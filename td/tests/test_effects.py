"""effects.py: planner (shared with the browser through shared/effects/vectors.json) and the EffectChain diff logic against
fake TD objects (no TouchDesigner needed).  Set REGEN_EFFECT_VECTORS=1 to rewrite vectors.json from this planner."""

import json
import math
import os
import random

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


PYRAMID = [
    {"enabled": True, "type": "dropShadow", "dx": 4, "dy": -3, "blur": 33, "color": C1, "opacity": 1},
    {"enabled": True, "type": "dropShadow", "dx": 0, "dy": 0, "blur": 90, "color": C2, "opacity": 0.5},
    {"enabled": True, "type": "outerGlow", "size": 130, "color": C1, "opacity": 1},
    {"enabled": True, "type": "innerGlow", "size": 300, "color": C2, "opacity": 1},
    {"enabled": True, "type": "bevel", "depth": 75, "size": 64, "angle": 45, "highlight": C1, "shadow": C2},
    {"enabled": True, "type": "bevel", "depth": 75, "size": 32, "angle": 45, "highlight": C1, "shadow": C2},
]


def filter_cases():
    """Every filter's samples + degenerate parameter sets (shared/effects/<type>.filter.json), one case each, plus a mixed stack."""
    out = []
    for t, sp in sorted(effects.FILTER_SPECS.items()):
        for s in sp.get("samples", []) + sp.get("degenerate", []):
            out.append({"effects": [dict({"enabled": True, "type": t}, **s)]})
    return out


def build_vectors():
    cases = [{"effects": [e]} for e in SAMPLES + DEGENERATE + PYRAMID]
    cases.append({"effects": SAMPLES[:3] + SAMPLES[5:6] + SAMPLES[12:13]})
    cases += filter_cases()
    fl = [c["effects"][0] for c in filter_cases() if c["effects"][0]["type"] in ("blur", "posterize", "curves", "unsharp")]
    if fl:
        cases.append({"effects": fl[:6] + SAMPLES[:1]})
    for c in cases:
        _record(c)
    return {"cases": cases}


def _record(c):
    c["chain"] = [{"effect": i, **p.as_dict()} for i, p in effects.plan_chain(c["effects"])]
    c["reach"] = effects.effects_reach(c["effects"])
    c["extent"] = [list(effects.effect_extent(e)) for e in c["effects"]]
    c["tdPreview"] = [effects.effect_td_preview(e) for e in c["effects"]]
    c["reads"] = [effects.effect_reads(e) for e in c["effects"]]
    return c


FUZZ = os.path.join(ROOT, "shared", "effects", "fuzz_vectors.json")
_GOOD_CUBE = "LUT_3D_SIZE 2\n" + "\n".join("%d %d %d" % (r, g, b) for b in (0, 1) for g in (0, 1) for r in (0, 1)) + "\n"
_CUBE_VARIANTS = [_GOOD_CUBE, "\ufeff" + _GOOD_CUBE.replace("\n", "\r\n"), "LUT_3D_INPUT_RANGE -1 2\n" + _GOOD_CUBE, "TITLE x # c\n" + _GOOD_CUBE,
                  _GOOD_CUBE + "1 2\n", _GOOD_CUBE.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 3"), "LUT_1D_SIZE 4\n0 0 0\n", "LUT_3D_SIZE 2\n" + "nan 0 0\n" * 8,
                  "LUT_3D_SIZE 2\n" + "\u0663 0 0\n" * 8, _GOOD_CUBE.replace("1 1 1", "1_0 1 1"), "", "garbage"]


def _fuzz_value(rng, d):
    r = rng.random()
    kind = (d or {}).get("kind", "num")
    if r < 0.55:                                    # a plausible value for the parameter
        if kind == "enum":
            return rng.choice(d["values"])
        if kind == "bool":
            return rng.random() < 0.5
        if kind == "color":
            return {"r": rng.randrange(256), "g": rng.randrange(256), "b": rng.randrange(256), "a": rng.randrange(256)}
        if kind == "points":
            return [[round(rng.random(), 3), round(rng.random(), 3)] for _ in range(rng.randrange(0, 6))]
        if kind == "stops":
            return [{"pos": round(rng.random(), 3), "color": {"r": rng.randrange(256), "g": rng.randrange(256), "b": rng.randrange(256), "a": 255}} for _ in range(rng.randrange(0, 5))]
        if kind == "list":
            return [round(rng.uniform(-1, 1), 3) for _ in range(rng.randrange(0, (d or {}).get("len", 16) + 3))]
        if kind == "text":
            return rng.choice(_CUBE_VARIANTS)
        lo, hi = (d or {}).get("min", -50), (d or {}).get("max", 200)
        return round(rng.uniform(lo, hi), rng.choice([0, 1, 3]))
    return rng.choice([None, "12", True, False, [], {}, [[0, 0], [1, 1]], {"x": 1}, 0, -1, 1e9, -1e9, 1e300, -1e300, 10 ** 400, 3.5, 255, "bogus",
                       {"r": "x", "g": None, "b": 1e9, "a": -5}, [None, 1, "a"], 2 ** 53, 16777219])


def build_fuzz():
    """Seeded random (and hostile) parameter sets for every filter and v5 effect: Python and TS must plan them identically."""
    rng = random.Random(20261015)
    v5 = {}
    for e in SAMPLES + PYRAMID:
        v5.setdefault(e["type"], {}).update({k: None for k in e if k not in ("type", "enabled")})
    cases = []
    for t in sorted(list(v5) + list(effects.FILTER_SPECS)):
        params = effects.FILTER_SPECS[t].get("params", {}) if t in effects.FILTER_SPECS else {k: None for k in v5[t]}
        for _ in range(10):
            e = {"enabled": True, "type": t}
            for p, d in params.items():
                if rng.random() < 0.85:
                    e[p] = _fuzz_value(rng, d)
            if rng.random() < 0.1:
                e["enabled"] = rng.choice([False, None, 0])
            cases.append({"effects": [e]})
    for bad in ({"type": ["x"]}, {"type": 5}, {"type": None}, {}, {"type": "blur", "radius": 10 ** 400}, {"type": "dropShadow", "blur": 10 ** 400, "dx": -10 ** 400}):
        cases.append({"effects": [bad]})
    return {"cases": [_record(c) for c in cases]}


def test_fuzz_vectors_match_planner():
    effects.reload_specs(effects.load_specs())
    if os.environ.get("REGEN_EFFECT_VECTORS"):
        data = build_fuzz()
        with open(FUZZ, "w") as f:
            json.dump(data, f)
    with open(FUZZ) as f:
        ref = json.load(f)
    got = build_fuzz()
    assert len(ref["cases"]) == len(got["cases"])
    for a, b in zip(ref["cases"], got["cases"]):
        assert a["effects"] == b["effects"]
        assert a["reach"] == b["reach"] and a["extent"] == b["extent"] and a["tdPreview"] == b["tdPreview"] and a["reads"] == b["reads"]
        assert len(a["chain"]) == len(b["chain"])
        for pa, pb in zip(a["chain"], b["chain"]):
            assert (pa["effect"], pa["shader"], pa["pass"], pa["fmt"], pa.get("level", 0), pa.get("aux", False), pa.get("data")) == \
                   (pb["effect"], pb["shader"], pb["pass"], pb["fmt"], pb.get("level", 0), pb.get("aux", False), pb.get("data"))
            assert pa["u"] == pytest.approx(pb["u"], rel=1e-9, abs=1e-6)


def test_vectors_match_planner():
    effects.reload_specs(effects.load_specs())
    if os.environ.get("REGEN_EFFECT_VECTORS"):
        with open(VECTORS, "w") as f:
            json.dump(build_vectors(), f, indent=1)
    with open(VECTORS) as f:
        ref = json.load(f)
    got = build_vectors()
    assert len(ref["cases"]) == len(got["cases"])
    for a, b in zip(ref["cases"], got["cases"]):
        assert a["reach"] == b["reach"] and a["extent"] == b["extent"]
        assert a["tdPreview"] == b["tdPreview"] and a["reads"] == b["reads"]
        assert len(a["chain"]) == len(b["chain"])
        for pa, pb in zip(a["chain"], b["chain"]):
            assert (pa["effect"], pa["shader"], pa["pass"], pa["fmt"]) == (pb["effect"], pb["shader"], pb["pass"], pb["fmt"])
            assert (pa.get("level", 0), pa.get("aux", False), pa.get("data")) == (pb.get("level", 0), pb.get("aux", False), pb.get("data"))
            assert pa["u"] == pytest.approx(pb["u"], rel=1e-9, abs=1e-6)


def test_plan_basics():
    assert effects.plan_effect({"enabled": False, "type": "dropShadow"}) == []
    assert effects.plan_effect({"enabled": True, "type": "stroke", "width": 0, "position": "inside"}) == []
    assert effects.plan_effect({"enabled": True, "type": "nope"}) == []
    ps = effects.plan_effect(SAMPLES[0])
    assert [p.pid for p in ps] == [0, 1]
    # dx/dy rounded half up, sigma = blur / 3, radius = ceil(blur)
    assert ps[0].u[:4] == pytest.approx([2.5, 8, 5, -5])
    assert ps[0].u[4:8] == pytest.approx([1.0, 128 / 255, 0.0, 200 / 255 * 0.8])
    # blur sizes are capped at MAX_RADIUS (200); above PYR_THRESHOLD the passes are the pyramid: down, H, V (level L), up
    big = effects.plan_effect(SAMPLES[3])
    assert [(p.pid, p.level) for p in big] == [(2, 4), (3, 4), (4, 4), (5, 0)]
    assert big[0].u[1] == 13 and big[0].u[8] == 4
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
    assert set(effects.EFFECT_TYPES) <= set(texts)
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


# --------------------------------------------------------------------------- v6 filters (spec driven planner)


def test_embedded_specs_in_sync():
    """effects.py embeds shared/effects/*.filter.json (the TD component ships no extra files): `effects_dev.py sync` regenerates it."""
    assert json.loads(effects._EMBEDDED_SPECS) == effects.load_specs()


def test_shader_files_for_every_filter():
    effects.reload_specs(effects.load_specs())
    texts = effects.load_shader_texts()
    for t, sp in effects.FILTER_SPECS.items():
        if not sp.get("glsl", True):
            continue
        s = texts[t]
        assert s.count("void main()") == 1 and "fxPos()" in s and not [l for l in s.splitlines() if l.startswith("#version")]
        # the declared inputs: shaders using sTD2DInputs[2] must say in2
        assert ("sTD2DInputs[2]" in s.replace("sTD2DInputs[2];", "")) == bool(sp.get("in2")) or "fxData" in s or "fxAux2" in s
        for p in effects.plan_effect(dict({"enabled": True, "type": t}, **(sp.get("samples") or [{}])[0])):
            assert p.shader in texts, (t, p.shader)
            assert len(p.u) == 16


def test_filter_samples_plan_and_degenerate():
    effects.reload_specs(effects.load_specs())
    for c in filter_cases():
        e = c["effects"][0]
        ps = effects.plan_effect(e)
        ext = effects.effect_extent(e)
        assert all(isinstance(v, int) and v >= 0 for v in ext)
        for p in ps:
            assert all(math.isfinite(v) for v in p.u) and p.fmt in (effects.FMT_F16, effects.FMT_F32, effects.FMT_U8)
            assert p.level >= 0 and (p.level == 0 or p.fmt != effects.FMT_U8)
        if ps:
            assert ps[-1].level == 0, "the last pass of a filter is full resolution"
        assert effects.effect_reads(e) in ("none", "point", "neighbourhood", "global")
    for sp in effects.FILTER_SPECS.values():
        assert sp.get("samples"), sp["type"] + ": every filter needs samples"
        assert sp.get("degenerate"), sp["type"] + ": every filter needs degenerate parameter sets"
        assert sp.get("reads") in ("point", "neighbourhood", "global")


def test_expression_language():
    ev = effects.ev
    assert ev("1 + 2 * 3", {}) == 7 and ev("-(2 + 3) * 2", {}) == -10 and ev("1 / 0", {}) == 0
    assert ev("a < 3 && b >= 2 || 0", {"a": 1, "b": 2}) == 1 and ev("!0", {}) == 1
    assert ev("if(x > 1, 10, 20)", {"x": 2}) == 10 and ev("clamp(5, 0, 3)", {}) == 3 and ev("round(2.5)", {}) == 3 and ev("round(-2.5)", {}) == -2
    assert ev("sqrt(-4)", {}) == 0 and ev("log(0)", {}) == 0 and ev("pow(0, -1)", {}) == 0
    assert ev("c.r * 2", {"c.r": 0.25}) == 0.5 and ev("G", {}) == float(effects.GLOBAL_REACH)
    assert ev("mod(-1, 3)", {}) == 2 and ev("min(3, 1, 2)", {}) == 1
    with pytest.raises(Exception):
        ev("1 +", {})


def test_pyramid_plan():
    # up to 16 px: the exact v5 passes; above: levels so that the low-res radius is <= 16, variance compensated
    assert effects._blur_plan(16) == (16 / 3.0, 16, 0)
    sg, r, lv = effects._blur_plan(17)
    assert (r, lv) == (9, 1) and sg == pytest.approx(math.sqrt((17 / 3.0) ** 2 - 1.0) / 2.0)
    assert effects._blur_plan(32)[2] == 1 and effects._blur_plan(33)[2] == 2 and effects._blur_plan(64)[2] == 2 and effects._blur_plan(65)[2] == 3
    assert effects._blur_plan(129)[2] == 4
    assert effects._blur_plan(200)[1:] == (13, 4) and effects._blur_plan(1e9)[1:] == (13, 4)
    assert all(effects._blur_plan(px)[1] <= 16 for px in range(0, 201))
    # reach: radius for level 0, (R_low + 2) * 2^L above
    assert effects._blur_reach(10) == 10 and effects._blur_reach(17) == (9 + 2) * 2
    # existing effects below the threshold are unchanged
    assert [p.pid for p in effects.plan_effect({"type": "outerGlow", "size": 16, "color": C1})] == [0, 1]
    assert [p.pid for p in effects.plan_effect({"type": "outerGlow", "size": 17, "color": C1})] == [2, 3, 4, 5]


def test_curves_and_cube_data():
    effects.reload_specs(effects.load_specs())
    ident = effects.plan_effect({"type": "curves"})[0].data
    assert (ident.w, ident.h) == (256, 1) and list(ident.data[:8]) == [0, 0, 0, 255, 1, 1, 1, 255]
    inv = effects.plan_effect({"type": "curves", "master": [[0, 1], [1, 0]]})[0].data.data
    assert list(inv[:4]) == [255, 255, 255, 255] and list(inv[-4:]) == [0, 0, 0, 255]
    mono = effects.curve_eval_table([(0, 0), (0.5, 0.2), (1, 1)])
    assert all(b >= a for a, b in zip(mono, mono[1:])) and mono[0] == 0 and mono[255] == 1
    cube = "TITLE x\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\nLUT_3D_SIZE 2\n" + "\n".join(
        "%d %d %d" % (r, g, b) for b in (0, 1) for g in (0, 1) for r in (0, 1))
    at = effects.cube_atlas(cube)
    assert at and at[1] == 2 and at[2] == 2 and (at[0].w, at[0].h) == (4, 4)
    assert effects.parse_cube("LUT_3D_SIZE 2\n1 2 3\n") is None and effects.parse_cube("LUT_1D_SIZE 4\n") is None
    assert effects.parse_cube("LUT_3D_SIZE 65\n") is None


def _env_with_filters():
    effects.reload_specs(effects.load_specs())
    e = Env()
    e.texts = effects.load_shader_texts()
    e.chain = effects.EffectChain(e.parent, "fx_a", e.texts)
    return e


def test_chain_pyramid_size_follows_the_document_not_a_stale_input_top():
    """Regression (live network_dev adjust, blur 40 on 512 px): a TOP that has not cooked yet reports 256 x 256; the level textures were
    then sized for 256 px and the blur came out garbage. The document size passed to apply() wins."""
    e = _env_with_filters()
    e.src.width, e.src.height = 256, 256
    e.chain.apply([legacy_fx(40)], e.src, 512, 512)
    n = e.chain.nodes
    assert (n[0].par.value("resolutionw"), n[0].par.value("resolutionh")) == (67, 67)          # level 3: ceil(512/8) + 3
    e.chain.apply([legacy_fx(40)], e.src)                                                         # no size given: the input's
    assert (e.chain.nodes[0].par.value("resolutionw")) == 35


def legacy_fx(r):
    return effects.legacy_blur_to_filter(r)


def test_chain_pyramid_levels_set_custom_resolution():
    e = _env_with_filters()
    e.chain.apply([{"type": "blur", "radius": 150}], e.src, 1000, 500)
    n = e.chain.nodes
    assert len(n) == 4
    # level 4: ceil(size / 16) + 3 on both hosts; the up pass runs at the input size
    assert [x.par.value("outputresolution") for x in n] == ["custom", "custom", "custom", "useinput"]
    assert (n[0].par.value("resolutionw"), n[0].par.value("resolutionh")) == (66, 35)           # level 4: ceil(1000/16) + 3, ceil(500/16) + 3
    assert [x.par.value("vec4valuew") for x in n] == [4.0, 4.0, 4.0, 0.0] and [x.par.value("vec4valuex") for x in n] == [2.0, 3.0, 4.0, 5.0]
    # back to a small radius: same nodes re-used, resolution reset
    e.chain.apply([{"type": "blur", "radius": 10}], e.src, 1000, 500)
    assert e.chain.node_count == 2 and all(x.par.value("outputresolution") == "useinput" for x in e.chain.nodes)


def test_chain_data_texture_and_aux_wiring():
    e = _env_with_filters()
    aux = e.parent.create("nullTOP", "auxsrc")
    e.chain.apply([{"type": "curves", "master": [[0, 1], [1, 0]]}, {"type": "displace", "source": "aux", "strengthX": 5, "strengthY": 5}], e.src, 64, 48, aux=aux)
    n = e.chain.nodes
    assert len(n) == 2
    # curves: input 2 = a script TOP whose callbacks DAT embeds the LUT; displace: input 2 = the aux TOP
    d = e.parent.op("fx_a_d0")
    assert d is not None and d.OPType == "scriptTOP" and d.par.value("callbacks") == "fx_a_dcb0"
    assert "onCook" in e.parent.op("fx_a_dcb0").text and "256x1" in e.parent.op("fx_a_dcb0").text
    assert src_of(n[0], 2) is d and src_of(n[1], 2) is aux and src_of(n[1], 0) is n[0]
    assert n[1].par.value("vec4valuew") == 0.0
    # same data again: nothing rewritten; aux missing: dummy input + flag in uPass.w
    m = e.log.mark()
    e.chain.apply([{"type": "curves", "master": [[0, 1], [1, 0]]}, {"type": "displace", "source": "aux", "strengthX": 5, "strengthY": 5}], e.src, 64, 48, aux=aux)
    dd = e.log.since(m)
    assert not dd["creates"] and not dd["destroys"] and not dd["par_sets"] and not dd["connects"]
    e.chain.apply([{"type": "displace", "source": "aux", "strengthX": 5, "strengthY": 5}], e.src, 64, 48)
    assert e.chain.nodes[0].par.value("vec4valuew") == 0.5 and src_of(e.chain.nodes[0], 2) is e.src
    assert e.parent.op("fx_a_d0") is None                                   # the data node went away with the curves pass
    e.chain.clear()
    assert e.chain.node_count == 0


def test_adjustment_layer_style_input_is_just_a_top():
    """An adjustment layer passes the composite below as ``input_top``: no special casing, the chain only sees a TOP."""
    e = _env_with_filters()
    below = e.parent.create("nullTOP", "composite_below")
    out = e.chain.apply([{"type": "posterize", "levels": 4}], below, 1920, 1080)
    assert src_of(e.chain.nodes[0], 0) is below and out is e.chain.nodes[0]
    assert e.chain.apply([{"type": "posterize", "enabled": False}], below, 1920, 1080) is below


def test_filter_flags_api():
    effects.reload_specs(effects.load_specs())
    assert effects.effect_reads({"type": "posterize"}) == "point" and not effects.effect_needs_neighbourhood({"type": "posterize"})
    assert effects.effect_needs_neighbourhood({"type": "blur", "radius": 4})
    assert effects.effect_reads({"type": "blur", "radius": 0}) == "none"
    assert effects.effect_reads({"type": "displace", "strengthX": 2, "strengthY": 2, "edge": "wrap"}) == "global"
    assert effects.effect_reads({"type": "dropShadow", "blur": 3, "color": C1}) == "neighbourhood" and effects.effect_reads({"type": "colorOverlay", "color": C1}) == "point"
    assert not effects.effect_td_preview({"type": "blur", "radius": 4})
    assert effects.effect_td_preview(SAMPLES[9]) and not effects.effect_td_preview(dict(SAMPLES[9], enabled=False)) and not effects.effect_td_preview(SAMPLES[8])


def test_td_preview_flag_mechanism():
    """No shipped filter needs it (measured), but the flag must work: constant or expression, only when something is drawn."""
    specs = effects.load_specs()
    specs["_tdp"] = {"type": "_tdp", "glsl": False, "reads": "point", "tdPreview": "mode == 1",
                     "params": {"mode": {"kind": "num", "default": 0, "min": 0, "max": 1}}, "passes": [{"shader": "posterize", "pass": 0, "u": ["2"]}]}
    specs["_tdq"] = {"type": "_tdq", "glsl": False, "reads": "point", "tdPreview": True, "passes": [{"shader": "posterize", "pass": 0, "u": ["2"]}]}
    try:
        effects.reload_specs(specs)
        assert not effects.effect_td_preview({"type": "_tdp", "mode": 0}) and effects.effect_td_preview({"type": "_tdp", "mode": 1})
        assert effects.effect_td_preview({"type": "_tdq"}) and not effects.effect_td_preview({"type": "_tdq", "enabled": False})
    finally:
        effects.reload_specs(effects.load_specs())


def test_parse_cube_rules():
    body = "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
    assert effects.parse_cube("\ufeffLUT_3D_SIZE 2\r\n" + body.replace("\n", "\r\n"))["size"] == 2
    r = effects.parse_cube("LUT_3D_INPUT_RANGE -1 2\nLUT_3D_SIZE 2\n" + body)
    assert (r["dmin"][0], r["dmax"][2]) == (-1.0, 2.0)
    assert effects.parse_cube("LUT_3D_SIZE 2\n" + body.replace("1 1 1", "nan 1 1")) is None
    assert effects.parse_cube("LUT_3D_SIZE 2\n" + body.replace("1 1 1", "1_0 1 1")) is None
    assert effects.parse_cube("LUT_3D_SIZE \u0662\n" + body) is None
    assert effects.parse_cube("LUT_3D_SIZE 65\n" + "0 0 0\n" * 10) is None
    assert effects.parse_cube("x" * (effects.CUBE_MAX_CHARS + 1)) is None
    assert effects.parse_cube("LUT_3D_SIZE 2\n" + "0 0 0\n" * (64 ** 3 + 5)) is None
    # python robustness: huge ints / non-string types plan like the defaults (no exceptions)
    assert effects.plan_effect({"type": ["x"]}) == [] and effects.plan_effect({"type": 5}) == [] and effects.plan_effect(None) == []
    assert effects.plan_effect({"type": "blur", "radius": 10 ** 400})[0].u[1] == 10        # not a finite number -> default radius 10


def test_adopt_cleans_orphaned_data_nodes():
    e = _env_with_filters()
    e.chain.apply([{"type": "curves"}, {"type": "posterize", "levels": 3}], e.src, 64, 48)
    assert e.parent.op("fx_a_d0") is not None
    # file reload: a new chain adopts the glsl nodes; the curves pass was removed from the stack -> its data nodes are not kept
    again = effects.EffectChain(e.parent, "fx_a", e.texts)
    assert e.parent.op("fx_a_d0") is not None and e.parent.op("fx_a_dcb0") is not None        # slot 0 exists: adopted
    again.apply([{"type": "posterize", "levels": 3}], e.src, 64, 48)
    assert e.parent.op("fx_a_d0") is None and e.parent.op("fx_a_dcb0") is None
    stray = e.parent.create("scriptTOP", "fx_a_d7")
    effects.EffectChain(e.parent, "fx_a", e.texts)
    assert not stray.valid or e.parent.op("fx_a_d7") is None
