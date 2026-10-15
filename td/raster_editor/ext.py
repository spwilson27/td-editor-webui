"""RasterEditorExt: TouchDesigner glue for the raster editor COMP (docs/TD_COMPONENT.md).

Thin by design: byte layout lives in ``protocol``, pixel maths in ``frames``. Everything
here runs on TD's main thread and must stay bounded: no sync readbacks, no sleeping,
at most a couple of 2 MB messages and a few ms of conversion per frame.

All operators are reached through ``ownerComp.op(...)`` so the class can run against fake
TD objects in ``td/tests``.
"""

import collections
import functools
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
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
TOP_TTL_S = 30.0  # a converted TOP import is served by GET /top for this long
TOP_QUEUE_MAX = 2  # imports waiting behind the active one (all clients together)
TOP_HELD_PER_CLIENT = 2
TOP_HELD_MAX_BYTES = 640 * 1024 * 1024
TOP_READ_TIMEOUT_S = 10.0  # delayed readback that never delivers
TOP_CONVERT_BUDGET_S = CONVERT_BUDGET_S
TOP_SERVED_TTL_S = 5.0  # a served import is dropped this long after its last fetch (a retry still works)
TOP_SCAN_MAX = 50000  # listTops looks at this many TOPs at most
FONT_RETRY_S = 30.0  # a failed font enumeration is retried this often
FONT_STYLE_SUFFIX = re.compile(r"[\s-]+(?:bold|italic|oblique|regular|roman|bolditalic|boldoblique)$", re.I)
EXPORT_FLASH_S = 10.0  # an export result stays in `Status` this long
DEFAULT_LAYER = {"id": "base", "kind": "base", "parentId": None, "name": "Background", "visible": True,
                 "opacity": 1, "blend": "normal", "x": 0, "y": 0, "sx": 1, "sy": 1, "surfaceW": None, "surfaceH": None,
                 "slot": None, "mask": None, "adjustment": None, "text": None, "shape": None}


def font_families(names, labels=None):
    """Font menu entries -> sorted, de-duplicated family names. TD's `font` menu lists faces ("Arial Bold
    Italic"); trailing style words are dropped so the web side can combine family + bold / italic itself."""
    out = {}
    for raw in (labels if labels else names):
        name = str(raw).strip()
        if not name:
            continue
        fam = name
        while True:  # only known style words, only as a separate trailing token ("Arial-Bold", "Arial Bold Italic")
            m = FONT_STYLE_SUFFIX.search(fam)
            if m is None or m.start() == 0:
                break
            fam = fam[:m.start()]
        out.setdefault(fam.casefold(), fam)
    return sorted(out.values(), key=str.casefold)


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
        self.size = (0, 0)  # (w, h) of the published frame
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
        self._destroyed = False
        self._cache_root = lambda: os.path.join(tempfile.gettempdir(), "raster_editor_undo")  # test seam
        self.pump_count = 0
        self._open_url = None  # test seam; defaults to TD's ui.viewFile
        self._abs_frame = None  # test seam; defaults to TD's absTime.frame
        self._dump_fid = 0
        self._replace = os.replace  # test seam
        self.test_result = None
        self._seen_errors = set()
        self.last_error = None
        self._started = False
        self._fonts_retry_at = 0.0
        self._top_sizes = {}  # path -> (totalCooks, w, h): listTops reads a size once per cook, never forces a cook
        self._fonts = None  # cached family list (the menu does not change while TD runs)
        self.base = _Pipe("base", 1, "")
        self.out = _Pipe("view", 5, "v")
        self._load_modules()
        self._reset_state()
        self.stats = {k: collections.deque(maxlen=STAT_WINDOW) for k in (
            "pump", "paste", "cook", "convert", "publish", "readback", "vconvert", "vpublish", "vreadback",
            "apply", "dump", "top")}

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
        self.doc_w = 0  # document / canvas size
        self.doc_h = 0
        self.has_input = False
        self.in_w = 0  # TD Input resolution (the BASE frame / base surface size); 0 = none
        self.in_h = 0
        self.mode_seen = None  # canvas mode ("input" | "fixed") the document size was last computed for
        self.guides = {"h": [], "v": []}  # stored with the document
        self._wh_seen = None  # (Docw, Doch) as of the last _sync_doc_size
        self._client_canvas = False  # a setCanvas is being applied (not a Follow Input -> Fixed parameter flip)
        self._canvas_sender = None  # ...by this client: it does not get the docSize echo
        self._flash = None  # (text, expires) one-line result of an export
        self._sized = False
        # document: layer stack as last applied + a numpy buffer per surface slot (uint8 [h, w, 4], TD order =
        # bottom row first, premultiplied if `Premultiplied`; masks are grey with a = 255)
        self.doc_layers = None
        self.doc_rev = None
        self.surfaces = {}
        self._slot_set = frozenset()
        self._slot_size = {}  # slot -> (w, h) of its surface (v5: per surface, independent of the document size)
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
        self._imp = None  # the TOP import being read / converted (one at a time, for all clients)
        self._imp_queue = []  # imports waiting for it
        self._tops_held = collections.OrderedDict()  # (client cid, str(requestId)) -> {msg, expires, w, h}
        self._tops_bytes = 0
        self._top_frame_id = 0

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
        if self._destroyed:
            return
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
        self._prune_undo_caches()

    @_guard
    def Stop(self):
        if self._doc_state_dirty:
            self._flush_doc_state()
        self._close_all_sockets()
        self._drop_all_tops()
        self.clients.clear()
        self.active_id = None
        self._started = False
        self._op("webserver").par.active = 0

    def _superseded(self):
        """True when the COMP already runs a NEWER extension instance (initializeExtensions, a re-saved extension DAT, a module
        reload: TD builds the new instance, then calls onDestroyTD on the old one). On a real delete the extension is already
        gone from the COMP (AttributeError), which is not 'superseded'."""
        try:
            cur = self.o.ext.RasterEditorExt
        except Exception:  # noqa: BLE001
            return False
        return cur is not None and cur is not self

    def onDestroyTD(self):
        """TD calls this on the extension when the COMP is deleted (verified: before its children are destroyed, the COMP still
        valid; Execute DAT onExit / onDestroy are NOT called) -- and also on the OLD instance when the extension is re-initialised,
        which must not touch the server the new instance owns (``_superseded``). Quiet everything that talks to the outside so the
        destruction has nothing to wait for: close the WebSocket clients, stop the server, stop the panel's browser, drop imports
        and temporaries. TD's undo snapshot of the delete is taken BEFORE this hook (verified: a lock taken here is not in it), so
        the surface pixels would come back blank after Ctrl+Z; they are therefore saved to a temp-folder side cache that the
        recreated instance's Restore() picks up (``_save_undo_cache``). While a restore is pending the locked images already
        are the document (and in the snapshot): nothing is written. Every step is independent and never raises."""
        if self._superseded():
            return
        self._destroyed = True
        self._started = False
        for name, step in (
                ("undo cache", lambda: None if self._restore_pending else self._save_undo_cache()),
                ("sockets", self._close_all_sockets),
                ("server", lambda: setattr(self._op("webserver").par, "active", 0)),
                ("panel", lambda: setattr(self._op("webrender").par, "active", 0)),
                ("clients", self.clients.clear)):
            try:
                step()
            except Exception as e:  # noqa: BLE001 - the COMP is going away; nothing may escape into TD
                print(f"[raster_editor] onDestroyTD/{name}: {type(e).__name__}: {e}")
        self.active_id = None

    # --- undo of a delete: surface pixels in a temp-folder side cache

    UNDO_CACHE_MAX_BYTES = 256 << 20
    UNDO_CACHE_MAX_AGE_S = 6 * 3600
    _undo_writers = {}  # class level: cache dir -> writer thread (so an immediate undo waits for the files)

    @staticmethod
    def _text_hash(text):
        return hashlib.sha1((text or "").encode("utf-8", "replace")).hexdigest()

    def _undo_prefix(self):
        return hashlib.sha1(str(self.o.path).encode()).hexdigest()[:12] + f"_{os.getpid()}_"

    def _undo_cache_dir(self, doc_hash):
        """One directory per (component path, TD process, stored document): a different document at the same path never finds it."""
        return os.path.join(self._cache_root(), self._undo_prefix() + doc_hash[:16])

    def _undo_root(self, create=False):
        """The cache root (private to the user: mode 0700, owned by us) or None."""
        root = self._cache_root()
        try:
            if create:
                os.makedirs(root, mode=0o700, exist_ok=True)
            st = os.stat(root)
            if hasattr(os, "getuid") and st.st_uid != os.getuid():
                return None
            return root
        except OSError:
            return None

    def _slot_identity(self, layers):
        """{slot: "<layer id>:pixel|mask"}: which layer a surface belongs to."""
        out = {}
        for l in layers or ():
            if l.get("slot") is not None:
                out[l["slot"]] = f"{l.get('id')}:pixel"
            m = l.get("mask")
            if isinstance(m, dict) and m.get("slot") is not None:
                out[m["slot"]] = f"{l.get('id')}:mask"
        return out

    def _save_undo_cache(self):
        """Hand every surface buffer (npy, as stored) + a meta file (written last, atomically = complete marker) to a worker thread so
        the delete never waits for the disk (nothing writes the buffers any more: the pump is off and the sockets are closed).
        Identity = hash of the stored document text at this moment (= what TD's undo snapshot holds) + the layer behind each slot.
        Skipped above UNDO_CACHE_MAX_BYTES."""
        self._prune_undo_caches()
        bufs = dict(self.surfaces)
        if not bufs or sum(b.nbytes for b in bufs.values()) > self.UNDO_CACHE_MAX_BYTES:
            return
        doc_hash = self._text_hash(self._op("doc_state").text)
        root = self._undo_root(create=True)
        if root is None:
            return
        d = self._undo_cache_dir(doc_hash)
        meta = {"doc_hash": doc_hash, "rev": self.doc_rev, "time": time.time(), "slots": {}}
        ident = self._slot_identity(self.doc_layers)
        for slot, buf in bufs.items():
            meta["slots"][str(slot)] = {"file": f"s{slot}.npy", "w": int(buf.shape[1]), "h": int(buf.shape[0]),
                                        "premult": self._slot_premult(slot), "layer": ident.get(slot)}
        self._doc_state_dirty = False

        def write():
            try:
                shutil.rmtree(d, ignore_errors=True)
                os.makedirs(d, mode=0o700, exist_ok=True)
                for slot, buf in bufs.items():
                    np.save(os.path.join(d, f"s{slot}.npy"), buf, allow_pickle=False)
                tmp = os.path.join(d, "meta.json.tmp")
                with open(tmp, "w") as f:
                    json.dump(meta, f)
                os.replace(tmp, os.path.join(d, "meta.json"))
            except Exception as e:  # noqa: BLE001
                shutil.rmtree(d, ignore_errors=True)
                print(f"[raster_editor] undo cache not written: {type(e).__name__}: {e}")
            finally:
                self._undo_writers.pop(d, None)
        if getattr(self, "_sync_cache_writes", False):  # tests
            write()
            return
        t = threading.Thread(target=write, name="raster_editor_undo_cache", daemon=True)
        self._undo_writers[d] = t
        t.start()

    def _drop_undo_caches(self, keep=None):
        """Remove this component's caches (all, or all except ``keep``): they can no longer be used."""
        root = self._undo_root()
        if root is None:
            return
        try:
            names = os.listdir(root)
        except OSError:
            return
        pre = self._undo_prefix()
        for n in names:
            if n.startswith(pre) and os.path.join(root, n) != keep:
                shutil.rmtree(os.path.join(root, n), ignore_errors=True)

    def _load_undo_cache(self, skip):
        """Fill the buffers of slots not restored from locked images / carried over (``skip``) from the side cache of the instance
        that was deleted with exactly the document ``Restore()`` just read (hash of the doc_state text and the layer behind each
        slot must match), then remove it. Any mismatch or damage removes the cache."""
        doc_hash = getattr(self, "_restore_doc_hash", None)
        if not doc_hash:
            return set()
        d = self._undo_cache_dir(doc_hash)
        t = self._undo_writers.get(d)
        if t is not None:
            t.join(10.0)  # an undo right after the delete: wait for the writer
        taken = set()
        try:
            root = self._undo_root()
            if root is None or not os.path.isdir(d):
                return taken
            with open(os.path.join(d, "meta.json")) as f:
                meta = json.load(f)
            if meta.get("doc_hash") != doc_hash:
                return taken
            ident = self._slot_identity(self.doc_layers)
            for key, info in meta["slots"].items():
                slot = int(key)
                buf = self.surfaces.get(slot)
                if slot in skip or buf is None or (buf.shape[1], buf.shape[0]) != (info["w"], info["h"]) \
                        or info.get("layer") != ident.get(slot):
                    continue
                arr = np.load(os.path.join(d, info["file"]), allow_pickle=False)
                if arr.shape != buf.shape or arr.dtype != np.uint8:
                    continue
                if slot not in self._mask_slots and bool(info.get("premult")) != bool(self._p("Premultiplied")):
                    self.frames.convert_premultiplication(arr, bool(self._p("Premultiplied")))
                self.surfaces[slot] = arr
                self._dirty.add(slot)
                taken.add(slot)
        except Exception as e:  # noqa: BLE001 - damaged / foreign cache: never fatal
            print(f"[raster_editor] undo cache unusable: {type(e).__name__}: {e}")
        finally:
            self._drop_undo_caches()   # consumed, or not ours: no later instance may pick it up
        return taken

    def _prune_undo_caches(self):
        """Remove side caches older than UNDO_CACHE_MAX_AGE_S (a delete that was never undone)."""
        root = self._undo_root()
        if root is None:
            return
        try:
            names = os.listdir(root)
        except OSError:
            return
        now = time.time()
        for n in names:
            p = os.path.join(root, n)
            try:
                if now - os.path.getmtime(p) > self.UNDO_CACHE_MAX_AGE_S:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass

    def _close_all_sockets(self):
        self._drop_all_tops()
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
            shape = self._opt("shape_glsl")  # None (older COMP): DocNetwork falls back to its sibling file
            self.network = mod.DocNetwork(self.o, self._op("blend_glsl").text,
                                          shape_glsl=shape.text if shape is not None else None)
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
            self._drop_all_tops()
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
        elif name == "Exportdoc":
            self.ExportDoc()
        elif name in ("Docsizemode", "Docw", "Doch"):
            if self._sized and self._p("Active"):
                self._sync_doc_size()  # (the pump would do it next frame; this keeps clients in step with the parameter)
        elif name == "Premultiplied":
            # Buffers (and the stored input / output frames) were encoded for the old setting: surfaces are
            # re-encoded one per pump (_reencode_one); a slot's encoding is `Premultiplied xor (slot in _stale_enc)`.
            self._stale_enc = {sl for sl in self.surfaces if sl not in self._mask_slots} - self._stale_enc
            self._sync_pack()
            self._invalidate(self.base)
            self._invalidate(self.out)
        # Maxsendfps/Maxinputfps/Maxviewfps are read on use.

    def _view_url(self, url):
        if self._open_url is not None:
            self._open_url(url)
        else:  # pragma: no cover - needs TD
            ui.viewFile(url)  # noqa: F821

    def _project_folder(self):
        """Folder relative paths are resolved against (TD resolves File parameters against the project folder)."""
        if self._open_url is not None:  # tests
            return ""
        return str(project.folder)  # noqa: F821  # pragma: no cover

    def _export_path(self):
        """(path, defaulted): the Exportpath parameter made absolute, ".tox" appended when missing; empty -> the
        project folder's raster_editor_export.tox."""
        raw = str(self._p("Exportpath") or "").strip()
        defaulted = not raw
        path = os.path.expanduser(raw) if raw else "raster_editor_export.tox"
        if not os.path.isabs(path):
            path = os.path.join(self._project_folder(), path)
        if not path.lower().endswith(".tox"):
            path += ".tox"
        return path, defaulted

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
        # No HTTP keep-alive: TD's Web Server DAT (Poco) waits for every idle keep-alive connection to time out (10 s each) when
        # it is destroyed, which freezes TD for as long as a browser (the panel's CEF page!) holds connections open.
        response["Connection"] = "close"
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
        if method == "GET" and path == "/top":
            return self._serve_top(request, response)
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
        self._drop_client_tops(c)
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
        elif t == "listTops":
            self._on_list_tops(c, msg)
        elif t == "importTop":
            self._on_import_top(c, msg)
        elif t == "renderLayer":
            self._on_render_layer(c, msg)
        elif t == "setCanvas":
            self._on_set_canvas(c, msg)
        elif t == "log":
            self._on_log(msg)
        # unknown message types are ignored (PROTOCOL.md)

    @_guard
    def OnWebSocketBinary(self, client, data, _replay=False):
        c = self.clients.get(client)
        if self._destroyed or c is None or not c.ready or not c.active:
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
        if hdr.type != P.TYPE_SURFACE:
            return
        buf = self.surfaces.get(hdr.slot)
        if buf is None or hdr.slot not in self._slot_set:
            return  # a slot that is not in the last `doc`
        if P.is_stale(hdr, buf.shape[1], buf.shape[0]):
            return  # produced for another surface size (v5: docW/docH = the slot's surface size)
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
                                 self.doc_layers is not None, self.doc_rev, self._mode(), self.in_w, self.in_h))
        self._send(c.id, P.base_size(self.in_w, self.in_h))  # (also in hello.baseSize: for pages that ignore that)
        self._send(c.id, P.fonts(self._font_families()))
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
            guides, _canvas = self.protocol.doc_extras(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad doc: {e}"))
            return
        # (the canvas mode of a doc is informational: the Docsizemode parameter is the single source of truth)
        self._apply_doc(rev, layers, guides)

    def _surface_sizes(self, layers):
        """{slot: (w, h)} for a layer stack (protocol.slot_sizes; a surface without a size in the spec keeps its buffer's)."""
        return self.protocol.slot_sizes(layers, self.doc_w, self.doc_h,
                                        {s: (b.shape[1], b.shape[0]) for s, b in self.surfaces.items()})

    def _apply_doc(self, rev, layers, guides=None):
        """Apply a layer stack: allocate / revive / resize the surface buffers it names (each at its own surface
        size), diff-apply it to the generated network, remember it (stored to `doc_state` in the next pump)."""
        t0 = self._now()
        P = self.protocol
        slots = P.layer_slots(layers)
        masks = frozenset(P.mask_slots(layers))
        sizes = self._surface_sizes(layers)
        # buffers first: a failed allocation leaves the previous document untouched. A slot that was not in the
        # previously applied doc always starts blank (masks white): the engine resends pixels itself when a slot
        # legitimately reappears. A slot whose surface size changed keeps its pixels anchored top-left until the
        # engine's resend (its frames for the old size are dropped as stale).
        fresh = {s: self.frames.alloc_buffer(*sizes[s], s in masks) for s in slots if s not in self._slot_set}
        resized = {}
        for s in slots:
            old = self.surfaces.get(s)
            if s in self._slot_set and old is not None and (old.shape[1], old.shape[0]) != sizes[s]:
                resized[s] = self.frames.resize_buffer(old, sizes[s][0], sizes[s][1], s in masks)
        before = set(self.network.slots()) if self.network is not None else set()
        if self.network is not None and (layers != self.doc_layers or not self._net_applied):
            self.network.apply(layers, self.doc_w, self.doc_h)
            self._network_applied()
        self.surfaces.update(fresh)
        self.surfaces.update(resized)
        for s in [s for s in self.surfaces if s not in slots]:
            del self.surfaces[s]
            self._dirty.discard(s)
            self._stale_enc.discard(s)
        for s in fresh:
            self._stale_enc.discard(s)
        self._slot_set = frozenset(slots)
        self._slot_size = sizes
        self._mask_slots = masks
        if self.network is not None:
            self._dirty.update(set(self.network.slots()) - before)  # new Script TOPs need their pixels
        self._dirty.update(fresh)
        self._dirty.update(resized)
        self.doc_layers = layers
        self.doc_rev = rev
        if guides is not None:
            self.guides = guides
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
        self._send(c.id, self.protocol.doc_state(self.doc_rev, self._layers_with_sizes(self.doc_layers), self.doc_w, self.doc_h, self.guides,
                                                 {"mode": self._mode()}))

    def _layers_with_sizes(self, layers):
        """The stack for a client: every pixel / base layer has its surface size (the web engine requires it). Layers that
        came without one (v4 documents, sloppy clients) get the slot's buffer size / the input size / the document size."""
        out = []
        for l in layers:
            if l.get("kind") in ("pixel", "base") and (l.get("surfaceW") is None or l.get("surfaceH") is None):
                if l["kind"] == "base":
                    w, h = (self.in_w, self.in_h) if self.in_w > 0 and self.in_h > 0 else (self.doc_w, self.doc_h)
                else:
                    buf = self.surfaces.get(l.get("slot"))
                    w, h = (buf.shape[1], buf.shape[0]) if buf is not None else (self.doc_w, self.doc_h)
                l = dict(l, surfaceW=int(w), surfaceH=int(h))
            out.append(l)
        return out

    def _flush_doc_state(self):
        if self.doc_layers is None:
            self._doc_state_dirty = False
            return
        self._op("doc_state").text = self.protocol.encode_json(
            {"rev": self.doc_rev, "layers": self.doc_layers, "guides": self.guides, "canvas": {"mode": self._mode()}})
        self._doc_state_dirty = False

    def _read_doc_state(self):
        text = self._op("doc_state").text
        if not text or not text.strip():
            return None
        data = json.loads(text)
        layers = data.get("layers")
        if isinstance(layers, list):  # a v4 document: text / shape layers have no surface any more
            for l in layers:
                if isinstance(l, dict) and l.get("kind") in ("text", "shape"):
                    l["slot"] = None
                    l.pop("rasterize", None)
        msg = {"rev": data.get("rev"), "layers": layers, "guides": data.get("guides"), "canvas": data.get("canvas")}
        rev, layers = self.protocol.parse_doc(msg)
        guides, canvas = self.protocol.doc_extras(msg)
        return rev, layers, guides, canvas

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
                    want = self._slot_size.get(slot) or (self.doc_w, self.doc_h)
                    if (int(top.width), int(top.height)) != tuple(want):
                        raise RuntimeError(f"s{slot} holds {top.width}x{top.height}, its surface is {want[0]}x{want[1]}")
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
            raise RuntimeError("the document is still being restored from the locked surfaces; export refused")
        tmp = (path[:-4] if path.endswith(".tox") else path) + ".part.tox"
        self._saving = True
        try:
            self.Freeze()
            try:
                self.o.save(tmp)
            finally:
                self.Thaw()
            self._replace(tmp, path)
        except Exception:
            try:
                os.remove(tmp)  # no stray .part.tox
            except OSError:
                pass
            raise
        finally:
            self._saving = False
        return path

    def _flash_status(self, text):
        self._flash = (text, self._now() + EXPORT_FLASH_S)
        self._status_at = 0.0

    def ExportDoc(self):
        """`Exportdoc` pulse ("Export with Document"): freeze the surfaces, save the COMP (document and pixels
        included) to the `Exportpath` .tox through a temp file + rename, thaw. Refused while a restore is pending.
        The outcome (path / reason) is shown in `Status`; never raises into TD. Returns the path or None."""
        try:
            path, defaulted = self._export_path()
            folder = os.path.dirname(path)
            if folder and not os.path.isdir(folder):
                raise RuntimeError(f"folder {folder} does not exist; set Export Path to a .tox file in an existing folder")
            if self._mode() == "input" and self._sized and (int(self._p("Docw")), int(self._p("Doch"))) != (self.doc_w, self.doc_h):
                # Follow Input: the saved component keeps the size it had (Docw / Doch are what a copy without input uses)
                self.o.par.Docw, self.o.par.Doch = self.doc_w, self.doc_h
            self.SaveTox(path)
        except Exception as e:  # noqa: BLE001
            self.last_error = (f"export failed: {e}", self._now())
            self._flash_status(f"export failed: {e}")
            print(f"[raster_editor] export failed: {type(e).__name__}: {e}")
            return None
        if self.last_error is not None and str(self.last_error[0]).startswith("export failed"):
            self.last_error = None  # (only the export's own error: unrelated errors stay visible)
        self._flash_status(f"exported with document to {path}" + (" (Export Path was empty)" if defaulted else ""))
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
            self._drop_undo_caches()   # nothing to restore: a leftover cache of an earlier component here is unusable
            return False
        self._restore_doc_hash = self._text_hash(self._op("doc_state").text)
        rev, layers, guides, canvas = stored
        self._restore_pending = True
        self.doc_layers, self.doc_rev, self.guides = layers, rev, guides
        if canvas["mode"] != self._mode():  # the stored canvas mode wins over a stale parameter
            self.o.par.Docsizemode = canvas["mode"]
        self._slot_set = frozenset(self.protocol.layer_slots(layers))
        self._mask_slots = frozenset(self.protocol.mask_slots(layers))
        self._slot_size = self.protocol.slot_sizes(layers, int(self._p("Docw")), int(self._p("Doch")))
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
                    w, h = self._slot_size.get(slot) or (self.doc_w, self.doc_h)
                    self.surfaces[slot] = self.frames.from_float(arr, w, h, slot in self._mask_slots)
                    self._dirty.add(slot)
                    restored.add(slot)
                del arr
            for slot in self.surfaces:
                if slot in self._carry and slot not in restored:
                    w, h = self._slot_size.get(slot) or (self.doc_w, self.doc_h)
                    buf = self.frames.resize_buffer(self._carry[slot], w, h, slot in self._mask_slots)
                    if slot in self._carry_stale:  # it still waited for a Premultiplied re-encode
                        self.frames.convert_premultiplication(buf, bool(self._p("Premultiplied")))
                    self.surfaces[slot] = buf
                    self._dirty.add(slot)
            taken = self._load_undo_cache(restored | {sl for sl in self.surfaces if sl in self._carry})
            if taken:
                print(f"[raster_editor] restored {len(taken)} surface(s) from the delete's undo cache")
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
        if self._destroyed:
            return  # the COMP is being deleted
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
                ("notify", lambda: self._notify_clients(now)), ("tops", lambda: self._tick_tops(now)),
                ("surfaces", self._cook_surfaces),
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

    def _mode(self):
        """Canvas size mode: "input" (Follow Input) or "fixed" (Docw x Doch)."""
        return "fixed" if str(self._p("Docsizemode")) == "fixed" else "input"

    def _default_layers(self):
        """The stack before any client sent a document: one base layer. In Fixed mode an input is fitted (contain) and
        centred like the web engine does; in Follow Input mode the transform is the identity."""
        base = dict(DEFAULT_LAYER)
        if self.has_input and self.in_w > 0:
            base["surfaceW"], base["surfaceH"] = self.in_w, self.in_h
            if self._mode() == "fixed":
                k = min(self.doc_w / self.in_w, self.doc_h / self.in_h)
                base.update(sx=k, sy=k, x=round((self.doc_w - self.in_w * k) / 2), y=round((self.doc_h - self.in_h * k) / 2))  # whole pixels
        else:
            base["surfaceW"], base["surfaceH"] = self.doc_w, self.doc_h
        return [base]

    def _apply_network(self):
        if self.network is None:
            return
        t = self._now()
        layers = self.doc_layers if self.doc_layers is not None else self._default_layers()
        self.network.apply(layers, self.doc_w, self.doc_h)
        self._network_applied()
        self.stats["apply"].append(self._now() - t)

    def _sync_doc_size(self):
        """Document size, input resolution and canvas mode (v5). Follow Input: document = input size (Docw x Doch with no
        input); Fixed: Docw x Doch. Surfaces keep their own sizes: nothing is reallocated here (a canvas resize never
        resamples pixels); only the first call allocates the surfaces of a restored document. Changes are announced
        to every client: `docSize` (document size / mode / hasInput) and `baseSize` (input resolution)."""
        has_input = len(self.o.inputs) > 0
        mode = self._mode()
        iw = ih = 0
        if has_input:
            top = self._op("in1")
            top.cook()
            iw, ih = int(top.width), int(top.height)
            if (iw < 1 or ih < 1) and self._sized and mode == "input":
                return  # the input reports 0x0 while it (re)starts: Follow Input keeps the document as it is
            iw, ih = max(0, min(iw, 0xFFFF)), max(0, min(ih, 0xFFFF))
        wh = (int(self._p("Docw")), int(self._p("Doch")))
        if self._sized and mode == "fixed" and self.mode_seen == "input" and not self._client_canvas \
                and wh == self._wh_seen and (self.doc_w, self.doc_h) != wh:
            # Follow Input -> Fixed by the parameter alone (Docw / Doch not edited together with it): start from the
            # size the document has now, so nothing visibly changes
            self.o.par.Docw, self.o.par.Doch = self.doc_w, self.doc_h
        if mode == "input" and iw >= 1 and ih >= 1:
            w, h = iw, ih
        else:
            w, h = int(self._p("Docw")), int(self._p("Doch"))
        w = max(1, min(w, 0xFFFF))
        h = max(1, min(h, 0xFFFF))
        self._wh_seen = (int(self._p("Docw")), int(self._p("Doch")))
        state = (w, h, has_input, iw, ih, mode)
        if self._sized and state == (self.doc_w, self.doc_h, self.has_input, self.in_w, self.in_h, self.mode_seen):
            return
        first = not self._sized
        size_changed = (w, h) != (self.doc_w, self.doc_h)
        mode_changed = mode != self.mode_seen
        base_changed = (iw, ih, has_input) != (self.in_w, self.in_h, self.has_input)
        if first:
            # a restored document: allocate every surface at its own size (a v4 document without sizes: the document's)
            if self.doc_layers is not None:
                self._slot_size = self.protocol.slot_sizes(self.doc_layers, w, h)
            surfaces = {s: self.frames.resize_buffer(self.surfaces.get(s), *self._slot_size.get(s, (w, h)), s in self._mask_slots)
                        for s in set(self.surfaces) | self._slot_set}
            self.surfaces = surfaces
            self._dirty = set(surfaces)  # push the buffers so the Script TOPs take their sizes
        prev_input, old_in = self.has_input, (self.in_w, self.in_h)
        self.doc_w, self.doc_h, self.has_input = w, h, has_input
        self.in_w, self.in_h = iw, ih
        self.mode_seen = mode
        self._sized = True
        if size_changed or first:
            self._invalidate(self.out)
            self._panel_key = None
        if base_changed or first:
            self._invalidate(self.base)
            self.base.pending = has_input
        if mode_changed and not first:
            self._doc_state_dirty = True  # the stored canvas mode follows the parameter
        if not first:
            ids = self._ready_ids()
            if size_changed or mode_changed or has_input != prev_input:
                msg = self.protocol.doc_size(w, h, has_input, mode)
                for cid in ids:
                    if cid != self._canvas_sender:
                        self._send(cid, msg)
            if base_changed:
                msg = self.protocol.base_size(iw, ih)
                for cid in ids:
                    self._send(cid, msg)
        if not first:
            self._adjust_base(mode, mode_changed, old_in, (iw, ih))
        flag = getattr(self.network, "set_input_connected", None)
        if flag is not None:
            flag(has_input)
        self._apply_network()
        self._status_at = 0.0

    def _adjust_base(self, mode, mode_changed, old_in, new_in):
        """Keep the stored base layer right without a page: switching to Follow Input resets its transform to the identity;
        an input resolution change updates its surface size, and in Fixed mode rescales sx / sy so the displayed box
        (surface size x scale) stays the same."""
        layers = self.doc_layers
        if not layers:
            return
        i = next((k for k, l in enumerate(layers) if l.get("kind") == "base"), None)
        if i is None:
            return
        b = dict(layers[i])
        if mode_changed and mode == "input":
            b.update(x=0, y=0, sx=1, sy=1)
        iw, ih = new_in
        ow, oh = b.get("surfaceW"), b.get("surfaceH")
        if iw > 0 and ih > 0 and (ow, oh) != (iw, ih):
            if mode == "fixed" and old_in[0] > 0 and ow and oh:
                b["sx"] = b.get("sx", 1) * ow / iw
                b["sy"] = b.get("sy", 1) * oh / ih
            b["surfaceW"], b["surfaceH"] = iw, ih
        if b != layers[i]:
            self.doc_layers = layers[:i] + [b] + layers[i + 1:]
            self._doc_state_dirty = True

    def _on_set_canvas(self, c, msg):
        """`setCanvas {w, h, mode}` from the active client: Fixed -> Docw / Doch / Docsizemode; Input -> Docsizemode only.
        The pump then announces the new size (`docSize`) to the other clients; the sender is told when the result
        differs from what it asked for (clamped, or the input's size in Follow Input mode)."""
        P = self.protocol
        if not c.active:
            return
        try:
            w, h, mode = P.parse_set_canvas(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad setCanvas: {e}"))
            return
        if mode == "fixed":
            self.o.par.Docw, self.o.par.Doch = w, h
        self.o.par.Docsizemode = mode
        self._doc_state_dirty = True  # the stored canvas mode follows
        self._client_canvas, self._canvas_sender = True, c.id
        try:
            if self._sized:
                self._sync_doc_size()
        finally:
            self._client_canvas, self._canvas_sender = False, None
        if not (mode == "fixed" and (self.doc_w, self.doc_h) == (w, h)):
            self._send(c.id, P.doc_size(self.doc_w, self.doc_h, self.has_input, self._mode()))

    # ------------------------------------------------------------------ fonts

    def _font_families(self):
        """System font families from a Text TOP's `font` menu (cached; a failure is retried after FONT_RETRY_S).
        Never raises: [] makes the web app use its built-in list."""
        if self._fonts is None:
            now = self._now()
            if now < self._fonts_retry_at:
                return []
            try:
                names, labels = self._font_menu()
                self._fonts = font_families(names, labels)
            except Exception as e:  # noqa: BLE001
                self._fonts_retry_at = now + FONT_RETRY_S
                self._report("fonts", e)
                return []
        return self._fonts

    def _font_menu(self):
        """(menuNames, menuLabels) of a hidden Text TOP: the build's `font_probe`, else a temporary one."""
        probe = self._opt("font_probe")
        if probe is not None:
            par = probe.par.font
            return list(par.menuNames), list(par.menuLabels)
        tmp = self.o.create("textTOP", "_font_probe_tmp")  # pragma: no cover - needs TD
        try:
            return list(tmp.par.font.menuNames), list(tmp.par.font.menuLabels)
        finally:
            tmp.destroy()

    # ------------------------------------------------------------------ TOP import (listTops / importTop / GET /top)

    def _all_tops(self):  # pragma: no cover - needs TD
        """Every TOP of the project (a tree walk, nothing is cooked). Test seam."""
        root = op("/project1")  # noqa: F821
        return root.findChildren(type=TOP)  # noqa: F821

    def _lookup_top(self, path):  # pragma: no cover - needs TD
        """The TOP at ``path`` or None. Test seam."""
        o = op(path)  # noqa: F821
        return o if o is not None and getattr(o, "family", None) == "TOP" else None

    def _make_scaler(self, top, tw, th, tag):  # pragma: no cover - needs TD
        """GPU downscale before the readback: Select TOP -> Resolution TOP (tw x th) inside this COMP. Returns
        (output TOP, [temporary operators]). Test seam."""
        sel = self.o.create("selectTOP", f"_imp_sel{tag}")
        res = None
        try:
            sel.par.top = top.path
            res = self.o.create("resolutionTOP", f"_imp_res{tag}")
            res.inputConnectors[0].connect(sel)
            res.par.outputresolution = "custom"
            res.par.resolutionw, res.par.resolutionh = tw, th
            try:
                res.par.inputfiltertype = "mipmap"
            except Exception:  # noqa: BLE001 - older parameter name / menu
                pass
        except Exception:
            for t in (res, sel):
                if t is not None:
                    t.destroy()
            raise
        return res, [res, sel]

    def _inside_self(self, path):
        me = str(self.o.path)
        return path == me or path.startswith(me + "/")

    def _top_size(self, t):
        """(w, h) of a TOP without forcing a cook: custom resolution parameters, else the size cached for its current
        cook count, else (when it has cooked) its reported size, else 0x0 (unknown)."""
        try:
            if str(t.par.outputresolution.eval()) == "custom":
                return int(t.par.resolutionw.eval()), int(t.par.resolutionh.eval())
        except Exception:  # noqa: BLE001 - not every TOP has these
            pass
        path = str(t.path)
        cooks = getattr(t, "totalCooks", 0)
        hit = self._top_sizes.get(path)
        if hit is not None and hit[0] == cooks:
            return hit[1], hit[2]
        if cooks > 0:
            try:
                w, h = int(t.width), int(t.height)
            except Exception:  # noqa: BLE001
                return 0, 0
            if len(self._top_sizes) > 4 * self.protocol.MAX_TOPS:
                self._top_sizes.clear()
            self._top_sizes[path] = (cooks, w, h)
            return w, h
        return 0, 0

    def _list_tops(self):
        items, scanned = [], 0
        for t in self._all_tops():
            scanned += 1
            if scanned > TOP_SCAN_MAX:
                break
            path = str(t.path)
            if self._inside_self(path):
                continue
            w, h = self._top_size(t)
            items.append({"path": path, "w": w, "h": h})
            if len(items) >= self.protocol.MAX_TOPS:
                break
        items.sort(key=lambda i: i["path"])
        return items

    def _on_list_tops(self, c, msg):
        P = self.protocol
        try:
            rid = P.parse_list_tops(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.top_error(msg.get("requestId") if isinstance(msg.get("requestId"), (str, int)) else None,
                                         f"bad listTops: {e}"))
            return
        self._send(c.id, P.tops(rid, self._list_tops()))

    def _on_import_top(self, c, msg):
        P = self.protocol
        try:
            rid, path = P.parse_import_top(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad importTop: {e}"))
            return
        if self._inside_self(path):
            self._send(c.id, P.top_error(rid, "that TOP is part of the raster editor"))
            return
        try:
            top = self._lookup_top(path)
        except Exception:  # noqa: BLE001 - bad path syntax
            top = None
        if top is None:
            self._send(c.id, P.top_error(rid, f"{path} is not a TOP"))
            return
        if self._inside_self(str(top.path)):  # wildcards / `..` can resolve into the component
            self._send(c.id, P.top_error(rid, "that TOP is part of the raster editor"))
            return
        w, h = self._top_size(top)  # no cook; 0x0 = unknown, checked again when it is read
        if w > P.MAX_TOP_DIM or h > P.MAX_TOP_DIM:
            self._send(c.id, P.top_error(rid, f"{path} is too large ({w}x{h}, limit {P.MAX_TOP_DIM}x{P.MAX_TOP_DIM})"))
            return
        self._enqueue_job(c, rid, {"client": c.id, "ccid": c.cid, "rid": rid, "path": path, "stage": "read",
                                   "calls": 0, "started": None, "scaler": None, "temps": []})

    def _on_render_layer(self, c, msg):
        """`renderLayer {requestId, layerId}` (Flatten): TD renders that text / shape layer alone at document size
        (network.render_layer_source) and serves it like a TOP import (`topReady` + `GET /top`, frame type 6)."""
        P = self.protocol
        try:
            rid, lid = P.parse_render_layer(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad renderLayer: {e}"))
            return
        layer = next((l for l in (self.doc_layers or []) if l.get("id") == lid), None)
        if not c.active:
            self._send(c.id, P.top_error(rid, "only the active editor can flatten a layer"))
        elif self._restore_pending or self._held:
            self._send(c.id, P.top_error(rid, "TouchDesigner is still restoring the document; try again"))
        elif layer is None or layer.get("kind") not in ("text", "shape"):
            self._send(c.id, P.top_error(rid, f"layer {lid!r} is not a text or shape layer of TouchDesigner's document"))
        elif getattr(self.network, "render_layer_source", None) is None:
            self._send(c.id, P.top_error(rid, "the document network cannot render layers"))
        elif self.doc_w * self.doc_h > P.MAX_TOP_PIXELS:
            self._send(c.id, P.top_error(rid, f"the document ({self.doc_w}x{self.doc_h}) is too large to flatten a layer"))
        else:
            self._enqueue_job(c, rid, {"client": c.id, "ccid": c.cid, "rid": rid, "path": None, "layer": lid,
                                       "target": (self.doc_w, self.doc_h), "stage": "read", "calls": 0, "started": None,
                                       "scaler": None, "temps": []})

    def _enqueue_job(self, c, rid, job):
        P = self.protocol
        # One import per client, newest wins: a queued one is replaced, the running one is cancelled. The capacity
        # check comes after, so replacing your own request never fails for lack of room.
        for j in [j for j in self._imp_queue if j["client"] == c.id]:
            self._imp_queue.remove(j)
            self._send(c.id, P.top_error(j["rid"], "superseded by a newer import"))
        if self._imp is not None and self._imp["client"] == c.id:
            self._send(c.id, P.top_error(self._imp["rid"], "superseded by a newer import"))
            self._release_job(self._imp)
            self._imp = None
        if len(self._imp_queue) + (1 if self._imp is not None else 0) >= TOP_QUEUE_MAX + 1:
            self._send(c.id, P.top_error(rid, "busy: other TOP imports are pending, try again"))
            return
        self._imp_queue.append(job)

    def _layer_token(self, layer_id):
        fn = getattr(self.network, "render_layer_token", None)
        return fn(layer_id) if fn is not None else None

    def _layer_ready(self, layer_id):
        fn = getattr(self.network, "render_layer_ready", None)
        return True if fn is None else bool(fn(layer_id))

    def _release_job(self, job):
        """Destroy the temporary operators of an import and drop its buffers."""
        for t in job.pop("temps", []):
            try:
                t.destroy()
            except Exception:  # noqa: BLE001
                pass
        job["scaler"] = None
        job.pop("arr", None)
        job.pop("out", None)
        job.pop("src", None)

    def _drop_client_tops(self, c):
        for j in [j for j in self._imp_queue if j["client"] == c.id]:
            self._imp_queue.remove(j)
            self._release_job(j)
        if self._imp is not None and self._imp["client"] == c.id:
            self._release_job(self._imp)
            self._imp = None
        for k in [k for k in self._tops_held if k[0] == c.cid]:
            self._tops_bytes -= len(self._tops_held.pop(k)["msg"])

    def _sweep_import_temps(self):
        """Destroy leftover downscale operators (`_imp_sel*` / `_imp_res*`), e.g. orphaned by a module reload."""
        try:
            kids = list(getattr(self.o, "children", None) or [])
        except Exception:  # noqa: BLE001
            return
        for k in kids:
            if str(getattr(k, "name", "")).startswith(("_imp_sel", "_imp_res")):
                try:
                    k.destroy()
                except Exception as e:  # noqa: BLE001
                    self._report("sweep", e)

    def _drop_all_tops(self):
        """Every import and held image (server stopped / clients cleared)."""
        for j in self._imp_queue + ([self._imp] if self._imp is not None else []):
            self._release_job(j)
        self._imp, self._imp_queue = None, []
        self._sweep_import_temps()
        self._tops_held.clear()
        self._tops_bytes = 0

    def _top_fail(self, job, text):
        self._release_job(job)
        if self._imp is job:
            self._imp = None
        if job["client"] in self.clients:
            self._send(job["client"], self.protocol.top_error(job["rid"], text))

    def _tick_tops(self, now):
        """Expire held imports and advance the one running import by one budgeted step per pump."""
        for k in [k for k, v in self._tops_held.items() if now >= v["expires"]]:
            self._tops_bytes -= len(self._tops_held.pop(k)["msg"])
        if self._imp is None and self._imp_queue:
            self._imp = self._imp_queue.pop(0)
            self._imp["started"] = now
        job = self._imp
        if job is None:
            return
        try:
            if job["stage"] == "read":
                self._top_read(job, now)
            else:
                self._top_convert(job)
        except Exception as e:  # noqa: BLE001 - one bad TOP must not break the pump
            self._report("importTop", e)
            self._top_fail(job, f"readback failed: {type(e).__name__}: {e}")

    def _top_read(self, job, now):
        P = self.protocol
        label = job["path"] or f"layer {job.get('layer')!r}"
        if job.get("layer") is not None:  # Flatten: the network's render source for the layer, at the document size
            if job["target"] != (self.doc_w, self.doc_h):
                return self._top_fail(job, "the document was resized while the layer was rendered")
            try:  # re-resolved EVERY pump: an apply() can destroy / recycle the operator behind the layer
                top = self.network.render_layer_source(job["layer"])
            except Exception as e:  # noqa: BLE001
                return self._top_fail(job, f"cannot render {label}: {e}" if job.get("src") is None else "layer changed")
            if top is None:
                return self._top_fail(job, f"cannot render {label}" if job.get("src") is None else "layer changed")
            if job.get("src") is not None and top is not job["src"]:
                return self._top_fail(job, "layer changed")
            job["src"] = top
            if not job.get("ready"):
                if not self._layer_ready(job["layer"]):  # text measurements still finishing: wait (bounded)
                    if now - job["started"] > TOP_READ_TIMEOUT_S:
                        return self._top_fail(job, "readback failed: the layer's text layout never became ready")
                    return
                job["ready"], job["token"] = True, self._layer_token(job["layer"])  # (measuring refines the layout first)
                job["calls"] = 0   # a delayed read issued before the layout was final is stale: the first result is discarded again
            elif self._layer_token(job["layer"]) != job["token"]:
                return self._top_fail(job, "layer changed")
        else:
            top = self._lookup_top(job["path"])
            if top is None:
                return self._top_fail(job, f"{job['path']} no longer exists")
            if self._inside_self(str(top.path)):
                return self._top_fail(job, "that TOP is part of the raster editor")
        w, h = int(top.width), int(top.height)
        if w < 1 or h < 1:
            return self._top_fail(job, f"{label} has no image (size {w}x{h})")
        if w > P.MAX_TOP_DIM or h > P.MAX_TOP_DIM:
            return self._top_fail(job, f"{label} is too large ({w}x{h}, limit {P.MAX_TOP_DIM}x{P.MAX_TOP_DIM})")
        if now - job["started"] > TOP_READ_TIMEOUT_S:
            return self._top_fail(job, "readback failed: timed out")
        tw, th = job["target"] if job.get("target") else P.import_target_size(w, h, self.doc_w, self.doc_h)
        src = top
        if (tw, th) != (w, h):  # large image: shrink on the GPU first, so the readback and the message stay small
            if job["scaler"] is None:
                job["scaler"], job["temps"] = self._make_scaler(top, tw, th, f"{id(job) & 0xFFFF:04x}")
                job["calls"] = 0
                return  # read from the next pump on (the new operators cook then)
            src = job["scaler"]
        # Two-step delayed readback as for the BASE stream: a call returns the read issued by the previous one, so
        # the first result is ignored (it may be stale) and the main thread never waits for the GPU.
        t = self._now()
        arr = src.numpyArray(delayed=True)
        self.stats["top"].append(self._now() - t)
        job["calls"] += 1
        if job["calls"] < 2 or arr is None:
            return
        if tuple(arr.shape[:2]) != (th, tw):  # the TOP was resized meanwhile: read again
            job["calls"] = 0
            return
        # one buffer holds header + pixels: the converter writes straight into it, the held message is that buffer
        hdr = P.Header(P.TYPE_TOP_IMAGE, P.FLAG_FRAME_END, 0, tw, th, 0, 0, tw, th)
        buf = bytearray(P.HEADER_SIZE + tw * th * 4)
        buf[:P.HEADER_SIZE] = P.encode_header(hdr)
        out = np.frombuffer(buf, np.uint8, offset=P.HEADER_SIZE).reshape(th, tw, 4)
        job.update(stage="convert", arr=arr, out=out, buf=buf, row=0, rows=32, w=tw, h=th,
                   unpre=bool(self._p("Premultiplied")))
        self._top_convert(job)

    def _top_convert(self, job):
        arr, out, h = job["arr"], job["out"], job["h"]
        start = self._now()
        while job["row"] < h:
            r0 = job["row"]
            r1 = min(h, r0 + job["rows"])
            t = self._now()
            self.converter.convert_rows(arr, out, r0, r1, job["unpre"])
            dt = self._now() - t
            job["row"] = r1
            if dt > 0:  # adapt the slice so each takes ~1/3 of the budget
                job["rows"] = max(16, int(job["rows"] * (TOP_CONVERT_BUDGET_S / 3) / dt))
            if self._now() - start >= TOP_CONVERT_BUDGET_S:
                break
        self.stats["top"].append(self._now() - start)
        if job["row"] < h:
            return
        P = self.protocol
        if job.get("layer") is not None:
            try:
                same = (self.network.render_layer_source(job["layer"]) is job.get("src")
                        and self._layer_token(job["layer"]) == job.get("token"))
            except Exception:  # noqa: BLE001
                same = False
            if not same:
                return self._top_fail(job, "layer changed")
        w, buf = job["w"], job["buf"]
        self._top_frame_id = (self._top_frame_id + 1) & 0xFFFFFFFF
        buf[8:12] = self._top_frame_id.to_bytes(4, "little")  # header frameId
        P.decode_frame(buf)  # sanity: the header we wrote describes the payload
        job.pop("buf")
        self._release_job(job)
        self._imp = None
        self._hold_top(job, buf, w, h)
        if job["client"] in self.clients:
            self._send(job["client"], P.top_ready(job["rid"], w, h))

    def _hold_top(self, job, msg, w, h):
        """Keep the converted image for GET /top: at most TOP_HELD_PER_CLIENT per client and TOP_HELD_MAX_BYTES in
        total (oldest evicted first), each for TOP_TTL_S (TOP_SERVED_TTL_S once it was served)."""
        key = (job["ccid"], str(job["rid"]))
        old = self._tops_held.pop(key, None)
        if old is not None:
            self._tops_bytes -= len(old["msg"])
        mine = [k for k in self._tops_held if k[0] == job["ccid"]]
        for k in mine[: max(0, len(mine) - TOP_HELD_PER_CLIENT + 1)]:
            self._tops_bytes -= len(self._tops_held.pop(k)["msg"])
        while self._tops_held and self._tops_bytes + len(msg) > TOP_HELD_MAX_BYTES:
            k = next(iter(self._tops_held))
            self._tops_bytes -= len(self._tops_held.pop(k)["msg"])
        self._tops_held[key] = {"msg": msg, "expires": self._now() + TOP_TTL_S, "w": w, "h": h}
        self._tops_bytes += len(msg)

    def _serve_top(self, request, response):
        """GET /top?token=T&client=C&requestId=R: the converted TOP image (frame type 6); 404 unknown / expired.
        After a successful serve the image is only kept TOP_SERVED_TTL_S longer (a retry still works)."""
        pars = request.get("pars") or {}
        if not self._token_ok(pars.get("token")):
            return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
        key = (pars.get("client"), str(pars.get("requestId")))
        held = self._tops_held.get(key)
        now = self._now()
        if held is not None and now >= held["expires"]:
            self._tops_bytes -= len(self._tops_held.pop(key)["msg"])
            held = None
        if held is None or not any(c.cid == key[0] for c in self.clients.values()):
            return self._cors(request, self._reply(response, 404, "Not Found", "unknown or expired TOP import"))
        held["expires"] = min(held["expires"], now + TOP_SERVED_TTL_S)
        response["Cache-Control"] = "no-store"
        return self._cors(request, self._reply(response, 200, "OK", held["msg"], "application/octet-stream"))

    # --- TOP -> clients (BASE from in1, VIEW from doc/out): shared budgeted pipeline

    def _poll_pipe(self, pipe, top, now, period, wanted, size, packed=False):
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
        if tuple(arr.shape[:2]) != (size[1], size[0]):
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
        if self.in_w < 1 or self.in_h < 1:
            return
        self._poll_pipe(self.base, top, now, period, bool(self._ready_ids()), (self.in_w, self.in_h))

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
        self._poll_pipe(self.out, top, now, period, True, (self.doc_w, self.doc_h), packed=pack is not None)

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
        h, w = wire.shape[:2]  # BASE: the input's size (v5), VIEW: the document's
        hdr = P.Header(pipe.type, P.FLAG_FRAME_END, pipe.frame_id, w, h, 0, 0, w, h)
        pipe.msg = P.encode_message(hdr, wire)
        pipe.size = (w, h)
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
                    msg = P.base_notice(self.base.fid, *self.base.size)
                self._send(c.id, msg)
                n.outstanding = self.base.fid
                n.sent_at = now
        if self.out.msg is not None:
            for c in self._view_subscribers():
                n = c.view
                if n.outstanding is not None or n.stalled or n.fetched == self.out.fid:
                    continue
                applied = self.out.snap_by_fid.get(c.cid)
                self._send(c.id, P.view_notice(self.out.fid, *self.out.size, -1 if applied is None else applied))
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
        masks are grey with a = 255), one band covering the whole surface (docW / docH = the surface size)."""
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
        sh, sw = buf.shape[:2]
        hdr = P.Header(P.TYPE_SURFACE_DUMP, P.FLAG_FRAME_END, self._dump_fid, sw, sh, 0, 0, sw, sh, slot)
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
            size = f"{self.doc_w}×{self.doc_h}" + (" (follows input)" if self._mode() == "input" and self.has_input else "")
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
        if self._flash is not None:
            if now < self._flash[1]:
                text += f" · {self._flash[0]}"
            else:
                self._flash = None
        elif self.last_error is not None and now - self.last_error[1] < 10.0:
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
