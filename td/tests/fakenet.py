"""Fake TouchDesigner operator tree for exercising network.DocNetwork without TD.

Only the surface DocNetwork uses is modelled: ``create / op / children / destroy``, parameters (every
assignment is logged), input connectors, ``bypass``, ``nodeX/nodeY``, ``tags``, ``comment``, ``lock``,
``numpyArray``.  Like TD, creating a glslTOP / scriptTOP also creates companion DATs (``g1_info``,
``s3_callbacks`` ...) and every create / destroy / par set is counted in ``Log``.
"""

import numpy as np

COMPANIONS = {
    "glslTOP": ("_info", "_pixel", "_compute"),
    "scriptTOP": ("_callbacks",),
}


class Log:
    def __init__(self):
        self.creates = []       # (type, name)
        self.destroys = []      # names
        self.par_sets = []      # (opname, parname, value)
        self.connects = []      # (opname, index, source name)
        self.disconnects = []   # (opname, index)
        self.renames = []

    def mark(self):
        return (len(self.creates), len(self.destroys), len(self.par_sets), len(self.connects), len(self.disconnects))

    def since(self, mark):
        return {
            "creates": self.creates[mark[0]:], "destroys": self.destroys[mark[1]:],
            "par_sets": self.par_sets[mark[2]:], "connects": self.connects[mark[3]:],
            "disconnects": self.disconnects[mark[4]:],
        }

    def clear(self):
        self.__init__()


class FakePars:
    def __init__(self, op):
        object.__setattr__(self, "_op", op)
        object.__setattr__(self, "_v", {})

    def __setattr__(self, name, value):
        self._v[name] = value
        self._op._log.par_sets.append((self._op.name, name, value))

    def __getattr__(self, name):
        v = object.__getattribute__(self, "_v")
        if name in v:
            return _Val(v[name])
        raise AttributeError(name)

    def value(self, name):
        return self._v.get(name)


class _Val:
    def __init__(self, v):
        self.v = v

    def eval(self):
        return self.v


class FakeConnector:
    def __init__(self, op, index):
        self.op, self.index = op, index
        self.source = None

    def connect(self, other):
        self.source = other
        self.op._log.connects.append((self.op.name, self.index, other.name))
        op = self.op       # TD keeps one free connector after the last used one (glsl TOPs: any number)
        while op.OPType in ("glslTOP", "overTOP") and op.inputConnectors[-1].source is not None:
            op.inputConnectors.append(FakeConnector(op, len(op.inputConnectors)))

    def disconnect(self):
        self.source = None
        self.op._log.disconnects.append((self.op.name, self.index))

    @property
    def connections(self):
        return [self.source] if self.source is not None else []


class FakeOp:
    def __init__(self, parent, optype, name, log):
        self.parent_op = parent
        self.OPType = optype
        self._name = name
        self._log = log
        self.par = FakePars(self)
        self.valid = True
        self.bypass = False
        self.nodeX = self.nodeY = 0
        self.tags = []
        self.comment = ""
        self.lock = False
        self.text = ""
        self.children_list = []
        self.inputConnectors = [FakeConnector(self, 0)]
        self.pixels = None
        self.cooks = 0

    # -- identity
    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, v):
        self._log.renames.append((self._name, v))
        self._name = v

    @property
    def path(self):
        base = self.parent_op.path if self.parent_op is not None else ""
        return base + "/" + self._name

    @property
    def isTOP(self):
        return self.OPType.endswith("TOP")

    # -- tree
    @property
    def children(self):
        return [c for c in self.children_list if c.valid]

    def op(self, name):
        for c in self.children_list:
            if c.valid and c._name == name:
                return c
        return None

    def create(self, optype, name):
        if self.op(name) is not None:      # like TD: a duplicate name gets a numeric suffix
            base, i = name, 1
            while self.op(name) is not None:
                name = "%s%d" % (base, i)
                i += 1
        c = FakeOp(self, optype, name, self._log)
        self.children_list.append(c)
        self._log.creates.append((optype, name))
        if optype == "glslTOP" or optype == "scriptTOP":
            for suf in COMPANIONS[optype]:
                comp = FakeOp(self, "textDAT", name + suf, self._log)
                self.children_list.append(comp)
                self._log.creates.append(("textDAT", name + suf))
        if optype in ("glslTOP", "levelTOP", "blurTOP", "thresholdTOP", "hsvadjustTOP", "overTOP", "nullTOP"):
            c.inputConnectors = [FakeConnector(c, 0)]
        return c

    def destroy(self):
        assert self.valid, "destroy of an invalid op " + self._name
        self.valid = False
        self._log.destroys.append(self._name)
        # downstream connectors that pointed here are cut, like TD
        root = self.parent_op
        if root is not None:
            for c in root.children_list:
                for con in c.inputConnectors:
                    if con.source is self:
                        con.source = None

    # -- TOP api
    def numpyArray(self):
        return self.pixels

    def cook(self, force=False):
        self.cooks += 1


def make_comp(log=None, with_input=True, webrender=True):
    """A fake raster_editor COMP with an In TOP (``in1``) and optionally a ``webrender`` TOP."""
    log = log or Log()
    comp = FakeCompOp(None, "baseCOMP", "raster_editor", log)
    comp.in1 = comp.create("inTOP", "in1")
    if webrender:
        comp.create("webrenderTOP", "webrender")
    log.clear()
    return comp, log


class FakeCompOp(FakeOp):
    def __init__(self, parent, optype, name, log):
        super().__init__(parent, optype, name, log)
        self.inputConnectors = [FakeConnector(self, 0)]
        self.surface_cooks = []

    @property
    def path(self):
        return "/" + self._name

    def OnSurfaceCook(self, top):
        # like the real ext: record the lock state at the time of the call
        self.surface_cooks.append((top.name, bool(top.lock)))
        top.pixels = np.full((4, 4, 4), len(self.surface_cooks), np.float32)

    def create(self, optype, name):
        c = super().create(optype, name)
        if optype == "baseCOMP":
            c.__class__ = FakeCompOp
            c.surface_cooks = []
        return c


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t
