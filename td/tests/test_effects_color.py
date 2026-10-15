"""Colour filters: python side data helpers (.cube parser and atlas), same cases as web/tests/browser/effects.filters.color.test.ts."""

import effects

ID2 = "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"


def cube_text(n, f=lambda r, g, b: (r, g, b), head=""):
    lines = [head, "LUT_3D_SIZE %d" % n]
    for b in range(n):
        for g in range(n):
            for r in range(n):
                lines.append(" ".join("%.6f" % x for x in f(r / (n - 1), g / (n - 1), b / (n - 1))))
    return "\n".join(lines) + "\n"


def test_parse_header_comments_domain():
    c = effects.parse_cube('# comment\nTITLE "x y"\n\nLUT_3D_SIZE 2 # trailing\nDOMAIN_MIN -1 0 0.25\nDOMAIN_MAX 2 1 1\n' + ID2)
    assert c["size"] == 2 and c["dmin"] == [-1, 0, 0.25] and c["dmax"] == [2, 1, 1]
    assert len(c["data"]) == 24 and c["data"][3:6] == [1, 0, 0]


def test_parse_defaults_and_crlf():
    c = effects.parse_cube(("LUT_3D_SIZE 2\n" + ID2).replace("\n", "\r\n"))
    assert c["dmin"] == [0, 0, 0] and c["dmax"] == [1, 1, 1] and len(c["data"]) == 24


def test_parse_rejections():
    for bad in [
        "LUT_3D_SIZE 2\n0 0 0\n",
        "LUT_3D_SIZE 2\n" + ID2 + "0 0 0\n",
        "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n",
        "LUT_3D_SIZE 65\n",
        "LUT_3D_SIZE 1\n0 0 0\n",
        ID2,
        "LUT_3D_SIZE 2\n" + ID2.replace("1 1 1", "1 x 1"),
        "LUT_3D_SIZE 2\n" + ID2.replace("1 1 1", "1 1"),
        "LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 1 1 1\n" + ID2,
        "",
    ]:
        assert effects.parse_cube(bad) is None, bad


def test_size_64_accepted():
    assert effects.parse_cube("LUT_3D_SIZE 64\n" + "0.5 0.5 0.5\n" * 64 ** 3)["size"] == 64


def test_atlas_layout_and_ordering():
    r = effects.cube_atlas(cube_text(5))
    tex, n, g, dmin, dmax = r
    assert (n, g, tex.w, tex.h) == (5, 3, 15, 15)
    # blue slice 4 = tile column 1, row 1; texel (red 3, green 2)
    o = ((5 + 2) * 15 + 5 + 3) * 4
    assert list(tex.data[o:o + 4]) == [round(0.75 * 255), round(0.5 * 255), 255, 255]
    assert effects.cube_atlas("junk") is None
