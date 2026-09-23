#!/usr/bin/env python3
"""Test-only fakes for the live smoke campaign controller: gate, gh, ncl and
enqueue-send, with state, a call log and scripted faults.

  python3 controller-live-fakes.py <gate|gh|ncl|enqueue> <args...>

Environment:
  FAKE_STATE       directory holding the fakes' state (gh.json, ncl.json,
                   enqueue.json, faults.json) -- required
  FAKE_LOG         ndjson call log (one line per call, with its outcome)
  FAKE_GATE_STATE  the gate state dir the gate fake reads and writes (the same
                   pr-<n>-state.json / runs/<id>/verdict.json shape the real
                   gate writes, smoke-pr-gate.sh)

Faults: faults.json maps "<tool>:<op>" to a list of behaviours consumed one per
call, in order:
  fail-before   no write; an error the controller reads as unknown/failed
  fail-after    the write happens, then the call reports an error (the
                ambiguous case: the effect landed but the caller cannot know)
  refuse        (gate only) a definitive refusal
  partial       (gate finish only) verdict.json is written, then the call
                dies before the hold/ledger work and the slot cleanup

The fakes mirror the real contracts the controller depends on:
  enqueue  INSERT ... ON CONFLICT(id) DO NOTHING + read-back: a repeated id
           with the same payload is `replay`, a different one `mismatch`; the
           helper's own budget (enqueue-send.ts CONTROLLER_SEND_BUDGET).
  gate     owner-token and claimant checks (smoke-pr-gate.sh claimant_guard),
           `finish` writes verdict.json FIRST and only then clears the slot
           and records completedRunId/completedVerdictDigest; a repeated
           finish with the same facts resumes from verdict.json
           (smoke-pr-gate.sh:4002-4027, :4160-4176, :4557-4563).
  gh       comments/issues carry whatever body was written; `api ... --jq .[]`
           lists them one JSON object per line.
  ncl      `tasks create` returns {ok, data:{series_id}}; `tasks list` lists them.
"""
import fcntl
import hashlib
import json
import os
import sys
import time

STATE = os.environ["FAKE_STATE"]
LOG = os.environ.get("FAKE_LOG")
BUDGET = {"perFire": 4, "perRun": 15, "perFingerprint": 2}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(name, default):
    try:
        with open(os.path.join(STATE, name)) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def save(name, doc):
    path = os.path.join(STATE, name)
    with open(path + ".tmp", "w") as fh:
        json.dump(doc, fh, sort_keys=True)
    os.replace(path + ".tmp", path)


def fault(op):
    faults = load("faults.json", {})
    queue = faults.get(op) or []
    if not queue:
        return None
    behaviour = queue.pop(0)
    faults[op] = queue
    save("faults.json", faults)
    return behaviour


def log(tool, op, argv, result):
    if LOG:
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"tool": tool, "op": op, "argv": argv, "result": result}, sort_keys=True) + "\n")


def opt(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def opts(argv, name):
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == name]


def out(doc, rc=0):
    print(json.dumps(doc, sort_keys=True))
    return rc


# -- enqueue ------------------------------------------------------------------
def enqueue(argv):
    db = load("enqueue.json", {"messages": {}, "fires": {}})
    mid, run, fire = opt(argv, "--id"), opt(argv, "--run-id"), opt(argv, "--fire")
    fp = opt(argv, "--fingerprint")
    # --text or --text-file, never both (enqueue-send.ts:428-433).
    if "--text" in argv and "--text-file" in argv:
        return "invalid", out({"ok": False, "code": "invalid", "error": "pass --text or --text-file, not both"}, 2)
    if "--text" in argv:
        text = opt(argv, "--text", "")
    else:
        try:
            with open(opt(argv, "--text-file")) as fh:
                text = fh.read()
        except (OSError, TypeError) as exc:
            return "invalid", out({"ok": False, "code": "invalid", "error": str(exc)}, 2)
    files = opts(argv, "--file")
    for f in files:
        if not os.path.isfile(f):
            return "invalid", out({"ok": False, "code": "invalid", "error": "attachment missing: " + f}, 2)
    payload = {"text": text, "to": opt(argv, "--to"), "threadKey": opt(argv, "--thread-key"),
               "files": [hashlib.sha256(open(f, "rb").read()).hexdigest() for f in files]}
    f = fault("enqueue")
    if f == "fail-before":
        return "fail-before", out({"ok": False, "code": "error", "error": "injected"}, 1)
    have = db["messages"].get(mid)
    if have:
        if {k: have[k] for k in payload} != payload:
            return "mismatch", out({"ok": False, "code": "mismatch", "error": "payload differs for " + mid}, 4)
        return "replay", out({"ok": True, "outcome": "replay", "id": mid, "seq": have["seq"]})
    msgs = [m for m in db["messages"].values() if m["runId"] == run]
    fire_key = "{}|{}".format(run, fire)
    reason = None
    if db["fires"].get(fire_key, 0) >= BUDGET["perFire"]:
        reason = "per-fire budget {} reached".format(BUDGET["perFire"])
    elif len(msgs) >= BUDGET["perRun"]:
        reason = "per-run budget {} reached".format(BUDGET["perRun"])
    elif fp and sum(1 for m in msgs if m.get("fingerprint") == fp) >= BUDGET["perFingerprint"]:
        reason = "per-fingerprint budget {} reached for {}".format(BUDGET["perFingerprint"], fp)
    if reason:
        return "budget", out({"ok": False, "code": "budget", "error": reason, "alarm": "controller_send_budget"}, 3)
    seq = 2 * len(db["messages"]) + 1
    db["messages"][mid] = dict(payload, runId=run, fingerprint=fp, seq=seq, at=now_iso())
    db["fires"][fire_key] = db["fires"].get(fire_key, 0) + 1
    save("enqueue.json", db)
    if f == "fail-after":
        return "fail-after", out({"ok": False, "code": "error", "error": "injected after write"}, 1)
    return "enqueued", out({"ok": True, "outcome": "enqueued", "id": mid, "seq": seq})


# -- gh -------------------------------------------------------------------------
def gh(argv):
    db = load("gh.json", {"comments": {}, "issues": [], "prs": {}})
    if argv[:1] == ["api"]:
        path = argv[1]
        f = fault("gh:api")
        if f == "fail-before":
            return "fail", out_err("HTTP 502")
        objs = []
        if "/comments" in path:
            pr = path.split("/issues/")[1].split("/")[0]
            objs = db["comments"].get(pr, [])
        else:
            objs = db["issues"]
        for o in objs:
            print(json.dumps(o))
        return "list", 0
    if argv[:2] == ["pr", "comment"]:
        pr = argv[2]
        body = open(opt(argv, "--body-file")).read()
        f = fault("gh:pr-comment")
        if f == "fail-before":
            return "fail", out_err("HTTP 502")
        n = sum(len(v) for v in db["comments"].values()) + 1
        db["comments"].setdefault(pr, []).append(
            {"id": n, "body": body, "html_url": "https://github.test/pr/{}#c{}".format(pr, n)})
        save("gh.json", db)
        if f == "fail-after":
            return "fail-after", out_err("HTTP 502 after write")
        print("https://github.test/pr/{}#c{}".format(pr, n))
        return "commented", 0
    if argv[:2] == ["issue", "list"]:
        f = fault("gh:issue-list")
        if f == "fail-before":
            return "fail", out_err("HTTP 502")
        print(json.dumps([{"number": i["number"], "title": i["title"], "url": i["html_url"]}
                          for i in db["issues"] if i["state"] == "open"]))
        return "list", 0
    if argv[:2] == ["issue", "create"]:
        body = open(opt(argv, "--body-file")).read()
        f = fault("gh:issue-create")
        if f == "fail-before":
            return "fail", out_err("HTTP 502")
        n = len(db["issues"]) + 100
        db["issues"].append({"number": n, "title": opt(argv, "--title"), "body": body, "state": "open",
                             "labels": opts(argv, "--label"), "html_url": "https://github.test/issues/{}".format(n)})
        save("gh.json", db)
        if f == "fail-after":
            return "fail-after", out_err("HTTP 502 after write")
        print("https://github.test/issues/{}".format(n))
        return "created", 0
    if argv[:2] == ["pr", "view"]:
        pr = argv[2]
        st = db["prs"].get(pr, {"state": "OPEN", "headRefOid": None, "headRefName": "feature"})
        fields = (opt(argv, "--json") or "").split(",")
        print(json.dumps({k: st.get(k) for k in fields}))
        return "view", 0
    if argv[:2] == ["pr", "close"]:
        pr = argv[2]
        f = fault("gh:pr-close")
        if f == "fail-before":
            return "fail", out_err("HTTP 502")
        db["prs"].setdefault(pr, {"state": "OPEN"})["state"] = "CLOSED"
        save("gh.json", db)
        if f == "fail-after":
            return "fail-after", out_err("HTTP 502 after write")
        return "closed", 0
    return "unknown", out_err("fake gh: unsupported " + " ".join(argv[:2]))


def out_err(msg):
    print(msg, file=sys.stderr)
    return 1


# -- ncl ------------------------------------------------------------------------
def ncl(argv):
    db = load("ncl.json", {"tasks": []})
    if argv[:2] == ["tasks", "create"]:
        name = opt(argv, "--name")
        f = fault("ncl:create")
        if f == "fail-before":
            return "fail", out({"ok": False, "error": {"message": "injected"}}, 1)
        if f == "refuse":
            return "refused", out({"ok": False, "error": {"message": "group has cli_scope disabled"}}, 1)
        sid = "{}-{}".format(name, hashlib.sha256(name.encode()).hexdigest()[:6])
        db["tasks"].append({"series_id": sid, "name": name, "status": "pending", "prompt": opt(argv, "--prompt"),
                            "flags": [a for a in argv if a.startswith("--") and a not in ("--prompt",)]})
        save("ncl.json", db)
        if f == "fail-after":
            return "fail-after", 1  # no output: a timeout after the host created the task
        return "created", out({"ok": True, "data": {"series_id": sid}})
    if argv[:2] == ["tasks", "list"]:
        return "list", out({"ok": True, "data": [{"series_id": t["series_id"], "status": t["status"]}
                                                 for t in db["tasks"]]})
    # The phase-dispatch owner route (the controller's _dispatch_owner_intent
    # and owner_status). Admission is keyed on context + event, as the host's
    # is; a step's settlement is whatever settle.json names for it, and a step
    # it does not name is still running -- an owner that never settles.
    if argv[:2] == ["tasks", "dispatch"]:
        ctx, event = opt(argv, "--context-key"), opt(argv, "--event-key")
        rows = load("dispatch.json", {"rows": {}})
        rid = "row-" + hashlib.sha256("{}#{}".format(ctx, event).encode()).hexdigest()[:10]
        admission = "replay" if rid in rows["rows"] else "inserted"
        rows["rows"][rid] = {"context": ctx, "event": event,
                             "session": "sess-" + hashlib.sha256(ctx.encode()).hexdigest()[:10]}
        save("dispatch.json", rows)
        return "dispatched", out({"ok": True, "data": {"admission": admission, "row_id": rid,
                                                       "session_id": rows["rows"][rid]["session"]}})
    if argv[:2] == ["tasks", "get"]:
        row = load("dispatch.json", {"rows": {}})["rows"].get(opt(argv, "--id"))
        if row is None:
            return "unknown-row", out({"ok": False, "error": {"message": "no such row"}}, 1)
        state = load("settle.json", {}).get(row["context"].rsplit("/", 1)[-1], "busy")
        return "get", out({"ok": True, "data": {"status": "completed" if state == "settled" else "running",
                                                "settlement": {"state": state, "outcome": "success",
                                                               "executionSettled": state == "settled"}}})
    return "unknown", out({"ok": False, "error": {"message": "fake ncl: unsupported"}}, 2)


# -- gate -----------------------------------------------------------------------
def gate(argv):
    gs = os.environ["FAKE_GATE_STATE"]
    verb = argv[0]
    claimant = os.environ.get("SMOKE_GATE_CLAIMANT", "")

    def states():
        for name in sorted(os.listdir(gs)):
            if name.startswith("pr-") and name.endswith("-state.json"):
                p = os.path.join(gs, name)
                yield p, json.load(open(p))

    def find(run):
        for p, st in states():
            if st.get("activeRunId") == run:
                return p, st
        return None, None

    def write(p, doc):
        with open(p + ".tmp", "w") as fh:
            json.dump(doc, fh)
        os.replace(p + ".tmp", p)

    if verb in ("finish", "challenger-timeout", "progress"):
        run = argv[2] if verb == "finish" else argv[1]
        token = argv[4] if verb == "finish" else argv[2]
        f = fault("gate:" + verb)
        if f == "fail-before":
            return "fail", out({"ok": False, "error": "lock busy", "retryable": True})
        if f == "refuse":
            return "refused", out({"ok": False, "error": "injected refusal"})
        resumed = None
        vfile = os.path.join(gs, "runs", run, "verdict.json")
        if verb != "progress" and os.path.exists(vfile):
            existing = json.load(open(vfile))
            want = argv[3] if verb == "finish" else "BLOCKED"
            if verb == "finish" and (existing.get("sha"), existing.get("verdict")) != (argv[1], want):
                return "verdict-conflict", out({"ok": False, "error": "a different verdict is already recorded"}, 2)
            for _, other in states():
                if other.get("completedRunId") == run and other.get("activeRunId") != run:
                    return "idempotent", out({"ok": True, "idempotent": True, "verdict": existing.get("verdict"),
                                              "finishedAt": existing.get("finishedAt")})
            resumed = existing
        p, st = find(run)
        if st is None:
            return "not-active", out({"ok": False, "error": "not the active run (reclaimed or finished)"})
        if st.get("activeLeaseOwner") != token:
            return "owner", out({"ok": False, "error": "caller owner does not match the owner recorded by claim"})
        if (st.get("activeClaimant") or "") != claimant:
            return "claimant", out({"ok": False, "claimantMismatch": True,
                                    "error": "this run is driven by someone else - refused"})
        if verb == "progress":
            st["activeProgressAt"] = now_iso()
            write(p, st)
            return "progress", out({"ok": True, "runId": run})
        verdict = argv[3] if verb == "finish" else "BLOCKED"
        if verb == "finish" and argv[1] != st.get("activeSha"):
            return "sha", out({"ok": False, "error": "finish sha does not match the sha this run claimed"}, 2)
        if verdict == "GO" and st.get("challengerDisposition") == "no-disposition":
            return "go-refused", out({"ok": False, "error": "GO is REFUSED"}, 2)
        rd = os.path.join(gs, "runs", run)
        os.makedirs(rd, exist_ok=True)
        vpath = os.path.join(rd, "verdict.json")
        if resumed:
            at = resumed["finishedAt"]
        else:
            at = now_iso()
            # The real gate's canonical payload: compact, fixed key order, one
            # trailing newline; the digest is over the compact string.
            with open(vpath + ".tmp", "w") as fh:
                fh.write(json.dumps({"schemaVersion": 1, "sha": st.get("activeSha"), "runId": run,
                                     "verdict": verdict, "finishedAt": at}, separators=(",", ":")) + "\n")
            os.replace(vpath + ".tmp", vpath)
        if verb == "challenger-timeout":
            st["challengerDisposition"] = "no-disposition"
            write(p, st)
        if f == "partial":
            return "partial", 1  # died after verdict.json, slot still held
        with open(vpath, "rb") as fh:
            digest = hashlib.sha256(fh.read().rstrip(b"\n")).hexdigest()
        pr = st.get("pr")
        write(os.path.join(gs, "pr-{}-verdict.json".format(pr)), {"runId": run, "verdict": verdict,
                                                                   "sha": st.get("activeSha")})
        st.update({"completedRunId": run, "completedVerdict": verdict, "completedAt": at,
                   "completedVerdictDigest": digest, "activeRunId": None,
                   "activeSha": None, "activeLeaseOwner": None, "activeClaimant": None})
        write(p, st)
        if f == "fail-after":
            return "fail-after", 1  # killed after the write, no output
        return verb, out({"ok": True, "verdict": verdict, "finishedAt": at})
    return "unknown", out({"ok": False, "error": "fake gate: unsupported verb " + verb}, 2)


def main():
    tool, argv = sys.argv[1], sys.argv[2:]
    os.makedirs(STATE, exist_ok=True)
    with open(os.path.join(STATE, ".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        op, rc = {"enqueue": enqueue, "gh": gh, "ncl": ncl, "gate": gate}[tool](argv)
    log(tool, op, argv, rc)
    return rc


if __name__ == "__main__":
    sys.exit(main())
