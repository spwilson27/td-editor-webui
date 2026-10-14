"""Minimal fake TouchDesigner objects for exercising RasterEditorExt without TD."""

import json

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


class FakeComposite:
    def __init__(self, ext_getter):
        self._ext = ext_getter
        self.cooks = 0
        self.uploaded = None
        self.raise_on_cook = False

    def cook(self, force=False):
        if self.raise_on_cook:
            raise RuntimeError("boom")
        self.cooks += 1
        self._ext().OnCompositeCook(self)

    def copyNumpyArray(self, arr):
        self.uploaded = arr.copy()


class FakeInput:
    """in1: scripted pixel source with TD's two-step delayed readback."""

    def __init__(self):
        self.width = 64
        self.height = 32
        self.totalCooks = 0
        self.array = None  # float32 (h, w, 4) bottom-first
        self._requested = None
        self.readbacks = 0

    def cook(self, force=False):
        pass

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
        self.par = Pars(active=1, url="", reloadsrc=None)
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


class FakeSwitch:
    def __init__(self):
        self.par = Pars(index=0)


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


class FakeOwner:
    def __init__(self, **par_overrides):
        pars = dict(Active=1, Port=9980, Docw=64, Doch=32, Premultiplied=1, Maxsendfps=30, Maxinputfps=30,
                    Devurl="", Panelquery="", Status="")
        pars.update(par_overrides)
        self.par = Pars(**pars)
        self.inputs = []
        self.panel = FakePanel()
        self.ext = None
        self.server = FakeServer()
        self.webrender = FakeWebRender()
        self.in1 = FakeInput()
        self.switch = FakeSwitch()
        self.ui = FakeText("<html>ui</html>")
        self.composite = FakeComposite(lambda: self.ext)
        self._ops = {
            "protocol": Module(protocol), "frames": Module(frames), "webserver": self.server,
            "webrender": self.webrender, "in1": self.in1, "out_switch": self.switch,
            "ui_html": self.ui, "composite": self.composite,
        }

    def op(self, name):
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
