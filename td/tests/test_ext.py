import json
import types

import numpy as np
import pytest

import ext as E
import frames
import protocol as P
from faketd import Clock, FakeOwner, TickClock


import tempfile  # noqa: E402

CACHE_ROOT = tempfile.mkdtemp(prefix="re_undo_cache_test_")


@pytest.fixture(autouse=True)
def _clean_undo_cache():
    import shutil
    shutil.rmtree(CACHE_ROOT, ignore_errors=True)
    yield


class Env:
    def __init__(self, tick=None, like=None, **pars):
        self.o = FakeOwner(**pars)
        if like is not None:  # a reloaded file: same doc_state DAT and Script TOPs, fresh extension
            self.o.doc_state = like.o.doc_state
            self.o._ops["doc_state"] = like.o.doc_state
            self.o.net = like.o.net
            self.o.net.rebind(lambda: self.o.ext)
        self.clock = TickClock(tick) if tick else Clock()
        self.fetch_skip = set()  # clients that never fetch
        self.autofetch = True  # a well-behaved web client fetches every `base` / `view` notice
        self.x = E.RasterEditorExt(self.o)
        self.x._now = self.clock
        self.x._cache_root = lambda: CACHE_ROOT
        self.x._sync_cache_writes = True
        self.x._port_free = lambda p: True   # (the real check connects to the port)
        self.x._sync_file_ops = True   # project / PNG workers run inline
        self.o.ext = self.x
        self.n = 0
        self.opened = []
        self.x._open_url = self.opened.append
        self.renamed = []
        self.x._replace = lambda a, b: self.renamed.append((a, b))
        self.s = self.o.server
        self.fetched = {}  # socket id -> [(header, payload bytes)]
        self.view_frames = {}
        self.autofetch_view = True

    def pump(self, n=1, dt=0.034):
        for _ in range(n):
            self.clock.advance(dt)
            self.x.Pump()
            if self.autofetch:
                for cid, c in list(self.x.clients.items()):
                    if c.base.outstanding is not None and cid not in self.fetch_skip:
                        self.fetch(cid)
                    if c.view.outstanding is not None and cid not in self.fetch_skip and self.autofetch_view:
                        self.fetch_view(cid)

    def connect(self, kind="panel", protocol=10, ready=True, token=None, fresh=False):
        self.n += 1
        cid = f"127.0.0.1:{5000 + self.n}"
        self.s.webSocketConnections.append(cid)
        self.x.OnWebSocketOpen(cid, "/ws?client=" + kind)
        if ready:
            self.send(cid, {"t": "ready", "protocol": protocol, "client": kind, "version": "t", "token": token or self.x.token,
                             "fresh": fresh})
        return cid

    def send(self, cid, msg):
        self.x.OnWebSocketText(cid, json.dumps(msg))

    def fetch(self, cid, token=None):
        """GET /base as the web client behind socket `cid` would (its hello.clientId)."""
        r = self.x.OnHTTPRequest(req(uri="/base", pars={"token": token or self.x.token, "client": self.x.clients[cid].cid}), {})
        if r["statusCode"] == 200:
            h, payload = P.decode_frame(r["data"])
            self.fetched.setdefault(cid, []).append((h, bytes(payload)))
        return r

    def surface(self, cid, slot, rect, pixels, frame_id=1, dw=None, dh=None, end=True, max_payload=P.MAX_PAYLOAD):
        """Send one SURFACE frame (bands) for `slot` from client `cid`."""
        dw = dw or self.x.doc_w
        dh = dh or self.x.doc_h
        msgs = list(P.encode_frames(P.TYPE_SURFACE, frame_id, dw, dh, rect, pixels, max_payload, slot=slot))
        if not end:
            msgs = msgs[:-1]
        for m in msgs:
            self.x.OnWebSocketBinary(cid, m)
        return msgs

    def doc(self, cid, layers, rev=1):
        self.send(cid, {"t": "doc", "rev": rev, "layers": layers})

    def get(self, uri, **pars):
        pars = dict(pars)
        pars.setdefault("token", self.x.token)
        return self.x.OnHTTPRequest(req(uri=uri, pars={k: str(v) for k, v in pars.items()}), {})

    def dump(self, cid, slot):
        """GET /surface as the client behind `cid`: (header, straight wire pixels) or None on 404."""
        r = self.get("/surface", client=self.x.clients[cid].cid, slot=slot)
        if r["statusCode"] != 200:
            return None
        h, payload = P.decode_frame(r["data"])
        return h, np.frombuffer(payload, np.uint8).reshape(h.h, h.w, 4).copy()

    def fetch_view(self, cid):
        r = self.get("/view", client=self.x.clients[cid].cid)
        if r["statusCode"] == 200:
            h, payload = P.decode_frame(r["data"])
            self.view_frames.setdefault(cid, []).append((h, bytes(payload)))
        return r

    def top(self, slot):
        return self.o.net.tops[slot]

    def set_input(self, w, h, seed=0, alpha=None):
        arr = np.random.RandomState(seed).rand(h, w, 4).astype(np.float32)
        if alpha is not None:
            arr[..., 3] = alpha
        self.o.inputs = [object()]
        self.o.in1.set_image(arr)
        return arr

    def run_until_bases(self, cid, frames_=40):
        for _ in range(frames_):
            self.pump()
        return self.bases(cid)

    def bases(self, cid):
        """BASE frames fetched by cid, grouped by frame id -> [(hdr, payload)] (one band each)."""
        out = {}
        for h, p in self.fetched.get(cid, []):
            out.setdefault(h.frame_id, []).append((h, p))
        return out

    def notices(self, cid):
        return self.s.messages(cid, "base")


def IN(n, w=0, h=0):
    """One `inputs` item: connected when it has a size."""
    return {"input": n, "w": w, "h": h, "connected": w > 0}


def wire_of(bands):
    """Reassemble the wire image from fetched bands."""
    return np.concatenate([np.frombuffer(p, np.uint8).reshape(h.h, h.w, 4) for h, p in bands])


@pytest.fixture
def env():
    return Env()


def wire_img(w, h, seed=0, alpha=255):
    a = np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)
    a[..., 3] = alpha
    return a


def L(id, kind="pixel", slot=None, mask=None, **kw):
    d = {"id": id, "kind": kind, "parentId": None, "name": id, "visible": True, "opacity": 1, "blend": "normal",
         "x": 0, "y": 0, "slot": slot, "mask": mask, "adjustment": None}
    d.update(kw)
    return d


DOC = [L("base", "input", input=1), L("p1", slot=1), L("p2", slot=2, mask={"slot": 3, "enabled": True})]
DOC_SIZED = [dict(l, surfaceW=64, surfaceH=32) if l["kind"] in ("input", "pixel") else l for l in DOC]  # as TD hands it to a client


# ----------------------------------------------------------------------------- HTTP

def req(method="GET", uri="/", data=b"", token=None, pars=None, **extra):
    r = {"method": method, "uri": uri, "data": data, "clientAddress": "127.0.0.1:5000", "Host": "127.0.0.1:9980",
         "pars": dict(pars or {})}
    if token is not None:
        r["pars"]["token"] = token
    r.update(extra)
    return r


def test_http_serves_ui_at_root_and_index(env):
    for path in ("/", "/index.html"):
        r = env.x.OnHTTPRequest(req(uri=path), {})
        assert r["statusCode"] == 200 and r["data"] == "<html>ui</html>"
        assert r["content-type"].startswith("text/html")


def test_http_404_elsewhere_and_when_ui_empty(env):
    assert env.x.OnHTTPRequest(req(uri="/nope"), {})["statusCode"] == 404
    assert env.x.OnHTTPRequest(req("POST", "/"), {})["statusCode"] == 404
    env.o.ui.text = ""
    assert env.x.OnHTTPRequest(req(), {})["statusCode"] == 404


def test_test_backchannel_only_with_test_query_and_token(env):
    post = lambda **kw: env.x.OnHTTPRequest(req("POST", "/__test", b'{"x":1}', **kw), {})  # noqa: E731
    assert post(token=env.x.token)["statusCode"] == 404 and env.x.test_result is None
    env.o.storage["reTest"] = 1
    assert post()["statusCode"] == 404  # no token
    assert post(token="wrong")["statusCode"] == 404
    assert post(token=env.x.token)["statusCode"] == 204
    assert env.x.test_result == '{"x":1}'


# ----------------------------------------------------------------------------- clients

def test_first_client_becomes_active_and_gets_hello(env):
    env.pump()
    a = env.connect("external")
    (hello,) = env.s.messages(a, "hello")
    assert hello["protocol"] == 10 and hello["active"] is True and hello["hasInput"] is False
    assert hello["doc"] == {"w": 64, "h": 32, "mode": "input"} and hello["inputs"] == [IN(1)] and "baseSize" not in hello and hello["maxSendFps"] == 30
    assert hello["hasDocument"] is False and hello["rev"] is None


def test_second_client_is_standby(env):
    env.pump()
    a = env.connect("external")
    b = env.connect("external")
    assert env.s.messages(b, "hello")[0]["active"] is False
    assert env.x.active_id == a


def test_panel_reconnect_does_not_steal_from_active_external(env):
    env.pump()
    env.connect("panel")
    ext_c = env.connect("external")
    env.send(ext_c, {"t": "takeover"})
    assert env.x.active_id == ext_c
    p2 = env.connect("panel")  # second panel connection: no priority any more
    assert env.x.active_id == ext_c
    assert env.s.messages(p2, "hello")[0]["active"] is False


def test_takeover_switches_active_and_notifies_both(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.send(b, {"t": "takeover"})
    assert env.x.active_id == b
    assert env.s.messages(a, "active")[-1] == {"t": "active", "active": False}
    assert env.s.messages(b, "active")[-1] == {"t": "active", "active": True}


def test_takeover_by_active_resends_active_true(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "takeover"})
    assert env.s.messages(a, "active")[-1]["active"] is True and env.x.active_id == a


def test_close_active_promotes_most_recent_remaining(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    c = env.connect("external")
    env.x.OnWebSocketClose(a)
    assert env.x.active_id == c
    assert env.s.messages(c, "active")[-1]["active"] is True
    env.x.OnWebSocketClose(c)
    assert env.x.active_id == b
    env.x.OnWebSocketClose(b)
    assert env.x.active_id is None and not env.x.clients


def test_close_standby_keeps_active(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.x.OnWebSocketClose(b)
    assert env.x.active_id == a


def test_close_unknown_client_is_harmless(env):
    env.x.OnWebSocketClose("nobody")


def test_protocol_mismatch_replies_error_and_closes(env):
    env.pump()
    a = env.connect("panel", protocol=99)
    assert env.s.messages(a, "error") and a in env.s.closed
    assert a not in env.x.clients and env.x.active_id is None


def test_wrong_ws_path_is_closed(env):
    env.x.OnWebSocketOpen("c1", "/other")
    assert "c1" in env.s.closed and "c1" not in env.x.clients


def test_garbage_and_unknown_messages(env):
    env.pump()
    a = env.connect("panel")
    env.x.OnWebSocketText(a, "not json")
    assert env.s.messages(a, "error")
    env.send(a, {"t": "somethingNew", "x": 1})  # ignored without error
    env.x.OnWebSocketText("ghost", '{"t":"takeover"}')


def test_messages_before_ready_are_ignored(env):
    env.pump()
    a = env.connect("panel", ready=False)
    env.send(a, {"t": "takeover"})
    assert env.x.active_id is None
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32))
    env.doc(a, DOC)
    assert env.x.doc_layers is None and not env.o.net.applies[1:]


def test_log_messages_rate_limited(env, capsys):
    env.pump()
    a = env.connect("panel")
    for i in range(50):
        env.send(a, {"t": "log", "level": "error", "msg": f"m{i}"})
    out = capsys.readouterr().out
    assert out.count("[raster_editor web error]") == E.LOG_PER_SECOND
    env.clock.advance(1.5)
    env.send(a, {"t": "log", "level": "warn", "msg": "later"})
    assert "later" in capsys.readouterr().out


def test_reconnect_gets_hello_and_full_base_again(env):
    env.set_input(64, 32, 3)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    first = env.bases(a)
    assert len(first) == 1
    env.x.OnWebSocketClose(a)
    b = env.connect("panel")
    assert env.s.messages(b, "hello")[0]["hasInput"] is True
    env.pump(5)
    assert len(env.bases(b)) == 1  # cached wire frame resent without a new readback


# ----------------------------------------------------------------------------- surfaces (protocol v3)

def test_tile_flows_into_td_order_premultiplied_buffer_and_script_top(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    img = wire_img(64, 32, 2, alpha=255)
    img[0, 0] = (10, 20, 30, 255)
    img[31, 63] = (1, 2, 3, 128)
    env.surface(a, 1, (0, 0, 64, 32), img)
    assert 1 in env.x._dirty
    env.pump()
    up = env.top(1).uploaded
    assert up is not None and up.shape == (32, 64, 4) and up.dtype == np.uint8
    assert up[31, 0].tolist() == [10, 20, 30, 255]  # wire top-left -> TD top row (last)
    assert up[0, 63].tolist() == [1, 1, 2, 128]  # premultiplied: round(c * 128 / 255)
    assert not env.x._dirty
    assert env.o.switch.par.index.eval() == 1


def test_premultiplied_off_keeps_straight():
    e = Env(Premultiplied=0)
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC)
    img = wire_img(64, 32, 4, alpha=100)
    e.surface(a, 1, (0, 0, 64, 32), img)
    e.pump()
    assert (e.top(1).uploaded == img[::-1]).all()


def test_mask_surface_is_grey_and_unchanged_by_premultiplication(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    grey = np.zeros((32, 64, 4), np.uint8)
    grey[..., :3] = np.arange(64, dtype=np.uint8)[None, :, None] * 4
    grey[..., 3] = 255
    env.surface(a, 3, (0, 0, 64, 32), grey)
    env.pump()
    assert (env.top(3).uploaded == grey[::-1]).all()


def test_each_slot_has_its_own_buffer(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.pump()
    n2, n3 = len(env.top(2).uploads), len(env.top(3).uploads)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1))
    env.pump()
    assert len(env.top(2).uploads) == n2 and len(env.top(3).uploads) == n3  # clean slots are not cooked
    assert env.x.surfaces[1] is not env.x.surfaces[2] and not env.x.surfaces[2].any()


def test_band_without_frame_end_is_not_uploaded(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    n = env.top(1).cooks
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 5), max_payload=64 * 4 * 8, end=False)  # 3 of 4 bands
    env.pump()
    assert env.top(1).cooks == n and not env.x._dirty
    assert env.x.surfaces[1][env.x.doc_h - 1].any()  # pixels were written already, just not published
    assert env.x.clients[a].fid_pending is None and not env.s.messages(a, "applied")


def test_multiband_frame_uploads_once_at_end(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    img = wire_img(64, 32, 6, alpha=255)
    n = len(env.top(1).uploads)
    env.surface(a, 1, (0, 0, 64, 32), img, max_payload=64 * 4 * 8)
    env.pump()
    assert len(env.top(1).uploads) == n + 1  # coalesced: one upload for four bands
    assert (env.top(1).uploaded == img[::-1]).all()


def test_many_frames_and_tiles_in_one_td_frame_upload_each_dirty_slot_once(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    n1, n2 = len(env.top(1).uploads), len(env.top(2).uploads)
    for i in range(10):
        env.surface(a, 1, (i, 0, 4, 4), wire_img(4, 4, i), frame_id=i)
        env.surface(a, 2, (0, i, 4, 4), wire_img(4, 4, i + 50), frame_id=100 + i)
    env.pump()
    assert len(env.top(1).uploads) == n1 + 1 and len(env.top(2).uploads) == n2 + 1
    env.pump(3)
    assert len(env.top(1).uploads) == n1 + 1  # nothing dirty any more: no further uploads


def test_partial_rect_tile_only_touches_rect(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    before = env.x.surfaces[1].copy()
    env.surface(a, 1, (20, 5, 10, 6), wire_img(10, 6, 2, 255), frame_id=2)
    changed = (env.x.surfaces[1] != before).any(axis=2)
    ys, xs = np.nonzero(changed)
    assert xs.min() >= 20 and xs.max() < 30 and ys.min() >= 32 - 11 and ys.max() < 32 - 5


def test_wrong_doc_size_dropped_silently(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.surface(a, 1, (0, 0, 32, 16), wire_img(32, 16), dw=32, dh=16)
    assert not env.x._dirty and not env.x.surfaces[1].any()
    assert capsys.readouterr().out == ""


def test_unknown_slot_dropped_silently(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.surface(a, 999, (0, 0, 64, 32), wire_img(64, 32))
    assert not env.x._dirty and 999 not in env.x.surfaces and capsys.readouterr().out == ""


def test_tile_before_any_doc_is_dropped(env):
    env.pump()
    a = env.connect("panel")
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32))
    assert not env.x._dirty and not env.x.surfaces


def test_invalid_frames_dropped_and_logged_once_per_frame_id(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    good = P.encode_message(P.Header(P.TYPE_SURFACE, 1, 7, 64, 32, 0, 0, 2, 2, 1), bytes(16))
    bad = good[:-1]
    for _ in range(3):
        env.x.OnWebSocketBinary(a, bad)
    out = capsys.readouterr().out
    assert out.count("dropped invalid frame") == 1
    env.x.OnWebSocketBinary(a, b"junk" * 10)
    env.x.OnWebSocketBinary(a, b"x")
    assert not env.x._dirty
    env.pump()
    assert "ERROR invalid frame" in env.o.par.Status.eval()


def test_type_2_composite_and_other_types_are_ignored(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    old = bytearray(P.encode_message(P.Header(P.TYPE_SURFACE, 1, 1, 64, 32, 0, 0, 64, 32, 1), bytes(64 * 32 * 4)))
    old[4] = 2  # v1/v2 COMPOSITE
    env.x.OnWebSocketBinary(a, bytes(old))
    assert "dropped invalid frame" in capsys.readouterr().out
    for typ in (P.TYPE_BASE, P.TYPE_VIEW, P.TYPE_SURFACE_DUMP):
        env.x.OnWebSocketBinary(a, P.encode_message(P.Header(typ, 1, 1, 64, 32, 0, 0, 64, 32, 1), bytes(64 * 32 * 4)))
    assert not env.x._dirty and not env.x.surfaces[1].any()


def test_tiles_from_standby_are_ignored_then_accepted_after_takeover(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.doc(a, DOC)
    env.pump()
    img = wire_img(64, 32, 1)
    env.surface(b, 1, (0, 0, 64, 32), img)
    assert not env.x._dirty
    env.send(b, {"t": "takeover"})
    env.surface(b, 1, (0, 0, 64, 32), img)
    assert 1 in env.x._dirty
    env.x._dirty.clear()
    env.surface(a, 1, (0, 0, 64, 32), img)  # a is standby now: ignored
    assert not env.x._dirty


def test_applied_once_per_td_frame_and_only_when_changed(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=41)
    env.surface(a, 1, (8, 8, 8, 8), wire_img(8, 8), frame_id=42)
    env.surface(a, 2, (0, 0, 8, 8), wire_img(8, 8), frame_id=43)
    assert not env.s.messages(a, "applied")  # nothing is reported before the upload
    env.pump()
    got = env.s.messages(a, "applied")
    assert [m["frameId"] for m in got] == [43] and all(isinstance(m["tdFrame"], int) for m in got)
    env.pump(5)
    assert len(env.s.messages(a, "applied")) == 1  # unchanged: not repeated
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=44)
    env.pump()
    assert [m["frameId"] for m in env.s.messages(a, "applied")] == [43, 44]


def test_applied_is_reported_to_the_client_that_sent_the_tiles_only(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.doc(a, DOC)
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=9)
    env.pump()
    assert env.s.messages(a, "applied") and not env.s.messages(b, "applied")


def test_applied_waits_while_a_surface_top_does_not_exist_yet(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=9)
    top = env.o.net.tops.pop(1)  # the network has not created the Script TOP yet
    env.pump()
    assert not env.s.messages(a, "applied") and 1 in env.x._dirty
    env.o.net.tops[1] = top
    env.pump()
    assert [m["frameId"] for m in env.s.messages(a, "applied")] == [9]


def test_out_switch_selects_the_network_once_a_stack_was_applied(env):
    env.set_input(64, 32)
    env.pump()
    assert env.o.switch.par.index.eval() == 1  # default document: base layer passthrough inside the network
    env.o.net_module.module.DocNetwork = lambda comp, glsl: (_ for _ in ()).throw(RuntimeError("x"))
    env.x.Start()
    env.pump()
    assert env.o.switch.par.index.eval() == 0  # no network: input passthrough


def test_no_input_output_is_the_network_at_doc_size(env):
    env.pump()
    assert env.o.switch.par.index.eval() == 1
    layers, w, h = env.o.net.applies[-1]
    assert (w, h) == (64, 32) and [l["kind"] for l in layers] == ["input"]


def test_network_failure_keeps_passthrough_and_reports(env, capsys):
    env.o.net_module.module.DocNetwork = lambda comp, glsl, **kw: (_ for _ in ()).throw(RuntimeError("no network"))
    env.x.Start()
    env.pump(3)
    assert env.x.network is None and env.o.switch.par.index.eval() == 0
    assert "network: RuntimeError: no network" in capsys.readouterr().out
    a = env.connect("panel")
    env.doc(a, DOC)  # still stored, still served
    assert env.x.doc_layers == DOC


def test_disconnect_keeps_document_and_buffers(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    img = wire_img(64, 32, 8, 255)
    env.surface(a, 1, (0, 0, 64, 32), img)
    env.pump()
    env.x.OnWebSocketClose(a)
    env.pump(3)
    assert (env.top(1).uploaded == img[::-1]).all() and env.o.switch.par.index.eval() == 1
    assert env.x.doc_layers == DOC


# ----------------------------------------------------------------------------- doc messages

def test_doc_is_applied_to_the_network_and_stored_in_doc_state(env):
    env.pump()
    a = env.connect("panel")
    n = len(env.o.net.applies)
    env.doc(a, DOC, rev=5)
    assert len(env.o.net.applies) == n + 1 and env.o.net.applies[-1] == (DOC, 64, 32)
    assert env.o.net.slots() == [1, 2, 3] and set(env.x.surfaces) == {1, 2, 3}
    assert all(s.shape == (32, 64, 4) for s in env.x.surfaces.values())
    assert env.o.doc_state.text == ""  # written once per pump, not per message
    env.pump()
    stored = json.loads(env.o.doc_state.text)
    assert stored == {"rev": 5, "layers": DOC, "guides": {"h": [], "v": []}, "canvas": {"mode": "input"},
                      "brushPresets": []}


def test_doc_state_written_once_per_pump_with_the_newest_doc(env):
    env.pump()
    a = env.connect("panel")
    writes = []

    class Spy:
        @property
        def text(self):
            return ""

        @text.setter
        def text(self, v):
            writes.append(v)
    env.o._ops["doc_state"] = Spy()
    for r in range(1, 6):
        env.doc(a, DOC, rev=r)
    env.pump()
    assert len(writes) == 1 and json.loads(writes[0])["rev"] == 5


def test_identical_stack_with_new_rev_does_not_reapply_but_updates_rev(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    n = len(env.o.net.applies)
    env.doc(a, DOC, rev=2)
    assert len(env.o.net.applies) == n and env.x.doc_rev == 2


def test_doc_from_standby_is_ignored(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.doc(b, DOC)
    assert env.x.doc_layers is None
    env.doc(a, DOC)
    assert env.x.doc_layers == DOC


def test_bad_doc_replies_error_and_changes_nothing(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    env.send(a, {"t": "doc", "rev": 2, "layers": [{"id": 3}]})
    assert env.s.messages(a, "error") and env.x.doc_rev == 1 and env.x.doc_layers == DOC


def test_duplicate_slots_rejected_without_state_change(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    dup = DOC[:2] + [dict(DOC[2], slot=1)]
    env.doc(a, dup, rev=2)
    assert env.x.doc_rev == 1 and env.s.messages(a, "error")


def test_failed_network_apply_keeps_previous_document(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    env.o.net.raise_on_apply = True
    env.doc(a, DOC[:2], rev=2)
    assert env.x.doc_rev == 1 and env.x.doc_layers == DOC
    assert "apply failed" in capsys.readouterr().out


def test_new_script_tops_are_uploaded_even_without_tiles(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    assert all(env.top(s).uploads for s in (1, 2, 3))  # blank buffers pushed so the TOPs have the doc size
    assert env.top(1).uploaded.shape == (32, 64, 4)


def test_removed_slot_is_freed_at_once_and_a_reappearing_slot_starts_blank_masks_white(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    env.surface(a, 2, (0, 0, 64, 32), wire_img(64, 32, 3, 255))
    assert (env.x.surfaces[3] == 255).all()   # a fresh mask is white (fully visible)
    env.doc(a, DOC[:2], rev=2)  # layer with slot 2 (and mask 3) deleted
    assert env.dump(a, 2) is None and 3 not in env.x._slot_set
    assert 2 not in env.x.surfaces and 3 not in env.x.surfaces
    env.surface(a, 2, (0, 0, 8, 8), wire_img(8, 8), frame_id=9)  # dropped: not in the doc any more
    env.doc(a, DOC, rev=3)  # undo of the delete: blank / white, the engine resends pixels itself
    assert not env.x.surfaces[2].any() and (env.x.surfaces[3] == 255).all()
    env.pump()
    assert not env.top(2).uploaded.any() and (env.top(3).uploaded == 255).all()


def test_slot_kept_across_docs_keeps_its_pixels(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=1)
    img = wire_img(64, 32, 3, 255)
    env.surface(a, 1, (0, 0, 64, 32), img)
    env.doc(a, DOC[:2] + [L("p3", slot=7)], rev=2)
    assert (env.x.surfaces[1][::-1] == img).all()


def test_reconnecting_client_resends_everything_over_the_existing_document(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=4)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    env.pump()
    env.x.OnWebSocketClose(a)
    b = env.connect("panel")  # reconnecting page: fresh=false, authoritative
    (hello,) = env.s.messages(b, "hello")
    assert hello["hasDocument"] is True and hello["rev"] == 4
    new = wire_img(64, 32, 9, 255)
    env.doc(b, DOC, rev=7)
    env.surface(b, 1, (0, 0, 64, 32), new)
    env.pump()
    assert env.x.doc_rev == 7 and (env.top(1).uploaded == new[::-1]).all()


# ----------------------------------------------------------------------------- fresh load / requestDoc / GET /surface

def test_hello_reports_stored_document(env):
    env.pump()
    a = env.connect("panel", fresh=True)
    assert env.s.messages(a, "hello")[0]["hasDocument"] is False
    env.doc(a, DOC, rev=12)
    b = env.connect("external", fresh=True)
    h = env.s.messages(b, "hello")[0]
    assert h["hasDocument"] is True and h["rev"] == 12 and env.x.clients[b].fresh


def test_fresh_load_flow_request_doc_then_surface_per_slot(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=3)
    imgs = {s: wire_img(64, 32, s, 255) for s in (1, 2)}
    for s, im in imgs.items():
        env.surface(a, s, (0, 0, 64, 32), im)
    env.pump()
    b = env.connect("external", fresh=True)
    assert env.s.messages(b, "hello")[0]["hasDocument"] is True
    env.send(b, {"t": "requestDoc"})
    (st,) = env.s.messages(b, "docState")
    assert st == {"t": "docState", "rev": 3, "layers": DOC_SIZED, "docW": 64, "docH": 32, "guides": {"h": [], "v": []},
                  "canvas": {"mode": "input"}, "brushPresets": []}
    for s, im in imgs.items():
        h, got = env.dump(b, s)
        assert (h.type, h.slot, h.frame_end, (h.x, h.y, h.w, h.h)) == (P.TYPE_SURFACE_DUMP, s, True, (0, 0, 64, 32))
        assert (h.doc_w, h.doc_h) == (64, 32)
        assert (got == im).all()  # opaque pixels survive the premultiplied round trip exactly


def test_request_doc_without_document_sends_nothing(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "requestDoc"})
    assert not env.s.messages(a, "docState")


def test_surface_dump_is_straight_alpha_and_masks_stay_grey(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    img = wire_img(64, 32, 5, alpha=255)
    img[3, 4] = (200, 100, 50, 128)
    env.surface(a, 1, (0, 0, 64, 32), img)
    grey = np.zeros((32, 64, 4), np.uint8)
    grey[..., :3] = 77
    grey[..., 3] = 255
    env.surface(a, 3, (0, 0, 64, 32), grey)
    env.pump()
    _, got = env.dump(a, 1)
    assert np.abs(got[3, 4].astype(int) - (200, 100, 50, 128)).max() <= 2  # straight again
    assert (got[0, 0] == img[0, 0]).all()
    _, g = env.dump(a, 3)
    assert (g == grey).all()


def test_surface_dump_with_premultiplied_off_is_the_buffer_flipped():
    e = Env(Premultiplied=0)
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC)
    img = wire_img(64, 32, 6, alpha=90)
    e.surface(a, 1, (0, 0, 64, 32), img)
    assert (e.dump(a, 1)[1] == img).all()


def test_surface_endpoint_auth_unknown_slot_and_cors(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    ok = dict(client=env.x.clients[a].cid)
    assert env.get("/surface", slot=1, **ok)["statusCode"] == 200
    assert env.x.OnHTTPRequest(req(uri="/surface", pars={"slot": "1"}), {})["statusCode"] == 403  # no token
    assert env.get("/surface", token="bad", slot=1, **ok)["statusCode"] == 403
    for slot in ("999", "x", "-1", ""):
        assert env.get("/surface", slot=slot, **ok)["statusCode"] == 404
    assert env.x.OnHTTPRequest(req(uri="/surface", pars={"token": env.x.token}), {})["statusCode"] == 404  # no slot
    r = env.x.OnHTTPRequest(req(uri="/surface", pars={"token": env.x.token, "slot": "1"}, clientAddress="10.0.0.2:1"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/surface", pars={"token": env.x.token, "slot": "1"}, Host="evil.example"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/surface", pars={"token": env.x.token, "slot": "1"}, Origin="http://localhost:5173"), {})
    assert r["Access-Control-Allow-Origin"] == "http://localhost:5173" and r["Vary"] == "Origin"
    r = env.x.OnHTTPRequest(req(uri="/surface", pars={"token": env.x.token, "slot": "1"}, Origin="http://evil.example"), {})
    assert "Access-Control-Allow-Origin" not in r
    assert r["Cache-Control"] == "no-store" and r["content-type"] == "application/octet-stream"


def test_surface_endpoint_is_a_snapshot_not_a_view_of_the_live_buffer(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    r = env.get("/surface", client=env.x.clients[a].cid, slot=1)
    before = bytes(r["data"])
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 2, 255), frame_id=2)
    assert bytes(r["data"]) == before


# ----------------------------------------------------------------------------- takeover

def test_takeover_new_active_loads_tds_document_and_old_active_is_standby(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external", fresh=True)
    env.doc(a, DOC, rev=2)
    im = wire_img(64, 32, 4, 255)
    env.surface(a, 1, (0, 0, 64, 32), im)
    env.send(b, {"t": "takeover"})
    assert env.s.messages(b, "active")[-1]["active"] is True and env.s.messages(a, "active")[-1]["active"] is False
    env.send(b, {"t": "requestDoc"})  # what the new active editor does first
    assert env.s.messages(b, "docState")[0]["rev"] == 2
    assert (env.dump(b, 1)[1] == im).all()
    env.doc(a, DOC[:2], rev=3)  # the old active can no longer edit
    assert env.x.doc_rev == 2


# ----------------------------------------------------------------------------- input / base path

def test_input_is_sent_as_banded_base_frames_flipped_and_unpremultiplied(env):
    arr = env.set_input(64, 32, seed=11, alpha=1.0)
    env.pump()
    a = env.connect("panel")
    frames_ = env.run_until_bases(a)
    assert len(frames_) == 1
    (msgs,) = frames_.values()
    assert msgs[-1][0].frame_end and not any(h.frame_end for h, _ in msgs[:-1])
    assert all(h.type == P.TYPE_BASE and (h.doc_w, h.doc_h) == (64, 32) for h, _ in msgs)
    wire = np.concatenate([np.frombuffer(p, np.uint8).reshape(h.h, h.w, 4) for h, p in msgs])
    expect = np.floor(arr[::-1] * 255 + 0.5).astype(np.uint8)
    assert np.abs(wire.astype(int) - expect).max() <= 1


def test_unchanged_input_is_not_resent(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    n = len(env.s.binaries)
    env.pump(30)
    assert len(env.s.binaries) == n


def test_changed_input_resent_and_rate_limited(env):
    env.o.par.Premultiplied.val = 0
    env.set_input(64, 32, 1)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    # change every pump (dt 34 ms) with Maxinputfps=10 -> at most ~1 frame per 100 ms
    env.o.par.Maxinputfps.val = 10
    start = len(env.bases(a))
    for i in range(60):  # ~2.04 s
        env.o.in1.set_image(np.random.RandomState(100 + i).rand(32, 64, 4))
        env.pump()
    got = len(env.bases(a)) - start
    assert 5 <= got <= 23  # ~2 s * 10 fps, plus slack for the pipelined readback and one frame of burst
    # trailing edge: the final image is eventually delivered
    last = np.random.RandomState(999).rand(32, 64, 4).astype(np.float32)
    env.o.in1.set_image(last)
    env.pump(30)
    final = list(env.bases(a).values())[-1]
    wire = np.concatenate([np.frombuffer(p, np.uint8).reshape(h.h, h.w, 4) for h, p in final])
    assert np.abs(wire.astype(int) - np.floor(last[::-1] * 255 + 0.5)).max() <= 1


def test_delayed_readback_never_requested_synchronously(env):
    env.set_input(64, 32)
    env.pump()
    env.connect("panel")
    env.pump(10)
    assert env.o.in1.readbacks >= 2  # always via numpyArray(delayed=True) (fake enforces 2 calls)


def test_no_readback_without_clients(env):
    env.set_input(64, 32)
    env.pump(20)
    assert env.o.in1.readbacks == 0


def test_standby_clients_also_receive_base(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.run_until_bases(a)
    assert len(env.bases(a)) == 1 and len(env.bases(b)) >= 1


def test_request_base_resends_cached_frame(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.send(a, {"t": "requestBase"})
    env.pump(5)
    assert len(env.fetched[a]) == 2 and len(env.notices(a)) == 2  # re-notified with the stored frame


def test_request_base_without_input_is_noop(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "requestBase"})
    env.pump(5)
    assert not env.notices(a) and not env.s.binaries


def test_input_resize_sends_docsize_and_basesize_new_base_and_keeps_surfaces(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.run_until_bases(a)
    img = wire_img(64, 32, 3, 255)
    env.surface(a, 1, (0, 0, 64, 32), img)
    env.pump()
    uploads = len(env.top(1).uploads)
    env.set_input(80, 40, 2)
    env.pump()
    (ds,) = env.s.messages(a, "docSize")
    assert ds == {"t": "docSize", "w": 80, "h": 40, "hasInput": True, "mode": "input"}
    assert env.s.messages(a, "inputs")[-1] == {"t": "inputs", "items": [IN(1, 80, 40), IN(2)]}  # (+ the spare connector)
    # v5: surfaces keep their own size and pixels; nothing is reallocated or re-uploaded by a document resize
    assert all(b.shape == (32, 64, 4) for b in env.x.surfaces.values())
    assert (env.dump(a, 1)[1] == img).all() and len(env.top(1).uploads) == uploads
    assert env.o.net.applies[-1][1:] == (80, 40)  # network told the new size
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8, 9, 255), dw=64, dh=32)  # a tile for the (unchanged) surface still lands
    assert not (env.dump(a, 1)[1][:8, :8] == img[:8, :8]).all()
    env.pump(30)
    last = list(env.bases(a).values())[-1]
    assert (last[0][0].doc_w, last[0][0].doc_h) == (80, 40)  # BASE frames carry the input size


def test_base_frame_is_the_input_size_not_the_document_size_in_fixed_mode(env):
    env.o.par.Docsizemode.val = "fixed"
    env.o.par.Docw.val, env.o.par.Doch.val = 100, 60
    env.set_input(80, 40, 2)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    assert (env.x.doc_w, env.x.doc_h, env.x.in_w, env.x.in_h) == (100, 60, 80, 40)
    n = env.notices(a)[-1]
    assert (n["docW"], n["docH"], n["w"], n["h"]) == (80, 40, 80, 40)
    h, payload = list(env.bases(a).values())[-1][0]
    assert (h.doc_w, h.doc_h, h.w, h.h, len(payload)) == (80, 40, 80, 40, 80 * 40 * 4)
    env.set_input(60, 30, 3)  # input resolution change while Fixed: baseSize, no docSize, doc unchanged
    env.pump(20)
    assert env.s.messages(a, "inputs")[-1]["items"][0] == IN(1, 60, 30)
    assert not env.s.messages(a, "docSize") and (env.x.doc_w, env.x.doc_h) == (100, 60)
    assert (env.notices(a)[-1]["docW"], env.notices(a)[-1]["docH"]) == (60, 30)


def test_doc_size_change_does_not_touch_surfaces(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    img = wire_img(64, 32, 3, 255)
    env.surface(a, 1, (0, 0, 64, 32), img)
    env.pump()
    uploads = len(env.top(1).uploads)
    env.o.par.Docw.val, env.o.par.Doch.val = 40, 20
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (40, 20)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 40, "h": 20, "hasInput": False, "mode": "input"}
    assert (env.dump(a, 1)[1] == img).all() and len(env.top(1).uploads) == uploads


def test_surfaces_are_allocated_at_their_own_sizes_and_masks_follow_their_layer(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("base", "input", input=1), L("p1", slot=1, surfaceW=20, surfaceH=10, sx=2.0, sy=0.5, x=3.5, y=-2.25),
              L("p2", slot=2, mask={"slot": 3, "enabled": True}, surfaceW=7, surfaceH=9)]
    env.doc(a, layers)
    assert {s: b.shape for s, b in env.x.surfaces.items()} == {1: (10, 20, 4), 2: (9, 7, 4), 3: (9, 7, 4)}
    assert (env.x.surfaces[3] == 255).all()  # a mask starts white
    h, got = env.dump(a, 2)
    assert (h.doc_w, h.doc_h, h.x, h.y, h.w, h.h) == (7, 9, 0, 0, 7, 9) and got.shape == (9, 7, 4)
    # frames are checked against the slot's surface size, not the document's
    px = wire_img(20, 10, 4, 255)
    env.surface(a, 1, (0, 0, 20, 10), px, dw=20, dh=10)
    assert (env.dump(a, 1)[1] == px).all()
    env.surface(a, 1, (0, 0, 20, 10), wire_img(20, 10, 5, 255), dw=64, dh=32)   # the document's size: stale for this slot
    assert (env.dump(a, 1)[1] == px).all()
    env.surface(a, 3, (0, 0, 7, 9), wire_img(7, 9, 6, 255), dw=7, dh=9)
    assert env.dump(a, 3)[1][:, :, 0].any()


def test_spec_size_change_reallocates_that_slot_only_and_drops_old_size_frames(env):
    env.pump()
    a = env.connect("panel")
    layers = lambda w, h: [L("base", "input", input=1), L("p1", slot=1, surfaceW=w, surfaceH=h), L("p2", slot=2, surfaceW=8, surfaceH=8)]
    env.doc(a, layers(16, 8), rev=1)
    px = wire_img(16, 8, 1, 255)
    env.surface(a, 1, (0, 0, 16, 8), px, dw=16, dh=8)
    env.surface(a, 2, (0, 0, 8, 8), wire_img(8, 8, 2, 255), dw=8, dh=8)
    p2 = env.x.surfaces[2].copy()
    env.pump()
    n = len(env.top(1).uploads)
    env.doc(a, layers(32, 24), rev=2)
    assert env.x.surfaces[1].shape == (24, 32, 4) and (env.x.surfaces[2] == p2).all()
    got = env.dump(a, 1)[1]
    assert (got[:8, :16] == px).all() and not got[8:].any()  # kept top-left until the engine's resend
    env.surface(a, 1, (0, 0, 16, 8), wire_img(16, 8, 7, 255), dw=16, dh=8)  # in flight, old size: dropped
    assert (env.dump(a, 1)[1] == got).all()
    full = wire_img(32, 24, 8, 255)
    env.surface(a, 1, (0, 0, 32, 24), full, dw=32, dh=24)
    assert (env.dump(a, 1)[1] == full).all()
    env.pump()
    assert env.top(1).uploaded.shape == (24, 32, 4) and len(env.top(1).uploads) > n
    env.doc(a, layers(32, 24), rev=3)  # unchanged spec: nothing reallocated
    assert (env.dump(a, 1)[1] == full).all()


def test_v4_layer_without_surface_size_keeps_the_buffer_through_a_canvas_resize(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    assert env.x.surfaces[1].shape == (32, 64, 4)
    env.o.par.Docw.val = 100
    env.pump()
    env.doc(a, DOC, rev=2)  # still no surfaceW/H in the spec: the buffer keeps its size (never realloc on canvas resize)
    assert env.x.surfaces[1].shape == (32, 64, 4) and env.x.doc_w == 100


def test_doc_size_change_with_no_surfaces_and_no_document_is_fine(env):
    env.pump()
    env.o.par.Docw.val = 100
    env.pump()
    assert env.x.doc_w == 100 and not env.x.surfaces


def test_input_disconnect_returns_to_doc_par_size(env):
    env.set_input(80, 40)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.o.inputs = []
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.has_input) == (64, 32, False)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 64, "h": 32, "hasInput": False, "mode": "input"}
    assert env.s.messages(a, "inputs")[-1]["items"][0] == IN(1)
    assert env.o.net.applies[-1][1:] == (64, 32)
    assert env.o.switch.par.index.eval() == 1


def test_doc_par_change_without_input_resizes(env):
    env.pump()
    a = env.connect("panel")
    env.o.par.Docw.val = 100
    env.o.par.Doch.val = 50
    env.pump()
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 100, "h": 50, "hasInput": False, "mode": "input"}
    env.o.par.Docw.val = 101  # change when an input is connected must be ignored
    env.o.inputs = [object()]
    env.set_input(10, 10)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (10, 10)


# ----------------------------------------------------------------------------- mouse / keyboard

class PV:
    def __init__(self, name, val):
        self.name, self.val = name, val


class Key:
    def __init__(self, key, character="", state=True, **mods):
        self.key, self.character, self.state = key, character, state
        self.shift = mods.get("shift", False)
        self.alt = mods.get("alt", False)
        self.ctrl = mods.get("ctrl", False)
        self.cmd = mods.get("cmd", False)


# ----------------------------------------------------------------------------- lifecycle / params / status

def test_start_runs_no_server_until_the_editor_is_master(env):
    env.x.Start()
    assert env.s.par.active.val == 0 and not env.x.is_master
    assert env.x.BecomeMaster() is True
    assert env.s.par.active.val == 1 and env.s.par.port.val == 9980 and env.x.is_master
    rec = env.x._record()
    assert rec["path"] == env.o.path and rec["port"] == 9980 and rec["token"] == env.x.token and rec["id"] == env.x.editor_id


def test_pump_starts_extension_lazily():
    e = Env()
    assert not e.x._started
    e.pump()
    assert e.x._started and e.s.par.active.val == 0 and e.x.editor_id


def test_page_url_has_token_and_editor_in_the_fragment_and_devurl_adds_ws(env):
    env.x.BecomeMaster()
    t, eid = env.x.token, env.x.editor_id
    assert env.x._page_url(eid) == f"http://127.0.0.1:9980/#token={t}&e={eid}"
    assert env.x._page_url(eid, test=True) == f"http://127.0.0.1:9980/?test=1#token={t}&e={eid}"
    assert env.x._page_url(eid, "http://localhost:5173/") == f"http://localhost:5173/?ws=ws://127.0.0.1:9980/ws#token={t}&e={eid}"
    assert env.x._page_url(eid, "http://localhost:5173/?a=1").startswith("http://localhost:5173/?a=1&ws=")


def test_start_closes_own_sockets_so_clients_reconnect(env):
    env.pump()
    a = env.connect("external")
    env.x.Start()
    assert env.s.closed == [a] and not env.x.clients


def test_active_off_drops_clients_and_hands_the_server_over(env):
    env.x.BecomeMaster()
    env.pump()
    a = env.connect("external")
    env.o.par.Active.val = 0
    env.x.OnParChange(env.o.par.Active)
    assert env.s.par.active.val == 0 and not env.x.is_master      # no other editor: the server stops
    assert not env.x.clients and a in env.s.closed
    assert env.x._record()["orphan"] is True and env.x._record()["path"] == ""
    env.pump(3)
    assert env.o.par.Status.eval() == "inactive"
    env.o.par.Active.val = 1
    env.x.OnParChange(env.o.par.Active)
    assert env.s.par.active.val == 1 and env.x.is_master        # the project's server resumes with the first active editor
    assert env.x.token == env.x._record()["token"]


def test_port_change_restarts_the_master_server_only(env):
    env.x.BecomeMaster()
    env.pump()
    env.connect("external")
    env.o.par.Port.val = 9999
    env.x.OnParChange(env.o.par.Port)
    assert env.s.par.port.val == 9999 and env.x.port_used == 9999 and not env.x.clients and env.x.is_master
    assert env.x._record()["port"] == 9999


def test_port_change_of_a_slave_is_ignored(env):
    env.pump()
    env.o.par.Port.val = 9999
    env.x.OnParChange(env.o.par.Port)
    assert env.s.par.active.val == 0 and not env.x.is_master


def test_pulses(env):
    env.x.OnParChange(env.o.par.Openbrowser)     # no live master: this editor becomes it, then opens its page
    t, eid = env.x.token, env.x.editor_id
    assert env.x.is_master and env.opened == [f"http://127.0.0.1:9980/#token={t}&e={eid}"]
    env.x.OnParChange(env.o.par.Openbrowser)     # a live master: no second server, same page
    assert len(env.opened) == 2 and env.opened[1] == env.opened[0]


def test_upgradeall_pulse_runs_the_upgrade_module_and_shows_its_report(env):
    env.o._ops["upgrade"] = types.SimpleNamespace(module=types.SimpleNamespace(upgrade_all=lambda comp: {"warning": "upgraded 2, skipped 1", "upgraded": []}))
    env.pump()
    env.x.OnParChange(env.o.par.Upgradeall)
    env.pump()
    assert "upgraded 2, skipped 1" in env.o.par.Status.eval()


def test_upgradeall_without_the_module_is_reported_not_raised(env):
    env.pump()
    env.x.OnParChange(env.o.par.Upgradeall)
    env.pump()
    assert "not available" in env.o.par.Status.eval()


def test_premultiplied_toggle_reencodes_surfaces_and_resends_input(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    img = wire_img(64, 32, 4, alpha=255)
    env.surface(a, 1, (0, 0, 64, 32), img)
    env.surface(a, 2, (0, 0, 64, 32), wire_img(64, 32, 5, alpha=128), frame_id=2)
    env.run_until_bases(a)
    straight = env.dump(a, 2)[1]
    n = len(env.top(2).uploads)
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    env.pump(10)
    assert len(env.bases(a)) == 2  # input resent unpremultiplied
    assert len(env.top(2).uploads) == n + 1  # re-uploaded in the new encoding
    assert (env.x.surfaces[1] == img[::-1]).all()
    assert np.abs(env.dump(a, 2)[1].astype(int) - straight).max() <= 2  # wire content unchanged (8-bit loss)


def test_status_strings(env):
    env.pump()
    assert env.o.par.Status.eval().startswith("not served · waiting for client")
    a = env.connect("panel")
    env.pump(10)
    s = env.o.par.Status.eval()
    assert s.startswith("not served · external active · 64×32 · 0 tiles/s in")
    env.connect("external")
    env.doc(a, DOC, rev=7)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32))
    env.clock.advance(0.3)
    env.pump()
    s = env.o.par.Status.eval()
    assert "1 tiles/s in" in s and "1 standby" in s and "doc r7 3 surfaces" in s


def test_exceptions_are_contained_and_reported_once(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.o.net.out = None  # sabotage a different step first
    env.top(1).raise_on_cook = True
    for i in range(5):
        env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=i)
        env.pump()  # must not raise
    out = capsys.readouterr().out
    assert out.count("cook s1: RuntimeError: boom") == 1
    assert "ERROR cook s1: RuntimeError: boom" in env.o.par.Status.eval()
    env.top(1).raise_on_cook = False
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=9)
    env.pump()
    assert not env.x._dirty


def test_callback_exceptions_do_not_escape(env, capsys):
    env.x.OnWebSocketOpen("127.0.0.1:1", "/ws")
    env.x.protocol = None  # sabotage
    env.x.OnWebSocketText("127.0.0.1:1", "{}")
    env.x.OnWebSocketText("127.0.0.1:1", "{}")
    assert capsys.readouterr().out.count("[raster_editor] _ws_text") == 1
    assert "_ws_text: AttributeError" in env.x.last_error[0]


def test_stats_collected(env):
    env.pump(5)
    a = env.connect("panel")
    env.doc(a, DOC)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32))
    env.pump()
    st = env.x.GetStats()
    assert st["pump"]["n"] >= 6 and st["paste"]["n"] == 1 and st["cook"]["n"] >= 1 and st["apply"]["n"] >= 1


# ----------------------------------------------------------------------------- review fixes

def test_input_change_between_readback_issue_and_return_is_not_lost(env):
    env.o.par.Premultiplied.val = 0
    first = env.set_input(64, 32, 1)
    env.pump()
    a = env.connect("panel")
    env.pump()  # issues the read of `first`
    second = np.random.RandomState(2).rand(32, 64, 4).astype(np.float32)
    env.o.in1.set_image(second)  # changes before the read returns
    env.pump(60)
    last = list(env.bases(a).values())[-1]
    wire = np.concatenate([np.frombuffer(p, np.uint8).reshape(h.h, h.w, 4) for h, p in last])
    assert np.abs(wire.astype(int) - np.floor(second[::-1] * 255 + 0.5)).max() <= 1


def test_readback_none_after_issue_keeps_waiting(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.o.in1.array_backup = env.o.in1.array
    env.o.in1.array = None  # the fake returns None for every request
    env.o.in1.totalCooks += 1
    env.pump(10)
    assert not env.s.binaries
    env.o.in1.array = env.o.in1.array_backup
    env.pump(30)
    assert len(env.bases(a)) == 1


def test_readback_shape_mismatch_is_dropped(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.o.in1.array = np.zeros((10, 10, 4), np.float32)  # stale readback of another size
    env.o.in1.totalCooks += 1
    env.pump(6)
    assert not env.s.binaries
    env.o.in1.set_image(np.random.RandomState(3).rand(32, 64, 4))
    env.pump(30)
    assert len(env.bases(a)) == 1


def test_active_off_switches_to_passthrough_and_keeps_the_document(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    assert env.o.switch.par.index.eval() == 1
    env.o.par.Active.val = 0
    env.x.OnParChange(env.o.par.Active)
    assert env.o.switch.par.index.eval() == 0
    env.o.par.Active.val = 1
    env.x.OnParChange(env.o.par.Active)  # Start: the document comes back from doc_state
    env.pump()
    assert env.x.doc_layers == DOC and env.o.switch.par.index.eval() == 1


def test_non_loopback_peers_rejected(env):
    env.x.OnWebSocketOpen("192.168.1.5:4000", "/ws")
    assert "192.168.1.5:4000" in env.s.closed and not env.x.clients
    env.x.OnWebSocketOpen("[::1]:4000", "/ws")
    assert "[::1]:4000" in env.x.clients
    r = env.x.OnHTTPRequest({"method": "GET", "uri": "/", "clientAddress": "10.0.0.2:5000", "Host": "127.0.0.1:9980"}, {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest({"method": "GET", "uri": "/", "clientAddress": "127.0.0.1:5000", "Host": "evil.example:9980"}, {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest({"method": "GET", "uri": "/", "clientAddress": "127.0.0.1:5000", "Host": "localhost:9980"}, {})
    assert r["statusCode"] == 200


@pytest.mark.parametrize("token", [None, "", "wrong", 5])
def test_ready_without_valid_token_is_refused(env, token):
    env.pump()
    a = env.connect("panel", ready=False)
    msg = {"t": "ready", "protocol": 1, "client": "panel"}
    if token is not None:
        msg["token"] = token
    env.send(a, msg)
    assert env.s.messages(a, "error") and a in env.s.closed and env.x.active_id is None


def test_token_is_the_project_token_and_survives_a_restart(env):
    env.x.BecomeMaster()
    t = env.x.token
    assert len(t) >= 16 and env.x._record()["token"] == t
    env.x.Start()
    assert env.x.token == t and env.x.is_master


@pytest.mark.parametrize("query,enabled", [(1, True), ("1", True), (0, False), ("", False)])
def test_backchannel_requires_the_test_storage_flag(env, query, enabled):
    if query:
        env.o.storage["reTest"] = query
    r = env.x.OnHTTPRequest(req("POST", "/__test", b"x", token=env.x.token), {})
    assert (r["statusCode"] == 204) is enabled


def test_backchannel_body_is_capped(env):
    env.o.storage["reTest"] = 1
    r = env.x.OnHTTPRequest(req("POST", "/__test", b"x" * (E.MAX_TEST_BODY + 1), token=env.x.token), {})
    assert r["statusCode"] == 413 and env.x.test_result is None


@pytest.mark.parametrize("addr,ok", [
    ("127.0.0.1:5000", True), ("127.5.5.5:1", True), ("[::1]:5000", True), ("::1", True), ("[::ffff:127.0.0.1]:80", True),
    ("::ffff:127.0.0.1", True), ("10.0.0.1:5", False), ("::ffff:10.0.0.1", False), ("[2001:db8::1]:80", False),
    ("", False), (None, False), ("garbage", False), ("localhost:80", False),
])
def test_loopback_detection_fails_closed(addr, ok):
    assert E.RasterEditorExt._is_loopback(addr) is ok


def test_missing_client_address_or_host_is_forbidden(env):
    r = req()
    del r["clientAddress"]
    assert env.x.OnHTTPRequest(r, {})["statusCode"] == 403
    r = req()
    del r["Host"]
    assert env.x.OnHTTPRequest(r, {})["statusCode"] == 403


def test_host_header_lookup_is_case_insensitive(env):
    r = req()
    del r["Host"]
    r["host"] = "LOCALHOST:9980"
    assert env.x.OnHTTPRequest(r, {})["statusCode"] == 200
    r["host"] = "[::1]:9980"
    assert env.x.OnHTTPRequest(r, {})["statusCode"] == 200
    r["host"] = "evil.example"
    assert env.x.OnHTTPRequest(r, {})["statusCode"] == 403


@pytest.mark.parametrize("n_clients", [1, 3])
def test_every_client_keeps_receiving_complete_frames_under_continuous_input_change(n_clients):
    env = Env()
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxinputfps.val = 120
    h, w = 540, 960  # 2 bands per frame
    env.o.inputs = [object()]
    env.o.in1.set_image(np.zeros((h, w, 4), np.float32))
    env.pump()
    ids = [env.connect("panel" if i == 0 else "external") for i in range(n_clients)]
    for i in range(160):
        env.o.in1.set_image(np.full((h, w, 4), (i % 50) / 50.0, np.float32))  # changes EVERY pump
        env.pump()
    for cid in ids:
        frames_ = env.bases(cid)
        complete = [fid for fid, bands in frames_.items()
                    if bands[-1][0].frame_end and sum(hh.h for hh, _ in bands) == h]
        assert len(complete) >= 5, (cid, len(complete), len(frames_))
        # frames that are not complete may only be the one in flight at the end
        incomplete = [fid for fid in frames_ if fid not in complete]
        assert len(incomplete) <= 1
        # a client never starts a new frame before finishing the previous one
        order = [P.decode_frame(d)[0] for c, d in env.s.binaries if c == cid]
        for prev, cur in zip(order, order[1:]):
            if cur.frame_id != prev.frame_id:
                assert prev.frame_end


def test_premultiplied_toggle_mid_conversion_restarts_it():
    env = Env(tick=0.001)
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    env.connect("panel")
    for _ in range(20):
        env.pump()
        if env.x.base.conv is not None:
            break
    assert env.x.base.conv is not None
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.x.base.conv is None and env.x.base.pending


def test_failed_buffer_allocation_does_not_commit_the_doc(env, monkeypatch):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    more = DOC + [L("p9", slot=9, surfaceW=30, surfaceH=30)]
    monkeypatch.setattr(env.x.frames, "alloc_buffer", lambda w, h, white=False: (_ for _ in ()).throw(MemoryError("no")))
    env.doc(a, more, rev=2)  # guarded: reported, nothing committed
    assert env.x.doc_layers == DOC and 9 not in env.x.surfaces and env.x.surfaces[1].shape == (32, 64, 4)
    monkeypatch.undo()
    env.doc(a, more, rev=3)
    assert env.x.surfaces[9].shape == (30, 30, 4)


def test_one_failing_pump_step_does_not_skip_the_rest(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    env.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8))
    env.top(1).raise_on_cook = True
    env.o.switch.par.index.val = 0
    env.pump()
    assert env.o.switch.par.index.eval() == 1  # the switch step still ran after the failing upload


def test_dev_module_reload_is_picked_up(env):
    import types
    env.pump()
    new = types.ModuleType("protocol")
    new.__dict__.update(P.__dict__)
    env.o._ops["protocol"].module = new
    env.pump(3, dt=0.5)
    assert env.x.protocol is new


# ----------------------------------------------------------------------------- flow control (ack)

def _big_input(env, h=540, w=960):
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxinputfps.val = 120
    env.o.inputs = [object()]
    env.o.in1.set_image(np.zeros((h, w, 4), np.float32))


def _bytes_to(env, cid):
    return sum(len(d) for c, d in env.s.binaries if c == cid)


# ----------------------------------------------------------------------------- BASE delivery by HTTP pull (protocol v2)

def test_base_notice_fields_and_single_band_whole_frame_fetch(env):
    env.o.par.Premultiplied.val = 0
    arr = env.set_input(64, 32, 3)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    (n,) = env.notices(a)
    assert n == {"t": "base", "input": 1, "frameId": n["frameId"], "docW": 64, "docH": 32, "x": 0, "y": 0, "w": 64, "h": 32}
    ((h, payload),) = env.fetched[a]
    assert (h.type, h.frame_end, h.frame_id, h.x, h.y, h.w, h.h) == (P.TYPE_BASE, True, n["frameId"], 0, 0, 64, 32)
    assert np.abs(wire_of([(h, payload)]).astype(int) - np.floor(arr[::-1] * 255 + 0.5)).max() <= 1
    assert not env.s.binaries  # nothing but JSON ever goes down the WebSocket


def test_full_hd_base_is_one_message_and_conversion_spreads_over_pumps():
    env = Env(tick=0.002)
    env.o.par.Maxinputfps.val = 120
    env.o.inputs = [object()]
    env.o.in1.set_image(np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32))
    env.pump()
    a = env.connect("panel")
    converts = []
    for _ in range(60):
        n = len(env.x.stats["convert"])
        env.pump()
        converts.append(len(env.x.stats["convert"]) - n)
    ((h, payload),) = env.fetched[a]
    assert (h.w, h.h, h.frame_end) == (1920, 1080, True) and len(payload) == 1920 * 1080 * 4
    assert sum(converts) >= 3  # budget resume: several pumps
    assert len(env.x.stats["publish"]) == 1


def test_one_notice_outstanding_until_fetched_and_the_newest_frame_is_served():
    env = Env()
    env.autofetch = False
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxinputfps.val = 120
    env.o.inputs = [object()]
    env.o.in1.set_image(np.zeros((32, 64, 4), np.float32))
    env.pump()
    a = env.connect("panel")
    for i in range(1, 60):
        env.o.in1.set_image(np.full((32, 64, 4), i / 100.0, np.float32))
        env.pump()
    assert len(env.notices(a)) == 1  # frames keep changing, but only one notice is outstanding
    first = env.notices(a)[0]["frameId"]
    r = env.fetch(a)
    (h, payload) = env.fetched[a][-1]
    assert h.frame_id != first and h.frame_id == env.x.base.fid  # newest, not the notified one
    assert r["data"] == env.x.base.msg
    env.o.in1.set_image(np.full((32, 64, 4), 0.9, np.float32))
    env.pump(10)
    assert len(env.notices(a)) == 2  # a newer frame exists now: exactly one more notice


def test_no_new_notice_when_nothing_changed_after_a_fetch(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.pump(40)
    assert len(env.notices(a)) == 1 and len(env.fetched[a]) == 1


def test_client_that_never_fetches_gets_one_notice_then_is_stalled_then_resumes(capsys):
    env = Env()
    env.o.par.Maxinputfps.val = 120
    env.o.inputs = [object()]
    env.o.in1.set_image(np.zeros((32, 64, 4), np.float32))
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    env.fetch_skip = {a}
    for i in range(1, 80):
        env.o.in1.set_image(np.full((32, 64, 4), (i % 30) / 30.0, np.float32))
        env.pump()
    assert len(env.notices(a)) == 1 and len(env.notices(b)) >= 5
    env.pump(3, dt=E.STALL_S / 2 + 0.1)
    assert env.x.clients[a].base.stalled and "1 stalled" in env.o.par.Status.eval()
    assert "stalled" in capsys.readouterr().out
    env.o.in1.set_image(np.full((32, 64, 4), 0.5, np.float32))
    env.pump(20)
    assert len(env.notices(a)) == 1 and not env.s.closed  # still nothing, and never closed from the cook thread
    env.fetch(a)  # it wakes up
    assert not env.x.clients[a].base.stalled
    env.pump(2)
    assert "stalled" not in env.o.par.Status.eval()
    env.o.in1.set_image(np.full((32, 64, 4), 0.25, np.float32))
    env.pump(20)
    assert len(env.notices(a)) == 2  # resumes with a fresh notice for the newest frame


class BoundedSocketServer:
    """Records every byte written to each client, like a kernel socket buffer nobody reads."""

    def __init__(self, server):
        self.written = {}
        for name in ("webSocketSendText", "webSocketSendBinary"):
            orig = getattr(server, name)

            def wrap(client, data, _o=orig):
                self.written[client] = self.written.get(client, 0) + len(data)
                return _o(client, data)
            setattr(server, name, wrap)


def test_nothing_but_tiny_json_is_written_to_a_client_that_never_reads():
    env = Env()
    env.o.par.Maxinputfps.val = 120
    sock = BoundedSocketServer(env.s)
    env.o.inputs = [object()]
    env.o.in1.set_image(np.zeros((540, 960, 4), np.float32))
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    env.fetch_skip = {a, b}  # neither ever fetches, and neither reads its socket
    for i in range(600):
        env.o.in1.set_image(np.full((540, 960, 4), (i % 40) / 40.0, np.float32))
        env.pump(dt=0.1)  # 60 s of simulated time: past the stall timeout
    for cid in (a, b):
        assert sock.written[cid] <= 16 * 1024, sock.written[cid]
    assert not env.s.binaries


def test_fetch_requires_token_and_loopback_and_a_stored_frame(env):
    env.pump()
    a = env.connect("panel")
    assert env.fetch(a)["statusCode"] == 404  # no input, nothing stored
    env.set_input(64, 32)
    env.pump(10)
    cid = env.x.clients[a].cid
    for pars in ({"client": cid}, {"token": "", "client": cid}, {"token": "nope", "client": cid}):
        assert env.x.OnHTTPRequest(req(uri="/base", pars=pars), {})["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/base", token=env.x.token, clientAddress="10.0.0.9:1"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/base", token=env.x.token, Host="evil.example"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(method="POST", uri="/base", token=env.x.token), {})
    assert r["statusCode"] == 404


def test_published_frames_are_immutable_snapshots(env):
    import hashlib
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32, 1)
    env.pump()
    env.connect("panel")
    env.pump(10)
    body = env.x.OnHTTPRequest(req(uri="/base", token=env.x.token), {})["data"]
    digest = hashlib.sha256(body).hexdigest()
    assert isinstance(body, bytes)
    for i in range(10):  # later conversions reuse the scratch buffer; the served bytes must not change
        env.o.in1.set_image(np.random.RandomState(50 + i).rand(32, 64, 4))
        env.pump(6)
    assert hashlib.sha256(body).hexdigest() == digest


def test_resize_mid_conversion_voids_notices_and_serves_only_the_new_size():
    env = Env(tick=0.002)
    env.o.par.Maxinputfps.val = 120
    env.o.par.Premultiplied.val = 0
    env.o.inputs = [object()]
    env.o.in1.set_image(np.random.RandomState(1).rand(540, 960, 4).astype(np.float32))
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(40)
    assert env.x.clients[a].base.outstanding is not None  # notice for the 960x540 frame, unfetched
    env.o.in1.set_image(np.random.RandomState(3).rand(540, 960, 4).astype(np.float32))
    for _ in range(30):  # start another conversion and resize in the middle of it
        env.pump()
        if env.x.base.conv is not None:
            break
    assert env.x.base.conv is not None
    env.o.in1.set_image(np.random.RandomState(2).rand(40, 80, 4).astype(np.float32))
    env.pump()
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 80, "h": 40, "hasInput": True, "mode": "input"}
    assert env.x.base.conv is None and env.x.clients[a].base.outstanding is None
    assert env.fetch(a)["statusCode"] == 404  # the old frame is gone, the new one is not ready yet
    env.pump(30)
    n = env.notices(a)[-1]
    assert (n["docW"], n["docH"]) == (80, 40)
    r = env.fetch(a)
    assert r["statusCode"] == 200
    h, _ = P.decode_frame(r["data"])
    assert (h.doc_w, h.doc_h, h.w, h.h) == (80, 40, 80, 40)


def test_reconnect_gets_a_notice_for_the_stored_frame_without_new_readback(env):
    env.set_input(64, 32, 2)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    reads = env.o.in1.readbacks
    env.x.OnWebSocketClose(a)
    b = env.connect("panel")
    env.pump(5)
    assert env.o.in1.readbacks == reads
    assert len(env.notices(b)) == 1 and len(env.fetched[b]) == 1
    assert env.x.clients[b].cid and env.s.messages(b, "hello")[0]["clientId"] == env.x.clients[b].cid


def test_frame_ids_wrap_around_u32_and_stay_consistent(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32)
    env.pump()
    env.x.base.frame_id = 0xFFFFFFFE
    a = env.connect("panel")
    for i in range(4):
        env.o.in1.set_image(np.full((32, 64, 4), i / 10.0, np.float32))
        env.pump(8)
    ids = [n["frameId"] for n in env.notices(a)]
    assert len(ids) >= 3 and 0 in ids or 1 in ids
    assert ids == sorted(ids, key=lambda i: (i + 2) % 2 ** 32)  # increasing modulo 2**32
    assert [h.frame_id for h, _ in env.fetched[a]] == ids and all(0 <= i < 2 ** 32 for i in ids)


def test_unfetched_standby_and_active_clients_are_tracked_separately(env):
    env.set_input(64, 32)
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    env.fetch_skip = {b}
    env.pump(10)
    assert len(env.fetched[a]) == 1 and not env.fetched.get(b)
    assert len(env.notices(b)) == 1
    env.fetch(b)
    assert env.x.clients[b].base.outstanding is None and env.x.clients[b].base.fetched == env.x.base.fid


def test_fetch_with_unknown_client_id_still_serves_but_marks_nobody(env):
    env.set_input(64, 32)
    env.pump(1)
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    r = env.x.OnHTTPRequest(req(uri="/base", pars={"token": env.x.token, "client": "ghost"}), {})
    assert r["statusCode"] == 200 and env.x.clients[a].base.outstanding is not None


# ----------------------------------------------------------------------------- liveness regressions

def test_request_base_renotifies_even_with_an_unfetched_notice_outstanding(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}  # the client's fetch "failed": it never fetched the notice
    env.pump(10)
    assert len(env.notices(a)) == 1 and env.x.clients[a].base.outstanding is not None
    env.send(a, {"t": "requestBase"})
    assert env.x.clients[a].base.outstanding is None and not env.x.clients[a].base.stalled
    env.pump(3)
    assert len(env.notices(a)) == 2  # re-announced, not stuck until stalled
    env.fetch_skip = set()
    env.pump(3)
    assert len(env.fetched[a]) == 1


def test_request_base_clears_a_stalled_flag(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(3)
    env.pump(2, dt=E.STALL_S)
    assert env.x.clients[a].base.stalled
    env.send(a, {"t": "requestBase"})
    env.pump(3)
    assert not env.x.clients[a].base.stalled and len(env.notices(a)) == 2


def test_404_on_base_clears_the_clients_outstanding_notice(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    assert env.x.clients[a].base.outstanding is not None
    env.x.base.msg = None  # frame vanished between notice and fetch
    assert env.fetch(a)["statusCode"] == 404
    assert env.x.clients[a].base.outstanding is None and env.x.clients[a].base.fetched is None


def test_premultiplied_toggle_does_not_strand_clients_on_the_old_image(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32, 1)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    assert env.x.clients[a].base.outstanding is not None
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.x.clients[a].base.outstanding is None and not env.x.clients[a].base.stalled
    env.fetch_skip = set()
    env.pump(30)
    assert len(env.notices(a)) == 2 and len(env.fetched[a]) == 1  # a fresh notice for the re-converted frame


def test_resize_clears_outstanding_and_stalled_for_every_client(env):
    env.set_input(64, 32)
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    env.fetch_skip = {a, b}
    env.pump(3)
    env.pump(2, dt=E.STALL_S)
    assert env.x.clients[a].base.stalled
    env.set_input(80, 40, 2)
    env.pump()
    assert all(c.base.outstanding is None and not c.base.stalled for c in env.x.clients.values())


def test_cors_only_for_loopback_origins_and_tokens_still_required(env):
    env.set_input(64, 32)
    env.pump(10)
    a = env.connect("panel")
    env.pump(10)
    cid = env.x.clients[a].cid

    def get(origin=None, token=True, **kw):
        r = req(uri="/base", pars={"token": env.x.token if token else "bad", "client": cid}, **kw)
        if origin is not None:
            r["Origin"] = origin
        return env.x.OnHTTPRequest(r, {})

    for origin in ("http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "http://localhost"):
        r = get(origin)
        assert r["statusCode"] == 200 and r["Access-Control-Allow-Origin"] == origin and r["Vary"] == "Origin"
    for origin in ("https://localhost:5173", "http://evil.example", "http://localhost.evil.example", "null",
                   "http://127.0.0.1.evil.example:80", None):
        assert "Access-Control-Allow-Origin" not in get(origin)
    r = get("http://localhost:5173", token=False)  # errors are readable by the page too, but never skip auth
    assert r["statusCode"] == 403 and r["Access-Control-Allow-Origin"] == "http://localhost:5173"
    assert get("http://localhost:5173", clientAddress="10.1.1.1:5")["statusCode"] == 403
    env.x.base.msg = None
    assert get("http://localhost:5173")["Access-Control-Allow-Origin"] == "http://localhost:5173"  # 404 too


def test_frame_id_is_never_reset_by_invalidations_or_active_toggles(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32)
    env.pump()
    env.connect("panel")
    env.pump(10)
    seen = [env.x.base.frame_id]
    for step in ("premult", "resize", "active"):
        if step == "premult":
            env.o.par.Premultiplied.val = 0
            env.x.OnParChange(env.o.par.Premultiplied)
        elif step == "resize":
            env.set_input(80, 40, 2)
        else:
            env.o.par.Active.val = 0
            env.x.OnParChange(env.o.par.Active)
            env.o.par.Active.val = 1
            env.x.OnParChange(env.o.par.Active)
        env.pump(20)
        seen.append(env.x.base.frame_id)
    assert seen == sorted(seen) and seen[2] > seen[0] and seen[0] > 0  # monotonic across premult, resize and a restart


# ----------------------------------------------------------------------------- view messages

VIEW_RECT = {"x": 10, "y": 20, "w": 800, "h": 600}


def vmsg(mode="td", zoom=2.0, pan_x=5.0, pan_y=-3.0, rect=None):
    return {"t": "view", "mode": mode, "zoom": zoom, "panX": pan_x, "panY": pan_y, "rect": dict(rect or VIEW_RECT)}


def set_output(env, seed=0, w=64, h=32, alpha=None):
    arr = np.random.RandomState(seed).rand(h, w, 4).astype(np.float32)
    if alpha is not None:
        arr[..., 3] = alpha
    env.o.net.out.set_image(arr)
    return arr


def test_bad_view_message_replies_error(env):
    env.pump()
    p = env.connect("panel")
    env.send(p, {"t": "view", "mode": "td", "zoom": "x"})
    assert env.s.messages(p, "error")


def test_viewmode_mirrors_the_active_clients_choice(env):
    env.pump()
    p = env.connect("panel")
    e = env.connect("external")
    env.send(e, vmsg("td"))
    assert env.o.par.Viewmode.eval() == "local"  # panel is active
    env.send(p, vmsg("td"))
    assert env.o.par.Viewmode.eval() == "td"
    env.send(e, {"t": "takeover"})
    assert env.o.par.Viewmode.eval() == "td"
    env.send(e, vmsg("local"))
    assert env.o.par.Viewmode.eval() == "local"
    env.x.OnWebSocketClose(e)
    assert env.o.par.Viewmode.eval() == "td"  # panel is active again


# ----------------------------------------------------------------------------- VIEW stream (external, mode td)

def test_no_view_stream_without_subscribers(env):
    env.pump()
    env.connect("external")
    set_output(env)
    env.pump(10)
    assert env.o.net.out.readbacks == 0 and not env.x.out.msg


def test_view_stream_notice_and_get_view_return_the_output_flipped_and_unpremultiplied():
    env = Env(Premultiplied=0)
    env.pump()
    e = env.connect("external")
    arr = set_output(env, 3, alpha=1.0)
    env.send(e, vmsg("td"))
    env.pump(10)
    (n,) = env.s.messages(e, "view")
    assert n == {"t": "view", "frameId": n["frameId"], "docW": 64, "docH": 32, "w": 64, "h": 32, "appliedFrameId": -1}
    ((h, payload),) = env.view_frames[e]
    assert (h.type, h.slot, h.frame_end, h.frame_id, (h.x, h.y, h.w, h.h)) == (P.TYPE_VIEW, 0, True, n["frameId"], (0, 0, 64, 32))
    got = np.frombuffer(payload, np.uint8).reshape(32, 64, 4)
    assert np.abs(got.astype(int) - np.floor(arr[::-1] * 255 + 0.5)).max() <= 1
    assert not env.s.binaries  # never binary on the WebSocket
    assert not env.fetched.get(e)  # and no BASE traffic without an input


def test_view_stream_uses_the_budgeted_pipeline_with_delayed_readback(env):
    env.pump()
    e = env.connect("external")
    set_output(env)
    env.send(e, vmsg("td"))
    env.pump(6)
    assert env.o.net.out.readbacks >= 2
    st = env.x.GetStats()
    assert st["vreadback"]["n"] >= 2 and st["vconvert"]["n"] >= 1 and st["vpublish"]["n"] == 1


def test_view_not_resent_while_output_unchanged_and_resent_when_it_changes(env):
    env.pump()
    e = env.connect("external")
    set_output(env, 1)
    env.send(e, vmsg("td"))
    env.pump(20)
    assert len(env.s.messages(e, "view")) == 1
    set_output(env, 2)
    env.pump(20)
    assert len(env.s.messages(e, "view")) == 2


def test_view_rate_limited_by_maxviewfps(env):
    env.o.par.Maxviewfps.val = 10
    env.pump()
    e = env.connect("external")
    set_output(env, 0)
    env.send(e, vmsg("td"))
    env.pump(5)
    start = len(env.s.messages(e, "view"))
    for i in range(60):  # 2.04 s, output changes every pump
        set_output(env, 100 + i)
        env.pump()
    got = len(env.s.messages(e, "view")) - start
    assert 5 <= got <= 23
    last = set_output(env, 999)  # trailing edge is never lost
    env.pump(30)
    h, payload = env.view_frames[e][-1]
    env.o.par.Premultiplied.val = 1
    assert h.frame_id == env.x.out.fid


def test_view_and_base_are_independent_streams():
    env = Env(Premultiplied=0)
    env.set_input(64, 32, 1)
    env.pump()
    e = env.connect("external")
    set_output(env, 2)
    env.send(e, vmsg("td"))
    env.pump(20)
    assert len(env.s.messages(e, "base")) == 1 and len(env.s.messages(e, "view")) == 1
    b = env.bases(e)
    assert next(iter(b.values()))[0][0].type == P.TYPE_BASE
    assert env.view_frames[e][0][0].type == P.TYPE_VIEW
    # frame ids are per stream
    assert env.x.base.frame_id >= 1 and env.x.out.frame_id >= 1


def test_get_view_requires_subscription_token_and_loopback(env):
    env.pump()
    e = env.connect("external")
    set_output(env)
    cid = env.x.clients[e].cid
    assert env.get("/view", client=cid)["statusCode"] == 404  # not subscribed
    env.send(e, vmsg("td"))
    assert env.get("/view", client=cid)["statusCode"] == 404  # subscribed, nothing converted yet
    env.pump(10)
    assert env.get("/view", client=cid)["statusCode"] == 200
    assert env.get("/view", client="nobody")["statusCode"] == 404
    assert env.get("/view", token="nope", client=cid)["statusCode"] == 403
    assert env.x.OnHTTPRequest(req(uri="/view", pars={"client": cid}), {})["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/view", token=env.x.token, pars={"client": cid}, clientAddress="10.0.0.9:1"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/view", pars={"token": env.x.token, "client": cid}, Host="evil.example"), {})
    assert r["statusCode"] == 403
    r = env.x.OnHTTPRequest(req(uri="/view", pars={"token": env.x.token, "client": cid}, Origin="http://localhost:5173"), {})
    assert r["Access-Control-Allow-Origin"] == "http://localhost:5173" and r["Vary"] == "Origin"
    r = env.x.OnHTTPRequest(req(uri="/view", pars={"token": env.x.token, "client": cid}, Origin="http://evil.example"), {})
    assert "Access-Control-Allow-Origin" not in r and r["Cache-Control"] == "no-store"


def test_one_view_notice_outstanding_and_newest_frame_served():
    env = Env()
    env.autofetch_view = False
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxviewfps.val = 120
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    for i in range(40):
        set_output(env, i)
        env.pump()
    assert len(env.s.messages(e, "view")) == 1
    first = env.s.messages(e, "view")[0]["frameId"]
    env.fetch_view(e)
    h, _ = env.view_frames[e][-1]
    assert h.frame_id != first and h.frame_id == env.x.out.fid
    set_output(env, 99)
    env.pump(10)
    assert len(env.s.messages(e, "view")) == 2


def test_view_stall_after_10s_then_resumes_on_fetch(capsys):
    env = Env()
    env.autofetch_view = False
    env.o.par.Maxviewfps.val = 120
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    set_output(env, 0)
    env.pump(10)
    assert len(env.s.messages(e, "view")) == 1
    env.pump(3, dt=E.STALL_S / 2 + 0.1)
    assert env.x.clients[e].view.stalled and "1 stalled" in env.o.par.Status.eval()
    assert "view frame" in capsys.readouterr().out
    set_output(env, 1)
    env.pump(20)
    assert len(env.s.messages(e, "view")) == 1 and not env.s.closed
    env.fetch_view(e)
    assert not env.x.clients[e].view.stalled
    set_output(env, 2)
    env.pump(20)
    assert len(env.s.messages(e, "view")) == 2


def test_view_stall_is_independent_of_the_base_stream():
    env = Env()
    env.autofetch_view = False
    env.set_input(64, 32)
    env.o.par.Maxviewfps.val = 120
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    set_output(env)
    env.pump(10)
    env.pump(3, dt=E.STALL_S / 2 + 0.1)
    c = env.x.clients[e]
    assert c.view.stalled and not c.base.stalled


def test_new_td_mode_message_clears_stall_and_reannounces():
    env = Env()
    env.autofetch_view = False
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    set_output(env)
    env.pump(10)
    env.pump(3, dt=E.STALL_S / 2 + 0.1)
    assert env.x.clients[e].view.stalled
    env.send(e, vmsg("td", zoom=4.0))  # zoom/pan changes while subscribed do not re-announce
    assert env.x.clients[e].view.stalled
    env.send(e, vmsg("local"))
    env.send(e, vmsg("td"))
    assert not env.x.clients[e].view.stalled and env.x.clients[e].view.outstanding is None
    env.pump(5)
    assert len(env.s.messages(e, "view")) == 2  # same stored frame, announced again


def test_leaving_td_mode_stops_the_stream_and_drops_the_frame(env):
    env.pump()
    e = env.connect("external")
    set_output(env)
    env.send(e, vmsg("td"))
    env.pump(10)
    assert env.x.out.msg is not None
    env.send(e, vmsg("local"))
    env.pump(2)
    assert env.x.out.msg is None
    n = env.o.net.out.readbacks
    set_output(env, 5)
    env.pump(10)
    assert env.o.net.out.readbacks == n
    assert env.get("/view", client=env.x.clients[e].cid)["statusCode"] == 404


def test_closing_the_only_subscriber_stops_the_stream(env):
    env.pump()
    e = env.connect("external")
    set_output(env)
    env.send(e, vmsg("td"))
    env.pump(10)
    env.x.OnWebSocketClose(e)
    env.pump(2)
    assert env.x.out.msg is None


def test_second_subscriber_gets_the_stored_frame_without_a_new_readback(env):
    env.pump()
    e1 = env.connect("external")
    set_output(env)
    env.send(e1, vmsg("td"))
    env.pump(10)
    n = env.o.net.out.readbacks
    e2 = env.connect("external")
    env.send(e2, vmsg("td"))
    env.pump(5)
    assert len(env.s.messages(e2, "view")) == 1 and env.o.net.out.readbacks == n


def test_doc_size_change_voids_view_notices_and_serves_only_the_new_size():
    env = Env()
    env.autofetch_view = False
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    set_output(env)
    env.pump(10)
    assert env.x.clients[e].view.outstanding is not None
    env.o.par.Docw.val, env.o.par.Doch.val = 80, 40
    env.pump()
    assert env.x.clients[e].view.outstanding is None and env.x.out.msg is None
    assert env.get("/view", client=env.x.clients[e].cid)["statusCode"] == 404
    env.autofetch_view = True
    set_output(env, 4, w=80, h=40)
    env.pump(20)
    h, _ = env.view_frames[e][-1]
    assert (h.doc_w, h.doc_h) == (80, 40)


def test_output_readback_of_the_wrong_size_is_dropped(env):
    env.pump()
    e = env.connect("external")
    env.send(e, vmsg("td"))
    set_output(env, w=10, h=10)
    env.pump(10)
    assert not env.s.messages(e, "view")


def test_applied_frame_id_in_view_notice_is_the_frame_uploaded_before_the_readback(env):
    env.pump()
    e = env.connect("external")
    env.send(e, {"t": "takeover"})
    env.doc(e, DOC)
    env.pump()
    env.surface(e, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=77)
    env.pump()  # uploaded
    set_output(env, 1)
    env.send(e, vmsg("td"))
    env.pump(10)
    assert env.s.messages(e, "applied")[-1]["frameId"] == 77
    assert env.s.messages(e, "view")[-1]["appliedFrameId"] == 77
    # a frame that arrives in the same pump as the readback issue is not claimed by it
    env.x.out.pending = True
    env.o.net.out.totalCooks += 1
    env.surface(e, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=78)
    env.pump()  # issues the read (snapshot 77) and then uploads 78
    env.pump(3)
    assert env.s.messages(e, "applied")[-1]["frameId"] == 78
    assert env.s.messages(e, "view")[-1]["appliedFrameId"] == 77
    env.o.net.out.totalCooks += 1
    env.pump(10)  # the next read starts after 78 was uploaded
    assert env.s.messages(e, "view")[-1]["appliedFrameId"] == 78


def test_view_notice_never_goes_to_clients_that_are_not_in_td_mode(env):
    env.pump()
    a = env.connect("panel")
    e1 = env.connect("external")
    e2 = env.connect("external")
    set_output(env)
    env.send(e1, vmsg("td"))
    env.send(e2, vmsg("local"))
    env.pump(10)
    assert env.s.messages(e1, "view") and not env.s.messages(e2, "view") and not env.s.messages(a, "view")


# ----------------------------------------------------------------------------- persistence

def settled_env(**kw):
    e = Env(**kw)
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC, rev=6)
    e.imgs = {1: wire_img(64, 32, 11, 255), 2: wire_img(64, 32, 12, 200), 3: wire_img(64, 32, 13, 255)}
    e.imgs[3][..., :3] = e.imgs[3][..., :1]  # grey mask
    for s, im in e.imgs.items():
        e.surface(a, s, (0, 0, 64, 32), im, frame_id=s)
    e.pump()
    e.a = a
    return e


def test_freeze_flushes_doc_state_uploads_pending_and_locks(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC, rev=3)
    env.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    env.x.Freeze()  # before any pump ran: everything pending is flushed first
    assert json.loads(env.o.doc_state.text)["rev"] == 3
    assert (env.top(1).uploaded == env.x.surfaces[1]).all() and not env.x._dirty
    assert env.o.net.frozen and env.x.frozen
    env.x.Thaw()
    assert not env.o.net.frozen and not env.x.frozen and env.o.net.thaws == 1


def test_restore_rebuilds_network_and_buffers_from_doc_state_and_locked_tops():
    a = settled_env()
    a.x.Freeze()
    n = len(a.o.net.applies)
    b = Env(like=a)  # the file was reopened: new extension, same DATs / Script TOPs
    b.pump()
    assert b.x.doc_layers == DOC and b.x.doc_rev == 6
    assert b.o.net.applies[n][0] == DOC  # restored straight into the stored document, no default stack first
    for s, im in a.imgs.items():
        assert (b.x.surfaces[s] == a.x.surfaces[s]).all(), s
    assert not b.o.net.frozen and b.o.net.thaws >= 1 and not b.x.frozen
    c = b.connect("panel", fresh=True)
    h = b.s.messages(c, "hello")[0]
    assert h["hasDocument"] is True and h["rev"] == 6
    b.send(c, {"t": "requestDoc"})
    assert b.s.messages(c, "docState")[0]["layers"] == DOC_SIZED
    assert (b.dump(c, 1)[1] == a.imgs[1]).all()  # opaque layers come back bit-exact
    assert np.abs(b.dump(c, 2)[1].astype(int) - a.imgs[2]).max() <= 2  # premultiplied round trip
    assert b.top(1).uploaded is not None and (b.top(1).uploaded == a.x.surfaces[1]).all()


def test_restore_to_a_different_doc_size_anchors_top_left():
    a = settled_env()
    a.x.Freeze()
    n = len(a.o.net.applies)
    b = Env(like=a, Docw=40, Doch=20)
    b.pump()
    assert (b.x.doc_w, b.x.doc_h) == (40, 20)
    assert (b.x.surfaces[1] == a.x.surfaces[1][32 - 20:, :40]).all()
    assert b.o.net.applies[n][1:] == (40, 20)


def test_start_without_stored_document_applies_the_default_stack():
    e = Env()
    e.pump()
    assert e.x.doc_layers is None and e.x.doc_rev is None
    assert [l["kind"] for l in e.o.net.applies[0][0]] == ["input"]
    e.send(e.connect("panel"), {"t": "requestDoc"})


def test_corrupt_doc_state_is_reported_and_start_continues(capsys):
    e = Env()
    e.o.doc_state.text = "{not json"
    e.x.Start()
    e.pump()
    assert e.x._started and e.x.doc_layers is None and "Restore" in capsys.readouterr().out
    assert e.o.net.applies  # default stack applied


def test_doc_state_with_invalid_layers_is_ignored(capsys):
    e = Env()
    e.o.doc_state.text = json.dumps({"rev": 1, "layers": [{"id": 1}]})
    e.x.Start()
    assert e.x.doc_layers is None and "Restore" in capsys.readouterr().out


def test_restore_when_the_network_is_missing_keeps_the_document():
    a = settled_env()
    b = Env(like=a)
    b.o.net_module.module.DocNetwork = lambda comp, glsl: (_ for _ in ()).throw(RuntimeError("x"))
    b.x.Start()
    assert b.x.network is None and b.x.doc_layers == DOC and b.x.doc_rev == 6


def test_savetox_freezes_around_the_save_and_thaws_after():
    e = settled_env()
    assert e.x.SaveTox("/tmp/x.tox") == "/tmp/x.tox"
    ((path, frozen_during, state_during),) = e.o.saved
    assert path == "/tmp/x.part.tox" and frozen_during is True and json.loads(state_during)["rev"] == 6
    assert e.renamed == [("/tmp/x.part.tox", "/tmp/x.tox")]   # temp file, then renamed over the target
    assert not e.o.net.frozen and not e.x.frozen and e.o.net.thaws == 1


def test_savetox_thaws_even_when_the_save_fails():
    e = settled_env()
    e.o.save = lambda path: (_ for _ in ()).throw(OSError("disk full"))
    with pytest.raises(OSError):
        e.x.SaveTox("/tmp/x.tox")
    assert not e.o.net.frozen and not e.x.frozen


def test_exportdoc_pulse_saves_to_the_export_path(env, tmp_path):
    env.pump()
    target = tmp_path / "out.tox"
    env.o.par.Exportpath.val = str(target)
    env.x.OnParChange(env.o.par.Exportdoc)
    assert env.o.saved[0][0] == str(tmp_path / "out.part.tox") and env.renamed == [(str(tmp_path / "out.part.tox"), str(target))]
    assert "exported with document to " + str(target) in env.x.GetStatus() or env.x._flash[0].endswith(str(target))


def test_freeze_thaw_round_trip_keeps_state_and_output_identical():
    e = settled_env()
    before = {s: e.top(s).uploaded.copy() for s in e.imgs}
    rev = e.x.doc_rev
    e.x.Freeze()
    e.x.Thaw()
    e.pump(3)
    assert e.x.doc_rev == rev
    for s in e.imgs:
        assert (e.top(s).uploaded == before[s]).all()


def test_active_toggle_restarts_and_restores_from_doc_state_and_tops():
    e = settled_env()
    e.o.par.Active.val = 0
    e.x.OnParChange(e.o.par.Active)
    e.o.par.Active.val = 1
    e.x.OnParChange(e.o.par.Active)
    e.pump()
    assert e.x.doc_layers == DOC and (e.x.surfaces[1] == e.top(1).uploaded).all()
    c = e.connect("external")  # nothing was locked, yet the pixels survive the restart
    assert (e.dump(c, 1)[1] == e.imgs[1]).all() and (e.dump(c, 3)[1] == e.imgs[3]).all()


def test_pending_doc_state_is_flushed_before_a_restart():
    e = Env()
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC, rev=9)  # no pump yet: doc_state not written
    assert e.o.doc_state.text == ""
    e.x.Start()
    assert json.loads(e.o.doc_state.text)["rev"] == 9 and e.x.doc_rev == 9


def test_network_is_ticked_every_pump_and_told_about_the_input(env):
    env.pump(5)
    assert env.o.net.ticks >= 5
    env.set_input(64, 32)
    env.pump()
    assert env.o.net.input_flags[-1] is True


def test_failed_first_apply_is_retried_every_second_until_it_works(capsys):
    e = Env()
    e.pump()
    e.o.net.raise_on_apply = True
    e.x._net_applied = False
    n = len(e.o.net.applies)
    e.pump(40)  # 1.36 s
    assert e.o.switch.par.index.eval() == 0 and capsys.readouterr().out.count("[raster_editor] Pump/network") == 1
    e.o.net.raise_on_apply = False
    e.pump(40)
    assert e.x._net_applied and len(e.o.net.applies) == n + 1 and e.o.switch.par.index.eval() == 1


def test_restore_survives_a_failing_first_apply_and_finishes_on_the_retry():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.pump()
    assert b.o.net.frozen and not b.x._net_applied  # nothing lost: still locked, pixels still in the TOPs
    b.o.net.raise_on_apply = False
    b.pump(40)
    assert b.x._net_applied and not b.o.net.frozen and not b.x.frozen
    for s, im in a.imgs.items():
        assert (b.x.surfaces[s] == a.x.surfaces[s]).all(), s


def test_failed_locked_read_stays_locked_retries_then_recovers():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_read = True
    b.pump()
    assert b.o.net.frozen and b.x._restore_pending and b.o.net.thaws == 0   # nothing unlocked: pixels still in the TOPs
    b.pump(40)
    assert b.o.net.frozen and b.x._restore_fail >= 2
    b.o.net.raise_on_read = False
    b.pump(40)
    assert not b.o.net.frozen and not b.x._restore_pending
    for s_ in a.imgs:
        assert (b.x.surfaces[s_] == a.x.surfaces[s_]).all()


def test_restore_gives_up_after_the_retry_limit_and_thaws():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_read = True
    b.pump(E.RESTORE_TRIES * 40)
    assert not b.o.net.frozen and not b.x._restore_pending


# ----------------------------------------------------------------------------- M1: masks stay white

def white_mask_env():
    e = Env()
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC, rev=1)
    return e, a


def test_mask_grows_white_when_the_document_grows():
    e, a = white_mask_env()
    e.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    e.o.par.Docw.val, e.o.par.Doch.val = 80, 40
    e.pump()
    assert (e.dump(a, 3)[1] == 255).all()          # old area white, new area white too
    p = e.dump(a, 1)[1]
    assert not p[32:].any() and not p[:, 64:].any()   # pixel layers grow transparent


def test_painted_mask_keeps_its_pixels_and_only_the_new_area_is_white():
    e, a = white_mask_env()
    black = np.zeros((32, 64, 4), np.uint8)
    black[..., 3] = 255   # a fully black (hidden) mask
    e.surface(a, 3, (0, 0, 64, 32), black)
    e.o.par.Docw.val, e.o.par.Doch.val = 80, 40
    e.pump()
    m = e.dump(a, 3)[1]
    assert (m[:32, :64] == black).all() and (m[32:] == 255).all() and (m[:, 64:] == 255).all()


def test_restore_into_a_larger_document_fills_masks_white():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a, Docw=80, Doch=40)
    b.pump()
    c = b.connect("external")
    m = b.dump(c, 3)[1]
    assert (m[:32, :64] == a.imgs[3]).all() and (m[32:] == 255).all() and (m[:, 64:] == 255).all()
    assert not b.dump(c, 1)[1][32:].any()


def test_input_resize_keeps_masks_white():
    e, a = white_mask_env()
    e.set_input(100, 50)
    e.pump()
    assert (e.dump(a, 3)[1] == 255).all()


def test_restart_carry_fills_masks_white_on_growth():
    e, a = white_mask_env()
    e.pump()
    e.o.par.Active.val = 0
    e.x.OnParChange(e.o.par.Active)
    e.o.par.Docw.val, e.o.par.Doch.val = 80, 40
    e.o.par.Active.val = 1
    e.x.OnParChange(e.o.par.Active)
    e.pump()
    c = e.connect("external")
    assert (e.dump(c, 3)[1] == 255).all()


# ----------------------------------------------------------------------------- M2: save robustness

def test_freeze_writes_every_slot_with_verification_and_locks():
    e = settled_env()
    e.x.Freeze()
    for s_ in e.imgs:
        t = e.top(s_)
        assert t.lock and t.uploaded.shape == (32, 64, 4) and (t.uploaded == e.x.surfaces[s_]).all()
    assert e.x.frozen


def test_freeze_detects_a_callback_that_did_not_write_and_rolls_back():
    e = settled_env()
    e.top(2).skip_copy = True   # the locked image stays the blank 128x128
    with pytest.raises(RuntimeError, match="128x128"):
        e.x.Freeze()
    assert not e.o.net.frozen and not e.x.frozen   # every lock taken was released again


def test_freeze_rolls_back_when_locking_fails_midway():
    e = settled_env()
    e.top(3).raise_on_lock = True
    with pytest.raises(RuntimeError, match="cannot lock"):
        e.x.Freeze()
    assert not any(t.lock for t in e.o.net.tops.values()) and not e.x.frozen
    e.pump(3)
    for s_ in e.imgs:   # nothing was lost: unlocking recooked from the buffers
        assert (e.top(s_).uploaded == e.x.surfaces[s_]).all()


def test_freeze_with_a_missing_script_top_raises():
    e = settled_env()
    e.o.net.tops.pop(1)
    with pytest.raises(RuntimeError, match="no Script TOP"):
        e.x.Freeze()


def test_savetox_with_failing_freeze_never_saves():
    e = settled_env()
    e.top(2).skip_copy = True
    with pytest.raises(RuntimeError):
        e.x.SaveTox("/tmp/y.tox")
    assert e.o.saved == [] and e.renamed == [] and not e.o.net.frozen


def test_project_save_callbacks_never_raise_and_report(capsys):
    e = settled_env()
    e.top(2).skip_copy = True
    e.x.OnProjectSave(True)   # must not raise into TD's save
    out = capsys.readouterr().out
    assert "WARNING" in out and "project save freeze" in out and not e.o.net.frozen
    e.top(2).skip_copy = False
    e.x.OnProjectSave(True)
    assert e.o.net.frozen
    e.x.OnProjectSave(False)
    assert not e.o.net.frozen and not e.x.frozen


def test_missed_post_save_is_undone_by_the_pump(capsys):
    e = settled_env()
    e.x.Freeze()
    e.pump(3)
    assert e.x.frozen   # a save may be in progress: leave it
    e.pump(1, dt=E.FROZEN_MAX_S + 1)
    assert not e.x.frozen and not e.o.net.frozen
    assert "left frozen" in capsys.readouterr().out
    e.surface(e.a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=77)
    e.pump()
    assert (e.top(1).uploaded == e.x.surfaces[1]).all()   # uploads work again


def test_savetox_in_progress_is_not_thawed_by_the_pump():
    e = settled_env()
    seen = []
    e.o.save = lambda path: (e.pump(1, dt=E.FROZEN_MAX_S + 1), seen.append(e.o.net.frozen))
    e.x.SaveTox("/tmp/z.tox")
    assert seen == [True]


# ----------------------------------------------------------------------------- S1..S4


def test_surface_uploads_are_budgeted_per_pump_but_at_least_one():
    e = Env(tick=0.003)   # every clock read costs 3 ms
    e.pump()
    a = e.connect("panel")
    layers = [L("base", "input", input=1)] + [L(f"p{i}", slot=i + 1) for i in range(6)]
    e.doc(a, layers)
    n = [len(e.top(i + 1).uploads) for i in range(6)]
    e.pump()
    uploaded = sum(len(e.top(i + 1).uploads) - n[i] for i in range(6))
    assert 1 <= uploaded < 6   # budget hit: the rest follows
    e.pump(10)
    assert not e.x._dirty


def test_premultiplied_toggle_reencodes_one_surface_per_pump_and_stays_consistent():
    e = settled_env()
    wire = {s_: e.dump(e.a, s_)[1] for s_ in (1, 2)}
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    assert e.x._stale_enc == {1, 2}   # masks need no re-encode
    e.pump()
    assert len(e.x._stale_enc) == 1   # one per pump
    for s_ in (1, 2):   # the wire view is the same while the toggle is half done
        assert np.abs(e.dump(e.a, s_)[1].astype(int) - wire[s_]).max() <= 2
    e.pump(5)
    assert not e.x._stale_enc
    e.o.par.Premultiplied.val = 1   # flipping back and forth keeps the bookkeeping right
    e.x.OnParChange(e.o.par.Premultiplied)
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    e.pump(5)
    assert not e.x._stale_enc


def test_requests_during_a_pending_restore_are_held_and_replayed():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.pump()   # restore waits for the network
    assert b.x._restore_pending
    c = b.connect("panel")
    assert b.s.messages(c, "hello")[0]["hasDocument"] is True   # truthful, but nothing is served yet
    assert b.get("/surface", client=b.x.clients[c].cid, slot=1)["statusCode"] == 503
    b.send(c, {"t": "requestDoc"})
    assert not b.s.messages(c, "docState")
    tile = wire_img(4, 4, 5, 255)
    b.doc(c, DOC, rev=9)
    b.surface(c, 1, (0, 0, 4, 4), tile, frame_id=3)
    assert b.x.doc_rev == 6   # held, not applied (and not lost)
    b.o.net.raise_on_apply = False
    b.pump(40)
    assert not b.x._restore_pending and b.x.doc_rev == 9
    got = b.dump(c, 1)[1]
    assert (got[:4, :4] == tile).all() and (got[10:20, 10:20] == a.imgs[1][10:20, 10:20]).all()   # tile on top of the restored pixels
    assert b.s.messages(c, "docState")   # the waiting requestDoc was answered after the restore


def test_zero_by_zero_input_keeps_the_current_document_size():
    e = Env()
    e.set_input(64, 32)
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC)
    e.o.in1.width, e.o.in1.height = 0, 0
    e.pump(3)
    assert (e.x.doc_w, e.x.doc_h) == (64, 32) and not e.s.messages(a, "docSize")
    assert e.x.surfaces[1].shape == (32, 64, 4)


def test_restore_converts_slot_by_slot_releasing_each_float_copy():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    seen = []
    orig = b.x.frames.from_float
    b.x.frames.from_float = lambda arr, w, h, white=False: (seen.append(white), orig(arr, w, h, white))[1]
    b.pump()
    assert sorted(seen) == [False, False, True]   # one conversion per slot, the mask flagged white


def test_webrender_transparency_is_never_toggled_it_reloads_the_page(env):
    class Spy:
        def __init__(self):
            self.sets = []

        def __setattr__(self, k, v):
            if k == "transparent":
                object.__getattribute__(self, "sets").append(v)
            object.__setattr__(self, k, v)
    env.o.webrender.par = Spy()
    env.o.webrender.par.active = 1
    env.pump()
    p = env.connect("panel")
    env.send(p, vmsg("td"))
    env.send(p, vmsg("local"))
    assert env.o.webrender.par.sets == []


# ----------------------------------------------------------------------------- re-review fixes

def pending_restore_env():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.pump()
    assert b.x._restore_pending and b.o.net.frozen
    return a, b


def test_freeze_and_thaw_during_a_pending_restore_leave_the_locked_pixels_alone(capsys):
    a, b = pending_restore_env()
    before = {s: b.top(s).uploaded.copy() for s in a.imgs}
    b.x.Freeze()          # e.g. an autosave while the first apply keeps failing
    b.x.Thaw()
    assert b.o.net.frozen   # still locked: they are the only copy
    assert "still being restored" in capsys.readouterr().out
    for s in a.imgs:
        assert (b.top(s).uploaded == before[s]).all()
    b.o.net.raise_on_apply = False
    b.pump(40)
    for s in a.imgs:
        assert (b.x.surfaces[s] == a.x.surfaces[s]).all(), s
    assert not b.o.net.frozen


def test_savetox_is_refused_while_a_restore_is_pending():
    a, b = pending_restore_env()
    with pytest.raises(RuntimeError, match="still being restored"):
        b.x.SaveTox("/tmp/q.tox")
    assert b.o.saved == [] and b.o.net.frozen


def test_project_save_during_a_pending_restore_does_not_unlock():
    a, b = pending_restore_env()
    b.x.OnProjectSave(True)
    b.x.OnProjectSave(False)
    assert b.o.net.frozen


def test_hold_overflow_rejects_the_client_and_makes_it_reload_after_the_restore():
    a, b = pending_restore_env()
    c = b.connect("panel")
    d = b.connect("external")
    b.x._held_bytes = E.HOLD_MAX_BYTES
    b.surface(c, 1, (0, 0, 4, 4), wire_img(4, 4), frame_id=5)   # does not fit
    b.surface(c, 1, (0, 0, 4, 4), wire_img(4, 4), frame_id=6)   # and nothing of it is held afterwards
    assert b.s.messages(c, "error") and len(b.x._held) == 0 and c in b.x._overflowed
    b.s.texts.clear()
    b.o.net.raise_on_apply = False
    b.x._held_bytes = 0
    b.pump(40)
    acts = [m["active"] for m in b.s.messages(c, "active")]
    assert acts == [False, True]   # the page treats active:true as "load TD's document"
    assert not b.s.messages(d, "active") and not b.x._overflowed


def test_held_messages_replay_in_order_budgeted_across_pumps():
    a, b = pending_restore_env()
    b.x._now = TickClock(0.003)   # every clock read costs 3 ms
    c = b.connect("panel")
    for i in range(6):
        b.surface(c, 1, (i * 4, 0, 4, 4), wire_img(4, 4, i, 255), frame_id=10 + i)
    assert len(b.x._held) == 6
    b.o.net.raise_on_apply = False
    b.x._net_retry_at = 0.0
    b.pump(1)
    assert b.x._restore_pending is False and 0 < len(b.x._held) < 6   # replay is spread over pumps
    b.surface(c, 1, (60, 0, 4, 4), wire_img(4, 4, 99, 255), frame_id=50)   # new traffic queues behind the rest
    assert b.get("/surface", client=b.x.clients[c].cid, slot=1)["statusCode"] == 503
    b.pump(20)
    assert not b.x._held and b.get("/surface", client=b.x.clients[c].cid, slot=1)["statusCode"] == 200
    assert b.x.clients[c].fid_pending == 50   # last one applied last


def test_cook_is_round_robin_so_a_busy_slot_cannot_starve_the_others():
    e = Env(tick=0.003)
    e.pump()
    a = e.connect("panel")
    e.doc(a, [L("base", "input", input=1)] + [L(f"p{i}", slot=i + 1) for i in range(4)])
    e.pump(10)
    seen = set()
    for i in range(12):
        for s_ in (1, 2, 3, 4):   # every slot is dirty every pump, the budget fits one upload
            e.x._dirty.add(s_)
        n = {s_: len(e.top(s_).uploads) for s_ in (1, 2, 3, 4)}
        e.pump()
        seen |= {s_ for s_ in n if len(e.top(s_).uploads) > n[s_]}
    assert seen == {1, 2, 3, 4}


def test_a_dirty_slot_without_a_script_top_is_dropped_after_a_while_and_applied_goes_out(capsys):
    e = Env()
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC)
    e.pump()
    e.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8), frame_id=9)
    e.o.net.tops.pop(1)
    e.pump(3)
    assert not e.s.messages(a, "applied") or e.s.messages(a, "applied")[-1]["frameId"] != 9
    e.pump(1, dt=E.MISSING_TOP_S + 1)
    e.pump()
    assert 1 not in e.x._dirty and e.s.messages(a, "applied")[-1]["frameId"] == 9
    assert "has no Script TOP" in capsys.readouterr().out


def test_freeze_reencodes_stale_surfaces_first():
    e = settled_env()
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    assert e.x._stale_enc
    e.x.Freeze()
    assert not e.x._stale_enc
    straight = e.x.surfaces[2]
    assert (e.top(2).uploaded == straight).all()
    assert (e.dump(e.a, 2)[1] == e.imgs[2]).all() or np.abs(e.dump(e.a, 2)[1].astype(int) - e.imgs[2]).max() <= 2


def test_restart_carry_keeps_the_pending_reencode_state():
    e = settled_env()
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    assert e.x._stale_enc == {1, 2}
    e.o.par.Active.val = 0
    e.x.OnParChange(e.o.par.Active)
    e.o.par.Active.val = 1
    e.x.OnParChange(e.o.par.Active)
    e.pump(5)
    c = e.connect("external")
    assert not e.x._stale_enc
    for s_ in (1, 2):
        assert np.abs(e.dump(c, s_)[1].astype(int) - e.imgs[s_]).max() <= 2   # wire content unchanged by the restart
        assert (e.top(s_).uploaded == e.x.surfaces[s_]).all()
    # straight alpha now: the 200-alpha layer is stored un-premultiplied
    assert (e.x.surfaces[2][::-1][..., 3] == 200).all() and np.abs(e.x.surfaces[2][::-1][..., :3].astype(int) - e.imgs[2][..., :3]).max() <= 2


# ----------------------------------------------------------------------------- v4: fonts, TOP import, text/shape docs

from faketd import FakeFontProbe, FakeTop  # noqa: E402


def rgba(r=0, g=0, b=0, a=255):
    return {"r": r, "g": g, "b": b, "a": a}


def TEXT(id, **kw):
    spec = {"text": "Hi", "font": "Arial", "size": 32, "color": rgba(255, 0, 0), "align": "left", "bold": False,
            "italic": False, "lineHeight": 1.2, "x": 10, "y": 20, "boxWidth": None}
    spec.update(kw)
    return L(id, "text", text=spec, shape=None)


def SHAPE(id):
    spec = {"type": "rect", "x": 1, "y": 2, "w": 30, "h": 20, "radius": 4, "rotation": 0,
            "fill": {"enabled": True, "color": rgba(0, 0, 255)}, "stroke": {"enabled": False, "color": rgba(), "width": 2}}
    return L(id, "shape", text=None, shape=spec)


def install_tops(env, *tops):
    env.o.tops = {t.path: t for t in tops}
    env.x._all_tops = lambda: list(env.o.tops.values())
    env.x._lookup_top = lambda path: env.o.tops.get(path)


def get_top(env, cid, rid, token=None, client=True, **extra):
    pars = {"token": token or env.x.token, "requestId": rid}
    if client:
        pars["client"] = env.x.clients[cid].cid
    return env.x.OnHTTPRequest(req(uri="/top", pars=pars, **extra), {})


def tops_img(w, h, seed=3):
    return np.random.RandomState(seed).rand(h, w, 4).astype(np.float32)  # bottom-first float, like a TOP readback


def run_import(env, cid, path, rid="r1", frames=12):
    env.send(cid, {"t": "importTop", "requestId": rid, "path": path})
    env.pump(frames)


def test_fonts_are_sent_after_hello_sorted_deduped_family_names(env):
    env.o._ops["font_probe"] = FakeFontProbe(names=["Zapfino", "Arial Bold", "Arial", "arial bold italic", "Helvetica Neue Light",
                                                    "", "Arial Black", "Courier New Bold"])
    env.pump()
    a = env.connect("external")
    kinds = [m["t"] for c, m in env.s.texts if c == a]
    assert kinds.index("hello") < kinds.index("fonts")
    (f,) = env.s.messages(a, "fonts")
    assert f["families"] == ["Arial", "Arial Black", "Courier New", "Helvetica Neue Light", "Zapfino"]


def test_fonts_prefer_menu_labels_and_are_cached(env):
    probe = FakeFontProbe(names=["x1", "x2"], labels=["Georgia Bold", "Georgia"])
    env.o._ops["font_probe"] = probe
    env.pump()
    a, b = env.connect("external"), env.connect("external")
    assert env.s.messages(a, "fonts")[0]["families"] == ["Georgia"]
    probe.par.font.menuLabels = ["changed"]
    assert env.s.messages(b, "fonts")[0]["families"] == ["Georgia"]  # cached after the first enumeration


def test_fonts_failure_sends_empty_list_and_reports(env, capsys):
    env.o._ops["font_probe"] = object()  # no .par
    env.pump()
    a = env.connect("external")
    assert env.s.messages(a, "fonts")[0]["families"] == []
    assert "fonts:" in capsys.readouterr().out


def test_font_families_helper():
    assert E.font_families(["Arial Bold", "Arial-Italic"]) == ["Arial"]
    assert E.font_families(["Bold"]) == ["Bold"]  # never reduced to nothing
    assert E.font_families(["Menlo Regular", "Menlo Bold Italic", "Menlo"]) == ["Menlo"]
    assert E.font_families([]) == []


def test_list_tops_excludes_raster_editor_and_never_cooks(env):
    env.pump()
    a = env.connect("external")
    inside = FakeTop("/project1/raster_editor/doc/out", 10, 10)
    t1 = FakeTop("/project1/b_ramp", 4096, 2160)
    t2 = FakeTop("/project1/a_const", 64, 32)
    fresh = FakeTop("/project1/never_cooked", 99, 99, cooks=0)
    fresh.par = types.SimpleNamespace()  # a TOP without resolution parameters
    custom = FakeTop("/project1/custom_res", 5, 5, cooks=0)
    ev = lambda v: types.SimpleNamespace(eval=lambda: v)  # noqa: E731
    custom.par = types.SimpleNamespace(outputresolution=ev("custom"), resolutionw=ev(5), resolutionh=ev(5))
    install_tops(env, inside, t1, t2, fresh, custom)
    env.send(a, {"t": "listTops", "requestId": "q1"})
    (m,) = env.s.messages(a, "tops")
    assert m["requestId"] == "q1"
    assert m["items"] == [{"path": "/project1/a_const", "w": 64, "h": 32}, {"path": "/project1/b_ramp", "w": 4096, "h": 2160},
                          {"path": "/project1/custom_res", "w": 5, "h": 5},
                          {"path": "/project1/never_cooked", "w": 0, "h": 0}]
    assert t1.calls == 0 and t2.calls == 0  # nothing was read back


def test_list_tops_is_capped_at_2000(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, *[FakeTop(f"/project1/t{i:05d}", 8, 8) for i in range(2500)])
    env.send(a, {"t": "listTops", "requestId": 1})
    assert len(env.s.messages(a, "tops")[0]["items"]) == 2000


def test_list_tops_bad_request_id_is_an_error_not_a_crash(env):
    env.pump()
    a = env.connect("external")
    install_tops(env)
    env.send(a, {"t": "listTops"})
    assert env.s.messages(a, "topError") and not env.s.messages(a, "tops")


def test_import_top_converts_to_straight_top_first_rgba_and_serves_it(env):
    env.pump()
    a = env.connect("external")
    arr = tops_img(6, 4)
    arr[..., :3] *= arr[..., 3:4]  # premultiplied, as TD hands it over
    install_tops(env, FakeTop("/project1/img", 6, 4, array=arr))
    run_import(env, a, "/project1/img", "r1")
    (ready,) = env.s.messages(a, "topReady")
    assert ready == {"t": "topReady", "requestId": "r1", "w": 6, "h": 4}
    r = get_top(env, a, "r1")
    assert r["statusCode"] == 200 and r["content-type"] == "application/octet-stream" and r["Cache-Control"] == "no-store"
    h, payload = P.decode_frame(r["data"])
    assert (h.type, h.slot, h.doc_w, h.doc_h, h.x, h.y, h.w, h.h, h.frame_end) == (6, 0, 6, 4, 0, 0, 6, 4, True)
    got = np.frombuffer(payload, np.uint8).reshape(4, 6, 4)
    want = frames.WireConverter().to_wire(arr, True)  # reference conversion
    assert (got == want).all()
    assert (got[0] == want[0]).all()
    # wire row 0 is the TOP's TOP row = last row of the bottom-first array
    assert np.abs(got[0, :, 3].astype(int) - np.round(arr[3, :, 3] * 255)).max() <= 1


def test_import_top_premultiplied_off_keeps_straight_values():
    e = Env(Premultiplied=0)
    e.pump()
    a = e.connect("external")
    arr = tops_img(5, 3, 9)
    install_tops(e, FakeTop("/project1/img", 5, 3, array=arr))
    run_import(e, a, "/project1/img")
    h, payload = P.decode_frame(get_top(e, a, "r1")["data"])
    got = np.frombuffer(payload, np.uint8).reshape(3, 5, 4)
    assert np.abs(got[0].astype(int) - np.round(arr[2] * 255)).max() <= 1


def test_import_top_is_delayed_never_blocking_and_ignores_the_first_result(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/img", 6, 4, array=tops_img(6, 4))
    top._requested = np.zeros((4, 6, 4), np.float32)  # a stale result left by someone else's earlier read
    install_tops(env, top)
    env.send(a, {"t": "importTop", "requestId": "r1", "path": "/project1/img"})
    env.pump(1)
    assert top.calls == 1 and not env.s.messages(a, "topReady")  # first call only issues the read
    env.pump(1)
    assert env.s.messages(a, "topReady")
    h, payload = P.decode_frame(get_top(env, a, "r1")["data"])
    assert np.frombuffer(payload, np.uint8).any()  # the real image, not the stale zeros


def test_import_top_waits_for_a_late_readback(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/img", 6, 4, array=tops_img(6, 4))
    calls = []
    real = top.numpyArray

    def slow(delayed=False):
        calls.append(1)
        out = real(delayed)
        return out if len(calls) >= 5 else None  # the GPU read takes a few frames
    top.numpyArray = slow
    install_tops(env, top)
    run_import(env, a, "/project1/img", frames=3)
    assert not env.s.messages(a, "topReady")
    env.pump(6)
    assert env.s.messages(a, "topReady")


def test_import_top_readback_timeout(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/img", 6, 4, array=tops_img(6, 4))
    top.numpyArray = lambda delayed=False: None
    install_tops(env, top)
    env.send(a, {"t": "importTop", "requestId": "r1", "path": "/project1/img"})
    env.pump(2)
    env.clock.advance(E.TOP_READ_TIMEOUT_S + 1)
    env.pump(2)
    (err,) = env.s.messages(a, "topError")
    assert err["requestId"] == "r1" and "timed out" in err["msg"]
    assert env.x._imp is None


def test_import_top_conversion_is_budgeted_over_several_pumps():
    e = Env(tick=0.002, Docw=400, Doch=1200)  # every clock read costs 2 ms against a 4 ms budget
    e.pump()
    a = e.connect("external")
    install_tops(e, FakeTop("/project1/big", 200, 600, array=tops_img(200, 600)))
    e.send(a, {"t": "importTop", "requestId": "r1", "path": "/project1/big"})
    e.pump(2)
    assert e.x._imp is not None and e.x._imp["stage"] == "convert" and 0 < e.x._imp["row"] < 600
    e.pump(40)
    assert e.s.messages(a, "topReady")
    h, payload = P.decode_frame(get_top(e, a, "r1")["data"])
    assert (h.w, h.h) == (200, 600)


@pytest.mark.parametrize("path,why", [("/project1/nothing", "not a TOP"), ("/project1/raster_editor/doc/out", "raster editor")])
def test_import_top_invalid_paths(env, path, why):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, path, "rX", frames=2)
    (err,) = env.s.messages(a, "topError")
    assert err["requestId"] == "rX" and why in err["msg"]


def test_import_top_bad_message_is_an_error(env):
    env.pump()
    a = env.connect("external")
    install_tops(env)
    for bad in ({"t": "importTop", "requestId": "r", "path": "relative"}, {"t": "importTop", "path": "/x"},
                {"t": "importTop", "requestId": "r", "path": 5}):
        env.send(a, bad)
    assert len(env.s.messages(a, "error")) == 3


def test_import_top_too_large_and_empty(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/huge", 8193, 100), FakeTop("/project1/empty", 0, 0), FakeTop("/project1/max", 8192, 8192, array=None))
    run_import(env, a, "/project1/huge", "r1", frames=2)
    run_import(env, a, "/project1/empty", "r2", frames=2)
    errs = {m["requestId"]: m["msg"] for m in env.s.messages(a, "topError")}
    assert "too large" in errs["r1"] and "8192" in errs["r1"] and "no image" in errs["r2"]
    assert env.x._imp is None and not env.s.messages(a, "topReady")


def test_import_top_exact_limit_8192_is_accepted_and_scaled_down_on_the_gpu(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/max", 8192, 8192, array=None)
    install_tops(env, top)
    made = []
    small = FakeTop("/scaled", 128, 64, array=tops_img(128, 64))  # doc is 64x32 -> at most 128x64

    class Temp:
        destroyed = 0

        def destroy(self):
            Temp.destroyed += 1
    env.x._make_scaler = lambda t, tw, th, tag: (made.append((t, tw, th)) or (small, [Temp(), Temp()]))
    run_import(env, a, "/project1/max", "r1", frames=12)
    assert not env.s.messages(a, "topError")
    assert made and made[0][0] is top and made[0][1:] == (64, 64)  # aspect kept, 2 x doc height limits it
    assert top.calls == 0  # the huge TOP itself is never read back
    assert Temp.destroyed == 0  # still needed while reading
    small.array = tops_img(64, 64)
    small.width = small.height = 64
    env.pump(10)
    (ready,) = env.s.messages(a, "topReady")
    assert (ready["w"], ready["h"]) == (64, 64)
    assert Temp.destroyed == 2  # temporary operators are destroyed again
    h, _ = P.decode_frame(get_top(env, a, "r1")["data"])
    assert (h.w, h.h, h.doc_w, h.doc_h) == (64, 64, 64, 64)


def test_import_target_size_limits():
    f = P.import_target_size
    assert f(100, 50, 1920, 1080) == (100, 50)  # never enlarged
    assert f(8192, 8192, 1920, 1080) == (2160, 2160)  # 2 x doc height
    assert f(4096, 2160, 1920, 1080) == (3840, 2025) or f(4096, 2160, 1920, 1080)[0] <= 3840
    w, h = f(8192, 8192, 8192, 8192)
    assert w * h <= P.MAX_TOP_PIXELS and abs(w - h) <= 1
    w, h = f(8192, 100, 1000, 1000)
    assert w == 2000 and h >= 1


def test_import_top_readback_exception_becomes_top_error(env, capsys):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/img", 6, 4, array=tops_img(6, 4))

    def boom(delayed=False):
        raise RuntimeError("gpu gone")
    top.numpyArray = boom
    install_tops(env, top)
    run_import(env, a, "/project1/img", frames=3)
    (err,) = env.s.messages(a, "topError")
    assert "readback failed" in err["msg"] and "gpu gone" in err["msg"]
    assert env.x._imp is None


def test_resized_top_restarts_the_read(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/img", 6, 4, array=np.zeros((2, 3, 4), np.float32))  # stale-shaped result
    install_tops(env, top)
    env.send(a, {"t": "importTop", "requestId": "r1", "path": "/project1/img"})
    env.pump(4)
    assert not env.s.messages(a, "topReady")
    top.array = tops_img(6, 4)
    env.pump(6)
    assert env.s.messages(a, "topReady")


def test_top_expires_after_30_seconds_and_is_404(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/img")
    env.clock.advance(20)
    assert get_top(env, a, "r1")["statusCode"] == 200  # served: now kept only 5 s more
    env.clock.advance(4)
    assert get_top(env, a, "r1")["statusCode"] == 200  # a retry still works
    env.clock.advance(E.TOP_SERVED_TTL_S + 1)
    assert get_top(env, a, "r1")["statusCode"] == 404
    assert env.x._tops_bytes == 0 and not env.x._tops_held


def test_unserved_import_expires_after_30_seconds(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/img")
    env.clock.advance(31)
    assert get_top(env, a, "r1")["statusCode"] == 404 and env.x._tops_bytes == 0


def test_pump_frees_expired_tops(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/img")
    assert env.x._tops_bytes > 0
    env.clock.advance(31)
    env.pump()
    assert env.x._tops_bytes == 0 and not env.x._tops_held


def test_get_top_auth_cors_and_unknown(env):
    env.pump()
    a = env.connect("external")
    b = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/img")
    assert get_top(env, a, "r1", token="bad")["statusCode"] == 403
    assert get_top(env, a, "nope")["statusCode"] == 404
    assert get_top(env, a, "r1", client=False)["statusCode"] == 404
    assert get_top(env, b, "r1")["statusCode"] == 404  # another client's id does not see it
    r = get_top(env, a, "r1", Origin="http://localhost:5173")
    assert r["Access-Control-Allow-Origin"] == "http://localhost:5173" and r["Vary"] == "Origin"
    assert "Access-Control-Allow-Origin" not in get_top(env, a, "r1", Origin="http://evil.example")
    assert get_top(env, a, "r1", Host="evil.example:9980")["statusCode"] == 403
    assert get_top(env, a, "r1", clientAddress="10.0.0.2:5000")["statusCode"] == 403
    assert env.x.OnHTTPRequest(req(method="POST", uri="/top", pars={"token": env.x.token}), {})["statusCode"] == 404


def test_request_id_may_be_a_number(env):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/img", 7)
    assert env.s.messages(a, "topReady")[0]["requestId"] == 7
    assert get_top(env, a, 7)["statusCode"] == 200


def test_newest_import_per_client_wins_and_queue_is_bounded(env):
    env.pump()
    a, b, c = env.connect("external"), env.connect("external"), env.connect("external")
    install_tops(env, *[FakeTop(f"/project1/t{i}", 6, 4, array=tops_img(6, 4, i)) for i in range(5)])
    # a starts, b and c queue, a newer one from b replaces its queued one
    env.send(a, {"t": "importTop", "requestId": "a1", "path": "/project1/t0"})
    env.pump(1)
    env.send(b, {"t": "importTop", "requestId": "b1", "path": "/project1/t1"})
    env.send(b, {"t": "importTop", "requestId": "b2", "path": "/project1/t2"})
    assert [j["rid"] for j in env.x._imp_queue] == ["b2"]
    assert env.s.messages(b, "topError")[0]["requestId"] == "b1"
    env.send(c, {"t": "importTop", "requestId": "c1", "path": "/project1/t3"})
    env.send(a, {"t": "importTop", "requestId": "a2", "path": "/project1/t4"})  # cancels the running a1; room is checked after
    errs_a = [(m["requestId"], m["msg"]) for m in env.s.messages(a, "topError")]
    assert [r for r, _ in errs_a] == ["a1"] and "superseded" in errs_a[0][1]  # a2 is NOT rejected as busy
    assert len(env.x._imp_queue) <= E.TOP_QUEUE_MAX + 1
    env.pump(60)
    got = {m["requestId"] for cid in (a, b, c) for m in env.s.messages(cid, "topReady")}
    assert "a1" not in got and {"b2", "c1", "a2"} <= got


def test_import_when_queue_is_full_is_rejected_busy(env):
    env.pump()
    cs = [env.connect("external") for _ in range(5)]
    install_tops(env, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
    for i, cid in enumerate(cs):
        env.send(cid, {"t": "importTop", "requestId": f"r{i}", "path": "/project1/t"})
        if i == 0:
            env.pump(1)  # the first becomes the running one
    busy = [m for cid in cs for m in env.s.messages(cid, "topError") if "busy" in m["msg"]]
    assert len(busy) == 2 and len(env.x._imp_queue) == E.TOP_QUEUE_MAX


def test_held_tops_per_client_and_total_are_bounded(env, monkeypatch):
    env.pump()
    a = env.connect("external")
    install_tops(env, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
    for i in range(4):
        run_import(env, a, "/project1/t", f"r{i}", frames=6)
    assert len(env.x._tops_held) == E.TOP_HELD_PER_CLIENT
    assert get_top(env, a, "r0")["statusCode"] == 404 and get_top(env, a, "r3")["statusCode"] == 200
    one = len(next(iter(env.x._tops_held.values()))["msg"])
    monkeypatch.setattr(E, "TOP_HELD_MAX_BYTES", one + 1)
    run_import(env, a, "/project1/t", "r9", frames=6)
    assert list(k[1] for k in env.x._tops_held) == ["r9"] and env.x._tops_bytes == one


def test_disconnect_drops_the_clients_imports_and_held_images(env):
    env.pump()
    a, b = env.connect("external"), env.connect("external")
    install_tops(env, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/t", "r1", frames=6)
    env.send(a, {"t": "importTop", "requestId": "r2", "path": "/project1/t"})
    env.send(b, {"t": "importTop", "requestId": "rb", "path": "/project1/t"})
    env.x.OnWebSocketClose(a)
    assert env.x._tops_bytes == 0 and all(j["client"] != a for j in env.x._imp_queue + [env.x._imp or {"client": None}])
    env.pump(30)
    assert env.s.messages(b, "topReady") and not env.s.messages(a, "topReady")[1:]


def test_import_does_not_touch_documents_or_other_streams(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, DOC)
    env.pump()
    before = {k: v.copy() for k, v in env.x.surfaces.items()}
    install_tops(env, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
    run_import(env, a, "/project1/t", "r1", frames=6)
    assert all((env.x.surfaces[k] == v).all() for k, v in before.items())
    assert env.x.doc_layers == DOC


def test_text_and_shape_layers_are_accepted_and_applied(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("base", "input", input=1), TEXT("t1"), SHAPE("s1"), TEXT("t2", sx=2.0, sy=2.0), SHAPE("s2")]
    env.doc(a, layers)
    assert env.x.doc_layers == layers and not env.s.messages(a, "error")
    assert not env.x.surfaces and env.o.net.applies[-1][0] == layers   # text / shape layers never own a surface


def test_text_or_shape_layer_with_a_slot_is_rejected(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, [L("base", "input", input=1), L("t1", "text", slot=3, text=TEXT("x")["text"], shape=None)])
    env.doc(a, [L("base", "input", input=1), L("s1", "shape", slot=4, text=None, shape=SHAPE("x")["shape"])])
    assert len(env.s.messages(a, "error")) == 2 and env.x.doc_layers is None


def test_stored_text_document_survives_a_restart(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("base", "input", input=1), TEXT("t1"), SHAPE("s1")]
    env.doc(a, layers, rev=5)
    env.pump(2)
    e2 = Env(like=env)
    e2.pump(3)
    assert e2.x.doc_layers == layers and e2.x.doc_rev == 5


def test_active_off_stop_and_port_change_release_every_import_and_held_image():
    for how in ("off", "stop", "port"):
        e = Env()
        e.x.BecomeMaster()
        e.pump()
        a, b = e.connect("external"), e.connect("external")
        install_tops(e, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
        run_import(e, a, "/project1/t", "r1", frames=6)
        e.send(b, {"t": "importTop", "requestId": "rb", "path": "/project1/t"})
        e.send(a, {"t": "importTop", "requestId": "r2", "path": "/project1/t"})
        assert e.x._tops_bytes > 0
        if how == "off":
            e.o.par.Active.val = 0
            e.x.OnParChange(e.o.par.Active)
        elif how == "stop":
            e.x.Stop()
        else:
            e.o.par.Port.val = 9981
            e.x.OnParChange(e.o.par.Port)
        assert e.x._tops_bytes == 0 and not e.x._tops_held and e.x._imp is None and not e.x._imp_queue, how


def test_import_job_temporaries_are_destroyed_on_cancel_and_disconnect(env):
    env.pump()
    a = env.connect("external")
    top = FakeTop("/project1/max", 8192, 8192)
    install_tops(env, top)
    destroyed = []

    class Temp:
        def destroy(self):
            destroyed.append(1)
    small = FakeTop("/s", 64, 64, array=None)
    env.x._make_scaler = lambda t, tw, th, tag: (small, [Temp()])
    env.send(a, {"t": "importTop", "requestId": "r1", "path": "/project1/max"})
    env.pump(3)
    assert env.x._imp is not None and env.x._imp["temps"]
    env.send(a, {"t": "importTop", "requestId": "r2", "path": "/project1/max"})  # cancels r1
    assert destroyed == [1]
    env.pump(3)
    env.x.OnWebSocketClose(a)
    assert destroyed == [1, 1] and env.x._imp is None


def test_import_resolving_into_the_component_is_refused(env):
    env.pump()
    a = env.connect("external")
    inner = FakeTop("/project1/raster_editor/doc/out", 6, 4, array=tops_img(6, 4))
    env.x._all_tops = lambda: [inner]
    env.x._lookup_top = lambda path: inner  # e.g. a wildcard / `..` path that resolves inside
    run_import(env, a, "/project1/*/out", "r1", frames=3)
    (err,) = env.s.messages(a, "topError")
    assert "raster editor" in err["msg"] and inner.calls == 0


def test_import_of_a_known_huge_top_is_refused_without_reading_it(env):
    env.pump()
    a = env.connect("external")
    big = FakeTop("/project1/wide", 9000, 10, cooks=0)
    big.par = types.SimpleNamespace(outputresolution=types.SimpleNamespace(eval=lambda: "custom"),
                                    resolutionw=types.SimpleNamespace(eval=lambda: 9000),
                                    resolutionh=types.SimpleNamespace(eval=lambda: 10))
    install_tops(env, big)
    run_import(env, a, "/project1/wide", "r1", frames=1)
    assert "too large" in env.s.messages(a, "topError")[0]["msg"] and big.size_reads == 0 and big.calls == 0


def test_list_tops_does_not_read_sizes_of_custom_or_unchanged_tops(env):
    env.pump()
    a = env.connect("external")
    ev = lambda v: types.SimpleNamespace(eval=lambda: v)  # noqa: E731
    custom = FakeTop("/project1/c", 7, 7)
    custom.par = types.SimpleNamespace(outputresolution=ev("custom"), resolutionw=ev(7), resolutionh=ev(7))
    plain = FakeTop("/project1/p", 9, 9)
    install_tops(env, custom, plain)
    env.send(a, {"t": "listTops", "requestId": 1})
    assert custom.size_reads == 0 and plain.size_reads == 2  # read once
    env.send(a, {"t": "listTops", "requestId": 2})
    assert plain.size_reads == 2  # cached for the same cook count
    plain.totalCooks += 1
    env.send(a, {"t": "listTops", "requestId": 3})
    assert plain.size_reads == 4


def test_font_failure_is_retried_with_backoff(env, capsys):
    env.o._ops["font_probe"] = object()
    env.pump()
    a = env.connect("external")
    assert env.s.messages(a, "fonts")[0]["families"] == []
    b = env.connect("external")
    assert env.s.messages(b, "fonts")[0]["families"] == []
    assert capsys.readouterr().out.count("fonts:") == 1  # not retried at once
    env.o._ops["font_probe"] = FakeFontProbe()
    env.clock.advance(E.FONT_RETRY_S + 1)
    c = env.connect("external")
    assert "Arial" in env.s.messages(c, "fonts")[0]["families"]


def test_font_families_strip_only_known_trailing_style_tokens():
    assert E.font_families(["Arial-Bold", "Arial Bold Italic", "Arial"]) == ["Arial"]
    assert E.font_families(["Bebas Neue", "Hind-Madurai", "Source Code Pro", "Roboto Mono Regular"]) == [
        "Bebas Neue", "Hind-Madurai", "Roboto Mono", "Source Code Pro"]


def test_orphaned_import_temporaries_are_swept_on_start_and_drop(env):
    class Kid:
        def __init__(self, name):
            self.name, self.gone = name, False

        def destroy(self):
            self.gone = True
    kids = [Kid("_imp_sel1a2b"), Kid("_imp_res1a2b"), Kid("in1"), Kid("doc")]
    env.o.children = kids
    env.x.Start()
    assert [k.gone for k in kids] == [True, True, False, False]
    again = [Kid("_imp_res9"), Kid("keep")]
    env.o.children = again
    env.x._drop_all_tops()
    assert [k.gone for k in again] == [True, False]


# ----------------------------------------------------------------------------- v5: canvas (DESIGN_V4 section 1)

def test_set_canvas_fixed_updates_the_parameters_and_tells_the_others(env):
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    env.send(a, {"t": "setCanvas", "w": 300, "h": 200, "mode": "fixed"})
    assert (env.o.par.Docw.val, env.o.par.Doch.val, env.o.par.Docsizemode.val) == (300, 200, "fixed")
    assert (env.x.doc_w, env.x.doc_h) == (300, 200)
    assert env.s.messages(b, "docSize")[-1] == {"t": "docSize", "w": 300, "h": 200, "hasInput": False, "mode": "fixed"}
    assert not env.s.messages(a, "docSize")  # exactly what the sender asked for: no echo
    assert env.o.net.applies[-1][1:] == (300, 200)
    env.pump()
    assert json.loads(env.o.doc_state.text if env.o.doc_state.text else "{}") == {}  # no document yet: nothing stored


def test_set_canvas_does_not_resample_or_reallocate_surfaces(env):
    env.pump()
    a = env.connect("panel")
    env.doc(a, [L("base", "input", input=1), L("p1", slot=1, surfaceW=40, surfaceH=20)])
    img = wire_img(40, 20, 3, 255)
    env.surface(a, 1, (0, 0, 40, 20), img, dw=40, dh=20)
    env.pump()
    uploads = len(env.top(1).uploads)
    env.send(a, {"t": "setCanvas", "w": 500, "h": 400, "mode": "fixed"})
    env.pump()
    assert env.x.surfaces[1].shape == (20, 40, 4) and (env.dump(a, 1)[1] == img).all()
    assert len(env.top(1).uploads) == uploads


def test_set_canvas_input_mode_follows_the_input_and_tells_the_sender_the_size(env):
    env.set_input(80, 40)
    env.o.par.Docsizemode.val = "fixed"
    env.o.par.Docw.val, env.o.par.Doch.val = 300, 200
    env.pump()
    a = env.connect("panel")
    assert (env.x.doc_w, env.x.doc_h) == (300, 200)
    env.send(a, {"t": "setCanvas", "w": 1, "h": 1, "mode": "input"})
    assert env.o.par.Docsizemode.val == "input" and (env.x.doc_w, env.x.doc_h) == (80, 40)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 80, "h": 40, "hasInput": True, "mode": "input"}
    env.send(a, {"t": "setCanvas", "w": 90, "h": 70, "mode": "fixed"})
    assert (env.x.doc_w, env.x.doc_h, env.x._mode()) == (90, 70, "fixed")
    # the input keeps its own resolution while Fixed
    assert (env.x.in_w, env.x.in_h) == (80, 40)


def test_set_canvas_only_from_the_active_client_and_validated(env):
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    env.send(b, {"t": "setCanvas", "w": 300, "h": 200, "mode": "fixed"})
    assert env.x.doc_w == 64 and env.o.par.Docsizemode.val == "input"
    for bad in ({"w": 0, "h": 5, "mode": "fixed"}, {"w": 5, "h": 20000, "mode": "fixed"}, {"mode": "nope"}, {"w": "x", "h": 1, "mode": "fixed"}):
        env.send(a, {"t": "setCanvas", **bad})
    assert len(env.s.messages(a, "error")) == 4 and env.x.doc_w == 64


def test_set_canvas_clamped_by_the_host_is_sent_back_to_the_sender(env):
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    real_sync = env.x._sync_doc_size

    def clamped():  # a host whose Docw parameter clamps to 16: the actual size differs from the request
        env.o.par.Docw.val = min(int(env.o.par.Docw.val), 16)
        real_sync()
    env.x._sync_doc_size = clamped
    env.send(a, {"t": "setCanvas", "w": 100, "h": 50, "mode": "fixed"})
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 16, "h": 50, "hasInput": False, "mode": "fixed"}
    assert env.s.messages(b, "docSize")[-1]["w"] == 16


def test_follow_input_doc_size_tracks_the_input_and_disconnect_uses_the_parameters(env):
    env.set_input(80, 40)
    env.pump()
    a = env.connect("panel")
    assert (env.x.doc_w, env.x.doc_h) == (80, 40) and env.s.messages(a, "hello")[0]["inputs"][0] == IN(1, 80, 40)
    env.set_input(33, 22)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (33, 22) and env.s.messages(a, "docSize")[-1]["mode"] == "input"
    env.o.inputs = []
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.in_w) == (64, 32, 0)


def test_fixed_mode_ignores_the_input_size_and_uses_docw_doch(env):
    env.o.par.Docsizemode.val = "fixed"
    env.o.par.Docw.val, env.o.par.Doch.val = 120, 50
    env.set_input(80, 40)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.in_w, env.x.in_h) == (120, 50, 80, 40)
    a = env.connect("panel")
    h = env.s.messages(a, "hello")[0]
    assert h["doc"] == {"w": 120, "h": 50, "mode": "fixed"} and h["inputs"][0] == IN(1, 80, 40) and h["hasInput"] is True
    env.o.inputs = []
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (120, 50)
    assert env.s.messages(a, "inputs")[-1]["items"][0] == IN(1)
    assert env.s.messages(a, "docSize")[-1]["hasInput"] is False


def test_parameter_flip_to_fixed_keeps_the_current_size(env):
    env.set_input(80, 40)
    env.pump()
    a = env.connect("panel")
    env.o.par.Docsizemode.val = "fixed"
    env.x.OnParChange(env.o.par.Docsizemode)
    assert (env.x.doc_w, env.x.doc_h) == (80, 40) and (env.o.par.Docw.val, env.o.par.Doch.val) == (80, 40)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 80, "h": 40, "hasInput": True, "mode": "fixed"}
    env.o.par.Docw.val = 200  # the user edits the size: pushed as docSize with the mode
    env.x.OnParChange(env.o.par.Docw)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 200, "h": 40, "hasInput": True, "mode": "fixed"}
    env.o.par.Docsizemode.val = "input"
    env.x.OnParChange(env.o.par.Docsizemode)
    assert (env.x.doc_w, env.x.doc_h) == (80, 40) and env.s.messages(a, "docSize")[-1]["mode"] == "input"


def test_default_base_layer_is_fitted_in_fixed_mode_and_identity_when_following(env):
    env.set_input(80, 40)
    env.pump()
    (base,) = env.o.net.applies[-1][0]
    assert (base["sx"], base["sy"], base["x"], base["y"], base["surfaceW"], base["surfaceH"]) == (1, 1, 0, 0, 80, 40)
    assert "rasterize" not in base
    env.o.par.Docsizemode.val = "fixed"
    env.o.par.Docw.val, env.o.par.Doch.val = 160, 160
    env.pump()
    (base,) = env.o.net.applies[-1][0]
    assert (base["sx"], base["sy"], base["x"], base["y"]) == (2, 2, 0, 40)  # contain + centred


def test_guides_and_canvas_mode_are_stored_and_restored(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "setCanvas", "w": 300, "h": 200, "mode": "fixed"})
    env.send(a, {"t": "doc", "rev": 4, "layers": DOC, "guides": {"h": [10, 20.5], "v": [5]}, "canvas": {"mode": "fixed"}})
    env.pump()
    stored = json.loads(env.o.doc_state.text)
    assert stored["guides"] == {"h": [10.0, 20.5], "v": [5.0]} and stored["canvas"] == {"mode": "fixed"}
    b = env.connect("external", fresh=True)
    env.send(b, {"t": "requestDoc"})
    st = env.s.messages(b, "docState")[-1]
    assert st["guides"] == {"h": [10.0, 20.5], "v": [5.0]} and st["canvas"] == {"mode": "fixed"} and (st["docW"], st["docH"]) == (300, 200)
    # a restart: the stored guides come back, and the stored mode wins over a stale parameter
    e2 = Env(like=env)
    e2.o.par.Docsizemode.val = "input"
    e2.pump(3)
    assert e2.x.guides == {"h": [10.0, 20.5], "v": [5.0]} and e2.x._mode() == "fixed"
    assert e2.o.par.Docsizemode.val == "fixed"


def test_canvas_in_a_doc_message_does_not_override_the_parameter(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "doc", "rev": 1, "layers": DOC, "canvas": {"mode": "fixed"}})
    env.pump()
    assert json.loads(env.o.doc_state.text)["canvas"] == {"mode": "input"}  # setCanvas / the parameter are authoritative


def test_a_v4_stored_document_is_migrated(env):
    old = {"rev": 2, "layers": [L("base", "input", input=1), dict(L("t", "text", slot=3, text=TEXT("x")["text"], shape=None), rasterize=True)]}
    env.o.doc_state.text = json.dumps(old)
    env.x.Start()
    env.pump(2)
    assert env.x.doc_layers[1]["slot"] is None and "rasterize" not in env.x.doc_layers[1]
    assert env.x.guides == {"h": [], "v": []}


def test_bad_guides_in_a_doc_are_rejected(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "doc", "rev": 1, "layers": DOC, "guides": {"h": ["x"]}})
    assert env.s.messages(a, "error") and env.x.doc_layers is None


# ----------------------------------------------------------------------------- v5: export (DESIGN_V4 section 1)

def test_exportdoc_writes_to_exportpath_via_temp_and_rename_and_reports(tmp_path):
    e = settled_env()
    e.x._open_url = e.opened.append
    target = tmp_path / "doc.tox"
    e.o.par.Exportpath.val = str(target)
    e.x.OnParChange(e.o.par.Exportdoc)
    ((path, frozen, state),) = e.o.saved
    assert path == str(tmp_path / "doc.part.tox") and frozen is True and json.loads(state)["rev"] == 6
    assert e.renamed == [(path, str(target))]
    assert not e.o.net.frozen and not e.x.frozen
    e.pump()
    assert f"exported with document to {target}" in e.x.GetStatus() and "ERROR" not in e.x.GetStatus()


def test_exportdoc_appends_tox_and_defaults_an_empty_path(env, tmp_path):
    env.pump()
    env.o.par.Exportpath.val = str(tmp_path / "noext")
    assert env.x.ExportDoc() == str(tmp_path / "noext.tox")
    env.o.par.Exportpath.val = ""
    assert env.x.ExportDoc() == "raster_editor_export.tox"
    env.pump()
    assert "Export Path was empty" in env.x.GetStatus()


def test_exportdoc_reports_a_missing_folder_and_save_failures_and_still_thaws(tmp_path):
    e = settled_env()
    e.o.par.Exportpath.val = str(tmp_path / "nope" / "x.tox")
    assert e.x.ExportDoc() is None and not e.o.saved
    e.pump()
    assert "export failed" in e.x.GetStatus() and "does not exist" in e.x.GetStatus()
    e.o.par.Exportpath.val = str(tmp_path / "ok.tox")
    e.o.save = lambda p: (_ for _ in ()).throw(OSError("disk full"))
    assert e.x.ExportDoc() is None
    assert not e.o.net.frozen and not e.x.frozen and not e.renamed
    e.pump()
    assert "disk full" in e.x.GetStatus()
    e.o.save = lambda p: e.o.saved.append((p, e.o.net.frozen, ""))
    assert e.x.ExportDoc() == str(tmp_path / "ok.tox")
    e.pump()
    assert "ERROR" not in e.x.GetStatus() and "exported" in e.x.GetStatus()  # the old error is cleared


def test_exportdoc_status_message_expires(tmp_path):
    e = settled_env()
    e.o.par.Exportpath.val = str(tmp_path / "x.tox")
    e.x.ExportDoc()
    e.pump()
    assert "exported" in e.x.GetStatus()
    e.pump(2, dt=E.EXPORT_FLASH_S)
    assert "exported" not in e.x.GetStatus()


def test_exportdoc_refused_while_a_restore_is_pending(tmp_path):
    a = settled_env()
    a.pump(3)
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.x.Start()
    assert b.x._restore_pending
    b.o.par.Exportpath.val = str(tmp_path / "x.tox")
    assert b.x.ExportDoc() is None and not b.o.saved
    b.pump()
    assert "still being restored" in b.x.GetStatus()


def test_savetox_parameter_is_gone():
    import inspect
    assert "Savetox" not in inspect.getsource(E)


# ----------------------------------------------------------------------------- v5: Flatten (renderLayer)

def flatten_env(**kw):
    e = Env(**kw)
    e.pump()
    a = e.connect("panel")
    e.doc(a, [L("base", "input", input=1), TEXT("t1"), SHAPE("s1"), L("p1", slot=1)])
    return e, a


def render_ready(e, a, layer="t1", rid="f1", frames=10):
    e.send(a, {"t": "renderLayer", "requestId": rid, "layerId": layer})
    e.pump(frames)


def test_render_layer_serves_the_layer_at_document_size_as_a_top_image():
    e, a = flatten_env()
    arr = tops_img(64, 32, 5)
    arr[..., :3] *= arr[..., 3:4]
    e.o.net.render_sources["t1"] = FakeTop("/project1/raster_editor/doc/t1_render", 64, 32, array=arr)
    install_tops(e)
    render_ready(e, a)
    assert set(e.o.net.render_calls) == {"t1"} and len(e.o.net.render_calls) >= 2  # re-resolved every pump
    (ready,) = e.s.messages(a, "topReady")
    assert ready == {"t": "topReady", "requestId": "f1", "w": 64, "h": 32} and not e.s.messages(a, "topError")
    r = get_top(e, a, "f1")
    h, payload = P.decode_frame(r["data"])
    assert (h.type, h.doc_w, h.doc_h, h.w, h.h, h.frame_end) == (6, 64, 32, 64, 32, True)
    got = np.frombuffer(payload, np.uint8).reshape(32, 64, 4)
    assert (got == frames.WireConverter().to_wire(arr, True)).all()  # premultiplied -> straight, top row first


def test_render_layer_errors():
    e, a = flatten_env()
    e.o.net.render_sources["s1"] = FakeTop("/project1/raster_editor/doc/s1_render", 64, 32, array=tops_img(64, 32))
    install_tops(e)
    cases = [("p1", "cannot render"), ("nope", "not a layer of"), ("t1", "cannot render")]  # p1 / t1: the network has no source
    for i, (layer, text) in enumerate(cases):
        render_ready(e, a, layer, f"e{i}", frames=6)
        errs = [m for m in e.s.messages(a, "topError") if m["requestId"] == f"e{i}"]
        assert len(errs) == 1 and text in errs[0]["msg"], (layer, errs)
    e.send(a, {"t": "renderLayer", "requestId": "bad"})
    assert e.s.messages(a, "error")
    b = e.connect("external")
    e.send(b, {"t": "renderLayer", "requestId": "sb", "layerId": "s1"})
    assert "active editor" in e.s.messages(b, "topError")[0]["msg"]


def test_render_layer_refused_for_a_huge_document_and_while_restoring():
    e, a = flatten_env()
    e.x.doc_w, e.x.doc_h = 8000, 8000
    e.send(a, {"t": "renderLayer", "requestId": "big", "layerId": "t1"})
    assert "too large" in e.s.messages(a, "topError")[-1]["msg"]
    e.x.doc_w, e.x.doc_h = 64, 32
    e.x._restore_pending = True
    e.send(a, {"t": "renderLayer", "requestId": "rs", "layerId": "t1"})
    assert "restoring" in e.s.messages(a, "topError")[-1]["msg"]


def test_render_layer_with_a_different_sized_source_is_scaled_to_the_document():
    e, a = flatten_env()
    src = FakeTop("/project1/raster_editor/doc/t1_render", 32, 16, array=tops_img(32, 16))
    e.o.net.render_sources["t1"] = src
    made = []
    scaled = FakeTop("/project1/raster_editor/_imp_res0", 64, 32, array=tops_img(64, 32, 8))
    e.x._make_scaler = lambda top, tw, th, tag: (made.append((top, tw, th)) or (scaled, []))
    render_ready(e, a, frames=12)
    assert made == [(src, 64, 32)] and e.s.messages(a, "topReady")[0]["w"] == 64
    h, _ = P.decode_frame(get_top(e, a, "f1")["data"])
    assert (h.doc_w, h.doc_h) == (64, 32)


def test_render_layer_fails_if_the_document_is_resized_meanwhile():
    e, a = flatten_env()
    e.o.net.render_sources["t1"] = FakeTop("/project1/raster_editor/doc/t1_render", 64, 32, array=tops_img(64, 32))
    e.send(a, {"t": "renderLayer", "requestId": "rz", "layerId": "t1"})
    e.o.par.Docw.val = 70
    e.pump(6)
    assert "resized" in e.s.messages(a, "topError")[-1]["msg"] and not e.s.messages(a, "topReady")


def test_newer_render_layer_supersedes_a_running_import_of_the_same_client():
    e, a = flatten_env()
    install_tops(e, FakeTop("/project1/img", 6, 4, array=tops_img(6, 4)))
    e.o.net.render_sources["t1"] = FakeTop("/project1/raster_editor/doc/t1_render", 64, 32, array=tops_img(64, 32))
    e.send(a, {"t": "importTop", "requestId": "i1", "path": "/project1/img"})
    e.send(a, {"t": "renderLayer", "requestId": "f1", "layerId": "t1"})
    e.pump(12)
    assert [m["requestId"] for m in e.s.messages(a, "topError")] == ["i1"]
    assert [m["requestId"] for m in e.s.messages(a, "topReady")] == ["f1"]


# ----------------------------------------------------------------------------- v5: freeze / restore with variable surface sizes

def sized_env():
    e = Env()
    e.pump()
    a = e.connect("panel")
    layers = [L("base", "input", input=1), L("p1", slot=1, surfaceW=20, surfaceH=10, sx=2.0, sy=2.0, x=3.5, y=1.25),
              L("p2", slot=2, mask={"slot": 3, "enabled": True}, surfaceW=7, surfaceH=9)]
    e.doc(a, layers, rev=8)
    e.imgs = {1: wire_img(20, 10, 21, 255), 2: wire_img(7, 9, 22, 200), 3: wire_img(7, 9, 23, 255)}
    e.imgs[3][..., :3] = e.imgs[3][..., :1]
    for s, im in e.imgs.items():
        e.surface(a, s, (0, 0, im.shape[1], im.shape[0]), im, dw=im.shape[1], dh=im.shape[0], frame_id=s)
    e.pump()
    e.a, e.layers = a, layers
    return e


def test_freeze_checks_every_slot_against_its_own_size_and_thaw_round_trips():
    e = sized_env()
    e.x.Freeze()
    assert e.o.net.frozen and {s: (t.uploaded.shape[1], t.uploaded.shape[0]) for s, t in e.o.net.tops.items()} == {
        1: (20, 10), 2: (7, 9), 3: (7, 9)}
    e.x.Thaw()
    assert not e.o.net.frozen


def test_freeze_fails_and_releases_locks_when_a_surface_holds_the_wrong_size():
    e = sized_env()
    e.top(3).skip_copy = True  # its callback writes nothing: the locked 128x128 image is not 7x9
    with pytest.raises(RuntimeError, match="7x9"):
        e.x.Freeze()
    assert not e.o.net.frozen and not e.x.frozen


def test_restart_restores_every_surface_at_its_own_size_from_the_locked_tops():
    a = sized_env()
    a.x.Freeze()
    b = Env(like=a)
    b.x.Start()
    b.pump(3)
    assert {s: buf.shape for s, buf in b.x.surfaces.items()} == {1: (10, 20, 4), 2: (9, 7, 4), 3: (9, 7, 4)}
    cid = b.connect("panel", fresh=True)
    for s, im in a.imgs.items():
        h, got = b.dump(cid, s)
        assert (h.doc_w, h.doc_h) == (im.shape[1], im.shape[0])
        assert np.abs(got.astype(int) - im.astype(int)).max() <= 2  # (alpha 200 surfaces round trip through premultiplication)
    assert not b.x._restore_pending and b.x.doc_rev == 8 and not b.o.net.frozen


def test_restore_with_a_late_network_keeps_variable_sizes_and_holds_stale_tiles():
    a = sized_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.x.Start()
    assert b.x._restore_pending
    assert {s: buf.shape for s, buf in b.x.surfaces.items()} == {1: (10, 20, 4), 2: (9, 7, 4), 3: (9, 7, 4)}
    c = b.connect("panel")
    b.surface(c, 1, (0, 0, 20, 10), wire_img(20, 10, 99, 255), dw=20, dh=10)  # held, replayed after the restore
    assert b.x._held
    b.o.net.raise_on_apply = False
    b.pump(5)
    assert not b.x._restore_pending and not b.x._held
    assert (b.dump(c, 1)[1] == wire_img(20, 10, 99, 255)).all()
    assert b.dump(c, 2)[1].shape == (9, 7, 4)


def test_premultiplied_toggle_re_encodes_surfaces_of_every_size():
    e = sized_env()
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    e.pump(5)
    assert not e.x._stale_enc
    h, got = e.dump(e.a, 2)
    assert (h.doc_w, h.doc_h) == (7, 9)
    assert np.abs(got.astype(int) - e.imgs[2].astype(int)).max() <= 2  # (round trip through premultiplication)


def test_a_restored_v4_document_without_surface_sizes_uses_the_document_size():
    a = settled_env()
    a.x.Freeze()
    b = Env(like=a)
    b.x.Start()
    b.pump(3)
    assert all(buf.shape == (32, 64, 4) for buf in b.x.surfaces.values()) and b.x.doc_rev == 6


def test_adjustment_mask_without_a_size_follows_the_document_size_across_canvas_resize(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("base", "input", input=1), L("adj", "adjustment", mask={"slot": 4, "enabled": True}, adjustment={"type": "invert"})]
    env.doc(a, layers)
    assert env.x.surfaces[4].shape == (32, 64, 4)
    env.send(a, {"t": "setCanvas", "w": 128, "h": 64, "mode": "fixed"})
    env.doc(a, layers, rev=2)
    # (the page models the mask of a surface-less layer at document size and reframes it with the canvas: TD's buffer must match, or its
    # SURFACE dump is rejected as stale by the page and the document never finishes loading)
    assert env.x.surfaces[4].shape == (64, 128, 4)
    assert env.dump(a, 4)[0].doc_w == 128


def test_render_layer_aborts_when_the_source_operator_is_replaced_mid_readback():
    e, a = flatten_env()
    first = FakeTop("/project1/raster_editor/doc/t1_render", 64, 32, array=tops_img(64, 32))
    e.o.net.render_sources["t1"] = first
    e.send(a, {"t": "renderLayer", "requestId": "f1", "layerId": "t1"})
    e.pump(2)   # request opened, readback in progress
    e.o.net.render_sources["t1"] = FakeTop("/project1/raster_editor/doc/other", 64, 32, array=tops_img(64, 32, 9))
    e.pump(8)
    assert e.s.messages(a, "topError")[-1]["msg"] == "layer changed" and not e.s.messages(a, "topReady")


def test_render_layer_aborts_when_the_layer_vanishes_or_its_token_changes():
    for how in ("gone", "token"):
        e, a = flatten_env()
        e.o.net.render_sources["t1"] = FakeTop("/p/t1", 64, 32, array=tops_img(64, 32))
        e.send(a, {"t": "renderLayer", "requestId": "f1", "layerId": "t1"})
        e.pump(2)
        if how == "gone":
            del e.o.net.render_sources["t1"]
        else:
            e.o.net.token += 1   # a newer doc was applied
        e.pump(8)
        assert e.s.messages(a, "topError")[-1]["msg"] == "layer changed", how


def test_render_layer_waits_until_the_layer_is_ready_then_succeeds_or_times_out():
    e, a = flatten_env()
    src = FakeTop("/p/t1", 64, 32, array=tops_img(64, 32))
    e.o.net.render_sources["t1"] = src
    e.o.net.not_ready.add("t1")
    e.send(a, {"t": "renderLayer", "requestId": "f1", "layerId": "t1"})
    e.pump(6)
    assert src.calls == 0 and not e.s.messages(a, "topReady") and not e.s.messages(a, "topError")  # nothing read yet
    e.o.net.not_ready.clear()
    e.o.net.token += 1   # (measuring refined the layout while waiting: not an abort)
    e.pump(10)
    assert e.s.messages(a, "topReady")
    e2, a2 = flatten_env()
    e2.o.net.render_sources["t1"] = FakeTop("/p/t1", 64, 32, array=tops_img(64, 32))
    e2.o.net.not_ready.add("t1")
    e2.send(a2, {"t": "renderLayer", "requestId": "f2", "layerId": "t1"})
    e2.pump(2)
    e2.pump(1, dt=E.TOP_READ_TIMEOUT_S + 1)
    assert "never became ready" in e2.s.messages(a2, "topError")[-1]["msg"]


def test_doc_state_fills_in_missing_surface_sizes_for_the_client(env):
    env.set_input(80, 40)
    env.pump()
    a = env.connect("panel")
    env.doc(a, [L("base", "input", input=1), L("p1", slot=1), L("p2", slot=2, surfaceW=7, surfaceH=9)])
    b = env.connect("external", fresh=True)
    env.send(b, {"t": "requestDoc"})
    got = {l["id"]: (l["surfaceW"], l["surfaceH"]) for l in env.s.messages(b, "docState")[0]["layers"]}
    assert got == {"base": (80, 40), "p1": (80, 40), "p2": (7, 9)}
    assert "surfaceW" not in env.x.doc_layers[1]  # the stored stack is untouched


# ----------------------------------------------------------------------------- review follow-ups (base layer in TD, baseSize, export)

def base_of(env):
    return next(l for l in env.x.doc_layers if l["kind"] == "input")


def fixed_env_with_input(w=80, h=40):
    e = Env()
    e.set_input(w, h)
    e.pump()
    a = e.connect("panel")
    e.doc(a, [L("base", "input", input=1, surfaceW=w, surfaceH=h, x=30, y=10, sx=2.0, sy=2.0)], rev=3)
    e.send(a, {"t": "setCanvas", "w": 300, "h": 200, "mode": "fixed"})
    e.pump()
    return e, a


def test_switching_to_follow_input_resets_the_stored_base_transform_in_td():
    for via in ("setCanvas", "par"):
        e, a = fixed_env_with_input()
        assert (base_of(e)["x"], base_of(e)["sx"]) == (30, 2.0)
        if via == "setCanvas":
            e.send(a, {"t": "setCanvas", "w": 0, "h": 0, "mode": "input"})
        else:
            e.o.par.Docsizemode.val = "input"
            e.x.OnParChange(e.o.par.Docsizemode)
        b = base_of(e)
        assert (b["x"], b["y"], b["sx"], b["sy"]) == (0, 0, 1, 1), via
        assert e.o.net.applies[-1][0][0]["sx"] == 1 and e.x._doc_state_dirty
        e.pump()
        assert json.loads(e.o.doc_state.text)["layers"][0]["sx"] == 1


def test_fixed_mode_input_resolution_change_keeps_the_displayed_box_in_td():
    e, a = fixed_env_with_input(80, 40)
    e.set_input(160, 20)
    e.pump()
    b = base_of(e)
    assert (b["surfaceW"], b["surfaceH"]) == (160, 20)
    assert abs(b["sx"] * 160 - 2.0 * 80) < 1e-9 and abs(b["sy"] * 20 - 2.0 * 40) < 1e-9   # same 160x80 box
    assert (b["x"], b["y"]) == (30, 10) and e.o.net.applies[-1][0][0]["surfaceW"] == 160
    # Follow Input: only the surface size follows (the transform is the identity)
    e.send(a, {"t": "setCanvas", "w": 0, "h": 0, "mode": "input"})
    e.set_input(50, 60)
    e.pump()
    b = base_of(e)
    assert (b["surfaceW"], b["surfaceH"], b["sx"], b["sy"]) == (50, 60, 1, 1)


def test_fixed_mode_reconnect_of_an_input_does_not_rescale_from_a_stale_size():
    e, a = fixed_env_with_input(80, 40)
    e.o.inputs = []
    e.pump()
    e.set_input(100, 100)
    e.pump()
    b = base_of(e)
    assert (b["surfaceW"], b["surfaceH"], b["sx"]) == (100, 100, 2.0)   # no input before: just the new size


def test_inputs_message_follows_hello_and_equals_hello_inputs():
    e = Env()
    e.set_input(80, 40)
    e.pump()
    a = e.connect("panel")
    kinds = [m["t"] for c, m in e.s.texts if c == a]
    assert kinds.index("hello") < kinds.index("inputs") < kinds.index("files") < kinds.index("fonts")
    assert e.s.messages(a, "inputs")[0]["items"] == e.s.messages(a, "hello")[0]["inputs"] == [IN(1, 80, 40), IN(2)]
    b = e.connect("external")
    assert e.s.messages(b, "inputs")[0]["items"][0]["w"] == 80


def test_zero_sized_input_is_ignored_only_in_follow_input_mode():
    e = Env()
    e.set_input(80, 40)
    e.pump()
    e.o.in1.width = e.o.in1.height = 0
    e.pump()
    assert (e.x.doc_w, e.x.doc_h, e.x.in_w) == (80, 40, 80)   # Follow Input keeps the document while the input restarts
    e.o.in1.width, e.o.in1.height = 80, 40
    e.o.par.Docsizemode.val = "fixed"
    e.o.par.Docw.val, e.o.par.Doch.val = 200, 100
    e.pump()
    e.o.in1.width = e.o.in1.height = 0
    e.pump()
    assert (e.x.doc_w, e.x.doc_h) == (200, 100) and e.x.in_w == 80   # Fixed: the document never depended on it


def test_render_layer_first_read_after_readiness_is_discarded():
    e, a = flatten_env()
    src = FakeTop("/p/t1", 64, 32, array=tops_img(64, 32))
    e.o.net.render_sources["t1"] = src
    e.o.net.not_ready.add("t1")
    e.send(a, {"t": "renderLayer", "requestId": "f1", "layerId": "t1"})
    e.pump(3)
    src.array = tops_img(64, 32, 9)   # the final layout renders something else
    e.o.net.not_ready.clear()
    e.pump(1)   # ready flips: this pump may issue the first delayed read, never use it
    assert not e.s.messages(a, "topReady")
    e.pump(8)
    h, payload = P.decode_frame(get_top(e, a, "f1")["data"])
    want = frames.WireConverter().to_wire(tops_img(64, 32, 9), True)
    assert (np.frombuffer(payload, np.uint8).reshape(32, 64, 4) == want).all()


def test_exportdoc_failure_removes_the_part_file_and_keeps_unrelated_errors(tmp_path):
    e = settled_env()
    removed = []
    real_remove = E.os.remove
    E.os.remove = lambda p: removed.append(p)
    try:
        e.o.par.Exportpath.val = str(tmp_path / "x.tox")
        e.x._replace = lambda a, b: (_ for _ in ()).throw(OSError("rename failed"))
        assert e.x.ExportDoc() is None
    finally:
        E.os.remove = real_remove
    assert removed == [str(tmp_path / "x.part.tox")]
    e.x._replace = lambda a, b: None
    e.x.last_error = ("network: boom", e.x._now())
    assert e.x.ExportDoc() == str(tmp_path / "x.tox")
    assert e.x.last_error and e.x.last_error[0] == "network: boom"   # not an export error: stays


def test_exportpath_expands_the_home_directory():
    e = Env()
    e.o.par.Exportpath.val = "~/exports/a"
    path, _ = e.x._export_path()
    assert path == E.os.path.expanduser("~/exports/a") + ".tox" and "~" not in path


def test_exportdoc_in_follow_input_mode_mirrors_the_current_size_into_docw_doch(tmp_path):
    e = Env()
    e.set_input(80, 40)
    e.pump()
    e.o.par.Exportpath.val = str(tmp_path / "m.tox")
    e.x.ExportDoc()
    assert (e.o.par.Docw.val, e.o.par.Doch.val) == (80, 40)


def test_default_fit_uses_whole_pixels():
    e = Env()
    e.set_input(7, 3)
    e.o.par.Docsizemode.val = "fixed"
    e.o.par.Docw.val, e.o.par.Doch.val = 20, 20
    e.pump()
    (b,) = e.o.net.applies[-1][0]
    assert b["x"] == int(b["x"]) and b["y"] == int(b["y"])


# ----------------------------------------------------------------------------- deleting the COMP (TD freeze: Poco waits for idle connections)

def test_every_http_response_closes_the_connection():
    e = Env()
    for r in (e.get("/"), e.get("/nope"), e.get("/base", client="x"), e.get("/surface", client="x", slot=1),
              e.x.OnHTTPRequest(req(uri="/", data=b"", pars={}, clientAddress="8.8.8.8:1"), {})):
        assert r["Connection"] == "close", r["statusCode"]


def test_on_destroy_td_quiets_everything_the_destruction_could_wait_for():
    e = settled_env()
    e.x.BecomeMaster()
    c2 = e.connect("external")
    install_tops(e, FakeTop("/project1/t", 6, 4, array=tops_img(6, 4)))
    e.send(c2, {"t": "importTop", "requestId": "r", "path": "/project1/t"})
    e.s.webSocketConnections[:] = [e.a, c2]
    e.x.onDestroyTD()
    assert set(e.s.closed) == {e.a, c2}   # every WebSocket peer closed by us
    assert e.o.server.par.active.val == 0 and not e.x.is_master
    assert not e.x.clients and e.x.active_id is None
    assert e.x._imp is None and not e.x._imp_queue and not e.x._tops_held
    assert json.loads(e.o.doc_state.text)["rev"] == 6   # the pending document state was stored
    assert not e.o.net.frozen   # (nothing is locked: TD's undo snapshot predates this hook anyway)


def test_after_destroy_the_pump_and_callbacks_do_nothing_and_never_restart():
    e = settled_env()
    e.x.onDestroyTD()
    n = len(e.o.net.applies)
    e.pump(5)
    e.x.Start()
    assert not e.x._started and len(e.o.net.applies) == n and e.o.server.par.active.val == 0
    e.x.OnWebSocketText("127.0.0.1:1", "{}")
    e.x.OnProjectSave(True)   # (a late callback must not raise)


def test_on_destroy_td_survives_failing_operators_and_is_idempotent(capsys):
    e = settled_env()
    e.o.server.webSocketClose = lambda c: (_ for _ in ()).throw(RuntimeError("dead"))
    e.o.server.webSocketConnections.append("127.0.0.1:9")
    e.o._ops["webserver"] = None            # an operator that is already gone
    e.x._save_undo_cache = lambda: (_ for _ in ()).throw(OSError("disk full"))
    e.x.onDestroyTD()
    e.x.onDestroyTD()
    out = capsys.readouterr().out
    assert "onDestroyTD/server" in out and "onDestroyTD/undo cache" in out
    assert e.x._destroyed


# ----------------------------------------------------------------------------- undo of a delete / re-initialised extension

def test_on_destroy_td_of_an_old_instance_after_reinit_does_not_touch_the_server():
    e = settled_env()
    e.x.BecomeMaster()
    e.o.ext = types.SimpleNamespace(RasterEditorExt=object())   # TD built the new instance first
    e.x.onDestroyTD()
    assert e.o.server.par.active.val == 1 and not e.s.closed and e.x.clients and e.x._started and not e.x._destroyed
    e.o.ext = types.SimpleNamespace()                       # on a real delete the extension is already gone
    e.x.onDestroyTD()
    assert e.o.server.par.active.val == 0 and e.x._destroyed


def cache_dirs(x):
    import os
    return sorted(n for n in (os.listdir(CACHE_ROOT) if os.path.isdir(CACHE_ROOT) else []) if n.startswith(x._undo_prefix()))


def recreated(a, **kw):
    """What TD's undo of the delete builds: the snapshot's stored document, blank unlocked Script TOPs, a new instance."""
    b = Env(**kw)
    b.o.doc_state.text = a.o.doc_state.text
    return b


def test_delete_during_a_pending_restore_leaves_the_locked_images_alone():
    a = sized_env()
    a.x.Freeze()
    b = Env(like=a)
    b.o.net.raise_on_apply = True
    b.x.Start()
    assert b.x._restore_pending
    b.x.onDestroyTD()
    assert all(t.lock for t in b.o.net.tops.values())   # the only copy of the pixels stays locked
    assert not cache_dirs(b.x)


def test_undo_of_the_delete_gets_the_pixels_back_from_the_side_cache():
    a = sized_env()
    want = {s: buf.copy() for s, buf in a.x.surfaces.items()}
    a.x.onDestroyTD()
    assert len(cache_dirs(a.x)) == 1
    b = recreated(a)
    b.x.Start()
    b.pump(3)
    assert not b.x._restore_pending
    for s, buf in want.items():
        assert (b.x.surfaces[s] == buf).all(), s
    assert b.top(1).uploaded.shape == (10, 20, 4)   # re-uploaded to the Script TOP
    assert not cache_dirs(b.x)                      # consumed


def test_side_cache_converts_premultiplied():
    a = sized_env()
    a.x.onDestroyTD()
    b = recreated(a, Premultiplied=0)
    b.x.Start()
    b.pump(3)
    assert np.abs(b.x.surfaces[2].astype(int) - a.imgs[2][::-1].astype(int)).max() <= 1   # (alpha-200 straight pixels)


def test_a_different_document_at_the_same_path_never_gets_the_deleted_pixels():
    a = sized_env()
    a.x.onDestroyTD()
    other = json.loads(a.o.doc_state.text)
    other["rev"] += 1   # same layers and slot sizes, another document (e.g. a component pasted later at this path)
    d = Env()
    d.o.doc_state.text = json.dumps(other)
    d.x.Start()
    d.pump(3)
    assert d.x.surfaces[1].shape == (10, 20, 4) and not d.x.surfaces[1].any() and not d.x.surfaces[2].any()
    assert not cache_dirs(d.x)   # and the stale cache is gone


def test_a_different_layer_behind_a_slot_is_not_taken():
    import os
    a = sized_env()
    a.x.onDestroyTD()
    (name,) = cache_dirs(a.x)
    mp = os.path.join(CACHE_ROOT, name, "meta.json")
    meta = json.load(open(mp))
    meta["slots"]["1"]["layer"] = "someone_else:pixel"
    json.dump(meta, open(mp, "w"))
    b = recreated(a)
    b.x.Start()
    b.pump(3)
    assert not b.x.surfaces[1].any() and b.x.surfaces[2].any()   # only the slot whose layer matches


def test_slots_restored_from_locked_images_or_carry_are_never_overwritten_by_the_cache():
    a = sized_env()
    a.x.Freeze()
    locked = {s: t.uploaded.copy() for s, t in a.o.net.tops.items()}
    a.x.onDestroyTD()   # (frozen + cached: both exist)
    for s in a.o.net.tops:
        a.x.surfaces[s][...] = 7   # change after the cache was written: the locked image is the truth
    a.x.Freeze()
    b = Env(like=a)
    b.x.Start()
    b.pump(3)
    assert (b.x.surfaces[1] == 7).all() and (b.x.surfaces[2] == 7).all()   # the locked images win over the cache
    # direct check of the skip set
    c = recreated(sized_env())
    c.x.Start()
    c.pump(2)
    c.x._restore_doc_hash = a.x._text_hash(c.o.doc_state.text)
    c.x.surfaces[1][...] = 9
    assert c.x._load_undo_cache({1, 2, 3}) == set() and (c.x.surfaces[1] == 9).all()


def test_no_stored_document_removes_leftover_caches_and_the_restore_hash_is_unused():
    a = sized_env()
    a.x.onDestroyTD()
    f = Env()
    f.x.Start()
    f.pump(3)
    assert not f.x.surfaces and not cache_dirs(f.x)


def test_old_side_caches_are_pruned_on_start_and_on_delete(tmp_path):
    import os
    e = Env()
    e.x._cache_root = lambda: str(tmp_path)
    old, new = tmp_path / "old", tmp_path / "new"
    for d in (old, new):
        d.mkdir()
        (d / "meta.json").write_text("{}")
    t = os.path.getmtime(old) - 7 * 3600
    os.utime(old, (t, t))
    e.x.Start()
    assert not old.exists() and new.exists()
    os.utime(new, (t, t))
    e.x.onDestroyTD()
    assert not new.exists()


def test_side_cache_is_skipped_when_too_big(monkeypatch):
    assert E.RasterEditorExt.UNDO_CACHE_MAX_BYTES == 256 << 20
    a = sized_env()
    monkeypatch.setattr(type(a.x), "UNDO_CACHE_MAX_BYTES", 10)
    a.x.onDestroyTD()
    assert not cache_dirs(a.x)


def test_cache_is_written_by_a_worker_thread_and_an_immediate_undo_waits_for_it(monkeypatch):
    import threading
    import time as _t
    a = sized_env()
    a.x._sync_cache_writes = False
    real_save = np.save
    gate = threading.Event()
    monkeypatch.setattr(E.np, "save", lambda *args, **kw: (gate.wait(5), real_save(*args, **kw))[1])
    want = a.x.surfaces[1].copy()
    t0 = _t.time()
    a.x.onDestroyTD()
    assert _t.time() - t0 < 1.0 and a.x._undo_writers   # the delete returned while the writer is still blocked
    b = recreated(a)
    threading.Timer(0.3, gate.set).start()
    b.x.Start()    # the undo comes at once: it waits for the files
    b.pump(3)
    assert (b.x.surfaces[1] == want).all()
    assert not a.x._undo_writers


def test_a_failing_write_leaves_no_cache_and_a_damaged_cache_is_removed_without_raising(monkeypatch, capsys):
    import os
    a = sized_env()
    monkeypatch.setattr(E.np, "save", lambda *a_, **k: (_ for _ in ()).throw(OSError("disk full")))
    a.x.onDestroyTD()
    monkeypatch.undo()
    assert not cache_dirs(a.x) and "undo cache not written" in capsys.readouterr().out
    c = sized_env()
    c.x.onDestroyTD()
    (name,) = cache_dirs(c.x)
    open(os.path.join(CACHE_ROOT, name, "s1.npy"), "wb").write(b"garbage")
    b = recreated(c)
    b.x.Start()
    b.pump(3)
    assert not b.x._restore_pending and not cache_dirs(b.x)
    c2 = sized_env()
    c2.x.onDestroyTD()
    (name,) = cache_dirs(c2.x)
    open(os.path.join(CACHE_ROOT, name, "meta.json"), "w").write("{")
    b2 = recreated(c2)
    b2.x.Start()
    b2.pump(3)
    assert not cache_dirs(b2.x)


def test_meta_is_written_atomically_last_and_the_root_is_private(tmp_path):
    import os
    import stat
    a = sized_env()
    a.x._cache_root = lambda: str(tmp_path / "root")
    a.x.onDestroyTD()
    root = tmp_path / "root"
    assert stat.S_IMODE(os.stat(root).st_mode) == 0o700
    (d,) = list(root.iterdir())
    assert sorted(p.name for p in d.iterdir()) == ["meta.json", "s1.npy", "s2.npy", "s3.npy"]   # (no .tmp left)


def test_a_cache_root_owned_by_someone_else_is_not_used(tmp_path, monkeypatch):
    import os
    a = sized_env()
    a.x._cache_root = lambda: str(tmp_path)
    monkeypatch.setattr(os, "getuid", lambda: os.stat(tmp_path).st_uid + 1)
    a.x.onDestroyTD()
    assert not list(tmp_path.iterdir())


def test_applied_is_sent_even_when_td_cooked_the_script_tops_before_the_pump():
    """A downstream consumer (effect chain) can cook a surface's Script TOP right after the tile arrived: OnSurfaceCook clears the dirty flag,
    the pump then finds nothing dirty -- the client must still get `applied` for its newest frame."""
    e = Env()
    e.pump()
    a = e.connect("panel")
    e.doc(a, DOC)
    e.pump(2)
    e.surface(a, 1, (0, 0, 64, 32), wire_img(64, 32, 4, 255))
    e.o.net.tops[1].cook()   # TD's own cook (not the pump's forced one) writes the buffer and clears the dirty flag
    assert 1 not in e.x._dirty
    e.pump()
    assert e.s.messages(a, "applied")[-1]["frameId"] == 1
    n = len(e.s.messages(a, "applied"))
    e.pump(3)
    assert len(e.s.messages(a, "applied")) == n    # still only once per newest frame


# ----------------------------------------------------------------------------- v9: masks on groups and input layers

def test_group_mask_is_document_sized_and_follows_the_canvas_resize(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("base", "input", input=1), L("g", "group", mask={"slot": 4, "enabled": True}), L("p", slot=1, surfaceW=9, surfaceH=5)]
    layers[2]["parentId"] = "g"
    env.doc(a, layers)
    assert env.x.surfaces[4].shape == (32, 64, 4) and (env.x.surfaces[4] == 255).all()
    black = np.zeros((32, 64, 4), np.uint8)
    black[..., 3] = 255
    env.surface(a, 4, (0, 0, 64, 32), black)
    assert (env.dump(a, 4)[1] == black).all()
    env.send(a, {"t": "setCanvas", "w": 128, "h": 64, "mode": "fixed"})
    env.doc(a, layers, rev=2)
    m = env.dump(a, 4)[1]
    assert m.shape == (64, 128, 4) and (m[:32, :64] == black).all() and (m[32:] == 255).all() and (m[:, 64:] == 255).all()


def test_input_mask_has_the_input_surface_size_and_survives_an_input_resize(env):
    env.pump()
    a = env.connect("panel")
    layers = [L("i", "input", input=1, surfaceW=40, surfaceH=20, mask={"slot": 5, "enabled": True})]
    env.doc(a, layers)
    assert env.x.surfaces[5].shape == (20, 40, 4) and (env.x.surfaces[5] == 255).all()
    black = np.zeros((20, 40, 4), np.uint8)
    black[..., 3] = 255
    env.surface(a, 5, (0, 0, 40, 20), black, dw=40, dh=20)
    assert (env.dump(a, 5)[1] == black).all()
    layers[0].update(surfaceW=80, surfaceH=40)                           # the input changed size: the page stretches the mask and resends
    env.doc(a, layers, rev=2)
    assert env.x.surfaces[5].shape == (40, 80, 4)
    big = np.zeros((40, 80, 4), np.uint8)
    big[..., 3] = 255
    env.surface(a, 5, (0, 0, 80, 40), big, dw=80, dh=40)
    assert (env.dump(a, 5)[1] == big).all()
    env.doc(a, [L("i", "input", input=1, surfaceW=80, surfaceH=40)], rev=3)      # mask deleted: the surface is freed
    assert 5 not in env.x.surfaces


def _half_mask(w, h):
    m = np.zeros((h, w, 4), np.uint8)
    m[..., 3] = 255
    m[:, w // 2:, :3] = 255                     # left half hides, right half shows
    return m


def _mask_halves(buf):
    """(left mean, right mean) of a TD-order mask buffer."""
    w = buf.shape[1]
    return float(buf[:, : w // 4, 0].mean()), float(buf[:, -(w // 4):, 0].mean())


def test_frames_stretch_buffer_is_a_normalised_bilinear_resample():
    from_ = np.zeros((2, 2, 4), np.uint8)
    from_[..., 3] = 255
    from_[:, 1, :3] = 200
    big = frames.stretch_buffer(from_, 8, 6)
    assert big.shape == (6, 8, 4) and big[0, 0, 0] == 0 and big[0, -1, 0] == 200 and (big[..., 3] == 255).all()
    assert list(big[3, :, 0]) == sorted(big[3, :, 0])                      # monotone ramp between the two columns
    assert (frames.stretch_buffer(big, 8, 6) == big).all() and frames.stretch_buffer(big, 8, 6) is not big
    assert frames.stretch_buffer(big, 2, 2).shape == (2, 2, 4)


def test_realloc_of_an_input_mask_stretches_instead_of_padding(env):
    env.pump()
    a = env.connect("panel")
    lay = lambda w, h: [L("i", "input", input=1, surfaceW=w, surfaceH=h, mask={"slot": 5, "enabled": True})]   # noqa: E731
    env.doc(a, lay(40, 20))
    env.surface(a, 5, (0, 0, 40, 20), _half_mask(40, 20), dw=40, dh=20)
    env.doc(a, lay(80, 40), rev=2)                                       # the input doubled its resolution
    buf = env.x.surfaces[5]
    assert buf.shape == (40, 80, 4)
    left, right = _mask_halves(buf)
    assert left < 5 and right > 250 and (buf[..., 3] == 255).all()       # padding would leave the right 3/4 white and the left 1/4 black only


def test_input_resolution_change_stretches_the_input_mask_at_once(env):
    env.set_input(40, 20)
    env.pump()
    a = env.connect("panel")
    env.doc(a, [L("i", "input", input=1, surfaceW=40, surfaceH=20, mask={"slot": 5, "enabled": True})])
    env.surface(a, 5, (0, 0, 40, 20), _half_mask(40, 20), dw=40, dh=20)
    env.set_input(80, 40)
    for _ in range(6):
        env.pump()
    assert env.x.in_sizes[1] == (80, 40)
    assert env.x.surfaces[5].shape == (40, 80, 4)
    left, right = _mask_halves(env.x.surfaces[5])
    assert left < 5 and right > 250
    assert env.x.doc_layers[0]["surfaceW"] == 80 and env.x._slot_size[5] == (80, 40)


@pytest.mark.parametrize("surface_first", [False, True])
def test_input_mask_surface_and_doc_in_either_order(env, surface_first):
    env.pump()
    a = env.connect("panel")
    lay = lambda w, h: [L("i", "input", input=1, surfaceW=w, surfaceH=h, mask={"slot": 5, "enabled": True})]   # noqa: E731
    env.doc(a, lay(40, 20))
    new = _half_mask(80, 40)
    new[:, :, :3] = 255 - new[:, :, :3]                                  # the exact mask the page sends: inverted halves
    if surface_first:
        env.surface(a, 5, (0, 0, 80, 40), new, dw=80, dh=40)            # arrives before the doc that gives the slot its new size
        assert env.x.surfaces[5].shape == (20, 40, 4)
        env.doc(a, lay(80, 40), rev=2)
    else:
        env.doc(a, lay(80, 40), rev=2)
        env.surface(a, 5, (0, 0, 80, 40), new, dw=80, dh=40)
    h, got = env.dump(a, 5)
    assert (h.w, h.h) == (80, 40) and (got[..., 0] == new[..., 0]).all()


def test_stale_frames_of_a_size_that_never_comes_are_dropped_after_the_next_doc(env):
    env.pump()
    a = env.connect("panel")
    lay = [L("i", "input", input=1, surfaceW=40, surfaceH=20, mask={"slot": 5, "enabled": True})]
    env.doc(a, lay)
    env.surface(a, 5, (0, 0, 80, 40), _half_mask(80, 40), dw=80, dh=40)
    assert env.x._early
    env.doc(a, lay, rev=2)                                               # still 40x20: the early frame is stale for good
    assert not env.x._early and (env.x.surfaces[5] == 255).all() and env.x.surfaces[5].shape == (20, 40, 4)


def test_surfaceless_input_mask_uses_the_live_input_size_in_the_slot_and_the_network(env):
    env.set_input(48, 24)
    env.pump()
    a = env.connect("panel")
    env.doc(a, [L("i", "input", input=1, mask={"slot": 5, "enabled": True})])
    assert env.x.surfaces[5].shape == (24, 48, 4) and env.x._slot_size[5] == (48, 24)
    assert env.x.doc_layers[0]["surfaceW"] == 48
    env.send(a, {"t": "setCanvas", "w": 128, "h": 64, "mode": "fixed"})   # a canvas change keeps the input mask at the input's size
    env.pump()
    assert env.x.surfaces[5].shape == (24, 48, 4)


def test_pump_is_skipped_while_the_network_applies(env):
    """TD runs the frame callbacks in-line when apply() creates an operator: that nested Pump re-applied the previous document and
    removed the surfaces being created (network.py 'fx_L_p4' KeyError / 's1 has been deleted')."""
    env.pump()
    a = env.connect("panel")
    net = env.o.net
    seen = []
    real = net.apply

    def apply(layers, w, h):
        before = len(net.applies)
        pumps = env.x.pump_count
        env.x.Pump()                      # the in-line frame callback
        seen.append((env.x.pump_count == pumps, len(net.applies) == before))
        return real(layers, w, h)
    net.apply = apply
    env.doc(a, DOC, rev=7)
    net.apply = real
    assert seen and all(s == (True, True) for s in seen) and env.x.pump_reentered >= 1
    env.pump(3)                           # normal frames resume
    assert env.x.pump_count > 0 and env.x.doc_rev == 7
