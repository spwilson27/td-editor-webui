import json
import os
import struct

import numpy as np
import pytest

import protocol as P

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "fixtures")


def hdr(**kw):
    d = dict(type=P.TYPE_COMPOSITE, flags=0, frame_id=1, doc_w=100, doc_h=50, x=0, y=0, w=10, h=5)
    d.update(kw)
    return P.Header(**d)


def px(w, h, seed=0):
    return np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)


def test_header_layout_matches_spec():
    data = P.encode_message(hdr(frame_id=0x01020304, doc_w=0x0506, doc_h=0x0708, x=0x0203, y=0x0304, w=2, h=1,
                                flags=1, type=1), bytes(8))
    assert data[:4] == b"REF1"
    assert data[4] == 1 and data[5] == 1 and data[6:8] == b"\0\0"
    assert struct.unpack_from("<I", data, 8)[0] == 0x01020304
    assert struct.unpack_from("<HHHHHH", data, 12) == (0x0506, 0x0708, 0x0203, 0x0304, 2, 1)
    assert len(data) == 24 + 8


def test_roundtrip():
    h = hdr(x=3, y=4, w=7, h=2, flags=P.FLAG_FRAME_END, frame_id=0xFFFFFFFF)
    p = px(7, 2)
    got, payload = P.decode_frame(P.encode_message(h, p))
    assert got == h and got.frame_end
    assert bytes(payload) == p.tobytes()


def test_payload_is_view_not_copy():
    data = bytearray(P.encode_message(hdr(w=1, h=1), bytes(4)))
    _, payload = P.decode_frame(data)
    data[24] = 99
    assert payload[0] == 99


def test_frame_id_wraps():
    assert P.encode_message(hdr(frame_id=2 ** 32 + 5, w=1, h=1), bytes(4))[8:12] == struct.pack("<I", 5)


@pytest.mark.parametrize("mutate", [
    lambda b: b"XXXX" + b[4:],
    lambda b: b[:10],
    lambda b: b[:-1],
    lambda b: b + b"\0",
    lambda b: b[:4] + bytes([0]) + b[5:],  # type 0
    lambda b: b[:4] + bytes([3]) + b[5:],  # type 3
    lambda b: b"",
])
def test_invalid_frames_rejected(mutate):
    good = P.encode_message(hdr(w=2, h=2), bytes(16))
    with pytest.raises(P.ProtocolError):
        P.decode_frame(mutate(good))


@pytest.mark.parametrize("fields", [
    dict(w=0), dict(h=0), dict(x=95, w=10), dict(y=48, h=5), dict(doc_w=0), dict(doc_h=0),
])
def test_invalid_rects_rejected_on_decode_and_encode(fields):
    h = hdr(**fields)
    with pytest.raises(P.ProtocolError):
        P.encode_header(h)
    raw = bytearray(P.encode_message(hdr(w=1, h=1), bytes(4)))
    struct.pack_into("<HHHHHH", raw, 12, h.doc_w, h.doc_h, h.x, h.y, h.w, h.h)
    with pytest.raises(P.ProtocolError):
        P.decode_frame(bytes(raw) + bytes(h.w * h.h * 4 - 4 if h.w * h.h * 4 > 4 else 0))


def test_rect_touching_document_edge_is_valid():
    P.encode_header(hdr(x=90, w=10, y=45, h=5))


def test_encode_payload_length_mismatch():
    with pytest.raises(P.ProtocolError):
        P.encode_message(hdr(w=2, h=2), bytes(15))


def test_stale_doc_size_detection():
    h = hdr()
    assert not P.is_stale(h, 100, 50)
    assert P.is_stale(h, 100, 51) and P.is_stale(h, 99, 50)


def test_unknown_flag_and_reserved_bits_tolerated():
    raw = bytearray(P.encode_message(hdr(w=1, h=1), bytes(4)))
    raw[5] = 0xFE | 1
    raw[6] = 7
    h, _ = P.decode_frame(bytes(raw))
    assert h.frame_end


def test_decode_accepts_noncontiguous_memoryview_types():
    data = P.encode_message(hdr(w=1, h=1), bytes(4))
    P.decode_frame(memoryview(data))
    P.decode_frame(np.frombuffer(data, np.uint8))


# ---- banding

def test_rows_per_band_exactly_2mb():
    # 2 MB = 524288 px. width 1024 -> 4096 bytes/row -> 512 rows exactly
    assert P.rows_per_band(1024) == 512
    assert P.rows_per_band(1025) == 511
    assert P.rows_per_band(1) == 524288
    assert P.rows_per_band(10 ** 6) == 1  # always at least one row


def test_band_split_exactly_at_limit():
    one = list(P.band_rects(0, 0, 1024, 512))
    assert one == [(0, 0, 1024, 512)]
    two = list(P.band_rects(0, 0, 1024, 513))
    assert two == [(0, 0, 1024, 512), (0, 512, 1024, 1)]


def test_bands_cover_rect_without_overlap_and_respect_limit():
    x, y, w, h = 5, 7, 333, 1500
    bands = list(P.band_rects(x, y, w, h))
    assert bands[0][1] == y
    pos = y
    for bx, by, bw, bh in bands:
        assert (bx, bw) == (x, w) and by == pos and bw * bh * 4 <= P.MAX_PAYLOAD
        pos += bh
    assert pos == y + h


def test_encode_frames_flags_and_content():
    pix = px(8, 10, 3)
    msgs = list(P.encode_frames(P.TYPE_BASE, 5, 20, 30, (4, 6, 8, 10), pix, max_payload=8 * 4 * 3))
    assert len(msgs) == 4  # 3+3+3+1 rows
    heads = [P.decode_frame(m)[0] for m in msgs]
    assert [h.frame_end for h in heads] == [False, False, False, True]
    assert [h.y for h in heads] == [6, 9, 12, 15] and all(h.frame_id == 5 for h in heads)
    rebuilt = np.concatenate([np.frombuffer(P.decode_frame(m)[1], np.uint8).reshape(-1, 8, 4) for m in msgs])
    assert (rebuilt == pix).all()


def test_encode_frames_single_band_has_frame_end():
    (m,) = list(P.encode_frames(P.TYPE_COMPOSITE, 1, 4, 4, (0, 0, 4, 4), px(4, 4)))
    assert P.decode_frame(m)[0].frame_end


def test_encode_frames_full_hd_is_four_bands_under_2mb():
    pix = np.zeros((1080, 1920, 4), np.uint8)
    msgs = list(P.encode_frames(P.TYPE_BASE, 1, 1920, 1080, (0, 0, 1920, 1080), pix))
    assert len(msgs) == 4
    assert all(len(m) - P.HEADER_SIZE <= P.MAX_PAYLOAD for m in msgs)
    assert sum(P.decode_frame(m)[0].h for m in msgs) == 1080


def test_encode_frames_noncontiguous_pixels():
    big = px(16, 16)
    sub = big[2:6, 3:9]  # not contiguous
    (m,) = list(P.encode_frames(P.TYPE_COMPOSITE, 1, 16, 16, (3, 2, 6, 4), sub))
    assert bytes(P.decode_frame(m)[1]) == sub.tobytes()


def test_encode_frames_shape_mismatch():
    with pytest.raises(P.ProtocolError):
        list(P.encode_frames(P.TYPE_BASE, 1, 8, 8, (0, 0, 4, 4), px(3, 4)))


# ---- JSON

def test_json_decode_ok_and_unknown_fields_pass_through():
    m = P.decode_json('{"t":"ready","protocol":1,"client":"panel","extra":[1]}')
    assert m["t"] == "ready" and m["extra"] == [1]


@pytest.mark.parametrize("bad", ["", "nope", "[]", "{}", '{"t":1}', "null", None])
def test_json_decode_rejects(bad):
    with pytest.raises(P.ProtocolError):
        P.decode_json(bad)


def test_json_builders():
    assert json.loads(P.hello(10, 20, True, 30, False)) == {
        "t": "hello", "protocol": 1, "doc": {"w": 10, "h": 20}, "hasInput": True, "maxSendFps": 30, "active": False}
    assert json.loads(P.doc_size(1, 2, False)) == {"t": "docSize", "w": 1, "h": 2, "hasInput": False}
    assert json.loads(P.active(True)) == {"t": "active", "active": True}
    assert json.loads(P.error("x")) == {"t": "error", "msg": "x"}


# ---- shared fixtures

def load_fixtures():
    with open(os.path.join(FIX, "fixtures.json")) as f:
        return json.load(f)["messages"]


@pytest.mark.parametrize("e", load_fixtures(), ids=lambda e: e["name"])
def test_shared_fixtures(e):
    import hashlib
    with open(os.path.join(FIX, e["file"]), "rb") as f:
        data = f.read()
    assert len(data) == e["size"]
    if not e["valid"]:
        with pytest.raises(P.ProtocolError):
            P.decode_frame(data)
        return
    h, payload = P.decode_frame(data)
    exp = e["header"]
    assert (h.type, h.flags, h.frame_end, h.frame_id, h.doc_w, h.doc_h, h.x, h.y, h.w, h.h) == (
        exp["type"], exp["flags"], exp["frameEnd"], exp["frameId"], exp["docW"], exp["docH"],
        exp["x"], exp["y"], exp["w"], exp["h"])
    assert hashlib.sha256(bytes(payload)).hexdigest() == e["payloadSha256"]
    # pixel spot check against the documented formula
    px0 = (h.x * 7 + h.y * 3) & 255
    assert payload[0] == px0


def test_stale_fixture_decodes_but_is_stale_for_current_doc():
    e = next(e for e in load_fixtures() if e["name"] == "stale_docsize")
    h, _ = P.decode_frame(open(os.path.join(FIX, e["file"]), "rb").read())
    assert P.is_stale(h, e["currentDoc"]["w"], e["currentDoc"]["h"])
