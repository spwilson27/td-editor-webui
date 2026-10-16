"""Teardown / safety / failure-accounting logic of scripts/td_workers.py with fakes (no TouchDesigner)."""
import os
import signal
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import td_workers as W  # noqa: E402


class FakeProc:
    pid = 4242
    returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return 0


def make_inst(tmp_path, monkeypatch):
    inst = W.Instance(0, str(tmp_path / "v.toe"), str(tmp_path / "w0"), 18770, td_bin="/bin/td", popen=lambda cmd, **kw: FakeProc())
    inst.registry = str(tmp_path / "pids")
    monkeypatch.setattr(W, "proc_info", lambda pid: ("Thu Oct 15 23:00:00 2026", "/bin/td x.toe"))
    return inst


def test_terminate_signals_own_group_once_then_is_dead(tmp_path, monkeypatch):
    inst = make_inst(tmp_path, monkeypatch)
    inst.launch()
    assert "4242" in open(inst.registry).read()
    sent = []
    monkeypatch.setattr(os, "getpgid", lambda pid: pid)
    state = {"alive": True}
    monkeypatch.setattr(W, "group_has_td", lambda pg: state["alive"])

    def killpg(pg, sig):
        sent.append((pg, sig))
        state["alive"] = False
    assert inst.terminate(killpg=killpg, sleep=lambda s: None)
    assert sent == [(4242, signal.SIGTERM)]
    assert inst.pid is None and inst.last_pid == 4242      # dead: a later terminate / Fleet.close never signals again
    assert not inst.terminate(killpg=killpg)
    assert sent == [(4242, signal.SIGTERM)]
    assert "4242" not in open(inst.registry).read()


def test_terminate_refuses_protected_foreign_reused_or_reaped(tmp_path, monkeypatch):
    sent = []
    kp = lambda pg, sig: sent.append(pg)  # noqa: E731
    inst = make_inst(tmp_path, monkeypatch)
    inst.launch()
    assert not inst.terminate(protected={4242}, killpg=kp)
    monkeypatch.setattr(os, "getpgid", lambda pid: 1)           # not the leader of its own group
    assert not inst.terminate(killpg=kp)
    monkeypatch.setattr(os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(W, "group_has_td", lambda pg: False)    # the group is not TouchDesigner (pid reused)
    assert not inst.terminate(killpg=kp)
    inst.proc.returncode = 0                                    # our Popen was reaped: the pid may have been reused
    monkeypatch.setattr(W, "group_has_td", lambda pg: True)
    assert inst.terminate(killpg=kp)
    assert sent == [] and inst.pid is None


def test_group_has_td_parses_ps(monkeypatch):
    out = f"  10 {W.TD_BIN} /x/a.toe\n  11 /usr/bin/python3 x\n  12 /Applications/TouchDesigner.app/Contents/Frameworks/H.app/x\n"

    class R:
        stdout = out
    monkeypatch.setattr(W.subprocess, "run", lambda *a, **k: R())
    assert W.group_has_td(10) and W.group_has_td(12) and not W.group_has_td(11) and not W.group_has_td(99)


def test_fleet_close_survives_errors_and_is_reentrant(monkeypatch):
    monkeypatch.setattr(W, "kill_children", lambda: None)
    calls = []

    class I:
        def __init__(self, n, fail):
            self.index, self.pid, self.mcp_port, self.conn_file, self.fail = n, n, 1, "c", fail

        def terminate(self, protected):
            calls.append(self.index)
            if self.fail:
                self.fail = False
                raise PermissionError("nope")
            self.pid = None
    f = W.Fleet(protected=set())
    f.add(I(1, True))
    f.add(I(2, False))
    f.close()
    assert calls == [1, 2] and not f._done       # the failure did not stop the other one
    f.close()                                    # not done yet: tries again
    assert calls == [1, 2, 1, 2] and f._done
    f.close()
    assert calls == [1, 2, 1, 2]


def test_fleet_signal_while_closing_is_ignored():
    f = W.Fleet(protected=set())
    f._closing = True
    f._on_signal(signal.SIGINT, None)           # would raise KeyboardInterrupt if it aborted the cleanup


def test_fleet_close_kills_validator_children(monkeypatch):
    seen = []
    monkeypatch.setattr(W, "kill_children", lambda: seen.append("kids"))
    W.Fleet(protected=set()).close()
    assert seen == ["kids"]


def test_children_killed_by_group_only_while_unreaped():
    sent = []

    class P:
        pid = 77

        def __init__(self, rc):
            self.rc = rc

        def poll(self):
            return self.rc

        def wait(self, timeout=None):
            self.rc = 0
    W.kill_child(P(0), killpg=lambda pg, sig: sent.append(pg))
    assert sent == []
    W.kill_child(P(None), killpg=lambda pg, sig: sent.append(pg))
    assert sent == [77]


def test_orphans_only_when_pid_start_and_cmd_match(tmp_path):
    path = str(tmp_path / "pids")
    td = f"{W.TD_BIN} /x/validate.toe"
    W.pids_register(path, 100, ("Thu 1", td))
    W.pids_register(path, 200, ("Thu 2", td))
    W.pids_register(path, 300, ("Thu 3", td))
    live = {100: ("Thu 1", td), 200: ("Thu 9", td), 300: ("Thu 3", "/usr/bin/vim")}   # same | pid reused later | reused by another program
    found = W.find_orphans(path, info=live.get)
    assert [e["pid"] for e in found] == [100]
    assert W.find_orphans(path, protected={100}, info=live.get) == []
    killed = []
    n = W.cleanup_orphans(path, ask=lambda: True, log=lambda *a: None, find=lambda p, pr: found, kill=lambda pid: killed.append(pid) or True)
    assert n == 1 and killed == [100]
    n = W.cleanup_orphans(path, ask=None, log=lambda *a: None, find=lambda p, pr: found, kill=lambda pid: 1 / 0)
    assert n == 0


def test_kill_group_checked_requires_leader_and_td(monkeypatch):
    sent = []
    monkeypatch.setattr(W, "group_has_td", lambda pg: False)
    assert not W.kill_group_checked(5, killpg=lambda *a: sent.append(a), getpgid=lambda p: p)
    monkeypatch.setattr(W, "group_has_td", lambda pg: True)
    assert not W.kill_group_checked(5, killpg=lambda *a: sent.append(a), getpgid=lambda p: 1)
    assert sent == []


def test_run_parallel_exception_becomes_failed_steps(tmp_path):
    def runner(steps, inst, label, outdir, args):
        if label == "w1":
            raise OSError("boom")
        return [{"num": s, "status": "pass", "seconds": 1.0, "name": "n"} for s in steps], 0
    out = dict(W.run_parallel([[1, 2], [1, 3]], [None, None], str(tmp_path), None, runner))
    assert [r["status"] for r in out[1]] == ["fail", "fail"] and "boom" in out[1][0]["details"]
    assert [r["status"] for r in out[0]] == ["pass", "pass"]


def test_add_missing_marks_fail():
    out = W.add_missing([{"num": 1, "status": "pass", "seconds": 1.0, "name": "b"}], {1, 2, 5}, {2: "two"})
    assert [r["num"] for r in out] == [1, 2, 5]
    assert out[1]["status"] == "fail" and out[1]["name"] == "two" and out[1]["details"] == "no result from shard"


def test_shard_timeout_and_run_shard_timeout(tmp_path):
    assert W.shard_timeout([1, 2], {1: 10, 2: 20}) == 90 + 300
    assert W.shard_timeout([9], {}) == 20 * 3 + 300

    class A:
        page, no_build, skip_ui, td_port = "playwright", False, False, 8765
        _durations = {}

    class R:
        returncode = 124
    seen = {}

    def spawn(cmd, timeout=None, **kw):
        seen["timeout"] = timeout
        return R()
    res, rc = W.run_shard([1, 2], None, "w0", str(tmp_path), A, spawn=spawn)
    assert rc == 124 and seen["timeout"] == 2 * 20 * 3 + 300 and "timed out" in res[0]["details"]


def test_main_unknown_step_exit_2_and_missing_results_exit_1(tmp_path, monkeypatch, capsys):
    class VT:
        STEPS = [(1, "build", "build", False), (2, "two", "two", False)]
        TIMING = set()
        SMOKE = [1]

        @staticmethod
        def order_steps(nums, no_timing=False):
            return sorted(nums)
    monkeypatch.setattr(W, "VDIR", str(tmp_path))
    assert W.main(["--only", "1,77", "--attach"], vt=VT) == 2
    assert "unknown step" in capsys.readouterr().err
    monkeypatch.setattr(W, "run_shard", lambda steps, inst, label, outdir, args, **k: ([], 0))   # the validator wrote nothing
    assert W.main(["--only", "1,2", "--attach"], vt=VT) == 1
    assert "no result from shard" in capsys.readouterr().out


def test_update_last_keeps_previous_for_failed_and_zero(tmp_path):
    p = str(tmp_path / "last.json")
    W.update_last(p, [{"num": 1, "status": "pass", "seconds": 5.0}, {"num": 2, "status": "pass", "seconds": 9.0}])
    W.update_last(p, [{"num": 1, "status": "fail", "seconds": 40.0}, {"num": 2, "status": "pass", "seconds": 0.0},
                      {"num": 3, "status": "pass", "seconds": 2.0}])
    assert W.load_durations(p) == {1: 5.0, 2: 9.0, 3: 2.0}


def test_scrub_tokens(tmp_path):
    (tmp_path / "a.log").write_text("Bearer SECRET123 and more")
    (tmp_path / "connection.json").write_text('{"token": "SECRET123"}')
    assert W.scrub_tokens([str(tmp_path)], ["SECRET123"]) == [str(tmp_path / "a.log")]
    assert "SECRET123" not in (tmp_path / "a.log").read_text()
    assert "SECRET123" in (tmp_path / "connection.json").read_text()


def test_prebuild_fails_clearly(tmp_path):
    class A:
        no_build = False

    class I:
        index = 0

        def __init__(self, rpc):
            self._rpc = rpc

        def rpc(self, code, t=20):
            return self._rpc(code)
    bad = lambda *a, **k: ([{"num": 1, "status": "fail", "details": "bad"}], 1)   # noqa: E731
    ok = lambda *a, **k: ([{"num": 1, "status": "pass", "details": ""}], 0)   # noqa: E731
    with pytest.raises(W.WorkerError, match="building"):
        W.prebuild([I(lambda c: {"ok": True})], [9990], str(tmp_path), A, runner=bad)
    with pytest.raises(W.WorkerError, match="no result"):
        W.prebuild([I(lambda c: {"ok": True})], [9990], str(tmp_path), A, runner=lambda *a, **k: ([], 1))
    with pytest.raises(W.WorkerError, match="set the editor port"):
        W.prebuild([I(lambda c: {"ok": False, "error": "x"})], [9990], str(tmp_path), A, runner=ok)
    with pytest.raises(W.WorkerError, match="did not move"):
        W.prebuild([I(lambda c: {"ok": True, "stdout": '{"port": 9980}'})], [9990], str(tmp_path), A, runner=ok, wait=lambda s: None, timeout=0)
    i = I(lambda c: {"ok": True, "stdout": '{"port": 9990}'})
    assert W.prebuild([i], [9990], str(tmp_path), A, runner=ok)[0][0] == 0 and i.editor_port == 9990


def test_conn_guard_restores_and_raises(tmp_path):
    f = tmp_path / "connection.json"
    f.write_text('{"port": 8765}')
    g = W.ConnGuard(str(f))
    g.check()
    f.write_text('{"port": 18770}')
    with pytest.raises(W.WorkerError, match="restored"):
        g.check()
    assert f.read_text() == '{"port": 8765}'
    n = tmp_path / "none.json"
    g2 = W.ConnGuard(str(n))
    n.write_text("x")
    with pytest.raises(W.WorkerError):
        g2.check()
    assert not n.exists()


def test_parse_vm_stat_does_not_double_count_purgeable():
    out = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages active: 900.\n"
           "Pages inactive: 200.\nPages speculative: 50.\nPages purgeable: 150.\n")
    assert W.parse_vm_stat(out) == (100 + 200 + 50) * 16384
