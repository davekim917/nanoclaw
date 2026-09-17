#!/usr/bin/env python3
"""Visual candidates: every visual problem the harness detects ends owned.

The contact sheet and the screenshot-only design critic DETECT. Neither can
confirm anything -- a capture can be wrong, and a critic grading a wrong
capture is wrong with it. This script is the bookkeeping between detection and
the existing finding lifecycle: it names the candidates, records exactly one
disposition per candidate, and tells smoke-evidence-barrier.sh whether any is
still unowned. COMPLETENESS ONLY: whether a disposition is TRUE is the
independent UI adversary's and the challenger's question, never this one's.
It never touches the verdict; a candidate reaches the verdict only as a
`confirmed` finding, through that finding's normal severity.

  record-critic <run-dir> --rubric <file> [--design-system-version <id>]
                (the critic's `GRADE · <shot filename> · <reason>` lines on stdin)
  record-critic <run-dir> --unavailable <reason>
  list          <run-dir>
  dispose       <run-dir> <candidate> <disposition> --by <who>
                [--finding <id>] [--evidence <run-relative file>]
                [--reason <text>] [--owner <who>] [--trigger <text>]
  barrier       <run-dir>
  aggregate     <runs-root> critic-log|known-artifacts

A candidate is one screen at one width (`<screen>@<desktop|mobile>`) with any of:
  capture-failed           the manifest records the capture failed, or a screen
                           the pinned journeys require is absent from it
  unsettled                captured with `settled: false`
  critic-broken            the critic graded it BROKEN
  critic-degraded-changed  the critic graded it DEGRADED and the baseline diff
                           says this build `changed` it (only a run that passed
                           a baseline url has a diff; a freeze campaign passes
                           none, so DEGRADED alone is never a candidate there)
plus `critic@sheet` (critic-unavailable) when the critic was recorded as not run.
A `changed` screen the critic graded FINE is not a candidate, and neither is a
DEGRADED grade on a screen this build did not change.

Writers are fenced like the scaffold's marker writes: `record-critic` and
`dispose` need SMOKE_LANE_ROLE=coordinator|challenger and record it as `side`.
`refuted-capture-artifact`/`deferred` on a BROKEN must come from the OTHER side
than the one that recorded the critic. The role is self-declared, exactly as it
is for markers; that a disposition is true stays the challenger's review.

Every command prints one JSON object, except `aggregate critic-log` (NDJSON).
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))

SCHEMA_VERSION = 1
WIDTHS = ("desktop", "mobile")
GRADES = ("FINE", "DEGRADED", "BROKEN")
DISPOSITIONS = ("confirmed", "refuted-capture-artifact", "deferred", "blocked")
# What each disposition must carry. `evidence` is the interactive viewport
# capture at that width on the bound build -- a screenshot-only judgment can
# neither confirm nor refute a screenshot-only suspicion.
REQUIRED_FIELDS = {
    "confirmed": ("finding", "evidence"),
    "refuted-capture-artifact": ("reason", "evidence"),
    "deferred": ("owner", "trigger"),
    "blocked": ("reason",),
}
# Nothing was captured, so there is no capture to call an artifact, and a
# screen nobody saw cannot be deferred as cosmetic: it was reproduced live
# (`confirmed`) or it is honestly `blocked` and reported untested.
ALLOWED_BY_KIND = {
    "capture-failed": ("confirmed", "blocked"),
    "critic-unavailable": ("deferred", "blocked"),
}
CRITIC_CANDIDATE = "critic@sheet"
SIDES = ("coordinator", "challenger")
# Letting a BROKEN go without a finding is the one move that waves a candidate
# through, so the side that captured and graded the sheet may not make it.
INDEPENDENT_DISPOSITIONS = ("refuted-capture-artifact", "deferred")
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
SEP_RE = re.compile(r"\s+·\s+")

MANIFEST_REL = "contact-sheet/manifest.json"
SHOTS_REL = "contact-sheet/shots.json"
CRITIC_REL = "contact-sheet/critic.json"
DISP_REL = "contact-sheet/dispositions.json"


def emit(obj, code=0):
    print(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    sys.exit(code)


def writer_side(what):
    """Same fence, same env, same fail-closed-on-unset as the scaffold's
    require_coordinator_role (smoke-run-scaffold.sh:154) -- except both sides
    may write here, and the record says which one did."""
    side = os.environ.get("SMOKE_LANE_ROLE", "")
    if side not in SIDES:
        emit({"ok": False, "error": "SMOKE_LANE_ROLE must be 'coordinator' or 'challenger' to write {} (got: {})".format(
            what, side or "unset")}, 1)
    return side


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _is_text(v):
    return isinstance(v, str) and v.strip() != "" and "\n" not in v and "\r" not in v


def _read_json(path):
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))
    except (OSError, ValueError):
        return None


def _write_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _run_file_ok(run_dir, rel):
    """Same bar smoke-evidence-barrier.sh sets for pass evidence: a real,
    non-empty regular file inside the run, no traversal, no symlink."""
    if not _is_text(rel) or os.path.isabs(rel) or ".." in rel.split("/"):
        return False
    root = os.path.realpath(run_dir)
    candidate = os.path.join(run_dir, rel)
    return (
        os.path.realpath(candidate).startswith(root + os.sep) and not os.path.islink(candidate)
        and os.path.isfile(candidate) and os.path.getsize(candidate) > 0
    )


def journey_required_shots(run_dir):
    """Screen names the run's ADOPTED selection demands, read through
    `smoke-journeys.py shots` -- the one reader of what `pin-run` stores
    (journeys/selection.json + catalogue.json), never a second parser of it.
    Whether a sheet is owed is then the gate's pin, not whether the owner got
    round to writing shots.json. A valid gate pin the run has not adopted yet
    is smoke-journeys.py barrier's refusal, which runs first; nothing is read
    from the lease dir here. None = the answer could not be read."""
    if not os.path.exists(os.path.join(run_dir, "journeys", "selection.json")):
        return []
    try:
        out = subprocess.run(
            [sys.executable, os.path.join(_HERE, "smoke-journeys.py"), "shots", run_dir],
            capture_output=True, text=True, timeout=60,
        ).stdout
        result = json.loads(out)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if not isinstance(result, dict):
        return None
    # `shots` refuses a run whose pin carries no catalogue snapshot; that gap
    # is smoke-journeys.py barrier's to report, and it demands no screens here.
    if result.get("ok") is not True or not isinstance(result.get("shots"), list):
        return []
    return [s["name"] for s in result["shots"] if isinstance(s, dict) and _is_text(s.get("name"))]


def sheet_required(run_dir, journey_shots):
    return bool(journey_shots) or any(
        os.path.exists(os.path.join(run_dir, rel)) for rel in (SHOTS_REL, MANIFEST_REL)
    )


def load_manifest(run_dir):
    m = _read_json(os.path.join(run_dir, MANIFEST_REL))
    if not isinstance(m, dict) or not isinstance(m.get("screens"), list):
        return None
    for s in m["screens"]:
        if not isinstance(s, dict) or not _is_text(s.get("name")):
            return None
        if any(not isinstance(s.get(w), dict) for w in WIDTHS):
            return None
    return m


def critic_problem(critic, manifest):
    """Why this critic.json does not cover this manifest, or None."""
    if not isinstance(critic, dict) or critic.get("schemaVersion") != SCHEMA_VERSION:
        return "not a critic record -- write it with `smoke-visual-candidates.py record-critic`"
    if critic.get("manifestGeneratedAt") != manifest.get("generatedAt"):
        return "graded a different capture (manifestGeneratedAt {} != manifest generatedAt {}) -- re-run the critic on the current shots".format(
            critic.get("manifestGeneratedAt"), manifest.get("generatedAt"))
    if critic.get("side") not in SIDES:
        return "does not record which side captured and graded the sheet"
    if "unavailable" in critic:
        return None if _is_text(critic["unavailable"]) else "unavailable needs a one-line reason"
    grades = critic.get("grades")
    if not isinstance(grades, list):
        return "grades must be a list"
    seen = set()
    for g in grades:
        if not isinstance(g, dict) or g.get("grade") not in GRADES or g.get("width") not in WIDTHS \
                or not _is_text(g.get("screen")) or not _is_text(g.get("reason")):
            return "malformed grade entry: {}".format(json.dumps(g)[:120])
        key = (g["screen"], g["width"])
        if key in seen:
            return "two grades for {}@{}".format(*key)
        seen.add(key)
    for s in manifest["screens"]:
        for w in WIDTHS:
            e = s[w]
            # With a baseline the critic judges what the build changed; an
            # `unchanged` tile looked that way before and may go ungraded.
            unchanged = isinstance(e.get("diff"), dict) and e["diff"].get("status") == "unchanged"
            if e.get("captured") is True and not unchanged and (s["name"], w) not in seen:
                return "no grade for captured screen {}@{} -- a screen the critic skipped is not a FINE".format(s["name"], w)
    return None


def compute_candidates(manifest, critic, journey_shots):
    grades = {}
    if isinstance(critic, dict) and isinstance(critic.get("grades"), list):
        grades = {(g["screen"], g["width"]): g for g in critic["grades"]}
    out = []
    names = set()
    for s in manifest["screens"]:
        names.add(s["name"])
        for w in WIDTHS:
            e, kinds, detail = s[w], [], []
            if e.get("captured") is not True:
                kinds.append("capture-failed")
                detail.append("capture failed: {}".format(e.get("reason") or "no reason recorded"))
            else:
                if e.get("settled") is False:
                    kinds.append("unsettled")
                    detail.append("captured while the page was still moving")
                g = grades.get((s["name"], w))
                changed = isinstance(e.get("diff"), dict) and e["diff"].get("status") == "changed"
                if g and g["grade"] == "BROKEN":
                    kinds.append("critic-broken")
                    detail.append("critic BROKEN: {}".format(g["reason"]))
                elif g and g["grade"] == "DEGRADED" and changed:
                    kinds.append("critic-degraded-changed")
                    detail.append("critic DEGRADED on a screen this build changed: {}".format(g["reason"]))
            if kinds:
                out.append({"candidate": "{}@{}".format(s["name"], w), "screen": s["name"], "width": w,
                            "kinds": kinds, "detail": "; ".join(detail), "file": e.get("file")})
    for name in journey_shots:
        if name not in names:
            for w in WIDTHS:
                out.append({"candidate": "{}@{}".format(name, w), "screen": name, "width": w,
                            "kinds": ["capture-failed"], "file": None,
                            "detail": "required by the run's pinned journeys but absent from manifest.json"})
    if isinstance(critic, dict) and _is_text(critic.get("unavailable")):
        out.append({"candidate": CRITIC_CANDIDATE, "screen": None, "width": None, "file": None,
                    "kinds": ["critic-unavailable"], "detail": "critic did not run: {}".format(critic["unavailable"])})
    return out


def allowed_dispositions(kinds):
    allowed = list(DISPOSITIONS)
    for k in kinds:
        if k in ALLOWED_BY_KIND:
            allowed = [d for d in allowed if d in ALLOWED_BY_KIND[k]]
    return allowed


def confirmed_finding_ids(run_dir):
    """Finding ids the run's required lane markers declare confirmed -- the
    existing lifecycle's own record (and the clip rule's input)."""
    contract = _read_json(os.path.join(run_dir, "completion-contract.json"))
    ids = set()
    markers = contract.get("requiredLaneMarkers") if isinstance(contract, dict) else None
    for rel in markers if isinstance(markers, list) else []:
        if not _is_text(rel) or os.path.isabs(rel) or ".." in rel.split("/"):
            continue
        marker = _read_json(os.path.join(run_dir, rel))
        found = marker.get("confirmedFindings") if isinstance(marker, dict) else None
        ids.update(f for f in (found if isinstance(found, list) else []) if isinstance(f, str))
    return ids


def disposition_problem(run_dir, entry, candidate, critic, check_lifecycle):
    kind = entry.get("disposition")
    if kind not in DISPOSITIONS:
        return "disposition must be one of {}".format(", ".join(DISPOSITIONS))
    if entry.get("side") not in SIDES:
        return "does not record which side (coordinator|challenger) wrote it -- write it with `dispose`"
    detected_by = critic.get("side") if isinstance(critic, dict) else None
    if "critic-broken" in candidate["kinds"] and kind in INDEPENDENT_DISPOSITIONS and entry["side"] == detected_by:
        return ("{} of a BROKEN must come from the other side: the {} side captured and graded this sheet, "
                "so it may confirm or block its own candidate but not wave it off").format(kind, detected_by)
    allowed = allowed_dispositions(candidate["kinds"])
    if kind not in allowed:
        return "a {} candidate can only be {}".format("/".join(candidate["kinds"]), " or ".join(allowed))
    if not _is_text(entry.get("by")):
        return "needs `by` (who reproduced or decided it)"
    for field in REQUIRED_FIELDS[kind]:
        if not _is_text(entry.get(field)):
            return "{} needs a one-line `{}`".format(kind, field)
    if "evidence" in REQUIRED_FIELDS[kind] and not _run_file_ok(run_dir, entry["evidence"]):
        return "evidence {} is not a non-empty regular file inside the run -- cite the interactive viewport capture".format(entry["evidence"])
    if kind == "confirmed":
        if not ID_RE.match(entry["finding"]):
            return "finding id {} is not a safe id".format(entry["finding"])
        if check_lifecycle and entry["finding"] not in confirmed_finding_ids(run_dir):
            return ("confirmed as finding {f} but no required lane marker lists it in confirmedFindings -- a confirmed visual "
                    "defect is a normal finding: write the lane marker with --confirmed-findings {f}").format(f=entry["finding"])
    return None


def load_dispositions(run_dir):
    path = os.path.join(run_dir, DISP_REL)
    if not os.path.exists(path):
        return []
    data = _read_json(path)
    if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION \
            or not isinstance(data.get("dispositions"), list) \
            or any(not isinstance(d, dict) for d in data["dispositions"]):
        return None
    return data["dispositions"]


def _state(run_dir):
    """(journey_shots, manifest, critic, candidates) or an emit() refusal."""
    journey_shots = journey_required_shots(run_dir)
    manifest = load_manifest(run_dir)
    if manifest is None:
        emit({"ok": False, "error": "no readable {} -- run smoke-contact-sheet.sh first".format(MANIFEST_REL)}, 1)
    critic = _read_json(os.path.join(run_dir, CRITIC_REL))
    return journey_shots or [], manifest, critic, compute_candidates(manifest, critic, journey_shots or [])


# --- record-critic ----------------------------------------------------------

def cmd_record_critic(args):
    side = writer_side("the critic record")
    manifest = load_manifest(args.run_dir)
    if manifest is None:
        emit({"ok": False, "error": "no readable {} -- run smoke-contact-sheet.sh first".format(MANIFEST_REL)}, 1)
    record = {"schemaVersion": SCHEMA_VERSION, "manifestGeneratedAt": manifest.get("generatedAt"),
              "side": side, "recordedAt": _now()}
    if args.unavailable is not None:
        if not _is_text(args.unavailable):
            emit({"ok": False, "error": "--unavailable needs a one-line reason"}, 1)
        record["unavailable"] = args.unavailable.strip()
    else:
        try:
            with open(args.rubric, "rb") as fh:
                rubric_sha = hashlib.sha256(fh.read()).hexdigest()
        except (OSError, TypeError):
            emit({"ok": False, "error": "--rubric must name the rubric file the critic graded against"}, 1)
        by_file = {}
        for s in manifest["screens"]:
            for w in WIDTHS:
                if s[w].get("captured") is True and _is_text(s[w].get("file")):
                    by_file[os.path.basename(s[w]["file"])] = (s["name"], w, s[w]["file"])
        grades, notes = [], []
        for raw in sys.stdin.read().splitlines():
            line = raw.strip()
            if not line:
                continue
            parts = SEP_RE.split(line, 2)
            if parts[0] == "NOTE" and len(parts) >= 2:
                notes.append(" · ".join(parts[1:]))
                continue
            if len(parts) != 3 or parts[0] not in GRADES or os.path.basename(parts[1]) not in by_file:
                emit({"ok": False, "error": "not a `GRADE · <graded shot filename> · <reason>` line for a captured shot in this manifest: {}".format(line[:200]),
                      "gradedShots": sorted(by_file)}, 1)
            screen, width, rel = by_file[os.path.basename(parts[1])]
            grades.append({"screen": screen, "width": width, "file": rel, "grade": parts[0], "reason": parts[2]})
        record.update({
            "rubric": {"file": os.path.basename(args.rubric), "sha256": rubric_sha},
            "designSystemVersion": args.design_system_version,
            "notes": notes, "grades": grades,
        })
    problem = critic_problem(record, manifest)
    if problem:
        emit({"ok": False, "error": problem}, 1)
    _write_atomic(os.path.join(args.run_dir, CRITIC_REL), record)
    candidates = compute_candidates(manifest, record, journey_required_shots(args.run_dir) or [])
    emit({"ok": True, "critic": os.path.join(args.run_dir, CRITIC_REL), "candidates": [c["candidate"] for c in candidates]})


# --- list / dispose ---------------------------------------------------------

def cmd_list(args):
    _, _, _, candidates = _state(args.run_dir)
    dispositions = load_dispositions(args.run_dir) or []
    for c in candidates:
        mine = [d for d in dispositions if d.get("candidate") == c["candidate"]]
        c["allowed"] = allowed_dispositions(c["kinds"])
        c["disposition"] = mine[0] if len(mine) == 1 else None
    emit({"ok": True, "candidates": candidates,
          "undispositioned": [c["candidate"] for c in candidates if c["disposition"] is None]})


def cmd_dispose(args):
    side = writer_side("a visual candidate disposition")
    _, _, critic, candidates = _state(args.run_dir)
    candidate = next((c for c in candidates if c["candidate"] == args.candidate), None)
    if candidate is None:
        emit({"ok": False, "error": "{} is not a candidate in this run".format(args.candidate),
              "candidates": [c["candidate"] for c in candidates]}, 1)
    entry = {"candidate": args.candidate, "disposition": args.disposition, "kinds": candidate["kinds"],
             "screen": candidate["screen"], "width": candidate["width"], "side": side, "by": args.by,
             "recordedAt": _now()}
    for field in ("finding", "evidence", "reason", "owner", "trigger"):
        if getattr(args, field) is not None:
            entry[field] = getattr(args, field)
    # The marker that carries the finding may not be written yet; the barrier
    # is where a confirmed candidate must have reached the finding lifecycle.
    problem = disposition_problem(args.run_dir, entry, candidate, critic, check_lifecycle=False)
    if problem:
        emit({"ok": False, "error": problem}, 1)
    existing = load_dispositions(args.run_dir)
    if existing is None:
        emit({"ok": False, "error": "{} is unreadable; move it aside rather than overwrite it".format(DISP_REL)}, 1)
    kept = [d for d in existing if d.get("candidate") != args.candidate]
    _write_atomic(os.path.join(args.run_dir, DISP_REL),
                  {"schemaVersion": SCHEMA_VERSION, "dispositions": kept + [entry]})
    emit({"ok": True, "candidate": args.candidate, "disposition": args.disposition, "side": side,
          "replaced": len(kept) != len(existing)})


# --- barrier ----------------------------------------------------------------

def cmd_barrier(args):
    run_dir = args.run_dir
    missing, invalid, reasons = [], [], []

    def add(bucket, rel, why):
        if rel not in bucket:
            bucket.append(rel)
        reasons.append("{}: {}".format(rel, why))

    def done():
        emit({"missing": missing, "invalid": invalid, "invalidReasons": reasons})

    journey_shots = journey_required_shots(run_dir)
    if journey_shots is None:
        add(invalid, "journeys/selection.json", "could not read which screens the pinned journeys require")
        done()
    # No user-visible surface: nothing owed, and the barrier's output stays
    # exactly what it was before this check existed.
    if not sheet_required(run_dir, journey_shots):
        done()

    if not os.path.exists(os.path.join(run_dir, MANIFEST_REL)):
        add(missing, MANIFEST_REL, "this campaign requires a contact sheet ({}) and none was captured -- a capture that never ran does not waive visual review".format(
            "its pinned journeys carry capture recipes" if journey_shots else "shots.json exists"))
        done()
    manifest = load_manifest(run_dir)
    if manifest is None:
        add(invalid, MANIFEST_REL, "not a contact-sheet manifest")
        done()

    critic_path = os.path.join(run_dir, CRITIC_REL)
    critic = None
    if not os.path.exists(critic_path):
        add(missing, CRITIC_REL, "a contact sheet exists and the design critic has no record -- run it and `record-critic`, or record `--unavailable <reason>`; a critic that did not run does not waive visual review")
    else:
        critic = _read_json(critic_path)
        problem = critic_problem(critic, manifest)
        if problem:
            add(invalid, CRITIC_REL, problem)
            critic = None

    dispositions = load_dispositions(run_dir)
    if dispositions is None:
        add(invalid, DISP_REL, "not a dispositions file -- write it with `smoke-visual-candidates.py dispose`")
        done()
    for c in compute_candidates(manifest, critic, journey_shots):
        rel = "{}#{}".format(DISP_REL, c["candidate"])
        mine = [d for d in dispositions if d.get("candidate") == c["candidate"]]
        if len(mine) > 1:
            add(invalid, rel, "{} dispositions recorded; a candidate has exactly one".format(len(mine)))
        elif not mine and "capture-failed" in c["kinds"]:
            add(missing, rel, "MISSING EVIDENCE -- {} ({}). Re-capture the screen, or reproduce it live and record `confirmed`, or record `blocked` and report the screen untested".format(
                c["candidate"], c["detail"]))
        elif not mine:
            add(invalid, rel, "visual candidate with no owner -- {}. Reproduce it in a viewport at that width on the bound build, then record one of: {}".format(
                c["detail"], ", ".join(allowed_dispositions(c["kinds"]))))
        else:
            problem = disposition_problem(run_dir, mine[0], c, critic, check_lifecycle=True)
            if problem:
                add(invalid, rel, problem)
    done()


# --- aggregate --------------------------------------------------------------

def cmd_aggregate(args):
    """The shared views are DERIVED from run dirs, so a run can never be
    missing from them the way a forgotten hand-append left one out."""
    rows, artifacts, seen = [], [], set()
    for critic_path in sorted(glob.glob(os.path.join(args.runs_root, "*", CRITIC_REL))):
        run_dir = os.path.dirname(os.path.dirname(critic_path))
        run_id = os.path.basename(run_dir)
        critic = _read_json(critic_path)
        if not isinstance(critic, dict):
            continue
        disp = {d.get("candidate"): d for d in (load_dispositions(run_dir) or [])}
        if _is_text(critic.get("unavailable")):
            rows.append({"runId": run_id, "screen": None, "width": None, "grade": "NOT_RUN",
                         "reason": critic["unavailable"], "ts": critic.get("recordedAt")})
        for g in critic.get("grades") if isinstance(critic.get("grades"), list) else []:
            if not isinstance(g, dict):
                continue
            d = disp.get("{}@{}".format(g.get("screen"), g.get("width")))
            rows.append({"runId": run_id, "screen": g.get("screen"), "width": g.get("width"), "grade": g.get("grade"),
                         "reason": g.get("reason"), "ts": critic.get("recordedAt"),
                         "disposition": d.get("disposition") if d else None})
        for d in disp.values():
            key = (d.get("screen"), d.get("width"), d.get("reason"))
            if d.get("disposition") == "refuted-capture-artifact" and key not in seen:
                seen.add(key)
                artifacts.append({"screen": d.get("screen"), "width": d.get("width"), "reason": d.get("reason"),
                                  "runId": run_id, "recordedAt": d.get("recordedAt")})
    if args.view == "known-artifacts":
        emit({"ok": True, "knownCaptureArtifacts": artifacts})
    for row in rows:
        print(json.dumps(row, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(prog="smoke-visual-candidates.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("record-critic")
    p.add_argument("run_dir")
    p.add_argument("--rubric")
    p.add_argument("--design-system-version")
    p.add_argument("--unavailable")
    p.set_defaults(fn=cmd_record_critic)

    p = sub.add_parser("list")
    p.add_argument("run_dir")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("dispose")
    p.add_argument("run_dir")
    p.add_argument("candidate")
    p.add_argument("disposition", choices=DISPOSITIONS)
    p.add_argument("--by", required=True)
    for field in ("finding", "evidence", "reason", "owner", "trigger"):
        p.add_argument("--" + field)
    p.set_defaults(fn=cmd_dispose)

    p = sub.add_parser("barrier")
    p.add_argument("run_dir")
    p.set_defaults(fn=cmd_barrier)

    p = sub.add_parser("aggregate")
    p.add_argument("runs_root")
    p.add_argument("view", choices=("critic-log", "known-artifacts"))
    p.set_defaults(fn=cmd_aggregate)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
