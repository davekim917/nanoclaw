#!/usr/bin/env bash
# Exercises the campaign verbs against a scratch state dir. No network: every
# assertion below exits before the fetch block, except case 1.
set -u
G=/home/ubuntu/nanoclaw-v2/container/skills/smoke-test/scripts/smoke-develop-gate.sh
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SMOKE_GATE_STATE_DIR="$T/state" SMOKE_GATE_ACTIVE_FILE="$T/run-active.json" \
       SMOKE_GATE_HOLD_FILE="$T/develop-hold.json"
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHB=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FAIL=0
ck(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got [$2] want [$3]"; FAIL=1; fi; }
st(){ jq -r "$1" "$T/state/develop-state.json" 2>/dev/null; }

echo "1. check with no config: settled:false, writes nothing"
printf '{"schemaVersion":1,"sentinel":"untouched"}\n' > "$T/state-probe" 2>/dev/null
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

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$FAIL"
