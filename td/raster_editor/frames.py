"""Pixel conversions between the wire format and TouchDesigner (numpy only).

Wire:  uint8 RGBA, straight alpha, row 0 = TOP row, document coordinates.
TD:    uint8 (output buffer) / float32 (TOP readback) RGBA, row 0 = BOTTOM row,
       optionally premultiplied alpha.
"""

import numpy as np

CHANNELS = 4


def alloc_buffer(w: int, h: int) -> np.ndarray:
    """Persistent TD-order output buffer (transparent black)."""
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
