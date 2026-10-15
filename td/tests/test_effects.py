"""effects.py: planner (shared with the browser through shared/effects/vectors.json) and the EffectChain diff logic against
fake TD objects (no TouchDesigner needed).  Set REGEN_EFFECT_VECTORS=1 to rewrite vectors.json from this planner."""

import json
import math
import os

import pytest

import effects
import fakenet

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
VECTORS = os.path.join(ROOT, "shared", "effects", "vectors.json")

C1 = {"r": 255, "g": 128, "b": 0, "a": 200}
C2 = {"r": 10, "g": 20, "b": 30, "a": 255}

SAMPLES = [
    {"enabled": True, "type": "dropShadow", "dx": 5.4, "dy": -4.6, "blur": 7.5, "color": C1, "opacity": 0.8},
    {"enabled": True, "type": "dropShadow", "dx": 0, "dy": 0, "blur": 0, "color": C2, "opacity": 1},
    {"enabled": True, "type": "outerGlow", "size": 12, "color": C1, "opacity": 0.5},
    {"enabled": True, "type": "innerGlow", "size": 300, "color": C2, "opacity": 1},
    {"enabled": True, "type": "stroke", "width": 1, "color": C1, "position": "inside", "opacity": 1},
    {"enabled": True, "type": "stroke", "width": 9, "color": C1, "position": "center", "opacity": 0.7},
    {"enabled": True, "type": "stroke", "width": 33, "color": C2, "position": "outside", "opacity": 1},
    {"enabled": True, "type": "bevel", "depth": 75, "size": 6, "angle": 120, "highlight": C1, "shadow": C2},
    {"enabled": True, "type": "colorOverlay", "color": C1, "opacity": 0.25},
    {"enabled": True, "type": "pixelSort", "direction": "v", "low": 0.2, "high": 0.9, "key": "hue"},
    {"enabled": True, "type": "pixelSort", "direction": "h", "low": 0, "high": 1, "key": "luma"},
    {"enabled": True, "type": "glitch", "amount": 40, "blockSize": 12, "seed": 7, "rgbShift": 3},
    {"enabled": True, "type": "chromaticAberration", "amount": 3.5, "angle": 30},
    {"enabled": True, "type": "halftone", "cellSize": 6, "angle": 45, "shape": "line"},
    {"enabled": False, "type": "halftone", "cellSize": 6, "angle": 45, "shape": "dot"},
]

# degenerate inputs: Python and TS must agree (missing fields, out of range, wrong types, huge / negative values)
DEGENERATE = [
    {"type": "dropShadow"},
    {"type": "dropShadow", "dx": 1e9, "dy": -1e9, "blur": -5, "color": None, "opacity": 7},
    {"type": "dropShadow", "dx": "5", "dy": True, "blur": "9", "color": C1, "opacity": "0.5"},
    {"type": "outerGlow", "size": -3, "color": C1, "opacity": -1},
    {"enabled": 0, "type": "colorOverlay", "color": C1, "opacity": 1},
    {"enabled": None, "type": "colorOverlay", "color": C1},
    {"enabled": True, "type": "stroke", "width": 500, "color": C1, "position": "inside", "opacity": 1},
    {"enabled": True, "type": "stroke", "width": -4, "color": C1, "position": "inside", "opacity": 1},
    {"enabled": True, "type": "stroke", "width": 3, "color": C1, "position": "bogus", "opacity": 1},
    {"enabled": True, "type": "pixelSort", "direction": "x", "low": 0.8, "high": 0.2, "key": "bogus"},
    {"enabled": True, "type": "pixelSort", "low": -3, "high": 9},
    {"enabled": True, "type": "glitch", "amount": 250, "blockSize": 0, "seed": -5, "rgbShift": -2},
    {"enabled": True, "type": "glitch", "amount": "50", "blockSize": 4.6, "seed": 16777219, "rgbShift": 1e30},
    {"enabled": True, "type": "chromaticAberration", "amount": -4, "angle": 1e12},
    {"enabled": True, "type": "halftone", "cellSize": 0},
    {"enabled": True, "type": "bevel", "depth": 900, "size": -2, "angle": "x"},
    {"enabled": True, "type": "nope"},
]


def build_vectors():
    cases = [{"effects": [e]} for e in SAMPLES + DEGENERATE]
    cases.append({"effects": SAMPLES[:3] + SAMPLES[5:6] + SAMPLES[12:13]})
    for c in cases:
        c["chain"] = [{"effect": i, **p.as_dict()} for i, p in effects.plan_chain(c["effects"])]
        c["reach"] = effects.effects_reach(c["effects"])
        c["extent"] = [list(effects.effect_extent(e)) for e in c["effects"]]
    return {"cases": cases}


def test_vectors_match_planner():
    if os.environ.get("REGEN_EFFECT_VECTORS"):
        with open(VECTORS, "w") as f:
            json.dump(build_vectors(), f, indent=1)
    with open(VECTORS) as f:
        ref = json.load(f)
    got = build_vectors()
    assert len(ref["cases"]) == len(got["cases"])
    for a, b in zip(ref["cases"], got["cases"]):
        assert a["reach"] == b["reach"] and a["extent"] == b["extent"]
        assert len(a["chain"]) == len(b["chain"])
        for pa, pb in zip(a["chain"], b["chain"]):
            assert (pa["effect"], pa["shader"], pa["pass"], pa["fmt"]) == (pb["effect"], pb["shader"], pb["pass"], pb["fmt"])
            assert pa["u"] == pytest.approx(pb["u"], abs=1e-6)


def test_plan_basics():
    assert effects.plan_effect({"enabled": False, "type": "dropShadow"}) == []
    assert effects.plan_effect({"enabled": True, "type": "stroke", "width": 0, "position": "inside"}) == []
    assert effects.plan_effect({"enabled": True, "type": "nope"}) == []
    ps = effects.plan_effect(SAMPLES[0])
    assert [p.pid for p in ps] == [0, 1]
    # dx/dy rounded half up, sigma = blur / 3, radius = ceil(blur)
    assert ps[0].u[:4] == pytest.approx([2.5, 8, 5, -5])
    assert ps[0].u[4:8] == pytest.approx([1.0, 128 / 255, 0.0, 200 / 255 * 0.8])
    # kernel radius is capped
    big = effects.plan_effect(SAMPLES[3])
    assert big[0].u[1] == effects.MAX_RADIUS
    # stroke pass counts: jump flood steps + composite, first jump reads the source
    s = effects.plan_effect(SAMPLES[6])       # outside, w = 33 -> d = 34 -> steps 32 .. 1, 1
    assert [p.u[0] for p in s[:-1]] == [32, 16, 8, 4, 2, 1, 1]
    assert [p.u[1] for p in s[:-1]] == [1, 0, 0, 0, 0, 0, 0]
    assert s[-1].pid == 1 and s[-1].u[:2] == [2.0, 33.0]
    assert [p.fmt for p in s] == ["rgba32float"] * 7 + ["rgba16float"]


def test_plan_chain_formats():
    chain = effects.plan_chain([SAMPLES[0], {"enabled": False, "type": "glitch"}, SAMPLES[8], SAMPLES[9]])
    assert [(i, p.shader, p.pid) for i, p in chain] == [
        (0, "dropShadow", 0), (0, "dropShadow", 1), (2, "colorOverlay", 0), (3, "pixelSort", 0), (3, "pixelSort", 1), (3, "pixelSort", 2)]
    assert [p.fmt for _, p in chain] == ["rgba16float", "rgba16float", "rgba16float", "rgba32float", "rgba32float", "rgba8fixed"]


def test_reach():
    assert effects.effect_reach(SAMPLES[0]) == 5 + 8
    assert effects.effect_reach(SAMPLES[1]) == 0 and effects.effect_reach(SAMPLES[8]) == 0
    assert effects.effect_reach(SAMPLES[-1]) == 0
    assert effects.effects_reach([SAMPLES[2], SAMPLES[12]]) == 12 + 6
    # pixel sort: finite conservative reach, exact extent = chunk alignment along the axis only
    assert effects.effect_reach(SAMPLES[9]) == 255
    assert effects.effect_extent(SAMPLES[9]) == (0, 0, 0, 256)          # direction v
    assert effects.effect_extent(SAMPLES[10]) == (0, 0, 256, 0)
    assert effects.effect_extent(SAMPLES[0]) == (13, 13, 0, 0)
    # stroke: the jump-flood dependency radius (sum of the jump sizes + 2), not the width
    assert effects.effect_extent(SAMPLES[6]) == (66, 66, 0, 0)
    assert effects.effect_extent(SAMPLES[5]) == (10, 10, 0, 0)         # centre w = 9: steps 4 2 1 1


def test_degenerate_inputs():
    # disabled only by a literal False; wrong-typed numbers fall back to defaults; clamps
    assert effects.plan_effect(DEGENERATE[4]) and effects.plan_effect(DEGENERATE[5])
    p = effects.plan_effect(DEGENERATE[1])
    assert p[0].u[1] == 0 and p[0].u[2:4] == [8192.0, -8192.0] and p[0].u[4:8] == [0.0, 0.0, 0.0, 1.0]
    assert effects.plan_effect(DEGENERATE[2])[0].u[2:4] == [0.0, 0.0]         # "5" and True are not numbers
    assert effects.plan_effect(DEGENERATE[7]) == []
    assert effects.plan_effect(DEGENERATE[16]) == []
    g = effects.plan_effect(DEGENERATE[11])[0].u
    assert g[:2] == [1.0, 100.0] and g[2] == 1.0 and g[3] == float((1 << 24) - 5)
    assert effects.plan_effect(DEGENERATE[12])[0].u[3] == 3.0                  # 2^24 + 3 wraps; "50" -> 0
    assert effects.plan_effect(DEGENERATE[12])[0].u[0] == 0.0


def test_shader_files():
    texts = effects.load_shader_texts()
    assert set(texts) == set(effects.EFFECT_TYPES)
    for t, s in texts.items():
        assert "void main()" in s and "uP0" in s and "fxPos()" in s
        assert not [l for l in s.splitlines() if l.startswith("#version")]          # the host adapter adds it (WebGL); TD injects its own
        assert s.count("void main()") == 1


# --------------------------------------------------------------------------- chain


class Env:
    def __init__(self):
        self.log = fakenet.Log()
        self.parent = fakenet.FakeOp(None, "baseCOMP", "doc", self.log)
        self.src = self.parent.create("nullTOP", "layer")
        self.texts = {t: "// " + t for t in effects.EFFECT_TYPES}
        self.chain = effects.EffectChain(self.parent, "fx_a", self.texts)


def src_of(op, i):
    return op.inputConnectors[i].source


def test_chain_builds_and_wires():
    e = Env()
    out = e.chain.apply([SAMPLES[0], SAMPLES[8], SAMPLES[2]], e.src, 64, 48)
    nodes = e.chain.nodes
    assert len(nodes) == 5 and out is nodes[-1]
    # effect 0: shadow pass 0 reads (src, src); pass 1 reads (src, pass0)
    assert (src_of(nodes[0], 0), src_of(nodes[0], 1)) == (e.src, e.src)
    assert (src_of(nodes[1], 0), src_of(nodes[1], 1)) == (e.src, nodes[0])
    # effect 1 (overlay) takes the shadow's output as its input
    assert (src_of(nodes[2], 0), src_of(nodes[2], 1)) == (nodes[1], nodes[1])
    assert (src_of(nodes[4], 0), src_of(nodes[4], 1)) == (nodes[2], nodes[3])
    assert nodes[0].par.value("pixeldat") == "fxsrc_dropShadow"
    assert nodes[1].par.value("format") == "rgba16float" and nodes[4].par.value("format") == "rgba8fixed"
    assert nodes[0].par.value("vec0name") == "uP0" and nodes[0].par.value("vec4name") == "uPass"
    assert nodes[1].par.value("vec4valuex") == 1.0
    assert nodes[0].par.value("vec0valuex") == pytest.approx(2.5)
    assert e.parent.op("fxsrc_dropShadow").text == e.texts["dropShadow"]


def test_param_edit_is_uniform_sets_only():
    e = Env()
    fx = [dict(SAMPLES[0]), dict(SAMPLES[8])]
    e.chain.apply(fx, e.src, 64, 48)
    m = e.log.mark()
    e.chain.apply(fx, e.src, 64, 48)
    d = e.log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["par_sets"] and not d["connects"] and not d["disconnects"]
    fx[0]["opacity"] = 0.3
    fx[0]["dx"] = 9
    m = e.log.mark()
    e.chain.apply(fx, e.src, 64, 48)
    d = e.log.since(m)
    assert not d["creates"] and not d["destroys"] and not d["connects"]
    assert {p[0] for p in d["par_sets"]} == {n.name for n in e.chain.nodes[:2]}
    assert {p[1] for p in d["par_sets"]} <= {"vec0valuez", "vec1valuew"}


def test_structure_changes_reuse_and_trim_nodes():
    e = Env()
    e.chain.apply([SAMPLES[0], SAMPLES[8]], e.src)
    names = [n.name for n in e.chain.nodes]
    m = e.log.mark()
    e.chain.apply([SAMPLES[8]], e.src)                      # shadow removed: nodes re-used, the tail destroyed
    d = e.log.since(m)
    assert len(e.chain.nodes) == 1 and e.chain.nodes[0].name == names[0]
    assert len(d["destroys"]) == 2 and not d["creates"]
    assert e.chain.nodes[0].par.value("pixeldat") == "fxsrc_colorOverlay"
    assert src_of(e.chain.nodes[0], 0) is e.src
    # stroke width crossing a power of two adds jump passes
    st = dict(SAMPLES[5])
    e.chain.apply([st], e.src)
    n1 = e.chain.node_count
    st["width"] = 40
    e.chain.apply([st], e.src)
    assert e.chain.node_count > n1
    # all disabled -> input returned, everything removed
    assert e.chain.apply([dict(SAMPLES[0], enabled=False)], e.src) is e.src
    assert e.chain.node_count == 0
    assert e.chain.apply([], e.src) is e.src


def test_destroy_and_adopt():
    e = Env()
    e.chain.apply([SAMPLES[0]], e.src)
    names = [n.name for n in e.chain.nodes]
    again = effects.EffectChain(e.parent, "fx_a", e.texts)      # a file reload: nodes exist already
    m = e.log.mark()
    out = again.apply([SAMPLES[0]], e.src)
    d = e.log.since(m)
    assert not d["creates"] and [n.name for n in again.nodes] == names and out.name == names[-1]
    assert d["par_sets"]                                          # state unknown -> rewritten once
    again.destroy()
    assert again.node_count == 0
    assert all(not e.parent.op(n) for n in names)


def test_acquire_release_hooks():
    e = Env()
    spare = [e.parent.create("glslTOP", "g%d" % i) for i in range(1, 4)]
    released = []
    chain = effects.EffectChain(e.parent, "fx_b", e.texts, acquire=lambda t: spare.pop(0), release=released.append)
    chain.apply([SAMPLES[0]], e.src)
    assert [n.name for n in chain.nodes] == ["g1", "g2"]
    chain.apply([], e.src)
    assert [o.name for o in released] == ["g2", "g1"]
    assert all(o.valid for o in released)           # hooks decide what happens to released nodes
