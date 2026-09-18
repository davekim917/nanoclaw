#!/usr/bin/env bash
# smoke-acceptance.py: block extraction (one fence, valid JSON, unique ids),
# provenance against the FROZEN request sources (fences stripped from the PR
# body, so a self-quoting block is unsupported), result-row completeness and
# evidence shape, the derived path, and the report sentence. Hermetic: temp
# dirs only, no network. The barrier and scaffold are never invoked -- nothing
# here reads them, and that is the point (SKILL.md "Acceptance verifier").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/smoke-acceptance.py"
EXAMPLE="$SCRIPT_DIR/../references/acceptance.example.json"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL $1" >&2; exit 1; }
expect() { # <label> <jq-assertion> <json>
  jq -e "$2" <<<"$3" >/dev/null || fail "$1: $3"
}
RUN="$WORK/run"

# Fictional frozen sources holding each example quote inside prose, line-
# wrapped differently from the block (provenance is whitespace-normalised).
Q1="$(jq -r '.items[0].quote' "$EXAMPLE")"
Q2="$(jq -r '.items[1].quote' "$EXAMPLE")"
Q3="$(jq -r '.items[2].quote' "$EXAMPLE")"
block_body() { # <block-json> [prose] -> a PR body carrying ONE fence
  printf '## Summary\n\nFines on the desk and the phone: %s.\n\n```acceptance-v1\n%s\n```\n\nSplit-reason: none\n' "${2:-$Q3}" "$1"
}
new_run() { # [block-json]: a run whose intent/ holds the three frozen sources and a PR body
  rm -rf "$RUN"; mkdir -p "$RUN/intent" "$RUN/evidence/A1"
  # AC1's words, wrapped mid-sentence with a tab: provenance is whitespace-normalised
  printf 'Issue 412\n\nWhen a loan is overdue, a borrower with an overdue loan sees\n   the fine on the borrower card\tbefore the librarian confirms a new loan (the card).\n' > "$RUN/intent/issue-412.md"
  printf '[thread lantern-desk/1726000000.000100]\nkim: %s -- north must never read south.\n' "$Q2" > "$RUN/intent/slack-lantern-desk-1726000000.000100.md"
  block_body "${1:-$(cat "$EXAMPLE")}" > "$RUN/intent/pr-body.md"
}
extract() { python3 "$TOOL" extract "$RUN" "$@" || true; }
check() { python3 "$TOOL" check "$RUN" "$@" || true; }
report() { python3 "$TOOL" report "$RUN"; }
shot() { printf 'png' > "$RUN/evidence/A1/$1"; }
rows() { printf '%s' "$1" > "$RUN/evidence/A1/acceptance-results.json"; }
MET='{"kind":"dom","excerpt":"fine line: $4.00"}'
row() { # <itemId> <verdict> <evidence-json> [blockedBy] [observed-json]
  jq -cn --arg id "$1" --arg v "$2" --argjson ev "$3" --arg b "${4:-}" --argjson ob "${5:-$MET}" \
    '{itemId:$id,verdict:$v,observed:$ob,evidence:$ev,blockedBy:(if $b == "" then null else $b end)}'
}

# --- 1. extract ----------------------------------------------------------------
new_run
OUT="$(extract)"
expect 1-example '.ok == true and .origin == "pr-body" and .itemCount == 3 and .problems == [] and .blocks == [{"carrier":"pr-body.md","status":"present","problems":[]}]' "$OUT"
DOC="$(cat "$RUN/intent/acceptance.json")"
expect 1-doc '.schemaVersion == 1 and .origin == "pr-body" and [.items[].id] == ["AC1","AC2","AC3"] and
  .sources.R1 == {"request":"issue#412","frozen":"issue-412.md"} and
  .sources.R2.frozen == "slack-lantern-desk-1726000000.000100.md" and .sources.R3.frozen == "pr-body.md" and
  (.items | all(.carrier == "pr-body.md" and (has("derived") | not)))' "$DOC"
# Write-once: a second extract is refused unless forced.
expect 1-write-once '.ok == false and (.error | test("written once"))' "$(extract)"
expect 1-force '.ok == true' "$(extract --force)"
# No intent/ dir, no carrier: distinct refusals, nothing written.
rm -rf "$WORK/bare"; mkdir -p "$WORK/bare"
expect 1-no-intent '.ok == false and (.error | test("no intent/"))' "$(python3 "$TOOL" extract "$WORK/bare" || true)"
mkdir -p "$WORK/bare/intent"
expect 1-no-carrier '.ok == false and (.error | test("pr-body.md"))' "$(python3 "$TOOL" extract "$WORK/bare" || true)"
[ ! -e "$WORK/bare/intent/acceptance.json" ] || fail "1-no-carrier: wrote a file"

# An INVALID block is `absent`, written as such with the reasons, and holds no
# items -- the lane derives (§3). One rule for every way a block can be wrong.
bad_block() { # <label> <jq-edit-or-raw-body-marker> <problem-regex> [raw]
  if [ "${4:-}" = raw ]; then new_run; printf '%s' "$2" > "$RUN/intent/pr-body.md"; else new_run "$(jq "$2" "$EXAMPLE")"; fi
  local out; out="$(extract)"
  jq -e --arg re "$3" '.ok == true and .origin == "absent" and .itemCount == 0 and any(.problems[]; test($re))' <<<"$out" >/dev/null || fail "$1: $out"
  jq -e '.origin == "absent" and .items == [] and .sources == {}' "$RUN/intent/acceptance.json" >/dev/null || fail "$1: file: $(cat "$RUN/intent/acceptance.json")"
}
bad_block 1-dup-id '.items[1].id = .items[0].id' 'duplicate id'
bad_block 1-bad-id '.items[0].id = "has space"' 'id must match'
bad_block 1-version '.v = 2' 'v must be 1'
bad_block 1-unknown-key '.items[0].screenshot = "x.png"' 'unknown key screenshot'
bad_block 1-unknown-top '.persist = true' 'unknown top-level key persist'
bad_block 1-no-quote 'del(.items[0].quote)' 'quote must be'
bad_block 1-no-when '.items[2].when = ""' 'when must be'
bad_block 1-source-unknown '.items[0].source = "R9"' 'source must name a key of sources'
bad_block 1-source-form '.sources.R1 = "issue 412"' 'is not issue#<n>, slack:'
bad_block 1-surface '.items[0].then.surface = "/desk"' 'then.surface must be'
bad_block 1-surface-api-method '.items[1].then.surface = "api:/api/fines"' 'then.surface must be'
bad_block 1-no-expect 'del(.items[1].then.expect)' 'then.expect must be'
bad_block 1-platform '.items[0].platform = "ios"' 'platform must be one of'
bad_block 1-negative-shape '.items[0].negative = "no fine"' 'negative must be an object'
bad_block 1-empty-items '.items = []' 'items must be a non-empty list'
bad_block 1-none-needs-reason '.items = "none"' 'needs a reason'
bad_block 1-reason-only-with-none '.reason = "x"' 'reason belongs only with items'
bad_block 1-not-json "$(block_body 'not json')" 'not valid JSON' raw
bad_block 1-two-fences "$(block_body "$(cat "$EXAMPLE")")$(block_body '{"v":1}')" '2 acceptance-v1 fences' raw
bad_block 1-unterminated "$(printf '## x\n\n```acceptance-v1\n{"v":1}\n')" 'not terminated' raw
# No fence at all is also absent, with no problem to report: nothing was authored.
new_run; printf '## Summary\n\nJust prose.\n' > "$RUN/intent/pr-body.md"
expect 1-no-fence '.ok == true and .origin == "absent" and .problems == [] and .blocks[0].status == "absent"' "$(extract)"
# `items: "none"` with a reason is a VALID, empty contract.
new_run "$(jq '.items = "none" | .reason = "dependency bump, no user-observable effect"' "$EXAMPLE")"
expect 1-none '.ok == true and .origin == "pr-body" and .itemCount == 0 and .blocks[0].status == "none"' "$(extract)"
expect 1-none-doc '.sources["_none"].reason == "dependency bump, no user-observable effect"' "$(cat "$RUN/intent/acceptance.json")"

# A freeze campaign carries one block per PR: ids are prefixed `pr<n>/` and a
# `pr-body` source resolves to THAT carrier, never another PR's prose.
new_run; rm "$RUN/intent/pr-body.md"
block_body "$(jq '.items |= [.[0]]' "$EXAMPLE")" > "$RUN/intent/pr-1952-body.md"
block_body "$(jq '.items |= [.[2]]' "$EXAMPLE")" > "$RUN/intent/pr-1953-body.md"
expect 1-freeze '.ok == true and .origin == "pr-body" and .itemCount == 2' "$(extract)"
expect 1-freeze-ids '[.items[] | {id, source, carrier}] == [{"id":"pr1952/AC1","source":"pr1952/R1","carrier":"pr-1952-body.md"},{"id":"pr1953/AC3","source":"pr1953/R3","carrier":"pr-1953-body.md"}] and
  .sources["pr1953/R3"].frozen == "pr-1953-body.md"' "$(cat "$RUN/intent/acceptance.json")"
# One carried PR without a valid block makes the whole campaign unauthored.
printf 'no block here\n' > "$RUN/intent/pr-1953-body.md"
expect 1-freeze-half-authored '.origin == "absent" and .itemCount == 0 and (.blocks | map(.status)) == ["present","absent"]' "$(extract --force)"

# --- 2. check: provenance -------------------------------------------------------
new_run; extract >/dev/null
shot ac1.png; shot ac2.txt; shot ac3.png
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 met '["evidence/A1/ac2.txt"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
OUT="$(check)"
expect 2-all-good '.ok == true and .origin == "pr-body" and .itemCount == 3 and .provenance == {"AC1":"supported","AC2":"supported","AC3":"supported"} and
  .unsupported == [] and .missingRows == [] and .rowProblems == [] and .verdicts.met == 3 and .resultFiles == ["evidence/A1/acceptance-results.json"]' "$OUT"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 0 missing rows" ] || fail "2-sentence: $(report)"
python3 "$TOOL" check "$RUN" >/dev/null || fail "2-exit-code: ok run exited non-zero"
python3 "$TOOL" check "$RUN" --lane A1 >/dev/null || fail "2-lane-flag"
# THE TAUTOLOGY: a pr-body quote that exists only inside the acceptance block.
# AC3's quote is in the prose because new_run put it there; a block quoting
# words the prose never said validates against nothing but itself.
new_run "$(jq '.items[2].quote = "the phone shows the fine in red"' "$EXAMPLE")"; extract >/dev/null
rows "[$(row AC1 met '[]'),$(row AC2 met '[]'),$(row AC3 met '[]')]"
expect 2-self-quoting '.ok == false and .provenance.AC3 == "unsupported" and
  (.unsupported | map(.id)) == ["AC3"] and (.unsupported[0].reason | test("fences stripped"))' "$(check)"
# ...even when the block is the ONLY thing in the body.
new_run; printf '```acceptance-v1\n%s\n```\n' "$(cat "$EXAMPLE")" > "$RUN/intent/pr-body.md"; extract >/dev/null
expect 2-block-only-body '.provenance.AC3 == "unsupported" and .provenance.AC1 == "supported"' "$(check)"
# A quote must match the named source, not any frozen file: AC1's words in the
# Slack thread do not support an item that names the issue.
new_run "$(jq '.items[0].source = "R2"' "$EXAMPLE")"; extract >/dev/null
expect 2-wrong-source '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("slack-lantern-desk"))' "$(check)"
# An unfrozen source (named, never fetched) is unsupported, naming the file.
new_run; rm "$RUN/intent/issue-412.md"; extract >/dev/null
expect 2-unfrozen '.provenance.AC1 == "unsupported" and (.unsupported[0].reason | test("unfrozen: intent/issue-412.md is missing"))' "$(check)"
# Whitespace is normalised (issue-412.md wraps AC1 mid-sentence and holds a
# tab); case and punctuation are not.
new_run "$(jq '.items[0].quote |= ascii_upcase' "$EXAMPLE")"; extract >/dev/null
expect 2-case-sensitive '.provenance.AC1 == "unsupported"' "$(check)"
new_run "$(jq '.items[1].quote = "the fines list should refuse another branch'"'"'s token with 403!"' "$EXAMPLE")"; extract >/dev/null
expect 2-punctuation '.provenance.AC2 == "unsupported"' "$(check)"

# --- 3. check: rows -------------------------------------------------------------
new_run; extract >/dev/null; shot ac1.png; shot ac3.png
# A missing row is a completeness failure; an unknown itemId is reported and
# ignored; a duplicate row is a problem.
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC9 met '["evidence/A1/ac1.png"]')]"
expect 3-missing-and-unknown '.ok == false and .missingRows == ["AC2","AC3"] and .unknownRows == [{"file":"evidence/A1/acceptance-results.json","itemId":"AC9"}] and .rowProblems == []' "$(check)"
[ "$(report)" = "Acceptance: present(3) — 0 unsupported, 2 missing rows" ] || fail "3-sentence: $(report)"
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 blocked '[]' 'seat lost'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
expect 3-duplicate-row 'any(.rowProblems[]; .itemId == "AC1" and any(.problems[]; test("duplicate row")))' "$(check)"
# No results file at all: every item is a missing row, and the file is named.
rm "$RUN/evidence/A1/acceptance-results.json"
expect 3-no-file '.missingRows == ["AC1","AC2","AC3"] and .resultFiles == []' "$(check)"
expect 3-no-file-named-lane '.missingRows == ["AC1","AC2","AC3"] and any(.problems[]; test("evidence/A1/acceptance-results.json: missing"))' "$(check --lane A1)"
# {rows:[...]} is accepted; garbage is a problem.
rows "{\"rows\":[$(row AC1 met '["evidence/A1/ac1.png"]')]}"
expect 3-rows-object '.missingRows == ["AC2","AC3"] and .rowProblems == []' "$(check)"
rows 'not json'
expect 3-garbage 'any(.problems[]; test("not a JSON list of rows"))' "$(check)"
# Rows from two lanes merge; the same item in both is a duplicate.
mkdir -p "$RUN/evidence/A2"; printf 'png' > "$RUN/evidence/A2/x.png"
rows "[$(row AC1 met '["evidence/A1/ac1.png"]')]"
printf '%s' "[$(row AC2 met '["evidence/A2/x.png"]'),$(row AC3 met '["evidence/A2/x.png"]')]" > "$RUN/evidence/A2/acceptance-results.json"
expect 3-two-lanes '.ok == true and .resultFiles == ["evidence/A1/acceptance-results.json","evidence/A2/acceptance-results.json"]' "$(check)"
printf '%s' "[$(row AC1 met '["evidence/A2/x.png"]'),$(row AC2 met '["evidence/A2/x.png"]'),$(row AC3 met '["evidence/A2/x.png"]')]" > "$RUN/evidence/A2/acceptance-results.json"
expect 3-two-lanes-duplicate 'any(.rowProblems[]; .itemId == "AC1" and .file == "evidence/A2/acceptance-results.json" and any(.problems[]; test("first in evidence/A1")))' "$(check)"
rm -rf "$RUN/evidence/A2"

# Verdict shape, one rule per verdict.
row_problem() { # <label> <row-json> <problem-regex>
  rows "[$2,$(row AC2 met '["evidence/A1/ac1.png"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
  local out; out="$(check)"
  jq -e --arg re "$3" '.ok == false and any(.rowProblems[]; .itemId == "AC1" and any(.problems[]; test($re)))' <<<"$out" >/dev/null || fail "$1: $out"
}
row_ok() { # <label> <row-json>
  rows "[$2,$(row AC2 met '["evidence/A1/ac1.png"]'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
  expect "$1" '.ok == true' "$(check)"
}
row_problem 3-bad-verdict "$(row AC1 passed '["evidence/A1/ac1.png"]')" 'verdict must be one of'
row_problem 3-met-no-evidence "$(row AC1 met '[]')" 'met needs at least one existing evidence file'
row_problem 3-met-missing-file "$(row AC1 met '["evidence/A1/never.png"]')" 'not an existing, non-empty file inside the run: evidence/A1/never.png'
: > "$RUN/evidence/A1/empty.png"
row_problem 3-met-empty-file "$(row AC1 met '["evidence/A1/empty.png"]')" 'non-empty file'
row_problem 3-met-absolute "$(row AC1 met "[\"$RUN/evidence/A1/ac1.png\"]")" 'inside the run'
row_problem 3-met-escape "$(row AC1 met '["../run/evidence/A1/ac1.png"]')" 'inside the run'
row_problem 3-not-met-no-excerpt "$(row AC1 not_met '["evidence/A1/ac1.png"]' '' '{"kind":"screenshot-only","excerpt":""}')" 'not_met needs a non-empty observed.excerpt'
row_problem 3-met-no-observed "$(row AC1 met '["evidence/A1/ac1.png"]' '' 'null')" 'met needs a non-empty observed.excerpt'
row_problem 3-observed-kind "$(row AC1 met '["evidence/A1/ac1.png"]' '' '{"kind":"vibes","excerpt":"x"}')" 'observed.kind must be one of'
LONG="$(printf 'x%.0s' $(seq 501))"
row_problem 3-excerpt-cap "$(row AC1 met '["evidence/A1/ac1.png"]' '' "{\"kind\":\"text\",\"excerpt\":\"$LONG\"}")" 'at most 500 characters'
row_problem 3-unknown-row-key "$(row AC1 met '["evidence/A1/ac1.png"]' | jq -c '.note = "x"')" 'unknown key note'
row_ok 3-not-met-ok "$(row AC1 not_met '["evidence/A1/ac1.png"]')"
# not_demonstrable keeps the lane's existing bar: a blocker AND an artifact of
# the furthest state; blocked needs the blocker only, never counts as coverage.
row_problem 3-nd-no-blocker "$(row AC1 not_demonstrable '["evidence/A1/ac1.png"]')" 'not_demonstrable needs blockedBy'
row_problem 3-nd-no-artifact "$(row AC1 not_demonstrable '[]' 'no overdue seed row on this build')" 'needs an artifact of the furthest state'
row_ok 3-nd-ok "$(row AC1 not_demonstrable '["evidence/A1/ac1.png"]' 'no overdue seed row on this build')"
row_problem 3-blocked-no-blocker "$(row AC1 blocked '[]')" 'blocked needs blockedBy'
row_problem 3-blocked-empty-blocker "$(row AC1 blocked '[]' ' ')" 'blockedBy must be null or a non-empty string'
row_ok 3-blocked-ok "$(row AC1 blocked '[]' 'coordinator seat lost before the lane started')"
rows "[$(row AC1 blocked '[]' 'seat lost'),$(row AC2 not_demonstrable '["evidence/A1/ac1.png"]' 'no south branch on this build'),$(row AC3 met '["evidence/A1/ac3.png"]')]"
expect 3-verdict-counts '.ok == true and .verdicts == {"met":1,"not_met":0,"not_demonstrable":1,"blocked":1}' "$(check)"

# --- 4. the derived path -----------------------------------------------------------
new_run; printf '## Summary\n\nJust prose.\n' > "$RUN/intent/pr-body.md"; extract >/dev/null
expect 4-absent-refused '.ok == false and .origin == "absent" and any(.problems[]; test("origin is absent") and test("derive"))' "$(check)"
[ "$(report)" = "Acceptance: absent — 0 unsupported, 0 missing rows" ] || fail "4-sentence-absent: $(report)"
# The lane derives from the frozen request sources into the same file.
derived() { # <jq-edit on the derived doc>
  jq "$1" <<<'{"schemaVersion":1,"origin":"derived","sources":{"R1":{"request":"issue#412","frozen":"issue-412.md"},"R2":{"request":"slack:lantern-desk/1726000000.000100","frozen":"slack-lantern-desk-1726000000.000100.md"}},
    "items":[{"id":"AC1","source":"R1","quote":"'"$Q1"'","when":"open the desk","then":{"surface":"web:/desk","expect":"fine shown"},"platform":"web","derived":true},
             {"id":"AC2","source":"R2","quote":"'"$Q2"'","when":"GET fines","then":{"surface":"api:GET /api/fines","expect":"403"},"platform":"api","derived":true}]}' > "$RUN/intent/acceptance.json"
}
derived '.'; shot ac1.png
rows "[$(row AC1 met '["evidence/A1/ac1.png"]'),$(row AC2 met '["evidence/A1/ac1.png"]')]"
expect 4-derived-ok '.ok == true and .origin == "derived" and .itemCount == 2' "$(check)"
[ "$(report)" = "Acceptance: derived(2) — 0 unsupported, 0 missing rows" ] || fail "4-sentence-derived: $(report)"
derived 'del(.items[1].derived)'
expect 4-derived-flag-required '.ok == false and any(.problems[]; test("item AC2: a derived contract marks every item derived: true"))' "$(check)"
derived '.origin = "pr-body"'
expect 4-authored-cannot-be-derived 'any(.problems[]; test("authored contract cannot carry derived items"))' "$(check)"
derived '.items[1].id = "AC1"'
expect 4-derived-dup-id 'any(.problems[]; test("duplicate id"))' "$(check)"
derived '.items[1].quote = "words the thread never said"'
expect 4-derived-provenance '.provenance.AC2 == "unsupported"' "$(check)"
# Doc-level garbage.
printf 'nope' > "$RUN/intent/acceptance.json"
expect 4-doc-garbage '.ok == false and any(.problems[]; test("unreadable or not JSON"))' "$(check)"
printf '{"schemaVersion":2}' > "$RUN/intent/acceptance.json"
expect 4-doc-version 'any(.problems[]; test("schemaVersion 1"))' "$(check)"
rm "$RUN/intent/acceptance.json"
expect 4-doc-missing '.ok == false and .origin == "absent" and any(.problems[]; test("run .extract. at freeze"))' "$(check)"
[ "$(report)" = "Acceptance: absent — 0 unsupported, 0 missing rows" ] || fail "4-sentence-missing: $(report)"

# --- 5. nothing outside intent/ is written; no bytecode is left -----------------------
new_run; extract >/dev/null; check >/dev/null; report >/dev/null
[ -z "$(find "$RUN" -name '.tmp-*' -o -name '__pycache__')" ] || fail "5-leftovers: $(find "$RUN" -name '.tmp-*' -o -name '__pycache__')"
[ ! -e "$SCRIPT_DIR/__pycache__" ] || fail "5-bytecode beside the scripts"

echo "smoke-acceptance.test.sh: all sections passed"
