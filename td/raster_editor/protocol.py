"""TD <-> web wire protocol (docs/PROTOCOL.md, version 8). Pure python, no TD or numpy needed.

Binary frames: 24-byte little-endian header + RGBA8 straight-alpha payload (top row first).
JSON messages: text frames with a string field ``t``.
"""

import json
import math
import re
import struct
from typing import Iterator, NamedTuple, Optional, Tuple

PROTOCOL_VERSION = 8
APP_VERSION = "0.5.0"  # written to .redoc meta.json
MAGIC = b"REF1"
HEADER_SIZE = 24
TYPE_BASE = 1  # TD -> web, GET /base?input=N (v6: header slot = input index 1..8)
# type 2 (v1/v2 COMPOSITE) is invalid in v3
TYPE_SURFACE = 3  # web -> TD, WebSocket, one slot per frame
TYPE_SURFACE_DUMP = 4  # TD -> web, GET /surface
TYPE_VIEW = 5  # TD -> web, GET /view
TYPE_TOP_IMAGE = 6  # TD -> web, GET /top (docW/docH = the TOP's own size; the document size for renderLayer)
TYPE_LAYER_PREVIEW = 7  # TD -> web, GET /layer (v7): one tdPreview layer's content after its effects, doc-sized, slot 0
VALID_TYPES = (TYPE_BASE, TYPE_SURFACE, TYPE_SURFACE_DUMP, TYPE_VIEW, TYPE_TOP_IMAGE, TYPE_LAYER_PREVIEW)
MAX_TOPS = 2000  # `tops` list length
MAX_TOP_DIM = 8192  # importTop: width and height limit
MAX_TOP_PIXELS = 32_000_000  # importTop result: total pixels after the GPU downscale
MAX_TEXT_CHARS = 100_000
MAX_INPUTS = 8  # TD Inputs (in1..in8)
LAYER_KINDS = ("input", "base", "pixel", "group", "adjustment", "text", "shape")  # "base" = a v5 document, read as input 1
SURFACE_KINDS = ("pixel", "input")  # kinds that carry surfaceW / surfaceH
EFFECT_KINDS = ("pixel", "input", "text", "shape", "group", "adjustment")  # layer kinds that may carry effects (v7: groups / adjustments too)
MAX_HISTORY_BYTES = 256 * 1024 * 1024  # POST /history body limit (also the .redoc history.bin limit)
HISTORY_NAME = "history.bin"  # .redoc entry
MAX_BRUSH_PRESETS = 64
MAX_CUSTOM_TIP_PRESETS = 16  # presets that embed a custom tip
MAX_TIP_DIM = 512
MAX_TIP_PNG_CHARS = 2 * 1024 * 1024  # data URL length of one custom tip
MAX_FILTER_TEXT = 16 * 1024 * 1024  # one string parameter of a filter (a .cube LUT)
BRUSH_TIPS = ("round", "chalk", "bristle", "spatter", "noise", "square", "star", "custom")
MAX_EFFECTS = 32  # per layer
MAX_SKEW_DEG = 85.0  # |kx|, |ky| above this are CLAMPED by parse_doc (like the engine and the network do)
PROJECT_FORMAT = 1  # .redoc meta.json "format"
PROJECT_EXT = ".redoc"
PNG_EXT = ".png"
SHAPE_TYPES = ("rect", "ellipse", "line", "polygon")
FLAG_FRAME_END = 1
MAX_PAYLOAD = 2 * 1024 * 1024  # bytes of pixel data per message
MAX_DIM = 0xFFFF
MAX_CANVAS_DIM = 16384  # document size limit (the Docw / Doch parameters)
MAX_SURFACE_DIM = 16384  # one pixel surface: width and height ...
MAX_SURFACE_PIXELS = 8192 * 8192  # ... and total pixels (imports are limited to 8192x8192)
MAX_GUIDES = 1000  # per direction
CANVAS_MODES = ("input", "fixed")

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
    slot: int = 0  # surface slot (SURFACE / SURFACE_DUMP), input index 1..8 (BASE); 0 for VIEW, TOP_IMAGE and LAYER_PREVIEW

    @property
    def frame_end(self) -> bool:
        return bool(self.flags & FLAG_FRAME_END)

    @property
    def payload_size(self) -> int:
        return self.w * self.h * 4


# --------------------------------------------------------------------------- binary


def validate_header(h: Header) -> None:
    """Raise ProtocolError unless the header describes a legal rect inside its ``doc_w`` x ``doc_h`` (v5: for SURFACE /
    SURFACE_DUMP that is the surface size, for BASE the input size, for VIEW the document size)."""
    if h.type not in VALID_TYPES:
        raise ProtocolError(f"unknown frame type {h.type}")
    if not 0 <= h.slot <= 0xFFFF:
        raise ProtocolError(f"bad slot {h.slot}")
    if h.type == TYPE_BASE and not 1 <= h.slot <= MAX_INPUTS:
        raise ProtocolError(f"bad input index {h.slot} (BASE slot = input 1..{MAX_INPUTS})")
    if h.type == TYPE_LAYER_PREVIEW and h.slot != 0:
        raise ProtocolError(f"bad slot {h.slot} (LAYER_PREVIEW slot = 0)")
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
        MAGIC, h.type, h.flags & 0xFF, h.slot, h.frame_id & 0xFFFFFFFF,
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
    magic, typ, flags, slot, frame_id, dw, dh, x, y, w, h = _HEADER.unpack_from(mv, 0)
    if magic != MAGIC:
        raise ProtocolError("bad magic")
    hdr = Header(typ, flags, frame_id, dw, dh, x, y, w, h, slot)
    validate_header(hdr)
    payload = mv[HEADER_SIZE:]
    if len(payload) != hdr.payload_size:
        raise ProtocolError(f"payload is {len(payload)} bytes, expected {hdr.payload_size}")
    return hdr, payload


def is_stale(h: Header, doc_w: int, doc_h: int) -> bool:
    """True if the frame was produced for a different size than the receiver's (drop silently). v5: the size to
    compare with is the slot's surface size for SURFACE frames, not the document size."""
    return h.doc_w != doc_w or h.doc_h != doc_h


def rows_per_band(width: int, max_payload: int = MAX_PAYLOAD) -> int:
    return max(1, max_payload // (width * 4))


def band_rects(x: int, y: int, w: int, h: int, max_payload: int = MAX_PAYLOAD) -> Iterator[Tuple[int, int, int, int]]:
    """Split a rect into row bands of at most ``max_payload`` payload bytes (>= 1 row)."""
    step = rows_per_band(w, max_payload)
    for by in range(y, y + h, step):
        yield x, by, w, min(step, y + h - by)


def encode_frames(frame_type: int, frame_id: int, doc_w: int, doc_h: int,
                  rect: Tuple[int, int, int, int], pixels, max_payload: int = MAX_PAYLOAD,
                  slot: int = 0) -> Iterator[bytes]:
    """Lazily yield the band messages of one frame. ``pixels`` is an array-like (h, w, 4)
    uint8 holding exactly the rect (row slices become the band payloads). The last band
    carries FRAME_END."""
    x, y, w, h = rect
    if tuple(pixels.shape) != (h, w, 4):
        raise ProtocolError(f"pixels shape {tuple(pixels.shape)} does not match rect {w}x{h}")
    bands = list(band_rects(x, y, w, h, max_payload))
    for i, (bx, by, bw, bh) in enumerate(bands):
        flags = FLAG_FRAME_END if i == len(bands) - 1 else 0
        hdr = Header(frame_type, flags, frame_id, doc_w, doc_h, bx, by, bw, bh, slot)
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


def hello(doc_w: int, doc_h: int, has_input: bool, max_send_fps: float, active: bool, client_id: str = "",
          has_document: bool = False, rev=None, mode: str = "input", inputs=None) -> str:
    """``doc`` also carries the canvas ``mode``; ``inputs`` (v6, replaces ``baseSize``) is the list of
    ``{input, w, h, connected}`` (see ``inputs_msg``). ``hasInput`` = TD input 1 is connected (it drives Follow Input)."""
    return encode_json({"t": "hello", "protocol": PROTOCOL_VERSION, "doc": {"w": doc_w, "h": doc_h, "mode": mode},
                        "inputs": input_items(inputs or []),
                        "hasInput": bool(has_input), "maxSendFps": max_send_fps, "active": bool(active),
                        "clientId": client_id, "hasDocument": bool(has_document),
                        "rev": rev if has_document else None})


def input_items(items) -> list:
    """Normalise TD input state to ``[{input, w, h, connected}]`` sorted by input (a disconnected input is 0x0)."""
    out = []
    for i in sorted(items, key=lambda i: i["input"]):
        conn = bool(i.get("connected"))
        out.append({"input": int(i["input"]), "w": int(i["w"]) if conn else 0, "h": int(i["h"]) if conn else 0, "connected": conn})
    return out


def inputs_msg(items) -> str:
    """TD -> web: every TD input connector that exists (connected or not, including the spare one) with its
    resolution; sent after ``hello`` and on any connect / disconnect / resolution change. An input that is not
    listed does not exist (treat as disconnected)."""
    return encode_json({"t": "inputs", "items": input_items(items)})


def base_notice(frame_id: int, doc_w: int, doc_h: int, input: int = 1) -> str:
    """A BASE frame of ``input`` (whole input, one band) is ready: fetch it with GET /base?input=N (PROTOCOL.md §4)."""
    return encode_json({"t": "base", "input": int(input), "frameId": frame_id, "docW": doc_w, "docH": doc_h,
                        "x": 0, "y": 0, "w": doc_w, "h": doc_h})


def view_notice(frame_id: int, doc_w: int, doc_h: int, applied_frame_id: int) -> str:
    """A newer TD output frame can be fetched with GET /view (external clients in TD mode)."""
    return encode_json({"t": "view", "frameId": frame_id, "docW": doc_w, "docH": doc_h,
                        "w": doc_w, "h": doc_h, "appliedFrameId": applied_frame_id})


def layer_preview_notice(layer_id: str, frame_id: int, doc_w: int, doc_h: int) -> str:
    """v7: a newer LAYER_PREVIEW frame of ``layer_id`` (doc-sized) can be fetched with GET /layer?layerId=."""
    return encode_json({"t": "layerPreview", "layerId": layer_id, "frameId": frame_id, "docW": doc_w, "docH": doc_h})


def fonts(families) -> str:
    """Sorted, de-duplicated font family names (sent after `hello`)."""
    return encode_json({"t": "fonts", "families": sorted({str(f) for f in families if str(f).strip()}, key=lambda f: (f.casefold(), f))})


def tops(request_id, items: list) -> str:
    """Importable TOPs: [{path, w, h}], at most MAX_TOPS."""
    return encode_json({"t": "tops", "requestId": request_id,
                        "items": [{"path": i["path"], "w": int(i["w"]), "h": int(i["h"])} for i in items[:MAX_TOPS]]})


def top_ready(request_id, w: int, h: int) -> str:
    return encode_json({"t": "topReady", "requestId": request_id, "w": int(w), "h": int(h)})


def top_error(request_id, msg: str) -> str:
    return encode_json({"t": "topError", "requestId": request_id, "msg": str(msg)})


def applied(frame_id: int, td_frame: int) -> str:
    return encode_json({"t": "applied", "frameId": frame_id, "tdFrame": td_frame})


def doc_state(rev, layers: list, doc_w: int, doc_h: int, guides=None, canvas=None, brush_presets=None) -> str:
    m = {"t": "docState", "rev": rev, "layers": layers, "docW": doc_w, "docH": doc_h,
         "guides": guides if guides is not None else {"h": [], "v": []},
         "canvas": canvas if canvas is not None else {"mode": "input"}}
    if brush_presets is not None:
        m["brushPresets"] = brush_presets  # v7
    return encode_json(m)


def doc_size(w: int, h: int, has_input: bool, mode: str = "input") -> str:
    """The document / canvas size (v5: surfaces are NOT reallocated by it) and the size mode."""
    return encode_json({"t": "docSize", "w": w, "h": h, "hasInput": bool(has_input), "mode": mode})


def active(is_active: bool) -> str:
    return encode_json({"t": "active", "active": bool(is_active)})


def error(msg: str) -> str:
    return encode_json({"t": "error", "msg": str(msg)})


def file_result(request_id, op: str, ok: bool, path: str, msg=None) -> str:
    """Outcome of saveProject / openProject / exportPng (also, without a requestId, for the TD pulses)."""
    m = {"t": "fileResult", "op": op, "ok": bool(ok), "path": str(path)}
    if request_id is not None:
        m["requestId"] = request_id
    if msg:
        m["msg"] = str(msg)
    return encode_json(m)


def reload_msg(rev) -> str:
    """The stored document was replaced (Open Project): drop the document and reload it with requestDoc."""
    return encode_json({"t": "reload", "rev": rev})


def files_msg(project_file: str, png_file: str) -> str:
    return encode_json({"t": "files", "projectFile": str(project_file), "pngFile": str(png_file)})


# --- web -> TD builders (used by fake clients and tests) and validators

def ready(client: str, token: str, fresh: bool = False, version: str = "", protocol: int = PROTOCOL_VERSION) -> str:
    return encode_json({"t": "ready", "protocol": protocol, "client": client, "version": version,
                        "token": token, "fresh": bool(fresh)})


def active_layer(layer_id) -> str:
    """web -> TD (v7): the active editor's active layer (``None`` = none); a hint for the network's pass planning."""
    return encode_json({"t": "activeLayer", "id": layer_id})


def doc(rev, layers: list, guides=None, canvas=None, brush_presets=None) -> str:
    msg = {"t": "doc", "rev": rev, "layers": layers}
    if brush_presets is not None:
        msg["brushPresets"] = brush_presets
    if guides is not None:
        msg["guides"] = guides
    if canvas is not None:
        msg["canvas"] = canvas
    return encode_json(msg)


def set_canvas(w: int, h: int, mode: str) -> str:
    return encode_json({"t": "setCanvas", "w": w, "h": h, "mode": mode})


def render_layer(request_id, layer_id: str, mode=None) -> str:
    msg = {"t": "renderLayer", "requestId": request_id, "layerId": layer_id}
    if mode is not None:
        msg["mode"] = mode
    return encode_json(msg)


def render_layers(request_id, layer_ids) -> str:
    return encode_json({"t": "renderLayers", "requestId": request_id, "layerIds": list(layer_ids)})


def list_tops(request_id) -> str:
    return encode_json({"t": "listTops", "requestId": request_id})


def import_top(request_id, path: str) -> str:
    return encode_json({"t": "importTop", "requestId": request_id, "path": path})


def _file_request(t: str, request_id, path) -> str:
    m = {"t": t, "requestId": request_id}
    if path is not None:
        m["path"] = path
    return encode_json(m)


def save_project(request_id, path=None) -> str:
    return _file_request("saveProject", request_id, path)


def open_project(request_id, path=None) -> str:
    return _file_request("openProject", request_id, path)


def export_png(request_id, path=None) -> str:
    return _file_request("exportPng", request_id, path)


def choose_file(request_id, purpose: str) -> str:
    return encode_json({"t": "chooseFile", "requestId": request_id, "purpose": purpose})


def file_chosen(request_id, path, text=None, error=None) -> str:
    """TD -> web: the file the user picked in TD's dialog (``null`` = cancelled / unavailable). v7 ``readText``: ``text`` = the file's
    UTF-8 contents, or ``error`` (too large / binary / unreadable) with ``path`` still set."""
    m = {"t": "fileChosen", "requestId": request_id, "path": path}
    if text is not None:
        m["text"] = text
    if error:
        m["error"] = str(error)
    return encode_json(m)


def request_doc() -> str:
    return encode_json({"t": "requestDoc"})


def view(mode: str, zoom: float, pan_x: float, pan_y: float, rect: dict) -> str:
    return encode_json({"t": "view", "mode": mode, "zoom": zoom, "panX": pan_x, "panY": pan_y, "rect": rect})


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _int_slot(s) -> bool:
    return isinstance(s, int) and not isinstance(s, bool) and 0 <= s <= 0xFFFF


def _check(cond, what):
    if not cond:
        raise ProtocolError(f"bad {what}")


def _check_rgba(c, what):
    _check(isinstance(c, dict) and all(_num(c.get(k)) and 0 <= c[k] <= 255 for k in "rgba"), what)


def _check_opt(d, key, pred, what):
    """An optional field: absent / null is fine, otherwise it must satisfy ``pred``."""
    if d.get(key) is not None:
        _check(pred(d[key]), f"{what}.{key}")


def _is_bool(v):
    return isinstance(v, bool)


def check_text_spec(t) -> None:
    """Validate a TextSpec (DESIGN_V3 section 2.2); raises ProtocolError."""
    _check(isinstance(t, dict), "text spec")
    _check(isinstance(t.get("text"), str) and len(t["text"]) <= MAX_TEXT_CHARS, "text.text")
    _check(isinstance(t.get("font"), str) and len(t["font"]) <= 256, "text.font")
    _check(_num(t.get("size")) and 0 < t["size"] <= 0xFFFF, "text.size")
    _check_rgba(t.get("color"), "text.color")
    _check(_num(t.get("x")) and _num(t.get("y")), "text position")
    _check_opt(t, "align", lambda v: v in ("left", "center", "right"), "text")
    _check_opt(t, "bold", _is_bool, "text")
    _check_opt(t, "italic", _is_bool, "text")
    _check_opt(t, "lineHeight", lambda v: _num(v) and 0 < v <= 100, "text")
    _check_opt(t, "boxWidth", lambda v: _num(v) and v > 0, "text")


def _check_fill(f, what):
    _check(isinstance(f, dict) and _is_bool(f.get("enabled")), f"{what} fill")
    _check_rgba(f.get("color"), f"{what} fill colour")


def _check_stroke(s, what):
    _check(isinstance(s, dict) and _is_bool(s.get("enabled")), f"{what} stroke")
    _check_rgba(s.get("color"), f"{what} stroke colour")
    _check(_num(s.get("width")) and s["width"] >= 0, f"{what} stroke width")


def check_shape_spec(s) -> None:
    """Validate a ShapeSpec (DESIGN_V3 section 2.2); raises ProtocolError."""
    _check(isinstance(s, dict) and s.get("type") in SHAPE_TYPES, "shape type")
    typ = s["type"]
    if typ in ("rect", "ellipse"):
        _check(all(_num(s.get(k)) for k in ("x", "y", "w", "h")), f"{typ} geometry")
        _check_opt(s, "rotation", _num, typ)
        _check_fill(s.get("fill"), typ)
        if typ == "rect":
            _check_opt(s, "radius", lambda v: _num(v) and v >= 0, typ)
    elif typ == "line":
        _check(all(_num(s.get(k)) for k in ("x1", "y1", "x2", "y2")), "line geometry")
        _check_opt(s, "arrowStart", _is_bool, typ)
        _check_opt(s, "arrowEnd", _is_bool, typ)
    else:
        _check(all(_num(s.get(k)) for k in ("cx", "cy", "radius")) and s["radius"] >= 0, "polygon geometry")
        _check(isinstance(s.get("sides"), int) and not isinstance(s.get("sides"), bool) and 3 <= s["sides"] <= 64,
               "polygon sides")
        _check_opt(s, "innerRatio", lambda v: _num(v) and 0 < v <= 1, typ)
        _check_opt(s, "rotation", _num, typ)
        _check_fill(s.get("fill"), typ)
    _check_stroke(s.get("stroke"), typ)


def _check_surface_size(l):
    """surfaceW / surfaceH of a pixel / base layer: both absent / null, or both ints in range."""
    sw, sh = l.get("surfaceW"), l.get("surfaceH")
    if sw is None and sh is None:
        return
    for v in (sw, sh):
        _check(isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= MAX_SURFACE_DIM, f"layer {l['id']!r} surface size")
    _check(sw * sh <= MAX_SURFACE_PIXELS, f"layer {l['id']!r} surface size (too many pixels)")


def _check_guides(g):
    _check(isinstance(g, dict), "guides")
    for k in ("h", "v"):
        v = g.get(k, [])
        _check(isinstance(v, list) and len(v) <= MAX_GUIDES and all(_num(x) for x in v), f"guides.{k}")


EFFECT_TYPES = ("dropShadow", "outerGlow", "innerGlow", "stroke", "bevel", "colorOverlay", "pixelSort", "glitch",
                "chromaticAberration", "halftone")


def _in_range(lo, hi):
    return lambda v: _num(v) and lo <= v <= hi


def _is_rgba(c):
    return isinstance(c, dict) and all(_num(c.get(k)) and 0 <= c[k] <= 255 for k in "rgba")


def _is_int(lo, hi):
    return lambda v: _num(v) and v == int(v) and lo <= v <= hi


def _one_of(*vals):
    return lambda v: isinstance(v, str) and v in vals


# type -> {field: predicate}: every field is required. Lengths are document pixels, angles degrees, colours straight
# RGBA 0..255, opacity 0..1, bevel depth / glitch amount 0..100 (percent), pixelSort low / high 0..1, glitch seed an integer
# (units: effects.py docstring). Other ranges are wide sanity bounds, not the UI's slider ranges.
_EFFECT_FIELDS = {
    "dropShadow": {"dx": _in_range(-4096, 4096), "dy": _in_range(-4096, 4096), "blur": _in_range(0, 512),
                   "color": _is_rgba, "opacity": _in_range(0, 1)},
    "outerGlow": {"size": _in_range(0, 512), "color": _is_rgba, "opacity": _in_range(0, 1)},
    "innerGlow": {"size": _in_range(0, 512), "color": _is_rgba, "opacity": _in_range(0, 1)},
    "stroke": {"width": _in_range(0, 512), "color": _is_rgba, "opacity": _in_range(0, 1),
               "position": _one_of("inside", "center", "outside")},
    "bevel": {"depth": _in_range(0, 100), "size": _in_range(0, 512), "angle": _in_range(-3600, 3600),
              "highlight": _is_rgba, "shadow": _is_rgba},
    "colorOverlay": {"color": _is_rgba, "opacity": _in_range(0, 1)},
    "pixelSort": {"direction": _one_of("h", "v"), "low": _in_range(0, 1), "high": _in_range(0, 1),
                  "key": _one_of("luma", "hue")},
    "glitch": {"amount": _in_range(0, 100), "blockSize": _in_range(1, 4096), "seed": _is_int(0, 2 ** 31),
               "rgbShift": _in_range(-1000, 1000)},
    "chromaticAberration": {"amount": _in_range(-1000, 1000), "angle": _in_range(-3600, 3600)},
    "halftone": {"cellSize": _in_range(1, 512), "angle": _in_range(-3600, 3600), "shape": _one_of("dot", "line")},
}


_EFFECT_TYPE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,47}$")


def _check_filter_value(v, what, depth=0):
    """Parameters of a filter are JSON values: finite numbers, booleans, strings (<= MAX_FILTER_TEXT), short lists and plain objects."""
    if v is None or isinstance(v, bool):
        return
    if isinstance(v, (int, float)):
        _check(_num(v), what)
    elif isinstance(v, str):
        _check(len(v) <= MAX_FILTER_TEXT, what + " (too long)")
    elif isinstance(v, list):
        _check(depth < 4 and len(v) <= 4096, what)
        for x in v:
            _check_filter_value(x, what, depth + 1)
    elif isinstance(v, dict):
        _check(depth < 4 and len(v) <= 256, what)
        for k, x in v.items():
            _check(isinstance(k, str), what)
            _check_filter_value(x, what, depth + 1)
    else:
        _check(False, what)


def check_effect(e, what="effect", fx=None) -> None:
    """Validate one Effect (web/src/engine/types.ts): a ``type`` name, boolean ``enabled`` and, for the ten v5 effect types, every field
    present and in range (extra fields are ignored). Any other type name is a filter of the filters library (v7: also as the effect of a
    ``filter`` adjustment): its parameters are JSON-sane here (finite numbers, bounded strings / lists) and, when the ``effects`` module is
    passed as ``fx``, run through ``fx.norm_params`` (the spec's own clamping / defaults; it never rejects a range, only a malformed value
    raises). A filter name that is unknown to TD draws nothing. Raises ProtocolError."""
    _check(isinstance(e, dict), what)
    typ = e.get("type")
    _check(isinstance(typ, str) and _EFFECT_TYPE_NAME.match(typ) is not None, f"{what} type {typ!r}")
    _check(_is_bool(e.get("enabled")), f"{what} {typ}.enabled")
    if typ not in _EFFECT_FIELDS:
        for k, v in e.items():
            _check_filter_value(v, f"{what} {typ}.{k}")
        specs = getattr(fx, "FILTER_SPECS", None) if fx is not None else None
        if specs and typ in specs:
            try:
                fx.norm_params(specs[typ], e)
            except Exception as ex:  # noqa: BLE001 - a spec that cannot read the parameters
                raise ProtocolError(f"bad {what} {typ} parameters ({ex})") from None
        return
    for field, pred in _EFFECT_FIELDS[typ].items():
        _check(field in e and pred(e[field]), f"{what} {typ}.{field}")


def check_effects(layer: dict, fx=None) -> None:
    ef = layer.get("effects")
    if ef is None:
        return
    lid = layer.get("id")
    _check(isinstance(ef, list) and len(ef) <= MAX_EFFECTS, f"layer {lid!r} effects (a list of at most {MAX_EFFECTS})")
    if ef and layer.get("kind") not in EFFECT_KINDS:
        raise ProtocolError(f"layer {lid!r}: {layer.get('kind')} layers cannot have effects")
    for i, e in enumerate(ef):
        check_effect(e, f"layer {lid!r} effects[{i}]", fx)


def check_brush_presets(presets) -> None:
    """DocSpec.brushPresets (web/src/engine/types.ts BrushPreset): at most MAX_BRUSH_PRESETS, MAX_CUSTOM_TIP_PRESETS with a custom tip
    (PNG data URL, <= MAX_TIP_DIM square, <= MAX_TIP_PNG_CHARS)."""
    _check(isinstance(presets, list) and len(presets) <= MAX_BRUSH_PRESETS, f"brushPresets (a list of at most {MAX_BRUSH_PRESETS})")
    custom = 0
    for i, p in enumerate(presets):
        what = f"brushPresets[{i}]"
        _check(isinstance(p, dict), what)
        _check(isinstance(p.get("id"), str) and 0 < len(p["id"]) <= 256, f"{what}.id")   # (a bad name is normalised, see brush_presets_of)
        _check(isinstance(p.get("settings"), dict) and isinstance(p.get("dynamics"), dict), what)
        _check(p.get("tip") in BRUSH_TIPS, f"{what}.tip")
        _check_filter_value(p["settings"], what + ".settings")
        _check_filter_value(p["dynamics"], what + ".dynamics")
        ct = p.get("customTip")
        if ct is not None:
            custom += 1
            _check(custom <= MAX_CUSTOM_TIP_PRESETS, f"brushPresets (at most {MAX_CUSTOM_TIP_PRESETS} custom tips)")
            _check(isinstance(ct, dict), f"{what}.customTip")
            for k in ("w", "h"):
                _check(isinstance(ct.get(k), int) and not isinstance(ct.get(k), bool) and 1 <= ct[k] <= MAX_TIP_DIM, f"{what}.customTip.{k}")
            png = ct.get("png")
            _check(isinstance(png, str) and png.startswith("data:image/png;base64,") and len(png) <= MAX_TIP_PNG_CHARS,
                   f"{what}.customTip.png")
        else:
            _check(p.get("tip") != "custom", f"{what}.tip (custom needs a customTip)")


def brush_presets_of(msg: dict) -> list:
    """The validated ``brushPresets`` of a ``doc`` / stored document (missing -> [])."""
    p = msg.get("brushPresets")
    if not isinstance(p, list):
        return []
    out = []
    for q in p:
        n = q.get("name") if isinstance(q, dict) else None
        if isinstance(q, dict) and not (isinstance(n, str) and n.strip() and len(n) <= 256):
            q = dict(q, name=n.strip()[:256] if isinstance(n, str) and n.strip() else "Brush preset")   # N1: never reject a document for a name
        out.append(q)
    return out


CLASSIC_ADJUSTMENTS = {   # v2 AdjustmentSpec type -> {param: default}; the v8 effect of the same name takes the same parameters
    "levels": {"inLow": 0.0, "inHigh": 1.0, "gamma": 1.0, "outLow": 0.0, "outHigh": 1.0},
    "brightnessContrast": {"brightness": 0.0, "contrast": 0.0},
    "hueSaturation": {"hue": 0.0, "saturation": 1.0, "value": 1.0},
    "invert": {},
    "threshold": {"level": 0.5},
    "blur": {"radius": 0.0},
}


def legacy_blur_to_filter(radius):
    """Canonical migration of a v6 Blur adjustment ``{"type": "blur", "radius": r}`` (gaussian sigma = r px, 0..200, edge pixels held outside
    the document) to the blur filter: ``sigma`` = r, ``edge`` = "hold", ``radius`` = the kernel half width the planner uses for that sigma
    (4r while <= 16 px = exact path, else 3r; max 200). r < 0.05 -> radius 0 / sigma 0 (no-op).  Pure: the single definition; effects.py mirrors
    it and web/src/engine/effects/filters.ts ``legacyBlurToFilter`` too (shared/effects/legacy_blur_vectors.json is checked against all three)."""
    ok = isinstance(radius, (int, float)) and not isinstance(radius, bool) and math.isfinite(radius)
    r = min(200.0, max(0.0, float(radius) if ok else 0.0))
    if r < 0.05:
        return {"enabled": True, "type": "blur", "radius": 0.0, "sigma": 0.0, "edge": "hold"}
    return {"enabled": True, "type": "blur", "radius": min(200.0, 4.0 * r if 4.0 * r <= 16.0 else 3.0 * r), "sigma": r, "edge": "hold"}


def legacy_adjustment_effect(a, fx=None):
    """The v8 effect for a legacy ``adjustment`` spec (classic types: an effect of the same type with the same parameters, the missing ones
    defaulted; ``{type: "filter", effect}``: that effect), or ``None`` for an unknown / malformed spec (it drew nothing)."""
    if not isinstance(a, dict):
        return None
    t = a.get("type")
    if t == "filter":
        e = a.get("effect")
        return dict(e) if isinstance(e, dict) else None
    if t not in CLASSIC_ADJUSTMENTS:
        return None
    e = {"type": t, "enabled": True}
    for k, d in CLASSIC_ADJUSTMENTS[t].items():
        v = a.get(k, d)
        e[k] = v if _num(v) else d
    if t == "blur":
        return legacy_blur_to_filter(e["radius"])
    return e


def migrate_layer(l: dict, fx=None) -> dict:
    """v5 -> v6: a ``base`` layer is read as ``input: 1`` (id and everything else kept). v7 -> v8: an adjustment layer with a legacy
    ``adjustment`` spec gets ``adjustment: None`` and the spec's effect PREPENDED to its ``effects[]`` (the stack applied to everything
    below; at most MAX_EFFECTS kept). Other layers are returned as they are."""
    if l.get("kind") == "base":
        l = dict(l, kind="input", input=1)
    if l.get("kind") == "adjustment" and l.get("adjustment") is not None:
        e = legacy_adjustment_effect(l["adjustment"], fx)
        ef = l.get("effects") if isinstance(l.get("effects"), list) else []
        l = dict(l, adjustment=None, effects=(([e] if e is not None else []) + ef)[:MAX_EFFECTS])
    return l


def parse_doc(msg: dict, fx=None):
    """Validate a ``doc`` message. Returns (rev, layers) or raises ProtocolError. Checks what the TD side
    relies on: a list of objects with string id / known kind, slot / mask slots as u16 ints, finite transform
    numbers (x, y, rot finite; sx, sy > 0; kx, ky finite and clamped to +-85), surface sizes, ``input`` 1..8 on input layers, effects
    (per type and range; v7: any layer kind), text / shape specs, and that text / shape / input
    layers have no slot (TD renders them). A v5 ``base`` layer is migrated to ``input: 1`` (the returned list has
    the migrated layers). The optional ``guides`` / ``canvas`` / ``brushPresets`` are validated too; read them with ``doc_extras`` /
    ``brush_presets_of``. v7: filter-library effects (in ``effects[]`` and as ``adjustment: {type: "filter", effect}``) and effects on group /
    adjustment layers are accepted. v8: a legacy ``adjustment`` spec of an adjustment layer is migrated to ``effects[]`` (``migrate_layer``);
    ``fx`` = the ``effects`` module (optional) validates filter parameters through ``norm_params``."""
    layers = msg.get("layers")
    if not isinstance(layers, list) or not _num(msg.get("rev")):
        raise ProtocolError("doc needs a numeric rev and a layers list")
    seen = set()
    out = []
    for l in layers:
        if not isinstance(l, dict) or not isinstance(l.get("id"), str) or l.get("kind") not in LAYER_KINDS:
            raise ProtocolError("bad layer spec")
        if l.get("kind") == "adjustment" and l.get("adjustment") is not None:
            _check(isinstance(l["adjustment"], dict), f"layer {l['id']!r} adjustment")
            if l["adjustment"].get("type") == "filter":
                check_effect(l["adjustment"].get("effect"), f"layer {l['id']!r} filter adjustment", fx)
        l = migrate_layer(l, fx)
        out.append(l)
        kind = l["kind"]
        if kind in ("text", "shape"):
            (check_text_spec if kind == "text" else check_shape_spec)(l.get(kind))
        if kind in ("text", "shape", "input") and l.get("slot") is not None:
            raise ProtocolError(f"{kind} layer {l['id']!r}: {kind} layers have no surface slot")
        if kind == "input":
            n = l.get("input")
            if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= MAX_INPUTS:
                raise ProtocolError(f"input layer {l['id']!r}: bad input index {n!r} (1..{MAX_INPUTS})")
        for k in ("x", "y", "rot"):
            _check_opt(l, k, _num, f"layer {l['id']!r}")
        for k in ("sx", "sy"):
            _check_opt(l, k, lambda v: _num(v) and 0 < v <= 1e6, f"layer {l['id']!r}")
        for k in ("kx", "ky"):
            _check_opt(l, k, _num, f"layer {l['id']!r}")
            if l.get(k) is not None and abs(l[k]) > MAX_SKEW_DEG:
                l = dict(l, **{k: math.copysign(MAX_SKEW_DEG, l[k])})
                out[-1] = l
        check_effects(l, fx)
        if kind in SURFACE_KINDS:
            _check_surface_size(l)
        for s in (l.get("slot"), (l.get("mask") or {}).get("slot") if isinstance(l.get("mask"), dict) else None):
            if s is None:
                continue
            if not _int_slot(s):
                raise ProtocolError(f"bad slot {s!r}")
            if s in seen:
                raise ProtocolError(f"duplicate surface slot {s}")
            seen.add(s)
    if msg.get("guides") is not None:
        _check_guides(msg["guides"])
    if msg.get("canvas") is not None:
        c = msg["canvas"]
        _check(isinstance(c, dict) and c.get("mode") in CANVAS_MODES, "canvas")
    if msg.get("brushPresets") is not None:
        check_brush_presets(msg["brushPresets"])
    return msg["rev"], out


def doc_extras(msg: dict):
    """(guides, canvas) of a validated ``doc`` / stored document, normalised: guides ``{"h": [...], "v": [...]}``
    (document pixels, floats), canvas ``{"mode": "input" | "fixed"}``; missing -> no guides / follow input."""
    g = msg.get("guides") or {}
    guides = {"h": [float(x) for x in g.get("h", [])], "v": [float(x) for x in g.get("v", [])]}
    c = msg.get("canvas") or {}
    return guides, {"mode": c.get("mode", "input")}


def parse_set_canvas(msg: dict):
    """Validate ``setCanvas``; returns (w, h, mode). With ``mode: "input"`` w / h are ignored (returned as 0)."""
    mode = msg.get("mode")
    if mode not in CANVAS_MODES:
        raise ProtocolError("bad canvas mode")
    if mode == "input":
        return 0, 0, mode
    w, h = msg.get("w"), msg.get("h")
    for v in (w, h):
        if not _num(v) or v != int(v) or not 1 <= v <= MAX_CANVAS_DIM:
            raise ProtocolError(f"bad canvas size {w!r}x{h!r} (1..{MAX_CANVAS_DIM})")
    return int(w), int(h), mode


def parse_file_request(msg: dict):
    """Validate ``saveProject`` / ``openProject`` / ``exportPng``; returns (requestId, path or None)."""
    rid = _request_id(msg)
    path = msg.get("path")
    if path is not None and (not isinstance(path, str) or not 0 < len(path.strip()) <= 1024 or "\x00" in path):
        raise ProtocolError("bad path")
    return rid, (path.strip() if path is not None else None)


CHOOSE_PURPOSES = ("placeImage", "openProject", "saveProject", "exportPng", "readText")
MAX_TEXT_FILE_BYTES = 12 * 1024 * 1024  # readText: larger files are refused
IMAGE_EXTS = ("png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "tga", "exr", "hdr", "webp", "psd")


def parse_choose_file(msg: dict):
    """Validate ``chooseFile``; returns (requestId, purpose)."""
    rid = _request_id(msg)
    if msg.get("purpose") not in CHOOSE_PURPOSES:
        raise ProtocolError(f"bad purpose {msg.get('purpose')!r} (one of {', '.join(CHOOSE_PURPOSES)})")
    return rid, msg["purpose"]


def parse_active_layer(msg: dict):
    """Validate ``activeLayer`` (v7); returns the layer id (``None`` = no active layer)."""
    lid = msg.get("id")
    if lid is not None and (not isinstance(lid, str) or not 0 < len(lid) <= 256):
        raise ProtocolError("bad layer id")
    return lid


def parse_layer_request(pars: dict):
    """Query of ``GET /layer``: the layerId (non-empty, <= 256 chars) or ``None`` when it is missing / malformed."""
    lid = (pars or {}).get("layerId")
    return lid if isinstance(lid, str) and 0 < len(lid) <= 256 else None


def parse_history_rev(pars: dict):
    """``rev`` of ``POST /history``: a non-negative integer (the document rev the history belongs to). Raises ProtocolError."""
    v = (pars or {}).get("rev")
    try:
        f = float(v)
        ok = f == int(f) and 0 <= f < 2 ** 53 and isinstance(v, (str, int, float)) and not isinstance(v, bool)
    except (TypeError, ValueError, OverflowError):
        ok = False
    if not ok:
        raise ProtocolError("bad rev")
    return int(f)


def parse_choose_types(msg: dict) -> list:
    """Optional ``fileTypes`` hint of ``chooseFile`` (v7, readText): up to 16 extensions ``[A-Za-z0-9]{1,8}``; bad entries are dropped."""
    t = msg.get("fileTypes")
    if not isinstance(t, list):
        return []
    return [x.lower() for x in t[:16] if isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9]{1,8}", x)]


def parse_render_layer(msg: dict):
    """Validate ``renderLayer``; returns (requestId, layerId)."""
    rid = _request_id(msg)
    lid = msg.get("layerId")
    if not isinstance(lid, str) or not 0 < len(lid) <= 256:
        raise ProtocolError("bad layerId")
    return rid, lid


RENDER_MODES = ("flatten", "mergeDown")
MAX_RENDER_LAYERS = 4096


def parse_render_request(msg: dict):
    """Validate ``renderLayer`` / ``renderLayers`` (v8); returns ``{"rid", "kind": "layer" | "layers", "layerId"?, "mode"?, "layerIds"?}``.
    ``mode`` of ``renderLayer`` defaults to ``"flatten"``; ``renderLayers.layerIds`` = 1..MAX_RENDER_LAYERS distinct ids."""
    rid = _request_id(msg)
    if msg.get("t") == "renderLayers":
        ids = msg.get("layerIds")
        _check(isinstance(ids, list) and 0 < len(ids) <= MAX_RENDER_LAYERS, "layerIds")
        for i in ids:
            _check(isinstance(i, str) and 0 < len(i) <= 256, "layerIds")
        _check(len(set(ids)) == len(ids), "layerIds (duplicates)")
        return {"rid": rid, "kind": "layers", "layerIds": list(ids)}
    rid, lid = parse_render_layer(msg)
    mode = msg.get("mode", "flatten")
    _check(mode in RENDER_MODES, "mode")
    return {"rid": rid, "kind": "layer", "layerId": lid, "mode": mode}


def slot_sizes(layers: list, doc_w: int, doc_h: int, current=None) -> dict:
    """{slot: (w, h)} of every surface slot (pixel layer surfaces and masks, v5). A pixel layer's surface is its
    ``surfaceW x surfaceH``; its mask has the same size. A layer without a surface size (adjustment / group
    masks, or a v4 document) keeps the size of its existing buffer (``current``: {slot: (w, h)}), else the
    document size: a canvas resize never reallocates a surface. Masks of layers that have no surface of their own are always
    document-sized (the page loads them at that size: a stale 1080p leftover buffer would make every load fail)."""
    cur = current or {}
    out = {}
    for l in layers:
        sw, sh = l.get("surfaceW"), l.get("surfaceH")
        known = (int(sw), int(sh)) if sw is not None and sh is not None else None
        m = l.get("mask")
        for s in (l.get("slot"), m.get("slot") if isinstance(m, dict) else None):
            if s is not None:
                if l.get("kind") not in SURFACE_KINDS and l.get("slot") is None:
                    out[s] = (doc_w, doc_h)   # mask of an adjustment / group / text / shape layer: the page models it at document size
                else:
                    out[s] = known or cur.get(s) or (doc_w, doc_h)
    return out


def import_target_size(w: int, h: int, doc_w: int, doc_h: int):
    """Size of an imported TOP image on the wire: the TOP's own size, shrunk (aspect kept, never enlarged) to fit
    min(8192, 2*docW) x min(8192, 2*docH) and MAX_TOP_PIXELS."""
    s = min(1.0, min(MAX_TOP_DIM, 2 * max(1, doc_w)) / w, min(MAX_TOP_DIM, 2 * max(1, doc_h)) / h,
            (MAX_TOP_PIXELS / (w * h)) ** 0.5)
    if s >= 1.0:
        return w, h
    return max(1, int(w * s)), max(1, int(h * s))


def parse_list_tops(msg: dict):
    """Validate ``listTops``; returns its requestId (any JSON scalar, echoed back)."""
    return _request_id(msg)


def _request_id(msg):
    rid = msg.get("requestId")
    if isinstance(rid, bool) or not isinstance(rid, (str, int, float)) or (isinstance(rid, str) and len(rid) > 128):
        raise ProtocolError("bad requestId")
    return rid


def parse_import_top(msg: dict):
    """Validate ``importTop``; returns (requestId, path)."""
    rid = _request_id(msg)
    path = msg.get("path")
    if not isinstance(path, str) or not path.startswith("/") or not 1 < len(path) <= 512 or "\x00" in path:
        raise ProtocolError("bad TOP path")
    return rid, path


def parse_view(msg: dict) -> dict:
    """Validate a ``view`` message; returns the normalised dict (mode, zoom, panX, panY, rect{x,y,w,h})."""
    r = msg.get("rect")
    if msg.get("mode") not in ("local", "td") or not isinstance(r, dict) \
            or not all(_num(msg.get(k)) for k in ("zoom", "panX", "panY")) \
            or not all(_num(r.get(k)) for k in ("x", "y", "w", "h")):
        raise ProtocolError("bad view message")
    return {"mode": msg["mode"], "zoom": msg["zoom"], "panX": msg["panX"], "panY": msg["panY"],
            "rect": {k: r[k] for k in ("x", "y", "w", "h")}}


def layer_slots(layers: list) -> list:
    """Every surface slot (pixel + mask) mentioned by a layer list, in stack order, no duplicates."""
    out = []
    for l in layers:
        m = l.get("mask")
        for s in (l.get("slot"), m.get("slot") if isinstance(m, dict) else None):
            if s is not None and s not in out:
                out.append(s)
    return out


def mask_slots(layers: list) -> list:
    """The slots of mask surfaces (they start white and are grey on the wire)."""
    return [l["mask"]["slot"] for l in layers
            if isinstance(l.get("mask"), dict) and l["mask"].get("slot") is not None]
