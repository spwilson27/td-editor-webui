import numpy as np
import pytest

import frames as F


def rnd(h, w, seed=0):
    return np.random.RandomState(seed).randint(0, 256, (h, w, 4), dtype=np.uint8)


def ref_premul(rgba):
    out = rgba.astype(np.float64)
    out[..., :3] = np.floor(out[..., :3] * out[..., 3:4] / 255.0 + 0.5)
    return out.astype(np.uint8)


# ---- paste_band

def test_paste_flips_rows_without_premultiply():
    buf = F.alloc_buffer(6, 5)
    band = rnd(2, 3)
    F.paste_band(buf, 1, 1, 3, 2, band.tobytes(), False)
    # wire rows y=1,2 of a 5-row doc live at TD rows 3 and 2 (bottom-first)
    assert (buf[3, 1:4] == band[0]).all()
    assert (buf[2, 1:4] == band[1]).all()
    # everything else untouched
    mask = np.ones(buf.shape[:2], bool)
    mask[2:4, 1:4] = False
    assert not buf[mask].any()


def test_paste_top_and_bottom_rows():
    buf = F.alloc_buffer(2, 4)
    top = np.full((1, 2, 4), 9, np.uint8)
    bottom = np.full((1, 2, 4), 7, np.uint8)
    F.paste_band(buf, 0, 0, 2, 1, top.tobytes(), False)
    F.paste_band(buf, 0, 3, 2, 1, bottom.tobytes(), False)
    assert (buf[3] == 9).all() and (buf[0] == 7).all()


def test_paste_premultiply_matches_reference():
    buf = F.alloc_buffer(32, 16)
    band = rnd(16, 32, 5)
    F.paste_band(buf, 0, 0, 32, 16, band, True)
    assert (buf == ref_premul(band)[::-1]).all()


def test_premultiply_alpha_extremes():
    band = np.array([[[200, 100, 50, 0], [200, 100, 50, 255], [255, 255, 255, 128], [1, 1, 1, 1]]], np.uint8)
    buf = F.alloc_buffer(4, 1)
    F.paste_band(buf, 0, 0, 4, 1, band.tobytes(), True)
    assert buf[0, 0].tolist() == [0, 0, 0, 0]
    assert buf[0, 1].tolist() == [200, 100, 50, 255]
    assert buf[0, 2].tolist() == [128, 128, 128, 128]
    assert buf[0, 3].tolist() == [0, 0, 0, 1]


def test_premultiply_exhaustive_all_values_match_exact_rounding():
    v = np.arange(256, dtype=np.uint8)
    rgb, a = np.meshgrid(v, v)  # 256x256
    band = np.stack([rgb, rgb, rgb, a], axis=-1).astype(np.uint8)
    buf = F.alloc_buffer(256, 256)
    F.paste_band(buf, 0, 0, 256, 256, band, True)
    exact = (rgb.astype(np.int64) * a + 127) // 255  # round-half-up of rgb*a/255
    assert (buf[::-1][..., 0] == exact).all()


def test_paste_in_place_and_no_full_buffer_touch():
    buf = F.alloc_buffer(64, 64)
    buf[...] = 77
    before = buf.copy()
    ident = buf.ctypes.data
    F.paste_band(buf, 10, 10, 4, 4, rnd(4, 4).tobytes(), True)
    assert buf.ctypes.data == ident
    diff = (buf != before).any(axis=2)
    assert diff[:, :].sum() <= 16
    ys, xs = np.nonzero(diff)
    assert ys.min() >= 64 - 14 and ys.max() < 64 - 10 and xs.min() >= 10 and xs.max() < 14


@pytest.mark.parametrize("rect", [(-1, 0, 2, 2), (0, -1, 2, 2), (3, 0, 2, 2), (0, 3, 2, 2), (0, 0, 0, 1), (0, 0, 1, 0)])
def test_paste_rejects_out_of_bounds(rect):
    buf = F.alloc_buffer(4, 4)
    x, y, w, h = rect
    with pytest.raises(ValueError):
        F.paste_band(buf, x, y, w, h, bytes(max(w * h * 4, 4)), False)


def test_paste_accepts_memoryview_and_bytes():
    buf = F.alloc_buffer(2, 1)
    p = rnd(1, 2)
    F.paste_band(buf, 0, 0, 2, 1, memoryview(p.tobytes()), False)
    assert (buf == p).all()


def test_paste_short_payload_raises():
    buf = F.alloc_buffer(4, 4)
    with pytest.raises(ValueError):
        F.paste_band(buf, 0, 0, 4, 4, bytes(10), False)


# ---- to_wire

def to_f(u8):
    return u8.astype(np.float32) / 255.0


def test_to_wire_flips_and_scales_without_unpremultiply():
    src = rnd(5, 7, 1)  # TD order, treated as straight
    out = F.WireConverter().to_wire(to_f(src), unpremultiply=False)
    assert out.dtype == np.uint8 and out.shape == src.shape
    assert (out == src[::-1]).all()


def test_premultiply_roundtrip_opaque_exact_and_alpha0_zero():
    straight = rnd(8, 16, 2)
    straight[0, :, 3] = 255
    straight[1, :, 3] = 0
    wire_in = straight  # wire order
    buf = F.alloc_buffer(16, 8)
    F.paste_band(buf, 0, 0, 16, 8, wire_in.tobytes(), True)
    back = F.WireConverter().to_wire(to_f(buf), True)
    assert (back[0] == straight[0]).all()  # alpha 255: exact
    assert (back[1][..., :3] == 0).all() and (back[1][..., 3] == 0).all()  # alpha 0: rgb 0
    # translucent pixels: error bounded by quantisation of the premultiplied value
    a = straight[..., 3:4].astype(np.float32)
    tol = np.ceil(255.0 / np.maximum(a, 1)) / 2 + 1
    err = np.abs(back[..., :3].astype(np.float32) - straight[..., :3])
    ok = (a[..., 0] == 0)[..., None] | (err <= tol)
    assert ok.all()
    assert (back[..., 3] == straight[..., 3]).all()


def test_to_wire_alpha_zero_with_nonzero_rgb_gives_zero_rgb():
    f = np.array([[[1.0, 0.5, 0.25, 0.0]]], np.float32)
    assert F.WireConverter().to_wire(f, True).tolist() == [[[0, 0, 0, 0]]]


def test_to_wire_clips_hdr_and_negative():
    f = np.array([[[2.0, -1.0, 0.5, 1.0], [3.0, 0.0, 0.0, 0.5]]], np.float32)
    out = F.WireConverter().to_wire(f, True)
    assert out[0, 0].tolist() == [255, 0, 128, 255]
    assert out[0, 1].tolist() == [255, 0, 0, 128]  # 3.0 / 0.5 clipped


def test_to_wire_rounds_half_up():
    f = np.array([[[1.5 / 255, 2.5 / 255, 254.5 / 255, 1.0]]], np.float32)
    out = F.WireConverter().to_wire(f, False)
    assert out[0, 0].tolist() == [2, 3, 255, 255]


def test_convert_rows_ranges_equal_full_conversion():
    arr = np.random.RandomState(4).rand(37, 29, 4).astype(np.float32)
    c = F.WireConverter()
    full = c.to_wire(arr, True)
    parts = np.empty(arr.shape, np.uint8)
    for r0, r1 in ((0, 5), (5, 6), (6, 30), (30, 37)):
        c.convert_rows(arr, parts, r0, r1, True)
    assert (parts == full).all()


def test_convert_rows_validates_range():
    arr = np.zeros((4, 4, 4), np.float32)
    with pytest.raises(ValueError):
        F.WireConverter().convert_rows(arr, np.empty(arr.shape, np.uint8), 2, 5)
    with pytest.raises(ValueError):
        F.WireConverter().convert_rows(arr, np.empty(arr.shape, np.uint8), 3, 2)


def test_to_wire_rejects_bad_shape():
    with pytest.raises(ValueError):
        F.WireConverter().to_wire(np.zeros((4, 4, 3), np.float32))


def test_to_wire_uint8_input():
    src = rnd(3, 3, 9)
    out = F.WireConverter().to_wire(src, False)
    assert (out == src[::-1]).all()
    out2 = F.WireConverter().to_wire(src, True)
    a = src[::-1][..., 3]
    assert (out2[a == 0][..., :3] == 0).all()
    assert (out2[a == 255][..., :3] == src[::-1][a == 255][..., :3]).all()


def test_paste_then_wire_full_pipeline_identity_when_opaque():
    wire = rnd(10, 12, 7)
    wire[..., 3] = 255
    buf = F.alloc_buffer(12, 10)
    F.paste_band(buf, 0, 0, 12, 10, wire, True)
    assert (F.WireConverter().to_wire(to_f(buf), True) == wire).all()


def test_scratch_reused_and_resized():
    c = F.WireConverter()
    c.to_wire(np.zeros((8, 8, 4), np.float32))
    s = c._scratch
    c.to_wire(np.zeros((4, 4, 4), np.float32))
    assert c._scratch is s
    c.to_wire(np.zeros((16, 16, 4), np.float32))
    assert c._scratch.size >= 16 * 16 * 4


def test_premultiply_u8_helper_matches_reference():
    x = rnd(5, 5, 8)
    assert (F.premultiply_u8(x) == ref_premul(x)).all()


# ---- v3 helpers: surface reallocation, locked-TOP readback, premultiplication toggle

def test_resize_buffer_anchors_top_left_in_td_order():
    old = np.arange(4 * 6 * 4, dtype=np.uint8).reshape(4, 6, 4)  # 6x4 document, TD order (row 0 = bottom)
    big = F.resize_buffer(old, 10, 7)
    assert big.shape == (7, 10, 4)
    # wire row 0 (top) is TD row h-1 in both; wire (x, y) is unchanged for the overlap
    for y in range(4):
        assert (big[7 - 1 - y, :6] == old[4 - 1 - y]).all()
    assert not big[:3].any() and not big[:, 6:].any()
    small = F.resize_buffer(old, 3, 2)
    for y in range(2):
        assert (small[2 - 1 - y] == old[4 - 1 - y, :3]).all()


def test_resize_buffer_from_none_and_same_size():
    assert not F.resize_buffer(None, 5, 3).any()
    old = np.random.RandomState(0).randint(0, 255, (3, 5, 4), dtype=np.uint8)
    same = F.resize_buffer(old, 5, 3)
    assert same is not old and (same == old).all()


def test_from_float_rounds_clips_and_resizes():
    arr = np.zeros((2, 3, 4), np.float32)
    arr[0, 0] = (0.5, 1.0, 0.2, 1.0)
    arr[1, 2] = (1.2, -0.3, 0.0, 0.5)
    out = F.from_float(arr, 3, 2)
    assert out[0, 0].tolist() == [128, 255, 51, 255] and out[1, 2].tolist() == [255, 0, 0, 128]
    assert F.from_float(arr, 4, 3).shape == (3, 4, 4)


def test_from_float_roundtrips_uint8_exactly():
    u8 = np.random.RandomState(4).randint(0, 256, (5, 7, 4), dtype=np.uint8)
    assert (F.from_float(u8.astype(np.float32) / 255.0, 7, 5) == u8).all()


def test_convert_premultiplication_toggles_in_place():
    wire = np.random.RandomState(5).randint(0, 256, (6, 6, 4), dtype=np.uint8)
    wire[..., 3] = 255
    buf = wire.copy()
    F.convert_premultiplication(buf, True)
    assert (buf == wire).all()  # opaque: unchanged
    wire[..., 3] = 128
    buf = wire.copy()
    F.convert_premultiplication(buf, True)
    assert (buf == F.premultiply_u8(wire)).all()
    F.convert_premultiplication(buf, False)
    assert np.abs(buf.astype(int) - wire).max() <= 2 and (buf[..., 3] == 128).all()


def test_masks_fill_white_in_the_new_area():
    old = np.zeros((2, 3, 4), np.uint8)
    old[..., 3] = 255   # black mask
    big = F.resize_buffer(old, 5, 4, white=True)
    assert (big[2:, :3] == old).all() and (big[:2] == 255).all() and (big[:, 3:] == 255).all()
    assert (F.alloc_buffer(2, 2, white=True) == 255).all() and not F.alloc_buffer(2, 2).any()
    assert (F.resize_buffer(None, 3, 2, white=True) == 255).all()
    arr = np.zeros((2, 3, 4), np.float32)
    arr[..., 3] = 1.0
    out = F.from_float(arr, 4, 3, white=True)
    assert (out[1:, :3] == (0, 0, 0, 255)).all() and (out[0] == 255).all() and (out[:, 3] == 255).all()
