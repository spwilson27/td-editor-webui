import pytest

import registry
import upgrade
from test_upgrade_fakes import FOp, FakeExt, build_editor, wire_outside


@pytest.fixture(autouse=True)
def _reset():
    FakeExt.fail_freeze = False
    FakeExt.fail_start_on = None
    FakeExt.swallow = False
    yield
    FakeExt.swallow = False
    FakeExt.fail_freeze = False
    FakeExt.fail_start_on = None


def make_project(old_version=None, with_new_par=True):
    root = FOp(None, "", "baseCOMP")
    p1 = root.create("baseCOMP", "project1")
    new = build_editor(p1, "new", version="0.8.0", code="NEW", shader="// new shader",
                       extra_pars=("Newpar",) if with_new_par else ())
    old = build_editor(p1, "old", version=old_version, code="OLD", extra_pars=("Savetox",))
    return root, p1, new, old


# --------------------------------------------------------------------------- versions / selection

def test_compare_versions():
    c = upgrade.compare_versions
    assert c("0.7.x", "0.8.0") < 0
    assert c("0.8.0", "0.8.0") == 0
    assert c("0.8.1", "0.8.0") > 0
    assert c("0.10.0", "0.9.9") > 0          # numeric, not lexical
    assert c("0.8", "0.8.0") == 0
    assert c("1.0.0", "0.99.99") > 0


def test_classify_older_same_newer_and_foreign_ops():
    root, p1, new, old = make_project()
    same = build_editor(p1, "same", version="0.8.0")
    newer = build_editor(p1, "newer", version="0.9.1")
    mid = build_editor(p1, "mid", version="0.7.9")
    other = p1.create("containerCOMP", "not_an_editor")
    other.create("textDAT", "x")
    older, nw, sm = upgrade.classify(new, root)
    assert {c.name for c in older} == {"old", "mid"}
    assert [(c.name, v) for c, v in nw] == [("newer", "0.9.1")]
    assert [c.name for c in sm] == ["same"]


def test_legacy_editor_without_version_is_older():
    root, p1, new, old = make_project(old_version=None)
    assert registry.editor_version(old) == "0.7.x"
    older, _, _ = upgrade.classify(new, root)
    assert old in older


# --------------------------------------------------------------------------- upgrade

def test_upgrade_replaces_code_and_keeps_document():
    root, p1, new, old = make_project()
    doc, doc_state, surf = old.op("doc"), old.op("doc_state"), old.op("doc/s1")
    old.store("editorId", "abc123")
    old.store("raster_history", (3, 3, b"blob"))
    old.op("doc_state").text = '{"layers":[{"id":"L1"},{"id":"L2"}],"rev":7}'
    old.par.Port = 9990
    old.par.Active = False
    old.comment = "mine"
    old_ext = old.ext.RasterEditorExt
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["upgraded"] == ["/project1/old"] and not rep["failed"] and not rep["skipped_newer"]
    assert rep["warning"] == ""
    # document data: same operators, same content
    assert old.op("doc") is doc and old.op("doc_state") is doc_state and old.op("doc/s1") is surf
    assert doc_state.text == '{"layers":[{"id":"L1"},{"id":"L2"}],"rev":7}'
    assert old.fetch("editorId") == "abc123" and old.fetch("raster_history") == (3, 3, b"blob")
    # parameter values
    assert old.par.Port.val == 9990 and old.par.Active.val is False
    # code replaced from the source
    assert old.op("RasterEditorExt").text == "ext NEW"
    assert old.op("blend_glsl").text == "// new shader"
    assert old.op("protocol").text == "protocol NEW"
    # version / pages
    assert registry.editor_version(old) == "0.8.0"
    assert registry.TAG in old.tags
    names = [p.name for p in old.customPars]
    assert "Newpar" in names and "Savetox" not in names
    assert old.par.Newpar.val == 0
    # extension: the old one was frozen + stopped, a new one started
    assert old_ext.calls == ["PrepareUpgrade", "Freeze", "Stop"]
    assert old.ext.RasterEditorExt is not old_ext and old.ext.RasterEditorExt.calls == ["Start"]
    assert new.ext.RasterEditorExt.calls == []         # the source itself is not touched


def test_copy_fixups_server_inactive_and_retargeted():
    root, p1, new, old = make_project()
    new.op("webserver").par.active = 1                 # the source is running its server
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("webserver").par.active.val == 0     # never grabs the source's port
    assert old.op("webrender").par.url.val == "about:blank"
    assert old.op("par_exec").par.op.val == "/project1/old"      # not the source's path
    assert old.op("keyboard").par.panels.val == "/project1/old"
    assert old.op("par_exec").par.active.val == 1      # re-enabled for the new extension
    assert new.op("par_exec").par.op.val == "/project1/new"      # the source is untouched


def test_parameter_expressions_modes_and_new_pars():
    root, p1, new, old = make_project()
    port = old.par.Port
    port.mode, port.expr = "EXPRESSION", "me.digits + 9000"
    port.val = 9001
    obj = old.par.Port
    upgrade.upgrade_all(new, root, pace=False)
    assert old.par.Port is obj                          # in place: expression / export / bind survive
    assert obj.mode == "EXPRESSION" and obj.expr == "me.digits + 9000"
    # definitions refreshed from the source
    new.par.Port.label = "TCP Port"
    new.par.Port.help = "help text"
    root2, p2, new2, old2 = make_project()
    new2.par.Port.label, new2.par.Port.help = "TCP Port", "help text"
    upgrade.upgrade_all(new2, root2, pace=False)
    assert old2.par.Port.label == "TCP Port" and old2.par.Port.help == "help text"


def test_changed_style_is_recreated_with_value():
    root, p1, new, old = make_project()
    old.par.Port = 4242
    # the new build has Port as a String
    pg = new.customPages[0]
    new.par.Port.destroy()
    pg.appendStr("Port")
    upgrade.upgrade_all(new, root, pace=False)
    assert old.par.Port.style == "Str" and old.par.Port.val == 4242


def test_user_pages_untouched():
    root, p1, new, old = make_project()
    mine = old.appendCustomPage("Mine")
    mine.appendFloat("Gain")
    old.par.Gain = 0.5
    upgrade.upgrade_all(new, root, pace=False)
    assert old.par.Gain.val == 0.5 and [p.name for p in old.customPages if p.name == "Mine"] == ["Mine"]


def test_wiring_preserved():
    root, p1, new, old = make_project()
    up, down = wire_outside(old, p1)
    in1, out1 = old.op("in1"), old.op("out1")
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("in1") is in1 and old.op("out1") is out1         # the ports are the same operators
    assert [c.owner for c in old.inputConnectors[0].connections] == [up]
    assert [c.owner for c in old.outputConnectors[0].connections] == [down]
    assert [c.owner for c in down.inputConnectors[0].connections] == [old]
    # internal wires replayed to the NEW nodes
    sw = old.op("out_switch")
    assert [c.owner for c in sw.inputConnectors[0].connections] == [in1]
    assert [c.owner for c in out1.inputConnectors[0].connections] == [sw]
    # the second input (doc_out) must not slide into the gap the copy closes up
    assert [[k.owner.name for k in i.connections] for i in sw.inputConnectors[:3]] == [["in1"], ["doc_out"], []]


def test_lost_external_wire_is_remade():
    root, p1, new, old = make_project()
    up, down = wire_outside(old, p1)
    # a source whose build has no out1: the old port is kept, so nothing is lost; simulate a loss anyway
    real = upgrade.restore_external_wiring
    wiring = upgrade.external_wiring(old)
    old._comp_in.clear()
    assert real(old, wiring) == 1
    assert [c.owner for c in old.inputConnectors[0].connections] == [up]


def test_same_version_skipped_silently_newer_listed_and_untouched():
    root, p1, new, old = make_project()
    same = build_editor(p1, "same", version="0.8.0", code="SAME")
    newer = build_editor(p1, "newer", version="0.9.1", code="NEWER")
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["upgraded"] == ["/project1/old"]
    assert rep["skipped_newer"] == [["/project1/newer", "0.9.1"]]
    assert rep["same"] == ["/project1/same"]
    assert "/project1/newer (0.9.1)" in rep["warning"]
    assert same.op("RasterEditorExt").text == "ext SAME"
    assert newer.op("RasterEditorExt").text == "ext NEWER" and registry.editor_version(newer) == "0.9.1"
    assert newer.ext.RasterEditorExt.calls == [] and same.ext.RasterEditorExt.calls == []


def test_non_editor_ops_never_touched():
    root, p1, new, old = make_project()
    foreign = p1.create("containerCOMP", "foreign")
    kid = foreign.create("textDAT", "protocol")
    kid.text = "mine"
    upgrade.upgrade_all(new, root, pace=False)
    assert foreign.op("protocol") is kid and kid.text == "mine" and foreign.valid
    assert [c.name for c in p1.children if c.name.startswith("_upg")] == []      # the temp backup is gone


def test_runtime_and_underscore_source_nodes_not_copied():
    root, p1, new, old = make_project()
    t = new.create("nullTOP", "imp_tmp")
    t.tags.add("reRuntime")
    new.create("nullTOP", "_scratch")
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("imp_tmp") is None and old.op("_scratch") is None


def test_extra_input_ports_kept_with_wires():
    root, p1, new, old = make_project()
    i2 = old.create("inTOP", "in2")
    i2.par.connectorder = 2
    up2 = p1.create("noiseTOP", "up2")
    old.inputConnectors[1].connect(up2)
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("in2") is i2
    assert [c.owner for c in old.inputConnectors[1].connections] == [up2]


# --------------------------------------------------------------------------- transactional behaviour

def _state(editor):
    return {
        "kids": {c.name: (id(c), c.text) for c in editor.children},
        "pars": [(p.name, p.val) for p in editor.customPars],
        "tags": set(editor.tags),
    }


def test_rollback_on_start_failure():
    root, p1, new, old = make_project()
    up, down = wire_outside(old, p1)
    old.par.Port = 7777
    before = _state(old)
    names_before = {c.name for c in old.children}
    FakeExt.fail_start_on = lambda comp: comp.path == "/project1/old" and comp.op("RasterEditorExt").text == "ext NEW"
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["upgraded"] == [] and len(rep["failed"]) == 1
    assert rep["failed"][0][0] == "/project1/old" and "start boom" in rep["failed"][0][1]
    assert "failed" in rep["warning"]
    # restored: same names, old code, old pars (Savetox back, Newpar gone), no tag, no version
    assert {c.name for c in old.children} == names_before
    assert old.op("RasterEditorExt").text == "ext OLD" and old.op("blend_glsl").text == "// shader"
    names = [p.name for p in old.customPars]
    assert "Savetox" in names and "Newpar" not in names and "Version" not in names
    assert old.par.Port.val == 7777
    assert registry.TAG not in old.tags and registry.editor_version(old) == "0.7.x"
    # data and the ports are the very same operators; wiring intact
    for n in ("doc", "doc_state", "in1", "out1"):
        assert old.op(n) is not None and before["kids"][n][0] == id(old.op(n))
    assert [c.owner for c in old.inputConnectors[0].connections] == [up]
    assert [c.owner for c in old.outputConnectors[0].connections] == [down]
    assert [c.owner for c in old.op("out1").inputConnectors[0].connections] == [old.op("out_switch")]
    assert [c.owner for c in old.op("out_switch").inputConnectors[0].connections] == [old.op("in1")]
    assert [c.owner.name for c in old.op("out_switch").inputConnectors[1].connections] == ["doc_out"]
    # a (re)started extension is running again and no temp COMP is left
    assert old.ext.RasterEditorExt.calls[-1] == "Start"
    assert not [c for c in p1.children if c.name.startswith("_upg")]
    assert old.par.ext0object.val.startswith("op(")


def test_freeze_failure_leaves_target_untouched():
    root, p1, new, old = make_project()
    kids = {c.name: id(c) for c in old.children}
    FakeExt.fail_freeze = True
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "freeze" in rep["failed"][0][1]
    assert {c.name: id(c) for c in old.children} == kids          # not a single operator replaced
    assert old.ext.RasterEditorExt.calls == ["PrepareUpgrade", "Freeze"]   # never stopped, never restarted
    assert not [c for c in p1.children if c.name.startswith("_upg")]


def test_one_failure_does_not_stop_the_others():
    root, p1, new, old = make_project()
    old2 = build_editor(p1, "old2", version="0.7.9", code="OLD2")
    FakeExt.fail_start_on = lambda comp: comp.path == "/project1/old" and comp.op("RasterEditorExt").text == "ext NEW"
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["upgraded"] == ["/project1/old2"]
    assert [f[0] for f in rep["failed"]] == ["/project1/old"]
    assert old2.op("RasterEditorExt").text == "ext NEW"


def test_unusable_source_changes_nothing():
    root, p1, new, old = make_project()
    new.op("RasterEditorExt").destroy()
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "not a usable upgrade source" in rep["failed"][0][1]
    assert old.op("RasterEditorExt").text == "ext OLD" and registry.editor_version(old) == "0.7.x"


def test_nothing_to_do():
    root, p1, new, old = make_project()
    upgrade.upgrade_all(new, root, pace=False)
    rep = upgrade.upgrade_all(new, root, pace=False)       # second run: old is now the same version
    assert rep["upgraded"] == [] and rep["failed"] == [] and rep["warning"] == ""
    assert rep["same"] == ["/project1/old"]


def test_hooks_called():
    root, p1, new, old = make_project()
    calls = []
    new.ext.RasterEditorExt.OnEditorsChanged = lambda: calls.append(1)
    upgrade.upgrade_all(new, root, pace=False)
    assert calls == [1]


# --------------------------------------------------------------------------- review fixes: data safety

def test_user_children_kept_and_listed_runtime_and_old_template_removed():
    root, p1, new, old = make_project()
    mine = old.create("nullTOP", "my_user_null")
    notes = old.create("textDAT", "_notes")            # '_' prefixed but not a known runtime pattern
    imp = old.create("selectTOP", "_imp_sel3")         # the extension's temporary operator
    stale = old.create("textDAT", "composite")         # an operator of an older build's template
    fx = old.create("textDAT", "fx_blur")
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert old.op("my_user_null") is mine and old.op("_notes") is notes
    assert old.op("_imp_sel3") is None and old.op("composite") is None
    assert old.op("fx_blur") is not fx                  # replaced by a template node ... or removed: never the stale object
    assert "my_user_null" in rep["warning"] and "_notes" in rep["warning"]


def test_user_child_named_like_source_template_is_template():
    root, p1, new, old = make_project()
    new.create("textDAT", "brand_new_node").text = "n"
    old.create("textDAT", "brand_new_node").text = "user's"     # same name as a node of the new template
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("brand_new_node").text == "n"


def test_rollback_failure_keeps_backup_renamed():
    root, p1, new, old = make_project()
    old.create("nullTOP", "my_user_null")
    FakeExt.fail_start_on = lambda comp: comp.path == "/project1/old"      # the rollback's restart fails too
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "ROLLBACK FAILED" in rep["failed"][0][1]
    bak = [c for c in p1.children if c.name.startswith("_upg_bak_FAILED_old")]
    assert len(bak) == 1 and bak[0].path in rep["failed"][0][1]
    assert bak[0].op("RasterEditorExt").text == "ext OLD"                  # the original operators are in it
    assert not [c for c in p1.children if c.name.startswith("_upg_bak_old")]


def test_swallowed_start_error_is_a_failure_and_rolls_back():
    root, p1, new, old = make_project()
    FakeExt.swallow = True           # the extension's _guard records last_error and returns
    FakeExt.fail_start_on = lambda comp: comp.op("RasterEditorExt").text == "ext NEW"
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "did not start" in rep["failed"][0][1] or "error while starting" in rep["failed"][0][1]
    assert old.op("RasterEditorExt").text == "ext OLD" and registry.editor_version(old) == "0.7.x"
    assert old.ext.RasterEditorExt._started and old.ext.RasterEditorExt.last_error is None


def test_version_stamped_only_after_success():
    root, p1, new, old = make_project()
    seen = []
    orig = FakeExt.Start

    def spy(self):
        seen.append(registry.editor_version(self.o))
        return orig(self)
    FakeExt.Start = spy
    try:
        upgrade.upgrade_all(new, root, pace=False)
    finally:
        FakeExt.Start = orig
    assert seen == ["0.7.x"] and registry.editor_version(old) == "0.8.0"


def test_stale_wire_on_copied_op_is_disconnected():
    root, p1, new, old = make_project()
    new.create("nullTOP", "n1")
    new.create("nullTOP", "n2")                       # n2 is wired to nothing in the source
    new.op("n1").inputConnectors[0].connect(new.op("in1"))
    upgrade.upgrade_all(new, root, pace=False)
    assert [c.owner.name for c in old.op("n1").inputConnectors[0].connections] == ["in1"]
    assert old.op("n2").inputConnectors[0].connections == []


def test_wiring_mismatch_raises_and_rolls_back(monkeypatch):
    root, p1, new, old = make_project()
    real = upgrade.child_wiring
    calls = []

    def lying(comp):
        out = real(comp)
        if comp is old:
            calls.append(1)
            out = dict(out)
            out["out_switch"] = []                    # as if the replay had not worked
        return out
    monkeypatch.setattr(upgrade, "child_wiring", lying)
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "wiring of out_switch" in rep["failed"][0][1]


def test_extension_pars_set_after_parameters():
    root, p1, new, old = make_project()
    order = []
    orig = FakeExt.__init__

    def init(self, comp):
        orig(self, comp)
        order.append(("Newpar" in [p.name for p in comp.customPars], comp.par.parentshortcut.val))
    FakeExt.__init__ = init
    try:
        old.par.parentshortcut = "Stale"
        upgrade.upgrade_all(new, root, pace=False)
    finally:
        FakeExt.__init__ = orig
    assert order[-1] == (True, "RasterEditor")           # parameters + extension pars complete when the new extension is built


def test_user_viewer_top_kept_template_top_replaced():
    root, p1, new, old = make_project()
    old.par.top = "/project1/my_viewer"
    new.par.top = "./webrender"
    upgrade.upgrade_all(new, root, pace=False)
    assert old.par.top.val == "/project1/my_viewer"
    root, p1, new, old = make_project()
    old.par.top = "./webrender"
    new.par.top = "./out1"
    upgrade.upgrade_all(new, root, pace=False)
    assert old.par.top.val == "./out1"


def test_unknown_pars_and_user_pages_never_removed_known_obsolete_warned():
    root, p1, new, old = make_project()
    old.customPages[0].appendFloat("Mygain")           # a user par on the template page
    old.appendCustomPage("Mine").appendInt("Mygain2")  # a user page
    old.par.Savetox.mode, old.par.Savetox.expr = "EXPRESSION", "1+1"      # obsolete template par with an expression
    rep = upgrade.upgrade_all(new, root, pace=False)
    names = {p.name: p.page.name for p in old.customPars}
    assert names.get("Mygain") == "Raster Editor" and names.get("Mygain2") == "Mine" and "Savetox" not in names
    assert "Savetox (expression)" in rep["warning"]


def test_dropped_page_tracked_by_storage():
    root, p1, new, old = make_project()
    # an earlier upgrade recorded that the template had a page 'Extras' with 'Zoomx'
    pg = old.appendCustomPage("Extras")
    pg.appendInt("Zoomx")
    pg.appendInt("Userthing")
    old.store(upgrade.STORE_PARS, ["Zoomx"])
    old.store(upgrade.STORE_PAGES, ["Extras", "Raster Editor"])
    upgrade.upgrade_all(new, root, pace=False)
    names = {p.name for p in old.customPars}
    assert "Zoomx" not in names and "Userthing" in names
    assert old.fetch(upgrade.STORE_PARS) == sorted(p.name for p in new.customPars)


def test_name_collision_with_user_page_par_fails_untouched():
    root, p1, new, old = make_project()
    old.appendCustomPage("Mine").appendInt("Newpar")
    kids = {c.name: id(c) for c in old.children}
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert rep["failed"] and "user page" in rep["failed"][0][1]
    assert {c.name: id(c) for c in old.children} == kids


def test_retarget_whole_path_segments_only():
    rx = upgrade._path_re("/p/raster_editor")
    assert rx.search("/p/raster_editor") and rx.search("op('/p/raster_editor/doc')")
    assert not rx.search("/p/raster_editor2") and not rx.search("/q/p/raster_editor") and not rx.search("/p/raster_editor_x")
    root, p1, new, old = make_project()
    new.op("keyboard").par.panels = new.path + "2"
    new.op("par_exec").par.op = new.path
    upgrade.upgrade_all(new, root, pace=False)
    assert old.op("keyboard").par.panels.val == "/project1/new2"
    assert old.op("par_exec").par.op.val == "/project1/old"


def test_linked_editors_skipped_and_reported():
    root, p1, new, old = make_project()
    ext_tox = build_editor(p1, "linked", version=None, code="LINK")
    ext_tox.par.externaltox = "x.tox"
    clone = build_editor(p1, "cloned", version=None, code="CLN")
    clone.par.clone = "/project1/master"
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert sorted(p for p, _ in rep["skipped_linked"]) == ["/project1/cloned", "/project1/linked"]
    assert "External .tox" in rep["warning"] and "Clone" in rep["warning"]
    assert ext_tox.op("RasterEditorExt").text == "ext LINK" and clone.op("RasterEditorExt").text == "ext CLN"


def test_synced_source_dats_are_embedded_in_the_copy():
    root, p1, new, old = make_project()
    d = new.op("blend_glsl")
    d.par.syncfile = 1
    d.par.file = "/repo/blend.glsl"
    rep = upgrade.upgrade_all(new, root, pace=False)
    assert old.op("blend_glsl").par.syncfile.val == 0 and old.op("blend_glsl").par.file.val == ""
    assert new.op("blend_glsl").par.syncfile.val == 1                     # the source itself is untouched
    assert "file-synced" in rep["warning"]


def test_one_editor_per_frame_and_callback():
    root, p1, new, old = make_project()
    old2 = build_editor(p1, "old2", version="0.7.9", code="OLD2")
    queue = []
    done = []
    ext_calls = []
    new.ext.RasterEditorExt.OnUpgradeDone = lambda rep: ext_calls.append(rep["upgraded"])
    upgrade._scheduler = lambda: (lambda fn, *a, delayFrames=0: queue.append((fn, a, delayFrames)))
    try:
        rep = upgrade.upgrade_all(new, root, on_done=done.append)
        assert rep["done"] is False and rep["upgraded"] == [] and len(rep["pending"]) == 2
        assert old.op("RasterEditorExt").text == "ext OLD"                  # nothing happened yet
        fn, a, d = queue.pop(0)
        assert d == 1
        fn(*a)
        assert len(rep["upgraded"]) == 1 and len(queue) == 1 and not done      # ONE editor in this frame
        fn, a, d = queue.pop(0)
        fn(*a)
    finally:
        del upgrade._scheduler
    assert rep["done"] and len(rep["upgraded"]) == 2 and rep["pending"] == []
    assert done == [rep] and ext_calls == [rep["upgraded"]]


def test_extension_is_not_detached():
    """ext0object is never cleared (a detach would look like a deletion to the old instance: master hand-over)."""
    root, p1, new, old = make_project()
    seen = []
    orig = FOp.initializeExtensions

    def spy(self):
        if self is old:
            seen.append(self.par.ext0object.val)
        return orig(self)
    FOp.initializeExtensions = spy
    try:
        upgrade.upgrade_all(new, root, pace=False)
    finally:
        FOp.initializeExtensions = orig
    assert seen and all(v for v in seen)
