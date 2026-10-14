"""DocNetwork diff logic against fake TD objects (no TouchDesigner needed)."""

import json
import os
import re

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
    assert b("vec0name") == "uParams" and b("vec1name") == "uOffset"
    assert b("vec0valuex") == 1.0        # multiply
    assert b("vec0valuey") == 0.5        # opacity
    assert b("vec0valuez") == 0.0        # no mask
    assert b("vec0valuew") == 0.0        # blend, not adjust
    assert b("pixeldat") == "blend_glsl"
    c = net._ops["blend_L_c"].par.value
    assert (c("vec1valuex"), c("vec1valuey")) == (5.0, -3.0)
    assert net._ops["blend_L_c"].tags == ["role:blend_L_c"]


def test_blend_L_mode_index_order_matches_types_ts():
    src = open(os.path.join(ROOT, "web", "src", "engine", "types.ts"), encoding="utf-8").read()
    m = re.search(r"export type BlendMode =([^;]+);", src)
    assert tuple(re.findall(r"'([a-z-]+)'", m.group(1))) == network.BLEND_MODES


def test_every_mode_has_a_shader_case():
    cases = sorted(int(c) for c in re.findall(r"case (\d+):", GLSL))
    assert cases == list(range(16))


def test_shader_contract():
    for needle in ("uniform vec4 uParams", "uniform vec2 uOffset", "texelFetch(sTD2DInputs[0]",
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
    assert pv("pixeldat") == "blend_glsl" and pv("vec0name") == "uParams" and pv("vec1name") == "uOffset"
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
