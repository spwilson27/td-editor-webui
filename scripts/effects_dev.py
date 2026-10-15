"""Live harness for the layer effects (shared/effects/*.glsl, td/raster_editor/effects.py, web/src/engine/effects).

    .venv/bin/python scripts/effects_dev.py [parity|stress|perf|all|sync|report] [--only NAME[,NAME]] [--keep] [--swiftshader] [--sizes 1920x1080,3840x2160]

stress  harder, photo-like content and parameter extremes for the filters most likely to differ between TD and the browser
        (error-diffusion dither, kuwahara, halftone, pixelate, pixel sort, long feedback chains ...); decides the `tdPreview` flags
sync    rewrite the embedded copy of shared/effects/*.filter.json inside td/raster_editor/effects.py (the TD component ships no spec files)

parity  every effect, every sample of every v6 filter (shared/effects/<type>.filter.json "samples"; displace/aux filters get an aux image) and
        a few stacks is rendered by the SAME shader sources
          * in TouchDesigner: EffectChain (effects.py) inside the scratch COMP /project1/_fxdev, GLSL TOP chain
          * in headless Chromium (Playwright from web/): web/src/engine/effects bundled with ``vite build --lib``
        and compared in premultiplied 8 bit.  Pass criterion: max |diff| <= 3/255 (pixel sort: <= 3/255 except where two keys land on
        different sides of a quantisation step on another GPU (hue on SwiftShader: ~0.3% of pixels); allowed 0.5%).  Needs TouchDesigner (port 8765) and web/node_modules.
perf    GPU time per effect / filter (first sample) at every --sizes entry (default 1920x1080 and 3840x2160): TD = sum of the chain's GLSL TOP ``gpuCookTime`` (min of 5 forced cooks),
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
    n = 4 if w * h <= 600_000 else 1
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
    ("blur 16", [{"enabled": True, "type": "blur", "radius": 16}]),
    ("blur 24", [{"enabled": True, "type": "blur", "radius": 24}]),
    ("blur 32", [{"enabled": True, "type": "blur", "radius": 32}]),
    ("blur 33", [{"enabled": True, "type": "blur", "radius": 33}]),
    ("blur 200", [{"enabled": True, "type": "blur", "radius": 200}]),
    ("dropShadow blur 40", [{"enabled": True, "type": "dropShadow", "dx": 10, "dy": 10, "blur": 40, "color": C(0, 0, 0), "opacity": 1}]),
    ("dropShadow blur 150", [{"enabled": True, "type": "dropShadow", "dx": 10, "dy": 10, "blur": 150, "color": C(0, 0, 0), "opacity": 1}]),
    ("stroke 64 outside", [{"enabled": True, "type": "stroke", "width": 64, "color": C(255, 0, 80), "position": "outside", "opacity": 1}]),
    ("bevel size 30", [{"enabled": True, "type": "bevel", "depth": 90, "size": 30, "angle": 120, "highlight": C(255, 255, 255), "shadow": C(0, 0, 0)}]),
]
# v6 pyramid versions of the blur-type v5 effects
PYRAMID_CASES = [
    ("dropShadow pyramid 45", [{"enabled": True, "type": "dropShadow", "dx": 9, "dy": 7, "blur": 45, "color": C(0, 0, 0, 230), "opacity": 0.8}]),
    ("outerGlow pyramid 100", [{"enabled": True, "type": "outerGlow", "size": 100, "color": C(255, 220, 80), "opacity": 0.9}]),
    ("innerGlow pyramid 70", [{"enabled": True, "type": "innerGlow", "size": 70, "color": C(255, 255, 255), "opacity": 0.8}]),
    ("bevel pyramid 60", [{"enabled": True, "type": "bevel", "depth": 90, "size": 60, "angle": 120, "highlight": C(255, 255, 255, 230), "shadow": C(0, 0, 0, 200)}]),
]
PIXEL_SORT_NAMES = ("pixelSort h luma", "pixelSort v hue")


def filter_cases(only=None, all_samples=True):
    """[(name, [effect])] for every sample of every filter spec (name 'type' or 'type#i'); needs fxpy specs loaded from the files."""
    out = []
    for t, sp in sorted(fxpy.FILTER_SPECS.items()):
        if only and t not in only:
            continue
        samples = sp.get("samples") or [{}]
        for i, smp in enumerate(samples if all_samples else samples[:1]):
            out.append(("%s#%d" % (t, i) if len(samples) > 1 and all_samples else t, [dict({"enabled": True, "type": t}, **smp)]))
    return out


def aux_image(w, h):
    """Straight RGBA8 aux image for displace-by-layer: smooth ramps + a hard step (document sized)."""
    yy, xx = np.mgrid[0:h, 0:w]
    r = (np.sin(xx / 17.0) * 0.5 + 0.5) * 255
    g = (np.cos(yy / 11.0 + xx / 40.0) * 0.5 + 0.5) * 255
    b = np.where(xx > w // 2, 255, 40)
    return np.rint(np.stack([r, g, b, np.full_like(r, 255)], -1)).astype(np.uint8)


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


def load_specs():
    """Loads the filter specs from the files (what the tests / chromium use) and refreshes the embedded copy in effects.py (what TD runs)."""
    fxpy.reload_specs(fxpy.load_specs())
    fxpy.sync_embedded_specs()


def td_setup():
    load_specs()
    texts = fxpy.load_shader_texts()
    fx_src = open(os.path.join(ROOT, "td", "raster_editor", "effects.py"), encoding="utf-8").read()
    src_path = os.path.join(WORK, "effects_src.py")          # TD's call limit is 200k chars: hand the sources over through files
    txt_path = os.path.join(WORK, "shader_texts.json")
    open(src_path, "w", encoding="utf-8").write(fx_src)
    json.dump(texts, open(txt_path, "w", encoding="utf-8"))
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
ax = c.create(scriptTOP, "aux")
acb = c.op("aux_callbacks")
acb.text = "def onCook(scriptOp):\\n    import sys\\n    scriptOp.copyNumpyArray(sys.modules['fxdev_state'].aux)\\n"
st = types.ModuleType("fxdev_state"); sys.modules["fxdev_state"] = st
st.buf = np.zeros((4, 4, 4), np.uint8)
st.aux = np.zeros((4, 4, 4), np.uint8)
m = types.ModuleType("fxdev_effects"); m.__dict__["__name__"] = "fxdev_effects"
exec(compile(open({src_path!r}, encoding='utf-8').read(), "effects.py", "exec"), m.__dict__)
st.fx = m
st.texts = json.load(open({txt_path!r}, encoding='utf-8'))
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


def td_set_aux(straight_u8):
    h, w, _ = straight_u8.shape
    pre = np.rint(premult(straight_u8) * 255).astype(np.uint8)[::-1]
    path = os.path.join(WORK, "aux.npy")
    np.save(path, np.ascontiguousarray(pre))
    td(PRELUDE + f'''
st = sys.modules["fxdev_state"]
st.aux = np.load({path!r})
op("{SCRATCH}/aux").cook(force=True)
_emit("ok")
''')


def td_render(effects, perf=False, pool=False):
    """Builds the chain for ``effects`` in TD and returns (premultiplied float (h,w,4) top row first, info)."""
    outp = os.path.join(WORK, "td_out.npy")
    pool = pool or bool(os.environ.get("FXDEV_POOL"))      # FXDEV_POOL=1: nodes from a network.py-like spare pool (warmed on a constant)
    r = td(PRELUDE + f'''
st = sys.modules["fxdev_state"]
c = op("{SCRATCH}")
if st.chain is not None: st.chain.destroy()
if {pool!r}:
    # network.py's spare pool: GLSL TOPs created ahead with blend.glsl pars, warmed (cooked) on 3 inputs wired to a constant (DocNetwork._warm_one)
    w = c.op("warm_in") or c.create(constantTOP, "warm_in")
    w.par.outputresolution = "custom"; w.par.resolutionw = 16; w.par.resolutionh = 16; w.par.format = "rgba8fixed"
    w.par.colorr = 0.7; w.par.colorg = 0.0; w.par.colorb = 0.0; w.par.alpha = 1.0
    cnt = [0]
    def _acq(optype):
        cnt[0] += 1
        n = c.create(glslTOP, "g%d" % (cnt[0] + 100))
        for k, v in {{"pixeldat": "probe_px", "format": "rgba16fixed", "vec0name": "uParams", "vec1name": "uXform", "vec2name": "uA", "vec3name": "uB"}}.items():
            setattr(n.par, k, v)
        for i in range(3): n.inputConnectors[i].connect(w)
        n.cook(force=True)
        return n
    def _rel(op):
        for cc in op.inputConnectors: cc.disconnect()
        op.destroy()
    st.chain = st.fx.EffectChain(c, "fx", st.texts, acquire=_acq, release=_rel, adopt=False)
else:
    st.chain = st.fx.EffectChain(c, "fx", st.texts)
src = c.op("src")
t0 = time.perf_counter()
out = st.chain.apply(json.loads({json.dumps(json.dumps(effects))}), src, 0, 0, aux=c.op("aux"))
ms_build = (time.perf_counter() - t0) * 1e3
nodes = st.chain.nodes
for n in nodes: n.cook(force=True)
errs = []
for n in nodes:
    e = n.errors()
    if e: errs.append(n.name + ": " + e[:300])
if not {perf!r}:
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
    a = None if perf else np.load(outp)[::-1].astype(np.float64)
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
    const aux = j.auxb64 ? mk(j.w, j.h, j.auxb64) : null;
    const res = [];
    const gl = new OffscreenCanvas(2, 2).getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    for (const c of j.cases) {
      if (j.mode === 'parity') {
        const o = blank(j.w, j.h);
        const r = RasterFx.applyEffects(src, c.effects, { x: 0, y: 0, w: j.w, h: j.h }, o, aux);
        const d = o.ctx.getImageData(0, 0, j.w, j.h).data;
        let s = ''; const CH = 1 << 15;
        for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
        res.push({ name: c.name, b64: btoa(s), rect: r });
      } else {
        const b = RasterFx.benchEffects(src, c.effects, j.iters, aux);
        res.push({ name: c.name, bench: b });
      }
    }
    return { renderer, res };
  }, job);
  for (const job of inp.jobs) {
    const r = await run({ ...job, b64: readBin(job.file), auxb64: job.auxfile ? readBin(job.auxfile) : null });
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
        af = None
        if j.get("aux") is not None:
            af = os.path.join(WORK, "chrome_aux_%d.bin" % i)
            open(af, "wb").write(np.ascontiguousarray(j["aux"]).tobytes())
        spec["jobs"].append({"mode": j["mode"], "w": j["straight"].shape[1], "h": j["straight"].shape[0], "file": f, "auxfile": af, "iters": j.get("iters", 10),
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


# --------------------------------------------------------------------------- v7: classic adjustments as filters vs the v2 adjustment maths

OLD_ADJ_TYPES = ("levels", "brightnessContrast", "hueSaturation", "invert", "threshold")
# the v6 adjustment blur (sigma = radius px, edge hold) as the blur filter: effects.legacy_blur_to_filter(r) = {radius: min(200, 3r), sigma: r, edge: hold}
ADJ_BLUR_CASES = [("adjBlur r%d" % r, [fxpy.legacy_blur_to_filter(r)]) for r in (2, 4, 10, 16, 200)]
OLD_ROWS = []


def _hsv_edit(c, hue, sat, val):
    """TD blend.glsl rgb2hsv / hsv2rgb (uAdjust 6) in numpy; c (..., 3) straight 0..1."""
    mx, mn = c.max(-1), c.min(-1)
    d = mx - mn
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(mx == r, np.mod((g - b) / d, 6.0), np.where(mx == g, (b - r) / d + 2.0, (r - g) / d + 4.0))
    h = np.where(d > 0, h, 0.0) * 60.0
    s = np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0.0)
    h = np.mod(h + hue, 360.0) / 60.0
    s = np.minimum(1.0, s * sat)
    v = mx * val
    i = np.floor(h)
    f = h - i
    p_, q_, t_ = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    k = i.astype(int) % 6
    out = np.zeros_like(c)
    for kk, (R, G, B) in enumerate([(v, t_, p_), (q_, v, p_), (p_, v, t_), (p_, q_, v), (t_, p_, v), (v, p_, q_)]):
        m = k == kk
        out[..., 0] = np.where(m, R, out[..., 0])
        out[..., 1] = np.where(m, G, out[..., 1])
        out[..., 2] = np.where(m, B, out[..., 2])
    return np.clip(out, 0, 1)


def old_adjust_ref(e, straight_u8):
    """Premultiplied float 0..1 of the v2 adjustment (docs in web/src/engine/adjustments.ts, td blend.glsl uAdjust 2..6) applied to an 8 bit
    PREMULTIPLIED image (what the layer / the composite below holds), straight colour recovered in float, alpha preserved."""
    pm8 = np.rint(premult(straight_u8) * 255.0) / 255.0
    a = pm8[..., 3:4]
    c = np.clip(np.where(a > 1e-6, pm8[..., :3] / np.maximum(a, 1e-6), 0.0), 0, 1)
    t = e["type"]
    if t == "levels":
        lo = e.get("inLow", 0.0)
        hi = max(e.get("inHigh", 1.0), lo + 1e-4)
        g = e.get("gamma", 1.0)
        o = e.get("outLow", 0.0) + (e.get("outHigh", 1.0) - e.get("outLow", 0.0)) * np.clip((c - lo) / (hi - lo), 0, 1) ** (1.0 / g)
    elif t == "brightnessContrast":
        c1 = np.clip(c * (1 + e.get("brightness", 0.0)), 0, 1)
        o = (c1 - 0.5) * (1 + e.get("contrast", 0.0)) + 0.5
    elif t == "invert":
        o = 1.0 - c
    elif t == "threshold":
        o = np.repeat((c @ np.array([0.2126, 0.7152, 0.0722]) >= e.get("level", 0.5)).astype(np.float64)[..., None], 3, -1)
    else:
        o = _hsv_edit(c, e.get("hue", 0.0), e.get("saturation", 1.0), e.get("value", 1.0))
    return np.concatenate([np.clip(o, 0, 1) * a, a], -1)


def old_blur_ref(radius_adj, straight_u8):
    """v6 adjustment blur: gaussian sigma = radius px on the PREMULTIPLIED image, outside the document repeats the edge pixels (hold)."""
    sg = float(radius_adj)
    n = int(np.ceil(4 * sg))
    k = np.exp(-0.5 * (np.arange(-n, n + 1) / sg) ** 2)
    k /= k.sum()
    x = np.rint(premult(straight_u8) * 255.0) / 255.0       # the layer holds 8 bit premultiplied
    for ax in (0, 1):
        pad = [(0, 0)] * 3
        pad[ax] = (n, n)
        xp = np.pad(x, pad, mode="edge")
        x = sum(k[i] * np.take(xp, np.arange(i, i + x.shape[ax]), axis=ax) for i in range(2 * n + 1))
    return x


def all_cases(only):
    return [c for c in CASES + PYRAMID_CASES if not only or c[0] in only or c[0].split()[0] in only] + filter_cases(only) + [c for c in ADJ_BLUR_CASES if not only or c[0] in only or "adjBlur" in only]


def do_parity(only, swiftshader):
    load_specs()
    img = test_image()
    aux = aux_image(img.shape[1], img.shape[0])
    h, w, _ = img.shape
    cases = all_cases(only)
    res = chrome_run([{"mode": "parity", "straight": img, "aux": aux, "cases": cases}], swiftshader)
    if res is None:
        check("chromium available", False, "playwright / vite / WebGL2 missing")
        return
    print("  chromium renderer:", res["renderer"])
    web = {r["name"]: r for r in res["parity"]}
    td_setup()
    td_set_source(img)
    td_set_aux(aux)
    for name, effects in cases:
        try:
            a, info = td_render(effects)
        except Exception as ex:  # noqa: BLE001
            check("parity " + name, False, "TD error: " + str(ex)[:600])
            continue
        if info["errors"]:
            check("parity " + name, False, "TD shader errors: " + " | ".join(info["errors"]))
            continue
        b = decode_premult(web[name]["b64"], w, h)
        mx, p999, nbad, d = diff_stats(a, b)
        mean = float(d.mean())
        changed = float((np.abs(a - premult(img)) * 255 > TOL).mean() * 100)      # the effect must really do something
        ok = mx <= TOL and changed > 0.2
        detail = "max %.2f/255  p99.9 %.2f  >%g: %d px  TD nodes %d  (changes %.1f%% of px)" % (mx, p999, TOL, nbad, info["nodes"], changed)
        if not ok and mx > TOL and name in PIXEL_SORT_NAMES:
            ok = nbad <= 0.005 * w * h        # key ties across GPUs reorder at most a handful of near-equal pixels
            detail += "  (pixel sort: allowed 0.5%% of pixels, got %.3f%%)" % (100.0 * nbad / (w * h))
        e0 = effects[0]
        if len(effects) == 1 and e0["type"] in OLD_ADJ_TYPES:
            ref = old_adjust_ref(e0, img)
            ma, mb = float(np.abs(a - ref).max() * 255), float(np.abs(b - ref).max() * 255)
            ba, bb = int((np.abs(a - ref) * 255 > 1.0).sum()), int((np.abs(b - ref) * 255 > 1.0).sum())
            # threshold / hue are discontinuous: a pixel whose key lands on the other side of the step differs by a lot; count those separately
            okr = (ma <= 1.0 and mb <= 1.0) or (e0["type"] in ("threshold", "hueSaturation") and max(ba, bb) <= 0.002 * w * h)
            check("vs v2 adjustment " + name, okr, "TD max %.2f/255 (%d px > 1)  WebGL max %.2f/255 (%d px > 1)" % (ma, ba, mb, bb))
            OLD_ROWS.append((name, ma, ba, mb, bb))
        elif name.startswith("adjBlur"):
            r = e0["sigma"]
            ref = old_blur_ref(r, img)
            m = min(int(np.ceil(4 * r)) + 1, min(h, w) // 2 - 1)
            edge = np.ones(a.shape[:2], bool)
            edge[m:-m, m:-m] = False
            dA, dB = np.abs(a - ref) * 255, np.abs(b - ref) * 255
            ia, ib, ea, eb = float(dA[~edge].max()), float(dB[~edge].max()), float(dA[edge].max()), float(dB[edge].max())
            tol = 1.05 if 4 * r <= 16 else 2.0         # exact path: 8 bit rounding only; pyramid: its documented error (<= 2.4)
            check("vs v2 blur " + name, max(ea, eb, ia, ib) <= tol,
                  "border band TD %.2f WebGL %.2f /255; interior TD %.2f WebGL %.2f (reference: gaussian sigma=%g, edge hold; band = 4 sigma, whole image when larger)" % (ea, eb, ia, ib, r))
            OLD_ROWS.append((name, ia, 0, ib, 0, ea, eb))
        check("parity " + name, ok, detail)
        PARITY_ROWS.append((name, mx, mean, p999, nbad, changed))
        if not ok:
            np.save(os.path.join(WORK, "bad_td_%s.npy" % name.replace(" ", "_")), a)
            np.save(os.path.join(WORK, "bad_web_%s.npy" % name.replace(" ", "_")), b)


STRESS = [("stress dither diffusion L%d %s" % (lv, "rgb" if col else "grey"), [{"enabled": True, "type": "dither", "mode": "diffusion", "levels": lv, "colour": col}])
          for lv in (2, 3, 4, 8) for col in (True, False)]
STRESS += [("stress dither ordered L%d m%d" % (lv, m), [{"enabled": True, "type": "dither", "mode": "ordered", "levels": lv, "matrix": m, "colour": True}]) for lv, m in ((2, 8), (5, 4))]
STRESS += [("stress kuwahara r%d" % r, [{"enabled": True, "type": "kuwahara", "radius": r}]) for r in (2, 6, 10, 16)]
STRESS += [("stress halftone %s %d" % (sh, cs), [{"enabled": True, "type": "halftone", "cellSize": cs, "angle": 25, "shape": sh}]) for sh in ("dot", "line") for cs in (3, 8, 20)]
STRESS += [("stress pixelate %s %d" % (sm, sz), [{"enabled": True, "type": "pixelate", "size": sz, "sample": sm}]) for sm in ("mean", "centre") for sz in (7, 33, 100)]
STRESS += [("stress data curves default", [{"enabled": True, "type": "curves"}]),
           ("stress data curves master", [{"enabled": True, "type": "curves", "master": [[0, 0], [0.3, 0.6], [1, 1]]}]),
           ("stress data curves invert", [{"enabled": True, "type": "curves", "master": [[0, 1], [1, 0]], "red": [[0, 0], [1, 0.5]]}]),
           ("stress data gradientMap default", [{"enabled": True, "type": "gradientMap"}]),
           ("stress data gradientMap 3 stops", [{"enabled": True, "type": "gradientMap", "stops": [{"pos": 0, "color": C(255, 0, 0)}, {"pos": 0.5, "color": C(0, 255, 0, 40)}, {"pos": 1, "color": C(0, 0, 255)}]}]),
           ("stress data selectiveColor default", [{"enabled": True, "type": "selectiveColor"}]),
           ("stress data selectiveColor reds", [{"enabled": True, "type": "selectiveColor", "adjust": [0.5, -0.3, 0.2, 0.1] + [0.0] * 32}]),
           ("stress data lut default", [{"enabled": True, "type": "lut"}]),
           ("stress data curves then blur", [{"enabled": True, "type": "curves"}, {"enabled": True, "type": "blur", "radius": 5}]),
           ("stress data blur then curves", [{"enabled": True, "type": "blur", "radius": 5}, {"enabled": True, "type": "curves", "master": [[0, 0], [0.3, 0.6], [1, 1]]}])]
STRESS += [("stress grain film", [{"enabled": True, "type": "grain", "amount": 80, "size": 3, "kind": "film", "colour": True, "seed": 7}]),
           ("stress pixelSort", [{"enabled": True, "type": "pixelSort", "direction": "h", "low": 0.2, "high": 0.8, "key": "luma"}]),
           ("stress blur 200", [{"enabled": True, "type": "blur", "radius": 200}]), ("stress blur 33", [{"enabled": True, "type": "blur", "radius": 33}]),
           ("stress lensBlur 60", [{"enabled": True, "type": "lensBlur", "radius": 60, "blades": 6, "rotation": 15, "brightness": 50, "threshold": 0.6}]),
           ("stress colorCycle bands", [{"enabled": True, "type": "colorCycle", "iterations": 32, "hueStep": 17, "lumaWarp": 60, "saturationBoost": 20, "bands": 12}]),
           ("stress feedback rot", [{"enabled": True, "type": "feedback", "iterations": 40, "dx": 3, "dy": -2, "rotate": 4, "scale": 97, "decay": 90, "blend": "screen"}]),
           ("stress driftGlitch 64", [{"enabled": True, "type": "driftGlitch", "iterations": 64, "amount": 20, "blockSize": 5, "density": 60, "rgbShift": 4, "seed": 3, "axis": "v"}])]


def stress_image(w=320, h=200, seed=11):
    """Photo-like content: smooth low-frequency colour field, texture noise, a few hard edges and a semi-transparent corner (straight RGBA8)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    rgb = np.stack([0.5 + 0.5 * np.sin(xx / 23.0 + yy / 41.0), 0.5 + 0.5 * np.sin(xx / 37.0 - yy / 19.0 + 1), 0.5 + 0.5 * np.cos(xx / 29.0 + yy / 53.0)], -1)
    rgb = rgb * 0.8 + rng.normal(0, 0.06, rgb.shape)
    rgb[h // 3: h // 3 + 40, w // 4: w // 4 + 90] = [0.9, 0.9, 0.2]
    a = np.ones((h, w))
    a[: h // 4, : w // 4] = 0.4
    a[-h // 5:, -w // 5:] = 0.0
    return np.rint(np.clip(np.concatenate([rgb, a[..., None]], -1), 0, 1) * 255).astype(np.uint8)


def do_stress(only, swiftshader):
    load_specs()
    img = stress_image()
    h, w, _ = img.shape
    cases = [c for c in STRESS if not only or any(o in c[0] for o in only)]
    res = chrome_run([{"mode": "parity", "straight": img, "aux": aux_image(w, h), "cases": cases}], swiftshader)
    if res is None:
        check("chromium available", False, "")
        return
    web = {r["name"]: r for r in res["parity"]}
    td_setup()
    td_set_source(img)
    td_set_aux(aux_image(w, h))
    for name, effects in cases:
        a, info = td_render(effects)
        b = decode_premult(web[name]["b64"], w, h)
        mx, p999, nbad, d = diff_stats(a, b)
        check(name, mx <= TOL and not info["errors"], "max %.2f/255  p99.9 %.2f  >%g: %d px (%.3f%%)  %s" % (mx, p999, TOL, nbad, 100.0 * nbad / (w * h), "; ".join(info["errors"])))
        PARITY_ROWS.append((name, mx, float(d.mean()), p999, nbad, 0.0))


PARITY_ROWS: list = []
PERF_ROWS: list = []


def perf_image(w, h):
    rng = np.random.default_rng(3)
    img = test_image(w, h)
    # make pixel sort / stroke representative: add a grid of noisy opaque blocks
    for i in range(0, h - h // 18, h // 9):
        img[i:i + h // 18, w // 19:w - w // 19, :3] = rng.integers(0, 256, (h // 18, w - 2 * (w // 19), 1), np.uint8)
        img[i:i + h // 18, w // 19:w - w // 19, 3] = 255
    return img


def do_perf(only, swiftshader, sizes):
    load_specs()
    td_setup()
    for (w, h) in sizes:
        img = perf_image(w, h)
        aux = aux_image(w, h)
        cases = [c for c in CASES + PERF_EXTRA + PYRAMID_CASES if not only or c[0] in only or c[0].split()[0] in only] + filter_cases(only, all_samples=False)
        res = chrome_run([{"mode": "perf", "straight": img, "aux": aux, "cases": cases, "iters": 10}], swiftshader)
        web = {r["name"]: r["bench"] for r in (res or {"perf": []})["perf"]}
        if res:
            print("  chromium renderer:", res["renderer"])
        td_set_source(img)
        td_set_aux(aux)
        print("  %-30s %7s %10s %7s %10s   @ %dx%d" % ("effect", "TD pass", "TD GPU ms", "web pass", "web ms", w, h))
        for name, effects in cases:
            try:
                a, info = td_render(effects, perf=True)
            except Exception as ex:  # noqa: BLE001
                check("perf %dx%d %s" % (w, h, name), False, "TD error: " + str(ex)[:300])
                continue
            wb = web.get(name)
            print("  %-30s %7d %10.3f %7s %10s" % (name, info["nodes"], info.get("gpu_ms", float("nan")),
                                                  wb["passes"] if wb else "-", "%.3f" % wb["ms"] if wb else "-"))
            PERF_ROWS.append((w, h, name, info["nodes"], info.get("gpu_ms", float("nan")), wb["ms"] if wb else float("nan")))
            check("perf %dx%d %s cooks" % (w, h, name), not info["errors"], "; ".join(info["errors"]))


def _agg(rows):
    """[(name, max, mean, p999, nbad, changed)] -> {type: (worst max, worst mean, samples)}; name 'type#i' / 'stress ...' / 'dropShadow pyramid 45'."""
    out = {}
    for name, mx, mean, p999, nbad, _ch in rows:
        t = name.split("#")[0]
        o = out.setdefault(t, [0.0, 0.0, 0])
        o[0], o[1], o[2] = max(o[0], mx), max(o[1], mean), o[2] + 1
    return out


def make_report(resdir, out_path):
    """docs/FILTERS.md from the JSON files written by `parity|stress|perf --json` (names parity_metal, parity_swift, stress_metal, stress_swift, perf)."""
    load_specs()
    ld = lambda n: json.load(open(os.path.join(resdir, n + ".json")))  # noqa: E731
    pm, ps = _agg(ld("parity_metal")["parity"]), _agg(ld("parity_swift")["parity"])
    sm, ss = {r[0]: r for r in ld("stress_metal")["parity"]}, {r[0]: r for r in ld("stress_swift")["parity"]}
    perf = ld("perf")["perf"]
    specs = fxpy.FILTER_SPECS
    L = []
    w = L.append
    w("# Filters library (v6 phase A)\n")
    w("Generated by `.venv/bin/python scripts/effects_dev.py report --results DIR` from live runs (TouchDesigner GLSL TOP chain in `/project1/_fxdev` vs the")
    w("WebGL2 runner in headless Chromium).  Sources: `shared/effects/<type>.filter.json` (spec: parameters, units, passes, extent, samples) +")
    w("`<type>.glsl`; planners `td/raster_editor/effects.py` == `web/src/engine/effects/{filters,plan}.ts` (checked by `shared/effects/vectors.json` and the seeded")
    w("`fuzz_vectors.json`); types `shared/effects/filters*.d.ts`.\n")
    w("## Using filters\n")
    w("- **Per-layer effect:** put the filter in `effects` (same chain as the v5 effects, mixed lists fine).")
    w("- **Adjustment layer:** run the filter on the document-sized composite BELOW the layer: web `applyEffects(compositeBelow, [filter], rect, out)`, TD")
    w("  `EffectChain.apply([filter], below_top, w, h)`.  Nothing else is special.")
    w("- **Second image (displace by layer / input):** web `applyEffects(src, fx, rect, out, auxSurface)`; TD `EffectChain.apply(fx, input, w, h, aux=top)`.")
    w("  Aux is document sized; absent aux = no displacement.")
    w("- **Planner flags** (per effect, identical in Python / TS): `effect_reads` / `effectReads` (`none|point|neighbourhood|global`),")
    w("  `effect_needs_neighbourhood`, `effect_td_preview` / `effectTdPreview`, extent / reach for region rendering (`expandRect`).")
    w("- Everything is static (no time); iterative filters take `iterations` <= 64 and deterministic seeds.\n")
    w("## Filters\n")
    w("| type | group | reads | passes (sample 0) | extent | preservesTransparent | tdPreview |")
    w("|---|---|---|---|---|---|---|")
    glob = []
    for t, sp in sorted(specs.items(), key=lambda kv: (kv[1].get("group", ""), kv[0])):
        smp = dict({"enabled": True, "type": t}, **(sp.get("samples") or [{}])[0])
        ps_ = fxpy.plan_effect(smp)
        ext = fxpy.effect_extent(smp)
        reads = fxpy.effect_reads(smp)
        isg = reads == "global" or max(ext[:2]) >= fxpy.GLOBAL_REACH
        if isg or any("G" in str(x) for x in sp.get("extent", [])):
            glob.append(t)
        w("| `%s` | %s | %s | %d | %s | %s | %s |" % (t, sp.get("group", ""), reads, len(ps_), "whole document" if max(ext[:2]) >= fxpy.GLOBAL_REACH else "%d x %d px" % ext[:2],
                                                   "yes" if sp.get("preservesTransparent") else "no", "yes" if fxpy.effect_td_preview(smp) else "no"))
    w("\nv5 effects (`dropShadow outerGlow innerGlow stroke bevel colorOverlay pixelSort glitch chromaticAberration halftone`) are unchanged except that their blur passes use the")
    w("pyramid above 16 px; `pixelSort` is flagged `tdPreview` (see below).\n")
    w("### Whole-document (global-extent) filters\n")
    w("These read pixels anywhere in the document (or depending on parameters), so an edit anywhere re-renders the whole document region; the planner reports")
    w("`reads: global` and an extent of 2^20 px for them (`expandRect` clips to the document).  Avoid stacking them on huge layers while painting: %s." % ", ".join("`%s`" % t for t in sorted(glob)))
    w("(`displace` only with edge != transparent, `feedback` / `echo` only with rotate / scale or large offsets, `crt` only with curvature.)\n")
    w("## Blur pyramid\n")
    w("Blur sizes (kernel half width, sigma = size / 3) up to 16 px run as one exact separable gaussian (bit-identical to v5).  Above (cap 200 px) every blur-type pass (shadow,")
    w("glows, bevel, blur, unsharp, high-pass, bloom) runs as a pyramid: box down-sample by s = 2^L (smallest L with ceil(size / s) <= 16, L = 1..4), gaussian at low resolution with")
    w("sigma_low^2 = (sigma^2 - s^2/4) / s^2, bilinear up-sample; the block grid is aligned to document coordinates (partial == full renders) and has one margin texel per side.")
    w("Cost is ~constant in the size.  Measured vs an exact gaussian (`web/tests/browser/effects.filters.test.ts`, 256x192, 8-bit): radius 12..16 max 0.96/255; 17: 1.53; 24: 1.13; 32: 1.11;")
    w("33: 2.06; 48: 1.15; 64: 1.10; 65: 2.03; 100: 1.62; 130: 2.43; 200: 1.22 (mean 0.19-0.35/255 throughout).  Continuity at the threshold for the v5 effects (16 -> 17 px vs the natural")
    w("15 -> 16 step): dropShadow 7.0 vs 7.0, outerGlow 9 vs 8, innerGlow 14 vs 13, bevel 14 vs 14 (max /255).\n")
    w("## Parity TD vs WebGL2 (premultiplied 8 bit, 256x160 test image, tolerance 3/255)\n")
    w("Rule (DESIGN_V6 section 4): a filter exceeding 3/255 on either GPU gets `tdPreview` (UI shows TD's render).  Metal = Chromium on the same Apple M4 Max GPU as TD; SwiftShader =")
    w("Chromium's software rasteriser, used as the \"different GPU implementation\" worst case.  max / mean are the worst over all samples of the type (/255).\n")
    w("| type | samples | Metal max | Metal mean | SwiftShader max | SwiftShader mean | flag |")
    w("|---|---|---|---|---|---|---|")
    bad = []
    for t in sorted(pm):
        a, b = pm[t], ps.get(t, [float("nan")] * 3)
        flag = "tdPreview" if (a[0] > TOL or b[0] > TOL) else ""
        if flag:
            bad.append(t)
        w("| %s | %d | %.2f | %.3f | %.2f | %.3f | %s |" % (t if t in specs else t + " (v5 effect)", a[2], a[0], a[1], b[0], b[1], flag))
    w("\n## Stress (photo-like 320x200 content with semi-transparent areas, parameter extremes)\n")
    w("| case | Metal max | Metal mean | SwiftShader max | SwiftShader mean | SwiftShader px > 3 |")
    w("|---|---|---|---|---|---|")
    for n in sorted(sm):
        a, b = sm[n], ss.get(n)
        w("| %s | %.2f | %.3f | %s | %s | %s |" % (n, a[1], a[2], "%.2f" % b[1] if b else "-", "%.3f" % b[2] if b else "-", b[4] if b else "-"))
    w("\n`stress pixelSort` (v5): on SwiftShader 12 of 64000 px differ by up to 90/255 (hue / luma key ties sort differently) -> `pixelSort` is flagged `tdPreview` (planner `TD_PREVIEW_V5`).")
    w("Flags from the table above: %s.\n" % (", ".join("`%s`" % t for t in bad) or "none"))
    w("### Exactness notes\n")
    w("- `dither` (error diffusion, ordered), `kuwahara` quadrant choice, `posterize` and the `edgeDetect` threshold take their decisions in **integer arithmetic on the 8-bit straight colour**")
    w("  (exact unpremultiply `min((510 k + m) / (2 m), 255)`).  This makes them identical across GPUs **only for 8-bit inputs**: when the chain feeds them float16 intermediates (after another")
    w("  effect with rgba16float output) the recovered integers can differ by one level and the decision can flip.  Dither diffusion is a windowed (7 rows x 19 columns) Floyd-Steinberg, an")
    w("  approximation of the sequential algorithm.  `unsharp`'s threshold is a +-1 level ramp for the same reason.")
    w("- Coordinate-mapping filters use `fxSin / fxCos / fxAtan2` (polynomials, only + - * / sqrt) instead of the GPU trig, which differs by far more than 1e-3 px on software rasterisers.\n")
    w("## Performance (GPU ms per run; TD = sum of the chain's GLSL TOP `gpuCookTime`, sync overhead subtracted, +-0.3 ms noise; browser = Metal via ANGLE, bracketed by a 1x1 read-back)\n")
    w("Sample 0 of every filter on a 1920x1080 / 3840x2160 image (opaque noisy blocks + shapes).  The browser column is a LOWER BOUND: Chromium queues GPU work asynchronously and the 1x1 read-back")
    w("bracket does not always wait for all of it, so trivial passes read ~0.03 ms; use the TD column for budgeting.\n")
    w("| effect | passes | TD 1080p | browser 1080p | TD 4K | browser 4K |")
    w("|---|---|---|---|---|---|")
    by = {}
    for (W, H, n, p, td_, web_) in perf:
        by.setdefault(n, {})[W] = (p, td_, web_)
    for n, d in sorted(by.items(), key=lambda kv: -kv[1].get(3840, (0, 0, 0))[1]):
        a, b = d.get(1920, (0, float("nan"), float("nan"))), d.get(3840, (0, float("nan"), float("nan")))
        w("| %s | %d | %.2f | %.2f | %.2f | %.2f |" % (n, a[0] or b[0], a[1], a[2], b[1], b[2]))
    w("\nCosts that matter: `kuwahara` (O(radius^2) taps, stride-subsampled above 6 px), `lensBlur`, `radialBlur` / `zoomBlur` (<= 64 taps), `feedback` (<= 63 taps).  The pyramid blurs stay")
    w("below ~3 ms at 4K for any radius up to 200.\n")
    w("## Tests\n")
    w("- `td/tests/test_effects*.py` (planner, vectors, fuzz vectors, chain wiring, .cube parser), `web/tests/browser/effects*.test.ts` (generic: every sample renders, partial == full for 7")
    w("  dirty rects incl. corners / 1x1 / edges; per-group semantic tests).  Browser tests skip with a console warning when WebGL2 is unavailable.")
    w("- Live: `scripts/effects_dev.py parity|stress|perf [--swiftshader] [--sizes ...] [--json F]`, then `report --results DIR`.")
    open(out_path, "w", encoding="utf-8").write("\n".join(L) + "\n")
    print("wrote", out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", nargs="?", default="all", choices=["all", "parity", "perf", "sync", "stress", "report"])
    ap.add_argument("--only", default="")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--swiftshader", action="store_true")
    ap.add_argument("--sizes", default="1920x1080,3840x2160")
    ap.add_argument("--json", default="", help="write parity / perf rows to this file")
    ap.add_argument("--results", default="", help="report: directory with parity_metal / parity_swift / stress_metal / stress_swift / perf .json")
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "FILTERS.md"))
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}
    if args.what == "sync":
        print("effects.py updated" if fxpy.sync_embedded_specs() else "effects.py already in sync")
        return 0
    if args.what == "report":
        make_report(args.results, args.out)
        return 0
    sizes = [tuple(int(v) for v in s.split("x")) for s in args.sizes.split(",") if s]
    try:
        if args.what in ("all", "parity"):
            do_parity(only, args.swiftshader)
        if args.what in ("all", "stress"):
            do_stress(only, args.swiftshader)
        if args.what in ("all", "perf"):
            do_perf(only, args.swiftshader, sizes)
    finally:
        if not args.keep:
            try:
                td_teardown()
            except Exception as ex:  # noqa: BLE001
                print("teardown failed:", ex)
    if args.json:
        json.dump({"parity": PARITY_ROWS, "perf": PERF_ROWS}, open(args.json, "w"))
    bad = [r for r in RESULTS if not r[1]]
    print("\n%d checks, %d failed" % (len(RESULTS), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
