#!/usr/bin/env python3
"""Acceptance contract: extract the PR body's block, check provenance and
results, print the report sentence.

An acceptance item is one request-sourced, user-observable expectation with a
stable id, quoted from a FROZEN request source (an issue body, a Slack thread,
the PR body's prose) so a `met` can be tied back to what was asked, not to
what the author chose to promise. This script is read-only bookkeeping beside
the lane -- it decides nothing about the verdict and the barrier never reads
it (smoke-evidence-barrier.sh:590-600 turns every invalid entry into exit 1,
so a warning channel cannot live there; SKILL.md "Acceptance verifier").

  extract <run-dir> [--force]       intent/pr-body.md (and intent/pr-<n>-body.md
                                    for a freeze campaign) -> intent/acceptance.json
  check   <run-dir> [--lane <id>]   provenance, ids, completeness, evidence,
                                    not_demonstrable / blocked shape
  report  <run-dir>                 the one Untested-line sentence

Every command prints one JSON object except `report`, which prints the sentence.
Stdlib only, no network, never writes outside <run-dir>/intent/.
"""
import argparse
import glob
import json
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True

SCHEMA_VERSION = 1
BLOCK_VERSION = 1
FENCE_LANG = "acceptance-v1"
# An open fence line for the block. Closed fences are matched by FENCE_RE; the
# two counts must agree or the body holds an unterminated block, which is
# invalid rather than "no block" -- an author who opened one meant to write one.
FENCE_OPEN_RE = re.compile(r"^[ \t]*`{3,}[ \t]*" + FENCE_LANG + r"[ \t]*$", re.M)
FENCE_RE = re.compile(r"^[ \t]*(`{3,})[ \t]*" + FENCE_LANG + r"[ \t]*\n(.*?)^[ \t]*\1[ \t]*$",
                      re.M | re.S)
# `pr<n>/` is the freeze-campaign prefix (one block per carried PR); the rest
# is the scaffold's lane-id alphabet (smoke-journeys.py ID_RE, :54).
ITEM_ID_RE = re.compile(r"^(pr[0-9]+/)?[A-Za-z0-9_-]+$")
SOURCE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")
SURFACE_RE = re.compile(r"^(web:\S.*|api:[A-Z]+ \S.*|native:\S.*)$")
PLATFORMS = ("web", "native", "api")
VERDICTS = ("met", "not_met", "not_demonstrable", "blocked")
OBSERVED_KINDS = ("text", "dom", "api", "screenshot-only")
EXCERPT_MAX = 500
ITEM_REQUIRED = ("id", "source", "quote", "when", "then", "platform")
ITEM_KEYS = set(ITEM_REQUIRED) | {"actor", "given", "negative", "derived"}
THEN_KEYS = {"surface", "expect"}
NEGATIVE_KEYS = {"given", "expect"}
BLOCK_KEYS = {"v", "sources", "items", "reason"}
ROW_KEYS = {"itemId", "verdict", "observed", "evidence", "blockedBy"}


def emit(obj, code=0):
    print(json.dumps(obj, separators=(",", ":")))
    sys.exit(code)


def _is_text(v):
    return isinstance(v, str) and v.strip() != ""


def _unknown_keys(obj, allowed):
    return sorted(k for k in obj if k not in allowed and not k.startswith("_"))


def normalise(text):
    """Whitespace-normalised: every run of whitespace (line wraps included) is
    one space. Nothing else is folded -- case, punctuation and quote marks
    must match, or the item is quoting something the source did not say."""
    return " ".join(text.split())


def strip_fences(body):
    """The PR body with EVERY acceptance-v1 fence removed. This is the text a
    `pr-body` quote is searched in: a quote that lives only inside the block
    would otherwise validate against itself (the consult's tautology)."""
    return FENCE_RE.sub("", body)


# --- block ------------------------------------------------------------------

def parse_block(body):
    """(block_dict, problems). A body with no fence at all is (None, []);
    anything else wrong is (None, [why]) -- the lane then derives (§3)."""
    opens = len(FENCE_OPEN_RE.findall(body))
    fences = FENCE_RE.findall(body)
    if opens == 0:
        return None, []
    if opens != len(fences):
        return None, ["an {} fence is not terminated".format(FENCE_LANG)]
    if len(fences) != 1:
        return None, ["{} {} fences; exactly one is allowed".format(len(fences), FENCE_LANG)]
    try:
        block = json.loads(fences[0][1])
    except ValueError as exc:
        return None, ["block is not valid JSON: {}".format(exc)]
    problems = validate_block(block)
    return (block if not problems else None), problems


def validate_block(block):
    if not isinstance(block, dict):
        return ["block is not a JSON object"]
    errors = []
    if block.get("v") != BLOCK_VERSION:
        errors.append("v must be {}".format(BLOCK_VERSION))
    for k in _unknown_keys(block, BLOCK_KEYS):
        errors.append("unknown top-level key {}".format(k))
    sources = block.get("sources")
    if not isinstance(sources, dict) or not sources:
        errors.append("sources must be a non-empty object of {key: request}")
        sources = {}
    for k, v in sources.items():
        if not SOURCE_KEY_RE.match(k) or not _is_text(v):
            errors.append("sources.{}: key must match {} and name a request".format(k, SOURCE_KEY_RE.pattern))
        elif source_path(v, None) is None:
            errors.append("sources.{}: {!r} is not issue#<n>, slack:<channel>/<thread> or pr-body".format(k, v))
    items = block.get("items")
    if items == "none":
        if not _is_text(block.get("reason")):
            errors.append("items \"none\" needs a reason")
        return errors
    if "reason" in block:
        errors.append("reason belongs only with items \"none\"")
    if not isinstance(items, list) or not items:
        return errors + ["items must be a non-empty list or the string \"none\""]
    seen = set()
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            errors.append("items[{}] is not an object".format(i))
            continue
        iid = it.get("id")
        where = "item {}".format(iid if isinstance(iid, str) else "#{}".format(i))
        if not isinstance(iid, str) or not ITEM_ID_RE.match(iid):
            errors.append("{}: id must match {}".format(where, ITEM_ID_RE.pattern))
        elif iid in seen:
            errors.append("{}: duplicate id".format(where))
        else:
            seen.add(iid)
        for k in _unknown_keys(it, ITEM_KEYS):
            errors.append("{}: unknown key {}".format(where, k))
        for k in ("quote", "when"):
            if not _is_text(it.get(k)):
                errors.append("{}: {} must be a non-empty string".format(where, k))
        for k in ("actor", "given"):
            if k in it and not _is_text(it[k]):
                errors.append("{}: {} must be a non-empty string".format(where, k))
        if "derived" in it and not isinstance(it["derived"], bool):
            errors.append("{}: derived must be a boolean".format(where))
        if not _is_text(it.get("source")) or it["source"] not in sources:
            errors.append("{}: source must name a key of sources".format(where))
        then = it.get("then")
        if not isinstance(then, dict):
            errors.append("{}: then must be an object with surface and expect".format(where))
        else:
            for k in _unknown_keys(then, THEN_KEYS):
                errors.append("{}: then has unknown key {}".format(where, k))
            if not _is_text(then.get("surface")) or not SURFACE_RE.match(then["surface"]):
                errors.append("{}: then.surface must be web:<route> | api:<METHOD> <path> | native:<screen>".format(where))
            if not _is_text(then.get("expect")):
                errors.append("{}: then.expect must be a non-empty string".format(where))
        if it.get("platform") not in PLATFORMS:
            errors.append("{}: platform must be one of {}".format(where, "|".join(PLATFORMS)))
        neg = it.get("negative")
        if neg is not None:
            if not isinstance(neg, dict) or not _is_text(neg.get("expect")):
                errors.append("{}: negative must be an object with expect (and optionally given)".format(where))
            else:
                for k in _unknown_keys(neg, NEGATIVE_KEYS):
                    errors.append("{}: negative has unknown key {}".format(where, k))
                if "given" in neg and not _is_text(neg["given"]):
                    errors.append("{}: negative.given must be a non-empty string".format(where))
    return errors


# --- sources ----------------------------------------------------------------

def source_path(request, carrier):
    """The frozen file (relative to <run-dir>/intent/) a `sources` value names,
    or None when the value is not one of the three forms. `pr-body` resolves
    to the carrier the block was read from (`carrier`), so a freeze
    campaign's `pr1952/AC1` is searched in intent/pr-1952-body.md, never in
    another carried PR's prose."""
    if not isinstance(request, str):
        return None
    m = re.match(r"^issue#([0-9]+)$", request)
    if m:
        return "issue-{}.md".format(m.group(1))
    m = re.match(r"^slack:([A-Za-z0-9_.-]+)/([0-9.]+)$", request)
    if m:
        return "slack-{}-{}.md".format(m.group(1), m.group(2))
    if request == "pr-body":
        return carrier or "pr-body.md"
    return None


def carriers(run_dir):
    """[(carrier file, id prefix)]: the single-PR carrier plus every carried
    PR of a freeze campaign, in name order."""
    intent = os.path.join(run_dir, "intent")
    out = []
    if os.path.isfile(os.path.join(intent, "pr-body.md")):
        out.append(("pr-body.md", ""))
    for path in sorted(glob.glob(os.path.join(intent, "pr-*-body.md"))):
        name = os.path.basename(path)
        m = re.match(r"^pr-([0-9]+)-body\.md$", name)
        if m:
            out.append((name, "pr{}/".format(m.group(1))))
    return out


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError, UnicodeDecodeError):
        return None


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


# --- extract ----------------------------------------------------------------

def cmd_extract(args):
    run_dir = args.run_dir
    intent = os.path.join(run_dir, "intent")
    out_path = os.path.join(intent, "acceptance.json")
    if not os.path.isdir(intent):
        emit({"ok": False, "error": "{} has no intent/ directory; freeze the sources first (SKILL.md §1)".format(run_dir)}, 2)
    if os.path.exists(out_path) and not args.force:
        emit({"ok": False, "error": "intent/acceptance.json already exists; a run's contract is written once (pass --force to replace it)"}, 1)
    found = carriers(run_dir)
    if not found:
        emit({"ok": False, "error": "no intent/pr-body.md or intent/pr-<n>-body.md to extract from"}, 2)
    items, sources, blocks, problems = [], {}, [], []
    for carrier, prefix in found:
        body = _read_text(os.path.join(intent, carrier))
        if body is None:
            problems.append("{}: unreadable".format(carrier))
            continue
        block, why = parse_block(body)
        if block is None:
            blocks.append({"carrier": carrier, "status": "invalid" if why else "absent", "problems": why})
            problems.extend("{}: {}".format(carrier, w) for w in why)
            continue
        blocks.append({"carrier": carrier, "status": "none" if block["items"] == "none" else "present", "problems": []})
        for key, request in block["sources"].items():
            sources[prefix + key] = {"request": request, "frozen": source_path(request, carrier)}
        if block["items"] == "none":
            sources[prefix + "_none"] = {"request": None, "frozen": None, "reason": block["reason"]}
            continue
        for it in block["items"]:
            item = dict(it)
            item["id"] = prefix + it["id"]
            item["source"] = prefix + it["source"]
            item["carrier"] = carrier
            item.pop("derived", None)
            items.append(item)
    # ONE rule: any carrier without a valid block (invalid OR absent) means the
    # campaign has no authored contract, and the lane derives one for the
    # whole campaign. A freeze campaign is not half-authored.
    present = [b for b in blocks if b["status"] in ("present", "none")]
    origin = "pr-body" if present and len(present) == len(blocks) else "absent"
    doc = {"schemaVersion": SCHEMA_VERSION, "origin": origin, "blocks": blocks,
           "sources": sources if origin == "pr-body" else {},
           "items": items if origin == "pr-body" else [], "problems": problems}
    _write_atomic(out_path, (json.dumps(doc, indent=2) + "\n").encode("utf-8"))
    emit({"ok": True, "origin": origin, "itemCount": len(doc["items"]), "blocks": blocks,
          "problems": problems, "path": out_path}, 0)


# --- check ------------------------------------------------------------------

def _run_file_ok(run_dir, rel):
    """A cited evidence file must be a real, non-empty regular file inside the
    run: relative, no `..` (the barrier's citation grammar,
    smoke-evidence-barrier.sh:191-192), present (its :197-198 existence check,
    which it applies to `pass` markers only -- so every acceptance verdict
    gets it here), and non-empty (smoke-journeys.py _run_file_ok, :919-930)."""
    if not _is_text(rel) or "\n" in rel or "\r" in rel:
        return False
    if os.path.isabs(rel) or rel in (".", "..") or ".." in rel.split("/"):
        return False
    root = os.path.realpath(run_dir)
    candidate = os.path.join(run_dir, rel)
    real = os.path.realpath(candidate)
    return (real.startswith(root + os.sep) and not os.path.islink(candidate)
            and os.path.isfile(candidate) and os.path.getsize(candidate) > 0)


def provenance(run_dir, doc):
    """Per item: (status, reason) where status is supported | unsupported.
    The quote must occur, whitespace-normalised, in the ONE frozen file its
    named source resolves to -- with every acceptance-v1 fence stripped from a
    pr-body carrier first. A source with no frozen file is `unfrozen`: its
    items are unsupported, never silently trusted (§3)."""
    intent = os.path.join(run_dir, "intent")
    texts, out = {}, {}
    for it in doc.get("items", []):
        src = doc.get("sources", {}).get(it.get("source"))
        frozen = src.get("frozen") if isinstance(src, dict) else None
        if not frozen:
            out[it["id"]] = ("unsupported", "source {!r} does not resolve to a frozen file".format(it.get("source")))
            continue
        if frozen not in texts:
            body = _read_text(os.path.join(intent, frozen))
            texts[frozen] = None if body is None else normalise(strip_fences(body))
        if texts[frozen] is None:
            out[it["id"]] = ("unsupported", "source {} is unfrozen: intent/{} is missing".format(it["source"], frozen))
        elif normalise(it["quote"]) not in texts[frozen]:
            out[it["id"]] = ("unsupported", "quote not found in intent/{} (acceptance-v1 fences stripped)".format(frozen))
        else:
            out[it["id"]] = ("supported", None)
    return out


def doc_problems(doc):
    """Structural problems of intent/acceptance.json itself: the extract
    output, or the lane's derived file in the same shape."""
    if not isinstance(doc, dict) or doc.get("schemaVersion") != SCHEMA_VERSION:
        return ["intent/acceptance.json is not a schemaVersion {} document".format(SCHEMA_VERSION)]
    origin = doc.get("origin")
    if origin not in ("pr-body", "derived", "absent"):
        return ["origin must be pr-body | derived | absent"]
    items, sources = doc.get("items"), doc.get("sources")
    if not isinstance(items, list) or not isinstance(sources, dict):
        return ["items must be a list and sources an object"]
    if origin == "absent":
        return ["origin is absent: the PR body carried no valid block and nothing was derived -- derive the items from the frozen request sources (SKILL.md §3, Acceptance verifier)"]
    problems, seen = [], set()
    for i, it in enumerate(items):
        if not isinstance(it, dict) or not isinstance(it.get("id"), str) or not ITEM_ID_RE.match(it["id"]):
            problems.append("items[{}]: missing or malformed id".format(i))
            continue
        if it["id"] in seen:
            problems.append("item {}: duplicate id".format(it["id"]))
        seen.add(it["id"])
        if not _is_text(it.get("quote")):
            problems.append("item {}: quote must be a non-empty string".format(it["id"]))
        if not _is_text(it.get("source")) or it["source"] not in sources:
            problems.append("item {}: source must name a key of sources".format(it["id"]))
        if origin == "derived" and it.get("derived") is not True:
            problems.append("item {}: a derived contract marks every item derived: true".format(it["id"]))
        if origin == "pr-body" and it.get("derived"):
            problems.append("item {}: an authored contract cannot carry derived items".format(it["id"]))
    return problems


def load_rows(run_dir, lane):
    """(rows, files, problems). Rows come from evidence/<lane>/acceptance-
    results.json -- a list of rows, or {rows:[...]} -- for the named lane, or
    every lane that wrote one when none is named."""
    if lane:
        files = [os.path.join(run_dir, "evidence", lane, "acceptance-results.json")]
    else:
        files = sorted(glob.glob(os.path.join(run_dir, "evidence", "*", "acceptance-results.json")))
    rows, problems, rels = [], [], []
    for path in files:
        rel = os.path.relpath(path, run_dir)
        rels.append(rel)
        data = _read_json(path)
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            data = data["rows"]
        if not isinstance(data, list):
            problems.append("{}: missing or not a JSON list of rows".format(rel))
            continue
        rows.extend((rel, r) for r in data)
    return rows, rels, problems


def row_problems(run_dir, row):
    if not isinstance(row, dict):
        return ["row is not an object"]
    out = []
    for k in _unknown_keys(row, ROW_KEYS):
        out.append("unknown key {}".format(k))
    verdict = row.get("verdict")
    if verdict not in VERDICTS:
        out.append("verdict must be one of {}".format("|".join(VERDICTS)))
    observed = row.get("observed")
    excerpt = observed.get("excerpt") if isinstance(observed, dict) else None
    if observed is not None:
        if not isinstance(observed, dict) or observed.get("kind") not in OBSERVED_KINDS:
            out.append("observed.kind must be one of {}".format("|".join(OBSERVED_KINDS)))
        elif excerpt is not None and (not isinstance(excerpt, str) or len(excerpt) > EXCERPT_MAX):
            out.append("observed.excerpt must be a string of at most {} characters".format(EXCERPT_MAX))
    evidence = row.get("evidence")
    if evidence is None:
        evidence = []
    if not isinstance(evidence, list) or not all(isinstance(e, str) for e in evidence):
        out.append("evidence must be a list of run-relative paths")
        evidence = []
    missing = [e for e in evidence if not _run_file_ok(run_dir, e)]
    for e in missing:
        out.append("evidence is not an existing, non-empty file inside the run: {}".format(e))
    present = len(evidence) - len(missing)
    blocked_by = row.get("blockedBy")
    if blocked_by is not None and not _is_text(blocked_by):
        out.append("blockedBy must be null or a non-empty string")
    if verdict in ("met", "not_met"):
        if not _is_text(excerpt):
            out.append("{} needs a non-empty observed.excerpt".format(verdict))
        if present == 0:
            out.append("{} needs at least one existing evidence file".format(verdict))
    elif verdict == "not_demonstrable":
        # The lane's existing rule (SKILL.md "`not demonstrable` costs
        # something to say"): a blocker naming the missing thing AND an
        # artifact of the furthest state reached.
        if not _is_text(blocked_by):
            out.append("not_demonstrable needs blockedBy naming the missing thing")
        if present == 0:
            out.append("not_demonstrable needs an artifact of the furthest state reached")
    elif verdict == "blocked":
        if not _is_text(blocked_by):
            out.append("blocked needs blockedBy naming what stopped the lane")
    return out


def run_check(run_dir, lane):
    doc_path = os.path.join(run_dir, "intent", "acceptance.json")
    result = {"ok": False, "origin": "absent", "itemCount": 0, "provenance": {}, "unsupported": [],
              "missingRows": [], "unknownRows": [], "rowProblems": [], "resultFiles": [],
              "verdicts": {v: 0 for v in VERDICTS}, "problems": []}
    if not os.path.exists(doc_path):
        result["problems"].append("intent/acceptance.json is missing: run `extract` at freeze, then derive if it reports absent")
        result["sentence"] = sentence(result)
        return result
    doc = _read_json(doc_path)
    if doc is None:
        result["problems"].append("intent/acceptance.json is unreadable or not JSON")
        result["sentence"] = sentence(result)
        return result
    problems = doc_problems(doc)
    result["problems"].extend(problems)
    if isinstance(doc, dict) and doc.get("origin") in ("pr-body", "derived", "absent"):
        result["origin"] = doc["origin"]
    if problems:
        result["sentence"] = sentence(result)
        return result
    items = doc["items"]
    result["itemCount"] = len(items)
    prov = provenance(run_dir, doc)
    result["provenance"] = {k: v[0] for k, v in prov.items()}
    result["unsupported"] = [{"id": k, "reason": v[1]} for k, v in prov.items() if v[0] == "unsupported"]

    rows, files, file_problems = load_rows(run_dir, lane)
    result["resultFiles"] = files
    result["problems"].extend(file_problems)
    known = {it["id"] for it in items}
    seen = {}
    for rel, row in rows:
        iid = row.get("itemId") if isinstance(row, dict) else None
        if not isinstance(iid, str) or iid not in known:
            # Reported and ignored (§3): a row for nothing proves nothing and
            # blocks nothing.
            result["unknownRows"].append({"file": rel, "itemId": iid})
            continue
        if iid in seen:
            result["rowProblems"].append({"itemId": iid, "file": rel, "problems": ["duplicate row (first in {})".format(seen[iid])]})
            continue
        seen[iid] = rel
        probs = row_problems(run_dir, row)
        if probs:
            result["rowProblems"].append({"itemId": iid, "file": rel, "problems": probs})
        if row.get("verdict") in VERDICTS:
            result["verdicts"][row["verdict"]] += 1
    result["missingRows"] = [it["id"] for it in items if it["id"] not in seen]
    result["ok"] = not (result["problems"] or result["unsupported"] or result["missingRows"] or result["rowProblems"])
    result["sentence"] = sentence(result)
    return result


def sentence(result):
    """`Acceptance: present(n)|derived(n)|absent -- m unsupported, k missing
    rows` -- the report's one Untested-line sentence (SKILL.md §8)."""
    origin = result["origin"]
    if origin == "absent":
        head = "absent"
    else:
        head = "{}({})".format("present" if origin == "pr-body" else "derived", result["itemCount"])
    return "Acceptance: {} — {} unsupported, {} missing rows".format(
        head, len(result["unsupported"]), len(result["missingRows"]))


def cmd_check(args):
    result = run_check(args.run_dir, args.lane)
    emit(result, 0 if result["ok"] else 1)


def cmd_report(args):
    print(run_check(args.run_dir, args.lane)["sentence"])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("extract")
    e.add_argument("run_dir")
    e.add_argument("--force", action="store_true")
    e.set_defaults(fn=cmd_extract)
    for name, fn in (("check", cmd_check), ("report", cmd_report)):
        c = sub.add_parser(name)
        c.add_argument("run_dir")
        c.add_argument("--lane", default=None)
        c.set_defaults(fn=fn)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
