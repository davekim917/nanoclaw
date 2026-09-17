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

# A run root where the one floor journey was proven yesterday, so a LIGHT
# campaign owes the floor nothing and the fixtures below stay about matching.
# (With no readable run root every floor journey is due — section 3.)
FRESH_ROOT="$WORK/fresh-runs"; mkdir -p "$FRESH_ROOT/r0/markers"
jq -n '{status:"pass",completedAt:"2026-09-09T12:00:00Z",evidence:["api.txt"]}' > "$FRESH_ROOT/r0/markers/branch-scope-crossing.json"
jq -n '{lanes:[{id:"branch-scope-crossing",kind:"floor",evidence:"api"}]}' > "$FRESH_ROOT/r0/completion-contract.json"
match() { # <paths-json> [extra args...] (later flags override these defaults)
  local paths="$1"; shift
  printf '%s' "$paths" | python3 "$TOOL" match --catalogue "$CATALOGUE" --as-of "$NOW" \
    --size light --run-root "$FRESH_ROOT" "$@"
}
# What smoke-pr-gate.sh journeys_pin_promote leaves in the shared lease dir for
# (repo org/repo, PR 7, <head>): the selection plus pin fields, and the exact
# catalogue bytes it was computed from, content-addressed. The gate's own
# promotion is tested in smoke-pr-gate.test.sh 5k; this only builds its output.
gate_pin() { # <lease-dir> <head-sha> <paths-json> [pr] [repo-slug] -> prints the pin file path
  local dir="$1" head="$2" pr="${4:-7}" slug="${5:-org__repo}" out digest pin
  mkdir -p "$dir"
  out="$(match "$3" --snapshot-out "$dir/.snap")"   # light + fresh floor: nothing owed but the change
  digest="$(jq -r '.catalogueSha256' <<<"$out")"
  mv "$dir/.snap" "$dir/journeys-catalogue-$digest.json"
  pin="$dir/journeys-pin-$slug-pr-$pr-$head.json"
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
bad_catalogue 1-empty 'del(.journeys[])' 'journeys must be a non-empty list'
bad_catalogue 1-no-proves 'del(.journeys[0].proves)' 'proves must be'
bad_catalogue 1-typo-key '.journeys[1].maxIntervalDay = 2' 'unknown key maxIntervalDay'
bad_catalogue 1-no-consumes '.journeys[0].consumes = []' 'consumes must be'
bad_catalogue 1-match-all '.journeys[0].consumes = ["**"]' 'matches every path'
# Judged per brace-EXPANDED alternative: `{**,api/**}` is `**` with a decoy,
# and would claim every changed path, emptying unmappedPaths.
bad_catalogue 1-brace-match-all '.journeys[0].consumes = ["{**,api/**}"]' 'consumes glob .* matches every path \(its alternative .\*\*. does\)'
bad_catalogue 1-brace-match-all-tail '.journeys[0].consumes = ["{api,*}/**"]' 'matches every path'
bad_catalogue 1-wildcard-spelling '.journeys[0].consumes = ["*?/**"]' 'matches every path'
bad_catalogue 1-exclude-everything '.excludePaths += [{"glob":"{docs/x/**,**}","reason":"r"}]' 'excludePaths glob .* matches every path'
jq '.journeys[0].consumes += ["{web,api}/src/**"]' "$EXAMPLE" > "$WORK/brace-ok.json"
expect 1-brace-ok '.ok == true' "$(python3 "$TOOL" validate "$WORK/brace-ok.json")"
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
warns 1w-brace-broad '.excludePaths += [{"glob":"{docs/x/**,.github/**}","reason":"r"}]' 'bare top-level'
warns 1w-brace-shadow '.excludePaths += [{"glob":"{docs/x/**,.github/**}","reason":"r"}] | .journeys[2].consumes += [".github/workflows/{build,ship}-app.yml"]' \
  'mobile-scan-return: consumes .* can never match'
warns 1w-no-reason '.excludePaths += ["docs/archive/**"]' 'docs/archive/\\*\\*. carries no reason'
# A consumes glob an exclusion shadows selects nothing, and says so...
warns 1w-shadowed-md '.excludePaths += [{"glob":"**/*.md","reason":"docs"}] | .journeys[0].consumes += ["web/release-notes/**/*.md"]' \
  'loan-desk-checkout: consumes .web/release-notes/\\*\\*/\\*.md. can never match'
warns 1w-shadowed-dir '.excludePaths += [{"glob":".github/**","reason":"ci"}] | .journeys[2].consumes += [".github/workflows/build-app.yml"]' \
  'mobile-scan-return: consumes ..github/workflows/build-app.yml. can never match'
# ...which is the matcher's real behaviour, not a lint opinion: the workflow
# that builds the installable app is excluded, never routed to its journey.
jq '.excludePaths += [{"glob":".github/**","reason":"ci"}] | .journeys[2].consumes += [".github/workflows/build-app.yml"]' "$EXAMPLE" > "$WORK/shadow.json"
expect 1w-exclusion-wins '[.matchedJourneys[] | select(.reason == "changed")] == [] and .excludedPaths[0].glob == ".github/**"' \
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
# An unusable catalogue still owes every journey it can NAME (floor included).
jq '.journeys[0].evidence = "web"' "$EXAMPLE" > "$WORK/half-broken.json"
expect 2-invalid-names-journeys '.selection == "full" and .catalogueValid == false and
  [.matchedJourneys[] | {id,reason}] == [{"id":"loan-desk-checkout","reason":"catalogue-invalid"},{"id":"branch-scope-crossing","reason":"catalogue-invalid"},{"id":"mobile-scan-return","reason":"catalogue-invalid"}] and
  .matchedJourneys[0].evidence == "browser" and .matchedJourneys[1].evidence == "api" and .floor.due == ["branch-scope-crossing"]' \
  "$(CATALOGUE="$WORK/half-broken.json" match '["web/src/desk/a.tsx"]')"
printf 'nope' > "$WORK/broken.json"
# A catalogue NOTHING can be read out of selects nothing, and that must never
# look like a selection somebody could pin: the matcher fails instead.
for broken in "$WORK/broken.json" "$WORK/no-such-catalogue.json"; do
  if OUT="$(CATALOGUE="$broken" match '["web/src/desk/a.tsx"]' 2>/dev/null)"; then fail "2-unparseable-catalogue: exit 0 with: $OUT"; fi
  [ -z "$OUT" ] || fail "2-unparseable-catalogue: printed a selection: $OUT"
done
printf '["not","an","object"]' > "$WORK/array.json"
if CATALOGUE="$WORK/array.json" match '[]' >/dev/null 2>&1; then fail "2-non-object-catalogue: exit 0"; fi

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
# UNKNOWN HISTORY IS NOT FRESH HISTORY. An unset or missing run root (a config
# or mount failure) makes every floor journey due — at every size — never none.
expect 3-missing-root '.computed == false and .due == ["branch-scope-crossing"] and (.reason | test("every floor journey is due"))' \
  "$(python3 "$TOOL" floor-due "$CATALOGUE" "$WORK/none" --size light --as-of "$NOW")"
expect 3-unset-root-match '[.matchedJourneys[] | {id,reason}] == [{"id":"loan-desk-checkout","reason":"changed"},{"id":"branch-scope-crossing","reason":"floor"}] and
  .floor.computed == false and (.floor.reason | test("SMOKE_GATE_RUN_ROOT unset"))' "$(match '["web/src/desk/a.tsx"]' --run-root "")"
expect 3-missing-root-native '.route == "native-manual" and [.matchedJourneys[].id] == ["branch-scope-crossing","mobile-scan-return"]' \
  "$(match '["mobile/a.tsx"]' --run-root "$WORK/none")"
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
  "$(match '["web/src/desk/a.tsx"]' --size standard --run-root "$ROOT")"
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
# ...and the other way: an api journey whose lane was NOT scaffolded api reads
# as a browser floor lane, where any media-looking file clears it and resets
# the cadence clock for a proof that was never an API contract check.
new_run '[{"id":"mobile-scan-return","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor"}]'
python3 "$TOOL" pin-run "$RUN" "$NATIVE_PIN" >/dev/null
printf 'png' > "$RUN/shot.png"
marker branch-scope-crossing pass '["shot.png"]'; marker mobile-scan-return blocked '[]'
expect 5-api-journey-needs-api-lane '.ready == false and any(.invalidReasons[]; test("journey branch-scope-crossing declares evidence api but its lane was not scaffolded"))' "$(barrier)"
# A disposition's journey is held to the same rule; a new-journey has no grant.
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"report-export","kind":"lane","evidence":"api"}]'
python3 "$TOOL" pin-run "$RUN" "$PIN_FILE" >/dev/null
marker loan-desk-checkout blocked '[]'; marker report-export blocked '[]'
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"new-journey","journeyId":"report-export"}]}'
expect 5-new-journey-no-api-grant 'any(.invalidReasons[]; test("lane report-export is scaffolded --evidence api"))' "$(barrier)"

# --- 5b. enforcement follows the GATE's pin, not the run's bookkeeping ---------
# A pr-owned run whose campaign the gate pinned cannot escape by skipping
# pin-run, nor by adopting a narrowed or stale selection.
# The barrier finds the pin in the SHARED lease dir, by the contract's sourceSha.
GATE_LEASES="$WORK/shared/qa-coordinator/leases"
GATE_PIN="$(gate_pin "$GATE_LEASES" "$SHA" '["api/src/reports/export.ts","web/src/desk/a.tsx"]')"
share_lease() { # <lease-dir> <pr>: the shared coordinator lease binding run-1 to its PR
  mkdir -p "$1"; jq -n --argjson pr "$2" '{schemaVersion:1,pr:$pr,runId:"run-1",owner:"owner-1"}' > "$1/lease-run-1.json"
}
pr_run() { # lanes as new_run, but claimed by a PR campaign (#7) on $SHA
  new_run "$1"
  share_lease "$GATE_LEASES" 7
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
share_lease "$WORK/other-leases" 7
expect 5b-other-head '.ready == true' "$(SMOKE_GATE_LEASE_DIR="$WORK/other-leases" bash "$BARRIER" "$RUN" lanes)"
# The lease dir also resolves from the shared root alone, as the gate's does.
expect 5b-shared-root-default '.ready == false' "$(SMOKE_GATE_SHARED_ROOT="$WORK/shared" bash "$BARRIER" "$RUN" lanes || true)"
# Adopting a doctored copy (unmapped path dropped) is refused by bytes...
mkdir -p "$RUN/journeys"; jq -c '.unmappedPaths = []' "$GATE_PIN" > "$RUN/journeys/selection.json"
cp "$EXAMPLE" "$RUN/journeys/catalogue.json"
expect 5b-narrowed-copy '.ready == false and any(.invalidReasons[]; test("does not match this campaign.s own gate pin"))' "$(gate_barrier)"
# ...and so is a selection pinned from another catalogue version (sha mismatch).
jq -c '.catalogueSha256 = "0000"' "$GATE_PIN" > "$RUN/journeys/selection.json"
expect 5b-sha-mismatch 'any(.invalidReasons[]; test("catalogueSha256=0000; gate catalogueSha256=[0-9a-f]{64}"))' "$(gate_barrier)"
# The real thing: pin-run, lanes, disposition => ready.
pr_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; marker loan-desk-checkout blocked '[]'
python3 "$TOOL" pin-run "$RUN" "$GATE_PIN" >/dev/null
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
expect 5b-adopted '.ready == true' "$(gate_barrier)"
# ONE OWNING PIN. Two more campaigns pinned the SAME head sha in the shared
# lease dir — another PR (#8) and the same PR number in another repo — each
# with a NARROWER scope (nothing unmapped). The run binds to repo+PR+head, its
# own: its own bytes stay ready, a sibling's bytes are refused by name.
PIN_PR8="$(gate_pin "$GATE_LEASES" "$SHA" '["web/src/desk/a.tsx"]' 8)"
expect 5b-sibling-pr-ignored '.ready == true' "$(gate_barrier)"
cp "$PIN_PR8" "$RUN/journeys/selection.json"
expect 5b-adopted-sibling-pr '.ready == false and any(.invalidReasons[];
  test("own gate pin .*journeys-pin-org__repo-pr-7-") and test("run adopted pinFile=.*-pr-8-"))' "$(gate_barrier)"
cp "$GATE_PIN" "$RUN/journeys/selection.json"
PIN_FORK="$(gate_pin "$GATE_LEASES" "$SHA" '["web/src/desk/a.tsx"]' 7 other__fork)"
# Two repos, same PR number and sha, and the barrier was not told which repo:
# ambiguous is refused, never guessed.
expect 5b-ambiguous-repo '.ready == false and any(.invalidReasons[]; test("2 repositories") and test("SMOKE_GATE_REPO"))' "$(gate_barrier)"
repo_barrier() { SMOKE_GATE_REPO="$1" SMOKE_GATE_LEASE_DIR="$GATE_LEASES" bash "$BARRIER" "$RUN" lanes || true; }
expect 5b-own-repo '.ready == true' "$(repo_barrier org/repo)"
cp "$PIN_FORK" "$RUN/journeys/selection.json"
expect 5b-adopted-other-repo '.ready == false and any(.invalidReasons[];
  test("own gate pin .*journeys-pin-org__repo-pr-7-") and test("run adopted pinFile=.*other__fork"))' "$(repo_barrier org/repo)"
expect 5b-fork-owns-its-own '.ready == true' "$(repo_barrier other/fork)"   # the same bytes ARE the fork campaign's own
# A repo with no pin of its own for this (PR, head) is the no-pin case.
cp "$GATE_PIN" "$RUN/journeys/selection.json"
expect 5b-third-repo-no-pin '.ready == true' "$(repo_barrier third/repo)"
# The PR comes from the SHARED lease, never the run: without it the owning pin
# cannot be identified, and that is a refusal, not "no pin".
rm -f "$GATE_LEASES/lease-run-1.json"
expect 5b-no-lease '.ready == false and any(.invalidReasons[]; test("PR cannot be read from the shared lease"))' "$(repo_barrier org/repo)"
jq -n '{schemaVersion:1,pr:7,runId:"run-1",owner:"owner-1",boundAt:"x"}' > "$GATE_LEASES/pr-7-authority.json"
expect 5b-authority-fallback '.ready == true' "$(repo_barrier org/repo)"
rm -f "$GATE_LEASES/pr-7-authority.json" "$PIN_PR8" "$PIN_FORK"

# Only a VALID pin binds. What the gate reports as pinState:"invalid" (a
# symlink, a directory, truncated JSON) has no selection to adopt, so it cannot
# hold a run hostage — the campaign is already `full` by the gate's own word.
pr_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
for kind in truncated symlink directory; do
  rm -rf "$WORK/bad-leases"; share_lease "$WORK/bad-leases" 7
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
# FIRST publish is the one that creates the floor: an absent catalogue has an
# empty floor, so declaring floor journeys needs the authority like any change.
expect 7-first-floor-needs-authority '.ok == false and (.error | test("floor"))' "$(publish "$EXAMPLE" --expect-sha256 absent)"
[ ! -e "$LIVE" ] || fail "7: a refused first publish wrote the catalogue"
jq 'del(.journeys[1])' "$EXAMPLE" > "$WORK/no-floor.json"
expect 7-first-no-floor '.ok == true and .priorSha256 == "absent" and .floorAuthority == null' "$(publish "$WORK/no-floor.json" --expect-sha256 absent)"
rm -f "$LIVE"
expect 7-first '.ok == true and .priorSha256 == "absent"' "$(publish "$EXAMPLE" --expect-sha256 absent --floor-authority "operator decision 2026-09-01")"
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
# The COMPLETE floor entry is protected, not just its claim: thinning the walk
# keeps "proves" intact while testing less. A `_` note is not content, and a
# non-floor journey is nobody's floor.
for edit in '.journeys[1].steps = ["Request the other branch once."]' '.journeys[1].endState = "a response comes back"' \
            '.journeys[1].seed = "whatever is there"' '.journeys[1].seats = ["qa-north"]' '.journeys[1].consumes = ["api/src/fines/list.ts"]'; do
  jq "$edit" "$WORK/p1.json" > "$WORK/pf.json"
  expect "7-floor-field: $edit" '.ok == false and (.error | test("floor"))' "$(publish "$WORK/pf.json" --expect-sha256 "$D2")"
done
jq '.journeys[1]._evidence = "walked 2026-09-09" | .journeys[0].steps += ["Check the receipt."] | .journeys[0].endState = "x"' "$WORK/p1.json" > "$WORK/pn.json"
expect 7-note-and-non-floor-free '.ok == true and .floorAuthority == null' "$(publish "$WORK/pn.json" --expect-sha256 "$D2")"
DN="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
jq '.journeys[1].steps = ["Request the other branch once."]' "$WORK/pn.json" > "$WORK/pf.json"
expect 7-floor-field-with-authority '.ok == true' "$(publish "$WORK/pf.json" --expect-sha256 "$DN" --floor-authority "operator decision 2026-09-11")"
DF="$(sha256sum < "$LIVE" | cut -d' ' -f1)"
expect 7-restore-p1 '.ok == true' "$(publish "$WORK/p1.json" --expect-sha256 "$DF" --floor-authority "restore")"
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
