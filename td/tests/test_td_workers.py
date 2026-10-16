"""Sharding / launch / teardown logic of scripts/td_workers.py with fakes (no TouchDesigner)."""
import json
import os
import signal
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import td_workers as W  # noqa: E402


def test_shard_lpt_balances_and_keeps_every_step():
    dur = {1: 5, 2: 100, 3: 90, 4: 10, 5: 60, 6: 55}
    shards = W.shard_steps(list(dur), dur, 3)
    assert sorted(s for sh in shards for s in sh) == sorted(dur)
    loads = sorted(W.shard_load(sh, dur) for sh in shards)
    assert loads[-1] - loads[0] <= 50          # 100 | 90+10 | 60+55+5 -> 100, 100, 120 at worst
    assert max(loads) <= 120


def test_shard_longest_first_goes_to_distinct_shards():
    shards = W.shard_steps([1, 2, 3], {1: 10, 2: 300, 3: 200}, 3)
    assert sorted(len(s) for s in shards) == [1, 1, 1]


def test_shard_without_records_is_equal_split():
    shards = W.shard_steps(list(range(1, 8)), {}, 3)
    assert [len(s) for s in shards] == [3, 2, 2]


def test_shard_unknown_steps_count_as_median():
    shards = W.shard_steps([1, 2, 3, 4], {1: 100, 2: 100}, 2)
    assert sorted(s for sh in shards for s in sh) == [1, 2, 3, 4]
    assert all(len(sh) == 2 for sh in shards)


def test_load_durations_formats(tmp_path):
    p = tmp_path / "a.json"
    p.write_text(json.dumps({"durations": {"5": 1.5, "6": 2}}))
    assert W.load_durations(str(p)) == {5: 1.5, 6: 2.0}
    p.write_text(json.dumps({"steps": [{"num": 7, "seconds": 3.0}]}))
    assert W.load_durations(str(p)) == {7: 3.0}
    assert W.load_durations(str(tmp_path / "missing.json")) == {}


def test_plan_steps_timing_after_and_prelude_excluded():
    par, tim = W.plan_steps([1, 2, 7, 8, 12, 99], {7, 8, 12})
    assert par == [2] and tim == [7, 8, 12, 99]    # 99 (deletes the COMP) never shares an instance with later steps
    par, tim = W.plan_steps([1, 2, 7, 99], {7}, no_timing=True)
    assert par == [2] and tim == [99]


def test_shard_commands_prepend_build_only_when_work():
    assert W.shard_commands([[2, 3], []]) == [[1, 2, 3], []]


def test_merge_results_reports_prelude_once_worst_wins():
    a = [{"num": 1, "name": "b", "status": "pass", "seconds": 3.0}, {"num": 2, "name": "s", "status": "pass", "seconds": 1.0}]
    b = [{"num": 1, "name": "b", "status": "fail", "seconds": 2.0}, {"num": 4, "name": "n", "status": "pass", "seconds": 9.0}]
    m = W.merge_results([(0, a), (1, b)])
    assert [r["num"] for r in m] == [1, 2, 4]
    assert m[0]["status"] == "fail" and m[0]["seconds"] == 3.0 and m[0]["worker"] == 1


def test_cap_workers():
    gb = W.GB
    assert W.cap_workers(3, 64 * gb, 16)[0] == 3
    n, why = W.cap_workers(3, 14 * gb, 16)   # 14 - 8 reserve = 6 GB -> 2 instances of 3 GB
    assert n == 2 and "RAM" in why
    assert W.cap_workers(3, 1 * gb, 16)[0] == 1
    assert W.cap_workers(3, 64 * gb, 8)[0] == 2
    assert W.cap_workers(3, 64 * gb, 16, steps=1)[0] == 1
    assert W.cap_workers(3, None, None)[0] == 3


def test_pick_ports_skips_user_port_and_busy_ones():
    ports = W.pick_ports(3, base=8764, is_free=lambda p: p != 8766)
    assert 8765 not in ports and 8766 not in ports and len(set(ports)) == 3


class FakeProc:
    pid = 4242
    returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return 0


def make_inst(tmp_path, popen=None):
    seen = {}

    def fake_popen(cmd, **kw):
        seen["cmd"], seen["kw"] = cmd, kw
        return FakeProc()
    inst = W.Instance(0, str(tmp_path / "v.toe"), str(tmp_path / "w0"), 18770, td_bin="/bin/td", popen=popen or fake_popen)
    inst.registry = None
    return inst, seen


def test_launch_env_new_session_and_private_connection_file(tmp_path):
    inst, seen = make_inst(tmp_path)
    inst.launch()
    env = seen["kw"]["env"]
    assert env["TD_MCP_PORT"] == "18770" and env["TD_MCP_CONNECTION"] == str(tmp_path / "w0" / "connection.json")
    assert seen["kw"]["start_new_session"] is True
    assert seen["cmd"] == ["/bin/td", str(tmp_path / "v.toe")]
    assert "/.td-mcp/" not in env["TD_MCP_CONNECTION"]


def test_launch_refuses_protected_pid(tmp_path):
    inst, _ = make_inst(tmp_path)
    with pytest.raises(RuntimeError):
        inst.launch(protected={4242})


def test_wait_ready_polls_until_rpc_answers(tmp_path):
    inst, _ = make_inst(tmp_path)
    inst.launch()
    clock = {"t": 0.0}
    answers = iter([{"ok": False}, {"ok": True, "stdout": "noproj"}, {"ok": True, "stdout": "ready\n"}])
    open(inst.conn_file, "w").write("{}")

    def sleep(s):
        clock["t"] += s
    secs = inst.wait_ready(30, rpc=lambda code, t: next(answers), sleep=sleep, clock=lambda: clock["t"])
    assert secs == pytest.approx(1.0)


def test_wait_ready_times_out_and_detects_exit(tmp_path):
    inst, _ = make_inst(tmp_path)
    inst.launch()
    clock = {"t": 0.0}

    def sleep(s):
        clock["t"] += s
    with pytest.raises(TimeoutError):
        inst.wait_ready(5, rpc=lambda c, t: {"ok": False}, sleep=sleep, clock=lambda: clock["t"])
    inst.proc.returncode = 1
    with pytest.raises(RuntimeError):
        inst.wait_ready(5, rpc=lambda c, t: {"ok": False}, sleep=sleep, clock=lambda: clock["t"])


def test_run_parallel_and_validator_cmd(tmp_path):
    class A:
        page, no_build, skip_ui, td_port = "playwright", False, False, 8765
    inst, _ = make_inst(tmp_path)
    inst.mcp_port = 18771
    cmd = W.validator_cmd([1, 2], inst, "/x/o.json", A)
    assert cmd[-4:] == ["--td-conn", inst.conn_file, "--td-port", "18771"] or "--td-conn" in cmd
    assert cmd[cmd.index("--only") + 1] == "1,2"
    att = W.validator_cmd([1], None, "/x/o.json", A)
    assert "--td-conn" not in att and att[att.index("--td-port") + 1] == "8765"

    calls = []

    def runner(steps, i, label, outdir, args):
        calls.append((label, steps))
        return [{"num": s, "status": "pass", "seconds": 1.0, "name": "n"} for s in steps], 0
    out = W.run_parallel([[1, 2], [], [1, 3]], [None, None, None], str(tmp_path), A, runner)
    assert sorted(calls) == [("w0", [1, 2]), ("w2", [1, 3])]
    assert sorted(w for w, _ in out) == [0, 2]


def test_run_shard_crash_gives_failed_results(tmp_path):
    class A:
        page, no_build, skip_ui, td_port = "playwright", False, False, 8765

    class R:
        returncode = 1
    res, rc = W.run_shard([1, 2], None, "w9", str(tmp_path), A, spawn=lambda *a, **k: R())
    assert rc == 1 and [r["status"] for r in res] == ["fail", "fail"]
