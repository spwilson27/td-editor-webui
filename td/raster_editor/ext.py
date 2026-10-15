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
FILE_FLASH_S = 10.0
INPUT_TRIM_S = 2.0  # a trailing spare In TOP beyond the one spare connector is removed this long after it became unneeded
MAX_INPUTS = 8
HISTORY_KEY = "raster_history"  # COMP storage: (rev, blob bytes), replaced as one object (v7)
HISTORY_MAX_BYTES = 256 * 1024 * 1024  # POST /history body limit
HINT_PAD = 32  # content-bounds hints are padded and rounded outward to HINT_GRID so a growing stroke re-plans rarely
HINT_GRID = 64
PNG_LEVEL = 3  # zlib level for PNG / .redoc surfaces (speed over size)
PNG_READ_TIMEOUT_S = 10.0
DEFAULT_LAYER = {"id": "input1", "kind": "input", "input": 1, "parentId": None, "name": "TD Input 1", "visible": True,
                 "opacity": 1, "blend": "normal", "x": 0, "y": 0, "sx": 1, "sy": 1, "rot": 0, "kx": 0, "ky": 0,
                 "effects": [], "surfaceW": None, "surfaceH": None,
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
    __slots__ = ("id", "cid", "kind", "ready", "active", "seq", "fresh", "bases", "view", "view_msg", "view_td",
                 "fid_pending", "fid_applied", "reloading", "active_layer", "lp")

    def __init__(self, cid):
        self.id = cid  # socket peer string, used for webSocketSend*
        self.cid = secrets.token_hex(6)  # opaque id in `hello`, echoed by the client in GET /base etc.
        self.kind = "unknown"
        self.ready = False
        self.active = False
        self.seq = 0
        self.fresh = False
        self.bases = {}  # input index -> _Notice (v6: one BASE stream per TD input)
        self.view = _Notice()
        self.reloading = False  # an Open Project replaced the document: doc / tiles are ignored until requestDoc
        self.view_msg = None  # last validated `view` message
        self.view_td = False  # external client subscribed to the VIEW stream
        self.fid_pending = None  # newest SURFACE frameId (FRAME_END) pasted from this client
        self.fid_applied = None  # newest one uploaded to its Script TOP (reported via `applied`)
        self.active_layer = None  # v7: the layer id the editor named in `activeLayer`
        self.lp = {}  # v7: layer id -> _Notice of its LAYER_PREVIEW stream

    def notice(self, n):
        return self.bases.setdefault(n, _Notice())

    @property
    def base(self):  # input 1
        return self.notice(1)


class _Pipe:
    """One budgeted TOP -> wire stream: delayed GPU readback, incremental conversion, one immutable
    message served over HTTP (BASE from in1, VIEW from doc/out). State only; logic lives in the extension."""

    def __init__(self, name, mtype, stat, input=None, layer=None):
        self.name, self.type, self.stat, self.input, self.layer = name, mtype, stat, input, layer
        self.src = None  # layer previews: the TOP this pipe reads (a replaced node restarts the stream)
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
        self.bases = {}  # input index -> _Pipe (BASE stream of that TD input)
        self.out = _Pipe("view", 5, "v")
        self._file_replace = os.replace  # test seam for the project / PNG writers
        self._file_results = collections.deque()  # results from worker threads, handled by the pump
        self._sync_file_ops = False  # tests: run file workers inline
        self._load_modules()
        self._reset_state()
        self.stats = {k: collections.deque(maxlen=STAT_WINDOW) for k in (
            "pump", "paste", "cook", "convert", "publish", "readback", "vconvert", "vpublish", "vreadback",
            "apply", "dump", "top", "lpreadback", "lpconvert", "lppublish")}

    # ------------------------------------------------------------------ setup / lifecycle

    def _load_modules(self):
        self.protocol = self.o.op("protocol").module
        self.frames = self.o.op("frames").module
        self.converter = self.frames.WireConverter()
        self.out.type = self.protocol.TYPE_VIEW
        for pipe in self.bases.values():
            pipe.type = self.protocol.TYPE_BASE

    @property
    def base(self):  # the BASE stream of input 1
        return self._base_pipe(1)

    def _base_pipe(self, n):
        pipe = self.bases.get(n)
        if pipe is None:
            pipe = self.bases[n] = _Pipe("base", self.protocol.TYPE_BASE, "", n)
        return pipe

    def _reset_state(self):
        self.token = secrets.token_urlsafe(16)  # per start; required in `ready`, carried in the panel URL
        self.clients = {}
        self.active_id = None
        self._seq = 0
        self._panel_seen = False
        self.doc_w = 0  # document / canvas size
        self.doc_h = 0
        self.has_input = False  # TD input 1 is connected (it drives Follow Input)
        self.in_w = 0  # resolution of input 1 (0 = none)
        self.in_h = 0
        self.in_sizes = {}  # input index -> (w, h) of every connected input whose size is known
        self.in_conn = frozenset()  # physically connected input connectors
        self.n_in = 1  # In TOPs that exist (in1..in<n_in>)
        self._inputs_sent = None  # last `inputs` item list announced
        self._trim_at = None
        self._sync_key = None
        self._file_job = None  # the running Save / Open / PNG export (one at a time)
        self._choose_queue = []  # chooseFile requests waiting for the pump (the dialog is modal: never inside a server callback)
        self._files_sent = None
        self.mode_seen = None  # canvas mode ("input" | "fixed") the document size was last computed for
        self.guides = {"h": [], "v": []}  # stored with the document
        self.brush_presets = []  # v7: DocSpec.brushPresets (stored with the document)
        self.layer_pipes = {}  # v7: layer id -> _Pipe (LAYER_PREVIEW stream of a tdPreview layer)
        self._lp_cursor = None
        self._lp_ids = (None, ())  # (doc_layers object, flagged layer ids)
        self._pbounds = {}  # v7: slot -> (x0, y0, x1, y1) painted bounds (layer pixels), None = known empty; absent = unknown
        self._hint_boxes = {}  # slot -> the padded box last handed to the network
        self._hints_sent = None
        self._active_layer_sent = None
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
        self._conv_cursor = 0  # round robin over inputs that are converting
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
        self._fx_mod = None
        self.network = None
        self.frozen = False
        for pipe in self.bases.values():
            pipe.reset()
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
                                          shape_glsl=shape.text if shape is not None else None, **self._effect_kwargs())
            self._net_mod = mod
            self._fx_mod = self._opt("effects").module if self._opt("effects") is not None else None
        except Exception as e:  # noqa: BLE001
            self.network = None
            self._report("network", e)

    def _effect_kwargs(self):
        """Layer effects for the DocNetwork: the `effects` module DAT and the shader sources embedded as `fx_common` /
        `fx_<type>` DATs (the same files the web preview compiles: shared/effects). Without them (an older COMP) the
        network falls back to the repo files and disables effects when those are missing."""
        eff = self._opt("effects")
        if eff is None:
            return {}
        mod = eff.module
        kw = {"effects": mod}
        build = getattr(mod, "load_shader_texts_from", None)
        if build is None:   # an older effects.py: common + the effect's own shader only
            common = self._opt("fx_common")
            if common is not None:
                shaders = {}
                for t in mod.EFFECT_TYPES:
                    dat = self._opt("fx_" + t)
                    if dat is None:
                        return kw
                    shaders[t] = common.text + "\n" + dat.text
                kw["effect_shaders"] = shaders
            return kw
        texts = {}
        for stem in mod.shader_stems():   # common, every shader and the include libraries (blurlib, filterlib, in2lib)
            dat = self._opt("fx_" + stem)
            if dat is None:
                self._report("effects", RuntimeError(f"shader DAT fx_{stem} is missing: rebuild the component"))
                return kw
            texts[stem] = dat.text
        try:
            kw["effect_shaders"] = build(texts)
        except Exception as e:  # noqa: BLE001
            self._report("effects", e)
        return kw

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
        elif name in ("Projectfile", "Pngfile"):
            self._broadcast_files()
        elif name == "Saveproject":
            self._start_file_op("saveProject", None, None, None)
        elif name == "Openproject":
            self._start_file_op("openProject", None, None, None)
        elif name == "Exportpng":
            self._start_file_op("exportPng", None, None, None)
        elif name in ("Docsizemode", "Docw", "Doch"):
            if self._sized and self._p("Active"):
                self._sync_doc_size()  # (the pump would do it next frame; this keeps clients in step with the parameter)
        elif name == "Premultiplied":
            # Buffers (and the stored input / output frames) were encoded for the old setting: surfaces are
            # re-encoded one per pump (_reencode_one); a slot's encoding is `Premultiplied xor (slot in _stale_enc)`.
            self._stale_enc = {sl for sl in self.surfaces if sl not in self._mask_slots} - self._stale_enc
            self._sync_pack()
            for pipe in list(self.bases.values()):
                self._invalidate(pipe)
            self._invalidate(self.out)
            self._invalidate_previews()
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
        if method == "GET" and path == "/layer":
            return self._serve_pipe(None, "layer", request, response, subscribed_only=True)
        if path == "/history" and method in ("GET", "POST", "OPTIONS"):
            return self._serve_history(method, request, response)
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
            # Re-announce the stored frame(s) (optional `input`: only that input). A notice may be outstanding because
            # the client's fetch failed (or it gave up): forget it, or the client would sit there until marked stalled.
            n = msg.get("input")
            if isinstance(n, int) and not isinstance(n, bool):
                c.notice(n).clear()
            else:
                for note in c.bases.values():
                    note.clear()
        elif t == "doc":
            self._on_doc(c, msg)
        elif t == "requestDoc":
            c.reloading = False
            self._on_request_doc(c)
        elif t in ("saveProject", "openProject", "exportPng"):
            self._on_file_request(c, t, msg)
        elif t == "chooseFile":
            self._on_choose_file(c, msg)
        elif t == "view":
            self._on_view(c, msg)
        elif t == "listTops":
            self._on_list_tops(c, msg)
        elif t == "importTop":
            self._on_import_top(c, msg)
        elif t == "renderLayer":
            self._on_render_layer(c, msg)
        elif t == "activeLayer":
            self._on_active_layer(c, msg)
        elif t == "setCanvas":
            self._on_set_canvas(c, msg)
        elif t == "log":
            self._on_log(msg)
        # unknown message types are ignored (PROTOCOL.md)

    @_guard
    def OnWebSocketBinary(self, client, data, _replay=False):
        c = self.clients.get(client)
        if self._destroyed or c is None or not c.ready or not c.active or c.reloading:
            return  # only the active editor may write surfaces (not while it still holds the document an Open replaced)
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
        self._grow_bounds(hdr.slot, hdr.x, hdr.y, hdr.x + hdr.w, hdr.y + hdr.h)
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
        items = self._input_items()
        self._send(c.id, P.hello(self.doc_w, self.doc_h, self.has_input, self._p("Maxsendfps"), c.active, c.cid,
                                 self.doc_layers is not None, self.doc_rev, self._mode(), items))
        self._send(c.id, P.inputs_msg(items))  # (also in hello.inputs: for pages that only read one of them)
        self._send(c.id, P.files_msg(*self._files_values()))
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
        if not c.active or c.reloading:
            return  # standby clients cannot edit (nor one that still has to reload the document an Open replaced)
        if not _replay and (self._restore_pending or self._held):
            self._hold(c.id, ("doc", c.id, msg), 1024)
            return
        try:
            rev, layers = self.protocol.parse_doc(msg, self._fx())
            guides, _canvas = self.protocol.doc_extras(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad doc: {e}"))
            return
        # (the canvas mode of a doc is informational: the Docsizemode parameter is the single source of truth)
        self._apply_doc(rev, layers, guides, self.protocol.brush_presets_of(msg) if "brushPresets" in msg else None)

    def _surface_sizes(self, layers):
        """{slot: (w, h)} for a layer stack (protocol.slot_sizes; a surface without a size in the spec keeps its buffer's)."""
        return self.protocol.slot_sizes(layers, self.doc_w, self.doc_h,
                                        {s: (b.shape[1], b.shape[0]) for s, b in self.surfaces.items()})

    def _fx(self):
        """The ``effects`` module DAT's module (filter specs / planner), None in an older COMP."""
        op = self._opt("effects")
        return op.module if op is not None else None

    def _apply_doc(self, rev, layers, guides=None, brush_presets=None, unknown=()):
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
        self._track_bounds(slots, fresh, resized, unknown, masks)
        if self.network is not None and (layers != self.doc_layers or not self._net_applied):
            self._push_hints(layers)
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
        if guides is not None:
            self.guides = guides
        if brush_presets is not None:
            self.brush_presets = brush_presets
        history = self._history_get()
        if history is not None and isinstance(self.doc_rev, (int, float)) and isinstance(rev, (int, float)) and rev < history[0]:
            self._history_drop()   # revisions only grow within a document: a lower one is a different (fresh) document
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
        self._send(c.id, self.protocol.doc_state(self.doc_rev, self._layers_with_sizes(self.doc_layers), self.doc_w, self.doc_h, self.guides,
                                                 {"mode": self._mode()}, self.brush_presets))
        for n in c.lp.values():   # the page drops its layer previews when it loads a document: announce the newest frames again
            n.clear()

    def _layers_with_sizes(self, layers):
        """The stack for a client: every pixel / input layer has its surface size (the web engine requires it). Layers that
        came without one (v4 documents, sloppy clients) get the slot's buffer size / the input size / the document size."""
        out = []
        for l in layers:
            if l.get("kind") in ("pixel", "input") and (l.get("surfaceW") is None or l.get("surfaceH") is None):
                if l["kind"] == "input":
                    w, h = self.in_sizes.get(l.get("input")) or (self.doc_w, self.doc_h)
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
            {"rev": self.doc_rev, "layers": self.doc_layers, "guides": self.guides, "canvas": {"mode": self._mode()},
             "brushPresets": self.brush_presets})
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
        msg = {"rev": data.get("rev"), "layers": layers, "guides": data.get("guides"), "canvas": data.get("canvas"),
               "brushPresets": data.get("brushPresets")}
        rev, layers = self.protocol.parse_doc(msg, self._fx())
        guides, canvas = self.protocol.doc_extras(msg)
        return rev, layers, guides, canvas, self.protocol.brush_presets_of(msg)

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
        if self._restore_pending:
            return  # (while a restore waits for the network, the TOPs hold the only copy of the pixels)
        if not self._dirty:
            # TD may have cooked the Script TOPs itself since the last tile (a consumer such as an effect chain pulls them; OnSurfaceCook
            # then cleared their dirty flags): the pixels ARE uploaded, so the clients still get their `applied`
            self._report_applied()
            return
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
            kept = self._history_get()
            if kept is not None:
                self.o.unstore(HISTORY_KEY)   # an exported component carries the document, not the undo history
            try:
                self.o.save(tmp)
            finally:
                if kept is not None:
                    self.o.store(HISTORY_KEY, kept)
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
        rev, layers, guides, canvas, presets = stored
        self._restore_pending = True
        self.doc_layers, self.doc_rev, self.guides, self.brush_presets = layers, rev, guides, presets
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

    # ------------------------------------------------------------------ files (v6: project .redoc, PNG export)
    #
    # Written / read by TD through the File parameters Projectfile / Pngfile (pulses Saveproject, Openproject, Exportpng, or the
    # web messages saveProject / openProject / exportPng). One operation at a time, refused while a restore is pending.
    # Save: the buffers and the document are SNAPSHOT on the main thread (plain copies), then a worker thread converts to straight
    # RGBA8, encodes the PNGs, writes `<path>.part` and renames it. Open: a worker reads, validates and decodes; the main thread
    # then replaces the document (history of the pages is dropped through `reload`). PNG: the output (`out1`) is read back with
    # the budgeted two-step delayed readback, converted per pump, encoded and written by a worker.

    def _files_values(self):
        return str(self._p("Projectfile") or ""), str(self._p("Pngfile") or "")

    def _broadcast_files(self):
        vals = self._files_values()
        if vals == self._files_sent:
            return
        self._files_sent = vals
        msg = self.protocol.files_msg(*vals)
        for cid in self._ready_ids():
            self._send(cid, msg)

    def _file_target(self, op, given):
        """Absolute path for an operation (the parameter, or ``given`` which is written to the parameter first). Raises
        RuntimeError with the reason. Relative paths are relative to the project folder; the ending (.redoc / .png) is
        added when missing."""
        P = self.protocol
        par, ext, default = (("Projectfile", P.PROJECT_EXT, "raster_editor" + P.PROJECT_EXT) if op != "exportPng"
                             else ("Pngfile", P.PNG_EXT, "raster_editor" + P.PNG_EXT))
        if given is not None:
            setattr(self.o.par, par, given)
        raw = str(self._p(par) or "").strip()
        if not raw:
            if op == "openProject":
                raise RuntimeError("Project File is empty: set it to the .redoc file to open")
            raw = default
        path = os.path.expanduser(raw)
        if not os.path.isabs(path):
            path = os.path.join(self._project_folder(), path)
        if op == "openProject":
            if not os.path.isfile(path) and not path.lower().endswith(ext) and os.path.isfile(path + ext):
                path += ext
            if not os.path.isfile(path):
                raise RuntimeError(f"{path} does not exist")
            return path
        if not path.lower().endswith(ext):
            path += ext
        folder = os.path.dirname(path)
        if folder and not os.path.isdir(folder):
            raise RuntimeError(f"folder {folder} does not exist")
        if os.path.isdir(path):
            raise RuntimeError(f"{path} is a folder")
        return path

    def _file_done(self, job, ok, msg=None, path=None):
        """Report the outcome: fileResult to the requester (or every client for a pulse), a Status flash."""
        if self._file_job is job:
            self._file_job = None
        op, path = job["op"], path or job.get("path") or ""
        text = self.protocol.file_result(job.get("rid"), op, ok, path, msg)
        if job.get("client") is not None:
            if job["client"] in self.clients:
                self._send(job["client"], text)
        else:
            for cid in self._ready_ids():
                self._send(cid, text)
        what = {"saveProject": "project saved to", "openProject": "project opened from", "exportPng": "PNG exported to"}[op]
        fail = {"saveProject": "project save failed", "openProject": "project open failed", "exportPng": "PNG export failed"}[op]
        self._flash_status(f"{what} {path}" if ok else f"{fail}: {msg}")
        if not ok:
            print(f"[raster_editor] {fail}: {msg}")

    def _on_file_request(self, c, t, msg):
        P = self.protocol
        try:
            rid, given = P.parse_file_request(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad {t}: {e}"))
            return
        self._start_file_op(t, c, rid, given, msg.get("includeHistory") is not False)

    @_guard
    def SaveProject(self):
        self._start_file_op("saveProject", None, None, None)

    @_guard
    def OpenProject(self):
        self._start_file_op("openProject", None, None, None)

    @_guard
    def ExportPng(self):
        self._start_file_op("exportPng", None, None, None)

    def _start_file_op(self, op, c, rid, given, include_history=True):
        job = {"op": op, "client": c.id if c is not None else None, "rid": rid, "path": given or "", "stage": "start",
               "started": self._now(), "history": include_history}
        try:
            if not self._p("Active"):
                raise RuntimeError("the editor is not active")
            if self._file_job is not None:
                raise RuntimeError(f"busy: {self._file_job['op']} is still running")
            if self._restore_pending or self._held or self._saving:
                raise RuntimeError("TouchDesigner is still restoring the document; try again in a moment")
            job["path"] = self._file_target(op, given)
            self._broadcast_files()
            if op == "exportPng" and (self.network is None or not self._net_applied):
                raise RuntimeError("there is no output to export yet")
            self._file_job = job
            {"saveProject": self._begin_save, "openProject": self._begin_open, "exportPng": self._begin_png}[op](job)
        except Exception as e:  # noqa: BLE001 - reported to the requester, never raised into TD
            self._file_done(job, False, str(e))

    def _run_worker(self, job, fn):
        """Run ``fn`` (pure file / numpy work, no TD access) off the main thread; its result is handled by the pump."""
        def work():
            try:
                res = ("ok", fn())
            except Exception as e:  # noqa: BLE001
                res = ("error", f"{type(e).__name__}: {e}" if not isinstance(e, (RuntimeError, ValueError)) else str(e))
            self._file_results.append((job, res))
        job["stage"] = "worker"
        if self._sync_file_ops:
            work()
            return
        threading.Thread(target=work, name="raster_editor_files", daemon=True).start()

    def _tick_files(self, now):
        while self._file_results:
            job, (status, val) = self._file_results.popleft()
            if self._file_job is not job:
                continue  # (the operation was abandoned)
            try:
                if status != "ok":
                    self._file_done(job, False, val)
                elif job["op"] == "openProject":
                    self._finish_open(job, val)
                else:
                    self._file_done(job, True)
            except Exception as e:  # noqa: BLE001
                self._file_done(job, False, f"{type(e).__name__}: {e}")
        job = self._file_job
        if job is not None and job["stage"] in ("png_read", "png_convert"):
            try:
                self._png_step(job, now)
            except Exception as e:  # noqa: BLE001
                self._file_done(job, False, f"{type(e).__name__}: {e}")

    # --- save

    def _project_doc(self):
        """The document as stored in doc.json: layers (with surface sizes), guides, canvas, document size."""
        layers = self._layers_with_sizes(self.doc_layers if self.doc_layers is not None else self._default_layers())
        return self.protocol.encode_json({"rev": self.doc_rev if self.doc_rev is not None else 0, "layers": layers,
                                          "guides": self.guides, "canvas": {"mode": self._mode()},
                                          "brushPresets": self.brush_presets,
                                          "width": self.doc_w, "height": self.doc_h})

    def _begin_save(self, job):
        while self._stale_enc:  # buffers still in the previous Premultiplied encoding
            self._reencode_one()
        doc_json = self._project_doc()
        snap = {s: (self.surfaces[s].copy(), self._slot_premult(s)) for s in sorted(self._slot_set) if s in self.surfaces}
        meta = {"format": self.protocol.PROJECT_FORMAT, "app": "raster-editor", "version": self.protocol.APP_VERSION,
                "slots": len(snap)}
        hist = self._history_get()   # the undo history belongs to the document only when it is the stored revision's
        blob = hist[2] if job.get("history", True) and hist is not None and hist[0] == self.doc_rev and hist[2] else None
        if blob is not None:
            meta["historyRev"] = hist[1]
        path, frames, replace = job["path"], self.frames, self._file_replace

        def write():
            def surfaces():
                for slot in sorted(snap):
                    buf, premult = snap.pop(slot)
                    yield slot, frames.buffer_to_straight(buf, premult)
            frames.write_redoc(path, doc_json, surfaces(), meta, PNG_LEVEL, replace, history=blob)
        self._run_worker(job, write)

    # --- open

    def _begin_open(self, job):
        path, P, frames = job["path"], self.protocol, self.frames
        premult = bool(self._p("Premultiplied"))
        job["premult"] = premult
        cur_w, cur_h = self.doc_w, self.doc_h
        fx = self._fx()

        def read():
            doc, meta, pngs, history = frames.read_redoc(path, P.PROJECT_FORMAT, True)
            try:
                rev, layers = P.parse_doc({"rev": doc.get("rev", 0), "layers": doc.get("layers"),
                                           "guides": doc.get("guides"), "canvas": doc.get("canvas"),
                                           "brushPresets": doc.get("brushPresets")}, fx)
            except P.ProtocolError as e:
                raise RuntimeError(f"invalid document in project file: {e}") from None
            guides, canvas = P.doc_extras(doc)
            w, h = doc.get("width"), doc.get("height")
            ok = all(isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= P.MAX_CANVAS_DIM for v in (w, h))
            if not ok:
                w, h = cur_w, cur_h
            known = {}  # slots whose layer spec states the size
            for l in layers:
                if l.get("surfaceW") is not None and l.get("surfaceH") is not None:
                    m = l.get("mask")
                    for s in (l.get("slot"), m.get("slot") if isinstance(m, dict) else None):
                        if s is not None:
                            known[s] = (int(l["surfaceW"]), int(l["surfaceH"]))
            bufs, total = {}, 0
            for slot in P.layer_slots(layers):
                if slot not in pngs:
                    raise RuntimeError(f"project file has no surface for slot {slot}")
                sw, sh = frames.png_size(pngs[slot])
                if slot in known and known[slot] != (sw, sh):
                    raise RuntimeError(f"surface {slot} is {sw}x{sh}, the document says {known[slot][0]}x{known[slot][1]}")
                total += sw * sh
                if total > 3 * frames.PNG_MAX_PIXELS:
                    raise RuntimeError("project file holds too many pixels")
                img = frames.decode_png(pngs.pop(slot))
                bufs[slot] = frames.straight_to_buffer(img, premult)
                del img
            return {"rev": rev, "layers": layers, "guides": guides, "canvas": canvas, "w": w, "h": h, "bufs": bufs,
                    "meta": meta, "history": history, "presets": P.brush_presets_of(doc)}
        self._run_worker(job, read)

    def _finish_open(self, job, data):
        """Main thread: replace the document with the one a worker read (nothing is changed when an earlier step failed)."""
        if self._restore_pending or self._held:
            raise RuntimeError("TouchDesigner started restoring the document meanwhile; open again")
        P = self.protocol
        layers, bufs = data["layers"], data["bufs"]
        w, h = data["w"], data["h"]
        if str(self._p("Docsizemode")) != data["canvas"]["mode"]:
            self.o.par.Docsizemode = data["canvas"]["mode"]
        if (int(self._p("Docw")), int(self._p("Doch"))) != (w, h):
            self.o.par.Docw, self.o.par.Doch = w, h
        self._client_canvas = True  # (a parameter flip made by us, not a user's Follow Input -> Fixed edit)
        try:
            self._sync_doc_size()
        finally:
            self._client_canvas = False
        rev = max(self.doc_rev if isinstance(self.doc_rev, (int, float)) else 0, data["rev"]) + 1   # always monotonic
        self._reset_previews()
        self._apply_doc(rev, layers, data["guides"], data.get("presets") or [], unknown=tuple(bufs))
        self._history_drop()   # (only after the document was replaced) the old history belonged to the old document
        hist_rev = (data.get("meta") or {}).get("historyRev")
        if data.get("history") and hist_rev is not None and hist_rev == data["rev"]:
            self._history_set(rev, hist_rev, data["history"])   # served for the new doc rev; the blob keeps the rev it embeds
        convert = bool(self._p("Premultiplied")) != job["premult"]  # toggled while the worker ran: re-encode
        for slot, buf in bufs.items():
            if convert and slot not in self._mask_slots:
                self.frames.convert_premultiplication(buf, bool(self._p("Premultiplied")))
            self.surfaces[slot] = buf
            self._slot_size[slot] = (buf.shape[1], buf.shape[0])
            self._stale_enc.discard(slot)
            self._dirty.add(slot)
        self._adjust_inputs(self._mode(), False, {}, self.in_sizes)  # input layers follow the live input resolutions
        self._flush_doc_state()
        for c in self.clients.values():
            c.reloading = c.ready
        for note in (n for c in self.clients.values() for n in c.bases.values()):
            note.clear()
        msg = P.reload_msg(self.doc_rev)
        for cid in self._ready_ids():
            self._send(cid, msg)
        self._waiters = []
        self._file_done(job, True)

    # --- PNG export

    def _begin_png(self, job):
        job["stage"] = "png_read"
        job["calls"] = 0
        self._png_step(job, self._now())

    def _png_step(self, job, now):
        top = self._opt("out1")
        if top is None:
            raise RuntimeError("the component has no out1")
        if job["stage"] == "png_read":
            if now - job["started"] > PNG_READ_TIMEOUT_S:
                raise RuntimeError("readback failed: timed out")
            w, h = int(top.width), int(top.height)
            if (w, h) != (self.doc_w, self.doc_h):
                job["calls"] = 0
                if now - job["started"] > 1.0 and job.get("size_wait"):
                    raise RuntimeError(f"the output is {w}x{h}, the document {self.doc_w}x{self.doc_h}")
                job["size_wait"] = True
                return
            arr = top.numpyArray(delayed=True)  # first call issues the read, the next returns it (never waits for the GPU)
            job["calls"] += 1
            if job["calls"] < 2 or arr is None:
                return
            if tuple(arr.shape[:2]) != (h, w):
                job["calls"] = 0
                return
            job.update(stage="png_convert", arr=arr, out=np.empty(arr.shape, np.uint8), row=0, rows=64,
                       unpre=bool(self._p("Premultiplied")))
        arr, out = job["arr"], job["out"]
        h, start = arr.shape[0], self._now()
        while job["row"] < h:
            r0 = job["row"]
            r1 = min(h, r0 + job["rows"])
            t = self._now()
            self.converter.convert_rows(arr, out, r0, r1, job["unpre"])
            dt = self._now() - t
            job["row"] = r1
            if dt > 0:
                job["rows"] = max(16, int(job["rows"] * (CONVERT_BUDGET_S / 3) / dt))
            if self._now() - start >= CONVERT_BUDGET_S:
                break
        if job["row"] < h:
            return
        path, frames, replace = job["path"], self.frames, self._file_replace
        job.pop("arr"), job.pop("out")
        self._run_worker(job, lambda: frames.write_png_file(path, out, PNG_LEVEL, replace))

    # ------------------------------------------------------------------ chooseFile / placeImage (v6)
    #
    # The editor panel is a windowless browser: <input type=file>, showOpenFilePicker and OS drag-drop do not work there, so the
    # page asks TD. `ui.chooseFile` is a MODAL native dialog: it blocks TD's main thread (and so the pump, the server callbacks
    # and the output cook) until the user answers, so it never runs inside a server callback but from the next pump, and one at
    # a time. `placeImage` then loads the file with a temporary Movie File In TOP and serves it exactly like an imported TOP
    # (`topReady` + GET /top with the same requestId).

    IMAGE_MAX_BYTES = 512 << 20

    def _choose_dialog(self, purpose, types=()):  # pragma: no cover - needs TD (test seam)
        P = self.protocol
        if purpose == "readText":
            return ui.chooseFile(load=True, fileTypes=list(types) or None, title="Open file")  # noqa: F821
        if purpose == "placeImage":
            return ui.chooseFile(load=True, fileTypes=list(P.IMAGE_EXTS), title="Place image")  # noqa: F821
        if purpose == "openProject":
            return ui.chooseFile(load=True, start=self._p("Projectfile") or None, fileTypes=["redoc"], title="Open project")  # noqa: F821
        if purpose == "saveProject":
            return ui.chooseFile(load=False, start=self._p("Projectfile") or "raster_editor.redoc", fileTypes=["redoc"], title="Save project")  # noqa: F821
        return ui.chooseFile(load=False, start=self._p("Pngfile") or "raster_editor.png", fileTypes=["png"], title="Export PNG")  # noqa: F821

    def _make_movie(self, path, tag):  # pragma: no cover - needs TD (test seam)
        t = self.o.create("moviefileinTOP", f"_imp_mov{tag}")
        t.par.file = path
        return t

    def _on_choose_file(self, c, msg):
        P = self.protocol
        try:
            rid, purpose = P.parse_choose_file(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad chooseFile: {e}"))
            return
        test = msg.get("testPath") if self._test_enabled() and "testPath" in msg else False   # validation stub (Panelquery test=1)
        if len(self._choose_queue) >= 4 or any(q[0] == c.id for q in self._choose_queue):
            self._send(c.id, P.file_chosen(rid, None))   # one dialog per client at a time
            return
        self._choose_queue.append((c.id, rid, purpose, test, P.parse_choose_types(msg)))

    def _tick_choose(self):
        if not self._choose_queue:
            return
        cid, rid, purpose, test, types = self._choose_queue.pop(0)
        P = self.protocol
        path = None
        try:
            path = test if test is not False else (self._choose_dialog(purpose, types) if types else self._choose_dialog(purpose))
        except Exception as e:  # noqa: BLE001 - no dialog available (headless): behave like cancel
            self._report("chooseFile", e)
        path = str(path) if path else None
        c = self.clients.get(cid)
        if c is None:
            return
        if purpose == "readText" and path:
            text, err = self._read_text_file(path)
            self._send(cid, P.file_chosen(rid, path, text, err))
            return
        self._send(cid, P.file_chosen(rid, path))
        if purpose == "placeImage" and path:
            self._place_image(c, rid, path)

    def _read_text_file(self, path):
        """(text, None) or (None, error): UTF-8 text up to MAX_TEXT_FILE_BYTES; larger, binary (NUL) or undecodable files are refused."""
        limit = self.protocol.MAX_TEXT_FILE_BYTES
        name = os.path.basename(path)
        try:
            with open(path, "rb") as f:
                data = f.read(limit + 1)
        except OSError as e:
            return None, f"cannot read {name}: {e.strerror or e}"
        if len(data) > limit:
            return None, f"{name} is too large (limit {limit >> 20} MB)"
        if b"\0" in data:
            return None, f"{name} is a binary file"
        try:
            return data.decode("utf-8-sig"), None
        except UnicodeDecodeError:
            return None, f"{name} is not UTF-8 text"

    def _place_image(self, c, rid, path):
        P = self.protocol
        ext = os.path.splitext(path)[1].lstrip(".").lower()
        try:
            size = os.path.getsize(path)
        except OSError:
            self._send(c.id, P.top_error(rid, f"{path} does not exist"))
            return
        if not os.path.isfile(path) or ext not in P.IMAGE_EXTS:
            self._send(c.id, P.top_error(rid, f"{os.path.basename(path)} is not a supported image file ({', '.join(P.IMAGE_EXTS)})"))
            return
        if size > self.IMAGE_MAX_BYTES:
            self._send(c.id, P.top_error(rid, f"{os.path.basename(path)} is too large ({size >> 20} MB)"))
            return
        job = {"client": c.id, "ccid": c.cid, "rid": rid, "path": None, "file": path, "stage": "read", "calls": 0,
               "started": None, "scaler": None, "temps": [], "movie": None}
        self._enqueue_job(c, rid, job)
        if job in self._imp_queue or self._imp is job:
            try:
                job["movie"] = self._make_movie(path, f"{id(job) & 0xFFFF:04x}")
            except Exception as e:  # noqa: BLE001
                self._top_fail(job, f"cannot load {os.path.basename(path)}: {e}")

    # ------------------------------------------------------------------ viewport (view messages)

    # ------------------------------------------------------------------ v7: activeLayer, content bounds, hints

    def _on_active_layer(self, c, msg):
        """`activeLayer {id}`: the active editor's active layer. A hint for the network (merged passes are split around it so an
        edit recooks only the layer's own pass and what is above it); applied by ``_sync_hints`` at the next pump."""
        try:
            c.active_layer = self.protocol.parse_active_layer(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad activeLayer: {e}"))

    def _grow_bounds(self, slot, x0, y0, x1, y1):
        """A SURFACE band was pasted into ``slot``: its rect joins the painted bounds (layer pixels). Unknown stays unknown."""
        if slot not in self._pbounds:
            return
        b = self._pbounds[slot]
        self._pbounds[slot] = (x0, y0, x1, y1) if b is None else (min(b[0], x0), min(b[1], y0), max(b[2], x1), max(b[3], y1))

    def _track_bounds(self, slots, fresh, resized, unknown, masks=()):
        """Painted bounds per slot (superset of the non-transparent pixels, from the SURFACE tiles): a slot that appears blank is
        known empty (until a tile arrives); anything that fills a buffer by another route (restore, Open Project, a resized
        surface, the undo cache) leaves its bounds unknown (no hint); a removed slot is forgotten."""
        for s in [s for s in self._pbounds if s not in slots]:
            del self._pbounds[s]
            self._hint_boxes.pop(s, None)
        for s in fresh:
            self._hint_boxes.pop(s, None)
            if self._restore_pending or s in unknown or s in masks:
                self._pbounds.pop(s, None)
            else:
                self._pbounds[s] = None
        for s in list(resized) + [u for u in unknown if u in slots]:
            self._pbounds.pop(s, None)
            self._hint_boxes.pop(s, None)

    @staticmethod
    def _transformed(l):
        """Does the layer need a resample pass (anything but an integer offset at scale 1)?"""
        return (l.get("sx", 1) != 1 or l.get("sy", 1) != 1 or l.get("rot", 0) != 0 or l.get("kx", 0) != 0 or l.get("ky", 0) != 0
                or float(l.get("x", 0) or 0) != int(l.get("x", 0) or 0) or float(l.get("y", 0) or 0) != int(l.get("y", 0) or 0))

    def _content_hints(self, layers):
        """{layer id: box | None} for ``network.set_content_bounds``: a known-empty pixel layer (None: skipped by the network) and,
        for a transformed layer, its padded painted box (grown only when the painted bounds leave it). Unknown layers: no hint."""
        out = {}
        for l in layers or ():
            s = l.get("slot")
            if l.get("kind") != "pixel" or s is None or s not in self._pbounds:
                continue
            b = self._pbounds[s]
            if b is None:
                out[l["id"]] = None
                self._hint_boxes.pop(s, None)
            elif self._transformed(l):
                sw, sh = self._slot_size.get(s) or (self.doc_w, self.doc_h)
                box = self._hint_boxes.get(s)
                if box is None or b[0] < box[0] or b[1] < box[1] or b[2] > box[2] or b[3] > box[3]:
                    g = HINT_GRID
                    lo = [(v - HINT_PAD) // g * g for v in b[:2]]
                    hi = [-(-(v + HINT_PAD) // g) * g for v in b[2:]]
                    if box is not None:
                        lo, hi = [min(lo[0], box[0]), min(lo[1], box[1])], [max(hi[0], box[2]), max(hi[1], box[3])]
                    box = self._hint_boxes[s] = (max(0, lo[0]), max(0, lo[1]), min(sw, hi[0]), min(sh, hi[1]))
                out[l["id"]] = box
        return out

    def _push_hints(self, layers):
        """Hand the content bounds and the active layer to the network (it applies them at its next apply()); returns True when
        either changed."""
        net, changed = self.network, False
        if net is None:
            return False
        fn = getattr(net, "set_content_bounds", None)
        if fn is not None:
            hints = self._content_hints(layers)
            if hints != self._hints_sent:
                fn(hints)
                self._hints_sent = hints
                changed = True
        fn = getattr(net, "set_active_layer", None)
        if fn is not None:
            act = self.clients.get(self.active_id)
            lid = act.active_layer if act is not None else None
            if lid != self._active_layer_sent:
                fn(lid)
                self._active_layer_sent = lid
                changed = True
        return changed

    def _sync_hints(self):
        """Pump step: new painted bounds / a new active layer re-plan the network once (before the surfaces are uploaded)."""
        if self.network is None or not self._net_applied or self.doc_layers is None or self._restore_pending or self._held:
            return
        if self._push_hints(self.doc_layers):
            self.network.apply(self.doc_layers, self.doc_w, self.doc_h)

    # ------------------------------------------------------------------ v7: history persistence (POST/GET /history)

    def _history_get(self):
        """(docRev, histRev, blob) stored in the COMP's storage (saved with the .toe), or None. ``docRev`` = the document rev the history is
        served for (what the page compares with the rev it loaded); ``histRev`` = the rev embedded in the blob (what the page's restore checks)."""
        try:
            v = self.o.fetch(HISTORY_KEY, None)
        except Exception:  # noqa: BLE001
            return None
        if isinstance(v, tuple) and len(v) == 3 and isinstance(v[2], (bytes, bytearray)):
            return v
        return None

    def _history_set(self, doc_rev, hist_rev, blob):
        self.o.store(HISTORY_KEY, (doc_rev, hist_rev, blob))   # one object: the replacement is atomic

    def _history_drop(self):
        if self._history_get() is not None:
            self.o.unstore(HISTORY_KEY)

    @staticmethod
    def _body_bytes(data):
        if isinstance(data, bytes):
            return data
        if isinstance(data, (bytearray, memoryview)):
            return bytes(data)
        if isinstance(data, str):
            return data.encode("latin-1", "surrogateescape")
        return b""

    def _serve_history(self, method, request, response):
        """`POST /history?token&client&rev` (body = the page's history blob, <= 256 MB, active editor) -> 204 (an empty body clears it);
        `GET /history?token&client` -> 200 blob + `X-Doc-Rev`, or 404. The body is delivered by the HTTP server; storing the bytes
        object is a reference assignment (no copy for a bytes body)."""
        P = self.protocol
        if method == "OPTIONS":   # CORS preflight of a page served from a dev origin
            response["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response["Access-Control-Allow-Headers"] = "Content-Type"
            response["Access-Control-Max-Age"] = "600"
            return self._cors(request, self._reply(response, 204, "No Content"))
        pars = request.get("pars") or {}
        if not self._token_ok(pars.get("token")):
            return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
        c = next((x for x in self.clients.values() if x.cid == pars.get("client") and x.ready), None)
        if c is None:
            return self._cors(request, self._reply(response, 403, "Forbidden", "unknown client"))
        response["Access-Control-Expose-Headers"] = "X-Doc-Rev, X-History-Rev"
        if method == "GET":
            h = self._history_get()
            if h is None or not h[2]:
                return self._cors(request, self._reply(response, 404, "Not Found", "no history"))
            response["X-Doc-Rev"] = str(h[0])
            response["X-History-Rev"] = str(h[1])
            response["Cache-Control"] = "no-store"
            return self._cors(request, self._reply(response, 200, "OK", h[2], "application/octet-stream"))
        if not c.active:
            return self._cors(request, self._reply(response, 409, "Conflict", "only the active editor stores history"))
        try:
            rev = P.parse_history_rev(pars)
        except P.ProtocolError as e:
            return self._cors(request, self._reply(response, 400, "Bad Request", str(e)))
        for k, v in request.items():   # refuse by the declared length when the server passes the headers on (the body is already read otherwise)
            if str(k).lower() == "content-length":
                try:
                    if int(v) > HISTORY_MAX_BYTES:
                        return self._cors(request, self._reply(response, 413, "Payload Too Large", "history too large"))
                except (TypeError, ValueError):
                    pass
        data = request.get("data", b"")
        if data is None or len(data) > HISTORY_MAX_BYTES:
            return self._cors(request, self._reply(response, 413, "Payload Too Large", "history too large"))
        if len(data) == 0:
            self._history_drop()
        else:
            self._history_set(rev, rev, self._body_bytes(data))
        return self._cors(request, self._reply(response, 204, "No Content"))

    # ------------------------------------------------------------------ v7: tdPreview layer stream (GET /layer)

    def _preview_layer_ids(self):
        """Layers of the document whose effects / filter adjustment include a planner-flagged ``tdPreview`` effect (cached per stack)."""
        layers = self.doc_layers
        listed = getattr(self.network, "preview_layers", None)   # the network knows which chains are live
        if listed is not None:
            try:
                live = set(listed())
            except Exception as e:  # noqa: BLE001
                self._report("preview layers", e)
                live = set()
            return tuple(l["id"] for l in layers or () if l["id"] in live and l.get("visible") is not False)
        if self._lp_ids[0] is layers and layers is not None:
            return self._lp_ids[1]
        fx = self._fx()
        ids = []
        flag = getattr(fx, "effect_td_preview", None)
        for l in layers or ():
            if flag is None or l.get("visible") is False:
                continue
            effs = list(l.get("effects") or ())
            a = l.get("adjustment")
            if l.get("kind") == "adjustment" and isinstance(a, dict) and a.get("type") == "filter" and isinstance(a.get("effect"), dict):
                effs.append(a["effect"])
            for e in effs:
                try:
                    if isinstance(e, dict) and flag(e):
                        ids.append(l["id"])
                        break
                except Exception:  # noqa: BLE001 - an effect the planner cannot read draws nothing
                    pass
        self._lp_ids = (layers, tuple(ids))
        return self._lp_ids[1]

    def _drop_layer_pipe(self, lid):
        self.layer_pipes.pop(lid, None)
        for c in self.clients.values():
            c.lp.pop(lid, None)

    def _reset_previews(self):
        for lid in list(self.layer_pipes):
            self._drop_layer_pipe(lid)
        self._lp_ids = (None, ())

    def _invalidate_previews(self):
        for pipe in list(self.layer_pipes.values()):
            self._invalidate(pipe)

    def _poll_layer_previews(self, now):
        """One LAYER_PREVIEW stream per flagged layer, only while an editor is active: change detection by the source TOP's cook count
        (a static layer is never read back again), the same two-step delayed readback and budgeted conversion as VIEW (one layer
        converts per pump, round robin), published as frame type 7 for GET /layer."""
        net = self.network
        fn = getattr(net, "layer_preview_source", None)
        tokfn = getattr(net, "layer_preview_token", None)
        active = any(c.ready and c.active for c in self.clients.values())
        ids = self._preview_layer_ids() if active and net is not None and self._net_applied and fn is not None else ()
        for lid in [l for l in self.layer_pipes if l not in ids]:
            self._drop_layer_pipe(lid)
        if not ids:
            return
        period = 1.0 / max(1, self._p("Maxviewfps"))
        order = list(ids)
        k = order.index(self._lp_cursor) + 1 if self._lp_cursor in order else 0
        converting = False
        for lid in order[k:] + order[:k]:
            try:
                top = fn(lid)
            except Exception as e:  # noqa: BLE001
                self._report("layer preview", e)
                top = None
            pipe = self.layer_pipes.get(lid)
            if top is None:
                if pipe is not None and (pipe.msg is not None or pipe.conv is not None or pipe.inflight is not None):
                    pipe.reset()
                continue
            if pipe is None:
                pipe = self.layer_pipes[lid] = _Pipe("layer", self.protocol.TYPE_LAYER_PREVIEW, "lp", layer=lid)
            if pipe.src is not top:   # the node behind the layer was replaced: its readback state is void
                pipe.src = top
                pipe.cooks = None
                pipe.conv = None
                pipe.inflight = None
                pipe.pending = True
            was = pipe.conv is not None
            key = None
            if tokfn is not None:
                try:
                    key = tokfn(lid)
                except Exception as e:  # noqa: BLE001
                    self._report("layer preview token", e)
            self._poll_pipe(pipe, top, now, period, True, (self.doc_w, self.doc_h), convert=not converting, key=key,
                            rekey=(lambda lid=lid: tokfn(lid)) if tokfn is not None else None)
            if not converting and (was or pipe.conv is not None):
                converting = True
                self._lp_cursor = lid

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
                ("hints", self._sync_hints),
                ("input", lambda: self._poll_base(now)), ("output", lambda: self._poll_view(now)),
                ("layers", lambda: self._poll_layer_previews(now)),
                ("notify", lambda: self._notify_clients(now)), ("tops", lambda: self._tick_tops(now)),
                ("surfaces", self._cook_surfaces), ("files", lambda: self._tick_files(now)), ("choose", self._tick_choose),
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
        fx = self._opt("effects")
        if self.network is not None and (self._op("network").module is not self._net_mod
                                         or (fx.module if fx is not None else None) is not self._fx_mod):
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
        """The stack before any client sent a document: one input layer per connected input (input 1 alone when none is
        connected: it renders transparent). In Fixed mode an input is fitted (contain) and centred like the web engine
        does; in Follow Input mode input 1 has the identity transform."""
        out = []
        for n in sorted(self.in_sizes) or [1]:
            lay = dict(DEFAULT_LAYER, id=f"input{n}", input=n, name=f"TD Input {n}", effects=[])
            size = self.in_sizes.get(n)
            if size is not None:
                iw, ih = size
                lay["surfaceW"], lay["surfaceH"] = iw, ih
                if self._mode() == "fixed":
                    k = min(self.doc_w / iw, self.doc_h / ih)
                    lay.update(sx=k, sy=k, x=round((self.doc_w - iw * k) / 2), y=round((self.doc_h - ih * k) / 2))  # whole pixels
            else:
                lay["surfaceW"], lay["surfaceH"] = self.doc_w, self.doc_h
            out.append(lay)
        return out

    def _apply_network(self):
        if self.network is None:
            return
        t = self._now()
        layers = self.doc_layers if self.doc_layers is not None else self._default_layers()
        self.network.apply(layers, self.doc_w, self.doc_h)
        self._network_applied()
        self.stats["apply"].append(self._now() - t)

    # --- TD inputs (v6: in1..in8 In TOPs, always one spare unconnected connector)

    def _count_in_ops(self):
        n = 0
        while n < MAX_INPUTS and self._opt(f"in{n + 1}") is not None:
            n += 1
        return n

    def _scan_inputs(self):
        """(connected connector indices, {input: (w, h)} of the connected inputs whose size is known). An input that
        reports 0x0 while it (re)starts keeps the size we knew; one never seen yet is left out until it has one."""
        conns = list(getattr(self.o, "inputConnectors", None) or [])
        connected = frozenset(i + 1 for i, k in enumerate(conns[:MAX_INPUTS]) if k.connections)
        sizes = {}
        for n in sorted(connected):
            top = self._opt(f"in{n}")
            if top is None:
                continue
            top.cook()
            w, h = int(top.width), int(top.height)
            if w >= 1 and h >= 1:
                sizes[n] = (min(w, 0xFFFF), min(h, 0xFFFF))
            elif n in self.in_sizes:
                sizes[n] = self.in_sizes[n]
        return connected, sizes

    def _ensure_input_ops(self, connected):
        """In TOPs in1..inN with N = highest connected input + 1 (max 8): always exactly one spare unconnected connector
        behind the last connected one. Input ``n`` is the In TOP ``in<n>`` with ``Connector Order`` n = connector n-1
        (verified in TD 2025: the order parameter, not node position / creation order, decides). A trailing In TOP
        beyond the spare is removed INPUT_TRIM_S after it became unneeded; one that is connected is never removed
        (N is computed from the connected ones)."""
        want = min(MAX_INPUTS, max(connected, default=0) + 1)
        have = self._count_in_ops()
        while have < want:
            have += 1
            top = self.o.create("inTOP", f"in{have}")
            top.par.connectorder = have
            top.nodeX, top.nodeY = -300, 150 - 100 * have
        if have > want:
            now = self._now()
            if self._trim_at is None:
                self._trim_at = now + INPUT_TRIM_S
            elif now >= self._trim_at:
                self._trim_at = None
                while have > want and have > 1 and have not in connected:
                    try:
                        self._opt(f"in{have}").destroy()
                    except Exception as e:  # noqa: BLE001
                        self._report("remove spare input", e)
                        break
                    have -= 1
        else:
            self._trim_at = None
        self.n_in = max(1, have)

    def _items_for(self, sizes, n_in):
        return [{"input": n, "w": sizes[n][0] if n in sizes else 0, "h": sizes[n][1] if n in sizes else 0,
                 "connected": n in sizes} for n in range(1, n_in + 1)]

    def _input_items(self):
        """[{input, w, h, connected}] for every In TOP that exists (`hello.inputs` / the `inputs` message)."""
        return self.protocol.input_items(self._items_for(self.in_sizes, self.n_in))

    def _sync_doc_size(self):
        """Document size, TD inputs and canvas mode (v6). Follow Input: document = size of input 1 (`Docw x Doch` with it
        unconnected); Fixed: `Docw x Doch`. Surfaces keep their own sizes: nothing is reallocated here (a canvas resize never
        resamples pixels); only the first call allocates the surfaces of a restored document. Changes are announced to every
        client: `docSize` (document size / mode / hasInput) and `inputs` (connections / resolutions)."""
        connected, sizes = self._scan_inputs()
        self._ensure_input_ops(connected)
        mode = self._mode()
        has_input = 1 in connected
        iw, ih = sizes.get(1, (0, 0))
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
        items = self._items_for(sizes, self.n_in)
        key = (w, h, has_input, iw, ih, mode, tuple((i["input"], i["w"], i["h"], i["connected"]) for i in items))
        if self._sized and key == self._sync_key:
            return
        self._sync_key = key
        first = not self._sized
        size_changed = (w, h) != (self.doc_w, self.doc_h)
        mode_changed = mode != self.mode_seen
        old_sizes = self.in_sizes
        inputs_changed = items != self._inputs_sent
        if first:
            # a restored document: allocate every surface at its own size (a v4 document without sizes: the document's)
            if self.doc_layers is not None:
                self._slot_size = self.protocol.slot_sizes(self.doc_layers, w, h)
            surfaces = {s: self.frames.resize_buffer(self.surfaces.get(s), *self._slot_size.get(s, (w, h)), s in self._mask_slots)
                        for s in set(self.surfaces) | self._slot_set}
            self.surfaces = surfaces
            self._dirty = set(surfaces)  # push the buffers so the Script TOPs take their sizes
        prev_input = self.has_input
        self.doc_w, self.doc_h, self.has_input = w, h, has_input
        self.in_w, self.in_h = iw, ih
        self.in_sizes, self.in_conn = sizes, connected
        self.mode_seen = mode
        self._sized = True
        if size_changed or first:
            self._invalidate(self.out)
            self._invalidate_previews()
            self._panel_key = None
        for n in set(old_sizes) | set(sizes):  # a changed / (dis)connected input starts a fresh BASE stream
            if first or old_sizes.get(n) != sizes.get(n):
                pipe = self._base_pipe(n)
                self._invalidate(pipe)
                pipe.pending = n in sizes
        if mode_changed and not first:
            self._doc_state_dirty = True  # the stored canvas mode follows the parameter
        if not first:
            ids = self._ready_ids()
            if size_changed or mode_changed or has_input != prev_input:
                msg = self.protocol.doc_size(w, h, has_input, mode)
                for cid in ids:
                    if cid != self._canvas_sender:
                        self._send(cid, msg)
            if inputs_changed:
                msg = self.protocol.inputs_msg(items)
                for cid in ids:
                    self._send(cid, msg)
        self._inputs_sent = items
        if not first:
            self._adjust_inputs(mode, mode_changed, old_sizes, sizes)
        set_inputs = getattr(self.network, "set_inputs", None)
        if set_inputs is not None:
            set_inputs(self.protocol.input_items(items))
        else:
            flag = getattr(self.network, "set_input_connected", None)
            if flag is not None:
                flag(has_input)
        self._apply_network()
        self._status_at = 0.0

    def _adjust_inputs(self, mode, mode_changed, old_sizes, new_sizes):
        """Keep the stored input layers right without a page: switching to Follow Input resets the transform of input 1 to the
        identity; an input resolution change updates the layer's surface size and (Fixed mode, or any input but input 1)
        rescales sx / sy so the displayed box (surface size x scale) stays the same."""
        layers = self.doc_layers
        if not layers:
            return
        out, changed = [], False
        for l in layers:
            if l.get("kind") != "input":
                out.append(l)
                continue
            n = l.get("input")
            b = dict(l)
            if mode_changed and mode == "input" and n == 1:
                b.update(x=0, y=0, sx=1, sy=1, rot=0, kx=0, ky=0)
            new = new_sizes.get(n)
            if new is not None:
                iw, ih = new
                ow, oh = b.get("surfaceW"), b.get("surfaceH")
                if (ow, oh) != (iw, ih):
                    if (mode == "fixed" or n != 1) and old_sizes.get(n) is not None and ow and oh:
                        b["sx"] = b.get("sx", 1) * ow / iw
                        b["sy"] = b.get("sy", 1) * oh / ih
                    b["surfaceW"], b["surfaceH"] = iw, ih
            changed = changed or b != l
            out.append(b)
        if changed:
            self.doc_layers = out
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
        movie = job.pop("movie", None)
        if movie is not None:
            try:
                movie.destroy()
            except Exception:  # noqa: BLE001
                pass
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
            if str(getattr(k, "name", "")).startswith(("_imp_sel", "_imp_res", "_imp_mov")):
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
        label = job["path"] or (os.path.basename(job["file"]) if job.get("file") else f"layer {job.get('layer')!r}")
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
        elif job.get("movie") is not None:   # placeImage: a temporary Movie File In TOP loading the picked file
            top = job["movie"]
            if int(top.width) < 1 or int(top.height) < 1:
                if now - job["started"] > TOP_READ_TIMEOUT_S:
                    return self._top_fail(job, f"could not load {os.path.basename(job['file'])} as an image")
                return   # still loading
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

    def _poll_pipe(self, pipe, top, now, period, wanted, size, packed=False, convert=True, key=None, rekey=None):
        """Change detection, rate limit, two-step async readback (the first delayed call issues a GPU read,
        the next returns it: one frame of latency, never a stall) and incremental conversion. ``key``: a change token
        replacing the TOP's cook count (layer previews: the network's own token, the TOP may be cooked lazily)."""
        cooks = top.totalCooks if key is None else key
        if cooks != pipe.cooks:
            pipe.cooks = cooks
            pipe.pending = True
        if pipe.conv is not None:
            if convert:
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
        if rekey is not None and pipe.cooks == cooks:
            pipe.cooks = rekey()   # a lazily cooked chain counts the read itself as a cook: that is not a change
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
        if convert:
            self._convert_some(pipe)

    def _poll_base(self, now):
        """Every connected input has its own change detection, rate limit, delayed readback and BASE frame. The
        conversion budget (CONVERT_BUDGET_S) belongs to ONE input per pump (round robin), the cheap readback calls to all."""
        sizes = self.in_sizes
        for n in [n for n in self.bases if n not in sizes]:
            pipe = self.bases[n]
            if pipe.msg is not None or pipe.conv is not None or pipe.inflight is not None:
                pipe.reset()  # disconnected: free its frame (GET /base?input=n -> 404)
        order = sorted(sizes)
        if not order:
            return
        period = 1.0 / max(1, self._p("Maxinputfps"))
        wanted = bool(self._ready_ids())
        k = next((i for i, n in enumerate(order) if n > self._conv_cursor), 0)
        converting = False
        for n in order[k:] + order[:k]:
            top = self._opt(f"in{n}")
            if top is None:
                continue
            pipe = self._base_pipe(n)
            was = pipe.conv is not None
            self._poll_pipe(pipe, top, now, period, wanted, sizes[n], convert=not converting)
            if not converting and (was or pipe.conv is not None):
                converting = True
                self._conv_cursor = n

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
            if pipe.layer is not None:
                if pipe.layer in c.lp:
                    c.lp[pipe.layer].clear()
            else:
                (c.view if pipe is self.out else c.notice(pipe.input)).clear()

    def _publish(self, pipe, wire, snap):
        """Store the converted image as the newest frame of the stream: one immutable message that
        GET /base | /view serve from TD's HTTP thread (never touched again, so no aliasing). One copy."""
        t = self._now()
        P = self.protocol
        pipe.frame_id = (pipe.frame_id + 1) & 0xFFFFFFFF
        h, w = wire.shape[:2]  # BASE: the input's size (v5), VIEW: the document's
        hdr = P.Header(pipe.type, P.FLAG_FRAME_END, pipe.frame_id, w, h, 0, 0, w, h, pipe.input or 0)  # BASE slot = input (v6)
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
            for kind, n in ([(f"base {i}", nt) for i, nt in c.bases.items()] + [("view", c.view)]
                            + [(f"layer {i!r}", nt) for i, nt in c.lp.items()]):
                if n.outstanding is not None and not n.stalled and now - n.sent_at > STALL_S:
                    n.stalled = True
                    self._status_at = 0.0
                    print(f"[raster_editor] client {c.id} has not fetched {kind} frame {n.outstanding} for "
                          f"{STALL_S:.0f}s: stalled, no more notices until it does")
        for i, pipe in sorted(self.bases.items()):
            if pipe.msg is None or i not in self.in_sizes:
                continue
            msg = None
            for c in self.clients.values():
                n = c.notice(i)
                if not c.ready or n.outstanding is not None or n.stalled or n.fetched == pipe.fid:
                    continue
                if msg is None:
                    msg = P.base_notice(pipe.fid, *pipe.size, i)
                self._send(c.id, msg)
                n.outstanding = pipe.fid
                n.sent_at = now
        for lid, pipe in sorted(self.layer_pipes.items()):
            if pipe.msg is None:
                continue
            msg = None
            for c in self.clients.values():
                if not c.ready or not c.active:
                    continue
                n = c.lp.setdefault(lid, _Notice())
                if n.outstanding is not None or n.stalled or n.fetched == pipe.fid:
                    continue
                if msg is None:
                    msg = P.layer_preview_notice(lid, pipe.fid, *pipe.size)
                self._send(c.id, msg)
                n.outstanding = pipe.fid
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
        """GET /base | /view ?token=T&client=<hello.clientId>[&input=N][&frameId=N]: the newest frame of the stream
        (/base: of input N, default 1; the pipe argument is ignored there)."""
        pars = request.get("pars") or {}
        if not self._token_ok(pars.get("token")):
            return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
        c = next((x for x in self.clients.values() if x.cid == pars.get("client")), None)
        inp = None
        if kind == "layer":   # v7: GET /layer?layerId=: the newest LAYER_PREVIEW frame of that tdPreview layer, active editor only
            lid = self.protocol.parse_layer_request(pars)
            pipe = self.layer_pipes.get(lid) if lid is not None else None
            n = c.lp.setdefault(lid, _Notice()) if c is not None and c.active and pipe is not None else None
            if n is None:
                return self._cors(request, self._reply(response, 404, "Not Found", "not subscribed (only the active editor gets layer previews)"))
            if pipe is None or pipe.msg is None:
                n.outstanding = None
                n.fetched = None
                return self._cors(request, self._reply(response, 404, "Not Found", "no layer preview"))
            subscribed_only = False
        if kind == "base":
            try:
                inp = int(pars.get("input", 1))
            except (TypeError, ValueError):
                inp = 0
            pipe = self.bases.get(inp)
        if kind != "layer":
            n = None if c is None else (c.notice(inp) if kind == "base" and 1 <= inp <= MAX_INPUTS else (c.view if kind == "view" else None))
        if subscribed_only and (c is None or not c.view_td):
            return self._cors(request, self._reply(response, 404, "Not Found", "not subscribed (send view mode td)"))
        if pipe is None or pipe.msg is None or (kind == "base" and inp not in self.in_sizes):
            if n is not None:  # whatever it was told about is gone; it gets a new notice with the next frame
                n.outstanding = None
                n.fetched = None
            return self._cors(request, self._reply(response, 404, "Not Found", f"no {kind} frame"
                                                   + (f" for input {inp}" if inp is not None else "")))
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
                stalled = sum(1 for c in ready if c.view.stalled or any(nt.stalled for nt in c.bases.values()))
                if stalled:
                    text += f" · {stalled} stalled"
        fx_err = getattr(self.network, "fx_error", None) if self._p("Active") else None
        if fx_err:
            text += f" · effects unavailable: {fx_err}"
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
