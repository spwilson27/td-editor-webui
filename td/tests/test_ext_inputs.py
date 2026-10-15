"""v6 multiple inputs: In TOP management (spare connector rule), per-input BASE streams, notices, stall rules."""

import numpy as np
import pytest

import ext as E
import protocol as P
from faketd import TickClock
from test_ext import IN, Env, L, req, wire_img


def plug(e, n, w, h, seed=0):
    """Connect input n (its In TOP must exist: the spare connector) to a source of size w x h."""
    arr = np.random.RandomState(seed).rand(h, w, 4).astype(np.float32)
    if n not in e.o.in_tops:
        e.pump()   # the extension creates the spare connector behind the connected inputs
    e.o.in_tops[n].set_image(arr)
    e.o.connected.add(n)
    return arr


def unplug(e, n):
    e.o.connected.discard(n)


def fetch_input(e, cid, n, **kw):
    r = e.get("/base", client=e.x.clients[cid].cid, input=n, **kw)
    if r["statusCode"] != 200:
        return r, None, None
    h, payload = P.decode_frame(r["data"])
    return r, h, np.frombuffer(payload, np.uint8).reshape(h.h, h.w, 4)


def base_notices(e, cid, n=None):
    return [m for m in e.s.messages(cid, "base") if n is None or m["input"] == n]


def ops(e):
    return sorted(e.o.in_tops)


@pytest.fixture
def env():
    e = Env()
    e.autofetch = False
    return e


# ---- In TOP management

def test_one_in_top_and_one_spare_connector_at_start(env):
    env.pump()
    assert ops(env) == [1] and env.o.created == []   # exactly one connector, unconnected


def test_connecting_the_spare_creates_the_next_one_with_connector_order(env):
    plug(env, 1, 8, 4)
    env.pump()
    assert ops(env) == [1, 2] and env.o.created == ["in2"]
    assert env.o.in_tops[2].par.connectorder.eval() == 2
    plug(env, 2, 6, 6)
    env.pump()
    plug(env, 3, 5, 5)
    env.pump(3)
    assert ops(env) == [1, 2, 3, 4] and env.o.created == ["in2", "in3", "in4"]
    assert [env.o.in_tops[n].par.connectorder.eval() for n in ops(env)][1:] == [2, 3, 4]


def test_never_more_than_eight_inputs(env):
    for n in range(1, 9):
        plug(env, n, 4, 4, n)
        env.pump()
    assert ops(env) == list(range(1, 9)) and env.o.created[-1] == "in8"
    env.pump(5)
    assert ops(env) == list(range(1, 9))   # no in9


def test_disconnecting_an_earlier_input_never_removes_a_connected_one(env):
    for n in (1, 2, 3):
        plug(env, n, 4 + n, 4)
        env.pump()
    assert ops(env) == [1, 2, 3, 4]
    unplug(env, 2)
    env.pump(5, dt=1.0)   # long after INPUT_TRIM_S
    assert ops(env) == [1, 2, 3, 4] and env.o.connected == {1, 3}   # 3 is connected: in3 and the spare in4 stay


def test_trailing_unneeded_spare_inputs_are_removed_after_a_delay(env):
    for n in (1, 2, 3):
        plug(env, n, 4 + n, 4)
        env.pump()
    unplug(env, 3)
    unplug(env, 2)
    env.pump(1, dt=0.1)
    assert ops(env) == [1, 2, 3, 4]               # not at once
    env.pump(1, dt=E.INPUT_TRIM_S + 0.1)
    env.pump(1, dt=0.1)
    assert ops(env) == [1, 2]                       # input 1 connected -> one spare (in2) remains
    unplug(env, 1)
    env.pump(2, dt=E.INPUT_TRIM_S + 0.1)
    assert ops(env) == [1]


def test_reconnecting_before_the_delay_cancels_the_removal(env):
    plug(env, 1, 4, 4)
    env.pump()
    plug(env, 2, 4, 4)
    env.pump()
    unplug(env, 2)
    env.pump(1, dt=1.0)
    plug(env, 2, 4, 4)
    env.pump(3, dt=1.5)
    assert ops(env) == [1, 2, 3]


# ---- inputs message / hasInput

def test_inputs_message_lists_every_input_that_exists_with_connected_flags(env):
    env.pump()
    a = env.connect("panel")
    plug(env, 1, 16, 8)
    env.pump()
    assert env.s.messages(a, "inputs")[-1] == {"t": "inputs", "items": [IN(1, 16, 8), IN(2)]}
    plug(env, 2, 9, 7)
    env.pump()
    assert env.s.messages(a, "inputs")[-1]["items"] == [IN(1, 16, 8), IN(2, 9, 7), IN(3)]
    n = len(env.s.messages(a, "inputs"))
    env.pump(5)
    assert len(env.s.messages(a, "inputs")) == n   # only on change
    unplug(env, 2)
    env.pump()
    assert env.s.messages(a, "inputs")[-1]["items"][1] == IN(2)   # disconnected: 0x0
    env.o.in_tops[1].set_image(np.zeros((9, 20, 4), np.float32))   # resolution change
    env.pump()
    assert env.s.messages(a, "inputs")[-1]["items"][0] == IN(1, 20, 9)


def test_follow_input_and_has_input_use_input_1_only(env):
    env.pump()
    a = env.connect("panel")
    env.o.connected.add(1)
    env.o.in_tops[1].set_image(np.zeros((8, 8, 4), np.float32))
    env.pump()
    plug(env, 2, 50, 30)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.has_input) == (8, 8, True)   # input 2 does not drive the canvas
    unplug(env, 1)
    env.pump()
    assert (env.x.doc_w, env.x.doc_h, env.x.has_input) == (64, 32, False)   # parameter size, hasInput false although input 2 is connected
    assert env.s.messages(a, "docSize")[-1] == {"t": "docSize", "w": 64, "h": 32, "hasInput": False, "mode": "input"}
    assert env.s.messages(a, "inputs")[-1]["items"][1] == IN(2, 50, 30)


def test_network_is_told_the_inputs(env):
    plug(env, 1, 16, 8)
    env.pump()
    plug(env, 2, 4, 4)
    env.pump()
    calls = env.o.net.input_calls
    assert calls[-1] == [IN(1, 16, 8), IN(2, 4, 4), IN(3)]
    unplug(env, 1)
    env.pump()
    assert calls[-1][0] == IN(1) and calls[-1][1] == IN(2, 4, 4)


# ---- BASE streams

def test_each_input_has_its_own_frames_notices_and_endpoint(env):
    img1, img2 = plug(env, 1, 16, 8, 1), plug(env, 2, 9, 7, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(30)
    n1, n2 = base_notices(env, a, 1), base_notices(env, a, 2)
    assert len(n1) == 1 and len(n2) == 1 and not base_notices(env, a, 3)   # newest-only: one outstanding per input
    assert (n1[0]["docW"], n1[0]["docH"], n2[0]["docW"], n2[0]["docH"]) == (16, 8, 9, 7)
    for n, img, notice in ((1, img1, n1[0]), (2, img2, n2[0])):
        r, h, px = fetch_input(env, a, n)
        assert r["statusCode"] == 200 and h.slot == n and h.type == P.TYPE_BASE and h.frame_id == notice["frameId"]
        assert (h.doc_w, h.doc_h, h.w, h.h) == (img.shape[1], img.shape[0], img.shape[1], img.shape[0])
        want = env.x.frames.WireConverter().to_wire(img, True)
        assert (px == want).all()
    assert fetch_input(env, a, 3)[0]["statusCode"] == 404    # the spare: no frame
    assert fetch_input(env, a, 9)[0]["statusCode"] == 404
    assert fetch_input(env, a, "x")[0]["statusCode"] == 404
    r = env.get("/base", client=env.x.clients[a].cid)       # no `input` parameter = input 1
    assert r["statusCode"] == 200 and P.decode_frame(r["data"])[0].slot == 1


def test_fetch_requires_the_token_and_a_known_client(env):
    plug(env, 1, 4, 4)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    assert env.get("/base", client=env.x.clients[a].cid, input=1, token="bad")["statusCode"] == 403


def test_a_changing_input_only_republishes_that_input(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 8, 8, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(20)
    fetch_input(env, a, 1)
    fetch_input(env, a, 2)
    f1 = env.x.bases[1].fid
    env.o.in_tops[2].set_image(np.random.RandomState(9).rand(8, 8, 4).astype(np.float32))
    env.pump(20)
    assert env.x.bases[1].fid == f1                    # input 1 unchanged: no new frame
    assert len(base_notices(env, a, 2)) == 2 and len(base_notices(env, a, 1)) == 1


def test_notices_stall_and_resume_per_input(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 8, 8, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    fetch_input(env, a, 1)                    # input 2 is never fetched
    env.pump(1, dt=E.STALL_S + 1)
    env.pump(1)
    c = env.x.clients[a]
    assert c.notice(2).stalled and not c.notice(1).stalled
    sent = len(base_notices(env, a, 2))
    env.o.in_tops[2].set_image(np.random.RandomState(4).rand(8, 8, 4).astype(np.float32))
    env.o.in_tops[1].set_image(np.random.RandomState(5).rand(8, 8, 4).astype(np.float32))
    env.pump(20)
    assert len(base_notices(env, a, 2)) == sent        # stalled: nothing more for input 2
    assert len(base_notices(env, a, 1)) == 2           # input 1 still flows
    assert fetch_input(env, a, 2)[0]["statusCode"] == 200   # (the newest frame: nothing is pending for it)
    assert not c.notice(2).stalled
    env.o.in_tops[2].set_image(np.random.RandomState(6).rand(8, 8, 4).astype(np.float32))
    env.pump(10)
    assert len(base_notices(env, a, 2)) == sent + 1    # resumed


def test_request_base_reannounces_all_or_one_input(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 8, 8, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    fetch_input(env, a, 1)
    fetch_input(env, a, 2)
    env.pump(3)
    n = {i: len(base_notices(env, a, i)) for i in (1, 2)}
    env.send(a, {"t": "requestBase", "input": 2})
    env.pump(2)
    assert len(base_notices(env, a, 2)) == n[2] + 1 and len(base_notices(env, a, 1)) == n[1]
    fetch_input(env, a, 2)
    env.send(a, {"t": "requestBase"})
    env.pump(2)
    assert len(base_notices(env, a, 2)) == n[2] + 2 and len(base_notices(env, a, 1)) == n[1] + 1


def test_disconnect_frees_the_stream_and_reconnect_announces_again(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 6, 6, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    fetch_input(env, a, 2)
    unplug(env, 2)
    env.pump(3)
    assert fetch_input(env, a, 2)[0]["statusCode"] == 404 and env.x.bases[2].msg is None
    assert fetch_input(env, a, 1)[0]["statusCode"] == 200
    plug(env, 2, 12, 5, 3)
    env.pump(20)
    n = base_notices(env, a, 2)[-1]
    assert (n["docW"], n["docH"]) == (12, 5)
    assert fetch_input(env, a, 2)[0]["statusCode"] == 200


def test_new_client_gets_a_notice_per_connected_input(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 6, 6, 2)
    plug(env, 3, 4, 4, 3)
    env.pump(3)
    a = env.connect("panel")
    env.pump(20)
    b = env.connect("external")
    env.pump(5)
    assert sorted(m["input"] for m in base_notices(env, b)) == [1, 2, 3]


def test_all_inputs_get_through_with_a_tiny_conversion_budget():
    e = Env(tick=0.002)   # every clock read costs 2 ms: one input's conversion fills the whole 4 ms budget
    e.autofetch = False
    big = [plug(e, n, 200, 120, n) for n in (1,)]
    e.pump(2)
    big.append(plug(e, 2, 160, 100, 2))
    e.pump(2)
    big.append(plug(e, 3, 120, 90, 3))
    a = e.connect("panel")
    for _ in range(300):
        e.pump()
        for n in (1, 2, 3):
            if e.x.clients[a].notice(n).outstanding is not None:
                fetch_input(e, a, n)
    for n, img in zip((1, 2, 3), big):
        _, h, px = fetch_input(e, a, n)
        assert h is not None and (px == e.x.frames.WireConverter().to_wire(img, True)).all()


def test_premultiplied_toggle_republishes_every_input(env):
    plug(env, 1, 8, 8, 1)
    plug(env, 2, 8, 8, 2)
    env.pump()
    a = env.connect("panel")
    env.pump(10)
    fetch_input(env, a, 1)
    fetch_input(env, a, 2)
    env.o.par.Premultiplied.val = 0
    env.x.OnParChange(env.o.par.Premultiplied)
    env.pump(15)
    for n in (1, 2):
        assert len(base_notices(env, a, n)) == 2


# ---- documents with input layers

def test_default_stack_has_one_input_layer_per_connected_input():
    e = Env()
    plug(e, 1, 8, 8, 1)
    plug(e, 2, 6, 4, 2)
    e.pump(3)
    layers = e.o.net.applies[-1][0]
    assert [(l["kind"], l["input"], l["id"]) for l in layers] == [("input", 1, "input1"), ("input", 2, "input2")]
    assert [(l["surfaceW"], l["surfaceH"]) for l in layers] == [(8, 8), (6, 4)]


def test_default_stack_without_any_input_is_one_input_1_layer(env):
    env.pump()
    (l,) = env.o.net.applies[-1][0]
    assert (l["kind"], l["input"]) == ("input", 1)


def test_doc_state_serves_input_layers_with_the_live_input_size():
    e = Env()
    plug(e, 1, 8, 8, 1)
    plug(e, 2, 6, 4, 2)
    e.pump(3)
    a = e.connect("panel")
    e.doc(a, [L("i2", "input", input=2), L("p", slot=1, surfaceW=4, surfaceH=4)])
    e.send(a, {"t": "requestDoc"})
    layers = e.s.messages(a, "docState")[-1]["layers"]
    assert (layers[0]["surfaceW"], layers[0]["surfaceH"]) == (6, 4)


def test_input_layer_resolution_change_keeps_the_displayed_box_for_inputs_other_than_1():
    e = Env()
    plug(e, 1, 8, 8, 1)
    e.pump(2)
    plug(e, 2, 10, 10, 2)
    e.pump(2)
    a = e.connect("panel")
    e.doc(a, [L("i1", "input", input=1, surfaceW=8, surfaceH=8),
              L("i2", "input", input=2, surfaceW=10, surfaceH=10, sx=2.0, sy=2.0, x=5, y=6, rot=30)])
    e.o.in_tops[2].set_image(np.zeros((20, 5, 4), np.float32))
    e.pump(2)
    i1, i2 = e.x.doc_layers
    assert (i1["sx"] if "sx" in i1 else 1) == 1
    assert (i2["surfaceW"], i2["surfaceH"]) == (5, 20)
    assert (i2["sx"], i2["sy"]) == (4.0, 1.0) and (i2["x"], i2["y"], i2["rot"]) == (5, 6, 30)   # box 20x20 kept


def test_switching_to_follow_input_resets_input_1_transform_only():
    e = Env()
    plug(e, 1, 8, 8, 1)
    e.pump(2)
    plug(e, 2, 8, 8, 2)
    e.pump(2)
    e.o.par.Docsizemode.val = "fixed"
    e.pump(2)
    a = e.connect("panel")
    e.doc(a, [L("i1", "input", input=1, sx=2.0, sy=2.0, x=3, y=4, rot=10, kx=5, ky=6, surfaceW=8, surfaceH=8),
              L("i2", "input", input=2, sx=2.0, sy=2.0, x=3, y=4, rot=10, surfaceW=8, surfaceH=8)])
    e.o.par.Docsizemode.val = "input"
    e.pump(2)
    i1, i2 = e.x.doc_layers
    assert [(i1[k]) for k in ("x", "y", "sx", "sy", "rot", "kx", "ky")] == [0, 0, 1, 1, 0, 0, 0]
    assert (i2["sx"], i2["x"], i2["rot"]) == (2.0, 3, 10)


def test_v5_stored_document_with_a_base_layer_is_restored_as_input_1():
    e = Env()
    e.o.doc_state.text = P.encode_json({"rev": 4, "layers": [L("base", "base", surfaceW=64, surfaceH=32), L("p", slot=1, surfaceW=64, surfaceH=32)],
                                        "guides": {"h": [], "v": []}, "canvas": {"mode": "input"}})
    e.pump(3)
    assert [(l["kind"], l.get("input")) for l in e.x.doc_layers] == [("input", 1), ("pixel", None)]
    assert e.o.net.applies[-1][0][0]["kind"] == "input"


# ---- effects module / shaders handed to the DocNetwork

def test_network_gets_the_effects_module_and_shader_texts_from_the_dats():
    import types
    from faketd import FakeText, Module
    e = Env()
    fx = types.SimpleNamespace(EFFECT_TYPES=("dropShadow", "glitch"))
    e.o._ops.update({"effects": Module(fx), "fx_common": FakeText("COMMON"), "fx_dropShadow": FakeText("DS"), "fx_glitch": FakeText("GL")})
    e.pump(2)
    kw = e.o.net_kwargs
    assert kw["effects"] is fx and kw["effect_shaders"] == {"dropShadow": "COMMON\nDS", "glitch": "COMMON\nGL"}


def test_network_without_effect_dats_is_built_as_before():
    e = Env()
    e.pump(2)
    assert e.o.net_kwargs == {}


def test_missing_shader_dat_hands_only_the_module():
    import types
    from faketd import FakeText, Module
    e = Env()
    e.o._ops.update({"effects": Module(types.SimpleNamespace(EFFECT_TYPES=("dropShadow", "glitch"))), "fx_common": FakeText("C"),
                     "fx_dropShadow": FakeText("DS")})
    e.pump(2)
    assert list(e.o.net_kwargs) == ["effects"]   # DocNetwork then loads shaders itself (or disables effects)


def test_effects_failure_is_shown_in_status():
    e = Env()
    e.pump(2)
    e.o.net.fx_error = "ImportError: no shaders"
    e.x._status_at = 0
    e.pump(1)
    assert "effects unavailable: ImportError: no shaders" in e.o.par.Status.eval()


def test_built_component_shader_dict_contains_every_include_of_every_shader():
    """The extension builds the shader dict from the embedded fx_<stem> DATs: it must equal what effects.load_shader_texts reads from
    the repo (common + filterlib / blurlib / in2lib prepended), for every effect AND filter type."""
    import effects
    import build_component as B
    from faketd import FakeText, Module
    import os
    root = os.path.join(B.REPO if B.REPO else os.path.join(os.path.dirname(__file__), "..", ".."), "shared", "effects")
    e = Env()
    dats = {B.effect_dat_name(r): FakeText(open(os.path.join(B.REPO, r), encoding="utf-8").read()) for r in B.effect_sources(B.REPO)}
    assert {"fx_" + s for s in effects.shader_stems()} <= set(dats)    # build_component embeds all of them
    e.o._ops.update({"effects": Module(effects), **dats})
    e.pump(2)
    got = e.o.net_kwargs["effect_shaders"]
    want = effects.load_shader_texts(root)
    assert got == want and set(got) == set(effects.shader_names())
    for name, text in got.items():
        for inc in effects.shader_includes(name):
            assert dats["fx_" + inc].text in text, f"{name} lacks {inc}.glsl"
        assert dats["fx_common"].text in text and dats["fx_" + name].text in text
    assert "blurlib" in effects.shader_includes("dropShadow") and dats["fx_blurlib"].text in got["dropShadow"]


def test_missing_include_dat_is_reported_and_only_the_module_is_handed_over():
    import effects
    import build_component as B
    import os
    from faketd import FakeText, Module
    e = Env()
    dats = {B.effect_dat_name(r): FakeText("x") for r in B.effect_sources(B.REPO) if "blurlib" not in r}
    e.o._ops.update({"effects": Module(effects), **dats})
    e.pump(2)
    assert list(e.o.net_kwargs) == ["effects"] and "fx_blurlib" in (e.x.last_error or ("",))[0]
