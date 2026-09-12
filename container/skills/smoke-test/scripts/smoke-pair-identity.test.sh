#!/usr/bin/env bash
# Exercises smoke-pair-identity.sh end to end through its real verbs against
# fixture Render responses (SMOKE_PAIR_FIXTURE_DIR) — no network. Covers the
# three review rounds that shaped this script (wrong serving identity, drift
# erased by re-initialization, success without durable evidence) plus the
# bounded re-freeze: one re-freeze allowed per run, a second drift after it
# stays BLOCKED, a stale-generation receipt never counts toward the current
# baseline, and `finish` (and the evidence barrier) refuse until every lane
# the contract declared at the re-freeze has been redispatched after it
# (issue #731, F3). Contracts and redispatches go through the real
# smoke-run-scaffold.sh verbs, so the snapshot is tested against its field.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-pair-identity.sh"

T="$(mktemp -d)"
cleanup() { rm -rf "$T"; }
trap cleanup EXIT

export SMOKE_PAIR_FIXTURE_DIR="$T/fx"
export SMOKE_GATE_FRONTEND_SERVICE="srv-fe00000000001"
export SMOKE_GATE_BACKEND_SERVICE="srv-be00000000001"
mkdir -p "$SMOKE_PAIR_FIXTURE_DIR"

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc

mk() { printf '[{"deploy":{"id":"%s","status":"%s","finishedAt":"2026-09-10T00:00:00Z","commit":{"id":"%s"}}}]' "$1" "$2" "$3"; }
mk2() { printf '[{"deploy":{"id":"%s","status":"%s","commit":{"id":"%s"}}},{"deploy":{"id":"%s","status":"%s","commit":{"id":"%s"}}}]' "$@"; }

run() { bash "$SCRIPT" "$@" >"$T/out" 2>"$T/err"; echo $?; }
out() { cat "$T/out"; }
err() { cat "$T/err"; }

fail() { echo "FAIL: $1" >&2; echo "-- stdout --" >&2; out >&2; echo "-- stderr --" >&2; err >&2; exit 1; }
expect_rc() { [ "$1" = "$2" ] || fail "$3: expected exit $2, got $1"; }

# Real completion contracts, markers and redispatches, written by the
# scaffold's own verbs. A develop-fenced run needs no shared lease: the fence
# only requires develop-state.json to name the run and its SHA.
SCAFFOLD="$SCRIPT_DIR/smoke-run-scaffold.sh"
BARRIER="$SCRIPT_DIR/smoke-evidence-barrier.sh"
export SMOKE_LANE_ROLE=coordinator
export SMOKE_GATE_STATE_DIR="$T/gate-state"
mkdir -p "$SMOKE_GATE_STATE_DIR"
SRC_SHA=dddddddddddddddddddddddddddddddddddddddd
SRC_SHA2=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
gate_develop() { printf '{"activeRunId":"%s","activeSha":"%s"}\n' "$(basename "$1")" "${2:-$SRC_SHA}" > "$SMOKE_GATE_STATE_DIR/develop-state.json"; }
scaffold() { bash "$SCAFFOLD" "$@" >"$T/sout" 2>&1 || { echo "FAIL: scaffold $*" >&2; cat "$T/sout" >&2; exit 1; }; }
conclusions() { mkdir -p "$1/coordinator" "$1/challenger"
  printf '# preliminary\n' > "$1/coordinator/preliminary.md"; printf '# disposition\n' > "$1/challenger/disposition.md"; }
journal_lines() { wc -l < "$1/coordinator/identity-checks.ndjson" | tr -d ' '; }

# --- missing service ids fail closed, in every mode, not just fixture mode -
RC="$(SMOKE_GATE_FRONTEND_SERVICE= SMOKE_GATE_BACKEND_SERVICE= bash "$SCRIPT" read >"$T/out" 2>"$T/err"; echo $?)"
expect_rc "$RC" 2 missing-services
err | grep -q 'SMOKE_GATE_FRONTEND_SERVICE' || fail "missing-services: message did not name the required env var"

# --- 1. Happy path: start freezes the LIVE pair, check/finish clean --------
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
RUN1="$T/run1"; mkdir -p "$RUN1"
expect_rc "$(run start "$RUN1")" 0 start-valid
jq -e '.frontend.deploy == "dep-fe000000001" and .backend.deploy == "dep-be000000001" and .freezeGeneration == 1 and .history == []' \
  "$RUN1/coordinator/identity.json" >/dev/null || fail "start-valid: identity.json shape wrong"
expect_rc "$(run check "$RUN1" lane-a-start)" 0 check-unchanged
expect_rc "$(run finish "$RUN1")" 0 finish-clean
tail -1 "$RUN1/coordinator/identity-checks.ndjson" | jq -e '.freezeGeneration == 1' >/dev/null || \
  fail "check-unchanged: receipt not tagged with freezeGeneration 1"

# --- 2. Wrong serving identity: only a status:"live" record may freeze -----
RUN2="$T/run2"; mkdir -p "$RUN2"
mk2 dep-fe000000009 build_in_progress "$C" dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN2")" 0 start-nonlive-first
grep -q 'dep-fe000000001' "$RUN2/coordinator/identity.json" || fail "start-nonlive-first: froze the building deploy, not the live one"
mk dep-fe000000001 deactivated "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" deactivated)" 2 live-to-deactivated
printf '[{"deploy":{"id":12345,"status":"live","commit":{"id":"%s"}}}]' "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" numeric-id)" 2 numeric-id
printf '[{"deploy":{"id":"dep-fe000000001","status":"live","commit":{"id":"notasha"}}}]' > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
expect_rc "$(run check "$RUN2" bad-sha)" 2 bad-sha

# --- 3. Drift erased by re-initialization: start is no-clobber -------------
RUN3="$T/run3"; mkdir -p "$RUN3"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN3")" 0 drift-start
mk dep-be000000002 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN3" moved)" 3 same-commit-redeploy-drift
expect_rc "$(run start "$RUN3")" 4 restart-after-drift-refused
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run finish "$RUN3")" 3 finish-after-recorded-drift

# --- 4. Success without durable evidence: a failed check log write refuses -
RUN4="$T/run4"; mkdir -p "$RUN4"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN4")" 0 evidence-start
chmod 500 "$RUN4/coordinator"
expect_rc "$(run check "$RUN4" ro)" 2 check-log-unwritable
chmod 700 "$RUN4/coordinator"
expect_rc "$(run finish "$RUN4")" 2 finish-no-successful-check

# --- 5. Bounded re-freeze: first drift may re-freeze once, second is BLOCKED
# Issue #731 F3's sequence on a real run. The contract declares lanes A, B, C
# before dispatch; A and B check ok at generation 1, C records drift, and the
# coordinator re-freezes. This test used to assert that one ok `check` by the
# coordinator then let `finish` exit 0 with no lane redispatched. Now finish
# refuses and names the stale lanes, and passes only once every lane is
# redispatched.
RUN5="$T/run5"; mkdir -p "$RUN5"
gate_develop "$RUN5"
scaffold contract "$RUN5" "$SRC_SHA" A B C
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN5")" 0 refreeze-start
expect_rc "$(run check "$RUN5" lane-a)" 0 refreeze-lane-a-gen1
expect_rc "$(run check "$RUN5" lane-b)" 0 refreeze-lane-b-gen1
scaffold marker "$RUN5" A completed "A on the old pair"
scaffold marker "$RUN5" B completed "B on the old pair"
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN5" lane-c)" 3 refreeze-first-drift-detected
scaffold marker "$RUN5" C blocked "C saw the pair drift"
expect_rc "$(run refreeze "$RUN5" "")" 2 refreeze-requires-reason
expect_rc "$(run refreeze "$RUN5" "backend replaced mid-run")" 0 refreeze-allowed
jq -e '.freezeGeneration == 2' "$RUN5/coordinator/identity.json" >/dev/null || fail "refreeze-allowed: freezeGeneration did not bump to 2"
jq -e '.history | length == 1 and .[0].backend.deploy == "dep-be000000001" and .[0].reason == "backend replaced mid-run"' \
  "$RUN5/coordinator/identity.json" >/dev/null || fail "refreeze-allowed: history did not name the OLD pair and reason"
jq -e '.backend.deploy == "dep-be000000009"' "$RUN5/coordinator/identity.json" >/dev/null || \
  fail "refreeze-allowed: current pair is not the NEW pair"
jq -e --arg sha "$SRC_SHA" '.refreezeLaneSnapshot == {contractPresent: true, sourceSha: $sha,
    lanes: [{id: "A", generation: 1}, {id: "B", generation: 1}, {id: "C", generation: 1}]}' \
  "$RUN5/coordinator/identity.json" >/dev/null || fail "refreeze-allowed: lane snapshot is not the contract's generations"
# The coordinator's own check at the new generation is ok...
expect_rc "$(run check "$RUN5" coordinator-postfreeze)" 0 check-after-refreeze
LAST_REC="$(tail -1 "$RUN5/coordinator/identity-checks.ndjson")"
jq -e '.freezeGeneration == 2' <<<"$LAST_REC" >/dev/null || fail "check-after-refreeze: receipt not tagged generation 2"
# ...but it is not lane evidence. Nothing was redispatched, so finish refuses,
# names every stale lane, and appends no receipt.
BEFORE="$(journal_lines "$RUN5")"
expect_rc "$(run finish "$RUN5")" 2 finish-refuses-without-redispatch
out | grep -Fq 'not redispatched since the pair re-freeze: A, B, C;' || \
  fail "finish-refuses-without-redispatch: message did not name lanes A, B, C"
[ "$(journal_lines "$RUN5")" = "$BEFORE" ] || fail "finish-refuses-without-redispatch: a refused finish still appended a receipt"
# The evidence barrier refuses synthesis on the same rule, so skipping finish
# does not get around it.
conclusions "$RUN5"
BOUT="$(bash "$BARRIER" "$RUN5" synthesis || true)"
jq -e '.ready == false and (.invalid | sort) == ["markers/A.json","markers/B.json","markers/C.json"]
       and all(.invalidReasons[]; contains("not redispatched since the pair re-freeze"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-refuses-without-redispatch"; }
# Redispatching only some lanes still refuses, naming just the rest.
scaffold redispatch "$RUN5" A
scaffold redispatch "$RUN5" B
expect_rc "$(run finish "$RUN5")" 2 finish-refuses-partial-redispatch
out | grep -Fq 'not redispatched since the pair re-freeze: C;' || \
  fail "finish-refuses-partial-redispatch: message did not name exactly lane C"
BOUT="$(bash "$BARRIER" "$RUN5" synthesis || true)"
jq -e '.ready == false and ([.invalidReasons[] | select(contains("re-freeze"))] | length == 1)
       and any(.invalidReasons[]; startswith("markers/C.json: not redispatched since the pair re-freeze"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-refuses-partial-redispatch"; }
# Every lane redispatched: finish passes, the coordinator's generation-2
# receipt being the current-generation check.
scaffold redispatch "$RUN5" C
expect_rc "$(run finish "$RUN5")" 0 finish-after-full-redispatch
# The barrier then waits on fresh markers, as for any redispatched lane.
BOUT="$(bash "$BARRIER" "$RUN5" synthesis || true)"
jq -e '.ready == false and (.invalidReasons | length == 3) and all(.invalidReasons[]; contains("stale generation"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-waits-on-fresh-markers"; }
for l in A B C; do scaffold marker "$RUN5" "$l" completed "$l on the new pair"; done
bash "$BARRIER" "$RUN5" synthesis | jq -e '.ready == true' >/dev/null || fail "barrier-ready-after-redispatch"
# Second drift after the one allowed re-freeze: check still reports it, but
# a second refreeze call is refused outright — this run is done re-freezing.
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN5" seconddrift)" 3 second-drift-after-refreeze
RC="$(run refreeze "$RUN5" "trying again")"
expect_rc "$RC" 4 second-refreeze-refused
err | grep -qi 'already re-froze' || fail "second-refreeze-refused: message did not name the one-per-run bound"
expect_rc "$(run finish "$RUN5")" 3 finish-after-second-drift-blocked

# refreeze itself requires a prior identity.json, and refuses a corrupt one
RUN6="$T/run6"; mkdir -p "$RUN6"
expect_rc "$(run refreeze "$RUN6" "no baseline yet")" 2 refreeze-without-start
mkdir -p "$RUN6/coordinator"; printf 'not json' > "$RUN6/coordinator/identity.json"
expect_rc "$(run refreeze "$RUN6" "corrupt")" 2 refreeze-corrupt-baseline

# --- 5b. Re-freeze before any contract: drift caught at preflight, no lane
# dispatched yet, so no lanes are snapshotted. The stale-generation rule still
# holds: the pre-refreeze receipt cannot stand in for a generation-2 one.
RUN7="$T/run7"; mkdir -p "$RUN7"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN7")" 0 contractless-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN7" preflight)" 3 contractless-drift
expect_rc "$(run refreeze "$RUN7" "backend replaced before dispatch")" 0 contractless-refreeze
jq -e '.refreezeLaneSnapshot == {contractPresent: false, sourceSha: null, lanes: []}' \
  "$RUN7/coordinator/identity.json" >/dev/null || fail "contractless-refreeze: snapshot should record no contract and no lanes"
expect_rc "$(run finish "$RUN7")" 2 finish-before-fresh-gen2-check
out | grep -q 'no identity checks recorded at the current freeze generation' || \
  fail "finish-before-fresh-gen2-check: refused for the wrong reason"
expect_rc "$(run check "$RUN7" postfreeze)" 0 contractless-check-after-refreeze
expect_rc "$(run finish "$RUN7")" 0 finish-after-contractless-refreeze

# --- 5c. Lane markers with no contract: the contract was removed, so a
# re-freeze cannot tell which lanes to redispatch, and refuses.
RUN8="$T/run8"; mkdir -p "$RUN8"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN8")" 0 orphan-markers-start
mkdir -p "$RUN8/markers"; printf '{"lane":"A","generation":1}\n' > "$RUN8/markers/A.json"
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN8" "backend replaced")" 2 refreeze-refuses-markers-without-contract
err | grep -q 'no completion contract' || fail "refreeze-refuses-markers-without-contract: message did not name the missing contract"
jq -e '.freezeGeneration == 1 and .history == []' "$RUN8/coordinator/identity.json" >/dev/null || \
  fail "refreeze-refuses-markers-without-contract: identity.json was re-frozen anyway"

# --- 5d. A contract re-scaffolded on another sourceSha after the re-freeze
# satisfies the snapshot: the barrier's sourceSha check already refuses every
# marker written under the old contract.
RUN9="$T/run9"; mkdir -p "$RUN9"
gate_develop "$RUN9"
scaffold contract "$RUN9" "$SRC_SHA" A B
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN9")" 0 new-sha-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN9" "backend replaced")" 0 new-sha-refreeze
gate_develop "$RUN9" "$SRC_SHA2"
scaffold contract "$RUN9" "$SRC_SHA2" A B
expect_rc "$(run check "$RUN9" postfreeze)" 0 new-sha-check
expect_rc "$(run finish "$RUN9")" 0 finish-after-rescaffold-on-new-sha

# --- 5e. Every doubt about the snapshot refuses: a re-frozen identity.json
# with no snapshot (hand-edited, or written before this check existed), a
# contract that vanished after the snapshot, or one that no longer parses.
RUN10="$T/run10"; mkdir -p "$RUN10"
gate_develop "$RUN10"
scaffold contract "$RUN10" "$SRC_SHA" A
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN10")" 0 snapshot-doubt-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN10" "backend replaced")" 0 snapshot-doubt-refreeze
scaffold redispatch "$RUN10" A
expect_rc "$(run check "$RUN10" postfreeze)" 0 snapshot-doubt-check
expect_rc "$(run finish "$RUN10")" 0 snapshot-doubt-baseline-finish
ID10="$RUN10/coordinator/identity.json"; cp "$ID10" "$T/id10.bak"
jq -c 'del(.refreezeLaneSnapshot)' "$T/id10.bak" > "$ID10"
expect_rc "$(run finish "$RUN10")" 2 finish-refuses-missing-snapshot
out | grep -q 'no lane snapshot' || fail "finish-refuses-missing-snapshot: refused for the wrong reason"
cp "$T/id10.bak" "$ID10"
mv "$RUN10/completion-contract.json" "$T/contract10.bak"
expect_rc "$(run finish "$RUN10")" 2 finish-refuses-vanished-contract
out | grep -q 'completion-contract.json is missing' || fail "finish-refuses-vanished-contract: refused for the wrong reason"
printf 'not json' > "$RUN10/completion-contract.json"
expect_rc "$(run finish "$RUN10")" 2 finish-refuses-unparsable-contract
out | grep -q 'does not read as a contract' || fail "finish-refuses-unparsable-contract: refused for the wrong reason"
mv "$T/contract10.bak" "$RUN10/completion-contract.json"
expect_rc "$(run finish "$RUN10")" 0 snapshot-doubt-restored-finish

# --- 5f. No re-freeze: behaviour is unchanged. A contract whose lanes were
# never redispatched does not matter, and finish does not even read it.
RUN11="$T/run11"; mkdir -p "$RUN11"
gate_develop "$RUN11"
scaffold contract "$RUN11" "$SRC_SHA" A B
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN11")" 0 no-refreeze-start
expect_rc "$(run check "$RUN11" lane-a)" 0 no-refreeze-check
expect_rc "$(run finish "$RUN11")" 0 finish-no-refreeze-with-contract
printf 'not json' > "$RUN11/completion-contract.json"
expect_rc "$(run finish "$RUN11")" 0 finish-no-refreeze-ignores-contract

# --- 6. Success without evidence: an actual truncated write is refused -----
# Needs mount privilege (a full 64k tmpfs forces a real short write); skip
# quietly otherwise — the read-back-before-install code path this exercises
# is unchanged from the reviewed v3 script and isn't re-derived here.
if command -v mount >/dev/null 2>&1 && mkdir -p "$T/tiny" && mount -t tmpfs -o size=64k tmpfs "$T/tiny" 2>/dev/null; then
  dd if=/dev/zero of="$T/tiny/fill" bs=1k count=62 2>/dev/null
  mkdir -p "$T/tiny/run"
  expect_rc "$(run start "$T/tiny/run")" 2 start-partial-write
  [ -e "$T/tiny/run/coordinator/identity.json" ] && fail "start-partial-write: a truncated write still installed a baseline"
  umount "$T/tiny" 2>/dev/null || true
else
  echo "note: tmpfs partial-write fixture skipped (no mount privilege)"
fi

echo "smoke pair identity tests passed"
