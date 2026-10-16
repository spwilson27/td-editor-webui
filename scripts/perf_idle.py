"""Idle / performance-mode cost of a FINISHED document with no browser connected (docs/PERF_IDLE.md).

    .venv/bin/python scripts/perf_idle.py [--res 1080,2160] [--only S1,S2mid,S2bot,S3top,S3mid] [--frames 300] [--keep]
                                          [--conn CONNFILE] [--out FILE.json]

Launches ONE isolated TouchDesigner (td_workers.Fleet; the user's TD on 8765 is never touched; with --conn it uses an instance you
already started, e.g. kept by td_workers --keep), builds dist/raster_editor.tox into it, then for each scenario and resolution:

  * builds a 27-layer document (20 pixel layers, 5 masks, 3 adjustments, 4 layers with effects, 2 text, 2 shape; mixed blends) through the
    extension's own doc apply path (`_apply_doc`) and fills the numpy surface buffers directly (no browser, no WebSocket client),
  * pulls the component's output into a Null TOP every frame (an Execute DAT cooks it at frame end, like a window showing it),
  * measures over N frames: per-frame Python time in the component (Pump + every pump step, via wrappers installed on the class of the
    isolated instance only), which TOPs/DATs cook every frame (totalCooks diff over ALL nodes), their cpu/gpu cook times, process CPU,
    achieved frame rate, memory (numpy surfaces, TD's gpuMemory/cpuMemory, naive width*height*bpp), and the cost of cookRate 30 / 60 / uncapped.

Scenarios: S1 static; S2mid / S2bot / S2top a TD input layer fed by an animated Noise TOP in the middle / at the bottom / at the top of the stack;
S3top / S3mid a layer opacity animated through the doc (no effect/filter in shared/effects has a time parameter: all are static).

Only the isolated instance is changed (cookRate, wrapped methods, scratch ops under /project1). The instance is killed at the end unless
--keep. Nothing is committed or saved; dist/raster_editor.tox is rewritten by the build step (restore it with git checkout).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import td_call  # noqa: E402
import td_workers as W  # noqa: E402

COMP = "/project1/raster_editor"
CONN = None   # td-mcp Connection of the instance under test


def td(code, timeout=120):
    res = td_call.run("from td import *\nimport json\n" + code, timeout, CONN)
    if not res.get("ok"):
        raise RuntimeError((res.get("traceback") or json.dumps(res))[-2500:])
    ret = None
    for line in (res.get("stdout") or "").splitlines():
        if line.startswith("@@"):
            ret = json.loads(line[2:])
    return ret


def footprint(pid):
    """macOS `footprint -p`: (total MB, {category: dirty MB}) -- counts compressed pages, unlike ps rss; IOAccelerator = GPU memory."""
    out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True, timeout=60).stdout
    import re
    tot = re.search(r"Footprint:\s+([\d.]+)\s*(MB|GB|KB)", out)
    mult = {"KB": 1 / 1024, "MB": 1, "GB": 1024}
    cats = {}
    for line in out.splitlines():
        m = re.match(r"\s*([\d.]+) (B|KB|MB|GB)\s+([\d.]+ \w+)\s+([\d.]+ \w+)\s+(\d+)\s+(\S.*)$", line)
        if m:
            v = float(m.group(1)) * {"B": 1 / 1048576, "KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]
            cats[m.group(6).strip()] = round(v, 1)
    return {"total_mb": round(float(tot.group(1)) * mult[tot.group(2)], 1) if tot else None,
            "gpu_mb": cats.get("IOAccelerator (graphics)"), "malloc_large_mb": cats.get("MALLOC_LARGE"), "malloc_medium_mb": cats.get("MALLOC_MEDIUM"),
            "iosurface_mb": cats.get("IOSurface")}


def h(expr, timeout=120):
    """Evaluate an expression of the harness module inside TD, JSON result."""
    return td(f"import sys, json\nH = sys.modules['perfh']\nprint('@@' + json.dumps({expr}, default=str))", timeout)


# --------------------------------------------------------------------------- code that runs INSIDE TouchDesigner

HARNESS = r'''
import sys, time, json, re, collections
import numpy as np
from td import *
pc = time.perf_counter
COMP = "/project1/raster_editor"
STEPS = ["Pump", "_pump", "_check_modules", "_router_tick", "_sync_doc_size", "_sync_hints", "_poll_base", "_poll_view",
         "_poll_layer_previews", "_notify_clients", "_tick_tops", "_cook_surfaces", "_poll_view11", "_tick_files", "_tick_choose",
         "_replay_step", "_reencode_one", "_check_frozen", "_tick_network", "_flush_if_dirty", "_update_switch", "_update_status",
         "_rescan", "_check_server", "_scan_inputs", "_ensure_input_ops", "_flush_doc_state"]
NET_STEPS = ["tick", "apply"]
running = False
sample_cooks = False
acc = {}
pump_t = []
fx_t = []
ivals = []
pull_t = []
anim_t = []
frames = 0
last_fs = None
t_first = None
cpu0 = 0.0
wall0 = 0.0
pull = None
anim = None
watch = {}
cooks0 = {}
orig_fx = None


def comp():
    return op(COMP)


def ext():
    return comp().ext.RasterEditorExt


def _wrap(cls, name, tag):
    key = "_perf_orig_" + name
    orig = cls.__dict__.get(key)
    if orig is None:
        orig = getattr(cls, name)
        setattr(cls, key, orig)
    def w(self, *a, **k):
        t = pc()
        try:
            return orig(self, *a, **k)
        finally:
            if running:
                d = pc() - t
                r = acc.setdefault(tag, [0, 0.0, 0.0])
                r[0] += 1
                r[1] += d
                if d > r[2]:
                    r[2] = d
                if name == "Pump" and tag == "Pump":
                    pump_t.append(d)
    w.__name__ = name
    setattr(cls, name, w)


def _unwrap(cls, name):
    key = "_perf_orig_" + name
    orig = cls.__dict__.get(key)
    if orig is not None:
        setattr(cls, name, orig)
        delattr(cls, key)


def wrap_on():
    e = ext()
    cls = type(e)
    for n in STEPS:
        if hasattr(cls, n):
            _wrap(cls, n, n)
    if e.network is not None:
        ncls = type(e.network)
        for n in NET_STEPS:
            if hasattr(ncls, n):
                _wrap(ncls, n, "net." + n)


def wrap_off():
    e = ext()
    for n in STEPS:
        _unwrap(type(e), n)
    if e.network is not None:
        for n in NET_STEPS:
            _unwrap(type(e.network), n)


def set_pump(on):
    comp().op("frame_exec").par.active = 1 if on else 0


_cs = {}


def set_server(on):
    """Stop / start the master's Web Server DAT with the health check neutralised (isolated instance only)."""
    e = ext()
    cls = type(e)
    if not on:
        if "orig" not in _cs:
            _cs["orig"] = cls.__dict__["_check_server"] if "_perf_orig__check_server" not in cls.__dict__ else cls.__dict__["_perf_orig__check_server"]
        if "_perf_orig__check_server" in cls.__dict__:
            _unwrap(cls, "_check_server")
        cls._check_server = lambda self: None
        comp().op("webserver").par.active = 0
    else:
        if "orig" in _cs:
            cls._check_server = _cs.pop("orig")
        comp().op("webserver").par.active = 1


def install():
    wrap_on()
    # frame_exec: time the whole onFrameStart callback (includes the promoted-call dispatch)
    global orig_fx
    fe = comp().op("frame_exec")
    if orig_fx is None:
        orig_fx = fe.text
    src = orig_fx.replace("def onFrameStart(frame):\n    parent().Pump()",
        "def onFrameStart(frame):\n    import sys\n    h = sys.modules.get('perfh')\n    if h is None or not h.running:\n        parent().Pump()\n        return\n"
        "    t = h.pc()\n    parent().Pump()\n    h.fx_t.append(h.pc() - t)")
    assert src != orig_fx
    fe.text = src
    ex = op("/project1/_perf_exec")
    if ex is None:
        ex = op("/project1").create(executeDAT, "_perf_exec")
    ex.text = ("def onFrameStart(frame):\n    import sys\n    sys.modules['perfh'].fs(frame)\n"
               "def onFrameEnd(frame):\n    import sys\n    sys.modules['perfh'].fe(frame)\n")
    ex.par.framestart = 1
    ex.par.frameend = 1
    ex.par.active = 1


def uninstall():
    global running
    running = False
    wrap_off()
    if "orig" in _cs:
        set_server(True)
    set_pump(True)
    if orig_fx is not None:
        comp().op("frame_exec").text = orig_fx
    ex = op("/project1/_perf_exec")
    if ex is not None:
        ex.destroy()


def snap(extra=()):
    c = comp()
    d = {}
    for o in list(c.findChildren(maxDepth=12)) + [x for x in extra if x is not None]:
        try:
            d[o.path] = o.totalCooks
        except Exception:
            pass
    return d


def fs(frame):
    global last_fs, frames, t_first
    if not running:
        return
    t = pc()
    if last_fs is not None:
        ivals.append(t - last_fs)
    else:
        t_first = t
    last_fs = t
    frames += 1
    if sample_cooks:
        for rec in watch.values():
            o = rec[0]
            tc = o.totalCooks
            if tc != rec[1]:
                rec[1] = tc
                rec[2] += 1
                c = o.cpuCookTime
                g = o.gpuCookTime
                rec[3] += c
                rec[4] += g
                if g > rec[5]:
                    rec[5] = g
    if anim is not None:
        t2 = pc()
        anim(frames)
        anim_t.append(pc() - t2)


def fe(frame):
    if running and pull is not None:
        t = pc()
        pull.cook()
        pull_t.append(pc() - t)
    elif pull is not None:
        pull.cook()


def start(sample=False, watch_paths=()):
    global running, sample_cooks, frames, last_fs, cooks0, cpu0, wall0, watch
    acc.clear(); pump_t.clear(); fx_t.clear(); ivals.clear(); pull_t.clear(); anim_t.clear()
    frames = 0
    last_fs = None
    sample_cooks = bool(sample)
    watch = {p: [op(p), op(p).totalCooks, 0, 0.0, 0.0, 0.0] for p in watch_paths if op(p) is not None}
    cooks0 = snap([pull])
    cpu0 = time.process_time()
    wall0 = pc()
    running = True


def progress():
    return {"n": frames, "wall": pc() - wall0 if running else 0}


def _stats(xs):
    if not xs:
        return {"n": 0}
    a = np.array(xs) * 1000.0
    return {"n": len(a), "mean": float(a.mean()), "p50": float(np.percentile(a, 50)), "p95": float(np.percentile(a, 95)),
            "p99": float(np.percentile(a, 99)), "max": float(a.max()), "sum": float(a.sum())}


def stop():
    global running
    running = False
    wall = pc() - wall0
    cpu = time.process_time() - cpu0
    c1 = snap([pull])
    cookers = {}
    for p, v in c1.items():
        d = v - cooks0.get(p, v)
        if d > 0:
            o = op(p)
            cookers[p] = {"type": o.OPType, "cooks": d}
            if o.family == "TOP":
                cookers[p].update({"w": o.width, "h": o.height, "fmt": str(o.pixelFormat)})
            if p in watch:
                r = watch[p]
                cookers[p].update({"cpu_ms_sum": r[3], "gpu_ms_sum": r[4], "gpu_ms_max": r[5], "sampled": r[2]})
    steps = {k: {"calls": v[0], "mean_us_per_frame": v[1] / max(1, frames) * 1e6, "mean_us_per_call": v[1] / max(1, v[0]) * 1e6,
                 "max_us": v[2] * 1e6, "total_ms": v[1] * 1e3} for k, v in acc.items()}
    return {"frames": frames, "wall_s": wall, "fps": frames / wall if wall else 0, "cpu_s": cpu, "cpu_percent_of_core": 100 * cpu / wall if wall else 0,
            "interval_ms": _stats(ivals), "pump_ms": _stats(pump_t), "frame_exec_ms": _stats(fx_t), "pull_cook_ms": _stats(pull_t),
            "anim_ms": _stats(anim_t), "steps": steps, "cookers": cookers, "cookrate": project.cookRate}


# ---------------------------------------------------------------- document

def set_doc(layers_json, rev):
    """The extension's own apply path for a client `doc` message (validated by protocol.parse_doc)."""
    e = ext()
    msg = {"rev": rev, "layers": json.loads(layers_json)}
    rev, layers = e.protocol.parse_doc(msg, e._fx())
    e._apply_doc(rev, layers)
    return len(layers)


def fill(slot, seed, is_mask):
    e = ext()
    b = e.surfaces[slot]
    hh, ww = b.shape[:2]
    rng = np.random.default_rng(seed)
    if is_mask:
        g = np.linspace(40, 255, ww).astype(np.uint8)[None, :]
        b[..., 0] = g; b[..., 1] = g; b[..., 2] = g; b[..., 3] = 255
        return
    # incompressible content (photo-like): macOS compresses idle pages, so a tiled pattern would hide the real footprint
    arr = np.frombuffer(rng.bytes(hh * ww * 4), np.uint8).reshape(hh, ww, 4).copy()
    base = np.array([(seed * 53) % 200 + 30, (seed * 97) % 200 + 30, (seed * 29) % 200 + 30], np.int32)
    arr[..., :3] = np.clip(base + (arr[..., :3].astype(np.int32) >> 2), 0, 255).astype(np.uint8)
    arr[..., 3] = 255
    # painted region: 50..90 % of the surface, transparent elsewhere (a finished document has transparent parts)
    fw = 0.5 + 0.4 * rng.random(); fh = 0.5 + 0.4 * rng.random()
    x0 = int(rng.random() * ww * (1 - fw)); y0 = int(rng.random() * hh * (1 - fh))
    b[...] = 0
    reg = arr[y0:y0 + int(hh * fh), x0:x0 + int(ww * fw)].copy()
    reg[..., :3] = (reg[..., :3].astype(np.uint16) * reg[..., 3:4] // 255).astype(np.uint8)
    b[y0:y0 + reg.shape[0], x0:x0 + reg.shape[1]] = reg
    e._dirty.add(slot)


def fill_all(seed0=1):
    e = ext()
    n = 0
    for slot in sorted(e.surfaces):
        fill(slot, seed0 + slot, slot in e._mask_slots)
        e._dirty.add(slot)
        n += 1
    return n


def settled():
    e = ext()
    net = e.network
    s = net.stats()
    return {"dirty": len(e._dirty), "net_applied": bool(e._net_applied), "garbage": s.get("garbage"), "junk": s.get("junk"),
            "pool": s.get("pool"), "pending": len(getattr(net, "_pending", ()) or ()), "clients": len(e.clients),
            "restore": bool(e._restore_pending), "held": len(e._held)}


# ---------------------------------------------------------------- memory

def bpp(fmt):
    f = str(fmt).lower()
    m = re.match(r"(\d+)-bit", f)
    bits = int(m.group(1)) if m else 8
    if "rgba" in f or "rgb" in f:
        ch = 4
    elif "mono+alpha" in f or "(rg" in f:
        ch = 2
    else:
        ch = 1
    return bits // 8 * ch if bits >= 8 else ch


def _call(o, name):
    try:
        v = getattr(o, name)
        return v() if callable(v) else v
    except Exception as ex:
        return str(ex)


def memory():
    e = ext()
    c = comp()
    surf = {s: b.nbytes for s, b in e.surfaces.items()}
    tops = [o for o in c.findChildren(maxDepth=12) if o.family == "TOP"]
    rows = []
    tot_formula = tot_gpu = tot_cpu = 0
    by_type = collections.Counter()
    by_fmt = collections.Counter()
    n_fmt = collections.Counter()
    for o in tops:
        try:
            w, hh = o.width, o.height
            f = o.pixelFormat
            nb = w * hh * bpp(f)
            gm = o.gpuMemory
            cm = o.cpuMemory
        except Exception:
            continue
        tot_formula += nb
        tot_gpu += gm
        tot_cpu += cm
        by_type[o.OPType] += gm
        by_fmt[str(f)] += gm
        n_fmt[str(f)] += 1
        rows.append((gm, o.path, o.OPType, w, hh, str(f), nb, cm))
    rows.sort(reverse=True)
    allops = c.findChildren(maxDepth=12)
    # other large Python-side buffers held by the extension
    big = {}
    for k, v in e.__dict__.items():
        try:
            if isinstance(v, np.ndarray) and v.nbytes > 1 << 20:
                big[k] = v.nbytes
            elif isinstance(v, (bytes, bytearray)) and len(v) > 1 << 20:
                big[k] = len(v)
            elif hasattr(v, "msg") and v.msg is not None and len(v.msg) > 1 << 20:
                big[k + ".msg"] = len(v.msg)
        except Exception:
            pass
    for k, pipe in list(e.bases.items()):
        if pipe.msg is not None:
            big[f"bases[{k}].msg"] = len(pipe.msg)
    if e.out.msg is not None:
        big["out.msg"] = len(e.out.msg)
    return {"numpy_surface_bytes": sum(surf.values()), "n_surfaces": len(surf), "n_masks": len(e._mask_slots),
            "gpu_formula_bytes": tot_formula, "gpu_reported_bytes": tot_gpu, "cpu_reported_bytes": tot_cpu,
            "comp_children_gpu": _call(c.op("doc"), "childrenGPUMemory"), "comp_children_cpu": _call(c.op("doc"), "childrenCPUMemory"),
            "nodes": len(allops), "tops": len(tops), "doc_nodes": len(c.op("doc").children) if c.op("doc") is not None else 0,
            "top_rows": [list(r) for r in rows[:8]], "gpu_by_type": dict(by_type.most_common(8)), "gpu_by_format": dict(by_fmt), "n_by_format": dict(n_fmt), "ext_big": big,
            "net_stats": {k: v for k, v in e.network.stats().items() if isinstance(v, (int, float, str))}}



# ---------------------------------------------------------------- experiments: freeze / drop numpy / rehydrate (one blocking call, no pump runs)

def pid():
    import os
    return os.getpid()


_x = {}


def _script_mem():
    c = comp()
    ts = [o for o in c.findChildren(maxDepth=12) if o.OPType == "scriptTOP"]
    return [sum(o.cpuMemory for o in ts), sum(o.gpuMemory for o in ts)]


def exp_freeze():
    """Phase 1: hash the buffers, Freeze() = lock every surface Script TOP with its buffer (what happens before a save)."""
    import hashlib
    e = ext()
    _x.clear()
    _x["hs"] = {s: hashlib.md5(b.tobytes()).hexdigest() for s, b in e.surfaces.items()}
    _x["sizes"] = {s: (b.shape[1], b.shape[0]) for s, b in e.surfaces.items()}
    e._check_frozen = lambda now: None      # instance attribute: the 2 s safety thaw must not undo the experiment between calls
    t = pc(); e.Freeze(); dt = (pc() - t) * 1e3
    return {"numpy_bytes": sum(b.nbytes for b in e.surfaces.values()), "freeze_ms": dt, "script_cpu_gpu": _script_mem()}


def exp_drop():
    """Phase 2: drop every numpy buffer (the Script TOPs hold the pixels on the GPU, locked)."""
    import gc
    e = ext()
    e.surfaces = {}
    gc.collect()
    return {"script_cpu_gpu": _script_mem()}


def exp_rehydrate(limit=None):
    """Phase 3: read the buffers back from the locked TOPs (the Restore path) and compare byte for byte."""
    import hashlib
    e = ext()
    new = {}
    per = []
    bad = []
    t = pc()
    for s, (w, hh) in list(_x["sizes"].items())[:limit]:
        top = e.network.surface_top(s)
        t0 = pc(); arr = top.numpyArray(); t1 = pc()
        buf = e.frames.from_float(arr, w, hh, s in e._mask_slots); t2 = pc()
        per.append((t1 - t0, t2 - t1))
        if hashlib.md5(buf.tobytes()).hexdigest() != _x["hs"][s]:
            bad.append(s)
        new[s] = buf
        del arr
    e.surfaces = new
    return {"n": len(per), "total_ms": (pc() - t) * 1e3, "readback_ms_per_slot": sum(p[0] for p in per) / len(per) * 1e3,
            "from_float_ms_per_slot": sum(p[1] for p in per) / len(per) * 1e3, "mismatch_slots": bad}


def exp_thaw():
    e = ext()
    t = pc(); e.Thaw(); dt = (pc() - t) * 1e3
    try:
        del e._check_frozen
    except AttributeError:
        pass
    e._dirty.update(e.surfaces)
    return {"thaw_ms": dt, "script_cpu_gpu": _script_mem()}


def callbacks():
    """Everything in the component that can run Python or cook per frame by itself."""
    c = comp()
    out = {"execute": [], "expr_pars": 0, "cook_every_frame": [], "script": []}
    for o in c.findChildren(maxDepth=12):
        t = o.OPType
        if t in ("executeDAT", "chopexecuteDAT", "datexecuteDAT", "parameterexecuteDAT", "panelexecuteDAT", "opexecuteDAT", "webserverDAT"):
            out["execute"].append((o.path, t))
        if t in ("scriptTOP", "scriptCHOP", "scriptDAT", "scriptSOP"):
            out["script"].append(o.path) if len(out["script"]) < 3 else None
        if getattr(o, 'allowCooking', True) and getattr(o, 'cookEveryFrame', False):
            out["cook_every_frame"].append(o.path)
        try:
            for p in o.pars():
                if p.mode == ParMode.EXPRESSION:
                    out["expr_pars"] += 1
        except Exception:
            pass
    out["n_script"] = sum(1 for o in c.findChildren(maxDepth=12) if o.OPType == "scriptTOP")
    return out
'''


def install_harness():
    code = f'''
import sys, types
m = types.ModuleType("perfh")
m.__dict__["__name__"] = "perfh"
exec(compile({HARNESS!r}, "perfh", "exec"), m.__dict__)
sys.modules["perfh"] = m
m.install()
print("@@" + "1")
'''
    td(code)


# --------------------------------------------------------------------------- documents

def layer(id_, kind="pixel", **kw):
    d = dict(id=id_, kind=kind, parentId=None, name=id_, visible=True, opacity=1.0, blend="normal", x=0, y=0, sx=1.0, sy=1.0, rot=0, kx=0, ky=0,
             effects=[], surfaceW=None, surfaceH=None, slot=None, mask=None, adjustment=None, text=None, shape=None)
    d.update(kw)
    return d


RED = {"r": 230, "g": 40, "b": 30, "a": 255}
BLUE = {"r": 20, "g": 60, "b": 220, "a": 200}


def fx(t, **kw):
    return dict(type=t, enabled=True, **kw)


def s1_doc(W, H):
    """27 layers, bottom first: 20 pixel (doc-size surfaces, 5 masks, 4 with effects), 3 adjustments, 2 shapes, 2 text; mixed blends."""
    blends = ["normal", "multiply", "screen", "overlay", "soft-light", "normal", "normal", "hard-light", "normal", "difference"]
    masked = {3, 7, 11, 15, 18}
    effects = {4: [fx("blur", radius=12.0)],
               9: [fx("dropShadow", blur=10.0, dx=20.0, dy=20.0, opacity=0.7, color={"r": 0, "g": 0, "b": 0, "a": 255})],
               13: [fx("dropShadow", blur=6.0, dx=8.0, dy=8.0, opacity=0.8, color={"r": 0, "g": 0, "b": 0, "a": 255}), fx("blur", radius=6.0)],
               17: [fx("posterize", levels=6)]}
    f = W / 1920.0
    ls = []
    slot = 1
    after = {
        5: [layer("s0", "shape", shape={"type": "rect", "x": 300.0 * f, "y": 300.0 * f, "w": 700.0 * f, "h": 400.0 * f, "radius": 30.0 * f,
                                         "fill": {"enabled": True, "color": RED}, "stroke": {"enabled": True, "color": BLUE, "width": 10.0 * f}, "rotation": 8.0})],
        8: [layer("a_hue", "adjustment", adjustment={"type": "hueSaturation", "hue": 20, "saturation": 1.2, "value": 1.0}, opacity=0.9)],
        10: [layer("t0", "text", text={"text": "Finished document\nsecond line", "font": "Helvetica", "size": 90.0 * f, "color": {"r": 255, "g": 255, "b": 255, "a": 255},
                                       "align": "left", "bold": True, "italic": False, "lineHeight": 1.2, "x": 200.0 * f, "y": 200.0 * f, "boxWidth": None})],
        12: [layer("a_blur", "adjustment", adjustment={"type": "blur", "radius": 8}, opacity=1.0)],
        14: [layer("s1", "shape", shape={"type": "ellipse", "x": 900.0 * f, "y": 500.0 * f, "w": 600.0 * f, "h": 400.0 * f,
                                          "fill": {"enabled": True, "color": BLUE}, "stroke": {"enabled": True, "color": RED, "width": 8.0 * f}, "rotation": 0.0})],
        19: [layer("a_lev", "adjustment", adjustment={"type": "levels", "inLow": 0.05, "inHigh": 0.95, "gamma": 1.2, "outLow": 0.0, "outHigh": 1.0}),
             layer("t1", "text", text={"text": "Top caption", "font": "Helvetica", "size": 60.0 * f, "color": {"r": 20, "g": 20, "b": 20, "a": 255},
                                       "align": "left", "bold": False, "italic": True, "lineHeight": 1.2, "x": 120.0 * f, "y": 900.0 * f, "boxWidth": None})],
    }
    for i in range(20):
        kw = dict(slot=slot, surfaceW=W, surfaceH=H, blend=blends[i % len(blends)], opacity=0.9 if i % 3 else 1.0,
                  x=float((i * 37) % 200), y=float((i * 53) % 150), effects=effects.get(i, []))
        if i % 6 == 5:
            kw["rot"] = 3.0
        slot += 1
        if i in masked:
            kw["mask"] = {"slot": 100 + i, "enabled": True}
        ls.append(layer(f"p{i}", **kw))
        ls.extend(after.get(i, []))
    return ls


def with_input(layers, where):
    """Insert a TD input layer (input 1) in the middle (above p9) or at the bottom of the stack."""
    live = layer("live", "input", input=1, name="TD Input 1", blend="normal", opacity=1.0)
    ls = list(layers)
    if where == "bot":
        return [live] + ls
    if where == "top":
        return ls + [live]
    idx = next(i for i, l in enumerate(ls) if l["id"] == "p9") + 1
    return ls[:idx] + [live] + ls[idx:]


# --------------------------------------------------------------------------- driver

def wait_settled(timeout=240, quiet=1.5):
    t0 = time.time()
    quiet_since = None
    last = None
    while time.time() - t0 < timeout:
        s = h("H.settled()")
        ok = s["dirty"] == 0 and s["net_applied"] and not s["restore"] and not s["held"] and not s["pending"] and not s["garbage"] and not s["junk"]
        last = s
        if ok:
            quiet_since = quiet_since or time.time()
            if time.time() - quiet_since >= quiet:
                return s
        else:
            quiet_since = None
        time.sleep(0.4)
    raise TimeoutError(f"document did not settle: {last}")


def run_frames(n, sample=False, watch=(), timeout=None):
    h(f"H.start({bool(sample)}, {list(watch)!r})")
    t0 = time.time()
    timeout = timeout or max(30, n / 5)
    while True:
        p = h("H.progress()")
        if p["n"] >= n:
            break
        if time.time() - t0 > timeout:
            break
        time.sleep(0.2)
    return h("H.stop()", 60)


def measure(n, cookrate=60, wrap=True, pre=True, watch=()):
    """wrap=True: step wrappers on (breakdown; cookers pre-pass of 60 frames, then the measured pass samples those nodes' cpu/gpu cook times).
    wrap=False: only the frame_exec callback is timed (authoritative total, no per-step overhead)."""
    td(f"if project.cookRate != {cookrate}:\n    project.cookRate = {cookrate}\nprint('@@1')")
    h("H.wrap_on()" if wrap else "H.wrap_off()")
    time.sleep(0.5)
    if pre:
        p = run_frames(60)
        watch = [k for k, v in p["cookers"].items() if v["type"].endswith("TOP")]
    return run_frames(n, sample=bool(watch), watch=watch)


def summarise(r):
    st = r["steps"]
    top = sorted(((k, v["mean_us_per_frame"]) for k, v in st.items() if k not in ("Pump", "_pump")), key=lambda x: -x[1])[:6]
    gpu = sum(v.get("gpu_ms_sum", 0) for v in r["cookers"].values()) / max(1, r["frames"])
    cpu = sum(v.get("cpu_ms_sum", 0) for v in r["cookers"].values()) / max(1, r["frames"])
    return {"fps": round(r["fps"], 2), "pump_mean_us": round(r["pump_ms"].get("mean", 0) * 1000, 1), "pump_p99_us": round(r["pump_ms"].get("p99", 0) * 1000, 1),
            "pump_max_us": round(r["pump_ms"].get("max", 0) * 1000, 1), "frame_exec_mean_us": round(r["frame_exec_ms"].get("mean", 0) * 1000, 1),
            "cpu_core_pct": round(r["cpu_percent_of_core"], 1), "n_cookers": len(r["cookers"]), "cook_gpu_ms_frame": round(gpu, 3),
            "cook_cpu_ms_frame": round(cpu, 3), "interval_p99_ms": round(r["interval_ms"].get("p99", 0), 2), "top_steps_us": [(k, round(v, 1)) for k, v in top]}


def build_component():
    env = dict(os.environ, TD_CALL_CONN_FILE=CONN_FILE)
    r = subprocess.run([sys.executable, os.path.join(ROOT, "td", "build_component.py")], capture_output=True, text=True, timeout=240, env=env, cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError(r.stdout[-1500:] + r.stderr[-1500:])


def setup_io(w, h_, live):
    td(f"""
from td import *
p = op('/project1'); c = op({COMP!r})
for n in ('_perf_noise', '_perf_null'):
    if p.op(n): p.op(n).destroy()
c.inputConnectors[0].disconnect() if c.inputConnectors[0].connections else None
c.par.Docsizemode = 'fixed'; c.par.Docw = {w}; c.par.Doch = {h_}
nl = p.create(nullTOP, '_perf_null')
nl.inputConnectors[0].connect(c.outputConnectors[0])
if {bool(live)}:
    n = p.create(noiseTOP, '_perf_noise')
    n.par.outputresolution = 'custom'; n.par.resolutionw = {w}; n.par.resolutionh = {h_}
    n.par.mono = 0
    n.par.tz.expr = 'absTime.seconds * 0.5'
    c.inputConnectors[0].connect(n)
import sys
H = sys.modules['perfh']
H.pull = nl
print('@@1')
""")


def wait_destroyed(timeout=30):
    """Surfaces of the previous document are destroyed after a 2 s grace; applying the next document while they are in that limbo hit a stale op once."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = h("H.ext().network.stats()")
        if not st["pending_destroy"] and not st["garbage"] and not st["junk"]:
            return
        time.sleep(0.5)
    time.sleep(1)


def apply_doc(layers, rev, fill_surfaces=True):
    try:
        h(f"H.set_doc({json.dumps(json.dumps(layers))}, {rev})")
    except RuntimeError:
        print("apply failed; fx_error:", h("H.ext().network.fx_error"), "stats:", h("H.ext().network.stats()"), flush=True)
        raise
    if fill_surfaces:
        # in slices (each call is one main-thread block)
        slots = h("sorted(H.ext().surfaces)")
        for i in range(0, len(slots), 4):
            part = slots[i:i + 4]
            td(f"""
import sys
H = sys.modules['perfh']; e = H.ext()
for s in {part}:
    H.fill(s, 1 + s, s in e._mask_slots)
print('@@1')
""", 120)


def run_instance(args, key, width, height, scen, fleet):
    """One resolution on a fresh isolated instance. Documents are switched by diff-applying the next one (never through an empty doc:
    an apply of the effect layers 6+ s after an empty-document apply raised KeyError 'fx_L_p4' in network._wire at v0.9.1)."""
    global CONN, CONN_FILE, PID
    inst = None
    if args.conn:
        CONN_FILE = os.path.abspath(args.conn)
        if CONN_FILE == os.path.abspath(W.USER_CONN_FILE):
            raise SystemExit("refusing: that is the user's TD connection")
    else:
        inst = W.launch_fleet(1, workroot=os.path.join(W.VDIR, "perf"), fleet=fleet)[0]
        CONN_FILE = inst.conn_file
    try:
        CONN = td_call.connection("127.0.0.1", None, CONN_FILE)
        print(f"[{key}] instance: {CONN_FILE}", flush=True)
        build_component()
        time.sleep(2)
        install_harness()
        PID = h("H.pid()")
        out = {"env": td("from td import *\nprint('@@' + json.dumps({'td': app.version + '.' + app.build, 'cookRate': project.cookRate}))"),
               "callbacks": h("H.callbacks()")}
        base = s1_doc(width, height)
        setup_io(width, height, False)
        time.sleep(3)
        out["empty"] = {"mem": h("H.memory()", 120), "fp": footprint(PID)}
        out["empty"]["l60"] = measure(args.frames, 60, wrap=False, pre=False)
        out["empty"]["suml60"] = summarise(out["empty"]["l60"])
        print(f"[{key} no document] {out['empty']['suml60']}", flush=True)
        rev = 100
        first = True
        for sc in scen:
            live = sc.startswith("S2")
            setup_io(width, height, live)
            layers = with_input(base, {"S2bot": "bot", "S2top": "top"}.get(sc, "mid")) if live else base
            t0 = time.time()
            rev += 1
            apply_doc(layers, rev, fill_surfaces=first)
            first = False
            s = wait_settled()
            print(f"[{key} {sc}] settled in {time.time() - t0:.0f}s: {s}", flush=True)
            time.sleep(2)
            if sc.startswith("S3"):
                pid_ = "p9" if sc == "S3mid" else "p19"
                td(f"""
import sys, json
H = sys.modules['perfh']; e = H.ext()
state = {{'rev': {rev}}}
def anim(f):
    state['rev'] += 1
    layers = [dict(l, opacity=0.5 + 0.5 * ((f % 60) / 60.0)) if l['id'] == {pid_!r} else l for l in e.doc_layers]
    e._apply_doc(state['rev'], layers)
H.anim = anim
print('@@1')
""")
            else:
                td("import sys\nsys.modules['perfh'].anim = None\nprint('@@1')")
            r = {"mem": h("H.memory()", 120), "fp": footprint(PID)}
            r["r60"] = measure(args.frames, 60)
            r["sum60"] = summarise(r["r60"])
            print(f"[{key} {sc}] 60fps wrapped: {r['sum60']}", flush=True)
            wl = [k for k, v in r["r60"]["cookers"].items() if v["type"].endswith("TOP")]
            r["l60"] = measure(args.frames, 60, wrap=False, pre=False, watch=wl)
            r["suml60"] = summarise(r["l60"])
            print(f"[{key} {sc}] 60fps light: {r['suml60']}", flush=True)
            if sc == "S1":
                # A/B of the process CPU at the default 60: component pump on / off / pump + web server off (alternating, two rounds).
                # Run BEFORE any cookRate change: afterwards TD's frame pacing stays in a busier state (see docs/PERF_IDLE.md).
                ab = {"pump_on": [], "pump_off": [], "pump_off_server_off": []}
                for rep in range(2):
                    for name, pump, server in (("pump_on", 1, 1), ("pump_off", 0, 1), ("pump_off_server_off", 0, 0)):
                        h(f"H.set_pump({pump})")
                        h(f"H.set_server({server})")
                        rr = measure(args.frames, 60, wrap=False, pre=False)
                        ab[name].append({"cpu_core_pct": rr["cpu_percent_of_core"], "fps": rr["fps"], "cpu_s": rr["cpu_s"], "wall_s": rr["wall_s"]})
                h("H.set_pump(1)")
                h("H.set_server(1)")
                r["ab"] = ab
                print(f"[{key} {sc}] A/B cpu%: " + json.dumps({k: [round(x['cpu_core_pct'], 1) for x in v] for k, v in ab.items()}), flush=True)
            td("import sys\nsys.modules['perfh'].anim = None\nprint('@@1')")
            if sc == "S1" and not args.no_experiment:
                x = {"fp0": footprint(PID)}
                x["freeze"] = h("H.exp_freeze()", 300)
                x["fp_frozen"] = footprint(PID)
                x["drop"] = h("H.exp_drop()")
                time.sleep(1)
                x["fp_dropped"] = footprint(PID)
                x["rehydrate"] = h("H.exp_rehydrate()", 600)
                x["fp_rehydrated"] = footprint(PID)
                x["thaw"] = h("H.exp_thaw()")
                r["experiment"] = x
                print(f"[{key} {sc}] experiment: {x}", flush=True)
                wait_settled()
                time.sleep(2)
            out[sc] = r
        if not args.no_rates:
            out["rates"] = {}
            for sc in ("S1", "S2mid"):
                if sc not in scen:
                    continue
                live = sc.startswith("S2")
                setup_io(width, height, live)
                rev += 1
                apply_doc(with_input(base, "mid") if live else base, rev, fill_surfaces=False)
                wait_settled()
                time.sleep(2)
                td("import sys\nsys.modules['perfh'].anim = None\nprint('@@1')")
                ph = {}
                wl = [k for k, v in out[sc]["r60"]["cookers"].items() if v["type"].endswith("TOP")]
                seq = [("60_first", 60, args.frames), ("30", 30, args.frames), ("60_after30", 60, args.frames), ("uncapped", 1000, args.frames * 2),
                       ("60_after_uncapped", 60, args.frames)]
                for name, rate, n in seq:
                    rr = measure(n, rate, wrap=False, pre=False, watch=wl)
                    ph[name] = {"raw": rr, "sum": summarise(rr)}
                    print(f"[{key} {sc} rate {name}] {ph[name]['sum']}", flush=True)
                out["rates"][sc] = ph
        td("project.cookRate = 60\nprint('@@1')")
        try:
            td("import sys\nsys.modules['perfh'].uninstall()\nprint('@@1')")
        except Exception as e:  # noqa: BLE001
            print("uninstall:", e)
        return out
    finally:
        if inst is not None and not args.keep:
            inst.terminate(fleet.protected)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--res", default="1080,2160", help="document heights (16:9), comma separated; each runs on its own fresh instance")
    ap.add_argument("--only", default="S1,S2mid,S2bot,S2top,S3top,S3mid")
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--conn", default=None, help="connection file of an already running ISOLATED instance (one resolution only)")
    ap.add_argument("--keep", action="store_true", help="leave the launched instance running (kill command is printed)")
    ap.add_argument("--no-experiment", action="store_true")
    ap.add_argument("--no-rates", action="store_true", help="skip the cookRate 30 / uncapped runs")
    ap.add_argument("--out", default=os.path.join(ROOT, ".validate", "perf_idle.json"))
    args = ap.parse_args()
    scen = args.only.split(",")
    results = {}
    with W.Fleet(keep=args.keep) as fleet:
        for height in [int(x) for x in args.res.split(",")]:
            width = height * 16 // 9
            key = f"{width}x{height}"
            results[key] = run_instance(args, key, width, height, scen, fleet)
            os.makedirs(os.path.dirname(args.out), exist_ok=True)
            with open(args.out, "w") as f:
                json.dump(results, f, indent=1)
    print("wrote", args.out)


CONN_FILE = None
PID = None

if __name__ == "__main__":
    main()
