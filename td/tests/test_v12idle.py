"""v12 (DESIGN_V10): idle-aware streaming. A client that sent `streams {paused: true}` gets no BASE / view / layer-preview frames or
notices and causes no readback or encode work; resume sends fresh state; protocol < 12 clients are never paused."""

import json

import numpy as np
import pytest

import ext as E
import frames
import protocol as P
from faketd import FakeTop
from test_ext import Env
from test_ext_v7 import PIXSORT, H, W, fetch_layer, notices as lp_notices, preview_img, setup_preview
from test_v11view import DH, DW, V, apply_exact, want_wire


def pause(env, cid, paused=True):
    env.send(cid, {"t": "streams", "paused": paused})


# ----------------------------------------------------------------------------- protocol

def test_streams_message_builders_and_parser():
    assert json.loads(P.streams(True)) == {"t": "streams", "paused": True}
    assert json.loads(P.streams(False)) == {"t": "streams", "paused": False}
    assert P.parse_streams({"t": "streams", "paused": True}) is True
    for bad in ({}, {"paused": 1}, {"paused": "true"}, {"paused": None}):
        with pytest.raises(P.ProtocolError):
            P.parse_streams(bad)
    assert P.PROTOCOL_VERSION == 12 and P.MIN_PROTOCOL == 10


def test_bad_streams_message_replies_an_error_and_changes_nothing():
    env = Env()
    env.pump()
    c = env.connect("external", protocol=12)
    env.send(c, {"t": "streams", "paused": "yes"})
    assert env.s.messages(c, "error") and not env.x.clients[c].paused


def test_hello_accepts_protocol_12_and_unknown_streams_before_ready_are_ignored():
    env = Env()
    env.pump()
    c = env.connect("external", protocol=12)
    assert env.s.messages(c, "hello")[0]["protocol"] == 12
    c2 = env.connect("external", ready=False)
    pause(env, c2)
    assert not env.x.clients[c2].paused


# ----------------------------------------------------------------------------- BASE stream

def base_env(n_clients=1, protocol=12):
    env = Env()
    env.pump()
    cids = [env.connect("external", protocol=protocol) for _ in range(n_clients)]
    env.set_input(32, 16, 1)
    env.pump(6)
    return env, cids


def test_paused_client_gets_no_base_notice_and_nothing_is_read_back():
    env, (a,) = base_env()
    assert len(env.notices(a)) == 1
    pause(env, a)
    rb, n0, cnt = env.o.in1.readbacks, len(env.notices(a)), env.x.GetCounters()
    for i in range(10):
        env.set_input(32, 16, 10 + i)
        env.pump(3)
    assert len(env.notices(a)) == n0
    assert env.o.in1.readbacks == rb
    after = env.x.GetCounters()
    assert after.get("readback") == cnt.get("readback") and after.get("basenotices") == cnt.get("basenotices")


def test_resume_announces_the_newest_base_frame_of_a_changed_input():
    env, (a,) = base_env()
    pause(env, a)
    for i in range(3):
        env.set_input(32, 16, 20 + i)
        env.pump(3)
    last = env.set_input(32, 16, 99)
    env.pump(3)
    n0 = len(env.notices(a))
    pause(env, a, False)
    env.pump(12)
    ns = env.notices(a)
    assert len(ns) == n0 + 1                                          # exactly one: the stale stored frame is not announced first
    frames_ = env.bases(a)
    newest = frames_[max(frames_)]
    want = frames.WireConverter().to_wire(last, True)
    assert (E_wire(newest) == want).all()


def E_wire(bands):
    return np.concatenate([np.frombuffer(p, np.uint8).reshape(h.h, h.w, 4) for h, p in bands])


def test_resume_of_an_unchanged_input_announces_the_stored_frame_again():
    env, (a,) = base_env()
    n0 = len(env.notices(a))
    pause(env, a)
    env.pump(10)
    pause(env, a, False)
    env.pump(4)
    assert len(env.notices(a)) == n0 + 1


def test_pause_and_resume_are_idempotent():
    env, (a,) = base_env()
    pause(env, a)
    pause(env, a)
    pause(env, a, False)
    env.pump(4)
    n = len(env.notices(a))
    pause(env, a, False)
    env.pump(4)
    assert len(env.notices(a)) == n


def test_all_clients_paused_equals_no_client_work():
    # no client at all
    idle = Env()
    idle.pump()
    idle.set_input(32, 16, 1)
    idle.pump(5)
    base0 = idle.o.in1.readbacks
    for i in range(6):
        idle.set_input(32, 16, i)
        idle.pump(3)
    no_client = idle.o.in1.readbacks - base0
    # two paused clients
    env, (a, b) = base_env(2)
    pause(env, a)
    pause(env, b)
    env.pump(5)
    rb0, cnt0 = env.o.in1.readbacks, env.x.GetCounters()
    for i in range(6):
        env.set_input(32, 16, i)
        env.pump(3)
    assert env.o.in1.readbacks - rb0 == no_client == 0
    assert env.x.GetCounters() == cnt0


def test_mixed_clients_only_the_unpaused_one_is_served():
    env, (a, b) = base_env(2)
    na, nb = len(env.notices(a)), len(env.notices(b))
    pause(env, a)
    for i in range(4):
        env.set_input(32, 16, 30 + i)
        env.pump(8)
    assert len(env.notices(a)) == na
    assert len(env.notices(b)) > nb                                     # the live one keeps getting frames
    rb = env.o.in1.readbacks
    assert rb > 0
    pause(env, b)
    env.pump(10)
    rb = env.o.in1.readbacks
    env.set_input(32, 16, 77)
    env.pump(10)
    assert env.o.in1.readbacks == rb                                    # now both are paused: no readback
    pause(env, a, False)
    env.pump(10)
    assert env.o.in1.readbacks > rb and len(env.notices(a)) == na + 1 and len(env.notices(b)) == len(env.notices(b))


def test_protocol_11_clients_are_never_paused():
    env, (a,) = base_env(protocol=11)
    n0 = len(env.notices(a))
    pause(env, a)
    assert env.x.clients[a].paused is False
    env.set_input(32, 16, 55)
    env.pump(8)
    assert len(env.notices(a)) > n0


def test_a_paused_client_can_disconnect_cleanly_and_a_new_one_starts_unpaused():
    env, (a,) = base_env()
    pause(env, a)
    env.x.OnWebSocketClose(a)
    b = env.connect("external", protocol=12)
    assert env.x.clients[b].paused is False
    env.pump(8)
    assert env.notices(b)


def test_status_reports_paused_clients():
    env, (a,) = base_env()
    b = env.connect("external", protocol=12)
    pause(env, b)
    env.pump(3)
    env.x._status_at = 0
    env.pump(1)
    assert "1 paused" in env.o.par.Status.eval()


# ----------------------------------------------------------------------------- layer previews

def test_paused_client_gets_no_layer_preview_and_no_readback_then_resume_announces_it_again():
    e, a, top = setup_preview()
    e.x.clients[a].protocol = 12        # (make() connects a protocol 10 panel)
    e.pump(6)
    assert len(lp_notices(e, a)) == 1
    pause(e, a)
    calls, cnt = top.calls, e.x.GetCounters()
    for i in range(5):
        top.array, top.totalCooks = preview_img(40 + i), top.totalCooks + 1
        e.pump(6)
    assert top.calls == calls and len(lp_notices(e, a)) == 1
    assert e.x.GetCounters().get("lpreadback") == cnt.get("lpreadback") and not e.x.layer_pipes   # the pipes are gone: the no-client case
    pause(e, a, False)
    e.pump(8)
    ns = lp_notices(e, a)
    assert len(ns) == 2
    h, payload = P.decode_frame(fetch_layer(e, a)["data"])
    assert (np.frombuffer(payload, np.uint8).reshape(H, W, 4) == frames.WireConverter().to_wire(preview_img(44), True)).all()


def test_layer_previews_keep_flowing_for_an_unpaused_active_editor_while_another_is_paused():
    e, a, top = setup_preview()
    e.x.clients[a].protocol = 12
    b = e.connect("external", protocol=12)
    e.pump(6)
    assert len(lp_notices(e, a)) == 1 and not lp_notices(e, b)
    e.send(b, {"t": "takeover"})                 # b is the active editor now; a was demoted
    pause(e, b)
    calls = top.calls
    top.array, top.totalCooks = preview_img(3), top.totalCooks + 1
    e.pump(8)
    assert top.calls == calls and not lp_notices(e, b)       # the only active editor is paused: no preview work
    pause(e, b, False)
    e.pump(8)
    assert len(lp_notices(e, b)) == 1


# ----------------------------------------------------------------------------- v11 view stream

def view_v(quality="auto"):
    v = V()
    c = v.connect(12)
    v.out(1)
    v.view(c, quality, {"x": 0, "y": 0, "w": DW, "h": DH, "scale": 1})
    v.pump(30)
    return v, c


def test_paused_view_client_gets_no_frames_no_captures_no_exact_work_and_loses_its_gpu_nodes():
    v, c = view_v()
    assert v.frames(c, "fast") and v.frames(c, "exact")
    pause(v.env, c)
    v.pump(2)
    nf, caps, cnt, rb = len(v.frames(c)), len(v.captures), v.x.GetCounters(), v.env.o.net.out.readbacks
    for i in range(10):
        v.out(50 + i)
        v.pump(4)
    v.pump(30)
    assert len(v.frames(c)) == nf and len(v.captures) == caps
    assert v.env.o.net.out.readbacks == rb
    assert v.destroyed and not v.x._vchains                             # no GPU chain is kept for a paused client
    after = v.x.GetCounters()
    for k in ("fastframes", "exactframes", "vxreadback", "vreadback", "readback"):
        assert after.get(k, 0) == cnt.get(k, 0)


def test_resume_sends_a_fast_frame_and_an_exact_refresh_in_auto():
    v, c = view_v()
    pause(v.env, c)
    v.pump(3)
    last = v.out(70)
    v.pump(10)
    nfast, nexact = len(v.frames(c, "fast")), len(v.frames(c, "exact"))
    pause(v.env, c, False)
    v.pump(2)
    assert len(v.frames(c, "fast")) == nfast + 1                         # promptly (within two pumps)
    v.pump(25)
    ex = v.frames(c, "exact")
    assert len(ex) == nexact + 1
    buf = None
    for k, d, _ in v.frames(c, "exact"):
        buf = apply_exact(buf, d)
    assert (buf == want_wire(last)).all()                                # the client's exact buffer is the current picture


def test_resume_in_exact_quality_sends_the_exact_picture_without_fast_frames():
    v, c = view_v("exact")
    pause(v.env, c)
    v.pump(3)
    last = v.out(71)
    v.pump(10)
    n = len(v.frames(c, "exact"))
    pause(v.env, c, False)
    v.pump(15)
    assert len(v.frames(c, "exact")) == n + 1 and not v.frames(c, "fast")
    buf = None
    for k, d, _ in v.frames(c, "exact"):
        buf = apply_exact(buf, d)
    assert (buf == want_wire(last)).all()


def test_resume_of_an_unchanged_picture_refreshes_the_exact_view():
    v, c = view_v()
    nexact = len(v.frames(c, "exact"))
    pause(v.env, c)
    v.pump(10)
    pause(v.env, c, False)
    v.pump(30)
    assert len(v.frames(c, "fast")) >= 2
    assert len(v.frames(c, "exact")) == nexact + 1                      # an empty tile frame: "your exact buffer is current"


def test_resume_with_frames_in_flight_sends_a_full_exact_frame():
    v, c = view_v()
    for i in range(3):
        v.out(80 + i)
        v.pump(1, ack=False)                                             # frames are in flight (un-acked) when the page goes idle
    pause(v.env, c)
    v.pump(2)
    pause(v.env, c, False)
    v.pump(40)
    last = v.frames(c, "exact")[-1][1]
    assert last["kind"] == 0                                             # full: its buffer may be stale


def test_view_mixed_clients_one_paused_one_live():
    v = V()
    a, b = v.connect(12), v.connect(12)
    v.out(1)
    for cid in (a, b):
        v.view(cid, "auto", {"x": 0, "y": 0, "w": DW, "h": DH, "scale": 1})
    v.pump(20)
    pause(v.env, a)
    na, nb = len(v.frames(a)), len(v.frames(b))
    for i in range(5):
        v.out(90 + i)
        v.pump(3)
    assert len(v.frames(a)) == na and len(v.frames(b)) > nb
    assert list(v.x._vchains) == [b]


def test_protocol_11_view_client_ignores_streams():
    v = V()
    c = v.connect(11)
    v.out(1)
    v.view(c, "fast")
    v.pump(5)
    pause(v.env, c)
    n = len(v.frames(c))
    for i in range(4):
        v.out(5 + i)
        v.pump(2)
    assert len(v.frames(c)) > n


def test_all_view_clients_paused_equals_no_client_view_work():
    v, c = view_v()
    pause(v.env, c)
    v.pump(5)
    none = V()
    none.out(1)
    none.pump(5)
    for env in (v.env, none.env):
        env.o.net.out.readbacks = 0
    cnt = v.x.GetCounters()
    for i in range(8):
        v.out(i)
        none.out(i)
        v.pump(3)
        none.pump(3)
    assert v.env.o.net.out.readbacks == none.env.o.net.out.readbacks == 0
    assert v.x.GetCounters() == cnt and not v.x._vchains and not none.x._vchains
