"""Build /project1/raster_editor inside a running TouchDesigner and save dist/raster_editor.tox.

Run from a shell (the script forwards itself to TD through scripts/td_call.py):
    .venv/bin/python td/build_component.py [--dev]
or hand it to TD directly:
    .venv/bin/python scripts/td_call.py --exec /abs/path/td/build_component.py

--dev  DATs point at the repo files (file + syncfile) instead of embedding the text, so edits
       to td/raster_editor/*.py, blend.glsl and dist/ui/index.html reload live. The .tox is not saved.

Idempotent: rebuilds the COMP's contents in place, keeping its position, size, connections and the
document (the `doc` network with its locked surface TOPs + the `doc_state` DAT), which survive every
rebuild. The clean dist/raster_editor.tox is exported from a throw-away build (no document in it).
Only touches /project1/raster_editor (and a temporary /project1/_re_tox_build, destroyed again).
"""

import os
import sys

if "op" in globals():  # executing inside TD (td_call exec namespace has no operator classes)
    from td import *  # noqa: F403

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if "__file__" in globals() else ""
PARENT = "/project1"
NAME = "raster_editor"
TOX_NAME = "_re_tox_build"
KEEP = ("doc", "doc_state")  # survive rebuilds: the generated network + the stored document
SHORTCUT = "RasterEditor"  # parent shortcut: doc/surface_callbacks call parent.RasterEditor.OnSurfaceCook


def _run_from_shell():
    import subprocess
    dev = "--dev" in sys.argv[1:]
    script = os.path.abspath(__file__)
    code = f"BUILD_DEV = {dev!r}\n__file__ = {script!r}\n" + open(script, encoding="utf-8").read()
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(script)), "scripts"))
    import td_call
    res = td_call.run(code, 120)
    for key in ("stdout", "stderr", "traceback"):
        if res.get(key):
            sys.stdout.write(res[key])
    return 0 if res.get("ok") else 1


# --------------------------------------------------------------------------- callback sources

WEBSERVER_CALLBACKS = '''# Web Server DAT callbacks: thin delegation to the RasterEditorExt extension.
def onHTTPRequest(dat, request, response):
    return dat.parent().OnHTTPRequest(request, response) or response

def onWebSocketOpen(dat, client, uri):
    dat.parent().OnWebSocketOpen(client, uri)

def onWebSocketClose(dat, client):
    dat.parent().OnWebSocketClose(client)

def onWebSocketReceiveText(dat, client, data):
    dat.parent().OnWebSocketText(client, data)

def onWebSocketReceiveBinary(dat, client, data):
    dat.parent().OnWebSocketBinary(client, data)

def onWebSocketReceivePing(dat, client, data):
    dat.webSocketSendPong(client, data=data)

def onWebSocketReceivePong(dat, client, data):
    pass

def onServerStart(dat):
    pass

def onServerStop(dat):
    pass
'''

# GPU side of the external TD-view stream: unpremultiply (uCfg.x = 1 when the output is premultiplied), flip so row 0 is
# the top row, scale to exact 0..255 integers in a 32-bit float texture. numpyArray() always returns float32, so doing this
# on the GPU leaves the CPU a single truncating cast (2.5 ms for 1080p instead of ~27 ms of float maths).
VIEW_PACK_GLSL = '''uniform vec4 uCfg;
out vec4 fragColor;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 res = ivec2(uTDOutputInfo.res.zw);
    vec4 c = texelFetch(sTD2DInputs[0], ivec2(p.x, res.y - 1 - p.y), 0);
    if (uCfg.x > 0.5) c.rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    c = clamp(c, 0.0, 1.0);
    fragColor = TDOutputSwizzle(floor(c * 255.0 + 0.5));
}
'''

KEYBOARD_CALLBACKS = '''# Keyboard In DAT: forwarded to the web panel while this COMP's panel has focus.
def onKey(dat, keyInfo):
    dat.parent().OnKey(keyInfo)

def onShortcut(dat, shortcutName, time):
    pass
'''

PANEL_EXEC = '''# Panel Execute DAT: mouse over the COMP's panel -> Web Render TOP (both bottom-left origin).
def onOffToOn(panelValue):
    parent().OnPanelValue(panelValue, 1)

def whileOn(panelValue):
    pass

def onOnToOff(panelValue):
    parent().OnPanelValue(panelValue, 0)

def whileOff(panelValue):
    pass

def onValueChange(panelValue, prev):
    parent().OnPanelValue(panelValue)
'''

FRAME_EXEC = '''# Execute DAT: drives the extension.
def onStart():
    parent().Start()

def onCreate():
    parent().Start()

def onExit():
    parent().Stop()

def onFrameStart(frame):
    parent().Pump()

def onFrameEnd(frame):
    pass

def onProjectPreSave():
    parent().OnProjectSave(True)

def onProjectPostSave():
    parent().OnProjectSave(False)
'''

PAR_EXEC = '''# Parameter Execute DAT: custom parameters -> extension.
def onValueChange(par, prev):
    parent().OnParChange(par)

def onPulse(par):
    parent().OnParChange(par)
'''

PARAMS = "Active Port Docw Doch Premultiplied Maxsendfps Maxinputfps Maxviewfps Devurl Panelquery Openbrowser Reloadui Savetox"


# --------------------------------------------------------------------------- build (inside TD)


SOURCES = ("td/raster_editor/protocol.py", "td/raster_editor/frames.py", "td/raster_editor/ext.py",
           "td/raster_editor/network.py", "td/raster_editor/blend.glsl", "dist/ui/index.html")


def read_sources():
    """Read every embedded file up front, before the old COMP is touched."""
    out = {}
    for rel in SOURCES:
        path = os.path.join(REPO, rel)
        if not os.path.isfile(path):
            hint = " (run `npm run build` in web/ first)" if rel.startswith("dist/") else ""
            raise RuntimeError(f"missing {path}{hint}; the existing COMP was left untouched")
        with open(path, encoding="utf-8") as f:
            out[rel] = f.read()
    return out


def text_dat(comp, name, rel, dev, x, y, sources):
    """textDAT holding a repo file: embedded text, or file-synced in --dev mode."""
    d = comp.create(textDAT, name)
    d.nodeX, d.nodeY = x, y
    if dev:
        d.par.file = os.path.join(REPO, rel)
        d.par.syncfile = 1
        d.par.loadonstart = 1
        d.par.loadonstartpulse.pulse()
    else:
        d.text = sources[rel]
    return d


def rebuild_plan(child_names):
    """(names to destroy, names kept) when rebuilding a COMP that already has these children."""
    names = list(child_names)
    return [n for n in names if n not in KEEP], [n for n in names if n in KEEP]


def clear_for_rebuild(comp):
    """Empty an existing COMP for an in-place rebuild: everything but ``doc`` / ``doc_state`` is destroyed,
    the extension is detached and the custom parameter pages are removed. Returns the kept names."""
    comp.par.ext0object = ""
    comp.initializeExtensions()  # drop the old extension instance (and its promoted methods) first
    pairs = [(c.name, c) for c in comp.children]  # names first: destroying a DAT can take its callbacks DAT along
    doomed, kept = rebuild_plan(n for n, _ in pairs)
    for n, c in pairs:
        if n in doomed:
            try:
                c.destroy()
            except Exception:  # noqa: BLE001 - already gone with its parent operator
                pass
    for page in list(comp.customPages):
        page.destroy()
    return kept


def quiesce(old):
    """Before an in-place rebuild: lock the surface TOPs (their pixels are the only copy once the extension's
    numpy buffers are gone; the new extension reads them back in Restore) and stop the old extension.
    A failing Freeze ABORTS the rebuild (raises) with nothing locked or destroyed; a COMP without a working
    extension (nothing to lose) is rebuilt anyway."""
    try:
        ext = getattr(getattr(old, "ext", None), "RasterEditorExt", None)
    except Exception:  # noqa: BLE001 - no extension initialised
        ext = None
    if ext is not None and hasattr(ext, "Freeze"):
        try:
            ext.Freeze()
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"rebuild aborted: could not freeze the surfaces ({e}); the COMP was left untouched") from e
    try:
        ext.Stop()
    except Exception as e:  # noqa: BLE001
        print("quiesce: Stop failed:", e)


def build(dev=False, name=NAME, in_place=True):
    sources = read_sources()
    parent = op(PARENT)
    old = parent.op(name) if in_place else None
    state = {"x": 0, "y": 0, "w": 1280, "h": 800, "in": None, "out": [], "pars": {}, "kept": []}
    if old is not None:
        state.update(x=old.nodeX, y=old.nodeY, w=int(old.par.w), h=int(old.par.h))
        if old.inputConnectors and old.inputConnectors[0].connections:
            state["in"] = old.inputConnectors[0].connections[0].owner
        if old.outputConnectors:
            state["out"] = [(c.owner, c.index) for c in old.outputConnectors[0].connections]
        state["pars"] = {p.name: p.val for p in old.customPars
                         if p.name != "Status" and p.style != "Pulse" and not p.readOnly}
        quiesce(old)
        state["kept"] = clear_for_rebuild(old)
        comp = old
    else:
        stale = parent.op(name)
        if stale is not None:
            stale.destroy()
        comp = parent.create(containerCOMP, name)
        comp.nodeX, comp.nodeY = state["x"], state["y"]
    comp.par.w, comp.par.h = state["w"], state["h"]
    comp.par.parentshortcut = SHORTCUT

    # --- custom parameters
    page = comp.appendCustomPage("Raster Editor")
    page.appendToggle("Active", label="Active")[0].default = True
    page.appendInt("Port", label="Port")[0].default = 9980
    page.appendInt("Docw", label="Doc Width")[0].default = 1920
    page.appendInt("Doch", label="Doc Height")[0].default = 1080
    page.appendToggle("Premultiplied", label="Premultiplied")[0].default = True
    page.appendInt("Maxsendfps", label="Max Send FPS")[0].default = 30
    page.appendInt("Maxinputfps", label="Max Input FPS")[0].default = 30
    page.appendInt("Maxviewfps", label="Max View FPS")[0].default = 30
    vm = page.appendMenu("Viewmode", label="View Mode")[0]
    vm.menuNames = ["local", "td"]
    vm.menuLabels = ["Local", "TD"]
    vm.default = "local"
    vm.readOnly = True
    page.appendStr("Devurl", label="Dev URL")
    page.appendStr("Panelquery", label="Panel Query")
    page.appendPulse("Openbrowser", label="Open in Browser")
    page.appendPulse("Reloadui", label="Reload UI")
    page.appendPulse("Savetox", label="Save TOX")
    page.appendStr("Status", label="Status")[0].readOnly = True
    for pname, lo, hi in (("Port", 1024, 65535), ("Docw", 1, 16384), ("Doch", 1, 16384),
                          ("Maxsendfps", 1, 120), ("Maxinputfps", 1, 120), ("Maxviewfps", 1, 120)):
        p = getattr(comp.par, pname)
        p.min, p.max, p.clampMin, p.clampMax = lo, hi, True, True
    for pname in ("Active", "Port", "Docw", "Doch", "Premultiplied", "Maxsendfps", "Maxinputfps", "Maxviewfps"):
        getattr(comp.par, pname).val = getattr(comp.par, pname).default
    comp.par.Viewmode = "local"

    # --- python modules + html + shader (before the extension is wired)
    text_dat(comp, "protocol", "td/raster_editor/protocol.py", dev, -600, 500, sources)
    text_dat(comp, "frames", "td/raster_editor/frames.py", dev, -600, 400, sources)
    text_dat(comp, "network", "td/raster_editor/network.py", dev, -600, 300, sources)
    text_dat(comp, "RasterEditorExt", "td/raster_editor/ext.py", dev, -600, 200, sources)
    text_dat(comp, "ui_html", "dist/ui/index.html", dev, -600, 100, sources)
    text_dat(comp, "blend_glsl", "td/raster_editor/blend.glsl", dev, -600, 0, sources)
    if comp.op("doc_state") is None:
        ds = comp.create(textDAT, "doc_state")
        ds.nodeX, ds.nodeY = -900, 200

    # --- TOP chain: in1 / doc_out (= doc/out) -> out_switch -> out1
    in1 = comp.create(inTOP, "in1")
    in1.nodeX, in1.nodeY = -300, 0
    out_switch = comp.create(switchTOP, "out_switch")
    out_switch.nodeX, out_switch.nodeY = 0, -50
    out1 = comp.create(outTOP, "out1")
    out1.nodeX, out1.nodeY = 300, -50
    doc_out = comp.create(selectTOP, "doc_out")  # wires cannot enter the doc COMP: select its output
    doc_out.nodeX, doc_out.nodeY = -300, -150
    doc_out.par.top = "doc/out"
    pack_dat = comp.create(textDAT, "view_pack_glsl")
    pack_dat.text = VIEW_PACK_GLSL
    pack_dat.nodeX, pack_dat.nodeY = -600, -250
    pack = comp.create(glslTOP, "view_pack")
    pack.nodeX, pack.nodeY = -100, -250
    pack.par.pixeldat = pack_dat
    pack.par.format = "rgba32float"
    pack.par.vec0name = "uCfg"
    pack.par.vec0valuex = 1
    pack.inputConnectors[0].connect(doc_out)
    out_switch.inputConnectors[0].connect(in1)
    out_switch.inputConnectors[1].connect(doc_out)
    out1.inputConnectors[0].connect(out_switch)
    out_switch.par.index = 0
    out_switch.par.extend = "hold"

    # --- server
    ws = comp.create(webserverDAT, "webserver")
    ws.nodeX, ws.nodeY = -300, 300
    ws.par.port = 9980
    ws.par.active = 0  # the extension starts it
    ws_cb = op(ws.par.callbacks.eval())
    ws_cb.name = "webserver_callbacks"
    ws_cb.text = WEBSERVER_CALLBACKS
    ws_cb.nodeX, ws_cb.nodeY = -300, 200

    # --- panel
    wr = comp.create(webrenderTOP, "webrender")
    wr.nodeX, wr.nodeY = 0, 200
    wr.par.source = "urlorfile"
    wr.par.url = "about:blank"
    wr.par.outputresolution = "custom"
    wr.par.resolutionw.expr = "parent().par.w"
    wr.par.resolutionh.expr = "parent().par.h"
    wr.par.dpiscale = 1
    wr.par.alwayscook = 1
    wr.par.maxrenderrate = 60
    wr.par.transparent = 1  # always on (toggling it reloads the page); the page paints an opaque background in Local mode
    wr.par.active = 1
    comp.par.top = "./webrender"
    comp.par.topfill = "native"

    pe = comp.create(panelexecuteDAT, "panel_exec")
    pe.nodeX, pe.nodeY = 300, 200
    pe.text = PANEL_EXEC
    pe.par.panelvalue = "u v lselect mselect rselect wheel"
    pe.par.valuechange = 1
    pe.par.offtoon = 1
    pe.par.ontooff = 1

    kb = comp.create(keyboardinDAT, "keyboard")
    kb.nodeX, kb.nodeY = 300, 350
    kb_cb = op(kb.par.callbacks.eval())
    kb_cb.name = "keyboard_callbacks"
    kb_cb.text = KEYBOARD_CALLBACKS
    kb_cb.nodeX, kb_cb.nodeY = 300, 450
    kb.par.panels = comp

    fe = comp.create(executeDAT, "frame_exec")
    fe.nodeX, fe.nodeY = 600, 200
    fe.text = FRAME_EXEC
    fe.par.start = 1
    fe.par.create = 1
    fe.par.exit = 1
    fe.par.framestart = 1
    fe.par.projectpresave = 1
    fe.par.projectpostsave = 1

    pa = comp.create(parameterexecuteDAT, "par_exec")
    pa.nodeX, pa.nodeY = 600, 350
    pa.text = PAR_EXEC
    pa.par.op = comp
    pa.par.pars = PARAMS
    pa.par.valuechange = 1
    pa.par.onpulse = 1

    # --- extension (promoted: parent().Pump(), parent().GetStatus(), ...)
    comp.par.ext0object = "op('./RasterEditorExt').module.RasterEditorExt(me)"
    comp.par.ext0name = "RasterEditorExt"
    comp.par.ext0promote = 1
    comp.initializeExtensions()

    return comp, state


def restore(comp, state):
    """Re-apply what the old COMP had: parameter values and connections."""
    for name, val in state["pars"].items():
        try:
            getattr(comp.par, name).val = val
        except Exception as e:  # noqa: BLE001 - a parameter that no longer exists
            print("could not restore", name, e)
    if state["in"] is not None and not comp.inputConnectors[0].connections:
        comp.inputConnectors[0].connect(state["in"])
    for target, index in state["out"]:
        if not any(c.owner is comp for c in target.inputConnectors[index].connections):
            target.inputConnectors[index].connect(comp.outputConnectors[0])


def export_tox(dev):
    """dist/raster_editor.tox from a throw-away clean build (no document, defaults, no runtime state)."""
    if dev:
        return
    scratch, _ = build(False, TOX_NAME, in_place=False)
    try:
        out = os.path.join(REPO, "dist", "raster_editor.tox")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        scratch.save(out)
        print("saved", out)
    finally:
        scratch.destroy()  # same script, no frame ran in between: its extension never started


def main(dev):
    export_tox(dev)
    comp, state = build(dev)
    # Restore with par_exec off: otherwise its (next-frame) OnParChange callbacks would close the
    # sockets of the freshly started server for every restored value.
    par_exec = comp.op("par_exec")
    par_exec.par.active = 0
    restore(comp, state)
    comp.Start()
    par_exec.par.active = 1
    print("built", comp.path, "dev" if dev else "embedded", "kept", state["kept"])
    return comp


if "op" in globals():  # executing inside TD
    if not os.path.isabs(__file__):
        raise RuntimeError("pass an absolute path to td_call.py --exec (got %r)" % __file__)
    _comp = main(bool(globals().get("BUILD_DEV", False)))
elif __name__ == "__main__":
    sys.exit(_run_from_shell())
