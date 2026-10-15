import json
import os
import struct

import numpy as np
import pytest

import protocol as P

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "fixtures")


def hdr(**kw):
    d = dict(type=P.TYPE_SURFACE, flags=0, frame_id=1, doc_w=100, doc_h=50, x=0, y=0, w=10, h=5)
    d.update(kw)
    return P.Header(**d)


def px(w, h, seed=0):
    return np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)


def test_header_layout_matches_spec():
    data = P.encode_message(hdr(frame_id=0x01020304, doc_w=0x0506, doc_h=0x0708, x=0x0203, y=0x0304, w=2, h=1,
                                flags=1, type=1), bytes(8))
    assert data[:4] == b"REF1"
    assert data[4] == 1 and data[5] == 1 and data[6:8] == b"\0\0"  # slot 0
    assert struct.unpack_from("<I", data, 8)[0] == 0x01020304
    assert struct.unpack_from("<HHHHHH", data, 12) == (0x0506, 0x0708, 0x0203, 0x0304, 2, 1)
    assert len(data) == 24 + 8


def test_slot_field_at_offset_6_roundtrips_for_every_valid_type():
    for typ in P.VALID_TYPES:
        raw = P.encode_message(hdr(type=typ, slot=0xBEEF, w=1, h=1), bytes(4))
        assert struct.unpack_from("<H", raw, 6)[0] == 0xBEEF
        got, _ = P.decode_frame(raw)
        assert got.slot == 0xBEEF and got.type == typ


def test_type_2_is_invalid_to_encode_and_decode():
    with pytest.raises(P.ProtocolError):
        P.encode_header(hdr(type=2))
    assert 2 not in P.VALID_TYPES and set(P.VALID_TYPES) == {1, 3, 4, 5, 6}


def test_slot_out_of_range_rejected():
    with pytest.raises(P.ProtocolError):
        P.encode_header(hdr(slot=0x10000))


def test_encode_frames_carries_slot_on_every_band():
    msgs = list(P.encode_frames(P.TYPE_SURFACE, 1, 4, 8, (0, 0, 4, 8), px(4, 8), max_payload=32, slot=77))
    assert len(msgs) == 4 and all(P.decode_frame(m)[0].slot == 77 for m in msgs)


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
    lambda b: b[:4] + bytes([2]) + b[5:],  # type 2 = v1/v2 COMPOSITE, invalid in v3
    lambda b: b[:4] + bytes([7]) + b[5:],
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
    (m,) = list(P.encode_frames(P.TYPE_SURFACE, 1, 4, 4, (0, 0, 4, 4), px(4, 4)))
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
    (m,) = list(P.encode_frames(P.TYPE_SURFACE, 1, 16, 16, (3, 2, 6, 4), sub))
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
    assert json.loads(P.hello(10, 20, True, 30, False, "abc")) == {
        "t": "hello", "protocol": 5, "doc": {"w": 10, "h": 20, "mode": "input"}, "baseSize": {"w": 0, "h": 0},
        "hasInput": True, "maxSendFps": 30, "active": False, "clientId": "abc", "hasDocument": False, "rev": None}
    h = json.loads(P.hello(10, 20, True, 30, True, "abc", False, None, "fixed", 640, 480))
    assert h["doc"]["mode"] == "fixed" and h["baseSize"] == {"w": 640, "h": 480}
    assert json.loads(P.hello(10, 20, False, 30, True, "abc", True, 12)) ["rev"] == 12
    assert json.loads(P.base_notice(7, 100, 50)) == {"t": "base", "frameId": 7, "docW": 100, "docH": 50,
                                                      "x": 0, "y": 0, "w": 100, "h": 50}
    assert json.loads(P.view_notice(8, 100, 50, 41)) == {"t": "view", "frameId": 8, "docW": 100, "docH": 50,
                                                          "w": 100, "h": 50, "appliedFrameId": 41}
    assert json.loads(P.applied(5, 900)) == {"t": "applied", "frameId": 5, "tdFrame": 900}
    assert json.loads(P.doc_state(3, [{"id": "a"}], 10, 20)) == {"t": "docState", "rev": 3, "layers": [{"id": "a"}],
                                                                 "docW": 10, "docH": 20, "guides": {"h": [], "v": []},
                                                                 "canvas": {"mode": "input"}}
    assert json.loads(P.doc_state(3, [], 10, 20, {"h": [4], "v": []}, {"mode": "fixed"}))["guides"] == {"h": [4], "v": []}
    assert json.loads(P.doc_size(1, 2, False)) == {"t": "docSize", "w": 1, "h": 2, "hasInput": False, "mode": "input"}
    assert json.loads(P.doc_size(1, 2, True, "fixed"))["mode"] == "fixed"
    assert json.loads(P.base_size(640, 480)) == {"t": "baseSize", "w": 640, "h": 480}
    assert json.loads(P.active(True)) == {"t": "active", "active": True}
    assert json.loads(P.error("x")) == {"t": "error", "msg": "x"}


def test_web_side_builders_roundtrip_through_decode():
    m = P.decode_json(P.ready("panel", "tok", True, "v1"))
    assert (m["t"], m["protocol"], m["client"], m["token"], m["fresh"]) == ("ready", 5, "panel", "tok", True)
    assert P.decode_json(P.request_doc()) == {"t": "requestDoc"}
    d = P.decode_json(P.doc(4, [LAYER]))
    assert P.parse_doc(d) == (4, [LAYER])
    v = P.decode_json(P.view("td", 2.0, 10, -4, {"x": 0, "y": 0, "w": 800, "h": 600}))
    assert P.parse_view(v)["rect"] == {"x": 0, "y": 0, "w": 800, "h": 600}


LAYER = {"id": "p1", "kind": "pixel", "parentId": None, "slot": 4, "mask": {"slot": 5, "enabled": True}}


@pytest.mark.parametrize("bad", [
    {"rev": 1}, {"layers": []}, {"rev": "x", "layers": []}, {"rev": 1, "layers": [1]},
    {"rev": 1, "layers": [{"id": "a", "kind": "wat"}]}, {"rev": 1, "layers": [{"id": 1, "kind": "pixel"}]},
    {"rev": 1, "layers": [{"id": "a", "kind": "pixel", "slot": -1}]},
    {"rev": 1, "layers": [{"id": "a", "kind": "pixel", "slot": 70000}]},
    {"rev": 1, "layers": [{"id": "a", "kind": "pixel", "slot": 1, "mask": {"slot": 1.5}}]},
    {"rev": 1, "layers": [{"id": "a", "kind": "pixel", "slot": 1}, {"id": "b", "kind": "pixel", "slot": 1}]},
    {"rev": 1, "layers": [{"id": "a", "kind": "pixel", "slot": 2, "mask": {"slot": 2}}]},
])
def test_parse_doc_rejects(bad):
    with pytest.raises(P.ProtocolError):
        P.parse_doc(bad)


@pytest.mark.parametrize("bad", [
    {}, {"mode": "x", "zoom": 1, "panX": 0, "panY": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}},
    {"mode": "td", "zoom": "1", "panX": 0, "panY": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}},
    {"mode": "td", "zoom": 1, "panX": 0, "panY": 0, "rect": {"x": 0, "y": 0, "w": 1}},
    {"mode": "td", "zoom": 1, "panX": 0, "panY": 0, "rect": None},
    {"mode": "td", "zoom": float("nan"), "panX": 0, "panY": 0, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}},
])
def test_parse_view_rejects(bad):
    with pytest.raises(P.ProtocolError):
        P.parse_view(bad)


def test_layer_slots_lists_pixel_and_mask_slots_once():
    ls = [{"id": "b", "kind": "base"}, LAYER, {"id": "a", "kind": "adjustment", "mask": {"slot": 6, "enabled": False}},
          {"id": "q", "kind": "pixel", "slot": 4, "mask": None}]
    assert P.layer_slots(ls) == [4, 5, 6]


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
    assert (h.type, h.slot, h.flags, h.frame_end, h.frame_id, h.doc_w, h.doc_h, h.x, h.y, h.w, h.h) == (
        exp["type"], exp["slot"], exp["flags"], exp["frameEnd"], exp["frameId"], exp["docW"], exp["docH"],
        exp["x"], exp["y"], exp["w"], exp["h"])
    assert hashlib.sha256(bytes(payload)).hexdigest() == e["payloadSha256"]
    # pixel spot check against the documented formula
    px0 = (h.x * 7 + h.y * 3) & 255
    assert payload[0] == px0


def test_stale_fixture_decodes_but_is_stale_for_current_doc():
    e = next(e for e in load_fixtures() if e["name"] == "stale_docsize")
    h, _ = P.decode_frame(open(os.path.join(FIX, e["file"]), "rb").read())
    assert P.is_stale(h, e["currentDoc"]["w"], e["currentDoc"]["h"])


def test_fixture_set_covers_v3_cases():
    names = {e["name"] for e in load_fixtures()}
    assert {"base_small", "surface_band0", "surface_band2", "surface_dump", "view_small", "invalid_type_2",
            "wrong_slot", "stale_docsize", "invalid_rect_outside"} <= names
    by = {e["name"]: e for e in load_fixtures()}
    assert by["surface_band0"]["header"]["slot"] == 5 and by["surface_dump"]["header"]["type"] == 4
    assert by["view_small"]["header"]["type"] == 5 and by["surface_no_end"]["header"]["slot"] == 300
    # v4: TOP_IMAGE carries the TOP's own size as docW/docH
    t = by["top_image"]["header"]
    assert t["type"] == 6 and (t["docW"], t["docH"], t["w"], t["h"], t["x"], t["y"], t["slot"]) == (7, 3, 7, 3, 0, 0, 0)


def test_wrong_slot_fixture_decodes_but_slot_is_unknown():
    e = next(e for e in load_fixtures() if e["name"] == "wrong_slot")
    h, _ = P.decode_frame(open(os.path.join(FIX, e["file"]), "rb").read())
    assert h.slot not in e["knownSlots"] and not P.is_stale(h, e["currentDoc"]["w"], e["currentDoc"]["h"])


# --------------------------------------------------------------------------- v4 (PROTOCOL.md section 6)

import copy  # noqa: E402


def rgba(r=0, g=0, b=0, a=255):
    return {"r": r, "g": g, "b": b, "a": a}


def text_layer(**kw):
    spec = {"text": "Hello", "font": "Arial", "size": 24, "color": rgba(1, 2, 3), "align": "center", "bold": True,
            "italic": False, "lineHeight": 1.2, "x": 5, "y": 6, "boxWidth": None}
    spec.update(kw)
    return {"id": "t", "kind": "text", "parentId": None, "slot": None, "mask": None, "text": spec, "shape": None}


def shape_layer(shape, **kw):
    d = {"id": "s", "kind": "shape", "parentId": None, "slot": None, "mask": None, "text": None, "shape": shape}
    d.update(kw)
    return d


FILL = {"enabled": True, "color": rgba(9, 9, 9)}
STROKE = {"enabled": True, "color": rgba(), "width": 3}
SHAPES = {
    "rect": {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 5, "radius": 2, "fill": FILL, "stroke": STROKE, "rotation": 15},
    "ellipse": {"type": "ellipse", "x": 0, "y": 0, "w": 10, "h": 5, "fill": FILL, "stroke": STROKE, "rotation": 0},
    "line": {"type": "line", "x1": 0, "y1": 0, "x2": 9, "y2": 9, "stroke": STROKE, "arrowStart": False, "arrowEnd": True},
    "polygon": {"type": "polygon", "cx": 5, "cy": 5, "radius": 4, "sides": 5, "innerRatio": 0.5, "fill": FILL, "stroke": STROKE,
                "rotation": 0},
}


def parse(*layers):
    return P.parse_doc({"rev": 1, "layers": list(layers)})


def test_version_and_new_frame_type():
    assert P.PROTOCOL_VERSION == 5 and P.TYPE_TOP_IMAGE == 6 and 6 in P.VALID_TYPES


def test_top_image_frame_uses_the_tops_own_size_as_doc_size():
    raw = P.encode_message(P.Header(P.TYPE_TOP_IMAGE, P.FLAG_FRAME_END, 3, 7, 3, 0, 0, 7, 3), bytes(7 * 3 * 4))
    h, payload = P.decode_frame(raw)
    assert (h.type, h.slot, h.doc_w, h.doc_h, h.frame_end, len(payload)) == (6, 0, 7, 3, True, 84)
    with pytest.raises(P.ProtocolError):  # still inside docW x docH
        P.encode_header(P.Header(P.TYPE_TOP_IMAGE, 1, 1, 7, 3, 1, 0, 7, 3))


def test_parse_doc_accepts_text_and_shape_layers_in_every_form():
    base = {"id": "base", "kind": "base", "parentId": None}
    layers = [base, text_layer(), shape_layer(SHAPES["rect"], id="s1"), shape_layer(SHAPES["ellipse"], id="s2"),
              shape_layer(SHAPES["line"], id="s3"), shape_layer(SHAPES["polygon"], id="s4"),
              {**text_layer(), "id": "tm", "mask": {"slot": 5, "enabled": True}}]
    rev, got = parse(*layers)
    assert rev == 1 and got == layers and P.layer_slots(got) == [5]


def test_parse_doc_keeps_accepting_v3_layers_without_the_new_fields():
    parse({"id": "b", "kind": "base"}, {"id": "p", "kind": "pixel", "slot": 1})


@pytest.mark.parametrize("mutate", [
    lambda l: l.update(slot=3),                                   # text / shape layers never have a surface (v5)
    lambda l: l.update(text=None),
    lambda l: l.update(text="Hello"),
    lambda l: l["text"].update(text=5),
    lambda l: l["text"].update(text="x" * (P.MAX_TEXT_CHARS + 1)),
    lambda l: l["text"].update(font=None),
    lambda l: l["text"].update(size=0),
    lambda l: l["text"].update(size=float("nan")),
    lambda l: l["text"].update(size=True),
    lambda l: l["text"].update(color=rgba(300)),
    lambda l: l["text"].update(color={"r": 1}),
    lambda l: l["text"].update(align="justify"),
    lambda l: l["text"].update(bold="no"),
    lambda l: l["text"].update(lineHeight=0),
    lambda l: l["text"].update(boxWidth=-3),
    lambda l: l["text"].update(x="1"),
    lambda l: l["text"].pop("y"),
])
def test_parse_doc_rejects_bad_text_layers(mutate):
    l = text_layer()
    mutate(l)
    with pytest.raises(P.ProtocolError):
        parse(l)


@pytest.mark.parametrize("kind,mutate", [
    ("rect", lambda s: s.update(w="10")),
    ("rect", lambda s: s.update(radius=-1)),
    ("rect", lambda s: s.pop("fill")),
    ("rect", lambda s: s["stroke"].update(width=-1)),
    ("rect", lambda s: s["fill"].update(enabled=1)),
    ("rect", lambda s: s["fill"].update(color=rgba(a=256))),
    ("rect", lambda s: s.update(rotation="x")),
    ("ellipse", lambda s: s.pop("h")),
    ("line", lambda s: s.pop("x2")),
    ("line", lambda s: s.update(arrowEnd="yes")),
    ("polygon", lambda s: s.update(sides=2)),
    ("polygon", lambda s: s.update(sides=65)),
    ("polygon", lambda s: s.update(sides=4.5)),
    ("polygon", lambda s: s.update(innerRatio=0)),
    ("polygon", lambda s: s.update(innerRatio=1.5)),
    ("polygon", lambda s: s.update(radius=-1)),
    ("polygon", lambda s: s.pop("cx")),
])
def test_parse_doc_rejects_bad_shapes(kind, mutate):
    spec = copy.deepcopy(SHAPES[kind])
    mutate(spec)
    with pytest.raises(P.ProtocolError):
        parse(shape_layer(spec))


def test_parse_doc_rejects_unknown_shape_type_and_kind():
    with pytest.raises(P.ProtocolError):
        parse(shape_layer({**SHAPES["rect"], "type": "star"}))
    with pytest.raises(P.ProtocolError):
        parse({"id": "x", "kind": "vector"})


def test_parse_doc_ignores_unknown_fields_and_checks_duplicate_slots():
    l = text_layer()
    l["future"] = 1
    l["text"]["future"] = 2
    parse(l)
    a = {"id": "a", "kind": "pixel", "slot": 2}
    b = {"id": "b", "kind": "pixel", "slot": 2, "mask": None}
    with pytest.raises(P.ProtocolError):
        parse(a, b)


def test_v4_json_builders_and_parsers():
    assert json.loads(P.fonts(["b", "A", "a", "", "B"])) == {"t": "fonts", "families": ["A", "a", "B", "b"]}
    assert json.loads(P.fonts(["Zed", "Arial", "Arial", " "])) == {"t": "fonts", "families": ["Arial", "Zed"]}
    assert json.loads(P.tops("q", [{"path": "/a", "w": 1, "h": 2}])) == {
        "t": "tops", "requestId": "q", "items": [{"path": "/a", "w": 1, "h": 2}]}
    assert len(json.loads(P.tops("q", [{"path": f"/{i}", "w": 1, "h": 1} for i in range(P.MAX_TOPS + 5)]))["items"]) == P.MAX_TOPS
    assert json.loads(P.top_ready("r", 8, 9)) == {"t": "topReady", "requestId": "r", "w": 8, "h": 9}
    assert json.loads(P.top_error("r", "nope")) == {"t": "topError", "requestId": "r", "msg": "nope"}
    assert P.parse_list_tops(P.decode_json(P.list_tops("q1"))) == "q1"
    assert P.parse_import_top(P.decode_json(P.import_top(5, "/project1/x"))) == (5, "/project1/x")


@pytest.mark.parametrize("msg", [{"requestId": "r"}, {"requestId": "r", "path": "rel"}, {"requestId": "r", "path": "/"},
                                 {"requestId": "r", "path": "/" + "a" * 600}, {"requestId": None, "path": "/a"},
                                 {"requestId": True, "path": "/a"}, {"requestId": {"a": 1}, "path": "/a"},
                                 {"requestId": "r", "path": 5}, {"requestId": "r", "path": "/a\x00"}])
def test_parse_import_top_rejects(msg):
    with pytest.raises(P.ProtocolError):
        P.parse_import_top(msg)


# --------------------------------------------------------------------------- v5 (PROTOCOL.md section 7)

def pix(id="p", **kw):
    return {"id": id, "kind": "pixel", "parentId": None, "slot": 1, "mask": None, "x": 0, "y": 0, "sx": 1, "sy": 1,
            "surfaceW": 10, "surfaceH": 5, **kw}


def test_parse_doc_v5_layer_fields_and_fractional_transforms():
    rev, got = parse({"id": "base", "kind": "base", "surfaceW": 64, "surfaceH": 32, "sx": 0.5, "sy": 0.25, "x": -3.5, "y": 0.25},
                     pix(x=1.25, y=-9.5, sx=2.5, sy=0.1), text_layer(sx=1, sy=1))
    assert rev == 1 and len(got) == 3


@pytest.mark.parametrize("bad", [
    {"sx": 0}, {"sx": -1}, {"sy": float("nan")}, {"sx": "2"}, {"sy": True}, {"sx": 1e9},
    {"x": "1"}, {"y": float("inf")},
    {"surfaceW": 0}, {"surfaceH": -3}, {"surfaceW": 1.5}, {"surfaceW": True}, {"surfaceW": 20000},
    {"surfaceW": 8193, "surfaceH": 8193}, {"surfaceW": 10, "surfaceH": None}, {"surfaceW": None, "surfaceH": 5},
])
def test_parse_doc_v5_rejects_bad_transform_and_surface_size(bad):
    with pytest.raises(P.ProtocolError):
        parse(pix(**bad))


def test_parse_doc_v5_surface_size_optional_and_ignored_on_other_kinds():
    parse(pix(surfaceW=None, surfaceH=None))
    parse({"id": "g", "kind": "group", "surfaceW": None, "surfaceH": None})
    parse({"id": "p", "kind": "pixel", "slot": 1})  # a v4 layer without any of the new fields


def test_parse_doc_guides_and_canvas():
    msg = {"rev": 1, "layers": [], "guides": {"h": [1, 2.5], "v": []}, "canvas": {"mode": "fixed"}}
    P.parse_doc(msg)
    assert P.doc_extras(msg) == ({"h": [1.0, 2.5], "v": []}, {"mode": "fixed"})
    assert P.doc_extras({"rev": 1, "layers": []}) == ({"h": [], "v": []}, {"mode": "input"})
    assert P.doc_extras({"guides": {"h": [3]}, "canvas": None}) == ({"h": [3.0], "v": []}, {"mode": "input"})
    for bad in ({"guides": "x"}, {"guides": {"h": ["a"]}}, {"guides": {"v": [float("nan")]}}, {"guides": {"h": [0] * 1001}},
                {"canvas": {"mode": "auto"}}, {"canvas": 3}, {"canvas": {}}):
        with pytest.raises(P.ProtocolError):
            P.parse_doc({"rev": 1, "layers": [], **bad})


def test_slot_sizes_per_surface_mask_follows_layer_and_fallbacks():
    layers = [{"id": "b", "kind": "base"},
              pix("a", slot=1, mask={"slot": 2, "enabled": True}, surfaceW=300, surfaceH=200),
              pix("b2", slot=3, surfaceW=7, surfaceH=9),
              {"id": "adj", "kind": "adjustment", "mask": {"slot": 4, "enabled": True}},
              {"id": "old", "kind": "pixel", "slot": 5, "surfaceW": None}]
    assert P.slot_sizes(layers, 64, 32) == {1: (300, 200), 2: (300, 200), 3: (7, 9), 4: (64, 32), 5: (64, 32)}
    # a surface without a size in the spec keeps its buffer's size (a canvas resize never reallocates)
    assert P.slot_sizes(layers, 99, 98, {4: (64, 32), 5: (10, 11), 1: (1, 1)}) == {1: (300, 200), 2: (300, 200), 3: (7, 9),
                                                                                     4: (64, 32), 5: (10, 11)}


def test_set_canvas_and_render_layer_parsers():
    assert P.parse_set_canvas(P.decode_json(P.set_canvas(800, 600, "fixed"))) == (800, 600, "fixed")
    assert P.parse_set_canvas({"mode": "input", "w": "junk"}) == (0, 0, "input")  # w, h ignored
    for bad in ({"mode": "auto", "w": 1, "h": 1}, {"mode": "fixed"}, {"mode": "fixed", "w": 0, "h": 5},
                {"mode": "fixed", "w": 5, "h": 16385}, {"mode": "fixed", "w": 1.5, "h": 5}, {"mode": "fixed", "w": True, "h": 5},
                {"mode": "fixed", "w": float("nan"), "h": 5}):
        with pytest.raises(P.ProtocolError):
            P.parse_set_canvas(bad)
    assert P.parse_render_layer(P.decode_json(P.render_layer("r1", "t1"))) == ("r1", "t1")
    for bad in ({"requestId": "r"}, {"requestId": "r", "layerId": ""}, {"requestId": "r", "layerId": 5},
                {"layerId": "t"}, {"requestId": None, "layerId": "t"}):
        with pytest.raises(P.ProtocolError):
            P.parse_render_layer(bad)


def test_v5_frames_use_surface_and_input_sizes_in_the_header():
    by = {e["name"]: e for e in load_fixtures()}
    base = by["base_input_size"]
    hb, _ = P.decode_frame(open(os.path.join(FIX, base["file"]), "rb").read())
    assert (hb.type, hb.doc_w, hb.doc_h) == (1, 6, 3) and not P.is_stale(hb, 6, 3) and P.is_stale(hb, 5, 4)
    dump = by["surface_dump_layer"]
    hd, _ = P.decode_frame(open(os.path.join(FIX, dump["file"]), "rb").read())
    cur = dump["currentSurface"]
    assert hd.slot == cur["slot"] and (hd.doc_w, hd.doc_h) == (cur["w"], cur["h"]) and not P.is_stale(hd, cur["w"], cur["h"])
    stale = by["stale_docsize"]
    hs, _ = P.decode_frame(open(os.path.join(FIX, stale["file"]), "rb").read())
    assert P.is_stale(hs, stale["currentSurface"]["w"], stale["currentSurface"]["h"])
