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


def classify(files, rules):
    full_rules = compile_rule_list(rules.get("full", []) or [])
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
