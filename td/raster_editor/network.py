"""DocNetwork: the generated compositing network of the raster editor COMP (docs/DESIGN_V2.md 4).

Everything inside ``<comp>/doc`` is owned and generated here; ``apply()`` diff-applies the layer
stack of the web client (PROTOCOL.md 3).  The TD-view overlay (``view_*``, ``doc_view``,
``panel_view`` next to ``doc``) is owned here too.  The module is pure python: TD objects are only
reached through ``comp.op / doc.create / node.par / node.inputConnectors / ...`` so the diff logic is
unit-tested against fake TD objects (``td/tests/test_network*.py``).

Network shape (all names inside ``doc``)::

    blank (constantTOP, transparent, doc size)      src_in<N> (selectTOP: ../in<N> or blank; only for inputs a layer uses)
    s<slot>        scriptTOP  surface pixels (callbacks DAT surface_callbacks -> OnSurfaceCook)
    g<N>           glslTOP    blend.glsl nodes: role in tag/comment ``blend_<id>`` (inputs 0 below, 1 source,
                              2 mask; always 3 wired).  They are
                              NOT named after the layer: creating or renaming a GLSL TOP costs ~4.5 ms, so a
                              pool of spare nodes is made in tick() and handed out / taken back by apply().
    fx_<id>_*      effect chain nodes of a layer (effects.EffectChain), also an adjustment layer's stack
    out            nullTOP    result (input = last root blend)
    blend_glsl, surface_callbacks   text DATs (shader, Script TOP callbacks)

v6 performance network (``optimize=True``, docs/DESIGN_V6.md 2.1): layers that provably add nothing get no pass (hidden, opacity 0,
empty, off canvas, adjustment without drawing effects); runs of up to 8 plain layers are ONE ``mrg_L_<first id>`` GLSL Multi TOP (blend.glsl uAdjust
8, 16 inputs); transformed pixel layers (``xf_L_*``) and small shapes (``shapec_*``) render only their bounding box; pass outputs are
8 bit when only plain Normal blends follow; spare nodes are pre-cooked.  Optional hints: ``set_content_bounds``,
``set_active_layer``.  ``optimize=False`` builds the v5 network (one 16 bit pass per layer).

Chain order is bottom -> top inside each parent; a group is an isolated chain that starts at ``blank``
and whose result is the *source* of ``blend_<groupId>``.

Adjustment layers (v8, docs/DESIGN_V7.md 3): an adjustment layer is an effect stack over everything below it (inside its parent).
Its ``effects[]`` (the classic Levels / Brightness-Contrast / Hue-Saturation / Invert / Threshold / Blur adjustments are ordinary
effect types since v8; ``protocol.parse_doc`` migrates v2..v7 ``adjustment`` specs) run as an ``effects.EffectChain`` on the
accumulated image ``acc``; the layer's blend node mixes the result in premultiplied RGBA (blend.glsl uAdjust 1):

    out = mix(below, chain(below), opacity * mask)

An adjustment whose stack draws nothing is skipped (``optimize``) or mixes the image with itself.  Adjustments break merged runs and
need full-precision (16 bit) inputs: the chain divides by alpha / colours.

Blend uniforms (GLSL TOP Vectors page): ``uParams`` vec4 = (BlendMode index, opacity, hasMask,
uAdjust 0..7) and ``uXform`` vec4 = (x, y, sx, sy), the layer -> document mapping ``doc = (x, y) + (sx, sy) * layer``
of the blend pass (only an INTEGER offset at scale 1 is ever placed by the blend pass; identity for every layer that is
not a pixel / input layer).  The layer's own surface is the Script TOP ``s<slot>`` at ``surfaceW x surfaceH`` (an input
layer's is ``src_in<N>``, a Select TOP of ``in<N>``, at the input's own resolution; a disconnected input is ``blank``).

Resampling is a separate pass (v5 affine): a pixel / input layer whose transform is NOT an integer offset at scale 1
(any rotation or skew included), or that has enabled effects, gets a node ``xf_L_<id>`` (uAdjust 7, custom resolution
= document size; inputs: surface, mask or the surface again, surface) that renders surface x coverage x mask into
document space; the blend node (or the layer's effect chain, see below) then reads that through ``texelFetch`` with an
identity mapping and no mask.  The layer -> document map is  ``doc = T(x,y) R(rot) K(kx,ky) S(sx,sy) layer``  (rot in
degrees clockwise on screen, K = [[1, tan kx],[tan ky, 1]], document y down, about the surface's top-left);
the resample node gets the INVERSE of the linear part in ``uXform`` = (m00, m01, m10, m11) and the translation in
``uA.xy``.  Coverage is the area of the document pixel's parallelogram footprint inside the source rect.  Only the
``xf_L`` node has ``inputfiltertype`` = ``mipmap`` (while lod = ``max(0, -0.5 log2|det A| - 0.5)`` > 0, i.e. |det A| <
0.5 with A the forward linear part; trilinear; |det A| = sx*sy for a pure scale: what Canvas 2D drawImage 'medium'
does, and Skia's area-scale rule for rotated / skewed draws) or ``linear``; its inputs are surfaces (or ``src_in<N>``),
never an accumulator.  Every other glsl node is ``nearest`` / texelFetch only (TD builds mip chains for ALL inputs of a
mipmap-filtered node, and keeps them).  Integer offsets at scale 1 without effects have no resample node: the blend pass
places the surface itself (exact).  Text / shape layers are always TD rendered at document size (they never have a
surface slot).

Inputs (v6): layers of kind ``input`` (input 1..8; a legacy ``base`` layer is input 1) read ``src_in<N>``.  The ext tells
the network which COMP inputs are connected with :meth:`DocNetwork.set_inputs` (the connectors of the COMP are also read
by apply()); a layer on a disconnected input renders transparent (no resample node) but keeps its transform.

Layer effects: a layer with enabled effects (pixel, input, text, shape) feeds its doc-space content (the resample node
when it has a mask or a transform, the source node otherwise) through an effect chain (effects.EffectChain, one per
layer, owned by the network) whose output is the *source* of the layer's blend node.  A render request (flatten / merge) plans its own nodes for
the requested layers (``render_open``).

v7 (docs/DESIGN_V6.md 5.1): effects on groups (chain on the isolated composite, mask first), displace
aux images (``auxSource`` 'layer:<id>' / 'input:<n>'), tdPreview layers (``preview_layers`` / ``layer_preview_source`` / ``layer_preview_token``)
and bold / italic faces of font collections (``text_face``).

Persistence (verified): a LOCKED Script TOP keeps its pixels in COMP.save()/loadTox (and so in a saved .toe).
Locking resets the locked image, so ``freeze()`` does ``top.lock = True`` and then calls ``comp.OnSurfaceCook(top)``
(the ext's promoted method, which must copy the whole surface buffer) to write the pixels INTO the locked TOP.
``thaw()`` unlocks; TD recooks an unlocked Script TOP at once, so ``OnSurfaceCook`` must always copy the whole
buffer (not only when dirty).  ``read_locked()`` returns the stored pixels as float32 (h, w, 4), TD row order.
"""

import json
import math
import collections
import os
import re
import struct
import sys
import tempfile
import time

BLEND_MODES = (
    "normal", "multiply", "screen", "overlay", "soft-light", "hard-light",
    "darken", "lighten", "color-dodge", "color-burn", "difference", "exclusion",
    "hue", "saturation", "color", "luminosity",
)
BLEND_INDEX = {name: i for i, name in enumerate(BLEND_MODES)}

GRACE_S = 2.0
WIDTH_CACHE_MAX = 100000   # measured widths kept (LRU); far above one max-size (20000 char) text
MEASURE_BUDGET = 16      # Text TOP measurement cooks per apply() / per tick()
FLATTEN_BUDGET = 200     # Text TOP measurement cooks per render_status() call
POOL_TARGET = 6          # spare glsl TOPs kept ready (creating a GLSL TOP costs ~4.7 ms)
POOL_MAX = 10
GARBAGE_MAX = 12
JUNK_MAX = 80
PENDING_MAX = 24
ROLE_PREFIX = "role:"
FMT = "rgba16float"          # adjustment internals (values may leave 0..1)
FMT_SHAPE = "rgba8fixed"       # shape / text layer outputs (the browser surfaces are 8 bit too)
FMT_BLEND = "rgba16fixed"     # blend outputs: 1.5e-5 steps (float16 is 2.4e-4 near 1.0 and colour-burn amplifies it)
FMT8 = "rgba8fixed"           # v6: blend outputs that only plain Normal blends read afterwards (see DocNetwork._emit)
MERGE_MAX = 8                 # layers per merged pass (blend.glsl uL0..uL7)
MERGE_MASKS_MAX = 7           # masked layers per merged pass; the node always has 16 inputs (1 below + 8 sources + 7 masks:
                              # TD recompiles a GLSL TOP whenever its number of wired inputs changes, ~15 ms)
MPOOL_TARGET = 2              # spare GLSL Multi TOPs kept ready for merged passes
MPOOL_MAX = 4
# internal feature switches of optimize=True (bisecting; all on = the v6 network)
EIGHT_BIT = True               # 8 bit pass outputs where only plain Normal blends follow
MERGE_RUNS = True              # merged multi-layer passes
CROP_BOXES = True              # cropped resample / shape passes
SKIP_RULES = True              # no pass for layers that add nothing
PREWARM = False                # v6: off by default — an unexplained adjustment-parity failure (validate step 13)
                               # only ever reproduced with pre-warm on; it saves at most a one-off ~15-20 ms compile
WARM_IDLE_S = 1.0             # spare nodes are pre-cooked (shader compile ~15 ms) only when no apply() happened this recently
ADJ_MERGED_CODE = 8           # blend.glsl uAdjust of a merged pass

# reserved (non layer) node names inside doc
RESERVED = ("blend_glsl", "shape_glsl", "text_measure", "surface_callbacks", "blank", "out", "warm_in")
EMPTY_HINT = ()               # set_content_bounds(): the layer has no visible pixels
MAX_INPUTS = 8
VIEW_NODES = ("view_doc", "view_glsl", "doc_view", "panel_view")

SURFACE_CALLBACKS = (
    "def onCook(scriptOp):\n"
    "    parent.RasterEditor.OnSurfaceCook(scriptOp)\n"
)

# TD-view overlay shader: document rect placed in panel pixels, web checkerboard underneath,
# transparent outside the (clipped) document rect.  Matches web/src/ui/viewportDraw.ts.
VIEW_GLSL = """\
// uView vec4: x,y = document origin in panel px (top-left origin), z = zoom, w = 1 if downscaling
// uClip vec4: x0,y0,x1,y1 = visible rect in panel px (canvas rect, top-left origin)
uniform vec4 uView;
uniform vec4 uClip;
out vec4 fragColor;
void main() {
    vec2 res = uTDOutputInfo.res.zw;
    vec2 pt = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);       // pixel centre, top-left origin
    ivec2 dsz = textureSize(sTD2DInputs[0], 0);
    vec2 local = pt - uView.xy;
    vec2 docPx = local / uView.z;
    vec4 outc = vec4(0.0);
    bool inClip = pt.x >= uClip.x && pt.y >= uClip.y && pt.x < uClip.z && pt.y < uClip.w;
    if (inClip && docPx.x >= 0.0 && docPx.y >= 0.0 && docPx.x < float(dsz.x) && docPx.y < float(dsz.y)) {
        ivec2 cell = ivec2(floor(local / 8.0));
        float chk = (((cell.x + cell.y) & 1) == 0) ? 0.811764706 : 1.0;
        vec4 c;
        if (uView.w > 0.5) {
            c = texture(sTD2DInputs[0], vec2(docPx.x / float(dsz.x), 1.0 - docPx.y / float(dsz.y)));
        } else {
            ivec2 ip = ivec2(floor(docPx));
            c = texelFetch(sTD2DInputs[0], ivec2(ip.x, dsz.y - 1 - ip.y), 0);
        }
        outc = vec4(c.rgb + vec3(chk) * (1.0 - c.a), 1.0);
    }
    fragColor = TDOutputSwizzle(outc);
}
"""


def sanitize(name):
    """TD operator-name-safe form of a layer id."""
    s = re.sub(r"\W", "_", str(name))
    if not s or s[0].isdigit():
        s = "_" + s
    return s


# --------------------------------------------------------------------------- pure helpers


def view_uniforms(view, panel_w, panel_h, doc_w, doc_h):
    """Shader inputs for the TD-view overlay from a PROTOCOL ``view`` message.

    ``rect`` is the canvas element rect in panel px (top-left origin); ``panX/panY`` the document
    origin inside that rect.  Returns ``(origin_x, origin_y, zoom, downscale, x0, y0, x1, y1)`` where the
    clip rect is the canvas rect intersected with the panel.  The TD texture origin is bottom-left; the
    shader flips, so all values here are top-left panel px."""
    rect = view.get("rect") or {}
    rx, ry = float(rect.get("x", 0)), float(rect.get("y", 0))
    rw, rh = float(rect.get("w", panel_w)), float(rect.get("h", panel_h))
    zoom = float(view.get("zoom", 1.0))
    if not zoom > 0:
        zoom = 1.0
    ox = rx + float(view.get("panX", 0))
    oy = ry + float(view.get("panY", 0))
    x0, y0 = max(0.0, rx), max(0.0, ry)
    x1, y1 = min(float(panel_w), rx + rw), min(float(panel_h), ry + rh)
    return (ox, oy, zoom, 1.0 if zoom < 1.0 else 0.0, x0, y0, max(x0, x1), max(y0, y1))


IDENTITY_XF = (0.0, 0.0, 1.0, 1.0)
SKEW_MAX = 85.0       # degrees: web/src/engine/xform.ts MAX_SKEW (tan() stays finite)


class Affine:
    """A layer's layer -> document map  ``doc = T(x,y) R(rot) K(kx,ky) S(sx,sy) layer`` (document px, y down; rot
    clockwise on screen; K = [[1, tan kx],[tan ky, 1]]).

    ``xf`` = (x, y, sx, sy) (what the blend pass uses for integer offsets), ``lin`` = (a, b, c, d) the forward 2x2
    (doc = (x, y) + [[a, b],[c, d]] layer), ``inv`` = (m00, m01, m10, m11) its inverse (the resample uniform
    ``uXform``), ``det`` = a d - b c, ``mip`` = the resample needs a mip level > 0 (|det| < 0.5), ``pure`` = no rotation or
    skew, ``dead`` = a singular matrix (the layer covers no area: rendered transparent)."""

    __slots__ = ("xf", "lin", "inv", "det", "mip", "pure", "dead")

    def __init__(self, x=0.0, y=0.0, sx=1.0, sy=1.0, rot=0.0, kx=0.0, ky=0.0):
        self.xf = (x, y, sx, sy)
        self.pure = rot == 0.0 and kx == 0.0 and ky == 0.0
        if self.pure:
            a, b, c, d = sx, 0.0, 0.0, sy
        else:
            r = math.radians(rot)
            cs, sn = math.cos(r), math.sin(r)
            tx, ty = math.tan(math.radians(kx)), math.tan(math.radians(ky))
            a, b = sx * (cs - sn * ty), sy * (cs * tx - sn)
            c, d = sx * (sn + cs * ty), sy * (sn * tx + cs)
        self.lin = (a, b, c, d)
        self.det = a * d - b * c
        self.dead = not (abs(self.det) > 1e-9 * max(1.0, abs(a * d) + abs(b * c)) and math.isfinite(self.det))
        if self.dead:
            self.inv = (1.0, 0.0, 0.0, 1.0)
        else:
            self.inv = (d / self.det, -b / self.det, -c / self.det, a / self.det)
        self.mip = abs(self.det) < 0.5

    @property
    def exact(self):
        """An integer offset at scale 1: the blend pass places the surface itself, no resample pass."""
        return self.pure and xform_is_exact(self.xf)


def _num(v, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


IDENTITY = Affine()


_AFFINE_KEYS = ("x", "y", "sx", "sy", "rot", "kx", "ky")
_AFFINE_MEMO = {}


def layer_affine(layer):
    """:func:`_layer_affine` memoised on the layer's kind and transform fields (an apply() asks for every layer, twice)."""
    try:
        key = (layer.get("kind"),) + tuple(layer.get(k) for k in _AFFINE_KEYS)
        hit = _AFFINE_MEMO.get(key)
    except TypeError:                    # unhashable junk in a field
        return _layer_affine(layer)
    if hit is None:
        if len(_AFFINE_MEMO) > 2048:
            _AFFINE_MEMO.clear()
        hit = _AFFINE_MEMO[key] = _layer_affine(layer)
    return hit


def _layer_affine(layer):
    """LayerSpec -> :class:`Affine`.  Only pixel and input layers (and a legacy ``base``) carry a transform;
    everything else (text, shape, group, adjustment) maps 1:1 at the origin.  Invalid numbers fall back to the identity."""
    if layer.get("kind") not in ("pixel", "input", "base"):
        return IDENTITY
    x, y = _num(layer.get("x", 0) or 0, None), _num(layer.get("y", 0) or 0, None)
    if x is None or y is None:
        x = y = 0.0
    sx, sy = _num(layer.get("sx", 1.0) or 1.0, 1.0), _num(layer.get("sy", 1.0) or 1.0, 1.0)
    if not sx > 0:
        sx = 1.0
    if not sy > 0:
        sy = 1.0
    rot, kx, ky = _num(layer.get("rot", 0.0) or 0.0, 0.0), _num(layer.get("kx", 0.0) or 0.0, 0.0), \
        _num(layer.get("ky", 0.0) or 0.0, 0.0)
    kx, ky = max(-SKEW_MAX, min(SKEW_MAX, kx)), max(-SKEW_MAX, min(SKEW_MAX, ky))
    if abs(rot) > 1e6:
        rot = 0.0
    return Affine(x, y, sx, sy, rot, kx, ky)


def xform_uniforms(layer):
    """LayerSpec -> ``((x, y, sx, sy), mip)``: the blend-pass ``uXform`` and whether the sampler must be mipmapped
    (mip lod > 0, i.e. |det| = sx*sy < 0.5 for a pure scale).  See :func:`layer_affine` for rotation / skew."""
    a = layer_affine(layer)
    return a.xf, a.mip


def xform_is_exact(xf):
    """True when the mapping is an integer offset at scale 1: the blend pass places the surface with texelFetch and
    no resample pass is needed.  Same tolerance as blend.glsl."""
    return (xf[2] == 1.0 and xf[3] == 1.0 and abs(xf[0] - round(xf[0])) < 1e-4 and abs(xf[1] - round(xf[1])) < 1e-4)


def input_index(layer):
    """The COMP input (1..8) an ``input`` layer reads; a legacy ``base`` layer is input 1."""
    if layer.get("kind") == "base":
        return 1
    try:
        n = int(layer.get("input") or 1)
    except (TypeError, ValueError):
        n = 1
    return max(1, min(MAX_INPUTS, n))


# --------------------------------------------------------------------------- text / shape specs

SHAPE_TYPE = {"rect": 1.0, "ellipse": 2.0, "line": 3.0, "polygon": 4.0}


def _rgba(c, default=(0, 0, 0, 255)):
    c = c or {}
    return (float(c.get("r", default[0])) / 255.0, float(c.get("g", default[1])) / 255.0,
            float(c.get("b", default[2])) / 255.0, float(c.get("a", default[3])) / 255.0)


def shape_uniforms(spec, doc_h):
    """ShapeSpec (document px, top-left origin, y down, rotation in degrees clockwise) -> GLSL TOP parameters
    of shape.glsl (TD px, bottom-left origin, y up, rotation radians counter-clockwise).  Pure function."""
    spec = spec or {}
    t = spec.get("type", "rect")
    fill = spec.get("fill") or {}
    stroke = spec.get("stroke") or {}
    fill_on = bool(fill.get("enabled")) and t != "line"
    sw = max(0.0, float(stroke.get("width", 0.0)))
    stroke_on = bool(stroke.get("enabled")) and (sw > 0.0 or t == "line")      # a line's arrowheads need no width
    rot = -math.radians(float(spec.get("rotation", 0.0) or 0.0)) if t != "line" else 0.0
    g = [0.0, 0.0, 0.0, 0.0]          # uOffset
    a = [0.0, 0.0, sw, 0.0]           # uA
    H = float(doc_h)
    if t in ("rect", "ellipse"):
        w, h = abs(float(spec.get("w", 0.0))), abs(float(spec.get("h", 0.0)))
        x, y = float(spec.get("x", 0.0)), float(spec.get("y", 0.0))
        # a negative w/h (drag up/left) is the same box
        if float(spec.get("w", 0.0)) < 0:
            x += float(spec.get("w", 0.0))
        if float(spec.get("h", 0.0)) < 0:
            y += float(spec.get("h", 0.0))
        g = [x + w / 2.0, H - (y + h / 2.0), w / 2.0, h / 2.0]
        if t == "rect":
            a[0] = max(0.0, min(float(spec.get("radius", 0.0) or 0.0), w / 2.0, h / 2.0))
    elif t == "line":
        g = [float(spec.get("x1", 0.0)), H - float(spec.get("y1", 0.0)),
             float(spec.get("x2", 0.0)), H - float(spec.get("y2", 0.0))]
        a[3] = (1.0 if spec.get("arrowStart") else 0.0) + (2.0 if spec.get("arrowEnd") else 0.0)
    elif t == "polygon":
        g = [float(spec.get("cx", 0.0)), H - float(spec.get("cy", 0.0)), max(0.0, float(spec.get("radius", 0.0))),
             min(1.0, max(0.05, float(spec.get("innerRatio", 1.0))))]
        a[1] = float(min(64, max(3, int(round(float(spec.get("sides", 3)))))))
    fc, sc = _rgba(fill.get("color")), _rgba(stroke.get("color"))
    pars = {"vec0valuex": SHAPE_TYPE.get(t, 1.0), "vec0valuey": rot, "vec0valuez": 1.0 if fill_on else 0.0,
            "vec0valuew": 1.0 if stroke_on else 0.0}
    for i, vals in ((1, g), (2, a), (3, fc), (4, sc)):
        for j, k in enumerate("xyzw"):
            pars["vec%dvalue%s" % (i, k)] = float(vals[j])
    return pars


# --------------------------------------------------------------------------- v6: content bounds / skip rules


def _finite_box(b):
    return all(isinstance(v, (int, float)) and math.isfinite(v) for v in b)


def affine_box(aff, rect):
    """Axis aligned bounds (x0, y0, x1, y1 floats, document px) of the layer-space rect ``rect`` = (x0, y0, x1, y1)
    mapped through the layer's :class:`Affine` (``doc = (x, y) + lin @ layer``)."""
    a, b, c, d = aff.lin
    tx, ty = aff.xf[0], aff.xf[1]
    x0, y0, x1, y1 = rect
    xs, ys = [], []
    for u, v in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        xs.append(tx + a * u + b * v)
        ys.append(ty + c * u + d * v)
    return (min(xs), min(ys), max(xs), max(ys))


def clip_box(box, doc_w, doc_h, pad=0):
    """Float document box -> integer pixel box (outward rounded, ``pad`` extra pixels) clipped to the canvas, or None
    when it does not overlap the canvas.  A non-finite box is the whole canvas."""
    if not _finite_box(box):
        return (0, 0, int(doc_w), int(doc_h))
    x0 = max(0, int(math.floor(box[0])) - pad)
    y0 = max(0, int(math.floor(box[1])) - pad)
    x1 = min(int(doc_w), int(math.ceil(box[2])) + pad)
    y1 = min(int(doc_h), int(math.ceil(box[3])) + pad)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


_BOX_MEMO = {}


def layer_box(aff, sw, sh, doc_w, doc_h, hint=None):
    """:func:`_layer_box` memoised (an apply() asks for every pixel layer; ``aff`` objects are memoised by layer_affine)."""
    key = (aff, sw, sh, doc_w, doc_h, hint)
    try:
        return _BOX_MEMO[key]
    except KeyError:
        if len(_BOX_MEMO) > 2048:
            _BOX_MEMO.clear()
        out = _BOX_MEMO[key] = _layer_box(aff, sw, sh, doc_w, doc_h, hint)
        return out
    except TypeError:                    # unhashable hint
        return _layer_box(aff, sw, sh, doc_w, doc_h, hint)


def _layer_box(aff, sw, sh, doc_w, doc_h, hint=None):
    """Document-space pixel box a pixel / input layer can touch: its surface rect (``sw`` x ``sh``) through ``aff``,
    clipped to the canvas, or None (nothing visible: outside the canvas, a singular matrix, an empty ``hint``).

    ``hint`` = optional content bounds in LAYER pixels (x0, y0, x1, y1) of everything non-transparent (the ext's
    dirty / content bounds; it must be a SUPERSET: pixels outside it are transparent) or :data:`EMPTY_HINT`.  The box is
    padded by 1 px (partial coverage of rotated edges) and, with a hint, by the filter reach (magnification + 2 px)."""
    if aff.dead:
        return None
    rect = (0.0, 0.0, float(sw), float(sh))
    pad = 0 if aff.exact else 1
    if hint is not None:
        if len(hint) == 0:
            return None                                     # EMPTY_HINT: the only hint that skips the layer
        try:
            hx0, hy0, hx1, hy1 = (float(v) for v in hint)
            r = (max(0.0, hx0), max(0.0, hy0), min(float(sw), hx1), min(float(sh), hy1))
            if all(math.isfinite(v) for v in (hx0, hy0, hx1, hy1)) and r[2] > r[0] and r[3] > r[1]:
                rect = r             # a degenerate / non-finite / outside-the-surface rect is no hint at all (never a skip)
                if not aff.exact:
                    a, b, c, d = aff.lin
                    pad = int(math.ceil(max(math.hypot(a, c), math.hypot(b, d), 1.0))) + 2
        except (TypeError, ValueError):
            pass
    return clip_box(affine_box(aff, rect), doc_w, doc_h, pad)


def shape_box(spec, doc_w, doc_h):
    """Document-space pixel box a shape layer can draw into (geometry + stroke reach + antialiasing margin + arrowheads),
    clipped to the canvas, or None when nothing is drawn (no enabled fill / stroke with alpha, outside the canvas)."""
    spec = spec or {}
    try:
        t = spec.get("type", "rect")
        fill, stroke = spec.get("fill") or {}, spec.get("stroke") or {}
        fa = float((fill.get("color") or {}).get("a", 255)) > 0
        sa = float((stroke.get("color") or {}).get("a", 255)) > 0
        sw = max(0.0, float(stroke.get("width", 0.0)))
        fill_on = bool(fill.get("enabled")) and t != "line" and fa
        stroke_on = bool(stroke.get("enabled")) and (sw > 0.0 or t == "line") and sa
        if not (fill_on or stroke_on):
            return None
        sm = 0.5 * sw if stroke_on else 0.0
        if t in ("rect", "ellipse"):
            w, h = float(spec.get("w", 0.0)), float(spec.get("h", 0.0))
            cx, cy = float(spec.get("x", 0.0)) + w / 2.0, float(spec.get("y", 0.0)) + h / 2.0
            hw, hh = abs(w) / 2.0 + sm, abs(h) / 2.0 + sm
            r = math.radians(float(spec.get("rotation", 0.0) or 0.0))
            ex = abs(math.cos(r)) * hw + abs(math.sin(r)) * hh
            ey = abs(math.sin(r)) * hw + abs(math.cos(r)) * hh
        elif t == "line":
            x1, y1, x2, y2 = (float(spec.get(k, 0.0)) for k in ("x1", "y1", "x2", "y2"))
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            reach = 0.5 * sw
            if spec.get("arrowStart") or spec.get("arrowEnd"):
                reach = max(reach, 1.1 * max(8.0, 4.0 * sw))
            ex, ey = abs(x2 - x1) / 2.0 + reach, abs(y2 - y1) / 2.0 + reach
        elif t == "polygon":
            cx, cy = float(spec.get("cx", 0.0)), float(spec.get("cy", 0.0))
            ex = ey = max(0.0, float(spec.get("radius", 0.0))) + sm
        else:
            return (0, 0, int(doc_w), int(doc_h))
        return clip_box((cx - ex - 2.0, cy - ey - 2.0, cx + ex + 2.0, cy + ey + 2.0), doc_w, doc_h)
    except (TypeError, ValueError, AttributeError):
        return (0, 0, int(doc_w), int(doc_h))


def shift_shape_spec(spec, dx, dy):
    """A shallow copy of a ShapeSpec translated by (dx, dy) document px (rendering it into a cropped texture whose origin is
    the document point (-dx, -dy)).  Rotation and sizes are unchanged."""
    out = dict(spec)
    for kx, ky in (("x", "y"), ("x1", "y1"), ("x2", "y2"), ("cx", "cy")):
        if kx in out and ky in out:
            out[kx], out[ky] = float(out[kx]) + dx, float(out[ky]) + dy
    return out


def text_is_empty(spec):
    """A text layer that draws nothing: no printable characters, or a fully transparent colour."""
    spec = spec or {}
    try:
        if not str(spec.get("text", "")).strip():
            return True
        return float((spec.get("color") or {}).get("a", 255)) <= 0
    except (TypeError, ValueError):
        return False


def effect_aux_ref(effects):
    """The aux-image reference of an effect list (v7): the first enabled effect with ``source: 'aux'`` and a string
    ``auxSource`` of the form ``'layer:<layerId>'`` or ``'input:<n>'`` (n = 1..8).  Returns ``('layer', id)``,
    ``('input', n)`` or None.  One aux image per chain: later references in the same list are ignored."""
    for e in effects or ():
        if not isinstance(e, dict) or e.get("enabled", True) is False or e.get("source") != "aux":
            continue
        ref = e.get("auxSource")
        if isinstance(ref, dict):                       # canonical: {kind:'layer', id} | {kind:'input', input}
            if ref.get("kind") == "layer" and isinstance(ref.get("id"), str) and ref["id"]:
                return ("layer", ref["id"])
            if ref.get("kind") == "input":
                try:
                    n = int(ref.get("input"))
                except (TypeError, ValueError):
                    continue
                if 1 <= n <= MAX_INPUTS:
                    return ("input", n)
            continue
        if not isinstance(ref, str):
            continue
        kind, _, rest = ref.partition(":")        # shorthand 'layer:<id>' / 'input:<n>'
        if kind == "layer" and rest:
            return ("layer", rest)
        if kind == "input":
            try:
                n = int(rest)
            except ValueError:
                continue
            if 1 <= n <= MAX_INPUTS:
                return ("input", n)
    return None


def opacity_value(v):
    """Layer opacity as a float (invalid -> 1.0); the blend shader clamps it to 0..1."""
    try:
        v = float(1.0 if v is None else v)
    except (TypeError, ValueError):
        return 1.0
    return v if math.isfinite(v) else 1.0


# Text TOP parameter names (TouchDesigner 2025.32820) -- see text_pars
TEXT_PAR = {
    "text": "text", "font": "font", "size": "fontsizex", "colorr": "fontcolorr", "colorg": "fontcolorg",
    "colorb": "fontcolorb", "alpha": "fontalpha", "alignx": "alignx", "aligny": "aligny",
    "typeface": "typeface", "spacing": "linespacing", "wrap": "wordwrap",
    "posx": "positionx", "posy": "positiony", "border": "borderspace1",
}
TEXT_ASCENT = 0.8        # web/src/engine/textShape.ts ASCENT: baseline = 0.8 em below the em-box top


def text_fallback_metrics(spec):
    """Used when the Text TOP cannot be measured (unit tests, no TD): ascent / natural line pitch / widest line."""
    size = min(TEXT_SIZE[1], max(TEXT_SIZE[0], float(spec.get("size", 16.0))))
    lines = str(spec.get("text", ""))[:TEXT_MAX].split("\n")
    box = spec.get("boxWidth")
    if box is not None:                  # approximate the browser wrap with 0.5 em per character
        lines = wrap_text("\n".join(lines), float(box), lambda t: 0.5 * size * len(t))
    return {"asc": 0.75 * size, "pitch": 0.95 * size, "tw": 0.5 * size * max(len(l) for l in lines),
            "text": "\n".join(lines)}


def wrap_text(text, box_width, width):
    """The browser's greedy wrap, a literal port of layoutText (web/src/engine/textShape.ts): paragraphs split on
    "\\n", words on single spaces; the candidate line ``cur + " " + word`` is MEASURED (``width(str)``) and taken
    while its width is <= box_width; an over-long word is not broken; an empty paragraph is an empty line.
    Returns the list of lines."""
    lines = []
    for para in text.split("\n"):
        if para == "":
            lines.append(para)
            continue
        words = para.split(" ")
        cur = words[0]
        for w in words[1:]:
            cand = cur + " " + w
            if width(cand) <= box_width:
                cur = cand
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


TEXT_SIZE = (1.0, 4000.0)        # web sanitizeText: clamp(size, 1, 4000)
TEXT_LINE_HEIGHT = (0.2, 10.0)   # clamp(lineHeight, 0.2, 10)
TEXT_MAX = 20000


def default_typeface(bold, italic):
    """The typeface menu entry of a one-file-per-face family (Arial, Times New Roman, ...): Regular / Italic / Bold / Bold Italic."""
    return "Bold Italic" if bold and italic else "Bold" if bold else "Italic" if italic else "Regular"


_WEIGHTS = {"thin": 100, "hairline": 100, "extralight": 200, "ultralight": 200, "light": 300, "book": 400, "regular": 400, "roman": 400,
            "normal": 400, "medium": 500, "semibold": 600, "demibold": 600, "demi": 600, "bold": 700, "extrabold": 800, "heavy": 800,
            "black": 900, "ultra": 900}
_ODD_WIDTH = {"condensed", "narrow", "compressed", "extended", "expanded", "wide", "rounded", "cond"}


def typeface_score(name, bold, italic):
    """Distance of a typeface menu entry ('Bold Oblique', 'Medium Italic', 'Condensed ExtraBold') from the wanted style (lower =
    better): 1.5 per 100 weight units from 400 / 700, 2 for a wrong slant, 5 for a condensed / extended cut."""
    toks = re.findall(r"[a-z]+", name.lower())
    weight = max([_WEIGHTS[t] for t in toks if t in _WEIGHTS] or [400])
    ital = any(t in ("italic", "oblique", "slanted", "inclined") for t in toks)
    odd = any(t in _ODD_WIDTH for t in toks)
    return abs(weight - (700 if bold else 400)) / 100.0 * 1.5 + (0.0 if ital == bool(italic) else 2.0) + (5.0 if odd else 0.0)


def pick_typeface(menu, bold, italic):
    """The entry of a Text TOP ``typeface`` menu that best matches bold / italic (Helvetica: 'Oblique' / 'Bold Oblique' instead of
    'Italic' / 'Bold Italic'; Futura: 'Medium Italic'; Avenir: 'Heavy'), or None for an empty menu."""
    best, best_s = None, None
    for n in menu or ():
        sc = typeface_score(str(n), bold, italic)
        if best_s is None or sc < best_s - 1e-9:
            best, best_s = str(n), sc
    return best


# ---- font collections (.ttc): TouchDesigner's Text TOP lists every face of a collection in its typeface menu but always renders
# face 0 (measured live: Helvetica / Menlo / Avenir -- Bold, Oblique, ... all give the Regular glyphs; `bold` / `italic` toggles
# neither).  A single-face .ttf extracted from the collection and set as ``fontfile`` renders the right face.

FONT_DIRS = {
    "darwin": ("/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", "~/Library/Fonts"),
    "win32": ("C:\\Windows\\Fonts", "~\\AppData\\Local\\Microsoft\\Windows\\Fonts"),
    "linux": ("/usr/share/fonts", "/usr/local/share/fonts", "~/.fonts", "~/.local/share/fonts"),
}
_TTC_INDEX = None          # lower-case family -> [(path, face index, weight, italic)]


def _sfnt_tables(f, off):
    f.seek(off)
    hdr = f.read(12)
    if len(hdr) < 12:
        return {}
    nt = struct.unpack(">H", hdr[4:6])[0]
    recs = f.read(16 * nt)
    tabs = {}
    for i in range(min(nt, len(recs) // 16)):
        tag, _cs, o, ln = struct.unpack(">4sIII", recs[16 * i:16 * i + 16])
        tabs[tag] = (o, ln)
    return tabs


def _face_info(f, off):
    """({family names}, weight, italic) of the sfnt at ``off`` of an open binary file (name / OS/2 / head tables only)."""
    tabs = _sfnt_tables(f, off)
    if b"name" not in tabs:
        return None
    o, ln = tabs[b"name"]
    f.seek(o)
    data = f.read(min(ln, 1 << 20))
    _fmt, cnt, so = struct.unpack(">HHH", data[:6])
    names = {}
    for i in range(cnt):
        pid, _eid, lid, nid, nl, no = struct.unpack(">HHHHHH", data[6 + 12 * i:18 + 12 * i])
        if nid not in (1, 16):
            continue
        raw = data[so + no:so + no + nl]
        try:
            txt = raw.decode("utf-16-be") if pid in (0, 3) else raw.decode("mac_roman")
        except Exception:      # noqa: BLE001
            continue
        english = (pid == 3 and lid == 0x409) or (pid == 1 and lid == 0)
        if (nid, ) not in names or english:
            names[(nid, )] = txt
    fams = {names[k].strip().lower() for k in names if names[k].strip()}
    weight, italic, wclass = 400, False, 5
    if b"head" in tabs:
        f.seek(tabs[b"head"][0] + 44)
        mac = struct.unpack(">H", f.read(2))[0]
        weight, italic = (700 if mac & 1 else 400), bool(mac & 2)
    if b"OS/2" in tabs and tabs[b"OS/2"][1] >= 64:
        f.seek(tabs[b"OS/2"][0] + 4)
        weight, wclass = struct.unpack(">HH", f.read(4))
        weight, wclass = weight or 400, wclass or 5
        f.seek(tabs[b"OS/2"][0] + 62)
        sel = struct.unpack(">H", f.read(2))[0]
        italic = italic or bool(sel & 1) or bool(sel & 0x200)
    return fams, weight, italic, wclass


def ttc_index(dirs=None, refresh=False):
    """Index of the font collections installed on this machine: ``{lower-case family: [(path, face index, weight, italic)]}``
    (built once, header reads only -- a collection can be hundreds of MB)."""
    global _TTC_INDEX
    if _TTC_INDEX is not None and not refresh and dirs is None:
        return _TTC_INDEX
    index = {}
    plat = "darwin" if sys.platform == "darwin" else "win32" if sys.platform.startswith("win") else "linux"
    for d in (dirs if dirs is not None else FONT_DIRS.get(plat, ())):
        d = os.path.expanduser(d)
        for root, subdirs, files in os.walk(d):
            if root[len(d):].count(os.sep) >= 3:
                subdirs[:] = []
            for fn in files:
                if not fn.lower().endswith((".ttc", ".otc")):
                    continue
                path = os.path.join(root, fn)
                try:
                    with open(path, "rb") as f:
                        head = f.read(12)
                        if head[:4] != b"ttcf":
                            continue
                        n = min(struct.unpack(">I", head[8:12])[0], 256)
                        offs = struct.unpack(">%dI" % n, f.read(4 * n))
                        for i, off in enumerate(offs):
                            info = _face_info(f, off)
                            if info:
                                for fam in info[0]:
                                    index.setdefault(fam, []).append((path, i, info[1], info[2], info[3]))
                except Exception:      # noqa: BLE001 - unreadable / odd file: skip it
                    continue
    if dirs is None:
        _TTC_INDEX = index
    return index


def ttc_face(family, bold, italic, index=None):
    """(path, face index) of the face of a collection family closest to bold / italic (weight 700 / 400, slant), or None when
    ``family`` is not in any installed collection."""
    cands = (index if index is not None else ttc_index()).get(str(family).strip().lower())
    if not cands:
        return None
    # same weights as typeface_score: 1.5 per 100 weight units, 2 for a wrong slant, 5 for a condensed / extended cut (OS/2 usWidthClass != 5)
    best = min(enumerate(cands), key=lambda e: (abs(e[1][2] - (700 if bold else 400)) / 100.0 * 1.5 + (0.0 if e[1][3] == bool(italic) else 2.0)
                                                + (0.0 if e[1][4] == 5 else 5.0), e[0]))
    return best[1][0], best[1][1]


def _uid():
    return os.getuid() if hasattr(os, "getuid") else None


def font_cache_dir(directory=None):
    """The per-user font cache directory (``<temp>/raster_editor_fonts_<uid>``, mode 0700, created on demand).  Refuses a directory
    that exists but is not owned by this user (another user could plant a font file there)."""
    uid = _uid()
    d = directory or os.path.join(tempfile.gettempdir(), "raster_editor_fonts_%s" % (uid if uid is not None else "user"))
    os.makedirs(d, mode=0o700, exist_ok=True)
    if uid is not None:
        st = os.stat(d)
        if st.st_uid != uid:
            raise PermissionError("font cache directory %s is not owned by this user" % d)
        if st.st_mode & 0o077:
            os.chmod(d, 0o700)
    return d


def font_file_ok(path):
    """A cached extracted font: a non-empty regular file owned by this user."""
    try:
        st = os.stat(path)
    except OSError:
        return False
    return st.st_size > 0 and os.path.isfile(path) and (_uid() is None or st.st_uid == _uid())


def extract_ttc_face(path, index, directory=None):
    """Writes face ``index`` of the collection ``path`` as a standalone sfnt file (tables copied verbatim, each 4-byte aligned, directory
    order kept) and returns its path (cached by file name / size / mtime in :func:`font_cache_dir`).  Offsets / lengths read from the file
    are validated against its size; a damaged collection raises ``ValueError``."""
    st = os.stat(path)
    directory = font_cache_dir(directory)
    stem = re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(path))[0])
    dest = os.path.join(directory, "%s_%d_%d_%d.ttf" % (stem, index, st.st_size, int(st.st_mtime)))
    if font_file_ok(dest):
        return dest
    size = st.st_size
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != b"ttcf" or len(head) < 12:
            raise ValueError("not a font collection")
        n = struct.unpack(">I", head[8:12])[0]
        if not 0 <= index < n or 12 + 4 * n > size:
            raise ValueError("face index out of range")
        offs = struct.unpack(">%dI" % n, f.read(4 * n))
        off = offs[index]
        f.seek(off)
        sfnt = f.read(12)
        if len(sfnt) < 12:
            raise ValueError("truncated sfnt header")
        nt = struct.unpack(">H", sfnt[4:6])[0]
        if off + 12 + 16 * nt > size or nt > 512:
            raise ValueError("bad table directory")
        recs = [struct.unpack(">4sIII", f.read(16)) for _ in range(nt)]
        out = bytearray(sfnt) + bytearray(16 * nt)
        out += b"\0" * (((len(out) + 3) & ~3) - len(out))
        ents = []
        for tag, cs, o, ln in recs:
            if o + ln > size or ln > (64 << 20):
                raise ValueError("table %r outside the file" % tag)
            f.seek(o)
            ents.append((tag, cs, len(out), ln))
            out += f.read(ln)
            out += b"\0" * (-len(out) & 3)
    for i, (tag, cs, o, ln) in enumerate(ents):
        out[12 + 16 * i:28 + 16 * i] = struct.pack(">4sIII", tag, cs, o, ln)
    fd, tmp = tempfile.mkstemp(suffix=".part", dir=directory)       # unique per process / instance: no cross-instance races
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(out)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return dest


def text_pars(spec, doc_w, doc_h, metrics=None, face=None):
    """TextSpec -> Text TOP parameters (document resolution, transparent background, premultiplied).  Pure.

    Conventions (web/src/engine/textShape.ts): the layout block has its top-left at (x, y); with ``boxWidth`` it is
    that wide (greedy word wrap), otherwise as wide as the widest line.  Line pitch = size * lineHeight; the
    baseline of line 0 is ``(size*lineHeight - size)/2 + 0.8*size`` below y; align left / centre / right puts every
    line at the left / centre / right of the block.

    Text TOP mapping (all positions are TD pixels, y up; ``aligny = top``, ``alignx/y mode = metrics``):
    * the TOP's first line box starts at ``positiony`` below the top edge (positiony = -top); its baseline is
      ``asc`` below that, ``asc = textHeight - fontDescender`` of a one-line text (measured, hinting makes it
      non-linear), so ``top = y + (size*lh - size)/2 + 0.8*size - asc``.
    * the natural line pitch ``pitch0`` (measured: height of 2 lines - 1 line) is corrected with ``linespacing``
      (extra pixels) to ``size * lineHeight``.
    * word wrap is done HERE (the Text TOP can only wrap inside its own width): greedy at single spaces exactly like
      the browser, with widths from Text TOP measurements (per word, cached) and the lines handed over as "\\n"
      separated text (``metrics["text"]``, wordwrap off).  A word wider than the box overflows.
    * the block width ``bw`` (= boxWidth, or without a box the widest line measured) anchors centre / right
      alignment: ``positionx = x + bw/2 - W/2`` (centre), ``x + bw - W`` (right), ``x`` (left).
    * ``face`` = ``(typeface menu entry, font file or "")`` (:meth:`DocNetwork.text_face`): a font-collection family's bold /
      italic face is a standalone font file; default = the plain Regular / Italic / Bold / Bold Italic menu entry.
    """
    spec = spec or {}
    P = TEXT_PAR
    m = metrics if metrics is not None else text_fallback_metrics(spec)
    c = _rgba(spec.get("color"), (0, 0, 0, 255))
    align = spec.get("align", "left")
    if align not in ("left", "center", "right"):
        align = "left"
    size = min(TEXT_SIZE[1], max(TEXT_SIZE[0], float(spec.get("size", 16.0))))
    lh = min(TEXT_LINE_HEIGHT[1], max(TEXT_LINE_HEIGHT[0], float(spec.get("lineHeight", 1.2))))
    x, y = float(spec.get("x", 0.0)), float(spec.get("y", 0.0))
    W = float(doc_w)
    box = spec.get("boxWidth")
    top = y + (size * lh - size) / 2.0 + TEXT_ASCENT * size - float(m["asc"])
    bw = max(1.0, float(box)) if box is not None else float(m.get("tw", 0.0))      # block width
    border = 0.0
    posx = x if align == "left" else x + bw / 2.0 - W / 2.0 if align == "center" else x + bw - W
    return {
        "outputresolution": "custom", "resolutionw": int(doc_w), "resolutionh": int(doc_h),
        "format": "rgba8fixed",
        "bgcolorr": 0.0, "bgcolorg": 0.0, "bgcolorb": 0.0, "bgalpha": 0.0,
        P["text"]: str(m.get("text", spec.get("text", "")))[:TEXT_MAX], P["font"]: str(spec.get("font", "")),
        "fontsizexunit": "pixels", "fontsizeyunit": "pixels", P["size"]: size, "fontsizey": size,
        P["colorr"]: c[0], P["colorg"]: c[1], P["colorb"]: c[2], P["alpha"]: c[3],
        P["alignx"]: align, "alignxmode": "metrics", P["aligny"]: "top", "alignymode": "metrics",
        "typeface": face[0] if face else default_typeface(spec.get("bold"), spec.get("italic")),
        "fontfile": face[1] if face else "",
        P["spacing"]: size * lh - float(m["pitch"]),
        P["wrap"]: False, P["border"]: border,
        P["posx"]: posx, P["posy"]: -top,
    }


# blend.glsl uAdjust codes (2..6 were the classic adjustments, 9 / 10 the blur pyramid: gone in v8 -- they are effect types now)
ADJ_BLEND, ADJ_PREMULT = 0, 1
ADJ_RESAMPLE = 7


class _OutOfBudget(Exception):
    pass


class _Node:
    """Desired state of one operator."""

    __slots__ = ("name", "optype", "pars", "inputs", "bypass", "pos", "glsl", "multi")

    def __init__(self, name, optype, pars=None, inputs=(), bypass=False, pos=(0, 0)):
        self.name = name
        self.optype = optype
        self.pars = pars or {}
        self.inputs = list(inputs)
        self.bypass = bypass
        self.pos = pos
        self.glsl = optype in ("glslTOP", "glslmultiTOP")
        self.multi = optype == "glslmultiTOP"


class DocNetwork:
    def __init__(self, comp, blend_glsl, clock=time.monotonic, shape_glsl=None, effects=None, effect_shaders=None,
                 optimize=True):
        """``optimize`` (v6, default on): bounding-box blending, skipped invisible / empty layers, merged multi-layer passes,
        8 bit intermediates, blur pyramid, pre-warmed spare nodes (module docstring and docs/DESIGN_V6.md 2).  Off = the v5
        network: one 16 bit blend pass per layer (kept for A/B measurements and as an escape hatch)."""
        self._opt = bool(optimize)
        self.comp = comp
        self._blend_glsl = blend_glsl
        self._shape_glsl = shape_glsl if shape_glsl is not None else _read_sibling("shape.glsl")
        self._clock = clock
        self.doc = comp.op("doc") or comp.create("baseCOMP", "doc")
        self._ops = {}        # name -> operator (every node we manage, incl. surfaces pending destroy)
        self._gen = {}        # name -> generation (bumped whenever the operator behind a name changes)
        self._gen_counter = 0
        self._cache = {}      # name -> {"type", "pars", "inputs", "bypass", "pos"}
        self._pending = {}    # surface name -> destroy deadline
        self._pool = []       # spare glsl TOPs [(op, cache)]
        self._pool_serial = 0
        self._mpool = []      # spare GLSL Multi TOPs for merged passes
        self._mpool_serial = 0
        self._shape_cropped = set()     # shape layers cropped by the last plan (crop hysteresis)
        self._active = None   # set_active_layer(): the layer being edited (its own pass, runs split around it)
        self._hints = {}      # layer id -> content bounds hint (set_content_bounds)
        self._boxes = {}      # layer id -> document box of the last plan's cropped resample pass
        self._plan_info = {}
        self._warm_src = None     # tiny constant TOP the spares are cooked against
        self._last_apply_t = -1e9
        self._unknown_names = []
        self._junk = []       # companion DATs TD auto-creates (g1_info, g1_pixel, s3_callbacks ...)
        self._garbage = []    # disconnected operators waiting to be destroyed by tick()
        self._adopt = {}
        self._metrics = {}    # (resolved font, bold, italic, size) -> measured text metrics
        self._faces = {}      # (resolved font, bold, italic) -> (typeface, font file)
        self._face_fail = {}  # same key -> clock time before which a failed face is not retried
        self.font_error = None
        self._budget = MEASURE_BUDGET
        self._text_nodes = {}  # text node name -> (spec, doc_w, doc_h)
        self._text_todo = set()     # text nodes laid out with the fallback metrics, finished by tick()
        self._text_rev = {}         # text node name -> bumped whenever tick()/status refines its layout
        self._text_retry = {}       # text node name -> (consecutive failures, retry not before)
        self._fontset = None
        self._fonts_at = -1e9
        self._widths = collections.OrderedDict()     # LRU: (font key, string or its hash) -> measured width
        self._names = {}      # layer id -> sanitised, unique
        self._used_names = set()
        self._desired = {}
        self._slots = {}      # slot -> node name (live surfaces)
        self._new_sizes = {}
        self._slot_sizes = {}  # slot -> (w, h) of the surface (document size when the spec has none)
        self._slot_nodes = {}
        self._prev_layers = None
        self._prev_stack = None
        self._prev_size = None
        self._prev_reqs = None
        self._cur = None             # (layers, doc_w, doc_h) of the last apply(): render requests re-plan with it
        self._reqs = {}              # render request key -> {spec, tag, sig, out, texts, slots, error}
        self._input_connected = None   # {input: bool} of the last apply()
        self._declared = {}            # set_inputs(): fallback for inputs whose COMP connector is not readable
        self._scanned = False
        self._view = None
        self._view_state = {}
        self._counters = {"created": 0, "destroyed": 0, "par_sets": 0, "connects": 0,
                          "disconnects": 0, "recycled": 0, "applies": 0, "unknown": 0, "forced": 0}
        self._last = {}
        self._last_ms = 0.0
        self._chains = {}      # layer id -> effects.EffectChain
        self._fx_fail = {}     # layer id -> (consecutive failures, retry not before, effect-list key)
        self._fx_todo = {}     # planned effect chains: alias node name -> (layer id, source node name, effects, pos)
        self._fx_out = {}      # alias node name -> the chain's output operator
        self._fx_aux = {}      # alias node name -> ('layer', id) | ('input', n): the chain's aux image reference
        self._content = {}     # layer id -> node name of its doc-space content (post effects) for layers used as an aux source
        self._preview = {}     # layer id -> alias node name of a tdPreview chain (the layer's post-effects content)
        self._fx_keys = {}     # alias node name -> signature of the chain's effect list + aux reference
        self.fx_error = None   # why layer effects are unavailable / the last chain failure (None = fine)
        self._fx, self._fx_shaders = None, None
        self._init_effects(effects, effect_shaders)
        self._ensure_base_nodes()

    # ------------------------------------------------------------------ public API

    def apply(self, layers, doc_w, doc_h):
        t0 = time.perf_counter()
        self._last_apply_t = self._clock()
        counters0 = dict(self._counters)
        doc_w, doc_h = int(doc_w), int(doc_h)
        connected = self._detect_inputs()
        key = (doc_w, doc_h)
        snap = json.dumps(layers)         # (key order follows the ext's parser: a different order only costs a re-plan)
        reqs = self._reqs_key()
        self._cur = (layers, doc_w, doc_h)
        if snap == self._prev_layers and key == self._prev_size and connected == self._input_connected and reqs == self._prev_reqs:
            self._last = {k: 0 for k in self._counters}
            self._last_ms = (time.perf_counter() - t0) * 1e3
            return
        self._input_connected = connected
        self._ensure_base_nodes()
        self._budget = MEASURE_BUDGET
        desired = self._plan(layers, doc_w, doc_h, connected)
        self._reconcile(desired)
        self._prev_layers = snap
        self._prev_stack = [{"id": l.get("id"), "kind": l.get("kind")} for l in layers]
        ids = {l.get("id") for l in layers}
        for k in [k for k in self._hints if k not in ids]:       # hints of deleted layers (no re-plan needed)
            del self._hints[k]
        if self._active is not None and self._active not in ids:
            self._active = None
        self._prev_size = key
        self._prev_reqs = reqs
        self._counters["applies"] += 1
        self._last_ms = (time.perf_counter() - t0) * 1e3
        self._last = {k: self._counters[k] - counters0[k] for k in self._counters}

    def tick(self):
        """Housekeeping, cheap, call once per frame: destroys ONE expired surface (2 s grace) or ONE
        garbage node, otherwise tops up the spare GLSL pool by one node (a few ms at most).  First it finishes
        pending text measurements (``MEASURE_BUDGET`` cooks per tick)."""
        if self._text_todo and self._text_due():
            self._refresh_texts()
            return
        if self._tick_pending():
            return
        if self._garbage:
            self._collect_garbage(1)
            return
        self._prune()
        if self._junk:
            self._destroy_op(self._junk.pop())
            return
        # a big paste (> POOL_TARGET layers) drains the pool: refill two per tick while it is nearly empty
        topped = False
        for _ in range(2 if len(self._pool) < 2 else 1):
            if len(self._pool) < POOL_TARGET:
                self._pool.append(self._make_pool_node())
                topped = True
        if not topped and self._opt and len(self._mpool) < MPOOL_TARGET:
            self._mpool.append(self._make_multi_node())
            topped = True
        if PREWARM and not topped and self._opt and self._clock() - self._last_apply_t >= WARM_IDLE_S:
            self._warm_one()

    def surface_top(self, slot):
        slot = int(slot)
        name = self._slots.get(slot)
        if name is None and ("s%d" % slot) in self._pending:
            name = "s%d" % slot
        return self._ops.get(name) if name else None

    def slots(self):
        return sorted(self._slots)

    def surface_size(self, slot):
        """(w, h) the Script TOP of ``slot`` is allocated at (the layer's surfaceW x surfaceH; masks: the size of their
        layer's surface; document size when the spec has no size), or None for an unknown slot."""
        slot = int(slot)
        if slot in self._slot_sizes:
            return self._slot_sizes[slot]
        top = self.surface_top(slot)
        return (int(top.width), int(top.height)) if top is not None else None

    def _text_status(self, name):
        """'ready' | 'pending' | 'failed' of one Text TOP's layout; does a bounded amount of measurement work (FLATTEN_BUDGET cooks)."""
        if name is None or name not in self._text_todo:
            return "ready"
        node, op = self._text_nodes.get(name), self._ops.get(name)
        if node is not None and op is not None and self._clock() >= self._text_retry.get(name, (0, 0.0))[1]:
            old = self._budget
            self._budget = FLATTEN_BUDGET
            try:
                metrics, complete = self._text_metrics(node[0], name)
                pars0 = self._counters["par_sets"]
                self._set_pars(name, op, self._text_pars(node[0], node[1], node[2], metrics))
                if self._counters["par_sets"] != pars0:           # a poll that changes nothing keeps the token
                    self._text_rev[name] = self._text_rev.get(name, 0) + 1
                if complete:
                    self._text_todo.discard(name)
            finally:
                self._budget = old
        if name not in self._text_todo:
            return "ready"
        return "failed" if self._text_retry.get(name, (0, 0.0))[0] > 0 else "pending"

    # ---- v8 render requests: flatten / merge down / merge selected --------------------------------------------------
    # A request is a temporary network ``rqout_<tag>`` planned (and reconciled) with the document: the same planner turns a synthetic
    # layer list (copies of the requested layers with their own ids ``<tag>.<id>``, sharing the surfaces) into nodes, so effects, masks,
    # transforms, blend modes, groups and adjustments behave exactly as in the document.  The nodes are removed again by
    # :meth:`render_close`.  The ext re-resolves :meth:`render_source` every frame and checks :meth:`render_token` before and after the
    # readback (like the v4 text / shape flatten).

    def _reqs_key(self):
        return tuple(sorted((k, json.dumps(v["spec"], sort_keys=True)) for k, v in self._reqs.items()))

    def render_open(self, key, kind, layer_id=None, layer_ids=None, mode="flatten"):
        """Start a render request.  ``kind`` 'layer' (``layer_id``, ``mode`` 'flatten' | 'mergeDown') or 'layers' (``layer_ids``).
        Returns None, or an error string (unknown layer, nothing below an adjustment, ...).  Plans the temporary nodes at once
        (one apply() of the last document)."""
        if self._cur is None:
            return "no document"
        if key in self._reqs:
            self.render_close(key)
        spec = {"kind": kind, "layerId": layer_id, "layerIds": list(layer_ids or ()), "mode": mode}
        used = {v["tag"] for v in self._reqs.values()}
        tag = next("q%d" % i for i in range(1 << 16) if "q%d" % i not in used)
        try:
            self._request_layers(self._cur[0], spec, tag)
        except ValueError as e:
            return str(e)
        self._reqs[key] = {"spec": spec, "tag": tag, "sig": None, "out": None, "texts": set(), "slots": set(), "inputs": set(), "ids": frozenset(), "error": None}
        self._replan()
        return self._reqs[key].get("error")

    def render_close(self, key):
        """End a render request: its temporary nodes are removed (by the re-plan; destroys are deferred to tick())."""
        if self._reqs.pop(key, None) is not None and self._cur is not None:
            self._replan()

    def _replan(self):
        layers, w, h = self._cur
        self.apply(layers, w, h)

    def render_error(self, key):
        rq = self._reqs.get(key)
        return None if rq is None else rq.get("error")

    def render_source(self, key):
        """The TOP with the request's result: document size, premultiplied RGBA, transparent where nothing is drawn.  ``None``
        when the request is gone, invalid (its layer was deleted / changed kind) or its operator is gone."""
        rq = self._reqs.get(key)
        if rq is None or rq.get("out") is None:
            return None
        op = self._ops.get(rq["out"])
        return op if op is not None and op.valid else None

    def render_token(self, key):
        """Opaque value identifying the pixels :meth:`render_source` would produce now: the request's synthetic layers (spec, masks,
        transforms, effects), the document size, the node's identity, its text layouts and the cook counters of the surfaces it reads.
        Edits to other layers do not change it.  ``None`` = no source."""
        if self.render_source(key) is None:
            return None
        rq = self._reqs[key]
        cooks = tuple(getattr(self._ops.get("s%d" % sl), "totalCooks", 0) for sl in sorted(rq["slots"]))
        ins = tuple((n, getattr(self._ops.get("src_in%d" % n), "totalCooks", 0)) for n in sorted(rq["inputs"]))
        failed = tuple(sorted((i, self._fx_fail[i][2]) for i in rq["ids"] if i in self._fx_fail))   # a failed chain changes the picture
        return (rq["tag"], self._gen.get(rq["out"]), rq["sig"], self._prev_size,
                tuple(self._text_rev.get(n, 0) for n in sorted(rq["texts"])), cooks, ins, failed)

    def render_status(self, key):
        """'ready' | 'pending' | 'failed' (text layouts still being measured / unmeasurable, or an effect chain of the request failed: its
        layer would be baked without the effects) | None (no source)."""
        if self.render_source(key) is None:
            return None
        rq = self._reqs[key]
        if any(i in self._fx_fail for i in rq["ids"]):
            return "failed"
        st = [self._text_status(n) for n in sorted(rq["texts"])]
        return "failed" if "failed" in st else "pending" if "pending" in st else "ready"

    def render_ready(self, key):
        return self.render_status(key) == "ready"

    def _request_layers(self, layers, spec, tag):
        """The synthetic layer list of a render request (ids ``<tag>.<id>``; top-level layers of the request have no parent).  Raises
        ValueError with a user message for a request that cannot be served.  Flatten = the layer alone (opacity 1, Normal, visible; mask,
        transform and effects kept; a group with its descendants); mergeDown = the layer below the adjustment (as flatten) + the adjustment
        (opacity, mask, effects kept); layers = the given layers in stack order with their own opacity / blend / visibility."""
        byid = {l.get("id"): l for l in layers if isinstance(l, dict)}
        kids = {}
        for l in layers:
            kids.setdefault(l.get("parentId") if l.get("parentId") in byid else None, []).append(l)
        order = {}

        def walk(pid):
            for l in kids.get(pid, ()):
                order[l["id"]] = len(order)
                walk(l["id"])
        walk(None)

        def new(l, parent, **over):
            return dict(l, id="%s.%s" % (tag, l["id"]), parentId=parent, **over)

        def tree(l, out, **over):
            """``l`` (overrides applied) as a root, then all its descendants."""
            out.append(new(l, None, **over))
            stack = [l["id"]]
            while stack:
                pid = stack.pop()
                for k in kids.get(pid, ()):
                    out.append(new(k, "%s.%s" % (tag, pid)))
                    stack.append(k["id"])

        def plain(l):
            return dict(visible=True, opacity=1.0, blend="normal")

        def merge_down(l):
            sib = kids.get(l.get("parentId") if l.get("parentId") in byid else None, [])
            i = sib.index(l)
            if i == 0:
                raise ValueError("there is nothing below this adjustment layer to merge into")
            below = sib[i - 1]
            if below.get("kind") == "adjustment":
                raise ValueError("cannot merge into an adjustment layer")
            out = []
            tree(below, out, **plain(below))
            out.append(new(l, None, visible=True))
            return out

        out = []
        if spec["kind"] == "layers":
            ids = [i for i in spec["layerIds"] if i in byid]
            if len(ids) != len(spec["layerIds"]):
                raise ValueError("a layer to render does not exist in TouchDesigner's document")
            chosen = set(ids)

            def covered(l):
                p = l.get("parentId")
                while p in byid:
                    if p in chosen:
                        return True
                    p = byid[p].get("parentId")
                return False
            for l in sorted((byid[i] for i in ids if not covered(byid[i])), key=lambda x: order[x["id"]]):
                tree(l, out)
            return out
        l = byid.get(spec["layerId"])
        if l is None:
            raise ValueError("layer %r is not in TouchDesigner's document" % (spec["layerId"],))
        if spec["mode"] == "mergeDown" or l.get("kind") == "adjustment":
            if l.get("kind") != "adjustment":
                raise ValueError("only an adjustment layer can be merged down")
            return merge_down(l)
        tree(l, out, **plain(l))
        return out

    def output(self):
        return self._ops.get("out")

    def set_inputs(self, connected):
        """The ext calls this when COMP inputs are (dis)connected: ``connected`` = ``{input (1..8): bool}`` or the
        protocol's ``[{input, connected, ...}]`` list (inputs not mentioned keep their last value).  apply() also reads the COMP's connectors itself (they win where they
        exist); this is the explicit notification and the fallback for inputs without a readable connector.  The
        ``src_in<N>`` Select TOPs are re-pointed at once and the next apply() re-plans (a transform only applies to a
        connected input).  Cheap; call it on every input change.

        ONE-FRAME CAVEAT: only the Select re-point happens here.  The input layer's transform / effects / resample
        node and its mask wiring depend on "connected" and are rebuilt by the NEXT ``apply()`` (this call only drops
        the stored-stack snapshot so that apply() re-plans even with an unchanged stack).  Until then the input is
        shown with the previous plan (untransformed / mis-placed for a newly connected input, a stale transform on a
        disconnected one).  The ext therefore calls ``apply(last stack)`` right after ``set_inputs`` in the same
        frame."""
        changed = []
        if not isinstance(connected, dict):          # the protocol's [{input, w, h, connected}] list
            connected = {int(i["input"]): bool(i.get("connected")) for i in (connected or ())}
        for k, v in connected.items():
            k, v = int(k), bool(v)
            if 1 <= k <= MAX_INPUTS and (self._declared.get(k, False) != v or (self._input_connected or {}).get(k, v) != v):
                self._declared[k] = v
                changed.append(k)
        if changed and self._prev_layers is not None:
            self._input_connected = None
            self._prev_layers = None
            for k in changed:
                self._set_input_source(k, self._declared[k])

    def set_input_connected(self, flag):
        """Legacy (v5) form of :meth:`set_inputs` for input 1."""
        self.set_inputs({1: bool(flag)})

    def set_content_bounds(self, bounds):
        """OPTIONAL hint (v6): tighter content bounds per pixel layer than its whole surface.  ``bounds`` =
        ``{layer id: (x0, y0, x1, y1) | None}`` in LAYER pixels (surface coordinates, top-left origin, x1 / y1 exclusive);
        ``None`` (or ``()``) = the layer has no visible pixel at all (it is skipped).  A layer id that is not mentioned
        has no hint (the whole surface is used); ``{}`` clears everything.

        The hint MUST be a superset of the non-transparent pixels (e.g. the union of all dirty rects since the surface
        was empty, or an exact scan): the resample pass of a transformed layer renders only the transformed hint rect, so
        pixels outside it would vanish.  Only transformed (resampled) layers get a smaller texture from it; an integer
        offset layer is placed by the blend pass directly and only profits from the skip of an empty one.  The change
        takes effect at the NEXT :meth:`apply` (this call only drops the stored-stack snapshot so that apply() re-plans
        even for an unchanged stack, like :meth:`set_inputs`); it is cheap and idempotent (an identical hint is a no-op)."""
        new = {}
        try:
            items = list((bounds or {}).items())
        except (TypeError, AttributeError):
            items = []
        for k, v in items:
            if v is None or (hasattr(v, "__len__") and len(v) == 0):
                new[k] = EMPTY_HINT
                continue
            try:
                box = tuple(float(x) for x in v)
            except (TypeError, ValueError):
                continue                                     # not numeric: no hint for this layer
            if len(box) == 4 and all(math.isfinite(x) for x in box) and box[2] > box[0] and box[3] > box[1]:
                new[k] = box                                 # (a degenerate non-empty rect is no hint: only None / () skips)
        if new != self._hints:
            self._hints = new
            self._prev_layers = None

    def set_active_layer(self, layer_id):
        """OPTIONAL hint (v6): the layer being edited / painted.  Merged runs are split around it so the active layer has a
        pass of its own: an edit then recooks that one pass plus everything above it instead of the whole merged run it
        would otherwise sit in (8 layers of fetches: ~3 ms at 4K for a run of full-size layers).  The stack below the
        active layer stays cached by TD.  ``None`` clears.  Takes effect at the next :meth:`apply` (drops the snapshot);
        changing the active layer re-plans (a few connections move), so call it on selection changes, not per stroke."""
        if layer_id != self._active:
            self._active = layer_id
            self._prev_layers = None

    def content_box(self, layer_id):
        """The document pixel box (x0, y0, x1, y1) of the cropped resample pass of the last apply() for ``layer_id``,
        or None when that layer is not cropped (exact placement, full-size, skipped, unknown)."""
        return self._boxes.get(layer_id)

    # ---- tdPreview layers (docs/DESIGN_V6.md 5, PROTOCOL.md 9) -----------------------------------------------------------

    def preview_layers(self):
        """Ids (stack order, bottom -> top) of the layers of the last apply() whose effects / filter contain a planner-flagged
        ``tdPreview`` type (``effects.effect_td_preview``) and whose chain is live.  The browser's Local preview shows TD's render of
        these layers: the ext reads :meth:`layer_preview_source` back when :meth:`layer_preview_token` changed."""
        order = [l.get("id") for l in (self._prev_stack or ())]
        return [i for i in order if i in self._preview and self._preview_op(i) is not None]

    def _preview_op(self, layer_id):
        alias = self._preview.get(layer_id)
        if alias is None or layer_id in self._fx_fail or layer_id not in self._live:
            return None
        op = self._fx_out.get(alias)
        return op if op is not None and op.valid else None

    def layer_preview_source(self, layer_id):
        """The TOP with the layer's content AFTER its effects, in DOCUMENT space and document size, PREMULTIPLIED RGBA (TD row
        order, rgba8fixed): for a pixel / input / text / shape layer its masked, transformed content through its effect chain; for
        a group the isolated composite through its chain (its mask applied first); for an adjustment layer the adjusted result
        through the chain (the stack applied to the composite below, i.e. before the opacity x mask mix).
        Never includes the layer's opacity, blend mode or (except groups / pixel layers, where it is applied before the effects)
        its mask.  ``None`` when the layer has no tdPreview effect, is hidden (itself or an ancestor; opacity 0 too), its chain failed (no effects would be shown) or it is gone."""
        return self._preview_op(layer_id)

    def layer_preview_token(self, layer_id):
        """Opaque, comparable value that changes whenever :meth:`layer_preview_source` may show different pixels: the chain's
        identity / effect list / aux reference, the document size, and the cook counters of the chain output and its input
        (hidden layers have no preview, so every previewed layer is pulled by the document output and its counters follow its edits).
        ``None`` = no preview for this layer."""
        op = self._preview_op(layer_id)
        if op is None:
            return None
        alias = self._preview[layer_id]
        entry = self._fx_todo.get(alias)
        src_op = self._ops.get(entry[1]) if entry else None
        return (self._gen.get(alias), self._fx_keys.get(alias), self._prev_size, getattr(op, "totalCooks", 0),
                getattr(src_op, "totalCooks", 0) if src_op is not None else 0)

    def freeze(self):
        """Lock every surface TOP so its pixels are stored with the file.

        Verified TD behaviour: locking a Script TOP resets its locked image (128x128 blank) and the
        pixels must be written AFTER the lock, so this calls ``comp.OnSurfaceCook(top)`` (the ext's promoted
        method, which must copy the whole surface buffer) right after ``lock = True``.  Do not read
        ``numpyArray()`` of the TOP between the two."""
        for slot in sorted(self._slots):
            top = self._ops[self._slots[slot]]
            if not top.lock:
                top.lock = True
                self.comp.OnSurfaceCook(top)

    def thaw(self):
        for slot in sorted(self._slots):
            top = self._ops[self._slots[slot]]
            if top.lock:
                top.lock = False

    def read_locked(self):
        out = {}
        for slot in sorted(self._slots):
            top = self._ops[self._slots[slot]]
            if top.lock:
                arr = top.numpyArray()
                if arr is not None:
                    out[slot] = arr
        return out

    def stats(self):
        types = {}
        for name, c in self._cache.items():
            types[c["type"]] = types.get(c["type"], 0) + 1
        return {
            "nodes": len(self._ops), "surfaces": len(self._slots), "pending_destroy": len(self._pending),
            "pool": len(self._pool), "mpool": len(self._mpool), "plan": dict(self._plan_info), "garbage": len(self._garbage), "junk": len(self._junk), "by_type": types, "last_apply_ms": self._last_ms,
            "last": dict(self._last), "totals": dict(self._counters),
            "view": self._view is not None, "fx_chains": len(self._chains),
            "fx_nodes": sum(c.node_count for c in self._chains.values()), "fx_error": self.fx_error,
        }

    # ---- TD-view overlay -----------------------------------------------------------------

    def set_view(self, view, panel_w, panel_h):
        if view is None:
            self._view = None
            return
        self._ensure_view_nodes()
        doc_w, doc_h = self._prev_size or (int(panel_w), int(panel_h))
        u = view_uniforms(view, panel_w, panel_h, doc_w, doc_h)
        self._view = (view, int(panel_w), int(panel_h))
        st = self._view_state
        node = self.comp.op("doc_view")
        if node is None:
            return
        vals = {
            "outputresolution": "custom", "resolutionw": int(panel_w), "resolutionh": int(panel_h),
            "inputfiltertype": "mipmap" if u[3] else "nearest",
            "vec0valuex": u[0], "vec0valuey": u[1], "vec0valuez": u[2], "vec0valuew": u[3],
            "vec1valuex": u[4], "vec1valuey": u[5], "vec1valuez": u[6], "vec1valuew": u[7],
        }
        for k, v in vals.items():
            if st.get(k) != v:
                setattr(node.par, k, v)
                self._counters["par_sets"] += 1
                st[k] = v

    def panel_view(self):
        if self._view is None and self.comp.op("panel_view") is None:
            self._ensure_view_nodes()
        return self.comp.op("panel_view")

    # ------------------------------------------------------------------ node plumbing

    def _ensure_base_nodes(self):
        doc = self.doc
        if "blend_glsl" not in self._ops:
            dat = doc.op("blend_glsl") or doc.create("textDAT", "blend_glsl")
            if dat.text != self._blend_glsl:
                dat.text = self._blend_glsl
            self._ops["blend_glsl"] = dat
            self._cache["blend_glsl"] = {"type": "textDAT", "pars": {}, "inputs": [], "bypass": False, "pos": None}
            dat.nodeX, dat.nodeY = -900, 200
        if "shape_glsl" not in self._ops:
            dat = doc.op("shape_glsl") or doc.create("textDAT", "shape_glsl")
            if dat.text != self._shape_glsl:
                dat.text = self._shape_glsl
            self._ops["shape_glsl"] = dat
            self._cache["shape_glsl"] = {"type": "textDAT", "pars": {}, "inputs": [], "bypass": False, "pos": None}
            dat.nodeX, dat.nodeY = -900, 300
        if "surface_callbacks" not in self._ops:
            dat = doc.op("surface_callbacks") or doc.create("textDAT", "surface_callbacks")
            if dat.text != SURFACE_CALLBACKS:
                dat.text = SURFACE_CALLBACKS
            self._ops["surface_callbacks"] = dat
            self._cache["surface_callbacks"] = {"type": "textDAT", "pars": {}, "inputs": [], "bypass": False, "pos": None}
            dat.nodeX, dat.nodeY = -900, 100

    def _detect_inputs(self):
        """{1..8: connected}: the COMP's input connectors where they exist, else the last :meth:`set_inputs` value."""
        try:
            conns = self.comp.inputConnectors
            n = len(conns)
        except Exception:
            conns, n = (), 0
        out = {}
        for k in range(1, MAX_INPUTS + 1):
            try:
                out[k] = bool(conns[k - 1].connections) if k <= n else bool(self._declared.get(k, False))
            except Exception:
                out[k] = bool(self._declared.get(k, False))
        return out

    def input_connected(self, n):
        """Whether input ``n`` was connected at the last apply()."""
        return bool((self._input_connected or {}).get(int(n), False))

    def _set_input_source(self, n, connected):
        name = "src_in%d" % n
        node = self._ops.get(name)
        if node is not None:
            self._set_pars(name, node, {"top": "../in%d" % n if connected else "blank"})

    def _alloc_name(self, layer_id):
        n = self._names.get(layer_id)
        if n is None:
            base = n = sanitize(layer_id)
            i = 2
            while n in self._used_names:
                n = "%s_%d" % (base, i)
                i += 1
            self._names[layer_id] = n
            self._used_names.add(n)
        return n

    # ------------------------------------------------------------------ text measurement

    def _measure_node(self):
        m = self._ops.get("text_measure")
        if m is None:
            m = self.doc.op("text_measure") or self.doc.create("textTOP", "text_measure")
            self._ops["text_measure"] = m
            self._cache["text_measure"] = {"type": "textTOP", "pars": {}, "inputs": [], "bypass": False, "pos": None}
            self._set_pars("text_measure", m, {
                "outputresolution": "custom", "resolutionw": 16, "resolutionh": 16, "format": "rgba8fixed",
                "fontsizexunit": "pixels", "fontsizeyunit": "pixels", "wordwrap": False, "linespacing": 0.0,
                "alignx": "left", "aligny": "top"})
            m.nodeX, m.nodeY = -900, 400
        return m

    def _font_names(self, refresh=False):
        """Families of the Text TOP's font menu (cached; re-read at most every 5 s while a requested font is
        missing, so a font installed later is picked up).  None = unknown."""
        now = self._clock()
        if self._fontset is None or (refresh and now - self._fonts_at > 5.0):
            try:
                self._fontset = set(self._measure_node().par.font.menuNames)
            except Exception:
                self._fontset = set()
            self._fonts_at = now
        return self._fontset or None

    def _resolve_font(self, font):
        """The family the Text TOP will really use: ``font`` if it is in the menu, else Helvetica (the metrics are
        cached by resolved family, so they follow a font that appears later)."""
        names = self._font_names()
        if names is not None and font not in names:
            names = self._font_names(refresh=True)
            if names is not None and font not in names:
                return "Helvetica"
        return font

    def text_face(self, spec):
        """``(typeface, fontfile)`` of the Text TOP for a TextSpec's family / bold / italic (cached).  Regular: the plain menu entry
        and no file.  Bold / italic: a family of an installed font COLLECTION (.ttc: Helvetica, Menlo, Avenir, ...) gets the matching
        face extracted to a standalone font file (the Text TOP ignores ``typeface`` / ``bold`` / ``italic`` for collections and
        always draws face 0); any other family gets the best entry of its own typeface menu (Helvetica-like menus say 'Oblique',
        Futura has no 'Italic').  Failures fall back to the plain entry."""
        bold, italic = bool(spec.get("bold")), bool(spec.get("italic"))
        plain = default_typeface(bold, italic)
        if not (bold or italic):
            return plain, ""
        font = self._resolve_font(str(spec.get("font", "")))
        key = (font, bold, italic)
        got = self._faces.get(key)
        if got is not None and (not got[1] or font_file_ok(got[1])):        # (the temp file may have been cleaned up)
            return got
        face = (plain, "")
        until = self._face_fail.get(key)
        if until is not None and self._clock() < until:
            return face                                                      # failed recently: no retry every apply / tick
        try:
            hit = ttc_face(font, bold, italic)
            if hit is not None:
                face = ("Regular", extract_ttc_face(*hit))
            else:
                m = self._measure_node()
                self._set_pars("text_measure", m, {"font": font})
                pick = pick_typeface(list(m.par.typeface.menuNames), bold, italic)
                if pick:
                    face = (pick, "")
        except Exception as e:      # noqa: BLE001 - fonts are cosmetic: never break the document
            self.font_error = "%s: %s" % (type(e).__name__, e)
            self._face_fail[key] = self._clock() + 30.0
            self._faces.pop(key, None)
            return face
        self._face_fail.pop(key, None)
        self._faces[key] = face
        return face

    def _text_pars(self, spec, doc_w, doc_h, metrics=None):
        return text_pars(spec, doc_w, doc_h, metrics, face=self.text_face(spec or {}))

    def _text_due(self):
        now = self._clock()
        return any(self._text_retry.get(n, (0, 0.0))[1] <= now for n in self._text_todo)

    def _text_metrics(self, spec, owner=None):
        """-> (metrics, complete).  ``asc`` (baseline below the line-box top) and ``pitch`` (natural line pitch) are
        measured per (resolved font, bold, italic, size); ``text`` is the text with the browser's wrap applied
        (candidate lines are measured, cached per string); ``tw`` = widest line (only when needed: centre / right
        without a box).  Measurements cook a 16x16 Text TOP (~0.3-1 ms each) and are cached.  At most
        ``self._budget`` cooks are spent per call: beyond that, or after a failure (retried with back-off) the
        0.5 em fallback layout is used and ``complete`` is False (tick() finishes the job over the next frames)."""
        size = min(TEXT_SIZE[1], max(TEXT_SIZE[0], float(spec.get("size", 16.0))))
        bold, italic = bool(spec.get("bold")), bool(spec.get("italic"))
        box = spec.get("boxWidth")
        text = str(spec.get("text", ""))[:TEXT_MAX]
        now = self._clock()
        if now < self._text_retry.get(owner, (0, 0.0))[1]:
            return dict(text_fallback_metrics(spec)), False
        try:
            font = self._resolve_font(str(spec.get("font", "")))
            key = (font, bold, italic, size)
            m = self._measure_node()
            ready = [False]

            def prepare():
                if not ready[0]:
                    face = self.text_face(spec)
                    self._set_pars("text_measure", m, {
                        "font": font, "typeface": face[0], "fontfile": face[1], "fontsizex": size, "fontsizey": size})
                    ready[0] = True

            def cook(s_):
                if self._budget <= 0:
                    raise _OutOfBudget()
                self._budget -= 1
                prepare()
                self._set_pars("text_measure", m, {"text": s_})
                m.cook(force=True)

            got = self._metrics.get(key)
            if got is None:
                cook("H")
                th1, desc = float(m.textHeight), float(m.fontDescender)
                cook("H\nH")
                got = {"asc": th1 - desc, "pitch": float(m.textHeight) - th1}
                self._metrics[key] = got

            def cached(k):
                w = self._widths.get(k)
                if w is not None:
                    self._widths.move_to_end(k)
                return w

            def store(k, w):
                self._widths[k] = w
                while len(self._widths) > WIDTH_CACHE_MAX:         # LRU: the entries a layer is using stay
                    self._widths.popitem(last=False)

            def skey(s_):       # long candidate lines are keyed by hash (a 20000 char paragraph is quadratic in size)
                return s_ if len(s_) <= 64 else hash(s_)

            def width(s_):
                if s_ == "":
                    return 0.0
                k = (key, skey(s_))
                w = cached(k)
                if w is None:
                    if s_[0] == " " or s_[-1] == " ":          # the Text TOP may trim outer spaces: bracket them
                        w = width_raw("|" + s_ + "|") - 2 * width_raw("|")
                    else:
                        w = width_raw(s_)
                    store(k, w)
                return w

            def width_raw(s_):
                k = (key, "raw", skey(s_))
                w = cached(k)
                if w is None:
                    cook(s_)
                    w = float(m.textWidth)
                    store(k, w)
                return w

            out = dict(got, text=text, tw=0.0)
            if box is not None:
                out["text"] = "\n".join(wrap_text(text, float(box), width))
            elif spec.get("align", "left") != "left":
                out["tw"] = max([width(l) for l in text.split("\n")] or [0.0])
            self._text_retry.pop(owner, None)
            return out, True
        except _OutOfBudget:
            return dict(text_fallback_metrics(spec)), False
        except Exception:
            fails = self._text_retry.get(owner, (0, 0.0))[0] + 1
            self._text_retry[owner] = (fails, now + min(30.0, 0.5 * 2 ** fails))
            return dict(text_fallback_metrics(spec)), False

    def _refresh_texts(self):
        """tick(): finish text layers whose measurements did not fit the per-apply budget (or failed)."""
        self._budget = MEASURE_BUDGET
        for name in sorted(self._text_todo):
            node = self._text_nodes.get(name)
            op = self._ops.get(name)
            if node is None or op is None:
                self._text_todo.discard(name)
                continue
            spec, w, h = node
            if self._clock() < self._text_retry.get(name, (0, 0.0))[1]:
                continue                                  # this layer is backing off; the others go on
            metrics, complete = self._text_metrics(spec, name)
            pars0 = self._counters["par_sets"]
            self._set_pars(name, op, self._text_pars(spec, w, h, metrics))
            if self._counters["par_sets"] != pars0:
                self._text_rev[name] = self._text_rev.get(name, 0) + 1
            if complete:
                self._text_todo.discard(name)
            if self._budget <= 0:
                break

    # ------------------------------------------------------------------ planning

    def _plan(self, layers, doc_w, doc_h, connected):
        d = {}
        self._fx_todo = {}
        self._fx_aux = {}
        self._content = {}
        self._preview = {}
        self._live = set()      # layers shown in the document (visible with opacity > 0, every ancestor too): the preview layers
        byid = {l.get("id"): l for l in layers}
        for l in layers:
            cur, ok, n = l, True, 0
            while cur is not None and n < 64:
                if not cur.get("visible", True) or not opacity_value(cur.get("opacity", 1.0)) > 0.0:
                    ok = False
                    break
                cur, n = byid.get(cur.get("parentId")), n + 1
            if ok:
                self._live.add(l.get("id"))
        self._text_nodes = {}
        self._text_todo = set()
        for gone in [n for n in self._text_retry if not n.startswith("text_")]:
            del self._text_retry[gone]
        self._slot_nodes = {}
        self._new_sizes = {}
        self._boxes = {}
        info = self._plan_info = {"layers": 0, "skipped": 0, "passes": 0, "merged": 0, "merged_layers": 0,
                                  "fmt8": 0, "cropped": 0, "skip_reasons": {}}
        opt = self._opt

        def add(node):
            d[node.name] = node
            return node

        children = {}
        for l in layers:
            children.setdefault(l.get("parentId"), []).append(l)
        known = {l["id"] for l in layers}
        # orphans (parent missing) are attached to the root so they are not lost
        for pid in [p for p in children if p is not None and p not in known]:
            children.setdefault(None, []).extend(children.pop(pid))

        res = {"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h}
        # v7: aux images of displace-like filters ('layer:<id>' / 'input:<n>'): layers used as a source keep a document-space,
        # uncropped content node; inputs get an identity resample ``auxin_<n>`` (document sized, top-left anchored)
        aux_targets, aux_inputs = set(), set()
        if self._fx is not None:
            for l in layers:
                ref = effect_aux_ref(self._effect_list(l))
                if ref is not None:
                    (aux_targets if ref[0] == "layer" else aux_inputs).add(ref[1])
        add(_Node("blank", "constantTOP", dict(res, colorr=0.0, colorg=0.0, colorb=0.0, alpha=0.0,
                                               format="rgba8fixed"), pos=(-600, 0)))

        row = [0]

        def surface(slot, x, y, w=None, h=None):
            """Script TOP of a surface, allocated at its own size (default: the document size)."""
            name = "s%d" % slot
            self._slot_nodes[slot] = name
            w = doc_w if not w else int(w)
            h = doc_h if not h else int(h)
            self._new_sizes[slot] = (w, h)
            if name not in d:
                add(_Node(name, "scriptTOP", {"outputresolution": "custom", "resolutionw": w, "resolutionh": h,
                                              "callbacks": "surface_callbacks"}, pos=(x, y)))
            return name

        def input_source(n):
            """Select TOP of COMP input ``n`` (created for the inputs a layer reads)."""
            name = "src_in%d" % n
            if name not in d:
                add(_Node(name, "selectTOP", {"top": "../in%d" % n if connected.get(n) else "blank"},
                          pos=(-600, -100 - 60 * n)))
            return name

        def blend_pars(mode, opacity, has_mask, adjust, xf, mip, fmt=FMT_BLEND, filt="nearest"):
            return {
                "vec0name": "uParams", "vec0valuex": float(mode), "vec0valuey": opacity_value(opacity),
                "vec0valuez": 1.0 if has_mask else 0.0, "vec0valuew": float(adjust),
                "vec1name": "uXform", "vec1valuex": xf[0], "vec1valuey": xf[1], "vec1valuez": xf[2],
                "vec1valuew": xf[3],
                "inputfiltertype": filt, "inputextenduv": "hold",
                "pixeldat": "blend_glsl", "format": fmt,
            }

        self._blend_pars = blend_pars

        def skip(reason):
            info["skipped"] += 1
            info["skip_reasons"][reason] = info["skip_reasons"].get(reason, 0) + 1

        def walk(kids, depth):
            """Phase 1: create the source nodes of a chain (surfaces, text / shape / resample / effect nodes) and return
            its blend *items* bottom -> top; :meth:`_emit` turns them into blend / merged nodes (it needs the whole chain)."""
            bx = depth * 700
            items = []
            for l in kids:
                extra = {}
                no_fx = False
                sid = self._alloc_name(l["id"])
                kind = l.get("kind")
                y = -row[0] * 160
                row[0] += 1
                info["layers"] += 1
                mask = l.get("mask")
                mask_name = None
                if mask and kind in ("pixel", "adjustment", "group", "input", "base", "text", "shape") and mask.get("slot") is not None:
                    # a mask lives in layer space: same size as the layer's surface (document size for the rest)
                    own = kind in ("pixel", "input", "base")
                    mw, mh = (l.get("surfaceW"), l.get("surfaceH")) if own else (None, None)
                    if own and kind in ("input", "base") and (not mw or not mh):
                        mw, mh = self._live_input_size(input_index(l)) or (None, None)      # (the ext normally states the input's size)
                    mask_name = surface(int(mask["slot"]), bx - 700, y - 60, mw, mh)
                    if not mask.get("enabled", True):
                        mask_name = None   # surface exists, but is not cooked / wired
                visible = bool(l.get("visible", True))
                opacity = l.get("opacity", 1.0)
                mode = BLEND_INDEX.get(l.get("blend", "normal"), 0)
                bname = "blend_L_" + sid
                aff = layer_affine(l)
                xf, mip = aff.xf, aff.mip
                skip_why = None          # v6: the layer provably adds nothing -> no blend pass (sources stay, uncooked)
                if opt:
                    if not visible:
                        skip_why = "hidden"
                    elif not opacity_value(opacity) > 0.0:
                        skip_why = "opacity"
                kids_items = None
                shape_full = None       # the full-size shape node, added below (not when the blend does not use it)
                sbox = None             # document box a text / shape / pixel layer can touch (None = nothing)
                if kind in ("input", "base"):
                    n_in = input_index(l)
                    src, adjust = input_source(n_in), 0
                    if not connected.get(n_in):
                        # nothing to transform / decorate: the source is the (document sized) transparent blank
                        aff, xf, mip = IDENTITY, IDENTITY_XF, False
                        no_fx = True
                        mask_name = None       # nothing to mask: the mask surface stays allocated but is not wired / cooked
                elif kind in ("text", "shape"):        # always TD rendered (v4: no rasterize, never a surface)
                    adjust = 0
                    spec = l.get(kind)
                    if not spec:
                        src = "blank"
                    elif kind == "text":
                        src = "text_" + sid
                        metrics, complete = self._text_metrics(spec, src)
                        self._text_nodes[src] = (spec, doc_w, doc_h)
                        if not complete:
                            self._text_todo.add(src)
                        add(_Node(src, "textTOP", self._text_pars(spec, doc_w, doc_h, metrics), (), pos=(bx - 350, y)))
                        if opt and text_is_empty(spec):
                            skip_why = skip_why or "empty"
                    else:
                        src = "shape_" + sid
                        pars = {"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h,
                                "pixeldat": "shape_glsl", "format": FMT_SHAPE,
                                "vec0name": "uParams", "vec1name": "uOffset", "vec2name": "uA", "vec3name": "uB",
                                "vec4name": "uC"}
                        pars.update(shape_uniforms(spec, doc_h))
                        shape_full = _Node(src, "glslTOP", pars, (), pos=(bx - 350, y))
                        if opt:
                            sbox = shape_box(spec, doc_w, doc_h)
                            if sbox is None:
                                skip_why = skip_why or "empty"
                elif kind == "pixel":
                    slot = l.get("slot")
                    src = surface(int(slot), bx - 350, y, l.get("surfaceW"), l.get("surfaceH")) \
                        if slot is not None else "blank"
                    adjust = 0
                elif kind == "group":
                    kids2 = children.get(l["id"], [])
                    src = "blank"
                    adjust = 0
                    if kids2:
                        kids_items = walk(kids2, depth + 1)
                        if opt and not kids_items:
                            skip_why = skip_why or "empty"
                    else:
                        visible = False
                        if opt:
                            skip_why = skip_why or "empty"
                elif kind == "adjustment":
                    # v8: the stack runs on the accumulated image (``$acc``); without drawing effects the layer mixes the image with itself
                    # (it must show the image below, also without the skip rules)
                    adjust, src = ADJ_PREMULT, "$acc"
                else:
                    continue
                # sTD2DInputs[] is sized by the number of wired inputs: always wire all three
                has_mask = mask_name is not None
                if kind in ("group", "adjustment"):
                    fx = self._layer_effects(l, kind)
                    if kind == "adjustment" and opt and not fx:
                        skip_why = skip_why or "noop"
                else:
                    fx = self._layer_effects(l, kind) if src != "blank" and not no_fx else None
                need_doc = l["id"] in aux_targets and kind in ("pixel", "input", "base", "text", "shape") and src != "blank" and not no_fx
                docspace = bool(fx and kind not in ("group", "adjustment")) or need_doc
                if kind in ("pixel", "input", "base") and aff.dead:
                    src, mask_name, has_mask, xf, mip = "blank", None, False, IDENTITY_XF, False       # singular matrix: no area
                    fx = None
                if opt and src == "blank" and kind not in ("adjustment", "group"):
                    skip_why = skip_why or "empty"
                staged = False
                crop = None
                # v9: a masked input whose mask is not provably the input's size resamples (the pass samples the mask in normalised layer
                # UVs, so a mask of another size still covers the whole input); a mask of the input's size keeps the exact path
                mask_mismatch = False
                if has_mask and kind in ("input", "base") and src != "blank":
                    live = self._live_input_size(input_index(l))
                    msz = (l.get("surfaceW"), l.get("surfaceH"))
                    mask_mismatch = msz[0] is None or msz[1] is None or (live is not None and live != (int(msz[0]), int(msz[1])))
                # a layer that is skipped anyway (hidden / opacity 0) gets no resample node: nothing would read it (effects / aux users keep theirs)
                pre_skipped = bool(opt and SKIP_RULES and skip_why is not None and not docspace)
                if (kind in ("pixel", "input", "base") and src != "blank" and not pre_skipped
                        and (not aff.exact or docspace or mask_mismatch)):
                    # non-integer position / scale, rotation or skew (or effects, which need the masked content in
                    # document space): a resample pass renders the layer (and its mask) into document space; it is the
                    # only node that reads through a mipmap filter, the blend below only fetches
                    staged = True
                    xp = blend_pars(0, 0.0, has_mask, ADJ_RESAMPLE, aff.inv, mip, filt="mipmap" if mip else "linear")
                    xp.update({"vec2valuex": float(aff.xf[0]), "vec2valuey": float(aff.xf[1]),
                               "vec2valuez": 0.0, "vec2valuew": 0.0})
                    if opt and CROP_BOXES and kind == "pixel" and not docspace:
                        # v6 bounding box: the resample pass renders only the transformed surface rect (clipped to the
                        # canvas) into a custom-resolution texture; the blend places it at the box origin
                        sw, sh = self._surface_size(l, doc_w, doc_h)
                        crop = layer_box(aff, sw, sh, doc_w, doc_h, self._hints.get(l["id"]))
                        if crop is None:
                            skip_why = skip_why or "outside"
                elif kind == "pixel" and src != "blank" and opt:
                    sw, sh = self._surface_size(l, doc_w, doc_h)
                    if layer_box(aff, sw, sh, doc_w, doc_h, self._hints.get(l["id"])) is None:
                        skip_why = skip_why or "outside"
                elif kind in ("text", "shape") and docspace and has_mask:
                    # the mask must be applied before the effects: identity resample (exact path) = source x mask
                    staged = True
                    xp = blend_pars(0, 0.0, True, ADJ_RESAMPLE, (1.0, 0.0, 0.0, 1.0), False, filt="linear")
                    xp.update({"vec2valuex": 0.0, "vec2valuey": 0.0, "vec2valuez": 0.0, "vec2valuew": 0.0})
                if staged:
                    xname = "xf_L_" + sid
                    if crop is not None:
                        cx0, cy0, cx1, cy1 = crop
                        xp.update({"outputresolution": "custom", "resolutionw": cx1 - cx0, "resolutionh": cy1 - cy0,
                                   "vec2valuex": float(aff.xf[0]) - cx0, "vec2valuey": float(aff.xf[1]) - cy0})
                        xp["format"] = FMT8 if (mode == 0 and EIGHT_BIT) else FMT_BLEND
                        info["cropped"] += 1
                        self._boxes[l["id"]] = crop
                        bxf = (float(cx0), float(cy0), 1.0, 1.0)
                    else:
                        xp.update({"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h})
                        bxf = IDENTITY_XF
                    add(_Node(xname, "glslTOP", xp, [src, mask_name or src, src], pos=(bx - 175, y)))      # 3 inputs: sTD2DInputs[] is sized by the wired ones
                    src, mask_name, has_mask, xf, mip = xname, None, False, bxf, False
                if fx and kind not in ("group", "adjustment"):
                    src = self._plan_effects(add, l, sid, src, fx, doc_w, doc_h, (bx - 100, y))
                if need_doc:
                    self._content[l["id"]] = src
                if (opt and CROP_BOXES and kind == "shape" and sbox is not None and not docspace and not has_mask and skip_why is None
                        and src == "shape_" + sid):
                    cx0, cy0, cx1, cy1 = sbox
                    # hysteresis: a shape enters the cropped state at <= 50 % of the canvas and leaves it above 65 %
                    limit = 0.65 if l["id"] in self._shape_cropped else 0.5
                    if (cx1 - cx0) * (cy1 - cy0) <= limit * doc_w * doc_h:
                        # v6 bounding box: a second, cropped shape node renders only the box (the full-size ``shape_<id>`` stays
                        # never cooked by the blend); same shader, shifted uniforms
                        cp = {"outputresolution": "custom", "resolutionw": cx1 - cx0, "resolutionh": cy1 - cy0,
                              "pixeldat": "shape_glsl", "format": FMT_SHAPE,
                              "vec0name": "uParams", "vec1name": "uOffset", "vec2name": "uA", "vec3name": "uB", "vec4name": "uC"}
                        cp.update(shape_uniforms(shift_shape_spec(l.get("shape"), -cx0, -cy0), cy1 - cy0))
                        add(_Node("shapec_" + sid, "glslTOP", cp, (), pos=(bx - 350, y - 40)))
                        src, xf = "shapec_" + sid, (float(cx0), float(cy0), 1.0, 1.0)
                        info["cropped"] += 1
                        self._boxes[l["id"]] = sbox
                        cropped_shape.add(l["id"])
                if shape_full is not None:
                    # the full-size node is the input of effect chains; nothing else cooks it.  When the blend does not use it
                    # (cropped / skipped, no effects) it is not built at all (render requests plan their own nodes).
                    unused = opt and not docspace and (src != "shape_" + sid or skip_why is not None)
                    if not unused:
                        add(shape_full)
                if skip_why is not None and not SKIP_RULES:
                    skip_why = None
                    if not visible or kind == "group" and not kids_items:
                        opacity = 0.0           # (merged passes have no bypass: a hidden layer is an opacity-0 slot)
                if skip_why is not None:
                    skip(skip_why)
                    continue
                items.append({"id": l["id"], "sid": sid, "kind": kind, "name": bname, "src": src,
                              "mask": mask_name or "blank", "has_mask": has_mask, "mode": mode, "opacity": opacity,
                              "xf": xf, "mip": mip, "adjust": adjust, "extra": extra, "bypass": not visible,
                              "pos": (bx, y), "kids": kids_items, "xpos": bx - 350,
                              "layer_y": y, "layer": l if kind in ("group", "adjustment") else None,
                              "fx": fx if kind in ("group", "adjustment") else None})
            return items

        for n in sorted(aux_inputs):
            xp = blend_pars(0, 0.0, False, ADJ_RESAMPLE, (1.0, 0.0, 0.0, 1.0), False, filt="linear")
            xp.update({"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h,
                       "vec2valuex": 0.0, "vec2valuey": 0.0, "vec2valuez": 0.0, "vec2valuew": 0.0})
            src_n = input_source(n)
            add(_Node("auxin_%d" % n, "glslTOP", xp, [src_n, src_n, src_n], pos=(-450, -100 - 60 * n)))
        cropped_shape = set()
        items = walk(children.get(None, []), 0)
        self._shape_cropped = cropped_shape
        root = self._emit(add, items, "blank", True, doc_w, doc_h)
        add(_Node("out", "nullTOP", {}, [root], pos=(1000, 0)))
        for rq in self._reqs.values():           # v8: temporary render-request networks (flatten / merge), same planner, own node names
            rq.update(out=None, texts=set(), slots=set(), inputs=set(), ids=frozenset(), sig=None)
            before_nodes, before_fx, before_children = set(d), set(self._fx_todo), dict(children)
            try:
                self._plan_request(rq, layers, children, walk, add, doc_w, doc_h)
                rq["error"] = None
            except ValueError as e:
                rq["error"] = str(e)
            except Exception as e:      # noqa: BLE001 - a request that cannot be planned must never break the document's own apply
                rq["error"] = "cannot plan the render request: %s: %s" % (type(e).__name__, e)
                rq.update(out=None, texts=set(), slots=set(), inputs=set(), ids=frozenset(), sig=None)
                for name in [n for n in d if n not in before_nodes]:
                    del d[name]
                for alias in [a for a in self._fx_todo if a not in before_fx]:
                    del self._fx_todo[alias]
                children.clear()
                children.update(before_children)
        for gone in [n for n in self._text_retry if n not in self._text_nodes]:
            del self._text_retry[gone]
        return d

    def _plan_request(self, rq, layers, children, walk, add, doc_w, doc_h):
        """Plan one render request's temporary nodes (called by _plan); raises ValueError for a request that cannot be served."""
        syn = self._request_layers(layers, rq["spec"], rq["tag"])
        byid = {l.get("id"): l for l in layers if isinstance(l, dict)}
        kids = {}

        def note(layer):
            for sv in (layer.get("slot"), (layer.get("mask") or {}).get("slot") if isinstance(layer.get("mask"), dict) else None):
                if sv is not None:
                    rq["slots"].add(int(sv))
        for sl in syn:
            kids.setdefault(sl.get("parentId"), []).append(sl)
            note(sl)
            if sl.get("kind") in ("input", "base"):
                rq["inputs"].add(input_index(sl))
            ref = effect_aux_ref(self._effect_list(sl)) if self._fx is not None else None
            if ref is not None:        # the aux image of an effect: another layer's pixels (and mask) or a COMP input
                if ref[0] == "input":
                    rq["inputs"].add(ref[1])
                else:
                    src = byid.get(ref[1]) or byid.get(ref[1].partition(".")[2])
                    if src is not None:
                        note(src)
                        if src.get("kind") in ("input", "base"):
                            rq["inputs"].add(input_index(src))
        rq["ids"] = frozenset(sl["id"] for sl in syn)
        top = kids.pop(None, [])
        children.update(kids)
        texts0 = set(self._text_nodes)
        ritems = walk(top, 0)
        rroot = self._emit(add, ritems, "blank", True, doc_w, doc_h)
        rq["out"] = "rqout_" + rq["tag"]
        rq["texts"] = set(self._text_nodes) - texts0
        rq["sig"] = json.dumps(syn, sort_keys=True, separators=(",", ":"), default=str)
        add(_Node(rq["out"], "nullTOP", {}, [rroot], pos=(1000, -300)))

    def _live_input_size(self, n):
        """(w, h) of the COMP's In TOP ``n`` right now, None when unknown (not connected / not readable)."""
        try:
            op = self.comp.op("in%d" % int(n))
            w, h = int(op.width), int(op.height)
        except Exception:      # noqa: BLE001
            return None
        return (w, h) if w > 0 and h > 0 else None

    def _surface_size(self, layer, doc_w, doc_h):
        """(w, h) of a pixel layer's surface (document size when the spec has none)."""
        w, h = layer.get("surfaceW"), layer.get("surfaceH")
        return (int(w) if w else doc_w, int(h) if h else doc_h)

    def _emit(self, add, items, acc, tail_ok, doc_w, doc_h):
        """Phase 2: turn the blend items of one chain (bottom -> top) into nodes and return the name of the last one.

        * ``optimize`` off: one ``blend_L_<id>`` GLSL TOP per item, 16 bit fixed (v5 behaviour).
        * on: runs of consecutive plain layers (adjust == 0; any blend mode, masks allowed) of up to ``MERGE_MAX`` layers
          (and ``MERGE_MASKS_MAX`` masks) become ONE ``mrg_L_<first id>`` GLSL Multi TOP (blend.glsl uAdjust
          8); a run of one layer and every adjustment keep their own ``blend_L_<id>`` pass.
        * 8 bit rule: the output of a pass is ``rgba8fixed`` iff ``tail_ok`` (everything downstream of this chain is plain
          Normal) and every later item of this chain is a plain Normal blend (adjust 0, mode normal).  A Normal blend is
          source-over (``src + (1 - a_s) below``): it never amplifies an input error, so one 8 bit rounding (the browser
          canvas is 8 bit as well) is invisible.  Everything that divides by alpha / by a colour (non-Normal modes,
          adjustments' unpremultiply, blur, effects) keeps its input at 16 bit fixed (colour-burn amplifies 1.5e-5 steps
          already; an 8 bit step would be visible).  A group's inner chain is a source of the group's blend: it follows
          the same rule with the group's blend mode and everything above the group."""
        opt = self._opt
        info = self._plan_info
        n = len(items)
        plain = [it["adjust"] == 0 and it["mode"] == 0 for it in items]
        after = [True] * n          # after[i]: every item above i is a plain Normal blend
        ok = True
        for i in range(n - 1, -1, -1):
            after[i] = ok
            ok = ok and plain[i]

        def solo(it):
            """v9: a group with an enabled mask always composites isolated: its own blend pass, never a merged run."""
            return it["kind"] == "group" and it["has_mask"] and not it.get("fx")    # (with effects the mask is baked first: see resolve)

        def resolve(i):
            it = items[i]
            if it["kids"] is not None and not it.get("resolved"):
                fx = it.get("fx")
                # a group with effects: its isolated composite feeds the chain, so it keeps 16 bit like any effect input
                it["src"] = self._emit(add, it["kids"], "blank", tail_ok and after[i] and plain[i] and not fx, doc_w, doc_h) or "blank"
                it["resolved"] = True
                if fx:
                    src = it["src"]
                    if it["has_mask"]:
                        # like every layer kind: the mask is applied BEFORE the effects (identity resample = source x mask)
                        xp = self._blend_pars(0, 0.0, True, ADJ_RESAMPLE, (1.0, 0.0, 0.0, 1.0), False, filt="linear")
                        xp.update({"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h,
                                   "vec2valuex": 0.0, "vec2valuey": 0.0, "vec2valuez": 0.0, "vec2valuew": 0.0})
                        xname = "xf_L_" + it["sid"]
                        add(_Node(xname, "glslTOP", xp, [src, it["mask"], src], pos=(it["xpos"] - 175, it["layer_y"])))
                        src = xname
                        it["has_mask"], it["mask"] = False, "blank"
                    it["src"] = self._plan_effects(add, it["layer"], it["sid"], src, fx, doc_w, doc_h, (it["pos"][0] - 100, it["layer_y"]))

        i = 0
        while i < n:
            it = items[i]
            run = [it]
            if opt and MERGE_RUNS and it["adjust"] == 0 and not solo(it):
                resolve(i)
                masks_n = 1 if it["has_mask"] else 0
                j = i + 1
                while (j < n and items[j]["adjust"] == 0 and not solo(items[j]) and len(run) < MERGE_MAX and it["id"] != self._active
                       and items[j]["id"] != self._active):
                    resolve(j)
                    m = 1 if items[j]["has_mask"] else 0
                    if masks_n + m > MERGE_MASKS_MAX:
                        break
                    run.append(items[j])
                    masks_n += m
                    j += 1
            else:
                resolve(i)
            last = i + len(run) - 1
            fmt = FMT8 if (opt and EIGHT_BIT and tail_ok and after[last]) else FMT_BLEND
            info["passes"] += 1
            if fmt == FMT8:
                info["fmt8"] += 1
            if len(run) > 1:
                srcs = [r["src"] for r in run]
                masks, vals = [], []
                for k, r in enumerate(run):
                    mi = 0
                    if r["has_mask"]:
                        masks.append(r["mask"])
                        mi = 1 + MERGE_MAX + len(masks) - 1
                    vals.append((float(r["mode"] + 16 * mi), opacity_value(r["opacity"]),
                                 float(math.floor(r["xf"][0] + 0.5)), float(math.floor(r["xf"][1] + 0.5))))
                vals += [(0.0, 0.0, 0.0, 0.0)] * (MERGE_MAX - len(vals))
                pars = {"vec0name": "uParams", "vec0valuex": 0.0, "vec0valuey": 1.0, "vec0valuez": 0.0,
                        "vec0valuew": float(ADJ_MERGED_CODE),
                        "inputfiltertype": "nearest", "inputextenduv": "hold", "pixeldat": "blend_glsl", "format": fmt}
                for k, v in enumerate(vals):
                    pars["vec%dname" % (4 + k)] = "uL%d" % k
                    for c_, comp_ in zip(v, "xyzw"):
                        pars["vec%dvalue%s" % (4 + k, comp_)] = c_
                name = "mrg_L_" + run[0]["sid"]
                srcs += ["blank"] * (MERGE_MAX - len(srcs))
                masks += ["blank"] * (MERGE_MASKS_MAX - len(masks))
                add(_Node(name, "glslmultiTOP", pars, [acc] + srcs + masks, pos=run[0]["pos"]))
                info["merged"] += 1
                info["merged_layers"] += len(run)
                acc = name
            else:
                src = it["src"]
                adjust, extra = it["adjust"], it["extra"]
                if it["kind"] == "adjustment":
                    # the layer's effect stack runs on the accumulated image; chain(acc) is mixed with acc by opacity x mask (uAdjust 1)
                    src = acc if not it.get("fx") else self._plan_effects(
                        add, it["layer"], it["sid"], acc, it["fx"], doc_w, doc_h, (it["xpos"] + 60, it["layer_y"]))
                bp = self._blend_pars(it["mode"], it["opacity"], it["has_mask"], adjust, it["xf"], it["mip"], fmt=fmt)
                bp.update(extra)
                add(_Node(it["name"], "glslTOP", bp, [acc, src, it["mask"]], bypass=it["bypass"], pos=it["pos"]))
                acc = it["name"]
            i += len(run)
        return acc

    # ------------------------------------------------------------------ layer effects (hook, see effects.py)

    def _init_effects(self, effects, shaders):
        """Locate effects.py (the module is injected by the ext; tests / dev scripts find the sibling file) and its shader
        sources.  Failure disables layer effects (``fx_error`` says why); the rest of the network is unaffected."""
        try:
            if effects is None:
                try:
                    dat = self.comp.op("effects")
                    effects = dat.module if dat is not None else None
                except Exception:
                    effects = None
            if effects is None:
                import importlib.util
                path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "effects.py")
                spec = importlib.util.spec_from_file_location("raster_effects", path)
                effects = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(effects)
            self._fx = effects
            self._fx_shaders = shaders if shaders is not None else effects.load_shader_texts()
        except Exception as e:      # noqa: BLE001 - effects are optional
            self._fx = self._fx_shaders = None
            self.fx_error = "%s: %s" % (type(e).__name__, e)

    def _effect_list(self, layer):
        """Every effect dict that is applied to the layer's content (an adjustment layer: the stack applied to everything below;
        the ext's ``parse_doc`` has already migrated legacy ``adjustment`` specs into it)."""
        return [e for e in (layer.get("effects") or ()) if isinstance(e, dict)] if isinstance(layer.get("effects"), (list, tuple)) else []

    def _layer_effects(self, layer, kind):
        """The layer's effect list when at least one effect draws something, else None.  All layer kinds (v7: groups and
        adjustments too; a filter adjustment's own filter leads the list)."""
        if self._fx is None or kind not in ("pixel", "input", "base", "text", "shape", "group", "adjustment"):
            return None
        fx = self._effect_list(layer)
        if not fx:
            return None
        try:
            return fx if self._fx.plan_chain(fx) else None
        except Exception as e:      # noqa: BLE001 - a malformed effect must not break the document
            self.fx_error = "plan: %s: %s" % (type(e).__name__, e)
            return None

    def _plan_effects(self, add, layer, sid, src, fx, doc_w, doc_h, pos):
        """Register the layer's effect chain: its input is the node ``src``; the returned alias name stands for the chain's
        output in the blend node's wiring (the chain nodes are built by :meth:`_apply_effects`).  Also records the chain's
        aux image reference and whether the layer is a tdPreview layer (:meth:`preview_layers`)."""
        alias = "fx_L_" + sid
        self._fx_todo[alias] = (layer["id"], src, fx, pos)
        ref = effect_aux_ref(fx)
        if ref is not None:
            self._fx_aux[alias] = ref
        try:
            if any(self._fx.effect_td_preview(e) for e in fx):
                self._preview[layer["id"]] = alias
        except Exception:      # noqa: BLE001 - an older effects module without the planner flag: no preview layers
            pass
        return alias

    def _aux_node(self, alias):
        """Name of the node holding the aux image of the chain ``alias`` (None = no aux: the filter renders unshifted)."""
        ref = self._fx_aux.get(alias)
        if ref is None:
            return None
        if ref[0] == "input":
            return "auxin_%d" % ref[1]
        name = self._content.get(ref[1])
        return name if name in self._ops or name in self._fx_todo else None

    def _fx_acquire(self, optype):
        if self._pool:
            op, _cache = self._pool.pop()
            self._counters["recycled"] += 1
        else:
            op, _cache = self._make_pool_node()
        return op

    def _fx_release(self, op):
        """Back to the spare pool in the state _make_pool_node leaves it (the chain renamed vectors / the shader DAT)."""
        cache = {"type": "glslTOP", "pars": {}, "inputs": [], "bypass": False, "pos": None}
        self._set_pars_raw(op, cache, {
            "pixeldat": "blend_glsl", "format": FMT_BLEND, "vec0name": "uParams", "vec1name": "uXform",
            "vec2name": "uA", "vec3name": "uB", "inputfiltertype": "nearest", "outputresolution": "useinput",
            "vec4name": ""})
        if op.valid and len(self._pool) < POOL_MAX:
            self._pool.append((op, cache))
        else:
            self._garbage.append((op, cache))

    def _apply_effects(self):
        """Build / update / remove the effect chains planned by the last _plan (after the nodes exist, before wiring).  A
        chain whose aux image is another layer's (chained) content is built after that chain (cycles: no aux)."""
        todo = self._fx_todo
        keep = {v[0] for v in todo.values()}
        for lid in [k for k in self._chains if k not in keep]:
            self._chains.pop(lid).destroy()
        for alias in [a for a in self._fx_out if a not in todo]:
            del self._fx_out[alias]
            self._gen.pop(alias, None)
        for lid in [k for k in self._fx_fail if k not in keep]:
            del self._fx_fail[lid]
        self._fx_keys = {}
        done, busy = set(), set()

        def build(alias):
            if alias in done:
                return
            done.add(alias)
            busy.add(alias)
            aux_name = self._aux_node(alias)
            aux = None
            if aux_name is not None and self._aux_cycle(alias):
                aux_name = None                            # cycle (A displaces by B, B by A): neither side gets an aux
            if aux_name is not None:
                if aux_name in todo:
                    build(aux_name)
                aux = self._fx_out.get(aux_name) if aux_name in todo else self._ops.get(aux_name)
            self._apply_chain(alias, aux)
            busy.discard(alias)

        for alias in list(todo):
            build(alias)

    def _aux_cycle(self, alias):
        """True when following the aux references from ``alias`` leads back to it."""
        seen, cur = set(), alias
        while True:
            nxt = self._aux_node(cur)
            if nxt is None or nxt not in self._fx_todo:
                return False
            if nxt == alias:
                return True
            if nxt in seen:
                return False
            seen.add(nxt)
            cur = nxt

    def _apply_chain(self, alias, aux):
        lid, src, fx, pos = self._fx_todo[alias]
        now = self._clock()
        src_op = self._ops[src]
        if src in self._fx_todo:                       # (a chain fed by another chain: not produced by the planner today)
            src_op = self._fx_out.get(src, src_op)
        fkey = json.dumps(fx, sort_keys=True, separators=(",", ":"), default=str) + "|" + str(self._fx_aux.get(alias))
        self._fx_keys[alias] = fkey
        fail = self._fx_fail.get(lid)
        if fail is not None and fail[2] == fkey and now < fail[1]:
            # this exact effect list failed recently: no retry on every apply(), the layer shows without effects
            if self._fx_out.get(alias) is not src_op:
                self._fx_out[alias] = src_op
                self._gen_counter += 1
                self._gen[alias] = self._gen_counter
            return
        chain = None
        try:
            chain = self._chains.get(lid)
            if chain is None:
                chain = self._chains[lid] = self._fx.EffectChain(
                    self.doc, "fx_" + sanitize(lid), self._fx_shaders, acquire=self._fx_acquire,
                    release=self._fx_release, pos=pos, adopt=False)
            c0 = dict(chain.counters)
            cur = self._cur
            dw, dh = (cur[1], cur[2]) if cur else (None, None)      # chain inputs are document sized (docspace): do not trust a fresh node's .width
            out = chain.apply(fx, src_op, dw, dh, aux=aux) if aux is not None else chain.apply(fx, src_op, dw, dh)
            for k in ("par_sets", "connects"):
                self._counters[k] += chain.counters[k] - c0[k]
            self._fx_fail.pop(lid, None)
        except Exception as e:      # noqa: BLE001 - never break the document: show the layer without its effects
            self.fx_error = "chain %s: %s: %s" % (lid, type(e).__name__, e)
            n = (fail[0] if fail is not None else 0) + 1
            self._fx_fail[lid] = (n, now + min(30.0, 0.5 * 2 ** n), fkey)
            try:                                       # clean up the partially built chain (nodes back to the pool)
                self._chains.pop(lid, None)
                if chain is not None:
                    chain.destroy()
            except Exception:      # noqa: BLE001
                pass
            out = src_op
        if self._fx_out.get(alias) is not out:
            self._fx_out[alias] = out
            self._gen_counter += 1
            self._gen[alias] = self._gen_counter

    # ------------------------------------------------------------------ reconcile

    def _reconcile(self, desired):
        old_names = set(self._desired)
        self._desired = desired
        slots_new = dict(self._slot_nodes)
        # slots leaving the stack keep their size while their Script TOP is in the grace period (dropped in _drop)
        self._slot_sizes = {sl: v for sl, v in self._slot_sizes.items() if sl not in slots_new}
        self._slot_sizes.update(self._new_sizes)
        first = not self._scanned
        if first:
            self._build_adopt_map()
        # surfaces re-appearing within the grace period keep their node
        for name in slots_new.values():
            self._pending.pop(name, None)
        # 1. create / adopt, set parameters
        for name, spec in desired.items():
            op = self._ops.get(name)
            if op is not None and self._cache[name]["type"] != spec.optype:
                self._drop(name, force_destroy=True)
                op = None
            if op is None:
                op = self._acquire(name, spec)
            self._set_pars(name, op, spec.pars)
            cache = self._cache[name]
            if cache["bypass"] != spec.bypass:
                op.bypass = spec.bypass
                cache["bypass"] = spec.bypass
            if cache["pos"] != spec.pos:
                op.nodeX, op.nodeY = spec.pos
                cache["pos"] = spec.pos
        # 1b. layer effect chains (their input nodes exist now; the blend nodes are wired to their outputs below)
        self._apply_effects()
        # 2. wiring
        for name, spec in desired.items():
            self._wire(name, spec.inputs)
        # 3. nodes that are no longer part of the network
        now = self._clock()
        for name in list(self._ops):
            if name in desired or name in RESERVED or name in self._pending:
                continue
            if self._cache[name]["type"] == "scriptTOP":
                self._pending[name] = now + GRACE_S    # stays (unwired) for the 2 s grace period
            else:
                self._drop(name)
        self._slots = slots_new
        # 4. leftovers of a previous session / manual edits: not generated by us -> removed
        if first or set(desired) != old_names:
            self._scanned = True
            self._remove_unknown()
        # destroys are deferred to tick(); if the ext never ticks, bound the backlog here
        if len(self._garbage) > GARBAGE_MAX or len(self._pending) > PENDING_MAX or len(self._junk) > JUNK_MAX:
            while self._junk:
                self._destroy_op(self._junk.pop())
            self._counters["forced"] += 1
            self._tick_pending(force=True)
            self._collect_garbage(len(self._garbage))

    def _build_adopt_map(self):
        """Operators of a loaded file: glsl nodes carry their role in ``tags`` (they cannot be renamed
        cheaply, see _make_pool_node); everything else is found by name."""
        self._adopt = {}
        for ch in self.doc.children:
            for t in (ch.tags or ()):
                if t.startswith(ROLE_PREFIX):
                    self._adopt[t[len(ROLE_PREFIX):]] = ch

    def _prune(self):
        """Destroying a node can take its companion DATs with it: forget operators that are gone."""
        self._junk = [j for j in self._junk if j.valid]
        self._garbage = [(g, c) for g, c in self._garbage if g.valid]
        self._pool = [(g, c) for g, c in self._pool if g.valid]
        self._mpool = [(g, c) for g, c in self._mpool if g.valid]

    def _remove_unknown(self):
        self._prune()
        known = {op.name for op in self._ops.values()} | set(RESERVED) | {n.name for c in self._chains.values() for n in c.nodes} \
            | {p[0].name for p in self._pool} | {p[0].name for p in self._mpool} | {g.name for g, _ in self._garbage} | {j.name for j in self._junk}
        leftovers = {o.path for o in self._adopt.values()}      # tagged glsl nodes whose role is gone
        for child in list(self.doc.children):
            if not child.valid or child.name in known or child.name.startswith("fxsrc_"):      # (fxsrc_*: effect shader DATs)
                continue
            spare = child.OPType == "glslTOP" and not child.tags and _SPARE_NAME.match(child.name)
            mspare = child.OPType == "glslmultiTOP" and not child.tags and _SPARE_MULTI.match(child.name)
            if (child.path in leftovers or spare or mspare) and child.OPType in ("glslTOP", "glslmultiTOP") \
                    and len(self._mpool if child.OPType == "glslmultiTOP" else self._pool) < \
                    (MPOOL_MAX if child.OPType == "glslmultiTOP" else POOL_MAX):
                for i in range(len(child.inputConnectors) - 1, -1, -1):
                    if i < len(child.inputConnectors):
                        child.inputConnectors[i].disconnect()
                cache = {"type": child.OPType, "pars": {}, "inputs": [], "bypass": False, "pos": None}
                self._reset_for_pool(child, cache, force=True)       # a stale xf_L / effect node keeps no custom size / mipmap
                (self._mpool if child.OPType == "glslmultiTOP" else self._pool).append((child, cache))
                continue
            self._unknown_names.append(child.name)
            self._destroy_op(child)
            self._counters["unknown"] += 1
        self._adopt = {}

    def _tick_pending(self, force=False):
        if not self._pending:
            return 0
        now = self._clock()
        n = 0
        for name, deadline in list(self._pending.items()):
            if now >= deadline or force:
                del self._pending[name]
                self._drop(name, force_destroy=True)
                n += 1
                if not force:
                    break           # one at a time (a destroy costs ~1 ms)
        return n

    def _collect_garbage(self, n=1):
        for _ in range(min(n, len(self._garbage))):
            op, _cache = self._garbage.pop()
            self._destroy_op(op)

    def _destroy_op(self, op):
        if getattr(op, "valid", True):
            op.destroy()
            self._counters["destroyed"] += 1

    # -- node creation / reuse

    def _make_pool_node(self):
        """A spare GLSL TOP (creating one costs ~4.5 ms and renaming ~4.8 ms, so these are made ahead in
        tick() and never renamed: they have generic names ``g<N>``; their role is the tag ``role:<name>``)."""
        self._pool_serial += 1
        while self.doc.op("g%d" % self._pool_serial) is not None:      # e.g. spares loaded from a file
            self._pool_serial += 1
        op = self.doc.create("glslTOP", "g%d" % self._pool_serial)
        self._counters["created"] += 1
        self._note_companions(op)
        cache = {"type": "glslTOP", "pars": {}, "inputs": [], "bypass": False, "pos": None}
        self._set_pars_raw(op, cache, {
            "pixeldat": "blend_glsl", "format": FMT_BLEND, "vec0name": "uParams", "vec1name": "uXform",
            "vec2name": "uA", "vec3name": "uB"})
        return (op, cache)

    def _warm_one(self):
        """Pre-warm ONE spare (v6): TD compiles blend.glsl the first time a GLSL node cooks (~15 ms, and again whenever its
        number of wired inputs changes), which used to hit the frame of the first apply() that used the node (the 20 ms
        'first resample' spike).  A spare is cooked once against a 16x16 constant on 3 inputs (plain GLSL TOP: the count
        every blend / resample node has) or 16 (merged pass) so the program is compiled and ready; the connections stay
        (``cache["inputs"]`` records them) and are replaced by the first real wiring without a recompile."""
        for pool, n_in in ((self._pool, 3), (self._mpool, 16)):
            for op, cache in pool:
                if cache.get("warm") or not op.valid:
                    continue
                cache["warm"] = True
                try:
                    if self._warm_src is None or not self._warm_src.valid:
                        w = self.doc.op("warm_in") or self.doc.create("constantTOP", "warm_in")
                        for k, v in (("outputresolution", "custom"), ("resolutionw", 16), ("resolutionh", 16),
                                     ("format", "rgba8fixed")):
                            setattr(w.par, k, v)
                        w.nodeX, w.nodeY = -900, 500
                        self._warm_src = w
                    for i in range(n_in):
                        op.inputConnectors[i].connect(self._warm_src)
                    cache["inputs"] = [("warm_in", -1)] * n_in
                    op.cook(force=True)
                except Exception:      # noqa: BLE001 - a failed warm-up only costs the first-use compile later
                    pass
                return True
        return False

    def _make_multi_node(self):
        """A spare GLSL Multi TOP for merged passes (any number of inputs; the plain GLSL TOP has three), generic name
        ``m<N>``, role in the tag like :meth:`_make_pool_node`.  Its vectors are fixed: uParams, uXform, uA, uB, uL0..uL7."""
        self._mpool_serial += 1
        while self.doc.op("m%d" % self._mpool_serial) is not None:
            self._mpool_serial += 1
        op = self.doc.create("glslmultiTOP", "m%d" % self._mpool_serial)
        self._counters["created"] += 1
        self._note_companions(op)
        cache = {"type": "glslmultiTOP", "pars": {}, "inputs": [], "bypass": False, "pos": None}
        pars = {"pixeldat": "blend_glsl", "format": FMT_BLEND, "vec0name": "uParams", "vec1name": "uXform",
                "vec2name": "uA", "vec3name": "uB"}
        for k in range(MERGE_MAX):
            pars["vec%dname" % (4 + k)] = "uL%d" % k
        self._set_pars_raw(op, cache, pars)
        return (op, cache)

    def _note_companions(self, op):
        """TD creates helper DATs next to some operators (unused here since the shader / callbacks DATs are
        shared): queue them for destruction in tick() instead of paying ~1 ms each inside apply()."""
        if op.OPType not in ("glslTOP", "glslmultiTOP", "scriptTOP"):
            return
        for suf in ("_callbacks", "_info", "_pixel", "_compute", "_vertex"):
            c = self.doc.op(op.name + suf)
            if c is not None:
                self._junk.append(c)

    def _acquire(self, name, spec):
        """Adopt the existing operator (file reload) -> spare pool (glsl) -> create."""
        existing = self._adopt.pop(name, None) if spec.glsl else self.doc.op(name)
        if existing is not None and existing.OPType == spec.optype:
            op = existing
            # resurrection: the node may be waiting in the garbage / junk lists (dropped, then re-added
            # before tick() collected it); it must not be destroyed while live
            self._prune()
            self._garbage = [(g, c) for g, c in self._garbage if g.path != existing.path]
            self._junk = [j for j in self._junk if j.path != existing.path]
            self._cache[name] = {"type": spec.optype, "pars": {}, "inputs": None, "bypass": None, "pos": None}
        else:
            if existing is not None:
                existing.destroy()
                self._counters["destroyed"] += 1
            if spec.glsl:
                pool = self._mpool if spec.multi else self._pool
                if pool:
                    op, cache = pool.pop()
                    self._counters["recycled"] += 1
                    if spec.multi:
                        cache["verify"] = True      # a pooled Multi TOP keeps its connections; TD may have cut / compacted some meanwhile
                else:
                    op, cache = self._make_multi_node() if spec.multi else self._make_pool_node()
                self._cache[name] = cache
            else:
                op = self.doc.create(spec.optype, name)
                self._counters["created"] += 1
                self._note_companions(op)
                self._cache[name] = {"type": spec.optype, "pars": {}, "inputs": [], "bypass": False, "pos": None}
        if spec.glsl:
            if existing is not None and op is existing:
                # an adopted node (loaded file / rebuilt component) carries whatever its previous role left: custom resolution,
                # mipmap filter, bypass, extra vectors.  Start it from the same neutral state as a pooled spare.
                self._reset_for_pool(op, self._cache[name], force=True)
            op.tags = [ROLE_PREFIX + name]
            op.comment = name
        self._ops[name] = op
        self._gen_counter += 1
        self._gen[name] = self._gen_counter
        return op

    def _set_pars(self, name, op, pars):
        cache = self._cache[name]
        if cache.get("want") == pars:       # the exact dict applied last time (a repeat apply): one C-level comparison
            return
        self._set_pars_raw(op, cache, pars)
        cache["want"] = pars

    def _set_pars_raw(self, op, cache, pars):
        cache.pop("want", None)          # (any direct write invalidates the "same dict as last time" shortcut of _set_pars)
        cp = cache["pars"]
        for k, v in pars.items():
            if cp.get(k, _MISSING) != v:
                try:
                    setattr(op.par, k, v)
                except Exception:
                    if k not in ("font", "typeface"):
                        raise
                    # family not in the Text TOP's font menu / face missing: stay usable
                    setattr(op.par, k, "Helvetica" if k == "font" else "Regular")
                cp[k] = v
                if k == "font":
                    cp.pop("typeface", None)       # the face must be (re)applied for the new family
                self._counters["par_sets"] += 1

    def _wire(self, name, inputs):
        """Connect ``inputs`` (node names).  The cache stores (name, generation) so a consumer is
        rewired when its source node was destroyed and recreated under the same name."""
        op = self._ops[name]
        cache = self._cache[name]
        want_all = [(n, self._gen[n]) for n in inputs]
        outs = self._fx_out
        cur = cache["inputs"]
        if cache.pop("verify", False) and cur and op.OPType == "glslmultiTOP":
            # recycled Multi TOP: the cache says "wired like in the previous role", but destroying a source op (a render request's text /
            # shape node, a recycled surface...) makes TD cut that connector (and shrink / shift the list): trust the real wiring
            cur = list(cur)
            for i, w in enumerate(want_all):
                if i < len(cur) and cur[i] == w:
                    tgt = outs[w[0]] if w[0] in outs else self._ops[w[0]]
                    got = op.inputConnectors[i].connections if i < len(op.inputConnectors) else []
                    owner = (getattr(got[0], "owner", got[0]) if got else None)
                    if owner is not tgt:
                        cur[i] = None
        if cur is not None and cur == want_all and (op.OPType != "glslmultiTOP" or len(op.inputConnectors) > len(cur)):
            return
        if cur is None:     # adopted: unknown state, rewire everything
            cur = [object()] * len(op.inputConnectors)
        elif op.OPType == "glslmultiTOP":
            # a Multi TOP's connector list is "connected + 1 free" and TD shrinks it when trailing sources are cut (destroyed):
            # inputs the cache believes connected but that no longer have a connector must be connected again
            have_n = len(op.inputConnectors) - 1
            if len(cur) > have_n:
                cur = list(cur[:max(0, have_n)]) + [None] * (len(cur) - max(0, have_n))
        n = max(len(cur), len(want_all))
        for i in range(n):
            want = want_all[i] if i < len(want_all) else None
            have = cur[i] if i < len(cur) else None
            if want == have:
                continue
            if want is None:
                if i < len(op.inputConnectors):
                    op.inputConnectors[i].disconnect()
                    self._counters["disconnects"] += 1
            else:
                while i >= len(op.inputConnectors):          # (defensive) grow the list: connecting the free last one adds one
                    j = len(op.inputConnectors) - 1
                    fill = want_all[j][0] if j < len(want_all) else "blank"
                    op.inputConnectors[j].connect(outs[fill] if fill in outs else self._ops[fill])
                    self._counters["connects"] += 1
                op.inputConnectors[i].connect(outs[want[0]] if want[0] in outs else self._ops[want[0]])
                self._counters["connects"] += 1
        cache["inputs"] = want_all

    def _reset_for_pool(self, op, cache, force=False):
        """Make a GLSL TOP a neutral spare: inherit input 0's resolution (shape / resample nodes have a custom one),
        ``nearest`` filter (never recycle a mipmap flag), not bypassed, untagged.  ``force`` = the cache knows nothing
        about the node's real parameter values (an adopted node of a loaded file): set them unconditionally."""
        pars = cache["pars"]
        if force or pars.get("outputresolution", "useinput") != "useinput":
            pars.pop("outputresolution", None)
            self._set_pars_raw(op, cache, {"outputresolution": "useinput"})
        if force or pars.get("inputfiltertype", "nearest") != "nearest":
            pars.pop("inputfiltertype", None)
            self._set_pars_raw(op, cache, {"inputfiltertype": "nearest"})
        if force:
            # an adopted / loaded node may have served ANY role (effect chain slot: vec names uP0.., shape: uOffset/uC, another
            # shader DAT): restore exactly what _make_pool_node / _make_multi_node leave.  The blend, resample and adjustment
            # nodes only write vec0 / vec1 (uParams, uXform) themselves; a stale uA / uB name leaves the translation of a
            # resample pass and every adjustment parameter unassigned (layers stacked at the origin, wrong adjustments).
            multi = cache.get("type") == "glslmultiTOP" or op.OPType == "glslmultiTOP"
            canon = {"pixeldat": "blend_glsl", "format": FMT_BLEND, "vec0name": "uParams", "vec1name": "uXform"}
            if multi:
                for k in range(MERGE_MAX):
                    canon["vec%dname" % (4 + k)] = "uL%d" % k
                canon.update({"vec2name": "uA", "vec3name": "uB"})
            else:
                canon.update({"vec2name": "uA", "vec3name": "uB", "vec4name": ""})
            for k in canon:
                pars.pop(k, None)
            self._set_pars_raw(op, cache, canon)
        if force or cache["bypass"]:
            op.bypass = False
            cache["bypass"] = False
        op.tags = []
        op.comment = ""

    def _drop(self, name, force_destroy=False):
        """The operator behind ``name`` is not needed any more.  GLSL TOPs go back to the spare pool,
        everything else is disconnected and destroyed later by tick() (destroying costs ~1 ms each)."""
        op = self._ops.pop(name)
        cache = self._cache.pop(name)
        self._pending.pop(name, None)
        if _SURFACE_NAME.match(name):
            self._slot_sizes.pop(int(name[1:]), None)
        # disconnect so nothing downstream keeps a reference
        if cache["type"] != "glslmultiTOP":
            for i in range(len(cache["inputs"] or []) - 1, -1, -1):
                if i < len(op.inputConnectors):
                    op.inputConnectors[i].disconnect()
                    self._counters["disconnects"] += 1
            cache["inputs"] = []
        # (a dropped Multi TOP keeps its 16 connections and its cache["inputs"]: the next role rewires only the inputs that
        # differ -- (name, generation) compares -- and TD never sees a changed input count, i.e. no shader recompile)
        if cache["type"] == "glslTOP" and len(self._pool) < POOL_MAX:
            self._reset_for_pool(op, cache)
            self._pool.append((op, cache))
        elif cache["type"] == "glslmultiTOP" and len(self._mpool) < MPOOL_MAX:
            self._reset_for_pool(op, cache)
            self._mpool.append((op, cache))
        elif force_destroy:
            self._destroy_op(op)
        else:
            self._garbage.append((op, cache))

    # ------------------------------------------------------------------ view nodes

    def _ensure_view_nodes(self):
        comp = self.comp
        if comp.op("view_doc") is None:
            sel = comp.create("selectTOP", "view_doc")
            sel.par.top = "doc/out"
            sel.nodeX, sel.nodeY = -300, -500
        if comp.op("view_glsl") is None:
            dat = comp.create("textDAT", "view_glsl")
            dat.text = VIEW_GLSL
            dat.nodeX, dat.nodeY = -300, -600
        if comp.op("doc_view") is None:
            g = comp.create("glslTOP", "doc_view")
            g.par.pixeldat = "view_glsl"
            g.par.vec0name = "uView"
            g.par.vec1name = "uClip"
            g.par.format = "rgba8fixed"
            g.inputConnectors[0].connect(comp.op("view_doc"))
            g.nodeX, g.nodeY = -100, -500
            self._view_state = {}
        if comp.op("panel_view") is None:
            ov = comp.create("overTOP", "panel_view")
            web = comp.op("webrender")
            if web is not None:
                ov.inputConnectors[0].connect(web)
            ov.inputConnectors[1].connect(comp.op("doc_view"))
            ov.nodeX, ov.nodeY = 100, -500
        ov = comp.op("panel_view")
        web = comp.op("webrender")
        if web is not None and not ov.inputConnectors[0].connections:
            ov.inputConnectors[0].connect(web)


_MISSING = object()
_SPARE_NAME = re.compile(r"^g\d+$")
_SPARE_MULTI = re.compile(r"^m\d+$")
_SURFACE_NAME = re.compile(r"^s\d+$")


def _read_sibling(name):
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""
