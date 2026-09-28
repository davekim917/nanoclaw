#!/usr/bin/env python3
import base64
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USAGE = """usage:
  smoke_lane_api.py init  <run-dir> --from <scope.json>
  smoke_lane_api.py check <run-dir> <METHOD> <path> [--body <json>]"""

REFUSED = 77
SCOPE_FILE = "write-scope.json"
LEDGER_FILE = "write-scope-fixtures.ndjson"
READ_METHODS = {"GET", "HEAD", "OPTIONS"}
SCOPE_LISTS = ("tenants", "brands", "accounts", "authPaths", "readOnlyPosts")
TARGET_KEYS = {
    "accounts": {"accountid", "accountids", "account", "accounts"},
    "tenants": {"tenantid", "tenantids", "tenant", "tenants"},
    "brands": {"brandid", "brandids", "brand", "brands"},
}
NAME_KEYS = {"name", "title", "label", "filename"}
ID_SEGMENT = re.compile(r".*\d.*")
VERSION_SEGMENT = re.compile(r"v\d+")
PASSWORD_HELPER = "/workspace/extra/qa-seat-password.sh"


class WriteScopeRefused(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validated_scope(raw):
    if not isinstance(raw, dict):
        raise ValueError("scope is not an object")
    for key in SCOPE_LISTS:
        value = raw.get(key, [])
        if not isinstance(value, list) or not all(isinstance(v, (str, int)) for v in value):
            raise ValueError("{} must be a list of strings".format(key))
    for key in ("authPaths", "readOnlyPosts"):
        for pattern in raw.get(key, []):
            re.compile(str(pattern))
    return {key: [str(v) for v in raw.get(key, [])] for key in SCOPE_LISTS}


def init_scope(run_dir, source):
    run_id = os.path.basename(os.path.normpath(run_dir))
    with open(source) as f:
        scope = validated_scope(json.load(f))
    scope.update(schemaVersion=1, runId=run_id)
    with open(os.path.join(run_dir, SCOPE_FILE), "x") as f:
        json.dump(scope, f, indent=1)
    return scope


def load_scope(run_dir):
    path = os.path.join(run_dir, SCOPE_FILE)
    if not os.path.isfile(path) or os.path.islink(path):
        raise WriteScopeRefused("no-scope path={}".format(path))
    try:
        with open(path) as f:
            raw = json.load(f)
        scope = validated_scope(raw)
    except (OSError, ValueError, re.error) as e:
        raise WriteScopeRefused("unreadable-scope path={} error={}".format(path, e))
    run_id = os.path.basename(os.path.normpath(run_dir))
    if raw.get("runId") != run_id:
        raise WriteScopeRefused("scope-run-mismatch scope={} run={}".format(raw.get("runId"), run_id))
    scope["fixturePrefix"] = "QA-{}-".format(run_id)
    return scope


def ledger_ids(run_dir):
    try:
        with open(os.path.join(run_dir, LEDGER_FILE)) as f:
            rows = [json.loads(line) for line in f if line.strip()]
        return {"{}/{}".format(r["path"].rstrip("/"), r["id"]) for r in rows}
    except FileNotFoundError:
        return set()
    except (OSError, ValueError, KeyError) as e:
        raise WriteScopeRefused("unreadable-ledger error={}".format(e))


def record_fixture(run_dir, create_path, fixture_id, name):
    with open(os.path.join(run_dir, LEDGER_FILE), "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"id": str(fixture_id), "path": create_path, "name": name, "at": now()}) + "\n")


def scalars(value):
    if isinstance(value, list):
        return [v for item in value for v in scalars(item)]
    if isinstance(value, dict):
        return []
    return [] if value is None else [str(value)]


def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def qa_name(body, prefix):
    for key, value in (body.items() if isinstance(body, dict) else []):
        if key.lower() in NAME_KEYS and isinstance(value, str) and value.startswith(prefix):
            return value
    return None


def judge(run_dir, method, path, body=None):
    method = method.upper()
    if method in READ_METHODS:
        return "read"
    scope = load_scope(run_dir)
    parsed = urllib.parse.urlsplit(path)
    route = parsed.path
    if method == "POST" and any(re.fullmatch(p, route) for p in scope["authPaths"]):
        return "auth"
    if method == "POST" and any(re.fullmatch(p, route) for p in scope["readOnlyPosts"]):
        return "read-only-post"
    fixtures = ledger_ids(run_dir)
    owned, foreign = [], []
    segments = route.split("/")
    for i, segment in enumerate(segments):
        segment = urllib.parse.unquote(segment)
        if ID_SEGMENT.fullmatch(segment) and not VERSION_SEGMENT.fullmatch(segment):
            mine = "/".join(segments[:i + 1]) in fixtures or segment in scope["accounts"]
            (owned if mine else foreign).append(segment)
    pairs = list(walk(body)) + urllib.parse.parse_qsl(parsed.query)
    for key, value in pairs:
        norm = key.lower().replace("_", "")
        for kind, keys in TARGET_KEYS.items():
            if norm in keys:
                for v in scalars(value):
                    (owned if v in scope[kind] else foreign).append("{}={}".format(key, v))
    if foreign:
        raise WriteScopeRefused("foreign-target targets={}".format(",".join(foreign)))
    if not owned and not (method == "POST" and qa_name(body, scope["fixturePrefix"])):
        raise WriteScopeRefused("no-qa-target (names no {}* object and no id this run created)".format(scope["fixturePrefix"]))
    return "write"


def created_ids(response, name):
    if not isinstance(response, dict):
        return []
    dicts = [response] + [v for v in response.values() if isinstance(v, dict)]
    with_id = [d for d in dicts if d.get("id") not in (None, "")]
    named = [d for d in with_id if name in (d.get(k) for k in NAME_KEYS)]
    unnamed = not any(k in d for d in with_id for k in NAME_KEYS)
    direct = [d for d in with_id if unnamed and (d is response or d is response.get("data"))]
    return [d["id"] for d in (named or direct[:1])]


def claims(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        c = json.loads(base64.urlsafe_b64decode(part))
        return {k: c[k] for k in ("sub", "userId", "id", "role", "tenantId", "tenant", "isAdmin") if k in c}
    except (IndexError, ValueError):
        return {}


class H:
    def __init__(self, outdir, run_dir, base, seats, login_path="/users/login", password_helper=PASSWORD_HELPER):
        self.out, self.run_dir, self.base, self.seats = outdir, run_dir, base.rstrip("/"), seats
        self.login_path, self.password_helper, self.tok = login_path, password_helper, {}
        os.makedirs(outdir, exist_ok=True)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def emit(self, line):
        print(line, flush=True)
        with open(os.path.join(self.out, "00-timeline.txt"), "a") as f:
            f.write(line + "\n")

    def save(self, tag, record):
        with open(os.path.join(self.out, "{}.json".format(tag)), "w") as f:
            json.dump(record, f, indent=1, default=str)

    def guarded(self, tag, seat, method, path, body):
        try:
            return judge(self.run_dir, method, path, body)
        except WriteScopeRefused as e:
            self.save(tag, {"harnessBlocked": True, "refusal": "WRITE_SCOPE_REFUSED", "reason": str(e),
                            "seat": seat, "method": method, "path": path, "body": body, "at": now()})
            self.emit("{} [{}] {} {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED reason={} (no request sent)".format(
                now(), tag, seat, method, path, e))
            raise

    def req(self, method, path, tok=None, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if tok:
            r.add_header("Authorization", "Bearer " + tok)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        t0 = time.time()
        try:
            resp = self.opener.open(r, timeout=240)
            code, raw = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read()
        except (urllib.error.URLError, OSError) as e:
            return -1, {"_error": str(e)[:300]}, time.time() - t0
        try:
            js = json.loads(raw)
        except ValueError:
            js = {"_raw": raw[:300].decode("utf8", "replace")}
        return code, js, time.time() - t0

    def login(self, seat):
        if seat in self.tok:
            return 200
        self.guarded("login-" + seat, seat, "POST", self.login_path, None)
        pr = subprocess.run(["bash", self.password_helper, self.seats[seat]], capture_output=True, text=True)
        pw = pr.stdout.strip()
        if pr.returncode != 0 or not pw:
            why = "SEAT_LEASE_REFUSED (seat unavailable)" if pr.returncode == 69 else "derive rc={}".format(pr.returncode)
            self.emit("{} login {} REFUSED locally: {}, no request sent".format(now(), seat, why))
            raise SystemExit(2)
        code, js, _ = self.req("POST", self.login_path, body={"email": self.seats[seat], "password": pw})
        pw = None
        token = None
        if isinstance(js, dict):
            d = js.get("data") if isinstance(js.get("data"), dict) else {}
            for k in ("access_token", "accessToken", "token"):
                token = token or js.get(k) or d.get(k)
        if token:
            self.tok[seat] = token
        self.emit("{} login {} -> {} token={} claims={}".format(
            now(), seat, code, "yes" if token else "no", json.dumps(claims(token)) if token else "-"))
        return code

    def call(self, tag, seat, method, path, body=None, save=True):
        kind = self.guarded(tag, seat, method, path, body)
        code, js, dt = self.req(method, path, self.tok.get(seat), body)
        if kind == "write" and method.upper() == "POST" and 200 <= code < 300:
            name = qa_name(body, "QA-{}-".format(os.path.basename(os.path.normpath(self.run_dir))))
            for fixture_id in created_ids(js, name) if name else []:
                record_fixture(self.run_dir, urllib.parse.urlsplit(path).path, fixture_id, name)
        if save:
            self.save(tag, {"status": code, "seat": seat, "method": method, "path": path, "body": body,
                            "at": now(), "response": js})
        d = js.get("data", js) if isinstance(js, dict) else js
        shape = "list[{}]".format(len(d)) if isinstance(d, list) else (
            "keys={}".format(list(d.keys())[:12]) if isinstance(d, dict) else type(d).__name__)
        self.emit("{} [{}] {} {} {} {} -> {} {:.2f}s {}".format(
            now(), tag, seat, method, path, json.dumps(body) if body is not None else "", code, dt, shape))
        return code, js


def main(argv):
    if len(argv) == 5 and argv[1] == "init" and argv[3] == "--from":
        try:
            init_scope(argv[2], argv[4])
        except FileExistsError:
            print("init: {} already exists; the scope is pinned once per run".format(SCOPE_FILE), file=sys.stderr)
            return 3
        except (OSError, ValueError, re.error) as e:
            print("init: {}".format(e), file=sys.stderr)
            return 2
        return 0
    if len(argv) in (5, 7) and argv[1] == "check" and (len(argv) == 5 or argv[5] == "--body"):
        body = json.loads(argv[6]) if len(argv) == 7 else None
        try:
            print(judge(argv[2], argv[3], argv[4], body))
        except WriteScopeRefused as e:
            print("WRITE_SCOPE_REFUSED reason={}".format(e), file=sys.stderr)
            return REFUSED
        return 0
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
