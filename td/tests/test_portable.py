"""Nothing depends on one machine: TD binary lookup, the built-in td-mcp client, the committed debug tox, no user paths."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import td_client  # noqa: E402
import td_workers as W  # noqa: E402


def test_find_td_bin_env_wins():
    assert W.find_td_bin(env={"TD_BIN": "/x/TD"}) == "/x/TD"


def test_find_td_bin_macos_locations():
    found = "/Applications/TouchDesigner.app/Contents/MacOS/TouchDesigner"
    assert W.find_td_bin(env={}, exists=lambda p: p == found, platform="darwin") == found
    assert W.find_td_bin(env={}, exists=lambda p: False, platform="darwin") is None
    assert W.find_td_bin(env={}, exists=lambda p: True, platform="linux") is None


def test_find_td_bin_windows_locations(tmp_path):
    exe = tmp_path / "Derivative" / "TouchDesigner.2025.1" / "bin" / "TouchDesigner.exe"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    assert W.find_td_bin(env={"ProgramFiles": str(tmp_path)}, platform="win32") == str(exe)


def test_missing_binary_is_a_clear_error(tmp_path):
    try:
        W.require_td_bin(str(tmp_path / "nope"))
    except RuntimeError as exc:
        assert "TD_BIN" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_td_client_posts_like_td_mcp(tmp_path):
    seen = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            seen["path"] = self.path
            seen["auth"] = self.headers["Authorization"]
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            raw = json.dumps({"result": {"ok": True, "stdout": "hi"}}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    conn_file = tmp_path / "c.json"
    conn_file.write_text(json.dumps({"host": "127.0.0.1", "port": srv.server_address[1], "token": "tok"}))
    old = os.environ.get("TD_MCP_CONNECTION")
    os.environ["TD_MCP_CONNECTION"] = str(conn_file)
    try:
        res = td_client.call("execute_python", {"code": "1"}, timeout=5)
    finally:
        srv.shutdown()
        os.environ.pop("TD_MCP_CONNECTION") if old is None else os.environ.__setitem__("TD_MCP_CONNECTION", old)
    assert res == {"ok": True, "stdout": "hi"}
    assert seen["path"] == "/rpc" and seen["auth"] == "Bearer tok"
    assert seen["body"] == {"method": "execute_python", "params": {"code": "1"}, "timeout": 5.0}


def test_td_client_missing_connection_file(tmp_path):
    res = td_client.call("x", connection_file=tmp_path / "none.json")
    assert res["ok"] is False and "none.json" in res["error"]


def test_committed_debug_tox_has_no_token_and_a_manifest():
    tox = ROOT / "tests" / "td" / "td_python_debug.tox"
    assert tox.is_file() and tox.stat().st_size > 1000
    manifest = json.loads((ROOT / "tests" / "td" / "td_python_debug.manifest.json").read_text())["sources"]
    assert {"bootstrap", "callbacks", "mod_runtime"} <= set(manifest)


def test_no_machine_specific_paths_tracked():
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True).stdout.split("\0")
    bad = []
    for f in files:
        if not f.endswith((".py", ".md", ".json", ".yml", ".txt", ".mjs", ".ts")) or f.endswith("test_portable.py"):
            continue
        p = ROOT / f
        if not p.is_file() or "node_modules" in f:
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        if "/Users/" in text or "mrwilson" in text or "/private/tmp/claude" in text:
            bad.append(f)
    assert not bad, bad
