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

# `--takeover` may appear anywhere in the argument list; strip it here so no
# verb has to know about it and a stale positional can never mean "take the
# slot". Only `claim` reads it (see below).
TAKEOVER=false
_ARGS=()
for _a in "$@"; do
  if [ "$_a" = "--takeover" ]; then TAKEOVER=true; else _ARGS+=("$_a"); fi
done
set -- ${_ARGS[@]+"${_ARGS[@]}"}

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
# Ported from smoke-develop-gate.sh per INVARIANT 3 (see its header). A
# non-numeric knob here does not abort a jq transform — this gate has no
# dispositions — but it degrades every `[ x -ge THRESHOLD ]` to a silently
# false comparison, which for an alarm threshold means never alarming.
BAD_NUMERIC_CONFIG=""
# Assigns rather than prints: `X="$(num_env ...)"` runs the function in a
# SUBSHELL, so BAD_NUMERIC_CONFIG accumulated there and was empty in the
# parent — the fallback worked, the alarm never fired. Caught by the test that
# asserts the bad knob is named.
#
# "All digits" is NOT enough — see the same function in smoke-develop-gate.sh
# for the three admitted classes (leading zeros, wider than int64, set-but-
# empty). Ported verbatim per INVARIANT 3.
num_env() {  # <target-var> <env-var-name> <default>
  local raw
  if [ -z "${!2+x}" ]; then printf -v "$1" '%s' "$3"; return; fi
  raw="${!2}"
  case "$raw" in
    0) printf -v "$1" '%s' "$raw"; return ;;
    ''|*[!0-9]*|0*) ;;
    *) if [ "${#raw}" -le 18 ]; then printf -v "$1" '%s' "$raw"; return; fi ;;
  esac
  BAD_NUMERIC_CONFIG="$BAD_NUMERIC_CONFIG $2"
  printf -v "$1" '%s' "$3"
}

num_env ACTIVE_STALE_SECONDS SMOKE_GATE_ACTIVE_STALE_SECONDS 14400
num_env PROGRESS_STALE_SECONDS SMOKE_GATE_PROGRESS_STALE_SECONDS 1800
num_env OVERRUN_REALERT_SECONDS SMOKE_GATE_OVERRUN_REALERT_SECONDS 7200
# Same seam as the develop gate: one command run immediately before a
# campaign opens, for preconditions the gate cannot see. Runs once per poll,
# only when a settle candidate has actually been chosen — never per PR.
PREFLIGHT_CMD="${SMOKE_GATE_PREFLIGHT_CMD:-}"
num_env PREFLIGHT_TIMEOUT SMOKE_GATE_PREFLIGHT_TIMEOUT 120
num_env PREFLIGHT_ALERT_SECONDS SMOKE_GATE_PREFLIGHT_ALERT_SECONDS 21600
num_env PREFLIGHT_REARM_FLOOR_SECONDS SMOKE_GATE_PREFLIGHT_REARM_FLOOR_SECONDS 900
# Verified spike budget: a preview boots `live` at port-bind but /healthz can
# report {"status":"warming"} for ~6-10 minutes while caches hydrate onto a
# fresh disk. Below this ceiling, "still warming" is normal and silent. At or
# past it, a backend stuck warming this long is worth one throttled alarm.
num_env WARMUP_TIMEOUT SMOKE_GATE_WARMUP_TIMEOUT 600
# How long a labeled PR may sit with unfetchable gate facts before it alarms.
# Facts come from several fetches (PR files, CI, Render services/deploys); any
# of them failing means the PR can never settle, and before 2026-08-12 that
# state was completely silent — freeze PR #786 sat fully built and warm for
# 6.5 hours while the CI fetch returned nothing on every 10-minute poll, and
# nothing anywhere said so. A gate that cannot settle must be loud.
num_env FACTS_STUCK_TIMEOUT SMOKE_GATE_FACTS_STUCK_SECONDS 3600
# Freeze-PR handoff wiring, `finish` only, freeze PRs only (see the header
# comment above `detect_freeze` and the `finish` command below). All three
# are no-ops unless set — a deployment that never wires them keeps today's
# behavior: finish still records a verdict and suspends the preview, nothing
# more.
PUBLISH_FILE="${SMOKE_GATE_PUBLISH_FILE:-}"
HOLD_FILE="${SMOKE_GATE_HOLD_FILE:-}"
# Same path the develop gate reads as its own HANDOFF_LEDGER (its
# SMOKE_GATE_STATE_DIR/handoff-ledger.jsonl) — the wrapper is responsible for
# pointing this at that file. Single writer per file: this gate APPENDS,
# never rewrites; the develop gate only ever reads.
HANDOFF_LEDGER="${SMOKE_GATE_HANDOFF_LEDGER:-}"

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

# How long to wait for a per-PR state lock. Same knob and same default as
# smoke-develop-gate.sh's.
num_env LOCK_WAIT SMOKE_GATE_LOCK_WAIT_SECONDS 15

# Losing the lock is NOT losing the slot. The old emission here was
# `{ok:false,error:"gate lock failed"}` — an `ok:false` that the skill's
# stop-the-campaign rule could not tell apart from "you were reclaimed", so a
# transient contention miss on a mandatory `progress` stamp could end a healthy
# campaign. `retryable:true` plus the `gate_lock_busy:` prefix is the stable,
# greppable "wait and retry" signal; the not-active refusals carry neither.
emit_lock_busy() {
  jq -cn --arg phase "$1" --arg pr "${2:-}" \
    '{ok:false,
      retryable:true,
      error:("gate_lock_busy: another gate invocation held the state lock (" + $phase +
             ") — RETRY this same command in ~10s. This does NOT mean the run lost its slot; do not stop the campaign."),
      pr:(if $pr == "" then null else ($pr|tonumber) end),
      wakeAgent:false,
      data:{schemaVersion:1,trigger:"gate_lock_busy",phase:$phase}}'
}

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
    refusedAlertSha: null,
    factsStuckSha: null,
    factsStuckSince: null,
    factsStuckAlertSha: null,
    overrunAlertRunId: null,
    overrunAlertAt: null,
    displacedRunId: null,
    displacedAt: null
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
    preflightWakeAt: null,
    preflightFingerprint: null
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

# Same liveness rule as smoke-develop-gate.sh: a run is live while its newest
# liveness signal (progress stamp, else the claim itself) is within
# PROGRESS_STALE_SECONDS. A killed container stops stamping, so a dead run goes
# reclaimable after that window — which is the ONLY evidence of death this gate
# has, and the only thing that may free a slot automatically.
#
# ACTIVE_STALE_SECONDS used to be ANDed in here, and that was the
# duplicate-coordinator fault. A campaign stamping `progress` every few minutes
# went "not live" the instant it crossed the ceiling, and the very next `poll`
# started a SECOND coordinator on the same PR and the same frozen SHA with
# nothing telling the first — it discovered the displacement hours later, when
# its own `progress` finally returned ok:false. Run
# …-20260822T023125Z was displaced 4h00m03s after its claim: three seconds past
# the 4h ceiling, having stamped progress four minutes earlier. It had already
# been through this once in the same run, and a third run hit it two days
# later. Overrun is now a reason to REFUSE a claim (see `claim`'s --takeover),
# never a reason to hand the slot to a rival.
active_run_is_live() {
  local started="$1" progress="$2" now_epoch started_epoch progress_epoch last quiet
  now_epoch="$(date -u +%s)"
  started_epoch="$(epoch_or_zero "$started")"
  progress_epoch="$(epoch_or_zero "$progress")"
  last="$started_epoch"
  if [ "$progress_epoch" -gt "$last" ]; then last="$progress_epoch"; fi
  quiet="$(( now_epoch - last ))"
  if [ "$quiet" -lt "$PROGRESS_STALE_SECONDS" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# Seconds a live run has held its slot. Only `claim` reads this, to decide
# whether the run has been going long enough for --takeover to be offered at
# all: below the ceiling there is no takeover, only `release` or waiting.
active_run_age() {
  printf '%s' "$(( $(date -u +%s) - $(epoch_or_zero "$1") ))"
}

# Find which PR's state file currently owns a given run id. `claim` lets the
# caller pick an arbitrary run-id, so `progress`/`release`/`finish` — which
# take only a run-id, no PR number, per the gate's command contract — recover
# the PR by scanning. Reads are unlocked (best-effort); the caller re-checks
# under that PR's own lock before mutating, so a race here just means a
# retry, never a wrong write.
# A run displaced by an explicit `--takeover` is told so BY NAME instead of
# getting the generic "reclaimed or finished". Takeover flips `activeRunId` and
# nothing else — a shell gate cannot kill the incumbent's container — so the
# next gate verb is the only channel that reaches a displaced coordinator, and
# it needs to carry an unambiguous stop instruction rather than a status.
emit_not_active() {
  local run_id="$1" base="$2" f
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.displacedRunId // empty' "$f" 2>/dev/null)" = "$run_id" ]; then
      jq -cn --arg run "$run_id" \
        --argjson pr "$(jq -r '.pr' "$f")" \
        --arg by "$(jq -r '.activeRunId // empty' "$f")" \
        --arg at "$(jq -r '.displacedAt // empty' "$f")" \
        '{ok:false,
          error:("STOP THIS CAMPAIGN. This run was displaced by an explicit --takeover at " + $at +
                 " and no longer owns the PR: stop every lane, write no markers, drive no browsers, publish nothing."),
          runId:$run,pr:$pr,activeRunId:(if $by == "" then null else $by end),displacedAt:$at}'
      return 0
    fi
  done
  jq -cn --arg run "$run_id" --arg base "$base" \
    '{ok:false,error:$base,runId:(if $run == "" then null else $run end),pr:null,activeRunId:null}'
}

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
  local pr="$1" head_sha="$2" head_ref="${3:-}"
  local files_json files_len files_fetch_failed migrations_touched frontend_touched is_freeze ci_sha
  local migration_files migrations_determinable target_files_json target_files_len target_compare_failed
  local runs_json runs_len ci_ref ci_total ci_pending ci_failed ci_succeeded ci_ready ci_truncated
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

  # migrationsTouched/frontendTouched computed above from files_json are the
  # freeze PR's OWN diff — smoke-freeze-pr.sh deliberately builds that as
  # exactly the two marker files (see FREEZE_MARKER_BACKEND/FRONTEND above), so
  # for a freeze PR those two booleans are ALWAYS false, no matter what the
  # frozen TARGET commit (ci_sha, the marker's parent) actually contains.
  # Confirmed live 2026-08-24 (challenger MG-1, PR #1188): the target carried
  # migration 222_undo_edit_prior_actor, which stops the backend booting, and
  # `smoke-pr-gate.sh check 1188` reported migrationsTouched:false anyway,
  # costing a coordinator and a challenger agent 30 minutes to diagnose a
  # condition this gate could have reported instantly. Recompute both off the
  # diff that actually matters for a freeze PR — base branch tip vs. the
  # target commit — using the same 300-file truncation guard
  # smoke-develop-gate.sh's own compare-based check already uses.
  #
  # ponytail: duplicates the ~6-line extraction above rather than threading a
  # shared helper through two call sites with different inputs (a PR's own
  # `pulls/.../files` array vs. a `compare` response's `.files`) — see
  # detect_freeze's own comment for the same call.
  migrations_determinable=true
  migration_files='[]'
  if [ "$is_freeze" = true ]; then
    if [ -z "$ci_sha" ]; then
      # ci_sha fetch already failed above (fetch_ok=false) — nothing to
      # compare against. Fail closed exactly like the files-fetch-failure
      # branch: assume both touched, and say we couldn't actually check.
      migrations_touched=true
      frontend_touched=true
      migrations_determinable=false
    else
      # `if !` on the direct assignment (not just a post-hoc shape check)
      # catches a nonzero gh exit even when it still printed something on
      # stdout — same pattern the files_json fetch above already uses.
      target_compare_failed=false
      if ! target_files_json="$(timeout 10 gh api "repos/$REPO/compare/$BRANCH...$ci_sha" 2>/dev/null)" ||
         ! jq -e '.files | type == "array"' <<<"$target_files_json" >/dev/null 2>&1; then
        target_compare_failed=true
        target_files_json='{"files":[]}'
      fi
      target_files_len="$(jq -r '.files | length' <<<"$target_files_json" 2>/dev/null || printf -- '-1')"
      if [ "$target_compare_failed" = true ] || { [ "$target_files_len" -ge 300 ] 2>/dev/null; }; then
        migrations_touched=true
        frontend_touched=true
        migrations_determinable=false
        fetch_ok=false
      else
        migrations_touched="$(jq -r --arg p "$MIGRATIONS_PREFIX" 'any(.files[].filename; startswith($p))' <<<"$target_files_json" 2>/dev/null)"
        frontend_touched="$(jq -r --arg p "$FRONTEND_PREFIX" 'any(.files[].filename; startswith($p))' <<<"$target_files_json" 2>/dev/null)"
        [ "$migrations_touched" = true ] || [ "$migrations_touched" = false ] || { migrations_touched=true; migrations_determinable=false; }
        [ "$frontend_touched" = true ] || [ "$frontend_touched" = false ] || frontend_touched=true
        migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.files[].filename | select(startswith($p))]' <<<"$target_files_json" 2>/dev/null)"
        [ -n "$migration_files" ] && jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1 || migration_files='[]'
      fi
    fi
  elif [ "$files_fetch_failed" = true ] || { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
    # Ordinary (non-freeze) PR whose own diff we couldn't read — same
    # fail-closed default as migrations_touched above, and equally unable to
    # name which files, so say so rather than reporting an empty list as fact.
    migrations_determinable=false
  else
    migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.[].filename | select(startswith($p))]' <<<"$files_json" 2>/dev/null)"
    [ -n "$migration_files" ] && jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1 || migration_files='[]'
  fi

  # CI facts come from `gh run list --branch`, deliberately NOT the check-runs
  # REST endpoint. This gate originally read
  # `repos/<repo>/commits/<sha>/check-runs`, which works with an operator token
  # but returns nothing to the agent container's scoped GitHub token — so every
  # in-container poll computed ci_total=0 / fetch_ok=false and silently refused
  # to settle. Freeze PR #786 was fully built, warm and correct for 6.5 hours on
  # 2026-08-12 and never ran. smoke-develop-gate.sh:540 has always used this
  # same `gh run list` call and has worked in-container for months; both gates
  # now read CI through the one mechanism proven under the container's token.
  ci_ready=false
  ci_total=0; ci_pending=0; ci_failed=0; ci_succeeded=0; ci_truncated=false
  if [ -n "$ci_sha" ]; then
    # A freeze PR's ci_sha is its marker commit's PARENT, which lives on the
    # base branch; a normal PR's ci_sha is its own head, on its head branch.
    if [ "$is_freeze" = true ]; then ci_ref="$BRANCH"; else ci_ref="$head_ref"; fi
    if [ -n "$ci_ref" ] &&
       runs_json="$(timeout 10 gh run list -R "$REPO" --branch "$ci_ref" --limit 100 \
         --json headSha,status,conclusion,workflowName 2>/dev/null)" &&
       jq -e 'type == "array"' <<<"$runs_json" >/dev/null 2>&1; then
      runs_len="$(jq -r 'length' <<<"$runs_json")"
      ci_total="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s)] | length' <<<"$runs_json")"
      if [ "$runs_len" -ge 100 ] && [ "$ci_total" -eq 0 ]; then
        # Full page and none of it is our SHA — the runs may simply be older
        # than one page. Cannot prove CI state, so fail closed rather than
        # read a paging artifact as "no CI ran".
        ci_truncated=true
        fetch_ok=false
      else
        ci_pending="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s and .status != "completed")] | length' <<<"$runs_json")"
        ci_failed="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s) | select((.conclusion // "") as $c | (["success","skipped","neutral"] | index($c) | not))] | length' <<<"$runs_json")"
        ci_succeeded="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s and .status == "completed" and .conclusion == "success")] | length' <<<"$runs_json")"
        # Same rule the develop gate applies: >=1 real success required, so a
        # head whose every workflow was path-skipped can never clear on
        # "nothing failed" alone.
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
    --argjson migrationFiles "$migration_files" --argjson migrationsDeterminable "$migrations_determinable" \
    '{
      pr: $pr, headSha: $headSha, fetchOk: $fetchOk,
      migrationsTouched: $migrationsTouched, frontendTouched: $frontendTouched,
      # migrationFiles names the pending migrations directly — the whole point
      # of this field is that an agent never has to re-derive what MG-1 took a
      # coordinator+challenger 30 minutes to find by hand. migrationsDeterminable
      # is false exactly when migrationsTouched is a fail-closed ASSUMPTION
      # (an unreadable diff) rather than a confirmed read — never report "no
      # migrations" from a check that could not actually run.
      migrationFiles: $migrationFiles, migrationsDeterminable: $migrationsDeterminable,
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

# Minimal freeze-PR detection for `finish` only — NOT evaluate_pr, which does
# far more (CI/deploy/healthz) that finish has no use for.
# ponytail: duplicates evaluate_pr's ~8-line files-diff/marker check rather
# than threading a shared helper through two call sites with very different
# needs (finish wants exactly 2 fetches total; reusing evaluate_pr here would
# cost 4 more — check-runs, services, two deploy lookups, a healthz curl —
# entirely wasted, since finish already has its own verdict from the caller).
#
# `filesOk` distinguishes "not a freeze PR" from "could not tell". A failed
# fetch collapses to files_json='[]' and therefore isFreezePr:false, which the
# caller treats identically to an ordinary PR: no hold, no publish, no ledger
# line, handoff.written:false with reason NULL, and an ok:true finish. That is
# a freeze-run verdict silently dropped on the floor — evaluate_pr fails closed
# on this exact fetch, this did not even report it. Reporting only; the
# caller's behaviour for a genuine non-freeze PR is unchanged.
detect_freeze() {
  local pr="$1" sha="$2" files_json is_freeze target_sha files_ok=true
  if ! files_json="$(timeout 10 gh api "repos/$REPO/pulls/$pr/files?per_page=100" 2>/dev/null)" ||
     ! jq -e 'type == "array"' <<<"$files_json" >/dev/null 2>&1; then
    files_ok=false
    files_json='[]'
  fi
  is_freeze="$(jq -r --arg a "$FREEZE_MARKER_BACKEND" --arg b "$FREEZE_MARKER_FRONTEND" '
    (length == 2) and ((map(.filename) | sort) == ([$a,$b] | sort))
  ' <<<"$files_json" 2>/dev/null)"
  [ "$is_freeze" = true ] || is_freeze=false
  target_sha=""
  if [ "$is_freeze" = true ]; then
    target_sha="$(timeout 8 gh api "repos/$REPO/commits/$sha" --jq '.parents[0].sha // empty' 2>/dev/null)"
  fi
  jq -cn --argjson isFreeze "$is_freeze" --argjson filesOk "$files_ok" --arg target "$target_sha" \
    '{isFreezePr:$isFreeze, filesOk:$filesOk,
      targetSha:(if $target == "" then null else $target end)}'
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
# A knob that fell back to its default because the deployed value was not a
# number is a misconfiguration, not a detail — name it in the same alarm.
MISSING="$MISSING$BAD_NUMERIC_CONFIG"
  if [ -n "$MISSING" ]; then
    jq -cn --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
      '{ok:false,error:"gate misconfigured",missing:$missing}'
    exit 2
  fi
  if ! PR_JSON="$(timeout 10 gh pr view "$PR" -R "$REPO" --json number,state,isDraft,headRefOid,headRefName,baseRefName,labels 2>/dev/null)" ||
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
  HEAD_REF="$(jq -r '.headRefName // empty' <<<"$PR_JSON")"
  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA" "$HEAD_REF")"
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
  if ! flock -w "$LOCK_WAIT" 8; then
    emit_lock_busy "$COMMAND" "$PR"
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
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  TOOK_OVER=""
  if [ -n "$ACTIVE_RUN" ] && [ "$ACTIVE_RUN" != "$RUN_ID" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    # A live run keeps its slot whatever its age or SHA. Reclaiming under a new
    # run id — same PR, same frozen SHA, everything else identical — is exactly
    # how a rival campaign displaced a stamping coordinator and ran 4h24m
    # alongside it without either knowing. Past ACTIVE_STALE_SECONDS a HUMAN may
    # still force the issue with --takeover; `poll` never passes it, so no
    # automatic path can ever produce a second coordinator again.
    ACTIVE_AGE="$(active_run_age "$(jq -r '.activeStartedAt // empty' <<<"$STATE")")"
    # `--takeover` is valid at ANY age. Gating it on the ceiling removed the
    # only lever an operator has during the first hours — exactly when someone
    # watching a wedged campaign would want it — while protecting against
    # nothing a deliberate human flag does not already imply. `poll` never
    # passes it, so no automatic path can produce a second coordinator.
    if [ "$TAKEOVER" = true ]; then
      TOOK_OVER="$ACTIVE_RUN"
    else
      if [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ]; then
        HINT="active run has overrun ${ACTIVE_STALE_SECONDS}s and is still stamping progress — stop its coordinator, or re-run this claim with --takeover"
      else
        HINT="another run already owns this PR preview — wait for it or ask its coordinator"
      fi
      jq -cn --argjson pr "$PR" --arg active "$ACTIVE_RUN" --arg err "$HINT" \
        --argjson age "$ACTIVE_AGE" \
        --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
        '{ok:false,error:$err,pr:$pr,activeRunId:$active,activeAgeSeconds:$age,
          activeSha:(if $sha == "" then null else $sha end)}'
      exit 0
    fi
  fi
  NOW="$(iso_now)"
  # Record WHO was displaced, so the displaced run's next gate call gets a stop
  # instruction naming the takeover instead of the generic reclaim message.
  # Cleared on an ordinary claim so a stale name can never mis-accuse a later run.
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" --arg took "$TOOK_OVER" \
    '.activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=$now |
     .displacedRunId=(if $took == "" then null else $took end) |
     .displacedAt=(if $took == "" then null else $now end)' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg sha "$SHA" --arg took "$TOOK_OVER" \
    '{ok:true,runId:$run,pr:$pr,sha:$sha,
      tookOverFrom:(if $took == "" then null else $took end)}'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "progress" ]; then
  RUN_ID="${2:-}"
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run (reclaimed or finished) — stop this campaign"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
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
    emit_not_active "$RUN_ID" "not the active run — nothing released"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
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
    emit_not_active "$RUN_ID" "not the active run (reclaimed or already finished) — no verdict recorded"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
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
  # The SHA must be the one this run CLAIMED, not merely a well-formed SHA.
  # `claim`/`poll` both record the frozen head as activeSha, so the gate
  # already knows the answer and needs no extra fetch — and until 2026-08-25
  # it never asked. A wrong SHA is not a cosmetic label: for a freeze PR,
  # detect_freeze derives the develop TARGET by walking the supplied SHA's
  # first parent, so passing the target itself walks one commit too far and
  # the hold/publish/ledger artifacts all name a build the campaign never
  # examined. Live: PR #1211's finish was called with df74301b (the target)
  # instead of 6259d76b (the marker it claimed and tested); the promotion
  # hold went out naming 9cf1ec10, PR #1199's commit. It exited ok:true.
  #
  # There is no legitimate case for a difference. The PR gate settles on
  # strict head/deploy equality (no deploy-lag SHA pair like the develop
  # gate's SMOKE_GATE_*_PATHS), and if the PR head moved mid-campaign the
  # tested build is still the claimed one — recording the new head would be
  # a verdict about something nobody ran. So: refuse, before the suspend
  # POST and before any artifact is touched. Refusing is also recoverable —
  # the slot is untouched, so re-running `finish` with the claimed SHA
  # completes normally. Shape matches the two sibling argument refusals
  # above (bare ok:false, exit 2): the invocation is wrong, not the world.
  CLAIMED_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$SHA" != "$CLAIMED_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg supplied "$SHA" --arg claimed "$CLAIMED_SHA" \
      '{ok:false,
        error:("finish sha does not match the sha this run claimed — no verdict recorded, no hold touched, slot still held. Re-run: finish " +
               (if $claimed == "" then "<claimed-sha>" else $claimed end) + " " + $run + " <verdict>"),
        pr:$pr,runId:$run,suppliedSha:$supplied,
        claimedSha:(if $claimed == "" then null else $claimed end)}'
    exit 2
  fi
  NOW="$(iso_now)"
  # ORDER IS THE CRASH CONTRACT. Clearing the slot FIRST — which is what this
  # did — made `finish` fail OPEN and permanently: a container death after the
  # state write but before the hold/ledger recorded NO_GO per-PR while the
  # promotion hold was never raised and the ledger line never landed, and the
  # retry was then refused with "not the active run" because activeRunId was
  # already null. The develop gate survives its identical window because its
  # hold-integrity reconciler notices the missing hold; the PR gate has no
  # equivalent, so it has to be crash-safe by construction instead.
  #
  # So: keep the slot HELD across the artifact work and clear it only once the
  # artifacts are durable. A crash anywhere below leaves activeRunId set, which
  # is exactly the state a plain `finish` retry needs. Every step in between is
  # idempotent — the suspend POST, the publish/hold file overwrites, and (see
  # the ledger append) a duplicate ledger line the develop gate's `tail -1`
  # never notices.
  #
  # The lock, however, is dropped now: the state file is unmodified, so nothing
  # is lost, and the network work below must not starve a concurrent verb.
  flock -u 9

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

  # Freeze-PR develop handoff (SMOKE_GATE_PUBLISH_FILE / SMOKE_GATE_HOLD_FILE
  # / SMOKE_GATE_HANDOFF_LEDGER — set by the wrapper only for a deployment
  # wired for smoke-develop-gate.sh's handoff mode). Non-freeze PRs and
  # deployments that never set these are completely untouched: detect_freeze
  # only runs when at least one of publish/hold is configured, and nothing
  # below writes anything unless this PR turns out to be a freeze PR.
  HANDOFF_WRITTEN=false
  HANDOFF_REASON=""
  HANDOFF_TARGET_SHA=""
  HANDOFF_DIVERGENCE=""
  if [ -n "$PUBLISH_FILE" ] || [ -n "$HOLD_FILE" ]; then
    FREEZE_INFO="$(detect_freeze "$PR" "$SHA")"
    if [ "$(jq -r '.filesOk' <<<"$FREEZE_INFO")" != true ]; then
      # Not "an ordinary PR" — an unreadable diff. If this WAS a freeze PR its
      # verdict has just been dropped with nothing written and nothing said.
      HANDOFF_REASON="could not read this PR's diff, so freeze-PR status is unknown — hold/publish/ledger not written. If this was a freeze PR the develop gate will never see this verdict; reconcile by hand"
    fi
    if [ "$(jq -r '.isFreezePr' <<<"$FREEZE_INFO")" = true ]; then
      TARGET_SHA="$(jq -r '.targetSha // empty' <<<"$FREEZE_INFO")"
      if [ -z "$TARGET_SHA" ]; then
        HANDOFF_REASON="could not determine the target develop sha for this freeze PR — hold/publish/ledger not written"
      else
        HANDOFF_TARGET_SHA="$TARGET_SHA"
        # SNAPSHOT BEFORE OVERWRITE. The hold file and the ledger are two
        # files on two different mounts (hold: the shared workgroup mount the
        # release desk reads; ledger: this gate's own state dir), and the only
        # way anyone has ever seen them disagree is a live check in the minutes
        # before the next `finish` — after which this block overwrites the hold
        # and the evidence is gone. That happened on 2026-08-18, -22 and -25;
        # all three are now un-diagnosable. The ledger is the authoritative
        # append-only record, so what the hold SHOULD say is derivable from it
        # (BLOCKED excluded — it deliberately leaves the hold alone and so
        # asserts nothing about it). Disagreement is captured to a timestamped
        # file that nothing here ever rewrites, then this finish proceeds.
        # Detection is not the point — the develop gate already alarms
        # (gate_hold_tampered); PRESERVATION is.
        if [ -n "$HOLD_FILE" ] && [ -n "$HANDOFF_LEDGER" ] && [ -s "$HANDOFF_LEDGER" ]; then
          LEDGER_HOLDING="$(jq -cR 'fromjson? | select(type == "object") | select(.verdict != "BLOCKED")' \
            "$HANDOFF_LEDGER" 2>/dev/null | tail -1)"
          if [ -n "$LEDGER_HOLDING" ]; then
            HOLD_NOW='null'
            [ -s "$HOLD_FILE" ] && HOLD_NOW="$(jq -c '.' "$HOLD_FILE" 2>/dev/null || printf '"unparseable"')"
            # Expected: a GO line means no hold; anything else means a hold
            # naming that same run. Same rule smoke-develop-gate.sh's
            # hold-integrity reconciler applies to its own completed record.
            if [ "$(jq -r '.verdict' <<<"$LEDGER_HOLDING")" = GO ]; then
              [ "$HOLD_NOW" = null ] || HANDOFF_DIVERGENCE="hold present after a GO"
            elif [ "$HOLD_NOW" = null ]; then
              HANDOFF_DIVERGENCE="hold missing"
            elif [ "$(jq -r '.runId // empty' <<<"$HOLD_NOW" 2>/dev/null)" != "$(jq -r '.runId' <<<"$LEDGER_HOLDING")" ]; then
              HANDOFF_DIVERGENCE="hold names a different run than the ledger"
            fi
            if [ -n "$HANDOFF_DIVERGENCE" ]; then
              DIVERGENCE_FILE="$STATE_DIR/hold-divergence-$(date -u +'%Y%m%dT%H%M%SZ')-pr$PR.json"
              jq -n --arg now "$NOW" --arg why "$HANDOFF_DIVERGENCE" --arg path "$HOLD_FILE" \
                --argjson pr "$PR" --arg run "$RUN_ID" --arg verdict "$VERDICT" \
                --argjson hold "$HOLD_NOW" --argjson ledger "$LEDGER_HOLDING" \
                '{schemaVersion:1,detectedAt:$now,divergence:$why,holdFile:$path,
                  detectedBy:{pr:$pr,runId:$run,verdict:$verdict},
                  holdBeforeOverwrite:$hold,newestHoldAffectingLedgerLine:$ledger}' \
                > "$DIVERGENCE_FILE" 2>/dev/null ||
                DIVERGENCE_FILE=""
              # If even the snapshot could not be written, say so in the field
              # rather than reporting null — "no divergence" and "a divergence
              # we failed to record" must never look the same.
              if [ -n "$DIVERGENCE_FILE" ] && [ -s "$DIVERGENCE_FILE" ]; then
                HANDOFF_DIVERGENCE="$DIVERGENCE_FILE"
              else
                HANDOFF_DIVERGENCE="NOT SNAPSHOTTED (write to $STATE_DIR failed): $HANDOFF_DIVERGENCE"
              fi
            fi
          fi
        fi
        # Publish + hold, the develop gate's EXACT semantics, keyed to the
        # TARGET develop sha (not the freeze marker sha) — every downstream
        # reader (release promotion, the develop gate's own reconciliation)
        # only ever reasons about develop lineage, never a freeze branch that
        # is about to be closed and torn down.
        #
        # Every write below is VERIFIED. `set -e` is not in effect here, so a
        # failed mkdir/mktemp/jq/mv (an unwritable or remounted shared mount is
        # the live case — the hold lives on the workgroup mount, the ledger does
        # not) used to leave HANDOFF_WRITTEN=true and reason:null while the
        # ledger line landed anyway: a NO_GO whose promotion hold silently never
        # went up. Reporting is the whole remedy — the slot-clearing semantics
        # below are unchanged, exactly as for a ledger-append failure, so the
        # verdict JSON carries the truth even though a re-finish is refused.
        HANDOFF_ARTIFACT_ERROR=""
        if [ -n "$PUBLISH_FILE" ]; then
          mkdir -p "$(dirname "$PUBLISH_FILE")" 2>/dev/null
          PUB_TMP="$(mktemp "$(dirname "$PUBLISH_FILE")/.latest-verdict.XXXXXX" 2>/dev/null)"
          if [ -n "$PUB_TMP" ]; then
            jq -cn --arg sha "$TARGET_SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
              '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now}' > "$PUB_TMP" 2>/dev/null
            mv "$PUB_TMP" "$PUBLISH_FILE" 2>/dev/null || rm -f "$PUB_TMP" 2>/dev/null
          fi
          jq -e --arg run "$RUN_ID" --arg sha "$TARGET_SHA" '.runId == $run and .sha == $sha' \
            "$PUBLISH_FILE" >/dev/null 2>&1 ||
            HANDOFF_ARTIFACT_ERROR="publish file $PUBLISH_FILE was not written"
        fi
        if [ -n "$HOLD_FILE" ]; then
          # HUMAN_DECISION raises the hold too (2026-08-25). It used to leave it
          # untouched, i.e. default-open — but a verdict whose literal meaning is
          # "the system does not know whether this is safe" defaulting open is
          # functionally GO on precisely the cases flagged as needing judgment. A
          # stalled queue is the correct consequence of requiring a decision.
          # `reason` distinguishes it from a defects hold so the release desk can
          # tell "we found bugs" from "somebody has to choose".
          # BLOCKED is deliberately UNCHANGED: it means the campaign could not
          # run, which asserts nothing about the build.
          case "$VERDICT" in
            NO_GO|HUMAN_DECISION)
              [ "$VERDICT" = NO_GO ] &&
                HOLD_REASON="confirmed defects on this develop lineage — see the run thread and run directory" ||
                HOLD_REASON="needs_human_decision"
              mkdir -p "$(dirname "$HOLD_FILE")" 2>/dev/null
              HOLD_TMP="$(mktemp "$(dirname "$HOLD_FILE")/.develop-hold.XXXXXX" 2>/dev/null)"
              if [ -n "$HOLD_TMP" ]; then
                jq -cn --arg sha "$TARGET_SHA" --arg run "$RUN_ID" --arg now "$NOW" \
                  --arg verdict "$VERDICT" --arg reason "$HOLD_REASON" \
                  '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,raisedAt:$now,
                    reason:$reason}' > "$HOLD_TMP" 2>/dev/null
                mv "$HOLD_TMP" "$HOLD_FILE" 2>/dev/null || rm -f "$HOLD_TMP" 2>/dev/null
              fi
              # The fail-OPEN direction: a raise that did not land leaves
              # promotion ungated on a build this run just objected to.
              jq -e --arg run "$RUN_ID" --arg sha "$TARGET_SHA" '.runId == $run and .sha == $sha' \
                "$HOLD_FILE" >/dev/null 2>&1 ||
                HANDOFF_ARTIFACT_ERROR="hold file $HOLD_FILE was NOT raised for this $VERDICT — promotion is ungated"
              ;;
            GO)
              rm -f "$HOLD_FILE" 2>/dev/null
              [ ! -e "$HOLD_FILE" ] ||
                HANDOFF_ARTIFACT_ERROR="hold file $HOLD_FILE could not be cleared for this GO"
              ;;
            # BLOCKED leaves the hold untouched — same as the develop gate's own
            # finish.
          esac
        fi
        if [ -n "$HANDOFF_ARTIFACT_ERROR" ]; then
          HANDOFF_REASON="$HANDOFF_ARTIFACT_ERROR — the ledger line below still records this verdict, so the two are now out of step. Fix the artifact by hand; a re-finish will be REFUSED (the slot is cleared)."
        else
          HANDOFF_WRITTEN=true
        fi
        if [ -n "$HANDOFF_LEDGER" ]; then
          mkdir -p "$(dirname "$HANDOFF_LEDGER")" 2>/dev/null
          LEDGER_APPENDED=false
          # One bounded retry (2 attempts total, 5s wait each): the develop
          # gate has no other way to learn this outcome, so a single
          # transient contention loss must not silently drop it.
          # ponytail: a `finish` retried after a crash appends a SECOND line for
          # the same targetSha. Harmless and deliberately not deduped — the
          # develop gate reads the matching lines with `tail -1` and the two
          # agree on freezePr/runId/verdict, so the later one simply wins. The
          # ledger is append-only audit; rewriting it to dedupe would cost more
          # than the duplicate does.
          for LEDGER_ATTEMPT in 1 2; do
            exec 7>"$HANDOFF_LEDGER.lock"
            if flock -w 5 7; then
              jq -cn --arg target "$TARGET_SHA" --arg freeze "$SHA" --argjson pr "$PR" \
                --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
                '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,
                  runId:$run,verdict:$verdict,finishedAt:$now}' >> "$HANDOFF_LEDGER"
              # VERIFIED like the publish/hold writes above: taking the lock
              # says nothing about the append landing. A writable directory
              # with an unwritable ledger FILE (ENOSPC, chattr +i, a bad mode)
              # left `written:true, reason:null` with no line — the same
              # fail-open the artifact checks exist to close. Read back under
              # the lock, so no other holder's line can be mistaken for ours.
              if tail -1 "$HANDOFF_LEDGER" 2>/dev/null |
                jq -e --arg run "$RUN_ID" --arg now "$NOW" \
                  '.runId == $run and .finishedAt == $now' >/dev/null 2>&1; then
                LEDGER_APPENDED=true
              fi
              flock -u 7
              if [ "$LEDGER_APPENDED" = true ]; then
                break
              fi
              continue
            fi
            flock -u 7 2>/dev/null
          done
          if [ "$LEDGER_APPENDED" != true ]; then
            # The publish/hold artifacts above are correctly written, but the
            # develop gate will never see this outcome without the ledger
            # line — from its side that is indistinguishable from "never
            # finished", so `written` must reflect the WHOLE handoff, not
            # just the artifact files.
            HANDOFF_WRITTEN=false
            # NOT "a later re-finish": this path still clears the slot below,
            # so a second `finish` is refused as not-the-active-run. Naming a
            # recovery the code forbids sends an operator down a dead end at
            # the exact moment the develop gate is blind to this verdict.
            # Append rather than replace: an artifact failure above is the more
            # dangerous half (a hold that never went up) and must not be lost
            # behind the ledger's message.
            if [ -n "$HANDOFF_ARTIFACT_ERROR" ]; then
              HANDOFF_REASON="$HANDOFF_REASON ALSO: ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome either."
            else
              HANDOFF_REASON="ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome. A re-finish will be REFUSED (the slot is cleared): append the ledger line by hand, or reconcile the gate state manually"
            fi
          fi
        fi
      fi
    fi
  fi

  # Artifacts are durable — NOW record the verdict and release the slot. Up to
  # this line a crash is fully recoverable: activeRunId is still this run, so a
  # plain `finish` retry re-runs the (idempotent) work above and completes.
  #
  # Re-verify ownership under the lock before clearing. The window above is
  # network-long, and a human `claim --takeover` inside it means the slot now
  # belongs to a successor: clearing it here would be the very stomp the
  # not-the-active-run guard exists to prevent. The artifacts already written
  # stand (this run did finish, and they name its own runId), so say so rather
  # than pretending nothing happened.
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      --argjson handoffWritten "$HANDOFF_WRITTEN" \
      '{ok:false,error:"the slot changed hands while this finish was writing its artifacts — no verdict recorded, the successor'"'"'s slot left alone",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end),
        handoff:{written:$handoffWritten}}'
    exit 0
  fi
  STATE="$(jq -c \
    --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null' <<<"$STATE")"
  write_pr_state "$PR" "$STATE"
  flock -u 9

  VERDICT_JSON="$(jq -cn \
    --argjson pr "$PR" --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --argjson attempted "$SUSPEND_ATTEMPTED" --argjson ok "$SUSPEND_OK" \
    --argjson status "$SUSPEND_STATUS" --arg reason "$SUSPEND_REASON" \
    --argjson handoffWritten "$HANDOFF_WRITTEN" --arg handoffReason "$HANDOFF_REASON" \
    --arg handoffTargetSha "$HANDOFF_TARGET_SHA" --arg divergence "$HANDOFF_DIVERGENCE" \
    '{schemaVersion:1,pr:$pr,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now,
      suspend:{attempted:$attempted,ok:$ok,httpStatus:$status,
               reason:(if $reason == "" then null else $reason end)},
      handoff:{written:$handoffWritten,
               targetSha:(if $handoffTargetSha == "" then null else $handoffTargetSha end),
               reason:(if $handoffReason == "" then null else $handoffReason end),
               divergenceSnapshot:(if $divergence == "" then null else $divergence end)}}')"
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
# A knob that fell back to its default because the deployed value was not a
# number is a misconfiguration, not a detail — name it in the same alarm.
MISSING="$MISSING$BAD_NUMERIC_CONFIG"
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
  --json number,headRefOid,headRefName --limit 100 2>/dev/null)"
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
  HEAD_REF="$(jq -r '.headRefName // empty' <<<"$ROW")"
  printf '%s' "$HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$' || continue

  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA" "$HEAD_REF")"

  # Facts incomplete — this PR cannot settle this poll. This used to be a bare
  # `continue`, which is how a permanently-unsettleable gate stayed silent for
  # 6.5 hours (see FACTS_STUCK_TIMEOUT). Record when the stall started and
  # alarm once it outlives the window.
  if [ "$(jq -r '.fetchOk' <<<"$FACTS")" != true ]; then
    exec 9>"$(pr_lock_file "$PR")"
    if flock -w 5 9; then
      STATE="$(read_pr_state "$PR")"
      if [ "$(jq -r '.factsStuckSha // empty' <<<"$STATE")" != "$HEAD_SHA" ]; then
        STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$(iso_now)" \
          '.factsStuckSha=$sha | .factsStuckSince=$now' <<<"$STATE")"
        write_pr_state "$PR" "$STATE"
      fi
      STUCK_SINCE="$(epoch_or_zero "$(jq -r '.factsStuckSince // empty' <<<"$STATE")")"
      STUCK_ALERT_SHA="$(jq -r '.factsStuckAlertSha // empty' <<<"$STATE")"
      flock -u 9
      exec 9>&-
      if [ "$STUCK_ALERT_SHA" != "$HEAD_SHA" ] && [ "$STUCK_SINCE" -gt 0 ] &&
         [ "$(( NOW_EPOCH - STUCK_SINCE ))" -ge "$FACTS_STUCK_TIMEOUT" ]; then
        jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"facts"}' >> "$ALARM_CANDIDATES"
      fi
    else
      exec 9>&-
    fi
    continue
  fi

  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    exec 9>&-
    continue
  fi
  STATE="$(read_pr_state "$PR")"
  STATE_DIRTY=false

  # Facts are complete again — drop any stall latch so a later stall re-alarms.
  if [ -n "$(jq -r '.factsStuckSha // empty' <<<"$STATE")" ]; then
    STATE="$(jq -c '.factsStuckSha=null | .factsStuckSince=null | .factsStuckAlertSha=null' <<<"$STATE")"
    STATE_DIRTY=true
  fi

  BACKEND_READY="$(jq -r '.backendReady' <<<"$FACTS")"
  if [ "$BACKEND_READY" = true ]; then
    if [ "$(jq -r '.deployLiveSha // empty' <<<"$STATE")" != "$HEAD_SHA" ]; then
      STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$(iso_now)" \
        '.deployLiveSha=$sha | .deployLiveSince=$now' <<<"$STATE")"
      STATE_DIRTY=true
    fi
  fi
  if [ "$STATE_DIRTY" = true ]; then
    write_pr_state "$PR" "$STATE"
  fi
  flock -u 9
  exec 9>&-

  # The ceiling was demoted from executioner to alarm, and an alarm has to ring.
  # It no longer evicts a stamping run (that produced two coordinators on one
  # campaign), but the case it was really defending against is still real: a
  # ZOMBIE STAMPER — a coordinator whose heartbeat fires while its work is
  # wedged in a retry loop, a stuck lane, or a hung browser. Refusing rival
  # claims only surfaces that if a rival happens to arrive. This fires whether
  # or not anything wants the slot, latched on the run id so one overrun episode
  # alarms once and a later run alarms again.
  # RE-ARMS on an interval. With eviction no longer automatic this alarm is the
  # only thing that surfaces a wedged run, so a once-per-run-id latch would let
  # one missed notification hold the slot silently forever.
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  OVERRUN_LAST="$(jq -r '.overrunAlertAt // empty' <<<"$STATE")"
  OVERRUN_SINCE="$(( $(date -u +%s) - $(epoch_or_zero "$OVERRUN_LAST") ))"
  if [ -n "$ACTIVE_RUN" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ] &&
     { [ "$(jq -r '.overrunAlertRunId // empty' <<<"$STATE")" != "$ACTIVE_RUN" ] ||
       [ "$OVERRUN_SINCE" -ge "$OVERRUN_REALERT_SECONDS" ]; }; then
    ACTIVE_AGE="$(active_run_age "$(jq -r '.activeStartedAt // empty' <<<"$STATE")")"
    if [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ]; then
      jq -cn --argjson pr "$PR" --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
        --arg run "$ACTIVE_RUN" --argjson age "$ACTIVE_AGE" \
        '{pr:$pr,sha:$sha,subtype:"overrun",runId:$run,activeAgeSeconds:$age}' >> "$ALARM_CANDIDATES"
      continue
    fi
  fi

  MIGRATIONS_TOUCHED="$(jq -r '.migrationsTouched' <<<"$FACTS")"
  REFUSED_ALERT_SHA="$(jq -r '.refusedAlertSha // empty' <<<"$STATE")"
  if [ "$MIGRATIONS_TOUCHED" = true ] && [ "$REFUSED_ALERT_SHA" != "$HEAD_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" \
      --argjson files "$(jq -c '.migrationFiles // []' <<<"$FACTS")" \
      --argjson determinable "$(jq -c '.migrationsDeterminable // false' <<<"$FACTS")" \
      '{pr:$pr,sha:$sha,subtype:"migrations",migrationFiles:$files,migrationsDeterminable:$determinable}' >> "$ALARM_CANDIDATES"
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
    # Every other alarm latches on the head SHA; the overrun alarm latches on
    # the RUN id, because the thing that has gone wrong is the run, not the
    # build — and a fresh run id then re-arms it for free, with no reset needed
    # in release/finish.
    W_KEY="$W_SHA"
    [ "$W_SUB" = "warmup" ] && FIELD="warmupAlertSha"
    [ "$W_SUB" = "facts" ] && FIELD="factsStuckAlertSha"
    if [ "$W_SUB" = "overrun" ]; then
      FIELD="overrunAlertRunId"
      W_KEY="$(jq -r '.runId' <<<"$WINNER")"
    fi
    ALREADY="$(jq -r --arg f "$FIELD" '.[$f] // empty' <<<"$STATE")"
    # Overrun is the one alarm that must be able to fire again for the SAME key:
    # it is the only signal that a wedged run is still holding the slot, and a
    # permanent latch would let one missed wake silence it for good. The other
    # subtypes are genuinely one-shot per SHA.
    REARM=false
    if [ "$W_SUB" = "overrun" ]; then
      OVERRUN_LAST="$(jq -r '.overrunAlertAt // empty' <<<"$STATE")"
      [ "$(( $(date -u +%s) - $(epoch_or_zero "$OVERRUN_LAST") ))" -ge "$OVERRUN_REALERT_SECONDS" ] && REARM=true
    fi
    if [ "$ALREADY" != "$W_KEY" ] || [ "$REARM" = true ]; then
      STATE="$(jq -c --arg f "$FIELD" --arg key "$W_KEY" '.[$f]=$key' <<<"$STATE")"
      if [ "$W_SUB" = "overrun" ]; then
        STATE="$(jq -c --arg now "$(iso_now)" '.overrunAlertAt=$now' <<<"$STATE")"
      fi
      write_pr_state "$W_PR" "$STATE"
      TRIGGER="pr_migrations_refused"
      [ "$W_SUB" = "warmup" ] && TRIGGER="pr_warmup_stuck"
      [ "$W_SUB" = "facts" ] && TRIGGER="pr_facts_unavailable"
      [ "$W_SUB" = "overrun" ] && TRIGGER="pr_run_overrun"
      # migrationFiles/migrationsDeterminable ride along on every alarm
      # subtype (empty array for warmup/facts) rather than branching the jq
      # object on $W_SUB — harmless on the two subtypes that don't use it, and
      # this is the wake message MG-1 needed: naming the pending migrations
      # here is what makes the alarm itself the instant answer.
      jq -cn --argjson pr "$W_PR" --arg sha "$W_SHA" --arg trigger "$TRIGGER" \
        --argjson files "$(jq -c '.migrationFiles // []' <<<"$WINNER")" \
        --argjson determinable "$(jq -c '.migrationsDeterminable // false' <<<"$WINNER")" \
        --arg run "$(jq -r '.runId // ""' <<<"$WINNER")" \
        --argjson age "$(jq -r '.activeAgeSeconds // "null"' <<<"$WINNER")" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:$trigger,pr:$pr,sourceSha:$sha,
          migrationFiles:$files,migrationsDeterminable:$determinable,
          runId:(if $run == "" then null else $run end),activeAgeSeconds:$age}}'
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

  # ponytail: a candidate whose preflight keeps failing keeps WINNING — it
  # stays the lowest-numbered settled PR on every poll, so no other labelled PR
  # is ever campaigned, and after the first alarm the repeats are
  # wakeAgent:false. The fingerprint now carries `pr`, so a DIFFERENT PR
  # failing does re-alarm rather than being swallowed by the first one's latch,
  # and the payload names the offender. The starvation itself is NOT fixed:
  # skipping to the next candidate means looping the selection and running
  # preflight once per candidate, up to SMOKE_GATE_PREFLIGHT_TIMEOUT each, in
  # the campaign-opening hot path. Upgrade path: filter candidates with a live
  # per-PR preflight latch out of SETTLE_CANDIDATES at selection time, which
  # needs a per-PR latch this gate does not keep yet. Deferred deliberately —
  # it is a scheduling change, not a correctness one, and wants its own round.
  if [ -n "$PREFLIGHT_CMD" ]; then
    exec 8>"$CONTROL_LOCK"
    flock -w 5 8 || true
    CONTROL="$(read_control)"
    PREFLIGHT_OUT="$TMP_DIR/preflight.out"
    # Target-aware preflight: this candidate's own backend preview URL, so a
    # deployment wired with SMOKE_GATE_PREFLIGHT_CMD referencing this var
    # points its login check at the SAME host the campaign is about to test —
    # never a fixed default host, which would prove nothing about THIS
    # candidate's build. A settle candidate only reaches this line once
    # `settled=true`, which already required healthzReady — so the preview is
    # confirmed up BEFORE preflight ever runs; there is no "not up yet" case
    # to defer here, only an unavailable-URL case to fail closed on.
    PREFLIGHT_TARGET_URL="$(jq -r '.backendPreviewUrl // empty' <<<"$FACTS")"
    if [ -z "$PREFLIGHT_TARGET_URL" ]; then
      # Fail closed rather than run the configured command against nothing
      # (which would either error confusingly or, worse, fall back to
      # whatever default host it carries — e.g. dev — silently testing the
      # wrong build). Never claims across polls: state is untouched, so the
      # very next poll re-evaluates this candidate fresh once a preview URL
      # is available, same "defer, don't skip" shape every other preflight
      # failure already has.
      jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"pr_preflight_failed",
        reason:"settled candidate has no backend preview URL to run a target-aware preflight against"}}'
      exit 0
    fi
    export SMOKE_GATE_PREFLIGHT_TARGET_URL="$PREFLIGHT_TARGET_URL"
    if timeout "$PREFLIGHT_TIMEOUT" bash -c "$PREFLIGHT_CMD" >"$PREFLIGHT_OUT" 2>&1; then
      CONTROL="$(jq -c '.preflightReason=null | .preflightFingerprint=null | .preflightWakeAt=null' <<<"$CONTROL")"
      write_control "$CONTROL"
    else
      PREFLIGHT_RC=$?
      PREFLIGHT_REASON="$(grep -v '^[[:space:]]*$' "$PREFLIGHT_OUT" 2>/dev/null | tail -1 | cut -c1-300)"
      [ -n "$PREFLIGHT_REASON" ] || PREFLIGHT_REASON="preflight command exited $PREFLIGHT_RC with no output"
      [ "$PREFLIGHT_RC" -eq 124 ] && PREFLIGHT_REASON="preflight timed out after ${PREFLIGHT_TIMEOUT}s: $PREFLIGHT_REASON"
      # `preflight_failed` is silenceable, and the ONLY `ack` verb in the fleet
      # is the develop gate's — so an ack filed from here lands in that gate's
      # namespace. Two of qa-seat-preflight's three terminal messages are byte
      # identical constants, so a reason-shaped fingerprint from this gate would
      # match the develop gate's own alarm and silence a campaign-blocking
      # condition nobody acked for it. The `pr|` prefix plus the PR number makes
      # that impossible by construction and discriminates one PR from the next.
      # (See the two invariants at the top of smoke-develop-gate.sh.)
      PREFLIGHT_FINGERPRINT="pr|$PREFLIGHT_REASON|$W_PR"
      LAST_PREFLIGHT_FINGERPRINT="$(jq -r '.preflightFingerprint // empty' <<<"$CONTROL")"
      SINCE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.preflightWakeAt // empty' <<<"$CONTROL")") ))"
      if { [ "$PREFLIGHT_FINGERPRINT" != "$LAST_PREFLIGHT_FINGERPRINT" ] && [ "$SINCE_WAKE" -ge "$PREFLIGHT_REARM_FLOOR_SECONDS" ]; } ||
         [ "$SINCE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
        CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" --arg f "$PREFLIGHT_FINGERPRINT" --arg now "$(iso_now)" \
          '.preflightReason=$r | .preflightFingerprint=$f | .preflightWakeAt=$now' <<<"$CONTROL")"
        write_control "$CONTROL"
        # `pr_preflight_failed`, NOT `preflight_failed`. Dispositions are keyed
        # by trigger name and the develop gate owns the only `ack` verb, so
        # sharing the name meant an ack filed from here overwrote
        # `.dispositions.preflight_failed` and destroyed a live develop-gate
        # silence for an unrelated incident — while this gate, which consults
        # no dispositions at all, re-alarmed every 6h regardless. A distinct
        # name makes `ack` report `silenceable:false` honestly instead of
        # promising a mute nothing here will ever honour.
        # `pr` names WHICH candidate failed. Without it the alarm said only
        # "preflight failed" while the gate silently kept selecting the same
        # lowest-numbered PR every poll — see the ponytail note below.
        jq -cn --arg reason "$PREFLIGHT_REASON" --argjson rc "$PREFLIGHT_RC" --arg fp "$PREFLIGHT_FINGERPRINT" \
          --argjson pr "$W_PR" \
          '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_preflight_failed",pr:$pr,reason:$reason,exitCode:$rc,fingerprint:$fp}}'
        exit 0
      fi
      CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" '.preflightReason=$r' <<<"$CONTROL")"
      write_control "$CONTROL"
      jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"pr_preflight_failed"}}'
      exit 0
    fi
  fi

  exec 9>"$(pr_lock_file "$W_PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
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
