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
  shots     <run-dir>
  barrier   <run-dir> [--gate-pin <file>]...
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
    # A match-everything glob leaves no path unmapped, which silences the one
    # list that forces somebody to explain a change nothing claims.
    if all(seg in ("**", "*") for seg in g.split("/")):
        return "matches every path; name the consumed area"
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
        segs = g.split("/")
        if segs[0] in ("**", "*") or segs[0].startswith("*") or (len(segs) == 2 and segs[1] == "**"):
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
    if not isinstance(journeys, list):
        return errors + ["journeys must be a list"]
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


def last_proven(run_root, journey_id):
    """Newest completedAt of a `pass` marker for this lane id that carries
    proof: browser media, or a run whose own contract declared the lane
    evidence:"api". A pass with neither never resets the clock."""
    newest = None
    try:
        runs = sorted(os.listdir(run_root))
    except OSError:
        return None
    for run in runs:
        marker = _read_json(os.path.join(run_root, run, "markers", journey_id + ".json"))
        if not isinstance(marker, dict) or marker.get("status") != "pass":
            continue
        evidence = marker.get("evidence") or []
        has_media = any(isinstance(e, str) and MEDIA_RE.search(e) for e in evidence)
        if not has_media:
            contract = _read_json(os.path.join(run_root, run, "completion-contract.json"))
            lanes = contract.get("lanes") if isinstance(contract, dict) else None
            is_api = any(
                isinstance(l, dict) and l.get("id") == journey_id and l.get("evidence") == "api"
                for l in (lanes or [])
            )
            if not is_api:
                continue
        done = _parse_iso(marker.get("completedAt"))
        if done is not None and (newest is None or done > newest):
            newest = done
    return newest


def floor_due(cat, run_root, size, as_of):
    """Which floor journeys this campaign owes. Every entry past its interval
    is due; when none is, a standard/full campaign owes the single
    least-recently-proven one and a light campaign owes nothing."""
    floor = [j for j in cat["journeys"] if j.get("maxIntervalDays") is not None]
    if not run_root or not os.path.isdir(run_root):
        return {"computed": False, "reason": "no readable run root, so last-proven dates are unknown", "asOf": None, "due": [], "entries": []}
    entries = []
    for j in floor:
        proven = last_proven(run_root, j["id"])
        overdue = proven is None or (as_of - proven).total_seconds() > j["maxIntervalDays"] * 86400
        entries.append({"id": j["id"], "lastProvenAt": proven.strftime("%Y-%m-%dT%H:%M:%SZ") if proven else None, "overdue": overdue})
    due = [e["id"] for e in entries if e["overdue"]]
    if not due and entries and size != "light":
        due = [min(entries, key=lambda e: e["lastProvenAt"])["id"]]
    return {"computed": True, "reason": None, "asOf": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"), "due": due, "entries": entries}


# --- match ------------------------------------------------------------------

def compute_selection(cat, digest, paths, unknown_reason, size, run_root, as_of):
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
    route = "native-manual" if native_only else "web"

    # A native-manual campaign spends nothing on the web build it did not
    # change, so it owes the floor what a light campaign does: overdue only.
    floor = floor_due(cat, run_root, "light" if native_only else size, as_of)

    matched, unassessed_native = [], []
    for j in journeys:
        jid = j["id"]
        if unknown_reason is not None:
            # An unknown range selects everything that can be walked. Native
            # journeys need a named human tester, so they are listed for the
            # report instead of being turned into lanes nobody asked for.
            if j["evidence"] == "native-manual":
                unassessed_native.append(jid)
                continue
            reason = "range-unknown"
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
        "selection": "full" if unknown_reason is not None else "matched",
        "reason": unknown_reason,
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


def broken_selection(digest, problem):
    """A catalogue that is present but unusable never reads as "no journeys
    matched": the campaign is full and says why."""
    return {
        "schemaVersion": SCHEMA_VERSION, "selection": "full",
        "reason": "journey catalogue is unusable: {}".format(problem), "route": "web",
        "catalogueValid": False, "catalogueSha256": digest,
        "matchedJourneys": [], "unmappedPaths": [], "excludedPaths": [],
        "unassessedNativeJourneys": [],
        "floor": {"computed": False, "reason": "journey catalogue is unusable", "asOf": None, "due": [], "entries": []},
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
        selection = broken_selection(digest, "; ".join(errors[:3]))
    else:
        selection = compute_selection(cat, digest, paths, unknown, args.size, args.run_root, as_of)
    selection.update({"pinned": False, "pinFile": None, "catalogueSnapshot": None})
    if args.snapshot_out and raw is not None:
        with open(args.snapshot_out, "wb") as fh:
            fh.write(raw)
    emit(selection)


# --- run-dir pin, shots -----------------------------------------------------

def _run_paths(run_dir):
    base = os.path.join(run_dir, "journeys")
    return base, os.path.join(base, "selection.json"), os.path.join(base, "catalogue.json")


def cmd_pin_run(args):
    base, selection_path, catalogue_path = _run_paths(args.run_dir)
    if not os.path.isdir(args.run_dir):
        emit({"ok": False, "error": "run dir does not exist"}, 2)
    pin_raw, selection = b"", None
    try:
        with open(args.pin_file, "rb") as fh:
            pin_raw = fh.read()
        selection = json.loads(pin_raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        emit({"ok": False, "error": "gate pin file could not be read: {}".format(exc)}, 1)
    if not isinstance(selection, dict) or selection.get("pinned") is not True:
        emit({"ok": False, "error": "not a pinned selection -- pass the pinFile path from the wake payload, not a copy of its contents"}, 1)
    snapshot_raw = None
    if selection.get("catalogueSnapshot"):
        snapshot_raw = b""
        try:
            with open(selection["catalogueSnapshot"], "rb") as fh:
                snapshot_raw = fh.read()
        except OSError as exc:
            emit({"ok": False, "error": "pinned catalogue snapshot could not be read: {}".format(exc)}, 1)
        if sha256_bytes(snapshot_raw) != selection.get("catalogueSha256"):
            emit({"ok": False, "error": "pinned catalogue snapshot does not hash to catalogueSha256"}, 1)
    # Write-once, byte-for-byte: `cmp` against the gate's pin file is the
    # challenger's whole check that nobody narrowed the scope on the way in.
    if os.path.exists(selection_path):
        with open(selection_path, "rb") as fh:
            if fh.read() != pin_raw:
                emit({"ok": False, "error": "this run already pinned a different selection; a run's journey contract is fixed once written"}, 1)
        emit({"ok": True, "selection": selection_path, "catalogue": catalogue_path if snapshot_raw else None, "alreadyPinned": True})
    os.makedirs(base, exist_ok=True)
    if snapshot_raw is not None:
        _write_atomic(catalogue_path, snapshot_raw)
    _write_atomic(selection_path, pin_raw)
    emit({"ok": True, "selection": selection_path, "catalogue": catalogue_path if snapshot_raw else None, "alreadyPinned": False})


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

    # Whether this run owes a journey selection is the GATE's decision, not the
    # run's bookkeeping: a pin the gate wrote for this campaign must be in the
    # run byte-for-byte, so skipping pin-run (or pinning a narrowed copy) is a
    # refusal rather than a way out of every check below.
    #
    # Only a VALID pin can be adopted. Anything else at a pin's path (a symlink,
    # a directory, truncated JSON) is what the gate itself reports as
    # pinState:"invalid" -- scope unrecoverable, campaign `full`, no pinFile to
    # hand to pin-run -- so there is nothing here to hold the run to.
    gate_pins = []
    for pin_path in args.gate_pin:
        if os.path.islink(pin_path) or not os.path.isfile(pin_path):
            continue
        try:
            with open(pin_path, "rb") as fh:
                raw = fh.read()
            if json.loads(raw.decode("utf-8")).get("pinned") is True:
                gate_pins.append((pin_path, raw))
        except (OSError, ValueError, UnicodeDecodeError, AttributeError):
            continue
    if gate_pins:
        try:
            with open(selection_path, "rb") as fh:
                run_raw = fh.read()
        except OSError:
            run_raw = None
        if run_raw is None:
            bad(sel_rel, "the gate pinned a journey selection for this campaign but the run never adopted it -- run `smoke-journeys.py pin-run {} {}`, then scaffold a lane per matched journey".format(run_dir, gate_pins[0][0]))
        elif not any(raw == run_raw for _, raw in gate_pins):
            gate = _read_json(gate_pins[0][0])
            run = _read_json(selection_path)
            bad(sel_rel, "does not match the gate's pin {} (catalogueSha256 run={} gate={}) -- a run's journey contract is the gate's, byte for byte; re-run pin-run in a clean run dir".format(
                gate_pins[0][0],
                run.get("catalogueSha256") if isinstance(run, dict) else "unreadable",
                gate.get("catalogueSha256") if isinstance(gate, dict) else "unreadable"))
        if invalid:
            emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})
    if not os.path.exists(selection_path):
        emit({"applies": False, "missing": [], "invalid": [], "invalidReasons": []})

    selection = _read_json(selection_path)
    if not isinstance(selection, dict) or not isinstance(selection.get("matchedJourneys"), list) \
            or not isinstance(selection.get("unmappedPaths"), list):
        bad(sel_rel, "not a pinned journey selection")
        emit({"applies": True, "missing": missing, "invalid": invalid, "invalidReasons": reasons})

    catalogue_ids = set()
    if selection.get("catalogueValid") is True:
        try:
            with open(catalogue_path, "rb") as fh:
                raw = fh.read()
            if sha256_bytes(raw) != selection.get("catalogueSha256"):
                bad(cat_rel, "does not hash to the selection's catalogueSha256 -- the run's catalogue was edited after it was pinned")
            else:
                catalogue_ids = {j.get("id") for j in json.loads(raw.decode("utf-8")).get("journeys", [])}
        except (OSError, ValueError, UnicodeDecodeError):
            missing.append(cat_rel)

    contract = _read_json(os.path.join(run_dir, "completion-contract.json")) or {}
    required = set(contract.get("requiredLaneMarkers") or [])
    lanes = {l.get("id"): l for l in (contract.get("lanes") or []) if isinstance(l, dict)}

    def has_lane(jid):
        return "markers/{}.json".format(jid) in required

    for m in selection["matchedJourneys"]:
        jid, evidence = m.get("id"), m.get("evidence")
        if not has_lane(jid):
            bad(sel_rel, "matched journey {} ({}) has no lane in the completion contract".format(jid, m.get("reason")))
            continue
        # The api exemption is the catalogue's to grant, never the scaffold's.
        if lanes.get(jid, {}).get("evidence") == "api" and evidence != "api":
            bad(sel_rel, "lane {} is scaffolded --evidence api but its journey declares evidence {}".format(jid, evidence))
        if evidence == "native-manual":
            marker = _read_json(os.path.join(run_dir, "markers", jid + ".json"))
            if isinstance(marker, dict) and marker.get("status") == "pass" and not any(
                isinstance(e, str) and e.startswith("manual-results/") for e in (marker.get("evidence") or [])
            ):
                bad("markers/{}.json".format(jid), "a native-manual journey passes only on the named tester's recorded result under manual-results/ -- issuing the packet is `completed`, not `pass`")

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

def _floor_view(cat):
    return {
        j["id"]: (j["proves"], j["maxIntervalDays"], j["evidence"])
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
        prior = None
        if prior_raw is not None:
            try:
                prior = json.loads(prior_raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                prior = None
        # Floor membership and proof claims are a human's call, not a
        # publisher's: adding, dropping, or weakening one needs a citation.
        if isinstance(prior, dict) and isinstance(prior.get("journeys"), list):
            try:
                floor_changed = _floor_view(prior) != _floor_view(proposed)
            except (KeyError, TypeError, AttributeError):
                floor_changed = True
            if floor_changed and not _is_text(args.floor_authority):
                emit({"ok": False, "error": "this proposal changes floor membership or a floor journey's proves/maxIntervalDays/evidence; that is a human call -- pass --floor-authority <where it was approved>"}, 1)
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

    p = sub.add_parser("shots")
    p.add_argument("run_dir")

    p = sub.add_parser("barrier")
    p.add_argument("run_dir")
    p.add_argument("--gate-pin", action="append", default=[])

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
    {"match": cmd_match, "pin-run": cmd_pin_run, "shots": cmd_shots,
     "barrier": cmd_barrier, "publish": cmd_publish}[args.command](args)


if __name__ == "__main__":
    main()
