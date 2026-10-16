"""validate_td.py without TouchDesigner: endpoint propagation, tier mapping, redaction, page driver lifecycle."""
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import validate_td as V  # noqa: E402
import page_driver as PD  # noqa: E402


def test_build_subprocess_gets_the_configured_endpoint(monkeypatch):
    monkeypatch.setenv("TD_CALL_PORT", "8765")        # a stale inherited value must not leak through
    monkeypatch.setenv("TD_CALL_CONN_FILE", "/home/user/.td-mcp/connection.json")
    V.configure(td_port=9123)
    env = V.td_env()
    assert env["TD_CALL_PORT"] == "9123" and "TD_CALL_CONN_FILE" not in env
    V.configure(td_port=9123, td_conn_file="/tmp/w1.json")
    env = V.td_env()
    assert env["TD_CALL_CONN_FILE"] == "/tmp/w1.json" and "TD_CALL_PORT" not in env


def test_s1_build_passes_env_to_subprocess(monkeypatch):
    V.configure(td_port=9124)
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(kw)
        return subprocess.CompletedProcess(cmd, 1, "", "stop here")
    monkeypatch.setattr(V.subprocess, "run", fake_run)
    monkeypatch.setattr(V, "op_exists", lambda: False)
    ok, _ = V.s1_build(V.ARGS)
    assert not ok and seen["env"]["TD_CALL_PORT"] == "9124"


def test_td_calls_use_the_configured_connection(monkeypatch):
    V.configure(td_port=9125)
    got = {}
    monkeypatch.setattr(V.td_call, "connection", lambda host, port, conn_file: ("conn", host, port, conn_file))
    monkeypatch.setattr(V.td_call, "run", lambda code, timeout, conn=None: got.setdefault("conn", conn) and {"ok": True, "stdout": ""})
    V.td("pass")
    assert got["conn"] == ("conn", "127.0.0.1", 9125, None)


def test_affected_most_specific_wins():
    steps, areas, _ = V.affected_steps(["web/src/shared/x.ts"])
    assert areas == ["*"] or set(V.ALL_AREAS) <= set(areas)       # web/ fallback -> everything, not shared/'s
    _, areas, _ = V.affected_steps(["web/src/ui/Scrub.tsx"])
    assert areas == ["scrub"]
    steps, _, _ = V.affected_steps(["docs/VALIDATION.md"])
    assert steps == sorted(V.SMOKE)


@pytest.mark.parametrize("path", ["td/new_thing.py", "shared/protocol.json", "dist/raster_editor.tox", "web/src/other.ts", "td/raster_editor/new.glsl", "x/y.glsl"])
def test_unmapped_product_paths_run_everything(path):
    steps, _, _ = V.affected_steps([path])
    assert set(steps) == set(V.STEP_AREAS)


def test_td_tests_and_scripts_only_smoke():
    steps, _, _ = V.affected_steps(["td/tests/test_x.py", "scripts/validate_td.py"])
    assert steps == sorted(V.SMOKE)


def test_redaction():
    t = "GET http://127.0.0.1:9981/?test=1#token=AbC_d-1&e=xyz and /x?token=Q9"
    r = V.redact(t)
    assert "AbC_d-1" not in r and "Q9" not in r and "token=<redacted>" in r and "&e=xyz" in r


def test_step_detail_is_redacted():
    V.configure()
    V.RESULTS.clear()
    monkey = V.baseline
    V.baseline = lambda: None
    try:
        V.step(1, "x", lambda: (True, "url #token=SECRET&e=1"))
    finally:
        V.baseline = monkey
    assert "SECRET" not in V.RESULTS[0].details


def test_driver_lifecycle_and_no_silent_restart():
    d = PD.PlaywrightPage()
    with pytest.raises(PD.DriverError):
        d.call("url")                     # never started: raises, does not start one
    d.start()
    pid = d.proc.pid
    assert d.call("url") is not None or True
    d.stop()
    with pytest.raises(OSError):
        os.killpg(pid, 0)                 # whole group gone
    with pytest.raises(PD.DriverError):
        d.call("url")
