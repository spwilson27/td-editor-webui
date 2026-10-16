"""Python client of scripts/page_driver.mjs: the real web page in headless Playwright Chromium (docs/VALIDATION.md, option 1).

    drv = PlaywrightPage()
    drv.goto(url); drv.eval("1 + 1") -> 2; drv.pointer(x, y, down=True); drv.key("Meta+z"); drv.screenshot() -> uint8 (h, w, 4)

One node process per PlaywrightPage; nothing global, so every validation worker (process) owns its own browser.
"""

import base64
import json
import os
import select
import signal
import subprocess
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "page_driver.mjs")
PANEL = (1280, 800)  # viewport in CSS px (the page's innerWidth x innerHeight; what the Web Render panel was)


class DriverError(RuntimeError):
    pass


class PlaywrightPage:
    def __init__(self, viewport=PANEL):
        self.viewport = viewport
        self.proc = None
        self.url = None
        self.down = False
        self._id = 0
        self._buf = b""

    # -- process ------------------------------------------------------------------------------------------------------------

    def start(self):
        """Start the driver (no-op while it runs). A failed start leaves nothing behind."""
        if self.proc is not None and self.proc.poll() is None:
            return
        env = dict(os.environ, PAGE_W=str(self.viewport[0]), PAGE_H=str(self.viewport[1]))
        # own session = own process group: stop() can take Chromium down with node
        self.proc = subprocess.Popen(["node", DRIVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=HERE,
                                     start_new_session=True)
        self._buf, self.url, self.down = b"", None, False
        try:
            ready = self._read(60)
            if not ready or not ready.get("ok"):
                raise DriverError(f"page driver did not start: {ready}")
        except BaseException:
            self.stop()
            raise

    def stop(self):
        """Close stdin (the driver closes the browser and exits), then kill the whole process group (node + Chromium)."""
        p, self.proc = self.proc, None
        if p is None:
            return
        try:
            p.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            p.wait(timeout=3)
        except Exception:  # noqa: BLE001
            pass
        try:
            os.killpg(p.pid, signal.SIGKILL)   # (also reaps Chromium helpers that outlived node)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            p.wait(timeout=2)
        except Exception:  # noqa: BLE001
            pass

    def _read(self, timeout):
        end = time.time() + timeout
        fd = self.proc.stdout.fileno()
        while b"\n" not in self._buf:
            left = end - time.time()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                return None
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                raise DriverError("page driver exited")
            self._buf += chunk
        line, self._buf = self._buf.split(b"\n", 1)
        return json.loads(line)

    def call(self, cmd, wait_s=30, **kw):
        if self.proc is None or self.proc.poll() is not None:
            raise DriverError("page driver is not running (it exited or was never started)")
        self._id += 1
        msg = dict(kw, id=self._id, cmd=cmd)
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        while True:
            r = self._read(wait_s)
            if r is None:
                self.stop()   # a hung browser is killed; the step fails (the next step's ensure() starts a fresh one explicitly)
                raise DriverError(f"page driver timed out on {cmd}")
            if r.get("id") == self._id:
                break
        if not r.get("ok"):
            raise DriverError(r.get("error", "?"))
        return r.get("result")

    # -- page ---------------------------------------------------------------------------------------------------------------

    def goto(self, url, timeout=30):
        self.down = False
        self.url = self.call("goto", timeout + 5, url=url, ms=int(timeout * 1000))
        return self.url

    def reload(self):
        self.down = False
        self.call("reload", 40)

    def eval(self, expr, timeout=30):
        """JSON value of a JS expression (promises awaited). Raises DriverError when the page throws."""
        return self.call("eval", timeout, expr=expr)

    def exec(self, code, timeout=30):
        """Run statements in the page (a function body); no result."""
        self.call("exec", timeout, code=code)

    def wait(self, selector=None, fn=None, timeout=10):
        return bool(self.call("wait", timeout + 5, selector=selector, fn=fn, ms=int(timeout * 1000)))

    def console(self):
        return self.call("console")

    # -- input --------------------------------------------------------------------------------------------------------------

    def pointer(self, x, y, down):
        """Move to (x, y) in CSS px and press / release the left button as `down` changes (what interactMouse did)."""
        self.call("mouse", op="move", x=x, y=y)
        if down and not self.down:
            self.call("mouse", op="down")
        elif not down and self.down:
            self.call("mouse", op="up")
        self.down = bool(down)

    def drag(self, points, delay=0.0):
        """Press at the first point, move through the rest, release at the last (one round trip)."""
        self.call("path", 60, points=[[float(x), float(y)] for x, y in points], delay=int(delay * 1000))
        self.down = False

    def key(self, key):
        self.call("key", key=key)

    def screenshot(self, path=None):
        """uint8 (h, w, 4) of the viewport (RGBA, straight alpha); with `path` a PNG is written there instead."""
        if path:
            self.call("screenshot", 30, path=path)
            return path
        r = self.call("screenshot", 30, raw=True)
        return np.frombuffer(base64.b64decode(r["rgba"]), np.uint8).reshape(r["h"], r["w"], 4).copy()
