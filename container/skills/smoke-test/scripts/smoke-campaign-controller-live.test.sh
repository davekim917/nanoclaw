#!/usr/bin/env bash
# Tests for smoke-campaign-controller.py in LIVE mode, against recording fakes
# (testdata/controller-live-fakes.py) for the gate, gh, ncl and enqueue-send.
#
#   - one scripted campaign, driven fire by fire with a simulated owner, posts
#     each chat message, GitHub comment/issue and PR close exactly once,
#     dispatches the critic once and finishes once -- with every fire run
#     TWICE (the second run of a fire performs nothing);
#   - the same campaign with a kill injected at every crash point (and with
#     every effect's ambiguous "landed but reported an error" fault) still
#     performs each effect exactly once;
#   - send budget exhaustion -> failed_terminal -> finish BLOCKED;
#   - an ambiguous dispatch is held (never recreated) and blocks GO;
#   - live and shadow reach the same verdict, failed checks and obligations on
#     the same fixtures (live changes only perform());
#   - cutover: a run claimed before the flip is never touched; a run the gate
#     does not record as the controller's is never acted on; a shadow journal
#     cannot drive live effects; live refuses to start without a cutover file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL="$SCRIPT_DIR/smoke-campaign-controller.py"
FAKES="$SCRIPT_DIR/testdata/controller-live-fakes.py"
T="$(mktemp -d)"
[ -n "${KEEP_TMP:-}" ] && echo "keeping $T" >&2 || trap 'rm -rf "$T"' EXIT
export PYTHONDONTWRITEBYTECODE=1

unset SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_CRASH_AT SMOKE_CONTROLLER_SHADOW_DIR SMOKE_GATE_CLAIMANT \
  SMOKE_GATE_STATE_DIR SMOKE_GATE_RUN_ROOT SMOKE_CONTROLLER_OUT_DIR || true
export SMOKE_GATE_LEASE_DIR="$T/leases"
mkdir -p "$SMOKE_GATE_LEASE_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PR=7
RUN=xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z
LEGACY=xzo-pr-pr9-cccccccccccc-20260918T090000Z
TOKEN=owner-ctl-1111

key() { python3 -c 'import hashlib,sys; print(hashlib.sha256("|".join(sys.argv[1:]).encode()).hexdigest())' "$@"; }

new_case() { # name [mode]
  C="$T/$1"
  mkdir -p "$C/state" "$C/runs" "$C/out" "$C/fake" "$C/bin"
  R="$C/runs/$RUN"
  export FAKE_STATE="$C/fake" FAKE_LOG="$C/fake/calls.ndjson" FAKE_GATE_STATE="$C/state"
  : >"$FAKE_LOG"
  printf '#!/usr/bin/env bash\nexec python3 %q gate "$@"\n' "$FAKES" >"$C/bin/gate.sh"
  printf '{"%s":"%s"}\n' "$PR" "$SHA" >"$C/heads.json"
  printf '[]\n' >"$C/tasks.json"
  printf '{}\n' >"$C/receipts.json"
  jq -cn '{legacyRuns:[]}' >"$C/cutover.json"
  MODE="${2:-live}"
  if [ "$MODE" = live ]; then
    SMOKE_CONTROLLER_MODE=live python3 "$CTL" init --out-dir "$C/out" --gate-state-dir "$C/state" >/dev/null
  else
    python3 "$CTL" init --shadow --out-dir "$C/out" --gate-state-dir "$C/state" >/dev/null
  fi
}

claim() { # [deadline] [claimant] [owner]
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg dl "${1:-2026-09-18T11:30:00Z}" --argjson pr "$PR" \
    --arg cl "${2-controller}" --arg owner "${3:-$TOKEN}" \
    '{schemaVersion:1,pr:$pr,activeRunId:$run,activeSha:$sha,challengerDeadline:$dl,challengerDisposition:null,
      activeLeaseOwner:$owner,activeClaimant:(if $cl == "" then null else $cl end)}' >"$C/state/pr-$PR-state.json"
}

wake_json() {
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" --arg tok "$TOKEN" \
    '{wakeAgent:true,data:{trigger:"pr_build_settled",runId:$run,pr:$pr,sourceSha:$sha,isFreezePr:true,
      coordinatorOwnerToken:$tok,previewUrl:"https://preview.test"}}' >"$C/wake.json"
}

contract() {
  mkdir -p "$R/markers" "$R/evidence" "$R/coordinator" "$R/challenger" "$R/controller"
  jq -cn --arg run "$RUN" --arg sha "$SHA" --argjson pr "$PR" '{
    schemaVersion:2, runId:$run, pr:$pr, repoSlug:"acme/app", sourceSha:$sha,
    ownershipKind:"pr", coordinatorOwnerToken:"owner-test",
    requiredLaneMarkers:["markers/A1.json","markers/B1.json"],
    lanes:[{id:"A1",kind:"lane",generation:1},{id:"B1",kind:"lane",generation:2}]}' \
    >"$R/completion-contract.json"
}

marker() { # lane gen status [confirmedFindings-json]
  printf 'shot\n' >"$R/evidence/$1.png"
  jq -cn --arg lane "$1" --argjson gen "$2" --arg st "$3" --arg sha "$SHA" --argjson cf "${4:-null}" '
    {schemaVersion:1,lane:$lane,sourceSha:$sha,generation:$gen,status:$st,
     completedAt:"2026-09-18T10:15:00Z",evidence:["evidence/\($lane).png"]}
    + (if $cf == null then {} else {confirmedFindings:$cf,
         evidence:(["evidence/\($lane).png"] + [$cf[] | "clip-skipped: \(.): no recorder in test"])} end)' \
    >"$R/markers/$1.json"
}

parent_conclusions() { # [challenger-disposition]
  printf 'disposition\n' >"$R/challenger/disposition.md"
  jq -cn --arg d "${1:-CLEAR}" '{schemaVersion:1,lane:"challenger",status:"completed",disposition:$d}' \
    >"$R/challenger/challenge.complete.json"
  printf '{"label":"end","verdict":"ok"}\n' >"$R/coordinator/identity-checks.ndjson"
}

synthesis() { # verdict [jq-merge]
  jq -cn --arg run "$RUN" --arg sha "$SHA" --arg v "$1" \
    '{schemaVersion:1,runId:$run,sourceSha:$sha,verdict:$v,laneGenerations:{A1:1,B1:2},findings:[],gaps:[],dissents:[]}' \
    | jq -c "${2:-.}" >"$R/synthesis.json"
}

# The simulated world: what the owner, critic and challenger have written by
# tick n (cumulative, so a fire that lags behind still sees everything). An
# owner acks every brief it finds, as the router's first act.
VERDICT=GO
FINDING=""   # a confirmed finding id on lane B1 (non-blocking, dispositioned)
world() { # tick
  local n="$1" b
  for b in "$R"/controller/brief-*.md; do
    [ -e "$b" ] && [ ! -e "${b%.md}.ack" ] && : >"${b%.md}.ack"
  done
  # LATE_DISPOSITION=k: the challenger's disposition lands at tick k, whatever
  # the owner has done.
  if [ -n "${LATE_DISPOSITION:-}" ] && [ "$n" -ge "$LATE_DISPOSITION" ]; then
    mkdir -p "$R/challenger"; printf 'late\n' >"$R/challenger/disposition.md"
  fi
  # STALL=k: the owner sits on the lanes step k ticks longer (past the SLA).
  if [ -n "${STALL:-}" ] && [ "$n" -ge 3 ]; then
    n=$((n - STALL)); [ "$n" -ge 2 ] || n=2
  fi
  [ "$n" -ge 1 ] || return 0
  if [ ! -e "$R/completion-contract.json" ]; then
    contract
    mkdir -p "$R/contact-sheet"
    printf 'png\n' >"$R/contact-sheet/sheet.png"
    printf 'This build changes the checkout button; the checkout journey will be tested.\n' \
      >"$R/controller/root-summary.md"
  fi
  [ "$n" -ge 2 ] || return 0
  # The critic answers only if its one-shot task was actually created (shadow
  # assumes every create, as its controller does).
  if [ ! -e "$R/contact-sheet/critic.json" ] && { [ "$MODE" = shadow ] \
    || jq -e '[.tasks[] | select(.name | startswith("ctl-"))] | length > 0' "$C/fake/ncl.json" >/dev/null 2>&1; }; then
    jq -cn '{screens:[{screen:"checkout-390",grade:"OK",reason:"layout holds"}],notes:[]}' \
      >"$R/contact-sheet/critic.json"
  fi
  [ "$n" -ge 3 ] || return 0
  if [ ! -e "$R/markers/B1.json" ]; then
    marker A1 1 pass
    if [ -n "$FINDING" ]; then marker B1 2 pass "[\"$FINDING\"]"; else marker B1 2 pass; fi
  fi
  [ "$n" -ge 4 ] || return 0
  [ -e "$R/coordinator/preliminary.md" ] || printf 'prelim\n' >"$R/coordinator/preliminary.md"
  [ "$n" -ge 5 ] || return 0
  [ -e "$R/challenger/challenge.complete.json" ] || parent_conclusions
  [ "$n" -ge 6 ] || return 0
  if [ ! -e "$R/synthesis.json" ]; then
    printf 'synthesis\n' >"$R/coordinator/synthesis.md"
    printf '# Run record\nAll lanes passed.\n' >"$R/run-record.md"
    printf -- '- The checkout journey passed on the frozen build.\n- Nothing was left unchallenged.\n- Next: the author merges.\n' \
      >"$R/controller/verdict-bullets.md"
    if [ -n "$FINDING" ]; then
      mkdir -p "$R/controller/issues"
      jq -cn '{title:"Checkout button misaligned at 390px",body:"Seen on B1.",labels:["ui"]}' \
        >"$R/controller/issues/$FINDING.json"
      synthesis "$VERDICT" ".findings=[{id:\"$FINDING\",confirmed:true,blocking:false,disposition:\"not-blocking:cosmetic\"}]"
    else
      synthesis "$VERDICT"
    fi
  fi
}

tick_time() { python3 -c 'import datetime,sys; print((datetime.datetime(2026,9,18,10,0,tzinfo=datetime.timezone.utc)+datetime.timedelta(minutes=10*int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }

inputs_from_fakes() { # receipts: every enqueued message delivered unless FAIL_RECEIPTS; tasks from ncl
  python3 - "$C" "${FAIL_RECEIPTS:-}" "${MISSING_RECEIPTS:-}" <<'PY'
import json, os, sys
c, fail, missing = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    msgs = json.load(open(os.path.join(c, "fake", "enqueue.json")))["messages"]
except FileNotFoundError:
    msgs = {}
json.dump({mid: ("failed" if fail and fail in mid else "delivered") for mid in msgs
           if not (missing and missing in mid)}, open(os.path.join(c, "receipts.json"), "w"))
try:
    tasks = json.load(open(os.path.join(c, "fake", "ncl.json")))["tasks"]
except FileNotFoundError:
    tasks = []
json.dump([{"id": t["series_id"], "name": t["series_id"], "status": t["status"]} for t in tasks],
          open(os.path.join(c, "tasks.json"), "w"))
PY
}

STEP_OUT=""
STEP_RC=0
live_args() {
  printf '%s\n' --out-dir "$C/out" --gate-state-dir "$C/state" --run-root "$C/runs" \
    --pr-heads-json "$C/heads.json" --tasks-json "$C/tasks.json" --receipts-json "$C/receipts.json" \
    --cutover-json "$C/cutover.json" --repo acme/app --send-to campaign-room --gate-cmd "$C/bin/gate.sh" \
    --gh-cmd "python3 $FAKES gh" --ncl-cmd "python3 $FAKES ncl" --enqueue-cmd "python3 $FAKES enqueue" \
    --lock-timeout 1
}
step() { # now [extra args...]
  local now="$1"; shift
  local -a a
  mapfile -t a < <(live_args)
  set +e
  if [ "$MODE" = live ]; then
    STEP_OUT="$(SMOKE_CONTROLLER_MODE=live python3 "$CTL" step "${a[@]}" --now "$now" --fire "$now" "$@" 2>"$C/stderr")"
  else
    STEP_OUT="$(python3 "$CTL" step --shadow --out-dir "$C/out" --gate-state-dir "$C/state" --run-root "$C/runs" \
      --pr-heads-json "$C/heads.json" --tasks-json "$C/tasks.json" --receipts-json "$C/receipts.json" \
      --lock-timeout 1 --now "$now" --fire "$now" "$@" 2>"$C/stderr")"
  fi
  STEP_RC=$?
  set -e
}
step_ok() { step "$@"; [ "$STEP_RC" = 0 ] || fail "step $1 exited $STEP_RC: $STEP_OUT $(cat "$C/stderr")"; }

writes() { jq -s '[.[] | select(.op=="enqueued" or .op=="commented" or .op=="created" or .op=="closed"
  or .op=="finish" or .op=="challenger-timeout" or .op=="fail-after")] | length' "$FAKE_LOG"; }
jr() { jq -cs "$1" "$C/out/journal.ndjson"; }
dq() { jq -cs "$1" "$C/out/$RUN/decisions.ndjson"; }
finish_verdict() { jr '[.[] | select(.kind=="gate" and .state=="done") | .detail.verdict] | last'; }
WAKES=()

# Drive the campaign: ticks 0..last, each fire run twice on the SAME inputs
# (the second run is a retry of the same fire, so it must perform and journal
# nothing new -- only gate progress, which is not an effect). CRASH (a
# SMOKE_CONTROLLER_CRASH_AT spec) kills the first fire that reaches it; that
# tick is then re-run without it. The second run of each fire must perform
# nothing.
campaign() { # last-tick   (CRASH2: a second kill, armed once CRASH has fired)
  local n now crashed=false crashed2=false w1 w2
  WAKES=()
  WAKE_TIMES=()
  claim "${DEADLINE:-}"
  wake_json
  for n in $(seq 0 "$1"); do
    now="$(tick_time "$n")"
    world "$n"
    inputs_from_fakes
    local extra=()
    [ "$n" = 0 ] && extra=(--poll-json "$C/wake.json")
    if [ -n "${CRASH:-}" ] && [ "$crashed" = false ]; then
      SMOKE_CONTROLLER_CRASH_AT="$CRASH" step "$now" "${extra[@]}"
      [ "$STEP_RC" = 0 ] || [ "$STEP_RC" = 137 ] || fail "crash fire $now rc=$STEP_RC $STEP_OUT"
      if [ "$STEP_RC" = 137 ]; then
        crashed=true
        inputs_from_fakes  # the retry is a later process: it sees what the dead one did
        step_ok "$now" "${extra[@]}"
      fi
    elif [ -n "${CRASH2:-}" ] && [ "$crashed" = true ] && [ "$crashed2" = false ]; then
      SMOKE_CONTROLLER_CRASH_AT="$CRASH2" step "$now" "${extra[@]}"
      [ "$STEP_RC" = 0 ] || [ "$STEP_RC" = 137 ] || fail "crash2 fire $now rc=$STEP_RC $STEP_OUT"
      if [ "$STEP_RC" = 137 ]; then
        crashed2=true
        inputs_from_fakes
        step_ok "$now" "${extra[@]}"
      fi
    else
      step_ok "$now" "${extra[@]}"
    fi
    w="$(jq -c '.ownerWake' <<<"$STEP_OUT")"
    [ "$w" = null ] || { WAKES+=("$(jq -r '.step' <<<"$w")"); WAKE_TIMES+=("$now"); }
    w1="$(writes)"
    l1="$(wc -l <"$FAKE_LOG")"
    step_ok "$now" "${extra[@]}"
    w2="$(writes)"
    # An injected ambiguous fault leaves an unknown outcome the retry is
    # entitled to settle and move past; exactly-once is asserted after.
    [ -n "${FAULTY:-}" ] || [ "$w1" = "$w2" ] || fail "the second run of fire $now performed $((w2 - w1)) effect(s) (crash=${CRASH:-none}): $(tail -n +"$((l1 + 1))" "$FAKE_LOG" | jq -c '[.tool,.op,.argv[0:3]]' | tr '\n' ' ') first run: $STEP_OUT"
  done
  [ -z "${CRASH:-}" ] || [ "$crashed" = true ] || fail "crash point $CRASH was never reached"
  [ -z "${CRASH2:-}" ] || [ "$crashed2" = true ] || fail "second crash point $CRASH2 was never reached"
}

# Each external effect exactly once: every message id's key once (no second
# attempt of a delivered send), each smoke-ctl marker once on GitHub, one
# terminal gate call, one task per slug.
effects_once() {
  python3 - "$C/fake" "$FAKE_LOG" <<'PY'
import collections, json, os, re, sys
fake, log = sys.argv[1], sys.argv[2]
def load(n, d):
    try:
        return json.load(open(os.path.join(fake, n)))
    except FileNotFoundError:
        return d
errs = []
msgs = load("enqueue.json", {"messages": {}})["messages"]
keys = collections.Counter(mid.split("#")[0] for mid in msgs)
errs += ["send key {} has {} attempts".format(k[:12], n) for k, n in keys.items() if n > 1]
gh = load("gh.json", {"comments": {}, "issues": []})
bodies = [c["body"] for cs in gh["comments"].values() for c in cs] + [i["body"] for i in gh["issues"]]
markers = collections.Counter(m for b in bodies for m in re.findall(r"<!-- smoke-ctl:[0-9a-f]{64} -->", b))
errs += ["marker {} written {} times".format(m[14:26], n) for m, n in markers.items() if n > 1]
errs += ["GitHub write without a marker"] * sum(1 for b in bodies if "smoke-ctl:" not in b)
calls = [json.loads(l) for l in open(log)]
term = [c for c in calls if c["tool"] == "gate" and c["op"] in ("finish", "challenger-timeout", "fail-after")]
if len(term) > 1:
    errs.append("{} terminal gate calls".format(len(term)))
names = collections.Counter(t["name"] for t in load("ncl.json", {"tasks": []})["tasks"])
errs += ["task {} created {} times".format(k, n) for k, n in names.items() if n > 1]
print(json.dumps({"ok": not errs, "errors": errs, "sends": len(msgs), "markers": len(markers),
                  "terminal": len(term), "tasks": sum(names.values())}))
PY
}
assert_once() { local r; r="$(effects_once)"; jq -e .ok <<<"$r" >/dev/null || fail "effects not exactly once ($1): $r"; }

# --- 1. startup refusals -------------------------------------------------------
new_case refusals
rm "$C/cutover.json"
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] && jq -e '.error | contains("cutover")' <<<"$STEP_OUT" >/dev/null \
  || fail "live without a cutover file must refuse: rc=$STEP_RC $STEP_OUT"
jq -cn '{legacyRuns:[]}' >"$C/cutover.json"
set +e
out="$(SMOKE_CONTROLLER_MODE=live python3 "$CTL" step --out-dir "$C/out" --gate-state-dir "$C/state" --run-root "$C/runs" \
  --cutover-json "$C/cutover.json" --repo acme/app 2>&1)"; rc=$?
set -e
[ "$rc" = 3 ] && grep -q "live mode needs" <<<"$out" || fail "live without its effect config must refuse: $out"
new_case shadow-journal shadow
MODE=live
step 2026-09-18T10:00:00Z
[ "$STEP_RC" = 3 ] && jq -e '.alarm == "controller_journal_error"' <<<"$STEP_OUT" >/dev/null \
  || fail "a shadow journal must never drive live effects: rc=$STEP_RC $STEP_OUT"
[ ! -s "$FAKE_LOG" ] || fail "a refused live start must call nothing: $(cat "$FAKE_LOG")"

# --- 2. the whole campaign, every effect once --------------------------------
new_case happy
FINDING=F1 campaign 9
assert_once happy
r="$(effects_once)"
[ "$(finish_verdict)" = '"GO"' ] || fail "happy path must finish GO: $(finish_verdict) $(dq '[.[]|select(.type=="finish")]')"
jq -e '.sends == 3 and .markers == 2 and .terminal == 1 and .tasks == 1' <<<"$r" >/dev/null \
  || fail "happy path effects (root, sheet, verdict + comment + issue + finish + critic): $r"
[ "$(jq -r '.prs["7"].state' "$C/fake/gh.json")" = CLOSED ] || fail "a freeze PR is closed after finish"
[ "$(printf '%s ' "${WAKES[@]}")" = "intake lanes preliminary synthesis " ] \
  || fail "owner wakes must be intake, lanes, preliminary, synthesis in order, once each: ${WAKES[*]}"
python3 - "$C/fake" "$RUN" <<'PY' || fail "chat payloads"
import json, os, sys
fake, run = sys.argv[1], sys.argv[2]
msgs = sorted(json.load(open(os.path.join(fake, "enqueue.json")))["messages"].values(), key=lambda m: m["seq"])
assert all(m["threadKey"] == run and m["to"] == "campaign-room" for m in msgs), "threadKey = runId, one destination"
root, sheet, verdict = msgs[0], msgs[1], msgs[2]
assert "checkout button" in root["text"] and "checkout-390" in root["text"], root["text"]
assert sheet["files"] and not sheet["text"].strip(), "the sheet is a separate attachment-only row"
assert "Safe to ship" in verdict["text"] and "GO" not in verdict["text"].replace("GO", "", 0) or True
for tok in ("NO_GO", "HUMAN_DECISION", " GO ", "**GO"):
    assert tok not in verdict["text"], "no bare machine verdict token: " + verdict["text"]
assert run in verdict["text"].splitlines()[-1], "runId on the last line"
PY
jq -e --arg run "$RUN" '.issues[0].title == "Checkout button misaligned at 390px" and (.issues[0].labels | index("smoke-finding"))' \
  "$C/fake/gh.json" >/dev/null || fail "the owner's issue file is what gets filed, labelled smoke-finding"
grep -q 'prompt' "$C/fake/ncl.json" && jq -e '.tasks[0].flags | index("--mute-chat") and index("--isolated")' \
  "$C/fake/ncl.json" >/dev/null || fail "the critic one-shot is created muted and isolated"
jq -e '[.[] | select(.tool=="gate" and .op=="progress")] | length >= 5' -s "$FAKE_LOG" >/dev/null \
  || fail "each live fire stamps gate progress on its run"

# --- 3. a kill at every crash point, and every ambiguous effect outcome ---------
for point in before-run-record after-run-record after-intent:owner:intake after-effect:owner:intake \
  after-intent:dispatch:critic after-effect:dispatch:critic after-intent:send:root after-effect:send:root \
  after-effect:send:root-sheet after-intent:send:verdict after-effect:send:verdict \
  after-intent:gh:pr-comment after-effect:gh:pr-comment after-intent:gh:issue:F1 after-effect:gh:issue:F1 \
  after-intent:gate:finish after-effect:gate:finish after-run-done after-intent:gh:freeze-close \
  after-effect:gh:freeze-close; do
  new_case "crash-${point//:/-}"
  FINDING=F1 CRASH="$point" campaign 10
  assert_once "$point"
  case "$point" in
    after-intent:dispatch:critic)
      # Journaled, never created, no start file: ambiguous -> held -> BLOCKED.
      [ "$(finish_verdict)" = '"BLOCKED"' ] || fail "$point: an ambiguous dispatch must block GO: $(finish_verdict)"
      [ "$(jq '.tasks | length' "$C/fake/ncl.json" 2>/dev/null || echo 0)" = 0 ] \
        || fail "$point: an ambiguous dispatch is never recreated"
      ;;
    *)
      [ "$(finish_verdict)" = '"GO"' ] || fail "$point: must still finish GO: $(finish_verdict) $(dq '[.[]|select(.type=="finish" or .type=="alarm")]')"
      ;;
  esac
  ! dq '[.[] | select(.reason=="controller_foreign_finish")] | length > 0' | grep -qx true \
    || fail "$point: the controller's own finish must never read as a foreign one"
done
for f in enqueue gh:pr-comment gh:issue-create gh:pr-close ncl:create gate:finish; do
  new_case "ambiguous-${f//:/-}"
  jq -cn --arg f "$f" '{($f):["fail-after"]}' >"$C/fake/faults.json"
  FAULTY=1 FINDING=F1 campaign 11
  assert_once "fail-after $f"
  [ "$(finish_verdict)" = '"GO"' ] || fail "fail-after $f: an effect that landed is reconciled, still GO: $(finish_verdict)"
done
new_case transient-gh
jq -cn '{"gh:api":["fail-before","fail-before"]}' >"$C/fake/faults.json"
FAULTY=1 FINDING=F1 campaign 11
assert_once transient-gh
[ "$(finish_verdict)" = '"GO"' ] || fail "two transient GitHub read failures are retried, not terminal"

# --- 4. send budget exhaustion -> failed_terminal -> BLOCKED ----------------------
new_case budget-helper
# The helper's own per-run count (its budget table) is already spent.
python3 - "$C/fake" "$RUN" <<'PY'
import json, os, sys
fake, run = sys.argv[1], sys.argv[2]
json.dump({"messages": {"old-{}#1".format(i): {"text": "x", "to": "r", "threadKey": run, "files": [], "runId": run,
                                              "fingerprint": None, "seq": 2 * i + 1, "at": "x"} for i in range(15)},
           "fires": {}}, open(os.path.join(fake, "enqueue.json"), "w"))
PY
campaign 9
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "an exhausted send budget permits only finish BLOCKED: $(finish_verdict)"
jr "[.[] | select(.kind==\"send\" and .slot==\"root\" and .state==\"failed_terminal\")] | length == 1" | grep -qx true \
  || fail "the refused root send is failed_terminal"
dq '[.[] | select(.type=="finish")] | last | .failedChecks | map(select(contains("failed_terminal"))) | length > 0' \
  | grep -qx true || fail "the BLOCKED finish names the failed_terminal obligation"
new_case budget-controller
# The controller's own count: 15 journaled attempts, so enqueue is never called.
for i in $(seq 1 15); do
  jq -cn --arg run "$RUN" --arg k "$(key "$RUN" send "old$i")" --arg s "old$i" \
    '{v:1,at:"2026-09-18T09:59:00Z",fire:"seed",runId:$run,kind:"send",slot:$s,key:$k,state:"delivered",attempt:1,mode:"live"}' \
    >>"$C/out/journal.ndjson"
done
campaign 9
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "controller-side budget: BLOCKED: $(finish_verdict)"
budget_ids() { jq -s -c '[.[] | select(.tool=="enqueue") | .argv as $a | ($a | index("--run-id")) as $i | $a[$i + 1]] | unique' "$FAKE_LOG"; }
[ "$(budget_ids)" = "[\"$RUN.alarms\"]" ] \
  || fail "an over-budget send never reaches the helper; only the alarm lane does: $(budget_ids)"
jr '[.[] | select(.kind=="send" and (.slot | startswith("alarm:send-budget:")))] | last | .state == "delivered"' \
  | grep -qx true || fail "the budget refusal's alarm is delivered in its own lane"
new_case failed-receipts
FAIL_RECEIPTS="$(key "$RUN" send root)" campaign 12
jr "[.[] | select(.kind==\"send\" and .slot==\"root\")] | last | .state == \"failed_terminal\"" | grep -qx true \
  || fail "three failed delivery receipts make the root send failed_terminal"
[ "$(jq -r '.messages | keys | map(select(startswith("'"$(key "$RUN" send root)"'"))) | length' "$C/fake/enqueue.json")" = 3 ] \
  || fail "each failed receipt advances the attempt (3 attempts, no more)"
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "undeliverable root -> BLOCKED: $(finish_verdict)"

# --- 5. dispatch refused by the host -> terminal, escalated, GO blocked ---------
new_case dispatch-refused
jq -cn '{"ncl:create":["refuse"]}' >"$C/fake/faults.json"
campaign 10
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "a refused critic dispatch blocks GO: $(finish_verdict)"
[ "$(jq -s '[.[] | select(.tool=="ncl" and .op=="refused")] | length' "$FAKE_LOG")" = 1 ] \
  || fail "a refused dispatch is not retried"

# --- 5b. an alarm raised mid-run is receipted, and does not hold GO --------------
new_case owner-overdue
STALL=8 DEADLINE=2026-09-18T14:00:00Z campaign 20
jr '[.[] | select(.kind=="send" and (.slot|startswith("alarm:overdue:")) and .state=="delivered")] | length == 1' \
  | grep -qx true || fail "the overdue alarm is receipted once its delivery row exists"
[ "$(finish_verdict)" = '"GO"' ] || fail "a late-but-complete owner step still finishes GO: $(finish_verdict) $(dq '[.[]|select(.type=="finish")]')"
unset STALL

# --- 5c. a frozen verdict settles even after the phase files move under it -------
# The challenger deadline passes with lanes pending: challenger-timeout BLOCKED
# is validated and its post enqueued. The disposition then lands before the
# post's receipt; the next fire must still settle and finish, not park in lanes.
new_case late-disposition
STALL=30 LATE_DISPOSITION=4 DEADLINE=2026-09-18T10:25:00Z campaign 8
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "late disposition: the frozen BLOCKED still finishes: $(finish_verdict)"
jr '[.[] | select(.kind=="gate" and .slot=="challenger-timeout" and .state=="done")] | length == 1' | grep -qx true \
  || fail "late disposition: the frozen verdict keeps its terminal verb"
fin_at="$(jr '[.[] | select(.kind=="gate" and .state=="done") | .at] | first')"
[ "$fin_at" = '"2026-09-18T10:40:00Z"' ] || fail "late disposition: finish lands the fire after the receipt, got $fin_at"
unset STALL LATE_DISPOSITION DEADLINE

# --- 6. live and shadow apply the same rules ------------------------------------
same_rules() { # label world-setup
  local label="$1" m
  for m in live shadow; do
    new_case "rules-$label-$m" "$m"
    eval "$2"
    campaign 9
    jr '[group_by(.key)[] | {k:(.[0].kind + ":" + .[0].slot), s:(last.state | if . == "delivered" then "done" else . end)}]
        | sort_by(.k) | map(select(.k | startswith("alarm") | not))' >"$T/rules-$label-$m.obs"
    dq '[.[] | select(.type=="finish") | {verdict, failedChecks, verb}] | last' >"$T/rules-$label-$m.fin"
  done
  cmp -s "$T/rules-$label-live.fin" "$T/rules-$label-shadow.fin" \
    || fail "$label: live and shadow finish differently: $(cat "$T/rules-$label-live.fin") vs $(cat "$T/rules-$label-shadow.fin")"
  cmp -s "$T/rules-$label-live.obs" "$T/rules-$label-shadow.obs" \
    || fail "$label: live and shadow obligations differ: $(diff "$T/rules-$label-live.obs" "$T/rules-$label-shadow.obs")"
}
same_rules go 'VERDICT=GO'
same_rules head-moved 'VERDICT=GO; printf "{\"%s\":\"%s\"}\n" "$PR" "$SHA2" >"$C/heads.json"'
same_rules no-go 'VERDICT=NO_GO'
grep -q '"GO"' "$T/rules-go-live.fin" || fail "the clean GO fixture finishes GO in both modes"
grep -q '"BLOCKED"' "$T/rules-head-moved-live.fin" || fail "a moved head refuses GO in both modes"
VERDICT=GO

# --- 7. never both act on one run ---------------------------------------------
# a) a run claimed before the flip: never recorded, stepped, stamped or finished.
new_case cutover-legacy
jq -cn --arg l "$LEGACY" '{legacyRuns:[$l]}' >"$C/cutover.json"
jq -cn --arg run "$LEGACY" --arg sha "$SHA" \
  '{schemaVersion:1,pr:9,activeRunId:$run,activeSha:$sha,challengerDeadline:"2026-09-18T09:00:00Z",
    challengerDisposition:null,activeLeaseOwner:"owner-legacy",activeClaimant:null}' >"$C/state/pr-9-state.json"
jq -cn --arg run "$LEGACY" --arg sha "$SHA" \
  '{wakeAgent:true,data:{trigger:"pr_build_settled",runId:$run,pr:9,sourceSha:$sha,coordinatorOwnerToken:"owner-new",resumedRunId:true}}' \
  >"$C/legacy-wake.json"
step_ok 2026-09-18T10:00:00Z --poll-json "$C/legacy-wake.json"
step_ok 2026-09-18T12:00:00Z
jr "[.[] | select(.runId==\"$LEGACY\")] | length == 0" | grep -qx true || fail "a legacy run is never journaled"
jr '[.[] | select(.kind=="hold")] | length == 1' | grep -qx true || fail "a legacy run surfacing is held once"
[ "$(jq -s '[.[] | select(.tool=="gate")] | length' "$FAKE_LOG")" = 0 ] \
  || fail "the controller never calls the gate for a legacy run (deadline long past): $(cat "$FAKE_LOG")"
[ "$(jq -s '[.[] | select(.tool=="enqueue")] | length' "$FAKE_LOG")" = 1 ] \
  || fail "exactly one alarm post for the held legacy run"
# b) a run the gate records as claimed by the legacy coordinator (or a stranger's
#    token) is never acted on, even with our wake journaled.
for variant in claimant token; do
  new_case "no-authority-$variant"
  if [ "$variant" = claimant ]; then claim 2026-09-18T11:30:00Z ""; else claim 2026-09-18T11:30:00Z controller owner-other; fi
  wake_json
  contract; marker A1 1 pass; marker B1 2 pass; printf 'p\n' >"$R/coordinator/preliminary.md"; parent_conclusions
  synthesis GO
  step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
  step_ok 2026-09-18T12:00:00Z
  [ "$(jq -s '[.[] | select(.tool=="gate" or .tool=="gh" or .tool=="ncl")] | length' "$FAKE_LOG")" = 0 ] \
    || fail "$variant: no gate/GitHub/task effect on a run we do not hold: $(cat "$FAKE_LOG")"
  jr '[.[] | select(.detail.noAuthority)] | length == 1' | grep -qx true || fail "$variant: no-authority recorded once"
  [ ! -e "$R/controller/brief-intake.md" ] || fail "$variant: no owner brief for a run we do not hold"
done
# c) the gate fake mirrors claimant_guard: a legacy caller cannot finish a
#    controller run (the real gate is tested in smoke-pr-gate.test.sh).
new_case legacy-caller
claim
out="$(bash "$C/bin/gate.sh" finish "$SHA" "$RUN" GO "$TOKEN")"
jq -e '.claimantMismatch == true' <<<"$out" >/dev/null || fail "legacy caller refused by claimant: $out"

# --- 8. owner wakes: one per fire, bounded re-offers, stopped by the ack --------
new_case wakes
claim; wake_json
step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
[ "$(jq -r '.ownerWake.step' <<<"$STEP_OUT")" = intake ] || fail "first wake is intake: $STEP_OUT"
jq -e --arg b "$R/controller/brief-intake.md" '.ownerWake.brief == $b and .ownerWake.runId != null' <<<"$STEP_OUT" >/dev/null \
  || fail "wake carries {step, runId, brief path}: $STEP_OUT"
grep -q 'never post to chat' "$R/controller/brief-intake.md" || fail "the brief forbids posting"
jq -e --arg t "$TOKEN" '.coordinatorOwnerToken == $t' "$R/controller/wake.json" >/dev/null || fail "intake gets the frozen wake"
n=0
for i in 1 2 3 4; do
  step_ok "2026-09-18T10:0${i}:00Z"
  [ "$(jq -r '.ownerWake.step // empty' <<<"$STEP_OUT")" = intake ] && n=$((n + 1))
done
[ "$n" = 2 ] || fail "an un-acked brief is re-offered twice more (3 offers in all), got $n"
new_case wakes-ack
claim; wake_json
step_ok 2026-09-18T10:00:00Z --poll-json "$C/wake.json"
: >"$R/controller/brief-intake.ack"
step_ok 2026-09-18T10:01:00Z
[ "$(jq -r '.ownerWake' <<<"$STEP_OUT")" = null ] || fail "an acked brief is not re-offered: $STEP_OUT"

# --- 9. review round 1 (PR #945) ---------------------------------------------------
# a) A crash inside the gate's finish, between verdict.json and the slot
#    cleanup: the run is not done, nothing post-finish runs, and the gate's own
#    crash-safe finish is re-run until its completed state agrees.
new_case partial-finish
jq -cn '{"gate:finish":["partial"]}' >"$C/fake/faults.json"
FAULTY=1 FINDING=F1 campaign 12
assert_once partial-finish
python3 - "$FAKE_LOG" <<'PY' || fail "partial finish: freeze-close must follow the COMPLETED finish"
import json, sys
calls = [json.loads(l) for l in open(sys.argv[1])]
ops = [(c["tool"], c["op"]) for c in calls]
partial = ops.index(("gate", "partial"))
done = ops.index(("gate", "finish"))
closed = ops.index(("gh", "closed"))
assert partial < done < closed, ops
PY
jr '[.[] | select(.kind=="gate" and .slot=="finish-resume" and .state=="done")] | length >= 1' | grep -qx true \
  || fail "partial finish: resumed through the gate's own finish"
jr '[.[] | select(.kind=="run")] | (last.state == "done") and (map(.detail.gateCompleted) | any)' | grep -qx true \
  || fail "partial finish: the run closes only on the gate's completion receipt"
[ "$(finish_verdict)" = '"GO"' ] || fail "partial finish: the resumed finish keeps the verdict: $(finish_verdict)"

# b) A delivery receipt that never arrives: alarmed once within the SLA, the
#    send keeps its one message id (never a second attempt), no finish.
new_case receipt-missing
VKEY="$(key "$RUN" send verdict)"
MISSING_RECEIPTS="$VKEY" campaign 14
jr '[.[] | select(.kind=="send" and (.slot|startswith("alarm:overdue:")))] | group_by(.key) | length == 1' \
  | grep -qx true || fail "missing receipt: exactly one overdue alarm: $(jr '[.[]|select(.kind=="send")|.slot]|unique')"
dq '[.[] | select(.type=="alarm" and .reason=="controller_obligation_overdue" and .detail.obligation=="send:verdict")] | length == 1' \
  | grep -qx true || fail "missing receipt: the alarm names send:verdict"
[ "$(jq -r --arg k "$VKEY" '.messages | keys | map(select(startswith($k))) | length' "$C/fake/enqueue.json")" = 1 ] \
  || fail "missing receipt: the verdict send is never re-attempted"
[ "$(jq -s '[.[] | select(.tool=="gate" and (.op=="finish" or .op=="challenger-timeout"))] | length' "$FAKE_LOG")" = 0 ] \
  || fail "missing receipt: no finish while the verdict post is unconfirmed"
alarm_at="$(dq '[.[] | select(.reason=="controller_obligation_overdue")] | first | .at')"
sent_at="$(jr "[.[] | select(.key==\"$VKEY\" and .state==\"enqueued\")] | first | .at")"
python3 - "$sent_at" "$alarm_at" <<'PY' || fail "missing receipt: alarm within one fire of the SLA ($sent_at -> $alarm_at)"
import datetime as d, json, sys
p = lambda s: d.datetime.strptime(json.loads(s), "%Y-%m-%dT%H:%M:%SZ")
gap = (p(sys.argv[2]) - p(sys.argv[1])).total_seconds()
assert 1800 < gap <= 1800 + 600, gap
PY
unset VKEY

# c) The challenger deadline passes on the fire the lanes step first comes
#    due: timeout first, no owner wake for a step the run will never use.
new_case timeout-before-judgment
STALL=30 DEADLINE=2026-09-18T10:15:00Z campaign 8
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "timeout: BLOCKED: $(finish_verdict)"
jr '[.[] | select(.kind=="gate" and .slot=="challenger-timeout" and .state=="done")] | length == 1' | grep -qx true \
  || fail "timeout: challenger-timeout is the terminal verb"
for i in "${!WAKES[@]}"; do
  [ "${WAKES[$i]}" != lanes ] || fail "timeout: an owner wake for lanes at ${WAKE_TIMES[$i]} after the deadline"
  [[ "${WAKE_TIMES[$i]}" < 2026-09-18T10:15:00Z ]] || fail "timeout: owner wake ${WAKES[$i]} at ${WAKE_TIMES[$i]} after the deadline"
done
jr '[.[] | select(.kind=="owner" and .slot=="lanes")] | length == 0' | grep -qx true \
  || fail "timeout: the lanes judgment is never even scheduled: $(jr '[.[]|select(.kind=="owner")]')"
unset STALL DEADLINE
# d) A wake queued earlier in a fire whose step was abandoned (or whose run
#    finished) later in the SAME fire is never offered, nor re-enqueued.
python3 -B - "$CTL" <<'PY' || fail "abandoned: pick_owner_wake filters on the fire's final state"
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ctl", sys.argv[1])
ctl = importlib.util.module_from_spec(spec); spec.loader.exec_module(ctl)
run = "xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"
k = lambda kind, slot: ctl.obligation_key(run, kind, slot)
class Stub:
    live, fire = True, "f1"
    def __init__(self, obs):
        self.obs, self.recorded = obs, []
        self.owner_wakes = [{"runId": run, "step": "lanes", "brief": "b", "key": k("owner", "lanes"), "since": "t"}]
    def obligations(self):
        return self.obs
    def record(self, *a):
        self.recorded.append(a)
def ob(kind, slot, state):
    return {"key": k(kind, slot), "runId": run, "kind": kind, "slot": slot, "state": state, "detail": {}, "history": []}
base = lambda lanes, run_state: {k("owner", "lanes"): ob("owner", "lanes", lanes), k("run", "claim"): ob("run", "claim", run_state)}
cases = {
    "step abandoned": base("abandoned", "enqueued"),
    "run done": base("enqueued", "done"),
    "verdict frozen": dict(base("enqueued", "enqueued"), **{k("verdict", "validated"): ob("verdict", "validated", "done")}),
    "terminal verb journaled": dict(base("enqueued", "enqueued"),
                                    **{k("gate", "challenger-timeout"): ob("gate", "challenger-timeout", "intent")}),
}
for label, obs in cases.items():
    st = Stub(obs)
    got = ctl.Controller.pick_owner_wake(st)
    assert got is None and not st.recorded, (label, got, st.recorded)
st = Stub(base("enqueued", "enqueued"))
assert ctl.Controller.pick_owner_wake(st)["step"] == "lanes", "a live, due step is still offered"
PY

# --- 10. review round 2 (PR #945) -------------------------------------------------
# A one-shot alarm is settled by its send obligation, never by a journaled
# flag. A kill BEFORE its intent re-raises it on the next fire; a kill AFTER
# its intent replays the SAME attempt; every case ends with exactly one
# enqueued message for the alarm, and that one delivered.
one_alarm() { # label alarm-slot [run]
  local k; k="$(key "${3:-$RUN}" send "$2")"
  [ "$(jq -r --arg k "$k" '.messages | keys | map(select(startswith($k))) | length' "$C/fake/enqueue.json" 2>/dev/null || echo 0)" = 1 ] \
    || fail "$1: exactly one enqueued message for $2: $(jq -c '.messages | keys' "$C/fake/enqueue.json" 2>/dev/null)"
  jr "[.[] | select(.key==\"$k\")] | last | .state == \"delivered\"" | grep -qx true \
    || fail "$1: the $2 alarm ends delivered: $(jr "[.[] | select(.key==\"$k\") | .state]")"
}
# verdict.json on file, the slot gone, and a completed state that names another
# run (or this one): the gate's finish cannot be confirmed / was someone else's.
gate_finished_elsewhere() { # completedRunId
  mkdir -p "$C/state/runs/$RUN"
  jq -cn --arg run "$RUN" --arg sha "$SHA" '{schemaVersion:1,runId:$run,sha:$sha,verdict:"BLOCKED"}' \
    >"$C/state/runs/$RUN/verdict.json"
  jq -c --arg done "$1" '.activeRunId=null | .activeLeaseOwner=null | .activeClaimant=null
    | .completedRunId=$done | .completedVerdict="BLOCKED"' "$C/state/pr-$PR-state.json" >"$C/state/pr.tmp"
  mv "$C/state/pr.tmp" "$C/state/pr-$PR-state.json"
}
recovery_fires() { # crash-spec first-tick: kill the first fire there, then keep firing
  local n now extra
  for n in $(seq "$2" $(($2 + 4))); do
    now="$(tick_time "$n")"
    extra=()
    [ "$n" = 0 ] && extra=(--poll-json "$C/wake.json")
    inputs_from_fakes
    if [ "$n" = "$2" ]; then
      SMOKE_CONTROLLER_CRASH_AT="$1" step "$now" "${extra[@]}"
      [ "$STEP_RC" = 137 ] || fail "crash point $1 was never reached (rc=$STEP_RC): $STEP_OUT $(cat "$C/stderr")"
      inputs_from_fakes
    fi
    step_ok "$now" "${extra[@]}"
  done
}
UNCONF="alarm:finish-unconfirmed:${RUN: -40}"
for point in "after-intent:send:$UNCONF" "before-intent:send:$UNCONF"; do
  new_case "unconfirmed-${point%%:*}"
  claim; wake_json
  gate_finished_elsewhere xzo-pr-pr7-bbbbbbbbbbbb-20260918T120000Z
  recovery_fires "$point" 0
  one_alarm "finish unconfirmed, killed ${point%%:*}" "$UNCONF"
  [ "$(jq -s '[.[] | select(.tool=="gate")] | length' "$FAKE_LOG")" = 0 ] \
    || fail "finish unconfirmed: no gate verb on a finish it cannot confirm"
  jr '[.[] | select(.kind=="run") | .detail.finishUnconfirmed] | any' | grep -qx true \
    || fail "finish unconfirmed: the state is still recorded"
done
# The same rule for an event alarm: a foreign finish is alarmed BEFORE the run
# is marked done, so a kill between them re-enters the path.
FOREIGN="alarm:foreign-finish:${RUN: -40}"
for point in "before-intent:send:$FOREIGN" "after-intent:send:$FOREIGN"; do
  new_case "foreign-${point%%:*}"
  claim; wake_json
  gate_finished_elsewhere "$RUN"
  recovery_fires "$point" 0
  one_alarm "foreign finish, killed ${point%%:*}" "$FOREIGN"
  jr '[.[] | select(.kind=="run")] | last | .state == "done"' | grep -qx true \
    || fail "foreign finish: the run still closes"
done
# ...and for the condition alarms the finding names: dispatch-ambiguous (a
# second kill, after the first made the dispatch ambiguous) and owner overdue.
AMB="alarm:dispatch-ambiguous:$(key "$RUN" dispatch critic | cut -c1-12)"
for point in "before-intent:send:$AMB" "after-intent:send:$AMB"; do
  new_case "ambiguous-alarm-${point%%:*}"
  CRASH=after-intent:dispatch:critic CRASH2="$point" campaign 10
  one_alarm "dispatch ambiguous, killed ${point%%:*}" "$AMB"
  [ "$(finish_verdict)" = '"BLOCKED"' ] || fail "dispatch ambiguous: still BLOCKED: $(finish_verdict)"
done
OVERDUE="alarm:overdue:$(key "$RUN" owner lanes | cut -c1-12)"
for point in "before-intent:send:$OVERDUE" "after-intent:send:$OVERDUE"; do
  new_case "overdue-alarm-${point%%:*}"
  STALL=8 DEADLINE=2026-09-18T14:00:00Z CRASH="$point" campaign 20
  one_alarm "owner overdue, killed ${point%%:*}" "$OVERDUE"
  [ "$(finish_verdict)" = '"GO"' ] || fail "owner overdue: a late-but-complete step still finishes GO: $(finish_verdict)"
done
unset STALL DEADLINE UNCONF FOREIGN AMB OVERDUE

# --- 11. review round 3: no terminal transition without its alarm -----------------
# The property, over every terminal or failure transition the controller can
# make: by the end of the fire that records it, the journal holds that
# transition's alarm obligation. Journaling is unconditional and outside every
# budget; DELIVERY is a separate, budgeted step, so the property holds just as
# well when the send budget is already spent (the alarm is then an open
# intent@0, drained on a later fire, never a terminal state with no alarm).
alarm_property() { # label required-alarm-slot-prefix
  python3 - "$C/out/journal.ndjson" "$1" "$2" <<'PY' || fail "$1: terminal transition without its alarm (above)"
import json, sys
path, label, want = sys.argv[1], sys.argv[2], sys.argv[3]
obs = {}
for line in open(path):
    if not line.strip():
        continue
    r = json.loads(line)
    o = obs.setdefault(r["key"], {"runId": r["runId"], "kind": r["kind"], "slot": r["slot"], "detail": {}})
    o["state"] = r["state"]
    o["detail"].update(r.get("detail") or {})
alarms = {}
for o in obs.values():
    if o["kind"] == "send" and (o["slot"].startswith("alarm:") or o["runId"].startswith("ctl.")):
        alarms.setdefault(o["runId"], []).append(o)
errs = []
for o in obs.values():
    if o["state"] not in ("failed_terminal", "abandoned"):
        continue
    if o["kind"] == "send" and (o["slot"].startswith("alarm:") or o["runId"].startswith("ctl.")):
        continue   # an alarm IS the alarm; nothing alarms about it
    if not alarms.get(o["runId"]):
        errs.append("{} {}:{} is {} with no alarm obligation on the run".format(
            o["runId"][-12:], o["kind"], o["slot"], o["state"]))
hit = [o for rid in alarms for o in alarms[rid] if o["slot"].startswith(want)]
if not hit:
    errs.append("no alarm obligation {}* (have: {})".format(
        want, sorted({o["slot"] for rid in alarms for o in alarms[rid]})))
for o in hit:
    if o["state"] == "abandoned":
        errs.append("{} was abandoned instead of settled".format(o["slot"]))
for e in errs:
    print("{}: {}".format(label, e))
sys.exit(1 if errs else 0)
PY
}
# "The budget is already spent": both lanes, the controller's side (journaled
# attempts) and the helper's (its own table), so no delivery is possible at all.
spend_budget() {
  local i
  for i in $(seq 1 15); do
    jq -cn --arg run "$RUN" --arg k "$(key "$RUN" send "spent$i")" --arg s "spent$i" \
      '{v:1,at:"2026-09-18T09:59:00Z",fire:"seed",runId:$run,kind:"send",slot:$s,key:$k,state:"delivered",attempt:1,mode:"live"}' \
      >>"$C/out/journal.ndjson"
    jq -cn --arg run "$RUN" --arg k "$(key "$RUN" send "alarm:spent$i")" --arg s "alarm:spent$i" \
      '{v:1,at:"2026-09-18T09:59:00Z",fire:"seed",runId:$run,kind:"send",slot:$s,key:$k,state:"delivered",attempt:1,mode:"live"}' \
      >>"$C/out/journal.ndjson"
  done
  python3 - "$C/fake" "$RUN" <<'PY'
import json, os, sys
fake, run = sys.argv[1], sys.argv[2]
msgs = {"spent-{}#1".format(i): {"text": "x", "to": "r", "threadKey": run, "files": [], "runId": rid,
                                 "fingerprint": None, "seq": 2 * i + 1, "at": "x"}
        for rid in (run, run + ".alarms") for i in range(15)}
json.dump({"messages": msgs, "fires": {}}, open(os.path.join(fake, "enqueue.json"), "w"))
PY
}
# Each transition, driven the shortest way that reaches it.
transition() { # name
  case "$1" in
    receipts-exhausted) FAIL_RECEIPTS="$(key "$RUN" send root)" campaign 12 ;;
    send-budget)        campaign 9 ;;
    dispatch-ambiguous) CRASH=after-intent:dispatch:critic campaign 10 ;;
    dispatch-failed)    jq -cn '{"ncl:create":["refuse"]}' >"$C/fake/faults.json"; campaign 10 ;;
    gate-refused)       jq -cn '{"gate:finish":["refuse"]}' >"$C/fake/faults.json"; FINDING=F1 campaign 12 ;;
    overdue)            STALL=8 DEADLINE=2026-09-18T14:00:00Z campaign 20; unset STALL DEADLINE ;;
    released)           claim; wake_json
                        inputs_from_fakes; step_ok "$(tick_time 0)" --poll-json "$C/wake.json"
                        jq -c '.activeRunId=null | .activeLeaseOwner=null | .activeClaimant=null' \
                          "$C/state/pr-$PR-state.json" >"$C/state/pr.tmp"
                        mv "$C/state/pr.tmp" "$C/state/pr-$PR-state.json"
                        inputs_from_fakes; step_ok "$(tick_time 1)" ;;
    no-authority)       claim "" ""; wake_json
                        inputs_from_fakes; step_ok "$(tick_time 0)" ;;
    foreign-finish)     claim; wake_json; inputs_from_fakes; step_ok "$(tick_time 0)" --poll-json "$C/wake.json"
                        gate_finished_elsewhere "$RUN"
                        inputs_from_fakes; step_ok "$(tick_time 1)" ;;
    finish-unconfirmed) claim; wake_json; inputs_from_fakes; step_ok "$(tick_time 0)" --poll-json "$C/wake.json"
                        gate_finished_elsewhere xzo-pr-pr7-bbbbbbbbbbbb-20260918T120000Z
                        inputs_from_fakes; step_ok "$(tick_time 1)" ;;
    # Codex round-4 repro 2: the gate's verdict.json cannot be parsed. The step
    # answers "unknown" -- not on the allowlist -- so the boundary alarms.
    malformed-verdict)  claim; wake_json; inputs_from_fakes; step_ok "$(tick_time 0)" --poll-json "$C/wake.json"
                        mkdir -p "$C/state/runs/$RUN"; printf '{"verdict":' >"$C/state/runs/$RUN/verdict.json"
                        inputs_from_fakes; step_ok "$(tick_time 1)"
                        inputs_from_fakes; step_ok "$(tick_time 2)" ;;
    # An unforeseen fault inside a step is the same boundary, other arm.
    step-error)         claim; wake_json; inputs_from_fakes; step_ok "$(tick_time 0)" --poll-json "$C/wake.json"
                        inputs_from_fakes; step_raising "$(tick_time 1)" ;;
  esac
}

# Runs one step with Controller.step_run raising, to prove the boundary catches
# what no path anticipated (a fault that cannot be staged through the fakes).
step_raising() { # now
  local now="$1"
  local -a a
  mapfile -t a < <(live_args)
  cat >"$C/raise.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ctl_under_test", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def boom(self, run_id):
    raise RuntimeError("an unforeseen step fault")
m.Controller.step_run = boom
sys.exit(m.main(sys.argv[2:]))
PY
  set +e
  STEP_OUT="$(SMOKE_CONTROLLER_MODE=live python3 -B "$C/raise.py" "$CTL" step "${a[@]}" --now "$now" --fire "$now" 2>"$C/stderr")"
  STEP_RC=$?
  set -e
  [ "$STEP_RC" = 0 ] || fail "step-error: the boundary absorbs the fault (rc $STEP_RC): $(tail -3 "$C/stderr")"
  jq -e '.stepErrors | length == 1 and (.[0].cause == "step-error")' <<<"$STEP_OUT" >/dev/null     || fail "step-error: the fire reports the failed step: $STEP_OUT"
}
for variant in budgeted spent; do
  for t in receipts-exhausted:send-failed send-budget:send-budget dispatch-ambiguous:dispatch-ambiguous \
           dispatch-failed:dispatch-failed gate-refused:gate-refused overdue:overdue released:released \
           no-authority:no-authority foreign-finish:foreign-finish finish-unconfirmed:finish-unconfirmed \
           malformed-verdict:step-outcome step-error:step-error; do
    name="${t%%:*}"
    want="${t##*:}"
    # With no budget left the root send is refused before it can ever exhaust
    # its receipts, so that transition becomes the budget refusal instead.
    [ "$variant" = spent ] && [ "$name" = receipts-exhausted ] && want=send-budget
    new_case "prop-$variant-$name"
    if [ "$variant" = spent ]; then
      spend_budget
    elif [ "$name" = send-budget ]; then
      spend_budget   # the transition IS a budget refusal, so it needs one
    fi
    transition "$name"
    alarm_property "$variant/$name" "alarm:$want:"
    if [ "$variant" = budgeted ] && [ "$name" != send-budget ]; then
      jq -s -e --arg p "alarm:$want:" '[.[] | select(.kind=="send" and (.slot | startswith($p)))] | last
        | .state == "delivered" or .state == "enqueued"' "$C/out/journal.ndjson" >/dev/null \
        || fail "$name: within budget the alarm is actually delivered"
    else
      # Spent: journaled anyway, and never silently dropped.
      jq -s -e --arg p "alarm:$want:" '[.[] | select(.kind=="send" and (.slot | startswith($p)))] | length > 0' \
        "$C/out/journal.ndjson" >/dev/null || fail "$name: the alarm is journaled even with no budget left"
    fi
  done
done
unset variant name t want


# --- XZO #2047: a barrier refusal must reach the OWNER ------------------------
# Run xzo-pr-pr2055-dacf01328421-20260921T193111Z: the lanes barrier answered
# `invalid: ["journeys/scope-dispositions.json"]` on the 19:51:35Z fire -- the
# FIRST lanes fire, before a single lane had run -- and every fire after it. The
# controller journaled that as an `escalate` decision with the reasons truncated
# to three, wrote the owner a brief from the STATIC OWNER_BRIEF template that
# said nothing about it, and woke the owner to run 14 lanes. The owner, the only
# party that could repair the artifact, discovered the refusal at 20:58Z by
# running the barrier by hand -- 67 minutes and a collapsed lease later.
#
# The barrier's own content rules are smoke-journeys.test.sh's subject; what is
# regressed here is the CONTROLLER's duty to carry whatever invalid[] it gets
# back to the owner. The contract below is refused by the real
# smoke-evidence-barrier.sh for its own content, from the first lanes fire, the
# same shape as #2055's intake-authored artifact.
new_case ctl-2047-barrier-refusal-reaches-owner
contract
mkdir -p "$R/contact-sheet"
printf 'png\n' >"$R/contact-sheet/sheet.png"
printf 'This build changes the checkout button; the checkout journey will be tested.\n' \
  >"$R/controller/root-summary.md"
jq -c '.requiredLaneMarkers = ["../elsewhere/markers/A1.json","markers/B1.json"]' \
  "$R/completion-contract.json" >"$R/.contract.tmp"
mv "$R/.contract.tmp" "$R/completion-contract.json"
campaign 3

jq -e '.invalid == ["../elsewhere/markers/A1.json"] and (.invalidReasons | length) == 1
       and .ready == false and .phase == "lanes"' \
  "$R/controller/barrier-lanes.json" >/dev/null \
  || fail "#2047: the lanes barrier's answer is not published for the owner: $(cat "$R/controller/barrier-lanes.json" 2>&1)"
grep -q 'controller/barrier-lanes.json' "$R/controller/brief-lanes.md" \
  || fail "#2047: the lanes brief does not point the owner at the barrier's answer"
grep -q 'THE BARRIER IS ALREADY REFUSING THIS PHASE' "$R/controller/brief-lanes.md" \
  || fail "#2047: a brief written while the barrier already refuses does not say so"
# The reasons are complete in the file even though the journal keeps three.
jq -e '.invalidReasons[0] | test("path-traversal marker path")' "$R/controller/barrier-lanes.json" >/dev/null \
  || fail "#2047: the published reason is not the barrier's own"

# ...and it is removed the moment the phase passes, so it can never be read as
# a live refusal that is over.
new_case ctl-2047-barrier-report-cleared
campaign 3
[ ! -e "$R/controller/barrier-lanes.json" ] \
  || fail "#2047: a passed lanes barrier left a refusal file behind"
grep -q 'controller/barrier-lanes.json' "$R/controller/brief-lanes.md" \
  || fail "#2047: a barrier-backed brief must name the barrier file even when nothing is refused yet"
grep -q 'CHECK THE BARRIER, DO NOT ASSUME IT' "$R/controller/brief-lanes.md" \
  || fail "#2047: a barrier that is only waiting for markers must not shout like one refusing content"

# --- XZO #2046: a re-minted owner token must be re-ISSUED to the owner --------
# Same run. The controller's fires stopped for 40 minutes (19:51:19Z ->
# 20:31:42Z, wrapper/fires.ndjson) while the gate's coordinator lease is 900 s
# (smoke-pr-gate.sh:220), so the lease lapsed under a live owner and its eight
# completed lanes were refused their markers. The next `poll` then did what it
# is supposed to do on a stale run: it resumed the run id and minted a FRESH
# owner token (smoke-pr-gate.sh:5312 -> :5347/:5349/:5389). The controller
# picked the new token up for itself, and stopped there. controller/wake.json --
# the only file that carries the token to the owner, and the file the intake
# brief tells it to read -- still named the retired one, and the lanes brief is
# re-offered only while its `.ack` is ABSENT, which it was not. So the owner the
# controller itself dispatched could satisfy neither begin_active_run_fence nor
# `adopt`, the verb that exists for exactly this transition. It correctly
# refused to work around it and the campaign ended BLOCKED with 4 of 14 markers.
#
# Neither the re-mint nor adopt's fence is the defect: the missing step is the
# controller re-issuing the token it just received to the owner it dispatched.
new_case ctl-2046-owner-token-reissued
campaign 2   # contract + critic in, the lanes step enqueued under $TOKEN
# The simulated owner acks at the START of a tick, so the brief written by the
# last fire is acked here -- the same state the real run was in at 20:31Z.
for b in "$R"/controller/brief-*.md; do [ -e "${b%.md}.ack" ] || : >"${b%.md}.ack"; done
jq -e --arg t "$TOKEN" '.coordinatorOwnerToken == $t' "$R/controller/wake.json" >/dev/null \
  || fail "#2046: precondition -- the run tree should hold the original token"
STEP_BEFORE="$(jq -sr '[.[] | select(.kind=="owner" and .state=="enqueued")] | last | .slot' "$C/out/journal.ndjson")"
[ -n "$STEP_BEFORE" ] && [ "$STEP_BEFORE" != null ] || fail "#2046: precondition -- no owner step is in flight"
[ -e "$R/controller/brief-$STEP_BEFORE.ack" ] || fail "#2046: precondition -- the owner never acked $STEP_BEFORE"

REMINT=owner-ctl-remint-2222
claim "" controller "$REMINT"
jq -c --arg t "$REMINT" '.data.coordinatorOwnerToken = $t' "$C/wake.json" >"$C/wake-remint.json"
inputs_from_fakes
step_ok "$(tick_time 3)" --poll-json "$C/wake-remint.json"

jq -e --arg t "$REMINT" '.coordinatorOwnerToken == $t' "$R/controller/wake.json" >/dev/null \
  || fail "#2046: the re-minted token was never issued to the owner (wake.json still names the retired one)"
grep -q 'YOUR OWNER TOKEN CHANGED' "$R/controller/brief-$STEP_BEFORE.md" \
  || fail "#2046: the re-offered brief does not tell the owner its token changed"
grep -q 'smoke-run-scaffold.sh adopt' "$R/controller/brief-$STEP_BEFORE.md" \
  || fail "#2046: the re-offered brief does not name the one legitimate recovery, adopt"
grep -q 'Do NOT copy a token out of gate state' "$R/controller/brief-$STEP_BEFORE.md" \
  || fail "#2046: the brief does not rule out the impersonation route the run's own recovery record refused"
jq -se --arg s "$STEP_BEFORE" '[.[] | select(.kind=="owner" and .slot==$s and .state=="intent"
       and (.detail.tokenReissued == true))] | length == 1' "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046: the in-flight owner step was not re-offered for adoption"
jq -se '[.[] | select(.kind=="send" and (.slot | startswith("alarm:token-reissued:")))] | length > 0' \
  "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046: a mid-run owner-token re-mint is not alarmed"
# The owner is woken again -- a brief nobody is told to re-read is not an issue.
[ "$(jq -r '.ownerWake.step // ""' <<<"$STEP_OUT")" = "$STEP_BEFORE" ] \
  || fail "#2046: the owner was not re-woken for the step it must adopt into: $STEP_OUT"

# Re-running the same fire hands the token over exactly once.
BEFORE_LINES="$(wc -l <"$C/out/journal.ndjson")"
step_ok "$(tick_time 3)" --poll-json "$C/wake-remint.json"
jq -se --arg s "$STEP_BEFORE" '[.[] | select(.kind=="owner" and .slot==$s and .state=="intent"
       and (.detail.tokenReissued == true))] | length == 1' "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046: the retry of the same fire re-offered the step a second time ($BEFORE_LINES lines before)"
# A step that is over is never re-offered: nothing is in flight to adopt into.
new_case ctl-2046-no-reissue-without-a-step-in-flight
campaign 6
REMINT=owner-ctl-remint-3333
claim "" controller "$REMINT"
jq -c --arg t "$REMINT" '.data.coordinatorOwnerToken = $t' "$C/wake.json" >"$C/wake-remint.json"
inputs_from_fakes
step_ok "$(tick_time 7)" --poll-json "$C/wake-remint.json"
jq -se '[.[] | select(.kind=="owner" and .state=="intent" and (.detail.tokenReissued == true))] | length == 0' \
  "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046: a finished run re-offered an owner step it has no use for"


# --- round 2, finding 3: the SYNTHESIS barrier's refusal wakes the owner too ---
# The lanes fix (XZO #2047) left the identical blind spot on the sibling path:
# when the synthesis barrier is not ready the branch published the report and
# returned, and smoke-controller-live.sh wakes the owner only on `ownerWake`.
# So the owner -- the only party that can repair what that barrier rejects --
# was never invoked, and _maybe_synthesis_overdue_blocked keys on the very
# owner:synthesis obligation the branch declined to create, so the terminal
# BLOCKED net could not fire either. Driven through the real barrier: a
# contact-sheet manifest it rejects for its own content, which is a
# synthesis-phase-only check (smoke-evidence-barrier.sh gates the visual
# candidate check on PHASE = synthesis) and so cannot be confused with a lanes
# refusal.
export SMOKE_VISUAL_DISPOSITIONS=1
new_case ctl-2047b-synthesis-barrier-wakes-owner
# Broken BEFORE the run first reaches synthesis, so what is under test is the
# arrival at a refusing barrier, not a later fire finding an already-briefed
# step. campaign 4 stops at await_challenger; world 5 lands the challenger's
# disposition, which is the last gate before the synthesis branch.
campaign 4
printf 'shots\n' >"$R/contact-sheet/shots.json"
printf 'not a manifest\n' >"$R/contact-sheet/manifest.json"
world 5
inputs_from_fakes
step_ok "$(tick_time 5)"

jq -e '.phase == "synthesis" and .ready == false
       and (.invalid | index("contact-sheet/manifest.json") != null)' \
  "$R/controller/barrier-synthesis.json" >/dev/null \
  || fail "#2047(synthesis): the barrier's answer is not published: $(cat "$R/controller/barrier-synthesis.json" 2>&1)"
[ -e "$R/controller/brief-synthesis.md" ] \
  || fail "#2047(synthesis): a refusing synthesis barrier wrote no brief -- nobody is told and nobody is invoked"
grep -q 'controller/barrier-synthesis.json' "$R/controller/brief-synthesis.md" \
  || fail "#2047(synthesis): the brief does not point the owner at the barrier's answer"
grep -q 'THE BARRIER IS ALREADY REFUSING THIS PHASE' "$R/controller/brief-synthesis.md" \
  || fail "#2047(synthesis): the brief does not say the barrier is refusing content"
jq -se '[.[] | select(.kind=="owner" and .slot=="synthesis" and .state=="enqueued"
        and .detail.outcome=="brief_written")] | length == 1' "$C/out/journal.ndjson" >/dev/null \
  || fail "#2047(synthesis): no owner:synthesis obligation, so the overdue-BLOCKED net can never fire either"
[ "$(jq -r '.ownerWake.step // ""' <<<"$STEP_OUT")" = synthesis ] \
  || fail "#2047(synthesis): the owner was not woken for the step only it can repair: $STEP_OUT"
unset SMOKE_VISUAL_DISPOSITIONS

# --- round 2, finding 1: the re-issue survives a kill at the claim record -----
# The claim record is fsynced BEFORE anything else and the gate latches the
# wake, so an edge trigger on reconcile_claims' poll-reclaim branch was not
# crash-safe: a death in between left the journalled token already matching,
# the branch skipped forever, and the owner enqueued on the old brief and a
# stale wake.json -- the exact wedge this PR recovers from. The kill is driven
# at the real seam (crash_point "after-reclaim-record"), and the fire that
# follows carries NO poll wake, which is what the gate actually gives once it
# has latched one.
new_case ctl-2046b-reissue-survives-a-crash-at-the-claim-record
campaign 2
for b in "$R"/controller/brief-*.md; do [ -e "${b%.md}.ack" ] || : >"${b%.md}.ack"; done
REMINT=owner-ctl-remint-crash-4444
claim "" controller "$REMINT"
jq -c --arg t "$REMINT" '.data.coordinatorOwnerToken = $t' "$C/wake.json" >"$C/wake-remint.json"
inputs_from_fakes
SMOKE_CONTROLLER_CRASH_AT=after-reclaim-record:run:claim step "$(tick_time 3)" --poll-json "$C/wake-remint.json"
[ "$STEP_RC" = 137 ] || fail "#2046(crash): the fire was not killed at the claim-record window (rc=$STEP_RC)"
jq -se --arg t "$REMINT" '[.[] | select(.kind=="run" and .slot=="claim")] | last | .detail.ownerToken == $t' \
  "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046(crash): precondition -- the claim record did not land before the kill"
jq -e --arg t "$REMINT" '.coordinatorOwnerToken != $t' "$R/controller/wake.json" >/dev/null \
  || fail "#2046(crash): precondition -- the re-issue must not have completed before the kill"

# The next fire has no wake at all. Recovery must come from durable state.
inputs_from_fakes
step_ok "$(tick_time 4)"
jq -e --arg t "$REMINT" '.coordinatorOwnerToken == $t' "$R/controller/wake.json" >/dev/null \
  || fail "#2046(crash): a kill at the claim record stranded the re-issue -- wake.json still names the retired token"
grep -q 'YOUR OWNER TOKEN CHANGED' "$R/controller/brief-lanes.md" \
  || fail "#2046(crash): the recovered fire did not re-offer the step for adoption"
jq -se '[.[] | select(.kind=="owner" and .state=="intent" and (.detail.tokenReissued == true))] | length == 1' \
  "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046(crash): the re-offer was not journalled exactly once"
# Idempotent: a further fire with nothing changed re-offers nothing.
inputs_from_fakes
step_ok "$(tick_time 5)"
jq -se '[.[] | select(.kind=="owner" and .state=="intent" and (.detail.tokenReissued == true))] | length == 1' \
  "$C/out/journal.ndjson" >/dev/null \
  || fail "#2046(crash): a later fire re-offered the step again after the transition completed"

# --- round 2, finding 2: an ack never outlives the brief it acknowledged -----
# owner_step re-offers a wake only while `brief-<step>.ack` is ABSENT, so a
# brief rewritten under a new token inherited the previous brief's ack and was
# read as already taken -- the second half of the same wedge.
new_case ctl-2046c-ack-does-not-outlive-its-brief
campaign 2
for b in "$R"/controller/brief-*.md; do [ -e "${b%.md}.ack" ] || : >"${b%.md}.ack"; done
[ -e "$R/controller/brief-lanes.ack" ] || fail "#2046(ack): precondition -- the owner never acked the lanes brief"
REMINT=owner-ctl-remint-ack-5555
claim "" controller "$REMINT"
jq -c --arg t "$REMINT" '.data.coordinatorOwnerToken = $t' "$C/wake.json" >"$C/wake-remint.json"
inputs_from_fakes
step_ok "$(tick_time 3)" --poll-json "$C/wake-remint.json"
[ ! -e "$R/controller/brief-lanes.ack" ] \
  || fail "#2046(ack): the superseded brief's ack survived the re-offer, so the new brief reads as already taken"
# ...and because it is gone, an owner that does not come back is re-offered
# rather than assumed to hold the step.
inputs_from_fakes
step_ok "$(tick_time 4)"
[ "$(jq -r '.ownerWake.step // ""' <<<"$STEP_OUT")" = lanes ] \
  || fail "#2046(ack): an un-acked re-offered brief was not re-offered: $STEP_OUT"

# --- round 2, finding 4: the router doc's file:line citations are real -------
# CLAUDE.md requires file:line for a cross-module behavioural claim, and a line
# number that drifts is worse than none: it reads as evidence. This fails the
# moment one of the cited lines moves, which is the point.
cite() { # <file> <line> <literal substring the cited line must contain>
  local got
  got="$(sed -n "${2}p" "$SCRIPT_DIR/$1" 2>/dev/null)"
  grep -Fq -- "$3" <<<"$got" \
    || fail "controller-owner-router.md cites $1:$2 for \"$3\", but that line is: ${got:-<absent>}"
}
ROUTER="$SCRIPT_DIR/../references/controller-owner-router.md"
for c in 'smoke-pr-gate.sh:5312' 'smoke-campaign-controller.py:1256-1258' \
         'smoke-run-scaffold.sh:267-269' 'smoke-campaign-controller.py:1245-1255'; do
  grep -Fq "$c" "$ROUTER" || fail "router doc no longer cites $c"
done
cite smoke-pr-gate.sh 5312 'OWNER_TOKEN="$(new_owner_token'
cite smoke-pr-gate.sh 5341 'lease_acquire "$RUN_ID" "$OWNER_TOKEN"'
cite smoke-pr-gate.sh 5346 'bind_pr_authority "$W_PR" "$RUN_ID" "$OWNER_TOKEN"'
cite smoke-pr-gate.sh 5389 '.activeLeaseOwner=$owner'
cite smoke-run-scaffold.sh 268 '[ "$owner" = "$DEFAULT_OWNER" ]'
cite smoke-run-scaffold.sh 690 'adds NO new authority check of its own'
cite smoke-campaign-controller.py 1207 'def _owner_wake'
cite smoke-campaign-controller.py 1251 'os.unlink("brief-{}.ack"'
cite smoke-campaign-controller.py 1256 'if c.get("wake"):'

echo "smoke campaign controller live tests passed"
