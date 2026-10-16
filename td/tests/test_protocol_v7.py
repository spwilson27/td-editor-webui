"""Protocol v7 (docs/PROTOCOL.md section 9): filters in documents, group / adjustment effects, brush presets, frame type 7."""

import json
import os

import pytest

import effects as FX
import protocol as P

BLUR = {"enabled": True, "type": "blur", "radius": 4}


def layer(**kw):
    d = {"id": "x", "kind": "pixel", "slot": 1}
    d.update(kw)
    return d


def parse(*layers, fx=None, **extra):
    return P.parse_doc({"rev": 1, "layers": list(layers), **extra}, fx)


def default_effect(typ, spec):
    e = {"type": typ, "enabled": True}
    for name, d in spec.get("params", {}).items():
        if "default" in d:
            e[name] = d["default"]
    return e


def extreme_effect(typ, spec, v):
    e = {"type": typ, "enabled": True}
    for name, d in spec.get("params", {}).items():
        k = d.get("kind", "num")
        if k in ("num", "seed"):
            e[name] = v
        elif k == "bool":
            e[name] = True
        elif k == "enum":
            e[name] = d["values"][-1]
        elif k == "color":
            e[name] = {"r": 255, "g": 0, "b": 255, "a": 255}
        elif k == "points":
            e[name] = [[0, 0], [0.5, 0.9], [1, 1]]
        elif k == "stops":
            e[name] = [{"pos": 0, "color": {"r": 0, "g": 0, "b": 0, "a": 255}}, {"pos": 1, "color": {"r": 255, "g": 255, "b": 255, "a": 255}}]
        elif k == "list":
            e[name] = [v] * int(d.get("len", 16))
        elif k == "text":
            e[name] = "x"
    return e


def test_every_library_filter_is_accepted_as_effect_and_as_adjustment_with_and_without_fx():
    assert len(FX.FILTER_SPECS) >= 30
    for typ, spec in FX.FILTER_SPECS.items():
        for e in (default_effect(typ, spec), extreme_effect(typ, spec, -1e6), extreme_effect(typ, spec, 1e6), {"type": typ, "enabled": True}):
            for fx in (None, FX):
                parse(layer(effects=[e]), fx=fx)
                parse({"id": "a", "kind": "adjustment", "adjustment": {"type": "filter", "effect": e}}, fx=fx)
                parse({"id": "g", "kind": "group", "effects": [e]}, fx=fx)


def test_filter_params_are_not_range_checked_here_but_malformed_values_are_refused():
    parse(layer(effects=[{"type": "blur", "enabled": True, "radius": 99999}]), fx=FX)            # clamped by TD, not refused
    for bad in (float("nan"), float("inf"), object(), {"a": object()}, "x" * (P.MAX_FILTER_TEXT + 1)):
        with pytest.raises(P.ProtocolError):
            parse(layer(effects=[{"type": "blur", "enabled": True, "radius": bad}]), fx=FX)


def test_norm_params_failures_are_protocol_errors():
    class Boom:
        FILTER_SPECS = {"boomy": {}}

        @staticmethod
        def norm_params(spec, e):
            raise ValueError("cannot read")
    with pytest.raises(P.ProtocolError, match="boomy"):
        parse(layer(effects=[{"type": "boomy", "enabled": True}]), fx=Boom)
    parse(layer(effects=[{"type": "boomy", "enabled": True}]))     # without fx: only the shape is checked
    parse(layer(effects=[{"type": "unknownToTd", "enabled": True, "a": 1}]), fx=Boom)


def test_group_and_adjustment_layers_may_carry_effects():
    p5 = {"enabled": True, "type": "colorOverlay", "color": {"r": 1, "g": 2, "b": 3, "a": 4}, "opacity": 0.5}
    _, ls = parse({"id": "g", "kind": "group", "effects": [p5, BLUR]}, {"id": "a", "kind": "adjustment", "adjustment": {"type": "invert"}, "effects": [BLUR]})
    assert ls[0]["effects"] == [p5, BLUR]
    with pytest.raises(P.ProtocolError):
        parse({"id": "g", "kind": "group", "effects": [{**p5, "opacity": 3}]})          # v5 effects keep their ranges everywhere
    with pytest.raises(P.ProtocolError):
        parse({"id": "g", "kind": "group", "effects": [BLUR] * 33})


@pytest.mark.parametrize("bad", [
    {"type": "filter"}, {"type": "filter", "effect": None}, {"type": "filter", "effect": "blur"},
    {"type": "filter", "effect": {"type": "blur"}}, {"type": "filter", "effect": {"type": "bad name", "enabled": True}},
])
def test_filter_adjustment_needs_a_valid_effect(bad):
    with pytest.raises(P.ProtocolError):
        parse({"id": "a", "kind": "adjustment", "adjustment": bad})


def test_other_adjustment_types_are_untouched():
    parse({"id": "a", "kind": "adjustment", "adjustment": {"type": "levels", "inLow": 0}}, {"id": "b", "kind": "adjustment", "adjustment": None})


def preset(**kw):
    d = {"id": "b1", "name": "Chalk", "settings": {"size": 5}, "tip": "chalk", "dynamics": {"seed": 3}}
    d.update(kw)
    return d


def tip(n=8, png="data:image/png;base64,AAAA"):
    return {"w": n, "h": n, "png": png}


def test_brush_presets_validation():
    assert P.brush_presets_of({}) == []
    parse(layer(), brushPresets=[preset(), preset(id="c", tip="custom", customTip=tip(512))])
    for bad in ("x", [1], [preset(id="")], [preset(tip="nope")], [preset(settings=[])], [preset(dynamics=None)],
                [preset(tip="custom")], [preset(customTip=tip(513))], [preset(customTip=tip(0))], [preset(customTip=tip(5, "http://x/y.png"))],
                [preset(customTip=tip(5, "data:image/png;base64," + "A" * P.MAX_TIP_PNG_CHARS))],
                [preset(settings={"a": float("nan")})], [preset(id=str(i)) for i in range(P.MAX_BRUSH_PRESETS + 1)],
                [preset(id=str(i), customTip=tip()) for i in range(P.MAX_CUSTOM_TIP_PRESETS + 1)]):
        with pytest.raises(P.ProtocolError):
            parse(layer(), brushPresets=bad)
    parse(layer(), brushPresets=[preset(id=str(i), customTip=tip()) for i in range(P.MAX_CUSTOM_TIP_PRESETS)])
    parse(layer(), brushPresets=None)


def test_unusable_preset_names_are_normalised():
    got = P.brush_presets_of({"brushPresets": [preset(name=""), preset(name=5), preset(name="x" * 300), preset(name="  ok ")]})
    assert [q["name"] for q in got] == ["Brush preset", "Brush preset", "x" * 256, "  ok "]
    parse(layer(), brushPresets=[preset(name="")])


def test_tip_names_cover_the_builtin_tips():
    assert set(P.BRUSH_TIPS) == {"round", "chalk", "bristle", "spatter", "noise", "square", "star", "custom"}


def test_layer_preview_frame_type_and_slot_rule():
    assert P.TYPE_LAYER_PREVIEW == 7 and 7 in P.VALID_TYPES
    h = P.Header(7, P.FLAG_FRAME_END, 5, 4, 3, 0, 0, 4, 3, 0)
    got, payload = P.decode_frame(P.encode_message(h, bytes(48)))
    assert got == h and len(payload) == 48
    with pytest.raises(P.ProtocolError):
        P.encode_header(h._replace(slot=1))
    with pytest.raises(P.ProtocolError):
        P.encode_header(h._replace(x=1))      # still one doc-sized rect inside the document


def test_v7_builders_and_parsers():
    assert json.loads(P.layer_preview_notice("L1", 9, 640, 480)) == {"t": "layerPreview", "layerId": "L1", "frameId": 9, "docW": 640, "docH": 480}
    assert P.decode_json(P.active_layer("L1")) == {"t": "activeLayer", "id": "L1"}
    assert P.decode_json(P.active_layer(None)) == {"t": "activeLayer", "id": None}
    assert P.parse_active_layer({"id": "a"}) == "a" and P.parse_active_layer({"id": None}) is None and P.parse_active_layer({}) is None
    for bad in (5, "", "x" * 257, ["a"]):
        with pytest.raises(P.ProtocolError):
            P.parse_active_layer({"id": bad})
    assert P.parse_layer_request({"layerId": "abc"}) == "abc"
    for bad in ({}, {"layerId": ""}, {"layerId": "x" * 257}, None, {"layerId": 4}):
        assert P.parse_layer_request(bad) is None
    assert P.parse_history_rev({"rev": "12"}) == 12 and P.parse_history_rev({"rev": 0}) == 0
    for bad in ({}, {"rev": "x"}, {"rev": "-1"}, {"rev": "1.5"}, {"rev": "nan"}, {"rev": True}, {"rev": "1e400"}, {"rev": None}):
        with pytest.raises(P.ProtocolError):
            P.parse_history_rev(bad)
    st = json.loads(P.doc_state(1, [], 2, 3, brush_presets=[preset()]))
    assert st["brushPresets"] == [preset()] and "brushPresets" not in json.loads(P.doc_state(1, [], 2, 3))
    assert json.loads(P.doc(1, [], brush_presets=[])) ["brushPresets"] == []
    assert P.PROTOCOL_VERSION == 11


def test_layer_preview_fixtures_match_the_generator():
    root = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "fixtures")
    manifest = json.load(open(os.path.join(root, "fixtures.json")))
    by = {e["name"]: e for e in manifest["messages"]}
    e = by["layer_preview"]
    hdr, payload = P.decode_frame(open(os.path.join(root, e["file"]), "rb").read())
    assert hdr.type == 7 and hdr.slot == 0 and e["header"]["type"] == 7 and (hdr.doc_w, hdr.doc_h) == (5, 4)
    bad = by["invalid_layer_preview_slot"]
    assert bad["valid"] is False
    with pytest.raises(P.ProtocolError):
        P.decode_frame(open(os.path.join(root, bad["file"]), "rb").read())


# ---- v9: masks on groups and input layers ----------------------------------------------------------------------

def test_v9_masks_on_group_and_input_layers_parse_and_get_their_own_sizes():
    layers = [layer(id="g", kind="group", slot=None, mask={"slot": 5, "enabled": True}),
              layer(id="i", kind="input", slot=None, input=2, surfaceW=40, surfaceH=30, mask={"slot": 6, "enabled": True}),
              layer(id="j", kind="input", slot=None, input=3, mask={"slot": 7, "enabled": False}),
              layer(id="p", kind="pixel", slot=8, surfaceW=16, surfaceH=9, mask={"slot": 9, "enabled": True}),
              layer(id="a", kind="adjustment", slot=None, mask={"slot": 10, "enabled": True})]
    _, out = parse(*layers)
    assert [l["mask"]["slot"] for l in out] == [5, 6, 7, 9, 10]
    assert P.mask_slots(out) == [5, 6, 7, 9, 10] and P.layer_slots(out) == [5, 6, 7, 8, 9, 10]
    # group / adjustment masks are document sized; an input mask follows the input surface (document size without a stated one)
    assert P.slot_sizes(out, 100, 50) == {5: (100, 50), 6: (40, 30), 7: (100, 50), 8: (16, 9), 9: (16, 9), 10: (100, 50)}
    # a surface-less input mask keeps the size of its buffer; a group mask never inherits a stale buffer size
    assert P.slot_sizes(out, 100, 50, {7: (64, 48), 5: (1920, 1080)}) == {5: (100, 50), 6: (40, 30), 7: (64, 48), 8: (16, 9), 9: (16, 9), 10: (100, 50)}


def test_v9_duplicate_mask_slots_across_group_and_input_are_refused():
    with pytest.raises(P.ProtocolError):
        parse(layer(id="g", kind="group", slot=None, mask={"slot": 5, "enabled": True}),
              layer(id="i", kind="input", slot=None, input=1, mask={"slot": 5, "enabled": True}))
