#!/usr/bin/env bash
# Exercises the campaign verbs against a scratch state dir. No network: every
# assertion below exits before the fetch block, except case 1.
set -u
# Resolve the gate next to THIS file. The old absolute path pointed at the main
# checkout, so running this suite from a worktree silently tested a different
# copy of the script than the one being edited.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G="$SCRIPT_DIR/smoke-develop-gate.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/shared" "$T/bin"
cat >"$T/bin/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
chmod +x "$T/bin/mountpoint"
export SMOKE_GATE_STATE_DIR="$T/state" SMOKE_GATE_ACTIVE_FILE="$T/run-active.json" \
       SMOKE_GATE_HOLD_FILE="$T/develop-hold.json" \
       SMOKE_GATE_SHARED_ROOT="$T/shared" \
       SMOKE_GATE_LEASE_DIR="$T/shared/qa-coordinator/leases"
export PATH="$T/bin:$PATH"
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHB=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FAIL=0
ck(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got [$2] want [$3]"; FAIL=1; fi; }
st(){ jq -r "$1" "$T/state/develop-state.json" 2>/dev/null; }

echo "1. check with no config: settled:false, writes nothing"
mkdir -p "$T/state"; echo '{"schemaVersion":1,"completedSha":"sentinel"}' > "$T/state/develop-state.json"
OUT="$(bash "$G" check 2>/dev/null)"
ck "settled=false"      "$(jq -r '.data.settled' <<<"$OUT")" "false"
ck "state untouched"    "$(st '.completedSha')"               "sentinel"

echo "2. claim on a free slot"
echo '{"schemaVersion":1}' > "$T/state/develop-state.json"
OUT="$(bash "$G" claim camp-1 "$SHA")"
ck "ok"                 "$(jq -r '.ok' <<<"$OUT")"            "true"
ck "activeRunId"        "$(st '.activeRunId')"                "camp-1"
ck "activeSha"          "$(st '.activeSha')"                  "$SHA"
ck "merge-hold written" "$([ -f "$T/run-active.json" ] && echo yes)" "yes"
ck "no hold raised"     "$([ -f "$T/develop-hold.json" ] && echo yes || echo no)" "no"
ck "no verdict written" "$(st '.completedSha')"               "null"

echo "3. progress works once claimed (the whole point)"
ck "progress ok"        "$(bash "$G" progress camp-1 | jq -r '.ok')" "true"
ck "stamp recorded"     "$([ "$(st '.activeProgressAt')" != "null" ] && echo yes)" "yes"

echo "4. a second run cannot stomp a live claim"
OUT="$(bash "$G" claim camp-2 "$SHB")"
ck "refused"            "$(jq -r '.ok' <<<"$OUT")"            "false"
ck "names the holder"   "$(jq -r '.activeRunId' <<<"$OUT")"   "camp-1"
ck "slot unchanged"     "$(st '.activeRunId')"                "camp-1"

echo "5. progress from a non-active run is refused"
ck "refused"            "$(bash "$G" progress camp-2 | jq -r '.ok')" "false"

echo "6. release requires the right id"
ck "wrong id refused"   "$(bash "$G" release camp-2 | jq -r '.ok')" "false"
ck "still held"         "$(st '.activeRunId')"                "camp-1"
OUT="$(bash "$G" release camp-1)"
ck "released"           "$(jq -r '.ok' <<<"$OUT")"            "true"
ck "slot cleared"       "$(st '.activeRunId')"                "null"
ck "active file gone"   "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "no"
ck "no hold raised"     "$([ -f "$T/develop-hold.json" ] && echo yes || echo no)" "no"

echo "7. release never clears another run's hold"
echo '{"schemaVersion":1,"sha":"x","runId":"scheduled-9","verdict":"NO_GO"}' > "$T/develop-hold.json"
bash "$G" claim camp-3 "$SHA" >/dev/null
bash "$G" release camp-3 >/dev/null
ck "hold survives"      "$(jq -r '.runId' "$T/develop-hold.json")" "scheduled-9"
rm -f "$T/develop-hold.json"

echo "8. merge-hold opt-out suppresses the watcher but not the queue"
bash "$G" claim camp-4 "$SHA" false >/dev/null
ck "slot held"          "$(st '.activeRunId')"                "camp-4"
ck "no active file"     "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "no"
bash "$G" release camp-4 >/dev/null

echo "9. argument validation"
bash "$G" claim camp-5 not-a-sha >/dev/null 2>&1; ck "bad sha exit 2" "$?" "2"
bash "$G" claim "" "$SHA" >/dev/null 2>&1;        ck "no id exit 2"  "$?" "2"
ck "bad merge-hold"     "$(bash "$G" claim camp-5 "$SHA" maybe 2>/dev/null | jq -r '.ok')" "false"
ck "unknown verb"       "$(bash "$G" wat 2>/dev/null | jq -r '.error')" "unknown command: wat"

echo "10. a stale claim is reclaimable (dead container must not wedge the gate)"
jq -c --arg s "$SHA" '{schemaVersion:1,activeRunId:"dead-1",activeSha:$s,
  activeStartedAt:"2020-01-01T00:00:00Z",activeProgressAt:"2020-01-01T00:00:00Z"}' \
  -n > "$T/state/develop-state.json"
ck "reclaimed"          "$(bash "$G" claim camp-6 "$SHB" | jq -r '.ok')" "true"
ck "new owner"          "$(st '.activeRunId')"                "camp-6"

echo "11. merge-hold opt-out SURVIVES progress (regression: the stamp used to resurrect it)"
echo '{"schemaVersion":1}' > "$T/state/develop-state.json"; rm -f "$T/run-active.json"
bash "$G" claim camp-7 "$SHA" false >/dev/null
ck "absent after claim"  "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "no"
OUT="$(bash "$G" progress camp-7)"
ck "progress ok"         "$(jq -r '.ok' <<<"$OUT")"           "true"
ck "reports hold off"    "$(jq -r '.mergeHold' <<<"$OUT")"    "false"
ck "STILL absent"        "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "no"
ck "stamp still taken"   "$([ "$(st '.activeProgressAt')" != "null" ] && echo yes)" "yes"
bash "$G" release camp-7 >/dev/null

echo "12. merge-hold ON still refreshes the active file on every stamp"
bash "$G" claim camp-8 "$SHA" >/dev/null; rm -f "$T/run-active.json"
ck "reports hold on"     "$(bash "$G" progress camp-8 | jq -r '.mergeHold')" "true"
ck "refreshed"           "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "yes"
bash "$G" release camp-8 >/dev/null

echo "13. finish is refused for a non-active run (reclaimed run cannot clobber its successor)"
echo '{"schemaVersion":1,"sha":"x","runId":"scheduled-9","verdict":"NO_GO"}' > "$T/develop-hold.json"
bash "$G" claim live-2 "$SHB" >/dev/null
OUT="$(bash "$G" finish "$SHA" stale-1 GO)"
ck "refused"             "$(jq -r '.ok' <<<"$OUT")"           "false"
ck "no verdict recorded" "$(st '.completedSha')"              "null"
ck "hold NOT cleared"    "$(jq -r '.runId' "$T/develop-hold.json")" "scheduled-9"
ck "live slot intact"    "$(st '.activeRunId')"               "live-2"

echo "14. finish by the active run still works, and clears its own slot"
OUT="$(bash "$G" finish "$SHB" live-2 GO)"
ck "accepted"            "$(jq -r '.ok' <<<"$OUT")"           "true"
ck "verdict recorded"    "$(st '.completedSha')"              "$SHB"
ck "slot cleared"        "$(st '.activeRunId')"               "null"
ck "own GO cleared hold" "$([ -f "$T/develop-hold.json" ] && echo yes || echo no)" "no"
ck "merge-hold nulled"   "$(st '.activeMergeHold')"           "null"

echo "15. legacy state with no activeMergeHold field defaults to holding"
jq -c --arg s "$SHA" --arg n "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,activeRunId:"legacy-1",activeSha:$s,activeStartedAt:$n,activeProgressAt:$n}' \
  -n > "$T/state/develop-state.json"
rm -f "$T/run-active.json"
ck "defaults to hold"    "$(bash "$G" progress legacy-1 | jq -r '.mergeHold')" "true"
ck "active file written" "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "yes"

# The check SUCCESS path needs the network. Stub gh/curl on PATH so the settled
# derivation and the output shape are exercised deterministically instead of
# resting on one manual live run.
BIN="$T/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"pr list"*)
    # Lock probe for freeze_status: by the time the advisory fan-out runs, the
    # caller has finished every state write, so the lock must be free.
    if [ -n "${LOCK_PROBE:-}" ]; then
      ( flock -n 6 && printf 'free' || printf 'held' ) 6>"$LOCK_PROBE_FILE" > "$LOCK_PROBE"
    fi
    printf '' ;;
  *branches*)  [ -n "${FAKE_FETCH_DELAY:-}" ] && sleep "$FAKE_FETCH_DELAY"
               jq -cn --arg s "$FAKE_SOURCE" '{commit:{sha:$s}}' ;;
  *"run list"*) cat "$FAKE_CHECKS" ;;
  *compare*)   jq -cn '{status:"ahead",behind_by:0,files:[{filename:"XZO-BACKEND/src/x.ts"}]}' ;;
esac
SH
cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"$FAKE_BACKEND_ID"*)  jq -cn --arg s "$FAKE_BACKEND"  '[{deploy:{status:"live",commit:{id:$s}}}]' ;;
  *"$FAKE_FRONTEND_ID"*) jq -cn --arg s "$FAKE_FRONTEND" '[{deploy:{status:"live",commit:{id:$s}}}]' ;;
esac
SH
chmod +x "$BIN/gh" "$BIN/curl"
export PATH="$BIN:$PATH"
export SMOKE_GATE_REPO=o/r SMOKE_GATE_BACKEND_SERVICE=srv-be SMOKE_GATE_FRONTEND_SERVICE=srv-fe \
       SMOKE_GATE_DEV_URL=https://dev.example SMOKE_GATE_FRONTEND_PATHS=XZO-FRONTEND/ \
       FAKE_BACKEND_ID=srv-be FAKE_FRONTEND_ID=srv-fe
export FAKE_SOURCE="$SHA" FAKE_BACKEND="$SHA" FAKE_FRONTEND="$SHA" FAKE_CHECKS="$T/checks.json"

echo "16. check success path: three-way equality, CI green"
jq -cn --arg s "$SHA" '[{headSha:$s,status:"completed",conclusion:"success",workflowName:"CI"}]' > "$T/checks.json"
echo '{"schemaVersion":1,"completedSha":"sentinel"}' > "$T/state/develop-state.json"
rm -f "$T/run-active.json"   # case 15's stamp wrote it; check must not
OUT="$(bash "$G" check)"
ck "settled"             "$(jq -r '.settled' <<<"$OUT")"      "true"
ck "ok"                  "$(jq -r '.ok' <<<"$OUT")"           "true"
ck "sourceSha echoed"    "$(jq -r '.sourceSha' <<<"$OUT")"    "$SHA"
ck "ciReady"             "$(jq -r '.ciReady' <<<"$OUT")"      "true"
ck "deployReady"         "$(jq -r '.deployReady' <<<"$OUT")"  "true"
ck "state untouched"     "$(st '.completedSha')"              "sentinel"
ck "no active file"      "$([ -f "$T/run-active.json" ] && echo yes || echo no)" "no"

echo "17. check refuses a head with a pending check"
jq -cn --arg s "$SHA" '[{headSha:$s,status:"completed",conclusion:"success",workflowName:"CI"},
                        {headSha:$s,status:"in_progress",conclusion:null,workflowName:"E2E"}]' > "$T/checks.json"
OUT="$(bash "$G" check)"
ck "not settled"         "$(jq -r '.settled' <<<"$OUT")"      "false"
ck "pending counted"     "$(jq -r '.pendingChecks' <<<"$OUT")" "1"

echo "18. check refuses a head where every workflow was path-skipped"
jq -cn --arg s "$SHA" '[{headSha:$s,status:"completed",conclusion:"skipped",workflowName:"CI"}]' > "$T/checks.json"
ck "not settled"         "$(bash "$G" check | jq -r '.settled')" "false"

echo "19. check accepts a provably-safe frontend deploy lag"
jq -cn --arg s "$SHA" '[{headSha:$s,status:"completed",conclusion:"success",workflowName:"CI"}]' > "$T/checks.json"
FAKE_FRONTEND="$SHB" bash "$G" check > "$T/lag.json"
ck "settled"             "$(jq -r '.settled' "$T/lag.json")"  "true"
ck "lag recorded"        "$(jq -r '.deployLagAccepted.frontend' "$T/lag.json")" "true"

echo "20. check does NOT hold the write lock across its fetches"
( flock -x 9; sleep 3 ) 9>"$T/state/develop-state.lock" &
BLOCKER=$!; sleep 0.3
ck "check still answers"  "$(bash "$G" check | jq -r '.settled')" "true"
wait $BLOCKER

# F1. Losing the lock must never read as losing the slot. A `progress` stamp
# that collides with a busy poll used to emit a bare ok:false with no error
# field, which the skill's stop rule could not tell apart from "you were
# reclaimed" — so a transient contention miss killed healthy campaigns.
echo "21. a lock-busy refusal is RETRYABLE and names itself, not a lost slot"
echo '{"schemaVersion":1}' > "$T/state/develop-state.json"
bash "$G" claim camp-lock "$SHA" >/dev/null
( flock -x 9; sleep 3 ) 9>"$T/state/develop-state.lock" &
BLOCKER=$!; sleep 0.3
OUT="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$G" progress camp-lock)"
wait $BLOCKER
ck "retryable"           "$(jq -r '.retryable' <<<"$OUT")"       "true"
ck "greppable error"     "$(jq -r '.error | startswith("gate_lock_busy:")' <<<"$OUT")" "true"
ck "says do not stop"    "$(jq -r '.error | test("do not stop the campaign")' <<<"$OUT")" "true"
ck "no spurious wake"    "$(jq -r '.wakeAgent' <<<"$OUT")"       "false"
ck "slot untouched"      "$(st '.activeRunId')"                  "camp-lock"
# ...and the terminal refusal it must be distinguishable FROM carries neither.
OUT="$(bash "$G" progress camp-nope)"
ck "not-active: no retry" "$(jq -r '.retryable // "absent"' <<<"$OUT")" "absent"
ck "not-active: ok false" "$(jq -r '.ok' <<<"$OUT")"             "false"

echo "22. a scheduled poll's FETCH window must not starve a progress stamp"
# Case 20 proves `check` releases the lock; this proves the verb that actually
# collides with a coordinator does too. A poll is put mid-fetch (the gh stub
# stalls) and a mandatory `progress` stamp with a 1s patience must still get
# through. Before the fix the poll held the lock for the whole fetch and the
# stamp came back ok:false — which the skill's stop rule read as "reclaimed".
jq -c --arg s "$SHA" --arg n "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,activeRunId:"camp-poll",activeSha:$s,activeStartedAt:$n,activeProgressAt:$n}' \
  -n > "$T/state/develop-state.json"
FAKE_FETCH_DELAY=3 bash "$G" poll >/dev/null 2>&1 &
POLLER=$!; sleep 1
OUT="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$G" progress camp-poll)"
wait $POLLER
ck "stamp not starved"   "$(jq -r '.ok' <<<"$OUT")"              "true"
ck "no lock-busy error"  "$(jq -r '.error // "none"' <<<"$OUT")" "none"

echo "23. F4: holdMergesUntil rides the LAST progress stamp, not the run start"
# A campaign is documented at 1-3h with a 90m default hold, so anchoring to the
# original start advertised an EXPIRED hold at minute 91 of a healthy, stamping
# run — the merge queue silently released mid-campaign.
jq -c --arg s "$SHA" '{schemaVersion:1,activeRunId:"long-1",activeSha:$s,
  activeStartedAt:"2020-01-01T00:00:00Z",activeProgressAt:"2020-01-01T00:00:00Z",
  activeMergeHold:true}' -n > "$T/state/develop-state.json"
rm -f "$T/run-active.json"
bash "$G" progress long-1 >/dev/null
HOLD_UNTIL="$(jq -r '.holdMergesUntil' "$T/run-active.json")"
ck "hold is in the future" \
  "$([ "$(date -u -d "$HOLD_UNTIL" +%s)" -gt "$(date -u +%s)" ] && echo yes || echo no)" "yes"
ck "startedAt still original" "$(jq -r '.startedAt' "$T/run-active.json")" "2020-01-01T00:00:00Z"

echo "24. freeze_status does NOT run its POST fan-out under the state lock"
# The single longest thing the gate does: one list call plus up to 100 status
# POSTs at 6s each. It is called from claim/progress/release/finish/poll, always
# AFTER the last state write, so holding the lock across it bought nothing and
# starved the mandatory progress stamp.
echo '{"schemaVersion":1}' > "$T/state/develop-state.json"
export SMOKE_GATE_FREEZE_STATUS_CONTEXT=qa/freeze \
       LOCK_PROBE="$T/freeze-probe.txt" LOCK_PROBE_FILE="$T/state/develop-state.lock"
bash "$G" claim camp-fs "$SHA" >/dev/null
ck "lock free during fan-out" "$(cat "$T/freeze-probe.txt" 2>/dev/null)" "free"
rm -f "$T/freeze-probe.txt"
bash "$G" progress camp-fs >/dev/null
ck "same on the stamp path"   "$(cat "$T/freeze-probe.txt" 2>/dev/null)" "free"
bash "$G" release camp-fs >/dev/null
unset SMOKE_GATE_FREEZE_STATUS_CONTEXT LOCK_PROBE LOCK_PROBE_FILE

echo "25. the poll's post-fetch write must PRESERVE a stamp that landed mid-fetch"
# Releasing the lock across the fetch is only safe because every writer after it
# re-reads state. Without the re-read the poll writes back its pre-fetch
# snapshot and silently erases the liveness stamp a coordinator took while the
# poll was on the network — the run then looks stale and gets reclaimed.
export FAKE_SOURCE="$SHB" FAKE_BACKEND="$SHB" FAKE_FRONTEND="$SHB"
jq -cn --arg s "$SHB" '[{headSha:$s,status:"completed",conclusion:"success",workflowName:"CI"}]' > "$T/checks.json"
jq -c --arg s "$SHA" --arg n "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,activeRunId:"camp-race",activeSha:$s,activeStartedAt:$n,activeProgressAt:$n}' \
  -n > "$T/state/develop-state.json"
FAKE_FETCH_DELAY=3 bash "$G" poll >"$T/poll-out.json" 2>/dev/null &
POLLER=$!; sleep 1
bash "$G" progress camp-race >/dev/null
STAMP="$(st '.activeProgressAt')"
wait $POLLER
ck "poll saw the active run" "$(jq -r '.data.trigger' "$T/poll-out.json")" "queued_behind_active_run"
ck "stamp survived the poll" "$(st '.activeProgressAt')"  "$STAMP"
ck "slot survived the poll"  "$(st '.activeRunId')"       "camp-race"

echo "26. ...and a CLAIM landing mid-fetch is not overwritten by the poll"
# The other interleaving: an empty slot at fetch time, taken by a human claim
# before the poll reaches its state phase. A poll writing back its pre-fetch
# snapshot would issue its OWN run id over the fresh claim — two coordinators
# on one environment, which is the failure the whole slot mechanism exists for.
echo '{"schemaVersion":1}' > "$T/state/develop-state.json"
rm -f "$T/run-active.json"
FAKE_FETCH_DELAY=3 bash "$G" poll >"$T/poll-out2.json" 2>/dev/null &
POLLER=$!; sleep 1
bash "$G" claim camp-claimed "$SHB" >/dev/null
wait $POLLER
ck "poll deferred"           "$(jq -r '.data.trigger' "$T/poll-out2.json")" "already_active"
ck "claim not overwritten"   "$(st '.activeRunId')"     "camp-claimed"
ck "no rival wake"           "$(jq -r '.wakeAgent' "$T/poll-out2.json")"    "false"
bash "$G" release camp-claimed >/dev/null

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$FAIL"
