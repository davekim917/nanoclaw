#!/usr/bin/env bash
# Tests for smoke-controller-shadow-report.py.
#
# Fixture: four campaigns from the replay corpus (testdata/), replayed through
# the controller in shadow exactly as smoke-campaign-replay.py does, then laid
# out the way the live shadow leaves them (one journal, <run>/decisions.ndjson)
# next to a gate state dir holding each run's real verdict and an actuals file
# holding the corpus `actual` blocks. The report must reproduce the replay's
# per-campaign numbers, and each pass bar must flip when its failure is
# injected. `collect` is exercised with a fake gh, a scratch outbound.db and a
# scratch transcript.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REP="$SCRIPT_DIR/smoke-controller-shadow-report.py"
CORPUS="$SCRIPT_DIR/testdata/controller-replay-corpus.ndjson"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export PYTHONDONTWRITEBYTECODE=1

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- fixture: replay four corpus campaigns into a live-shaped shadow dir -----
python3 - "$SCRIPT_DIR" "$CORPUS" "$T" <<'PY'
import importlib.util, json, os, shutil, sys, tempfile
script_dir, corpus, t = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("replay", os.path.join(script_dir, "smoke-campaign-replay.py"))
replay = importlib.util.module_from_spec(spec); spec.loader.exec_module(replay)
wanted = ("pr1495-", "pr1945-", "pr1968-", "pr1606-")
entries = [e for e in map(json.loads, open(corpus)) if "runId" in e and e["runId"][7:14] in wanted]
assert len(entries) == 4, [e["runId"] for e in entries]
ctl = replay.load_controller()
work = tempfile.mkdtemp(dir=t)
shadow, gate = os.path.join(t, "shadow"), os.path.join(t, "gate")
os.makedirs(shadow); os.makedirs(os.path.join(gate, "runs"))
expected, actuals = {}, {}
with open(os.path.join(shadow, "journal.ndjson"), "w") as journal:
    for e in entries:
        s = replay.replay_one(ctl, e, "faithful", work)
        expected[e["runId"]] = s
        out = os.path.join(work, "faithful", e["runId"], "out")
        journal.write(open(os.path.join(out, "journal.ndjson")).read())
        shutil.copytree(os.path.join(out, e["runId"]), os.path.join(shadow, e["runId"]))
        a = e["actual"]
        os.makedirs(os.path.join(gate, "runs", e["runId"]))
        json.dump({"schemaVersion": 1, "runId": e["runId"], "sha": a["verdictSha"], "verdict": a["verdict"],
                   "finishedAt": a["finishedAt"]}, open(os.path.join(gate, "runs", e["runId"], "verdict.json"), "w"))
        actuals[e["runId"]] = dict(a, pr=e["pr"], isFreezePr=e["isFreezePr"])
json.dump(expected, open(os.path.join(t, "expected.json"), "w"))
json.dump(actuals, open(os.path.join(t, "actuals.json"), "w"))
PY

report() { # [extra args]
  python3 "$REP" report --shadow-dir "$T/shadow" --gate-state-dir "$T/gate" --actuals "$T/actuals.json" \
    --since 2026-09-01T00:00:00Z --until 2026-09-30T00:00:00Z --md "$T/r.md" --json "$T/r.json" "$@" >"$T/r.stdout"
}
rj() { jq -r "$1" "$T/r.json"; }

report
[ "$(rj '.campaigns | length')" = 4 ] || fail "four campaigns in the window"
# The report's per-campaign numbers are the replay's.
python3 - "$T" <<'PY' || fail "report diverges from the replay's per-campaign numbers"
import json, sys
t = sys.argv[1]
exp = json.load(open(t + "/expected.json"))
got = {r["runId"]: r for r in json.load(open(t + "/r.json"))["campaigns"]}
keys = ("missedObligations", "issuesMissed", "issuesActual", "issuesController", "falseGo", "controllerVerdict",
        "finishedBy", "escalations", "actualCoordinatorTurns", "duplicateIntents", "duplicateEffects", "ownerWakes",
        "finishLagMin", "rootLagMin")
bad = [(run, k, exp[run][k], got[run][k]) for run in exp for k in keys if exp[run][k] != got[run][k]]
if bad:
    print(bad, file=sys.stderr)
    sys.exit(1)
PY
[ "$(rj '.bars.controllerCausedDuplicates.result')" = PASS ] && [ "$(rj '.bars.falseGo.result')" = PASS ] \
  || fail "clean replay: no duplicates, no false GO"
[ "$(rj '.bars.missedObligations.value')" = 1 ] && rj '.bars.missedObligations.detail[0]' | grep -q "pr1945.*issues x1" \
  || fail "the replay's one missed issue (pr1945) is reported: $(rj '.bars.missedObligations')"
turns="$(jq '[.[] | .actualCoordinatorTurns] | add' "$T/expected.json")"
[ "$(rj '.bars.coordinationReduction.actualCoordinatorTurns')" = "$turns" ] \
  && [ "$(rj '.bars.coordinationReduction.callsAvoided')" = "$(( turns - $(rj '.bars.coordinationReduction.controllerCoordinationWakes') ))" ] \
  || fail "coordination calls avoided = real turns - controller coordination wakes"
[ "$(rj '.bars.liveCampaigns.result')" = PASS ] || fail "four campaigns meet the live-campaign floor"
grep -q '^| Would-be false GO | 0 | 0 | PASS |' "$T/r.md" || fail "markdown carries the bars: $(cat "$T/r.md")"
jq -e '.pass == false and .bars.missedObligations == "FAIL"' "$T/r.stdout" >/dev/null || fail "stdout summary"

# --- window: a campaign finished outside it is not scored -------------------
python3 "$REP" report --shadow-dir "$T/shadow" --gate-state-dir "$T/gate" --actuals "$T/actuals.json" \
  --since 2026-09-10T00:00:00Z --until 2026-09-30T00:00:00Z --json "$T/w.json" >/dev/null
jq -e '[.campaigns[].runId | .[7:14]] == ["pr1945-","pr1968-"]' "$T/w.json" >/dev/null \
  || fail "pr1495 (09-05) and pr1606 (09-08) are outside a 09-10 window: $(jq -c '[.campaigns[].runId]' "$T/w.json")"

# --- injected failures flip their bars --------------------------------------
cp "$T/shadow/journal.ndjson" "$T/journal.bak"
RUN1968="$(jq -r 'keys[] | select(contains("pr1968-"))' "$T/expected.json")"
RUN1606="$(jq -r 'keys[] | select(contains("pr1606-"))' "$T/expected.json")"
# (a) a second intent for one key+attempt = a controller-caused duplicate
jq -c --arg run "$RUN1968" 'select(.runId == $run and .state == "intent" and .kind == "send")' "$T/journal.bak" \
  | head -1 >>"$T/shadow/journal.ndjson"
report
[ "$(rj '.bars.controllerCausedDuplicates.value')" = 1 ] && [ "$(rj '.bars.controllerCausedDuplicates.result')" = FAIL ] \
  || fail "duplicate intent must count: $(rj '.bars.controllerCausedDuplicates')"
cp "$T/journal.bak" "$T/shadow/journal.ndjson"
# (b) a GO finish where the gate's verdict was not GO = would-be false GO
cp "$T/shadow/$RUN1606/decisions.ndjson" "$T/dec.bak"
echo '{"type":"finish","class":"mechanical","reason":"x","verdict":"GO","failedChecks":[],"runId":"'"$RUN1606"'","at":"2026-09-10T00:00:00Z","fire":"f"}' \
  >>"$T/shadow/$RUN1606/decisions.ndjson"
report
[ "$(rj '.bars.falseGo.value')" = 1 ] && rj '.bars.falseGo.detail[0]' | grep -q pr1606 || fail "false GO: $(rj '.bars.falseGo')"
cp "$T/dec.bak" "$T/shadow/$RUN1606/decisions.ndjson"
# (c) a campaign the gate finished that the shadow never claimed = missed
grep -v "\"runId\":\"$RUN1968\"" "$T/journal.bak" >"$T/shadow/journal.ndjson"
report
rj '.bars.missedObligations.detail[]' | grep -q "$RUN1968:claim-not-journaled" || fail "unjournaled campaign is a missed obligation"
cp "$T/journal.bak" "$T/shadow/journal.ndjson"
# (d) no actuals for a campaign: scored incomplete, never a silent pass
jq --arg run "$RUN1606" 'del(.[$run])' "$T/actuals.json" >"$T/actuals.partial.json"
python3 "$REP" report --shadow-dir "$T/shadow" --gate-state-dir "$T/gate" --actuals "$T/actuals.partial.json" \
  --since 2026-09-01T00:00:00Z --json "$T/p.json" >/dev/null
jq -e --arg run "$RUN1606" '.incompleteActuals == [$run] and .bars.coordinationReduction.campaignsWithTurnData == 3' \
  "$T/p.json" >/dev/null || fail "missing actuals are reported: $(jq -c '.incompleteActuals' "$T/p.json")"
# (e) a re-init after the first = a journal treated as empty; fire health counts
mkdir -p "$T/shadow/wrapper"
{
  echo '{"fire":"2026-09-10T00:00:00Z","stepped":true,"initialized":true,"elapsedSeconds":3}'
  echo '{"fire":"2026-09-10T00:10:00Z","stepped":true,"controllerError":"controller_journal_error","elapsedSeconds":2}'
  echo '{"fire":"2026-09-10T00:20:00Z","stepped":false,"skipped":"input fetch failed","elapsedSeconds":11}'
  echo '{"fire":"2026-09-10T00:30:00Z","stepped":true,"initialized":true,"elapsedSeconds":4}'
} >"$T/shadow/wrapper/fires.ndjson"
report
[ "$(rj '.bars.journalTreatedAsEmpty.result')" = FAIL ] || fail "a second init means the journal was treated as empty"
jq -e '.fireHealth | .fires == 4 and .hardErrors == 1 and .journalErrors == 1 and .decisionLess == 1
  and .skippedReasons["input fetch failed"] == 1 and .maxElapsedSeconds == 11' "$T/r.json" >/dev/null \
  || fail "fire health: $(jq -c .fireHealth "$T/r.json")"
rm "$T/shadow/wrapper/fires.ndjson"

# --- collect: gh, outbound.db, transcripts, owner steps ----------------------
C="$T/collect"
RUN=demo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z
OTHER=demo-pr-pr8-bbbbbbbbbbbb-20260918T100500Z
mkdir -p "$C/gate/runs/$RUN" "$C/gate/runs/$OTHER" "$C/sessions/sess-1/.claude-projects/-workspace-agent/subagents" \
  "$C/runs/$RUN/coordinator" "$C/shim"
for r in "$RUN" "$OTHER"; do
  echo '{"runId":"'"$r"'","sha":"aaaa","verdict":"NO_GO","finishedAt":"2026-09-18T11:00:00Z"}' >"$C/gate/runs/$r/verdict.json"
done
cat >"$C/shim/gh" <<'SH'
#!/usr/bin/env bash
case "$1 $2" in
  "pr view") printf '%s\n' '{"comments":[{"createdAt":"2026-09-18T11:01:00Z"},{"createdAt":"2026-09-01T00:00:00Z"}],
    "closedAt":"2026-09-18T11:02:00Z","mergedAt":null,"headRefOid":"aaaa","headRefName":"smoke/freeze-x"}' ;;
  "issue list") printf '%s\n' '[{"number":1,"createdAt":"2026-09-18T10:30:00Z","body":"run demo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"},
    {"number":2,"createdAt":"2026-09-18T10:31:00Z","body":"run demo-pr-pr8-bbbbbbbbbbbb-20260918T100500Z"},
    {"number":3,"createdAt":"2026-09-17T00:00:00Z","body":"old"}]' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$C/shim/gh"
python3 - "$C/sessions/sess-1/outbound.db" "$RUN" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER, timestamp TEXT, kind TEXT, content TEXT)")
rows = [("a", 1, "2026-09-18T10:02:00Z", "chat", "PR #7 root " + sys.argv[2]),
        ("b", 2, "2026-09-18T11:00:30Z", "chat", "verdict https://github.com/acme/app/pull/7"),
        ("c", 3, "2026-09-18T10:03:00Z", "system", sys.argv[2]),
        ("d", 4, "2026-09-18T10:04:00Z", "chat", "unrelated #77"),
        ("e", 5, "2026-09-19T10:04:00Z", "chat", sys.argv[2])]
con.executemany("INSERT INTO messages_out VALUES (?,?,?,?,?)", rows)
con.commit()
PY
{
  echo '{"type":"user","timestamp":"2026-09-18T10:01:00Z","message":{"content":"Script output: {\"runId\":\"'"$RUN"'\"}"}}'
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}'
  echo '{"type":"user","timestamp":"2026-09-18T10:01:05Z","message":{"content":[{"type":"tool_result","content":"x"}]}}'
  echo '{"type":"user","timestamp":"2026-09-18T10:40:00Z","message":{"content":"@Dinesh disposition filed"}}'
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cat runs/'"$RUN"'/x"}}]}}'
  echo '{"type":"user","timestamp":"2026-09-18T10:41:00Z","message":{"content":"Base directory for this skill: '"$RUN"'"}}'
  echo '{"type":"user","timestamp":"2026-09-18T10:50:00Z","message":{"content":"something else"}}'
} >"$C/sessions/sess-1/.claude-projects/-workspace-agent/t.jsonl"
echo '{"type":"user","timestamp":"2026-09-18T10:05:00Z","message":{"content":"'"$RUN"'"}}' \
  >"$C/sessions/sess-1/.claude-projects/-workspace-agent/subagents/s.jsonl"
echo '{"requiredLaneMarkers":["markers/A1.json"]}' >"$C/runs/$RUN/completion-contract.json"
echo prelim >"$C/runs/$RUN/coordinator/preliminary.md"
PATH="$C/shim:$PATH" python3 "$REP" collect --gate-state-dir "$C/gate" --since 2026-09-18T00:00:00Z --repo acme/app \
  --sessions-root "$C/sessions" --run-root "$C/runs" --out "$C/actuals.json"
jq -e --arg run "$RUN" '.[$run] | .postTimes == ["2026-09-18T10:02:00Z","2026-09-18T11:00:30Z"]
  and .prComments == ["2026-09-18T11:01:00Z"] and .issues == ["2026-09-18T10:30:00Z"]
  and .coordinatorTurns == ["2026-09-18T10:01:00Z","2026-09-18T10:40:00Z"]
  and .isFreezePr == true and .closedAt == "2026-09-18T11:02:00Z" and .gaps == []
  and .ownerSteps == {intake:true,lanes:false,preliminary:true,synthesis:false}' "$C/actuals.json" >/dev/null \
  || fail "collect: $(jq -c --arg run "$RUN" '.[$run]' "$C/actuals.json")"
jq -e --arg run "$OTHER" '.[$run].issues == ["2026-09-18T10:31:00Z"]' "$C/actuals.json" >/dev/null \
  || fail "an issue naming another campaign's runId is not credited to this one"
# Without gh or sessions the gaps are named, never silently empty.
python3 "$REP" collect --gate-state-dir "$C/gate" --since 2026-09-18T00:00:00Z --out "$C/bare.json"
jq -e --arg run "$RUN" '.[$run] | (.gaps | length) == 3 and (has("postTimes") | not)' "$C/bare.json" >/dev/null \
  || fail "collect without sources must name its gaps: $(jq -c --arg run "$RUN" '.[$run]' "$C/bare.json")"

echo "smoke controller shadow report tests passed"
