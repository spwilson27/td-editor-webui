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
import sys

sys.path.insert(0, "/Users/mrwilson/software/td-mcp/src")
from td_mcp.client import call  # noqa: E402


def run(code: str, timeout: float = 60) -> dict:
    return call("execute_python", {"code": code}, timeout=timeout)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exec", dest="path")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
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
