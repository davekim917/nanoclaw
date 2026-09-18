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
import errno
import glob
import json
import os
import re
import stat
import sys
import tempfile

sys.dont_write_bytecode = True

SCHEMA_VERSION = 1
BLOCK_VERSION = 1
FENCE_LANG = "acceptance-v1"
# A top-level fence line, for EXTRACTION only: three or more backticks or
# tildes, up to three spaces of indent; the close line is the same character,
# at least as long, and nothing else. A trailing CR (GitHub's web editor saves
# CRLF) is not part of the line. Provenance does not rely on this parser
# recognising every Markdown form a fence can take -- see pr_body_text.
FENCE_LINE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t\r]*$")
# The scaffold's lane-id alphabet (smoke-journeys.py ID_RE, :54). An authored
# block uses it bare; `pr<n>/` is added by extract for a freeze campaign (one
# block per carried PR), so only the merged doc may carry it -- an authored
# `pr2/R1` would collide with carried PR 2's `R1` (#928 review 2, finding 1).
AUTHORED_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DOC_ID_RE = re.compile(r"^(pr[0-9]+/)?[A-Za-z0-9_-]+$")
SURFACE_RE = re.compile(r"^(web:\S.*|api:[A-Z]+ \S.*|native:\S.*)$")
PLATFORMS = ("web", "native", "api")
VERDICTS = ("met", "not_met", "not_demonstrable", "blocked")
OBSERVED_KINDS = ("text", "dom", "api", "screenshot-only")
EXCERPT_MAX = 500
ITEM_REQUIRED = ("id", "source", "quote", "when", "then", "platform")
ITEM_KEYS = set(ITEM_REQUIRED) | {"actor", "given", "negative"}
# The doc (intent/acceptance.json) carries two more per item: `carrier` (the
# PR body a pr-body quote is searched in) and `derived`.
DOC_ITEM_KEYS = ITEM_KEYS | {"carrier", "derived"}
THEN_KEYS = {"surface", "expect"}
NEGATIVE_KEYS = {"given", "expect"}
BLOCK_KEYS = {"v", "sources", "items", "reason"}
DOC_KEYS = {"schemaVersion", "origin", "blocks", "sources", "items", "none", "problems"}
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


# --- fences -----------------------------------------------------------------

def find_fences(body):
    """Every acceptance-v1 fenced block in the body, in order, as
    (start_line, end_line_or_None, content). A block runs from its open line
    to the first matching close line -- same character, at least as long
    (CommonMark 4.5) -- or, unterminated, to end of file. Lines inside a block
    are never opens of another."""
    lines = body.split("\n")
    out, i = [], 0
    while i < len(lines):
        m = FENCE_LINE_RE.match(lines[i])
        if not m or m.group(2) != FENCE_LANG:
            i += 1
            continue
        char, width = m.group(1)[0], len(m.group(1))
        j = i + 1
        while j < len(lines):
            c = FENCE_LINE_RE.match(lines[j])
            if c and c.group(1)[0] == char and len(c.group(1)) >= width and c.group(2) == "":
                break
            j += 1
        if j < len(lines):
            out.append((i, j, "\n".join(lines[i + 1:j])))
            i = j + 1
        else:
            out.append((i, None, "\n".join(lines[i + 1:])))
            break
    return out


def pr_body_text(body):
    """(text, reason): the text a `pr-body` quote is searched in -- the frozen
    body with the ONE extracted block's lines removed -- or (None, why) when
    the string acceptance-v1 still occurs anywhere in what is left. That
    fails closed on CONTENT, not syntax: a second block in a blockquote, a
    list item, a nested list, a tilde fence, an unterminated fence, or a plain
    mention all leave the string behind, so the body cannot support a quote
    and no Markdown form this script does not parse can hide one (#928 review
    2, finding 2). A quote that lives only inside the block never validates
    against itself."""
    lines = body.split("\n")
    fences = find_fences(body)
    if fences and fences[0][1] is not None:
        start, end = fences[0][0], fences[0][1]
        lines = lines[:start] + lines[end + 1:]
    rest = "\n".join(lines)
    if FENCE_LANG in rest.lower():
        return None, "the PR body mentions {} outside its one block".format(FENCE_LANG)
    return rest, None


# --- block ------------------------------------------------------------------

def parse_block(body):
    """(block_dict, problems). A body with no fence at all is (None, []);
    anything else wrong is (None, [why]) -- the lane then derives (§3)."""
    fences = find_fences(body)
    if not fences:
        return None, []
    if any(end is None for _, end, _ in fences):
        return None, ["an {} fence is not terminated".format(FENCE_LANG)]
    if len(fences) != 1:
        return None, ["{} {} fences; exactly one is allowed".format(len(fences), FENCE_LANG)]
    try:
        block = json.loads(fences[0][2])
    except ValueError as exc:
        return None, ["block is not valid JSON: {}".format(exc)]
    problems = validate_block(block)
    return (block if not problems else None), problems


def validate_item(it, where, sources, allowed):
    """ONE item rule, for the authored block and the derived doc alike (#928
    review 5: a derived item missing when/then/platform passed)."""
    errors = []
    for k in _unknown_keys(it, allowed):
        errors.append("{}: unknown key {}".format(where, k))
    for k in ("quote", "when"):
        if not _is_text(it.get(k)):
            errors.append("{}: {} must be a non-empty string".format(where, k))
    for k in ("actor", "given", "carrier"):
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


def validate_items(items, sources, allowed, id_re):
    errors, seen = [], set()
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            errors.append("items[{}] is not an object".format(i))
            continue
        iid = it.get("id")
        where = "item {}".format(iid if isinstance(iid, str) else "#{}".format(i))
        if not isinstance(iid, str) or not id_re.match(iid):
            errors.append("{}: id must match {}".format(where, id_re.pattern))
        elif iid in seen:
            errors.append("{}: duplicate id".format(where))
        else:
            seen.add(iid)
        errors.extend(validate_item(it, where, sources, allowed))
    return errors


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
        if not AUTHORED_ID_RE.match(k) or not _is_text(v):
            errors.append("sources.{}: key must match {} and name a request".format(k, AUTHORED_ID_RE.pattern))
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
    return errors + validate_items(items, sources, ITEM_KEYS, AUTHORED_ID_RE)


# --- sources ----------------------------------------------------------------

def source_path(request, carrier):
    """The frozen file (a bare name under <run-dir>/intent/) a `sources` value
    names, or None when the value is not one of the three forms. `pr-body`
    resolves to the item's carrier (carrier_of its id), so a freeze
    campaign's `pr1952/AC1` is searched in intent/pr-1952-body.md, never in
    another carried PR's prose. The name is DERIVED here, from the validated
    request, every time it is needed -- a stored name is only ever compared
    against it, never trusted (#928 review 1)."""
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


def carrier_of(item_id):
    """The PR body an item's `pr-body` source is searched in, DERIVED from its
    id: `pr1952/AC1` -> pr-1952-body.md, an unprefixed id -> pr-body.md. A
    stored `carrier` is only compared against this, never trusted -- it would
    otherwise alias `pr-body` onto any file in intent/ (#928 review 1)."""
    m = re.match(r"^pr([0-9]+)/", item_id) if isinstance(item_id, str) else None
    return "pr-{}-body.md".format(m.group(1)) if m else "pr-body.md"


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


def read_frozen(run_dir, name):
    """(text, reason) for one frozen source by its bare name: a regular file
    directly in <run-dir>/intent/, read with no symlink followed at either
    step. intent/ is opened ONCE with O_DIRECTORY|O_NOFOLLOW and the source is
    opened relative to that descriptor (openat), so swapping intent/ or the
    file for a link after any check cannot redirect the read -- the
    descriptor already names the verified directory (#928 review 2, finding
    3). O_NONBLOCK keeps a FIFO planted under the name from hanging the open;
    fstat then refuses anything but a regular file."""
    if not _is_text(name) or "/" in name or name in (".", "..") or "\0" in name:
        return None, "{!r} is not a bare file name".format(name)
    nofollow = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        dfd = os.open(os.path.join(run_dir, "intent"), nofollow | os.O_DIRECTORY)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            return None, "intent/ is reached through a symlink or is not a directory"
        return None, "intent/ could not be opened: {}".format(exc.strerror)
    try:
        fd = os.open(name, nofollow, dir_fd=dfd)
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return None, "intent/{} is missing".format(name)
        if exc.errno == errno.ELOOP:
            return None, "intent/{} is a symlink".format(name)
        return None, "intent/{} could not be read: {}".format(name, exc.strerror)
    finally:
        os.close(dfd)
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
            return None, "intent/{} is not a regular file".format(name)
        try:
            return fh.read().decode("utf-8"), None
        except UnicodeDecodeError:
            return None, "intent/{} is not UTF-8".format(name)


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
    items, sources, blocks, none, problems = [], {}, [], [], []
    for carrier, prefix in found:
        body, why = read_frozen(run_dir, carrier)
        if body is None:
            problems.append("{}: {}".format(carrier, why))
            blocks.append({"carrier": carrier, "status": "invalid", "problems": [why]})
            continue
        block, why = parse_block(body)
        if block is None:
            blocks.append({"carrier": carrier, "status": "invalid" if why else "absent", "problems": why})
            problems.extend("{}: {}".format(carrier, w) for w in why)
            continue
        # Authored keys are bare (AUTHORED_ID_RE), so prefix+key cannot
        # collide across carriers; refuse anyway rather than let one block's
        # source overwrite another's (#928 review 2, finding 1).
        clash = sorted(prefix + k for k in block["sources"] if prefix + k in sources)
        if clash:
            why = ["source key {} is already taken by another carried PR".format(k) for k in clash]
            blocks.append({"carrier": carrier, "status": "invalid", "problems": why})
            problems.extend("{}: {}".format(carrier, w) for w in why)
            continue
        blocks.append({"carrier": carrier, "status": "none" if block["items"] == "none" else "present", "problems": []})
        for key, request in block["sources"].items():
            sources[prefix + key] = {"request": request}
        if block["items"] == "none":
            none.append({"carrier": carrier, "reason": block["reason"]})
            continue
        for it in block["items"]:
            item = dict(it)
            item["id"] = prefix + it["id"]
            item["source"] = prefix + it["source"]
            item["carrier"] = carrier  # == carrier_of(item["id"]) by construction
            items.append(item)
    # ONE rule: any carrier without a valid block (invalid OR absent) means the
    # campaign has no authored contract, and the lane derives one for the
    # whole campaign. A freeze campaign is not half-authored.
    present = [b for b in blocks if b["status"] in ("present", "none")]
    origin = "pr-body" if present and len(present) == len(blocks) else "absent"
    doc = {"schemaVersion": SCHEMA_VERSION, "origin": origin, "blocks": blocks,
           "sources": sources if origin == "pr-body" else {},
           "items": items if origin == "pr-body" else [],
           "none": none if origin == "pr-body" else [], "problems": problems}
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
    named source resolves to -- derived from the source's `request` and the
    item's id (carrier_of) here, never read from the doc. A pr-body carrier is
    searched as pr_body_text leaves it (its one block removed, or unavailable).
    A source with no frozen file is `unfrozen`: its items are unsupported,
    never silently trusted (§3)."""
    texts, out = {}, {}
    for it in doc.get("items", []):
        src = doc.get("sources", {}).get(it.get("source"))
        request = src.get("request") if isinstance(src, dict) else None
        frozen = source_path(request, carrier_of(it["id"]))
        if frozen is None:
            out[it["id"]] = ("unsupported", "source {!r} names no valid request".format(it.get("source")))
            continue
        if request == "pr-body" and it.get("carrier", frozen) != frozen:
            out[it["id"]] = ("unsupported", "item {} stores carrier {!r} but its id resolves to intent/{}".format(it["id"], it["carrier"], frozen))
            continue
        stored = src.get("frozen")
        if stored is not None and stored != frozen:
            out[it["id"]] = ("unsupported", "source {} stores frozen {!r} but its request resolves to intent/{}".format(it["source"], stored, frozen))
            continue
        if frozen not in texts:
            body, why = read_frozen(run_dir, frozen)
            if body is None:
                why = "unfrozen: " + why
            elif request == "pr-body":
                body, why = pr_body_text(body)
                why = why and "unavailable: " + why
            texts[frozen] = (None, why) if body is None else (normalise(body), None)
        text, why = texts[frozen]
        if text is None:
            out[it["id"]] = ("unsupported", "source {} is {}".format(it["source"], why))
        elif normalise(it["quote"]) not in text:
            out[it["id"]] = ("unsupported", "quote not found in intent/{}{}".format(
                frozen, " (its acceptance-v1 block removed)" if request == "pr-body" else ""))
        else:
            out[it["id"]] = ("supported", None)
    return out


def doc_problems(doc):
    """Structural problems of intent/acceptance.json itself -- the extract
    output, or the lane's derived file in the same shape, held to the same
    item rule as the authored block."""
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
    problems = ["unknown top-level key {}".format(k) for k in _unknown_keys(doc, DOC_KEYS)]
    for k, v in sources.items():
        if (not DOC_ID_RE.match(k) or not isinstance(v, dict) or _unknown_keys(v, {"request", "frozen"})
                or source_path(v.get("request"), None) is None):
            problems.append("sources.{}: must be {{request: issue#<n> | slack:<channel>/<thread> | pr-body}}".format(k))
    problems.extend(validate_items(items, sources, DOC_ITEM_KEYS, DOC_ID_RE))
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            continue
        if origin == "derived" and it.get("derived") is not True:
            problems.append("item {}: a derived contract marks every item derived: true".format(it["id"]))
        if origin == "pr-body" and it.get("derived"):
            problems.append("item {}: an authored contract cannot carry derived items".format(it["id"]))
    # An empty contract is a claim ("no user-observable effect") and must say
    # so: `none: [{reason}]`, the doc form of the block's items "none".
    none = doc.get("none", [])
    if not isinstance(none, list) or not all(isinstance(n, dict) and _is_text(n.get("reason")) for n in none):
        problems.append("none must be a list of {reason} entries")
    elif not items and not none:
        problems.append("an empty contract needs none: [{reason: ...}] saying why there is no user-observable effect")
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
