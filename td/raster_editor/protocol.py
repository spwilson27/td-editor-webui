"""TD <-> web wire protocol (docs/PROTOCOL.md, version 1). Pure python, no TD or numpy needed.

Binary frames: 24-byte little-endian header + RGBA8 straight-alpha payload (top row first).
JSON messages: text frames with a string field ``t``.
"""

import json
import struct
from typing import Iterator, NamedTuple, Optional, Tuple

PROTOCOL_VERSION = 2
MAGIC = b"REF1"
HEADER_SIZE = 24
TYPE_BASE = 1  # TD -> web
TYPE_COMPOSITE = 2  # web -> TD
FLAG_FRAME_END = 1
MAX_PAYLOAD = 2 * 1024 * 1024  # bytes of pixel data per message
MAX_DIM = 0xFFFF

_HEADER = struct.Struct("<4sBBHIHHHHHH")
assert _HEADER.size == HEADER_SIZE


class ProtocolError(ValueError):
    """Malformed or invalid message."""


class Header(NamedTuple):
    type: int
    flags: int
    frame_id: int
    doc_w: int
    doc_h: int
    x: int
    y: int
    w: int
    h: int

    @property
    def frame_end(self) -> bool:
        return bool(self.flags & FLAG_FRAME_END)

    @property
    def payload_size(self) -> int:
        return self.w * self.h * 4


# --------------------------------------------------------------------------- binary


def validate_header(h: Header) -> None:
    """Raise ProtocolError unless the header describes a legal rect inside the document."""
    if h.type not in (TYPE_BASE, TYPE_COMPOSITE):
        raise ProtocolError(f"unknown frame type {h.type}")
    if h.doc_w < 1 or h.doc_h < 1:
        raise ProtocolError(f"bad document size {h.doc_w}x{h.doc_h}")
    if h.w < 1 or h.h < 1:
        raise ProtocolError(f"empty rect {h.w}x{h.h}")
    if h.x + h.w > h.doc_w or h.y + h.h > h.doc_h:
        raise ProtocolError(
            f"rect {h.x},{h.y} {h.w}x{h.h} outside document {h.doc_w}x{h.doc_h}"
        )


def encode_header(h: Header) -> bytes:
    validate_header(h)
    return _HEADER.pack(
        MAGIC, h.type, h.flags & 0xFF, 0, h.frame_id & 0xFFFFFFFF,
        h.doc_w, h.doc_h, h.x, h.y, h.w, h.h,
    )


def encode_message(h: Header, payload) -> bytes:
    """Header + payload as one message. ``payload`` is any buffer of exactly w*h*4 bytes
    (a C-contiguous numpy array works; non-contiguous objects need ``.tobytes()``)."""
    mv = _as_bytes_view(payload)
    if len(mv) != h.payload_size:
        raise ProtocolError(f"payload is {len(mv)} bytes, expected {h.payload_size}")
    return encode_header(h) + mv  # one copy of the payload


def _as_bytes_view(payload):
    try:
        return memoryview(payload).cast("B")
    except (TypeError, ValueError):
        return memoryview(payload.tobytes())


def decode_frame(data) -> Tuple[Header, memoryview]:
    """Parse and validate one binary message. Returns (header, payload view; no copy).

    Raises ProtocolError for bad magic/type/rect/length. Does *not* compare the document size
    with the receiver's own; callers drop stale frames themselves (see ``is_stale``)."""
    mv = memoryview(data)
    if mv.ndim != 1 or mv.itemsize != 1:
        mv = mv.cast("B")
    if len(mv) < HEADER_SIZE:
        raise ProtocolError(f"message too short ({len(mv)} bytes)")
    magic, typ, flags, _res, frame_id, dw, dh, x, y, w, h = _HEADER.unpack_from(mv, 0)
    if magic != MAGIC:
        raise ProtocolError("bad magic")
    hdr = Header(typ, flags, frame_id, dw, dh, x, y, w, h)
    validate_header(hdr)
    payload = mv[HEADER_SIZE:]
    if len(payload) != hdr.payload_size:
        raise ProtocolError(f"payload is {len(payload)} bytes, expected {hdr.payload_size}")
    return hdr, payload


def is_stale(h: Header, doc_w: int, doc_h: int) -> bool:
    """True if the frame was produced for a different document size (drop silently)."""
    return h.doc_w != doc_w or h.doc_h != doc_h


def rows_per_band(width: int, max_payload: int = MAX_PAYLOAD) -> int:
    return max(1, max_payload // (width * 4))


def band_rects(x: int, y: int, w: int, h: int, max_payload: int = MAX_PAYLOAD) -> Iterator[Tuple[int, int, int, int]]:
    """Split a rect into row bands of at most ``max_payload`` payload bytes (>= 1 row)."""
    step = rows_per_band(w, max_payload)
    for by in range(y, y + h, step):
        yield x, by, w, min(step, y + h - by)


def encode_frames(frame_type: int, frame_id: int, doc_w: int, doc_h: int,
                  rect: Tuple[int, int, int, int], pixels, max_payload: int = MAX_PAYLOAD) -> Iterator[bytes]:
    """Lazily yield the band messages of one frame. ``pixels`` is an array-like (h, w, 4)
    uint8 holding exactly the rect (row slices become the band payloads). The last band
    carries FRAME_END."""
    x, y, w, h = rect
    if tuple(pixels.shape) != (h, w, 4):
        raise ProtocolError(f"pixels shape {tuple(pixels.shape)} does not match rect {w}x{h}")
    bands = list(band_rects(x, y, w, h, max_payload))
    for i, (bx, by, bw, bh) in enumerate(bands):
        flags = FLAG_FRAME_END if i == len(bands) - 1 else 0
        hdr = Header(frame_type, flags, frame_id, doc_w, doc_h, bx, by, bw, bh)
        yield encode_message(hdr, pixels[by - y: by - y + bh])


# --------------------------------------------------------------------------- JSON


def encode_json(msg: dict) -> str:
    return json.dumps(msg, separators=(",", ":"))


def decode_json(text) -> dict:
    """Parse a JSON text message; must be an object with a string ``t``."""
    try:
        msg = json.loads(text)
    except (TypeError, ValueError) as e:
        raise ProtocolError(f"invalid JSON: {e}") from None
    if not isinstance(msg, dict) or not isinstance(msg.get("t"), str):
        raise ProtocolError("JSON message needs a string field 't'")
    return msg


def hello(doc_w: int, doc_h: int, has_input: bool, max_send_fps: float, active: bool, client_id: str = "") -> str:
    return encode_json({"t": "hello", "protocol": PROTOCOL_VERSION, "doc": {"w": doc_w, "h": doc_h},
                        "hasInput": bool(has_input), "maxSendFps": max_send_fps, "active": bool(active),
                        "clientId": client_id})


def base_notice(frame_id: int, doc_w: int, doc_h: int) -> str:
    """A BASE frame (whole document, one band) is ready: fetch it with GET /base (PROTOCOL.md §4)."""
    return encode_json({"t": "base", "frameId": frame_id, "docW": doc_w, "docH": doc_h,
                        "x": 0, "y": 0, "w": doc_w, "h": doc_h})


def doc_size(w: int, h: int, has_input: bool) -> str:
    return encode_json({"t": "docSize", "w": w, "h": h, "hasInput": bool(has_input)})


def active(is_active: bool) -> str:
    return encode_json({"t": "active", "active": bool(is_active)})


def error(msg: str) -> str:
    return encode_json({"t": "error", "msg": str(msg)})
