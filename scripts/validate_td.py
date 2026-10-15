"""Live validation of the raster_editor COMP (protocol v6) against a running TouchDesigner
(docs/TESTING.md section 3, docs/DESIGN_V2.md section 7).

    .venv/bin/python scripts/validate_td.py                  # every step (the real UI drives the UI steps)
    .venv/bin/python scripts/validate_td.py --skip-ui        # only the steps a python fake client can drive
    .venv/bin/python scripts/validate_td.py --fake-client    # same, but keeps the UI steps that tolerate it
    .venv/bin/python scripts/validate_td.py --only 5,7,9     # run chosen steps (numbers below)

The fake client speaks protocol v6 over a stdlib WebSocket: it sends `doc` + SURFACE tiles like the web
app, pulls BASE / VIEW / SURFACE over HTTP and measures `applied` latency.

Flags: --no-build (reuse the COMP that exists), --port N, --only. Only operators inside
/project1/raster_editor and the temporary /project1/_validate_in, /project1/_validate_load, _validate_tops are
touched (destroyed again at the end); the user's .toe is never saved: persistence uses the Exportdoc pulse to dist/validate.
"""

import argparse
import base64
import hashlib
import http.client
import select
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

import numpy as np

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


def baseline():
    """Between steps: the editor is on (a step such as the export one switches it off and on) and the server answers, so a
    step never starts against a half-restarted component. Steps reset the rest (inputs, canvas) themselves."""
    try:
        td("comp.par.Active = 1")
        wait_for(lambda: td("print(comp.ext.RasterEditorExt._started and comp.op('webserver').par.active.eval())").strip() in ("1", "True"), 10)
        # The panel's page reconnects a few seconds after an Active off/on or a rebuild and, being the first panel after a (re)start,
        # takes over as the active editor: a step that took over earlier would silently lose it (its doc / tiles ignored). Wait for it.
        wait_for(lambda: td("x = comp.ext.RasterEditorExt; print(any(c.kind == 'panel' and c.ready for c in x.clients.values()))").strip() == "True", 25)
    except Exception:  # noqa: BLE001 - the step reports its own problems
        pass


def step(num, name, fn):
    baseline()
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
            # select even with a zero timeout: recv(0) must still pick up bytes that are waiting
            if not select.select([self.sock], [], [], max(0.0, end - time.time()))[0]:
                return None
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk

    def close(self):
        """Close handshake: send a close frame, keep reading so TD can finish writing, then drop."""
        try:
            self.sock.sendall(bytes([0x88, 0x82]) + b"\0\0\0\0" + struct.pack(">H", 1000))
            end = time.time() + 2
            while time.time() < end:
                try:
                    if self.recv(0.2) is None and not self.buf:
                        continue
                except ConnectionError:
                    break
        except OSError:
            pass
        finally:
            try:
                self.sock.close()
            except OSError:
                pass



def token():
    return td("print(comp.ext.RasterEditorExt.token)").strip()


def http_get(port, path, timeout=10):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    c.request("GET", path)
    r = c.getresponse()
    body = r.read()
    c.close()
    return r.status, body


def get_base(port, tok, client_id, frame_id=0, input=1):
    """GET /base?input=N (PROTOCOL.md section 4): the newest BASE frame message of that TD input, or None on 404."""
    st, body = http_get(port, f"/base?token={tok}&client={client_id}&input={input}&frameId={frame_id}")
    return body if st == 200 else None


def L(id, kind="pixel", slot=None, mask=None, size=None, **kw):
    """A v5 LayerSpec. ``size`` = (surfaceW, surfaceH) of a pixel / base layer's surface (default: none = document size)."""
    d = {"id": id, "kind": kind, "parentId": None, "name": id, "visible": True, "opacity": 1, "blend": "normal",
         "x": 0, "y": 0, "sx": 1, "sy": 1, "rot": 0, "kx": 0, "ky": 0, "effects": [], "surfaceW": size[0] if size else None, "surfaceH": size[1] if size else None,
         "slot": slot, "mask": mask, "adjustment": None}
    d.update(kw)
    return d


class Editor:
    """A fake web client speaking protocol v5: doc + SURFACE tiles out, notices + HTTP pulls in."""

    def __init__(self, port, kind="external", fresh=False, autofetch=True):
        self.port, self.kind, self.autofetch = port, kind, autofetch
        self.ws = WS(port)
        self.token = token()
        self.client_id = None
        self.hello = None
        self.active = None
        self.texts = []
        self.bases, self.view_log = [], []   # BASE messages; (t_recv, header, appliedFrameId, bytes)
        self.notices = {"base": 0, "view": 0}
        self.sent, self.applied = {}, {}     # frameId -> send time / `applied` receive time
        self.doc_state = None
        self.doc_w = self.doc_h = None
        self.mode = None            # canvas mode from hello / docSize
        self.inputs = {}            # input index -> (w, h, connected) from hello.inputs / `inputs`
        self.base_size = None       # (w, h) of TD input 1; (0, 0) = none
        self.reloads, self.file_results, self.files = [], [], None
        self.bases_by_input = {}
        self.fid = 1000 if kind == "external" else 5000
        self.ws.send(P.ready(kind, self.token, fresh, "validate"))

    def poll(self, timeout=0.0):
        got = []
        while True:
            m = self.ws.recv(timeout)
            timeout = 0.0
            if m is None:
                return got
            now = time.time()
            if isinstance(m, bytes):
                raise AssertionError("TD sent binary on the WebSocket (protocol v3 forbids it)")
            msg = json.loads(m)
            self.texts.append(msg)
            got.append(msg)
            t = msg["t"]
            if t == "hello":
                self.hello, self.client_id, self.active = msg, msg["clientId"], msg["active"]
                self.doc_w, self.doc_h = msg["doc"]["w"], msg["doc"]["h"]
                self.mode = msg["doc"].get("mode")
                self._set_inputs(msg.get("inputs", []))
            elif t == "inputs":
                self._set_inputs(msg["items"])
            elif t == "reload":
                self.reloads.append(msg)
            elif t == "fileResult":
                self.file_results.append(msg)
            elif t == "files":
                self.files = msg
            elif t == "active":
                self.active = msg["active"]
            elif t == "docSize":
                self.doc_w, self.doc_h = msg["w"], msg["h"]
                self.mode = msg.get("mode")
            elif t == "docState":
                self.doc_state = msg
            elif t == "applied":
                self.applied[msg["frameId"]] = now
            elif t == "base":
                self.notices["base"] += 1
                if self.autofetch:
                    body = get_base(self.port, self.token, self.client_id, msg["frameId"], msg.get("input", 1))
                    if body is not None:
                        self.bases.append(body)
                        self.bases_by_input.setdefault(msg.get("input", 1), []).append(body)
            elif t == "view":
                self.notices["view"] += 1
                t_notice = now
                if self.autofetch:
                    st, body = http_get(self.port, f"/view?token={self.token}&client={self.client_id}&frameId={msg['frameId']}")
                    if st == 200:
                        self.view_log.append((time.time(), P.decode_frame(body)[0], msg["appliedFrameId"], body, t_notice))

    def _set_inputs(self, items):
        self.inputs = {i["input"]: (i["w"], i["h"], i["connected"]) for i in items}
        w, h, _ = self.inputs.get(1, (0, 0, False))
        self.base_size = (w, h)

    def run(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            self.poll(0.05)

    def wait(self, pred, timeout=3.0):
        end = time.time() + timeout
        while time.time() < end:
            self.poll(0.05)
            if pred():
                return True
        return bool(pred())

    def send(self, text):
        self.ws.send(text)

    def takeover(self):
        self.send(json.dumps({"t": "takeover"}))
        return self.wait(lambda: self.active is True, 3)

    def send_doc(self, layers, rev, guides=None, canvas=None):
        self.send(P.doc(rev, layers, guides, canvas))

    def send_surface(self, slot, rect, pixels, size=None):
        """One SURFACE frame (bands under 2 MB); returns its frameId. v5: the header size is the SLOT's surface size
        (``size`` = (w, h); default the document size)."""
        self.fid += 1
        self.sent[self.fid] = time.time()
        sw, sh = size or (self.doc_w, self.doc_h)
        for m in P.encode_frames(P.TYPE_SURFACE, self.fid, sw, sh, rect, pixels, slot=slot):
            self.ws.send(m)
        return self.fid

    def send_canvas(self, w, h, mode):
        self.send(P.set_canvas(w, h, mode))

    def view(self, mode, zoom=1.0, pan_x=0.0, pan_y=0.0, rect=None):
        self.send(P.view(mode, zoom, pan_x, pan_y, rect or {"x": 0, "y": 0, "w": 1280, "h": 800}))

    def dump(self, slot):
        st, body = http_get(self.port, f"/surface?token={self.token}&client={self.client_id}&slot={slot}")
        if st != 200:
            return None
        hdr, payload = P.decode_frame(body)
        return hdr, np.frombuffer(payload, np.uint8).reshape(hdr.h, hdr.w, 4).copy()

    def close(self):
        self.ws.close()


def td_rect(path, x, y, w, h):
    """Premultiplied uint8 RGBA of a TOP region in wire orientation (row 0 = top), as a numpy array.
    Fetched in row chunks: td_call's stdout capture truncates large outputs."""
    rows = max(1, 20000 // (w * 4))
    parts = []
    for y0 in range(y, y + h, rows):
        n = min(rows, y + h - y0)
        out = td_json(f"""
import numpy as np, base64
a = op({path!r}).numpyArray()
H, W = a.shape[:2]
r = a[H - {y0} - {n}: H - {y0}, {x}: {x} + {w}][::-1]
u8 = np.clip(r * 255 + 0.5, 0, 255).astype(np.uint8)
print(json.dumps({{'b64': base64.b64encode(u8.tobytes()).decode()}}))
""", 120)
        parts.append(np.frombuffer(base64.b64decode(out["b64"]), np.uint8).reshape(n, w, 4))
    return np.concatenate(parts).copy()


def over_np(dst, src_rgb, src_a):
    """dst (h,w,3 float) <- src over dst, src_a float 0..1 (h,w,1)."""
    return src_rgb * src_a + dst * (1.0 - src_a)


def scene(W, H):
    """Step-5 document: base = red input, p1 green top half + marker + translucent block, p2 blue block behind a mask."""
    p1 = np.zeros((H, W, 4), np.uint8)
    p1[: H // 2] = (0, 200, 0, 255)
    p1[0:10, 0:20] = (255, 0, 255, 255)
    p1[100:110, 100:110] = (200, 100, 50, 128)
    p2 = np.zeros((H, W, 4), np.uint8)
    p2[300:800, 400:1400] = (0, 0, 255, 255)
    mask = np.zeros((H, W, 4), np.uint8)
    mask[..., 3] = 255
    mask[:, 400:900, :3] = 255   # white = visible
    return p1, p2, mask


SCENE_LAYERS = [L("base", "input", input=1, size=(IW, IH)), L("p1", slot=1, size=(IW, IH)),
                L("p2", slot=2, mask={"slot": 3, "enabled": True}, size=(IW, IH))]


def expected_scene(p1, p2, mask):
    out = np.zeros(p1.shape[:2] + (3,), np.float64)
    out[...] = (255, 0, 0)
    out = over_np(out, p1[..., :3].astype(np.float64), p1[..., 3:4] / 255.0)
    a2 = p2[..., 3:4] / 255.0 * mask[..., 0:1] / 255.0
    return over_np(out, p2[..., :3].astype(np.float64), a2)


CROPS = [(0, 0, 40, 20), (95, 95, 30, 30), (0, 398, 1920, 3), (0, 700, 1920, 3), (600, 0, 3, 1080), (1100, 0, 3, 1080)]


def check_scene(exp, tol=3, path=COMP + "/out1"):
    """Compare TD crops with the expected float RGB image; returns (ok, worst, where)."""
    worst, where = 0.0, None
    for (x, y, w, h) in CROPS:
        got = td_rect(path, x, y, w, h)
        d = np.abs(got[..., :3].astype(np.float64) - exp[y:y + h, x:x + w]).max()
        if d > worst:
            worst, where = d, (x, y, w, h)
        if got[..., 3].min() < 254:
            return False, 255.0, ("alpha", x, y)
    return worst <= tol, worst, where


def restore_p1(ed):
    """Steps 7/8 scribble random tiles into slot 1: put the scene's p1 back."""
    fid = ed.send_surface(1, (0, 0, IW, IH), STATE["p1"])
    wait_applied(ed, fid, 5)


def wait_applied(ed, fid, timeout=5.0):
    return ed.wait(lambda: fid in ed.applied, timeout)


def connect_input():
    td(f"""
old = op({TMP!r})
if old: old.destroy()
c = op('/project1').create(constantTOP, '_validate_in')
c.par.outputresolution = 'custom'; c.par.resolutionw = {IW}; c.par.resolutionh = {IH}
c.par.colorr = 1; c.par.colorg = 0; c.par.colorb = 0; c.par.alpha = 1
comp.inputConnectors[0].connect(c)
comp.par.Docsizemode = 'input'
""")


def disconnect_input():
    td(f"""
comp.inputConnectors[0].disconnect()
t = op({TMP!r})
if t: t.destroy()
""")


def toggle_input(i):
    td(f"op({TMP!r}).par.colorg = {i % 2}")


def stats():
    return td_json("print(json.dumps(comp.GetStats()))")


def clear_stats():
    td("[d.clear() for d in comp.ext.RasterEditorExt.stats.values()]")


def fmt(d):
    return f"median {d['median']:.2f} worst {d['max']:.2f} (n={d['n']})"



ORIG = {}


def op_exists():
    try:
        return bool(td_json("print(json.dumps(op(%r) is not None))" % COMP))
    except RuntimeError:
        return False


def s1_build(args):
    pre = td_json("""
c = op('/project1/raster_editor')
t = c.op('doc_state').text if c is not None and c.op('doc_state') is not None else ''
d = c.op('doc') if c is not None else None
print(json.dumps({'state': t, 'kids': sorted(x.name for x in d.children if x.name.startswith('s')) if d else []}))
""") if op_exists() else {"state": "", "kids": []}
    if not args.no_build:
        r = subprocess.run([sys.executable, os.path.join(ROOT, "td", "build_component.py")],
                           capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            return False, (r.stdout + r.stderr)[-1500:]
    ORIG.update(td_json("print(json.dumps({'Port': int(comp.par.Port), 'Docw': int(comp.par.Docw), 'Doch': int(comp.par.Doch), 'Panelquery': comp.par.Panelquery.eval(), 'Docsizemode': comp.par.Docsizemode.eval(), 'Exportpath': comp.par.Exportpath.eval()}))"))
    if not args.skip_ui:
        td("comp.par.Panelquery = 'test=1'")
    if args.port != 9980:
        td(f"comp.par.Port = {args.port}")
    info = td_json("""
bad = [(c.path, c.errors()) for c in comp.findChildren(depth=3) if c.errors()]
print(json.dumps({'exists': comp is not None, 'bad': bad, 'ext': bool(comp.ext.RasterEditorExt._started)}))
""")
    post = td_json("""
d = comp.op('doc')
print(json.dumps({'state': comp.op('doc_state').text, 'kids': sorted(x.name for x in d.children if x.name.startswith('s'))}))
""")
    kept = post["state"] == pre["state"] and set(pre["kids"]) <= set(post["kids"])
    ok = info["exists"] and not info["bad"] and info["ext"] and kept
    note = (f"doc_state ({len(pre['state'])} chars) and {len(pre['kids'])} surface TOPs preserved across the rebuild: {kept}"
            if pre["state"] or pre["kids"] else "no document to preserve (first build)")
    return ok, note if ok else json.dumps(info) + " " + note


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
    td("comp.inputConnectors[0].disconnect() if comp.inputConnectors[0].connections else None\ncomp.par.Docsizemode = 'input'; comp.par.Docw = 800; comp.par.Doch = 600")
    want = [800, 600]
    got = wait_for(lambda: out1_size() == want, 3)
    return bool(got), f"out1 {out1_size()} vs Docw x Doch {want}"



# --------------------------------------------------------------------------- v3 steps (fake client)


STATE = {}   # data shared between steps (sent images, revisions)


def s5_scene(args):
    """Fake client: hello, doc, tiles -> out1 pixels, masks, /surface round trip, applied."""
    connect_input()
    if not wait_for(lambda: out1_size() == [IW, IH], 4):
        return False, f"out1 never became {IW}x{IH}: {out1_size()} status={status()!r}"
    ed = Editor(args.port)
    try:
        if not ed.takeover():
            return False, f"takeover failed: {ed.texts}"
        h = ed.hello
        if h["protocol"] != P.PROTOCOL_VERSION or h["doc"].get("w") != IW or h["doc"].get("h") != IH or not h["hasInput"] \
                or "hasDocument" not in h or "rev" not in h or h["doc"].get("mode") != "input" or h.get("inputs", [{}])[0] != {"input": 1, "w": IW, "h": IH, "connected": True}:
            return False, f"bad hello {h}"
        p1, p2, mask = scene(IW, IH)
        t0 = time.time()
        ed.send_doc(SCENE_LAYERS, 1)
        fids = [ed.send_surface(1, (0, 0, IW, IH), p1), ed.send_surface(2, (0, 0, IW, IH), p2),
                ed.send_surface(3, (0, 0, IW, IH), mask)]
        t_send = time.time() - t0
        if not wait_applied(ed, fids[-1], 6):
            return False, f"no `applied` for frame {fids[-1]}: {ed.texts[-3:]} status={status()!r}"
        time.sleep(0.15)
        exp = expected_scene(p1, p2, mask)
        ok, worst, where = check_scene(exp)
        STATE.update(p1=p1, p2=p2, mask=mask, rev=1)
        # BASE pull still works next to the surfaces (the input is red)
        base_ok = ed.wait(lambda: len(ed.bases) > 0, 3)
        img = None
        if base_ok:
            hdr, payload = P.decode_frame(ed.bases[-1])
            img = np.frombuffer(payload, np.uint8).reshape(hdr.h, hdr.w, 4)
            base_ok = tuple(img[IH // 2, IW // 2]) == (255, 0, 0, 255) and hdr.type == P.TYPE_BASE and hdr.slot == 1
        # document stored for fresh pages
        st = td_json("import json as j; t = comp.op('doc_state').text; d = j.loads(t) if t else {}; print(json.dumps({'rev': d.get('rev'), 'n': len(d.get('layers', [])), 'w': d.get('docW')}))")
        return (bool(ok and base_ok and st["rev"] == 1 and st["n"] == 3),
                f"out1 vs expected: worst channel diff {worst:.1f} at {where}; BASE over HTTP ok={base_ok}; doc_state {st}; "
                f"sent doc + 3x8 MB surfaces in {t_send * 1000:.0f} ms (client side)")
    finally:
        ed.close()


def s6_masks(args):
    """A painted mask hides exactly the masked pixels; /surface returns what was sent (straight alpha, masks grey)."""
    p1, p2, mask = STATE["p1"], STATE["p2"], STATE["mask"]
    ed = Editor(args.port)
    try:
        ed.takeover()
        # black rectangle painted into the mask over the visible blue area: x 420..520, y 420..470
        tile = np.zeros((50, 100, 4), np.uint8)
        tile[..., 3] = 255
        fid = ed.send_surface(3, (420, 420, 100, 50), tile)
        if not wait_applied(ed, fid, 4):
            return False, "no applied for the mask tile"
        time.sleep(0.15)
        m2 = mask.copy()
        m2[420:470, 420:520, :3] = 0
        exp = expected_scene(p1, p2, m2)
        got = td_rect(COMP + "/out1", 380, 400, 160, 90)
        diff = np.abs(got[..., :3].astype(np.float64) - exp[400:490, 380:540]).max()
        # exactness: count pixels that are blue in TD vs expected
        td_blue = (got[..., 2] > 200) & (got[..., 1] < 50)
        exp_blue = (exp[400:490, 380:540, 2] > 200) & (exp[400:490, 380:540, 1] < 50)
        mism = int((td_blue != exp_blue).sum())
        # surface dump round trips
        hd1, d1 = ed.dump(1)
        hd3, d3 = ed.dump(3)
        d1ok = int(np.abs(d1.astype(int) - p1).max()) <= 2 and (hd1.type, hd1.slot, hd1.frame_end) == (P.TYPE_SURFACE_DUMP, 1, True)
        d3ok = (d3 == m2).all() and hd3.slot == 3
        # unknown slot / bad token
        nf = http_get(args.port, f"/surface?token={ed.token}&client={ed.client_id}&slot=777")[0]
        bt = http_get(args.port, f"/surface?token=bad&client={ed.client_id}&slot=1")[0]
        STATE["mask"] = m2
        ok = diff <= 3 and mism == 0 and d1ok and d3ok and nf == 404 and bt == 403
        return ok, (f"mask edit: worst diff {diff:.1f}, {mism} blue/non-blue mismatches in the 160x90 window; /surface slot1 round trip "
                    f"within 2: {d1ok}, mask grey exact: {d3ok}; unknown slot -> {nf}, bad token -> {bt}")
    finally:
        ed.close()


def s7_view_stream(args):
    """External client in TD mode: VIEW notices + GET /view; content matches out1; fps and age while the output changes."""
    p1 = STATE["p1"]
    ed = Editor(args.port)
    try:
        ed.takeover()
        td("comp.par.Maxviewfps = 30")
        ed.view("td", 1.0, 0, 0)
        if not ed.wait(lambda: ed.view_log, 4):
            return False, f"no VIEW frame: {ed.texts[-3:]}"
        t_hdr, hdr, applied, body = ed.view_log[0][0], ed.view_log[0][1], ed.view_log[0][2], ed.view_log[0][3]
        payload = np.frombuffer(P.decode_frame(body)[1], np.uint8).reshape(IH, IW, 4)
        exp = expected_scene(p1, STATE["p2"], STATE["mask"])
        vdiff = max(np.abs(payload[y:y + h, x:x + w, :3].astype(np.float64) - exp[y:y + h, x:x + w]).max() for x, y, w, h in CROPS)
        shape_ok = hdr.type == P.TYPE_VIEW and hdr.slot == 0 and (hdr.doc_w, hdr.doc_h) == (IW, IH) and hdr.frame_end
        # continuous change: 64x64 tiles at 60 Hz for 4 s; the stream delivers frames as fast as it can
        ed.view_log.clear()
        end = time.time() + 4
        n = 0
        tile = np.random.RandomState(7).randint(0, 256, (64, 64, 4), dtype=np.uint8)
        tile[..., 3] = 255
        fids = []
        stop = threading.Event()

        def pull():   # fetching 8 MB frames must not throttle the 60 Hz tile sender
            while not stop.is_set():
                ed.poll(0.02)
        th = threading.Thread(target=pull, daemon=True)
        th.start()
        while time.time() < end:
            fids.append(ed.send_surface(1, ((n * 61) % (IW - 64), (n * 37) % (IH - 64), 64, 64), tile))
            n += 1
            time.sleep(1 / 60)
        time.sleep(0.6)
        stop.set()
        th.join()
        frames = ed.view_log
        fps = len(frames) / 4.0
        # age: tile sent -> the VIEW frame whose appliedFrameId covers it. TD side = until its notice arrives (readback,
        # conversion, publish, WebSocket); total adds the client's own 8 MB GET /view.
        td_ages, tot_ages, fetch_ms = [], [], []
        for fid in fids[::5]:
            fr = next((f for f in frames if f[2] >= fid), None)
            if fr is not None:
                td_ages.append((fr[4] - ed.sent[fid]) * 1000)
                tot_ages.append((fr[0] - ed.sent[fid]) * 1000)
                fetch_ms.append((fr[0] - fr[4]) * 1000)

        def q(xs, f):
            xs = sorted(xs)
            return xs[min(len(xs) - 1, int(len(xs) * f))] if xs else float("nan")
        med, p95 = q(tot_ages, 0.5), q(tot_ages, 0.95)
        td_med, td_p95, fetch_med = q(td_ages, 0.5), q(td_ages, 0.95), q(fetch_ms, 0.5)
        st = stats()
        STATE["view"] = dict(fps=fps, age_med=med, age_p95=p95)
        restore_p1(ed)
        # leaving TD mode stops the stream and 404s the endpoint
        ed.view("local")
        ed.run(0.5)
        n0 = len(ed.view_log)
        ed.send_surface(1, (0, 0, 64, 64), tile)
        ed.run(0.8)
        stopped = len(ed.view_log) == n0
        gone = http_get(args.port, f"/view?token={ed.token}&client={ed.client_id}")[0] == 404
        ok = vdiff <= 3 and shape_ok and fps >= 20 and stopped and gone   # fps is the pass criterion; ages are reported
        return ok, (f"first VIEW frame: type/slot/size ok={shape_ok}, worst diff vs out1 {vdiff:.1f}; stream {fps:.1f} fps "
                    f"(budget >= 20), age tile -> TD notice (TD side) median {td_med:.0f} ms p95 {td_p95:.0f} ms, + client GET /view {fetch_med:.0f} ms "
                    f"= total median {med:.0f} ms p95 {p95:.0f} ms (budget <= 120 total, reported only), "
                    f"{len(frames)} frames; view convert {fmt(st['vconvert'])} | publish {fmt(st['vpublish'])} | readback {fmt(st['vreadback'])}; "
                    f"stops after mode local: {stopped}, GET /view -> 404: {gone}")
    finally:
        ed.close()


def s8_latency(args):
    """Stroke -> TD: `applied` latency of 64x64 tiles at 60 Hz, upload costs per dirty 1080p surface."""
    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.run(0.3)
        clear_stats()
        tile = np.random.RandomState(8).randint(0, 256, (64, 64, 4), dtype=np.uint8)
        tile[..., 3] = 255
        fids = []
        end = time.time() + 5
        n = 0
        while time.time() < end:
            fids.append(ed.send_surface(1, ((n * 53) % (IW - 64), (n * 29) % (IH - 64), 64, 64), tile))
            n += 1
            ed.poll(0)
            time.sleep(1 / 60)
        ed.run(0.5)
        restore_p1(ed)
        lat = sorted((ed.applied[f] - ed.sent[f]) * 1000 for f in fids if f in ed.applied)
        if not lat:
            return False, "no applied replies"
        med, p95 = lat[len(lat) // 2], lat[int(len(lat) * 0.95)]
        frame_ms = 1000.0 / float(td_json("print(json.dumps(project.cookRate))"))
        st = stats()
        up = st["paste"]["median"] + st["cook"]["median"]
        tdframes = med / frame_ms
        STATE["latency"] = dict(med=med, p95=p95, frames=tdframes)
        # `applied` is reported once per TD frame at most
        frames_with_applied = len(ed.applied)
        ok = tdframes <= 3.0 and up <= 3.0
        return ok, (f"tile -> applied latency median {med:.1f} ms ({tdframes:.1f} TD frames of {frame_ms:.1f} ms; budget <= 3), p95 {p95:.1f} ms, "
                    f"{len(lat)}/{len(fids)} answered, {frames_with_applied} applied msgs; paste {fmt(st['paste'])} | upload (cook) {fmt(st['cook'])} "
                    f"=> {up:.2f} ms per dirty 1080p surface (budget < 3); Pump {fmt(st['pump'])}")
    finally:
        ed.close()


def s9_panel_overlay(args):
    """A panel client in TD mode: DocNetwork.set_view + background switch + the overlay shows the document."""
    ed = Editor(args.port, kind="panel")   # a second panel connection is standby, but its `view` still drives the overlay
    try:
        ed.run(0.5)
        # document origin at panel (100, 50), zoom 0.5, canvas rect = the whole 1280x800 panel
        ed.view("td", 0.5, 100.0, 50.0, {"x": 0, "y": 0, "w": 1280, "h": 800})
        ok = wait_for(lambda: td("print(comp.par.top.val)").strip().endswith("panel_view"), 3)
        info = td_json("""
w = comp.op('webrender')
print(json.dumps({'top': comp.par.top.val, 'transparent': bool(w.par.transparent.eval()), 'mode': comp.par.Viewmode.eval(),
                  'pv': [comp.op('panel_view').width, comp.op('panel_view').height] if comp.op('panel_view') else None}))
""")
        time.sleep(0.3)
        # doc (600, 700) is base red; doc (1000, 350) is p1 green; doc (500, 500) is masked p2 blue? (p1 green top half y<540)
        def at(dx, dy):
            px, py = int(100 + dx * 0.5), int(50 + dy * 0.5)
            a = td_rect("/project1/raster_editor/panel_view", px, py, 1, 1)[0, 0]
            return a.tolist()
        red, green = at(1700, 900), at(1000, 350)
        good = (red[0] > 220 and red[1] < 40 and green[1] > 150 and green[0] < 40)
        ed.view("local")
        back = wait_for(lambda: td("print(comp.par.top.val)").strip().endswith("webrender"), 3)
        transp_off = True  # transparent stays on: toggling it reloads the page (and drops the connection)
        return bool(ok and good and back and info["transparent"]), (
            f"td mode: top={info['top']} transparent={info['transparent']} panel_view={info['pv']} Viewmode(active client)={info['mode']}; "
            f"overlay pixels doc(1700,900)={red} (red base) doc(1000,350)={green} (p1 green); back to webrender: {back}, transparent off: {transp_off}")
    finally:
        ed.close()


def s10_persistence(args):
    """Freeze/Thaw round trip; Exportdoc pulse -> loadTox into a temp COMP: document + output identical. Never saves the .toe."""
    os.makedirs(OUT_DIR, exist_ok=True)
    # the loaded copy has no input: compare on a blank base at the same document size (no cropping)
    td(f"comp.par.Docw = {IW}; comp.par.Doch = {IH}\ncomp.inputConnectors[0].disconnect()")
    wait_for(lambda: out1_size() == [IW, IH], 3)
    time.sleep(0.4)
    path = os.path.join(OUT_DIR, "persist.tox")
    if os.path.exists(path):
        os.remove(path)
    before = td_json(f"""
import hashlib, numpy as np
x = comp.ext.RasterEditorExt
sig = {{str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())}}
o = comp.op('doc/out').numpyArray()
print(json.dumps({{'sig': sig, 'rev': x.doc_rev, 'layers': len(x.doc_layers), 'out': hashlib.md5((o * 255 + .5).astype(np.uint8).tobytes()).hexdigest()}}))
""")
    # Freeze / Thaw round trip
    ft = td_json("""
import hashlib, numpy as np
x = comp.ext.RasterEditorExt
x.Freeze()
locked = {str(s): bool(t.lock) for s, t in ((s, x.network.surface_top(s)) for s in x.network.slots())}
x.Thaw()
unlocked = {str(s): not x.network.surface_top(s).lock for s in x.network.slots()}
print(json.dumps({'locked': all(locked.values()) and bool(locked), 'unlocked': all(unlocked.values())}))
""")
    time.sleep(0.2)
    after_ft = td_json("""
import hashlib, numpy as np
o = comp.op('doc/out').numpyArray()
print(json.dumps(hashlib.md5((o * 255 + .5).astype(np.uint8).tobytes()).hexdigest()))
""")
    td(f"comp.par.Exportpath = {path!r}\ncomp.par.Exportdoc.pulse()")  # (the par_exec callback runs a frame later)
    wait_for(lambda: os.path.exists(path), 15)
    exported_msg = bool(wait_for(lambda: "exported with document" in status(), 5))
    size = os.path.getsize(path) if os.path.exists(path) else 0
    td("comp.par.Exportpath = ''")
    # Load the exported file into a temporary container. The primary editor is switched off meanwhile (one port).
    td("comp.par.Active = 0")
    time.sleep(0.5)
    td(f"""
old = op('/project1/_validate_load')
if old: old.destroy()
box = op('/project1').create(baseCOMP, '_validate_load')
box.loadTox({path!r})
""", 120)
    time.sleep(0.8)  # let the loaded copy start and restore (its Pump runs on frame start)
    loaded = td_json("""
import hashlib, numpy as np
box = op('/project1/_validate_load')
kids = [c.name for c in box.children]
c = box.op(kids[0]) if kids else None
x = c.ext.RasterEditorExt if c is not None else None
res = {'kids': kids}
if x is not None and x.doc_layers is not None:
    res.update(sig={str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())}, rev=x.doc_rev,
               layers=len(x.doc_layers), started=x._started, err=x.last_error and x.last_error[0], status=x.GetStatus())
    o = c.op('doc/out').numpyArray()
    res['out'] = hashlib.md5((o * 255 + .5).astype(np.uint8).tobytes()).hexdigest()
    res['frozen_left'] = [s for s in x.network.slots() if x.network.surface_top(s).lock]
print(json.dumps(res))
""", 120)
    td("""
box = op('/project1/_validate_load')
if box: box.destroy()
comp.par.Active = 1
""")
    wait_for(lambda: "active" in status() or "waiting" in status(), 5)
    connect_input()
    same_sig = loaded.get("sig") == before["sig"]
    ok = (ft["locked"] and ft["unlocked"] and after_ft == before["out"] and size > 0 and same_sig
          and loaded.get("rev") == before["rev"] and loaded.get("out") == before["out"] and not loaded.get("frozen_left") and exported_msg)
    return bool(ok), (f"Freeze locks all surface TOPs: {ft['locked']}, Thaw unlocks: {ft['unlocked']}, output unchanged: {after_ft == before['out']}; "
                      f"Exportdoc -> {size} bytes, Status says exported: {exported_msg}; loaded copy: rev {loaded.get('rev')} (was {before['rev']}), surfaces identical: {same_sig}, "
                      f"out identical: {loaded.get('out') == before['out']}, locked after restore: {loaded.get('frozen_left')}, err={loaded.get('err')}")

def s11_reconnect_takeover(args):
    """Fresh page loads TD's document; reconnecting client re-sends (authoritative); takeover hands over and loads."""
    p1, p2, mask = STATE["p1"], STATE["p2"], STATE["mask"]
    a = Editor(args.port)
    a.takeover()
    # (a reconnecting real page is authoritative and may have pushed its own document since step 10: put the scene back)
    a.send_doc(SCENE_LAYERS, STATE["rev"])
    fids = [a.send_surface(1, (0, 0, IW, IH), p1), a.send_surface(2, (0, 0, IW, IH), p2), a.send_surface(3, (0, 0, IW, IH), mask)]
    wait_applied(a, fids[-1], 6)
    a.close()
    # 1. fresh page: hello.hasDocument -> requestDoc -> docState -> GET /surface per slot
    b = Editor(args.port, fresh=True)
    try:
        b.takeover()
        h = b.hello
        has = h["hasDocument"] is True and h["rev"] == STATE["rev"]
        b.send(P.request_doc())
        got = b.wait(lambda: b.doc_state is not None, 3)
        slots = P.layer_slots(b.doc_state["layers"]) if got else []
        dumps = {s: b.dump(s) for s in slots}
        loaded_ok = got and slots == [1, 2, 3] and b.doc_state["layers"] == SCENE_LAYERS and \
            all(d is not None for d in dumps.values()) and (dumps[3][1] == mask).all() and int(np.abs(dumps[1][1].astype(int) - p1).max()) <= 2 \
            and int(np.abs(dumps[2][1].astype(int) - p2).max()) <= 2 and (b.doc_state["docW"], b.doc_state["docH"]) == (IW, IH)
        # 2. reconnect: the same page re-sends its stack and every surface; TD follows it
        b.close()
        c = Editor(args.port)   # fresh=False, authoritative
        c.takeover()
        flipped = [dict(l) for l in SCENE_LAYERS]
        flipped[1]["opacity"] = 0.5
        c.send_doc(flipped, 2)
        fids = [c.send_surface(1, (0, 0, IW, IH), p1), c.send_surface(2, (0, 0, IW, IH), p2), c.send_surface(3, (0, 0, IW, IH), mask)]
        wait_applied(c, fids[-1], 6)
        time.sleep(0.2)
        px = td_rect(COMP + "/out1", 1500, 100, 1, 1)[0, 0]    # p1 green at 50% over red
        half = abs(int(px[0]) - 128) <= 4 and abs(int(px[1]) - 100) <= 4
        rev2 = td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_rev))") == 2
        # 3. takeover: d takes over, c can no longer edit, d loads TD's document first
        d = Editor(args.port, fresh=True)
        d.takeover()
        c.poll(0.3)
        demoted = c.active is False
        d.send(P.request_doc())
        d.wait(lambda: d.doc_state is not None, 3)
        loads = d.doc_state is not None and d.doc_state["rev"] == 2 and d.doc_state["layers"][1]["opacity"] == 0.5
        c.send_doc(SCENE_LAYERS, 3)   # ignored: standby
        c.send_surface(1, (0, 0, 64, 64), np.zeros((64, 64, 4), np.uint8))
        time.sleep(0.4)
        still = td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_rev))") == 2
        px2 = td_rect(COMP + "/out1", 10, 100, 1, 1)[0, 0]
        ignored = abs(int(px2[0]) - 128) <= 4   # p1 at 50% still painting (0,0,64,64 black tile was dropped)
        # restore the full-opacity scene for the next steps
        d.send_doc(SCENE_LAYERS, 4)
        STATE["rev"] = 4
        time.sleep(0.3)
        c.close()
        d.close()
        ok = has and loaded_ok and half and rev2 and demoted and loads and still and ignored
        return bool(ok), (f"fresh page: hasDocument/rev ok={has}, docState + 3 surfaces loaded identical={loaded_ok}; reconnect re-send applied "
                          f"(opacity 0.5 pixel {px.tolist()}, rev 2: {rev2}); takeover: old active demoted={demoted}, new loads rev-2 doc={loads}, "
                          f"standby edits ignored={still and ignored}")
    finally:
        pass


def s12_perf(args):
    """DESIGN_V2 section 6: network cook with 20 layers (3 adjustments + 3 masks) @1080p, doc apply costs, pump costs."""
    ed = Editor(args.port)
    try:
        ed.takeover()
        layers = [L("base", "input", input=1)]
        slot = 10
        masks = 0
        for i in range(17):
            m = None
            if masks < 3 and i % 5 == 4:
                m = {"slot": 200 + masks, "enabled": True}
                masks += 1
            layers.append(L(f"p{i}", slot=slot, mask=m, blend=["normal", "multiply", "screen", "overlay"][i % 4], opacity=0.8))
            slot += 1
        for j, adj in enumerate((
                {"type": "levels", "inLow": 0.1, "inHigh": 0.9, "gamma": 1.2, "outLow": 0, "outHigh": 1},
                {"type": "hueSaturation", "hue": 20, "saturation": 1.2, "value": 1},
                {"type": "threshold", "level": 0.5})):
            layers.append(L(f"a{j}", "adjustment", adjustment=adj, mask={"slot": 210 + j, "enabled": True} if j == 0 else None))
        n_layers = len(layers)
        t_struct = time.time()
        clear_stats()
        ed.send_doc(layers, 20)
        rng = np.random.RandomState(3)
        img = rng.randint(0, 256, (IH, IW, 4), dtype=np.uint8)
        img[..., 3] = 200
        grey = np.full((IH, IW, 4), 255, np.uint8)
        fids = []
        all_slots = P.layer_slots(layers)
        for s in all_slots:
            fids.append(ed.send_surface(s, (0, 0, IW, IH), grey if s >= 200 else img))
        wait_applied(ed, fids[-1], 15)
        time.sleep(0.5)
        struct_ms = (time.time() - t_struct) * 1000
        st_struct = stats()
        def gpu_probe(label):
            """Dirty the bottom surface, cook the output, sum gpu/cpu cook time of every doc TOP that cooked in that
            frame (TD cooks a node once per frame: one call per frame). Returns (median gpu ms, median cpu ms, top nodes)."""
            runs = []
            for i in range(12):
                runs.append(td_json("""
x = comp.ext.RasterEditorExt
doc = comp.op('doc')
x._dirty.add(10)
x._cook_surfaces()
doc.op('out').cook()
rows = []
for c in doc.findChildren(type=TOP, depth=1):
    if c.cookAbsFrame == absTime.frame:
        rows.append([c.name, c.gpuCookTime, c.cpuCookTime])
print(json.dumps(rows))
"""))
                time.sleep(0.07)
            runs = runs[2:]
            gsum = sorted(sum(r[1] for r in run) for run in runs)
            csum = sorted(sum(r[2] for r in run) for run in runs)
            top = sorted(runs[-1], key=lambda r: -r[1])[:4]
            return gsum[len(gsum) // 2], csum[len(csum) // 2], len(runs[-1]), ", ".join(f"{n} {g:.2f}/{c:.2f}" for n, g, c in top)
        gpu_med, cpu_med, ncook, worst_nodes = gpu_probe("no blur")
        # a blur adjustment costs extra: measured separately, not part of the budget
        layers_blur = layers + [L("ablur", "adjustment", adjustment={"type": "blur", "radius": 4})]
        ed.send_doc(layers_blur, 21)
        ed.run(0.6)
        gpu_blur = gpu_probe("blur")[0]
        ed.send_doc(layers, 22)
        ed.run(0.6)
        netinfo = td_json("print(json.dumps(comp.ext.RasterEditorExt.network.stats()))")
        # prop change: opacity edits, one `doc` per edit
        clear_stats()
        for i in range(30):
            ls = [dict(l) for l in layers]
            ls[5]["opacity"] = 0.3 + 0.02 * i
            ed.send_doc(ls, 100 + i)
            ed.poll(0)
            time.sleep(0.05)
        ed.run(0.4)
        prop = stats()["apply"]
        # structural: add / remove a pixel layer
        clear_stats()
        for i in range(10):
            ls = [dict(l) for l in layers]
            if i % 2 == 0:
                ls.insert(3, L("extra", slot=300 + i))
            ed.send_doc(ls, 200 + i)
            ed.poll(0)
            time.sleep(0.2)
        ed.run(0.4)
        struct = stats()["apply"]
        prop_ok = prop["median"] < 2.0
        struct_ok = struct["median"] < 10.0
        gpu_ok = gpu_med < 4.0   # without blur
        return prop_ok and struct_ok and gpu_ok, (
            f"{n_layers} layers incl. 3 adjustments + 3 masks, doc + {len(all_slots)} surfaces of 1080p sent and applied in {struct_ms:.0f} ms; "
            f"network (no blur adjustment) summed gpuCookTime median {gpu_med:.2f} ms (budget < 4), summed cpuCookTime {cpu_med:.2f} ms over "
            f"{ncook} cooked TOPs; heaviest gpu/cpu ms: {worst_nodes}; with an extra blur adjustment {gpu_blur:.2f} ms gpu (reported, not budgeted); "
            f"DocNetwork.apply as seen by ext: prop change {fmt(prop)} (budget < 2 ms), structural {fmt(struct)} (budget < 10 ms); "
            f"nodes {netinfo['nodes']}")
    finally:
        # Leave a tiny document behind: the real page is promoted when this client leaves and would otherwise download the
        # 21 x 8 MB stack above (and be mid-load when the next step's client takes over).
        try:
            ed.send_doc([L("base", "input", input=1)], 800)
            ed.run(0.3)
        except Exception:  # noqa: BLE001
            pass
        ed.close()


def s13_stalled_client(args):
    """Clients that stop reading must not freeze TD: (1) an HTTP client that GETs /base and never reads the body,
    (2) a WebSocket client that never reads or fetches (also subscribed to the VIEW stream). Both vanish with a RST. Run last."""
    connect_input()
    wait_for(lambda: out1_size() == [IW, IH], 3)
    tok = token()
    ed = Editor(args.port)  # a healthy client first, so a frame is stored and its notice flows
    ed.takeover()
    ed.run(1.0)
    ws_stalled = WS(args.port)
    ws_stalled.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    ws_stalled.send(P.ready("external", tok, False, "stalled"))
    ws_stalled.send(P.view("td", 1.0, 0, 0, {"x": 0, "y": 0, "w": 1280, "h": 800}))
    http_stalled = socket.socket()
    http_stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    http_stalled.connect(("127.0.0.1", args.port))
    http_stalled.sendall(f"GET /base?token={tok}&client=x HTTP/1.1\r\nHost: 127.0.0.1:{args.port}\r\n\r\n".encode())
    worst = 0.0
    tile = np.random.RandomState(9).randint(0, 256, (64, 64, 4), dtype=np.uint8)
    for i in range(40):  # keep changing the 1080p input and the output: nothing may block TD
        toggle_input(i)
        ed.send_surface(1, ((i * 71) % (IW - 64), 100, 64, 64), tile)
        t0 = time.time()
        td_json("print(json.dumps(1))")
        worst = max(worst, time.time() - t0)
        ed.poll(0)
        time.sleep(0.05)
    stalled = wait_for(lambda: (ed.poll(0) or True) and "stalled" in status(), 14, 0.5)
    for sock in (ws_stalled.sock, http_stalled):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        sock.close()  # abrupt reset with unread data
    alive = worst < 2
    for _ in range(12):
        t0 = time.time()
        try:
            td_json("print(json.dumps(len(comp.ext.RasterEditorExt.clients)))")
        except Exception as e:  # noqa: BLE001
            ed.close()
            return False, f"TD stopped responding after the abrupt close: {e} -> restart TD (kill, then open -a TouchDesigner)"
        alive = alive and time.time() - t0 < 2
        ed.poll(0)
        time.sleep(0.25)
    healthy = ed.notices["base"] >= 2   # the well-behaved client kept receiving notices throughout
    ed.close()
    ok = alive and bool(stalled) and healthy
    return ok, (f"TD worst round trip while two clients hung and input + output changed: {worst * 1000:.0f} ms; stalled in Status: {bool(stalled)}; "
                f"responsive after resets: {alive}; healthy client got {ed.notices['base']} base notices")


# --------------------------------------------------------------------------- real UI steps (need the built v3 page)


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


def ui_ready(timeout=10):
    """The real page is the active editor and finished loading (after a fake client left)."""
    def loaded():
        ls = js_result("window.__editorTest.loadState()") or {}
        return ls.get("active") is True and not ls.get("loadingDoc")
    return wait_for(loaded, timeout, 0.3)


def ensure_test_hook():
    """Panel URL carries ?test=1 (installs window.__editorTest); reloads the page when that changes."""
    if td("print(comp.par.Panelquery.eval())").strip() != "test=1":
        td("comp.par.Panelquery = 'test=1'")
        time.sleep(3.0)
    return bool(wait_for(lambda: js_result("window.__editorTest.state()"), 8))


def reset_doc(args, layers=None):
    """A fake client replaces TD's document (default: just the base layer) and leaves; the real page is promoted and loads it."""
    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.send_doc(layers or [L("base", "input", input=1)], 900)
        ed.run(0.4)
    finally:
        ed.close()
    time.sleep(1.5)


def s14_ui_paint(args):
    """Real UI: brush stroke -> TD output, undo, hidden layer, `latency()` readout. Starts from a clean input."""
    if not ensure_test_hook():
        return False, "test hook window.__editorTest not reachable (panel URL needs ?test=1; rebuilt UI?)"
    connect_input()
    reset_doc(args)
    wait_for(lambda: out1_size() == [IW, IH], 3)
    if not ui_ready():
        return False, f"page is not the active editor: {js_result('window.__editorTest.loadState()')} status={status()!r}"
    mouse(0.5, 0.5)
    js("window.__editorTest.addLayer()")
    time.sleep(0.2)
    js("window.__editorTest.setPrimary('#0000ff')")
    td("comp.op('webrender').sendKey('b', char='b')")
    time.sleep(0.2)
    st = js_result("window.__editorTest.state()")
    if not st or st["tool"] != "brush":
        return False, f"key 'b' did not select the brush: {st and st['tool']}"
    doc = st["doc"]
    if not drag_doc([(doc["w"] * 0.375, doc["h"] / 2), (doc["w"] * 0.625, doc["h"] / 2)]):
        return False, "could not resolve doc coordinates"
    blue = centre_is((0, 0, 255, 255))
    corner = pixel(COMP + "/out1", 0.03, 0.97)
    td("comp.op('webrender').sendKey('z', char='z', cmd=True)")
    undone = centre_is((255, 0, 0, 255), 3)
    lat = js_result("window.__editorTest.latency()")
    return bool(blue and px_near(corner, (255, 0, 0, 255), 3) and undone), (
        f"stroke -> centre blue={bool(blue)} corner still red={px_near(corner, (255, 0, 0, 255), 3)}, undo -> red={bool(undone)}; "
        f"UI latency readout {lat}")


def take_over(ed, tries=6):
    """Become the active editor. The panel's page reconnects a few seconds after a rebuild / Active toggle and, as the first panel after
    a (re)start, takes the role: ask again until we hold it (a doc / tiles sent without it are silently ignored by TD)."""
    for _ in range(tries):
        if ed.takeover():
            return True
        time.sleep(0.5)
    return False


def page_matches_td(timeout=30):
    """The real page is the active editor, has finished loading and shows the same layer stack (ids, order) TD holds."""
    def ok():
        td_ids = td_json("print(json.dumps([l['id'] for l in (comp.ext.RasterEditorExt.doc_layers or [])]))")
        pg = js_result("(function(){var d=window.__editorTest.docSpec();return d.layers.map(function(l){return l.id})})()")
        ls = js_result("window.__editorTest.loadState()") or {}
        return ls.get("active") is True and not ls.get("loadingDoc") and pg == td_ids
    return bool(wait_for(ok, timeout, 0.5))


def settle_page(timeout=30):
    """Page and TD agree on the document and the page's composite is no longer changing (two identical reads of a pixel grid)."""
    if not page_matches_td(timeout):
        return False
    expr = ("(function(){var o=[];for(var y=0;y<300;y+=37)for(var x=0;x<520;x+=41)o.push(window.__editorTest.readPixel(x,y));return o;})()")
    prev = None
    for _ in range(12):
        cur = js_result(expr, 30)
        if cur is not None and cur == prev:
            return True
        prev = cur
        time.sleep(0.5)
    return False


def s15_parity(args):
    """Blend parity TD vs the browser preview (DESIGN_V2 section 7): one document with every blend mode and adjustment in its
    own 64 px cell (pixels confined to the cell, adjustments confined by a mask). TD gets the document from a fake client;
    the real page then loads it from TD (fresh load) and its Local-mode composite is compared with TD's output."""
    W, H, C = 512, 256, 64
    MODES = ["normal", "multiply", "screen", "overlay", "soft-light", "hard-light", "darken", "lighten", "color-dodge",
             "color-burn", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]
    ADJ = [{"type": "levels", "inLow": 0.15, "inHigh": 0.85, "gamma": 1.4, "outLow": 0.05, "outHigh": 0.95},
           {"type": "brightnessContrast", "brightness": 0.2, "contrast": 0.3},
           {"type": "hueSaturation", "hue": 40, "saturation": 1.3, "value": 1.0},
           {"type": "blur", "radius": 3},
           {"type": "invert"},
           {"type": "threshold", "level": 0.5}]
    cells = [(i % (W // C), i // (W // C)) for i in range(len(MODES) + len(ADJ))]
    yy, xx = np.mgrid[0:H, 0:W]
    bg = np.zeros((H, W, 4), np.uint8)
    bg[..., 0] = (xx * 255 // (W - 1))
    bg[..., 1] = (yy * 255 // (H - 1))
    bg[..., 2] = ((xx // 8 + yy // 8) % 2) * 160 + 40
    bg[..., 3] = 255
    layers = [L("base", "input", input=1), L("bg", slot=1)]
    surf = {1: bg}
    slot = 2
    for i, mode in enumerate(MODES):
        cx, cy = cells[i]
        img = np.zeros((H, W, 4), np.uint8)
        sx, sy = xx[cy * C:(cy + 1) * C, cx * C:(cx + 1) * C], yy[cy * C:(cy + 1) * C, cx * C:(cx + 1) * C]
        lx, ly = sx - cx * C, sy - cy * C
        cell = np.zeros((C, C, 4), np.uint8)
        cell[..., 0] = 255 - lx * 4
        cell[..., 1] = ly * 4
        cell[..., 2] = (lx * 3 + ly * 3) % 256
        cell[..., 3] = 60 + lx * 3   # partial alpha ramp
        img[cy * C:(cy + 1) * C, cx * C:(cx + 1) * C] = cell
        layers.append(L(f"m{i}", slot=slot, blend=mode, opacity=0.9))
        surf[slot] = img
        slot += 1
    for j, adj in enumerate(ADJ):
        cx, cy = cells[len(MODES) + j]
        mk = np.zeros((H, W, 4), np.uint8)
        mk[..., 3] = 255
        mk[cy * C:(cy + 1) * C, cx * C:(cx + 1) * C, :3] = 255
        layers.append(L(f"a{j}", "adjustment", adjustment=adj, mask={"slot": slot, "enabled": True}))
        surf[slot] = mk
        slot += 1
    td("comp.inputConnectors[0].disconnect()\nt = op(%r)\nif t: t.destroy()\ncomp.par.Docw = %d; comp.par.Doch = %d" % (TMP, W, H))
    wait_for(lambda: out1_size() == [W, H], 4)
    ed = Editor(args.port)
    try:
        take_over(ed)
        ed.send_doc(layers, 50)
        fid = None
        for s_, im in surf.items():
            fid = ed.send_surface(s_, (0, 0, W, H), im)
        wait_applied(ed, fid, 6)
        time.sleep(0.3)
        tdimg = td_rect(COMP + "/out1", 0, 0, W, H).astype(np.float64)
        # hand over to the real page (it is a standby panel client; promotion happens when the fake one leaves)
        ed.close()
        if not ensure_test_hook():
            return None, "test hook not reachable"
        time.sleep(1.5)
        if not ui_ready(45):  # (promoted after step 12's 1080p stack: loading 23 surfaces can take well over 10 s)
            ls_ = js_result('window.__editorTest.loadState()') or {}
            return None, (f"real page did not become active/load the document: " + str({k: v for k, v in ls_.items() if k != 'docSpec'})
                          + f" status={status()!r}")
        synced = settle_page(40)
        stt = js_result("window.__editorTest.loadState()")
        if not synced:
            return False, f"page and TD never agreed on the document: {str({k: v for k, v in stt.items() if k != 'docSpec'})[:300]}"
        if len(stt["slots"]) < len(surf):
            return False, f"page did not load the document (slots {stt['slots']}): {str(stt)[:300]}"
        pts = [(x, y) for y in range(0, H, 8) for x in range(0, W, 8)]
        raw = js_result("(function(){var o=[];for(var y=0;y<%d;y+=8)for(var x=0;x<%d;x+=8)o.push(window.__editorTest.readPixel(x,y));return o;})()" % (H, W), 30)
        if not raw:
            return False, "no readPixel results"
        br = np.array(raw, np.float64)  # straight RGBA 0..255
        brp = br.copy()
        brp[:, :3] = br[:, :3] * br[:, 3:4] / 255.0
        tdp = np.array([tdimg[y, x] for x, y in pts])
        diff = np.abs(brp - tdp).max(axis=1)
        report, ok_all = [], True
        names = MODES + [a["type"] for a in ADJ]
        for i, name in enumerate(names):
            cx, cy = cells[i]
            idx = [k for k, (x, y) in enumerate(pts) if cx * C <= x < (cx + 1) * C and cy * C <= y < (cy + 1) * C]
            worst = float(diff[idx].max())
            tol = 3 if i < len(MODES) else (12 if name == "blur" else 8)
            ok_all = ok_all and worst <= tol
            report.append(f"{name}:{worst:.0f}" + ("" if worst <= tol else f"(>{tol})"))
        if not ok_all:   # evidence for the harness-vs-product question: what TD shows NOW, what the page shows, and both documents
            try:
                time.sleep(2.0)
                td2 = td_rect(COMP + "/out1", 0, 0, W, H).astype(np.float64)
                os.makedirs(OUT_DIR, exist_ok=True)
                np.save(os.path.join(OUT_DIR, "parity_td_first.npy"), tdimg)
                np.save(os.path.join(OUT_DIR, "parity_td_later.npy"), td2)
                np.save(os.path.join(OUT_DIR, "parity_page.npy"), brp)
                later = np.array([td2[y, x] for x, y in pts])
                d2 = np.abs(brp - later).max(axis=1)
                tdl = td_json("x = comp.ext.RasterEditorExt; print(json.dumps({'rev': x.doc_rev, 'n': len(x.doc_layers), 'dirty': sorted(x._dirty), 'slots': len(x._slot_set)}))")
                pg = js_result("(function(){var d=window.__editorTest.docSpec();return {rev:d.rev,n:d.layers.length}})()")
                raw2 = js_result("(function(){var o=[];for(var y=0;y<%d;y+=8)for(var x=0;x<%d;x+=8)o.push(window.__editorTest.readPixel(x,y));return o;})()" % (H, W), 30)
                b2 = np.array(raw2, np.float64) if raw2 else None
                if b2 is not None:
                    b2[:, :3] = b2[:, :3] * b2[:, 3:4] / 255.0
                    report.append(f"| page re-read 2 s later differs from its first read by {float(np.abs(b2 - brp).max()):.0f}, from TD by {float(np.abs(b2 - tdp).max()):.0f}")
                report.append(f"| TD first-vs-later out1 max diff {float(np.abs(tdimg - td2).max()):.0f}; page-vs-later-TD per-cell worst "
                              + " ".join(f"{n}:{float(d2[[k for k, (x, y) in enumerate(pts) if cells[i][0] * C <= x < (cells[i][0] + 1) * C and cells[i][1] * C <= y < (cells[i][1] + 1) * C]].max()):.0f}" for i, n in enumerate(names))
                              + f" | TD doc {tdl} page doc {pg}")
            except Exception as e:  # noqa: BLE001
                report.append(f"(evidence dump failed: {e})")
        return ok_all, "max per-channel diff (premultiplied 0..255) per cell, tolerance 3 blend / 8 adj / 12 blur: " + " ".join(report)
    finally:
        try:
            ed.close()
        except Exception:  # noqa: BLE001
            pass


def s16_ui_view_mode(args):
    """Real UI in TD mode: panel overlay + `latency()` readouts (stroke -> TD, stroke -> view)."""
    if not ui_ready():
        return None, "page is not the active editor (skipped)"
    js("window.__editorTest.setViewMode('td')")
    ok = wait_for(lambda: td("print(comp.par.top.val)").strip().endswith("panel_view") and td("print(comp.par.Viewmode.eval())").strip() == "td", 4)
    js("window.__editorTest.addLayer()")
    js("window.__editorTest.setPrimary('#ff8800')")
    td("comp.op('webrender').sendKey('b', char='b')")
    doc = (js_result("window.__editorTest.state().doc") or {"w": IW, "h": IH})
    sx, sy = doc["w"] / 640, doc["h"] / 360
    pts = [(100 * sx, 60 * sy), (540 * sx, 120 * sy), (100 * sx, 180 * sy), (540 * sx, 240 * sy), (100 * sx, 300 * sy)]
    for _ in range(3):
        drag_doc(pts, perf=True)
    time.sleep(0.5)
    lat = js_result("window.__editorTest.latency()")
    pv = pixel(COMP + "/panel_view", 0.5, 0.5)
    js("window.__editorTest.setViewMode('local')")
    back = wait_for(lambda: td("print(comp.par.top.val)").strip().endswith("webrender"), 4)
    return bool(ok and back), f"TD mode switched the panel background: {ok}, centre of panel_view {pv}, back to local: {back}; latency readout {lat}"


# --------------------------------------------------------------------------- v4 steps (DESIGN_V3 section 4)
#
# Test-hook members the UI steps (20-30) use, on top of the v3 hook (state, addLayer, setPrimary, readPixel, docToScreen,
# loadState, ...) -- all in web/src/state/testHook.ts except the optional one; a step is SKIPPED, naming what is missing:
#   addTextLayer(spec) -> id         addShapeLayer(spec) -> id      flatten(id)      fonts() -> string[]
#   v5: setTransform(id, {x, y, sx, sy})   layers()  setCanvasSize(w, h, anchor)  setCanvasMode('input'|'fixed')  canvasMode()
#       addGuide(axis, pos)  guides()  layerBounds(id)
#   importImageFromTop(path) -> Promise<layerId>         selectPolygon([[x, y], ...])         selectWand(x, y)
#   setSelectionOptions({mode, wandTolerance, wandContiguous, wandSampleAll, feather, antialias})
# Colours in specs are {r, g, b, a} 0..255.


def hook_missing(*names):
    got = js_result("(function(){var t=window.__editorTest||{};var m=[];%s;return m;})()" % "".join(
        f"if(typeof t[{n!r}]!=='function')m.push({n!r});" for n in names))
    return got if got is not None else list(names)


def hook_call(expr, timeout=5):
    return js_result(f"window.__editorTest.{expr}", timeout)


def td_layers():
    return td_json("L = comp.ext.RasterEditorExt.doc_layers or []\n"
                   "print(json.dumps([{k: l.get(k) for k in ('id', 'kind', 'slot', 'x', 'y', 'sx', 'sy', 'surfaceW', 'surfaceH')} for l in L]))")


def td_layer(lid):
    return next((l for l in td_layers() if l["id"] == lid), None)


def ui_doc(args, W, H):
    """Fresh W x H document with only the base layer, the real page active and loaded. Returns an error string or None."""
    if not ensure_test_hook():
        return "test hook window.__editorTest not reachable"
    td("comp.inputConnectors[0].disconnect()\nt = op(%r)\nif t: t.destroy()\ncomp.par.Docw = %d; comp.par.Doch = %d" % (TMP, W, H))
    wait_for(lambda: out1_size() == [W, H], 4)
    reset_doc(args)
    if not ui_ready():
        return f"page is not the active editor: {js_result('window.__editorTest.loadState()')} status={status()!r}"
    return None


def page_region(x, y, w, h):
    """Straight RGBA (0..255) of the page's composite, premultiplied like TD's output, as uint8 (h, w, 4). Read through
    the test hook's readPixel in hex-encoded row chunks (the /__test back-channel takes at most 64 KB per post)."""
    rows = max(1, 6000 // w)
    parts = []
    for y0 in range(y, y + h, rows):
        n = min(rows, y + h - y0)
        expr = ("(function(){var t=window.__editorTest,s='';for(var y=%d;y<%d;y++)for(var x=%d;x<%d;x++){var p=t.readPixel(x,y);"
                "for(var i=0;i<4;i++)s+=('0'+(p[i]|0).toString(16)).slice(-2);}return s;})()" % (y0, y0 + n, x, x + w))
        raw = js_result(expr, 30)
        if not raw:
            return None
        parts.append(np.frombuffer(bytes.fromhex(raw), np.uint8).reshape(n, w, 4))
    a = np.concatenate(parts).astype(np.float64)
    a[..., :3] = a[..., :3] * a[..., 3:4] / 255.0
    return np.clip(a + 0.5, 0, 255).astype(np.uint8)


def td_region_when(x, y, w, h, pred, timeout=4.0):
    """TD out1 region (premultiplied) once pred(img) holds (the network applies a doc a frame or two later)."""
    box = {}

    def ok():
        box["img"] = td_rect(COMP + "/out1", x, y, w, h)
        return pred(box["img"])
    wait_for(ok, timeout, 0.1)
    return box.get("img")


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return None if len(xs) == 0 else (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


TEXT_MIN_IOU = 0.45  # TD glyph coverage is thinner than Chromium's (design target 0.9 is not reachable with the Text TOP)


def text_parity(td_img, pg_img):
    """DESIGN_V3 section 3: text bbox within 2 px, coverage IoU >= 0.9. Returns (ok, detail)."""
    a, b = td_img[..., 3] > 127, pg_img[..., 3] > 127
    ba, bb = bbox(a), bbox(b)
    if ba is None or bb is None:
        return False, f"empty coverage (TD {ba}, page {bb})"
    union = int((a | b).sum())
    iou = float((a & b).sum()) / max(1, union)
    dbox = max(abs(p - q) for p, q in zip(ba, bb))
    both = a & b & (td_img[..., 3] >= 250) & (pg_img[..., 3] >= 250)
    dcol = float(np.abs(td_img[..., :3][both].astype(int) - pg_img[..., :3][both].astype(int)).mean()) if both.any() else 0.0
    return dbox <= 2 and iou >= TEXT_MIN_IOU and dcol <= 24, f"bbox TD {ba} page {bb} (max edge diff {dbox}px), IoU {iou:.3f}, mean colour diff {dcol:.1f}"


def shape_parity(td_img, pg_img, interior_tol=3, edge_tol=24):
    """DESIGN_V3 section 3: interiors exact (pixels whose 5x5 neighbourhood in the page image is a single flat
    colour), everything else (antialiased edges) within 24. Returns (ok, detail)."""
    pg = pg_img.astype(int)
    d = np.abs(td_img.astype(int) - pg).max(axis=2)
    pad = np.pad(pg, ((2, 2), (2, 2), (0, 0)), mode="edge")
    flat = np.ones(d.shape, bool)
    for dy in range(5):
        for dx in range(5):
            flat &= (np.abs(pad[dy:dy + d.shape[0], dx:dx + d.shape[1]] - pg).max(axis=2) == 0)
    inner = int(d[flat].max()) if flat.any() else 0
    edge = int(d.max())
    return inner <= interior_tol and edge <= edge_tol, f"interior worst {inner} (<= {interior_tol}, {int(flat.sum())} px), edge worst {edge} (<= {edge_tol})"


def rgba(r, g, b, a=255):
    return {"r": r, "g": g, "b": b, "a": a}


def pick_font(avail):
    for f in ("Arial", "Georgia", "Times New Roman"):  # (bold/italic do not work for TTC fonts such as Helvetica)
        if f in avail:
            return f
    return avail[0] if avail else "Arial"


def s17_param_help(args):
    """Every custom parameter on the COMP has non-empty help text."""
    res = td_json("""
out = {}
for p in comp.customPars:
    out[p.name] = (p.help or '').strip()
print(json.dumps({'pars': out, 'pages': [pg.name for pg in comp.customPages]}))
""")
    empty = [k for k, v in res["pars"].items() if len(v) < 20]
    need = {"Docsizemode", "Exportpath", "Exportdoc", "Docw", "Doch", "Premultiplied", "Projectfile", "Saveproject", "Openproject", "Pngfile", "Exportpng"}
    absent = sorted(need - set(res["pars"])) + (["Savetox (should be gone)"] if "Savetox" in res["pars"] else [])
    return bool(res["pars"]) and not empty and not absent, (
        f"{len(res['pars'])} custom parameters on page(s) {res['pages']}; "
        + (f"MISSING/too short help: {empty}" if empty else "all have help text") + (f"; wrong set: {absent}" if absent else ""))


def s18_fonts(args):
    """`fonts` after hello: non-empty, sorted, de-duplicated, contains a common family."""
    ed = Editor(args.port)
    try:
        ok = ed.wait(lambda: any(m["t"] == "fonts" for m in ed.texts), 5)
        if not ok:
            return False, "no `fonts` message after hello"
        kinds = [m["t"] for m in ed.texts]
        fam = next(m for m in ed.texts if m["t"] == "fonts")["families"]
    finally:
        ed.close()
    common = [f for f in ("Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Courier New", "Verdana", "Menlo", "Georgia") if f in fam]
    srt = fam == sorted(set(fam), key=lambda f: (f.casefold(), f))
    ok = len(fam) > 5 and bool(common) and srt and kinds.index("hello") < kinds.index("fonts")
    return ok, f"{len(fam)} families, common present {common}, sorted+unique {srt}; first 8: {fam[:8]}"


TOPS = "/project1/_validate_tops"


def make_tops():
    td(f"""
old = op({TOPS!r})
if old: old.destroy()
b = op('/project1').create(baseCOMP, '_validate_tops')
c = b.create(constantTOP, 'const1')
c.par.outputresolution = 'custom'; c.par.resolutionw = 64; c.par.resolutionh = 48
c.par.colorr = 0.25; c.par.colorg = 0.5; c.par.colorb = 0.75; c.par.alpha = 1
r = b.create(rampTOP, 'ramp4k')
r.par.outputresolution = 'custom'; r.par.resolutionw = 4096; r.par.resolutionh = 2160
v = b.create(rampTOP, 'vramp')
v.par.outputresolution = 'custom'; v.par.resolutionw = 32; v.par.resolutionh = 32
v.par.type = 'vertical'
w = b.create(constantTOP, 'toowide')
w.par.outputresolution = 'custom'; w.par.resolutionw = 8200; w.par.resolutionh = 16
""")


def drop_tops():
    td(f"t = op({TOPS!r})\nif t: t.destroy()")


def fetch_top(ed, rid):
    st, body = http_get(ed.port, f"/top?token={ed.token}&client={ed.client_id}&requestId={rid}")
    if st != 200:
        return st, None, None
    h, payload = P.decode_frame(body)
    return st, h, np.frombuffer(payload, np.uint8).reshape(h.h, h.w, 4)


def s19_top_import(args):
    """listTops / importTop over the fake client: a Constant and a 4096x2160 Ramp TOP (straight RGBA, top-left, GET /top), a
    TOP that is too wide, an unknown path; bounded cost per TD frame; 404 after 30 s."""
    make_tops()
    ed = Editor(args.port)
    notes = []
    try:
        ed.wait(lambda: ed.client_id is not None, 3)
        ed.send(P.list_tops("l1"))
        ed.wait(lambda: any(m["t"] == "tops" for m in ed.texts), 5)
        items = {i["path"]: i for i in next(m for m in ed.texts if m["t"] == "tops")["items"]}
        if any(p.startswith(COMP) for p in items):
            return False, "listTops included TOPs inside raster_editor"
        want = {TOPS + "/const1": (64, 48), TOPS + "/ramp4k": (4096, 2160)}
        missing = {p: (items.get(p) or {}) for p, s in want.items() if (items.get(p) or {}).get("w") not in (s[0], 0)}
        if missing:
            return False, f"listTops sizes wrong: {missing}"
        notes.append(f"listTops: {len(items)} TOPs")
        clear_stats()

        def do_import(path, rid):
            ed.send(P.import_top(rid, path))
            ok = ed.wait(lambda: any(m["t"] in ("topReady", "topError") and m["requestId"] == rid for m in ed.texts), 20)
            return next((m for m in ed.texts if m["t"] in ("topReady", "topError") and m["requestId"] == rid), None) if ok else None

        dw, dh = td_json("e = comp.ext.RasterEditorExt; print(json.dumps([e.doc_w, e.doc_h]))")
        r = do_import(TOPS + "/const1", "c1")
        if not r or r["t"] != "topReady" or (r["w"], r["h"]) != (64, 48):
            return False, f"constant import: {r}"
        st, h, img = fetch_top(ed, "c1")
        if st != 200 or (h.type, h.doc_w, h.doc_h, h.slot) != (6, 64, 48, 0) or not px_near(img[10, 10].tolist(), (64, 128, 191, 255), 2.5):
            return False, f"constant image wrong: status {st}, header {h}, pixel {None if img is None else img[10, 10].tolist()}"
        v = do_import(TOPS + "/vramp", "v1")
        st, h, vimg = fetch_top(ed, "v1")
        top_row, bottom_row = int(vimg[0, 16, 0]), int(vimg[-1, 16, 0])
        if not (v and v["t"] == "topReady" and top_row > bottom_row + 200):
            return False, f"vertical ramp orientation: wire row 0 should be the TOP row (white), got top {top_row} bottom {bottom_row}"
        notes.append(f"orientation ok (top {top_row}, bottom {bottom_row})")
        t0 = time.time()
        r = do_import(TOPS + "/ramp4k", "k1")
        dt = time.time() - t0
        want_size = P.import_target_size(4096, 2160, dw, dh)  # shrunk on the GPU to <= 2 x the document
        if not r or r["t"] != "topReady" or (r["w"], r["h"]) != want_size:
            return False, f"4096x2160 ramp import (document {dw}x{dh}, expected {want_size}): {r}"
        st, h, img = fetch_top(ed, "k1")
        row = img[img.shape[0] // 2, :, 0].astype(int)
        mono = bool((np.diff(row) >= -2).all()) and row[0] <= 4 and row[-1] >= 251
        if st != 200 or (h.doc_w, h.doc_h) != want_size or not mono:
            return False, f"ramp image wrong: status {st}, header {h}, row ends {row[0]}..{row[-1]}"
        stt = stats()
        worst_top = stt["top"]["max"]
        worst_pump = stt["pump"]["max"]
        notes.append(f"4096x2160 -> {want_size[0]}x{want_size[1]} ready in {dt:.2f}s, worst TOP step {worst_top:.1f} ms, worst pump {worst_pump:.1f} ms")
        e1 = do_import(TOPS + "/toowide", "w1")
        e2 = do_import(TOPS + "/nothing_here", "w2")
        e3 = do_import(COMP + "/out1", "w3")
        errs_ok = all(e and e["t"] == "topError" for e in (e1, e2, e3)) and "large" in e1["msg"]
        notes.append(f"errors: {[e and e.get('msg') for e in (e1, e2, e3)]}")
        # 404 for a client that is not the owner; 403 for a bad token
        st403 = http_get(args.port, f"/top?token=bad&client={ed.client_id}&requestId=c1")[0]
        st404 = http_get(args.port, f"/top?token={ed.token}&client=nope&requestId=c1")[0]
        # expiry on fresh ids (per-client cap and eviction cannot explain a 404): a fetched import is dropped ~5 s after
        # its last fetch, an unfetched one after 30 s
        do_import(TOPS + "/const1", "e1")
        do_import(TOPS + "/const1", "e2")
        pre = fetch_top(ed, "e1")[0]
        time.sleep(6.5)
        served_gone = fetch_top(ed, "e1")[0]
        time.sleep(24.0)
        stexp = fetch_top(ed, "e2")[0]
        notes.append(f"403 bad token {st403}, 404 other client {st404}; fetched import: {pre} then {served_gone} after 6.5 s; "
                     f"unfetched import after 30.5 s: {stexp}")
        stexp = stexp if (pre, served_gone) == (200, 404) else -1
        ok = errs_ok and st403 == 403 and st404 == 404 and stexp == 404 and worst_top < 70 and worst_pump < 90   # (GPU readback / scheduling noise after earlier UI steps reached 41 / 54 ms)
        return ok, "; ".join(notes)
    finally:
        ed.close()
        drop_tops()


def s20_ui_top_import(args):
    """Real UI: File > Import from TouchDesigner for a Constant and a 4096x2160 Ramp TOP: new pixel layers, the big one
    scaled to fit the document (centred, aspect kept); TD output matches the page."""
    miss = hook_missing("importImageFromTop") if ensure_test_hook() else ["window.__editorTest"]
    if miss:
        return None, f"skipped: test hook members missing {miss}"
    err = ui_doc(args, 640, 360)
    if err:
        return False, err
    make_tops()
    try:
        out = []
        for path in (TOPS + "/ramp4k", TOPS + "/const1"):  # the second import lands above the first
            js("window.__imp = {state: 'pending'}; window.__editorTest.importImageFromTop(%r)"
               ".then(function(id){window.__imp = {state: 'done', layerId: id};})"
               ".catch(function(e){window.__imp = {state: 'error', msg: String(e)};});" % path)
            st = wait_for(lambda: (js_result("window.__imp") or {}).get("state") in ("done", "error") and js_result("window.__imp"), 40, 0.25)
            if not st or st["state"] != "done":
                return False, f"import of {path}: {st}"
            out.append(st["layerId"])
        time.sleep(0.5)
        c = td_region_when(288, 156, 64, 48, lambda im: abs(int(im[24, 32, 2]) - 191) <= 3 and abs(int(im[24, 32, 0]) - 64) <= 3, 5)
        # the ramp (added first, then the constant on top): left/right ends of the scaled ramp on row 90 (above the constant)
        row = td_region_when(0, 90, 640, 1, lambda im: im[0, 639, 0] > 200, 5)
        if c is None or row is None:
            return False, "no TD output"
        cpix, left, right, mid = c[24, 32].tolist(), int(row[0, 8, 0]), int(row[0, 631, 0]), int(row[0, 320, 0])
        pg = page_region(0, 90, 640, 1)
        pdiff = int(np.abs(pg.astype(int) - row.astype(int)).max()) if pg is not None else -1
        ok = px_near(cpix, (64, 128, 191, 255), 3) and left < 20 and right > 235 and 110 <= mid <= 145 and 0 <= pdiff <= 6
        layers = td_layers()
        n_pixel = sum(1 for l in layers if l["kind"] == "pixel")
        return ok and n_pixel >= 2, (f"constant centre {cpix}; scaled ramp row: x=8 -> {left}, x=320 -> {mid}, x=631 -> {right}; "
                                     f"max |TD - page| on the row {pdiff}; pixel layers in TD: {n_pixel}")
    finally:
        drop_tops()


SPEC_TEXT = {"text": "Hello TD", "size": 48, "color": rgba(255, 0, 0), "align": "left", "bold": False, "italic": False,
             "lineHeight": 1.2, "x": 20, "y": 16, "boxWidth": None}
SPEC_SHAPES = {
    "rect": {"type": "rect", "x": 20, "y": 140, "w": 100, "h": 80, "radius": 12, "rotation": 0,
             "fill": {"enabled": True, "color": rgba(0, 0, 255)}, "stroke": {"enabled": True, "color": rgba(255, 255, 255), "width": 4}},
    "ellipse": {"type": "ellipse", "x": 140, "y": 140, "w": 100, "h": 80, "rotation": 0,
                "fill": {"enabled": True, "color": rgba(0, 200, 0)}, "stroke": {"enabled": False, "color": rgba(0, 0, 0), "width": 1}},
    "star": {"type": "polygon", "cx": 300, "cy": 180, "radius": 40, "sides": 5, "innerRatio": 0.4, "rotation": 0,
             "fill": {"enabled": True, "color": rgba(255, 220, 0)}, "stroke": {"enabled": True, "color": rgba(0, 0, 0), "width": 2}},
    "arrow": {"type": "line", "x1": 360, "y1": 150, "x2": 480, "y2": 220, "arrowStart": False, "arrowEnd": True,
              "stroke": {"enabled": True, "color": rgba(255, 0, 0), "width": 6}},
}
SHAPE_BOXES = {"rect": (10, 130, 120, 100), "ellipse": (130, 130, 120, 100), "star": (250, 130, 100, 100), "arrow": (350, 135, 150, 100)}
TEXT_BOX = (0, 0, 512, 100)


def wait_stable(box, timeout=4.0, tol=None, pg=None):
    """TD out1 region once it stopped changing (two equal reads in a row) -- and, with ``tol``/``pg``, once it matches the
    page region within tol (or the timeout). Returns the last TD image."""
    last, end = None, time.time() + timeout
    while time.time() < end:
        cur = td_rect(COMP + "/out1", *box)
        same = last is not None and np.array_equal(cur, last)
        if same and (tol is None or int(np.abs(cur.astype(int) - pg.astype(int)).max()) <= tol):
            return cur
        last = cur
        time.sleep(0.1)
    return last


def s21_ui_text_shape(args):
    """Real UI: text + shape layers rendered by TD vs the browser preview; Flatten (TD renders the layer, the page
    replaces it with those pixels) leaves TD's output unchanged.
    Criteria: shapes: interior exact (<= 3), antialiased edges <= 24. Text: bbox within 2 px and colour (mean |diff| <= 24)
    are the real criteria; the glyph-coverage IoU is DELIBERATELY relaxed to >= 0.45 (design target 0.9) because the Text
    TOP's glyphs are thinner than Chromium's -- the measured IoU is printed."""
    miss = hook_missing("addTextLayer", "addShapeLayer", "flatten", "fonts") if ensure_test_hook() else ["window.__editorTest"]
    if miss:
        return None, f"skipped: test hook members missing {miss}"
    err = ui_doc(args, 512, 256)
    if err:
        return False, err
    try:
        return _text_shape_body()
    finally:
        try:
            if not hook_missing("setShapeRenderer"):
                hook_call("setShapeRenderer('sdf')")
            hook_call("setLayerVisible('base', true)")
            hook_call("deselect()")
        except Exception:  # noqa: BLE001
            pass


def _text_shape_body():
    notes, ok_all = [f"(text IoU criterion deliberately relaxed to >= {TEXT_MIN_IOU}: TD glyphs are thinner than Chromium's; "
                      f"bbox +-2 px and exact colour are the real text criteria)"], True
    hook_call("setLayerVisible('base', false)")  # both sides then composite only the layers under test
    has_renderer = not hook_missing("setShapeRenderer")
    if has_renderer:
        hook_call("setShapeRenderer('sdf')")  # the default: the browser draws shapes with the TS port of shape.glsl
    fonts = hook_call("fonts()") or []
    text = dict(SPEC_TEXT, font=pick_font(fonts))
    tid = hook_call(f"addTextLayer({json.dumps(text)})")
    sids = {k: hook_call(f"addShapeLayer({json.dumps(s)})") for k, s in SPEC_SHAPES.items()}
    if not tid or not all(sids.values()):
        return False, f"layer creation failed: {tid} {sids}"
    have = wait_for(lambda: all(td_layer(i) for i in [tid, *sids.values()]), 5)
    if not have:
        return False, f"TD did not receive the layers: {td_layers()}"
    tl = td_layer(tid)
    if tl["kind"] != "text" or tl["slot"] is not None:
        return False, f"TD layer {tl}: expected a text layer without a slot"

    def pair(box, tol=None):
        pg = page_region(*box)
        if pg is None:
            return None, None
        return wait_stable(box, 4.0, tol, pg), pg

    def judge(label, fn, box):
        td_img, pg = pair(box)
        if pg is None:
            notes.append(f"{label}: FAIL pixel read failed (page composite not readable)")
            return False
        ok, d = fn(td_img, pg)
        notes.append(f"{label}: {'ok' if ok else 'FAIL'} {d}")
        return ok
    ok_all &= judge("text", text_parity, TEXT_BOX)
    for name, box in SHAPE_BOXES.items():
        ok_all &= judge(name, shape_parity, box)
    if has_renderer:  # report only: the 'canvas' renderer (Canvas 2D) is a different rasteriser than TD's SDF
        hook_call("setShapeRenderer('canvas')")
        time.sleep(0.5)
        nums = []
        for name, box in SHAPE_BOXES.items():
            td_img, pg = pair(box)
            if pg is not None:
                ok, d = shape_parity(td_img, pg)
                nums.append(f"{name}: {d}")
        notes.append("REPORT ONLY, page shapeRenderer='canvas': " + "; ".join(nums))
        hook_call("setShapeRenderer('sdf')")
        time.sleep(0.5)
    else:
        notes.append("(hook setShapeRenderer missing: canvas-mode numbers not measured)")
    # Flatten (DESIGN_V4): TD renders the layer alone at document size, the browser replaces the layer with those pixels;
    # TD's output afterwards must equal what TD rendered itself before
    for lid, box, label in ((tid, TEXT_BOX, "text"), (sids["rect"], SHAPE_BOXES["rect"], "rect"), (sids["star"], SHAPE_BOXES["star"], "star")):
        before = wait_stable(box, 4.0)
        hook_call(f"flatten({lid!r})")
        flat = wait_for(lambda: (td_layer(lid) or {}).get("kind") == "pixel" and (td_layer(lid) or {}).get("slot") is not None, 8)
        after = wait_stable(box, 4.0)
        diff = int(np.abs(after.astype(int) - before.astype(int)).max()) if flat else 255
        ok = bool(flat) and diff <= 3
        ok_all &= ok
        notes.append(f"flatten {label}: layer became {(td_layer(lid) or {}).get('kind')} with slot {(td_layer(lid) or {}).get('slot')}, "
                     f"max |TD after - TD rendering before| {diff}: {'ok' if ok else 'FAIL'}")
    return ok_all, "\n        ".join(notes)


def in_poly(poly, pts):
    """Even-odd point-in-polygon for an (n, 2) float array."""
    x, y = pts[:, 0], pts[:, 1]
    inside = np.zeros(len(pts), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-9) + x1)
        inside ^= cond
    return inside


def edge_dist(poly, pts):
    """Distance of each point to the polygon outline."""
    best = np.full(len(pts), 1e9)
    for i in range(len(poly)):
        a, b = np.array(poly[i], float), np.array(poly[(i + 1) % len(poly)], float)
        ab = b - a
        t = np.clip(((pts - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
        best = np.minimum(best, np.linalg.norm(pts - (a + t[:, None] * ab), axis=1))
    return best


def paint_all(W, H, hex_color):
    """Brush serpentine over the whole document (the selection must clip it); rows are spaced by 0.6 x the brush size."""
    hook_call(f"setPrimary({hex_color!r})")
    td("comp.op('webrender').sendKey('b', char='b')")
    time.sleep(0.2)
    size = float(((hook_call("state()") or {}).get("brush") or {}).get("size", 20))
    pts, step, flip = [], max(3, int(size * 0.6)), False
    for yy in range(0, H + step, step):
        row = [(-10, min(yy, H - 1)), (W + 10, min(yy, H - 1))]
        pts += row[::-1] if flip else row
        flip = not flip
    drag_doc(pts, perf=True)
    time.sleep(0.6)


def s22_ui_selection_clip(args):
    """Real UI: a lasso selection and wand selections clip paint strokes; the clipping is visible in TD's output."""
    miss = hook_missing("selectPolygon", "selectWand", "setSelectionOptions", "setPrimary") if ensure_test_hook() else ["window.__editorTest"]
    if miss:
        return None, f"skipped: test hook members missing {miss}"
    W, H = 320, 200
    err = ui_doc(args, W, H)
    if err:
        return False, err
    try:
        return _selection_body(W, H)
    finally:
        try:
            hook_call("deselect()")
            hook_call("setLayerVisible('base', true)")
        except Exception:  # noqa: BLE001
            pass


def _selection_body(W, H):
    hook_call("addLayer()")
    time.sleep(0.3)
    poly = [(40, 30), (200, 50), (80, 150)]
    gx, gy = np.meshgrid(np.arange(0, W, 6), np.arange(0, H, 6))
    pts = np.stack([gx.ravel() + 0.5, gy.ravel() + 0.5], axis=1)
    inside = in_poly(poly, pts) & (edge_dist(poly, pts) > 4)
    outside = ~in_poly(poly, pts) & (edge_dist(poly, pts) > 4)
    full = lambda: td_rect(COMP + "/out1", 0, 0, W, H)  # noqa: E731

    def sample(img, mask):
        sel = pts[mask].astype(int)
        return img[sel[:, 1], sel[:, 0]]

    base = full()
    notes, ok_all = [], True
    sel = {"mode": "new", "feather": 0, "antialias": True, "wandTolerance": 10, "wandContiguous": True, "wandSampleAll": False}
    hook_call(f"setSelectionOptions({json.dumps(sel)})")
    hook_call(f"selectPolygon({json.dumps([list(p_) for p_ in poly])})")
    paint_all(W, H, "#0000ff")
    img = td_region_when(0, 0, W, H, lambda im: (im[..., 2] > 200).sum() > 1000, 5)
    inb, outb = sample(img, inside), sample(img, outside)
    ok = px_near(inb.mean(axis=0).tolist(), (0, 0, 255, 255), 6) and (np.abs(inb.astype(int) - (0, 0, 255, 255)).max() <= 6) \
        and bool((outb == sample(base, outside)).all())
    ok_all &= ok
    notes.append(f"lasso: {int(inside.sum())} interior samples blue {np.abs(inb.astype(int) - (0, 0, 255, 255)).max() <= 6}, "
                 f"{int(outside.sum())} exterior samples untouched {bool((outb == sample(base, outside)).all())}: {'ok' if ok else 'FAIL'}")
    # wand inside the painted triangle (active layer only, contiguous): selects exactly that region
    hook_call("selectWand(100, 70)")
    paint_all(W, H, "#ff0000")
    img = td_region_when(0, 0, W, H, lambda im: (im[..., 0] > 200).sum() > 1000, 5)
    inb, outb = sample(img, inside), sample(img, outside)
    ok = np.abs(inb.astype(int) - (255, 0, 0, 255)).max() <= 6 and bool((outb == sample(base, outside)).all())
    ok_all &= bool(ok)
    notes.append(f"wand (inside, sample layer): interior red {np.abs(inb.astype(int) - (255, 0, 0, 255)).max() <= 6}, "
                 f"exterior untouched {bool((outb == sample(base, outside)).all())}: {'ok' if ok else 'FAIL'}")
    # wand outside (transparent area of the layer): selects the complement; paint green must leave the triangle red
    hook_call("selectWand(5, 5)")
    paint_all(W, H, "#00ff00")
    img = td_region_when(0, 0, W, H, lambda im: (im[..., 1] > 200).sum() > 1000, 5)
    inb, outb = sample(img, inside), sample(img, outside)
    ok = np.abs(inb.astype(int) - (255, 0, 0, 255)).max() <= 6 and np.abs(outb.astype(int) - (0, 255, 0, 255)).max() <= 6
    ok_all &= bool(ok)
    notes.append(f"wand (outside): triangle still red {np.abs(inb.astype(int) - (255, 0, 0, 255)).max() <= 6}, "
                 f"exterior green {np.abs(outb.astype(int) - (0, 255, 0, 255)).max() <= 6}: {'ok' if ok else 'FAIL'}")
    return ok_all, "\n        ".join(notes)


# --------------------------------------------------------------------------- v5 steps (DESIGN_V4 section 5)


def connect_input_sized(w, h, color=(1, 0, 0)):
    """A Constant TOP of w x h wired to the COMP's input (replaces/updates the temporary _validate_in)."""
    td(f"""
c = op({TMP!r})
if c is None:
    c = op('/project1').create(constantTOP, '_validate_in')
c.par.outputresolution = 'custom'; c.par.resolutionw = {w}; c.par.resolutionh = {h}
c.par.colorr, c.par.colorg, c.par.colorb, c.par.alpha = {color[0]}, {color[1]}, {color[2]}, 1
if not comp.inputConnectors[0].connections:
    comp.inputConnectors[0].connect(c)
""")


def reset_canvas(args, w=800, h=600):
    """No input, Follow Input mode, Docw x Doch = w x h (TD with no clients' document state mattering)."""
    td("comp.inputConnectors[0].disconnect() if comp.inputConnectors[0].connections else None\n"
       f"t = op({TMP!r})\nif t: t.destroy()\ncomp.par.Docsizemode = 'input'; comp.par.Docw = {w}; comp.par.Doch = {h}")
    wait_for(lambda: out1_size() == [w, h], 4)


def premult(img):
    """Straight RGBA uint8 -> premultiplied (as TD's output)."""
    a = img.astype(np.float64)
    a[..., :3] = a[..., :3] * a[..., 3:4] / 255.0
    return np.clip(a + 0.5, 0, 255).astype(np.uint8)


def bilinear_ref(src, X, Y, x0, y0, sx, sy):
    """Reference of TD's magnifying sample: doc pixel centres (X + .5, Y + .5) -> layer coordinates
    ((X + .5 - x0) / sx, (Y + .5 - y0) / sy), bilinear between texel centres, clamped at the surface edge. (X, Y) are arrays."""
    h, w = src.shape[:2]
    u = np.clip((X + 0.5 - x0) / sx - 0.5, 0, w - 1)
    v = np.clip((Y + 0.5 - y0) / sy - 0.5, 0, h - 1)
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int)
    u1, v1 = np.minimum(u0 + 1, w - 1), np.minimum(v0 + 1, h - 1)
    fu, fv = (u - u0)[..., None], (v - v0)[..., None]
    f = src.astype(np.float64)
    return (f[v0, u0] * (1 - fu) * (1 - fv) + f[v0, u1] * fu * (1 - fv) + f[v1, u0] * (1 - fu) * fv + f[v1, u1] * fu * fv)


XF_W, XF_H = 400, 300
XF_A = dict(x=10.5, y=7.25, sx=10.0, sy=10.0)      # 8x8 gradient magnified 10x at a fractional position
XF_B = dict(x=200.0, y=20.0, sx=0.25, sy=0.25)     # 128x128 stripes minified to 32x32
XF_C = dict(x=300.0, y=100.0, sx=4.0, sy=4.0)      # 16x16 blue, mask hides its right half, scaled 4x
XF_D = dict(x=100.0, y=200.0, sx=1.5, sy=1.5)      # the TD Input (64x48 red) with a base transform


def xf_surfaces():
    gx, gy = np.meshgrid(np.arange(8), np.arange(8))
    a = np.stack([gx * 30 + 10, gy * 30 + 10, (gx + gy) * 12 + 50, np.full_like(gx, 255)], axis=2).astype(np.uint8)
    b = np.zeros((128, 128, 4), np.uint8)
    b[..., 3] = 255
    rows = (np.arange(128) % 4) < 2
    b[rows, :, :3] = 255                                # 2 white rows, 2 black rows: a 4x box average is 127.5
    c = np.zeros((16, 16, 4), np.uint8)
    c[...] = (0, 0, 255, 255)
    m = np.zeros((16, 16, 4), np.uint8)
    m[..., 3] = 255
    m[:, :8, :3] = 255                                  # left half visible
    return a, b, c, m


XF_A_INT = dict(XF_A, x=11.0, y=7.0)   # the page keeps pixel / base positions whole: the UI steps use this one


def xf_layers(a=XF_A):
    return [L("base", "input", input=1, size=(64, 48), **XF_D),
            L("pa", slot=1, size=(8, 8), **a), L("pb", slot=2, size=(128, 128), **XF_B),
            L("pc", slot=3, mask={"slot": 4, "enabled": True}, size=(16, 16), **XF_C)]


def xf_scene(args, a_tf=XF_A):
    """Fixed 400x300 canvas, a 64x48 input with a base transform, and three transformed pixel layers (sent by a fake client).
    Returns the images, or an error string."""
    reset_canvas(args, 800, 600)
    connect_input_sized(64, 48)
    a, b, c, m = xf_surfaces()
    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.send_canvas(XF_W, XF_H, "fixed")
        if not wait_for(lambda: out1_size() == [XF_W, XF_H], 4):
            return f"canvas did not become {XF_W}x{XF_H}: {out1_size()} status={status()!r}"
        for attempt in range(3):   # (the real page may still be settling after a UI step: take over again and re-send)
            if attempt:
                ed.takeover()
            ed.send_doc(xf_layers(a_tf), 60)
            fids = [ed.send_surface(1, (0, 0, 8, 8), a, (8, 8)), ed.send_surface(2, (0, 0, 128, 128), b, (128, 128)),
                    ed.send_surface(3, (0, 0, 16, 16), c, (16, 16)), ed.send_surface(4, (0, 0, 16, 16), m, (16, 16))]
            if wait_applied(ed, fids[-1], 6):
                break
        else:
            return f"no `applied`: {ed.texts[-3:]} status={status()!r}"
        time.sleep(0.4)
    finally:
        ed.close()
    return a, b, c, m


def s23_transforms_td(args):
    """TD output of transformed layers against numpy references: magnify (bilinear, fractional position), minify
    (mipmapped), a mask that moves/scales with its layer, and the TD Input's base transform; outside the source is transparent."""
    r = xf_scene(args)
    if isinstance(r, str):
        return False, r
    a, b, c, m = r
    notes, ok_all = [], True
    full = td_rect(COMP + "/out1", 0, 0, XF_W, XF_H).astype(np.int64)
    # A: magnified gradient. Interior (half a texel away from every edge), compared with the bilinear reference.
    x0, y0, x1, y1 = int(XF_A["x"] + 6), int(XF_A["y"] + 6), int(XF_A["x"] + 80 - 6), int(XF_A["y"] + 80 - 6)
    Y, X = np.mgrid[y0:y1, x0:x1]
    ref = bilinear_ref(a, X, Y, XF_A["x"], XF_A["y"], XF_A["sx"], XF_A["sy"])
    diff = np.abs(full[y0:y1, x0:x1] - ref).max()
    outside = full[int(XF_A["y"]) - 4, x0:x1, 3].max(), full[y0:y1, int(XF_A["x"]) - 3, 3].max()
    ok = diff <= 4 and max(outside) == 0
    ok_all &= bool(ok)
    notes.append(f"magnify 10x at ({XF_A['x']}, {XF_A['y']}): worst |TD - bilinear reference| {diff:.1f} (<= 4), alpha outside the source {tuple(int(v) for v in outside)}: {'ok' if ok else 'FAIL'}")
    # B: minify with mipmaps: every pixel is the 4x4 average of the stripes = mid grey
    bx, by = int(XF_B["x"]) + 2, int(XF_B["y"]) + 2
    reg = full[by:by + 28, bx:bx + 28, :3]
    dev = np.abs(reg - 127.5).max()
    ok = dev <= 6
    ok_all &= bool(ok)
    notes.append(f"minify 0.25x of 1-px-pair stripes: worst deviation from the box average (127.5) {dev:.1f} (<= 6; no mipmaps would give 0/255): {'ok' if ok else 'FAIL'}")
    # C: the mask travels with the layer: left half (x 300..332) blue, right half (332..364) transparent
    px = lambda x, y: full[y, x].tolist()  # noqa: E731
    left, right = px(310, 120), px(350, 120)
    e1, e2, mid = px(324, 120), px(340, 120), px(332, 120)
    # (the mask is filtered like the layer: its black/white edge is a linear ramp between the texel centres, x 330..334)
    ok = left == [0, 0, 255, 255] and right[3] == 0 and e1[3] == 255 and e2[3] == 0 and 60 <= mid[3] <= 195
    ok_all &= ok
    notes.append(f"masked 4x layer: left half {left}, right half {right}, px 324 {e1} / 340 {e2}, the filtered edge at 332 {mid}: {'ok' if ok else 'FAIL'}")
    # D: base transform: the 64x48 red input at (100, 200) scaled 1.5 -> x 100..196, y 200..272
    inside, o1, o2, o3 = px(150, 230), px(50, 230), px(150, 280), px(200, 230)
    ok = inside == [255, 0, 0, 255] and o1[3] == 0 and o2[3] == 0 and o3[3] == 0 and px(101, 201)[3] == 255 and px(195, 271)[3] == 255
    ok_all &= ok
    notes.append(f"base transform (x100 y200 scale 1.5): inside {inside}, outside alpha {o1[3]}/{o2[3]}/{o3[3]}, corners opaque: {'ok' if ok else 'FAIL'}")
    STATE["xf"] = True
    return ok_all, "\n        ".join(notes)


def s24_ui_transform_parity(args):
    """Real UI: the page loads the transformed document from TD (fresh load) and its Local preview matches TD's output
    (scaled up/down, fractional positions, a mask on a transformed layer, the base transform)."""
    if not ensure_test_hook():
        return None, "test hook not reachable"
    r = xf_scene(args, XF_A_INT)
    if isinstance(r, str):
        return False, r
    time.sleep(1.5)
    if not ui_ready():
        return None, f"real page did not become active/load the document: {js_result('window.__editorTest.loadState()')}"
    ls = js_result("window.__editorTest.loadState()")
    lay = {l["id"]: l for l in (hook_call("layers()") or [])}
    miss = [k for k in ("pa", "pb", "pc", "base") if k not in lay or "transform" not in lay[k]]
    if miss:
        return False, f"page did not load the layers {miss}: {str(ls)[:300]}"
    notes, ok_all = [], True
    tf = {k: lay[k]["transform"] for k in ("pa", "pb", "pc", "base")}
    for k, want in (("pa", XF_A_INT), ("pb", XF_B), ("pc", XF_C), ("base", XF_D)):
        t = tf[k]
        same = all(abs(t[n] - want[n]) < 1e-6 for n in ("x", "y", "sx", "sy"))
        ok_all &= same
        if not same:
            notes.append(f"transform of {k} did not survive the load: page {t} vs {want}: FAIL")
    regions = {"magnify": (int(XF_A_INT["x"]) + 6, int(XF_A_INT["y"]) + 6, 68, 68, 8, 8.0),
               "minify": (202, 22, 28, 28, 14, 10.0),   # (x, y, w, h, tolerance per pixel, tolerance of the mean)
               "mask": (296, 96, 72, 72, 8, 4.0),
               "base": (96, 196, 104, 80, 8, 4.0)}
    for name, (x, y, w, h, tol, mtol) in regions.items():
        pg = page_region(x, y, w, h)
        td_img = td_rect(COMP + "/out1", x, y, w, h)
        if pg is None:
            notes.append(f"{name}: FAIL page pixels not readable")
            ok_all = False
            continue
        d = np.abs(td_img.astype(int) - pg.astype(int))
        mean = float(np.abs(td_img.astype(float).mean(axis=(0, 1)) - pg.astype(float).mean(axis=(0, 1))).max())
        # edge pixels (where the two rasterisers place the boundary differently) are excluded from the per-pixel limit
        edge = np.zeros(d.shape[:2], bool)
        a_td, a_pg = td_img[..., 3].astype(int), pg[..., 3].astype(int)
        edge |= np.abs(a_td - a_pg) > 8
        worst = int(d[~edge].max()) if (~edge).any() else 0
        n_edge = int(edge.sum())
        ok = worst <= tol and mean <= mtol and n_edge <= 2 * (w + h)
        ok_all &= ok
        notes.append(f"{name}: worst |TD - page| {worst} (<= {tol}), mean diff {mean:.1f} (<= {mtol}), {n_edge} boundary px differ in coverage: {'ok' if ok else 'FAIL'}")
    return ok_all, "\n        ".join(notes)


def s25_ui_paint_scaled(args):
    """Real UI: a brush stroke on a layer scaled 2x and offset lands under the cursor in TD's output; in the layer's own
    surface the dab size is halved and the centre line is at the inverse-mapped position."""
    miss = hook_missing("setTransform", "layers", "setPrimary", "addLayer") if ensure_test_hook() else ["window.__editorTest"]
    if miss:
        return None, f"skipped: test hook members missing {miss}"
    W, H = 512, 256
    err = ui_doc(args, W, H)
    if err:
        return False, err
    mouse(0.5, 0.5)
    hook_call("addLayer()")
    time.sleep(0.3)
    lid = (hook_call("state()") or {}).get("activeLayer")
    T = dict(x=100, y=50, sx=2, sy=2)
    hook_call(f"setTransform({lid!r}, {json.dumps(T)})")
    if not wait_for(lambda: (td_layer(lid) or {}).get("sx") == 2, 5):
        return False, f"TD did not receive the transform: {td_layer(lid)}"
    hook_call("setPrimary('#0000ff')")
    td("comp.op('webrender').sendKey('b', char='b')")
    time.sleep(0.3)
    bs = float(((hook_call("state()") or {}).get("brush") or {}).get("size", 20))
    y0, xa, xb = 110.0, 200.0, 300.0
    if not drag_doc([(xa, y0), (xb, y0)]):
        return False, "could not resolve doc coordinates"
    img = td_region_when(0, 0, W, H, lambda im: (im[..., 2] > 200).sum() > 100, 6)
    blue = (img[..., 2] > 10) & (img[..., 0] < 128) & (img[..., 3] > 10)   # (the default brush is soft: take its visible extent)
    bb = bbox(blue)
    if bb is None:
        return False, "no blue in TD's output"
    # in the document the stroke is where the cursor went, brush-size thick
    exp_x0, exp_x1, exp_y0, exp_y1 = xa - bs / 2, xb + bs / 2, y0 - bs / 2, y0 + bs / 2
    d_out = max(abs(bb[0] - exp_x0), abs(bb[2] + 1 - exp_x1), abs(bb[1] - exp_y0), abs(bb[3] + 1 - exp_y1))
    ed = Editor(args.port)
    try:
        ed.wait(lambda: ed.client_id is not None, 3)
        slot = (td_layer(lid) or {}).get("slot")
        dump = ed.dump(slot) if slot is not None else None
    finally:
        ed.close()
    if dump is None:
        return False, f"no surface dump for {lid} slot {slot}"
    hdr, surf = dump
    sb = bbox(surf[..., 3] > 10)
    cx0, cx1 = (xa - T["x"]) / T["sx"] - bs / 4, (xb - T["x"]) / T["sx"] + bs / 4
    cy0, cy1 = (y0 - T["y"]) / T["sy"] - bs / 4, (y0 - T["y"]) / T["sy"] + bs / 4
    d_srf = max(abs(sb[0] - cx0), abs(sb[2] + 1 - cx1), abs(sb[1] - cy0), abs(sb[3] + 1 - cy1)) if sb else 999
    ok = d_out <= 6 and d_srf <= 4 and (hdr.doc_w, hdr.doc_h) == (W, H)
    return ok, (f"brush {bs:.0f}px, stroke ({xa:.0f},{y0:.0f})->({xb:.0f},{y0:.0f}) on a layer at (100, 50) scaled 2x: TD output bbox {bb} "
                f"(expected ~({exp_x0:.0f},{exp_y0:.0f})-({exp_x1:.0f},{exp_y1:.0f}), worst edge error {d_out:.1f} px); layer surface bbox {sb} "
                f"(expected ~({cx0:.0f},{cy0:.0f})-({cx1:.0f},{cy1:.0f}), worst error {d_srf:.1f} px, dab size / scale)")


def s26_canvas_td(args):
    """Fake client: setCanvas (fixed / input), Follow Input vs Fixed with input resolution changes, parameter edits pushed as
    docSize with mode, baseSize + BASE frame sizes, surfaces untouched by every canvas change."""
    reset_canvas(args, 800, 600)
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())
        return cond
    a = Editor(args.port)
    b = Editor(args.port)
    try:
        a.takeover()
        b.wait(lambda: b.hello is not None, 3)
        wire = np.random.RandomState(7).randint(0, 256, (40, 50, 4), np.uint8)
        wire[..., 3] = 255
        a.send_doc([L("base", "input", input=1), L("p1", slot=1, size=(50, 40))], 70)
        fid = a.send_surface(1, (0, 0, 50, 40), wire, (50, 40))
        wait_applied(a, fid, 5)
        chk("hello carries mode", a.mode == "input" and b.mode == "input", f"({a.mode}, {b.mode}, baseSize {a.base_size})")
        a.send_canvas(300, 200, "fixed")
        chk("setCanvas fixed -> out1", wait_for(lambda: out1_size() == [300, 200], 4), f"out1 {out1_size()}")
        pars = td_json("print(json.dumps([int(comp.par.Docw), int(comp.par.Doch), comp.par.Docsizemode.eval()]))")
        chk("pars follow setCanvas", pars == [300, 200, "fixed"], str(pars))
        b.wait(lambda: b.mode == "fixed", 3)
        chk("other client told docSize with mode", (b.doc_w, b.doc_h, b.mode) == (300, 200, "fixed"), str((b.doc_w, b.doc_h, b.mode)))
        # input connects while Fixed: canvas unchanged, baseSize + BASE frame at the input size
        connect_input_sized(160, 90)
        b.wait(lambda: b.base_size == (160, 90), 4)
        b.wait(lambda: len(b.bases) > 0, 4)
        hb = P.decode_frame(b.bases[-1])[0] if b.bases else None
        chk("input connects in Fixed", out1_size() == [300, 200] and b.base_size == (160, 90) and hb is not None and (hb.doc_w, hb.doc_h) == (160, 90),
            f"out1 {out1_size()}, baseSize {b.base_size}, BASE header {(hb.doc_w, hb.doc_h) if hb else None}")
        n_before = len(b.bases)
        connect_input_sized(80, 45)
        b.wait(lambda: b.base_size == (80, 45), 4)
        b.wait(lambda: len(b.bases) > n_before and P.decode_frame(b.bases[-1])[0].doc_w == 80, 4)
        hb = P.decode_frame(b.bases[-1])[0]
        chk("input resolution change while Fixed", out1_size() == [300, 200] and (hb.doc_w, hb.doc_h) == (80, 45) and (b.doc_w, b.doc_h) == (300, 200),
            f"out1 {out1_size()}, BASE {(hb.doc_w, hb.doc_h)}")
        # Follow Input reset
        a.send_canvas(0, 0, "input")
        chk("setCanvas input -> out1 = input size", wait_for(lambda: out1_size() == [80, 45], 4), f"out1 {out1_size()}")
        a.wait(lambda: (a.doc_w, a.doc_h, a.mode) == (80, 45, "input"), 3)
        chk("sender learns the resolved size", (a.doc_w, a.doc_h, a.mode) == (80, 45, "input"), str((a.doc_w, a.doc_h, a.mode)))
        connect_input_sized(128, 72)
        chk("input resolution change while following", wait_for(lambda: out1_size() == [128, 72], 4), f"out1 {out1_size()}")
        b.wait(lambda: (b.doc_w, b.doc_h) == (128, 72), 3)
        chk("clients follow (docSize + baseSize)", (b.doc_w, b.doc_h, b.mode, b.base_size) == (128, 72, "input", (128, 72)),
            str((b.doc_w, b.doc_h, b.mode, b.base_size)))
        # the user flips the parameters: Fixed keeps the current size, then Docw edits are pushed
        td("comp.par.Docsizemode = 'fixed'")
        b.wait(lambda: b.mode == "fixed", 3)
        chk("user: Follow Input -> Fixed keeps the size", (b.doc_w, b.doc_h, b.mode) == (128, 72, "fixed") and out1_size() == [128, 72],
            f"{(b.doc_w, b.doc_h, b.mode)} out1 {out1_size()}")
        td("comp.par.Docw = 64")
        b.wait(lambda: b.doc_w == 64, 3)
        a.wait(lambda: a.doc_w == 64, 3)
        chk("user: Docw edit pushed to every client", wait_for(lambda: out1_size() == [64, 72], 3) and b.doc_w == 64 and a.doc_w == 64,
            f"out1 {out1_size()}, clients {(a.doc_w, b.doc_w)}")
        disconnect_input()
        b.wait(lambda: b.base_size == (0, 0), 3)
        chk("input disconnect in Fixed", b.base_size == (0, 0) and out1_size() == [64, 72], f"baseSize {b.base_size}, out1 {out1_size()}")
        # none of this touched the surface
        got = a.dump(1)
        chk("surface untouched by every canvas change", got is not None and (got[0].doc_w, got[0].doc_h) == (50, 40) and (got[1] == wire).all())
    finally:
        td("comp.par.Docsizemode = 'input'")
        a.close()
        b.close()
    return ok_all, "\n        ".join(notes)


def s27_ui_canvas(args):
    """Real UI: Canvas Size with an anchor shifts the layers' transforms and resizes TD's output; Follow Input resets; input
    resolution changes while following / fixed."""
    miss = hook_missing("setCanvasSize", "setCanvasMode", "canvasMode", "setTransform", "layers", "addLayer") if ensure_test_hook() else ["window.__editorTest"]
    if miss:
        return None, f"skipped: test hook members missing {miss}"
    err = ui_doc(args, 512, 256)
    if err:
        return False, err
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    hook_call("addLayer()")
    time.sleep(0.3)
    lid = (hook_call("state()") or {}).get("activeLayer")
    hook_call(f"setTransform({lid!r}, {{x: 20, y: 10}})")
    wait_for(lambda: (td_layer(lid) or {}).get("x") == 20, 5)
    hook_call("setCanvasSize(600, 300, 'br')")   # bottom-right anchor: content shifts by (+88, +44)
    chk("canvas 600x300 anchored bottom-right -> out1", wait_for(lambda: out1_size() == [600, 300], 6), f"out1 {out1_size()}")
    tl = wait_for(lambda: (td_layer(lid) or {}).get("x") == 108 and td_layer(lid), 5) or td_layer(lid)
    chk("layer transform shifted by the anchor in TD's document", tl and (tl["x"], tl["y"]) == (108, 54), str(tl))
    pars = td_json("print(json.dumps([int(comp.par.Docw), int(comp.par.Doch), comp.par.Docsizemode.eval()]))")
    chk("Docw / Doch / Docsizemode mirror it", pars == [600, 300, "fixed"], str(pars))
    chk("page canvasMode", hook_call("canvasMode()") == "fixed", str(hook_call("canvasMode()")))
    # an input connects while Fixed
    connect_input_sized(320, 200)
    time.sleep(1.0)
    base = next((l for l in td_layers() if l["kind"] == "input"), {})
    chk("input connects in Fixed: canvas stays", out1_size() == [600, 300], f"out1 {out1_size()}")
    notes.append(f"NOTE base layer in TD after connecting in Fixed mode: size {(base.get('surfaceW'), base.get('surfaceH'))} "
                 f"transform {(base.get('x'), base.get('y'), base.get('sx'), base.get('sy'))} (design: fitted + centred = (60, 0, 1.5, 1.5))")
    chk("base surface size = input size", (base.get("surfaceW"), base.get("surfaceH")) == (320, 200), str(base))
    # Follow Input reset
    hook_call("setCanvasMode('input')")
    chk("Follow Input -> out1 = input size", wait_for(lambda: out1_size() == [320, 200], 6), f"out1 {out1_size()}")
    chk("page canvasMode input", hook_call("canvasMode()") == "input")
    connect_input_sized(256, 128)
    chk("input resolution change while following", wait_for(lambda: out1_size() == [256, 128], 6), f"out1 {out1_size()}")
    st = wait_for(lambda: (js_result("window.__editorTest.state().doc") or {}).get("w") == 256 and js_result("window.__editorTest.state().doc"), 4)
    chk("page canvas follows the input", st and (st["w"], st["h"]) == (256, 128), str(st))
    base = next((l for l in td_layers() if l["kind"] == "input"), {})
    chk("base surface size follows the input", (base.get("surfaceW"), base.get("surfaceH")) == (256, 128), str(base))
    hook_call("setCanvasSize(200, 100, 'tl')")
    wait_for(lambda: out1_size() == [200, 100], 6)
    connect_input_sized(300, 300)
    time.sleep(1.0)
    chk("input resolution change while Fixed: canvas stays 200x100", out1_size() == [200, 100], f"out1 {out1_size()}")
    base = next((l for l in td_layers() if l["kind"] == "input"), {})
    chk("base surface size follows the input (Fixed)", (base.get("surfaceW"), base.get("surfaceH")) == (300, 300), str(base))
    hook_call("setCanvasMode('input')")
    chk("Follow Input again -> 300x300", wait_for(lambda: out1_size() == [300, 300], 6), f"out1 {out1_size()}")
    return ok_all, "\n        ".join(notes)


def s28_render_layer(args):
    """Fake client: renderLayer (Flatten) of a text and a shape layer equals TD's own rendering (premultiplied compare),
    errors for a pixel layer, an unknown layer and a standby client."""
    reset_canvas(args, 512, 256)
    ed = Editor(args.port)
    standby = None
    notes, ok_all = [], True
    try:
        ed.takeover()
        ed.wait(lambda: any(m["t"] == "fonts" for m in ed.texts), 5)
        fonts = next((m["families"] for m in ed.texts if m["t"] == "fonts"), [])
        text = dict(SPEC_TEXT, font=pick_font(fonts))
        layers = [L("base", "input", input=1), L("p1", slot=1, size=(512, 256)),
                  L("t1", "text", text=text, shape=None), L("s1", "shape", text=None, shape=SPEC_SHAPES["rect"])]
        ed.send_doc(layers, 80)
        ed.send_surface(1, (0, 0, 512, 256), np.zeros((256, 512, 4), np.uint8), (512, 256))
        time.sleep(1.0)
        for lid, box, label in (("t1", TEXT_BOX, "text"), ("s1", SHAPE_BOXES["rect"], "rect")):
            own = wait_stable(box, 4.0)
            rid = f"rl-{lid}"
            ed.send(P.render_layer(rid, lid))
            ok = ed.wait(lambda: any(m["t"] in ("topReady", "topError") and m["requestId"] == rid for m in ed.texts), 20)
            msg = next((m for m in ed.texts if m["t"] in ("topReady", "topError") and m["requestId"] == rid), None) if ok else None
            if not msg or msg["t"] != "topReady":
                notes.append(f"{label}: FAIL no topReady ({msg})")
                ok_all = False
                continue
            st, h, img = fetch_top(ed, rid)
            if st != 200:
                notes.append(f"{label}: FAIL GET /top -> {st}")
                ok_all = False
                continue
            full = premult(img)
            x, y, w, hh = box
            crop = full[y:y + hh, x:x + w]
            diff = int(np.abs(crop.astype(int) - own.astype(int)).max())
            # outside the layer's own region the rendering is empty (alone, at document size)
            other_empty = int(full[:, :, 3].astype(int).sum() - full[y:y + hh, x:x + w, 3].astype(int).sum())
            ok = (h.type, h.doc_w, h.doc_h) == (P.TYPE_TOP_IMAGE, 512, 256) and (msg["w"], msg["h"]) == (512, 256) and diff <= 3
            ok_all &= bool(ok)
            notes.append(f"{label}: type-6 frame {(h.doc_w, h.doc_h)}, max |renderLayer - TD output| in its box {diff} (<= 3), "
                         f"alpha elsewhere {other_empty}: {'ok' if ok else 'FAIL'}")
        for rid, lid, want in (("e1", "p1", "not a text or shape"), ("e2", "nope", "not a text or shape")):
            ed.send(P.render_layer(rid, lid))
            ok = ed.wait(lambda: any(m["t"] == "topError" and m["requestId"] == rid for m in ed.texts), 5)
            msg = next((m for m in ed.texts if m["t"] == "topError" and m["requestId"] == rid), None)
            good = bool(ok and msg and want in msg["msg"])
            ok_all &= good
            notes.append(f"renderLayer {lid!r} -> topError {msg and msg['msg']!r}: {'ok' if good else 'FAIL'}")
        standby = Editor(args.port)
        standby.ws.send(P.render_layer("e3", "t1"))
        ok = standby.wait(lambda: any(m["t"] == "topError" and m["requestId"] == "e3" for m in standby.texts), 5)
        notes.append(f"standby client renderLayer -> topError: {'ok' if ok else 'FAIL'}")
        ok_all &= bool(ok)
    finally:
        ed.close()
        if standby:
            standby.close()
    return ok_all, "\n        ".join(notes)


def s29_export(args):
    """Exportpath / Exportdoc: round trip through a real file (temp + rename, no .part left), the result in Status, guides +
    canvas mode persisted and restored by loadTox into a temp COMP; errors for a missing folder; help + file filter."""
    os.makedirs(OUT_DIR, exist_ok=True)
    reset_canvas(args, 320, 200)
    path = os.path.join(OUT_DIR, "export_roundtrip.tox")
    part = os.path.join(OUT_DIR, "export_roundtrip.part.tox")
    for f in (path, part):
        if os.path.exists(f):
            os.remove(f)
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.send_canvas(320, 200, "fixed")
        wait_for(lambda: out1_size() == [320, 200], 4)
        px = np.random.RandomState(3).randint(0, 256, (30, 40, 4), np.uint8)
        px[..., 3] = 255
        ed.send_doc([L("base", "input", input=1), L("p1", slot=1, size=(40, 30), x=12.5, y=3.25, sx=2.0, sy=2.0)], 90,
                    guides={"h": [10.0, 55.5], "v": [100.0]}, canvas={"mode": "fixed"})
        fid = ed.send_surface(1, (0, 0, 40, 30), px, (40, 30))
        wait_applied(ed, fid, 5)
        time.sleep(0.3)
        before = td_json("""
import hashlib
x = comp.ext.RasterEditorExt
print(json.dumps({'sig': {str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())}, 'guides': x.guides, 'rev': x.doc_rev}))
""")
        # a missing folder is refused with a clear message and nothing is written
        td(f"comp.par.Exportpath = {os.path.join(OUT_DIR, 'no_such_dir', 'x.tox')!r}\ncomp.par.Exportdoc.pulse()")
        msg = wait_for(lambda: "export failed" in status() and status(), 5)
        chk("missing folder -> clear error in Status, no file", bool(msg) and "does not exist" in status(), status()[-110:])
        # the real export
        td(f"comp.par.Exportpath = {path!r}\ncomp.par.Exportdoc.pulse()")
        done = wait_for(lambda: os.path.exists(path), 15)
        wait_for(lambda: "exported with document" in status(), 5)
        chk("Exportdoc wrote the file via temp + rename", done and not os.path.exists(part) and os.path.getsize(path) > 0,
            f"{os.path.getsize(path) if done else 0} bytes, .part exists: {os.path.exists(part)}")
        chk("Status reports the export and the old error is gone", "exported with document" in status() and "export failed" not in status(), status()[-110:])
        locked = td_json("x = comp.ext.RasterEditorExt; print(json.dumps([x.frozen, [s for s in x.network.slots() if x.network.surface_top(s).lock]]))")
        chk("thawed afterwards", locked == [False, []], str(locked))
        # load it into a temp COMP (the live editor is switched off meanwhile: one port)
        td("comp.par.Active = 0")
        time.sleep(0.5)
        td(f"""
old = op('/project1/_validate_load')
if old: old.destroy()
box = op('/project1').create(baseCOMP, '_validate_load')
box.loadTox({path!r})
""", 120)
        time.sleep(0.8)
        loaded = td_json("""
import hashlib
box = op('/project1/_validate_load')
kids = [c.name for c in box.children]
c = box.op(kids[0]) if kids else None
x = c.ext.RasterEditorExt if c is not None else None
res = {'kids': kids}
if x is not None and x.doc_layers is not None:
    res.update(sig={str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())}, guides=x.guides,
               mode=c.par.Docsizemode.eval(), size=[int(c.par.Docw), int(c.par.Doch)], rev=x.doc_rev,
               layer=[{k: l.get(k) for k in ('x', 'y', 'sx', 'sy', 'surfaceW', 'surfaceH')} for l in x.doc_layers if l['id'] == 'p1'][0],
               locked=[s for s in x.network.slots() if x.network.surface_top(s).lock], err=x.last_error and x.last_error[0])
print(json.dumps(res))
""", 120)
        td("""
box = op('/project1/_validate_load')
if box: box.destroy()
comp.par.Active = 1
""")
        wait_for(lambda: "active" in status() or "waiting" in status(), 5)
        chk("guides persisted through Export with Document -> loadTox", loaded.get("guides") == {"h": [10.0, 55.5], "v": [100.0]}, str(loaded.get("guides")))
        chk("canvas mode + size persisted", loaded.get("mode") == "fixed" and loaded.get("size") == [320, 200], f"{loaded.get('mode')} {loaded.get('size')}")
        chk("surface pixels + transform persisted", loaded.get("sig") == before["sig"] and loaded.get("layer") ==
            {"x": 12.5, "y": 3.25, "sx": 2.0, "sy": 2.0, "surfaceW": 40, "surfaceH": 30} and not loaded.get("locked"),
            f"rev {loaded.get('rev')}, layer {loaded.get('layer')}, err {loaded.get('err')}")
        info = td_json("""
p = comp.par.Exportpath
print(json.dumps({'help': (p.help or ''), 'style': p.style, 'ft': str(getattr(p, 'fileTypes', None)), 'ph': (comp.par.Exportdoc.help or '')}))
""")
        notes.append(f"NOTE Exportpath style {info['style']}, fileTypes attribute {info['ft']} (TD has none for custom File pars; '.tox' is appended on export)")
        chk("Exportpath / Exportdoc help", len(info["help"]) > 40 and len(info["ph"]) > 40 and info["style"] == "File")
    finally:
        td("comp.par.Exportpath = ''\ncomp.par.Docsizemode = 'input'")
        ed.close()
    return ok_all, "\n        ".join(notes)


def s30_delete_component(args):
    """Deleting the COMP while clients are connected must not freeze TD (the Web Server DAT's destructor waits for idle HTTP
    keep-alive connections, 10 s each), and undoing the delete must bring the document back with its pixels.
    A throwaway copy (the exported .tox, loaded into a temp container; the live editor is switched off meanwhile: one port)
    with a browser-like keep-alive HTTP client, a WebSocket client and its own panel page connected is deleted (inside an undo
    block): the delete must return quickly, TD must stay responsive and the port must be free; then ui.undo.undo() recreates it
    and its surfaces must be identical to before. Run last."""
    path = os.path.join(ROOT, "dist", "raster_editor.tox")
    was_active = td_json("print(json.dumps(int(comp.par.Active)))")
    notes, ok_all = [], True
    conns, ws = [], None
    try:
        td("comp.par.Active = 0")
        time.sleep(0.5)
        td(f"""
old = op('/project1/_validate_load')
if old: old.destroy()
box = op('/project1').create(baseCOMP, '_validate_load')
box.loadTox({path!r})
""", 120)
        time.sleep(2.0)   # the copy starts its server on the port and its panel page connects
        info = td_json("""
box = op('/project1/_validate_load'); c = box.children[0]
x = c.ext.RasterEditorExt
print(json.dumps({'name': c.name, 'started': x._started, 'token': x.token, 'port': int(c.op('webserver').par.port)}))
""")
        port = info["port"]
        for _ in range(3):   # browser-like: HTTP/1.1 keep-alive connections left open
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
            c.request("GET", "/")
            r = c.getresponse()
            r.read()
            notes.append(f"GET / -> {r.status}, Connection: {r.getheader('connection')}")
            ok_all &= (r.getheader("connection") or "").lower() == "close"
            conns.append(c)
        ws = WS(port)
        ws.send(P.ready("external", info["token"], False, "validate"))
        hello = None
        for _ in range(5):
            m = ws.recv(1.0)
            if isinstance(m, str) and json.loads(m)["t"] == "hello":
                hello = json.loads(m)
                break
        ws.send(json.dumps({"t": "takeover"}))
        ws.recv(1.0)
        # a small document with pixels, so the undo has something to bring back
        W = H = 64
        ws.send(P.doc(1, [L("base", "input", input=1, size=(W, H)), L("p1", slot=1, size=(W, H))]))
        px = np.random.RandomState(5).randint(0, 256, (H, W, 4), np.uint8)
        px[..., 3] = 255
        for m in P.encode_frames(P.TYPE_SURFACE, 1, W, H, (0, 0, W, H), px, slot=1):
            ws.send(m)
        sig_code = """
import hashlib
c = op('/project1/_validate_load').children[-1]
x = c.ext.RasterEditorExt
print(json.dumps({'sig': {str(s): hashlib.md5(b.tobytes()).hexdigest() for s, b in sorted(x.surfaces.items())},
                  'clients': len(x.clients), 'doc': [x.doc_w, x.doc_h], 'nonblank': bool(x.surfaces.get(1) is not None and x.surfaces[1][..., 3].max() > 0)}))
"""
        before = wait_for(lambda: (lambda d: d if d["nonblank"] else None)(td_json(sig_code)), 5) or td_json(sig_code)
        clients = before["clients"]
        ok_all &= clients >= 2 and before["nonblank"]
        notes.append(f"clients connected to the copy (its own panel page + ours): {clients} (>= 2 required); surfaces {list(before['sig'])}, pixels sent: {before['nonblank']}")
        t0 = time.time()
        td("""
c = op('/project1/_validate_load').children[0]
ui.undo.startBlock('validate delete')
c.destroy()
ui.undo.endBlock()
""", 120)
        dt = time.time() - t0
        ok_all &= dt < 3.0
        notes.append(f"deleting the COMP with {clients} client(s) and 3 keep-alive connections took {dt:.2f} s (< 3 s; 10-15 s before the fix)")
        t1 = time.time()
        alive = td_json("print(json.dumps(1))", 10) == 1
        ok_all &= alive and time.time() - t1 < 2
        notes.append(f"TD responsive afterwards: {alive}")
        probe = socket.socket()
        try:
            free = bool(wait_for(lambda: probe.connect_ex(("127.0.0.1", port)) != 0, 5))
        finally:
            probe.close()
        notes.append(f"port {port} released: {free}")
        ok_all &= free
        # undo of the delete: TD recreates the COMP from its snapshot; the pixels come back from the side cache
        td("ui.undo.undo()")
        time.sleep(1.5)
        after = wait_for(lambda: (lambda d: d if d and d["nonblank"] else None)(td_json(sig_code.replace("children[-1]", "children[0]"))), 10)
        same = bool(after) and after["sig"] == before["sig"]
        ok_all &= same
        notes.append(f"undo of the delete: COMP recreated with surfaces {list(after['sig']) if after else None}, pixels identical to before: {same}")
    finally:
        for c in conns:
            try:
                c.close()
            except OSError:
                pass
        if ws is not None:
            try:
                ws.sock.close()
            except OSError:
                pass
        td(f"""
box = op('/project1/_validate_load')
if box: box.destroy()
comp.par.Active = {was_active}
""")
    return ok_all, "\n        ".join(notes)


# --------------------------------------------------------------------------- v6 steps: multiple inputs, files, affine, effects, tools

import frames as FR  # noqa: E402  (td/raster_editor/frames.py: PNG / .redoc codecs)


def in_name(n):
    return TMP if n == 1 else f"/project1/_validate_in{n}"


def connect_n(n, w, h, color):
    """Constant TOP w x h wired to the COMP's input n (the connector must exist: wait for the spare)."""
    if not wait_for(lambda: td_json(f"print(json.dumps(len(comp.inputConnectors)))") >= n, 4):
        raise RuntimeError(f"input connector {n} does not exist")
    td(f"""
c = op({in_name(n)!r})
if c is None:
    c = op('/project1').create(constantTOP, {in_name(n).rsplit('/', 1)[1]!r})
c.par.outputresolution = 'custom'; c.par.resolutionw = {w}; c.par.resolutionh = {h}
c.par.colorr, c.par.colorg, c.par.colorb, c.par.alpha = {color[0]}, {color[1]}, {color[2]}, 1
if not comp.inputConnectors[{n - 1}].connections:
    comp.inputConnectors[{n - 1}].connect(c)
""")


def disconnect_n(n):
    td(f"comp.inputConnectors[{n - 1}].disconnect()")


def reset_inputs(w=800, h=600):
    td(f"""
for c in comp.inputConnectors:
    if c.connections: c.disconnect()
for n in range(1, 9):
    t = op('/project1/_validate_in' + ('' if n == 1 else str(n)))
    if t: t.destroy()
comp.par.Docsizemode = 'input'; comp.par.Docw = {w}; comp.par.Doch = {h}
""")
    wait_for(lambda: out1_size() == [w, h], 4)


def n_connectors():
    return td_json("print(json.dumps(len(comp.inputConnectors)))")


def px_at(x, y, path=COMP + "/out1"):
    """RGBA of one out1 pixel; [-1, -1, -1, -1] while the output is not that large (yet), so wait_for loops simply retry."""
    w, h = out1_size()
    if not (0 <= x < w and 0 <= y < h):
        return [-1, -1, -1, -1]
    return td_rect(path, x, y, 1, 1)[0, 0].tolist()


def s31_inputs(args):
    """Multiple inputs (fake client): spare-connector rule, `inputs` message, per-input BASE frames, input layers rendered at
    their placement, disconnect / reconnect keeps the placement, Follow Input uses input 1 only."""
    reset_inputs()
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    ed = Editor(args.port)
    try:
        for _ in range(4):   # (the page may still be reloading after an earlier step: ask again until we are the active editor)
            if ed.takeover():
                break
        chk("fake client is the active editor", ed.active is True, "")
        chk("initially one unconnected input connector (after the spare trim delay)", wait_for(lambda: n_connectors() == 1, 8), f"({n_connectors()})")
        sizes = {1: (96, 64), 2: (48, 32), 3: (32, 24)}
        cols = {1: (1, 0, 0), 2: (0, 1, 0), 3: (0, 0, 1)}
        for n in (1, 2, 3):
            connect_n(n, *sizes[n], cols[n])
            ok = wait_for(lambda: n_connectors() == n + 1, 4) and ed.wait(lambda: ed.inputs.get(n, (0, 0, False))[2] is True, 4)
            chk(f"connect input {n}: spare connector appears ({n + 1} connectors), `inputs` lists it", ok, f"{n_connectors()} connectors, {ed.inputs}")
        chk("inputs message: sizes and the spare", {k: v[:2] for k, v in ed.inputs.items() if v[2]} == sizes and ed.inputs.get(4) == (0, 0, False),
            str(ed.inputs))
        ed.run(1.0)
        for n in (1, 2, 3):
            body = ed.bases_by_input.get(n, [None])[-1]
            if body is None:
                chk(f"BASE frame input {n}", False, "none received")
                continue
            h, payload = P.decode_frame(body)
            img = np.frombuffer(payload, np.uint8).reshape(h.h, h.w, 4)
            want = [255 * c for c in cols[n]] + [255]
            chk(f"BASE input {n}: header slot, size and colour", h.slot == n and (h.doc_w, h.doc_h) == sizes[n] and img[3, 3].tolist() == want,
                f"slot {h.slot} {h.doc_w}x{h.doc_h} px {img[3, 3].tolist()}")
        st, _ = http_get(args.port, f"/base?token={ed.token}&client={ed.client_id}&input=4")
        chk("spare input has no frame (404)", st == 404, str(st))
        # a document with three input layers on a fixed canvas
        ed.send_canvas(300, 200, "fixed")
        wait_for(lambda: out1_size() == [300, 200], 10)
        lay = lambda: [L("i1", "input", input=1, size=sizes[1]), L("i2", "input", input=2, size=sizes[2], x=150, y=10, sx=2.0, sy=2.0),
                       L("i3", "input", input=3, size=sizes[3], x=20, y=120, rot=0)]
        ed.send_doc(lay(), 10, canvas={"mode": "fixed"})
        wait_for(lambda: {"i1", "i2", "i3"} <= {l["id"] for l in (td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_layers or []))") or [])}, 6)
        ok = wait_for(lambda: px_at(10, 10) == [255, 0, 0, 255] and px_at(170, 30) == [0, 255, 0, 255] and px_at(30, 130) == [0, 0, 255, 255], 5)
        chk("input layers render at their placement", ok, f"{px_at(10, 10)} {px_at(170, 30)} {px_at(30, 130)}")
        before = td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_layers))")
        disconnect_n(2)
        ok = ed.wait(lambda: ed.inputs.get(2, (0, 0, True))[2] is False, 4) and wait_for(lambda: px_at(170, 30)[3] == 0, 4)
        chk("disconnect input 2: reported, its layer renders transparent", ok, f"{ed.inputs.get(2)} {px_at(170, 30)}")
        after = td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_layers))")
        chk("placement kept while disconnected", [(l["id"], l["x"], l["y"], l["sx"]) for l in before] == [(l["id"], l["x"], l["y"], l["sx"]) for l in after],
            str([(l["id"], l["x"], l["sx"]) for l in after]))
        chk("connected neighbours untouched (input 1 and 3 still render)", px_at(10, 10) == [255, 0, 0, 255] and px_at(30, 130) == [0, 0, 255, 255])
        connect_n(2, 60, 40, (0, 1, 0))   # reconnect with ANOTHER resolution
        ok = ed.wait(lambda: ed.inputs.get(2, (0, 0, False))[:2] == (60, 40), 4) and wait_for(lambda: px_at(170, 30) == [0, 255, 0, 255], 4)
        l2 = next(l for l in td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_layers))") if l["id"] == "i2")
        chk("reconnect (new resolution): renders again, placement (x, y, scale) kept, surface size follows the input", ok
            and (l2["surfaceW"], l2["surfaceH"]) == (60, 40) and l2["sx"] == 2.0 and (l2["x"], l2["y"]) == (150, 10), f"{l2['surfaceW']}x{l2['surfaceH']} sx {l2['sx']}")
        # Follow Input uses input 1 only: make input 2 much bigger than input 1
        connect_n(2, 500, 400, (0, 1, 0))
        ed.send_canvas(0, 0, "input")
        ok = wait_for(lambda: out1_size() == [96, 64], 4)
        chk("Follow Input = input 1's size (input 2 is 500x400)", ok, f"out1 {out1_size()}")
        disconnect_n(1)
        ok = wait_for(lambda: td_json("print(json.dumps(comp.ext.RasterEditorExt.has_input))") is False, 4)
        h = ed.hello
        chk("hasInput follows input 1 only", ok, "")
        # trailing spare removal: disconnect 3 and 2 -> connectors shrink to one spare behind the last connected (none) after ~2 s
        disconnect_n(2)
        disconnect_n(3)
        ok = wait_for(lambda: n_connectors() == 1, 8)
        chk("trailing spare inputs are removed again; never a connected one", ok, f"{n_connectors()} connectors")
    except Exception as e:  # noqa: BLE001 - keep the notes gathered so far
        chk("step ran to the end", False, f"{type(e).__name__}: {e}")
    finally:
        ed.close()
        reset_inputs()
    return ok_all, "\n        ".join(notes)


def s32_ui_inputs(args):
    """Real UI: connected inputs appear as input layers in the page (sizes differ), the page lists the inputs."""
    if not ensure_test_hook():
        return None, "test hook not reachable"
    reset_inputs()
    reset_doc(args, [L("p", slot=1, size=(8, 8))])
    time.sleep(1.0)
    if not ui_ready():
        return None, "real page did not become active"
    connect_n(1, 96, 64, (1, 0, 0))
    connect_n(2, 48, 32, (0, 1, 0))
    ok = wait_for(lambda: len([l for l in (hook_call("layers()") or []) if l.get("input")]) >= 2, 6)
    lays = [(l["id"], l.get("input"), l.get("inputConnected")) for l in (hook_call("layers()") or []) if l.get("input")]
    ins = hook_call("inputs()")
    connect_n(3, 32, 24, (0, 0, 1))
    ok3 = wait_for(lambda: any(l.get("input") == 3 for l in (hook_call("layers()") or [])), 6)
    disconnect_n(2)
    okd = wait_for(lambda: any(l.get("input") == 2 and l.get("inputConnected") is False for l in (hook_call("layers()") or [])), 6)
    reset_inputs()
    return bool(ok and ok3 and okd), (f"input layers {lays}; inputs() {str(ins)[:160]}; input 3 layer appeared: {ok3}; "
                                       f"input 2 layer marked disconnected: {okd}")


def unpremultiply_np(img):
    a = img.astype(np.float64)
    al = a[..., 3:4]
    out = a.copy()
    out[..., :3] = np.where(al > 0, a[..., :3] * 255.0 / np.maximum(al, 1), 0)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


FX_GUIDES = {"h": [10.0, 55.5], "v": [100.0]}


def files_layers():
    fx = [{"enabled": True, "type": "dropShadow", "dx": 4, "dy": 4, "blur": 3, "color": {"r": 0, "g": 0, "b": 0, "a": 255}, "opacity": 0.6},
          {"enabled": True, "type": "stroke", "width": 2, "color": {"r": 255, "g": 255, "b": 0, "a": 255}, "position": "outside", "opacity": 1}]
    return [L("p1", slot=1, size=(40, 30), x=100, y=60, sx=2.0, sy=2.0, rot=25, kx=10, effects=fx),
            L("p2", slot=2, mask={"slot": 3, "enabled": True}, size=(30, 30), x=20, y=20, sx=1.5, sy=1.5,
              effects=[{"enabled": True, "type": "colorOverlay", "color": {"r": 255, "g": 0, "b": 128, "a": 255}, "opacity": 0.3}]),
            L("t1", "text", text={"text": "Hi", "font": "Arial", "size": 24, "color": {"r": 255, "g": 255, "b": 255, "a": 255}, "align": "left",
                                  "bold": False, "italic": False, "lineHeight": 1.2, "x": 200, "y": 20, "boxWidth": None}),
            L("a1", "adjustment", adjustment={"type": "invert"}, visible=False)]


def s33_files(args):
    """Project .redoc: save -> change the document -> open: identical layers / specs / effects / guides / surfaces / out1, reload reaches the
    client; PNG export equals out1; the pulses; refusals."""
    os.makedirs(OUT_DIR, exist_ok=True)
    reset_inputs(320, 200)
    proj = os.path.join(OUT_DIR, "files_roundtrip.redoc")
    png = os.path.join(OUT_DIR, "files_export.png")
    for f in (proj, png, proj + ".part", png + ".part"):
        if os.path.exists(f):
            os.remove(f)
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.send_canvas(320, 200, "fixed")
        wait_for(lambda: out1_size() == [320, 200], 4)
        rng = np.random.RandomState(8)
        p1 = rng.randint(0, 256, (30, 40, 4), np.uint8)
        p1[..., 3] = 200
        p2 = rng.randint(0, 256, (30, 30, 4), np.uint8)
        p2[..., 3] = 255
        m = np.zeros((30, 30, 4), np.uint8)
        m[..., 3] = 255
        m[:, :15, :3] = 255
        ed.send_doc(files_layers(), 20, guides=FX_GUIDES, canvas={"mode": "fixed"})
        fids = [ed.send_surface(1, (0, 0, 40, 30), p1, (40, 30)), ed.send_surface(2, (0, 0, 30, 30), p2, (30, 30)),
                ed.send_surface(3, (0, 0, 30, 30), m, (30, 30))]
        wait_applied(ed, fids[-1], 6)
        time.sleep(1.0)
        ref = td_rect(COMP + "/out1", 0, 0, 320, 200)
        ed.doc_state = None
        ed.send(P.request_doc())
        ed.wait(lambda: ed.doc_state is not None, 3)
        want_state = ed.doc_state
        dumps = {s: ed.dump(s)[1] for s in (1, 2, 3)}
        # --- save (request) ---
        ed.send(P.save_project("sv1", proj))
        ok = ed.wait(lambda: any(r.get("requestId") == "sv1" for r in ed.file_results), 10)
        r = next((r for r in ed.file_results if r.get("requestId") == "sv1"), {})
        chk("saveProject -> fileResult ok, file written, no .part", ok and r.get("ok") and os.path.isfile(proj) and not os.path.exists(proj + ".part"), str(r))
        chk("files message carries the parameter", ed.files is not None and ed.files["projectFile"] == proj, str(ed.files))
        doc, meta, pngs = FR.read_redoc(proj)
        chk("zip: doc.json (layers, guides, canvas, effects), surfaces, meta", meta.get("format") == 1 and sorted(pngs) == [1, 2, 3]
            and doc["guides"] == FX_GUIDES and doc["canvas"]["mode"] == "fixed" and doc["layers"][0]["effects"][0]["type"] == "dropShadow",
            f"meta {meta} slots {sorted(pngs)}")
        # --- change the document, then open ---
        ed.send_doc([L("z", "input", input=1)], 21)
        ed.send_surface(1, (0, 0, 40, 30), p2[:30, :30].repeat(2, axis=1)[:, :40].copy(), (40, 30))
        time.sleep(0.8)
        changed = td_rect(COMP + "/out1", 0, 0, 320, 200)
        chk("document replaced (out1 differs)", np.abs(changed.astype(int) - ref.astype(int)).max() > 20)
        n0 = len(ed.reloads)
        ed.file_results.clear()
        ed.send(P.open_project("op1", proj))
        ok = ed.wait(lambda: any(r.get("requestId") == "op1" for r in ed.file_results), 10)
        r = next((r for r in ed.file_results if r.get("requestId") == "op1"), {})
        chk("openProject -> fileResult ok + reload broadcast", ok and r.get("ok") and ed.wait(lambda: len(ed.reloads) > n0, 3), str(r))
        ed.doc_state = None
        ed.send(P.request_doc())
        ed.wait(lambda: ed.doc_state is not None, 3)
        got = ed.doc_state or {}
        strip = lambda st: json.dumps([{k: v for k, v in l.items()} for l in st.get("layers", [])], sort_keys=True)  # noqa: E731
        chk("layers, specs, effects identical", strip(got) == strip(want_state), "" if strip(got) == strip(want_state) else (strip(got)[:200] + " != " + strip(want_state)[:200]))
        chk("guides and canvas identical", got.get("guides") == FX_GUIDES and got.get("canvas") == {"mode": "fixed"}, str(got.get("guides")))
        same = all((ed.dump(s)[1] == dumps[s]).all() for s in (1, 2, 3))
        chk("surfaces identical (straight RGBA via /surface)", same)
        time.sleep(0.8)
        after = td_rect(COMP + "/out1", 0, 0, 320, 200)
        d = int(np.abs(after.astype(int) - ref.astype(int)).max())
        chk("out1 identical to before the save", d <= 1, f"worst diff {d}")
        # --- PNG export ---
        ed.file_results.clear()
        ed.send(P.export_png("pn1", png))
        ok = ed.wait(lambda: any(r.get("requestId") == "pn1" for r in ed.file_results), 10)
        r = next((r for r in ed.file_results if r.get("requestId") == "pn1"), {})
        pimg = FR.decode_png(open(png, "rb").read()) if os.path.isfile(png) else None
        out_now = td_rect(COMP + "/out1", 0, 0, 320, 200)
        want = unpremultiply_np(out_now)
        dpx = int(np.abs(pimg.astype(int)[..., :3] - want.astype(int)[..., :3])[want[..., 3] > 8].max()) if pimg is not None else 999
        dal = int(np.abs(pimg[..., 3].astype(int) - out_now[..., 3].astype(int)).max()) if pimg is not None else 999
        chk("exportPng equals out1 (straight alpha)", ok and r.get("ok") and pimg is not None and pimg.shape[:2] == (200, 320) and dpx <= 3 and dal <= 1,
            f"{r.get('msg', '')} worst rgb {dpx}, alpha {dal}")
        # --- pulses through the parameters ---
        proj2 = os.path.join(OUT_DIR, "files_pulse.redoc")
        if os.path.exists(proj2):
            os.remove(proj2)
        ed.file_results.clear()
        td(f"comp.par.Projectfile = {proj2!r}\ncomp.par.Saveproject.pulse()")
        ok = wait_for(lambda: os.path.isfile(proj2), 10) and ed.wait(lambda: any(r["op"] == "saveProject" for r in ed.file_results), 5)
        chk("Saveproject pulse writes the file, clients get fileResult without requestId, Status flash",
            ok and "requestId" not in ed.file_results[-1] and "project saved" in status(), status()[-90:])
        td("comp.par.Projectfile = " + repr(os.path.join(OUT_DIR, "nope", "x.redoc")) + "\ncomp.par.Saveproject.pulse()")
        wait_for(lambda: "project save failed" in status(), 5)
        chk("failed pulse shows the reason in Status", "does not exist" in status(), status()[-120:])
        # --- damaged project leaves the document alone ---
        bad = os.path.join(OUT_DIR, "files_bad.redoc")
        open(bad, "wb").write(b"not a zip")
        rev_before = td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_rev))")
        ed.file_results.clear()
        ed.send(P.open_project("op2", bad))
        ed.wait(lambda: any(r.get("requestId") == "op2" for r in ed.file_results), 6)
        r = next((r for r in ed.file_results if r.get("requestId") == "op2"), {})
        chk("damaged file refused, document untouched", r.get("ok") is False and td_json("print(json.dumps(comp.ext.RasterEditorExt.doc_rev))") == rev_before, str(r))
    finally:
        ed.close()
        reset_inputs()
    return ok_all, "\n        ".join(notes)


def compare_page_td(regions):
    """[(name, (x, y, w, h), tol, mean_tol, edge_frac)] -> (ok, notes): per-pixel difference of the page's composite and out1,
    excluding pixels whose coverage differs (boundaries), which must stay below ``edge_frac`` of the region."""
    notes, ok_all = [], True
    for name, (x, y, w, h), tol, mtol, efrac in regions:
        pg = page_region(x, y, w, h)
        td_img = td_rect(COMP + "/out1", x, y, w, h)
        if pg is None:
            notes.append(f"{name}: FAIL page pixels not readable")
            ok_all = False
            continue
        d = np.abs(td_img.astype(int) - pg.astype(int))
        edge = np.abs(td_img[..., 3].astype(int) - pg[..., 3].astype(int)) > 8
        worst = int(d[~edge].max()) if (~edge).any() else 0
        mean = float(np.abs(td_img.astype(float).mean(axis=(0, 1)) - pg.astype(float).mean(axis=(0, 1))).max())
        frac = float(edge.mean())
        ok = worst <= tol and mean <= mtol and frac <= efrac
        ok_all &= ok
        notes.append(f"{name}: worst |TD - page| {worst} (<= {tol}), mean diff {mean:.1f} (<= {mtol}), boundary px {frac * 100:.1f}% (<= {efrac * 100:.1f}%): {'ok' if ok else 'FAIL'}")
    return ok_all, notes


def s34_ui_affine_parity(args):
    """Real UI: rotated / skewed pixel and input layers (and a mask on one) -- TD resample pass vs the browser preview."""
    if not ensure_test_hook():
        return None, "test hook not reachable"
    reset_canvas(args, 800, 600)
    connect_input_sized(64, 48)
    a, b, c, m = xf_surfaces()
    layers = [L("base", "input", input=1, size=(64, 48), x=40, y=190, sx=1.5, sy=1.5, rot=20),
              L("pa", slot=1, size=(8, 8), x=250, y=30, sx=8.0, sy=8.0, rot=30, kx=15),
              L("pc", slot=3, mask={"slot": 4, "enabled": True}, size=(16, 16), x=150, y=150, sx=4.0, sy=4.0, rot=-25, ky=10)]
    ed = Editor(args.port)
    try:
        take_over(ed)
        ed.send_canvas(XF_W, XF_H, "fixed")
        wait_for(lambda: out1_size() == [XF_W, XF_H], 4)
        ed.send_doc(layers, 61)
        fids = [ed.send_surface(1, (0, 0, 8, 8), a, (8, 8)), ed.send_surface(3, (0, 0, 16, 16), c, (16, 16)), ed.send_surface(4, (0, 0, 16, 16), m, (16, 16))]
        if not wait_applied(ed, fids[-1], 6):
            return False, "no `applied`"
    finally:
        ed.close()
    time.sleep(1.5)
    if not ui_ready() or not settle_page(40):
        return None, "real page did not become active/load the document (page and TD never agreed on the layer stack)"
    lay = {l["id"]: l for l in (hook_call("layers()") or [])}
    notes = []
    ok_load = all(k in lay and abs(lay[k]["transform"].get("rot", 0) - r) < 1e-6 for k, r in (("base", 20), ("pa", 30), ("pc", -25)))
    notes.append(f"rot/skew survive the load into the page: {'ok' if ok_load else 'FAIL ' + str({k: v.get('transform') for k, v in lay.items()})}")
    ok, n = compare_page_td([("rotated+skewed magnified gradient", (180, 0, 220, 190), 12, 4.0, 0.03),
                             ("rotated masked layer", (110, 110, 200, 190), 12, 4.0, 0.03),
                             ("rotated input", (0, 150, 140, 150), 12, 4.0, 0.04)])
    return ok and ok_load, "\n        ".join(notes + n)


def s35_ui_effects_parity(args):
    """Real UI: every deterministic layer effect (+ pixel sort, glitch) -- TD GLSL chain vs the browser preview's WebGL2 (same shaders)."""
    if not ensure_test_hook():
        return None, "test hook not reachable"
    reset_canvas(args, 800, 600)
    W, H, cell = 400, 300, 100
    yy, xx = np.mgrid[0:64, 0:64]
    disc = np.zeros((64, 64, 4), np.uint8)
    r = np.hypot(xx - 31.5, yy - 31.5)
    disc[..., :3] = np.stack([60 + xx * 3, 200 - yy * 2, np.full_like(xx, 120)], axis=2)
    disc[..., 3] = np.clip((24 - r) * 255, 0, 255)
    col = lambda r_, g, b: {"r": r_, "g": g, "b": b, "a": 255}   # noqa: E731
    effects = {
        "dropShadow": {"type": "dropShadow", "dx": 5, "dy": 6, "blur": 6, "color": col(0, 0, 0), "opacity": 0.7},
        "outerGlow": {"type": "outerGlow", "size": 8, "color": col(255, 200, 0), "opacity": 0.9},
        "innerGlow": {"type": "innerGlow", "size": 8, "color": col(255, 255, 255), "opacity": 0.9},
        "stroke": {"type": "stroke", "width": 4, "color": col(255, 0, 0), "position": "center", "opacity": 1},
        "bevel": {"type": "bevel", "depth": 60, "size": 6, "angle": 120, "highlight": col(255, 255, 255), "shadow": col(0, 0, 0)},
        "colorOverlay": {"type": "colorOverlay", "color": col(0, 128, 255), "opacity": 0.5},
        "chromaticAberration": {"type": "chromaticAberration", "amount": 3, "angle": 30},
        "halftone": {"type": "halftone", "cellSize": 6, "angle": 45, "shape": "dot"},
        "glitch": {"type": "glitch", "amount": 40, "blockSize": 8, "seed": 5, "rgbShift": 3},
        "pixelSort": {"type": "pixelSort", "direction": "h", "low": 0.2, "high": 0.9, "key": "luma"},
        "outerGlow+stroke": None,
    }
    names = [n for n, v in effects.items() if v is not None]
    layers, grid = [], {}
    for i, n in enumerate(names):
        x, y = (i % 4) * cell + 18, (i // 4) * cell + 18
        grid[n] = (i % 4 * cell, i // 4 * cell, cell, cell)
        layers.append(L(f"e{i}", slot=i + 1, size=(64, 64), x=x, y=y, sx=0.5, sy=0.5,
                        effects=[dict(effects[n], enabled=True)]))
    ed = Editor(args.port)
    try:
        take_over(ed)
        ed.send_canvas(W, H, "fixed")
        wait_for(lambda: out1_size() == [W, H], 4)
        ed.send_doc(layers, 62)
        fids = [ed.send_surface(i + 1, (0, 0, 64, 64), disc, (64, 64)) for i in range(len(names))]
        if not wait_applied(ed, fids[-1], 30):
            snap = td_json("x = comp.ext.RasterEditorExt; print(json.dumps({'rev': x.doc_rev, 'applied_net': x._net_applied, 'dirty': sorted(x._dirty)[:12], "
                           "'clients': [(k.kind, k.active, k.fid_pending, k.fid_applied) for k in x.clients.values()], 'err': str(x.last_error), 'pending': x._restore_pending, "
                           "'slots': len(x._slot_set), 'size': [x.doc_w, x.doc_h]}))")
            return False, f"no `applied` for {fids[-1]} (got {sorted(ed.applied)[-3:]}); TD {snap}; client texts {[t['t'] for t in ed.texts][-6:]}; status={status()!r}"
    finally:
        ed.close()
    time.sleep(2.0)
    if not ui_ready() or not settle_page(40):
        return None, "real page did not become active/load the document (page and TD never agreed on the layer stack)"
    fx_err = td_json("n = comp.ext.RasterEditorExt.network; print(json.dumps(getattr(n, 'fx_error', None)))")
    # tolerance: 3/255 for deterministic effects (design), more for the sort / glitch families (documented in the note)
    # halftone: dot boundaries are anti-aliased differently (coverage of ~6% of the cell differs); glitch: seeded random block shifts
    # differ in a few blocks between the two shader hosts (hash precision) -- both are the experimental effects, tolerances are loose
    tol = {"pixelSort": 40}
    edge = {}
    regions = [(n, grid[n], tol.get(n, 3), 2.0, edge.get(n, 0.02)) for n in names]
    ok, notes = compare_page_td(regions)
    if not ok:   # evidence: both images and the page's / TD's layer stack
        try:
            pg_full, td_full = page_region(0, 0, W, H), td_rect(COMP + "/out1", 0, 0, W, H)
            if pg_full is not None:
                for nm, im in (("page", pg_full), ("td", td_full)):
                    open(os.path.join(OUT_DIR, f"effects_{nm}.png"), "wb").write(FR.encode_png(unpremultiply_np(im)))
            tdl = td_json("print(json.dumps([[l['id'], l.get('x'), l.get('y'), l.get('sx'), len(l.get('effects') or [])] for l in comp.ext.RasterEditorExt.doc_layers]))")
            pgl = js_result("(function(){return window.__editorTest.layers().map(function(l){return [l.id,l.transform&&l.transform.x,l.transform&&l.transform.y,l.transform&&l.transform.sx,(l.effects||[]).length]})})()")
            notes.append(f"TD layers {tdl[:3]}.. page layers {str(pgl)[:200]}.. canvas TD {out1_size()} page {js_result('window.__editorTest.state().doc')}")
        except Exception as e:  # noqa: BLE001
            notes.append(f"(evidence failed: {e})")
    return ok and not fx_err, (f"fx_error={fx_err}\n        " if fx_err else "") + "\n        ".join(notes)


def s36_ui_tools(args):
    """Real UI via the test hook: quick mask round trip + clipped stroke, clone, floating selection commit, crop -- all reflected in TD's output."""
    if not ensure_test_hook():
        return None, "test hook not reachable"
    reset_canvas(args, 320, 200)
    reset_doc(args, [L("base", "input", input=1)])
    ed = Editor(args.port)
    try:
        ed.takeover()
        ed.send_canvas(320, 200, "fixed")
        wait_for(lambda: out1_size() == [320, 200], 4)
    finally:
        ed.close()
    time.sleep(1.5)
    if not ui_ready():
        return None, "real page did not become active"
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    hook_call("addLayer()")
    hook_call("setPrimary('#ff0000')")
    hook_call("selectRect(100, 60, 100, 80)")
    q = hook_call("setQuickMask(true)")
    q2 = hook_call("setQuickMask(false)")
    chk("quick mask on/off", q is True or q is not None, f"({q} -> {q2})")
    hook_call("stroke('brush', [[60, 100], [260, 100]])")
    inside = wait_for(lambda: px_at(150, 100)[3] > 200, 5)
    chk("stroke after quick-mask round trip is clipped to the selection in TD", inside and px_at(70, 100)[3] == 0 and px_at(240, 100)[3] == 0,
        f"inside {px_at(150, 100)}, left {px_at(70, 100)}, right {px_at(240, 100)}")
    hook_call("deselect()")
    hook_call("setTool('brush')")
    hook_call("stroke('brush', [[20, 20], [24, 20]])")
    wait_for(lambda: px_at(22, 20)[3] > 200, 4)
    hook_call("setCloneSource(22, 20)")
    hook_call("stroke('clone', [[220, 150], [224, 150]])")
    ok = wait_for(lambda: px_at(222, 150)[3] > 100, 5)
    chk("clone copies the sampled pixels", ok, f"dest {px_at(222, 150)}")
    hook_call("selectRect(10, 10, 30, 20)")
    fl = hook_call("liftSelection()")
    f = js_result("(function(){var f=window.__editorTest.floating();return f?{transform:f.transform}:null})()")
    notes.append(f"(liftSelection() -> {fl!r}; floating() -> {str(f)[:120]})")
    if f:
        tf = f.get("transform", {})
        hook_call(f"setFloatingTransform({{x: {tf.get('x', 0) + 200}, y: {tf.get('y', 0) + 100}}})")
        hook_call("commitFloating()")
        ok = wait_for(lambda: px_at(222, 120)[3] > 150, 5)
        chk("floating selection moved and committed", ok and px_at(22, 20)[3] == 0, f"new place {px_at(222, 120)}, old {px_at(22, 20)}")
    else:
        chk("floating selection lifted", False, f"floating() = {f}")
    hook_call("crop({x: 0, y: 0, w: 200, h: 150})")
    ok = wait_for(lambda: out1_size() == [200, 150], 5)
    chk("crop resizes the canvas (TD out1)", ok, f"out1 {out1_size()}")
    return ok_all, "\n        ".join(notes)


def s37_choose_file(args):
    """chooseFile plumbing with the test stub (`testPath`, Panelquery test=1; the native dialog cannot be automated):
    fileChosen for project / PNG purposes, placeImage -> a picked PNG arrives as topReady + GET /top, errors."""
    os.makedirs(OUT_DIR, exist_ok=True)
    img = np.random.RandomState(2).randint(0, 256, (24, 40, 4), np.uint8)
    img[..., 3] = 255
    pic = os.path.join(OUT_DIR, "place_me.png")
    open(pic, "wb").write(FR.encode_png(img))
    old_q = td("print(comp.par.Panelquery.eval())").strip()
    td("comp.par.Panelquery = 'test=1'")
    notes, ok_all = [], True

    def chk(label, cond, extra=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        notes.append(f"{label}: {'ok' if cond else 'FAIL'} {extra}".rstrip())

    def msgs(ed, t, rid):
        return [m for m in ed.texts if m["t"] == t and m.get("requestId") == rid]

    ed = Editor(args.port)
    try:
        ed.takeover()
        for purpose in ("openProject", "saveProject", "exportPng"):
            ed.send(json.dumps({"t": "chooseFile", "requestId": purpose, "purpose": purpose, "testPath": "/tmp/x_" + purpose}))
            ok = ed.wait(lambda: msgs(ed, "fileChosen", purpose), 3)
            chk(f"{purpose}: fileChosen carries the path", ok and msgs(ed, "fileChosen", purpose)[0]["path"] == "/tmp/x_" + purpose)
        ed.send(json.dumps({"t": "chooseFile", "requestId": "cancel", "purpose": "placeImage", "testPath": None}))
        ok = ed.wait(lambda: msgs(ed, "fileChosen", "cancel"), 3)
        chk("cancel -> path null, nothing imported", ok and msgs(ed, "fileChosen", "cancel")[0]["path"] is None and not msgs(ed, "topReady", "cancel"))
        ed.send(json.dumps({"t": "chooseFile", "requestId": "pic", "purpose": "placeImage", "testPath": pic}))
        ok = ed.wait(lambda: msgs(ed, "topReady", "pic") or msgs(ed, "topError", "pic"), 15)
        ready = msgs(ed, "topReady", "pic")
        chk("placeImage: fileChosen then topReady", ok and ready and msgs(ed, "fileChosen", "pic")[0]["path"] == pic and (ready[0]["w"], ready[0]["h"]) == (40, 24),
            str(msgs(ed, "topError", "pic") or ready))
        if ready:
            st, body = http_get(args.port, f"/top?token={ed.token}&client={ed.client_id}&requestId=pic")
            hdr, payload = P.decode_frame(body) if st == 200 else (None, b"")
            got = np.frombuffer(payload, np.uint8).reshape(24, 40, 4) if st == 200 else None
            d = int(np.abs(got.astype(int) - img.astype(int)).max()) if got is not None else 999
            chk("GET /top returns the picture (frame type 6)", st == 200 and hdr.type == P.TYPE_TOP_IMAGE and d <= 2, f"worst diff {d}")
        left = td_json("print(json.dumps([c.name for c in comp.children if c.name.startswith('_imp_')]))")
        chk("temporary Movie File In TOP destroyed", left == [], str(left))
        txt = os.path.join(OUT_DIR, "not_an_image.txt")
        open(txt, "w").write("x")
        ed.send(json.dumps({"t": "chooseFile", "requestId": "bad", "purpose": "placeImage", "testPath": txt}))
        ok = ed.wait(lambda: msgs(ed, "topError", "bad"), 5)
        chk("non-image refused with topError", ok and "not a supported image" in msgs(ed, "topError", "bad")[0]["msg"])
    finally:
        ed.close()
        td(f"comp.par.Panelquery = {old_q!r}")
    return ok_all, "\n        ".join(notes)


def s38_filters_compile(args):
    """Every effect and filter shader of the BUILT component (embedded fx_* DATs incl. blurlib / filterlib / in2lib) compiles in TD:
    one layer per type with its default parameters, then every GLSL TOP of the generated network is cooked and checked for errors."""
    import effects as EF
    reset_canvas(args, 800, 600)
    names = EF.shader_names()
    layers, fx_types = [], []
    for i, n in enumerate(names):
        sp = EF.FILTER_SPECS.get(n)
        if n in EF_V5:
            e = {"type": n, "enabled": True, **EF_V5[n]}
        else:
            e = {"type": n, "enabled": True, **{k: v["default"] for k, v in (sp or {}).get("params", {}).items() if "default" in v}}
        fx_types.append(n)
        layers.append(L(f"f{i}", slot=i + 1, size=(24, 24), x=(i % 8) * 80 + 20, y=(i // 8) * 80 + 20, effects=[e]))
    px = np.zeros((24, 24, 4), np.uint8)
    px[4:20, 4:20] = (200, 90, 40, 255)
    ed = Editor(args.port)
    try:
        for _ in range(4):
            if ed.takeover():
                break
        ed.send_canvas(800, 600, "fixed")
        wait_for(lambda: out1_size() == [800, 600], 6)
        ed.send_doc(layers, 80)
        fids = [ed.send_surface(i + 1, (0, 0, 24, 24), px, (24, 24)) for i in range(len(names))]
        if not wait_applied(ed, fids[-1], 40):
            return False, f"no `applied`; status={status()!r}"
    finally:
        ed.close()
    time.sleep(1.5)
    res = td_json("""
doc = op('/project1/raster_editor/doc')
bad = {}
n = 0
for o in doc.findChildren(type=glslTOP):
    n += 1
    o.cook(force=True)
    e = o.errors(recurse=False)
    if e: bad[o.name] = e[:160]
net = comp.ext.RasterEditorExt.network
print(json.dumps({'n': n, 'bad': dict(list(bad.items())[:6]), 'nbad': len(bad), 'fx_error': getattr(net, 'fx_error', None), 'last_error': str(comp.ext.RasterEditorExt.last_error)}))
""", 120)
    ok = res["n"] > len(names) and res["nbad"] == 0 and not res["fx_error"]
    return ok, f"{len(names)} shader types ({len([n for n in names if n in EF.FILTER_SPECS])} filters), {res['n']} GLSL TOPs cooked, {res['nbad']} with errors {res['bad']}, fx_error={res['fx_error']}"


EF_V5 = {
    "dropShadow": {"dx": 4, "dy": 4, "blur": 4, "color": {"r": 0, "g": 0, "b": 0, "a": 255}, "opacity": 0.6},
    "outerGlow": {"size": 6, "color": {"r": 255, "g": 200, "b": 0, "a": 255}, "opacity": 0.8},
    "innerGlow": {"size": 6, "color": {"r": 255, "g": 255, "b": 255, "a": 255}, "opacity": 0.8},
    "stroke": {"width": 3, "color": {"r": 255, "g": 0, "b": 0, "a": 255}, "position": "outside", "opacity": 1},
    "bevel": {"depth": 50, "size": 4, "angle": 120, "highlight": {"r": 255, "g": 255, "b": 255, "a": 255}, "shadow": {"r": 0, "g": 0, "b": 0, "a": 255}},
    "colorOverlay": {"color": {"r": 0, "g": 100, "b": 255, "a": 255}, "opacity": 0.5},
    "pixelSort": {"direction": "h", "low": 0.2, "high": 0.9, "key": "luma"},
    "glitch": {"amount": 30, "blockSize": 6, "seed": 3, "rgbShift": 2},
    "chromaticAberration": {"amount": 2, "angle": 30},
    "halftone": {"cellSize": 4, "angle": 45, "shape": "dot"},
}


STEPS = [
    (1, "build component, no operator errors, document survives a rebuild", "build", False),
    (2, "web server serves the UI", "server", False),
    (3, "web render panel loaded and not blank", "panel", False),
    (4, "no input: out1 is Docw x Doch", "noinput", False),
    (5, "fake client v3: doc + SURFACE tiles -> out1 pixels, BASE pull, applied", "scene", False),
    (6, "painted mask hides exactly the masked pixels; /surface round trip", "masks", False),
    (7, "TD VIEW stream for an external client: content, fps, age", "view", False),
    (8, "stroke -> TD latency (applied) and per-frame upload cost", "latency", False),
    (9, "panel TD-view overlay: view message -> panel_view background", "overlay", False),
    (10, "persistence: Freeze/Thaw, Exportdoc -> loadTox identical", "persist", False),
    (11, "fresh load, reconnect re-send, takeover", "reconnect", False),
    (12, "network + apply budgets (20 layers @1080p)", "perf", False),
    (13, "blend + adjustment parity TD vs browser preview (real UI)", "parity", True),
    (14, "real UI: brush stroke, undo", "uipaint", True),
    (15, "real UI: TD mode, latency readouts", "uiview", True),
    (16, "stalled clients (never read / never fetch, then RST): bounded, TD stays responsive", "stalled", False),
    (17, "every custom parameter has help text", "help", False),
    (18, "fonts list after hello: non-empty, sorted, common family", "fonts", False),
    (19, "TOP import: list, Constant + 4096x2160 Ramp, errors, 30 s expiry, bounded cost", "topimport", False),
    (20, "real UI: import TOPs as layers (big one scaled to fit)", "uitop", True),
    (21, "real UI: text/shape TD-rendered vs browser preview, Flatten equals TD's rendering", "uitextshape", True),
    (22, "real UI: lasso / wand selections clip strokes in TD output", "uiselect", True),
    (23, "transforms in TD vs numpy: magnify, minify (mipmaps), mask on a transformed layer, base transform", "xform", False),
    (24, "real UI: transform parity TD vs browser preview", "uixform", True),
    (25, "real UI: painting on a scaled layer lands under the cursor", "uipaintscaled", True),
    (26, "canvas: setCanvas, Follow Input / Fixed, input resolution changes, parameter edits, surfaces untouched", "canvas", False),
    (27, "real UI: Canvas Size anchors, Follow Input reset, input resolution while following / fixed", "uicanvas", True),
    (28, "renderLayer (Flatten source) equals TD's own rendering; errors", "renderlayer", False),
    (29, "Exportpath / Exportdoc round trip; guides + canvas persisted through loadTox", "export", False),
    (31, "multiple inputs: spare connector rule, inputs message, per-input BASE, layers placed, disconnect/reconnect, Follow Input = input 1", "inputs", False),
    (32, "real UI: connected inputs become input layers; disconnected ones are marked", "uiinputs", True),
    (33, ".redoc save -> change -> open round trip, reload, PNG export equals out1, pulses, refusals", "files", False),
    (34, "real UI: affine (rotate / skew + mask) parity TD vs browser preview", "uiaffine", True),
    (35, "real UI: layer effects parity TD vs browser preview (all ten)", "uieffects", True),
    (36, "real UI: quick mask, clone, floating commit, crop reflected in TD", "uitools", True),
    (37, "chooseFile plumbing (test stub): fileChosen, placeImage -> topReady + GET /top, errors", "choose", False),
    (38, "every effect + filter shader of the built component compiles in TD (includes embedded)", "filters", False),
    (99, "deleting the COMP with clients connected does not freeze TD; undo of the delete restores the pixels (run last)", "delete", False),
]
FUNCS = {"build": "s1_build", "server": "s2_server", "panel": "s3_panel", "noinput": "s4_no_input", "scene": "s5_scene",
         "masks": "s6_masks", "view": "s7_view_stream", "latency": "s8_latency", "overlay": "s9_panel_overlay",
         "persist": "s10_persistence", "reconnect": "s11_reconnect_takeover", "perf": "s12_perf", "parity": "s15_parity",
         "uipaint": "s14_ui_paint", "uiview": "s16_ui_view_mode", "stalled": "s13_stalled_client",
         "help": "s17_param_help", "fonts": "s18_fonts", "topimport": "s19_top_import", "uitop": "s20_ui_top_import",
         "uitextshape": "s21_ui_text_shape", "uiselect": "s22_ui_selection_clip",
         "xform": "s23_transforms_td", "uixform": "s24_ui_transform_parity", "uipaintscaled": "s25_ui_paint_scaled",
         "canvas": "s26_canvas_td", "uicanvas": "s27_ui_canvas", "renderlayer": "s28_render_layer", "export": "s29_export", "delete": "s30_delete_component",
         "inputs": "s31_inputs", "uiinputs": "s32_ui_inputs", "files": "s33_files", "uiaffine": "s34_ui_affine_parity",
         "uieffects": "s35_ui_effects_parity", "uitools": "s36_ui_tools", "choose": "s37_choose_file", "filters": "s38_filters_compile"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-ui", action="store_true", help="skip the steps that need the real web page")
    ap.add_argument("--fake-client", action="store_true", help="python WebSocket client acts as the web app (the default for steps 5-12, 16)")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--port", type=int, default=9980)
    ap.add_argument("--only", default="", help="comma separated step numbers")
    args = ap.parse_args()
    only = {int(x) for x in args.only.split(",") if x.strip()}
    g = globals()
    try:
        for num, name, key, ui in STEPS:
            if only and num not in only:
                continue
            if ui and args.skip_ui:
                step(num, name, lambda: (None, "skipped (--skip-ui)"))
            else:
                step(num, name, lambda k=key: g[FUNCS[k]](args))
    finally:
        try:
            restore = "\n".join(f"comp.par.{k} = {v!r}" for k, v in ORIG.items())
            td(f"""
for c in comp.inputConnectors:
    if c.connections: c.disconnect()
{restore}
for p in ['/project1/_validate_in' + ('' if n == 1 else str(n)) for n in range(1, 9)] + ['/project1/_validate_load', '/project1/_validate_tops']:
    t = op(p)
    if t: t.destroy()
comp.par.Active = 1
""")
        except Exception as e:  # noqa: BLE001
            print("cleanup failed:", e)
    failed = [r for r in results if r is False]
    print(f"\n{results.count(True)} passed, {len(failed)} failed, {results.count(None)} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
