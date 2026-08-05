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
# 4h: campaigns finish in 1-3h; a host restart mid-run otherwise strands the
# gate for the full window before the recovery wake can reclaim the SHA.
ACTIVE_STALE_SECONDS="${SMOKE_GATE_ACTIVE_STALE_SECONDS:-14400}"

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -w 5 9; then
  jq -cn '{wakeAgent:true,data:{schemaVersion:1,trigger:"gate_lock_failed"}}'
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
    completedSha: null,
    completedAt: null,
    completedRunId: null,
    completedVerdict: null,
    fetchFailures: 0,
    lastFailureWakeAt: null
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

STATE="$(read_state)"
COMMAND="${1:-poll}"

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
     .candidateSha=null |
     .candidateFirstSeen=null' <<<"$STATE")"
  write_state "$STATE"
  jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" \
    '{ok:true,finishedSha:$sha,runId:$run,verdict:$verdict}'
  exit 0
fi

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" '{ok:false,error:("unknown command: " + $command)}'
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
    '{wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_misconfigured",missing:$missing}}'
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
FRONTEND_CHECKS="$(jq -r --arg sha "$SOURCE_SHA" '[.[]? | select(.headSha == $sha and .workflowName == "Frontend CI" and .status == "completed" and .conclusion == "success")] | length' "$TMP_DIR/checks.json" 2>/dev/null)"
BACKEND_SHA="$(jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' "$TMP_DIR/backend.json" 2>/dev/null)"
FRONTEND_SHA="$(jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' "$TMP_DIR/frontend.json" 2>/dev/null)"

if ! printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$BACKEND_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$FRONTEND_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
   ! printf '%s' "$CHECK_TOTAL" | grep -Eq '^[0-9]+$' ||
   ! printf '%s' "$FRONTEND_CHECKS" | grep -Eq '^[0-9]+$'; then
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
    '{wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_fetch_failed",consecutiveFailures:$failures}}'
  exit 0
fi

STATE="$(jq -c '.fetchFailures=0' <<<"$STATE")"
NOW="$(iso_now)"
NOW_EPOCH="$(date -u +%s)"
CI_READY=false
if [ "$CHECK_TOTAL" -gt 0 ] && [ "$FRONTEND_CHECKS" -gt 0 ] && [ "$CHECK_PENDING" -eq 0 ] && [ "$CHECK_FAILED" -eq 0 ]; then
  CI_READY=true
fi
DEPLOY_READY=false
if [ "$SOURCE_SHA" = "$BACKEND_SHA" ] && [ "$SOURCE_SHA" = "$FRONTEND_SHA" ]; then
  DEPLOY_READY=true
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
  emit_no_wake "waiting_for_settled_build"
  exit 0
fi

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
  ACTIVE_EPOCH="$(epoch_or_zero "$ACTIVE_STARTED")"
  ACTIVE_AGE="$(( NOW_EPOCH - ACTIVE_EPOCH ))"
  if [ "$ACTIVE_AGE" -lt "$ACTIVE_STALE_SECONDS" ]; then
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

PREVIOUS_SHA="$COMPLETED_SHA"
if [ -z "$PREVIOUS_SHA" ]; then
  PREVIOUS_SHA="$(timeout 8 gh api "repos/$REPO/commits/$SOURCE_SHA" --jq '.parents[0].sha // empty' 2>/dev/null || true)"
fi
RUN_ID="${SMOKE_GATE_RUN_PREFIX:-smoke}-${SOURCE_SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
STATE="$(jq -c \
  --arg sha "$SOURCE_SHA" \
  --arg now "$NOW" \
  --arg run "$RUN_ID" \
  '.activeSha=$sha |
   .activeStartedAt=$now |
   .activeRunId=$run |
   .candidateSha=null |
   .candidateFirstSeen=null' <<<"$STATE")"
write_state "$STATE"

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
    abandonedActiveSha:(if $abandoned == "" then null else $abandoned end)
  }}'
