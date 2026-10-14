"""RasterEditorExt: TouchDesigner glue for the raster editor COMP (docs/TD_COMPONENT.md).

Thin by design: byte layout lives in ``protocol``, pixel maths in ``frames``. Everything
here runs on TD's main thread and must stay bounded: no sync readbacks, no sleeping,
at most a couple of 2 MB messages and a few ms of conversion per frame.

All operators are reached through ``ownerComp.op(...)`` so the class can run against fake
TD objects in ``td/tests``.
"""

import collections
import functools
import hmac
import ipaddress
import secrets
import time
import traceback
from urllib.parse import parse_qs

import numpy as np

CLIENT_KINDS = ("panel", "external")
MODIFIER_KEYS = frozenset((
    "shift", "lshift", "rshift", "ctrl", "lctrl", "rctrl", "alt", "lalt", "ralt",
    "cmd", "lcmd", "rcmd", "meta", "win", "capslock",
))
MAX_BYTES_PER_PUMP = 2 * 1024 * 1024  # across all clients; a 2 MB webSocketSendBinary costs ~5-10 ms in TD
MAX_TEST_BODY = 64 * 1024
MODULE_CHECK_S = 1.0
LOOPBACK = ("127.0.0.1", "::1", "[::1]", "localhost")
CONVERT_BUDGET_S = 0.004  # input -> wire conversion time per pump
STATUS_PERIOD_S = 0.25
LOG_PER_SECOND = 20
STAT_WINDOW = 300


def _guard(fn):
    """Contain exceptions: report once per distinct message, never raise into TD."""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        try:
            return fn(self, *args, **kwargs)
        except Exception as e:  # noqa: BLE001 - containment is the point
            self._report(fn.__name__, e)
            return None
    return wrapper


class _Client:
    __slots__ = ("id", "kind", "ready", "active", "seq")

    def __init__(self, cid):
        self.id = cid
        self.kind = "unknown"
        self.ready = False
        self.active = False
        self.seq = 0


class _Frame:
    """A banded frame, encoded lazily once and shared by every client that receives it."""
    __slots__ = ("_gen", "msgs", "buf")

    def __init__(self, gen, buf):
        self._gen = gen
        self.msgs = []
        self.buf = buf  # the wire image the bands are sliced from (must not be overwritten while sending)

    def get(self, i):
        while len(self.msgs) <= i:
            m = next(self._gen, None)
            if m is None:
                return None
            self.msgs.append(m)
        return self.msgs[i]


def _median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


class RasterEditorExt:
    def __init__(self, ownerComp):
        self.o = ownerComp
        self._now = time.perf_counter
        self.pump_count = 0
        self._open_url = None  # test seam; defaults to TD's ui.viewFile
        self.test_result = None
        self._seen_errors = set()
        self.last_error = None
        self._started = False
        self._load_modules()
        self._reset_state()
        self.stats = {k: collections.deque(maxlen=STAT_WINDOW) for k in ("pump", "paste", "cook", "convert", "send", "readback")}

    # ------------------------------------------------------------------ setup / lifecycle

    def _load_modules(self):
        self.protocol = self.o.op("protocol").module
        self.frames = self.o.op("frames").module
        self.converter = self.frames.WireConverter()

    def _reset_state(self):
        self.token = secrets.token_urlsafe(16)  # per start; required in `ready`, carried in the panel URL
        self.clients = {}
        self.active_id = None
        self._seq = 0
        self._panel_seen = False
        self.doc_w = 0
        self.doc_h = 0
        self.has_input = False
        self.buffer = None  # uint8 [h, w, 4], TD order (bottom row first)
        self.dirty = False
        self.got_composite = False
        self._base_wire = None
        self._jobs = {}  # client id -> [frame being sent, next band index, queued next frame or None]
        self._wire_bufs = [None, None]
        self._wire_i = 0
        self._issued_cooks = None
        self._move_pending = False
        self._module_check_at = 0.0
        self._frame_id = 0
        self._input_cooks = None
        self._input_pending = False
        self._readback_issued = False
        self._last_input_start = -1e9
        self._conv = None
        self._buttons = {"lselect": False, "mselect": False, "rselect": False}
        self._reload_at = None
        self._wr_cooks = None
        self._status_at = 0.0
        self._status = None
        self._out_times = collections.deque(maxlen=64)
        self._logged_bad_frames = collections.deque(maxlen=8)
        self._log_window = (0.0, 0)

    def _p(self, name):
        return getattr(self.o.par, name).eval()

    def _op(self, name):
        return self.o.op(name)

    @_guard
    def Start(self):
        """(Re)start: reset state, bring the server and the panel up. Idempotent."""
        self._close_all_sockets()
        self._load_modules()
        self._reset_state()
        self._started = True
        self._apply_active()

    @_guard
    def Stop(self):
        self._close_all_sockets()
        self.clients.clear()
        self.active_id = None
        self._started = False
        self._op("webserver").par.active = 0

    def _close_all_sockets(self):
        ws = self._op("webserver")
        try:
            conns = list(ws.webSocketConnections)
        except Exception:  # noqa: BLE001 - server may be down
            conns = []
        for c in conns:
            try:
                ws.webSocketClose(c)
            except Exception:  # noqa: BLE001
                pass

    def _apply_active(self):
        ws = self._op("webserver")
        wr = self._op("webrender")
        if self._p("Active"):
            ws.par.port = self._p("Port")
            ws.par.active = 1
            wr.par.active = 1
            self._set_panel_url()
            self._reload_at = self._now() + 0.5
        else:
            ws.par.active = 0
            wr.par.active = 0
            self.clients.clear()
            self.active_id = None
            self._jobs.clear()
            self.got_composite = False
            self._op("out_switch").par.index = 0  # passthrough while the editor is off
        self._status_at = 0.0

    def _panel_url(self):
        port = self._p("Port")
        dev = (self._p("Devurl") or "").strip()
        extra = (self._p("Panelquery") or "").strip().lstrip("?&")
        if dev:
            url = dev + ("&" if "?" in dev else "?") + f"ws=ws://127.0.0.1:{port}/ws&client=panel"
        else:
            url = f"http://127.0.0.1:{port}/?client=panel"
        url += f"&token={self.token}"
        return url + ("&" + extra if extra else "")

    def _browser_url(self):
        """URL for an external browser tab (same token, client=external)."""
        port = self._p("Port")
        extra = (self._p("Panelquery") or "").strip().lstrip("?&")
        return f"http://127.0.0.1:{port}/?client=external&token={self.token}" + ("&" + extra if extra else "")

    def _token_ok(self, tok):
        return isinstance(tok, str) and hmac.compare_digest(tok.encode(), self.token.encode())

    def _test_enabled(self):
        q = parse_qs((self._p("Panelquery") or "").strip().lstrip("?&"))
        return q.get("test") == ["1"]

    def _set_panel_url(self):
        self._op("webrender").par.url = self._panel_url()

    # ------------------------------------------------------------------ parameters

    @_guard
    def OnParChange(self, par):
        name = par.name
        if name == "Active":
            if self._p("Active"):
                self.Start()
            else:
                self._close_all_sockets()
                self._apply_active()
        elif name in ("Port",):
            self._close_all_sockets()
            self.clients.clear()
            self.active_id = None
            self._jobs.clear()
            ws = self._op("webserver")
            ws.par.port = self._p("Port")
            ws.par.restart.pulse()
            self._set_panel_url()
            self._reload_at = self._now() + 0.5
        elif name in ("Devurl", "Panelquery"):
            self._set_panel_url()
            self._reload_at = self._now()
        elif name == "Reloadui":
            self._op("webrender").par.reloadsrc.pulse()
        elif name == "Openbrowser":
            self._view_url(self._browser_url())
        elif name == "Premultiplied":
            # Buffer content was converted for the old setting: have the editor resend a full
            # composite (re-activation does that) and resend the input with the new setting.
            self._conv = None
            self._base_wire = None
            self._jobs.clear()
            self._readback_issued = False
            self._input_pending = self.has_input
            self._send_to_active(self.protocol.active(True))
        # Docw/Doch are picked up by the pump; Maxsendfps/Maxinputfps are read on use.

    def _view_url(self, url):
        if self._open_url is not None:
            self._open_url(url)
        else:  # pragma: no cover - needs TD
            ui.viewFile(url)  # noqa: F821

    # ------------------------------------------------------------------ web server callbacks

    @staticmethod
    def _host_part(addr):
        """'127.0.0.1:80' -> '127.0.0.1'; '[::1]:80' -> '::1'; '::1' / '::ffff:127.0.0.1' unchanged."""
        a = str(addr).strip()
        if a.startswith("["):
            return a[1:].split("]", 1)[0]
        if a.count(":") == 1:
            return a.rsplit(":", 1)[0]
        return a

    @classmethod
    def _is_loopback(cls, addr, allow_name=False):
        """Fail closed: anything missing or unparsable is not loopback."""
        if not addr:
            return False
        host = cls._host_part(addr)
        if allow_name and host.lower() == "localhost":
            return True
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return False
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        return ip.is_loopback

    @classmethod
    def _host_ok(cls, request):
        """Host header (case-insensitive key) must be present and loopback: DNS-rebinding guard."""
        for k, v in request.items():
            if str(k).lower() == "host":
                return cls._is_loopback(v, allow_name=True)
        return False

    @staticmethod
    def _reply(response, code, reason, data="", ctype="text/plain; charset=utf-8"):
        response["statusCode"] = code
        response["statusReason"] = reason
        response["content-type"] = ctype
        response["data"] = data
        return response

    @_guard
    def OnHTTPRequest(self, request, response):
        if not self._is_loopback(request.get("clientAddress")) or not self._host_ok(request):
            return self._reply(response, 403, "Forbidden", "forbidden")
        path = request.get("uri", "/")
        method = request.get("method")
        if method == "POST" and path == "/__test" and self._test_enabled() \
                and self._token_ok((request.get("pars") or {}).get("token")):
            # Validation back-channel: the page (with ?test=1) posts values it cannot return
            # through executeJavaScript, e.g. screen coordinates of document points.
            data = request.get("data", b"")
            if len(data) > MAX_TEST_BODY:
                return self._reply(response, 413, "Payload Too Large", "too large")
            self.test_result = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
            return self._reply(response, 204, "No Content")
        if method == "GET" and path in ("/", "/index.html"):
            html = self._op("ui_html").text
            if html:
                response["Cache-Control"] = "no-store"
                return self._reply(response, 200, "OK", html, "text/html; charset=utf-8")
        return self._reply(response, 404, "Not Found", "not found")

    @_guard
    def OnWebSocketOpen(self, client, uri=""):
        path = uri.split("?", 1)[0]
        if path != "/ws" or not self._is_loopback(client):
            self._op("webserver").webSocketClose(client)
            return
        self.clients[client] = _Client(client)

    @_guard
    def OnWebSocketClose(self, client):
        c = self.clients.pop(client, None)
        if c is None:
            return
        self._jobs.pop(client, None)
        if self.active_id == client:
            self.active_id = None
            ready = [x for x in self.clients.values() if x.ready]
            if ready:
                self._set_active(max(ready, key=lambda x: x.seq).id)
        self._status_at = 0.0

    @_guard
    def OnWebSocketText(self, client, text):
        c = self.clients.get(client)
        if c is None:
            return
        try:
            msg = self.protocol.decode_json(text)
        except self.protocol.ProtocolError as e:
            self._send(client, self.protocol.error(str(e)))
            return
        t = msg["t"]
        if t == "ready":
            self._on_ready(c, msg)
        elif not c.ready:
            return
        elif t == "takeover":
            self._set_active(client)
        elif t == "requestBase":
            self._queue_base([client])
        elif t == "log":
            self._on_log(msg)
        # unknown message types are ignored (PROTOCOL.md)

    @_guard
    def OnWebSocketBinary(self, client, data):
        c = self.clients.get(client)
        if c is None or not c.ready or not c.active:
            return  # only the active editor may composite
        P = self.protocol
        try:
            hdr, payload = P.decode_frame(data)
        except P.ProtocolError as e:
            self._log_bad_frame(data, e)
            return
        if hdr.type != P.TYPE_COMPOSITE or P.is_stale(hdr, self.doc_w, self.doc_h) or self.buffer is None:
            return
        t0 = self._now()
        self.frames.paste_band(self.buffer, hdr.x, hdr.y, hdr.w, hdr.h, payload, bool(self._p("Premultiplied")))
        self.stats["paste"].append(self._now() - t0)
        if hdr.frame_end:
            self.dirty = True
            self.got_composite = True
            self._out_times.append(self._now())

    # ------------------------------------------------------------------ client management

    def _on_ready(self, c, msg):
        P = self.protocol
        if self.buffer is None:
            self._sync_doc_size()
        if not self._token_ok(msg.get("token")):
            self._send(c.id, P.error("bad or missing token (open the editor from the COMP's Open in Browser button)"))
            self._op("webserver").webSocketClose(c.id)
            self.clients.pop(c.id, None)
            return
        if msg.get("protocol") != P.PROTOCOL_VERSION:
            self._send(c.id, P.error(f"unsupported protocol {msg.get('protocol')!r}, server speaks {P.PROTOCOL_VERSION}"))
            self._op("webserver").webSocketClose(c.id)
            self.clients.pop(c.id, None)
            return
        kind = msg.get("client")
        c.kind = kind if kind in CLIENT_KINDS else "external"
        self._seq += 1
        c.seq = self._seq
        c.ready = True
        take = False
        if c.kind == "panel" and not self._panel_seen:
            take = True  # panel wins on first connect after a (re)start
        elif self.active_id is None:
            take = True
        if c.kind == "panel":
            self._panel_seen = True
        if take:
            self._demote_active()
            c.active = True
            self.active_id = c.id
        self._send(c.id, P.hello(self.doc_w, self.doc_h, self.has_input,
                                 self._p("Maxsendfps"), c.active))
        if self.has_input:
            self._queue_base([c.id])
        self._status_at = 0.0

    def _demote_active(self):
        prev = self.clients.get(self.active_id)
        if prev is not None and prev.active:
            prev.active = False
            self._send(prev.id, self.protocol.active(False))
        self.active_id = None

    def _set_active(self, cid):
        c = self.clients.get(cid)
        if c is None or not c.ready:
            return
        if self.active_id == cid:
            self._send(cid, self.protocol.active(True))  # re-sync: editor resends a full composite
            return
        self._demote_active()
        c.active = True
        self.active_id = cid
        self._send(cid, self.protocol.active(True))
        self._status_at = 0.0

    def _send(self, client, text):
        self._op("webserver").webSocketSendText(client, text)

    def _send_to_active(self, text):
        if self.active_id is not None:
            self._send(self.active_id, text)

    def _ready_ids(self):
        return [c.id for c in self.clients.values() if c.ready]

    def _on_log(self, msg):
        now = self._now()
        start, n = self._log_window
        if now - start >= 1.0:
            start, n = now, 0
        if n < LOG_PER_SECOND:
            print(f"[raster_editor web {msg.get('level', 'info')}] {msg.get('msg', '')}")
        self._log_window = (start, n + 1)

    def _log_bad_frame(self, data, err):
        # once per frameId (best effort: the id sits at bytes 8..12 if the message is that long)
        fid = bytes(memoryview(data)[8:12]) if len(data) >= 12 else None
        if fid in self._logged_bad_frames:
            return
        self._logged_bad_frames.append(fid)
        print(f"[raster_editor] dropped invalid frame: {err}")
        self.last_error = (f"invalid frame: {err}", self._now())

    # ------------------------------------------------------------------ pump (each frame start)

    def Pump(self):
        t0 = self._now()
        self.pump_count += 1
        try:
            self._pump(t0)
        except Exception as e:  # noqa: BLE001
            self._report("Pump", e)
        try:
            if t0 >= self._status_at:
                self._update_status(t0)
        except Exception as e:  # noqa: BLE001
            self._report("status", e)
        self.stats["pump"].append(self._now() - t0)

    def _pump(self, now):
        if not self._started:
            self.Start()
        if not self._p("Active"):
            return
        # Each step is isolated: a failure in one must not skip flushing, cooking or the switch.
        for name, step in (
                ("modules", lambda: self._check_modules(now)), ("reload", lambda: self._maybe_reload_panel(now)),
                ("panel", self._keep_panel_cooking), ("mouse", self._flush_mouse),
                ("doc", self._sync_doc_size), ("input", lambda: self._poll_input(now)),
                ("send", self._flush_jobs), ("cook", self._cook_composite), ("switch", self._update_switch)):
            try:
                step()
            except Exception as e:  # noqa: BLE001
                self._report(f"Pump/{name}", e)

    def _check_modules(self, now):
        """--dev file sync recompiles the protocol/frames DATs; pick up the new module objects."""
        if now < self._module_check_at:
            return
        self._module_check_at = now + MODULE_CHECK_S
        if self._op("protocol").module is not self.protocol or self._op("frames").module is not self.frames:
            self._load_modules()

    def _maybe_reload_panel(self, now):
        if self._reload_at is not None and now >= self._reload_at:
            self._reload_at = None
            self._op("webrender").par.reloadsrc.pulse()

    def _cook_composite(self):
        if self.dirty:
            t = self._now()
            self._op("composite").cook(force=True)
            self.stats["cook"].append(self._now() - t)

    def _update_switch(self):
        sw = self._op("out_switch")
        want = 1 if (self.got_composite or not self.has_input) else 0
        if sw.par.index.eval() != want:
            sw.par.index = want

    def _keep_panel_cooking(self):
        """A Web Render TOP that nothing pulls never loads its page or cooks again, so the
        editor would be dead whenever no viewer shows this COMP. If it did not cook since the
        last pump, force one (cheap: it only copies the latest browser frame)."""
        wr = self._op("webrender")
        if wr.totalCooks == self._wr_cooks:
            wr.cook(force=True)
        self._wr_cooks = wr.totalCooks

    def _sync_doc_size(self):
        has_input = len(self.o.inputs) > 0
        if has_input:
            top = self._op("in1")
            top.cook()
            w, h = int(top.width), int(top.height)
        else:
            w, h = int(self._p("Docw")), int(self._p("Doch"))
        w = max(1, min(w, 0xFFFF))
        h = max(1, min(h, 0xFFFF))
        if self.buffer is not None and (w, h, has_input) == (self.doc_w, self.doc_h, self.has_input):
            return
        buffer = self.frames.alloc_buffer(w, h)  # may raise: nothing is committed before it succeeds
        self.buffer = buffer
        self.doc_w, self.doc_h, self.has_input = w, h, has_input
        self.got_composite = False
        self.dirty = True  # push the blank buffer so the Script TOP takes the new size
        self._base_wire = None
        self._jobs.clear()
        self._conv = None
        self._readback_issued = False
        self._input_pending = has_input
        self._input_cooks = None
        msg = self.protocol.doc_size(w, h, has_input)
        for cid in self._ready_ids():
            self._send(cid, msg)
        self._status_at = 0.0

    # --- input -> clients

    def _poll_input(self, now):
        if not self.has_input:
            return
        top = self._op("in1")
        cooks = top.totalCooks
        if cooks != self._input_cooks:
            self._input_cooks = cooks
            self._input_pending = True
        if self._conv is not None:
            self._convert_some()
            return
        if not self._input_pending or not self._ready_ids():
            return
        period = 1.0 / max(1, self._p("Maxinputfps"))
        if now - self._last_input_start < period:
            return
        target = self._wire_bufs[self._wire_i ^ 1]
        if target is not None and self._buf_in_use(target):
            return  # an in-flight frame still reads from it; wait for the clients to finish
        # Two-step async readback: the first delayed call issues a GPU read, the next one
        # returns it (one frame latency, never a stall).
        t = self._now()
        arr = top.numpyArray(delayed=True)
        self.stats["readback"].append(self._now() - t)
        if not self._readback_issued:
            self._readback_issued = True
            self._issued_cooks = cooks
            return
        if arr is None:
            return
        self._readback_issued = False
        if tuple(arr.shape[:2]) != (self.doc_h, self.doc_w):
            return  # size is changing; _sync_doc_size will restart the pipeline
        # The image is what the input looked like when the read was issued; if it changed
        # since, another cycle is still owed.
        self._input_pending = top.totalCooks != self._issued_cooks
        self._last_input_start = now
        self._wire_i ^= 1
        out = self._wire_bufs[self._wire_i]
        if out is None or out.shape != arr.shape:
            out = self._wire_bufs[self._wire_i] = np.empty(arr.shape, np.uint8)
        self._conv = {"arr": arr, "out": out, "row": 0, "rows": 128}
        self._convert_some()

    def _convert_some(self):
        c = self._conv
        h = c["arr"].shape[0]
        start = self._now()
        unpre = bool(self._p("Premultiplied"))
        while c["row"] < h:
            r0 = c["row"]
            r1 = min(h, r0 + c["rows"])
            t = self._now()
            self.converter.convert_rows(c["arr"], c["out"], r0, r1, unpre)
            dt = self._now() - t
            c["row"] = r1
            if dt > 0:  # adapt the slice so each takes ~1/3 of the budget
                c["rows"] = max(16, int(c["rows"] * (CONVERT_BUDGET_S / 3) / dt))
            if self._now() - start >= CONVERT_BUDGET_S:
                break
        self.stats["convert"].append(self._now() - start)
        if c["row"] >= h:
            self._base_wire = c["out"]
            self._conv = None
            self._queue_base(self._ready_ids())

    def _queue_base(self, targets):
        """Queue a banded BASE frame of the cached input for ``targets``. A frame already being
        sent is always finished (so a client sees FRAME_END even when the input changes every
        frame); only one newer frame is kept waiting behind it, the newest wins."""
        if not self.has_input or not targets:
            return
        if self._base_wire is None:
            self._input_pending = True
            return
        P = self.protocol
        self._frame_id = (self._frame_id + 1) & 0xFFFFFFFF
        frame = _Frame(P.encode_frames(P.TYPE_BASE, self._frame_id, self.doc_w, self.doc_h,
                                       (0, 0, self.doc_w, self.doc_h), self._base_wire), self._base_wire)
        for cid in targets:
            job = self._jobs.get(cid)
            if job is None or job[1] == 0:
                self._jobs.pop(cid, None)  # nothing sent yet: replace outright (and requeue)
                self._jobs[cid] = [frame, 0, None]
            else:
                job[2] = frame

    def _buf_in_use(self, buf):
        return any(j[0].buf is buf or (j[2] is not None and j[2].buf is buf) for j in self._jobs.values())

    def _flush_jobs(self):
        """Send pending BASE bands, round-robin over clients, up to MAX_BYTES_PER_PUMP in total."""
        ws = self._op("webserver")
        budget = MAX_BYTES_PER_PUMP
        self._sent_this_pump = False
        t = self._now()
        while self._jobs:
            cid = next(iter(self._jobs))
            job = self._jobs[cid]
            frame, i = job[0], job[1]
            msg = frame.get(i) if cid in self.clients else None
            if msg is None:  # client gone, or its frame is complete
                nxt = job[2]
                del self._jobs[cid]
                if nxt is not None and cid in self.clients:
                    self._jobs[cid] = [nxt, 0, None]
                continue
            if self._sent_this_pump and len(msg) > budget:
                break  # always make progress, never exceed the budget by more than the first message
            ws.webSocketSendBinary(cid, msg)
            budget -= len(msg)
            self._sent_this_pump = True
            del self._jobs[cid]
            self._jobs[cid] = [frame, i + 1, job[2]]  # to the back of the queue
        if self._sent_this_pump:
            self.stats["send"].append(self._now() - t)

    # ------------------------------------------------------------------ Script TOP

    @_guard
    def OnCompositeCook(self, scriptOp):
        if self.buffer is not None:
            scriptOp.copyNumpyArray(self.buffer)
        self.dirty = False

    # ------------------------------------------------------------------ mouse / keyboard

    @_guard
    def OnPanelValue(self, panelValue, edge=None):
        """Panel Execute DAT -> Web Render TOP. ``edge`` is 1/0 for a button press/release
        (onOffToOn/onOnToOff) and None for plain value changes. Button state is tracked here
        from the edges because a fast click can change a button twice within one frame, when
        reading the panel's current value would miss the press. Pointer moves (u and v change
        separately) are coalesced into one interactMouse per frame; button edges first flush
        a pending move so ordering is preserved."""
        if not self._p("Active"):
            return
        name = panelValue.name
        if name in self._buttons:
            if edge is None:
                return  # handled through the edge callbacks
            self._flush_mouse()
            self._buttons[name] = bool(edge)
            self._send_mouse()
        elif name == "wheel":
            if panelValue.val:
                self._flush_mouse()
                p = self.o.panel
                self._op("webrender").interactMouse(p.u.val, p.v.val, wheel=panelValue.val)
        else:
            self._move_pending = True

    def _flush_mouse(self):
        if self._move_pending:
            self._send_mouse()

    def _send_mouse(self):
        self._move_pending = False
        p = self.o.panel
        self._op("webrender").interactMouse(p.u.val, p.v.val, left=self._buttons["lselect"],
                                            middle=self._buttons["mselect"], right=self._buttons["rselect"])

    @_guard
    def OnKey(self, keyInfo):
        if not self._p("Active") or not keyInfo.state:
            return
        key = keyInfo.key
        if key is None or str(key).lower() in MODIFIER_KEYS:
            return
        self._op("webrender").sendKey(key, char=keyInfo.character or None, shift=bool(keyInfo.shift),
                                      alt=bool(keyInfo.alt), ctrl=bool(keyInfo.ctrl), cmd=bool(keyInfo.cmd))

    # ------------------------------------------------------------------ status / diagnostics

    def _out_fps(self, now):
        return sum(1 for t in self._out_times if now - t <= 1.0)

    def _update_status(self, now):
        self._status_at = now + STATUS_PERIOD_S
        if not self._p("Active"):
            text = "inactive"
        else:
            act = self.clients.get(self.active_id)
            ready = [c for c in self.clients.values() if c.ready]
            size = f"{self.doc_w}×{self.doc_h}"
            if act is None:
                text = f"waiting for client · {size}"
            else:
                text = f"{act.kind} active · {size} · {self._out_fps(now)} fps out"
                if len(ready) > 1:
                    text += f" · {len(ready) - 1} standby"
        if self.last_error is not None and now - self.last_error[1] < 10.0:
            text += f" · ERROR {self.last_error[0]}"
        if text != self._status:
            self._status = text
            self.o.par.Status = text

    def GetStatus(self):
        return self._status or ""

    def GetStats(self):
        """Milliseconds: median / p95-ish worst over the last 300 samples."""
        out = {}
        for k, d in self.stats.items():
            xs = [x * 1000.0 for x in d]
            out[k] = {"n": len(xs), "median": _median(xs), "max": max(xs) if xs else 0.0}
        return out

    def _report(self, where, e):
        msg = f"{where}: {type(e).__name__}: {e}"
        self.last_error = (msg, self._now())
        self._status_at = 0.0
        if msg not in self._seen_errors and len(self._seen_errors) < 100:
            self._seen_errors.add(msg)
            print(f"[raster_editor] {msg}\n{traceback.format_exc()}")
