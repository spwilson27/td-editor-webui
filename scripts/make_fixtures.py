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
        e["header"] = {"type": hdr.type, "slot": hdr.slot, "flags": hdr.flags, "frameEnd": hdr.frame_end, "frameId": hdr.frame_id,
                       "docW": hdr.doc_w, "docH": hdr.doc_h, "x": hdr.x, "y": hdr.y, "w": hdr.w, "h": hdr.h}
        e["payloadSha256"] = hashlib.sha256(bytes(payload)).hexdigest()
    else:
        e["error"] = error
    return e


def main():
    os.makedirs(OUT, exist_ok=True)
    old = os.path.join(OUT, "fixtures.json")
    if os.path.exists(old):  # remove only files this generator wrote earlier
        for e in json.load(open(old)).get("messages", []):
            path = os.path.join(OUT, e["file"])
            if os.path.exists(path):
                os.remove(path)
    entries = []

    def write(name, data, frame, **kw):
        file = name + ".bin"
        with open(os.path.join(OUT, file), "wb") as fh:
            fh.write(data)
        entries.append(entry(name, file, data, frame, **kw))

    # 1. single-band BASE frame of input 1 (v6: header slot = input index 1..8), whole 5x4 input, FRAME_END set
    for i, m in enumerate(P.encode_frames(P.TYPE_BASE, 1, 5, 4, (0, 0, 5, 4), Pix(0, 0, 5, 4), slot=1)):
        write("base_small", m, "base_small")

    # 2. multi-band SURFACE of slot 5: 6x7 doc, rect (1,1,4,6), bands of at most 2 rows (32 bytes)
    msgs = list(P.encode_frames(P.TYPE_SURFACE, 7, 6, 7, (1, 1, 4, 6), Pix(1, 1, 4, 6), max_payload=32, slot=5))
    assert len(msgs) == 3
    for i, m in enumerate(msgs):
        write(f"surface_band{i}", m, "surface_multiband")

    # 3. SURFACE for slot 300 with frameId near the u32 wrap, no FRAME_END (mid-frame band only)
    h = P.Header(P.TYPE_SURFACE, 0, 0xFFFFFFFF, 3, 3, 0, 2, 3, 1, 300)
    write("surface_no_end", P.encode_message(h, rect_pixels(0, 2, 3, 1)), "surface_no_end")

    # 4. SURFACE_DUMP (GET /surface): whole 5x4 document of slot 9, one band, FRAME_END
    (m,) = P.encode_frames(P.TYPE_SURFACE_DUMP, 3, 5, 4, (0, 0, 5, 4), Pix(0, 0, 5, 4), slot=9)
    write("surface_dump", m, "surface_dump")

    # 5. VIEW (GET /view): whole 5x4 document, slot 0
    (m,) = P.encode_frames(P.TYPE_VIEW, 12, 5, 4, (0, 0, 5, 4), Pix(0, 0, 5, 4))
    write("view_small", m, "view_small")

    # 5b. TOP_IMAGE (GET /top, v4): a 7x3 TOP; docW/docH are the TOP's own size, one band, slot 0
    (m,) = P.encode_frames(P.TYPE_TOP_IMAGE, 21, 7, 3, (0, 0, 7, 3), Pix(0, 0, 7, 3))
    write("top_image", m, "top_image")

    # 5c. v5: a BASE frame has the INPUT's size as docW/docH (here 6x3) which differs from the document (5x4)
    (m,) = P.encode_frames(P.TYPE_BASE, 31, 6, 3, (0, 0, 6, 3), Pix(0, 0, 6, 3), slot=2)
    write("base_input_size", m, "base_input_size")
    entries[-1]["currentDoc"] = {"w": 5, "h": 4}
    entries[-1]["note"] = ("v5/v6: BASE docW/docH = the input size (6x3), not the document size (5x4); not stale; "
                           "v6: slot = the input index (2 here)")

    # 5e. v6: BASE of the last input (8), frame id near the u32 wrap
    (m,) = P.encode_frames(P.TYPE_BASE, 0xFFFFFFFE, 4, 2, (0, 0, 4, 2), Pix(0, 0, 4, 2), slot=8)
    write("base_input8", m, "base_input8")
    entries[-1]["note"] = "v6: BASE for input 8 (the highest); slot = input index"

    # 5d. v5: a SURFACE_DUMP of a layer whose surface (9x2) is smaller than the document (5x4 / any); docW/docH = surface size
    (m,) = P.encode_frames(P.TYPE_SURFACE_DUMP, 4, 9, 2, (0, 0, 9, 2), Pix(0, 0, 9, 2), slot=4)
    write("surface_dump_layer", m, "surface_dump_layer")
    entries[-1]["currentDoc"] = {"w": 5, "h": 4}
    entries[-1]["currentSurface"] = {"slot": 4, "w": 9, "h": 2}
    entries[-1]["note"] = "v5: docW/docH = the slot's surface size (9x2); the document may be any size"

    # 6. valid on the wire but stale: produced for a 7x7 surface while the receiver's is 6x7;
    #    decode_frame accepts it, receivers must drop it silently (PROTOCOL.md rules)
    stale = P.Header(P.TYPE_SURFACE, 1, 11, 7, 7, 0, 0, 2, 2, 5)
    write("stale_docsize", P.encode_message(stale, rect_pixels(0, 0, 2, 2)), "stale_docsize")
    entries[-1]["currentDoc"] = {"w": 6, "h": 7}
    entries[-1]["currentSurface"] = {"slot": 5, "w": 6, "h": 7}
    entries[-1]["note"] = ("decodes fine; v5: docW/docH are compared with the slot's surface size (currentSurface), "
                           "a receiver whose slot is that size must drop it")

    # 7. valid on the wire but for a slot TD does not know (not in its last `doc`): dropped
    unk = P.Header(P.TYPE_SURFACE, 1, 13, 6, 7, 0, 0, 2, 2, 999)
    write("wrong_slot", P.encode_message(unk, rect_pixels(0, 0, 2, 2)), "wrong_slot")
    entries[-1]["currentDoc"] = {"w": 6, "h": 7}
    entries[-1]["currentSurface"] = {"slot": 5, "w": 6, "h": 7}
    entries[-1]["knownSlots"] = [5, 9]
    entries[-1]["note"] = "decodes fine; a receiver that does not know the slot must drop it"

    # invalid messages: not decodable, receivers drop them
    good = P.encode_message(P.Header(P.TYPE_BASE, 1, 9, 4, 4, 0, 0, 2, 2, 1), rect_pixels(0, 0, 2, 2))
    write("invalid_bad_magic", b"XXXX" + good[4:], "invalid", valid=False, error="bad magic")
    write("invalid_rect_outside", bytearray(good[:16]) + struct.pack("<HHHH", 3, 3, 2, 2) + good[24:], "invalid",
          valid=False, error="rect outside document")
    write("invalid_payload_short", good[:-1], "invalid", valid=False, error="payload length mismatch")
    write("invalid_type", good[:4] + bytes([9]) + good[5:], "invalid", valid=False, error="unknown type")
    write("invalid_type_2", good[:4] + bytes([2]) + good[5:], "invalid", valid=False,
          error="type 2 (v1/v2 COMPOSITE) is invalid in v3")
    write("invalid_zero_size_rect", bytearray(good[:20]) + struct.pack("<HH", 0, 2) , "invalid",
          valid=False, error="zero-width rect")
    write("invalid_too_short", good[:10], "invalid", valid=False, error="message too short")
    write("invalid_base_input0", good[:6] + struct.pack("<H", 0) + good[8:], "invalid", valid=False,
          error="v6: a BASE frame's slot is its input index 1..8 (0 is invalid)")
    write("invalid_base_input9", good[:6] + struct.pack("<H", 9) + good[8:], "invalid", valid=False,
          error="v6: a BASE frame's slot is its input index 1..8 (9 is invalid)")

    with open(os.path.join(OUT, "fixtures.json"), "w") as fh:
        json.dump({"pixel": "r=(x*7+y*3)&255 g=(x*13+y*5+40)&255 b=(x+y*11)&255 a=255-((x+y)&63)",
                   "messages": entries}, fh, indent=2)
        fh.write("\n")
    print(f"wrote {len(entries)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
