#!/usr/bin/env python3
"""Mechanical campaign-size classifier for smoke-pr-gate.sh.

Reads a JSON array of repo-relative changed-file paths from stdin and an
install-supplied sizing-rules file path as argv[1]. Prints one JSON object
`{"campaignSize": "...", "sizeReason": "..."}` and exits 0.

Deliberately NOT fnmatch: fnmatch's `*` already matches `/`, so it cannot
express "`*` stays within one path segment, `**` crosses segments" — the
distinction the rules format depends on. Glob translation here is
purpose-built for that distinction plus `{a,b}` alternation.

This script never decides "full" for an undeterminable file list (fetch
failure, truncated listing) — that fail-closed call is made by the caller
(smoke-pr-gate.sh) BEFORE this script is invoked, using facts (fetchOk,
truncation) this script has no access to. This script only classifies a
complete, known file list against the rules.
"""
import ast
import json
import re
import sys


def expand_braces(pattern):
    """Expand one or more `{a,b,c}` alternation groups into concrete globs.

    Only handles non-nested groups (rules format does not need nesting) --
    finds the first `{...}`, splits its comma list, and recurses so multiple
    groups in one pattern (or the copies produced by an earlier group) all
    get expanded.
    """
    start = pattern.find("{")
    if start == -1:
        return [pattern]
    end = pattern.find("}", start)
    if end == -1:
        return [pattern]
    prefix = pattern[:start]
    suffix = pattern[end + 1:]
    options = pattern[start + 1:end].split(",")
    out = []
    for opt in options:
        out.extend(expand_braces(prefix + opt + suffix))
    return out


def _segment_to_regex(segment):
    """Translate one `/`-free glob segment (already brace-expanded, no `**`)
    into a regex fragment. `*` matches within the segment only, since the
    caller never hands this a `/`."""
    out = []
    for ch in segment:
        if ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
    return "".join(out)


def _glob_to_regex_no_braces(glob):
    """Translate a single brace-free glob (repo-relative, no leading `/`)
    into an anchored regex. `**` crosses directories; `*` does not."""
    segs = glob.split("/")
    n = len(segs)
    result = ""
    for i, seg in enumerate(segs):
        if seg == "**":
            if n == 1:
                # whole pattern is exactly '**' -- matches anything
                result += ".*"
            elif i == 0:
                # '**/rest' -- zero or more leading directories
                result += "(?:.*/)?"
            elif i == n - 1:
                # 'prefix/**' -- this directory and everything under it
                result += "/.*"
            else:
                # 'a/**/b' -- zero or more full directories between a and b
                result += "/(?:.*/)?"
            continue
        seg_regex = _segment_to_regex(seg)
        prev = segs[i - 1] if i > 0 else None
        if i == 0:
            result += seg_regex
        elif prev == "**":
            # the '**' piece already accounted for the separating slash
            result += seg_regex
        else:
            result += "/" + seg_regex
    return "^" + result + "$"


def compile_glob(glob):
    """Return a list of compiled regexes for one glob (>1 only when it
    contains `{a,b}` alternation)."""
    return [re.compile(_glob_to_regex_no_braces(g)) for g in expand_braces(glob)]


def compile_rule_list(globs):
    """[(original_glob_string, [compiled_regex, ...]), ...]"""
    return [(g, compile_glob(g)) for g in globs]


def match_first(path, compiled_rules):
    """Return the original glob string of the first rule matching `path`,
    or None."""
    for original, regexes in compiled_rules:
        for rx in regexes:
            if rx.match(path):
                return original
    return None


def _find_top_level_assignment(tree, name):
    """Return the AST value node of the LAST top-level `name = ...` (or
    `name: T = ...`) assignment in `tree.body`, matching normal module
    semantics where a later assignment shadows an earlier one, or None if
    `name` is never assigned at module top level. Deliberately does not
    descend into functions, classes, or conditionals -- a value assigned
    conditionally or built inside a function is not a fixed policy constant
    this format can trust."""
    found = None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target] if node.value is not None else []
        else:
            continue
        if any(isinstance(t, ast.Name) and t.id == name for t in targets):
            found = node.value
    return found


def load_full_globs_from(spec):
    """Load `fullGlobsFrom: {"path": <python file>, "name": <variable>}`.

    Returns (globs, None) on success or (None, reason) on any failure. The
    install's release policy already owns its sensitive-path list; this lets
    smoke read it directly instead of keeping a second, driftable copy.

    Deliberately reads the named constant with `ast` + `literal_eval` rather
    than importing the file as a module: running another team's program just
    to get one literal means any future non-stdlib import or import-time side
    effect in that file (a `yaml` import, an env read) would either silently
    turn every PR `full` or execute code this classifier never meant to run.
    A literal has no such surface -- `literal_eval` only ever produces plain
    data, never runs arbitrary statements.

    Every failure mode here is a caller instruction to fail closed to `full`
    — an unreadable file, a file that doesn't parse, a name never assigned at
    top level, a value that isn't a literal, and a value of the wrong type
    are all indistinguishable from "this rules file's full-glob policy could
    not be read," which must never silently fall through to a lighter
    campaign.
    """
    if not isinstance(spec, dict):
        return None, "fullGlobsFrom must be an object with path and name"
    path = spec.get("path")
    name = spec.get("name")
    if not isinstance(path, str) or not path:
        return None, "fullGlobsFrom.path is missing or not a string"
    if not isinstance(name, str) or not name:
        return None, "fullGlobsFrom.name is missing or not a string"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        return None, "fullGlobsFrom.path {} could not be read: {}".format(path, exc)
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError) as exc:
        return None, "fullGlobsFrom.path {} could not be parsed: {}".format(path, exc)
    value_node = _find_top_level_assignment(tree, name)
    if value_node is None:
        return None, "fullGlobsFrom.name {} not found at top level in {}".format(name, path)
    try:
        value = ast.literal_eval(value_node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError) as exc:
        return None, "fullGlobsFrom.name {} in {} is not a literal: {}".format(name, path, exc)
    if not isinstance(value, (list, tuple)) or not all(isinstance(v, str) for v in value):
        return None, "fullGlobsFrom.name {} in {} is not a list of strings".format(name, path)
    return list(value), None


def classify(files, rules):
    full_globs = list(rules.get("full", []) or [])
    full_globs_from = rules.get("fullGlobsFrom")
    if full_globs_from is not None:
        imported_globs, error = load_full_globs_from(full_globs_from)
        if error is not None or imported_globs is None:
            return "full", "full: {}".format(error)
        # Union with any local `full` globs, order preserved, no duplicates.
        for g in imported_globs:
            if g not in full_globs:
                full_globs.append(g)

    full_rules = compile_rule_list(full_globs)
    allowed_rules = compile_rule_list(rules.get("lightAllowed", []) or [])
    deny_rules = compile_rule_list(rules.get("lightDeny", []) or [])

    for f in files:
        m = match_first(f, full_rules)
        if m:
            return "full", "full: {} matched {}".format(f, m)

    if not files:
        return "standard", "standard: no changed files"

    for f in files:
        m = match_first(f, deny_rules)
        if m:
            return "standard", "standard: {} matched {}".format(f, m)

    for f in files:
        if match_first(f, allowed_rules) is None:
            return "standard", "standard: {} not matched by lightAllowed".format(f)

    return "light", "light: all {} changed file(s) matched lightAllowed".format(len(files))


def main():
    rules_path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        files = json.load(sys.stdin)
    except (ValueError, TypeError):
        files = []
    if not isinstance(files, list):
        files = []
    files = [f for f in files if isinstance(f, str)]

    if not rules_path:
        print(json.dumps({"campaignSize": "standard", "sizeReason": "no sizing rules"}))
        return

    try:
        with open(rules_path, "r", encoding="utf-8") as fh:
            rules = json.load(fh)
    except (OSError, ValueError):
        print(json.dumps({"campaignSize": "standard", "sizeReason": "no sizing rules"}))
        return

    if not isinstance(rules, dict):
        print(json.dumps({"campaignSize": "standard", "sizeReason": "no sizing rules"}))
        return

    size, reason = classify(files, rules)
    print(json.dumps({"campaignSize": size, "sizeReason": reason}))


if __name__ == "__main__":
    main()
