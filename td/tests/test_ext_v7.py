"""v7: filters in documents, tdPreview layer stream, history persistence, activeLayer + content bounds."""

import json
import types

import numpy as np
import pytest

import ext as E
import frames
import protocol as P
from faketd import FakeTop, Module
from test_ext import Env, L, req, wire_img
from test_ext_files import result

PIXSORT = {"enabled": True, "type": "pixelSort", "direction": "h", "low": 0.2, "high": 0.8, "key": "luma"}
BLUR = {"enabled": True, "type": "blur", "radius": 4}   # a filter-library type
FILTER_ADJ = {"type": "filter", "effect": BLUR}


def fx_stub(flagged=("pixelSort",)):
    return Module(types.SimpleNamespace(EFFECT_TYPES=(), effect_td_preview=lambda e: e.get("type") in flagged and e.get("enabled")))


def make(fx=True, doc=None, **pars):
    e = Env(**pars)
    if fx:
        e.o._ops["effects"] = fx_stub()
    e.pump()
    a = e.connect("panel")
    layers = doc if doc is not None else [L("p1", slot=1, surfaceW=64, surfaceH=32), L("p2", slot=2, surfaceW=64, surfaceH=32)]
    e.send(a, {"t": "doc", "rev": 1, "layers": layers})
    e.pump(2)
    return e, a


# --------------------------------------------------------------------------- history (POST / GET /history)

def post_history(e, cid, blob, rev=1, token=None, client=None, method="POST"):
    pars = {"token": token or e.x.token, "client": client or e.x.clients[cid].cid}
    if rev is not None:
        pars["rev"] = str(rev)
    return e.x.OnHTTPRequest(req(method, "/history", blob, pars=pars), {})


def get_history(e, cid, token=None):
    return e.x.OnHTTPRequest(req("GET", "/history", pars={"token": token or e.x.token, "client": e.x.clients[cid].cid}), {})


def test_history_post_get_roundtrip_with_doc_rev_header():
    e, a = make()
    assert get_history(e, a)["statusCode"] == 404
    blob = bytes(range(256)) * 100
    r = post_history(e, a, blob, rev=7)
    assert r["statusCode"] == 204
    g = get_history(e, a)
    assert g["statusCode"] == 200 and g["data"] == blob and g["X-Doc-Rev"] == "7" and g["X-History-Rev"] == "7"
    assert g["content-type"] == "application/octet-stream" and g["Access-Control-Expose-Headers"] == "X-Doc-Rev, X-History-Rev"
    assert e.o.fetch(E.HISTORY_KEY) == (7, 7, blob)   # in the COMP's storage (saved with the .toe)


def test_history_post_replaces_atomically_and_stores_the_same_object():
    e, a = make()
    b1, b2 = b"one" * 10, b"two" * 10
    post_history(e, a, b1, rev=1)
    post_history(e, a, b2, rev=2)
    assert e.o.fetch(E.HISTORY_KEY) == (2, 2, b2) and e.o.fetch(E.HISTORY_KEY)[2] is b2   # no copy of a bytes body


def test_history_requests_need_token_client_and_loopback():
    e, a = make()
    assert post_history(e, a, b"x", token="bad")["statusCode"] == 403
    assert post_history(e, a, b"x", client="nobody")["statusCode"] == 403
    assert get_history(e, a, token="bad")["statusCode"] == 403
    r = e.x.OnHTTPRequest(req("POST", "/history", b"x", pars={"token": e.x.token, "client": e.x.clients[a].cid, "rev": "1"},
                              clientAddress="10.0.0.5:4000"), {})
    assert r["statusCode"] == 403
    r = e.x.OnHTTPRequest(req("POST", "/history", b"x", pars={"token": e.x.token, "client": e.x.clients[a].cid, "rev": "1"},
                              Host="evil.example:9980"), {})
    assert r["statusCode"] == 403
    assert e.o.fetch(E.HISTORY_KEY) is None


def test_history_post_validates_rev_size_and_active_client():
    e, a = make()
    b = e.connect("external")
    assert post_history(e, b, b"x", rev=1)["statusCode"] == 409           # standby editors cannot overwrite it
    for bad in (None, "x", "-1", "1.5", "nan"):
        assert post_history(e, a, b"x", rev=bad)["statusCode"] == 400
    assert post_history(e, a, b"x" * (E.HISTORY_MAX_BYTES + 1))["statusCode"] == 413
    assert e.o.fetch(E.HISTORY_KEY) is None
    assert post_history(e, a, b"x" * 1000)["statusCode"] == 204
    assert post_history(e, a, b"", rev=2)["statusCode"] == 204 and e.o.fetch(E.HISTORY_KEY) is None   # empty body clears
    assert get_history(e, b)["statusCode"] == 404


def test_history_accepts_a_bytearray_and_a_256_mb_body_without_copying_for_bytes():
    e, a = make()
    big = bytes(E.HISTORY_MAX_BYTES)
    assert post_history(e, a, big, rev=3)["statusCode"] == 204
    assert e.o.fetch(E.HISTORY_KEY)[2] is big
    assert post_history(e, a, bytearray(b"abc"), rev=4)["statusCode"] == 204
    assert e.o.fetch(E.HISTORY_KEY) == (4, 4, b"abc") and isinstance(e.o.fetch(E.HISTORY_KEY)[2], bytes)


def test_history_cors_preflight_and_origin_header():
    e, a = make()
    r = e.x.OnHTTPRequest(req("OPTIONS", "/history", Origin="http://localhost:5173"), {})
    assert r["statusCode"] == 204 and "POST" in r["Access-Control-Allow-Methods"] and r["Access-Control-Allow-Origin"] == "http://localhost:5173"
    g = e.x.OnHTTPRequest(req("OPTIONS", "/history", Origin="http://evil.example"), {})
    assert "Access-Control-Allow-Origin" not in g


def test_history_dropped_when_a_doc_with_a_lower_rev_replaces_the_document():
    e, a = make()
    post_history(e, a, b"hist", rev=9)
    e.send(a, {"t": "doc", "rev": 10, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)]})
    assert e.o.fetch(E.HISTORY_KEY) == (9, 9, b"hist")        # same lineage: kept
    e.send(a, {"t": "doc", "rev": 3, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)]})
    assert e.o.fetch(E.HISTORY_KEY) is None                 # a fresh document


def make_saved(tmp_path, hist_rev=1):
    e, a = make()
    blob = b"HIST" + bytes(range(200)) * 5
    post_history(e, a, blob, rev=hist_rev)
    path = tmp_path / "h.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.pump(2)
    return e, a, blob, path


def test_redoc_contains_history_bin_and_meta_rev(tmp_path):
    e, a, blob, path = make_saved(tmp_path)
    assert result(e, a, "saveProject")[-1]["ok"] is True
    doc, meta, pngs, hist = frames.read_redoc(str(path), 1, True)
    assert hist == blob and meta["historyRev"] == 1 and meta["format"] == 1
    assert frames.read_redoc(str(path))[0]["rev"] == 1          # the 3-tuple form is unchanged


def test_redoc_omits_history_that_belongs_to_another_revision(tmp_path):
    e, a, blob, path = make_saved(tmp_path, hist_rev=0)        # history of rev 0, the document is rev 1
    _, meta, _, hist = frames.read_redoc(str(path), 1, True)
    assert hist is None and "historyRev" not in meta


def test_open_project_restores_history_at_the_new_rev_and_drops_the_old_one(tmp_path):
    e, a, blob, path = make_saved(tmp_path)
    post_history(e, a, b"newer history", rev=1)
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(path)})
    e.pump(3)
    assert result(e, a, "openProject")[-1]["ok"] is True
    doc_rev, hist_rev, hist = e.o.fetch(E.HISTORY_KEY)
    assert hist == blob and doc_rev == e.x.doc_rev == 2 and hist_rev == 1   # the doc rev stays monotonic; the blob keeps the rev it embeds
    g = get_history(e, a)
    assert g["X-Doc-Rev"] == "2" and g["X-History-Rev"] == "1"


def test_open_project_without_history_drops_the_stored_history(tmp_path):
    e, a = make()
    path = tmp_path / "n.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.pump(2)
    post_history(e, a, b"to be dropped", rev=1)
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(path)})
    e.pump(3)
    assert result(e, a, "openProject")[-1]["ok"] is True and e.o.fetch(E.HISTORY_KEY) is None


def test_redoc_reader_rejects_oversized_history(tmp_path):
    import zipfile
    p = tmp_path / "x.redoc"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("meta.json", json.dumps({"format": 1}))
        z.writestr("doc.json", "{}")
        z.writestr("history.bin", b"abc")
    assert frames.read_redoc(str(p), 1, True)[3] == b"abc"
    old = frames.HISTORY_MAX_BYTES
    frames.HISTORY_MAX_BYTES = 2
    try:
        with pytest.raises(frames.FileFormatError):
            frames.read_redoc(str(p), 1, True)
    finally:
        frames.HISTORY_MAX_BYTES = old


def test_brush_presets_are_stored_served_and_saved(tmp_path):
    e, a = make()
    pres = [{"id": "b1", "name": "Chalk", "settings": {"size": 20}, "tip": "chalk", "dynamics": {"seed": 1}}]
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)], "brushPresets": pres})
    e.pump(2)
    assert json.loads(e.o.doc_state.text)["brushPresets"] == pres
    b = e.connect("external")
    e.send(b, {"t": "requestDoc"})
    assert e.s.messages(b, "docState")[-1]["brushPresets"] == pres
    e.send(a, {"t": "doc", "rev": 3, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)]})   # absent = keep
    assert e.x.brush_presets == pres
    path = tmp_path / "b.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.pump(2)
    assert frames.read_redoc(str(path))[0]["brushPresets"] == pres
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(path)})
    e.pump(3)
    assert e.x.brush_presets == pres


def test_invalid_brush_presets_are_refused():
    e, a = make()
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)],
               "brushPresets": [{"id": "x", "name": "n", "settings": {}, "tip": "nope", "dynamics": {}}]})
    assert "brushPresets" in e.s.messages(a, "error")[-1]["msg"] and e.x.doc_rev == 1


# --------------------------------------------------------------------------- v7 documents

def test_doc_with_filters_filter_adjustment_and_group_adjustment_effects_is_applied():
    layers = [L("p1", slot=1, surfaceW=64, surfaceH=32, effects=[BLUR, PIXSORT]),
              L("g", "group", effects=[BLUR]),
              L("adj", "adjustment", adjustment=FILTER_ADJ, effects=[dict(BLUR, radius=9)])]
    e, a = make(doc=layers)
    assert not e.s.messages(a, "error")
    assert [l["id"] for l in e.o.net.applies[-1][0]] == ["p1", "g", "adj"]
    assert json.loads(e.o.doc_state.text)["layers"][2]["adjustment"] is None    # v8: migrated into effects[] (the stored copy)
    assert json.loads(e.o.doc_state.text)["layers"][2]["effects"] == [FILTER_ADJ["effect"], dict(BLUR, radius=9)]


# --------------------------------------------------------------------------- activeLayer + content bounds

def test_active_layer_from_the_active_client_reaches_the_network_once():
    e, a = make()
    b = e.connect("external")
    e.send(b, {"t": "activeLayer", "id": "p2"})        # standby: ignored
    e.pump()
    assert e.o.net.active_calls == [None] or e.o.net.active_calls == []
    n = len(e.o.net.applies)
    e.send(a, {"t": "activeLayer", "id": "p1"})
    e.pump(3)
    assert e.o.net.active_calls[-1] == "p1" and e.o.net.active_calls.count("p1") == 1
    assert len(e.o.net.applies) == n + 1                 # re-planned once
    e.pump(5)
    assert len(e.o.net.applies) == n + 1                 # nothing changed: no re-plan
    e.send(a, {"t": "activeLayer", "id": None})
    e.pump(2)
    assert e.o.net.active_calls[-1] is None


def test_bad_active_layer_is_an_error():
    e, a = make()
    e.send(a, {"t": "activeLayer", "id": 5})
    assert "activeLayer" in e.s.messages(a, "error")[-1]["msg"]


def test_active_layer_follows_a_takeover():
    e, a = make()
    b = e.connect("external")
    e.send(a, {"t": "activeLayer", "id": "p1"})
    e.send(b, {"t": "activeLayer", "id": "p2"})
    e.pump(2)
    assert e.o.net.active_calls[-1] == "p1"
    e.send(b, {"t": "takeover"})
    e.pump(2)
    assert e.o.net.active_calls[-1] == "p2"


def test_new_pixel_layers_are_known_empty_until_a_tile_arrives():
    e, a = make()
    assert e.o.net.bounds_calls[-1] == {"p1": None, "p2": None}
    img = wire_img(10, 6, 1)
    e.surface(a, 1, (5, 7, 10, 6), img)
    e.pump(2)
    assert "p1" not in e.o.net.bounds_calls[-1] and e.o.net.bounds_calls[-1]["p2"] is None   # not transformed: no box, no skip


def test_transformed_layer_gets_a_padded_box_that_grows_only_when_left():
    e, a = make(doc=[L("t", slot=1, surfaceW=256, surfaceH=128, sx=2.0, sy=2.0)])
    e.surface(a, 1, (100, 100, 10, 6), wire_img(10, 6, 1), dw=256, dh=128)
    e.pump(2)
    box = e.o.net.bounds_calls[-1]["t"]
    g = E.HINT_GRID
    assert box[0] <= 100 - E.HINT_PAD and box[2] >= 110 + E.HINT_PAD and box[0] % g == 0 and box[2] % g == 0
    assert box[0] > 0 and box[1] > 0 and box[2] < 256        # a small box: the whole point
    n = len(e.o.net.bounds_calls)
    e.surface(a, 1, (box[0] + 1, box[1] + 1, 4, 4), wire_img(4, 4, 2), frame_id=2, dw=256, dh=128)    # inside: no re-plan
    e.pump(2)
    assert len(e.o.net.bounds_calls) == n
    applies = len(e.o.net.applies)
    e.surface(a, 1, (230, 100, 10, 6), wire_img(10, 6, 3), frame_id=3, dw=256, dh=128)   # leaves it
    e.pump(2)
    assert len(e.o.net.bounds_calls) == n + 1 and len(e.o.net.applies) == applies + 1
    grown = e.o.net.bounds_calls[-1]["t"]
    assert grown[0] <= box[0] and grown[1] <= box[1] and grown[2] >= 240 and grown[3] >= 106 and grown[2] <= 256 and grown[3] <= 128


def test_bounds_forgotten_when_a_slot_is_removed_or_resized_and_unknown_after_restore_or_open(tmp_path):
    e, a = make(doc=[L("t", slot=1, surfaceW=64, surfaceH=32, sx=2.0), L("u", slot=2, surfaceW=64, surfaceH=32)])
    e.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8, 1))
    e.pump(2)
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("t", slot=1, surfaceW=32, surfaceH=16, sx=2.0)]})   # slot 2 gone, slot 1 resized
    e.pump(2)
    assert 1 not in e.x._pbounds and 2 not in e.x._pbounds
    assert e.o.net.bounds_calls[-1] == {}
    # a slot that comes back after having been removed is blank again: known empty
    e.send(a, {"t": "doc", "rev": 3, "layers": [L("t", slot=1, surfaceW=32, surfaceH=16, sx=2.0), L("n", slot=5, surfaceW=4, surfaceH=4)]})
    assert e.x._pbounds[5] is None
    # Open Project fills buffers without tiles: unknown
    path = tmp_path / "o.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.pump(2)
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(path)})
    e.pump(3)
    assert 5 not in e.x._pbounds and e.o.net.bounds_calls[-1] == {}


def test_restored_document_has_unknown_bounds_and_keeps_presets_and_history():
    e, a = make(doc=[L("t", slot=1, surfaceW=64, surfaceH=32, sx=2.0)])
    pres = [{"id": "b1", "name": "Chalk", "settings": {}, "tip": "chalk", "dynamics": {}}]
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("t", slot=1, surfaceW=64, surfaceH=32, sx=2.0)], "brushPresets": pres})
    e.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8, 1))
    post_history(e, a, b"hist", rev=2)
    e.pump(2)
    e.x.Freeze()
    e2 = Env(like=e)
    e2.o.storage = e.o.storage            # COMP storage comes back with the file
    e2.pump()
    assert e2.x.doc_rev == 2 and e2.x.brush_presets == pres and e2.x._pbounds == {}
    assert e2.o.net.bounds_calls[-1] == {}
    c = e2.connect("panel")
    assert get_history(e2, c)["X-Doc-Rev"] == "2"


def test_tiles_for_unknown_slots_never_create_bounds():
    e, a = make(doc=[L("t", slot=1, surfaceW=64, surfaceH=32)])
    e.x._pbounds.pop(1)
    e.surface(a, 1, (0, 0, 8, 8), wire_img(8, 8, 1))
    assert 1 not in e.x._pbounds


# --------------------------------------------------------------------------- tdPreview layer stream

W, H = 64, 32


def preview_img(seed=0):
    a = np.random.RandomState(seed).rand(H, W, 4).astype(np.float32)
    a[..., :3] *= a[..., 3:4]    # premultiplied like the network
    return a


def setup_preview(effects=(PIXSORT,), **kw):
    e, a = make(doc=[L("p1", slot=1, surfaceW=W, surfaceH=H, effects=list(effects)), L("p2", slot=2, surfaceW=W, surfaceH=H)], **kw)
    top = FakeTop("/project1/raster_editor/doc/pv_p1", W, H, cooks=1, array=preview_img(0))
    e.o.net.preview_tops["p1"] = top
    return e, a, top


def notices(e, cid):
    return e.s.messages(cid, "layerPreview")


def fetch_layer(e, cid, lid="p1", **kw):
    pars = {"token": e.x.token, "client": e.x.clients[cid].cid, "layerId": lid}
    pars.update(kw)
    return e.x.OnHTTPRequest(req("GET", "/layer", pars=pars), {})


def test_flagged_layer_is_read_back_noticed_and_served_as_frame_type_7():
    e, a, top = setup_preview()
    e.pump(6)
    (n,) = notices(e, a)
    assert n["layerId"] == "p1" and n["docW"] == W and n["docH"] == H and isinstance(n["frameId"], int)
    r = fetch_layer(e, a)
    assert r["statusCode"] == 200 and r["content-type"] == "application/octet-stream"
    h, payload = P.decode_frame(r["data"])
    assert (h.type, h.slot, h.frame_id, h.doc_w, h.doc_h, (h.x, h.y, h.w, h.h), h.frame_end) == (7, 0, n["frameId"], W, H, (0, 0, W, H), True)
    got = np.frombuffer(payload, np.uint8).reshape(H, W, 4)
    want = frames.WireConverter().to_wire(preview_img(0), True)
    assert (got == want).all()      # straight alpha, top row first


def test_unflagged_layers_and_hidden_flagged_layers_get_no_stream():
    e, a, top = setup_preview(effects=(BLUR,))
    e.pump(6)
    assert not notices(e, a) and top.calls == 0 and fetch_layer(e, a)["statusCode"] == 404
    e2, a2, top2 = setup_preview()
    e2.send(a2, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=W, surfaceH=H, effects=[PIXSORT], visible=False)]})
    e2.pump(6)
    assert not notices(e2, a2) and top2.calls == 0


def test_a_disabled_flagged_effect_is_not_flagged():
    e, a, top = setup_preview(effects=(dict(PIXSORT, enabled=False),))
    e.pump(6)
    assert not notices(e, a)


def test_filter_adjustment_with_a_flagged_effect_is_streamed():
    e, a = make(doc=[L("p1", slot=1, surfaceW=W, surfaceH=H),
                     L("adj", "adjustment", adjustment={"type": "filter", "effect": PIXSORT})])
    e.o.net.preview_tops["adj"] = FakeTop("/x", W, H, array=preview_img(3))
    e.pump(6)
    assert [n["layerId"] for n in notices(e, a)] == ["adj"]


def test_static_layer_is_not_read_back_again():
    e, a, top = setup_preview()
    e.pump(8)
    calls = top.calls
    assert calls >= 2 and len(notices(e, a)) == 1
    e.pump(40)
    assert top.calls <= calls + 1          # (one redundant read is ignored by the two-step scheme; no per-frame traffic)
    assert len(notices(e, a)) == 1


def test_changed_output_is_read_again_with_newest_only_notices():
    e, a, top = setup_preview()
    e.pump(6)
    (n1,) = notices(e, a)
    top.array, top.totalCooks = preview_img(4), top.totalCooks + 1
    e.pump(6)
    assert len(notices(e, a)) == 1           # the first notice is still un-fetched: no second one (one outstanding per client+layer)
    top.array, top.totalCooks = preview_img(5), top.totalCooks + 1
    e.pump(6)
    h0, _ = P.decode_frame(fetch_layer(e, a)["data"])    # a fetch returns the newest frame, not the announced one
    assert h0.frame_id > n1["frameId"]
    e.pump(6)
    assert len(notices(e, a)) == 1           # ...and it is the newest: nothing more to announce
    top.array, top.totalCooks = preview_img(5), top.totalCooks + 1
    e.pump(6)
    ns = notices(e, a)
    assert len(ns) == 2 and ns[1]["frameId"] > h0.frame_id
    top.array, top.totalCooks = preview_img(5), top.totalCooks
    h, payload = P.decode_frame(fetch_layer(e, a)["data"])
    assert (np.frombuffer(payload, np.uint8).reshape(H, W, 4) == frames.WireConverter().to_wire(preview_img(5), True)).all()


def test_only_the_active_editor_gets_previews():
    e, a, top = setup_preview()
    b = e.connect("external")
    e.pump(6)
    assert notices(e, a) and not notices(e, b)
    assert fetch_layer(e, b)["statusCode"] == 404
    e.send(b, {"t": "takeover"})
    e.pump(6)
    assert notices(e, b) and fetch_layer(e, b)["statusCode"] == 200
    assert fetch_layer(e, a)["statusCode"] == 404          # a is standby now


def test_no_readback_without_an_active_client():
    e, a, top = setup_preview()
    e.pump(2)
    e.x.OnWebSocketClose(a)
    calls = top.calls
    e.pump(10)
    assert top.calls == calls and e.x.layer_pipes == {}


def test_layer_request_validation_and_unknown_layers():
    e, a, top = setup_preview()
    e.pump(6)
    assert fetch_layer(e, a, lid="nope")["statusCode"] == 404
    assert fetch_layer(e, a, lid="")["statusCode"] == 404
    r = e.x.OnHTTPRequest(req("GET", "/layer", pars={"token": "bad", "client": e.x.clients[a].cid, "layerId": "p1"}), {})
    assert r["statusCode"] == 403
    r = e.x.OnHTTPRequest(req("GET", "/layer", pars={"token": e.x.token, "client": "zzz", "layerId": "p1"}), {})
    assert r["statusCode"] == 404


def test_stream_stops_when_the_effect_is_removed_and_a_missing_source_waits():
    e, a, top = setup_preview()
    e.pump(6)
    assert "p1" in e.x.layer_pipes
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=W, surfaceH=H, effects=[BLUR]), L("p2", slot=2, surfaceW=W, surfaceH=H)]})
    e.pump(3)
    assert e.x.layer_pipes == {} and fetch_layer(e, a)["statusCode"] == 404
    e.o.net.preview_tops.clear()       # flagged again but the network has no node for it (yet)
    e.send(a, {"t": "doc", "rev": 3, "layers": [L("p1", slot=1, surfaceW=W, surfaceH=H, effects=[PIXSORT])]})
    e.pump(6)
    assert fetch_layer(e, a)["statusCode"] == 404 and len(notices(e, a)) == 1


def test_replaced_source_node_restarts_the_stream():
    e, a, top = setup_preview()
    e.pump(6)
    fetch_layer(e, a)
    new = FakeTop("/x2", W, H, cooks=1, array=preview_img(9))
    e.o.net.preview_tops["p1"] = new
    e.pump(6)
    assert len(notices(e, a)) == 2
    h, payload = P.decode_frame(fetch_layer(e, a)["data"])
    assert (np.frombuffer(payload, np.uint8).reshape(H, W, 4) == frames.WireConverter().to_wire(preview_img(9), True)).all()


def test_document_resize_invalidates_previews():
    e, a, top = setup_preview(Docsizemode="fixed")
    e.pump(6)
    fetch_layer(e, a)
    e.o.par.Docw.val, e.o.par.Doch.val = 80, 40
    e.x.OnParChange(e.o.par.Docw)
    e.pump(2)
    assert e.x.layer_pipes["p1"].msg is None
    top2 = FakeTop("/x3", 80, 40, cooks=1, array=np.random.RandomState(1).rand(40, 80, 4).astype(np.float32))
    e.o.net.preview_tops["p1"] = top2
    e.pump(8)
    h, _ = P.decode_frame(fetch_layer(e, a)["data"])
    assert (h.doc_w, h.doc_h) == (80, 40)


def test_stalled_client_gets_no_more_notices_until_it_fetches():
    e, a, top = setup_preview()
    e.pump(6)
    top.array, top.totalCooks = preview_img(2), top.totalCooks + 1
    e.pump(6)
    e.clock.advance(E.STALL_S + 1)
    e.pump(2)
    assert e.x.clients[a].lp["p1"].stalled
    fetch_layer(e, a)
    assert not e.x.clients[a].lp["p1"].stalled


def test_preview_stream_converts_one_layer_per_pump_round_robin():
    layers = [L(f"p{i}", slot=i, surfaceW=W, surfaceH=H, effects=[PIXSORT]) for i in (1, 2, 3)]
    e, a = make(doc=layers)
    for i in (1, 2, 3):
        e.o.net.preview_tops[f"p{i}"] = FakeTop(f"/t{i}", W, H, array=preview_img(i))
    e.pump(20)
    assert sorted(n["layerId"] for n in notices(e, a)) == ["p1", "p2", "p3"]


def test_lp_stats_recorded():
    e, a, top = setup_preview()
    e.pump(6)
    assert len(e.x.stats["lpreadback"]) and len(e.x.stats["lppublish"])


def test_network_listed_layers_and_token_drive_the_stream():
    e, a, top = setup_preview(effects=(BLUR,))     # my own flagging says "no": the network's preview_layers() decides
    net = e.o.net
    net.token = ("t", 0)
    net.preview_layers = lambda: ["p1"]
    net.layer_preview_token = lambda lid: net.token
    e.pump(6)
    assert len(notices(e, a)) == 1
    fetch_layer(e, a)
    calls = top.calls
    top.totalCooks += 5                              # cook counts are not the signal (a lazily cooked node counts reads as cooks)
    e.pump(20)
    assert len(notices(e, a)) == 1 and top.calls <= calls + 1
    top.array = preview_img(7)
    net.token = ("t", 1)                              # the token changed: read again
    e.pump(6)
    assert len(notices(e, a)) == 2
    net.preview_layers = lambda: []
    e.pump(2)
    assert e.x.layer_pipes == {}


def test_network_listed_hidden_layers_are_skipped():
    e, a, top = setup_preview()
    e.o.net.preview_layers = lambda: ["p1"]
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=W, surfaceH=H, effects=[PIXSORT], visible=False)]})
    e.pump(6)
    assert not notices(e, a) and top.calls == 0


def test_request_doc_announces_the_newest_preview_frames_again():
    e, a, top = setup_preview()
    e.pump(6)
    fetch_layer(e, a)
    e.pump(10)
    assert len(notices(e, a)) == 1
    e.send(a, {"t": "requestDoc"})       # the page drops its previews while it loads the document
    e.pump(3)
    assert len(notices(e, a)) == 2 and notices(e, a)[1]["frameId"] == notices(e, a)[0]["frameId"]


# --------------------------------------------------------------------------- chooseFile readText

def choose_text(e, a, path, rid="r", **extra):
    e.o.par.Panelquery.val = "test=1"
    e.send(a, {"t": "chooseFile", "requestId": rid, "purpose": "readText", "testPath": path, **extra})
    e.pump(2)
    return e.s.messages(a, "fileChosen")[-1]


def test_read_text_returns_the_utf8_contents(tmp_path):
    e, a = make()
    f = tmp_path / "l.cube"
    f.write_text("TITLE \"x\"\nLUT_3D_SIZE 2\n0 0 0\n1 1 1\né", encoding="utf-8")
    m = choose_text(e, a, str(f), fileTypes=["cube", "bad type!"])
    assert m == {"t": "fileChosen", "requestId": "r", "path": str(f), "text": f.read_text(encoding="utf-8")}
    assert P.parse_choose_types({"fileTypes": ["cube", "bad type!", 5, "TXT"]}) == ["cube", "txt"]


def test_read_text_refuses_big_binary_missing_and_cancel(tmp_path):
    e, a = make()
    big = tmp_path / "big.cube"
    big.write_bytes(b"a" * (P.MAX_TEXT_FILE_BYTES + 1))
    m = choose_text(e, a, str(big), "b1")
    assert m["path"] == str(big) and "text" not in m and "too large" in m["error"]
    binf = tmp_path / "b.bin"
    binf.write_bytes(b"ab\0cd")
    assert "binary" in choose_text(e, a, str(binf), "b2")["error"]
    bad = tmp_path / "l1.cube"
    bad.write_bytes(b"\xff\xfe\xfa")
    assert "UTF-8" in choose_text(e, a, str(bad), "b3")["error"]
    assert "cannot read" in choose_text(e, a, str(tmp_path / "none.cube"), "b4")["error"]
    cancel = choose_text(e, a, None, "b5")
    assert cancel == {"t": "fileChosen", "requestId": "b5", "path": None}
    big.write_bytes(b"a" * P.MAX_TEXT_FILE_BYTES)
    assert len(choose_text(e, a, str(big), "b6")["text"]) == P.MAX_TEXT_FILE_BYTES


def test_save_project_include_history_false_omits_history_bin(tmp_path):
    e, a = make()
    post_history(e, a, b"HIST" * 10, rev=1)
    p1, p2 = tmp_path / "with.redoc", tmp_path / "without.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s1", "path": str(p1)})
    e.pump(3)
    e.send(a, {"t": "saveProject", "requestId": "s2", "path": str(p2), "includeHistory": False})
    e.pump(3)
    assert frames.read_redoc(str(p1), 1, True)[3] == b"HIST" * 10
    _, meta, _, hist = frames.read_redoc(str(p2), 1, True)
    assert hist is None and "historyRev" not in meta
    assert e.o.fetch(E.HISTORY_KEY) == (1, 1, b"HIST" * 10)        # the stored history is untouched


def test_empty_history_post_clears_and_get_is_404():
    e, a = make()
    post_history(e, a, b"x" * 10, rev=1)
    assert post_history(e, a, b"", rev=1)["statusCode"] == 204
    assert e.o.fetch(E.HISTORY_KEY) is None and get_history(e, a)["statusCode"] == 404


def test_a_read_that_bumps_the_token_is_not_a_change():
    e, a, top = setup_preview(effects=(BLUR,))
    net = e.o.net
    net.token = 0
    net.preview_layers = lambda: ["p1"]
    net.layer_preview_token = lambda lid: net.token
    real = top.numpyArray

    def lazy_read(delayed=False):
        net.token += 1            # reading cooks a lazily cooked chain
        return real(delayed)
    top.numpyArray = lazy_read
    e.pump(6)
    fetch_layer(e, a)
    calls = top.calls
    e.pump(30)
    assert top.calls <= calls + 1 and len(notices(e, a)) == 1
    net.token += 5                 # a real change still reads again
    e.pump(6)
    assert len(notices(e, a)) == 2


def test_open_project_at_a_lower_rev_never_lets_a_stale_page_win(tmp_path):
    e, a = make()
    for r in range(2, 8):
        e.send(a, {"t": "doc", "rev": r, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)]})   # TD is at rev 7
    path = tmp_path / "old.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.pump(3)
    e.send(a, {"t": "doc", "rev": 20, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32), L("p2", slot=2, surfaceW=64, surfaceH=32)]})
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(path)})
    e.pump(3)
    assert e.x.doc_rev == 21                                  # monotonic: above everything the stale page can hold
    assert [l["id"] for l in e.x.doc_layers] == ["p1"]
    # the stale page (it was disconnected during the Open) reconnects: it is told to reload and its `doc` is ignored
    assert e.x.clients[a].reloading
    e.send(a, {"t": "doc", "rev": 20, "layers": [L("zzz", slot=9, surfaceW=4, surfaceH=4)]})
    assert [l["id"] for l in e.x.doc_layers] == ["p1"]
    b = e.connect("external")
    assert e.s.messages(b, "hello")[-1]["rev"] == 21


def test_history_is_stored_after_a_successful_open_only_when_its_rev_matches_the_file(tmp_path):
    e, a, blob, path = make_saved(tmp_path)
    import zipfile
    # a file whose meta.historyRev differs from its document rev: the history is not stored (S1)
    bad = tmp_path / "bad.redoc"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(bad, "w") as zout:
        for n in zin.namelist():
            d = zin.read(n)
            if n == "meta.json":
                m = json.loads(d)
                m["historyRev"] = 99
                d = json.dumps(m).encode()
            zout.writestr(n, d)
    e.send(a, {"t": "openProject", "requestId": "o", "path": str(bad)})
    e.pump(3)
    assert result(e, a, "openProject")[-1]["ok"] is True and e.o.fetch(E.HISTORY_KEY) is None
    # a failed open keeps the old history
    post_history(e, a, b"keep", rev=e.x.doc_rev)
    e.send(a, {"t": "openProject", "requestId": "o2", "path": str(tmp_path / "missing.redoc")})
    e.pump(3)
    assert e.o.fetch(E.HISTORY_KEY)[2] == b"keep"


def test_tox_export_does_not_embed_the_history(tmp_path):
    e, a = make()
    post_history(e, a, b"private", rev=1)
    seen = []
    e.o.save = lambda p: seen.append(e.o.fetch(E.HISTORY_KEY))
    e.x._replace = lambda x, y: None
    e.x.SaveTox(str(tmp_path / "x.tox"))
    assert seen == [None] and e.o.fetch(E.HISTORY_KEY) == (1, 1, b"private")


def test_declared_oversize_body_is_refused_by_content_length():
    e, a = make()
    r = e.x.OnHTTPRequest(req("POST", "/history", b"x", pars={"token": e.x.token, "client": e.x.clients[a].cid, "rev": "1"},
                              **{"Content-Length": str(E.HISTORY_MAX_BYTES + 1)}), {})
    assert r["statusCode"] == 413 and e.o.fetch(E.HISTORY_KEY) is None


def test_brush_preset_names_are_normalised_not_rejected():
    e, a = make()
    pres = [{"id": "b1", "name": "", "settings": {}, "tip": "round", "dynamics": {}},
            {"id": "b2", "name": "n" * 400, "settings": {}, "tip": "round", "dynamics": {}},
            {"id": "b3", "settings": {}, "tip": "round", "dynamics": {}}]
    e.send(a, {"t": "doc", "rev": 2, "layers": [L("p1", slot=1, surfaceW=64, surfaceH=32)], "brushPresets": pres})
    assert not e.s.messages(a, "error")
    names = [q["name"] for q in e.x.brush_presets]
    assert names == ["Brush preset", "n" * 256, "Brush preset"]


def test_read_text_strips_a_utf8_bom(tmp_path):
    e, a = make()
    f = tmp_path / "bom.cube"
    f.write_bytes(b"\xef\xbb\xbfLUT_3D_SIZE 2\n")
    assert choose_text(e, a, str(f))["text"] == "LUT_3D_SIZE 2\n"


def test_layer_notices_are_only_created_for_flagged_layers():
    e, a, top = setup_preview()
    e.pump(6)
    for i in range(20):
        fetch_layer(e, a, lid=f"junk{i}")
    assert set(e.x.clients[a].lp) == {"p1"}
