#!/usr/bin/env bash
# Deterministic pre-task gate for a continuous develop smoke watcher.
# The scheduled-task contract consumes only the final stdout line.
#
# Deployment config is environment-only — no tenant defaults. Deploy a thin
# wrapper in the agent folder that exports SMOKE_GATE_REPO,
# SMOKE_GATE_BACKEND_SERVICE, SMOKE_GATE_FRONTEND_SERVICE, and
# SMOKE_GATE_DEV_URL, then execs this script.
set -u

REPO="${SMOKE_GATE_REPO:-}"
BRANCH="${SMOKE_GATE_BRANCH:-develop}"
BACKEND_SERVICE="${SMOKE_GATE_BACKEND_SERVICE:-}"
FRONTEND_SERVICE="${SMOKE_GATE_FRONTEND_SERVICE:-}"
DEV_URL="${SMOKE_GATE_DEV_URL:-}"
STATE_DIR="${SMOKE_GATE_STATE_DIR:-/workspace/agent/smoke-gate}"
STATE_FILE="$STATE_DIR/develop-state.json"
LOCK_FILE="$STATE_DIR/develop-state.lock"
DEBOUNCE_SECONDS="${SMOKE_GATE_DEBOUNCE_SECONDS:-600}"
# 4h hard ceiling: campaigns finish in 1-3h; a host restart mid-run otherwise
# strands the gate for the full window before recovery can reclaim the SHA.
ACTIVE_STALE_SECONDS="${SMOKE_GATE_ACTIVE_STALE_SECONDS:-14400}"
# Liveness: the coordinator stamps `progress <run-id>` while working. An
# active run whose newest stamp (or start, if never stamped) is older than
# this is treated as dead — catches containers killed at spawn without
# waiting out the hard ceiling.
PROGRESS_STALE_SECONDS="${SMOKE_GATE_PROGRESS_STALE_SECONDS:-1800}"
# Optional campaign wake window, `HH:MM-HH:MM` (may wrap midnight), evaluated
# in SMOKE_GATE_WAKE_TZ. Unset = always open, so no existing deployment
# changes behaviour. This gates only the full-campaign wake: every other
# trigger (develop_unsettled, gate_misconfigured, gate_fetch_failed) still
# fires around the clock, because those are alarms and an alarm you only hear
# at 3am is not an alarm.
WAKE_WINDOW="${SMOKE_GATE_WAKE_WINDOW:-}"
WAKE_TZ="${SMOKE_GATE_WAKE_TZ:-UTC}"
# Optional: on finish, additionally publish the terminal verdict as a small
# JSON artifact at this path (e.g. a shared workgroup file). Downstream
# gates (release promotion) read the artifact — durable file, not chat —
# so a bot message can never carry gate authority.
PUBLISH_FILE="${SMOKE_GATE_PUBLISH_FILE:-}"
# Optional explicit block flag (default-open promotion gating): NO_GO writes
# it, a later GO removes it, BLOCKED/HUMAN_DECISION leave it untouched — an
# infra-blocked run neither raises a false hold nor clears a real one.
# Absence of the file means "no smoke objection", so history predating the
# smoke watcher and watcher downtime never gate a promotion by themselves.
HOLD_FILE="${SMOKE_GATE_HOLD_FILE:-}"
# Optional live-run artifact for merge-queue coordination: written when a run
# is claimed, refreshed by `progress`, removed by `finish`. Carries
# `holdMergesUntil` so a consumer never has to know this gate's timings — and
# so a run that dies without finishing cannot hold the queue forever.
ACTIVE_FILE="${SMOKE_GATE_ACTIVE_FILE:-}"
MERGE_HOLD_SECONDS="${SMOKE_GATE_MERGE_HOLD_SECONDS:-5400}"
# One throttled wake when the same head stays unsettled this long (red CI,
# hung checks, stuck deploys). Without it the watcher waits silently forever —
# fail-quiet, which this gate refuses everywhere else.
UNSETTLED_ALERT_SECONDS="${SMOKE_GATE_UNSETTLED_ALERT_SECONDS:-2700}"
# Optional readiness command run immediately before a campaign is opened, for
# preconditions this gate cannot see: test-account liveness, a seeded fixture,
# a reachable dependency. Exit 0 = go. Non-zero = the campaign never opens and
# the last line of stdout becomes the human-readable reason.
#
# The gate deliberately knows NOTHING about what the command checks or how it
# gets its credentials. That is the point: on 2026-08-09 three unattended
# campaigns ran 03:00-06:00 against eight stale QA logins, failed every browser
# journey, verified nothing, and were discovered by a human at 09:00. The fix
# has to survive the credential architecture changing underneath it — file
# today, derived-from-one-secret with a seed step later — so the seam is a
# command, not a credential format this script would have to learn twice.
#
# It runs AFTER the wake window and BEFORE any state mark, for the same reason
# the window check does: `emit_no_wake` preserves the settled candidate, so the
# first poll after the preconditions are repaired opens the campaign normally.
PREFLIGHT_CMD="${SMOKE_GATE_PREFLIGHT_CMD:-}"
PREFLIGHT_TIMEOUT="${SMOKE_GATE_PREFLIGHT_TIMEOUT:-120}"
# A failing precondition is an alarm, so it wakes — but the condition is not
# SHA-bound the way `develop_unsettled` is (dead accounts stay dead across every
# new head), so a per-SHA one-shot would re-alarm on each merge. Throttle on
# time instead, and re-arm immediately whenever the reason text changes.
PREFLIGHT_ALERT_SECONDS="${SMOKE_GATE_PREFLIGHT_ALERT_SECONDS:-21600}"
# Comma-separated path prefixes that require each service to redeploy. When a
# service's live deploy lags the source SHA, the lag is accepted only if every
# file changed between them falls OUTSIDE that service's paths — the deployed
# artifact is then what a fresh deploy would produce. Unset = strict equality.
# Fixes the stall where a backend-only merge never redeploys the frontend, so
# three-way SHA equality can never happen.
FRONTEND_PATHS="${SMOKE_GATE_FRONTEND_PATHS:-}"
BACKEND_PATHS="${SMOKE_GATE_BACKEND_PATHS:-}"
# `check` runs the poll derivation and reports settledness WITHOUT mutating
# state or claiming anything. It exists for human-requested campaigns, which
# freeze on a person's word rather than on a gate wake and would otherwise
# judge "is this head testable" by eye — the failure that voided the
# 2026-08-07 marketing campaign, whose frozen pair was replaced by a merge
# burst two minutes after the freeze.
READONLY=false

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -w 5 9; then
  jq -cn '{ok:false,settled:false,wakeAgent:true,data:{schemaVersion:1,trigger:"gate_lock_failed"}}'
  exit 0
fi

default_state() {
  jq -cn '{
    schemaVersion: 1,
    candidateSha: null,
    candidateFirstSeen: null,
    activeSha: null,
    activeStartedAt: null,
    activeRunId: null,
    activeProgressAt: null,
    activeMergeHold: null,
    unsettledSha: null,
    unsettledSince: null,
    unsettledWakeSha: null,
    completedSha: null,
    completedAt: null,
    completedRunId: null,
    completedVerdict: null,
    fetchFailures: 0,
    lastFailureWakeAt: null,
    holdAlertFor: null,
    preflightReason: null,
    preflightWakeAt: null
  }'
}

read_state() {
  if [ -s "$STATE_FILE" ] && jq -e 'type == "object"' "$STATE_FILE" >/dev/null 2>&1; then
    jq -c '.' "$STATE_FILE"
  else
    default_state
  fi
}

write_state() {
  local next="$1" tmp
  [ "$READONLY" = true ] && return 0
  tmp="$(mktemp "$STATE_DIR/.develop-state.XXXXXX")"
  printf '%s\n' "$next" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

iso_now() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

epoch_or_zero() {
  local value="$1"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    date -u -d "$value" +%s 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

# `HH:MM-HH:MM` in WAKE_TZ, wrapping midnight when the start is later than the
# end (`22:00-02:00`). Compared in minutes-since-midnight so DST just works:
# the window is a wall-clock statement ("quiet hours"), and re-reading the zone
# every call is what keeps it one after the clocks move. `10#` forces base 10 —
# without it `08` and `09` are invalid octal and the whole gate errors for two
# hours a day, which is exactly the kind of bug that only ever fires at 08:xx.
in_wake_window() {
  local now now_min from to from_min to_min
  # ONE clock read, split locally. Two calls (`+%H` then `+%M`) can straddle an
  # hour boundary — 05:59:59 followed by 06:00:00 reads as 05:00 and reopens a
  # window that just shut. Fires roughly never, and always at the worst minute.
  now="$(TZ="$WAKE_TZ" date +%H:%M)"
  now_min=$(( 10#${now%%:*} * 60 + 10#${now##*:} ))
  from="${WAKE_WINDOW%%-*}"
  to="${WAKE_WINDOW##*-}"
  from_min=$(( 10#${from%%:*} * 60 + 10#${from##*:} ))
  to_min=$(( 10#${to%%:*} * 60 + 10#${to##*:} ))
  if [ "$from_min" -le "$to_min" ]; then
    if [ "$now_min" -ge "$from_min" ] && [ "$now_min" -lt "$to_min" ]; then
      printf 'true'; return 0
    fi
  else
    if [ "$now_min" -ge "$from_min" ] || [ "$now_min" -lt "$to_min" ]; then
      printf 'true'; return 0
    fi
  fi
  printf 'false'
}

# Advisory freeze visibility on the forge itself. Opt-in via
# SMOKE_GATE_FREEZE_STATUS_CONTEXT (unset = off, so no deployment changes).
#
# The merge hold is an artifact inside this fleet, which means it binds only
# agents that read that artifact. Anyone merging from GitHub — a human, or an
# automation on someone's personal token — cannot see it and never could. On
# 2026-08-08 four merges landed 20 minutes into a campaign from exactly there
# and voided it, and the run spent its remaining time investigating a gate
# failure that had not happened.
#
# **State is always `success`, and that is deliberate.** `pending` is the
# semantically obvious choice and it is the wrong one: it lands in
# `statusCheckRollup`, which is what every merge actuator here reads to decide
# "CI green" — so an advisory notice would silently become a merge blocker on
# the automated path. The notice lives in the DESCRIPTION; the state stays
# green so nothing that gates on green can ever be moved by it. Advisory by
# construction, not by policy.
#
# Best-effort throughout: a status write must never fail a claim or a verdict.
FREEZE_STATUS_CONTEXT="${SMOKE_GATE_FREEZE_STATUS_CONTEXT:-}"

freeze_status() {
  local desc="$1" heads sha
  [ -n "$FREEZE_STATUS_CONTEXT" ] || return 0
  [ -n "$REPO" ] || return 0
  heads="$(timeout 10 gh pr list -R "$REPO" --base "$BRANCH" --state open \
    --limit 100 --json headRefOid --jq '.[].headRefOid' 2>/dev/null)" || return 0
  for sha in $heads; do
    timeout 6 gh api -X POST "repos/$REPO/statuses/$sha" \
      -f state=success \
      -f context="$FREEZE_STATUS_CONTEXT" \
      -f description="${desc:0:140}" >/dev/null 2>&1 || true
  done
  return 0
}

# Live-run artifact. `holdMergesUntil` is an absolute cap from run start: a run
# that dies without finishing stops holding the merge queue on its own.
write_active_file() {
  [ -n "$ACTIVE_FILE" ] || return 0
  local run="$1" sha="$2" started="$3" progress="$4" tmp
  mkdir -p "$(dirname "$ACTIVE_FILE")"
  tmp="$(mktemp "$(dirname "$ACTIVE_FILE")/.run-active.XXXXXX")"
  jq -cn \
    --arg run "$run" --arg sha "$sha" --arg started "$started" \
    --arg progress "$progress" \
    --arg until "$(date -u -d "@$(( $(epoch_or_zero "$started") + MERGE_HOLD_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" \
    '{schemaVersion:1,runId:$run,sha:$sha,startedAt:$started,
      progressAt:(if $progress == "" then null else $progress end),
      holdMergesUntil:$until}' > "$tmp"
  mv "$tmp" "$ACTIVE_FILE"
}

STATE="$(read_state)"
COMMAND="${1:-poll}"

# `check` is `poll` with every write suppressed and an early exit once
# readiness is known. Reusing the poll derivation is the point: a campaign
# must be judged testable by the SAME rule the watcher uses, not a parallel
# one that can drift away from it.
if [ "$COMMAND" = "check" ]; then
  READONLY=true
  COMMAND=poll
  # Drop the write lock immediately: state has been read once above and a
  # read-only caller never writes. Holding it across `check`'s network fetches
  # (four parallel, plus up to two compares — ~30s worst case) would make a
  # concurrent scheduled poll exhaust its 5s flock wait and emit
  # gate_lock_failed, which spawns the coordinator for nothing.
  flock -u 9
fi

if [ "$COMMAND" = "finish" ]; then
  SHA="${2:-}"
  RUN_ID="${3:-}"
  VERDICT="${4:-}"
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"finish requires a 40-character SHA"}'
    exit 2
  fi
  case "$VERDICT" in
    GO|NO_GO|HUMAN_DECISION|BLOCKED) ;;
    *) jq -cn '{ok:false,error:"finish verdict must be GO, NO_GO, HUMAN_DECISION, or BLOCKED"}'; exit 2 ;;
  esac
  # Only the run that currently owns the slot may record a verdict. Without
  # this, a run reclaimed for being stale can revive and finish late: it would
  # overwrite the completed SHA, null the live successor's active slot
  # mid-flight, and — on GO — delete a promotion hold a different run raised.
  # `progress` has always refused a non-active run; verdict authority is
  # strictly more dangerous and was the only verb still failing open.
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or already finished) — no verdict recorded, no hold touched",
        runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c \
    --arg sha "$SHA" \
    --arg run "$RUN_ID" \
    --arg verdict "$VERDICT" \
    --arg now "$NOW" \
    '.completedSha=$sha |
     .completedAt=$now |
     .completedRunId=$run |
     .completedVerdict=$verdict |
     .activeSha=null |
     .activeStartedAt=null |
     .activeRunId=null |
     .activeProgressAt=null |
     .activeMergeHold=null |
     .candidateSha=null |
     .candidateFirstSeen=null' <<<"$STATE")"
  write_state "$STATE"
  if [ -n "$PUBLISH_FILE" ]; then
    mkdir -p "$(dirname "$PUBLISH_FILE")"
    PUB_TMP="$(mktemp "$(dirname "$PUBLISH_FILE")/.latest-verdict.XXXXXX")"
    jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
      '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now}' > "$PUB_TMP"
    mv "$PUB_TMP" "$PUBLISH_FILE"
  fi
  if [ -n "$HOLD_FILE" ]; then
    case "$VERDICT" in
      NO_GO)
        mkdir -p "$(dirname "$HOLD_FILE")"
        HOLD_TMP="$(mktemp "$(dirname "$HOLD_FILE")/.develop-hold.XXXXXX")"
        jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg now "$NOW" \
          '{schemaVersion:1,sha:$sha,runId:$run,verdict:"NO_GO",raisedAt:$now,
            reason:"confirmed defects on this develop lineage — see the run thread and run directory"}' > "$HOLD_TMP"
        mv "$HOLD_TMP" "$HOLD_FILE"
        ;;
      GO)
        rm -f "$HOLD_FILE"
        ;;
    esac
  fi
  [ -n "$ACTIVE_FILE" ] && rm -f "$ACTIVE_FILE"
  freeze_status "No active QA freeze."
  jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" \
    '{ok:true,finishedSha:$sha,runId:$run,verdict:$verdict}'
  exit 0
fi

# Is the currently-recorded active run still live? Shared by `claim` (refuse to
# stomp a running campaign) and the poll path (reclaim an abandoned one).
active_run_is_live() {
  local started="$1" progress="$2" now_epoch started_epoch progress_epoch last quiet age
  now_epoch="$(date -u +%s)"
  started_epoch="$(epoch_or_zero "$started")"
  progress_epoch="$(epoch_or_zero "$progress")"
  last="$started_epoch"
  if [ "$progress_epoch" -gt "$last" ]; then last="$progress_epoch"; fi
  age="$(( now_epoch - started_epoch ))"
  quiet="$(( now_epoch - last ))"
  if [ "$age" -lt "$ACTIVE_STALE_SECONDS" ] && [ "$quiet" -lt "$PROGRESS_STALE_SECONDS" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# Register a human-requested campaign as the active run. This is the ONLY way a
# chat-initiated campaign becomes stampable: `progress` keys on activeRunId, so
# without a claim a campaign is invisible to the watcher, which then starts a
# competing run on the same environment, browser lease and worktree.
#
# `claim` deliberately carries no verdict authority. It cannot write the hold
# file, the publish artifact, or completedSha — only `finish` does, and a
# campaign that never routed through the gate must never call it. Release with
# `release`, which clears the slot and nothing else.
if [ "$COMMAND" = "claim" ]; then
  RUN_ID="${2:-}"
  SHA="${3:-}"
  MERGE_HOLD="${4:-true}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"claim requires a run id"}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"claim requires the 40-character frozen source SHA"}'
    exit 2
  fi
  case "$MERGE_HOLD" in
    true|false) ;;
    *) jq -cn '{ok:false,error:"claim merge-hold argument must be true or false"}'; exit 2 ;;
  esac
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ -n "$ACTIVE_RUN" ] && [ "$ACTIVE_RUN" != "$RUN_ID" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    jq -cn --arg active "$ACTIVE_RUN" --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
      '{ok:false,error:"another run already owns the environment — wait for it or ask its coordinator",
        activeRunId:$active,activeSha:(if $sha == "" then null else $sha end)}'
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" \
    --argjson hold "$MERGE_HOLD" \
    '.activeSha=$sha |
     .activeStartedAt=$now |
     .activeRunId=$run |
     .activeProgressAt=$now |
     .activeMergeHold=$hold |
     .candidateSha=null |
     .candidateFirstSeen=null' <<<"$STATE")"
  write_state "$STATE"
  # A campaign that wants the build to keep moving (its own browser lanes are
  # blocked, a fix must land) opts out; the watcher is still suppressed either
  # way, which is the part that prevents two runs on one environment.
  if [ "$MERGE_HOLD" = true ]; then
    write_active_file "$RUN_ID" "$SHA" "$NOW" "$NOW"
    freeze_status "QA smoke run active on $BRANCH (${SHA:0:12}) — merging now voids it. Advisory only; you may merge."
  elif [ -n "$ACTIVE_FILE" ]; then
    rm -f "$ACTIVE_FILE"
    freeze_status "No active QA freeze."
  fi
  jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --argjson hold "$MERGE_HOLD" \
    '{ok:true,runId:$run,sha:$sha,mergeHold:$hold}'
  exit 0
fi

# Release the active slot without recording a verdict. Use this to end a
# human-requested campaign: the watcher is free again, no hold is raised, and
# no hold another run raised is cleared.
if [ "$COMMAND" = "release" ]; then
  RUN_ID="${2:-}"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ -z "$RUN_ID" ] || [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run — nothing released",
        runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STATE="$(jq -c '.activeSha=null | .activeStartedAt=null | .activeRunId=null |
                  .activeProgressAt=null | .activeMergeHold=null' <<<"$STATE")"
  write_state "$STATE"
  [ -n "$ACTIVE_FILE" ] && rm -f "$ACTIVE_FILE"
  freeze_status "No active QA freeze."
  jq -cn --arg run "$RUN_ID" '{ok:true,releasedRunId:$run}'
  exit 0
fi

# Liveness stamp. The coordinator calls `progress <run-id>` after the freeze
# and at least every 15 minutes while lanes run. ok:false means the run is no
# longer the active one (reclaimed or finished) — the caller must stop that
# campaign instead of double-running the SHA.
if [ "$COMMAND" = "progress" ]; then
  RUN_ID="${2:-}"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ -z "$RUN_ID" ] || [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or finished) — stop this campaign",
        runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  PROGRESS_NOW="$(iso_now)"
  STATE="$(jq -c --arg now "$PROGRESS_NOW" '.activeProgressAt=$now' <<<"$STATE")"
  write_state "$STATE"
  # A campaign that claimed with merge-hold off stays off. Re-writing the
  # active file here would resurrect the hold it opted out of on the very
  # first stamp — and stamping is mandatory, so the opt-out would never
  # survive 15 minutes. Absent field (scheduled runs, pre-existing state)
  # means hold, which is the safe default.
  MERGE_HOLD="$(jq -r 'if .activeMergeHold == false then "false" else "true" end' <<<"$STATE")"
  if [ "$MERGE_HOLD" = true ]; then
    write_active_file "$RUN_ID" "$(jq -r '.activeSha // empty' <<<"$STATE")" \
      "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" "$PROGRESS_NOW"
  fi
  jq -cn --arg run "$RUN_ID" --argjson hold "$MERGE_HOLD" '{ok:true,runId:$run,mergeHold:$hold}'
  exit 0
fi

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" \
    '{ok:false,error:("unknown command: " + $command),
      commands:["poll","check","claim","release","progress","finish"]}'
  exit 2
fi

# Fail closed on missing deployment config: wake the agent (throttled to one
# wake per 6h) so misconfiguration surfaces as a visible BLOCKED watcher note
# instead of silent wakeAgent:false forever.
MISSING=""
[ -n "$REPO" ] || MISSING="$MISSING SMOKE_GATE_REPO"
[ -n "$BACKEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_BACKEND_SERVICE"
[ -n "$FRONTEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_FRONTEND_SERVICE"
[ -n "$DEV_URL" ] || MISSING="$MISSING SMOKE_GATE_DEV_URL"
if [ -n "$MISSING" ]; then
  LAST_FAILURE_WAKE="$(jq -r '.lastFailureWakeAt // empty' <<<"$STATE")"
  LAST_FAILURE_EPOCH="$(epoch_or_zero "$LAST_FAILURE_WAKE")"
  NOW_EPOCH="$(date -u +%s)"
  WAKE=false
  if [ "$(( NOW_EPOCH - LAST_FAILURE_EPOCH ))" -ge 21600 ]; then
    WAKE=true
    STATE="$(jq -c --arg now "$(iso_now)" '.lastFailureWakeAt=$now' <<<"$STATE")"
  fi
  write_state "$STATE"
  jq -cn --argjson wake "$WAKE" \
    --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_misconfigured",settled:false,missing:$missing}}'
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

timeout 10 gh api "repos/$REPO/branches/$BRANCH" >"$TMP_DIR/branch.json" 2>/dev/null &
PID_BRANCH=$!
timeout 10 gh run list -R "$REPO" --branch "$BRANCH" --limit 100 \
  --json headSha,status,conclusion,workflowName >"$TMP_DIR/checks.json" 2>/dev/null &
PID_CHECKS=$!
timeout 10 curl -fsS "https://api.render.com/v1/services/$BACKEND_SERVICE/deploys?limit=10" \
  >"$TMP_DIR/backend.json" 2>/dev/null &
PID_BACKEND=$!
timeout 10 curl -fsS "https://api.render.com/v1/services/$FRONTEND_SERVICE/deploys?limit=10" \
  >"$TMP_DIR/frontend.json" 2>/dev/null &
PID_FRONTEND=$!

FETCH_OK=true
wait "$PID_BRANCH" || FETCH_OK=false
wait "$PID_CHECKS" || FETCH_OK=false
wait "$PID_BACKEND" || FETCH_OK=false
wait "$PID_FRONTEND" || FETCH_OK=false

SOURCE_SHA="$(jq -r '.commit.sha // empty' "$TMP_DIR/branch.json" 2>/dev/null)"
CHECK_TOTAL="$(jq -r --arg sha "$SOURCE_SHA" '[.[]? | select(.headSha == $sha)] | length' "$TMP_DIR/checks.json" 2>/dev/null)"
CHECK_PENDING="$(jq -r --arg sha "$SOURCE_SHA" '[.[]? | select(.headSha == $sha and .status != "completed")] | length' "$TMP_DIR/checks.json" 2>/dev/null)"
CHECK_FAILED="$(jq -r --arg sha "$SOURCE_SHA" '[.[]? | select(.headSha == $sha) | select((.conclusion // "") as $c | (["success","skipped","neutral"] | index($c) | not))] | length' "$TMP_DIR/checks.json" 2>/dev/null)"
# Any completed successful run counts. Requiring one NAMED workflow here
# ("Frontend CI") deadlocked every backend-only merge forever: the workflow
# is path-filtered, never starts, and a run that never existed reads the
# same as zero. Requiring ≥1 success (rather than deleting the term) keeps
# the gate fail-closed on a head where every triggered workflow was
# path-skipped — CHECK_FAILED allowlists "skipped", so total>0/pending=0/
# failed=0 alone would clear a head with zero CI actually executed.
CHECK_SUCCESS="$(jq -r --arg sha "$SOURCE_SHA" '[.[]? | select(.headSha == $sha and .status == "completed" and .conclusion == "success")] | length' "$TMP_DIR/checks.json" 2>/dev/null)"
BACKEND_SHA="$(jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' "$TMP_DIR/backend.json" 2>/dev/null)"
FRONTEND_SHA="$(jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' "$TMP_DIR/frontend.json" 2>/dev/null)"

if ! printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$BACKEND_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$FRONTEND_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$CHECK_TOTAL" | grep -Eq '^[0-9]+$' ||
   ! printf '%s' "$CHECK_SUCCESS" | grep -Eq '^[0-9]+$'; then
  FETCH_OK=false
fi

if [ "$FETCH_OK" != true ]; then
  FAILURES="$(( $(jq -r '.fetchFailures // 0' <<<"$STATE") + 1 ))"
  if [ "$FAILURES" -gt 3 ]; then FAILURES=3; fi
  STATE="$(jq -c --argjson failures "$FAILURES" '.fetchFailures=$failures' <<<"$STATE")"
  WAKE=false
  if [ "$FAILURES" -ge 3 ]; then
    LAST_FAILURE_WAKE="$(jq -r '.lastFailureWakeAt // empty' <<<"$STATE")"
    LAST_FAILURE_EPOCH="$(epoch_or_zero "$LAST_FAILURE_WAKE")"
    NOW_EPOCH="$(date -u +%s)"
    if [ "$(( NOW_EPOCH - LAST_FAILURE_EPOCH ))" -ge 21600 ]; then
      WAKE=true
      NOW="$(iso_now)"
      STATE="$(jq -c --arg now "$NOW" '.fetchFailures=0 | .lastFailureWakeAt=$now' <<<"$STATE")"
    fi
  fi
  write_state "$STATE"
  jq -cn --argjson wake "$WAKE" --argjson failures "$FAILURES" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_fetch_failed",settled:false,consecutiveFailures:$failures}}'
  exit 0
fi

STATE="$(jq -c '.fetchFailures=0' <<<"$STATE")"
NOW="$(iso_now)"
NOW_EPOCH="$(date -u +%s)"
CI_READY=false
if [ "$CHECK_TOTAL" -gt 0 ] && [ "$CHECK_SUCCESS" -gt 0 ] && [ "$CHECK_PENDING" -eq 0 ] && [ "$CHECK_FAILED" -eq 0 ]; then
  CI_READY=true
fi
# Is a lagging live deploy still the correct artifact for the source SHA?
# True only when the deployed SHA is a strict ancestor of source AND no file
# changed between them touches this service's paths. Fail-closed: unset paths,
# any fetch problem, a non-ancestor state, or a truncated (300-file) compare
# all return false.
deploy_lag_safe() {
  local deployed="$1" paths="$2" out status behind files hits
  [ -n "$paths" ] || { printf 'false'; return; }
  out="$(timeout 10 gh api "repos/$REPO/compare/$deployed...$SOURCE_SHA" 2>/dev/null)" || { printf 'false'; return; }
  status="$(jq -r '.status // empty' <<<"$out" 2>/dev/null)"
  behind="$(jq -r '.behind_by // 1' <<<"$out" 2>/dev/null)"
  [ "$status" = "ahead" ] && [ "$behind" = "0" ] || { printf 'false'; return; }
  files="$(jq -r '.files | length' <<<"$out" 2>/dev/null)"
  printf '%s' "$files" | grep -Eq '^[0-9]+$' || { printf 'false'; return; }
  [ "$files" -lt 300 ] || { printf 'false'; return; }
  hits="$(jq -r --arg p "$paths" '
    [ .files[].filename ] as $files
    | ($p | split(",") | map(select(length > 0))) as $pre
    | [ $files[] as $f | $pre[] as $x | select($f | startswith($x)) ] | length' <<<"$out" 2>/dev/null)"
  printf '%s' "$hits" | grep -Eq '^[0-9]+$' || { printf 'false'; return; }
  if [ "$hits" -eq 0 ]; then printf 'true'; else printf 'false'; fi
}

DEPLOY_READY=false
BACKEND_LAG_ACCEPTED=false
FRONTEND_LAG_ACCEPTED=false
if [ "$SOURCE_SHA" = "$BACKEND_SHA" ] && [ "$SOURCE_SHA" = "$FRONTEND_SHA" ]; then
  DEPLOY_READY=true
elif [ "$CI_READY" = true ]; then
  # Only pay for compare calls once CI has settled on this head.
  BACKEND_OK=false
  FRONTEND_OK=false
  if [ "$SOURCE_SHA" = "$BACKEND_SHA" ]; then
    BACKEND_OK=true
  elif [ "$(deploy_lag_safe "$BACKEND_SHA" "$BACKEND_PATHS")" = true ]; then
    BACKEND_OK=true
    BACKEND_LAG_ACCEPTED=true
  fi
  if [ "$SOURCE_SHA" = "$FRONTEND_SHA" ]; then
    FRONTEND_OK=true
  elif [ "$(deploy_lag_safe "$FRONTEND_SHA" "$FRONTEND_PATHS")" = true ]; then
    FRONTEND_OK=true
    FRONTEND_LAG_ACCEPTED=true
  fi
  if [ "$BACKEND_OK" = true ] && [ "$FRONTEND_OK" = true ]; then DEPLOY_READY=true; fi
fi

# `check` stops here: readiness is known, and everything past this point is
# claim/debounce bookkeeping a read-only caller must not participate in.
# It reports the same CI and deploy facts the watcher acts on, so a campaign
# can quote them in its run record instead of asserting the build settled.
if [ "$READONLY" = true ]; then
  jq -cn \
    --argjson ciReady "$CI_READY" \
    --argjson deployReady "$DEPLOY_READY" \
    --arg sha "$SOURCE_SHA" \
    --arg backend "$BACKEND_SHA" \
    --arg frontend "$FRONTEND_SHA" \
    --arg activeRun "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
    --arg completed "$(jq -r '.completedSha // empty' <<<"$STATE")" \
    --argjson checks "$CHECK_TOTAL" \
    --argjson pending "$CHECK_PENDING" \
    --argjson failed "$CHECK_FAILED" \
    --argjson succeeded "$CHECK_SUCCESS" \
    --argjson backendLag "$BACKEND_LAG_ACCEPTED" \
    --argjson frontendLag "$FRONTEND_LAG_ACCEPTED" \
    '{ok:true,
      settled:($ciReady and $deployReady),
      sourceSha:$sha,
      backendDeploySha:$backend,
      frontendDeploySha:$frontend,
      ciReady:$ciReady,
      deployReady:$deployReady,
      checkCount:$checks,
      pendingChecks:$pending,
      failedChecks:$failed,
      succeededChecks:$succeeded,
      deployLagAccepted:{backend:$backendLag,frontend:$frontendLag},
      activeRunId:(if $activeRun == "" then null else $activeRun end),
      completedSha:(if $completed == "" then null else $completed end)}'
  exit 0
fi

emit_no_wake() {
  local trigger="$1"
  write_state "$STATE"
  jq -cn \
    --arg trigger "$trigger" \
    --arg sha "$SOURCE_SHA" \
    --arg backend "$BACKEND_SHA" \
    --arg frontend "$FRONTEND_SHA" \
    --argjson checks "$CHECK_TOTAL" \
    '{wakeAgent:false,data:{schemaVersion:1,trigger:$trigger,sourceSha:$sha,backendDeploySha:$backend,frontendDeploySha:$frontend,checkCount:$checks}}'
}

if [ "$CI_READY" != true ] || [ "$DEPLOY_READY" != true ]; then
  # Track how long THIS head has been unsettled and wake once when it exceeds
  # the alert window, so a red or hung develop is never silent. One wake per
  # SHA: a new head resets the alert, a stuck head never re-spams.
  if [ "$(jq -r '.unsettledSha // empty' <<<"$STATE")" != "$SOURCE_SHA" ]; then
    STATE="$(jq -c --arg sha "$SOURCE_SHA" --arg now "$NOW" \
      '.unsettledSha=$sha | .unsettledSince=$now' <<<"$STATE")"
  fi
  STUCK_FOR="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.unsettledSince // empty' <<<"$STATE")") ))"
  if [ "$STUCK_FOR" -ge "$UNSETTLED_ALERT_SECONDS" ] &&
     [ "$(jq -r '.unsettledWakeSha // empty' <<<"$STATE")" != "$SOURCE_SHA" ]; then
    STATE="$(jq -c --arg sha "$SOURCE_SHA" '.unsettledWakeSha=$sha' <<<"$STATE")"
    write_state "$STATE"
    FAILED_WORKFLOWS="$(jq -c --arg sha "$SOURCE_SHA" \
      '[.[]? | select(.headSha == $sha)
        | select((.conclusion // "") as $c | (["success","skipped","neutral"] | index($c) | not))
        | .workflowName] | unique' "$TMP_DIR/checks.json" 2>/dev/null)"
    printf '%s' "$FAILED_WORKFLOWS" | jq -e 'type == "array"' >/dev/null 2>&1 || FAILED_WORKFLOWS='[]'
    jq -cn \
      --arg sha "$SOURCE_SHA" \
      --arg backend "$BACKEND_SHA" \
      --arg frontend "$FRONTEND_SHA" \
      --argjson failedWorkflows "$FAILED_WORKFLOWS" \
      --argjson failed "$CHECK_FAILED" \
      --argjson pending "$CHECK_PENDING" \
      --argjson stuck "$STUCK_FOR" \
      '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_unsettled",
        sourceSha:$sha,backendDeploySha:$backend,frontendDeploySha:$frontend,
        failedChecks:$failed,pendingChecks:$pending,failedWorkflows:$failedWorkflows,
        backendDeployLag:($backend != $sha),frontendDeployLag:($frontend != $sha),
        unsettledForSeconds:$stuck}}'
    exit 0
  fi
  emit_no_wake "waiting_for_settled_build"
  exit 0
fi

# Hold-file reconciliation. The hold lives on the shared workgroup mount so the
# release desk can read it, which means every sibling can also delete or edit
# it — including the builders whose promotion it blocks, under a standing
# "bias to build" mandate. The gate's own ledger is private and authoritative,
# so it can tell when the projection stopped matching: a NO_GO ledger with no
# hold file means the objection was cleared by something that is not this gate.
# Detection, not prevention — but it converts a silent hole into one visible
# wake instead of a promotion nobody knows was ungated.
HOLD_INTEGRITY=ok
if [ -n "$HOLD_FILE" ]; then
  LEDGER_VERDICT="$(jq -r '.completedVerdict // empty' <<<"$STATE")"
  LEDGER_RUN="$(jq -r '.completedRunId // empty' <<<"$STATE")"
  case "$LEDGER_VERDICT" in
    NO_GO)
      if [ ! -s "$HOLD_FILE" ]; then
        HOLD_INTEGRITY=missing
      elif [ "$(jq -r '.runId // empty' "$HOLD_FILE" 2>/dev/null)" != "$LEDGER_RUN" ]; then
        HOLD_INTEGRITY=mismatched
      fi
      ;;
    GO)
      [ -s "$HOLD_FILE" ] && HOLD_INTEGRITY=unexpected
      ;;
    # BLOCKED / HUMAN_DECISION deliberately leave the hold untouched, so the
    # ledger implies no expectation and there is nothing to reconcile.
  esac
fi
if [ "$HOLD_INTEGRITY" != ok ] &&
   [ "$(jq -r '.holdAlertFor // empty' <<<"$STATE")" != "$HOLD_INTEGRITY" ]; then
  STATE="$(jq -c --arg s "$HOLD_INTEGRITY" '.holdAlertFor=$s' <<<"$STATE")"
  write_state "$STATE"
  jq -cn --arg state "$HOLD_INTEGRITY" --arg run "$(jq -r '.completedRunId // empty' <<<"$STATE")" \
    --arg verdict "$(jq -r '.completedVerdict // empty' <<<"$STATE")" \
    '{wakeAgent:true,data:{schemaVersion:1,trigger:"gate_hold_tampered",
      holdIntegrity:$state,ledgerVerdict:$verdict,ledgerRunId:$run}}'
  exit 0
fi
[ "$HOLD_INTEGRITY" = ok ] &&
  STATE="$(jq -c '.holdAlertFor=null' <<<"$STATE")"

# Settled: clear the stuck-head alert so the next stall alerts again.
STATE="$(jq -c '.unsettledSha=null | .unsettledSince=null | .unsettledWakeSha=null' <<<"$STATE")"

COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
ACTIVE_STARTED="$(jq -r '.activeStartedAt // empty' <<<"$STATE")"
CANDIDATE_SHA="$(jq -r '.candidateSha // empty' <<<"$STATE")"
CANDIDATE_FIRST="$(jq -r '.candidateFirstSeen // empty' <<<"$STATE")"

if [ "$COMPLETED_SHA" = "$SOURCE_SHA" ]; then
  emit_no_wake "already_completed"
  exit 0
fi

if [ -n "$ACTIVE_SHA" ]; then
  # A run is live while its newest liveness signal (progress stamp, else the
  # start itself) is fresh AND it is under the hard age ceiling. A killed
  # container stops stamping, so the run goes reclaimable after
  # PROGRESS_STALE_SECONDS of silence instead of the full ceiling. Shared with
  # `claim` so a campaign and the watcher can never disagree about liveness.
  if [ "$(active_run_is_live "$ACTIVE_STARTED" \
            "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    if [ "$ACTIVE_SHA" != "$SOURCE_SHA" ]; then
      if [ "$CANDIDATE_SHA" != "$SOURCE_SHA" ]; then
        STATE="$(jq -c --arg sha "$SOURCE_SHA" --arg now "$NOW" '.candidateSha=$sha | .candidateFirstSeen=$now' <<<"$STATE")"
      fi
      emit_no_wake "queued_behind_active_run"
    else
      emit_no_wake "already_active"
    fi
    exit 0
  fi
fi

RECOVERY=false
ABANDONED_SHA=""
if [ -n "$ACTIVE_SHA" ]; then
  RECOVERY=true
  ABANDONED_SHA="$ACTIVE_SHA"
fi

if [ "$CANDIDATE_SHA" != "$SOURCE_SHA" ]; then
  STATE="$(jq -c --arg sha "$SOURCE_SHA" --arg now "$NOW" '.candidateSha=$sha | .candidateFirstSeen=$now' <<<"$STATE")"
  emit_no_wake "debouncing_candidate"
  exit 0
fi

CANDIDATE_EPOCH="$(epoch_or_zero "$CANDIDATE_FIRST")"
CANDIDATE_AGE="$(( NOW_EPOCH - CANDIDATE_EPOCH ))"
if [ "$CANDIDATE_AGE" -lt "$DEBOUNCE_SECONDS" ]; then
  emit_no_wake "debouncing_candidate"
  exit 0
fi

# Campaign wake window. This check sits AFTER the debounce and BEFORE any
# state is marked, and the ordering is the whole design: `emit_no_wake` writes
# STATE, so the settled candidate survives untouched and the first poll inside
# the window fires on whatever develop has settled on by then. Suppressing the
# wake after `.activeSha` were set would strand the SHA as an active run with
# nobody testing it — the gate would then have to time it out before anything
# could run again.
if [ -n "$WAKE_WINDOW" ] && [ "$(in_wake_window)" != true ]; then
  emit_no_wake "outside_wake_window"
  exit 0
fi

# Campaign preconditions. Everything above this line proves the BUILD is
# testable; this proves the harness can actually test it. A campaign that opens
# without its test accounts still freezes the environment, still holds the merge
# queue for 90 minutes, and still produces a verdict-shaped nothing.
if [ -n "$PREFLIGHT_CMD" ]; then
  PREFLIGHT_OUT="$TMP_DIR/preflight.out"
  if timeout "$PREFLIGHT_TIMEOUT" bash -c "$PREFLIGHT_CMD" >"$PREFLIGHT_OUT" 2>&1; then
    :
  else
    PREFLIGHT_RC=$?
    # Last non-empty line, trimmed — the command's own summary of what is wrong.
    PREFLIGHT_REASON="$(grep -v '^[[:space:]]*$' "$PREFLIGHT_OUT" 2>/dev/null | tail -1 | cut -c1-300)"
    [ -n "$PREFLIGHT_REASON" ] || PREFLIGHT_REASON="preflight command exited $PREFLIGHT_RC with no output"
    [ "$PREFLIGHT_RC" -eq 124 ] && PREFLIGHT_REASON="preflight timed out after ${PREFLIGHT_TIMEOUT}s: $PREFLIGHT_REASON"
    LAST_REASON="$(jq -r '.preflightReason // empty' <<<"$STATE")"
    SINCE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.preflightWakeAt // empty' <<<"$STATE")") ))"
    if [ "$PREFLIGHT_REASON" != "$LAST_REASON" ] || [ "$SINCE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
      STATE="$(jq -c --arg r "$PREFLIGHT_REASON" --arg now "$NOW" \
        '.preflightReason=$r | .preflightWakeAt=$now' <<<"$STATE")"
      write_state "$STATE"
      jq -cn \
        --arg reason "$PREFLIGHT_REASON" \
        --arg sha "$SOURCE_SHA" \
        --argjson rc "$PREFLIGHT_RC" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:"preflight_failed",
          sourceSha:$sha,reason:$reason,exitCode:$rc}}'
      exit 0
    fi
    # Already alarmed on this exact reason inside the throttle window. Refuse
    # the campaign silently rather than waking every poll for the same news.
    STATE="$(jq -c --arg r "$PREFLIGHT_REASON" '.preflightReason=$r' <<<"$STATE")"
    emit_no_wake "preflight_failed"
    exit 0
  fi
  # Passed — clear the latch so the next failure alarms immediately instead of
  # inheriting a throttle window from an outage that is already repaired.
  STATE="$(jq -c '.preflightReason=null | .preflightWakeAt=null' <<<"$STATE")"
fi

PREVIOUS_SHA="$COMPLETED_SHA"
if [ -z "$PREVIOUS_SHA" ]; then
  PREVIOUS_SHA="$(timeout 8 gh api "repos/$REPO/commits/$SOURCE_SHA" --jq '.parents[0].sha // empty' 2>/dev/null || true)"
fi
# Run ids are second-granular, so reclaiming an abandoned run on the SAME SHA
# inside one second would reissue the SAME id — and then the zombie container's
# `progress` and `finish` would match the new active run and be accepted,
# silently defeating the not-the-active-run guards. Walk the timestamp forward
# until the id is distinct from both the run being replaced and the last
# completed one. Preserves the id format; costs a second at most.
RUN_STAMP_EPOCH="$(date -u +%s)"
RUN_ID="${SMOKE_GATE_RUN_PREFIX:-smoke}-${SOURCE_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
while [ "$RUN_ID" = "$(jq -r '.activeRunId // empty' <<<"$STATE")" ] ||
      [ "$RUN_ID" = "$(jq -r '.completedRunId // empty' <<<"$STATE")" ]; do
  RUN_STAMP_EPOCH="$(( RUN_STAMP_EPOCH + 1 ))"
  RUN_ID="${SMOKE_GATE_RUN_PREFIX:-smoke}-${SOURCE_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
done
STATE="$(jq -c \
  --arg sha "$SOURCE_SHA" \
  --arg now "$NOW" \
  --arg run "$RUN_ID" \
  '.activeSha=$sha |
   .activeStartedAt=$now |
   .activeRunId=$run |
   .activeProgressAt=null |
   .activeMergeHold=true |
   .candidateSha=null |
   .candidateFirstSeen=null' <<<"$STATE")"
write_state "$STATE"
write_active_file "$RUN_ID" "$SOURCE_SHA" "$NOW" ""
freeze_status "QA smoke run active on $BRANCH (${SOURCE_SHA:0:12}) — merging now voids it. Advisory only; you may merge."

jq -cn \
  --arg repo "$REPO" \
  --arg branch "$BRANCH" \
  --arg sha "$SOURCE_SHA" \
  --arg previous "$PREVIOUS_SHA" \
  --arg backend "$BACKEND_SHA" \
  --arg frontend "$FRONTEND_SHA" \
  --arg devUrl "$DEV_URL" \
  --arg runId "$RUN_ID" \
  --arg abandoned "$ABANDONED_SHA" \
  --argjson checks "$CHECK_TOTAL" \
  --argjson recovery "$RECOVERY" \
  --argjson backendLag "$BACKEND_LAG_ACCEPTED" \
  --argjson frontendLag "$FRONTEND_LAG_ACCEPTED" \
  '{wakeAgent:true,data:{
    schemaVersion:1,
    trigger:"develop_build_settled",
    repo:$repo,
    branch:$branch,
    runId:$runId,
    sourceSha:$sha,
    previousCompletedSha:(if $previous == "" then null else $previous end),
    backendDeploySha:$backend,
    frontendDeploySha:$frontend,
    devUrl:$devUrl,
    checkCount:$checks,
    recovery:$recovery,
    abandonedActiveSha:(if $abandoned == "" then null else $abandoned end),
    deployLagAccepted:{backend:$backendLag,frontend:$frontendLag}
  }}'
