"""Live validation of the raster_editor COMP against a running TouchDesigner (docs/TESTING.md §3).

    .venv/bin/python scripts/validate_td.py                  # all steps (needs the real UI)
    .venv/bin/python scripts/validate_td.py --skip-ui        # steps 1-5, 9, 10; step 5 via fake client
    .venv/bin/python scripts/validate_td.py --fake-client    # step 5 and 10 driven by a python WebSocket client

Flags: --no-build (reuse the COMP that exists), --port N. Only operators inside
/project1/raster_editor and the temporary /project1/_validate_in are touched; the temporary
one is destroyed and the COMP's input is disconnected again at the end.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.join(ROOT, "td", "raster_editor"))
import td_call  # noqa: E402
import protocol as P  # noqa: E402

COMP = "/project1/raster_editor"
TMP = "/project1/_validate_in"
OUT_DIR = os.path.join(ROOT, "dist", "validate")
IW, IH = 1920, 1080  # input size used by step 5 (several 2 MB bands)
PRELUDE = f"from td import *\nimport json\ncomp = op({COMP!r})\n"

results = []


# --------------------------------------------------------------------------- TD access


def td(code, timeout=60):
    """Run python in TD; return stdout. Raises on failure."""
    res = td_call.run(PRELUDE + code, timeout)
    if not res.get("ok"):
        raise RuntimeError((res.get("traceback") or json.dumps(res))[-1500:])
    return res.get("stdout", "")


def td_json(code, timeout=60):
    out = td(code, timeout).strip().splitlines()
    return json.loads(out[-1]) if out else None


def wait_for(fn, timeout, period=0.1):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(period)
    return last


def step(num, name, fn):
    t0 = time.time()
    try:
        ok, detail = fn()
    except Exception as e:  # noqa: BLE001
        ok, detail = False, f"exception: {type(e).__name__}: {e}"
    results.append(ok)
    print(f"[{'PASS' if ok is True else 'SKIP' if ok is None else 'FAIL'}] {num:>2}. {name}  ({time.time() - t0:.1f}s)"
          + (f"\n        {detail}" if detail else ""), flush=True)
    return ok


def pixel(path, u, v):
    """RGBA (0-255 scale) of a TOP at normalised (u, v) from the bottom-left."""
    return td_json(f"""
a = op({path!r}).numpyArray()
h, w = a.shape[:2]
x = min(w - 1, int({u!r} * w)); y = min(h - 1, int({v!r} * h))
print(json.dumps([round(float(c) * 255, 1) for c in a[y, x]]))
""")


def px_near(got, want, tol=2.5):
    return all(abs(g - w) <= tol for g, w in zip(got, want))


def out1_size():
    return td_json("o = comp.op('out1'); print(json.dumps([o.width, o.height]))")


def status():
    return td("print(comp.GetStatus())").strip()


# --------------------------------------------------------------------------- minimal websocket client


class WS:
    """Stdlib WebSocket client: just enough RFC 6455 for text + binary messages."""

    def __init__(self, port, path="/ws"):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed during handshake")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        self.buf = bytearray(rest)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))

    def send(self, data):
        op = 1 if isinstance(data, str) else 2
        raw = data.encode() if isinstance(data, str) else bytes(data)
        n = len(raw)
        hdr = bytes([0x80 | op])
        hdr += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 \
            else bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        import numpy as np
        masked = (np.frombuffer(raw, np.uint8) ^ np.resize(np.frombuffer(mask, np.uint8), n)).tobytes()
        self.sock.sendall(hdr + mask + masked)

    def _parse(self):
        """One complete message from the buffer (str | bytes), or None; consumes only what it returns."""
        buf, pos, msg, kind = self.buf, 0, b"", None
        while True:
            if len(buf) - pos < 2:
                return None
            b0, b1 = buf[pos], buf[pos + 1]
            n, hdr = b1 & 0x7F, 2
            if n == 126:
                if len(buf) - pos < 4:
                    return None
                n, hdr = struct.unpack_from(">H", buf, pos + 2)[0], 4
            elif n == 127:
                if len(buf) - pos < 10:
                    return None
                n, hdr = struct.unpack_from(">Q", buf, pos + 2)[0], 10
            if len(buf) - pos < hdr + n:
                return None
            payload = bytes(buf[pos + hdr: pos + hdr + n])
            pos += hdr + n
            op = b0 & 15
            if op == 9:
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
            elif op == 8:
                raise ConnectionError("closed by server")
            elif op in (1, 2, 0):
                kind = op or kind
                msg += payload
                if b0 & 0x80:
                    self.buf = self.buf[pos:]
                    return msg.decode() if kind == 1 else msg

    def recv(self, timeout=1.0):
        """Next message (str | bytes) or None on timeout. Partial frames stay buffered."""
        end = time.time() + timeout
        while True:
            m = self._parse()
            if m is not None:
                return m
            left = end - time.time()
            if left <= 0:
                return None
            self.sock.settimeout(left)
            try:
                chunk = self.sock.recv(1 << 20)
            except socket.timeout:
                return None
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def ready_msg(client="external"):
    token = td("print(comp.ext.RasterEditorExt.token)").strip()
    return json.dumps({"t": "ready", "protocol": 1, "client": client, "version": "validate", "token": token})


def drain(ws, seconds):
    """Collect (texts, binaries) for a while."""
    texts, bins = [], []
    end = time.time() + seconds
    while time.time() < end:
        m = ws.recv(0.2)
        if m is None:
            continue
        (texts if isinstance(m, str) else bins).append(json.loads(m) if isinstance(m, str) else m)
    return texts, bins


def assemble(bins, w, h):
    """Rebuild the wire image from the bands of the LAST frameId received; returns
    (image, complete, frame_id). Complete = contiguous bands ending with FRAME_END covering h rows."""
    import numpy as np
    heads = [P.decode_frame(b) for b in bins]
    if not heads:
        return np.zeros((h, w, 4), np.uint8), False, None
    last = heads[-1][0].frame_id
    img = np.zeros((h, w, 4), np.uint8)
    rows, ended, nxt = 0, False, 0
    for hdr, payload in heads:
        if hdr.frame_id != last:
            continue
        if hdr.y != nxt:
            return img, False, last
        img[hdr.y:hdr.y + hdr.h, hdr.x:hdr.x + hdr.w] = np.frombuffer(payload, np.uint8).reshape(hdr.h, hdr.w, 4)
        nxt += hdr.h
        rows += hdr.h
        ended = hdr.frame_end
    return img, ended and rows == h, last


def composite_image(w, h):
    import numpy as np
    img = np.zeros((h, w, 4), np.uint8)
    img[...] = (0, 200, 0, 255)
    img[0:10, 0:20] = (255, 0, 255, 255)  # top-left marker: proves the vertical flip
    img[100:110, 100:110] = (200, 100, 50, 128)  # translucent: proves premultiplication
    return img


def send_frame(ws, frame_id, doc, rect, img):
    for m in P.encode_frames(P.TYPE_COMPOSITE, frame_id, doc[0], doc[1], rect, img):
        ws.send(m)


# --------------------------------------------------------------------------- steps


ORIG = {}


def s1_build(args):
    if not args.no_build:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "td", "build_component.py")],
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            return False, (r.stdout + r.stderr)[-1500:]
    ORIG.update(td_json("print(json.dumps({'Port': int(comp.par.Port), 'Docw': int(comp.par.Docw), 'Doch': int(comp.par.Doch), 'Panelquery': comp.par.Panelquery.eval()}))"))
    if not args.skip_ui:
        td("comp.par.Panelquery = 'test=1'")
    if args.port != 9980:
        td(f"comp.par.Port = {args.port}")
    info = td_json("""
bad = [(c.path, c.errors()) for c in comp.findChildren(depth=3) if c.errors()]
print(json.dumps({'exists': comp is not None, 'bad': bad, 'ext': bool(comp.ext.RasterEditorExt._started)}))
""")
    ok = info["exists"] and not info["bad"] and info["ext"]
    return ok, "" if ok else json.dumps(info)


def s2_server(args):
    c = http.client.HTTPConnection("127.0.0.1", args.port, timeout=5)
    c.request("GET", "/")
    r = c.getresponse()
    body = r.read()
    want = open(os.path.join(ROOT, "dist", "ui", "index.html"), "rb").read()
    c.request("GET", "/nope")
    r2 = c.getresponse()
    r2.read()
    ok = r.status == 200 and body == want and r2.status == 404 and "text/html" in (r.getheader("content-type") or "")
    return ok, f"GET / -> {r.status} {len(body)} bytes (dist {len(want)}), /nope -> {r2.status}"


def s3_panel(args):
    loaded = wait_for(lambda: td_json("print(json.dumps(bool(comp.op('webrender').loaded)))"), 10)
    os.makedirs(OUT_DIR, exist_ok=True)
    png = os.path.join(OUT_DIR, "ui.png")
    stats = td_json(f"""
w = comp.op('webrender'); w.save({png!r})
a = w.numpyArray()[..., :3]
print(json.dumps({{'std': float(a.std()), 'rng': float(a.max() - a.min()), 'size': [w.width, w.height]}}))
""")
    ok = bool(loaded) and stats["std"] > 0.01 and stats["rng"] > 0.2
    connected = wait_for(lambda: "active" in status(), 5)
    return ok, f"loaded={loaded} std={stats['std']:.3f} range={stats['rng']:.2f} -> {png}; status={status()!r}" + \
        ("" if connected or args.skip_ui else "  (WARNING: UI did not connect)")


def s4_no_input(args):
    # a document size distinct from the input size used later, so a stale size would show
    td("comp.inputConnectors[0].disconnect() if comp.inputConnectors[0].connections else None\ncomp.par.Docw = 800; comp.par.Doch = 600")
    want = [800, 600]
    got = wait_for(lambda: out1_size() == want, 3)
    return bool(got), f"out1 {out1_size()} vs Docw x Doch {want}"


def connect_input():
    td(f"""
old = op({TMP!r})
if old: old.destroy()
c = op('/project1').create(constantTOP, '_validate_in')
c.par.outputresolution = 'custom'; c.par.resolutionw = {IW}; c.par.resolutionh = {IH}
c.par.colorr = 1; c.par.colorg = 0; c.par.colorb = 0; c.par.alpha = 1
comp.inputConnectors[0].connect(c)
""")


def s5_input(args):
    connect_input()
    ok_size = wait_for(lambda: out1_size() == [IW, IH], 3)
    if not ok_size:
        return False, f"out1 never became {IW}x{IH}: {out1_size()} status={status()!r}"
    if not (args.fake_client or args.skip_ui):
        return real_ui_input_roundtrip(args)
    return fake_client_input_roundtrip(args)


def real_ui_input_roundtrip(args):
    got = wait_for(lambda: td_json("print(json.dumps(comp.op('out_switch').par.index.eval()))") == 1, 3)
    p = pixel(COMP + "/out1", 0.5, 0.5)
    ok = got and px_near(p, (255, 0, 0, 255))
    return bool(ok), f"switch index==1: {bool(got)}, centre={p}, status={status()!r}"


def fake_client_input_roundtrip(args):
    ws = WS(args.port)
    try:
        ws.send(ready_msg())
        ws.send(json.dumps({"t": "takeover"}))
        texts, bins = drain(ws, 2.5)
        hello = next((t for t in texts if t["t"] == "hello"), None)
        active = [t["active"] for t in texts if t["t"] == "active"]
        if not hello or hello["doc"] != {"w": IW, "h": IH} or not hello["hasInput"]:
            return False, f"bad hello {hello}"
        if not active or active[-1] is not True:
            return False, f"takeover failed: {texts}"
        img, complete, ids = assemble(bins, IW, IH)
        # one complete BASE frame (maybe repeated); red input, centre must be opaque red
        if not complete:
            return False, f"BASE frame incomplete ({len(bins)} bands)"
        if not px_near(tuple(int(c) for c in img[IH // 2, IW // 2]), (255, 0, 0, 255), 1):
            return False, f"BASE centre pixel {img[IH // 2, IW // 2].tolist()}"
        send_frame(ws, 1, (IW, IH), (0, 0, IW, IH), composite_image(IW, IH))
        ok = wait_for(lambda: td_json("print(json.dumps(comp.op('out_switch').par.index.eval()))") == 1, 3)
        time.sleep(0.2)
        centre = pixel(COMP + "/out1", 0.5, 0.5)
        marker = pixel(COMP + "/out1", 5 / IW, 1 - 5 / IH)  # wire (5, 5) = near TD top-left
        below = pixel(COMP + "/out1", 5 / IW, 5 / IH)  # wire bottom-left: plain green
        trans = pixel(COMP + "/out1", 105 / IW, 1 - 105 / IH)
        want_t = (200 * 128 / 255, 100 * 128 / 255, 50 * 128 / 255, 128)
        good = (ok and px_near(centre, (0, 200, 0, 255)) and px_near(marker, (255, 0, 255, 255))
                and px_near(below, (0, 200, 0, 255)) and px_near(trans, want_t, 3))
        return bool(good), (f"BASE ok ({len(bins)} bands); out1 switch={bool(ok)} centre={centre} marker(top-left)={marker} "
                            f"bottom-left={below} translucent={trans} want {[round(c, 1) for c in want_t]}")
    finally:
        ws.close()


UI_JS_POST = ("fetch('/__test?token='+encodeURIComponent(new URLSearchParams(location.search).get('token')),"
              "{method:'POST',body:JSON.stringify(%s)})")


def js(expr):
    td(f"comp.op('webrender').executeJavaScript({expr!r})")


def js_result(expr, timeout=3):
    td("comp.ext.RasterEditorExt.test_result = None")
    js(UI_JS_POST % expr)
    raw = wait_for(lambda: td("print(comp.ext.RasterEditorExt.test_result or '')").strip(), timeout)
    return json.loads(raw) if raw else None


def mouse(u, v, left=False):
    td(f"comp.op('webrender').interactMouse({u!r}, {v!r}, left={left!r})")


def drag_doc(doc_pts, panel=(1280, 800), perf=False):
    """Drag across document points (resolved to panel u/v with the test hook)."""
    pts = [js_result(f"window.__editorTest.docToScreen({x},{y})") for x, y in doc_pts]
    if any(p is None for p in pts):
        return False
    uv = [(p["x"] / panel[0], 1 - p["y"] / panel[1]) for p in pts]  # panel/web origin is top-left, TD bottom-left
    mouse(*uv[0])
    mouse(*uv[0], left=True)
    for a, b in zip(uv, uv[1:]):
        for i in range(1, 9):
            t = i / 8
            mouse(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, left=True)
            if perf:
                time.sleep(0.008)
    mouse(*uv[-1], left=False)
    return True


def centre_is(rgba, tol=6):
    return wait_for(lambda: px_near(pixel(COMP + "/out1", 0.5, 0.5), rgba, tol), 1.5, 0.05)


def s6_paint(args):
    if not wait_for(lambda: js_result("window.__editorTest.state()"), 5):
        return False, "test hook window.__editorTest not reachable (panel URL needs ?test=1; rebuilt UI?)"
    if not wait_for(lambda: px_near(pixel(COMP + "/out1", 0.5, 0.5), (255, 0, 0, 255), 3), 3):
        return False, "centre is not red before painting"
    mouse(0.5, 0.5)  # focus the page
    js("window.__editorTest.addLayer()")  # the TD Input base layer is locked by default
    time.sleep(0.2)
    js("window.__editorTest.setPrimary('#0000ff')")
    td("comp.op('webrender').sendKey('b', char='b')")
    time.sleep(0.2)
    st = js_result("window.__editorTest.state()")
    if not st or st["tool"] != "brush":
        return False, f"key 'b' did not select the brush: {st and st['tool']}"
    if not drag_doc([(IW * 0.375, IH / 2), (IW * 0.625, IH / 2)]):
        return False, "could not resolve doc coordinates"
    blue = centre_is((0, 0, 255, 255))
    corner = pixel(COMP + "/out1", 0.03, 0.97)
    return bool(blue and px_near(corner, (255, 0, 0, 255), 3)), f"centre={pixel(COMP + '/out1', .5, .5)} corner={corner}"


def s7_undo(args):
    td("comp.op('webrender').sendKey('z', char='z', cmd=True)")
    ok = centre_is((255, 0, 0, 255), 3)
    return bool(ok), f"centre={pixel(COMP + '/out1', .5, .5)}"


def s8_layer(args):
    js("window.__editorTest.addLayer()")
    time.sleep(0.2)
    js("window.__editorTest.setPrimary('#00ff00')")
    if not drag_doc([(IW * 0.375, IH / 2), (IW * 0.625, IH / 2)]):
        return False, "could not resolve doc coordinates"
    green = centre_is((0, 255, 0, 255))
    layer = js_result("window.__editorTest.state().activeLayer")
    js(f"window.__editorTest.setLayerVisible({json.dumps(layer)}, false)")
    red = centre_is((255, 0, 0, 255), 3)
    return bool(green and red), f"painted green={bool(green)}, hidden -> red={bool(red)} centre={pixel(COMP + '/out1', .5, .5)}"


def s9_disconnect(args):
    td(f"""
comp.inputConnectors[0].disconnect()
t = op({TMP!r})
if t: t.destroy()
""")
    want = td_json("print(json.dumps([int(comp.par.Docw), int(comp.par.Doch)]))")
    ok = wait_for(lambda: out1_size() == want, 3)
    idx = td_json("print(json.dumps(comp.op('out_switch').par.index.eval()))")
    return bool(ok), f"out1 {out1_size()} vs {want}, switch index {idx}"


def toggle_input(i):
    td(f"op({TMP!r}).par.colorg = {i % 2}")


def s10_perf(args):
    connect_input()
    wait_for(lambda: out1_size() == [IW, IH], 3)
    time.sleep(0.5)
    td("[d.clear() for d in comp.ext.RasterEditorExt.stats.values()]")
    frames_sent, send_s = 0, 0.0
    if args.fake_client or args.skip_ui:
        driver = "fake client: 256x256 composite rects at ~60 Hz for 6 s while the 1080p input changes ~7x/s, then a full 1080p frame"
        ws = WS(args.port)
        try:
            ws.send(ready_msg())
            ws.send(json.dumps({"t": "takeover"}))
            texts, _ = drain(ws, 0.8)
            hello = next(t for t in texts if t["t"] == "hello")
            dw, dh = hello["doc"]["w"], hello["doc"]["h"]
            import numpy as np
            tile = np.random.RandomState(1).randint(0, 256, (256, 256, 4), dtype=np.uint8)
            n = 0
            end = time.time() + 6
            while time.time() < end:
                x = (n * 37) % max(1, dw - 256)
                y = (n * 23) % max(1, dh - 256)
                send_frame(ws, n, (dw, dh), (x, y, 256, 256), tile)
                if n % 8 == 0:
                    toggle_input(n // 8)
                n += 1
                while ws.recv(0) is not None:  # keep the socket drained (BASE frames keep arriving)
                    pass
                time.sleep(1 / 60)
            full = np.random.RandomState(2).randint(0, 256, (dh, dw, 4), dtype=np.uint8)
            t0 = time.time()
            send_frame(ws, n, (dw, dh), (0, 0, dw, dh), full)
            send_s = time.time() - t0
            frames_sent = n
            drain(ws, 0.5)
        finally:
            ws.close()
    else:
        driver = "mouse drag with the brush for ~6 s while the 1080p input changes"
        js("window.__editorTest.addLayer()")
        js("window.__editorTest.setPrimary('#ff8800')")
        doc = (js_result("window.__editorTest.state().doc") or {"w": IW, "h": IH})
        sx, sy = doc["w"] / 640, doc["h"] / 360
        pts = [(100 * sx, 60 * sy), (540 * sx, 120 * sy), (100 * sx, 180 * sy), (540 * sx, 240 * sy), (100 * sx, 300 * sy)]
        end = time.time() + 6
        i = 0
        while time.time() < end:
            toggle_input(i)
            i += 1
            drag_doc(pts, perf=True)
    st = td_json("print(json.dumps(comp.GetStats()))")
    p, q, c, cv, rb, sd = (st[k] for k in ("pump", "paste", "cook", "convert", "readback", "send"))
    checks = [("Pump worst <= 50 ms", p["max"] <= 50), ("256x256 band paste median <= 2 ms", q["median"] <= 2.0 or driver.startswith("mouse")),
              ("paste+upload median <= 4 ms", q["median"] + c["median"] <= 4.0),
              ("input readback worst <= 15 ms (DESIGN 6)", rb["max"] <= 15), ("convert slice worst <= 8 ms", cv["max"] <= 8),
              ("send (one 2 MB band) worst <= 15 ms", sd["max"] <= 15)]
    ok = all(v for _, v in checks)
    def f(d):
        return f"median {d['median']:.2f} worst {d['max']:.2f} (n={d['n']})"
    return ok, (f"driver: {driver}\n        Pump ms: {f(p)}\n        band paste ms: {f(q)} | composite cook/upload ms: {f(c)}"
                f"\n        input readback ms: {f(rb)} | convert slice ms: {f(cv)} | band send ms: {f(sd)}"
                + (f"\n        sent {frames_sent} tiles + full frame in {send_s * 1000:.0f} ms (client side)" if frames_sent else "")
                + "\n        " + "; ".join(f"{'ok' if v else 'FAIL'}: {n}" for n, v in checks))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-ui", action="store_true", help="skip steps 6-8 and use the fake client for step 5/10")
    ap.add_argument("--fake-client", action="store_true", help="python WebSocket client acts as the web app")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--port", type=int, default=9980)
    args = ap.parse_args()
    try:
        step(1, "build component, no operator errors", lambda: s1_build(args))
        step(2, "web server serves the UI", lambda: s2_server(args))
        step(3, "web render panel loaded and not blank", lambda: s3_panel(args))
        step(4, "no input: out1 is Docw x Doch", lambda: s4_no_input(args))
        step(5, "input: composite round trip through the editor", lambda: s5_input(args))
        if args.skip_ui:
            for n, name in ((6, "paint"), (7, "undo"), (8, "hidden layer")):
                step(n, name + " (needs real UI)", lambda: (None, "skipped (--skip-ui)"))
        else:
            step(6, "paint with brush via mouse drag", lambda: s6_paint(args))
            step(7, "undo with cmd+z", lambda: s7_undo(args))
            step(8, "hidden layer does not change output", lambda: s8_layer(args))
        step(9, "disconnect input: out1 back to Docw x Doch", lambda: s9_disconnect(args))
        step(10, "performance while streaming / dragging", lambda: s10_perf(args))
    finally:
        try:
            restore = "\n".join(f"comp.par.{k} = {v!r}" for k, v in ORIG.items())
            td(f"""
comp.inputConnectors[0].disconnect()
{restore}
t = op({TMP!r})
if t: t.destroy()
""")
        except Exception as e:  # noqa: BLE001
            print("cleanup failed:", e)
    failed = [r for r in results if r is False]
    print(f"\n{results.count(True)} passed, {len(failed)} failed, {results.count(None)} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
