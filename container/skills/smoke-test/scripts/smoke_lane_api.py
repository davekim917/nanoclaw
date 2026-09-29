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
  smoke_lane_api.py check <run-dir> <METHOD> <path> [--body <json>] [--tenant <seat tenant>]"""

REFUSED = 77
SCOPE_FILE = "write-scope.json"
LEDGER_FILE = "write-scope-fixtures.ndjson"
SCOPE_MODE = "deny"
READ_METHODS = {"GET", "HEAD", "OPTIONS"}
SCOPE_LISTS = ("tenants", "authPaths", "readOnlyPosts", "denyPaths", "denyPrefixes")
REQUIRED_LISTS = ("tenants", "denyPaths", "denyPrefixes")
PINNED_KEYS = {"mode", "schemaVersion", "runId"}
PATTERN_LISTS = ("authPaths", "readOnlyPosts", "denyPaths")
TENANT_KEYS = {"tenantid", "tenantids", "tenant", "tenants"}
TENANT_CLAIMS = ("tenantId", "tenant_id", "tenant")
DENY_PATTERNS = (
    re.compile(r"sync|publish|archive|refresh|rebuild|reindex|backfill|cron"),
    re.compile(r"(?:^|/)jobs?/(?:[^/]+/)*(?:runs?|execute|trigger)(?:[/-]|$)"),
)
NAME_KEYS = {"name", "title", "label", "filename"}
PASSWORD_HELPER = "/workspace/extra/qa-seat-password.sh"
SECRET_KEY = re.compile(r"password|secret|token", re.I)


class WriteScopeRefused(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validated_scope(raw):
    if not isinstance(raw, dict):
        raise ValueError("scope is not an object")
    if raw.get("mode") != SCOPE_MODE:
        raise ValueError("mode must be {!r} (an allowlist scope file is no longer accepted)".format(SCOPE_MODE))
    unknown = sorted(set(raw) - set(SCOPE_LISTS) - PINNED_KEYS)
    if unknown:
        raise ValueError("unknown keys {}".format(unknown))
    for key in SCOPE_LISTS:
        if key in REQUIRED_LISTS and key not in raw:
            raise ValueError("{} is required (an empty list is fine)".format(key))
        value = raw.get(key, [])
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError("{} must be a list of strings".format(key))
    for key in PATTERN_LISTS:
        for pattern in raw.get(key, []):
            re.compile(pattern)
            if not pattern.startswith("/") or pattern.endswith("/") or "//" in pattern or "%" in pattern:
                raise ValueError("{} pattern {!r} is not a canonical path pattern".format(key, pattern))
    for prefix in raw.get("denyPrefixes", []):
        try:
            canonical = route_of(prefix)
        except WriteScopeRefused:
            canonical = None
        if prefix != canonical or canonical == "/":
            raise ValueError("denyPrefixes entry {!r} is not a canonical path below the root".format(prefix))
    scope = {key: [str(v) for v in raw.get(key, [])] for key in SCOPE_LISTS}
    return dict(scope, mode=SCOPE_MODE)


def init_scope(run_dir, source):
    run_id = os.path.basename(os.path.normpath(run_dir))
    with open(source) as f:
        scope = validated_scope(json.load(f))
    pinned = {**scope, "schemaVersion": 2, "runId": run_id}
    with open(os.path.join(run_dir, SCOPE_FILE), "x") as f:
        json.dump(pinned, f, indent=1)
    return pinned


def fixture_prefix(run_dir):
    return "QA-{}-".format(os.path.basename(os.path.normpath(run_dir)))


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
    return scope


def record_fixture(run_dir, create_path, fixture_id, name):
    with open(os.path.join(run_dir, LEDGER_FILE), "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"id": str(fixture_id), "path": create_path, "name": name, "at": now()}) + "\n")


def scalars(value):
    if isinstance(value, list) and value:
        return [v for item in value for v in scalars(item)]
    if isinstance(value, dict):
        inner = value.get("id")
        return [str(inner)] if isinstance(inner, (str, int)) and not isinstance(inner, bool) else ["<object>"]
    return ["<empty>"] if value in (None, "", []) else [str(value)]


def walk(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def route_of(path):
    if not path.startswith("/") or path.startswith("//"):
        raise WriteScopeRefused("bad-path (a request path is a single-slash absolute path)")
    segments = [urllib.parse.unquote(s) for s in urllib.parse.urlsplit(path).path.split("/")]
    if any(s in (".", "..") for s in segments):
        raise WriteScopeRefused("bad-path (no dot segments)")
    return "/" + "/".join(s for s in segments if s).lower()


def denied(scope, route):
    for pattern in scope["denyPaths"]:
        if re.fullmatch(pattern, route, re.I):
            return "denyPaths {}".format(pattern)
    for prefix in scope["denyPrefixes"]:
        if route == prefix or route.startswith(prefix + "/"):
            return "denyPrefixes {}".format(prefix)
    return None


def tenant_key(key):
    return any(part.replace("_", "").replace("-", "") in TENANT_KEYS
               for part in re.split(r"[\[\]]", key.lower()) if part)


def judge(run_dir, method, path, body=None, token_tenants=(), base_path=""):
    method = method.upper()
    route = route_of(path)
    if base_path:
        route = route_of(base_path.rstrip("/") + route)
    if method in READ_METHODS:
        return "read"
    scope = load_scope(run_dir)
    rule = denied(scope, route)
    if rule:
        raise WriteScopeRefused("denied-path rule={}".format(rule))
    if method == "POST" and any(re.fullmatch(p, route, re.I) for p in scope["authPaths"]):
        return "auth"
    if method == "POST" and any(re.fullmatch(p, route, re.I) for p in scope["readOnlyPosts"]):
        return "read-only-post"
    shape = next((p.pattern for p in DENY_PATTERNS if p.search(route)), None)
    if shape:
        raise WriteScopeRefused("denied-path rule=tenant-wide-shape {}".format(shape))
    query = urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query, keep_blank_values=True)
    foreign = ["{}={}".format(key, v) for key, value in list(walk(body)) + query
               if tenant_key(key)
               for v in scalars(value) if v not in scope["tenants"]]
    if foreign:
        raise WriteScopeRefused("foreign-tenant targets={}".format(",".join(foreign)))
    if not token_tenants:
        raise WriteScopeRefused("no-tenant (a write needs a seat token naming a scoped tenant)")
    outside = [t for t in token_tenants if t not in scope["tenants"]]
    if outside:
        raise WriteScopeRefused("foreign-tenant seat-tenant={}".format(",".join(outside)))
    return "write"


def seat_tenants(token):
    c = claims(token) if token else {}
    return [v for k in TENANT_CLAIMS if k in c for v in scalars(c[k])]


def names_itself(response, fixture_id, name):
    if not isinstance(response, dict):
        return False
    entity = response
    if "id" not in response:
        wrapped = [v for v in response.values() if isinstance(v, dict)]
        entity = response["data"] if isinstance(response.get("data"), dict) else wrapped[0] if len(wrapped) == 1 else {}
    return str(entity.get("id")) == str(fixture_id) and name in (entity.get(k) for k in NAME_KEYS)


def redacted(body):
    if isinstance(body, dict):
        return {k: "<redacted>" if SECRET_KEY.search(k) else redacted(v) for k, v in body.items()}
    if isinstance(body, list):
        return [redacted(v) for v in body]
    return body


def sanitized(path):
    parts = urllib.parse.urlsplit(path)
    if not parts.query:
        return path
    query = [(k, "<redacted>" if SECRET_KEY.search(k) else v)
             for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def claims(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        c = json.loads(base64.urlsafe_b64decode(part))
        return {k: c[k] for k in ("sub", "userId", "id", "role", "isAdmin") + TENANT_CLAIMS if k in c}
    except (IndexError, ValueError):
        return {}


class H:
    def __init__(self, outdir, run_dir, base, seats, login_path="/users/login", password_helper=PASSWORD_HELPER):
        self.out, self.run_dir, self.base, self.seats = outdir, run_dir, base.rstrip("/"), seats
        self.login_path, self.password_helper, self.tok = login_path, password_helper, {}
        os.makedirs(outdir, exist_ok=True)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def emit(self, line):
        print(line, flush=True)
        with open(os.path.join(self.out, "00-timeline.txt"), "a") as f:
            f.write(line + "\n")

    def save(self, tag, record):
        with open(os.path.join(self.out, "{}.json".format(tag)), "w") as f:
            json.dump(record, f, indent=1, default=str)

    def refuse(self, tag, seat, method, path, body, error):
        self.save(tag, {"harnessBlocked": True, "refusal": "WRITE_SCOPE_REFUSED", "reason": str(error),
                        "seat": seat, "method": method, "path": sanitized(path), "body": redacted(body), "at": now()})
        self.emit("{} [{}] {} {} {} -> HARNESS_BLOCKED WRITE_SCOPE_REFUSED reason={} (no request sent)".format(
            now(), tag, seat, method, sanitized(path), error))
        raise error

    def guarded(self, tag, seat, method, path, body, tok=None):
        try:
            judge(self.run_dir, method, path, body, seat_tenants(tok), urllib.parse.urlsplit(self.base).path)
        except WriteScopeRefused as e:
            self.refuse(tag, seat, method, path, body, e)

    def own(self, tag, seat, create_path, fixture_id, name):
        path = "{}/{}".format(create_path.rstrip("/"), urllib.parse.quote(str(fixture_id), safe=""))
        prefix = fixture_prefix(self.run_dir)
        if not (isinstance(name, str) and name.startswith(prefix) and len(name) > len(prefix)):
            self.refuse(tag, seat, "OWN", path, None, WriteScopeRefused("not-a-qa-name name={!r}".format(name)))
        code, js = self.call(tag, seat, "GET", path)
        if not (200 <= code < 300 and names_itself(js, fixture_id, name)):
            self.refuse(tag + "-own", seat, "OWN", path, None,
                        WriteScopeRefused("unverified-fixture status={} (the object does not carry {})".format(code, name)))
        record_fixture(self.run_dir, create_path, fixture_id, name)
        self.emit("{} [{}] {} OWN {} -> ledgered as {}".format(now(), tag, seat, path, name))

    def req(self, method, path, tok=None, body=None, tag="req", seat="-"):
        self.guarded(tag, seat, method, path, body, tok)
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
        code, js, _ = self.req("POST", self.login_path, body={"email": self.seats[seat], "password": pw},
                                  tag="login-" + seat, seat=seat)
        pw = None
        token = None
        if isinstance(js, dict):
            data = js.get("data")
            for d in (js, data if isinstance(data, dict) else {}):
                for k in ("access_token", "accessToken", "token"):
                    token = token or (d.get(k) if isinstance(d.get(k), str) else None)
        if token:
            self.tok[seat] = token
        self.emit("{} login {} -> {} token={} claims={}".format(
            now(), seat, code, "yes" if token else "no", json.dumps(claims(token)) if token else "-"))
        return code

    def call(self, tag, seat, method, path, body=None, save=True):
        code, js, dt = self.req(method, path, self.tok.get(seat), body, tag, seat)
        if save:
            self.save(tag, {"status": code, "seat": seat, "method": method, "path": sanitized(path),
                            "body": redacted(body), "at": now(), "response": redacted(js)})
        d = js.get("data", js) if isinstance(js, dict) else js
        shape = "list[{}]".format(len(d)) if isinstance(d, list) else (
            "keys={}".format(list(d.keys())[:12]) if isinstance(d, dict) else type(d).__name__)
        self.emit("{} [{}] {} {} {} {} -> {} {:.2f}s {}".format(
            now(), tag, seat, method, sanitized(path), json.dumps(redacted(body)) if body is not None else "", code, dt, shape))
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
    flags = dict(zip(argv[5::2], argv[6::2]))
    if (len(argv) >= 5 and argv[1] == "check" and len(argv) % 2 == 1
            and set(flags) <= {"--body", "--tenant"} and len(flags) == (len(argv) - 5) // 2):
        body = json.loads(flags["--body"]) if "--body" in flags else None
        tenants = [flags["--tenant"]] if "--tenant" in flags else []
        try:
            print(judge(argv[2], argv[3], argv[4], body, tenants))
        except WriteScopeRefused as e:
            print("WRITE_SCOPE_REFUSED reason={}".format(e), file=sys.stderr)
            return REFUSED
        return 0
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
