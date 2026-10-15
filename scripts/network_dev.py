"""Live harness for td/raster_editor/network.py (blend.glsl + DocNetwork) inside TouchDesigner.

    .venv/bin/python scripts/network_dev.py [all|blend|adjust|misc|perf|view|persist|shapes|shapes-gl|text|v3perf|v6] [--keep]

Works only inside the scratch COMP ``/project1/_netdev`` (created and destroyed here).  A stand-in
for the extension (``Stub.OnSurfaceCook``) serves surface buffers that this script uploads.  Nothing
outside the scratch COMP is touched; the project is never saved.

Checks (each prints PASS/FAIL with numbers):
  blend   16 blend modes x random straight RGBA pairs (partial alpha) vs a numpy W3C reference and,
          when Playwright/Chromium is available (web/node_modules), vs Canvas 2D globalCompositeOperation
  adjust  every adjustment type vs the formulas documented in network.py
  misc    masks, offsets, hidden layers, opacity, group isolation, base input
  view    TD-view overlay placement + checkerboard
  persist freeze / read_locked / thaw, .tox round trip
  xform   v4 transforms: scale/offset/mask/base vs numpy and Chromium canvas, Flatten source; xperf: timings
  perf    apply() timings and GPU cook time of a 20-layer 1080p document
  shapes  v3 shape layers (shape.glsl) vs a supersampled numpy reference, every shape type
  shapes-gl  same, offline: shape.glsl in headless Chromium WebGL2 (no TouchDesigner)
  text    v3 text layers vs Chromium Canvas 2D (textShape.ts conventions): bbox +-2 px, coverage IoU
  v3perf  apply() timings for text/shape edits, GPU cost per layer @1080p
  v6      v6 performance network (merged passes, bounding boxes, skip rules, 8 bit, blur pyramid) vs the v5 network
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import textwrap

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "td", "raster_editor"))

from td_call import run as td_run  # noqa: E402

SCRATCH = "/project1/_netdev"
BLEND_MODES = (
    "normal", "multiply", "screen", "overlay", "soft-light", "hard-light",
    "darken", "lighten", "color-dodge", "color-burn", "difference", "exclusion",
    "hue", "saturation", "color", "luminosity",
)
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + detail if detail else ""))
    return bool(ok)


# --------------------------------------------------------------------------- TD plumbing


def td(code: str, timeout: float = 120):
    """Run code in TD; the last printed line starting with '@@' is parsed as JSON and returned."""
    res = td_run(textwrap.dedent(code), timeout=timeout)
    out = res.get("stdout", "") or ""
    if not res.get("ok"):
        raise RuntimeError("TD error: " + (res.get("traceback") or json.dumps(res))[:3000] + "\n" + out[-2000:])
    ret = None
    for line in out.splitlines():
        if line.startswith("@@"):
            ret = json.loads(line[2:])
    return ret


WORK = os.environ.get("NETDEV_WORK") or os.path.join(tempfile.gettempdir(), "netdev_work")
os.makedirs(WORK, exist_ok=True)


PRELUDE = '''
from td import *
import sys, types, json, base64, time
import numpy as np
def _emit(o): print("@@" + json.dumps(o))
def _b64(a): return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
def _st(): return sys.modules["re_state"]
'''


def setup(doc_w: int = 64, doc_h: int = 64) -> None:
    """(Re)create the scratch COMP, the stand-in extension and a DocNetwork."""
    # The sources are read by TD itself (this machine): network.py + effects.py + shaders no longer fit the 200 kB
    # limit of one td_call.
    raster_dir = os.path.join(ROOT, "td", "raster_editor")
    fx_dir = os.path.join(ROOT, "shared", "effects")
    opt_arg = ", optimize=False" if os.environ.get("NETDEV_OPT", "1") == "0" else ""      # NETDEV_OPT=0: the v5 node-per-layer network
    code = PRELUDE + f'''
p = op("/project1")
if p.op("_netdev"): p.op("_netdev").destroy()
c = p.create(baseCOMP, "_netdev")
stub = c.create(textDAT, "ext_stub")
stub.text = """
import sys
import numpy as np
class Stub:
    def __init__(self, owner):
        self.owner = owner
        self.cooks = {{}}
    def OnSurfaceCook(self, scriptOp):
        st = sys.modules["re_state"]
        slot = int(scriptOp.name[1:])
        self.cooks[slot] = self.cooks.get(slot, 0) + 1
        buf = st.buffers.get(slot)
        if buf is None:
            buf = np.zeros((scriptOp.height, scriptOp.width, 4), np.uint8)
        scriptOp.copyNumpyArray(buf)
"""
c.par.parentshortcut = "RasterEditor"
c.par.ext0object = "op('./ext_stub').module.Stub(me)"
c.par.ext0name = "Stub"
c.par.ext0promote = 1
c.initializeExtensions()
def _load(name, src):
    m = types.ModuleType(name); m.__dict__["__name__"] = name
    exec(compile(src, name, "exec"), m.__dict__); sys.modules[name] = m; return m
import os
def _rd(path):
    with open(path, encoding="utf-8") as f:
        return f.read()
GLSL_SRC = _rd({os.path.join(raster_dir, "blend.glsl")!r})
net_mod = _load("re_network", _rd({os.path.join(raster_dir, "network.py")!r}))
fx_mod = _load("re_effects", _rd({os.path.join(raster_dir, "effects.py")!r}))
st = types.ModuleType("re_state"); sys.modules["re_state"] = st
st.buffers = {{}}
st.net_mod = net_mod
st.glsl = GLSL_SRC
st.comp = c
st.net = net_mod.DocNetwork(c, GLSL_SRC, shape_glsl=_rd({os.path.join(raster_dir, 'shape.glsl')!r}), effects=fx_mod, effect_shaders=fx_mod.load_shader_texts({fx_dir!r}){opt_arg})
st.fx_mod = fx_mod
st.fx_shaders = fx_mod.load_shader_texts({fx_dir!r})
st.w, st.h = {doc_w}, {doc_h}
_emit("ok")
'''
    td(code)


def teardown() -> None:
    td(PRELUDE + '''
p = op("/project1")
if p.op("_netdev"): p.op("_netdev").destroy()
_emit("ok")
''')


def upload(slot: int, rgba_straight_u8: np.ndarray) -> None:
    """rgba_straight_u8: (h, w, 4) uint8 straight alpha, top row first (document order)."""
    h, w, _ = rgba_straight_u8.shape
    a = rgba_straight_u8.astype(np.float32) / 255.0
    pre = a.copy()
    pre[..., :3] *= a[..., 3:4]
    pre8 = np.rint(pre * 255).astype(np.uint8)[::-1]            # premultiplied, TD row order
    upload_premul(slot, pre8)


def upload_premul(slot: int, pre8_td_order: np.ndarray) -> None:
    path = os.path.join(WORK, f"up_{slot}.npy")
    np.save(path, np.ascontiguousarray(pre8_td_order))
    td(PRELUDE + f'''
a = np.load({path!r})
_st().buffers[{slot}] = a
t = _st().net.surface_top({slot})
if t is not None: t.cook(force=True)
_emit("ok")
''')


def apply(layers: list[dict], w: int, h: int) -> dict:
    return td(PRELUDE + f'''
st = _st()
t0 = time.perf_counter()
st.net.apply(json.loads({json.dumps(json.dumps(layers))}), {w}, {h})
dt = (time.perf_counter() - t0) * 1e3
st.w, st.h = {w}, {h}
_emit({{"ms": dt, "stats": st.net.stats()}})
''')


def read_out(premultiplied: bool = False) -> np.ndarray:
    """Output of doc/out as float32 (h, w, 4), top row first, straight alpha unless premultiplied."""
    outp = os.path.join(WORK, "out.npy")
    r = td(PRELUDE + f'''
st = _st()
o = st.net.output()
o.cook(force=True)
a = o.numpyArray()
np.save({outp!r}, a.astype(np.float32))
_emit("ok")
''')
    a = np.load(outp)[::-1].copy()
    if not premultiplied:
        al = a[..., 3:4]
        a[..., :3] = np.where(al > 0, a[..., :3] / np.maximum(al, 1e-9), 0)
    return a


def layer(id_, kind="pixel", **kw) -> dict:
    d = dict(id=id_, kind=kind, parentId=None, name=id_, visible=True, opacity=1.0, blend="normal",
             x=0, y=0, sx=1.0, sy=1.0, rot=0.0, kx=0.0, ky=0.0, surfaceW=None, surfaceH=None, slot=None, mask=None, adjustment=None)
    d.update(kw)
    return d


def base_layer() -> dict:
    return layer("base", "base")


# --------------------------------------------------------------------------- numpy references


def lum(c):
    return 0.3 * c[..., 0] + 0.59 * c[..., 1] + 0.11 * c[..., 2]


def clip_color(c):
    l = lum(c)[..., None]
    n = c.min(-1, keepdims=True)
    x = c.max(-1, keepdims=True)
    with np.errstate(all="ignore"):
        c = np.where(n < 0, l + (c - l) * l / (l - n), c)
        c = np.where(x > 1, l + (c - l) * (1 - l) / (x - l), c)
    return c


def set_lum(c, l):
    return clip_color(c + (l - lum(c))[..., None])


def sat(c):
    return c.max(-1) - c.min(-1)


def set_sat(c, s):
    mn = c.min(-1, keepdims=True)
    mx = c.max(-1, keepdims=True)
    with np.errstate(all="ignore"):
        r = np.where(mx > mn, (c - mn) * s[..., None] / (mx - mn), 0.0)
    return r


def blend_fn(mode: str, cb, cs):
    if mode == "normal":
        return cs
    if mode == "multiply":
        return cb * cs
    if mode == "screen":
        return cb + cs - cb * cs
    if mode in ("overlay", "hard-light"):
        b, s = (cs, cb) if mode == "overlay" else (cb, cs)    # overlay = hard-light(swap)
        return np.where(s <= 0.5, b * 2 * s, b + (2 * s - 1) - b * (2 * s - 1))
    if mode == "soft-light":
        d = np.where(cb <= 0.25, ((16 * cb - 12) * cb + 4) * cb, np.sqrt(cb))
        return np.where(cs <= 0.5, cb - (1 - 2 * cs) * cb * (1 - cb), cb + (2 * cs - 1) * (d - cb))
    if mode == "darken":
        return np.minimum(cb, cs)
    if mode == "lighten":
        return np.maximum(cb, cs)
    if mode == "color-dodge":
        with np.errstate(all="ignore"):
            return np.where(cb == 0, 0.0, np.where(cs >= 1, 1.0, np.minimum(1.0, cb / (1 - cs))))
    if mode == "color-burn":
        with np.errstate(all="ignore"):
            return np.where(cb >= 1, 1.0, np.where(cs <= 0, 0.0, 1 - np.minimum(1.0, (1 - cb) / cs)))
    if mode == "difference":
        return np.abs(cb - cs)
    if mode == "exclusion":
        return cb + cs - 2 * cb * cs
    if mode == "hue":
        return set_lum(set_sat(cs, sat(cb)), lum(cb))
    if mode == "saturation":
        return set_lum(set_sat(cb, sat(cs)), lum(cb))
    if mode == "color":
        return set_lum(cs, lum(cb))
    if mode == "luminosity":
        return set_lum(cb, lum(cs))
    raise ValueError(mode)


def w3c_over(mode: str, below_straight, src_straight, opacity=1.0):
    """Reference: W3C source-over with blend mode.  Inputs/outputs float straight RGBA in 0..1."""
    cb, ab = below_straight[..., :3], below_straight[..., 3:4]
    cs, as_ = src_straight[..., :3], src_straight[..., 3:4] * opacity
    bl = np.clip(blend_fn(mode, cb, cs), 0, 1)
    ar = as_ + ab - as_ * ab
    pre = (1 - ab) * as_ * cs + (1 - as_) * ab * cb + as_ * ab * bl
    return np.concatenate([pre, ar], -1)   # premultiplied result


# --------------------------------------------------------------------------- checks: blend

CHROME_JS = r"""
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(({ w, h, below, src, modes, opacity }) => {
    const mk = (data) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0); return c;
    };
    const rd = (c) => Array.from(c.getContext('2d').getImageData(0, 0, w, h).data);
    const B = mk(below), S = mk(src);
    const res = { below: rd(B), src: rd(S), out: {} };
    for (const m of modes) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.drawImage(B, 0, 0);
      x.globalCompositeOperation = m === 'normal' ? 'source-over' : m;
      x.globalAlpha = opacity;
      x.drawImage(S, 0, 0);
      res.out[m] = rd(c);
    }
    return res;
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})();
"""


def chromium_reference(below: np.ndarray, src: np.ndarray, modes, opacity: float):
    """Runs Canvas 2D in Playwright Chromium. Returns (below_rt, src_rt, {mode: out}) straight uint8 or None."""
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules", "playwright")):
        return None
    h, w, _ = below.shape
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "ref.cjs")
        open(js, "w").write(CHROME_JS)
        inp = os.path.join(d, "in.json")
        outp = os.path.join(d, "out.json")
        json.dump({"w": w, "h": h, "below": below.ravel().tolist(), "src": src.ravel().tolist(),
                   "modes": list(modes), "opacity": opacity}, open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp], cwd=web, capture_output=True, text=True, timeout=180, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            print("chromium reference failed:", r.stderr[-500:])
            return None
        o = json.load(open(outp))
    f = lambda a: np.array(a, np.uint8).reshape(h, w, 4)
    return f(o["below"]), f(o["src"]), {m: f(v) for m, v in o["out"].items()}


def premul255(straight_u8):
    a = straight_u8.astype(np.float64)
    out = a.copy()
    out[..., :3] = a[..., :3] * a[..., 3:4] / 255.0
    return out


def make_pairs(n_side=64, seed=7):
    rng = np.random.default_rng(seed)
    n = n_side * n_side
    below = rng.integers(0, 256, (n, 4), dtype=np.uint8)
    src = rng.integers(0, 256, (n, 4), dtype=np.uint8)
    # a good share of exactly-opaque / partial / zero alpha and extreme channel values
    sel = rng.random(n)
    below[sel < 0.35, 3] = 255
    src[(sel > 0.2) & (sel < 0.55), 3] = 255
    below[(sel > 0.9), 3] = rng.choice([0, 64, 128, 192], (sel > 0.9).sum())
    ext = rng.random((n, 3)) < 0.18
    src[..., :3] = np.where(ext, rng.choice([0, 255], (n, 3)).astype(np.uint8), src[..., :3])
    ext = rng.random((n, 3)) < 0.18
    below[..., :3] = np.where(ext, rng.choice([0, 255], (n, 3)).astype(np.uint8), below[..., :3])
    return below.reshape(n_side, n_side, 4), src.reshape(n_side, n_side, 4)


def test_blend():
    S = 64
    below, src = make_pairs(S)
    ref = chromium_reference(below, src, BLEND_MODES, 1.0)
    if ref is None:
        below_rt, src_rt, chrome = below, src, None
        print("(no Chromium reference: comparing to numpy W3C only)")
    else:
        below_rt, src_rt, chrome = ref
    setup(S, S)
    upload(1, below_rt)
    upload(2, src_rt)
    worst_w3c = 0.0
    worst_chrome = 0.0
    lines = []
    for mi, mode in enumerate(BLEND_MODES):
        layers = [base_layer(), layer("b", slot=1), layer("s", slot=2, blend=mode)]
        apply(layers, S, S)
        out = read_out(premultiplied=True) * 255.0
        # numpy reference from the TD-visible (premultiplied 8-bit) inputs
        b = below_rt.astype(np.float64) / 255
        s = src_rt.astype(np.float64) / 255
        # TD stores premultiplied 8-bit; reference on the same quantisation
        bq = np.rint(premul255(below_rt)) / 255
        sq = np.rint(premul255(src_rt)) / 255
        bs = np.where(bq[..., 3:4] > 0, bq / np.maximum(bq[..., 3:4], 1e-9), 0); bs[..., 3] = bq[..., 3]
        ss = np.where(sq[..., 3:4] > 0, sq / np.maximum(sq[..., 3:4], 1e-9), 0); ss[..., 3] = sq[..., 3]
        r1 = w3c_over(mode, bs, ss) * 255
        # first layer is opaque-normal over transparent so b == below
        d1 = np.abs(out - r1).max()
        d1m = np.abs(out - r1).mean()
        worst_w3c = max(worst_w3c, d1)
        msg = f"{mode:12s} TD vs W3C-numpy max {d1:5.2f} mean {d1m:5.3f}"
        if chrome is not None:
            c = premul255(chrome[mode])
            d2 = np.abs(out - c)
            # canvas stores 8-bit premultiplied; getImageData unpremultiplies (lossy at low alpha)
            lossy = chrome[mode][..., 3:4] < 8
            d2 = np.where(lossy, 0, d2)
            msg += f" | vs Chromium max {d2.max():5.2f} mean {d2.mean():5.3f} p99.9 {np.percentile(d2, 99.9):4.2f}"
            worst_chrome = max(worst_chrome, d2.max())
        lines.append(msg)
    for l in lines:
        print("  " + l)
    check("blend: 16 modes vs W3C numpy reference (<= 3/255)", worst_w3c <= 3.0, f"worst {worst_w3c:.2f}")
    if ref is not None:
        check("blend: 16 modes vs Chromium Canvas 2D (<= 3/255)", worst_chrome <= 3.0, f"worst {worst_chrome:.2f}")


def test_opacity_blend():
    S = 32
    below, src = make_pairs(S, seed=11)
    ref = chromium_reference(below, src, ("normal", "multiply", "hue", "overlay"), 0.37)
    setup(S, S)
    upload(1, below)
    upload(2, src)
    worst = 0
    for mode in ("normal", "multiply", "hue", "overlay"):
        apply([base_layer(), layer("b", slot=1), layer("s", slot=2, blend=mode, opacity=0.37)], S, S)
        out = read_out(premultiplied=True) * 255
        bq = np.rint(premul255(below)) / 255
        sq = np.rint(premul255(src)) / 255
        bs = np.where(bq[..., 3:4] > 0, bq / np.maximum(bq[..., 3:4], 1e-9), 0); bs[..., 3] = bq[..., 3]
        ss = np.where(sq[..., 3:4] > 0, sq / np.maximum(sq[..., 3:4], 1e-9), 0); ss[..., 3] = sq[..., 3]
        r1 = w3c_over(mode, bs, ss, 0.37) * 255
        d = np.abs(out - r1).max()
        worst = max(worst, d)
        if ref is not None:
            c = premul255(ref[2][mode])
            dc = np.where(ref[2][mode][..., 3:4] < 8, 0, np.abs(out - c)).max()
            print(f"  opacity .37 {mode:9s} vs W3C {d:.2f}  vs Chromium {dc:.2f}")
            worst = max(worst, dc)
    check("blend: opacity 0.37 (W3C + Chromium) <= 3/255", worst <= 3.0, f"worst {worst:.2f}")


# --------------------------------------------------------------------------- checks: adjustments


def rgb2hsv(c):
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx, mn = c.max(-1), c.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    with np.errstate(all="ignore"):
        h = np.where(d == 0, 0, np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4))) * 60
        s = np.where(mx > 0, d / mx, 0)
    return np.stack([h, s, mx], -1)


def hsv2rgb(h, s, v):
    h = (h % 360) / 60
    i = np.floor(h)
    f = h - i
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    i = i.astype(int) % 6
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)


def gaussian_blur(img, sigma, mode="edge"):
    r = int(np.ceil(sigma * 4))
    x = np.arange(-r, r + 1)
    k = np.exp(-x * x / (2 * sigma * sigma))
    k /= k.sum()
    pad = np.pad(img, ((r, r), (0, 0), (0, 0)), mode=mode)
    out = sum(k[i] * pad[i:i + img.shape[0]] for i in range(len(k)))
    pad = np.pad(out, ((0, 0), (r, r), (0, 0)), mode=mode)
    return sum(k[i] * pad[:, i:i + img.shape[1]] for i in range(len(k)))


def ref_adjust(adj: dict, below_pre: np.ndarray, opacity: float, mask: np.ndarray | None):
    """Documented formulas (network.py docstring).  below_pre: float premultiplied RGBA 0..1."""
    a = below_pre[..., 3:4]
    c = np.where(a > 0, below_pre[..., :3] / np.maximum(a, 1e-9), 0.0)
    t = adj["type"]
    straight_mode = True
    if t == "levels":
        lo, hi = adj["inLow"], max(adj["inHigh"], adj["inLow"] + 1e-4)
        tt = np.clip((c - lo) / (hi - lo), 0, 1)
        o = adj["outLow"] + (adj["outHigh"] - adj["outLow"]) * tt ** (1 / adj["gamma"])
    elif t == "brightnessContrast":
        c1 = np.clip(c * (1 + adj["brightness"]), 0, 1)
        o = np.clip((c1 - 0.5) * (1 + adj["contrast"]) + 0.5, 0, 1)
    elif t == "invert":
        o = 1 - c
    elif t == "threshold":
        l = 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]
        o = np.repeat((l >= adj["level"]).astype(np.float64)[..., None], 3, -1)
    elif t == "hueSaturation":
        hsv = rgb2hsv(c)
        o = np.clip(hsv2rgb(hsv[..., 0] + adj["hue"], np.minimum(1.0, hsv[..., 1] * adj["saturation"]), hsv[..., 2] * adj["value"]), 0, 1)
    elif t == "blur":
        adj_pre = gaussian_blur(below_pre.astype(np.float64), adj["radius"])
        straight_mode = False
    else:
        raise ValueError(t)
    if straight_mode:
        adj_pre = np.concatenate([np.clip(o, 0, 1) * a, a], -1)
    m = 1.0 if mask is None else mask[..., None]
    return below_pre + (adj_pre - below_pre) * (opacity * m)


def premul_f(straight_u8):
    return np.rint(premul255(straight_u8)) / 255.0


def run_adjust(adj: dict, below_u8, opacity=0.8, mask_u8=None, bypass_check=False, label=None):
    S = below_u8.shape[0]
    upload(1, below_u8)
    lays = [base_layer(), layer("b", slot=1)]
    mk = None
    if mask_u8 is not None:
        upload(5, mask_u8)
        mk = {"slot": 5, "enabled": True}
    lays.append(layer("adj", "adjustment", opacity=opacity, adjustment=adj, mask=mk))
    apply(lays, S, S)
    return read_out(premultiplied=True)


def test_adjust():
    S = 64
    rng = np.random.default_rng(3)
    below, _ = make_pairs(S, seed=21)
    mask = np.zeros((S, S, 4), np.uint8)
    mask[..., :3] = rng.integers(0, 256, (S, S, 1))
    mask[..., 3] = 255
    setup(S, S)
    cases = [
        {"type": "levels", "inLow": 0.1, "inHigh": 0.85, "gamma": 1.8, "outLow": 0.05, "outHigh": 0.9},
        {"type": "levels", "inLow": 0.0, "inHigh": 1.0, "gamma": 0.5, "outLow": 0.0, "outHigh": 1.0},
        {"type": "brightnessContrast", "brightness": 0.3, "contrast": -0.4},
        {"type": "brightnessContrast", "brightness": -0.5, "contrast": 0.6},
        {"type": "hueSaturation", "hue": 70, "saturation": 1.4, "value": 0.8},
        {"type": "hueSaturation", "hue": -120, "saturation": 0.3, "value": 1.3},
        {"type": "invert"},
        {"type": "threshold", "level": 0.4},
    ]
    worst = 0.0
    bq = premul_f(below)
    for adj in cases:
        for use_mask in (False, True):
            m = None
            mf = None
            if use_mask:
                m = mask
                mf = mask[..., 0].astype(np.float64) / 255
            out = run_adjust(adj, below, 0.8, m)
            ref = ref_adjust(adj, bq, 0.8, mf)
            d = np.abs(out - np.clip(ref, 0, 1)) * 255
            if adj["type"] == "threshold":     # ignore pixels whose luma sits on the threshold itself
                a_ = bq[..., 3:4]
                c_ = np.where(a_ > 0, bq[..., :3] / np.maximum(a_, 1e-9), 0)
                l_ = c_ @ np.array([0.2126, 0.7152, 0.0722])
                d = np.where((np.abs(l_ - adj["level"]) < 0.01)[..., None], 0, d)
            worst = max(worst, d.max())
            print(f"  {adj['type']:18s} mask={use_mask!s:5s} max {d.max():5.2f} mean {d.mean():5.3f}"
                  + (f"  {adj}" if not use_mask else ""))
    check("adjust: levels/brightnessContrast/hueSaturation/invert/threshold vs documented formulas (<= 3/255)",
          worst <= 3.0, f"worst {worst:.2f}")
    # blur on a structured image: pixels outside the document repeat the edge (Blur TOP hold == web preview)
    for S2, rad, touch in ((128, 3.0, False), (128, 8.0, True), (256, 20.0, True), (512, 40.0, True)):
        img = np.zeros((S2, S2, 4), np.uint8)
        img[..., 3] = 255
        if not touch:
            img[:] = 0
        img[S2 // 4:3 * S2 // 4, S2 // 4:3 * S2 // 4, :3] = (230, 40, 40)
        img[S2 // 4:3 * S2 // 4, S2 // 4:3 * S2 // 4, 3] = 255
        img[S2 // 2:, S2 // 3:S2 // 2, :] = (30, 200, 255, 100)
        setup(S2, S2)
        out = run_adjust({"type": "blur", "radius": rad}, img, 1.0)
        ref = ref_adjust({"type": "blur", "radius": rad}, premul_f(img), 1.0, None)
        d = np.abs(out - ref) * 255
        check(f"adjust: blur radius {rad:g}{' (content touches the border)' if touch else ''} vs numpy gaussian, edge-hold like the web preview (<= 12/255)",
              d.max() <= 12.0, f"max {d.max():.2f} mean {d.mean():.3f}")


# --------------------------------------------------------------------------- checks: misc


def test_misc():
    S = 48
    rng = np.random.default_rng(5)
    a = rng.integers(0, 256, (S, S, 4), dtype=np.uint8)
    b = rng.integers(0, 256, (S, S, 4), dtype=np.uint8)
    c = rng.integers(0, 256, (S, S, 4), dtype=np.uint8)
    setup(S, S)
    upload(1, a)
    upload(2, b)
    upload(3, c)
    A, B, C = (premul_f(x) for x in (a, b, c))

    def straight(p):
        al = p[..., 3:4]
        return np.concatenate([np.where(al > 0, p[..., :3] / np.maximum(al, 1e-9), 0), al], -1)

    def over(mode, below_pre, src_pre, opacity=1.0, mask=None):
        s = straight(src_pre)
        s = s.copy()
        if mask is not None:
            s[..., 3:4] = s[..., 3:4] * mask[..., None]
        return w3c_over(mode, straight(below_pre), s, opacity)

    # --- hidden layer == absent
    apply([base_layer(), layer("a", slot=1), layer("b", slot=2, visible=False)], S, S)
    out = read_out(True)
    check("misc: hidden layer is bypassed", np.abs(out - A).max() * 255 < 0.6, f"max {np.abs(out - A).max() * 255:.2f}")

    # --- offset: layer b moved by (7, -5) in doc px (top-left), normal over a
    ox, oy = 7, -5
    apply([base_layer(), layer("a", slot=1), layer("b", slot=2, x=ox, y=oy)], S, S)
    out = read_out(True)
    shifted = np.zeros_like(B)
    ys, xs = np.mgrid[0:S, 0:S]
    sx, sy = xs - ox, ys - oy
    ok = (sx >= 0) & (sx < S) & (sy >= 0) & (sy < S)
    shifted[ok] = B[sy[ok], sx[ok]]
    ref = over("normal", A, shifted)
    d = np.abs(out - ref).max() * 255
    check("misc: layer offset (x,y top-left origin, partially outside)", d < 0.6, f"max {d:.2f}")

    # --- mask on pixel layer
    msk = rng.integers(0, 256, (S, S, 1), dtype=np.uint8)
    m8 = np.concatenate([np.repeat(msk, 3, -1), np.full((S, S, 1), 255, np.uint8)], -1)
    upload(7, m8)
    apply([base_layer(), layer("a", slot=1),
           layer("b", slot=2, mask={"slot": 7, "enabled": True}, opacity=0.9, blend="multiply")], S, S)
    out = read_out(True)
    ref = over("multiply", A, B, 0.9, msk[..., 0] / 255.0)
    d = np.abs(out - ref).max() * 255
    check("misc: pixel layer mask + opacity + blend", d < 1.0, f"max {d:.2f}")
    apply([base_layer(), layer("a", slot=1),
           layer("b", slot=2, mask={"slot": 7, "enabled": False}, opacity=0.9, blend="multiply")], S, S)
    out = read_out(True)
    ref = over("multiply", A, B, 0.9, None)
    d = np.abs(out - ref).max() * 255
    check("misc: disabled mask is ignored", d < 1.0, f"max {d:.2f}")

    # --- group isolation: group (opacity .5, normal) containing b (multiply) and c (screen) over a
    g = layer("g", "group", opacity=0.5)
    lays = [base_layer(), layer("a", slot=1), g,
            layer("b", slot=2, parentId="g", blend="multiply"), layer("c", slot=3, parentId="g", blend="screen")]
    apply(lays, S, S)
    out = read_out(True)
    inner = over("screen", over("multiply", np.zeros_like(A), B), C)    # chain starts from transparent
    ref = over("normal", A, inner, 0.5)
    d = np.abs(out - ref).max() * 255
    check("misc: isolated group (children blend with each other, group opacity over below)", d < 1.5, f"max {d:.2f}")

    # --- adjustment inside group only affects group content below it
    lays = [base_layer(), layer("a", slot=1), layer("g", "group"),
            layer("b", slot=2, parentId="g"),
            layer("adj", "adjustment", parentId="g", adjustment={"type": "invert"}),
            layer("c", slot=3, parentId="g", blend="normal")]
    apply(lays, S, S)
    out = read_out(True)
    inv = ref_adjust({"type": "invert"}, B, 1.0, None)
    inner = over("normal", inv, C)
    ref = over("normal", A, inner)
    d = np.abs(out - ref).max() * 255
    check("misc: adjustment inside a group sees only the group's content below", d < 1.5, f"max {d:.2f}")

    # --- base from input: no input -> blank; node count sane
    st = apply([base_layer()], S, S)
    out = read_out(True)
    check("misc: base without input is transparent", out.max() == 0, f"max {out.max()}")

    # --- base from the COMP input (in1 connected to a Constant TOP that lives in a second scratch COMP)
    r = td(PRELUDE + """
p = op("/project1"); st = _st(); c = st.comp
if p.op("_netdev_src"): p.op("_netdev_src").destroy()
src = p.create(constantTOP, "_netdev_src")
src.par.outputresolution = "custom"; src.par.resolutionw = 48; src.par.resolutionh = 48
src.par.colorr = 1.0; src.par.colorg = 0.0; src.par.colorb = 0.0; src.par.alpha = 1.0
c.create(inTOP, "in1")
c.inputConnectors[0].connect(src)
_emit(1)
""")
    apply([base_layer(), layer("a", slot=1, opacity=0.5)], S, S)
    out = read_out(True)
    ref = over("normal", np.tile(np.array([1.0, 0, 0, 1.0]), (S, S, 1)), A, 0.5)
    d = np.abs(out - ref).max() * 255
    check("misc: base layer takes COMP input 1 when connected (src_in1 -> ../in1)", d < 1.0, f"max {d:.2f}")
    td(PRELUDE + """
st = _st(); st.comp.inputConnectors[0].disconnect(); _emit(1)
""")
    apply([base_layer(), layer("a", slot=1, opacity=0.5)], S, S)
    out = read_out(True)
    ref = over("normal", np.zeros((S, S, 4)), A, 0.5)
    d = np.abs(out - ref).max() * 255
    check("misc: base falls back to transparent after the input is disconnected", d < 1.0, f"max {d:.2f}")
    td(PRELUDE + """
op("/project1/_netdev_src").destroy(); _emit(1)
""")

    # --- document without any layer, delete -> grace -> destroy
    st = apply([base_layer(), layer("a", slot=1), layer("b", slot=2)], S, S)
    st = apply([base_layer(), layer("a", slot=1)], S, S)
    pend = st["stats"]["pending_destroy"]
    import time as _t
    _t.sleep(2.2)
    r = td(PRELUDE + """
st = _st()
for _ in range(20): st.net.tick()
s = st.net.stats(); _emit({"pending": s["pending_destroy"], "slots": st.net.slots(), "nodes": s["nodes"]})
""")
    check("misc: removed surface destroyed after the 2 s grace", pend >= 1 and r["pending"] == 0 and r["slots"] == [1],
          f"pending before {pend}, after {r['pending']}, slots {r['slots']}")


# --------------------------------------------------------------------------- checks: view, persistence


def view_reference(doc_pre, view, pw, ph):
    """numpy model of the doc_view shader (nearest sampling, zoom >= 1). doc_pre: (h, w, 4) premult, top row first."""
    h, w, _ = doc_pre.shape
    r = view["rect"]
    ox, oy, z = r["x"] + view["panX"], r["y"] + view["panY"], view["zoom"]
    ys, xs = np.mgrid[0:ph, 0:pw]
    px, py = xs + 0.5, ys + 0.5
    lx, ly = px - ox, py - oy
    dx, dy = lx / z, ly / z
    inside = (dx >= 0) & (dy >= 0) & (dx < w) & (dy < h) & (px >= max(0, r["x"])) & (py >= max(0, r["y"])) \
        & (px < min(pw, r["x"] + r["w"])) & (py < min(ph, r["y"] + r["h"]))
    out = np.zeros((ph, pw, 4))
    ix = np.clip(np.floor(dx).astype(int), 0, w - 1)
    iy = np.clip(np.floor(dy).astype(int), 0, h - 1)
    chk = np.where(((np.floor(lx / 8).astype(int) + np.floor(ly / 8).astype(int)) & 1) == 0, 207 / 255, 1.0)
    c = doc_pre[iy, ix]
    rgb = c[..., :3] + chk[..., None] * (1 - c[..., 3:4])
    out[inside] = np.concatenate([rgb, np.ones((ph, pw, 1))], -1)[inside]
    return out


def test_view():
    S_w, S_h = 40, 30
    rng = np.random.default_rng(9)
    img = rng.integers(0, 256, (S_h, S_w, 4), dtype=np.uint8)
    img[..., 3] = np.where(rng.random((S_h, S_w)) < 0.5, 255, rng.integers(0, 256, (S_h, S_w)))
    setup(S_w, S_h)
    upload(1, img)
    apply([base_layer(), layer("a", slot=1)], S_w, S_h)
    td(PRELUDE + """
st = _st(); c = st.comp
w = c.create(constantTOP, "webrender"); w.par.outputresolution = "custom"; w.par.resolutionw = 200; w.par.resolutionh = 150
w.par.colorr = 0; w.par.colorg = 0; w.par.colorb = 0; w.par.alpha = 0
_emit(1)
""")
    pre = premul_f(img)
    worst = 0
    for view in (
        {"mode": "td", "zoom": 2.0, "panX": 15, "panY": 5, "rect": {"x": 10, "y": 20, "w": 160, "h": 100}},
        {"mode": "td", "zoom": 1.0, "panX": -7, "panY": 3, "rect": {"x": 0, "y": 0, "w": 200, "h": 150}},
        {"mode": "td", "zoom": 3.0, "panX": 40, "panY": 20, "rect": {"x": 5, "y": 5, "w": 190, "h": 140}},
    ):
        outp = os.path.join(WORK, "view.npy")
        td(PRELUDE + f"""
st = _st()
st.net.set_view(json.loads({json.dumps(json.dumps(view))}), 200, 150)
pv = st.net.panel_view()
pv.cook(force=True)
np.save({outp!r}, pv.numpyArray().astype(np.float32))
_emit({{"res": [pv.width, pv.height], "path": pv.path}})
""")
        got = np.load(outp)[::-1]
        ref = view_reference(pre, view, 200, 150)
        d = np.abs(got - ref) * 255
        worst = max(worst, d.max())
        print(f"  view zoom {view['zoom']}: max {d.max():.2f} mean {d.mean():.4f}  (non-transparent px {(got[..., 3] > 0).sum()})")
    check("view: panel_view places the document (zoom/pan/rect, top-left->bottom-left), checker under the doc only",
          worst <= 1.0, f"worst {worst:.2f}")
    # minification path (zoom < 1) runs and stays within the document rect
    view = {"mode": "td", "zoom": 0.5, "panX": 20, "panY": 10, "rect": {"x": 0, "y": 0, "w": 200, "h": 150}}
    outp = os.path.join(WORK, "view.npy")
    td(PRELUDE + f"""
st = _st()
st.net.set_view(json.loads({json.dumps(json.dumps(view))}), 200, 150)
pv = st.net.panel_view(); pv.cook(force=True)
np.save({outp!r}, pv.numpyArray().astype(np.float32))
_emit(1)
""")
    got = np.load(outp)[::-1]
    ys, xs = np.nonzero(got[..., 3] > 0)
    check("view: zoom 0.5 draws exactly the scaled document rect", (xs.min(), ys.min(), xs.max(), ys.max()) == (20, 10, 39, 24),
          f"bbox {(xs.min(), ys.min(), xs.max(), ys.max())}")


def test_persist():
    S = 32
    rng = np.random.default_rng(13)
    a = rng.integers(0, 256, (S, S, 4), dtype=np.uint8)
    b = rng.integers(0, 256, (S, S, 4), dtype=np.uint8)
    setup(S, S)
    upload(1, a)
    upload(2, b)
    layers = [base_layer(), layer("a", slot=1), layer("b", slot=2, blend="screen", opacity=0.6)]
    apply(layers, S, S)
    before = read_out(True)
    path = os.path.join(WORK, "persist.tox")
    r = td(PRELUDE + f"""
st = _st(); net = st.net
net.freeze()
locked = [bool(net.surface_top(s).lock) for s in net.slots()]
rl = net.read_locked()
st.comp.save({path!r})
net.thaw()
after_thaw = [bool(net.surface_top(s).lock) for s in net.slots()]
_emit({{"locked": locked, "slots": sorted(rl), "shape": list(rl[1].shape), "dtype": str(rl[1].dtype), "after_thaw": after_thaw}})
""")
    ok = r["locked"] == [True, True] and r["slots"] == [1, 2] and r["shape"] == [S, S, 4] and not any(r["after_thaw"])
    check("persist: freeze locks surfaces, read_locked returns float32 (h,w,4), thaw unlocks", ok, json.dumps(r))
    # numerical check of read_locked content
    pre = premul_f(a)[::-1]
    got = td(PRELUDE + f"""
st = _st(); net = st.net
net.freeze(); rl = net.read_locked(); np.save({os.path.join(WORK, 'rl1.npy')!r}, rl[1]); net.thaw(); _emit(1)
""")
    rl = np.load(os.path.join(WORK, "rl1.npy"))
    check("persist: read_locked == uploaded premultiplied pixels (TD row order)", np.abs(rl - pre).max() * 255 < 0.51,
          f"max {np.abs(rl - pre).max() * 255:.3f}")
    after = read_out(True)
    check("persist: output unchanged after freeze/thaw", np.abs(after - before).max() * 255 < 0.2, f"max {np.abs(after - before).max() * 255:.3f}")
    # tox round trip: load the saved tox into a fresh COMP, adopt with a new DocNetwork (no buffers!) and read locked pixels
    r = td(PRELUDE + f"""
p = op("/project1")
st = _st()
n = p.loadTox({path!r})
n.name = "_netdev_copy"
assert n.path == "/project1/_netdev_copy", n.path
doc = n.op("doc")
s1 = doc.op("s1")
rl = s1.numpyArray()
np.save({os.path.join(WORK, 'rl_tox.npy')!r}, rl)
info = {{"lock": bool(s1.lock), "children": sorted(c.name for c in doc.children)}}
# adopt the loaded network with a fresh DocNetwork: nothing may be created, locked surfaces stay locked
net2 = st.net_mod.DocNetwork(n, st.glsl)
net2.apply(json.loads({json.dumps(json.dumps(layers))}), {S}, {S})
s2 = net2.stats()
info["adopt_created"] = s2["last"]["created"]
info["adopt_locked"] = [bool(net2.surface_top(k).lock) for k in net2.slots()]
rl3 = net2.read_locked()
np.save({os.path.join(WORK, 'rl_adopt.npy')!r}, rl3[1])
n.destroy()
_emit(info)
""")
    rl2 = np.load(os.path.join(WORK, "rl_tox.npy"))
    check("persist: locked Script TOP pixels survive COMP.save + loadTox (s1 locked=%s)" % r["lock"],
          r["lock"] and np.abs(rl2 - pre).max() * 255 < 0.51, f"max {np.abs(rl2 - pre).max() * 255:.3f}; nodes {len(r['children'])}")
    rl3 = np.load(os.path.join(WORK, "rl_adopt.npy"))
    check("persist: a fresh DocNetwork adopts the loaded doc (0 nodes created, surfaces stay locked, pixels readable)",
          r["adopt_created"] == 0 and all(r["adopt_locked"]) and np.abs(rl3 - pre).max() * 255 < 0.51, json.dumps(r["adopt_locked"]) + f" created={r['adopt_created']}")


# --------------------------------------------------------------------------- checks: perf


def perf_doc(n_pixel=16, adjs=("levels", "hueSaturation", "brightnessContrast"), masks=3):
    """base + pixel layers (some masked) + adjustments interleaved: 1 + n_pixel + len(adjs) layers."""
    lays = [base_layer()]
    slot = 1
    mask_slots = []
    adj_defs = {
        "levels": {"type": "levels", "inLow": 0.05, "inHigh": 0.95, "gamma": 1.2, "outLow": 0.0, "outHigh": 1.0},
        "hueSaturation": {"type": "hueSaturation", "hue": 20, "saturation": 1.2, "value": 1.0},
        "brightnessContrast": {"type": "brightnessContrast", "brightness": 0.1, "contrast": 0.2},
        "blur": {"type": "blur", "radius": 8},
        "invert": {"type": "invert"},
        "threshold": {"type": "threshold", "level": 0.5},
    }
    every = max(1, n_pixel // max(1, len(adjs)))
    ai = 0
    modes = ("normal", "multiply", "screen", "overlay", "soft-light", "normal", "hue")
    for i in range(n_pixel):
        mask = None
        if len(mask_slots) < masks and i % 4 == 1:
            mask = {"slot": 100 + len(mask_slots), "enabled": True}
            mask_slots.append(100 + len(mask_slots))
        lays.append(layer(f"p{i}", slot=slot, blend=modes[i % len(modes)], opacity=0.8 + 0.01 * i,
                          x=(i * 3) % 40, y=(i * 5) % 30, mask=mask))
        slot += 1
        if ai < len(adjs) and i % every == every - 1:
            lays.append(layer(f"a{ai}", "adjustment", adjustment=adj_defs[adjs[ai]], opacity=0.9))
            ai += 1
    return lays, slot - 1, mask_slots


def settle(max_ticks=150):
    """Simulate frames: tick() until the housekeeping backlog (garbage, junk DATs, spare pool) is empty."""
    return td(PRELUDE + f"""
net = _st().net
n = 0
while n < {max_ticks}:
    s = net.stats()
    if not (s["garbage"] or s["junk"]) and s["pool"] >= 6 and not net._pending: break
    net.tick(); n += 1
_emit(n)
""", timeout=300)


def test_perf():
    W, H = 1920, 1080
    setup(W, H)
    lays, nslots, mask_slots = perf_doc()
    r = td(PRELUDE + f"""
st = _st(); rng = np.random.default_rng(1)
for s in list(range(1, {nslots} + 1)) + {mask_slots!r}:
    a = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
    st.buffers[s] = np.ascontiguousarray(np.tile(a, ({H} // 64 + 1, {W} // 64 + 1, 1))[:{H}, :{W}])
_emit(1)
""", timeout=300)
    st = apply(lays, W, H)
    print(f"  initial build of {len(lays)} layers @1080p: {st['ms']:.1f} ms, nodes {st['stats']['nodes']}")

    def gpu_cook():
        """GPU timer queries resolve a frame later: re-cook the whole chain once per td call and read the
        previous cook's gpuCookTime at the start of the next call."""
        code = PRELUDE + """
st = _st(); net = st.net
tops = [c for c in net.doc.children if c.isTOP]
kinds = ("glslTOP", "glslmultiTOP", "levelTOP", "hsvadjustTOP", "blurTOP", "thresholdTOP")
g = sum(c.gpuCookTime for c in tops if c.OPType in kinds)
cpu = sum(c.cookTime for c in tops)
by = {(c.comment or c.name): round(c.gpuCookTime, 3) for c in tops if c.gpuCookTime > 0.15}
net.surface_top(1).cook(force=True)          # dirties everything downstream of the bottom surface
net.output().cook(force=True)
_emit({"g": g, "cpu": cpu, "by": by})
"""
        rows = [td(code, timeout=120) for _ in range(30)][5:]
        gs = np.array([r["g"] for r in rows])
        return {"gpu_med": float(np.median(gs)), "gpu_max": float(gs.max()), "cpu_med": float(np.median([r["cpu"] for r in rows])),
                "gpu_by": rows[-1]["by"]}

    g = gpu_cook()
    check("perf: GPU cook, 20 layers incl. 3 adjustments + 3 masks @1080p < 4 ms (median of sum of node gpuCookTime)",
          g["gpu_med"] < 4.0, f"median {g['gpu_med']:.2f} ms, max {g['gpu_max']:.2f} ms; CPU cookTime sum {g['cpu_med']:.2f} ms")
    print("   heaviest nodes (ms):", g["gpu_by"])

    # blur variant
    lays2, ns2, ms2 = perf_doc(adjs=("levels", "blur", "threshold"))
    apply(lays2, W, H)
    g2 = gpu_cook()
    print(f"  with blur(radius 8) instead of hue/bc: gpu median {g2['gpu_med']:.2f} ms")
    lays3, _, _ = perf_doc(adjs=("levels", "blur", "invert"))
    lays3[[i for i, l in enumerate(lays3) if l['id'] == 'a1'][0]]["adjustment"] = {"type": "blur", "radius": 100}
    apply(lays3, W, H)
    g3 = gpu_cook()
    print(f"  with blur(radius 100): gpu median {g3['gpu_med']:.2f} ms")
    apply(lays, W, H)

    # --- apply() timings.  tick() is called a few times first, as the ext does each frame.
    def timed(label, new_layers, ticks=6):
        settle()
        ms = []
        for _ in range(1):
            ms.append(apply(new_layers, W, H)["ms"])
        return min(ms), label

    def prop_times(mutate, n=15):
        out = []
        cur = json.loads(json.dumps(lays))
        for i in range(n):
            mutate(cur, i)
            out.append(apply(cur, W, H)["ms"])
        return out

    def med(a):
        return float(np.median(a))

    import copy
    t_op = prop_times(lambda ls, i: ls[5].__setitem__("opacity", 0.3 + 0.04 * i))
    t_bl = prop_times(lambda ls, i: ls[6].__setitem__("blend", BLEND_MODES[i % 16]))
    t_vis = prop_times(lambda ls, i: ls[7].__setitem__("visible", i % 2 == 0))
    t_off = prop_times(lambda ls, i: ls[8].__setitem__("x", i))
    adj_i = [i for i, l in enumerate(lays) if l["kind"] == "adjustment"][0]
    t_adj = prop_times(lambda ls, i: ls[adj_i]["adjustment"].__setitem__("gamma", 1.0 + 0.05 * i))
    print(f"  apply() prop change (ms, median/max): opacity {med(t_op):.2f}/{max(t_op):.2f}  blend {med(t_bl):.2f}/{max(t_bl):.2f}  "
          f"visible {med(t_vis):.2f}/{max(t_vis):.2f}  offset {med(t_off):.2f}/{max(t_off):.2f}  adj param {med(t_adj):.2f}/{max(t_adj):.2f}")
    worst_prop = max(med(t_op), med(t_bl), med(t_vis), med(t_off), med(t_adj))
    check("perf: DocNetwork.apply prop change < 2 ms (median per kind)", worst_prop < 2.0 and max(t_op + t_bl + t_vis + t_off + t_adj) < 4.0,
          f"worst median {worst_prop:.2f} ms")
    t_same = [apply(lays, W, H)["ms"] for _ in range(5)]
    print(f"  apply() identical stack: {med(t_same):.3f} ms")

    # structural
    struct = {}
    cur = json.loads(json.dumps(lays))
    top_id = len(cur)
    new_px = layer("new1", slot=900, blend="multiply")
    new_px_mask = layer("new2", slot=901, mask={"slot": 902, "enabled": True})
    new_adj = layer("newadj", "adjustment", adjustment={"type": "levels", "inLow": 0.1, "inHigh": 0.9, "gamma": 1.1, "outLow": 0, "outHigh": 1})
    new_hue = layer("newhue", "adjustment", adjustment={"type": "hueSaturation", "hue": 30, "saturation": 1.1, "value": 1.0})
    seq = [("add pixel layer", cur + [new_px]),
           ("delete pixel layer", cur),
           ("add pixel layer + mask", cur + [new_px_mask]),
           ("delete pixel layer + mask", cur),
           ("add levels adjustment", cur + [new_adj]),
           ("delete levels adjustment", cur),
           ("add hue/sat adjustment", cur + [new_hue]),
           ("delete hue/sat adjustment", cur),
           ("add group + 2 children", cur + [layer("g1", "group"), layer("g1a", slot=910, parentId="g1"), layer("g1b", slot=911, parentId="g1")]),
           ("delete group + children", cur)]
    reorder = cur[:]
    reorder[3], reorder[4] = reorder[4], reorder[3]
    seq.append(("reorder two layers", reorder))
    seq.append(("reorder back", cur))
    for label, ls in seq:
        settle()
        r = apply(ls, W, H)
        struct[label] = r["ms"]
        print(f"  apply() {label:28s} {r['ms']:6.2f} ms   {json.dumps(r['stats']['last'])}")
    adds = [v for k, v in struct.items() if k.startswith(("add", "delete", "reorder"))]
    check("perf: DocNetwork.apply structural change (add/delete/reorder) < 10 ms", max(adds) < 10.0, f"worst {max(adds):.2f} ms")


# --------------------------------------------------------------------------- checks: transforms (v4)

XFORM_JS = r"""
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(({ cases, W, H }) => {
    const mk = (data, w, h, maskAlpha) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const px = new Uint8ClampedArray(data);
      if (maskAlpha) for (let i = 0; i < w * h; i++) { px[i * 4 + 3] = px[i * 4]; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255; }
      c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0); return c;
    };
    const res = [];
    for (const cs of cases) {
      const row = {};
      for (const q of ['low', 'medium', 'high']) {
        const src = mk(cs.src, cs.sw, cs.sh, false);
        const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
        const lx = layer.getContext('2d');
        lx.imageSmoothingEnabled = true; lx.imageSmoothingQuality = q;
        if (cs.A) lx.setTransform(cs.A[0], cs.A[2], cs.A[1], cs.A[3], cs.x, cs.y);
        const dr = (img) => cs.A ? lx.drawImage(img, 0, 0, cs.sw, cs.sh) : lx.drawImage(img, cs.x, cs.y, cs.sw * cs.sx, cs.sh * cs.sy);
        dr(src);
        if (cs.mask) {
          const m = mk(cs.mask, cs.sw, cs.sh, true);
          lx.globalCompositeOperation = 'destination-in';
          dr(m);
          lx.globalCompositeOperation = 'source-over';
        }
        const o = document.createElement('canvas'); o.width = W; o.height = H;
        const ox = o.getContext('2d'); ox.globalAlpha = cs.opacity; ox.drawImage(layer, 0, 0);
        row[q] = Array.from(ox.getImageData(0, 0, W, H).data);
      }
      res.push(row);
    }
    return res;
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})();
"""


def _affine(c):
    sys.path.insert(0, os.path.join(ROOT, "td", "tests"))
    import fakenet
    return fakenet.affine_forward(c["sx"], c["sy"], c.get("rot", 0.0), c.get("kx", 0.0), c.get("ky", 0.0))


def chromium_xform(cases, W, H):
    """Canvas 2D drawImage(smoothing) reference for each case -> list of {quality: premultiplied float (H, W, 4) 0..255}."""
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules", "playwright")):
        return None
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "ref.cjs")
        open(js, "w").write(XFORM_JS)
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        json.dump({"W": W, "H": H, "cases": [
            {"src": c["src"].ravel().tolist(), "sw": c["src"].shape[1], "sh": c["src"].shape[0],
             "mask": None if c.get("mask") is None else c["mask"].ravel().tolist(),
             "x": c["x"], "y": c["y"], "sx": c["sx"], "sy": c["sy"], "opacity": c.get("opacity", 1.0),
             "A": None if not any(k in c for k in ("rot", "kx", "ky")) else _affine(c).ravel().tolist()} for c in cases]},
            open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp], cwd=web, capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            print("chromium xform reference failed:", r.stderr[-500:])
            return None
        o = json.load(open(outp))
    return [{q: premul255(np.array(v, np.uint8).reshape(H, W, 4)) for q, v in row.items()} for row in o]


def xform_sources():
    rng = np.random.default_rng(11)
    noise = rng.integers(0, 256, (30, 40, 4), dtype=np.uint8)
    noise[..., 3] = 255
    yy, xx = np.mgrid[0:120, 0:160]
    smooth = np.zeros((120, 160, 4), np.uint8)       # photo-like: low frequencies + a soft (3 px) circular edge
    disc = 0.5 + 0.5 * np.tanh((30.0 - np.hypot(xx - 80.0, yy - 60.0)) / 1.5)
    smooth[..., 0] = 127 + 100 * np.sin(xx / 17.0) * np.cos(yy / 23.0) + 60 * disc
    smooth[..., 1] = 127 + 100 * np.cos(yy / 13.0) - 70 * disc
    smooth[..., 2] = 127 + 90 * np.sin((xx + yy) / 11.0)
    smooth[..., 3] = 255
    checker = np.zeros((120, 160, 4), np.uint8)      # hard-edged stress image (10 px checker)
    checker[..., 0] = 127 + 120 * np.sin(xx / 17.0)
    checker[..., 1] = 127 + 120 * np.cos(yy / 13.0)
    checker[..., 2] = np.where(((xx // 10) + (yy // 10)) % 2 == 0, 230, 40)
    checker[..., 3] = 255
    mask_a = rng.integers(0, 256, (30, 40, 4), dtype=np.uint8)
    mask_a[..., 1] = mask_a[..., 2] = mask_a[..., 0]
    mask_a[..., 3] = 255
    mask_b = np.zeros((120, 160, 4), np.uint8)
    mask_b[..., 0] = 128 + 127 * np.sin(xx / 9.0) * np.cos(yy / 11.0)
    mask_b[..., 1] = mask_b[..., 2] = mask_b[..., 0]
    mask_b[..., 3] = 255
    return noise, smooth, mask_a, mask_b, checker


def xform_cases():
    A, B, MA, MB, K = xform_sources()
    c = lambda name, src, x, y, sx, sy, kind, **kw: dict(name=name, src=src, x=x, y=y, sx=sx, sy=sy, kind=kind, **kw)
    return [
        c("int offset (7,-5) x1", A, 7, -5, 1.0, 1.0, "exact"),
        c("int offset (-3,40) x1", B[:60, :80].copy(), -3, 40, 1.0, 1.0, "exact"),
        c("frac offset (3.5,2.25) x1", A, 3.5, 2.25, 1.0, 1.0, "frac"),
        c("frac offset (0.3,-0.7) x1", A, 0.3, -0.7, 1.0, 1.0, "frac"),
        c("x2 at (5,4)", A, 5, 4, 2.0, 2.0, "up"),
        c("x3.7 at (-6.3,4.4)", A, -6.3, 4.4, 3.7, 3.7, "up"),
        c("sx2 sy0.5 at (10.5,20.25)", A, 10.5, 20.25, 2.0, 0.5, "mixed"),
        c("x0.5 at (3,3)", B, 3, 3, 0.5, 0.5, "down"),
        c("x0.25 at (10,10)", B, 10, 10, 0.25, 0.25, "down"),
        c("x0.5 at (3.5,3.25)", B, 3.5, 3.25, 0.5, 0.5, "down"),
        c("x0.3 at (-4.7,6.1)", B, -4.7, 6.1, 0.3, 0.3, "down"),
        c("sx0.5 sy1.5 at (8,-10)", B, 8, -10, 0.5, 1.5, "mixed"),
        c("sx0.5 sy0.25 at (2.5,3.5)", B, 2.5, 3.5, 0.5, 0.25, "down"),
        c("x0.1 at (1.5,2.5)", B, 1.5, 2.5, 0.1, 0.1, "down"),
        c("x0.72 at (1.3,2.7)", B, 1.3, 2.7, 0.72, 0.72, "down"),
        c("sx2 sy0.1 at (2.5,3.5)", B, 2.5, 3.5, 2.0, 0.1, "down"),
        c("[stress] noise x0.5 at (3.5,3.25)", np.tile(A, (2, 2, 1)), 3.5, 3.25, 0.5, 0.5, "stress"),
        c("[stress, hard edges] checker x0.5 at (3.5,3.25)", K, 3.5, 3.25, 0.5, 0.5, "stress"),
        c("[stress, hard edges] checker x0.3 at (-4.7,6.1)", K, -4.7, 6.1, 0.3, 0.3, "stress"),
        c("[stress, hard edges] checker x0.5 at (3,3)", K, 3, 3, 0.5, 0.5, "stress"),
        c("mask x2.5 at (4.5,3.25) op .8", A, 4.5, 3.25, 2.5, 2.5, "up", mask=MA, opacity=0.8),
        c("mask exact (6,5) x1", A, 6, 5, 1.0, 1.0, "exact", mask=MA),
        c("mask x0.5 at (4,4)", B, 4, 4, 0.5, 0.5, "down", mask=MB),
        # v5 affine: rotation clockwise on screen, skew kx / ky (degrees), about the surface's top-left
        c("rot 30 at (30,5)", B[:60, :80].copy(), 30, 5, 1.0, 1.0, "affine", rot=30.0),
        c("rot -50 at (45,40) x1.3", B[:60, :80].copy(), 45, 40, 1.3, 1.3, "affine", rot=-50.0),
        c("rot 90 at (70,5)", B[:60, :80].copy(), 70, 5, 1.0, 1.0, "affine", rot=90.0),
        c("rot 180 at (80,70)", B[:50, :60].copy(), 80, 70, 1.0, 1.0, "affine", rot=180.0),
        c("rot 12.5 sx1.5 sy0.8 at (8.25,4.5)", B[:40, :60].copy(), 8.25, 4.5, 1.5, 0.8, "affine", rot=12.5),
        c("skew kx 25 at (5,8)", B[:50, :60].copy(), 5, 8, 1.0, 1.0, "affine", kx=25.0),
        c("skew ky -20 at (6,40)", B[:50, :60].copy(), 6, 40, 1.0, 1.0, "affine", ky=-20.0),
        c("rot 20 kx 15 ky 8 sx1.2 at (20.5,10.5)", B[:40, :60].copy(), 20.5, 10.5, 1.2, 1.2, "affine", rot=20.0, kx=15.0, ky=8.0),
        c("rot 33 x0.5 at (30,4)", B, 30, 4, 0.5, 0.5, "affine-down", rot=33.0),
        c("rot 20 kx 20 x0.4 at (10,15)", B, 10, 15, 0.4, 0.4, "affine-down", rot=20.0, kx=20.0),
        c("mask rot 25 at (28,6) op .8", A, 28, 6, 2.0, 2.0, "affine", rot=25.0, mask=MA, opacity=0.8),
        c("mask rot -35 x0.6 at (45,45)", B, 45, 45, 0.6, 0.6, "affine-down", rot=-35.0, mask=MB),
        c("[stress, hard edges] checker rot 15 at (10,10)", K[:60, :80].copy(), 10, 10, 1.0, 1.0, "affine-stress", rot=15.0),
    ]


def test_xform():
    DW, DH = 96, 80
    setup(DW, DH)
    cases = xform_cases()
    chrome = chromium_xform(cases, DW, DH)
    if chrome is None:
        print("  (Chromium/Playwright unavailable: only the numpy comparison runs)")
    sys.path.insert(0, os.path.join(ROOT, "td", "tests"))
    import fakenet
    worst = {"exact": [0, 0], "frac": [0, 0], "up": [0, 0], "down": [0, 0], "mixed": [0, 0], "stress": [0, 0],
             "affine": [0, 0], "affine-down": [0, 0], "affine-stress": [0, 0]}
    affine_edge = []
    for i, cs in enumerate(cases):
        src = cs["src"]
        sh, sw = src.shape[:2]
        upload(1, src)
        rk = dict(rot=cs.get("rot", 0.0), kx=cs.get("kx", 0.0), ky=cs.get("ky", 0.0))
        lay = layer("a", slot=1, x=cs["x"], y=cs["y"], sx=cs["sx"], sy=cs["sy"], surfaceW=sw, surfaceH=sh,
                    opacity=cs.get("opacity", 1.0), **rk)
        if cs.get("mask") is not None:
            upload(2, cs["mask"])
            lay["mask"] = {"slot": 2, "enabled": True}
        apply([base_layer(), lay], DW, DH)
        out = read_out(True) * 255.0
        P = premul_f(src)
        ref = fakenet.sample_reference(P, DW, DH, cs["x"], cs["y"], cs["sx"], cs["sy"], **rk)
        if cs.get("mask") is not None:
            m = fakenet.sample_reference(cs["mask"][..., :1] / 255.0, DW, DH, cs["x"], cs["y"], cs["sx"], cs["sy"],
                                         coverage=False, **rk)
            ref = ref * m
        ref = ref * cs.get("opacity", 1.0) * 255.0
        # interior = every pixel whose footprint lies fully inside the source rect (coverage 1)
        jj, ii = np.mgrid[0:DH, 0:DW]
        lx, ly = (ii + 0.5 - cs["x"]) / cs["sx"], (jj + 0.5 - cs["y"]) / cs["sy"]
        hx, hy = 0.5 / cs["sx"], 0.5 / cs["sy"]
        inner = (lx - hx >= 0) & (lx + hx <= sw) & (ly - hy >= 0) & (ly + hy <= sh)
        if rk != dict(rot=0.0, kx=0.0, ky=0.0):
            cov_ = fakenet.coverage_supersampled(_affine(cs), cs["x"], cs["y"], sw, sh, DW, DH)
            full = cov_ == 1.0       # interior = footprints fully inside, one pixel away from any edge
            inner = full & np.roll(full, 1, 0) & np.roll(full, -1, 0) & np.roll(full, 1, 1) & np.roll(full, -1, 1)
        edge = ~inner & (np.abs(out).sum(-1) + np.abs(ref).sum(-1) > 0)
        dn = np.abs(out - ref)
        line = f"  [{cs['name']}] ({inner.sum()} interior, {edge.sum()} edge px)\n      TD vs numpy: interior max {dn[inner].max():.2f}"
        if edge.any():
            line += f", edge max {dn[edge].max():.2f}"
        if chrome is not None:
            parts = []
            for q in ("low", "medium", "high"):
                dc = np.abs(out - chrome[i][q]).max(-1)
                parts.append(f"{q}: int max {dc[inner].max():.1f} mean {dc[inner].mean():.2f}"
                             + (f" / edge max {dc[edge].max():.1f}" if edge.any() else ""))
            line += "\n      TD vs Chromium canvas  " + " | ".join(parts)
            k = cs["kind"]
            best = min(np.abs(out - chrome[i][q]).max(-1)[inner].max() for q in ("low", "medium"))
            worst[k][0] = max(worst[k][0], best)
        worst[cs["kind"]][1] = max(worst[cs["kind"]][1], dn[inner].max())
        if cs["kind"].startswith("affine") and edge.any():
            # edge pixels: TD's exact parallelogram coverage vs the numpy point-sampled coverage (and Chromium's AA)
            affine_edge.append(np.abs(out - ref).max(-1)[edge].max())
            line += f"\n      TD vs numpy edge pixels: max {affine_edge[-1]:.1f}, mean {np.abs(out - ref).max(-1)[edge].mean():.2f}"
        print(line)
        lim = 0.6 if cs["kind"] == "exact" else 2.5 if cs["kind"] in ("frac", "up", "mixed", "affine") else 6.0
        check(f"xform: TD vs numpy reference, {cs['name']}", dn[inner].max() < lim, f"interior max {dn[inner].max():.2f} (limit {lim})")
    if chrome is not None:
        check("xform: integer position at scale 1 vs Chromium canvas <= 3/255", worst["exact"][0] <= 3.0, f"{worst['exact'][0]:.1f}")
        for k in ("frac", "up", "mixed", "down"):
            check(f"xform: {k} interiors vs Chromium canvas (best of low/medium; 'high' is bicubic) <= 8/255", worst[k][0] <= 8.0,
                  f"{worst[k][0]:.1f}")
        check("xform: stress (hard-edged checker, noise) interiors vs Chromium canvas medium <= 8/255", worst["stress"][0] <= 8.0,
              f"{worst['stress'][0]:.1f}")
        check("xform: rotated / skewed interiors vs Chromium canvas (best of low/medium) <= 8/255", worst["affine"][0] <= 8.0,
              f"{worst['affine'][0]:.1f}")
        check("xform: rotated / skewed minified interiors vs Chromium canvas (best of low/medium) <= 10/255", worst["affine-down"][0] <= 10.0,
              f"{worst['affine-down'][0]:.1f}")
        check("xform: rotated hard-edged stress interiors vs Chromium canvas <= 20/255", worst["affine-stress"][0] <= 20.0,
              f"{worst['affine-stress'][0]:.1f}")
    if affine_edge:
        check("xform: rotated / skewed edge pixels vs the numpy point-sampled coverage <= 12/255 (32x32 sampling error)",
              max(affine_edge) <= 12.0, f"{max(affine_edge):.1f}")


def test_xform_base_and_flatten():
    """Base layer transform on a TD Input of its own resolution; render_layer_source() for Flatten."""
    sys.path.insert(0, os.path.join(ROOT, "td", "tests"))
    import fakenet
    DW, DH = 96, 80
    setup(DW, DH)
    A, B, MA, MB, K = xform_sources()
    src = B[:90, :120].copy()                       # the "TD Input": 120 x 90, not the document size
    sh, sw = src.shape[:2]
    path = os.path.join(WORK, "input_img.npy")
    np.save(path, np.ascontiguousarray(premul_f(src)[::-1].astype(np.float32)))
    td(PRELUDE + f"""
p = op("/project1")
for n in ("_netdev_src2", "_netdev_src2_cb"):
    if p.op(n): p.op(n).destroy()
s = p.create(scriptTOP, "_netdev_src2")
s.par.outputresolution = "custom"; s.par.resolutionw = {sw}; s.par.resolutionh = {sh}
cb = p.create(textDAT, "_netdev_src2_cb")
cb.text = "import numpy as np\\ndef onCook(scriptOp):\\n    scriptOp.copyNumpyArray(np.load({path!r}))\\n"
s.par.callbacks = cb
st = _st(); c = st.comp
c.create(inTOP, "in1")
c.inputConnectors[0].connect(s)
s.cook(force=True)
_emit([s.width, s.height])
""")
    cases = [dict(name="base identity", x=0, y=0, sx=1.0, sy=1.0, exact=True),
             dict(name="base moved (7,-5)", x=7, y=-5, sx=1.0, sy=1.0, exact=True),
             dict(name="base x0.6 at (5.5,-3.25)", x=5.5, y=-3.25, sx=0.6, sy=0.6, exact=False),
             dict(name="base x1.4 at (-10,6.5)", x=-10, y=6.5, sx=1.4, sy=1.4, exact=False),
             dict(name="base sx0.5 sy0.3 at (0,0)", x=0, y=0, sx=0.5, sy=0.3, exact=False)]
    chrome = chromium_xform([dict(src=src, x=c["x"], y=c["y"], sx=c["sx"], sy=c["sy"]) for c in cases], DW, DH)
    P = premul_f(src)
    for i, cs in enumerate(cases):
        lay = layer("base", "base", x=cs["x"], y=cs["y"], sx=cs["sx"], sy=cs["sy"], surfaceW=sw, surfaceH=sh)
        apply([lay], DW, DH)
        out = read_out(True) * 255.0
        ref = fakenet.sample_reference(P, DW, DH, cs["x"], cs["y"], cs["sx"], cs["sy"]) * 255.0
        jj, ii = np.mgrid[0:DH, 0:DW]
        lx, ly = (ii + 0.5 - cs["x"]) / cs["sx"], (jj + 0.5 - cs["y"]) / cs["sy"]
        inner = (lx - 0.5 / cs["sx"] >= 0) & (lx + 0.5 / cs["sx"] <= sw) & (ly - 0.5 / cs["sy"] >= 0) & (ly + 0.5 / cs["sy"] <= sh)
        dn = np.abs(out - ref).max(-1)
        msg = f"vs numpy interior max {dn[inner].max():.2f}"
        ok = dn[inner].max() < (0.6 if cs["exact"] else 2.5)
        if chrome is not None:
            dc = np.abs(out - chrome[i]["medium"]).max(-1)
            msg += f", vs Chromium(medium) interior max {dc[inner].max():.1f}"
            ok = ok and dc[inner].max() <= (3.0 if cs["exact"] else 8.0)
        check(f"xform: {cs['name']} (input {sw}x{sh} in a {DW}x{DH} document)", ok, msg)
    r = td(PRELUDE + "o = _st().net.output(); _emit([o.width, o.height])")
    check("xform: output is document sized, independent of the input", r == [DW, DH], str(r))
    td(PRELUDE + "st = _st(); st.comp.inputConnectors[0].disconnect(); _emit(1)")
    apply([layer("base", "base", x=3, y=3, sx=0.5, sy=0.5)], DW, DH)
    out = read_out(True)
    check("xform: base without input is transparent", out.max() == 0, f"max {out.max()}")
    td(PRELUDE + """
p = op("/project1")
for n in ("_netdev_src2", "_netdev_src2_cb"):
    if p.op(n): p.op(n).destroy()
_emit(1)
""")

    # ---- flatten: render_layer_source == the layer alone, unaffected by opacity / mask / blend / visibility
    setup(DW, DH)
    rng = np.random.default_rng(2)
    upload(1, rng.integers(0, 256, (DH, DW, 4), dtype=np.uint8))
    upload(9, np.concatenate([np.repeat(rng.integers(0, 256, (DH, DW, 1), dtype=np.uint8), 3, -1), np.full((DH, DW, 1), 255, np.uint8)], -1))
    rect = {"type": "rect", "x": 10.0, "y": 8.0, "w": 50.0, "h": 40.0, "radius": 6, "fill": fill_(), "stroke": stroke_(w=4), "rotation": 12}
    ts = text_spec(size=24.0, text="Flatten me", x=6.0, y=30.0)
    noisy = dict(opacity=0.3, blend="multiply", visible=False, mask={"slot": 9, "enabled": True})
    full = [base_layer(), layer("p", slot=1, surfaceW=DW, surfaceH=DH),
            shape_layer("sh", dict(rect), **noisy), text_layer("tx", dict(ts), **noisy)]
    plain = [base_layer(), shape_layer("sh", dict(rect)), text_layer("tx", dict(ts))]
    flat_path = os.path.join(WORK, "flat.npy")
    for lid, kind in (("sh", "shape"), ("tx", "text")):
        apply(full, DW, DH)
        settle()
        t = td(PRELUDE + f"""
net = _st().net
for _ in range(3):
    if net.render_layer_ready({lid!r}): break
tok = net.render_layer_token({lid!r})
op_ = net.render_layer_source({lid!r})
op_.cook(force=True)
np.save({flat_path!r}, op_.numpyArray().astype(np.float32))
_emit({{"w": op_.width, "h": op_.height, "name": op_.name, "same": tok == net.render_layer_token({lid!r})}})
""")
        flat = np.load(flat_path)[::-1]
        only = [base_layer()] + [l for l in plain if l["id"] == lid]
        apply(only, DW, DH)
        ref = read_out(True)
        d = np.abs(flat - ref).max() * 255
        ink = int((ref[..., 3] > 0).sum())
        check(f"flatten: render_layer_source({kind}) = the layer alone at document size, premultiplied (hidden, opacity .3, multiply, masked)",
              t["w"] == DW and t["h"] == DH and ink > 50 and d < 1.5 and t['same'], f"{t['w']}x{t['h']} node {t['name']}, {ink} inked px, max diff {d:.2f}/255")


def _over(below, src):
    """premultiplied float source-over (normal blend)"""
    return src + below * (1.0 - src[..., 3:4])


def _input_script(n, arr_td_order):
    """In TOP ``in<n>`` inside the scratch COMP, fed by a Script TOP of the given premultiplied float image (TD row order)."""
    h, w = arr_td_order.shape[:2]
    path = os.path.join(WORK, f"input_{n}.npy")
    np.save(path, np.ascontiguousarray(arr_td_order.astype(np.float32)))
    td(PRELUDE + f"""
p = op("/project1")
for nm in ("_netdev_src{n}", "_netdev_src{n}_cb"):
    if p.op(nm): p.op(nm).destroy()
s = p.create(scriptTOP, "_netdev_src{n}")
s.par.outputresolution = "custom"; s.par.resolutionw = {w}; s.par.resolutionh = {h}
cb = p.create(textDAT, "_netdev_src{n}_cb")
cb.text = "import numpy as np\\ndef onCook(scriptOp):\\n    scriptOp.copyNumpyArray(np.load({path!r}))\\n"
s.par.callbacks = cb
c = _st().comp
if not c.op("in{n}"): c.create(inTOP, "in{n}")
s.cook(force=True)
_emit([s.width, s.height])
""")


def _connect_input(n, on=True):
    td(PRELUDE + f"""
c = _st().comp
n = {n}
if {on!r}:
    c.inputConnectors[n - 1].connect(op("/project1/_netdev_src" + str(n)))
else:
    c.inputConnectors[n - 1].disconnect()
_emit(1)
""")


def test_inputs():
    """v6 multiple inputs: three In TOPs of different sizes, several input layers (transform / rotation / mask / blend),
    a disconnected input stays transparent and keeps its placement on reconnection; compared with the numpy reference."""
    sys.path.insert(0, os.path.join(ROOT, "td", "tests"))
    import fakenet
    DW, DH = 96, 80
    setup(DW, DH)
    A, B, MA, MB, K = xform_sources()
    imgs = {1: B[:90, :120].copy(), 2: A.copy(), 3: K[:50, :70].copy()}
    for n, im in imgs.items():
        _input_script(n, premul_f(im)[::-1])
    for n in (1, 2, 3):
        _connect_input(n)
    upload(7, MB[:50, :70].copy())
    mask3 = {"slot": 7, "enabled": True}
    specs = [
        dict(id="i1", input=1, x=-8.0, y=-5.0, sx=0.8, sy=0.8),
        dict(id="i2", input=2, x=30.5, y=10.25, sx=2.0, sy=2.0, rot=20.0),
        dict(id="i3", input=3, x=40.0, y=35.0, sx=0.9, sy=0.9, rot=-15.0, kx=10.0, opacity=0.8, blend="normal", mask=mask3),
    ]

    def layers(skip=()):
        return [layer(sp["id"], "input", **{k: v for k, v in sp.items() if k != "id"},
                      surfaceW=imgs[sp["input"]].shape[1], surfaceH=imgs[sp["input"]].shape[0])
                for sp in specs if sp["id"] not in skip]

    def reference(skip=()):
        acc = np.zeros((DH, DW, 4))
        edge = np.zeros((DH, DW), bool)
        for sp in specs:
            if sp["id"] in skip:
                continue
            im = imgs[sp["input"]]
            P = premul_f(im)
            kw = dict(rot=sp.get("rot", 0.0), kx=sp.get("kx", 0.0), ky=sp.get("ky", 0.0))
            r = fakenet.sample_reference(P, DW, DH, sp["x"], sp["y"], sp["sx"], sp["sy"], **kw)
            if sp.get("mask"):
                r = r * fakenet.sample_reference(MB[:50, :70, :1] / 255.0, DW, DH, sp["x"], sp["y"], sp["sx"], sp["sy"], coverage=False, **kw)
            r = r * sp.get("opacity", 1.0)
            acc = _over(acc, r)
            cov = fakenet.coverage_supersampled(fakenet.affine_forward(sp["sx"], sp["sy"], **kw), sp["x"], sp["y"], im.shape[1], im.shape[0], DW, DH)
            e = (cov > 0) & (cov < 1)
            edge |= e | np.roll(e, 1, 0) | np.roll(e, -1, 0) | np.roll(e, 1, 1) | np.roll(e, -1, 1)
        return acc * 255.0, edge

    def compare(label, skip=()):
        apply(layers(skip), DW, DH)
        out = read_out(True) * 255.0
        ref, edge = reference(skip)
        d = np.abs(out - ref).max(-1)
        check(f"inputs: {label}: TD vs numpy (non-edge pixels)", d[~edge].max() < 3.5,
              f"max {d[~edge].max():.2f} over {int((~edge).sum())} px ({int((ref[..., 3] > 0).sum())} inked)")
        return out

    r = td(PRELUDE + "st = _st(); _emit([[bool(i.connections) for i in st.comp.inputConnectors]])")
    print("  COMP input connectors connected:", r)
    full = compare("3 input layers (120x90, 40x30, 70x50 sources; rotation, skew, mask, opacity)")
    st = td(PRELUDE + "_emit(_st().net.stats())")
    check("inputs: one src_in<N> Select per referenced input, selects of the connected inputs", st["by_type"].get("selectTOP") == 3,
          json.dumps(st["by_type"]))
    td(PRELUDE + "_emit(1)")
    _connect_input(2, False)
    apply(layers(), DW, DH)
    out = read_out(True) * 255.0
    ref, edge = reference(skip=("i2",))
    d = np.abs(out - ref).max(-1)
    check("inputs: disconnected input 2 renders transparent (the other layers are untouched)", d[~edge].max() < 3.5, f"max {d[~edge].max():.2f}")
    nx = td(PRELUDE + "_emit(['xf_L_i2' in _st().net._ops, str(_st().net._ops['src_in2'].par.top.val)])")
    check("inputs: no resample pass for a disconnected input, its select points at blank", nx == [False, "blank"], str(nx))
    _connect_input(2, True)
    apply(layers(), DW, DH)
    again = read_out(True) * 255.0
    check("inputs: reconnecting restores the same placement (spec unchanged)", np.abs(again - full).max() < 0.5, f"max {np.abs(again - full).max():.2f}")
    # input 3 swaps resolution (placement kept, new size is picked up by the resample pass)
    _input_script(3, premul_f(K[:60, :100])[::-1].copy())
    imgs[3] = K[:60, :100].copy()
    apply(layers(), DW, DH)
    out = read_out(True) * 255.0
    check("inputs: an input changing resolution is resampled at its new size", np.abs(out - full).max() > 5.0)
    # blend mode between two inputs
    imgs[3] = K[:50, :70].copy()
    _input_script(3, premul_f(imgs[3])[::-1].copy())
    apply([layer("a", "input", input=1, surfaceW=120, surfaceH=90), layer("b", "input", input=3, blend="multiply", x=5.0, y=5.0, surfaceW=70, surfaceH=50)], DW, DH)
    o = read_out(True)
    P1 = fakenet.sample_reference(premul_f(imgs[1]), DW, DH, 0, 0, 1.0, 1.0)
    P3 = fakenet.sample_reference(premul_f(imgs[3]), DW, DH, 5, 5, 1.0, 1.0)
    exp = P1.copy()
    inside = P3[..., 3] > 0
    mult = P1[..., :3] * P3[..., :3]            # opaque sources: multiply == product of straight colours
    exp[inside, :3] = mult[inside]
    check("inputs: blend modes apply between input layers (multiply)", np.abs(o[..., :3] - exp[..., :3])[inside].max() * 255 < 2.5,
          f"max {np.abs(o[..., :3] - exp[..., :3])[inside].max() * 255:.2f}")
    # movable / deletable: delete an input layer, the select for its input goes away
    apply(layers(skip=("i1", "i3")), DW, DH)
    ks = td(PRELUDE + "_emit(sorted(n for n in _st().net._ops if n.startswith('src_in')))")
    check("inputs: deleting input layers drops their selects", ks == ["src_in2"], str(ks))
    td(PRELUDE + """
p = op("/project1")
for n in (1, 2, 3):
    for nm in ("_netdev_src%d" % n, "_netdev_src%d_cb" % n):
        if p.op(nm): p.op(nm).destroy()
_emit(1)
""")


def test_effects_net():
    """Effects wiring on the live GPU: chain nodes compile and cook, exact / rotated / masked layers, shape effects,
    parameter edits, removal back to the pool."""
    sys.path.insert(0, os.path.join(ROOT, "td", "tests"))
    import fakenet
    DW, DH = 96, 80
    setup(DW, DH)
    A, B, MA, MB, K = xform_sources()
    src = B[:50, :60].copy()
    sh, sw = src.shape[:2]
    upload(1, src)
    upload(2, MB[:50, :60].copy())
    P = premul_f(src)
    blue = {"r": 0, "g": 0, "b": 255, "a": 255}
    ov = {"type": "colorOverlay", "enabled": True, "opacity": 1.0, "color": blue}

    def chain_errors():
        return td(PRELUDE + """
net = _st().net
errs = []
for lid, ch in net._chains.items():
    for n in ch.nodes:
        n.cook(force=True)
        e = n.errors(recurse=False)
        if e: errs.append([n.name, e])
_emit(errs)
""")

    # 1. integer offset + overlay: the exact path through the staged resample pass
    apply([layer("a", slot=1, x=7, y=5, surfaceW=sw, surfaceH=sh, effects=[ov])], DW, DH)
    out = read_out(True) * 255.0
    ref = fakenet.sample_reference(P, DW, DH, 7, 5, 1.0, 1.0)
    exp = np.concatenate([np.zeros_like(ref[..., :2]), ref[..., 3:4], ref[..., 3:4]], -1) * 255.0       # blue * alpha
    d = np.abs(out - exp).max()
    check("effects: colour overlay on an integer-offset pixel layer (staged exact resample + chain)", d < 2.0, f"max {d:.2f}")
    check("effects: no GPU errors in the chain nodes", chain_errors() == [], str(chain_errors()))
    # 2. rotated + masked + overlay at 0.6 opacity (mask applied BEFORE the effect)
    ov2 = dict(ov, opacity=0.6)
    lay = layer("a", slot=1, x=30.5, y=10.25, sx=1.3, sy=1.3, rot=25.0, surfaceW=sw, surfaceH=sh, mask={"slot": 2, "enabled": True}, effects=[ov2])
    apply([lay], DW, DH)
    out = read_out(True) * 255.0
    kw = dict(rot=25.0)
    r = fakenet.sample_reference(P, DW, DH, 30.5, 10.25, 1.3, 1.3, **kw)
    m = fakenet.sample_reference(MB[:50, :60, :1] / 255.0, DW, DH, 30.5, 10.25, 1.3, 1.3, coverage=False, **kw)
    cont = r * m
    k = 0.6
    exp = np.concatenate([cont[..., :3] * (1 - k), cont[..., 3:4]], -1)
    exp[..., 2] += k * cont[..., 3]
    cov = fakenet.coverage_supersampled(fakenet.affine_forward(1.3, 1.3, **kw), 30.5, 10.25, sw, sh, DW, DH)
    e = (cov > 0) & (cov < 1)
    e = e | np.roll(e, 1, 0) | np.roll(e, -1, 0) | np.roll(e, 1, 1) | np.roll(e, -1, 1)
    d = np.abs(out - exp * 255.0).max(-1)
    check("effects: rotated + masked pixel layer, overlay 60% (content masked first)", d[~e].max() < 3.5, f"max {d[~e].max():.2f}")
    # 3. drop shadow on a shape with a mask: shadow below, offset, no blur
    shadow = {"type": "dropShadow", "enabled": True, "blur": 0.0, "dx": 9.0, "dy": 6.0, "opacity": 1.0, "color": {"r": 0, "g": 0, "b": 0, "a": 255}}
    rect = {"type": "rect", "x": 10.0, "y": 8.0, "w": 30.0, "h": 24.0, "radius": 0, "fill": fill_(), "stroke": stroke_(on=False), "rotation": 0}
    apply([shape_layer("s", dict(rect), effects=[shadow])], DW, DH)
    out = read_out(True)
    solid = out[16, 20]            # inside the rect
    sh_only = out[36, 45]          # inside the shifted rect (x 19..49, y 14..38), outside the original (x 10..40, y 8..32)
    none = out[60, 80]
    check("effects: drop shadow below a shape (offset 9,6): content on top, black shadow outside it, nothing elsewhere",
          solid[3] > 0.99 and solid[0] > 0.8 and sh_only[3] > 0.99 and sh_only[:3].max() < 0.01 and none[3] == 0.0,
          f"content {np.round(solid, 2)}, shadow-only {np.round(sh_only, 2)}, outside {np.round(none, 2)}")
    check("effects: shape chain nodes compile (no GPU errors)", chain_errors() == [], str(chain_errors()))
    # 4. edits, removal
    st0 = td(PRELUDE + "_emit(_st().net.stats())")
    r = apply([shape_layer("s", dict(rect), effects=[dict(shadow, dx=12.0)])], DW, DH)
    check("effects: a parameter edit creates / destroys / rewires nothing", r["stats"]["last"]["created"] == 0 and r["stats"]["last"]["connects"] == 0
          and r["stats"]["last"]["destroyed"] == 0 and 0 < r["stats"]["last"]["par_sets"] <= 4, json.dumps(r["stats"]["last"]))
    r = apply([shape_layer("s", dict(rect), effects=[dict(shadow, enabled=False)])], DW, DH)
    out2 = read_out(True)
    check("effects: all effects disabled -> chain removed, shape renders plain", r["stats"]["fx_chains"] == 0 and out2[36, 45, 3] == 0.0,
          f"fx_chains {r['stats']['fx_chains']}, pixel {out2[36, 45]}")
    settle()
    # a recycled effect node must serve a normal blend again (vector names restored)
    apply([layer("a", slot=1, x=7, y=5, surfaceW=sw, surfaceH=sh, blend="multiply"), layer("b", slot=1, x=20, y=15, surfaceW=sw, surfaceH=sh,
           adjustment=None)], DW, DH)
    adj_l = layer("adj", "adjustment", adjustment={"type": "invert"})
    apply([layer("a", slot=1, x=7, y=5, surfaceW=sw, surfaceH=sh), adj_l], DW, DH)
    out3 = read_out(True)
    ref3 = fakenet.sample_reference(P, DW, DH, 7, 5, 1.0, 1.0)
    inside = ref3[..., 3] > 0.99
    straight = ref3[..., :3]
    check("effects: nodes recycled from a removed chain work as plain blend / adjustment nodes", np.abs(out3[..., :3] - (1 - straight))[inside].max() * 255 < 2.0,
          f"max {np.abs(out3[..., :3] - (1 - straight))[inside].max() * 255:.2f}")


def test_effects_perf():
    W, H = 1920, 1080
    setup(W, H)
    td(PRELUDE + f"""
st = _st(); rng = np.random.default_rng(1)
a = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
st.buffers[1] = np.ascontiguousarray(np.tile(a, ({H} // 64 + 1, {W} // 64 + 1, 1))[:{H}, :{W}])
_emit(1)
""", timeout=300)
    shadow = {"type": "dropShadow", "enabled": True, "blur": 8.0, "dx": 6.0, "dy": 6.0, "opacity": 0.7, "color": {"r": 0, "g": 0, "b": 0, "a": 255}}
    ov = {"type": "colorOverlay", "enabled": True, "opacity": 0.5, "color": {"r": 255, "g": 0, "b": 0, "a": 255}}

    def gpu():
        code = PRELUDE + """
net = _st().net
tops = [c for c in net.doc.children if c.isTOP]
g = sum(c.gpuCookTime for c in tops if c.OPType in ("glslTOP", "glslmultiTOP"))
net.surface_top(1).cook(force=True)
net.output().cook(force=True)
_emit({"g": g})
"""
        rows = [td(code, timeout=120)["g"] for _ in range(24)][6:]
        return float(np.median(rows))
    mk = lambda fx, rot=0.0: [layer("a", slot=1, x=3.0, y=2.0, rot=rot, surfaceW=W, surfaceH=H, effects=fx)]
    res = {}
    for label, ls in (("no effects", mk([])), ("colour overlay", mk([ov])), ("drop shadow r8 (2 passes)", mk([shadow])),
                      ("shadow + overlay, rotated 12 deg", mk([shadow, ov], 12.0))):
        apply(ls, W, H)
        settle()
        res[label] = gpu()
        print(f"  GPU cook, one full-size layer @1080p, {label:34s}: median {res[label]:.2f} ms")
    times = []
    cur = mk([shadow, ov])
    apply(cur, W, H)
    for i in range(20):
        cur[0]["effects"][0] = dict(shadow, dx=6.0 + i, opacity=0.5 + 0.02 * i)
        times.append(apply(json.loads(json.dumps(cur)), W, H)["ms"])
    check("effects perf: apply() for an effect parameter edit < 1 ms (median)", float(np.median(times)) < 1.0,
          f"{np.median(times):.2f} ms (max {max(times):.2f})")
    times = []
    for i in range(10):
        ls = mk([shadow, ov] if i % 2 == 0 else [])
        times.append(apply(ls, W, H)["ms"])
        settle()
    print(f"  apply() add/remove effect chain (3 passes): median {np.median(times):.2f} ms max {max(times):.2f} ms")
    check("effects perf: apply() adding / removing a 3-pass chain < 10 ms (pooled nodes)", max(times) < 10.0, f"max {max(times):.2f} ms")


def test_xform_perf():
    W, H = 1920, 1080
    setup(W, H)
    n = 16
    td(PRELUDE + f"""
st = _st(); rng = np.random.default_rng(1)
a = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
big = np.ascontiguousarray(np.tile(a, ({H} // 64 + 1, {W} // 64 + 1, 1))[:{H}, :{W}])
for s in list(range(1, {n} + 1)) + [100, 101, 102]:
    st.buffers[s] = big
_emit(1)
""", timeout=300)

    def doc(mode):
        ls = [base_layer()]
        for i in range(n):
            kw = dict(slot=i + 1, surfaceW=W, surfaceH=H, blend=("normal", "multiply", "screen")[i % 3], opacity=0.9)
            if mode == "int-offset":
                kw.update(x=(i * 3) % 40, y=(i * 5) % 30)
            elif mode == "bilinear":
                kw.update(x=(i * 3) % 40 + 0.5, y=(i * 5) % 30 + 0.25, sx=1.0 + 0.02 * i, sy=1.0 + 0.02 * i)
            elif mode == "mip":
                kw.update(x=(i * 3) % 40 + 0.5, y=(i * 5) % 30 + 0.25, sx=0.45, sy=0.45)
            elif mode == "rotated":      # v5 affine: every layer rotated (+ some skew), parallelogram coverage on every pixel
                kw.update(x=(i * 3) % 40 + 0.5, y=(i * 5) % 30 + 0.25, sx=1.0 + 0.02 * i, sy=1.0 + 0.02 * i,
                          rot=5.0 + 2.0 * i, kx=(8.0 if i % 3 == 0 else 0.0))
            if i % 4 == 1:
                kw["mask"] = {"slot": 100 + i // 4 % 3, "enabled": True}
            ls.append(layer(f"p{i}", **kw))
        return ls

    def gpu_cook():
        code = PRELUDE + """
st = _st(); net = st.net
tops = [c for c in net.doc.children if c.isTOP]
g = sum(c.gpuCookTime for c in tops if c.OPType in ("glslTOP", "glslmultiTOP"))
net.surface_top(1).cook(force=True)
net.output().cook(force=True)
_emit({"g": g})
"""
        rows = [td(code, timeout=120)["g"] for _ in range(30)][8:]
        return float(np.median(rows)), float(max(rows))

    res = {}
    for mode in ("identity", "int-offset", "bilinear", "mip", "rotated"):
        apply(doc(mode), W, H)
        settle()
        res[mode] = gpu_cook()
        print(f"  GPU cook, {n} full-size pixel layers (4 masked) @1080p, {mode:10s}: median {res[mode][0]:.2f} ms  max {res[mode][1]:.2f} ms")
    over = (res["bilinear"][0] - res["int-offset"][0]) / n
    check("xform perf: a resample pass (bilinear, full-size layer @1080p) adds < 0.2 ms over the exact path",
          over < 0.2, f"{over:.3f} ms per layer ({res['bilinear'][0]:.2f} vs {res['int-offset'][0]:.2f} ms for 16 layers)")
    over_rot = (res["rotated"][0] - res["int-offset"][0]) / n
    check("xform perf: a rotated / skewed resample pass (full-size layer @1080p) adds < 0.35 ms over the exact path",
          over_rot < 0.35, f"{over_rot:.3f} ms per layer ({res['rotated'][0]:.2f} vs {res['int-offset'][0]:.2f} ms for 16 layers)")
    setup(W, H)
    td(PRELUDE + f"""
st = _st(); rng = np.random.default_rng(1)
a = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
big = np.ascontiguousarray(np.tile(a, ({H} // 64 + 1, {W} // 64 + 1, 1))[:{H}, :{W}])
for s in list(range(1, {n} + 1)) + [100, 101, 102]:
    st.buffers[s] = big
_emit(1)
""", timeout=300)
    # GPU timings on this machine jump between ~3.9 and ~5.8 ms for the SAME network (also without any minify), so
    # every state is measured in 4 interleaved cycles and compared by its best (minimum) median.
    def minified(k):
        ls = doc("bilinear")
        for i in range(k):
            ls[1 + (i * n) // k]["sx"] = ls[1 + (i * n) // k]["sy"] = 0.45
        return ls
    base_s, min4_s, min16_s, after_s = [], [], [], []
    for cyc in range(4):
        for k, bucket in ((0, base_s), (4, min4_s), (16, min16_s), (0, after_s)):
            apply(minified(k), W, H)
            settle()
            bucket.append(gpu_cook()[0])
        print(f"  cycle {cyc}: baseline {base_s[-1]:.2f}  4 minified {min4_s[-1]:.2f}  16 minified {min16_s[-1]:.2f}  after un-minify {after_s[-1]:.2f} ms")
    cost = (min(min16_s) - min(base_s)) / 16.0
    check("xform perf: GPU cost of a minified (mipmapped) full-size layer @1080p < 0.25 ms (best of 4)", cost < 0.25,
          f"{cost:.3f} ms per layer (16 minified {min(min16_s):.2f} vs {min(base_s):.2f} ms)")
    check("xform perf: after un-minifying, GPU cost is within the machine's 1.5 ms bimodal timing noise of the baseline (best of 4)",
          min(after_s) - min(base_s) < 1.5,
          f"baseline {min(base_s):.2f} -> after {min(after_s):.2f} ms")
    apply(doc("identity"), W, H)
    settle()
    ident = gpu_cook()[0]
    print(f"  GPU cook, identity transforms after all that (resample passes removed): {ident:.2f} ms")

    apply(doc("bilinear"), W, H)
    settle()

    def med(a):
        return float(np.median(a))

    def edit(mutate, k=20):
        cur = json.loads(json.dumps(doc("bilinear")))
        out = []
        for i in range(k):
            mutate(cur, i)
            out.append(apply(cur, W, H)["ms"])
        return out
    t_move = edit(lambda c, i: c[5].__setitem__("x", 10.0 + 0.25 * i))
    t_scale = edit(lambda c, i: (c[6].__setitem__("sx", 1.0 + 0.01 * i), c[6].__setitem__("sy", 1.0 + 0.01 * i)))
    t_drag = edit(lambda c, i: (c[7].__setitem__("sx", 0.9 - 0.02 * i), c[7].__setitem__("sy", 0.9 - 0.02 * i), c[7].__setitem__("x", i)))
    t_rot = edit(lambda c, i: (c[8].__setitem__("rot", 3.0 + 0.5 * i), c[8].__setitem__("kx", 0.25 * i)))
    t_rotmip = edit(lambda c, i: (c[9].__setitem__("rot", 3.0 + 4 * i), c[9].__setitem__("sx", 0.9 - 0.02 * i), c[9].__setitem__("sy", 0.9 - 0.02 * i)))
    print(f"  apply() rotate/skew edit (17 layers @1080p): rotate {med(t_rot):.2f}/{max(t_rot):.2f} ms, rotate+scale across the mip threshold "
          f"{med(t_rotmip):.2f}/{max(t_rotmip):.2f} ms")
    print(f"  apply() transform edit (17 layers @1080p): move {med(t_move):.2f}/{max(t_move):.2f} ms, scale {med(t_scale):.2f}/{max(t_scale):.2f} ms, "
          f"scale across the mip threshold {med(t_drag):.2f}/{max(t_drag):.2f} ms")
    worst = max(med(t_move), med(t_scale), med(t_drag), med(t_rot), med(t_rotmip))
    check("xform perf: apply() for a transform edit < 1 ms (median)", worst < 1.0, f"{worst:.2f} ms")


# --------------------------------------------------------------------------- checks: shapes (v3)

RED = {"r": 230, "g": 40, "b": 30, "a": 255}
BLUE = {"r": 20, "g": 60, "b": 220, "a": 200}
GREEN = {"r": 30, "g": 180, "b": 70, "a": 140}


def fill_(c=RED, on=True):
    return {"enabled": on, "color": c}


def stroke_(c=BLUE, w=6.0, on=True):
    return {"enabled": on, "color": c, "width": w}


def shape_layer(id_, spec, **kw):
    return layer(id_, "shape", shape=spec, text=None, **kw)


def text_layer(id_, spec, **kw):
    return layer(id_, "text", text=spec, shape=None, **kw)


def _rot(pts, cx, cy, deg):
    """Local = inverse clockwise (y-down) rotation about the centre."""
    t = np.radians(deg)
    d = pts - np.array([cx, cy])
    c, s = np.cos(t), np.sin(t)
    return np.stack([c * d[:, 0] + s * d[:, 1], -s * d[:, 0] + c * d[:, 1]], 1)


def _sd_round_box(l, h, r):
    r = min(r, min(h))
    q = np.abs(l) - np.array(h) + r
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(np.maximum(q[:, 0], q[:, 1]), 0) - r


def _seg_dist(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def _poly_sd(p, verts):
    """Exact signed distance (negative inside) of a simple polygon; even-odd for the sign."""
    n = len(verts)
    d = np.full(len(p), 1e9)
    inside = np.zeros(len(p), bool)
    for i in range(n):
        a, b = verts[i], verts[(i + 1) % n]
        d = np.minimum(d, _seg_dist(p, a, b))
        cond = ((a[1] > p[:, 1]) != (b[1] > p[:, 1])) & (
            p[:, 0] < (b[0] - a[0]) * (p[:, 1] - a[1]) / (b[1] - a[1] + 1e-30) + a[0])
        inside ^= cond
    return np.where(inside, -d, d)


def _in_tri(p, a, b, c):
    def sgn(p1, p2, p3):
        return (p1[:, 0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[:, 1] - p3[1])
    d1, d2, d3 = sgn(p, a, b), sgn(p, b, c), sgn(p, c, a)
    neg = (d1 < 0) | (d2 < 0) | (d3 < 0)
    pos = (d1 > 0) | (d2 > 0) | (d3 > 0)
    return ~(neg & pos)


def polygon_vertices(cx, cy, R, n, inner):
    """Document coordinates (y down): first outer vertex straight up, clockwise on screen."""
    m = n if inner >= 1.0 else 2 * n
    out = []
    for k in range(m):
        a = np.pi / 2 - k * 2 * np.pi / m
        r = R * inner if (m != n and k % 2 == 1) else R
        out.append((cx + r * np.cos(a), cy - r * np.sin(a)))
    return np.array(out)


def shape_masks(spec, pts):
    """(fill_mask, stroke_mask) booleans at document points (N, 2), y down, following web/src/engine/textShape.ts:
    exact geometry, the stroke is the band of half width w/2 around the outline (round joins)."""
    t = spec["type"]
    sw = spec.get("stroke", {}).get("width", 0.0) if spec.get("stroke", {}).get("enabled") else 0.0
    ho = sw / 2
    z = np.zeros(len(pts), bool)
    if t in ("rect", "ellipse"):
        cx, cy = spec["x"] + spec["w"] / 2, spec["y"] + spec["h"] / 2
        hw, hh = spec["w"] / 2, spec["h"] / 2
        l = _rot(pts, cx, cy, spec.get("rotation", 0.0))
        if t == "rect":
            r = min(spec.get("radius", 0.0), hw, hh)
            fill = _sd_round_box(l, (hw, hh), r) <= 0
            stroke = (np.abs(_sd_round_box(l, (hw, hh), r)) <= ho) if sw > 0 else z
            return fill, stroke
        th = np.linspace(0, 2 * np.pi, 721)[:-1]
        verts = np.stack([hw * np.cos(th), hh * np.sin(th)], 1)
        sd = _poly_sd(l, verts)
        return sd <= 0, (np.abs(sd) <= ho) if sw > 0 else z
    if t == "polygon":
        verts = polygon_vertices(spec["cx"], spec["cy"], spec["radius"], int(spec["sides"]), spec["innerRatio"])
        c = np.array([spec["cx"], spec["cy"]])
        l = _rot(pts, c[0], c[1], spec.get("rotation", 0.0)) + c
        sd = _poly_sd(l, verts)
        return sd <= 0, (np.abs(sd) <= ho) if sw > 0 else z
    if t == "line":
        # textShape.ts linePolys: shaft quad + arrowhead triangles, one union
        a = np.array([spec["x1"], spec["y1"]], float)
        b = np.array([spec["x2"], spec["y2"]], float)
        ln = float(np.linalg.norm(b - a))
        if ln <= 0 or not spec["stroke"]["enabled"]:
            return z, z
        u = (b - a) / ln
        n = np.array([-u[1], u[0]])
        both = spec.get("arrowStart") and spec.get("arrowEnd")
        H = min(max(8.0, 4 * sw), ln / 2 if both else ln)
        hwid = 0.4 * H
        t0 = H / 2 if spec.get("arrowStart") else 0.0
        t1 = ln - (H / 2 if spec.get("arrowEnd") else 0.0)
        m = z.copy()
        if sw > 0 and t1 > t0:
            q = pts - a
            lx, ly = q @ u, q @ n
            m |= (lx >= t0) & (lx <= t1) & (np.abs(ly) <= ho)
        if spec.get("arrowEnd"):
            m |= _in_tri(pts, b, b - u * H + n * hwid, b - u * H - n * hwid)
        if spec.get("arrowStart"):
            m |= _in_tri(pts, a, a + u * H + n * hwid, a + u * H - n * hwid)
        return z, m
    raise ValueError(t)


def shape_reference(spec, w, h, ss=16):
    """Premultiplied float (h, w, 4), top row first: supersampled (ss x ss) stroke-over-fill composite.  A 2x2
    coarse pass finds pixels whose 3x3 neighbourhood has any fractional coverage; only those get ss x ss."""
    ys, xs = np.mgrid[0:h, 0:w]

    def cover(sel, n):
        off = (np.arange(n) + 0.5) / n
        f = np.zeros(sel.sum())
        s_ = np.zeros(sel.sum())
        for oy in off:
            for ox in off:
                pts = np.stack([xs[sel] + ox, ys[sel] + oy], 1)
                fm, sm = shape_masks(spec, pts)
                f += fm
                s_ += sm
        return f / (n * n), s_ / (n * n)

    allp = np.ones((h, w), bool)
    fc, sc = (a.reshape(h, w) for a in cover(allp, 2))
    frac = ((fc > 0) & (fc < 1)) | ((sc > 0) & (sc < 1))
    for c in (fc, sc):                     # a boundary between two flat pixels may still be partial coverage
        dx = c[:, 1:] != c[:, :-1]
        dy = c[1:] != c[:-1]
        frac[:, 1:] |= dx; frac[:, :-1] |= dx
        frac[1:] |= dy; frac[:-1] |= dy
    unc = dilate3(dilate3(frac))
    f2, s2 = cover(unc, ss)
    fc[unc], sc[unc] = f2, s2
    fcol = spec.get("fill", {}).get("color", RED)
    scol = spec.get("stroke", {}).get("color", BLUE)
    if not spec.get("fill", {}).get("enabled") or spec["type"] == "line":
        fc[:] = 0
    if not spec.get("stroke", {}).get("enabled"):
        sc[:] = 0
    fa = fc * fcol["a"] / 255
    sa = sc * scol["a"] / 255
    out = np.zeros((h, w, 4))
    for i, k in enumerate("rgb"):
        out[..., i] = scol[k] / 255 * sa + fcol[k] / 255 * fa * (1 - sa)
    out[..., 3] = sa + fa * (1 - sa)
    return out, fc, sc


def dilate3(m):
    o = m.copy()
    o[1:] |= m[:-1]; o[:-1] |= m[1:]
    o[:, 1:] |= m[:, :-1]; o[:, :-1] |= m[:, 1:]
    o[1:, 1:] |= m[:-1, :-1]; o[:-1, :-1] |= m[1:, 1:]
    o[1:, :-1] |= m[:-1, 1:]; o[:-1, 1:] |= m[1:, :-1]
    return o


def shape_cases():
    box = dict(x=24.0, y=18.0, w=80.0, h=50.0)
    return [
        ("rect fill", {"type": "rect", **box, "radius": 0, "fill": fill_(), "stroke": stroke_(on=False), "rotation": 0}),
        ("rect radius+stroke", {"type": "rect", **box, "radius": 14, "fill": fill_(), "stroke": stroke_(w=6), "rotation": 0}),
        ("rect rot30 stroke", {"type": "rect", **box, "radius": 0, "fill": fill_(GREEN), "stroke": stroke_(w=5), "rotation": 30}),
        ("rect rot-70 radius", {"type": "rect", **box, "radius": 9, "fill": fill_(), "stroke": stroke_(w=3), "rotation": -70}),
        ("rect stroke only", {"type": "rect", **box, "radius": 6, "fill": fill_(on=False), "stroke": stroke_(w=8), "rotation": 0}),
        ("rect thick stroke > half", {"type": "rect", "x": 40, "y": 30, "w": 30, "h": 14, "radius": 0, "fill": fill_(), "stroke": stroke_(w=20), "rotation": 0}),
        ("ellipse fill+stroke", {"type": "ellipse", **box, "fill": fill_(), "stroke": stroke_(w=6), "rotation": 0}),
        ("ellipse rot25", {"type": "ellipse", "x": 20, "y": 20, "w": 90, "h": 36, "fill": fill_(GREEN), "stroke": stroke_(w=4), "rotation": 25}),
        ("ellipse stroke only", {"type": "ellipse", **box, "fill": fill_(on=False), "stroke": stroke_(w=5), "rotation": 0}),
        ("ellipse eccentric 120x6", {"type": "ellipse", "x": 4.0, "y": 45.0, "w": 120.0, "h": 6.0, "fill": fill_(), "stroke": stroke_(w=2), "rotation": 0}),
        ("ellipse eccentric 110x3 rot20", {"type": "ellipse", "x": 9.0, "y": 40.0, "w": 110.0, "h": 3.0, "fill": fill_(GREEN), "stroke": stroke_(w=1.5), "rotation": 20}),
        ("ellipse eccentric stroke only rot-15", {"type": "ellipse", "x": 6.0, "y": 36.0, "w": 116.0, "h": 8.0, "fill": fill_(on=False), "stroke": stroke_(w=3), "rotation": -15}),
        ("circle fill only", {"type": "ellipse", "x": 40, "y": 20, "w": 50, "h": 50, "fill": fill_(), "stroke": stroke_(on=False), "rotation": 0}),
        ("line", {"type": "line", "x1": 14, "y1": 20, "x2": 110, "y2": 70, "stroke": stroke_(w=4), "arrowStart": False, "arrowEnd": False}),
        ("line horizontal thick", {"type": "line", "x1": 14, "y1": 48, "x2": 114, "y2": 48, "stroke": stroke_(w=9), "arrowStart": False, "arrowEnd": False}),
        ("arrow end", {"type": "line", "x1": 14, "y1": 70, "x2": 110, "y2": 24, "stroke": stroke_(w=3), "arrowStart": False, "arrowEnd": True}),
        ("arrow both", {"type": "line", "x1": 20, "y1": 20, "x2": 108, "y2": 76, "stroke": stroke_(w=4), "arrowStart": True, "arrowEnd": True}),
        ("hexagon fill+stroke", {"type": "polygon", "cx": 64.0, "cy": 48.0, "radius": 36, "sides": 6, "innerRatio": 1.0, "fill": fill_(), "stroke": stroke_(w=4), "rotation": 0}),
        ("pentagon rot17 fill only", {"type": "polygon", "cx": 64.0, "cy": 48.0, "radius": 38, "sides": 5, "innerRatio": 1.0, "fill": fill_(GREEN), "stroke": stroke_(on=False), "rotation": 17}),
        ("star5 stroke", {"type": "polygon", "cx": 64.0, "cy": 50.0, "radius": 40, "sides": 5, "innerRatio": 0.45, "fill": fill_(), "stroke": stroke_(w=4), "rotation": 0}),
        ("star7 rot40 stroke only", {"type": "polygon", "cx": 64.0, "cy": 48.0, "radius": 42, "sides": 7, "innerRatio": 0.6, "fill": fill_(on=False), "stroke": stroke_(w=3), "rotation": 40}),
        ("triangle", {"type": "polygon", "cx": 64.0, "cy": 52.0, "radius": 34, "sides": 3, "innerRatio": 1.0, "fill": fill_(), "stroke": stroke_(w=5), "rotation": 0}),
        ("polygon 64 sides", {"type": "polygon", "cx": 64.0, "cy": 48.0, "radius": 40, "sides": 64, "innerRatio": 1.0, "fill": fill_(), "stroke": stroke_(on=False), "rotation": 0}),
    ]


SHAPE_GL_JS = r"""
// Runs shape.glsl in WebGL2 (GLSL ES 3.00 shim for the TD built-ins) for offline validation of the maths.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  const out = await page.evaluate(({ W, H, src, cases }) => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return { error: 'no webgl2' };
    const fsSrc = '#version 300 es\nprecision highp float;\nprecision highp int;\n#define TDOutputSwizzle(x) (x)\n' + src;
    const vsSrc = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }';
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const pr = gl.createProgram(); gl.attachShader(pr, mk(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const res = [];
    for (const u of cases) {
      for (const n of ['uParams','uOffset','uA','uB','uC']) gl.uniform4fv(gl.getUniformLocation(pr, n), u[n]);
      gl.viewport(0, 0, W, H); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      res.push(Array.from(px));
    }
    return { res };
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})();
"""


def shape_gl_render(specs, W, H):
    """Runs shape.glsl for each spec in headless Chromium WebGL2; returns premultiplied float (n, H, W, 4), top row
    first (like read_out(premultiplied=True)), or None when Playwright / WebGL2 is unavailable."""
    import network as netmod
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules", "playwright")):
        return None
    src = open(os.path.join(ROOT, "td", "raster_editor", "shape.glsl"), encoding="utf-8").read()
    cases = []
    for sp in specs:
        pars = netmod.shape_uniforms(sp, H)
        cases.append({n: [pars["vec%dvalue%s" % (i, k)] for k in "xyzw"]
                      for i, n in enumerate(("uParams", "uOffset", "uA", "uB", "uC"))})
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "gl.cjs")
        open(js, "w").write(SHAPE_GL_JS)
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        json.dump({"W": W, "H": H, "src": src, "cases": cases}, open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp], cwd=web, capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            print("  webgl run failed:", (r.stderr or r.stdout)[-800:])
            return None
        res = json.load(open(outp))
    if "res" not in res:
        print("  webgl unavailable:", res)
        return None
    imgs = np.array(res["res"], np.uint8).reshape(len(specs), H, W, 4)[:, ::-1].astype(np.float32) / 255
    return imgs   # premultiplied=False canvas: rgb are straight? readPixels of the default FB returns what was written


def compare_shape(out, spec, W, H, ref_pack):
    ref, fc, sc = ref_pack
    diff = np.abs(out - ref)
    flat = ((fc < 1e-6) | (fc > 1 - 1e-6)) & ((sc < 1e-6) | (sc > 1 - 1e-6))
    edge = dilate3(dilate3(~flat))
    interior = ~edge
    di = float(diff[interior].max()) * 255 if interior.any() else 0.0
    de = float(diff[edge].max()) * 255 if edge.any() else 0.0
    return di, de


def test_shapes_gl():
    """Offline (no TouchDesigner): shape.glsl in WebGL2 vs the numpy reference."""
    W, H = 128, 96
    cases = shape_cases()
    imgs = shape_gl_render([c[1] for c in cases], W, H)
    if imgs is None:
        check("shape.glsl offline (WebGL2) available", False, "playwright/WebGL2 unavailable")
        return
    for (name, spec), img in zip(cases, imgs):
        # the GL output is premultiplied values written as-is (blending off): rgb already premultiplied
        di, de = compare_shape(img, spec, W, H, shape_reference(spec, W, H))
        check(f"shape.glsl WebGL2 {name}: interior <= 3.5/255, edges <= 24/255", di <= 3.5 and de <= 24.0, f"interior {di:.1f}, edge {de:.1f}")


SHAPE_CANVAS_JS = r"""
// Port of drawShape / linePolys / polygonPoints from web/src/engine/textShape.ts: real Chromium Canvas 2D AA.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(({ W, H, specs }) => {
    const rgba = (c) => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
    const rad = (d) => (d * Math.PI) / 180;
    const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; } return a / 2; };
    const linePolys = (s) => {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy);
      if (!(len > 0)) return [];
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux, w = s.stroke.width;
      const both = s.arrowStart && s.arrowEnd;
      const Hh = Math.min(Math.max(8, 4 * w), both ? len / 2 : len), hw = 0.4 * Hh;
      const polys = [];
      const startAt = s.arrowStart ? Hh / 2 : 0, endAt = len - (s.arrowEnd ? Hh / 2 : 0);
      if (w > 0 && endAt > startAt) {
        const a = { x: s.x1 + ux * startAt, y: s.y1 + uy * startAt }, b = { x: s.x1 + ux * endAt, y: s.y1 + uy * endAt };
        polys.push([{ x: a.x + nx * w / 2, y: a.y + ny * w / 2 }, { x: b.x + nx * w / 2, y: b.y + ny * w / 2 },
          { x: b.x - nx * w / 2, y: b.y - ny * w / 2 }, { x: a.x - nx * w / 2, y: a.y - ny * w / 2 }]);
      }
      const head = (tx, ty, sx, sy) => { const bx = tx + sx * Hh, by = ty + sy * Hh;
        polys.push([{ x: tx, y: ty }, { x: bx - sy * hw, y: by + sx * hw }, { x: bx + sy * hw, y: by - sx * hw }]); };
      if (s.arrowEnd) head(s.x2, s.y2, -ux, -uy);
      if (s.arrowStart) head(s.x1, s.y1, ux, uy);
      return polys.map((p) => (area(p) < 0 ? p.slice().reverse() : p));
    };
    const polygonPoints = (s) => {
      const pts = [], star = s.innerRatio < 1, count = star ? s.sides * 2 : s.sides, step = star ? 180 / s.sides : 360 / s.sides;
      for (let j = 0; j < count; j++) { const a = rad(s.rotation - 90 + j * step); const r = star && j % 2 === 1 ? s.radius * s.innerRatio : s.radius;
        pts.push({ x: s.cx + Math.cos(a) * r, y: s.cy + Math.sin(a) * r }); }
      return pts;
    };
    const boxPath = (ctx, s) => {
      ctx.translate(s.x + s.w / 2, s.y + s.h / 2); ctx.rotate(rad(s.rotation));
      const hw = s.w / 2, hh = s.h / 2; ctx.beginPath();
      if (s.type === 'ellipse') { ctx.ellipse(0, 0, Math.max(0, hw), Math.max(0, hh), 0, 0, Math.PI * 2); return; }
      const r = Math.min(s.radius, hw, hh);
      if (r <= 0) { ctx.rect(-hw, -hh, s.w, s.h); return; }
      ctx.moveTo(-hw + r, -hh); ctx.arcTo(hw, -hh, hw, hh, r); ctx.arcTo(hw, hh, -hw, hh, r);
      ctx.arcTo(-hw, hh, -hw, -hh, r); ctx.arcTo(-hw, -hh, hw, -hh, r); ctx.closePath();
    };
    const draw = (ctx, s) => {
      ctx.save();
      if (s.type === 'line') {
        if (s.stroke.enabled) { ctx.fillStyle = rgba(s.stroke.color); ctx.beginPath();
          for (const p of linePolys(s)) { ctx.moveTo(p[0].x, p[0].y); for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); ctx.closePath(); }
          ctx.fill('nonzero'); }
        ctx.restore(); return;
      }
      if (s.type === 'polygon') { ctx.beginPath(); polygonPoints(s).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); }
      else boxPath(ctx, s);
      if (s.fill.enabled) { ctx.fillStyle = rgba(s.fill.color); ctx.fill(); }
      if (s.stroke.enabled && s.stroke.width > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = s.stroke.width; ctx.strokeStyle = rgba(s.stroke.color); ctx.stroke(); }
      ctx.restore();
    };
    return specs.map((s) => {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d'); draw(c, s);
      return Array.from(c.getImageData(0, 0, W, H).data);
    });
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})();
"""


def shape_canvas_render(specs, W, H):
    """Real Chromium Canvas 2D renders of drawShape: STRAIGHT uint8 rgba (n, H, W, 4) top-first, or None."""
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules", "playwright")):
        return None
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "sc.cjs")
        open(js, "w").write(SHAPE_CANVAS_JS)
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        json.dump({"W": W, "H": H, "specs": specs}, open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp], cwd=web, capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            print("  chromium canvas failed:", r.stderr[-500:])
            return None
        return np.array(json.load(open(outp)), np.uint8).reshape(len(specs), H, W, 4)


def canvas_premul(img_u8):
    """Straight uint8 canvas read-back -> premultiplied float (what the page composites)."""
    a = img_u8.astype(np.float32) / 255
    a[..., :3] *= a[..., 3:4]
    return a


def test_shapes_chromium():
    """Offline: shape.glsl (WebGL2) vs the REAL Chromium Canvas 2D rendering of the same specs (edge limit 24/255)."""
    W, H = 128, 96
    cases = shape_cases()
    specs = [c[1] for c in cases]
    gl = shape_gl_render(specs, W, H)
    cv = shape_canvas_render(specs, W, H)
    if gl is None or cv is None:
        check("shape.glsl vs Chromium canvas available", False, "playwright/WebGL2 unavailable")
        return
    worst = 0.0
    for (name, spec), g, c in zip(cases, gl, cv):
        cp = canvas_premul(c)
        d = np.abs(g - cp) * 255
        edge = (cp[..., 3] > 0) & (cp[..., 3] < 1) | ((g[..., 3] > 0) & (g[..., 3] < 1))
        mean_e = float(d[edge].mean()) if edge.any() else 0.0
        ex = shape_reference(spec, W, H)[0]
        dev = float(np.abs(ex - cp).max()) * 255           # Chromium vs the exact (supersampled) geometry
        worst = max(worst, d.max())
        # Skia's rasteriser deviates from exact coverage by up to ~0.26 itself (even for a 64-gon fill), so a smooth
        # SDF cannot reach 24/255 against it everywhere: gate: TD must be no further from Chromium than exact geometry is (+4), and the mean edge error small
        check(f"shape.glsl vs Chromium canvas {name}: max <= (Chromium vs exact)+4, mean edge <= 12 (/255)", d.max() <= dev + 4.0 and mean_e <= 12.0,
              f"max {d.max():.1f}, mean over edge pixels {mean_e:.2f}; Chromium vs exact geometry max {dev:.1f}")
    print(f"  worst TD(shader) vs Chromium canvas: {worst:.1f}/255")


WRAP_FIXTURE_JS = r"""
// Runs the REAL layoutText of web/src/engine/textShape.ts (bundled with vite) in Chromium and records every string
// it measures, so the python port (network.wrap_text) can be replayed against identical widths.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { build } = require('vite');
  const r = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: process.argv[4], formats: ['iife'], name: 'TS' } } });
  const bundle = (Array.isArray(r) ? r[0] : r).output[0].code;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle });
  const out = await page.evaluate((cases) => {
    const log = {};
    const orig = OffscreenCanvasRenderingContext2D.prototype.measureText;
    OffscreenCanvasRenderingContext2D.prototype.measureText = function (t) { const m = orig.call(this, t); log[t] = m.width; return m; };
    return cases.map((c) => {
      for (const k of Object.keys(log)) delete log[k];
      const spec = { text: c.text, font: c.font, size: c.size, color: { r: 0, g: 0, b: 0, a: 255 }, align: 'left', bold: !!c.bold,
        italic: !!c.italic, lineHeight: 1.2, x: 0, y: 0, boxWidth: c.boxWidth };
      const l = TS.layoutText(spec);
      return Object.assign({}, c, { lines: l.lines, widths: Object.assign({}, log) });
    });
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  await browser.close();
})();
"""


def wrap_fixture_cases():
    """Fixed, deterministic inputs of td/tests/wrap_vectors.json."""
    long = "The quick brown fox jumps over the lazy dog and keeps running far away"
    cases = []
    for font, bold, italic in (("Helvetica", False, False), ("Arial", True, False), ("Times New Roman", False, True), ("Courier New", False, False)):
        for size in (14.0, 24.0, 40.0):
            for box in (60.0, 120.0, 200.0, 333.0, 640.0):
                cases.append(dict(text=long, font=font, size=size, bold=bold, italic=italic, boxWidth=box))
    for box in (1.0, 50.0, 90.0, 400.0):
        cases += [
            dict(text="alpha beta\n\ngamma  delta   eps", font="Helvetica", size=20.0, bold=False, italic=False, boxWidth=box),
            dict(text="Supercalifragilisticexpialidocious is long", font="Arial", size=22.0, bold=False, italic=False, boxWidth=box),
            dict(text=" leading and trailing  ", font="Helvetica", size=18.0, bold=False, italic=False, boxWidth=box),
            dict(text="", font="Helvetica", size=18.0, bold=False, italic=False, boxWidth=box),
            dict(text="one\ntwo three\nfour five six", font="Menlo", size=16.0, bold=False, italic=False, boxWidth=box),
        ]
    return cases


def make_wrap_fixture(path=None):
    """Writes td/tests/wrap_vectors.json: the results of the real textShape.ts layoutText for ``wrap_fixture_cases()``
    plus the width of every string it measured.  The widths are MACHINE / FONT DEPENDENT (this Mac's fonts in
    Chromium): the pytest replay uses the recorded widths, so it checks the algorithm, not the fonts.  Regenerate
    with ``scripts/network_dev.py wrap-fixture`` only when textShape.ts layoutText changes."""
    web = os.path.join(ROOT, "web")
    path = path or os.path.join(ROOT, "td", "tests", "wrap_vectors.json")
    cases = wrap_fixture_cases()
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "wrap.cjs")
        open(js, "w").write(WRAP_FIXTURE_JS)
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        json.dump(cases, open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp, os.path.join(web, "src", "engine", "textShape.ts")], cwd=web,
                           capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            raise RuntimeError("wrap fixture failed: " + (r.stderr or r.stdout)[-1000:])
        res = json.load(open(outp))
    json.dump(res, open(path, "w"), indent=1, sort_keys=True)
    print(f"wrote {path}: {len(res)} cases")


def test_shapes():
    W, H = 128, 96
    setup(W, H)
    worst_edge = 0.0
    worst_int = 0.0
    for name, spec in shape_cases():
        apply([base_layer(), shape_layer("s", spec)], W, H)
        out = read_out(premultiplied=True)
        ref, fc, sc = shape_reference(spec, W, H)
        diff = np.abs(out - ref)
        flat = ((fc < 1e-6) | (fc > 1 - 1e-6)) & ((sc < 1e-6) | (sc > 1 - 1e-6))
        # an edge pixel is any pixel with fractional coverage or touching one
        edge = dilate3(dilate3(~flat))
        interior = ~edge
        di = float(diff[interior].max()) * 255 if interior.any() else 0.0
        de = float(diff[edge].max()) * 255 if edge.any() else 0.0
        worst_edge, worst_int = max(worst_edge, de), max(worst_int, di)
        check(f"shape {name}: interior <= 3.5/255, edges <= 24/255", di <= 3.5 and de <= 24.0, f"interior {di:.1f}, edge {de:.1f}")


# --------------------------------------------------------------------------- checks: text (v3)

TEXT_REF_JS = r"""
// Mirrors web/src/engine/textShape.ts layoutText + drawText (the conventions TD must match)
const { chromium } = require('playwright');
const fs = require('fs');
const ASCENT = 0.8;
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(({ W, H, specs, ASCENT }) => {
    const res = [];
    for (const s of specs) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const c = cv.getContext('2d', { willReadFrequently: true });
      const fam = s.font.includes(',') ? s.font : `"${s.font.replace(/"/g, '')}", sans-serif`;
      c.font = `${s.italic ? 'italic ' : ''}${s.bold ? 'bold ' : ''}${s.size}px ${fam}`;
      const width = (t) => c.measureText(t).width;
      const lines = [];
      for (const para of s.text.split('\n')) {
        if (s.boxWidth === null || para === '') { lines.push(para); continue; }
        const words = para.split(' ');
        let cur = words[0];
        for (let i = 1; i < words.length; i++) {
          const cand = cur + ' ' + words[i];
          if (width(cand) <= s.boxWidth) cur = cand; else { lines.push(cur); cur = words[i]; }
        }
        lines.push(cur);
      }
      const widths = lines.map(width);
      const blockW = s.boxWidth === null ? Math.max(0, ...widths) : s.boxWidth;
      const lineH = s.size * s.lineHeight;
      c.fillStyle = `rgba(${s.color.r},${s.color.g},${s.color.b},${s.color.a / 255})`;
      c.textAlign = s.align; c.textBaseline = 'alphabetic';
      const ax = s.align === 'left' ? s.x : s.align === 'center' ? s.x + blockW / 2 : s.x + blockW;
      const base = (lineH - s.size) / 2 + ASCENT * s.size;
      lines.forEach((l, i) => { if (l !== '') c.fillText(l, ax, s.y + i * lineH + base); });
      res.push({ lines, widths, blockW, lineH, data: Array.from(c.getImageData(0, 0, W, H).data) });
    }
    return res;
  }, inp);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})();
"""


def text_reference(specs, W, H):
    """Browser (Chromium Canvas 2D, textShape.ts conventions) renders: list of dict(lines, widths, blockW, lineH,
    rgba straight uint8 (H, W, 4)).  None when Playwright is not installed."""
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(os.path.join(web, "node_modules", "playwright")):
        return None
    with tempfile.TemporaryDirectory() as d:
        js = os.path.join(d, "tref.cjs")
        open(js, "w").write(TEXT_REF_JS)
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        json.dump({"W": W, "H": H, "specs": specs, "ASCENT": 0.8}, open(inp, "w"))
        env = dict(os.environ, NODE_PATH=os.path.join(web, "node_modules"))
        r = subprocess.run(["node", js, inp, outp], cwd=web, capture_output=True, text=True, timeout=180, env=env)
        if r.returncode != 0 or not os.path.exists(outp):
            print("  chromium text reference failed:", r.stderr[-400:])
            return None
        res = json.load(open(outp))
    for e in res:
        e["rgba"] = np.array(e["data"], np.uint8).reshape(H, W, 4)
        del e["data"]
    return res


def ink_bbox(alpha, thr=0.25):
    ys, xs = np.nonzero(alpha > thr)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def text_spec(**kw):
    d = {"text": "Hamburgefonstiv", "font": "Helvetica", "size": 32.0, "color": {"r": 255, "g": 255, "b": 255, "a": 255},
         "align": "left", "bold": False, "italic": False, "lineHeight": 1.2, "x": 20.0, "y": 14.0, "boxWidth": None}
    d.update(kw)
    return d


def text_cases():
    long = "The quick brown fox jumps over the lazy dog and keeps running"
    return [
        ("helvetica 32 left", text_spec()),
        ("helvetica 16", text_spec(size=16.0, x=7.0, y=5.0)),
        ("helvetica 64", text_spec(size=64.0, text="Wag", x=11.0, y=30.0)),
        ("arial bold", text_spec(font="Arial", bold=True)),
        ("times italic", text_spec(font="Times New Roman", italic=True, size=40.0)),
        ("courier new", text_spec(font="Courier New", size=28.0)),
        ("menlo 24", text_spec(font="Menlo", size=24.0, text="int main() {}")),
        ("2 lines lh 1.5", text_spec(text="First line\nSecond line", lineHeight=1.5)),
        ("3 lines lh 0.9", text_spec(text="aaa\nbbbbbb\ncc", lineHeight=0.9, size=28.0)),
        ("centre multiline", text_spec(text="Short\nA much longer line\nMid", align="center")),
        ("right multiline", text_spec(text="Short\nA much longer line\nMid", align="right")),
        ("wrap 300 left", text_spec(text=long, boxWidth=300.0, size=24.0)),
        ("wrap 300 centre", text_spec(text=long, boxWidth=300.0, size=24.0, align="center")),
        ("wrap 260 right bold", text_spec(font="Arial", text=long, boxWidth=260.0, size=22.0, align="right", bold=True)),
        ("wrap + newline lh 1.4", text_spec(text="alpha beta gamma delta\n\nepsilon zeta eta", boxWidth=180.0, size=20.0, lineHeight=1.4)),
        ("semi-transparent colour", text_spec(color={"r": 200, "g": 40, "b": 60, "a": 128})),
        ("overhang word", text_spec(text="Supercalifragilistic word", boxWidth=120.0, size=26.0)),
    ]


def test_text():
    W, H = 640, 360
    cases = text_cases()
    refs = text_reference([c[1] for c in cases], W, H)
    if refs is None:
        check("text: Chromium reference available", False, "playwright not installed in web/node_modules")
        return
    setup(W, H)
    worst_box = 0
    for (name, spec), ref in zip(cases, refs):
        apply([base_layer(), text_layer("t", spec)], W, H)
        outp = read_out()
        ra = ref["rgba"][..., 3].astype(np.float32) / 255
        bb_r, bb_t = ink_bbox(ra), ink_bbox(outp[..., 3])
        if bb_t is None or bb_r is None:
            check(f"text {name}", False, f"empty render (ref {bb_r}, td {bb_t})")
            continue
        dev = max(abs(a - b) for a, b in zip(bb_r, bb_t))
        mr, mt = ra > 0.5, outp[..., 3] > 0.5
        iou = float((mr & mt).sum() / max(1, (mr | mt).sum()))
        ta = outp[..., 3]
        soft = float(np.minimum(ra, ta).sum() / max(1e-9, np.maximum(ra, ta).sum()))      # coverage-weighted IoU
        ratio = float(ta.sum() / max(1e-9, ra.sum()))
        # colour (interior of glyphs): straight colour of the opaque pixels
        c = spec["color"]
        solid = outp[..., 3] > 0.9
        col_err = float(np.abs(outp[..., :3][solid] * 255 - np.array([c["r"], c["g"], c["b"]])).max()) if solid.any() and c["a"] == 255 else 0.0
        worst_box = max(worst_box, dev)
        check(f"text {name}: bbox +-2 px, coverage IoU >= 0.45 (design target 0.9 not reachable: Chromium stem-darkens glyphs, TD ink is 0.65-0.85x), colour", dev <= 2 and soft >= 0.45 and col_err <= 3,
              f"ref {bb_r} td {bb_t} dev {dev} IoU(alpha>.5) {iou:.3f} soft IoU {soft:.3f} ink ratio {ratio:.3f} colour err {col_err:.1f}")


def test_v3perf():
    """apply() timings for spec edits and GPU cost per text / shape layer @1080p."""
    W, H = 1920, 1080
    setup(W, H)
    star = {"type": "polygon", "cx": 900.0, "cy": 500.0, "radius": 300.0, "sides": 7, "innerRatio": 0.5,
            "fill": fill_(), "stroke": stroke_(w=8), "rotation": 10}
    rect = {"type": "rect", "x": 100.0, "y": 100.0, "w": 600.0, "h": 400.0, "radius": 40, "fill": fill_(), "stroke": stroke_(w=6), "rotation": 15}
    arrow = {"type": "line", "x1": 100.0, "y1": 900.0, "x2": 1600.0, "y2": 700.0, "stroke": stroke_(w=12), "arrowStart": True, "arrowEnd": True}
    ell = {"type": "ellipse", "x": 300.0, "y": 300.0, "w": 900.0, "h": 500.0, "fill": fill_(GREEN), "stroke": stroke_(w=10), "rotation": 30}
    shapes = [star, rect, arrow, ell]
    ts = text_spec(size=96.0, text="Hamburgefonstiv\nsecond line", x=100.0, y=100.0)

    def doc(n_shape=0, n_text=0):
        ls = [base_layer()]
        for i in range(n_shape):
            ls.append(shape_layer(f"s{i}", dict(shapes[i % 4])))
        for i in range(n_text):
            ls.append(text_layer(f"t{i}", dict(ts, y=100.0 + 20 * i, boxWidth=900.0 if i % 2 else None)))
        return ls

    def gpu(label, ls, kinds):
        apply(ls, W, H)
        settle()
        code = PRELUDE + """
st = _st(); net = st.net
tops = [c for c in net.doc.children if c.isTOP]
mine = [c for c in tops if (c.comment or c.name).startswith(%r) or c.name.startswith(%r)]
g = sum(c.gpuCookTime for c in mine); cpu = sum(c.cookTime for c in mine)
for c in mine:
    if c.OPType == "glslTOP": c.par.vec1valuex = c.par.vec1valuex.eval() + 0.01
    else: c.par.positionx = c.par.positionx.eval() + 0.01
net.output().cook(force=True)
_emit({"g": g, "cpu": cpu, "n": len(mine)})
""" % (kinds, kinds)
        rows = [td(code, timeout=120) for _ in range(24)][6:]
        return float(np.median([r["g"] for r in rows])), float(np.median([r["cpu"] for r in rows])), rows[-1]["n"]

    gs, cs, n = gpu("shapes", doc(8, 0), "shape_")
    check("v3 perf: GPU cost per shape layer @1080p < 0.75 ms", gs / max(1, n) < 0.75, f"{n} shape nodes: {gs:.3f} ms total, {gs / max(1, n):.3f} ms each (CPU {cs:.2f})")
    gt, ct, n = gpu("text", doc(0, 8), "text_")
    check("v3 perf: GPU cost per text layer @1080p < 0.5 ms", gt / max(1, n) < 0.5, f"{n} text nodes: {gt:.3f} ms total, {gt / max(1, n):.3f} ms each (CPU cook {ct / max(1, n):.2f} ms each)")

    # apply() timings
    base_doc = doc(4, 4)
    apply(base_doc, W, H)
    settle()

    def med(a):
        return float(np.median(a))

    def edit_times(mutate, n=15):
        cur = json.loads(json.dumps(base_doc))
        out = []
        for i in range(n):
            mutate(cur, i)
            out.append(apply(cur, W, H)["ms"])
        return out

    def find(cur, id_):
        return next(l for l in cur if l["id"] == id_)
    t_move = edit_times(lambda c, i: find(c, "s1")["shape"].__setitem__("x", 100.0 + i))
    t_rot = edit_times(lambda c, i: find(c, "s0")["shape"].__setitem__("rotation", 10.0 + i))
    t_col = edit_times(lambda c, i: find(c, "s3")["shape"]["fill"]["color"].__setitem__("r", 10 + i))
    t_tmove = edit_times(lambda c, i: find(c, "t0")["text"].__setitem__("x", 100.0 + i))
    t_tcol = edit_times(lambda c, i: find(c, "t0")["text"]["color"].__setitem__("g", 10 + i))
    t_ttxt = edit_times(lambda c, i: find(c, "t0")["text"].__setitem__("text", "Hamburgefonstiv\nsecond line " + "x" * (i % 3)))
    t_tbox = edit_times(lambda c, i: find(c, "t1")["text"].__setitem__("boxWidth", 700.0 + 10 * i))
    t_tsize = edit_times(lambda c, i: find(c, "t0")["text"].__setitem__("size", 96.0 + (i % 2)))     # alternates: 2nd+ hits the metrics cache
    for lab, a in (("shape move", t_move), ("shape rotate", t_rot), ("shape colour", t_col), ("text move", t_tmove),
                   ("text colour", t_tcol), ("text content (2-3 variants, cached)", t_ttxt), ("text box width drag", t_tbox),
                   ("text size (cached)", t_tsize)):
        print(f"  apply() {lab:38s} median {med(a):6.2f} ms  max {max(a):6.2f} ms")
    worst = max(med(a) for a in (t_move, t_rot, t_col, t_tmove, t_tcol, t_tbox, t_tsize))
    check("v3 perf: apply() for a text / shape spec edit < 2 ms (median)", worst < 2.0, f"worst median {worst:.2f} ms")

    # adding new layers
    settle()
    r = apply(doc(4, 4) + [shape_layer("new1", dict(rect))], W, H)
    print(f"  apply() add shape layer {r['ms']:.2f} ms")
    settle()
    r2 = apply(doc(4, 4) + [shape_layer("new1", dict(rect)), text_layer("newt", dict(ts))], W, H)
    print(f"  apply() add text layer (new font size measured) {r2['ms']:.2f} ms")
    check("v3 perf: adding a shape / text layer < 10 ms", max(r["ms"], r2["ms"]) < 10.0, f"{r['ms']:.2f} / {r2['ms']:.2f} ms")


# --------------------------------------------------------------------------- checks: v6 performance network (A/B vs v5)


def setup_legacy() -> None:
    """A second DocNetwork ``st.net2`` in /project1/_netdev/legacy with ``optimize=False`` (the v5 network: one 16 bit
    pass per layer) sharing the surface buffers of the stand-in extension -- the reference the v6 network is compared to."""
    raster_dir = os.path.join(ROOT, "td", "raster_editor")
    td(PRELUDE + f"""
st = _st()
c = op("/project1/_netdev")
c2 = c.create(baseCOMP, "legacy")
c2.par.parentshortcut = "RasterEditor"
c2.par.ext0object = "op('/project1/_netdev/ext_stub').module.Stub(me)"
c2.par.ext0name = "Stub"
c2.par.ext0promote = 1
c2.initializeExtensions()
st.net2 = st.net_mod.DocNetwork(c2, st.glsl, shape_glsl=open({os.path.join(raster_dir, 'shape.glsl')!r}, encoding="utf-8").read(), effects=st.fx_mod, effect_shaders=st.fx_shaders, optimize=False)
_emit("ok")
""")


def upload2(slot: int, straight_u8: np.ndarray) -> None:
    """upload() for both networks."""
    a = straight_u8.astype(np.float32) / 255.0
    pre = a.copy()
    pre[..., :3] *= a[..., 3:4]
    pre8 = np.rint(pre * 255).astype(np.uint8)[::-1]
    path = os.path.join(WORK, f"up_{slot}.npy")
    np.save(path, np.ascontiguousarray(pre8))
    td(PRELUDE + f"""
st = _st()
st.buffers[{slot}] = np.load({path!r})
for n in (st.net, st.net2):
    t = n.surface_top({slot})
    if t is not None: t.cook(force=True)
_emit("ok")
""")


def apply_both(layers, w, h, hints=None):
    """apply() on the v6 network (st.net, with the optional content-bounds hints) and the v5 network (st.net2)."""
    return td(PRELUDE + f"""
st = _st()
lay = json.loads({json.dumps(json.dumps(layers))})
hints = json.loads({json.dumps(json.dumps(hints))})
st.net.set_content_bounds({{k: (tuple(v) if v is not None else None) for k, v in (hints or {{}}).items()}})
st.net.apply(lay, {w}, {h})
st.net2.apply(lay, {w}, {h})
s1, s2 = st.net.stats(), st.net2.stats()
_emit({{"plan": s1["plan"], "nodes": s1["nodes"], "nodes2": s2["nodes"], "boxes": {{k: v for k, v in st.net._boxes.items()}}}})
""")


def read_both():
    pa, pb = os.path.join(WORK, "out_a.npy"), os.path.join(WORK, "out_b.npy")
    td(PRELUDE + f"""
st = _st()
for n, path in ((st.net, {pa!r}), (st.net2, {pb!r})):
    o = n.output(); o.cook(force=True)
    np.save(path, o.numpyArray().astype(np.float32))
_emit("ok")
""")
    return np.load(pa)[::-1].copy(), np.load(pb)[::-1].copy()


def test_v6():
    S = 96
    rng = np.random.default_rng(66)
    setup(S, S)
    setup_legacy()
    full_sizes = {}

    def surf(slot, w=S, h=S, alpha=True):
        img = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
        if not alpha:
            img[..., 3] = 255
        else:
            img[..., 3] = np.where(rng.random((h, w)) < 0.25, 0, img[..., 3])
        upload2(slot, img)
        full_sizes[slot] = (w, h)
        return img

    def gray(slot, w=S, h=S):
        m = np.zeros((h, w, 4), np.uint8)
        m[..., :3] = rng.integers(0, 256, (h, w, 1))
        m[..., 3] = 255
        upload2(slot, m)
        return m

    def compare(label, layers, tol, hints=None, expect=None):
        info = apply_both(layers, S, S, hints)
        a, b = read_both()
        d = np.abs(a - b) * 255.0
        pl = info["plan"]
        ok = d.max() <= tol
        if expect:
            for k, v in expect.items():
                ok = ok and pl.get(k) == v
        check(f"v6 {label}: v6 network vs v5 network <= {tol:g}/255", ok,
              f"max {d.max():.2f} mean {d.mean():.4f} | nodes {info['nodes']} (v5 {info['nodes2']}) passes {pl['passes']} merged {pl['merged']}/"
              f"{pl['merged_layers']} layers, skipped {pl['skipped']}, fmt8 {pl['fmt8']}, cropped {pl['cropped']}")
        return a, b

    # 1. a run of Normal layers (offsets, small surfaces, masks, opacity) -> merged passes
    lays = [base_layer()]
    for i in range(14):
        w, h = (S, S) if i % 3 == 0 else (int(rng.integers(20, 70)), int(rng.integers(20, 70)))
        surf(i + 1, w, h)
        mk = None
        if i % 4 == 1:
            gray(60 + i, w, h)
            mk = {"slot": 60 + i, "enabled": True}
        lays.append(layer(f"n{i}", slot=i + 1, surfaceW=w, surfaceH=h, x=int(rng.integers(-10, 40)), y=int(rng.integers(-10, 40)),
                          opacity=float(rng.choice([1.0, 0.8, 0.5])), mask=mk))
    compare("15 plain Normal layers (offsets, masks, opacity)", lays, 1.0, expect={"merged": 2, "passes": 2})

    # 2. every blend mode in one stack (the merged loop calls the same blend code, accumulating in float)
    modes = ("normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "darken", "lighten", "color-dodge",
             "color-burn", "difference", "exclusion", "hue", "saturation", "color", "luminosity")
    lays = [base_layer()]
    for i, m in enumerate(modes):
        surf(30 + i, S, S)
        lays.append(layer(f"m{i}", slot=30 + i, blend=m, opacity=0.6 + 0.4 * (i % 2)))
    compare("all 16 blend modes", lays, 3.0)

    # 3. skip rules: hidden, zero opacity, off canvas, no slot, no-op adjustments, empty group
    lays = [base_layer()]
    for i in range(6):
        surf(100 + i, 50, 40)
    lays += [layer("h", slot=100, visible=False), layer("z", slot=101, opacity=0.0), layer("far", slot=102, x=500, y=3, surfaceW=50, surfaceH=40),
             layer("noslot"), layer("ok1", slot=103, x=3, y=4, surfaceW=50, surfaceH=40),
             layer("nb", "adjustment", adjustment={"type": "blur", "radius": 0.0}), layer("nu", "adjustment", adjustment={"type": "mystery"}),
             layer("eg", "group"), layer("ok2", slot=104, x=30, y=20, surfaceW=50, surfaceH=40, blend="multiply", opacity=0.7)]
    a, b = compare("skipped layers (hidden, opacity 0, off canvas, no slot, no-op adjustments, empty group)", lays, 0.51)

    # 4. transformed layers: cropped resample passes (scale, rotation, skew, masks, effects off)
    lays = [base_layer()]
    for i in range(6):
        surf(120 + i, 40, 30)
    gray(130, 40, 30)
    xfs = [dict(x=5.5, y=4.25, sx=1.5, sy=1.5), dict(x=20.0, y=30.0, rot=30.0), dict(x=40.0, y=-5.0, sx=0.45, sy=0.45),
           dict(x=10.5, y=50.0, kx=25.0, sx=2.0, sy=1.2), dict(x=60.0, y=60.0, sx=1.0, sy=1.0, ky=-30.0), dict(x=-20.0, y=10.0, sx=3.0, sy=3.0)]
    for i, t in enumerate(xfs):
        lays.append(layer(f"x{i}", slot=120 + i, surfaceW=40, surfaceH=30, blend="normal" if i % 2 == 0 else "screen", opacity=0.9,
                          mask={"slot": 130, "enabled": True} if i == 3 else None, **t))
    compare("transformed layers -> cropped resample passes", lays, 1.5)
    # the same through the content-bounds hint: the surface content is confined to a sub-rect
    img = np.zeros((30, 40, 4), np.uint8)
    img[8:20, 10:30] = (200, 60, 90, 255)
    for i in (0, 3):
        upload2(120 + i, img)
    hint = {"x0": (10.0, 8.0, 30.0, 20.0), "x3": (10.0, 8.0, 30.0, 20.0)}
    a, b = compare("content-bounds hint (superset of the non-transparent pixels) on rescaled layers", lays, 1.0, hints=hint)
    info = apply_both(lays, S, S, hint)
    info0 = apply_both(lays, S, S, {})
    sm = {k: (v[2] - v[0]) * (v[3] - v[1]) for k, v in info["boxes"].items()}
    fu = {k: (v[2] - v[0]) * (v[3] - v[1]) for k, v in info0["boxes"].items()}
    check("v6 content-bounds hint: the resample passes of x0 / x3 are smaller than their full box",
          all(sm[k] < fu[k] for k in ("x0", "x3")), f"areas {sm['x0']} / {sm['x3']} vs {fu['x0']} / {fu['x3']}")

    # 5. groups inside merged runs + adjustments between runs + the 8 bit rule
    lays = [base_layer()]
    for i in range(10):
        surf(140 + i, S, S)
    lays += [layer("a0", slot=140), layer("g", "group", blend="multiply", opacity=0.7), layer("g0", slot=141, parentId="g"),
             layer("g1", slot=142, parentId="g", blend="screen"), layer("g2", slot=143, parentId="g"),
             layer("lv", "adjustment", adjustment={"type": "levels", "inLow": 0.05, "inHigh": 0.95, "gamma": 1.4, "outLow": 0.0, "outHigh": 1.0}),
             layer("a1", slot=144), layer("a2", slot=145, opacity=0.5), layer("a3", slot=146, blend="color-burn", opacity=0.9),
             layer("a4", slot=147), layer("a5", slot=148)]
    compare("group + adjustment + burn (16 bit below, 8 bit Normal tail)", lays, 3.0)
    lays = [base_layer(), layer("p", slot=140), layer("q", slot=141, opacity=0.5), layer("r", slot=142, opacity=0.3)]
    compare("pure Normal stack (every pass 8 bit)", lays, 1.0, expect={"fmt8": 1})

    # 5b. shapes: cropped shape nodes (geometry + stroke + arrowheads + antialiasing margin) vs the full-size v5 nodes
    red, blue = {"r": 230, "g": 40, "b": 30, "a": 255}, {"r": 20, "g": 60, "b": 220, "a": 200}
    fl, st_ = {"enabled": True, "color": red}, {"enabled": True, "color": blue, "width": 7.0}
    shapes = [
        {"type": "rect", "x": 10.0, "y": 8.0, "w": 40.0, "h": 24.0, "radius": 5.0, "fill": fl, "stroke": st_, "rotation": 25.0},
        {"type": "ellipse", "x": 50.0, "y": 40.0, "w": 36.0, "h": 20.0, "fill": fl, "stroke": {"enabled": False, "color": blue, "width": 0.0}, "rotation": -40.0},
        {"type": "line", "x1": 8.0, "y1": 80.0, "x2": 60.0, "y2": 70.0, "fill": {"enabled": False, "color": red}, "stroke": dict(st_, width=3.0),
         "arrowStart": True, "arrowEnd": True},
        {"type": "polygon", "cx": 70.0, "cy": 20.0, "radius": 18.0, "sides": 5, "innerRatio": 0.5, "fill": fl, "stroke": st_},
        {"type": "rect", "x": -10.0, "y": 60.0, "w": 30.0, "h": 50.0, "radius": 0.0, "fill": fl, "stroke": st_, "rotation": 0.0},
    ]
    lays = [base_layer(), layer("pl", slot=140, blend="multiply", opacity=0.8)]
    for i, sp in enumerate(shapes):
        lays.append(layer(f"sh{i}", "shape", shape=sp, blend="normal" if i % 2 == 0 else "overlay", opacity=0.9))
    compare("shape layers (cropped shape nodes: rect/ellipse/line+arrows/star, partly off canvas)", lays, 1.5, expect={"cropped": 5})

    # 6. blur pyramid vs numpy gaussian (edge hold) and vs the v5 Blur TOP
    worst = 0.0
    for S2, rad in ((256, 7.0), (256, 12.0), (256, 24.0), (512, 50.0), (512, 100.0), (512, 200.0)):
        img = np.zeros((S2, S2, 4), np.uint8)
        img[..., 3] = 255
        img[S2 // 4:3 * S2 // 4, S2 // 4:3 * S2 // 4, :3] = (230, 40, 40)
        img[S2 // 2:, S2 // 3:S2 // 2, :] = (30, 200, 255, 100)
        img[S2 // 8:S2 // 8 + 8, :, :3] = 255                      # a bright band (8 rows) next to the border, not on it
        img[S2 // 5:S2 // 5 + 2, 20:S2 - 20, :3] = 0               # 2 px dark line: the pyramid's worst case
        setup(S2, S2)
        setup_legacy()
        upload2(1, img)
        lays = [base_layer(), layer("b", slot=1), layer("adj", "adjustment", adjustment={"type": "blur", "radius": rad})]
        info = apply_both(lays, S2, S2)
        a, b = read_both()
        ref = ref_adjust({"type": "blur", "radius": rad}, premul_f(img), 1.0, None)
        # b is the v5 chain over an empty base: layer premultiplied then blurred
        d = np.abs(a - ref) * 255
        dl = np.abs(b - ref) * 255
        worst = max(worst, d.max())
        check(f"v6 blur pyramid radius {rad:g} @ {S2}^2 vs numpy gaussian (edge hold) <= 12/255 (v5 Blur TOP: max {dl.max():.1f})",
              d.max() <= 12.0, f"max {d.max():.2f} mean {d.mean():.4f}")
    # detail thinner than the shrink factor ON the document border (the padded shrink repeats the edge pixels exactly)
    for S2, rad in ((512, 100.0), (512, 200.0)):
        img = np.zeros((S2, S2, 4), np.uint8)
        img[..., 3] = 255
        img[:8, :, :3] = 255
        img[:, S2 - 3:, :3] = 255
        img[S2 // 2:, :5, :] = (30, 200, 255, 90)
        setup(S2, S2)
        setup_legacy()
        upload2(1, img)
        apply_both([base_layer(), layer("b", slot=1), layer("adj", "adjustment", adjustment={"type": "blur", "radius": rad})], S2, S2)
        a, b = read_both()
        ref = ref_adjust({"type": "blur", "radius": rad}, premul_f(img), 1.0, None)
        check(f"v6 blur pyramid radius {rad:g}: thin bands ON the document border vs numpy gaussian <= 12/255 (v5 Blur TOP {np.abs(b - ref).max() * 255:.1f})",
              np.abs(a - ref).max() * 255 <= 12.0, f"max {np.abs(a - ref).max() * 255:.2f}")
    setup(S, S)
    setup_legacy()


# --------------------------------------------------------------------------- main



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", nargs="?", default="all")
    ap.add_argument("--keep", action="store_true", help="leave /project1/_netdev in place")
    args = ap.parse_args()
    which = args.what
    try:
        if which in ("all", "blend"):
            test_blend()
            test_opacity_blend()
        if which in ("all", "adjust"):
            test_adjust()
        if which in ("all", "misc"):
            test_misc()
        if which in ("all", "xform"):
            test_xform()
        if which in ("all", "xform"):
            test_xform_base_and_flatten()
        if which in ("all", "inputs"):
            test_inputs()
        if which in ("all", "effects"):
            test_effects_net()
        if which in ("all", "xperf"):
            test_xform_perf()
        if which in ("all", "fxperf"):
            test_effects_perf()
        if which in ("all", "view"):
            test_view()
        if which in ("all", "persist"):
            test_persist()
        if which in ("all", "perf"):
            test_perf()
        if which in ("all", "shapes"):
            test_shapes()
        if which in ("all", "text"):
            test_text()
        if which in ("all", "v3perf"):
            test_v3perf()
        if which in ("all", "v6"):
            test_v6()
        if which == "wrap-fixture":
            make_wrap_fixture()
        if which == "shapes-chromium":
            test_shapes_chromium()
        if which == "shapes-gl":
            test_shapes_gl()
    finally:
        if not args.keep and which not in ("shapes-gl", "shapes-chromium", "wrap-fixture"):
            teardown()
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
