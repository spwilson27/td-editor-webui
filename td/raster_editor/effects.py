"""Layer effects for TouchDesigner (docs/DESIGN_V5.md "Layer effects", docs/PROTOCOL.md section 8).

Pure python (TD objects are only reached through ``parent.op / parent.create / node.par / node.inputConnectors``), so it is
unit-tested against ``td/tests/fakenet.py``.

Shared with the browser preview (web/src/engine/effects)::

    shared/effects/common.glsl     prelude, concatenated in front of every effect shader
    shared/effects/<type>.glsl     one shader per effect type (several passes selected by uPass.x)

The planner here (``plan_effect``) and ``web/src/engine/effects/plan.ts`` produce the SAME pass lists / uniform values
(``shared/effects/vectors.json`` is checked by both test suites), so the shader code is the single source of the maths.

Pass model (every effect = 1..N passes, each pass = one GLSL TOP)::

    node.input0 = the effect's input (previous effect's output, or the layer content), premultiplied rgba
    node.input1 = the previous pass of this effect (pass 0: same as input0)
    uniforms    = uP0..uP3 (vec4 x4 = 16 floats, per effect), uPass = (pass id, 0, 0, 0)  [region origin: always 0 in TD]
    format      = rgba8fixed for the chain's final pass, rgba16float for the last pass of an inner effect and for
                  blur passes, rgba32float for jump flood / pixel sort data

Typical use from network.py::

    shaders = effects.load_shader_texts()                       # once: {type: common + shader source}
    chain = effects.EffectChain(doc, "fx_" + layer_id, shaders)  # one per layer that has effects
    top = chain.apply(layer["effects"], layer_top, doc_w, doc_h) # build / update; returns the TOP to blend (``layer_top`` itself
                                                                 #   when no effect is enabled)
    ...
    chain.destroy()                                              # layer deleted / effects removed

``apply`` only touches what changed: a parameter edit is a handful of ``par`` sets on existing nodes; the node count / order only
changes when the effect list structure changes (stroke width crossing a power of two changes the pass count).  Nodes are
generic GLSL TOPs: pass ``acquire(optype) -> op`` / ``release(op)`` to take them from network.py's spare pool.

v6 filters library (docs/DESIGN_V6.md section 1; types shared/effects/filters.d.ts)::

    Every filter is shared/effects/<type>.filter.json (parameters with units / ranges, uniform layout, passes, extent, samples) + <type>.glsl.
    The planner (``plan_effect`` / ``effect_extent`` / ``plan_chain``) evaluates the spec: one tiny expression language, identical in
    web/src/engine/effects/filters.ts.  A copy of the specs is EMBEDDED at the end of this file (``scripts/effects_dev.py sync``), so the
    TD component needs no extra files.  Filters use the same chain as the layer effects (mixed lists are fine) and are also the adjustment
    layers' engine: for an adjustment layer ``EffectChain.apply(filters, below_top, w, h)`` gets the document-sized composite below as
    ``input_top`` (nothing else is special).  EXTRA INPUT: ``apply(..., aux=top)`` -- a document-sized TOP read by filters that take a second
    image (displace by layer / input, input 2 of their passes); without it they render with no displacement (uPass.w fraction 0.5).
    Data textures (curve / gradient LUT, .cube atlas, tables) are RGBA8 Script TOPs (+ callbacks DAT) wired to input 2 of that pass.
    ``Pass.level`` > 0 = pyramid pass: custom output resolution ceil(size / 2^level) + 3.  Blur pyramid: blur sizes <= 16 px are the exact
    separable gaussian; above (cap 200 px) every blur-type pass (shadow / glows / bevel / blur / unsharp / high-pass / bloom) is a
    down-sample pyramid, measured max error vs the exact gaussian ~1.4/255 (mean 0.3).  Planner reports per effect: ``effect_reads``
    ('none' | 'point' | 'neighbourhood' | 'global'), ``effect_needs_neighbourhood`` (for bbox / caching of adjustment layers) and
    ``effect_td_preview`` (True = the browser preview cannot match TD within 3/255: the UI shows TD's render of the layer).
    Everything is static: no time dependence; iterative filters (feedback, echo, drift glitch, colour cycle) take ``iterations`` <= 64.

Units (contract with the UI): lengths in document px; ``opacity`` 0..1; colours RGBA 0..255 (alpha multiplies opacity);
bevel ``depth`` 0..100 (percent), ``angle`` degrees, 0 = light from the right, counter-clockwise on screen (120 = upper left);
pixelSort ``low`` / ``high`` 0..1 on luma or hue; glitch ``amount`` 0..100 (percent of bands glitched AND max shift in px),
``blockSize`` band height px, ``seed`` integer, ``rgbShift`` px; chromaticAberration ``amount`` px, ``angle`` degrees (as bevel);
halftone ``cellSize`` px, ``angle`` degrees clockwise on screen.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import zlib

FMT_U8 = "rgba8fixed"
FMT_F16 = "rgba16float"
FMT_F32 = "rgba32float"

MAX_RADIUS = 200          # blur size cap (px).  Sizes above PYR_THRESHOLD run as a down-sample pyramid (docs/DESIGN_V6.md)
PYR_THRESHOLD = 16        # largest blur radius (px) run as one full-resolution separable gaussian; above: pyramid
MAX_STROKE = 128
PIXEL_SORT_SPAN = 256     # spans are sorted in aligned chunks of this many px (pixelSort.glsl MAXSPAN)

EFFECT_TYPES = ("dropShadow", "outerGlow", "innerGlow", "stroke", "bevel", "colorOverlay",
                "pixelSort", "glitch", "chromaticAberration", "halftone")


class DataTex:
    """RGBA8 data texture of a pass (curve / gradient / LUT / table), bound as input 2.  ``data`` rows in texture order (row 0 first)."""
    __slots__ = ("w", "h", "data", "digest")

    def __init__(self, w, h, data):
        self.w, self.h, self.data = int(w), int(h), bytes(data)
        self.digest = "%dx%d:%08x" % (self.w, self.h, zlib.crc32(self.data) & 0xffffffff)

    def summary(self):
        return {"w": self.w, "h": self.h, "digest": self.digest}


class Pass:
    """One GLSL TOP pass: shader (effect type), pass id, 16 uniform floats uP0..uP3, working format, ``level`` (output size =
    ceil(size / 2^level) + 3 for level > 0, pyramid passes), ``data`` (DataTex bound as input 2) and ``aux`` (input 2 = the chain's aux image)."""
    __slots__ = ("shader", "pid", "u", "fmt", "level", "data", "aux")

    def __init__(self, shader, pid, u, fmt, level=0, data=None, aux=False):
        self.shader, self.pid, self.fmt = shader, pid, fmt
        self.level, self.data, self.aux = int(level), data, bool(aux)
        u = [float(v) for v in u]
        if len(u) > 16:
            raise ValueError("a pass has at most 16 uniform floats")
        self.u = u + [0.0] * (16 - len(u))

    def with_fmt(self, fmt):
        return Pass(self.shader, self.pid, self.u, fmt, self.level, self.data, self.aux)

    def as_dict(self):
        d = {"shader": self.shader, "pass": self.pid, "u": list(self.u), "fmt": self.fmt}
        if self.level:
            d["level"] = self.level
        if self.data is not None:
            d["data"] = self.data.summary()
        if self.aux:
            d["aux"] = True
        return d

    def __repr__(self):
        return "Pass(%s#%d %s)" % (self.shader, self.pid, self.fmt)


# --------------------------------------------------------------------------- planning (== web/src/engine/effects/plan.ts)


def _rad(deg):
    """Degrees -> radians after an exact fmod 360 (huge angles then agree between Python and JS libm)."""
    return math.fmod(deg, 360.0) * math.pi / 180.0


def _round(x):
    return int(math.floor(float(x) + 0.5))


def _num(e, k, d=0.0):
    """Finite numbers only (numeric strings, booleans, None -> default): same rule as plan.ts ``num``."""
    v = e.get(k, d)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return float(d)
    try:
        v = float(v)
    except OverflowError:         # a python int beyond the double range (JSON gives Infinity in JS): default, like plan.ts
        return float(d)
    return v if math.isfinite(v) else float(d)


_SEED_MOD = 1 << 24      # seeds are reduced to 0..2^24-1 so the float uniform holds them exactly
_MAX_OFFSET = 8192


def _off(e, k):
    return max(-_MAX_OFFSET, min(_MAX_OFFSET, _round(_num(e, k))))


def _enabled(e):
    """Only a literal False disables an effect (a missing flag = enabled), like ``enabled === false`` in plan.ts."""
    return bool(e) and e.get("enabled", True) is not False


def _col(c, opacity=1.0):
    """RGBA 0..255 dict -> [r, g, b, a * opacity] in 0..1; anything but a dict / a finite number falls back to the defaults (0,0,0,255)."""
    c = c if isinstance(c, dict) else {}
    return [_comp(c, "r", 0) / 255.0, _comp(c, "g", 0) / 255.0, _comp(c, "b", 0) / 255.0,
            _comp(c, "a", 255) / 255.0 * min(1.0, max(0.0, opacity))]


def _blur_size(px):
    """Blur size (px) -> (sigma, kernel radius).  ``size`` is the kernel half width; sigma = size / 3."""
    px = min(float(MAX_RADIUS), max(0.0, px))
    r = int(math.ceil(px))
    return px / 3.0, r


def _jfa_steps(d):
    """Jump sizes (px) to find the nearest edge pixel within distance d: pow2ceil(ceil(d)/2) ... 1, then 1 again (JFA+1)."""
    s0 = 1
    half = int(math.ceil(d / 2.0))
    while s0 < half:
        s0 *= 2
    steps = []
    s = s0
    while s >= 1:
        steps.append(s)
        s //= 2
    steps.append(1)
    return steps


# --------------------------------------------------------------------------- blur pyramid


def _pyr_level(px):
    """Pyramid level of a blur of kernel size ``px`` (already clamped to 0..MAX_RADIUS): 0 up to PYR_THRESHOLD px, else the smallest
    L with ceil(R / 2^L) <= PYR_THRESHOLD (R = ceil(px))."""
    r = int(math.ceil(px))
    lv = 0
    while ((r + (1 << lv) - 1) >> lv) > PYR_THRESHOLD:
        lv += 1
    return lv


def _blur_plan(px):
    """Blur size (px) -> (sigma, kernel radius, level) of the passes that really run: level 0 = full resolution gaussian (sigma = px/3,
    radius ceil(px)); level L > 0: LOW-RES sigma^2 = (sigma^2 - s^2/4) / s^2 (s = 2^L, compensating the box down-sample and bilinear
    up-sample variance) and radius ceil(R / s)."""
    px = min(float(MAX_RADIUS), max(0.0, px))
    r = int(math.ceil(px))
    lv = _pyr_level(px)
    sg = px / 3.0
    if lv == 0:
        return sg, r, 0
    s = 1 << lv
    return math.sqrt(max(sg * sg - s * s / 4.0, 0.0)) / s, (r + s - 1) // s, lv


def _blur_reach(px):
    """Pixels a blur of size ``px`` reads around a pixel: radius, or (R_low + 2) * 2^L for the pyramid (kernel, bilinear, block)."""
    _, r, lv = _blur_plan(px)
    return r if lv == 0 else (r + 2) << lv


# --------------------------------------------------------------------------- filter specs (shared/effects/<type>.filter.json)
#
# A filter is a spec (JSON, shared with web/src/engine/effects/filters.ts) + a shader <type>.glsl.  Everything numeric is evaluated by the tiny
# expression language below, identically in Python and TypeScript (docs: shared/effects/filters.d.ts, "Filter specs").

GLOBAL_REACH = 1 << 20     # extent of a filter that reads anywhere in the document (kaleidoscope, polar...)
_FMT_NAMES = {"u8": FMT_U8, "f16": FMT_F16, "f32": FMT_F32}
_TOK = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)|(==|!=|<=|>=|&&|\|\||[-+*/<>!(),]))")


def _tokenize(src):
    out, pos = [], 0
    src = src.rstrip()
    while pos < len(src):
        m = _TOK.match(src, pos)
        if not m:
            raise ValueError("bad expression %r at %d" % (src, pos))
        pos = m.end()
        if m.group(1) is not None:
            out.append(("n", float(m.group(1))))
        elif m.group(2) is not None:
            out.append(("i", m.group(2)))
        else:
            out.append(("o", m.group(3)))
    return out


class _Parser:
    def __init__(self, toks):
        self.t, self.i = toks, 0

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def eat(self, v=None):
        tok = self.peek()
        if v is not None and tok[1] != v:
            raise ValueError("expected %s" % v)
        self.i += 1
        return tok

    def parse(self):
        n = self.p_or()
        if self.i != len(self.t):
            raise ValueError("trailing tokens")
        return n

    def p_bin(self, ops, sub):
        n = sub()
        while self.peek()[0] == "o" and self.peek()[1] in ops:
            op = self.eat()[1]
            n = ("b", op, n, sub())
        return n

    def p_or(self):
        return self.p_bin(("||",), self.p_and)

    def p_and(self):
        return self.p_bin(("&&",), self.p_cmp)

    def p_cmp(self):
        n = self.p_add()
        if self.peek()[0] == "o" and self.peek()[1] in ("==", "!=", "<", ">", "<=", ">="):
            op = self.eat()[1]
            n = ("b", op, n, self.p_add())
        return n

    def p_add(self):
        return self.p_bin(("+", "-"), self.p_mul)

    def p_mul(self):
        return self.p_bin(("*", "/"), self.p_un)

    def p_un(self):
        if self.peek()[0] == "o" and self.peek()[1] in ("-", "!"):
            op = self.eat()[1]
            return ("u", op, self.p_un())
        return self.p_prim()

    def p_prim(self):
        k, v = self.eat()
        if k == "n":
            return ("n", v)
        if k == "i":
            if self.peek() == ("o", "("):
                self.eat()
                args = []
                if self.peek() != ("o", ")"):
                    args.append(self.p_or())
                    while self.peek() == ("o", ","):
                        self.eat()
                        args.append(self.p_or())
                self.eat(")")
                return ("f", v, args)
            return ("v", v)
        if (k, v) == ("o", "("):
            n = self.p_or()
            self.eat(")")
            return n
        raise ValueError("unexpected token %r" % (v,))


_AST = {}


def _fin(x):
    return x if math.isfinite(x) else 0.0


def _f_sqrt(x):
    return math.sqrt(x) if x > 0 else 0.0


def _f_pow(a, b):
    try:
        return _fin(math.pow(a, b))
    except (ValueError, OverflowError, ZeroDivisionError):
        return 0.0


def _f_exp(x):
    return math.exp(x) if x < 700 else 0.0


def _f_log(x):
    return math.log(x) if x > 0 else 0.0


def _f_mod(a, b):
    return a - b * math.floor(a / b) if b != 0 else 0.0


_FUNCS = {
    "abs": abs, "min": min, "max": max, "floor": math.floor, "ceil": math.ceil, "round": lambda x: math.floor(x + 0.5),
    "sqrt": _f_sqrt, "pow": _f_pow, "exp": _f_exp, "log": _f_log, "sin": math.sin, "cos": math.cos, "tan": lambda x: _fin(math.tan(x)),
    "atan2": math.atan2, "rad": lambda x: x * math.pi / 180.0, "deg": lambda x: x * 180.0 / math.pi,
    "clamp": lambda x, lo, hi: min(hi, max(lo, x)), "mix": lambda a, b, t: a + (b - a) * t, "if": lambda c, a, b: a if c != 0 else b,
    "mod": _f_mod, "sign": lambda x: (x > 0) - (x < 0), "fract": lambda x: x - math.floor(x),
    "pyrL": lambda px: float(_pyr_level(min(float(MAX_RADIUS), max(0.0, px)))),
    "blurSig": lambda px: _blur_plan(px)[0], "blurR": lambda px: float(_blur_plan(px)[1]), "blurReach": lambda px: float(_blur_reach(px)),
}
_CONSTS = {"pi": math.pi, "G": float(GLOBAL_REACH), "MAXR": float(MAX_RADIUS), "SEEDMOD": float(1 << 24)}


def _eval(n, env):
    k = n[0]
    if k == "n":
        return n[1]
    if k == "v":
        name = n[1]
        if name in env:
            return env[name]
        if name in _CONSTS:
            return _CONSTS[name]
        raise KeyError("unknown name %r" % name)
    if k == "u":
        x = _eval(n[2], env)
        return -x if n[1] == "-" else (1.0 if x == 0 else 0.0)
    if k == "b":
        op = n[1]
        a = _eval(n[2], env)
        b = _eval(n[3], env)
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return a / b if b != 0 else 0.0
        if op == "&&":
            return 1.0 if (a != 0 and b != 0) else 0.0
        if op == "||":
            return 1.0 if (a != 0 or b != 0) else 0.0
        return 1.0 if {"==": a == b, "!=": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op] else 0.0
    fn = _FUNCS[n[1]]
    return _fin(float(fn(*[_eval(a, env) for a in n[2]])))


def ev(src, env):
    """Evaluate an expression string (numbers, names, + - * / comparisons && || !, functions) -> finite float."""
    if isinstance(src, bool):
        return 1.0 if src else 0.0
    if isinstance(src, (int, float)):
        return float(src)
    ast = _AST.get(src)
    if ast is None:
        ast = _AST[src] = _Parser(_tokenize(src)).parse()
    return _fin(float(_eval(ast, env)))


# ---- parameter normalisation (the type rules of filters.d.ts)


def _clampf(v, lo, hi):
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _is_num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    try:
        return math.isfinite(float(v))
    except OverflowError:
        return False


def _norm_points(v):
    """[[x, y] | {x, y}] -> sorted, de-duplicated (last wins) list of (x, y) clamped to 0..1; max 32 points."""
    pts = {}
    for q in (v if isinstance(v, list) else [])[:64]:
        if isinstance(q, dict):
            q = (q.get("x"), q.get("y"))
        if not (isinstance(q, (list, tuple)) and len(q) >= 2 and _is_num(q[0]) and _is_num(q[1])):
            continue
        pts[min(1.0, max(0.0, float(q[0])))] = min(1.0, max(0.0, float(q[1])))
    return sorted(pts.items())[:32]


def _norm_stops(v, default):
    out = []
    for q in (v if isinstance(v, list) else [])[:32]:
        if isinstance(q, dict) and _is_num(q.get("pos")):
            c = q.get("color") if isinstance(q.get("color"), dict) else {}
            out.append((min(1.0, max(0.0, float(q["pos"]))), [_comp(c, k, 255 if k == "a" else 0) / 255.0 for k in "rgba"]))
    if not out:
        out = [(float(p), [_comp(c, k, 255 if k == "a" else 0) / 255.0 for k in "rgba"]) for p, c in default]
    out.sort(key=lambda t: t[0])          # stable: equal positions keep their order
    return out


def _comp(c, k, d):
    v = c.get(k, d) if isinstance(c, dict) else d
    return min(255.0, max(0.0, float(v))) if _is_num(v) else float(d)


def norm_params(spec, e):
    """Effect dict -> evaluation environment {name: float, 'colour.r': float, ..., '#list:name': normalised list}."""
    env = {}
    for name, d in spec.get("params", {}).items():
        k = d.get("kind", "num")
        raw = e.get(name)
        if k in ("num", "seed"):
            v = _num(e, name, d.get("default", 0.0))
            if d.get("round") or k == "seed":
                v = float(_round(v))
            if k == "seed":
                v = float(int(v) % _SEED_MOD)
            env[name] = _clampf(v, d.get("min"), d.get("max"))
        elif k == "bool":
            env[name] = 1.0 if raw is True else (0.0 if raw is False else (1.0 if d.get("default") else 0.0))
        elif k == "enum":
            vals = d["values"]
            env[name] = float(vals.index(raw) if isinstance(raw, str) and raw in vals else vals.index(d["default"]))
        elif k == "color":
            dc = d.get("default") or {"r": 0, "g": 0, "b": 0, "a": 255}
            c = raw if isinstance(raw, dict) else {}
            for ch in "rgba":
                env[name + "." + ch] = _comp(c, ch, dc.get(ch, 255 if ch == "a" else 0)) / 255.0
        elif k == "points":
            pts = _norm_points(raw) if isinstance(raw, list) else [tuple(p) for p in d.get("default", [[0, 0], [1, 1]])]
            env["#list:" + name] = pts
            env[name + ".n"] = float(len(pts))
        elif k == "stops":
            env["#list:" + name] = _norm_stops(raw, d.get("default", [[0, {"r": 0, "g": 0, "b": 0}], [1, {"r": 255, "g": 255, "b": 255}]]))
        elif k == "list":
            n = int(d.get("len", 16))
            lo, hi = d.get("min", -1.0), d.get("max", 1.0)
            vals = [float(x) if _is_num(x) else 0.0 for x in (raw if isinstance(raw, list) else [])[:n]]
            env["#list:" + name] = [min(hi, max(lo, x)) for x in vals] + [0.0] * (n - len(vals))
        elif k == "text":
            env["#text:" + name] = raw if isinstance(raw, str) else ""
        else:
            raise ValueError("param kind " + k)
    return env


# ---- data generators


def _q8(x):
    return int(math.floor(min(1.0, max(0.0, x)) * 255.0 + 0.5))


def _pchip_slopes(xs, ys):
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [(ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]
    if n == 2:
        return [d[0], d[0]]
    m = [0.0] * n
    for k in range(1, n - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])

    def end(h0, h1, d0, d1):
        v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if (v > 0) != (d0 > 0) or v == 0:
            return 0.0
        if (d0 > 0) != (d1 > 0) and abs(v) > 3 * abs(d0):
            return 3 * d0
        return v
    m[0] = end(h[0], h[1], d[0], d[1])
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
    return m


def curve_eval_table(points):
    """256 curve values (monotone cubic / PCHIP through the control points, flat outside the first / last point)."""
    if not points:
        return [i / 255.0 for i in range(256)]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    if len(points) == 1:
        return [ys[0]] * 256
    m = _pchip_slopes(xs, ys)
    out = []
    for i in range(256):
        x = i / 255.0
        if x <= xs[0]:
            out.append(ys[0])
        elif x >= xs[-1]:
            out.append(ys[-1])
        else:
            k = 0
            while xs[k + 1] < x:
                k += 1
            h = xs[k + 1] - xs[k]
            t = (x - xs[k]) / h
            t2, t3 = t * t, t * t * t
            v = ((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1])
            out.append(min(1.0, max(0.0, v)))
    return out


def _gen_curves(env, args):
    tabs = [curve_eval_table(env["#list:" + a]) for a in args]          # master, r, g, b
    data = bytearray()
    for i in range(256):
        mv = tabs[0][i]
        mi = min(255, max(0, int(math.floor(mv * 255.0 + 0.5))))
        data += bytes((_q8(tabs[1][mi]), _q8(tabs[2][mi]), _q8(tabs[3][mi]), 255))
    return DataTex(256, 1, data)


def _gen_gradient(env, args):
    st = env["#list:" + args[0]]
    data = bytearray()
    for i in range(256):
        t = i / 255.0
        if t <= st[0][0]:
            c = st[0][1]
        elif t >= st[-1][0]:
            c = st[-1][1]
        else:
            k = 0
            while st[k + 1][0] < t:
                k += 1
            p0, p1 = st[k], st[k + 1]
            w = (t - p0[0]) / (p1[0] - p0[0]) if p1[0] > p0[0] else 1.0
            c = [p0[1][j] + (p1[1][j] - p0[1][j]) * w for j in range(4)]
        data += bytes(_q8(v) for v in c)
    return DataTex(256, 1, data)


def _gen_table(env, args):
    """Signed values -1..1 of a list parameter -> RGBA8 N/4 x 1 texture, byte = round((v + 1) * 127.5)."""
    v = env["#list:" + args[0]]
    v = v + [0.0] * (-len(v) % 4)
    data = bytes(int(math.floor((x + 1.0) * 127.5 + 0.5)) for x in v)
    return DataTex(len(v) // 4, 1, data)


_NUM_RE = re.compile(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
_INT_RE = re.compile(r"^[+-]?[0-9]+$")
_LINES_RE = re.compile(r"\r\n|\r|\n")
_WS_RE = re.compile(r"[ \t]+")
CUBE_MAX_CHARS = 12_000_000
CUBE_MAX_VALUES = 64 ** 3 * 3


def parse_cube(text):
    """Adobe/Resolve ``.cube`` (3D only) -> {size, dmin[3], dmax[3], data: flat floats, red fastest} or None when invalid / unsupported.
    Identical rules in filters.ts parseCube: optional BOM, lines split on CRLF / CR / LF, tokens split on spaces / tabs, ASCII numbers only
    (no nan / inf / underscores), '#' comments, LUT_3D_INPUT_RANGE a b = DOMAIN_MIN/MAX (a a a)/(b b b) (last one wins), text <= 12 MB,
    parsing stops at the first value beyond 64^3 * 3."""
    if not isinstance(text, str) or len(text) > CUBE_MAX_CHARS:
        return None
    if text.startswith("\ufeff"):
        text = text[1:]
    size, dmin, dmax, vals = 0, [0.0] * 3, [1.0] * 3, []
    for line in _LINES_RE.split(text):
        line = line.split("#", 1)[0].strip(" \t")
        if not line:
            continue
        w = _WS_RE.split(line)
        key = w[0].upper()
        if key == "LUT_3D_SIZE":
            if len(w) < 2 or not _INT_RE.match(w[1]):
                return None
            size = int(w[1])
        elif key in ("DOMAIN_MIN", "DOMAIN_MAX"):
            if len(w) < 4 or not all(_NUM_RE.match(x) for x in w[1:4]):
                return None
            v = [float(x) for x in w[1:4]]
            if key == "DOMAIN_MIN":
                dmin = v
            else:
                dmax = v
        elif key == "LUT_3D_INPUT_RANGE":
            if len(w) < 3 or not all(_NUM_RE.match(x) for x in w[1:3]):
                return None
            dmin, dmax = [float(w[1])] * 3, [float(w[2])] * 3
        elif key == "LUT_1D_SIZE":
            return None
        elif key in ("TITLE", "LUT_1D_INPUT_RANGE"):
            continue
        else:
            if len(w) != 3 or not all(_NUM_RE.match(x) for x in w):
                return None
            vals.extend((float(w[0]), float(w[1]), float(w[2])))
            if len(vals) > CUBE_MAX_VALUES:
                return None
    if not (2 <= size <= 64) or len(vals) != size ** 3 * 3:
        return None
    if not all(math.isfinite(x) for x in vals + dmin + dmax) or any(dmax[i] <= dmin[i] for i in range(3)):
        return None
    return {"size": size, "dmin": dmin, "dmax": dmax, "data": vals}


def cube_atlas_layout(n):
    g = int(math.ceil(math.sqrt(n)))
    return g, g * n, g * n


_CUBE_CACHE = {}
CUBE_CACHE_SIZE = 32


def cube_atlas(text):
    """(DataTex, size, g, dmin, dmax) of a .cube text (cached), or None.  Atlas: g x g tiles of n x n texels, tile b = blue slice
    (tile column b % g, tile row b // g), texel (red, green) inside the tile."""
    hit = _CUBE_CACHE.pop(text, _MISSING)
    if hit is not _MISSING:
        _CUBE_CACHE[text] = hit            # LRU: most recently used last
        return hit
    c = parse_cube(text)
    res = None
    if c is not None:
        n = c["size"]
        g, w, h = cube_atlas_layout(n)
        buf = bytearray(w * h * 4)
        d = c["data"]
        for b in range(n):
            tx, ty = b % g, b // g
            for gg in range(n):
                for r in range(n):
                    o = ((ty * n + gg) * w + tx * n + r) * 4
                    s = ((b * n + gg) * n + r) * 3
                    buf[o] = _q8(d[s]); buf[o + 1] = _q8(d[s + 1]); buf[o + 2] = _q8(d[s + 2]); buf[o + 3] = 255
        res = (DataTex(w, h, buf), n, g, c["dmin"], c["dmax"])
    _CUBE_CACHE[text] = res
    while len(_CUBE_CACHE) > CUBE_CACHE_SIZE:
        _CUBE_CACHE.pop(next(iter(_CUBE_CACHE)))
    return res


def _gen_cube(env, args):
    r = cube_atlas(env["#text:" + args[0]])
    return r[0] if r else None


_GENS = {"curves": _gen_curves, "gradient": _gen_gradient, "table": _gen_table, "cube": _gen_cube}


def _cube_env(env, name):
    """Adds cube.n / cube.g / cube.dmin.* / cube.dmax.* / cube.ok to env."""
    r = cube_atlas(env["#text:" + name])
    env[name + ".ok"] = 1.0 if r else 0.0
    env[name + ".n"] = float(r[1]) if r else 0.0
    env[name + ".g"] = float(r[2]) if r else 0.0
    for i, ch in enumerate("rgb"):
        env[name + ".min." + ch] = r[3][i] if r else 0.0
        env[name + ".max." + ch] = r[4][i] if r else 1.0


# ---- planning from a spec

FILTER_SPECS = {}          # type -> spec (loaded from the embedded block below, or reload_specs(dir))


def _spec_env(spec, e):
    env = norm_params(spec, e)
    for name, d in spec.get("params", {}).items():
        if d.get("kind") == "text" and d.get("cube"):
            _cube_env(env, name)
    for name, expr in spec.get("vars", []):
        env[name] = ev(expr, env)
    return env


def _expand(spec, ents, env, out):
    for ent in ents:
        if "when" in ent and ev(ent["when"], env) == 0:
            continue
        if "sub" in ent:                      # the passes of another spec (e.g. "blur") with numeric parameter overrides
            sp = FILTER_SPECS[ent["sub"]]
            env2 = _spec_env(sp, {k: ev(x, env) for k, x in ent.get("with", {}).items()})
            if not (sp.get("noop") and ev(sp["noop"], env2) != 0):
                _expand(sp, sp["passes"], env2, out)
            continue
        if "repeat" in ent:
            rp = ent["repeat"]
            n = int(max(0, min(256, math.floor(ev(rp["count"], env)))))
            for i in range(n):
                e2 = dict(env)
                e2[rp["var"]] = float(i)
                _expand(spec, ent["passes"], e2, out)
            continue
        u = [ev(x, env) for x in ent.get("u", [])]
        data = None
        if ent.get("data"):
            data = _GENS[ent["data"]["gen"]](env, ent["data"]["args"])
            if data is None:
                continue
        out.append(Pass(ent.get("shader", spec["type"]), int(ev(ent.get("pass", 0), env)), u, _FMT_NAMES[ent.get("fmt", "f16")],
                        int(ev(ent.get("level", 0), env)), data, bool(ent.get("aux"))))


def plan_filter(e):
    spec = FILTER_SPECS.get(e.get("type")) if isinstance(e, dict) and isinstance(e.get("type"), str) else None
    if spec is None or not _enabled(e):
        return []
    env = _spec_env(spec, e)
    if spec.get("noop") and ev(spec["noop"], env) != 0:
        return []
    out = []
    _expand(spec, spec["passes"], env, out)
    return out


def filter_extent(e):
    spec = FILTER_SPECS[e["type"]]
    env = _spec_env(spec, e)
    return tuple(int(max(0, math.ceil(ev(x, env)))) for x in spec.get("extent", ["0", "0", "0", "0"]))


def is_filter(t):
    return t in FILTER_SPECS


# v5 effects that fail the 3/255 parity on another GPU implementation (pixel sort: hue / luma key ties order differently; SwiftShader vs
# Metal: 12 of 64000 px differ by up to 90/255) -> the preview shows TD's render (docs/FILTERS.md)
TD_PREVIEW_V5 = frozenset({"pixelSort"})


def effect_td_preview(e):
    """True when the browser preview cannot match TouchDesigner within 3/255 for this effect (the UI shows TD's render instead)."""
    if isinstance(e, dict) and isinstance(e.get("type"), str) and e["type"] in TD_PREVIEW_V5 and plan_effect(e):
        return True
    spec = FILTER_SPECS.get(e.get("type")) if isinstance(e, dict) and isinstance(e.get("type"), str) else None
    if spec is None or not plan_effect(e):
        return False
    v = spec.get("tdPreview", False)
    return bool(ev(v, _spec_env(spec, e))) if isinstance(v, str) else bool(v)


def effect_reads(e):
    """'none' (nothing to draw) | 'point' (output pixel depends on the same input pixel only) | 'neighbourhood' | 'global' (any pixel)."""
    if not plan_effect(e):
        return "none"
    spec = FILTER_SPECS.get(e["type"])
    if spec is None:
        return "global" if e["type"] == "pixelSort" else "neighbourhood" if effect_reach(e) > 0 else "point"
    rg = spec.get("readsGlobal")
    if rg and ev(rg, _spec_env(spec, e)) != 0:
        return "global"
    return spec.get("reads", "point")


def effect_needs_neighbourhood(e):
    """True when the output at a pixel reads other input pixels (so a changed region of the input spreads; bbox / cache planning)."""
    return effect_reads(e) in ("neighbourhood", "global")


def load_specs(directory=None):
    """{type: spec} read from ``directory`` (default shared/effects) *.filter.json."""
    d = directory or _shared_dir()
    out = {}
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".filter.json"):
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                spec = json.load(f)
            out[spec["type"]] = spec
    return out


def reload_specs(specs=None):
    """Replace FILTER_SPECS (tests / dev: ``reload_specs(load_specs())``)."""
    FILTER_SPECS.clear()
    FILTER_SPECS.update(specs if specs is not None else json.loads(_EMBEDDED_SPECS))
    _AST.clear()


def embedded_specs_json(specs):
    return json.dumps(specs, sort_keys=True, separators=(",", ":"))


_BEGIN = "# BEGIN EMBEDDED " + "FILTER SPECS"
_END = "# END EMBEDDED " + "FILTER SPECS"


def sync_embedded_specs(path=None, directory=None):
    """Dev tool (``scripts/effects_dev.py sync``): rewrite the embedded copy of shared/effects/*.filter.json inside effects.py, so the TD
    component needs no extra files.  Returns True when the file changed."""
    path = path or os.path.abspath(__file__)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    a = text.rindex(_BEGIN)
    b = text.index(_END)
    head = text[a:text.index("\n", a) + 1]
    new = text[:a] + head + "_EMBEDDED_SPECS = " + repr(embedded_specs_json(load_specs(directory))) + "\n" + text[b:]
    if new != text:
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
    return new != text


def plan_effect(e):
    """Effect dict -> list of Pass ([] when disabled / nothing to draw)."""
    if not isinstance(e, dict) or not _enabled(e):
        return []
    t = e.get("type")
    if not isinstance(t, str):
        return []
    if t in FILTER_SPECS:
        return plan_filter(e)
    op = min(1.0, max(0.0, _num(e, "opacity", 1.0)))
    if t == "dropShadow":
        sg, r, lv = _blur_plan(_num(e, "blur"))
        dx, dy = _off(e, "dx"), _off(e, "dy")
        u = [sg, r, dx, dy] + _col(e.get("color"), op)
        if lv:      # pyramid: down, H, V at level lv, then up + composite (blurlib.glsl)
            u += [float(lv)]
            return [Pass(t, 2, u, FMT_F16, lv), Pass(t, 3, u, FMT_F16, lv), Pass(t, 4, u, FMT_F16, lv), Pass(t, 5, u, FMT_F16)]
        return [Pass(t, 0, u, FMT_F16), Pass(t, 1, u, FMT_F16)]
    if t in ("outerGlow", "innerGlow"):
        sg, r, lv = _blur_plan(_num(e, "size"))
        u = [sg, r, 0, 0] + _col(e.get("color"), op)
        if lv:
            u += [float(lv)]
            return [Pass(t, 2, u, FMT_F16, lv), Pass(t, 3, u, FMT_F16, lv), Pass(t, 4, u, FMT_F16, lv), Pass(t, 5, u, FMT_F16)]
        return [Pass(t, 0, u, FMT_F16), Pass(t, 1, u, FMT_F16)]
    if t == "stroke":
        w = min(float(MAX_STROKE), _num(e, "width"))
        if w <= 0:
            return []
        pos = {"inside": 0, "center": 1, "outside": 2}.get(e.get("position", "outside"), 2)
        d = w / 2.0 + 1.0 if pos == 1 else w + 1.0
        steps = _jfa_steps(d)
        out = [Pass(t, 0, [k, 1.0 if i == 0 else 0.0], FMT_F32) for i, k in enumerate(steps)]
        out.append(Pass(t, 1, [pos, w, 0, 0] + _col(e.get("color"), op), FMT_F16))
        return out
    if t == "bevel":
        size = _num(e, "size")
        sg, r, lv = _blur_plan(size)
        a = _rad(_num(e, "angle", 120.0))
        depth = min(1.0, max(0.0, _num(e, "depth", 100.0) / 100.0))
        if lv:      # pyramid: head = (sigma_low, R_low, depth, L | Lx, Ly, sigma_full, 0); passes 2 down, 3 H, 4 V (level L), 5 up + light
            head = [sg, r, depth, float(lv), math.cos(a), -math.sin(a), min(float(MAX_RADIUS), max(0.0, size)) / 3.0, 0]
            full = head + _col(e.get("highlight")) + _col(e.get("shadow"))
            return [Pass(t, 2, head, FMT_F16, lv), Pass(t, 3, head, FMT_F16, lv), Pass(t, 4, head, FMT_F16, lv), Pass(t, 5, full, FMT_F16)]
        return [Pass(t, 0, [sg, r, depth, 0, math.cos(a), -math.sin(a)], FMT_F16),
                Pass(t, 1, [sg, r, depth, 0, math.cos(a), -math.sin(a), 0, 0]
                     + _col(e.get("highlight")) + _col(e.get("shadow")), FMT_F16)]
    if t == "colorOverlay":
        return [Pass(t, 0, _col(e.get("color"), op), FMT_F16)]
    if t == "pixelSort":
        axis = 1.0 if e.get("direction") == "v" else 0.0
        lo, hi = min(1.0, max(0.0, _num(e, "low", 0.0))), min(1.0, max(0.0, _num(e, "high", 1.0)))
        u = [axis, lo, hi, 1.0 if e.get("key") == "hue" else 0.0]
        return [Pass(t, 0, u, FMT_F32), Pass(t, 1, u, FMT_F32), Pass(t, 2, u, FMT_F16)]
    if t == "glitch":
        amount = min(100.0, max(0.0, _num(e, "amount")))
        u = [amount / 100.0, amount, max(1.0, float(_round(_num(e, "blockSize", 16.0)))), float(_round(_num(e, "seed")) % _SEED_MOD),
             min(256.0, max(0.0, _num(e, "rgbShift")))]
        return [Pass(t, 0, u, FMT_F16)]
    if t == "chromaticAberration":
        a = _rad(_num(e, "angle"))
        amt = _num(e, "amount")
        return [Pass(t, 0, [amt * math.cos(a), -amt * math.sin(a)], FMT_F16)]
    if t == "halftone":
        a = _rad(_num(e, "angle"))
        cs = max(1.0, _num(e, "cellSize", 8.0))
        return [Pass(t, 0, [cs, math.cos(a), math.sin(a), 1.0 if e.get("shape") == "line" else 0.0], FMT_F16)]
    return []


SORT_CHUNK = PIXEL_SORT_SPAN


def effect_extent(e):
    """(rx, ry, ax, ay): px an edit spreads along x / y, and the chunk alignment (px, 0 = none) the output region is widened to
    along x / y (pixel sort).  Mirrors effectExtent() in plan.ts."""
    ps = plan_effect(e)
    if not ps:
        return (0, 0, 0, 0)
    t = e["type"]
    if t in FILTER_SPECS:
        return filter_extent(e)

    def iso(r):
        return (r, r, 0, 0)

    if t == "dropShadow":
        r = _blur_reach(_num(e, "blur"))
        return (abs(_off(e, "dx")) + r, abs(_off(e, "dy")) + r, 0, 0)
    if t in ("outerGlow", "innerGlow"):
        return iso(_blur_reach(_num(e, "size")))
    if t == "stroke":      # jump flood: dependency radius = sum of the jump sizes (+1 edge test, +1 slack)
        return iso(int(sum(p.u[0] for p in ps if p.fmt == FMT_F32)) + 2)
    if t == "bevel":
        return iso(_blur_reach(_num(e, "size")) + 1)
    if t == "pixelSort":
        return (0, 0, 0, SORT_CHUNK) if e.get("direction") == "v" else (0, 0, SORT_CHUNK, 0)
    if t == "glitch":
        amount = min(100.0, max(0.0, _num(e, "amount")))
        return iso(int(math.ceil(amount)) + 2 * int(math.ceil(min(256.0, max(0.0, _num(e, "rgbShift"))) * 1.5)) + 2)
    if t == "chromaticAberration":
        return iso(int(math.ceil(abs(_num(e, "amount")))) + 2)
    if t == "halftone":
        return iso(int(math.ceil(1.5 * max(1.0, _num(e, "cellSize", 8.0)))) + 2)
    return (0, 0, 0, 0)


def effect_reach(e):
    """Conservative isotropic reach in px (pixel sort: 255, the widening to a 256 px chunk)."""
    rx, ry, ax, ay = effect_extent(e)
    return max(rx, ry, ax - 1 if ax else 0, ay - 1 if ay else 0)


def effects_reach(effects):
    return sum(effect_reach(e) for e in effects or ())


def plan_chain(effects):
    """Flat pass list for the enabled effects: [(effect_index, Pass), ...] with the formats resolved: the last pass of the
    chain is rgba8fixed, the last pass of every earlier effect rgba16float."""
    groups = [(i, plan_effect(e)) for i, e in enumerate(effects or ())]
    groups = [(i, ps) for i, ps in groups if ps]
    out = []
    for gi, (i, ps) in enumerate(groups):
        for pj, p in enumerate(ps):
            if pj == len(ps) - 1:
                p = p.with_fmt(FMT_U8 if gi == len(groups) - 1 else FMT_F16)
            out.append((i, p))
    return out


# --------------------------------------------------------------------------- shader sources


def _shared_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.environ.get("RASTER_EFFECTS_DIR"), os.path.join(here, "effects"),
                 os.path.join(os.path.dirname(os.path.dirname(here)), "shared", "effects")):
        if cand and os.path.isfile(os.path.join(cand, "common.glsl")):
            return cand
    raise FileNotFoundError("shared/effects/common.glsl not found (next to raster_editor/effects/ or ../../shared/effects)")


# v5 effects whose blur passes use the pyramid helpers; filters list their libraries in the spec ("include")
LEGACY_INCLUDES = {"dropShadow": ("filterlib", "blurlib"), "outerGlow": ("filterlib", "blurlib"), "innerGlow": ("filterlib", "blurlib"),
                   "bevel": ("filterlib", "blurlib")}


def shader_names():
    """Names of all shaders: v5 effects + every filter / helper shader with its own .glsl (spec ``"glsl": false`` = none)."""
    return list(EFFECT_TYPES) + [t for t, sp in sorted(FILTER_SPECS.items()) if sp.get("glsl", True) and t not in EFFECT_TYPES]


def shader_includes(name):
    sp = FILTER_SPECS.get(name)
    if not sp:
        return LEGACY_INCLUDES.get(name, ())
    inc = tuple(sp.get("include", ["filterlib"]))
    return inc + ("in2lib",) if sp.get("in2") and "in2lib" not in inc else inc


def shader_uses_input2(name):
    """True when every pass of this shader gets a third input (data texture, aux image or a dummy)."""
    sp = FILTER_SPECS.get(name)
    return bool(sp and sp.get("in2"))


def shader_stems():
    """Every shared/effects/<stem>.glsl a built component needs: common, all shaders and their include libraries."""
    stems = {"common"}
    for t in shader_names():
        stems.add(t)
        stems.update(shader_includes(t))
    return sorted(stems)


def load_shader_texts_from(texts):
    """{shader name: common + includes + shader} from ``texts`` = {stem: glsl source} (the embedded ``fx_<stem>`` DATs of a built
    component, or the files of shared/effects). Raises KeyError naming the missing stem."""
    def rd(n):
        if n not in texts:
            raise KeyError(f"shader source {n}.glsl is missing")
        return texts[n]
    common = rd("common")
    out = {}
    for t in shader_names():
        out[t] = common + "\n" + "".join(rd(i) + "\n" for i in shader_includes(t)) + rd(t)
    return out


def load_shader_texts(directory=None):
    """{shader name: common.glsl [+ filterlib.glsl, blurlib.glsl] + shader} read from shared/effects (or ``directory``)."""
    d = directory or _shared_dir()
    texts = {}
    for stem in shader_stems():
        with open(os.path.join(d, stem + ".glsl"), encoding="utf-8") as f:
            texts[stem] = f.read()
    return load_shader_texts_from(texts)


# --------------------------------------------------------------------------- TD node chain

_VEC_NAMES = ("uP0", "uP1", "uP2", "uP3", "uPass", "uSize")


class _Slot:
    __slots__ = ("op", "pars", "inputs", "init", "data_op", "data_dat", "data_digest")

    def __init__(self, op):
        self.op = op
        self.init = False     # static parameters (vector names, filtering) written
        self.pars = {}        # last values written (so a repeat apply writes nothing)
        self.inputs = [None, None, None]
        self.data_op = self.data_dat = None      # script TOP + callbacks DAT feeding a data texture (input 2)
        self.data_digest = None


_CB_TEMPLATE = """# generated by raster_editor.effects: data texture %(digest)s (RGBA8, row 0 = bottom)
import base64, zlib
import numpy as np
def onCook(scriptOp):
    a = np.frombuffer(zlib.decompress(base64.b64decode('%(blob)s')), np.uint8).reshape(%(h)d, %(w)d, 4).copy()
    scriptOp.copyNumpyArray(a)
"""


class EffectChain:
    """The GLSL TOP chain of one layer's effect stack inside ``parent``.

    ``shader_texts``  {shader name: full shader text} (``load_shader_texts``); one text DAT ``<dat_prefix><name>`` per shader
                      is created in ``parent`` on demand (shared by all chains of that parent).
    ``acquire/release`` optional node supply (e.g. network.py's pooled spare GLSL TOPs): ``acquire("glslTOP") -> op``,
                      ``release(op)`` (disconnect + park).  Default: ``parent.create`` / ``op.destroy``.  Data textures (curves, gradient
                      maps, LUTs) need one Script TOP + callbacks DAT per such pass: always created / destroyed in ``parent``.
    Nodes are named ``<prefix>_<k>`` when created here (data: ``<prefix>_d<k>`` / ``<prefix>_dcb<k>``); ``adopt=True`` (default) re-uses
    such nodes already present (file reload) -- their state is unknown so every parameter is rewritten once.

    Filters (docs/DESIGN_V6.md) use the same chain.  ``apply(effects, input_top, doc_w, doc_h, aux=None)``:
      * ``input_top`` for an ADJUSTMENT layer is the document-sized composite below it (no special casing: the chain only sees a TOP);
      * ``aux`` = optional TOP (document sized) read by filters that take a second image (displace by layer / input); when a filter needs it
        and none is given it renders with no displacement (the pass gets ``uPass.w`` fraction 0.5);
      * pyramid passes (``Pass.level`` > 0) run at ceil(size / 2^level) + 3, custom resolution taken from ``input_top`` (``doc_w/doc_h``
        as fallback).
    """

    def __init__(self, parent, prefix, shader_texts, acquire=None, release=None, dat_prefix="fxsrc_", pos=None, adopt=True):
        self.parent = parent
        self.prefix = prefix
        self.shader_texts = shader_texts
        self.dat_prefix = dat_prefix
        self._acquire = acquire
        self._release = release
        self._pos = pos
        self._slots = []
        self._out = None
        self._last_sig = None
        self.counters = {"par_sets": 0, "creates": 0, "destroys": 0, "connects": 0}
        if adopt:
            k = 0
            while acquire is None:
                op = parent.op("%s_%d" % (prefix, k))
                if op is None or not getattr(op, "valid", True):
                    break
                self._slots.append(_Slot(op))
                k += 1
            self._adopt_data_nodes()

    # -- helpers
    def _adopt_data_nodes(self):
        """After a file reload: data Script TOPs / callbacks DATs of this chain either belong to an adopted slot (re-used, rewritten once) or
        are orphans (slot gone) and are destroyed."""
        pat = re.compile(r"^%s_(d|dcb)(\d+)$" % re.escape(self.prefix))
        for c in list(self.parent.children):
            try:
                m = pat.match(c.name or "")
            except Exception:             # destroyed together with a sibling (companion DAT of a Script TOP)
                continue
            if not m:
                continue
            k = int(m.group(2))
            if k < len(self._slots):
                slot = self._slots[k]
                if m.group(1) == "d":
                    slot.data_op = c
                else:
                    slot.data_dat = c
            else:
                try:
                    c.destroy()
                except Exception:
                    pass
        for k, slot in enumerate(self._slots):
            if (slot.data_op is None) != (slot.data_dat is None):       # half a pair: start over
                self._drop_data(slot)

    def _dat_name(self, shader):
        return self.dat_prefix + shader

    def _ensure_dat(self, shader):
        name = self._dat_name(shader)
        dat = self.parent.op(name)
        if dat is None:
            dat = self.parent.create("textDAT", name)
        text = self.shader_texts[shader]
        if dat.text != text:
            dat.text = text
        return name

    def _set(self, slot, pars):
        for k, v in pars.items():
            if slot.pars.get(k, _MISSING) != v:
                setattr(slot.op.par, k, v)
                slot.pars[k] = v
                self.counters["par_sets"] += 1

    def _new_slot(self, index):
        if self._acquire is not None:
            op = self._acquire("glslTOP")
        else:
            op = self.parent.create("glslTOP", "%s_%d" % (self.prefix, index))
        self.counters["creates"] += 1
        slot = _Slot(op)
        if self._pos is not None:
            op.nodeX, op.nodeY = self._pos[0] + 200 * index, self._pos[1]
        return slot

    def _init_slot(self, slot):
        pars = {"inputfiltertype": "nearest", "outputresolution": "useinput"}
        for i, n in enumerate(_VEC_NAMES):
            pars["vec%dname" % i] = n
        self._set(slot, pars)
        slot.init = True

    def _drop_data(self, slot):
        for o in (slot.data_op, slot.data_dat):
            if o is not None:
                try:
                    o.destroy()
                except Exception:
                    pass
        if slot.data_op is not None:
            self.counters["destroys"] += 1
        slot.data_op = slot.data_dat = slot.data_digest = None

    def _drop_slot(self, slot):
        try:
            for c in slot.op.inputConnectors:
                c.disconnect()
        except Exception:
            pass
        if self._release is not None:
            self._release(slot.op)
        else:
            slot.op.destroy()
        self._drop_data(slot)
        self.counters["destroys"] += 1

    def _ensure_data(self, slot, index, data):
        """Script TOP holding ``data`` (DataTex) for the slot; rewritten only when the digest changes."""
        if slot.data_op is None:
            base = "%s_d%d" % (self.prefix, index)
            slot.data_op = self.parent.op(base) or self.parent.create("scriptTOP", base)
            slot.data_dat = self.parent.op("%s_dcb%d" % (self.prefix, index)) or self.parent.create("textDAT", "%s_dcb%d" % (self.prefix, index))
            auto = self.parent.op(base + "_callbacks")        # TD creates a default callbacks DAT with the Script TOP
            if auto is not None and auto is not slot.data_dat:
                try:
                    auto.destroy()
                except Exception:
                    pass
            slot.data_op.par.callbacks = slot.data_dat.name
            self.counters["creates"] += 1
            slot.data_digest = None
        if slot.data_digest != data.digest:
            blob = base64.b64encode(zlib.compress(data.data, 6)).decode("ascii")
            slot.data_dat.text = _CB_TEMPLATE % {"digest": data.digest, "blob": blob, "w": data.w, "h": data.h}
            slot.data_digest = data.digest
            self.counters["par_sets"] += 1
        return slot.data_op

    # -- API
    def apply(self, effects, input_top, doc_w=None, doc_h=None, aux=None):
        """Make the chain match ``effects`` (list of effect / filter dicts); returns the output TOP (``input_top`` when nothing is
        enabled).  See the class docstring for ``input_top`` (adjustment layers) and ``aux``."""
        passes = plan_chain(effects)
        if not passes:
            self.clear()
            return input_top
        n = len(passes)
        while len(self._slots) > n:
            self._drop_slot(self._slots.pop())
        while len(self._slots) < n:
            self._slots.append(self._new_slot(len(self._slots)))
        W = getattr(input_top, "width", None) or doc_w or 0
        H = getattr(input_top, "height", None) or doc_h or 0
        eff_in = input_top
        prev = input_top
        cur_eff = passes[0][0]
        for k, (ei, p) in enumerate(passes):
            if ei != cur_eff:                       # new effect: its input is the previous effect's last pass
                eff_in = prev
                cur_eff = ei
            slot = self._slots[k]
            if not slot.init:
                self._init_slot(slot)
            in2 = shader_uses_input2(p.shader)
            pars = {"pixeldat": self._ensure_dat(p.shader), "format": p.fmt}
            for v in range(4):
                for j, ax in enumerate("xyzw"):
                    pars["vec%dvalue%s" % (v, ax)] = p.u[v * 4 + j]
            pars["vec4valuex"] = float(p.pid)
            pars["vec4valuey"] = 0.0
            pars["vec4valuez"] = 0.0
            pars["vec4valuew"] = float(p.level) + (0.5 if (p.aux and aux is None) else 0.0)
            for ax in "xyzw":
                pars["vec5value" + ax] = 0.0           # uSize: 0 = the texture size (only the WebGL size buckets use it)
            if p.level and W and H:
                d = 1 << p.level
                pars["outputresolution"] = "custom"
                pars["resolutionw"] = (W + d - 1) // d + 3
                pars["resolutionh"] = (H + d - 1) // d + 3
            else:
                pars["outputresolution"] = "useinput"
            self._set(slot, pars)
            third = None
            if p.data is not None:
                third = self._ensure_data(slot, k, p.data)
            else:
                if slot.data_op is not None:
                    self._drop_data(slot)
                if p.aux:
                    third = aux if aux is not None else input_top
                elif in2:
                    third = input_top                   # dummy: every pass of an input-2 shader has three inputs
            want = [eff_in, prev, third]
            for i in (0, 1, 2):
                if slot.inputs[i] != want[i]:
                    if want[i] is None:
                        slot.op.inputConnectors[i].disconnect()
                    else:
                        slot.op.inputConnectors[i].connect(want[i])
                        self.counters["connects"] += 1
                    slot.inputs[i] = want[i]
            prev = slot.op
        self._out = prev
        return prev

    def clear(self):
        """Remove all nodes (no effect enabled)."""
        while self._slots:
            self._drop_slot(self._slots.pop())
        self._out = None

    def destroy(self):
        self.clear()

    @property
    def output(self):
        return self._out

    @property
    def node_count(self):
        return len(self._slots)

    @property
    def nodes(self):
        return [s.op for s in self._slots]


_MISSING = object()


# BEGIN EMBEDDED FILTER SPECS (generated: .venv/bin/python scripts/effects_dev.py sync; checked by td/tests/test_effects.py)
_EMBEDDED_SPECS = '{"bloom":{"degenerate":[{},{"radius":0},{"intensity":0},{"intensity":1000000000.0,"knee":-1,"radius":1000000000.0,"threshold":5},{"tint":"red"},{"tint":{"a":0,"b":0,"g":0,"r":0}},{"radius":33,"threshold":1}],"doc":"Bloom: the bright part of the image (soft threshold on luma, see blur threshold/knee) is blurred with a gaussian of `radius` px (pyramid above 32 px), multiplied by intensity and tint and screen blended over the original with premultiplied maths: out = c + B - c*B on rgb and alpha, B = blurred * tint * intensity (clamped to 0..1), so glow also spreads into transparent surroundings (alpha = union coverage). threshold 0 blooms the whole image.","extent":["blurReach(radius)","blurReach(radius)","0","0"],"group":"stylise","noop":"radius <= 0 || intensity <= 0 || tint.a <= 0","params":{"intensity":{"default":100,"kind":"num","max":300,"min":0,"unit":"%"},"knee":{"default":0.2,"doc":"soft knee width of the threshold","kind":"num","max":1,"min":0},"radius":{"default":20,"kind":"num","max":200,"min":0,"unit":"px"},"threshold":{"default":0.7,"doc":"luma above which pixels glow; 0 = everything","kind":"num","max":1,"min":0},"tint":{"default":{"a":255,"b":255,"g":255,"r":255},"kind":"color"}},"passes":[{"sub":"blur","with":{"knee":"knee","radius":"radius","threshold":"threshold"}},{"pass":0,"u":["intensity / 100","tint.r","tint.g","tint.b","tint.a"]}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"intensity":150,"knee":0.2,"radius":8,"threshold":0.3},{"intensity":250,"knee":0.1,"radius":60,"threshold":0.5,"tint":{"a":255,"b":120,"g":200,"r":255}},{"intensity":100,"radius":15,"threshold":0}],"type":"bloom"},"blur":{"degenerate":[{},{"radius":0},{"radius":-5},{"radius":1000000000.0},{"radius":"12"},{"radius":16},{"radius":17},{"radius":33},{"radius":200.5}],"doc":"Gaussian blur of the premultiplied layer (radius = kernel half width, sigma = radius / 3). Radii above 16 px run as a down-sample pyramid. threshold/knee (bloom building block): blur only the bright part of the image (soft threshold on luma).","extent":["blurReach(px)","blurReach(px)","0","0"],"group":"blur","include":["filterlib","blurlib"],"noop":"px <= 0","params":{"knee":{"default":0,"doc":"soft knee width of the bright pass","kind":"num","max":1,"min":0},"radius":{"default":10,"kind":"num","max":200,"min":0,"unit":"px"},"threshold":{"default":0,"doc":"0 = blur everything; >0: only luma above it (bright pass)","kind":"num","max":1,"min":0}},"passes":[{"pass":0,"u":["sig","R","mode","0","threshold","knee"],"when":"L == 0"},{"pass":1,"u":["sig","R","mode","0","threshold","knee"],"when":"L == 0"},{"level":"L","pass":2,"u":["sig","R","mode","L","threshold","knee"],"when":"L > 0"},{"level":"L","pass":3,"u":["sig","R","mode","L","threshold","knee"],"when":"L > 0"},{"level":"L","pass":4,"u":["sig","R","mode","L","threshold","knee"],"when":"L > 0"},{"pass":5,"u":["sig","R","mode","L","threshold","knee"],"when":"L > 0"}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"radius":6},{"radius":40},{"knee":0.2,"radius":150,"threshold":0.4}],"type":"blur","vars":[["px","radius"],["L","pyrL(px)"],["sig","blurSig(px)"],["R","blurR(px)"],["mode","if(threshold > 0, 3, 2)"]]},"channelMixer":{"degenerate":[{},{"gg":-1000000000.0,"rr":1000000000.0},{"grayBlue":0,"grayGreen":-1000000000.0,"grayRed":1000000000.0,"monochrome":true},{"r":null,"rr":"a"},{"monochrome":1,"r":500}],"doc":"Channel mixer on straight colour: R\' = rr R + rg G + rb B + r, G\' = gr R + gg G + gb B + g, B\' = br R + bg G + bb B + b (coefficients in % / 100, constants in % of full scale / 100), clamped to 0..1. With `monochrome` the matrix and constants are ignored and all three outputs equal grayRed R + grayGreen G + grayBlue B (weights in % / 100, default 30/59/11), clamped. Alpha unchanged.","extent":["0","0","0","0"],"group":"color","noop":"!monochrome && rr == 100 && rg == 0 && rb == 0 && gr == 0 && gg == 100 && gb == 0 && br == 0 && bg == 0 && bb == 100 && r == 0 && g == 0 && b == 0","params":{"b":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"bb":{"default":100,"kind":"num","max":200,"min":-200,"unit":"%"},"bg":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"br":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"g":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"gb":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"gg":{"default":100,"kind":"num","max":200,"min":-200,"unit":"%"},"gr":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"grayBlue":{"default":11,"kind":"num","max":200,"min":-200,"unit":"%"},"grayGreen":{"default":59,"kind":"num","max":200,"min":-200,"unit":"%"},"grayRed":{"default":30,"kind":"num","max":200,"min":-200,"unit":"%"},"monochrome":{"default":false,"kind":"bool"},"r":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"rb":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"rg":{"default":0,"kind":"num","max":200,"min":-200,"unit":"%"},"rr":{"default":100,"kind":"num","max":200,"min":-200,"unit":"%"}},"passes":[{"pass":0,"u":["rr / 100","rg / 100","rb / 100","gr / 100","gg / 100","gb / 100","br / 100","bg / 100","bb / 100","r / 100","g / 100","b / 100","monochrome","grayRed / 100","grayGreen / 100","grayBlue / 100"]}],"preservesTransparent":true,"reads":"point","samples":[{"bb":0,"br":100,"rb":100,"rg":0,"rr":0},{"monochrome":true},{"b":-15,"gb":20,"gg":80,"r":10,"rg":-30,"rr":120}],"type":"channelMixer"},"colorBalance":{"degenerate":[{},{"highlightsYellowBlue":-1000000000.0,"shadowsCyanRed":1000000000.0},{"midtonesCyanRed":"5"},{"preserveLuminosity":2,"shadowsMagentaGreen":-300},{"highlightsMagentaGreen":null,"midtonesYellowBlue":true}],"doc":"Colour balance (Photoshop style): per tonal range (shadows / midtones / highlights) a shift along cyan-red, magenta-green and yellow-blue (-100..100 %; positive = more red / green / blue, negative = more cyan / magenta / yellow). With L = Rec.709 luma of the straight colour: weights ws = (1-L)^2, wh = L^2, wm = 1 - ws - wh = 2 L (1-L) (they sum to 1). out = clamp(c + 0.5 * sum_range w_range * (cyanRed, magentaGreen, yellowBlue) / 100) per channel (a +100 shift at full weight adds 0.5). With `preserveLuminosity` the result is offset by (L(c) - L(out)) per channel so the Rec.709 luma stays the same (then clamped). Alpha unchanged.","extent":["0","0","0","0"],"group":"color","noop":"shadowsCyanRed == 0 && shadowsMagentaGreen == 0 && shadowsYellowBlue == 0 && midtonesCyanRed == 0 && midtonesMagentaGreen == 0 && midtonesYellowBlue == 0 && highlightsCyanRed == 0 && highlightsMagentaGreen == 0 && highlightsYellowBlue == 0","params":{"highlightsCyanRed":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"highlightsMagentaGreen":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"highlightsYellowBlue":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"midtonesCyanRed":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"midtonesMagentaGreen":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"midtonesYellowBlue":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"preserveLuminosity":{"default":true,"kind":"bool"},"shadowsCyanRed":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"shadowsMagentaGreen":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"shadowsYellowBlue":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"}},"passes":[{"pass":0,"u":["shadowsCyanRed / 100","shadowsMagentaGreen / 100","shadowsYellowBlue / 100","midtonesCyanRed / 100","midtonesMagentaGreen / 100","midtonesYellowBlue / 100","highlightsCyanRed / 100","highlightsMagentaGreen / 100","highlightsYellowBlue / 100","preserveLuminosity"]}],"preservesTransparent":true,"reads":"point","samples":[{"highlightsMagentaGreen":-50,"midtonesYellowBlue":60,"shadowsCyanRed":40},{"midtonesCyanRed":-80,"midtonesMagentaGreen":30,"preserveLuminosity":false},{"highlightsCyanRed":100,"highlightsYellowBlue":-100,"shadowsYellowBlue":100}],"type":"colorBalance"},"colorCycle":{"degenerate":[{},{"hueStep":0},{"bands":1000000000.0,"hueStep":1000000000.0,"iterations":1000000000.0,"lumaWarp":1000000000.0,"saturationBoost":1000000000.0},{"bands":1,"hueStep":"x","iterations":-1},{"bands":2,"hueStep":-180,"iterations":64}],"doc":"Colour cycling (a static frame of palette cycling), point operation on the straight colour in YIQ (the (I,Q) chroma plane is rotated, Y and chroma magnitude are kept). s0 = colour; for each of `iterations` steps: luma = Rec.709 luma of the previous result, phase += hueStep * (1 + lumaWarp/100 * (2*luma - 1)) degrees, s = clamp(rotate(s0, phase)). With bands >= 2 the rotation uses the phase snapped to multiples of 360/bands (bands 0 or 1 = smooth). Finally chroma is scaled by 1 + saturationBoost/100. Because luma is re-evaluated each step the loop is not a single rotation (it is, when lumaWarp = 0: total rotation iterations * hueStep). Alpha unchanged; hueStep 0 = no-op.","extent":["0","0","0","0"],"group":"animated","noop":"hueStep == 0","params":{"bands":{"default":0,"doc":"0 or 1 = smooth, 2..64 = number of phase steps per turn","kind":"num","max":64,"min":0,"round":true,"unit":"bands"},"hueStep":{"default":30,"doc":"hue rotation per iteration","kind":"num","max":180,"min":-180,"unit":"deg"},"iterations":{"default":8,"kind":"num","max":64,"min":1,"round":true,"unit":"steps"},"lumaWarp":{"default":50,"doc":"how strongly luma scales the step: step * (1 + lumaWarp * (2*luma - 1)), bright pixels cycle faster","kind":"num","max":100,"min":0,"unit":"%"},"saturationBoost":{"default":0,"doc":"final chroma scale 1 + boost","kind":"num","max":100,"min":0,"unit":"%"}},"passes":[{"pass":0,"u":["iterations","hueStep","lumaWarp / 100","saturationBoost / 100","bands","0","0","0"]}],"preservesTransparent":true,"reads":"point","samples":[{"bands":0,"hueStep":40,"iterations":3,"lumaWarp":60,"saturationBoost":20},{"bands":6,"hueStep":-25,"iterations":12,"lumaWarp":100,"saturationBoost":0},{"bands":0,"hueStep":120,"iterations":1,"lumaWarp":0,"saturationBoost":50}],"type":"colorCycle"},"crt":{"degenerate":[{},{"curvature":0,"glow":0,"mask":"none","scanlines":0,"vignette":0},{"scanlinePeriod":0,"scanlines":1000000000.0},{"curvature":1000000000.0,"glow":1000000000.0,"maskStrength":1000000000.0,"vignette":1000000000.0},{"curvature":-5,"mask":"bogus"},{"mask":"slot","maskStrength":0,"scanlinePeriod":"x"}],"doc":"CRT monitor look in one pass, on premultiplied rgb (alpha kept inside the screen), formulas: curvature: barrel uv\' = uv + uv*(uv.yx)^2*0.4*curvature (uv = -1..1 over the document), source read bilinearly at uv\', outputs outside the curved screen are opaque black (bezel); glow: 5x5 taps (2 px spacing) mean of max(c-0.5,0)*2, added with weight 2*glow; scanlines: rgb *= 1 - scanlines*(1 - (0.5-0.5cos(2 pi (y mod period + 0.5)/period))); mask \'aperture\': document column x mod 3 selects R/G/B, other channels multiplied by 1 - maskStrength, \'slot\' adds dark gaps every 4th row per triad (staggered 2 rows on odd triads); vignette: rgb *= 1 - vignette*(uv.x^2+uv.y^2)/2. Scanlines, mask and vignette work in output (screen) coordinates. The bezel edge is a hard decision on float positions.","extent":["if(curvature > 0, G, if(glow > 0, 4, 0))","if(curvature > 0, G, if(glow > 0, 4, 0))","0","0"],"group":"stylise","noop":"scanlines <= 0 && (mask == 0 || maskStrength <= 0) && curvature <= 0 && vignette <= 0 && glow <= 0","params":{"curvature":{"default":15,"kind":"num","max":100,"min":0,"unit":"%"},"glow":{"default":25,"kind":"num","max":100,"min":0,"unit":"%"},"mask":{"default":"aperture","kind":"enum","values":["none","aperture","slot"]},"maskStrength":{"default":40,"kind":"num","max":100,"min":0,"unit":"%"},"scanlinePeriod":{"default":3,"kind":"num","max":16,"min":2,"round":true,"unit":"px"},"scanlines":{"default":40,"kind":"num","max":100,"min":0,"unit":"%"},"vignette":{"default":25,"kind":"num","max":100,"min":0,"unit":"%"}},"passes":[{"pass":0,"u":["scanlines / 100","scanlinePeriod","if(mk > 0, mask, 0)","mk","curvature / 100","vignette / 100","glow / 100"]}],"preservesTransparent":false,"reads":"neighbourhood","readsGlobal":"curvature > 0","samples":[{"curvature":0,"glow":0,"mask":"aperture","maskStrength":50,"scanlinePeriod":3,"scanlines":60,"vignette":0},{"curvature":30,"glow":30,"mask":"slot","maskStrength":60,"scanlinePeriod":4,"scanlines":40,"vignette":40},{"curvature":0,"glow":50,"mask":"none","scanlines":0,"vignette":70}],"type":"crt","vars":[["mk","if(mask == 0, 0, maskStrength / 100)"]]},"curves":{"degenerate":[{},{"master":[]},{"master":[[0.5,0.5]]},{"master":[[2,-1],[0.3,7],[0.3,0.2],["a",1]]},{"red":"bad"},{"green":[[0,0],[0.5,1],[1,0]]}],"doc":"Curves: master (RGB) and per-channel curves through control points (x, y in 0..1), monotone cubic interpolation baked into a 256 entry LUT texture (input 2); channel curve is applied after the master curve. Straight colour in, alpha unchanged. Points as [x, y] or {x, y}; at most 32; x outside 0..1 clamped, equal x: last wins; no points = identity.","extent":["0","0","0","0"],"group":"color","in2":true,"params":{"blue":{"default":[[0,0],[1,1]],"kind":"points"},"green":{"default":[[0,0],[1,1]],"kind":"points"},"master":{"default":[[0,0],[1,1]],"kind":"points"},"red":{"default":[[0,0],[1,1]],"kind":"points"}},"passes":[{"data":{"args":["master","red","green","blue"],"gen":"curves"},"pass":0,"u":["0"]}],"preservesTransparent":true,"reads":"point","samples":[{"master":[[0,0],[0.25,0.15],[0.75,0.9],[1,1]]},{"blue":[[0,0],[1,0.6]],"master":[[0,0],[1,1]],"red":[[0,0.1],[0.5,0.7],[1,0.9]]},{"master":[{"x":0,"y":1},{"x":1,"y":0}]}],"type":"curves"},"displace":{"degenerate":[{},{"strengthX":0,"strengthY":0},{"octaves":99,"scale":0,"strengthX":1000000000.0,"strengthY":-1000000000.0},{"edge":"bogus","source":"bogus"},{"seed":-7}],"doc":"Displace: out(p) = in(p + offset(p)). source \'noise\': offset = (fbm(p / scale, seed) * 2 - 1) * strength per axis (value noise, deterministic); source \'aux\': offset = (aux.rg * 2 - 1) * strength where aux is the chain\'s second image (straight colour, 0.5 = no shift; document sized; transparent aux pixels shift nothing; absent aux = no displacement). edge: what is read outside the document.","extent":["reach","reach","0","0"],"group":"distort","in2":true,"noop":"smax == 0","params":{"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"octaves":{"default":2,"kind":"num","max":6,"min":1,"round":true},"scale":{"default":64,"doc":"noise feature size","kind":"num","max":4000,"min":1,"unit":"px"},"seed":{"default":0,"kind":"seed"},"source":{"default":"noise","kind":"enum","values":["noise","aux"]},"strengthX":{"default":20,"kind":"num","max":500,"min":-500,"unit":"px"},"strengthY":{"default":20,"kind":"num","max":500,"min":-500,"unit":"px"}},"passes":[{"aux":true,"pass":0,"u":["source","strengthX","strengthY","edge","scale","octaves","seed"]}],"preservesTransparent":false,"reads":"neighbourhood","readsGlobal":"edge != 0","samples":[{"octaves":3,"scale":40,"seed":5,"source":"noise","strengthX":14,"strengthY":-9},{"edge":"clamp","source":"aux","strengthX":12,"strengthY":12},{"edge":"wrap","scale":20,"seed":99,"source":"noise","strengthX":30,"strengthY":30}],"type":"displace","vars":[["smax","max(abs(strengthX), abs(strengthY))"],["reach","if(edge == 0, ceil(smax) + 2, G)"]]},"dither":{"degenerate":[{},{"strength":0},{"levels":0},{"levels":1000000000.0,"matrix":1000000000.0},{"levels":2,"matrix":-3,"mode":"diffusion"},{"colour":"x","mode":"bogus"},{"levels":16,"mode":"diffusion","strength":1000000000.0}],"doc":"Dither: quantise to `levels` values per channel (0 and 1 included) with \'ordered\' Bayer dithering (matrix 2, 4 or 8, tiled on the document origin) or \'diffusion\'. colour=false quantises the luma and outputs grey. strength mixes the dithered result with the original. Alpha unchanged. \'diffusion\' is a WINDOWED Floyd-Steinberg (7,3,5,1)/16 error diffusion: true error diffusion is sequential over the whole image (each pixel depends on all previous ones), which a GPU cannot do and which would make a region render depend on the whole document. Instead every pixel re-simulates the algorithm in integer arithmetic (8-bit straight colour * 16, floor shifts) over the causal window of rows y-6..y and columns x-12..x+6 (left to right, no serpentine, the error entering the window from its top row and left column is a pseudo-random value in +-half a step hashed from the document position, because otherwise every pixel of a flat area would simulate the same window and get the same value) and outputs the result for its own position. The error propagation is therefore truncated to 6 rows / ~12 columns: it is an approximation of true error diffusion (same look and local tone reproduction, but not bit-identical to a sequential run, and the pattern differs slightly near where the window starts), exactly reproducible on every GPU because no float accumulation is involved.","extent":["if(mode == 1, 12, 0)","if(mode == 1, 6, 0)","0","0"],"group":"stylise","noop":"strength <= 0","params":{"colour":{"default":true,"kind":"bool"},"levels":{"default":4,"kind":"num","max":16,"min":2,"round":true,"unit":"levels per channel"},"matrix":{"default":4,"doc":"Bayer matrix size, 2 | 4 | 8 (3 -> 4, 5..7 -> 8); ordered mode only","kind":"num","max":8,"min":2,"round":true,"unit":"px"},"mode":{"default":"ordered","kind":"enum","values":["ordered","diffusion"]},"strength":{"default":100,"kind":"num","max":100,"min":0,"unit":"%"}},"passes":[{"pass":0,"u":["mode","levels","msz","colour","strength / 100"]}],"preservesTransparent":true,"reads":"neighbourhood","samples":[{"colour":true,"levels":3,"matrix":4,"mode":"ordered","strength":100},{"colour":false,"levels":2,"matrix":8,"mode":"ordered"},{"colour":true,"levels":3,"mode":"diffusion"},{"colour":false,"levels":2,"mode":"diffusion","strength":70}],"type":"dither","vars":[["msz","if(matrix <= 2, 2, if(matrix <= 4, 4, 8))"]]},"driftGlitch":{"degenerate":[{},{"amount":0},{"amount":1000000000.0,"blockSize":0,"density":1000000000.0,"iterations":1000000000.0,"rgbShift":1000000000.0},{"axis":"bogus","seed":-5},{"amount":"x","density":-1,"iterations":-3}],"doc":"Drift glitch (static version of an animated glitch): the document is cut into bands of blockSize px (axis h: horizontal strips shifted along x; v: vertical strips shifted along y; band index = floor(doc coordinate / blockSize)). Over `iterations` steps every band\'s offset random-walks: at step i, with probability density % (hash of seed, band, i) the band moves by (u - 0.5) * 2 * amount px, u in [0,1) another hash. Total offset o (px, |o| <= iterations * amount). Green is read at round(o), red at round(o + k), blue at round(o - k), k = o * rgbShift / amount (so the colour split grows with the drift, |k| <= iterations * rgbShift); out(x) = in(x - shift). Transparent outside the layer (no wrap); alpha = max of the three channel alphas. Deterministic: pure function of input + parameters.","extent":["if(axis == 0, reach, 0)","if(axis == 1, reach, 0)","0","0"],"group":"animated","noop":"amount <= 0 || density <= 0","params":{"amount":{"default":8,"doc":"maximum offset change of a band per step","kind":"num","max":500,"min":0,"unit":"px"},"axis":{"default":"h","doc":"h: horizontal bands shifted along x; v: vertical bands shifted along y","kind":"enum","values":["h","v"]},"blockSize":{"default":16,"doc":"band thickness, document aligned","kind":"num","max":500,"min":1,"round":true,"unit":"px"},"density":{"default":40,"doc":"probability that a band moves in a step","kind":"num","max":100,"min":0,"unit":"%"},"iterations":{"default":8,"kind":"num","max":64,"min":1,"round":true,"unit":"steps"},"rgbShift":{"default":4,"doc":"red/blue split per amount of drift: k = o * rgbShift / amount","kind":"num","max":64,"min":0,"unit":"px"},"seed":{"default":0,"kind":"seed"}},"passes":[{"pass":0,"u":["iterations","amount","blockSize","density / 100","rgbShift","seed","axis","0"]}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"amount":10,"blockSize":8,"density":70,"iterations":6,"rgbShift":3,"seed":3},{"amount":6,"axis":"v","blockSize":12,"density":50,"iterations":20,"rgbShift":0,"seed":11},{"amount":30,"blockSize":4,"density":100,"iterations":64,"rgbShift":8,"seed":99}],"type":"driftGlitch","vars":[["reach","min(G, ceil(iterations * (amount + rgbShift)) + 2)"]]},"duotone":{"degenerate":[{},{"amount":0},{"amount":1000000000.0,"contrast":1000000000.0},{"contrast":-1000000000.0},{"highlight":null,"mid":"x","shadow":5,"useMid":1},{"shadow":{"b":"a","g":900,"r":-50}}],"doc":"Duotone / tritone: t = Rec.709 luma of the straight colour, contrast applied about 0.5 (t\' = clamp((t - 0.5) k + 0.5), k = 1 + contrast/50 for contrast >= 0, 1 + contrast/100 for contrast < 0). Colour = mix(shadow, highlight, t\'); with `useMid` three colours: t\' < 0.5 -> mix(shadow, mid, 2 t\'), else mix(mid, highlight, 2 t\' - 1). The result is mixed with the original colour by amount / 100. Colour alpha values are ignored; the layer alpha is unchanged.","extent":["0","0","0","0"],"group":"color","noop":"amount <= 0","params":{"amount":{"default":100,"kind":"num","max":100,"min":0,"unit":"%"},"contrast":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"highlight":{"default":{"a":255,"b":150,"g":214,"r":255},"kind":"color"},"mid":{"default":{"a":255,"b":110,"g":60,"r":200},"kind":"color"},"shadow":{"default":{"a":255,"b":64,"g":8,"r":16},"kind":"color"},"useMid":{"default":false,"kind":"bool"}},"passes":[{"pass":0,"u":["shadow.r","shadow.g","shadow.b","highlight.r","highlight.g","highlight.b","mid.r","mid.g","mid.b","useMid","k","amount / 100"]}],"preservesTransparent":true,"reads":"point","samples":[{},{"contrast":40,"useMid":true},{"amount":70,"contrast":-50,"highlight":{"a":255,"b":255,"g":255,"r":255},"shadow":{"a":0,"b":0,"g":40,"r":0}}],"type":"duotone","vars":[["k","if(contrast >= 0, 1 + contrast / 50, 1 + contrast / 100)"]]},"echo":{"degenerate":[{},{"iterations":1},{"decay":1000000000.0,"dx":1000000000.0,"dy":-1000000000.0,"iterations":1000000000.0},{"blend":"bogus","fade":"bogus"},{"decay":100,"dx":-500,"dy":500,"fade":"linear","iterations":64}],"doc":"Echo: translation-only feedback. Echo i (i = 0..iterations-1; 0 = the input itself) is the input shifted by i * (dx, dy) px (bilinear, transparent outside) with opacity w_i = decay^i (fade \'exp\') or max(0, 1 - i * (1 - decay)) (fade \'linear\'), decay = decay % / 100. Composited in order of i: \'over\' = later echoes behind the earlier ones (input on top), \'add\' = premultiplied sum (clamped), \'lighten\' = per-channel max of premultiplied values. Uses the feedback shader (one pass). iterations = 1 or decay 0 leaves the input unchanged.","extent":["rx","ry","0","0"],"glsl":false,"group":"animated","noop":"iterations <= 1 || decay <= 0","params":{"blend":{"default":"over","kind":"enum","values":["over","add","lighten"]},"decay":{"default":80,"doc":"opacity multiplier per echo (exp) / linear drop is 100 - decay % per echo","kind":"num","max":100,"min":0,"unit":"%"},"dx":{"default":12,"doc":"shift per echo (right +)","kind":"num","max":500,"min":-500,"unit":"px"},"dy":{"default":0,"doc":"shift per echo (down +)","kind":"num","max":500,"min":-500,"unit":"px"},"fade":{"default":"exp","kind":"enum","values":["linear","exp"]},"iterations":{"default":8,"kind":"num","max":64,"min":1,"round":true,"unit":"echoes (including the original)"}},"passes":[{"pass":0,"shader":"feedback","u":["iterations","dx","dy","1","0","1","decay / 100","blend","0.5","0.5","fadeMode","0"]}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"blend":"over","decay":80,"dx":12,"dy":0,"fade":"exp","iterations":8},{"blend":"add","decay":85,"dx":-6,"dy":5,"fade":"linear","iterations":6},{"blend":"lighten","decay":90,"dx":3,"dy":7,"fade":"linear","iterations":10}],"type":"echo","vars":[["rx","min(G, ceil((iterations - 1) * abs(dx)) + 2)"],["ry","min(G, ceil((iterations - 1) * abs(dy)) + 2)"],["fadeMode","if(fade == 0, 1, 0)"]]},"edgeDetect":{"degenerate":[{},{"strength":0},{"mode":"overlay","strength":0},{"strength":1000000000.0,"threshold":5},{"invert":"yes","threshold":-1},{"method":"bogus","mode":"bogus"}],"doc":"Edge detection on the luma (Rec.709) of the premultiplied colour, 3x3 neighbourhood (one value for all channels). sobel: e = sqrt(gx^2+gy^2)/4; laplacian: e = |8c - sum of the 8 neighbours|/4. e = clamp(e * strength); values below threshold become 0. mode \'edges\': straight grey = e (invert: 1 - e); mode \'overlay\': straight colour = original + e (invert: original - e). Alpha unchanged.","extent":["1","1","0","0"],"group":"stylise","noop":"strength <= 0 && mode == 1","params":{"invert":{"default":false,"kind":"bool"},"method":{"default":"sobel","kind":"enum","values":["sobel","laplacian"]},"mode":{"default":"edges","kind":"enum","values":["edges","overlay"]},"strength":{"default":100,"kind":"num","max":500,"min":0,"unit":"%"},"threshold":{"default":0,"doc":"edge values below this become 0 (applied after strength)","kind":"num","max":1,"min":0}},"passes":[{"pass":0,"u":["method","strength / 100","threshold","invert","mode"]}],"preservesTransparent":true,"reads":"neighbourhood","samples":[{"method":"sobel","strength":300,"threshold":0.02},{"invert":true,"method":"laplacian","strength":400},{"method":"sobel","mode":"overlay","strength":200}],"type":"edgeDetect"},"emboss":{"degenerate":[{},{"amount":0},{"amount":0,"mode":"overlay"},{"amount":1000000000.0,"angle":1000000000.0,"height":1000000000.0},{"angle":"x","height":-3},{"mode":"bogus"}],"doc":"Emboss (Photoshop style): relief = amount * (luma(p - L*height) - luma(p + L*height)) where L is the unit vector towards the light (angle 0 = light from the right, counter-clockwise on screen) and luma is Rec.709 of the premultiplied colour (transparent = flat), taps are bilinear. mode \'gray\': straight colour = 0.5 + relief (flat areas become mid grey); mode \'overlay\': straight colour = original + relief. Result clamped to 0..1, alpha unchanged.","extent":["height + 1","height + 1","0","0"],"group":"stylise","noop":"amount <= 0 && mode == 1","params":{"amount":{"default":100,"kind":"num","max":500,"min":0,"unit":"%"},"angle":{"default":135,"doc":"light direction, 0 = from the right, counter-clockwise on screen (90 = from above)","kind":"num","max":360,"min":-360,"unit":"deg"},"height":{"default":2,"doc":"sample distance on each side of the pixel","kind":"num","max":10,"min":1,"unit":"px"},"mode":{"default":"gray","kind":"enum","values":["gray","overlay"]}},"passes":[{"pass":0,"u":["dx","dy","height","amount / 100","mode"]}],"preservesTransparent":true,"reads":"neighbourhood","samples":[{"amount":300,"angle":135,"height":2,"mode":"gray"},{"amount":200,"angle":0,"height":1,"mode":"overlay"},{"amount":500,"angle":-45,"height":7.5,"mode":"gray"}],"type":"emboss","vars":[["dx","cos(rad(angle))"],["dy","-sin(rad(angle))"]]},"feedback":{"degenerate":[{},{"iterations":1},{"decay":1000000000.0,"dx":1000000000.0,"dy":-1000000000.0,"iterations":1000000000.0,"rotate":1000000000.0,"scale":0},{"blend":"bogus","scale":1000000000.0},{"centerX":-4,"centerY":"x","decay":100,"iterations":64,"rotate":180,"scale":50}],"doc":"Video feedback trail frozen after `iterations` frames. Layers i = 0..iterations-1 are the input transformed i times by T (about the centre c = (centerX, centerY) * document size: scale about c by scale %, rotate by `rotate` degrees clockwise, then translate by (dx, dy) px), each with opacity decay^i, composited into the running result in order of i: \'over\' = newer iterations behind the older ones (the untransformed input is on top, exact compositing of the copies), \'add\' = premultiplied sum, \'lighten\' = per-channel max of premultiplied colour/alpha, \'screen\' = a + b - a*b on premultiplied channels. Bilinear resampling, transparent outside the layer. One pass, <= 63 taps per pixel. iterations = 1 (or decay 0) leaves the input unchanged.","extent":["rx","ry","0","0"],"group":"animated","noop":"iterations <= 1 || decay <= 0","params":{"blend":{"default":"over","kind":"enum","values":["over","add","lighten","screen"]},"centerX":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document height"},"decay":{"default":80,"doc":"opacity multiplier per iteration","kind":"num","max":100,"min":0,"unit":"%"},"dx":{"default":10,"doc":"translation per iteration (right +)","kind":"num","max":500,"min":-500,"unit":"px"},"dy":{"default":6,"doc":"translation per iteration (down +)","kind":"num","max":500,"min":-500,"unit":"px"},"iterations":{"default":8,"kind":"num","max":64,"min":1,"round":true,"unit":"frames"},"rotate":{"default":0,"doc":"rotation per iteration, clockwise on screen","kind":"num","max":180,"min":-180,"unit":"deg"},"scale":{"default":100,"doc":"scale per iteration about the centre","kind":"num","max":200,"min":50,"unit":"%"}},"passes":[{"pass":0,"u":["iterations","dx","dy","cos(rad(rotate))","sin(rad(rotate))","scale / 100","decay / 100","blend","centerX","centerY","0","0"]}],"preservesTransparent":false,"reads":"neighbourhood","readsGlobal":"!(rotate == 0 && scale == 100)","samples":[{"blend":"over","decay":80,"dx":10,"dy":6,"iterations":8},{"blend":"add","centerX":0.4,"centerY":0.5,"decay":85,"dx":4,"dy":-3,"iterations":10,"rotate":12,"scale":92},{"blend":"lighten","decay":90,"dx":0,"dy":0,"iterations":12,"rotate":-8,"scale":108},{"blend":"screen","decay":70,"dx":-7,"dy":5,"iterations":6,"rotate":5,"scale":100}],"type":"feedback","vars":[["pure","rotate == 0 && scale == 100"],["rx","if(pure, min(G, ceil((iterations - 1) * abs(dx)) + 2), G)"],["ry","if(pure, min(G, ceil((iterations - 1) * abs(dy)) + 2), G)"]]},"gradientMap":{"degenerate":[{},{"amount":0},{"amount":1000000000.0},{"stops":[]},{"stops":"bad"},{"stops":[{"color":5,"pos":2},{"pos":-1},{"color":{"r":1}}]},{"amount":"50","reverse":"yes"}],"doc":"Gradient map: the Rec.709 luma L = 0.2126 R + 0.7152 G + 0.0722 B of the straight colour (stored sRGB values, 0..1; 1 - L when `reverse`) indexes a 256 entry gradient LUT built from `stops` (piecewise linear colour interpolation, flat before the first / after the last stop); linear interpolation between LUT entries. The result is mixed with the original colour by `amount` / 100. The alpha of the stops is IGNORED (only the stop colours map); the layer alpha is unchanged.","extent":["0","0","0","0"],"group":"color","in2":true,"noop":"amount <= 0","params":{"amount":{"default":100,"kind":"num","max":100,"min":0,"unit":"%"},"reverse":{"default":false,"kind":"bool"},"stops":{"default":[[0,{"a":255,"b":0,"g":0,"r":0}],[1,{"a":255,"b":255,"g":255,"r":255}]],"kind":"stops"}},"passes":[{"data":{"args":["stops"],"gen":"gradient"},"pass":0,"u":["reverse","amount / 100"]}],"preservesTransparent":true,"reads":"point","samples":[{"stops":[{"color":{"a":255,"b":80,"g":0,"r":20},"pos":0},{"color":{"a":255,"b":60,"g":40,"r":220},"pos":0.5},{"color":{"a":255,"b":160,"g":240,"r":255},"pos":1}]},{"amount":60,"reverse":true},{"stops":[{"color":{"a":10,"b":0,"g":255,"r":0},"pos":0.3},{"color":{"a":255,"b":255,"g":0,"r":255},"pos":0.7}]}],"type":"gradientMap"},"grain":{"degenerate":[{},{"amount":0},{"amount":1000000000.0,"size":1000000000.0},{"seed":-5,"size":-2},{"colour":"x","kind":"bogus"},{"seed":1000000000000.0}],"doc":"Grain: additive noise per grain cell (size x size document px, cell = floor(doc / size)), hash of (cell, seed) so it is deterministic and independent of the rendered region. kind \'noise\': delta = (2u - 1) * amount/100 * 0.5 (uniform, +-0.5 at 100 %); kind \'film\': approx gaussian (sum of 4 uniforms, sd 1) * amount/100 * 0.2 * 4 l (1 - l) with l the luma of the straight colour (strongest in midtones, 0 in pure black/white). colour=true: independent noise per channel, false: the same delta on r,g,b. Added to the straight colour (0..1) and clamped; alpha untouched, transparent pixels stay transparent.","extent":["0","0","0","0"],"group":"stylise","noop":"amount <= 0","params":{"amount":{"default":30,"kind":"num","max":100,"min":0,"unit":"%"},"colour":{"default":false,"kind":"bool"},"kind":{"default":"film","kind":"enum","values":["film","noise"]},"seed":{"default":0,"kind":"seed"},"size":{"default":1,"kind":"num","max":16,"min":1,"round":true,"unit":"px"}},"passes":[{"pass":0,"u":["amount / 100","size","kind","colour","seed"]}],"preservesTransparent":true,"reads":"point","samples":[{"amount":60,"colour":false,"kind":"film","seed":3,"size":1},{"amount":80,"colour":true,"kind":"noise","seed":11,"size":3},{"amount":100,"colour":true,"kind":"film","seed":0,"size":16}],"type":"grain"},"highPass":{"degenerate":[{},{"radius":0},{"radius":-3},{"radius":1000000000000.0}],"doc":"High-pass: straight colour = 0.5 + (src - blur(src, radius)); alpha unchanged (flat areas become mid grey).","extent":["blurReach(radius)","blurReach(radius)","0","0"],"group":"blur","params":{"radius":{"default":4,"kind":"num","max":200,"min":0,"unit":"px"}},"passes":[{"sub":"blur","with":{"radius":"radius"}},{"pass":0,"u":["radius > 0"]}],"preservesTransparent":true,"reads":"neighbourhood","samples":[{"radius":5},{"radius":90}],"type":"highPass"},"kaleidoscope":{"degenerate":[{},{"segments":0},{"angle":1000000000.0,"segments":1000000000.0},{"centerX":1000000000.0,"zoom":0},{"edge":"bogus","segments":"x"},{"angle":-1000000000.0,"segments":32,"zoom":400}],"doc":"Kaleidoscope: the plane around the centre c is cut into N = segments wedges of S = 2 pi / N; inside every wedge the polar angle a = atan2(dy, dx) (document px, y down) is mirror-folded to a\' = S/2 - |mod(a, S) - S/2| in [0, S/2], so each wedge contains a source half-wedge and its mirror image (mirror lines every S/2 through the centre). out(p) = in(c + |p - c| / zoom (cos(a\' + angle), sin(a\' + angle))). angle rotates which part of the source is shown; zoom = percent magnification. Edge: what is read outside the document.","extent":["G","G","0","0"],"group":"distort","params":{"angle":{"default":0,"kind":"num","max":3600,"min":-3600,"unit":"degrees"},"centerX":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document height"},"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"segments":{"default":6,"kind":"num","max":32,"min":2,"round":true,"unit":"wedges"},"zoom":{"default":100,"kind":"num","max":400,"min":25,"unit":"percent"}},"passes":[{"pass":0,"u":["segments","rad(angle)","centerX","centerY","zoom / 100","edge"]}],"preservesTransparent":false,"reads":"global","samples":[{"angle":20,"segments":6},{"angle":0,"edge":"clamp","segments":2},{"angle":-45,"centerX":0.4,"centerY":0.55,"edge":"mirror","segments":8,"zoom":200},{"edge":"wrap","segments":5,"zoom":50}],"type":"kaleidoscope"},"kuwahara":{"degenerate":[{},{"radius":0},{"radius":-3},{"radius":1000000000.0},{"radius":"8"},{"radius":6},{"radius":7},{"radius":16}],"doc":"Kuwahara oil-paint filter, classic 4 overlapping quadrants of (radius+1)^2 px around the pixel; each pixel takes the mean colour of the quadrant with the lowest luma variance (variance of the integer 8-bit luma) (flat painterly regions, edges preserved). Radii above 6 px stride-subsample the window (stride = ceil(radius/6), at most 13x13 taps). Means are taken over premultiplied rgba (alpha weighted straight colour, alpha = mean alpha of the chosen quadrant). The quadrant is chosen with exact integer arithmetic (integer straight 8-bit luma, N*S2 - S1^2, ties -> lowest index), identical on every GPU.","extent":["n * st","n * st","0","0"],"group":"stylise","params":{"radius":{"default":4,"kind":"num","max":16,"min":1,"round":true,"unit":"px"}},"passes":[{"pass":0,"u":["n","st"]}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"radius":4},{"radius":12},{"radius":1}],"type":"kuwahara","vars":[["st","ceil(radius / 6)"],["n","floor(radius / st)"]]},"lensBlur":{"degenerate":[{},{"radius":0},{"radius":-5},{"blades":99,"brightness":1000000000.0,"radius":1000000000.0},{"blades":"y","radius":"x"},{"radius":8},{"blades":3,"radius":8.5},{"blades":8,"radius":100,"rotation":1000000000.0,"threshold":1},{"radius":0.2,"seed":-3}],"doc":"Lens blur (bokeh): average of the premultiplied rgba over a disc (blades 0) or a regular polygon (blades 3..8, circumradius = radius, first vertex at `rotation` degrees clockwise from +x) of `radius` px. The kernel is sampled with a deterministic golden-angle (Vogel) spiral of <= 64 bilinear taps, each rotated by a per-pixel angle hashed from (document position, seed) to turn banding into fine grain; polygon taps are re-weighted by (edge radius)^2 so the density is uniform over the polygon. Highlight boost: before averaging, rgb of every sample is multiplied by 1 + 15 * (brightness / 100) * h, h = clamp((luma - threshold) / (1 - threshold), 0, 1) of its straight colour, and the result is clamped to [0, alpha] (alpha is never boosted). brightness 0 = plain average. Quality: radius <= 8 px runs at full resolution (<= 64 taps over <= 200 px^2: ~3 px^2 per tap, mild grain). Larger radii first box down-sample by 2^L (L = 1..4 for radius <= 16 / 32 / 64 / 100) so the spiral radius is <= 8 low-res texels, sample the spiral at low resolution and bilinearly up-sample (cost ~constant): the kernel edge is softened by about 2^L px and a polygon\'s corners are rounded accordingly; very small bright points at large radii lose their shape (they are blended into 2^L-px blocks) and fine grain (up to ~1 level of a 64-tap estimate) remains in high-contrast detail.","extent":["if(L == 0, ceil(radius) + 3, ceil(radius) + 4 * d + 4)","if(L == 0, ceil(radius) + 3, ceil(radius) + 4 * d + 4)","0","0"],"group":"blur","include":["filterlib","blurlib"],"noop":"radius <= 0","params":{"blades":{"default":0,"doc":"0 = circle, 3..8 = polygon (1 and 2 act as 0)","kind":"num","max":8,"min":0,"round":true},"brightness":{"default":0,"doc":"highlight boost before averaging, 0 = none","kind":"num","max":100,"min":0,"unit":"%"},"radius":{"default":12,"doc":"disc radius / polygon circumradius","kind":"num","max":100,"min":0,"unit":"px"},"rotation":{"default":0,"doc":"polygon rotation, clockwise on screen","kind":"num","max":360,"min":-360,"unit":"deg"},"seed":{"default":0,"doc":"per-pixel kernel rotation jitter","kind":"seed"},"threshold":{"default":0.7,"doc":"luma above which samples are boosted","kind":"num","max":1,"min":0}},"passes":[{"pass":0,"u":["Rl","N","bl","rad(rotation)","gk","threshold","L","seed"],"when":"L == 0"},{"level":"L","pass":1,"u":["Rl","N","bl","rad(rotation)","gk","threshold","L","seed"],"when":"L > 0"},{"level":"L","pass":2,"u":["Rl","N","bl","rad(rotation)","gk","threshold","L","seed"],"when":"L > 0"},{"pass":3,"u":["Rl","N","bl","rad(rotation)","gk","threshold","L","seed"],"when":"L > 0"}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"blades":0,"brightness":40,"radius":5,"threshold":0.6},{"blades":6,"brightness":60,"radius":14,"rotation":15,"seed":3,"threshold":0.5},{"blades":5,"brightness":20,"radius":60,"rotation":30,"threshold":0.6},{"blades":0,"radius":100}],"type":"lensBlur","vars":[["bl","if(blades < 3, 0, blades)"],["L","if(radius <= 8, 0, if(radius <= 16, 1, if(radius <= 32, 2, if(radius <= 64, 3, 4))))"],["d","pow(2, L)"],["Rl","radius / d"],["N","clamp(ceil(pi * Rl * Rl), 6, 64)"],["gk","15 * brightness / 100"]]},"lensDistortion":{"degenerate":[{},{"k1":0,"k2":0,"scale":100},{"k1":1000000000.0,"k2":-1000000000.0,"scale":0},{"centerX":9000000000.0,"k1":-100,"k2":-100,"scale":50},{"edge":"bogus","k1":"a"},{"edge":"wrap","k1":100,"k2":100,"scale":200}],"doc":"Lens distortion (inverse mapping, evaluated per OUTPUT pixel, no iteration): with x = (p - c) / H the offset from the centre in units of H = half the document diagonal (so r = 1 at the corners of a centred document), the source position is c + H x (1 + k1\' r^2 + k2\' r^4) / zoom, k1\' = k1 / 100, k2\' = k2 / 100, zoom = scale / 100. k1 > 0 barrel (centre magnified, edges compressed), k1 < 0 pincushion; scale > 100 zooms in (hides borders), < 100 zooms out (shows transparent/edge borders). Centre = fraction of the document.","extent":["G","G","0","0"],"group":"distort","noop":"k1 == 0 && k2 == 0 && scale == 100","params":{"centerX":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document height"},"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"k1":{"default":30,"kind":"num","max":100,"min":-100,"unit":"percent (r^2 coefficient)"},"k2":{"default":0,"kind":"num","max":100,"min":-100,"unit":"percent (r^4 coefficient)"},"scale":{"default":100,"kind":"num","max":200,"min":50,"unit":"percent zoom"}},"passes":[{"pass":0,"u":["k1 / 100","k2 / 100","scale / 100","edge","centerX","centerY"]}],"preservesTransparent":false,"reads":"global","samples":[{"k1":40,"k2":0},{"edge":"clamp","k1":-50,"k2":10,"scale":80},{"centerX":0.4,"centerY":0.6,"k1":80,"k2":-60,"scale":120},{"edge":"mirror","k1":0,"k2":0,"scale":150}],"type":"lensDistortion"},"lut":{"degenerate":[{},{"cube":"garbage"},{"cube":5,"intensity":1000000000.0},{"cube":"LUT_1D_SIZE 2\\n0 0 0\\n1 1 1\\n"},{"cube":"LUT_3D_SIZE 65\\n"},{"cube":"LUT_3D_SIZE 2\\n0 0 0\\n","intensity":-3}],"doc":"3D LUT (Adobe / DaVinci Resolve `.cube`, LUT_3D_SIZE 2..64; 1D LUTs and malformed files are rejected and the filter does nothing). The straight colour is normalised through the file\'s domain, u = clamp((c - DOMAIN_MIN) / (DOMAIN_MAX - DOMAIN_MIN)), looked up with trilinear interpolation (red index fastest in the file, blue slowest) and mixed with the original by intensity / 100. Table outputs are stored in 8 bit and clipped to 0..1. Alpha unchanged.","extent":["0","0","0","0"],"group":"color","in2":true,"noop":"cube.ok == 0 || intensity <= 0","params":{"cube":{"cube":true,"default":"","kind":"text","unit":".cube file contents"},"intensity":{"default":100,"kind":"num","max":100,"min":0,"unit":"%"}},"passes":[{"data":{"args":["cube"],"gen":"cube"},"pass":0,"u":["cube.n","cube.g","cube.min.r","cube.min.g","cube.min.b","cube.max.r","cube.max.g","cube.max.b","intensity / 100"]}],"preservesTransparent":true,"reads":"point","samples":[{"cube":"TITLE \\"swap\\"\\nLUT_3D_SIZE 2\\n0 0 0\\n0 0 1\\n0 1 0\\n0 1 1\\n1 0 0\\n1 0 1\\n1 1 0\\n1 1 1\\n"},{"cube":"LUT_3D_SIZE 2\\nDOMAIN_MIN 0 0 0\\nDOMAIN_MAX 1 1 1\\n1 1 1\\n0 1 1\\n1 0 1\\n0 0 1\\n1 1 0\\n0 1 0\\n1 0 0\\n0 0 0\\n","intensity":50}],"type":"lut"},"motionBlur":{"degenerate":[{},{"length":0},{"length":-5},{"angle":1000000000.0,"length":1000000000.0},{"angle":"y","length":"x"},{"length":0.3},{"angle":90,"length":33}],"doc":"Motion blur: box average of the premultiplied rgba along a line through each pixel, total streak length `length` px centred on the pixel, direction `angle` degrees (0 = horizontal, clockwise on screen). Long streaks stay a smooth, exact box: pass 0 is a box of width a = length / N (<= 32 bilinear taps, spacing <= 1 px), pass 1 is a comb of N = ceil(length / 32) taps spaced a px apart; box (*) comb = one box of width length. At most 32 + 13 taps per pixel at any length. Quality: the continuous box is sampled with bilinear taps at <= 1 px spacing, so the result matches an ideal box blur to ~1/255 on smooth content; for lengths below 1 px the streak is a 2-tap bilinear box.","extent":["ceil(length / 2 * abs(dx)) + 4","ceil(length / 2 * abs(dy)) + 4","0","0"],"group":"blur","noop":"length <= 0","params":{"angle":{"default":0,"doc":"0 = horizontal, clockwise on screen","kind":"num","max":360,"min":-360,"unit":"deg"},"length":{"default":30,"doc":"total streak length (centred)","kind":"num","max":400,"min":0,"unit":"px"}},"passes":[{"pass":0,"u":["dx","dy","a","n1"]},{"pass":1,"u":["dx","dy","a","n2"],"when":"n2 > 1"}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"angle":0,"length":12},{"angle":35,"length":90},{"angle":-70,"length":400}],"type":"motionBlur","vars":[["n2","clamp(ceil(length / 32), 1, 13)"],["a","length / n2"],["n1","max(2, ceil(a))"],["dx","cos(rad(angle))"],["dy","sin(rad(angle))"]]},"pixelate":{"degenerate":[{},{"size":1},{"size":0},{"size":1000000000.0},{"sample":"bogus","size":-4},{"shape":"hex","size":"9"},{"size":256}],"doc":"Pixelate into square cells of `size` document px, aligned to the document origin (cell = floor(doc / size)). sample \'mean\': average of the cell (premultiplied, n x n taps with n = min(size,16), regularly stride-subsampled above 16 px, deterministic; taps clamped into the document); \'centre\': the colour of the pixel at the cell centre.","extent":["size","size","0","0"],"group":"stylise","noop":"size <= 1","params":{"sample":{"default":"mean","kind":"enum","values":["mean","centre"]},"shape":{"default":"square","kind":"enum","values":["square"]},"size":{"default":8,"kind":"num","max":256,"min":1,"round":true,"unit":"px"}},"passes":[{"pass":0,"u":["size","sample"]}],"preservesTransparent":false,"reads":"neighbourhood","samples":[{"sample":"mean","size":8},{"sample":"centre","size":20},{"sample":"mean","size":37}],"type":"pixelate"},"polar":{"degenerate":[{},{"mode":"polarToRect"},{"angleOffset":1000000000.0,"radiusScale":0},{"centerX":-1000000000.0,"centerY":1000000000.0,"radiusScale":1000000000.0},{"edge":"bogus","mode":"bogus"},{"edge":"mirror","mode":"polarToRect","radiusScale":10}],"doc":"Polar coordinates. R = radiusScale/100 * min(W, H) / 2 (document px), c = centre in px, angle measured clockwise from \'up\'. rectToPolar: out(p) = in(x = fract((atan2(dx, -dy) - offset) / 2 pi) * W, y = |p - c| / R * H): the image\'s x axis wraps around the centre, its top row sits at the centre and its bottom row at radius R. polarToRect: the inverse, out(x, y) = in(c + (y / H) R (sin a, -cos a)), a = x / W * 2 pi + offset. angleOffset in degrees. The x axis of the source wraps seamlessly; edge applies to the radial (y) direction and to what is read outside the document.","extent":["G","G","0","0"],"group":"distort","params":{"angleOffset":{"default":0,"kind":"num","max":3600,"min":-3600,"unit":"degrees"},"centerX":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document height"},"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"mode":{"default":"rectToPolar","kind":"enum","values":["rectToPolar","polarToRect"]},"radiusScale":{"default":100,"kind":"num","max":400,"min":10,"unit":"percent"}},"passes":[{"pass":0,"u":["mode","centerX","centerY","rad(angleOffset)","radiusScale / 100","edge"]}],"preservesTransparent":false,"reads":"global","samples":[{"mode":"rectToPolar"},{"angleOffset":45,"mode":"polarToRect"},{"centerX":0.3,"centerY":0.4,"edge":"clamp","mode":"rectToPolar","radiusScale":150},{"angleOffset":-90,"edge":"wrap","mode":"polarToRect","radiusScale":60}],"type":"polar"},"posterize":{"degenerate":[{},{"levels":0},{"levels":1000000000.0},{"levels":"5"},{"levels":3.5}],"doc":"Posterize: each straight colour channel is quantised to `levels` equally spaced values (0 and 1 included). Alpha unchanged.","extent":["0","0","0","0"],"group":"color","params":{"levels":{"default":4,"kind":"num","max":255,"min":2,"round":true,"unit":"levels per channel"}},"passes":[{"pass":0,"u":["levels"]}],"preservesTransparent":true,"reads":"point","samples":[{"levels":4},{"levels":2},{"levels":7}],"type":"posterize"},"radialBlur":{"degenerate":[{},{"amount":0},{"amount":-4},{"amount":1000000000.0,"centerX":-3,"centerY":9},{"amount":"x","centerX":"y"},{"amount":0.001},{"amount":180,"centerX":0,"centerY":0}],"doc":"Radial (spin) blur: average of the premultiplied rgba over an arc around (centerX, centerY) (fractions of the document), total arc `amount` degrees centred on each pixel\'s own angle (+-amount/2). Taps: ceil(arc length in px at the pixel\'s radius), capped at 64, equally weighted, bilinear, rotating the pixel about the centre; outside the document is transparent. Quality: while radius * amount(rad) <= 64 px the tap spacing is <= 1 px (smooth); beyond that the spacing grows (e.g. 180 deg at 300 px radius: ~15 px between taps) and fine detail shows faint stepping. Reads the whole document in principle (extent = document).","extent":["G","G","0","0"],"group":"blur","noop":"amount <= 0","params":{"amount":{"default":20,"doc":"total arc, centred on the pixel\'s angle","kind":"num","max":180,"min":0,"unit":"deg"},"centerX":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document height"}},"passes":[{"pass":0,"u":["rad(amount)","centerX","centerY"]}],"preservesTransparent":false,"reads":"global","samples":[{"amount":25,"centerX":0.5,"centerY":0.5},{"amount":90,"centerX":0.2,"centerY":0.8},{"amount":180,"centerX":0.5,"centerY":0.5}],"type":"radialBlur"},"ripple":{"degenerate":[{},{"amplitude":0},{"amplitude":1000000000.0,"wavelength":0},{"angle":-1000000000.0,"phase":1000000000.0,"wavelength":-5},{"decay":1000000000.0,"edge":"bogus","kind":"bogus"},{"amplitude":200,"kind":"wave","wavelength":2}],"doc":"Ripple. kind \'wave\': out(p) = in(p + A sin(2 pi (p . u) / wavelength + phase) n) with u = (cos angle, sin angle) the wave direction and n = (-sin angle, cos angle) the displacement direction (angle 0: columns move vertically as x advances). kind \'ripple\': out(p) = in(p + A g(r) sin(2 pi r / wavelength + phase) (p - c) / r), r = |p - c| px, g(r) = exp(-5 (decay / 100) r / halfDiagonal) (decay 0 = no fade). Positions in document px, centre = fraction of the document.","extent":["G","G","0","0"],"group":"distort","noop":"amplitude == 0","params":{"amplitude":{"default":8,"kind":"num","max":200,"min":0,"unit":"px"},"angle":{"default":0,"doc":"wave direction (kind wave)","kind":"num","max":3600,"min":-3600,"unit":"degrees"},"centerX":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document height"},"decay":{"default":0,"doc":"amplitude fade with distance from the centre (kind ripple)","kind":"num","max":100,"min":0,"unit":"percent"},"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"kind":{"default":"ripple","kind":"enum","values":["wave","ripple"]},"phase":{"default":0,"kind":"num","max":3600,"min":-3600,"unit":"degrees"},"wavelength":{"default":40,"kind":"num","max":2000,"min":2,"unit":"px"}},"passes":[{"pass":0,"u":["kind","amplitude","wavelength","rad(phase)","rad(angle)","centerX","centerY","decay","edge"]}],"preservesTransparent":false,"reads":"global","samples":[{"amplitude":4,"angle":0,"kind":"wave","wavelength":16},{"amplitude":3,"decay":30,"edge":"clamp","kind":"ripple","wavelength":12},{"amplitude":6,"angle":60,"edge":"wrap","kind":"wave","phase":90,"wavelength":30},{"amplitude":8,"centerX":0.2,"centerY":0.7,"edge":"mirror","kind":"ripple","wavelength":20}],"type":"ripple"},"selectiveColor":{"degenerate":[{},{"adjust":[]},{"adjust":[5,-5,"a",null]},{"adjust":"bad","relative":3},{"adjust":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]}],"doc":"Selective colour (Photoshop style): CMYK ink adjustments per colour range. `adjust` = 36 values in -1..1 (UI -100..100 %), range-major then cyan, magenta, yellow, black; ranges in order reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks. Range weights of the straight colour (h = HSV hue in degrees, chroma = max - min, mx / mn = max / min channel, L = Rec.709 luma): colour ranges with centres 0, 60, 120, 180, 240, 300: w = max(0, 1 - hueDistance / 60) * chroma; whites = smoothstep(0.5, 1, mn); blacks = smoothstep(0.5, 1, 1 - mx); neutrals = (1 - smoothstep(0, 0.25, chroma)) * (1 - |2 L - 1|). Inks C, M, Y = 1 - R, 1 - G, 1 - B, K = min(C, M, Y). For each ink i: i\' = i + w * a_i * (relative ? i : 1) summed over the ranges; the black adjustment adds w * a_k * (relative ? K : 1) to all three inks; result 1 - clamp(ink\'). `relative` = Photoshop\'s relative method (changes proportional to the existing ink), off = absolute. The 36 values travel through an 8-bit table (resolution 1/127.5, |value| < 0.5 % is treated as 0). Alpha unchanged.","extent":["0","0","0","0"],"group":"color","in2":true,"params":{"adjust":{"kind":"list","len":36,"max":1,"min":-1,"unit":"-1..1 = -100..100 %, range-major (reds .. blacks) then c, m, y, k"},"relative":{"default":true,"kind":"bool"}},"passes":[{"data":{"args":["adjust"],"gen":"table"},"pass":0,"u":["relative"]}],"preservesTransparent":true,"reads":"point","samples":[{"adjust":[0,0,0,0,0,0,0,0,0,0,0,0,0.8,0,0,0,0.9,0.5,-0.6,0,0,0,0.8,0,0,0,0,0,0,0,0,0,0,0,0,0.4],"relative":false},{"adjust":[0.5,0,0,0,0,0,0.7,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.5,0,0,0,-0.5,0,0,0,0.5]},{"adjust":[-1,1,-1,1,1,-1,1,-1,1,1,1,1,-1,-1,-1,-1,1,0.3,0.2,0.1,0.9,0.9,0.9,0.9,1,1,1,1,-1,-1,-1,-1,1,1,1,1]}],"type":"selectiveColor"},"tileMirror":{"degenerate":[{},{"offsetX":0,"offsetY":0,"rotation":0,"tilesX":1,"tilesY":1},{"tilesX":0,"tilesY":1000000000.0},{"offsetX":-5,"offsetY":1000000000.0,"rotation":1000000000.0},{"edge":"bogus","mirror":"yes"},{"rotation":360,"tilesX":32,"tilesY":32}],"doc":"Tile / mirror: the whole document is repeated tilesX x tilesY times, every tile showing the full image scaled down (tile size tw = W / tilesX, th = H / tilesY). The tile grid is rotated by rotation degrees (clockwise) about the document centre and shifted by offsetX % of tw / offsetY % of th. With mirror on, odd tiles (counted per axis in the grid\'s own axes) are flipped so neighbours meet seamlessly. Bilinear; the sampled position always lies inside the document, edge only affects the half pixel at the borders.","extent":["G","G","0","0"],"group":"distort","noop":"tilesX == 1 && tilesY == 1 && offsetX == 0 && offsetY == 0 && mod(rotation, 360) == 0","params":{"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"mirror":{"default":true,"kind":"bool"},"offsetX":{"default":0,"kind":"num","max":100,"min":0,"unit":"percent of tile width"},"offsetY":{"default":0,"kind":"num","max":100,"min":0,"unit":"percent of tile height"},"rotation":{"default":0,"kind":"num","max":3600,"min":-3600,"unit":"degrees"},"tilesX":{"default":2,"kind":"num","max":32,"min":1,"round":true,"unit":"tiles"},"tilesY":{"default":2,"kind":"num","max":32,"min":1,"round":true,"unit":"tiles"}},"passes":[{"pass":0,"u":["tilesX","tilesY","mirror","edge","offsetX / 100","offsetY / 100","rad(rotation)"]}],"preservesTransparent":false,"reads":"global","samples":[{"mirror":true,"tilesX":2,"tilesY":2},{"mirror":false,"offsetX":40,"tilesX":3,"tilesY":1},{"edge":"clamp","mirror":true,"offsetY":25,"rotation":30,"tilesX":4,"tilesY":3},{"edge":"wrap","offsetX":50,"offsetY":50,"tilesX":1,"tilesY":1}],"type":"tileMirror"},"twirl":{"degenerate":[{},{"angle":0},{"angle":1000000000.0,"radius":0},{"angle":-1000000000.0,"centerX":1000000000.0,"centerY":-1000000000.0,"radius":1000000000.0},{"angle":"x","edge":"bogus"},{"angle":3600,"radius":1}],"doc":"Twirl: out(p) = in(c + R(-a(r)) (p - c)), r = |p - c| in document px, a(r) = angle * (1 - s(min(r / radius, 1))) with s the cubic smoothstep t^2 (3 - 2t); positive angle turns the content clockwise at the centre, 0 at radius and beyond. Centre = fraction of the document. Bilinear resampling; edge: what is read outside the document.","extent":["G","G","0","0"],"group":"distort","noop":"angle == 0","params":{"angle":{"default":90,"kind":"num","max":3600,"min":-3600,"unit":"degrees"},"centerX":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":3,"min":-2,"unit":"fraction of document height"},"edge":{"default":"transparent","kind":"enum","values":["transparent","clamp","mirror","wrap"]},"radius":{"default":200,"kind":"num","max":4000,"min":1,"unit":"px"}},"passes":[{"pass":0,"u":["rad(angle)","radius","centerX","centerY","edge"]}],"preservesTransparent":false,"reads":"global","samples":[{"angle":120,"radius":60},{"angle":-300,"centerX":0.3,"centerY":0.6,"edge":"clamp","radius":150},{"angle":720,"edge":"mirror","radius":40},{"angle":45,"edge":"wrap","radius":500}],"type":"twirl"},"unsharp":{"degenerate":[{},{"amount":0},{"radius":0},{"amount":1000000000.0,"radius":1000000000.0,"threshold":-1},{"amount":"x"}],"doc":"Unsharp mask: out = src + amount * (src - blur(src, radius)) where |src - blur| exceeds threshold; operates on premultiplied rgb, alpha unchanged, rgb clamped to [0, alpha].","extent":["blurReach(radius)","blurReach(radius)","0","0"],"group":"blur","noop":"amount <= 0 || radius <= 0","params":{"amount":{"default":100,"kind":"num","max":500,"min":0,"unit":"%"},"radius":{"default":2,"kind":"num","max":200,"min":0,"unit":"px"},"threshold":{"default":0,"doc":"differences below this (0..255) are left alone","kind":"num","max":255,"min":0,"unit":"levels"}},"passes":[{"sub":"blur","with":{"radius":"radius"}},{"pass":0,"u":["amount / 100","threshold / 255"]}],"preservesTransparent":true,"reads":"neighbourhood","samples":[{"amount":150,"radius":3,"threshold":4},{"amount":300,"radius":60,"threshold":0}],"type":"unsharp"},"vibrance":{"degenerate":[{},{"saturation":-1000000000.0,"vibrance":1000000000.0},{"vibrance":"x"},{"saturation":null},{"saturation":-100,"vibrance":-100},{"saturation":100,"vibrance":100}],"doc":"Vibrance + saturation on straight colour. Let G = Rec.709 luma gray, S = HSV saturation (max-min)/max of the colour. Colour = G + (c - G) * f with f = fv * (1 + saturation/100), fv = 1 + v (1 - S) for vibrance v = vibrance/100 >= 0 (low-saturation colours are boosted most, grey is unaffected, fully saturated colours not at all) and fv = 1 + v S for v < 0 (saturated colours are reduced most). `saturation` -100 gives luma grey, +100 doubles the distance from grey (linear in the luma / chroma plane, not in HSV). Result clamped to 0..1, alpha unchanged.","extent":["0","0","0","0"],"group":"color","noop":"vibrance == 0 && saturation == 0","params":{"saturation":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"},"vibrance":{"default":0,"kind":"num","max":100,"min":-100,"unit":"%"}},"passes":[{"pass":0,"u":["vibrance / 100","saturation / 100"]}],"preservesTransparent":true,"reads":"point","samples":[{"vibrance":70},{"saturation":-100},{"saturation":40,"vibrance":-60}],"type":"vibrance"},"zoomBlur":{"degenerate":[{},{"amount":0},{"amount":-4},{"amount":1000000000.0,"centerX":-3,"centerY":9},{"amount":"x","centerX":"y"},{"amount":0.001},{"amount":100,"centerX":1,"centerY":1}],"doc":"Zoom blur: average of the premultiplied rgba along the straight line from each pixel towards (centerX, centerY) (fractions of the document); the streak covers amount % of the pixel\'s distance to the centre (amount 100 = all the way to the centre). Taps: ceil(streak length in px), capped at 64, starting at the pixel itself, equally weighted, bilinear; outside the document is transparent. Quality: smooth while the streak is <= 64 px; longer streaks (far from the centre, large amount) have tap spacing > 1 px and may show faint stepping on fine detail. Extent = document.","extent":["G","G","0","0"],"group":"blur","noop":"amount <= 0","params":{"amount":{"default":30,"doc":"streak length as % of the distance to the centre","kind":"num","max":100,"min":0,"unit":"%"},"centerX":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document width"},"centerY":{"default":0.5,"kind":"num","max":1,"min":0,"unit":"fraction of document height"}},"passes":[{"pass":0,"u":["amount / 100","centerX","centerY"]}],"preservesTransparent":false,"reads":"global","samples":[{"amount":30,"centerX":0.5,"centerY":0.5},{"amount":70,"centerX":0.3,"centerY":0.6},{"amount":100,"centerX":0.5,"centerY":0.5}],"type":"zoomBlur"}}'
# END EMBEDDED FILTER SPECS
reload_specs()
