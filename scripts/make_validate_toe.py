"""Generate the validation project .validate/validate.toe (docs/VALIDATION.md, option 2).

    .venv/bin/python scripts/make_validate_toe.py [--out .validate/validate.toe] [--seed-from-attached]

The project holds /project1/td_python_debug (the td-mcp debug server) and nothing else; the raster editor is built from
dist/raster_editor.tox by validation step 1 in every worker. Generated in a scratch TouchDesigner instance launched here (its own
td-mcp port + connection file): the user's project is never modified or saved.

How: TouchDesigner opens a .tox given on the command line as a new project, so the td-mcp component is saved once as a seed tox
(.validate/td_python_debug.tox), opened in a scratch instance, copied under /project1 and the project saved as validate.toe.
The seed tox is taken from the running TD on 8765 only with --seed-from-attached (a read-only `COMP.save(tox)` of
/project1/td_python_debug; the user's project is not changed); once cached it is reused.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import td_workers as W  # noqa: E402

SEED_TOX = os.path.join(W.VDIR, "td_python_debug.tox")
TD_MCP = "/Users/mrwilson/software/td-mcp"
DEFAULT_PORT = 18765   # the port stored in the toe: never 8765, so opening it by hand cannot collide with the user's server


def build_code(out_toe, port, clean_seed, module_path=TD_MCP):
    """Python run inside the scratch instance (opened from the seed tox: the component is /td_python_debug). The Token parameter is
    blanked everywhere that is kept (the clean seed tox, the toe): every worker then generates its own random token at start."""
    return f"""from td import *
root = op('/')
p = root.op('project1') or root.create(baseCOMP, 'project1')
src = op('/td_python_debug')
dbg = p.copy(src, name='td_python_debug')
dbg.nodeX, dbg.nodeY = 0, 0
dbg.par.Port = {port}
dbg.par.Token = ''
dbg.par.Autostart = 1
dbg.par.Modulepath = {module_path!r}
dbg.save({clean_seed!r})
src.destroy()
project.save({out_toe!r})
print('saved', [c.name for c in p.children])
"""


def seed_from_attached(seed=SEED_TOX, port=W.USER_PORT):
    """Read-only: save the attached TD's td_python_debug component as a tox file."""
    import td_call
    os.makedirs(os.path.dirname(seed), exist_ok=True)
    conn = td_call.connection("127.0.0.1", port, None)
    res = td_call.run(f"c = op('/project1/td_python_debug')\nc.save({seed!r})\nprint(c.path)", 30, conn)
    if not res.get("ok"):
        raise RuntimeError(f"could not save the seed tox from the attached TD: {str(res.get('error') or res.get('traceback'))[-300:]}")
    os.chmod(seed, 0o600)   # it holds the attached TD's token until generate() replaces it with a blank-token copy
    return seed


MIN_TOE_BYTES = 1000


def generate(out=W.VALIDATE_TOE, seed=SEED_TOX, port=None, td_bin=W.TD_BIN, timeout=120, log=print, check=True):
    """Build `out` atomically: saved to a temp path, size-checked, opened once in a scratch instance (it must hold td_python_debug), then
    renamed over `out`. The seed tox is replaced by a blank-token copy; the scratch work dir (connection file with a token) is deleted."""
    if not os.path.exists(seed):
        raise FileNotFoundError(f"{seed} missing: run with --seed-from-attached (saves it from the TD on {W.USER_PORT}, read-only)")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    workdir = os.path.join(W.VDIR, "gen")
    mcp = W.pick_ports(1, base=W.BASE_MCP_PORT + 90)[0]
    protected = W.td_pids() | W.listener_pid(W.USER_PORT)
    tmp = out[:-4] + ".new.toe" if out.endswith(".toe") else out + ".new.toe"
    clean = os.path.join(os.path.dirname(out), "td_python_debug.clean.tox")
    for f in (tmp, clean):
        if os.path.exists(f):
            os.remove(f)
    try:
        with W.Fleet(protected=protected) as fleet:
            inst = fleet.add(W.Instance(0, seed, workdir, mcp, td_bin))
            # seed tox: a tox opens as a project whose root holds the component (no /project1), so wait on the connection file
            inst.launch(protected)
            t0 = time.time()
            end = t0 + timeout
            while time.time() < end and not os.path.exists(inst.conn_file):
                if not inst.alive():
                    raise RuntimeError(f"scratch TouchDesigner exited early, see {inst.log}")
                time.sleep(0.5)
            if not os.path.exists(inst.conn_file):
                raise TimeoutError(f"scratch TouchDesigner not ready in {timeout}s (a dialog? see {inst.log})")
            log(f"scratch instance pid {inst.pid} ready in {time.time() - t0:.1f}s")
            res = inst.rpc(build_code(tmp, DEFAULT_PORT, clean), 60)
            if not res.get("ok"):
                raise RuntimeError(f"building the project failed: {str(res.get('error') or res.get('traceback'))[-300:]}")
            log(res.get("stdout", "").strip())
        for f in (tmp, clean):
            if not os.path.exists(f) or os.path.getsize(f) < MIN_TOE_BYTES // 2:
                raise RuntimeError(f"generated file {f} is missing or too small")
        if os.path.getsize(tmp) < MIN_TOE_BYTES:
            raise RuntimeError(f"generated project {tmp} is only {os.path.getsize(tmp)} bytes")
        if check and not verify(tmp, log=log):
            raise RuntimeError("the generated project does not open with td_python_debug under /project1")
        os.replace(tmp, out)
        os.replace(clean, seed)   # blank Token: never keeps the attached TD's token
        os.chmod(seed, 0o600)
    finally:
        for f in (tmp, clean):
            if os.path.exists(f):
                os.remove(f)
        shutil.rmtree(workdir, ignore_errors=True)   # its connection file holds the scratch instance's token
    log(f"wrote {out} ({os.path.getsize(out)} bytes)")
    return out


def verify(toe=W.VALIDATE_TOE, log=print):
    """Open the toe in a scratch instance on its own port and check it holds only the debug server."""
    workroot = os.path.join(W.VDIR, "verify")
    protected = W.td_pids() | W.listener_pid(W.USER_PORT)
    try:
        with W.Fleet(protected=protected) as fleet:
            insts = W.launch_fleet(1, toe, workroot, fleet, 120, log=log)
            res = insts[0].rpc("print(sorted(c.name for c in op('/project1').children))", 20)
            log(res.get("stdout", "").strip())
            return bool(res.get("ok")) and res.get("stdout", "").strip() == "['td_python_debug']"
    finally:
        shutil.rmtree(workroot, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default=W.VALIDATE_TOE)
    ap.add_argument("--seed-from-attached", action="store_true", help=f"(re)create the seed tox from the TD on {W.USER_PORT} (read-only)")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args(argv)
    if args.seed_from_attached or not os.path.exists(SEED_TOX):
        if not args.seed_from_attached:
            print(f"{SEED_TOX} missing; pass --seed-from-attached", file=sys.stderr)
            return 2
        print("seed:", seed_from_attached())
    generate(args.out, check=not args.no_verify)
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
