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
import socket
import tempfile
import threading
import time
import traceback
import zlib
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs

import numpy as np

CLIENT_KINDS = ("external",)  # v10: no in-TD panel; every client is an external browser
VERSION_FALLBACK = "0.8.0"
RECORD_KEY = "rasterEditorMaster"  # root storage: {path, id, port, token, orphan} of the project master
PORT_FALLBACK = 50  # a busy master port: try the next ones up to +50
SCAN_PERIOD_S = 5.0  # master: editor list poll (renames have no callback; create / delete / Active / Start are event driven)
HEALTH_PERIOD_S = 2.0  # master server check / slave check that the master is alive
START_GRACE_S = 5.0  # a slave does not judge the master before it has run this long (project load order)
TAKEOVER_WAIT_S = 3.0  # a failover waits this long for the old master to release the port, then falls back
BLOCK_S = 10.0  # no free port: no new attempt for this long (BLOCK_MAX attempts, then only an explicit Open in Browser)
BLOCK_MAX = 3
UPGRADE_HOLD_S = 15.0  # an editor being upgraded keeps its role (master record, token) this long
SERVER_FAILS_MAX = 3  # master server not running after this many restart attempts -> hand over
MAX_TEST_BODY = 64 * 1024
MODULE_CHECK_S = 1.0
LOOPBACK_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
LOOPBACK = ("127.0.0.1", "::1", "[::1]", "localhost")
CONVERT_BUDGET_S = 0.004  # input / output -> wire conversion time per pump (per stream)
STALL_S = 10.0  # a client that has not fetched its last `base` / `view` notice for this long is 'stalled'
EARLY_MAX_BYTES = 96 * 1024 * 1024  # SURFACE frames kept for a doc that has not arrived yet (replayed after it)
EARLY_MAX_FRAMES = 512  # ... per slot
STATUS_PERIOD_S = 0.25
LOG_PER_SECOND = 20
STAT_WINDOW = 300
VIEW_IDLE_S = 0.2  # v11 auto: this long without a change -> one exact frame
VIEW_MAX_INFLIGHT = 2  # v11: un-acked view frames per client
VIEW_ACK_TIMEOUT_S = 2.0  # an un-acked frame older than this is forgotten (a lost ack must not stall the stream for good)
VIEW_MAX_CHAINS = 4  # v11: GPU downscale chains (one per fast client); more clients get exact frames only
VIEW_EXACT_PERIOD_S = 0.1  # v11 `exact` quality: at most this often
FAST_MAX_PIXELS = 2_400_000  # a fast frame is never larger than this (viewport pixel size is clamped)
FAST_BYTES_BUDGET = 200 * 1024  # JPEG quality goes down when a colour frame exceeds this, back up when far below
FAST_Q_DEFAULT, FAST_Q_MIN = 75, 40
FAST_ALPHA_Q = 90
VCHAIN_BACKOFF_S = 5.0  # a chain that could not be created / read is retried this late (the client gets exact frames meanwhile)
GL_MAX_DIM = 16384
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


class _BmpMismatch(RuntimeError):
    """The BMP read back has another size than the chain was asked for (the resolution is still changing)."""


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
                 "fid_pending", "fid_applied", "reloading", "active_layer", "lp", "protocol",
                 "vq", "vp", "vserial", "v_inflight", "v_fid", "v_q", "v_tok", "v_changed", "v_fast_dirty", "v_exact_dirty",
                 "v_showing", "v_prev", "v_prev_applied", "v_next_at", "v_next_exact", "v_big", "v_vserial_seen", "v_unacked_since", "v_eq", "v_acked", "v_nfast")

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
        self.protocol = 10  # hello.protocol of the client (>= 11: fast / exact view frames over the WebSocket)
        # --- v11 view stream state (DESIGN_V9)
        self.vq = "auto"  # auto | fast | exact (what the client asked for)
        self.v_eq = "auto"  # what it gets: `exact` when it cannot have a GPU chain (no OpenCV, more clients than chains)
        self.vp = None  # last viewport {x, y, w, h, scale}
        self.vserial = 0  # bumped by every viewport / quality change
        self.v_inflight = {}  # frameId -> send time of the un-acked fast / exact frames
        self.v_fid = 0  # per-client frame counter (fast and exact share it)
        self.v_q = FAST_Q_DEFAULT  # adaptive JPEG quality
        self.v_tok = None  # output change token last seen
        self.v_changed = 0.0  # time of the last change (surface edit, document change, viewport)
        self.v_fast_dirty = False
        self.v_exact_dirty = False
        self.v_showing = None  # "fast" | "exact": what the client was last sent
        self.v_prev = None  # the last exact frame (wire RGBA8) sent to this client: tile diffs are taken against it
        self.v_prev_applied = None
        self.v_next_at = -1e9  # leaky bucket of the fast frame rate
        self.v_next_exact = 0.0
        self.v_big = None  # (frameId, message) of an exact frame announced with `viewExact` (GET /view?exact=1)
        self.v_vserial_seen = 0
        self.v_nfast = 0  # fast frames sent so far (an exact result computed before the newest one is stale)
        self.v_acked = False  # has acknowledged a view frame: until then one small frame at a time and no inline exact frames (a client that never reads must not block the WebSocket write)
        self.v_unacked_since = None  # first time a frame went un-acked past the timeout (cleared by any ack): shown as `stalled`

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
        self.sink = None  # v11 exact stream: called with (wire, snap, cooks-at-issue) instead of publishing a message
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
        self.pub_cooks = None  # change token of the read being published


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
        self.vx = _Pipe("vexact", 9, "vx")   # v11: full-resolution straight-alpha frames for the exact view
        self.vx.sink = lambda wire, snap, cooks: self._vx_sink(wire, snap, cooks)
        self._vx_frame = None      # newest converted exact frame waiting for the clients that take it
        self._vx_busy = False      # a worker job is encoding
        self._vx_results = collections.deque()   # (job, results) from the worker, handled by the pump
        self._vx_pool = None
        self._sync_view_workers = False   # tests: run the exact encoder inline
        self._vchains = {}         # client socket id -> GPU downscale chain (fast view)
        self._vfail = {}           # client socket id -> time until which its chain is not retried (exact only meanwhile)
        self._cv2 = None           # False = not importable
        self._file_replace = os.replace  # test seam for the project / PNG writers
        self._file_results = collections.deque()  # results from worker threads, handled by the pump
        self._sync_file_ops = False  # tests: run file workers inline
        # v8 router / identity state (see "identity, master election, router")
        self.ws_log = collections.deque(maxlen=40)   # (time, client, wanted editor, routed to, known editors): diagnostics
        self.is_master = False
        self.editor_id = ""
        self.copied = False
        self._copied_from = ""
        self.port_used = None
        self._ws = None            # server DAT this session sends through (the master's); None = our own
        self._tok = secrets.token_urlsafe(16)   # the project token (the master's; adopted from the master record)
        self._root_op = None       # test seam: replaces op('/')
        self._peers = {}           # test seam: path -> COMP
        self._local_record = None  # master record when there is no root (unit tests)
        self._route = {}           # master: client -> session
        self._by_id = {}           # master: editorId -> (COMP, extension)
        self._editors_sig = None
        self._editors_payload = None
        self._scan_at = 0.0
        self._health_at = 0.0
        self._miss_at = -1e9
        self._takeover = None      # deadline while waiting for the old master's port
        self._retry_at = 0.0       # next attempt while waiting
        self._blocked_until = 0.0
        self._blocked_n = 0
        self.was_copied = False
        self._wall = time.time     # test seam (the master record's hold is wall-clock: it outlives a process)
        self._server_fails = 0
        self._started_at = self._now()
        self.registry = None
        self._load_modules()
        self._reset_state()
        self.stats = {k: collections.deque(maxlen=STAT_WINDOW) for k in (
            "pump", "paste", "cook", "convert", "publish", "readback", "vconvert", "vpublish", "vreadback",
            "apply", "dump", "top", "lpreadback", "lpconvert", "lppublish",
            "vfast", "vfastcap", "vfastenc", "vfastrs", "vfastflip", "vxreadback", "vxconvert", "vxpublish", "vxmain", "vxenc")}

    # ------------------------------------------------------------------ setup / lifecycle

    def _load_modules(self):
        self.protocol = self.o.op("protocol").module
        self.frames = self.o.op("frames").module
        reg = self._opt("registry")
        if reg is not None:
            self.registry = reg.module
        elif self.registry is None:
            import registry as _registry  # unit tests (the COMP embeds registry.py as the `registry` DAT)
            self.registry = _registry
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
        self.clients = {}
        self.active_id = None
        self._seq = 0
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
        self._early = {}  # slot -> SURFACE frames (bytes) that arrived for a size the slot does not have yet (replayed after the next doc)
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
        self._module_check_at = 0.0
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
        self._req_serial = 0       # render request keys (network.render_open)

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
        carry = {} if self._restore_pending else self.surfaces  # a restart in a live session: Script TOPs are not locked, keep our pixels
        # (while a restore is pending the buffers are blank placeholders: the pixels are still in the locked TOPs / the undo cache)
        carry_stale = set() if self._restore_pending else set(self._stale_enc)  # ...and which of them still wait for a Premultiplied re-encode
        self._close_own_sockets()
        self._sweep_view_nodes()
        self._load_modules()
        self._reset_state()
        self._carry = carry
        self._carry_stale = carry_stale
        self._started = True
        self._started_at = self._now()
        self._identity()
        if self.copied and not self._carry:
            self._carry, self._carry_stale = self._pixels_of_original()
            if not self._carry and self._has_pixel_slots():
                self._flash_status("copied without pixels (the original editor is not running)", 60.0)
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
        if not self._restore_pending:
            self._copy_done()
        self._resume_master()
        self._registry_changed()

    @_guard
    def Stop(self):
        if self._doc_state_dirty:
            self._flush_doc_state()
        self._close_own_sockets()
        self._drop_all_tops()
        self._drop_all_vchains()
        self.clients.clear()
        self.active_id = None
        self._started = False
        if self.is_master:  # (the master record stays: a restart of this editor resumes as master with the same port / token)
            rec = self._record() or {}
            rec["hold"] = self._wall() + UPGRADE_HOLD_S
            self._set_record(rec)
            self._stop_server()

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
        destruction has nothing to wait for: close the WebSocket clients, stop the server (the next active editor takes over as
        master on the same port with the same token: failover), drop imports and temporaries. TD's undo snapshot of the delete is taken BEFORE this hook (verified: a lock taken here is not in it), so
        the surface pixels would come back blank after Ctrl+Z; they are therefore saved to a temp-folder side cache that the
        recreated instance's Restore() picks up (``_save_undo_cache``). While a restore is pending the locked images already
        are the document (and in the snapshot): nothing is written. Every step is independent and never raises."""
        if self._superseded():
            return
        if self._hold_active():
            rec = self._record() or {}
            rec.pop("hold", None)   # (deleted while upgrading: normal failover below)
            self._set_record(rec)
        self._destroyed = True
        self._started = False
        for name, step in (
                ("undo cache", lambda: None if self._restore_pending else self._save_undo_cache()),
                ("sockets", self._close_own_sockets),
                ("server", lambda: setattr(self._op("webserver").par, "active", 0)),
                ("handover", self._on_destroy_router),
                ("view nodes", self._drop_all_vchains),
                ("clients", self.clients.clear)):
            try:
                step()
            except Exception as e:  # noqa: BLE001 - the COMP is going away; nothing may escape into TD
                print(f"[raster_editor] onDestroyTD/{name}: {type(e).__name__}: {e}")
        self.active_id = None

    # ------------------------------------------------------------------ identity, master election, router (v8)
    #
    # Every editor is complete and can be the project master. Only the master's Web Server DAT is active: it serves the
    # page once and routes `editor=<id>` HTTP requests and WebSocket connections to the target editor's session (this
    # class: the per-editor protocol state) with plain Python calls. A slave costs nothing per frame beyond its own
    # work (`_router_tick` compares one timestamp). The master record (path / id / port / token) lives in the root's
    # storage so that failover, project load and `Open in Browser` can find / validate it.

    def _root(self):
        """The project root operator (it holds the master record); None outside TD (unit tests keep a local record)."""
        if self._root_op is not None:
            return self._root_op
        try:
            return op("/")  # noqa: F821 - TD global
        except NameError:
            return None

    def _record(self):
        r = self._root()
        if r is None:
            return dict(self._local_record) if self._local_record else None
        try:
            rec = r.fetch(RECORD_KEY, None)
        except Exception:  # noqa: BLE001
            rec = None
        return dict(rec) if isinstance(rec, dict) else None

    def _set_record(self, rec):
        r = self._root()
        if r is None:
            self._local_record = dict(rec)
        else:
            r.store(RECORD_KEY, dict(rec))

    def _comp_at(self, path):
        if not path:
            return None
        if path == str(self.o.path):
            return self.o
        if path in self._peers:
            return self._peers[path]
        try:
            return op(path)  # noqa: F821 - TD global
        except NameError:
            return None

    def _ext_of(self, comp):
        """The editor extension of ``comp`` (this one for our own COMP), or None."""
        if comp is None:
            return None
        if comp is self.o:
            return self
        try:
            holder = comp.ext
            e = getattr(holder, "RasterEditorExt", None)
            if e is None and hasattr(holder, "is_master"):
                e = holder  # (unit tests hand the extension itself)
        except Exception:  # noqa: BLE001
            return None
        return e if e is not None and hasattr(e, "is_master") else None

    def _server_running(self):
        try:
            return bool(self._op("webserver").par.active.eval())
        except Exception:  # noqa: BLE001
            return False

    def _live_master(self):
        """The running master's extension in this TD process (record validated: the COMP exists, is a started master with a
        running server), or None."""
        rec = self._record()
        if not rec or not rec.get("path"):
            return None
        m = self._ext_of(self._comp_at(rec["path"]))
        if m is None or m._destroyed or not m.is_master or not m._started or not m._server_running():
            return None
        return m

    def _hold_active(self, rec=None):
        rec = rec if rec is not None else (self._record() or {})
        return float(rec.get("hold") or 0.0) > self._wall()

    def _pending_master(self):
        """The editor the record names as master that is NOT serving yet but is about to be: being upgraded in place (the record's
        `hold`, written by PrepareUpgrade and honoured by the NEW extension instance too) or waiting for its port (failover /
        resume). Nobody else takes over, and Open in Browser joins it instead of starting a second server."""
        rec = self._record()
        if not rec or not rec.get("path"):
            return None
        m = self._ext_of(self._comp_at(rec["path"]))
        if m is None or m._destroyed or (m.is_master and m._server_running()):
            return None
        if m._takeover is not None or self._hold_active(rec):
            return m
        return None

    def _find_editors(self):
        root = self._root()
        if root is None:
            return [self.o]
        out = self.registry.find_editors(root, legacy=False)
        if not any(c is self.o for c in out) and not self._destroyed:
            out.append(self.o)
            out.sort(key=lambda c: str(c.path))
        return out

    def _identity(self):
        """Stable editorId, kept in COMP storage. It survives everything that keeps the storage with no second editor owning the
        id (undo of a delete, cut / paste, save / load of a .tox, project load). A copy / paste / duplicate / loaded .tox of a LIVE
        editor carries the same id while the original still exists: the newcomer takes a new id (its document came along with
        the children and its pixels are adopted from the original while that runs)."""
        eid = str(self.o.fetch("editorId", "") or "")
        if eid and self._id_in_use_elsewhere(eid):
            self.copied = self.was_copied = True
            self._copied_from = eid
            print(f"[raster_editor] {self.o.path} is a copy of editor {eid}: new editor id (the document was copied)")
            eid = ""
        if not eid:
            eid = "e" + secrets.token_hex(4)
            self.o.store("editorId", eid)
        self.editor_id = eid

    def _id_in_use_elsewhere(self, eid):
        try:
            for comp in self._find_editors():
                if comp is not self.o and self.registry.editor_id(comp) == eid:
                    return True
        except Exception as e:  # noqa: BLE001
            self._report("identity", e)
        return False

    def _pixels_of_original(self):
        """A copy of a live editor: its surface Script TOPs are blank (the pixels are only in the running extension's buffers
        unless the project was saved), so take them from the editor it was copied from and let Restore use them like a
        restart's carried buffers. Nothing to adopt (the original is inactive / not running) -> {} and a Status notice."""
        if not self._copied_from:
            return {}, set()
        for comp in self._find_editors():
            if comp is self.o:
                continue
            ext = self._ext_of(comp)
            if ext is not None and ext.editor_id == self._copied_from and ext._started and ext.surfaces:
                return {sl: b.copy() for sl, b in ext.surfaces.items()}, set(ext._stale_enc)
        return {}, set()

    def _port_free(self, port):
        """True when nothing listens on 127.0.0.1:port (a connect is refused). Not a bind test: that would also trip over the
        TIME_WAIT sockets of a server that was just stopped (failover on the same port)."""
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=0.25):
                return False
        except OSError:
            return True

    def _pick_port(self, ports, wait):
        """The first free port of ``ports`` (a list: the preferred ones in order). None while ``wait`` and the old master has not
        released them yet (up to TAKEOVER_WAIT_S; the caller retries); after that / without waiting the next free ports above the
        first one, up to +PORT_FALLBACK. RuntimeError when nothing is free."""
        for p in ports:
            if self._port_free(p):
                return p
        if wait:
            now = self._now()
            if self._takeover is None:
                self._takeover = now + TAKEOVER_WAIT_S
            if now < self._takeover:
                self._retry_at = now + 0.25
                return None
        base = ports[0]
        for p in range(base + 1, min(base + PORT_FALLBACK, 65535) + 1):
            if self._port_free(p):
                return p
        raise RuntimeError(f"no free port from {base} to {base + PORT_FALLBACK}")

    def BecomeMaster(self, takeover=False, resume=False, user=False):
        """Make this editor the project master: start its Web Server DAT. ``takeover`` (failover): the record's port and token,
        waiting briefly for the old server to release the port. ``resume`` (project load): the configured `Port` first, then the
        record's. Otherwise (election) the `Port` parameter, falling back to the next free port (up to +50); a project with no free
        port is retried a few times, spaced BLOCK_S apart, unless ``user`` (an explicit Open in Browser / Promote). Returns True when
        serving (False: not active, another live or pending master exists, still waiting for the port, or failed). Every exit
        other than "waiting for the port" clears the takeover wait."""
        self._wait_port = False
        try:
            ok = self._become_master(takeover, resume, user)
        except Exception as e:  # noqa: BLE001
            self._blocked_n += 1
            self._blocked_until = self._now() + BLOCK_S
            self._report("BecomeMaster", e)
            ok = False
        if not self._wait_port:
            self._takeover = None
        return ok

    def _become_master(self, takeover, resume, user):
        if self._destroyed or not self._p("Active"):
            return False
        if user:
            self._blocked_n, self._blocked_until = 0, 0.0
        elif self._blocked_n >= BLOCK_MAX or self._now() < self._blocked_until:
            return False
        cur = self._live_master()
        if cur is not None and cur is not self:
            return False
        pend = self._pending_master()
        if pend is not None and pend is not self and not user:
            return False
        if self.is_master and self._server_running():
            return True
        rec = self._record() or {}
        token = rec.get("token") or secrets.token_urlsafe(16)
        mine = int(self._p("Port"))
        if resume:
            ports = [mine] + ([int(rec["port"])] if rec.get("port") and int(rec["port"]) != mine else [])
        elif takeover and rec.get("port"):
            ports = [int(rec["port"])]
        else:
            ports = [mine]
        port = self._pick_port(ports, takeover and not resume)
        if port is None:
            self._wait_port = True
            return False  # `_router_tick` retries until the old master released the port (then falls back)
        ws = self._op("webserver")
        ws.par.active = 0
        ws.par.port = port
        ws.par.active = 1
        self.is_master = True
        self._ws = None
        self._tok = token
        self._route = {}
        self._blocked_n, self._blocked_until = 0, 0.0
        self._set_record({"path": str(self.o.path), "id": self.editor_id, "port": port, "token": token, "orphan": False,
                          "failed": [] if user else list(rec.get("failed") or [])})
        self.port_used = port
        self._rescan(force=True)
        busy = f" (port {ports[0]} busy)" if port != ports[0] else ""
        self._flash_status(f"master · http://127.0.0.1:{port}/{busy}")
        return True

    @_guard
    def Promote(self):
        """Take the master role from the current master (validation / manual hand-over): it stops serving, this editor serves on
        the same port with the same token; open pages reconnect."""
        cur = self._live_master()
        if cur is not None and cur is not self:
            cur._stop_server()
        self._takeover = None
        return self.BecomeMaster(takeover=True, user=True)

    def _stop_server(self):
        """Stop serving (resign / deactivate / delete): every session routed through this server forgets its clients, the Web
        Server DAT is switched off. The master record is left to the caller."""
        self.is_master = False
        sessions = {id(e): e for _, e in self._by_id.values()}
        sessions[id(self)] = self
        for e in sessions.values():
            e._forget_clients()
        self._route = {}
        self._by_id = {}
        self._editors_sig = None
        self._editors_payload = None   # never publish a list from a master that has not rescanned since it (re)started
        try:
            ws = self._op("webserver")
            for cid in list(ws.webSocketConnections):   # (switching the DAT off does not reliably close live sockets: pages would never notice)
                try:
                    ws.webSocketClose(cid)
                except Exception:  # noqa: BLE001
                    pass
            ws.par.active = 0
        except Exception as e:  # noqa: BLE001
            print(f"[raster_editor] stop server: {type(e).__name__}: {e}")

    def _forget_clients(self):
        """Drop this editor's clients without talking to them (their server is gone)."""
        for cid in list(self.clients):
            self._ws_close(cid)
        self._ws = None

    def _successor(self, exclude=None, skip_ids=()):
        """The next active, started editor in path order (not ``exclude`` / ``skip_ids``), or None."""
        for comp in self._find_editors():
            if comp is exclude:
                continue
            ext = self._ext_of(comp)
            if ext is None or ext._destroyed or not ext._started or ext.editor_id in skip_ids:
                continue
            try:
                if not comp.par.Active.eval():
                    continue
            except Exception:  # noqa: BLE001
                continue
            return ext
        return None

    def _hand_over(self, failed=False):
        """This master stops serving; the next active editor takes over on the same port with the same token. No active
        editor left -> the server stays off and the record is marked `orphan` (the first editor activated again resumes).
        ``failed``: this editor's server could not run; it is remembered in the record so a successor with the same error is
        not handed back to (no flapping)."""
        rec = self._record() or {}
        bad = list(rec.get("failed") or [])
        if failed and self.editor_id not in bad:
            bad.append(self.editor_id)
        self._stop_server()
        succ = self._successor(exclude=self.o, skip_ids=bad)
        if succ is None:
            rec.update(path="", id="", orphan=True, failed=bad)
            self._set_record(rec)
            return None
        rec["failed"] = bad
        self._set_record(rec)
        succ._takeover = None
        succ.BecomeMaster(takeover=True)
        return succ

    def _resume_master(self):
        """Project load / restart: the editor that was master when the project was saved serves again (the configured Port
        first, then the record's; an upgrade / rebuild in place keeps the record's port); no other editor starts a server."""
        if not self._p("Active") or self.is_master:
            return
        rec = self._record()
        if rec and rec.get("id") == self.editor_id and rec.get("path") is not None and self._live_master() is None:
            if self._hold_active(rec):
                self.BecomeMaster(takeover=True)
            else:
                self.BecomeMaster(resume=True)

    def _registry_changed(self, exclude=None):
        """An editor was created / started / deleted / (de)activated: the master refreshes its list (and pushes it)."""
        m = self if self.is_master else self._live_master()
        if m is not None:
            m._rescan(force=True, exclude=exclude)

    def _rescan(self, force=False, exclude=None):
        """Master: rebuild the id -> editor map and the editor list; push `editors` to the open pages when it changed."""
        now = self._now()
        if not force and now < self._scan_at:
            return
        self._scan_at = now + SCAN_PERIOD_S
        by_id, items = {}, []
        ws = self._op("webserver")
        for comp in self._find_editors():
            if exclude is not None and comp is exclude:
                continue
            ext = self._ext_of(comp)
            eid = self.editor_id if comp is self.o else self.registry.editor_id(comp)
            if ext is None or not eid or ext._destroyed or not ext._started:
                continue   # not (yet) running: not routable, not listed
            if eid in by_id:
                continue   # a duplicate id (a copy before its first Start re-ided it): the first started one keeps it
            try:
                active = bool(comp.par.Active.eval())
            except Exception:  # noqa: BLE001
                active = False
            by_id[eid] = (comp, ext)
            items.append({"id": eid, "name": str(comp.name), "path": str(comp.path), "version": self.registry.editor_version(comp),
                          "active": active})
            if ext is not self:
                ext._ws, ext._tok = ws, self._tok
                if ext.is_master:  # an earlier master that lost the election (e.g. its server failed)
                    ext._stop_server()
        self._by_id = by_id
        rec = self._record()
        if rec and rec.get("id") == self.editor_id and rec.get("path") != str(self.o.path):
            rec["path"] = str(self.o.path)  # the master was renamed / moved
            self._set_record(rec)
        payload = {"master": self.editor_id, "editors": items}
        sig = json.dumps(payload, sort_keys=True)
        if sig != self._editors_sig:
            self._editors_sig = sig
            self._editors_payload = payload
            text = self.protocol.editors_msg(self.editor_id, items)
            try:
                for cid in list(ws.webSocketConnections):
                    ws.webSocketSendText(cid, text)
            except Exception as e:  # noqa: BLE001
                self._report("editors push", e)

    def _send_editors(self, client):
        m = self if self.is_master else self._live_master()
        if m is None or m._editors_payload is None:
            return
        m.ws_log.append((round(m._now(), 2), client, "editors", [e["name"] for e in m._editors_payload["editors"]], m._editors_payload["master"]))
        m._op("webserver").webSocketSendText(client, self.protocol.editors_msg(m._editors_payload["master"], m._editors_payload["editors"]))

    def _target(self, eid):
        """The session for ``editor=<eid>`` (missing -> this master's own editor), or None for an unknown / inactive editor.
        O(1) per message: a dict lookup."""
        if not eid or eid == self.editor_id:
            return self if self._p("Active") else None
        ent = self._by_id.get(eid)
        if ent is None:
            now = self._now()
            if now - self._miss_at > 0.5:  # a just created editor the periodic scan has not seen yet
                self._miss_at = now
                self._rescan(force=True)
                ent = self._by_id.get(eid)
            if ent is None:
                return None
        ext = ent[1]
        if ext._destroyed or not ext._started or not ext._p("Active"):
            return None
        ext._tok = self._tok
        return ext

    def _router_tick(self, now):
        """Once per pump, a timestamp compare unless something is due. Master: refresh the list, check the server. Slave: is
        the master alive? (failover) -- only the candidate (next active editor in path order) acts."""
        if self._takeover is not None and now >= self._retry_at:
            self.BecomeMaster(takeover=True)
        if self.is_master:
            if now >= self._scan_at:
                self._rescan(force=True)
            if now >= self._health_at:
                self._health_at = now + HEALTH_PERIOD_S
                self._check_server()
            return
        if now < self._health_at or now - self._started_at < START_GRACE_S:
            return
        self._health_at = now + HEALTH_PERIOD_S
        rec = self._record()
        if not rec or not self._p("Active"):
            return
        if rec.get("path") and rec.get("id") != self.editor_id:
            if self._live_master() is not None or self._pending_master() is not None:
                return  # alive, or starting up again (upgrade / project load / port release): not dead
            comp = self._comp_at(rec["path"])
            cand = self._successor(exclude=comp if comp is not None and self._ext_of(comp) is not None else None,
                                   skip_ids=rec.get("failed") or ())
            if cand is self:
                self.BecomeMaster(takeover=True)
        elif rec.get("orphan") and not rec.get("path"):
            cand = self._successor(skip_ids=rec.get("failed") or ())
            if cand is self:
                self.BecomeMaster(takeover=True)

    BIND_ERROR = re.compile(r"bind|address already in use|in use|eaddrinuse|cannot assign|permission denied", re.I)

    def _check_server(self):
        """Master health. A failure is only "the Web Server DAT is not active" or a bind-class error (port taken). A stopped server
        is restarted on its port if that is free (else on the next free one); one that keeps failing hands the role over, and the
        failing editor is remembered in the record so the successor is not handed back to (no flapping)."""
        if not self._p("Active"):
            return
        ws = self._op("webserver")
        err = ""
        try:
            err = str(ws.errors() or "")
        except Exception:  # noqa: BLE001
            pass
        bad = (not self._server_running()) or bool(self.BIND_ERROR.search(err))
        if not bad:
            self._server_fails = 0
            return
        self._server_fails += 1
        if self._server_fails > SERVER_FAILS_MAX:
            self._server_fails = 0
            self._report("server", RuntimeError(f"web server failed ({err or 'not running'}); handing over"))
            self._hand_over(failed=True)
            return
        rec = self._record() or {}
        port = int(rec.get("port") or self._p("Port"))
        ws.par.active = 0
        if not self._port_free(port):
            nxt = self._pick_port([port], False)   # taken by someone else: the next free port (the record follows)
            port = nxt
            rec["port"] = port
            self._set_record(rec)
            self.port_used = port
        ws.par.port = port
        ws.par.active = 1

    def OpenInBrowser(self):
        """`Openbrowser` pulse: open the project master's page with this editor's tab selected. If no live master exists in this
        TD process this editor becomes the master first. A master that is just starting again (upgrade / failover waiting for its
        port) is joined: the page opens at the record's port and retries until it is up; no second server is started.
        Returns the URL (None: could not serve)."""
        m = self._live_master()
        if m is None:
            pend = self._pending_master()
            if pend is not None and pend is not self:
                m = pend
            else:
                if not self.BecomeMaster(user=True):
                    self._flash_status("cannot open: this editor is inactive or the server did not start")
                    return None
                m = self
        url = m._page_url(self.editor_id, self._p("Devurl"), self._test_enabled())
        self._view_url(url)
        return url

    def _page_url(self, eid, devurl="", test=False):
        """URL of the master's page for editor ``eid`` (the token travels in the fragment: it never reaches a server log)."""
        rec = self._record() or {}
        port = rec.get("port") or self.port_used or self._p("Port")
        token = rec.get("token") or self._tok
        frag = f"#token={token}&e={eid}"
        dev = (devurl or "").strip()
        if dev:
            return dev + ("&" if "?" in dev else "?") + f"ws=ws://127.0.0.1:{port}/ws" + ("&test=1" if test else "") + frag
        return f"http://127.0.0.1:{port}/" + ("?test=1" if test else "") + frag

    def _upgrade_all(self):
        """`Upgradeall` pulse: replace every OLDER editor in the project with this editor's build (upgrade.py scans the whole
        project); the report goes to `Status`."""
        mod = self._opt("upgrade")
        if mod is None:
            text = "upgrade module not available in this build"
        else:
            try:
                import sys
                sys.modules.setdefault("registry", self.registry)  # (upgrade.py does `import registry`)
                report = mod.module.upgrade_all(self.o)
            except ImportError:
                text = "upgrade module not available in this build"
            except Exception as e:  # noqa: BLE001
                self._report("upgrade", e)
                text = f"upgrade failed: {type(e).__name__}: {e}"
            else:
                if isinstance(report, dict):
                    if report.get("done") is False:
                        text = f"upgrading {len(report.get('pending', []))} editor(s) ..."   # OnUpgradeDone shows the result
                    else:
                        text = self._upgrade_summary(report)
                else:
                    text = report if isinstance(report, str) else "; ".join(str(x) for x in (report or [])) or "nothing to upgrade"
        print(f"[raster_editor] upgrade all: {text}")
        self._flash_status(text, 60.0)

    @staticmethod
    def _upgrade_summary(report):
        text = (f"upgraded {len(report.get('upgraded', []))}, skipped newer {len(report.get('skipped_newer', []))}, "
                f"linked {len(report.get('skipped_linked', []))}, failed {len(report.get('failed', []))}")
        if report.get("warning"):
            text += " · " + str(report["warning"])
        return text

    def OnUpgradeDone(self, report):
        """Hook for upgrade.py (the paced upgrade is through): the final summary goes to `Status`."""
        text = self._upgrade_summary(report if isinstance(report, dict) else {})
        print(f"[raster_editor] upgrade all: {text}")
        self._flash_status(text, 60.0)

    def PrepareUpgrade(self):
        """Hook for upgrade.py, called on a target before it is frozen and stopped: store the pending document state and drop
        imports so nothing is in flight when the extension is replaced."""
        if self._doc_state_dirty:
            self._flush_doc_state()
        self._drop_all_tops()
        if self.is_master:   # the NEW extension instance honours this too: it lives in the record, not in this object
            rec = self._record() or {}
            rec["hold"] = self._wall() + UPGRADE_HOLD_S
            self._set_record(rec)

    def OnEditorsChanged(self):
        """Hook for upgrade.py (called on the source after all targets): refresh the registry / list and master election."""
        self._registry_changed()
        m = self if self.is_master else self._live_master()
        if m is None:
            self._resume_master()

    def _on_destroy_router(self):
        if self.is_master:
            self._hand_over()
        else:
            self._registry_changed(exclude=self.o)

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
        self.undo_trace = ["called", doc_hash, sorted(skip)]
        if not doc_hash:
            return set()
        d = self._undo_cache_dir(doc_hash)
        self.undo_trace.append(os.path.isdir(d))
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

    def _close_own_sockets(self):
        """Close this editor's WebSocket clients (through the server they connected to: the master's)."""
        self._drop_all_tops()
        ws = self._server()
        for cid in list(self.clients):
            try:
                ws.webSocketClose(cid)
            except Exception:  # noqa: BLE001 - server may be down
                pass

    _close_all_sockets = _close_own_sockets

    def _server(self):
        return self._ws if self._ws is not None else self._op("webserver")

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
        """Active off: the output is the input passed through, clients are dropped. (The server belongs to the master only.)"""
        if not self._p("Active"):
            self._drop_all_tops()
            self.clients.clear()
            self.active_id = None
            self._op("out_switch").par.index = 0  # passthrough while the editor is off
            if not self.is_master:
                self._op("webserver").par.active = 0
        self._status_at = 0.0

    @property
    def token(self):
        """The project token (the master's; one for all editors)."""
        return self._tok

    def _token_ok(self, tok):
        return isinstance(tok, str) and hmac.compare_digest(tok.encode(), self._tok.encode())

    def _test_enabled(self):
        """Validation back-channel (`POST /__test`, `testPath`): only when COMP storage `reTest` is set on this editor."""
        try:
            return bool(self.o.fetch("reTest", 0))
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------------ parameters

    @_guard
    def OnParChange(self, par):
        name = par.name
        if name == "Active":
            if self._p("Active"):
                self.Start()
                rec = self._record()
                if rec and rec.get("orphan") and not rec.get("path") and self._successor() is self:
                    self.BecomeMaster(takeover=True)  # the project's server was stopped for lack of an active editor
            else:
                self._close_own_sockets()
                self._apply_active()
                if self.is_master:
                    self._hand_over()
            self._registry_changed()
        elif name == "Port":
            if self.is_master:  # a slave's Port is ignored
                self._close_own_sockets()
                self._stop_server()
                rec = self._record() or {}
                rec["port"] = None
                self._set_record(rec)
                self.BecomeMaster()
        elif name == "Openbrowser":
            self.OpenInBrowser()
        elif name == "Upgradeall":
            self._upgrade_all()
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
            self._view11_reset_all()
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
        """Master router: the page and `/editors` are served here, every per-editor route goes to the session named by
        ``editor=<id>`` (none: this master's own editor)."""
        if not self._is_loopback(request.get("clientAddress")) or not self._host_ok(request):
            return self._reply(response, 403, "Forbidden", "forbidden")
        path = request.get("uri", "/")
        method = request.get("method")
        pars = request.get("pars") or {}
        if method == "GET" and path == "/editors":
            if not self._token_ok(pars.get("token")):
                return self._cors(request, self._reply(response, 403, "Forbidden", "bad token"))
            self._rescan(force=False)
            payload = self._editors_payload if self._editors_payload is not None else {"master": self.editor_id, "editors": []}
            response["Cache-Control"] = "no-store"
            return self._cors(request, self._reply(response, 200, "OK", json.dumps(payload), "application/json; charset=utf-8"))
        if method == "GET" and path in ("/", "/index.html"):
            html = self._op("ui_html").text
            if html:
                response["Cache-Control"] = "no-store"
                return self._reply(response, 200, "OK", html, "text/html; charset=utf-8")
            return self._reply(response, 404, "Not Found", "not found")
        if method == "POST" and path == "/__test" and self._test_enabled() \
                and self._token_ok((request.get("pars") or {}).get("token")):
            # Validation back-channel: the page (with ?test=1) posts values it cannot return
            # through executeJavaScript, e.g. screen coordinates of document points.
            data = request.get("data", b"")
            if len(data) > MAX_TEST_BODY:
                return self._reply(response, 413, "Payload Too Large", "too large")
            self.test_result = data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data)
            return self._reply(response, 204, "No Content")
        target = self._target(pars.get("editor"))
        if target is None:
            return self._cors(request, self._reply(response, 404, "Not Found", '{"error":"no such editor"}',
                                                   "application/json; charset=utf-8"))
        return target._session_http(request, response, path, method)

    @_guard
    def _session_http(self, request, response, path, method):
        """The per-editor HTTP routes (the master routed the request here)."""
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
        return self._reply(response, 404, "Not Found", "not found")

    @_guard
    def OnWebSocketOpen(self, client, uri=""):
        """Master router: the connection belongs to the editor named by ``?editor=<id>`` (none: this master's own editor)."""
        path, _, query = uri.partition("?")
        if path != "/ws" or not self._is_loopback(client):
            self._op("webserver").webSocketClose(client)
            return
        want = (parse_qs(query).get("editor") or [""])[0]
        target = self._target(want)
        self.ws_log.append((round(self._now(), 2), client, want, target.editor_id if target is not None else None, len(self._by_id)))
        if target is None:
            ws = self._op("webserver")
            try:  # (the Web Server DAT cannot close with code 4404: the page gets `gone` first, then the close)
                ws.webSocketSendText(client, self.protocol.gone())
            finally:
                ws.webSocketClose(client)
            return
        self._route[client] = target
        if target is not self:
            target._ws = self._op("webserver")
        target._ws_open(client)

    @_guard
    def OnWebSocketClose(self, client):
        target = self._route.pop(client, None)
        if target is not None:
            target._ws_close(client)

    @_guard
    def OnWebSocketText(self, client, text):
        target = self._route.get(client)
        if target is not None:
            target._ws_text(client, text)

    @_guard
    def OnWebSocketBinary(self, client, data):
        target = self._route.get(client)
        if target is not None:
            target._ws_binary(client, data)

    # --- the session side (one editor's clients; transport-agnostic)

    def _ws_open(self, client):
        self.clients[client] = _Client(client)

    def _ws_close(self, client):
        c = self.clients.pop(client, None)
        if c is None:
            return
        self._view11_unsub(c)
        self._drop_client_tops(c)
        if self.active_id == client:
            self.active_id = None
            ready = [x for x in self.clients.values() if x.ready]
            if ready:
                self._set_active(max(ready, key=lambda x: x.seq).id)
        self._sync_viewmode()
        self._status_at = 0.0

    @_guard
    def _ws_text(self, client, text):
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
        elif t == "viewAck":
            self._on_view_ack(c, msg)
        elif t == "viewExactReset":
            self._on_view_exact_reset(c)
        elif t == "listTops":
            self._on_list_tops(c, msg)
        elif t == "importTop":
            self._on_import_top(c, msg)
        elif t in ("renderLayer", "renderLayers"):
            self._on_render_layer(c, msg)
        elif t == "activeLayer":
            self._on_active_layer(c, msg)
        elif t == "setCanvas":
            self._on_set_canvas(c, msg)
        elif t == "log":
            self._on_log(msg)
        # unknown message types are ignored (PROTOCOL.md)

    @_guard
    def _ws_binary(self, client, data, _replay=False):
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
            if not _replay:
                self._stash_early_surface(hdr.slot, data)
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
            self._server().webSocketClose(c.id)
            self.clients.pop(c.id, None)
            return
        proto = msg.get("protocol")
        if not isinstance(proto, int) or isinstance(proto, bool) or not P.MIN_PROTOCOL <= proto <= P.PROTOCOL_VERSION:
            self._send(c.id, P.error(f"unsupported protocol {msg.get('protocol')!r}, server speaks {P.PROTOCOL_VERSION}"))
            self._server().webSocketClose(c.id)
            self.clients.pop(c.id, None)
            return
        c.protocol = proto
        c.kind = "external"  # (v10: the in-TD panel is gone)
        c.fresh = bool(msg.get("fresh"))
        self._seq += 1
        c.seq = self._seq
        c.ready = True
        if self.active_id is None:
            self._demote_active()
            c.active = True
            self.active_id = c.id
        items = self._input_items()
        self._send(c.id, P.hello(self.doc_w, self.doc_h, self.has_input, self._p("Maxsendfps"), c.active, c.cid,
                                 self.doc_layers is not None, self.doc_rev, self._mode(), items, c.protocol))
        self._send(c.id, P.inputs_msg(items))  # (also in hello.inputs: for pages that only read one of them)
        self._send(c.id, P.files_msg(*self._files_values()))
        self._send(c.id, P.fonts(self._font_families()))
        self._send_editors(c.id)
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
        self._server().webSocketSendText(client, text)

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

    def _fill_input_sizes(self, layers):
        """Masked input layers that state no surface size get the live size of their input (else the size of their mask's buffer, else they stay
        without one = document size): protocol.slot_sizes and the network then agree on the size of an input layer's mask."""
        if not layers:
            return layers
        out, changed = [], False
        for l in layers:
            if (l.get("kind") == "input" and isinstance(l.get("mask"), dict)
                    and (l.get("surfaceW") is None or l.get("surfaceH") is None)):      # (only a mask depends on the size)
                size = self.in_sizes.get(l.get("input"))
                m = l.get("mask")
                if size is None and isinstance(m, dict) and self.surfaces.get(m.get("slot")) is not None:
                    b = self.surfaces[m["slot"]]
                    size = (b.shape[1], b.shape[0])
                if size is not None:
                    l = dict(l, surfaceW=int(size[0]), surfaceH=int(size[1]))
                    changed = True
            out.append(l)
        return out if changed else layers

    def _input_mask_slots(self, layers):
        return frozenset(l["mask"]["slot"] for l in layers or ()
                         if l.get("kind") == "input" and isinstance(l.get("mask"), dict) and l["mask"].get("slot") is not None)

    def _stash_early_surface(self, slot, data):
        """A SURFACE frame produced for a size this slot does not have (yet): the page's doc with the new size may still be on its way.
        Kept (bounded) and replayed after the next doc; a really stale frame is dropped then."""
        early = self._early
        if sum(len(d) for lst in early.values() for d in lst) + len(data) > EARLY_MAX_BYTES or len(early.get(slot, ())) >= EARLY_MAX_FRAMES:
            return
        early.setdefault(slot, []).append(bytes(data))

    def _replay_early_surfaces(self):
        early, self._early = self._early, {}
        c = next((c for c in self.clients.values() if c.ready and c.active), None)
        if c is None:
            return
        for slot, lst in early.items():
            for data in lst:
                self._ws_binary(c.id, data, _replay=True)

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
        layers = self._fill_input_sizes(layers)
        slots = P.layer_slots(layers)
        masks = frozenset(P.mask_slots(layers))
        in_masks = self._input_mask_slots(layers)
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
                # an input mask follows its input's resolution: the picture is stretched (the page sends the exact mask a moment later);
                # every other surface keeps its pixels anchored top-left
                resized[s] = (self.frames.stretch_buffer(old, sizes[s][0], sizes[s][1]) if s in in_masks
                              else self.frames.resize_buffer(old, sizes[s][0], sizes[s][1], s in masks))
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
        self._replay_early_surfaces()
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

    def _flash_status(self, text, seconds=None):
        self._flash = (text, self._now() + (seconds or EXPORT_FLASH_S))
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
        self._slot_size = self.protocol.slot_sizes(self._fill_input_sizes(layers), int(self._p("Docw")), int(self._p("Doch")))
        self._sync_doc_size()  # allocates the buffers and applies the network once
        if self._restore_pending and self._net_applied:  # (else the first successful apply finishes it)
            self._finish_restore()
        self._doc_state_dirty = False
        return True

    def _copy_done(self):
        """The first successful Start / Restore after a copy is through: a later Start must not re-adopt the original's pixels."""
        self.copied = False
        self._copied_from = ""

    def _has_pixel_slots(self):
        try:
            stored = self._read_doc_state()
            return bool(stored and self.protocol.layer_slots(stored[1]))
        except Exception:  # noqa: BLE001
            return False

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
        self._copy_done()
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
                self._ws_binary(cid, payload, _replay=True)
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
            in_masks = self._input_mask_slots(layers)
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
                stretch_to = None
                if slot in known and known[slot] != (sw, sh):
                    if slot not in in_masks:
                            raise RuntimeError(f"surface {slot} is {sw}x{sh}, the document says {known[slot][0]}x{known[slot][1]}")
                    stretch_to = known[slot]      # an input mask saved for another input resolution: resample it
                total += sw * sh
                if total > 3 * frames.PNG_MAX_PIXELS:
                    raise RuntimeError("project file holds too many pixels")
                img = frames.decode_png(pngs.pop(slot))
                bufs[slot] = frames.straight_to_buffer(img, premult)
                if stretch_to is not None:
                    bufs[slot] = frames.stretch_buffer(bufs[slot], *stretch_to)
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
        t.tags.add("reRuntime")
        t.par.file = path
        return t

    def _on_choose_file(self, c, msg):
        P = self.protocol
        try:
            rid, purpose = P.parse_choose_file(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad chooseFile: {e}"))
            return
        test = msg.get("testPath") if self._test_enabled() and "testPath" in msg else False   # validation stub (storage reTest)
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
            for e in l.get("effects") or ():       # (v8: legacy adjustment specs are migrated into effects[] when the document arrives)
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
        if c.protocol >= 11:
            self._on_view11(c, msg)
            return
        try:
            view = self.protocol.parse_view(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad view: {e}"))
            return
        c.view_msg = view
        sub = view["mode"] == "td"
        if sub and not c.view_td:
            c.view.clear()  # re-announce the stored frame (if any), clear any stall
            if self.out.msg is None:
                self.out.pending = True
        c.view_td = sub
        self._sync_viewmode()
        self._status_at = 0.0

    # ------------------------------------------------------------------ v11 view stream (DESIGN_V9, PROTOCOL.md section 13)
    #
    # Per client: `fast` frames (GPU crop + downscale of the output to the client's viewport, JPEG colour + JPEG alpha, pushed over
    # the WebSocket in the tick the output was cooked, <= 2 un-acked) and `exact` frames (full-resolution straight-alpha RGBA8,
    # zlib in a worker thread, only the changed 64 px tiles after the first). `auto` = fast while things change, one exact frame
    # after VIEW_IDLE_S without a change. The step runs AFTER the surface upload of the same pump so the picture contains it.

    def _view11_subscribers(self):
        return [c for c in self.clients.values() if c.ready and c.view_td and c.protocol >= 11]

    def _get_cv2(self):
        if self._cv2 is None:
            try:
                import cv2  # noqa: PLC0415 - TD's Python ships OpenCV; unit tests stub the encoder
                self._cv2 = cv2
            except Exception:  # noqa: BLE001
                self._cv2 = False
        return self._cv2

    def _on_view11(self, c, msg):
        P = self.protocol
        try:
            v = P.parse_view11(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad view: {e}"))
            return
        c.view_msg = {"mode": v["mode"]}
        now = self._now()
        if v["mode"] == "td":
            fresh = not c.view_td
            changed = fresh or v["quality"] != c.vq or (v["viewport"] is not None and v["viewport"] != c.vp)
            c.vq = v["quality"]
            if v["viewport"] is not None:
                c.vp = v["viewport"]
            c.view_td = True
            if fresh:
                c.v_tok = None
                c.v_prev = None
                c.v_prev_applied = None
                c.v_inflight.clear()
                c.v_showing = None
                c.v_next_at = -1e9
            if changed:
                c.vserial += 1
                c.v_changed = now
                c.v_fast_dirty = c.v_exact_dirty = True
        else:
            self._view11_unsub(c)
            c.view_td = False
        self._sync_viewmode()
        self._status_at = 0.0

    def _view11_unsub(self, c):
        """The client left TD mode / disconnected: its GPU nodes and exact buffer go."""
        self._drop_vchain(c.id)
        c.v_prev = None
        c.v_prev_applied = None
        c.v_big = None
        c.v_inflight.clear()
        c.v_fast_dirty = c.v_exact_dirty = False
        c.v_showing = None

    def _on_view_ack(self, c, msg):
        try:
            fid = self.protocol.parse_view_ack(msg)
        except self.protocol.ProtocolError as e:
            self._send(c.id, self.protocol.error(f"bad viewAck: {e}"))
            return
        c.v_inflight.pop(fid, None)
        c.v_acked = True
        c.v_unacked_since = None
        if c.view.stalled:
            c.view.stalled = False
            self._status_at = 0.0
        if c.v_big is not None and c.v_big[0] == fid:
            c.v_big = None

    def _on_view_exact_reset(self, c):
        """The client has no (matching) exact buffer: the next exact frame is a full one, now."""
        c.v_prev = None
        c.v_prev_applied = None
        c.v_exact_dirty = True
        c.v_showing = None
        c.v_changed = min(c.v_changed, self._now() - VIEW_IDLE_S)

    def _view11_reset_all(self):
        """The output's encoding / size changed (Premultiplied toggle, canvas resize): everything in flight is stale."""
        self.vx.reset()
        self.vx.pending = True
        self._vx_frame = None
        now = self._now()
        for c in self._view11_subscribers():
            c.v_fast_dirty = c.v_exact_dirty = True
            c.v_changed = now

    def _view_src(self):
        top = self._opt("doc_out")
        if top is None and self.network is not None:
            top = self.network.output()
        return top

    def _cook_rate(self):  # test seam
        try:
            return float(project.cookRate)  # noqa: F821 - TD global
        except Exception:  # noqa: BLE001
            return 0.0

    def _fast_clients(self, subs, now=0.0):
        """Ids of the clients that get fast frames: asked for them, OpenCV is there, and a GPU chain is free (clients that
        already own one keep it; the others take the free ones in connection order)."""
        if not self._get_cv2():
            return set()
        free = VIEW_MAX_CHAINS
        out = set()
        for c in sorted(subs, key=lambda c: (c.id not in self._vchains, c.seq)):
            if c.vq != "exact" and free > 0 and self._vfail.get(c.id, 0.0) <= now:
                out.add(c.id)
                free -= 1
        return out

    def _poll_view11(self, now):
        subs = self._view11_subscribers()
        if not subs:
            for cid in list(self._vchains):
                self._drop_vchain(cid)
            self._vfail.clear()
            if self.vx.msg is not None or self.vx.conv is not None or self.vx.inflight is not None or self._vx_frame is not None:
                self.vx.reset()
                self._vx_frame = None
            return
        want = self._fast_clients(subs, now)
        for cid in [k for k in self._vchains if k not in want]:
            self._drop_vchain(cid)
        for cid in [k for k in self._vfail if k not in self.clients]:
            del self._vfail[cid]
        for c in subs:
            c.v_eq = c.vq if c.id in want or c.vq == "exact" else "exact"
            if c.id not in want:
                c.v_fast_dirty = False
        if self.network is None or not self._net_applied:
            return
        src = self._view_src()
        src.cook()
        tok = (src.totalCooks, self.doc_w, self.doc_h, bool(self._p("Premultiplied")))
        for c in subs:
            old = [f for f, t in c.v_inflight.items() if now - t > VIEW_ACK_TIMEOUT_S]
            for fid in old:
                del c.v_inflight[fid]   # (a lost ack must not stall the stream)
            if old:
                c.v_acked = False    # back to slow start: one small frame at a time, exact frames announced instead of pushed
                c.v_prev = None      # ... and whatever it missed makes the next exact frame a full one
                c.v_prev_applied = None
                c.v_exact_dirty = True
                if c.v_unacked_since is None:
                    c.v_unacked_since = now
            if c.v_unacked_since is not None and not c.view.stalled and now - c.v_unacked_since > STALL_S:
                c.view.stalled = True
                self._status_at = 0.0
                print(f"[raster_editor] client {c.id} has not acknowledged view frames for {STALL_S:.0f}s: stalled (a frame every "
                      f"{VIEW_ACK_TIMEOUT_S:.0f}s until it does)")
            if tok != c.v_tok or c.vserial != c.v_vserial_seen:
                c.v_tok = tok
                c.v_vserial_seen = c.vserial
                c.v_changed = now
                c.v_fast_dirty = c.id in want
                c.v_exact_dirty = True
        period = 1.0 / max(1, self._p("Maxviewfps"))
        for c in subs:
            if c.id in want and c.v_fast_dirty and len(c.v_inflight) < (VIEW_MAX_INFLIGHT if c.v_acked else 1) and now >= c.v_next_at - 0.002:
                try:
                    if self._send_fast(c, now, src, period):
                        c.v_next_at = max(c.v_next_at + period, now - period / 2)
                except _BmpMismatch:
                    pass   # the chain is still changing size: next tick
                except Exception as e:  # noqa: BLE001 - one client's failure must not starve the others
                    self._report("fast view", e)
                    self._drop_vchain(c.id)
                    self._vfail[c.id] = now + VCHAIN_BACKOFF_S
                    c.v_fast_dirty = False
                    c.v_exact_dirty = True
        t = self._now()
        busy = self.vx.conv is not None or self.vx.inflight is not None or self._vx_frame is not None or self._vx_busy or self._vx_results
        self._poll_vexact(now, subs, tok)
        self._collect_exact(now)
        if busy or self.vx.conv is not None or self._vx_frame is not None:
            self.stats["vxmain"].append(self._now() - t)

    # --- fast frames

    def _fast_geometry(self, c):
        """(integer document region (x, y, w, h), pixel size) of the client's viewport: the visible part of the document at
        device pixels, never more pixels than the region has (no upscaling) and never more than FAST_MAX_PIXELS."""
        W, H = self.doc_w, self.doc_h
        vp = c.vp or {"x": 0.0, "y": 0.0, "w": float(W), "h": float(H), "scale": 1.0}
        cl = lambda v, lo, hi: min(hi, max(lo, v)) if v == v else lo   # noqa: E731 - (also guards a NaN)
        vx, vy = cl(vp["x"], -1e7, 1e7), cl(vp["y"], -1e7, 1e7)
        vw, vh = cl(vp["w"], 1e-3, 1e6), cl(vp["h"], 1e-3, 1e6)
        x0, y0 = max(0, int(vx // 1)), max(0, int(vy // 1))
        x1, y1 = min(W, -int(-(vx + vw) // 1)), min(H, -int(-(vy + vh) // 1))
        if x1 <= x0 or y1 <= y0:
            x0, y0, x1, y1 = 0, 0, W, H
        rw, rh = x1 - x0, y1 - y0
        sc = cl(vp["scale"], 1e-3, 64.0)
        pw, ph = max(1, min(rw, int(rw * sc + 0.5))), max(1, min(rh, int(rh * sc + 0.5)))
        if pw * ph > FAST_MAX_PIXELS:
            f = (FAST_MAX_PIXELS / (pw * ph)) ** 0.5
            pw, ph = max(1, int(pw * f)), max(1, int(ph * f))
        pw, ph = min(pw, GL_MAX_DIM // 2), min(ph, GL_MAX_DIM)   # (the packed texture is 2 * pw wide)
        return (x0, y0, rw, rh), pw, ph

    def _send_fast(self, c, now, src, period):
        """Capture + encode + send one fast frame to ``c``. True when a frame went out."""
        P = self.protocol
        t0 = self._now()
        chain = self._vchains.get(c.id)
        if chain is not None and chain.get("src", src) is not src:
            self._drop_vchain(c.id)   # the output the chain reads was replaced
            chain = None
        if chain is None:
            used = {ch["n"] for ch in self._vchains.values()}
            chain = self._make_vchain(next(n for n in range(VIEW_MAX_CHAINS + 1) if n not in used), src)
            if chain is None:
                raise RuntimeError("the fast view nodes could not be created")
            self._vchains[c.id] = chain
        region, pw, ph = self._fast_geometry(c)
        self._set_vchain(chain, region, pw, ph)
        bgr, alpha = self._capture_fast(chain, pw, ph, bool(self._p("Premultiplied")))
        t1 = self._now()
        rgb = self._encode_jpeg(bgr, c.v_q if c.v_acked else FAST_Q_MIN)
        al = b"" if alpha is None else self._encode_jpeg(alpha, FAST_ALPHA_Q)
        if len(rgb) > FAST_BYTES_BUDGET:
            c.v_q = max(FAST_Q_MIN, c.v_q - 5)
        elif len(rgb) < FAST_BYTES_BUDGET // 2 and c.v_q < FAST_Q_DEFAULT:
            c.v_q = min(FAST_Q_DEFAULT, c.v_q + 5)
        t2 = self._now()
        c.v_fid = (c.v_fid + 1) & 0xFFFFFFFF
        applied = P.NO_APPLIED if c.fid_applied is None else c.fid_applied
        msg = P.encode_view_fast(c.v_fid, applied, self.doc_w, self.doc_h, tuple(float(v) for v in region), pw, ph, rgb, al)
        self._server().webSocketSendBinary(c.id, msg)
        c.v_inflight[c.v_fid] = now
        c.v_fast_dirty = False
        c.v_showing = "fast"
        c.v_nfast += 1
        t3 = self._now()
        self.stats["vfastcap"].append(t1 - t0)
        self.stats["vfastenc"].append(t2 - t1)
        self.stats["vfast"].append(t3 - t0)
        return True

    def _make_vchain(self, n, src):  # pragma: no cover - needs TD (test seam)
        """doc_out -> Crop TOP (document region) -> Resolution TOP (pixel size, 8 bit) -> GLSL TOP (colour | alpha plane, flipped).
        Hidden runtime operators (`_` prefix, tag reRuntime); None when they cannot be created."""
        made = []
        try:
            def mk(kind, name):
                o = self.o.create(kind, f"_view_{name}{n}")
                o.tags.add("reRuntime")
                made.append(o)
                return o
            crop = mk("cropTOP", "crop")
            crop.inputConnectors[0].connect(src)
            for side in ("left", "right", "bottom", "top"):
                setattr(crop.par, f"crop{side}unit", "pixels")
            rs = mk("resolutionTOP", "rs")
            rs.inputConnectors[0].connect(crop)
            rs.par.outputresolution = "custom"
            rs.par.fillmode = "fill"
            rs.par.format = "rgba8fixed"
            try:
                rs.par.inputfiltertype = "mipmap"
            except Exception:  # noqa: BLE001 - older menu
                pass
            px = mk("glslTOP", "px")   # [colour | alpha as grey] side by side, rows top-first: ONE 8 bit readback per frame
            dat = self._opt("view_fast_glsl")
            if dat is None:
                raise RuntimeError("view_fast_glsl is missing (rebuild the component)")
            px.par.pixeldat = dat
            px.par.format = "rgba8fixed"
            px.par.outputresolution = "custom"
            px.par.vec0name = "uCfg"
            px.inputConnectors[0].connect(rs)
            return {"n": n, "ops": made, "crop": crop, "rs": rs, "px": px, "geom": None, "pre": None, "src": src}
        except Exception as e:  # noqa: BLE001
            self._report("view chain", e)
            for o in made:
                try:
                    o.destroy()
                except Exception:  # noqa: BLE001
                    pass
            return None

    def _set_vchain(self, chain, region, pw, ph):  # pragma: no cover - needs TD (test seam)
        pre = 1.0 if self._p("Premultiplied") else 0.0
        if chain["pre"] != pre:
            chain["pre"] = chain["px"].par.vec0valuex = pre   # (also when the geometry did not change: a live Premultiplied toggle)
        geom = (region, pw, ph, self.doc_w, self.doc_h)
        if chain["geom"] == geom:
            return
        chain["geom"] = geom
        x, y, w, h = region
        crop, rs, px = chain["crop"], chain["rs"], chain["px"]
        crop.par.cropleft, crop.par.cropright = x, x + w
        crop.par.cropbottom, crop.par.croptop = self.doc_h - (y + h), self.doc_h - y   # (TD: origin bottom-left)
        rs.par.resolutionw, rs.par.resolutionh = pw, ph
        px.par.resolutionw, px.par.resolutionh = 2 * pw, ph

    def _sweep_view_nodes(self):
        """Orphaned fast-view nodes (a crash / an earlier instance): this instance has none yet."""
        for o in list(getattr(self.o, "children", ()) or ()):
            if re.match(r"^_view_(crop|rs|px)\d+$", str(getattr(o, "name", ""))):
                try:
                    o.destroy()
                except Exception:  # noqa: BLE001
                    pass

    def _drop_all_vchains(self):
        for cid in list(self._vchains):
            self._drop_vchain(cid)
        pool, self._vx_pool = self._vx_pool, None
        if pool is not None:
            pool.shutdown(wait=False)

    def _drop_vchain(self, cid):
        chain = self._vchains.pop(cid, None)
        if chain is not None:
            self._destroy_vchain(chain)

    def _destroy_vchain(self, chain):  # test seam
        for o in reversed(chain.get("ops", ())):
            try:
                o.destroy()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _bmp_bgra(top, w, h):  # pragma: no cover - needs TD
        """saveByteArray('.bmp') of an 8-bit TOP -> (h, w, 4) BGRA view, bottom row first (the alpha byte is not reliable)."""
        raw = np.frombuffer(top.saveByteArray(".bmp"), np.uint8)
        off = int.from_bytes(raw[10:14].tobytes(), "little")
        bw, bh = int.from_bytes(raw[18:22].tobytes(), "little", signed=True), int.from_bytes(raw[22:26].tobytes(), "little", signed=True)
        bpp = int.from_bytes(raw[28:30].tobytes(), "little")
        if bh < 0 and (bw, -bh, bpp) == (w, h, 32):
            raise RuntimeError("top-down BMP from saveByteArray: the fast view assumes bottom-up rows")   # (backs off; exact frames meanwhile)
        if (bw, bh, bpp) != (w, h, 32) or len(raw) < off + w * h * 4:
            raise _BmpMismatch(f"unexpected bmp {bw}x{bh}x{bpp} for {w}x{h}")   # (the resolution is still changing: next tick)
        return raw[off: off + w * h * 4].reshape(h, w, 4)

    def _capture_fast(self, chain, pw, ph, premult):  # pragma: no cover - needs TD (test seam)
        """(BGR uint8 (ph, pw, 3) premultiplied colour, alpha uint8 (ph, pw) | None when fully opaque), top row first. The GLSL TOP
        premultiplies when the output is straight (Premultiplied off)."""
        cv2 = self._get_cv2()
        t = self._now()
        bmp = self._bmp_bgra(chain["px"], 2 * pw, ph)
        t1 = self._now()
        bgr = cv2.cvtColor(bmp[:, :pw], cv2.COLOR_BGRA2BGR)
        alpha = cv2.extractChannel(bmp[:, pw:], 0)
        self.stats["vfastrs"].append(t1 - t)
        self.stats["vfastflip"].append(self._now() - t1)
        if alpha.min() == 255:
            alpha = None
        return bgr, alpha

    def _encode_jpeg(self, arr, q):  # test seam
        cv2 = self._get_cv2()
        ok, buf = cv2.imencode(".jpg", arr, [cv2.IMWRITE_JPEG_QUALITY, int(q)])
        if not ok:
            raise RuntimeError("jpeg encode failed")
        return buf.tobytes()

    # --- exact frames

    def _exact_wanted(self, c, now):
        """Does ``c`` want a fresh exact picture to be READ now (the frame is dispatched once its own conditions hold)?"""
        if not c.v_exact_dirty or c.v_eq == "fast":
            return False
        if c.v_eq == "exact":
            return now >= c.v_next_exact
        return not c.v_fast_dirty and now - c.v_changed >= VIEW_IDLE_S * 0.25

    def _exact_takes(self, c, now, frame_tok, cur_tok):
        if not c.v_exact_dirty or c.v_eq == "fast" or c.v_inflight:
            return False
        if c.v_eq == "exact":
            return now >= c.v_next_exact
        return not c.v_fast_dirty and now - c.v_changed >= VIEW_IDLE_S and frame_tok == cur_tok

    def _poll_vexact(self, now, subs, tok):
        wanted = any(self._exact_wanted(c, now) for c in subs)
        pack = self._opt("view_pack")  # GPU: unpremultiply + flip + scale to 0..255 (CPU then only casts)
        top = pack if pack is not None else self.network.output()
        if wanted:
            top.cook()
            if self._vx_frame is None and not self._vx_busy:
                self.vx.pending = True   # (a reset / new subscriber / viewport change: read even though the picture did not change)
        self._poll_pipe(self.vx, top, now, VIEW_EXACT_PERIOD_S, wanted, (self.doc_w, self.doc_h), packed=pack is not None, key=tok)
        self._dispatch_exact(now, subs, tok)

    def _vx_sink(self, wire, snap, cooks):
        self._vx_frame = {"arr": wire, "snap": snap, "tok": cooks}

    def _dispatch_exact(self, now, subs, cur_tok):
        fr = self._vx_frame
        if fr is None or self._vx_busy:
            return
        targets = [c for c in subs if self._exact_takes(c, now, fr["tok"], cur_tok)]
        if not targets:
            if not any(c.v_eq == "exact" and c.v_exact_dirty for c in subs) and fr["tok"] != cur_tok:
                self._vx_frame = None   # the picture changed again: a fresh read follows
            return
        self._vx_frame = None
        for c in targets:
            c.v_exact_dirty = fr["tok"] != cur_tok   # (a frame read before the latest change leaves the client dirty: `exact` quality takes it, the next read follows)
            c.v_next_exact = now + VIEW_EXACT_PERIOD_S
        job = {"cur": fr["arr"], "snap": fr["snap"], "targets": [(c.id, c.v_prev) for c in targets],
               "mark": {c.id: (c.v_nfast, c.v_tok, c.vserial) for c in targets}}
        self._vx_busy = True
        if self._sync_view_workers:
            self._exact_work(job)
            return
        if self._vx_pool is None:
            self._vx_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="re_exact")
        self._vx_pool.submit(self._exact_work, job)

    def _exact_work(self, job):
        """Worker thread: tile diff per distinct previous frame + zlib (one C call each). Only touches ``job``."""
        t = self._now()
        F = self.frames
        cur = job["cur"]
        plans, bodies, out = {}, {}, {}
        try:
            for cid, prev in job["targets"]:
                key = id(prev)
                if key not in plans:
                    plans[key] = F.plan_exact(cur, prev)
                kind = plans[key][0]
                if kind == "none":
                    out[cid] = None
                    continue
                bk = (key if kind == "tiles" else "full")
                if bk not in bodies:
                    bodies[bk] = F.compress_exact(cur, plans[key])
                out[cid] = bodies[bk]
            job["results"] = out
        except Exception as e:  # noqa: BLE001
            job["error"] = e
        self.stats["vxenc"].append(self._now() - t)
        self._vx_results.append(job)

    def _collect_exact(self, now):
        P = self.protocol
        while self._vx_results:
            job = self._vx_results.popleft()
            self._vx_busy = False
            if "error" in job:
                self._report("exact view", job["error"])
                continue
            cur = job["cur"]
            current_size = (self.doc_h, self.doc_w, 4) == tuple(cur.shape)
            for cid, prev in job["targets"]:
                c = self.clients.get(cid)
                if c is None or not c.view_td or c.protocol < 11:
                    continue
                nf, tok, ser = job["mark"][cid]
                if not current_size or c.v_nfast != nf or (c.v_eq == "auto" and (c.v_tok != tok or c.vserial != ser)):
                    c.v_exact_dirty = True   # a newer fast frame went out / the output or the canvas changed while the worker ran: stale
                    continue
                res = job["results"][cid]
                if (c.v_prev is not prev and not (res is not None and res[0] == 0)) or len(c.v_inflight) >= (VIEW_MAX_INFLIGHT if c.v_acked else 1):
                    c.v_exact_dirty = True   # a reset / ack race: redo against its current state
                    continue
                applied = job["snap"].get(c.cid)
                if res is None:
                    if c.v_showing == "exact" and c.v_prev_applied == applied:
                        continue   # nothing changed for this client and it is already showing the exact picture
                    kind, n, body = 1, 0, zlib.compress(b"", 1)   # "your exact buffer is current": an empty tile frame
                else:
                    kind, n, body = res
                c.v_fid = (c.v_fid + 1) & 0xFFFFFFFF
                msg = P.encode_view_exact(c.v_fid, P.NO_APPLIED if applied is None else applied, cur.shape[1], cur.shape[0], kind, n, body)
                try:
                    if len(msg) <= P.MAX_EXACT_INLINE and c.v_acked:
                        self._server().webSocketSendBinary(c.id, msg)
                        c.v_big = None
                    else:
                        c.v_big = (c.v_fid, msg)
                        self._send(c.id, P.view_exact_notice(c.v_fid, len(msg)))
                except Exception as e:  # noqa: BLE001 - a closing socket must not cost the other clients their frame
                    self._report("exact view send", e)
                    c.v_exact_dirty = True
                    continue
                c.v_inflight[c.v_fid] = now
                c.v_prev = cur
                c.v_prev_applied = applied
                c.v_showing = "exact"

    def _serve_exact(self, request, response, c, pars):
        """GET /view?exact=1&frameId=N: the exact message announced by `viewExact` (same bytes as the binary frame)."""
        big = c.v_big if c is not None else None
        try:
            want = int(pars.get("frameId", -1))
        except (TypeError, ValueError):
            want = -1
        if big is None or big[0] != want:
            return self._cors(request, self._reply(response, 404, "Not Found", "no such exact frame"))
        response["Cache-Control"] = "no-store"
        return self._cors(request, self._reply(response, 200, "OK", big[1], "application/octet-stream"))

    def _sync_viewmode(self):
        act = self.clients.get(self.active_id)
        mode = act.view_msg["mode"] if act is not None and act.view_msg else "local"
        if self._p("Viewmode") != mode:
            self.o.par.Viewmode = mode

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
                ("modules", lambda: self._check_modules(now)), ("router", lambda: self._router_tick(now)),
                ("doc", self._sync_doc_size), ("hints", self._sync_hints),
                ("input", lambda: self._poll_base(now)), ("output", lambda: self._poll_view(now)),
                ("layers", lambda: self._poll_layer_previews(now)),
                ("notify", lambda: self._notify_clients(now)), ("tops", lambda: self._tick_tops(now)),
                ("surfaces", self._cook_surfaces), ("view11", lambda: self._poll_view11(now)), ("files", lambda: self._tick_files(now)), ("choose", self._tick_choose),
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
                self._slot_size = self.protocol.slot_sizes(self._fill_input_sizes(self.doc_layers), w, h)
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
            self._view11_reset_all()
            self._invalidate_previews()
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
                    m = b.get("mask")
                    buf = self.surfaces.get(m.get("slot")) if isinstance(m, dict) else None
                    if buf is not None and (buf.shape[1], buf.shape[0]) != (iw, ih):
                        # the input's mask follows the resolution at once (stretched); the page sends its exact version a moment later
                        self.surfaces[m["slot"]] = self.frames.stretch_buffer(buf, iw, ih)
                        self._slot_size[m["slot"]] = (iw, ih)
                        self._dirty.add(m["slot"])
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
        tmp.tags.add("reRuntime")
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
        sel.tags.add("reRuntime")
        res = None
        try:
            sel.par.top = top.path
            res = self.o.create("resolutionTOP", f"_imp_res{tag}")
            res.tags.add("reRuntime")
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
        """`renderLayer {requestId, layerId, mode?}` (Flatten / merge down, any layer kind) and `renderLayers {requestId, layerIds}`
        (merge selected): the network plans a temporary render network for the request (network.render_open, closed again when the job
        ends) and TD serves its document-size result like a TOP import (`topReady` + `GET /top`, frame type 6)."""
        P = self.protocol
        try:
            req = P.parse_render_request(msg)
        except P.ProtocolError as e:
            self._send(c.id, P.error(f"bad {msg.get('t')}: {e}"))
            return
        rid = req["rid"]
        ids = [req["layerId"]] if req["kind"] == "layer" else req["layerIds"]
        known = {l.get("id") for l in (self.doc_layers or [])}
        missing = next((i for i in ids if i not in known), None)
        if not c.active:
            self._send(c.id, P.top_error(rid, "only the active editor can flatten a layer"))
        elif self._restore_pending or self._held:
            self._send(c.id, P.top_error(rid, "TouchDesigner is still restoring the document; try again"))
        elif missing is not None:
            self._send(c.id, P.top_error(rid, f"layer {missing!r} is not a layer of TouchDesigner's document"))
        elif getattr(self.network, "render_open", None) is None:
            self._send(c.id, P.top_error(rid, "the document network cannot render layers"))
        elif self.doc_w * self.doc_h > P.MAX_TOP_PIXELS:
            self._send(c.id, P.top_error(rid, f"the document ({self.doc_w}x{self.doc_h}) is too large to flatten a layer"))
        else:
            self._req_serial += 1
            self._enqueue_job(c, rid, {"client": c.id, "ccid": c.cid, "rid": rid, "path": None, "req": req,
                                       "rkey": f"job{self._req_serial}", "opened": False,
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

    def _layer_token(self, key):
        fn = getattr(self.network, "render_token", None)
        return fn(key) if fn is not None else None

    def _layer_ready(self, key):
        fn = getattr(self.network, "render_ready", None)
        return True if fn is None else bool(fn(key))

    def _release_job(self, job):
        """Destroy the temporary operators of an import and drop its buffers (a render request's network is closed)."""
        if job.pop("opened", False):
            try:
                self.network.render_close(job["rkey"])
            except Exception as e:  # noqa: BLE001
                self._report("renderClose", e)
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
        req = job.get("req")
        label = job["path"] or (os.path.basename(job["file"]) if job.get("file") else
                                (f"layer {req['layerId']!r}" if req and req["kind"] == "layer" else "the layers"))
        if req is not None:  # Flatten / merge: the network's render source for the request, at the document size
            if job["target"] != (self.doc_w, self.doc_h):
                return self._top_fail(job, "the document was resized while the layer was rendered")
            if not job["opened"]:   # plans the temporary nodes (one apply); they cook from the next pump on
                job["opened"] = True
                try:
                    err = self.network.render_open(job["rkey"], req["kind"], layer_id=req.get("layerId"),
                                                   layer_ids=req.get("layerIds"), mode=req.get("mode", "flatten"))
                except Exception as e:  # noqa: BLE001
                    return self._top_fail(job, f"cannot render {label}: {e}")
                if err:
                    return self._top_fail(job, str(err))
                return
            try:  # re-resolved EVERY pump: an apply() can destroy / recycle the operator behind the request
                top = self.network.render_source(job["rkey"])
            except Exception as e:  # noqa: BLE001
                return self._top_fail(job, f"cannot render {label}: {e}" if job.get("src") is None else "layer changed")
            if top is None:
                return self._top_fail(job, f"cannot render {label}" if job.get("src") is None else "layer changed")
            if job.get("src") is not None and top is not job["src"]:
                return self._top_fail(job, "layer changed")
            job["src"] = top
            if not job.get("ready"):
                if not self._layer_ready(job["rkey"]):  # text measurements still finishing: wait (bounded)
                    status = getattr(self.network, "render_status", None)
                    if status is not None and status(job["rkey"]) == "failed":   # an effect chain (or a text layout) cannot be built: never bake it silently
                        return self._top_fail(job, f"cannot render {label}: an effect or text layout of the layers failed in TouchDesigner (see its Textport)")
                    if now - job["started"] > TOP_READ_TIMEOUT_S:
                        return self._top_fail(job, "readback failed: the layer's text layout never became ready")
                    return
                job["ready"], job["token"] = True, self._layer_token(job["rkey"])  # (measuring refines the layout first)
                job["calls"] = 0   # a delayed read issued before the layout was final is stale: the first result is discarded again
            elif self._layer_token(job["rkey"]) != job["token"]:
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
        if job.get("req") is not None:
            try:
                same = (self.network.render_source(job["rkey"]) is job.get("src")
                        and self._layer_token(job["rkey"]) == job.get("token"))
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
        pipe.conv = {"arr": arr, "out": out, "row": 0, "rows": 128, "snap": prev[1], "packed": packed, "cooks": prev[0]}
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
        """Protocol < 11 clients in TD mode: the v3 `view` notice + GET /view path."""
        return [c for c in self.clients.values() if c.ready and c.view_td and c.protocol < 11]

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
            pipe.pub_cooks = c["cooks"]
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
        if pipe.sink is not None:   # v11 exact stream: the converted frame (ownership passes to the sink)
            pipe.wire = None
            pipe.sink(wire, snap, pipe.pub_cooks)
            self.stats[pipe.stat + "publish"].append(self._now() - t)
            return
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
        if kind == "view" and c is not None and c.protocol >= 11:
            if pars.get("exact") == "1":
                return self._serve_exact(request, response, c, pars)
            return self._cors(request, self._reply(response, 404, "Not Found", "protocol 11 clients get view frames over the WebSocket (exact=1 for large exact frames)"))
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
                nview = len(self._view_subscribers()) + len(self._view11_subscribers())
                if nview:
                    text += f" · {nview} td-view"
                    rate = self._cook_rate()
                    if 0 < rate < 45:
                        text += f" (preview latency follows the {rate:g} fps cook rate)"
                stalled = sum(1 for c in ready if c.view.stalled or any(nt.stalled for nt in c.bases.values()))
                if stalled:
                    text += f" · {stalled} stalled"
        if self._p("Active"):
            if self.is_master:
                text = f"master :{self.port_used} · {text}"
            else:
                rec = self._record()
                if rec and rec.get("path"):
                    text = f"slave of {str(rec['path']).rsplit('/', 1)[-1]} · {text}"
                else:
                    text = f"not served · {text}"
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
