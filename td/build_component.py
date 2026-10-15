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
Only touches /project1/raster_editor (and a temporary /project1/_re_tox_build, always destroyed again,
also when its build fails).
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

# Help text for every custom parameter (shown by TD as the tooltip / help of the parameter). Said in the
# order: what it does, units / range, default, when to change it.
HELP = {
    "Active": "Turns the editor on or off. On (default): the web server runs, the editor panel is shown and the "
              "output is the edited document. Off: the server is stopped, clients are disconnected and the output "
              "is the input passed through unchanged. Turn off to save GPU/CPU when the editor is not needed; the "
              "document is kept.",
    "Port": "TCP port of the editor's web server on 127.0.0.1 (1024-65535, default 9980). The editor panel and "
            "Open in Browser connect to it. Change it only if another program already uses 9980, or to run two "
            "editors in one project; changing it restarts the server and reloads the panel.",
    "Docsizemode": "How the document (canvas) size is chosen. Follow Input (default): the document is the size of the "
                   "connected input image; with no input it is Doc Width x Doc Height. Fixed: always Doc Width x "
                   "Doc Height; an input keeps its own resolution and is placed as a movable layer. The editor's "
                   "Document > Canvas Size dialog sets this and Doc Width / Doc Height for you. Switching to Fixed "
                   "keeps the current size. Layers are never resampled by a size change.",
    "Docw": "Document width in pixels (1-16384, default 1920). Used when Document Size Mode is Fixed, or when it is "
            "Follow Input and no input is connected; ignored while an input is followed. Changing it changes the "
            "canvas only: layers keep their pixels and positions (the editor's Canvas Size dialog can also shift "
            "them by an anchor).",
    "Doch": "Document height in pixels (1-16384, default 1080). Used when Document Size Mode is Fixed, or when it is "
            "Follow Input and no input is connected; ignored while an input is followed. Changing it changes the "
            "canvas only: layers keep their pixels and positions (the editor's Canvas Size dialog can also shift "
            "them by an anchor).",
    "Premultiplied": "Whether TouchDesigner's image data is premultiplied by alpha (on, default, which is TD's "
                     "convention). On: the input is un-premultiplied before the editor sees it, the output is "
                     "premultiplied again, and layers are stored premultiplied. Also applies to Flatten and TOP "
                     "imports. Turn off only if your input is straight (non-premultiplied) alpha and the output "
                     "should be straight too. Has no visible effect on fully opaque images.",
    "Maxsendfps": "Upper limit, in frames per second (1-120, default 30), that the web editor uses when it sends "
                  "painted pixels to TouchDesigner. Lower it to reduce load on slow machines; raise it for the "
                  "smoothest live strokes. Sent to the editor when it connects.",
    "Maxinputfps": "Upper limit, in frames per second (1-120, default 30), at which the connected input image is "
                   "copied to the editor as the background layer. Only matters for inputs that change over time "
                   "(video, generative). Lower it to save CPU; static inputs cost nothing.",
    "Maxviewfps": "Upper limit, in frames per second (1-120, default 30), at which the finished output is sent to "
                  "the editor while its view mode is TD (the editor shows TouchDesigner's result). Lower it to save "
                  "CPU; it does not affect the output TOP itself.",
    "Viewmode": "Informational, read-only: whether the active editor currently shows its own preview (Local) or "
                "TouchDesigner's rendered output (TD). Switch it in the editor's View menu, not here.",
    "Devurl": "Developer option: URL of a web development server (for example http://localhost:5173/) that the "
              "panel should load instead of the built-in editor. Leave empty (default) in normal use.",
    "Panelquery": "Developer option: extra URL query string added to the panel and Open in Browser addresses, "
                  "for example test=1 to enable the automated-test hook. Leave empty (default) in normal use.",
    "Openbrowser": "Pulse: opens the editor in your default web browser (a second window onto the same document, "
                   "authorised with this session's token). The panel stays the active editor until the "
                   "browser window takes over.",
    "Reloadui": "Pulse: reloads the editor page in the panel. Use it if the panel looks stuck or after updating "
                "the editor; the document is kept in TouchDesigner and reloaded.",
    "Exportpath": "File the Export with Document pulse writes: a .tox (default empty = raster_editor_export.tox next "
                  "to the project file). A relative path is relative to the project folder, a missing .tox ending is "
                  "added, and the folder must already exist.",
    "Exportdoc": "Pulse (Export with Document): saves this component as a .tox at Export Path including the current "
                 "document, all layers' pixels, guides and the canvas size mode, so loading the .tox restores the "
                 "editor as you left it. An existing file at Export Path is overwritten. It is written to a temporary file and renamed, so a failed export never "
                 "damages an earlier one. Refused while the document is still being restored. Does not save the "
                 "project itself; the result is shown in Status.",
    "Projectfile": "The project file (.redoc) that Save Project writes and Open Project reads (default empty = "
                   "raster_editor.redoc in the project folder for saving). A relative path is relative to the project "
                   "folder and a missing .redoc ending is added. A .redoc is a zip with the whole document: layers "
                   "with their transforms, masks, text/shape/adjustment settings, effects, guides and canvas mode "
                   "plus every layer's pixels as PNG. TD Inputs are live and are not stored. The editor's File menu "
                   "writes this parameter for you.",
    "Saveproject": "Pulse: writes the current document to Project File (.redoc). The file is written to a temporary "
                   "file and renamed, so a failed save never damages an earlier one; the pixels are encoded off the "
                   "main thread so the output keeps running. Refused while a restore or another file operation is "
                   "running. The result is shown in Status and sent to the editor.",
    "Openproject": "Pulse: replaces the current document with the one in Project File (.redoc): layers, pixels, "
                   "effects, guides and canvas mode (Doc Width/Height and Document Size Mode follow the file). The "
                   "undo history of every editor window is cleared and all windows reload the document. Nothing is "
                   "changed when the file is damaged or invalid; the reason is shown in Status. TD Inputs are live: "
                   "input layers show whatever is connected now.",
    "Pngfile": "The PNG file that Export PNG writes (default empty = raster_editor.png in the project folder). A "
               "relative path is relative to the project folder and a missing .png ending is added. The editor's File "
               "menu writes this parameter for you.",
    "Exportpng": "Pulse: saves the flattened output of this component (what the output TOP shows, at the document "
                 "size) to PNG File with straight (non-premultiplied) alpha, as 8-bit RGBA. Written to a temporary "
                 "file and renamed. Refused while the editor is inactive or another file operation is running. "
                 "The result is shown in Status.",
    "Status": "Informational, read-only: a one-line summary of the editor (which window is active, document size, "
              "tiles per second received, connected windows, errors). Nothing to set here.",
}
COMMENT = ("Raster Editor: a layer-based raster editor with a web UI. Wire TOPs into the inputs (a new spare input "
           "appears as you connect, up to 8) or set the document size on the Raster Editor page; Open in Browser "
           "opens a second window; Save/Open Project and Export PNG are on the same page. Hover a parameter for help.")

PARAMS = "Active Port Docw Doch Premultiplied Maxsendfps Maxinputfps Maxviewfps Devurl Panelquery Openbrowser Reloadui Exportdoc Docsizemode Projectfile Saveproject Openproject Pngfile Exportpng"


# --------------------------------------------------------------------------- build (inside TD)


SOURCES = ("td/raster_editor/protocol.py", "td/raster_editor/frames.py", "td/raster_editor/ext.py",
           "td/raster_editor/network.py", "td/raster_editor/effects.py", "td/raster_editor/blend.glsl",
           "td/raster_editor/shape.glsl", "dist/ui/index.html")
EFFECT_DIR = "shared/effects"  # shared with the web preview; every *.glsl becomes a DAT `fx_<stem>` (common, dropShadow, ...)
MAX_INPUTS = 8


def effect_sources(repo=None):
    """Repo-relative paths of the shared effect shaders (sorted). Missing folder -> none: the COMP builds without effects."""
    root = os.path.join(repo if repo is not None else REPO, EFFECT_DIR)
    if not os.path.isdir(root):
        return []
    return [f"{EFFECT_DIR}/{n}" for n in sorted(os.listdir(root)) if n.endswith(".glsl")]


def effect_dat_name(rel):
    return "fx_" + os.path.splitext(os.path.basename(rel))[0]


def read_sources():
    """Read every embedded file up front, before the old COMP is touched."""
    out = {}
    for rel in SOURCES + tuple(effect_sources()):
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
    state = {"x": 0, "y": 0, "w": 1280, "h": 800, "ins": {}, "n_in": 1, "out": [], "pars": {}, "kept": []}
    if old is not None:
        state.update(x=old.nodeX, y=old.nodeY, w=int(old.par.w), h=int(old.par.h))
        state["ins"] = {i + 1: k.connections[0].owner for i, k in enumerate(old.inputConnectors) if k.connections}
        state["n_in"] = min(MAX_INPUTS, max(state["ins"], default=0) + 1)
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
    dm = page.appendMenu("Docsizemode", label="Document Size Mode")[0]
    dm.menuNames = ["input", "fixed"]
    dm.menuLabels = ["Follow Input", "Fixed"]
    dm.default = "input"
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
    page.appendFile("Exportpath", label="Export Path")
    page.appendPulse("Exportdoc", label="Export with Document")
    page.appendFile("Projectfile", label="Project File")
    page.appendPulse("Saveproject", label="Save Project")
    page.appendPulse("Openproject", label="Open Project")
    page.appendFile("Pngfile", label="PNG File")
    page.appendPulse("Exportpng", label="Export PNG")
    page.appendStr("Status", label="Status")[0].readOnly = True
    for pname, lo, hi in (("Port", 1024, 65535), ("Docw", 1, 16384), ("Doch", 1, 16384),
                          ("Maxsendfps", 1, 120), ("Maxinputfps", 1, 120), ("Maxviewfps", 1, 120)):
        p = getattr(comp.par, pname)
        p.min, p.max, p.clampMin, p.clampMax = lo, hi, True, True
    # (TD 2025.32820 has no file-type filter for a custom File parameter: ExportDoc appends ".tox" itself)
    for pname in ("Active", "Port", "Docw", "Doch", "Premultiplied", "Maxsendfps", "Maxinputfps", "Maxviewfps"):
        getattr(comp.par, pname).val = getattr(comp.par, pname).default
    comp.par.Docsizemode = "input"
    comp.par.Viewmode = "local"
    for pname, text in HELP.items():
        getattr(comp.par, pname).help = text
    comp.comment = COMMENT
    probe = comp.create(textTOP, "font_probe")  # hidden: never cooked; its `font` menu lists the system fonts
    probe.nodeX, probe.nodeY = -300, -350
    probe.viewer = False

    # --- python modules + html + shader (before the extension is wired)
    text_dat(comp, "protocol", "td/raster_editor/protocol.py", dev, -600, 500, sources)
    text_dat(comp, "frames", "td/raster_editor/frames.py", dev, -600, 400, sources)
    text_dat(comp, "network", "td/raster_editor/network.py", dev, -600, 300, sources)
    text_dat(comp, "effects", "td/raster_editor/effects.py", dev, -900, 300, sources)
    for i, rel in enumerate(effect_sources()):  # shader sources shared with the web preview
        text_dat(comp, effect_dat_name(rel), rel, dev, -1200 + 150 * (i % 4), -400 - 100 * (i // 4), sources)
    text_dat(comp, "RasterEditorExt", "td/raster_editor/ext.py", dev, -600, 200, sources)
    text_dat(comp, "ui_html", "dist/ui/index.html", dev, -600, 100, sources)
    text_dat(comp, "blend_glsl", "td/raster_editor/blend.glsl", dev, -600, 0, sources)
    text_dat(comp, "shape_glsl", "td/raster_editor/shape.glsl", dev, -600, -100, sources)
    if comp.op("doc_state") is None:
        ds = comp.create(textDAT, "doc_state")
        ds.nodeX, ds.nodeY = -900, 200

    # --- TOP chain: in1 / doc_out (= doc/out) -> out_switch -> out1
    in1 = comp.create(inTOP, "in1")  # in2..in8 are created by the extension, always one spare connector (Connector Order = N)
    in1.nodeX, in1.nodeY = -300, 0
    in1.par.connectorder = 1
    extra = []
    for n in range(2, min(MAX_INPUTS, state.get("n_in", 1)) + 1):  # a rebuild keeps the connectors that had wires
        t = comp.create(inTOP, f"in{n}")
        t.nodeX, t.nodeY = -300, 150 - 100 * n
        t.par.connectorder = n
        extra.append(t)
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
    for n, src in sorted(state["ins"].items()):
        if n <= len(comp.inputConnectors) and not comp.inputConnectors[n - 1].connections:
            comp.inputConnectors[n - 1].connect(src)
    for target, index in state["out"]:
        if not any(c.owner is comp for c in target.inputConnectors[index].connections):
            target.inputConnectors[index].connect(comp.outputConnectors[0])


def destroy_scratch():
    """Destroy the temporary clean-build COMP (/project1/_re_tox_build) if it exists."""
    stale = op(PARENT).op(TOX_NAME)
    if stale is not None:
        try:
            stale.destroy()
        except Exception as e:  # noqa: BLE001
            print("could not destroy", TOX_NAME, e)


def export_tox(dev):
    """dist/raster_editor.tox from a throw-away clean build (no document, defaults, no runtime state)."""
    if dev:
        return
    destroy_scratch()  # a leftover of an earlier failed run
    try:
        scratch, _ = build(False, TOX_NAME, in_place=False)
        out = os.path.join(REPO, "dist", "raster_editor.tox")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        scratch.save(out)
        print("saved", out)
    finally:
        destroy_scratch()  # always, also when build() or save() failed half way (no frame ran: its extension never started)


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
