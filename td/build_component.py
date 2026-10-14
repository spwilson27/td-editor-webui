"""Build /project1/raster_editor inside a running TouchDesigner and save dist/raster_editor.tox.

Run from a shell (the script forwards itself to TD through scripts/td_call.py):
    .venv/bin/python td/build_component.py [--dev]
or hand it to TD directly:
    .venv/bin/python scripts/td_call.py --exec /abs/path/td/build_component.py

--dev  DATs point at the repo files (file + syncfile) instead of embedding the text, so edits
       to td/raster_editor/*.py and dist/ui/index.html reload live. The .tox is not saved.

Idempotent: destroys and recreates the COMP, keeping its position, size and connections.
Only touches /project1/raster_editor.
"""

import os
import sys

if "op" in globals():  # executing inside TD (td_call exec namespace has no operator classes)
    from td import *  # noqa: F403

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if "__file__" in globals() else ""
PARENT = "/project1"
NAME = "raster_editor"


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

COMPOSITE_CALLBACKS = '''# Script TOP: output the extension's persistent numpy buffer.
def onSetupParameters(scriptOp):
    pass

def onPulse(par):
    pass

def onCook(scriptOp):
    scriptOp.parent().OnCompositeCook(scriptOp)
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
'''

PAR_EXEC = '''# Parameter Execute DAT: custom parameters -> extension.
def onValueChange(par, prev):
    parent().OnParChange(par)

def onPulse(par):
    parent().OnParChange(par)
'''

PARAMS = "Active Port Docw Doch Premultiplied Maxsendfps Maxinputfps Devurl Panelquery Openbrowser Reloadui"


# --------------------------------------------------------------------------- build (inside TD)


SOURCES = ("td/raster_editor/protocol.py", "td/raster_editor/frames.py", "td/raster_editor/ext.py",
           "dist/ui/index.html")


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


def build(dev=False):
    sources = read_sources()
    parent = op(PARENT)
    old = parent.op(NAME)
    state = {"x": 0, "y": 0, "w": 1280, "h": 800, "in": None, "out": [], "pars": {}}
    if old is not None:
        state.update(x=old.nodeX, y=old.nodeY, w=int(old.par.w), h=int(old.par.h))
        if old.inputConnectors and old.inputConnectors[0].connections:
            state["in"] = old.inputConnectors[0].connections[0].owner
        if old.outputConnectors:
            state["out"] = [(c.owner, c.index) for c in old.outputConnectors[0].connections]
        state["pars"] = {p.name: p.val for p in old.customPars
                         if p.name != "Status" and p.style != "Pulse" and not p.readOnly}
        old.destroy()

    comp = parent.create(containerCOMP, NAME)
    comp.nodeX, comp.nodeY = state["x"], state["y"]
    comp.par.w, comp.par.h = state["w"], state["h"]

    # --- custom parameters
    page = comp.appendCustomPage("Raster Editor")
    page.appendToggle("Active", label="Active")[0].default = True
    page.appendInt("Port", label="Port")[0].default = 9980
    page.appendInt("Docw", label="Doc Width")[0].default = 1920
    page.appendInt("Doch", label="Doc Height")[0].default = 1080
    page.appendToggle("Premultiplied", label="Premultiplied")[0].default = True
    page.appendInt("Maxsendfps", label="Max Send FPS")[0].default = 30
    page.appendInt("Maxinputfps", label="Max Input FPS")[0].default = 30
    page.appendStr("Devurl", label="Dev URL")
    page.appendStr("Panelquery", label="Panel Query")
    page.appendPulse("Openbrowser", label="Open in Browser")
    page.appendPulse("Reloadui", label="Reload UI")
    page.appendStr("Status", label="Status")[0].readOnly = True
    for name, lo, hi in (("Port", 1024, 65535), ("Docw", 1, 16384), ("Doch", 1, 16384),
                         ("Maxsendfps", 1, 120), ("Maxinputfps", 1, 120)):
        p = getattr(comp.par, name)
        p.min, p.max, p.clampMin, p.clampMax = lo, hi, True, True
    for name in ("Active", "Port", "Docw", "Doch", "Premultiplied", "Maxsendfps", "Maxinputfps"):
        getattr(comp.par, name).val = getattr(comp.par, name).default

    # --- python modules + html (before the extension is wired)
    text_dat(comp, "protocol", "td/raster_editor/protocol.py", dev, -600, 400, sources)
    text_dat(comp, "frames", "td/raster_editor/frames.py", dev, -600, 300, sources)
    ext = text_dat(comp, "RasterEditorExt", "td/raster_editor/ext.py", dev, -600, 200, sources)
    text_dat(comp, "ui_html", "dist/ui/index.html", dev, -600, 100, sources)

    # --- TOP chain
    in1 = comp.create(inTOP, "in1")
    in1.nodeX, in1.nodeY = -300, 0
    composite = comp.create(scriptTOP, "composite")
    composite.nodeX, composite.nodeY = -300, -150
    out_switch = comp.create(switchTOP, "out_switch")
    out_switch.nodeX, out_switch.nodeY = 0, -50
    out1 = comp.create(outTOP, "out1")
    out1.nodeX, out1.nodeY = 300, -50
    out_switch.inputConnectors[0].connect(in1)
    out_switch.inputConnectors[1].connect(composite)
    out1.inputConnectors[0].connect(out_switch)
    out_switch.par.index = 0
    out_switch.par.extend = "hold"
    composite_cb = op(composite.par.callbacks.eval())
    composite_cb.name = "composite_callbacks"
    composite_cb.text = COMPOSITE_CALLBACKS
    composite_cb.nodeX, composite_cb.nodeY = -600, -150

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
    if state["in"] is not None:
        comp.inputConnectors[0].connect(state["in"])
    for target, index in state["out"]:
        target.inputConnectors[index].connect(comp.outputConnectors[0])


def main(dev):
    comp, state = build(dev)
    if not dev:
        # Saved before restoring values and before Start(): the .tox carries defaults and no
        # runtime state (no token, no clients, server off).
        out = os.path.join(REPO, "dist", "raster_editor.tox")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        comp.save(out)
        print("saved", out)
    # Restore with par_exec off: otherwise its (next-frame) OnParChange callbacks would close the
    # sockets of the freshly started server for every restored value.
    par_exec = comp.op("par_exec")
    par_exec.par.active = 0
    restore(comp, state)
    comp.Start()
    par_exec.par.active = 1
    print("built", comp.path, "dev" if dev else "embedded")
    return comp


if "op" in globals():  # executing inside TD
    if not os.path.isabs(__file__):
        raise RuntimeError("pass an absolute path to td_call.py --exec (got %r)" % __file__)
    _comp = main(bool(globals().get("BUILD_DEV", False)))
elif __name__ == "__main__":
    sys.exit(_run_from_shell())
