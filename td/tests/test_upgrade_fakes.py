"""A small fake TouchDesigner operator tree (COMPs, DATs, TOPs, connectors, custom pages, extensions, storage, copyOPs)
for exercising upgrade.py without TD."""

import copy

import registry


class FPar:
    def __init__(self, owner, name, style="Str", val=None, page=None):
        self.owner, self.name, self.style, self.page = owner, name, style, page
        self.val = val
        self.expr = ""
        self.bindExpr = ""
        self.mode = "CONSTANT"
        self.label = name
        self.default = val
        self.min = self.max = 0
        self.clampMin = self.clampMax = False
        self.normMin = self.normMax = 0
        self.menuNames, self.menuLabels = [], []
        self.help = ""
        self.startSection = False
        self.readOnly = False
        self.custom = False
        self.pulses = 0

    def eval(self):
        return self.val

    def pulse(self):
        self.pulses += 1

    def destroy(self):
        self.owner._pars.pop(self.name)
        if self.page is not None:
            self.page._names.remove(self.name)

    def __setattr__(self, k, v):
        if k == "val" and getattr(self, "readOnly", False) and getattr(self, "_strict_ro", False):
            raise RuntimeError("read only")
        object.__setattr__(self, k, v)


class FPage:
    def __init__(self, comp, name):
        self.comp, self.name, self._names = comp, name, []

    @property
    def pars(self):
        return tuple(self.comp._pars[n] for n in self._names)

    def destroy(self):
        for n in list(self._names):
            self.comp._pars.pop(n)
        self.comp._pages.remove(self)

    def sort(self, *names):
        rest = [n for n in self._names if n not in names]
        self._names = [n for n in names if n in self._names] + rest

    def _append(self, style, name, label=None):
        p = FPar(self.comp, name, style, page=self)
        p.custom = True
        p.label = label or name
        if style in ("Int", "Float"):
            p.val = p.default = 0
        elif style == "Toggle":
            p.val = p.default = False
        else:
            p.val = p.default = ""
        self.comp._pars[name] = p
        self._names.append(name)
        return (p,)

    def __getattr__(self, n):
        if n.startswith("append"):
            return lambda name, label=None: self._append(n[6:], name, label)
        raise AttributeError(n)


class FConn:
    def __init__(self, owner, index, is_input):
        self.owner, self.index, self.is_input = owner, index, is_input
        self.connections = []

    def connect(self, other):
        if isinstance(other, _OutWire):
            _connect_down(self.owner, self.index, other.comp)
            return
        if not isinstance(other, FConn):
            other = other.outputConnectors[0]
        assert self.is_input and not other.is_input
        for c in list(self.connections):
            self.disconnect_from(c)
        self.connections.append(other)
        other.connections.append(self)

    def disconnect_from(self, c):
        self.connections.remove(c)
        c.connections.remove(self)

    def disconnect(self):
        self.drop_all()

    def drop_all(self):
        for c in list(self.connections):
            self.disconnect_from(c)


class FExtNS:
    pass


class FakeExt:
    """Stands in for RasterEditorExt: records the lifecycle calls."""
    fail_freeze = False
    fail_start_on = None   # callable(comp) -> bool: raise in Start

    swallow = False        # model the extension's _guard: Start() records last_error instead of raising

    def __init__(self, comp):
        self.o = comp
        self.calls = []
        self._started = False
        self.last_error = None

    def Freeze(self):
        self.calls.append("Freeze")
        if FakeExt.fail_freeze:
            raise RuntimeError("freeze boom")

    def Stop(self):
        self.calls.append("Stop")

    def Start(self):
        self.calls.append("Start")
        if FakeExt.fail_start_on and FakeExt.fail_start_on(self.o):
            if FakeExt.swallow:
                self.last_error = ("Start: RuntimeError: start boom", 0.0)
                return
            raise RuntimeError("start boom")
        self._started = True

    def PrepareUpgrade(self):
        self.calls.append("PrepareUpgrade")


class FOp:
    _ids = 0

    def __init__(self, parent, name, optype, text=""):
        FOp._ids += 1
        self.id = FOp._ids
        self.parent_ = parent
        self.name = name
        self.OPType = optype
        self.isCOMP = optype.endswith("COMP")
        self.valid = True
        self.text = text
        self._pars = {}
        self._pages = []
        self._children = []
        self._store = {}
        self.tags = set()
        self.nodeX = self.nodeY = 0
        self._ni = 4
        self.inputConnectors = [FConn(self, i, True) for i in range(self._ni)]
        self.outputConnectors = [FConn(self, 0, False)]
        self.ext = FExtNS()
        self._comp_in = {}    # COMP only: wires kept per index (live while an inTOP with that connector order exists)
        self._comp_out = None
        if parent is not None:
            parent._children.append(self)
        if self.isCOMP:
            for n in ("ext0object", "ext0name", "ext0promote", "parentshortcut", "top", "topfill"):
                self._pars[n] = FPar(self, n, "Str", "")
        if optype == "webserverDAT":
            self.par.active = 0
            self.par.port = 9980
        if optype == "parameterexecuteDAT":
            self.par.active = 1
            self.par.op = ""

    # -- tree
    @property
    def path(self):
        return "/" if self.parent_ is None else (self.parent_.path.rstrip("/") + "/" + self.name)

    def parent(self):
        return self.parent_

    @property
    def children(self):
        return list(self._children)

    def op(self, name):
        if name.startswith("/"):
            node = self.root()
            for part in [p for p in name.split("/") if p]:
                node = node.op(part)
                if node is None:
                    return None
            return node
        for c in self._children:
            if c.name == name:
                return c
        return None

    def root(self):
        n = self
        while n.parent_ is not None:
            n = n.parent_
        return n

    def create(self, optype, name):
        if isinstance(optype, type):
            optype = optype.__name__
        assert self.op(name) is None, f"{name} exists"
        return FOp(self, name, optype)

    def destroy(self):
        if self.parent_ is None:
            raise RuntimeError("cannot destroy root")
        for c in list(self._children):
            c.destroy()
        for k in self.__dict__["inputConnectors"]:
            k.drop_all()
        for k in self.__dict__["outputConnectors"]:
            k.drop_all()
        self.parent_._children.remove(self)
        self.valid = False
        if self.OPType == "inTOP" and self.parent_.isCOMP:   # TD: the wire goes with the connector
            self.parent_._comp_in.pop(int(self.par.connectorder.val or 1) - 1, None)
        if self.OPType == "outTOP" and self.parent_.isCOMP:
            self.parent_.__dict__["_down"] = []

    def copyOPs(self, ops):
        copies = {}
        for o in ops:
            copies[id(o)] = self._copy_one(o)
        for o in ops:  # internal wiring between the copied operators: like TD, the wires are re-slotted (gaps closed up)
            slot = 0
            for i, k in enumerate(o.inputConnectors):
                for c in k.connections:
                    if id(c.owner) in copies:
                        copies[id(o)].inputConnectors[slot].connect(copies[id(c.owner)].outputConnectors[0])
                        slot += 1
        return [copies[id(o)] for o in ops]

    def _copy_one(self, o):
        if self.op(o.name) is not None:
            raise RuntimeError(f"name clash {o.name}")
        n = FOp(self, o.name, o.OPType, o.text)
        n.nodeX, n.nodeY = o.nodeX, o.nodeY
        n.tags = set(o.tags)
        n._pars = {}
        for k, p in o._pars.items():
            q = copy.copy(p)
            q.owner = n
            q.page = None
            n._pars[k] = q
        for c in o._children:
            n._copy_one_into(c)
        return n

    def _copy_one_into(self, c):
        n = self._copy_one(c)
        return n

    # -- pars
    @property
    def par(self):
        return _ParNS(self)

    def pars(self, *a):
        return list(self._pars.values())

    @property
    def customPars(self):
        return [p for p in self._pars.values() if p.custom]

    @property
    def customPages(self):
        return list(self._pages)

    def appendCustomPage(self, name):
        pg = FPage(self, name)
        self._pages.append(pg)
        return pg

    # -- storage
    def store(self, k, v):
        self._store[k] = v

    def fetch(self, k, default=None):
        return self._store.get(k, default)

    def unstore(self, k):
        self._store.pop(k, None)

    # -- COMP connectors: backed by the In/Out TOPs inside
    def _port(self, kind, n):
        for c in self._children:
            if c.OPType == kind and (kind == "outTOP" or int(c.par.connectorder.val or 1) == n):
                return c
        return None

    def __getattribute__(self, name):
        if name == "inputConnectors" and object.__getattribute__(self, "isCOMP"):
            return _CompInputs(self)
        if name == "outputConnectors" and object.__getattribute__(self, "isCOMP"):
            return _CompOutputs(self)
        return object.__getattribute__(self, name)

    def initializeExtensions(self):
        self.ext = FExtNS()
        spec = self._pars["ext0object"].val
        if spec:
            dat = self.op("RasterEditorExt")
            if dat is None:
                raise RuntimeError("no extension DAT")
            setattr(self.ext, "RasterEditorExt", FakeExt(self))

    def __getattr__(self, name):   # promoted extension methods
        if name in ("Start", "Stop", "Freeze") and "ext" in self.__dict__:
            e = getattr(self.ext, "RasterEditorExt", None)
            if e is not None:
                return getattr(e, name)
        raise AttributeError(name)


class _ParNS:
    def __init__(self, o):
        object.__setattr__(self, "_o", o)

    def __getattr__(self, name):
        o = object.__getattribute__(self, "_o")
        if name not in o._pars:
            if o.isCOMP and name[0].isupper():
                raise AttributeError(name)
            o._pars[name] = FPar(o, name, "Str", 0)
        return o._pars[name]

    def __setattr__(self, name, v):
        getattr(self, name).val = v


class _CompInputs(list):
    """COMP input connectors: wires live in the COMP, only while an In TOP with that connector order exists."""

    def __init__(self, comp):
        super().__init__([_Wire(comp, i) for i in range(8)])


class _Wire:
    def __init__(self, comp, i):
        self.comp, self.i = comp, i
        self.owner, self.index = comp, i

    @property
    def connections(self):
        if self.comp._port("inTOP", self.i + 1) is None:
            return []
        return list(self.comp._comp_in.get(self.i, []))

    def connect(self, other):
        if not isinstance(other, FConn):
            other = other.outputConnectors[0]
        assert self.comp._port("inTOP", self.i + 1) is not None
        self.comp._comp_in[self.i] = [other]


class _CompOutputs(list):
    def __init__(self, comp):
        super().__init__([_OutWire(comp)])


class _OutWire:
    def __init__(self, comp):
        self.comp = comp

    @property
    def connections(self):
        if self.comp._port("outTOP", 0) is None:
            return []
        return list(self.comp._comp_out_list())


def _comp_out_list(self):
    return [c for c in getattr(self, "_down", [])]


FOp._comp_out_list = _comp_out_list


def _connect_down(consumer, idx, comp):
    """consumer.inputConnectors[idx] <- comp output (recorded on both sides)."""
    consumer.inputConnectors[idx].drop_all()
    consumer.inputConnectors[idx].connections.append(_Down(comp))
    comp.__dict__.setdefault("_down", []).append(consumer.inputConnectors[idx])


class _Down:
    def __init__(self, comp):
        self.owner, self.index = comp, 0


# --------------------------------------------------------------------------- builders

HELPERS_NOTE = "build_editor() creates a v0.7-like editor COMP"


def build_editor(parent, name="raster_editor", version=None, extra_pars=(), code="# code", legacy=False,
                 shader="// shader", drop=(), extra_kids=()):
    """An editor COMP with the typical children: data (doc/doc_state), ports (in1/out1), template nodes, ext, custom page."""
    c = parent.create("containerCOMP", name)
    c.par.ext0object = "op('./RasterEditorExt').module.RasterEditorExt(me)"
    c.par.ext0name = "RasterEditorExt"
    c.par.ext0promote = 1
    c.par.parentshortcut = "RasterEditor"
    c.par.top = "./webrender"
    doc = c.create("containerCOMP", "doc")
    doc.create("scriptTOP", "s1")
    c.create("textDAT", "doc_state").text = '{"layers":[]}'
    i1 = c.create("inTOP", "in1")
    i1.par.connectorder = 1
    o1 = c.create("outTOP", "out1")
    sw = c.create("switchTOP", "out_switch")
    sw.inputConnectors[0].connect(i1)
    sw.inputConnectors[1].connect(c.create("selectTOP", "doc_out"))
    o1.inputConnectors[0].connect(sw)
    for n in ("protocol", "network", "ui_html"):
        c.create("textDAT", n).text = f"{n} {code}"
    c.create("textDAT", "blend_glsl").text = shader
    c.create("textDAT", "RasterEditorExt").text = f"ext {code}"
    c.create("webserverDAT", "webserver")
    c.create("webrenderTOP", "webrender").par.url = "http://x"
    c.create("keyboardinDAT", "keyboard").par.panels = c.path
    pe = c.create("parameterexecuteDAT", "par_exec")
    pe.par.op = c.path
    for n in drop:
        c.op(n).destroy()
    for n, t in extra_kids:
        c.create(t, n)
    pg = c.appendCustomPage("Raster Editor")
    pg.appendToggle("Active", label="Active")[0].default = True
    c.par.Active = True
    p = pg.appendInt("Port", label="Port")[0]
    p.default = 9980
    c.par.Port = 9980
    pg.appendStr("Status", label="Status")
    c.par.Status.readOnly = True
    for n in extra_pars:
        pg.appendInt(n)
    pg.appendPulse("Openbrowser", label="Open in Browser")
    if version is not None:
        pg.appendStr("Version", label="Version")
        c.par.Version.val = c.par.Version.default = version
        c.par.Version.readOnly = True
        c.tags.add(registry.TAG)
    c.initializeExtensions()
    return c


def wire_outside(editor, parent):
    """An upstream TOP into in1 and a downstream null from out1."""
    up = parent.create("noiseTOP", f"{editor.name}_up")
    editor.inputConnectors[0].connect(up)
    down = parent.create("nullTOP", f"{editor.name}_down")
    _connect_down(down, 0, editor)
    return up, down
