#!/usr/bin/env python3
"""Journey catalogue: validate, match, pin, enforce, publish.

A journey is a saved plain-English QA walk plus the repo paths whose change
makes it relevant (`consumes`). This script is the whole mechanism -- there is
no runner, DSL or dependency graph behind it. The retained QA owner still
executes the steps; this only decides, deterministically and before any model
wakes, WHICH journeys a change selects and which changed paths nothing claims.

  validate  <catalogue>
  match     --catalogue <file> [--snapshot-out <file>] [--unknown <reason>]
            [--size light|standard|full] [--run-root <dir>] [--as-of <iso>]
            (changed paths: JSON array on stdin, never argv)
  floor-due <catalogue> <run-root> [--size ...] [--as-of <iso>]
  pin-run   <run-dir> <gate-pin-file>
  pin-check <pin-file> [--pr <n> --head <sha> --repo-slug <slug>] [--as-path <final path>]
            | --owner <primary-pin-file> ... (the one owning-pin rule) | --candidate (stdin)
  shots     <run-dir>
  barrier   <run-dir> [--gate-pin <the ONE primary pin this campaign owns> --pr <n> --head <sha>]
  publish   <catalogue> <proposed> --expect-sha256 <hex|absent> --lock <file>
            [--floor-authority <citation>]

Every command prints one JSON object. Globs are campaign-size-classify.py's
(`*` stays inside a path segment, `**` crosses them, `{a,b}` alternates) --
imported, never reimplemented, so sizing and selection cannot disagree about
what a pattern means.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

# The glob module is loaded from a sibling file; never leave a __pycache__
# beside the skill's scripts (a read-only mount in the container anyway).
sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "campaign_size_classify", os.path.join(_HERE, "campaign-size-classify.py")
)
_globs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_globs)

SCHEMA_VERSION = 1
EVIDENCE_KINDS = ("browser", "api", "native-manual")
DISPOSITIONS = ("mapped-to-journey", "new-journey", "no-user-facing-consumer", "unresolved")
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# A capture recipe is executable input to smoke-contact-sheet.sh, which accepts
# exactly these two verbs. A journey's English `steps` never reach that script.
RECIPE_STEP_RE = re.compile(r"^(click|wait) \S")
MEDIA_RE = re.compile(r"\.(png|jpg|jpeg|webp|gif|mp4|webm)$", re.I)
MATCHED_PATHS_SHOWN = 20
SHOTS_CAP = 8

JOURNEY_REQUIRED_TEXT = ("title", "proves", "entryPath", "endState", "seed", "restore")
JOURNEY_KEYS = set(JOURNEY_REQUIRED_TEXT) | {
    "id", "evidence", "steps", "seats", "consumes", "maxIntervalDays", "checkpoints", "captureRecipes",
}
RECIPE_KEYS = {"name", "path", "steps", "finalPath"}
TOP_KEYS = {"schemaVersion", "journeys", "excludePaths"}


def emit(obj, code=0):
    print(json.dumps(obj, separators=(",", ":")))
    sys.exit(code)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _is_text(v):
    return isinstance(v, str) and v.strip() != ""


def _text_list(v, allow_empty):
    return isinstance(v, list) and all(_is_text(x) for x in v) and (allow_empty or len(v) > 0)


def _glob_problem(g):
    if not _is_text(g):
        return "is not a non-empty string"
    if g.startswith("/"):
        return "must be repo-relative (no leading /)"
    # A match-everything glob leaves no path unmapped (or, as an exclusion, no
    # path in scope), which silences the one list that forces somebody to
    # explain a change nothing claims. Judged per brace-EXPANDED alternative --
    # `{**,api/**}` is `**` with a decoy -- and a segment of only `*`/`?` is a
    # wildcard however it is spelled (`*?`, `**?`).
    for alt in _globs.expand_braces(g):
        if all(seg != "" and set(seg) <= {"*", "?"} for seg in alt.split("/")):
            return "matches every path{}; name the area".format(
                "" if alt == g else " (its alternative {!r} does)".format(alt))
    return None


def _exclude_entries(cat):
    """excludePaths as [(glob, reason)]. An entry is `{glob, reason}`; a bare
    string is still read (reason None) and `validate` warns about it."""
    out = []
    for e in cat.get("excludePaths", []) if isinstance(cat, dict) else []:
        if isinstance(e, dict):
            out.append((e.get("glob"), e.get("reason")))
        else:
            out.append((e, None))
    return out


def _sample_paths(glob):
    """Concrete paths a glob would match, for the shadow check below."""
    samples = []
    for g in _globs.expand_braces(glob):
        for deep in ("x", "x/y"):
            segs = [deep if seg == "**" else seg.replace("*", "x").replace("?", "x") for seg in g.split("/")]
            samples.append("/".join(segs))
    return samples


def catalogue_warnings(cat):
    """Ways a VALID catalogue silently drops scope. The matcher strips
    excludePaths BEFORE consumes, so an exclusion always wins: a consumes glob
    it shadows selects nothing, and no journey can rescue a path a broad
    exclusion hides. Warnings, not errors -- the catalogue still loads."""
    warnings = []
    entries = [(g, r) for g, r in _exclude_entries(cat) if _is_text(g)]
    for g, reason in entries:
        broad = False
        for alt in _globs.expand_braces(g):
            segs = alt.split("/")
            broad = broad or segs[0].startswith("*") or (len(segs) == 2 and set(segs[1]) <= {"*"})
        if broad:
            warnings.append("excludePaths {!r} is a bare top-level or extension-wide wildcard; it hides every such path from every journey -- name the narrow area instead".format(g))
        if not _is_text(reason):
            warnings.append("excludePaths {!r} carries no reason".format(g))
    rules = _globs.compile_rule_list([g for g, _ in entries])
    for j in cat.get("journeys", []):
        for g in j.get("consumes", []):
            shadows = {_globs.match_first(p, rules) for p in _sample_paths(g)}
            if shadows and None not in shadows:
                warnings.append("journey {}: consumes {!r} can never match -- excludePaths {} is applied first".format(
                    j.get("id"), g, ", ".join(repr(x) for x in sorted(shadows))))
    return warnings


def _unknown_keys(obj, allowed):
    return sorted(k for k in obj if k not in allowed and not k.startswith("_"))


def validate_catalogue(cat):
    """List of problems; empty means valid."""
    if not isinstance(cat, dict):
        return ["catalogue is not a JSON object"]
    errors = []
    if cat.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("schemaVersion must be {}".format(SCHEMA_VERSION))
    for k in _unknown_keys(cat, TOP_KEYS):
        errors.append("unknown top-level key {}".format(k))
    excludes = cat.get("excludePaths", [])
    if not isinstance(excludes, list):
        errors.append("excludePaths must be a list of globs")
    else:
        for e in excludes:
            if isinstance(e, dict):
                for k in _unknown_keys(e, {"glob", "reason"}):
                    errors.append("excludePaths entry has unknown key {}".format(k))
                if "reason" in e and not _is_text(e["reason"]):
                    errors.append("excludePaths {!r} reason must be a non-empty string".format(e.get("glob")))
                e = e.get("glob")
            problem = _glob_problem(e)
            if problem:
                errors.append("excludePaths glob {!r} {}".format(e, problem))
    journeys = cat.get("journeys")
    if not isinstance(journeys, list) or not journeys:
        return errors + ["journeys must be a non-empty list"]
    seen = set()
    for i, j in enumerate(journeys):
        if not isinstance(j, dict):
            errors.append("journeys[{}] is not an object".format(i))
            continue
        jid = j.get("id")
        where = "journey {}".format(jid if isinstance(jid, str) else "#{}".format(i))
        # The id is the contract lane id, so it takes the scaffold's alphabet.
        if not isinstance(jid, str) or not ID_RE.match(jid):
            errors.append("{}: id must match {}".format(where, ID_RE.pattern))
        elif jid in seen:
            errors.append("{}: duplicate id".format(where))
        else:
            seen.add(jid)
        for k in _unknown_keys(j, JOURNEY_KEYS):
            errors.append("{}: unknown key {}".format(where, k))
        for k in JOURNEY_REQUIRED_TEXT:
            if not _is_text(j.get(k)):
                errors.append("{}: {} must be a non-empty string".format(where, k))
        evidence = j.get("evidence")
        if evidence not in EVIDENCE_KINDS:
            errors.append("{}: evidence must be one of {}".format(where, "|".join(EVIDENCE_KINDS)))
        if not _text_list(j.get("steps"), allow_empty=False):
            errors.append("{}: steps must be a non-empty list of plain-English strings".format(where))
        if not _text_list(j.get("seats"), allow_empty=True):
            errors.append("{}: seats must be a list of strings".format(where))
        if not _text_list(j.get("checkpoints"), allow_empty=evidence != "browser"):
            errors.append("{}: checkpoints must be a list of strings (non-empty for a browser journey)".format(where))
        interval = j.get("maxIntervalDays")
        if interval is not None and (
            isinstance(interval, bool) or not isinstance(interval, (int, float)) or interval <= 0
        ):
            errors.append("{}: maxIntervalDays must be a positive number".format(where))
        consumes = j.get("consumes")
        # A floor journey is selected by cadence, so it alone may consume nothing.
        if not isinstance(consumes, list) or (not consumes and interval is None):
            errors.append("{}: consumes must be a non-empty list of globs (a floor journey may leave it empty)".format(where))
        else:
            for g in consumes:
                problem = _glob_problem(g)
                if problem:
                    errors.append("{}: consumes glob {!r} {}".format(where, g, problem))
        recipes = j.get("captureRecipes", [])
        if not isinstance(recipes, list):
            errors.append("{}: captureRecipes must be a list".format(where))
            continue
        for r in recipes:
            if not isinstance(r, dict) or not _is_text(r.get("name")) or not _is_text(r.get("path")):
                errors.append("{}: every captureRecipe needs a name and a path".format(where))
                continue
            for k in _unknown_keys(r, RECIPE_KEYS):
                errors.append("{}: captureRecipe {} has unknown key {}".format(where, r["name"], k))
            steps = r.get("steps", [])
            if not isinstance(steps, list) or not all(isinstance(s, str) and RECIPE_STEP_RE.match(s) for s in steps):
                errors.append("{}: captureRecipe {} steps must be click/wait commands only".format(where, r["name"]))
            if "finalPath" in r and not _is_text(r["finalPath"]):
                errors.append("{}: captureRecipe {} finalPath must be a non-empty string".format(where, r["name"]))
    return errors


def load_catalogue(path):
    """(catalogue, sha256, raw_bytes, errors). sha256 is None only when the
    file could not be read at all."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return None, None, None, ["catalogue could not be read: {}".format(exc)]
    digest = sha256_bytes(raw)
    try:
        cat = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        return None, digest, raw, ["catalogue is not valid JSON: {}".format(exc)]
    errors = validate_catalogue(cat)
    return (cat if not errors else None), digest, raw, errors


# --- floor cadence ----------------------------------------------------------

def _parse_iso(value):
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def lane_problems(run_dir, contract, jid, evidence, is_floor, files_must_exist=True):
    """Everything a journey-backed lane owes -- ONE rule, used by the barrier
    (matched and disposition-linked lanes) and by floor cadence, so a pass the
    barrier would refuse can never reset a clock. Returns [(artifact, why)].
      floor journey   => lane kind `floor`;
      api             => the catalogue grants the exemption and the contract
                         carries it -- both ways, nothing else may;
      browser         => a `pass` names browser media;
      native-manual   => a `pass` names the tester's result under
                         manual-results/ -- issuing the packet is `completed`.
    `files_must_exist` is the barrier's bar (the run is live). Cadence reads old
    runs whose media retention may have pruned, so it asks only what was cited."""
    sel_rel, marker_rel = "journeys/selection.json", "markers/{}.json".format(jid)
    lane = next((l for l in (contract.get("lanes") or []) if isinstance(l, dict) and l.get("id") == jid), {})
    out = []
    if is_floor and lane.get("kind") != "floor":
        out.append((sel_rel, "journey {} is a floor journey but its lane is kind {!r}; scaffold it `{}:floor:<title>`".format(jid, lane.get("kind"), jid)))
    declared = lane.get("evidence")
    if declared == "api" and evidence != "api":
        out.append((sel_rel, "lane {} is scaffolded --evidence api but its journey declares evidence {}".format(jid, evidence)))
    elif evidence == "api" and declared != "api":
        out.append((sel_rel, "journey {} declares evidence api but its lane was not scaffolded `--evidence {}=api`; regenerate the contract with it".format(jid, jid)))
    marker = _read_json(os.path.join(run_dir, marker_rel))
    if isinstance(marker, dict) and marker.get("status") == "pass":
        cited = [e for e in (marker.get("evidence") or []) if isinstance(e, str)]
        there = (lambda e: _run_file_ok(run_dir, e)) if files_must_exist else (lambda e: True)
        if evidence == "browser" and not any(MEDIA_RE.search(e) and there(e) for e in cited):
            out.append((marker_rel, "a browser journey passes only on browser media (png/jpg/jpeg/webp/gif/mp4/webm) in the run"))
        if evidence == "native-manual" and not any(e.startswith("manual-results/") and there(e) for e in cited):
            out.append((marker_rel, "a native-manual journey passes only on the named tester's recorded result under manual-results/ -- issuing the packet is `completed`, not `pass`"))
    return out


def pass_identity_problems(contract, marker, jid):
    """The barrier's identity bar for a pass marker, as one shared function:
    the lane is declared, sourceSha is present on BOTH sides and equal (never
    null == null), the lane field agrees, the generation is the contract's,
    completedAt is set, and evidence is a non-empty list of one-line paths."""
    out = []
    if not isinstance(contract, dict):
        return ["the run has no readable contract"]
    lane = next((l for l in (contract.get("lanes") or []) if isinstance(l, dict) and l.get("id") == jid), None)
    if "markers/{}.json".format(jid) not in (contract.get("requiredLaneMarkers") or []):
        out.append("lane {} is not declared in its run's contract".format(jid))
    sha = contract.get("sourceSha")
    if not (isinstance(sha, str) and HEX40.match(sha) and marker.get("sourceSha") == sha):
        out.append("marker sourceSha is missing or differs from its run's contract")
    if marker.get("lane", jid) != jid:
        out.append("marker lane field does not match its file name")
    want = (lane or {}).get("generation", 1)
    if marker.get("generation", 1) != want:
        out.append("marker generation {} is not the contract's {}".format(marker.get("generation", 1), want))
    if not _is_text(marker.get("completedAt")):
        out.append("completedAt is missing")
    if not _text_list(marker.get("evidence"), allow_empty=False) or any("\n" in e or "\r" in e for e in marker["evidence"]):
        out.append("a pass names no evidence")
    return out


def stale_after_refreeze(run_dir, jid):
    """True when a pair re-freeze retired this lane's evidence and nothing
    redispatched it -- or when that cannot be told. The rule is
    rl_stale_after_refreeze in refreeze-lanes.jq, the ONE definition the
    barrier and `smoke-pair-identity.sh finish` read; it is invoked here
    exactly as smoke-evidence-barrier.sh invokes it, never mirrored."""
    identity = os.path.join(run_dir, "coordinator", "identity.json")
    if not os.path.exists(identity):
        return False
    contract = os.path.join(run_dir, "completion-contract.json")
    try:
        out = subprocess.run(
            ["jq", "-cs", "-L", _HERE, "--slurpfile", "c", contract,
             'include "refreeze-lanes"; if length != 1 then {error: "identity.json is not exactly one JSON document"} '
             'else .[0] | rl_stale_after_refreeze(if ($c | length) == 1 then $c[0] else "unparsable" end) end',
             identity],
            capture_output=True, text=True, timeout=20, check=False)
        verdict = json.loads(out.stdout) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        verdict = None
    if not isinstance(verdict, dict) or verdict.get("error"):
        return True
    return jid in (verdict.get("stale") or [])


def last_proven(run_root, journey):
    """Newest completedAt of a `pass` that PROVED this floor journey: the
    marker passes pass_identity_problems (declared lane, same sourceSha and
    generation, evidence cited) and the lane satisfies lane_problems for the
    journey's DECLARED evidence and floor kind. A text-only pass on a browser journey
    mis-scaffolded as api proves nothing and resets nothing."""
    jid, newest = journey["id"], None
    try:
        runs = sorted(os.listdir(run_root))
    except OSError:
        return None
    for run in runs:
        run_dir = os.path.join(run_root, run)
        marker = _read_json(os.path.join(run_dir, "markers", jid + ".json"))
        contract = _read_json(os.path.join(run_dir, "completion-contract.json"))
        if not isinstance(marker, dict) or marker.get("status") != "pass" or not isinstance(contract, dict):
            continue
        # The COMPLETE pass-validity bar the barrier applies, relaxing only file
        # existence (media retention prunes old runs): a pass the barrier would
        # refuse today proves nothing and resets nothing.
        if pass_identity_problems(contract, marker, jid) or \
                lane_problems(run_dir, contract, jid, journey["evidence"], True, files_must_exist=False) or \
                stale_after_refreeze(run_dir, jid):
            continue
        done = _parse_iso(marker.get("completedAt"))
        if done is not None and (newest is None or done > newest):
            newest = done
    return newest


def floor_due(cat, run_root, size, as_of):
    """Which floor journeys this campaign owes. Every entry past its interval
    is due; when none is, a standard/full campaign owes the single
    least-recently-proven one and a light campaign owes nothing. With no
    readable history, all of them."""
    floor = [j for j in cat["journeys"] if j.get("maxIntervalDays") is not None]
    if not run_root or not os.path.isdir(run_root):
        # Unknown history is not fresh history: a missing mount or an unset
        # SMOKE_GATE_RUN_ROOT must never delete the floor. Every floor journey
        # is due, whatever the campaign size, and the reason says why.
        return {"computed": False, "asOf": None, "due": [j["id"] for j in floor],
                "reason": "no readable run root ({}), so last-proven dates are unknown and every floor journey is due".format(run_root or "SMOKE_GATE_RUN_ROOT unset"),
                "entries": [{"id": j["id"], "lastProvenAt": None, "overdue": True} for j in floor]}
    entries = []
    for j in floor:
        proven = last_proven(run_root, j)
        overdue = proven is None or (as_of - proven).total_seconds() > j["maxIntervalDays"] * 86400
        entries.append({"id": j["id"], "lastProvenAt": proven.strftime("%Y-%m-%dT%H:%M:%SZ") if proven else None, "overdue": overdue})
    due = [e["id"] for e in entries if e["overdue"]]
    if not due and entries and size != "light":
        due = [min(entries, key=lambda e: e["lastProvenAt"])["id"]]
    return {"computed": True, "reason": None, "asOf": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"), "due": due, "entries": entries}


# --- match ------------------------------------------------------------------

def compute_selection(cat, digest, paths, unknown_reason, size, run_root, as_of, recover=False):
    journeys = cat["journeys"]
    exclude_reasons = dict(_exclude_entries(cat))
    exclude_rules = _globs.compile_rule_list(list(exclude_reasons))
    excluded, scope = [], []
    for p in paths:
        hit = _globs.match_first(p, exclude_rules)
        if hit:
            excluded.append({"path": p, "glob": hit, "reason": exclude_reasons[hit]})
        else:
            scope.append(p)

    hits = {}
    claimed = set()
    for j in journeys:
        rules = _globs.compile_rule_list(j["consumes"])
        mine = [p for p in scope if _globs.match_first(p, rules)]
        if mine:
            hits[j["id"]] = mine
            claimed.update(mine)
    unmapped = [p for p in scope if p not in claimed]

    # Native-manual is a ROUTE only when the change is non-empty and every path
    # in it is claimed, and claimed by nothing but native-manual journeys. One
    # unmapped path, or one path a browser/api journey also consumes, keeps the
    # campaign on the web route.
    by_id = {j["id"]: j for j in journeys}
    native_only = (
        unknown_reason is None and bool(scope) and not unmapped
        and all(by_id[i]["evidence"] == "native-manual" for i in hits)
    )
    route = "native-manual" if native_only and not recover else "web"

    # A native-manual campaign spends nothing on the web build it did not
    # change, so it owes the floor what a light campaign does: overdue only.
    floor = floor_due(cat, run_root, "light" if native_only else size, as_of)

    matched, unassessed_native = [], []
    for j in journeys:
        jid = j["id"]
        if recover:
            # The primary pin is unreadable, so what it owed is unknown: the
            # recovery pin owes every journey the catalogue holds.
            reason = "pin-recovered"
        elif unknown_reason is not None:
            # An unknown range selects everything that can be walked. Native
            # journeys need a named human tester, so they are listed for the
            # report instead of being turned into lanes nobody asked for --
            # EXCEPT a due floor journey: cadence is owed whatever the range.
            if j["evidence"] == "native-manual" and jid not in floor["due"]:
                unassessed_native.append(jid)
                continue
            reason = "floor" if j["evidence"] == "native-manual" else "range-unknown"
        elif jid in hits:
            reason = "changed"
        elif jid in floor["due"]:
            reason = "floor"
        else:
            continue
        mine = hits.get(jid, []) if unknown_reason is None else []
        matched.append({
            "id": jid, "reason": reason, "evidence": j["evidence"],
            "floor": j.get("maxIntervalDays") is not None,
            "matchedPathCount": len(mine), "matchedPaths": mine[:MATCHED_PATHS_SHOWN],
        })

    return {
        "schemaVersion": SCHEMA_VERSION,
        "selection": "full" if (unknown_reason is not None or recover) else "matched",
        "reason": ("recovered: this head's primary journeys pin is invalid, so every catalogue journey is owed"
                   + ("; " + unknown_reason if unknown_reason else "")) if recover else unknown_reason,
        "recovery": recover,
        "route": route,
        "catalogueValid": True,
        "catalogueSha256": digest,
        "matchedJourneys": matched,
        # Frozen once the gate pins this selection: a glob added to the
        # catalogue later does not take a path off this list.
        "unmappedPaths": [] if unknown_reason is not None else unmapped,
        "excludedPaths": [] if unknown_reason is not None else excluded,
        "unassessedNativeJourneys": unassessed_native,
        "floor": floor,
    }


def _write_atomic(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def cmd_match(args):
    """Compute one selection. Pinning is NOT done here: a campaign's pin is
    shared, immutable state the PR gate owns (journeys_pin_promote), beside
    the range pin it is derived from. `--snapshot-out` hands the gate the exact
    catalogue bytes this selection was computed from, so the snapshot it pins
    is the one that was hashed, not a second read of a file that may have
    moved."""
    try:
        paths = json.load(sys.stdin)
    except ValueError:
        paths = None
    unknown = args.unknown
    if unknown is None and (not isinstance(paths, list) or not all(isinstance(p, str) for p in paths)):
        unknown = "the changed-path list handed to the matcher was unreadable"
    paths = sorted(set(paths)) if unknown is None else []

    as_of = _parse_iso(args.as_of) if args.as_of else datetime.datetime.now(datetime.timezone.utc)
    if as_of is None:
        emit({"ok": False, "error": "--as-of is not an ISO timestamp"}, 2)

    cat, digest, raw, errors = load_catalogue(args.catalogue)
    if cat is None:
        # ONE rule for every unusable catalogue -- unreadable, unparseable, or
        # failing validation: no selection at all. A partial reading is worse
        # than none (it can name journeys while dropping every unclaimed path),
        # so the caller pins nothing and retries; `publish` validates before it
        # writes, so this only ever follows a hand edit.
        print(json.dumps({"ok": False, "error": "journey catalogue is unusable: " + "; ".join(errors[:3])}), file=sys.stderr)
        sys.exit(1)
    selection = compute_selection(cat, digest, paths, unknown, args.size, args.run_root, as_of, args.recover)
    selection.update({"pinned": False, "pinFile": None, "catalogueSnapshot": None})
    if args.snapshot_out and raw is not None:
        with open(args.snapshot_out, "wb") as fh:
            fh.write(raw)
    emit(selection)


# --- run-dir pin, shots -----------------------------------------------------

def _run_paths(run_dir):
    base = os.path.join(run_dir, "journeys")
    return base, os.path.join(base, "selection.json"), os.path.join(base, "catalogue.json")


# --- the ONE pin predicate ---------------------------------------------------
# The run never authors what it is held to; only the gate does, in immutable
# shared files -- and the gate (journeys_select, journeys_pin_promote), pin-run
# and the barrier all judge a pin HERE. Shape alone is not validity: the bytes
# {"pinned":true,"matchedJourneys":[],"unmappedPaths":[]} are invalid everywhere.

HEX64, HEX40 = re.compile(r"^[0-9a-f]{64}$"), re.compile(r"^[0-9a-f]{40}$")


def selection_problem(sel):
    """Why this object is not a complete, pinnable selection, or None."""
    if not isinstance(sel, dict) or sel.get("schemaVersion") != SCHEMA_VERSION:
        return "not a schemaVersion {} selection".format(SCHEMA_VERSION)
    if sel.get("selection") not in ("matched", "full") or sel.get("route") not in ("web", "native-manual"):
        return "selection/route is missing or unknown"
    if sel.get("catalogueValid") is not True or not isinstance(sel.get("catalogueSha256"), str) \
            or not HEX64.match(sel["catalogueSha256"]):
        return "it was not computed from a valid, hashed catalogue"
    if not isinstance(sel.get("recovery"), bool):
        return "recovery flag is missing"
    for key in ("unmappedPaths", "unassessedNativeJourneys"):
        if not isinstance(sel.get(key), list) or not all(isinstance(x, str) for x in sel[key]):
            return "{} must be a list of strings".format(key)
    matched = sel.get("matchedJourneys")
    if not isinstance(matched, list) or not isinstance(sel.get("excludedPaths"), list):
        return "matchedJourneys/excludedPaths must be lists"
    for m in matched:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not ID_RE.match(m["id"]) \
                or not _is_text(m.get("reason")) or m.get("evidence") not in EVIDENCE_KINDS \
                or not isinstance(m.get("floor"), bool):
            return "a matchedJourneys entry is malformed"
    # `full` means "walk everything": one that names nothing is the absence of
    # a selection, and pinned it would switch journey obligations off.
    if sel["selection"] == "full" and not matched and not sel["unassessedNativeJourneys"]:
        return "it is `full` but names no journey ({})".format(sel.get("reason") or "no reason given")
    return None


def pin_name(slug, pr, head, recovery):
    return "journeys-pin-{}-pr-{}-{}{}.json".format(slug, pr, head, "-recovery" if recovery else "")


def check_pin(path, pr=None, head=None, slug=None, as_path=None):
    """(state, reason, pin, raw, catalogue) for a journeys pin file; state is
    absent | invalid | valid. Valid means: a regular file; a complete pinnable
    selection; pinned for the repo/PR/head its own FILE NAME says (and the ones
    the caller expects); and its content-addressed catalogue snapshot, beside
    it, is a regular file that hashes to catalogueSha256, validates, and
    declares the evidence/floor the pin claims for every journey it names.
    `as_path` judges a not-yet-linked temp file as if it sat at its final path."""
    final = as_path or path
    # UNAVAILABLE is not INVALID. "Invalid" is a verdict on the BYTES (they are
    # there and they are wrong) and it licenses the gate to promote a recovery
    # pin; a checker that could not read (a permission error, a vanished
    # mount) has no verdict, and must never start a recovery for a pin that
    # may be perfectly valid. The caller retries later.
    try:
        if not os.path.lexists(path):
            return "absent", None, None, None, None
        if os.path.islink(path) or not os.path.isfile(path):
            return "invalid", "a symlink or not a regular file", None, None, None
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        return "unavailable", "the pin could not be read: {}".format(exc), None, None, None
    try:
        pin = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return "invalid", "truncated or malformed", None, None, None
    problem = selection_problem(pin)
    if problem is None and (pin.get("pinned") is not True or not isinstance(pin.get("headSha"), str)
                            or not HEX40.match(pin["headSha"]) or isinstance(pin.get("pr"), bool)
                            or not isinstance(pin.get("pr"), int) or not _is_text(pin.get("repoSlug"))):
        problem = "it carries no pinned repo/PR/head identity"
    if problem is None and os.path.basename(final) != pin_name(pin["repoSlug"], pin["pr"], pin["headSha"], pin["recovery"]):
        problem = "its contents are pinned for another repo/PR/head (or pin kind) than its file name"
    if problem is None:
        for label, want, got in (("PR", pr, pin["pr"]), ("head", head, pin["headSha"]), ("repo", slug, pin["repoSlug"])):
            if want is not None and str(want) != str(got):
                problem = "it is pinned for {} {}, not {}".format(label, got, want)
    cat = None
    if problem is None:
        snapshot = os.path.join(os.path.dirname(os.path.abspath(final)), "journeys-catalogue-{}.json".format(pin["catalogueSha256"]))
        if os.path.basename(str(pin.get("catalogueSnapshot"))) != os.path.basename(snapshot):
            problem = "catalogueSnapshot does not name its content-addressed snapshot"
        elif os.path.islink(snapshot) or not os.path.isfile(snapshot):
            problem = "its catalogue snapshot {} is missing or not a regular file".format(snapshot)
        else:
            cat, digest, _, errors = load_catalogue(snapshot)
            if digest is None:
                return "unavailable", "its catalogue snapshot could not be read: {}".format("; ".join(errors[:1])), None, None, None
            if digest != pin["catalogueSha256"]:
                problem, cat = "its catalogue snapshot does not hash to catalogueSha256", None
            elif cat is None:
                problem = "its catalogue snapshot is not a valid catalogue: {}".format("; ".join(errors[:2]))
    if problem is None:
        declared = {j["id"]: (j["evidence"], j.get("maxIntervalDays") is not None) for j in cat["journeys"]}
        for m in pin["matchedJourneys"]:
            if declared.get(m["id"]) != (m["evidence"], m["floor"]):
                problem = "journey {} is not in its catalogue snapshot with that evidence/floor".format(m["id"])
        if problem is None and pin["recovery"] and {m["id"] for m in pin["matchedJourneys"]} != set(declared):
            problem = "a recovery pin must name every journey in its catalogue snapshot"
    if problem is not None:
        return "invalid", problem, None, None, None
    return "valid", None, pin, raw, cat


def resolve_owner(primary, pr=None, head=None, slug=None):
    """THE owning pin for (repo, PR, head), decided in one place for the gate's
    lookup, its promotion and the barrier: a valid RECOVERY pin owns if one
    exists (it is only ever created after a definite invalid primary, so it
    takes precedence and the owner can never flip back), else the valid
    primary, else nothing. Any checker that is UNAVAILABLE makes the answer
    unavailable -- no decision is taken on a pin nobody could read."""
    recovery = primary[:-len(".json")] + "-recovery.json"
    r_state, r_reason, r_pin, r_raw, r_cat = check_pin(recovery, pr, head, slug)
    p_state, p_reason, p_pin, p_raw, p_cat = check_pin(primary, pr, head, slug)
    out = {"primary": {"path": primary, "state": p_state, "reason": p_reason},
           "recovery": {"path": recovery, "state": r_state, "reason": r_reason}}
    if r_state == "valid":
        out.update({"state": "valid", "owner": recovery, "pin": r_pin, "raw": r_raw, "cat": r_cat})
    elif "unavailable" in (r_state, p_state):
        out.update({"state": "unavailable", "owner": None, "reason": p_reason if p_state == "unavailable" else r_reason})
    elif p_state == "valid":
        out.update({"state": "valid", "owner": primary, "pin": p_pin, "raw": p_raw, "cat": p_cat})
    elif p_state == "absent" and r_state == "absent":
        out.update({"state": "absent", "owner": None})
    else:
        out.update({"state": "invalid", "owner": None,
                    "reason": "neither journeys pin for this head is valid: {} ({}); {} ({})".format(
                        primary, p_reason or "absent", recovery, r_reason or "absent")})
    return out


def cmd_pin_check(args):
    if args.owner:
        out = resolve_owner(args.pin_file, args.pr, args.head, args.repo_slug)
        emit({k: v for k, v in out.items() if k not in ("raw", "cat")})
    if args.candidate:
        try:
            problem = selection_problem(json.load(sys.stdin))
        except ValueError:
            problem = "not JSON"
        emit({"state": "invalid" if problem else "valid", "reason": problem})
    state, reason, pin, _, _ = check_pin(args.pin_file, args.pr, args.head, args.repo_slug, args.as_path or None)
    emit({"state": state, "reason": reason, "pin": pin})


def cmd_pin_run(args):
    """Adopt a GATE-authored pin into the run, byte for byte. Nothing else can
    become a run's selection: not a copy of a pin's contents, not an invalid
    pin, and never anything assembled on the run side."""
    base, selection_path, catalogue_path = _run_paths(args.run_dir)
    if not os.path.isdir(args.run_dir):
        emit({"ok": False, "error": "run dir does not exist"}, 2)
    state, reason, pin, pin_raw, _ = check_pin(args.pin_file)
    if state != "valid":
        emit({"ok": False, "error": "{} is not a valid gate pin ({}) -- pass journeys.pinFile from the wake payload exactly; when the primary pin is invalid the gate offers the campaign only with its recovery pin, and that is the pinFile it sends".format(args.pin_file, reason or "no file there")}, 1)
    with open(os.path.join(os.path.dirname(os.path.abspath(args.pin_file)), os.path.basename(pin["catalogueSnapshot"])), "rb") as fh:
        snapshot_raw = fh.read()
    # Write-once, byte-for-byte.
    if os.path.exists(selection_path):
        with open(selection_path, "rb") as fh:
            if fh.read() != pin_raw:
                emit({"ok": False, "error": "this run already pinned a different selection; a run's journey contract is fixed once written"}, 1)
        emit({"ok": True, "selection": selection_path, "catalogue": catalogue_path, "alreadyPinned": True})
    os.makedirs(base, exist_ok=True)
    _write_atomic(catalogue_path, snapshot_raw)
    _write_atomic(selection_path, pin_raw)
    emit({"ok": True, "selection": selection_path, "catalogue": catalogue_path, "alreadyPinned": False})


def cmd_shots(args):
    _, selection_path, catalogue_path = _run_paths(args.run_dir)
    selection, cat = _read_json(selection_path), _read_json(catalogue_path)
    if not isinstance(selection, dict) or not isinstance(cat, dict):
        emit({"ok": False, "error": "run has no pinned selection and catalogue; run pin-run first"}, 1)
    wanted = [m["id"] for m in selection.get("matchedJourneys", [])]
    shots, dropped = [], 0
    for j in cat.get("journeys", []):
        if j.get("id") not in wanted:
            continue
        for r in j.get("captureRecipes", []):
            if any(s["name"] == r["name"] for s in shots):
                continue
            if len(shots) >= SHOTS_CAP:
                dropped += 1
                continue
            shots.append(r)
    emit({"ok": True, "shots": shots, "droppedOverCap": dropped})


# --- barrier ----------------------------------------------------------------

def _run_file_ok(run_dir, rel):
    """A cited evidence file must be a real, non-empty regular file inside the
    run -- the same bar smoke-evidence-barrier.sh sets for pass evidence."""
    if not _is_text(rel) or os.path.isabs(rel) or ".." in rel.split("/"):
        return False
    root = os.path.realpath(run_dir)
    candidate = os.path.join(run_dir, rel)
    real = os.path.realpath(candidate)
    return (
        real.startswith(root + os.sep) and not os.path.islink(candidate)
        and os.path.isfile(candidate) and os.path.getsize(candidate) > 0
    )


def cmd_barrier(args):
    """Completeness only. Whether a disposition is TRUE, or a matched journey
    was walked well, is the challenger's question, not this one's."""
    run_dir = args.run_dir
    _, selection_path, catalogue_path = _run_paths(run_dir)
    missing, invalid, reasons = [], [], []
    sel_rel, cat_rel, disp_rel = "journeys/selection.json", "journeys/catalogue.json", "journeys/scope-dispositions.json"

    def bad(rel, why):
        if rel not in invalid:
            invalid.append(rel)
        reasons.append("{}: {}".format(rel, why))

    # Whether this run owes a journey selection, and WHAT it owes, are the
    # gate's: `--gate-pin` is the one primary-pin path this campaign owns (passed
    # only when something is there). The owning pin is the primary if check_pin
    # says valid, else the gate's recovery pin if valid, else nothing -- and
    # nothing is a refusal. Every requirement below is read from that pin and
    # its verified snapshot in the shared lease dir; the run's own copies are
    # only compared against them.
    if not args.gate_pin:
        if os.path.exists(selection_path):
            bad(sel_rel, "this run holds a journey selection but no gate pin owns it (not a PR campaign, or no pin for its repo/PR/head in the shared lease dir) -- a selection is only ever the gate's, adopted with pin-run")
            emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})
        emit({"applies": False, "missing": [], "invalid": [], "invalidReasons": []})
    owner = resolve_owner(args.gate_pin, args.pr, args.head)
    if owner["state"] != "valid":
        bad(sel_rel, "this campaign has no usable journeys pin ({}) -- nothing can say what the run owes, so nothing clears it; the gate does not offer a head in this state".format(
            owner.get("reason") or "primary {}, recovery {}".format(owner["primary"]["state"], owner["recovery"]["state"])))
        emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})
    owning, selection, gate_raw, cat = owner["owner"], owner["pin"], owner["raw"], owner["cat"]
    try:
        with open(selection_path, "rb") as fh:
            run_raw = fh.read()
    except OSError:
        run_raw = None
    if run_raw is None:
        bad(sel_rel, "the gate pinned a journey selection for this campaign but the run never adopted it -- run `smoke-journeys.py pin-run {} {}`, then scaffold a lane per matched journey".format(run_dir, owning))
    elif run_raw != gate_raw:
        run = _read_json(selection_path)
        run = run if isinstance(run, dict) else {}
        bad(sel_rel, "does not match this campaign's own gate pin {} (run adopted pinFile={} catalogueSha256={}; gate catalogueSha256={}) -- a run's journey contract is its OWN campaign's pin, byte for byte; re-run pin-run in a clean run dir".format(
            owning, run.get("pinFile"), run.get("catalogueSha256"), selection["catalogueSha256"]))
    if invalid:
        emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})
    # The copy workers read must be the snapshot the gate pinned.
    try:
        with open(catalogue_path, "rb") as fh:
            if sha256_bytes(fh.read()) != selection["catalogueSha256"]:
                bad(cat_rel, "does not hash to the gate pin's catalogueSha256 -- the run's catalogue was edited after it was pinned")
    except OSError:
        missing.append(cat_rel)

    declared = {j["id"]: (j["evidence"], j.get("maxIntervalDays") is not None) for j in cat["journeys"]}
    catalogue_ids = set(declared)
    contract = _read_json(os.path.join(run_dir, "completion-contract.json")) or {}
    required = set(contract.get("requiredLaneMarkers") or [])

    def has_lane(jid):
        return "markers/{}.json".format(jid) in required

    def journey_lane_problem(jid):
        # A journey the catalogue does not hold (a new-journey) has no api grant.
        evidence, is_floor = declared.get(jid, ("browser", False))
        for rel, problem in lane_problems(run_dir, contract, jid, evidence, is_floor):
            bad(rel, problem)
        marker = _read_json(os.path.join(run_dir, "markers", jid + ".json"))
        if isinstance(marker, dict) and marker.get("status") == "pass":
            for problem in pass_identity_problems(contract, marker, jid):
                bad("markers/{}.json".format(jid), problem)

    for m in selection["matchedJourneys"]:
        if not has_lane(m["id"]):
            bad(sel_rel, "matched journey {} ({}) has no lane in the completion contract".format(m["id"], m["reason"]))
            continue
        journey_lane_problem(m["id"])

    unmapped = selection["unmappedPaths"]
    if unmapped:
        doc = _read_json(os.path.join(run_dir, disp_rel))
        if doc is None:
            if os.path.exists(os.path.join(run_dir, disp_rel)):
                bad(disp_rel, "not valid JSON")
            else:
                missing.append(disp_rel)
        else:
            entries = doc.get("dispositions") if isinstance(doc, dict) else None
            if not isinstance(entries, list):
                bad(disp_rel, "must be an object with a dispositions list")
                entries = []
            covered = set()
            for i, d in enumerate(entries):
                tag = "dispositions[{}]".format(i)
                if not isinstance(d, dict) or not _text_list(d.get("paths"), allow_empty=False):
                    bad(disp_rel, "{} needs a non-empty paths list".format(tag))
                    continue
                kind = d.get("disposition")
                problem = None
                if kind not in DISPOSITIONS:
                    problem = "disposition must be one of {}".format("|".join(DISPOSITIONS))
                elif kind in ("mapped-to-journey", "new-journey"):
                    jid = d.get("journeyId")
                    if not _is_text(jid):
                        problem = "{} needs a journeyId".format(kind)
                    elif kind == "mapped-to-journey" and jid not in catalogue_ids:
                        problem = "journeyId {} is not in the pinned catalogue (use new-journey)".format(jid)
                    elif kind == "new-journey" and jid in catalogue_ids:
                        problem = "journeyId {} already exists in the pinned catalogue (use mapped-to-journey)".format(jid)
                    elif not has_lane(jid):
                        problem = "journey {} has no lane in the completion contract, so nothing proves it ran".format(jid)
                    else:
                        journey_lane_problem(jid)
                elif kind == "no-user-facing-consumer":
                    cited = d.get("evidence")
                    if not _is_text(d.get("changedBehaviour")):
                        problem = "no-user-facing-consumer must name the changedBehaviour"
                    elif not _text_list(cited, allow_empty=False) or not any(_run_file_ok(run_dir, e) for e in cited):
                        problem = "no-user-facing-consumer must cite evidence, at least one entry a non-empty file in this run (the saved source search)"
                elif not _is_text(d.get("reason")):
                    problem = "unresolved needs a reason"
                if problem:
                    bad(disp_rel, "{}: {}".format(tag, problem))
                else:
                    covered.update(d["paths"])
            for p in unmapped:
                if p not in covered:
                    bad(disp_rel, "frozen unmapped path has no valid scope disposition: {}".format(p))

    emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})


# --- publish ----------------------------------------------------------------

def _without_notes(value):
    """`_`-prefixed keys are notes, at any depth; everything else is content."""
    if isinstance(value, dict):
        return {k: _without_notes(v) for k, v in value.items() if not k.startswith("_")}
    if isinstance(value, list):
        return [_without_notes(v) for v in value]
    return value


def _floor_view(cat):
    """The COMPLETE floor entries, by id. Not just the claim: a floor journey
    whose steps, endState, seed or checkpoints were thinned still "proves" the
    same sentence while testing less, so every field is the human's call. Dict
    equality ignores key order; only `_` notes are left out."""
    return {
        j["id"]: _without_notes(j)
        for j in (cat or {}).get("journeys", []) if j.get("maxIntervalDays") is not None
    }


def cmd_publish(args):
    # One publisher per agent group. Owners and challengers propose; they do
    # not write the catalogue a later campaign will be matched against.
    if os.environ.get("SMOKE_LANE_ROLE") != "coordinator":
        emit({"ok": False, "error": "only SMOKE_LANE_ROLE=coordinator publishes the journey catalogue"}, 2)
    proposed, new_digest, new_raw, errors = load_catalogue(args.proposed)
    if proposed is None:
        emit({"ok": False, "error": "proposed catalogue is invalid", "errors": errors}, 1)

    os.makedirs(os.path.dirname(os.path.abspath(args.lock)), exist_ok=True)
    with open(args.lock, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(args.catalogue, "rb") as fh:
                prior_raw = fh.read()
            prior_digest = sha256_bytes(prior_raw)
        except FileNotFoundError:
            prior_raw, prior_digest = None, "absent"
        if prior_digest != args.expect_sha256:
            emit({"ok": False, "error": "catalogue changed since this proposal was based on it", "expected": args.expect_sha256, "actual": prior_digest}, 1)
        # Floor membership and proof claims are a human's call, not a
        # publisher's: adding, dropping, or weakening one needs a citation. An
        # ABSENT catalogue has an EMPTY floor -- so the first publish, which is
        # the one that creates the floor, is held to it too. A prior that
        # cannot be read is a floor nobody can compare against: refused alike.
        try:
            prior_floor = {} if prior_raw is None else _floor_view(json.loads(prior_raw.decode("utf-8")))
            floor_changed = prior_floor != _floor_view(proposed)
        except (ValueError, UnicodeDecodeError, KeyError, TypeError, AttributeError):
            floor_changed = True
        if floor_changed and not _is_text(args.floor_authority):
            emit({"ok": False, "error": "this proposal changes floor membership or a floor journey (any field but a `_` note; a first publish that declares floor journeys included); that is a human call -- pass --floor-authority <where it was approved>"}, 1)
        _write_atomic(os.path.abspath(args.catalogue), new_raw)
    emit({"ok": True, "catalogue": args.catalogue, "sha256": new_digest, "priorSha256": prior_digest,
          "journeyCount": len(proposed["journeys"]), "floorAuthority": args.floor_authority or None,
          "warnings": catalogue_warnings(proposed)})


# --- cli --------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(prog="smoke-journeys.py")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate")
    p.add_argument("catalogue")

    p = sub.add_parser("match")
    p.add_argument("--catalogue", required=True)
    p.add_argument("--snapshot-out", default="")
    p.add_argument("--recover", action="store_true")
    p.add_argument("--unknown")
    p.add_argument("--size", default="standard")
    p.add_argument("--run-root", default="")
    p.add_argument("--as-of")

    p = sub.add_parser("floor-due")
    p.add_argument("catalogue")
    p.add_argument("run_root")
    p.add_argument("--size", default="standard")
    p.add_argument("--as-of")

    p = sub.add_parser("pin-run")
    p.add_argument("run_dir")
    p.add_argument("pin_file")

    p = sub.add_parser("pin-check")
    p.add_argument("pin_file", nargs="?", default="")
    p.add_argument("--candidate", action="store_true")
    p.add_argument("--owner", action="store_true")
    p.add_argument("--pr", type=int)
    p.add_argument("--head")
    p.add_argument("--repo-slug")
    p.add_argument("--as-path", default="")

    p = sub.add_parser("shots")
    p.add_argument("run_dir")

    p = sub.add_parser("barrier")
    p.add_argument("run_dir")
    p.add_argument("--gate-pin", default="")
    p.add_argument("--pr", type=int)
    p.add_argument("--head")

    p = sub.add_parser("publish")
    p.add_argument("catalogue")
    p.add_argument("proposed")
    p.add_argument("--expect-sha256", required=True)
    p.add_argument("--lock", required=True)
    p.add_argument("--floor-authority", default="")

    args = parser.parse_args()
    if args.command == "validate":
        cat, digest, _, errors = load_catalogue(args.catalogue)
        emit({"ok": cat is not None, "sha256": digest, "errors": errors,
              "warnings": catalogue_warnings(cat) if cat else [],
              "journeyCount": len(cat["journeys"]) if cat else 0}, 0 if cat is not None else 1)
    if args.command == "floor-due":
        cat, _, _, errors = load_catalogue(args.catalogue)
        if cat is None:
            emit({"ok": False, "errors": errors}, 1)
        as_of = _parse_iso(args.as_of) if args.as_of else datetime.datetime.now(datetime.timezone.utc)
        if as_of is None:
            emit({"ok": False, "error": "--as-of is not an ISO timestamp"}, 2)
        emit(floor_due(cat, args.run_root, args.size, as_of))
    {"match": cmd_match, "pin-run": cmd_pin_run, "pin-check": cmd_pin_check, "shots": cmd_shots,
     "barrier": cmd_barrier, "publish": cmd_publish}[args.command](args)


if __name__ == "__main__":
    main()
