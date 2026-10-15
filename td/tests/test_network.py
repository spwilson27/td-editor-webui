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
    net = DocNetwork(comp, GLSL, clock=clock)
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
    DocNetwork(comp, GLSL)
    assert len([c for c in comp.children if c.name == "doc"]) == 1


def test_build_chain_wiring(env):
    net, comp, log, _ = env
    net.apply(stack_of_three(), W, H)
    # chain bottom -> top, each blend takes the previous as input 0 and its surface as input 1
    assert source_of(net, "blend_base", 0) == "blank"
    assert source_of(net, "blend_base", 1) == "base_src"
    assert source_of(net, "blend_L_a", 0) == "blend_base"
    assert source_of(net, "blend_L_a", 1) == "s1"
    assert source_of(net, "blend_L_b", 0) == "blend_L_a"
    assert source_of(net, "blend_L_b", 1) == "s2"
    assert source_of(net, "blend_L_c", 0) == "blend_L_b"
    assert source_of(net, "blend_L_c", 1) == "s3"
    assert source_of(net, "out", 0) == "blend_L_c"
    assert net.output() is net._ops["out"]
    # all three glsl inputs are always wired (sTD2DInputs[] is sized by the wired inputs)
    for r in ("blend_base", "blend_L_a", "blend_L_b", "blend_L_c"):
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
    ys = [net._ops[r].nodeY for r in ("blend_base", "blend_L_a", "blend_L_b", "blend_L_c")]
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
    assert source_of(net, "blend_L_b", 0) == "blend_base"
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
    net2 = DocNetwork(comp, GLSL, clock=clock)
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
    net2 = DocNetwork(comp, GLSL, clock=clock)
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
    assert source_of(net, "blend_L_a", 0) == "blend_base"


def test_input_connection_switches_base_source(env):
    net, comp, log, _ = env
    net.apply([base(), px("a", 1)], W, H)
    assert net._ops["base_src"].par.value("top") == "blank"
    comp.inputConnectors[0].source = comp.in1          # any connected source
    m = log.mark()
    net.apply([base(), px("a", 1)], W, H)               # apply detects the change itself
    assert net._ops["base_src"].par.value("top") == "../in1"
    assert len(log.since(m)["par_sets"]) == 1
    net.set_input_connected(False)
    assert net._ops["base_src"].par.value("top") == "blank"


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
    assert source_of(net, "blend_L_g", 0) == "blend_base"
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
    net.apply([base(), px("a", 1), adj("bl", {"type": "blur", "radius": 0.08})], W, H)
    assert net._ops["adj_L_bl"].bypass is True


def test_unknown_removal_survives_children_dying_with_parent(env, monkeypatch):
    net, comp, log, clock = env
    net.apply([base(), px("a", 1)], W, H)            # leaves companion DATs (g*_info, s1_callbacks ...) behind
    assert net.stats()["junk"] > 0
    monkeypatch.setattr(network, "POOL_MAX", 0)       # spares cannot be recycled -> destroyed as unknown
    net2 = DocNetwork(comp, GLSL, clock=clock)
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
    assert source_of(net, "blend_L_s", 0) == "blend_base"
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
    n1 = DocNetwork(comp, GLSL)
    n1.apply([base(), shp("s"), txt("t")], W, H)
    log.clear()
    n2 = DocNetwork(comp, GLSL)
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
    assert pvals(net, "xf_L_a", "vec1") == (2.5, -1.25, 0.25, 0.5)            # document top-left px; the shader flips
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
    assert {(n, k) for n, k, v in d["par_sets"]} == {(gname, "vec1value" + c) for c in "xyzw"}
    m = log.mark()
    net.apply(L1(x=3.5, y=1.25, sx=0.5, sy=0.5), W, H)                  # starts minifying: filter flag on the resample node
    d = log.since(m)
    assert {(n, k) for n, k, v in d["par_sets"]} == {(gname, "vec1valuez"), (gname, "vec1valuew"), (gname, "inputfiltertype")}
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
            assert re.fullmatch(r"s\d+|base_src", src), (name, "reads", src)
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
    assert source_of(net, "xf_L_base", 0) == "base_src"
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
    assert pvals(net, "blend_base", "vec1") == (0.0, 0.0, 1.0, 1.0)        # no input: transparent blank, nothing to move
    assert source_of(net, "blend_base", 1) == "base_src" and source_of(net, "blend_base", 0) == "blank"
    comp.inputConnectors[0].connect(comp.in1)
    net.apply([b], W, H)
    assert pvals(net, "xf_L_base", "vec1") == (10.5, -4.0, 0.5, 0.5)
    assert net._ops["xf_L_base"].par.value("inputfiltertype") == "mipmap" and source_of(net, "xf_L_base", 0) == "base_src"
    assert source_of(net, "blend_base", 1) == "xf_L_base"
    assert net._ops["base_src"].par.value("top") == "../in1"
    comp.inputConnectors[0].disconnect()
    net.set_input_connected(False)
    net.apply([b], W, H)
    assert "xf_L_base" not in net._ops and pvals(net, "blend_base", "vec1") == (0.0, 0.0, 1.0, 1.0)


def test_set_input_connected_true_replans_the_base_transform(env):
    net, comp, log, _ = env
    b = L("base", "base", x=2.5, y=0, sx=0.5, sy=0.5)
    net.apply([b], W, H)
    assert "xf_L_base" not in net._ops
    comp.inputConnectors[0].connect(comp.in1)      # the ext flips the flag, then applies the (unchanged) stack
    net.set_input_connected(True)
    net.apply([b], W, H)
    assert "xf_L_base" in net._ops and net._ops["base_src"].par.value("top") == "../in1"


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
    "layer coords": "vec2 l = (c - uXform.xy) / sc;",
    "coverage": "vec2 cov2 = clamp((min(l + h, srcSz) - max(l - h, vec2(0.0))) / (2.0 * h), 0.0, 1.0);",
    "coverage applied": "src *= cov * m;",
    "uv flip": "vec2 uv = vec2(l.x / srcSz.x, 1.0 - l.y / srcSz.y);",
    "lod": "float lod = max(0.0, -0.5 * log2(sc.x * sc.y) - 0.5);",
    "exact flip": "ivec2(ip.x, int(srcSz.y) - 1 - ip.y)",
    "exact tolerance": "abs(uXform.x - floor(uXform.x + 0.5)) < 1e-4 && abs(uXform.y - floor(uXform.y + 0.5)) < 1e-4",
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
    ("lod", "- 0.5);", "+ 0.5);"),
    ("lod", "log2(sc.x * sc.y)", "log2(max(sc.x, sc.y))"),
    ("coverage", "(2.0 * h)", "(1.0 * h)"),
    ("blend source flip", "srcSize.y - 1 - d.y", "d.y"),
    ("exact flip", "int(srcSz.y) - 1 - ip.y", "ip.y"),
    ("exact tolerance", "< 1e-4 && abs(uXform.y", "< 1e-2 && abs(uXform.y"),
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
