"""Minimal, dependency-free client for the td-mcp debug plugin running inside TouchDesigner.

Same wire format as td-mcp's own client (src/td_mcp/client.py): POST http://<host>:<port>/rpc with a bearer token,
body {"method", "params", "timeout"}, answer {"result": {...}} or {"error": {"message"}}.

The endpoint comes from a connection file ({"host", "port", "token"}): $TD_MCP_CONNECTION, else ~/.td-mcp/connection.json.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

LOOPBACK = {"127.0.0.1", "localhost"}


def connection_path() -> Path:
    override = os.environ.get("TD_MCP_CONNECTION")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".td-mcp" / "connection.json"


class ConnectionConfigError(Exception):
    pass


@dataclass(frozen=True)
class Connection:
    host: str
    port: int
    token: str


def load_connection(path: Path | None = None) -> Connection:
    dest = path or connection_path()
    if not dest.is_file():
        raise ConnectionConfigError(f"No connection file at {dest}. Open TouchDesigner with the td_python_debug component (see docs/TESTING.md).")
    try:
        payload = json.loads(dest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConnectionConfigError(f"Could not read {dest}: {exc}") from exc
    if payload.get("host") not in LOOPBACK:
        raise ConnectionConfigError("The debug server host must be 127.0.0.1.")
    try:
        port = int(payload.get("port"))
    except (TypeError, ValueError) as exc:
        raise ConnectionConfigError("The connection file has no valid port.") from exc
    if not 1 <= port <= 65535:
        raise ConnectionConfigError("The connection file has no valid port.")
    token = payload.get("token")
    if not isinstance(token, str) or token == "":
        raise ConnectionConfigError("The connection file has no token.")
    return Connection(host=payload["host"], port=port, token=token)


def call(method: str, params: dict | None = None, *, connection: Connection | None = None,
         connection_file: Path | None = None, timeout: float = 30) -> dict:
    """One RPC; always returns a dict ({"ok": False, "error": ...} on any failure)."""
    try:
        conn = connection or load_connection(connection_file)
    except ConnectionConfigError as exc:
        return {"ok": False, "error": str(exc)}
    wait = min(max(float(timeout), 0.1), 120.0)
    body = json.dumps({"method": method, "params": params or {}, "timeout": wait}).encode("utf-8")
    request = urllib.request.Request(
        f"http://{conn.host}:{conn.port}/rpc", data=body, method="POST",
        headers={"Authorization": f"Bearer {conn.token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=wait + 5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": _http_error(exc)}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": f"TouchDesigner is not reachable at {conn.host}:{conn.port}. ({exc.reason})"}
    except TimeoutError:
        return {"ok": False, "error": "Timed out waiting for TouchDesigner. The main thread may be busy."}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "TouchDesigner returned a response that was not an object."}
    error = payload.get("error")
    if error:
        return {"ok": False, "error": error.get("message", str(error)) if isinstance(error, dict) else str(error)}
    result = payload.get("result")
    return result if isinstance(result, dict) else {"ok": False, "error": "TouchDesigner returned no result."}


def _http_error(exc: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return f"TouchDesigner returned HTTP {exc.code}."
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return f"TouchDesigner returned HTTP {exc.code}."
