"""Live harness for td/raster_editor/network.py (blend.glsl + DocNetwork) inside TouchDesigner.

    .venv/bin/python scripts/network_dev.py [all|blend|adjust|misc|perf|view|persist] [--keep]

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
  perf    apply() timings and GPU cook time of a 20-layer 1080p document
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
    net_src = open(os.path.join(ROOT, "td", "raster_editor", "network.py"), encoding="utf-8").read()
    glsl_src = open(os.path.join(ROOT, "td", "raster_editor", "blend.glsl"), encoding="utf-8").read()
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
net_mod = _load("re_network", {net_src!r})
st = types.ModuleType("re_state"); sys.modules["re_state"] = st
st.buffers = {{}}
st.net_mod = net_mod
st.glsl = {glsl_src!r}
st.comp = c
st.net = net_mod.DocNetwork(c, {glsl_src!r})
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
             x=0, y=0, slot=None, mask=None, adjustment=None)
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
    check("misc: base layer takes COMP input 1 when connected (base_src -> ../in1)", d < 1.0, f"max {d:.2f}")
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
kinds = ("glslTOP", "levelTOP", "hsvadjustTOP", "blurTOP", "thresholdTOP")
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
        if which in ("all", "view"):
            test_view()
        if which in ("all", "persist"):
            test_persist()
        if which in ("all", "perf"):
            test_perf()
    finally:
        if not args.keep:
            teardown()
    bad = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
