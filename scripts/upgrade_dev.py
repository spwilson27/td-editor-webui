"""Live harness for td/raster_editor/upgrade.py (Upgrade All Editors) inside TouchDesigner.

    timeout 400 .venv/bin/python scripts/upgrade_dev.py [--keep] [--old PATH.tox] [--new PATH.tox]

Builds a scratch box /project1/_upg_box holding three editors (loaded with loadTox into the box, renamed):
  _upg_old     the v0.7.3 component (default: `git show v0.7.3:dist/raster_editor.tox`, written to the scratchpad)
  _upg_new     the current build (dist/raster_editor.tox); when it has no ``Version`` parameter yet one is added (the build's VERSION) and a
               marker line is appended to its extension so the replacement is observable
  _upg_newer   another copy with Version 9.0.0 (must be skipped and listed)
puts a document (input / pixel layer with a drop shadow / pixel layer with a mask) into the old one through a fake web client,
wires a constant TOP into its input and a null TOP behind its output, runs ``upgrade.upgrade_all(_upg_new, root=_upg_box)``
(the search root is the box: the user's /project1/raster_editor is never visited) and verifies document, surfaces, wiring,
parameter values / expression, storage, Version and the output image; then destroys the scratch operators.

Only ops under /project1/_upg_box are created / changed / destroyed. The .toe is not saved, time.play is not touched.
Never sleeps inside TD: waits poll from this process.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _build_version():
    import re
    with open(os.path.join(ROOT, "td", "build_component.py")) as f:
        m = re.search(r'^VERSION = "([^"]+)"', f.read(), re.M)
    return m.group(1) if m else ""


NEW_VERSION = _build_version()  # what an upgrade stamps (td/build_component.py VERSION)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "td", "raster_editor"))

import td_call  # noqa: E402
import validate_td as vt  # noqa: E402  (fake web client)

SCRATCH = os.path.join(ROOT, ".validate", "tmp")   # repo-local, git-ignored
os.makedirs(SCRATCH, exist_ok=True)
BOX = "/project1/_upg_box"
OLD, NEW, NEWER = BOX + "/_upg_old", BOX + "/_upg_new", BOX + "/_upg_newer"
MASTER = BOX + "/_upg_slave"      # a v8 (tagged) editor routed through the live master's server
PORTS = {OLD: 9971, NEW: 9972, NEWER: 9973, MASTER: 9974}
W, H = 256, 144
RECORD_KEY = "rasterEditorMaster"
PRELUDE = "from td import *\nimport json\n"
results = []


def td(code, timeout=60):
    res = td_call.run(PRELUDE + code, timeout)
    if not res.get("ok"):
        raise RuntimeError((res.get("traceback") or json.dumps(res))[-2000:])
    return res.get("stdout", "")


def td_json(code, timeout=60):
    lines = td(code, timeout).strip().splitlines()
    return json.loads(lines[-1]) if lines else None


def wait_for(fn, timeout, period=0.15):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(period)
    return last


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS" if ok else "FAIL"), name, detail)


def load(tox, path, port):
    td(f"""
box = op({BOX!r})
c = box.loadTox({tox!r})
c.name = {os.path.basename(path)!r}
c.par.Port = {port}
c.par.Active = 1
c.Start()   # (re)binds the server to the new port
print(c.path)
""", 120)


def ready(path, timeout=15):
    return wait_for(lambda: td(f"""
x = op({path!r}).ext.RasterEditorExt
print(bool(x._started and not x._restore_pending and x.network is not None))""").strip() == "True", timeout)


def snapshot(path):
    """Document + output signature of an editor."""
    return td_json(f"""
import hashlib, numpy as np
c = op({path!r}); x = c.ext.RasterEditorExt
o = c.op('out1').numpyArray()
print(json.dumps({{
  'doc_state': hashlib.md5(c.op('doc_state').text.encode()).hexdigest(),
  'layers': [l['id'] for l in (x.doc_layers or [])], 'rev': x.doc_rev,
  'surfaces': {{str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())}},
  'out': hashlib.md5((o * 255 + .5).astype(np.uint8).tobytes()).hexdigest(),
  'out_size': [o.shape[1], o.shape[0]],
  'version': c.par.Version.eval() if hasattr(c.par, 'Version') else None,
  'ext_marker': 'upg-marker' in c.op('RasterEditorExt').text,
  'pars': {{n: [str(getattr(c.par, n).mode), getattr(c.par, n).eval()] for n in ('Port', 'Maxsendfps', 'Maxviewfps', 'Premultiplied')}},
  'expr': c.par.Maxviewfps.expr, 'store': c.fetch('_upg_marker', None), 'tags': sorted(c.tags),
  'children': len(c.children), 'started': bool(x._started)}}))
""")


def wiring(path):
    return td_json(f"""
c = op({path!r})
print(json.dumps({{'in': [k.owner.path for k in c.inputConnectors[0].connections],
                  'out': [k.owner.path for k in c.outputConnectors[0].connections]}}))""")


def listening(port):
    import socket
    try:
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
        return True
    except OSError:
        return False


_ready = vt.P.ready


def speak(protocol):
    """The fake client of validate_td speaks the repo's protocol; the v0.7.3 editor wants 9."""
    vt.P.ready = lambda client, token, fresh=False, version="", proto=None: _ready(client, token, fresh, version, protocol=protocol)


def client(port, tok, proto, eid="", fresh=False):
    """A fake web client; for a v8 editor behind the master router ``eid`` selects it (/ws?editor=<id>)."""
    speak(proto)
    end = time.time() + 60
    while True:       # the master's editor list learns of a just (re)started editor with its next scan
        ed = vt.Editor(port, fresh=fresh, editor=eid, tok=tok, protocol=proto)
        try:
            ed.poll(3.0)
            if ed.hello:
                return ed
        except ConnectionError:
            pass
        ed.close()
        if time.time() > end:
            dbg = td(f"x = op({MASTER!r}).ext.RasterEditorExt\nm = op('/project1/raster_editor').ext.RasterEditorExt\n"
                     f"print(x.editor_id, x._started, x.o.par.Active.eval(), sorted(m._by_id), m.is_master, x._destroyed, x.o.tags)")
            raise RuntimeError(f"no hello from editor {eid} on {port}: {dbg}")
        time.sleep(0.5)


def make_document(port, tok):
    speak(9)
    if not wait_for(lambda: listening(port), 15):
        raise RuntimeError(f"nothing listens on {port}: " + td(f"x = op({OLD!r}).ext.RasterEditorExt; print(op({OLD!r}).par.Port.eval(), "
                                                           f"op({OLD!r}).op('webserver').par.active.eval(), x.GetStatus())"))
    vt.token = lambda: tok
    ed = vt.Editor(port)
    try:
        if not ed.takeover():
            raise RuntimeError("takeover failed")
        rng = np.random.default_rng(7)
        a = rng.integers(0, 256, (H, W, 4), dtype=np.uint8)
        a[..., 3] = np.where(rng.random((H, W)) < 0.5, 255, 90)
        b = np.zeros((H, W, 4), np.uint8)
        b[40:110, 60:200] = (0, 0, 255, 255)
        mask = np.zeros((H, W, 4), np.uint8)
        mask[..., 3] = 255
        mask[:, 80:170, :3] = 255
        shadow = {"type": "dropShadow", "enabled": True, "dx": 5, "dy": 4, "blur": 3,
                  "color": {"r": 0, "g": 0, "b": 0, "a": 255}, "opacity": 0.8}
        layers = [vt.L("base", "input", input=1), vt.L("a", slot=1, size=(W, H), effects=[shadow], opacity=0.8),
                  vt.L("b", slot=2, size=(W, H), blend="multiply", mask={"slot": 3, "enabled": True})]
        ed.send_doc(layers, 1)
        fids = [ed.send_surface(1, (0, 0, W, H), a), ed.send_surface(2, (0, 0, W, H), b), ed.send_surface(3, (0, 0, W, H), mask)]
        if not vt.wait_applied(ed, fids[-1], 8):
            raise RuntimeError("document was not applied")
    finally:
        ed.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--old")
    ap.add_argument("--new")
    args = ap.parse_args()
    old_tox = args.old or os.path.join(SCRATCH, "re_v073.tox")
    if not args.old:
        with open(old_tox, "wb") as f:
            f.write(subprocess.check_output(["git", "show", "v0.7.3:dist/raster_editor.tox"], cwd=ROOT))
    new_tox = args.new or os.path.join(ROOT, "dist", "raster_editor.tox")
    # the loaded component is named after the tox's root (_re_tox_build): a file copy per scratch editor keeps it unambiguous
    guard = td_json("""
r = op('/project1/raster_editor')
print(json.dumps({'ext': hash(r.op('RasterEditorExt').text), 'n': len(r.children), 'port': r.par.Port.eval()}))""")
    td(f"b = op({BOX!r})\nif b: b.destroy()\nop('/project1').create('baseCOMP', '_upg_box')")
    try:
        # ---- setup
        load(old_tox, OLD, PORTS[OLD])
        load(new_tox, NEW, PORTS[NEW])
        load(new_tox, NEWER, PORTS[NEWER])
        load(new_tox, MASTER, PORTS[MASTER])
        td(f"""
for p, ver in ((%r, %r), (%r, '9.0.0'), (%r, '0.7.9')):
    c = op(p)
    if not hasattr(c.par, 'Version'):
        pg = [g for g in c.customPages if g.name == 'Raster Editor'][0]
        v = pg.appendStr('Version', label='Version')[0]
        v.default = ver; v.val = ver; v.readOnly = True
        c.tags.add('rasterEditor')
        print('synthetic Version on', p)
    c.par.Version.readOnly = False; c.par.Version = ver; c.par.Version.readOnly = True
    c.op('RasterEditorExt').text += ('\\n# upg-marker\\n' if p != %r else '')
    c.initializeExtensions()
    c.Start()
c = op({OLD!r})
c.store('_upg_marker', 'keep-me')
c.create('nullTOP', 'my_user_null')
c.appendCustomPage('Mine').appendFloat('Gain')
c.par.Gain = 0.25
""" % (NEW, NEW_VERSION, NEWER, MASTER, MASTER))
        for p in (OLD, NEW, NEWER, MASTER):
            if not ready(p, 20):
                raise RuntimeError(f"{p} did not start")
        td(f"""
up = op({BOX!r}).create('constantTOP', '_upg_in')
up.par.outputresolution = 'custom'; up.par.resolutionw = {W}; up.par.resolutionh = {H}
up.par.colorr = 1; up.par.colorg = 0.2; up.par.colorb = 0; up.par.alpha = 1
c = op({OLD!r})
c.inputConnectors[0].connect(up)
down = op({BOX!r}).create('nullTOP', '_upg_down')
down.inputConnectors[0].connect(c.outputConnectors[0])
c.par.Maxsendfps = 17
c.par.Maxviewfps.expr = '20 + 5'
""")
        tok = td(f"print(op({OLD!r}).ext.RasterEditorExt.token)").strip()
        wait_for(lambda: td_json(f"print(json.dumps(op({OLD!r}).op('out1').width))") == W, 8)
        make_document(PORTS[OLD], tok)
        time.sleep(0.5)
        wait_for(lambda: td_json(f"print(json.dumps(op({OLD!r}).op('out1').width))") == W, 5)
        # the v8 slave: routed through the project's master (read-only use of its token), a client has sent a document to it
        minfo = td_json(f"x = op({MASTER!r}).ext.RasterEditorExt\nm = op('/project1/raster_editor').ext.RasterEditorExt\n"
                        f"print(json.dumps({{'eid': x.editor_id, 'master': x.is_master, 'tok': m.token, 'port': m.port_used, 'mpath': m.o.path}}))")
        mc = client(minfo["port"], minfo["tok"], 10, minfo["eid"])
        mc.takeover()
        rng = np.random.default_rng(3)
        m1 = rng.integers(0, 256, (H, W, 4), dtype=np.uint8)
        mc.send_canvas(W, H, "fixed")
        mc.wait(lambda: (mc.doc_w, mc.doc_h) == (W, H), 5)
        mc.send_doc([vt.L("base", "input", input=1), vt.L("m", slot=1, size=(W, H))], 1)
        vt.wait_applied(mc, mc.send_surface(1, (0, 0, W, H), m1), 8)
        time.sleep(0.4)
        mbefore = snapshot(MASTER)
        check("setup: v8 slave has a connected client and a document", not minfo["master"] and mbefore["layers"] == ["base", "m"]
              and mbefore["version"] == "0.7.9", str(minfo))
        before = snapshot(OLD)
        td(f"import numpy as np\nop({BOX!r}).store('before_out', (op({OLD!r}).op('out1').numpyArray() * 255 + .5).astype(np.uint8))")
        wires_before = wiring(OLD)
        newer_before = snapshot(NEWER)
        check("setup: old editor has the document", before["layers"] == ["base", "a", "b"] and len(before["surfaces"]) == 3
              and before["version"] is None and before["out_size"] == [W, H], str(before)[:300])
        # ---- run (paced: one editor per frame; the final report arrives through on_done)
        td(f"op({BOX!r}).unstore('rep')")
        out = td(f"""
import sys, importlib
sys.path.insert(0, {os.path.join(ROOT, 'td', 'raster_editor')!r})
import registry, upgrade
importlib.reload(registry); importlib.reload(upgrade)
registry.op = upgrade.op = op   # (inside the component's DATs TD provides the globals)
def cb(r):
    op({BOX!r}).store('rep', json.dumps(r))
first = upgrade.upgrade_all(op({NEW!r}), op({BOX!r}), on_done=cb)
print(json.dumps({{'done': first['done'], 'pending': first['pending']}}))""", 60)
        first = json.loads(out.strip().splitlines()[-1])
        check("paced: returns at once with the editors pending", first["done"] is False and len(first["pending"]) == 2, str(first))
        txt = wait_for(lambda: td(f"print(op({BOX!r}).fetch('rep', ''))").strip(), 60)
        if not txt:
            raise RuntimeError("the paced upgrade never finished")
        rep = json.loads(txt)
        print("report:", json.dumps(rep))
        check("report", sorted(rep["upgraded"]) == sorted([MASTER, OLD]) and rep["failed"] == [] and rep["skipped_newer"] == [[NEWER, "9.0.0"]]
              and rep["same"] == [] and rep["done"] and "9.0.0" in rep["warning"] and "my_user_null" in rep["warning"], str(rep)[:400])
        check("old editor restarted", bool(ready(OLD, 30)))
        wait_for(lambda: snapshot(OLD)["out"] == before["out"], 6)
        after = snapshot(OLD)
        check("document identical (doc_state, layers, rev)", (after["doc_state"], after["layers"], after["rev"]) ==
              (before["doc_state"], before["layers"], before["rev"]), f"{after['layers']} rev {after['rev']}")
        check("surfaces identical (hash per slot)", after["surfaces"] == before["surfaces"], str(after["surfaces"]))
        diff = td_json(f"import numpy as np\na = (op({OLD!r}).op('out1').numpyArray() * 255 + .5).astype(np.uint8).astype(int)\n"
                       f"b = op({BOX!r}).fetch('before_out').astype(int)\nprint(json.dumps(int(np.abs(a - b).max()) if a.shape == b.shape else -1))")
        check("output TOP renders the same image", after["out_size"] == before["out_size"] and 0 <= diff <= 1,
              f"max channel diff {diff}, identical hash {after['out'] == before['out']}")
        w = wiring(OLD)
        check("wiring intact", w == wires_before and w["in"] == [BOX + "/_upg_in"] and w["out"] == [BOX + "/_upg_down"], str(w))
        check("downstream null still fed", td_json(f"print(json.dumps([k.owner.path for k in op({BOX!r}+'/_upg_down').inputConnectors[0].connections]))") == [OLD])
        check("Version updated + tag", after["version"] == NEW_VERSION and "rasterEditor" in after["tags"], f"{after['version']} {after['tags']}")
        check("code replaced from the source", after["ext_marker"] and not before["ext_marker"])
        check("parameter values / expression / storage kept",
              after["pars"] == before["pars"] and after["expr"] == "20 + 5" and after["store"] == "keep-me", str(after["pars"]))
        sn = snapshot(NEWER)
        check("newer editor untouched", sn["version"] == "9.0.0" and sn["ext_marker"] and sn["doc_state"] == newer_before["doc_state"])
        check("no backup COMP left", td_json(f"print(json.dumps([c.name for c in op({BOX!r}).children if c.name.startswith('_upg_bak')]))") == [])
        st = td_json(f"x = op({OLD!r}).ext.RasterEditorExt\nprint(json.dumps({{'err': repr(getattr(x, 'last_error', None)), 'status': x.GetStatus()}}))")
        check("new extension running without errors", st["err"] == "None", str(st))
        user = td_json(f"c = op({OLD!r})\nprint(json.dumps({{'child': c.op('my_user_null') is not None, 'gain': c.par.Gain.eval(), 'page': [g.name for g in c.customPages]}}))")
        check("user child and user page kept", user["child"] and user["gain"] == 0.25 and "Mine" in user["page"], str(user))
        # ---- the v8 slave behind the project's master: document intact, a new client connects through the master
        check("slave editor restarted", bool(ready(MASTER, 30)))
        mafter = snapshot(MASTER)
        minfo2 = td_json(f"x = op({MASTER!r}).ext.RasterEditorExt\nm = op('/project1/raster_editor').ext.RasterEditorExt\n"
                         f"print(json.dumps({{'eid': x.editor_id, 'err': repr(x.last_error), 'mport': m.port_used, 'mmaster': m.is_master, 'started': x._started}}))")
        check("slave: same editor id, started, no error; the project master untouched",
              minfo2["eid"] == minfo["eid"] and minfo2["err"] == "None" and minfo2["started"] and minfo2["mmaster"]
              and minfo2["mport"] == minfo["port"], str(minfo2))
        check("slave: document + surfaces identical, Version updated",
              mafter["doc_state"] == mbefore["doc_state"] and mafter["surfaces"] == mbefore["surfaces"] and mafter["version"] == NEW_VERSION,
              f"{mafter['layers']} {mafter['version']}")
        mt = td_json(f"print(json.dumps(op({MASTER!r}).op('RasterEditorExt').text == op({NEW!r}).op('RasterEditorExt').text))")
        check("slave: code replaced from the source", mt is True)
        try:
            mc.poll(1.0)
            dropped = False
        except Exception:  # the old socket was closed by the stop
            dropped = True
        mc2 = client(minfo["port"], minfo["tok"], 10, minfo["eid"], fresh=True)
        try:
            mc2.takeover()
            check("slave: old client dropped, a new one connects through the master and sees the document",
                  dropped and bool(mc2.hello and mc2.hello.get("hasDocument")),
                  f"dropped={dropped} hello={ {k: mc2.hello.get(k) for k in ('hasDocument', 'rev')} if mc2.hello else None}")
        finally:
            mc2.close()
        # ---- whole-project root (read-only dry run): finds the box editors, nothing under /ui /sys /local
        cl = td_json(f"""
import sys
sys.path.insert(0, {os.path.join(ROOT, 'td', 'raster_editor')!r})
import registry, upgrade
registry.op = upgrade.op = op
older, newer, same = upgrade.classify(op({NEW!r}))
paths = [c.path for c in older] + [c.path for c, v in newer] + [c.path for c in same]
print(json.dumps(paths))""")
        check("default root = whole project, system networks skipped", {OLD, NEWER, MASTER} <= set(cl) and
              not [p for p in cl if p.split('/')[1] in ('ui', 'sys', 'local')], str(cl))
        g2 = td_json("""
r = op('/project1/raster_editor')
print(json.dumps({'ext': hash(r.op('RasterEditorExt').text), 'n': len(r.children), 'port': r.par.Port.eval()}))""")
        check("/project1/raster_editor untouched", g2 == guard)
    finally:
        if not args.keep:
            td(f"b = op({BOX!r})\nif b: b.destroy()", 120)
            check("scratch destroyed", td(f"print(op({BOX!r}) is None)").strip() == "True")
    print("RESULT", "OK" if all(results) else "FAILED", f"{sum(results)}/{len(results)}")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
