import json

import numpy as np
import pytest

import ext as E
import frames
import protocol as P
from faketd import Clock, FakeOwner, TickClock


class Env:
    def __init__(self, tick=None, **pars):
        self.o = FakeOwner(**pars)
        self.clock = TickClock(tick) if tick else Clock()
        self.x = E.RasterEditorExt(self.o)
        self.x._now = self.clock
        self.o.ext = self.x
        self.n = 0
        self.opened = []
        self.x._open_url = self.opened.append
        self.s = self.o.server

    def pump(self, n=1, dt=0.034):
        for _ in range(n):
            self.clock.advance(dt)
            self.x.Pump()

    def connect(self, kind="panel", protocol=1, ready=True, token=None):
        self.n += 1
        cid = f"127.0.0.1:{5000 + self.n}"
        self.s.webSocketConnections.append(cid)
        self.x.OnWebSocketOpen(cid, "/ws?client=" + kind)
        if ready:
            self.send(cid, {"t": "ready", "protocol": protocol, "client": kind, "version": "t", "token": token or self.x.token})
        return cid

    def send(self, cid, msg):
        self.x.OnWebSocketText(cid, json.dumps(msg))

    def composite(self, cid, rect, pixels, frame_id=1, dw=None, dh=None, end=True, max_payload=P.MAX_PAYLOAD):
        dw = dw or self.x.doc_w
        dh = dh or self.x.doc_h
        msgs = list(P.encode_frames(P.TYPE_COMPOSITE, frame_id, dw, dh, rect, pixels, max_payload))
        if not end:
            msgs = msgs[:-1]
        for m in msgs:
            self.x.OnWebSocketBinary(cid, m)
        return msgs

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
        """Decoded BASE messages sent to cid, grouped by frame id -> list of (hdr, payload)."""
        out = {}
        for c, data in self.s.binaries:
            if c == cid:
                h, p = P.decode_frame(data)
                out.setdefault(h.frame_id, []).append((h, bytes(p)))
        return out


@pytest.fixture
def env():
    return Env()


def wire_img(w, h, seed=0, alpha=255):
    a = np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)
    a[..., 3] = alpha
    return a


# ----------------------------------------------------------------------------- HTTP

def req(method="GET", uri="/", data=b"", token=None, **extra):
    r = {"method": method, "uri": uri, "data": data, "clientAddress": "127.0.0.1:5000", "Host": "127.0.0.1:9980",
         "pars": {} if token is None else {"token": token}}
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
    env.o.par.Panelquery.val = "test=1"
    assert post()["statusCode"] == 404  # no token
    assert post(token="wrong")["statusCode"] == 404
    assert post(token=env.x.token)["statusCode"] == 204
    assert env.x.test_result == '{"x":1}'


# ----------------------------------------------------------------------------- clients

def test_first_client_becomes_active_and_gets_hello(env):
    env.pump()
    a = env.connect("external")
    (hello,) = env.s.messages(a, "hello")
    assert hello["protocol"] == 1 and hello["active"] is True and hello["hasInput"] is False
    assert hello["doc"] == {"w": 64, "h": 32} and hello["maxSendFps"] == 30


def test_second_client_is_standby(env):
    env.pump()
    a = env.connect("external")
    b = env.connect("external")
    assert env.s.messages(b, "hello")[0]["active"] is False
    assert env.x.active_id == a


def test_panel_takes_priority_on_first_connect_after_start(env):
    env.pump()
    ext_c = env.connect("external")
    panel = env.connect("panel")
    assert env.x.active_id == panel
    assert env.s.messages(ext_c, "active")[-1]["active"] is False
    assert env.s.messages(panel, "hello")[0]["active"] is True


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


def test_composite_from_standby_is_ignored_then_accepted_after_takeover(env):
    env.pump()
    a = env.connect("panel")
    b = env.connect("external")
    img = wire_img(64, 32, 1)
    env.composite(b, (0, 0, 64, 32), img)
    assert not env.x.dirty and not env.x.got_composite
    env.send(b, {"t": "takeover"})
    env.composite(b, (0, 0, 64, 32), img)
    assert env.x.got_composite
    env.composite(a, (0, 0, 64, 32), img)  # a is standby now: ignored (no state change)


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
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    assert not env.x.got_composite


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


# ----------------------------------------------------------------------------- composite path

def test_composite_flows_into_td_order_premultiplied_buffer_and_script_top(env):
    env.pump()
    a = env.connect("panel")
    img = wire_img(64, 32, 2, alpha=255)
    img[0, 0] = (10, 20, 30, 255)
    img[31, 63] = (1, 2, 3, 128)
    env.composite(a, (0, 0, 64, 32), img)
    assert env.x.dirty
    env.pump()
    up = env.o.composite.uploaded
    assert up is not None and up.shape == (32, 64, 4) and up.dtype == np.uint8
    assert up[31, 0].tolist() == [10, 20, 30, 255]  # wire top-left -> TD top row (last)
    assert up[0, 63].tolist() == [1, 1, 2, 128]  # premultiplied: round(c * 128 / 255)
    assert not env.x.dirty
    assert env.o.switch.par.index.eval() == 1


def test_premultiplied_off_keeps_straight(env):
    e = Env(Premultiplied=0)
    e.pump()
    a = e.connect("panel")
    img = wire_img(64, 32, 4, alpha=100)
    e.composite(a, (0, 0, 64, 32), img)
    e.pump()
    assert (e.o.composite.uploaded == img[::-1]).all()


def test_band_without_frame_end_is_not_published(env):
    env.pump()
    a = env.connect("panel")
    img = wire_img(64, 32, 5)
    env.composite(a, (0, 0, 64, 32), img, max_payload=64 * 4 * 8, end=False)  # 3 of 4 bands
    env.pump()
    assert not env.x.got_composite and env.o.composite.cooks == 1  # only the initial blank push
    # pixels were written already
    assert env.x.buffer[env.x.doc_h - 1].any()


def test_multiband_frame_publishes_once_at_end(env):
    env.pump()
    a = env.connect("panel")
    img = wire_img(64, 32, 6, alpha=255)
    cooks = env.o.composite.cooks
    env.composite(a, (0, 0, 64, 32), img, max_payload=64 * 4 * 8)
    env.pump()
    assert env.o.composite.cooks == cooks + 1  # coalesced: one cook for four bands
    assert (env.o.composite.uploaded == img[::-1]).all()


def test_partial_rect_composite_only_touches_rect(env):
    env.pump()
    a = env.connect("panel")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32, 1, 255))
    before = env.x.buffer.copy()
    patch = wire_img(10, 6, 2, 255)
    env.composite(a, (20, 5, 10, 6), patch, frame_id=2)
    changed = (env.x.buffer != before).any(axis=2)
    ys, xs = np.nonzero(changed)
    assert xs.min() >= 20 and xs.max() < 30 and ys.min() >= 32 - 11 and ys.max() < 32 - 5


def test_wrong_doc_size_dropped_silently(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.composite(a, (0, 0, 32, 16), wire_img(32, 16), dw=32, dh=16)
    assert not env.x.got_composite and not env.x.dirty
    assert capsys.readouterr().out == ""


def test_invalid_frames_dropped_and_logged_once_per_frame_id(env, capsys):
    env.pump()
    a = env.connect("panel")
    good = P.encode_message(P.Header(P.TYPE_COMPOSITE, 1, 7, 64, 32, 0, 0, 2, 2), bytes(16))
    bad = good[:-1]
    for _ in range(3):
        env.x.OnWebSocketBinary(a, bad)
    out = capsys.readouterr().out
    assert out.count("dropped invalid frame") == 1
    env.x.OnWebSocketBinary(a, b"junk" * 10)
    env.x.OnWebSocketBinary(a, b"x")
    assert not env.x.got_composite
    env.pump()
    assert "ERROR invalid frame" in env.o.par.Status.eval()


def test_base_type_frame_from_web_is_ignored(env):
    env.pump()
    a = env.connect("panel")
    m = P.encode_message(P.Header(P.TYPE_BASE, 1, 1, 64, 32, 0, 0, 64, 32), bytes(64 * 32 * 4))
    env.x.OnWebSocketBinary(a, m)
    assert not env.x.got_composite


def test_out_switch_passthrough_until_composite_when_input_present(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    assert env.o.switch.par.index.eval() == 0
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.pump()
    assert env.o.switch.par.index.eval() == 1


def test_no_input_output_is_composite_buffer_at_doc_size(env):
    env.pump()
    assert env.o.switch.par.index.eval() == 1
    assert env.o.composite.uploaded.shape == (32, 64, 4)


def test_disconnect_keeps_last_composite(env):
    env.pump()
    a = env.connect("panel")
    img = wire_img(64, 32, 8, 255)
    env.composite(a, (0, 0, 64, 32), img)
    env.pump()
    env.x.OnWebSocketClose(a)
    env.pump(3)
    assert (env.o.composite.uploaded == img[::-1]).all() and env.o.switch.par.index.eval() == 1


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


def test_large_input_bands_split_under_2mb_and_sent_one_band_per_pump():
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env = Env(tick=0.002)  # every clock read costs 0.5 ms, so conversion hits its budget
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    a = env.connect("panel")
    counts, converts = [], []
    for _ in range(80):
        before, cv = len(env.s.binaries), len(env.x.stats["convert"])
        env.pump()
        counts.append(len(env.s.binaries) - before)
        converts.append(len(env.x.stats["convert"]) - cv)
    msgs = [P.decode_frame(d)[0] for c, d in env.s.binaries if c == a]
    assert len(msgs) == 4 and msgs[-1].frame_end
    assert all(h.payload_size <= P.MAX_PAYLOAD for h in msgs)
    assert sum(h.h for h in msgs) == 1080
    assert max(counts) <= 1  # one ~2 MB band per pump
    assert sum(converts) >= 3  # the conversion was spread over several pumps (budget resume)


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
    assert 5 <= got <= 21  # ~2 s * 10 fps, plus slack for the 2-step readback
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
    assert len(env.bases(a)) == 2


def test_request_base_without_input_is_noop(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "requestBase"})
    env.pump(5)
    assert not env.s.binaries


def test_frame_ids_increase_between_base_frames(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.send(a, {"t": "requestBase"})
    env.pump(5)
    assert sorted(env.bases(a)) == sorted(set(env.bases(a))) and len(env.bases(a)) == 2


def test_input_resize_sends_docsize_then_new_base_and_drops_old_size_composites(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    assert env.x.got_composite
    env.set_input(80, 40, 2)
    env.pump()
    (ds,) = env.s.messages(a, "docSize")
    assert ds == {"t": "docSize", "w": 80, "h": 40, "hasInput": True}
    assert env.x.buffer.shape == (40, 80, 4) and not env.x.got_composite
    assert env.o.switch.par.index.eval() == 0  # passthrough until the editor answers
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32), dw=64, dh=32)  # in-flight stale composite
    assert not env.x.got_composite
    env.pump(30)
    last = list(env.bases(a).values())[-1]
    assert (last[0][0].doc_w, last[0][0].doc_h) == (80, 40)
    # the buffer was re-uploaded at the new size
    assert env.o.composite.uploaded.shape == (40, 80, 4)


def test_input_disconnect_returns_to_doc_par_size(env):
    env.set_input(80, 40)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.o.inputs = []
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.has_input) == (64, 32, False)
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 64, "h": 32, "hasInput": False}
    assert env.o.composite.uploaded.shape == (32, 64, 4)
    assert env.o.switch.par.index.eval() == 1


def test_doc_par_change_without_input_resizes(env):
    env.pump()
    a = env.connect("panel")
    env.o.par.Docw.val = 100
    env.o.par.Doch.val = 50
    env.pump()
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 100, "h": 50, "hasInput": False}
    env.o.par.Docw.val = 101  # change when an input is connected must be ignored
    env.o.inputs = [object()]
    env.set_input(10, 10)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (10, 10)


def test_old_size_readback_dropped_after_resize(env):
    env.set_input(64, 32)
    env.pump()
    env.connect("panel")
    env.pump(1)
    env.set_input(16, 16, 4)
    env.pump(40)
    for c, d in env.s.binaries:
        h, _ = P.decode_frame(d)
        assert (h.doc_w, h.doc_h) in ((64, 32), (16, 16))
    last = P.decode_frame(env.s.binaries[-1][1])[0]
    assert (last.doc_w, last.doc_h) == (16, 16)


# ----------------------------------------------------------------------------- mouse / keyboard

class PV:
    def __init__(self, name, val):
        self.name, self.val = name, val


def test_mouse_forwarded_unchanged_bottom_left_origin(env):
    p = env.o.panel
    p.u.val, p.v.val = 0.25, 0.8
    env.x.OnPanelValue(PV("u", 0.25))
    env.x.OnPanelValue(PV("lselect", 1), 1)
    env.x.OnPanelValue(PV("lselect", 0), 0)
    mouse = env.o.webrender.mouse
    assert mouse[0][:2] == (0.25, 0.8)  # v is NOT flipped
    assert mouse[0][2] == dict(left=False, middle=False, right=False)
    assert mouse[1][2]["left"] is True and mouse[2][2]["left"] is False


def test_fast_click_within_one_frame_still_sends_press_then_release(env):
    # the panel's current lselect value is already 0 when both edge callbacks run
    env.o.panel.lselect.val = 0
    env.x.OnPanelValue(PV("lselect", 0), 1)
    env.x.OnPanelValue(PV("lselect", 0), 0)
    assert [m[2]["left"] for m in env.o.webrender.mouse] == [True, False]


def test_plain_value_change_of_a_button_is_ignored(env):
    env.x.OnPanelValue(PV("lselect", 1))
    assert not env.o.webrender.mouse


def test_drag_keeps_button_state_across_moves(env):
    env.x.OnPanelValue(PV("lselect", 1), 1)
    env.o.panel.u.val = 0.5
    env.x.OnPanelValue(PV("u", 0.5))
    assert env.o.webrender.mouse[-1][2]["left"] is True


def test_mouse_buttons_middle_right_and_wheel(env):
    env.x.OnPanelValue(PV("mselect", 1), 1)
    env.x.OnPanelValue(PV("rselect", 1), 1)
    assert env.o.webrender.mouse[-1][2] == dict(left=False, middle=True, right=True)
    n = len(env.o.webrender.mouse)
    env.x.OnPanelValue(PV("wheel", 0))
    assert len(env.o.webrender.mouse) == n
    env.x.OnPanelValue(PV("wheel", -2.0))
    assert env.o.webrender.mouse[-1][2] == {"wheel": -2.0}


class Key:
    def __init__(self, key, character="", state=True, **mods):
        self.key, self.character, self.state = key, character, state
        self.shift = mods.get("shift", False)
        self.alt = mods.get("alt", False)
        self.ctrl = mods.get("ctrl", False)
        self.cmd = mods.get("cmd", False)


def test_keyboard_forwarding(env):
    env.x.OnKey(Key("b", "b"))
    env.x.OnKey(Key("z", "z", cmd=True))
    env.x.OnKey(Key("b", "b", state=False))  # release ignored
    env.x.OnKey(Key("shift"))  # modifier alone ignored
    env.x.OnKey(Key("lctrl"))
    env.x.OnKey(Key("space", " "))
    keys = env.o.webrender.keys
    assert [k for k, _ in keys] == ["b", "z", "space"]
    assert keys[1][1] == dict(char="z", shift=False, alt=False, ctrl=False, cmd=True)
    assert keys[2][1]["char"] == " "


def test_input_events_ignored_when_inactive(env):
    env.o.par.Active.val = 0
    env.x.OnKey(Key("b", "b"))
    env.x.OnPanelValue(PV("u", 0))
    assert not env.o.webrender.keys and not env.o.webrender.mouse


# ----------------------------------------------------------------------------- lifecycle / params / status

def test_start_configures_server_and_panel(env):
    env.x.Start()
    assert env.s.par.active.val == 1 and env.s.par.port.val == 9980
    assert env.o.webrender.par.url.val == f"http://127.0.0.1:9980/?client=panel&token={env.x.token}"
    env.pump(30)  # reload scheduled shortly after start
    assert env.o.webrender.par.reloadsrc.pulses == 1


def test_pump_starts_extension_lazily():
    e = Env()
    assert not e.x._started
    e.pump()
    assert e.x._started and e.s.par.active.val == 1


def test_devurl_and_panelquery(env):
    env.o.par.Devurl.val = "http://localhost:5173/"
    env.o.par.Panelquery.val = "test=1"
    t = env.x.token
    assert env.x._panel_url() == f"http://localhost:5173/?ws=ws://127.0.0.1:9980/ws&client=panel&token={t}&test=1"
    env.o.par.Devurl.val = "http://localhost:5173/?a=1"
    assert env.x._panel_url().startswith("http://localhost:5173/?a=1&ws=")
    env.o.par.Devurl.val = ""
    assert env.x._panel_url() == f"http://127.0.0.1:9980/?client=panel&token={t}&test=1"


def test_start_closes_stale_sockets_so_clients_reconnect(env):
    env.s.webSocketConnections.extend(["old1", "old2"])
    env.x.Start()
    assert env.s.closed == ["old1", "old2"]


def test_active_off_stops_server_and_pump_is_noop(env):
    env.pump()
    a = env.connect("panel")
    env.o.par.Active.val = 0
    env.x.OnParChange(env.o.par.Active)
    assert env.s.par.active.val == 0 and env.o.webrender.par.active.val == 0
    assert not env.x.clients and a in env.s.closed
    forced = env.o.webrender.forced
    env.pump(3)
    assert env.o.webrender.forced == forced
    assert env.o.par.Status.eval() == "inactive"
    env.o.par.Active.val = 1
    env.x.OnParChange(env.o.par.Active)
    assert env.s.par.active.val == 1


def test_port_change_restarts_server(env):
    env.pump()
    env.connect("panel")
    env.o.par.Port.val = 9999
    env.x.OnParChange(env.o.par.Port)
    assert env.s.par.port.val == 9999 and env.s.par.restart.pulses == 1
    assert "9999" in env.o.webrender.par.url.val and not env.x.clients


def test_pulses(env):
    env.x.OnParChange(env.o.par.Reloadui)
    assert env.o.webrender.par.reloadsrc.pulses == 1
    env.x.OnParChange(env.o.par.Openbrowser)
    assert env.opened == [f"http://127.0.0.1:9980/?client=external&token={env.x.token}"]


def test_premultiplied_toggle_asks_active_editor_for_full_composite(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.run_until_bases(a)
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.s.messages(a, "active")[-1]["active"] is True
    env.pump(10)
    assert len(env.bases(a)) == 2  # input resent unpremultiplied


def test_webrender_forced_to_cook_only_when_nothing_pulls_it(env):
    wr = env.o.webrender
    env.pump(5)
    assert wr.forced >= 4  # never pulled -> pump keeps it alive
    forced = wr.forced
    for _ in range(5):
        wr.totalCooks += 1  # a viewer cooks it each frame
        env.pump()
    assert wr.forced == forced


def test_status_strings(env):
    env.pump()
    assert env.o.par.Status.eval().startswith("waiting for client")
    a = env.connect("panel")
    env.pump(10)
    s = env.o.par.Status.eval()
    assert s.startswith("panel active · 64×32 · 0 fps out")
    env.connect("external")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.clock.advance(0.3)
    env.pump()
    s = env.o.par.Status.eval()
    assert "1 fps out" in s and "1 standby" in s


def test_exceptions_are_contained_and_reported_once(env, capsys):
    env.pump()
    a = env.connect("panel")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.o.composite.raise_on_cook = True
    for _ in range(5):
        env.pump()  # must not raise
    out = capsys.readouterr().out
    assert out.count("Pump/cook: RuntimeError: boom") == 1
    assert "ERROR Pump/cook: RuntimeError: boom" in env.o.par.Status.eval()
    env.o.composite.raise_on_cook = False
    env.pump()
    assert env.x.dirty is False


def test_callback_exceptions_do_not_escape(env, capsys):
    env.x.OnWebSocketOpen("127.0.0.1:1", "/ws")
    env.x.protocol = None  # sabotage
    env.x.OnWebSocketText("127.0.0.1:1", "{}")
    env.x.OnWebSocketText("127.0.0.1:1", "{}")
    assert capsys.readouterr().out.count("[raster_editor] OnWebSocketText") == 1
    assert "OnWebSocketText: AttributeError" in env.x.last_error[0]


def test_stats_collected(env):
    env.pump(5)
    a = env.connect("panel")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.pump()
    st = env.x.GetStats()
    assert st["pump"]["n"] >= 6 and st["paste"]["n"] == 1 and st["cook"]["n"] >= 1


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


def test_active_off_switches_to_passthrough_and_forgets_composite(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.pump()
    assert env.o.switch.par.index.eval() == 1
    env.o.par.Active.val = 0
    env.x.OnParChange(env.o.par.Active)
    assert env.o.switch.par.index.eval() == 0 and not env.x.got_composite


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


def test_token_changes_on_every_start(env):
    t = env.x.token
    env.x.Start()
    assert env.x.token != t and len(env.x.token) >= 16


@pytest.mark.parametrize("query,enabled", [("test=1", True), ("a=1&test=1", True), ("xtest=1", False),
                                          ("test=10", False), ("test=0", False), ("", False)])
def test_backchannel_requires_exact_test_param(env, query, enabled):
    env.o.par.Panelquery.val = query
    r = env.x.OnHTTPRequest(req("POST", "/__test", b"x", token=env.x.token), {})
    assert (r["statusCode"] == 204) is enabled


def test_backchannel_body_is_capped(env):
    env.o.par.Panelquery.val = "test=1"
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


def test_byte_budget_is_shared_across_clients_round_robin():
    env = Env()
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    a, b = env.connect("panel"), env.connect("external")
    per_pump = []
    for _ in range(120):
        before = sum(len(d) for _, d in env.s.binaries)
        env.pump()
        per_pump.append(sum(len(d) for _, d in env.s.binaries) - before)
    assert max(per_pump) <= E.MAX_BYTES_PER_PUMP + P.MAX_PAYLOAD + P.HEADER_SIZE  # at most one message over budget
    for cid in (a, b):
        frames_ = env.bases(cid)
        assert len(frames_) == 1 and sum(h.h for h, _ in list(frames_.values())[0]) == 1080
    order = [c for c, _ in env.s.binaries][:4]
    assert order == [a, b, a, b]  # clients take turns


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


def test_pending_frame_that_has_not_started_is_replaced_and_a_started_one_finishes():
    env = Env()
    env.o.par.Premultiplied.val = 0
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    a = env.connect("panel")
    while len(env.s.binaries) < 1:
        env.pump()
    first = env.x._jobs[a][0]
    env.x._queue_base([a])
    env.x._queue_base([a])
    job = env.x._jobs[a]
    assert job[0] is first and job[2] is not None and job[2] is not first  # in flight kept, newest queued
    env.pump(30)
    fids = sorted(env.bases(a))
    assert len(fids) == 2 and all(env.bases(a)[f][-1][0].frame_end for f in fids)


def test_conversion_does_not_start_into_a_buffer_an_in_flight_job_reads():
    env = Env()
    env.o.par.Premultiplied.val = 0
    env.o.par.Maxinputfps.val = 120
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    a = env.connect("panel")
    for i in range(120):
        env.o.in1.set_image(big * ((i % 7) / 7 + 0.1))
        env.pump()
        for job in env.x._jobs.values():
            busy = {id(job[0].buf)} | ({id(job[2].buf)} if job[2] else set())
            conv = env.x._conv
            assert conv is None or id(conv["out"]) not in busy


def test_premultiplied_toggle_mid_conversion_restarts_it():
    env = Env(tick=0.001)
    big = np.random.RandomState(1).rand(1080, 1920, 4).astype(np.float32)
    env.o.inputs = [object()]
    env.o.in1.set_image(big)
    env.pump()
    env.connect("panel")
    for _ in range(20):
        env.pump()
        if env.x._conv is not None:
            break
    assert env.x._conv is not None
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.x._conv is None and env.x._input_pending


def test_conversion_double_buffers_and_does_not_reallocate(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32, 1)
    env.pump()
    env.connect("panel")
    seen = []
    for i in range(6):
        env.o.in1.set_image(np.random.RandomState(i).rand(32, 64, 4))
        env.pump(8)
        seen.append(id(env.x._base_wire))
    assert len(set(seen)) == 2  # two buffers alternate


def test_failed_buffer_allocation_does_not_commit_doc_size(env, monkeypatch):
    env.pump()
    a = env.connect("panel")
    env.o.par.Docw.val = 200
    monkeypatch.setattr(env.x.frames, "alloc_buffer", lambda w, h: (_ for _ in ()).throw(MemoryError("no")))
    env.pump()
    assert (env.x.doc_w, env.x.doc_h) == (64, 32) and env.x.buffer.shape == (32, 64, 4)
    assert not env.s.messages(a, "docSize")
    monkeypatch.undo()
    env.pump()
    assert env.x.doc_w == 200 and env.s.messages(a, "docSize")


def test_one_failing_pump_step_does_not_skip_the_rest(env):
    env.pump()
    a = env.connect("panel")
    env.composite(a, (0, 0, 64, 32), wire_img(64, 32))
    env.o.composite.raise_on_cook = True
    env.o.inputs = []
    env.pump()
    assert env.o.switch.par.index.eval() == 1  # the switch step still ran


def test_pointer_moves_coalesce_into_one_call_per_frame(env):
    env.pump()
    p = env.o.panel
    for i in range(5):
        p.u.val, p.v.val = 0.1 * i, 0.2
        env.x.OnPanelValue(PV("u", p.u.val))
        env.x.OnPanelValue(PV("v", p.v.val))
    assert not env.o.webrender.mouse
    env.pump()
    assert len(env.o.webrender.mouse) == 1 and env.o.webrender.mouse[0][:2] == (pytest.approx(0.4), 0.2)
    env.pump()
    assert len(env.o.webrender.mouse) == 1  # nothing pending


def test_button_edge_flushes_pending_move_first_and_keeps_order(env):
    p = env.o.panel
    p.u.val, p.v.val = 0.3, 0.3
    env.x.OnPanelValue(PV("u", 0.3))
    env.x.OnPanelValue(PV("lselect", 0), 1)
    env.x.OnPanelValue(PV("lselect", 0), 0)
    assert [m[2]["left"] for m in env.o.webrender.mouse] == [False, True, False]


def test_dev_module_reload_is_picked_up(env):
    import types
    env.pump()
    new = types.ModuleType("protocol")
    new.__dict__.update(P.__dict__)
    env.o._ops["protocol"].module = new
    env.pump(3, dt=0.5)
    assert env.x.protocol is new
