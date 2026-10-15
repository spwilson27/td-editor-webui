"""DocNetwork: the generated compositing network of the raster editor COMP (docs/DESIGN_V2.md 4).

Everything inside ``<comp>/doc`` is owned and generated here; ``apply()`` diff-applies the layer
stack of the web client (PROTOCOL.md 3).  The TD-view overlay (``view_*``, ``doc_view``,
``panel_view`` next to ``doc``) is owned here too.  The module is pure python: TD objects are only
reached through ``comp.op / doc.create / node.par / node.inputConnectors / ...`` so the diff logic is
unit-tested against fake TD objects (``td/tests/test_network*.py``).

Network shape (all names inside ``doc``)::

    blank (constantTOP, transparent, doc size)      base_src (selectTOP: ../in1 or blank)
    s<slot>        scriptTOP  surface pixels (callbacks DAT surface_callbacks -> OnSurfaceCook)
    g<N>           glslTOP    blend.glsl nodes: role in tag/comment ``blend_<id>`` (inputs 0 below, 1 source,
                              2 mask; always 3 wired).  They are
                              NOT named after the layer: creating or renaming a GLSL TOP costs ~4.5 ms, so a
                              pool of spare nodes is made in tick() and handed out / taken back by apply().
    adj_L_<id>     Blur TOP of a blur adjustment (the only native adjustment node)
    out            nullTOP    result (input = last root blend)
    blend_glsl, surface_callbacks   text DATs (shader, Script TOP callbacks)

Chain order is bottom -> top inside each parent; a group is an isolated chain that starts at ``blank``
and whose result is the *source* of ``blend_<groupId>``.

Adjustment mapping (AdjustmentSpec -> blend.glsl / TOPs)  --  KEEP IN SYNC WITH THE WEB PREVIEW
=========================================================================================
All formulas are on STRAIGHT (unpremultiplied) sRGB values c in [0,1].  Levels, brightness/contrast,
invert, threshold and hue/saturation are computed INSIDE the ``blend_<id>`` pass (blend.glsl uAdjust 2..6,
parameters in uniforms uA / uB): one full-screen pass per adjustment, no helper nodes.  The shader
unpremultiplies the image below, applies f, clamps to [0,1], premultiplies with the alpha of the image below.
Final result of every adjustment layer:

    out = mix(below, adjusted, opacity * mask)            (premultiplied RGBA, per channel)

levels            uAdjust 2   uA = (inLow, inHigh, gamma, outLow), uB.x = outHigh
                    t   = clamp((c - inLow) / (inHigh - inLow), 0, 1)
                    out = outLow + (outHigh - outLow) * t ** (1 / gamma)       (gamma > 1 brightens mid-tones)
                    inHigh is kept >= inLow + 1e-4, gamma in 0.1..10
brightnessContrast uAdjust 3  uA = (brightness, contrast)
                    c1  = clamp(c * (1 + brightness), 0, 1)
                    out = clamp((c1 - 0.5) * (1 + contrast) + 0.5, 0, 1)
hueSaturation     uAdjust 6   uA = (hue, saturation, value)
                    true HSV edit: V = max(R,G,B), S = (V - min) / V, H in degrees;
                    H' = H + hue (+ = CSS hue-rotate direction: red -> green -> blue), S' = min(1, S * saturation),
                    V' = V * value, back to RGB, each channel clamped (value > 1 saturates channels).
invert            uAdjust 4   out = 1 - c
threshold         uAdjust 5   uA.x = level;  out = white if lum(c) >= level else black, alpha preserved,
                    lum = Rec.709 0.2126 R + 0.7152 G + 0.0722 B
blur              uAdjust 1   one extra node ``adj_L_<id>`` = Blur TOP (gaussian) on the premultiplied image
                    size = round(radius * 4.698 / preshrink), preshrink = 1 (r<6), 2 (<14), 4 (<32), 8
                    -> gaussian with standard deviation sigma = radius px (measured 100.06 for size 470 and
                    200.4 for 940 at preshrink 1), premultiplied RGBA, pixels outside the document repeat the
                    edge pixels (extend 'hold').  radius < 0.1 -> node bypassed.
(Version 1 used native Level / HSV Adjust / Threshold TOPs behind an unpremultiply helper pass: 3-4 passes per
adjustment.  Same maths, folded into the shader to cut GPU passes and cooks.)

Blend uniforms (GLSL TOP Vectors page): ``uParams`` vec4 = (BlendMode index, opacity, hasMask,
uAdjust 0..7) and ``uXform`` vec4 = (x, y, sx, sy), the layer -> document mapping ``doc = (x, y) + (sx, sy) * layer``
(v4 transforms; x/y fractional, identity for every layer that is not a pixel / base layer).  The layer's own surface
is the Script TOP ``s<slot>`` at ``surfaceW x surfaceH`` (the base layer's is ``in1`` at its own resolution).

Resampling is a separate pass: a pixel / base layer whose transform is NOT an integer offset at scale 1 gets a node
``xf_L_<id>`` (uAdjust 7, custom resolution = document size; inputs: surface, mask or the surface again) that renders
surface x coverage x mask into document space; the blend node then reads that through ``texelFetch`` with an identity
mapping and no mask.  Only the ``xf_L`` node has ``inputfiltertype`` = ``mipmap`` (while lod =
``max(0, -log2(sqrt(sx*sy)) - 0.5)`` > 0, i.e. sx*sy < 0.5; trilinear, which is what Canvas 2D drawImage 'medium'
does) or ``linear``; its inputs are surfaces (or ``base_src``), never an accumulator.  Every other glsl node is
``nearest`` / texelFetch only (TD builds mip chains for ALL inputs of a mipmap-filtered node, and keeps them).
Integer offsets at scale 1 have no resample node: the blend pass places the surface itself (exact).  Text / shape
layers are always TD rendered at document size (they never have a surface slot); see ``render_layer_source``.

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
FLATTEN_BUDGET = 200     # Text TOP measurement cooks per render_layer_status() call
POOL_TARGET = 6          # spare glsl TOPs kept ready (creating a GLSL TOP costs ~4.7 ms)
POOL_MAX = 10
GARBAGE_MAX = 12
JUNK_MAX = 80
PENDING_MAX = 24
ROLE_PREFIX = "role:"
BLUR_SIZE_PER_RADIUS = 4.698   # Blur TOP gaussian: sigma = size / 4.698 (measured)
FMT = "rgba16float"          # adjustment internals (values may leave 0..1)
FMT_SHAPE = "rgba8fixed"       # shape / text layer outputs (the browser surfaces are 8 bit too)
FMT_BLEND = "rgba16fixed"     # blend outputs: 1.5e-5 steps (float16 is 2.4e-4 near 1.0 and colour-burn amplifies it)

# reserved (non layer) node names inside doc
RESERVED = ("blend_glsl", "shape_glsl", "text_measure", "surface_callbacks", "blank", "base_src", "out")
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


def blur_preshrink(radius):
    """Blur TOP pre-shrink (box downsample before the 1-D passes); the cost is linear in the filter size, so
    large radii run on a 2x/4x/8x smaller image (sigma >= ~3.5 shrunk px; measured error vs a true gaussian
    stays ~4/255 incl. 1 px lines)."""
    return 1 if radius < 6 else 2 if radius < 14 else 4 if radius < 32 else 8


def xform_uniforms(layer):
    """LayerSpec -> blend ``uXform`` (x, y, sx, sy) and whether the sampler must be mipmapped (mip lod > 0, i.e. sx*sy < 0.5).  Only pixel and
    base layers carry a transform; everything else (text, shape, group, adjustment) maps 1:1 at the origin."""
    if layer.get("kind") not in ("pixel", "base"):
        return (0.0, 0.0, 1.0, 1.0), False
    x, y = float(layer.get("x", 0) or 0), float(layer.get("y", 0) or 0)
    sx, sy = float(layer.get("sx", 1.0) or 1.0), float(layer.get("sy", 1.0) or 1.0)
    if not (sx > 0 and math.isfinite(sx)):
        sx = 1.0
    if not (sy > 0 and math.isfinite(sy)):
        sy = 1.0
    if not (math.isfinite(x) and math.isfinite(y)):
        x = y = 0.0
    return (x, y, sx, sy), (sx * sy < 0.5)


def xform_is_exact(xf):
    """True when the mapping is an integer offset at scale 1: the blend pass places the surface with texelFetch and
    no resample pass is needed.  Same tolerance as blend.glsl."""
    return (xf[2] == 1.0 and xf[3] == 1.0 and abs(xf[0] - round(xf[0])) < 1e-4 and abs(xf[1] - round(xf[1])) < 1e-4)


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


def text_pars(spec, doc_w, doc_h, metrics=None):
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
        "typeface": ("Bold Italic" if spec.get("bold") and spec.get("italic") else "Bold" if spec.get("bold")
                     else "Italic" if spec.get("italic") else "Regular"),
        P["spacing"]: size * lh - float(m["pitch"]),
        P["wrap"]: False, P["border"]: border,
        P["posx"]: posx, P["posy"]: -top,
    }


class Plan:
    """How one adjustment layer is built.

    ``nodes``: extra operators (only blur has one), ordered ``(name, optype, pars, bypass, inputs, kind)``;
    inputs are node names or the tokens ``$acc`` (accumulated image below) / ``$prev``.  ``src`` = node
    feeding blend input 1 (``$last`` = last node, otherwise a name such as ``blank``), ``adjust`` =
    blend.glsl uAdjust, ``extra`` = uA / uB uniform values of the blend node."""

    def __init__(self, nodes, adjust, src="$last", extra=None):
        self.nodes, self.adjust, self.src, self.extra = nodes, adjust, src, extra or {}


# blend.glsl uAdjust codes
ADJ_BLEND, ADJ_PREMULT, ADJ_LEVELS, ADJ_BC, ADJ_INVERT, ADJ_THRESHOLD, ADJ_HSV, ADJ_RESAMPLE = range(8)


def _ab(a=0.0, b=0.0, c=0.0, d=0.0, e=0.0):
    return {"vec2valuex": float(a), "vec2valuey": float(b), "vec2valuez": float(c), "vec2valuew": float(d),
            "vec3valuex": float(e)}


def adjustment_plan(adj, sid, doc_w=0, doc_h=0):
    """AdjustmentSpec -> :class:`Plan`.  Documented at the top of this module."""
    t = adj.get("type")
    base = "adj_L_" + sid
    if t == "levels":
        lo = float(adj.get("inLow", 0.0))
        hi = max(float(adj.get("inHigh", 1.0)), lo + 1e-4)
        gamma = min(10.0, max(0.1, float(adj.get("gamma", 1.0))))
        return Plan([], ADJ_LEVELS, "blank", _ab(lo, hi, gamma, float(adj.get("outLow", 0.0)), float(adj.get("outHigh", 1.0))))
    if t == "brightnessContrast":
        return Plan([], ADJ_BC, "blank", _ab(float(adj.get("brightness", 0.0)), float(adj.get("contrast", 0.0))))
    if t == "invert":
        return Plan([], ADJ_INVERT, "blank", _ab())
    if t == "threshold":
        return Plan([], ADJ_THRESHOLD, "blank", _ab(float(adj.get("level", 0.5))))
    if t == "hueSaturation":
        return Plan([], ADJ_HSV, "blank", _ab(float(adj.get("hue", 0.0)), float(adj.get("saturation", 1.0)),
                                              float(adj.get("value", 1.0))))
    if t == "blur":
        r = max(0.0, float(adj.get("radius", 0.0)))
        ps = blur_preshrink(r)
        return Plan([(base, "blurTOP", {
            "type": "gaussian", "extend": "hold", "preshrink": ps,
            "size": max(1, int(round(r * BLUR_SIZE_PER_RADIUS / ps)))}, r < 0.1, ["$acc"], "blur")], ADJ_PREMULT)
    # unknown type: identity
    return Plan([(base, "nullTOP", {}, False, ["$acc"], "null")], ADJ_PREMULT)


class _OutOfBudget(Exception):
    pass


class _Node:
    """Desired state of one operator."""

    __slots__ = ("name", "optype", "pars", "inputs", "bypass", "pos", "glsl")

    def __init__(self, name, optype, pars=None, inputs=(), bypass=False, pos=(0, 0)):
        self.name = name
        self.optype = optype
        self.pars = pars or {}
        self.inputs = list(inputs)
        self.bypass = bypass
        self.pos = pos
        self.glsl = optype == "glslTOP"


class DocNetwork:
    def __init__(self, comp, blend_glsl, clock=time.monotonic, shape_glsl=None):
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
        self._unknown_names = []
        self._junk = []       # companion DATs TD auto-creates (g1_info, g1_pixel, s3_callbacks ...)
        self._garbage = []    # disconnected operators waiting to be destroyed by tick()
        self._adopt = {}
        self._metrics = {}    # (resolved font, bold, italic, size) -> measured text metrics
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
        self._source_keys = {}  # text / shape layer id -> its own spec + document size (Flatten token)
        self._sources = {}     # text / shape layer id -> source node name
        self._slot_nodes = {}
        self._prev_layers = None
        self._prev_stack = None
        self._prev_size = None
        self._input_connected = None
        self._scanned = False
        self._view = None
        self._view_state = {}
        self._counters = {"created": 0, "destroyed": 0, "par_sets": 0, "connects": 0,
                          "disconnects": 0, "recycled": 0, "applies": 0, "unknown": 0, "forced": 0}
        self._last = {}
        self._last_ms = 0.0
        self._ensure_base_nodes()

    # ------------------------------------------------------------------ public API

    def apply(self, layers, doc_w, doc_h):
        t0 = time.perf_counter()
        counters0 = dict(self._counters)
        doc_w, doc_h = int(doc_w), int(doc_h)
        connected = self._detect_input()
        key = (doc_w, doc_h)
        snap = json.dumps(layers, sort_keys=True, separators=(",", ":"))
        if snap == self._prev_layers and key == self._prev_size and connected == self._input_connected:
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
        self._prev_size = key
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
        for _ in range(2 if len(self._pool) < 2 else 1):
            if len(self._pool) < POOL_TARGET:
                self._pool.append(self._make_pool_node())

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

    # ---- Flatten (text / shape layer rendered alone) -------------------------------------------
    # The ext re-resolves these EVERY FRAME while a renderLayer request is in flight (they are cheap dictionary
    # lookups): the operator behind a layer can be recycled / destroyed by an apply() between two frames.

    def render_layer_source(self, layer_id):
        """The TOP that renders a text / shape layer alone: its source node (Text TOP / shape GLSL TOP) at document
        resolution, transparent background, premultiplied RGBA, NOT affected by the layer's opacity, mask, blend
        mode, visibility (a hidden layer still renders) or the layers below.  Pure lookup, no cooking, no
        measurement.  ``None`` when ``layer_id`` is not a text / shape layer of the last applied stack (never
        applied, deleted, kind changed) or its operator is gone; the transparent ``blank`` TOP for a layer without a
        spec.  Check :meth:`render_layer_ready` before reading pixels and :meth:`render_layer_token` before and after
        the readback."""
        name = self._sources.get(layer_id)
        if name is None:
            for l in self._prev_stack or ():
                if l.get("id") == layer_id and l.get("kind") in ("text", "shape"):
                    op = self._ops.get("blank")
                    return op if op is not None and op.valid else None
            return None
        op = self._ops.get(name)
        return op if op is not None and op.valid else None

    def render_layer_token(self, layer_id):
        """Opaque value identifying the pixels ``render_layer_source`` would produce right now.  PER LAYER: it changes
        only when this layer's own spec / kind / the document size changes, the node behind it is replaced, or its text
        layout is refined (measurements finished).  Edits to other layers do not touch it, so a readback survives
        continuous editing elsewhere.  ``None`` = the layer is gone.  The ext compares it before cooking and after
        reading back and drops the result when it differs."""
        if self.render_layer_source(layer_id) is None:
            return None
        name = self._sources.get(layer_id, "blank")
        return (self._gen.get(name), self._source_keys.get(layer_id), self._text_rev.get(name, 0))

    def render_layer_status(self, layer_id):
        """``'ready'`` | ``'pending'`` (text measurements still being finished over later ticks, the layout shown is
        the 0.5 em fallback) | ``'failed'`` (the Text TOP could not be measured: retried with back-off, the fallback
        layout is what renders) | ``None`` (layer gone).  Does a bounded amount of measurement work itself
        (``FLATTEN_BUDGET`` cooks per call), so polling it each frame converges."""
        if self.render_layer_source(layer_id) is None:
            return None
        name = self._sources.get(layer_id)
        if name is None or name not in self._text_todo:
            return "ready"
        node, op = self._text_nodes.get(name), self._ops.get(name)
        if node is not None and op is not None and self._clock() >= self._text_retry.get(name, (0, 0.0))[1]:
            old = self._budget
            self._budget = FLATTEN_BUDGET
            try:
                metrics, complete = self._text_metrics(node[0], name)
                pars0 = self._counters["par_sets"]
                self._set_pars(name, op, text_pars(node[0], node[1], node[2], metrics))
                if self._counters["par_sets"] != pars0:           # a poll that changes nothing keeps the token
                    self._text_rev[name] = self._text_rev.get(name, 0) + 1
                if complete:
                    self._text_todo.discard(name)
            finally:
                self._budget = old
        if name not in self._text_todo:
            return "ready"
        return "failed" if self._text_retry.get(name, (0, 0.0))[0] > 0 else "pending"

    def render_layer_ready(self, layer_id):
        return self.render_layer_status(layer_id) == "ready"

    def output(self):
        return self._ops.get("out")

    def set_input_connected(self, flag):
        """The ext calls this when the COMP's input 1 is (dis)connected; apply() also detects it."""
        flag = bool(flag)
        if flag != self._input_connected and self._prev_layers is not None:
            self._input_connected = flag
            self._set_base_source(flag)
            self._prev_layers = None        # the base transform only applies to a connected input: re-plan on apply()

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
            "pool": len(self._pool), "garbage": len(self._garbage), "junk": len(self._junk), "by_type": types, "last_apply_ms": self._last_ms,
            "last": dict(self._last), "totals": dict(self._counters),
            "view": self._view is not None,
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

    def _detect_input(self):
        try:
            conns = self.comp.inputConnectors[0].connections
            return bool(conns)
        except Exception:
            return False

    def _set_base_source(self, connected):
        node = self._ops.get("base_src")
        if node is not None:
            want = "../in1" if connected else "blank"
            self._set_pars("base_src", node, {"top": want})

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
                    self._set_pars("text_measure", m, {
                        "font": font, "typeface": "Bold Italic" if bold and italic else "Bold" if bold
                        else "Italic" if italic else "Regular", "fontsizex": size, "fontsizey": size})
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
            self._set_pars(name, op, text_pars(spec, w, h, metrics))
            if self._counters["par_sets"] != pars0:
                self._text_rev[name] = self._text_rev.get(name, 0) + 1
            if complete:
                self._text_todo.discard(name)
            if self._budget <= 0:
                break

    # ------------------------------------------------------------------ planning

    def _plan(self, layers, doc_w, doc_h, connected):
        d = {}
        self._text_nodes = {}
        self._text_todo = set()
        for gone in [n for n in self._text_retry if not n.startswith("text_")]:
            del self._text_retry[gone]
        self._slot_nodes = {}
        self._new_sizes = {}
        self._sources = {}
        self._source_keys = {}
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
        add(_Node("blank", "constantTOP", dict(res, colorr=0.0, colorg=0.0, colorb=0.0, alpha=0.0,
                                               format="rgba8fixed"), pos=(-600, 0)))
        add(_Node("base_src", "selectTOP", {"top": "../in1" if connected else "blank"}, pos=(-600, -100)))

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

        def blend_pars(mode, opacity, has_mask, adjust, xf, mip, fmt=FMT_BLEND, filt="nearest"):
            return {
                "vec0name": "uParams", "vec0valuex": float(mode), "vec0valuey": float(opacity),
                "vec0valuez": 1.0 if has_mask else 0.0, "vec0valuew": float(adjust),
                "vec1name": "uXform", "vec1valuex": xf[0], "vec1valuey": xf[1], "vec1valuez": xf[2],
                "vec1valuew": xf[3],
                "inputfiltertype": filt, "inputextenduv": "hold",
                "pixeldat": "blend_glsl", "format": fmt,
            }

        def walk(kids, acc, depth):
            bx = depth * 700
            for l in kids:
                extra = {}
                sid = self._alloc_name(l["id"])
                kind = l.get("kind")
                y = -row[0] * 160
                row[0] += 1
                mask = l.get("mask")
                mask_name = None
                if mask and kind in ("pixel", "adjustment", "group", "base", "text", "shape") and mask.get("slot") is not None:
                    # a mask lives in layer space: same size as the layer's surface (document size for the rest)
                    own = kind in ("pixel", "base")
                    mask_name = surface(int(mask["slot"]), bx - 700, y - 60,
                                        l.get("surfaceW") if own else None, l.get("surfaceH") if own else None)
                    if not mask.get("enabled", True):
                        mask_name = None   # surface exists, but is not cooked / wired
                visible = bool(l.get("visible", True))
                opacity = l.get("opacity", 1.0)
                mode = BLEND_INDEX.get(l.get("blend", "normal"), 0)
                bname = "blend_base" if kind == "base" else "blend_L_" + sid
                xf, mip = xform_uniforms(l)
                if kind in ("text", "shape"):
                    self._source_keys[l["id"]] = json.dumps([kind, l.get(kind), doc_w, doc_h], sort_keys=True,
                                                            separators=(",", ":"))
                if kind == "base":
                    src, adjust, mode = "base_src", 0, 0
                    if not connected:
                        xf, mip = (0.0, 0.0, 1.0, 1.0), False       # nothing to transform: blank is document sized
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
                        add(_Node(src, "textTOP", text_pars(spec, doc_w, doc_h, metrics), (), pos=(bx - 350, y)))
                        self._sources[l["id"]] = src
                    else:
                        src = "shape_" + sid
                        pars = {"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h,
                                "pixeldat": "shape_glsl", "format": FMT_SHAPE,
                                "vec0name": "uParams", "vec1name": "uOffset", "vec2name": "uA", "vec3name": "uB",
                                "vec4name": "uC"}
                        pars.update(shape_uniforms(spec, doc_h))
                        add(_Node(src, "glslTOP", pars, (), pos=(bx - 350, y)))
                        self._sources[l["id"]] = src
                elif kind == "pixel":
                    slot = l.get("slot")
                    src = surface(int(slot), bx - 350, y, l.get("surfaceW"), l.get("surfaceH")) \
                        if slot is not None else "blank"
                    adjust = 0
                elif kind == "group":
                    kids2 = children.get(l["id"], [])
                    src = walk(kids2, "blank", depth + 1) if kids2 else "blank"
                    adjust = 0
                    if not kids2:
                        visible = False
                elif kind == "adjustment":
                    plan = adjustment_plan(l.get("adjustment") or {}, sid, doc_w, doc_h)
                    adjust = plan.adjust
                    extra = plan.extra
                    prev = None
                    ax = bx - 350
                    for name, optype, pars, byp, ins, nk in plan.nodes:
                        npars = dict(pars)
                        if optype not in ("nullTOP", "constantTOP"):
                            npars["format"] = FMT
                        ins = [acc if i == "$acc" else prev if i == "$prev" else i for i in ins]
                        add(_Node(name, optype, npars, ins, bypass=byp, pos=(ax, y)))
                        prev = name
                        ax += 120
                    src = prev if plan.src == "$last" else plan.src
                else:
                    continue
                # sTD2DInputs[] is sized by the number of wired inputs: always wire all three
                has_mask = mask_name is not None
                if kind in ("pixel", "base") and src != "blank" and not xform_is_exact(xf):
                    # non-integer position or scale: a resample pass renders the layer (and its mask) into document
                    # space; it is the only node that reads through a mipmap filter, the blend below only fetches
                    xname = "xf_L_" + sid
                    xp = blend_pars(0, 0.0, has_mask, ADJ_RESAMPLE, xf, mip, filt="mipmap" if mip else "linear")
                    xp.update({"outputresolution": "custom", "resolutionw": doc_w, "resolutionh": doc_h})
                    add(_Node(xname, "glslTOP", xp, [src, mask_name or src, src], pos=(bx - 175, y)))      # 3 inputs: sTD2DInputs[] is sized by the wired ones
                    src, mask_name, has_mask, xf, mip = xname, None, False, (0.0, 0.0, 1.0, 1.0), False
                inputs = [acc, src, mask_name or "blank"]
                bp = blend_pars(mode, opacity, has_mask, adjust, xf, mip)
                bp.update(extra)
                add(_Node(bname, "glslTOP", bp, inputs, bypass=not visible, pos=(bx, y)))
                acc = bname
            return acc

        root = walk(children.get(None, []), "blank", 0)
        add(_Node("out", "nullTOP", {}, [root], pos=(1000, 0)))
        for gone in [n for n in self._text_retry if n not in self._text_nodes]:
            del self._text_retry[gone]
        return d

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

    def _remove_unknown(self):
        self._prune()
        known = {op.name for op in self._ops.values()} | set(RESERVED) \
            | {p[0].name for p in self._pool} | {g.name for g, _ in self._garbage} | {j.name for j in self._junk}
        leftovers = {o.path for o in self._adopt.values()}      # tagged glsl nodes whose role is gone
        for child in list(self.doc.children):
            if not child.valid or child.name in known:      # may have died with a destroyed parent node
                continue
            spare = child.OPType == "glslTOP" and not child.tags and _SPARE_NAME.match(child.name)
            if (child.path in leftovers or spare) and len(self._pool) < POOL_MAX:
                child.tags = []
                child.comment = ""
                for i in range(len(child.inputConnectors)):
                    child.inputConnectors[i].disconnect()
                child.bypass = False
                self._pool.append((child, {"type": "glslTOP", "pars": {}, "inputs": [], "bypass": False, "pos": None}))
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

    def _note_companions(self, op):
        """TD creates helper DATs next to some operators (unused here since the shader / callbacks DATs are
        shared): queue them for destruction in tick() instead of paying ~1 ms each inside apply()."""
        if op.OPType not in ("glslTOP", "scriptTOP"):
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
                if self._pool:
                    op, cache = self._pool.pop()
                    self._counters["recycled"] += 1
                else:
                    op, cache = self._make_pool_node()
                self._cache[name] = cache
            else:
                op = self.doc.create(spec.optype, name)
                self._counters["created"] += 1
                self._note_companions(op)
                self._cache[name] = {"type": spec.optype, "pars": {}, "inputs": [], "bypass": False, "pos": None}
        if spec.glsl:
            op.tags = [ROLE_PREFIX + name]
            op.comment = name
        self._ops[name] = op
        self._gen_counter += 1
        self._gen[name] = self._gen_counter
        return op

    def _set_pars(self, name, op, pars):
        self._set_pars_raw(op, self._cache[name], pars)

    def _set_pars_raw(self, op, cache, pars):
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
        cur = cache["inputs"]
        if cur is None:     # adopted: unknown state, rewire everything
            cur = [object()] * len(op.inputConnectors)
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
                op.inputConnectors[i].connect(self._ops[want[0]])
                self._counters["connects"] += 1
        cache["inputs"] = want_all

    def _drop(self, name, force_destroy=False):
        """The operator behind ``name`` is not needed any more.  GLSL TOPs go back to the spare pool,
        everything else is disconnected and destroyed later by tick() (destroying costs ~1 ms each)."""
        op = self._ops.pop(name)
        cache = self._cache.pop(name)
        self._pending.pop(name, None)
        if _SURFACE_NAME.match(name):
            self._slot_sizes.pop(int(name[1:]), None)
        # disconnect so nothing downstream keeps a reference
        for i in range(len(cache["inputs"] or [])):
            op.inputConnectors[i].disconnect()
            self._counters["disconnects"] += 1
        cache["inputs"] = []
        if cache["type"] == "glslTOP" and len(self._pool) < POOL_MAX:
            if cache["pars"].get("outputresolution", "useinput") != "useinput":
                # shape nodes have a custom resolution; blend nodes inherit input 0's
                self._set_pars_raw(op, cache, {"outputresolution": "useinput"})
            if cache["pars"].get("inputfiltertype", "nearest") != "nearest":
                self._set_pars_raw(op, cache, {"inputfiltertype": "nearest"})      # never recycle a mipmap flag
            if cache["bypass"]:
                op.bypass = False
                cache["bypass"] = False
            op.tags = []
            op.comment = ""
            self._pool.append((op, cache))
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
_SURFACE_NAME = re.compile(r"^s\d+$")


def _read_sibling(name):
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""
