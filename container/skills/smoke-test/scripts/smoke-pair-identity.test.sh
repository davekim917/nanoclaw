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
# marker written under the old contract. The re-scaffold also gains lane D,
# which the old snapshot (taken on $SRC_SHA, naming only A and B) never named
# either — this must stay green for the same reason as the missing-sha
# mismatch itself: a contract rewrite on a new sourceSha retires every old
# marker regardless of which lanes it declares.
RUN9="$T/run9"; mkdir -p "$RUN9"
gate_develop "$RUN9"
scaffold contract "$RUN9" "$SRC_SHA" A B
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN9")" 0 new-sha-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN9" "backend replaced")" 0 new-sha-refreeze
gate_develop "$RUN9" "$SRC_SHA2"
scaffold contract "$RUN9" "$SRC_SHA2" A B D
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

# --- 5g. A required lane the snapshot never named is not stale when its
# generation is above the snapshot's highest — the one way that can happen is
# `contract --regenerate`, which bumps every lane, old and new, past whatever
# was on disk at that moment. Covers both `--regenerate` with no lane gain
# (the ordinary redispatch-everything case) and `--regenerate` adding a lane.
RUN14="$T/run14"; mkdir -p "$RUN14"
gate_develop "$RUN14"
scaffold contract "$RUN14" "$SRC_SHA" A B
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN14")" 0 regen-start
scaffold marker "$RUN14" A completed "A on the old pair"
scaffold marker "$RUN14" B completed "B on the old pair"
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN14" "backend replaced")" 0 regen-refreeze
jq -e --arg sha "$SRC_SHA" '.refreezeLaneSnapshot == {contractPresent: true, sourceSha: $sha,
    lanes: [{id: "A", generation: 1}, {id: "B", generation: 1}]}' \
  "$RUN14/coordinator/identity.json" >/dev/null || fail "regen-refreeze: snapshot did not name A, B at generation 1"
# --regenerate with the SAME lanes: both bump past the snapshot, no lane
# gain — the old markers are still on disk, at the old generation.
scaffold contract "$RUN14" "$SRC_SHA" A B --regenerate
expect_rc "$(run check "$RUN14" postrefreeze)" 0 regen-check-postfreeze
expect_rc "$(run finish "$RUN14")" 0 finish-after-regenerate-no-new-lane
conclusions "$RUN14"
BOUT="$(bash "$BARRIER" "$RUN14" synthesis || true)"
jq -e '.ready == false and (.invalid | sort) == ["markers/A.json","markers/B.json"]
       and (.invalidReasons | length == 2) and all(.invalidReasons[]; contains("stale generation"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-after-regenerate-no-new-lane: A, B should wait on a fresh marker (ordinary stale generation), not be reported un-redispatched"; }
# --regenerate again, adding lane D: the snapshot never named D, and D's
# generation — bumped along with A and B — is above the snapshot's highest,
# so D is not treated as stale either; it simply has no marker yet.
scaffold contract "$RUN14" "$SRC_SHA" A B D --regenerate
expect_rc "$(run finish "$RUN14")" 0 finish-after-regenerate-gains-lane
BOUT="$(bash "$BARRIER" "$RUN14" synthesis || true)"
jq -e '.ready == false and (.invalid | sort) == ["markers/A.json","markers/B.json"]
       and all(.invalidReasons[]; contains("stale generation")) and (.missing == ["markers/D.json"])' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-after-regenerate-gains-lane: D (never named in the snapshot) must not be flagged as un-redispatched"; }

# --- 5h. Two ways to defeat the redispatch rule without deleting the
# snapshot outright: emptying `lanes` to `[]`, and flipping `contractPresent`
# to false while still naming a sourceSha (a shape `refreeze` never writes —
# its own contractPresent:false always pairs with sourceSha:null). Both must
# refuse in `finish` AND in the barrier, exactly like the missing-snapshot
# case in 5e above.
RUN15="$T/run15"; mkdir -p "$RUN15"
gate_develop "$RUN15"
scaffold contract "$RUN15" "$SRC_SHA" A B
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN15")" 0 bypass-start
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUN15" "backend replaced")" 0 bypass-refreeze
# A fresh check at the current freeze generation, so the redispatch-stale
# check below is what finish would refuse or clear ON — not an incidental
# empty check journal, which would refuse for an unrelated reason and mask a
# bypass that let the stale check itself through.
expect_rc "$(run check "$RUN15" postfreeze)" 0 bypass-check-postfreeze
ID15="$RUN15/coordinator/identity.json"; cp "$ID15" "$T/id15.bak"
conclusions "$RUN15"

# Bypass 1: an EMPTIED snapshot (`lanes: []`) must not turn the rule off —
# there is no recorded maximum generation for A or B to legitimately exceed.
jq -c '.refreezeLaneSnapshot.lanes = []' "$T/id15.bak" > "$ID15"
expect_rc "$(run finish "$RUN15")" 2 finish-refuses-emptied-snapshot
out | grep -Fq 'not redispatched since the pair re-freeze: A, B;' || \
  fail "finish-refuses-emptied-snapshot: message did not name lanes A, B"
BOUT="$(bash "$BARRIER" "$RUN15" synthesis || true)"
jq -e '.ready == false and (.invalid | sort) == ["markers/A.json","markers/B.json"]
       and all(.invalidReasons[]; contains("not redispatched since the pair re-freeze"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-refuses-emptied-snapshot"; }

# Bypass 2: `contractPresent:false` paired with a sourceSha — refuse instead
# of reading it as "nothing was dispatched yet".
jq -c --arg sha "$SRC_SHA" '.refreezeLaneSnapshot = {contractPresent:false,sourceSha:$sha,lanes:[]}' "$T/id15.bak" > "$ID15"
expect_rc "$(run finish "$RUN15")" 2 finish-refuses-falsified-contractpresent
out | grep -Fq 'also records a sourceSha' || \
  fail "finish-refuses-falsified-contractpresent: refused for the wrong reason"
BOUT="$(bash "$BARRIER" "$RUN15" synthesis || true)"
jq -e '.ready == false and .invalid == ["coordinator/identity.json"]
       and (.invalidReasons[0] | contains("also records a sourceSha"))' <<<"$BOUT" >/dev/null || \
  { echo "$BOUT" > "$T/out"; fail "barrier-refuses-falsified-contractpresent"; }

# Restoring the real snapshot goes back to the ordinary un-redispatched
# refusal — not because the snapshot is malformed, but because A and B truly
# have not been redispatched yet.
cp "$T/id15.bak" "$ID15"
expect_rc "$(run finish "$RUN15")" 2 bypass-restored-refuses-for-the-real-reason
out | grep -Fq 'not redispatched since the pair re-freeze: A, B;' || \
  fail "bypass-restored-refuses-for-the-real-reason: expected the ordinary un-redispatched refusal after restoring the real snapshot"

# --- 5i. A LATE freeze does not launder evidence gathered before it (XZO #2092)
# The laundering sequence: lanes run and write markers with no pair frozen;
# `start` then freezes whatever is live NOW and one ok `check` follows. Before,
# that cleared finish and the barrier, so markers bound to no build supported a
# verdict. A start that finds lane evidence on disk records itself as late and
# snapshots the lanes like a re-freeze; nothing counts until each lane is
# redispatched and re-run. A start with no marker yet is an ordinary freeze.
[ "$(jq -r 'has("lateFreeze")' "$RUN5/coordinator/identity.json")" = false ] ||
  fail "late-freeze: a start with no lane evidence on disk (run5) was recorded as late"
RUNL="$T/run-late"; mkdir -p "$RUNL"
gate_develop "$RUNL"
scaffold contract "$RUNL" "$SRC_SHA" A B
scaffold marker "$RUNL" A completed "A ran before any freeze"
scaffold marker "$RUNL" B completed "B ran before any freeze"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUNL")" 0 late-start
err | grep -q 'LATE FREEZE' || fail "late-start: start did not say the freeze was late"
jq -e --arg sha "$SRC_SHA" '.lateFreeze.markersOnDisk == ["markers/A.json","markers/B.json"]
    and .refreezeLaneSnapshot == {contractPresent: true, sourceSha: $sha, lanes: [{id: "A", generation: 1}, {id: "B", generation: 1}]}
    and .freezeGeneration == 1 and .history == []' "$RUNL/coordinator/identity.json" >/dev/null ||
  fail "late-start: identity.json does not record the late freeze and its lane snapshot"
expect_rc "$(run check "$RUNL" coordinator-after-late-start)" 0 late-check-ok
# The laundering step: an ok check on the late freeze must NOT clear the lanes.
expect_rc "$(run finish "$RUNL")" 2 late-finish-refuses
out | grep -Fq 'not redispatched since the pair was frozen late: A, B;' ||
  fail "late-finish-refuses: finish did not name both lanes as run before the freeze"
conclusions "$RUNL"
BOUT="$(bash "$BARRIER" "$RUNL" synthesis || true)"
jq -e '.ready == false and (.invalid | sort) == ["markers/A.json","markers/B.json"]
       and all(.invalidReasons[]; contains("frozen LATE") and contains("redispatch"))' <<<"$BOUT" >/dev/null ||
  { echo "$BOUT" > "$T/out"; fail "late-barrier-refuses"; }
# Recovery is possible: redispatch, re-run with checks, and the same run passes.
scaffold redispatch "$RUNL" A
scaffold redispatch "$RUNL" B
for l in A B; do
  expect_rc "$(run check "$RUNL" "lane-$l-start")" 0 "late-recovery-check-$l"
  scaffold marker "$RUNL" "$l" completed "$l re-run on the frozen pair"
done
expect_rc "$(run finish "$RUNL")" 0 late-finish-after-redispatch
bash "$BARRIER" "$RUNL" synthesis | jq -e '.ready == true' >/dev/null || fail "late-barrier-ready-after-redispatch"
# The one bounded refreeze is still available after a late freeze.
mk dep-be000000009 live "$C" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run refreeze "$RUNL" "backend replaced after the late freeze")" 0 late-then-refreeze-allowed

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

# --- 7. A PR contract binds the frozen pair to its preview source SHA -------
# The shared smoke-gate env normally names the develop services. For a PR run,
# letting start freeze those services and then having check compare them only
# to themselves is a false green. A PR-owned contract makes its sourceSha the
# expected serving commit for BOTH services; develop contracts above retain
# their existing pair-only behavior because their services may differ.
RUN16="$T/run16"; mkdir -p "$RUN16"
cat >"$RUN16/completion-contract.json" <<JSON
{"schemaVersion":1,"sourceSha":"$SRC_SHA","ownershipKind":"pr","requiredLaneMarkers":[]}
JSON
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN16")" 2 pr-start-refuses-base-pair
[ ! -e "$RUN16/coordinator/identity.json" ] ||
  fail "pr-start-refuses-base-pair: a wrong serving pair was frozen"
err | grep -Fq "does not serve PR contract sourceSha $SRC_SHA" ||
  fail "pr-start-refuses-base-pair: refusal did not name the contract SHA"

# The real PR preview pair freezes successfully and records the source binding
# with the identity. If the configured services later move back to the base
# pair, check must report a source mismatch rather than comparing the wrong
# pair to itself and returning ok.
mk dep-fe000000016 live "$SRC_SHA" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000016 live "$SRC_SHA" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run start "$RUN16")" 0 pr-start-preview-pair
jq -e --arg sha "$SRC_SHA" '.expectedSourceSha == $sha and .frontend.commit == $sha and .backend.commit == $sha' "$RUN16/coordinator/identity.json" >/dev/null ||
  fail "pr-start-preview-pair: frozen identity did not record the expected source"
mk dep-fe000000001 live "$A" > "$SMOKE_PAIR_FIXTURE_DIR/fe.json"
mk dep-be000000001 live "$B" > "$SMOKE_PAIR_FIXTURE_DIR/be.json"
expect_rc "$(run check "$RUN16" base-pair-returned)" 3 pr-check-detects-base-pair
out | grep -Fq "base-pair-returned: source-mismatch" ||
  fail "pr-check-detects-base-pair: wrong pair did not report source-mismatch"
tail -1 "$RUN16/coordinator/identity-checks.ndjson" | jq -e --arg sha "$SRC_SHA" '
  .verdict == "source-mismatch" and .expectedSourceSha == $sha
' >/dev/null || fail "pr-check-detects-base-pair: receipt omitted the expected source"
expect_rc "$(run finish "$RUN16")" 3 pr-finish-blocks-source-mismatch
out | grep -Fq "finish: source mismatch" ||
  fail "pr-finish-blocks-source-mismatch: finish did not preserve BLOCKED semantics"

echo "smoke pair identity tests passed"
