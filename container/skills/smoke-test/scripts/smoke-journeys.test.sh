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
# The barrier decides an incomplete campaign identity by whether THIS install
# keeps a catalogue (section 5b); the host running this suite must not.
export SMOKE_JOURNEYS_CATALOGUE="$WORK/absent-catalogue.json"
unset SMOKE_GATE_REPO

# A run root where the one floor journey was proven yesterday, so a LIGHT
# campaign owes the floor nothing and the fixtures below stay about matching.
# (With no readable run root every floor journey is due — section 3.)
FRESH_ROOT="$WORK/fresh-runs"; mkdir -p "$FRESH_ROOT/r0/markers"
jq -n --arg sha "$SHA" '{sourceSha:$sha,status:"pass",completedAt:"2026-09-09T12:00:00Z",evidence:["api.txt"]}' > "$FRESH_ROOT/r0/markers/branch-scope-crossing.json"
jq -n --arg sha "$SHA" '{sourceSha:$sha,requiredLaneMarkers:["markers/branch-scope-crossing.json"],lanes:[{id:"branch-scope-crossing",kind:"floor",evidence:"api",generation:1}]}' > "$FRESH_ROOT/r0/completion-contract.json"
match() { # <paths-json> [extra args...] (later flags override these defaults)
  local paths="$1"; shift
  printf '%s' "$paths" | python3 "$TOOL" match --catalogue "$CATALOGUE" --as-of "$NOW" \
    --size light --run-root "$FRESH_ROOT" "$@"
}
# What smoke-pr-gate.sh journeys_pin_promote leaves in the shared lease dir for
# (repo org/repo, PR 7, <head>): the selection plus pin fields, and the exact
# catalogue bytes it was computed from, content-addressed. The gate's own
# promotion is tested in smoke-pr-gate.test.sh 5k; this only builds its output.
gate_pin() { # <lease-dir> <head-sha> <paths-json> [pr] [repo-slug] [recovery|""] [extra match args] -> pin path
  local dir="$1" head="$2" pr="${4:-7}" slug="${5:-org__repo}" kind="${6:-}" out digest pin state=valid
  local -a extra=(); [ -z "${7:-}" ] || read -r -a extra <<<"$7"
  mkdir -p "$dir"
  [ "$kind" != recovery ] || { extra+=(--recover); state=recovered; }
  out="$(match "$3" --snapshot-out "$dir/.snap" ${extra[@]+"${extra[@]}"})"   # default: light + fresh floor
  digest="$(jq -r '.catalogueSha256' <<<"$out")"
  mv "$dir/.snap" "$dir/journeys-catalogue-$digest.json"
  pin="$dir/journeys-pin-$slug-pr-$pr-$head${kind:+-recovery}.json"
  jq -c --arg h "$head" --argjson pr "$pr" --arg slug "$slug" --arg f "$pin" --arg st "$state" \
    --arg s "$dir/journeys-catalogue-$digest.json" \
    '. + {headSha:$h,pr:$pr,repoSlug:$slug,pinned:true,pinState:$st,pinFile:$f,catalogueSnapshot:$s,pinnedAt:"2026-09-10T00:00:00Z"}' \
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
# ONE rule for every unusable catalogue. One that parses but fails validation
# (here: one empty title) is refused exactly like one that does not parse — a
# partial reading could name journeys while dropping every unclaimed path.
jq '.journeys[0].title = ""' "$EXAMPLE" > "$WORK/half-broken.json"
if OUT="$(CATALOGUE="$WORK/half-broken.json" match '["api/src/reports/export.ts"]' 2>"$WORK/half.err")"; then
  fail "2-invalid-catalogue-refused: exit 0 with: $OUT"
fi
[ -z "$OUT" ] || fail "2-invalid-catalogue-refused: printed a selection: $OUT"
expect 2-invalid-catalogue-says-why '.ok == false and (.error | test("unusable: journey loan-desk-checkout: title must be"))' "$(cat "$WORK/half.err")"
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
floor_run() { # <run> <completedAt> <evidence-json> <lane-evidence or ""> [journey-id] [marker-sha]
  mkdir -p "$ROOT/$1/markers"
  local id="${5:-branch-scope-crossing}" marker_sha="${6:-$SHA}"
  jq -n --arg at "$2" --argjson ev "$3" --arg sha "$marker_sha" '{sourceSha:$sha,status:"pass",completedAt:$at,evidence:$ev}' \
    > "$ROOT/$1/markers/$id.json"
  jq -n --arg e "$4" --arg id "$id" --arg sha "$SHA" '{sourceSha:$sha,requiredLaneMarkers:["markers/" + $id + ".json"],lanes:[{id:$id,kind:"floor",generation:1} + (if $e == "" then {} else {evidence:$e} end)]}' \
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
# CADENCE USES THE BARRIER'S RULE (lane_problems), for the journey's DECLARED
# evidence. A BROWSER floor journey mis-scaffolded as api, "passing" on a text
# file, is a pass the barrier refuses — so it must not reset the clock either.
# Nor does a marker that is not its own contract's (another build's sourceSha).
jq '.journeys[0].maxIntervalDays = 3' "$EXAMPLE" > "$WORK/browser-floor.json"
due_browser() { python3 "$TOOL" floor-due "$WORK/browser-floor.json" "$ROOT" --size light --as-of "$NOW" | jq -c '[.entries[] | select(.id == "loan-desk-checkout")][0]'; }
floor_run r3 2026-09-09T18:00:00Z '["notes.txt"]' api loan-desk-checkout
expect 3-mislabelled-api-pass-no-reset '.overdue == true and .lastProvenAt == null' "$(due_browser)"
floor_run r4 2026-09-09T18:00:00Z '["desk.png"]' "" loan-desk-checkout "$(printf 'c%.0s' $(seq 40))"
expect 3-foreign-marker-no-reset '.overdue == true and .lastProvenAt == null' "$(due_browser)"
floor_run r5 2026-09-09T18:00:00Z '["desk.png"]' "" loan-desk-checkout
expect 3-real-browser-pass-resets '.overdue == false and .lastProvenAt == "2026-09-09T18:00:00Z"' "$(due_browser)"
rm -rf "$ROOT/r3" "$ROOT/r4" "$ROOT/r5"
# ...and the barrier's COMPLETE pass bar: a pass citing nothing, or a marker
# whose sourceSha is missing on both sides (null == null), proves nothing.
floor_run r6 2026-09-09T18:00:00Z '[]' api
expect 3-empty-evidence-no-reset '.entries[0].lastProvenAt == "2026-09-09T12:00:00Z"' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW" | jq -c '{entries:[.entries[] | select(.id == "branch-scope-crossing")]}')"
rm -rf "$ROOT/r6"
floor_run r7 2026-09-09T18:00:00Z '["api.txt"]' api
jq 'del(.sourceSha)' "$ROOT/r7/markers/branch-scope-crossing.json" > "$ROOT/r7/m.tmp"; mv "$ROOT/r7/m.tmp" "$ROOT/r7/markers/branch-scope-crossing.json"
jq 'del(.sourceSha)' "$ROOT/r7/completion-contract.json" > "$ROOT/r7/c.tmp"; mv "$ROOT/r7/c.tmp" "$ROOT/r7/completion-contract.json"
expect 3-null-sha-no-reset '.entries[0].lastProvenAt == "2026-09-09T12:00:00Z"' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW" | jq -c '{entries:[.entries[] | select(.id == "branch-scope-crossing")]}')"
rm -rf "$ROOT/r7"
# A pair RE-FREEZE retires evidence gathered before it: the barrier refuses a
# generation-1 pass after `refreeze` snapshotted generation 1 until the lane is
# redispatched (refreeze-lanes.jq rl_stale_after_refreeze), and cadence reads
# that same definition — the stale pass resets nothing; the gen-2 pass does.
floor_run r8 2026-09-09T18:00:00Z '["api.txt"]' api
mkdir -p "$ROOT/r8/coordinator"
jq -n --arg sha "$SHA" '{history:[{at:"2026-09-09T17:00:00Z"}],freezeGeneration:2,
  refreezeLaneSnapshot:{contractPresent:true,sourceSha:$sha,lanes:[{id:"branch-scope-crossing",generation:1}]}}' > "$ROOT/r8/coordinator/identity.json"
expect 3-refreeze-stale-no-reset '.entries[0].lastProvenAt == "2026-09-09T12:00:00Z"' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW" | jq -c '{entries:[.entries[] | select(.id == "branch-scope-crossing")]}')"
jq '.lanes[0].generation = 2' "$ROOT/r8/completion-contract.json" > "$ROOT/r8/c.tmp"; mv "$ROOT/r8/c.tmp" "$ROOT/r8/completion-contract.json"
jq '.generation = 2' "$ROOT/r8/markers/branch-scope-crossing.json" > "$ROOT/r8/m.tmp"; mv "$ROOT/r8/m.tmp" "$ROOT/r8/markers/branch-scope-crossing.json"
expect 3-redispatched-pass-resets '.entries[0].lastProvenAt == "2026-09-09T18:00:00Z"' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW" | jq -c '{entries:[.entries[] | select(.id == "branch-scope-crossing")]}')"
printf 'not json' > "$ROOT/r8/coordinator/identity.json"   # unreadable identity: doubt never resets
expect 3-unreadable-identity-no-reset '.entries[0].lastProvenAt == "2026-09-09T12:00:00Z"' "$(python3 "$TOOL" floor-due "$CATALOGUE" "$ROOT" --size light --as-of "$NOW" | jq -c '{entries:[.entries[] | select(.id == "branch-scope-crossing")]}')"
rm -rf "$ROOT/r8"
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
LEASES="$WORK/empty-leases"   # the shared lease dir the barrier looks in; `adopt` points it at a pin's
mkdir -p "$LEASES"            # readable and empty: "no pin", which a MISSING dir is not (5b-lease-dir-*)
share_lease() { # <lease-dir> <pr> [repo-slug]: the shared coordinator lease binding run-1 to its PR and repo,
  # as smoke-pr-gate.sh lease_acquire writes it (repoSlug slugged like journeys_pin_file)
  mkdir -p "$1"; jq -n --argjson pr "$2" --arg slug "${3:-org__repo}" \
    '{schemaVersion:1,pr:$pr,runId:"run-1",owner:"owner-1",repoSlug:$slug}' > "$1/lease-run-1.json"
}
new_run() { # <lane-spec-json: [{id,kind,evidence?}]> — a PR campaign (#7) claimed on $SHA
  rm -rf "$RUN"; mkdir -p "$RUN/markers"
  jq -n --arg sha "$SHA" --argjson lanes "$1" '{schemaVersion:1,runId:"run-1",sourceSha:$sha,
    coordinatorOwnerToken:"owner-1",ownershipKind:"pr",lanes:($lanes | map(. + {generation:1})),
    requiredLaneMarkers:($lanes | map("markers/" + .id + ".json"))}' > "$RUN/completion-contract.json"
}
adopt() { # <gate pin>: the campaign's lease dir is wherever its pin is; pin-run it into the run
  LEASES="$(dirname "$1")"; share_lease "$LEASES" 7
  python3 "$TOOL" pin-run "$RUN" "$1"
}
marker() { # <lane> <status> <evidence-json>
  jq -n --arg sha "$SHA" --arg lane "$1" --arg st "$2" --argjson ev "$3" \
    '{sourceSha:$sha,lane:$lane,generation:1,status:$st,completedAt:"2026-09-10T01:00:00Z",evidence:$ev}' \
    > "$RUN/markers/$1.json"
}
barrier() { SMOKE_GATE_LEASE_DIR="$LEASES" bash "$BARRIER" "$RUN" lanes || true; }

# No pinned selection: the barrier is exactly what it was.
new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
expect 5-no-selection '.ready == true' "$(barrier)"

# Pinned, but the matched journey was never given a lane, and the unmapped
# path has no disposition: not ready, both named.
LEASES="$(dirname "$PIN_FILE")"; share_lease "$LEASES" 7
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
adopt "$PIN_FILE" >/dev/null
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
adopt "$NATIVE_PIN" >/dev/null
printf 'packet' > "$RUN/manual-packet.md"
marker branch-scope-crossing blocked '[]'; marker mobile-scan-return completed '["manual-packet.md"]'
expect 5-packet-issued-is-terminal '.ready == true' "$(barrier)"
marker mobile-scan-return pass '["manual-packet.md"]'
expect 5-packet-is-not-a-pass 'any(.invalidReasons[]; test("named tester"))' "$(barrier)"
mkdir -p "$RUN/manual-results"; printf 'passed on build 412 by the named tester' > "$RUN/manual-results/mobile-scan-return.md"
marker mobile-scan-return pass '["manual-results/mobile-scan-return.md"]'
expect 5-recorded-result-passes '.ready == true' "$(barrier)"
new_run '[{"id":"mobile-scan-return","kind":"floor","evidence":"api"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"}]'
adopt "$NATIVE_PIN" >/dev/null
marker branch-scope-crossing blocked '[]'; marker mobile-scan-return blocked '[]'
expect 5-api-laundering 'any(.invalidReasons[]; test("scaffolded --evidence api but its journey declares evidence native-manual"))' "$(barrier)"
# ...and the other way: an api journey whose lane was NOT scaffolded api reads
# as a browser floor lane, where any media-looking file clears it and resets
# the cadence clock for a proof that was never an API contract check.
new_run '[{"id":"mobile-scan-return","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor"}]'
adopt "$NATIVE_PIN" >/dev/null
printf 'png' > "$RUN/shot.png"
marker branch-scope-crossing pass '["shot.png"]'; marker mobile-scan-return blocked '[]'
expect 5-api-journey-needs-api-lane '.ready == false and any(.invalidReasons[]; test("journey branch-scope-crossing declares evidence api but its lane was not scaffolded"))' "$(barrier)"
# A disposition's journey is held to the same rule; a new-journey has no grant.
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"report-export","kind":"lane","evidence":"api"}]'
adopt "$PIN_FILE" >/dev/null
marker loan-desk-checkout blocked '[]'; marker report-export blocked '[]'
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"new-journey","journeyId":"report-export"}]}'
expect 5-new-journey-no-api-grant 'any(.invalidReasons[]; test("lane report-export is scaffolded --evidence api"))' "$(barrier)"

# --- 5b. enforcement follows the GATE's pin, not the run's bookkeeping ---------
# A pr-owned run whose campaign the gate pinned cannot escape by skipping
# pin-run, nor by adopting a narrowed or stale selection.
# The barrier finds the pin in the SHARED lease dir, by the contract's sourceSha.
GATE_LEASES="$WORK/shared/qa-coordinator/leases"
GATE_PIN="$(gate_pin "$GATE_LEASES" "$SHA" '["api/src/reports/export.ts","web/src/desk/a.tsx"]')"
pr_run() { new_run "$1"; LEASES="$GATE_LEASES"; share_lease "$GATE_LEASES" 7; }
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
adopt "$GATE_PIN" >/dev/null
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
# Two repos, same PR number and sha, in one shared lease dir: WHICH is this
# campaign is the gate-authored lease's `repoSlug`, never a guess and never
# the environment (SMOKE_GATE_REPO only backfills a lease written before the
# field existed, below).
lease_repo() { share_lease "$GATE_LEASES" 7 "$1"; }
repo_barrier() { SMOKE_GATE_REPO="$1" SMOKE_GATE_LEASE_DIR="$GATE_LEASES" bash "$BARRIER" "$RUN" lanes || true; }
expect 5b-own-repo '.ready == true' "$(gate_barrier)"
expect 5b-env-does-not-override-lease '.ready == true' "$(repo_barrier other/fork)"   # the lease says org/repo; env is not identity
cp "$PIN_FORK" "$RUN/journeys/selection.json"
expect 5b-adopted-other-repo '.ready == false and any(.invalidReasons[];
  test("own gate pin .*journeys-pin-org__repo-pr-7-") and test("run adopted pinFile=.*other__fork"))' "$(gate_barrier)"
lease_repo other__fork
expect 5b-fork-owns-its-own '.ready == true' "$(gate_barrier)"   # the same bytes ARE the fork campaign's own
# A repo with no pin of its own for this (PR, head) owns none of these: a
# selection carried in anyway is nobody's, and without one it is the no-pin case.
lease_repo third__repo; cp "$GATE_PIN" "$RUN/journeys/selection.json"
expect 5b-third-repo-foreign-selection '.ready == false and any(.invalidReasons[]; test("no gate pin owns it"))' "$(gate_barrier)"
mv "$RUN/journeys" "$WORK/journeys.aside"
expect 5b-third-repo-no-pin '.ready == true' "$(gate_barrier)"
mv "$WORK/journeys.aside" "$RUN/journeys"
lease_repo org__repo
# IDENTITY THAT CANNOT BE COMPLETED — no lease (the gate's finish removes it),
# or a legacy lease without repoSlug and no SMOKE_GATE_REPO — is decided by
# whether THIS install keeps a catalogue: without one no pin can ever have been
# produced, so the legacy answer holds; with one an unpinned campaign cannot be
# told from one whose obligations were dropped, so a pr-owned run is refused,
# naming what is missing. With SMOKE_GATE_REPO set, a legacy lease is backfilled.
with_catalogue() { SMOKE_JOURNEYS_CATALOGUE="$CATALOGUE" "$@"; }
jq 'del(.repoSlug)' "$GATE_LEASES/lease-run-1.json" > "$GATE_LEASES/.legacy"; mv "$GATE_LEASES/.legacy" "$GATE_LEASES/lease-run-1.json"
expect 5b-legacy-lease-catalogue-unset-repo '.ready == false and (.invalid | index("journeys/selection.json")) and
  any(.invalidReasons[]; test("keeps a journey catalogue") and test("carries no repoSlug and SMOKE_GATE_REPO is unset"))' "$(with_catalogue gate_barrier)"
expect 5b-legacy-lease-catalogue-env-backfill '.ready == true' "$(with_catalogue repo_barrier org/repo)"
cp "$PIN_FORK" "$RUN/journeys/selection.json"
expect 5b-legacy-lease-env-backfill-enforces '.ready == false and any(.invalidReasons[]; test("run adopted pinFile=.*other__fork"))' "$(with_catalogue repo_barrier org/repo)"
cp "$GATE_PIN" "$RUN/journeys/selection.json"
expect 5b-legacy-lease-no-catalogue-unset-repo '.ready == false and any(.invalidReasons[]; test("no gate pin owns it"))' "$(gate_barrier)"   # legacy answer: a selection nobody owns
mv "$RUN/journeys" "$WORK/journeys.aside"
expect 5b-legacy-lease-no-catalogue-no-selection '.ready == true' "$(gate_barrier)"
expect 5b-legacy-lease-no-catalogue-env-backfill '.ready == false and any(.invalidReasons[]; test("never adopted it"))' "$(repo_barrier org/repo)"
mv "$WORK/journeys.aside" "$RUN/journeys"
rm -f "$GATE_LEASES/lease-run-1.json"
expect 5b-no-lease-catalogue '.ready == false and any(.invalidReasons[]; test("keeps a journey catalogue") and test("lease-run-1.json is absent"))' "$(with_catalogue gate_barrier)"
expect 5b-no-lease-catalogue-env-does-not-help '.ready == false and any(.invalidReasons[]; test("lease-run-1.json is absent"))' "$(with_catalogue repo_barrier org/repo)"
expect 5b-no-lease-no-catalogue '.ready == false and any(.invalidReasons[]; test("no gate pin owns it"))' "$(gate_barrier)"
mv "$RUN/journeys" "$WORK/journeys.aside"
expect 5b-no-lease-no-catalogue-no-selection '.ready == true' "$(gate_barrier)"
mv "$WORK/journeys.aside" "$RUN/journeys"
lease_repo org__repo
rm -f "$PIN_PR8" "$PIN_FORK"

# THE RUN NEVER AUTHORS WHAT IT IS HELD TO. An invalid primary pin is never "no
# pin", and the only thing that can stand in for it is the GATE's recovery pin
# (`…-recovery.json`: every catalogue journey owed) — judged by the same one
# predicate the gate uses. Nothing assembled on the run side counts.
ALL_LANES='[{"id":"loan-desk-checkout","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"},{"id":"mobile-scan-return","kind":"lane"}]'
SHAPE_ONLY='{"pinned":true,"matchedJourneys":[],"unmappedPaths":[]}'
for kind in truncated symlink directory shape-only; do
  BAD_LEASES="$WORK/bad-leases-$kind"; rm -rf "$BAD_LEASES"; share_lease "$BAD_LEASES" 7
  bad="$BAD_LEASES/journeys-pin-org__repo-pr-7-$SHA.json"
  case "$kind" in
    truncated) printf '{"pinned":tr' > "$bad" ;;
    symlink) ln -s "$GATE_PIN" "$bad" ;;
    directory) mkdir "$bad" ;;
    shape-only) printf '%s' "$SHAPE_ONLY" > "$bad" ;;   # the gate's old jq check refused this; read_gate_pin took it
  esac
  LEASES="$BAD_LEASES"
  expect "5b-$kind-pin-check" '.state == "invalid"' "$(python3 "$TOOL" pin-check "$bad" --pr 7 --head "$SHA" --repo-slug org__repo)"
  # No recovery pin: NOT ready, both files named, whatever the run holds.
  new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
  expect "5b-$kind-no-recovery" '.ready == false and any(.invalidReasons[]; test("no usable journeys pin") and test("neither journeys pin .*-recovery.json \\(absent\\)"))' "$(barrier)"
  expect "5b-$kind-pin-run-refuses" '.ok == false and (.error | test("not a valid gate pin"))' "$(python3 "$TOOL" pin-run "$RUN" "$bad" || true)"
  # A hand-written "rebuilt" selection (the retired run-side recovery) is just
  # bytes that are not the gate's.
  mkdir -p "$RUN/journeys"; cp "$EXAMPLE" "$RUN/journeys/catalogue.json"
  jq -cn --arg p "$bad" '{schemaVersion:1,selection:"full",rebuilt:true,invalidPin:{path:$p},catalogueValid:false,matchedJourneys:[],unmappedPaths:[]}' > "$RUN/journeys/selection.json"
  printf '{"dispositions":[{"disposition":"scope-rebuilt","reason":"x"}]}' > "$RUN/journeys/scope-dispositions.json"
  expect "5b-$kind-hand-rebuilt-refused" '.ready == false' "$(barrier)"
  # The gate's recovery pin owns the run: every journey, lane by lane.
  RECOVERY="$(gate_pin "$BAD_LEASES" "$SHA" '["api/src/reports/export.ts","web/src/desk/a.tsx"]' 7 org__repo recovery)"
  expect "5b-$kind-recovery-valid" '.state == "valid" and .pin.recovery == true and
    [.pin.matchedJourneys[] | {id,reason}] == [{"id":"loan-desk-checkout","reason":"pin-recovered"},{"id":"branch-scope-crossing","reason":"pin-recovered"},{"id":"mobile-scan-return","reason":"pin-recovered"}] and
    .pin.unmappedPaths == ["api/src/reports/export.ts"]' "$(python3 "$TOOL" pin-check "$RECOVERY" --pr 7 --head "$SHA")"
  expect "5b-$kind-hand-rebuilt-still-refused" '.ready == false and any(.invalidReasons[]; test("does not match this campaign.s own gate pin .*-recovery.json"))' "$(barrier)"
  new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
  expect "5b-$kind-recovery-must-be-adopted" 'any(.invalidReasons[]; test("pin-run .*-recovery.json"))' "$(barrier)"
  new_run "$ALL_LANES"; adopt "$RECOVERY" >/dev/null
  cmp -s "$RUN/journeys/selection.json" "$RECOVERY" || fail "5b: recovery adoption is not byte-for-byte"
  for lane in loan-desk-checkout branch-scope-crossing mobile-scan-return; do marker "$lane" blocked '[]'; done
  disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
  expect "5b-$kind-recovered-ready" '.ready == true' "$(barrier)"
  new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"}]'; adopt "$RECOVERY" >/dev/null
  marker loan-desk-checkout blocked '[]'; marker branch-scope-crossing blocked '[]'
  disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
  expect "5b-$kind-recovery-lane-per-journey" 'any(.invalidReasons[]; test("matched journey mobile-scan-return \\(pin-recovered\\) has no lane"))' "$(barrier)"
  # STABLE OWNER: a recovery pin, once it exists, owns — even if the primary
  # later reads as valid again (a fixture swap here; a checker hiccup in life).
  # The run holding the recovery bytes stays ready; primary bytes are refused.
  case "$kind" in directory) rm -rf "$bad" ;; *) rm -f "$bad" ;; esac
  cp "$GATE_PIN" "$bad"
  expect "5b-$kind-owner-is-recovery" '.state == "valid" and (.owner | test("-recovery.json$")) and .primary.state == "valid"' \
    "$(python3 "$TOOL" pin-check "$bad" --owner --pr 7 --head "$SHA")"
  new_run "$ALL_LANES"; adopt "$RECOVERY" >/dev/null
  for lane in loan-desk-checkout branch-scope-crossing mobile-scan-return; do marker "$lane" blocked '[]'; done
  disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
  expect "5b-$kind-recovery-still-owns" '.ready == true' "$(barrier)"
  new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; adopt "$bad" >/dev/null   # adopts the now-valid primary bytes
  marker loan-desk-checkout blocked '[]'; disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
  expect "5b-$kind-primary-bytes-refused" '.ready == false and any(.invalidReasons[]; test("own gate pin .*-recovery.json"))' "$(barrier)"
  # An invalid recovery pin is as good as none (primary back to invalid too).
  printf '{"pinned":tr' > "$bad"
  printf '%s' "$SHAPE_ONLY" > "$WORK/r.tmp"; cat "$WORK/r.tmp" > "$RECOVERY"
  expect "5b-$kind-both-invalid" '.ready == false and any(.invalidReasons[]; test("no usable journeys pin") and test("neither journeys pin"))' "$(barrier)"
done
# UNAVAILABLE IS NOT INVALID: a pin (or its snapshot) nobody can read is no
# verdict — the owner is undecided, the run is not ready, and nothing licenses
# a recovery. (Skipped as root, where chmod 000 still reads.)
if [ "$(id -u)" != 0 ]; then
  U_LEASES="$WORK/unavail-leases"; rm -rf "$U_LEASES"; share_lease "$U_LEASES" 7
  U_PIN="$(gate_pin "$U_LEASES" "$SHA" '["web/src/desk/a.tsx"]')"
  new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; adopt "$U_PIN" >/dev/null; marker loan-desk-checkout blocked '[]'
  chmod 000 "$U_PIN"
  expect 5b-unavailable-pin '.state == "unavailable" and (.primary.reason | test("could not be read"))' "$(python3 "$TOOL" pin-check "$U_PIN" --owner --pr 7 --head "$SHA")"
  expect 5b-unavailable-pin-barrier '.ready == false and any(.invalidReasons[]; test("no usable journeys pin") and test("could not be read"))' "$(barrier)"
  chmod 644 "$U_PIN"; chmod 000 "$U_LEASES"/journeys-catalogue-*.json
  expect 5b-unavailable-snapshot '.state == "unavailable" and (.primary.reason | test("snapshot could not be read"))' "$(python3 "$TOOL" pin-check "$U_PIN" --owner --pr 7 --head "$SHA")"
  chmod 644 "$U_LEASES"/journeys-catalogue-*.json
  expect 5b-available-again '.state == "valid" and .owner == "'"$U_PIN"'"' "$(python3 "$TOOL" pin-check "$U_PIN" --owner --pr 7 --head "$SHA")"
fi

# NOTHING IS ENUMERATED. The pin is looked up by the campaign's identity and
# probed by exact name, so a lease dir that can be SEARCHED but not LISTED
# (0300) is a healthy no-catalogue install's — byte-identical — and a symlinked
# lease dir is followed the way the gate and scaffold follow it. A probe that
# FAILED (unreachable dir, EACCES on the lease or the pin, a leaf symlink where
# a pin should be) is refused for a pr-owned run, naming what failed; a
# develop-owned run never takes pin obligations from there and is unchanged.
new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
NO_PIN_PR_OUT="$(SMOKE_GATE_LEASE_DIR="$WORK/empty-leases" bash "$BARRIER" "$RUN" lanes)"
MISSING_LEASES="$WORK/never-created-leases"
expect 5b-lease-dir-missing-pr '.ready == false and (.invalid | index("journeys/selection.json")) and
  any(.invalidReasons[]; test("could not be looked up") and test("never-created-leases") and test("could not be reached"))' \
  "$(SMOKE_GATE_LEASE_DIR="$MISSING_LEASES" bash "$BARRIER" "$RUN" lanes || true)"
SYML_LEASES="$WORK/symlinked-leases"; ln -s "$GATE_LEASES" "$SYML_LEASES"
expect 5b-lease-dir-symlink-followed '.ready == false and any(.invalidReasons[]; test("never adopted it") and test("pin-run"))' \
  "$(SMOKE_GATE_LEASE_DIR="$SYML_LEASES" bash "$BARRIER" "$RUN" lanes || true)"
mkdir -p "$WORK/symlink-root/qa-coordinator"; ln -s "$GATE_LEASES" "$WORK/symlink-root/qa-coordinator/leases"
expect 5b-lease-dir-symlink-shared-root '.ready == false and any(.invalidReasons[]; test("never adopted it"))' \
  "$(SMOKE_GATE_SHARED_ROOT="$WORK/symlink-root" bash "$BARRIER" "$RUN" lanes || true)"
jq '.ownershipKind = "develop" | .coordinatorOwnerToken = null' "$RUN/completion-contract.json" > "$RUN/c.tmp"; mv "$RUN/c.tmp" "$RUN/completion-contract.json"
DEVELOP_EMPTY_OUT="$(SMOKE_GATE_LEASE_DIR="$WORK/empty-leases" bash "$BARRIER" "$RUN" lanes)"
expect 5b-lease-dir-develop-baseline '.ready == true' "$DEVELOP_EMPTY_OUT"
[ "$(SMOKE_GATE_LEASE_DIR="$MISSING_LEASES" bash "$BARRIER" "$RUN" lanes)" = "$DEVELOP_EMPTY_OUT" ] ||
  fail "5b-lease-dir-missing-develop: a develop-owned run's answer changed with the lease dir missing"
if [ "$(id -u)" != 0 ]; then  # chmod still reads as root
  UNSEARCHABLE="$WORK/unsearchable-leases"; share_lease "$UNSEARCHABLE" 7; chmod 000 "$UNSEARCHABLE"
  [ "$(SMOKE_GATE_LEASE_DIR="$UNSEARCHABLE" bash "$BARRIER" "$RUN" lanes)" = "$DEVELOP_EMPTY_OUT" ] ||
    fail "5b-lease-dir-unsearchable-develop: a develop-owned run's answer changed with the lease dir unreadable"
  new_run '[{"id":"A1","kind":"lane"}]'; marker A1 blocked '[]'
  expect 5b-lease-dir-unsearchable-pr '.ready == false and (.invalid | index("journeys/selection.json")) and
    any(.invalidReasons[]; test("could not be looked up") and test("unsearchable-leases") and test("Permission denied"))' \
    "$(SMOKE_GATE_LEASE_DIR="$UNSEARCHABLE" bash "$BARRIER" "$RUN" lanes || true)"
  # Search-but-not-list (0300): named reads work, listing does not. No
  # catalogue, no pin => the legacy answer, byte for byte...
  chmod 300 "$UNSEARCHABLE"
  [ "$(SMOKE_GATE_LEASE_DIR="$UNSEARCHABLE" bash "$BARRIER" "$RUN" lanes)" = "$NO_PIN_PR_OUT" ] ||
    fail "5b-lease-dir-0300-no-pin: a search-only lease dir with no pin is not byte-identical to the no-pin answer"
  # ...and WITH a pin the pin is found and enforced, listing permission or not.
  chmod 755 "$UNSEARCHABLE"; U300_PIN="$(gate_pin "$UNSEARCHABLE" "$SHA" '["web/src/desk/a.tsx"]')"; chmod 300 "$UNSEARCHABLE"
  expect 5b-lease-dir-0300-pin-enforced '.ready == false and any(.invalidReasons[]; test("never adopted it") and test("pin-run"))' \
    "$(SMOKE_GATE_LEASE_DIR="$UNSEARCHABLE" bash "$BARRIER" "$RUN" lanes || true)"
  chmod 755 "$UNSEARCHABLE"
  # EACCES on the lease itself is a failed probe, not "no lease".
  chmod 000 "$UNSEARCHABLE/lease-run-1.json"
  expect 5b-lease-unreadable-pr '.ready == false and any(.invalidReasons[]; test("could not be looked up") and test("lease-run-1.json could not be read"))' \
    "$(SMOKE_GATE_LEASE_DIR="$UNSEARCHABLE" bash "$BARRIER" "$RUN" lanes || true)"
  chmod 644 "$UNSEARCHABLE/lease-run-1.json"
else
  echo "note: lease-dir permission fixtures skipped (running as root, chmod still reads)" >&2
fi
# A leaf symlink where the pin should be is INVALID, never followed and never "absent".
LINK_LEASES="$WORK/leaf-link-leases"; share_lease "$LINK_LEASES" 7
LINK_PIN="$(gate_pin "$WORK/leaf-link-src" "$SHA" '["web/src/desk/a.tsx"]')"
ln -s "$LINK_PIN" "$LINK_LEASES/$(basename "$LINK_PIN")"
expect 5b-leaf-symlink-pin-invalid '.state == "invalid" and (.reason | test("symlink"))' "$(python3 "$TOOL" pin-check "$LINK_LEASES/$(basename "$LINK_PIN")" --pr 7 --head "$SHA")"
expect 5b-leaf-symlink-pin-barrier '.ready == false and any(.invalidReasons[]; test("no usable journeys pin") and test("symlink"))' \
  "$(SMOKE_GATE_LEASE_DIR="$LINK_LEASES" bash "$BARRIER" "$RUN" lanes || true)"
# Nothing in the barrier enumerates the lease dir any more: no compgen, find or
# shell glob over it outside comments — the one lookup is by exact name in
# smoke-journeys.py, whose probes keep their errno.
[ "$(grep -v '^[[:space:]]*#' "$BARRIER" | grep -c 'compgen -G\|find "\$JOURNEY_LEASE_DIR\|\$JOURNEY_LEASE_DIR"*/[^"]*[*]\|in "\$JOURNEY_LEASE_DIR"/')" = 0 ] ||
  fail "5b-no-enumeration: smoke-evidence-barrier.sh enumerates the lease dir"

# A selection with NO gate pin behind it is not the gate's, so it is refused.
new_run "$ALL_LANES"; LEASES="$WORK/empty-leases"; share_lease "$LEASES" 7
mkdir -p "$RUN/journeys"; cp "$GATE_PIN" "$RUN/journeys/selection.json"
expect 5b-selection-without-gate-pin '.ready == false and any(.invalidReasons[]; test("no gate pin owns it"))' "$(barrier)"
expect 5b-no-pin-file '.ok == false' "$(python3 "$TOOL" pin-run "$RUN" "$WORK/nothing-here.json" || true)"
# The two identity facts the barrier already has: a contract naming another
# campaign's run, or calling itself develop-owned while the shared lease binds
# its run id to a PR, is refused whenever a journeys pin exists for the sha.
new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; adopt "$GATE_PIN" >/dev/null; marker loan-desk-checkout blocked '[]'
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
expect 5b-identity-ok '.ready == true' "$(barrier)"
jq '.runId = "run-2"' "$RUN/completion-contract.json" > "$RUN/c.tmp"; mv "$RUN/c.tmp" "$RUN/completion-contract.json"
expect 5b-borrowed-run-id '.ready == false and any(.invalidReasons[]; test("runId .run-2. is not this run directory.s name .run-1."))' "$(barrier)"
jq '.runId = "run-1" | .ownershipKind = "develop" | .coordinatorOwnerToken = null' "$RUN/completion-contract.json" > "$RUN/c.tmp"; mv "$RUN/c.tmp" "$RUN/completion-contract.json"
rm -rf "$RUN/journeys"
expect 5b-relabelled-develop '.ready == false and any(.invalidReasons[]; test("declares ownershipKind develop but the shared lease .* binds this run to PR #7"))' "$(barrier)"

# THE ONE PREDICATE, directly. Shape is not validity: identity and the snapshot count.
expect 5b-check-valid '.state == "valid"' "$(python3 "$TOOL" pin-check "$GATE_PIN" --pr 7 --head "$SHA" --repo-slug org__repo)"
expect 5b-check-absent '.state == "absent"' "$(python3 "$TOOL" pin-check "$WORK/nope.json" --pr 7 --head "$SHA")"
expect 5b-check-other-pr '.state == "invalid" and (.reason | test("PR 7, not 8"))' "$(python3 "$TOOL" pin-check "$GATE_PIN" --pr 8 --head "$SHA")"
expect 5b-check-other-repo '.state == "invalid" and (.reason | test("repo"))' "$(python3 "$TOOL" pin-check "$GATE_PIN" --pr 7 --head "$SHA" --repo-slug other__fork)"
mkdir -p "$WORK/moved"; cp "$GATE_LEASES"/journeys-catalogue-*.json "$WORK/moved/"; cp "$GATE_PIN" "$WORK/moved/journeys-pin-org__repo-pr-9-$SHA.json"
expect 5b-check-renamed '.state == "invalid" and (.reason | test("than its file name"))' "$(python3 "$TOOL" pin-check "$WORK/moved/journeys-pin-org__repo-pr-9-$SHA.json")"
cp "$GATE_PIN" "$WORK/moved/"; for snap in "$WORK/moved"/journeys-catalogue-*.json; do echo >> "$snap"; done
expect 5b-check-snapshot-tampered '.state == "invalid" and (.reason | test("does not hash"))' "$(python3 "$TOOL" pin-check "$WORK/moved/$(basename "$GATE_PIN")")"
rm -f "$WORK/moved"/journeys-catalogue-*.json
expect 5b-check-snapshot-missing '.state == "invalid" and (.reason | test("missing"))' "$(python3 "$TOOL" pin-check "$WORK/moved/$(basename "$GATE_PIN")")"
jq -c '.matchedJourneys[0].evidence = "api"' "$GATE_PIN" > "$WORK/relabel.json"
mkdir -p "$WORK/relabel"; cp "$GATE_LEASES"/journeys-catalogue-*.json "$WORK/relabel/"; mv "$WORK/relabel.json" "$WORK/relabel/$(basename "$GATE_PIN")"
expect 5b-check-evidence-relabelled '.state == "invalid" and (.reason | test("not in its catalogue snapshot with that evidence"))' "$(python3 "$TOOL" pin-check "$WORK/relabel/$(basename "$GATE_PIN")")"
expect 5b-candidate-empty-full '.state == "invalid" and (.reason | test("names no journey"))' \
  "$(match '[]' --unknown x | jq -c '.matchedJourneys = [] | .unassessedNativeJourneys = []' | python3 "$TOOL" pin-check --candidate)"
expect 5b-candidate-ok '.state == "valid"' "$(match '["web/src/desk/a.tsx"]' | python3 "$TOOL" pin-check --candidate)"

# --- 5c. one lane rule for every journey-backed lane ------------------------------
# A catalogue whose BROWSER journey is also a floor journey.
jq '.journeys[0].maxIntervalDays = 3' "$EXAMPLE" > "$WORK/browser-floor.json"
FLOOR_PIN="$(CATALOGUE="$WORK/browser-floor.json" gate_pin "$WORK/lease5c" "$SHA" '["web/src/desk/a.tsx","api/src/reports/export.ts"]')"
bf_run() { # <loan-desk lane kind>; report-export is there for the disposition cases
  new_run '[{"id":"loan-desk-checkout","kind":"'"$1"'"},{"id":"mobile-scan-return","kind":"lane"}]'
  adopt "$FLOOR_PIN" >/dev/null
  printf 'ok' > "$RUN/api.txt"; printf 'png' > "$RUN/desk.png"; marker mobile-scan-return blocked '[]'
  disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
}
# A floor journey scaffolded as an ordinary lane slips the barrier's floor-media
# bar and never touches the cadence clock: refused, whatever it cites.
bf_run lane; marker loan-desk-checkout pass '["api.txt"]'
expect 5c-floor-journey-needs-floor-kind '.ready == false and any(.invalidReasons[]; test("loan-desk-checkout is a floor journey but its lane is kind .lane."))' "$(barrier)"
bf_run floor; marker loan-desk-checkout pass '["api.txt"]'
expect 5c-browser-pass-needs-media '.ready == false and any(.invalidReasons[]; test("browser"))' "$(barrier)"
bf_run floor; marker loan-desk-checkout pass '["desk.png"]'
expect 5c-browser-floor-pass '.ready == true' "$(barrier)"
# The media bar is the JOURNEY's, not the lane kind's: a non-floor browser
# journey cannot pass on a text file either, nor on media that is not there.
new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'; adopt "$PIN_FILE" >/dev/null
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"unresolved","reason":"x"}]}'
printf 'ok' > "$RUN/api.txt"; marker loan-desk-checkout pass '["api.txt"]'
expect 5c-browser-lane-text-only 'any(.invalidReasons[]; test("a browser journey passes only on browser media"))' "$(barrier)"
printf 'png' > "$RUN/desk.png"; marker loan-desk-checkout pass '["api.txt","desk.png"]'
expect 5c-browser-lane-with-media '.ready == true' "$(barrier)"
# Disposition-linked journeys take the SAME helper: a native-manual journey
# reached through mapped-to-journey passes only on the tester's result.
bf_run floor; marker loan-desk-checkout blocked '[]'; printf 'packet' > "$RUN/packet.md"
marker mobile-scan-return pass '["packet.md"]'
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"mapped-to-journey","journeyId":"mobile-scan-return"}]}'
expect 5c-disposition-native-needs-result 'any(.invalidReasons[]; test("named tester"))' "$(barrier)"
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"mapped-to-journey","journeyId":"loan-desk-checkout"}]}'
marker mobile-scan-return blocked '[]'
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"mobile-scan-return","kind":"lane"}]'; adopt "$FLOOR_PIN" >/dev/null
marker loan-desk-checkout blocked '[]'; marker mobile-scan-return blocked '[]'
disposition '{"dispositions":[{"paths":["api/src/reports/export.ts"],"disposition":"mapped-to-journey","journeyId":"loan-desk-checkout"}]}'
expect 5c-disposition-floor-kind 'any(.invalidReasons[]; test("is a floor journey but its lane is kind"))' "$(barrier)"

# DUE FLOOR JOURNEYS ARE MANDATORY MATCHES, native ones included. Unknown range
# and no readable history: a native-manual floor journey is due, so it is a
# required lane (packet/result shape), not an "unassessed" footnote.
jq '.journeys[2].maxIntervalDays = 30' "$EXAMPLE" > "$WORK/native-floor.json"
OUT="$(CATALOGUE="$WORK/native-floor.json" match '[]' --unknown "no GO" --run-root "")"
expect 5c-native-floor-due-is-matched '.unassessedNativeJourneys == [] and
  [.matchedJourneys[] | select(.id == "mobile-scan-return") | {reason,floor}] == [{"reason":"floor","floor":true}]' "$OUT"
NF_PIN="$(CATALOGUE="$WORK/native-floor.json" gate_pin "$WORK/lease5d" "$SHA" '[]' 7 org__repo "" '--unknown no-GO --run-root /nonexistent')"
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"}]'; adopt "$NF_PIN" >/dev/null
marker loan-desk-checkout blocked '[]'; marker branch-scope-crossing blocked '[]'
expect 5c-native-floor-needs-lane 'any(.invalidReasons[]; test("matched journey mobile-scan-return \\(floor\\) has no lane"))' "$(barrier)"
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"},{"id":"mobile-scan-return","kind":"lane"}]'; adopt "$NF_PIN" >/dev/null
for lane in loan-desk-checkout branch-scope-crossing mobile-scan-return; do marker "$lane" blocked '[]'; done
expect 5c-native-floor-kind 'any(.invalidReasons[]; test("mobile-scan-return is a floor journey but its lane is kind"))' "$(barrier)"
new_run '[{"id":"loan-desk-checkout","kind":"lane"},{"id":"branch-scope-crossing","kind":"floor","evidence":"api"},{"id":"mobile-scan-return","kind":"floor"}]'; adopt "$NF_PIN" >/dev/null
for lane in loan-desk-checkout branch-scope-crossing; do marker "$lane" blocked '[]'; done
printf 'packet' > "$RUN/packet.md"; marker mobile-scan-return pass '["packet.md"]'
expect 5c-native-floor-packet-is-not-pass 'any(.invalidReasons[]; test("named tester"))' "$(barrier)"
marker mobile-scan-return completed '["packet.md"]'
expect 5c-native-floor-packet-issued '.ready == true' "$(barrier)"

# --- 6. capture recipes --------------------------------------------------------
new_run '[{"id":"loan-desk-checkout","kind":"lane"}]'
adopt "$PIN_FILE" >/dev/null
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
