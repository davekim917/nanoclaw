#!/usr/bin/env python3
"""Structural, fail-closed redactor for agent-browser network captures (GH harness
security defect: raw browser network captures persisted bearer tokens to disk
before redaction). v5.

Two independent input shapes are handled:

1. `agent-browser network requests|request --json` output — an arbitrary JSON
   tree where a request/response object carries a `url` (or `request.url`)
   field and inline body fields (`postData`, `body`, `responseBody`, ...) as
   JSON-encoded STRINGS.
2. HAR 1.2 (`agent-browser network har stop <path>`) — a fixed
   `{"log": {"entries": [{"request": {...}, "response": {...}}]}}` shape where
   headers/cookies/query params are `[{"name":, "value":}, ...]` pairs and
   bodies live in `postData.text` / `response.content.text`.

Both are auto-detected from the parsed structure; the caller does not choose.

Policy, either shape:
- Input must parse as JSON after stripping any non-JSON prefix (e.g. a Node
  warning line on stdin); anything that still doesn't parse is DROPPED (a
  one-line JSON stub is written, exit 2) — never echoed. A parse failure must
  never fall back to printing the raw bytes.
- Header/cookie values for Authorization/Cookie/Set-Cookie/X-Api-Key/
  Proxy-Authorization (by key name, or by `name` in a HAR {name,value} pair)
  are redacted; every remaining string anywhere in the tree is additionally
  scrubbed for `Bearer <token>` and JWT-shaped (`eyJ...eyJ...`) substrings,
  including inside URLs and query strings.
- Bodies (postData/body/responseBody/requestBody/HAR postData.text/HAR
  response.content.text) are DROPPED unless the request URL matches the
  evidence allowlist below; auth endpoints (login/reset/activate/refresh/
  token) keep URL, method and status only, body always dropped. An
  allowlisted body that is (or contains) a JSON string is parsed and scrubbed
  structurally (credential-shaped keys -> [REDACTED]) before being
  re-serialized; a string body that does not parse as JSON is dropped, never
  passed through — a body we can't structurally inspect is a body we can't
  prove is safe.

This is a minimum bar, not a general secret scanner: exotic non-standard HAR
extensions (e.g. `_webSocketMessages`) fall back to the generic scrub (key-name
+ JWT/Bearer pattern match) rather than the body drop/allowlist policy above.
"""
import json
import re
import sys

ALLOW = re.compile(
    r"/messaging/conversations/[^/?]+/(read|messages)|/users/admin/edit/\d+|/depletions/|/collateral/",
    re.I,
)
AUTH = re.compile(r"/users/(login|reset-password|activate|refresh)|/auth/|/token", re.I)
CRED_KEYS = re.compile(
    r"^(password|newPassword|currentPassword|confirmPassword|secret|refreshToken|"
    r"refresh_token|token|accessToken|access_token|apiKey|api_key|x-api-key|"
    r"authorization|cookie|set-cookie|proxy-authorization)$",
    re.I,
)
BODY_KEYS = {"postData", "body", "responseBody", "requestBody", "postDataEntries", "response", "content", "text"}
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
BEARER = re.compile(r"[Bb]earer\s+\S+")


def scrub_str(s):
    return BEARER.sub("Bearer [REDACTED]", JWT.sub("[REDACTED-JWT]", s))


def scrub_tree(o):
    if isinstance(o, dict):
        return {k: ("[REDACTED]" if CRED_KEYS.match(k) else scrub_tree(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub_tree(x) for x in o]
    if isinstance(o, str):
        return scrub_str(o)
    return o


def scrub_body(v):
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
        except Exception:
            return "[DROPPED-UNPARSABLE-BODY]"
        return json.dumps(scrub_tree(parsed), separators=(",", ":"))
    return scrub_tree(v)


def gated_body(v, url):
    """Apply the drop-unless-allowlisted / auth-endpoint policy to one body value."""
    if AUTH.search(url or ""):
        return "[DROPPED-AUTH-REQUEST-BODY]"
    if ALLOW.search(url or ""):
        return scrub_body(v)
    return "[DROPPED-NOT-ALLOWLISTED]"


# ---- Shape 1: agent-browser `network requests`/`request --json` ----

def walk(o, url=""):
    if isinstance(o, dict):
        u = o.get("url")
        if not isinstance(u, str) and isinstance(o.get("request"), dict):
            u = o["request"].get("url")
        url = u if isinstance(u, str) else url
        out = {}
        for k, v in o.items():
            if CRED_KEYS.match(k):
                out[k] = "[REDACTED]"
                continue
            if k in BODY_KEYS:
                out[k] = gated_body(v, url)
                continue
            out[k] = walk(v, url)
        return out
    if isinstance(o, list):
        return [walk(x, url) for x in o]
    if isinstance(o, str):
        return scrub_str(o)
    return o


# ---- Shape 2: HAR 1.2 (`network har stop`) ----

def scrub_pairs(pairs):
    """A list of HAR {"name":, "value":, ...} pairs — headers, cookies, query params."""
    out = []
    for p in pairs:
        if not isinstance(p, dict) or not isinstance(p.get("name"), str):
            out.append(scrub_tree(p))
            continue
        item = dict(p)
        if CRED_KEYS.match(p["name"]):
            if "value" in item:
                item["value"] = "[REDACTED]"
        else:
            for k, v in list(item.items()):
                if k != "name":
                    item[k] = scrub_tree(v)
        out.append(item)
    return out


def redact_cookies(pairs):
    """HAR `cookies` entries are actual browser cookies — every value is a
    live session/auth artifact regardless of the cookie's own name, so
    (unlike headers/query params) every value is redacted unconditionally."""
    out = []
    for p in pairs:
        if not isinstance(p, dict):
            out.append(scrub_tree(p))
            continue
        item = dict(p)
        if "value" in item:
            item["value"] = "[REDACTED]"
        out.append(item)
    return out


def redact_har_message(msg, url):
    if not isinstance(msg, dict):
        return msg
    out = dict(msg)
    for key in ("headers", "queryString"):
        if isinstance(out.get(key), list):
            out[key] = scrub_pairs(out[key])
    if isinstance(out.get("cookies"), list):
        out["cookies"] = redact_cookies(out["cookies"])
    if isinstance(out.get("postData"), dict):
        pd = dict(out["postData"])
        if "text" in pd:
            pd["text"] = gated_body(pd["text"], url)
        if isinstance(pd.get("params"), list):
            pd["params"] = scrub_pairs(pd["params"])
        out["postData"] = pd
    if isinstance(out.get("content"), dict):
        content = dict(out["content"])
        if "text" in content:
            content["text"] = gated_body(content["text"], url)
        out["content"] = content
    handled = {"headers", "cookies", "queryString", "postData", "content"}
    for k, v in list(out.items()):
        if k in handled:
            continue
        out[k] = scrub_tree(v)
    return out


def redact_har(data):
    log = data.get("log", {})
    entries = log.get("entries", [])
    new_entries = []
    for e in entries:
        if not isinstance(e, dict):
            new_entries.append(scrub_tree(e))
            continue
        req = e.get("request") if isinstance(e.get("request"), dict) else {}
        url = req.get("url") if isinstance(req.get("url"), str) else None
        ne = dict(e)
        if isinstance(e.get("request"), dict):
            ne["request"] = redact_har_message(e["request"], url)
        if isinstance(e.get("response"), dict):
            ne["response"] = redact_har_message(e["response"], url)
        # Non-standard extensions some HAR writers add (e.g. _webSocketMessages):
        # generic fallback scrub only, not the body drop/allowlist policy.
        for k, v in list(ne.items()):
            if k in ("request", "response"):
                continue
            ne[k] = scrub_tree(v)
        new_entries.append(ne)
    new_log = dict(log)
    new_log["entries"] = new_entries
    out = dict(data)
    out["log"] = new_log
    return out


def is_har(data):
    return (
        isinstance(data, dict)
        and isinstance(data.get("log"), dict)
        and isinstance(data["log"].get("entries"), list)
    )


def parse_leading_json(raw):
    """Find the first position where JSON parses to the end of the buffer's
    intent — tolerates a stray non-JSON prefix line (e.g. a Node warning
    printed to the same stream before the actual capture)."""
    cands = []
    pos = 0
    for line in raw.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped[:1] in ("{", "["):
            cands.append(pos + (len(line) - len(stripped)))
        pos += len(line)
    for ch in ("{", "["):
        i = raw.find(ch)
        if i >= 0:
            cands.append(i)
    for i in sorted(set(cands)):
        try:
            return json.loads(raw[i:])
        except Exception:
            continue
    return None


def main():
    raw = sys.stdin.read()
    data = parse_leading_json(raw)
    if data is None:
        sys.stdout.write(
            json.dumps(
                {
                    "dropped": "unparsable-capture",
                    "reason": "input was not a JSON network dump; nothing echoed (fail-closed redaction)",
                }
            )
            + "\n"
        )
        return 2
    result = redact_har(data) if is_har(data) else walk(data)
    json.dump(result, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
