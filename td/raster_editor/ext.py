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
import json
import os
import re
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
MAX_TEST_BODY = 64 * 1024
MODULE_CHECK_S = 1.0
LOOPBACK_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOOPBACK = ("127.0.0.1", "::1", "[::1]", "localhost")
CONVERT_BUDGET_S = 0.004  # input / output -> wire conversion time per pump (per stream)
STALL_S = 10.0  # a client that has not fetched its last `base` / `view` notice for this long is 'stalled'
STATUS_PERIOD_S = 0.25
LOG_PER_SECOND = 20
STAT_WINDOW = 300
NET_RETRY_S = 1.0  # a network that failed to apply is retried this often
MISSING_TOP_S = 3.0  # a dirty slot without a Script TOP this long is dropped (with a report) so `applied` is not blocked
REPLAY_BUDGET_S = 0.004  # held messages replayed per pump after a restore
COOK_BUDGET_S = 0.004  # surface uploads per pump (at least one slot always goes)
HOLD_MAX_BYTES = 64 * 1024 * 1024  # tiles / docs held while a restore is pending
RESTORE_TRIES = 5
FROZEN_MAX_S = 2.0  # a Freeze() without a Thaw() this long ago is undone by the pump
DEFAULT_LAYER = {"id": "base", "kind": "base", "parentId": None, "name": "Background", "visible": True,
                 "opacity": 1, "blend": "normal", "x": 0, "y": 0, "slot": None, "mask": None, "adjustment": None}


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


class _Notice:
    """Per client and stream (base / view): the one un-fetched notice, newest frame fetched, stall flag."""
    __slots__ = ("outstanding", "sent_at", "stalled", "fetched")

    def __init__(self):
        self.outstanding = None  # frameId of the notice sent but not yet fetched
        self.sent_at = 0.0
        self.stalled = False
        self.fetched = None  # frameId of the newest frame this client has fetched

    def clear(self):
        self.outstanding = None
        self.fetched = None
        self.stalled = False


class _Client:
    __slots__ = ("id", "cid", "kind", "ready", "active", "seq", "fresh", "base", "view", "view_msg", "view_td",
                 "fid_pending", "fid_applied")

    def __init__(self, cid):
        self.id = cid  # socket peer string, used for webSocketSend*
        self.cid = secrets.token_hex(6)  # opaque id in `hello`, echoed by the client in GET /base etc.
        self.kind = "unknown"
        self.ready = False
        self.active = False
        self.seq = 0
        self.fresh = False
        self.base = _Notice()
        self.view = _Notice()
        self.view_msg = None  # last validated `view` message
        self.view_td = False  # external client subscribed to the VIEW stream
        self.fid_pending = None  # newest SURFACE frameId (FRAME_END) pasted from this client
        self.fid_applied = None  # newest one uploaded to its Script TOP (reported via `applied`)


class _Pipe:
    """One budgeted TOP -> wire stream: delayed GPU readback, incremental conversion, one immutable
    message served over HTTP (BASE from in1, VIEW from doc/out). State only; logic lives in the extension."""

    def __init__(self, name, mtype, stat):
        self.name, self.type, self.stat = name, mtype, stat
        self.frame_id = 0  # never reset: clients compare frame ids across restarts
        self.wire = None  # conversion scratch (reused); published messages are immutable copies
        self.reset()

    def reset(self):
        self.msg = None
        self.fid = None
        self.snap_by_fid = {}  # (view) applied frame id per client, as of the published frame
        self.cooks = None
        self.pending = False
        self.inflight = None  # (cooks, applied-snapshot) of the GPU read the next numpyArray call will return
        self.next_at = -1e9  # leaky bucket for the frame rate limit
        self.conv = None


def _median(xs):
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


class RasterEditorExt:
    def __init__(self, ownerComp):
        self.o = ownerComp
        self._now = time.perf_counter
        self.pump_count = 0
        self._open_url = None  # test seam; defaults to TD's ui.viewFile
        self._abs_frame = None  # test seam; defaults to TD's absTime.frame
        self._dump_fid = 0
        self._replace = os.replace  # test seam
        self.test_result = None
        self._seen_errors = set()
        self.last_error = None
        self._started = False
        self.base = _Pipe("base", 1, "")
        self.out = _Pipe("view", 5, "v")
        self._load_modules()
        self._reset_state()
        self.stats = {k: collections.deque(maxlen=STAT_WINDOW) for k in (
            "pump", "paste", "cook", "convert", "publish", "readback", "vconvert", "vpublish", "vreadback",
            "apply", "dump")}

    # ------------------------------------------------------------------ setup / lifecycle

    def _load_modules(self):
        self.protocol = self.o.op("protocol").module
        self.frames = self.o.op("frames").module
        self.converter = self.frames.WireConverter()
        self.base.type, self.out.type = self.protocol.TYPE_BASE, self.protocol.TYPE_VIEW

    def _reset_state(self):
        self.token = secrets.token_urlsafe(16)  # per start; required in `ready`, carried in the panel URL
        self.clients = {}
        self.active_id = None
        self._seq = 0
        self._panel_seen = False
        self.doc_w = 0
        self.doc_h = 0
        self.has_input = False
        self._sized = False
        # document: layer stack as last applied + a numpy buffer per surface slot (uint8 [h, w, 4], TD order =
        # bottom row first, premultiplied if `Premultiplied`; masks are grey with a = 255)
        self.doc_layers = None
        self.doc_rev = None
        self.surfaces = {}
        self._slot_set = frozenset()
        self._mask_slots = frozenset()  # mask surfaces: start white, grey on the wire
        self._stale_enc = set()  # slots still encoded for the previous `Premultiplied` setting (converted one per pump)
        self._held = []  # messages held while a restore is pending: ("doc", client, msg) / ("bin", client, data)
        self._held_bytes = 0
        self._overflowed = set()  # clients whose messages did not fit the hold queue: they reload after the restore
        self._cook_cursor = -1  # round robin over dirty slots
        self._missing_since = {}  # dirty slot -> first time it had no Script TOP
        self._carry_stale = set()
        self._waiters = []  # clients whose requestDoc waits for the restore
        self._restore_fail = 0
        self._restore_retry_at = 0.0
        self._frozen_at = 0.0
        self._saving = False
        self._dirty = set()  # slots whose buffer is newer than their Script TOP
        self._doc_state_dirty = False
        self._net_applied = False
        self._restore_pending = False
        self._net_retry_at = 0.0
        self._net_mod = None
        self.network = None
        self.frozen = False
        self.base.reset()
        self.out.reset()
        self._carry = {}
        self._panel_key = None
        self._panel_top = "webrender"
        self._module_check_at = 0.0
        self._move_pending = False
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

    def _opt(self, name):
        """An operator that older builds of the COMP do not have: None instead of an error."""
        try:
            return self.o.op(name)
        except KeyError:
            return None

    def _sync_pack(self):
        """Tell the view_pack shader whether the output is premultiplied (uCfg.x)."""
        pack = self._opt("view_pack")
        if pack is not None:
            pack.par.vec0valuex = 1.0 if self._p("Premultiplied") else 0.0

    @_guard
    def Start(self):
        """(Re)start: reset state, bring the server and the panel up, restore the stored document. Idempotent."""
        if self._doc_state_dirty:
            self._flush_doc_state()
        carry = self.surfaces  # a restart in a live session: Script TOPs are not locked, keep our pixels
        carry_stale = set(self._stale_enc)  # ...and which of them still wait for a Premultiplied re-encode
        self._close_all_sockets()
        self._load_modules()
        self._reset_state()
        self._carry = carry
        self._carry_stale = carry_stale
        self._started = True
        self._apply_active()
        if self._p("Active"):
            self._make_network()
            self._sync_pack()
            try:
                self.Restore()
            except Exception as e:  # noqa: BLE001 - a bad stored document must not keep the editor from starting
                self._report("Restore", e)
            self._sync_doc_size()
        if not self._restore_pending:
            self._carry, self._carry_stale = {}, set()

    @_guard
    def Stop(self):
        if self._doc_state_dirty:
            self._flush_doc_state()
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

    def _make_network(self):
        """Create the DocNetwork (network.py) over the COMP's `doc` container. Failure leaves network None:
        documents are still stored and served, the output stays the input passthrough."""
        self.network = None
        self._net_applied = False
        try:
            mod = self._op("network").module
            self.network = mod.DocNetwork(self.o, self._op("blend_glsl").text)
            self._net_mod = mod
        except Exception as e:  # noqa: BLE001
            self.network = None
            self._report("network", e)

    def _network_applied(self):
        """out_switch: input 0 = in1 passthrough, input 1 = `doc_out` (a Select TOP on doc/out, built by
        build_component: wires cannot cross into a child COMP). It is selected once a stack was applied."""
        self._net_applied = True
        if self._restore_pending and self._restore_fail == 0:
            self._finish_restore()

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
            self._op("out_switch").par.index = 0  # passthrough while the editor is off
            self._sync_panel_view()
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
        elif name == "Savetox":
            self.SaveTox(self._default_tox_path())
        elif name == "Premultiplied":
            # Buffers (and the stored input / output frames) were encoded for the old setting: surfaces are
            # re-encoded one per pump (_reencode_one); a slot's encoding is `Premultiplied xor (slot in _stale_enc)`.
            self._stale_enc = {sl for sl in self.surfaces if sl not in self._mask_slots} - self._stale_enc
            self._sync_pack()
            self._invalidate(self.base)
            self._invalidate(self.out)
        # Docw/Doch are picked up by the pump; Maxsendfps/Maxinputfps/Maxviewfps are read on use.

    def _view_url(self, url):
        if self._open_url is not None:
            self._open_url(url)
        else:  # pragma: no cover - needs TD
            ui.viewFile(url)  # noqa: F821

    def _default_tox_path(self):
        if self._open_url is not None:  # tests
            return "raster_editor_export.tox"
        return os.path.join(project.folder, "raster_editor_export.tox")  # noqa: F821  # pragma: no cover

    def _td_frame(self):
        if self._abs_frame is not None:
            return int(self._abs_frame())
        try:
            return int(absTime.frame)  # noqa: F821
        except NameError:
            return self.pump_count

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
        if method == "GET" and path == "/base":
            return self._serve_pipe(self.base, "base", request, response, subscribed_only=False)
        if method == "GET" and path == "/view":
            return self._serve_pipe(self.out, "view", request, response, subscribed_only=True)
        if method == "GET" and path == "/surface":
            return self._serve_surface(request, response)
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
        if self.active_id == client:
            self.active_id = None
            ready = [x for x in self.clients.values() if x.ready]
            if ready:
                self._set_active(max(ready, key=lambda x: x.seq).id)
        if c.kind == "panel":
            self._sync_panel_view()
        self._sync_viewmode()
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
            # Re-announce the stored frame. A notice may be outstanding because the client's fetch
            # failed (or it gave up): forget it, or the client would sit there until marked stalled.
            c.base.clear()
        elif t == "doc":
            self._on_doc(c, msg)
        elif t == "requestDoc":
            self._on_request_doc(c)
        elif t == "view":
            self._on_view(c, msg)
        elif t == "log":
            self._on_log(msg)
        # unknown message types are ignored (PROTOCOL.md)

    @_guard
    def OnWebSocketBinary(self, client, data, _replay=False):
        c = self.clients.get(client)
        if c is None or not c.ready or not c.active:
            return  # only the active editor may write surfaces
        if not _replay and (self._restore_pending or self._held):
            self._hold(client, ("bin", client, bytes(data)), len(data))
            return
        P = self.protocol
        try:
            hdr, payload = P.decode_frame(data)
        except P.ProtocolError as e:
            self._log_bad_frame(data, e)
            return
        if hdr.type != P.TYPE_SURFACE or P.is_stale(hdr, self.doc_w, self.doc_h):
            return
        buf = self.surfaces.get(hdr.slot)
        if buf is None or hdr.slot not in self._slot_set:
            return  # a slot that is not in the last `doc`
        t0 = self._now()
        self.frames.paste_band(buf, hdr.x, hdr.y, hdr.w, hdr.h, payload, self._slot_premult(hdr.slot))
        self.stats["paste"].append(self._now() - t0)
        if hdr.frame_end:
            self._dirty.add(hdr.slot)
            c.fid_pending = hdr.frame_id
            self._out_times.append(self._now())

    # ------------------------------------------------------------------ client management

    def _on_ready(self, c, msg):
        P = self.protocol
        if not self._sized:
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
        c.fresh = bool(msg.get("fresh"))
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
        self._send(c.id, P.hello(self.doc_w, self.doc_h, self.has_input, self._p("Maxsendfps"), c.active, c.cid,
                                 self.doc_layers is not None, self.doc_rev))
        self._sync_viewmode()
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
            self._send(cid, self.protocol.active(True))  # re-sync
            return
        self._demote_active()
        c.active = True
        self.active_id = cid
        self._send(cid, self.protocol.active(True))
        self._sync_viewmode()
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
        self._status_at = 0.0

    # ------------------------------------------------------------------ document

    def _slot_premult(self, slot):
        """Is this slot's buffer currently stored premultiplied? (`Premultiplied`, unless it still waits for its
        re-encode after a toggle.)"""
        return bool(self._p("Premultiplied")) != (slot in self._stale_enc)

    def _hold(self, client, item, size):
        """While a restore waits for the network the Script TOPs hold the only copy of the pixels: tiles and docs
        that arrive are kept (in order) and replayed afterwards. A client that overflows the queue gets an error
        and none of its further messages are held; after the restore it is told to reload from TD."""
        if client in self._overflowed:
            return
        if self._held_bytes + size > HOLD_MAX_BYTES:
            self._overflowed.add(client)
            self._report("restore", RuntimeError("too many messages held while restoring; client will reload"))
            self._send(client, self.protocol.error("TouchDesigner is still restoring the document; reloading it"))
            return
        self._held.append(item)
        self._held_bytes += size

    def _on_doc(self, c, msg, _replay=False):
        if not c.active:
            return  # standby clients cannot edit
        if not _replay and (self._restore_pending or self._held):
            self._hold(c.id, ("doc", c.id, msg), 1024)
            return
        try:
            rev, layers = self.protocol.parse_doc(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad doc: {e}"))
            return
        self._apply_doc(rev, layers)

    def _apply_doc(self, rev, layers):
        """Apply a layer stack: allocate / revive the surface buffers it names, diff-apply it to the generated
        network, remember it (stored to `doc_state` in the next pump)."""
        t0 = self._now()
        P = self.protocol
        slots = P.layer_slots(layers)
        masks = frozenset(P.mask_slots(layers))
        # buffers first: a failed allocation leaves the previous document untouched. A slot that was not in the
        # previously applied doc always starts blank (masks white): the engine resends pixels itself when a slot
        # legitimately reappears.
        fresh = {s: self.frames.alloc_buffer(self.doc_w, self.doc_h, s in masks) for s in slots if s not in self._slot_set}
        before = set(self.network.slots()) if self.network is not None else set()
        if self.network is not None and (layers != self.doc_layers or not self._net_applied):
            self.network.apply(layers, self.doc_w, self.doc_h)
            self._network_applied()
        self.surfaces.update(fresh)
        for s in [s for s in self.surfaces if s not in slots]:
            del self.surfaces[s]
            self._dirty.discard(s)
            self._stale_enc.discard(s)
        for s in fresh:
            self._stale_enc.discard(s)
        self._slot_set = frozenset(slots)
        self._mask_slots = masks
        if self.network is not None:
            self._dirty.update(set(self.network.slots()) - before)  # new Script TOPs need their pixels
        self._dirty.update(fresh)
        self.doc_layers = layers
        self.doc_rev = rev
        self._doc_state_dirty = True
        self.stats["apply"].append(self._now() - t0)
        self._status_at = 0.0

    def _on_request_doc(self, c):
        if self.doc_layers is None:
            return
        if self._restore_pending or self._held:  # not before the pixels are back: the client fetches the surfaces right after
            if c.id not in self._waiters:
                self._waiters.append(c.id)
            return
        self._send(c.id, self.protocol.doc_state(self.doc_rev, self.doc_layers, self.doc_w, self.doc_h))

    def _flush_doc_state(self):
        if self.doc_layers is None:
            self._doc_state_dirty = False
            return
        self._op("doc_state").text = self.protocol.encode_json(
            {"rev": self.doc_rev, "layers": self.doc_layers})
        self._doc_state_dirty = False

    def _read_doc_state(self):
        text = self._op("doc_state").text
        if not text or not text.strip():
            return None
        data = json.loads(text)
        rev, layers = self.protocol.parse_doc({"rev": data.get("rev"), "layers": data.get("layers")})
        return rev, layers

    def _reencode_one(self):
        """After a `Premultiplied` toggle: re-encode one stale surface per pump and upload it again."""
        if not self._stale_enc:
            return
        slot = min(self._stale_enc)
        self._stale_enc.discard(slot)
        buf = self.surfaces.get(slot)
        if buf is not None:
            self.frames.convert_premultiplication(buf, bool(self._p("Premultiplied")))
            self._dirty.add(slot)

    def _cook_surfaces(self):
        """Upload dirty slots (round robin from after the last one cooked, so a continuous stroke on one slot cannot
        starve the others): forcing the Script TOP's cook runs OnSurfaceCook, which copies the buffer. Called once per
        pump, so several tiles / frames in one TD frame cost one upload per slot. A slot whose Script TOP does not
        exist for MISSING_TOP_S is dropped with a report, so `applied` is never blocked for good."""
        if not self._dirty or self._restore_pending:
            return  # (while a restore waits for the network, the TOPs hold the only copy of the pixels)
        t = self._now()
        done = []
        order = sorted(self._dirty)
        k = next((i for i, sl in enumerate(order) if sl > self._cook_cursor), 0)
        for slot in order[k:] + order[:k]:
            if slot not in self._slot_set:
                done.append(slot)
                continue
            top = self.network.surface_top(slot) if self.network is not None else None
            if top is None:
                since = self._missing_since.setdefault(slot, t)
                if t - since > MISSING_TOP_S:
                    self._report("cook", RuntimeError(f"surface s{slot} has no Script TOP; dropped its pending upload"))
                    done.append(slot)
                continue  # the network has not created it (yet); retried next pump
            self._missing_since.pop(slot, None)
            try:
                top.cook(force=True)
            except Exception as e:  # noqa: BLE001
                self._report(f"cook s{slot}", e)
            done.append(slot)
            self._cook_cursor = slot
            if self._now() - t >= COOK_BUDGET_S:
                break  # the rest follows next pump (first-time 1080p uploads are ~0.5 ms each)
        self._dirty.difference_update(done)
        for sl in done:
            self._missing_since.pop(sl, None)
        self.stats["cook"].append(self._now() - t)
        if not self._dirty:
            self._report_applied()

    def _report_applied(self):
        """`applied` (<= once per TD frame per client, only when it changed): the newest SURFACE frameId of the
        client that is now in the Script TOPs."""
        frame = None
        for c in self.clients.values():
            if c.ready and c.fid_pending is not None and c.fid_pending != c.fid_applied:
                c.fid_applied = c.fid_pending
                if frame is None:
                    frame = self._td_frame()
                self._send(c.id, self.protocol.applied(c.fid_applied, frame))

    def _write_surface(self, top):
        """Copy a slot's persistent buffer into its Script TOP (not guarded: Freeze needs the failures)."""
        slot = int(top.name[1:])
        buf = self.surfaces.get(slot)
        if buf is not None:
            top.copyNumpyArray(buf)
        self._dirty.discard(slot)

    @_guard
    def OnSurfaceCook(self, scriptOp):
        """Callback of every surface Script TOP (`s<slot>`): output the slot's buffer on EVERY cook (unlocking a
        TOP recooks it from the callbacks; dirty only decides whether the pump forces a cook)."""
        self._write_surface(scriptOp)

    # ------------------------------------------------------------------ persistence

    def Freeze(self):
        """Before the project / component is saved: lock every surface Script TOP with its current buffer so the
        pixels are stored in the file. Pair with Thaw(). Verifies every slot; on any failure the locks taken are
        released again and the error is raised (a half frozen save would store blank images). While a restore is
        pending the locked images ARE the document: nothing is written and nothing is unlocked."""
        if self._restore_pending:
            print("[raster_editor] WARNING: the document is still being restored; its locked pixels are saved as they are")
            return
        while self._stale_enc:  # buffers still in the previous Premultiplied encoding
            self._reencode_one()
        if self._doc_state_dirty:
            self._flush_doc_state()
        locked = []
        try:
            if self.network is not None:
                for slot in sorted(self._slot_set):
                    top = self.network.surface_top(slot)
                    if top is None:
                        raise RuntimeError(f"surface s{slot} has no Script TOP")
                    if not top.lock:
                        top.lock = True  # resets the locked image: write the buffer right after
                        locked.append(top)
                    self._write_surface(top)
                    if (int(top.width), int(top.height)) != (self.doc_w, self.doc_h):
                        raise RuntimeError(f"s{slot} holds {top.width}x{top.height}, document is {self.doc_w}x{self.doc_h}")
        except Exception:
            for top in locked:
                try:
                    top.lock = False
                except Exception:  # noqa: BLE001
                    pass
            raise
        self.frozen = True
        self._frozen_at = self._now()

    def Thaw(self):
        if self._restore_pending:
            return  # still locked on purpose, see Freeze
        if self.network is not None:
            self.network.thaw()
        self.frozen = False

    def SaveTox(self, path):
        """Export the COMP (document + pixels included) to ``path`` (written to a temp file, then renamed).
        Never saves the project."""
        path = str(path)
        if self._restore_pending:
            raise RuntimeError("the document is still being restored from the locked surfaces; SaveTox refused")
        tmp = (path[:-4] if path.endswith(".tox") else path) + ".part.tox"
        self._saving = True
        try:
            self.Freeze()
            try:
                self.o.save(tmp)
            finally:
                self.Thaw()
            self._replace(tmp, path)
        finally:
            self._saving = False
        return path

    def OnProjectSave(self, before):
        """Execute DAT onProjectPreSave / PostSave. Never raises into TD's save; a failed Freeze leaves nothing locked."""
        try:
            if before:
                self.Freeze()
            else:
                self.Thaw()
        except Exception as e:  # noqa: BLE001
            self._report("project save " + ("freeze" if before else "thaw"), e)
            if before:
                print("[raster_editor] WARNING: surface pixels were NOT locked; they will be missing from the saved file")

    def _check_frozen(self, now):
        """Safety net: a missed post-save leaves the TOPs locked (output stale, uploads ignored)."""
        if self.frozen and not self._saving and now - self._frozen_at > FROZEN_MAX_S:
            self._report("Freeze", RuntimeError("surfaces were left frozen; thawing"))
            self.Thaw()

    def Restore(self):
        """Rebuild the network from `doc_state` and read each surface's pixels back from its (locked) Script
        TOP into the numpy buffers, then unlock. Only valid right after Start (before the document size is
        known). Returns True if a stored document was restored (the pixels may follow with the network's first
        successful apply)."""
        if self._sized:
            return False
        stored = self._read_doc_state()
        if stored is None:
            return False
        rev, layers = stored
        self._restore_pending = True
        self.doc_layers, self.doc_rev = layers, rev
        self._slot_set = frozenset(self.protocol.layer_slots(layers))
        self._mask_slots = frozenset(self.protocol.mask_slots(layers))
        self._sync_doc_size()  # allocates the buffers and applies the network once
        if self._restore_pending and self._net_applied:  # (else the first successful apply finishes it)
            self._finish_restore()
        self._doc_state_dirty = False
        return True

    def _finish_restore(self):
        """Pixels from the locked Script TOPs into the buffers (or from the pre-restart buffers), then unlock.
        A failed read keeps everything locked and is retried (the locked images are the only copy)."""
        try:
            locked = self.network.read_locked()
        except Exception as e:  # noqa: BLE001
            self._restore_fail += 1
            self._report("Restore read", e)
            if self._restore_fail < RESTORE_TRIES:
                self._restore_retry_at = self._now() + 1.0
                return
            locked = {}  # give up: continue with blank / carried buffers
        try:
            restored = set()
            for slot in list(locked):
                arr = locked.pop(slot)  # one float32 copy alive at a time
                if slot in self.surfaces:
                    self.surfaces[slot] = self.frames.from_float(arr, self.doc_w, self.doc_h, slot in self._mask_slots)
                    self._dirty.add(slot)
                    restored.add(slot)
                del arr
            for slot in self.surfaces:
                if slot in self._carry and slot not in restored:
                    buf = self.frames.resize_buffer(self._carry[slot], self.doc_w, self.doc_h, slot in self._mask_slots)
                    if slot in self._carry_stale:  # it still waited for a Premultiplied re-encode
                        self.frames.convert_premultiplication(buf, bool(self._p("Premultiplied")))
                    self.surfaces[slot] = buf
                    self._dirty.add(slot)
        finally:
            self.network.thaw()  # a TOP left locked would ignore every upload
            self.frozen = False
            self._restore_pending = False
        self._carry, self._carry_stale = {}, set()
        self._replay_step()

    def _replay_step(self):
        """Replay the held messages in order, a few ms per pump; when the queue is empty answer the waiting
        requestDocs and tell clients that overflowed to reload (active false -> true makes the page load TD's document)."""
        if self._restore_pending:
            return
        t = self._now()
        while self._held:
            kind, cid, payload = self._held.pop(0)
            if kind == "doc":
                c = self.clients.get(cid)
                if c is not None:
                    self._on_doc(c, payload, _replay=True)
            else:
                self._held_bytes -= len(payload)
                self.OnWebSocketBinary(cid, payload, _replay=True)
            if self._now() - t >= REPLAY_BUDGET_S:
                return
        self._held_bytes = 0
        waiters, self._waiters = self._waiters, []
        for cid in waiters:
            c = self.clients.get(cid)
            if c is not None:
                self._on_request_doc(c)
        over, self._overflowed = self._overflowed, set()
        for cid in over:
            if cid in self.clients:
                self._send(cid, self.protocol.active(False))
                self._send(cid, self.protocol.active(True))

    # ------------------------------------------------------------------ viewport (view messages)

    def _on_view(self, c, msg):
        try:
            view = self.protocol.parse_view(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad view: {e}"))
            return
        c.view_msg = view
        if c.kind == "panel":
            self._sync_panel_view()
        elif c.kind == "external":
            sub = view["mode"] == "td"
            if sub and not c.view_td:
                c.view.clear()  # re-announce the stored frame (if any), clear any stall
                if self.out.msg is None:
                    self.out.pending = True
            c.view_td = sub
        self._sync_viewmode()
        self._status_at = 0.0

    def _sync_viewmode(self):
        act = self.clients.get(self.active_id)
        mode = act.view_msg["mode"] if act is not None and act.view_msg else "local"
        if self._p("Viewmode") != mode:
            self.o.par.Viewmode = mode

    def _panel_client(self):
        panels = [c for c in self.clients.values() if c.ready and c.kind == "panel"]
        return max(panels, key=lambda c: c.seq) if panels else None

    def _sync_panel_view(self):
        """The panel client's TD-view overlay: DocNetwork.set_view + the COMP background switch."""
        pc = self._panel_client()
        view = pc.view_msg if pc is not None and pc.view_msg and pc.view_msg["mode"] == "td" else None
        if view is not None and not self._p("Active"):
            view = None
        pw, ph = int(self.o.par.w.eval()), int(self.o.par.h.eval())
        key = (json.dumps(view, sort_keys=True), pw, ph, self.doc_w, self.doc_h)
        if key == self._panel_key or self.network is None:
            return
        self.network.set_view(view, pw, ph)
        top = self._rel_path(self.network.panel_view()) if view is not None else "./webrender"
        if top != self._panel_top:
            self.o.par.top = top
            self._panel_top = top
        # (webrender.transparent stays on permanently: toggling it makes the Web Render TOP reload its page)
        self._panel_key = key  # only after everything worked: a failure is retried by the next pump

    def _rel_path(self, top):
        p, base = str(top.path), str(self.o.path) + "/"
        return "./" + p[len(base):] if p.startswith(base) else p

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
        # Order matters: the output readback is issued before this pump's uploads, so the `appliedFrameId`
        # snapshot taken with it only names frames that were already uploaded.
        for name, step in (
                ("modules", lambda: self._check_modules(now)), ("reload", lambda: self._maybe_reload_panel(now)),
                ("panel", self._keep_panel_cooking), ("mouse", self._flush_mouse),
                ("doc", self._sync_doc_size), ("panelview", self._sync_panel_view),
                ("input", lambda: self._poll_base(now)), ("output", lambda: self._poll_view(now)),
                ("notify", lambda: self._notify_clients(now)), ("surfaces", self._cook_surfaces),
                ("replay", self._replay_step), ("reencode", self._reencode_one), ("frozen", lambda: self._check_frozen(now)), ("network", lambda: self._tick_network(now)), ("docstate", self._flush_if_dirty),
                ("switch", self._update_switch)):
            try:
                step()
            except Exception as e:  # noqa: BLE001
                self._report(f"Pump/{name}", e)

    def _check_modules(self, now):
        """--dev file sync recompiles the python DATs; pick up the new module objects."""
        if now < self._module_check_at:
            return
        self._module_check_at = now + MODULE_CHECK_S
        if self._op("protocol").module is not self.protocol or self._op("frames").module is not self.frames:
            self._load_modules()
        if self.network is not None and self._op("network").module is not self._net_mod:
            self._make_network()
            if self.network is not None and self._sized:
                self._net_applied = False
                self._apply_network()
                self._dirty.update(self.surfaces)
                self._panel_key = None

    def _maybe_reload_panel(self, now):
        if self._reload_at is not None and now >= self._reload_at:
            self._reload_at = None
            self._op("webrender").par.reloadsrc.pulse()

    def _tick_network(self, now):
        if self._restore_pending and self._net_applied and now >= self._restore_retry_at:
            self._restore_retry_at = now + 1.0
            self._finish_restore()
        if self.network is not None and not self._net_applied and self._sized and now >= self._net_retry_at:
            self._net_retry_at = now + NET_RETRY_S  # a failed apply (e.g. at start) is retried, not forgotten
            self._apply_network()
            self._dirty.update(self.network.slots())
        tick = getattr(self.network, "tick", None)
        if tick is not None:
            tick()  # destroys surfaces whose grace expired, keeps the spare GLSL pool topped up

    def _flush_if_dirty(self):
        if self._doc_state_dirty:
            self._flush_doc_state()

    def _update_switch(self):
        sw = self._op("out_switch")
        want = 1 if (self.network is not None and self._net_applied) else 0
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

    def _apply_network(self):
        if self.network is None:
            return
        t = self._now()
        layers = self.doc_layers if self.doc_layers is not None else [dict(DEFAULT_LAYER)]
        self.network.apply(layers, self.doc_w, self.doc_h)
        self._network_applied()
        self.stats["apply"].append(self._now() - t)

    def _sync_doc_size(self):
        has_input = len(self.o.inputs) > 0
        if has_input:
            top = self._op("in1")
            top.cook()
            w, h = int(top.width), int(top.height)
            if (w < 1 or h < 1) and self._sized:
                return  # the input reports 0x0 while it (re)starts: keep the document as it is
        else:
            w, h = int(self._p("Docw")), int(self._p("Doch"))
        w = max(1, min(w, 0xFFFF))
        h = max(1, min(h, 0xFFFF))
        if self._sized and (w, h, has_input) == (self.doc_w, self.doc_h, self.has_input):
            return
        first = not self._sized
        # reallocate every surface, anchored top-left; may raise: nothing is committed before it succeeds
        surfaces = {s: self.frames.resize_buffer(self.surfaces.get(s), w, h, s in self._mask_slots)
                    for s in set(self.surfaces) | self._slot_set}
        self.surfaces = surfaces
        self.doc_w, self.doc_h, self.has_input = w, h, has_input
        self._sized = True
        self._dirty = set(surfaces)  # push the (resized) buffers so the Script TOPs take the new size
        self._invalidate(self.base)
        self._invalidate(self.out)
        self.base.pending = has_input
        self._panel_key = None
        if not first:
            msg = self.protocol.doc_size(w, h, has_input)
            for cid in self._ready_ids():
                self._send(cid, msg)
        flag = getattr(self.network, "set_input_connected", None)
        if flag is not None:
            flag(has_input)
        self._apply_network()
        self._status_at = 0.0

    # --- TOP -> clients (BASE from in1, VIEW from doc/out): shared budgeted pipeline

    def _poll_pipe(self, pipe, top, now, period, wanted, packed=False):
        """Change detection, rate limit, two-step async readback (the first delayed call issues a GPU read,
        the next returns it: one frame of latency, never a stall) and incremental conversion."""
        cooks = top.totalCooks
        if cooks != pipe.cooks:
            pipe.cooks = cooks
            pipe.pending = True
        if pipe.conv is not None:
            self._convert_some(pipe)
            return
        if not wanted or not (pipe.pending or pipe.inflight is not None) or now < pipe.next_at:
            return
        # One delayed call both returns the read issued by the previous call and issues a new one, so a steady
        # stream costs one call per frame. When nothing changed since, the read it issued is redundant and is
        # ignored by the next call (inflight None).
        t = self._now()
        arr = top.numpyArray(delayed=True)
        self.stats[pipe.stat + "readback"].append(self._now() - t)
        prev = pipe.inflight
        if pipe.pending:
            pipe.inflight = (cooks, {c.cid: c.fid_applied for c in self.clients.values()})
            pipe.pending = False
        else:
            pipe.inflight = None
        if prev is None:
            return
        if arr is None:
            pipe.pending = True  # no result available yet: ask again next frame
            return
        if tuple(arr.shape[:2]) != (self.doc_h, self.doc_w):
            return  # size is changing; _sync_doc_size restarts the pipeline
        pipe.next_at = max(pipe.next_at + period, now - period / 2)
        out = pipe.wire
        if out is None or out.shape != arr.shape:
            out = pipe.wire = np.empty(arr.shape, np.uint8)  # safe to reuse: publishing copies it
        pipe.conv = {"arr": arr, "out": out, "row": 0, "rows": 128, "snap": prev[1], "packed": packed}
        self._convert_some(pipe)

    def _poll_base(self, now):
        if not self.has_input:
            return
        top = self._op("in1")
        period = 1.0 / max(1, self._p("Maxinputfps"))
        self._poll_pipe(self.base, top, now, period, bool(self._ready_ids()))

    def _view_subscribers(self):
        return [c for c in self.clients.values() if c.ready and c.view_td]

    def _poll_view(self, now):
        subs = self._view_subscribers()
        if not subs or self.network is None or not self._net_applied:
            if not subs and (self.out.msg is not None or self.out.conv is not None or self.out.inflight is not None):
                self.out.reset()  # nobody watches: free the frame, the next subscriber gets a fresh one
            return
        pack = self._opt("view_pack")  # GPU: unpremultiply + flip + scale to 0..255 (CPU then only casts)
        top = pack if pack is not None else self.network.output()
        top.cook()
        period = 1.0 / max(1, self._p("Maxviewfps"))
        self._poll_pipe(self.out, top, now, period, True, packed=pack is not None)

    def _convert_some(self, pipe):
        c = pipe.conv
        h = c["arr"].shape[0]
        start = self._now()
        unpre = bool(self._p("Premultiplied"))
        while c["row"] < h:
            r0 = c["row"]
            r1 = min(h, r0 + c["rows"])
            t = self._now()
            if c["packed"]:
                self.converter.copy_rows(c["arr"], c["out"], r0, r1)
            else:
                self.converter.convert_rows(c["arr"], c["out"], r0, r1, unpre)
            dt = self._now() - t
            c["row"] = r1
            if dt > 0:  # adapt the slice so each takes ~1/3 of the budget
                c["rows"] = max(16, int(c["rows"] * (CONVERT_BUDGET_S / 3) / dt))
            if self._now() - start >= CONVERT_BUDGET_S:
                break
        self.stats[pipe.stat + "convert"].append(self._now() - start)
        if c["row"] >= h:
            pipe.conv = None
            self._publish(pipe, c["out"], c["snap"])

    def _invalidate(self, pipe):
        """The stored frame is no longer valid (resize, Premultiplied toggle): drop it and every client's
        notice bookkeeping, so each client is notified again when the next one is ready.
        The frame id counter is deliberately never reset: fetched / outstanding comparisons rely on it."""
        pipe.reset()
        pipe.pending = True
        for c in self.clients.values():
            (c.base if pipe is self.base else c.view).clear()

    def _publish(self, pipe, wire, snap):
        """Store the converted image as the newest frame of the stream: one immutable message that
        GET /base | /view serve from TD's HTTP thread (never touched again, so no aliasing). One copy."""
        t = self._now()
        P = self.protocol
        pipe.frame_id = (pipe.frame_id + 1) & 0xFFFFFFFF
        hdr = P.Header(pipe.type, P.FLAG_FRAME_END, pipe.frame_id, self.doc_w, self.doc_h, 0, 0, self.doc_w, self.doc_h)
        pipe.msg = P.encode_message(hdr, wire)
        pipe.fid = pipe.frame_id
        pipe.snap_by_fid = snap
        self.stats[pipe.stat + "publish"].append(self._now() - t)

    def _notify_clients(self, now):
        """Tell each client that a newer BASE / VIEW frame can be fetched. At most one notice is outstanding
        per client and stream (sent, not yet fetched); a client that does not fetch within STALL_S is stalled
        and gets no more notices until it does. Only tiny JSON is ever written to a WebSocket, so a client
        that stops reading cannot block TD's cook thread."""
        P = self.protocol
        for c in self.clients.values():
            for kind, n in (("base", c.base), ("view", c.view)):
                if n.outstanding is not None and not n.stalled and now - n.sent_at > STALL_S:
                    n.stalled = True
                    self._status_at = 0.0
                    print(f"[raster_editor] client {c.id} has not fetched {kind} frame {n.outstanding} for "
                          f"{STALL_S:.0f}s: stalled, no more notices until it does")
        if self.base.msg is not None and self.has_input:
            msg = None
            for c in self.clients.values():
                n = c.base
                if not c.ready or n.outstanding is not None or n.stalled or n.fetched == self.base.fid:
                    continue
                if msg is None:
                    msg = P.base_notice(self.base.fid, self.doc_w, self.doc_h)
                self._send(c.id, msg)
                n.outstanding = self.base.fid
                n.sent_at = now
        if self.out.msg is not None:
            for c in self._view_subscribers():
                n = c.view
                if n.outstanding is not None or n.stalled or n.fetched == self.out.fid:
                    continue
                applied = self.out.snap_by_fid.get(c.cid)
                self._send(c.id, P.view_notice(self.out.fid, self.doc_w, self.doc_h, -1 if applied is None else applied))
                n.outstanding = self.out.fid
                n.sent_at = now

    def _serve_pipe(self, pipe, kind, request, response, subscribed_only):
        """GET /base | /view ?token=T&client=<hello.clientId>[&frameId=N]: the newest frame of the stream."""
        pars = request.get("pars") or {}
        if not self._token_ok(pars.get("token")):
            return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
        c = next((x for x in self.clients.values() if x.cid == pars.get("client")), None)
        n = None if c is None else (c.base if kind == "base" else c.view)
        if subscribed_only and (c is None or not c.view_td):
            return self._cors(request, self._reply(response, 404, "Not Found", "not subscribed (send view mode td)"))
        if pipe.msg is None or (kind == "base" and not self.has_input):
            if n is not None:  # whatever it was told about is gone; it gets a new notice with the next frame
                n.outstanding = None
                n.fetched = None
            return self._cors(request, self._reply(response, 404, "Not Found", f"no {kind} frame"))
        if n is not None:
            n.fetched = pipe.fid
            n.outstanding = None
            if n.stalled:
                n.stalled = False
                print(f"[raster_editor] client {c.id} resumed")
                self._status_at = 0.0
        response["Cache-Control"] = "no-store"
        return self._cors(request, self._reply(response, 200, "OK", pipe.msg, "application/octet-stream"))

    def _serve_surface(self, request, response):
        """GET /surface?token=T&client=C&slot=N: SURFACE_DUMP of the slot's current buffer (straight alpha;
        masks are grey with a = 255), one band covering the document."""
        pars = request.get("pars") or {}
        if not self._token_ok(pars.get("token")):
            return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
        if self._restore_pending or self._held:
            return self._cors(request, self._reply(response, 503, "Service Unavailable", "restoring the document"))
        try:
            slot = int(pars.get("slot"))
        except (TypeError, ValueError):
            slot = None
        buf = self.surfaces.get(slot) if slot in self._slot_set else None
        if buf is None:
            return self._cors(request, self._reply(response, 404, "Not Found", "unknown slot"))
        t = self._now()
        P = self.protocol
        wire = self.converter.to_wire(buf, self._slot_premult(slot))
        self._dump_fid = (self._dump_fid + 1) & 0xFFFFFFFF
        hdr = P.Header(P.TYPE_SURFACE_DUMP, P.FLAG_FRAME_END, self._dump_fid, self.doc_w, self.doc_h,
                       0, 0, self.doc_w, self.doc_h, slot)
        msg = P.encode_message(hdr, wire)
        self.stats["dump"].append(self._now() - t)
        response["Cache-Control"] = "no-store"
        return self._cors(request, self._reply(response, 200, "OK", msg, "application/octet-stream"))

    @staticmethod
    def _cors(request, response):
        """The page may come from a dev server on another loopback origin (Devurl workflow): allow
        exactly that origin, nobody else. The token and loopback checks still apply."""
        for k, v in request.items():
            if str(k).lower() == "origin" and LOOPBACK_ORIGIN.match(str(v)):
                response["Access-Control-Allow-Origin"] = str(v)
                response["Vary"] = "Origin"
        return response

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
                text = f"{act.kind} active · {size} · {self._out_fps(now)} tiles/s in"
                if self.doc_layers is not None:
                    text += f" · doc r{self.doc_rev} {len(self._slot_set)} surfaces"
                if len(ready) > 1:
                    text += f" · {len(ready) - 1} standby"
                nview = len(self._view_subscribers())
                if nview:
                    text += f" · {nview} td-view"
                stalled = sum(1 for c in ready if c.base.stalled or c.view.stalled)
                if stalled:
                    text += f" · {stalled} stalled"
        if self.last_error is not None and now - self.last_error[1] < 10.0:
            text += f" · ERROR {self.last_error[0]}"
        if text != self._status:
            self._status = text
            self.o.par.Status = text

    def GetStatus(self):
        return self._status or ""

    def GetStats(self):
        """Milliseconds: median / worst over the last 300 samples."""
        out = {}
        for k, d in self.stats.items():
            xs = [x * 1000.0 for x in d]
            out[k] = {"n": len(xs), "median": _median(xs), "max": max(xs) if xs else 0.0}
        try:
            if self.network is not None:
                out["network"] = self.network.stats()
        except Exception:  # noqa: BLE001
            pass
        return out

    def _report(self, where, e):
        msg = f"{where}: {type(e).__name__}: {e}"
        self.last_error = (msg, self._now())
        self._status_at = 0.0
        if msg not in self._seen_errors and len(self._seen_errors) < 100:
            self._seen_errors.add(msg)
            print(f"[raster_editor] {msg}\n{traceback.format_exc()}")
