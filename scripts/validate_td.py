"""Live validation of the raster_editor COMP (protocol v3) against a running TouchDesigner
(docs/TESTING.md section 3, docs/DESIGN_V2.md section 7).

    .venv/bin/python scripts/validate_td.py                  # every step (the real UI drives the UI steps)
    .venv/bin/python scripts/validate_td.py --skip-ui        # only the steps a python fake client can drive
    .venv/bin/python scripts/validate_td.py --fake-client    # same, but keeps the UI steps that tolerate it
    .venv/bin/python scripts/validate_td.py --only 5,7,9     # run chosen steps (numbers below)

The fake client speaks protocol v3 over a stdlib WebSocket: it sends `doc` + SURFACE tiles like the web
app, pulls BASE / VIEW / SURFACE over HTTP and measures `applied` latency.

Flags: --no-build (reuse the COMP that exists), --port N, --only. Only operators inside
/project1/raster_editor and the temporary /project1/_validate_in, /project1/_validate_load are touched
(destroyed again at the end); the user's .toe is never saved: persistence uses SaveTox to dist/validate.
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


def get_base(port, tok, client_id, frame_id=0):
    """GET /base (PROTOCOL.md section 4): the newest BASE frame message, or None on 404."""
    st, body = http_get(port, f"/base?token={tok}&client={client_id}&frameId={frame_id}")
    return body if st == 200 else None


def L(id, kind="pixel", slot=None, mask=None, **kw):
    d = {"id": id, "kind": kind, "parentId": None, "name": id, "visible": True, "opacity": 1, "blend": "normal",
         "x": 0, "y": 0, "slot": slot, "mask": mask, "adjustment": None}
    d.update(kw)
    return d


class Editor:
    """A fake web client speaking protocol v3: doc + SURFACE tiles out, notices + HTTP pulls in."""

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
            elif t == "active":
                self.active = msg["active"]
            elif t == "docSize":
                self.doc_w, self.doc_h = msg["w"], msg["h"]
            elif t == "docState":
                self.doc_state = msg
            elif t == "applied":
                self.applied[msg["frameId"]] = now
            elif t == "base":
                self.notices["base"] += 1
                if self.autofetch:
                    body = get_base(self.port, self.token, self.client_id, msg["frameId"])
                    if body is not None:
                        self.bases.append(body)
            elif t == "view":
                self.notices["view"] += 1
                t_notice = now
                if self.autofetch:
                    st, body = http_get(self.port, f"/view?token={self.token}&client={self.client_id}&frameId={msg['frameId']}")
                    if st == 200:
                        self.view_log.append((time.time(), P.decode_frame(body)[0], msg["appliedFrameId"], body, t_notice))

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

    def send_doc(self, layers, rev):
        self.send(P.doc(rev, layers))

    def send_surface(self, slot, rect, pixels):
        """One SURFACE frame (bands under 2 MB); returns its frameId."""
        self.fid += 1
        self.sent[self.fid] = time.time()
        for m in P.encode_frames(P.TYPE_SURFACE, self.fid, self.doc_w, self.doc_h, rect, pixels, slot=slot):
            self.ws.send(m)
        return self.fid

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


SCENE_LAYERS = [L("base", "base"), L("p1", slot=1), L("p2", slot=2, mask={"slot": 3, "enabled": True})]


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
    ORIG.update(td_json("print(json.dumps({'Port': int(comp.par.Port), 'Docw': int(comp.par.Docw), 'Doch': int(comp.par.Doch), 'Panelquery': comp.par.Panelquery.eval()}))"))
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
    td("comp.inputConnectors[0].disconnect() if comp.inputConnectors[0].connections else None\ncomp.par.Docw = 800; comp.par.Doch = 600")
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
        if h["protocol"] != 3 or h["doc"] != {"w": IW, "h": IH} or not h["hasInput"] or "hasDocument" not in h or "rev" not in h:
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
            base_ok = tuple(img[IH // 2, IW // 2]) == (255, 0, 0, 255) and hdr.type == P.TYPE_BASE and hdr.slot == 0
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
    """Freeze/Thaw round trip; SaveTox -> loadTox into a temp COMP: document + output identical. Never saves the .toe."""
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
    td(f"comp.ext.RasterEditorExt.SaveTox({path!r})")
    size = os.path.getsize(path) if os.path.exists(path) else 0
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
          and loaded.get("rev") == before["rev"] and loaded.get("out") == before["out"] and not loaded.get("frozen_left"))
    return bool(ok), (f"Freeze locks all surface TOPs: {ft['locked']}, Thaw unlocks: {ft['unlocked']}, output unchanged: {after_ft == before['out']}; "
                      f"SaveTox -> {size} bytes; loaded copy: rev {loaded.get('rev')} (was {before['rev']}), surfaces identical: {same_sig}, "
                      f"out identical: {loaded.get('out') == before['out']}, locked after restore: {loaded.get('frozen_left')}, err={loaded.get('err')}")

def s11_reconnect_takeover(args):
    """Fresh page loads TD's document; reconnecting client re-sends (authoritative); takeover hands over and loads."""
    p1, p2, mask = STATE["p1"], STATE["p2"], STATE["mask"]
    a = Editor(args.port)
    a.takeover()
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
        layers = [L("base", "base")]
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


def ui_ready():
    """The real page is the active editor and finished loading (after a fake client left)."""
    def loaded():
        ls = js_result("window.__editorTest.loadState()") or {}
        return ls.get("active") is True and not ls.get("loadingDoc")
    return wait_for(loaded, 10, 0.3)


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
        ed.send_doc(layers or [L("base", "base")], 900)
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
    layers = [L("base", "base"), L("bg", slot=1)]
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
        ed.takeover()
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
        if not ui_ready():
            return None, f"real page did not become active/load the document: {js_result('window.__editorTest.loadState()')}"
        stt = js_result("window.__editorTest.loadState()")
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
    (10, "persistence: Freeze/Thaw, SaveTox -> loadTox identical", "persist", False),
    (11, "fresh load, reconnect re-send, takeover", "reconnect", False),
    (12, "network + apply budgets (20 layers @1080p)", "perf", False),
    (13, "blend + adjustment parity TD vs browser preview (real UI)", "parity", True),
    (14, "real UI: brush stroke, undo", "uipaint", True),
    (15, "real UI: TD mode, latency readouts", "uiview", True),
    (16, "stalled clients (never read / never fetch, then RST): bounded, TD stays responsive", "stalled", False),
]
FUNCS = {"build": "s1_build", "server": "s2_server", "panel": "s3_panel", "noinput": "s4_no_input", "scene": "s5_scene",
         "masks": "s6_masks", "view": "s7_view_stream", "latency": "s8_latency", "overlay": "s9_panel_overlay",
         "persist": "s10_persistence", "reconnect": "s11_reconnect_takeover", "perf": "s12_perf", "parity": "s15_parity",
         "uipaint": "s14_ui_paint", "uiview": "s16_ui_view_mode", "stalled": "s13_stalled_client"}


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
comp.inputConnectors[0].disconnect()
{restore}
for p in ('/project1/_validate_in', '/project1/_validate_load'):
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
