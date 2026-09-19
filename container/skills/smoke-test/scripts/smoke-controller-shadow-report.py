#!/usr/bin/env python3
"""Score the live controller shadow against what the legacy coordinator did.

  collect  HOST-side, read-only: gather what actually happened for every PR
           campaign the gate finished in [--since, --until] -- the gate
           verdict, PR comments / close / merge and smoke-finding issues (gh),
           chat posts (the gate agent's outbound.db files, opened read-only),
           coordinator turns (its transcripts) and owner steps (run artifacts).
           Writes one JSON object keyed by runId, each value the shape of a
           replay-corpus `actual` block plus pr/isFreezePr/ownerSteps.
  report   compare the shadow's journal and decisions (smoke-controller-shadow.sh
           out-dir) with those actuals and print the CONTROLLER-SPEC s3 pass
           bars as Markdown (--md) and JSON (--json).

Per-campaign scoring is the replay's own `summarize`
(smoke-campaign-replay.py:480-557), imported, so a live number and a replay
number mean the same thing: missed obligations (pr-comment, freeze-close,
root post, verdict post, finish, issues), controller-caused duplicates (two
intents or two effect decisions for one key+attempt), false GO, escalations
(coordination-model wakes) and finish/root lag. On top of it:

  - a campaign the gate finished that the shadow journal never claimed is a
    missed obligation (`claim-not-journaled`), not a silent gap;
  - false GO also counts any `finish` decision with verdict GO that carried a
    failed check (the spec's "or any validation check failed");
  - a campaign with no collected actuals is scored `incomplete`, and the bar
    it feeds reads UNKNOWN, never PASS;
  - duplicates are scanned over every shadow journal and decision record in
    the window, active and stuck campaigns included, not only finished ones;
  - verdict agreement: actual non-GO -> controller GO is false GO (FAIL);
    actual GO -> controller non-GO is expected under the stricter GO rule but
    must name its failed check (none named: FAIL), and every such mismatch
    turns an otherwise-passing report into `pass: "needs-review"`;
  - fire health comes from the wrapper's fires.ndjson: hard errors (controller
    rc != 0), journal errors, decision-less fires, and any re-init after the
    first (a journal treated as empty).

Coordinator turns are counted the way the CONTROLLER-SPEC s1 measurement did
(the replay's `coordinatorTurns`, len of that list): a turn starts at a user
message that is not a tool result, a skill preamble or a continuation
summary; it belongs to a campaign when its text or any of its tool inputs
names the runId. Attribution is heuristic, as in s1.
"""

import argparse
import datetime as dt
import glob
import importlib.util
import json
import os
import re
import sqlite3
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPLAY_PATH = os.path.join(SCRIPT_DIR, "smoke-campaign-replay.py")
FIRE_SECONDS = 600
POST_WINDOW_AFTER = dt.timedelta(hours=2)
POST_WINDOW_BEFORE = dt.timedelta(minutes=5)
COORDINATION_REDUCTION_BAR = 0.80
RUN_PR_RE = re.compile(r"-pr(\d+)-")


def parse_iso(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def claim_time(run_id):
    try:
        return dt.datetime.strptime(run_id.rsplit("-", 1)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    except (IndexError, ValueError):
        return None


def load_replay():
    spec = importlib.util.spec_from_file_location("smoke_campaign_replay", REPLAY_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_ndjson(path):
    out = []
    try:
        with open(path) as fh:
            for line in fh:
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        out.append({"_unparsable": True})
    except OSError:
        pass
    return out


def finished_runs(gate_state_dir, since, until):
    """runId -> gate verdict.json, for runs the gate finished inside the window."""
    out = {}
    for path in sorted(glob.glob(os.path.join(gate_state_dir, "runs", "*", "verdict.json"))):
        doc = read_json(path)
        fin = parse_iso((doc or {}).get("finishedAt"))
        run_id = os.path.basename(os.path.dirname(path))
        if not fin or not RUN_PR_RE.search(run_id):
            continue
        if fin >= since and (until is None or fin <= until):
            out[run_id] = doc
    return out


# ---------------------------------------------------------------------------
# collect (host)


def gh_json(argv, timeout=30):
    try:
        proc = subprocess.run(["gh"] + argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)
    if proc.returncode != 0:
        return None, proc.stderr.strip()[:200]
    try:
        return json.loads(proc.stdout), None
    except ValueError as exc:
        return None, "unparsable gh output: {}".format(exc)


def count_turns(transcript_files, run_ids):
    """runId -> [turn start timestamps] (the s1 turn boundary and attribution)."""
    turns = {r: [] for r in run_ids}
    seen = set()
    for path in transcript_files:
        cur = None

        def flush(c):
            if not c or not c["ts"]:
                return
            key = (path, c["ts"])
            if key in seen:
                return
            seen.add(key)
            for r in run_ids:
                if r in c["text"]:
                    turns[r].append(c["ts"])

        try:
            fh = open(path, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "user":
                    c = (e.get("message") or {}).get("content")
                    text = None
                    if isinstance(c, str):
                        text = c
                    elif isinstance(c, list):
                        texts = [x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text"]
                        if texts and not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                            text = texts[0]
                    if text is None:
                        continue
                    if text.startswith(("Base directory for this skill", "Continue from where",
                                        "This session is being continued")):
                        continue
                    flush(cur)
                    cur = {"ts": e.get("timestamp"), "text": text}
                elif e.get("type") == "assistant" and cur:
                    for x in (e.get("message") or {}).get("content") or []:
                        if isinstance(x, dict) and x.get("type") == "tool_use":
                            cur["text"] += "\n" + json.dumps(x.get("input"))
            flush(cur)
    return {r: sorted(ts) for r, ts in turns.items()}


def chat_posts(outbound_dbs, run_id, pr, start, end):
    times = set()
    # A digit boundary: "#7" must not match "#77".
    needle = re.compile(r"{}|(?:#|/pull/){}(?!\d)".format(re.escape(run_id), pr))
    for db in outbound_dbs:
        try:
            con = sqlite3.connect("file:{}?mode=ro".format(db), uri=True, timeout=5)
        except sqlite3.Error:
            continue
        try:
            rows = con.execute("SELECT timestamp, content FROM messages_out WHERE kind = 'chat'").fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            con.close()
        for ts, content in rows:
            t = parse_iso(ts)
            if t and start <= t <= end and needle.search(content or ""):
                times.add(iso(t))
    return sorted(times)


def owner_steps(run_dir):
    if not run_dir or not os.path.isdir(run_dir):
        return None
    contract = read_json(os.path.join(run_dir, "completion-contract.json"))
    markers = [m for m in (contract or {}).get("requiredLaneMarkers") or [] if isinstance(m, str)]
    return {
        "intake": contract is not None,
        "lanes": bool(markers) and all(os.path.isfile(os.path.join(run_dir, m)) for m in markers),
        "preliminary": os.path.isfile(os.path.join(run_dir, "coordinator", "preliminary.md")),
        "synthesis": any(os.path.isfile(os.path.join(run_dir, p)) for p in
                         ("synthesis.json", "synthesis.md", "coordinator/synthesis.md")),
    }


def collect(args):
    since = parse_iso(args.since)
    until = parse_iso(args.until) if args.until else None
    runs = finished_runs(args.gate_state_dir, since, until)
    dbs = sorted(glob.glob(os.path.join(args.sessions_root, "sess-*", "outbound.db"))) if args.sessions_root else []
    transcripts = []
    if args.sessions_root:
        transcripts = [p for p in glob.glob(os.path.join(args.sessions_root, "sess-*", ".claude-projects", "**",
                                                         "*.jsonl"), recursive=True) if "/subagents/" not in p]
    turns = count_turns(transcripts, list(runs)) if transcripts else {}
    issues, issues_err = None, None
    if args.repo:
        issues, issues_err = gh_json(["issue", "list", "-R", args.repo, "--label", "smoke-finding", "--state", "all",
                                      "--search", "created:>={}".format(since.strftime("%Y-%m-%d")),
                                      "--json", "number,createdAt,body", "--limit", "1000"])
    out = {}
    for run_id, verdict in sorted(runs.items()):
        pr = int(RUN_PR_RE.search(run_id).group(1))
        claim = claim_time(run_id)
        fin = parse_iso(verdict.get("finishedAt"))
        window = (claim or fin, fin + POST_WINDOW_AFTER)
        entry = {"pr": pr, "verdict": verdict.get("verdict"), "finishedAt": verdict.get("finishedAt"),
                 "verdictSha": verdict.get("sha"), "gaps": []}
        if args.repo:
            view, err = gh_json(["pr", "view", str(pr), "-R", args.repo, "--json",
                                 "comments,closedAt,mergedAt,headRefOid,headRefName"])
            if view is None:
                entry["gaps"].append("gh pr view: {}".format(err))
            else:
                entry["prComments"] = sorted(c["createdAt"] for c in view.get("comments") or []
                                             if window[0] <= (parse_iso(c.get("createdAt")) or window[0] - dt.timedelta(1)) <= window[1])
                entry.update({"closedAt": view.get("closedAt"), "mergedAt": view.get("mergedAt"),
                              "headSha": view.get("headRefOid"),
                              "isFreezePr": str(view.get("headRefName") or "").startswith("smoke/freeze-")})
            if issues is None:
                entry["gaps"].append("gh issue list: {}".format(issues_err))
            else:
                mine = []
                for i in issues:
                    t = parse_iso(i.get("createdAt"))
                    body = i.get("body") or ""
                    other = any(r in body for r in runs if r != run_id) and run_id not in body
                    if t and window[0] <= t <= window[1] and not other:
                        mine.append(i["createdAt"])
                entry["issues"] = sorted(mine)
        else:
            entry["gaps"].append("no --repo: PR comments, close state and issues not collected")
        if dbs:
            entry["postTimes"] = chat_posts(dbs, run_id, pr, (claim or fin) - POST_WINDOW_BEFORE, fin + POST_WINDOW_AFTER)
        else:
            entry["gaps"].append("no outbound.db under --sessions-root: posts not collected")
        if transcripts:
            entry["coordinatorTurns"] = turns.get(run_id, [])
        else:
            entry["gaps"].append("no transcripts under --sessions-root: coordinator turns not collected")
        entry["ownerSteps"] = owner_steps(os.path.join(args.run_root, run_id) if args.run_root else None)
        out[run_id] = entry
    text = json.dumps(out, indent=1, sort_keys=True)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


# ---------------------------------------------------------------------------
# report


REQUIRED_ACTUALS = ("postTimes", "prComments", "issues")


def score(replay, run_id, verdict, actual, records, decisions):
    pr = int(RUN_PR_RE.search(run_id).group(1))
    act = {
        "verdict": verdict.get("verdict"), "finishedAt": verdict.get("finishedAt"),
        "verdictSha": verdict.get("sha"), "headSha": actual.get("headSha"),
        "postTimes": actual.get("postTimes") or [], "prComments": actual.get("prComments") or [],
        "issues": actual.get("issues") or [], "closedAt": actual.get("closedAt"), "mergedAt": actual.get("mergedAt"),
        "coordinatorTurns": actual.get("coordinatorTurns"),
    }
    claim_rec = next((r for r in records if r.get("kind") == "run" and r.get("slot") == "claim"), None)
    is_freeze = actual.get("isFreezePr")
    if is_freeze is None and claim_rec:
        is_freeze = bool((claim_rec.get("detail") or {}).get("isFreezePr"))
    entry = {"runId": run_id, "pr": pr, "isFreezePr": bool(is_freeze), "actual": act}
    alarms = [{"trigger": d.get("reason")} for d in decisions if d.get("type") == "alarm"]
    fires = [{"alarms": alarms}] + [{"alarms": []}] * max(0, len({d.get("fire") for d in decisions}) - 1)
    s = replay.summarize(entry, "live", records, decisions, fires, 0, 0, [])
    s["pr"] = pr
    s["observed"] = claim_rec is not None
    s["claimOrigin"] = (claim_rec.get("detail") or {}).get("origin") if claim_rec else None
    if not s["observed"]:
        s["missedObligations"] = ["claim-not-journaled"] + s["missedObligations"]
    missing = [k for k in REQUIRED_ACTUALS if k not in actual]
    s["incomplete"] = bool(missing) or not actual
    s["actualsMissing"] = missing if actual else ["all"]
    s["actualsGaps"] = actual.get("gaps") or []
    go_with_failed = [d for d in decisions if d.get("type") == "finish" and d.get("verdict") == "GO"
                      and (d.get("failedChecks") or act["verdict"] != "GO")]
    s["falseGo"] = bool(s["falseGo"] or go_with_failed)
    s["ownerStepsActual"] = actual.get("ownerSteps")
    return s


def fire_health(fires, since, until):
    inside = [f for f in fires if not f.get("_unparsable") and parse_iso(f.get("fire")) and
              parse_iso(f.get("fire")) >= since and (until is None or parse_iso(f.get("fire")) <= until)]
    skipped = {}
    for f in inside:
        if not f.get("stepped"):
            skipped[f.get("skipped") or f.get("controllerError") or "unknown"] = \
                skipped.get(f.get("skipped") or f.get("controllerError") or "unknown", 0) + 1
    inits = [f for f in fires if f.get("initialized")]
    return {
        "fires": len(inside),
        "stepped": sum(1 for f in inside if f.get("stepped") and not f.get("controllerError")),
        "decisionLess": sum(1 for f in inside if not f.get("stepped")),
        "skippedReasons": skipped,
        "hardErrors": sum(1 for f in inside if f.get("controllerError")),
        "journalErrors": sum(1 for f in inside if f.get("controllerError") == "controller_journal_error"),
        "reinitsAfterFirst": max(0, len(inits) - 1),
        "unparsableFireLines": sum(1 for f in fires if f.get("_unparsable")),
        "maxElapsedSeconds": max([f.get("elapsedSeconds") or 0 for f in inside] or [0]),
    }


def bar(ok, unknown=False):
    return "UNKNOWN" if unknown else ("PASS" if ok else "FAIL")


def window_duplicates(shadow_dir, journal, since, until):
    """Controller-caused duplicates over EVERY shadow record in the window,
    not just finished campaigns: a stuck or still-active campaign counts too.
    Same two rules as the replay (smoke-campaign-replay.py:494-509): a second
    plain intent for one key+attempt, or a second effect decision for one
    type+key+attempt that was not a post-reconcile marker search. A repeat
    counts when the repeating record falls inside the window."""
    def inside(rec):
        t = parse_iso(rec.get("at"))
        return t is not None and t >= since and (until is None or t <= until)

    by_run = {}
    seen, intents = set(), 0
    for r in journal:
        if r.get("_unparsable") or r.get("state") != "intent":
            continue
        det = r.get("detail") or {}
        if det.get("ambiguous") or det.get("overdue") or det.get("outcome"):
            continue
        # An alarm's obligation record (journaled before, and independently
        # of, any delivery attempt, so it carries no attempt) is not an
        # attempt intent: the attempt that follows it is the first one.
        if det.get("alarm") and not r.get("attempt"):
            continue
        k = (r.get("key"), r.get("attempt", 1))
        if k in seen and inside(r):
            intents += 1
            by_run[r.get("runId")] = by_run.get(r.get("runId"), 0) + 1
        seen.add(k)
    effects = 0
    try:
        entries = sorted(os.listdir(shadow_dir))
    except OSError:
        entries = []
    for run_id in entries:
        path = os.path.join(shadow_dir, run_id, "decisions.ndjson")
        if run_id == "wrapper" or not os.path.isfile(path):
            continue
        eff = set()
        for d in read_ndjson(path):
            if d.get("_unparsable") or not d.get("effect") or d.get("afterReconcile"):
                continue
            k = (d.get("type"), d.get("key") or d.get("verb") or d.get("slot"), d.get("attempt", 1))
            if k in eff and inside(d):
                effects += 1
                by_run[run_id] = by_run.get(run_id, 0) + 1
            eff.add(k)
    return {"intents": intents, "effects": effects, "byRun": by_run}


def overall(bars):
    """True only when every bar PASSes; "needs-review" when the only non-PASS
    bars are NEEDS_REVIEW (every hard bar holds, a human reads the listed
    mismatches); False on any FAIL or UNKNOWN."""
    results = {b["result"] for b in bars.values()}
    if results <= {"PASS"}:
        return True
    if results <= {"PASS", "NEEDS_REVIEW"}:
        return "needs-review"
    return False


def verdict_agreement(rows):
    """Controller vs real verdict, for mismatches that are not a false GO
    (that is its own hard bar). The controller's GO rule is deliberately
    stricter than today's coordinator, so an actual GO the controller holds
    at BLOCKED/NO_GO is expected -- but only with the failed check it named
    (its finish decision's failedChecks, smoke-campaign-controller.py:569-624).
    Unexplained: FAIL. Explained, or any other non-GO mismatch: a human reads
    it (NEEDS_REVIEW)."""
    unexplained, review = [], []
    for r in rows:
        if not r["verdictMismatch"] or r["controllerVerdict"] == "GO":
            continue
        checks = [c for c in (r.get("failedChecks") or []) if isinstance(c, str) and c.strip()]
        item = {"runId": r["runId"], "actual": r["actualVerdict"], "controller": r["controllerVerdict"],
                "failedChecks": checks}
        (unexplained if r["actualVerdict"] == "GO" and not checks else review).append(item)
    result = "FAIL" if unexplained else ("NEEDS_REVIEW" if review else "PASS")
    return {"value": len(unexplained) + len(review), "unexplained": unexplained, "needsReview": review,
            "want": "0 unexplained; every GO the controller withholds names its failed check",
            "result": result}


def report(args):
    replay = load_replay()
    since = parse_iso(args.since)
    until = parse_iso(args.until) if args.until else None
    if since is None:
        raise SystemExit("--since must be ISO-8601")
    actuals = read_json(args.actuals) if args.actuals else {}
    if not isinstance(actuals, dict):
        raise SystemExit("--actuals is not a JSON object")
    journal = read_ndjson(os.path.join(args.shadow_dir, "journal.ndjson"))
    by_run = {}
    for r in journal:
        by_run.setdefault(r.get("runId"), []).append(r)
    runs = finished_runs(args.gate_state_dir, since, until)
    rows = []
    for run_id, verdict in sorted(runs.items()):
        decisions = read_ndjson(os.path.join(args.shadow_dir, run_id, "decisions.ndjson"))
        rows.append(score(replay, run_id, verdict, actuals.get(run_id) or {}, by_run.get(run_id, []), decisions))
    health = fire_health(read_ndjson(os.path.join(args.shadow_dir, "wrapper", "fires.ndjson")), since, until)

    incomplete = [r["runId"] for r in rows if r["incomplete"]]
    missed = sorted("{}:{}".format(r["runId"], o) for r in rows for o in r["missedObligations"])
    missed += sorted("{}:issues x{}".format(r["runId"], r["issuesMissed"]) for r in rows if r["issuesMissed"])
    dup_scan = window_duplicates(args.shadow_dir, journal, since, until)
    dups = dup_scan["intents"] + dup_scan["effects"]
    false_go = [r["runId"] for r in rows if r["falseGo"]]
    turn_rows = [r for r in rows if r["actualCoordinatorTurns"] is not None]
    turns = sum(r["actualCoordinatorTurns"] for r in turn_rows)
    wakes = sum(r["escalations"] for r in turn_rows)
    reduction = (1 - wakes / turns) if turns else None
    ctl_finished = [r for r in rows if r["finishedBy"] == "controller"]
    lags = [r["finishLagMin"] for r in ctl_finished if r["finishLagMin"] is not None]
    bars = {
        "missedObligations": {"value": len(missed), "detail": missed, "want": 0,
                              "result": bar(not missed, unknown=bool(incomplete) and not missed)},
        "controllerCausedDuplicates": {"value": dups, "intents": dup_scan["intents"], "effects": dup_scan["effects"],
                                       "byRun": dup_scan["byRun"], "scope": "every shadow record in the window",
                                       "want": 0, "result": bar(dups == 0)},
        "falseGo": {"value": len(false_go), "detail": false_go, "want": 0, "result": bar(not false_go)},
        "verdictAgreement": verdict_agreement(rows),
        "journalTreatedAsEmpty": {"value": health["reinitsAfterFirst"], "want": 0,
                                  "result": bar(health["reinitsAfterFirst"] == 0)},
        "coordinationReduction": {"value": None if reduction is None else round(reduction, 3),
                                  "controllerCoordinationWakes": wakes, "actualCoordinatorTurns": turns,
                                  "callsAvoided": turns - wakes, "campaignsWithTurnData": len(turn_rows),
                                  "want": ">= {:.0%}".format(COORDINATION_REDUCTION_BAR),
                                  "result": bar(reduction is not None and reduction >= COORDINATION_REDUCTION_BAR,
                                                unknown=reduction is None)},
        "phaseLag": {"finishLagMin": replay._dist(lags), "want": "<= {} min".format(FIRE_SECONDS // 60),
                     "controllerFinished": len(ctl_finished), "campaigns": len(rows),
                     "result": bar(bool(lags) and max(lags) <= FIRE_SECONDS // 60, unknown=not lags)},
        "liveCampaigns": {"value": len(rows), "want": ">= 2 (fewer: extend shadow until 3)",
                          "result": bar(len(rows) >= 2)},
    }
    out = {
        "window": [iso(since), iso(until) if until else None],
        "pass": overall(bars),
        "bars": bars, "fireHealth": health, "incompleteActuals": incomplete,
        "controllerGo": sum(r["controllerVerdict"] == "GO" for r in rows),
        "verdictMismatches": sorted("{} {}->{}".format(r["runId"], r["actualVerdict"], r["controllerVerdict"])
                                    for r in rows if r["verdictMismatch"]),
        "ownerWakes": sum(r["ownerWakes"] for r in rows),
        "campaigns": rows,
    }
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=1, sort_keys=True)
    md = render_md(out)
    if args.md:
        with open(args.md, "w") as fh:
            fh.write(md)
    print(json.dumps({"pass": out["pass"], "campaigns": len(rows),
                      "bars": {k: v["result"] for k, v in bars.items()}}, sort_keys=True))
    return 0


def render_md(out):
    b = out["bars"]
    lines = ["# Controller shadow report", "",
             "Window {} .. {}. Overall: **{}**.".format(
                 out["window"][0], out["window"][1] or "now",
                 {True: "PASS", "needs-review": "NEEDS REVIEW"}.get(out["pass"], "NOT PASSING")), "",
             "| Bar | Value | Want | Result |", "|---|---|---|---|"]
    cr = b["coordinationReduction"]
    rows = [
        ("Missed obligations", b["missedObligations"]["value"], "0", b["missedObligations"]["result"]),
        ("Controller-caused duplicates", b["controllerCausedDuplicates"]["value"], "0",
         b["controllerCausedDuplicates"]["result"]),
        ("Would-be false GO", b["falseGo"]["value"], "0", b["falseGo"]["result"]),
        ("Verdict mismatches (non-GO controller)", b["verdictAgreement"]["value"], "0 unexplained",
         b["verdictAgreement"]["result"]),
        ("Journal treated as empty", b["journalTreatedAsEmpty"]["value"], "0", b["journalTreatedAsEmpty"]["result"]),
        ("Coordination wakes vs coordinator turns",
         "{} vs {} ({} avoided, {})".format(cr["controllerCoordinationWakes"], cr["actualCoordinatorTurns"],
                                            cr["callsAvoided"], "n/a" if cr["value"] is None else
                                            "{:.0%} fewer".format(cr["value"])), cr["want"], cr["result"]),
        ("Finish lag (controller-finished)", json.dumps(b["phaseLag"]["finishLagMin"]), b["phaseLag"]["want"],
         b["phaseLag"]["result"]),
        ("Live campaigns", b["liveCampaigns"]["value"], b["liveCampaigns"]["want"], b["liveCampaigns"]["result"]),
    ]
    lines += ["| {} | {} | {} | {} |".format(*r) for r in rows]
    h = out["fireHealth"]
    lines += ["", "Fires: {} ({} stepped, {} decision-less, {} hard errors, {} journal errors); slowest {}s.".format(
        h["fires"], h["stepped"], h["decisionLess"], h["hardErrors"], h["journalErrors"], h["maxElapsedSeconds"])]
    if h["skippedReasons"]:
        lines.append("Skipped: " + ", ".join("{} x{}".format(k, v) for k, v in sorted(h["skippedReasons"].items())))
    if out["incompleteActuals"]:
        lines += ["", "Actuals incomplete for: " + ", ".join(out["incompleteActuals"]) +
                  " (their missed-obligation count is a floor)."]
    if b["missedObligations"]["detail"]:
        lines += ["", "Missed: " + ", ".join(b["missedObligations"]["detail"])]
    va = b["verdictAgreement"]
    for label, items in (("Unexplained (controller named no failed check)", va["unexplained"]),
                         ("For review", va["needsReview"])):
        if items:
            lines += ["", "{}:".format(label)]
            lines += ["- {} {} -> {}: {}".format(i["runId"], i["actual"], i["controller"],
                                                 "; ".join(i["failedChecks"]) or "no failed check named")
                      for i in items]
    if b["controllerCausedDuplicates"]["byRun"]:
        lines += ["", "Duplicates by run: " + ", ".join("{} x{}".format(k, v) for k, v in
                                                        sorted(b["controllerCausedDuplicates"]["byRun"].items()))]
    lines += ["", "| Campaign | Actual | Controller | Finished by | Missed | Escalations | Turns | Owner wakes |",
              "|---|---|---|---|---|---|---|---|"]
    for r in out["campaigns"]:
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r["runId"], r["actualVerdict"], r["controllerVerdict"] or "-", r["finishedBy"] or "-",
            ", ".join(r["missedObligations"]) or "-", r["escalations"],
            "-" if r["actualCoordinatorTurns"] is None else r["actualCoordinatorTurns"], r["ownerWakes"]))
    return "\n".join(lines) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--gate-state-dir", required=True)
    c.add_argument("--since", required=True)
    c.add_argument("--until")
    c.add_argument("--repo", help="owner/name for gh reads; omit to skip GitHub")
    c.add_argument("--sessions-root", help="the gate agent group's data/v2-sessions/<agent group> dir")
    c.add_argument("--run-root", help="campaign run root, for owner steps")
    c.add_argument("--out")
    r = sub.add_parser("report")
    r.add_argument("--shadow-dir", required=True)
    r.add_argument("--gate-state-dir", required=True)
    r.add_argument("--actuals")
    r.add_argument("--since", required=True)
    r.add_argument("--until")
    r.add_argument("--md")
    r.add_argument("--json")
    args = p.parse_args(argv)
    return collect(args) if args.command == "collect" else report(args)


if __name__ == "__main__":
    sys.exit(main())
