#!/usr/bin/env python3
"""Offline replay of historical PR smoke campaigns through the controller, in shadow.

  build  read-only: turn finished campaigns (run dirs + gate verdicts + the
         actual effects collected separately) into a scrubbed, compact corpus
         (ndjson, one campaign per line; first line is provenance).
  run    replay every corpus campaign through smoke-campaign-controller.py in
         shadow, one fire per */10 tick (each fire executed TWICE), and compare
         the controller's decisions with what actually happened.
         --effects live runs the same timeline in LIVE mode against the
         recording fakes (testdata/controller-live-fakes.py): the gate, gh, ncl
         and enqueue-send are real subprocesses with state, receipts are read
         back from what was enqueued, and the owner acks each brief. It then
         also counts, from the fakes' own state, any effect performed twice.

Timeline model. A campaign is claimed at its runId timestamp (the poll that
claimed it wakes the first fire). Artifacts appear at their recorded mtimes (the
contract at its createdAt: its file mtime is its LAST rewrite); identity checks
at each line's readAt. The historical gate `finish` is never applied: the
controller must reach finish itself (actual verdict/finishedAt are compared,
not injected). The challenger
deadline is claim + 5400 s (smoke-pr-gate.sh:1286 default; deadlines are stamped
since 57b339e0b, 2026-08-29, before this corpus). History has no synthesis.json
(a new contract, CONTROLLER-SPEC s2), so --mode chooses what the owner writes
when synthesis.md appeared:
  faithful  proposes the verdict the campaign actually reached, bound to the
            run, with the contract's lane generations and the markers'
            confirmed findings -- but no dispositions, which history never
            recorded in machine-readable form.
  go-probe  proposes GO for every campaign (same bindings, no dispositions):
            the validator must refuse every one whose actual verdict was not GO.

Readiness. Today's barrier refuses every one of these contracts before reading
a lane (pre-identity schemaVersion 1 -- smoke-journeys.py:1025-1030; the oldest
also lack ownershipKind, smoke-evidence-barrier.sh:48-55), so the replay swaps
in replay_barrier(): the barrier's marker checks (sha, lane id, generation from
the contract, terminal status, completedAt, pass evidence present, confirmed
finding clip or skip line) and the synthesis phase's two parent conclusions.
It does not replay the journeys pin, the visual-candidate check or the pair
re-freeze check. That substitution is the replay's main fidelity limit.
"""

import argparse
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONTROLLER_PATH = os.path.join(SCRIPT_DIR, "smoke-campaign-controller.py")
FIRE_SECONDS = 600
CHALLENGER_TIMEOUT_SECONDS = 5400
TERMINAL = {"pass", "fail", "blocked", "void", "completed"}

# Credential-shaped content never enters the corpus: the builder copies only
# allowlisted fields, then refuses to write if any of these still matches.
CREDENTIAL_PATTERNS = [
    re.compile(r"owner-[0-9a-f]{32,}"),                   # coordinatorOwnerToken
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),           # GitHub tokens
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),          # Slack tokens
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),                 # API keys
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                    # AWS key ids
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}"),
    re.compile(r"\brnd_[A-Za-z0-9]{16,}"),                  # Render API keys
]


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def mtime_iso(path):
    return iso(dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc))


def run_claim_time(run_id):
    return dt.datetime.strptime(run_id.rsplit("-", 1)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)


def credential_hits(text):
    return [p.pattern for p in CREDENTIAL_PATTERNS if p.search(text)]


def redact_names(text, pairs):
    """Replace install-private names (workgroup, agent group, client) with
    generic stand-ins, case-insensitively. The names come from the command
    line so they never live in tracked code; the public-boundary pre-commit
    check refuses a corpus that still carries them."""
    for pair in pairs or []:
        name, _, generic = pair.partition("=")
        if not name or not generic:
            raise SystemExit("--redact takes NAME=GENERIC, got {!r}".format(pair))
        text = re.sub(re.escape(name), generic, text, flags=re.IGNORECASE)
    return text


# ---------------------------------------------------------------------------
# build


def _safe_rel(rel):
    return isinstance(rel, str) and rel and not rel.startswith("/") and ".." not in rel.split("/") and "\n" not in rel


def _scrub_contract(c):
    out = {k: c[k] for k in ("schemaVersion", "runId", "sourceSha", "ownershipKind", "pr", "repoSlug", "createdAt")
           if k in c}
    out["requiredLaneMarkers"] = [m for m in c.get("requiredLaneMarkers") or [] if _safe_rel(m)]
    if isinstance(c.get("lanes"), list):
        out["lanes"] = [{k: lane[k] for k in ("id", "kind", "generation", "evidence") if k in lane}
                        for lane in c["lanes"] if isinstance(lane, dict)]
    return out


def _scrub_marker(m):
    out = {k: m[k] for k in ("lane", "sourceSha", "generation", "status", "completedAt") if k in m}
    if isinstance(m.get("confirmedFindings"), list):
        out["confirmedFindings"] = [f for f in m["confirmedFindings"] if isinstance(f, str)]
    ev = []
    for e in m.get("evidence") or []:
        if not isinstance(e, str):
            continue
        if e.startswith("clip-skipped: "):
            parts = e.split(": ", 2)
            ev.append("clip-skipped: {}: {}".format(parts[1] if len(parts) > 1 else "", "reason-redacted"))
        elif _safe_rel(e) or (e.startswith("/") and "\n" not in e and "\r" not in e):
            # Absolute entries are kept (container paths, no secrets): today's
            # barrier refuses them (smoke-evidence-barrier.sh:191-193), and
            # dropping them would misreport the lane as having no evidence.
            ev.append(e)
    if "evidence" in m:
        out["evidence"] = ev
    return out


def build(args):
    gh = json.load(open(args.gh_actual))
    a2 = json.load(open(args.actuals2))
    turns = json.load(open(args.turns)).get("camp", {}) if args.turns else {}
    runs = sorted(d for d in os.listdir(args.gate_runs)
                  if d.startswith("xzo-pr-") and d.rsplit("-", 1)[1][:8] >= args.since
                  and (not args.until or d.rsplit("-", 1)[1][:8] <= args.until))
    lines = [json.dumps({"provenance": {
        "builtAt": iso(dt.datetime.now(dt.timezone.utc)),
        "window": [args.since, args.until],
        "sources": {
            "runDirs": "campaign workgroup runs/<runId> (read-only; allowlisted fields of contract, markers, challenge.complete, identity-check verdict+readAt; every other file as path+mtime only)",
            "gateVerdicts": "gate agent group runs/<runId>/verdict.json",
            "ghActual": "gh (read-only): PR issue comments in [claim, finish+2h] (time+author), smoke-finding issues created in that window (number+time), PR closedAt/mergedAt/state",
            "posts": "gate agent session outbound.db messages_out kind=chat naming the PR or runId in [claim-5m, finish+2h] (timestamps only); gh pr view headRefOid,headRefName",
            "coordinatorTurns": "the CONTROLLER-SPEC s1 measurement (heuristic turn attribution; pr1483 predates it)",
        },
        "scrub": "allowlisted fields only; clip-skip reasons redacted; no evidence content; install-private names replaced via --redact; refused if any credential pattern matches"},
        "runs": len(runs)}, sort_keys=True)]
    for run in runs:
        w = os.path.join(args.runs_root, run)
        verdict = json.load(open(os.path.join(args.gate_runs, run, "verdict.json")))
        c_raw = json.load(open(os.path.join(w, "completion-contract.json")))
        contract = _scrub_contract(c_raw)
        files = []

        def add(rel, content=None, at=None):
            full = os.path.join(w, rel)
            if at is None:
                if not os.path.exists(full):
                    return
                at = mtime_iso(full)
            entry = {"path": rel, "at": at}
            if content is not None:
                entry["content"] = content
            files.append(entry)

        add("completion-contract.json", contract, contract.get("createdAt") or mtime_iso(os.path.join(w, "completion-contract.json")))
        for rel in contract["requiredLaneMarkers"]:
            full = os.path.join(w, rel)
            if not os.path.isfile(full):
                continue
            try:
                m = _scrub_marker(json.load(open(full)))
            except ValueError:
                add(rel, "unparsable")
                continue
            add(rel, m)
            for e in m.get("evidence") or []:
                if not e.startswith("clip-skipped: ") and os.path.isfile(os.path.join(w, e)) \
                        and os.path.getsize(os.path.join(w, e)) > 0:
                    add(e)
            for f in m.get("confirmedFindings") or []:
                clip = "clips/{}.mp4".format(f)
                if os.path.isfile(os.path.join(w, clip)):
                    add(clip)
        for rel in ("coordinator/preliminary.md", "challenger/disposition.md", "synthesis.md",
                    "contact-sheet/sheet.png", "contact-sheet/critic.json"):
            if os.path.isfile(os.path.join(w, rel)) and os.path.getsize(os.path.join(w, rel)) > 0:
                add(rel)
        cs = os.path.join(w, "contact-sheet")
        if os.path.isdir(cs):
            times = [os.path.getmtime(os.path.join(dp, f)) for dp, _, fs in os.walk(cs) for f in fs]
            if times:
                add("contact-sheet/", None, iso(dt.datetime.fromtimestamp(min(times), dt.timezone.utc)))
        cc = os.path.join(w, "challenger/challenge.complete.json")
        if os.path.isfile(cc):
            try:
                doc = json.load(open(cc))
                add("challenger/challenge.complete.json",
                    {k: doc[k] for k in ("status", "disposition") if k in doc})
            except ValueError:
                add("challenger/challenge.complete.json", "unparsable")
        idc = os.path.join(w, "coordinator/identity-checks.ndjson")
        identity = []
        if os.path.isfile(idc):
            for line in open(idc).read().splitlines():
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict) and d.get("readAt"):
                    identity.append({"at": iso(parse_iso(d["readAt"])), "verdict": d.get("verdict")})
        g = gh.get(run, {})
        x = a2.get(run, {})
        confirmed = sorted({f for fe in files if isinstance(fe.get("content"), dict)
                            for f in fe["content"].get("confirmedFindings") or []})
        entry = {
            "runId": run, "pr": int(re.match(r"xzo-pr-pr(\d+)-", run).group(1)),
            "sourceSha": contract.get("sourceSha"), "claimAt": iso(run_claim_time(run)),
            "isFreezePr": (x.get("headRefName") or "").startswith("smoke/freeze-"),
            "files": sorted({f["path"]: f for f in reversed(files)}.values(), key=lambda f: (f["at"], f["path"])),
            "identityChecks": sorted(identity, key=lambda i: i["at"]),
            "markerConfirmedFindings": confirmed,
            "actual": {
                "verdict": verdict.get("verdict"), "finishedAt": verdict.get("finishedAt"),
                "verdictSha": verdict.get("sha"), "headSha": x.get("headSha"),
                "postTimes": x.get("postTimes") or [],
                "prComments": sorted(c["at"] for c in g.get("prComments") or []),
                "issues": sorted(i["at"] for i in g.get("issues") or []),
                "closedAt": g.get("closedAt"), "mergedAt": g.get("mergedAt"),
                "coordinatorTurns": ([t[0] for t in turns[run]] if run in turns else None),
            },
        }
        lines.append(json.dumps(entry, sort_keys=True, separators=(",", ":")))
    text = redact_names("\n".join(lines) + "\n", args.redact)
    hits = credential_hits(text)
    if hits:
        raise SystemExit("refusing to write: credential-shaped content matched {}".format(hits))
    with open(args.out, "w") as fh:
        fh.write(text)
    print(json.dumps({"ok": True, "runs": len(runs), "bytes": len(text), "out": args.out}))


# ---------------------------------------------------------------------------
# replay barrier


def _load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def replay_barrier(run_dir, phase):
    contract = _load(os.path.join(run_dir, "completion-contract.json"))
    if not isinstance(contract, dict):
        return {"ready": False, "missing": ["completion-contract.json"], "invalid": [], "invalidReasons": []}
    sha = contract.get("sourceSha")
    gens = {lane.get("id"): int(lane.get("generation") or 1) for lane in contract.get("lanes") or []
            if isinstance(lane, dict)}
    missing, invalid, reasons = [], [], []
    for rel in contract.get("requiredLaneMarkers") or []:
        lane_id = os.path.basename(rel)[:-5] if rel.endswith(".json") else os.path.basename(rel)
        m = _load(os.path.join(run_dir, rel))
        if m is None:
            if os.path.exists(os.path.join(run_dir, rel)):
                invalid.append(rel)
                reasons.append("{}: not valid JSON".format(rel))
            else:
                missing.append(rel)
            continue
        problem = None
        if m.get("sourceSha") != sha:
            problem = "sourceSha mismatch"
        elif (m.get("lane") or lane_id) != lane_id:
            problem = "lane id mismatch"
        elif str(m.get("generation") or 1) != str(gens.get(lane_id, 1)):
            problem = "generation {} != contract {}".format(m.get("generation") or 1, gens.get(lane_id, 1))
        elif m.get("status") not in TERMINAL:
            problem = "status {!r} is not terminal".format(m.get("status"))
        elif not m.get("completedAt"):
            problem = "completedAt missing"
        else:
            ev = m.get("evidence") or []
            findings = m.get("confirmedFindings") or []
            if m.get("status") == "pass":
                if not ev:
                    problem = "pass marker with no evidence"
                for e in ev:
                    if e.startswith("clip-skipped: "):
                        if not any(e.startswith("clip-skipped: {}: ".format(f)) for f in findings):
                            problem = "clip-skipped entry names no confirmed finding"
                    elif e.startswith("/") or e in (".", "..") or e.startswith("../") or "/../" in e \
                            or e.endswith("/.."):
                        problem = "pass evidence path is absolute or escapes the run root: {}".format(e)
                    elif not os.path.isfile(os.path.join(run_dir, e)):
                        problem = "pass evidence missing: {}".format(e)
                    if problem:
                        break
            if not problem:
                for f in findings:
                    if any(e.startswith("clip-skipped: {}: ".format(f)) for e in ev):
                        continue
                    if "clips/{}.mp4".format(f) not in ev or not os.path.isfile(
                            os.path.join(run_dir, "clips/{}.mp4".format(f))):
                        problem = "confirmed finding {} has no clip evidence".format(f)
                        break
        if problem:
            invalid.append(rel)
            reasons.append("{}: {}".format(rel, problem))
    if phase == "synthesis":
        for rel in ("coordinator/preliminary.md", "challenger/disposition.md"):
            if not os.path.isfile(os.path.join(run_dir, rel)):
                missing.append(rel)
    return {"ready": not missing and not invalid, "phase": phase, "missing": missing, "invalid": invalid,
            "invalidReasons": reasons}


# ---------------------------------------------------------------------------
# run


def load_controller():
    # No __pycache__ beside the shipped scripts (smoke-acceptance.test.sh
    # rejects bytecode there), however the replay is invoked.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("smoke_campaign_controller", CONTROLLER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.BARRIER_OVERRIDE = replay_barrier
    return mod


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        if content is None:
            fh.write("x\n")
        elif isinstance(content, str):
            fh.write(content + "\n")
        else:
            json.dump(content, fh)


def _synthesis_doc(entry, verdict, mode):
    contract = next(f["content"] for f in entry["files"] if f["path"] == "completion-contract.json")
    gens = {lane["id"]: int(lane.get("generation") or 1) for lane in contract.get("lanes") or [] if "id" in lane}
    for rel in contract.get("requiredLaneMarkers") or []:
        lane_id = os.path.basename(rel)[:-5] if rel.endswith(".json") else os.path.basename(rel)
        gens.setdefault(lane_id, 1)
    return {"schemaVersion": 1, "runId": entry["runId"], "sourceSha": entry["sourceSha"], "verdict": verdict,
            "laneGenerations": gens,
            "findings": [{"id": f, "confirmed": True} for f in entry["markerConfirmedFindings"]] + (
                # faithful only: one confirmed finding per issue the campaign
                # actually filed, so issue filing is exercised. History never
                # recorded its finding list in machine-readable form; go-probe
                # omits these so its GO refusals rest on real gaps only.
                [{"id": "hist-issue-{}".format(n), "confirmed": True, "blocking": False}
                 for n in range(1, len(entry["actual"].get("issues") or []) + 1)] if mode == "faithful" else []),
            "gaps": [], "dissents": []}


FAKES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "controller-live-fakes.py")
LIVE_TOKEN = "owner-replay"


def _fake_writes(log):
    if not os.path.exists(log):
        return 0
    return sum(1 for line in open(log) if json.loads(line)["op"] in (
        "enqueued", "commented", "created", "closed", "finish", "challenger-timeout", "fail-after"))


def _fake_duplicates(fake, log):
    """Effects performed more than once, read from the fakes' own state."""
    def load(name, default):
        try:
            return json.load(open(os.path.join(fake, name)))
        except FileNotFoundError:
            return default
    dups = 0
    keys = {}
    for mid in load("enqueue.json", {"messages": {}})["messages"]:
        k = mid.split("#")[0]
        keys[k] = keys.get(k, 0) + 1
    dups += sum(n - 1 for n in keys.values())
    gh = load("gh.json", {"comments": {}, "issues": []})
    bodies = [c["body"] for cs in gh["comments"].values() for c in cs] + [i["body"] for i in gh["issues"]]
    markers = {}
    for b in bodies:
        for m in re.findall(r"<!-- smoke-ctl:[0-9a-f]{64} -->", b):
            markers[m] = markers.get(m, 0) + 1
    dups += sum(n - 1 for n in markers.values())
    calls = [json.loads(line) for line in open(log)] if os.path.exists(log) else []
    dups += max(0, sum(1 for c in calls if c["tool"] == "gate" and c["op"] in ("finish", "challenger-timeout")) - 1)
    names = {}
    for t in load("ncl.json", {"tasks": []})["tasks"]:
        names[t["name"]] = names.get(t["name"], 0) + 1
    dups += sum(n - 1 for n in names.values())
    return dups, {"sends": len(load("enqueue.json", {"messages": {}})["messages"]), "ghWrites": len(bodies),
                  "tasks": sum(names.values()), "gateTerminal": sum(
                      1 for c in calls if c["tool"] == "gate" and c["op"] in ("finish", "challenger-timeout"))}


def _live_inputs(fake, base):
    try:
        msgs = json.load(open(os.path.join(fake, "enqueue.json")))["messages"]
    except FileNotFoundError:
        msgs = {}
    with open(os.path.join(base, "receipts.json"), "w") as fh:
        json.dump({mid: "delivered" for mid in msgs}, fh)
    try:
        tasks = json.load(open(os.path.join(fake, "ncl.json")))["tasks"]
    except FileNotFoundError:
        tasks = []
    with open(os.path.join(base, "tasks.json"), "w") as fh:
        json.dump([{"id": t["series_id"], "name": t["series_id"], "status": t["status"]} for t in tasks], fh)


def replay_one(ctl, entry, mode, work, effects="shadow"):
    run, pr, sha = entry["runId"], entry["pr"], entry["sourceSha"]
    live = effects == "live"
    base = os.path.join(work, "live", mode, run) if live else os.path.join(work, mode, run)
    state, root, out = (os.path.join(base, d) for d in ("state", "runs", "out"))
    run_dir = os.path.join(root, run)
    os.makedirs(state)
    os.makedirs(root)
    claim_at = parse_iso(entry["claimAt"])
    actual = entry["actual"]
    fin_at = parse_iso(actual["finishedAt"])
    deadline = claim_at + dt.timedelta(seconds=CHALLENGER_TIMEOUT_SECONDS)

    def call(argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ctl.main(argv)
        text = buf.getvalue().strip()
        return rc, (json.loads(text.splitlines()[-1]) if text else {})

    fake = os.path.join(base, "fake")
    flog = os.path.join(fake, "calls.ndjson")
    live_argv = []
    if live:
        os.makedirs(fake)
        os.environ.update({"SMOKE_CONTROLLER_MODE": "live", "FAKE_STATE": fake, "FAKE_LOG": flog,
                           "FAKE_GATE_STATE": state})
        with open(os.path.join(fake, "gh.json"), "w") as fh:
            json.dump({"comments": {}, "issues": [], "prs": {str(pr): {"state": "OPEN"}}}, fh)
        gate_sh = os.path.join(base, "gate.sh")
        with open(gate_sh, "w") as fh:
            fh.write("#!/usr/bin/env bash\nexec python3 {} gate \"$@\"\n".format(FAKES_PATH))
        with open(os.path.join(base, "cutover.json"), "w") as fh:
            json.dump({"legacyRuns": []}, fh)
        live_argv = ["--cutover-json", os.path.join(base, "cutover.json"), "--repo", "acme/app",
                     "--send-to", "campaign-room", "--gate-cmd", gate_sh,
                     "--gh-cmd", "python3 " + FAKES_PATH + " gh", "--ncl-cmd", "python3 " + FAKES_PATH + " ncl",
                     "--enqueue-cmd", "python3 " + FAKES_PATH + " enqueue",
                     "--receipts-json", os.path.join(base, "receipts.json"),
                     "--tasks-json", os.path.join(base, "tasks.json")]
        rc, _ = call(["init", "--out-dir", out, "--gate-state-dir", state])
    else:
        rc, _ = call(["init", "--shadow", "--out-dir", out, "--gate-state-dir", state])
    assert rc == 0
    heads = os.path.join(base, "heads.json")
    with open(heads, "w") as fh:
        json.dump({str(pr): actual.get("headSha") or sha}, fh)
    wake = os.path.join(base, "wake.json")
    with open(wake, "w") as fh:
        json.dump({"wakeAgent": True, "data": {"trigger": "pr_build_settled", "runId": run, "pr": pr,
                                               "sourceSha": sha, "isFreezePr": entry["isFreezePr"],
                                               "coordinatorOwnerToken": LIVE_TOKEN}}, fh)
    state_file = os.path.join(state, "pr-{}-state.json".format(pr))
    with open(state_file, "w") as fh:
        json.dump({"schemaVersion": 1, "pr": pr, "activeRunId": run, "activeSha": sha,
                   "challengerDeadline": iso(deadline), "challengerDisposition": None,
                   "activeLeaseOwner": LIVE_TOKEN, "activeClaimant": "controller"}, fh)

    # A file's recorded time is its LAST write. Evidence a marker cites existed
    # when the marker was written, so it appears no later than that marker
    # (otherwise a later rewrite reads as a transient "evidence missing").
    cited_by = {}
    for f in entry["files"]:
        if isinstance(f.get("content"), dict):
            for e in f["content"].get("evidence") or []:
                cited_by[e] = min(cited_by.get(e, f["at"]), f["at"])
    events = [(min(parse_iso(f["at"]), parse_iso(cited_by.get(f["path"], f["at"]))), "file", f)
              for f in entry["files"]]
    events += [(parse_iso(i["at"]), "identity", i) for i in entry["identityChecks"]]
    syn = next((f for f in entry["files"] if f["path"] == "synthesis.md"), None)
    if syn:
        proposed = actual["verdict"] if mode == "faithful" else "GO"
        # synthesis.md's mtime is its LAST write; 10 of the 27 that have one rewrote it
        # after finish. The verdict came from it, so it existed by finishedAt.
        events.append((min(parse_iso(syn["at"]), fin_at), "synthesis", _synthesis_doc(entry, proposed, mode)))
    # The historical `finish` is NOT replayed: in the world under evaluation
    # there is no legacy coordinator, so the controller must reach finish (or
    # challenger-timeout) itself or that counts as a missed obligation. The
    # actual verdict and finishedAt are kept for comparison only.
    events.sort(key=lambda e: e[0])

    fires, dup_records, dup_effects, hard_errors = [], 0, 0, []
    t = claim_at
    ei = 0
    first = True
    horizon = max(fin_at, events[-1][0]) + dt.timedelta(hours=2)
    journal = os.path.join(out, "journal.ndjson")
    while t <= horizon and len(fires) < 2000:
        while ei < len(events) and events[ei][0] <= t:
            _, kind, payload = events[ei]
            if kind == "file":
                if payload["path"].endswith("/"):
                    os.makedirs(os.path.join(run_dir, payload["path"]), exist_ok=True)
                else:
                    _write(os.path.join(run_dir, payload["path"]), payload.get("content"))
            elif kind == "identity":
                p = os.path.join(run_dir, "coordinator/identity-checks.ndjson")
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "a") as fh:
                    fh.write(json.dumps({"verdict": payload["verdict"], "readAt": payload["at"]}) + "\n")
            elif kind == "synthesis":
                _write(os.path.join(run_dir, "synthesis.json"), payload)
            ei += 1
        if live:
            # The retained owner acks each brief as its first act (router).
            ctl_dir = os.path.join(run_dir, "controller")
            for name in os.listdir(ctl_dir) if os.path.isdir(ctl_dir) else []:
                if name.startswith("brief-") and name.endswith(".md"):
                    open(os.path.join(ctl_dir, name[:-3] + ".ack"), "a").close()
            _live_inputs(fake, base)
        argv = ["step"] + ([] if live else ["--shadow"]) + ["--out-dir", out, "--gate-state-dir", state,
                                                            "--run-root", root, "--pr-heads-json", heads,
                                                            "--now", iso(t), "--fire", iso(t)] + live_argv
        if first:
            argv += ["--poll-json", wake]
        results = []
        for rep in (0, 1):  # every fire replayed twice, on the same inputs
            before = sum(1 for _ in open(journal))
            wbefore = _fake_writes(flog) if live else 0
            rc, res = call(argv)
            after = sum(1 for _ in open(journal))
            if rc != 0 or res.get("skipped"):  # a skipped fire is a replay that did not happen
                hard_errors.append({"at": iso(t), "rc": rc, "result": res})
            if rep == 1:
                dup_records += after - before
                dup_effects += res.get("effectsRefused", 0) if not live else _fake_writes(flog) - wbefore
            results.append(res)
        fires.append({"at": iso(t), "runs": results[0].get("runs", []), "alarms": results[0].get("alarms", [])})
        first = False
        done = [json.loads(l) for l in open(journal)]
        if any(r["kind"] == "run" and r["state"] == "done" for r in done):
            break  # shadow journals post-finish obligations in the finishing fire
        t += dt.timedelta(seconds=FIRE_SECONDS)
    records = [json.loads(l) for l in open(journal)]
    dpath = os.path.join(out, run, "decisions.ndjson")
    decisions = [json.loads(l) for l in open(dpath)] if os.path.exists(dpath) else []
    result = summarize(entry, mode, records, decisions, fires, dup_records, dup_effects, hard_errors)
    if live:
        os.environ.pop("SMOKE_CONTROLLER_MODE", None)
        fake_dups, counts = _fake_duplicates(fake, flog)
        result["duplicateEffects"] += fake_dups
        result["liveEffects"] = counts
    return result


def summarize(entry, mode, records, decisions, fires, dup_records, dup_effects, hard_errors):
    actual = entry["actual"]
    first_decision = {}
    for d in decisions:
        first_decision.setdefault((d["type"], d.get("slot") or d.get("step") or d.get("verb")), d)
    gate_done = [r for r in records if r["kind"] == "gate" and r["state"] == "done"]
    run_done = [r for r in records if r["kind"] == "run" and r["state"] == "done"]
    finished_by = (run_done[0].get("detail") or {}).get("finishedBy") if run_done else None
    ctl_verdict = (gate_done[-1].get("detail") or {}).get("verdict") if gate_done else None
    ctl_finish_at = gate_done[-1]["at"] if gate_done else None
    ctl_verb = gate_done[-1]["slot"] if gate_done else None
    failed_checks = next((d.get("failedChecks") for d in reversed(decisions) if d["type"] == "finish"), None)

    # Duplicates: two intents for one key+attempt, or two effect decisions for
    # one key+attempt that were not a post-reconcile marker search.
    seen, dup_intents = set(), 0
    for r in records:
        detail = r.get("detail") or {}
        # An alarm's obligation record (detail.alarm, no attempt: journaled
        # before, and independently of, any delivery attempt) is not an
        # attempt intent -- the attempt that follows it is the first one.
        if detail.get("alarm") and not r.get("attempt"):
            continue
        if r["state"] == "intent" and not (r.get("detail") or {}).get("ambiguous") \
                and not (r.get("detail") or {}).get("overdue") and not (r.get("detail") or {}).get("outcome"):
            k = (r["key"], r.get("attempt", 1))
            dup_intents += k in seen
            seen.add(k)
    eff, dup_eff_log = set(), 0
    for d in decisions:
        if d.get("effect") and not d.get("afterReconcile"):
            k = (d["type"], d.get("key") or d.get("verb") or d.get("slot"), d.get("attempt", 1))
            dup_eff_log += k in eff
            eff.add(k)

    done_slots = {(r["kind"], r["slot"]) for r in records if r["state"] in ("done", "delivered")}
    issues_ctl = sum(1 for (k, s) in done_slots if k == "gh" and s.startswith("issue:"))
    missed = []
    if actual.get("prComments") and ("gh", "pr-comment") not in done_slots:
        missed.append("pr-comment")
    if actual.get("closedAt") and not actual.get("mergedAt") and entry["isFreezePr"] \
            and ("gh", "freeze-close") not in done_slots:
        missed.append("freeze-close")
    if actual.get("postTimes") and ("send", "root") not in done_slots:
        missed.append("root-post")
    if actual.get("postTimes") and ("send", "verdict") not in done_slots:
        missed.append("verdict-post")
    if ("gate", "finish") not in done_slots and ("gate", "challenger-timeout") not in done_slots:
        missed.append("finish")
    issues_missed = max(0, len(actual.get("issues") or []) - issues_ctl)

    escalations = [d for d in decisions if d["class"] == "coordination_model"]
    esc_reasons = sorted({d["reason"] for d in escalations})
    owner_wakes = sum(1 for d in decisions if d["type"] == "wake_owner")
    dispatches = sum(1 for d in decisions if d["type"] == "dispatch")

    def lag(dec_key, actual_at):
        d = first_decision.get(dec_key)
        if not d or not actual_at:
            return None
        return round((parse_iso(d["at"]) - parse_iso(actual_at)).total_seconds() / 60)

    posts = actual.get("postTimes") or []
    return {
        "runId": entry["runId"], "mode": mode,
        "actualVerdict": actual["verdict"], "controllerVerdict": ctl_verdict, "controllerVerb": ctl_verb,
        "finishedBy": finished_by, "failedChecks": failed_checks,
        "falseGo": ctl_verdict == "GO" and actual["verdict"] != "GO",
        "verdictMismatch": ctl_verdict is not None and ctl_verdict != actual["verdict"],
        "finishLagMin": (round((parse_iso(ctl_finish_at) - parse_iso(actual["finishedAt"])).total_seconds() / 60)
                         if ctl_finish_at else None),
        "rootLagMin": lag(("send", "root"), posts[0] if posts else None),
        "fires": len(fires),
        "duplicateRecordsOnReplay": dup_records, "duplicateEffectsOnReplay": dup_effects,
        "duplicateIntents": dup_intents, "duplicateEffects": dup_eff_log,
        "hardErrors": hard_errors,
        "missedObligations": missed, "issuesActual": len(actual.get("issues") or []),
        "issuesController": issues_ctl, "issuesMissed": issues_missed,
        "escalations": len({(d["reason"], d.get("slot")) for d in escalations}), "escalationReasons": esc_reasons,
        "ownerWakes": owner_wakes, "dispatches": dispatches,
        "actualCoordinatorTurns": (len(actual["coordinatorTurns"]) if actual.get("coordinatorTurns") is not None
                                   else None),
        "alarms": sorted({a.get("trigger") for f in fires for a in f["alarms"]}),
    }


def run(args):
    with open(args.corpus) as fh:
        lines = [json.loads(l) for l in fh if l.strip()]
    entries = [e for e in lines if "runId" in e]
    if args.runs:
        wanted = set(args.runs.split(","))
        entries = [e for e in entries if e["runId"] in wanted or str(e["pr"]) in wanted]
    ctl = load_controller()
    work = tempfile.mkdtemp(prefix="ctl-replay-")
    try:
        results = [replay_one(ctl, e, mode, work, args.effects) for mode in args.modes.split(",") for e in entries]
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    report = aggregate(results)
    report["work"] = work if args.keep else None
    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump({"report": report, "runs": results}, fh, indent=1, sort_keys=True)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["pass"] else 1


def aggregate(results):
    by_mode = {}
    for r in results:
        by_mode.setdefault(r["mode"], []).append(r)
    report = {"modes": {}}
    ok = True
    for mode, rs in by_mode.items():
        turns = [r["actualCoordinatorTurns"] for r in rs if r["actualCoordinatorTurns"] is not None]
        esc_with_turns = [r["escalations"] for r in rs if r["actualCoordinatorTurns"] is not None]
        m = {
            "campaigns": len(rs),
            "falseGo": sum(r["falseGo"] for r in rs),
            "controllerGo": sum(r["controllerVerdict"] == "GO" for r in rs),
            "actualGo": sum(r["actualVerdict"] == "GO" for r in rs),
            "verdictMismatches": sum(r["verdictMismatch"] for r in rs),
            "mismatchDetail": sorted("{} {}->{} ({})".format(r["runId"][7:14], r["actualVerdict"], r["controllerVerdict"],
                                                             r["controllerVerb"]) for r in rs if r["verdictMismatch"]),
            "finishedByController": sum(r["finishedBy"] == "controller" for r in rs),
            "finishedByGateFirst": sum(r["finishedBy"] == "gate" for r in rs),
            "duplicates": sum(r["duplicateRecordsOnReplay"] + r["duplicateEffectsOnReplay"] + r["duplicateIntents"]
                              + r["duplicateEffects"] for r in rs),
            "hardErrors": sum(len(r["hardErrors"]) for r in rs),
            "missedObligations": sorted("{}:{}".format(r["runId"][7:14], o) for r in rs for o in r["missedObligations"]),
            "issuesActual": sum(r["issuesActual"] for r in rs),
            "issuesController": sum(r["issuesController"] for r in rs),
            "issuesMissed": sum(r["issuesMissed"] for r in rs),
            "campaignsWithEscalation": sum(r["escalations"] > 0 for r in rs),
            "escalations": sum(r["escalations"] for r in rs),
            "escalationReasons": sorted({x for r in rs for x in r["escalationReasons"]}),
            "coordinationWakesOnTurnRuns": sum(esc_with_turns),
            "actualCoordinatorTurns": sum(turns), "campaignsWithTurnData": len(turns),
            "ownerWakes": sum(r["ownerWakes"] for r in rs), "dispatches": sum(r["dispatches"] for r in rs),
            "fires": sum(r["fires"] for r in rs),
            "finishLagMin": _dist([r["finishLagMin"] for r in rs if r["finishLagMin"] is not None]),
            "rootLagMin": _dist([r["rootLagMin"] for r in rs if r["rootLagMin"] is not None]),
            "alarms": sorted({a for r in rs for a in r["alarms"]}),
        }
        live_counts = [r["liveEffects"] for r in rs if "liveEffects" in r]
        if live_counts:
            m["liveEffects"] = {k: sum(c[k] for c in live_counts) for k in live_counts[0]}
        m["pass"] = m["falseGo"] == 0 and m["duplicates"] == 0 and m["hardErrors"] == 0
        ok = ok and m["pass"]
        report["modes"][mode] = m
    report["pass"] = ok
    return report


def _dist(xs):
    if not xs:
        return None
    xs = sorted(xs)
    return {"n": len(xs), "min": xs[0], "p50": xs[len(xs) // 2], "max": xs[-1]}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build")
    b.add_argument("--runs-root", required=True)
    b.add_argument("--gate-runs", required=True)
    b.add_argument("--gh-actual", required=True)
    b.add_argument("--actuals2", required=True)
    b.add_argument("--turns")
    b.add_argument("--since", default="20260905")
    b.add_argument("--until", default="")
    b.add_argument("--out", required=True)
    b.add_argument("--redact", action="append", default=[], metavar="NAME=GENERIC",
                   help="replace an install-private name everywhere in the corpus (repeatable)")
    rd = sub.add_parser("redact", help="apply --redact pairs to an existing corpus in place")
    rd.add_argument("path")
    rd.add_argument("--redact", action="append", required=True, metavar="NAME=GENERIC")
    r = sub.add_parser("run")
    r.add_argument("--corpus", required=True)
    r.add_argument("--modes", default="faithful,go-probe")
    r.add_argument("--runs")
    r.add_argument("--json-out")
    r.add_argument("--keep", action="store_true")
    r.add_argument("--effects", choices=("shadow", "live"), default="shadow",
                   help="live: run the controller in live mode against the recording fakes")
    s = sub.add_parser("scan", help="exit 1 if the file holds credential-shaped content")
    s.add_argument("path")
    bb = sub.add_parser("barrier", help="the replay readiness check, for inspection")
    bb.add_argument("run_dir")
    bb.add_argument("phase")
    args = p.parse_args(argv)
    if args.command == "build":
        build(args)
        return 0
    if args.command == "run":
        return run(args)
    if args.command == "redact":
        text = open(args.path).read()
        with open(args.path, "w") as fh:
            fh.write(redact_names(text, args.redact))
        return 0
    if args.command == "scan":
        hits = credential_hits(open(args.path).read())
        print(json.dumps({"ok": not hits, "hits": hits}))
        return 1 if hits else 0
    print(json.dumps(replay_barrier(args.run_dir, args.phase)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
