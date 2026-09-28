#!/usr/bin/env python3
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
SCOPE = {"tenants": [], "brands": [], "accounts": [],
         "authPaths": ["/users/login"], "readOnlyPosts": ["/widgets/search"]}


class Backend(http.server.BaseHTTPRequestHandler):
    seen = []
    store = {}

    def log_message(self, format, *args):
        pass

    def reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Backend.seen.append((self.command, self.path, body))
        if self.path.startswith("/users/login"):
            out = {"access_token": "h.eyJzdWIiOiAiMSJ9.s"}
        elif self.command == "POST":
            new_id = "fx-{}".format(900 + len(Backend.store))
            Backend.store["{}/{}".format(self.path, new_id)] = dict(body or {}, id=new_id)
            out = {"owner": {"id": 191}, "report": {"id": new_id}}
        elif self.command == "GET" and self.path in Backend.store:
            out = {"data": Backend.store[self.path]}
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

    def client(self):
        return api.H(os.path.join(self.run_dir, "lanes", "l1"), run_dir=self.run_dir, base=self.base,
                     seats={"M": "m@example.test", "X": "held@example.test"}, password_helper=self.helper)

    def assert_blocked(self, h, tag, method, path, body, reason):
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, "M", method, path, body)
        self.assertIn(reason, str(ctx.exception))
        self.assertEqual(len(Backend.seen), before, "a refused write must send nothing")
        with open(os.path.join(h.out, tag + ".json")) as f:
            rec = json.load(f)
        self.assertTrue(rec["harnessBlocked"])
        self.assertEqual(rec["refusal"], "WRITE_SCOPE_REFUSED")
        self.assertNotIn("status", rec, "a refusal must never look like a product response")
        with open(os.path.join(h.out, "00-timeline.txt")) as f:
            self.assertIn("[{}] M {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED".format(tag, method, path), f.read())

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

    def test_foreign_and_targetless_writes_refused(self):
        self.pin()
        h = self.client()
        self.assert_blocked(h, "w1", "POST", "/audits/jobs", {"accountId": "4401", "kind": "x"}, "foreign-target")
        self.assert_blocked(h, "w2", "PATCH", "/cards/4402", {"stage": "b"}, "foreign-target")
        self.assert_blocked(h, "w4", "POST", "/sync/run", {"module": "all"}, "no-qa-target")
        self.assert_blocked(h, "w5", "POST", "/notes?tenant=globex", {"title": PREFIX + "n"}, "foreign-target")
        self.assert_blocked(h, "w6", "POST", "/notes", {"title": PREFIX + "n", "brand_id": 3}, "foreign-target")
        self.assert_blocked(h, "w7", "POST", "/notes", {"title": "QA-other-run-n"}, "no-qa-target")
        self.assert_blocked(h, "w8", "POST", "/budget/save", {"meta": {"name": PREFIX + "n"}}, "no-qa-target")
        self.assert_blocked(h, "w9", "PATCH", "/notes", {"name": PREFIX + "n"}, "no-qa-target")
        self.assert_blocked(h, "w10", "POST", "/notes", {"name": PREFIX + "n", "account": {"id": 4401}}, "foreign-target")
        self.assert_blocked(h, "w11", "POST", "/notes", {"name": PREFIX + "n", "accounts": [{"ref": 1}]}, "foreign-target")
        self.assert_blocked(h, "w12", "POST", "/notes?accountId=", {"name": PREFIX + "n"}, "foreign-target")
        for i, empty in enumerate((None, [], [None])):
            self.assert_blocked(h, "w12e%d" % i, "POST", "/notes", {"name": PREFIX + "n", "accountId": empty}, "foreign-target")
        self.assert_blocked(h, "w13", "POST", "/reports/v12", {"name": PREFIX + "n"}, "foreign-target")
        self.assert_blocked(h, "w13b", "POST", "/v4401/notes", {"name": PREFIX + "n"}, "foreign-target")
        self.assertEqual(h.call("w14", "M", "POST", "/v1/notes", {"name": PREFIX + "n"})[0], 201)
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused):
            h.req("DELETE", "/users/4401")
        self.assertEqual(len(Backend.seen), before, "the client's own send method is guarded too")

    def test_read_only_post_is_an_explicit_list(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("q1", "M", "POST", "/widgets/search", {"markets": ["M1"]})[0], 201)
        self.assert_blocked(h, "q2", "POST", "/widgets/search/save", {"markets": ["M1"]}, "no-qa-target")

    def test_ownership_needs_a_verified_readback(self):
        self.pin()
        h = self.client()
        name = PREFIX + "coord-r1"
        code, js = h.call("c1", "M", "POST", "/reports", {"name": name, "segmentId": 81})
        self.assertEqual(code, 201)
        self.assertEqual(api.ledger_ids(self.run_dir), set(), "a create response is never parsed for ownership")
        self.assert_blocked(h, "c2", "PATCH", "/reports/" + js["report"]["id"], {"slot": 2}, "foreign-target")
        h.own("c3", "M", "/reports", js["report"]["id"], name)
        self.assertEqual(api.ledger_ids(self.run_dir), {"/reports/" + js["report"]["id"]})
        self.assertEqual(h.call("c4", "M", "PATCH", "/reports/" + js["report"]["id"], {"slot": 2})[0], 200)
        self.assertEqual(h.call("c5", "M", "DELETE", "/reports/" + js["report"]["id"])[0], 200)
        self.assert_blocked(h, "c6", "PATCH", "/users/" + js["report"]["id"], {"role": "admin"}, "foreign-target")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c7", "M", "/reports", 191, name)
        self.assertIn("unverified-fixture", str(ctx.exception), "the owner id in the response is not the object")
        Backend.store["/accounts/4401"] = {"id": 4401, "name": "Existing client", "notes": [{"name": name}]}
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.own("c8", "M", "/accounts", 4401, name)
        self.assertIn("unverified-fixture", str(ctx.exception), "a QA-named child does not make its parent ours")
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
        self.assertEqual(len(api.ledger_ids(self.run_dir)), 2)
        with open(os.path.join(h.out, "c7-own.json")) as f:
            self.assertTrue(json.load(f)["harnessBlocked"])

    def test_evidence_holds_no_secrets(self):
        self.pin()
        h = self.client()
        with self.assertRaises(api.WriteScopeRefused):
            h.call("s1", "M", "POST", "/notes?access_token=FICTIONAL-TOKEN&x=1", {"k": 1})
        h.call("s2", "M", "POST", "/users/login", {"email": "m@example.test", "password": "fictional-pw"})
        for f in ("s1.json", "s2.json", "00-timeline.txt"):
            with open(os.path.join(h.out, f)) as fh:
                text = fh.read()
            for secret in ("FICTIONAL-TOKEN", "fictional-pw", "eyJzdWIiOiAiMSJ9"):
                self.assertNotIn(secret, text, "{} leaks {}".format(f, secret))

    def test_allowlisted_account_is_writable(self):
        self.pin(dict(SCOPE, accounts=["7001"]))
        h = self.client()
        self.assertEqual(h.call("a1", "M", "POST", "/cards", {"accountId": 7001})[0], 201)
        self.assert_blocked(h, "a2", "DELETE", "/users/7001", None, "foreign-target")
        self.assertEqual(api.ledger_ids(self.run_dir), set(), "writes never ledger on their own")

    def test_scope_from_another_run_refused(self):
        self.pin()
        other = os.path.join(self.tmp.name, "acme-pr-pr8-0123456789ab-20260102T000000Z")
        os.makedirs(other)
        os.rename(os.path.join(self.run_dir, api.SCOPE_FILE), os.path.join(other, api.SCOPE_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(other, "POST", "/notes", {"title": PREFIX + "x"})
        self.assertIn("scope-run-mismatch", str(ctx.exception))

    def test_unreadable_scope_and_ledger_refuse(self):
        with open(os.path.join(self.run_dir, api.SCOPE_FILE), "w") as f:
            f.write("{")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "PUT", "/x", None)
        self.assertIn("unreadable-scope", str(ctx.exception))
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        self.pin()
        real = os.path.join(self.tmp.name, "scope-copy.json")
        os.rename(os.path.join(self.run_dir, api.SCOPE_FILE), real)
        os.symlink(real, os.path.join(self.run_dir, api.SCOPE_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/notes", {"name": PREFIX + "n"})
        self.assertIn("no-scope", str(ctx.exception), "a symlinked scope is refused, not followed")
        os.unlink(os.path.join(self.run_dir, api.SCOPE_FILE))
        os.rename(real, os.path.join(self.run_dir, api.SCOPE_FILE))
        with open(os.path.join(self.run_dir, api.LEDGER_FILE), "w") as f:
            f.write("not json\n")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "DELETE", "/reports/fx-901", None)
        self.assertIn("unreadable-ledger", str(ctx.exception))
        os.unlink(os.path.join(self.run_dir, api.LEDGER_FILE))
        elsewhere = os.path.join(self.tmp.name, "other-ledger.ndjson")
        with open(elsewhere, "w") as f:
            f.write(json.dumps({"id": "x1", "path": "/reports"}) + "\n")
        os.symlink(elsewhere, os.path.join(self.run_dir, api.LEDGER_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run_dir, "POST", "/notes", {"name": PREFIX + "n"})
        self.assertIn("unreadable-ledger", str(ctx.exception), "a symlinked ledger is refused, not followed")

    def test_cli(self):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE, f)
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 0)
        self.assertEqual(run("init", self.run_dir, "--from", src).returncode, 3, "the scope is pinned once")
        ok = run("check", self.run_dir, "POST", "/notes", "--body", json.dumps({"title": PREFIX + "x"}))
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        no = run("check", self.run_dir, "POST", "/cards", "--body", '{"accountId": 4401}')
        self.assertEqual(no.returncode, 77)
        self.assertIn("WRITE_SCOPE_REFUSED reason=foreign-target", no.stderr)
        with open(src, "w") as f:
            json.dump(dict(SCOPE, readOnlyPosts=["("]), f)
        self.assertEqual(run("init", os.path.join(self.tmp.name, "fresh"), "--from", src).returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
