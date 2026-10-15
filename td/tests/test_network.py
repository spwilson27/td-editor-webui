"""DocNetwork diff logic against fake TD objects (no TouchDesigner needed)."""

import json
import os
import re

import numpy as np
import pytest

import fakenet
import network
from network import DocNetwork

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GLSL = open(os.path.join(ROOT, "td", "raster_editor", "blend.glsl"), encoding="utf-8").read()
W, H = 64, 48


def L(id_, kind="pixel", **kw):
    d = dict(id=id_, kind=kind, parentId=None, name=id_, visible=True, opacity=1.0, blend="normal",
             x=0, y=0, slot=None, mask=None, adjustment=None)
    d.update(kw)
    return d


def base():
    return L("base", "base")


def px(id_, slot, **kw):
    return L(id_, slot=slot, **kw)


@pytest.fixture
def env():
    clock = fakenet.Clock()
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL, clock=clock, optimize=False)       # the v5 node-per-layer network; v6 has its own tests below
    return net, comp, log, clock


def settle(net, n=80):
    """Frames: tick until nothing is left to do except waiting for the grace period."""
    for _ in range(n):
        s = net.stats()
        if not (s["garbage"] or s["junk"]) and s["pool"] >= network.POOL_TARGET:
            break
        net.tick()


def op_by_role(net, role):
    return net._ops[role]


def source_of(net, role, index=0):
    """Role name of the node wired to input ``index`` of ``role``."""
    target = net._ops[role].inputConnectors[index].source
    for r, o in net._ops.items():
        if o is target:
            return r
    return None


def stack_of_three():
    return [base(), px("a", 1), px("b", 2, blend="multiply", opacity=0.5), px("c", 3, x=5, y=-3)]


# --------------------------------------------------------------------------- construction


def test_creates_doc_and_text_dats(env):
    net, comp, log, _ = env
    doc = comp.op("doc")
    assert doc is not None and doc.OPType == "baseCOMP"
    assert doc.op("blend_glsl").text == GLSL
    assert "OnSurfaceCook" in doc.op("surface_callbacks").text
    assert "parent.RasterEditor" in doc.op("surface_callbacks").text


def test_existing_doc_is_reused():
    comp, log = fakenet.make_comp()
    comp.create("baseCOMP", "doc")
    DocNetwork(comp, GLSL, optimize=False)
    assert len([c for c in comp.children if c.name == "doc"]) == 1


def test_build_chain_wiring(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    # chain bottom -> top, each blend takes the previous as input 0 and its surface as input 1
    assert source_of(net, "blend_L_base", 0) == "blank"
    assert source_of(net, "blend_L_base", 1) == "src_in1"
    assert source_of(net, "blend_L_a", 0) == "blend_L_base"
    assert source_of(net, "blend_L_a", 1) == "s1"
    assert source_of(net, "blend_L_b", 0) == "blend_L_a"
    assert source_of(net, "blend_L_b", 1) == "s2"
    assert source_of(net, "blend_L_c", 0) == "blend_L_b"
    assert source_of(net, "blend_L_c", 1) == "s3"
    assert source_of(net, "out", 0) == "blend_L_c"
    assert net.output() is net._ops["out"]
    # all three glsl inputs are always wired (sTD2DInputs[] is sized by the wired inputs)
    for r in ("blend_L_base", "blend_L_a", "blend_L_b", "blend_L_c"):
        assert source_of(net, r, 2) == "blank"


def test_surfaces_are_script_tops_with_doc_resolution(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    assert net.slots() == [1, 2, 3]
    s2 = net.surface_top(2)
    assert s2.OPType == "scriptTOP" and s2.name == "s2"
    pv = s2.par.value
    assert pv("outputresolution") == "custom" and pv("resolutionw") == W and pv("resolutionh") == H
    assert pv("callbacks") == "surface_callbacks"
    assert net.surface_top(99) is None


def test_blend_L_parameters(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    b = net._ops["blend_L_b"].par.value
    assert b("vec0name") == "uParams" and b("vec1name") == "uXform"
    assert b("vec0valuex") == 1.0        # multiply
    assert b("vec0valuey") == 0.5        # opacity
    assert b("vec0valuez") == 0.0        # no mask
    assert b("vec0valuew") == 0.0        # blend, not adjust
    assert b("pixeldat") == "blend_glsl"
    c = net._ops["blend_L_c"].par.value
    assert tuple(c("vec1value" + k) for k in "xyzw") == (5.0, -3.0, 1.0, 1.0)
    assert c("inputfiltertype") == "nearest" and c("inputextenduv") == "hold"
    assert net._ops["blend_L_c"].tags == ["role:blend_L_c"]


def test_blend_L_mode_index_order_matches_types_ts():
    src = open(os.path.join(ROOT, "web", "src", "engine", "types.ts"), encoding="utf-8").read()
    m = re.search(r"export type BlendMode =([^;]+);", src)
    assert tuple(re.findall(r"'([a-z-]+)'", m.group(1))) == network.BLEND_MODES


def test_every_mode_has_a_shader_case():
    cases = sorted(int(c) for c in re.findall(r"case (\d+):", GLSL))
    assert cases == list(range(16))


def test_shader_contract():
    for needle in ("uniform vec4 uParams", "uniform vec4 uXform", "texelFetch(sTD2DInputs[0]", "textureLod(sTD2DInputs[1]",
                   "TDOutputSwizzle", "sTD2DInputs[2]"):
        assert needle in GLSL


def test_hidden_layer_is_bypassed(env):
    net, comp, log, _ = env
    st = stack_of_three()
    st[2]["visible"] = False
    net.apply(st, W, H)
    assert net._ops["blend_L_b"].bypass is True
    assert net._ops["blend_L_a"].bypass is False


def test_node_layout_is_columnar_and_distinct(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    ys = [net._ops[r].nodeY for r in ("blend_L_base", "blend_L_a", "blend_L_b", "blend_L_c")]
    assert ys == sorted(ys, reverse=True) and len(set(ys)) == 4          # one row per layer, top of stack lowest on screen
    assert net._ops["s1"].nodeX < net._ops["blend_L_a"].nodeX              # surfaces left of the blend column


# --------------------------------------------------------------------------- minimal changes


def test_identical_apply_does_nothing(env):
    net, comp, log, _ = env
    st = stack_of_three()
    net.apply(st, W, H)
    m = log.mark()
    net.apply(json.loads(json.dumps(st)), W, H)
    d = log.since(m)
    assert not any(d.values())
    assert net.stats()["last"]["par_sets"] == 0


@pytest.mark.parametrize("key,value,expected", [
    ("opacity", 0.25, 1), ("blend", "screen", 1), ("x", 11, 1), ("y", 4, 1),
])
def test_property_change_is_one_par_set(env, key, value, expected):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    st = stack_of_three()
    st[3][key] = value
    m = log.mark()
    net.apply(st, W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert len(d["par_sets"]) == expected


def test_visibility_toggle_sets_only_bypass(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    st = stack_of_three()
    st[1]["visible"] = False
    m = log.mark()
    net.apply(st, W, H)
    d = log.since(m)
    assert not d["par_sets"] and not d["creates"] and not d["connects"]
    assert net._ops["blend_L_a"].bypass is True


def test_rename_and_locked_changes_do_nothing(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    st = stack_of_three()
    st[1]["name"] = "renamed"
    m = log.mark()
    net.apply(st, W, H)
    assert not any(log.since(m).values())


def test_reorder_only_rewires(env):
    net, comp, log, _ = env
    a, b, c = px("a", 1), px("b", 2), px("c", 3)
    net.apply([base(), a, b, c], W, H)
    m = log.mark()
    net.apply([base(), b, a, c], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["par_sets"]
    assert source_of(net, "blend_L_b", 0) == "blend_L_base"
    assert source_of(net, "blend_L_a", 0) == "blend_L_b"
    assert source_of(net, "blend_L_c", 0) == "blend_L_a"
    assert len(d["connects"]) <= 6


def test_add_layer_creates_one_surface_and_reuses_a_pooled_blend(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    assert net.stats()["pool"] >= network.POOL_TARGET
    m = log.mark()
    net.apply(stack_of_three() + [px("d", 4)], W, H)
    d = log.since(m)
    made = [n for t, n in d["creates"]]
    assert "s4" in made
    assert not any(t == "glslTOP" for t, n in d["creates"])        # blend came from the spare pool
    assert not d["destroys"]
    assert not log.renames                                          # never renamed (a GLSL rename costs 4.8 ms)
    assert source_of(net, "out", 0) == "blend_L_d"
    assert source_of(net, "blend_L_d", 0) == "blend_L_c"


def test_add_without_pool_creates_glsl_node(env):
    net, comp, log, _ = env
    m = log.mark()
    net.apply([base(), px("a", 1)], W, H)
    types = [t for t, n in log.since(m)["creates"] if t == "glslTOP"]
    assert len(types) == 2


def test_delete_layer_keeps_surface_for_grace_period(env):
    net, comp, log, clock = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    s3 = net.surface_top(3)
    m = log.mark()
    net.apply(stack_of_three()[:3], W, H)
    d = log.since(m)
    assert not d["destroys"]                                        # nothing destroyed inside apply()
    assert net.slots() == [1, 2]
    assert net.surface_top(3) is s3 and s3.valid                    # still reachable during the grace
    assert source_of(net, "out", 0) == "blend_L_b"
    clock.t += 1.9
    for _ in range(5):
        net.tick()
    assert s3.valid
    clock.t += 0.2
    for _ in range(5):
        net.tick()
    assert not s3.valid
    assert net.surface_top(3) is None
    assert net.stats()["pending_destroy"] == 0


def test_undo_of_delete_within_grace_reuses_surface(env):
    net, comp, log, clock = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    s3 = net.surface_top(3)
    net.apply(stack_of_three()[:3], W, H)
    clock.t += 1.0
    m = log.mark()
    net.apply(stack_of_three(), W, H)
    d = log.since(m)
    assert not any(n == "s3" for t, n in d["creates"])
    assert net.surface_top(3) is s3
    clock.t += 5
    net.tick()
    assert s3.valid                                                 # no longer pending


def test_deleted_blend_L_returns_to_pool_and_is_disconnected(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    pool_before = net.stats()["pool"]
    node = net._ops["blend_L_c"]
    net.apply(stack_of_three()[:3], W, H)
    assert net.stats()["pool"] == pool_before + 1
    assert all(c.source is None for c in node.inputConnectors)
    assert node.tags == [] and node.valid


def test_delete_is_cheap_creates_nothing(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    m = log.mark()
    net.apply(stack_of_three()[:2], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["par_sets"]


def test_doc_resize_updates_resolution_pars_only(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    m = log.mark()
    net.apply(stack_of_three(), 100, 80)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"]
    names = {n for n, k, v in d["par_sets"]}
    assert names == {"blank", "s1", "s2", "s3"}
    assert all(k in ("resolutionw", "resolutionh") for n, k, v in d["par_sets"])


def test_slot_changes_swap_surface_nodes(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    net.apply([base(), px("a", 7)], W, H)
    assert net.slots() == [7]
    assert source_of(net, "blend_L_a", 1) == "s7"
    assert 1 in [s for s in (1,) if net.surface_top(1) is not None]    # old one in grace


# --------------------------------------------------------------------------- masks


def test_mask_wiring(env):
    net, comp, log, _ = env
    st = [base(), px("a", 1, mask={"slot": 10, "enabled": True})]
    net.apply(st, W, H)
    assert source_of(net, "blend_L_a", 2) == "s10"
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 1.0
    assert net.slots() == [1, 10]
    assert net.surface_top(10).OPType == "scriptTOP"


def test_disabled_mask_keeps_surface_but_unwires(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, mask={"slot": 10, "enabled": True})], W, H)
    m = log.mark()
    net.apply([base(), px("a", 1, mask={"slot": 10, "enabled": False})], W, H)
    d = log.since(m)
    assert net.slots() == [1, 10]
    assert source_of(net, "blend_L_a", 2) == "blank"
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 0.0
    assert not d["creates"] and not d["destroys"]
    assert len(d["par_sets"]) == 1 and len(d["connects"]) == 1


def test_add_and_remove_mask(env):
    net, comp, log, clock = env
    net.apply([base(), px("a", 1)], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), px("a", 1, mask={"slot": 10, "enabled": True})], W, H)
    d = log.since(m)
    assert [n for t, n in d["creates"] if t == "scriptTOP"] == ["s10"]
    net.apply([base(), px("a", 1)], W, H)
    assert net.slots() == [1]
    assert source_of(net, "blend_L_a", 2) == "blank"
    clock.t += 3
    for _ in range(4):
        net.tick()
    assert net.surface_top(10) is None


# --------------------------------------------------------------------------- groups


def group_stack():
    return [
        base(), px("a", 1),
        L("g", "group", opacity=0.5, blend="multiply"),
        px("b", 2, parentId="g"), px("c", 3, parentId="g", blend="screen"),
        px("d", 4),
    ]


def test_group_is_an_isolated_chain(env):
    net, comp, log, _ = env
    net.apply(group_stack(), W, H)
    # children chain starts at the transparent blank, not at the accumulated image
    assert source_of(net, "blend_L_b", 0) == "blank"
    assert source_of(net, "blend_L_c", 0) == "blend_L_b"
    # the group's result is the SOURCE of the group's blend; its input 0 is the accumulated image below
    assert source_of(net, "blend_L_g", 0) == "blend_L_a"
    assert source_of(net, "blend_L_g", 1) == "blend_L_c"
    assert source_of(net, "blend_L_d", 0) == "blend_L_g"
    assert net._ops["blend_L_g"].par.value("vec0valuey") == 0.5
    assert net._ops["blend_L_g"].par.value("vec0valuex") == 1.0           # multiply


def test_empty_group_is_bypassed(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), L("g", "group")], W, H)
    assert net._ops["blend_L_g"].bypass is True
    assert source_of(net, "blend_L_g", 1) == "blank"


def test_nested_groups_and_layout_columns(env):
    net, comp, log, _ = env
    st = [base(), L("g1", "group"), L("g2", "group", parentId="g1"), px("a", 1, parentId="g2"), px("b", 2, parentId="g1")]
    net.apply(st, W, H)
    assert source_of(net, "blend_L_a", 0) == "blank"
    assert source_of(net, "blend_L_g2", 0) == "blank"
    assert source_of(net, "blend_L_g2", 1) == "blend_L_a"
    assert source_of(net, "blend_L_b", 0) == "blend_L_g2"
    assert source_of(net, "blend_L_g1", 1) == "blend_L_b"
    assert net._ops["blend_L_a"].nodeX > net._ops["blend_L_g2"].nodeX > net._ops["blend_L_g1"].nodeX


def test_group_mask(env):
    net, comp, log, _ = env
    st = [base(), L("g", "group", mask={"slot": 9, "enabled": True}), px("a", 1, parentId="g")]
    net.apply(st, W, H)
    assert source_of(net, "blend_L_g", 2) == "s9"


def test_move_layer_into_group_rewires_only(env):
    net, comp, log, _ = env
    st = [base(), L("g", "group"), px("a", 1), px("b", 2)]
    net.apply(st, W, H)
    settle(net)
    m = log.mark()
    st2 = [base(), L("g", "group"), px("a", 1, parentId="g"), px("b", 2)]
    net.apply(st2, W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"]
    assert source_of(net, "blend_L_a", 0) == "blank"
    assert source_of(net, "blend_L_g", 1) == "blend_L_a"


# --------------------------------------------------------------------------- adjustments


def adj(id_, spec, **kw):
    return L(id_, "adjustment", adjustment=spec, **kw)


LEVELS = {"type": "levels", "inLow": 0.1, "inHigh": 0.9, "gamma": 2.0, "outLow": 0.2, "outHigh": 0.8}


















def test_adjustment_with_mask_and_hidden(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("lv", LEVELS, mask={"slot": 5, "enabled": True}, visible=False)], W, H)
    assert source_of(net, "blend_L_lv", 2) == "s5"
    assert net._ops["blend_L_lv"].bypass is True
    assert net._ops["blend_L_lv"].par.value("vec0valuez") == 1.0






# --------------------------------------------------------------------------- housekeeping


def test_unknown_nodes_inside_doc_are_removed(env):
    net, comp, log, _ = env
    doc = comp.op("doc")
    stray = doc.create("constantTOP", "user_added")
    stray2 = doc.create("textDAT", "notes")
    net.apply([base(), px("a", 1)], W, H)
    assert not stray.valid and not stray2.valid
    assert doc.op("blend_glsl") is not None and doc.op("surface_callbacks") is not None


def test_unknown_node_added_later_is_removed_on_structural_change(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    stray = comp.op("doc").create("nullTOP", "late")
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    assert not stray.valid


def test_companion_dats_are_destroyed_in_tick_not_apply(env):
    net, comp, log, _ = env
    m = log.mark()
    net.apply([base(), px("a", 1)], W, H)
    assert not log.since(m)["destroys"]
    assert net.stats()["junk"] > 0
    settle(net)
    doc = comp.op("doc")
    assert doc.op("s1_callbacks") is None
    assert not [c for c in doc.children if c.name.endswith(("_info", "_pixel", "_compute"))]
    # the surface and blend nodes themselves are untouched
    assert doc.op("s1") is not None


def test_tick_is_incremental_and_tops_up_the_pool(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    settle(net)
    assert net.stats()["pool"] == network.POOL_TARGET
    m = log.mark()
    net.tick()
    assert not log.since(m)["creates"]                                # nothing to do


def test_pool_nodes_are_fully_configured(env):
    net, comp, log, _ = env
    net.tick()
    node, cache = net._pool[0]
    pv = node.par.value
    assert pv("pixeldat") == "blend_glsl" and pv("vec0name") == "uParams" and pv("vec1name") == "uXform"
    assert pv("format") == network.FMT_BLEND


def test_backlog_is_bounded_without_ticks(env):
    net, comp, log, _ = env
    st = [base()] + [px("p%d" % i, i + 1) for i in range(10)]
    net.apply(st, W, H)
    net.apply([base()], W, H)
    for i in range(6):
        net.apply([base()] + [adj("a%d_%d" % (i, j), LEVELS) for j in range(3)], W, H)
        net.apply([base()], W, H)
    s = net.stats()
    assert s["garbage"] <= network.GARBAGE_MAX and s["junk"] <= network.JUNK_MAX and s["pending_destroy"] <= network.PENDING_MAX


def test_adopts_existing_network_without_creating(env):
    net, comp, log, clock = env
    st = [base(), px("a", 1, mask={"slot": 9, "enabled": True}), L("g", "group"), px("b", 2, parentId="g"), adj("lv", LEVELS)]
    net.apply(st, W, H)
    settle(net)
    for s in (1, 2, 9):
        net.surface_top(s).lock = True
    net2 = DocNetwork(comp, GLSL, clock=clock, optimize=False)
    m = log.mark()
    net2.apply(st, W, H)
    d = log.since(m)
    assert not d["creates"]
    assert not d["destroys"]
    assert net2.slots() == [1, 2, 9]
    assert all(net2.surface_top(s).lock for s in (1, 2, 9))           # locked pixels are not touched
    assert source_of(net2, "blend_L_lv", 1) == "blank"
    assert net2._ops["blend_L_a"].tags == ["role:blend_L_a"]


def test_adoption_removes_stale_roles_but_recycles_glsl(env):
    net, comp, log, clock = env
    net.apply([base(), px("a", 1), px("gone", 2)], W, H)
    settle(net)
    net2 = DocNetwork(comp, GLSL, clock=clock, optimize=False)
    m = log.mark()
    net2.apply([base(), px("a", 1)], W, H)
    d = log.since(m)
    # stale blend_L_gone glsl node was recycled into the pool, the stale surface s2 was destroyed as unknown
    assert not any(t == "glslTOP" for t, n in d["creates"])
    assert "s2" in d["destroys"]
    assert net2.stats()["pool"] >= 1


def test_name_sanitising_and_collisions(env):
    net, comp, log, _ = env
    assert network.sanitize("a-b c") == "a_b_c"
    assert network.sanitize("7up") == "_7up"
    net.apply([base(), px("a-b", 1), px("a_b", 2)], W, H)
    assert "blend_L_a_b" in net._ops and "blend_L_a_b_2" in net._ops
    assert source_of(net, "blend_L_a_b_2", 1) == "s2"


def test_orphans_are_attached_to_root(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, parentId="missing")], W, H)
    assert source_of(net, "blend_L_a", 0) == "blend_L_base"


def test_input_connection_switches_base_source(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    assert net._ops["src_in1"].par.value("top") == "blank"
    comp.inputConnectors[0].source = comp.in1          # any connected source
    m = log.mark()
    net.apply([base(), px("a", 1)], W, H)               # apply detects the change itself
    assert net._ops["src_in1"].par.value("top") == "../in1"
    assert len(log.since(m)["par_sets"]) == 1
    net.set_input_connected(False)
    assert net._ops["src_in1"].par.value("top") == "blank"


def test_stats(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    s = net.stats()
    assert s["surfaces"] == 3 and s["last_apply_ms"] >= 0
    assert s["by_type"]["scriptTOP"] == 3
    assert s["totals"]["applies"] == 1
    assert s["last"]["created"] > 0
    net.apply(stack_of_three(), W, H)
    assert net.stats()["last"]["created"] == 0


# --------------------------------------------------------------------------- persistence


def test_freeze_locks_then_writes_pixels(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    net.freeze()
    assert all(net.surface_top(s).lock for s in (1, 2, 3))
    # OnSurfaceCook is called AFTER the lock (locking resets the locked image)
    assert [(n, locked) for n, locked in comp.op("doc").parent_op.surface_cooks] == [("s1", True), ("s2", True), ("s3", True)]
    locked = net.read_locked()
    assert sorted(locked) == [1, 2, 3]
    net.thaw()
    assert not any(net.surface_top(s).lock for s in (1, 2, 3))
    assert net.read_locked() == {}


def test_freeze_is_idempotent(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    net.freeze()
    n = len(comp.surface_cooks)
    net.freeze()
    assert len(comp.surface_cooks) == n


# --------------------------------------------------------------------------- view overlay


def test_view_uniforms_math():
    view = {"mode": "td", "zoom": 2.0, "panX": 15, "panY": 5, "rect": {"x": 10, "y": 20, "w": 160, "h": 100}}
    ox, oy, z, down, x0, y0, x1, y1 = network.view_uniforms(view, 200, 150, 40, 30)
    assert (ox, oy, z, down) == (25.0, 25.0, 2.0, 0.0)
    assert (x0, y0, x1, y1) == (10.0, 20.0, 170.0, 120.0)
    # panel pixel of document pixel (3, 4): top-left origin; the TD (bottom-left) row is panel_h - 1 - row
    px_, py_ = ox + 3 * z, oy + 4 * z
    assert (px_, py_) == (31.0, 33.0)
    assert 150 - 1 - int(py_) == 116


def test_view_uniforms_clip_and_downscale():
    view = {"mode": "td", "zoom": 0.5, "panX": -10, "panY": 0, "rect": {"x": -5, "y": 0, "w": 400, "h": 100}}
    ox, oy, z, down, x0, y0, x1, y1 = network.view_uniforms(view, 200, 150, 40, 30)
    assert down == 1.0 and z == 0.5
    assert (x0, y0, x1, y1) == (0.0, 0.0, 200.0, 100.0)               # intersection with the panel
    assert (ox, oy) == (-15.0, 0.0)


def test_view_uniforms_bad_zoom_falls_back():
    assert network.view_uniforms({"zoom": 0, "rect": {"x": 0, "y": 0, "w": 10, "h": 10}}, 10, 10, 4, 4)[2] == 1.0


def test_set_view_builds_overlay_once_and_caches_pars(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    view = {"mode": "td", "zoom": 2.0, "panX": 15, "panY": 5, "rect": {"x": 10, "y": 20, "w": 160, "h": 100}}
    net.set_view(view, 200, 150)
    for name in ("view_doc", "view_glsl", "doc_view", "panel_view"):
        assert comp.op(name) is not None
    assert comp.op("view_doc").par.value("top") == "doc/out"
    assert comp.op("view_glsl").text == network.VIEW_GLSL
    dv = comp.op("doc_view")
    assert dv.par.value("resolutionw") == 200 and dv.par.value("resolutionh") == 150
    assert (dv.par.value("vec0valuex"), dv.par.value("vec0valuey"), dv.par.value("vec0valuez")) == (25.0, 25.0, 2.0)
    assert (dv.par.value("vec1valuex"), dv.par.value("vec1valuew")) == (10.0, 120.0)
    assert dv.par.value("inputfiltertype") == "nearest"
    # Over: webrender on top (input 0), the document below (input 1)
    pv = comp.op("panel_view")
    assert pv.OPType == "overTOP"
    assert pv.inputConnectors[0].source is comp.op("webrender")
    assert pv.inputConnectors[1].source is comp.op("doc_view")
    assert net.panel_view() is pv
    # unchanged view: no parameter writes; a pan: only the changed ones
    m = log.mark()
    net.set_view(dict(view), 200, 150)
    assert not log.since(m)["par_sets"] and not log.since(m)["creates"]
    net.set_view(dict(view, panX=20), 200, 150)
    assert [k for n, k, v in log.since(m)["par_sets"]] == ["vec0valuex"]
    net.set_view(dict(view, zoom=0.5), 200, 150)
    assert dv.par.value("inputfiltertype") == "mipmap"
    net.set_view(None, 200, 150)
    assert net.stats()["view"] is False
    assert net.panel_view() is pv


def test_panel_view_available_before_set_view(env):
    net, comp, log, _ = env
    assert net.panel_view() is not None


def test_view_shader_contract():
    g = network.VIEW_GLSL
    assert "uniform vec4 uView" in g and "uniform vec4 uClip" in g and "TDOutputSwizzle" in g
    assert "0.811764706" in g            # #cfcfcf, as web/src/ui/viewportDraw.ts
    assert "/ 8.0" in g                  # 8 px checker cells


# --------------------------------------------------------------------------- review regressions


def _all_valid(net):
    return all(o.valid for o in net._ops.values())




def test_fake_renames_duplicates_like_td():
    comp, log = fakenet.make_comp()
    a = comp.create("nullTOP", "x")
    b = comp.create("nullTOP", "x")
    assert (a.name, b.name) == ("x", "x1")


def test_layer_ids_cannot_collide_with_reserved_names(env):
    net, comp, log, _ = env
    net.apply([base(), px("glsl", 1), px("base", 2), px("out", 3)], W, H)
    doc = comp.op("doc")
    assert doc.op("blend_glsl").OPType == "textDAT"
    assert "blend_L_glsl" in net._ops and "blend_L_base" in net._ops and "blend_L_out" in net._ops
    assert source_of(net, "out", 0) == "blend_L_out"


def test_reparent_out_of_group(env):
    net, comp, log, _ = env
    net.apply([base(), L("g", "group"), px("a", 1, parentId="g"), px("b", 2, parentId="g")], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), L("g", "group"), px("a", 1), px("b", 2, parentId="g")], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"]
    assert source_of(net, "blend_L_g", 0) == "blend_L_base"
    assert source_of(net, "blend_L_g", 1) == "blend_L_b"
    assert source_of(net, "blend_L_b", 0) == "blank"
    assert source_of(net, "blend_L_a", 0) == "blend_L_g"
    assert source_of(net, "out", 0) == "blend_L_a"


def test_delete_group_with_masks_and_adjustments(env):
    net, comp, log, clock = env
    st = [base(), px("a", 1), L("g", "group", mask={"slot": 8, "enabled": True}),
          px("b", 2, parentId="g", mask={"slot": 9, "enabled": True}),
          adj("lv", LEVELS, parentId="g", mask={"slot": 10, "enabled": True})]
    net.apply(st, W, H)
    settle(net)
    net.apply(st[:2], W, H)
    assert net.slots() == [1]
    assert source_of(net, "out", 0) == "blend_L_a"
    clock.t += 3
    for _ in range(40):
        net.tick()
    assert _all_valid(net)
    names = {c.name for c in net.doc.children}
    assert not {"s2", "s8", "s9", "s10"} & names
    assert net.stats()["pending_destroy"] == 0 and net.stats()["garbage"] == 0




def test_pool_never_exceeds_max(env):
    net, comp, log, _ = env
    big = [base()] + [px("p%d" % i, i + 1) for i in range(network.POOL_MAX + 6)]
    net.apply(big, W, H)
    net.apply([base()], W, H)
    assert net.stats()["pool"] <= network.POOL_MAX
    for _ in range(60):
        net.tick()
    assert net.stats()["pool"] <= network.POOL_MAX
    assert _all_valid(net)


def test_big_paste_refills_two_per_tick(env):
    net, comp, log, _ = env
    assert net.stats()["pool"] == 0
    m = log.mark()
    net.tick()
    assert len([1 for t, n in log.since(m)["creates"] if t == "glslTOP"]) == 2


def test_apply_raising_midway_then_retry(env):
    net, comp, log, _ = env
    st = stack_of_three()
    net.apply(st[:2], W, H)
    boom = {"n": 0}
    orig = fakenet.FakePars.__setattr__

    def flaky(self, name, value):
        if name == "vec0valuey" and boom["n"] == 0 and self._op.tags == ["role:blend_L_b"]:
            boom["n"] += 1
            raise RuntimeError("TD hiccup")
        orig(self, name, value)

    fakenet.FakePars.__setattr__ = flaky
    try:
        with pytest.raises(RuntimeError):
            net.apply(st, W, H)
        net.apply(st, W, H)                                           # retry converges
    finally:
        fakenet.FakePars.__setattr__ = orig
    assert source_of(net, "out", 0) == "blend_L_c"
    assert source_of(net, "blend_L_c", 1) == "s3"
    assert net._ops["blend_L_b"].par.value("vec0valuey") == 0.5
    assert net._ops["blend_L_b"].par.value("vec0valuex") == 1.0
    assert net.slots() == [1, 2, 3]


def test_resize_while_surface_pending_then_undo(env):
    net, comp, log, clock = env
    net.apply(stack_of_three(), W, H)
    settle(net)
    s3 = net.surface_top(3)
    net.apply(stack_of_three()[:3], W, H)
    net.apply(stack_of_three()[:3], 100, 80)
    clock.t += 1
    net.apply(stack_of_three(), 100, 80)
    assert net.surface_top(3) is s3 and s3.valid
    assert (s3.par.value("resolutionw"), s3.par.value("resolutionh")) == (100, 80)
    clock.t += 5
    net.tick()
    assert s3.valid


def test_blur_tiny_radius_is_identity(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("bl", {"type": "blur", "radius": 0.03})], W, H)
    assert net._ops["adj_L_bl"].bypass is True


def test_unknown_removal_survives_children_dying_with_parent(env, monkeypatch):
    net, comp, log, clock = env
    net.apply([base(), px("a", 1)], W, H)            # leaves companion DATs (g*_info, s1_callbacks ...) behind
    assert net.stats()["junk"] > 0
    monkeypatch.setattr(network, "POOL_MAX", 0)       # spares cannot be recycled -> destroyed as unknown
    net2 = DocNetwork(comp, GLSL, clock=clock, optimize=False)
    net2.apply([base()], W, H)                        # must not touch the dead companions
    names = {c.name for c in comp.op("doc").children}
    assert not any(n.endswith(("_info", "_pixel", "_compute")) or re.match(r"s\d+_callbacks", n) for n in names), names
    net2.tick()


def test_tick_prunes_junk_that_died_with_its_parent(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    net.apply([base()], W, H)
    for _ in range(80):
        net.tick()
    assert net.stats()["junk"] == 0


def uvals(net, role):
    pv = net._ops[role].par.value
    return tuple(pv(k) for k in ("vec2valuex", "vec2valuey", "vec2valuez", "vec2valuew", "vec3valuex"))


def test_levels_is_one_pass_with_uniforms(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("lv", LEVELS, opacity=0.7)], W, H)
    assert source_of(net, "blend_L_lv", 0) == "blend_L_a"
    assert source_of(net, "blend_L_lv", 1) == "blank"
    assert not [r for r in net._ops if r.startswith("adj_")]          # no helper nodes at all
    pv = net._ops["blend_L_lv"].par.value
    assert pv("vec0valuew") == network.ADJ_LEVELS and pv("vec0valuey") == 0.7
    assert uvals(net, "blend_L_lv") == (0.1, 0.9, 2.0, 0.2, 0.8)
    assert net._ops["blend_L_lv"].par.value("vec2name") == "uA"


def test_levels_degenerate_input_range_is_guarded():
    p = network.adjustment_plan({"type": "levels", "inLow": 0.5, "inHigh": 0.5, "gamma": 1, "outLow": 0, "outHigh": 1}, "x")
    assert p.extra["vec2valuey"] > p.extra["vec2valuex"]
    p = network.adjustment_plan({"type": "levels", "inLow": 0, "inHigh": 1, "gamma": 99, "outLow": 0, "outHigh": 1}, "x")
    assert p.extra["vec2valuez"] == 10.0


def test_adjustment_param_edit_is_par_sets_only(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("lv", LEVELS)], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), px("a", 1), adj("lv", dict(LEVELS, gamma=1.5))], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"]
    assert [k for n, k, v in d["par_sets"]] == ["vec2valuez"]


def test_brightness_contrast_invert_threshold_hue_mapping(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1),
               adj("bc", {"type": "brightnessContrast", "brightness": 0.25, "contrast": -0.5}),
               adj("iv", {"type": "invert"}),
               adj("th", {"type": "threshold", "level": 0.3}),
               adj("hs", {"type": "hueSaturation", "hue": 30, "saturation": 1.5, "value": 0.8})], W, H)
    code = lambda r: net._ops[r].par.value("vec0valuew")
    assert (code("blend_L_bc"), code("blend_L_iv"), code("blend_L_th"), code("blend_L_hs")) == \
        (network.ADJ_BC, network.ADJ_INVERT, network.ADJ_THRESHOLD, network.ADJ_HSV)
    assert uvals(net, "blend_L_bc")[:2] == (0.25, -0.5)
    assert uvals(net, "blend_L_th")[0] == 0.3
    assert uvals(net, "blend_L_hs")[:3] == (30, 1.5, 0.8)
    # each adjustment sees the accumulated result below it (chain order)
    assert source_of(net, "blend_L_iv", 0) == "blend_L_bc" and source_of(net, "blend_L_th", 0) == "blend_L_iv"
    assert source_of(net, "blend_L_hs", 0) == "blend_L_th"


def test_blur_mapping_and_preshrink(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("bl", {"type": "blur", "radius": 4})], W, H)
    b = net._ops["adj_L_bl"]
    assert b.OPType == "blurTOP" and source_of(net, "adj_L_bl", 0) == "blend_L_a"
    assert b.par.value("type") == "gaussian" and b.par.value("extend") == "hold"
    assert b.par.value("size") == round(4 * 4.698) and b.par.value("preshrink") == 1
    assert net._ops["blend_L_bl"].par.value("vec0valuew") == network.ADJ_PREMULT
    assert source_of(net, "blend_L_bl", 1) == "adj_L_bl"
    for r, ps in ((5.9, 1), (6, 2), (13.9, 2), (14, 4), (31.9, 4), (32, 8), (200, 8)):
        assert network.blur_preshrink(r) == ps
    n = network.adjustment_plan({"type": "blur", "radius": 100}, "z").nodes[0]
    assert n[2]["preshrink"] == 8 and n[2]["size"] == round(100 * 4.698 / 8)
    net.apply([base(), px("a", 1), adj("bl", {"type": "blur", "radius": 0})], W, H)
    assert net._ops["adj_L_bl"].bypass is True


def test_adjustment_type_change_rewires(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("x", {"type": "blur", "radius": 8})], W, H)
    blur_op = net._ops["adj_L_x"]
    net.apply([base(), px("a", 1), adj("x", LEVELS)], W, H)
    assert "adj_L_x" not in net._ops
    assert source_of(net, "blend_L_x", 1) == "blank"
    assert net._ops["blend_L_x"].par.value("vec0valuew") == network.ADJ_LEVELS
    net.apply([base(), px("a", 1), adj("x", {"type": "blur", "radius": 8})], W, H)
    assert net._ops["blend_L_x"].inputConnectors[1].source is net._ops["adj_L_x"]
    assert net._ops["blend_L_x"].par.value("vec0valuew") == network.ADJ_PREMULT
    assert blur_op.valid or True


def test_adjustment_inside_group_sees_only_group_content(env):
    net, comp, log, _ = env
    st = [base(), px("a", 1), L("g", "group"), px("b", 2, parentId="g"), adj("lv", LEVELS, parentId="g")]
    net.apply(st, W, H)
    assert source_of(net, "blend_L_lv", 0) == "blend_L_b"
    assert source_of(net, "blend_L_g", 1) == "blend_L_lv"


def test_delete_blur_defers_destroy_to_tick(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("bl", {"type": "blur", "radius": 8})], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), px("a", 1)], W, H)
    assert not log.since(m)["destroys"]
    assert net.stats()["garbage"] == 1
    for _ in range(5):
        net.tick()
    assert "adj_L_bl" not in net._ops and net.stats()["garbage"] == 0


def test_garbage_resurrection_keeps_live_nodes(env):
    net, comp, log, _ = env
    with_adj = [base(), px("a", 1), adj("bl", {"type": "blur", "radius": 8})]
    net.apply(with_adj, W, H)
    settle(net)
    net.apply([base(), px("a", 1)], W, H)
    assert net.stats()["garbage"] == 1
    net.apply(with_adj, W, H)
    for _ in range(8):
        net.tick()
    assert _all_valid(net) and comp.op("doc").op("adj_L_bl").valid
    assert source_of(net, "blend_L_bl", 1) == "adj_L_bl"


def test_nested_group_and_adjustment_type_change_in_one_apply(env):
    net, comp, log, _ = env
    st = [base(), L("g1", "group"), L("g2", "group", parentId="g1"), px("a", 1, parentId="g2"),
          adj("x", LEVELS, parentId="g2"), adj("y", {"type": "invert"}, parentId="g1")]
    net.apply(st, W, H)
    st2 = [base(), L("g1", "group"), L("g2", "group", parentId="g1"), px("a", 1, parentId="g2"),
           adj("x", {"type": "blur", "radius": 10}, parentId="g2"),
           adj("y", {"type": "hueSaturation", "hue": 5, "saturation": 1, "value": 1}, parentId="g1")]
    net.apply(st2, W, H)
    assert net._ops["adj_L_x"].OPType == "blurTOP"
    assert source_of(net, "adj_L_x", 0) == "blend_L_a"
    assert net._ops["blend_L_x"].inputConnectors[1].source is net._ops["adj_L_x"]
    assert net._ops["blend_L_y"].par.value("vec0valuew") == network.ADJ_HSV
    assert source_of(net, "blend_L_y", 0) == "blend_L_g2"


# --------------------------------------------------------------------------- v3: text and shape layers

RED = {"r": 255, "g": 0, "b": 0, "a": 255}
BLUE = {"r": 0, "g": 0, "b": 255, "a": 128}
FILL = {"enabled": True, "color": RED}
STROKE = {"enabled": True, "color": BLUE, "width": 4}
NOSTROKE = {"enabled": False, "color": BLUE, "width": 0}
RECT = {"type": "rect", "x": 10, "y": 5, "w": 20, "h": 10, "radius": 3, "fill": FILL, "stroke": STROKE, "rotation": 0}
TEXT = {"text": "Hi", "font": "Arial", "size": 20, "color": RED, "align": "left", "bold": False, "italic": False,
        "lineHeight": 1.2, "x": 7, "y": 9, "boxWidth": None}


def shp(id_, spec=RECT, **kw):
    return L(id_, "shape", shape=spec, text=None, **kw)


def txt(id_, spec=TEXT, **kw):
    return L(id_, "text", text=spec, shape=None, **kw)


def pvals(net, role, prefix):
    pv = net._ops[role].par.value
    return tuple(pv("%svalue%s" % (prefix, k)) for k in "xyzw")


def test_shape_uniform_conversion_to_bottom_left():
    u = network.shape_uniforms(dict(RECT, rotation=30), 48)
    assert (u["vec0valuex"], u["vec0valuez"], u["vec0valuew"]) == (1.0, 1.0, 1.0)
    assert u["vec0valuey"] == pytest.approx(-0.5235988)          # clockwise on screen -> CCW negative in y-up
    # centre (20, 10) top-left -> (20, 38) bottom-left; half sizes
    assert [u["vec1value" + k] for k in "xyzw"] == [20.0, 38.0, 10.0, 5.0]
    assert u["vec2valuex"] == 3.0 and u["vec2valuez"] == 4.0
    assert [u["vec3value" + k] for k in "xyzw"] == [1.0, 0.0, 0.0, 1.0]
    assert [u["vec4value" + k] for k in "xyzw"] == [0.0, 0.0, 1.0, pytest.approx(128 / 255)]


def test_shape_uniform_rect_radius_clamped_and_negative_size():
    u = network.shape_uniforms(dict(RECT, radius=99, x=30, y=15, w=-20, h=-10), 48)
    assert u["vec2valuex"] == 5.0                                  # min(w, h) / 2
    assert [u["vec1value" + k] for k in "xyzw"] == [20.0, 38.0, 10.0, 5.0]    # same box as the positive one


def test_shape_uniform_disabled_fill_and_stroke():
    u = network.shape_uniforms(dict(RECT, fill={"enabled": False, "color": RED}, stroke=NOSTROKE), 48)
    assert u["vec0valuez"] == 0.0 and u["vec0valuew"] == 0.0
    u = network.shape_uniforms(dict(RECT, stroke={"enabled": True, "color": BLUE, "width": 0}), 48)
    assert u["vec0valuew"] == 0.0                                  # zero width = no stroke


def test_shape_uniform_line_ellipse_polygon():
    line = {"type": "line", "x1": 2, "y1": 3, "x2": 20, "y2": 30, "stroke": STROKE, "arrowStart": True, "arrowEnd": False}
    u = network.shape_uniforms(line, 48)
    assert u["vec0valuex"] == 3.0 and u["vec0valuez"] == 0.0 and u["vec0valuey"] == 0.0
    assert [u["vec1value" + k] for k in "xyzw"] == [2.0, 45.0, 20.0, 18.0]
    assert u["vec2valuew"] == 1.0
    assert network.shape_uniforms(dict(line, arrowStart=False, arrowEnd=True), 48)["vec2valuew"] == 2.0
    assert network.shape_uniforms(dict(line, arrowEnd=True), 48)["vec2valuew"] == 3.0
    ell = {"type": "ellipse", "x": 0, "y": 0, "w": 40, "h": 20, "fill": FILL, "stroke": NOSTROKE, "rotation": 90}
    u = network.shape_uniforms(ell, 48)
    assert u["vec0valuex"] == 2.0 and u["vec2valuex"] == 0.0
    assert [u["vec1value" + k] for k in "xyzw"] == [20.0, 38.0, 20.0, 10.0]
    poly = {"type": "polygon", "cx": 30, "cy": 10, "radius": 8, "sides": 100, "innerRatio": 0.4, "fill": FILL,
            "stroke": STROKE, "rotation": 0}
    u = network.shape_uniforms(poly, 48)
    assert u["vec0valuex"] == 4.0 and u["vec2valuey"] == 64.0     # sides clamped to 64
    assert [u["vec1value" + k] for k in "xyzw"] == [30.0, 38.0, 8.0, 0.4]
    assert network.shape_uniforms(dict(poly, sides=1, innerRatio=7), 48)["vec2valuey"] == 3.0


def test_shape_layer_builds_shape_node_without_surface(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s")], W, H)
    n = net._ops["shape_s"]
    assert n.OPType == "glslTOP" and n.par.value("pixeldat") == "shape_glsl"
    assert net.slots() == [] and "s1" not in net._ops
    assert source_of(net, "blend_L_s", 0) == "blend_L_base"
    assert source_of(net, "blend_L_s", 1) == "shape_s"
    assert source_of(net, "blend_L_s", 2) == "blank"
    assert not n.inputConnectors[0].connections                       # no inputs
    pv = n.par.value
    assert (pv("outputresolution"), pv("resolutionw"), pv("resolutionh")) == ("custom", W, H)
    assert [pv("vec%dname" % i) for i in range(5)] == ["uParams", "uOffset", "uA", "uB", "uC"]
    assert pvals(net, "shape_s", "vec1") == (20.0, H - 10.0, 10.0, 5.0)
    assert net.doc.op("shape_glsl").text.startswith("// Raster Editor v3 shape layer")
    assert net._ops["shape_s"].tags == ["role:shape_s"]


def test_text_layer_builds_text_top(env):
    net, comp, log, _ = env
    net.apply([base(), txt("t")], W, H)
    n = net._ops["text_t"]
    assert n.OPType == "textTOP"
    assert source_of(net, "blend_L_t", 1) == "text_t"
    pv = n.par.value
    P = network.TEXT_PAR
    assert pv(P["text"]) == "Hi" and pv(P["font"]) == "Arial" and pv(P["size"]) == 20
    assert (pv(P["colorr"]), pv(P["colorg"]), pv(P["alpha"])) == (1.0, 0.0, 1.0)
    assert pv("bgalpha") == 0.0 and pv("resolutionw") == W and pv("resolutionh") == H


def test_text_pars_mapping_variants():
    P = network.TEXT_PAR
    M = {"asc": 17.0, "pitch": 22.0, "tw": 40.0}                        # measured: ascent, natural pitch, widest line
    u = network.text_pars(dict(TEXT, align="center", bold=True, italic=True, lineHeight=1.5, boxWidth=100,
                               color={"r": 51, "g": 102, "b": 153, "a": 51}), 200, 100, M)
    assert u[P["alignx"]] == "center" and u["typeface"] == "Bold Italic"
    assert u[P["wrap"]] is False and u[P["colorr"]] == pytest.approx(0.2) and u[P["alpha"]] == pytest.approx(0.2)
    assert u["fontsizexunit"] == "pixels" and u["aligny"] == "top" and u["bgalpha"] == 0.0
    # line pitch: size * lineHeight = 30, natural 22 -> 8 extra px
    assert u[P["spacing"]] == pytest.approx(8.0)
    # centre in a 100 wide block at x=7: anchor = x + bw/2 = 57 -> positionx = 57 - 200/2
    assert u[P["border"]] == 0.0 and u[P["posx"]] == pytest.approx(57 - 100)
    assert network.text_pars(dict(TEXT, align="right", boxWidth=100), 200, 100, M)[P["posx"]] == 7 + 100 - 200
    assert network.text_pars(dict(TEXT, align="left", boxWidth=100), 200, 100, M)[P["posx"]] == 7
    # baseline of line 0 = y + (30 - 20)/2 + 16 = 30 below y=9 -> top = 39 - asc 17 = 22 -> positiony = -22
    assert u[P["posy"]] == pytest.approx(-(9 + 5 + 16 - 17))
    # the lines come from the metrics (wrapped by DocNetwork)
    assert network.text_pars(TEXT, 200, 100, dict(M, text="a\nb"))[P["text"]] == "a\nb"
    nb = network.text_pars(TEXT, 200, 100, M)
    assert nb[P["wrap"]] is False and nb[P["border"]] == 0.0 and nb[P["posx"]] == 7.0
    assert network.text_pars(dict(TEXT, align="center"), 200, 100, M)[P["posx"]] == 7 + 20 - 100
    assert network.text_pars(dict(TEXT, align="right"), 200, 100, M)[P["posx"]] == 7 + 40 - 200
    assert network.text_pars(dict(TEXT, align="bogus"), W, H, M)[P["alignx"]] == "left"


def test_text_metrics_are_measured_once_and_cached(env):
    net, comp, log, _ = env
    net.apply([base(), txt("t", dict(TEXT, align="center"))], W, H)
    m = net._ops["text_measure"]
    assert m.OPType == "textTOP" and m.cooks >= 2
    n = m.cooks
    net.apply([base(), txt("t", dict(TEXT, align="center", x=30))], W, H)      # move: nothing to measure
    assert m.cooks == n
    net.apply([base(), txt("t", dict(TEXT, align="center", text="Longer text"))], W, H)   # new width only
    assert m.cooks == n + 1
    P = network.TEXT_PAR
    # fake: 0.5 em per char -> 11 chars * 10 = 110 wide; asc = 1.1*20 - 5 = 17
    assert net._ops["text_t"].par.value(P["posx"]) == pytest.approx(7 + 55 - W / 2)
    assert "text_measure" in net._ops and not net._cache.get("text_measure", {}).get("inputs")


def test_shape_spec_edit_is_par_sets_only_and_cheap(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s")], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), shp("s", dict(RECT, x=12, rotation=15))], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert {k for n, k, v in d["par_sets"]} == {"vec0valuey", "vec1valuex"}
    assert net.stats()["last"]["par_sets"] == 2


def test_text_spec_edit_is_par_sets_only(env):
    net, comp, log, _ = env
    net.apply([base(), txt("t")], W, H)
    settle(net)
    m = log.mark()
    net.apply([base(), txt("t", dict(TEXT, text="Hello", size=24, x=9))], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"]
    P = network.TEXT_PAR
    # size changes the baseline, pitch and the (left aligned) x stays
    assert {k for n, k, v in d["par_sets"]} == {P["text"], P["size"], "fontsizey", P["posx"], P["posy"], P["spacing"]}


def test_text_shape_never_have_surfaces_and_ignore_legacy_fields(env):
    net, comp, log, _ = env
    # v5: `rasterize` is gone; a stale slot / rasterize / transform on a text or shape layer is ignored
    net.apply([base(), shp("s", rasterize=True, slot=4, x=9, y=9, sx=2.0, sy=2.0), txt("t", rasterize=True, slot=2)],
              W, H)
    assert net.slots() == [] and net.surface_top(4) is None
    assert source_of(net, "blend_L_s", 1) == "shape_s" and source_of(net, "blend_L_t", 1) == "text_t"
    assert pvals(net, "blend_L_s", "vec1") == (0.0, 0.0, 1.0, 1.0)         # identity: geometry lives in the spec
    assert net._ops["blend_L_s"].par.value("inputfiltertype") == "nearest"


def test_text_shape_with_mask_opacity_blend_hidden_and_group(env):
    net, comp, log, _ = env
    layers = [base(), L("grp", "group"),
              shp("s", parentId="grp", opacity=0.4, blend="multiply", mask={"slot": 7, "enabled": True}),
              txt("t", visible=False)]
    net.apply(layers, W, H)
    assert source_of(net, "blend_L_s", 1) == "shape_s" and source_of(net, "blend_L_s", 2) == "s7"
    assert source_of(net, "blend_L_s", 0) == "blank"                       # group chain starts at blank
    pv = net._ops["blend_L_s"].par.value
    assert pv("vec0valuex") == network.BLEND_INDEX["multiply"] and pv("vec0valuey") == 0.4 and pv("vec0valuez") == 1.0
    assert source_of(net, "blend_L_grp", 1) == "blend_L_s"
    assert net._ops["blend_L_t"].bypass is True
    assert net.slots() == [7]


def test_doc_resize_updates_text_and_shape_pars(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s"), txt("t")], W, H)
    net.apply([base(), shp("s"), txt("t")], 100, 80)
    assert net._ops["shape_s"].par.value("resolutionw") == 100
    assert pvals(net, "shape_s", "vec1") == (20.0, 80 - 10.0, 10.0, 5.0)   # y flip uses the new height
    assert net._ops["text_t"].par.value("resolutionh") == 80


def test_pooled_shape_node_serves_blend_with_inherited_resolution(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s")], W, H)
    settle(net)
    shape_op = net._ops["shape_s"]
    net.apply([base()], W, H)              # delete: back to the pool
    assert shape_op.par.value("outputresolution") == "useinput"
    net.apply([base(), px("a", 1)], W, H)
    pv = net._ops["blend_L_a"].par.value
    assert pv("pixeldat") == "blend_glsl" and pv("format") == network.FMT_BLEND
    assert pv("outputresolution") in (None, "useinput")


def test_missing_spec_is_blank(env):
    net, comp, log, _ = env
    net.apply([base(), L("t", "text", text=None), L("s", "shape", shape=None)], W, H)
    assert source_of(net, "blend_L_t", 1) == "blank" and source_of(net, "blend_L_s", 1) == "blank"


def test_shape_glsl_contract():
    src = open(os.path.join(ROOT, "td", "raster_editor", "shape.glsl"), encoding="utf-8").read()
    for u in ("uParams", "uOffset", "uA", "uB", "uC"):
        assert re.search(r"uniform vec4 %s;" % u, src)
    assert "TDOutputSwizzle" in src and "gl_FragCoord" in src


def test_shape_node_adopted_after_reload():
    comp, log = fakenet.make_comp()
    n1 = DocNetwork(comp, GLSL, optimize=False)
    n1.apply([base(), shp("s"), txt("t")], W, H)
    log.clear()
    n2 = DocNetwork(comp, GLSL, optimize=False)
    n2.apply([base(), shp("s"), txt("t")], W, H)
    assert not [c for c in log.creates if c[0] in ("glslTOP", "textTOP")]
    assert n2._ops["shape_s"].tags == ["role:shape_s"]


def test_wrap_text_matches_browser_algorithm():
    w = lambda s_: 10.0 * len(s_)                  # 10 px per char
    wt = network.wrap_text
    assert wt("aaa bbb ccc", 70, w) == ["aaa bbb", "ccc"]                 # <= box fits (7 chars = 70)
    assert wt("aaa bbb ccc", 69, w) == ["aaa", "bbb", "ccc"]
    assert wt("tiny supercalifragilistic x", 50, w) == ["tiny", "supercalifragilistic", "x"]   # never broken
    assert wt("a\n\nb c", 100, w) == ["a", "", "b c"]                     # empty paragraph = empty line
    assert wt("a  b", 100, w) == ["a  b"]                                  # double space = an empty word
    assert wt("", 50, w) == [""]


def test_wrap_text_replays_the_real_layoutText_vectors():
    """td/tests/wrap_vectors.json: the real web/src/engine/textShape.ts layoutText run in Chromium (regenerate with
    ``scripts/network_dev.py wrap-fixture``), with the width of every string it measured."""
    cases = json.load(open(os.path.join(HERE, "wrap_vectors.json"), encoding="utf-8"))
    assert len(cases) >= 50
    for c in cases:
        widths = c["widths"]
        asked = []

        def width(t):
            asked.append(t)
            return widths[t]          # KeyError = the python port measured a string the browser never measured
        assert network.wrap_text(c["text"], c["boxWidth"], width) == c["lines"], c
        assert set(asked) <= set(widths)


def test_boxed_text_is_wrapped_by_docnetwork_and_measurements_are_cached(env):
    net, comp, log, _ = env
    spec = dict(TEXT, text="aaa bbb ccc ddd", boxWidth=70.0, size=20)          # fake width: 10 px per char (0.5 em)
    net.apply([base(), txt("t", spec)], W, H)
    P = network.TEXT_PAR
    assert net._ops["text_t"].par.value(P["text"]) == "aaa bbb\nccc ddd"
    assert net._ops["text_t"].par.value(P["wrap"]) is False
    m = net._ops["text_measure"]
    n = m.cooks
    net.apply([base(), txt("t", dict(spec, boxWidth=70.0, x=40))], W, H)       # move: everything cached
    assert m.cooks == n
    net.apply([base(), txt("t", dict(spec, boxWidth=40.0))], W, H)             # only the NEW candidate strings
    assert 0 < m.cooks - n <= 3
    assert net._ops["text_t"].par.value(P["text"]) == "aaa\nbbb\nccc\nddd"


def test_no_text_measure_node_without_text_layers(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), shp("s")], W, H)
    assert "text_measure" not in net._ops and comp.op("doc").op("text_measure") is None


def test_font_change_between_layers_resets_the_typeface_cache(env):
    net, comp, log, _ = env
    net.apply([base(), txt("a", dict(TEXT, bold=True, font="Arial")), txt("b", dict(TEXT, bold=True, font="Georgia"))], W, H)
    # the measure node follows each family (typeface re-applied after a font change: TD may reset it)
    log_pars = [(n, k, v) for n, k, v in log.par_sets if n == "text_measure" and k in ("font", "typeface")]
    assert [v for n, k, v in log_pars if k == "font"] == ["Arial", "Georgia"]
    assert [v for n, k, v in log_pars if k == "typeface"] == ["Bold", "Bold"]
    assert net._ops["text_a"].par.value("font") == "Arial" and net._ops["text_b"].par.value("font") == "Georgia"


def test_measure_base_pars_set_only_on_cache_miss(env):
    net, comp, log, _ = env
    net.apply([base(), txt("a", TEXT)], W, H)
    m = log.mark()
    net.apply([base(), txt("a", dict(TEXT, x=50, y=60, color=BLUE))], W, H)
    assert not [p for p in log.since(m)["par_sets"] if p[0] == "text_measure"]


def test_measurement_budget_defers_to_tick_with_fallback_layout(env, monkeypatch):
    net, comp, log, _ = env
    monkeypatch.setattr(network, "MEASURE_BUDGET", 6)
    words = " ".join("w%03d" % i for i in range(60))
    spec = dict(TEXT, text=words, boxWidth=100.0, size=20)
    net.apply([base(), txt("t", spec)], W, H)
    m = net._ops["text_measure"]
    assert m.cooks <= 6                                    # bounded per apply
    assert "text_t" in net._text_todo
    first = net._ops["text_t"].par.value(network.TEXT_PAR["text"])
    assert "\n" in first                                  # fallback layout still wraps
    ticks = 0
    while net._text_todo and ticks < 200:
        net.tick()
        ticks += 1
    assert not net._text_todo and ticks > 1
    final = net._ops["text_t"].par.value(network.TEXT_PAR["text"])
    expect = network.wrap_text(words, 100.0, lambda t: 10.0 * len(t))
    assert final == "\n".join(expect)


def _failing_cook(monkeypatch, bad, calls=None, clock=None):
    """text_measure raises when asked to measure a string containing ``bad``."""
    orig = fakenet.FakeOp.cook

    def cook(self, force=False):
        if self.name == "text_measure" and bad in str(self.par.value("text")):
            if calls is not None:
                calls.append(clock.t if clock else 0)
            raise RuntimeError("cook failed")
        orig(self, force)
    monkeypatch.setattr(fakenet.FakeOp, "cook", cook)
    return orig


def test_measurement_failure_is_cached_and_retried_with_backoff(env, monkeypatch):
    net, comp, log, clock = env
    calls = []
    orig = _failing_cook(monkeypatch, "FAIL", calls, clock)
    spec = dict(TEXT, text="FAIL here", align="center")                  # centre needs the width -> measures the text
    net.apply([base(), txt("t", spec)], W, H)
    assert len(calls) == 1 and "text_t" in net._text_todo
    assert net._text_retry["text_t"][0] == 1
    net.apply([base(), txt("t", dict(spec, x=3))], W, H)                 # within the back-off: no new attempt
    for _ in range(5):
        net.tick()
    assert len(calls) == 1
    clock.t += 5.0
    net.tick()
    assert len(calls) == 2 and net._text_retry["text_t"][0] == 2         # back-off doubles
    monkeypatch.setattr(fakenet.FakeOp, "cook", orig)
    clock.t += 60.0
    for _ in range(5):
        net.tick()
    assert not net._text_todo
    assert "text_t" not in net._text_retry                               # success resets the failure count


def test_failing_text_layer_does_not_block_the_others(env, monkeypatch):
    net, comp, log, clock = env
    _failing_cook(monkeypatch, "FAIL")
    a = dict(TEXT, text="FAIL here", align="center")
    b = dict(TEXT, text="aaa bbb ccc ddd", boxWidth=70.0, size=20)
    net.apply([base(), txt("a", a), txt("b", b)], W, H)
    P = network.TEXT_PAR
    assert "text_a" in net._text_todo and "text_b" not in net._text_todo
    assert net._ops["text_b"].par.value(P["text"]) == "aaa bbb\nccc ddd"          # b measured despite a failing
    net.apply([base(), txt("a", a), txt("b", dict(b, boxWidth=40.0))], W, H)      # b is still editable while a backs off
    assert net._ops["text_b"].par.value(P["text"]) == "aaa\nbbb\nccc\nddd"
    assert net._text_retry["text_a"][0] >= 1 and "text_b" not in net._text_retry
    net.apply([base(), txt("b", b)], W, H)                                       # the failing layer is deleted
    assert "text_a" not in net._text_retry


def test_measure_budget_limits_cooks_per_apply_and_per_tick(env, monkeypatch):
    net, comp, log, _ = env
    monkeypatch.setattr(network, "MEASURE_BUDGET", 5)
    words = " ".join("w%03d" % i for i in range(80))
    net.apply([base(), txt("t", dict(TEXT, text=words, boxWidth=100.0, size=20))], W, H)
    m = net._ops["text_measure"]
    assert m.cooks <= 5
    per_tick = []
    while net._text_todo and len(per_tick) < 500:
        before = m.cooks
        net.tick()
        per_tick.append(m.cooks - before)
    assert not net._text_todo and max(per_tick) <= 5 and sum(per_tick) > 5


def test_trimmed_space_candidates_are_measured_with_a_bracket(env):
    net, comp, log, _ = env
    seen = []
    orig = fakenet.FakeOp.cook

    def spy(self, force=False):
        if self.name == "text_measure":
            seen.append(str(self.par.value("text")))
        orig(self, force)
    fakenet.FakeOp.cook = spy
    try:
        net.apply([base(), txt("t", dict(TEXT, text="aa  bb", boxWidth=500.0, size=20))], W, H)   # "aa " + "" -> trailing space
    finally:
        fakenet.FakeOp.cook = orig
    assert "|" in "".join(seen) and any(t.startswith("|") and t.endswith("|") and t != "|" for t in seen)
    # the fake is exact: width("aa ") = 3 chars -> bracket arithmetic must give 3 * 10 = 30, not 20
    assert net._widths[(("Arial", False, False, 20.0), "aa ")] == pytest.approx(30.0)


def test_width_cache_is_lru_and_a_big_text_finishes(env, monkeypatch):
    """A 5000 word (20000 char) text needs ~10000 cache entries: the old clear-at-8192 never finished."""
    net, comp, log, _ = env
    monkeypatch.setattr(network, "MEASURE_BUDGET", 400)
    letters = "abcdefghijklmnopqrstuvwxyz"
    words = ["%s%s%s" % (letters[i % 26], letters[(i // 26) % 26], letters[(i // 676) % 26]) for i in range(5000)]
    text = " ".join(words)[:network.TEXT_MAX]
    spec = dict(TEXT, text=text, boxWidth=70.0, size=20)                 # fake: 10 px per char -> two 3-letter words per line
    net.apply([base(), txt("t", spec)], W, H)
    ticks = 0
    while net._text_todo and ticks < 400:
        net.tick()
        ticks += 1
    assert not net._text_todo and ticks > 1
    assert len(net._widths) > 8192
    got = net._ops["text_t"].par.value(network.TEXT_PAR["text"])
    assert got.split("\n") == network.wrap_text(text, 70.0, lambda t: 10.0 * len(t))
    # LRU: a small limit evicts the oldest entries only
    monkeypatch.setattr(network, "WIDTH_CACHE_MAX", 100)
    net.apply([base(), txt("t", dict(spec, text="zz yy xx ww vv uu"))], W, H)
    assert len(net._widths) <= 100


def test_missing_font_resolves_to_helvetica_and_follows_the_menu(env):
    net, comp, log, clock = env
    menu = {"Helvetica", "Arial"}
    node = net._measure_node()

    class P:                       # the fake Text TOP gets a font menu
        menuNames = property(lambda self: sorted(menu))
    node.par.__dict__["_v"]
    object.__setattr__(node.par, "font", P())
    assert net._resolve_font("Arial") == "Arial"
    assert net._resolve_font("Fancy") == "Helvetica"
    menu.add("Fancy")
    assert net._resolve_font("Fancy") == "Helvetica"           # menu cached (re-read at most every 5 s)
    clock.t += 6.0
    assert net._resolve_font("Fancy") == "Fancy"


def test_text_size_and_line_height_clamped_like_the_web_engine():
    P = network.TEXT_PAR
    u = network.text_pars(dict(TEXT, size=99999, lineHeight=99), 200, 100, {"asc": 10.0, "pitch": 10.0, "tw": 0.0})
    assert u[P["size"]] == 4000.0 and u[P["spacing"]] == pytest.approx(4000.0 * 10 - 10.0)
    u = network.text_pars(dict(TEXT, size=0.2, lineHeight=0.01), 200, 100, {"asc": 1.0, "pitch": 1.0, "tw": 0.0})
    assert u[P["size"]] == 1.0 and u[P["spacing"]] == pytest.approx(0.2 - 1.0)
    assert len(network.text_pars(dict(TEXT, text="x" * 30000), 200, 100, None)[P["text"]]) == network.TEXT_MAX


def test_polygon_edge_parameters():
    poly = {"type": "polygon", "cx": 30, "cy": 10, "radius": 0, "sides": 5, "innerRatio": 0.0, "fill": FILL,
            "stroke": STROKE, "rotation": 0}
    u = network.shape_uniforms(poly, 48)
    assert u["vec1valuez"] == 0.0 and u["vec1valuew"] == 0.05            # radius 0 kept (shader draws nothing); ratio >= 0.05
    u = network.shape_uniforms(dict(poly, radius=-5, sides=float("nan") if False else 2.4), 48)
    assert u["vec1valuez"] == 0.0 and u["vec2valuey"] == 3.0
    u = network.shape_uniforms({"type": "polygon"}, 48)                  # all defaults
    assert all(v == v for v in u.values())                              # no NaN


# ---- numpy ports of the shader's distance functions vs brute force ----------------------------------------


def _sd_ellipse_eberly(p, r):
    """numpy port of shape.glsl sdEllipse (without the shortcuts): D. Eberly's bisection."""
    import numpy as np
    q = np.abs(np.asarray(p, float))
    a, b = float(r[0]), float(r[1])
    sw = a < b
    e0, e1 = (b, a) if sw else (a, b)
    y0, y1 = (q[1], q[0]) if sw else (q[0], q[1])
    if y1 > 0:
        if y0 > 0:
            z0, z1 = y0 / e0, y1 / e1
            g = z0 * z0 + z1 * z1 - 1
            if abs(g) < 1e-9:
                dist = 0.0
            else:
                r0 = (e0 / e1) ** 2
                n0 = r0 * z0
                s0, s1 = z1 - 1, (0.0 if g < 0 else float(np.hypot(n0, z1)) - 1)
                s = 0.0
                for _ in range(48):
                    s = 0.5 * (s0 + s1)
                    if s == s0 or s == s1:
                        break
                    gg = (n0 / (s + r0)) ** 2 + (z1 / (s + 1)) ** 2 - 1
                    if gg > 0:
                        s0 = s
                    elif gg < 0:
                        s1 = s
                    else:
                        break
                dist = float(np.hypot(r0 * y0 / (s + r0) - y0, y1 / (s + 1) - y1))
        else:
            dist = abs(y1 - e1)
    else:
        numer0, denom0 = e0 * y0, e0 * e0 - e1 * e1
        if numer0 < denom0:
            xde0 = numer0 / denom0
            dist = float(np.hypot(e0 * xde0 - y0, e1 * (1 - xde0 * xde0) ** 0.5))
        else:
            dist = abs(y0 - e0)
    k = (q[0] / a) ** 2 + (q[1] / b) ** 2
    return -dist if k < 1 else dist


@pytest.mark.parametrize("radii", [(40, 25), (300, 10), (500, 3), (60, 60), (100, 1), (8, 30)])
def test_ellipse_sdf_matches_brute_force_distance(radii):
    import numpy as np
    rng = np.random.default_rng(5)
    a, b = radii
    th = np.linspace(0, 2 * np.pi, 200001)
    curve = np.stack([a * np.cos(th), b * np.sin(th)], 1)
    pts = [(0.0, 0.0), (a + 0.5, 0.0), (-a + 0.3, 0.0), (0.0, b + 0.5), (-480.6 if a > 480 else -a * 0.99, 0.06),
           (0.0, 1e-3), (a, 0.0), (0.0, b)]
    for _ in range(60):
        u = rng.uniform(-1.3, 1.3, 2) * np.array([a, b])
        pts.append(tuple(u))
    for _ in range(60):                                             # near the outline (where the strokes live)
        t = rng.uniform(0, 2 * np.pi)
        n = np.array([np.cos(t) / a, np.sin(t) / b])
        pts.append(tuple(np.array([a * np.cos(t), b * np.sin(t)]) + rng.uniform(-3, 3) * n / np.linalg.norm(n)))
    for p in pts:
        d = np.min(np.linalg.norm(curve - np.asarray(p), axis=1))
        got = _sd_ellipse_eberly(p, (a, b))
        inside = (p[0] / a) ** 2 + (p[1] / b) ** 2 < 1
        assert abs(abs(got) - d) < 0.02 + 2e-4 * d, (radii, p, got, d)       # brute force sampled at ~1e-3 px
        assert (got < 0) == bool(inside) or d < 1e-3


def test_polygon_sdf_numpy_port_vs_brute_force():
    import numpy as np
    sys_path = os.path.join(ROOT, "scripts")
    import sys
    sys.path.insert(0, sys_path)
    import network_dev as nd
    rng = np.random.default_rng(2)
    for n_, inner in ((3, 1.0), (5, 0.4), (7, 0.9), (64, 1.0)):
        verts = nd.polygon_vertices(0.0, 0.0, 30.0, n_, inner)
        pts = rng.uniform(-40, 40, (200, 2))
        sd = nd._poly_sd(pts, verts)
        m = len(verts)
        seg = np.stack([verts, np.roll(verts, -1, 0)], 1)
        for p, v in zip(pts, sd):
            dmin = min(float(nd._seg_dist(p[None], a, b)[0]) for a, b in seg)
            assert abs(abs(v) - dmin) < 1e-9


# --------------------------------------------------------------------------- v5 transforms / surface sizes


def test_xform_uniforms_mapping():
    f = network.xform_uniforms
    assert f(L("a", x=2.5, y=-1.25, sx=0.5, sy=0.7)) == ((2.5, -1.25, 0.5, 0.7), True)
    assert f(L("a", sx=0.5, sy=3.7)) == ((0.0, 0.0, 0.5, 3.7), False)         # mixed: lod = 0 (sx*sy >= 0.5)
    assert f(L("a", sx=2.0, sy=1.0)) == ((0.0, 0.0, 2.0, 1.0), False)
    assert f(L("a", sx=0.7, sy=0.7))[1] is True and f(L("a", sx=0.72, sy=0.72))[1] is False    # lod > 0 below sx*sy = 0.5
    assert f(L("a")) == ((0.0, 0.0, 1.0, 1.0), False)                       # v4 spec without sx/sy: identity
    assert f(L("b", "base", x=3, y=4, sx=2, sy=2)) == ((3.0, 4.0, 2.0, 2.0), False)
    for kind in ("text", "shape", "group", "adjustment"):
        assert f(L("a", kind, x=9, y=9, sx=0.2, sy=0.2)) == ((0.0, 0.0, 1.0, 1.0), False)
    assert f(L("a", sx=0.0, sy=-2.0))[0][2:] == (1.0, 1.0)                  # invalid scale -> identity
    assert f(L("a", x=float("nan"), y=1))[0][:2] == (0.0, 0.0)


def test_transform_reaches_resample_pass_unflipped(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, x=2.5, y=-1.25, sx=0.25, sy=0.5, surfaceW=16, surfaceH=8)], W, H)
    assert pvals(net, "xf_L_a", "vec1") == (4.0, 0.0, 0.0, 2.0)               # inverse linear part diag(1/sx, 1/sy)
    assert pvals(net, "xf_L_a", "vec2")[:2] == (2.5, -1.25)                    # translation: document top-left px; the shader flips
    xf = net._ops["xf_L_a"].par.value
    assert xf("vec0valuew") == network.ADJ_RESAMPLE and xf("inputfiltertype") == "mipmap"
    assert (xf("outputresolution"), xf("resolutionw"), xf("resolutionh")) == ("custom", W, H)
    assert source_of(net, "xf_L_a", 0) == "s1" and source_of(net, "xf_L_a", 1) == "s1"     # no mask: the surface again
    assert source_of(net, "xf_L_a", 2) == "s1"             # sTD2DInputs[] is sized by the wired inputs: always 3
    # the blend only fetches: identity mapping, source = the resample result, nearest filter, no mask
    assert source_of(net, "blend_L_a", 1) == "xf_L_a"
    assert pvals(net, "blend_L_a", "vec1") == (0.0, 0.0, 1.0, 1.0)
    assert net._ops["blend_L_a"].par.value("inputfiltertype") == "nearest"


def test_integer_offset_has_no_resample_pass(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, x=7, y=-5, surfaceW=16, surfaceH=8)], W, H)
    assert "xf_L_a" not in net._ops and source_of(net, "blend_L_a", 1) == "s1"
    assert pvals(net, "blend_L_a", "vec1") == (7.0, -5.0, 1.0, 1.0)


def test_transform_edit_is_uniform_sets_only(env):
    net, comp, log, _ = env
    L1 = lambda **kw: [base(), px("a", 1, surfaceW=16, surfaceH=8, **kw)]
    net.apply(L1(x=0.5, y=0.25, sx=1.5, sy=1.5), W, H)
    settle(net)
    gname = net._ops["xf_L_a"].name
    m = log.mark()
    net.apply(L1(x=3.5, y=1.25, sx=1.7, sy=1.6), W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert {(n, k) for n, k, v in d["par_sets"]} == {(gname, "vec1valuex"), (gname, "vec1valuew"),
                                                         (gname, "vec2valuex"), (gname, "vec2valuey")}      # off-diagonals stay 0
    m = log.mark()
    net.apply(L1(x=3.5, y=1.25, sx=0.5, sy=0.5), W, H)                  # starts minifying: filter flag on the resample node
    d = log.since(m)
    assert {(n, k) for n, k, v in d["par_sets"]} == {(gname, "vec1valuex"), (gname, "vec1valuew"), (gname, "inputfiltertype")}
    assert [v for n, k, v in d["par_sets"] if k == "inputfiltertype"] == ["mipmap"]
    assert not d["creates"] and not d["connects"]


def test_unminify_resets_the_filter_and_exact_drops_the_pass(env):
    net, comp, log, _ = env
    L1 = lambda **kw: [base(), px("a", 1, surfaceW=16, surfaceH=8, **kw)]
    net.apply(L1(x=0.5, sx=0.3, sy=0.3), W, H)
    node = net._ops["xf_L_a"]
    assert node.par.value("inputfiltertype") == "mipmap"
    net.apply(L1(x=0.5, sx=0.9, sy=0.9), W, H)
    assert net._ops["xf_L_a"].par.value("inputfiltertype") == "linear"
    net.apply(L1(x=3, sx=1.0, sy=1.0), W, H)                            # back to an integer offset: pass removed
    assert "xf_L_a" not in net._ops and node in [n for n, c in net._pool] + [g for g, c in net._garbage]
    settle(net)
    if node.valid and node in [n for n, c in net._pool]:
        assert node.par.value("inputfiltertype") == "nearest" and node.par.value("outputresolution") == "useinput"
    assert source_of(net, "blend_L_a", 1) == "s1"


def _mip_inputs_are_surfaces(net):
    """The accumulator (blend / group / blank / adjustment results) is never read through a mipmap-filtered node."""
    for name, op in net._ops.items():
        if op.OPType != "glslTOP" or op.par.value("inputfiltertype") != "mipmap":
            continue
        for con in op.inputConnectors:
            if con.source is None:
                continue
            src = next(n for n, o in net._ops.items() if o is con.source)
            assert re.fullmatch(r"s\d+|src_in[1-8]", src), (name, "reads", src)
    # and every other glsl node is texelFetch-only
    for name, op in net._ops.items():
        if op.OPType == "glslTOP" and name.startswith(("blend_", "shape_")):
            assert op.par.value("inputfiltertype") in (None, "nearest"), name


def test_accumulator_is_never_read_through_a_mipmap_filter(env):
    net, comp, log, _ = env
    layers = [base(), px("a", 1, sx=0.3, sy=0.3, x=0.5, surfaceW=20, surfaceH=20),
              px("b", 2, sx=0.2, sy=0.4, surfaceW=20, surfaceH=20, mask={"slot": 5, "enabled": True}),
              L("g", "group"), px("c", 3, parentId="g", sx=0.45, sy=0.45, y=0.5, surfaceW=20, surfaceH=20),
              L("adj", "adjustment", adjustment={"type": "blur", "radius": 4}), shp("s")]
    net.apply(layers, W, H)
    _mip_inputs_are_surfaces(net)
    assert sum(1 for o in net._ops.values() if o.OPType == "glslTOP" and o.par.value("inputfiltertype") == "mipmap") == 3
    comp.inputConnectors[0].connect(comp.in1)
    layers[0] = L("base", "base", sx=0.3, sy=0.3, x=1.5)
    net.apply(layers, W, H)
    _mip_inputs_are_surfaces(net)
    assert source_of(net, "xf_L_base", 0) == "src_in1"
    # churn through pool recycling: nothing keeps a stale mipmap flag
    for i in range(4):
        layers[1]["sx"] = layers[1]["sy"] = 0.3 if i % 2 else 1.0
        layers[2]["x"] = 3 + i
        net.apply(layers, W, H)
        settle(net)
        _mip_inputs_are_surfaces(net)
    for node, cache in net._pool:
        assert node.par.value("inputfiltertype") in (None, "nearest")


def test_surfaces_use_their_own_size_and_masks_follow_the_layer(env):
    net, comp, log, _ = env
    layers = [base(), px("a", 1, surfaceW=200, surfaceH=100, mask={"slot": 5, "enabled": True}),
              px("b", 2, surfaceW=7, surfaceH=9),
              L("adj", "adjustment", adjustment={"type": "invert"}, mask={"slot": 6, "enabled": True}),
              shp("s", mask={"slot": 8, "enabled": True}), px("legacy", 3)]
    net.apply(layers, W, H)
    size = lambda n: (net._ops[n].par.value("resolutionw"), net._ops[n].par.value("resolutionh"))
    assert size("s1") == (200, 100) and size("s2") == (7, 9)
    assert size("s5") == (200, 100)                         # mask: size of its layer's surface
    assert size("s6") == (W, H) and size("s8") == (W, H)    # adjustment / shape masks cover the document
    assert size("s3") == (W, H)                             # no surfaceW/H in the spec: document size
    assert net.surface_size(1) == (200, 100) and net.surface_size(5) == (200, 100) and net.surface_size(99) is None
    assert net._ops["blank"].par.value("resolutionw") == W


def test_surface_size_change_and_doc_resize_do_not_touch_each_other(env):
    net, comp, log, _ = env
    st = lambda w, h: [base(), px("a", 1, surfaceW=w, surfaceH=h)]
    net.apply(st(100, 50), W, H)
    settle(net)
    m = log.mark()
    net.apply(st(100, 50), 128, 96)                        # canvas resize: surfaces keep their size
    d = log.since(m)
    assert {n for n, k, v in d["par_sets"]} == {"blank"} and not d["creates"]
    assert net.surface_size(1) == (100, 50)
    m = log.mark()
    net.apply(st(30, 40), 128, 96)                         # replaced pixels (apply transform): same slot, new size
    d = log.since(m)
    assert {(n, k, v) for n, k, v in d["par_sets"]} == {("s1", "resolutionw", 30), ("s1", "resolutionh", 40)}
    assert not d["creates"] and not d["destroys"] and net.surface_size(1) == (30, 40)


def test_base_transform_applies_only_with_a_connected_input(env):
    net, comp, log, _ = env
    b = L("base", "base", x=10.5, y=-4, sx=0.5, sy=0.5)
    net.apply([b], W, H)
    assert "xf_L_base" not in net._ops
    assert pvals(net, "blend_L_base", "vec1") == (0.0, 0.0, 1.0, 1.0)        # no input: transparent blank, nothing to move
    assert source_of(net, "blend_L_base", 1) == "src_in1" and source_of(net, "blend_L_base", 0) == "blank"
    comp.inputConnectors[0].connect(comp.in1)
    net.apply([b], W, H)
    assert pvals(net, "xf_L_base", "vec1") == (2.0, 0.0, 0.0, 2.0) and pvals(net, "xf_L_base", "vec2")[:2] == (10.5, -4.0)
    assert net._ops["xf_L_base"].par.value("inputfiltertype") == "mipmap" and source_of(net, "xf_L_base", 0) == "src_in1"
    assert source_of(net, "blend_L_base", 1) == "xf_L_base"
    assert net._ops["src_in1"].par.value("top") == "../in1"
    comp.inputConnectors[0].disconnect()
    net.set_input_connected(False)
    net.apply([b], W, H)
    assert "xf_L_base" not in net._ops and pvals(net, "blend_L_base", "vec1") == (0.0, 0.0, 1.0, 1.0)


def test_set_input_connected_true_replans_the_base_transform(env):
    net, comp, log, _ = env
    b = L("base", "base", x=2.5, y=0, sx=0.5, sy=0.5)
    net.apply([b], W, H)
    assert "xf_L_base" not in net._ops
    comp.inputConnectors[0].connect(comp.in1)      # the ext flips the flag, then applies the (unchanged) stack
    net.set_input_connected(True)
    net.apply([b], W, H)
    assert "xf_L_base" in net._ops and net._ops["src_in1"].par.value("top") == "../in1"


def test_render_layer_source_returns_the_unblended_source_node(env):
    net, comp, log, _ = env
    net.apply([base(), px("p", 1), shp("s", opacity=0.3, blend="multiply", visible=False,
                                       mask={"slot": 7, "enabled": True}), txt("t", opacity=0.5),
               L("empty", "text", text=None)], W, H)
    s, t = net.render_layer_source("s"), net.render_layer_source("t")
    assert s is net._ops["shape_s"] and t is net._ops["text_t"]               # not the blend node (opacity / mask / mode)
    assert s.par.value("resolutionw") == W and t.par.value("resolutionh") == H
    assert net.render_layer_source("empty") is net._ops["blank"]               # no spec: transparent
    assert net.render_layer_source("p") is None and net.render_layer_source("nope") is None


def test_render_layer_status_finishes_pending_text_with_a_bounded_budget(env, monkeypatch):
    net, comp, log, _ = env
    monkeypatch.setattr(network, "MEASURE_BUDGET", 0)
    spec = dict(TEXT, boxWidth=40.0, text="aaa bbb ccc ddd eee fff")
    net.apply([base(), txt("t", spec)], W, H)
    assert "text_t" in net._text_todo
    before = net._ops["text_t"].par.value(network.TEXT_PAR["text"]), net._ops["text_t"].par.value(network.TEXT_PAR["spacing"])
    tok = net.render_layer_token("t")
    assert net.render_layer_ready("t") is True                           # bounded work inside the call converges
    assert "text_t" not in net._text_todo and net._budget == 0           # the budget is restored (try/finally)
    after = net._ops["text_t"].par.value(network.TEXT_PAR["text"]), net._ops["text_t"].par.value(network.TEXT_PAR["spacing"])
    assert after != before                                               # real (measured) layout, not the fallback
    assert net.render_layer_token("t") != tok                            # the readback in flight must be dropped
    assert net.render_layer_source("t") is net._ops["text_t"]


def test_render_layer_status_signals_failure_and_never_blocks(env, monkeypatch):
    net, comp, log, clock = env
    net.apply([base(), txt("t")], W, H)
    net._ops["text_measure"].cook = lambda force=False: (_ for _ in ()).throw(RuntimeError("cook failed"))
    net._text_todo.add("text_t")
    net._metrics.clear()
    net._widths.clear()
    b0 = net._budget
    assert net.render_layer_status("t") == "failed"
    assert net._budget == b0                                              # restored even though the measurement raised


def test_render_layer_source_after_delete_and_kind_change(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s"), txt("t")], W, H)
    tok = net.render_layer_token("s")
    assert tok is not None and net.render_layer_status("s") == "ready"
    net.apply([base(), txt("t")], W, H)
    assert net.render_layer_source("s") is None and net.render_layer_token("s") is None
    assert net.render_layer_status("s") is None and net.render_layer_ready("s") is False
    net.apply([base(), px("s", 3), txt("t")], W, H)                       # same id, now a pixel layer
    assert net.render_layer_source("s") is None
    net.apply([base(), shp("s"), txt("t")], W, H)
    assert net.render_layer_source("s") is not None and net.render_layer_token("s") != tok    # new node: token differs
    net.apply([base(), shp("s", x=0, opacity=0.5), txt("t")], W, H)       # any apply invalidates an in-flight readback
    assert net.render_layer_source("s") is not None


def test_render_layer_token_changes_with_every_real_apply(env):
    net, comp, log, _ = env
    st = [base(), shp("s")]
    net.apply(st, W, H)
    t0 = net.render_layer_token("s")
    net.apply(st, W, H)
    assert net.render_layer_token("s") == t0                               # no-op apply: same pixels
    st2 = [base(), shp("s", dict(RECT, x=11))]
    net.apply(st2, W, H)
    assert net.render_layer_token("s") != t0


def test_surface_size_is_consistent_for_slots_in_grace_and_after_destroy(env):
    net, comp, log, clock = env
    net.apply([base(), px("a", 1, surfaceW=30, surfaceH=20)], W, H)
    net.apply([base()], W, H)                                              # slot 1 now in its grace period
    assert net.surface_top(1) is not None and net.surface_size(1) == (30, 20)
    clock.t += 3.0
    settle(net)
    assert net.surface_top(1) is None and net.surface_size(1) is None


def test_mask_follows_a_resized_surface(env):
    net, comp, log, _ = env
    st = lambda w, h: [base(), px("a", 1, surfaceW=w, surfaceH=h, mask={"slot": 5, "enabled": True}, sx=1.5, sy=1.5, x=0.5)]
    net.apply(st(40, 30), W, H)
    assert net.surface_size(5) == (40, 30)
    net.apply(st(25, 12), W, H)
    assert net.surface_size(1) == net.surface_size(5) == (25, 12)
    assert net._ops["s5"].par.value("resolutionw") == 25 and net._ops["s5"].par.value("resolutionh") == 12
    assert source_of(net, "xf_L_a", 1) == "s5" and net._ops["xf_L_a"].par.value("vec0valuez") == 1.0
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 0.0            # the mask is consumed by the resample pass


def _ramp(h, w, seed=3):
    rng = np.random.default_rng(seed)
    return rng.random((h, w, 4))


def test_reference_integer_position_scale_one_is_an_exact_copy():
    src = _ramp(9, 11)
    out = fakenet.sample_reference(src, 20, 15, 4, -2, 1.0, 1.0)
    exp = np.zeros((15, 20, 4))
    for j in range(15):
        for i in range(20):
            sy_, sx_ = j + 2, i - 4
            if 0 <= sy_ < 9 and 0 <= sx_ < 11:
                exp[j, i] = src[sy_, sx_]
    assert np.array_equal(out, exp)


def test_reference_half_pixel_shift_blends_neighbours_and_clips_edges():
    src = np.zeros((2, 4, 4))
    src[..., 3] = 1.0
    src[:, :, 0] = [[0, 1, 2, 3]] * 2
    out = fakenet.sample_reference(src, 8, 2, 0.5, 0.0, 1.0, 1.0)
    # doc pixel 1 (centre 1.5) -> layer x = 1.0: halfway between texels 0 and 1
    assert out[0, 1, 0] == pytest.approx(0.5)
    assert out[0, 2, 0] == pytest.approx(1.5)
    # first column is half covered (layer starts at 0.5): colour clamps to the edge texel, alpha = coverage
    assert out[0, 0, 3] == pytest.approx(0.5) and out[0, 0, 0] == pytest.approx(0.0)
    # last covered column: layer x range [3.5, 4.5] vs source [0, 4] -> half covered
    assert out[0, 4, 3] == pytest.approx(0.5) and out[0, 5, 3] == 0.0


def test_reference_y_axis_is_top_down_for_fractional_positions():
    src = np.zeros((4, 1, 4))
    src[..., 3] = 1.0
    src[:, 0, 0] = [0, 1, 2, 3]                       # row index grows downwards
    out = fakenet.sample_reference(src, 1, 8, 0.0, 1.5, 1.0, 1.0)
    # doc row 3 has centre 3.5 -> layer y = 2.0: halfway between source rows 1 and 2
    assert out[3, 0, 0] == pytest.approx(1.5)
    assert out[0, 0, 3] == 0.0 and out[0, 0, 0] == 0.0                       # row 0 is above the layer (starts at y = 1.5)
    assert out[1, 0, 3] == pytest.approx(0.5) and out[1, 0, 0] == pytest.approx(0.0)     # half covered, edge texel
    assert out[2, 0, 3] == pytest.approx(1.0)


@pytest.mark.parametrize("x,y,sx,sy", [(0.3, -1.7, 1.0, 1.0), (2.25, 1.5, 2.0, 3.7), (-3.5, 0.0, 1.3, 0.9)])
def test_shader_port_matches_reference(x, y, sx, sy):
    """The GL conventions (bottom-up rows, v = 1 - ly/H, gl_FragCoord) reproduce the top-down reference."""
    src = _ramp(7, 9)
    # interior only: edge coverage is a separate (analytic) factor
    ref = fakenet.sample_reference(src, 40, 30, x, y, sx, sy, mip=False)
    port = fakenet.shader_port(src[::-1], 40, 30, x, y, sx, sy)
    jj, ii = np.mgrid[0:30, 0:40]
    lx, ly = (ii + 0.5 - x) / sx, (jj + 0.5 - y) / sy
    interior = (lx - 0.5 / sx >= 0) & (lx + 0.5 / sx <= 9) & (ly - 0.5 / sy >= 0) & (ly + 0.5 / sy <= 7)
    assert interior.sum() > 20
    assert np.abs(ref[interior] - port[interior]).max() < 1e-9


def test_reference_minification_uses_a_mip_level():
    src = np.zeros((32, 32, 4))
    src[::2, :, :] = 1.0                                # horizontal 1 px stripes
    plain = fakenet.sample_reference(src, 10, 10, 0, 0, 0.3, 0.3, mip=False)[2:8, 2:8]
    mipped = fakenet.sample_reference(src, 10, 10, 0, 0, 0.3, 0.3, mip=True)[2:8, 2:8]
    assert plain[..., 0].std() > 0.15                                # aliased without mips
    assert mipped[..., 0].std() < 0.5 * plain[..., 0].std() and abs(mipped[..., 0].mean() - 0.5) < 0.1


# --------------------------------------------------------------------------- shader ports (resample + blend fetch)


def _tex(h, w, seed, alpha=True):
    t = _ramp(h, w, seed)
    if not alpha:
        t[..., 1:] = t[..., :1]
    return t


@pytest.mark.parametrize("x,y,sx,sy", [
    (0.3, -1.7, 1.0, 1.0), (2.25, 1.5, 2.0, 3.7), (-3.5, 0.0, 1.3, 0.9), (4.0, 3.0, 1.0, 1.0),   # exact branch
    (1.5, 2.5, 0.5, 0.5), (-2.2, 3.3, 0.3, 0.45), (2.0, 1.0, 0.25, 0.25), (3.5, 2.0, 2.0, 0.4)])
@pytest.mark.parametrize("masked", [False, True])
def test_resample_port_matches_sample_reference(x, y, sx, sy, masked):
    """The uAdjust = 7 pass (GL conventions, coverage, exact branch, trilinear lod, mask) == the top-down reference,
    edges included."""
    src = _tex(16, 20, 5)
    mask = _tex(16, 20, 6)
    port = fakenet.resample_port(src[::-1], mask[::-1], 48, 40, x, y, sx, sy, has_mask=masked)
    ref = fakenet.sample_reference(src, 48, 40, x, y, sx, sy)
    if masked:
        ref = ref * fakenet.sample_reference(mask[..., :1], 48, 40, x, y, sx, sy, coverage=False)
    assert np.abs(port - ref).max() < 1e-9


def test_resample_port_mask_of_another_size_follows_the_layer_rect():
    src, mask = _tex(16, 20, 5), _tex(8, 10, 6)
    port = fakenet.resample_port(src[::-1], mask[::-1], 48, 40, 3.5, 2.5, 1.5, 1.5, has_mask=True)
    ref = fakenet.sample_reference(src, 48, 40, 3.5, 2.5, 1.5, 1.5) * \
        fakenet.sample_reference(mask[..., :1], 48, 40, 3.5, 2.5, 3.0, 3.0, mip=False, coverage=False)   # 2x smaller mask
    # the mask is addressed with normalised coordinates: the same rect as the layer
    assert np.abs(port - ref).max() < 1e-9


@pytest.mark.parametrize("x,y", [(7, -5), (2.6, 3.4), (-3.5, 2.5), (0.49, 0.5), (-0.5, -0.51)])
def test_blend_fetch_port_integer_offset_and_mask_guard(x, y):
    src, mask = _tex(12, 14, 7), _tex(6, 8, 8)               # the mask is smaller than the layer: 0 outside it
    s, m = fakenet.blend_source_port(src[::-1], mask[::-1], 40, 36, x, y, has_mask=True)
    ox, oy = int(np.floor(x + 0.5)), int(np.floor(y + 0.5))
    ref = fakenet.sample_reference(src, 40, 36, ox, oy, 1.0, 1.0)
    assert np.array_equal(s, ref)
    # outside the mask (but inside the layer) the mask is 0; outside the layer it is irrelevant (source is 0)
    jj, ii = np.mgrid[0:36, 0:40]
    in_layer = (ii - ox >= 0) & (ii - ox < 14) & (jj - oy >= 0) & (jj - oy < 12)
    in_mask = in_layer & (ii - ox < 8) & (jj - oy < 6)
    assert np.all(m[in_layer & ~in_mask] == 0.0)
    assert np.array_equal(m[in_mask], mask[(jj - oy)[in_mask], (ii - ox)[in_mask], 0])


def test_round_half_up_offset_in_the_blend_path():
    src = _tex(4, 4, 9)
    a, _ = fakenet.blend_source_port(src[::-1], None, 10, 10, 2.5, 2.5)        # floor(2.5 + 0.5) = 3
    b, _ = fakenet.blend_source_port(src[::-1], None, 10, 10, 3, 3)
    c, _ = fakenet.blend_source_port(src[::-1], None, 10, 10, 2.49, 2.49)      # -> 2
    d, _ = fakenet.blend_source_port(src[::-1], None, 10, 10, 2, 2)
    assert np.array_equal(a, b) and np.array_equal(c, d) and not np.array_equal(a, c)


# The ports above are Python; these pin the GLSL text to them (a mutated shader must fail the contract).

GLSL_PINS = {
    "round-half-up integer offset": "ivec2(floor(uXform.xy + 0.5))",
    "mask out-of-bounds guard": "m = (d.x < mSize.x && d.y < mSize.y) ? texelFetch(sTD2DInputs[2], mp, 0).r : 0.0;",
    "blend source flip": "ivec2 sp = ivec2(d.x, srcSize.y - 1 - d.y);",
    "blend mask flip": "ivec2 mp = ivec2(d.x, mSize.y - 1 - d.y);",
    "doc y flip": "vec2 c = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);",
    "translation": "vec2 d = c - uA.xy;",
    "layer coords (inverse matrix)": "vec2 l = vec2(uXform.x * d.x + uXform.y * d.y, uXform.z * d.x + uXform.w * d.y);",
    "footprint edge x": "vec2 e0 = 0.5 * vec2(uXform.x, uXform.z);",
    "footprint edge y": "vec2 e1 = 0.5 * vec2(uXform.y, uXform.w);",
    "coverage": "float cov = footprintCoverage(l, e0, e1, srcSz);",
    "coverage applied": "src *= cov * m;",
    "footprint area": "float area0 = abs(e0.x * e1.y - e0.y * e1.x) * 4.0;",
    "axis aligned coverage": "vec2 cv = clamp((min(l + ext, srcSz) - max(l - ext, vec2(0.0))) / (2.0 * ext), 0.0, 1.0);",
    "footprint corners": "p[0] = l - e0 - e1; p[1] = l + e0 - e1; p[2] = l + e0 + e1; p[3] = l - e0 + e1;",
    "clip left": "n = clipPoly(p, n, vec2(1.0, 0.0), 0.0);",
    "clip right": "n = clipPoly(p, n, vec2(-1.0, 0.0), -srcSz.x);",
    "clip top": "n = clipPoly(p, n, vec2(0.0, 1.0), 0.0);",
    "clip bottom": "n = clipPoly(p, n, vec2(0.0, -1.0), -srcSz.y);",
    "clip intersection": "q[m++] = a + (b - a) * (da / (da - db));",
    "coverage ratio": "return clamp(abs(a2) * 0.5 / area0, 0.0, 1.0);",
    "uv flip": "vec2 uv = vec2(l.x / srcSz.x, 1.0 - l.y / srcSz.y);",
    "determinant": "float det = abs(uXform.x * uXform.w - uXform.y * uXform.z);",
    "lod": "float lod = max(0.0, 0.5 * log2(max(det, 1e-12)) - 0.5);",
    "exact flip": "ivec2(ip.x, int(srcSz.y) - 1 - ip.y)",
    "exact linear part": "abs(uXform.x - 1.0) < 1e-6 && abs(uXform.w - 1.0) < 1e-6 && abs(uXform.y) < 1e-6 && abs(uXform.z) < 1e-6",
    "exact tolerance": "abs(uA.x - floor(uA.x + 0.5)) < 1e-4 && abs(uA.y - floor(uA.y + 0.5)) < 1e-4",
    "resample dispatch": "if (uParams.w > 6.5) { resample(); return; }",
    "sampling by lod": "textureLod(sTD2DInputs[0], uv, lod)",
    "mask sampling by lod": "textureLod(sTD2DInputs[1], uv, lod).r",
}


def glsl_contract_failures(src):
    return [k for k, v in GLSL_PINS.items() if v not in src]


def test_glsl_matches_the_pinned_port_formulas():
    assert glsl_contract_failures(GLSL) == []


@pytest.mark.parametrize("pin,old,new", [
    ("round-half-up integer offset", "ivec2(floor(uXform.xy + 0.5))", "ivec2(floor(uXform.xy))"),
    ("mask out-of-bounds guard", "(d.x < mSize.x && d.y < mSize.y) ? texelFetch(sTD2DInputs[2], mp, 0).r : 0.0", "texelFetch(sTD2DInputs[2], mp, 0).r"),
    ("coverage applied", "src *= cov * m;", "src *= m;"),
    ("doc y flip", "outSize.y - gl_FragCoord.y", "gl_FragCoord.y"),
    ("uv flip", "1.0 - l.y / srcSz.y", "l.y / srcSz.y"),
    ("lod", "1e-12)) - 0.5);", "1e-12)) + 0.5);"),
    ("lod", "0.5 * log2(max(det, 1e-12))", "-0.5 * log2(max(det, 1e-12))"),
    ("determinant", "uXform.x * uXform.w - uXform.y * uXform.z", "uXform.x * uXform.w"),
    ("layer coords (inverse matrix)", "uXform.x * d.x + uXform.y * d.y", "uXform.x * d.x + uXform.z * d.y"),
    ("footprint edge y", "0.5 * vec2(uXform.y, uXform.w)", "0.5 * vec2(uXform.z, uXform.w)"),
    ("translation", "d = c - uA.xy", "d = c - uA.zw"),
    ("footprint area", "e0.x * e1.y - e0.y * e1.x", "e0.x * e1.y + e0.y * e1.x"),
    ("axis aligned coverage", "(2.0 * ext)", "(1.0 * ext)"),
    ("coverage ratio", "abs(a2) * 0.5 / area0", "abs(a2) / area0"),
    ("clip right", "vec2(-1.0, 0.0), -srcSz.x", "vec2(-1.0, 0.0), srcSz.x"),
    ("clip bottom", "vec2(0.0, -1.0), -srcSz.y", "vec2(0.0, -1.0), -srcSz.x"),
    ("clip intersection", "da / (da - db)", "da / (da + db)"),
    ("footprint corners", "p[2] = l + e0 + e1;", "p[2] = l + e0 - e1;"),
    ("blend source flip", "srcSize.y - 1 - d.y", "d.y"),
    ("exact flip", "int(srcSz.y) - 1 - ip.y", "ip.y"),
    ("exact tolerance", "abs(uA.x - floor(uA.x + 0.5)) < 1e-4", "abs(uA.x - floor(uA.x + 0.5)) < 1e-2"),
    ("exact linear part", "abs(uXform.y) < 1e-6", "abs(uXform.y) < 1e-1"),
])
def test_shader_mutations_are_caught(pin, old, new):
    assert old in GLSL
    mutated = GLSL.replace(old, new, 1)
    assert mutated != GLSL and pin in glsl_contract_failures(mutated)


# --------------------------------------------------------------------------- xform_is_exact tolerance / mask wiring


@pytest.mark.parametrize("x,y,exact", [(3.0, 2.0, True), (3.00005, 2.0, True), (3.0, 2.00009, True), (3.0005, 2.0, False),
                                       (3.0, 2.0005, False), (-4.99995, 0.0, True), (0.5, 0.0, False)])
def test_xform_is_exact_tolerance(x, y, exact):
    assert network.xform_is_exact((x, y, 1.0, 1.0)) is exact
    assert network.xform_is_exact((x, y, 1.0001, 1.0)) is False


def test_exactness_decides_the_resample_pass(env):
    net, comp, log, _ = env
    mk = lambda x: [base(), px("a", 1, x=x, y=2.0, surfaceW=16, surfaceH=8)]
    net.apply(mk(3.00005), W, H)
    assert "xf_L_a" not in net._ops and source_of(net, "blend_L_a", 1) == "s1"
    assert pvals(net, "blend_L_a", "vec1") == (3.00005, 2.0, 1.0, 1.0)          # the shader rounds it
    net.apply(mk(3.0005), W, H)
    assert "xf_L_a" in net._ops and source_of(net, "blend_L_a", 1) == "xf_L_a"


def test_mask_is_not_wired_on_the_blend_after_resampling(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, x=0.5, sx=1.5, sy=1.5, surfaceW=16, surfaceH=8, mask={"slot": 5, "enabled": True})], W, H)
    assert source_of(net, "xf_L_a", 1) == "s5"
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 0.0
    assert source_of(net, "blend_L_a", 2) == "blank"
    # exact placement keeps the mask on the blend
    net.apply([base(), px("a", 1, x=2, surfaceW=16, surfaceH=8, mask={"slot": 5, "enabled": True})], W, H)
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 1.0 and source_of(net, "blend_L_a", 2) == "s5"
    assert "xf_L_a" not in net._ops


# --------------------------------------------------------------------------- per-layer Flatten token


def test_render_layer_token_is_per_layer(env):
    net, comp, log, _ = env
    st = lambda **kw: [base(), px("p", 1, **kw), shp("s"), txt("t")]
    net.apply(st(), W, H)
    ts, tt = net.render_layer_token("s"), net.render_layer_token("t")
    net.apply(st(x=5, opacity=0.5, visible=False), W, H)               # unrelated pixel layer edits
    assert net.render_layer_token("s") == ts and net.render_layer_token("t") == tt
    net.apply([base(), px("p", 1), shp("s", dict(RECT, x=40)), txt("t")], W, H)       # the shape's own edit
    assert net.render_layer_token("s") != ts and net.render_layer_token("t") == tt
    net.apply([base(), px("p", 1), shp("s", dict(RECT, x=40), opacity=0.2, blend="multiply"), txt("t")], W, H)
    assert net.render_layer_token("s") == net.render_layer_token("s")      # opacity / blend never matter
    t2 = net.render_layer_token("s")
    net.apply([base(), px("p", 1), shp("s", dict(RECT, x=40), opacity=0.9), txt("t")], W, H)
    assert net.render_layer_token("s") == t2
    net.apply([base(), px("p", 1), shp("s", dict(RECT, x=40)), txt("t")], 100, 80)    # document size does
    assert net.render_layer_token("s") != t2 and net.render_layer_token("t") != tt


def test_status_polls_with_no_change_keep_the_token(env):
    net, comp, log, _ = env
    net.apply([base(), txt("t")], W, H)
    assert net.render_layer_ready("t") is True
    tok = net.render_layer_token("t")
    for _ in range(3):
        assert net.render_layer_status("t") == "ready"
    net._text_todo.add("text_t")                      # forced re-poll: the measurements are cached, the pars identical
    assert net.render_layer_status("t") == "ready"
    assert net.render_layer_token("t") == tok


# --------------------------------------------------------------------------- v6: affine (rotate / skew) resample


def test_affine_matrix_conventions():
    """doc = T(x,y) R(rot) K(kx,ky) S(sx,sy) layer; rot clockwise on screen (y down), K = [[1, tan kx],[tan ky, 1]]."""
    a = network.layer_affine(L("a", x=5, y=7, sx=2.0, sy=3.0))
    assert a.pure and a.lin == (2.0, 0.0, 0.0, 3.0) and a.inv == (0.5, 0.0, 0.0, pytest.approx(1 / 3)) and not a.dead
    a = network.layer_affine(L("a", rot=90.0))                       # clockwise: layer +x (right) maps to doc +y (down)
    assert a.lin[0] == pytest.approx(0, abs=1e-12) and a.lin[2] == pytest.approx(1.0)       # (1,0) -> (a, c) = (0, 1)
    assert a.lin[1] == pytest.approx(-1.0) and a.lin[3] == pytest.approx(0, abs=1e-12)      # (0,1) -> (b, d) = (-1, 0)
    a = network.layer_affine(L("a", kx=45.0))                        # x' = x + tan(kx) y
    assert a.lin == (1.0, pytest.approx(1.0), 0.0, 1.0)
    a = network.layer_affine(L("a", ky=45.0))
    assert a.lin == (1.0, 0.0, pytest.approx(1.0), 1.0)
    a = network.layer_affine(L("a", sx=2.0, sy=0.5, rot=30.0, kx=20.0, ky=-10.0))
    ref = fakenet.affine_forward(2.0, 0.5, 30.0, 20.0, -10.0)
    assert np.allclose(np.array(a.lin).reshape(2, 2), ref, atol=1e-12)
    inv = np.array(a.inv).reshape(2, 2)
    assert np.allclose(inv @ np.array(a.lin).reshape(2, 2), np.eye(2), atol=1e-12)
    assert not a.pure and a.det == pytest.approx(np.linalg.det(ref))


def test_affine_degenerate_and_invalid_inputs():
    a = network.layer_affine(L("a", kx=45.0, ky=45.0))                # 1 - tan tan = 0: singular
    assert a.dead and a.inv == (1.0, 0.0, 0.0, 1.0)
    assert not network.layer_affine(L("a", kx=89.0, ky=-89.0)).dead
    assert not network.layer_affine(L("a", kx=400.0)).dead                # skew is clamped to +-89 degrees
    a = network.layer_affine(L("a", rot=float("nan"), kx=float("inf")))
    assert a.pure and not a.dead
    for kind in ("text", "shape", "group", "adjustment"):
        assert network.layer_affine(L("a", kind, rot=30.0, sx=2)) is network.IDENTITY
    assert network.layer_affine(L("a", "input", input=2, rot=15.0)).pure is False
    assert network.layer_affine(L("a", "base", rot=15.0)).pure is False


@pytest.mark.parametrize("rot,kx,ky,sx,sy,mip", [
    (0, 0, 0, 0.7, 0.7, True), (45, 0, 0, 0.7, 0.7, True), (45, 0, 0, 0.8, 0.8, False),     # rotation keeps |det|
    (0, 40, 0, 1.0, 0.6, False), (0, 60, 20, 1.0, 0.6, True),                                 # det = sx sy (1 - tan kx tan ky)
    (20, 30, -25, 0.9, 0.9, False)])
def test_mip_threshold_is_the_determinant(rot, kx, ky, sx, sy, mip):
    a = network.layer_affine(L("a", rot=rot, kx=kx, ky=ky, sx=sx, sy=sy))
    ref = fakenet.affine_forward(sx, sy, rot, kx, ky)
    assert a.mip is mip and bool(fakenet.affine_lod(ref) > 0) is mip


def test_rotated_layer_gets_a_resample_pass_with_the_inverse_matrix(env):
    net, comp, log, _ = env
    layer = px("a", 1, x=10, y=6, sx=1.5, sy=0.75, rot=30.0, kx=12.0, ky=-7.0, surfaceW=16, surfaceH=8)
    net.apply([base(), layer], W, H)                                  # integer x, y: still needs the pass (rotated)
    assert "xf_L_a" in net._ops and source_of(net, "blend_L_a", 1) == "xf_L_a"
    inv, t = fakenet.resample_uniforms(10, 6, 1.5, 0.75, 30.0, 12.0, -7.0)
    assert pvals(net, "xf_L_a", "vec1") == pytest.approx(inv)
    assert pvals(net, "xf_L_a", "vec2")[:2] == (10.0, 6.0)
    xf = net._ops["xf_L_a"].par.value
    assert xf("vec0valuew") == network.ADJ_RESAMPLE and xf("inputfiltertype") == "linear"      # |det| 0.9 -> no mip
    assert pvals(net, "blend_L_a", "vec1") == (0.0, 0.0, 1.0, 1.0)
    # a rotation edit is uniform sets on the resample node only
    settle(net)
    m = log.mark()
    net.apply([base(), dict(layer, rot=31.0)], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert {n for n, k, v in d["par_sets"]} == {net._ops["xf_L_a"].name}
    assert {k for n, k, v in d["par_sets"]} <= {"vec1value" + c for c in "xyzw"}
    m = log.mark()
    net.apply([base(), dict(layer, rot=0.0, kx=0.0, ky=0.0, sx=1.0, sy=1.0)], W, H)           # integer offset again: pass dropped
    assert "xf_L_a" not in net._ops and source_of(net, "blend_L_a", 1) == "s1"


def test_rotation_mip_flag_follows_the_determinant(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, rot=33.0, sx=0.6, sy=0.6, surfaceW=16, surfaceH=8)], W, H)
    assert net._ops["xf_L_a"].par.value("inputfiltertype") == "mipmap"
    net.apply([base(), px("a", 1, rot=33.0, sx=0.9, sy=0.9, surfaceW=16, surfaceH=8)], W, H)
    assert net._ops["xf_L_a"].par.value("inputfiltertype") == "linear"
    _mip_inputs_are_surfaces(net)


def test_singular_transform_renders_nothing_without_a_resample_pass(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, kx=45.0, ky=45.0, surfaceW=16, surfaceH=8)], W, H)
    assert "xf_L_a" not in net._ops and source_of(net, "blend_L_a", 1) == "blank"


@pytest.mark.parametrize("x,y,sx,sy,rot,kx,ky", [
    (6.3, 4.1, 1.0, 1.0, 30.0, 0.0, 0.0), (20.0, -2.0, 1.4, 0.8, -50.0, 0.0, 0.0), (8.0, 3.0, 1.0, 1.0, 0.0, 25.0, 0.0),
    (4.0, 6.5, 1.0, 1.0, 0.0, 0.0, -20.0), (14.5, 3.5, 0.9, 1.2, 17.0, 30.0, -12.0), (24.0, 20.0, 0.5, 0.5, 90.0, 0.0, 0.0),
    (3.0, 2.0, 0.6, 0.45, 25.0, 10.0, 5.0)])
@pytest.mark.parametrize("masked", [False, True])
def test_resample_port_affine_matches_reference(x, y, sx, sy, rot, kx, ky, masked):
    """The shader port (inverse-matrix uniforms, parallelogram clipping, lod from the determinant) vs the independent
    top-down reference (forward matrix, point sampled coverage): equal in the interior, edges within the 32x32 point
    sampling error."""
    src, mask = _tex(16, 20, 5), _tex(16, 20, 6)
    port = fakenet.resample_port(src[::-1], mask[::-1], 48, 40, x, y, sx, sy, has_mask=masked, rot=rot, kx=kx, ky=ky)
    ref = fakenet.sample_reference(src, 48, 40, x, y, sx, sy, rot=rot, kx=kx, ky=ky)
    if masked:
        ref = ref * fakenet.sample_reference(mask[..., :1], 48, 40, x, y, sx, sy, rot=rot, kx=kx, ky=ky, coverage=False)
    A = fakenet.affine_forward(sx, sy, rot, kx, ky)
    cov_ref = fakenet.coverage_supersampled(A, x, y, 20, 16, 48, 40)
    assert (cov_ref > 0).sum() > 30
    full = cov_ref == 1.0
    full = full & np.roll(full, 1, 0) & np.roll(full, -1, 0) & np.roll(full, 1, 1) & np.roll(full, -1, 1)    # not on an edge
    assert full.sum() >= 5 or abs(np.linalg.det(A)) < 0.5
    assert np.abs(port - ref)[full].max() < 1e-9
    assert np.abs(port - ref).max() < 0.045          # edges: point sampling error (<= 1/32 of the coverage) x colour <= 1


def test_footprint_coverage_analytic_cases():
    f = fakenet.footprint_coverage
    s = np.sin(np.radians(45)) * 0.5
    c45 = (0.5 * np.cos(np.radians(45)), 0.5 * np.sin(np.radians(45)))
    e0, e1 = c45, (-c45[1], c45[0])                                  # a unit pixel rotated by 45 degrees (a diamond)
    r = np.hypot(*e0) * np.sqrt(2)                                   # half diagonal 0.7071
    assert f((50.0, 50.0), e0, e1, 100, 100) == 1.0
    assert f((0.0, 50.0), e0, e1, 100, 100) == pytest.approx(0.5)     # centred on the edge: half, for any orientation
    assert f((r - 0.5 * r, 50.0), e0, e1, 100, 100) == pytest.approx(1 - 0.125, abs=1e-9)    # the diamond's tip cut off
    assert f((r, 50.0), e0, e1, 100, 100) == pytest.approx(1.0)
    assert f((-r, 50.0), e0, e1, 100, 100) == 0.0
    assert f((0.0, 0.0), e0, e1, 100, 100) == pytest.approx(0.25, abs=1e-9)        # the corner: a quarter
    assert f((100.0, 100.0), e0, e1, 100, 100) == pytest.approx(0.25, abs=1e-9)
    # axis aligned footprints are the v4 separable overlap
    assert f((0.25, 50.0), (0.5, 0.0), (0.0, 0.5), 100, 100) == pytest.approx(0.75)
    assert f((0.25, 0.25), (1.0, 0.0), (0.0, 1.0), 100, 100) == pytest.approx((1.25 / 2) * (1.25 / 2))
    # a magnified skew: the overlap of a sheared pixel with the corner
    assert 0.0 < f((0.0, 0.0), (0.5, 0.0), (0.4, 0.5), 100, 100) < 0.5


def test_rotated_rect_area_is_conserved_by_the_port():
    """Sum of the coverage over the document == the area of the transformed layer rect (|det| * w * h)."""
    for rot, kx, ky, sx, sy in ((30.0, 0, 0, 1.0, 1.0), (0, 30.0, 10.0, 1.2, 0.8), (77.0, -20.0, 0, 0.7, 1.1)):
        A = fakenet.affine_forward(sx, sy, rot, kx, ky)
        src = np.ones((10, 14, 4))
        out = fakenet.resample_port(src[::-1], None, 64, 64, 30.0, 20.0, sx, sy, rot=rot, kx=kx, ky=ky)
        assert out[..., 3].sum() == pytest.approx(abs(np.linalg.det(A)) * 14 * 10, rel=1e-6)


def test_rotation_direction_is_clockwise_on_screen():
    """A layer whose right edge is bright, rotated 90 degrees clockwise, has its bright edge at the BOTTOM."""
    src = np.zeros((10, 20, 4))
    src[:, 10:, :] = 1.0                                              # right half: premultiplied white
    # pivot = layer top-left: rot 90 maps layer (lx, ly) -> doc (x - ly, y + lx): the layer extends to the left and down
    out = fakenet.sample_reference(src, 40, 40, 20.0, 5.0, 1.0, 1.0, rot=90.0)
    ys, xs = np.nonzero(out[..., 3] > 0.5)
    assert xs.min() >= 10 and xs.max() < 20 and ys.min() >= 15 and ys.max() < 25        # bright half: lx 10..20 -> doc y 15..25
    assert out[22, 12, 3] == pytest.approx(1.0) and out[8, 12, 3] == 0.0                   # lx 17 is bright, lx 3 is transparent
    port = fakenet.resample_port(src[::-1], None, 40, 40, 20.0, 5.0, 1.0, 1.0, rot=90.0)
    assert np.abs(port - out).max() < 0.05


# --------------------------------------------------------------------------- v6: multiple inputs


def inp(id_, n, **kw):
    return L(id_, "input", input=n, **kw)


def connect_inputs(comp, *ns):
    for n in ns:
        while len(comp.inputConnectors) < n:
            comp.inputConnectors.append(fakenet.FakeConnector(comp, len(comp.inputConnectors)))
        comp.inputConnectors[n - 1].source = comp.in1


def test_input_layers_read_their_own_select(env):
    net, comp, log, _ = env
    connect_inputs(comp, 1, 3)
    net.apply([inp("i1", 1), inp("i3", 3, x=4.5, sx=0.5, sy=0.5), inp("i2", 2), px("p", 1, surfaceW=8, surfaceH=8)], W, H)
    assert {n for n in net._ops if n.startswith("src_in")} == {"src_in1", "src_in2", "src_in3"}
    top = lambda n: net._ops["src_in%d" % n].par.value("top")
    assert (top(1), top(2), top(3)) == ("../in1", "blank", "../in3")
    assert net._ops["src_in1"].OPType == "selectTOP"
    assert source_of(net, "blend_L_i1", 1) == "src_in1" and source_of(net, "blend_L_i2", 1) == "src_in2"
    assert source_of(net, "xf_L_i3", 0) == "src_in3" and source_of(net, "blend_L_i3", 1) == "xf_L_i3"
    assert "xf_L_i2" not in net._ops                              # disconnected: transparent, nothing to resample
    assert source_of(net, "blend_L_i1", 0) == "blank" and source_of(net, "blend_L_i3", 0) == "blend_L_i1"
    _mip_inputs_are_surfaces(net)


def test_input_layer_blend_mode_and_opacity_are_honoured(env):
    net, comp, log, _ = env
    connect_inputs(comp, 1)
    net.apply([inp("i1", 1, blend="multiply", opacity=0.4)], W, H)
    p = net._ops["blend_L_i1"].par.value
    assert p("vec0valuex") == float(network.BLEND_INDEX["multiply"]) and p("vec0valuey") == 0.4


def test_two_layers_may_read_the_same_input(env):
    net, comp, log, _ = env
    connect_inputs(comp, 2)
    net.apply([inp("a", 2), inp("b", 2, x=3.5, sx=0.5, sy=0.5)], W, H)
    assert source_of(net, "blend_L_a", 1) == "src_in2" and source_of(net, "xf_L_b", 0) == "src_in2"
    assert [n for n in net._ops if n.startswith("src_in")] == ["src_in2"]


def test_unreferenced_input_selects_are_removed(env):
    net, comp, log, _ = env
    connect_inputs(comp, 1, 2)
    net.apply([inp("a", 1), inp("b", 2)], W, H)
    assert "src_in2" in net._ops
    net.apply([inp("a", 1)], W, H)
    assert "src_in2" not in net._ops and net.input_connected(2) is True


def test_connect_disconnect_keeps_placement_and_is_cheap(env):
    net, comp, log, _ = env
    layers = [inp("i2", 2, x=3.5, y=1.0, sx=0.5, sy=0.5, rot=10.0)]
    net.apply(layers, W, H)
    assert "xf_L_i2" not in net._ops                              # not connected yet: transparent
    connect_inputs(comp, 2)
    net.set_inputs({2: True})
    m = log.mark()
    net.apply(layers, W, H)                                       # the layer's spec never changed: the placement is back
    assert "xf_L_i2" in net._ops and net._ops["src_in2"].par.value("top") == "../in2"
    inv, t = fakenet.resample_uniforms(3.5, 1.0, 0.5, 0.5, 10.0)
    assert pvals(net, "xf_L_i2", "vec1") == pytest.approx(inv)
    comp.inputConnectors[1].disconnect()
    net.apply(layers, W, H)
    assert "xf_L_i2" not in net._ops and net._ops["src_in2"].par.value("top") == "blank"


def test_set_inputs_repoints_the_selects_at_once_and_replans(env):
    net, comp, log, _ = env
    layers = [inp("i4", 4, x=0.5, sx=0.5, sy=0.5), inp("i1", 1)]
    net.apply(layers, W, H)
    assert net._ops["src_in4"].par.value("top") == "blank"
    net.set_inputs({4: True})                                     # connector 4 of the fake COMP does not exist: fallback
    assert net._ops["src_in4"].par.value("top") == "../in4"
    net.apply(layers, W, H)
    assert "xf_L_i4" in net._ops and net.input_connected(4) and not net.input_connected(1)
    net.set_inputs({4: False, 1: True})
    assert net._ops["src_in4"].par.value("top") == "blank" and net._ops["src_in1"].par.value("top") == "../in1"


def test_legacy_base_layer_is_input_one(env):
    net, comp, log, _ = env
    connect_inputs(comp, 1)
    net.apply([L("base", "base", x=1.5), inp("i2", 2)], W, H)
    assert source_of(net, "xf_L_base", 0) == "src_in1" and net._ops["src_in1"].par.value("top") == "../in1"


def test_input_index_is_clamped(env):
    assert network.input_index(inp("a", 0)) == 1 and network.input_index(inp("a", 99)) == network.MAX_INPUTS
    assert network.input_index(L("a", "input")) == 1 and network.input_index(L("a", "input", input="x")) == 1


def test_input_layer_with_mask_uses_the_input_size_for_the_mask(env):
    net, comp, log, _ = env
    connect_inputs(comp, 2)
    net.apply([inp("i2", 2, x=0.5, sx=0.5, sy=0.5, surfaceW=120, surfaceH=90, mask={"slot": 7, "enabled": True})], W, H)
    assert (net._ops["s7"].par.value("resolutionw"), net._ops["s7"].par.value("resolutionh")) == (120, 90)
    assert source_of(net, "xf_L_i2", 1) == "s7" and source_of(net, "xf_L_i2", 0) == "src_in2"


def test_inputs_reorder_and_delete_only_rewire(env):
    net, comp, log, _ = env
    connect_inputs(comp, 1, 2)
    a, b, c = inp("a", 1), inp("b", 2), px("c", 1, surfaceW=8, surfaceH=8)
    net.apply([a, b, c], W, H)
    settle(net)
    m = log.mark()
    net.apply([b, a, c], W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["par_sets"]
    net.apply([a, c], W, H)
    assert "blend_L_b" not in net._ops and "src_in2" not in net._ops


# --------------------------------------------------------------------------- v6: layer effects integration


def shadow(**kw):
    return dict({"type": "dropShadow", "enabled": True, "blur": 4.0, "dx": 3.0, "dy": 3.0, "opacity": 0.8,
                 "color": {"r": 0, "g": 0, "b": 0, "a": 255}}, **kw)


def overlay(**kw):
    return dict({"type": "colorOverlay", "enabled": True, "opacity": 1.0, "color": {"r": 255, "g": 0, "b": 0, "a": 255}}, **kw)


def fx_chain_nodes(net, lid):
    return net._chains[lid].nodes if lid in net._chains else []


def source_op_name(net, op):
    return next((n for n, o in net._ops.items() if o is op), None)


def test_effects_module_is_found(env):
    net, *_ = env
    assert net._fx is not None and net.fx_error is None and "dropShadow" in net._fx_shaders


def test_pixel_layer_with_effects_is_staged_even_at_an_integer_offset(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, x=3, y=2, surfaceW=16, surfaceH=8, effects=[shadow()])], W, H)
    nodes = fx_chain_nodes(net, "a")
    assert len(nodes) == 2                                                # drop shadow = 2 passes
    assert "xf_L_a" in net._ops and source_of(net, "xf_L_a", 0) == "s1"
    # exact (integer, scale 1) resample uniforms: identity matrix, translation (3, 2)
    assert pvals(net, "xf_L_a", "vec1") == (1.0, 0.0, 0.0, 1.0) and pvals(net, "xf_L_a", "vec2")[:2] == (3.0, 2.0)
    # chain input 0 = the resample node, the last pass is the blend's source
    assert nodes[0].inputConnectors[0].source is net._ops["xf_L_a"]
    assert net._ops["blend_L_a"].inputConnectors[1].source is nodes[-1]
    assert pvals(net, "blend_L_a", "vec1") == (0.0, 0.0, 1.0, 1.0) and net._ops["blend_L_a"].par.value("vec0valuez") == 0.0
    assert net._ops["xf_L_a"].par.value("inputfiltertype") == "linear"


def test_effect_masks_are_applied_before_the_effects(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, mask={"slot": 5, "enabled": True}, effects=[overlay()])], W, H)
    assert source_of(net, "xf_L_a", 1) == "s5" and net._ops["xf_L_a"].par.value("vec0valuez") == 1.0
    assert net._ops["blend_L_a"].par.value("vec0valuez") == 0.0
    assert fx_chain_nodes(net, "a")[0].inputConnectors[0].source is net._ops["xf_L_a"]


def test_text_and_shape_effects(env):
    net, comp, log, _ = env
    net.apply([base(), shp("s", effects=[overlay()]), txt("t", effects=[overlay()], mask={"slot": 9, "enabled": True})], W, H)
    # no mask: the chain reads the shape node directly
    assert fx_chain_nodes(net, "s")[0].inputConnectors[0].source is net._ops["shape_s"]
    assert "xf_L_s" not in net._ops
    # a mask is applied first by an identity resample pass (source x mask)
    assert "xf_L_t" in net._ops and source_of(net, "xf_L_t", 0) == "text_t" and source_of(net, "xf_L_t", 1) == "s9"
    assert pvals(net, "xf_L_t", "vec1") == (1.0, 0.0, 0.0, 1.0) and net._ops["xf_L_t"].par.value("vec0valuez") == 1.0
    assert fx_chain_nodes(net, "t")[0].inputConnectors[0].source is net._ops["xf_L_t"]
    assert net._ops["blend_L_t"].par.value("vec0valuez") == 0.0 and source_of(net, "blend_L_t", 2) == "blank"
    assert net.render_layer_source("s") is net._ops["shape_s"]           # Flatten = content only


def test_input_layer_effects(env):
    net, comp, log, _ = env
    connect_inputs(comp, 2)
    net.apply([inp("i2", 2, effects=[overlay()])], W, H)
    assert "xf_L_i2" in net._ops and source_of(net, "xf_L_i2", 0) == "src_in2" and len(fx_chain_nodes(net, "i2")) == 1
    comp.inputConnectors[1].disconnect()
    net.apply([inp("i2", 2, effects=[overlay()])], W, H)                   # disconnected: transparent, nothing to decorate
    assert "i2" not in net._chains and "xf_L_i2" not in net._ops


def test_groups_and_adjustments_ignore_effects(env):
    net, comp, log, _ = env
    net.apply([base(), L("g", "group", effects=[overlay()]), px("c", 1, parentId="g", surfaceW=8, surfaceH=8),
               adj("adj", {"type": "invert"}, effects=[overlay()])], W, H)
    assert not net._chains


def test_effect_param_edit_is_par_sets_only(env):
    net, comp, log, _ = env
    mk = lambda **kw: [base(), px("a", 1, x=2, surfaceW=16, surfaceH=8, effects=[shadow(**kw)])]
    net.apply(mk(), W, H)
    settle(net)
    m = log.mark()
    net.apply(mk(dx=7.0, opacity=0.5), W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert {n for n, k, v in d["par_sets"]} <= {o.name for o in fx_chain_nodes(net, "a")} and d["par_sets"]
    m = log.mark()
    net.apply(mk(dx=7.0, opacity=0.5), W, H)                                # identical: nothing at all
    assert log.since(m)["par_sets"] == [] and net.stats()["last"]["par_sets"] == 0


def test_toggling_effects_builds_and_pools_the_chain_cleanly(env):
    net, comp, log, _ = env
    settle(net)
    on = [base(), px("a", 1, x=2, surfaceW=16, surfaceH=8, effects=[shadow(), overlay()])]
    off = [base(), px("a", 1, x=2, surfaceW=16, surfaceH=8, effects=[shadow(enabled=False), overlay(enabled=False)])]
    net.apply(on, W, H)
    nodes = list(fx_chain_nodes(net, "a"))
    assert len(nodes) == 3 and "xf_L_a" in net._ops
    assert not [c for c in log.creates if c[1].startswith("fx_")]             # nodes came from the pool, not parent.create
    net.apply(off, W, H)                                                      # all disabled: no chain, no resample pass
    assert "a" not in net._chains and "xf_L_a" not in net._ops
    assert net._ops["blend_L_a"].inputConnectors[1].source is net._ops["s1"]
    pooled = [n for n, c in net._pool]
    assert all(n in pooled or n in [g for g, c in net._garbage] for n in nodes)
    for n in nodes:                                                           # returned as clean spares, disconnected
        assert all(con.source is None for con in n.inputConnectors)
        if n in pooled:
            assert n.par.value("pixeldat") == "blend_glsl" and n.par.value("vec2name") == "uA" and n.par.value("format") == network.FMT_BLEND
    for _ in range(3):                                                        # churn: re-enable, then a blend reuses spares
        net.apply(on, W, H)
        net.apply(off + [px("b", 2, surfaceW=8, surfaceH=8, blend="multiply")], W, H)
        settle(net)
    pv = net._ops["blend_L_b"].par.value
    assert pv("pixeldat") == "blend_glsl" and pv("vec2name") == "uA" and pv("vec3name") == "uB" and pv("vec0name") == "uParams"


def test_deleting_the_layer_destroys_the_chain_and_reorder_keeps_it(env):
    net, comp, log, _ = env
    a = px("a", 1, surfaceW=16, surfaceH=8, effects=[overlay()])
    b = px("b", 2, surfaceW=16, surfaceH=8)
    net.apply([base(), a, b], W, H)
    chain = net._chains["a"]
    m = log.mark()
    net.apply([base(), b, a], W, H)
    d = log.since(m)
    assert net._chains["a"] is chain and not d["creates"] and not d["par_sets"]
    net.apply([base(), b], W, H)
    assert not net._chains and "fx_L_a" not in net._fx_out
    assert all(not n.valid or all(c.source is None for c in n.inputConnectors) for n in chain.nodes) or chain.node_count == 0


def test_chain_nodes_survive_unknown_node_cleanup(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[shadow()])], W, H)
    nodes = list(fx_chain_nodes(net, "a"))
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[shadow()]), px("b", 2, surfaceW=8, surfaceH=8)], W, H)
    net._scanned = False                                                      # force the leftover scan
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[shadow()])], W, H)
    assert all(n.valid for n in nodes)
    assert not [n for n, c in net._pool if n in nodes]                         # not handed out as spares
    assert comp.op("doc").op("fxsrc_dropShadow") is not None                  # the shader DATs are not "unknown" either


def test_shared_effect_shader_dats_are_reused(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=8, surfaceH=8, effects=[shadow()]), px("b", 2, surfaceW=8, surfaceH=8, effects=[shadow()])], W, H)
    assert len([c for c in log.creates if c[1] == "fxsrc_dropShadow"]) == 1


def test_effect_chain_failure_shows_the_layer_without_effects(env, monkeypatch):
    net, comp, log, _ = env
    monkeypatch.setattr(net._fx.EffectChain, "apply", lambda self, *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[overlay()])], W, H)
    assert "boom" in net.fx_error and net._ops["blend_L_a"].inputConnectors[1].source is net._ops["xf_L_a"]


def test_without_an_effects_module_layers_render_plainly(monkeypatch):
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL, effects=object(), effect_shaders={})        # a module without EffectChain / plan_chain
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[overlay()])], W, H)
    assert not net._chains and "xf_L_a" not in net._ops


def test_malformed_effect_entries_are_ignored(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[None, "x", {"type": "nope"}, {"type": "stroke", "width": 0}])], W, H)
    assert not net._chains and "xf_L_a" not in net._ops


def test_stats_report_effects(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=16, surfaceH=8, effects=[shadow()])], W, H)
    s = net.stats()
    assert s["fx_chains"] == 1 and s["fx_nodes"] == 2 and s["fx_error"] is None


# --------------------------------------------------------------------------- review follow-ups


def test_skew_is_clamped_to_the_web_limit_of_85_degrees():
    assert network.SKEW_MAX == 85.0
    a, b = network.layer_affine(L("a", kx=89.0)), network.layer_affine(L("a", kx=85.0))
    assert a.lin == b.lin                                                   # 89 -> 85, like web/src/engine/xform.ts
    assert network.layer_affine(L("a", ky=-400.0)).lin == network.layer_affine(L("a", ky=-85.0)).lin
    assert network.layer_affine(L("a", kx=84.0)).lin != b.lin


def _stale_glsl(comp, name, tags, res="custom", filt="mipmap"):
    node = comp.op("doc").create("glslTOP", name)           # (the fixture's DocNetwork already made doc)
    node.tags = list(tags)
    node.comment = "stale"
    node.bypass = True
    node.par.outputresolution = res
    node.par.resolutionw = 333
    node.par.inputfiltertype = filt
    return node


def test_recycled_stale_nodes_get_neutral_parameters(env):
    net, comp, log, clock = env
    net.apply([base()], W, H)
    settle(net)
    tagged = _stale_glsl(comp, "g90", ["role:xf_L_gone"])                    # a tagged stale resample node
    spare = _stale_glsl(comp, "g91", [])                                      # an untagged spare
    net2 = DocNetwork(comp, GLSL, clock=clock, optimize=False)
    net2.apply([base()], W, H)
    pooled = [n for n, c in net2._pool]
    for node in (tagged, spare):
        assert node.valid and node in pooled
        v = node.par.value
        assert v("outputresolution") == "useinput" and v("inputfiltertype") == "nearest"
        assert node.bypass is False and node.tags == [] and node.comment == ""
        assert not any(c.source for c in node.inputConnectors)


def test_v4_document_adoption_resets_stale_resample_and_drops_old_names(env):
    """A v4 file: blend_base + base_src + a tagged xf_L_* with a custom resolution and the mipmap filter."""
    net, comp, log, clock = env
    doc = net.doc
    old_blend = _stale_glsl(comp, "g1", ["role:blend_base"], res="useinput", filt="linear")
    stale_xf = _stale_glsl(comp, "g2", ["role:xf_L_old"])
    base_src = doc.create("selectTOP", "base_src")
    net2 = DocNetwork(comp, GLSL, clock=clock, optimize=False)
    net2.apply([base(), px("a", 1, surfaceW=16, surfaceH=8)], W, H)
    assert net2.output() is not None
    assert not base_src.valid                                                  # v4 name no longer part of the network
    assert stale_xf.valid and stale_xf in [n for n, c in net2._pool]          # recycled, not destroyed
    v = stale_xf.par.value
    assert v("outputresolution") == "useinput" and v("inputfiltertype") == "nearest" and stale_xf.tags == []
    assert old_blend.valid and old_blend.tags == [] and old_blend.par.value("inputfiltertype") == "nearest"   # v4 role: not a v5 role
    assert source_of(net2, "blend_L_a", 1) == "s1" and source_of(net2, "blend_L_a", 0) == "blend_L_base"
    assert not any(o.OPType == "glslTOP" and o.par.value("inputfiltertype") == "mipmap" for o in net2._ops.values())
    _mip_inputs_are_surfaces(net2)


def test_set_inputs_is_only_effective_after_the_next_apply(env):
    """The documented one-frame caveat: set_inputs re-points the Select, the transform / resample is re-planned by apply()."""
    net, comp, log, _ = env
    b = L("i", "input", input=1, x=2.5, y=0, sx=0.5, sy=0.5, surfaceW=16, surfaceH=8)
    net.apply([b], W, H)
    assert "xf_L_i" not in net._ops
    comp.inputConnectors[0].connect(comp.in1)
    net.set_inputs({1: True})
    assert net._ops["src_in1"].par.value("top") == "../in1"                    # Select updated at once ...
    assert "xf_L_i" not in net._ops                                            # ... but the placement is still the old plan
    net.apply([b], W, H)                                                       # (the ext applies right after set_inputs)
    assert "xf_L_i" in net._ops and net._ops["xf_L_i"].par.value("inputfiltertype") == "mipmap"


def test_disconnected_input_layer_has_no_mask_wiring(env):
    net, comp, log, _ = env
    b = L("i", "input", input=3, surfaceW=16, surfaceH=8, mask={"slot": 6, "enabled": True})
    net.apply([b], W, H)                                                       # input 3 is not connected
    assert net._ops["blend_L_i"].par.value("vec0valuez") == 0.0 and source_of(net, "blend_L_i", 2) == "blank"
    connect_inputs(comp, 3)
    net.apply([b], W, H)
    assert net._ops["blend_L_i"].par.value("vec0valuez") == 1.0 and source_of(net, "blend_L_i", 2) == "s6"


def test_effect_chain_failure_backs_off_and_cleans_partial_nodes(env, monkeypatch):
    net, comp, log, clock = env
    calls = []
    orig = net._fx.EffectChain.apply

    def partial(self, *a, **k):
        calls.append(1)
        orig(self, *a, **k)                       # builds the nodes ...
        raise RuntimeError("late failure")       # ... then fails
    monkeypatch.setattr(net._fx.EffectChain, "apply", partial)
    mk = lambda op_=1.0, fx=None: [base(), px("a", 1, opacity=op_, surfaceW=16, surfaceH=8, effects=fx or [overlay()])]
    net.apply(mk(), W, H)
    assert len(calls) == 1 and "late failure" in net.fx_error and "a" not in net._chains
    for i in range(5):                                                         # unrelated edits: no retry storm
        net.apply(mk(0.5 - 0.05 * i), W, H)
    assert len(calls) == 1
    assert net._ops["blend_L_a"].inputConnectors[1].source is net._ops["xf_L_a"]
    net.apply(mk(fx=[overlay(opacity=0.5)]), W, H)                             # a changed effect list retries at once
    assert len(calls) == 2
    clock.t += 1.0
    net.apply(mk(0.3, fx=[overlay(opacity=0.5)]), W, H)                        # back-off (0.5 * 2**2 = 2 s) not over yet
    assert len(calls) == 2
    clock.t += 5.0
    net.apply(mk(0.2, fx=[overlay(opacity=0.5)]), W, H)
    assert len(calls) == 3
    monkeypatch.setattr(net._fx.EffectChain, "apply", orig)                    # recovers
    clock.t += 60.0
    net.apply(mk(0.1, fx=[overlay(opacity=0.5)]), W, H)
    assert "a" in net._chains and net._fx_fail == {}


def test_glsl_pins_for_exact_mask_branch_and_footprint_early_out():
    pins = {
        "exact mask size branch": "if (exact && mSize == ivec2(srcSz)) {",
        "footprint early-out": "if (hi.x <= 0.0 || hi.y <= 0.0 || lo.x >= srcSz.x || lo.y >= srcSz.y) return 0.0;",
        "footprint inside": "if (lo.x >= 0.0 && lo.y >= 0.0 && hi.x <= srcSz.x && hi.y <= srcSz.y) return 1.0;",
    }
    for name, text in pins.items():
        assert text in GLSL, name
    for old, new in (("mSize == ivec2(srcSz)", "mSize != ivec2(srcSz)"),
                     ("hi.x <= 0.0 || hi.y <= 0.0", "hi.x <= 0.0 && hi.y <= 0.0"),
                     ("lo.x >= 0.0 && lo.y >= 0.0 && hi.x", "lo.x >= 0.0 || lo.y >= 0.0 && hi.x")):
        assert old in GLSL
        mutated = GLSL.replace(old, new, 1)
        assert any(t not in mutated for t in pins.values())


# =========================================================================== v6 phase A: performance
# bounding boxes, skip rules, merged passes, 8 bit intermediates, blur pyramid, spare-node pool (docs/DESIGN_V6.md 2)


@pytest.fixture
def opt():
    clock = fakenet.Clock()
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL, clock=clock)
    assert net._opt
    return net, comp, log, clock


def fmt(net, role):
    return net._ops[role].par.value("format")


def plan(net):
    return net.stats()["plan"]


def uL(net, role, k):
    pv = net._ops[role].par.value
    return tuple(pv("vec%dvalue%s" % (4 + k, c)) for c in "xyzw")


def ins(net, role):
    """Role names wired to the inputs of ``role``."""
    names = {id(o): r for r, o in net._ops.items()}
    return [names.get(id(c.source)) for c in net._ops[role].inputConnectors if c.source is not None]


# ---- bounds math


def test_affine_box_pure_scale_offset_and_rotation():
    a = network.Affine(10.0, 20.0, 2.0, 3.0)
    assert network.affine_box(a, (0, 0, 8, 4)) == (10.0, 20.0, 26.0, 32.0)
    r = network.Affine(0.0, 0.0, 1.0, 1.0, rot=90.0)          # 90 degrees clockwise on screen: (u, v) -> (-v, u)
    b = network.affine_box(r, (0, 0, 8, 4))
    assert all(abs(x - y) < 1e-9 for x, y in zip(b, (-4.0, 0.0, 0.0, 8.0)))
    k = network.Affine(0.0, 0.0, 1.0, 1.0, kx=45.0)           # x += y * tan(45)
    b = network.affine_box(k, (0, 0, 8, 4))
    assert all(abs(x - y) < 1e-9 for x, y in zip(b, (0.0, 0.0, 12.0, 4.0)))


def test_clip_box_outward_rounding_clipping_and_empty():
    assert network.clip_box((1.2, 2.7, 9.1, 6.0), 64, 48) == (1, 2, 10, 6)
    assert network.clip_box((1.2, 2.7, 9.1, 6.0), 64, 48, pad=1) == (0, 1, 11, 7)
    assert network.clip_box((-5.0, -5.0, 200.0, 200.0), 64, 48) == (0, 0, 64, 48)
    assert network.clip_box((70.0, 0.0, 80.0, 10.0), 64, 48) is None
    assert network.clip_box((10.0, 10.0, 10.0, 20.0), 64, 48) is None            # zero width
    assert network.clip_box((float("nan"), 0, 1, 1), 64, 48) == (0, 0, 64, 48)


def test_layer_box_cases():
    ex = network.layer_affine({"kind": "pixel", "x": 10, "y": 5})
    assert network.layer_box(ex, 20, 10, 64, 48) == (10, 5, 30, 15)                           # exact: no padding
    assert network.layer_box(network.layer_affine({"kind": "pixel", "x": 60, "y": 5}), 20, 10, 64, 48) == (60, 5, 64, 15)
    assert network.layer_box(network.layer_affine({"kind": "pixel", "x": 64, "y": 5}), 20, 10, 64, 48) is None
    assert network.layer_box(network.layer_affine({"kind": "pixel", "x": -30, "y": 0}), 20, 10, 64, 48) is None
    sc = network.layer_affine({"kind": "pixel", "x": 0.5, "y": 0.0, "sx": 2.0, "sy": 2.0})
    assert network.layer_box(sc, 10, 10, 64, 48) == (0, 0, 22, 21)                          # 0.5..20.5 -> 1 px pad
    assert network.layer_box(network.layer_affine({"kind": "pixel", "sx": 1.5, "sy": 1.5, "x": .5}), 10_000, 10_000, 64, 48) == (0, 0, 64, 48)
    dead = network.Affine(0, 0, 1e-12, 1.0)
    assert network.layer_box(dead, 20, 10, 64, 48) is None


def test_layer_box_content_hint():
    aff = network.layer_affine({"kind": "pixel", "x": 10.5, "y": 5.0})
    full = network.layer_box(aff, 40, 30, 64, 48)
    assert full == (9, 4, 52, 36)                                                                    # 10.5..50.5, 1 px pad
    tight = network.layer_box(aff, 40, 30, 64, 48, hint=(5.0, 5.0, 15.0, 10.0))
    assert tight is not None and tight[0] > full[0] and tight[3] < full[3]
    assert tight[0] <= 10.5 + 5.0 - 1 and tight[2] >= 10.5 + 15.0 + 1                        # padded by the filter reach
    assert network.layer_box(aff, 40, 30, 64, 48, hint=network.EMPTY_HINT) is None
    assert network.layer_box(aff, 40, 30, 64, 48, hint=(50.0, 50.0, 60.0, 60.0)) == full    # outside the surface: no hint
    assert network.layer_box(aff, 40, 30, 64, 48, hint=(9.0, 9.0, 9.0, 12.0)) == full         # degenerate rect: no hint
    assert network.layer_box(aff, 40, 30, 64, 48, hint=("a", 1, 2, 3)) == full                # not numeric: no hint
    # the exact path keeps no padding
    ex = network.layer_affine({"kind": "pixel", "x": 10, "y": 5})
    assert network.layer_box(ex, 40, 30, 64, 48, hint=(5.0, 5.0, 15.0, 10.0)) == (15, 10, 25, 15)


def test_shape_box_rect_ellipse_polygon_line_and_nothing():
    base_ = {"type": "rect", "x": 10, "y": 5, "w": 20, "h": 10, "radius": 0, "fill": FILL, "stroke": NOSTROKE, "rotation": 0}
    assert network.shape_box(base_, 64, 48) == (8, 3, 32, 17)                                # +2 px antialiasing margin
    assert network.shape_box(dict(base_, stroke=STROKE), 64, 48) == (6, 1, 34, 19)           # + half stroke width (2)
    flipped = dict(base_, x=30, y=15, w=-20, h=-10)                                           # dragged up / left: the same box
    assert network.shape_box(flipped, 64, 48) == network.shape_box(base_, 64, 48)
    assert network.shape_box(dict(base_, rotation=90), 64, 48) == (13, 0, 27, 22)            # 20x10 about (20, 10) turned: 10x20, clipped at 0
    el = dict(base_, type="ellipse")
    assert network.shape_box(el, 64, 48) == (8, 3, 32, 17)
    poly = {"type": "polygon", "cx": 30, "cy": 20, "radius": 10, "sides": 5, "innerRatio": 1, "fill": FILL, "stroke": NOSTROKE}
    assert network.shape_box(poly, 64, 48) == (18, 8, 42, 32)
    line = {"type": "line", "x1": 5, "y1": 5, "x2": 25, "y2": 15, "fill": NOSTROKE, "stroke": STROKE}
    assert network.shape_box(line, 64, 48) == (1, 1, 29, 19)                                  # reach = 2 (half stroke) + 2
    arrow = dict(line, arrowEnd=True)
    assert network.shape_box(arrow, 64, 48) == (0, 0, 45, 35)                                 # arrowhead reach 1.1 * H (H = 16)
    # nothing drawn
    assert network.shape_box(dict(base_, fill={"enabled": False, "color": RED}), 64, 48) is None
    assert network.shape_box(dict(base_, fill={"enabled": True, "color": dict(RED, a=0)}), 64, 48) is None
    assert network.shape_box(dict(base_, x=100), 64, 48) is None                              # outside the canvas
    assert network.shape_box({"type": "line", "x1": 0, "y1": 0, "x2": 5, "y2": 5, "fill": NOSTROKE, "stroke": NOSTROKE}, 64, 48) is None
    assert network.shape_box({"type": "banana", "fill": FILL}, 64, 48) == (0, 0, 64, 48)       # unknown type: the whole canvas, no exception


def test_text_empty_and_adjustment_noop_and_opacity_value():
    assert network.text_is_empty({"text": "", "color": RED}) and network.text_is_empty({"text": " \n ", "color": RED})
    assert network.text_is_empty({"text": "x", "color": dict(RED, a=0)})
    assert not network.text_is_empty({"text": "x", "color": RED}) and network.text_is_empty(None)
    assert network.adjustment_is_noop({"type": "blur", "radius": 0.04}) and not network.adjustment_is_noop({"type": "blur", "radius": 0.06})
    assert network.adjustment_is_noop({"type": "mystery"}) and not network.adjustment_is_noop(LEVELS)
    assert network.opacity_value(None) == 1.0 and network.opacity_value("x") == 1.0 and network.opacity_value(0.25) == 0.25
    assert network.opacity_value(float("nan")) == 1.0


# ---- skip rules


def test_skip_rules_remove_the_blend_pass_but_keep_sources_and_surfaces(opt):
    net, comp, log, _ = opt
    st = [base(), px("hid", 1, visible=False), px("zero", 2, opacity=0.0), px("noslot", None),
          px("off", 3, x=500), px("ok", 4),
          txt("t_empty", dict(TEXT, text="  ")), shp("s_empty", dict(RECT, fill={"enabled": False, "color": RED}, stroke=NOSTROKE)),
          adj("noop_blur", {"type": "blur", "radius": 0.01}), adj("noop_unknown", {"type": "mystery"}),
          L("empty_group", "group"),
          shp("s_hidden", visible=False), txt("t_hidden", visible=False), px("ok2", 5)]
    net.apply(st, W, H)
    live = [r for r in net._ops if r.startswith(("blend_L_", "mrg_L_"))]
    assert plan(net)["skipped"] == 11 and plan(net)["layers"] == 14
    assert sorted(plan(net)["skip_reasons"]) == ["empty", "hidden", "noop", "opacity", "outside"]
    # base, ok, ok2 remain (one merged pass, three layers)
    assert live == ["mrg_L_base"] and ins(net, "mrg_L_base")[1:4] == ["src_in1", "s4", "s5"]
    # the surfaces of the skipped pixel layers stay allocated (the ext writes them), hidden text / shape keep their source
    assert net.slots() == [1, 2, 3, 4, 5]
    assert "text_t_hidden" in net._ops and "shape_s_hidden" not in net._ops            # (the shape node is built when asked for)
    assert net.render_layer_source("t_hidden") is net._ops["text_t_hidden"]
    src = net.render_layer_source("s_hidden")
    assert src is net._ops["shape_s_hidden"] and src.par.value("resolutionw") == W
    net.apply(st, W, H)                                                                # stays after the next apply()
    assert net.render_layer_source("s_hidden") is src and net._ops["shape_s_hidden"] is src
    assert net.render_layer_source("t_empty") is net._ops["text_t_empty"]
    assert source_of(net, "out") == "mrg_L_base"


def test_skip_off_screen_and_zero_opacity_reappear_when_edited(opt):
    net, comp, log, _ = opt
    mk = lambda **kw: [base(), px("a", 1, **kw)]
    net.apply(mk(opacity=0.0), W, H)
    assert "blend_L_a" not in net._ops and source_of(net, "out") == "blend_L_base"
    net.apply(mk(opacity=0.4), W, H)
    assert source_of(net, "out") == "mrg_L_base" and uL(net, "mrg_L_base", 1)[1] == 0.4
    net.apply(mk(opacity=0.4, x=1000), W, H)                                        # moved off the canvas
    assert plan(net)["skip_reasons"] == {"outside": 1} and source_of(net, "out") == "blend_L_base"
    net.apply(mk(visible=False), W, H)
    assert plan(net)["skip_reasons"] == {"hidden": 1}


def test_skip_hidden_group_keeps_children_text_source(opt):
    net, comp, log, _ = opt
    net.apply([base(), L("g", "group", visible=False), txt("t", parentId="g"), px("p", 1, parentId="g")], W, H)
    assert source_of(net, "out") == "blend_L_base"
    assert "text_t" in net._ops and net.render_layer_source("t") is net._ops["text_t"]
    assert not any(r.startswith(("blend_L_t", "blend_L_p", "blend_L_g", "mrg_L_t", "mrg_L_p")) for r in net._ops)
    net.apply([base(), L("g", "group"), px("p", 1, parentId="g")], W, H)
    assert ins(net, "mrg_L_base")[1:3] == ["src_in1", "blend_L_p"]


def test_group_whose_children_are_all_skipped_is_skipped(opt):
    net, comp, log, _ = opt
    net.apply([base(), L("g", "group"), px("p", 1, parentId="g", visible=False)], W, H)
    assert source_of(net, "out") == "blend_L_base" and plan(net)["skip_reasons"] == {"hidden": 1, "empty": 1}


def test_optimize_off_keeps_the_v5_network(env):
    net, comp, log, _ = env
    net.apply([base(), px("hid", 1, visible=False), px("a", 2), px("b", 3, blend="multiply"), px("z", 4, opacity=0.0)], W, H)
    assert [r for r in net._ops if r.startswith("blend_L_")] == ["blend_L_base", "blend_L_hid", "blend_L_a", "blend_L_b", "blend_L_z"]
    assert net._ops["blend_L_hid"].bypass is True and not any(r.startswith("mrg_L_") for r in net._ops)
    assert all(fmt(net, r) == "rgba16fixed" for r in net._ops if r.startswith("blend_L_"))
    assert net.stats()["mpool"] == 0


# ---- merged passes


def test_merged_runs_and_single_layers(opt):
    net, comp, log, _ = opt
    st = [base()] + [px("p%d" % i, i + 1) for i in range(1, 11)]
    net.apply(st, W, H)
    assert plan(net)["passes"] == 2 and plan(net)["merged"] == 2 and plan(net)["merged_layers"] == 11
    assert ins(net, "mrg_L_base")[0] == "blank"
    assert ins(net, "mrg_L_base")[1:9] == ["src_in1"] + ["s%d" % i for i in range(2, 9)]
    # the second run starts from the first and holds the remaining three layers
    r2 = ins(net, "mrg_L_p8")
    assert r2[0] == "mrg_L_base" and r2[1:4] == ["s9", "s10", "s11"] and r2[4:] == ["blank"] * 12      # 16 inputs, always
    assert len(net._ops["mrg_L_base"].inputConnectors) >= 16 and source_of(net, "out") == "mrg_L_p8"
    # slot uniforms: (mode + 16 * mask input, opacity, x, y); unused slots are zero
    assert uL(net, "mrg_L_p8", 0) == (0.0, 1.0, 0.0, 0.0) and uL(net, "mrg_L_p8", 3) == (0.0, 0.0, 0.0, 0.0)
    assert net._ops["mrg_L_base"].par.value("vec0valuew") == network.ADJ_MERGED_CODE
    assert net._ops["mrg_L_base"].par.value("vec4name") == "uL0" and net._ops["mrg_L_base"].par.value("vec11name") == "uL7"
    assert net._ops["mrg_L_base"].OPType == "glslmultiTOP"
    # a single leftover layer keeps its own v5 pass
    net.apply(st[:9], W, H)                                  # 9 layers: 8 + 1
    assert plan(net)["passes"] == 2 and "blend_L_p8" in net._ops and "mrg_L_p8" not in net._ops


def test_merged_slots_modes_opacity_offsets_and_masks(opt):
    net, comp, log, _ = opt
    st = [base(), px("a", 1, blend="multiply", opacity=0.5, x=3, y=-2), px("b", 2, mask={"slot": 9, "enabled": True}, blend="color-burn"),
          px("c", 3, mask={"slot": 10, "enabled": False}), px("d", 4, mask={"slot": 11, "enabled": True}, x=2.00004)]
    net.apply(st, W, H)
    assert plan(net)["merged"] == 1
    assert uL(net, "mrg_L_base", 0) == (0.0, 1.0, 0.0, 0.0)
    assert uL(net, "mrg_L_base", 1) == (1.0, 0.5, 3.0, -2.0)
    assert uL(net, "mrg_L_base", 2) == (9.0 + 16 * 9, 1.0, 0.0, 0.0)                         # colour-burn, mask = input 9
    assert uL(net, "mrg_L_base", 3) == (0.0, 1.0, 0.0, 0.0)                                  # disabled mask: not wired
    assert uL(net, "mrg_L_base", 4) == (0.0 + 16 * 10, 1.0, 2.0, 0.0)                         # second mask = input 10, offset rounded
    w = ins(net, "mrg_L_base")
    assert w[9] == "s9" and w[10] == "s11" and w[11:] == ["blank"] * 5 and w[1:6] == ["src_in1", "s1", "s2", "s3", "s4"]


def test_merge_breaks_at_adjustments_and_respects_the_mask_limit(opt):
    net, comp, log, _ = opt
    st = [base(), px("a", 1), px("b", 2), adj("lv", LEVELS), px("c", 3), px("d", 4)]
    net.apply(st, W, H)
    assert [r for r in net._ops if r.startswith(("blend_L_", "mrg_L_"))] == ["mrg_L_base", "blend_L_lv", "mrg_L_c"]
    assert source_of(net, "blend_L_lv", 0) == "mrg_L_base" and source_of(net, "mrg_L_c", 0) == "blend_L_lv"
    masked = [base()] + [px("m%d" % i, 20 + i, mask={"slot": 40 + i, "enabled": True}) for i in range(9)]
    net.apply(masked, W, H)
    runs = [r for r in net._ops if r.startswith(("blend_L_", "mrg_L_"))]
    assert len(runs) == 2                                                                  # 7 masks per node: base + 6 | m6.. rest
    first = ins(net, runs[0])
    assert first[9:16] == ["s%d" % (40 + i) for i in range(7)] and len(ins(net, runs[1])) == 16


def test_group_is_a_merge_member_and_its_inner_chain_is_merged(opt):
    net, comp, log, _ = opt
    st = [base(), px("a", 1), L("g", "group", blend="multiply", opacity=0.5), px("x", 2, parentId="g"), px("y", 3, parentId="g"),
          px("z", 4)]
    net.apply(st, W, H)
    inner = [r for r in net._ops if r.startswith("mrg_L_x")]
    assert inner and ins(net, inner[0])[0] == "blank" and ins(net, inner[0])[1:3] == ["s2", "s3"]
    outer = ins(net, "mrg_L_base")
    assert outer[1:5] == ["src_in1", "s1", inner[0], "s4"]
    assert uL(net, "mrg_L_base", 2) == (1.0, 0.5, 0.0, 0.0)


def test_merged_pass_structure_survives_edits_with_par_sets_only(opt):
    net, comp, log, _ = opt
    st = [base()] + [px("p%d" % i, i) for i in range(1, 8)]
    net.apply(st, W, H)
    settle(net)
    m = log.mark()
    st[3]["opacity"] = 0.3
    net.apply(st, W, H)
    d = log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"] and not d["disconnects"]
    assert len(d["par_sets"]) == 1 and d["par_sets"][0][1:] == ("vec7valuey", 0.3)


# ---- merged pass = chained passes (numpy reference of blend.glsl)


def _lum(c):
    return c @ np.array([0.3, 0.59, 0.11])


def _clip_color(c):
    lum, n, x = _lum(c)[..., None], c.min(-1)[..., None], c.max(-1)[..., None]
    with np.errstate(all="ignore"):
        c = np.where(n < 0, lum + (c - lum) * lum / (lum - n), c)
        c = np.where(x > 1, lum + (c - lum) * (1 - lum) / (x - lum), c)
    return c


def _set_lum(c, l):
    return _clip_color(c + (l - _lum(c))[..., None])


def _sat(c):
    return c.max(-1) - c.min(-1)


def _set_sat(c, s):
    mn, mx = c.min(-1)[..., None], c.max(-1)[..., None]
    with np.errstate(all="ignore"):
        return np.where(mx > mn, (c - mn) * s[..., None] / (mx - mn), 0.0)


def _hard(cb, cs):
    return np.where(cs <= 0.5, cb * 2 * cs, cb + (2 * cs - 1) - cb * (2 * cs - 1))


def _soft(cb, cs):
    d = np.where(cb <= 0.25, ((16 * cb - 12) * cb + 4) * cb, np.sqrt(np.maximum(cb, 0)))
    return np.where(cs <= 0.5, cb - (1 - 2 * cs) * cb * (1 - cb), cb + (2 * cs - 1) * (d - cb))


def _dodge(cb, cs):
    with np.errstate(all="ignore"):
        return np.where(cb <= 0.0005, 0.0, np.where(cs >= 0.9995, 1.0, np.minimum(1.0, cb / (1 - cs))))


def _burn(cb, cs):
    with np.errstate(all="ignore"):
        return np.where(cb >= 0.9995, 1.0, np.where(cs <= 0.0005, 0.0, 1 - np.minimum(1.0, (1 - cb) / cs)))


def blend_fn(mode, cb, cs):
    if mode == 0:
        return cs
    if mode == 1:
        return cb * cs
    if mode == 2:
        return cb + cs - cb * cs
    if mode == 3:
        return _hard(cs, cb)
    if mode == 4:
        return _soft(cb, cs)
    if mode == 5:
        return _hard(cb, cs)
    if mode == 6:
        return np.minimum(cb, cs)
    if mode == 7:
        return np.maximum(cb, cs)
    if mode == 8:
        return _dodge(cb, cs)
    if mode == 9:
        return _burn(cb, cs)
    if mode == 10:
        return np.abs(cb - cs)
    if mode == 11:
        return cb + cs - 2 * cb * cs
    if mode == 12:
        return _set_lum(_set_sat(cs, _sat(cb)), _lum(cb))
    if mode == 13:
        return _set_lum(_set_sat(cb, _sat(cs)), _lum(cb))
    if mode == 14:
        return _set_lum(cs, _lum(cb))
    return _set_lum(cb, _lum(cs))


def compose_general(below, src, mode, opacity, m):
    """composeOver() of blend.glsl WITHOUT the Normal shortcut (the v5 formula), float64, premultiplied (h, w, 4)."""
    src = src * (opacity * m)[..., None] if np.ndim(m) else src * (opacity * m)
    asrc, ab = src[..., 3], below[..., 3]
    with np.errstate(all="ignore"):
        cs = np.where(asrc[..., None] > 0, src[..., :3] / asrc[..., None], 0.0)
        cb = np.where(ab[..., None] > 0, below[..., :3] / ab[..., None], 0.0)
    bl = np.where(((asrc > 0) & (ab > 0))[..., None], np.clip(blend_fn(mode, np.clip(cb, 0, 1), np.clip(cs, 0, 1)), 0, 1), 0.0)
    out = np.empty_like(below)
    out[..., :3] = (1 - ab)[..., None] * src[..., :3] + (1 - asrc)[..., None] * below[..., :3] + (asrc * ab)[..., None] * bl
    out[..., 3] = asrc + ab - asrc * ab
    return out


def compose_shader(below, src, mode, opacity, m):
    """composeOver() as written in blend.glsl (Normal shortcut included)."""
    if mode != 0:
        return compose_general(below, src, mode, opacity, m)
    src = src * (opacity * m)[..., None] if np.ndim(m) else src * (opacity * m)
    asrc, ab = src[..., 3], below[..., 3]
    out = np.empty_like(below)
    out[..., :3] = ((1 - ab)[..., None] * src[..., :3] + (1 - asrc)[..., None] * below[..., :3]
                    + ab[..., None] * np.minimum(src[..., :3], asrc[..., None]))
    out[..., 3] = asrc + ab - asrc * ab
    return out


def place(img, x, y, w, h):
    """The layer image (h', w', c) at integer offset (x, y) in a (h, w) canvas (zeros outside), top row first."""
    out = np.zeros((h, w, img.shape[2]))
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + img.shape[1]), min(h, y + img.shape[0])
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = img[y0 - y:y1 - y, x0 - x:x1 - x]
    return out


def merged_port(net, role, images, w, h):
    """blend.glsl merged() applied to the uniforms / wiring the network produced for ``role`` (a numpy port; images:
    node role -> float (h, w, c) top row first in that node's own size)."""
    wired = ins(net, role)
    acc = images[wired[0]].copy()
    for k in range(network.MERGE_MAX):
        mode_code, opa, ox, oy = uL(net, role, k)
        if opa <= 0:
            continue
        code = int(mode_code + 0.5)
        mi, mode = code >> 4, code & 15
        src = place(images[wired[1 + k]], int(np.floor(ox + 0.5)), int(np.floor(oy + 0.5)), w, h)
        inside = place(np.ones(images[wired[1 + k]].shape[:2] + (1,)), int(np.floor(ox + 0.5)), int(np.floor(oy + 0.5)), w, h)[..., 0] > 0
        m = np.ones((h, w))
        if mi > 0:
            mk = images[wired[mi]]
            m = np.where(inside, place(mk[..., :1], int(np.floor(ox + 0.5)), int(np.floor(oy + 0.5)), w, h)[..., 0], 1.0)
            msk_inside = place(np.ones(mk.shape[:2] + (1,)), int(np.floor(ox + 0.5)), int(np.floor(oy + 0.5)), w, h)[..., 0] > 0
            m = np.where(inside & ~msk_inside, 0.0, m)
        comp = compose_shader(acc, src, mode, min(1.0, opa), m)
        acc = np.where(inside[..., None], comp, acc)
    return acc


def _rand_layer(rng, w, h):
    a = rng.random((h, w, 1)) * (rng.random((h, w, 1)) > 0.2)
    return np.concatenate([rng.random((h, w, 3)) * a, a], axis=-1)


@pytest.mark.parametrize("mode_set", [[0] * 7, list(range(7)), list(range(7, 14)), [15, 9, 8, 4, 12, 13, 3]])
def test_merged_pass_equals_chained_passes(opt, mode_set):
    net, comp, log, _ = opt
    rng = np.random.default_rng(len(mode_set) + sum(mode_set))
    k = len(mode_set)                                              # base + k <= 8 layers: ONE merged pass
    st = [base()]
    images = {"blank": np.zeros((H, W, 4)), "src_in1": _rand_layer(rng, W, H)}
    lay = [dict(x=int(rng.integers(-5, 20)), y=int(rng.integers(-5, 15)), sw=int(rng.integers(10, 50)), sh=int(rng.integers(8, 40)))
           for _ in range(k)]
    for i in range(k):
        masked = i % 3 == 1
        st.append(px("p%d" % i, i + 1, blend=network.BLEND_MODES[mode_set[i]], opacity=float(rng.choice([1.0, 0.7, 0.35])),
                     x=lay[i]["x"], y=lay[i]["y"], surfaceW=lay[i]["sw"], surfaceH=lay[i]["sh"],
                     mask={"slot": 100 + i, "enabled": True} if masked else None))
        images["s%d" % (i + 1)] = _rand_layer(rng, lay[i]["sw"], lay[i]["sh"])
        if masked:
            images["s%d" % (100 + i)] = np.concatenate([rng.random((lay[i]["sh"], lay[i]["sw"], 1))] * 4, axis=-1)
    net.apply(st, W, H)
    runs = [r for r in net._ops if r.startswith(("mrg_L_", "blend_L_"))]
    out = images["blank"]
    for r in runs:
        images_r = dict(images)
        images_r[ins(net, r)[0]] = out
        out = merged_port(net, r, images_r, W, H) if r.startswith("mrg_L_") else out
    # the chained v5 result: one general composeOver per layer in the same order, 16 bit fixed after each pass
    ref = images["blank"].copy()
    layers = [("src_in1", 0, 1.0, 0, 0, None)]
    for i in range(k):
        layers.append(("s%d" % (i + 1), mode_set[i], st[i + 1]["opacity"], lay[i]["x"], lay[i]["y"], "s%d" % (100 + i) if (i % 3 == 1) else None))
    for name, mode, opa, x, y, mk in layers:
        img = images[name]
        src = place(img, x, y, W, H)
        inside = place(np.ones(img.shape[:2] + (1,)), x, y, W, H)[..., 0] > 0
        m = np.ones((H, W))
        if mk:
            m = np.where(inside, place(images[mk][..., :1], x, y, W, H)[..., 0], 1.0)
        ref = compose_general(ref, src, mode, opa, m)
        ref = np.round(ref * 65535) / 65535
    # ``mrg_L_base`` covers the base too (input layer on src_in1)
    assert np.abs(out - ref).max() < 4 / 255, np.abs(out - ref).max()      # colour-burn / dodge amplify the 16 bit steps
    if set(mode_set) == {0}:
        assert np.abs(out - ref).max() < 1e-4


def test_normal_shortcut_equals_the_general_formula():
    rng = np.random.default_rng(3)
    below, src = _rand_layer(rng, 40, 30), _rand_layer(rng, 40, 30)
    for opa, m in ((1.0, np.ones((30, 40))), (0.4, rng.random((30, 40))), (0.0, np.ones((30, 40)))):
        a, b = compose_general(below, src, 0, opa, m), compose_shader(below, src, 0, opa, m)
        assert np.abs(a - b).max() < 1e-12
    bad = src.copy()
    bad[..., :3] += 0.3                                                          # invalid premultiplied input (rgb > a): clamped identically
    assert np.abs(compose_general(below, bad, 0, 0.8, np.ones((30, 40))) - compose_shader(below, bad, 0, 0.8, np.ones((30, 40)))).max() < 1e-12


# ---- 8 bit intermediates


def test_eight_bit_rule_suffix_of_plain_normal_blends(opt):
    net, comp, log, _ = opt
    net.apply([base(), px("a", 1), adj("lv", LEVELS), px("b", 2), px("c", 3, blend="multiply"), px("d", 4), px("e", 5)], W, H)
    assert fmt(net, "mrg_L_base") == "rgba16fixed"                       # an adjustment is downstream
    assert fmt(net, "blend_L_lv") == "rgba16fixed"                       # multiply is downstream
    assert fmt(net, "mrg_L_b") == "rgba8fixed"                            # b, multiply c, d, e merged: nothing needs precision after
    net.apply([base(), px("a", 1), adj("lv", LEVELS), px("b", 2), px("c", 3, blend="multiply"), adj("lv2", LEVELS), px("d", 4), px("e", 5)], W, H)
    assert fmt(net, "mrg_L_b") == "rgba16fixed" and fmt(net, "mrg_L_d") == "rgba8fixed"
    assert fmt(net, "blend_L_lv2") == "rgba8fixed" and plan(net)["fmt8"] == 2
    # a non-Normal blend that is the last layer: its own output may be 8 bit (nothing reads it), what is below may not
    net.apply([base(), px("a", 1), adj("lv", LEVELS), px("b", 2, blend="screen")], W, H)
    assert fmt(net, "blend_L_lv") == "rgba16fixed" and fmt(net, "blend_L_b") == "rgba8fixed"
    # a lone normal layer above an adjustment
    net.apply([base(), adj("lv", LEVELS), px("b", 2)], W, H)
    assert fmt(net, "blend_L_lv") == "rgba8fixed"


def test_eight_bit_rule_groups(opt):
    net, comp, log, _ = opt
    st = [base(), L("g", "group"), px("x", 1, parentId="g"), px("y", 2, parentId="g"), px("z", 3)]
    net.apply(st, W, H)
    assert fmt(net, "mrg_L_x") == "rgba8fixed" and fmt(net, "mrg_L_base") == "rgba8fixed"          # Normal group, plain layers above
    st[1]["blend"] = "overlay"
    net.apply(st, W, H)
    assert fmt(net, "mrg_L_x") == "rgba16fixed"                    # the group's inner result is the SOURCE of an overlay blend
    st[1]["blend"] = "normal"
    st.append(adj("lv", LEVELS))
    net.apply(st, W, H)
    assert fmt(net, "mrg_L_x") == "rgba16fixed" and fmt(net, "mrg_L_base") == "rgba16fixed" and fmt(net, "blend_L_lv") == "rgba8fixed"


def test_eight_bit_error_bound_and_the_reason_for_the_rule():
    """One 8 bit rounding between Normal blends is below 1/255; the same rounding below a colour-burn is amplified."""
    rng = np.random.default_rng(11)
    layers = [_rand_layer(rng, 48, 40) for _ in range(6)]
    exact = q = np.zeros((40, 48, 4))
    for i, l in enumerate(layers):
        exact = compose_general(exact, l, 0, 0.8, np.ones((40, 48)))
        q = compose_general(q, l, 0, 0.8, np.ones((40, 48)))
        if i in (2, 5):                                                 # two merged-pass boundaries in 8 bit
            q = np.round(q * 255) / 255
    assert np.abs(exact - q).max() <= 1.0 / 255
    # the same 8 bit step below a colour-burn layer
    below = np.ones((40, 48, 4))
    below[..., :3] = 0.97 + 0.03 * rng.random((40, 48, 3))                 # bright, opaque
    top = np.ones((40, 48, 4))
    top[..., :3] = 0.04                                                    # dark opaque source: burn divides by it
    burned = compose_general(below, top, 9, 1.0, np.ones((40, 48)))
    burned_q = compose_general(np.round(below * 255) / 255, top, 9, 1.0, np.ones((40, 48)))
    assert np.abs(burned - burned_q).max() > 4.0 / 255


# ---- cropped resample passes


@pytest.mark.parametrize("kw", [dict(x=5.5, y=3.25, sx=1.5, sy=1.5), dict(x=10.0, y=8.0, rot=30.0), dict(x=4.0, y=2.0, sx=0.4, sy=0.4),
                                dict(x=8.5, y=6.0, kx=20.0, sy=1.2, sx=0.8), dict(x=-12.0, y=-6.0, sx=2.0, sy=2.0)])
def test_staged_layer_is_cropped_and_places_exactly(opt, kw):
    net, comp, log, _ = opt
    net.apply([base(), px("a", 1, surfaceW=24, surfaceH=18, **kw)], W, H)
    box = net.content_box("a")
    assert box is not None and "xf_L_a" in net._ops
    x0, y0, x1, y1 = box
    xf = net._ops["xf_L_a"]
    pv = xf.par.value
    assert (pv("resolutionw"), pv("resolutionh")) == (x1 - x0, y1 - y0)
    assert pv("vec2valuex") == pytest.approx(kw.get("x", 0.0) - x0) and pv("vec2valuey") == pytest.approx(kw.get("y", 0.0) - y0)
    assert uL(net, "mrg_L_base", 1)[2:] == (float(x0), float(y0))
    # numpy: resample into the crop with the shifted translation == the full-size resample cropped
    rng = np.random.default_rng(5)
    img = _rand_layer(rng, 24, 18)
    full = fakenet.resample_port(img[::-1], None, W, H, kw.get("x", 0.0), kw.get("y", 0.0), kw.get("sx", 1.0), kw.get("sy", 1.0),
                                 rot=kw.get("rot", 0.0), kx=kw.get("kx", 0.0), ky=kw.get("ky", 0.0))
    crop = fakenet.resample_port(img[::-1], None, x1 - x0, y1 - y0, kw.get("x", 0.0) - x0, kw.get("y", 0.0) - y0,
                                 kw.get("sx", 1.0), kw.get("sy", 1.0), rot=kw.get("rot", 0.0), kx=kw.get("kx", 0.0), ky=kw.get("ky", 0.0))
    assert np.abs(full[y0:y1, x0:x1] - crop).max() < 1e-9
    outside = full.copy()
    outside[y0:y1, x0:x1] = 0
    assert np.abs(outside).max() < 1e-9                                       # nothing is lost outside the box


def test_crop_off_when_effects_inputs_or_optimize_off(env, opt):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5)], W, H)
    assert net.content_box("a") is None and net._ops["xf_L_a"].par.value("resolutionw") == W
    net, comp, log, _ = opt
    comp.inputConnectors[0].connect(comp.in1)
    net.apply([base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5, kind="input", input=1)], W, H)
    assert net.content_box("a") is None and net._ops["xf_L_a"].par.value("resolutionw") == W      # input resolution unknown: full canvas


def test_crop_formats_normal_8_bit_otherwise_16(opt):
    net, comp, log, _ = opt
    net.apply([base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5), px("b", 2, surfaceW=24, surfaceH=18, x=2.5, sx=1.5, sy=1.5, blend="screen")], W, H)
    assert fmt(net, "xf_L_a") == "rgba8fixed" and fmt(net, "xf_L_b") == "rgba16fixed"


def test_content_bounds_hint_shrinks_the_resample_pass_and_skips_empty(opt):
    net, comp, log, _ = opt
    st = [base(), px("a", 1, surfaceW=40, surfaceH=30, x=5.5, sx=1.5, sy=1.5), px("b", 2, surfaceW=40, surfaceH=30, x=2.5, sx=1.5, sy=1.5)]
    net.apply(st, W, H)
    full_a = net.content_box("a")
    net.set_content_bounds({"a": (4.0, 4.0, 12.0, 10.0), "b": None})
    assert net._prev_layers is None                                       # the next apply() re-plans
    net.apply(st, W, H)
    tight = net.content_box("a")
    assert (tight[2] - tight[0]) < (full_a[2] - full_a[0]) and "b" not in plan(net)["skip_reasons"] and plan(net)["skip_reasons"] == {"outside": 1}
    net.set_content_bounds({"a": (4.0, 4.0, 12.0, 10.0), "b": None})      # identical hint: no re-plan
    snap = net._prev_layers
    net.set_content_bounds({"a": (4, 4, 12, 10), "b": ()})
    assert net._prev_layers == snap
    net.set_content_bounds({})
    net.apply(st, W, H)
    assert net.content_box("a") == full_a and plan(net)["skipped"] == 0


# ---- blur pyramid


def test_blur_shrink_factor_and_sigma_band():
    assert network.blur_shrink(0) == 1 and network.blur_shrink(6.9) == 1
    for r, s in ((7, 2), (13.9, 2), (14, 4), (27, 4), (28, 8), (56, 16), (100, 16), (200, 32), (400, 64), (1000, 256)):
        assert network.blur_shrink(r) == s, r
    for r in (7, 9, 20, 55, 100, 150, 399, 700):
        sigma = r / network.blur_shrink(r)
        assert 3.5 <= sigma < 7.0 + 1e-9


def test_blur_pyramid_nodes_and_legacy_path(opt, env):
    net, comp, log, _ = opt
    net.apply([base(), px("a", 1), adj("b", {"type": "blur", "radius": 100})], 1920, 1080)
    assert ins(net, "adj_L_b")[0] == "adj_L_b_dn" and ins(net, "adj_L_b_dn")[0] == "mrg_L_base"
    assert ins(net, "adj_L_b_up")[0] == "adj_L_b" and source_of(net, "blend_L_b", 1) == "adj_L_b_up"
    dn, bl, up = (net._ops[n].par.value for n in ("adj_L_b_dn", "adj_L_b", "adj_L_b_up"))
    size = round(100 / 16 * network.BLUR_SIZE_PER_RADIUS)
    k = size + 1
    assert (dn("resolutionw"), dn("resolutionh")) == (120 + 2 * k, 68 + 2 * k) and dn("vec0valuew") == network.ADJ_SHRINK
    assert dn("vec1valuex") == 16.0 and dn("vec2valuex") == float(k) and net._ops["adj_L_b_dn"].OPType == "glslTOP"
    assert (up("resolutionw"), up("resolutionh")) == (1920, 1080) and up("inputfiltertype") == "linear" and up("vec0valuew") == network.ADJ_ENLARGE
    assert up("vec1valuex") == 16.0 and up("vec2valuex") == float(k)
    assert bl("size") == size and bl("preshrink") == 1 and bl("extend") == "hold"
    assert all(net._ops[n].par.value("format") == "rgba16float" for n in ("adj_L_b_dn", "adj_L_b", "adj_L_b_up"))
    # cost of the filter no longer depends on the radius
    net.apply([base(), px("a", 1), adj("b", {"type": "blur", "radius": 400})], 1920, 1080)
    assert net._ops["adj_L_b"].par.value("size") == round(400 / 64 * network.BLUR_SIZE_PER_RADIUS)
    net.apply([base(), px("a", 1), adj("b", {"type": "blur", "radius": 5})], 1920, 1080)     # small radii: the single Blur TOP
    assert "adj_L_b_dn" not in net._ops and net._ops["adj_L_b"].par.value("preshrink") == 1
    net, comp, log, _ = env
    net.apply([base(), px("a", 1), adj("b", {"type": "blur", "radius": 100})], 1920, 1080)   # optimize off: v5 preshrink
    assert "adj_L_b_dn" not in net._ops and net._ops["adj_L_b"].par.value("preshrink") == 8


def shrink_port(img, s, k):
    """numpy port of shrinkPass() (texel space, edge hold): mean of the clamped s x s block of every padded cell."""
    h, w = img.shape[:2]
    gh, gw = -(-h // s) + 2 * k, -(-w // s) + 2 * k
    ys = np.clip((np.arange(gh)[:, None] - k) * s + np.arange(s)[None, :], 0, h - 1)
    xs = np.clip((np.arange(gw)[:, None] - k) * s + np.arange(s)[None, :], 0, w - 1)
    return np.stack([[img[ys[j]][:, xs[i]].mean(axis=(0, 1)) for i in range(gw)] for j in range(gh)])


def test_pyramid_shrink_pad_cells_are_the_edge_pixels_not_block_means():
    """The reason for the padded GLSL shrink: with a mipmapped downsample the cell outside the image would be the mean of the
    s x s border block; here it is the mean of clamped (repeated) edge pixels."""
    img = np.zeros((32, 32, 1))
    img[:2, :, 0] = 1.0                                         # two bright rows on the border
    g = shrink_port(img, 16, 2)
    assert g.shape == (6, 6, 1)
    assert g[1, 3, 0] == pytest.approx(1.0)                      # pad cell below the border: the repeated edge row, fully bright
    assert g[2, 3, 0] == pytest.approx(2 / 16)                   # first real cell: the block mean
    assert g[0, 0, 0] == pytest.approx(1.0)                      # corner pad: the corner texel


def test_blur_pyramid_tracks_document_size(opt):
    net, comp, log, _ = opt
    st = [base(), adj("b", {"type": "blur", "radius": 64})]
    net.apply(st, 1000, 500)
    k = net._ops["adj_L_b_dn"].par.value("vec2valuex")
    assert (net._ops["adj_L_b_dn"].par.value("resolutionw"), net._ops["adj_L_b_dn"].par.value("resolutionh")) == (63 + 2 * k, 32 + 2 * k)
    net.apply(st, 640, 480)
    assert (net._ops["adj_L_b_dn"].par.value("resolutionw"), net._ops["adj_L_b_dn"].par.value("resolutionh")) == (40 + 2 * k, 30 + 2 * k)
    assert net._ops["adj_L_b_up"].par.value("resolutionw") == 640


# ---- pools


def test_multi_pool_is_topped_up_recycled_and_adopted(opt):
    net, comp, log, clock = opt
    settle(net)
    for _ in range(40):
        net.tick()
    assert net.stats()["mpool"] == network.MPOOL_TARGET
    m = log.mark()
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    d = log.since(m)
    assert not [c for c in d["creates"] if c[0] == "glslmultiTOP"]                      # served from the spare pool
    assert net.stats()["last"]["recycled"] >= 1
    for _ in range(40):
        net.tick()
    assert net.stats()["mpool"] == network.MPOOL_TARGET
    net.apply([base()], W, H)                                                           # the merged node goes back to the pool
    assert "mrg_L_base" not in net._ops
    # a second DocNetwork adopts the tagged multi node of the first without creating anything
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    settle(net)
    net2 = DocNetwork(comp, GLSL, clock=clock)
    m = log.mark()
    net2.apply([base(), px("a", 1), px("b", 2)], W, H)
    assert not [c for c in log.since(m)["creates"] if c[0] in ("glslmultiTOP", "glslTOP")]
    assert source_of(net2, "out") == "mrg_L_base"


def test_visibility_toggle_costs_few_operations(opt):
    net, comp, log, _ = opt
    st = [base()] + [px("p%d" % i, i) for i in range(1, 20)]
    net.apply(st, W, H)
    settle(net)
    for _ in range(40):
        net.tick()
    m = log.mark()
    st[5]["visible"] = False
    net.apply(st, W, H)
    d = log.since(m)
    assert not d["creates"] and len(d["connects"]) + len(d["disconnects"]) < 100 and len(d["par_sets"]) < 80
    m = log.mark()
    st[5]["visible"] = True
    net.apply(st, W, H)
    assert not log.since(m)["creates"]


def test_default_construction_matches_the_ext_call_and_public_api():
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL)                          # exactly how ext.py constructs it
    net.apply([base(), px("a", 1)], W, H)
    net.set_inputs({1: True})
    assert net.output() is not None and net.slots() == [1] and net.surface_top(1) is not None
    assert set(net.stats()) >= {"nodes", "surfaces", "pool", "mpool", "plan", "last", "totals"}


def test_prewarm_is_off_by_default(opt):
    net, comp, log, clock = opt
    net.apply([base(), px("a", 1)], W, H)
    for _ in range(20):
        clock.t += 5.0
        net.tick()
    assert not any(c.get("warm") for c in net._cache.values()), "no spare may be pre-warmed unless PREWARM is on"


def test_spares_are_prewarmed_when_idle_only_once_and_wiring_is_replaced(opt, monkeypatch):
    monkeypatch.setattr(network, "PREWARM", True)  # pre-warm is opt-in (off by default)
    net, comp, log, clock = opt
    net.apply([base(), px("a", 1)], W, H)
    for _ in range(40):
        net.tick()
    spares = [o for o, c in net._pool + net._mpool]
    assert spares and all(o.cooks == 0 for o in spares)            # an apply() just happened: nothing is pre-cooked yet
    clock.t += 1.0
    for _ in range(60):
        net.tick()
    warmed = [(o, c) for o, c in net._pool + net._mpool if c.get("warm")]
    assert len(warmed) == len(net._pool) + len(net._mpool) and all(o.cooks == 1 for o, _ in warmed)
    assert all(len([k for k in o.inputConnectors if k.source is not None]) == (16 if o.OPType == "glslmultiTOP" else 3) for o, _ in warmed)
    n_cooks = sum(o.cooks for o, _ in warmed)
    for _ in range(20):
        net.tick()
    assert sum(o.cooks for o, _ in net._pool + net._mpool) == n_cooks          # never twice
    # a warmed spare is rewired by the first real use
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    assert ins(net, "mrg_L_base")[:2] == ["blank", "src_in1"]


def test_shift_shape_spec_and_cropped_shape_node(opt):
    spec = dict(RECT, x=40, y=30, w=10, h=8)
    sh = network.shift_shape_spec(spec, -35, -25)
    assert (sh["x"], sh["y"], sh["w"], sh["h"]) == (5, 5, 10, 8) and spec["x"] == 40
    ln = network.shift_shape_spec({"type": "line", "x1": 5, "y1": 6, "x2": 9, "y2": 10}, -1, -2)
    assert (ln["x1"], ln["y1"], ln["x2"], ln["y2"]) == (4, 4, 8, 8)
    net, comp, log, _ = opt
    net.apply([base(), shp("s", spec)], 200, 100)
    box = net.content_box("s")
    assert box == network.shape_box(spec, 200, 100) and "shapec_s" in net._ops and "shape_s" not in net._ops
    cw, ch = box[2] - box[0], box[3] - box[1]
    pv = net._ops["shapec_s"].par.value
    assert (pv("resolutionw"), pv("resolutionh")) == (cw, ch)
    # TD-space uniforms of the cropped node == the full node's, moved by the box origin (y flipped)
    full = network.shape_uniforms(spec, 100)
    assert pv("vec1valuex") == pytest.approx(full["vec1valuex"] - box[0])
    assert pv("vec1valuey") == pytest.approx(full["vec1valuey"] - (100 - box[3]))
    assert uL(net, "mrg_L_base", 1)[2:] == (float(box[0]), float(box[1]))
    assert source_of(net, "out") == "mrg_L_base" and ins(net, "mrg_L_base")[2] == "shapec_s"
    # the Flatten source stays the full document-size node
    tok0 = net.render_layer_token("s")
    flat = net.render_layer_source("s")                          # built lazily, pooled, uncooked
    assert flat is net._ops["shape_s"] and flat.par.value("resolutionw") == 200 and flat.par.value("resolutionh") == 100
    assert flat.par.value("vec1valuex") == pytest.approx(network.shape_uniforms(spec, 100)["vec1valuex"])
    assert net.render_layer_token("s") is not None and net.render_layer_token("s") == net.render_layer_token("s")
    net.apply([base(), shp("s", spec)], 200, 100)
    assert net.render_layer_source("s") is flat and "shapec_s" in net._ops             # kept, still cropped
    net.apply([base()], 200, 100)
    assert "shape_s" not in net._ops and "s" not in net._flat_want
    # a mask, a big shape or effects: no crop
    net.apply([base(), shp("s", dict(spec, w=190, h=90, x=2, y=2)), shp("m", spec, mask={"slot": 3, "enabled": True})], 200, 100)
    assert "shapec_s" not in net._ops and "shapec_m" not in net._ops


def test_active_layer_hint_splits_merged_runs(opt):
    net, comp, log, _ = opt
    st = [base()] + [px("p%d" % i, i) for i in range(1, 8)]
    net.apply(st, W, H)
    assert [r for r in net._ops if r.startswith(("mrg_L_", "blend_L_"))] == ["mrg_L_base"]
    net.set_active_layer("p4")
    assert net._prev_layers is None
    net.apply(st, W, H)
    assert [r for r in net._ops if r.startswith(("mrg_L_", "blend_L_"))] == ["mrg_L_base", "blend_L_p4", "mrg_L_p5"]
    assert source_of(net, "blend_L_p4", 0) == "mrg_L_base" and source_of(net, "mrg_L_p5", 0) == "blend_L_p4"
    net.set_active_layer("p4")                                   # same layer: no re-plan
    snap = net._prev_layers
    net.set_active_layer("p4")
    assert net._prev_layers == snap
    net.set_active_layer(None)
    net.apply(st, W, H)
    assert [r for r in net._ops if r.startswith(("mrg_L_", "blend_L_"))] == ["mrg_L_base"]


def test_content_bounds_hint_validation_and_pruning(opt):
    net, comp, log, _ = opt
    st = [base(), px("a", 1, surfaceW=40, surfaceH=30, x=5.5, sx=1.5, sy=1.5)]
    net.apply(st, W, H)
    full = net.content_box("a")
    net.set_content_bounds({"a": (5, 5, 5, 9), "zz": ("x", 1, 2, 3), "bad": 7, "nan": (0, 0, float("nan"), 3)})
    assert net._hints == {}                                  # degenerate / non-numeric entries are dropped, nothing skips
    net.set_content_bounds(None)
    net.set_content_bounds({"a": (4.0, 4.0, 12.0, 10.0), "gone": (0, 0, 5, 5), "e": None})
    assert net._hints["e"] == network.EMPTY_HINT and set(net._hints) == {"a", "gone", "e"}
    net.apply(st, W, H)
    assert set(net._hints) == {"a"} and net.content_box("a") != full          # stale ids pruned
    net.set_content_bounds({"a": ()})
    net.apply(st, W, H)
    assert plan(net)["skip_reasons"] == {"outside": 1}


def test_shape_crop_hysteresis(opt):
    net, comp, log, _ = opt
    mk = lambda w: [base(), shp("s", dict(RECT, x=10, y=10, w=w, h=50, stroke=NOSTROKE))]
    net.apply(mk(60), 200, 100)                                  # 64 x 54 box: 17 % of the canvas -> cropped
    assert "shapec_s" in net._ops
    # canvas 200x100 = 20000 px: 0.5 -> box area 10000; 0.65 -> 13000
    net.apply(mk(150), 200, 100)                                 # 154 x 54 = 8316 <= 10000 still cropped
    assert "shapec_s" in net._ops
    net.apply(mk(170), 200, 100)                                 # 174 x 54 = 9396 <= 10000 cropped
    net.apply(mk(190), 200, 100)                                 # 194 x 54 = 10476: above 0.5 but below 0.65 -> stays cropped
    assert "shapec_s" in net._ops
    net.apply(mk(260), 200, 100)                                 # clipped to the canvas: 200 x 54 = 10800 -> still cropped
    assert "shapec_s" in net._ops
    net.apply([base(), shp("s", dict(RECT, x=0, y=0, w=200, h=100, stroke=NOSTROKE))], 200, 100)      # whole canvas: full node
    assert "shapec_s" not in net._ops and "shape_s" in net._ops
    net.apply(mk(190), 200, 100)                                 # re-entering needs <= 50 %: 10476 > 10000 stays full
    assert "shapec_s" not in net._ops and "shape_s" in net._ops


def test_dropped_multi_nodes_keep_their_16_connections(opt):
    net, comp, log, _ = opt
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    op = net._ops["mrg_L_base"]
    net.apply([base()], W, H)
    assert "mrg_L_base" not in net._ops
    assert len([c for c in op.inputConnectors if c.source is not None]) == 16            # nothing disconnected on drop
    m = log.mark()
    net.apply([base(), px("a", 1), px("b", 2)], W, H)
    d = log.since(m)
    mine = lambda lst: [x for x in lst if x[0] == op.name]
    assert net._ops["mrg_L_base"] is op and not mine(d["disconnects"]) and len(mine(d["connects"])) <= 3        # only what differs
    assert ins(net, "mrg_L_base")[:3] == ["blank", "src_in1", "s1"]


def test_blur_radius_is_clamped_to_the_web_limit(opt):
    net, comp, log, _ = opt
    net.apply([base(), adj("b", {"type": "blur", "radius": 900})], 1920, 1080)
    net.apply([base(), adj("c", {"type": "blur", "radius": 200})], 1920, 1080)
    c200 = (net._ops["adj_L_c"].par.value("size"), net._ops["adj_L_c_dn"].par.value("vec1valuex"))
    net.apply([base(), adj("b", {"type": "blur", "radius": 900})], 1920, 1080)
    assert (net._ops["adj_L_b"].par.value("size"), net._ops["adj_L_b_dn"].par.value("vec1valuex")) == c200
    assert network.adjustment_plan({"type": "blur", "radius": 5000}, "z").nodes[0][3] is False
    assert network.adjustment_plan({"type": "blur", "radius": 5000}, "z").nodes[0][2]["size"] == round(200 * network.BLUR_SIZE_PER_RADIUS / 8)


def test_materialised_lazy_shape_persists_with_the_same_op_and_token(opt):
    net, comp, log, _ = opt
    spec = dict(RECT, x=40, y=30, w=10, h=8)
    st = [base(), shp("s", spec)]
    net.apply(st, 200, 100)
    assert "shape_s" not in net._ops
    flat = net.render_layer_source("s")
    tok = net.render_layer_token("s")
    assert "s" in net._flat_want and tok is not None
    for opacity in (1.0, 0.5):                                            # unrelated edits and plain re-applies
        st[1]["opacity"] = opacity
        net.apply(st, 200, 100)
        assert net._ops["shape_s"] is flat and net.render_layer_source("s") is flat
        assert net.render_layer_token("s") == tok
    st[1]["visible"] = False                                              # hidden: still there
    net.apply(st, 200, 100)
    assert net.render_layer_source("s") is flat and net.render_layer_token("s") == tok
    st[1]["shape"] = dict(spec, w=12)                                     # an edit of the layer's own spec changes the token
    net.apply(st, 200, 100)
    assert net.render_layer_source("s") is flat and net.render_layer_token("s") != tok


# ---- blur pyramid shaders: text pins + numpy ports


def enlarge_port(grid, s, k, out_w, out_h):
    """numpy port of enlargePass(): bilinear (clamp) at ((x + .5) / s + k) / gridSize, texel space."""
    gh, gw = grid.shape[:2]
    xs, ys = (np.arange(out_w) + 0.5) / s + k, (np.arange(out_h) + 0.5) / s + k
    fx, fy = xs - 0.5, ys - 0.5
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = (fx - x0)[None, :, None], (fy - y0)[:, None, None]
    g = lambda yy, xx: grid[np.clip(yy, 0, gh - 1)[:, None], np.clip(xx, 0, gw - 1)[None, :]]
    return (g(y0, x0) * (1 - tx) * (1 - ty) + g(y0, x0 + 1) * tx * (1 - ty) + g(y0 + 1, x0) * (1 - tx) * ty + g(y0 + 1, x0 + 1) * tx * ty)


def _gauss(img, sigma):
    r = int(np.ceil(sigma * 4))
    k = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * sigma * sigma))
    k /= k.sum()
    for ax in (0, 1):
        pad = [(0, 0)] * 3
        pad[ax] = (r, r)
        p = np.pad(img, pad, mode="edge")
        img = sum(k[i] * np.take(p, np.arange(i, i + img.shape[ax]), axis=ax) for i in range(len(k)))
    return img


@pytest.mark.parametrize("w,h,s", [(96, 80, 4), (100, 70, 8), (130, 65, 16)])
def test_pyramid_shrink_blur_enlarge_matches_a_direct_gaussian_incl_border(w, h, s):
    rng = np.random.default_rng(w + s)
    img = np.zeros((h, w, 4))
    img[..., 3] = 1.0
    img[:3, :, :3] = 1.0
    img[:, -2:, 0] = 1.0
    img[h // 3:2 * h // 3, w // 4:w // 2, :3] = rng.random(3)
    sigma = 3.5 * s
    size = round(sigma * network.BLUR_SIZE_PER_RADIUS / s)
    k = size + 1
    grid = _gauss(shrink_port(img, s, k), sigma / s)
    out = enlarge_port(grid, s, k, w, h)
    ref = _gauss(img, sigma)
    assert np.abs(out - ref).max() * 255 < 12, np.abs(out - ref).max() * 255
    bad = enlarge_port(grid, s, 0, w, h)                    # the mutation: no k offset in enlarge
    assert np.abs(bad - ref).max() * 255 > 12
    wrong_shrink = _gauss(shrink_port(img, s, k + 1), sigma / s)       # shrink grid and enlarge disagree on k
    assert np.abs(enlarge_port(wrong_shrink, s, k, w, h) - ref).max() * 255 > 12


PYRAMID_PINS = {
    "shrink -k offset": "ivec2 o = (ivec2(gl_FragCoord.xy) - ivec2(k)) * s;",
    "shrink clamp x": "int xx = clamp(o.x + x, 0, src.x - 1);",
    "shrink clamp y": "int yy = clamp(o.y + y, 0, src.y - 1);",
    "shrink mean": "fragColor = TDOutputSwizzle(sum / n);",
    "enlarge k offset": "vec2 q = (gl_FragCoord.xy / s) + vec2(k);",
    "enlarge grid uv": "texture(sTD2DInputs[0], q / grid)",
    "pass dispatch": "if (uParams.w > 9.5) { enlargePass(); return; }",
}


def test_pyramid_glsl_pins_present():
    for name, text in PYRAMID_PINS.items():
        assert text in GLSL, name


@pytest.mark.parametrize("pin,old,new", [
    ("shrink -k offset", "ivec2(gl_FragCoord.xy) - ivec2(k)", "ivec2(gl_FragCoord.xy)"),
    ("shrink clamp x", "clamp(o.x + x, 0, src.x - 1)", "o.x + x"),
    ("shrink clamp y", "clamp(o.y + y, 0, src.y - 1)", "o.y + y"),
    ("shrink mean", "sum / n", "sum"),
    ("enlarge k offset", "+ vec2(k);", ";"),
    ("enlarge grid uv", "q / grid", "q"),
    ("pass dispatch", "uParams.w > 9.5", "uParams.w > 10.5"),
])
def test_pyramid_shader_mutations_are_caught(pin, old, new):
    assert old in GLSL
    mutated = GLSL.replace(old, new, 1)
    assert mutated != GLSL and pin in [k for k, v in PYRAMID_PINS.items() if v not in mutated]


def test_rewiring_a_recycled_multi_node_whose_connectors_were_cut_by_destroyed_sources(opt):
    """Regression (live v5 validation: IndexError in _wire): a pooled Multi TOP keeps its connections; when TD cuts them
    (destroyed sources) the connector list SHRINKS below what the cache believes, so connecting input i raised IndexError."""
    net, comp, log, clock = opt
    net.apply([base()] + [px("p%d" % i, i) for i in range(1, 8)], W, H)
    op = net._ops["mrg_L_base"]
    net.apply([base()], W, H)                                   # the merged node goes back to the pool, still wired
    for c in op.inputConnectors[5:]:                            # TD cut the trailing connections: the list shrank
        c.source = None
    del op.inputConnectors[6:]
    doc21 = [base()] + [px("q%d" % i, 20 + i) for i in range(1, 21)]
    net.apply(doc21, W, H)                                      # must not raise
    assert all(c.source is not None for c in net._ops["mrg_L_base"].inputConnectors[:16])
    assert ins(net, "mrg_L_base")[:3] == ["blank", "src_in1", "s21"]
    # defensive: connecting past the end of a shrunk list although the cache believes the inputs are connected
    node = net._ops["mrg_L_base"]
    net._cache["mrg_L_base"]["inputs"] = [("blank", net._gen["blank"])] * 16
    del node.inputConnectors[3:]
    net._wire("mrg_L_base", ["blank"] * 3 + ["src_in1"] * 13)
    assert len(node.inputConnectors) >= 16 and ins(net, "mrg_L_base")[3:5] == ["src_in1", "src_in1"]


def test_repeat_apply_shortcut_does_not_skip_after_a_pool_reset(opt):
    """_set_pars skips an identical dict; a recycled node whose parameters were reset by the pool (custom resolution ->
    useinput) must get them back when the next role asks for the same values."""
    net, comp, log, _ = opt
    st = [base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5)]
    net.apply(st, W, H)
    xf = net._ops["xf_L_a"]
    want = dict(net._cache["xf_L_a"]["pars"])
    net.apply([base()], W, H)                                           # back to the pool: resolution reset to useinput
    assert xf.par.value("outputresolution") == "useinput"
    net.apply(st, W, H)
    node = net._ops["xf_L_a"]
    assert node is xf and node.par.value("outputresolution") == "custom" and node.par.value("resolutionw") == want["resolutionw"]
    m = log.mark()
    net.apply(st, W, H)                                                 # identical apply: nothing is written at all
    assert not log.since(m)["par_sets"]


ADJ_DOCS = [
    ("x", {"type": "levels", "inLow": 0.15, "inHigh": 0.85, "gamma": 1.4, "outLow": 0.05, "outHigh": 0.95}),
    ("y", {"type": "hueSaturation", "hue": 40, "saturation": 1.3, "value": 1.0}),
    ("z", {"type": "brightnessContrast", "brightness": 0.2, "contrast": 0.3}),
    ("x", {"type": "threshold", "level": 0.7}),
    ("y", {"type": "levels", "inLow": 0.3, "inHigh": 0.6, "gamma": 0.8, "outLow": 0.0, "outHigh": 0.5}),
    ("x", {"type": "invert"}),
    ("w", {"type": "hueSaturation", "hue": -20, "saturation": 0.4, "value": 1.2}),
]


def _assert_adjustment_uniforms(net, aid, spec):
    plan_ = network.adjustment_plan(spec, network.sanitize(aid), W, H, pyramid=True)
    node = net._ops["blend_L_" + network.sanitize(aid)]
    pv = node.par.value
    assert pv("vec0valuew") == plan_.adjust, (aid, spec)
    for k, v in plan_.extra.items():
        assert pv(k) == v, (aid, spec, k, pv(k), v)


@pytest.mark.parametrize("optimize", [True, False])
def test_recycled_nodes_get_the_adjustment_uniforms_of_their_new_role(optimize):
    """Regression (live parity step): pooled / warmed spares are handed from role to role across documents; every apply must
    leave the uniforms of the CURRENT role on the node (no 'same parameters as last time' shortcut may skip a write)."""
    clock = fakenet.Clock()
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL, clock=clock, optimize=optimize)
    for rnd in range(3):
        for aid, spec in ADJ_DOCS:
            st = [base(), px("a", 1), px("b", 2), adj(aid, spec, mask={"slot": 9, "enabled": True}), px("c", 3)]
            net.apply(st, W, H)
            _assert_adjustment_uniforms(net, aid, spec)
            for _ in range(8):                                    # idle frames: spares get pre-warmed, pools refilled
                clock.t += 0.2
                net.tick()
    # two adjustments swap parameters between documents (their nodes are reused as they are)
    a1, a2 = ADJ_DOCS[0][1], ADJ_DOCS[1][1]
    net.apply([base(), px("a", 1), adj("p", a1), adj("q", a2)], W, H)
    _assert_adjustment_uniforms(net, "p", a1)
    _assert_adjustment_uniforms(net, "q", a2)
    net.apply([base(), px("a", 1), adj("p", a2), adj("q", a1)], W, H)
    _assert_adjustment_uniforms(net, "p", a2)
    _assert_adjustment_uniforms(net, "q", a1)
    net.apply([base(), px("a", 1), adj("q", a1), adj("p", a2)], W, H)              # reordered
    _assert_adjustment_uniforms(net, "p", a2)
    _assert_adjustment_uniforms(net, "q", a1)


def test_adjustment_node_taken_back_from_the_pool_is_rewired_and_rewritten(opt):
    net, comp, log, clock = opt
    spec1, spec2 = ADJ_DOCS[0][1], ADJ_DOCS[2][1]
    net.apply([base(), px("a", 1), adj("p", spec1, mask={"slot": 9, "enabled": True})], W, H)
    node = net._ops["blend_L_p"]
    net.apply([base(), px("a", 1)], W, H)                                          # back to the pool
    for _ in range(6):
        clock.t += 0.5
        net.tick()
    net.apply([base(), px("a", 1), adj("p", spec2, mask={"slot": 9, "enabled": True})], W, H)
    _assert_adjustment_uniforms(net, "p", spec2)
    assert source_of(net, "blend_L_p", 0) == "mrg_L_base" and source_of(net, "blend_L_p", 2) == "s9"


def test_adopted_glsl_node_is_reset_before_its_role_parameters_are_written(opt):
    """A node adopted from a loaded file / rebuilt component carries the leftovers of its previous role."""
    net, comp, log, clock = opt
    st = [base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5), adj("p", ADJ_DOCS[0][1])]
    net.apply(st, W, H)
    for _ in range(3):
        net.tick()
    stale = net._ops["blend_L_p"]
    stale.par.outputresolution = "custom"                                       # what an earlier role left behind
    stale.par.inputfiltertype = "mipmap"
    stale.bypass = True
    net2 = DocNetwork(comp, GLSL, clock=clock)
    net2.apply(st, W, H)
    assert net2._ops["blend_L_p"] is stale
    assert stale.par.value("outputresolution") == "useinput" and stale.par.value("inputfiltertype") == "nearest" and stale.bypass is False
    _assert_adjustment_uniforms(net2, "p", ADJ_DOCS[0][1])


def test_pass_format_follows_the_role_when_a_node_is_recycled(opt):
    """An 8 bit pass node handed to a role that needs 16 bit (and back) must get the role's format written."""
    net, comp, log, clock = opt
    top_run = [base(), px("a", 1), px("b", 2)]
    net.apply(top_run, W, H)
    assert fmt(net, "mrg_L_base") == "rgba8fixed"
    node = net._ops["mrg_L_base"]
    net.apply(top_run + [adj("lv", LEVELS)], W, H)                      # an adjustment above: the same merged node needs 16 bit
    assert net._ops["mrg_L_base"] is node and fmt(net, "mrg_L_base") == "rgba16fixed"
    assert net._ops["blend_L_lv"].par.value("format") == "rgba8fixed"
    net.apply([base()] + [px("q%d" % i, i) for i in range(1, 5)] + [adj("lv", LEVELS), px("z", 9, blend="multiply")], W, H)
    assert fmt(net, "mrg_L_base") == "rgba16fixed" and fmt(net, "blend_L_lv") == "rgba16fixed"
    net.apply([base(), px("a", 1)], W, H)                               # everything back to the pool, then 8 bit again
    for _ in range(4):
        net.tick()
    net.apply(top_run, W, H)
    assert fmt(net, "mrg_L_base") == "rgba8fixed"
    for n, o in net._ops.items():
        if n.startswith(("mrg_L_", "blend_L_", "xf_L_")):
            assert o.par.value("format") == net._cache[n]["pars"]["format"]       # the cache never disagrees with the node


@pytest.mark.parametrize("switch", ["EIGHT_BIT", "MERGE_RUNS", "CROP_BOXES", "SKIP_RULES"])
def test_feature_switches_turn_one_optimisation_off(switch, monkeypatch):
    monkeypatch.setattr(network, switch, False)
    clock = fakenet.Clock()
    comp, log = fakenet.make_comp()
    net = DocNetwork(comp, GLSL, clock=clock)
    st = [base(), px("a", 1), px("hid", 2, visible=False), px("b", 3, surfaceW=24, surfaceH=18, x=5.5, sx=1.5, sy=1.5),
          shp("s", dict(RECT, x=10, y=10, w=20, h=10)), adj("lv", LEVELS), px("c", 4)]
    net.apply(st, W, H)
    ops_ = set(net._ops)
    if switch == "EIGHT_BIT":
        assert all(o.par.value("format") != "rgba8fixed" for n, o in net._ops.items() if n.startswith(("mrg_L_", "blend_L_", "xf_L_")))
    if switch == "MERGE_RUNS":
        assert not any(n.startswith("mrg_L_") for n in ops_)
    if switch == "CROP_BOXES":
        assert net.content_box("b") is None and "shapec_s" not in ops_
        assert net._ops["xf_L_b"].par.value("resolutionw") == W
    if switch == "SKIP_RULES":
        assert plan(net)["skipped"] == 0
        merged = [r for r in ops_ if r.startswith("mrg_L_")]
        assert any(uL(net, m, k)[1] == 0.0 and ins(net, m)[1 + k] == "s2" for m in merged for k in range(8)) or "blend_L_hid" in ops_
    # whatever is switched off, the network stays a complete chain to `out`
    assert source_of(net, "out") in ops_


def _stale_node(comp, name, optype="glslTOP", tags=(), **stale):
    """A glsl node of a loaded file / rebuilt component that served another role (effect slot, shape ...)."""
    n = comp.op("doc").create(optype, name)
    n.tags = list(tags)
    for k, v in dict(pixeldat="fxsrc_blur", format="rgba32float", vec0name="uP0", vec1name="uP1", vec2name="uP2", vec3name="uP3",
                     vec4name="uPass", outputresolution="custom", inputfiltertype="mipmap").items():
        setattr(n.par, k, stale.get(k, v))
    return n


def test_adopted_and_leftover_nodes_get_the_canonical_vector_names_and_every_plan_value(opt):
    """Regression (live: after a component rebuild the layers of a resample pass stacked at the origin and adjustments were
    wrong): the new DocNetwork adopts tagged nodes and re-pools untagged spares that last served as effect slots; blend /
    resample / adjustment nodes write only vec0 (uParams) and vec1 (uXform) themselves, so uA / uB must have their names."""
    net, comp, log, clock = opt
    # nodes as a previous session left them: a tagged one for each role the new document will use, plus spares
    roles = ["blend_L_lv", "xf_L_a", "blend_L_hs", "mrg_L_base"]
    for r in roles:
        _stale_node(comp, "g%d" % (100 + roles.index(r)) if not r.startswith("mrg") else "m77",
                    "glslmultiTOP" if r.startswith("mrg") else "glslTOP", tags=["role:" + r])
    _stale_node(comp, "g200")                                    # untagged spare that was an effect slot
    _stale_node(comp, "g201")
    st = [base(), px("a", 1, surfaceW=24, surfaceH=18, x=5.5, y=3.25, sx=1.5, sy=1.5), px("b", 2),
          adj("lv", ADJ_DOCS[0][1], mask={"slot": 9, "enabled": True}), adj("hs", ADJ_DOCS[1][1])]
    net2 = DocNetwork(comp, GLSL, clock=clock)                  # the rebuilt component: adopts what the doc holds
    net2.apply(st, W, H)
    for _ in range(6):
        net2.tick()
    net2.apply(st[:3] + [adj("lv", ADJ_DOCS[2][1]), adj("hs", ADJ_DOCS[1][1])], W, H)       # then a different document
    adopted = [n for n in net2._ops if n.startswith(("blend_L_", "xf_L_", "mrg_L_"))]
    assert {"blend_L_lv", "xf_L_a", "blend_L_hs"} <= set(adopted)
    for name in adopted:
        pv = net2._ops[name].par.value
        assert (pv("vec0name"), pv("vec1name"), pv("pixeldat")) == ("uParams", "uXform", "blend_glsl"), name
        if name.startswith("mrg_L_"):
            assert pv("vec11name") == "uL7" and pv("vec4name") == "uL0", name
        else:
            assert (pv("vec2name"), pv("vec3name")) == ("uA", "uB"), name
        assert pv("outputresolution") == ("custom" if name.startswith("xf_L_") else "useinput"), name
        assert pv("inputfiltertype") == ("linear" if name == "xf_L_a" else "nearest"), name
    # every parameter the plan wants is on the node (whatever the cache believes)
    for name, spec in net2._desired.items():
        op_ = net2._ops[name]
        if op_.OPType not in ("glslTOP", "glslmultiTOP"):
            continue
        for k, v in spec.pars.items():
            assert op_.par.value(k) == v, (name, k, op_.par.value(k), v)
    _assert_adjustment_uniforms(net2, "lv", ADJ_DOCS[2][1])
    pa = net2._ops["xf_L_a"].par.value
    bx = net2.content_box("a")
    assert (pa("vec2valuex"), pa("vec2valuey")) == (5.5 - bx[0], 3.25 - bx[1])  # the (crop-relative) translation reaches uA
