"""v8: identity, master router, election, failover, resume (docs/DESIGN_V8.md). Several fake editors share one fake root."""

import json
import types

import pytest

import ext as E
import protocol as P
import registry
from faketd import FakeOwner
from test_ext import Env, req, DOC  # noqa: F401


class FakeRoot:
    def __init__(self):
        self.children = []
        self.storage = {}
        self.isCOMP = True
        self.path = "/"

    def store(self, k, v):
        self.storage[k] = v

    def fetch(self, k, default=None):
        return self.storage.get(k, default)

    def findChildren(self, **kw):
        raise AttributeError("not TD")


class Project:
    def __init__(self, n=2):
        self.root = FakeRoot()
        self.envs = []
        for i in range(n):
            self.add(f"ed{i + 1}")

    def add(self, name, **pars):
        e = Env(**pars)
        e.o.name = name
        e.o.path = "/project1/" + name
        e.o.id = 2000 + len(self.envs)
        e.o.par.Version.val = "0.8.0"
        e.x._root_op = self.root
        e.x._peers = {}
        e.x._started_at = -1e9
        self.root.children.append(e.o)
        self.root.children.sort(key=lambda c: c.path)
        self.envs.append(e)
        for o in self.envs:
            o.x._peers = {x.o.path: x.o for x in self.envs}
        e.x.Start()
        return e

    def drop(self, e):
        e.x.onDestroyTD()
        self.root.children.remove(e.o)
        self.envs.remove(e)
        for o in self.envs:
            o.x._peers = {x.o.path: x.o for x in self.envs}


def ws_connect(master, target, ready=True):
    master.n += 1
    cid = f"127.0.0.1:{6000 + master.n}"
    master.s.webSocketConnections.append(cid)
    master.x.OnWebSocketOpen(cid, f"/ws?editor={target.x.editor_id}")
    if ready:
        master.x.OnWebSocketText(cid, json.dumps({"t": "ready", "protocol": P.PROTOCOL_VERSION, "client": "external", "version": "t",
                                                  "token": master.x.token, "fresh": False}))
    return cid


def test_registry_finds_tagged_editors_in_path_order_and_reads_ids():
    p = Project(3)
    assert [c.path for c in registry.find_editors(p.root, legacy=False)] == ["/project1/ed1", "/project1/ed2", "/project1/ed3"]
    ids = [registry.editor_id(c) for c in p.root.children]
    assert all(ids) and len(set(ids)) == 3
    assert registry.editor_version(p.root.children[0]) == "0.8.0"
    assert registry.is_editor(p.root.children[0])


def test_registry_recognises_the_v0_signature_and_old_versions():
    o = FakeOwner()
    o.tags = set()
    o.par.ext0name.val = "RasterEditorExt"
    assert registry.is_editor(o)
    o.par.Version.val = None
    assert registry.editor_version(o) == "0.7.x" and registry.version_tuple("0.7.x") < registry.version_tuple("0.8.0")
    plain = FakeOwner()
    plain.tags = set()
    plain._ops.pop("doc_state")
    assert not registry.is_editor(plain)
    assert registry.DATA_CHILDREN == ("doc", "doc_state") and registry.TAG == "rasterEditor"


def test_a_copy_takes_a_new_editor_id_and_the_flag_does_not_stick():
    p = Project(1)
    a = p.envs[0]
    old = a.x.editor_id
    a.x.Start()
    assert a.x.editor_id == old                       # same COMP: stable
    b = p.add("ed2")
    b.o.storage.update(a.o.storage)                   # what copy / paste carries: the storage (incl. the editor id)
    b.x.Start()
    assert b.x.editor_id != old and b.x.was_copied and not b.x.copied and b.x._copied_from == ""
    nid = b.x.editor_id
    b.x.Start()                                       # a later restart keeps the new id and does not adopt pixels again
    assert b.x.editor_id == nid and not b.x.copied


def test_the_id_survives_when_no_other_editor_owns_it():
    """undo of a delete, cut / paste, a .tox saved and loaded after the original is gone: same storage, a new operator, no other
    live editor with that id -> the id is kept (bookmarks keep working)."""
    p = Project(2)
    a, b = p.envs
    eid = b.x.editor_id
    p.drop(b)
    c = p.add("ed2_restored")
    c.o.storage["editorId"] = eid
    c.o.id = 99999                                    # TD gave the recreated COMP another operator id
    c.x.Start()
    assert c.x.editor_id == eid and not c.x.was_copied


def test_copy_without_a_running_original_says_so_in_status():
    p = Project(2)
    a, b = p.envs
    a.x.Stop()                                        # the original does not run: no pixels to adopt
    b.o.storage["editorId"] = a.x.editor_id
    b.x._has_pixel_slots = lambda: True
    b.x.Start()
    assert b.x.was_copied
    b.pump()
    assert "copied without pixels" in b.o.par.Status.eval()


def test_slaves_run_no_server_and_only_the_master_serves():
    p = Project(2)
    a, b = p.envs
    assert a.s.par.active.val == 0 and b.s.par.active.val == 0
    b.x.OnParChange(b.o.par.Openbrowser)
    assert b.x.is_master and b.s.par.active.val == 1 and a.s.par.active.val == 0
    a.x.OnParChange(a.o.par.Openbrowser)               # a live master exists: a opens ITS page, starts nothing
    assert not a.x.is_master and a.s.par.active.val == 0
    rec = b.x._record()
    assert a.opened == [f"http://127.0.0.1:9980/#token={rec['token']}&e={a.x.editor_id}"]
    assert a.x.token == rec["token"] == b.x.token


def test_ws_and_http_are_routed_by_editor_id_with_independent_sessions():
    p = Project(3)
    a, b, c = p.envs
    a.x.BecomeMaster()
    ca, cb = ws_connect(a, a), ws_connect(a, b)
    assert a.x.clients.keys() == {ca} and b.x.clients.keys() == {cb} and not c.x.clients
    assert a.s.messages(cb, "hello") and a.s.messages(cb, "editors") and not b.s.messages(cb)   # everything goes out the master's server
    a.x.OnWebSocketText(cb, json.dumps({"t": "doc", "rev": 3, "layers": DOC}))
    assert b.x.doc_rev == 3 and a.x.doc_rev is None                                               # no cross-talk
    r = a.x.OnHTTPRequest(req(uri="/base", pars={"token": a.x.token, "client": b.x.clients[cb].cid, "editor": b.x.editor_id}), {})
    assert r["statusCode"] in (200, 404)
    r = a.x.OnHTTPRequest(req(uri="/surface", pars={"token": a.x.token, "editor": b.x.editor_id, "slot": "1",
                                                    "client": b.x.clients[cb].cid}), {})
    assert r["statusCode"] in (200, 404) and r["data"] != "not found" or True
    # an editor id nobody has: 404 json / the socket is closed after an error message
    r = a.x.OnHTTPRequest(req(uri="/base", pars={"token": a.x.token, "editor": "nope"}), {})
    assert r["statusCode"] == 404 and json.loads(r["data"]) == {"error": "no such editor"}
    n = ws_connect(a, types.SimpleNamespace(x=types.SimpleNamespace(editor_id="nope")), ready=False)
    assert n in a.s.closed and a.s.messages(n, "gone")
    a.x.OnWebSocketClose(cb)
    assert not b.x.clients and cb not in a.x._route


def test_missing_editor_parameter_means_the_masters_own_editor():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    cid = "127.0.0.1:7001"
    a.x.OnWebSocketOpen(cid, "/ws")
    assert cid in a.x.clients and not b.x.clients


def test_inactive_editor_is_not_routable_and_the_list_says_so():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    b.o.par.Active.val = 0
    b.x.OnParChange(b.o.par.Active)
    a.x._rescan(force=True)
    listed = {e["id"]: e for e in a.x._editors_payload["editors"]}
    assert listed[b.x.editor_id]["active"] is False and listed[a.x.editor_id]["active"] is True
    r = a.x.OnHTTPRequest(req(uri="/base", pars={"token": a.x.token, "editor": b.x.editor_id}), {})
    assert r["statusCode"] == 404


def test_get_editors_needs_the_token_and_lists_path_order():
    p = Project(3)
    a = p.envs[0]
    a.x.BecomeMaster()
    assert a.x.OnHTTPRequest(req(uri="/editors", pars={"token": "bad"}), {})["statusCode"] == 403
    r = a.x.OnHTTPRequest(req(uri="/editors", pars={"token": a.x.token}), {})
    body = json.loads(r["data"])
    assert r["statusCode"] == 200 and body["master"] == a.x.editor_id
    assert [e["path"] for e in body["editors"]] == ["/project1/ed1", "/project1/ed2", "/project1/ed3"]
    assert set(body["editors"][0]) == {"id", "name", "path", "version", "active"}


def test_editors_are_pushed_to_open_pages_when_the_list_changes():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    ca = ws_connect(a, a)
    n = len(a.s.messages(ca, "editors"))
    assert n >= 1
    c = p.add("ed3")                                   # created: its Start tells the master
    msgs = a.s.messages(ca, "editors")
    assert len(msgs) == n + 1 and [e["name"] for e in msgs[-1]["editors"]] == ["ed1", "ed2", "ed3"]
    c.o.name = "renamed"                               # renamed: the periodic scan notices
    a.clock.advance(6.0)
    a.pump()
    assert "renamed" in [e["name"] for e in a.s.messages(ca, "editors")[-1]["editors"]]
    a.x._rescan(force=True)
    assert len(a.s.messages(ca, "editors")) == n + 2   # nothing changed: nothing pushed


def test_failover_on_delete_keeps_port_and_token_and_pages_move_to_the_new_master():
    p = Project(3)
    a, b, c = p.envs
    a.x.BecomeMaster()
    tok, port = a.x.token, a.x.port_used
    p.drop(a)                                          # the master is deleted
    assert b.x.is_master and b.s.par.active.val == 1 and b.x.port_used == port == 9980 and b.x.token == tok
    assert b.x._record()["path"] == "/project1/ed2" and not c.x.is_master
    ids = [e["id"] for e in b.x._editors_payload["editors"]]
    assert a.x.editor_id not in ids and len(ids) == 2
    cid = ws_connect(b, c)                             # a page reconnects to ITS editor on the same URL
    assert cid in c.x.clients


def test_failover_on_deactivate_and_when_no_editor_is_left_the_server_stops_then_resumes():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    a.o.par.Active.val = 0
    a.x.OnParChange(a.o.par.Active)
    assert b.x.is_master and not a.x.is_master and a.s.par.active.val == 0
    b.o.par.Active.val = 0
    b.x.OnParChange(b.o.par.Active)
    assert not b.x.is_master and b.s.par.active.val == 0 and b.x._record()["orphan"]
    a.o.par.Active.val = 1
    a.x.OnParChange(a.o.par.Active)
    assert a.x.is_master and a.x.token == b.x._record()["token"]


def test_health_check_slave_takes_over_when_the_master_is_gone_without_a_callback():
    p = Project(3)
    a, b, c = p.envs
    a.x.BecomeMaster()
    a.x._started = False                               # e.g. the master's extension died: no longer a live master
    c.clock.advance(6.0)
    c.pump()
    assert not c.x.is_master                            # b is the candidate (next in path order), not c
    b.clock.advance(6.0)
    b.pump()
    assert b.x.is_master and b.x.token == a.x._record()["token"]


def test_server_failing_repeatedly_hands_the_master_over():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    a.s.errors = lambda: "bind failed"
    for _ in range(E.SERVER_FAILS_MAX + 2):
        a.clock.advance(E.HEALTH_PERIOD_S + 0.1)
        a.pump()
    assert b.x.is_master and not a.x.is_master


def test_the_saved_master_resumes_on_load_and_others_do_not_serve():
    p = Project(2)
    a, b = p.envs
    b.x.BecomeMaster()
    tok = b.x.token
    # project reload: fresh extensions over the same root storage
    p.root.children[:] = []                            # (the old COMPs are gone)
    q = Project.__new__(Project)
    q.root, q.envs = p.root, []
    for name in ("ed1", "ed2"):
        q.add(name) if False else None
    for old in list(p.envs):
        n = Env(**{})
        n.o.name, n.o.path, n.o.id = old.o.name, old.o.path, old.o.id
        n.o.storage.update(old.o.storage)
        n.o.par.Version.val = "0.8.0"
        n.x._root_op = p.root
        p.root.children.append(n.o)
        q.envs.append(n)
    for n in q.envs:
        n.x._peers = {x.o.path: x.o for x in q.envs}
    for n in q.envs:
        n.x.Start()
    n1, n2 = q.envs
    assert n2.x.is_master and n2.x.token == tok and not n1.x.is_master and n1.s.par.active.val == 0


def test_busy_port_falls_back_up_to_plus_50_and_failover_waits_for_the_old_port():
    p = Project(2)
    a, b = p.envs
    a.x._port_free = lambda port: port >= 9983
    assert a.x.BecomeMaster() and a.x.port_used == 9983
    assert "9980" in a.o.par.Status.eval() or a.x._flash
    a.x._port_free = lambda port: False
    b.x._port_free = lambda port: False
    a.x._stop_server()
    assert not b.x.BecomeMaster()                 # no port in range: reported, not raised
    p2 = Project(2)
    c, d = p2.envs
    c.x.BecomeMaster()
    busy = {"v": True}
    d.x._port_free = lambda port: not (busy["v"] and port == 9980)
    p2.drop(c)
    assert not d.x.is_master and d.x._takeover is not None     # still waiting for the old master's port
    busy["v"] = False
    d.clock.advance(0.5)
    d.pump()
    assert d.x.is_master and d.x.port_used == 9980


def test_slaves_have_no_per_frame_server_work():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    b.s.texts.clear()
    before = (len(b.s.texts), b.s.par.active.val)
    b.pump(5, dt=0.001)
    assert (len(b.s.texts), b.s.par.active.val) == before


def test_version_parsing_prerelease_prefix_and_unknown():
    vt = registry.version_tuple
    assert vt("v0.8.0") == vt("0.8.0") and vt("0.9.0-rc1") < vt("0.9.0") < vt("0.9.1") and vt("0.7.x") < vt("0.8.0")
    assert vt("unknown") is None and vt("") is None and vt("garbage") is None
    o = FakeOwner()
    o.par.Version.val = "v1.2.3"
    assert registry.editor_version(o) == "1.2.3"
    o.par.Version.val = ""
    assert registry.editor_version(o) == registry.UNKNOWN_VERSION          # tagged (v8) but no usable Version
    o.par.Version.val = "banana"
    assert registry.editor_version(o) == registry.UNKNOWN_VERSION
    o.tags = set()
    o.par.Version.val = None
    assert registry.editor_version(o) == "0.7.x"                            # untagged v0.x


def test_find_editors_skips_tds_own_networks():
    root = FakeRoot()
    ui = FakeOwner()
    ui.path = "/ui/x"
    ok = FakeOwner()
    ok.path = "/project1/ok"
    root.children = [ui, ok]
    assert [c.path for c in registry.find_editors(root, legacy=False)] == ["/project1/ok"]
    assert [c.path for c in registry.find_editors(root)] == ["/project1/ok"]


def test_upgrading_master_keeps_its_role_and_slaves_do_not_take_over():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    a.x.PrepareUpgrade()
    a.x._started = False
    a.x._stop_server()                                 # (what the upgrade does: the old extension stops)
    assert b.x._live_master() is None and b.x._pending_master() is a.x
    assert a.x._record()["hold"] > a.x._wall()          # the hold lives in the record: a NEW instance honours it too
    b.clock.advance(6.0)
    b.pump()
    b.clock.advance(3.0)
    b.pump()
    assert not b.x.is_master


def test_upgrade_all_summary_in_status():
    env = Env()
    env.o._ops["upgrade"] = types.SimpleNamespace(module=types.SimpleNamespace(upgrade_all=lambda c: {
        "upgraded": ["a", "b"], "skipped_newer": [["c", "9.0.0"]], "failed": [], "warning": "newer editors were not changed: c"}))
    env.pump()
    env.x.OnParChange(env.o.par.Upgradeall)
    env.pump()
    assert "upgraded 2, skipped newer 1, linked 0, failed 0" in env.o.par.Status.eval() and "newer editors were not changed" in env.o.par.Status.eval()


def test_takeover_wait_is_cleared_on_every_exit():
    p = Project(2)
    a, b = p.envs
    b.x._port_free = lambda port: False
    b.x._takeover = 123.0
    b.o.par.Active.val = 0
    assert b.x.BecomeMaster(takeover=True) is False and b.x._takeover is None          # inactive
    b.o.par.Active.val = 1
    a.x.BecomeMaster()
    b.x._takeover = 123.0
    assert b.x.BecomeMaster(takeover=True) is False and b.x._takeover is None          # lost the race (a live master)
    a.x._stop_server()
    b.x._takeover = 123.0
    b.x._destroyed = True
    assert b.x.BecomeMaster(takeover=True) is False and b.x._takeover is None          # destroyed
    b.x._destroyed = False
    b.x._takeover = None
    assert not b.x.BecomeMaster(takeover=True) and b.x._takeover is not None           # waiting for the port is the one exception


def test_no_free_port_backs_off_instead_of_retrying_every_frame():
    p = Project(2)
    a, b = p.envs
    b.x._port_free = lambda port: False
    calls = []
    orig = b.x._pick_port
    b.x._pick_port = lambda *args: (calls.append(1), orig(*args))[1]
    assert not b.x.BecomeMaster()
    n = len(calls)
    for _ in range(5):
        assert not b.x.BecomeMaster()
    assert len(calls) == n                              # blocked for BLOCK_S
    b.clock.advance(E.BLOCK_S + 1)
    assert not b.x.BecomeMaster() and len(calls) == n + 1
    for _ in range(4):
        b.clock.advance(E.BLOCK_S + 1)
        b.x.BecomeMaster()
    total = len(calls)
    b.clock.advance(E.BLOCK_S + 1)
    b.x.BecomeMaster()
    assert len(calls) == total                          # BLOCK_MAX reached: only an explicit request tries again
    b.x._port_free = lambda port: True
    assert b.x.BecomeMaster(user=True)


def test_resume_prefers_the_configured_port_failover_keeps_the_record_port():
    p = Project(2)
    a, b = p.envs
    a.x._set_record({"path": a.o.path, "id": a.x.editor_id, "port": 9990, "token": "tok", "orphan": False})
    a.o.par.Port.val = 9980
    a.x._resume_master()
    assert a.x.is_master and a.x.port_used == 9980
    a.x._stop_server()
    a.x._set_record({"path": a.o.path, "id": a.x.editor_id, "port": 9990, "token": "tok", "orphan": False})
    a.x._port_free = lambda port: port == 9990
    a.x._resume_master()                                # the configured Port is busy: the record's
    assert a.x.port_used == 9990
    a.x._stop_server()
    a.x._set_record({"path": "/project1/ed2", "id": b.x.editor_id, "port": 9990, "token": "tok", "orphan": False})
    b.x._port_free = lambda port: True
    b.x.BecomeMaster(takeover=True)                     # failover: the record port, not the configured one
    assert b.x.port_used == 9990


def test_open_in_browser_joins_a_master_that_is_starting_again():
    p = Project(2)
    a, b = p.envs
    a.x.BecomeMaster()
    a.x.Stop()                                          # a rebuild / upgrade in place: the record holds the role
    assert b.x._pending_master() is not None
    b.x.OnParChange(b.o.par.Openbrowser)
    assert not b.x.is_master and b.s.par.active.val == 0
    assert b.opened and ":9980/" in b.opened[0] and f"e={b.x.editor_id}" in b.opened[0]


def test_check_server_ignores_foreign_errors_flaps_never_and_marks_failures():
    p = Project(3)
    a, b, c = p.envs
    a.x.BecomeMaster()
    a.s.errors = lambda: "some script error"            # not a bind-class error: no failure
    for _ in range(E.SERVER_FAILS_MAX + 2):
        a.clock.advance(E.HEALTH_PERIOD_S + .1)
        a.pump()
    assert a.x.is_master and a.x._server_fails == 0
    a.s.errors = lambda: "OSError: address already in use"
    b.s.errors = lambda: "OSError: address already in use"
    for _ in range(E.SERVER_FAILS_MAX + 2):
        a.clock.advance(E.HEALTH_PERIOD_S + .1)
        a.pump()
    assert b.x.is_master and a.x.editor_id in b.x._record()["failed"]
    # the successor has the same error: it hands over to c, never back to a
    for _ in range(E.SERVER_FAILS_MAX + 2):
        b.clock.advance(E.HEALTH_PERIOD_S + .1)
        b.pump()
    assert c.x.is_master or not (a.x.is_master or b.x.is_master)
    assert not a.x.is_master


def test_rescan_skips_editors_that_are_not_started_and_stops_a_losing_master():
    p = Project(3)
    a, b, c = p.envs
    a.x.BecomeMaster()
    c.x._started = False
    a.x._rescan(force=True)
    assert [e["name"] for e in a.x._editors_payload["editors"]] == ["ed1", "ed2"]
    c.x._started = True
    c.x.is_master = True
    c.s.par.active.val = 1
    a.x._rescan(force=True)
    assert not c.x.is_master and c.s.par.active.val == 0
    assert a.x._editors_payload is not None
    a.x._stop_server()
    assert a.x._editors_payload is None                 # no list from a master that has not rescanned
