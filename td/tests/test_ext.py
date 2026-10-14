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
        self.fetch_skip = set()  # clients that never fetch
        self.autofetch = True  # a well-behaved web client fetches every `base` notice
        self.x = E.RasterEditorExt(self.o)
        self.x._now = self.clock
        self.o.ext = self.x
        self.n = 0
        self.opened = []
        self.x._open_url = self.opened.append
        self.s = self.o.server
        self.fetched = {}  # socket id -> [(header, payload bytes)]

    def pump(self, n=1, dt=0.034):
        for _ in range(n):
            self.clock.advance(dt)
            self.x.Pump()
            if self.autofetch:
                for cid, c in list(self.x.clients.items()):
                    if c.outstanding is not None and cid not in self.fetch_skip:
                        self.fetch(cid)

    def connect(self, kind="panel", protocol=P.PROTOCOL_VERSION, ready=True, token=None):
        self.n += 1
        cid = f"127.0.0.1:{5000 + self.n}"
        self.s.webSocketConnections.append(cid)
        self.x.OnWebSocketOpen(cid, "/ws?client=" + kind)
        if ready:
            self.send(cid, {"t": "ready", "protocol": protocol, "client": kind, "version": "t", "token": token or self.x.token})
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
        """BASE frames fetched by cid, grouped by frame id -> [(hdr, payload)] (one band each)."""
        out = {}
        for h, p in self.fetched.get(cid, []):
            out.setdefault(h.frame_id, []).append((h, p))
        return out

    def notices(self, cid):
        return self.s.messages(cid, "base")


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
    assert hello["protocol"] == 2 and hello["active"] is True and hello["hasInput"] is False
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
    assert len(env.fetched[a]) == 2 and len(env.notices(a)) == 2  # re-notified with the stored frame


def test_request_base_without_input_is_noop(env):
    env.pump()
    a = env.connect("panel")
    env.send(a, {"t": "requestBase"})
    env.pump(5)
    assert not env.notices(a) and not env.s.binaries





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
        if env.x._conv is not None:
            break
    assert env.x._conv is not None
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.x._conv is None and env.x._input_pending





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
    assert n == {"t": "base", "frameId": n["frameId"], "docW": 64, "docH": 32, "x": 0, "y": 0, "w": 64, "h": 32}
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
    assert h.frame_id != first and h.frame_id == env.x._base_fid  # newest, not the notified one
    assert r["data"] == env.x._base_msg
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
    assert env.x.clients[a].stalled and "1 stalled" in env.o.par.Status.eval()
    assert "stalled" in capsys.readouterr().out
    env.o.in1.set_image(np.full((32, 64, 4), 0.5, np.float32))
    env.pump(20)
    assert len(env.notices(a)) == 1 and not env.s.closed  # still nothing, and never closed from the cook thread
    env.fetch(a)  # it wakes up
    assert not env.x.clients[a].stalled
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
    assert env.x.clients[a].outstanding is not None  # notice for the 960x540 frame, unfetched
    env.o.in1.set_image(np.random.RandomState(3).rand(540, 960, 4).astype(np.float32))
    for _ in range(30):  # start another conversion and resize in the middle of it
        env.pump()
        if env.x._conv is not None:
            break
    assert env.x._conv is not None
    env.o.in1.set_image(np.random.RandomState(2).rand(40, 80, 4).astype(np.float32))
    env.pump()
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 80, "h": 40, "hasInput": True}
    assert env.x._conv is None and env.x.clients[a].outstanding is None
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
    env.x._frame_id = 0xFFFFFFFE
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
    assert env.x.clients[b].outstanding is None and env.x.clients[b].fetched == env.x._base_fid


def test_fetch_with_unknown_client_id_still_serves_but_marks_nobody(env):
    env.set_input(64, 32)
    env.pump(1)
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    r = env.x.OnHTTPRequest(req(uri="/base", pars={"token": env.x.token, "client": "ghost"}), {})
    assert r["statusCode"] == 200 and env.x.clients[a].outstanding is not None


# ----------------------------------------------------------------------------- liveness regressions

def test_request_base_renotifies_even_with_an_unfetched_notice_outstanding(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}  # the client's fetch "failed": it never fetched the notice
    env.pump(10)
    assert len(env.notices(a)) == 1 and env.x.clients[a].outstanding is not None
    env.send(a, {"t": "requestBase"})
    assert env.x.clients[a].outstanding is None and not env.x.clients[a].stalled
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
    assert env.x.clients[a].stalled
    env.send(a, {"t": "requestBase"})
    env.pump(3)
    assert not env.x.clients[a].stalled and len(env.notices(a)) == 2


def test_404_on_base_clears_the_clients_outstanding_notice(env):
    env.set_input(64, 32)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    assert env.x.clients[a].outstanding is not None
    env.x._base_msg = None  # frame vanished between notice and fetch
    assert env.fetch(a)["statusCode"] == 404
    assert env.x.clients[a].outstanding is None and env.x.clients[a].fetched is None


def test_premultiplied_toggle_does_not_strand_clients_on_the_old_image(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32, 1)
    env.pump()
    a = env.connect("panel")
    env.fetch_skip = {a}
    env.pump(10)
    assert env.x.clients[a].outstanding is not None
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    assert env.x.clients[a].outstanding is None and not env.x.clients[a].stalled
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
    assert env.x.clients[a].stalled
    env.set_input(80, 40, 2)
    env.pump()
    assert all(c.outstanding is None and not c.stalled for c in env.x.clients.values())


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
    env.x._base_msg = None
    assert get("http://localhost:5173")["Access-Control-Allow-Origin"] == "http://localhost:5173"  # 404 too


def test_frame_id_is_never_reset_by_invalidations_or_active_toggles(env):
    env.o.par.Maxinputfps.val = 120
    env.set_input(64, 32)
    env.pump()
    env.connect("panel")
    env.pump(10)
    seen = [env.x._frame_id]
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
        seen.append(env.x._frame_id)
    assert seen == sorted(seen) and seen[2] > seen[0] and seen[0] > 0  # monotonic across premult, resize and a restart
