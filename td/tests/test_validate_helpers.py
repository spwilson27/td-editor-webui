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
