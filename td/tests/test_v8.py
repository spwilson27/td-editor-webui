"""v8: legacy adjustment migration, render requests (flatten / merge down / merge selected) in the protocol, network and ext."""

import json
import os

import numpy as np
import pytest

import fakenet
import network
import protocol as P
from network import DocNetwork
from faketd import FakeTop
from test_ext import L as XL
from test_ext_v7 import make
from test_ext import tops_img, install_tops, get_top
from test_network import GLSL, H, W, L, adj, base, fx_chain_nodes, px, shadow, source_of, txt, shp, TEXT, RECT, disp

LEGACY = [
    {"type": "levels", "inLow": 0.1, "inHigh": 0.9, "gamma": 2.0, "outLow": 0.2, "outHigh": 0.8},
    {"type": "brightnessContrast", "brightness": 0.25, "contrast": -0.5},
    {"type": "hueSaturation", "hue": 30, "saturation": 1.5, "value": 0.8},
    {"type": "invert"},
    {"type": "threshold", "level": 0.3},
]


def doc(layers):
    return {"t": "doc", "rev": 1, "layers": layers}


# --------------------------------------------------------------------------- protocol


@pytest.mark.parametrize("spec", LEGACY)
def test_classic_adjustment_migrates_to_an_effect_of_the_same_type(spec):
    l = dict(id="a", kind="adjustment", adjustment=spec, effects=[{"type": "dropShadow", "enabled": True, "dx": 1, "dy": 1, "blur": 2,
                                                                   "color": {"r": 0, "g": 0, "b": 0, "a": 255}, "opacity": 1}])
    _, out = P.parse_doc(doc([l]))
    assert out[0]["adjustment"] is None
    first = out[0]["effects"][0]
    assert first["type"] == spec["type"] and first["enabled"] is True
    assert all(first[k] == v for k, v in spec.items() if k != "type")
    assert [e["type"] for e in out[0]["effects"]] == [spec["type"], "dropShadow"]          # prepended


def test_filter_adjustment_migrates_to_its_effect_and_unknown_specs_to_nothing():
    fl = {"type": "filter", "effect": {"type": "bloom", "enabled": True, "radius": 5}}
    _, out = P.parse_doc(doc([dict(id="a", kind="adjustment", adjustment=fl), dict(id="b", kind="adjustment", adjustment={"type": "sepia"}),
                              dict(id="c", kind="adjustment", adjustment=None, effects=[{"type": "invert", "enabled": True}])]))
    assert out[0]["effects"] == [fl["effect"]] and out[0]["adjustment"] is None
    assert out[1]["effects"] == [] and out[1]["adjustment"] is None
    assert out[2]["effects"] == [{"type": "invert", "enabled": True}]
    with pytest.raises(P.ProtocolError):
        P.parse_doc(doc([dict(id="a", kind="adjustment", adjustment={"type": "filter", "effect": {"type": "bad type", "enabled": True}})]))


LEGACY_BLUR = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "shared", "effects", "legacy_blur_vectors.json")))


def test_blur_adjustment_migration_is_canonical_with_and_without_the_effects_module():
    import effects
    for v in LEGACY_BLUR:     # one definition (protocol), mirrored by effects.py and the web's legacyBlurToFilter (same vectors there)
        assert P.legacy_blur_to_filter(v["in"]) == v["out"], v
        assert effects.legacy_blur_to_filter(v["in"]) == v["out"], v
        if v["in"] >= 0.05:
            assert P.legacy_adjustment_effect({"type": "blur", "radius": v["in"]}) == v["out"]
            assert P.legacy_adjustment_effect({"type": "blur", "radius": v["in"]}, effects) == v["out"]
    e = P.legacy_adjustment_effect({"type": "blur", "radius": 10})          # no module: sigma 10, hold edge (NOT x3 radius alone)
    assert e == {"enabled": True, "type": "blur", "radius": 30.0, "sigma": 10, "edge": "hold"}
    assert P.legacy_adjustment_effect({"type": "blur", "radius": 150}) ["sigma"] == 150
    assert P.legacy_adjustment_effect({"type": "blur", "radius": 150})["radius"] == 200.0
    _, out = P.parse_doc(doc([dict(id="a", kind="adjustment", adjustment={"type": "blur", "radius": 4})]), effects)
    assert out[0]["effects"] == [P.legacy_blur_to_filter(4)] and out[0]["effects"][0]["radius"] == 16.0


def test_legacy_blur_kernel_is_gaussian_at_every_radius():
    """Kernel half width >= 3 sigma for the whole 0..200 range (item: r = 100 / 200 must not collapse to a 1-2 sigma kernel)."""
    import effects
    for r in (0.5, 4, 20, 40, 100, 150, 200):
        f = P.legacy_blur_to_filter(r)
        px = 4 * f["sigma"] if 4 * f["sigma"] <= 16 else min(600, 3 * f["sigma"])
        sg, rad, lv = effects._blur_plan(px, f["sigma"])
        assert (rad << lv) >= 3 * f["sigma"] - (1 << lv), (r, sg, rad, lv)
        assert sg > 0


def test_render_request_parsers():
    ok = P.parse_render_request(P.decode_json(P.render_layer("r", "a", "mergeDown")))
    assert ok == {"rid": "r", "kind": "layer", "layerId": "a", "mode": "mergeDown"}
    assert P.parse_render_request(P.decode_json(P.render_layer("r", "a")))["mode"] == "flatten"
    assert P.parse_render_request(P.decode_json(P.render_layers("r", ["a", "b"]))) == {"rid": "r", "kind": "layers", "layerIds": ["a", "b"]}
    for bad in ({"t": "renderLayer", "requestId": "r", "layerId": "a", "mode": "x"},
                {"t": "renderLayers", "requestId": "r", "layerIds": []},
                {"t": "renderLayers", "requestId": "r", "layerIds": ["a", "a"]},
                {"t": "renderLayers", "requestId": "r", "layerIds": [1]},
                {"t": "renderLayers", "requestId": "r"}):
        with pytest.raises(P.ProtocolError):
            P.parse_render_request(bad)
    assert P.parse_render_layer(P.decode_json(P.render_layer("r1", "t1", "flatten"))) == ("r1", "t1")


# --------------------------------------------------------------------------- network render requests


@pytest.fixture(params=[False, True], ids=["v5", "v6"])
def net(request):
    comp, log = fakenet.make_comp()
    return DocNetwork(comp, GLSL, clock=fakenet.Clock(), optimize=request.param)


def node_names(n):
    return {k for k in n._ops}


def test_flatten_plans_the_layer_alone_without_opacity_and_blend_and_cleans_up(net):
    st = [base(), px("a", 1, surfaceW=8, surfaceH=8, effects=[shadow()], opacity=0.3, blend="multiply", mask={"slot": 5, "enabled": True}),
          px("b", 2)]
    net.apply(st, W, H)
    before = node_names(net)
    assert net.render_open("k", "layer", layer_id="a") is None
    src = net.render_source("k")
    assert src is not None and src is net._ops["rqout_q0"] and net.render_status("k") == "ready"
    assert "q0.a" in net._chains and node_names(net) > before
    bn = net._ops["blend_L_q0_a"]
    assert (bn.par.value("vec0valuex"), bn.par.value("vec0valuey")) == (0.0, 1.0)          # Normal, opacity 1
    assert source_of(net, "blend_L_q0_a", 0) == "blank"                                       # isolated
    assert source_of(net, "xf_L_q0_a", 1) == "s5"                                              # the mask is applied (before the effects)
    assert "s5" in node_names(net) and net._ops["s1"] is net.surface_top(1)                   # shared surface scripts
    tok = net.render_token("k")
    net.apply(st, W, H)
    assert net.render_token("k") == tok
    net.apply(st[:2] + [px("b", 2, x=3)], W, H)                                                # another layer edited: same pixels
    assert net.render_token("k") == tok
    net.apply([st[0], dict(st[1], effects=[shadow(blur=9.0)]), st[2]], W, H)
    assert net.render_token("k") != tok
    net.render_close("k")
    for _ in range(30):
        net.tick()
    assert node_names(net) == before and "q0.a" not in net._chains and net.render_source("k") is None


def test_flatten_of_a_group_composites_its_children_and_applies_group_effects_and_mask(net):
    st = [base(), L("g", "group", opacity=0.5, effects=[shadow()], mask={"slot": 9, "enabled": True}),
          px("c", 1, parentId="g"), px("d", 2, parentId="g", blend="multiply"), px("z", 3)]
    net.apply(st, W, H)
    assert net.render_open("k", "layer", layer_id="g") is None
    assert "q0.g" in net._chains and ("blend_L_q0_c" in net._ops or "mrg_L_q0_c" in net._ops)
    names = node_names(net)
    assert not any(n.endswith("_z") for n in names if "q0" in n)                              # layers outside the group are not in it
    assert source_of(net, "rqout_q0") is not None


def test_merge_down_applies_the_adjustment_stack_to_the_layer_below_only(net):
    st = [base(), px("a", 1), px("b", 2, opacity=0.4, blend="screen"), adj("lv", LEGACY[0], opacity=0.5, mask={"slot": 7, "enabled": True}),
          px("c", 3)]
    net.apply(st, W, H)
    assert net.render_open("k", "layer", layer_id="lv", mode="mergeDown") is None
    assert [e["type"] for e in net._fx_todo["fx_L_q0_lv"][2]] == ["levels"]
    assert net._chains["q0.lv"] is not None
    below = source_of(net, "blend_L_q0_lv", 0)
    assert below.endswith("q0_b")                                                              # b alone (not a, not the base)
    pv = net._ops["blend_L_q0_lv"].par.value
    assert (pv("vec0valuew"), pv("vec0valuey"), pv("vec0valuez")) == (float(network.ADJ_PREMULT), 0.5, 1.0)
    bq = net._ops["blend_L_q0_b"]                                  # a lone layer keeps its own pass (also with merged runs)
    assert (bq.par.value("vec0valuex"), bq.par.value("vec0valuey")) == (0.0, 1.0)              # content only: Normal, opacity 1
    # flatten of an adjustment layer is the same request
    net.render_close("k")
    assert net.render_open("k", "layer", layer_id="lv") is None and "q0.lv" in net._chains


def test_merge_down_errors(net):
    net.apply([adj("a0", LEGACY[3]), adj("a1", LEGACY[3]), px("p", 1)], W, H)
    assert "nothing below" in net.render_open("k", "layer", layer_id="a0", mode="mergeDown")
    assert "adjustment" in net.render_open("k", "layer", layer_id="a1", mode="mergeDown")
    assert "only an adjustment" in net.render_open("k", "layer", layer_id="p", mode="mergeDown")
    assert "not in" in net.render_open("k", "layer", layer_id="nope")
    assert not net._reqs and net.render_source("k") is None


def test_render_layers_is_an_isolated_composite_in_stack_order(net):
    st = [base(), px("a", 1, blend="multiply", opacity=0.5), L("g", "group"), px("c", 2, parentId="g"), px("d", 3, parentId="g"),
          px("e", 4), adj("iv", LEGACY[3])]
    net.apply(st, W, H)
    # selection given out of order, with a group AND one of its children (covered), and a layer of another parent
    assert net.render_open("k", "layers", layer_ids=["e", "d", "g", "a"]) is None
    mine = [n for n in net._ops if "q0_" in n and n.startswith(("blend_L_", "mrg_L_"))]
    assert mine
    ins = lambda n: [net._ops[n].inputConnectors[i].source for i in range(len(net._ops[n].inputConnectors))]
    root = net._ops["rqout_q0"].inputConnectors[0].source
    assert root is not net._ops["out"].inputConnectors[0].source
    sids = [l["id"] for l in net._request_layers(st, net._reqs["k"]["spec"], "q0")]
    assert sids == ["q0.a", "q0.g", "q0.c", "q0.d", "q0.e"]                                    # stack order, c / d once, no adjustment
    byid = {l["id"]: l for l in net._request_layers(st, net._reqs["k"]["spec"], "q0")}
    assert byid["q0.a"]["parentId"] is None and byid["q0.c"]["parentId"] == "q0.g" and byid["q0.a"]["opacity"] == 0.5
    assert net.render_open("k2", "layers", layer_ids=["a", "nope"]) is not None


def test_render_layers_with_an_adjustment_and_the_layer_below_it(net):
    """Merge Selected of [layer, adjustment above it]: the adjustment applies to the selected layer(s) below it only, in stack order."""
    st = [base(), px("a", 1), px("b", 2, opacity=0.5), adj("lv", LEGACY[0], opacity=0.6), px("c", 3)]
    net.apply(st, W, H)
    assert net.render_open("k", "layers", layer_ids=["lv", "b"]) is None
    sids = [l["id"] for l in net._request_layers(st, net._reqs["k"]["spec"], "q0")]
    assert sids == ["q0.b", "q0.lv"]                                                           # stack order, a / c / base not included
    assert [e["type"] for e in net._fx_todo["fx_L_q0_lv"][2]] == ["levels"] and "q0.lv" in net._chains
    pv = net._ops["blend_L_q0_lv"].par.value
    assert (pv("vec0valuew"), pv("vec0valuey")) == (float(network.ADJ_PREMULT), 0.6)           # the adjustment keeps its opacity
    assert source_of(net, "blend_L_q0_lv", 0).endswith("q0_b")
    assert net.render_source("k") is net._ops["rqout_q0"]
    net.render_close("k")


def test_hidden_layers_stay_hidden_in_merge_selected_like_the_web_side(net):
    st = [base(), px("a", 1, visible=False), px("b", 2), L("g", "group", visible=False), px("c", 3, parentId="g")]
    net.apply(st, W, H)
    assert net.render_open("k", "layers", layer_ids=["a", "b", "g"]) is None
    byid = {l["id"]: l for l in net._request_layers(st, net._reqs["k"]["spec"], "q0")}
    assert byid["q0.a"]["visible"] is False and byid["q0.b"]["visible"] is True and byid["q0.g"]["visible"] is False
    assert not any(n.startswith(("blend_L_q0_a", "mrg_L_q0_a")) and not net._cache[n]["bypass"] and net._ops[n].par.value("vec0valuey") > 0
                   for n in net._ops if "q0_a" in n)                                       # nothing of the hidden layer is drawn
    net.render_close("k")
    # whereas Flatten of a hidden layer renders it (the layer alone is made visible)
    assert net.render_open("k", "layer", layer_id="a") is None
    assert {l["id"]: l for l in net._request_layers(st, net._reqs["k"]["spec"], "q0")}["q0.a"]["visible"] is True
    net.render_close("k")


def test_text_layout_and_stale_requests(net):
    st = [base(), txt("t", dict(TEXT, text="hello")), shp("s", RECT)]
    net.apply(st, W, H)
    assert net.render_open("k", "layers", layer_ids=["t", "s"]) is None
    assert net.render_status("k") in ("ready", "pending")
    for _ in range(40):
        net.tick()
    assert net.render_ready("k") is True
    tok = net.render_token("k")
    net.apply([base(), txt("t", dict(TEXT, text="other")), shp("s", RECT)], W, H)
    assert net.render_token("k") != tok
    net.apply([base(), shp("s", RECT)], W, H)                                                  # a requested layer was deleted
    assert net.render_source("k") is None and net.render_token("k") is None and "does not exist" in net.render_error("k")
    net.apply(st, W, H)                                                                        # it is back: the request recovers
    assert net.render_source("k") is not None
    net.render_close("k")


def test_two_requests_use_separate_tags_and_do_not_disturb_the_document(net):
    st = [base(), px("a", 1, effects=[shadow()]), px("b", 2)]
    net.apply(st, W, H)
    out0 = net._ops["out"].inputConnectors[0].source
    assert net.render_open("k1", "layer", layer_id="a") is None and net.render_open("k2", "layer", layer_id="b") is None
    assert net.render_source("k1") is not net.render_source("k2")
    assert net._ops["out"].inputConnectors[0].source is out0
    net.render_close("k1")
    assert net.render_source("k2") is not None and "q0.a" not in net._chains
    net.render_close("k2")
    assert net.stats()["plan"]["layers"] == 3


def test_render_token_covers_aux_displace_sources_masks_and_input_layers(net):
    """Review fix: the aux image (another layer's pixels / mask, a COMP input) and input layers are read by the request."""
    st = [base(), px("m", 1, mask={"slot": 7, "enabled": True}), px("a", 2, effects=[disp("layer:m")])]
    net.apply(st, W, H)
    assert net.render_open("k", "layer", layer_id="a") is None
    assert {1, 7, 2} <= net._reqs["k"]["slots"]
    tok = net.render_token("k")
    net._ops["s1"].cooks += 1                                       # the aux layer's pixels were repainted
    assert net.render_token("k") != tok
    tok = net.render_token("k")
    net._ops["s7"].cooks += 1                                       # ... or its mask
    assert net.render_token("k") != tok
    net.render_close("k")


def test_render_token_follows_input_layer_cooks_and_input_aux(net):
    st = [base(), L("i2", "input", input=2), px("a", 2, effects=[disp("input:3")])]
    net.apply(st, W, H)
    assert net.render_open("k", "layers", layer_ids=["i2", "a"]) is None
    assert net._reqs["k"]["inputs"] == {2, 3}
    tok = net.render_token("k")
    for n in (2, 3):
        src = net._ops.get("src_in%d" % n)
        assert src is not None
        src.cooks += 1
        t2 = net.render_token("k")
        assert t2 != tok
        tok = t2
    net.render_close("k")


def test_a_failed_effect_chain_makes_the_request_failed_and_changes_the_token(net):
    st = [base(), px("a", 1, effects=[shadow()])]
    net.apply(st, W, H)
    assert net.render_open("k", "layer", layer_id="a") is None and net.render_status("k") == "ready"
    tok = net.render_token("k")
    net._fx_fail["q0.a"] = (1, 1e12, "key")                         # what _apply_chain records when the chain raises
    assert net.render_status("k") == "failed" and net.render_ready("k") is False
    assert net.render_token("k") != tok
    del net._fx_fail["q0.a"]
    assert net.render_status("k") == "ready"
    net.render_close("k")


def test_a_failing_effect_build_in_a_request_is_reported_as_failed_through_apply(net, monkeypatch):
    st = [base(), px("a", 1, effects=[shadow()])]
    net.apply(st, W, H)
    orig = net._fx.EffectChain.apply

    def boom(self, effects, input_top, *a, **kw):
        if "q0" in self.prefix:
            raise RuntimeError("shader compile")
        return orig(self, effects, input_top, *a, **kw)
    monkeypatch.setattr(net._fx.EffectChain, "apply", boom)
    assert net.render_open("k", "layer", layer_id="a") is None
    assert net.render_status("k") == "failed"
    assert net._ops["out"].inputConnectors[0].source is not None   # the document itself was applied
    net.render_close("k")


def test_an_exception_while_planning_a_request_sets_its_error_and_never_breaks_document_applies(net, monkeypatch):
    st = [base(), px("a", 1), px("b", 2)]
    net.apply(st, W, H)
    assert net.render_open("k", "layer", layer_id="a") is None
    before = node_names(net)
    real = net._emit
    calls = {"n": 0}

    def emit(add, items, acc, tail_ok, doc_w, doc_h):
        calls["n"] += 1
        if calls["n"] == 2:                                           # the request's emit (the document's is the first)
            add(network._Node("junk_node", "nullTOP", {}, ["blank"]))
            raise RuntimeError("planner bug")
        return real(add, items, acc, tail_ok, doc_w, doc_h)
    monkeypatch.setattr(net, "_emit", emit)
    net.apply(st + [px("c", 3)], W, H)                                # does not raise
    assert "cannot plan the render request" in net.render_error("k") and net.render_source("k") is None
    assert "junk_node" not in net._ops
    assert "s3" in net._ops                              # the document's own nodes were built
    monkeypatch.undo()
    net.apply(st + [px("c", 3, x=1)], W, H)                           # recovers at the next real change
    assert net.render_error("k") is None and net.render_source("k") is not None


def test_migration_keeps_existing_effects_after_the_legacy_one_and_truncates_to_max_effects():
    existing = [{"type": "invert", "enabled": True}, {"type": "threshold", "level": 0.2, "enabled": True}]
    _, out = P.parse_doc(doc([dict(id="a", kind="adjustment", adjustment={"type": "levels", "gamma": 1.5}, effects=list(existing))]))
    assert [e["type"] for e in out[0]["effects"]] == ["levels", "invert", "threshold"] and out[0]["adjustment"] is None
    assert out[0]["effects"][0]["gamma"] == 1.5 and out[0]["effects"][1:] == existing           # prepended, the rest untouched
    many = [{"type": "invert", "enabled": True, "n": i} for i in range(P.MAX_EFFECTS)]
    l = P.migrate_layer(dict(id="a", kind="adjustment", adjustment={"type": "threshold", "level": 0.5}, effects=many))
    assert len(l["effects"]) == P.MAX_EFFECTS and l["effects"][0]["type"] == "threshold"
    assert l["effects"][1:] == many[:P.MAX_EFFECTS - 1]                                          # the LAST effect is the one dropped
    # an unknown legacy spec contributes nothing but still clears the field
    l = P.migrate_layer(dict(id="a", kind="adjustment", adjustment={"type": "sepia"}, effects=list(existing)))
    assert l["effects"] == existing and l["adjustment"] is None


# --------------------------------------------------------------------------- ext


def render_env(layers=None):
    e, a = make(doc=layers or [XL("base", "input", input=1), XL("p1", slot=1, surfaceW=64, surfaceH=32), XL("p2", slot=2, surfaceW=64, surfaceH=32),
                                XL("adj", "adjustment", effects=[{"type": "invert", "enabled": True}])])
    return e, a


def test_render_layers_and_merge_down_are_served_like_top_imports_and_closed_after():
    e, a = render_env()
    arr = tops_img(64, 32, 3)
    arr[..., :3] *= arr[..., 3:4]
    install_tops(e)
    e.o.net.render_sources["p1+p2"] = FakeTop("/p/q", 64, 32, array=arr)
    e.o.net.render_sources["adj"] = FakeTop("/p/m", 64, 32, array=arr)
    e.send(a, {"t": "renderLayers", "requestId": "m1", "layerIds": ["p1", "p2"]})
    e.pump(10)
    assert e.s.messages(a, "topReady")[-1] == {"t": "topReady", "requestId": "m1", "w": 64, "h": 32}
    h, _ = P.decode_frame(get_top(e, a, "m1")["data"])
    assert (h.type, h.doc_w, h.doc_h) == (6, 64, 32)
    net = e.o.net
    assert net.open_calls[0][1:] == ("layers", None, ("p1", "p2"), "flatten") and net.closed == [net.open_calls[0][0]]
    e.send(a, {"t": "renderLayer", "requestId": "m2", "layerId": "adj", "mode": "mergeDown"})
    e.pump(10)
    assert net.open_calls[1][1:] == ("layer", "adj", (), "mergeDown")
    assert [m["requestId"] for m in e.s.messages(a, "topReady")] == ["m1", "m2"] and len(net.closed) == 2


def test_render_request_errors_close_the_request_and_report_top_error():
    e, a = render_env()
    install_tops(e)
    e.o.net.render_sources["adj"] = FakeTop("/p/m", 64, 32, array=tops_img(64, 32))
    e.o.net.open_error = "there is nothing below this adjustment layer to merge into"
    e.send(a, {"t": "renderLayer", "requestId": "x1", "layerId": "adj", "mode": "mergeDown"})
    e.pump(6)
    assert "nothing below" in e.s.messages(a, "topError")[-1]["msg"] and e.o.net.closed
    e.send(a, {"t": "renderLayers", "requestId": "x2", "layerIds": ["p1", "ghost"]})
    assert "not a layer" in e.s.messages(a, "topError")[-1]["msg"]
    e.send(a, {"t": "renderLayers", "requestId": "x3", "layerIds": []})
    assert e.s.messages(a, "error")
    b = e.connect("external")
    e.send(b, {"t": "renderLayers", "requestId": "x4", "layerIds": ["p1"]})
    assert "active editor" in e.s.messages(b, "topError")[0]["msg"]


def test_render_request_token_change_mid_readback_drops_the_result():
    e, a = render_env()
    e.o.net.render_sources["p1+p2"] = FakeTop("/p/q", 64, 32, array=tops_img(64, 32))
    e.send(a, {"t": "renderLayers", "requestId": "m1", "layerIds": ["p1", "p2"]})
    e.pump(2)
    e.o.net.token += 1
    e.pump(8)
    assert e.s.messages(a, "topError")[-1]["msg"] == "layer changed" and not e.s.messages(a, "topReady") and e.o.net.closed


def _running_job(e, a, rid, ids, source):
    e.o.net.render_sources[source] = FakeTop("/p/" + rid, 64, 32, array=tops_img(64, 32))
    e.send(a, {"t": "renderLayers", "requestId": rid, "layerIds": ids})
    e.pump(2)                                          # opened, readback in progress


def test_render_job_closes_its_request_when_the_client_disconnects():
    e, a = render_env()
    _running_job(e, a, "m1", ["p1", "p2"], "p1+p2")
    net = e.o.net
    assert len(net.open_calls) == 1 and not net.closed
    e.x.OnWebSocketClose(a)
    e.pump(2)
    assert net.closed == [net.open_calls[0][0]] and not net.req_layers


def test_a_newer_render_request_of_the_same_client_supersedes_and_closes_the_running_one():
    e, a = render_env()
    _running_job(e, a, "m1", ["p1", "p2"], "p1+p2")
    net = e.o.net
    net.render_sources["adj"] = FakeTop("/p/m2", 64, 32, array=tops_img(64, 32))
    e.send(a, {"t": "renderLayer", "requestId": "m2", "layerId": "adj", "mode": "mergeDown"})
    assert "superseded" in e.s.messages(a, "topError")[-1]["msg"] and net.closed == [net.open_calls[0][0]]
    e.pump(10)
    assert [m["requestId"] for m in e.s.messages(a, "topReady")] == ["m2"]
    assert len(net.closed) == 2 and not net.req_layers


def test_render_job_fails_at_once_when_an_effect_chain_of_the_request_failed():
    e, a = render_env()
    e.o.net.render_sources["p1+p2"] = FakeTop("/p/q", 64, 32, array=tops_img(64, 32))
    e.o.net.failed.add("p1+p2")
    e.send(a, {"t": "renderLayers", "requestId": "m1", "layerIds": ["p1", "p2"]})
    e.pump(6)
    err = e.s.messages(a, "topError")[-1]["msg"]
    assert "failed in TouchDesigner" in err and not e.s.messages(a, "topReady") and e.o.net.closed
