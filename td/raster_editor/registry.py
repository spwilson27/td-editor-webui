"""Editor registry (docs/DESIGN_V8.md section 2): find the raster editors of a project.

Pure helpers over TD operator objects (no TD import): ``op`` is only used as the default root. Used by the
extension (master router, tabs list, failover) and by ``upgrade.py`` (Upgrade All Editors).

An editor is a COMP with the tag ``rasterEditor`` (v8) or, for older builds (v0.x), the signature: a COMP whose
extension is ``RasterEditorExt`` / that has the ``doc_state`` DAT and a ``webserver`` DAT.
"""

import re

TAG = "rasterEditor"
EXT_NAME = "RasterEditorExt"
# Children holding document data: they must survive an upgrade (rebuild in place). ``doc`` is the generated surface
# network (its locked surface TOPs hold the pixels), ``doc_state`` the stored document (layers, guides, ...).
DATA_CHILDREN = ("doc", "doc_state")
LEGACY_VERSION = "0.7.x"
UNKNOWN_VERSION = "unknown"  # a v8-tagged editor whose Version is empty / unparsable: upgrade skips it with a warning
EXCLUDED_ROOTS = ("ui", "sys", "local")
VERSION_RE = re.compile(r"^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?$")


def _tags(comp):
    try:
        return set(comp.tags)
    except Exception:  # noqa: BLE001
        return set()


def _child(comp, name):
    try:
        return comp.op(name)
    except Exception:  # noqa: BLE001
        return None


def is_legacy(comp):
    """The v0.x signature: no tag, but the raster editor extension (or its documents DATs + web server)."""
    try:
        if getattr(comp, "isCOMP", True) is False:
            return False
        par = getattr(comp.par, "ext0name", None)
        if par is not None and str(par.eval() or "") == EXT_NAME:
            return True
    except Exception:  # noqa: BLE001
        pass
    return _child(comp, "doc_state") is not None and _child(comp, "webserver") is not None and \
        _child(comp, "doc") is not None


def is_editor(comp):
    if comp is None:
        return False
    if TAG in _tags(comp):
        return True
    return is_legacy(comp)


def _walk(root, out, depth=0, legacy=True):
    try:
        kids = list(root.children)
    except Exception:  # noqa: BLE001
        return
    for c in kids:
        if _excluded(c):
            continue
        if is_editor(c) if legacy else TAG in _tags(c):
            out.append(c)  # an editor's own network is never searched (no nested editors)
        elif getattr(c, "isCOMP", False) and depth < 12:
            _walk(c, out, depth + 1, legacy)


def _excluded(comp):
    """TD's own networks (/ui, /sys, /local) are never searched."""
    p = str(getattr(comp, "path", ""))
    return any(p == "/" + n or p.startswith("/" + n + "/") for n in EXCLUDED_ROOTS)


def find_editors(root=None, legacy=True):
    """All raster editors of the project under ``root`` (default: the project root; /ui, /sys and /local are skipped), in path
    order. ``legacy=False``: only COMPs with the v8 tag (fast: TD's own tag search), as used by the master's periodic scan; the
    default also finds v0.x editors."""
    if root is None:
        root = op("/")  # noqa: F821 - TD global
    out = []
    if not legacy:
        try:
            out = [c for c in root.findChildren(tags=[TAG]) if TAG in _tags(c)]
        except Exception:  # noqa: BLE001 - not TD (unit tests with fake operators)
            out = []
            _walk(root, out, legacy=False)
    else:
        _walk(root, out)
    return sorted((c for c in out if not _excluded(c)), key=lambda c: str(c.path))


def editor_id(comp):
    """The editor's stable id (stored on the COMP by the extension); '' if it has none yet."""
    try:
        return str(comp.fetch("editorId", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def editor_version(comp):
    """The ``Version`` parameter (a leading 'v' is stripped). A v8-tagged editor with an empty / unparsable Version is
    ``UNKNOWN_VERSION``; an untagged v0.x editor (no such parameter) is '0.7.x'."""
    tagged = TAG in _tags(comp)
    try:
        par = getattr(comp.par, "Version", None)
        if par is not None:
            v = str(par.eval() or "").strip()
            if VERSION_RE.match(v):
                return v[1:] if v[:1] in "vV" else v
            if v or tagged:
                return UNKNOWN_VERSION
    except Exception:  # noqa: BLE001
        pass
    return UNKNOWN_VERSION if tagged else LEGACY_VERSION


def version_tuple(v):
    """'0.8.0' -> (0, 8, 0, 1); 'v0.9.0-rc1' -> (0, 9, 0, 0) (a pre-release ranks below its release); '0.7.x' -> (0, 7, 0, 1);
    UNKNOWN_VERSION / garbage -> None (not comparable)."""
    v = str(v).strip()
    if v[:1] in "vV":
        v = v[1:]
    if v == UNKNOWN_VERSION or not v:
        return None
    core, _, rest = v.partition("-")
    core = core.partition("+")[0]
    parts = []
    for p in core.split(".")[:4]:
        m = re.match(r"\d+", p)
        if m is None and not parts:
            return None
        parts.append(int(m.group()) if m else 0)
    return tuple(parts + [0] * (3 - len(parts))) + (0 if rest else 1,)
