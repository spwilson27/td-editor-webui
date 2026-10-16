"""Run python inside the live TouchDesigner via the td-mcp debug plugin.

Usage:
    .venv/bin/python scripts/td_call.py --exec path/to/file.py   # run a file
    echo "print(op('/project1'))" | .venv/bin/python scripts/td_call.py   # run stdin

Prints stdout/stderr/traceback from TouchDesigner; exit code 1 on failure.
The code runs on TD's main thread: never sleep or loop waiting inside it — return,
then poll from outside with another call.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/Users/mrwilson/software/td-mcp/src")
from td_mcp.client import Connection, call, load_connection  # noqa: E402


def connection(host: str = "127.0.0.1", port: int | None = None, conn_file: str | None = None) -> Connection | None:
    """The td-mcp endpoint: ``conn_file`` (its host / port / token) when given, else the default connection file with ``port``
    overriding its port. None = the default file as is. A worker's TD instance has its own port + token (conn file)."""
    if conn_file:
        return load_connection(Path(conn_file).expanduser())
    if port is None:
        return None
    base = load_connection()
    return Connection(host=host, port=int(port), token=base.token)


def env_connection() -> Connection | None:
    """Endpoint from TD_CALL_CONN_FILE / TD_CALL_PORT (set by validate_td.py for the component build subprocess)."""
    return connection(os.environ.get("TD_CALL_HOST", "127.0.0.1"), int(os.environ["TD_CALL_PORT"]) if os.environ.get("TD_CALL_PORT") else None,
                      os.environ.get("TD_CALL_CONN_FILE"))


def run(code: str, timeout: float = 60, conn: Connection | None = None) -> dict:
    return call("execute_python", {"code": code}, timeout=timeout, connection=conn or env_connection())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exec", dest="path")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--td-port", type=int, default=None, help="another TD instance (default: the connection file's port)")
    parser.add_argument("--td-conn", default=None, help="connection file of another TD instance")
    args = parser.parse_args()
    if args.td_port:
        os.environ["TD_CALL_PORT"] = str(args.td_port)
    if args.td_conn:
        os.environ["TD_CALL_CONN_FILE"] = args.td_conn
    if args.path:
        # __file__ lets scripts locate the repo.
        code = f"__file__ = {args.path!r}\n" + open(args.path, encoding="utf-8").read()
    else:
        code = sys.stdin.read()
    result = run(code, args.timeout)
    for key in ("stdout", "stderr"):
        if result.get(key):
            sys.stdout.write(result[key])
    if result.get("traceback"):
        sys.stdout.write(result["traceback"])
    if not result.get("ok"):
        if result.get("error"):
            print(json.dumps(result))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
