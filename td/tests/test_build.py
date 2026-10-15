"""Pure parts of td/build_component.py: what an in-place rebuild keeps and destroys (the TD build itself is
exercised live by scripts/validate_td.py)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import build_component as B  # noqa: E402


class FakeOp:
    def __init__(self, name, log):
        self.name = name
        self.log = log
        self.destroyed = False

    def destroy(self):
        self.destroyed = True
        self.log.append(("destroy", self.name))


class FakePage:
    def __init__(self, name, log):
        self.name, self.log = name, log

    def destroy(self):
        self.log.append(("page", self.name))


class FakeComp:
    def __init__(self, names, pages=("Raster Editor",)):
        self.log = []
        self.children = [FakeOp(n, self.log) for n in names]
        self.customPages = [FakePage(n, self.log) for n in pages]
        self.inits = 0

        class Par:
            ext0object = "op('./RasterEditorExt').module.RasterEditorExt(me)"
        self.par = Par()

    def initializeExtensions(self):
        self.inits += 1
        self.log.append(("init", self.par.ext0object))


V2_CHILDREN = ["in1", "out1", "frames", "ui_html", "keyboard", "par_exec", "protocol", "composite", "webrender",
               "webserver", "frame_exec", "out_switch", "panel_exec", "RasterEditorExt", "keyboard_callbacks",
               "composite_callbacks", "webserver_callbacks"]
V3_CHILDREN = ["in1", "out1", "frames", "ui_html", "network", "blend_glsl", "doc", "doc_state", "protocol", "webrender",
               "webserver", "frame_exec", "RasterEditorExt", "par_exec"]


def test_doc_and_doc_state_are_the_only_kept_children():
    doomed, kept = B.rebuild_plan(V3_CHILDREN)
    assert kept == ["doc", "doc_state"] and "doc" not in doomed and "doc_state" not in doomed
    assert sorted(doomed + kept) == sorted(V3_CHILDREN)


def test_rebuilding_a_v2_comp_without_doc_keeps_nothing():
    doomed, kept = B.rebuild_plan(V2_CHILDREN)
    assert kept == [] and doomed == V2_CHILDREN


def test_clear_for_rebuild_destroys_everything_but_the_document():
    comp = FakeComp(V3_CHILDREN)
    kept = B.clear_for_rebuild(comp)
    survivors = [c.name for c in comp.children if not c.destroyed]
    assert survivors == ["doc", "doc_state"] and kept == survivors
    assert comp.par.ext0object == "" and comp.inits == 1
    assert ("page", "Raster Editor") in comp.log
    # the extension is detached before any child (e.g. its own DAT) is destroyed
    assert comp.log.index(("init", "")) < comp.log.index(("destroy", "RasterEditorExt"))


def test_quiesce_freezes_then_stops():
    calls = []

    class Ext:
        def Freeze(self):
            calls.append("Freeze")

        def Stop(self):
            calls.append("Stop")

    class Old:
        class ext:  # noqa: N801
            RasterEditorExt = Ext()
    B.quiesce(Old)
    assert calls == ["Freeze", "Stop"]


def test_quiesce_aborts_the_rebuild_when_freeze_fails():
    calls = []

    class Broken:
        def Freeze(self):
            raise RuntimeError("x")

        def Stop(self):
            calls.append("Stop")

    class Old:
        class ext:  # noqa: N801
            RasterEditorExt = Broken()
    with pytest.raises(RuntimeError, match="rebuild aborted"):
        B.quiesce(Old)
    assert calls == []  # nothing was stopped, the caller destroys nothing


def test_quiesce_without_an_extension_lets_the_rebuild_proceed(capsys):
    class Old:
        pass
    B.quiesce(Old)


def test_build_aborts_before_touching_the_comp_when_quiesce_raises():
    src = open(B.__file__).read()
    assert src.index("quiesce(old)") < src.index("clear_for_rebuild(old)")


class Conn:
    def __init__(self, owner):
        self.owner = owner


class Connector:
    def __init__(self):
        self.connections = []
        self.connected = []

    def connect(self, other):
        self.connected.append(other)


def test_restore_reapplies_values_and_connections_only_when_missing(capsys):
    class Par:
        def __init__(self):
            self.vals = {}

        def __getattr__(self, name):
            raise AttributeError(name)

    comp = type("C", (), {})()
    comp.par = type("P", (), {})()
    comp.par.Port = type("Q", (), {"val": 0})()
    comp.inputConnectors = [Connector()]
    comp.outputConnectors = [Connector()]
    target = type("T", (), {})()
    target.inputConnectors = [Connector()]
    src = object()
    state = {"pars": {"Port": 9999, "Gone": 1}, "in": src, "out": [(target, 0)]}
    B.restore(comp, state)
    assert comp.par.Port.val == 9999 and "could not restore Gone" in capsys.readouterr().out
    assert comp.inputConnectors[0].connected == [src] and target.inputConnectors[0].connected == [comp.outputConnectors[0]]
    # in-place rebuild: the connections are still there, so they are not touched
    comp.inputConnectors[0].connections = [Conn(src)]
    comp.inputConnectors[0].connected.clear()
    target.inputConnectors[0].connections = [Conn(comp)]
    target.inputConnectors[0].connected.clear()
    B.restore(comp, state)
    assert not comp.inputConnectors[0].connected and not target.inputConnectors[0].connected


def test_sources_list_embeds_network_and_shader():
    assert "td/raster_editor/network.py" in B.SOURCES and "td/raster_editor/blend.glsl" in B.SOURCES
    assert B.KEEP == ("doc", "doc_state") and B.SHORTCUT == "RasterEditor"


def test_frame_exec_calls_freeze_and_thaw_on_project_save():
    assert "def onProjectPreSave" in B.FRAME_EXEC and "OnProjectSave(True)" in B.FRAME_EXEC
    assert "def onProjectPostSave" in B.FRAME_EXEC and "OnProjectSave(False)" in B.FRAME_EXEC


def test_new_parameters_are_wired_to_the_par_exec():
    pars = B.PARAMS.split()
    assert "Maxviewfps" in pars and "Savetox" in pars and "Viewmode" not in pars


# --------------------------------------------------------------------------- parameter help (DESIGN_V3 section 1)

def _declared_params():
    """Every custom parameter name that build() creates (parsed from the source: build() needs TD)."""
    import re
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build_component.py"), encoding="utf-8").read()
    return set(re.findall(r'page\.append\w+\("(\w+)"', src))


def test_every_custom_parameter_has_help_text():
    declared = _declared_params()
    assert {"Active", "Port", "Status", "Viewmode", "Savetox"} <= declared
    assert declared == set(B.HELP), f"missing {declared - set(B.HELP)}, stale {set(B.HELP) - declared}"
    for name, text in B.HELP.items():
        assert len(text.strip()) >= 40, name


def test_help_says_defaults_units_and_read_only():
    h = B.HELP
    assert "default 9980" in h["Port"] and "1920" in h["Docw"] and "1080" in h["Doch"]
    for k in ("Maxsendfps", "Maxinputfps", "Maxviewfps"):
        assert "frames per second" in h[k] and "default 30" in h[k]
    assert "read-only" in h["Status"] and "read-only" in h["Viewmode"] and "Informational" in h["Status"]
    assert B.COMMENT


def test_params_list_matches_help_for_the_parameter_execute_dat():
    assert set(B.PARAMS.split()) <= set(B.HELP)
