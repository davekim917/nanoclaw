#!/usr/bin/env python3
import base64
import http.server
import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
api = importlib.import_module("smoke_lane_api")

RUN_ID = "acme-pr-pr7-0123456789ab-20260101T000000Z"
PREFIX = "QA-{}-".format(RUN_ID)
SCOPE = {"mode": "deny", "tenants": ["sandbox", "playground"],
         "authPaths": ["/users/login", "/users/refresh"], "readOnlyPosts": ["/widgets/search"],
         "denyPaths": ["/ledger/close", "/widgets/[^/]+/broadcast"], "denyPrefixes": ["/media", "/profile/photo/"]}
SEAT_TENANTS = {"m@example.test": {"tenantId": "sandbox"}, "g@example.test": {"tenantId": "globex"},
                "n@example.test": {"sub": "9"}, "w@example.test": {"tenantId": "sandbox", "tenant_id": "globex"}}


def token_for(claims):
    raw = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return "h.{}.s".format(raw)


class Backend(http.server.BaseHTTPRequestHandler):
    seen = []
    store = {}

    def log_message(self, format, *args):
        pass

    def reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Backend.seen.append((self.command, self.path, body))
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/elsewhere")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/users/login"):
            out = {"access_token": token_for(SEAT_TENANTS[(body or {}).get("email")])}
        elif self.command == "POST":
            new_id = "fx-{}".format(900 + len(Backend.store))
            Backend.store["{}/{}".format(self.path, new_id)] = dict(body or {}, id=new_id)
            out = {"owner": {"id": 191}, "report": {"id": new_id}}
        elif self.command == "GET" and self.path in Backend.store:
            stored = Backend.store[self.path]
            out = stored if self.path.startswith("/bare/") else {"data": stored}
        else:
            out = {"ok": True}
        raw = json.dumps(out).encode()
        self.send_response(201 if self.command == "POST" else 200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = reply


class Guard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:{}".format(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Backend.seen.clear()
        Backend.store.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.run_dir = os.path.join(self.tmp.name, RUN_ID)
        os.makedirs(self.run_dir)
        self.helper = os.path.join(self.tmp.name, "pw.sh")
        with open(self.helper, "w") as f:
            f.write('[ "$1" = held@example.test ] && exit 69\necho fictional-pw\n')

    def tearDown(self):
        self.tmp.cleanup()

    def pin(self, scope=None):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE if scope is None else scope, f)
        return api.init_scope(self.run_dir, src)

    def client(self, *login):
        h = api.H(os.path.join(self.run_dir, "lanes", "l1"), run_dir=self.run_dir, base=self.base,
                  seats={"M": "m@example.test", "X": "held@example.test", "G": "g@example.test",
                         "N": "n@example.test", "W": "w@example.test"}, password_helper=self.helper)
        for seat in login:
            h.login(seat)
        return h

    def ledger(self):
        path = os.path.join(self.run_dir, api.LEDGER_FILE)
        if not os.path.exists(path):
            return set()
        with open(path) as f:
            return {"{}/{}".format(r["path"], r["id"]) for r in map(json.loads, f)}

    def assert_blocked(self, h, tag, method, path, body, reason, seat="M"):
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, seat, method, path, body)
        self.assertIn(reason, str(ctx.exception))
        self.assertEqual(len(Backend.seen), before, "a refused write must send nothing")
        with open(os.path.join(h.out, tag + ".json")) as f:
            rec = json.load(f)
        self.assertTrue(rec["harnessBlocked"])
        self.assertEqual(rec["refusal"], "WRITE_SCOPE_REFUSED")
        self.assertNotIn("status", rec, "a refusal must never look like a product response")
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            self.assertIn("[{}] {} {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED".format(tag, seat, method, path), f.read())

    def assert_sent(self, h, tag, method, path, body=None, seat="M"):
        before = len(Backend.seen)
        code, _ = h.call(tag, seat, method, path, body)
        self.assertIn(code, (200, 201))
        self.assertEqual(len(Backend.seen), before + 1)

    def test_no_scope_refuses_writes_but_not_reads(self):
        h = self.client()
        self.assertEqual(h.call("r1", "M", "GET", "/widgets/5")[0], 200)
        self.assert_blocked(h, "w1", "POST", "/notes", {"title": PREFIX + "a"}, "no-scope")
        with self.assertRaises(api.WriteScopeRefused):
            h.login("M")
        self.assertEqual([s[0] for s in Backend.seen], ["GET"])

    def test_login_needs_the_auth_exemption(self):
        self.pin(dict(SCOPE, authPaths=[]))
        with self.assertRaises(api.WriteScopeRefused):
            self.client().login("M")
        self.assertEqual(Backend.seen, [])
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.pin()
        h = self.client()
        self.assertEqual(h.login("M"), 201)
        self.assertEqual(Backend.seen[0][:2], ("POST", "/users/login"))
        self.assertIn("M", h.tok)

    def test_refused_login_evidence_holds_no_password(self):
        self.pin()
        scope = os.path.join(self.run_dir, api.SCOPE_FILE)
        with open(self.helper, "w") as f:
            f.write('rm -f "%s"\necho fictional-pw\n' % scope)
        h = self.client()
        with self.assertRaises(api.WriteScopeRefused):
            h.login("M")
        self.assertEqual(Backend.seen, [])
        with open(os.path.join(h.out, "login-M.json")) as f:
            saved = f.read()
        self.assertNotIn("fictional-pw", saved)
        self.assertIn("<redacted>", saved)

    def test_seat_lease_refusal_sends_no_login(self):
        self.pin()
        with self.assertRaises(SystemExit):
            self.client().login("X")
        self.assertEqual(Backend.seen, [])

    def test_ordinary_writes_in_a_scoped_tenant_go(self):
        self.pin()
        h = self.client("M")
        self.assert_sent(h, "o1", "POST", "/notes", {"body": "any note"})
        self.assert_sent(h, "o2", "PATCH", "/cards/4402", {"stage": "b"})
        self.assert_sent(h, "o3", "DELETE", "/users/4401")
        self.assert_sent(h, "o4", "PUT", "/widgets/7/settings", {"tenantId": "sandbox"})
        self.assert_sent(h, "o5", "POST", "/jobs", {"kind": "one-off"})
        self.assert_sent(h, "o6", "POST", "/mediakit/items", {"k": 1})
        self.assertEqual(self.ledger(), set(), "writes never ledger on their own")

    def test_deny_paths_refused_whatever_the_spelling(self):
        self.pin()
        h = self.client("M")
        for i, path in enumerate(("/ledger/close", "/Ledger/CLOSE", "/ledger/close/", "/ledger//close",
                                  "/ledger/%63lose", "/ledger/close?dryRun=false", "/widgets/9/broadcast")):
            self.assert_blocked(h, "d%d" % i, "POST", path, {"k": 1}, "denied-path rule=denyPaths")
        self.assert_blocked(h, "d-del", "DELETE", "/ledger/close", None, "denied-path")
        self.assert_blocked(h, "d-dot", "POST", "/ledger/x/../close", None, "bad-path")
        self.assert_sent(h, "d-near", "POST", "/ledger/close-preview", {"k": 1})

    def test_deny_prefixes_refuse_every_write_method_but_not_reads(self):
        self.pin()
        h = self.client("M")
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            for path in ("/media", "/media/5", "/MEDIA/5/thumb/", "/profile/photo/upload"):
                self.assert_blocked(h, "p-{}-{}".format(method, len(Backend.seen)) + path.replace("/", "_"),
                                    method, path, {"k": 1}, "denied-path rule=denyPrefixes")
        self.assert_sent(h, "p-get", "GET", "/media/5")
        self.assert_sent(h, "p-sibling", "PATCH", "/profile/settings", {"k": 1})
        self.assert_sent(h, "p-seg", "POST", "/media-library", {"k": 1})

    def test_a_new_tenant_wide_route_is_refused_by_shape(self):
        self.pin()
        h = self.client("M")
        for i, path in enumerate(("/forecasts/nightly-resync", "/catalog/Rebuild", "/orders/archive",
                                  "/stats/reindex/all", "/history/backfill", "/admin/cron/trigger",
                                  "/budget/publishDraft", "/reports/jobs/run", "/imports/jobs/77/run",
                                  "/cache/refresh-all")):
            self.assertFalse(api.denied(api.load_scope(self.run_dir), api.route_of(path)), "not an exact rule")
            self.assert_blocked(h, "s%d" % i, "POST", path, {"k": 1}, "tenant-wide-shape")
        self.assert_blocked(h, "s-patch", "PATCH", "/users/refresh", {"k": 1}, "tenant-wide-shape")
        self.assert_sent(h, "s-auth", "POST", "/users/refresh", {"k": 1})
        self.assert_sent(h, "s-runner", "POST", "/runners/7/rerun-notes", {"k": 1})

    def test_explicit_deny_beats_exemptions(self):
        self.pin(dict(SCOPE, readOnlyPosts=["/media/search"], authPaths=["/ledger/close"]))
        h = self.client()
        self.assert_blocked(h, "e1", "POST", "/media/search", {"q": 1}, "denyPrefixes")
        self.assert_blocked(h, "e2", "POST", "/ledger/close", None, "denyPaths")

    def test_writes_outside_the_scoped_tenants_refused(self):
        self.pin()
        h = self.client("M", "G", "N", "W")
        self.assert_blocked(h, "t1", "POST", "/notes", {"k": 1}, "foreign-tenant seat-tenant=globex", seat="G")
        self.assert_blocked(h, "t2", "POST", "/notes", {"k": 1}, "foreign-tenant seat-tenant=globex", seat="W")
        self.assert_blocked(h, "t3", "POST", "/notes", {"k": 1}, "no-tenant", seat="N")
        self.assert_blocked(h, "t4", "POST", "/notes", {"k": 1}, "no-tenant", seat="X")
        self.assert_blocked(h, "t5", "POST", "/notes", {"tenantId": "globex"}, "foreign-tenant targets=tenantId=globex")
        self.assert_blocked(h, "t6", "POST", "/notes?tenant=globex", {"k": 1}, "foreign-tenant")
        self.assert_blocked(h, "t7", "POST", "/notes", {"meta": {"tenant_id": "globex"}}, "foreign-tenant")
        for i, empty in enumerate((None, [], [None], "")):
            self.assert_blocked(h, "t8e%d" % i, "POST", "/notes", {"tenantId": empty}, "foreign-tenant")
        self.assert_blocked(h, "t9", "POST", "/notes", {"tenants": ["sandbox", "globex"]}, "foreign-tenant")
        self.assert_sent(h, "t10", "POST", "/notes", {"tenants": ["sandbox", "playground"]})
        self.assertEqual(h.call("t11", "G", "GET", "/notes")[0], 200, "reads go from any seat")
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused):
            h.req("DELETE", "/users/4401")
        self.assertEqual(len(Backend.seen), before, "the client's own send method is guarded too")
        self.assert_blocked(h, "t12", "POST", "//4401/cards", {"k": 1}, "bad-path")
        with self.assertRaises(api.WriteScopeRefused):
            h.call("t13", "M", "GET", "relative/path")
        self.assertEqual(len(Backend.seen), before, "a malformed path is refused even for a read")

    def test_redirects_are_not_followed(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("r1", "M", "GET", "/redirect")[0], 302)
        self.assertEqual([p for _, p, _ in Backend.seen], ["/redirect"], "a redirect is reported, never followed")

    def test_read_only_post_is_an_explicit_list(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("q1", "M", "POST", "/widgets/search", {"markets": ["M1"]})[0], 201)
        self.assert_blocked(h, "q2", "POST", "/widgets/search/save", {"markets": ["M1"]}, "no-tenant")

    def test_own_ledgers_only_a_verified_readback(self):
        self.pin()
        h = self.client("M")
        name = PREFIX + "coord-r1"
        code, js = h.call("c1", "M", "POST", "/reports", {"name": name, "segmentId": 81})
        self.assertEqual(code, 201)
        self.assertEqual(self.ledger(), set(), "a create response is never parsed for ownership")
        h.own("c3", "M", "/reports", js["report"]["id"], name)
        self.assertEqual(self.ledger(), {"/reports/" + js["report"]["id"]})
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c7", "M", "/reports", 191, name)
        self.assertIn("unverified-fixture", str(ctx.exception), "the owner id in the response is not the object")
        Backend.store["/accounts/4401"] = {"id": 4401, "name": "Existing client", "notes": [{"name": name}]}
        with self.assertRaises(api.WriteScopeRefused):
            h.own("c8", "M", "/accounts", 4401, name)
        Backend.store["/bare/4403"] = {"id": 4403, "name": "Existing", "report": {"id": 4403, "name": name}}
        Backend.store["/bare/4404"] = {"id": 4404, "name": "Existing", "data": {"id": 4404, "name": name}}
        for acct in (4403, 4404):
            with self.assertRaises(api.WriteScopeRefused):
                h.own("c8e%d" % acct, "M", "/bare", acct, name)
        Backend.store["/accounts/4402"] = {"id": "fx-777", "name": name}
        with self.assertRaises(api.WriteScopeRefused):
            h.own("c8b", "M", "/accounts", 4402, name)
        quoted = PREFIX + 'say "hi"'
        _, qjs = h.call("c8q", "M", "POST", "/reports", {"name": quoted})
        h.own("c8r", "M", "/reports", qjs["report"]["id"], quoted)
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c9", "M", "/reports", js["report"]["id"], PREFIX)
        self.assertIn("not-a-qa-name", str(ctx.exception))
        self.assertEqual(len(Backend.seen), before, "a bad name is refused before any read")
        self.assertEqual(len(self.ledger()), 2)
        with open(os.path.join(h.out, "c7-own.json")) as f:
            self.assertTrue(json.load(f)["harnessBlocked"])

    def test_evidence_holds_no_secrets(self):
        self.pin()
        h = self.client()
        with self.assertRaises(api.WriteScopeRefused):
            h.call("s1", "M", "POST", "/notes?access_token=FICTIONAL-TOKEN&x=1", {"k": 1})
        h.call("s2", "M", "POST", "/users/login", {"email": "m@example.test", "password": "fictional-pw"})
        h.login("M")
        with self.assertRaises(api.WriteScopeRefused):
            h.call("s3", "M", "POST", "/media", {"meta": {"access_token": "FICTIONAL-TOKEN"}})
        issued = h.tok["M"].split(".")[1]
        for f in ("s1.json", "s2.json", "s3.json", "00-timeline.txt"):
            with open(os.path.join(h.out, f)) as fh:
                text = fh.read()
            for secret in ("FICTIONAL-TOKEN", "fictional-pw", issued):
                self.assertNotIn(secret, text, "{} leaks {}".format(f, secret))

    def test_scope_from_another_run_refused(self):
        self.pin()
        other = os.path.join(self.tmp.name, "acme-pr-pr8-0123456789ab-20260102T000000Z")
        os.makedirs(other)
        os.rename(os.path.join(self.run_dir, api.SCOPE_FILE), os.path.join(other, api.SCOPE_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(other, "POST", "/notes", {"k": 1}, ["sandbox"])
        self.assertIn("scope-run-mismatch", str(ctx.exception))

    def test_unreadable_or_allowlist_scope_refuses(self):
        path = os.path.join(self.run_dir, api.SCOPE_FILE)
        with open(path, "w") as f:
            f.write("{")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "PUT", "/x", None, ["sandbox"])
        self.assertIn("unreadable-scope", str(ctx.exception))
        legacy = {k: v for k, v in SCOPE.items() if k != "mode"}
        with open(path, "w") as f:
            json.dump(dict(legacy, accounts=[], brands=[], runId=RUN_ID), f)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "PUT", "/x", None, ["sandbox"])
        self.assertIn("mode must be", str(ctx.exception), "an allowlist-era scope file fails closed")
        os.unlink(path)
        with self.assertRaises(ValueError):
            self.pin(legacy)
        with self.assertRaises(ValueError):
            self.pin(dict(SCOPE, denyPrefixes=["/"]))
        self.pin()
        real = os.path.join(self.tmp.name, "scope-copy.json")
        os.rename(path, real)
        os.symlink(real, path)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/notes", {"k": 1}, ["sandbox"])
        self.assertIn("no-scope", str(ctx.exception), "a symlinked scope is refused, not followed")

    def test_cli(self):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE, f)
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
        missing = run("check", self.run_dir, "POST", "/notes", "--tenant", "sandbox")
        self.assertEqual(missing.returncode, 77, "a missing scope file refuses through the CLI too")
        self.assertIn("no-scope", missing.stderr)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 0)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 3, "the scope is pinned once")
        ok = run("check", self.run_dir, "PATCH", "/cards/4402", "--body", '{"stage": "b"}', "--tenant", "sandbox")
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        flipped = run("check", self.run_dir, "PATCH", "/cards/4402", "--tenant", "sandbox", "--body", "{}")
        self.assertEqual(flipped.returncode, 0)
        for args, reason in ((("POST", "/notes"), "no-tenant"),
                             (("POST", "/notes", "--tenant", "globex"), "foreign-tenant"),
                             (("DELETE", "/media/5", "--tenant", "sandbox"), "denied-path"),
                             (("POST", "/stock/resync", "--tenant", "sandbox"), "tenant-wide-shape"),
                             (("POST", "//4401/cards", "--tenant", "sandbox"), "bad-path")):
            no = run("check", self.run_dir, *args)
            self.assertEqual(no.returncode, 77, args)
            self.assertTrue(no.stderr.startswith("WRITE_SCOPE_REFUSED reason="), no.stderr)
            self.assertIn(reason, no.stderr)
        self.assertEqual(run("check", self.run_dir, "POST", "/notes", "--tenants", "sandbox").returncode, 2)
        self.assertEqual(run("check", self.run_dir, "POST", "/notes", "--tenant").returncode, 2)
        with open(src, "w") as f:
            json.dump(dict(SCOPE, readOnlyPosts=["("]), f)
        self.assertEqual(run("init", os.path.join(self.tmp.name, "fresh"), "--from", src).returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
