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
                              2 mask; always 3 wired) or ``adj_<id>_un`` (unpremultiply helper).  They are
                              NOT named after the layer: creating or renaming a GLSL TOP costs ~4.5 ms, so a
                              pool of spare nodes is made in tick() and handed out / taken back by apply().
    adj_<id>[_a]   native adjustment TOPs (Level / HSV Adjust / Blur / Threshold, see below)
    out            nullTOP    result (input = last root blend)
    blend_glsl, surface_callbacks   text DATs (shader, Script TOP callbacks)

Chain order is bottom -> top inside each parent; a group is an isolated chain that starts at ``blank``
and whose result is the *source* of ``blend_<groupId>``.

Adjustment mapping (AdjustmentSpec -> TOPs)  --  KEEP IN SYNC WITH THE WEB PREVIEW
===================================================================================
All formulas are on STRAIGHT (unpremultiplied) sRGB values c in [0,1] unless stated; the working
image is premultiplied, so adjustments that are non-linear in colour are bracketed by an unpremultiply
node (``adj_<id>_un``, blend.glsl mode 3) and finally merged with the alpha of the image below
(blend.glsl ``uAdjust = 2``).  Final result of every adjustment layer:

    out = mix(below, adjusted, opacity * mask)            (premultiplied RGBA, per channel)

levels            nodes: _un -> _a (Level) -> adj (Level)            uAdjust = 2
                    t   = clamp((c - inLow) / (inHigh - inLow), 0, 1)           _a.inlow/inhigh, clamp
                    out = outLow + (outHigh - outLow) * t ** (1 / gamma)         adj.gamma1=gamma, outlow/outhigh
                  (gamma > 1 brightens mid-tones; alpha untouched; inHigh is kept >= inLow + 1e-4)
brightnessContrast nodes: _un -> _a (Level) -> adj (Level)           uAdjust = 2
                    c1  = clamp(c * (1 + brightness), 0, 1)                     _a.brightness1 = 1 + brightness
                    out = clamp((c1 - 0.5) * (1 + contrast) + 0.5, 0, 1)        adj.contrast = 1 + contrast
                  (== CSS ``brightness(1+b) contrast(1+k)``; brightness is a MULTIPLY, contrast pivots at 0.5)
hueSaturation     nodes: _un -> adj (HSV Adjust TOP)                 uAdjust = 2
                    true HSV edit on straight colour: V = max(R,G,B), S = (V - min) / V, H in degrees;
                    H' = H + hue (+ = CSS hue-rotate direction: red -> green -> blue), S' = min(1, S * saturation),
                    V' = V * value, back to RGB, then each channel is clamped to [0,1] by the blend shader
                    (value > 1 saturates channels, hue is not kept).  hueoffset/saturationmult/valuemult are
                    set 1:1 (hueoffset is in DEGREES).  Identity (0, 1, 1) -> node bypassed.
blur              node: adj (Blur TOP, gaussian)                      uAdjust = 1
                    size = round(radius * 4.698 / preshrink), preshrink = 1 (r<6), 2 (<14), 4 (<32), 8
                    -> gaussian with standard deviation sigma = radius px (measured 100.06 for size 470 and
                    200.4 for 940 at preshrink 1), applied to premultiplied RGBA.  Pixels outside the document
                    repeat the edge pixels (Blur TOP extend 'hold'); radius < 0.1 -> node bypassed (size 1 would blur with sigma ~0.2 px, not r).
invert            nodes: _un -> adj (Level invert=1)                 uAdjust = 2      out = 1 - c
threshold         nodes: _un -> adj (Threshold TOP)                  uAdjust = 2
                    out = white if lum(c) >= level else black, alpha preserved, lum = Rec.709
                    0.2126 R + 0.7152 G + 0.0722 B  (the Threshold TOP 'luminance' weights, measured:
                    NOT Rec.601 0.299/0.587/0.114).  comparator 'lessorequal' = level <= lum.

Blend uniforms (GLSL TOP Vectors page): ``uParams`` vec4 = (BlendMode index, opacity, hasMask,
uAdjust 0..3) and ``uOffset`` vec2 = (x, y).  See blend.glsl.

Persistence (verified): a LOCKED Script TOP keeps its pixels in COMP.save()/loadTox (and so in a saved .toe).
Locking resets the locked image, so ``freeze()`` does ``top.lock = True`` and then calls ``comp.OnSurfaceCook(top)``
(the ext's promoted method, which must copy the whole surface buffer) to write the pixels INTO the locked TOP.
``thaw()`` unlocks; TD recooks an unlocked Script TOP at once, so ``OnSurfaceCook`` must always copy the whole
buffer (not only when dirty).  ``read_locked()`` returns the stored pixels as float32 (h, w, 4), TD row order.
"""

import json
import re
import time

BLEND_MODES = (
    "normal", "multiply", "screen", "overlay", "soft-light", "hard-light",
    "darken", "lighten", "color-dodge", "color-burn", "difference", "exclusion",
    "hue", "saturation", "color", "luminosity",
)
BLEND_INDEX = {name: i for i, name in enumerate(BLEND_MODES)}

GRACE_S = 2.0
POOL_TARGET = 6          # spare glsl TOPs kept ready (creating a GLSL TOP costs ~4.7 ms)
POOL_MAX = 10
GARBAGE_MAX = 12
JUNK_MAX = 80
PENDING_MAX = 24
ROLE_PREFIX = "role:"
BLUR_SIZE_PER_RADIUS = 4.698   # Blur TOP gaussian: sigma = size / 4.698 (measured)
FMT = "rgba16float"          # adjustment internals (values may leave 0..1)
FMT_BLEND = "rgba16fixed"     # blend outputs: 1.5e-5 steps (float16 is 2.4e-4 near 1.0 and colour-burn amplifies it)

# reserved (non layer) node names inside doc
RESERVED = ("blend_glsl", "surface_callbacks", "blank", "base_src", "out")
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


LEVEL_DEFAULTS = {
    "invert": False, "brightness1": 1.0, "gamma1": 1.0, "contrast": 1.0, "inlow": 0.0, "inhigh": 1.0,
    "outlow": 0.0, "outhigh": 1.0, "clamp": True,
}


def blur_preshrink(radius):
    """Blur TOP pre-shrink (box downsample before the 1-D passes); the cost is linear in the filter size, so
    large radii run on a 2x/4x/8x smaller image (sigma >= ~3.5 shrunk px; measured error vs a true gaussian
    stays ~4/255 incl. 1 px lines)."""
    return 1 if radius < 6 else 2 if radius < 14 else 4 if radius < 32 else 8


def _level(**kw):
    """Complete Level TOP parameter set (a node can change role between applies)."""
    d = dict(LEVEL_DEFAULTS)
    d.update(kw)
    return d


class Plan:
    """Nodes of one adjustment layer (besides ``blend_<id>``).

    ``nodes``: ordered ``(name, optype, pars, bypass, inputs, kind)``; inputs are node names or the tokens
    ``$acc`` (accumulated image below) / ``$prev`` (previous node of the list).  ``src`` = node feeding
    blend input 1 (``$last`` = last node), ``adjust`` = blend.glsl uAdjust."""

    def __init__(self, nodes, adjust, src="$last"):
        self.nodes, self.adjust, self.src = nodes, adjust, src


def adjustment_plan(adj, sid, doc_w=0, doc_h=0):
    """AdjustmentSpec -> :class:`Plan`.  Documented at the top of this module."""
    t = adj.get("type")
    base = "adj_L_" + sid
    un = (base + "_un", "glslTOP", {}, False, ["$acc", "blank", "blank"], "un")
    if t == "levels":
        lo = float(adj.get("inLow", 0.0))
        hi = max(float(adj.get("inHigh", 1.0)), lo + 1e-4)
        gamma = min(10.0, max(0.1, float(adj.get("gamma", 1.0))))
        return Plan([
            un,
            (base + "_a", "levelTOP", _level(inlow=lo, inhigh=hi), False, ["$prev"], "level"),
            (base, "levelTOP", _level(
                gamma1=gamma, outlow=float(adj.get("outLow", 0.0)), outhigh=float(adj.get("outHigh", 1.0))),
             False, ["$prev"], "level"),
        ], 2)
    if t == "brightnessContrast":
        b = float(adj.get("brightness", 0.0))
        k = float(adj.get("contrast", 0.0))
        return Plan([
            un,
            (base + "_a", "levelTOP", _level(brightness1=1.0 + b), False, ["$prev"], "level"),
            (base, "levelTOP", _level(contrast=1.0 + k), False, ["$prev"], "level"),
        ], 2)
    if t == "invert":
        return Plan([un, (base, "levelTOP", _level(invert=True), False, ["$prev"], "level")], 2)
    if t == "threshold":
        return Plan([un, (base, "thresholdTOP", {
            "comparator": "lessorequal", "rgb": "luminance", "alpha": "one",
            "threshold": float(adj.get("level", 0.5))}, False, ["$prev"], "threshold")], 2)
    if t == "hueSaturation":
        hue = float(adj.get("hue", 0.0))
        sat = float(adj.get("saturation", 1.0))
        val = float(adj.get("value", 1.0))
        ident = hue == 0.0 and sat == 1.0 and val == 1.0
        return Plan([un, (base, "hsvadjustTOP", {
            "hueoffset": hue, "saturationmult": sat, "valuemult": val}, ident, ["$prev"], "hsv")], 2)
    if t == "blur":
        r = max(0.0, float(adj.get("radius", 0.0)))
        ps = blur_preshrink(r)
        return Plan([(base, "blurTOP", {
            "type": "gaussian", "extend": "hold", "preshrink": ps,
            "size": max(1, int(round(r * BLUR_SIZE_PER_RADIUS / ps)))}, r < 0.1, ["$acc"], "blur")], 1)
    # unknown type: identity
    return Plan([(base, "nullTOP", {}, False, ["$acc"], "null")], 1)


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
    def __init__(self, comp, blend_glsl, clock=time.monotonic):
        self.comp = comp
        self._blend_glsl = blend_glsl
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
        self._names = {}      # layer id -> sanitised, unique
        self._used_names = set()
        self._desired = {}
        self._slots = {}      # slot -> node name (live surfaces)
        self._prev_layers = None
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
        desired = self._plan(layers, doc_w, doc_h, connected)
        self._reconcile(desired)
        self._prev_layers = snap
        self._prev_size = key
        self._counters["applies"] += 1
        self._last_ms = (time.perf_counter() - t0) * 1e3
        self._last = {k: self._counters[k] - counters0[k] for k in self._counters}

    def tick(self):
        """Housekeeping, cheap, call once per frame: destroys ONE expired surface (2 s grace) or ONE
        garbage node, otherwise tops up the spare GLSL pool by one node (a few ms at most)."""
        if self._tick_pending():
            return
        if self._garbage:
            self._collect_garbage(1)
            return
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

    def output(self):
        return self._ops.get("out")

    def set_input_connected(self, flag):
        """The ext calls this when the COMP's input 1 is (dis)connected; apply() also detects it."""
        flag = bool(flag)
        if flag != self._input_connected and self._prev_layers is not None:
            self._input_connected = flag
            self._set_base_source(flag)

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

    # ------------------------------------------------------------------ planning

    def _plan(self, layers, doc_w, doc_h, connected):
        d = {}
        self._slot_nodes = {}
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

        def surface(slot, x, y):
            name = "s%d" % slot
            self._slot_nodes[slot] = name
            if name not in d:
                add(_Node(name, "scriptTOP", dict(res, callbacks="surface_callbacks"), pos=(x, y)))
            return name

        def blend_pars(mode, opacity, has_mask, adjust, ox, oy, fmt=FMT_BLEND):
            return {
                "vec0name": "uParams", "vec0valuex": float(mode), "vec0valuey": float(opacity),
                "vec0valuez": 1.0 if has_mask else 0.0, "vec0valuew": float(adjust),
                "vec1name": "uOffset", "vec1valuex": float(ox), "vec1valuey": float(oy),
                "pixeldat": "blend_glsl", "format": fmt,
            }

        def walk(kids, acc, depth):
            bx = depth * 700
            for l in kids:
                sid = self._alloc_name(l["id"])
                kind = l.get("kind")
                y = -row[0] * 160
                row[0] += 1
                mask = l.get("mask")
                mask_name = None
                if mask and kind in ("pixel", "adjustment", "group", "base") and mask.get("slot") is not None:
                    mask_name = surface(int(mask["slot"]), bx - 700, y - 60)
                    if not mask.get("enabled", True):
                        mask_name = None   # surface exists, but is not cooked / wired
                visible = bool(l.get("visible", True))
                opacity = l.get("opacity", 1.0)
                mode = BLEND_INDEX.get(l.get("blend", "normal"), 0)
                bname = "blend_base" if kind == "base" else "blend_L_" + sid
                ox, oy = (l.get("x", 0), l.get("y", 0)) if kind == "pixel" else (0, 0)
                if kind == "base":
                    src, adjust, mode = "base_src", 0, 0
                elif kind == "pixel":
                    slot = l.get("slot")
                    src = surface(int(slot), bx - 350, y) if slot is not None else "blank"
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
                    prev = None
                    ax = bx - 350
                    for name, optype, pars, byp, ins, nk in plan.nodes:
                        npars = dict(pars)
                        if nk == "un":
                            npars.update(blend_pars(0, 1.0, False, 3, 0, 0, FMT))
                        elif optype not in ("nullTOP", "constantTOP"):
                            npars["format"] = FMT
                        ins = [acc if i == "$acc" else prev if i == "$prev" else i for i in ins]
                        add(_Node(name, optype, npars, ins, bypass=byp, pos=(ax, y)))
                        prev = name
                        ax += 120
                    src = prev if plan.src == "$last" else plan.src
                else:
                    continue
                # sTD2DInputs[] is sized by the number of wired inputs: always wire all three
                inputs = [acc, src, mask_name or "blank"]
                add(_Node(bname, "glslTOP", blend_pars(mode, opacity, mask_name is not None, adjust, ox, oy),
                          inputs, bypass=not visible, pos=(bx, y)))
                acc = bname
            return acc

        root = walk(children.get(None, []), "blank", 0)
        add(_Node("out", "nullTOP", {}, [root], pos=(1000, 0)))
        return d

    # ------------------------------------------------------------------ reconcile

    def _reconcile(self, desired):
        old_names = set(self._desired)
        self._desired = desired
        slots_new = dict(self._slot_nodes)
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

    def _remove_unknown(self):
        known = {op.name for op in self._ops.values()} | set(RESERVED) \
            | {p[0].name for p in self._pool} | {g.name for g, _ in self._garbage} | {j.name for j in self._junk}
        leftovers = {o.path for o in self._adopt.values()}      # tagged glsl nodes whose role is gone
        for child in list(self.doc.children):
            if child.name in known:
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
            child.destroy()
            self._counters["destroyed"] += 1
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
            "pixeldat": "blend_glsl", "format": FMT_BLEND, "vec0name": "uParams", "vec1name": "uOffset"})
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
            self._garbage = [(g, c) for g, c in self._garbage if g is not existing and g.path != existing.path]
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
                setattr(op.par, k, v)
                cp[k] = v
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
        # disconnect so nothing downstream keeps a reference
        for i in range(len(cache["inputs"] or [])):
            op.inputConnectors[i].disconnect()
            self._counters["disconnects"] += 1
        cache["inputs"] = []
        if cache["type"] == "glslTOP" and len(self._pool) < POOL_MAX:
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
