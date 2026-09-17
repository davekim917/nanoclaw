#!/usr/bin/env bash
# smoke-journeys.py: catalogue validation, matching, floor cadence, the pin,
# run-dir pinning + the barrier's completeness check (through the real
# smoke-evidence-barrier.sh), capture recipes, and publish. Hermetic: temp
# dirs only, no network. The gate-side wiring is covered by
# smoke-pr-gate.test.sh section 5k.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/smoke-journeys.py"
BARRIER="$SCRIPT_DIR/smoke-evidence-barrier.sh"
EXAMPLE="$SCRIPT_DIR/../references/journeys.example.json"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL $1" >&2; exit 1; }
expect() { # <label> <jq-assertion> <json>
  jq -e "$2" <<<"$3" >/dev/null || fail "$1: $3"
}
SHA="$(printf 'a%.0s' $(seq 40))"
NOW=2026-09-10T00:00:00Z

match() { # <paths-json> [extra args...]
  local paths="$1"; shift
  printf '%s' "$paths" | python3 "$TOOL" match --catalogue "$CATALOGUE" --as-of "$NOW" "$@"
}
# What smoke-pr-gate.sh journeys_pin_promote leaves in the shared lease dir for
# (repo org/repo, PR 7, <head>): the selection plus pin fields, and the exact
# catalogue bytes it was computed from, content-addressed. The gate's own
# promotion is tested in smoke-pr-gate.test.sh 5k; this only builds its output.
gate_pin() { # <lease-dir> <head-sha> <paths-json> -> prints the pin file path
  local dir="$1" head="$2" out digest pin
  mkdir -p "$dir"
  out="$(match "$3" --snapshot-out "$dir/.snap")"
  digest="$(jq -r '.catalogueSha256' <<<"$out")"
  mv "$dir/.snap" "$dir/journeys-catalogue-$digest.json"
  pin="$dir/journeys-pin-org__repo-pr-7-$head.json"
  jq -c --arg h "$head" --arg f "$pin" --arg s "$dir/journeys-catalogue-$digest.json" \
    '. + {headSha:$h,pinned:true,pinState:"valid",pinFile:$f,catalogueSnapshot:$s,pinnedAt:"2026-09-10T00:00:00Z"}' \
    <<<"$out" > "$pin"
  printf '%s' "$pin"
}

# --- 1. validate -------------------------------------------------------------
expect 1-example '.ok == true and .journeyCount == 3 and (.sha256 | length == 64)' \
  "$(python3 "$TOOL" validate "$EXAMPLE")"
bad_catalogue() { # <label> <jq-edit> <error-regex>
  jq "$2" "$EXAMPLE" > "$WORK/bad.json"
  local out
  out="$(python3 "$TOOL" validate "$WORK/bad.json")" && fail "$1: accepted"
  jq -e --arg re "$3" '.ok == false and any(.errors[]; test($re))' <<<"$out" >/dev/null || fail "$1: $out"
}
bad_catalogue 1-dup-id '.journeys[1].id = .journeys[0].id' 'duplicate id'
bad_catalogue 1-lane-alphabet '.journeys[0].id = "has space"' 'id must match'
# `platform: web|native` cannot say "API-only by design"; evidence can, and is closed.
bad_catalogue 1-evidence '.journeys[0].evidence = "web"' 'evidence must be one of'
bad_catalogue 1-no-proves 'del(.journeys[0].proves)' 'proves must be'
bad_catalogue 1-typo-key '.journeys[1].maxIntervalDay = 2' 'unknown key maxIntervalDay'
bad_catalogue 1-no-consumes '.journeys[0].consumes = []' 'consumes must be'
bad_catalogue 1-match-all '.journeys[0].consumes = ["**"]' 'matches every path'
# English never reaches the contact-sheet script: recipes are click/wait only.
bad_catalogue 1-english-recipe '.journeys[0].captureRecipes[0].steps = ["Open the period menu"]' 'click/wait commands only'
bad_catalogue 1-browser-checkpoints '.journeys[0].checkpoints = []' 'checkpoints'
jq '.journeys[1].consumes = []' "$EXAMPLE" > "$WORK/floor-no-consumes.json"
expect 1-floor-may-consume-nothing '.ok == true' "$(python3 "$TOOL" validate "$WORK/floor-no-consumes.json")"

# Warnings: a VALID catalogue can still drop scope silently, because the
# matcher applies excludePaths before consumes. The example is clean.
expect 1w-example-clean '.warnings == []' "$(python3 "$TOOL" validate "$EXAMPLE")"
warns() { # <label> <jq-edit> <warning-regex>
  jq "$2" "$EXAMPLE" > "$WORK/warn.json"
  expect "$1" '.ok == true and any(.warnings[]; test("'"$3"'"))' "$(python3 "$TOOL" validate "$WORK/warn.json")"
}
warns 1w-extension-wide '.excludePaths += [{"glob":"**/*.md","reason":"docs"}]' 'excludePaths .\\*\\*/\\*.md. is a bare top-level or extension-wide'
warns 1w-top-level '.excludePaths += [{"glob":".github/**","reason":"ci"}]' 'bare top-level'
warns 1w-no-reason '.excludePaths += ["docs/archive/**"]' 'docs/archive/\\*\\*. carries no reason'
# A consumes glob an exclusion shadows selects nothing, and says so...
warns 1w-shadowed-md '.excludePaths += [{"glob":"**/*.md","reason":"docs"}] | .journeys[0].consumes += ["web/release-notes/**/*.md"]' \
  'loan-desk-checkout: consumes .web/release-notes/\\*\\*/\\*.md. can never match'
warns 1w-shadowed-dir '.excludePaths += [{"glob":".github/**","reason":"ci"}] | .journeys[2].consumes += [".github/workflows/build-app.yml"]' \
  'mobile-scan-return: consumes ..github/workflows/build-app.yml. can never match'
# ...which is the matcher's real behaviour, not a lint opinion: the workflow
# that builds the installable app is excluded, never routed to its journey.
jq '.excludePaths += [{"glob":".github/**","reason":"ci"}] | .journeys[2].consumes += [".github/workflows/build-app.yml"]' "$EXAMPLE" > "$WORK/shadow.json"
expect 1w-exclusion-wins '.matchedJourneys == [] and .excludedPaths[0].glob == ".github/**"' \
  "$(printf '[".github/workflows/build-app.yml"]' | python3 "$TOOL" match --catalogue "$WORK/shadow.json" --as-of "$NOW")"
# A partly-overlapping glob is not "never matches".
jq '.excludePaths += [{"glob":"**/*.md","reason":"docs"}]' "$EXAMPLE" > "$WORK/warn.json"
expect 1w-partial-overlap-quiet '[.warnings[] | select(test("can never match"))] == []' "$(python3 "$TOOL" validate "$WORK/warn.json")"
bad_catalogue 1-exclude-key '.excludePaths += [{"glob":"a/b/**","why":"x"}]' 'unknown key why'

# --- 2. match ----------------------------------------------------------------
CATALOGUE="$WORK/journeys.json"; cp "$EXAMPLE" "$CATALOGUE"
# A backend-only change selects the unchanged UI consumer; ALL applicable
# journeys match, not the first; a deleted path is just a path.
OUT="$(match '["api/migrations/0042_loan_period_options.sql","api/src/auth/session.ts","api/src/reports/export.ts","tools/lint/rules.yml"]')"
expect 2-backend-only '.selection == "matched" and .route == "web" and .pinned == false and
  [.matchedJourneys[] | {id,reason}] == [{"id":"loan-desk-checkout","reason":"changed"},{"id":"branch-scope-crossing","reason":"changed"}] and
  .unmappedPaths == ["api/src/reports/export.ts"] and
  (.excludedPaths | map({path,glob})) == [{"path":"tools/lint/rules.yml","glob":"tools/lint/**"}] and
  (.excludedPaths[0].reason | test("lint"))' "$OUT"
expect 2-native-only '.route == "native-manual" and [.matchedJourneys[].id] == ["mobile-scan-return"]' \
  "$(match '["mobile/app/scan.tsx"]')"
expect 2-native-plus-unmapped '.route == "web"' "$(match '["mobile/app/scan.tsx","tools/x.sh"]')"
expect 2-native-plus-web '.route == "web"' "$(match '["mobile/app/scan.tsx","web/src/desk/a.tsx"]')"
# Excluded-only is an EMPTY scope, which is not "all native".
expect 2-empty-scope '.route == "web" and .matchedJourneys == [] and .unmappedPaths == []' \
  "$(match '["docs/internal/a.md"]')"
expect 2-unknown '.selection == "full" and .reason == "no GO" and .unmappedPaths == [] and
  [.matchedJourneys[] | select(.reason == "range-unknown") | .id] == ["loan-desk-checkout","branch-scope-crossing"] and
  .unassessedNativeJourneys == ["mobile-scan-return"]' "$(match '[]' --unknown "no GO")"
expect 2-unreadable-paths '.selection == "full" and (.reason | test("unreadable"))' "$(match 'not json')"
printf 'nope' > "$WORK/broken.json"
expect 2-broken-catalogue '.selection == "full" and .catalogueValid == false and (.catalogueSha256 | length == 64)' \
  "$(CATALOGUE="$WORK/broken.json" match '["web/src/desk/a.tsx"]')"

# --- 3. floor cadence ---------------------------------------------------------
# Same rule SKILL.md states: every overdue entry is due; else standard/full
# owes the least-recently-proven one and light owes none. A pass with neither
# media nor an api-declared contract lane never resets the clock.
ROOT="$WORK/runs"
floor_run() { # <run> <completedAt> <evidence-json> <lane-evidence or "">
  mkdir -p "$ROOT/$1/markers"
  jq -n --arg at "$2" --argjson ev "$3" '{status:"pass",completedAt:$at,evidence:$ev}' \
    > "$ROOT/$1/markers/branch-scope-crossing.json"
  jq -n --arg e "$4" '{lanes:[{id:"branch-scope-crossing",kind:"floor"} + (if $e == "" then {} else {evidence:$e} end)]}' \
    > "$ROOT/$1/completion-contract.json"
}
expect 3-no-root '.computed == false and .due == []' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$WORK/none" --as-of "$NOW")"
floor_run r1 2026-09-09T12:00:00Z '["notes.txt"]' ""
expect 3-unproven-pass-is-overdue '.computed == true and .due == ["branch-scope-crossing"] and .entries[0].lastProvenAt == null' \
  "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --as-of "$NOW")"
floor_run r2 2026-09-09T12:00:00Z '["notes.txt"]' api
expect 3-fresh-standard '.due == ["branch-scope-crossing"] and .entries[0].overdue == false' \
  "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --as-of "$NOW")"
expect 3-fresh-light '.due == []' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW")"
expect 3-overdue-light '.due == ["branch-scope-crossing"] and .entries[0].overdue == true' \
  "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of 2026-09-20T00:00:00Z)"
# In the matcher: the floor journey rides a change that never touched it...
expect 3-match-floor '[.matchedJourneys[] | {id,reason}] == [{"id":"loan-desk-checkout","reason":"changed"},{"id":"branch-scope-crossing","reason":"floor"}]' \
  "$(match '["web/src/desk/a.tsx"]' --run-root "$ROOT")"
# ...and a native-manual campaign owes the floor only what is overdue.
expect 3-native-fresh-floor '.route == "native-manual" and [.matchedJourneys[].id] == ["mobile-scan-return"]' \
  "$(match '["mobile/a.tsx"]' --run-root "$ROOT")"

# --- 4. the matcher never pins; it hands the gate the bytes it hashed ---------
# Pinning is the PR gate's (shared lease dir, immutable — smoke-pr-gate.test.sh
# 5k). The matcher's part: say pinned:false, and write the catalogue it read.
OUT="$(match '["api/src/reports/export.ts","web/src/desk/a.tsx"]' --snapshot-out "$WORK/snap.json")"
expect 4-unpinned '.pinned == false and .pinFile == null and .unmappedPaths == ["api/src/reports/export.ts"]' "$OUT"
cmp -s "$WORK/snap.json" "$EXAMPLE" || fail "4: snapshot is not the catalogue's bytes"
[ "$(sha256sum < "$WORK/snap.json" | cut -d' ' -f1)" = "$(jq -r '.catalogueSha256' <<<"$OUT")" ] || fail "4: snapshot does not hash to catalogueSha256"
PIN_FILE="$(gate_pin "$WORK/lease4" "$SHA" '["api/src/reports/export.ts","web/src/desk/a.tsx"]')"

# --- 5. pin-run + barrier -------------------------------------------------------
RUN="$WORK/run-1"
new_run() { # <lane-spec-json: [{id,kind,evidence?}]>
  rm -rf "$RUN"; mkdir -p "$RUN/markers"
  jq -n --arg sha "$SHA" --argjson lanes "$1" '{schemaVersion:1,runId:"run-1",sourceSha:$sha,
    coordinatorOwnerToken:null,ownershipKind:"develop",lanes:($lanes | map(. + {generation:1})),
    requiredLaneMarkers:($lanes | map("markers/" + .id + ".json"))}' > "$RUN/completion-contract.json"
}
marker() { # <lane> <status> <evidence-json>
  jq -n --arg sha "$SHA" --arg lane "$1" --arg st "$2" --argjson ev "$3" \
    '{sourceSha:$sha,lane:$lane,generation:1,status:$st,completedAt:"2026-09-10T01:00:00Z",evidence:$ev}' \
    > "$RUN/markers/$1.json"
}
barrier() { bash "$BARRIER" "$RUN" lanes || true; }

# No pinned selection: the barrier is exactly what it was.
new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
expect 5-no-selection '.ready == true' "$(barrier)"

# Pinned, but the matched journey was never given a lane, and the unmapped
# path has no disposition: not ready, both named.
expect 5-pin-run '.ok == true and .alreadyPinned == false' "$(python3 "$TOOL" pin-run "$RUN" "$PIN_FILE")"
cmp -s "$RUN/journeys/selection.json" "$PIN_FILE" || fail "5: run selection is not the gate pin's bytes"
cmp -s "$RUN/journeys/catalogue.json" "$EXAMPLE" || fail "5: run catalogue is not the pinned snapshot"
expect 5-pin-run-again '.alreadyPinned == true' "$(python3 "$TOOL" pin-run "$RUN" "$PIN_FILE")"
jq '.unmappedPaths = []' "$PIN_FILE" > "$WORK/doctored.json"
expect 5-pin-run-refuses-second-contract '.ok == false' "$(python3 "$TOOL" pin-run "$RUN" "$WORK/doctored.json" || true)"
expect 5-pin-run-refuses-unpinned '.ok == false' "$(python3 "$TOOL" pin-run "$WORK" <(echo '{"pinned":false}') || true)"
OUT="$(barrier)"
expect 5-missing-lane-and-disposition '.ready == false and (.missing | index("journeys/scope-dispositions.json")) and
  any(.invalidReasons[]; test("matched journey loan-desk-checkout \\(changed\\) has no lane"))' "$OUT"

# Lane declared but not terminal: the existing marker loop owns that.
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"report-export","kind":"lane"}]'
python3 "$TOOL" pin-run "$RUN" "$PIN_FILE" >/dev/null
disposition() { printf '%s' "$1" > "$RUN/journeys/scope-dispositions.json"; }
disposition '{"schemaVersion":1,"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"export consumers not traceable on this build"}]}'
expect 5-marker-still-required '.ready == false and (.missing | index("markers/loan-desk-checkout.json"))' "$(barrier)"
marker loan-desk-checkout blocked '[]'; marker report-export blocked '[]'
# `unresolved` lets uncertainty terminate honestly.
expect 5-unresolved-is-complete '.ready == true' "$(barrier)"

# Each disposition kind has a completeness bar.
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"none"}]}'
expect 5-bad-kind 'any(.invalidReasons[]; test("disposition must be one of"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["some/other/path"],"disposition":"unresolved","reason":"x"}]}'
expect 5-path-not-covered 'any(.invalidReasons[]; test("no valid scope disposition: api/src/reports/export.ts"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"no-user-facing-consumer","changedBehaviour":"CSV column order","evidence":["grep found nothing"]}]}'
expect 5-no-consumer-needs-a-file 'any(.invalidReasons[]; test("must cite evidence"))' "$(barrier)"
mkdir -p "$RUN/intake"; printf 'rg -n "reports/export" web mobile\n(no hits)\n' > "$RUN/intake/export-search.txt"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"no-user-facing-consumer","evidence":["intake/export-search.txt"]}]}'
expect 5-no-consumer-needs-behaviour 'any(.invalidReasons[]; test("changedBehaviour"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"no-user-facing-consumer","changedBehaviour":"CSV column order","evidence":["intake/export-search.txt"]}]}'
expect 5-no-consumer-complete '.ready == true' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"no-user-facing-consumer","changedBehaviour":"x","evidence":["../run-1/intake/export-search.txt"]}]}'
expect 5-evidence-escape 'any(.invalidReasons[]; test("must cite evidence"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"mapped-to-journey","journeyId":"branch-scope-crossing"}]}'
expect 5-mapped-needs-lane 'any(.invalidReasons[]; test("branch-scope-crossing has no lane"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"mapped-to-journey","journeyId":"report-export"}]}'
expect 5-mapped-must-exist 'any(.invalidReasons[]; test("not in the pinned catalogue"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"new-journey","journeyId":"report-export"}]}'
expect 5-new-journey-complete '.ready == true' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"new-journey","journeyId":"loan-desk-checkout"}]}'
expect 5-new-journey-not-existing 'any(.invalidReasons[]; test("already exists"))' "$(barrier)"
disposition 'not json'
expect 5-disposition-garbage '.ready == false and (.invalid | index("journeys/scope-dispositions.json"))' "$(barrier)"

# A catalogue edited inside the run after pinning is caught.
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
echo >> "$RUN/journeys/catalogue.json"
expect 5-run-catalogue-edited 'any(.invalidReasons[]; test("edited after it was pinned"))' "$(barrier)"

# The api exemption is the catalogue's to grant; native-manual passes only on
# the tester's recorded result, never on the packet.
NATIVE_PIN="$(gate_pin "$WORK/lease5" "$SHA" '["mobile/a.tsx","api/src/fines/list.ts"]')"
new_run '[{"id":"mobile-scan-return","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"}]'
python3 "$TOOL" pin-run "$RUN" "$NATIVE_PIN" >/dev/null
printf 'packet' > "$RUN/manual-packet.md"
marker branch-scope-crossing blocked '[]'; marker mobile-scan-return completed '["manual-packet.md"]'
expect 5-packet-issued-is-terminal '.ready == true' "$(barrier)"
marker mobile-scan-return pass '["manual-packet.md"]'
expect 5-packet-is-not-a-pass 'any(.invalidReasons[]; test("named tester"))' "$(barrier)"
mkdir -p "$RUN/manual-results"; printf 'passed on build 412 by the named tester' > "$RUN/manual-results/mobile-scan-return.md"
marker mobile-scan-return pass '["manual-results/mobile-scan-return.md"]'
expect 5-recorded-result-passes '.ready == true' "$(barrier)"
new_run '[{"id":"mobile-scan-return","kind":"floor","evidence":"api"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"}]'
python3 "$TOOL" pin-run "$RUN" "$NATIVE_PIN" >/dev/null
marker branch-scope-crossing blocked '[]'; marker mobile-scan-return blocked '[]'
expect 5-api-laundering 'any(.invalidReasons[]; test("scaffolded --evidence api but its journey declares evidence native-manual"))' "$(barrier)"

# --- 5b. enforcement follows the GATE's pin, not the run's bookkeeping ---------
# A pr-owned run whose campaign the gate pinned cannot escape by skipping
# pin-run, nor by adopting a narrowed or stale selection.
# The barrier finds the pin in the SHARED lease dir, by the contract's sourceSha.
GATE_LEASES="$WORK/shared/qa-coordinator/leases"
GATE_PIN="$(gate_pin "$GATE_LEASES" "$SHA" '["api/src/reports/export.ts","web/src/desk/a.tsx"]')"
pr_run() { # lanes as new_run, but claimed by a PR campaign on $SHA
  new_run "$1"
  jq '.ownershipKind = "pr" | .coordinatorOwnerToken = "owner-1"' "$RUN/completion-contract.json" > "$RUN/c.tmp"
  mv "$RUN/c.tmp" "$RUN/completion-contract.json"
}
gate_barrier() { SMOKE_GATE_LEASE_DIR="$GATE_LEASES" bash "$BARRIER" "$RUN" lanes || true; }
pr_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
NO_PIN_OUT="$(SMOKE_GATE_LEASE_DIR="$WORK/empty-leases" bash "$BARRIER" "$RUN" lanes)"
[ "$NO_PIN_OUT" = '{"ready":true,"phase":"lanes","sourceSha":"'"$SHA"'","missing":[],"invalid":[],"invalidReasons":[]}' ] ||
  fail "5b: no gate pin changed the barrier's output: $NO_PIN_OUT"
expect 5b-skipped-pin-run '.ready == false and (.invalid | index("journeys/selection.json")) and
  any(.invalidReasons[]; test("never adopted it") and test("pin-run"))' "$(gate_barrier)"
# A different head SHA's pin, or a develop-owned run, is not this campaign's.
gate_pin "$WORK/other-leases" "$(printf 'b%.0s' $(seq 40))" '["web/src/desk/a.tsx"]' >/dev/null
expect 5b-other-head '.ready == true' "$(SMOKE_GATE_LEASE_DIR="$WORK/other-leases" bash "$BARRIER" "$RUN" lanes)"
# The lease dir also resolves from the shared root alone, as the gate's does.
expect 5b-shared-root-default '.ready == false' "$(SMOKE_GATE_SHARED_ROOT="$WORK/shared" bash "$BARRIER" "$RUN" lanes || true)"
# Adopting a doctored copy (unmapped path dropped) is refused by bytes...
mkdir -p "$RUN/journeys"; jq -c '.unmappedPaths = []' "$GATE_PIN" > "$RUN/journeys/selection.json"
cp "$EXAMPLE" "$RUN/journeys/catalogue.json"
expect 5b-narrowed-copy '.ready == false and any(.invalidReasons[]; test("does not match the gate.s pin"))' "$(gate_barrier)"
# ...and so is a selection pinned from another catalogue version (sha mismatch).
jq -c '.catalogueSha256 = "0000"' "$GATE_PIN" > "$RUN/journeys/selection.json"
expect 5b-sha-mismatch 'any(.invalidReasons[]; test("catalogueSha256 run=0000 gate=[0-9a-f]{64}"))' "$(gate_barrier)"
# The real thing: pin-run, lanes, disposition => ready.
pr_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; marker loan-desk-checkout blocked '[]'
python3 "$TOOL" pin-run "$RUN" "$GATE_PIN" >/dev/null
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
expect 5b-adopted '.ready == true' "$(gate_barrier)"
# Only a VALID pin binds. What the gate reports as pinState:"invalid" (a
# symlink, a directory, truncated JSON) has no selection to adopt, so it cannot
# hold a run hostage — the campaign is already `full` by the gate's own word.
pr_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
for kind in truncated symlink directory; do
  rm -rf "$WORK/bad-leases"; mkdir -p "$WORK/bad-leases"
  bad="$WORK/bad-leases/journeys-pin-org__repo-pr-7-$SHA.json"
  case "$kind" in
    truncated) printf '{"pinned":tr' > "$bad" ;;
    symlink) ln -s "$GATE_PIN" "$bad" ;;
    directory) mkdir "$bad" ;;
  esac
  expect "5b-invalid-pin-$kind" '.ready == true' "$(SMOKE_GATE_LEASE_DIR="$WORK/bad-leases" bash "$BARRIER" "$RUN" lanes)"
done

# --- 6. capture recipes --------------------------------------------------------
new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'
python3 "$TOOL" pin-run "$RUN" "$PIN_FILE" >/dev/null
expect 6-shots '.ok == true and [.shots[].name] == ["desk","desk-periods"] and .shots[1].steps == ["click text=Loan period","wait 500"]' \
  "$(python3 "$TOOL" shots "$RUN")"

# --- 7. publish ------------------------------------------------------------------
LIVE="$WORK/live/journeys.json"; LOCK="$WORK/live/control.lock"; mkdir -p "$WORK/live"
publish() { python3 "$TOOL" publish "$LIVE" "$@" --lock "$LOCK" || true; }
expect 7-role '.ok == false and (.error | test("coordinator"))' "$(publish "$EXAMPLE" --expect-sha256 absent)"
export SMOKE_LANE_ROLE=coordinator
expect 7-first '.ok == true and .priorSha256 == "absent"' "$(publish "$EXAMPLE" --expect-sha256 absent)"
cmp -s "$LIVE" "$EXAMPLE" || fail "7: published bytes differ"
D1="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
jq '.journeys[0].consumes += ["api/src/reports/**"]' "$EXAMPLE" > "$WORK/p1.json"
# A proposal based on a stale digest loses; nothing is written.
expect 7-stale-digest '.ok == false and .actual == "'"$D1"'"' "$(publish "$WORK/p1.json" --expect-sha256 absent)"
cmp -s "$LIVE" "$EXAMPLE" || fail "7: a refused publish wrote the catalogue"
expect 7-correct '.ok == true and .priorSha256 == "'"$D1"'"' "$(publish "$WORK/p1.json" --expect-sha256 "$D1")"
D2="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
jq '.journeys[0].id = .journeys[1].id' "$WORK/p1.json" > "$WORK/p2.json"
expect 7-invalid '.ok == false and (.errors | length > 0)' "$(publish "$WORK/p2.json" --expect-sha256 "$D2")"
# Retiring or weakening a FLOOR journey is a human call; an ordinary journey is not.
jq 'del(.journeys[1])' "$WORK/p1.json" > "$WORK/p3.json"
expect 7-floor-needs-authority '.ok == false and (.error | test("floor"))' "$(publish "$WORK/p3.json" --expect-sha256 "$D2")"
jq '.journeys[1].maxIntervalDays = 30' "$WORK/p1.json" > "$WORK/p4.json"
expect 7-floor-weakened '.ok == false and (.error | test("floor"))' "$(publish "$WORK/p4.json" --expect-sha256 "$D2")"
jq 'del(.journeys[2])' "$WORK/p1.json" > "$WORK/p5.json"
expect 7-retire-ordinary '.ok == true and .journeyCount == 2' "$(publish "$WORK/p5.json" --expect-sha256 "$D2")"
D3="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
jq 'del(.journeys[1])' "$WORK/p5.json" > "$WORK/p6.json"
expect 7-floor-with-authority '.ok == true and .floorAuthority == "operator decision 2026-09-10"' \
  "$(publish "$WORK/p6.json" --expect-sha256 "$D3" --floor-authority "operator decision 2026-09-10")"
[ -z "$(find "$WORK/live" -name '.tmp-*')" ] || fail "7: temp files left behind"
# The shared lock is honoured: a holder blocks the publish until it lets go.
D4="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
( flock 9; sleep 2 ) 9>"$LOCK" &
sleep 0.5
START="$(date +%s%N)"
expect 7-locked-then-ok '.ok == true' "$(publish "$WORK/p5.json" --expect-sha256 "$D4" --floor-authority "restore")"
[ $(( ( $(date +%s%N) - START ) / 1000000 )) -ge 1000 ] || fail "7: publish did not wait for the shared lock"
wait

echo "smoke-journeys: all passed"
