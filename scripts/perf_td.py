"""TouchDesigner network cost at 4K with 30+ layers (hardening / performance report).

    .venv/bin/python scripts/perf_td.py [--ref v0.4.0] [--w 3840 --h 2160] [--keep] [--only SECTION[,SECTION]]

Builds a THROWAWAY COMP ``/project1/_hard_perf`` from ``td/raster_editor/{network.py,blend.glsl,shape.glsl}`` read
from git ``--ref`` (default v0.4.0; ``--ref WORKTREE`` uses the working tree), modelled on scripts/network_dev.py
(stand-in extension serving surface buffers).  Nothing outside the scratch COMP is touched; the project is never saved.

Sections: build, gpu, idle, update, apply, memory, offenders  (default: all)
GPU timers resolve a frame later and TD runs frames only BETWEEN calls, so every sample is its own td call that
(1) reads gpuCookTime of the nodes that cooked since the previous call, then (2) performs the action.
"""

from __future__ import annotations

import argparse
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
from td_call import run as td_run  # noqa: E402

SCRATCH = "/project1/_hard_perf"
WORK = os.path.join(tempfile.gettempdir(), "hard_perf_work")
os.makedirs(WORK, exist_ok=True)
PRELUDE = '''
from td import *
import sys, types, json, time
import numpy as np
def _emit(o): print("@@" + json.dumps(o))
def _st(): return sys.modules["hp_state"]
'''


def td(code: str, timeout: float = 300):
    res = td_run(PRELUDE + textwrap.dedent(code), timeout=timeout)
    out = res.get("stdout", "") or ""
    if not res.get("ok"):
        raise RuntimeError("TD error: " + (res.get("traceback") or json.dumps(res))[:3000] + "\n" + out[-2000:])
    ret = None
    for line in out.splitlines():
        if line.startswith("@@"):
            ret = json.loads(line[2:])
    return ret


def src(ref: str, name: str) -> str:
    path = f"td/raster_editor/{name}"
    if ref == "WORKTREE":
        return open(os.path.join(ROOT, path), encoding="utf-8").read()
    return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT).decode()


def setup(ref: str, w: int, h: int) -> None:
    net_src, glsl_src, shape_src = src(ref, "network.py"), src(ref, "blend.glsl"), src(ref, "shape.glsl")
    td(f'''
p = op("/project1")
if p.op("_hard_perf"): p.op("_hard_perf").destroy()
c = p.create(baseCOMP, "_hard_perf")
stub = c.create(textDAT, "ext_stub")
stub.text = """
import sys
import numpy as np
class Stub:
    def __init__(self, owner):
        self.owner = owner
    def OnSurfaceCook(self, scriptOp):
        st = sys.modules["hp_state"]
        slot = int(scriptOp.name[1:])
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
st = types.ModuleType("hp_state"); sys.sys = sys; sys.modules["hp_state"] = st
st.buffers = {{}}
st.comp = c
st.net = net_mod.DocNetwork(c, {glsl_src!r}, shape_glsl={shape_src!r})
st.w, st.h = {w}, {h}
st.prev = {{}}
_emit("ok")
''')


def teardown() -> None:
    td('''
p = op("/project1")
if p.op("_hard_perf"): p.op("_hard_perf").destroy()
for m in ("hp_state", "re_network"):
    sys.modules.pop(m, None)
_emit("ok")
''')


# --------------------------------------------------------------------------- document

RED = {"r": 230, "g": 40, "b": 30, "a": 255}
BLUE = {"r": 20, "g": 60, "b": 220, "a": 200}


def layer(id_, kind="pixel", **kw):
    d = dict(id=id_, kind=kind, parentId=None, name=id_, visible=True, opacity=1.0, blend="normal", x=0, y=0, sx=1.0, sy=1.0,
             surfaceW=None, surfaceH=None, slot=None, mask=None, adjustment=None, text=None, shape=None)
    d.update(kw)
    return d


def big_doc(W, H, blur_radius=8, with_blur=True, n_full=6, n_half=8, n_small=8, n_shape=4, n_text=4):
    """base + n_full full-size layers + n_half 1920x1080 layers at 2x + n_small 800x600 (0.5x / 1.5x) layers,
    4 masks, 3 adjustments (hueSaturation, blur, levels), shapes, text.  Returns (layers, buffers{slot: (w, h)})."""
    ls = [layer("base", "base")]
    sizes: dict[int, tuple[int, int]] = {}
    slot = 1
    blends = ("normal", "multiply", "screen", "overlay", "soft-light", "normal", "hue")
    plan = [(W, H, 1.0)] * n_full + [(W // 2, H // 2, 2.0)] * n_half + [(800, 600, 0.5)] * (n_small // 2) + [(800, 600, 1.5)] * (n_small - n_small // 2)
    masked = {1, 7, 9, 15}
    for i, (sw, sh, sc) in enumerate(plan):
        kw = dict(slot=slot, surfaceW=sw, surfaceH=sh, sx=sc, sy=sc, blend=blends[i % len(blends)], opacity=0.85,
                  x=float((i * 37) % 400) + 0.5 * (sc != 1.0), y=float((i * 53) % 300) + 0.25 * (sc != 1.0))
        sizes[slot] = (sw, sh)
        if i in masked:
            kw["mask"] = {"slot": 100 + i, "enabled": True}
            sizes[100 + i] = (sw, sh)
        ls.append(layer(f"p{i}", **kw))
        slot += 1
        if i == 8:
            ls.append(layer("a_hue", "adjustment", adjustment={"type": "hueSaturation", "hue": 20, "saturation": 1.2, "value": 1.0}, opacity=0.9))
        if i == 14 and with_blur:
            ls.append(layer("a_blur", "adjustment", adjustment={"type": "blur", "radius": blur_radius}, opacity=1.0))
    ls.append(layer("a_lev", "adjustment", adjustment={"type": "levels", "inLow": 0.05, "inHigh": 0.95, "gamma": 1.2, "outLow": 0.0, "outHigh": 1.0}))
    for i in range(n_shape):
        if i % 2:
            sp = {"type": "ellipse", "x": 300.0 + 700 * i, "y": 400.0 + 200 * i, "w": 900.0, "h": 600.0, "fill": {"enabled": True, "color": RED},
                  "stroke": {"enabled": True, "color": BLUE, "width": 12.0}, "rotation": 10.0 * i}
        else:
            sp = {"type": "rect", "x": 300.0 + 700 * i, "y": 400.0 + 200 * i, "w": 900.0, "h": 600.0, "radius": 40.0, "fill": {"enabled": True, "color": RED},
                  "stroke": {"enabled": True, "color": BLUE, "width": 12.0}, "rotation": 10.0 * i}
        ls.append(layer(f"s{i}", "shape", shape=sp))
    for i in range(n_text):
        ls.append(layer(f"t{i}", "text", text={"text": f"Hardening layer {i}\nsecond line", "font": "Helvetica", "size": 120.0,
                                              "color": {"r": 255, "g": 255, "b": 255, "a": 255}, "align": "left", "bold": True, "italic": False,
                                              "lineHeight": 1.2, "x": 200.0 + 800 * i, "y": 200.0 + 300 * i, "boxWidth": None}))
    return ls, sizes


def upload_buffers(sizes):
    """Random-ish content tiled to each slot's size, premultiplied-looking noise; held by the stand-in extension."""
    td(f'''
st = _st(); rng = np.random.default_rng(1)
tile = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
tile[..., :3] = (tile[..., :3].astype(np.uint16) * tile[..., 3:4] // 255).astype(np.uint8)
st.buffers.clear()
for s, (w, h) in {json.dumps({str(k): v for k, v in sizes.items()})}.items():
    st.buffers[int(s)] = np.ascontiguousarray(np.tile(tile, (h // 64 + 1, w // 64 + 1, 1))[:h, :w])
_emit(len(st.buffers))
''', timeout=600)


def apply(layers, w, h):
    return td(f'''
st = _st()
t0 = time.perf_counter()
st.net.apply(json.loads({json.dumps(json.dumps(layers))}), {w}, {h})
dt = (time.perf_counter() - t0) * 1e3
st.w, st.h = {w}, {h}
_emit({{"ms": dt, "stats": st.net.stats()}})
''')


def settle():
    return td('''
net = _st().net
n = 0
while n < 400:
    s = net.stats()
    if not (s["garbage"] or s["junk"]) and s["pool"] >= 6 and not net._pending: break
    net.tick(); n += 1
_emit(n)
''', timeout=600)


# Probe: (1) cost of everything that cooked since the previous call (gpuCookTime resolves a frame late),
# (2) snapshot, (3) action.  ``ACTION`` is python text run after the snapshot.
SAMPLE = '''
st = _st(); net = st.net
tops = [c for c in net.doc.children if c.isTOP]
prev = st.prev
cooked = [c for c in tops if c.totalCooks != prev.get(c.name, -1)]
rec = {{"gpu": sum(c.gpuCookTime for c in cooked), "cpu": sum(c.cpuCookTime for c in cooked), "n": len(cooked),
       "by": {{(c.comment or c.name): round(c.gpuCookTime, 3) for c in cooked if c.gpuCookTime > 0.05}},
       "kinds": {{}}}}
for c in cooked:
    k = c.OPType
    rec["kinds"][k] = round(rec["kinds"].get(k, 0) + c.gpuCookTime, 3)
st.prev = {{c.name: c.totalCooks for c in tops}}
t0 = time.perf_counter()
{action}
rec["action_ms"] = (time.perf_counter() - t0) * 1e3
_emit(rec)
'''


def sample(action: str, n: int, skip: int = 4, timeout=300):
    rows = [td(SAMPLE.format(action=textwrap.dedent(action)), timeout=timeout) for _ in range(n)][skip:]
    g = np.array([r["gpu"] for r in rows])
    out = {"gpu_med": float(np.median(g)), "gpu_max": float(g.max()), "gpu_min": float(g.min()),
           "cpu_med": float(np.median([r["cpu"] for r in rows])), "cooked_med": float(np.median([r["n"] for r in rows])),
           "action_ms_med": float(np.median([r["action_ms"] for r in rows])), "by": rows[-1]["by"], "kinds": rows[-1]["kinds"]}
    return out


FORCE_ALL = "net.surface_top(1).cook(force=True); net.output().cook(force=True)"


def fmt(r):
    return (f"gpu median {r['gpu_med']:.2f} ms (min {r['gpu_min']:.2f}, max {r['gpu_max']:.2f}); cpu cook {r['cpu_med']:.2f} ms; "
            f"{r['cooked_med']:.0f} nodes cooked; action {r['action_ms_med']:.2f} ms")


def top_by(by, k=8):
    return ", ".join(f"{n}={v}" for n, v in sorted(by.items(), key=lambda kv: -kv[1])[:k])


# --------------------------------------------------------------------------- sections

def sec_build(ctx):
    W, H = ctx["w"], ctx["h"]
    ls, sizes = big_doc(W, H)
    ctx["layers"], ctx["sizes"] = ls, sizes
    mb = sum(w * h * 4 for w, h in sizes.values()) / 1048576
    print(f"## document: {len(ls)} layers @ {W}x{H}, {len(sizes)} surface buffers, {mb:.0f} MB of RGBA8 surface data")
    r = td("import resource\n_emit(0)")
    upload_buffers(sizes)
    r = apply(ls, W, H)
    print(f"initial apply() (cold, creates nodes + surfaces): {r['ms']:.0f} ms; nodes={r['stats']['nodes']} surfaces={r['stats']['surfaces']} by_type={r['stats']['by_type']}")
    n = settle()
    print(f"settle() needed {n} ticks")


def sec_gpu(ctx):
    r = sample(FORCE_ALL, 30)
    ctx["full_gpu"] = r
    print(f"FULL chain recook (bottom surface dirty): {fmt(r)}")
    print(f"  by node kind: {r['kinds']}")
    print(f"  heaviest nodes: {top_by(r['by'])}")


def sec_idle(ctx):
    r = sample("pass", 30, skip=6)
    print(f"IDLE (no edits, no forcing): {fmt(r)}")
    t = td('''
net = _st().net
ts = []
for _ in range(100):
    t0 = time.perf_counter(); net.tick(); ts.append((time.perf_counter() - t0) * 1e3)
_emit({"med": float(np.median(ts)), "max": max(ts)})
''')
    print(f"tick() housekeeping when idle: median {t['med']:.3f} ms, max {t['max']:.3f} ms")


def sec_update(ctx):
    """One layer's pixels change (new surface buffer + Script TOP cook), as during a stroke."""
    sizes = ctx["sizes"]
    for label, slot in (("full-size layer p5 (slot 6, 3840x2160; 27 layers above it)", 6),
                        ("bottom full-size layer p0 (slot 1; everything above recooks)", 1),
                        ("a 1920x1080 layer drawn at 2x (p9, slot 10)", 10),
                        ("a small 800x600 layer (p15, slot 16)", 16)):
        w, h = sizes[slot]
        act = f"""
        b = st.buffers[{slot}]
        b[100:356, 100:356, 0] ^= 1      # a 256x256 'dab' region changes in the source buffer
        t = net.surface_top({slot}); t.cook(force=True)
        net.output().cook(force=True)
        """
        r = sample(act, 24)
        print(f"UPDATE {label}: {fmt(r)}")
        print(f"  heaviest nodes: {top_by(r['by'], 5)}")


def sec_apply(ctx):
    W, H = ctx["w"], ctx["h"]
    base = ctx["layers"]
    apply(base, W, H)
    settle()

    def med(a):
        return float(np.median(a))

    def run(mutate, n=12):
        cur = json.loads(json.dumps(base))
        out = []
        for i in range(n):
            mutate(cur, i)
            out.append(apply(cur, W, H)["ms"])
        return out

    def by_id(cur, id_):
        return next(l for l in cur if l["id"] == id_)

    cases = {
        "opacity": lambda c, i: by_id(c, "p3").__setitem__("opacity", 0.3 + 0.04 * i),
        "blend mode": lambda c, i: by_id(c, "p4").__setitem__("blend", ("multiply", "screen", "overlay", "hue")[i % 4]),
        "visibility toggle": lambda c, i: by_id(c, "p2").__setitem__("visible", i % 2 == 0),
        "integer offset": lambda c, i: by_id(c, "p5").__setitem__("x", float(i)),
        "scale drag (resample layer)": lambda c, i: by_id(c, "p9").__setitem__("sx", 2.0 + 0.01 * i) or by_id(c, "p9").__setitem__("sy", 2.0 + 0.01 * i),
        "hue adjustment param": lambda c, i: by_id(c, "a_hue")["adjustment"].__setitem__("hue", 10 + i),
        "blur radius drag": lambda c, i: by_id(c, "a_blur")["adjustment"].__setitem__("radius", 8 + i),
        "shape move": lambda c, i: by_id(c, "s1")["shape"].__setitem__("x", 1000.0 + i),
        "shape rotate": lambda c, i: by_id(c, "s0")["shape"].__setitem__("rotation", 10.0 + i),
        "text move": lambda c, i: by_id(c, "t0")["text"].__setitem__("x", 200.0 + i),
        "text colour": lambda c, i: by_id(c, "t1")["text"]["color"].__setitem__("g", 20 + i),
    }
    for name, mut in cases.items():
        t = run(mut)
        print(f"apply() {name:30s} median {med(t):7.2f} ms  max {max(t):7.2f} ms")
    t_same = [apply(base, W, H)["ms"] for _ in range(8)]
    print(f"apply() identical stack                median {med(t_same):7.3f} ms")
    # structural: add / delete a layer
    settle()
    extra = layer("pn", slot=900, surfaceW=800, surfaceH=600, x=50.0, y=50.0)
    td(f'_st().buffers[900] = np.zeros((600, 800, 4), np.uint8); _emit(1)')
    ra = apply(base[:10] + [extra] + base[10:], W, H)["ms"]
    settle()
    rd = apply(base, W, H)["ms"]
    settle()
    print(f"apply() add one 800x600 layer          {ra:7.2f} ms; delete it {rd:7.2f} ms")
    sh = layer("sn", "shape", shape=json.loads(json.dumps(by_id(base, "s0")["shape"])))
    ra2 = apply(base + [sh], W, H)["ms"]
    settle()
    print(f"apply() add one shape layer            {ra2:7.2f} ms")
    apply(base, W, H)
    settle()
    # doc-size change = full rebuild
    r = apply(base, W, H)
    print(f"apply() re-apply after settle          {r['ms']:7.3f} ms")


def sec_memory(ctx):
    r = td('''
st = _st(); net = st.net
tops = [c for c in net.doc.children if c.isTOP]
def bpp(c):
    f = str(c.pixelFormat)
    import re
    m = re.search(r"(\\d+)", f)
    bits = int(m.group(1)) if m else 8
    ch = 4 if "rgba" in f.lower() else 1 if f.lower().startswith(("mono", "r")) else 4
    return bits * ch / 8
tot = 0; by = {}; fmts = {}
for c in tops:
    b = c.width * c.height * bpp(c)
    tot += b
    by[c.OPType] = by.get(c.OPType, 0) + b
    fmts[str(c.pixelFormat)] = fmts.get(str(c.pixelFormat), 0) + 1
bufmb = sum(a.nbytes for a in st.buffers.values()) / 1048576
import resource, os
rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
gpu = None
try:
    gpu = app.gpuMemory if hasattr(app, "gpuMemory") else None
except Exception as e:
    gpu = str(e)
_emit({"n": len(tops), "tops_mb": tot / 1048576, "by_mb": {k: round(v / 1048576) for k, v in by.items()}, "fmts": fmts,
       "numpy_buffers_mb": bufmb, "ru_maxrss": rss, "gpu": gpu, "pid": os.getpid()})
''')
    rss_now = subprocess.run(["ps", "-o", "rss=", "-p", str(r["pid"])], capture_output=True, text=True).stdout.strip()
    print(f"MEMORY: {r['n']} TOPs, estimated GPU texture memory (w*h*bytes/pixel) {r['tops_mb']:.0f} MB; by node type (MB): {r['by_mb']}")
    print(f"        pixel formats: {r['fmts']}")
    print(f"        stand-in numpy surface buffers (CPU, would be the ext's mirrors): {r['numpy_buffers_mb']:.0f} MB;"
          f" TD process RSS now {int(rss_now or 0) / 1024:.0f} MB; app.gpuMemory={r['gpu']}")
    ctx["mem"] = r


def sec_offenders(ctx):
    W, H = ctx["w"], ctx["h"]
    ls = ctx["layers"]

    def variant(name, mutate):
        cur = json.loads(json.dumps(ls))
        mutate(cur)
        apply(cur, W, H)
        settle()
        r = sample(FORCE_ALL, 24, skip=6)
        print(f"VARIANT {name:55s} gpu median {r['gpu_med']:.2f} ms  max {r['gpu_max']:.2f}  nodes {r['cooked_med']:.0f}")
        return r

    def by_id(cur, id_):
        return next(l for l in cur if l["id"] == id_)

    base = variant("baseline (blur r=8)", lambda c: None)
    ctx["variants"] = {"baseline": base}
    nb = variant("no blur adjustment", lambda c: c.remove(by_id(c, "a_blur")))
    b100 = variant("blur radius 100", lambda c: by_id(c, "a_blur")["adjustment"].__setitem__("radius", 100))
    b400 = variant("blur radius 400", lambda c: by_id(c, "a_blur")["adjustment"].__setitem__("radius", 400))

    def no_shapes_text(c):
        for l in [l for l in c if l["kind"] in ("shape", "text")]:
            c.remove(l)
    variant("no shape / text layers", no_shapes_text)

    def drop_scaled(c):
        for l in c:
            if l["kind"] == "pixel" and (l["sx"] != 1.0 or l["x"] != int(l["x"]) or l["y"] != int(l["y"])):
                l["sx"] = l["sy"] = 1.0
                l["x"] = float(int(l["x"]))
                l["y"] = float(int(l["y"]))
    variant("all layers integer-offset / unscaled (exact path)", drop_scaled)

    def minify(c):
        for l in c:
            if l["kind"] == "pixel" and l["surfaceW"] == W:
                l["sx"] = l["sy"] = 0.45
    variant("6 full-size layers minified to 0.45x (mipmap)", minify)

    def no_masks(c):
        for l in c:
            l["mask"] = None
    variant("masks removed", no_masks)
    d = (base["gpu_med"] - nb["gpu_med"])
    print(f"=> blur(8) adds {d:.2f} ms; blur(100) adds {b100['gpu_med'] - nb['gpu_med']:.2f} ms; blur(400) adds {b400['gpu_med'] - nb['gpu_med']:.2f} ms")
    print("per-layer GPU cost for the shape / text nodes: see 'heaviest nodes' list of the baseline gpu section")


SECTIONS = ("build", "gpu", "idle", "update", "apply", "memory", "offenders")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="v0.4.0")
    ap.add_argument("--w", type=int, default=3840)
    ap.add_argument("--h", type=int, default=2160)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--only", default=",".join(SECTIONS))
    a = ap.parse_args()
    todo = a.only.split(",")
    ctx = {"w": a.w, "h": a.h}
    setup(a.ref, a.w, a.h)
    try:
        sec_build(ctx)
        for s in SECTIONS[1:]:
            if s in todo:
                print(f"\n=== {s} ===")
                globals()["sec_" + s](ctx)
    finally:
        if not a.keep:
            teardown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
