"""v9 (DESIGN_V7 8): masks on groups and input layers in the network and in render requests."""

import pytest

import fakenet
import network
from network import DocNetwork
from test_network import GLSL, H, W, L, adj, base, px, source_of, connect_inputs, ins, uL
from test_v8 import LEGACY


@pytest.fixture(params=[False, True], ids=["v5", "v6"])
def net(request):
    comp, log = fakenet.make_comp()
    return DocNetwork(comp, GLSL, clock=fakenet.Clock(), optimize=request.param), comp


def inp(id_, n=1, **kw):
    return L(id_, "input", input=n, **kw)


def wired_sources(n, prefix=("blend_L_", "mrg_L_", "xf_L_")):
    out = {}
    for r in n._ops:
        if r.startswith(prefix):
            out[r] = [source_of(n, r, k) for k in range(len(n._ops[r].inputConnectors))]
    return out


def mask_consumers(n, mask):
    return sorted(r for r, srcs in wired_sources(n).items() if mask in srcs)


def test_nested_masked_groups_each_keep_their_own_mask_and_isolation(net):
    n, _ = net
    st = [base(), L("g1", "group", mask={"slot": 9, "enabled": True}, opacity=0.8),
          L("g2", "group", parentId="g1", mask={"slot": 10, "enabled": True}, blend="multiply"),
          px("c", 1, parentId="g2"), px("d", 2, parentId="g1"), px("z", 3)]
    n.apply(st, W, H)
    assert mask_consumers(n, "s9") == ["blend_L_g1"] and mask_consumers(n, "s10") == ["blend_L_g2"]
    assert n._ops["blend_L_g1"].par.value("vec0valuez") == 1.0 and n._ops["blend_L_g2"].par.value("vec0valuez") == 1.0
    assert source_of(n, "blend_L_g2", 0) != source_of(n, "blend_L_g1", 0) or n._opt is False
    assert (n._ops["s9"].par.value("resolutionw"), n._ops["s10"].par.value("resolutionh")) == (W, H)       # document sized
    # the masks are never part of a merged pass
    for r in [r for r in n._ops if r.startswith("mrg_L_")]:
        assert "s9" not in ins(n, r) and "s10" not in ins(n, r)
    # a disabled inner mask unwires only that one
    st[2] = dict(st[2], mask={"slot": 10, "enabled": False})
    n.apply(st, W, H)
    assert mask_consumers(n, "s9") == ["blend_L_g1"] and mask_consumers(n, "s10") == []


def test_adjustment_inside_a_masked_group_sees_the_group_content_and_the_group_keeps_the_mask(net):
    n, _ = net
    st = [base(), px("a", 1), L("g", "group", mask={"slot": 9, "enabled": True}), px("c", 2, parentId="g"),
          adj("lv", LEGACY[0], parentId="g", mask={"slot": 11, "enabled": True})]
    n.apply(st, W, H)
    assert source_of(n, "blend_L_lv", 0).endswith("c") or source_of(n, "blend_L_lv", 0).startswith("mrg_L_")      # the group's inner chain, not the page
    assert mask_consumers(n, "s11") == ["blend_L_lv"] and mask_consumers(n, "s9") == ["blend_L_g"]
    assert source_of(n, "blend_L_g", 1) == source_of(n, "blend_L_lv", 1) or source_of(n, "blend_L_g", 1) == "blend_L_lv"
    if n._opt:
        assert "s9" not in sum((ins(n, r) for r in n._ops if r.startswith("mrg_L_")), [])


def test_hidden_or_transparent_masked_input_adds_no_pass_and_wires_nothing(net):
    n, comp = net
    connect_inputs(comp, 1)
    comp.in1.width, comp.in1.height = 80, 60                        # mask of another size: the resample would be needed ...
    for kw in (dict(visible=False), dict(opacity=0.0)):
        st = [base(), inp("i", 1, surfaceW=40, surfaceH=30, mask={"slot": 7, "enabled": True}, **kw), px("z", 2)]
        n.apply(st, W, H)
        if n._opt:                                                   # ... a skipped one builds nothing
            assert "blend_L_i" not in n._ops and "xf_L_i" not in n._ops          # no pass and no resample node at all
            assert "s7" not in sum(wired_sources(n).values(), [])
        else:
            assert n._ops["blend_L_i"].bypass or n._ops["blend_L_i"].par.value("vec0valuey") == 0.0


# ---- render requests with masks


def test_flatten_of_a_masked_group_bakes_its_mask_but_not_opacity_or_blend(net):
    n, _ = net
    st = [base(), L("g", "group", mask={"slot": 9, "enabled": True}, opacity=0.4, blend="multiply"), px("c", 1, parentId="g"), px("z", 2)]
    n.apply(st, W, H)
    assert n.render_open("k", "layer", layer_id="g") is None
    bn = n._ops["blend_L_q0_g"]
    assert (bn.par.value("vec0valuex"), bn.par.value("vec0valuey"), bn.par.value("vec0valuez")) == (0.0, 1.0, 1.0)      # Normal, 1, masked
    assert source_of(n, "blend_L_q0_g", 2) == "s9" and source_of(n, "blend_L_q0_g", 0) == "blank"
    # a request of an UNmasked group beside it never picks the mask up
    n.render_close("k")
    n.apply([base(), L("g", "group"), px("c", 1, parentId="g"), L("h", "group", mask={"slot": 9, "enabled": True}), px("d", 2, parentId="h")], W, H)
    assert n.render_open("k", "layer", layer_id="g") is None
    assert "s9" not in sum(([s for s in v] for r, v in wired_sources(n).items() if "q0" in r), [])


def test_render_layers_ignores_the_parent_groups_mask_but_keeps_a_selected_groups_own(net):
    n, _ = net
    st = [base(), L("g", "group", mask={"slot": 9, "enabled": True}, opacity=0.5), px("c", 1, parentId="g", mask={"slot": 10, "enabled": True}),
          px("d", 2, parentId="g"), L("h", "group", mask={"slot": 12, "enabled": True}), px("e", 3, parentId="h")]
    n.apply(st, W, H)
    assert n.render_open("k", "layers", layer_ids=["c", "d"]) is None
    q = {r: v for r, v in wired_sources(n).items() if "q0" in r}
    assert "s9" not in sum(q.values(), []) and "s10" in sum(q.values(), [])          # the parent's mask is gone, the layer's own stays
    n.render_close("k")
    assert n.render_open("k2", "layers", layer_ids=["h"]) is None
    q = {r: v for r, v in wired_sources(n).items() if "q" in r and "L_q" in r}
    assert "s12" in sum(q.values(), [])


def test_merge_down_onto_a_masked_group_keeps_the_groups_mask(net):
    n, _ = net
    st = [base(), L("g", "group", mask={"slot": 9, "enabled": True}, opacity=0.5), px("c", 1, parentId="g"),
          adj("lv", LEGACY[0], mask={"slot": 7, "enabled": True}, opacity=0.6)]
    n.apply(st, W, H)
    assert n.render_open("k", "layer", layer_id="lv", mode="mergeDown") is None
    assert "s9" in wired_sources(n)["blend_L_q0_g"] and source_of(n, "blend_L_q0_g", 2) == "s9"
    pv = n._ops["blend_L_q0_g"].par.value
    assert (pv("vec0valuex"), pv("vec0valuey")) == (0.0, 1.0)                           # plain content (opacity 1, Normal)
    assert source_of(n, "blend_L_q0_lv", 2) == "s7" and source_of(n, "blend_L_q0_lv", 0) == "blend_L_q0_g"
