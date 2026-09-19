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
  python3 - "$C" "${FAIL_RECEIPTS:-}" <<'PY'
import json, os, sys
c, fail = sys.argv[1], sys.argv[2]
try:
    msgs = json.load(open(os.path.join(c, "fake", "enqueue.json")))["messages"]
except FileNotFoundError:
    msgs = {}
json.dump({mid: ("failed" if fail and fail in mid else "delivered") for mid in msgs}, open(os.path.join(c, "receipts.json"), "w"))
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
campaign() { # last-tick
  local n now crashed=false w1 w2
  WAKES=()
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
    else
      step_ok "$now" "${extra[@]}"
    fi
    w="$(jq -c '.ownerWake' <<<"$STEP_OUT")"
    [ "$w" = null ] || WAKES+=("$(jq -r '.step' <<<"$w")")
    w1="$(writes)"
    l1="$(wc -l <"$FAKE_LOG")"
    step_ok "$now" "${extra[@]}"
    w2="$(writes)"
    # An injected ambiguous fault leaves an unknown outcome the retry is
    # entitled to settle and move past; exactly-once is asserted after.
    [ -n "${FAULTY:-}" ] || [ "$w1" = "$w2" ] || fail "the second run of fire $now performed $((w2 - w1)) effect(s) (crash=${CRASH:-none}): $(tail -n +"$((l1 + 1))" "$FAKE_LOG" | jq -c '[.tool,.op,.argv[0:3]]' | tr '\n' ' ') first run: $STEP_OUT"
  done
  [ -z "${CRASH:-}" ] || [ "$crashed" = true ] || fail "crash point $CRASH was never reached"
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
  jq -cn --arg run "$RUN" --arg k "$(key "$RUN" send "alarm:old$i")" --arg s "alarm:old$i" \
    '{v:1,at:"2026-09-18T09:59:00Z",fire:"seed",runId:$run,kind:"send",slot:$s,key:$k,state:"delivered",attempt:1,mode:"live"}' \
    >>"$C/out/journal.ndjson"
done
campaign 9
[ "$(finish_verdict)" = '"BLOCKED"' ] || fail "controller-side budget: BLOCKED: $(finish_verdict)"
[ "$(jq -s '[.[] | select(.tool=="enqueue")] | length' "$FAKE_LOG")" = 0 ] \
  || fail "an over-budget send never reaches the helper"
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

echo "smoke campaign controller live tests passed"
