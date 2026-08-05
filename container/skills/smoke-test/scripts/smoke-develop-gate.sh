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
# Comma-separated path prefixes that require each service to redeploy. When a
# service's live deploy lags the source SHA, the lag is accepted only if every
# file changed between them falls OUTSIDE that service's paths — the deployed
# artifact is then what a fresh deploy would produce. Unset = strict equality.
# Fixes the stall where a backend-only merge never redeploys the frontend, so
# three-way SHA equality can never happen.
FRONTEND_PATHS="${SMOKE_GATE_FRONTEND_PATHS:-}"
BACKEND_PATHS="${SMOKE_GATE_BACKEND_PATHS:-}"

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
    activeProgressAt: null,
    unsettledSha: null,
    unsettledSince: null,
    unsettledWakeSha: null,
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
     .activeProgressAt=null |
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
  jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" \
    '{ok:true,finishedSha:$sha,runId:$run,verdict:$verdict}'
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
  write_active_file "$RUN_ID" "$(jq -r '.activeSha // empty' <<<"$STATE")" \
    "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" "$PROGRESS_NOW"
  jq -cn --arg run "$RUN_ID" '{ok:true,runId:$run}'
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
  ACTIVE_EPOCH="$(epoch_or_zero "$ACTIVE_STARTED")"
  ACTIVE_AGE="$(( NOW_EPOCH - ACTIVE_EPOCH ))"
  # A run is live while its newest liveness signal (progress stamp, else the
  # start itself) is fresh AND it is under the hard age ceiling. A killed
  # container stops stamping, so the run goes reclaimable after
  # PROGRESS_STALE_SECONDS of silence instead of the full ceiling.
  PROGRESS_EPOCH="$(epoch_or_zero "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")"
  LAST_ACTIVITY_EPOCH="$ACTIVE_EPOCH"
  if [ "$PROGRESS_EPOCH" -gt "$LAST_ACTIVITY_EPOCH" ]; then LAST_ACTIVITY_EPOCH="$PROGRESS_EPOCH"; fi
  QUIET_FOR="$(( NOW_EPOCH - LAST_ACTIVITY_EPOCH ))"
  if [ "$ACTIVE_AGE" -lt "$ACTIVE_STALE_SECONDS" ] && [ "$QUIET_FOR" -lt "$PROGRESS_STALE_SECONDS" ]; then
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
   .activeProgressAt=null |
   .candidateSha=null |
   .candidateFirstSeen=null' <<<"$STATE")"
write_state "$STATE"
write_active_file "$RUN_ID" "$SOURCE_SHA" "$NOW" ""

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
