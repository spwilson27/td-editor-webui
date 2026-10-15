"""Pure helpers of scripts/validate_td.py (the live steps themselves need TouchDesigner)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"))
import validate_td as V  # noqa: E402


def disc(w, h, cx, cy, r, shift=0, color=(255, 0, 0)):
    yy, xx = np.mgrid[0:h, 0:w]
    m = (xx - cx - shift) ** 2 + (yy - cy) ** 2 <= r * r
    img = np.zeros((h, w, 4), np.uint8)
    img[m] = (*color, 255)
    return img


def test_text_parity_accepts_small_offsets_and_rejects_big_ones():
    a = disc(80, 40, 40, 20, 18)
    assert V.text_parity(a, disc(80, 40, 40, 20, 18, shift=1))[0]
    ok, detail = V.text_parity(a, disc(80, 40, 40, 20, 18, shift=6))
    assert not ok and "IoU" in detail
    assert not V.text_parity(a, np.zeros_like(a))[0]
    assert not V.text_parity(a, disc(80, 40, 40, 20, 18, color=(0, 255, 0)))[0]  # colour mismatch


def test_shape_parity_interior_exact_edges_tolerant():
    a = disc(60, 60, 30, 30, 20)
    assert V.shape_parity(a, a)[0]
    b = a.copy()
    b[30, 10] = (255, 0, 0, 200)  # edge pixel off by 55: fails the edge tolerance
    assert not V.shape_parity(b, a)[0]
    e = a.copy()
    e[30, 10, 3] = 255 - 20  # edge pixel within 24
    assert V.shape_parity(e, a)[0]
    i = a.copy()
    i[30, 30] = (250, 0, 0, 255)  # interior pixel must be exact
    assert not V.shape_parity(i, a)[0]


def test_polygon_helpers():
    poly = [(0, 0), (10, 0), (0, 10)]
    pts = np.array([[2.0, 2.0], [9.0, 9.0], [-1.0, 1.0]])
    assert V.in_poly(poly, pts).tolist() == [True, False, False]
    d = V.edge_dist(poly, pts)
    assert abs(d[0] - 2.0) < 1e-6 and d[1] > 3


def test_step_table_is_consistent():
    nums = [n for n, *_ in V.STEPS]
    assert nums == sorted(set(nums)) and {17, 18, 19, 20, 21, 22} <= set(nums)
    assert all(key in V.FUNCS and V.FUNCS[key] in vars(V) for _, _, key, _ in V.STEPS)
    assert [ui for n, _, _, ui in V.STEPS if n in (20, 21, 22)] == [True] * 3


def test_pick_font_prefers_common_families():
    assert V.pick_font(["Zapfino", "Georgia", "Arial"]) == "Arial"
    assert V.pick_font(["Zapfino"]) == "Zapfino"


def test_bilinear_reference_matches_texel_centres_and_midpoints():
    src = np.zeros((2, 2, 4), np.uint8)
    src[0, 0] = (0, 0, 0, 255)
    src[0, 1] = (100, 0, 0, 255)
    src[1, 0] = (0, 100, 0, 255)
    src[1, 1] = (100, 100, 0, 255)
    Y, X = np.mgrid[0:20, 0:20]
    ref = V.bilinear_ref(src, X, Y, 0.0, 0.0, 10.0, 10.0)   # 10x: texel centres at doc 5 and 15
    assert abs(ref[5, 5, 0] - 5.0) < 1.0          # pixel centre 5.5 is half a pixel past the texel centre: 0.1 of the way to 100
    assert abs(ref[10, 10, 0] - 50) < 6 and abs(ref[10, 10, 1] - 50) < 6        # the middle of four texels is the mean
    assert np.allclose(ref[0, 0], (0, 0, 0, 255))                               # clamped at the surface edge


def test_premult_matches_td_convention():
    img = np.array([[[200, 100, 50, 128], [10, 20, 30, 255], [90, 90, 90, 0]]], np.uint8)
    got = V.premult(img)
    assert got[0, 1].tolist() == [10, 20, 30, 255] and got[0, 2].tolist() == [0, 0, 0, 0]
    assert got[0, 0].tolist() == [100, 50, 25, 128]


def test_v5_layer_helper_and_editor_frame_sizes():
    layer = V.L("p", slot=3, size=(8, 4), x=1.5)
    assert (layer["surfaceW"], layer["surfaceH"], layer["sx"], layer["sy"], layer["x"]) == (8, 4, 1, 1, 1.5)
    assert "rasterize" not in layer and V.L("b", "base")["surfaceW"] is None
    assert all(V.P.parse_doc({"rev": 1, "layers": V.SCENE_LAYERS}))
    assert V.P.slot_sizes(V.SCENE_LAYERS, 1, 1) == {1: (V.IW, V.IH), 2: (V.IW, V.IH), 3: (V.IW, V.IH)}
    assert V.P.parse_doc({"rev": 1, "layers": V.xf_layers()})
    assert V.P.slot_sizes(V.xf_layers(), 400, 300) == {1: (8, 8), 2: (128, 128), 3: (16, 16), 4: (16, 16)}


def test_transform_scene_surfaces_are_what_the_references_assume():
    a, b, c, m = V.xf_surfaces()
    assert a.shape == (8, 8, 4) and b.shape == (128, 128, 4) and c.shape == (16, 16, 4) and m.shape == (16, 16, 4)
    assert b[0, 0, 0] == 255 and b[2, 0, 0] == 0 and b[:4, :, 0].mean() == 127.5
    assert (m[:, :8, :3] == 255).all() and (m[:, 8:, :3] == 0).all() and (m[..., 3] == 255).all()
