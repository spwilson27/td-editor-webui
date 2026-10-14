"""Generate the shared protocol fixtures (docs/fixtures/*.bin + fixtures.json).

Both the TS codec tests and the Python protocol tests decode these exact bytes and assert
the fields recorded in fixtures.json. Regenerate with:
    .venv/bin/python scripts/make_fixtures.py
Pixel (x, y) of every payload is `pixel(x, y)` below, so decoders can also spot-check
pixels: payload[(row * w + col) * 4 ...] == pixel(x + col, y + row).
"""

import hashlib
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "td", "raster_editor"))
import protocol as P  # noqa: E402

OUT = os.path.join(ROOT, "docs", "fixtures")


def pixel(x, y):
    return ((x * 7 + y * 3) & 255, (x * 13 + y * 5 + 40) & 255, (x + y * 11) & 255, 255 - ((x + y) & 63))


def rect_pixels(x, y, w, h):
    return bytes(c for row in range(h) for col in range(w) for c in pixel(x + col, y + row))


class Pix:
    """Minimal (h, w, 4) array-like for protocol.encode_frames without numpy."""
    def __init__(self, x, y, w, h):
        self.shape = (h, w, 4)
        self._rows = [rect_pixels(x, y + r, w, 1) for r in range(h)]

    def __getitem__(self, sl):
        return memoryview(b"".join(self._rows[sl]))


def entry(name, file, data, frame, valid=True, error=None):
    e = {"name": name, "file": file, "frame": frame, "valid": valid, "size": len(data)}
    if valid:
        hdr, payload = P.decode_frame(data)
        e["header"] = {"type": hdr.type, "flags": hdr.flags, "frameEnd": hdr.frame_end, "frameId": hdr.frame_id,
                       "docW": hdr.doc_w, "docH": hdr.doc_h, "x": hdr.x, "y": hdr.y, "w": hdr.w, "h": hdr.h}
        e["payloadSha256"] = hashlib.sha256(bytes(payload)).hexdigest()
    else:
        e["error"] = error
    return e


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".bin"):
            os.remove(os.path.join(OUT, f))
    entries = []

    def write(name, data, frame, **kw):
        file = name + ".bin"
        with open(os.path.join(OUT, file), "wb") as fh:
            fh.write(data)
        entries.append(entry(name, file, data, frame, **kw))

    # 1. single-band BASE frame, whole 5x4 document, FRAME_END set
    for i, m in enumerate(P.encode_frames(P.TYPE_BASE, 1, 5, 4, (0, 0, 5, 4), Pix(0, 0, 5, 4))):
        write("base_small", m, "base_small")

    # 2. multi-band COMPOSITE: 6x7 doc, rect (1,1,4,6), bands of at most 2 rows (32 bytes)
    msgs = list(P.encode_frames(P.TYPE_COMPOSITE, 7, 6, 7, (1, 1, 4, 6), Pix(1, 1, 4, 6), max_payload=32))
    assert len(msgs) == 3
    for i, m in enumerate(msgs):
        write(f"composite_band{i}", m, "composite_multiband")

    # 3. COMPOSITE with frameId near the u32 wrap, no FRAME_END (mid-frame band only)
    h = P.Header(P.TYPE_COMPOSITE, 0, 0xFFFFFFFF, 3, 3, 0, 2, 3, 1)
    write("composite_no_end", P.encode_message(h, rect_pixels(0, 2, 3, 1)), "composite_no_end")

    # invalid messages: not decodable, receivers drop them
    good = P.encode_message(P.Header(P.TYPE_BASE, 1, 9, 4, 4, 0, 0, 2, 2), rect_pixels(0, 0, 2, 2))
    write("invalid_bad_magic", b"XXXX" + good[4:], "invalid", valid=False, error="bad magic")
    write("invalid_rect_outside", bytearray(good[:16]) + struct.pack("<HHHH", 3, 3, 2, 2) + good[24:], "invalid",
          valid=False, error="rect outside document")
    write("invalid_payload_short", good[:-1], "invalid", valid=False, error="payload length mismatch")
    write("invalid_type", good[:4] + bytes([9]) + good[5:], "invalid", valid=False, error="unknown type")
    write("invalid_too_short", good[:10], "invalid", valid=False, error="message too short")

    with open(os.path.join(OUT, "fixtures.json"), "w") as fh:
        json.dump({"pixel": "r=(x*7+y*3)&255 g=(x*13+y*5+40)&255 b=(x+y*11)&255 a=255-((x+y)&63)",
                   "messages": entries}, fh, indent=2)
        fh.write("\n")
    print(f"wrote {len(entries)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
