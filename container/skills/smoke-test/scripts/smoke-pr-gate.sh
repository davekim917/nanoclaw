#!/usr/bin/env bash
# Deterministic pre-task gate for PR-scoped Render preview smoke campaigns.
# Sibling of smoke-develop-gate.sh: same env-only config, jq-composed state,
# flock, fail-closed fetches, one-line JSON stdout contract, throttled alarms.
#
# The develop gate serializes on ONE shared environment (the wake window,
# merge hold, qa/freeze status, and run-active file all exist only to protect
# that one mutable thing from the ~50 merges/day landing on it). A PR preview
# is immutable-by-construction from everyone except the PR author, so none of
# that machinery applies here: NO develop-hold file, NO freeze status, NO
# merge-hold/active-file, NO wake window. State is instead split per PR (one
# state file + one flock per PR number) so unrelated PRs never contend, and
# `poll` may find several PRs settled at once but emits at most ONE wake per
# call — the coordinator that consumes the wake is serial, same as develop.
#
# See groups/_ops/specs/fleet-hardening/phase5-preview-envs.md for the full
# design and the live Render verification behind every rule below.
set -u

REPO="${SMOKE_GATE_REPO:-}"
BRANCH="${SMOKE_GATE_BRANCH:-develop}"
BACKEND_SERVICE="${SMOKE_GATE_BACKEND_SERVICE:-}"
FRONTEND_SERVICE="${SMOKE_GATE_FRONTEND_SERVICE:-}"
LABEL="${SMOKE_GATE_LABEL:-render-preview}"
STATE_DIR="${SMOKE_GATE_STATE_DIR:-/workspace/agent/smoke-gate}"
RUN_PREFIX="${SMOKE_GATE_RUN_PREFIX:-smoke}"
# Ported verbatim from smoke-develop-gate.sh — a claimed run is live while its
# newest liveness signal is fresh AND under the hard age ceiling. Not called
# out as a separate contract knob because it is the same plumbing every claim/
# progress/release/finish verb already depends on across both gates.
ACTIVE_STALE_SECONDS="${SMOKE_GATE_ACTIVE_STALE_SECONDS:-14400}"
PROGRESS_STALE_SECONDS="${SMOKE_GATE_PROGRESS_STALE_SECONDS:-1800}"
# Same seam as the develop gate: one command run immediately before a
# campaign opens, for preconditions the gate cannot see. Runs once per poll,
# only when a settle candidate has actually been chosen — never per PR.
PREFLIGHT_CMD="${SMOKE_GATE_PREFLIGHT_CMD:-}"
PREFLIGHT_TIMEOUT="${SMOKE_GATE_PREFLIGHT_TIMEOUT:-120}"
PREFLIGHT_ALERT_SECONDS="${SMOKE_GATE_PREFLIGHT_ALERT_SECONDS:-21600}"
PREFLIGHT_REARM_FLOOR_SECONDS="${SMOKE_GATE_PREFLIGHT_REARM_FLOOR_SECONDS:-900}"
# Verified spike budget: a preview boots `live` at port-bind but /healthz can
# report {"status":"warming"} for ~6-10 minutes while caches hydrate onto a
# fresh disk. Below this ceiling, "still warming" is normal and silent. At or
# past it, a backend stuck warming this long is worth one throttled alarm.
WARMUP_TIMEOUT="${SMOKE_GATE_WARMUP_TIMEOUT:-600}"

CONTROL_FILE="$STATE_DIR/control.json"
CONTROL_LOCK="$STATE_DIR/control.lock"
# Most CONTROL_LOCK call sites use `flock -w 5 8 || true` — best-effort, not
# fail-closed like the per-PR locks. Accepted: under rare contention (two
# concurrent polls hitting the same misconfig/fetch-failure/preflight edge at
# once) the worst case is a duplicate throttled alarm, never a lost or
# corrupted write — informational, not correctness-critical. `claim`'s use of
# this lock is the one exception and DOES fail closed (see below), because it
# guards a real write (cross-PR run-id uniqueness), not just an alarm stamp.

# Deployment-specific path conventions from the design doc — not exposed as
# env because they are facts about this repo's layout, not gate policy.
FRONTEND_PREFIX="XZO-FRONTEND/"
MIGRATIONS_PREFIX="XZO-BACKEND/migrations/"
FREEZE_MARKER_BACKEND="XZO-BACKEND/.render-freeze"
FREEZE_MARKER_FRONTEND="XZO-FRONTEND/.render-freeze"

mkdir -p "$STATE_DIR"

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

pr_state_file() { printf '%s/pr-%s-state.json' "$STATE_DIR" "$1"; }
pr_lock_file()  { printf '%s/pr-%s-state.lock' "$STATE_DIR" "$1"; }
pr_verdict_file() { printf '%s/pr-%s-verdict.json' "$STATE_DIR" "$1"; }

default_pr_state() {
  jq -cn --argjson pr "$1" '{
    schemaVersion: 1,
    pr: $pr,
    activeSha: null,
    activeStartedAt: null,
    activeRunId: null,
    activeProgressAt: null,
    completedSha: null,
    completedAt: null,
    completedRunId: null,
    completedVerdict: null,
    deployLiveSha: null,
    deployLiveSince: null,
    warmupAlertSha: null,
    refusedAlertSha: null
  }'
}

read_pr_state() {
  local n="$1" f
  f="$(pr_state_file "$n")"
  if [ -s "$f" ] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
    jq -c '.' "$f"
  else
    default_pr_state "$n"
  fi
}

write_pr_state() {
  local n="$1" next="$2" tmp
  tmp="$(mktemp "$STATE_DIR/.pr-$n-state.XXXXXX")"
  printf '%s\n' "$next" > "$tmp"
  mv "$tmp" "$(pr_state_file "$n")"
}

default_control() {
  jq -cn '{
    schemaVersion: 1,
    fetchFailures: 0,
    lastFailureWakeAt: null,
    lastMisconfigWakeAt: null,
    preflightReason: null,
    preflightWakeAt: null
  }'
}

read_control() {
  if [ -s "$CONTROL_FILE" ] && jq -e 'type == "object"' "$CONTROL_FILE" >/dev/null 2>&1; then
    jq -c '.' "$CONTROL_FILE"
  else
    default_control
  fi
}

write_control() {
  local next="$1" tmp
  tmp="$(mktemp "$STATE_DIR/.control.XXXXXX")"
  printf '%s\n' "$next" > "$tmp"
  mv "$tmp" "$CONTROL_FILE"
}

# Same age/liveness rule as smoke-develop-gate.sh: fresh while the newest
# liveness signal is within PROGRESS_STALE_SECONDS AND overall age is under
# ACTIVE_STALE_SECONDS.
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

# Find which PR's state file currently owns a given run id. `claim` lets the
# caller pick an arbitrary run-id, so `progress`/`release`/`finish` — which
# take only a run-id, no PR number, per the gate's command contract — recover
# the PR by scanning. Reads are unlocked (best-effort); the caller re-checks
# under that PR's own lock before mutating, so a race here just means a
# retry, never a wrong write.
find_pr_for_run() {
  local run_id="$1" f pr
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.activeRunId // empty' "$f" 2>/dev/null)" = "$run_id" ]; then
      pr="$(jq -r '.pr' "$f" 2>/dev/null)"
      [ -n "$pr" ] && [ "$pr" != "null" ] && { printf '%s' "$pr"; return 0; }
    fi
  done
  return 1
}

# Fetch every service on the account once per evaluation. Render's list API
# wraps items as {service:{...}} on some endpoints and bare elsewhere, same
# ambiguity the develop gate already defends against for /deploys — `(.service
# // .)` covers both.
# ponytail: limit=100, no cursor pagination. The account runs a handful of
# services; add pagination if the account ever exceeds one page.
fetch_services() {
  timeout 10 curl -fsS --max-time 10 "https://api.render.com/v1/services?limit=100" 2>/dev/null
}

find_preview() {
  local services_json="$1" parent_id="$2" pr="$3"
  jq -c --arg pid "$parent_id" --arg suffix "PR #$pr" '
    [.[]? | (.service // .) | select(.serviceDetails.parentServer.id == $pid) | select(.name | endswith($suffix))][0] // null
  ' <<<"$services_json" 2>/dev/null
}

latest_live_deploy_sha() {
  local service_id="$1" out
  out="$(timeout 10 curl -fsS --max-time 10 "https://api.render.com/v1/services/$service_id/deploys?limit=5" 2>/dev/null)" || return 1
  jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' <<<"$out" 2>/dev/null
}

healthz_ok() {
  local url="$1" code
  [ -n "$url" ] && [ "$url" != "null" ] || return 1
  code="$(timeout 10 curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${url%/}/healthz" 2>/dev/null)" || return 1
  [ "$code" = "200" ]
}

# Core settle computation for one PR — shared by `check` (read-only) and
# `poll` (per-candidate evaluation). Every fetch is timeout-bounded; any hard
# failure or truncated (>=100, same ceiling smoke-develop-gate.sh uses for its
# 300-file compare guard) file/check-run listing fails closed in the SAFER
# direction: migrations-touched and frontend-touched default to true, CI
# defaults to not-ready. Prints one JSON facts line.
evaluate_pr() {
  local pr="$1" head_sha="$2"
  local files_json files_len files_fetch_failed migrations_touched frontend_touched is_freeze ci_sha
  local checks_json ci_total ci_pending ci_failed ci_succeeded ci_ready ci_truncated
  local services_json backend backend_id backend_url backend_deploy_sha backend_ready
  local frontend frontend_id frontend_url frontend_deploy_sha frontend_ready
  local healthz_ready settled fetch_ok=true

  files_fetch_failed=false
  if ! files_json="$(timeout 10 gh api "repos/$REPO/pulls/$pr/files?per_page=100" 2>/dev/null)" ||
     ! jq -e 'type == "array"' <<<"$files_json" >/dev/null 2>&1; then
    fetch_ok=false
    files_json='[]'
    files_fetch_failed=true
  fi
  files_len="$(jq -r 'length' <<<"$files_json" 2>/dev/null || printf 0)"
  if [ "$files_fetch_failed" = true ] || { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
    # Truncated OR the fetch itself failed — cannot prove either path was NOT
    # touched. Fail closed on both: assume migrations touched (refuse) and
    # frontend touched (require the frontend preview too). Before this fix
    # the fetch-failure path fell through to the empty-array branch below,
    # which computed both as false — the exact fail-OPEN bug this comment
    # already promised was impossible (P1-2, confirmed live 2026-08-12).
    migrations_touched=true
    frontend_touched=true
  else
    migrations_touched="$(jq -r --arg p "$MIGRATIONS_PREFIX" 'any(.[].filename; startswith($p))' <<<"$files_json" 2>/dev/null)"
    frontend_touched="$(jq -r --arg p "$FRONTEND_PREFIX" 'any(.[].filename; startswith($p))' <<<"$files_json" 2>/dev/null)"
    [ "$migrations_touched" = true ] || [ "$migrations_touched" = false ] || migrations_touched=true
    [ "$frontend_touched" = true ] || [ "$frontend_touched" = false ] || frontend_touched=true
  fi
  is_freeze="$(jq -r --arg a "$FREEZE_MARKER_BACKEND" --arg b "$FREEZE_MARKER_FRONTEND" '
    (length == 2) and ((map(.filename) | sort) == ([$a,$b] | sort))
  ' <<<"$files_json" 2>/dev/null)"
  [ "$is_freeze" = true ] || is_freeze=false

  if [ "$is_freeze" = true ]; then
    ci_sha="$(timeout 8 gh api "repos/$REPO/commits/$head_sha" --jq '.parents[0].sha // empty' 2>/dev/null)"
    [ -n "$ci_sha" ] || { ci_sha=""; fetch_ok=false; }
  else
    ci_sha="$head_sha"
  fi

  ci_ready=false
  ci_total=0; ci_pending=0; ci_failed=0; ci_succeeded=0; ci_truncated=false
  if [ -n "$ci_sha" ]; then
    if checks_json="$(timeout 10 gh api "repos/$REPO/commits/$ci_sha/check-runs?per_page=100" 2>/dev/null)" &&
       jq -e '.check_runs | type == "array"' <<<"$checks_json" >/dev/null 2>&1; then
      ci_total="$(jq -r '.check_runs | length' <<<"$checks_json")"
      if [ "$ci_total" -ge 100 ]; then
        ci_truncated=true
      else
        ci_pending="$(jq -r '[.check_runs[] | select(.status != "completed")] | length' <<<"$checks_json")"
        ci_failed="$(jq -r '[.check_runs[] | select((.conclusion // "") as $c | (["success","skipped","neutral"] | index($c) | not))] | length' <<<"$checks_json")"
        ci_succeeded="$(jq -r '[.check_runs[] | select(.status == "completed" and .conclusion == "success")] | length' <<<"$checks_json")"
        if [ "$ci_total" -gt 0 ] && [ "$ci_succeeded" -gt 0 ] && [ "$ci_pending" -eq 0 ] && [ "$ci_failed" -eq 0 ]; then
          ci_ready=true
        fi
      fi
    else
      fetch_ok=false
    fi
  fi

  if ! services_json="$(fetch_services)" || ! jq -e 'type == "array"' <<<"$services_json" >/dev/null 2>&1; then
    fetch_ok=false
    services_json='[]'
  fi

  backend="$(find_preview "$services_json" "$BACKEND_SERVICE" "$pr")"
  backend_id=""; backend_url=""; backend_deploy_sha=""; backend_ready=false
  if [ "$backend" != "null" ] && [ -n "$backend" ]; then
    backend_id="$(jq -r '.id // empty' <<<"$backend")"
    backend_url="$(jq -r '.serviceDetails.url // empty' <<<"$backend")"
    if [ -n "$backend_id" ]; then
      backend_deploy_sha="$(latest_live_deploy_sha "$backend_id")" || { backend_deploy_sha=""; fetch_ok=false; }
      [ "$backend_deploy_sha" = "$head_sha" ] && backend_ready=true
    fi
  fi

  frontend_ready=true
  frontend=""; frontend_id=""; frontend_url=""; frontend_deploy_sha=""
  if [ "$frontend_touched" = true ]; then
    frontend_ready=false
    frontend="$(find_preview "$services_json" "$FRONTEND_SERVICE" "$pr")"
    if [ "$frontend" != "null" ] && [ -n "$frontend" ]; then
      frontend_id="$(jq -r '.id // empty' <<<"$frontend")"
      frontend_url="$(jq -r '.serviceDetails.url // empty' <<<"$frontend")"
      if [ -n "$frontend_id" ]; then
        frontend_deploy_sha="$(latest_live_deploy_sha "$frontend_id")" || { frontend_deploy_sha=""; fetch_ok=false; }
        [ "$frontend_deploy_sha" = "$head_sha" ] && frontend_ready=true
      fi
    fi
  fi

  healthz_ready=false
  if [ "$backend_ready" = true ] && healthz_ok "$backend_url"; then
    healthz_ready=true
  fi

  settled=false
  if [ "$migrations_touched" = false ] && [ "$backend_ready" = true ] && \
     [ "$frontend_ready" = true ] && [ "$ci_ready" = true ] && [ "$healthz_ready" = true ]; then
    settled=true
  fi

  jq -cn \
    --argjson pr "$pr" --arg headSha "$head_sha" \
    --argjson fetchOk "$fetch_ok" \
    --argjson migrationsTouched "$migrations_touched" \
    --argjson frontendTouched "$frontend_touched" \
    --argjson isFreezePr "$is_freeze" \
    --arg ciSha "$ci_sha" \
    --argjson ciReady "$ci_ready" --argjson ciTotal "$ci_total" \
    --argjson ciPending "$ci_pending" --argjson ciFailed "$ci_failed" \
    --argjson ciSucceeded "$ci_succeeded" --argjson ciTruncated "$ci_truncated" \
    --arg backendPreviewId "$backend_id" --arg backendPreviewUrl "$backend_url" \
    --arg backendDeploySha "$backend_deploy_sha" --argjson backendReady "$backend_ready" \
    --arg frontendPreviewId "$frontend_id" --arg frontendPreviewUrl "$frontend_url" \
    --arg frontendDeploySha "$frontend_deploy_sha" --argjson frontendReady "$frontend_ready" \
    --argjson healthzReady "$healthz_ready" --argjson settled "$settled" \
    '{
      pr: $pr, headSha: $headSha, fetchOk: $fetchOk,
      migrationsTouched: $migrationsTouched, frontendTouched: $frontendTouched,
      isFreezePr: $isFreezePr, ciSha: (if $ciSha == "" then null else $ciSha end),
      ciReady: $ciReady, ciTotal: $ciTotal, ciPending: $ciPending,
      ciFailed: $ciFailed, ciSucceeded: $ciSucceeded, ciTruncated: $ciTruncated,
      backendPreviewId: (if $backendPreviewId == "" then null else $backendPreviewId end),
      backendPreviewUrl: (if $backendPreviewUrl == "" then null else $backendPreviewUrl end),
      backendDeploySha: (if $backendDeploySha == "" then null else $backendDeploySha end),
      backendReady: $backendReady,
      frontendPreviewId: (if $frontendPreviewId == "" then null else $frontendPreviewId end),
      frontendPreviewUrl: (if $frontendPreviewUrl == "" then null else $frontendPreviewUrl end),
      frontendDeploySha: (if $frontendDeploySha == "" then null else $frontendDeploySha end),
      frontendReady: $frontendReady,
      healthzReady: $healthzReady, settled: $settled
    }'
}

COMMAND="${1:-poll}"

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "check" ]; then
  PR="${2:-}"
  if ! printf '%s' "$PR" | grep -Eq '^[0-9]+$'; then
    jq -cn '{ok:false,error:"check requires a PR number"}'
    exit 2
  fi
  MISSING=""
  [ -n "$REPO" ] || MISSING="$MISSING SMOKE_GATE_REPO"
  [ -n "$BACKEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_BACKEND_SERVICE"
  [ -n "$FRONTEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_FRONTEND_SERVICE"
  if [ -n "$MISSING" ]; then
    jq -cn --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
      '{ok:false,error:"gate misconfigured",missing:$missing}'
    exit 2
  fi
  if ! PR_JSON="$(timeout 10 gh pr view "$PR" -R "$REPO" --json number,state,isDraft,headRefOid,baseRefName,labels 2>/dev/null)" ||
     ! jq -e 'type == "object"' <<<"$PR_JSON" >/dev/null 2>&1; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"failed to fetch PR",pr:$pr}'
    exit 1
  fi
  STATE_OK="$(jq -r '.state == "OPEN"' <<<"$PR_JSON")"
  BASE_OK="$(jq -r --arg b "$BRANCH" '.baseRefName == $b' <<<"$PR_JSON")"
  LABEL_OK="$(jq -r --arg l "$LABEL" '[.labels[].name] | index($l) != null' <<<"$PR_JSON")"
  if [ "$STATE_OK" != true ] || [ "$BASE_OK" != true ] || [ "$LABEL_OK" != true ]; then
    jq -cn --argjson pr "$PR" --argjson open "$STATE_OK" --argjson base "$BASE_OK" --argjson labeled "$LABEL_OK" \
      '{ok:true,pr:$pr,eligible:false,reason:(
        if $open != true then "pr not open"
        elif $base != true then "pr base does not match SMOKE_GATE_BRANCH"
        else "pr missing the smoke-gate label" end)}'
    exit 0
  fi
  HEAD_SHA="$(jq -r '.headRefOid' <<<"$PR_JSON")"
  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA")"
  # Belt and braces (P1-2): `check` is the one path a human trusts before a
  # manual claim, so it must never assert settled:true on a fetch failure —
  # independent of whatever evaluate_pr's own per-field fail-closed defaults
  # did, in case a future field is added there without updating this clamp.
  FACTS="$(jq -c 'if .fetchOk != true then .settled = false else . end' <<<"$FACTS")"
  jq -cn --argjson facts "$FACTS" '{ok:true} + {eligible:true} + $facts'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "claim" ]; then
  RUN_ID="${2:-}"
  PR="${3:-}"
  SHA="${4:-}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"claim requires a run id"}'
    exit 2
  fi
  if ! printf '%s' "$PR" | grep -Eq '^[0-9]+$'; then
    jq -cn '{ok:false,error:"claim requires a PR number"}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"claim requires the 40-character frozen head SHA"}'
    exit 2
  fi
  # Run ids must be unique across the WHOLE gate, not just within one PR's
  # state file — finish/progress/release resolve a bare run id by scanning
  # every pr-*-state.json for the first match (find_pr_for_run), so two PRs
  # sharing a caller-chosen id makes that resolution ambiguous: finish could
  # record PR A's verdict under PR B's SHA and leave PR B a zombie forever
  # "active". Serialize the whole claim behind CONTROL_LOCK (same lock
  # ordering as poll's preflight-then-claim path: control lock first, then
  # the target PR's own lock) so the scan below can't race a concurrent claim
  # on a different PR.
  exec 8>"$CONTROL_LOCK"
  if ! flock -w 5 8; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gate lock failed",pr:$pr}'
    exit 0
  fi
  OTHER_PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -n "$OTHER_PR" ] && [ "$OTHER_PR" != "$PR" ]; then
    jq -cn --argjson pr "$PR" --argjson otherPr "$OTHER_PR" --arg run "$RUN_ID" \
      '{ok:false,error:"run id already claimed on a different PR — run ids must be unique across the gate",
        pr:$pr,runId:$run,activePr:$otherPr}'
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w 5 9; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gate lock failed",pr:$pr}'
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ -n "$ACTIVE_RUN" ] && [ "$ACTIVE_RUN" != "$RUN_ID" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    jq -cn --argjson pr "$PR" --arg active "$ACTIVE_RUN" --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
      '{ok:false,error:"another run already owns this PR preview — wait for it or ask its coordinator",
        pr:$pr,activeRunId:$active,activeSha:(if $sha == "" then null else $sha end)}'
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" \
    '.activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=$now' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg sha "$SHA" \
    '{ok:true,runId:$run,pr:$pr,sha:$sha}'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "progress" ]; then
  RUN_ID="${2:-}"
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"not the active run (reclaimed or finished) — stop this campaign",
        runId:(if $run == "" then null else $run end),pr:null,activeRunId:null}'
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w 5 9; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gate lock failed",pr:$pr}'
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or finished) — stop this campaign",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c --arg now "$NOW" '.activeProgressAt=$now' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:true,runId:$run,pr:$pr}'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "release" ]; then
  RUN_ID="${2:-}"
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"not the active run — nothing released",
        runId:(if $run == "" then null else $run end),pr:null,activeRunId:null}'
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w 5 9; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gate lock failed",pr:$pr}'
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run — nothing released",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STATE="$(jq -c '.activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:true,releasedRunId:$run,pr:$pr}'
  exit 0
fi

# ---------------------------------------------------------------------------
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
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"not the active run (reclaimed or already finished) — no verdict recorded",
        runId:(if $run == "" then null else $run end),pr:null,activeRunId:null}'
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w 5 9; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"gate lock failed",pr:$pr}'
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  # Same not-the-active-run guard as smoke-develop-gate.sh finish, copied
  # exactly: only the run that currently owns the slot may record a verdict,
  # so a reclaimed run reviving late can never overwrite a successor's.
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or already finished) — no verdict recorded, no hold touched",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c \
    --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"

  # Suspend the backend preview so a finished PR stops billing compute while
  # it waits for merge/close. Teardown itself is Render's job (auto-delete on
  # PR close) — this gate never deletes services. Rediscovered fresh rather
  # than trusting a stored id, since the preview may already be gone.
  SUSPEND_ATTEMPTED=false
  SUSPEND_OK=false
  SUSPEND_STATUS="null"
  SUSPEND_REASON=""
  if SERVICES_JSON="$(fetch_services)" && jq -e 'type == "array"' <<<"$SERVICES_JSON" >/dev/null 2>&1; then
    BACKEND_PREVIEW="$(find_preview "$SERVICES_JSON" "$BACKEND_SERVICE" "$PR")"
    if [ "$BACKEND_PREVIEW" != "null" ] && [ -n "$BACKEND_PREVIEW" ]; then
      BACKEND_PREVIEW_ID="$(jq -r '.id // empty' <<<"$BACKEND_PREVIEW")"
      if [ -n "$BACKEND_PREVIEW_ID" ]; then
        SUSPEND_ATTEMPTED=true
        HTTP_CODE="$(timeout 10 curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
          -X POST "https://api.render.com/v1/services/$BACKEND_PREVIEW_ID/suspend" 2>/dev/null)"
        if [ -z "$HTTP_CODE" ]; then
          SUSPEND_REASON="suspend request failed (network/timeout)"
        else
          SUSPEND_STATUS="$HTTP_CODE"
          if [ "$HTTP_CODE" = "202" ]; then
            SUSPEND_OK=true
          else
            SUSPEND_REASON="suspend returned HTTP $HTTP_CODE"
          fi
        fi
      else
        SUSPEND_REASON="backend preview found but had no service id"
      fi
    else
      SUSPEND_REASON="backend preview not found (already torn down?)"
    fi
  else
    SUSPEND_REASON="failed to list services"
  fi

  VERDICT_JSON="$(jq -cn \
    --argjson pr "$PR" --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --argjson attempted "$SUSPEND_ATTEMPTED" --argjson ok "$SUSPEND_OK" \
    --argjson status "$SUSPEND_STATUS" --arg reason "$SUSPEND_REASON" \
    '{schemaVersion:1,pr:$pr,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now,
      suspend:{attempted:$attempted,ok:$ok,httpStatus:$status,
               reason:(if $reason == "" then null else $reason end)}}')"
  VERDICT_TMP="$(mktemp "$STATE_DIR/.pr-$PR-verdict.XXXXXX")"
  printf '%s\n' "$VERDICT_JSON" > "$VERDICT_TMP"
  mv "$VERDICT_TMP" "$(pr_verdict_file "$PR")"

  jq -cn --argjson verdict "$VERDICT_JSON" '{ok:true} + $verdict'
  exit 0
fi

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" \
    '{ok:false,error:("unknown command: " + $command),
      commands:["poll","check","claim","release","progress","finish"]}'
  exit 2
fi

# ---------------------------------------------------------------------------
# poll: fail-closed on missing deployment config, throttled to one wake per
# 6h so misconfiguration surfaces once as a visible alarm instead of silent
# wakeAgent:false forever.
MISSING=""
[ -n "$REPO" ] || MISSING="$MISSING SMOKE_GATE_REPO"
[ -n "$BACKEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_BACKEND_SERVICE"
[ -n "$FRONTEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_FRONTEND_SERVICE"
if [ -n "$MISSING" ]; then
  exec 8>"$CONTROL_LOCK"
  flock -w 5 8 || true
  CONTROL="$(read_control)"
  LAST="$(epoch_or_zero "$(jq -r '.lastMisconfigWakeAt // empty' <<<"$CONTROL")")"
  NOW_EPOCH="$(date -u +%s)"
  WAKE=false
  if [ "$(( NOW_EPOCH - LAST ))" -ge 21600 ]; then
    WAKE=true
    CONTROL="$(jq -c --arg now "$(iso_now)" '.lastMisconfigWakeAt=$now' <<<"$CONTROL")"
  fi
  write_control "$CONTROL"
  jq -cn --argjson wake "$WAKE" \
    --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_misconfigured",settled:false,missing:$missing}}'
  exit 0
fi

PR_LIST_JSON="$(timeout 10 gh pr list -R "$REPO" --base "$BRANCH" --label "$LABEL" --state open \
  --json number,headRefOid --limit 100 2>/dev/null)"
PR_LIST_RC=$?
PR_LIST_LEN="$(jq -r 'length' <<<"$PR_LIST_JSON" 2>/dev/null || printf -- '-1')"
# Exit code, shape, AND truncation (>=100, the --limit ceiling — same guard
# evaluate_pr already applies to its own files/check-runs fetches) all gate
# here. A command that fails but still prints something that happens to
# parse as an empty/valid array must not be read as a legitimate "no labeled
# PRs" result, and a truncated page must not be read as "only these PRs are
# labeled" — either way some labeled PRs would silently never get polled.
if [ "$PR_LIST_RC" -ne 0 ] || ! jq -e 'type == "array"' <<<"$PR_LIST_JSON" >/dev/null 2>&1 || \
   [ "$PR_LIST_LEN" -ge 100 ] 2>/dev/null; then
  exec 8>"$CONTROL_LOCK"
  flock -w 5 8 || true
  CONTROL="$(read_control)"
  FAILURES="$(( $(jq -r '.fetchFailures // 0' <<<"$CONTROL") + 1 ))"
  if [ "$FAILURES" -gt 3 ]; then FAILURES=3; fi
  CONTROL="$(jq -c --argjson f "$FAILURES" '.fetchFailures=$f' <<<"$CONTROL")"
  WAKE=false
  if [ "$FAILURES" -ge 3 ]; then
    LAST="$(epoch_or_zero "$(jq -r '.lastFailureWakeAt // empty' <<<"$CONTROL")")"
    NOW_EPOCH="$(date -u +%s)"
    if [ "$(( NOW_EPOCH - LAST ))" -ge 21600 ]; then
      WAKE=true
      CONTROL="$(jq -c --arg now "$(iso_now)" '.fetchFailures=0 | .lastFailureWakeAt=$now' <<<"$CONTROL")"
    fi
  fi
  write_control "$CONTROL"
  jq -cn --argjson wake "$WAKE" --argjson failures "$FAILURES" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_fetch_failed",settled:false,consecutiveFailures:$failures}}'
  exit 0
fi
# Fetch succeeded — reset the strike counter.
exec 8>"$CONTROL_LOCK"
flock -w 5 8 || true
CONTROL="$(jq -c '.fetchFailures=0' <<<"$(read_control)")"
write_control "$CONTROL"
flock -u 8

PR_COUNT="$(jq -r 'length' <<<"$PR_LIST_JSON")"
if [ "$PR_COUNT" -eq 0 ]; then
  jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates",labeledPrCount:0}}'
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ALARM_CANDIDATES="$TMP_DIR/alarms.jsonl"
SETTLE_CANDIDATES="$TMP_DIR/settles.jsonl"
: > "$ALARM_CANDIDATES"
: > "$SETTLE_CANDIDATES"
NOW_EPOCH="$(date -u +%s)"

while IFS= read -r ROW; do
  PR="$(jq -r '.number' <<<"$ROW")"
  HEAD_SHA="$(jq -r '.headRefOid' <<<"$ROW")"
  printf '%s' "$HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$' || continue

  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA")"
  [ "$(jq -r '.fetchOk' <<<"$FACTS")" = true ] || continue

  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w 5 9; then
    exec 9>&-
    continue
  fi
  STATE="$(read_pr_state "$PR")"

  BACKEND_READY="$(jq -r '.backendReady' <<<"$FACTS")"
  if [ "$BACKEND_READY" = true ]; then
    if [ "$(jq -r '.deployLiveSha // empty' <<<"$STATE")" != "$HEAD_SHA" ]; then
      STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$(iso_now)" \
        '.deployLiveSha=$sha | .deployLiveSince=$now' <<<"$STATE")"
      write_pr_state "$PR" "$STATE"
    fi
  fi
  flock -u 9
  exec 9>&-

  MIGRATIONS_TOUCHED="$(jq -r '.migrationsTouched' <<<"$FACTS")"
  REFUSED_ALERT_SHA="$(jq -r '.refusedAlertSha // empty' <<<"$STATE")"
  if [ "$MIGRATIONS_TOUCHED" = true ] && [ "$REFUSED_ALERT_SHA" != "$HEAD_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"migrations"}' >> "$ALARM_CANDIDATES"
    continue
  fi

  HEALTHZ_READY="$(jq -r '.healthzReady' <<<"$FACTS")"
  WARMUP_ALERT_SHA="$(jq -r '.warmupAlertSha // empty' <<<"$STATE")"
  if [ "$BACKEND_READY" = true ] && [ "$HEALTHZ_READY" != true ] && [ "$WARMUP_ALERT_SHA" != "$HEAD_SHA" ]; then
    LIVE_SINCE_EPOCH="$(epoch_or_zero "$(jq -r '.deployLiveSince // empty' <<<"$STATE")")"
    if [ "$LIVE_SINCE_EPOCH" -gt 0 ] && [ "$(( NOW_EPOCH - LIVE_SINCE_EPOCH ))" -ge "$WARMUP_TIMEOUT" ]; then
      jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"warmup"}' >> "$ALARM_CANDIDATES"
      continue
    fi
  fi

  SETTLED="$(jq -r '.settled' <<<"$FACTS")"
  [ "$SETTLED" = true ] || continue

  COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
  [ "$COMPLETED_SHA" != "$HEAD_SHA" ] || continue

  ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ -n "$ACTIVE_SHA" ] && [ "$(active_run_is_live \
        "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
        "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    continue
  fi

  RECOVERY=false
  ABANDONED=""
  if [ -n "$ACTIVE_SHA" ]; then RECOVERY=true; ABANDONED="$ACTIVE_SHA"; fi
  jq -cn --argjson pr "$PR" --argjson facts "$FACTS" --argjson recovery "$RECOVERY" --arg abandoned "$ABANDONED" \
    '{pr:$pr,facts:$facts,recovery:$recovery,abandonedActiveSha:(if $abandoned == "" then null else $abandoned end)}' \
    >> "$SETTLE_CANDIDATES"
done < <(jq -c '.[]' <<<"$PR_LIST_JSON")

# At most one wake per poll: alarms first (lowest PR number wins), then
# settle candidates (lowest PR number = oldest, since GitHub PR numbers are
# monotonically increasing with creation time). A candidate that loses the
# slot this poll leaves no marker behind, so it competes again next poll.
if [ -s "$ALARM_CANDIDATES" ]; then
  WINNER="$(jq -sc 'sort_by(.pr) | .[0]' "$ALARM_CANDIDATES")"
  W_PR="$(jq -r '.pr' <<<"$WINNER")"
  W_SHA="$(jq -r '.sha' <<<"$WINNER")"
  W_SUB="$(jq -r '.subtype' <<<"$WINNER")"
  exec 9>"$(pr_lock_file "$W_PR")"
  if flock -w 5 9; then
    STATE="$(read_pr_state "$W_PR")"
    FIELD="refusedAlertSha"
    [ "$W_SUB" = "warmup" ] && FIELD="warmupAlertSha"
    ALREADY="$(jq -r --arg f "$FIELD" '.[$f] // empty' <<<"$STATE")"
    if [ "$ALREADY" != "$W_SHA" ]; then
      STATE="$(jq -c --arg f "$FIELD" --arg sha "$W_SHA" '.[$f]=$sha' <<<"$STATE")"
      write_pr_state "$W_PR" "$STATE"
      TRIGGER="pr_migrations_refused"
      [ "$W_SUB" = "warmup" ] && TRIGGER="pr_warmup_stuck"
      jq -cn --argjson pr "$W_PR" --arg sha "$W_SHA" --arg trigger "$TRIGGER" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:$trigger,pr:$pr,sourceSha:$sha}}'
      exit 0
    fi
  fi
  # Lost the race to another poll, or lock failed — fall through to settle
  # candidates below rather than emitting nothing this cycle.
fi

if [ -s "$SETTLE_CANDIDATES" ]; then
  WINNER="$(jq -sc 'sort_by(.pr) | .[0]' "$SETTLE_CANDIDATES")"
  W_PR="$(jq -r '.pr' <<<"$WINNER")"
  FACTS="$(jq -c '.facts' <<<"$WINNER")"
  RECOVERY="$(jq -r '.recovery' <<<"$WINNER")"
  ABANDONED="$(jq -r '.abandonedActiveSha' <<<"$WINNER")"
  HEAD_SHA="$(jq -r '.headSha' <<<"$FACTS")"

  if [ -n "$PREFLIGHT_CMD" ]; then
    exec 8>"$CONTROL_LOCK"
    flock -w 5 8 || true
    CONTROL="$(read_control)"
    PREFLIGHT_OUT="$TMP_DIR/preflight.out"
    if timeout "$PREFLIGHT_TIMEOUT" bash -c "$PREFLIGHT_CMD" >"$PREFLIGHT_OUT" 2>&1; then
      CONTROL="$(jq -c '.preflightReason=null | .preflightWakeAt=null' <<<"$CONTROL")"
      write_control "$CONTROL"
    else
      PREFLIGHT_RC=$?
      PREFLIGHT_REASON="$(grep -v '^[[:space:]]*$' "$PREFLIGHT_OUT" 2>/dev/null | tail -1 | cut -c1-300)"
      [ -n "$PREFLIGHT_REASON" ] || PREFLIGHT_REASON="preflight command exited $PREFLIGHT_RC with no output"
      [ "$PREFLIGHT_RC" -eq 124 ] && PREFLIGHT_REASON="preflight timed out after ${PREFLIGHT_TIMEOUT}s: $PREFLIGHT_REASON"
      LAST_REASON="$(jq -r '.preflightReason // empty' <<<"$CONTROL")"
      SINCE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.preflightWakeAt // empty' <<<"$CONTROL")") ))"
      if { [ "$PREFLIGHT_REASON" != "$LAST_REASON" ] && [ "$SINCE_WAKE" -ge "$PREFLIGHT_REARM_FLOOR_SECONDS" ]; } ||
         [ "$SINCE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
        CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" --arg now "$(iso_now)" \
          '.preflightReason=$r | .preflightWakeAt=$now' <<<"$CONTROL")"
        write_control "$CONTROL"
        jq -cn --arg reason "$PREFLIGHT_REASON" --argjson rc "$PREFLIGHT_RC" \
          '{wakeAgent:true,data:{schemaVersion:1,trigger:"preflight_failed",reason:$reason,exitCode:$rc}}'
        exit 0
      fi
      CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" '.preflightReason=$r' <<<"$CONTROL")"
      write_control "$CONTROL"
      jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"preflight_failed"}}'
      exit 0
    fi
  fi

  exec 9>"$(pr_lock_file "$W_PR")"
  if ! flock -w 5 9; then
    jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"gate_lock_failed"}}'
    exit 0
  fi
  STATE="$(read_pr_state "$W_PR")"
  # Re-verify under lock: another poll (or a human claim) may have taken this
  # PR since the unlocked evaluation pass above.
  COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
  ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$COMPLETED_SHA" = "$HEAD_SHA" ] ||
     { [ -n "$ACTIVE_SHA" ] && [ "$(active_run_is_live \
          "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
          "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; }; then
    jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates"}}'
    exit 0
  fi

  RUN_STAMP_EPOCH="$(date -u +%s)"
  RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
  while [ "$RUN_ID" = "$(jq -r '.activeRunId // empty' <<<"$STATE")" ] ||
        [ "$RUN_ID" = "$(jq -r '.completedRunId // empty' <<<"$STATE")" ]; do
    RUN_STAMP_EPOCH="$(( RUN_STAMP_EPOCH + 1 ))"
    RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
  done
  NOW="$(iso_now)"
  STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$NOW" --arg run "$RUN_ID" \
    '.activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=null' <<<"$STATE")"
  write_pr_state "$W_PR" "$STATE"

  jq -cn \
    --arg repo "$REPO" --arg branch "$BRANCH" --argjson pr "$W_PR" --arg runId "$RUN_ID" \
    --argjson facts "$FACTS" --argjson recovery "$RECOVERY" \
    --arg abandoned "$ABANDONED" \
    '{wakeAgent:true,data:({
      schemaVersion:1, trigger:"pr_build_settled",
      repo:$repo, branch:$branch, pr:$pr, runId:$runId,
      sourceSha:$facts.headSha,
      previewUrl:$facts.backendPreviewUrl,
      frontendPreviewUrl:$facts.frontendPreviewUrl,
      isFreezePr:$facts.isFreezePr, ciSha:$facts.ciSha,
      recovery:$recovery,
      abandonedActiveSha:(if $abandoned == "" or $abandoned == "null" then null else $abandoned end)
    })}'
  exit 0
fi

jq -cn --argjson count "$PR_COUNT" \
  '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates",labeledPrCount:$count}}'
