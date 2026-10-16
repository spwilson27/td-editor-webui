"""Upgrade All Editors (docs/DESIGN_V8.md section 1).

``upgrade_all(source)`` replaces the code / UI / shaders / network scaffold / extension setup / custom parameter pages of every
raster editor in the project that is OLDER than ``source`` with those of ``source`` and keeps what makes the editor *that* editor.

PRESERVED (never rebuilt)
  * the document: the ``registry.DATA_CHILDREN`` children (``doc`` = generated network with the locked surface TOPs that hold
    the pixels, ``doc_state`` = stored document) and the COMP itself (storage: editorId, history, ...; position, size, tags,
    comment, parameters that survive)
  * USER children: only children that belong to the editor TEMPLATE are replaced -- the names of the source's template, the
    names of earlier builds (``KNOWN_TEMPLATE_NAMES``, ``fx_*``, ``view_pack*``) and the extension's temporary operators
    (``RUNTIME_RE``: ``_imp_*``, ``_font_probe_tmp``, ``_view_crop|rs|px<n>``). Any other child is kept and listed in the report
  * every surviving custom parameter is kept IN PLACE (value, expression, export, bind); definitions (label, range, menu, help,
    order) are refreshed, new ones are added with their defaults. Only parameters that belong to the template (names of the
    source, of earlier builds, or recorded by an earlier upgrade in the COMP storage) are ever removed; user pages and user
    parameters are never touched. A removed parameter that had an expression / export / bind is warned about
  * external wiring: the In / Out TOPs (``in<N>`` / ``out<N>``) stay the same operators, so the inputs from outside and the
    outputs to downstream operators keep their connections (re-checked, re-made if missing); the internal wires between the
    ports and the copied nodes are replayed from the source and verified
  * the viewer (``top`` / ``topfill``) when the user pointed it somewhere else than at a template operator
REPLACED: the template children, the COMP-level extension / parent-shortcut parameters (set LAST, right before the extension is
  re-initialised, so the new extension sees its parameters), the template parameter definitions; ``Version`` is stamped only after
  the new extension has started without error; the tag ``rasterEditor`` is added.

SKIPPED (listed in the report): editors newer than the source; editors with an External .tox or a Clone master set (the next load /
  cook would undo the upgrade). Dev-mode source DATs (file-synced) are copied as plain embedded text (sync off, file cleared).

TRANSACTIONAL per target: the old template children are backed up into a temporary COMP next to the target
(``_upg_bak_<name>``), the surfaces are frozen and the extension stopped (a failing Freeze aborts with nothing changed), then
swapped. After ``Start()`` the extension must be started with no ``last_error`` (the extension's own guard swallows exceptions),
otherwise everything is restored. The backup is destroyed after a success or a SUCCESSFUL rollback; when the rollback itself fails
it is kept and renamed ``_upg_bak_FAILED_<name>`` (its path is in the error).

MASTER HAND-OVER (contract with the extension): ``PrepareUpgrade()`` is called on the target before anything is changed. The old
extension instance is never detached (``ext0object`` is not cleared): the new one replaces it through ``initializeExtensions()``
so the old instance's ``onDestroyTD`` sees ``_superseded()`` and does not hand over. Execute DATs are copied only AFTER the new
extension exists (TD fires ``onCreate`` on a copy: ``parent().Start()`` then reaches the NEW extension). ``Start()`` of the new
extension resumes as master. After all targets the source's ``OnEditorsChanged()`` is called.

PACING: ``upgrade_all`` upgrades ONE editor per TD frame (``run(delayFrames=1)``) when running inside TD, and returns the report
at once with ``done: False`` and ``pending``; the same dict is completed in place and ``on_done(report)`` / the source extension's
``OnUpgradeDone(report)`` / ``ui.status`` are called when the last editor is through. ``pace=False`` runs everything at once.

Pure Python over the TD operator API, so it runs against fakes in the tests.
"""

import re

import registry

TEMPLATE_SKIP_TAG = "reRuntime"
PORT_TYPES = ("inTOP", "outTOP")
COMP_PAR_RE = re.compile(r"^(ext\d+(object|name|promote)|parentshortcut|top|topfill)$")
LATE_TYPES = ("executeDAT", "parameterexecuteDAT")     # copied after the new extension exists (onCreate -> parent().Start())
BAK_PREFIX = "_upg_bak_"
NEVER_PRESERVE = ("Status",)           # runtime text, rewritten by the extension
SYSTEM_ROOTS = ("ui", "sys", "local")  # never searched when no root is given
PAR_ATTRS = ("label", "menuNames", "menuLabels", "default", "min", "max", "clampMin", "clampMax", "normMin", "normMax",
             "help", "startSection", "readOnly")
SCALAR_STYLES = ("Int", "Float", "Str", "Toggle", "Menu", "StrMenu", "Pulse", "File", "Folder", "Momentary", "Header")
NO_VALUE_STYLES = ("Pulse", "Momentary", "Header")

# --- what belongs to the template of EARLIER builds (v0.1 - v0.7.3, from their build_component.py / extension) ---
KNOWN_TEMPLATE_NAMES = frozenset((
    "RasterEditorExt", "blend_glsl", "shape_glsl", "composite", "composite_callbacks", "doc_out", "effects", "font_probe",
    "frame_exec", "frames", "keyboard", "keyboard_callbacks", "network", "out_switch", "panel_exec", "panel_view", "par_exec",
    "protocol", "ui_html", "view_pack", "view_pack_glsl", "webrender", "webserver", "webserver_callbacks", "upgrade", "registry",
    "view_doc", "view_glsl", "doc_view",   # (v0.7.x TD-view overlay nodes DocNetwork.set_view created next to doc)
    "view_fast_glsl"))                     # (v0.9: the shader of the lazily created fast-view chains)
TEMPLATE_RE = re.compile(r"^(fx_\w+|view_pack_\w+)$")
RUNTIME_RE = re.compile(r"^_(imp_(sel|res|mov)\w*|font_probe_tmp|view_(crop|rs|px)\d+)$")        # the extension's temporary operators
KNOWN_PAR_NAMES = frozenset((
    "Active", "Devurl", "Doch", "Docsizemode", "Docw", "Exportdoc", "Exportpath", "Exportpng", "Maxinputfps", "Maxsendfps",
    "Maxviewfps", "Openbrowser", "Openproject", "Panelquery", "Pngfile", "Port", "Premultiplied", "Projectfile", "Reloadui",
    "Saveproject", "Savetox", "Status", "Viewmode", "Version", "Upgradeall"))
KNOWN_TEMPLATE_PAGES = frozenset(("Raster Editor",))
STORE_PARS = "reTemplatePars"      # COMP storage: the template parameters / pages of the build that was installed last
STORE_PAGES = "reTemplatePages"


class UpgradeError(Exception):
    pass


# --------------------------------------------------------------------------- versions / selection

def compare_versions(a, b):
    """-1 / 0 / 1; ``a`` and ``b`` are version strings ('0.8.0', '0.7.x' = legacy 0.7.0)."""
    ta, tb = registry.version_tuple(a), registry.version_tuple(b)
    n = max(len(ta), len(tb))
    ta, tb = ta + (0,) * (n - len(ta)), tb + (0,) * (n - len(tb))
    return (ta > tb) - (ta < tb)


def _alive(c):
    try:
        return c is not None and c.valid is not False
    except Exception:  # noqa: BLE001
        return False


def _truthy(v):
    return v not in (None, "", 0, False)


def find_editors(root=None):
    """The editors under ``root``; no root: the whole project, i.e. every top-level network except ``/ui``, ``/sys``, ``/local``."""
    if root is not None:
        return registry.find_editors(root)
    top = op("/")  # noqa: F821 - TD global
    out = []
    for c in list(top.children):
        if c.name in SYSTEM_ROOTS:
            continue
        if registry.is_editor(c):
            out.append(c)
        elif getattr(c, "isCOMP", False):
            out.extend(registry.find_editors(c))
    return sorted(out, key=lambda c: str(c.path))


def link_reason(comp):
    """Why an editor cannot be upgraded in place (its content comes from elsewhere), or ''."""
    for name, what in (("externaltox", "External .tox"), ("clone", "Clone master")):
        try:
            par = getattr(comp.par, name, None)
            if par is not None and _truthy(par.eval()):
                return f"{what} is set ({par.eval()})"
        except Exception:  # noqa: BLE001
            pass
    return ""


def classify(source, root=None):
    """Find the editors under ``root`` and split them against ``source``'s version: ``(older, newer, same)`` -- lists of COMPs
    (newer: (comp, version) pairs). The source itself and anything inside it are ignored."""
    sv = registry.editor_version(source)
    spath = str(source.path)
    older, newer, same = [], [], []
    for e in find_editors(root):
        p = str(e.path)
        if p == spath or p.startswith(spath + "/") or not _alive(e):
            continue
        ev = registry.editor_version(e)
        c = compare_versions(ev, sv)
        if c < 0:
            older.append(e)
        elif c > 0:
            newer.append((e, ev))
        else:
            same.append(e)
    return older, newer, same


# --------------------------------------------------------------------------- small TD helpers

def _ext(comp):
    try:
        return getattr(comp.ext, registry.EXT_NAME)
    except Exception:  # noqa: BLE001 - no extension initialised
        return None


def _is_port(c):
    return str(getattr(c, "OPType", "")) in PORT_TYPES


def _is_data(c):
    return c.name in registry.DATA_CHILDREN


def _is_late(c):
    return str(getattr(c, "OPType", "")) in LATE_TYPES


def _ports(comp):
    return [c for c in comp.children if _is_port(c)]


def source_template_kids(source):
    """The source's template children (what is copied)."""
    out = []
    for c in source.children:
        if _is_data(c) or _is_port(c):
            continue
        try:
            tags = set(c.tags)
        except Exception:  # noqa: BLE001
            tags = set()
        if c.name.startswith("_") or TEMPLATE_SKIP_TAG in tags:
            continue
        out.append(c)
    return out


def split_target_kids(target, template_names):
    """(replace, runtime, user): the target's template children (destroyed and re-copied), its temporary runtime operators
    (destroyed) and everything else (kept). Data children and In/Out TOPs belong to none of them."""
    replace, runtime, user = [], [], []
    for c in target.children:
        if _is_data(c) or _is_port(c):
            continue
        n = c.name
        if n in template_names or n in KNOWN_TEMPLATE_NAMES or TEMPLATE_RE.match(n):
            replace.append(c)
        elif RUNTIME_RE.match(n):
            runtime.append(c)
        else:
            user.append(c)
    return replace, runtime, user


def _mode(p):
    m = getattr(p, "mode", None)
    return str(getattr(m, "name", m)).split(".")[-1]


def _state(p):
    return {"mode": _mode(p), "val": p.val, "expr": getattr(p, "expr", ""), "bindExpr": getattr(p, "bindExpr", "")}


def _set_state(p, st):
    mode = st["mode"]
    try:
        if mode == "EXPRESSION":
            p.expr = st["expr"]
        elif mode == "BIND":
            p.bindExpr = st["bindExpr"]
        else:
            p.val = st["val"]
    except Exception:  # noqa: BLE001 - e.g. a menu entry that no longer exists: the default stays
        pass


def _set_val(p, v):
    """Set a value, also on a read-only parameter (scripts may; fall back to toggling the flag)."""
    try:
        p.val = v
    except Exception:  # noqa: BLE001
        ro = p.readOnly
        p.readOnly = False
        try:
            p.val = v
        finally:
            p.readOnly = ro


# --------------------------------------------------------------------------- custom parameter pages

def template_par_names(target, source_names):
    """Parameter names that belong to the template: this build's, earlier builds', and the ones recorded by an earlier upgrade."""
    try:
        rec = target.fetch(STORE_PARS, None)
    except Exception:  # noqa: BLE001
        rec = None
    return set(source_names) | set(KNOWN_PAR_NAMES) | set(rec or ())


def template_page_names(target, source_pages):
    try:
        rec = target.fetch(STORE_PAGES, None)
    except Exception:  # noqa: BLE001
        rec = None
    return set(source_pages) | set(KNOWN_TEMPLATE_PAGES) | set(rec or ())


def describe_pars(comp, pages=None, names=None):
    """[{page, name, style, attrs, state}] for the custom parameters (scalar styles) on ``pages`` whose name is in ``names``
    (None = all), in page / par order."""
    out = []
    for page in comp.customPages:
        if pages is not None and page.name not in pages:
            continue
        for p in page.pars:
            if names is not None and p.name not in names:
                continue
            style = str(p.style)
            if style not in SCALAR_STYLES:
                raise UpgradeError(f"unsupported custom parameter style {style} ({p.name})")
            attrs = {}
            for a in PAR_ATTRS:
                try:
                    v = getattr(p, a)
                except Exception:  # noqa: BLE001
                    continue
                if v is not None:
                    attrs[a] = list(v) if isinstance(v, (list, tuple)) else v
            out.append({"page": page.name, "name": p.name, "style": style, "attrs": attrs,
                        "state": None if style in NO_VALUE_STYLES else _state(p)})
    return out


def _apply_attrs(p, attrs):
    for a in PAR_ATTRS:
        if a == "readOnly" or a not in attrs:
            continue
        if a == "menuNames":
            try:
                p.menuNames = list(attrs[a])
            except Exception:  # noqa: BLE001
                pass
            continue
        try:
            setattr(p, a, attrs[a])
        except Exception:  # noqa: BLE001 - not applicable to this style
            pass


def _page(comp, name):
    for pg in comp.customPages:
        if pg.name == name:
            return pg
    return comp.appendCustomPage(name)


def _lost(p, why):
    m = _mode(p)
    if m in ("EXPRESSION", "EXPORT", "BIND"):
        return f"parameter {p.name} ({m.lower()}) was {why}"
    return None


def reconcile_pars(comp, desired, owned_pages, remove_names, values=None, exact_state=False):
    """Make the template parameters of ``comp`` match ``desired`` (a ``describe_pars`` list).

    A parameter that already exists with the same name, style and page stays the same object (value, expression, export, bind
    survive); its definition is refreshed. A missing one is created with its default (``values[name]`` overrides); one with a
    changed style / page is recreated with the old value / expression. A parameter on an owned page whose name is in
    ``remove_names`` and not in ``desired`` is destroyed (obsolete), and a page left empty is destroyed with it. Parameters that
    are not template parameters and every page that is not owned are not touched. ``exact_state``: also put every surviving
    parameter's value / expression back from ``desired`` (rollback). Returns warnings (lost expressions / exports)."""
    values = values or {}
    notes = []
    existing = {p.name: p for p in comp.customPars}
    names = {d["name"] for d in desired}
    dpages = {d["page"] for d in desired}
    for pg in list(comp.customPages):
        if pg.name not in owned_pages:
            continue
        for p in list(pg.pars):
            if p.name in remove_names and p.name not in names:
                w = _lost(p, "removed (no longer part of the editor)")
                if w:
                    notes.append(w)
                p.destroy()
        if pg.name not in dpages and not pg.pars:
            pg.destroy()
    order = {}
    for d in desired:
        name, style = d["name"], d["style"]
        cur = existing.get(name)
        old_state = None
        if cur is not None and not (str(cur.style) == style and cur.page.name == d["page"]):
            w = _lost(cur, "recreated (its type changed)")
            if w:
                notes.append(w)
            old_state = _state(cur) if str(cur.style) not in NO_VALUE_STYLES else None
            cur.destroy()
            cur = None
        created = cur is None
        if created:
            pg = _page(comp, d["page"])
            label = d["attrs"].get("label", name)
            made = getattr(pg, "append" + style)(name, label=label)
            cur = made[0] if isinstance(made, (list, tuple)) else made
        _apply_attrs(cur, d["attrs"])
        if style not in NO_VALUE_STYLES:
            if name in values:
                _set_val(cur, values[name])
            elif exact_state and d["state"] is not None:
                _set_state(cur, d["state"])
            elif created:
                if old_state is not None:
                    _set_state(cur, old_state)
                else:
                    _set_val(cur, d["attrs"].get("default", cur.default))
        if "readOnly" in d["attrs"] and bool(cur.readOnly) != bool(d["attrs"]["readOnly"]):
            cur.readOnly = bool(d["attrs"]["readOnly"])
        order.setdefault(d["page"], []).append(name)
    for pname, ns in order.items():
        try:
            _page(comp, pname).sort(*ns)
        except Exception:  # noqa: BLE001 - order is cosmetic
            pass
    return notes


# --------------------------------------------------------------------------- wiring

def _conn_list(connector):
    try:
        return list(connector.connections)
    except Exception:  # noqa: BLE001
        return []


def external_wiring(comp):
    """Wires on the COMP's own connectors: ({input index: [(upstream op, its output index)]}, {output index: [(downstream op, input index)]})."""
    ins, outs = {}, {}
    for i, k in enumerate(getattr(comp, "inputConnectors", None) or []):
        cs = [(c.owner, getattr(c, "index", 0)) for c in _conn_list(k)]
        if cs:
            ins[i] = cs
    for i, k in enumerate(getattr(comp, "outputConnectors", None) or []):
        cs = [(c.owner, c.index) for c in _conn_list(k)]
        if cs:
            outs[i] = cs
    return ins, outs


def restore_external_wiring(comp, wiring):
    """Reconnect whatever is missing (nothing is disconnected). Returns the number of wires re-made."""
    ins, outs = wiring
    n = 0
    conns_in = getattr(comp, "inputConnectors", None) or []
    for i, lst in ins.items():
        if i >= len(conns_in):
            continue
        have = {c.owner for c in _conn_list(conns_in[i])}
        for owner, oidx in lst:
            if owner not in have and _alive(owner):
                conns_in[i].connect(owner.outputConnectors[oidx])
                n += 1
    conns_out = getattr(comp, "outputConnectors", None) or []
    for i, lst in outs.items():
        if i >= len(conns_out):
            continue
        for target, idx in lst:
            if not _alive(target):
                continue
            if not any(c.owner is comp for c in _conn_list(target.inputConnectors[idx])):
                target.inputConnectors[idx].connect(conns_out[i])
                n += 1
    return n


def child_wiring(comp):
    """Internal wires of the editor's network by child name, as the inputs of each operator:
    {name: [(input idx, upstream name, upstream output idx)]}. The data children are left out (nothing is wired into ``doc``).
    TD's copyOPs re-slots the wires between copied operators (a gap in the connectors is closed up), so after copying the
    wires are replayed from the source with their real input indexes."""
    names = {c.name for c in comp.children if not _is_data(c)}
    out = {}
    for c in comp.children:
        if c.name not in names:
            continue
        ins = []
        for i, k in enumerate(c.inputConnectors):
            for u in _conn_list(k):
                if u.owner.name in names and u.owner is not c and u.owner.parent() is comp:
                    ins.append((i, u.owner.name, getattr(u, "index", 0)))
        out[c.name] = ins
    return out


def replay_wiring(comp, wiring, only):
    """Make the inputs of the operators named in ``only`` exactly as ``wiring`` says (names resolved in ``comp``): connectors the
    source does not wire are DISCONNECTED (copyOPs re-slots wires into the wrong connectors), the others connected. Verifies the
    result and raises ``UpgradeError`` on a mismatch."""
    for name in only:
        c = comp.op(name)
        if c is None:
            continue
        want = {}
        for i, up, oidx in wiring.get(name, ()):
            u = comp.op(up)
            if u is not None:
                want[i] = (u, oidx)
        for i, k in enumerate(c.inputConnectors):
            have = [(x.owner, getattr(x, "index", 0)) for x in _conn_list(k)]
            if i in want:
                if have != [want[i]]:
                    k.connect(want[i][0].outputConnectors[want[i][1]])
            elif have:
                k.disconnect()
    got = child_wiring(comp)
    for name in only:
        if comp.op(name) is None:
            continue
        exp = sorted((i, up, o) for i, up, o in wiring.get(name, ()) if comp.op(up) is not None)
        if sorted(got.get(name, ())) != exp:
            raise UpgradeError(f"wiring of {name} is {sorted(got.get(name, ()))}, expected {exp}")


# --------------------------------------------------------------------------- copy fix-ups

def _path_re(path):
    # a whole path only: not preceded by a path character (a longer path) and not followed by one (/p/raster_editor2)
    return re.compile(r"(?<![\w.\-/])" + re.escape(path) + r"(?![\w.\-])")


def _retarget(op_, source_path, target_path):
    """A copied operator's parameters may still name the source COMP (absolute paths: parameter-execute ``op``, keyboard ``panels``...)."""
    rx = _path_re(source_path)
    try:
        pars = list(op_.pars())
    except Exception:  # noqa: BLE001
        return
    for p in pars:
        try:
            m = _mode(p)
            if m == "EXPRESSION":
                e = p.expr
                if isinstance(e, str) and rx.search(e):
                    p.expr = rx.sub(lambda _m: target_path, e)
            elif m == "CONSTANT":
                v = p.val
                if isinstance(v, str) and rx.search(v):
                    p.val = rx.sub(lambda _m: target_path, v)
        except Exception:  # noqa: BLE001 - read-only / not a string parameter
            pass


def _sanitize_copy(c, source_path, target_path, notes):
    """Make a copy from the live source safe: never let a copied server grab the source's port or a panel load the source's URL,
    never keep a file-synced DAT (the copies are embedded)."""
    t = str(getattr(c, "OPType", ""))
    if t == "webserverDAT":
        c.par.active = 0
    elif t == "parameterexecuteDAT":
        c.par.active = 0       # re-enabled once the extension runs (its callbacks need it)
    elif t == "webrenderTOP":
        try:
            c.par.url = "about:blank"
        except Exception:  # noqa: BLE001
            pass
    try:
        sync = getattr(c.par, "syncfile", None)
        if sync is not None and _truthy(sync.eval()):
            sync.val = 0
            c.par.file = ""
            msg = "the source uses file-synced DATs (dev mode): the copies are embedded and no longer follow the files"
            if msg not in notes:
                notes.append(msg)
    except Exception:  # noqa: BLE001
        pass
    _retarget(c, source_path, target_path)


def _top_is_template(target, val, names):
    """Does the viewer parameter point at a template operator of ``target`` (or nowhere)?"""
    v = str(val or "").strip()
    if not v:
        return True
    prefix = str(target.path) + "/"
    if v.startswith(prefix):
        v = v[len(prefix):]
    elif v.startswith("./"):
        v = v[2:]
    elif v.startswith("/") or v.startswith("."):
        return False
    return v.split("/")[0] in names


# --------------------------------------------------------------------------- one target

def _quiesce(target):
    """Hook, freeze the surfaces, stop the old extension. A failing Freeze aborts (raises) with nothing changed."""
    ext = _ext(target)
    if ext is None:
        return
    hook = getattr(ext, "PrepareUpgrade", None)
    if callable(hook):
        hook()
    if hasattr(ext, "Freeze"):
        try:
            ext.Freeze()
        except Exception as e:  # noqa: BLE001
            raise UpgradeError(f"could not freeze the surfaces ({e}); the editor was left untouched") from e
    try:
        ext.Stop()
    except Exception as e:  # noqa: BLE001
        print("[upgrade] Stop failed:", e)


def _destroy_all(ops):
    for c in list(ops):
        try:
            if _alive(c):
                c.destroy()
        except Exception:  # noqa: BLE001 - gone with its parent / companion operator
            pass


def _start(comp):
    """Initialise the extension (the old instance is superseded, not detached) and start it. The extension's own guard swallows
    exceptions, so success means: started and no ``last_error``."""
    comp.initializeExtensions()
    ext = _ext(comp)
    if ext is None:
        raise UpgradeError("the extension did not initialise")
    return ext


def _check_started(comp):
    ext = _ext(comp)
    if ext is None:
        raise UpgradeError("the extension is gone after the start")
    if not getattr(ext, "_started", True):
        err = getattr(ext, "last_error", None)
        raise UpgradeError(f"the extension did not start ({err[0] if err else 'no error reported'})")
    err = getattr(ext, "last_error", None)
    if err:
        raise UpgradeError(f"the extension reported an error while starting: {err[0] if isinstance(err, (tuple, list)) else err}")


def _install(target, kids, source_path, target_path, notes):
    """Copy ``kids`` into ``target``; the Execute DATs only after the extension is initialised (``late``). Returns the pair
    (names copied now, the late kids to copy afterwards)."""
    early = [c for c in kids if not _is_late(c)]
    late = [c for c in kids if _is_late(c)]
    if early:
        for c in target.copyOPs(early):
            if source_path:
                _sanitize_copy(c, source_path, target_path, notes)
    return late


def _install_late(target, late, source_path, target_path, notes):
    if late:
        for c in target.copyOPs(late):
            if source_path:
                _sanitize_copy(c, source_path, target_path, notes)
            if c.name == "par_exec":
                c.par.active = 0


def upgrade_one(source, target):
    """Upgrade ``target`` to the build of ``source``; on any error restore it and raise. Returns {version, notes, kept}."""
    sv = registry.editor_version(source)
    spath, tpath = str(source.path), str(target.path)
    skids = source_template_kids(source)
    sdesc = describe_pars(source)
    sdesc_names = {d["name"] for d in sdesc}
    if not any(c.name == "RasterEditorExt" for c in skids):
        raise UpgradeError(f"{spath} has no RasterEditorExt: not a usable upgrade source")
    snames = {c.name for c in skids}
    pages = template_page_names(target, {d["page"] for d in sdesc})
    tnames = template_par_names(target, sdesc_names)
    # ---- preflight (no changes)
    for p in target.customPars:
        if p.name in sdesc_names and p.page.name not in pages:
            raise UpgradeError(f"parameter {p.name} exists on the user page {p.page.name}")
    replace, runtime, user = split_target_kids(target, snames)
    notes = []
    if user:
        notes.append("kept your own operators: " + ", ".join(sorted(c.name for c in user)))
    snap_pars = describe_pars(target, pages, tnames)
    snap_comp = {p.name: _state(p) for p in target.pars() if COMP_PAR_RE.match(p.name)}
    snap_tags = set(target.tags)
    snap_ext = external_wiring(target)
    snap_wires = child_wiring(target)
    snap_port_names = {c.name for c in _ports(target)}
    snap_store = {k: target.fetch(k, None) for k in (STORE_PARS, STORE_PAGES)}
    replaced_names = {c.name for c in replace}
    pe = target.op("par_exec")
    par_exec_was = pe.par.active.eval() if pe is not None else None
    top_is_template = _top_is_template(target, snap_comp.get("top", {}).get("val", ""), snames | replaced_names)

    _quiesce(target)
    bak = None
    keep_bak = False
    state = {"swapped": False}
    try:
        parent = target.parent()
        bak = parent.create("baseCOMP", _unique(parent, BAK_PREFIX + target.name))
        if replace:
            bak.copyOPs(replace)
        state["swapped"] = True
        _destroy_all(replace + runtime)
        late = _install(target, skids, spath, tpath, notes)
        for sp in _ports(source):                    # ports the source has and the target lacks
            if target.op(sp.name) is None:
                for c in target.copyOPs([sp]):
                    _sanitize_copy(c, spath, tpath, notes)
        only = (snames & {c.name for c in target.children}) | {c.name for c in _ports(target) if source.op(c.name) is not None}
        only -= {c.name for c in late}
        replay_wiring(target, child_wiring(source), only)
        notes += reconcile_pars(target, sdesc, pages, tnames - sdesc_names, values={"Version": ""} if "Version" in sdesc_names else None)
        # ---- the COMP-level extension setup LAST, so the new extension's __init__ sees its parameters
        for p in source.pars():
            if COMP_PAR_RE.match(p.name):
                if p.name in ("top", "topfill") and not top_is_template:
                    continue
                try:
                    _set_state(getattr(target.par, p.name), _state(p))
                except Exception:  # noqa: BLE001
                    pass
        _start(target)
        _install_late(target, late, spath, tpath, notes)
        ext = _ext(target)
        if not getattr(ext, "_started", False):
            target.Start()
        _check_started(target)
        pe = target.op("par_exec")
        if pe is not None:
            pe.par.active = 1 if par_exec_was is None else par_exec_was
        restore_external_wiring(target, snap_ext)
        for want in skids:
            if target.op(want.name) is None:
                raise UpgradeError(f"{want.name} is missing after the upgrade")
        # ---- success: stamp the version, remember the template
        if "Version" in sdesc_names:
            _set_val(target.par.Version, getattr(source.par, "Version").eval())
        got = registry.editor_version(target)
        if compare_versions(got, sv) != 0:
            raise UpgradeError(f"version is {got} after the upgrade, expected {sv}")
        target.tags = set(snap_tags | {registry.TAG})
        target.store(STORE_PARS, sorted(sdesc_names))
        target.store(STORE_PAGES, sorted({d["page"] for d in sdesc}))
    except Exception as e:  # noqa: BLE001
        try:
            _rollback(target, bak, replace, snames | replaced_names, snap_pars, pages, tnames, sdesc_names, snap_comp, snap_tags,
                      snap_ext, snap_wires, snap_port_names, snap_store, par_exec_was, state)
        except Exception as e2:  # noqa: BLE001
            keep_bak = True
            where = ""
            if bak is not None and _alive(bak):
                try:
                    bak.name = _unique(bak.parent(), f"{BAK_PREFIX}FAILED_{target.name}")
                except Exception:  # noqa: BLE001
                    pass
                where = f" Your original operators are in {bak.path}."
            raise UpgradeError(f"{e}; ROLLBACK FAILED, the editor may be damaged: {e2}.{where}") from e
        raise
    finally:
        if bak is not None and not keep_bak:
            _destroy_all([bak])
    return {"version": sv, "notes": notes, "kept": sorted(c.name for c in user)}


def _rollback(target, bak, replace, template_names, snap_pars, pages, tnames, sdesc_names, snap_comp, snap_tags, snap_ext,
              snap_wires, snap_port_names, snap_store, par_exec_was, state):
    notes = []
    if state["swapped"]:
        doomed = [target.op(n) for n in sorted(template_names)]
        doomed += [c for c in _ports(target) if c.name not in snap_port_names]
        _destroy_all([c for c in doomed if c is not None and not (_is_port(c) and c.name in snap_port_names)])
        kids = list(bak.children) if bak is not None else []
        late = _install(target, kids, "", "", notes)
    else:
        late = []
    for name, st in snap_comp.items():
        try:
            _set_state(getattr(target.par, name), st)
        except Exception:  # noqa: BLE001
            pass
    target.tags = set(snap_tags)
    snap_names = {d["name"] for d in snap_pars}
    reconcile_pars(target, snap_pars, pages, (tnames | sdesc_names) - snap_names, exact_state=True)
    for k, v in snap_store.items():
        if v is None:
            target.unstore(k)
        else:
            target.store(k, v)
    if state["swapped"]:
        only = {c.name for c in target.children if c.name in snap_wires}
        only -= {c.name for c in late}
        replay_wiring(target, snap_wires, only)
    _start(target)
    _install_late(target, late, "", "", notes)
    ext = _ext(target)
    if not getattr(ext, "_started", False):
        target.Start()
    _check_started(target)
    pe = target.op("par_exec")
    if pe is not None and par_exec_was is not None:
        pe.par.active = par_exec_was
    restore_external_wiring(target, snap_ext)


def _unique(parent, base):
    name, n = base, 1
    while parent.op(name) is not None:
        n += 1
        name = f"{base}{n}"
    return name


# --------------------------------------------------------------------------- entry point

def _scheduler():
    """TD's ``run(callable, arg, delayFrames=1)``, or None outside TD."""
    try:
        import td
        return td.run
    except Exception:  # noqa: BLE001
        return None


def _summary(report):
    parts = []
    if report["skipped_newer"]:
        parts.append("newer editors were not changed: " + ", ".join(f"{p} ({v})" for p, v in report["skipped_newer"]))
    if report["skipped_linked"]:
        parts.append("not upgraded (content comes from elsewhere): " + ", ".join(f"{p}: {w}" for p, w in report["skipped_linked"]))
    if report["failed"]:
        parts.append("upgrade failed: " + "; ".join(f"{p}: {e}" for p, e in report["failed"]))
    if report["notes"]:
        parts.append("; ".join(f"{p}: {n}" for p, n in report["notes"]))
    return "Upgrade All Editors: " + " | ".join(parts) if parts else ""


def _finish(source, report, on_done):
    report["warning"] = _summary(report)
    report["done"] = True
    report["pending"] = []
    sv = report["version"]
    msg = report["warning"] or (f"Upgrade All Editors: {len(report['upgraded'])} upgraded to {sv}"
                                if report["upgraded"] else f"Upgrade All Editors: nothing to upgrade (v{sv})")
    report["message"] = msg
    ext = _ext(source) if _alive(source) else None
    for hook, arg in (("OnEditorsChanged", None), ("OnUpgradeDone", report)):
        fn = getattr(ext, hook, None) if ext is not None else None
        if callable(fn):
            try:
                fn() if arg is None else fn(arg)
            except Exception as e:  # noqa: BLE001
                print(f"[upgrade] {hook}:", e)
    print("[raster_editor]", msg)
    try:
        ui.status = msg  # noqa: F821 - TD global
    except Exception:  # noqa: BLE001
        pass
    if on_done is not None:
        try:
            on_done(report)
        except Exception as e:  # noqa: BLE001
            print("[upgrade] on_done:", e)


def upgrade_all(source, root=None, on_done=None, pace=None):
    """Upgrade every older editor under ``root`` (default: the whole project) to ``source``'s build.

    Returns {source, version, upgraded: [path], skipped_newer: [[path, version]], skipped_linked: [[path, why]],
    failed: [[path, error]], same: [path], notes: [[path, text]], pending: [path], done: bool, warning: str}.
    Inside TD one editor is upgraded per frame (``pace`` None/True) and the dict is completed in place; ``on_done(report)`` and the
    source extension's ``OnUpgradeDone`` run at the end. ``pace=False`` (tests): everything now, the returned report is final."""
    sv = registry.editor_version(source)
    report = {"source": str(source.path), "version": sv, "upgraded": [], "skipped_newer": [], "skipped_linked": [],
              "failed": [], "same": [], "notes": [], "pending": [], "done": False, "warning": ""}
    older, newer, same = classify(source, root)
    report["same"] = [str(c.path) for c in same]
    report["skipped_newer"] = [[str(c.path), v] for c, v in newer]
    todo = []
    for t in older:
        why = link_reason(t)
        if why:
            report["skipped_linked"].append([str(t.path), why])
        else:
            todo.append(t)
    report["pending"] = [str(t.path) for t in todo]
    run_later = _scheduler() if pace is None or pace is True else None
    paths = {str(t.path): t for t in todo}

    def one(t):
        p = str(t.path)
        try:
            if not _alive(t) or not _alive(source):
                raise UpgradeError("the editor or the source was deleted meanwhile")
            res = upgrade_one(source, t)
            report["upgraded"].append(p)
            report["notes"] += [[p, n] for n in res["notes"]]
        except Exception as e:  # noqa: BLE001 - one bad editor must not stop the others
            report["failed"].append([p, f"{type(e).__name__}: {e}"])
        if p in report["pending"]:
            report["pending"].remove(p)

    if run_later is None:
        for t in todo:
            one(t)
        _finish(source, report, on_done)
        return report

    queue = list(paths.values())

    def step(*_):
        if queue:
            one(queue.pop(0))
        if queue:
            run_later(step, delayFrames=1)
        else:
            _finish(source, report, on_done)

    if queue:
        run_later(step, delayFrames=1)
    else:
        _finish(source, report, on_done)
    return report
