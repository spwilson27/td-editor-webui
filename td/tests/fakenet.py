"""Fake TouchDesigner operator tree for exercising network.DocNetwork without TD.

Only the surface DocNetwork uses is modelled: ``create / op / children / destroy``, parameters (every
assignment is logged), input connectors, ``bypass``, ``nodeX/nodeY``, ``tags``, ``comment``, ``lock``,
``numpyArray``.  Like TD, creating a glslTOP / scriptTOP also creates companion DATs (``g1_info``,
``s3_callbacks`` ...) and every create / destroy / par set is counted in ``Log``.
"""

import numpy as np

COMPANIONS = {
    "glslTOP": ("_info", "_pixel", "_compute"),
    "glslmultiTOP": ("_info", "_pixel", "_compute"),
    "scriptTOP": ("_callbacks",),
}


class Log:
    def __init__(self):
        self.creates = []       # (type, name)
        self.destroys = []      # names
        self.par_sets = []      # (opname, parname, value)
        self.connects = []      # (opname, index, source name)
        self.disconnects = []   # (opname, index)
        self.renames = []

    def mark(self):
        return (len(self.creates), len(self.destroys), len(self.par_sets), len(self.connects), len(self.disconnects))

    def since(self, mark):
        return {
            "creates": self.creates[mark[0]:], "destroys": self.destroys[mark[1]:],
            "par_sets": self.par_sets[mark[2]:], "connects": self.connects[mark[3]:],
            "disconnects": self.disconnects[mark[4]:],
        }

    def clear(self):
        self.__init__()


class FakePars:
    def __init__(self, op):
        object.__setattr__(self, "_op", op)
        object.__setattr__(self, "_v", {})

    def __setattr__(self, name, value):
        self._v[name] = value
        self._op._log.par_sets.append((self._op.name, name, value))

    def __getattr__(self, name):
        v = object.__getattribute__(self, "_v")
        if name in v:
            return _Val(v[name])
        raise AttributeError(name)

    def value(self, name):
        return self._v.get(name)


class _Val:
    def __init__(self, v):
        self.v = v

    def eval(self):
        return self.v


class FakeConnector:
    def __init__(self, op, index):
        self.op, self.index = op, index
        self.source = None

    def connect(self, other):
        self.source = other
        self.op._log.connects.append((self.op.name, self.index, other.name))
        op = self.op       # TD keeps one free connector after the last used one (glsl TOPs: any number)
        while op.OPType in ("glslTOP", "glslmultiTOP", "overTOP") and op.inputConnectors[-1].source is not None:
            op.inputConnectors.append(FakeConnector(op, len(op.inputConnectors)))

    def disconnect(self):
        self.source = None
        self.op._log.disconnects.append((self.op.name, self.index))
        _trim(self.op)

    @property
    def connections(self):
        return [self.source] if self.source is not None else []


def _trim(op):
    """Like TD, a Multi TOP keeps exactly one free connector after the last connected one: trailing free ones vanish."""
    if op.OPType == "glslmultiTOP":
        while len(op.inputConnectors) > 1 and op.inputConnectors[-1].source is None and op.inputConnectors[-2].source is None:
            op.inputConnectors.pop()


class FakeOp:
    def __init__(self, parent, optype, name, log):
        self.parent_op = parent
        self.OPType = optype
        self._name = name
        self._log = log
        self.par = FakePars(self)
        self.valid = True
        self.bypass = False
        self.nodeX = self.nodeY = 0
        self.tags = []
        self.comment = ""
        self.lock = False
        self.text = ""
        self.children_list = []
        self.inputConnectors = [FakeConnector(self, 0)]
        self.pixels = None
        self.cooks = 0

    # -- identity
    @property
    def name(self):
        if not self.valid:
            raise RuntimeError("Invalid OP object")
        return self._name

    @name.setter
    def name(self, v):
        self._log.renames.append((self._name, v))
        self._name = v

    @property
    def path(self):
        base = self.parent_op.path if self.parent_op is not None else ""
        return base + "/" + self._name

    @property
    def isTOP(self):
        return self.OPType.endswith("TOP")

    # -- tree
    @property
    def children(self):
        return [c for c in self.children_list if c.valid]

    def op(self, name):
        for c in self.children_list:
            if c.valid and c._name == name:
                return c
        return None

    def create(self, optype, name):
        if self.op(name) is not None:      # like TD: a duplicate name gets a numeric suffix
            base, i = name, 1
            while self.op(name) is not None:
                name = "%s%d" % (base, i)
                i += 1
        c = FakeOp(self, optype, name, self._log)
        self.children_list.append(c)
        self._log.creates.append((optype, name))
        if optype in COMPANIONS:
            for suf in COMPANIONS[optype]:
                comp = FakeOp(self, "textDAT", name + suf, self._log)
                self.children_list.append(comp)
                self._log.creates.append(("textDAT", name + suf))
        if optype in ("glslTOP", "glslmultiTOP", "levelTOP", "blurTOP", "thresholdTOP", "hsvadjustTOP", "overTOP", "nullTOP",
                      "resolutionTOP"):
            c.inputConnectors = [FakeConnector(c, 0)]
        return c

    def destroy(self):
        assert self.valid, "destroy of an invalid op " + self._name
        self.valid = False
        self._log.destroys.append(self._name)
        # like TD, destroying a GLSL / Script TOP also takes its auto-created companion DATs with it
        for suf in COMPANIONS.get(self.OPType, ()):
            comp = self.parent_op.op(self._name + suf) if self.parent_op is not None else None
            if comp is not None:
                comp.valid = False
        # downstream connectors that pointed here are cut, like TD
        root = self.parent_op
        if root is not None:
            for c in root.children_list:
                for con in c.inputConnectors:
                    if con.source is self:
                        con.source = None
                        _trim(c)

    # -- Text TOP measurement (deterministic stand-in: 0.5 em per character, line box 1.1 em, descender 0.25 em)
    def _tp(self, k, d=0):
        v = self.par.value(k)
        return d if v is None else v

    @property
    def textWidth(self):
        lines = str(self._tp("text", "")).split("\n")
        return 0.5 * float(self._tp("fontsizex", 30)) * max(len(l) for l in lines)

    @property
    def textHeight(self):
        return 1.1 * float(self._tp("fontsizex", 30)) * len(str(self._tp("text", "")).split("\n"))

    @property
    def fontDescender(self):
        return 0.25 * float(self._tp("fontsizex", 30))

    # -- TOP api
    def numpyArray(self):
        return self.pixels

    def cook(self, force=False):
        self.cooks += 1


def make_comp(log=None, with_input=True, webrender=True):
    """A fake raster_editor COMP with an In TOP (``in1``) and optionally a ``webrender`` TOP."""
    log = log or Log()
    comp = FakeCompOp(None, "baseCOMP", "raster_editor", log)
    comp.in1 = comp.create("inTOP", "in1")
    if webrender:
        comp.create("webrenderTOP", "webrender")
    log.clear()
    return comp, log


class FakeCompOp(FakeOp):
    def __init__(self, parent, optype, name, log):
        super().__init__(parent, optype, name, log)
        self.inputConnectors = [FakeConnector(self, 0)]
        self.surface_cooks = []

    @property
    def path(self):
        return "/" + self._name

    def OnSurfaceCook(self, top):
        # like the real ext: record the lock state at the time of the call
        self.surface_cooks.append((top.name, bool(top.lock)))
        top.pixels = np.full((4, 4, 4), len(self.surface_cooks), np.float32)

    def create(self, optype, name):
        c = super().create(optype, name)
        if optype == "baseCOMP":
            c.__class__ = FakeCompOp
            c.surface_cooks = []
        return c


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


# --------------------------------------------------------------------------- numpy reference of blend.glsl sampling
# Used by test_network.py (maths) and scripts/network_dev.py (against the live GPU / Chromium).


def _pyramid(img):
    """Mip chain by 2x2 box filtering (sizes floor(n/2), edge texel repeated for the odd row/column)."""
    levels = [img.astype(np.float64)]
    while min(levels[-1].shape[:2]) > 1:
        a = levels[-1]
        h, w = a.shape[0] // 2, a.shape[1] // 2
        h, w = max(h, 1), max(w, 1)
        # average the source rows/cols that map onto each output texel (box)
        out = np.zeros((h, w, a.shape[2]))
        for dy in (0, 1):
            for dx in (0, 1):
                yy = np.minimum(np.arange(h) * 2 + dy, a.shape[0] - 1)
                xx = np.minimum(np.arange(w) * 2 + dx, a.shape[1] - 1)
                out += a[yy][:, xx]
        levels.append(out / 4.0)
    return levels


def _bilinear(img, u, v):
    """img (h, w, c) top-row-first; u, v = continuous texel coordinates (texel i covers [i, i+1]); clamp to edge."""
    h, w = img.shape[:2]
    fx, fy = u - 0.5, v - 0.5
    x0, y0 = np.floor(fx), np.floor(fy)
    tx, ty = (fx - x0)[..., None], (fy - y0)[..., None]
    x0, y0 = x0.astype(int), y0.astype(int)

    def g(yy, xx):
        return img[np.clip(yy, 0, h - 1), np.clip(xx, 0, w - 1)]
    return (g(y0, x0) * (1 - tx) * (1 - ty) + g(y0, x0 + 1) * tx * (1 - ty)
            + g(y0 + 1, x0) * (1 - tx) * ty + g(y0 + 1, x0 + 1) * tx * ty)


def affine_forward(sx, sy, rot=0.0, kx=0.0, ky=0.0):
    """Forward linear part R(rot) K(kx,ky) S(sx,sy) (document px, y down; rot degrees clockwise on screen)."""
    r = np.radians(rot)
    R = np.array([[np.cos(r), -np.sin(r)], [np.sin(r), np.cos(r)]])
    K = np.array([[1.0, np.tan(np.radians(kx))], [np.tan(np.radians(ky)), 1.0]])
    return R @ K @ np.diag([sx, sy])


def affine_lod(A):
    """mip level of the resample pass: -0.5 log2|det A| - 0.5 (geometric mean of the singular values; 0 when magnifying)."""
    return max(0.0, -0.5 * np.log2(abs(np.linalg.det(A))) - 0.5)


def coverage_supersampled(A, x, y, sw, sh, out_w, out_h, n=32):
    """Fraction of every document pixel covered by the layer rect [0,sw]x[0,sh] mapped through ``doc = (x,y) + A l``,
    by n x n point sampling (independent of the shader's polygon clipping; error <= ~1/n on an edge)."""
    Ai = np.linalg.inv(A)
    o = (np.arange(n) + 0.5) / n
    cov = np.zeros((out_h, out_w))
    jj, ii = np.mgrid[0:out_h, 0:out_w]
    for oy in o:
        for ox in o:
            dx, dy = ii + ox - x, jj + oy - y
            lx = Ai[0, 0] * dx + Ai[0, 1] * dy
            ly = Ai[1, 0] * dx + Ai[1, 1] * dy
            cov += (lx >= 0) & (lx < sw) & (ly >= 0) & (ly < sh)
    return cov / (n * n)


def sample_reference(src, out_w, out_h, x, y, sx, sy, mip=True, coverage=True, lod=None, rot=0.0, kx=0.0, ky=0.0):
    """What blend.glsl does to the *source* (premultiplied float (h, w, 4), top row first) for a document of
    out_w x out_h: returns the float (out_h, out_w, 4) layer image in document space (top row first), coverage applied.

    ``doc = (x, y) + R(rot) K(kx,ky) S(sx,sy) layer`` (v5 affine; rot / kx / ky degrees).  Pure scale + translation keeps
    the exact formulas of v4 (separable coverage, integer offsets at scale 1 are texel exact); rotated / skewed
    transforms use point-sampled coverage."""
    sh, sw = src.shape[:2]
    jj, ii = np.mgrid[0:out_h, 0:out_w]
    cx, cy = ii + 0.5, jj + 0.5
    pure = rot == 0.0 and kx == 0.0 and ky == 0.0
    A = affine_forward(sx, sy, rot, kx, ky)
    Ai = np.linalg.inv(A)
    dx, dy = cx - x, cy - y
    lx, ly = Ai[0, 0] * dx + Ai[0, 1] * dy, Ai[1, 0] * dx + Ai[1, 1] * dy
    if pure:
        hx, hy = 0.5 / sx, 0.5 / sy
        cov = (np.clip((np.minimum(lx + hx, sw) - np.maximum(lx - hx, 0.0)) / (2 * hx), 0, 1)
               * np.clip((np.minimum(ly + hy, sh) - np.maximum(ly - hy, 0.0)) / (2 * hy), 0, 1))
    else:
        cov = coverage_supersampled(A, x, y, sw, sh, out_w, out_h)
    exact = pure and sx == 1.0 and sy == 1.0 and abs(x - round(x)) < 1e-4 and abs(y - round(y)) < 1e-4
    if exact:
        iy = np.clip(np.floor(ly).astype(int), 0, sh - 1)
        ix = np.clip(np.floor(lx).astype(int), 0, sw - 1)
        out = src[iy, ix]
    else:
        if lod is None:
            lod = affine_lod(A) if mip else 0.0
        chain = _pyramid(src) if lod > 0 else [src]
        l0 = min(int(np.floor(lod)), len(chain) - 1)
        l1 = min(l0 + 1, len(chain) - 1)
        f = lod - np.floor(lod) if l1 != l0 else 0.0

        def at(level):
            im = chain[level]
            k = 2.0 ** level
            return _bilinear(im, lx / k * (im.shape[1] * k / sw), ly / k * (im.shape[0] * k / sh))
        out = at(l0) if f == 0 else at(l0) * (1 - f) + at(l1) * f
    return out * cov[..., None] if coverage else out


def shader_port(tex_td, out_w, out_h, x, y, sx, sy):
    """A literal numpy port of the non-exact path of blend.glsl (GL conventions: texture rows bottom first, v up,
    gl_FragCoord bottom-left) -- used to check the y-flip / uv formulas against ``sample_reference``.
    ``tex_td``: (h, w, 4) in TD row order (row 0 = bottom).  Bilinear, clamp, no mip."""
    sh, sw = tex_td.shape[:2]
    px_, py_ = np.meshgrid(np.arange(out_w), np.arange(out_h))        # gl pixel index, py_ counted from the bottom
    fcx, fcy = px_ + 0.5, py_ + 0.5                                   # gl_FragCoord
    cx, cy = fcx, out_h - fcy
    lx, ly = (cx - x) / sx, (cy - y) / sy
    u, v = lx / sw, 1.0 - ly / sh
    out = _bilinear(tex_td, u * sw, v * sh)                           # texel space, row 0 = bottom (v = 0)
    return out[::-1]                                                  # back to top-row-first document order


def clip_poly(poly, nrm, d):
    """Port of clipPoly() in blend.glsl: Sutherland-Hodgman against dot(v, nrm) >= d (at most 8 vertices kept)."""
    q = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        da, db = a[0] * nrm[0] + a[1] * nrm[1] - d, b[0] * nrm[0] + b[1] * nrm[1] - d
        if da >= 0.0 and len(q) < 8:
            q.append(a)
        if (da >= 0.0) != (db >= 0.0) and len(q) < 8:
            t = da / (da - db)
            q.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return q


def footprint_coverage(l, e0, e1, sw, sh):
    """Port of footprintCoverage() in blend.glsl for one pixel: ``l`` = footprint centre in layer px, ``e0`` / ``e1`` =
    half edges (layer px) of the document pixel's parallelogram."""
    ex, ey = abs(e0[0]) + abs(e1[0]), abs(e0[1]) + abs(e1[1])
    lo, hi = (l[0] - ex, l[1] - ey), (l[0] + ex, l[1] + ey)
    if hi[0] <= 0 or hi[1] <= 0 or lo[0] >= sw or lo[1] >= sh:
        return 0.0
    area0 = abs(e0[0] * e1[1] - e0[1] * e1[0]) * 4.0
    if area0 <= 1e-12:
        return 0.0
    if e0[1] == 0.0 and e1[0] == 0.0:
        cx = np.clip((min(l[0] + ex, sw) - max(l[0] - ex, 0.0)) / (2 * ex), 0, 1)
        cy = np.clip((min(l[1] + ey, sh) - max(l[1] - ey, 0.0)) / (2 * ey), 0, 1)
        return float(cx * cy)
    if lo[0] >= 0 and lo[1] >= 0 and hi[0] <= sw and hi[1] <= sh:
        return 1.0
    poly = [(l[0] - e0[0] - e1[0], l[1] - e0[1] - e1[1]), (l[0] + e0[0] - e1[0], l[1] + e0[1] - e1[1]),
            (l[0] + e0[0] + e1[0], l[1] + e0[1] + e1[1]), (l[0] - e0[0] + e1[0], l[1] - e0[1] + e1[1])]
    for nrm, d in (((1.0, 0.0), 0.0), ((-1.0, 0.0), -sw), ((0.0, 1.0), 0.0), ((0.0, -1.0), -sh)):
        poly = clip_poly(poly, nrm, d)
        if not poly:
            return 0.0
    a2 = 0.0
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        a2 += a[0] * b[1] - b[0] * a[1]
    return float(min(1.0, abs(a2) * 0.5 / area0))


def resample_uniforms(x, y, sx, sy, rot=0.0, kx=0.0, ky=0.0):
    """(uXform = inverse linear part (m00, m01, m10, m11), uA.xy = (x, y)) as network.py hands them to the resample pass."""
    A = affine_forward(sx, sy, rot, kx, ky)
    Ai = np.linalg.inv(A)
    return (Ai[0, 0], Ai[0, 1], Ai[1, 0], Ai[1, 1]), (x, y)


def resample_port(src_td, mask_td, out_w, out_h, x, y, sx, sy, has_mask=False, rot=0.0, kx=0.0, ky=0.0):
    """A literal numpy port of ``resample()`` in blend.glsl (the uAdjust = 7 pass): GL conventions (textures hold
    TD row order, row 0 = bottom, v up; gl_FragCoord bottom-left, pixel centres at +0.5), uniforms uXform = inverse linear
    part and uA.xy = translation, parallelogram coverage by polygon clipping, the integer ``exact`` branch (texelFetch),
    trilinear ``textureLod`` with lod = max(0, 0.5 log2|det uXform| - 0.5) and the mask taken from the second input.
    Returns the document image top row first (premultiplied, coverage x mask applied)."""
    src_td = np.asarray(src_td, np.float64)
    sh, sw = src_td.shape[:2]
    (m00, m01, m10, m11), (tx, ty) = resample_uniforms(x, y, sx, sy, rot, kx, ky)
    pxx, pyy = np.meshgrid(np.arange(out_w), np.arange(out_h))           # pyy counted from the bottom (GL)
    cx, cy = pxx + 0.5, out_h - (pyy + 0.5)
    dx, dy = cx - tx, cy - ty
    lx, ly = m00 * dx + m01 * dy, m10 * dx + m11 * dy
    e0, e1 = (0.5 * m00, 0.5 * m10), (0.5 * m01, 0.5 * m11)
    cov = np.zeros(lx.shape)
    for j in range(out_h):
        for i in range(out_w):
            cov[j, i] = footprint_coverage((lx[j, i], ly[j, i]), e0, e1, sw, sh)
    exact = (abs(m00 - 1) < 1e-6 and abs(m11 - 1) < 1e-6 and abs(m01) < 1e-6 and abs(m10) < 1e-6
             and abs(tx - np.floor(tx + 0.5)) < 1e-4 and abs(ty - np.floor(ty + 0.5)) < 1e-4)
    u, v = lx / sw, 1.0 - ly / sh
    lod = max(0.0, 0.5 * np.log2(max(abs(m00 * m11 - m01 * m10), 1e-12)) - 0.5)
    ipx, ipy = np.floor(lx).astype(int), np.floor(ly).astype(int)

    def tex_lod(tex):
        th, tw = tex.shape[:2]
        if lod <= 0:
            return _bilinear(tex, u * tw, v * th)
        chain = _pyramid(tex)
        l0 = min(int(np.floor(lod)), len(chain) - 1)
        l1 = min(l0 + 1, len(chain) - 1)
        f = (lod - np.floor(lod)) if l1 != l0 else 0.0
        a = _bilinear(chain[l0], u * chain[l0].shape[1], v * chain[l0].shape[0])
        b = _bilinear(chain[l1], u * chain[l1].shape[1], v * chain[l1].shape[0])
        return a * (1 - f) + b * f
    if exact:
        src = src_td[np.clip(sh - 1 - ipy, 0, sh - 1), np.clip(ipx, 0, sw - 1)]
    else:
        src = tex_lod(src_td)
    m = np.ones(cov.shape)
    if has_mask:
        mask_td = np.asarray(mask_td, np.float64)
        mh, mw = mask_td.shape[:2]
        if exact and (mh, mw) == (sh, sw):
            m = mask_td[np.clip(mh - 1 - ipy, 0, mh - 1), np.clip(ipx, 0, mw - 1)][..., 0]
        else:
            m = tex_lod(mask_td)[..., 0]
    out = src * (cov * m)[..., None]
    out[cov <= 0] = 0.0
    return out[::-1]


def blend_source_port(src_td, mask_td, out_w, out_h, x, y, has_mask=False):
    """Literal port of the blend pass's source/mask fetch (uAdjust 0..6): integer offset ``round(x), round(y)``
    (``floor(v + 0.5)``), transparent outside the source, mask 0 outside the mask.  Returns (src, m) top row first."""
    src_td = np.asarray(src_td, np.float64)
    sh, sw = src_td.shape[:2]
    pxx, pyy = np.meshgrid(np.arange(out_w), np.arange(out_h))
    dx = pxx - int(np.floor(x + 0.5))
    dy = (out_h - 1 - pyy) - int(np.floor(y + 0.5))
    inside = (dx >= 0) & (dy >= 0) & (dx < sw) & (dy < sh)
    src = np.zeros((out_h, out_w, 4))
    m = np.ones((out_h, out_w))
    sp_y = np.clip(sh - 1 - dy, 0, sh - 1)
    sp_x = np.clip(dx, 0, sw - 1)
    src[inside] = src_td[sp_y, sp_x][inside]
    if has_mask:
        mask_td = np.asarray(mask_td, np.float64)
        mh, mw = mask_td.shape[:2]
        in_m = inside & (dx < mw) & (dy < mh)
        mv = mask_td[np.clip(mh - 1 - dy, 0, mh - 1), np.clip(dx, 0, mw - 1)][..., 0]
        m = np.where(inside, np.where(in_m, mv, 0.0), 1.0)
    return src[::-1], m[::-1]
