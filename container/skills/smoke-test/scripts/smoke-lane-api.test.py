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

    def log_message(self, *a):
        pass

    def reply(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        Backend.seen.append((self.command, self.path, body))
        out = {"access_token": "h.eyJzdWIiOiAiMSJ9.s"} if self.path == "/users/login" else (
            {"owner": {"id": 191}, "report": {"id": "rp-77", "filename": PREFIX + "f.pdf"}} if self.path == "/reports/nested" else (
            {"owner": {"id": 192}} if self.path == "/reports/anon" else {"id": "fx-901", "ok": True}))
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
        self.tmp = tempfile.TemporaryDirectory()
        self.run = os.path.join(self.tmp.name, RUN_ID)
        os.makedirs(self.run)
        self.helper = os.path.join(self.tmp.name, "pw.sh")
        with open(self.helper, "w") as f:
            f.write('[ "$1" = held@example.test ] && exit 69\necho fictional-pw\n')

    def tearDown(self):
        self.tmp.cleanup()

    def pin(self, scope=None):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE if scope is None else scope, f)
        return api.init_scope(self.run, src)

    def client(self):
        return api.H(os.path.join(self.run, "lanes", "l1"), run_dir=self.run, base=self.base,
                     seats={"M": "m@example.test", "X": "held@example.test"}, password_helper=self.helper)

    def assert_blocked(self, h, tag, method, path, body, reason):
        before = len(Backend.seen)
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            h.call(tag, "M", method, path, body)
        self.assertIn(reason, ctx.exception.reason)
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
        os.unlink(os.path.join(self.run, api.SCOPE_FILE))
        self.pin()
        h = self.client()
        self.assertEqual(h.login("M"), 201)
        self.assertEqual(Backend.seen[0][:2], ("POST", "/users/login"))
        self.assertIn("M", h.tok)

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
        self.assert_blocked(h, "w3", "DELETE", "/cards/4402", None, "foreign-target")
        self.assert_blocked(h, "w4", "POST", "/sync/run", {"module": "all"}, "no-qa-target")
        self.assert_blocked(h, "w5", "POST", "/notes?tenant=globex", {"title": PREFIX + "n"}, "foreign-target")
        self.assert_blocked(h, "w6", "POST", "/notes", {"title": PREFIX + "n", "brand_id": 3}, "foreign-target")
        self.assert_blocked(h, "w7", "POST", "/notes", {"title": "QA-other-run-n"}, "no-qa-target")

    def test_read_only_post_is_an_explicit_list(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("q1", "M", "POST", "/widgets/search", {"markets": ["M1"]})[0], 201)
        self.assert_blocked(h, "q2", "POST", "/widgets/search/save", {"markets": ["M1"]}, "no-qa-target")

    def test_qa_named_create_ledgers_its_id(self):
        self.pin()
        h = self.client()
        self.assertEqual(h.call("c1", "M", "POST", "/reports", {"name": PREFIX + "coord-r1", "segmentId": 81})[0], 201)
        self.assertEqual(api.ledger_ids(self.run), {"fx-901"})
        self.assertEqual(h.call("c2", "M", "PATCH", "/reports/fx-901", {"slot": 2})[0], 200)
        self.assertEqual(h.call("c3", "M", "DELETE", "/reports/fx-901")[0], 200)
        self.assert_blocked(h, "c4", "DELETE", "/reports/fx-902", None, "foreign-target")
        self.assertEqual(h.call("c5", "M", "POST", "/reports/nested", {"filename": PREFIX + "f.pdf"})[0], 201)
        self.assertEqual(api.ledger_ids(self.run), {"fx-901", "rp-77"}, "the named object's id, not its owner's")
        h.call("c6", "M", "POST", "/reports/anon", {"name": PREFIX + "anon"})
        self.assertNotIn("192", api.ledger_ids(self.run), "a nested id that is not the named object stays foreign")

    def test_allowlisted_account_is_writable(self):
        self.pin(dict(SCOPE, accounts=["7001"]))
        h = self.client()
        self.assertEqual(h.call("a1", "M", "POST", "/cards", {"accountId": 7001})[0], 201)
        self.assertEqual(api.ledger_ids(self.run), set(), "only QA-named creates are ledgered")

    def test_scope_from_another_run_refused(self):
        self.pin()
        other = os.path.join(self.tmp.name, "acme-pr-pr8-0123456789ab-20260102T000000Z")
        os.makedirs(other)
        os.rename(os.path.join(self.run, api.SCOPE_FILE), os.path.join(other, api.SCOPE_FILE))
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(other, "POST", "/notes", {"title": PREFIX + "x"})
        self.assertIn("scope-run-mismatch", ctx.exception.reason)

    def test_unreadable_scope_and_ledger_refuse(self):
        with open(os.path.join(self.run, api.SCOPE_FILE), "w") as f:
            f.write("{")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run, "PUT", "/x", None)
        self.assertIn("unreadable-scope", ctx.exception.reason)
        os.unlink(os.path.join(self.run, api.SCOPE_FILE))
        self.pin()
        with open(os.path.join(self.run, api.LEDGER_FILE), "w") as f:
            f.write("not json\n")
        with self.assertRaises(api.WriteScopeRefused) as ctx:
            api.judge(self.run, "DELETE", "/reports/fx-901", None)
        self.assertIn("unreadable-ledger", ctx.exception.reason)

    def test_cli(self):
        src = os.path.join(self.tmp.name, "scope.json")
        with open(src, "w") as f:
            json.dump(SCOPE, f)
        cli = [sys.executable, os.path.join(HERE, "smoke_lane_api.py")]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        run = lambda *a: subprocess.run(cli + list(a), capture_output=True, text=True, env=env)
        self.assertEqual(run("init", self.run, "--from", src).returncode, 0)
        self.assertEqual(run("init", self.run, "--from", src).returncode, 3, "the scope is pinned once")
        with open(os.path.join(self.run, api.SCOPE_FILE)) as f:
            self.assertEqual(json.load(f)["fixturePrefix"], PREFIX)
        ok = run("check", self.run, "POST", "/notes", "--body", json.dumps({"title": PREFIX + "x"}))
        self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "write"))
        no = run("check", self.run, "POST", "/cards", "--body", '{"accountId": 4401}')
        self.assertEqual(no.returncode, 77)
        self.assertIn("WRITE_SCOPE_REFUSED reason=foreign-target", no.stderr)
        with open(src, "w") as f:
            json.dump(dict(SCOPE, readOnlyPosts=["("]), f)
        self.assertEqual(run("init", os.path.join(self.tmp.name, "fresh"), "--from", src).returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
