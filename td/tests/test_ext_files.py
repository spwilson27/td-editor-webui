"""v6 files: .redoc save / open, PNG export, pulses, the `files` message, reload, refusal rules."""

import json
import os
import threading
import zipfile

import numpy as np
import pytest

import ext as E
import frames
import protocol as P
from faketd import FakeInput
from test_ext import Env, L, wire_img

FX = [{"enabled": True, "type": "dropShadow", "dx": 3, "dy": 4, "blur": 5, "color": {"r": 1, "g": 2, "b": 3, "a": 255}, "opacity": 0.5},
      {"enabled": False, "type": "halftone", "cellSize": 8, "angle": 15, "shape": "dot"}]
GUIDES = {"h": [10.5, 20], "v": [5]}


def doc_layers():
    return [
        L("i1", "input", input=1, rot=12, kx=3, ky=-4, sx=1.5, sy=0.5, x=2, y=3, surfaceW=64, surfaceH=32, effects=FX[:1]),
        L("i2", "input", input=2, surfaceW=16, surfaceH=16, effects=[]),
        L("p1", slot=1, surfaceW=20, surfaceH=10, rot=30, effects=FX, sx=2.0, sy=2.0, x=1.5, y=-2),
        L("p2", slot=2, surfaceW=7, surfaceH=9, mask={"slot": 3, "enabled": True}),
        L("a1", "adjustment", mask={"slot": 4, "enabled": True}, adjustment={"type": "invert"}),
    ]


def draw(e, a, premult_alpha=200):
    """Fill the surfaces of doc_layers() with pixels; returns {slot: straight wire image sent}."""
    sent = {}
    for slot, (w, h), alpha in ((1, (20, 10), premult_alpha), (2, (7, 9), 255), (3, (7, 9), 255), (4, (64, 32), 255)):
        img = wire_img(w, h, slot, alpha)
        if slot in (3, 4):
            img[..., 0] = img[..., 1] = img[..., 2]   # masks are grey
        e.surface(a, slot, (0, 0, w, h), img, dw=w, dh=h)
        sent[slot] = img
    e.pump(2)
    return sent


def make_doc_env(mode="input", size=None):
    e = Env()
    if mode == "fixed":
        e.o.par.Docsizemode.val = "fixed"
        e.o.par.Docw.val, e.o.par.Doch.val = size
    e.pump()
    a = e.connect("panel")
    e.send(a, {"t": "doc", "rev": 5, "layers": doc_layers(), "guides": GUIDES, "canvas": {"mode": mode}})
    sent = draw(e, a)
    return e, a, sent


def result(e, cid, op=None):
    return [m for m in e.s.messages(cid, "fileResult") if op is None or m["op"] == op]


def save(e, a, path, rid="s1", pump=2):
    e.send(a, {"t": "saveProject", "requestId": rid, "path": str(path)})
    e.pump(pump)
    return result(e, a, "saveProject")[-1]


def stored_surfaces(e):
    return {s: e.dump(next(iter(e.x.clients)), s)[1] for s in sorted(e.x._slot_set)}


# ---- save

def test_save_writes_a_zip_with_doc_surfaces_and_meta(tmp_path):
    e, a, sent = make_doc_env()
    path = tmp_path / "p.redoc"
    r = save(e, a, path)
    assert r == {"t": "fileResult", "requestId": "s1", "op": "saveProject", "ok": True, "path": str(path)}
    assert sorted(os.listdir(tmp_path)) == ["p.redoc"]
    with zipfile.ZipFile(path) as z:
        assert sorted(z.namelist()) == ["doc.json", "meta.json", "surfaces/1.png", "surfaces/2.png", "surfaces/3.png", "surfaces/4.png"]
        meta = json.loads(z.read("meta.json"))
        doc = json.loads(z.read("doc.json"))
    assert meta["format"] == 1 and meta["version"] == P.APP_VERSION and meta["app"] == "raster-editor"
    rev, layers = P.parse_doc(doc)   # a valid DocSpec
    assert rev == 5 and [l["id"] for l in layers] == ["i1", "i2", "p1", "p2", "a1"]
    assert doc["guides"] == GUIDES and doc["canvas"] == {"mode": "input"} and (doc["width"], doc["height"]) == (64, 32)
    assert layers[2]["effects"] == FX and layers[2]["rot"] == 30 and layers[0]["kx"] == 3
    docp, _, pngs = frames.read_redoc(str(path))
    for slot, img in stored_surfaces(e).items():   # exactly what the pages would fetch
        assert (frames.decode_png(pngs[slot]) == img).all()


def test_save_unpremultiplies_like_the_surface_dump_and_masks_stay_grey(tmp_path):
    e, a, sent = make_doc_env()
    path = tmp_path / "p.redoc"
    save(e, a, path)
    _, _, pngs = frames.read_redoc(str(path))
    p1 = frames.decode_png(pngs[1])
    assert (p1[..., 3] == 200).all()
    # a straight pixel survives premultiply -> store -> unpremultiply within 1/255 * 255/alpha
    assert np.abs(p1[..., :3].astype(int) - sent[1][..., :3].astype(int)).max() <= 2
    m = frames.decode_png(pngs[3])
    assert (m == sent[3]).all()


def test_save_with_premultiplied_off_stores_the_buffer_as_is(tmp_path):
    e, a, sent = make_doc_env()
    e.o.par.Premultiplied.val = 0
    e.x.OnParChange(e.o.par.Premultiplied)
    e.pump(10)
    path = tmp_path / "p.redoc"
    save(e, a, path)
    p1 = frames.decode_png(frames.read_redoc(str(path))[2][1])
    assert (p1 == e.dump(a, 1)[1]).all() and (p1[..., 3] == 200).all()   # the buffer (straight now) as the pages fetch it


def test_save_uses_the_parameter_without_a_path_and_writes_a_given_path_to_it(tmp_path):
    e, a, _ = make_doc_env()
    p1, p2 = tmp_path / "one.redoc", tmp_path / "two"
    e.o.par.Projectfile.val = str(p1)
    e.send(a, {"t": "saveProject", "requestId": "r"})
    e.pump(2)
    assert os.path.isfile(p1) and result(e, a)[-1]["path"] == str(p1)
    save(e, a, p2, "r2")
    assert os.path.isfile(str(p2) + ".redoc") and e.o.par.Projectfile.eval() == str(p2)   # ending added, parameter written
    assert e.s.messages(a, "files")[-1] == {"t": "files", "projectFile": str(p2), "pngFile": ""}


def test_save_overwrites_atomically_and_failures_keep_the_old_file(tmp_path):
    e, a, _ = make_doc_env()
    path = tmp_path / "p.redoc"
    save(e, a, path)
    old = path.read_bytes()
    e.x._file_replace = lambda a_, b_: (_ for _ in ()).throw(OSError("rename refused"))
    r = save(e, a, path, "bad")
    assert r["ok"] is False and "rename refused" in r["msg"] and r["requestId"] == "bad"
    assert path.read_bytes() == old and sorted(os.listdir(tmp_path)) == ["p.redoc"]   # no .part
    e.x._file_replace = os.replace
    assert save(e, a, path, "again")["ok"] is True


def test_save_into_a_missing_folder_or_a_folder_is_refused(tmp_path):
    e, a, _ = make_doc_env()
    r = save(e, a, tmp_path / "nope" / "x.redoc")
    assert r["ok"] is False and "does not exist" in r["msg"]
    (tmp_path / "d.redoc").mkdir()
    r = save(e, a, tmp_path / "d.redoc", "d")
    assert r["ok"] is False and "folder" in r["msg"]


def test_save_snapshots_the_buffers_before_the_worker_runs(tmp_path, monkeypatch):
    """Edits after the request must not leak into the file: the copy happens on the main thread."""
    e, a, sent = make_doc_env()
    e.x._sync_file_ops = False
    gate = threading.Event()
    real = frames.write_redoc

    def slow(*args, **kw):
        gate.wait(5)
        return real(*args, **kw)
    monkeypatch.setattr(frames, "write_redoc", slow)
    path = tmp_path / "p.redoc"
    e.send(a, {"t": "saveProject", "requestId": "s", "path": str(path)})
    e.surface(a, 1, (0, 0, 20, 10), np.zeros((10, 20, 4), np.uint8), dw=20, dh=10)   # a later stroke
    gate.set()
    for _ in range(200):
        e.pump()
        if result(e, a):
            break
        threading.Event().wait(0.01)
    assert result(e, a)[-1]["ok"] is True
    p1 = frames.decode_png(frames.read_redoc(str(path))[2][1])
    assert (p1[..., 3] == 200).all()    # not the later transparent stroke


def test_operations_are_serialised_and_refused_while_busy_or_restoring(tmp_path, monkeypatch):
    e, a, _ = make_doc_env()
    e.x._sync_file_ops = False
    gate = threading.Event()
    real = frames.write_redoc
    monkeypatch.setattr(frames, "write_redoc", lambda *a_, **k: (gate.wait(5), real(*a_, **k))[1])
    e.send(a, {"t": "saveProject", "requestId": "first", "path": str(tmp_path / "a.redoc")})
    e.send(a, {"t": "saveProject", "requestId": "second", "path": str(tmp_path / "b.redoc")})
    e.send(a, {"t": "exportPng", "requestId": "third"})
    busy = result(e, a)
    assert [m["requestId"] for m in busy] == ["second", "third"] and all(not m["ok"] and "busy" in m["msg"] for m in busy)
    gate.set()
    for _ in range(200):
        e.pump()
        if any(m["requestId"] == "first" for m in result(e, a)):
            break
        threading.Event().wait(0.01)
    assert result(e, a, "saveProject")[-1]["ok"] is True and not os.path.exists(tmp_path / "b.redoc")
    e.x._restore_pending = True
    r = save(e, a, tmp_path / "c.redoc", "c")
    assert not r["ok"] and "restoring" in r["msg"] and not os.path.exists(tmp_path / "c.redoc")


def test_inactive_editor_refuses_file_operations(tmp_path):
    e, a, _ = make_doc_env()
    e.o.par.Active.val = 0
    e.send(a, {"t": "saveProject", "requestId": "x", "path": str(tmp_path / "x.redoc")})
    assert result(e, a)[-1]["ok"] is False and not os.path.exists(tmp_path / "x.redoc")


def test_bad_file_request_gets_an_error_message():
    e, a, _ = make_doc_env()
    e.send(a, {"t": "saveProject"})
    e.send(a, {"t": "openProject", "requestId": "r", "path": 5})
    assert len(e.s.messages(a, "error")) == 2 and not result(e, a)


# ---- open

def open_project(e, a, path, rid="o1", pump=3):
    e.send(a, {"t": "openProject", "requestId": rid, "path": str(path)})
    e.pump(pump)
    return result(e, a, "openProject")[-1]


def test_open_replaces_the_document_and_reloads_every_client(tmp_path):
    src, sa, sent = make_doc_env("fixed", (90, 70))
    path = tmp_path / "p.redoc"
    save(src, sa, path)
    want_layers = src.x._layers_with_sizes(src.x.doc_layers)
    want_surfaces = stored_surfaces(src)

    dst = Env()
    dst.pump()
    a, b = dst.connect("panel"), dst.connect("external")
    dst.send(a, {"t": "doc", "rev": 9, "layers": [L("x", "input", input=1), L("q", slot=1, surfaceW=3, surfaceH=3), L("q2", slot=2, surfaceW=3, surfaceH=3)]})
    dst.surface(a, 1, (0, 0, 3, 3), wire_img(3, 3, 1), dw=3, dh=3)
    dst.pump(2)
    r = open_project(dst, a, path)
    assert r == {"t": "fileResult", "requestId": "o1", "op": "openProject", "ok": True, "path": str(path)}
    assert (dst.x.doc_w, dst.x.doc_h) == (90, 70) and str(dst.o.par.Docsizemode.eval()) == "fixed"
    assert (dst.o.par.Docw.eval(), dst.o.par.Doch.eval()) == (90, 70)
    assert dst.x.doc_rev == 10 and dst.x.guides == GUIDES   # rev bumped past max(old 9, file 5)
    for cid in (a, b):
        assert dst.s.messages(cid, "reload") == [{"t": "reload", "rev": 10}]
    assert not result(dst, b)   # only the requester gets the fileResult
    # the pages reload through requestDoc
    dst.send(b, {"t": "requestDoc"})
    st = dst.s.messages(b, "docState")[-1]
    assert st["layers"] == want_layers and st["guides"] == GUIDES and st["canvas"] == {"mode": "fixed"} and (st["docW"], st["docH"]) == (90, 70)
    assert sorted(dst.x._slot_set) == sorted(want_surfaces)
    for slot, img in want_surfaces.items():
        assert (dst.dump(b, slot)[1] == img).all(), slot
    assert dst.o.net.applies[-1][0] == dst.x.doc_layers and dst.o.net.tops   # network rebuilt for the new stack
    assert dst.o.par.Status.eval().find("project opened") >= 0


def test_open_save_open_is_stable(tmp_path):
    src, sa, _ = make_doc_env()
    p1, p2 = tmp_path / "1.redoc", tmp_path / "2.redoc"
    save(src, sa, p1)
    dst = Env()
    dst.pump()
    a = dst.connect("panel")
    assert open_project(dst, a, p1)["ok"]
    assert save(dst, a, p2, "again")["ok"]
    d1, _, g1 = frames.read_redoc(str(p1))
    d2, _, g2 = frames.read_redoc(str(p2))
    assert d1["layers"] == d2["layers"] and d1["guides"] == d2["guides"] and d2["rev"] == d1["rev"] + 1
    assert all((frames.decode_png(g1[s]) == frames.decode_png(g2[s])).all() for s in g1)


def test_stale_tiles_and_docs_are_ignored_until_the_page_reloads(tmp_path):
    src, sa, _ = make_doc_env()
    path = tmp_path / "p.redoc"
    save(src, sa, path)
    dst, a = make_doc_env()[:2]
    assert open_project(dst, a, path)["ok"]
    before = dst.dump(a, 1)[1].copy()
    dst.surface(a, 1, (0, 0, 20, 10), wire_img(20, 10, 99), dw=20, dh=10)   # in flight when the file was opened
    dst.send(a, {"t": "doc", "rev": 50, "layers": [L("z", "input", input=1)]})
    dst.pump(2)
    assert (dst.dump(a, 1)[1] == before).all() and dst.x.doc_rev == 6
    dst.send(a, {"t": "requestDoc"})
    dst.surface(a, 1, (0, 0, 20, 10), wire_img(20, 10, 99), dw=20, dh=10)   # after reloading: normal editing resumes
    assert not (dst.dump(a, 1)[1] == before).all()
    dst.send(a, {"t": "doc", "rev": 7, "layers": doc_layers()})
    assert dst.x.doc_rev == 7


def test_open_applies_stored_premultiplication_for_the_current_setting(tmp_path):
    src, sa, sent = make_doc_env()
    path = tmp_path / "p.redoc"
    save(src, sa, path)
    for premult in (1, 0):
        dst = Env()
        dst.o.par.Premultiplied.val = premult
        dst.pump()
        a = dst.connect("panel")
        assert open_project(dst, a, path)["ok"]
        got = dst.dump(a, 1)[1]
        assert np.abs(got[..., :3].astype(int) - sent[1][..., :3].astype(int)).max() <= 2
        assert (got[..., 3] == 200).all()


def test_open_keeps_the_document_when_anything_is_wrong(tmp_path):
    e, a, _ = make_doc_env()
    layers_before, rev_before = list(e.x.doc_layers), e.x.doc_rev
    pix_before = {s: b.copy() for s, b in e.x.surfaces.items()}
    good, _, pngs = frames.read_redoc(str(_save_good(tmp_path)))
    meta = {"format": 1}
    img = frames.encode_png(wire_img(2, 2))

    def write(name, doc=None, pngs_=None, meta_=meta, raw=None):
        path = tmp_path / name
        if raw is not None:
            path.write_bytes(raw)
            return path
        frames.write_redoc(str(path), json.dumps(doc), [], meta_)
        if pngs_:
            with zipfile.ZipFile(path, "a") as z:
                for s, data in pngs_.items():
                    z.writestr(f"surfaces/{s}.png", data)
        return path

    ok_doc = {"rev": 1, "layers": [L("p", slot=1, surfaceW=2, surfaceH=2)], "guides": {"h": [], "v": []}, "canvas": {"mode": "input"},
              "width": 4, "height": 4}
    cases = {
        "missing.redoc": (None, "does not exist"),
        "garbage.redoc": (write("garbage.redoc", raw=b"nope"), "not a project"),
        "future.redoc": (write("future.redoc", ok_doc, {1: img}, {"format": 2}), "not supported"),
        "badfx.redoc": (write("badfx.redoc", {**ok_doc, "layers": [L("p", slot=1, surfaceW=2, surfaceH=2, effects=[{"type": "x"}])]}, {1: img}), "invalid document"),
        "nosurf.redoc": (write("nosurf.redoc", ok_doc, {}), "no surface for slot 1"),
        "size.redoc": (write("size.redoc", {**ok_doc, "layers": [L("p", slot=1, surfaceW=3, surfaceH=2)]}, {1: img}), "2x2"),
        "badpng.redoc": (write("badpng.redoc", ok_doc, {1: b"not a png"}), "PNG"),
        "dup.redoc": (write("dup.redoc", {**ok_doc, "layers": [L("p", slot=1), L("q", slot=1)]}, {1: img}), "invalid document"),
    }
    for name, (path, msg) in cases.items():
        r = open_project(e, a, tmp_path / name)
        assert r["ok"] is False and msg in r["msg"], (name, r)
        assert e.x.doc_layers == layers_before and e.x.doc_rev == rev_before, name
        assert all((e.x.surfaces[s] == b).all() for s, b in pix_before.items()), name
        assert not e.s.messages(a, "reload")
    r = open_project(e, a, tmp_path / "")   # a folder
    assert r["ok"] is False
    assert open_project(e, a, tmp_path / "garbage")["ok"] is False   # .redoc appended; still garbage


def _save_good(tmp_path):
    e, a, _ = make_doc_env()
    path = tmp_path / "good.redoc"
    save(e, a, path)
    return path


def test_open_appends_the_ending_when_the_file_exists_with_it(tmp_path):
    src, sa, _ = make_doc_env()
    save(src, sa, tmp_path / "proj.redoc")
    dst = Env()
    dst.pump()
    a = dst.connect("panel")
    r = open_project(dst, a, tmp_path / "proj")
    assert r["ok"] and r["path"] == str(tmp_path / "proj.redoc")


def test_open_with_empty_project_file_parameter_says_so():
    e, a, _ = make_doc_env()
    e.send(a, {"t": "openProject", "requestId": "r"})
    r = result(e, a)[-1]
    assert r["ok"] is False and "Project File" in r["msg"]


def test_open_adjusts_input_layers_to_the_live_input_resolution(tmp_path):
    src, sa, _ = make_doc_env()
    path = tmp_path / "p.redoc"
    save(src, sa, path)
    dst = Env()
    dst.o.connected.add(1)
    dst.o.in_tops[1].set_image(np.zeros((10, 30, 4), np.float32))
    dst.pump(2)
    a = dst.connect("panel")
    assert open_project(dst, a, path)["ok"]
    i1 = next(l for l in dst.x.doc_layers if l["id"] == "i1")
    assert (i1["surfaceW"], i1["surfaceH"]) == (30, 10) and i1["rot"] == 12   # TD Inputs are live: the file's size is not authoritative


def test_open_during_pending_restore_is_refused(tmp_path):
    src, sa, _ = make_doc_env()
    save(src, sa, tmp_path / "p.redoc")
    dst = Env()
    dst.pump()
    a = dst.connect("panel")
    dst.x._restore_pending = True
    r = open_project(dst, a, tmp_path / "p.redoc")
    assert r["ok"] is False and "restoring" in r["msg"]


# ---- PNG export

def png_env(w=64, h=32):
    e = Env()
    e.pump()
    a = e.connect("panel")
    e.send(a, {"t": "doc", "rev": 1, "layers": [L("i1", "input", input=1)]})
    e.pump(3)
    e.o.out1.width, e.o.out1.height = e.x.doc_w, e.x.doc_h
    return e, a


def out_image(e, seed=4, alpha=0.6):
    arr = np.random.RandomState(seed).rand(e.x.doc_h, e.x.doc_w, 4).astype(np.float32)
    arr[..., 3] = alpha
    arr[..., :3] *= alpha   # premultiplied, as TD hands it over
    e.o.out1.set_image(arr)
    return arr


def test_png_export_equals_the_output_unpremultiplied(tmp_path):
    e, a = png_env()
    arr = out_image(e)
    path = tmp_path / "o.png"
    e.send(a, {"t": "exportPng", "requestId": "e1", "path": str(path)})
    e.pump(6)
    assert result(e, a, "exportPng") == [{"t": "fileResult", "requestId": "e1", "op": "exportPng", "ok": True, "path": str(path)}]
    got = frames.decode_png(path.read_bytes())
    assert (got == frames.WireConverter().to_wire(arr, True)).all()
    assert os.listdir(tmp_path) == ["o.png"] and e.o.par.Pngfile.eval() == str(path)
    assert e.s.messages(a, "files")[-1]["pngFile"] == str(path)


def test_png_export_with_premultiplied_off_is_the_raw_output(tmp_path):
    e, a = png_env()
    e.o.par.Premultiplied.val = 0
    arr = out_image(e)
    e.send(a, {"t": "exportPng", "requestId": "e1", "path": str(tmp_path / "o")})
    e.pump(6)
    assert (frames.decode_png((tmp_path / "o.png").read_bytes()) == frames.WireConverter().to_wire(arr, False)).all()


def test_png_export_never_waits_for_the_gpu_and_ignores_the_first_read(tmp_path):
    e, a = png_env()
    first = out_image(e, 1)
    e.send(a, {"t": "exportPng", "requestId": "e1", "path": str(tmp_path / "o.png")})
    assert not result(e, a)             # nothing finished synchronously
    out_image(e, 2)                     # the output changes after the read was issued
    e.pump(6)
    assert result(e, a)[-1]["ok"]       # (the read issued at request time is the one delivered)


def test_png_export_failures_are_reported(tmp_path):
    e, a = png_env()
    out_image(e)
    e.o.out1.width = 7   # the output does not have the document's size
    e.send(a, {"t": "exportPng", "requestId": "e1", "path": str(tmp_path / "o.png")})
    for _ in range(60):
        e.pump(1, dt=0.1)
    r = result(e, a)[-1]
    assert r["ok"] is False and "7x" in r["msg"] and not os.path.exists(tmp_path / "o.png")
    e.o.out1.width = e.x.doc_w
    e.x._file_replace = lambda a_, b_: (_ for _ in ()).throw(OSError("denied"))
    e.send(a, {"t": "exportPng", "requestId": "e2", "path": str(tmp_path / "o2.png")})
    e.pump(6)
    r = result(e, a)[-1]
    assert r["requestId"] == "e2" and r["ok"] is False and "denied" in r["msg"] and os.listdir(tmp_path) == []


def test_png_export_without_a_network_is_refused(tmp_path):
    e, a = png_env()
    e.x._net_applied = False
    e.send(a, {"t": "exportPng", "requestId": "e1", "path": str(tmp_path / "o.png")})
    assert result(e, a)[-1]["ok"] is False


# ---- pulses and parameters

def test_pulses_run_the_operations_and_report_to_every_client(tmp_path):
    e, a, _ = make_doc_env()
    b = e.connect("external")
    e.o.par.Projectfile.val = str(tmp_path / "pulse.redoc")
    e.x.OnParChange(e.o.par.Saveproject)
    e.pump(2)
    for cid in (a, b):
        (m,) = result(e, cid, "saveProject")
        assert m["ok"] is True and "requestId" not in m and m["path"] == str(tmp_path / "pulse.redoc")
    assert "project saved" in e.o.par.Status.eval()
    e.x.OnParChange(e.o.par.Openproject)
    e.pump(3)
    assert result(e, a, "openProject")[-1]["ok"] is True and e.s.messages(b, "reload")
    out_image(e)
    e.o.par.Pngfile.val = str(tmp_path / "pulse.png")
    e.o.out1.width, e.o.out1.height = e.x.doc_w, e.x.doc_h
    out_image(e)
    e.x.OnParChange(e.o.par.Exportpng)
    e.pump(6)
    assert result(e, b, "exportPng")[-1]["ok"] is True and os.path.isfile(tmp_path / "pulse.png")


def test_failed_pulse_shows_the_reason_in_status(tmp_path):
    e, a, _ = make_doc_env()
    e.o.par.Projectfile.val = str(tmp_path / "nope" / "x.redoc")
    e.x.OnParChange(e.o.par.Saveproject)
    e.pump(1)
    assert "project save failed" in e.o.par.Status.eval() and "does not exist" in e.o.par.Status.eval()


def test_file_parameter_changes_are_broadcast(tmp_path):
    e, a, _ = make_doc_env()
    b = e.connect("external")
    assert e.s.messages(b, "files")[0] == {"t": "files", "projectFile": "", "pngFile": ""}
    e.o.par.Projectfile.val = "/x/y.redoc"
    e.x.OnParChange(e.o.par.Projectfile)
    e.o.par.Pngfile.val = "/x/y.png"
    e.x.OnParChange(e.o.par.Pngfile)
    for cid in (a, b):
        assert e.s.messages(cid, "files")[-1] == {"t": "files", "projectFile": "/x/y.redoc", "pngFile": "/x/y.png"}
    n = len(e.s.messages(a, "files"))
    e.x.OnParChange(e.o.par.Pngfile)   # unchanged value: nothing to say
    assert len(e.s.messages(a, "files")) == n


def test_relative_paths_are_resolved_against_the_project_folder(tmp_path, monkeypatch):
    e, a, _ = make_doc_env()
    monkeypatch.setattr(e.x, "_project_folder", lambda: str(tmp_path))
    e.o.par.Projectfile.val = "sub.redoc"
    e.send(a, {"t": "saveProject", "requestId": "r"})
    e.pump(2)
    assert os.path.isfile(tmp_path / "sub.redoc") and result(e, a)[-1]["path"] == str(tmp_path / "sub.redoc")
    e.o.par.Projectfile.val = ""
    e.send(a, {"t": "saveProject", "requestId": "r2"})   # empty = raster_editor.redoc in the project folder
    e.pump(2)
    assert os.path.isfile(tmp_path / "raster_editor.redoc")


# ---- chooseFile / fileChosen / placeImage

from faketd import FakeTop  # noqa: E402
from test_ext import get_top, tops_img  # noqa: E402


def choose_env(answer=None, **pars):
    e = Env(**pars)
    e.pump()
    a = e.connect("panel")
    asked = []
    e.x._choose_dialog = lambda purpose: (asked.append(purpose), answer)[1]
    return e, a, asked


def chosen(e, a):
    return [m for m in e.s.messages(a, "fileChosen")]


def test_choose_file_returns_the_path_without_blocking_the_server_callback(tmp_path):
    e, a, asked = choose_env(str(tmp_path / "x.redoc"))
    e.send(a, {"t": "chooseFile", "requestId": "c1", "purpose": "openProject"})
    assert asked == [] and chosen(e, a) == []      # the modal dialog is not opened inside the callback
    e.pump(1)
    assert asked == ["openProject"] and chosen(e, a) == [{"t": "fileChosen", "requestId": "c1", "path": str(tmp_path / "x.redoc")}]


@pytest.mark.parametrize("purpose", ["openProject", "saveProject", "exportPng"])
def test_choose_file_for_project_and_png_just_returns_the_path_or_null(purpose, tmp_path):
    for answer, want in ((str(tmp_path / "a"), str(tmp_path / "a")), (None, None)):
        e, a, asked = choose_env(answer)
        e.send(a, {"t": "chooseFile", "requestId": "c", "purpose": purpose})
        e.pump(2)
        assert chosen(e, a)[-1]["path"] == want and asked == [purpose]
        assert not e.s.messages(a, "topReady") and not e.s.messages(a, "topError")


def test_choose_file_rejects_bad_requests_and_a_failing_dialog_is_a_cancel():
    e, a, _ = choose_env("x")
    e.send(a, {"t": "chooseFile", "requestId": "c", "purpose": "format c:"})
    e.send(a, {"t": "chooseFile", "purpose": "placeImage"})
    assert len(e.s.messages(a, "error")) == 2

    def boom(purpose):
        raise RuntimeError("no display")
    e.x._choose_dialog = boom
    e.send(a, {"t": "chooseFile", "requestId": "c2", "purpose": "placeImage"})
    e.pump(2)
    assert chosen(e, a) == [{"t": "fileChosen", "requestId": "c2", "path": None}]


def test_choose_file_one_pending_dialog_per_client(tmp_path):
    e, a, asked = choose_env(str(tmp_path / "p"))
    e.send(a, {"t": "chooseFile", "requestId": "c1", "purpose": "openProject"})
    e.send(a, {"t": "chooseFile", "requestId": "c2", "purpose": "openProject"})
    assert chosen(e, a) == [{"t": "fileChosen", "requestId": "c2", "path": None}]
    e.pump(2)
    assert asked == ["openProject"] and chosen(e, a)[-1]["requestId"] == "c1"


def test_test_path_stub_needs_panelquery_test_1():
    e, a, asked = choose_env("REAL", Panelquery="")
    e.send(a, {"t": "chooseFile", "requestId": "c1", "purpose": "exportPng", "testPath": "/stub"})
    e.pump(2)
    assert asked == ["exportPng"] and chosen(e, a)[-1]["path"] == "REAL"       # ignored without test=1
    e.o.par.Panelquery.val = "test=1"
    e.send(a, {"t": "chooseFile", "requestId": "c2", "purpose": "exportPng", "testPath": "/stub"})
    e.pump(2)
    assert asked == ["exportPng"] and chosen(e, a)[-1] == {"t": "fileChosen", "requestId": "c2", "path": "/stub"}   # no dialog opened
    e.send(a, {"t": "chooseFile", "requestId": "c4", "purpose": "exportPng", "testPath": None})
    e.pump(2)
    assert chosen(e, a)[-1]["path"] is None and asked == ["exportPng"]


def place_env(tmp_path, name="pic.png", w=40, h=24, **kw):
    path = tmp_path / name
    path.write_bytes(b"x" * 10)
    e, a, asked = choose_env(str(path), **kw)
    movie = FakeTop("/project1/raster_editor/_imp_mov", w, h, array=tops_img(w, h, 5))
    made = []
    e.x._make_movie = lambda p, tag: (made.append(p), movie)[1]
    movie.destroyed = False
    movie.destroy = lambda: setattr(movie, "destroyed", True)
    return e, a, movie, made


def test_place_image_loads_the_file_and_serves_it_like_a_top_import(tmp_path):
    e, a, movie, made = place_env(tmp_path)
    e.send(a, {"t": "chooseFile", "requestId": "pi", "purpose": "placeImage"})
    e.pump(10)
    assert chosen(e, a)[-1]["path"] == str(tmp_path / "pic.png") and made == [str(tmp_path / "pic.png")]
    assert e.s.messages(a, "topReady") == [{"t": "topReady", "requestId": "pi", "w": 40, "h": 24}]
    h, payload = P.decode_frame(get_top(e, a, "pi")["data"])
    assert h.type == P.TYPE_TOP_IMAGE and (h.doc_w, h.doc_h) == (40, 24)
    want = frames.WireConverter().to_wire(tops_img(40, 24, 5), True)
    assert (np.frombuffer(payload, np.uint8).reshape(24, 40, 4) == want).all()
    assert movie.destroyed    # the temporary operator is gone


def test_place_image_waits_for_the_load_and_times_out(tmp_path):
    e, a, movie, _ = place_env(tmp_path)
    movie.width = movie.height = 0
    e.send(a, {"t": "chooseFile", "requestId": "pi", "purpose": "placeImage"})
    e.pump(5)
    assert not e.s.messages(a, "topReady") and not e.s.messages(a, "topError") and not movie.destroyed   # still loading
    movie.width, movie.height = 40, 24
    e.pump(10)
    assert e.s.messages(a, "topReady")
    e2, a2, movie2, _ = place_env(tmp_path, "b.png")
    movie2.width = movie2.height = 0
    e2.send(a2, {"t": "chooseFile", "requestId": "pj", "purpose": "placeImage"})
    e2.pump(2)
    e2.pump(1, dt=E.TOP_READ_TIMEOUT_S + 1)
    e2.pump(2)
    (err,) = e2.s.messages(a2, "topError")
    assert "could not load b.png" in err["msg"] and movie2.destroyed


def test_place_image_rejects_missing_wrong_type_and_huge_files(tmp_path):
    e, a, asked = choose_env(str(tmp_path / "nope.png"))
    e.send(a, {"t": "chooseFile", "requestId": "1", "purpose": "placeImage"})
    e.pump(2)
    assert "does not exist" in e.s.messages(a, "topError")[-1]["msg"]
    (tmp_path / "t.txt").write_text("x")
    e.x._choose_dialog = lambda p: str(tmp_path / "t.txt")
    e.send(a, {"t": "chooseFile", "requestId": "2", "purpose": "placeImage"})
    e.pump(2)
    assert "not a supported image" in e.s.messages(a, "topError")[-1]["msg"]
    (tmp_path / "big.png").write_bytes(b"x")
    e.x.IMAGE_MAX_BYTES = 0
    e.x._choose_dialog = lambda p: str(tmp_path / "big.png")
    e.send(a, {"t": "chooseFile", "requestId": "3", "purpose": "placeImage"})
    e.pump(2)
    assert "too large" in e.s.messages(a, "topError")[-1]["msg"]


def test_cancelled_place_image_does_nothing():
    e, a, asked = choose_env(None)
    e.send(a, {"t": "chooseFile", "requestId": "1", "purpose": "placeImage"})
    e.pump(3)
    assert chosen(e, a)[-1]["path"] is None and not e.s.messages(a, "topError") and not e.s.messages(a, "topReady")


def test_client_leaving_releases_a_loading_image(tmp_path):
    e, a, movie, _ = place_env(tmp_path)
    movie.width = movie.height = 0
    e.send(a, {"t": "chooseFile", "requestId": "pi", "purpose": "placeImage"})
    e.pump(3)
    e.x.OnWebSocketClose(a)
    assert movie.destroyed
