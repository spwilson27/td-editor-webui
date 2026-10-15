"""Pixel conversions between the wire format and TouchDesigner (numpy only).

Wire:  uint8 RGBA, straight alpha, row 0 = TOP row, document coordinates.
TD:    uint8 (output buffer) / float32 (TOP readback) RGBA, row 0 = BOTTOM row,
       optionally premultiplied alpha.
"""

import json
import os
import re
import struct
import zipfile
import zlib

import numpy as np

CHANNELS = 4


def alloc_buffer(w: int, h: int, white: bool = False) -> np.ndarray:
    """Persistent TD-order surface buffer: transparent black, or opaque white for mask surfaces (the engine's
    masks start fully visible)."""
    if white:
        return np.full((h, w, CHANNELS), 255, np.uint8)
    return np.zeros((h, w, CHANNELS), np.uint8)


def _div255(v: np.ndarray) -> None:
    """In place v = round(v / 255) for uint16 values <= 255*255 (exact)."""
    v += 128
    t = v >> 8
    v += t
    v >>= 8


def paste_band(buf: np.ndarray, x: int, y: int, w: int, h: int, payload, premultiply: bool) -> None:
    """Write one wire band (top-left origin rect x,y,w,h; straight RGBA8 ``payload``) into the
    TD-order buffer in place: rows are flipped, and only this band is premultiplied.
    No full-buffer work; temporaries are band sized."""
    bh, bw = buf.shape[:2]
    if x < 0 or y < 0 or w < 1 or h < 1 or x + w > bw or y + h > bh:
        raise ValueError(f"band {x},{y} {w}x{h} outside buffer {bw}x{bh}")
    src = np.frombuffer(payload, np.uint8, count=w * h * CHANNELS).reshape(h, w, CHANNELS)[::-1]
    dst = buf[bh - y - h: bh - y, x: x + w]
    if not premultiply:
        dst[...] = src
        return
    a = src[..., 3:4].astype(np.uint16)
    rgb = src[..., :3].astype(np.uint16)
    rgb *= a
    _div255(rgb)
    dst[..., :3] = rgb  # values <= 255
    dst[..., 3:4] = src[..., 3:4]


def premultiply_u8(rgba: np.ndarray) -> np.ndarray:
    """Straight -> premultiplied copy (reference implementation for tests/fixtures)."""
    out = rgba.copy()
    a = rgba[..., 3:4].astype(np.uint16)
    rgb = rgba[..., :3].astype(np.uint16)
    rgb *= a
    _div255(rgb)
    out[..., :3] = rgb
    return out


class WireConverter:
    """TD (h, w, 4) bottom-first arrays -> wire uint8 top-first, optionally unpremultiplied.

    ``convert_rows`` converts a range of wire rows so callers can spread a full-frame
    conversion over several TD frames; ``to_wire`` does it all at once."""

    def __init__(self):
        self._scratch = None

    def to_wire(self, arr: np.ndarray, unpremultiply: bool = True) -> np.ndarray:
        arr = _check(arr)
        out = np.empty(arr.shape, np.uint8)
        self.convert_rows(arr, out, 0, arr.shape[0], unpremultiply)
        return out

    @staticmethod
    def copy_rows(arr: np.ndarray, out: np.ndarray, y0: int, y1: int) -> None:
        """Rows [y0, y1) of a GPU-packed readback (float32 holding exact 0..255 integers, already in wire order
        and unpremultiplied by the ``view_pack`` shader) -> uint8: one truncating cast, ~2.5 ms for 1080p."""
        if not (0 <= y0 <= y1 <= arr.shape[0]) or out.shape != arr.shape:
            raise ValueError(f"row range {y0}:{y1} / shape {out.shape} vs {arr.shape}")
        np.copyto(out[y0:y1], arr[y0:y1], casting="unsafe")

    def convert_rows(self, arr: np.ndarray, out: np.ndarray, y0: int, y1: int, unpremultiply: bool = True) -> None:
        """Fill wire rows [y0, y1) of ``out`` (uint8, same shape as ``arr``)."""
        h = arr.shape[0]
        if not (0 <= y0 <= y1 <= h):
            raise ValueError(f"row range {y0}:{y1} outside 0..{h}")
        if y0 == y1:
            return
        # wire row y  <-  arr row h-1-y, so wire rows [y0,y1) are arr rows (h-y1 .. h-y0) reversed
        src = arr[h - y1: h - y0][::-1]
        dst = out[y0:y1]
        if arr.dtype == np.uint8:
            dst[...] = src
            if unpremultiply:
                _unpremultiply_u8_inplace(dst)
            return
        shape = dst.shape
        if self._scratch is None or self._scratch.size < dst.size:
            self._scratch = np.empty(dst.size, np.float32)
        f = self._scratch[: dst.size].reshape(shape)
        if unpremultiply:
            alpha = src[..., 3:4]
            # per-pixel 255/alpha (0 where alpha is 0): one small divide, then one multiply
            scale = np.divide(np.float32(255.0), alpha, out=np.zeros(alpha.shape, np.float32),
                              where=alpha > 0)
            np.multiply(src[..., :3], scale, out=f[..., :3])
            np.multiply(alpha, np.float32(255.0), out=f[..., 3:4])
        else:
            np.multiply(src, np.float32(255.0), out=f)
        np.clip(f, 0.0, 255.0, out=f)
        f += np.float32(0.5)
        dst[...] = f  # truncating cast of x + 0.5 == round half up


def _check(arr) -> np.ndarray:
    arr = np.asarray(arr)
    if arr.ndim != 3 or arr.shape[2] != CHANNELS:
        raise ValueError(f"expected (h, w, 4) array, got {arr.shape}")
    return arr


def _unpremultiply_u8_inplace(rgba: np.ndarray) -> None:
    a = rgba[..., 3:4].astype(np.uint16)
    rgb = rgba[..., :3].astype(np.uint16)
    rgb *= 255
    rgb += a >> 1
    np.floor_divide(rgb, np.maximum(a, 1), out=rgb)
    np.minimum(rgb, 255, out=rgb)
    rgb[(a == 0).repeat(3, axis=2)] = 0
    rgba[..., :3] = rgb


def resize_buffer(old, w: int, h: int, white: bool = False) -> np.ndarray:
    """New TD-order buffer of w x h with ``old`` copied in, anchored at the document's top-left (wire
    coordinates stay valid). TD order keeps the top rows last. The new area is transparent black, or opaque
    white for masks (``white``). With no ``old`` the buffer is entirely the fill."""
    out = alloc_buffer(w, h, white)
    if old is None:
        return out
    oh, ow = old.shape[:2]
    cw, ch = min(ow, w), min(oh, h)
    out[h - ch: h, :cw] = old[oh - ch: oh, :cw]
    return out


def from_float(arr: np.ndarray, w: int, h: int, white: bool = False) -> np.ndarray:
    """float32 (h', w', 4) TD-order TOP readback (0..1) -> uint8 buffer of w x h, anchored top-left."""
    arr = _check(arr)
    u8 = np.clip(arr * np.float32(255.0) + np.float32(0.5), 0, 255).astype(np.uint8)
    return resize_buffer(u8, w, h, white)


def convert_premultiplication(buf: np.ndarray, to_premultiplied: bool) -> None:
    """Re-encode a whole TD-order buffer in place when the ``Premultiplied`` setting flips."""
    if to_premultiplied:
        buf[...] = premultiply_u8(buf)
    else:
        _unpremultiply_u8_inplace(buf)


# --------------------------------------------------------------------------- PNG / .redoc codecs (v6 files)
#
# No PIL / cv2 dependency (TD's Python is not guaranteed to have them). The writer emits 8-bit RGBA, non-interlaced,
# filter "Sub" (vectorised) + zlib; the reader decodes 8-bit RGBA or RGB, non-interlaced, all five filter types (Sub / Up
# are vectorised, Average / Paeth are correct but a per-byte Python loop: files written by this encoder never use them).
# Palette, 16-bit, grey and interlaced PNGs are refused with a clear message. We only need to read our own files.

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_MAX_PIXELS = 8192 * 8192
REDOC_MAX_DOC_JSON = 64 * 1024 * 1024
REDOC_MAX_TOTAL = 3 * 1024 * 1024 * 1024  # declared uncompressed size of all entries
REDOC_MAX_ENTRIES = 5000
_SURFACE_NAME = re.compile(r"^surfaces/(\d{1,5})\.png$")


class FileFormatError(ValueError):
    """A PNG or .redoc file that is damaged, unsupported or exceeds a limit."""


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def encode_png(rgba: np.ndarray, level: int = 3) -> bytes:
    """(h, w, 4) uint8, row 0 = top (wire order, straight alpha) -> PNG bytes (RGBA8, Sub filter)."""
    rgba = _check(rgba)
    if rgba.dtype != np.uint8:
        raise ValueError("encode_png needs uint8")
    h, w = rgba.shape[:2]
    if w < 1 or h < 1 or w > 0x7FFFFFFF or h > 0x7FFFFFFF:
        raise ValueError(f"bad image size {w}x{h}")
    raw = np.empty((h, 1 + w * CHANNELS), np.uint8)
    raw[:, 0] = 1  # filter type Sub
    body = raw[:, 1:].reshape(h, w, CHANNELS)
    body[:, 0] = rgba[:, 0]
    if w > 1:
        np.subtract(rgba[:, 1:], rgba[:, :-1], out=body[:, 1:])  # uint8 wraps mod 256
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(memoryview(raw).cast("B"), level)) + _chunk(b"IEND", b"")


def png_size(data) -> tuple:
    """(w, h) from a PNG's IHDR without decoding it."""
    mv = bytes(memoryview(data)[:33])
    if len(mv) < 33 or mv[:8] != PNG_SIGNATURE or mv[12:16] != b"IHDR":
        raise FileFormatError("not a PNG file")
    w, h = struct.unpack(">II", mv[16:24])
    return w, h


def decode_png(data, max_pixels: int = PNG_MAX_PIXELS) -> np.ndarray:
    """PNG bytes (8-bit RGBA / RGB, non-interlaced) -> (h, w, 4) uint8, row 0 = top, straight alpha. Raises
    FileFormatError for anything else, for a bad CRC / size, or an image above ``max_pixels``."""
    mv = memoryview(data)
    if len(mv) < 33 or bytes(mv[:8]) != PNG_SIGNATURE:
        raise FileFormatError("not a PNG file")
    pos, idat, ihdr, seen_end = 8, [], None, False
    while pos + 12 <= len(mv):
        (length,) = struct.unpack(">I", mv[pos:pos + 4])
        tag = bytes(mv[pos + 4:pos + 8])
        end = pos + 8 + length
        if end + 4 > len(mv):
            raise FileFormatError("truncated PNG")
        body = mv[pos + 8:end]
        (crc,) = struct.unpack(">I", mv[end:end + 4])
        if zlib.crc32(tag + bytes(body)) & 0xFFFFFFFF != crc:
            raise FileFormatError(f"bad PNG checksum in {tag.decode('latin1')}")
        if tag == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", bytes(body))
        elif tag == b"IDAT":
            idat.append(body)
        elif tag == b"IEND":
            seen_end = True
            break
        pos = end + 4
    if ihdr is None or not seen_end or not idat:
        raise FileFormatError("incomplete PNG")
    w, h, depth, ctype, comp, filt, interlace = ihdr
    if depth != 8 or ctype not in (2, 6) or comp != 0 or filt != 0 or interlace != 0:
        raise FileFormatError(f"unsupported PNG (bit depth {depth}, colour type {ctype}, interlace {interlace}): "
                              "only 8-bit RGB / RGBA, non-interlaced")
    if w < 1 or h < 1 or w * h > max_pixels:
        raise FileFormatError(f"PNG size {w}x{h} is outside the limit ({max_pixels} pixels)")
    bpp = 4 if ctype == 6 else 3
    stride = w * bpp
    want = h * (stride + 1)
    d = zlib.decompressobj()
    try:
        raw = d.decompress(b"".join(bytes(c) for c in idat), want + 1)
    except zlib.error as e:
        raise FileFormatError(f"damaged PNG data: {e}") from None
    if len(raw) != want or d.unconsumed_tail:
        raise FileFormatError("PNG data has the wrong length")
    rows = np.frombuffer(raw, np.uint8).reshape(h, stride + 1)
    ftypes = rows[:, 0]
    out = np.empty((h, w, bpp), np.uint8)
    prev = np.zeros((w, bpp), np.uint8)
    for y in range(h):
        line = rows[y, 1:].reshape(w, bpp)
        ft = int(ftypes[y])
        if ft == 0:
            cur = line.copy()
        elif ft == 1:  # Sub
            cur = np.cumsum(line, axis=0, dtype=np.uint8)
        elif ft == 2:  # Up
            cur = line + prev
        elif ft == 3:  # Average
            cur = line.copy()
            for x in range(w):
                left = cur[x - 1].astype(np.uint16) if x else np.zeros(bpp, np.uint16)
                cur[x] = line[x] + ((left + prev[x]) >> 1).astype(np.uint8)
        elif ft == 4:  # Paeth
            cur = line.copy()
            for x in range(w):
                a = cur[x - 1].astype(np.int16) if x else np.zeros(bpp, np.int16)
                b = prev[x].astype(np.int16)
                c = prev[x - 1].astype(np.int16) if x else np.zeros(bpp, np.int16)
                p = a + b - c
                pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
                pred = np.where((pa <= pb) & (pa <= pc), a, np.where(pb <= pc, b, c))
                cur[x] = line[x] + pred.astype(np.uint8)
        else:
            raise FileFormatError(f"bad PNG filter type {ft}")
        out[y] = cur
        prev = cur
    if bpp == 3:
        rgba = np.empty((h, w, 4), np.uint8)
        rgba[..., :3] = out
        rgba[..., 3] = 255
        return rgba
    return out


def buffer_to_straight(buf: np.ndarray, premultiplied: bool) -> np.ndarray:
    """A TD-order surface buffer (bottom row first, premultiplied or not) -> new wire-order straight RGBA8 array."""
    out = np.empty(buf.shape, np.uint8)
    out[...] = buf[::-1]
    if premultiplied:
        _unpremultiply_u8_inplace(out)
    return out


def straight_to_buffer(img: np.ndarray, premultiply: bool) -> np.ndarray:
    """Wire-order straight RGBA8 -> new TD-order buffer (flipped, premultiplied when asked)."""
    out = np.ascontiguousarray(img[::-1])
    if premultiply:
        out = premultiply_u8(out)
    return out


def surface_entry(slot: int) -> str:
    return f"surfaces/{int(slot)}.png"


def write_redoc(path: str, doc: dict, surfaces, meta: dict, level: int = 3, replace=os.replace) -> None:
    """Write a project: ``doc.json`` + ``surfaces/<slot>.png`` + ``meta.json`` into ``path + ".part"`` and rename
    it over ``path`` (a failed write never damages an existing file; the temp file is removed). ``surfaces`` yields
    ``(slot, rgba)`` with straight wire-order RGBA8; PNGs are stored, not deflated again."""
    tmp = path + ".part"
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr("meta.json", json.dumps(meta, separators=(",", ":")))
            z.writestr("doc.json", doc if isinstance(doc, (str, bytes)) else json.dumps(doc, separators=(",", ":")))
            for slot, rgba in surfaces:
                z.writestr(zipfile.ZipInfo(surface_entry(slot), (2000, 1, 1, 0, 0, 0)), encode_png(rgba, level),
                           zipfile.ZIP_STORED)
        replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def write_png_file(path: str, rgba: np.ndarray, level: int = 3, replace=os.replace) -> None:
    """Encode ``rgba`` (wire order, straight) to ``path`` through ``path + ".part"`` + rename."""
    tmp = path + ".part"
    try:
        with open(tmp, "wb") as f:
            f.write(encode_png(rgba, level))
        replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def read_redoc(path: str, max_format: int = 1):
    """Open a project: returns ``(doc, meta, {slot: png bytes})``. Validates the container only (entry names, declared
    sizes, JSON, ``meta.format`` <= ``max_format``); the document and the images are checked by the caller."""
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise FileFormatError(f"not a project file ({e})") from None
    with z:
        infos = {i.filename: i for i in z.infolist()}
        if len(infos) > REDOC_MAX_ENTRIES or sum(i.file_size for i in infos.values()) > REDOC_MAX_TOTAL:
            raise FileFormatError("project file is too large")
        for need in ("doc.json", "meta.json"):
            if need not in infos:
                raise FileFormatError(f"project file has no {need}")
        for name in ("doc.json", "meta.json"):
            if infos[name].file_size > REDOC_MAX_DOC_JSON:
                raise FileFormatError(f"{name} is too large")
        try:
            meta = json.loads(z.read("meta.json"))
            doc = json.loads(z.read("doc.json"))
        except (ValueError, zipfile.BadZipFile, zlib.error) as e:
            raise FileFormatError(f"damaged project file ({e})") from None
        if not isinstance(meta, dict) or not isinstance(meta.get("format"), int) or isinstance(meta.get("format"), bool):
            raise FileFormatError("project file has no format version")
        if meta["format"] > max_format or meta["format"] < 1:
            raise FileFormatError(f"project format {meta['format']} is not supported (this editor reads format {max_format})")
        if not isinstance(doc, dict):
            raise FileFormatError("doc.json is not an object")
        pngs = {}
        for name, info in infos.items():
            m = _SURFACE_NAME.match(name)
            if m:
                if info.file_size > PNG_MAX_PIXELS * 4 + 4096:
                    raise FileFormatError(f"{name} is too large")
                try:
                    pngs[int(m.group(1))] = z.read(name)
                except (zipfile.BadZipFile, zlib.error) as e:
                    raise FileFormatError(f"damaged {name} ({e})") from None
        return doc, meta, pngs
