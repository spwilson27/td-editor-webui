"""Live harness for the layer effects (shared/effects/*.glsl, td/raster_editor/effects.py, web/src/engine/effects).

    .venv/bin/python scripts/effects_dev.py [parity|perf|all] [--only NAME[,NAME]] [--keep] [--swiftshader]

parity  every effect (and a few stacks) is rendered by the SAME shader sources
          * in TouchDesigner: EffectChain (effects.py) inside the scratch COMP /project1/_fxdev, GLSL TOP chain
          * in headless Chromium (Playwright from web/): web/src/engine/effects bundled with ``vite build --lib``
        and compared in premultiplied 8 bit.  Pass criterion: max |diff| <= 3/255 (pixel sort: <= 3/255 except where two keys land on
        different sides of a quantisation step on another GPU (hue on SwiftShader: ~0.3% of pixels); allowed 0.5%).  Needs TouchDesigner (port 8765) and web/node_modules.
perf    GPU time per effect at 1920x1080: TD = sum of the chain's GLSL TOP ``gpuCookTime`` (min of 5 forced cooks),
        Chromium = gl.finish()-bracketed run of the same passes (Metal GPU via ANGLE; --swiftshader = software, slow).

Only /project1/_fxdev is created (and destroyed at the end unless --keep); nothing else in the project is touched and the
project is never saved.
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

import effects as fxpy  # noqa: E402
from td_call import run as td_run  # noqa: E402

SCRATCH = "/project1/_fxdev"
WORK = os.environ.get("FXDEV_WORK") or os.path.join(tempfile.gettempdir(), "fxdev_work")
os.makedirs(WORK, exist_ok=True)
TOL = 3.0          # /255
RESULTS: list[tuple[str, bool, str]] = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  " + detail if detail else ""))
    return bool(ok)


# --------------------------------------------------------------------------- test content


def test_image(w=256, h=160, seed=5):
    """Straight RGBA8 (h, w, 4), top row first: gradient ellipse (AA edge), translucent rect, noise patch, thin line."""
    rng = np.random.default_rng(seed)
    n = 4
    yy, xx = np.mgrid[0:h * n, 0:w * n]
    X, Y = (xx + 0.5) / n, (yy + 0.5) / n
    cov = ((X - w * 0.42) / (w * 0.30)) ** 2 + ((Y - h * 0.50) / (h * 0.36)) ** 2 <= 1
    cov = cov.reshape(h, n, w, n).mean((1, 3))
    gx = np.linspace(0, 1, w)[None, :].repeat(h, 0)
    gy = np.linspace(0, 1, h)[:, None].repeat(w, 1)
    hue = gx * 5.0
    rgb = np.stack([np.clip(np.abs(hue - 3) - 1, 0, 1), np.clip(2 - np.abs(hue - 2), 0, 1), np.clip(2 - np.abs(hue - 4), 0, 1)], -1)
    rgb = rgb * (0.25 + 0.75 * (1 - gy))[..., None]
    img = np.zeros((h, w, 4), np.float64)
    img[..., :3] = rgb
    img[..., 3] = cov
    # translucent rect
    img[int(h * 0.62):int(h * 0.92), int(w * 0.62):int(w * 0.92)] = [0.7, 0.2, 0.8, 0.5]
    # noise patch
    nz = rng.random((int(h * 0.25), int(w * 0.2), 1)).repeat(3, 2)
    img[int(h * 0.05):int(h * 0.05) + nz.shape[0], int(w * 0.75):int(w * 0.75) + nz.shape[1], :3] = nz
    img[int(h * 0.05):int(h * 0.05) + nz.shape[0], int(w * 0.75):int(w * 0.75) + nz.shape[1], 3] = 1
    # thin diagonal line
    for i in range(min(h, w) // 2):
        img[h - 6 - i, 4 + i:6 + i] = [1, 1, 0, 1]
    return np.rint(np.clip(img, 0, 1) * 255).astype(np.uint8)


def premult(straight_u8):
    a = straight_u8.astype(np.float64) / 255
    p = a.copy()
    p[..., :3] *= a[..., 3:4]
    return p  # float 0..1


C = lambda r, g, b, a=255: {"r": r, "g": g, "b": b, "a": a}  # noqa: E731
CASES = [
    ("colorOverlay", [{"enabled": True, "type": "colorOverlay", "color": C(30, 120, 255), "opacity": 0.6}]),
    ("dropShadow", [{"enabled": True, "type": "dropShadow", "dx": 9, "dy": 7, "blur": 12, "color": C(0, 0, 0, 230), "opacity": 0.8}]),
    ("dropShadow hard", [{"enabled": True, "type": "dropShadow", "dx": -6, "dy": 4, "blur": 0, "color": C(255, 0, 0), "opacity": 1}]),
    ("outerGlow", [{"enabled": True, "type": "outerGlow", "size": 14, "color": C(255, 220, 80), "opacity": 0.9}]),
    ("innerGlow", [{"enabled": True, "type": "innerGlow", "size": 12, "color": C(255, 255, 255), "opacity": 0.8}]),
    ("stroke outside", [{"enabled": True, "type": "stroke", "width": 6, "color": C(255, 0, 80), "position": "outside", "opacity": 1}]),
    ("stroke inside", [{"enabled": True, "type": "stroke", "width": 5, "color": C(0, 0, 0), "position": "inside", "opacity": 0.9}]),
    ("stroke centre", [{"enabled": True, "type": "stroke", "width": 9, "color": C(0, 200, 255), "position": "center", "opacity": 1}]),
    ("bevel", [{"enabled": True, "type": "bevel", "depth": 90, "size": 7, "angle": 120, "highlight": C(255, 255, 255, 230), "shadow": C(0, 0, 0, 200)}]),
    ("chromaticAberration", [{"enabled": True, "type": "chromaticAberration", "amount": 3.5, "angle": 30}]),
    ("halftone dot", [{"enabled": True, "type": "halftone", "cellSize": 7, "angle": 30, "shape": "dot"}]),
    ("halftone line", [{"enabled": True, "type": "halftone", "cellSize": 6, "angle": 70, "shape": "line"}]),
    ("glitch", [{"enabled": True, "type": "glitch", "amount": 45, "blockSize": 9, "seed": 11, "rgbShift": 3}]),
    ("pixelSort h luma", [{"enabled": True, "type": "pixelSort", "direction": "h", "low": 0.15, "high": 0.9, "key": "luma"}]),
    ("pixelSort v hue", [{"enabled": True, "type": "pixelSort", "direction": "v", "low": 0.0, "high": 1.0, "key": "hue"}]),
    ("stack shadow+stroke+overlay", [
        {"enabled": True, "type": "dropShadow", "dx": 6, "dy": 6, "blur": 8, "color": C(0, 0, 0), "opacity": 0.7},
        {"enabled": True, "type": "stroke", "width": 4, "color": C(255, 255, 255), "position": "outside", "opacity": 1},
        {"enabled": True, "type": "colorOverlay", "color": C(255, 120, 0), "opacity": 0.25}]),
]
PERF_EXTRA = [
    ("dropShadow blur 40", [{"enabled": True, "type": "dropShadow", "dx": 10, "dy": 10, "blur": 40, "color": C(0, 0, 0), "opacity": 1}]),
    ("stroke 64 outside", [{"enabled": True, "type": "stroke", "width": 64, "color": C(255, 0, 80), "position": "outside", "opacity": 1}]),
    ("bevel size 30", [{"enabled": True, "type": "bevel", "depth": 90, "size": 30, "angle": 120, "highlight": C(255, 255, 255), "shadow": C(0, 0, 0)}]),
]
PIXEL_SORT_NAMES = ("pixelSort h luma", "pixelSort v hue")


# --------------------------------------------------------------------------- TouchDesigner side

PRELUDE = '''
from td import *
import sys, types, json, time
import numpy as np
def _emit(o): print("@@" + json.dumps(o))
'''


def td(code, timeout=120):
    res = td_run(textwrap.dedent(code), timeout=timeout)
    out = res.get("stdout", "") or ""
    if not res.get("ok"):
        raise RuntimeError("TD error: " + (res.get("traceback") or json.dumps(res))[:3000] + "\n" + out[-2000:])
    ret = None
    for line in out.splitlines():
        if line.startswith("@@"):
            ret = json.loads(line[2:])
    return ret


def td_setup():
    texts = fxpy.load_shader_texts()
    fx_src = open(os.path.join(ROOT, "td", "raster_editor", "effects.py"), encoding="utf-8").read()
    td(PRELUDE + f'''
p = op("/project1")
if p.op("_fxdev"): p.op("_fxdev").destroy()
c = p.create(baseCOMP, "_fxdev")
s = c.create(scriptTOP, "src")
cb = c.op("src_callbacks")
pr = c.create(glslTOP, "probe")
pd = c.create(textDAT, "probe_px")
pd.text = "uniform vec4 uP3;\\nout vec4 fragColor;\\nvoid main() {{ fragColor = TDOutputSwizzle(texelFetch(sTD2DInputs[0], ivec2(0), 0) + vec4(uP3.w * 0.0)); }}\\n"
pr.par.pixeldat = "probe_px"
pr.par.outputresolution = "custom"; pr.par.resolutionw = 1; pr.par.resolutionh = 1
pr.par.format = "rgba32float"
pr.par.vec3name = "uP3"
cb.text = "def onCook(scriptOp):\\n    import sys\\n    scriptOp.copyNumpyArray(sys.modules['fxdev_state'].buf)\\n"
st = types.ModuleType("fxdev_state"); sys.modules["fxdev_state"] = st
st.buf = np.zeros((4, 4, 4), np.uint8)
m = types.ModuleType("fxdev_effects"); m.__dict__["__name__"] = "fxdev_effects"
exec(compile({fx_src!r}, "effects.py", "exec"), m.__dict__)
st.fx = m
st.texts = json.loads({json.dumps(json.dumps(texts))})
st.chain = None
_emit("ok")
''')


def td_teardown():
    td(PRELUDE + '''
p = op("/project1")
if p.op("_fxdev"): p.op("_fxdev").destroy()
sys.modules.pop("fxdev_state", None)
_emit("ok")
''')


def td_set_source(straight_u8):
    h, w, _ = straight_u8.shape
    pre = np.rint(premult(straight_u8) * 255).astype(np.uint8)[::-1]      # premultiplied, TD row order (bottom first)
    path = os.path.join(WORK, "src.npy")
    np.save(path, np.ascontiguousarray(pre))
    td(PRELUDE + f'''
st = sys.modules["fxdev_state"]
st.buf = np.load({path!r})
op("{SCRATCH}/src").cook(force=True)
_emit("ok")
''')


def td_render(effects, perf=False):
    """Builds the chain for ``effects`` in TD and returns (premultiplied float (h,w,4) top row first, info)."""
    outp = os.path.join(WORK, "td_out.npy")
    r = td(PRELUDE + f'''
st = sys.modules["fxdev_state"]
c = op("{SCRATCH}")
if st.chain is not None: st.chain.destroy()
st.chain = st.fx.EffectChain(c, "fx", st.texts)
src = c.op("src")
t0 = time.perf_counter()
out = st.chain.apply(json.loads({json.dumps(json.dumps(effects))}), src, 0, 0)
ms_build = (time.perf_counter() - t0) * 1e3
nodes = st.chain.nodes
for n in nodes: n.cook(force=True)
errs = []
for n in nodes:
    e = n.errors()
    if e: errs.append(n.name + ": " + e[:300])
a = out.numpyArray()
np.save({outp!r}, a.astype(np.float32))
info = {{"nodes": len(nodes), "build_ms": ms_build, "errors": errs, "fmt": out.par.format.eval()}}
if {perf!r}:
    # GPU time: dirty the chain (bump an unused uniform of its first node), then read back a 1x1 probe TOP behind it, which
    # forces every pass to run and finish; the same probe on the bare source gives the sync overhead to subtract.
    probe = c.op("probe")
    def timed(first, feed, n=12):
        ts = []
        for i in range(n):
            first.par.vec3valuew = 1e-6 * (i + 1) + (1e-3 if feed is src else 0.0)
            t = time.perf_counter()
            probe.inputConnectors[0].connect(feed)
            probe.cook(force=True)
            probe.numpyArray()
            ts.append((time.perf_counter() - t) * 1e3)
        ts.sort()
        return ts[len(ts) // 2]
    base = timed(probe, src)
    info["gpu_ms"] = max(0.0, timed(nodes[0], out) - base)
    info["sync_ms"] = base
_emit(info)
''', timeout=300)
    a = np.load(outp)[::-1].astype(np.float64)
    return a, r


# --------------------------------------------------------------------------- Chromium side

BUNDLE_CFG = """
export default {{
  root: {web!r},
  logLevel: 'error',
  build: {{
    lib: {{ entry: {entry!r}, name: 'RasterFx', formats: ['iife'], fileName: () => 'fx.js' }},
    outDir: {out!r}, emptyOutDir: true, minify: false, target: 'es2020',
  }},
}};
"""

CHROME_JS = r"""
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const inp = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const bundle = fs.readFileSync(inp.bundle, 'utf8');
  const args = inp.swiftshader ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
  const browser = await chromium.launch({ args });
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: bundle });
  const readBin = (p) => fs.readFileSync(p).toString('base64');
  const out = { renderer: null, parity: [], perf: [] };
  const run = async (job) => page.evaluate(async (j) => {
    const mk = (w, h, b64) => {
      const bin = atob(b64); const px = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < px.length; i++) px[i] = bin.charCodeAt(i);
      const c = new OffscreenCanvas(w, h); const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.putImageData(new ImageData(px, w, h), 0, 0);
      return { canvas: c, ctx, width: w, height: h };
    };
    const blank = (w, h) => { const c = new OffscreenCanvas(w, h); return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }), width: w, height: h }; };
    const src = mk(j.w, j.h, j.b64);
    const res = [];
    const gl = new OffscreenCanvas(2, 2).getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    for (const c of j.cases) {
      if (j.mode === 'parity') {
        const o = blank(j.w, j.h);
        const r = RasterFx.applyEffects(src, c.effects, { x: 0, y: 0, w: j.w, h: j.h }, o);
        const d = o.ctx.getImageData(0, 0, j.w, j.h).data;
        let s = ''; const CH = 1 << 15;
        for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
        res.push({ name: c.name, b64: btoa(s), rect: r });
      } else {
        const b = RasterFx.benchEffects(src, c.effects, j.iters);
        res.push({ name: c.name, bench: b });
      }
    }
    return { renderer, res };
  }, job);
  for (const job of inp.jobs) {
    const r = await run({ ...job, b64: readBin(job.file) });
    out.renderer = r.renderer;
    (job.mode === 'parity' ? out.parity : out.perf).push(...r.res);
  }
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
"""


def have_playwright():
    return os.path.isdir(os.path.join(ROOT, "web", "node_modules", "playwright"))


def build_bundle():
    out = os.path.join(WORK, "bundle")
    cfg = os.path.join(WORK, "vite.fx.config.mjs")
    open(cfg, "w").write(BUNDLE_CFG.format(web=os.path.join(ROOT, "web"), entry=os.path.join(ROOT, "web", "src", "engine", "effects", "index.ts"), out=out))
    r = subprocess.run([os.path.join(ROOT, "web", "node_modules", ".bin", "vite"), "build", "--config", cfg], cwd=os.path.join(ROOT, "web"),
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        print("  bundle failed:", (r.stderr or r.stdout)[-1500:])
        return None
    return os.path.join(out, "fx.js")


def chrome_run(jobs, swiftshader=False):
    """jobs: [{mode: parity|perf, w, h, straight (h,w,4) uint8, cases: [(name, effects)], iters}]."""
    if not have_playwright():
        return None
    bundle = build_bundle()
    if not bundle:
        return None
    spec = {"bundle": bundle, "swiftshader": swiftshader, "jobs": []}
    for i, j in enumerate(jobs):
        f = os.path.join(WORK, "chrome_src_%d.bin" % i)
        j["straight"].tobytes()
        open(f, "wb").write(np.ascontiguousarray(j["straight"]).tobytes())
        spec["jobs"].append({"mode": j["mode"], "w": j["straight"].shape[1], "h": j["straight"].shape[0], "file": f, "iters": j.get("iters", 10),
                             "cases": [{"name": n, "effects": e} for n, e in j["cases"]]})
    js = os.path.join(WORK, "chrome_fx.cjs")
    open(js, "w").write(CHROME_JS)
    inp, outp = os.path.join(WORK, "chrome_in.json"), os.path.join(WORK, "chrome_out.json")
    json.dump(spec, open(inp, "w"))
    env = dict(os.environ, NODE_PATH=os.path.join(ROOT, "web", "node_modules"))
    r = subprocess.run(["node", js, inp, outp], cwd=os.path.join(ROOT, "web"), capture_output=True, text=True, timeout=900, env=env)
    if r.returncode != 0 or not os.path.exists(outp):
        print("  chromium run failed:", (r.stderr or r.stdout)[-1500:])
        return None
    return json.load(open(outp))


def decode_premult(b64, w, h):
    a = np.frombuffer(base64.b64decode(b64), np.uint8).reshape(h, w, 4).astype(np.float64) / 255
    a[..., :3] *= a[..., 3:4]
    return a


# --------------------------------------------------------------------------- checks


def diff_stats(a, b):
    d = np.abs(a - b) * 255
    return float(d.max()), float(np.percentile(d, 99.9)), int((d > TOL).sum()), d


def do_parity(only, swiftshader):
    img = test_image()
    h, w, _ = img.shape
    cases = [c for c in CASES if not only or c[0] in only]
    res = chrome_run([{"mode": "parity", "straight": img, "cases": cases}], swiftshader)
    if res is None:
        check("chromium available", False, "playwright / vite / WebGL2 missing")
        return
    print("  chromium renderer:", res["renderer"])
    web = {r["name"]: r for r in res["parity"]}
    td_setup()
    td_set_source(img)
    for name, effects in cases:
        a, info = td_render(effects)
        if info["errors"]:
            check("parity " + name, False, "TD shader errors: " + " | ".join(info["errors"]))
            continue
        b = decode_premult(web[name]["b64"], w, h)
        mx, p999, nbad, d = diff_stats(a, b)
        changed = float((np.abs(a - premult(img)) * 255 > TOL).mean() * 100)      # the effect must really do something
        ok = mx <= TOL and changed > 0.2
        detail = "max %.2f/255  p99.9 %.2f  >%g: %d px  TD nodes %d  (effect changes %.1f%% of px)" % (mx, p999, TOL, nbad, info["nodes"], changed)
        if not ok and mx > TOL and name in PIXEL_SORT_NAMES:
            ok = nbad <= 0.005 * w * h        # key ties across GPUs reorder at most a handful of near-equal pixels
            detail += "  (pixel sort: allowed 0.5%% of pixels, got %.3f%%)" % (100.0 * nbad / (w * h))
        check("parity " + name, ok, detail)
        if not ok:
            np.save(os.path.join(WORK, "bad_td_%s.npy" % name.replace(" ", "_")), a)
            np.save(os.path.join(WORK, "bad_web_%s.npy" % name.replace(" ", "_")), b)


def do_perf(only, swiftshader):
    rng = np.random.default_rng(3)
    img = test_image(1920, 1080)
    # make pixel sort / stroke representative: add a grid of noisy opaque blocks
    for i in range(0, 1080 - 60, 120):
        img[i:i + 60, 100:1800, :3] = rng.integers(0, 256, (60, 1700, 1), np.uint8)
        img[i:i + 60, 100:1800, 3] = 255
    cases = [c for c in CASES + PERF_EXTRA if not only or c[0] in only]
    res = chrome_run([{"mode": "perf", "straight": img, "cases": cases, "iters": 10}], swiftshader)
    web = {r["name"]: r["bench"] for r in (res or {"perf": []})["perf"]}
    if res:
        print("  chromium renderer:", res["renderer"])
    td_setup()
    td_set_source(img)
    print("  %-30s %7s %10s %7s %10s" % ("effect @1920x1080", "TD pass", "TD GPU ms", "web pass", "web ms"))
    for name, effects in cases:
        a, info = td_render(effects, perf=True)
        wb = web.get(name)
        print("  %-30s %7d %10.3f %7s %10s" % (name, info["nodes"], info.get("gpu_ms", float("nan")),
                                              wb["passes"] if wb else "-", "%.3f" % wb["ms"] if wb else "-"))
        check("perf " + name + " cooks", not info["errors"], "; ".join(info["errors"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", nargs="?", default="all", choices=["all", "parity", "perf"])
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--swiftshader", action="store_true")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}
    try:
        if args.what in ("all", "parity"):
            do_parity(only, args.swiftshader)
        if args.what in ("all", "perf"):
            do_perf(only, args.swiftshader)
    finally:
        if not args.keep:
            try:
                td_teardown()
            except Exception as ex:  # noqa: BLE001
                print("teardown failed:", ex)
    bad = [r for r in RESULTS if not r[1]]
    print("\n%d checks, %d failed" % (len(RESULTS), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
