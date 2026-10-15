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

Units (contract with the UI): lengths in document px; ``opacity`` 0..1; colours RGBA 0..255 (alpha multiplies opacity);
bevel ``depth`` 0..100 (percent), ``angle`` degrees, 0 = light from the right, counter-clockwise on screen (120 = upper left);
pixelSort ``low`` / ``high`` 0..1 on luma or hue; glitch ``amount`` 0..100 (percent of bands glitched AND max shift in px),
``blockSize`` band height px, ``seed`` integer, ``rgbShift`` px; chromaticAberration ``amount`` px, ``angle`` degrees (as bevel);
halftone ``cellSize`` px, ``angle`` degrees clockwise on screen.
"""

from __future__ import annotations

import math
import os

FMT_U8 = "rgba8fixed"
FMT_F16 = "rgba16float"
FMT_F32 = "rgba32float"

MAX_RADIUS = 128          # blur kernel half width cap (px)
MAX_STROKE = 128
PIXEL_SORT_SPAN = 256     # spans are sorted in aligned chunks of this many px (pixelSort.glsl MAXSPAN)

EFFECT_TYPES = ("dropShadow", "outerGlow", "innerGlow", "stroke", "bevel", "colorOverlay",
                "pixelSort", "glitch", "chromaticAberration", "halftone")


class Pass:
    """One GLSL TOP pass: shader (effect type), pass id, 16 uniform floats uP0..uP3, working format."""
    __slots__ = ("shader", "pid", "u", "fmt")

    def __init__(self, shader, pid, u, fmt):
        self.shader, self.pid, self.fmt = shader, pid, fmt
        u = [float(v) for v in u]
        self.u = u + [0.0] * (16 - len(u))

    def as_dict(self):
        return {"shader": self.shader, "pass": self.pid, "u": list(self.u), "fmt": self.fmt}

    def __repr__(self):
        return "Pass(%s#%d %s)" % (self.shader, self.pid, self.fmt)


# --------------------------------------------------------------------------- planning (== web/src/engine/effects/plan.ts)


def _round(x):
    return int(math.floor(float(x) + 0.5))


def _num(e, k, d=0.0):
    """Finite numbers only (numeric strings, booleans, None -> default): same rule as plan.ts ``num``."""
    v = e.get(k, d)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return float(d)
    v = float(v)
    return v if math.isfinite(v) else float(d)


_SEED_MOD = 1 << 24      # seeds are reduced to 0..2^24-1 so the float uniform holds them exactly
_MAX_OFFSET = 8192


def _off(e, k):
    return max(-_MAX_OFFSET, min(_MAX_OFFSET, _round(_num(e, k))))


def _enabled(e):
    """Only a literal False disables an effect (a missing flag = enabled), like ``enabled === false`` in plan.ts."""
    return bool(e) and e.get("enabled", True) is not False


def _col(c, opacity=1.0):
    c = c or {}
    a = float(c.get("a", 255)) / 255.0
    return [float(c.get("r", 0)) / 255.0, float(c.get("g", 0)) / 255.0, float(c.get("b", 0)) / 255.0,
            a * min(1.0, max(0.0, opacity))]


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


def plan_effect(e):
    """Effect dict -> list of Pass ([] when disabled / nothing to draw)."""
    if not _enabled(e):
        return []
    t = e.get("type")
    op = min(1.0, max(0.0, _num(e, "opacity", 1.0)))
    if t == "dropShadow":
        sg, r = _blur_size(_num(e, "blur"))
        dx, dy = _off(e, "dx"), _off(e, "dy")
        u = [sg, r, dx, dy] + _col(e.get("color"), op)
        return [Pass(t, 0, u, FMT_F16), Pass(t, 1, u, FMT_F16)]
    if t in ("outerGlow", "innerGlow"):
        sg, r = _blur_size(_num(e, "size"))
        u = [sg, r, 0, 0] + _col(e.get("color"), op)
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
        sg, r = _blur_size(size)
        a = math.radians(_num(e, "angle", 120.0))
        depth = min(1.0, max(0.0, _num(e, "depth", 100.0) / 100.0))
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
        a = math.radians(_num(e, "angle"))
        amt = _num(e, "amount")
        return [Pass(t, 0, [amt * math.cos(a), -amt * math.sin(a)], FMT_F16)]
    if t == "halftone":
        a = math.radians(_num(e, "angle"))
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

    def iso(r):
        return (r, r, 0, 0)

    if t == "dropShadow":
        r = _blur_size(_num(e, "blur"))[1]
        return (abs(_off(e, "dx")) + r, abs(_off(e, "dy")) + r, 0, 0)
    if t in ("outerGlow", "innerGlow"):
        return iso(_blur_size(_num(e, "size"))[1])
    if t == "stroke":      # jump flood: dependency radius = sum of the jump sizes (+1 edge test, +1 slack)
        return iso(int(sum(p.u[0] for p in ps if p.fmt == FMT_F32)) + 2)
    if t == "bevel":
        return iso(_blur_size(_num(e, "size"))[1] + 1)
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
                p = Pass(p.shader, p.pid, p.u, FMT_U8 if gi == len(groups) - 1 else FMT_F16)
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


def load_shader_texts(directory=None):
    """{effect type: common.glsl + effect shader} read from shared/effects (or ``directory``)."""
    d = directory or _shared_dir()
    with open(os.path.join(d, "common.glsl"), encoding="utf-8") as f:
        common = f.read()
    out = {}
    for t in EFFECT_TYPES:
        with open(os.path.join(d, t + ".glsl"), encoding="utf-8") as f:
            out[t] = common + "\n" + f.read()
    return out


# --------------------------------------------------------------------------- TD node chain

_VEC_NAMES = ("uP0", "uP1", "uP2", "uP3", "uPass", "uSize")


class _Slot:
    __slots__ = ("op", "pars", "inputs", "init")

    def __init__(self, op):
        self.op = op
        self.init = False     # static parameters (vector names, filtering) written
        self.pars = {}        # last values written (so a repeat apply writes nothing)
        self.inputs = [None, None]


class EffectChain:
    """The GLSL TOP chain of one layer's effect stack inside ``parent``.

    ``shader_texts``  {effect type: full shader text} (``load_shader_texts``); one text DAT ``<dat_prefix><type>`` per type
                      is created in ``parent`` on demand (shared by all chains of that parent).
    ``acquire/release`` optional node supply (e.g. network.py's pooled spare GLSL TOPs): ``acquire("glslTOP") -> op``,
                      ``release(op)`` (disconnect + park).  Default: ``parent.create`` / ``op.destroy``.
    Nodes are named ``<prefix>_<k>`` when created here; ``adopt=True`` (default) re-uses such nodes already present (file
    reload) -- their state is unknown so every parameter is rewritten once.
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

    # -- helpers
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
        self.counters["destroys"] += 1

    # -- API
    def apply(self, effects, input_top, doc_w=None, doc_h=None):
        """Make the chain match ``effects`` (list of effect dicts); returns the output TOP (``input_top`` when no effect is
        enabled).  ``doc_w/doc_h`` are accepted for symmetry: the nodes inherit the input's (document) resolution."""
        passes = plan_chain(effects)
        if not passes:
            self.clear()
            return input_top
        n = len(passes)
        while len(self._slots) > n:
            self._drop_slot(self._slots.pop())
        while len(self._slots) < n:
            self._slots.append(self._new_slot(len(self._slots)))
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
            pars = {"pixeldat": self._ensure_dat(p.shader), "format": p.fmt}
            for v in range(4):
                for j, ax in enumerate("xyzw"):
                    pars["vec%dvalue%s" % (v, ax)] = p.u[v * 4 + j]
            pars["vec4valuex"] = float(p.pid)
            pars["vec4valuey"] = 0.0
            pars["vec4valuez"] = 0.0
            pars["vec4valuew"] = 0.0
            for ax in "xyzw":
                pars["vec5value" + ax] = 0.0           # uSize: 0 = the texture size (only the WebGL size buckets use it)
            self._set(slot, pars)
            want = [eff_in, prev]
            for i in (0, 1):
                if slot.inputs[i] != want[i]:
                    slot.op.inputConnectors[i].connect(want[i])
                    slot.inputs[i] = want[i]
                    self.counters["connects"] += 1
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
