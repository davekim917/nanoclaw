#!/usr/bin/env bash
# Tests for smoke-controller-shadow.sh (the shadow series' task-script wrapper).
#
# gh and ncl are fakes on PATH that log every call; git/curl/sqlite3/bun/node
# are traps that must never run. Covers: kill switch, one-time init (a lost
# journal is never re-created), the synthesized claiming wake, input-fetch
# failure -> decision-less fire, budget overrun (a hanging gh), ncl only for a
# bare non-ambiguous dispatch intent, the counterfactual hold, the no-wake last
# line, "no write outside the out-dir", symlinked out-dir / wrapper dir / *.tmp
# / fires.ndjson (and a hard-linked fires.ndjson), config read as data (exit,
# hang and non-literal lines), a hung worker hard-killed inside its budget, and
# budget validation ("08", 0, 1e3, 200, -5 rejected; 110 is the cap).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$SCRIPT_DIR/smoke-controller-shadow.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

unset SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_CRASH_AT SMOKE_CONTROLLER_SHADOW_DIR SMOKE_GATE_STATE_DIR \
  SMOKE_GATE_RUN_ROOT SMOKE_GATE_REPO SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS || true

SHIM="$T/shim"
mkdir -p "$SHIM"
cat >"$SHIM/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE_LOG"
echo '{"wakeAgent":true,"data":{"from":"gh stdout"}}' >&2
case "${FAKE_GH:-ok}" in
  fail) echo "HTTP 502" >&2; exit 1 ;;
  hang) sleep 30; exit 0 ;;
esac
printf '{"headRefOid":"%s","headRefName":"%s"}\n' "${FAKE_HEAD:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" "${FAKE_REF:-feature/x}"
SH
cat >"$SHIM/ncl" <<'SH'
#!/usr/bin/env bash
echo "ncl $*" >>"$FAKE_LOG"
[ "${FAKE_NCL:-ok}" = fail ] && { echo "ncl: command timed out after 30s" >&2; exit 2; }
cat <<'JSON'
{
  "id": "cli-1",
  "ok": true,
  "data": [{"series_id": "ctl-deadbeef-0a1b", "row_id": "task-1", "status": "pending"}]
}
JSON
SH
for cmd in git curl sqlite3 bun node; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"%s"\nexit 97\n' "$cmd" "$T/traps.log" >"$SHIM/$cmd"
done
chmod +x "$SHIM"/*
export PATH="$SHIM:$PATH"
export FAKE_LOG="$T/calls.log"
export HOME="$T/home"
mkdir -p "$HOME"

fail() { echo "FAIL: $*" >&2; exit 1; }

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PR=7
RUN=demo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z

new_case() {
  C="$T/$1"
  mkdir -p "$C/agent/state/runs" "$C/wg/runs" "$C/wg/leases"
  OUT="$C/wg/controller-shadow"
  R="$C/wg/runs/$RUN"
  : >"$FAKE_LOG"
  write_env shadow
}

write_env() { # mode ("" = unset)
  {
    echo 'set -u'
    echo "export SMOKE_GATE_STATE_DIR='$C/agent/state'"
    echo "export SMOKE_GATE_RUN_ROOT='$C/wg/runs'"
    echo "export SMOKE_GATE_LEASE_DIR='$C/wg/leases'"
    echo "export SMOKE_GATE_REPO='acme/app'"
    [ -n "${NO_OUT_DIR:-}" ] || echo "export SMOKE_CONTROLLER_SHADOW_DIR='$OUT'"
    [ -z "${NO_RUN_ROOT:-}" ] || echo "unset SMOKE_GATE_RUN_ROOT"
    # A sourced file that prints must not reach the runner's stdout.
    echo "echo '{\"wakeAgent\":true,\"data\":{\"from\":\"env file\"}}'"
    [ -z "$1" ] || echo "export SMOKE_CONTROLLER_MODE='$1'"
  } >"$C/env.sh"
}

claim() {
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" \
    '{schemaVersion:1,pr:$pr,activeRunId:$run,activeSha:$sha,activeStartedAt:"2026-09-18T10:00:00Z",
      challengerDeadline:"2099-01-01T00:00:00Z",challengerDisposition:null}' >"$C/agent/state/pr-$PR-state.json"
}

finished() { # finishedAt
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" --arg at "$1" \
    '{schemaVersion:1,pr:$pr,activeRunId:null,activeSha:null,completedRunId:$run,completedSha:$sha,
      completedAt:$at,completedVerdict:"GO"}' >"$C/agent/state/pr-$PR-state.json"
  mkdir -p "$C/agent/state/runs/$RUN"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg at "$1" \
    '{schemaVersion:1,sha:$sha,runId:$run,verdict:"GO",finishedAt:$at}' >"$C/agent/state/runs/$RUN/verdict.json"
  jq -cn --arg run "$RUN" --arg sha "$SHA" '{runId:$run,sha:$sha,verdict:"GO"}' >"$C/agent/state/pr-$PR-verdict.json"
}

contract() {
  mkdir -p "$R/markers"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" '{schemaVersion:2,runId:$run,pr:$pr,sourceSha:$sha,
    ownershipKind:"pr",requiredLaneMarkers:["markers/A1.json"],lanes:[{id:"A1",kind:"lane",generation:1}]}' \
    >"$R/completion-contract.json"
}

OUTPUT=""
DATA=""
ELAPSED=0
fire() { # [env assignments...] -- runs the wrapper, checks the output contract
  local s rc
  s="$(date +%s)"
  set +e
  OUTPUT="$(env SMOKE_CONTROLLER_ENV_FILE="$C/env.sh" "$@" bash "$W" 2>"$T/stderr")"
  rc=$?
  set -e
  ELAPSED=$(( $(date +%s) - s ))
  [ "$rc" = 0 ] || fail "wrapper exited $rc (must always be 0): $(tail -5 "$T/stderr")"
  [ "$(printf '%s\n' "$OUTPUT" | wc -l)" = 1 ] || fail "stdout must be exactly one line, got: $OUTPUT"
  printf '%s\n' "$OUTPUT" | jq -e '(keys == ["data","wakeAgent"]) and .wakeAgent == false and (.data | type == "object")' \
    >/dev/null || fail "last line is not {wakeAgent:false,data:{...}}: $OUTPUT"
  DATA="$(printf '%s\n' "$OUTPUT" | jq -c .data)"
}
d() { jq -r "$1" <<<"$DATA"; }
calls() { grep -c "^$1 " "$FAKE_LOG" || true; }
jrn() { jq -s -c "$1" "$OUT/journal.ndjson"; }

# --- kill switch: explicit off does nothing; unset defaults to shadow ------
new_case off
write_env off
fire
[ "$(d .mode)" = off ] && [ "$(d .stepped)" = false ] || fail "SMOKE_CONTROLLER_MODE=off must do nothing: $DATA"
[ ! -e "$OUT" ] || fail "mode off must not create the out-dir"
write_env live
fire
[ "$(d .stepped)" = false ] && d .skipped | grep -q unsupported || fail "an unknown mode is refused: $DATA"
[ ! -s "$FAKE_LOG" ] || fail "mode off/unsupported must call nothing: $(cat "$FAKE_LOG")"

# --- default: unset mode runs shadow -----------------------------------------
new_case default-on
write_env ""
fire
[ "$(d .mode)" = shadow ] && [ "$(d .stepped)" = true ] || fail "unset SMOKE_CONTROLLER_MODE must default to shadow: $DATA"

# --- first fire: init once, no claims, no fetches ----------------------------
new_case init
fire
[ "$(d .stepped)" = true ] && [ "$(d .initialized)" = true ] || fail "first fire inits and steps: $DATA"
[ -f "$OUT/journal.ndjson" ] && [ -f "$OUT/wrapper/initialized" ] || fail "journal + sentinel after first fire"
[ "$(calls gh)" = 0 ] && [ "$(calls ncl)" = 0 ] || fail "no claim, no fetch: $(cat "$FAKE_LOG")"
fire
[ "$(d .initialized)" = null ] && [ "$(d .stepped)" = true ] || fail "init happens once: $DATA"

# --- a lost journal is a hard error, never re-created as empty ----------------
rm "$OUT/journal.ndjson"
fire
[ "$(d .controllerError)" = controller_journal_error ] || fail "missing journal must surface as the controller's journal error: $DATA"
[ ! -e "$OUT/journal.ndjson" ] || fail "the wrapper must not re-init a lost journal"

# --- new claim: synthesized wake, heads fetched, decisions written -----------
new_case claim
claim; contract
fire
[ "$(d .stepped)" = true ] && [ "$(d .newClaimWake)" = "$RUN" ] || fail "new claim is handed over as a wake: $DATA"
[ "$(calls gh)" = 1 ] && grep -q "^gh pr view $PR -R acme/app --json headRefOid,headRefName" "$FAKE_LOG" \
  || fail "one read-only gh pr view per claimed PR: $(cat "$FAKE_LOG")"
jrn "[.[] | select(.kind==\"run\" and .detail.origin==\"poll-wake\" and .detail.isFreezePr==false)] | length == 1" \
  | grep -qx true || fail "claim journaled from the synthesized wake: $(cat "$OUT/journal.ndjson")"
[ -s "$OUT/$RUN/decisions.ndjson" ] || fail "decisions written for the run"
jq -e --arg sha "$SHA" '."7" == $sha' "$OUT/wrapper/inputs/pr-heads.json" >/dev/null || fail "pr heads input"
jq -e '. == {}' "$OUT/wrapper/inputs/receipts.json" >/dev/null || fail "receipts are empty in shadow"
fire
[ "$(d .newClaimWake)" = null ] || fail "an already-journaled claim is not re-woken: $DATA"
[ "$(calls ncl)" = 0 ] || fail "ncl runs only for a bare dispatch intent"

# --- input fetch failure: decision-less fire, exit 0 -------------------------
lines_before="$(wc -l <"$OUT/journal.ndjson")"
dec_before="$(wc -l <"$OUT/$RUN/decisions.ndjson")"
fire FAKE_GH=fail
[ "$(d .stepped)" = false ] && [ "$(d .skipped)" = "input fetch failed" ] && [ "$(d .inputErrors)" = 1 ] \
  || fail "gh failure must skip the step: $DATA"
[ "$(wc -l <"$OUT/journal.ndjson")" = "$lines_before" ] && [ "$(wc -l <"$OUT/$RUN/decisions.ndjson")" = "$dec_before" ] \
  || fail "a decision-less fire writes no journal record or decision"
tail -1 "$OUT/wrapper/fires.ndjson" | jq -e '.skipped == "input fetch failed"' >/dev/null || fail "the skip is logged"

# --- budget overrun: a hanging gh is cut to the budget -----------------------
fire FAKE_GH=hang SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS=8 SMOKE_CONTROLLER_SHADOW_GH_TIMEOUT=100
[ "$ELAPSED" -le 10 ] || fail "fire overran an 8s budget: ${ELAPSED}s"
[ "$(d .stepped)" = false ] && d .log[0] | grep -q "timed out" || fail "hung gh is skipped and logged: $DATA"
# Budget too small for the step: skipped, never started.
fire SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS=12 SMOKE_CONTROLLER_SHADOW_STEP_MIN_SECONDS=30
d .skipped | grep -q "budget too small" || fail "step is skipped when the budget cannot cover it: $DATA"

# --- ncl only for a bare dispatch intent; its failure is decision-less --------
k="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$RUN|dispatch|critic")"
jq -cn --arg run "$RUN" --arg k "$k" '{v:1,at:"2026-09-18T10:05:00Z",fire:"f",runId:$run,kind:"dispatch",slot:"critic",
  key:$k,state:"intent",attempt:1,mode:"shadow"}' >>"$OUT/journal.ndjson"
: >"$FAKE_LOG"
fire
[ "$(calls ncl)" = 1 ] && grep -qx "ncl tasks list --json" "$FAKE_LOG" || fail "bare dispatch intent -> one ncl tasks list: $(cat "$FAKE_LOG")"
jq -e '.[0].name == "ctl-deadbeef-0a1b" and .[0].id == "ctl-deadbeef-0a1b"' "$OUT/wrapper/inputs/tasks.json" >/dev/null \
  || fail "series ids are passed as task names: $(cat "$OUT/wrapper/inputs/tasks.json")"
fire FAKE_NCL=fail
[ "$(d .skipped)" = "input fetch failed" ] || fail "ncl failure is decision-less: $DATA"
# Once the controller has marked the intent ambiguous (smoke-campaign-controller.py:863-866)
# it never reconciles from tasks again, so ncl (and its transport writes) stop.
jq -cn --arg run "$RUN" --arg k "$k" '{v:1,at:"2026-09-18T10:06:00Z",fire:"f",runId:$run,kind:"dispatch",slot:"critic",
  key:$k,state:"intent",attempt:1,mode:"shadow",detail:{ambiguous:true}}' >>"$OUT/journal.ndjson"
: >"$FAKE_LOG"
fire
[ "$(calls ncl)" = 0 ] || fail "an ambiguous intent needs no ncl read: $(cat "$FAKE_LOG")"

# --- counterfactual hold: a just-finished run still looks active -------------
new_case hold
claim; contract
fire
finished "$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
fire
[ "$(d .held)" = 1 ] || fail "a run the gate finished 5 min ago is held: $DATA"
jq -e --arg run "$RUN" '.activeRunId == $run and .challengerDeadline == "2099-01-01T00:00:00Z"' \
  "$OUT/wrapper/gate-view/pr-$PR-state.json" >/dev/null || fail "held run is active in the view"
[ ! -e "$OUT/wrapper/gate-view/runs/$RUN" ] && [ ! -e "$OUT/wrapper/gate-view/pr-$PR-verdict.json" ] \
  || fail "held run's verdict files are withheld from the view"
jrn '[.[] | select(.kind=="run" and .state=="done")] | length == 0' | grep -qx true \
  || fail "controller must not see the held run as finished"
finished "$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ)"
fire
[ "$(d .held)" = 0 ] && [ -f "$OUT/wrapper/gate-view/runs/$RUN/verdict.json" ] || fail "hold expires after 2h: $DATA"
jrn '[.[] | select(.kind=="run" and .state=="done" and .detail.finishedBy=="gate")] | length == 1' | grep -qx true \
  || fail "after the hold the controller records the gate's finish"

# --- containment: nothing outside the out-dir changes ------------------------
new_case contain
claim; contract
snap() { (cd "$C" && find . -path ./wg/controller-shadow -prune -o -printf '%p %s %T@ %m\n' | sort); \
         (cd "$HOME" && find . -printf '%p %s %T@\n' | sort); }
fire
snap >"$T/before"
fire
finished "$(date -u -d '-5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
snap >"$T/before2"
fire
fire FAKE_GH=fail
snap >"$T/after2"
cmp -s "$T/before2" "$T/after2" || fail "a fire wrote outside its out-dir: $(diff "$T/before2" "$T/after2" | head)"
[ ! -e "$C/agent/state/controller-shadow" ] || fail "controller default out-dir must not be used"

# Out-dir inside the gate state dir is refused before anything runs.
new_case overlap
OUT="$C/agent/state/controller-shadow"
write_env shadow
fire
d .skipped | grep -q "overlaps the gate state dir" || fail "out-dir overlapping gate state is refused: $DATA"
[ ! -e "$OUT" ] || fail "refused overlap must not create the out-dir"

# --- symlinks inside or at the out-dir are never followed ---------------------
new_case sym-out
mkdir -p "$C/elsewhere"
ln -s "$C/elsewhere" "$OUT"
fire
d .skipped | grep -q "out-dir refused" || fail "a symlinked out-dir is refused: $DATA"
[ -z "$(ls -A "$C/elsewhere")" ] || fail "nothing is written through a symlinked out-dir: $(ls -A "$C/elsewhere")"
[ "$(calls gh)" = 0 ] || fail "a refused out-dir runs nothing"

new_case sym-wrap
mkdir -p "$C/elsewhere" "$OUT"
ln -s "$C/elsewhere" "$OUT/wrapper"
fire
d .skipped | grep -q "out-dir refused" || fail "a symlinked wrapper dir is refused: $DATA"
[ -z "$(ls -A "$C/elsewhere")" ] || fail "nothing is written through a symlinked wrapper dir"
[ ! -e "$OUT/journal.ndjson" ] || fail "a refused wrapper dir must stop the fire before init"

new_case sym-files
claim; contract
fire
[ "$(d .stepped)" = true ] || fail "setup fire steps: $DATA"
echo victim >"$C/victim"
echo victim >"$C/victim-log"
ln -s "$C/victim" "$OUT/wrapper/inputs/pr-heads.json.tmp"
ln -s "$C/victim" "$OUT/wrapper/claims-seen.json.tmp"
ln -sfn "$C/victim" "$OUT/wrapper/inputs/tasks.json"
mv "$OUT/wrapper/fires.ndjson" "$T/fires.keep"
ln -s "$C/victim-log" "$OUT/wrapper/fires.ndjson"
fire
[ "$(cat "$C/victim")" = victim ] && [ "$(cat "$C/victim-log")" = victim ] \
  || fail "a write followed a planted symlink: $(cat "$C/victim" "$C/victim-log")"
[ "$(d .stepped)" = true ] || fail "planted *.tmp / target symlinks are replaced, not fatal: $DATA"
[ -f "$OUT/wrapper/inputs/pr-heads.json" ] && [ ! -L "$OUT/wrapper/inputs/pr-heads.json" ] \
  && [ ! -L "$OUT/wrapper/inputs/tasks.json" ] || fail "inputs are regular files after the fire"
[ -L "$OUT/wrapper/fires.ndjson" ] && d .fireLogError | grep -qi "refusing" \
  || fail "a symlinked fires.ndjson is refused (not followed, not replaced) and reported: $DATA"
rm "$OUT/wrapper/fires.ndjson"
# A hard link to an outside file is refused too (controller's single-link rule).
ln "$C/victim-log" "$OUT/wrapper/fires.ndjson"
fire
[ "$(cat "$C/victim-log")" = victim ] && d .fireLogError | grep -q "hard links" \
  || fail "a hard-linked fires.ndjson is refused: $DATA"

# --- config is data: exit / hang / non-literal lines cannot take over ---------
new_case cfg-exit
{ echo 'exit 0'; echo 'sleep 300'; echo 'while :; do :; done'; cat "$C/env.sh"; } >"$C/env2.sh"
mv "$C/env2.sh" "$C/env.sh"
fire
[ "$ELAPSED" -le 10 ] || fail "config lines must not execute (took ${ELAPSED}s)"
[ "$(d .mode)" = shadow ] && [ "$(d .stepped)" = true ] || fail "exit/sleep lines are ignored, exports still read: $DATA"
echo 'export SMOKE_GATE_STATE_DIR="$HOME/elsewhere"' >>"$C/env.sh"
fire
[ "$(d .stepped)" = false ] && [ "$(d '.refusedKeys[0]')" = SMOKE_GATE_STATE_DIR ] \
  || fail "a non-literal value for a used key skips the fire: $DATA"

# --- the hard wall clock: a hung worker still ends with the line -------------
new_case hang
fire SMOKE_CONTROLLER_SHADOW_TEST_HANG=1 SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS=8
[ "$ELAPSED" -le 10 ] || fail "a hung worker overran an 8s budget: ${ELAPSED}s"
[ "$(d .skipped)" = "fire exceeded its budget and was killed" ] || fail "hung worker: $DATA"
tail -1 "$OUT/wrapper/fires.ndjson" | jq -e '.skipped == "fire exceeded its budget and was killed"' >/dev/null \
  || fail "the killed fire is logged"
fire SMOKE_CONTROLLER_SHADOW_TEST_HANG=ignore-term SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS=8
[ "$ELAPSED" -le 11 ] || fail "a SIGTERM-proof worker must be SIGKILLed by budget+2: ${ELAPSED}s"
[ "$(d .rc)" = 137 ] && [ "$(d .skipped)" = "fire exceeded its budget and was killed" ] || fail "SIGKILLed worker: $DATA"

# --- budget validation: decimal 1..110 only ----------------------------------
new_case budget
for b in 08 0 1e3 200 -5; do
  fire SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS="$b"
  [ "$(d .budgetRejected)" = "$b" ] && [ "$(d .budgetSeconds)" = 100 ] && [ "$(d .stepped)" = true ] \
    || fail "budget $b must be rejected for the 100s default: $DATA"
  [ "$ELAPSED" -le 100 ] || fail "budget $b fire overran"
done
fire SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS=110
[ "$(d .budgetRejected)" = null ] && [ "$(d .stepped)" = true ] || fail "110 is the accepted cap: $DATA"
grep -q '^BUDGET_MAX=110$' "$W" && grep -q 'timeout -k 2 "\$BUDGET"' "$W" \
  || fail "hard kill must land by 110 + 2 s, under the runner's 120 s"

# --- default out-dir: a sibling of the run root ------------------------------
new_case default-out
NO_OUT_DIR=1 write_env shadow
fire
[ -e "$OUT/journal.ndjson" ] || fail "default out-dir must be <run-root>/../controller-shadow: $DATA"
[ -d "$OUT/wrapper" ] || fail "default out-dir must hold the wrapper dir: $DATA"
new_case no-out
NO_OUT_DIR=1 NO_RUN_ROOT=1 write_env shadow
fire
d .skipped | grep -q "no out-dir" || fail "no out-dir and no run root must skip: $DATA"
[ ! -e "$OUT" ] || fail "a skipped fire with no out-dir must create nothing"

# --- the no-wake guarantee is structural -------------------------------------
# Only final() writes to fd 3 (the runner's stdout), and it renders a literal.
n_fd3="$(grep -c '>&3' "$W")"
[ "$n_fd3" = 2 ] || fail "expected exactly final()'s two fd-3 writes, found $n_fd3"
[ "$(sed -n '/^final() {/,/^}/p' "$W" | grep -c '>&3')" = 2 ] || fail "every fd-3 write must be inside final()"
grep -q "exec 3>&1 1>&2" "$W" || fail "stdout must be moved to fd 3 before anything runs"
! grep -q 'wakeAgent:true\|"wakeAgent": *true\|wakeAgent=true' "$W" || fail "the wrapper must never render wakeAgent true"

[ ! -e "$T/traps.log" ] || fail "a trap command ran: $(cat "$T/traps.log")"
echo "smoke controller shadow wrapper tests passed"
