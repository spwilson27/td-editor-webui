"""Minimal fake TouchDesigner objects for exercising RasterEditorExt without TD."""

import json
import types

import numpy as np

import frames
import protocol


class Par:
    def __init__(self, name, val=None):
        self.name = name
        self.val = val
        self.pulses = 0

    def eval(self):
        return self.val

    def pulse(self):
        self.pulses += 1


class Pars:
    def __init__(self, **vals):
        object.__setattr__(self, "_d", {k: Par(k, v) for k, v in vals.items()})

    def __getattr__(self, name):
        d = object.__getattribute__(self, "_d")
        if name not in d:
            d[name] = Par(name)
        return d[name]

    def __setattr__(self, name, value):
        getattr(self, name).val = value


class Module:
    def __init__(self, module):
        self.module = module


class FakeServer:
    def __init__(self):
        self.par = Pars(active=0, port=0, restart=None)
        self.texts = []  # (client, parsed json)
        self.binaries = []  # (client, bytes)
        self.webSocketConnections = []
        self.closed = []

    def webSocketSendText(self, client, text):
        self.texts.append((client, json.loads(text)))

    def webSocketSendBinary(self, client, data):
        self.binaries.append((client, bytes(data)))

    def webSocketClose(self, client):
        self.closed.append(client)
        if client in self.webSocketConnections:
            self.webSocketConnections.remove(client)

    def messages(self, client, t=None):
        return [m for c, m in self.texts if c == client and (t is None or m["t"] == t)]


class FakeSurfaceTop:
    """doc/s<slot> Script TOP. cook(force) runs the extension's OnSurfaceCook, copyNumpyArray replaces the image.
    Like TD: locking resets the image to a blank 128x128, a locked TOP does not cook, unlocking recooks it from the
    callbacks (not from the stored image)."""

    def __init__(self, slot, ext_getter, path_prefix="/project1/raster_editor/doc"):
        self.name = f"s{slot}"
        self.path = f"{path_prefix}/{self.name}"
        self._ext = ext_getter
        self.cooks = 0
        self.uploads = []  # copies, in order
        self._image = None
        self._lock = False
        self.raise_on_cook = False
        self.raise_on_lock = False
        self.skip_copy = False   # a callback that silently fails to write

    @property
    def uploaded(self):
        return self._image

    @property
    def width(self):
        return 0 if self._image is None else self._image.shape[1]

    @property
    def height(self):
        return 0 if self._image is None else self._image.shape[0]

    @property
    def lock(self):
        return self._lock

    @lock.setter
    def lock(self, v):
        v = bool(v)
        if v == self._lock:
            return
        if v and self.raise_on_lock:
            raise RuntimeError("cannot lock")
        self._lock = v
        if v:
            self._image = np.zeros((128, 128, 4), np.uint8)  # locking resets the stored image
        else:
            self._ext().OnSurfaceCook(self)  # unlocking recooks from the callbacks

    def cook(self, force=False):
        if self._lock:
            return
        if self.raise_on_cook:
            raise RuntimeError("boom")
        self.cooks += 1
        self._ext().OnSurfaceCook(self)

    def copyNumpyArray(self, arr):
        if self.skip_copy:
            return
        self._image = arr.copy()
        self.uploads.append(self._image)


class FakeNetwork:
    """DocNetwork stand-in (DESIGN_V2 section 8): records calls, owns one FakeSurfaceTop per slot."""

    def __init__(self, ext_getter):
        self._ext = ext_getter
        self.applies = []  # (layers, w, h)
        self.tops = {}
        self.out = FakeInput()
        self.out.path = "/project1/raster_editor/doc/out"
        self.thaws = 0
        self.raise_on_apply = False
        self.raise_on_read = False
        self.created = 0
        self.ticks = 0
        self.input_flags = []
        self.input_calls = []
        self.render_sources = {}  # layer id -> TOP (FakeTop) returned by render_source
        self.render_calls = []
        self.open_calls = []      # v8: render_open(key, kind, layer_id, layer_ids, mode)
        self.req_layers = {}
        self.closed = []
        self.open_error = None
        self.token = 0          # bumped to simulate an apply() / layout refinement
        self.failed = set()     # layer ids whose effect chain / text failed
        self.not_ready = set()  # layer ids whose text measurement is still pending
        self.active_calls = []    # v7: set_active_layer(id)
        self.bounds_calls = []    # v7: set_content_bounds({id: box | None})
        self.preview_tops = {}    # v7: layer id -> FakeTop returned by layer_preview_source

    # v8 render requests: key -> the layer id (or "+"-joined ids) whose entry in ``render_sources`` is the result
    def render_open(self, key, kind, layer_id=None, layer_ids=None, mode="flatten"):
        self.open_calls.append((key, kind, layer_id, tuple(layer_ids or ()), mode))
        self.req_layers[key] = layer_id if kind == "layer" else "+".join(layer_ids)
        return self.open_error

    def render_close(self, key):
        self.closed.append(key)
        self.req_layers.pop(key, None)

    def render_token(self, key):
        lid = self.req_layers.get(key)
        return (self.token, id(self.render_sources.get(lid)))

    def render_status(self, key):
        lid = self.req_layers.get(key)
        return "failed" if lid in self.failed else "pending" if lid in self.not_ready else "ready"

    def render_ready(self, key):
        return self.render_status(key) == "ready"

    def render_source(self, key):
        lid = self.req_layers.get(key)
        self.render_calls.append(lid)
        if lid not in self.render_sources:
            raise KeyError(f"no layer {lid!r}")
        return self.render_sources[lid]

    def set_active_layer(self, layer_id):
        self.active_calls.append(layer_id)

    def set_content_bounds(self, bounds):
        self.bounds_calls.append(dict(bounds))

    def layer_preview_source(self, layer_id):
        return self.preview_tops.get(layer_id)

    def apply(self, layers, doc_w, doc_h):
        if self.raise_on_apply:
            raise RuntimeError("apply failed")
        replan = bool(self.applies) and self.applies[-1][0] is layers   # a re-plan of the same stack (hints changed) creates nothing
        self.applies.append((layers, doc_w, doc_h))
        if replan:
            return
        want = []
        for l in layers:
            m = l.get("mask")
            want += [s for s in (l.get("slot"), m and m.get("slot")) if s is not None]
        for s in want:
            if s not in self.tops:
                self.tops[s] = FakeSurfaceTop(s, self._ext)
                self.created += 1
        for s in [s for s in self.tops if s not in want]:
            del self.tops[s]  # grace period not modelled

    def surface_top(self, slot):
        return self.tops.get(slot)

    def slots(self):
        return sorted(self.tops)

    def output(self):
        return self.out

    @property
    def frozen(self):
        return any(t.lock for t in self.tops.values())

    def thaw(self):
        self.thaws += 1
        for t in self.tops.values():
            t.lock = False

    def rebind(self, ext_getter):
        """Another extension instance (a reloaded file) now owns the same Script TOPs."""
        self._ext = ext_getter
        for t in self.tops.values():
            t._ext = ext_getter

    def read_locked(self):
        """float32 (h, w, 4) TD-order pixels of every locked surface TOP."""
        if self.raise_on_read:
            raise RuntimeError("read failed")
        return {s: t.uploaded.astype(np.float32) / 255.0 for s, t in self.tops.items() if t.lock and t.uploaded is not None}

    def tick(self):
        self.ticks += 1

    def set_input_connected(self, flag):
        self.input_flags.append(bool(flag))

    def set_inputs(self, items):
        """v6 API: [{input, w, h, connected}] for every In TOP that exists."""
        self.input_calls.append([dict(i) for i in items])
        self.input_flags.append(any(i["input"] == 1 and i["connected"] for i in items))

    def stats(self):
        return {}


class FakeInput:
    """in1: scripted pixel source with TD's two-step delayed readback."""

    def __init__(self, n=1, owner=None):
        self.path = f"/project1/raster_editor/in{n}"
        self.name = f"in{n}"
        self.owner = owner
        self.par = Pars(connectorder=0)
        self.nodeX = self.nodeY = 0
        self.destroyed = False
        self.width = 64
        self.height = 32
        self.totalCooks = 0
        self.array = None  # float32 (h, w, 4) bottom-first
        self._requested = None
        self.readbacks = 0

    def cook(self, force=False):
        pass

    def destroy(self):
        self.destroyed = True
        if self.owner is not None:
            self.owner._remove_input(self)

    def set_image(self, arr):
        self.array = arr.astype(np.float32)
        self.height, self.width = arr.shape[:2]
        self.totalCooks += 1

    def numpyArray(self, delayed=False):
        self.readbacks += 1
        out = self._requested
        self._requested = self.array
        return out


class FakeWebRender:
    def __init__(self):
        self.par = Pars(active=1, url="", reloadsrc=None, transparent=0)
        self.totalCooks = 0
        self.forced = 0
        self.mouse = []
        self.keys = []

    def cook(self, force=False):
        self.totalCooks += 1
        self.forced += 1

    def interactMouse(self, u, v, **kw):
        self.mouse.append((u, v, kw))

    def sendKey(self, key, **kw):
        self.keys.append((key, kw))


class FakeConnector:
    def __init__(self):
        self.connected = None

    def connect(self, op):
        self.connected = op


class FakeSwitch:
    def __init__(self):
        self.par = Pars(index=0)
        self.inputConnectors = [FakeConnector(), FakeConnector()]


class FakeText:
    def __init__(self, text=""):
        self.text = text


class FakePanel:
    def __init__(self):
        self.u = Par("u", 0.0)
        self.v = Par("v", 0.0)
        self.lselect = Par("lselect", 0)
        self.mselect = Par("mselect", 0)
        self.rselect = Par("rselect", 0)
        self.wheel = Par("wheel", 0.0)


class FakeFontPar:
    def __init__(self, names, labels):
        self.menuNames, self.menuLabels = names, labels


class FakeFontProbe:
    """Hidden Text TOP whose `font` menu lists faces."""

    def __init__(self, names=("Arial", "Arial Bold", "Arial Bold Italic", "Helvetica", "Helvetica Neue Light", "Courier New"),
                 labels=None):
        self.par = types.SimpleNamespace(font=FakeFontPar(list(names), list(labels if labels is not None else names)))


class FakeTop:
    """A TOP somewhere in the project (listTops / importTop) with TD's two-step delayed readback."""

    def __init__(self, path, w, h, cooks=1, array=None, family="TOP"):
        self.path, self._w, self._h, self.totalCooks, self.family = path, w, h, cooks, family
        self.size_reads = 0  # reads of .width / .height: on a real TOP these can cook it
        self.array = array  # float32 (h, w, 4) bottom-first
        self.par = Pars(outputresolution="useinput", resolutionw=w, resolutionh=h)
        self.calls = 0
        self._requested = None

    @property
    def width(self):
        self.size_reads += 1
        return self._w

    @width.setter
    def width(self, v):
        self._w = v

    @property
    def height(self):
        self.size_reads += 1
        return self._h

    @height.setter
    def height(self, v):
        self._h = v

    def numpyArray(self, delayed=False):
        self.calls += 1
        out, self._requested = self._requested, self.array
        return out


class FakeInConn:
    def __init__(self, owner, n):
        self.owner, self.n = owner, n

    @property
    def connections(self):
        return [object()] if self.n in self.owner.connected else []


class FakeOwner:
    def __init__(self, **par_overrides):
        pars = dict(Active=1, Port=9980, Docw=64, Doch=32, Premultiplied=1, Maxsendfps=30, Maxinputfps=30,
                    Maxviewfps=30, Viewmode="local", Docsizemode="input", Exportpath="", Devurl="", Panelquery="", Status="", w=1280, h=800,
                    top="./webrender", Projectfile="", Pngfile="")
        pars.update(par_overrides)
        self.par = Pars(**pars)
        self.connected = set()  # connected input indices (1-based)
        self.panel = FakePanel()
        self.ext = None
        self.server = FakeServer()
        self.webrender = FakeWebRender()
        self.in_tops = {}
        self.in1 = self._add_input(1)
        self.created = []  # names of In TOPs created by the extension
        self.out1 = FakeInput(0)
        self.out1.path, self.out1.name = "/project1/raster_editor/out1", "out1"
        self.switch = FakeSwitch()
        self.ui = FakeText("<html>ui</html>")
        self.path = "/project1/raster_editor"
        self.name = "raster_editor"
        self.id = 1001
        self.tags = {"rasterEditor"}
        self.isCOMP = True
        self.net = FakeNetwork(lambda: self.ext)
        self.doc_state = FakeText("")
        self.saved = []  # (path, frozen, doc_state) per comp.save() call
        self.glsl = FakeText("// glsl")
        self.net_module = Module(types.SimpleNamespace(DocNetwork=self._make_net))
        self._ops = {
            "protocol": Module(protocol), "frames": Module(frames), "webserver": self.server,
            "webrender": self.webrender, "out_switch": self.switch, "out1": self.out1,
            "ui_html": self.ui, "network": self.net_module, "blend_glsl": self.glsl, "doc_state": self.doc_state,
            "font_probe": FakeFontProbe(),
        }
        self.storage = {}  # COMP storage (store / fetch / unstore)
        self.tops = {}  # path -> FakeTop (see ext._all_tops / _lookup_top seams in test_ext)

    def _make_net(self, comp, glsl, shape_glsl=None, **kw):
        self.net_kwargs = kw   # effects / effect_shaders handed to the DocNetwork
        return self.net

    def _add_input(self, n):
        t = self.in_tops[n] = FakeInput(n, self)
        return t

    def _remove_input(self, top):
        for n, t in list(self.in_tops.items()):
            if t is top:
                del self.in_tops[n]
                self.connected.discard(n)

    @property
    def inputs(self):
        return [object() for _ in sorted(self.connected)]

    @inputs.setter
    def inputs(self, v):  # compat: a truthy list means "input 1 connected"
        self.connected = {1} if v else set()

    @property
    def inputConnectors(self):
        return [FakeInConn(self, n) for n in range(1, max(self.in_tops, default=0) + 1)]

    def create(self, optype, name):
        assert optype == "inTOP", optype
        n = int(name[2:])
        self.created.append(name)
        return self._add_input(n)

    def store(self, key, value):
        self.storage[key] = value

    def fetch(self, key, default=None):
        return self.storage.get(key, default)

    def unstore(self, key):
        self.storage.pop(key, None)

    def save(self, path):
        self.saved.append((path, self.net.frozen, self.doc_state.text))

    def op(self, name):
        if name.startswith("in") and name[2:].isdigit():
            try:
                return self.in_tops[int(name[2:])]
            except KeyError:
                raise KeyError(name) from None
        return self._ops[name]


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class TickClock(Clock):
    """A clock that also advances ``tick`` seconds on every read, so code under a time budget
    sees time pass while it works (numpy on a tiny fake frame takes ~0 real time)."""

    def __init__(self, tick=0.001):
        super().__init__()
        self.tick = tick

    def __call__(self):
        self.t += self.tick
        return self.t
