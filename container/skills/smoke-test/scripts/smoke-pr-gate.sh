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
# How long past the liveness window a claimed run may sit dead before
# `pr_run_stalled` rings. Same-run recovery gets first refusal: it fires on the
# first poll past PROGRESS_STALE_SECONDS, but only for a PR that settles ON THAT
# POLL, and one transiently failed fetch is enough to miss it. The grace keeps
# that blip from costing a second wake for a run recovery is about to resume.
num_env STALLED_GRACE_SECONDS SMOKE_GATE_STALLED_GRACE_SECONDS 1800
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

# Preview-identity disambiguation (#1536). Render has twice provisioned two
# services sharing one display name under the same parent (PR #1533, PR
# #1637); positional `[0]` silently took whichever the API listed first — a
# wrong-twin suspend POST at the mutating `finish` site, and a browser lane
# attested against a backend the served frontend never actually calls. Same
# bundle-extraction technique smoke-build-identity.sh already uses (fetch the
# served frontend HTML, pull the hashed JS bundle path, fetch the bundle) —
# reused here as a disambiguation ORACLE rather than a pass/fail check: count
# each ambiguous backend candidate's host inside the bundle and prefer the one
# the frontend actually calls. Same knob name pattern as
# SMOKE_BUILD_ID_BUNDLE_PATTERN so both move together if the shape of Vite's
# hashed output ever changes; default already includes `-` (base64url content
# hashes legitimately contain it, e.g. `index-Cg8w-v89.js` — the real #1533
# bundle name) rather than deferring that gap the way #1366 did.
BUNDLE_PATTERN="${SMOKE_GATE_BUNDLE_PATTERN:-assets/index-[A-Za-z0-9_-]+\.js}"
num_env IDENTITY_TIMEOUT SMOKE_GATE_IDENTITY_TIMEOUT 10

# Campaign-size classification: the install supplies a rules file naming
# which changed paths force the full gauntlet vs. which are UI-only enough to
# get a light campaign — never agent judgment (two PRs called "low risk" by
# eye carried real P1 bugs). Missing file = today's behavior, unchanged
# (`standard`, every field below still emitted for backward compatibility).
SIZING_RULES="${SMOKE_SIZING_RULES:-/workspace/agent/campaign-sizing.json}"
# Resolved next to this script rather than hardcoded to the container path so
# the test suite (which runs this file from container/skills/smoke-test/scripts/,
# not /workspace/agent/) exercises the real classifier, not a stand-in.
SIZING_CLASSIFIER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIZING_CLASSIFIER="$SIZING_CLASSIFIER_DIR/campaign-size-classify.py"
# Journey catalogue (smoke-journeys.py): the install's saved QA journeys and
# the repo paths each one consumes. Install data, like the sizing rules — an
# ABSENT file means the install never adopted one and every output of this
# gate is byte-identical to a gate that has never heard of journeys.
JOURNEYS_CATALOGUE="${SMOKE_JOURNEYS_CATALOGUE:-/workspace/agent/journeys.json}"
JOURNEYS_TOOL="$SIZING_CLASSIFIER_DIR/smoke-journeys.py"

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

# --- Run-level terminal artifact ------------------------------------------
# ONE file per run, created write-once, is the terminal marker. Everything
# else this gate writes about an outcome — pr-<n>-state.json's completed
# fields, pr-<n>-verdict.json, the handoff ledger — is an INDEXED RECEIPT of
# it, never a second authority. Before this existed, `finish` committed
# completed state and wrote its receipt separately, so a crash between them
# left two records that could disagree with nothing to arbitrate.
#
# It lives under this gate's own state dir rather than the skill's
# <qa-run-root>: that tree is on the shared workgroup mount, which `finish`
# has already had to learn can be unwritable mid-run (see the
# HANDOFF_ARTIFACT_ERROR path), and a terminal marker cannot live somewhere
# the gate cannot rely on writing.
run_dir()          { printf '%s/runs/%s' "$STATE_DIR" "$1"; }
run_verdict_file() { printf '%s/runs/%s/verdict.json' "$STATE_DIR" "$1"; }

# Run ids reach the gate from a caller (`claim` takes an arbitrary one) and are
# used as PATH components below, so they are constrained here rather than
# trusted. Rejects `..`, `/`, and anything that would escape the state dir.
run_id_ok() { printf '%s' "${1:-}" | grep -Eq '^[A-Za-z0-9._-]{1,200}$' && [ "${1:-}" != ".." ]; }

# The canonical verdict payload. Key ORDER is part of the contract — jq emits
# in insertion order, so two invocations reasoning about the same terminal
# facts produce byte-identical JSON and therefore the same digest.
verdict_payload() {  # <sha> <runId> <verdict> <finishedAt>
  jq -cn --arg sha "$1" --arg run "$2" --arg verdict "$3" --arg now "$4" \
    '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now}'
}
verdict_digest() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# --- Cross-container coordinator lease -------------------------------------
# The per-PR flock serializes gate PROCESSES; it cannot serialize CONTAINERS,
# because two coordinators in two containers holding the same run id take that
# lock at different moments and both proceed. That is what happened on the
# pr1105 and pr1066 campaigns: two coordinators ran the same campaign
# concurrently and overwrote each other's markers. The shared workgroup FS is
# the only durable medium both can see, so the lease is a file with an expiry.
num_env LEASE_TTL_SECONDS SMOKE_GATE_LEASE_TTL_SECONDS 900
# Identifies the CONTAINER, not the invocation. A coordinator runs many
# separate gate processes over a campaign and all of them must count as the
# same owner; two containers must not. $HOSTNAME is the container id.
DEFAULT_OWNER="${SMOKE_GATE_OWNER:-${HOSTNAME:-unknown-host}}"
# Per-PR history stays deployment-local. Coordinator authority does not: every
# coordinator must see the same lease files and locks through the workgroup
# mount. SMOKE_GATE_SHARED_ROOT is a test seam; deployments leave it unset.
SHARED_LEASE_ROOT="${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}"
LEASE_DIR="${SMOKE_GATE_LEASE_DIR:-$SHARED_LEASE_ROOT/qa-coordinator/leases}"
LEASE_DIR_PREPARED=false
LEASE_DIR_ERROR=""
LIFECYCLE_FENCE_HELD=false
FENCED_AUTHORITY_JSON=""
TASK_BINDING_LOCK_HELD=false
TASK_PRIOR_BINDING_JSON=null
TASK_ACQUIRED_BINDING_JSON=null
TASK_BINDING_CREATED=false
FENCED_TASK_BINDING_JSON=null
TASK_FINISH_COMPLETED_AT=""
TASK_FINISH_VERDICT_DIGEST=""
TASK_PR_RUN_LOCK_HELD=false

new_owner_token() {
  local nonce token
  nonce="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
  printf '%s' "$nonce" | grep -Eq '^[0-9a-f-]{36}$' || return 1
  token="$(printf '%s:%s:%s' "$nonce" "$$" "$(date -u +%s%N)" | sha256sum | cut -d' ' -f1)"
  [ "${#token}" -eq 64 ] || return 1
  printf 'owner-%s' "$token"
}

lease_dir_prepare() {
  local root ancestor ancestor_real dir probe
  if [ "$LEASE_DIR_PREPARED" = true ]; then return 0; fi
  if [ ! -d "$SHARED_LEASE_ROOT" ]; then
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT is missing"
    return 1
  fi
  if ! command -v mountpoint >/dev/null 2>&1 || ! mountpoint -q "$SHARED_LEASE_ROOT"; then
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT is not a mounted filesystem"
    return 1
  fi
  root="$(cd -P "$SHARED_LEASE_ROOT" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT cannot be resolved"; return 1; }
  case "$LEASE_DIR" in
    "$SHARED_LEASE_ROOT"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory $LEASE_DIR is outside $SHARED_LEASE_ROOT"; return 1 ;;
  esac
  ancestor="$LEASE_DIR"
  while [ "$ancestor" != / ] && [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    ancestor="$(dirname "$ancestor")"
  done
  ancestor_real="$(cd -P "$ancestor" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="configured lease directory has no resolvable ancestor: $ancestor"; return 1; }
  case "$ancestor_real" in
    "$root"|"$root"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory resolves through non-shared path $ancestor_real"; return 1 ;;
  esac
  if ! mkdir -p -- "$LEASE_DIR" 2>/dev/null; then
    LEASE_DIR_ERROR="could not create shared lease directory $LEASE_DIR"
    return 1
  fi
  dir="$(cd -P "$LEASE_DIR" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="could not resolve shared lease directory $LEASE_DIR"; return 1; }
  case "$dir" in
    "$root"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory resolves outside shared root: $dir"; return 1 ;;
  esac
  probe="$(mktemp "$dir/.lease-probe.XXXXXX" 2>/dev/null)" || {
    LEASE_DIR_ERROR="shared lease directory is not writable: $dir"; return 1; }
  if ! printf 'probe\n' > "$probe" 2>/dev/null || ! rm -f "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    LEASE_DIR_ERROR="shared lease directory cannot complete an atomic write: $dir"
    return 1
  fi
  LEASE_DIR="$dir"
  LEASE_DIR_PREPARED=true
}

emit_lease_dir_error() {  # <runId> <command>
  jq -cn --arg run "$1" --arg cmd "$2" --arg dir "$LEASE_DIR" --arg detail "$LEASE_DIR_ERROR" \
    '{ok:false,error:("shared coordinator lease unavailable - " + $detail + "; refusing to continue unleased"),
      runId:$run,command:$cmd,leaseDir:$dir}'
}

lease_file()      { printf '%s/lease-%s.json' "$LEASE_DIR" "$1"; }
lease_lock_file() { printf '%s/lease-%s.lock' "$LEASE_DIR" "$1"; }
lease_lifecycle_lock_file() { printf '%s/pr-%s-lifecycle.lock' "$LEASE_DIR" "$1"; }
pr_authority_file() { printf '%s/pr-%s-authority.json' "$LEASE_DIR" "$1"; }

read_pr_authority() {
  local f; f="$(pr_authority_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e --argjson pr "$1" '
      type == "object" and .schemaVersion == 1 and .pr == $pr and
      (.runId | type == "string" and length > 0) and
      (.owner | type == "string" and length > 0) and
      (.boundAt | type == "string" and length > 0)
    ' "$f" >/dev/null 2>&1; then
    jq -c '.' "$f"
  else
    jq -cn --arg path "$f" '{malformedAuthority:true,path:$path}'
  fi
}

write_pr_authority() { # <pr> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.pr-$1-authority.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" >"$tmp" 2>/dev/null &&
    mv "$tmp" "$(pr_authority_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

pr_authority_status() { # <authority-json>: absent|malformed|expired|live
  local authority="$1" run owner lease
  [ "$authority" != null ] || { printf 'absent'; return; }
  jq -e '.malformedAuthority != true' <<<"$authority" >/dev/null 2>&1 || { printf 'malformed'; return; }
  run="$(jq -r '.runId' <<<"$authority")"; owner="$(jq -r '.owner' <<<"$authority")"
  lease="$(read_lease "$run")"
  [ "$(lease_is_malformed "$lease")" != true ] || { printf 'malformed'; return; }
  [ "$lease" != null ] || { printf 'expired'; return; }
  [ "$(jq -r '.owner // empty' <<<"$lease")" = "$owner" ] || { printf 'malformed'; return; }
  [ "$(jq -r '.pr // 0' <<<"$lease")" = "$(jq -r '.pr' <<<"$authority")" ] || { printf 'malformed'; return; }
  if [ "$(lease_is_live "$lease")" = true ]; then printf 'live'; else printf 'expired'; fi
}

bind_pr_authority() { # <pr> <runId> <owner>
  local next
  next="$(jq -cn --argjson pr "$1" --arg run "$2" --arg owner "$3" --arg now "$(iso_now)" \
    '{schemaVersion:1,pr:$pr,runId:$run,owner:$owner,boundAt:$now}')" || return 1
  write_pr_authority "$1" "$next"
}

remove_pr_authority_fenced() { # <pr> <runId> <owner>
  local authority
  authority="$(read_pr_authority "$1")"
  [ "$(jq -r '.runId // empty' <<<"$authority" 2>/dev/null)" = "$2" ] &&
    [ "$(jq -r '.owner // empty' <<<"$authority" 2>/dev/null)" = "$3" ] || return 1
  rm -f "$(pr_authority_file "$1")" 2>/dev/null && [ ! -e "$(pr_authority_file "$1")" ]
}

lease_lifecycle_begin() { # <pr> <runId> <command>
  local pr="$1" run="$2" command="$3"
  if ! lease_dir_prepare; then emit_lease_dir_error "$run" "$command"; return 1; fi
  if ! exec 5>"$(lease_lifecycle_lock_file "$pr")"; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg dir "$LEASE_DIR" --arg cmd "$command" \
      '{ok:false,error:("could not open shared lifecycle lock under " + $dir + " - refusing to continue unleased"),pr:$pr,runId:$run,command:$cmd,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 5; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this PR lifecycle fence - RETRY this same command in ~10s.",pr:$pr,runId:$run,command:$cmd}'
    exec 5>&-
    return 1
  fi
  LIFECYCLE_FENCE_HELD=true
}

lease_lifecycle_end() {
  if [ "$LIFECYCLE_FENCE_HELD" = true ]; then
    flock -u 5 2>/dev/null || true
    exec 5>&-
    LIFECYCLE_FENCE_HELD=false
  fi
}

read_lease() {
  local f lease stamp field; f="$(lease_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e '
      type == "object" and .schemaVersion == 1 and
      (.pr | type == "number" and . >= 1 and . == floor) and
      (.owner | type == "string" and length > 0) and
      (.claimedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.renewedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.expiresAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$f" >/dev/null 2>&1; then
    lease="$(jq -c '.' "$f")"
    for field in claimedAt renewedAt expiresAt; do
      stamp="$(jq -r --arg field "$field" '.[$field]' <<<"$lease")"
      if [ "$(date -u -d "$stamp" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" != "$stamp" ]; then
        jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
        return
      fi
    done
    printf '%s' "$lease"
  else
    jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
  fi
}

lease_is_malformed() {
  jq -e '.malformedLease == true' <<<"${1:-null}" >/dev/null 2>&1 && printf 'true' || printf 'false'
}

lease_is_live() {  # <lease-json>
  local exp
  [ "${1:-null}" != null ] || { printf 'false'; return; }
  exp="$(jq -r '.expiresAt // empty' <<<"$1" 2>/dev/null)"
  if [ -n "$exp" ] && [ "$(date -u +%s)" -lt "$(epoch_or_zero "$exp")" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

lease_expiry_from_now() {
  date -u -d "@$(( $(date -u +%s) + LEASE_TTL_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ'
}

write_lease() {  # <runId> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.lease-$1.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" > "$tmp" 2>/dev/null &&
    mv "$tmp" "$(lease_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null
  return 1
}

# Take (or take over) a run's lease. Prints one JSON line either way; returns 0
# on success, 1 on refusal. Takeover is allowed ONLY against an EXPIRED lease —
# a live lease with a different owner always refuses, which is the whole point.
# The claimant re-reads after writing and verifies it still holds the lease, so
# two claimants racing the same expiry cannot both believe they won.
lease_acquire() {  # <runId> <owner> <pr> [quiet]
  local run="$1" owner="$2" pr="$3" quiet="${4:-}" cur prior_claimed now next back
  if ! lease_dir_prepare; then
    [ -n "$quiet" ] || emit_lease_dir_error "$run" "lease-claim"
    return 1
  fi
  if ! exec 6>"$(lease_lock_file "$run")"; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared lease lock under " + $dir + " - refusing to run unleased"),runId:$run,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" \
      '{ok:false,retryable:true,
        error:"gate_lock_busy: another invocation held this run'"'"'s lease lock — RETRY this same command in ~10s.",
        runId:$run}'
    exec 6>&-
    return 1
  fi
  cur="$(read_lease "$run")"
  if [ "$(lease_is_malformed "$cur")" = true ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg path "$(lease_file "$run")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to overwrite or run unleased"),runId:$run,leaseFile:$path}'
    flock -u 6; exec 6>&-
    return 1
  fi
  # A run id names one PR for its entire on-disk lifetime. Letting an expired
  # lease move to another PR would strand the original PR authority pointer as
  # permanently malformed, and could make one campaign's release affect the
  # other. Recovery may replace the owner after expiry, but never the PR.
  if [ "$cur" != null ] && [ "$(jq -r '.pr // 0' <<<"$cur")" != "$pr" ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson pr "$pr" --argjson lease "$cur" \
      '{ok:false,
        error:("this run id is permanently bound to PR " + ($lease.pr|tostring) +
               " and cannot be reused for PR " + ($pr|tostring)),
        runId:$run,requestedBy:$owner,requestedPr:$pr,
        leasePr:$lease.pr,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
    flock -u 6; exec 6>&-
    return 1
  fi
  if [ "$(lease_is_live "$cur")" = true ] &&
     [ "$(jq -r '.owner // empty' <<<"$cur")" != "$owner" ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson pr "$pr" --argjson lease "$cur" \
      '{ok:false,
        error:("this run id is already held for PR " + ($lease.pr|tostring) + " by " + $lease.owner +
               " until " + $lease.expiresAt + " — STOP; another coordinator owns this campaign"),
        runId:$run,requestedBy:$owner,requestedPr:$pr,
        leasePr:$lease.pr,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
    flock -u 6; exec 6>&-
    return 1
  fi
  # Same owner re-claiming keeps its original claimedAt — the campaign started
  # when it started, and only the expiry moves.
  prior_claimed=""
  [ "$(jq -r '.owner // empty' <<<"$cur")" = "$owner" ] &&
    prior_claimed="$(jq -r '.claimedAt // empty' <<<"$cur")"
  now="$(iso_now)"
  next="$(jq -cn --arg owner "$owner" --argjson pr "$pr" --arg now "$now" \
    --arg claimed "${prior_claimed:-$now}" --arg exp "$(lease_expiry_from_now)" \
    '{schemaVersion:1,pr:$pr,owner:$owner,claimedAt:$claimed,renewedAt:$now,expiresAt:$exp}')"
  if ! write_lease "$run" "$next"; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not write the lease file under " + $dir +
                        " - refusing to run unleased. Fix the shared lease dir and retry."),runId:$run,leaseDir:$dir}'
    flock -u 6; exec 6>&-
    return 1
  fi
  # Verify we hold what we just wrote before telling the caller it may proceed.
  back="$(read_lease "$run")"
  if [ "$(jq -r '.owner // empty' <<<"$back")" != "$owner" ] ||
     [ "$(jq -r '.pr // 0' <<<"$back")" != "$pr" ] ||
     [ "$(lease_is_live "$back")" != true ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$back" \
      '{ok:false,error:"lease write did not stick (raced by another claimant) — do NOT proceed; retry",
        runId:$run,requestedBy:$owner,lease:$lease}'
    flock -u 6; exec 6>&-
    return 1
  fi
  [ -n "$quiet" ] || jq -cn --arg run "$run" --argjson lease "$back" \
    '{ok:true,runId:$run,lease:$lease}'
  flock -u 6; exec 6>&-
  return 0
}

# A lifecycle command holds one shared PR fence and the run lease lock from
# owner validation through its state/effect transition. Separate private state
# roots therefore cannot race each other, and an expired owner cannot act after
# a successor reclaims the lease.
lease_fence_begin() {  # <pr> <runId> <owner> <command>
  local pr="$1" run="$2" owner="$3" command="$4" lease live lease_owner authority
  if [ "$LIFECYCLE_FENCE_HELD" != true ] && ! lease_lifecycle_begin "$pr" "$run" "$command"; then return 1; fi
  if ! exec 6>"$(lease_lock_file "$run")"; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg dir "$LEASE_DIR" --arg cmd "$command" \
      '{ok:false,error:("could not open shared run lease lock under " + $dir + " - refusing to continue unleased"),pr:$pr,runId:$run,command:$cmd,leaseDir:$dir}'
    lease_lifecycle_end
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this run lease lock - RETRY this same command in ~10s.",pr:$pr,runId:$run,command:$cmd}'
    exec 6>&-; lease_lifecycle_end
    return 1
  fi
  lease="$(read_lease "$run")"
  if [ "$(lease_is_malformed "$lease")" = true ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" --arg path "$(lease_file "$run")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing lifecycle authority"),pr:$pr,runId:$run,command:$cmd,leaseFile:$path}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  live="$(lease_is_live "$lease")"
  lease_owner="$(jq -r '.owner // empty' <<<"$lease" 2>/dev/null)"
  if [ "$live" != true ] || [ "$lease_owner" != "$owner" ] ||
     [ "$(jq -r '.pr // 0' <<<"$lease" 2>/dev/null)" != "$pr" ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg owner "$owner" --arg cmd "$command" \
      --argjson lease "$lease" --argjson live "$live" \
      '{ok:false,error:"live shared coordinator lease does not belong to this lifecycle owner - STOP this campaign; if this is the original owner after expiry, recover with claim using the same run id and owner token",pr:$pr,runId:$run,command:$cmd,requestedBy:$owner,held:$live,leaseOwner:($lease.owner // null),expiresAt:($lease.expiresAt // null)}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  authority="$(read_pr_authority "$pr")"
  if [ "$(jq -r '.runId // empty' <<<"$authority" 2>/dev/null)" != "$run" ] ||
     [ "$(jq -r '.owner // empty' <<<"$authority" 2>/dev/null)" != "$owner" ] ||
     [ "$(pr_authority_status "$authority")" != live ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg owner "$owner" --arg cmd "$command" --argjson authority "$authority" \
      '{ok:false,error:"shared PR authority belongs to another run or owner - STOP this campaign",pr:$pr,runId:$run,command:$cmd,requestedBy:$owner,authority:$authority}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  FENCED_LEASE_JSON="$lease"
  FENCED_AUTHORITY_JSON="$authority"
  return 0
}

lease_fence_end() {
  flock -u 6 2>/dev/null || true; exec 6>&-
  lease_lifecycle_end
  FENCED_AUTHORITY_JSON=""
}

lease_remove_fenced() {  # <runId>
  if ! rm -f "$(lease_file "$1")" 2>/dev/null || [ -e "$(lease_file "$1")" ]; then
    return 1
  fi
}

lease_restore_fenced() {  # <runId> <lease-json>
  local restored
  restored="$(jq -c --arg now "$(iso_now)" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$2")" || return 1
  write_lease "$1" "$restored"
}

rollback_poll_ownership() { # <pr> <runId> <owner> <prior-lease> <prior-authority> <acquired-lease> <acquired-authority>
  local pr="$1" run="$2" owner="$3" prior_lease="$4" prior_authority="$5"
  local acquired_lease="$6" acquired_authority="$7" current current_authority
  lease_lifecycle_begin "$pr" "$run" "poll-rollback" >/dev/null 2>&1 || return 1
  exec 6>"$(lease_lock_file "$run")" || { lease_lifecycle_end; return 1; }
  flock -w "$LOCK_WAIT" 6 || { exec 6>&-; lease_lifecycle_end; return 1; }
  current="$(read_lease "$run")"; current_authority="$(read_pr_authority "$pr")"
  # A successor that changed either identity wins. Never roll it back.
  if [ "$current" != "$acquired_lease" ] || [ "$current_authority" != "$acquired_authority" ]; then
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 0
  fi
  if [ "$prior_lease" = null ]; then rm -f "$(lease_file "$run")" 2>/dev/null
  else write_lease "$run" "$prior_lease"; fi || { flock -u 6; exec 6>&-; lease_lifecycle_end; return 1; }
  if [ "$prior_authority" = null ]; then rm -f "$(pr_authority_file "$pr")" 2>/dev/null
  else write_pr_authority "$pr" "$prior_authority"; fi || { flock -u 6; exec 6>&-; lease_lifecycle_end; return 1; }
  flock -u 6; exec 6>&-; lease_lifecycle_end
}

# --- Task-scoped certification lease ---------------------------------------
# A certification, re-verification or evidence-recovery run has no PR to key
# ownership on: no PR gate `claim`, no `pr-<n>-authority.json` binding. Before
# this existed, smoke-run-scaffold.sh's begin_active_run_fence had exactly two
# accepted active-slot shapes (`pr`, `develop`) and refused every task-scoped
# write — "run does not hold the gate in exactly one active slot" — so
# coordinators hand-composed the contract and markers directly, bypassing
# require_coordinator_role, the sourceSha fence, and every other check that
# script exists to enforce.
#
# Unlike a PR number, a task run id is never reused across builds — each
# certification mints its own. The retained binding and expiring lease both
# live in the shared ownership namespace because private gate state differs by
# container. `deploySha` binds permanently at claim and can never change, even
# under --takeover: a different build gets a different run id. Release removes
# only the lease; finish adds exact terminal facts to the retained binding.
# The private task state remains a lifecycle slot and a compatibility source
# for schema-v1 records, but it is not the cross-container identity authority.
task_state_file()      { printf '%s/task-%s-state.json' "$STATE_DIR" "$1"; }
task_lease_file()      { printf '%s/task-lease-%s.json' "$LEASE_DIR" "$1"; }
task_lease_lock_file() { printf '%s/task-lease-%s.lock' "$LEASE_DIR" "$1"; }
task_binding_file()    { printf '%s/task-binding-%s.json' "$LEASE_DIR" "$1"; }

read_task_binding() { # <runId>: null | binding | {malformedTaskBinding:true,path}
  local run="$1" f binding completed stamp
  f="$(task_binding_file "$run")"
  if [ ! -e "$f" ]; then
    printf 'null'
    return
  fi
  if ! binding="$(jq -ce --arg run "$run" '
    def iso: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def terminal_ok:
      . == null or
      (type == "object" and
       (.verdict == "GO" or .verdict == "NO_GO" or .verdict == "HUMAN_DECISION" or .verdict == "BLOCKED") and
       (.completedAt | iso) and
       (.verdictDigest | type == "string" and test("^[0-9a-f]{64}$")));
    select(type == "object" and .schemaVersion == 1 and .kind == "task-binding" and
           .runId == $run and
           (.deploySha | type == "string" and test("^[0-9a-f]{40}$")) and
           (.boundAt | iso) and
           (.terminal | terminal_ok))
  ' "$f" 2>/dev/null)"; then
    jq -cn --arg path "$f" '{malformedTaskBinding:true,path:$path}'
    return
  fi
  for completed in boundAt terminal.completedAt; do
    [ "$completed" = boundAt ] && stamp="$(jq -r '.boundAt' <<<"$binding")" ||
      stamp="$(jq -r '.terminal.completedAt // empty' <<<"$binding")"
    [ -z "$stamp" ] || [ "$(date -u -d "$stamp" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" = "$stamp" ] || {
      jq -cn --arg path "$f" '{malformedTaskBinding:true,path:$path}'
      return
    }
  done
  printf '%s' "$binding"
}

write_task_binding() { # <runId> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.task-binding-$1.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" >"$tmp" 2>/dev/null &&
    mv "$tmp" "$(task_binding_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

task_binding_lock_begin() { # <runId> <command>
  local run="$1" command="$2"
  if ! lease_dir_prepare; then emit_lease_dir_error "$run" "$command"; return 1; fi
  if ! exec 7>"$(task_lease_lock_file "$run")"; then
    jq -cn --arg run "$run" --arg cmd "$command" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared task binding lock under " + $dir + " - refusing claim"),runId:$run,command:$cmd,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 7; then
    jq -cn --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this run identity lock - RETRY this same command in ~10s.",runId:$run,command:$cmd}'
    exec 7>&-
    return 1
  fi
  TASK_BINDING_LOCK_HELD=true
}

task_binding_lock_end() {
  if [ "$TASK_PR_RUN_LOCK_HELD" = true ]; then
    flock -u 6 2>/dev/null || true
    exec 6>&-
    TASK_PR_RUN_LOCK_HELD=false
  fi
  if [ "$TASK_BINDING_LOCK_HELD" = true ]; then
    flock -u 7 2>/dev/null || true
    exec 7>&-
    TASK_BINDING_LOCK_HELD=false
  fi
}

emit_task_binding_conflict() { # <run> <command> <binding> [pr]
  local state_kind
  state_kind="$(read_task_state_binding "$1" | jq -r '.binding')"
  case "$state_kind" in active|released|completed) ;; *)
    if jq -e '.terminal != null' <<<"$3" >/dev/null 2>&1; then state_kind=completed; else state_kind=active; fi ;;
  esac
  jq -cn --arg run "$1" --arg cmd "$2" --arg path "$(task_binding_file "$1")" --arg stateKind "$state_kind" \
    --arg pr "${4:-}" --argjson binding "$3" \
    '{ok:false,error:(if $binding.malformedTaskBinding == true
                      then "shared task binding is malformed at " + $path + " - refusing claim"
                      elif $binding.terminal != null
                      then "run id already finished by a task-scoped run - terminal task run ids must remain unique across the gate"
                      elif $stateKind == "released"
                      then "run id remains bound to a released task-scoped run - run ids must remain unique across the gate"
                      else "run id is already active or permanently bound to a task-scoped run - run ids must remain unique across the gate"
                      end),runId:$run,command:$cmd,
                      pr:(if $pr == "" then null else ($pr|tonumber) end),
                      taskBindingFile:$path,taskBinding:$stateKind,sharedTaskBinding:$binding}'
}

task_binding_guard_absent_begin() { # <runId> <command> [pr]; success leaves fd 7 held
  local run="$1" command="$2" binding pr="${3:-}"
  task_binding_lock_begin "$run" "$command" || return 1
  binding="$(ensure_task_binding_from_local "$run")"
  if [ "$binding" != null ]; then
    if jq -e '.malformedLegacyTaskState == true or .malformedLegacyTaskLease == true or .taskBindingWriteFailed == true' <<<"$binding" >/dev/null 2>&1; then
      jq -cn --arg run "$run" --arg cmd "$command" --arg pr "$pr" --argjson detail "$binding" \
        '{ok:false,error:"task-scoped state cannot be read or made durable - refusing claim",runId:$run,command:$cmd,
          pr:(if $pr == "" then null else ($pr|tonumber) end),detail:$detail}'
    else
      emit_task_binding_conflict "$run" "$command" "$binding" "$pr"
    fi
    task_binding_lock_end
    return 1
  fi
}

# The task state is a private lifecycle record and a legacy compatibility
# source. Empty files are allowed: no task-claim writes one, so they carry no
# binding. Every nonempty record used for backfill must have the shape this
# lifecycle writes; otherwise claim paths fail closed rather than guessing
# which run it may have represented.
read_task_state_binding() {  # <runId> -> {binding:none|active|released|completed,...}
  local run="$1" f binding
  f="$(task_state_file "$run")"
  if [ ! -e "$f" ] || [ ! -s "$f" ]; then
    jq -cn --arg path "$f" '{binding:"none",taskStateFile:$path}'
    return
  fi
  if ! binding="$(jq -ce --arg run "$run" '
    def valid_sha: type == "string" and test("^[0-9a-f]{40}$");
    if type != "object" or .schemaVersion != 1 then error("not a task state object")
    else
      (if has("activeRunId") then .activeRunId else null end) as $active_run |
      (if has("activeSha") then .activeSha else null end) as $active_sha |
      (if has("completedRunId") then .completedRunId else null end) as $completed_run |
      (if has("completedSha") then .completedSha else null end) as $completed_sha |
      if ($active_run != null and $completed_run != null) then error("task state has active and completed runs")
      elif ($active_run != null and (($active_run | type) != "string" or $active_run != $run)) then error("task state names another active run")
      elif ($completed_run != null and (($completed_run | type) != "string" or $completed_run != $run)) then error("task state names another completed run")
      elif $active_run != null then
        if ($active_sha | valid_sha) then {binding:"active",deploySha:$active_sha}
        else error("active task state has no valid deploy SHA") end
      elif $completed_run != null then
        if ($completed_sha | valid_sha) then {binding:"completed",deploySha:$completed_sha}
        else error("completed task state has no valid deploy SHA") end
      elif $active_sha != null then
        if ($active_sha | valid_sha) and $completed_sha == null then {binding:"released",deploySha:$active_sha}
        else error("released task state has an invalid binding") end
      elif $completed_sha != null then error("task state has a completed SHA without a completed run")
      else {binding:"none"}
      end
    end
  ' "$f" 2>/dev/null)"; then
    jq -cn --arg path "$f" '{binding:"malformed",taskStateFile:$path}'
    return
  fi
  jq -cn --argjson binding "$binding" --arg path "$f" '$binding + {taskStateFile:$path}'
}

# Compatibility bridge for schema-v1 state written before the shared binding
# existed. This runs only while task-lease-<run>.lock is held. A completed
# state is migrated only when its private write-once verdict proves every
# terminal fact; an all-null old release has no SHA to prove and remains none.
ensure_task_binding_from_local() { # <runId> -> null | binding | malformed marker
  local run="$1" binding state kind sha next verdict digest at verdict_kind terminal legacy_lease lease_sha state_sha
  binding="$(read_task_binding "$run")"
  if jq -e '.malformedTaskBinding == true' <<<"$binding" >/dev/null 2>&1; then
    printf '%s' "$binding"
    return
  fi
  state="$(read_task_state_binding "$run")"
  kind="$(jq -r '.binding' <<<"$state")"
  if [ "$kind" = malformed ]; then
    jq -cn --arg path "$(jq -r '.taskStateFile' <<<"$state")" \
      '{malformedLegacyTaskState:true,path:$path}'
    return
  fi
  legacy_lease="$(read_task_lease "$run")"
  if [ "$(lease_is_malformed "$legacy_lease")" = true ]; then
    jq -cn --arg path "$(task_lease_file "$run")" \
      '{malformedLegacyTaskLease:true,path:$path}'
    return
  fi
  lease_sha="$(jq -r '.deploySha // empty' <<<"$legacy_lease")"
  if [ "$binding" != null ] && [ "$legacy_lease" != null ] &&
     [ "$(jq -r '.deploySha' <<<"$binding")" != "$lease_sha" ]; then
    jq -cn --arg path "$(task_lease_file "$run")" --argjson binding "$binding" --argjson lease "$legacy_lease" \
      '{malformedLegacyTaskLease:true,path:$path,reason:"shared task lease conflicts with shared task binding",taskBinding:$binding,taskLease:$lease}'
    return
  fi
  state_sha="$(jq -r '.deploySha // empty' <<<"$state")"
  if [ "$kind" != none ] && [ "$legacy_lease" != null ] && [ "$state_sha" != "$lease_sha" ]; then
    jq -cn --arg path "$(task_lease_file "$run")" --argjson state "$state" --argjson lease "$legacy_lease" \
      '{malformedLegacyTaskLease:true,path:$path,reason:"shared task lease conflicts with private task state",taskState:$state,taskLease:$lease}'
    return
  fi
  if [ "$binding" != null ] && [ "$kind" != none ] &&
     [ "$(jq -r '.deploySha' <<<"$binding")" != "$(jq -r '.deploySha' <<<"$state")" ]; then
    jq -cn --arg path "$(jq -r '.taskStateFile' <<<"$state")" --argjson binding "$binding" --argjson state "$state" \
      '{malformedLegacyTaskState:true,path:$path,reason:"private task state conflicts with shared task binding",taskBinding:$binding,taskState:$state}'
    return
  fi
  if [ "$kind" = none ]; then
    if [ "$binding" != null ]; then printf '%s' "$binding"; return; fi
    if [ "$legacy_lease" = null ]; then printf 'null'; return; fi
    next="$(jq -cn --arg run "$run" --arg sha "$lease_sha" --arg at "$(jq -r '.claimedAt' <<<"$legacy_lease")" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
    if ! write_task_binding "$run" "$next" || [ "$(read_task_binding "$run")" != "$next" ]; then
      jq -cn --arg path "$(task_binding_file "$run")" '{taskBindingWriteFailed:true,path:$path}'
      return
    fi
    printf '%s' "$next"
    return
  fi
  sha="$(jq -r '.deploySha' <<<"$state")"
  at="$(iso_now)"
  verdict=null
  if [ "$kind" = completed ] || [ -e "$(run_verdict_file "$run")" ]; then
    verdict="$(jq -ce --arg run "$run" --arg sha "$sha" '
      select(type == "object" and .runId == $run and .sha == $sha and
             (.verdict == "GO" or .verdict == "NO_GO" or .verdict == "HUMAN_DECISION" or .verdict == "BLOCKED") and
             (.finishedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))
    ' "$(run_verdict_file "$run")" 2>/dev/null)" || {
      jq -cn --arg path "$(run_verdict_file "$run")" \
        '{malformedLegacyTaskState:true,path:$path}'
      return
    }
    at="$(jq -r '.finishedAt' <<<"$verdict")"
    [ "$(date -u -d "$at" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" = "$at" ] || {
      jq -cn --arg path "$(run_verdict_file "$run")" '{malformedLegacyTaskState:true,path:$path}'
      return
    }
    digest="$(verdict_digest "$verdict")"
    verdict_kind="$(jq -r '.verdict' <<<"$verdict")"
    terminal="$(jq -cn --arg verdict "$verdict_kind" --arg at "$at" --arg digest "$digest" \
      '{verdict:$verdict,completedAt:$at,verdictDigest:$digest}')"
  else
    terminal=null
  fi
  if [ "$binding" != null ]; then
    if [ "$terminal" != null ]; then
      if [ "$(jq -c '.terminal' <<<"$binding")" = null ]; then
        next="$(jq -c --argjson terminal "$terminal" '.terminal=$terminal' <<<"$binding")"
      elif [ "$(jq -c '.terminal' <<<"$binding")" = "$terminal" ]; then
        printf '%s' "$binding"
        return
      else
        jq -cn --arg path "$(run_verdict_file "$run")" --argjson binding "$binding" --argjson verdict "$verdict" \
          '{malformedLegacyTaskState:true,path:$path,reason:"private verdict conflicts with shared terminal binding",taskBinding:$binding,privateVerdict:$verdict}'
        return
      fi
    else
      # A terminal binding paired with an active private state and no verdict is
      # the supported crash cut after shared terminal commit. task-finish will
      # reconstruct only the exact bound verdict; claim paths still refuse it.
      printf '%s' "$binding"
      return
    fi
  elif [ "$terminal" != null ]; then
    next="$(jq -cn --arg run "$run" --arg sha "$sha" --arg at "$at" --argjson terminal "$terminal" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:$terminal}')"
  else
    next="$(jq -cn --arg run "$run" --arg sha "$sha" --arg at "$at" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
  fi
  if ! write_task_binding "$run" "$next" || [ "$(read_task_binding "$run")" != "$next" ]; then
    jq -cn --arg path "$(task_binding_file "$run")" '{taskBindingWriteFailed:true,path:$path}'
    return
  fi
  printf '%s' "$next"
}

read_task_lease() {
  local f lease stamp field; f="$(task_lease_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e --arg run "$1" '
      type == "object" and .schemaVersion == 1 and .kind == "task" and
      .runId == $run and
      (.deploySha | type == "string" and test("^[0-9a-f]{40}$")) and
      (.owner | type == "string" and length > 0) and
      (.claimedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.renewedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.expiresAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$f" >/dev/null 2>&1; then
    lease="$(jq -c '.' "$f")"
    for field in claimedAt renewedAt expiresAt; do
      stamp="$(jq -r --arg field "$field" '.[$field]' <<<"$lease")"
      if [ "$(date -u -d "$stamp" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" != "$stamp" ]; then
        jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
        return
      fi
    done
    printf '%s' "$lease"
  else
    jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
  fi
}

write_task_lease() {  # <runId> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.task-lease-$1.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" > "$tmp" 2>/dev/null &&
    mv "$tmp" "$(task_lease_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null
  return 1
}

# Same shape and same guarantees as lease_acquire: one shared lock, a re-read
# verification after write, refuse-on-race. Three differences:
#  - the permanently-bound field is `deploySha` here (`.pr` there);
#  - a FINISHED run id is never re-claimable (the check right after the lock);
#  - on SUCCESS it returns with task fd 7 and PR-run fd 6 STILL HELD (#726 F1).
#    Its one caller, `task-claim`, writes the private slot under these locks,
#    then ends them
#    with task_lease_fence_end — after restoring TASK_PRIOR_LEASE_JSON if the
#    slot write failed. Releasing the lock between the lease write and the
#    slot write let two concurrent --takeover claims leave the lease owned by
#    B while task-<run>-state.json named A, after which task-progress,
#    task-release and task-finish refuse both owners.
# Sets TASK_PRIOR_LEASE_JSON (the lease as found, or null) and
# TASK_ACQUIRED_LEASE_JSON (the lease re-read after the write). Call it
# directly, never inside $(…): the lock and both globals would die with the
# subshell. On refusal it prints the refusal JSON and releases both locks.
task_lease_acquire() {  # <runId> <owner> <deploySha>
  local run="$1" owner="$2" sha="$3" cur prior_claimed now next back
  local shared_pr_lease binding state_binding state_kind new_binding cleanup
  TASK_PRIOR_LEASE_JSON=null
  TASK_ACQUIRED_LEASE_JSON=null
  TASK_PRIOR_BINDING_JSON=null
  TASK_ACQUIRED_BINDING_JSON=null
  TASK_BINDING_CREATED=false
  task_binding_lock_begin "$run" task-claim || return 1

  # PR claim/poll writes the shared run lease while holding this same task
  # identity lock. Prove absence under the existing PR run lock and retain
  # that lock through the task binding/private-slot transaction. PR release
  # and finish hold it across lease removal and any rollback restoration, so
  # their temporary absence can never be mistaken for a free identity.
  if ! exec 6>"$(lease_lock_file "$run")"; then
    jq -cn --arg run "$run" --arg path "$(lease_lock_file "$run")" \
      '{ok:false,error:("could not open shared PR run lock at " + $path + " - task-claim refused"),runId:$run}'
    task_binding_lock_end
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --arg run "$run" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this PR run identity lock - RETRY this same task-claim in ~10s.",runId:$run}'
    exec 6>&-
    task_binding_lock_end
    return 1
  fi
  TASK_PR_RUN_LOCK_HELD=true
  shared_pr_lease="$(read_lease "$run")"
  if [ "$(lease_is_malformed "$shared_pr_lease")" = true ]; then
    jq -cn --arg run "$run" --arg path "$(lease_file "$run")" \
      '{ok:false,error:("shared PR run lease is malformed at " + $path + " - task-claim refused"),runId:$run,leaseFile:$path}'
    task_binding_lock_end
    return 1
  fi
  if [ "$shared_pr_lease" != null ]; then
    jq -cn --arg run "$run" --argjson lease "$shared_pr_lease" \
      '{ok:false,error:"run id is already bound by a PR campaign in shared ownership - task-claim refused",runId:$run,activePr:$lease.pr,prLease:$lease}'
    task_binding_lock_end
    return 1
  fi

  cur="$(read_task_lease "$run")"
  if [ "$(lease_is_malformed "$cur")" = true ]; then
    jq -cn --arg run "$run" --arg path "$(task_lease_file "$run")" \
      '{ok:false,error:("shared task lease is malformed at " + $path + " - refusing to overwrite or run unleased"),runId:$run,leaseFile:$path}'
    task_binding_lock_end
    return 1
  fi

  binding="$(ensure_task_binding_from_local "$run")"
  if jq -e '.malformedTaskBinding == true or .malformedLegacyTaskState == true or .malformedLegacyTaskLease == true or .taskBindingWriteFailed == true' <<<"$binding" >/dev/null 2>&1; then
    jq -cn --arg run "$run" --argjson binding "$binding" \
      '{ok:false,error:"task identity evidence is malformed or could not be made durable - task-claim refused",runId:$run,detail:$binding}'
    task_binding_lock_end
    return 1
  fi
  # A legacy shared task lease is authoritative evidence even when this
  # caller's private state root has never seen the run. Backfill it before any
  # takeover/recovery decision, still under the existing lease lock.
  if [ "$binding" = null ] && [ "$cur" != null ]; then
    new_binding="$(jq -cn --arg run "$run" --arg sha "$(jq -r '.deploySha' <<<"$cur")" --arg at "$(iso_now)" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
    if ! write_task_binding "$run" "$new_binding" || [ "$(read_task_binding "$run")" != "$new_binding" ]; then
      jq -cn --arg run "$run" --arg path "$(task_binding_file "$run")" \
        '{ok:false,error:("could not backfill shared task binding at " + $path + " - task-claim refused"),runId:$run,taskBindingFile:$path}'
      task_binding_lock_end
      return 1
    fi
    binding="$new_binding"
  fi
  if [ "$binding" != null ] && [ "$cur" != null ] &&
     [ "$(jq -r '.deploySha' <<<"$binding")" != "$(jq -r '.deploySha' <<<"$cur")" ]; then
    jq -cn --arg run "$run" --argjson binding "$binding" --argjson lease "$cur" \
      '{ok:false,gateStatus:"reconciliation_required",error:"shared task binding conflicts with the task lease - refusing to choose one",runId:$run,taskBinding:$binding,taskLease:$lease}'
    task_binding_lock_end
    return 1
  fi
  if [ "$binding" != null ] && [ "$(jq -r '.terminal != null' <<<"$binding")" = true ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --argjson binding "$binding" \
      '{ok:false,error:"this task run already finished - a terminal run id can never be re-claimed; start a new run id, or resume only the exact interrupted task-finish",runId:$run,requestedBy:$owner,requestedSha:$sha,finished:true,recordedVerdict:$binding.terminal,taskBinding:$binding}'
    task_binding_lock_end
    return 1
  fi
  if [ "$binding" != null ] && [ "$(jq -r '.deploySha' <<<"$binding")" != "$sha" ]; then
    state_binding="$(read_task_state_binding "$run")"
    state_kind="$(jq -r '.binding' <<<"$state_binding")"
    case "$state_kind" in active|released) ;; *) state_kind=shared ;; esac
    jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --arg bindingKind "$state_kind" --argjson binding "$binding" \
      '{ok:false,
        error:("this run id is permanently bound to deploy " + $binding.deploySha +
               " and cannot be reused for deploy " + $sha +
               " — a task-scoped run id is one build for its whole lifetime; start a new run id for a new build"),
        runId:$run,requestedBy:$owner,requestedSha:$sha,
        boundSha:$binding.deploySha,binding:$bindingKind,taskBinding:$binding}'
    task_binding_lock_end
    return 1
  fi
  if [ "$binding" = null ]; then
    new_binding="$(jq -cn --arg run "$run" --arg sha "$sha" --arg at "$(iso_now)" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
    if ! write_task_binding "$run" "$new_binding" || [ "$(read_task_binding "$run")" != "$new_binding" ]; then
      jq -cn --arg run "$run" --arg path "$(task_binding_file "$run")" \
        '{ok:false,error:("could not create permanent shared task binding at " + $path + " - task-claim refused"),runId:$run,taskBindingFile:$path}'
      task_binding_lock_end
      return 1
    fi
    TASK_BINDING_CREATED=true
    binding="$new_binding"
  fi
  TASK_PRIOR_BINDING_JSON="$(if [ "$TASK_BINDING_CREATED" = true ]; then printf 'null'; else printf '%s' "$binding"; fi)"
  TASK_ACQUIRED_BINDING_JSON="$binding"

  if [ "$(lease_is_live "$cur")" = true ] &&
     [ "$(jq -r '.owner // empty' <<<"$cur")" != "$owner" ]; then
    if [ "$TAKEOVER" != true ]; then
      jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$cur" \
        '{ok:false,
          error:("this task run is already held by " + $lease.owner + " until " + $lease.expiresAt +
                 " — STOP; another coordinator owns this run, or re-run with --takeover to force it"),
          runId:$run,requestedBy:$owner,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
      task_binding_lock_end
      return 1
    fi
  fi
  prior_claimed=""
  [ "$(jq -r '.owner // empty' <<<"$cur")" = "$owner" ] &&
    prior_claimed="$(jq -r '.claimedAt // empty' <<<"$cur")"
  now="$(iso_now)"
  next="$(jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --arg now "$now" \
    --arg claimed "${prior_claimed:-$now}" --arg exp "$(lease_expiry_from_now)" \
    '{schemaVersion:1,kind:"task",runId:$run,deploySha:$sha,owner:$owner,claimedAt:$claimed,renewedAt:$now,expiresAt:$exp}')"
  if ! write_task_lease "$run" "$next"; then
    cleanup=""
    if [ "$TASK_BINDING_CREATED" = true ] &&
       { ! rm -f "$(task_binding_file "$run")" 2>/dev/null || [ -e "$(task_binding_file "$run")" ]; }; then
      cleanup="; the just-created shared task binding also could not be removed and requires reconciliation"
    fi
    jq -cn --arg run "$run" --arg dir "$LEASE_DIR" --arg cleanup "$cleanup" \
      '{ok:false,error:("could not write the task lease file under " + $dir +
                        " - refusing to run unleased. Fix the shared lease dir and retry" + $cleanup),runId:$run,leaseDir:$dir}'
    task_binding_lock_end
    return 1
  fi
  back="$(read_task_lease "$run")"
  if [ "$(jq -r '.owner // empty' <<<"$back")" != "$owner" ] ||
     [ "$(jq -r '.deploySha // empty' <<<"$back")" != "$sha" ] ||
     [ "$(lease_is_live "$back")" != true ]; then
    cleanup=""
    if [ "$TASK_BINDING_CREATED" = true ] &&
       { ! rm -f "$(task_binding_file "$run")" 2>/dev/null || [ -e "$(task_binding_file "$run")" ]; }; then
      cleanup="; the just-created shared task binding could not be removed and requires reconciliation"
    fi
    jq -cn --arg run "$run" --arg owner "$owner" --arg cleanup "$cleanup" --argjson lease "$back" \
      '{ok:false,error:("task lease write did not stick (raced by another claimant) — do NOT proceed; retry" + $cleanup),
        runId:$run,requestedBy:$owner,lease:$lease}'
    task_binding_lock_end
    return 1
  fi
  TASK_PRIOR_LEASE_JSON="$cur"
  TASK_ACQUIRED_LEASE_JSON="$back"
  return 0  # fd 7 is still held — the caller ends it (see above)
}

# Same contract as lease_fence_begin: hold the lease lock from owner
# validation through the caller's effect, so a reclaim mid-write is
# impossible. No PR lifecycle fence and no authority file — the run id is
# already the whole key.
task_lease_fence_begin() {  # <runId> <owner> <command>
  local run="$1" owner="$2" command="$3" lease live lease_owner binding new_binding
  task_binding_lock_begin "$run" "$command" || return 1
  lease="$(read_task_lease "$run")"
  if [ "$(lease_is_malformed "$lease")" = true ]; then
    jq -cn --arg run "$run" --arg cmd "$command" --arg path "$(task_lease_file "$run")" \
      '{ok:false,error:("shared task lease is malformed at " + $path + " - refusing lifecycle authority"),runId:$run,command:$cmd,leaseFile:$path}'
    task_binding_lock_end
    return 1
  fi
  binding="$(ensure_task_binding_from_local "$run")"
  if jq -e '.malformedTaskBinding == true or .malformedLegacyTaskState == true or .malformedLegacyTaskLease == true or .taskBindingWriteFailed == true' <<<"$binding" >/dev/null 2>&1; then
    jq -cn --arg run "$run" --arg cmd "$command" --argjson detail "$binding" \
      '{ok:false,error:"task identity evidence is malformed or could not be made durable - refusing lifecycle authority",runId:$run,command:$cmd,detail:$detail}'
    task_binding_lock_end
    return 1
  fi
  if [ "$binding" = null ] && [ "$lease" != null ]; then
    new_binding="$(jq -cn --arg run "$run" --arg sha "$(jq -r '.deploySha' <<<"$lease")" --arg at "$(iso_now)" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
    if ! write_task_binding "$run" "$new_binding" || [ "$(read_task_binding "$run")" != "$new_binding" ]; then
      jq -cn --arg run "$run" --arg cmd "$command" --arg path "$(task_binding_file "$run")" \
        '{ok:false,error:("could not backfill shared task binding at " + $path + " - refusing lifecycle authority"),runId:$run,command:$cmd,taskBindingFile:$path}'
      task_binding_lock_end
      return 1
    fi
    binding="$new_binding"
  fi
  if [ "$binding" = null ] || [ "$lease" = null ] ||
     [ "$(jq -r '.terminal != null' <<<"$binding")" = true ] ||
     [ "$(jq -r '.deploySha' <<<"$binding")" != "$(jq -r '.deploySha // empty' <<<"$lease")" ]; then
    jq -cn --arg run "$run" --arg cmd "$command" --argjson binding "$binding" --argjson lease "$lease" \
      '{ok:false,error:"shared task binding and live lease do not prove one unfinished lifecycle - refusing",runId:$run,command:$cmd,taskBinding:$binding,taskLease:$lease}'
    task_binding_lock_end
    return 1
  fi
  live="$(lease_is_live "$lease")"
  lease_owner="$(jq -r '.owner // empty' <<<"$lease" 2>/dev/null)"
  if [ "$live" != true ] || [ "$lease_owner" != "$owner" ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --arg cmd "$command" --argjson lease "$lease" --argjson live "$live" \
      '{ok:false,error:"live shared task lease does not belong to this lifecycle owner - STOP this run; if this is the original owner after expiry, recover with task-claim using the same run id, owner token and deploy SHA",runId:$run,command:$cmd,requestedBy:$owner,held:$live,leaseOwner:($lease.owner // null),expiresAt:($lease.expiresAt // null)}'
    task_binding_lock_end
    return 1
  fi
  FENCED_TASK_LEASE_JSON="$lease"
  return 0
}

task_finish_fence_begin() { # <run> <owner> <sha> <verdict> <completedAt> <digest> <hasPrivateVerdict>
  local run="$1" owner="$2" sha="$3" verdict="$4" completed_at="$5" digest="$6"
  local has_private_verdict="$7" binding lease new_binding expected_digest
  TASK_FINISH_COMPLETED_AT="$completed_at"
  TASK_FINISH_VERDICT_DIGEST="$digest"
  task_binding_lock_begin "$run" task-finish || return 1
  binding="$(ensure_task_binding_from_local "$run")"
  lease="$(read_task_lease "$run")"
  if jq -e '.malformedTaskBinding == true or .malformedLegacyTaskState == true or .malformedLegacyTaskLease == true or .taskBindingWriteFailed == true' <<<"$binding" >/dev/null 2>&1 ||
     [ "$(lease_is_malformed "$lease")" = true ]; then
    jq -cn --arg run "$run" --argjson binding "$binding" --argjson lease "$lease" \
      '{ok:false,error:"task finish cannot reconcile malformed shared identity evidence",runId:$run,taskBinding:$binding,taskLease:$lease}'
    task_binding_lock_end
    return 1
  fi
  if [ "$binding" = null ] && [ "$lease" != null ]; then
    new_binding="$(jq -cn --arg run "$run" --arg sha "$(jq -r '.deploySha' <<<"$lease")" --arg at "$(iso_now)" \
      '{schemaVersion:1,kind:"task-binding",runId:$run,deploySha:$sha,boundAt:$at,terminal:null}')"
    if ! write_task_binding "$run" "$new_binding" || [ "$(read_task_binding "$run")" != "$new_binding" ]; then
      jq -cn --arg run "$run" --arg path "$(task_binding_file "$run")" \
        '{ok:false,error:("could not backfill shared task binding at " + $path + " - task-finish refused"),runId:$run,taskBindingFile:$path}'
      task_binding_lock_end
      return 1
    fi
    binding="$new_binding"
  fi
  if [ "$binding" = null ] || [ "$(jq -r '.deploySha // empty' <<<"$binding")" != "$sha" ]; then
    jq -cn --arg run "$run" --arg sha "$sha" --argjson binding "$binding" \
      '{ok:false,gateStatus:"reconciliation_required",error:"shared task binding does not match this finish - refusing",runId:$run,attemptedSha:$sha,taskBinding:$binding}'
    task_binding_lock_end
    return 1
  fi
  if [ "$(jq -r '.terminal != null' <<<"$binding")" = true ]; then
    if [ "$has_private_verdict" != true ]; then
      completed_at="$(jq -r '.terminal.completedAt' <<<"$binding")"
      digest="$(jq -r '.terminal.verdictDigest' <<<"$binding")"
      expected_digest="$(verdict_digest "$(verdict_payload "$sha" "$run" "$verdict" "$completed_at")")"
      TASK_FINISH_COMPLETED_AT="$completed_at"
      TASK_FINISH_VERDICT_DIGEST="$digest"
    else
      expected_digest="$digest"
    fi
    if [ "$expected_digest" != "$digest" ] ||
       ! jq -e --arg verdict "$verdict" --arg at "$completed_at" --arg digest "$digest" \
         '.terminal.verdict == $verdict and .terminal.completedAt == $at and .terminal.verdictDigest == $digest' <<<"$binding" >/dev/null 2>&1; then
      jq -cn --arg run "$run" --arg verdict "$verdict" --arg at "$completed_at" --arg digest "$digest" --argjson binding "$binding" \
        '{ok:false,gateStatus:"reconciliation_required",error:"shared task terminal facts conflict with this exact finish - nothing changed",runId:$run,taskBinding:$binding,attemptedTerminal:{verdict:$verdict,completedAt:$at,verdictDigest:$digest}}'
      task_binding_lock_end
      return 1
    fi
    if [ "$lease" != null ] && [ "$(jq -r '.owner // empty' <<<"$lease")" != "$owner" ]; then
      jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$lease" \
        '{ok:false,gateStatus:"reconciliation_required",error:"terminal task binding is paired with another lease owner - refusing reconciliation",runId:$run,requestedBy:$owner,taskLease:$lease}'
      task_binding_lock_end
      return 1
    fi
    FENCED_TASK_LEASE_JSON="$lease"
    FENCED_TASK_BINDING_JSON="$binding"
    return 0
  fi
  if [ "$lease" = null ] || [ "$(lease_is_live "$lease")" != true ] ||
     [ "$(jq -r '.owner // empty' <<<"$lease")" != "$owner" ] ||
     [ "$(jq -r '.deploySha // empty' <<<"$lease")" != "$sha" ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$lease" \
      '{ok:false,error:"live shared task lease does not belong to this unfinished finish owner",runId:$run,requestedBy:$owner,taskLease:$lease}'
    task_binding_lock_end
    return 1
  fi
  FENCED_TASK_LEASE_JSON="$lease"
  FENCED_TASK_BINDING_JSON="$binding"
  return 0
}

task_lease_fence_end() {
  task_binding_lock_end
}

task_lease_remove_fenced() {  # <runId>
  if ! rm -f "$(task_lease_file "$1")" 2>/dev/null || [ -e "$(task_lease_file "$1")" ]; then
    return 1
  fi
}

# --- Challenger disposition ------------------------------------------------
# A campaign is not finishable until the challenger files a disposition, and
# twice (pr1195, pr1228) one never was: challenger/disposition.md was never
# written and the coordinator waited forever with nothing anywhere saying so.
# `claim` now stamps a deadline and `challenger-timeout` converts an expired
# one into a BLOCKED verdict — never into permission to synthesize.
num_env CHALLENGER_TIMEOUT_SECONDS SMOKE_GATE_CHALLENGER_TIMEOUT_SECONDS 5400
# The skill's <qa-run-root> — the coordinator's evidence tree, which is where
# the challenger actually writes. Unset means this deployment has not told the
# gate where to look, and `challenger-timeout` REFUSES rather than reading a
# failed lookup as "no disposition": absence is only evidence when presence
# was possible.
CHALLENGER_RUN_ROOT="${SMOKE_GATE_RUN_ROOT:-}"
challenger_disposition_file() { printf '%s/%s/challenger/disposition.md' "$CHALLENGER_RUN_ROOT" "$1"; }
challenger_deadline_from_now() {
  date -u -d "@$(( $(date -u +%s) + CHALLENGER_TIMEOUT_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ'
}

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
    activeLeaseOwner: null,
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
    stalledAlertRunId: null,
    displacedRunId: null,
    displacedAt: null,
    finishIntent: null,
    completedVerdictDigest: null,
    gateStatus: null,
    reconciliation: null,
    challengerDeadline: null,
    challengerDisposition: null,
    challengerTimedOutAt: null
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
  tmp="$(mktemp "$STATE_DIR/.pr-$n-state.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$next" > "$tmp" 2>/dev/null ||
     ! mv "$tmp" "$(pr_state_file "$n")" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

default_control() {
  jq -cn '{
    schemaVersion: 1,
    fetchFailures: 0,
    lastFailureWakeAt: null,
    lastMisconfigWakeAt: null,
    leaseFailureFingerprint: null,
    leaseFailureWakeAt: null,
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

emit_poll_lease_failure() { # <detail-json>
  local detail="$1" fingerprint last now wake=false control
  # A live owner is ordinary contention: the existing campaign remains the
  # only authority and the watcher stays quiet. Lock contention is retryable
  # on the next scheduled poll and is quiet for the same reason.
  if jq -e '(.leaseOwner // null) != null or .retryable == true' <<<"$detail" >/dev/null 2>&1; then
    jq -cn --argjson detail "$detail" \
      '{ok:false,wakeAgent:false,data:{schemaVersion:1,trigger:"coordinator_lease_unavailable",detail:$detail}}'
    return
  fi
  fingerprint="$(jq -r '.error // "unknown shared lease failure"' <<<"$detail" | sha256sum | cut -d' ' -f1)"
  exec 4>"$CONTROL_LOCK"
  if flock -w 5 4; then
    control="$(read_control)"
    last="$(epoch_or_zero "$(jq -r --arg fp "$fingerprint" 'if .leaseFailureFingerprint == $fp then .leaseFailureWakeAt // empty else empty end' <<<"$control")")"
    now="$(date -u +%s)"
    if [ "$(( now - last ))" -ge 21600 ]; then wake=true; fi
    control="$(jq -c --arg fp "$fingerprint" --arg at "$(iso_now)" --argjson wake "$wake" \
      '.leaseFailureFingerprint=$fp | if $wake then .leaseFailureWakeAt=$at else . end' <<<"$control")"
    write_control "$control" || wake=true
    flock -u 4
  else
    wake=true
  fi
  exec 4>&-
  jq -cn --argjson wake "$wake" --argjson detail "$detail" \
    '{ok:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"coordinator_lease_unavailable",detail:$detail}}'
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

# Same scan, widened to a run that has already released the slot. Only the
# verdict-reconciliation path uses this: once a run-level verdict.json exists,
# the run is no longer anybody's activeRunId, and the mismatch still has to be
# recorded against the PR it belonged to.
find_pr_for_any_run() {
  local run_id="$1" f pr
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if jq -e --arg r "$run_id" \
         '(.activeRunId // "") == $r or (.completedRunId // "") == $r or ((.finishIntent.runId // "") == $r)' \
         "$f" >/dev/null 2>&1; then
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

# Enumerates EVERY match, never just the positional first (#1536's original
# defect). Returns a JSON array of {id,name,url}, empty when nothing matches.
find_preview_candidates() {
  local services_json="$1" parent_id="$2" pr="$3"
  jq -c --arg pid "$parent_id" --arg suffix "PR #$pr" '
    [.[]? | (.service // .) | select(.serviceDetails.parentServer.id == $pid) | select(.name | endswith($suffix))
     | {id:(.id // null), name:(.name // null), url:(.serviceDetails.url // null)}]
  ' <<<"$services_json" 2>/dev/null
}

# Disambiguation oracle for 2+ backend candidates: fetch the served frontend
# HTML, extract the hashed JS bundle path (identical technique to
# smoke-build-identity.sh), fetch the bundle, and count each candidate's host
# inside it. Prints `{resolved:<candidate>|null, reason:<string>|null}`.
# `resolved` is non-null ONLY when exactly one candidate's host is referenced
# and every other candidate's host is not — any other outcome (no frontend url,
# fetch failure, unextractable bundle path, zero or 2+ candidates referenced)
# is a refusal with a stated reason. Never guesses.
resolve_backend_by_bundle() {
  local frontend_url="$1" candidates_json="$2"
  local tmp html_file bundle_path bundle_url bundle_file

  if [ -z "$frontend_url" ] || [ "$frontend_url" = "null" ]; then
    jq -cn '{resolved:null, reason:"no healthy frontend preview URL available to disambiguate against"}'
    return 0
  fi

  tmp="$(mktemp -d)"
  html_file="$tmp/index.html"
  if ! timeout "$IDENTITY_TIMEOUT" curl -fsS --max-time "$IDENTITY_TIMEOUT" "${frontend_url%/}/" >"$html_file" 2>/dev/null; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"failed to fetch the served frontend HTML to disambiguate"}'
    return 0
  fi

  bundle_path="$(grep -oE "$BUNDLE_PATTERN" "$html_file" 2>/dev/null | head -1)"
  if [ -z "$bundle_path" ]; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"could not extract a JS bundle path from the served frontend HTML"}'
    return 0
  fi

  bundle_url="${frontend_url%/}/$bundle_path"
  bundle_file="$tmp/bundle.js"
  if ! timeout "$IDENTITY_TIMEOUT" curl -fsS --max-time "$IDENTITY_TIMEOUT" "$bundle_url" >"$bundle_file" 2>/dev/null; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"failed to fetch the served JS bundle to disambiguate"}'
    return 0
  fi

  local n idx url host count matched=0 match_json=null
  n="$(jq 'length' <<<"$candidates_json")"
  for (( idx=0; idx<n; idx++ )); do
    url="$(jq -r ".[$idx].url // empty" <<<"$candidates_json")"
    [ -n "$url" ] || continue
    host="$(printf '%s' "$url" | sed -E 's#^https?://##; s#/.*$##')"
    [ -n "$host" ] || continue
    # `grep -c` prints "0" on stdout AND exits 1 when nothing matched — a
    # zero count is not a failure, so the fallback only covers a genuine
    # error (e.g. an unreadable file), never `grep`'s own no-match exit code.
    count="$(grep -cF -- "$host" "$bundle_file" 2>/dev/null)"
    [ -n "$count" ] || count=0
    if [ "$count" -gt 0 ]; then
      matched=$((matched + 1))
      match_json="$(jq -c ".[$idx]" <<<"$candidates_json")"
    fi
  done
  rm -rf "$tmp"

  if [ "$matched" -eq 1 ]; then
    jq -cn --argjson c "$match_json" '{resolved:$c, reason:null}'
  elif [ "$matched" -eq 0 ]; then
    jq -cn '{resolved:null, reason:"the served bundle references none of the candidate backend hosts"}'
  else
    jq -cn '{resolved:null, reason:"the served bundle references more than one candidate backend host"}'
  fi
}

# Resolves ONE backend preview's identity for a PR. Prints
# `{selected:<candidate>|null, method:"none"|"single"|"bundle-disambiguated"|"ambiguous",
#   candidates:[...], reason:<string>|null}`.
# `frontend_url` is the (already-resolved, unambiguous) frontend preview URL,
# or empty when unavailable — bundle disambiguation is attempted only when
# there is more than one backend candidate, so an unambiguous PR never touches
# the network for it.
resolve_backend_identity() {
  local services_json="$1" pr="$2" frontend_url="$3"
  local candidates n disambig resolved reason full_reason
  candidates="$(find_preview_candidates "$services_json" "$BACKEND_SERVICE" "$pr")"
  n="$(jq 'length' <<<"$candidates")"
  if [ "$n" -eq 0 ]; then
    jq -cn --argjson c "$candidates" '{selected:null, method:"none", candidates:$c, reason:null}'
    return 0
  fi
  if [ "$n" -eq 1 ]; then
    jq -cn --argjson c "$candidates" '{selected:$c[0], method:"single", candidates:$c, reason:null}'
    return 0
  fi
  disambig="$(resolve_backend_by_bundle "$frontend_url" "$candidates")"
  resolved="$(jq -c '.resolved' <<<"$disambig")"
  if [ "$resolved" != null ]; then
    jq -cn --argjson c "$candidates" --argjson sel "$resolved" \
      '{selected:$sel, method:"bundle-disambiguated", candidates:$c, reason:null}'
    return 0
  fi
  reason="$(jq -r '.reason // "ambiguous"' <<<"$disambig")"
  full_reason="$(jq -r --arg pr "$pr" --arg why "$reason" '
    "refusing to select a backend preview for PR #" + $pr + ": " +
    (length | tostring) + " services share that name — " +
    ([.[] | ((.name // "unnamed") + " (" + (.id // "no id") + ")")] | join(", ")) +
    ". " + $why + " (#1536)."
  ' <<<"$candidates")"
  jq -cn --argjson c "$candidates" --arg reason "$full_reason" \
    '{selected:null, method:"ambiguous", candidates:$c, reason:$reason}'
}

# Resolves ONE frontend preview's identity for a PR. When Render left a failed
# duplicate alongside the live preview, the deployment records are the
# authoritative discriminator: exactly one candidate with a live, commit-bound
# deployment is safe to select. Multiple live candidates and any unavailable
# deployment lookup remain an unconditional refusal.
resolve_frontend_identity() {
  local services_json="$1" pr="$2"
  local candidates n full_reason candidate candidate_id live_sha live_candidates live_n query_failure
  candidates="$(find_preview_candidates "$services_json" "$FRONTEND_SERVICE" "$pr")"
  n="$(jq 'length' <<<"$candidates")"
  if [ "$n" -eq 0 ]; then
    jq -cn --argjson c "$candidates" '{selected:null, method:"none", candidates:$c, reason:null}'
    return 0
  fi
  if [ "$n" -eq 1 ]; then
    jq -cn --argjson c "$candidates" '{selected:$c[0], method:"single", candidates:$c, reason:null}'
    return 0
  fi

  live_candidates='[]'
  query_failure=""
  while IFS= read -r candidate; do
    candidate_id="$(jq -r '.id // empty' <<<"$candidate")"
    if [ -z "$candidate_id" ]; then
      query_failure="a candidate has no Render service id"
      break
    fi
    if ! live_sha="$(latest_live_deploy_sha "$candidate_id")"; then
      query_failure="could not read deployment status for $candidate_id"
      break
    fi
    if [ -n "$live_sha" ]; then
      live_candidates="$(jq -cn --argjson current "$live_candidates" --argjson item "$candidate" '$current + [$item]')"
    fi
  done < <(jq -c '.[]' <<<"$candidates")

  if [ -z "$query_failure" ]; then
    live_n="$(jq 'length' <<<"$live_candidates")"
    if [ "$live_n" -eq 1 ]; then
      jq -cn --argjson c "$candidates" --argjson live "$live_candidates" \
        '{selected:$live[0], method:"live-deploy-filtered", candidates:$c, reason:null}'
      return 0
    fi
    query_failure="${live_n} candidates have a live, commit-bound deployment"
  fi

  full_reason="$(jq -r --arg pr "$pr" --arg why "$query_failure" '
    "refusing to select a frontend preview for PR #" + $pr + ": " +
    (length | tostring) + " services share that name — " +
    ([.[] | ((.name // "unnamed") + " (" + (.id // "no id") + ")")] | join(", ")) +
    ". " + $why + "; a unique live deployment is required (#1536)."
  ' <<<"$candidates")"
  jq -cn --argjson c "$candidates" --arg reason "$full_reason" \
    '{selected:null, method:"ambiguous", candidates:$c, reason:$reason}'
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

# Prints one `{campaignSize, sizeReason}` JSON object. Classification is
# mechanical, never agent judgment — the whole point (two PRs called "low
# risk" by eye carried real P1 bugs). Two ways in:
#   determinable=false -> fail closed to `full` on fail_reason alone, no rules
#     file or glob matching ever runs. The caller decides "determinable" from
#     facts this function has no access to (fetchOk, truncation) — same
#     fail-closed direction as migrationsTouched/frontendTouched above.
#   determinable=true  -> delegate to campaign-size-classify.py, which reads
#     the install-supplied rules file (or reports "no sizing rules" if it is
#     absent — backward compatible: nothing changes for installs that never
#     added one) and matches changed_files_json (a JSON array of repo-relative
#     paths) against it. A classifier crash or malformed reply is itself
#     fail-closed to `full`, same direction as every other fetch in this gate.
campaign_size_classify() {
  local determinable="$1" fail_reason="$2" changed_files_json="${3:-[]}"
  local rules_path="$SIZING_RULES" out
  if [ "$determinable" != true ]; then
    jq -cn --arg reason "$fail_reason" '{campaignSize:"full", sizeReason:("full: " + $reason)}'
    return 0
  fi
  if ! out="$(printf '%s' "$changed_files_json" | timeout 10 python3 "$SIZING_CLASSIFIER" "$rules_path" 2>/dev/null)" ||
     ! jq -e 'type == "object" and (.campaignSize | type == "string") and (.sizeReason | type == "string")' \
       <<<"$out" >/dev/null 2>&1; then
    jq -cn '{campaignSize:"full", sizeReason:"full: campaign size classifier failed"}'
    return 0
  fi
  printf '%s' "$out"
}

# --- Freeze-campaign range pin -----------------------------------------------
# A pin holds EVERYTHING range-derived for one freeze head: the campaignRange
# object (baseline, determinable, reason, fileListMethod), the changed-path
# list, the migration/frontend facts read from it, and the size verdict
# classified from it. `poll` promotes one at the first SETTLED evaluation of
# that head — the moment a campaign can be opened — and from then on every
# `poll`, `check` and recovery wake of that head READS it instead of
# recomputing. Pinning only the baseline was not enough: a transient compare
# or tree failure opens a campaign as unknown/`full`, and a recomputing
# recovery wake could come back determinable/`standard` — shrinking required
# coverage, and changing migrationsInRange, for the SAME run. Sizing is in the
# pin for the same reason (the rules file can change between two polls).
#
# STORAGE INVARIANT: a pin outlives and out-reaches everything that could
# recompute it. range_pin_lookup and range_pin_promote are the ONLY code that
# touches pins; check, poll and recovery all go through them.
#   IMMUTABLE, KEYED BY HEAD SHA, first write wins. One file per (repo, PR,
#     head), created with `ln` — which fails on EEXIST — so creation is atomic
#     and can never replace an existing pin, PR lock held or not. An evaluation
#     of head Y addresses a different file than head X's pin. (A single slot in
#     the PR state could not give this: a slow poll holding an OLD head's
#     result overwrote it after a newer head had pinned and opened its
#     campaign.) Pins are never trimmed here: a trim can race the claim that
#     would protect the pin. They are small; pruning belongs to evidence
#     retention, which can see whether a head still has a non-terminal run.
#   SHARED, like campaign ownership. A run can be resumed through the shared
#     lease by a coordinator with a DIFFERENT private state dir; a pin under
#     the first coordinator's STATE_DIR would be invisible to it and it would
#     recompute. Pins live in LEASE_DIR — the same validated shared directory
#     the leases and PR authority use (lease_dir_prepare) — repo-qualified.
#     No usable shared directory means no pin can be kept: the head reports
#     unknown/`full` and is NOT offered. Never a private pin.
#   INVALID IS NOT ABSENT. Anything at a pin's path that is not a well-formed
#     pin for that head — truncated, a symlink (dangling or not), a directory —
#     is `invalid`: the original scope is unrecoverable, so the head reports
#     unknown/`full` and is still OFFERED (a full campaign is the safe answer).
#     It is never recomputed over, replaced, moved or deleted.
RANGE_PIN_SHAPE='type == "object" and .schemaVersion == 1 and (.headSha | type == "string") and
  (.campaignRange | type == "object") and (.campaignRange.determinable | type == "boolean") and
  (.rangePaths | type == "array") and (.migrationFiles | type == "array") and
  (.migrationsTouched | type == "boolean") and (.frontendTouched | type == "boolean") and
  (.migrationsDeterminable | type == "boolean") and
  ((.migrationsInRange | type) as $t | $t == "array" or $t == "null") and
  (.campaignSize | type == "string") and (.sizeReason | type == "string")'
range_pin_file() {  # <pr> <head-sha>
  printf '%s/range-pin-%s-pr-%s-%s.json' "$LEASE_DIR" \
    "$(printf '%s' "$REPO" | sed -e 's#/#__#g' -e 's/[^A-Za-z0-9._-]/_/g')" "$1" "$2"
}
# Read-only twin of lease_dir_prepare's checks (that one creates the directory
# and probes a write; `check` must not). Prints a reason and returns 1 when
# pins cannot be trusted to be shared; a lease dir that does not exist yet is
# fine — it simply holds no pins.
range_pin_store_readable() {
  local root dir
  [ -d "$SHARED_LEASE_ROOT" ] || { printf 'shared lease root %s is missing' "$SHARED_LEASE_ROOT"; return 1; }
  command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$SHARED_LEASE_ROOT" ||
    { printf 'shared lease root %s is not a mounted filesystem' "$SHARED_LEASE_ROOT"; return 1; }
  root="$(cd -P "$SHARED_LEASE_ROOT" 2>/dev/null && pwd -P)" ||
    { printf 'shared lease root %s cannot be resolved' "$SHARED_LEASE_ROOT"; return 1; }
  case "$LEASE_DIR" in
    "$SHARED_LEASE_ROOT"/*|"$root"/*) ;;
    *) printf 'lease directory %s is outside the shared root' "$LEASE_DIR"; return 1 ;;
  esac
  [ -e "$LEASE_DIR" ] || [ -L "$LEASE_DIR" ] || return 0
  dir="$(cd -P "$LEASE_DIR" 2>/dev/null && pwd -P)" ||
    { printf 'lease directory %s cannot be resolved' "$LEASE_DIR"; return 1; }
  case "$dir" in
    "$root"/*) ;;
    *) printf 'lease directory resolves outside the shared root: %s' "$dir"; return 1 ;;
  esac
}
# Prints ONE envelope: {state:"valid",pin} | {state:"absent"} |
# {state:"invalid",reason} | {state:"unavailable",reason}.
range_pin_lookup() {  # <pr> <head-sha>
  local f why
  if ! why="$(range_pin_store_readable)"; then
    jq -cn --arg why "$why" '{state:"unavailable",reason:("range pins cannot be kept on shared storage (" + $why + ")")}'
    return 0
  fi
  f="$(range_pin_file "$1" "$2")"
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then jq -cn '{state:"absent"}'; return 0; fi
  if [ -L "$f" ]; then why="a symlink"
  elif [ ! -f "$f" ]; then why="not a regular file"
  elif jq -c --arg h "$2" "if (($RANGE_PIN_SHAPE) and .headSha == \$h) then {state:\"valid\",pin:.} else error(\"shape\") end" \
         "$f" 2>/dev/null; then return 0
  else why="truncated or malformed"
  fi
  jq -cn --arg f "$f" --arg why "$why" \
    '{state:"invalid",reason:("the range pin for this head (" + $f + ") is " + $why + ", so the scope it pinned cannot be recovered")}'
}
# Promote a candidate to THE pin for (pr, head). First write wins; a second
# promotion for the same head changes nothing on disk. Returns 0 when this call
# created the pin, 3 when something already occupies the pin's path (a pin, or
# an invalid one — either way the caller's freshly computed facts are not what
# the head is pinned to), 1 when no pin exists and none could be created.
range_pin_promote() {  # <pr> <head-sha> <candidate-file>
  local pr="$1" head="$2" candidate="$3" f tmp
  printf '%s' "$pr" | grep -Eq '^[0-9]+$' && printf '%s' "$head" | grep -Eq '^[0-9a-f]{40}$' || return 1
  lease_dir_prepare || { printf 'smoke-pr-gate: range pin not written: %s\n' "$LEASE_DIR_ERROR" >&2; return 1; }
  f="$(range_pin_file "$pr" "$head")"
  if [ -e "$f" ] || [ -L "$f" ]; then return 3; fi
  tmp="$(mktemp "$LEASE_DIR/.range-pin-pr-$pr.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -c --arg h "$head" --arg now "$(iso_now)" \
         "select(($RANGE_PIN_SHAPE) and .headSha == \$h) | . + {pinnedAt:\$now}" \
         "$candidate" > "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  if ln "$tmp" "$f" 2>/dev/null; then rm -f "$tmp" 2>/dev/null; return 0; fi
  rm -f "$tmp" 2>/dev/null
  if [ -e "$f" ] || [ -L "$f" ]; then return 3; fi
  return 1
}

# --- Freeze-campaign journey selection (smoke-journeys.py) ---------------------
# Which saved journeys this campaign owes, which changed paths no journey
# claims, and whether the change is a native-manual one. Derived from the
# campaign's range paths and NOTHING else — the caller hands in the same
# `range_paths_json` sizing reads, which IS the pinned list whenever the range
# pin is valid — and then pinned itself, because the two inputs the range pin
# does not hold can also move between two polls: the catalogue, and the floor's
# last-proven dates. Same storage invariant as the range pin, through the same
# primitives (range_pin_file's naming, range_pin_store_readable,
# lease_dir_prepare, `ln` fail-on-exists): shared LEASE_DIR, immutable, keyed by
# (repo, PR, head), never trimmed, invalid is not absent. The catalogue bytes
# the selection was computed from are kept beside it, content-addressed.
JOURNEYS_PIN_SHAPE='type == "object" and .schemaVersion == 1 and (.selection | type == "string") and
  (.route | type == "string") and (.matchedJourneys | type == "array") and (.unmappedPaths | type == "array")'
journeys_pin_file() {  # <pr> <head-sha>
  local f
  f="$(range_pin_file "$1" "$2")"
  printf '%s/journeys-pin-%s' "$LEASE_DIR" "${f##*/range-pin-}"
}
journeys_full() {  # <reason> <pinState> — the fail-closed selection: full, said why
  jq -cn --arg reason "$1" --arg state "$2" \
    '{schemaVersion:1, selection:"full", reason:$reason, route:"web", catalogueValid:false,
      catalogueSha256:null, matchedJourneys:[], unmappedPaths:[], excludedPaths:[],
      unassessedNativeJourneys:[], pinned:false, pinFile:null, catalogueSnapshot:null, pinState:$state}'
}
# Prints the selection (one JSON object), or `null` when the install has no
# catalogue AND this head has no journeys pin. Range-sized data reaches the
# matcher on stdin, never argv. An undeterminable range is `selection:"full"`,
# never an empty match; a matcher crash fails closed the same way.
journeys_select() {  # <pr> <head-sha> <determinable> <fail-reason> <paths-json> <size>
  local pr="$1" head_sha="$2" determinable="$3" fail_reason="$4" paths_json="${5:-[]}" size="$6"
  local f why out snapshot_out=""
  local -a args
  if ! why="$(range_pin_store_readable)"; then
    [ -e "$JOURNEYS_CATALOGUE" ] || [ -L "$JOURNEYS_CATALOGUE" ] || { printf 'null'; return 0; }
    journeys_full "journey selection cannot be pinned on shared storage ($why)" unavailable
    return 0
  fi
  f="$(journeys_pin_file "$pr" "$head_sha")"
  if [ -e "$f" ] || [ -L "$f" ]; then
    if [ -L "$f" ]; then why="a symlink"
    elif [ ! -f "$f" ]; then why="not a regular file"
    elif jq -ce --arg h "$head_sha" "select(($JOURNEYS_PIN_SHAPE) and .pinned == true and .headSha == \$h)" "$f" 2>/dev/null; then
      return 0
    else why="truncated or malformed"
    fi
    journeys_full "the journeys pin for this head ($f) is $why, so the selection it pinned cannot be recovered" invalid
    return 0
  fi
  [ -e "$JOURNEYS_CATALOGUE" ] || [ -L "$JOURNEYS_CATALOGUE" ] || { printf 'null'; return 0; }
  args=(--catalogue "$JOURNEYS_CATALOGUE" --size "$size" --run-root "${SMOKE_GATE_RUN_ROOT:-}")
  [ "$determinable" = true ] || args+=(--unknown "range not determinable: $fail_reason")
  # Like the range pin's candidate: written only where `poll` can promote it.
  if [ "$COMMAND" = poll ] && [ -n "${TMP_DIR:-}" ]; then
    snapshot_out="$TMP_DIR/journeys-catalogue-$pr.json"
    rm -f "$snapshot_out" "$TMP_DIR/journeys-pin-$pr.json" 2>/dev/null
    args+=(--snapshot-out "$snapshot_out")
  fi
  if ! out="$(printf '%s' "$paths_json" | timeout 20 python3 "$JOURNEYS_TOOL" match "${args[@]}" 2>/dev/null)" ||
     ! out="$(jq -ce "select($JOURNEYS_PIN_SHAPE) | . + {pinState:\"absent\"}" <<<"$out" 2>/dev/null)"; then
    out="$(journeys_full "journey matcher failed" absent)"
    [ -z "$snapshot_out" ] || rm -f "$snapshot_out" 2>/dev/null
  fi
  [ -z "$snapshot_out" ] || printf '%s' "$out" > "$TMP_DIR/journeys-pin-$pr.json" 2>/dev/null || true
  printf '%s' "$out"
}
# Promote poll's candidate to THE journeys pin for (pr, head), catalogue
# snapshot first. Same return contract as range_pin_promote: 0 created, 3 the
# path is already occupied, 1 nothing could be created.
journeys_pin_promote() {  # <pr> <head-sha> <candidate> <snapshot-candidate>
  local pr="$1" head="$2" candidate="$3" snapshot="$4" f tmp digest snap=""
  printf '%s' "$pr" | grep -Eq '^[0-9]+$' && printf '%s' "$head" | grep -Eq '^[0-9a-f]{40}$' || return 1
  lease_dir_prepare || { printf 'smoke-pr-gate: journeys pin not written: %s\n' "$LEASE_DIR_ERROR" >&2; return 1; }
  f="$(journeys_pin_file "$pr" "$head")"
  if [ -e "$f" ] || [ -L "$f" ]; then return 3; fi
  digest="$(jq -r '.catalogueSha256 // empty' "$candidate" 2>/dev/null)" || return 1
  if [ -n "$digest" ]; then
    printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' && [ -f "$snapshot" ] &&
      [ "$(sha256sum < "$snapshot" | cut -d' ' -f1)" = "$digest" ] || return 1
    snap="$LEASE_DIR/journeys-catalogue-$digest.json"
    if [ ! -e "$snap" ] && [ ! -L "$snap" ]; then
      tmp="$(mktemp "$LEASE_DIR/.journeys-catalogue.XXXXXX" 2>/dev/null)" || return 1
      cat "$snapshot" > "$tmp" 2>/dev/null && { ln "$tmp" "$snap" 2>/dev/null || true; }
      rm -f "$tmp" 2>/dev/null
    fi
    # Content-addressed, so an existing one is fine exactly when it verifies.
    if [ -L "$snap" ] || [ ! -f "$snap" ] || [ "$(sha256sum < "$snap" | cut -d' ' -f1)" != "$digest" ]; then
      printf 'smoke-pr-gate: journeys pin not written: catalogue snapshot %s does not verify\n' "$snap" >&2
      return 1
    fi
  fi
  tmp="$(mktemp "$LEASE_DIR/.journeys-pin-pr-$pr.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -c --arg h "$head" --arg now "$(iso_now)" --arg f "$f" --arg snap "$snap" \
         "select($JOURNEYS_PIN_SHAPE) | . + {headSha:\$h, pinned:true, pinState:\"valid\", pinFile:\$f,
            catalogueSnapshot:(if \$snap == \"\" then null else \$snap end), pinnedAt:\$now}" \
         "$candidate" > "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
    rm -f "$tmp" 2>/dev/null; return 1
  fi
  if ln "$tmp" "$f" 2>/dev/null; then rm -f "$tmp" 2>/dev/null; return 0; fi
  rm -f "$tmp" 2>/dev/null
  if [ -e "$f" ] || [ -L "$f" ]; then return 3; fi
  return 1
}

# --- Freeze-campaign baseline ------------------------------------------------
# A freeze PR's target sits ON the tracked branch: smoke-freeze-pr.sh takes a
# "full 40-character SHA on SMOKE_GATE_BRANCH" (smoke-freeze-pr.sh:22), creates
# the marker commit with that SHA as its ONLY parent (`parents:[$parent]`,
# $parent = $TARGET_SHA, smoke-freeze-pr.sh:100-104) and opens the PR against
# that same branch (`--base "$BRANCH"`, smoke-freeze-pr.sh:120). So `compare/$BRANCH...target`
# has a head that is an ancestor-or-equal of its base and is EMPTY for every
# freeze — status "behind"/"identical", zero files. Migration facts, sizing and
# the human-facing range all read that empty list as "nothing changed". The
# range a campaign actually covers is "everything since the build last
# certified": baseline = targetSha of the newest handoff-ledger entry with
# verdict GO whose receipt VALIDATES. The ledger is appended by this gate's own
# `finish` (see HANDOFF_LEDGER above); a later BLOCKED on the same target does
# not unseat a GO, because BLOCKED asserts nothing about the build (see the
# hold handling in `finish`). Never the PR state's completedSha — that advances
# on every verdict, NO_GO included.
#
# A GO line validates when (1) its verdictDigest is the sha256 of the run's
# write-once verdict.json and that file agrees on runId / verdict / freezeSha /
# finishedAt, and (2) its target/PR binding holds. verdict_payload() does not
# cover targetSha or freezePr, so the digest alone would let a line re-point a
# genuine GO at any SHA; the binding is re-derived from GitHub — the freeze
# commit's first parent must be targetSha, and freezePr's head must be that
# freeze commit. A line that fails is skipped for the next-older GO: an older
# baseline only ever WIDENS the range, which is the safe direction.
#
# Prints {baselineSha, runId, resolved, reason}. `resolved:false` means the
# answer could not be established this call (a binding fetch failed);
# `resolved:true` with a null baselineSha is the conclusive "no validated GO
# exists". Stability across one campaign is not this function's job: the whole
# range result, this baseline included, is pinned per head (see
# range_pin_promote).
BASELINE_CANDIDATE_LIMIT=10

# Complete changed-file list between two commits, from their recursive trees.
# An entry is compared on its FULL identity — mode + type + sha — for `blob`
# and `commit` (submodule) entries, so a chmod-only change (same blob sha) and
# a submodule bump are both in the list; `tree` entries are directories, not
# files, and are excluded.
# changed = added ∪ removed ∪ identity-differs, so a rename shows up as BOTH
# its old and its new path (which is what sizing wants — see previous_filename
# in the sizing block). Two API calls. Prints {"files":[{"filename":…},…]} and
# returns 0; on any failure prints a short reason and returns 1. `truncated`
# on either tree is a failure: GitHub truncates past its own entry/size limit
# and a truncated tree is no more complete than the capped compare it replaces.
# stdin is closed on the fetches: this runs inside poll's `while read` loop.
campaign_range_tree_files() {  # <baseline-sha> <target-sha>
  local side sha tree base_tree="" target_tree=""
  for side in baseline target; do
    [ "$side" = baseline ] && sha="$1" || sha="$2"
    if ! tree="$(timeout 20 gh api "repos/$REPO/git/trees/$sha?recursive=1" </dev/null 2>/dev/null)"; then
      printf 'the %s tree could not be fetched' "$side"; return 1
    fi
    # Every entry must carry a COMPLETE identity and a KNOWN type. A blob or
    # commit entry missing its sha would compare as equal on both sides and
    # drop a changed file as unchanged; an unknown type would be skipped.
    if ! jq -e '(.truncated | type == "boolean") and (.tree | type == "array") and
                all(.tree[]; (.path | type == "string") and (.path != "") and
                  (.type == "tree" or
                   ((.type == "blob" or .type == "commit") and
                    (.mode | type == "string") and (.mode != "") and
                    (.sha | type == "string") and (.sha != ""))))' \
         <<<"$tree" >/dev/null 2>&1; then
      printf 'the %s tree is malformed' "$side"; return 1
    fi
    if [ "$(jq -r '.truncated' <<<"$tree")" != false ]; then
      printf 'the %s tree is truncated' "$side"; return 1
    fi
    [ "$side" = baseline ] && base_tree="$tree" || target_tree="$tree"
  done
  jq -cn --slurpfile a <(printf '%s' "$base_tree") --slurpfile b <(printf '%s' "$target_tree") '
    def entries: [.tree[] | select(.type == "blob" or .type == "commit") |
                  {key: .path, value: [.mode, .type, .sha]}] | from_entries;
    ($a[0] | entries) as $x | ($b[0] | entries) as $y |
    {files: [(($x | keys) + ($y | keys)) | unique | .[] | select($x[.] != $y[.]) | {filename: .}]}
  ' 2>/dev/null || { printf 'the tree diff could not be computed'; return 1; }
}
resolve_campaign_baseline() {
  local line n=0
  local l_target l_freeze l_pr l_run l_digest l_finished vfile vjson parent pr_head
  if [ -z "$HANDOFF_LEDGER" ] || [ ! -s "$HANDOFF_LEDGER" ]; then
    jq -cn '{baselineSha:null,runId:null,resolved:true,
             reason:"no handoff ledger is configured or it is empty, so there is no certified baseline"}'
    return 0
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    n="$(( n + 1 ))"
    [ "$n" -le "$BASELINE_CANDIDATE_LIMIT" ] || break
    l_target="$(jq -r '.targetSha // empty' <<<"$line")"
    l_freeze="$(jq -r '.freezeSha // empty' <<<"$line")"
    l_pr="$(jq -r 'if (.freezePr | type) == "number" then (.freezePr | floor | tostring) else "" end' <<<"$line")"
    l_run="$(jq -r '.runId // empty' <<<"$line")"
    l_digest="$(jq -r '.verdictDigest // empty' <<<"$line")"
    l_finished="$(jq -r '.finishedAt // empty' <<<"$line")"
    printf '%s' "$l_target" | grep -Eq '^[0-9a-f]{40}$' || continue
    printf '%s' "$l_freeze" | grep -Eq '^[0-9a-f]{40}$' || continue
    printf '%s' "$l_digest" | grep -Eq '^[0-9a-f]{64}$' || continue
    [ -n "$l_pr" ] && run_id_ok "$l_run" || continue
    vfile="$(run_verdict_file "$l_run")"
    [ -s "$vfile" ] || continue
    vjson="$(jq -c '.' "$vfile" 2>/dev/null || printf '')"
    [ -n "$vjson" ] && [ "$(verdict_digest "$vjson")" = "$l_digest" ] || continue
    jq -e --arg run "$l_run" --arg sha "$l_freeze" --arg at "$l_finished" \
      '.runId == $run and .verdict == "GO" and .sha == $sha and .finishedAt == $at' \
      <<<"$vjson" >/dev/null 2>&1 || continue
    if ! parent="$(timeout 8 gh api "repos/$REPO/commits/$l_freeze" --jq '.parents[0].sha // empty' 2>/dev/null)" ||
       [ -z "$parent" ] ||
       ! pr_head="$(timeout 8 gh api "repos/$REPO/pulls/$l_pr" --jq '.head.sha // empty' 2>/dev/null)" ||
       [ -z "$pr_head" ]; then
      jq -cn --arg run "$l_run" \
        '{baselineSha:null,runId:null,resolved:false,
          reason:("the target/PR binding of GO receipt " + $run + " could not be fetched, so the certified baseline is unverified")}'
      return 0
    fi
    [ "$parent" = "$l_target" ] && [ "$pr_head" = "$l_freeze" ] || continue
    jq -cn --arg sha "$l_target" --arg run "$l_run" \
      '{baselineSha:$sha,runId:$run,resolved:true,reason:null}'
    return 0
  done < <(jq -cR 'fromjson? | select(type == "object") | select(.verdict == "GO")' \
             "$HANDOFF_LEDGER" 2>/dev/null | tac)
  jq -cn '{baselineSha:null,runId:null,resolved:true,
           reason:"no GO entry in the handoff ledger has a validating receipt, so there is no certified baseline"}'
}

# Core settle computation for one PR — shared by `check` (read-only) and
# `poll` (per-candidate evaluation). Every fetch is timeout-bounded; any hard
# failure or truncated (>=100, same ceiling smoke-develop-gate.sh uses for its
# 300-file compare guard) file/check-run listing fails closed in the SAFER
# direction: migrations-touched and frontend-touched default to true, CI
# defaults to not-ready. Prints one JSON facts line.
evaluate_pr() {
  local pr="$1" head_sha="$2" head_ref="${3:-}"
  local files_json files_len files_fetch_failed migrations_touched frontend_touched frontend_required is_freeze ci_sha
  local migration_files migrations_determinable target_files_json target_files_len
  local baseline_json baseline_sha range_determinable range_reason migrations_in_range campaign_range_json
  local range_files_method range_paths_json range_pin="" range_pin_size_out="" range_pin_state=absent
  local runs_json runs_len ci_total ci_pending ci_failed ci_succeeded ci_ready ci_truncated
  local services_json backend backend_id backend_url backend_deploy_sha backend_ready
  local frontend frontend_id frontend_url frontend_deploy_sha frontend_ready
  local frontend_identity frontend_method frontend_candidates_json
  local backend_identity backend_method backend_candidates_json
  local preview_ambiguous preview_ambiguity_text frontend_evidence_gap FR_REASON
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
  # migration 222_undo_edit_prior_actor and `check 1188` reported
  # migrationsTouched:false anyway.
  #
  # That fix recomputed them off `compare/$BRANCH...target` — which is empty
  # for EVERY freeze, because the target is on $BRANCH (see the baseline
  # comment above resolve_campaign_baseline). Its tests passed on fixtures that
  # hand-set `"status":"ahead"` with files, a response the API cannot return
  # for that call shape. The range is now ONE value, `campaignRange` =
  # validated-GO baseline ... target, and everything range-derived for a freeze
  # (these two booleans, migrationFiles, migrationsInRange, sizing, and the
  # range a human or a route selector quotes) reads it and nothing else.
  #
  # Determinable only when the compare says the target is strictly AHEAD of
  # the baseline (status "ahead", behind_by 0) with a complete non-empty file
  # list (compare's own below its 300 cap, else the recursive tree diff), or
  # when baseline == target (the one legitimately empty range — no fetch
  # needed). behind / diverged / identical-with-different-SHAs / malformed /
  # a truncated tree / fetch failure / no validated GO all mean the range
  # is UNKNOWN: size `full`, migrationsInRange null — never `[]`, which would
  # claim a confirmed read. Same ahead-and-not-behind shape as the develop
  # gate's deploy_lag_safe (smoke-develop-gate.sh:1505-1514: status "ahead",
  # behind 0, then its own <300 files guard).
  #
  # Range uncertainty deliberately does NOT clear fetch_ok. fetch_ok means
  # "readiness facts are missing" and clamps `settled` in `check` and skips the
  # candidate in `poll`; an unknown range is a statement about campaign SCOPE,
  # answered by running the full gauntlet, not by never running. A missing
  # target identity (ci_sha) still clears it, above.
  migrations_determinable=true
  migration_files='[]'
  migrations_in_range=null
  campaign_range_json=null
  if [ "$is_freeze" = true ]; then
    baseline_sha=""
    range_determinable=false
    range_reason=""
    range_files_method=""
    target_files_json='{"files":[]}'
    range_pin="$(range_pin_lookup "$pr" "$head_sha")"
    range_pin_state="$(jq -r '.state // "invalid"' <<<"$range_pin" 2>/dev/null)"
    case "$range_pin_state" in
      valid) range_pin="$(jq -c '.pin' <<<"$range_pin")" ;;
      absent) range_pin="" ;;
      invalid|unavailable)
        # Nothing is fetched or recomputed: an invalid pin's scope is
        # unrecoverable, and without shared storage no scope can be kept.
        range_reason="$(jq -r '.reason // "the range pin for this head could not be read"' <<<"$range_pin" 2>/dev/null)"
        range_pin="" ;;
      *) range_pin_state=invalid; range_reason="the range pin for this head could not be read"; range_pin="" ;;
    esac
    if [ -n "$range_pin" ]; then
      # This head's campaign range is pinned: read it, fetch nothing.
      range_determinable="$(jq -r '.campaignRange.determinable' <<<"$range_pin")"
      range_reason="$(jq -r '.campaignRange.reason // ""' <<<"$range_pin")"
      range_paths_json="$(jq -c '.rangePaths' <<<"$range_pin")"
      migrations_touched="$(jq -r '.migrationsTouched' <<<"$range_pin")"
      frontend_touched="$(jq -r '.frontendTouched' <<<"$range_pin")"
      migrations_determinable="$(jq -r '.migrationsDeterminable' <<<"$range_pin")"
      migration_files="$(jq -c '.migrationFiles' <<<"$range_pin")"
      migrations_in_range="$(jq -c '.migrationsInRange' <<<"$range_pin")"
      campaign_range_json="$(jq -c '.campaignRange + {baselinePinned:true}' <<<"$range_pin")"
      range_pin_size_out="$(jq -c '{campaignSize, sizeReason}' <<<"$range_pin")"
    elif [ "$range_pin_state" != absent ]; then
      :
    elif [ -z "$ci_sha" ]; then
      range_reason="the freeze target commit could not be determined"
    else
      baseline_json="$(resolve_campaign_baseline)"
      jq -e 'type == "object"' <<<"$baseline_json" >/dev/null 2>&1 ||
        baseline_json='{"baselineSha":null,"reason":"the certified baseline could not be resolved"}'
      baseline_sha="$(jq -r '.baselineSha // empty' <<<"$baseline_json")"
      if [ -z "$baseline_sha" ]; then
        range_reason="$(jq -r '.reason // "the certified baseline could not be resolved"' <<<"$baseline_json")"
      elif [ "$baseline_sha" = "$ci_sha" ]; then
        range_determinable=true
      elif ! target_files_json="$(timeout 10 gh api "repos/$REPO/compare/$baseline_sha...$ci_sha" 2>/dev/null)" ||
           ! jq -e 'type == "object"' <<<"$target_files_json" >/dev/null 2>&1; then
        # `if !` on the direct assignment (not just a post-hoc shape check)
        # catches a nonzero gh exit even when it still printed something on
        # stdout — same pattern the files_json fetch above already uses.
        target_files_json='{"files":[]}'
        range_reason="the baseline...target comparison could not be fetched"
      elif ! jq -e '(.status | type == "string") and (.behind_by | type == "number") and
                    (.files | type == "array") and all(.files[]; (.filename | type == "string"))' \
             <<<"$target_files_json" >/dev/null 2>&1; then
        target_files_json='{"files":[]}'
        range_reason="the baseline...target comparison is malformed"
      elif [ "$(jq -r '.status == "ahead" and .behind_by == 0' <<<"$target_files_json")" != true ]; then
        range_reason="the target is not strictly ahead of the certified baseline (compare status: $(jq -r '.status' <<<"$target_files_json"))"
        target_files_json='{"files":[]}'
      else
        target_files_len="$(jq -r '.files | length' <<<"$target_files_json")"
        if [ "$target_files_len" -ge 300 ] 2>/dev/null; then
          # The compare endpoint caps `.files` at 300 and its pagination pages
          # only COMMITS (page 2 carries no further files), so at the cap the
          # list is incomplete — an artifact of that endpoint, not real
          # uncertainty. The two recursive trees are complete, so the file list
          # comes from them instead. Compare is still what vouched for
          # ahead/behind above; a truncated, failed or malformed tree leaves
          # the range unknown exactly as before.
          if target_files_json="$(campaign_range_tree_files "$baseline_sha" "$ci_sha")"; then
            range_files_method=tree
            if [ "$(jq -r '.files | length' <<<"$target_files_json")" -eq 0 ] 2>/dev/null; then
              range_reason="the baseline and target trees are identical although the SHAs differ"
            else
              range_determinable=true
            fi
          else
            range_reason="the baseline...target comparison is at the 300-file cap and the complete tree diff is unavailable ($target_files_json)"
            target_files_json='{"files":[]}'
          fi
        elif [ "$target_files_len" -eq 0 ] 2>/dev/null; then
          range_reason="the baseline...target comparison is empty although the SHAs differ"
        else
          range_determinable=true
          range_files_method=compare
        fi
      fi
    fi
    if [ -z "$range_pin" ]; then
      # ONE path list for everything range-derived below (migration facts,
      # frontend fact, sizing): both the new AND the previous path of every
      # entry. A file renamed or moved OUT of a prefix carries that prefix only
      # in `previous_filename`, and a migration that left the migrations folder
      # is still a changed migration — reading `.filename` alone reported
      # migrationsTouched:false / migrationsInRange:[] for exactly that range.
      range_paths_json='[]'
      if [ "$range_determinable" = true ]; then
        range_paths_json="$(jq -c '[.files[] | .filename, (.previous_filename // empty)]' <<<"$target_files_json" 2>/dev/null)"
        jq -e 'type == "array" and all(.[]; type == "string")' <<<"$range_paths_json" >/dev/null 2>&1 || range_paths_json=""
        migrations_touched="$(jq -r --arg p "$MIGRATIONS_PREFIX" 'any(.[]; startswith($p))' <<<"$range_paths_json" 2>/dev/null)"
        frontend_touched="$(jq -r --arg p "$FRONTEND_PREFIX" 'any(.[]; startswith($p))' <<<"$range_paths_json" 2>/dev/null)"
        migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.[] | select(startswith($p))] | unique' <<<"$range_paths_json" 2>/dev/null)"
      fi
      if [ "$range_determinable" != true ] ||
         { [ "$migrations_touched" != true ] && [ "$migrations_touched" != false ]; } ||
         { [ "$frontend_touched" != true ] && [ "$frontend_touched" != false ]; } ||
         ! jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1; then
        [ -n "$range_reason" ] || range_reason="the baseline...target comparison could not be read"
        range_determinable=false
        # Fail-closed ASSUMPTIONS, flagged as such by migrationsDeterminable.
        migrations_touched=true
        frontend_touched=true
        migrations_determinable=false
        migration_files='[]'
      else
        migrations_in_range="$migration_files"
      fi
      campaign_range_json="$(jq -cn --arg base "$baseline_sha" --arg target "$ci_sha" \
        --argjson determinable "$range_determinable" --arg reason "$range_reason" \
        --argjson baseline "${baseline_json:-null}" --arg method "$range_files_method" \
        '{baselineSha:(if $base == "" then null else $base end),
          targetSha:(if $target == "" then null else $target end),
          determinable:$determinable,
          reason:(if $determinable then null else $reason end),
          # Which source produced the file list: "compare", "tree" (compare was
          # at its 300-file cap), or null when no list was needed or obtained.
          fileListMethod:(if $determinable and $method != "" then $method else null end),
          baselineRunId:($baseline.runId // null),
          baselineResolved:($baseline.resolved // false),
          baselinePinned:false}')"
    fi
    # pinState: valid (read from the pin) | absent (computed; poll may promote
    # it) | invalid (unknown/full, offered, never promoted over) | unavailable
    # (no shared pin storage: unknown/full, NOT offered).
    campaign_range_json="$(jq -c --arg st "$range_pin_state" '. + {pinState:$st}' <<<"$campaign_range_json")"
  elif [ "$files_fetch_failed" = true ] || { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
    # Ordinary (non-freeze) PR whose own diff we couldn't read — same
    # fail-closed default as migrations_touched above, and equally unable to
    # name which files, so say so rather than reporting an empty list as fact.
    migrations_determinable=false
  else
    migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.[].filename | select(startswith($p))]' <<<"$files_json" 2>/dev/null)"
    [ -n "$migration_files" ] && jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1 || migration_files='[]'
  fi

  # --- Campaign-size classification -----------------------------------------
  # A freeze PR's OWN diff is always exactly the two markers (see the
  # migrationsTouched/frontendTouched comment above), so a freeze classifies
  # off campaignRange's file list, never files_json. Determinability IS
  # campaignRange.determinable — one range, one answer; an unknown range sizes
  # `full` with the range's own reason.
  local size_files_json='[]' size_determinable=true size_fail_reason=""
  if [ "$is_freeze" = true ]; then
    if [ "$range_determinable" != true ]; then
      size_determinable=false
      size_fail_reason="$range_reason"
    else
      # Both the new AND previous path matter: a renamed file (status
      # "renamed") carries `previous_filename`, and a file moved OUT of a
      # `full` path (e.g. a migration or a scope module renamed into a UI
      # folder) must still classify off where it came from, not just where
      # it landed — classifying by new path alone could read as `light`.
      # Same list the migration/frontend facts above were read from.
      size_files_json="$range_paths_json"
    fi
  else
    if [ "$files_fetch_failed" = true ]; then
      size_determinable=false
      size_fail_reason="the PR file list could not be fetched"
    elif { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
      size_determinable=false
      size_fail_reason="the PR file list is truncated (>=100 files)"
    else
      # See the freeze branch above: a rename's `previous_filename` must also
      # be checked, or a file moved OUT of a `full` path is missed entirely.
      size_files_json="$(jq -c '[.[] | .filename, (.previous_filename // empty)]' <<<"$files_json" 2>/dev/null || printf '[]')"
    fi
  fi
  local size_out campaign_size campaign_size_reason
  # A pinned freeze range carries its size verdict too (see range_pin_promote).
  size_out="${range_pin_size_out:-$(campaign_size_classify "$size_determinable" "$size_fail_reason" "$size_files_json")}"
  campaign_size="$(jq -r '.campaignSize' <<<"$size_out")"
  campaign_size_reason="$(jq -r '.sizeReason' <<<"$size_out")"

  # The pin CANDIDATE for this evaluation: exactly the range-derived values
  # emitted below, written where only `poll` can pick it up (its per-invocation
  # TMP_DIR). This function runs unlocked and in a subshell, so it never writes
  # a pin itself — `poll` promotes the candidate (range_pin_promote), and only
  # for a settled head. `check` has no TMP_DIR and writes nothing.
  if [ "$is_freeze" = true ] && [ "$range_pin_state" = absent ] && [ "$COMMAND" = poll ] && [ -n "${TMP_DIR:-}" ]; then
    jq -e 'type == "array"' <<<"$range_paths_json" >/dev/null 2>&1 || range_paths_json='[]'
    [ "$range_determinable" = true ] || range_paths_json='[]'
    # Range-sized values (the path list, the migration lists) NEVER travel in
    # argv: Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN), a
    # ~2,000-path range is past that, and a jq that cannot exec would drop the
    # candidate and leave an otherwise-settled freeze skipped forever. They go
    # through --slurpfile from a builtin printf (no exec, no limit). Same rule
    # at every site below that carries them: the facts emit, check's output,
    # the settle-candidate line, the pin promotion and the settled wake.
    jq -cn --arg h "$head_sha" --argjson range "$campaign_range_json" \
      --slurpfile lists <(printf '{"paths":%s,"mf":%s,"mir":%s}' "$range_paths_json" "$migration_files" "$migrations_in_range") \
      --argjson mt "$migrations_touched" --argjson ft "$frontend_touched" \
      --argjson md "$migrations_determinable" \
      --arg size "$campaign_size" --arg sizeReason "$campaign_size_reason" \
      '{schemaVersion:1,headSha:$h,campaignRange:$range,rangePaths:$lists[0].paths,
        migrationsTouched:$mt,frontendTouched:$ft,migrationsDeterminable:$md,
        migrationFiles:$lists[0].mf,migrationsInRange:$lists[0].mir,campaignSize:$size,sizeReason:$sizeReason}' \
      > "$TMP_DIR/range-pin-$pr.json" 2>/dev/null || rm -f "$TMP_DIR/range-pin-$pr.json" 2>/dev/null
  fi

  # `frontendTouched` remains a factual target-diff field. It is not an
  # identity requirement for a detected two-marker freeze: the marker pair
  # itself says the frozen source has both backend and frontend previews. A
  # moving-branch compare with no frontend paths (equal/ancestor targets) can
  # never prove the frontend preview is absent, stale, or still building.
  frontend_required="$frontend_touched"
  if [ "$is_freeze" = true ]; then frontend_required=true; fi

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
    # Runs are found BY COMMIT (`actions/runs?head_sha=`), not by branch.
    # Branch-based listing structurally missed release-lineage freezes: a
    # merge commit that lands ON develop keeps its runs under
    # head_branch=release/<...>, so `gh run list --branch develop` returned
    # zero rows for a fully green SHA and the gate could never settle
    # (pr1330, 2026-08-30 — the coordinator's manual SHA-bound substitution,
    # independently re-proved by the challenger, is exactly this query).
    # Same listing API family as `gh run list`, so the scoped-container-token
    # property that motivated the original `gh run list` choice carries over
    # — and it was executed in-container under that token during pr1330.
    if runs_json="$(timeout 10 gh api "repos/$REPO/actions/runs?head_sha=$ci_sha&per_page=100" \
         --jq '[.workflow_runs[] | {headSha: .head_sha, status, conclusion, workflowName: .name}]' 2>/dev/null)" &&
       jq -e 'type == "array"' <<<"$runs_json" >/dev/null 2>&1; then
      runs_len="$(jq -r 'length' <<<"$runs_json")"
      ci_total="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s)] | length' <<<"$runs_json")"
      if [ "$runs_len" -ge 100 ] && [ "$ci_total" -eq 0 ]; then
        # Cannot happen with head_sha-filtered listing (every row matches),
        # but kept as the fail-closed guard against an API surprise.
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

  # Frontend identity is resolved FIRST and unconditionally — not gated on
  # frontend_required — for two reasons (#1536): its URL is the disambiguation
  # oracle backend resolution needs below, and a backend-only PR whose
  # frontend twin exists is exactly the shape that let #1533 recur unnoticed
  # (the closed-then-reopened disposition's point 6: frontendPreviewUrl was
  # null on backend-only PRs, which hid the recurring gap rather than proving
  # anything).
  frontend_identity="$(resolve_frontend_identity "$services_json" "$pr")"
  frontend_method="$(jq -r '.method' <<<"$frontend_identity")"
  frontend="$(jq -c '.selected' <<<"$frontend_identity")"
  frontend_candidates_json="$(jq -c '.candidates' <<<"$frontend_identity")"
  frontend_id=""; frontend_url=""
  if [ "$frontend" != "null" ]; then
    frontend_id="$(jq -r '.id // empty' <<<"$frontend")"
    frontend_url="$(jq -r '.url // empty' <<<"$frontend")"
  fi

  backend_identity="$(resolve_backend_identity "$services_json" "$pr" "$frontend_url")"
  backend_method="$(jq -r '.method' <<<"$backend_identity")"
  backend="$(jq -c '.selected' <<<"$backend_identity")"
  backend_candidates_json="$(jq -c '.candidates' <<<"$backend_identity")"
  backend_id=""; backend_url=""; backend_deploy_sha=""; backend_ready=false
  if [ "$backend" != "null" ]; then
    backend_id="$(jq -r '.id // empty' <<<"$backend")"
    backend_url="$(jq -r '.url // empty' <<<"$backend")"
    if [ -n "$backend_id" ]; then
      backend_deploy_sha="$(latest_live_deploy_sha "$backend_id")" || { backend_deploy_sha=""; fetch_ok=false; }
      [ "$backend_deploy_sha" = "$head_sha" ] && backend_ready=true
    fi
  fi

  # Ambiguity is REFUSED, never guessed. Backend ambiguity always blocks
  # settling (backend_ready can never be proven), so fetch_ok goes false
  # deliberately — leaving it true would leave backendReady false with no
  # alarm path, and `poll` would `continue` every cycle forever in silence.
  # fetch_ok=false routes it through the existing facts-stuck latch instead,
  # which alarms as pr_facts_unavailable once the stall outlives
  # SMOKE_GATE_FACTS_STUCK_SECONDS.
  #
  # Frontend ambiguity is RECORDED on every PR, required or not (#725): with it
  # gated on frontend_required, a backend-only PR with two frontend twins
  # reported previewAmbiguous:false and a null reason — byte-identical to "the
  # frontend preview is not created yet", which the previewAmbiguous contract
  # below forbids, on exactly the PR shape that let #1533 recur unnoticed. It
  # BLOCKS settling (fetch_ok=false) only when the frontend is required for
  # this PR; otherwise a backend-only PR would be held by a frontend duplicate
  # it never needed resolved.
  preview_ambiguous=false
  preview_ambiguity_text=""
  if [ "$backend_method" = "ambiguous" ]; then
    preview_ambiguous=true
    fetch_ok=false
    preview_ambiguity_text="$(jq -r '.reason' <<<"$backend_identity")"
    printf 'smoke-pr-gate: %s\n' "$preview_ambiguity_text" >&2
  fi
  if [ "$frontend_method" = "ambiguous" ]; then
    preview_ambiguous=true
    FR_REASON="$(jq -r '.reason' <<<"$frontend_identity")"
    if [ -n "$preview_ambiguity_text" ]; then
      preview_ambiguity_text="$preview_ambiguity_text; $FR_REASON"
    else
      preview_ambiguity_text="$FR_REASON"
    fi
    printf 'smoke-pr-gate: %s\n' "$FR_REASON" >&2
  fi

  frontend_ready=true
  frontend_deploy_sha=""
  if [ "$frontend_required" = true ]; then
    frontend_ready=false
    if [ "$frontend_method" = "ambiguous" ]; then
      fetch_ok=false
    elif [ -n "$frontend_id" ]; then
      frontend_deploy_sha="$(latest_live_deploy_sha "$frontend_id")" || { frontend_deploy_sha=""; fetch_ok=false; }
      [ "$frontend_deploy_sha" = "$head_sha" ] && frontend_ready=true
    fi
  fi

  # A null frontendPreviewUrl is an EVIDENCE GAP, not "not applicable" — the
  # browser lane's own identity attestation (smoke-build-identity.sh) needs
  # this URL regardless of whether this PR happened to touch frontend files.
  frontend_evidence_gap=true
  [ -n "$frontend_url" ] && frontend_evidence_gap=false

  healthz_ready=false
  if [ "$backend_ready" = true ] && healthz_ok "$backend_url"; then
    healthz_ready=true
  fi

  # Readiness is separate from range. An ordinary PR's own diff touching
  # migrations still refuses (unchanged). A FREEZE does not: its target is
  # already on the tracked branch, so "the range carries a migration" (or "the
  # range is unknown") describes campaign scope, not whether this preview is
  # safe to test. The failure that introduced the freeze refusal (migration
  # 222 stopping a backend booting, 2026-08-24) is still caught, by the facts
  # that actually observe it: a backend that did not boot is never
  # backendReady/healthzReady. Target identity, CI, deploy identity, frontend
  # readiness and healthz all still gate a freeze below and via fetch_ok.
  settled=false
  if { [ "$is_freeze" = true ] || [ "$migrations_touched" = false ]; } && [ "$backend_ready" = true ] && \
     [ "$frontend_ready" = true ] && [ "$ci_ready" = true ] && [ "$healthz_ready" = true ]; then
    settled=true
  fi

  # Journey selection reads `range_paths_json` — the pinned list whenever this
  # head's range pin is valid, never a second fetch — through $size_files_json,
  # the same value sizing classified.
  local journeys_json=null
  if [ "$is_freeze" = true ]; then
    journeys_json="$(journeys_select "$pr" "$head_sha" "$size_determinable" \
      "$size_fail_reason" "$size_files_json" "$campaign_size")"
    jq -e 'type == "object" or . == null' <<<"$journeys_json" >/dev/null 2>&1 ||
      journeys_json="$(journeys_full "journey selection could not be read" absent)"
  fi

  # The two migration lists are range-sized, so they reach jq through
  # --slurpfile, never argv (see the MAX_ARG_STRLEN note at the pin candidate
  # above). $migrationsInRange is still named on the argv below, so it is
  # shadowed with `null` there and rebound from the file as the program's
  # first step.
  local range_lists_json
  # The journey selection lists range paths too, so it rides the same file.
  range_lists_json="$(printf '{"migrationFiles":%s,"migrationsInRange":%s,"journeys":%s}' "$migration_files" "$migrations_in_range" "$journeys_json")"
  migrations_in_range=null
  jq -cn \
    --argjson pr "$pr" --arg headSha "$head_sha" \
    --argjson fetchOk "$fetch_ok" \
    --argjson migrationsTouched "$migrations_touched" \
    --argjson frontendTouched "$frontend_touched" \
    --argjson frontendRequired "$frontend_required" \
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
    --slurpfile rangeLists <(printf '%s' "$range_lists_json") --argjson migrationsDeterminable "$migrations_determinable" \
    --arg campaignSize "$campaign_size" --arg sizeReason "$campaign_size_reason" \
    --arg backendSelectionMethod "$backend_method" --argjson backendCandidates "$backend_candidates_json" \
    --arg frontendSelectionMethod "$frontend_method" --argjson frontendCandidates "$frontend_candidates_json" \
    --argjson previewAmbiguous "$preview_ambiguous" --arg previewAmbiguityReason "$preview_ambiguity_text" \
    --argjson frontendEvidenceGap "$frontend_evidence_gap" \
    --argjson campaignRange "$campaign_range_json" --argjson migrationsInRange "$migrations_in_range" \
    '($rangeLists[0].migrationFiles) as $migrationFiles |
     ($rangeLists[0].migrationsInRange) as $migrationsInRange |
     ($rangeLists[0].journeys) as $journeys |
     ({
      pr: $pr, headSha: $headSha, fetchOk: $fetchOk,
      migrationsTouched: $migrationsTouched, frontendTouched: $frontendTouched,
      frontendRequired: $frontendRequired,
      # Mechanical, install-rules-driven sizing — never agent judgment. See
      # campaign_size_classify(): campaignSize is one of full/standard/light,
      # sizeReason names the first file (and glob) that forced the verdict,
      # or "no sizing rules" when the install never supplied a rules file.
      campaignSize: $campaignSize, sizeReason: $sizeReason,
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
      healthzReady: $healthzReady, settled: $settled,
      # #1536: every backend/frontend match Render returned for this PR
      # suffix, how the selection was made (single / bundle-disambiguated /
      # ambiguous / none), and the resulting refusal state. previewAmbiguous
      # is the RECORDED refusal — a duplicate same-named preview was found and
      # nothing was guessed from it. It is never inferred from a null id
      # (that is also what "not created yet" looks like); it is stated here
      # explicitly instead.
      backendSelectionMethod: $backendSelectionMethod, backendCandidates: $backendCandidates,
      frontendSelectionMethod: $frontendSelectionMethod, frontendCandidates: $frontendCandidates,
      previewAmbiguous: $previewAmbiguous,
      previewAmbiguityReason: (if $previewAmbiguityReason == "" then null else $previewAmbiguityReason end),
      # A null frontendPreviewUrl is an evidence gap, not a shrug: the browser
      # lane cannot attest a build identity without it, whether or not this
      # PR touched frontend files.
      frontendEvidenceGap: $frontendEvidenceGap
    } + (if $isFreezePr then {
      # Freeze PRs only (the range of an ordinary PR is its own diff, and its
      # facts stay byte-identical). campaignRange is THE range of a freeze campaign:
      # sizing, the migration fields above, route/consumer selection and any
      # range a human is shown quote it, never a range re-derived elsewhere.
      # migrationsInRange is null — never [] — whenever determinable is false.
      campaignRange: $campaignRange, migrationsInRange: $migrationsInRange
    } else {} end)
    # Present only when the install has a journey catalogue (journeys_select).
    + (if $journeys != null then {journeys: $journeys} else {} end))'
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
if [ "$COMMAND" = "wait-settled" ]; then
  # A PR can merge, close, lose its label, or receive a new head while a
  # caller waits. Unlike the develop branch waiter, those are terminal facts,
  # not an unsettled build: retrying them until a deadline would turn a
  # completed or superseded preview into a false timeout.
  PR="${2:-}"
  shift 2 2>/dev/null || true
  EXPECTED_HEAD=""
  WAIT_INTERVAL_SECONDS=300
  WAIT_MAX_SECONDS=2700
  WAIT_OPTION_ERROR=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head)
        if [ "$#" -lt 2 ]; then WAIT_OPTION_ERROR="wait-settled --head requires a 40-character SHA"; break; fi
        EXPECTED_HEAD="$2"; shift 2 ;;
      --interval-seconds)
        if [ "$#" -lt 2 ]; then WAIT_OPTION_ERROR="wait-settled --interval-seconds requires a non-negative integer"; break; fi
        WAIT_INTERVAL_SECONDS="$2"; shift 2 ;;
      --max-seconds)
        if [ "$#" -lt 2 ]; then WAIT_OPTION_ERROR="wait-settled --max-seconds requires a non-negative integer"; break; fi
        WAIT_MAX_SECONDS="$2"; shift 2 ;;
      *) WAIT_OPTION_ERROR="unknown wait-settled option: $1"; break ;;
    esac
  done
  # `grep -E` checks each newline-delimited record, not the whole shell
  # argument. These predicates deliberately combine a full-string glob check
  # with length/first-byte rules so a multi-line option cannot turn a bounded
  # waiter into an arithmetic-error spin.
  is_wait_pr() {
    local value="$1"
    [ -n "$value" ] && [[ "$value" == [1-9]* ]] && [[ "$value" != *[!0-9]* ]]
  }
  is_wait_sha() {
    local value="$1"
    [ "${#value}" -eq 40 ] && [[ "$value" != *[!0-9a-f]* ]]
  }
  is_wait_nonnegative_integer() {
    local value="$1"
    [ "${#value}" -le 18 ] && { [ "$value" = 0 ] || { [[ "$value" == [1-9]* ]] && [[ "$value" != *[!0-9]* ]]; }; }
  }
  if ! is_wait_pr "$PR"; then
    jq -cn '{ok:false,error:"wait-settled requires a PR number"}'
    exit 2
  fi
  if [ -n "$WAIT_OPTION_ERROR" ] || ! is_wait_sha "$EXPECTED_HEAD" ||
     ! is_wait_nonnegative_integer "$WAIT_INTERVAL_SECONDS" ||
     ! is_wait_nonnegative_integer "$WAIT_MAX_SECONDS"; then
    [ -n "$WAIT_OPTION_ERROR" ] || WAIT_OPTION_ERROR="wait-settled requires --head <40-character SHA> and non-negative integer limits"
    jq -cn --arg error "$WAIT_OPTION_ERROR" '{ok:false,error:$error}'
    exit 2
  fi

  WAIT_STARTED="$(date -u +%s)"
  WAIT_ATTEMPTS=0
  while :; do
    # Do not begin another network read after a prior sleep consumed the
    # deadline. The initial attempt always happens, even for max=0, so callers
    # receive the check's actual pending/fetch diagnostic in their BLOCKED row.
    if [ "$WAIT_ATTEMPTS" -gt 0 ]; then
      WAIT_NOW="$(date -u +%s)"
      WAIT_ELAPSED=$(( WAIT_NOW - WAIT_STARTED ))
      if [ "$WAIT_ELAPSED" -ge "$WAIT_MAX_SECONDS" ]; then
        jq -c --arg expected "$EXPECTED_HEAD" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
          '. + {requestedHeadSha:$expected,waitedSeconds:$waited,attempts:$attempts,timedOut:true,incomplete:true}' \
          <<<"$WAIT_OUT"
        exit 1
      fi
    fi
    WAIT_ATTEMPTS=$(( WAIT_ATTEMPTS + 1 ))
    WAIT_OUT="$(bash "$0" check "$PR")"
    WAIT_CHECK_RC=$?
    if ! jq -e 'type == "object"' <<<"$WAIT_OUT" >/dev/null 2>&1; then
      WAIT_OUT="$(jq -cn --argjson pr "$PR" '{ok:false,pr:$pr,error:"check returned invalid JSON"}')"
      WAIT_CHECK_RC=1
    fi
    WAIT_NOW="$(date -u +%s)"
    WAIT_ELAPSED=$(( WAIT_NOW - WAIT_STARTED ))
    WAIT_OK="$(jq -r '.ok == true' <<<"$WAIT_OUT")"
    WAIT_ELIGIBLE="$(jq -r '.eligible == true' <<<"$WAIT_OUT")"
    WAIT_HEAD="$(jq -r '.headSha // empty' <<<"$WAIT_OUT")"

    # `check` returns 2 only for a locally permanent configuration/usage
    # problem. Waiting cannot repair it, and treating it as a product verdict
    # would obscure the operational error.
    if [ "$WAIT_CHECK_RC" -eq 2 ]; then
      jq -c --arg expected "$EXPECTED_HEAD" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
        '. + {terminal:"check_error",requestedHeadSha:$expected,waitedSeconds:$waited,attempts:$attempts,timedOut:false,incomplete:true}' \
        <<<"$WAIT_OUT"
      exit 2
    fi
    if [ "$WAIT_OK" = true ] && [ "$WAIT_ELIGIBLE" != true ]; then
      jq -c --arg expected "$EXPECTED_HEAD" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
        '. + {terminal:"ineligible",requestedHeadSha:$expected,waitedSeconds:$waited,attempts:$attempts,timedOut:false,incomplete:true}' \
        <<<"$WAIT_OUT"
      exit 3
    fi
    if [ "$WAIT_OK" = true ] && [ -n "$WAIT_HEAD" ] && [ "$WAIT_HEAD" != "$EXPECTED_HEAD" ]; then
      jq -c --arg expected "$EXPECTED_HEAD" --arg observed "$WAIT_HEAD" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
        '. + {terminal:"head_moved",requestedHeadSha:$expected,observedHeadSha:$observed,waitedSeconds:$waited,attempts:$attempts,timedOut:false,incomplete:true}' \
        <<<"$WAIT_OUT"
      exit 3
    fi
    if [ "$(jq -r '.settled == true' <<<"$WAIT_OUT")" = true ]; then
      jq -c --arg expected "$EXPECTED_HEAD" --argjson pr "$PR" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
        '. + {requestedHeadSha:$expected,checkIdentity:{pr:$pr,requestedHeadSha:$expected,headSha:(.headSha // null),ciSha:(.ciSha // null)},waitedSeconds:$waited,attempts:$attempts,timedOut:false,incomplete:false}' \
        <<<"$WAIT_OUT"
      exit 0
    fi
    if [ "$WAIT_ELAPSED" -ge "$WAIT_MAX_SECONDS" ]; then
      jq -c --arg expected "$EXPECTED_HEAD" --argjson attempts "$WAIT_ATTEMPTS" --argjson waited "$WAIT_ELAPSED" \
        '. + {requestedHeadSha:$expected,waitedSeconds:$waited,attempts:$attempts,timedOut:true,incomplete:true}' \
        <<<"$WAIT_OUT"
      exit 1
    fi
    WAIT_REMAINING=$(( WAIT_MAX_SECONDS - WAIT_ELAPSED ))
    WAIT_SLEEP_SECONDS="$WAIT_INTERVAL_SECONDS"
    if [ "$WAIT_SLEEP_SECONDS" -gt "$WAIT_REMAINING" ]; then
      WAIT_SLEEP_SECONDS="$WAIT_REMAINING"
    fi
    sleep "$WAIT_SLEEP_SECONDS"
  done
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "check" ]; then
  PR="${2:-}"
  if ! printf '%s' "$PR" | grep -Eq '^[1-9][0-9]*$'; then
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
  jq -c '{ok:true} + {eligible:true} + .' <<<"$FACTS"
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "claim" ]; then
  RUN_ID="${2:-}"
  PR="${3:-}"
  SHA="${4:-}"
  # Optional 5th positional: the coordinator's lease owner token. Defaults to
  # the container id, which is what actually needs distinguishing — pass one
  # explicitly only when several coordinators share a container.
  OWNER="${5:-$DEFAULT_OWNER}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"claim requires a run id"}'
    exit 2
  fi
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"run id must be 1-200 chars of [A-Za-z0-9._-] — it names files under the state dir",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$PR" | grep -Eq '^[1-9][0-9]*$'; then
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
  # Lock order matches automatic poll: private PR state, then shared task
  # identity, then PR lifecycle/run ownership. Hold the task lock until this
  # PR's shared lease, authority and private slot all commit, so task-claim
  # cannot pass between this read and the PR identity write.
  if ! task_binding_guard_absent_begin "$RUN_ID" claim "$PR"; then
    exit 0
  fi
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
  # A reclaim that CONTINUES an unfinished campaign must do it under the run
  # id that campaign already published. Minting a fresh one here leaves every
  # artifact, marker and posted message on the old identity while `finish` and
  # `challenger-timeout` — both of which guard on `.activeRunId` — will only
  # answer to the new one, so the campaign has no terminal path at all. That is
  # exactly how pr1432 looped ~4h under ids nothing it had published named
  # (2026-09-02). Refuse:
  # reclaim under the published id, or say --takeover and mean it. Note this
  # can only bite once the incumbent is no longer live — a live run is already
  # refused by the slot check above.
  if [ "$TAKEOVER" != true ] &&
     [ "$(jq -r --arg sha "$SHA" \
          'if (.activeSha == $sha and .challengerDisposition == null and (.activeRunId // "") != "")
           then "true" else "false" end' <<<"$STATE")" = true ] &&
     [ "$(jq -r '.activeRunId // empty' <<<"$STATE")" != "$RUN_ID" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg active "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
      --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
      '{ok:false,
        error:"run id drift — this PR has an unfinished campaign on the same SHA; reclaim under its existing run id to continue it, or pass --takeover to deliberately start a new identity",
        pr:$pr,runId:$run,activeRunId:$active,
        activeSha:(if $sha == "" then null else $sha end)}'
    exit 0
  fi
  # The slot check above proves no OTHER RUN owns this PR. It cannot prove no
  # other CONTAINER is running THIS run — the per-PR flock is process-local to
  # one filesystem view and both coordinators pass it. Take the durable lease
  # before writing the slot, and refuse the claim outright if it is held: an
  # unleased claim is exactly the duplicate coordinator this closes.
  if ! lease_lifecycle_begin "$PR" "$RUN_ID" "$COMMAND"; then
    exit 0
  fi
  PRIOR_AUTHORITY="$(read_pr_authority "$PR")"
  AUTHORITY_STATUS="$(pr_authority_status "$PRIOR_AUTHORITY")"
  if [ "$AUTHORITY_STATUS" = malformed ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$(pr_authority_file "$PR")" \
      '{ok:false,error:("shared PR authority is malformed at " + $path + " - refusing claim"),pr:$pr,runId:$run}'
    lease_lifecycle_end
    exit 0
  fi
  if [ "$AUTHORITY_STATUS" = live ] &&
     { [ "$(jq -r '.runId' <<<"$PRIOR_AUTHORITY")" != "$RUN_ID" ] ||
       [ "$(jq -r '.owner' <<<"$PRIOR_AUTHORITY")" != "$OWNER" ]; } &&
     [ "$TAKEOVER" != true ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --argjson authority "$PRIOR_AUTHORITY" \
      '{ok:false,error:"another live run owns this PR in the shared coordinator registry - refuse duplicate campaign unless an operator explicitly authorizes --takeover",pr:$pr,runId:$run,requestedBy:$owner,activeRunId:$authority.runId,leaseOwner:$authority.owner}'
    lease_lifecycle_end
    exit 0
  fi
  PRIOR_LEASE="$(read_lease "$RUN_ID")"
  if ! LEASE_RESULT="$(lease_acquire "$RUN_ID" "$OWNER" "$PR")"; then
    printf '%s\n' "$LEASE_RESULT"
    lease_lifecycle_end
    exit 0
  fi
  if ! bind_pr_authority "$PR" "$RUN_ID" "$OWNER"; then
    if [ "$(lease_is_live "$PRIOR_LEASE")" = true ]; then write_lease "$RUN_ID" "$PRIOR_LEASE" || true
    else rm -f "$(lease_file "$RUN_ID")" 2>/dev/null || true; fi
    lease_lifecycle_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:false,error:"could not write shared PR authority - claim refused",pr:$pr,runId:$run}'
    exit 1
  fi
  # Keep the shared PR lifecycle fence across acquisition and the private slot
  # write, then also take the run lock to verify the owner we just installed.
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  # Record WHO was displaced, so the displaced run's next gate call gets a stop
  # instruction naming the takeover instead of the generic reclaim message.
  # Cleared on an ordinary claim so a stale name can never mis-accuse a later run.
  #
  # challengerDeadline is stamped here because `claim` is the only point that
  # knows when the campaign began. A run whose challenger never files by then
  # is finishable ONLY through `challenger-timeout`, and only as BLOCKED.
  # A reclaim that CONTINUES the same campaign (same SHA, no disposition yet)
  # keeps its original deadline. Stamping a fresh one on every recovery
  # reclaim reset the clock hourly and made `challenger-timeout` unreachable
  # — pr1432 looped ~4h "stuck waiting on challenger" (2026-09-02).
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" --arg owner "$OWNER" --arg took "$TOOK_OVER" \
    --arg deadline "$(challenger_deadline_from_now)" \
    '(if (.activeSha == $sha and (.challengerDeadline // "") != "" and .challengerDisposition == null)
      then .challengerDeadline else $deadline end) as $dl |
     .activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=$now |
     .activeLeaseOwner=$owner |
     .displacedRunId=(if $took == "" then null else $took end) |
     .displacedAt=(if $took == "" then null else $now end) |
     .challengerDeadline=$dl |
     .challengerDisposition=null | .challengerTimedOutAt=null |
     .finishIntent=null' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    CLEANUP=""
    if [ "$(lease_is_live "$PRIOR_LEASE")" = true ]; then
      write_lease "$RUN_ID" "$PRIOR_LEASE" || CLEANUP="; the preexisting shared lease also could not be restored"
    else
      lease_remove_fenced "$RUN_ID" || CLEANUP="; the just-acquired shared lease also could not be removed"
    fi
    if [ "$PRIOR_AUTHORITY" = null ]; then
      rm -f "$(pr_authority_file "$PR")" 2>/dev/null || CLEANUP="$CLEANUP; the new shared PR authority could not be removed"
    else
      write_pr_authority "$PR" "$PRIOR_AUTHORITY" || CLEANUP="$CLEANUP; the prior shared PR authority could not be restored"
    fi
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg cleanup "$CLEANUP" \
      '{ok:false,error:("could not write the private PR slot - claim refused" + $cleanup),pr:$pr,runId:$run,owner:$owner}'
    exit 1
  fi
  lease_fence_end
  task_binding_lock_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg sha "$SHA" --arg took "$TOOK_OVER" \
    --argjson lease "$(jq -c '.lease' <<<"$LEASE_RESULT")" \
    --arg deadline "$(jq -r '.challengerDeadline' <<<"$STATE")" \
    '{ok:true,runId:$run,pr:$pr,sha:$sha,
      tookOverFrom:(if $took == "" then null else $took end),
      lease:$lease,challengerDeadline:$deadline}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Lease verbs. Standalone so a coordinator can hold a lease across steps the
# gate knows nothing about; `claim` takes one implicitly and `finish`/`release`
# drop it, so a campaign that only uses the existing verbs is fully covered
# without ever naming these.
if [ "$COMMAND" = "lease-claim" ] || [ "$COMMAND" = "lease-renew" ] ||
   [ "$COMMAND" = "lease-release" ] || [ "$COMMAND" = "lease-status" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg cmd "$COMMAND" --arg run "$RUN_ID" \
      '{ok:false,error:($cmd + " requires a run id of 1-200 chars of [A-Za-z0-9._-]"),runId:$run}'
    exit 2
  fi

  if ! lease_dir_prepare; then
    emit_lease_dir_error "$RUN_ID" "$COMMAND"
    exit 1
  fi

  if [ "$COMMAND" = "lease-status" ]; then
    LEASE="$(read_lease "$RUN_ID")"
    if [ "$(lease_is_malformed "$LEASE")" = true ]; then
      jq -cn --arg run "$RUN_ID" --arg path "$(lease_file "$RUN_ID")" \
        '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to report it available"),runId:$run,leaseFile:$path}'
      exit 1
    fi
    jq -cn --arg run "$RUN_ID" --argjson lease "$LEASE" --argjson live "$(lease_is_live "$LEASE")" \
      '{ok:true,runId:$run,held:$live,lease:$lease}'
    exit 0
  fi

  if [ "$COMMAND" = "lease-claim" ]; then
    LEASE_PR="${4:-}"
    if ! printf '%s' "$LEASE_PR" | grep -Eq '^[1-9][0-9]*$'; then
      EXISTING_LEASE="$(read_lease "$RUN_ID")"
      if [ "$(lease_is_malformed "$EXISTING_LEASE")" != true ] && [ "$EXISTING_LEASE" != null ] &&
         [ "$(jq -r '.owner // empty' <<<"$EXISTING_LEASE")" = "$OWNER" ]; then
        LEASE_PR="$(jq -r '.pr' <<<"$EXISTING_LEASE")"
      else
        jq -cn --arg run "$RUN_ID" \
          '{ok:false,error:"lease-claim requires the PR number for a new shared run id; use lease-claim <run-id> <owner-token> <pr>",runId:$run}'
        exit 2
      fi
    fi
    if ! task_binding_guard_absent_begin "$RUN_ID" lease-claim "$LEASE_PR"; then
      exit 0
    fi
    lease_acquire "$RUN_ID" "$OWNER" "$LEASE_PR"
    task_binding_lock_end
    exit 0
  fi

  # renew / release both require the caller to BE the owner. A non-owner
  # renewing would extend someone else's hold; a non-owner releasing would
  # hand the run to whoever asked next, which is the fault this file exists
  # to stop.
  if ! exec 6>"$(lease_lock_file "$RUN_ID")"; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared lease lock under " + $dir + " - refusing to continue unleased"),runId:$run,command:$cmd,leaseDir:$dir}'
    exit 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" \
      '{ok:false,retryable:true,
        error:"gate_lock_busy: another invocation held this run'"'"'s lease lock — RETRY this same command in ~10s.",
        runId:$run,command:$cmd}'
    exit 0
  fi
  LEASE="$(read_lease "$RUN_ID")"
  if [ "$(lease_is_malformed "$LEASE")" = true ]; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" --arg path "$(lease_file "$RUN_ID")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to renew or release"),runId:$run,command:$cmd,leaseFile:$path}'
    flock -u 6
    exit 1
  fi
  if [ "$LEASE" = null ]; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" \
      '{ok:false,error:("no lease exists for this run — " +
        (if $cmd == "lease-renew" then "claim it with lease-claim before renewing" else "nothing to release" end)),
        runId:$run}'
    flock -u 6
    exit 0
  fi
  LEASE_OWNER="$(jq -r '.owner // empty' <<<"$LEASE")"
  if [ "$LEASE_OWNER" != "$OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --argjson lease "$LEASE" \
      --argjson live "$(lease_is_live "$LEASE")" \
      '{ok:false,error:"this run'"'"'s lease belongs to another owner — only its owner may renew or release it",
        runId:$run,requestedBy:$owner,leaseOwner:$lease.owner,held:$live,expiresAt:$lease.expiresAt}'
    flock -u 6
    exit 0
  fi
  if [ "$(lease_is_live "$LEASE")" != true ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg cmd "$COMMAND" --arg exp "$(jq -r '.expiresAt' <<<"$LEASE")" \
      '{ok:false,error:("the coordinator lease expired at " + $exp + " - " + $cmd + " cannot revive or remove expired authority; recover with claim using the same run id and owner token"),runId:$run,requestedBy:$owner,expiresAt:$exp}'
    flock -u 6
    exit 0
  fi
  if [ "$COMMAND" = "lease-release" ]; then
    if ! lease_remove_fenced "$RUN_ID"; then
      jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg dir "$LEASE_DIR" \
        '{ok:false,error:("could not remove shared lease under " + $dir + " - refusing to report it released"),runId:$run,owner:$owner,leaseDir:$dir}'
      flock -u 6
      exit 1
    fi
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" '{ok:true,runId:$run,released:true,owner:$owner}'
    flock -u 6
    exit 0
  fi
  # lease-renew only extends a live lease. Recovery after expiry goes through
  # the same-run claim path so it is serialized against successor claims.
  NEXT="$(jq -c --arg now "$(iso_now)" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$LEASE")"
  if ! write_lease "$RUN_ID" "$NEXT"; then
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not write the lease file under " + $dir + " - the lease will EXPIRE; fix the shared lease dir and retry"),runId:$run,leaseDir:$dir}'
    flock -u 6
    exit 1
  fi
  jq -cn --arg run "$RUN_ID" --argjson lease "$(read_lease "$RUN_ID")" \
    '{ok:true,runId:$run,renewed:true,lease:$lease}'
  flock -u 6
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "progress" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
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
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - STOP this campaign",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  RENEWED_LEASE="$(jq -c --arg now "$NOW" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$FENCED_LEASE_JSON")"
  if ! write_lease "$RUN_ID" "$RENEWED_LEASE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not renew the live shared lease under " + $dir + " - progress not recorded; retry before the lease expires"),pr:$pr,runId:$run}'
    exit 1
  fi
  STATE="$(jq -c --arg now "$NOW" '.activeProgressAt=$now' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write progress state - progress not recorded",pr:$pr,runId:$run}'
    exit 1
  fi
  lease_fence_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson lease "$RENEWED_LEASE" \
    '{ok:true,runId:$run,pr:$pr,leaseRenewed:true,lease:$lease}'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "release" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
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
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - nothing released",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  STATE="$(jq -c '.activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null | .challengerDeadline=null | .finishIntent=null' <<<"$STATE")"
  # Remove the PR binding and run lease together under the shared locks. Any
  # later failure restores both identities before releasing the fence.
  if ! remove_pr_authority_fenced "$PR" "$RUN_ID" "$OWNER"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not remove matching shared PR authority - nothing released",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! lease_remove_fenced "$RUN_ID"; then
    write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON" || true
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared lease under " + $dir + " - nothing released"),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! write_pr_state "$PR" "$STATE"; then
    RESTORED=false
    if lease_restore_fenced "$RUN_ID" "$FENCED_LEASE_JSON" &&
       write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON"; then RESTORED=true; fi
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not write released PR state - release refused and lease restoration attempted",pr:$pr,runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  lease_fence_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:true,releasedRunId:$run,pr:$pr,leaseReleased:true}'
  exit 0
fi

# ---------------------------------------------------------------------------
# Task-scoped verbs: claim/progress/release for a certification, re-
# verification or evidence-recovery run that has no PR. See the "Task-scoped
# certification lease" section above for why this is a separate, simpler
# lifecycle rather than a PR claim in disguise.
if [ "$COMMAND" = "task-claim" ]; then
  RUN_ID="${2:-}"
  SHA="${3:-}"
  OWNER="${4:-$DEFAULT_OWNER}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"task-claim requires a run id"}'
    exit 2
  fi
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"run id must be 1-200 chars of [A-Za-z0-9._-] — it names files under the state dir",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"task-claim requires the 40-character frozen deploy SHA"}'
    exit 2
  fi
  # Run ids are unique across the WHOLE gate (see the comment in `claim`): a
  # run id already owned by a PR or the develop campaign cannot also become a
  # task run, or the two lifecycles would race the same identity through two
  # independent lock domains.
  # The scan, the lease acquisition and the slot write all run under
  # CONTROL_LOCK, the lock `claim` holds for its own uniqueness scan (#726 F2).
  # Unlocked, this and a PR `claim` could each scan before the other wrote, and
  # both win. Fail closed like `claim`, never the best-effort `|| true` form.
  if ! exec 8>"$CONTROL_LOCK"; then
    jq -cn --arg run "$RUN_ID" --arg lock "$CONTROL_LOCK" \
      '{ok:false,error:("could not open the gate control lock at " + $lock + " - task-claim refused"),runId:$run}'
    exit 1
  fi
  if ! flock -w "$LOCK_WAIT" 8; then
    emit_lock_busy "$COMMAND"
    exit 0
  fi
  OTHER_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
  if [ -n "$OTHER_PR" ]; then
    jq -cn --arg run "$RUN_ID" --argjson otherPr "$OTHER_PR" \
      '{ok:false,error:"run id already claimed by a PR campaign — run ids must be unique across the gate",runId:$run,activePr:$otherPr}'
    exit 0
  fi
  # The develop gate's own terminal state carries completedRunId after its
  # active slot clears. It shares runs/<id>/verdict.json with task runs, so a
  # completed develop identity is just as unavailable as an active one.
  DEVELOP_STATE_FILE="$STATE_DIR/develop-state.json"
  if [ -s "$DEVELOP_STATE_FILE" ]; then
    if ! DEVELOP_BINDING="$(jq -er --arg run "$RUN_ID" '
      if type != "object" then error("not a develop state object")
      elif (.activeRunId // "") == $run then "active"
      elif (.completedRunId // "") == $run then "completed"
      else "none"
      end
    ' "$DEVELOP_STATE_FILE" 2>/dev/null)"; then
      jq -cn --arg run "$RUN_ID" --arg path "$DEVELOP_STATE_FILE" \
        '{ok:false,error:("develop state cannot be read at " + $path + " - task-claim refused to preserve run-id uniqueness"),runId:$run,developStateFile:$path}'
      exit 0
    fi
    if [ "$DEVELOP_BINDING" != none ]; then
      jq -cn --arg run "$RUN_ID" --arg binding "$DEVELOP_BINDING" --arg path "$DEVELOP_STATE_FILE" \
        '{ok:false,error:(if $binding == "completed"
                          then "run id already finished by the develop campaign — terminal run ids must be unique across the gate"
                          else "run id already claimed by the develop campaign — run ids must be unique across the gate"
                          end),runId:$run,developBinding:$binding,developStateFile:$path}'
      exit 0
    fi
  fi
  # Returns holding the shared task identity/lease lock (fd 7) — see
  # task_lease_acquire.
  # Called directly, never inside $(…), or the lock would die with the
  # subshell before the slot write below. It prints its own refusal.
  if ! task_lease_acquire "$RUN_ID" "$OWNER" "$SHA"; then
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --arg now "$NOW" --arg owner "$OWNER" \
    '{schemaVersion:1,activeRunId:$run,activeSha:$sha,activeStartedAt:$now,activeProgressAt:$now,
      activeLeaseOwner:$owner,completedAt:null,completedRunId:null,completedVerdict:null}')"
  if ! (mkdir -p "$STATE_DIR" 2>/dev/null; tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)" &&
        printf '%s\n' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$(task_state_file "$RUN_ID")" 2>/dev/null); then
    # Put back exactly the lease that was there (#726 F1), the way `claim` and
    # `task-release` restore theirs: a live same-owner lease a running
    # coordinator still relies on, the owner a failed --takeover tried to
    # displace, or an expired lease that still carries this run's deploySha
    # binding. Only a lease/binding this claim created from nothing is removed.
    # fd 7 is still held, so no other claimant can have changed either record.
    CLEANUP=""
    if [ "$TASK_PRIOR_LEASE_JSON" = null ]; then
      task_lease_remove_fenced "$RUN_ID" || CLEANUP="; the just-acquired shared task lease also could not be removed"
    else
      write_task_lease "$RUN_ID" "$TASK_PRIOR_LEASE_JSON" || CLEANUP="; the preexisting shared task lease also could not be restored"
    fi
    if [ "$TASK_PRIOR_BINDING_JSON" = null ]; then
      rm -f "$(task_binding_file "$RUN_ID")" 2>/dev/null &&
        [ ! -e "$(task_binding_file "$RUN_ID")" ] ||
        CLEANUP="$CLEANUP; the just-created shared task binding also could not be removed"
    fi
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg cleanup "$CLEANUP" \
      '{ok:false,error:("could not write the private task slot - claim refused" + $cleanup),runId:$run,owner:$owner}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --argjson lease "$TASK_ACQUIRED_LEASE_JSON" \
    '{ok:true,runId:$run,sha:$sha,lease:$lease}'
  exit 0
fi

if [ "$COMMAND" = "task-progress" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -z "$RUN_ID" ] || [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run (reclaimed or finished) — stop this run"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - STOP this run",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! task_lease_fence_begin "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  RENEWED_LEASE="$(jq -c --arg now "$NOW" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$FENCED_TASK_LEASE_JSON")"
  if ! write_task_lease "$RUN_ID" "$RENEWED_LEASE"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not renew the live shared task lease under " + $dir + " - progress not recorded; retry before the lease expires"),runId:$run}'
    exit 1
  fi
  STATE="$(jq -c --arg now "$NOW" '.activeProgressAt=$now' <<<"$STATE")"
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" '{ok:false,error:"could not write progress state - progress not recorded",runId:$run}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --argjson lease "$RENEWED_LEASE" '{ok:true,runId:$run,leaseRenewed:true,lease:$lease}'
  exit 0
fi

if [ "$COMMAND" = "task-release" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -z "$RUN_ID" ] || [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run — nothing released"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - nothing released",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! task_lease_fence_begin "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  # Keep activeSha as this run's durable deploy binding after the active slot
  # and lease are released. task-claim reads it under this same task lease
  # fence: another SHA must use another run id, while this SHA may recover.
  STATE="$(jq -c '.activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null' <<<"$STATE")"
  if ! task_lease_remove_fenced "$RUN_ID"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared task lease under " + $dir + " - nothing released"),runId:$run,leaseReleased:false}'
    exit 1
  fi
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    RESTORED=false
    write_task_lease "$RUN_ID" "$FENCED_TASK_LEASE_JSON" && RESTORED=true
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not write released task state - release refused and lease restoration attempted",runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" '{ok:true,releasedRunId:$run,leaseReleased:true}'
  exit 0
fi

# task-finish: the terminal step for a task-scoped run, so a hand-composed
# contract can never reach a PUBLISHED verdict through the scaffold + barrier
# alone — publication is only real once this writes the write-once
# run-level verdict.json AND commits the task's terminal state, both under
# the same lease that `task-claim` handed out. Mirrors `finish`'s terminal
# binding: the run-level verdict is consulted BEFORE the slot guard (a
# completed run is nobody's activeRunId, so asking the slot first would
# misreport a repeat call as "not active" instead of "already finished"),
# and a second, DIFFERENT verdict for the same run is refused rather than
# overwritten — verdict.json stays canonical, a human reconciles. Unlike
# `finish`, there is no PR, no develop handoff, no preview to suspend, and no
# ledger — so no finishIntent bridge either: with nothing else to make
# idempotent between the verdict write and the state clear, that crash
# window is one file write wide and closes itself on retry the same way the
# state clear below already does.
if [ "$COMMAND" = "task-finish" ]; then
  RUN_ID="${2:-}"
  SHA="${3:-}"
  VERDICT="${4:-}"
  OWNER="${5:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"task-finish requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"task-finish requires the 40-character deploy SHA this run claimed"}'
    exit 2
  fi
  case "$VERDICT" in
    GO|NO_GO|HUMAN_DECISION|BLOCKED) ;;
    *) jq -cn '{ok:false,error:"task-finish verdict must be GO, NO_GO, HUMAN_DECISION, or BLOCKED"}'; exit 2 ;;
  esac

  RUN_VERDICT_FILE="$(run_verdict_file "$RUN_ID")"
  RUN_VERDICT_RESUMED=false
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -s "$RUN_VERDICT_FILE" ]; then
    EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
    if [ -n "$EXISTING_VERDICT" ] &&
       jq -e --arg sha "$SHA" --arg run "$RUN_ID" --arg v "$VERDICT" \
         '.sha == $sha and .runId == $run and .verdict == $v' \
         <<<"$EXISTING_VERDICT" >/dev/null 2>&1; then
      NOW="$(jq -r '.finishedAt' <<<"$EXISTING_VERDICT")"
      VERDICT_DIGEST="$(verdict_digest "$EXISTING_VERDICT")"
      RUN_VERDICT_RESUMED=true
      if [ -s "$TASK_STATE_FILE" ] &&
         [ "$(jq -r '.completedRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" = "$RUN_ID" ]; then
        if ! task_finish_fence_begin "$RUN_ID" "$OWNER" "$SHA" "$VERDICT" "$NOW" "$VERDICT_DIGEST" true; then
          exit 0
        fi
        task_lease_fence_end
        jq -cn --argjson verdict "$EXISTING_VERDICT" --arg digest "$VERDICT_DIGEST" \
          '{ok:true,idempotent:true,
            note:"this run was already finished with these exact terminal facts — nothing re-recorded, no artifact rewritten",
            verdictDigest:$digest} + $verdict'
        exit 0
      fi
      # Verdict recorded but the slot/lease were never cleared — a crash
      # between the two writes. Fall through and resume just that half; the
      # verdict itself is NOT rewritten (RUN_VERDICT_RESUMED guards that below).
    else
      jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" --arg attempted "$VERDICT" \
        --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
        '{ok:false,gateStatus:"reconciliation_required",
          error:("a DIFFERENT verdict is already recorded for this run — STOP. Nothing was overwritten and no verdict was fabricated. " +
                 $path + " stays canonical; a human must reconcile which run owns this outcome before any verdict is published."),
          runId:$run,runVerdictFile:$path,recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted}}'
      exit 1
    fi
  fi

  if [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run (reclaimed or already finished) — no verdict recorded"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  CLAIMED_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$SHA" != "$CLAIMED_SHA" ]; then
    jq -cn --arg run "$RUN_ID" --arg supplied "$SHA" --arg claimed "$CLAIMED_SHA" \
      '{ok:false,
        error:("task-finish sha does not match the deploy sha this run claimed — no verdict recorded, slot still held. Re-run: task-finish " +
               $run + " " + (if $claimed == "" then "<claimed-sha>" else $claimed end) + " <verdict>"),
        runId:$run,suppliedSha:$supplied,claimedSha:(if $claimed == "" then null else $claimed end)}'
    exit 2
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - no terminal effect attempted",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if [ "$RUN_VERDICT_RESUMED" != true ]; then
    NOW="$(iso_now)"
    VERDICT_DIGEST="$(verdict_digest "$(verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW")")"
  fi
  if ! task_finish_fence_begin "$RUN_ID" "$OWNER" "$SHA" "$VERDICT" "$NOW" "$VERDICT_DIGEST" "$RUN_VERDICT_RESUMED"; then
    exit 0
  fi
  NOW="$TASK_FINISH_COMPLETED_AT"
  VERDICT_DIGEST="$TASK_FINISH_VERDICT_DIGEST"

  if [ "${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}" != /workspace/workgroup ] &&
     [ "${SMOKE_GATE_TEST_TASK_FINISH_EXIT_AFTER:-}" = before-binding ]; then
    exit 96
  fi

  if [ "$(jq -r '.terminal != null' <<<"$FENCED_TASK_BINDING_JSON")" != true ]; then
    TERMINAL_BINDING="$(jq -c --arg verdict "$VERDICT" --arg at "$NOW" --arg digest "$VERDICT_DIGEST" \
      '.terminal={verdict:$verdict,completedAt:$at,verdictDigest:$digest}' <<<"$FENCED_TASK_BINDING_JSON")"
    if ! write_task_binding "$RUN_ID" "$TERMINAL_BINDING" ||
       [ "$(read_task_binding "$RUN_ID")" != "$TERMINAL_BINDING" ]; then
      task_lease_fence_end
      jq -cn --arg run "$RUN_ID" --arg path "$(task_binding_file "$RUN_ID")" \
        '{ok:false,error:("could not commit exact shared terminal task binding at " + $path + " - lease and private slot remain held"),runId:$run,taskBindingFile:$path}'
      exit 1
    fi
    FENCED_TASK_BINDING_JSON="$TERMINAL_BINDING"
  fi

  # The first durable terminal write is shared. A crash here leaves every
  # container refusing the identity, while an exact task-finish retry rebuilds
  # the private verdict from these immutable facts.
  if [ "${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}" != /workspace/workgroup ] &&
     [ "${SMOKE_GATE_TEST_TASK_FINISH_EXIT_AFTER:-}" = binding ]; then
    exit 98
  fi

  if [ "$RUN_VERDICT_RESUMED" != true ]; then
    mkdir -p "$(run_dir "$RUN_ID")" 2>/dev/null
    RV_TMP="$(mktemp "$(run_dir "$RUN_ID")/.verdict.XXXXXX" 2>/dev/null)"
    if [ -z "$RV_TMP" ]; then
      task_lease_fence_end
      jq -cn --arg run "$RUN_ID" --arg dir "$(run_dir "$RUN_ID")" \
        '{ok:false,error:("could not stage the run verdict under " + $dir +
                          " — no verdict recorded, slot still held. Fix the state dir and re-run this task-finish."),runId:$run}'
      exit 1
    fi
    verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW" > "$RV_TMP"
    if ln "$RV_TMP" "$RUN_VERDICT_FILE" 2>/dev/null; then
      rm -f "$RV_TMP" 2>/dev/null
    else
      rm -f "$RV_TMP" 2>/dev/null
      # Lost the create to a concurrent task-finish between the short-circuit
      # above and here. Same arbitration, same refusal to overwrite.
      EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
      if [ -n "$EXISTING_VERDICT" ] && [ "$(verdict_digest "$EXISTING_VERDICT")" = "$VERDICT_DIGEST" ]; then
        : # identical file already there — proceed, the state clear below is idempotent
      else
        task_lease_fence_end
        jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" --arg attempted "$VERDICT" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '{ok:false,gateStatus:"reconciliation_required",
            error:("a DIFFERENT verdict was written for this run while this task-finish was running — STOP. Nothing was overwritten and no verdict was fabricated; " +
                   $path + " stays canonical. A human must reconcile which run owns this outcome."),
            runId:$run,runVerdictFile:$path,recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted}}'
        exit 1
      fi
    fi
  fi

  # The test seam is accepted only off the production shared root.
  if [ "${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}" != /workspace/workgroup ] &&
     [ "${SMOKE_GATE_TEST_TASK_FINISH_EXIT_AFTER:-}" = verdict ]; then
    exit 97
  fi

  if [ "$FENCED_TASK_LEASE_JSON" != null ] && ! task_lease_remove_fenced "$RUN_ID"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared task lease under " + $dir + " - terminal state not committed"),runId:$run,leaseReleased:false}'
    exit 1
  fi
  if [ "${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}" != /workspace/workgroup ] &&
     [ "${SMOKE_GATE_TEST_TASK_FINISH_EXIT_AFTER:-}" = lease-removal ]; then
    exit 99
  fi
  STATE="$(jq -c --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null | .activeLeaseOwner=null' <<<"$STATE")"
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    RESTORED=false
    if [ "$FENCED_TASK_LEASE_JSON" != null ]; then
      write_task_lease "$RUN_ID" "$FENCED_TASK_LEASE_JSON" && RESTORED=true
    fi
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not commit terminal task state - no success receipt returned and lease restoration attempted",runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --arg verdict "$VERDICT" --arg now "$NOW" --arg digest "$VERDICT_DIGEST" \
    '{ok:true,leaseReleased:true,runId:$run,sha:$sha,verdict:$verdict,finishedAt:$now,verdictDigest:$digest}'
  exit 0
fi

# ---------------------------------------------------------------------------
if [ "$COMMAND" = "finish" ]; then
  SHA="${2:-}"
  RUN_ID="${3:-}"
  VERDICT="${4:-}"
  OWNER="${5:-$DEFAULT_OWNER}"
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"finish requires a 40-character SHA"}'
    exit 2
  fi
  case "$VERDICT" in
    GO|NO_GO|HUMAN_DECISION|BLOCKED) ;;
    *) jq -cn '{ok:false,error:"finish verdict must be GO, NO_GO, HUMAN_DECISION, or BLOCKED"}'; exit 2 ;;
  esac
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"finish requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi

  # TERMINAL BINDING — the run-level verdict.json is consulted BEFORE the slot
  # guard, because it outranks gate state. A completed run is nobody's
  # activeRunId, so asking the slot first would answer a repeated finish with
  # "not the active run" — true, and useless: the caller needs to know the
  # verdict is already recorded, and a caller with a DIFFERENT verdict needs to
  # be stopped rather than told to re-claim.
  RUN_VERDICT_FILE="$(run_verdict_file "$RUN_ID")"
  RUN_VERDICT_RESUMED=false
  if [ -s "$RUN_VERDICT_FILE" ]; then
    EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
    if [ -n "$EXISTING_VERDICT" ] &&
       jq -e --arg sha "$SHA" --arg run "$RUN_ID" --arg v "$VERDICT" \
         '.sha == $sha and .runId == $run and .verdict == $v' \
         <<<"$EXISTING_VERDICT" >/dev/null 2>&1; then
      # Same terminal facts. Reuse the recorded finishedAt so the digest is the
      # SAME string, then let the rest of finish run: a crash between this file
      # and the hold/ledger writes is exactly the case a retry has to complete,
      # and every step below is idempotent. Only a run whose gate state is
      # already committed short-circuits.
      NOW="$(jq -r '.finishedAt' <<<"$EXISTING_VERDICT")"
      VERDICT_DIGEST="$(verdict_digest "$EXISTING_VERDICT")"
      RUN_VERDICT_RESUMED=true
      COMPLETED_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
      if [ -n "${COMPLETED_PR:-}" ] &&
         [ "$(jq -r '.completedRunId // empty' "$(pr_state_file "$COMPLETED_PR")" 2>/dev/null)" = "$RUN_ID" ]; then
        jq -cn --argjson pr "$COMPLETED_PR" --argjson verdict "$EXISTING_VERDICT" \
          --arg digest "$VERDICT_DIGEST" --arg path "$RUN_VERDICT_FILE" \
          '{ok:true,idempotent:true,
            note:"this run was already finished with these exact terminal facts — nothing re-recorded, no artifact rewritten",
            pr:$pr,verdictDigest:$digest,runVerdictFile:$path} + $verdict'
        exit 0
      fi
    else
      # FAIL CLOSED. A second, DIFFERENT verdict for one run means two things
      # believe they own the outcome. verdict.json stays canonical and
      # untouched — the gate never fabricates a BLOCKED to paper over this, and
      # never overwrites. State and ledger are indexed receipts; the state gets
      # flagged so no automated path treats this run as settled.
      RECON_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
      RECON_RECORDED=false
      # This check runs before caller authority is established. The write-once
      # run verdict is enough to refuse; mutating PR state here would let a
      # displaced owner quarantine its successor's live campaign.
      jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" \
        --arg attempted "$VERDICT" --argjson recon "$RECON_RECORDED" \
        --argjson pr "$(if [ -n "${RECON_PR:-}" ]; then printf '%s' "$RECON_PR"; else printf 'null'; fi)" \
        --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
        '{ok:false,gateStatus:"reconciliation_required",
          error:("a DIFFERENT verdict is already recorded for this run — STOP. Nothing was overwritten and no verdict was fabricated. " +
                 $path + " stays canonical; a human must reconcile which campaign owns this run before any verdict is published."),
          runId:$run,pr:$pr,runVerdictFile:$path,
          recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted},
          stateFlagged:$recon}'
      exit 1
    fi
  fi

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

  # HARD RULE: `no-disposition` must never permit synthesis or GO. The
  # challenger timeout exists to end a stall, and a stall that releases the
  # coordinator toward GO is strictly worse than the stall — it publishes a
  # pass that nothing challenged. Refused before any state or artifact is
  # touched, so the slot survives and a correct verdict can still be recorded.
  if [ "$VERDICT" = GO ] &&
     [ "$(jq -r '.challengerDisposition // empty' <<<"$STATE")" = "no-disposition" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg at "$(jq -r '.challengerTimedOutAt // empty' <<<"$STATE")" \
      '{ok:false,
        error:("this run'"'"'s challenger never filed a disposition before its deadline (recorded no-disposition at " + $at +
               ") — GO is REFUSED. An unchallenged campaign cannot pass. Finish NO_GO, HUMAN_DECISION or BLOCKED."),
        pr:$pr,runId:$run,challengerDisposition:"no-disposition",refusedVerdict:"GO"}'
    exit 2
  fi

  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - no terminal effect attempted",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  # This shared fence remains held through every terminal effect and the final
  # state transition. Expiry may pass while network work runs, but no successor
  # can reclaim until this locked transition either completes or the process
  # dies and leaves the lease available for forward recovery.
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi

  # TERMINAL BINDING — recoverable commit sequence, steps 2 and 3.
  #
  # 2. finishIntent first. It carries the ONE finishedAt this run will ever
  #    use, so a finish that crashes before verdict.json lands recomputes the
  #    SAME digest on retry instead of colliding with itself. An intent whose
  #    terminal facts differ from this invocation's is NOT resumed — that is a
  #    real disagreement, and it falls through to a fresh intent whose digest
  #    will not match any verdict.json already on disk.
  # 3. verdict.json, write-once, before ANY completed state exists. That
  #    ordering is the whole point: state and ledger become receipts of a file
  #    that already exists, so they can never be the sole surviving authority.
  if [ "$RUN_VERDICT_RESUMED" != true ]; then
    INTENT="$(jq -c --arg run "$RUN_ID" --arg sha "$SHA" --arg v "$VERDICT" \
      '.finishIntent // empty | select(.runId == $run and .sha == $sha and .verdict == $v)' <<<"$STATE")"
    if [ -n "$INTENT" ]; then
      NOW="$(jq -r '.finishedAt' <<<"$INTENT")"
      VERDICT_DIGEST="$(jq -r '.digest' <<<"$INTENT")"
    else
      NOW="$(iso_now)"
      VERDICT_DIGEST="$(verdict_digest "$(verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW")")"
      STATE="$(jq -c --arg run "$RUN_ID" --arg sha "$SHA" --arg v "$VERDICT" \
        --arg now "$NOW" --arg d "$VERDICT_DIGEST" \
        '.finishIntent={runId:$run,sha:$sha,verdict:$v,finishedAt:$now,digest:$d,recordedAt:$now}' <<<"$STATE")"
      write_pr_state "$PR" "$STATE"
    fi

    # `ln` and not `mv -n`: GNU `mv -n` exits 0 when it SKIPS, which is
    # indistinguishable from having written the file. `ln` fails with EEXIST,
    # so "I created it" and "it was already there" are separable — and they
    # have to be, because they mean opposite things here.
    mkdir -p "$(run_dir "$RUN_ID")" 2>/dev/null
    RV_TMP="$(mktemp "$(run_dir "$RUN_ID")/.verdict.XXXXXX" 2>/dev/null)"
    if [ -z "$RV_TMP" ]; then
      jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$(run_dir "$RUN_ID")" \
        '{ok:false,error:("could not stage the run verdict under " + $dir +
                          " — no verdict recorded, no hold touched, slot still held. Fix the state dir and re-run this finish."),
          pr:$pr,runId:$run}'
      exit 1
    fi
    verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW" > "$RV_TMP"
    if ln "$RV_TMP" "$RUN_VERDICT_FILE" 2>/dev/null; then
      rm -f "$RV_TMP" 2>/dev/null
    else
      rm -f "$RV_TMP" 2>/dev/null
      # Lost the create to a concurrent finish between the short-circuit above
      # and here. Same arbitration, same refusal to overwrite.
      EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
      if [ -n "$EXISTING_VERDICT" ] &&
         [ "$(verdict_digest "$EXISTING_VERDICT")" = "$VERDICT_DIGEST" ]; then
        : # identical file already there — proceed, the artifacts below are idempotent
      else
        STATE="$(jq -c --arg now "$(iso_now)" --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" \
          --arg attempted "$VERDICT" --arg sha "$SHA" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '.gateStatus="reconciliation_required" |
           .reconciliation={detectedAt:$now,runId:$run,verdictFile:$path,
                            recorded:$recorded,attempted:{sha:$sha,verdict:$attempted}}' <<<"$STATE")"
        RECON_RECORDED=false
        if write_pr_state "$PR" "$STATE"; then RECON_RECORDED=true; fi
        jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" \
          --arg sha "$SHA" --arg attempted "$VERDICT" \
          --argjson recon "$RECON_RECORDED" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '{ok:false,gateStatus:"reconciliation_required",
            error:("a DIFFERENT verdict was written for this run while this finish was running — STOP. Nothing was overwritten and no verdict was fabricated; " +
                   $path + " stays canonical. A human must reconcile which campaign owns this run."),
            pr:$pr,runId:$run,runVerdictFile:$path,
            recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted},stateFlagged:$recon}'
        exit 1
      fi
    fi
  fi

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
  # Keep both the private PR lock and the shared lifecycle/lease locks through
  # the terminal work. A concurrent claim must wait; allowing it to change the
  # slot while suspend/publish/hold/ledger writes are in flight would let both
  # coordinators create terminal effects.

  # Suspend the backend preview so a finished PR stops billing compute while
  # it waits for merge/close. Teardown itself is Render's job (auto-delete on
  # PR close) — this gate never deletes services. Rediscovered fresh rather
  # than trusting a stored id, since the preview may already be gone.
  SUSPEND_ATTEMPTED=false
  SUSPEND_OK=false
  SUSPEND_STATUS="null"
  SUSPEND_REASON=""
  if SERVICES_JSON="$(fetch_services)" && jq -e 'type == "array"' <<<"$SERVICES_JSON" >/dev/null 2>&1; then
    # THE mutating site (#1536) — a wrong-twin pick here POSTs suspend against
    # a service nobody chose. Same candidate-enumeration + bundle-oracle
    # resolution as evaluate_pr, so this site can never disagree with what a
    # coordinator was told during the campaign.
    FINISH_FRONTEND_IDENTITY="$(resolve_frontend_identity "$SERVICES_JSON" "$PR")"
    FINISH_FRONTEND_URL="$(jq -r '.selected.url // empty' <<<"$FINISH_FRONTEND_IDENTITY")"
    BACKEND_IDENTITY="$(resolve_backend_identity "$SERVICES_JSON" "$PR" "$FINISH_FRONTEND_URL")"
    BACKEND_METHOD="$(jq -r '.method' <<<"$BACKEND_IDENTITY")"
    BACKEND_PREVIEW="$(jq -c '.selected' <<<"$BACKEND_IDENTITY")"
    if [ "$BACKEND_METHOD" = "ambiguous" ]; then
      # On ambiguity: attempt nothing, record why. finish itself still
      # completes and writes its verdict — suspend has always been
      # best-effort here (every other failure mode below only records a
      # reason too), and stranding the run would be a worse, newer failure
      # than one preview left running until a human picks.
      SUSPEND_REASON="$(jq -r '.reason' <<<"$BACKEND_IDENTITY")"
      printf 'smoke-pr-gate: %s\n' "$SUSPEND_REASON" >&2
    elif [ "$BACKEND_PREVIEW" != "null" ]; then
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
  TERMINAL_EFFECT_ERROR=""
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
        # the attempt is refused below with the slot and lease held for retry.
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
          HANDOFF_REASON="$HANDOFF_ARTIFACT_ERROR — the ledger line below may record this attempt, but finish remains retryable with the slot and lease held."
          TERMINAL_EFFECT_ERROR="$HANDOFF_ARTIFACT_ERROR"
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
            LEDGER_LINE=""
            exec 7>"$HANDOFF_LEDGER.lock"
            if flock -w 5 7; then
              # verdictDigest ties this line to the run-level verdict.json it is
              # a receipt of: a ledger line whose digest names no verdict file
              # is a fabrication, and one that disagrees with the file is the
              # reconciliation case. Appended, so older readers (the develop
              # gate's tail -1 + field reads) are unaffected.
              if jq -cn --arg target "$TARGET_SHA" --arg freeze "$SHA" --argjson pr "$PR" \
                --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
                --arg digest "$VERDICT_DIGEST" \
                '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,
                  runId:$run,verdict:$verdict,finishedAt:$now,verdictDigest:$digest}' >> "$HANDOFF_LEDGER"; then
                LEDGER_LINE="$(tail -1 "$HANDOFF_LEDGER" 2>/dev/null || true)"
              fi
              # VERIFIED like the publish/hold writes above: taking the lock
              # says nothing about the append landing. A writable directory
              # with an unwritable ledger FILE (ENOSPC, chattr +i, a bad mode)
              # left `written:true, reason:null` with no line — the same
              # fail-open the artifact checks exist to close. Read back under
              # the lock, so no other holder's line can be mistaken for ours.
              if [ -n "$LEDGER_LINE" ] &&
                jq -e --arg run "$RUN_ID" --arg now "$NOW" --arg digest "$VERDICT_DIGEST" \
                  '.runId == $run and .finishedAt == $now and .verdictDigest == $digest' \
                  <<<"$LEDGER_LINE" >/dev/null 2>&1; then
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
            # Keep the slot and lease held below so the same finish can retry;
            # otherwise the develop gate remains blind with no automated
            # recovery path.
            # Append rather than replace: an artifact failure above is the more
            # dangerous half (a hold that never went up) and must not be lost
            # behind the ledger's message.
            if [ -n "$HANDOFF_ARTIFACT_ERROR" ]; then
              HANDOFF_REASON="$HANDOFF_REASON ALSO: ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome either."
            else
              HANDOFF_REASON="ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome. The slot and lease remain held so this finish can be retried."
            fi
            TERMINAL_EFFECT_ERROR="${TERMINAL_EFFECT_ERROR:+$TERMINAL_EFFECT_ERROR; }ledger line was not appended to $HANDOFF_LEDGER"
          fi
        fi
      fi
    fi
  fi

  if [ -n "$TERMINAL_EFFECT_ERROR" ]; then
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg error "$TERMINAL_EFFECT_ERROR" \
      '{ok:false,error:("terminal artifact write failed - slot and shared lease remain held for retry: " + $error),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi

  # Build and durably write the indexed PR receipt while both shared fences
  # and the private PR lock are still held. Nothing after owner validation is
  # allowed to escape the fence.
  VERDICT_JSON="$(jq -cn \
    --argjson pr "$PR" --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --argjson attempted "$SUSPEND_ATTEMPTED" --argjson ok "$SUSPEND_OK" \
    --argjson status "$SUSPEND_STATUS" --arg reason "$SUSPEND_REASON" \
    --argjson handoffWritten "$HANDOFF_WRITTEN" --arg handoffReason "$HANDOFF_REASON" \
    --arg handoffTargetSha "$HANDOFF_TARGET_SHA" --arg divergence "$HANDOFF_DIVERGENCE" \
    --arg digest "$VERDICT_DIGEST" --arg runVerdictFile "$RUN_VERDICT_FILE" \
    '{schemaVersion:1,pr:$pr,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now,
      verdictDigest:$digest,runVerdictFile:$runVerdictFile,
      suspend:{attempted:$attempted,ok:$ok,httpStatus:$status,
               reason:(if $reason == "" then null else $reason end)},
      handoff:{written:$handoffWritten,
               targetSha:(if $handoffTargetSha == "" then null else $handoffTargetSha end),
               reason:(if $handoffReason == "" then null else $handoffReason end),
               divergenceSnapshot:(if $divergence == "" then null else $divergence end)}}')"
  VERDICT_TMP="$(mktemp "$STATE_DIR/.pr-$PR-verdict.XXXXXX" 2>/dev/null)"
  if [ -z "$VERDICT_TMP" ] || ! printf '%s\n' "$VERDICT_JSON" > "$VERDICT_TMP" 2>/dev/null ||
     ! mv "$VERDICT_TMP" "$(pr_verdict_file "$PR")" 2>/dev/null ||
     ! jq -e --arg run "$RUN_ID" --arg digest "$VERDICT_DIGEST" \
       '.runId == $run and .verdictDigest == $digest' "$(pr_verdict_file "$PR")" >/dev/null 2>&1; then
    rm -f "${VERDICT_TMP:-}" 2>/dev/null || true
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write the terminal PR verdict receipt - slot and shared lease remain held for retry",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi

  # Remove the matching PR binding and run lease before clearing the private
  # slot. Failures restore both while the shared locks stay held.
  if ! remove_pr_authority_fenced "$PR" "$RUN_ID" "$OWNER"; then
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not remove matching shared PR authority - terminal state not committed",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! lease_remove_fenced "$RUN_ID"; then
    write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON" || true
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared lease under " + $dir + " - terminal state not committed"),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  STATE="$(jq -c \
    --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --arg digest "$VERDICT_DIGEST" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .completedVerdictDigest=$digest | .finishIntent=null |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null | .challengerDeadline=null' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    RESTORED=false
    if lease_restore_fenced "$RUN_ID" "$FENCED_LEASE_JSON" &&
       write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON"; then RESTORED=true; fi
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not commit terminal PR state - no success receipt returned and lease restoration attempted",pr:$pr,runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi

  lease_fence_end
  flock -u 9

  jq -cn --argjson verdict "$VERDICT_JSON" '{ok:true,leaseReleased:true} + $verdict'
  exit 0
fi

# ---------------------------------------------------------------------------
# challenger-timeout: end a campaign the challenger abandoned. Runs pr1195 and
# pr1228 stalled indefinitely because challenger/disposition.md was never
# written and nothing had a deadline. The ONLY outcome this verb can produce is
# BLOCKED, and it produces it through the ordinary `finish` — a timeout that
# unblocks a coordinator toward GO is worse than the stall it ends.
if [ "$COMMAND" = "challenger-timeout" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"challenger-timeout requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run (reclaimed or already finished) — nothing to time out"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  if [ "$RUN_ID" != "$(jq -r '.activeRunId // empty' <<<"$STATE")" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg active "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
      '{ok:false,error:"not the active run — nothing to time out",
        pr:$pr,runId:$run,activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - challenger timeout refused",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  DEADLINE="$(jq -r '.challengerDeadline // empty' <<<"$STATE")"
  if [ -z "$DEADLINE" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"this run has no challengerDeadline — it was claimed before deadlines were stamped, so there is nothing to time out. Release it or finish it explicitly.",
        pr:$pr,runId:$run}'
    exit 2
  fi
  REMAINING="$(( $(epoch_or_zero "$DEADLINE") - $(date -u +%s) ))"
  if [ "$REMAINING" -gt 0 ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg deadline "$DEADLINE" \
      --argjson remaining "$REMAINING" \
      '{ok:false,error:"the challenger deadline has not passed — keep waiting",
        pr:$pr,runId:$run,challengerDeadline:$deadline,remainingSeconds:$remaining}'
    exit 0
  fi
  # Absence is only evidence when presence was possible. With no run root
  # configured the gate cannot look, and an unreadable lookup must never be
  # read as "the challenger filed nothing" — that would BLOCK healthy campaigns
  # on every deployment that has not wired this.
  if [ -z "$CHALLENGER_RUN_ROOT" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"SMOKE_GATE_RUN_ROOT is not set, so the gate cannot look for challenger/disposition.md — refusing to declare a disposition missing that it never checked for. Wire SMOKE_GATE_RUN_ROOT to the run root, or finish this run explicitly.",
        pr:$pr,runId:$run}'
    exit 2
  fi
  if [ ! -d "$CHALLENGER_RUN_ROOT" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg root "$CHALLENGER_RUN_ROOT" \
      '{ok:false,error:("SMOKE_GATE_RUN_ROOT " + $root + " is not readable — the lookup failed, which is not the same as a missing disposition. Fix the mount and retry."),
        pr:$pr,runId:$run,runRoot:$root}'
    exit 2
  fi
  DISPOSITION_FILE="$(challenger_disposition_file "$RUN_ID")"
  if [ -s "$DISPOSITION_FILE" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$DISPOSITION_FILE" \
      '{ok:false,error:"the challenger DID file a disposition — nothing timed out. Synthesize and finish normally.",
        pr:$pr,runId:$run,dispositionFile:$path}'
    exit 0
  fi
  NOW="$(iso_now)"
  SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  STATE="$(jq -c --arg now "$NOW" --arg deadline "$DEADLINE" \
    '.challengerDisposition="no-disposition" | .challengerTimedOutAt=$now' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write challenger-timeout state - no terminal action attempted",pr:$pr,runId:$run}'
    exit 1
  fi
  lease_fence_end
  # Drop the lock before the nested finish, which takes the same one.
  flock -u 9
  exec 9>&-
  if [ -z "$SHA" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,challengerDisposition:"no-disposition",
        error:"recorded no-disposition, but this run has no claimed sha to finish against — reconcile by hand",
        pr:$pr,runId:$run}'
    exit 1
  fi
  # Through the NORMAL finish, so the write-once verdict.json, the artifact
  # writes, the ledger line and the lease drop all happen exactly as they do
  # for a coordinator-authored verdict. BLOCKED is the only verdict this path
  # can produce, and BLOCKED leaves the promotion hold untouched — a campaign
  # that could not run asserts nothing about the build.
  FINISH_OUT="$(bash "$0" finish "$SHA" "$RUN_ID" BLOCKED "$OWNER")"
  FINISH_RC=$?
  jq -cn --argjson finish "$FINISH_OUT" --arg deadline "$DEADLINE" --arg at "$NOW" \
    --arg path "$DISPOSITION_FILE" \
    '$finish + {challengerDisposition:"no-disposition",challengerDeadline:$deadline,
                challengerTimedOutAt:$at,expectedDispositionFile:$path}' 2>/dev/null ||
    printf '%s\n' "$FINISH_OUT"
  exit "$FINISH_RC"
fi

# ---------------------------------------------------------------------------
# pr_run_stalled: a claimed run nothing else will ever look at again.
#
# Every other path that notices a dead run is reached THROUGH its PR: same-run
# recovery needs the PR to settle on this poll, `pr_run_overrun` needs FRESH
# progress (active_run_is_live), and `challenger-timeout` refuses once a
# disposition exists. So a coordinator that dies after the challenger filed —
# and whose preview is then suspended, torn down, unlabeled or closed — left a
# run claimed forever with valid evidence and no terminal verdict, and nothing
# anywhere said so. A PR that is closed or unlabeled is not even in `poll`'s
# list, which is why this scans the per-PR STATE FILES, never the PR list.
#
# Precedence. Called only where `poll` would otherwise answer
# `waiting_for_candidates` — so every existing alarm and every settle/recovery
# wake outranks it, it can never delay a campaign, and a poll with no stalled
# run prints byte-for-byte what it printed before. `pr_run_overrun` is disjoint
# by predicate (live vs. not live). A listed PR whose facts say it settles is
# skipped outright: recovery owns it and merely lost this poll to a lock or a
# baseline-pin race.
#
# It reports; it never recovers. No owner token, lease or authority is minted
# or rotated here — for a PR that no longer settles, taking the slot is a
# decision (`claim <runId> <pr> <sourceSha>` resumes the published run id;
# `release` abandons it), and this wake carries the facts to make it.
#
# Latched on the RUN id like the overrun alarm, but one-shot: a new run id
# re-arms it for free and nothing re-rings the same run.
stalled_not_settling() {  # <pr> <state-json> -> reason object, or nothing when recovery owns this PR
  local pr="$1" state="$2" head facts
  head="$(jq -r --argjson pr "$pr" '[.[] | select(.number == $pr)][0].headRefOid // empty' <<<"$PR_LIST_JSON" 2>/dev/null)"
  if [ -z "$head" ]; then
    jq -cn '{reason:"pr_not_listed"}'
    return
  fi
  facts="$(cat "${TMP_DIR:-/nonexistent}/facts-$pr.json" 2>/dev/null || true)"
  jq -e 'type == "object"' <<<"$facts" >/dev/null 2>&1 || facts='{}'
  jq -cn --arg head "$head" --argjson facts "$facts" --argjson state "$state" '
    ($facts | {fetchOk, settled, ciReady, ciPending, ciFailed, backendReady, frontendRequired,
               frontendReady, healthzReady, previewAmbiguous, migrationsTouched}) as $f |
    if $state.activeSha != $head then {reason:"head_moved", headSha:$head}
    elif $facts.fetchOk != true then {reason:"facts_unavailable", headSha:$head}
    elif $state.completedSha == $head then {reason:"head_sha_already_completed", headSha:$head}
    elif ($facts.migrationsTouched == true and $facts.isFreezePr != true) then
      {reason:"migrations_refused", headSha:$head, facts:$f}
    elif $facts.settled != true then {reason:"not_settled", headSha:$head, facts:$f}
    else empty end'
}

stalled_run_alarm() {  # prints one wake and returns 0, or prints nothing and returns 1
  local f state pr run last quiet now why view w_pr="" w_run="" w_why=""
  local dispo=null contract=null adopt=null
  now="$(date -u +%s)"
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    state="$(jq -c 'select(type == "object")' "$f" 2>/dev/null || true)"
    [ -n "$state" ] || continue
    run="$(jq -r '.activeRunId // empty' <<<"$state")"
    [ -n "$run" ] || continue
    [ "$(jq -r '.stalledAlertRunId // empty' <<<"$state")" != "$run" ] || continue
    pr="$(jq -r '.pr // empty' <<<"$state")"
    printf '%s' "$pr" | grep -Eq '^[1-9][0-9]*$' || continue
    [ -z "$w_pr" ] || [ "$pr" -lt "$w_pr" ] || continue
    last="$(epoch_or_zero "$(jq -r '.activeProgressAt // .activeStartedAt // empty' <<<"$state")")"
    [ "$(( now - last ))" -ge "$(( PROGRESS_STALE_SECONDS + STALLED_GRACE_SECONDS ))" ] || continue
    why="$(stalled_not_settling "$pr" "$state")"
    [ -n "$why" ] || continue
    w_pr="$pr"; w_run="$run"; w_why="$why"
  done
  [ -n "$w_pr" ] || return 1

  exec 9>"$(pr_lock_file "$w_pr")"
  if ! flock -w 5 9; then exec 9>&-; return 1; fi
  state="$(read_pr_state "$w_pr")"
  # Re-verify under the lock: a `progress`, `claim`, `finish` or another poll
  # may have landed since the unlocked scan.
  last="$(epoch_or_zero "$(jq -r '.activeProgressAt // .activeStartedAt // empty' <<<"$state")")"
  if [ "$(jq -r '.activeRunId // empty' <<<"$state")" != "$w_run" ] ||
     [ "$(jq -r '.stalledAlertRunId // empty' <<<"$state")" = "$w_run" ] ||
     [ "$(( now - last ))" -lt "$(( PROGRESS_STALE_SECONDS + STALLED_GRACE_SECONDS ))" ] ||
     ! write_pr_state "$w_pr" "$(jq -c --arg run "$w_run" '.stalledAlertRunId=$run' <<<"$state")"; then
    flock -u 9; exec 9>&-
    return 1
  fi
  flock -u 9; exec 9>&-

  # One best-effort lookup, paid only by the poll that actually rings: a PR
  # that fell out of the labeled-open list is closed, merged, unlabeled or
  # rebased onto another base, and which one decides release vs. resume.
  if [ "$(jq -r '.reason' <<<"$w_why")" = pr_not_listed ]; then
    view="$(timeout 10 gh pr view "$w_pr" -R "$REPO" --json state,labels,baseRefName,headRefOid 2>/dev/null || true)"
    if jq -e 'type == "object" and (.state | type == "string")' <<<"$view" >/dev/null 2>&1; then
      w_why="$(jq -c --arg label "$LABEL" --arg base "$BRANCH" '
        {reason:(if .state != "OPEN" then ("pr_" + (.state | ascii_downcase))
                 elif ([.labels[]?.name] | index($label)) == null then "label_removed"
                 elif (.baseRefName // $base) != $base then "base_changed"
                 else "pr_not_listed" end),
         prState:.state, labeled:(([.labels[]?.name] | index($label)) != null),
         headSha:(.headRefOid // null)}' <<<"$view")"
    fi
  fi
  # Absence is only evidence when presence was possible (same rule as
  # `challenger-timeout`): with no readable run root these are null, not false.
  if [ -n "$CHALLENGER_RUN_ROOT" ] && [ -d "$CHALLENGER_RUN_ROOT" ]; then
    dispo=false; contract=false; adopt=false
    [ ! -s "$(challenger_disposition_file "$w_run")" ] || dispo=true
    if [ -s "$CHALLENGER_RUN_ROOT/$w_run/completion-contract.json" ]; then
      contract=true
      # The contract binds the token of whoever authored it
      # (smoke-run-scaffold.sh:479) and every reclaim mints a new one, so a
      # successor's marker/redispatch is refused by require_contract_owner
      # (smoke-run-scaffold.sh:311) until it takes the contract over.
      [ -z "$(jq -r '.coordinatorOwnerToken // empty' \
            "$CHALLENGER_RUN_ROOT/$w_run/completion-contract.json" 2>/dev/null || true)" ] || adopt=true
    fi
  fi
  jq -cn --argjson state "$state" --argjson why "$w_why" --argjson now "$now" --argjson last "$last" \
    --argjson dispo "$dispo" --argjson contract "$contract" --argjson adopt "$adopt" \
    --argjson leaseLive "$(lease_is_live "$(read_lease "$w_run")")" \
    '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_run_stalled",
      pr:$state.pr, runId:$state.activeRunId, sourceSha:$state.activeSha,
      activeStartedAt:$state.activeStartedAt, lastProgressAt:$state.activeProgressAt,
      quietSeconds:($now - $last),
      challengerDispositionFiled:$dispo, challengerDeadline:$state.challengerDeadline,
      synthesisPending:($dispo == true),
      finishIntentPending:($state.finishIntent != null),
      completionContractExists:$contract, contractAdoptionRequired:$adopt,
      leaseLive:$leaseLive,
      notSettling:$why,
      hint:"This run is still claimed but its coordinator stopped stamping progress, and its PR is no longer a settle candidate, so poll will never resume it. Nothing was reclaimed: no owner token, lease or authority changed. Decide: resume the SAME run id with `claim <runId> <pr> <sourceSha>` (allowed because progress is stale, once leaseLive is false; keeps the evidence and the challenger deadline) and carry it to `finish`, or abandon it with `claim` then `release`. This alarm fires once per run id."}}'
  return 0
}

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" \
    '{ok:false,error:("unknown command: " + $command),
      commands:["poll","check","wait-settled","claim","release","progress","finish",
                "lease-claim","lease-renew","lease-release","lease-status",
                "challenger-timeout"]}'
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
# An EMPTY list is the one answer this command cannot be trusted on. `gh pr
# list` routes through GitHub's search API, and an unresolvable or no-longer-
# readable repo answers with HTTP 200, body `[]`, exit 0, empty stderr — byte
# for byte a healthy "nothing is labeled". That defeats all three legs of the
# guard below, which made the gate_fetch_failed escalation unreachable for
# exactly the failures that stop every campaign silently: a renamed repo, a
# revoked or rescoped token, a typo'd SMOKE_GATE_REPO.
#
# So on empty (and ONLY on empty — the healthy path pays nothing) ask a
# question that actually 404s. `gh repo view` hits the repo endpoint directly
# and exits non-zero when the repo does not resolve or is no longer readable,
# which turns "absence of PRs" back into evidence instead of an assumption.
REPO_PROBE_OK=true
if [ "$PR_LIST_RC" -eq 0 ] && [ "$PR_LIST_LEN" = "0" ]; then
  timeout 10 gh repo view "$REPO" --json name >/dev/null 2>&1 || REPO_PROBE_OK=false
fi
# Exit code, reachability, shape, AND truncation (>=100, the --limit ceiling —
# same guard evaluate_pr already applies to its own files/check-runs fetches)
# all gate here. A command that fails but still prints something that happens to
# parse as an empty/valid array must not be read as a legitimate "no labeled
# PRs" result, and a truncated page must not be read as "only these PRs are
# labeled" — either way some labeled PRs would silently never get polled.
if [ "$PR_LIST_RC" -ne 0 ] || [ "$REPO_PROBE_OK" != true ] || \
   ! jq -e 'type == "array"' <<<"$PR_LIST_JSON" >/dev/null 2>&1 || \
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
  # No labeled PR is exactly what a stalled run's PR looks like once it closes.
  if stalled_run_alarm; then exit 0; fi
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
  # Kept for stalled_not_settling, which names WHY a stalled run's PR is not
  # being recovered from these same facts rather than a second fetch.
  printf '%s\n' "$FACTS" > "$TMP_DIR/facts-$PR.json"

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

  # Deterministic regression seam for the evaluated-but-not-yet-promoted
  # window (a slow poll holding an OLD head's facts). Production wrappers never
  # set it — same guard as the post-bind seam below.
  if [ -n "${SMOKE_GATE_SHARED_ROOT+x}" ] && [ "$SMOKE_GATE_SHARED_ROOT" != /workspace/workgroup ] &&
     [ -n "${SMOKE_GATE_TEST_HOLD_BEFORE_RANGE_PIN_FILE:-}" ]; then
    : > "$SMOKE_GATE_TEST_HOLD_BEFORE_RANGE_PIN_FILE.ready"
    for _wait in $(seq 1 600); do
      [ -e "$SMOKE_GATE_TEST_HOLD_BEFORE_RANGE_PIN_FILE" ] && break
      /usr/bin/sleep 0.05 2>/dev/null || sleep 0.05
    done
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
  # Pin the freeze campaign's WHOLE range result to this head SHA at the first
  # settled evaluation (see the STORAGE INVARIANT above range_pin_lookup).
  # These FACTS were computed before the lock, so by pinState:
  #   valid       read from the pin — offer.
  #   invalid     unknown/full, unrecoverable — offer; nothing is promoted over it.
  #   absent      promote. rc 3: the path got occupied in between, so these
  #               fresh facts are not what the head is pinned to — drop the
  #               candidate for one cycle; the next poll reads what is there.
  #               rc 1: no pin could be created — not offered: an unpinned
  #               campaign is exactly what this exists to prevent.
  #   unavailable no shared pin storage — not offered, said on stderr.
  RANGE_PIN_CONFLICT=false
  if [ "$(jq -r '.isFreezePr == true and .settled == true' <<<"$FACTS")" = true ]; then
    case "$(jq -r '.campaignRange.pinState // "absent"' <<<"$FACTS")" in
      valid|invalid) ;;
      absent)
        if range_pin_promote "$PR" "$HEAD_SHA" "$TMP_DIR/range-pin-$PR.json"; then
          # These facts ARE the pin now; say so, so the wake and every later
          # read of this head are the same object.
          FACTS="$(jq -c '.campaignRange.pinState="valid" | .campaignRange.baselinePinned=true' <<<"$FACTS")"
        else
          RANGE_PIN_CONFLICT=true
        fi ;;
      *) RANGE_PIN_CONFLICT=true
         printf 'smoke-pr-gate: freeze PR #%s is settled but not offered: %s\n' "$PR" \
           "$(jq -r '.campaignRange.reason // "no shared range-pin storage"' <<<"$FACTS")" >&2 ;;
    esac
  fi
  # The journeys pin follows the range pin, by the same table: valid/invalid
  # are offered as read; absent is promoted (rc 3 or 1 drops the candidate for
  # this cycle); unavailable is not offered.
  if [ "$RANGE_PIN_CONFLICT" != true ] &&
     [ "$(jq -r '.isFreezePr == true and .settled == true and (.journeys | type == "object")' <<<"$FACTS")" = true ]; then
    case "$(jq -r '.journeys.pinState // "absent"' <<<"$FACTS")" in
      valid|invalid) ;;
      absent)
        if journeys_pin_promote "$PR" "$HEAD_SHA" "$TMP_DIR/journeys-pin-$PR.json" "$TMP_DIR/journeys-catalogue-$PR.json" &&
           JOURNEYS_PINNED="$(jq -c --slurpfile j "$(journeys_pin_file "$PR" "$HEAD_SHA")" '.journeys=$j[0]' <<<"$FACTS" 2>/dev/null)" &&
           [ -n "$JOURNEYS_PINNED" ]; then
          FACTS="$JOURNEYS_PINNED"
        else
          RANGE_PIN_CONFLICT=true
        fi ;;
      *) RANGE_PIN_CONFLICT=true
         printf 'smoke-pr-gate: freeze PR #%s is settled but not offered: %s\n' "$PR" \
           "$(jq -r '.journeys.reason // "no shared journeys-pin storage"' <<<"$FACTS")" >&2 ;;
    esac
  fi
  if [ "$STATE_DIRTY" = true ]; then
    write_pr_state "$PR" "$STATE"
  fi
  flock -u 9
  exec 9>&-
  [ "$RANGE_PIN_CONFLICT" != true ] || continue

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
  # Ordinary PRs only. A freeze is never refused on migrations (see `settled`
  # in evaluate_pr), so alarming "refused" for one would announce a refusal
  # that did not happen — and, sitting before the settle check, would swallow
  # the settle itself.
  if [ "$MIGRATIONS_TOUCHED" = true ] && [ "$(jq -r '.isFreezePr' <<<"$FACTS")" != true ] &&
     [ "$REFUSED_ALERT_SHA" != "$HEAD_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" \
      --argjson files "$(jq -c '.migrationFiles // []' <<<"$FACTS")" \
      --argjson determinable "$(jq -c '.migrationsDeterminable // false' <<<"$FACTS")" \
      '{pr:$pr,sha:$sha,subtype:"migrations",migrationFiles:$files,migrationsDeterminable:$determinable}' >> "$ALARM_CANDIDATES"
    continue
  fi

  # #1603: a SHA this gate already finished, and whose backend preview this
  # gate's own `finish` therefore suspended, keeps reporting backendReady:true
  # (the deploy is still the right SHA) with healthzReady:false (503 Service
  # Suspended — by design, not an outage). That is not a stuck warm-up; it is
  # this gate's own prior suspend still in effect. Checked BEFORE the warmup
  # alarm fires — four consecutive campaigns (#1560, #1600, #1617, #1644) cost
  # a wake and a container spawn each to manually distinguish "our gate
  # suspended this" from a real stuck warm-up, with the alarm's inputs
  # unchanged across all four. COMPLETED_SHA is read once here and reused
  # below rather than duplicating the same jq read.
  COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
  HEALTHZ_READY="$(jq -r '.healthzReady' <<<"$FACTS")"
  WARMUP_ALERT_SHA="$(jq -r '.warmupAlertSha // empty' <<<"$STATE")"
  if [ "$BACKEND_READY" = true ] && [ "$HEALTHZ_READY" != true ] && \
     [ "$WARMUP_ALERT_SHA" != "$HEAD_SHA" ] && [ "$COMPLETED_SHA" != "$HEAD_SHA" ]; then
    LIVE_SINCE_EPOCH="$(epoch_or_zero "$(jq -r '.deployLiveSince // empty' <<<"$STATE")")"
    if [ "$LIVE_SINCE_EPOCH" -gt 0 ] && [ "$(( NOW_EPOCH - LIVE_SINCE_EPOCH ))" -ge "$WARMUP_TIMEOUT" ]; then
      jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"warmup"}' >> "$ALARM_CANDIDATES"
      continue
    fi
  fi

  SETTLED="$(jq -r '.settled' <<<"$FACTS")"
  [ "$SETTLED" = true ] || continue

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
  jq -c --argjson pr "$PR" --argjson recovery "$RECOVERY" --arg abandoned "$ABANDONED" \
    '. as $facts | {pr:$pr,facts:$facts,recovery:$recovery,abandonedActiveSha:(if $abandoned == "" then null else $abandoned end)}' \
    <<<"$FACTS" >> "$SETTLE_CANDIDATES"
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
      flock -u 8
      exec 8>&-
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

  # Same-SHA recovery keeps the RUN ID, not just the deadline. Minting a new
  # id on reclaim published a second identity for one campaign while every
  # artifact, marker and message still named the first — and `finish` and
  # `challenger-timeout` both guard on `.activeRunId`, so the campaign was left
  # with no terminal path under the id it had already announced. pr1432 burned
  # ~4h that way: one campaign, three run ids, no terminal path (2026-09-02). A reclaim on the same
  # frozen SHA with no disposition yet is a CONTINUATION, so it resumes the id
  # (same predicate `claim` refuses id drift on, and the same one the deadline
  # is preserved by below). A different SHA is a different campaign and mints.
  RESUMED_RUN_ID=false
  if [ "$(jq -r --arg sha "$HEAD_SHA" \
        'if (.activeSha == $sha and .challengerDisposition == null and (.activeRunId // "") != "")
         then "true" else "false" end' <<<"$STATE")" = true ]; then
    RUN_ID="$(jq -r '.activeRunId' <<<"$STATE")"
    RESUMED_RUN_ID=true
  else
    RUN_STAMP_EPOCH="$(date -u +%s)"
    RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
    while [ "$RUN_ID" = "$(jq -r '.activeRunId // empty' <<<"$STATE")" ] ||
          [ "$RUN_ID" = "$(jq -r '.completedRunId // empty' <<<"$STATE")" ]; do
      RUN_STAMP_EPOCH="$(( RUN_STAMP_EPOCH + 1 ))"
      RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
    done
  fi
  OWNER_TOKEN="$(new_owner_token || true)"
  if [ -z "$OWNER_TOKEN" ]; then
    emit_poll_lease_failure '{"ok":false,"error":"could not generate a coordinator owner token"}'
    exit 0
  fi
  LEASE_ERROR_FILE="$TMP_DIR/lease-error.json"
  if ! task_binding_guard_absent_begin "$RUN_ID" poll "$W_PR" >"$LEASE_ERROR_FILE"; then
    emit_poll_lease_failure "$(cat "$LEASE_ERROR_FILE")"
    exit 0
  fi
  if ! lease_lifecycle_begin "$W_PR" "$RUN_ID" "poll" >"$LEASE_ERROR_FILE"; then
    emit_poll_lease_failure "$(cat "$LEASE_ERROR_FILE")"
    exit 0
  fi
  PRIOR_AUTHORITY="$(read_pr_authority "$W_PR")"
  AUTHORITY_STATUS="$(pr_authority_status "$PRIOR_AUTHORITY")"
  if [ "$AUTHORITY_STATUS" = malformed ]; then
    lease_lifecycle_end
    emit_poll_lease_failure "$(jq -cn --arg path "$(pr_authority_file "$W_PR")" '{ok:false,error:("shared PR authority is malformed at " + $path)}')"
    exit 0
  fi
  if [ "$AUTHORITY_STATUS" = live ] &&
     { [ "$(jq -r '.runId' <<<"$PRIOR_AUTHORITY")" != "$RUN_ID" ] ||
       [ "$(jq -r '.owner' <<<"$PRIOR_AUTHORITY")" != "$OWNER_TOKEN" ]; }; then
    lease_lifecycle_end
    emit_poll_lease_failure "$(jq -cn --argjson authority "$PRIOR_AUTHORITY" '{ok:false,error:"another live coordinator owns this PR",leaseOwner:$authority.owner,activeRunId:$authority.runId}')"
    exit 0
  fi
  PRIOR_LEASE="$(read_lease "$RUN_ID")"
  if ! LEASE_RESULT="$(lease_acquire "$RUN_ID" "$OWNER_TOKEN" "$W_PR")"; then
    lease_lifecycle_end
    emit_poll_lease_failure "$LEASE_RESULT"
    exit 0
  fi
  if ! bind_pr_authority "$W_PR" "$RUN_ID" "$OWNER_TOKEN"; then
    ACQUIRED_LEASE="$(jq -c '.lease' <<<"$LEASE_RESULT")"
    FAILED_AUTHORITY="$(read_pr_authority "$W_PR")"
    lease_lifecycle_end
    BIND_FAILURE='{"ok":false,"error":"could not write shared PR authority"}'
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$FAILED_AUTHORITY"; then
      emit_poll_lease_failure "$BIND_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$BIND_FAILURE")"
    fi
    exit 0
  fi
  ACQUIRED_LEASE="$(jq -c '.lease' <<<"$LEASE_RESULT")"
  ACQUIRED_AUTHORITY="$(read_pr_authority "$W_PR")"
  # Deterministic regression seam for the narrow post-bind/pre-fence window.
  # Production wrappers never set it.
  if [ -n "${SMOKE_GATE_SHARED_ROOT+x}" ] && [ "$SMOKE_GATE_SHARED_ROOT" != /workspace/workgroup ] &&
     printf '%s' "${SMOKE_GATE_TEST_HOLD_RUN_LOCK_AFTER_BIND_SECONDS:-}" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    TEST_LOCK_READY="$TMP_DIR/test-run-lock-ready"
    ( flock -x 7
      : >"$TEST_LOCK_READY"
      sleep "$SMOKE_GATE_TEST_HOLD_RUN_LOCK_AFTER_BIND_SECONDS"
    ) 7>"$(lease_lock_file "$RUN_ID")" &
    for _wait in $(seq 1 100); do [ -e "$TEST_LOCK_READY" ] && break; sleep 0.01; done
  fi
  if ! lease_fence_begin "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "poll" >"$LEASE_ERROR_FILE"; then
    LEASE_FAILURE="$(cat "$LEASE_ERROR_FILE")"
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$ACQUIRED_AUTHORITY"; then
      emit_poll_lease_failure "$LEASE_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$LEASE_FAILURE")"
    fi
    exit 0
  fi
  NOW="$(iso_now)"
  # Same-SHA recovery keeps the original challenger deadline (see `claim`).
  STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$NOW" --arg run "$RUN_ID" --arg owner "$OWNER_TOKEN" \
    --arg deadline "$(challenger_deadline_from_now)" \
    '(if (.activeSha == $sha and (.challengerDeadline // "") != "" and .challengerDisposition == null)
      then .challengerDeadline else $deadline end) as $dl |
     .activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=null |
     .activeLeaseOwner=$owner |
     .challengerDeadline=$dl |
     .challengerDisposition=null | .challengerTimedOutAt=null | .finishIntent=null' <<<"$STATE")"
  if ! write_pr_state "$W_PR" "$STATE"; then
    lease_fence_end
    SLOT_FAILURE='{"ok":false,"error":"could not persist the claimed coordinator slot"}'
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$ACQUIRED_AUTHORITY"; then
      emit_poll_lease_failure "$SLOT_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$SLOT_FAILURE")"
    fi
    exit 0
  fi
  lease_fence_end
  task_binding_lock_end

  # A resumed run id whose completion contract already exists is bound to the
  # PREDECESSOR's token: `contract` stamps coordinatorOwnerToken once
  # (smoke-run-scaffold.sh:491) and the token minted above is always new, so
  # the scaffold's require_contract_owner (smoke-run-scaffold.sh:321-326) will
  # refuse this wake's marker/redispatch until it runs `adopt`. Say so in the
  # wake rather than leaving the successor to discover it from a refusal.
  # Read-only, and `null` — not false — when the run
  # root is unwired: absence is only evidence when presence was possible.
  CONTRACT_ADOPTION_REQUIRED=false
  if [ "$RESUMED_RUN_ID" = true ]; then
    if [ -z "$CHALLENGER_RUN_ROOT" ] || [ ! -d "$CHALLENGER_RUN_ROOT" ]; then
      CONTRACT_ADOPTION_REQUIRED=null
    elif [ -n "$(jq -r '.coordinatorOwnerToken // empty' \
           "$CHALLENGER_RUN_ROOT/$RUN_ID/completion-contract.json" 2>/dev/null || true)" ]; then
      CONTRACT_ADOPTION_REQUIRED=true
    fi
  fi

  jq -cn \
    --arg repo "$REPO" --arg branch "$BRANCH" --argjson pr "$W_PR" --arg runId "$RUN_ID" \
    --arg ownerToken "$OWNER_TOKEN" \
    --argjson contractAdoptionRequired "$CONTRACT_ADOPTION_REQUIRED" \
    --slurpfile factsFile <(printf '%s' "$FACTS") --argjson recovery "$RECOVERY" \
    --arg abandoned "$ABANDONED" \
    --argjson resumedRunId "$RESUMED_RUN_ID" \
    '$factsFile[0] as $facts | {wakeAgent:true,data:({
      schemaVersion:1, trigger:"pr_build_settled",
      repo:$repo, branch:$branch, pr:$pr, runId:$runId, coordinatorOwnerToken:$ownerToken,
      resumedRunId:$resumedRunId,
      contractAdoptionRequired:$contractAdoptionRequired,
      sourceSha:$facts.headSha,
      previewUrl:$facts.backendPreviewUrl,
      frontendPreviewUrl:$facts.frontendPreviewUrl,
      isFreezePr:$facts.isFreezePr, ciSha:$facts.ciSha,
      campaignSize:$facts.campaignSize, sizeReason:$facts.sizeReason,
      recovery:$recovery,
      abandonedActiveSha:(if $abandoned == "" or $abandoned == "null" then null else $abandoned end)
    } + (if $facts.isFreezePr == true then
      {campaignRange:$facts.campaignRange, migrationsInRange:$facts.migrationsInRange} else {} end)
      + (if $facts.journeys != null then {journeys:$facts.journeys} else {} end))}'
  exit 0
fi

if stalled_run_alarm; then exit 0; fi

jq -cn --argjson count "$PR_COUNT" \
  '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates",labeledPrCount:$count}}'
