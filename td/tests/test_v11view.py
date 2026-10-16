"""v11 (DESIGN_V9): fast / exact TD view frames: codecs against the golden fixtures, tile diffs, and the per-client state machine."""

import json
import os
import zlib

import numpy as np
import pytest

import ext as E
import frames as F
import protocol as P
from test_ext import Env, set_output
from test_v8_router import Project, ws_connect

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "fixtures")


def fixture(name):
    return open(os.path.join(FIX, name + ".bin"), "rb").read()


def pixel(x, y):
    return ((x * 7 + y * 3) & 255, (x * 13 + y * 5 + 40) & 255, (x + y * 11) & 255, 255 - ((x + y) & 63))


# ----------------------------------------------------------------------------- codecs vs the golden fixtures

with open(os.path.join(FIX, "view_v11.json")) as _fh:
    VIEW_FIXTURES = json.load(_fh)["messages"]


def test_fast_fixture_fields():
    m = next(e for e in VIEW_FIXTURES if e["name"] == "view_fast")
    d = P.decode_view_fast(fixture("view_fast"))
    assert (d["frameId"], d["applied"], d["docW"], d["docH"], d["pw"], d["ph"]) == (77, 70, 100, 60, 8, 6)
    assert d["rect"] == (10.5, 4.25, 80.0, 48.0)
    assert len(d["rgb"]) == m["rgbLen"] and len(d["alpha"]) == m["alphaLen"]
    assert bytes(d["rgb"])[:2] == b"\xff\xd8" and bytes(d["alpha"])[-2:] == b"\xff\xd9"
    hdr, _ = P.decode_frame(fixture("view_fast"))
    assert (hdr.type, hdr.slot, hdr.flags, hdr.frame_id, hdr.x, hdr.y, hdr.w, hdr.h) == (8, 0, 1, 77, 0, 0, 0, 0)
    assert P.VIEW_FAST_HEADER.size == 36 == m["subHeaderSize"]


def test_fast_opaque_fixture_has_no_alpha_and_no_applied():
    d = P.decode_view_fast(fixture("view_fast_opaque"))
    assert d["alpha"] == b"" and d["applied"] is None and d["frameId"] == 0xFFFFFFFE


def test_exact_fixtures_round_trip_pixels():
    full = P.decode_view_exact(fixture("view_exact_full"))
    assert (full["kind"], full["tile"], full["nTiles"], full["docW"], full["docH"], full["applied"]) == (0, 64, 0, 70, 66, 80)
    buf = F.decode_exact_body(full["body"], 70, 66, 0, 0)
    want = np.array([[pixel(x, y) for x in range(70)] for y in range(66)], np.uint8)
    assert (buf == want).all()
    tiles = P.decode_view_exact(fixture("view_exact_tiles"))
    assert (tiles["kind"], tiles["nTiles"], tiles["frameId"]) == (1, 2, 91)
    buf = F.decode_exact_body(tiles["body"], 70, 66, 1, 2, buf)
    exp = want.copy()
    exp[10:21, 64:70] ^= 0x55
    exp[64:66, 0:6] ^= 0x33
    assert (buf == exp).all()
    m = next(e for e in VIEW_FIXTURES if e["name"] == "view_exact_tiles")
    import hashlib
    assert hashlib.sha256(buf.tobytes()).hexdigest() == m["pixelsAfterSha256"]
    assert list(zlib.decompress(tiles["body"])[:16]) == list(np.array([1, 0, 0, 0, 6, 0, 64, 0, 0, 0, 1, 0, 64, 0, 2, 0], np.uint8))


def test_tile_frame_without_matching_buffer_is_refused():
    tiles = P.decode_view_exact(fixture("view_exact_tiles"))
    with pytest.raises(ValueError):
        F.decode_exact_body(tiles["body"], 70, 66, 1, 2, None)
    with pytest.raises(ValueError):
        F.decode_exact_body(tiles["body"], 70, 66, 1, 2, np.zeros((10, 10, 4), np.uint8))


@pytest.mark.parametrize("name", [e["name"] for e in VIEW_FIXTURES if e.get("valid") is False])
def test_invalid_view_fixtures_are_rejected(name):
    m = next(e for e in VIEW_FIXTURES if e["name"] == name)
    dec = P.decode_view_fast if m["type"] == 8 else P.decode_view_exact
    with pytest.raises(P.ProtocolError):
        dec(fixture(name))


def test_encoders_reproduce_the_fixtures_bytes():
    d = P.decode_view_fast(fixture("view_fast"))
    again = P.encode_view_fast(d["frameId"], d["applied"], d["docW"], d["docH"], d["rect"], d["pw"], d["ph"], d["rgb"], d["alpha"])
    assert again == fixture("view_fast")
    e = P.decode_view_exact(fixture("view_exact_tiles"))
    assert P.encode_view_exact(e["frameId"], e["applied"], e["docW"], e["docH"], e["kind"], e["nTiles"], e["body"]) == fixture("view_exact_tiles")


def test_old_invalid_type_fixture_moved_to_type_10():
    assert fixture("invalid_type")[4] == 10
    with pytest.raises(P.ProtocolError):
        P.decode_frame(fixture("invalid_type"))


def test_view_frames_only_exist_with_a_zero_rect_and_slot_0():
    with pytest.raises(P.ProtocolError):
        P.encode_header(P.Header(P.TYPE_VIEW_FAST, 1, 1, 10, 10, 0, 0, 5, 5))
    with pytest.raises(P.ProtocolError):
        P.encode_header(P.Header(P.TYPE_VIEW_EXACT, 1, 1, 10, 10, 0, 0, 0, 0, 3))
    P.encode_header(P.Header(P.TYPE_VIEW_EXACT, 1, 1, 10, 10, 0, 0, 0, 0, 0))
    with pytest.raises(P.ProtocolError):
        P.decode_view_exact(fixture("view_fast"))
    with pytest.raises(P.ProtocolError):
        P.decode_view_fast(fixture("view_exact_full"))
    with pytest.raises(P.ProtocolError):
        P.encode_view_exact(1, 0, 10, 10, P.EXACT_FULL, 3, b"x")   # a full frame has no tiles


def test_parse_view11_validation():
    ok = P.parse_view11({"t": "view", "mode": "td", "quality": "fast", "viewport": {"x": 1, "y": 2, "w": 30, "h": 40, "scale": 2}})
    assert ok == {"mode": "td", "quality": "fast", "viewport": {"x": 1.0, "y": 2.0, "w": 30.0, "h": 40.0, "scale": 2.0}}
    assert P.parse_view11({"t": "view", "mode": "local"}) == {"mode": "local", "quality": "auto", "viewport": None}
    for bad in ({"mode": "x"}, {"mode": "td", "quality": "best"}, {"mode": "td", "viewport": {"x": 0, "y": 0, "w": 0, "h": 5, "scale": 1}},
                {"mode": "td", "viewport": {"x": 0, "y": 0, "w": 5, "h": 5, "scale": -1}}, {"mode": "td", "viewport": {"x": "a", "y": 0, "w": 5, "h": 5, "scale": 1}},
                {"mode": "td", "viewport": [1, 2]}, {"mode": "td", "viewport": {"x": 0, "y": 0, "w": float("nan"), "h": 5, "scale": 1}}):
        with pytest.raises(P.ProtocolError):
            P.parse_view11(bad)
    assert P.parse_view_ack({"frameId": 5}) == 5
    for bad in ({}, {"frameId": -1}, {"frameId": True}, {"frameId": 2 ** 32}, {"frameId": "1"}):
        with pytest.raises(P.ProtocolError):
            P.parse_view_ack(bad)


def test_json_builders_v11():
    assert json.loads(P.view_td("fast", {"x": 0, "y": 0, "w": 5, "h": 5, "scale": 1}))["quality"] == "fast"
    assert json.loads(P.view_ack(3)) == {"t": "viewAck", "frameId": 3}
    assert json.loads(P.view_exact_reset()) == {"t": "viewExactReset"}
    assert json.loads(P.view_exact_notice(4, 99)) == {"t": "viewExact", "frameId": 4, "size": 99}
    assert json.loads(P.hello(1, 1, False, 30, True, "c", protocol=10))["protocol"] == 10


# ----------------------------------------------------------------------------- tile diffs

def rnd(h, w, seed=0):
    return np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)


def test_dirty_tiles_grid_and_edges():
    a = rnd(130, 200)
    b = a.copy()
    assert not F.dirty_tiles(a, b).any()
    b[0, 0] ^= 1
    b[129, 199] ^= 1
    b[64, 64] ^= 1
    d = F.dirty_tiles(a, b)
    assert d.shape == (3, 4)
    assert d.tolist() == [[True, False, False, False], [False, True, False, False], [False, False, False, True]]


def test_plan_exact_none_tiles_full_and_threshold():
    a = rnd(128, 256)   # 2 x 4 = 8 tiles
    assert F.plan_exact(a, None) == ("full", None)
    assert F.plan_exact(a, a[:64]) == ("full", None)
    assert F.plan_exact(a, a.copy()) == ("none", None)
    b = a.copy()
    b[:64, :64] ^= 1
    b[:64, 64:128] ^= 1
    kind, tiles = F.plan_exact(b, a)
    assert kind == "tiles" and tiles.tolist() == [[0, 0], [0, 1]]
    c = a.copy()
    c[:64, :192] ^= 1     # 3 of 8 tiles = 37.5 % > 30 %
    assert F.plan_exact(c, a)[0] == "full"
    assert F.plan_exact(c, a, threshold=0.5)[0] == "tiles"


def test_tiles_body_round_trip_with_clipped_edge_tiles():
    prev = rnd(100, 150, 1)
    cur = prev.copy()
    cur[70:100, 128:150] = rnd(30, 22, 2)
    cur[3:5, 3:5] ^= 0xFF
    plan = F.plan_exact(cur, prev, threshold=0.5)
    assert plan[0] == "tiles"
    kind, n, body = F.compress_exact(cur, plan)
    assert kind == 1 and n == len(plan[1]) == 2
    got = F.decode_exact_body(body, 150, 100, 1, n, prev.copy())
    assert (got == cur).all()
    kind, n, body = F.compress_exact(cur, ("full", None))
    assert (kind, n) == (0, 0) and (F.decode_exact_body(body, 150, 100, 0, 0) == cur).all()


def test_decode_exact_rejects_wrong_sizes():
    with pytest.raises(ValueError):
        F.decode_exact_body(zlib.compress(b"123"), 4, 4, 0, 0)
    prev = np.zeros((70, 70, 4), np.uint8)
    cur = prev.copy()
    cur[0, 0] = 1
    plan = F.plan_exact(cur, prev, threshold=1.0)
    _, n, body = F.compress_exact(cur, plan)
    with pytest.raises(ValueError):
        F.decode_exact_body(zlib.compress(zlib.decompress(body) + b"x"), 70, 70, 1, n, prev.copy())


# ----------------------------------------------------------------------------- the state machine (fake TD)

DW, DH = 200, 150


class V:
    """An Env whose GPU nodes, JPEG encoder and capture are faked; clients speak protocol 11."""

    def __init__(self, env=None, **pars):
        self.env = env or Env(Docw=DW, Doch=DH, **pars)
        x = self.x = self.env.x
        x._sync_view_workers = True
        x._get_cv2 = lambda: True
        x._encode_jpeg = lambda arr, q: b"\xff\xd8" + bytes([q]) + b"\xff\xd9"
        self.chains, self.destroyed, self.captures = [], [], []
        self.alpha = None   # what the faked capture returns as the alpha plane
        x._make_vchain = self._mk
        x._set_vchain = lambda chain, region, pw, ph: chain.update(geom=(region, pw, ph))
        x._destroy_vchain = lambda chain: self.destroyed.append(chain["n"])
        x._capture_fast = self._cap
        self.env.pump()

    def _mk(self, n, src):
        chain = {"n": n, "geom": None, "ops": []}
        self.chains.append(chain)
        return chain

    def _cap(self, chain, pw, ph, premult):
        self.captures.append((chain["n"], pw, ph))
        return np.zeros((ph, pw, 3), np.uint8), (None if self.alpha is None else np.full((ph, pw), self.alpha, np.uint8))

    def connect(self, protocol=11, acked=True):
        cid = self.env.connect("external", protocol=protocol)
        self.x.clients[cid].v_acked = acked     # (a client that has acknowledged a frame before: full speed)
        return cid

    def view(self, cid, quality="auto", viewport=None, mode="td"):
        msg = {"t": "view", "mode": mode, "quality": quality}
        if viewport is not None:
            msg["viewport"] = viewport
        self.env.send(cid, msg)

    def frames(self, cid, kind=None):
        out = []
        for c, b in self.env.s.binaries:
            if c != cid:
                continue
            t = P.decode_frame(b)[0].type
            if t == P.TYPE_VIEW_FAST:
                out.append(("fast", P.decode_view_fast(b), b))
            elif t == P.TYPE_VIEW_EXACT:
                out.append(("exact", P.decode_view_exact(b), b))
        return [f for f in out if kind in (None, f[0])]

    def ack_all(self, cid):
        for k, d, _ in self.frames(cid):
            self.env.send(cid, {"t": "viewAck", "frameId": d["frameId"]})

    def out(self, seed=0, **kw):
        return set_output(self.env, seed, w=DW, h=DH, alpha=1.0, **kw)

    def pump(self, n=1, ack=True):
        for _ in range(n):
            self.env.pump()
            if ack:
                for cid in list(self.x.clients):
                    self.ack_all(cid)


def want_wire(arr):
    return np.floor(arr[::-1] * 255 + 0.5).astype(np.uint8)


def apply_exact(buf, d):
    return F.decode_exact_body(d["body"], d["docW"], d["docH"], d["kind"], d["nTiles"], buf)


def test_hello_echoes_the_clients_protocol_and_rejects_others():
    v = V()
    a, b = v.connect(11), v.connect(10)
    assert v.env.s.messages(a, "hello")[0]["protocol"] == 11 and v.env.s.messages(b, "hello")[0]["protocol"] == 10
    for bad in (9, 12, "11", True, None):
        c = v.env.connect("external", protocol=bad)
        assert v.env.s.messages(c, "error") and v.env.s.messages(c, "hello") == []


def test_fast_only_streams_jpeg_frames_with_the_viewport_geometry_and_never_sends_exact():
    v = V()
    c = v.connect()
    v.out(1)
    v.view(c, "fast", {"x": 20.4, "y": 10.2, "w": 100, "h": 60, "scale": 2.0})
    v.pump(3)
    (kind, d, raw) = v.frames(c)[0]
    assert kind == "fast" and d["applied"] is None and (d["docW"], d["docH"]) == (DW, DH)
    # integer region around the visible rect, never upscaled (100 x 60 region -> at most 101 x 61 px at scale 2)
    assert d["rect"] == (20.0, 10.0, 101.0, 61.0) and (d["pw"], d["ph"]) == (101, 61)
    assert bytes(d["rgb"]).startswith(b"\xff\xd8") and d["alpha"] == b""
    v.pump(40)
    assert all(k == "fast" for k, _, _ in v.frames(c))
    assert len(v.frames(c)) == 1            # unchanged output: no repeat
    assert len(v.chains) == 1 and v.chains[0]["geom"] == ((20, 10, 101, 61), 101, 61)


def test_fast_frames_follow_output_changes_with_applied_and_alpha():
    v = V()
    c = v.connect()
    v.alpha = 200
    v.view(c, "fast")
    v.out(1)
    v.pump(3)
    v.env.send(c, {"t": "doc", "rev": 1, "layers": [{"id": "p1", "kind": "pixel", "parentId": None, "name": "p1", "visible": True, "opacity": 1,
                                                 "blend": "normal", "x": 0, "y": 0, "sx": 1, "sy": 1, "rot": 0, "kx": 0, "ky": 0, "effects": [],
                                                 "surfaceW": DW, "surfaceH": DH, "slot": 1, "mask": None, "adjustment": None}]})
    n0 = len(v.frames(c))
    for i in range(3):
        v.out(10 + i)
        v.pump(2)
    fr = v.frames(c)
    assert len(fr) >= n0 + 3
    assert bytes(fr[0][1]["alpha"]) == b"\xff\xd8" + bytes([90]) + b"\xff\xd9"
    ids = [d["frameId"] for _, d, _ in fr]
    assert ids == sorted(set(ids))


def test_applied_frame_id_is_the_clients_newest_uploaded_surface():
    v = V()
    c = v.connect()
    v.view(c, "fast")
    v.out(1)
    v.pump(3)
    v.env.send(c, {"t": "doc", "rev": 1, "layers": [{"id": "p1", "kind": "pixel", "parentId": None, "name": "p1", "visible": True, "opacity": 1,
                                                 "blend": "normal", "x": 0, "y": 0, "sx": 1, "sy": 1, "rot": 0, "kx": 0, "ky": 0, "effects": [],
                                                 "surfaceW": DW, "surfaceH": DH, "slot": 1, "mask": None, "adjustment": None}]})
    v.env.pump()
    v.env.surface(c, 1, (0, 0, 8, 8), np.zeros((8, 8, 4), np.uint8), frame_id=4242, dw=DW, dh=DH)
    v.out(2)
    v.pump(3)
    assert v.frames(c)[-1][1]["applied"] == 4242


def test_in_flight_limit_two_and_newest_wins():
    v = V()
    c = v.connect()
    v.view(c, "fast")
    for i in range(10):
        v.out(i)
        v.pump(1, ack=False)
    assert len(v.frames(c)) == 2                          # the third is not even captured while two are pending
    caps = len(v.captures)
    v.out(99)
    v.pump(3, ack=False)
    assert len(v.captures) == caps
    first = v.frames(c)[0][1]["frameId"]
    v.env.send(c, {"t": "viewAck", "frameId": first})
    v.pump(1, ack=False)
    assert len(v.frames(c)) == 3 and len(v.captures) == caps + 1   # one captured AFTER the ack, from the newest output
    v.env.send(c, {"t": "viewAck", "frameId": 123456})              # an unknown ack changes nothing
    v.pump(2, ack=False)
    assert len(v.frames(c)) == 3


def test_a_client_that_never_acked_gets_one_small_frame_and_no_inline_exact():
    v = V()
    sizes = []
    v.x._encode_jpeg = lambda arr, q: sizes.append(q) or b"\xff\xd8" + b"\xff\xd9"
    c = v.connect(acked=False)
    v.view(c, "auto")
    for i in range(6):
        v.out(i)
        v.pump(1, ack=False)
    assert len(v.frames(c, "fast")) == 1 and sizes[0] == E.FAST_Q_MIN     # one frame in flight, lowest quality
    v.env.send(c, {"t": "viewAck", "frameId": v.frames(c)[0][1]["frameId"]})
    for i in range(6):
        v.out(10 + i)
        v.pump(1, ack=False)
    assert len(v.frames(c, "fast")) >= 2 and sizes[-1] == E.FAST_Q_DEFAULT


def test_first_exact_frame_of_an_unacknowledged_client_is_fetched_not_pushed():
    v = V()
    c = v.connect(acked=False)
    v.view(c, "exact")
    v.out(1)
    v.pump(25, ack=False)
    assert v.frames(c) == [] and len(v.env.s.messages(c, "viewExact")) == 1


def test_lost_acks_expire_and_the_client_shows_as_stalled(capsys):
    v = V()
    c = v.connect()
    v.view(c, "fast")
    n = 0
    for i in range(400):
        v.out(i)
        v.pump(1, ack=False)
    cl = v.x.clients[c]
    assert cl.view.stalled and "1 stalled" in v.env.o.par.Status.eval()
    assert len(v.frames(c)) > 2          # un-acked frames expire (VIEW_ACK_TIMEOUT_S) so a lost ack does not freeze the stream
    assert len(v.frames(c)) < 20         # ... but a dead client only gets a trickle
    assert "acknowledged" in capsys.readouterr().out
    v.ack_all(c)
    assert not cl.view.stalled


def test_auto_fast_while_changing_then_one_exact_after_idle_and_nothing_more():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    for i in range(8):
        arr = v.out(i)
        v.pump(1)
    assert v.frames(c, "exact") == []                    # still changing
    nfast = len(v.frames(c, "fast"))
    assert nfast >= 5
    v.pump(25)
    ex = v.frames(c, "exact")
    assert len(ex) == 1
    d = ex[0][1]
    assert d["kind"] == 0 and (d["docW"], d["docH"]) == (DW, DH)
    buf = apply_exact(None, d)
    assert (buf == want_wire(arr)).all()                 # straight alpha, wire order, the last output
    v.pump(40)
    assert len(v.frames(c, "exact")) == 1 and len(v.frames(c, "fast")) == nfast


def test_auto_exact_comes_about_200_ms_after_the_last_change():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(2)
    t0 = v.env.clock.t
    t_exact = None
    for _ in range(60):
        v.pump(1)
        if v.frames(c, "exact"):
            t_exact = v.env.clock.t
            break
    assert t_exact is not None and 0.15 <= t_exact - t0 <= 0.6


def test_fast_frame_waits_for_the_idle_timer_before_exact_even_with_a_pending_ack():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(1, ack=False)
    assert len(v.frames(c, "fast")) == 1
    v.pump(30, ack=False)                         # never acked: exact waits for the ack (in-flight must be empty)
    assert v.frames(c, "exact") == []
    v.ack_all(c)
    v.pump(3)
    assert len(v.frames(c, "exact")) == 1


def test_tile_refine_sends_only_changed_tiles_and_matches_the_output():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    arr = v.out(1)
    v.pump(25)
    buf = apply_exact(None, v.frames(c, "exact")[0][1])
    full_size = len(v.frames(c, "exact")[0][2])
    arr = arr.copy()
    arr[0:10, 0:10] = np.random.RandomState(5).rand(10, 10, 4).astype(np.float32)
    arr[..., 3] = 1.0
    v.env.o.net.out.set_image(arr)
    v.pump(25)
    ex = v.frames(c, "exact")
    assert len(ex) == 2
    d = ex[1][1]
    assert d["kind"] == 1 and d["nTiles"] == 1            # rows 0..9 of the OUTPUT are the bottom of the wire image: wire row DH-1 ... tile (3, 0)
    assert len(ex[1][2]) < 0.2 * full_size
    buf = apply_exact(buf, d)
    assert (buf == want_wire(arr)).all()


def test_more_than_30_percent_changed_sends_a_full_frame():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(25)
    arr = v.out(2)     # everything changed
    v.pump(25)
    ex = v.frames(c, "exact")
    assert [f[1]["kind"] for f in ex] == [0, 0]


def test_viewport_change_in_auto_goes_fast_then_confirms_with_an_empty_exact_frame():
    v = V()
    c = v.connect()
    v.view(c, "auto", {"x": 0, "y": 0, "w": DW, "h": DH, "scale": 1})
    v.out(1)
    v.pump(25)
    assert len(v.frames(c, "exact")) == 1 and len(v.frames(c, "fast")) == 1
    v.view(c, "auto", {"x": 50, "y": 40, "w": 100, "h": 60, "scale": 1})
    v.pump(3)
    assert len(v.frames(c, "fast")) == 2 and v.frames(c, "fast")[1][1]["rect"] == (50.0, 40.0, 100.0, 60.0)
    v.pump(25)
    ex = v.frames(c, "exact")
    assert len(ex) == 2 and ex[1][1]["kind"] == 1 and ex[1][1]["nTiles"] == 0   # "your exact buffer is current"
    buf = apply_exact(apply_exact(None, ex[0][1]), ex[1][1])
    assert buf.shape == (DH, DW, 4)


def test_empty_exact_fixture_and_burst_with_unchanged_result_confirms_exact():
    d = P.decode_view_exact(fixture("view_exact_empty"))
    assert (d["kind"], d["nTiles"]) == (1, 0) and zlib.decompress(d["body"]) == b""
    buf = np.zeros((66, 70, 4), np.uint8)
    assert (F.decode_exact_body(d["body"], 70, 66, 1, 0, buf.copy()) == buf).all()
    v = V()
    c = v.connect()
    v.view(c, "auto")
    arr = v.out(1)
    v.pump(25)
    for _ in range(4):                       # a fast burst that ends on identical pixels
        v.out(2)
        v.pump(1)
    v.env.o.net.out.set_image(arr)
    v.pump(30)
    ex = v.frames(c, "exact")
    assert len(ex) == 2 and ex[1][1]["kind"] == 1 and ex[1][1]["nTiles"] == 0


def test_exact_only_sends_no_fast_frames_and_rate_limits():
    v = V()
    c = v.connect()
    v.view(c, "exact")
    for i in range(30):
        v.out(i)
        v.pump(1)
    assert v.frames(c, "fast") == [] and v.chains == []
    ex = v.frames(c, "exact")
    assert 2 <= len(ex) <= 12                              # not every tick (VIEW_EXACT_PERIOD_S), but it keeps up
    v.pump(25)
    arr = v.out(77)
    v.pump(25)
    last = apply_exact(None, v.frames(c, "exact")[-1][1]) if v.frames(c, "exact")[-1][1]["kind"] == 0 else None
    assert last is None or (last == want_wire(arr)).all()


def test_exact_only_final_picture_is_exact():
    v = V()
    c = v.connect()
    v.view(c, "exact")
    buf = None
    for i in range(5):
        arr = v.out(i)
        v.pump(2)
    v.pump(30)
    for _, d, _ in v.frames(c, "exact"):
        buf = apply_exact(buf, d)
    assert (buf == want_wire(arr)).all()


def test_reset_forces_a_full_frame_even_without_changes():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(25)
    assert len(v.frames(c, "exact")) == 1
    v.env.send(c, {"t": "viewExactReset"})
    v.pump(10)
    ex = v.frames(c, "exact")
    assert len(ex) == 2 and ex[1][1]["kind"] == 0


def test_canvas_resize_sends_a_full_frame_of_the_new_size():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(25)
    v.env.o.par.Docw.val, v.env.o.par.Doch.val = 120, 90
    arr = np.random.RandomState(9).rand(90, 120, 4).astype(np.float32)
    arr[..., 3] = 1.0
    v.env.o.net.out.set_image(arr)
    v.pump(30)
    ex = v.frames(c, "exact")
    assert (ex[-1][1]["docW"], ex[-1][1]["docH"]) == (120, 90) and ex[-1][1]["kind"] == 0


def test_large_exact_frames_are_announced_and_fetched_over_http(monkeypatch):
    monkeypatch.setattr(P, "MAX_EXACT_INLINE", 100)
    v = V()
    c = v.connect()
    v.view(c, "exact")
    v.out(3)
    v.pump(25)
    assert v.frames(c, "exact") == []
    (n,) = v.env.s.messages(c, "viewExact")
    cid = v.x.clients[c].cid
    r = v.env.get("/view", client=cid, exact=1, frameId=n["frameId"])
    assert r["statusCode"] == 200 and len(r["data"]) == n["size"]
    d = P.decode_view_exact(r["data"])
    assert d["frameId"] == n["frameId"] and (apply_exact(None, d) == want_wire(v.env.o.net.out.array)).all()
    assert v.env.get("/view", client=cid, exact=1, frameId=n["frameId"] + 1)["statusCode"] == 404
    assert v.env.get("/view", client=cid)["statusCode"] == 404              # v11 clients never use the v3 GET /view
    v.env.send(c, {"t": "viewAck", "frameId": n["frameId"]})
    assert v.env.get("/view", client=cid, exact=1, frameId=n["frameId"])["statusCode"] == 404
    assert v.env.get("/view", client="nobody", exact=1, frameId=1)["statusCode"] == 404
    assert v.env.get("/view", token="bad", client=cid, exact=1)["statusCode"] == 403


def test_unsubscribe_and_disconnect_destroy_the_gpu_nodes_and_stop_the_stream():
    v = V()
    a, b = v.connect(), v.connect()
    v.view(a, "fast")
    v.view(b, "auto")
    v.out(1)
    v.pump(3)
    assert len(v.chains) == 2 and v.destroyed == []
    v.view(a, mode="local")
    v.pump(2)
    assert v.destroyed == [0]
    n = len(v.frames(a))
    v.out(2)
    v.pump(5)
    assert len(v.frames(a)) == n and len(v.frames(b)) > 1
    v.env.x.OnWebSocketClose(b)
    v.pump(2)
    assert sorted(v.destroyed) == [0, 1] and not v.x._vchains
    assert v.x.vx.msg is None and v.x._vx_frame is None


def test_fast_clients_get_their_own_viewport_chain_and_counter_and_independent_acks():
    v = V()
    a, b = v.connect(), v.connect()
    v.view(a, "fast", {"x": 0, "y": 0, "w": 100, "h": 50, "scale": 1})
    v.view(b, "fast", {"x": 100, "y": 100, "w": 50, "h": 25, "scale": 1})
    v.out(1)
    v.pump(3, ack=False)
    fa, fb = v.frames(a)[0][1], v.frames(b)[0][1]
    assert fa["rect"] == (0.0, 0.0, 100.0, 50.0) and fb["rect"] == (100.0, 100.0, 50.0, 25.0)
    assert fa["frameId"] == fb["frameId"] == 1
    v.env.send(a, {"t": "viewAck", "frameId": 1})
    for i in range(6):
        v.out(10 + i)
        v.pump(1, ack=False)
    assert len(v.frames(a)) > len(v.frames(b)) == 2


def test_more_clients_than_chains_fall_back_to_exact_only():
    v = V()
    cs = [v.connect() for _ in range(E.VIEW_MAX_CHAINS + 1)]
    for c in cs:
        v.view(c, "auto")
    v.out(1)
    v.pump(30)
    assert len(v.chains) == E.VIEW_MAX_CHAINS
    assert len(v.frames(cs[-1], "fast")) == 0 and len(v.frames(cs[-1], "exact")) == 1


def test_no_cv2_means_exact_frames_only():
    v = V()
    v.x._get_cv2 = lambda: False
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(30)
    assert v.frames(c, "fast") == [] and len(v.frames(c, "exact")) == 1 and v.chains == []


def test_protocol_10_clients_keep_the_v3_notice_path_and_get_no_binary():
    v = V()
    old = v.connect(10)
    new = v.connect(11)
    v.env.send(old, {"t": "view", "mode": "td", "zoom": 1.0, "panX": 0.0, "panY": 0.0, "rect": {"x": 0, "y": 0, "w": 100, "h": 100}})
    v.view(new, "fast")
    v.out(1)
    v.pump(30)
    assert v.env.s.messages(old, "view") and v.env.view_frames[old][0][0].type == P.TYPE_VIEW
    assert v.frames(old) == [] and v.frames(new)
    assert v.env.s.messages(new, "view") == []
    assert v.x._view_subscribers() == [v.x.clients[old]] and v.x._view11_subscribers() == [v.x.clients[new]]
    assert v.env.get("/view", client=v.x.clients[old].cid)["statusCode"] == 200


def test_bad_v11_view_message_is_an_error_and_viewmode_mirrors():
    v = V()
    c = v.connect()
    v.env.send(c, {"t": "view", "mode": "td", "quality": "ultra"})
    assert v.env.s.messages(c, "error")
    v.view(c, "fast")
    assert v.env.o.par.Viewmode.eval() == "td"
    v.view(c, mode="local")
    assert v.env.o.par.Viewmode.eval() == "local"
    v.env.send(c, {"t": "viewAck", "frameId": -3})
    assert len(v.env.s.messages(c, "error")) == 2


def test_two_clients_exact_share_the_work_but_keep_their_own_previous_frames():
    v = V()
    a = v.connect()
    v.view(a, "auto")
    arr = v.out(1)
    v.pump(25)
    b = v.connect()          # joins later: gets a full frame, a keeps getting tile diffs
    v.view(b, "auto")
    v.pump(25)
    assert [f[1]["kind"] for f in v.frames(b, "exact")] == [0]
    arr = arr.copy()
    arr[0:5, 0:5, :3] = 0.25
    v.env.o.net.out.set_image(arr)
    v.pump(25)
    assert v.frames(a, "exact")[-1][1]["kind"] == 1 and v.frames(b, "exact")[-1][1]["kind"] == 1
    bufa = bufb = None
    for _, d, _ in v.frames(a, "exact"):
        bufa = apply_exact(bufa, d)
    for _, d, _ in v.frames(b, "exact"):
        bufb = apply_exact(bufb, d)
    assert (bufa == bufb).all() and (bufa == want_wire(arr)).all()


def test_exact_frames_are_encoded_in_a_worker_thread_when_not_inline():
    v = V()
    v.x._sync_view_workers = False
    c = v.connect()
    v.view(c, "exact")
    arr = v.out(1)
    import time
    for _ in range(60):
        v.pump(1)
        if v.frames(c, "exact"):
            break
        time.sleep(0.01)
    ex = v.frames(c, "exact")
    assert ex and (apply_exact(None, ex[0][1]) == want_wire(arr)).all()
    assert v.x._vx_pool is not None
    v.x._drop_all_vchains()
    assert v.x._vx_pool is None


def test_status_mentions_the_cook_rate_only_below_45_fps():
    v = V()
    c = v.connect()
    v.view(c, "fast")
    v.x._cook_rate = lambda: 30.0
    v.x._status_at = 0.0
    v.pump(2)
    assert "td-view" in v.env.o.par.Status.eval() and "30 fps cook rate" in v.env.o.par.Status.eval()
    v.x._cook_rate = lambda: 60.0
    v.x._status_at = 0.0
    v.pump(2)
    assert "cook rate" not in v.env.o.par.Status.eval()


def test_the_stream_never_changes_the_projects_cook_rate_or_timeline():
    import inspect
    src = inspect.getsource(E)
    assert "cookRate =" not in src.replace("float(project.cookRate)", "") and "time.play" not in src


def test_fast_geometry_clamps():
    v = V()
    x = v.x
    c = v.connect()
    cl = x.clients[c]
    cl.vp = None
    assert x._fast_geometry(cl) == ((0, 0, DW, DH), DW, DH)
    cl.vp = {"x": -50.0, "y": -20.0, "w": 80.0, "h": 40.0, "scale": 1.0}      # partly outside: clipped to the document
    assert x._fast_geometry(cl)[0] == (0, 0, 30, 20)
    cl.vp = {"x": 500.0, "y": 500.0, "w": 10.0, "h": 10.0, "scale": 1.0}      # entirely outside: the whole document
    assert x._fast_geometry(cl)[0] == (0, 0, DW, DH)
    cl.vp = {"x": 0.0, "y": 0.0, "w": 100.0, "h": 50.0, "scale": 0.25}        # zoomed out: fewer pixels
    assert x._fast_geometry(cl) == ((0, 0, 100, 50), 25, 13)
    cl.vp = {"x": 0.0, "y": 0.0, "w": 100.0, "h": 50.0, "scale": 10.0}        # zoomed in: never more than the document has
    assert x._fast_geometry(cl)[1:] == (100, 50)
    x.doc_w, x.doc_h = 8000, 6000
    cl.vp = {"x": 0.0, "y": 0.0, "w": 8000.0, "h": 6000.0, "scale": 1.0}
    (_, pw, ph) = x._fast_geometry(cl)
    assert pw * ph <= E.FAST_MAX_PIXELS and abs(pw / ph - 4 / 3) < 0.01


def test_jpeg_quality_adapts_to_the_frame_size():
    v = V()
    c = v.connect()
    big = {"n": 0}

    def enc(arr, q):
        big["n"] += 1
        return b"\xff\xd8" + bytes(E.FAST_BYTES_BUDGET + 10 if big["n"] <= 6 else 10) + b"\xff\xd9"
    v.x._encode_jpeg = enc
    v.view(c, "fast")
    for i in range(10):
        v.out(i)
        v.pump(1)
    assert v.x.clients[c].v_q < E.FAST_Q_DEFAULT
    qmin = v.x.clients[c].v_q
    for i in range(30):
        v.out(50 + i)
        v.pump(1)
    assert v.x.clients[c].v_q > qmin and E.FAST_Q_MIN <= qmin


def test_premultiplied_toggle_resends_everything():
    v = V()
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    v.pump(25)
    nf, ne = len(v.frames(c, "fast")), len(v.frames(c, "exact"))
    v.env.o.par.Premultiplied.val = 0
    v.x.OnParChange(v.env.o.par.Premultiplied)
    v.pump(30)
    assert len(v.frames(c, "fast")) == nf + 1                     # the picture is encoded differently now: sent again
    ex = v.frames(c, "exact")
    assert len(ex) == ne + 1 and ex[-1][1]["kind"] in (0, 1)


# ----------------------------------------------------------------------------- several editors through the master router

def test_a_slave_editor_streams_independently_through_the_masters_server():
    p = Project(2)
    m, s = p.envs
    vm, vs = V(m), V(s)
    ca = ws_connect(m, m)
    cb = ws_connect(m, s)
    for cid, ed in ((ca, m), (cb, s)):
        m.x.OnWebSocketText(cid, json.dumps({"t": "view", "mode": "td", "quality": "fast", "viewport": {"x": 0, "y": 0, "w": 64, "h": 32, "scale": 1}}))
    assert not vs.chains                      # nothing is created before the slave has output to show
    for env in (m, s):
        set_output(env, 3, w=64, h=32, alpha=1.0)
    for _ in range(6):
        m.pump()
        s.pump()
    frames_a = [b for c, b in m.s.binaries if c == ca]
    frames_b = [b for c, b in m.s.binaries if c == cb]
    assert frames_a and frames_b                                  # both ride the master's server DAT
    assert len(vm.chains) == 1 and len(vs.chains) == 1             # one GPU chain per subscribed editor
    assert all(P.decode_frame(b)[0].type == P.TYPE_VIEW_FAST for b in frames_a + frames_b)
    # an editor without a subscriber has no nodes and sends nothing
    set_output(s, 4, w=64, h=32, alpha=1.0)
    m.x.OnWebSocketText(cb, json.dumps({"t": "view", "mode": "local"}))
    n = len(frames_a)
    for _ in range(6):
        s.pump()
        m.pump()
    assert vs.destroyed == [0] and len([1 for c, b in m.s.binaries if c == cb]) == len(frames_b)
    assert len([1 for c, b in m.s.binaries if c == ca]) >= n


# ----------------------------------------------------------------------------- review fixes

class HeldPool:
    """A worker pool that runs a job only when the test says so."""

    def __init__(self):
        self.jobs = []

    def submit(self, fn, job):
        self.jobs.append((fn, job))

    def shutdown(self, wait=False):
        pass

    def run(self):
        fn, job = self.jobs.pop(0)
        fn(job)


def held(v):
    v.x._sync_view_workers = False
    v.x._vx_pool = HeldPool()
    return v.x._vx_pool


def run_until_job(v, pool, ack=True):
    for _ in range(60):
        v.pump(1, ack=ack)
        if pool.jobs:
            return True
    return False


def test_stale_exact_result_is_dropped_after_a_newer_fast_frame_or_output_change():
    v = V()
    pool = held(v)
    c = v.connect()
    v.view(c, "auto")
    v.out(1)
    assert run_until_job(v, pool)
    v.out(2)                       # the output changes while the worker runs -> a fast frame goes out
    v.pump(3)
    pool.run()
    v.pump(3)
    assert v.frames(c, "exact") == []                     # the old picture is never sent after the newer fast frame
    arr = v.env.o.net.out.array
    assert run_until_job(v, pool)
    pool.run()
    v.pump(3)
    ex = v.frames(c, "exact")
    assert len(ex) == 1 and (apply_exact(None, ex[0][1]) == want_wire(arr)).all()


def test_exact_result_for_the_old_canvas_size_is_dropped_and_headers_use_the_buffer_size():
    v = V()
    pool = held(v)
    c = v.connect()
    v.view(c, "exact")
    v.out(1)
    assert run_until_job(v, pool)
    v.env.o.par.Docw.val, v.env.o.par.Doch.val = 120, 90
    v.pump(2)
    pool.run()
    v.pump(2)
    assert v.frames(c, "exact") == []
    arr = np.random.RandomState(4).rand(90, 120, 4).astype(np.float32)
    arr[..., 3] = 1.0
    v.env.o.net.out.set_image(arr)
    assert run_until_job(v, pool)
    pool.run()
    v.pump(3)
    d = v.frames(c, "exact")[0][1]
    assert (d["docW"], d["docH"]) == (120, 90)


def test_hostile_viewports_are_clamped_by_the_parser_and_the_geometry():
    for vp in ({"x": 1e308, "y": -1e308, "w": 1.7e308, "h": 1e308, "scale": 1e308}, {"x": 0, "y": 0, "w": 10 ** 400, "h": 5, "scale": 1}):
        try:
            got = P.parse_view11({"mode": "td", "viewport": vp})["viewport"]
        except P.ProtocolError:
            continue
        assert abs(got["x"]) <= 1e7 and got["w"] <= 1e6 and 1e-3 <= got["scale"] <= 64
    for bad in (float("inf"), float("nan")):
        with pytest.raises(P.ProtocolError):
            P.parse_view11({"mode": "td", "viewport": {"x": bad, "y": 0, "w": 5, "h": 5, "scale": 1}})
    v = V()
    c = v.connect()
    cl = v.x.clients[c]
    cl.vp = {"x": 1.7e308, "y": 0.0, "w": 1.7e308, "h": 50.0, "scale": 1e308}     # even if one got past the parser
    region, pw, ph = v.x._fast_geometry(cl)
    assert pw * ph <= E.FAST_MAX_PIXELS and pw >= 1
    cl.vp = {"x": 0.0, "y": 0.0, "w": 1e6, "h": 1.0, "scale": 64.0}
    v.x.doc_w, v.x.doc_h = 16384, 16384
    _, pw, ph = v.x._fast_geometry(cl)
    assert 2 * pw <= E.GL_MAX_DIM and ph <= E.GL_MAX_DIM


def test_one_clients_failure_does_not_starve_the_others_and_backs_off():
    v = V()
    a, b = v.connect(), v.connect()
    for cid in (a, b):
        v.view(cid, "auto", {"x": 0, "y": 0, "w": DW, "h": DH, "scale": 1})
    calls = {"n": 0}
    real = v.x._capture_fast

    def cap(chain, pw, ph, premult):
        if v.x._vchains.get(a) is chain:
            calls["n"] += 1
            raise RuntimeError("boom")
        return real(chain, pw, ph, premult)
    v.x._capture_fast = cap
    for i in range(8):
        v.out(i)
        v.pump(1)
    assert v.frames(b, "fast")                                  # b is served
    assert calls["n"] == 1                                       # no per-tick retry for a
    v.pump(30)
    assert len(v.frames(a, "exact")) >= 1                        # a still gets its exact frame (auto -> exact only meanwhile)
    v.env.clock.advance(E.VCHAIN_BACKOFF_S + 1)
    v.out(40)
    v.pump(3)
    assert calls["n"] == 2                                       # retried after the back-off


def test_chain_creation_failure_backs_off_and_auto_still_gets_exact():
    v = V()
    made = {"n": 0}

    def mk(n, src):
        made["n"] += 1
        return None
    v.x._make_vchain = mk
    c = v.connect()
    v.view(c, "auto")
    for i in range(6):
        v.out(i)
        v.pump(1)
    v.pump(30)
    assert made["n"] == 1 and v.frames(c, "fast") == [] and len(v.frames(c, "exact")) >= 1


def test_premultiplied_toggle_reaches_a_live_chain_without_a_geometry_change():
    v = V()
    del v.x._set_vchain
    from faketd import Pars

    class N:
        def __init__(self):
            self.par = Pars(cropleft=0, cropright=0, cropbottom=0, croptop=0, resolutionw=0, resolutionh=0, vec0valuex=-1)
    chain = {"crop": N(), "rs": N(), "px": N(), "geom": None, "pre": None, "n": 0, "ops": []}
    v.x._set_vchain(chain, (0, 0, 10, 10), 10, 10)
    assert chain["px"].par.vec0valuex.eval() == 1.0
    v.env.o.par.Premultiplied.val = 0
    v.x._set_vchain(chain, (0, 0, 10, 10), 10, 10)
    assert chain["px"].par.vec0valuex.eval() == 0.0
    assert (chain["px"].par.resolutionw.eval(), chain["px"].par.resolutionh.eval()) == (20, 10)


def test_ack_timeout_returns_the_client_to_slow_start_with_a_full_exact_next():
    v = V()
    c = v.connect()
    v.view(c, "fast")
    v.out(1)
    v.pump(2, ack=False)
    cl = v.x.clients[c]
    cl.v_prev = np.zeros((DH, DW, 4), np.uint8)
    cl.v_acked = True
    v.env.clock.advance(E.VIEW_ACK_TIMEOUT_S + 1)
    v.pump(1, ack=False)
    assert cl.v_acked is False and cl.v_prev is None
    v.env.send(c, {"t": "viewAck", "frameId": 1})
    assert cl.v_acked is True


def test_no_subscribers_means_no_opencv_import_or_chain_work():
    v = V()
    called = []
    v.x._get_cv2 = lambda: called.append(1) or True
    v.connect()
    v.pump(5)
    assert called == []


def test_orphaned_view_nodes_are_swept_at_start():
    v = V()
    gone = []

    class O:
        def __init__(self, name):
            self.name = name

        def destroy(self):
            gone.append(self.name)
    v.env.o.children = [O("_view_crop0"), O("_view_px3"), O("_view_rs1"), O("doc"), O("_view_other")]
    v.x._sweep_view_nodes()
    assert sorted(gone) == ["_view_crop0", "_view_px3", "_view_rs1"]


def test_a_chain_whose_source_changed_is_recreated():
    v = V()
    c = v.connect()
    v.view(c, "fast")
    v.out(1)
    v.pump(3)
    assert len(v.chains) == 1
    v.chains[0]["src"] = object()        # the chain reads another TOP than the output now
    v.out(2)
    v.pump(3)
    assert len(v.chains) == 2 and v.destroyed == [0]


def test_top_down_bmp_is_rejected_and_a_size_mismatch_is_transient():
    import struct

    class T:
        def __init__(self, w, h):
            hdr = bytearray(138)
            hdr[10:14] = (138).to_bytes(4, "little")
            hdr[18:22] = w.to_bytes(4, "little")
            hdr[22:26] = struct.pack("<i", h)
            hdr[28:30] = (32).to_bytes(2, "little")
            self.data = bytes(hdr) + bytes(w * abs(h) * 4)

        def saveByteArray(self, ext):
            return self.data
    assert E.RasterEditorExt._bmp_bgra(T(4, 3), 4, 3).shape == (3, 4, 4)
    with pytest.raises(E._BmpMismatch):
        E.RasterEditorExt._bmp_bgra(T(5, 3), 4, 3)
    with pytest.raises(RuntimeError, match="top-down") as ei:
        E.RasterEditorExt._bmp_bgra(T(4, -3), 4, 3)
    assert not isinstance(ei.value, E._BmpMismatch)
