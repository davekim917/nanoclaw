#!/usr/bin/env bash
# Task-script wrapper: one fire of the PR smoke-campaign controller in LIVE mode.
# It replaces the PR gate task's script once the operator cuts over:
#
#   --script 'bash /app/skills/smoke-test/scripts/smoke-controller-live.sh'
#   --prompt <references/controller-owner-router.md>
#
# Live happens only when BOTH hold: this wrapper is the task's script AND the
# gate env file says SMOKE_CONTROLLER_MODE=live. Any other mode (the default
# shadow included) makes this wrapper do nothing at all -- no poll, no claim,
# no effect -- so the env line is the kill switch.
#
# Each fire (the worker, smoke-controller-live-worker.py):
#   1. reads the gate env file AS DATA (the shadow wrapper's rules);
#   2. validates the whole journal (`controller validate`: torn tail, record
#      schema, born and per-record mode) under control.lock. An invalid
#      journal stops the fire BEFORE any gate effect: no progress stamp, no
#      poll, and the fire reports itself as a failure wake;
#   3. on the first live fire, writes <out>/cutover.json naming every run the
#      gate has claimed right now: those finish under the legacy coordinator
#      and the controller never acts on them. Written once, never rewritten;
#   4. queues, durably (wrapper/alarms/), any one-shot gate alarm latch it
#      has not acknowledged (wrapper/latches.json): the alarm a fire lost
#      between the poll returning and the queue write;
#   5. stamps gate `progress` for each controller run, then -- only when the
#      alarm queue is empty -- runs the gate's `poll` with
#      SMOKE_GATE_CLAIMANT=controller, so a new claim is recorded as the
#      controller's (smoke-pr-gate.sh claimant_guard) and its wake -- with the
#      owner token -- reaches only the controller. An alarm wake is queued
#      before its latch is acknowledged;
#   6. reads PR heads (gh), delivery receipts (this session's inbound.db) and,
#      only when a dispatch intent needs reconciling, `ncl tasks list`;
#   7. runs one controller `step` in live mode, which journals every queued
#      alarm; entries the journal holds are then removed from the queue.
#
# Output: the LAST stdout line is always {"wakeAgent":<bool>,"data":{...}}.
# It wakes the owner for exactly two reasons:
#   - a due owner judgment step: data carries {step, runId, brief} (the brief
#     is <run>/controller/brief-<step>.md) for the owner router prompt;
#   - a fire that failed closed: data carries {failure, detail, fire}, and the
#     owner posts ONE operator alarm and takes no campaign action
#     (references/controller-owner-router.md). This is the wrapper's only
#     reporting mechanism -- it posts nothing itself, because a fire that
#     cannot complete cannot be trusted to run a send either.
# Only the two named non-failure ends -- the completed step and the kill
# switch being off -- are wakeAgent:false.
#
# What that does NOT cover, and is accepted: a fire whose whole task script is
# killed prints no line at all, so it reports nothing -- the host discards the
# output and resolves the occurrence `failed` with no wake
# (src/modules/scheduling/host-script.ts:361, 383, 490-499). Only those
# unreported fires feed the failure streak that auto-pauses the series after 8
# and notifies the owner (src/modules/scheduling/recurrence.ts:128-147): a
# REPORTED failure is a wakeAgent:true occurrence, which the container resolves
# completed, so it never counts toward that streak and never backs off. A
# persistent reported fault therefore wakes the owner every fire, by design;
# the owner's per-cause daily send id is what keeps it to one post a day
# (container/agent-runner/src/cli/enqueue-send.ts:24-28, a replay).
#
# Guarantees (as the shadow wrapper, smoke-controller-shadow.sh):
#   - stdout moves to fd 3 on the first line; only final() writes there.
#   - the worker runs under `timeout -k 2 <budget>`; budget
#     SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS (process env only), decimal 1..110,
#     default 100, so the hard kill lands by 112 s, under the runner's 120 s
#     (agent-runner scheduling/task-script.ts). The worker cuts every child's
#     timeout to its own deadline and passes the controller a deadline epoch.
#   - exit status 0 whatever happens.
#   - the wrapper's own writes stay under the out-dir (contained, O_NOFOLLOW).
#     Live effects leave it by design: the gate's state and lease files (poll,
#     progress, finish), GitHub, chat rows in this session's outbound.db, task
#     rows via ncl, and owner briefs under <run-root>/<runId>/controller/.
set -uo pipefail
exec 3>&1 1>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

final() { # <data-json> -- the only write to the runner's stdout
  local data="${1:-}"
  if ! jq -e 'type == "object"' <<<"$data" >/dev/null 2>&1; then
    data="$(jq -cn --arg d "the fire printed no usable summary; see the task's stderr" --arg fire "${NOW:-}" \
      '{failure:"worker-output-invalid",detail:$d,fire:$fire,stepped:false,
        note:"this cause repeats every fire while it persists, so you may have reported it already: post the alarm under the same per-cause daily id, which replays instead of duplicating"}' 2>/dev/null)" ||
      data='{"failure":"worker-output-invalid","detail":"the fire printed no usable summary","stepped":false}'
  fi
  # Two reasons to wake: a well-formed owner step (with {step, runId, brief} on
  # top), or ANY fire that failed closed -- `failure` is the wrapper's whole
  # reporting mechanism, so it must never be rendered as a quiet false.
  jq -cn --argjson d "$data" '
    ($d.ownerWake // null) as $w
    | if ($w | type) == "object" and ($w.step | type) == "string" and ($w.runId | type) == "string"
         and ($w.brief | type) == "string" and $d.stepped == true
      then {wakeAgent:true, data:({step:$w.step, runId:$w.runId, brief:$w.brief} + ($d | del(.ownerWake)))}
      elif ($d.failure | type) == "string" and ($d.failure | length) > 0
      then {wakeAgent:true, data:($d | del(.ownerWake))}
      else {wakeAgent:false, data:$d} end' >&3 2>/dev/null ||
    printf '%s\n' '{"wakeAgent":true,"data":{"failure":"final-line-unrenderable","detail":"the fire summary could not be rendered (jq unavailable or refused)"}}' >&3
  exit 0
}

BUDGET_MAX=110
BUDGET=100
BUDGET_REJECTED=""
RAW_BUDGET="${SMOKE_CONTROLLER_LIVE_BUDGET_SECONDS:-}"
if [ -n "$RAW_BUDGET" ]; then
  if [[ "$RAW_BUDGET" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$RAW_BUDGET" -le "$BUDGET_MAX" ]; then
    BUDGET="$RAW_BUDGET"
  else
    BUDGET_REJECTED="$RAW_BUDGET"
  fi
fi

export SMOKE_CONTROLLER_LIVE_START
SMOKE_CONTROLLER_LIVE_START="$(date +%s)"
export SMOKE_CONTROLLER_LIVE_BUDGET="$BUDGET"
export SMOKE_CONTROLLER_SCRIPT_DIR="$SCRIPT_DIR"
export PYTHONDONTWRITEBYTECODE=1

DATA="$(timeout -k 2 "$BUDGET" python3 "$SCRIPT_DIR/smoke-controller-live-worker.py")"
RC=$?
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "$DATA" ]; then
  # The worker never got to speak. That is a failure like any other, and it
  # carries the same {failure, detail, fire} the worker's own ends do, so
  # final() wakes the owner instead of reporting a silent false.
  case "$RC" in
    124|137) WHY="fire exceeded its budget and was killed"; SLUG="fire-killed" ;;
    *) WHY="wrapper failed before its summary (see stderr)"; SLUG="worker-no-output" ;;
  esac
  DATA="$(jq -cn --argjson rc "$RC" --arg why "$WHY" --arg slug "$SLUG" --arg fire "$NOW" \
    '{mode:null,fire:$fire,stepped:false,skipped:$why,failure:$slug,detail:$why,rc:$rc,
      note:"this cause repeats every fire while it persists, so you may have reported it already: post the alarm under the same per-cause daily id, which replays instead of duplicating"}' 2>/dev/null)"
fi
DATA="$(printf '%s\n' "$DATA" | tail -n 1)"
if [ -n "$BUDGET_REJECTED" ]; then
  DATA="$(jq -c --arg b "$BUDGET_REJECTED" --argjson used "$BUDGET" '. + {budgetRejected:$b,budgetSeconds:$used}' \
    <<<"$DATA" 2>/dev/null)" || DATA=""
fi
final "$DATA"
