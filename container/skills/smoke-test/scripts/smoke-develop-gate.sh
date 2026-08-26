#!/usr/bin/env bash
# Deterministic pre-task gate for a continuous develop smoke watcher.
# The scheduled-task contract consumes only the final stdout line.
#
# Deployment config is environment-only — no tenant defaults. Deploy a thin
# wrapper in the agent folder that exports SMOKE_GATE_REPO,
# SMOKE_GATE_BACKEND_SERVICE, SMOKE_GATE_FRONTEND_SERVICE, and
# SMOKE_GATE_DEV_URL, then execs this script.
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
DEV_URL="${SMOKE_GATE_DEV_URL:-}"
STATE_DIR="${SMOKE_GATE_STATE_DIR:-/workspace/agent/smoke-gate}"
STATE_FILE="$STATE_DIR/develop-state.json"
LOCK_FILE="$STATE_DIR/develop-state.lock"
# Single writer per file: smoke-pr-gate.sh's `finish` (given the SAME path via
# its own SMOKE_GATE_HANDOFF_LEDGER) APPENDS one line per freeze-run outcome
# here; this gate only ever reads it. Owned by this gate's state dir (not
# smoke-pr-gate.sh's) because it is this gate's dedup/tamper-check ledger —
# smoke-pr-gate.sh has no use for it once written.
HANDOFF_LEDGER="$STATE_DIR/handoff-ledger.jsonl"
DEBOUNCE_SECONDS="${SMOKE_GATE_DEBOUNCE_SECONDS:-600}"
# 4h hard ceiling: campaigns finish in 1-3h; a host restart mid-run otherwise
# strands the gate for the full window before recovery can reclaim the SHA.
ACTIVE_STALE_SECONDS="${SMOKE_GATE_ACTIVE_STALE_SECONDS:-14400}"
# Liveness: the coordinator stamps `progress <run-id>` while working. An
# active run whose newest stamp (or start, if never stamped) is older than
# this is treated as dead — catches containers killed at spawn without
# waiting out the hard ceiling.
PROGRESS_STALE_SECONDS="${SMOKE_GATE_PROGRESS_STALE_SECONDS:-1800}"
OVERRUN_REALERT_SECONDS="${SMOKE_GATE_OVERRUN_REALERT_SECONDS:-7200}"
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
# Optional explicit block flag (default-open promotion gating): NO_GO and
# HUMAN_DECISION write it, a later GO removes it, BLOCKED leaves it untouched —
# an infra-blocked run neither raises a false hold nor clears a real one.
# Absence of the file means "no smoke objection", so history predating the
# smoke watcher and watcher downtime never gate a promotion by themselves.
# (HUMAN_DECISION joined the raising set on 2026-08-25; this comment said
# otherwise until 2026-08-26. The `finish` block below is the code.)
HOLD_FILE="${SMOKE_GATE_HOLD_FILE:-}"
# Optional directory of append-only JSONL where a human's decision on a hold is
# recorded — the release desk's own gate ledger. UNSET = INERT: no file is read
# and every campaign-open path behaves exactly as it did before this existed.
#
# Why it exists. Nothing in this file ever read HOLD_FILE before opening a
# campaign, only wrote it. So a standing `needs_human_decision` hold was
# invisible to the thing that decides to freeze and test: develop kept moving,
# the cooldown kept expiring, and a fresh campaign opened every
# FREEZE_MIN_INTERVAL_SECONDS to re-derive a verdict about findings the new
# build does not touch. Four campaigns in 24h on 2026-08-24/25, every one
# HUMAN_DECISION, each one a preview pair and four browser lanes.
#
# This does NOT gate promotion — HOLD_FILE alone does that, and nothing here
# ever deletes, rewrites or expires it. It gates only whether a NEW round opens.
DECISION_LEDGER="${SMOKE_GATE_DECISION_LEDGER:-}"
# How often an undecided hold re-alarms. Default matches the campaign cadence
# floor: the human hears from the fleet at the same rate as before, but each
# notification is a token-free wake instead of a full campaign.
HOLD_ALERT_SECONDS="${SMOKE_GATE_HOLD_ALERT_SECONDS:-21600}"
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
# ...and a FLOOR under the re-arm. The ceiling alone assumed the reason text is
# stable while a condition persists, which it is not: a reason that names which
# checks failed changes whenever one of them flaps, so text-change re-arm on its
# own can wake once per poll. Ceiling stops silence; floor stops a storm. An
# alarm that fires six times an hour is one nobody reads.
PREFLIGHT_REARM_FLOOR_SECONDS="${SMOKE_GATE_PREFLIGHT_REARM_FLOOR_SECONDS:-900}"
# Comma-separated path prefixes that require each service to redeploy. When a
# service's live deploy lags the source SHA, the lag is accepted only if every
# file changed between them falls OUTSIDE that service's paths — the deployed
# artifact is then what a fresh deploy would produce. Unset = strict equality.
# Fixes the stall where a backend-only merge never redeploys the frontend, so
# three-way SHA equality can never happen.
FRONTEND_PATHS="${SMOKE_GATE_FRONTEND_PATHS:-}"
BACKEND_PATHS="${SMOKE_GATE_BACKEND_PATHS:-}"
# Opt-in handoff to PR-scoped previews (smoke-pr-gate.sh / smoke-freeze-pr.sh):
# instead of opening a QA campaign against the shared dev environment, poll
# cuts a freeze PR pinning develop at the settled SHA and hands the actual
# campaign to smoke-pr-gate.sh polling that PR like any other labeled PR —
# the original Phase 5 problem (mid-run merges voiding a campaign on the one
# shared environment) stops applying, because the frozen preview is nobody
# else's to move. Unset (default) = today's behavior, byte-for-byte; this
# whole codepath is inert until explicitly turned on.
FREEZE_HANDOFF="${SMOKE_GATE_FREEZE_HANDOFF:-false}"
# Path to smoke-freeze-pr.sh. Required (fail-closed, folded into the existing
# gate_misconfigured alarm below) whenever FREEZE_HANDOFF is on — there is no
# fallback freeze mechanism this gate could improvise.
FREEZE_HELPER="${SMOKE_GATE_FREEZE_HELPER:-}"
# How long an open freeze handoff stays worth testing. A freeze pins one
# develop SHA; past this, with develop moved on, the slot is freed so the next
# poll re-freezes on current head rather than campaigning a superseded build.
FREEZE_STALE_SECONDS="${SMOKE_GATE_FREEZE_STALE_SECONDS:-14400}"
# Minimum interval between freeze cuts (campaign cadence floor). 0 = no floor
# (default, no behavior change for existing deployments); the wrapper sets the
# policy. Counted from the last freeze OPEN, so campaign duration eats into it.
FREEZE_MIN_INTERVAL_SECONDS="${SMOKE_GATE_FREEZE_MIN_INTERVAL_SECONDS:-0}"
# `check` runs the poll derivation and reports settledness WITHOUT mutating
# state or claiming anything. It exists for human-requested campaigns, which
# freeze on a person's word rather than on a gate wake and would otherwise
# judge "is this head testable" by eye — the failure that voided the
# 2026-08-07 marketing campaign, whose frozen pair was replaced by a merge
# burst two minutes after the freeze.
READONLY=false

mkdir -p "$STATE_DIR"
# How long to wait for the state lock before giving up. The lock is no longer
# held across the network phases (see the release/re-acquire below and the
# unlock inside `freeze_status`), so a few seconds covers every ordinary
# collision. Kept small and tunable rather than "long enough for anything",
# because a scheduled-task runner may cap total wall clock.
LOCK_WAIT="${SMOKE_GATE_LOCK_WAIT_SECONDS:-15}"

# Losing the lock is NOT losing the slot, and the two must never look alike.
#
# The old shape emitted a bare `ok:false` with no `error` field, and the skill
# tells a coordinator that `ok:false` means "this run is no longer the active
# one — stop the campaign". So a mandatory `progress` stamp that merely collided
# with a busy poll killed a healthy campaign: exactly the harm the liveness fix
# shipped to prevent. `retryable:true` plus the `gate_lock_busy:` error prefix
# is the stable, greppable signal that this is transient — the not-active
# refusals never carry either. `wakeAgent:false` because a poll that could not
# take the lock has learned nothing worth spawning a coordinator for; the next
# poll retries on its own cadence.
emit_lock_busy() {
  jq -cn --arg phase "$1" \
    '{ok:false,
      retryable:true,
      error:("gate_lock_busy: another gate invocation held the state lock (" + $phase +
             ") — RETRY this same command in ~10s. This does NOT mean the run lost its slot; do not stop the campaign."),
      settled:false,
      wakeAgent:false,
      data:{schemaVersion:1,trigger:"gate_lock_busy",phase:$phase}}'
}

exec 9>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT" 9; then
  emit_lock_busy entry
  exit 0
fi

# Re-take the lock after a network phase and re-read state from disk, because a
# claim/progress/finish may have landed while we were unlocked. Read-only
# callers never re-lock: `check` drops the lock for good and writes nothing.
relock_or_exit() {
  [ "$READONLY" = true ] && return 0
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$1"
    exit 0
  fi
  STATE="$(read_state)"
}

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
    overrunAlertRunId: null,
    overrunAlertAt: null,
    displacedRunId: null,
    displacedAt: null,
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
    holdPendingRunId: null,
    holdPendingWakeAt: null,
    preflightReason: null,
    preflightWakeAt: null,
    handoffFreezePr: null,
    handoffFreezeSha: null,
    handoffTargetSha: null,
    handoffOpenedAt: null,
    freezeFailReason: null,
    freezeFailWakeAt: null,
    lastFreezeOpenedAt: null,
    ledgerTamperAlertFor: null,
    dispositions: {}
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

# A run displaced by an explicit `--takeover` is told so BY NAME instead of the
# generic "reclaimed or finished". Takeover flips `activeRunId` and nothing else
# — a shell gate cannot kill the incumbent's container — so the next gate verb
# is the only channel that reaches a displaced coordinator, and it must carry an
# unambiguous stop instruction rather than a status. Reads $STATE.
emit_not_active() {
  local run_id="$1" base="$2"
  if [ -n "$run_id" ] && [ "$(jq -r '.displacedRunId // empty' <<<"$STATE")" = "$run_id" ]; then
    jq -cn --arg run "$run_id" \
      --arg by "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
      --arg at "$(jq -r '.displacedAt // empty' <<<"$STATE")" \
      '{ok:false,
        error:("STOP THIS CAMPAIGN. This run was displaced by an explicit --takeover at " + $at +
               " and no longer owns the environment: stop every lane, write no markers, drive no browsers, publish nothing."),
        runId:$run,activeRunId:(if $by == "" then null else $by end),displacedAt:$at}'
    return 0
  fi
  jq -cn --arg run "$run_id" --arg base "$base" \
    --arg active "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
    '{ok:false,error:$base,runId:(if $run == "" then null else $run end),
      activeRunId:(if $active == "" then null else $active end)}'
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

# ── Wake dispositions (the `ack` verb) ───────────────────────────────────────
# Every alarm wake has to end in exactly one of resolved / acked / escalated.
# Before this there was no way to close one out: an unchanged condition re-woke
# the agent every ALERT_SECONDS forever. On 2026-08-25/26 one stuck freeze
# produced three identical `develop_freeze_failed` wakes exactly 6h apart —
# each re-verified the same facts, posted the same message, and dispositioned
# nothing. That is the bug; the token cost was the symptom.
#
# `acked` and `escalated` silence ONE trigger for ONE exact fingerprint (the
# condition's own reason string, which is what the wake payload carries), and
# only until ACK_MAX_SILENCE_SECONDS: a changed reason is a different condition
# and alarms on the normal rules, and an acked incident can never go dark for
# longer than the TTL. `resolved` never silences — it asserts the condition is
# gone, so if the gate still sees it the claim was wrong and must alarm.
ACK_MAX_SILENCE_SECONDS="${SMOKE_GATE_ACK_MAX_SILENCE_SECONDS:-86400}"
# Every alarm trigger this gate emits (grep `trigger:"` below). Validated on
# `ack` so a typo cannot be filed under a key nothing ever reads.
ACK_TRIGGERS="develop_unsettled develop_freeze_abandoned develop_freeze_stale
  develop_freeze_ledger_tampered develop_freeze_failed gate_hold_tampered
  develop_run_overrun develop_hold_undecided preflight_failed
  gate_misconfigured gate_fetch_failed"
# ...of which only these two re-alarm on a plain timer against a stable reason
# string, so only these two are silenceable. The other interval alarms
# (misconfigured, fetch failure, run overrun, undecided hold) stay
# un-silenceable ON PURPOSE: each is the only thing chasing a human or a broken
# deployment, and their own comments already say a latch that can go quiet is
# not a safety mechanism. `ack` still RECORDS a disposition for them — it just
# reports silenceable:false rather than pretending to mute them.
#
# This list is what the `ack` verb PROMISES; the `ack_silences` call sites in
# the poll path are what actually delivers. They must name the same triggers,
# and the test suite asserts exactly that (case 45) rather than a runtime guard
# that no call site can ever reach.
ACK_SILENCEABLE="develop_freeze_failed preflight_failed"

in_word_list() {
  local needle="$1" haystack="$2" item
  # shellcheck disable=SC2086 # word-splitting the space-separated list is the point
  for item in $haystack; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

# True when a live ack/escalation covers this exact trigger + fingerprint.
# Reads $STATE.
ack_silences() {
  local trigger="$1" fingerprint="$2" entry age now_epoch="${NOW_EPOCH:-$(date -u +%s)}"
  entry="$(jq -c --arg t "$trigger" '.dispositions[$t] // empty' <<<"$STATE" 2>/dev/null)"
  [ -n "$entry" ] || return 1
  [ "$(jq -r '.fingerprint // empty' <<<"$entry")" = "$fingerprint" ] || return 1
  case "$(jq -r '.disposition // empty' <<<"$entry")" in
    acked|escalated) ;;
    *) return 1 ;;
  esac
  age=$(( now_epoch - $(epoch_or_zero "$(jq -r '.at // empty' <<<"$entry")") ))
  [ "$age" -lt "$ACK_MAX_SILENCE_SECONDS" ]
}

# Drop a trigger's disposition. Called both when the underlying condition
# CLEARS (a later recurrence is a new incident and must alarm at once) and when
# an alarm actually fires (the fresh wake owes a fresh disposition). Sets $STATE.
drop_disposition() {
  STATE="$(jq -c --arg t "$1" '.dispositions = ((.dispositions // {}) | del(.[$t]))' <<<"$STATE")"
}

# Has a human decided the hold that run id currently owns?
#
# Prints exactly one of: `decided`, `undecided`, `unknown`. THREE values, not a
# boolean, because "the check did not say yes" is not "the check said no": an
# unset path, a missing directory and an unreadable file all mean this function
# could not tell, and the caller must see that separately from a real "nobody
# has answered". The campaign-open guard enumerates all three explicitly.
#
# The ledger is the release desk's own append-only record. Entries key the hold
# as `smoke_hold:<runId>`, which is why the hold file carries `runId` at all.
# NEWEST LINE WINS and it must be an `override`: on 2026-08-25 a human wrote an
# `override` on `smoke_hold:xzo-pr-pr1211-…` at 19:21:33Z and the desk wrote a
# `correction` on the SAME target at 20:27:00Z reading "not a human gate,
# authorizes nothing". Matching any override anywhere in the file would read
# that retracted one as decided.
#
# `-R` + `fromjson?` per line, never a streaming `jq select`: the desk appends
# to these files live, and one torn append makes a streaming select abort at
# that line and silently drop every LATER match — including, on a busy day, the
# decision this call exists to find.
hold_decision_state() {
  local run_id="$1" newest
  [ -n "$DECISION_LEDGER" ] || { printf 'unknown'; return; }
  [ -n "$run_id" ] || { printf 'unknown'; return; }
  [ -d "$DECISION_LEDGER" ] || { printf 'unknown'; return; }
  # A glob that matches nothing must not become the literal pattern string.
  local files=("$DECISION_LEDGER"/*.jsonl) raw
  [ -e "${files[0]}" ] || { printf 'undecided'; return; }
  # `cat`'s own status, not the pipeline's: an unreadable file (bad mode, a
  # remounted share) must read as `unknown`, never as "nobody decided" — that
  # is the fail-OPEN direction, and getting it backwards would wedge the fleet
  # on an IO error.
  if ! raw="$(cat "${files[@]}" 2>/dev/null)"; then printf 'unknown'; return; fi
  newest="$(printf '%s\n' "$raw" |
    jq -cR --arg t "smoke_hold:$run_id" \
      'fromjson? | select(type == "object") | select(.target == $t)' 2>/dev/null | tail -1)"
  if [ -z "$newest" ]; then printf 'undecided'; return; fi
  if [ "$(jq -r '.action // empty' <<<"$newest" 2>/dev/null)" = override ]; then
    printf 'decided'
  else
    printf 'undecided'
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
  # Drop the state lock BEFORE the fan-out. Every caller reaches this line
  # after its last state write and emits/exits immediately afterwards, so
  # nothing is lost — and this is the single longest thing the gate does (one
  # list call plus up to 100 POSTs at a 6s timeout each). Holding the lock
  # across it starved a coordinator's mandatory `progress` stamp, which then
  # read as "you are not the active run" and killed the campaign.
  flock -u 9 2>/dev/null || true
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

# Live-run artifact. `holdMergesUntil` is a cap measured from the newest
# LIVENESS signal — the last progress stamp, or the start when nothing has
# stamped yet — not from run start. A run that dies stops stamping and its hold
# therefore still expires on its own, which is the property this field exists
# for; but a run that is demonstrably alive keeps a valid hold for as long as it
# keeps stamping. Anchoring to the original start advertised an EXPIRED hold at
# minute 91 of a campaign documented to take 1-3h: a healthy, stamping run
# silently stopped holding the queue.
write_active_file() {
  [ -n "$ACTIVE_FILE" ] || return 0
  local run="$1" sha="$2" started="$3" progress="$4" anchor tmp
  anchor="$progress"
  [ -n "$anchor" ] || anchor="$started"
  mkdir -p "$(dirname "$ACTIVE_FILE")"
  tmp="$(mktemp "$(dirname "$ACTIVE_FILE")/.run-active.XXXXXX")"
  jq -cn \
    --arg run "$run" --arg sha "$sha" --arg started "$started" \
    --arg progress "$progress" \
    --arg until "$(date -u -d "@$(( $(epoch_or_zero "$anchor") + MERGE_HOLD_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" \
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
  # concurrent scheduled poll exhaust its flock wait. `poll` now does the same
  # thing for the same phase (see the unlock before the fetch block); this early
  # unlock stays because `check` never re-takes the lock at all.
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
    emit_not_active "$RUN_ID" "not the active run (reclaimed or already finished) — no verdict recorded, no hold touched"
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
    # HUMAN_DECISION raises the hold too (2026-08-25) — see the matching block
    # in smoke-pr-gate.sh's finish. A verdict meaning "the system does not know
    # whether this is safe" must not default open. BLOCKED is unchanged.
    case "$VERDICT" in
      NO_GO|HUMAN_DECISION)
        [ "$VERDICT" = NO_GO ] &&
          HOLD_REASON="confirmed defects on this develop lineage — see the run thread and run directory" ||
          HOLD_REASON="needs_human_decision"
        mkdir -p "$(dirname "$HOLD_FILE")"
        HOLD_TMP="$(mktemp "$(dirname "$HOLD_FILE")/.develop-hold.XXXXXX")"
        jq -cn --arg sha "$SHA" --arg run "$RUN_ID" --arg now "$NOW" \
          --arg verdict "$VERDICT" --arg reason "$HOLD_REASON" \
          '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,raisedAt:$now,
            reason:$reason}' > "$HOLD_TMP"
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
#
# Liveness is the progress stamp alone. ACTIVE_STALE_SECONDS used to be ANDed
# in here — the same code as the PR gate's, and the same duplicate-coordinator
# fault: a campaign stamping `progress` every few minutes went "not live" the
# instant it crossed the ceiling, and the next poll handed its environment to a
# rival with nothing telling the first. A dead container stops stamping, which
# is the only evidence of death either gate has and the only thing that may
# free a slot automatically. Overrun is now a reason to REFUSE a claim (see
# `claim`'s --takeover), never a reason to hand the slot away.
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

# Seconds a live run has held the environment. Only `claim` reads it, to decide
# whether --takeover is on offer at all: below the ceiling there is no takeover,
# only `release` or waiting.
active_run_age() {
  printf '%s' "$(( $(date -u +%s) - $(epoch_or_zero "$1") ))"
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
  # In freeze-handoff mode every campaign — scheduled OR chat-requested — runs
  # against an immutable preview, never against shared dev: dev moves ~50
  # merges/day and a campaign on it is voided by the next merge (the exact
  # failure this deployment migrated away from). Refusing here makes that a
  # property of the gate, not of anyone remembering the rule. The requested-
  # campaign flow is: cut a freeze PR with the freeze helper, wait for the PR
  # gate's `check <pr>` to report settled:true, then claim/progress/finish on
  # the PR gate. `check` stays available here for build facts.
  if [ "$FREEZE_HANDOFF" = true ]; then
    jq -cn '{ok:false,error:"claim is disabled in freeze-handoff mode — shared dev is not a campaign environment. Cut a freeze PR (smoke-freeze-pr.sh <target-sha>), wait for the PR gate check to settle, and claim there.",
      requestedCampaignFlow:["smoke-freeze-pr.sh <target-sha>","smoke-pr-gate.sh check <pr> (until settled:true)","smoke-pr-gate.sh claim <run-id> <pr> <sha>","... progress/finish on the PR gate"]}'
    exit 0
  fi
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
    # A live run keeps the environment whatever its age. Past
    # ACTIVE_STALE_SECONDS a human may still force the issue with --takeover;
    # nothing automatic ever passes it.
    ACTIVE_AGE="$(active_run_age "$(jq -r '.activeStartedAt // empty' <<<"$STATE")")"
    # `--takeover` is valid at ANY age — see the matching note in the PR gate.
    # Gating it on the ceiling denied an operator the only lever they have
    # during the first hours of a wedged campaign.
    if [ "$TAKEOVER" != true ]; then
      if [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ]; then
        HINT="active run has overrun ${ACTIVE_STALE_SECONDS}s and is still stamping progress — stop its coordinator, or re-run this claim with --takeover"
      else
        HINT="another run already owns the environment — wait for it or ask its coordinator"
      fi
      jq -cn --arg active "$ACTIVE_RUN" --arg err "$HINT" --argjson age "$ACTIVE_AGE" \
        --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
        '{ok:false,error:$err,activeRunId:$active,activeAgeSeconds:$age,
          activeSha:(if $sha == "" then null else $sha end)}'
      exit 0
    fi
    TOOK_OVER="$ACTIVE_RUN"
  fi
  NOW="$(iso_now)"
  # Record WHO was displaced so the displaced run's next gate verb carries a
  # stop instruction naming the takeover. Cleared on an ordinary claim.
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" \
    --argjson hold "$MERGE_HOLD" --arg took "${TOOK_OVER:-}" \
    '.activeSha=$sha |
     .activeStartedAt=$now |
     .activeRunId=$run |
     .activeProgressAt=$now |
     .activeMergeHold=$hold |
     .displacedRunId=(if $took == "" then null else $took end) |
     .displacedAt=(if $took == "" then null else $now end) |
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
    emit_not_active "$RUN_ID" "not the active run — nothing released"
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
    emit_not_active "$RUN_ID" "not the active run (reclaimed or finished) — stop this campaign"
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
    ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
    write_active_file "$RUN_ID" "$ACTIVE_SHA" \
      "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" "$PROGRESS_NOW"
    # Re-post the advisory notice, because `claim` could only reach the PRs
    # that existed at freeze. A PR opened mid-run gets no notice at all
    # otherwise: on 2026-08-11 #752 opened at 08:05 into a run frozen at
    # 07:00 and carried no qa/freeze status, so anyone merging it from the
    # GitHub UI saw nothing. Cheap and best-effort — the same write `claim`
    # already makes, on the cadence that is already mandatory.
    freeze_status "QA smoke run active on $BRANCH (${ACTIVE_SHA:0:12}) — merging now voids it. Advisory only; you may merge."
  fi
  jq -cn --arg run "$RUN_ID" --argjson hold "$MERGE_HOLD" '{ok:true,runId:$run,mergeHold:$hold}'
  exit 0
fi

# Terminal disposition for an alarm wake. Exactly one of resolved / acked /
# escalated, scoped to the fingerprint the wake carried (its `reason`, or the
# most specific identifier in the payload when the trigger has no reason text).
if [ "$COMMAND" = "ack" ]; then
  TRIGGER="${2:-}"
  FINGERPRINT="${3:-}"
  DISPOSITION="${4:-}"
  NOTE="${5:-}"
  if [ -z "$TRIGGER" ] || [ -z "$FINGERPRINT" ]; then
    jq -cn '{ok:false,error:"ack requires <trigger> <fingerprint> <resolved|acked|escalated> [note]"}'
    exit 2
  fi
  if ! in_word_list "$TRIGGER" "$ACK_TRIGGERS"; then
    jq -cn --arg t "$TRIGGER" \
      --argjson known "$(printf '%s\n' $ACK_TRIGGERS | jq -Rsc 'split("\n") | map(select(length > 0))')" \
      '{ok:false,error:("ack: unknown trigger " + $t),triggers:$known}'
    exit 2
  fi
  case "$DISPOSITION" in
    resolved|acked|escalated) ;;
    *)
      jq -cn '{ok:false,error:"ack disposition must be resolved, acked, or escalated"}'
      exit 2
      ;;
  esac
  ACK_NOW="$(iso_now)"
  SILENCEABLE=false
  if in_word_list "$TRIGGER" "$ACK_SILENCEABLE"; then SILENCEABLE=true; fi
  STATE="$(jq -c --arg t "$TRIGGER" --arg f "$FINGERPRINT" --arg d "$DISPOSITION" \
    --arg now "$ACK_NOW" --arg note "$NOTE" \
    '.dispositions = ((.dispositions // {}) | .[$t] = {
       fingerprint:$f, disposition:$d, at:$now,
       note:(if $note == "" then null else $note end)})' <<<"$STATE")"
  write_state "$STATE"
  # `silencedUntil` is the honest answer to "will this stop waking me": null
  # for `resolved` (which never silences) and for the triggers that are
  # deliberately un-silenceable, an ISO instant otherwise. Never claim a mute
  # the poll path will not honor.
  SILENCED_UNTIL=""
  if [ "$SILENCEABLE" = true ] && [ "$DISPOSITION" != resolved ]; then
    SILENCED_UNTIL="$(date -u -d "@$(( $(epoch_or_zero "$ACK_NOW") + ACK_MAX_SILENCE_SECONDS ))" \
      +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '')"
  fi
  jq -cn --arg t "$TRIGGER" --arg f "$FINGERPRINT" --arg d "$DISPOSITION" \
    --arg at "$ACK_NOW" --arg until "$SILENCED_UNTIL" --argjson silenceable "$SILENCEABLE" \
    '{ok:true,trigger:$t,fingerprint:$f,disposition:$d,at:$at,
      silenceable:$silenceable,
      silencedUntil:(if $until == "" then null else $until end)}'
  exit 0
fi

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" \
    '{ok:false,error:("unknown command: " + $command),
      commands:["poll","check","claim","release","progress","finish","ack"]}'
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
if [ "$FREEZE_HANDOFF" = true ] && { [ -z "$FREEZE_HELPER" ] || [ ! -x "$FREEZE_HELPER" ]; }; then
  MISSING="$MISSING SMOKE_GATE_FREEZE_HELPER"
fi
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

# ---- network derivation phase: the lock is DROPPED from here ---------------
# Everything between this line and the `relock_or_exit` calls below is pure
# read-only derivation from the forge and the deploy API — four parallel
# fetches plus up to two `compare` calls, ~10-30s of wall clock. STATE was read
# once at the top and is not touched again until we re-take the lock and RE-READ
# it, so there is no read-modify-write spanning the unlock. This is what test
# case 20 already proves for `check`; a scheduled `poll` holding the lock across
# the same fetches is what made a coordinator's `progress` stamp lose its flock
# wait. (`check` already unlocked above; a second unlock is a no-op.)
flock -u 9

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
  # First state write since the unlock — re-take the lock and re-read.
  relock_or_exit fetch-failure
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

# ---- end of the network derivation phase: the lock is RE-TAKEN here --------
# Every remaining branch mutates state, so `STATE` is re-read from disk here to
# pick up any claim/progress/finish that landed while we were on the network.
# `.fetchFailures=0` moved down with it — resetting the strike counter on the
# pre-fetch copy would have written back a stale snapshot.
relock_or_exit poll-state
STATE="$(jq -c '.fetchFailures=0' <<<"$STATE")"

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

# Handoff bookkeeping (handoff mode only). Runs BEFORE hold-file
# reconciliation below and updates completedSha/completedRunId/
# completedVerdict in-place when the ledger has an answer — so a hold this
# same freeze-run finish legitimately wrote is read as legitimate on the very
# first poll that sees it, never flagged gate_hold_tampered. This is the
# "cleaner ownership split" for point 4: the tamper-check itself is
# UNCHANGED and still trusts only completedRunId/completedVerdict: it never
# learns the ledger exists. Consulting the ledger is entirely this block's
# job, scoped to whatever THIS gate currently believes is its own open
# handoff (handoffTargetSha) — never an arbitrary ledger line — so a foreign
# or stale ledger entry can never be laundered into "legitimate" here.
if [ "$FREEZE_HANDOFF" = true ]; then
  HANDOFF_TARGET="$(jq -r '.handoffTargetSha // empty' <<<"$STATE")"
  HANDOFF_PR="$(jq -r '.handoffFreezePr // empty' <<<"$STATE")"
  if [ -n "$HANDOFF_TARGET" ]; then
    LEDGER_ENTRY=""
    if [ -s "$HANDOFF_LEDGER" ]; then
      # `-R` + `fromjson?` per line, same treatment as the retention scan's
      # read of this file. A streaming `jq select()` aborts at the first
      # malformed line and `2>/dev/null` hides it, so one torn append — which
      # is ordinary on a file another process appends to — silently drops every
      # LATER match, including the outcome this poll is waiting for. Blast
      # radius is smaller here (it fails toward "not completed yet", which the
      # staleness ceiling eventually alarms on) but it is the same bug.
      LEDGER_ENTRY="$(jq -cR --arg t "$HANDOFF_TARGET" \
        'fromjson? | select(type == "object") | select(.targetSha == $t)' \
        "$HANDOFF_LEDGER" 2>/dev/null | tail -1)"
    fi
    # Bind adoption to the SAME freeze PR as the handoff we currently have
    # open — targetSha alone is not enough to trust a ledger line: it is the
    # develop head SHA, public and echoed in our own wake payload, so a
    # forged or stale (a zombie campaign's late finish on a previously
    # abandoned handoff) line can share it while naming a different PR. A
    # line with no freezePr at all (malformed) reads as literal "null",
    # which can never equal a real PR number — falls through to the tamper
    # path below rather than adopting, and never crashes.
    L_FREEZE_PR=""
    [ -n "$LEDGER_ENTRY" ] && L_FREEZE_PR="$(jq -r '.freezePr' <<<"$LEDGER_ENTRY")"

    if [ -n "$LEDGER_ENTRY" ] && [ "$L_FREEZE_PR" = "$HANDOFF_PR" ]; then
      # The freeze run finished: smoke-pr-gate.sh already wrote the verdict.
      # Adopt it as this gate's own completed record and free the handoff
      # slot — the "same develop SHA never re-freezes" dedup advance.
      L_RUN="$(jq -r '.runId' <<<"$LEDGER_ENTRY")"
      L_VERDICT="$(jq -r '.verdict' <<<"$LEDGER_ENTRY")"
      L_FINISHED="$(jq -r '.finishedAt' <<<"$LEDGER_ENTRY")"
      STATE="$(jq -c --arg sha "$HANDOFF_TARGET" --arg run "$L_RUN" --arg verdict "$L_VERDICT" --arg now "$L_FINISHED" \
        '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
         .handoffFreezePr=null | .handoffFreezeSha=null | .handoffTargetSha=null | .handoffOpenedAt=null |
         .ledgerTamperAlertFor=null' <<<"$STATE")"
    elif [ -n "$HANDOFF_PR" ]; then
      # Either no ledger outcome yet, or one that names a DIFFERENT freeze PR
      # (tamper-shaped — handled below). Either way, check abandonment
      # FIRST: a confirmed-CLOSED freeze PR must free the handoff regardless
      # of what a stale or mismatched ledger tail claims. Checking this only
      # when the ledger was empty (the original shape) let a single latched
      # tamper mismatch shadow abandonment forever — closing the real freeze
      # PR would never be noticed again, and no gate command can clear
      # handoffFreezePr/handoffTargetSha by hand. Fail-closed on the fetch
      # itself: a lookup problem means "cannot prove it is closed", so do
      # NOT reclaim — leave the handoff in place and let a later poll retry.
      FREEZE_PR_STATE="$(timeout 8 gh pr view "$HANDOFF_PR" -R "$REPO" --json state 2>/dev/null \
        | jq -r '.state // empty' 2>/dev/null)"
      if [ "$FREEZE_PR_STATE" = "CLOSED" ] || [ "$FREEZE_PR_STATE" = "MERGED" ]; then
        # Closed with no completed (matching) verdict ever recorded —
        # abandoned. Free the slot and alarm regardless of a mismatched or
        # stale ledger tail: a closed PR is a stronger, independently
        # verified signal than a ledger line this gate already refused to
        # trust. Freeing and alarming happen together in the SAME poll, so
        # there is nothing to re-arm. The alarm names the target SHA's own
        # publish/hold artifacts (this gate's own config, shared by wrapper
        # convention with smoke-pr-gate.sh's finish) so the responder checks
        # whether the campaign actually completed and failed only to report
        # before assuming it died.
        STATE="$(jq -c '.handoffFreezePr=null | .handoffFreezeSha=null | .handoffTargetSha=null |
                        .handoffOpenedAt=null | .ledgerTamperAlertFor=null' <<<"$STATE")"
        write_state "$STATE"
        jq -cn --argjson pr "$HANDOFF_PR" --arg sha "$HANDOFF_TARGET" \
          --arg publish "$PUBLISH_FILE" --arg hold "$HOLD_FILE" \
          '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_freeze_abandoned",
            freezePr:$pr,targetSha:$sha,
            hint:"Before assuming the campaign died, check whether it actually completed but failed only to report: inspect the hold/publish artifacts for this target SHA.",
            publishFile:(if $publish == "" then null else $publish end),
            holdFile:(if $hold == "" then null else $hold end)}}'
        exit 0
      fi
      # Still open, but is it still worth testing? A freeze pins ONE develop
      # SHA; while it sits, develop keeps moving, and a campaign that finally
      # runs against a long-superseded freeze produces a verdict about a build
      # nobody ships. That happened on the very first live cycle: freeze PR
      # #786 was cut at 12:01Z, a gate bug kept it from ever settling, and the
      # campaign that eventually ran at 01:50Z tested a 14-hour-old build with
      # develop nine commits past it — the run's own verdict opened by saying
      # so. Past the ceiling, with develop actually moved on, free the slot so
      # the next poll re-freezes on current head, and tell the coordinator to
      # close the stale PR (which also tears down its previews). Freeing and
      # alarming happen in the SAME poll, so there is nothing to re-arm.
      #
      # Deliberately NOT closing the PR from here: a campaign may be mid-run
      # on it, and this gate cannot see smoke-pr-gate.sh's per-PR state. The
      # worst case of freeing the slot is one extra concurrent preview pair
      # (the running campaign still owns its own claim and finishes normally);
      # the worst case of closing it here would be killing a live run's
      # environment out from under it.
      HANDOFF_AGE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.handoffOpenedAt // empty' <<<"$STATE")") ))"
      if [ "$HANDOFF_AGE" -ge "$FREEZE_STALE_SECONDS" ] && [ "$HANDOFF_TARGET" != "$SOURCE_SHA" ]; then
        STATE="$(jq -c '.handoffFreezePr=null | .handoffFreezeSha=null | .handoffTargetSha=null |
                        .handoffOpenedAt=null | .ledgerTamperAlertFor=null' <<<"$STATE")"
        write_state "$STATE"
        jq -cn --argjson pr "$HANDOFF_PR" --arg sha "$HANDOFF_TARGET" \
          --arg current "$SOURCE_SHA" --argjson age "$HANDOFF_AGE" \
          '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_freeze_stale",
            freezePr:$pr,targetSha:$sha,currentSha:$current,ageSeconds:$age,
            hint:"This freeze is older than the staleness ceiling and develop has moved past it. Close the freeze PR (this also tears down its previews) unless a campaign is still live on it; a fresh freeze is cut on the next poll. Do not publish a verdict for a build nobody ships."}}'
        exit 0
      fi
      # Still open and still current enough. No ledger entry at all is silent (no news yet). A
      # mismatched (or malformed) entry is tamper evidence, same shape as
      # gate_hold_tampered: never adopt, never free the real handoff — one
      # latched alarm, not a re-spam every poll, re-arming only if the
      # offending freezePr changes. `try...catch` guards a malformed line
      # (freezePr missing → literal "null", not a number) from crashing this
      # jq call — it reports the raw value instead.
      if [ -n "$LEDGER_ENTRY" ]; then
        if [ "$(jq -r '.ledgerTamperAlertFor // empty' <<<"$STATE")" != "$L_FREEZE_PR" ]; then
          STATE="$(jq -c --arg pr "$L_FREEZE_PR" '.ledgerTamperAlertFor=$pr' <<<"$STATE")"
          write_state "$STATE"
          jq -cn --arg target "$HANDOFF_TARGET" --arg expected "$HANDOFF_PR" --arg got "$L_FREEZE_PR" \
            '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_freeze_ledger_tampered",
              targetSha:$target,
              expectedFreezePr:(try ($expected|tonumber) catch $expected),
              gotFreezePr:(try ($got|tonumber) catch $got)}}'
          exit 0
        fi
      else
        STATE="$(jq -c '.ledgerTamperAlertFor=null' <<<"$STATE")"
      fi
    fi
  fi

  # Out-of-band freeze adoption. A human-requested campaign cuts its freeze PR
  # by calling smoke-freeze-pr.sh directly — a supported, documented flow that
  # "bypasses the scheduled cadence floor: deliberate, a human asked". It also
  # bypasses the handoff bookkeeping above, because only THIS file's own freeze
  # cut writes handoffFreezePr/handoffTargetSha. So its campaign produces a real
  # hold, a real published verdict and a correct ledger line that the block
  # above can never adopt, `completedSha` never advances, and the very SHA that
  # was just tested stays eligible to be frozen and tested again. Live: PR #1211
  # was created 2h09m after the previous cut, inside the 6h floor this gate
  # enforces, so the gate cannot have cut it — and its ledger line was still
  # unadopted ten hours later. Same shape re-froze `8dfca446` as #1195 after
  # #1188 had already produced a verdict for it.
  #
  # Only fires with NO handoff open (nothing to hijack) and only for the exact
  # SHA this poll is about to freeze. This is the `already_completed` dedup
  # below, sourced from the ledger instead of state — not a second authority.
  # It cannot launder a verdict past the tamper shield above, which guards
  # adoption INTO an open handoff: there is none here, adoption never touches
  # the hold, and a forged GO line lands as completedVerdict=GO with a hold
  # present, which the reconciler below reports as `unexpected` and alarms on.
  if [ -z "$(jq -r '.handoffTargetSha // empty' <<<"$STATE")" ] &&
     [ "$(jq -r '.completedSha // empty' <<<"$STATE")" != "$SOURCE_SHA" ] &&
     [ -s "$HANDOFF_LEDGER" ]; then
    OOB_ENTRY="$(jq -cR --arg t "$SOURCE_SHA" \
      'fromjson? | select(type == "object") | select(.targetSha == $t)' \
      "$HANDOFF_LEDGER" 2>/dev/null | tail -1)"
    if [ -n "$OOB_ENTRY" ]; then
      STATE="$(jq -c --arg sha "$SOURCE_SHA" \
        --arg run "$(jq -r '.runId' <<<"$OOB_ENTRY")" \
        --arg verdict "$(jq -r '.verdict' <<<"$OOB_ENTRY")" \
        --arg now "$(jq -r '.finishedAt' <<<"$OOB_ENTRY")" \
        '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict' \
        <<<"$STATE")"
    fi
  fi
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
    NO_GO|HUMAN_DECISION)
      if [ ! -s "$HOLD_FILE" ]; then
        HOLD_INTEGRITY=missing
      elif [ "$(jq -r '.runId // empty' "$HOLD_FILE" 2>/dev/null)" != "$LEDGER_RUN" ]; then
        HOLD_INTEGRITY=mismatched
      fi
      ;;
    GO)
      [ -s "$HOLD_FILE" ] && HOLD_INTEGRITY=unexpected
      ;;
    # BLOCKED deliberately leaves the hold untouched, so the ledger implies no
    # expectation and there is nothing to reconcile. HUMAN_DECISION joined the
    # NO_GO branch when it started raising a hold — otherwise a HUMAN_DECISION
    # hold deleted by a builder would be the one hold nobody notices going
    # missing, which is exactly the hole this reconciler exists to close.
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
    # The ceiling was demoted from executioner to alarm, and an alarm has to
    # ring. It no longer evicts a stamping run, but the zombie stamper it was
    # really defending against is still real — a coordinator whose heartbeat
    # fires while its work is wedged. Latched on the run id, so one overrun
    # episode alarms once and a later run re-arms it for free.
    # RE-ARMS on an interval, deliberately. Since eviction is no longer
    # automatic, this alarm is the ONLY thing that surfaces a wedged run — and
    # a once-per-run-id latch means a single missed or swallowed notification
    # leaves the slot held with nothing ever saying so again. A latch that can
    # go permanently silent is not a safety mechanism; it is a safety mechanism
    # shaped like one. Re-alarm while the overrun persists.
    ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
    ACTIVE_AGE="$(active_run_age "$ACTIVE_STARTED")"
    OVERRUN_LAST="$(jq -r '.overrunAlertAt // empty' <<<"$STATE")"
    OVERRUN_SINCE="$(( $(date -u +%s) - $(epoch_or_zero "$OVERRUN_LAST") ))"
    if [ -n "$ACTIVE_RUN" ] && [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ] &&
       { [ "$(jq -r '.overrunAlertRunId // empty' <<<"$STATE")" != "$ACTIVE_RUN" ] ||
         [ "$OVERRUN_SINCE" -ge "$OVERRUN_REALERT_SECONDS" ]; }; then
      STATE="$(jq -c --arg r "$ACTIVE_RUN" --arg now "$NOW" \
        '.overrunAlertRunId=$r | .overrunAlertAt=$now' <<<"$STATE")"
      write_state "$STATE"
      jq -cn --arg run "$ACTIVE_RUN" --arg sha "$ACTIVE_SHA" --argjson age "$ACTIVE_AGE" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_run_overrun",
          runId:$run,activeSha:$sha,activeAgeSeconds:$age}}'
      exit 0
    fi
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

# Handoff mode: an open freeze PR occupies the "one campaign at a time" slot
# exactly like activeSha does for a manually-claimed run, but it survives
# across polls as a durable GitHub PR rather than a liveness-stamped process
# — no staleness check here. Only the ledger (completed, handled above) or the
# freeze PR's own closed state (abandoned, also handled above) ever free it.
if [ "$FREEZE_HANDOFF" = true ]; then
  HANDOFF_PR="$(jq -r '.handoffFreezePr // empty' <<<"$STATE")"
  if [ -n "$HANDOFF_PR" ]; then
    HANDOFF_TARGET="$(jq -r '.handoffTargetSha // empty' <<<"$STATE")"
    if [ "$HANDOFF_TARGET" != "$SOURCE_SHA" ]; then
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

# ── Undecided promotion hold: do not open a NEW round ─────────────────────────
#
# THE BUG THIS CLOSES. Everything above proves the build is testable. Nothing
# anywhere asked whether testing it would tell anyone something they do not
# already know. A NO_GO/HUMAN_DECISION hold names findings a human has been
# asked to rule on; while that question is open, develop keeps moving and every
# expiry of the cadence floor opened another full campaign to re-derive the same
# answer about routes the new build does not touch. On 2026-08-24/25 that ran
# four times in 24h — four HUMAN_DECISIONs, four preview pairs, sixteen browser
# lanes — and each `finish` OVERWROTE the hold, which also destroyed the runId
# the pending question was keyed to, so a human's answer no longer matched the
# file describing it.
#
# WHAT THIS DOES NOT DO. It does not touch the hold. No path below deletes,
# rewrites or expires it, and there is no timeout after which promotion
# un-gates. Promotion stays blocked until a human clears it by the two routes
# the release runbook already defines. This gates ONE thing: whether a new round
# opens.
#
# POSITION. Here, and not lower, for the reason the wake-window check states
# above: `emit_no_wake` writes STATE, so the settled candidate survives
# untouched and the first poll after a decision opens the campaign on whatever
# develop has settled on by then. It also sits ahead of the preflight, so a
# suppressed round does not pay for a 240s credential probe. And it is OUTSIDE
# the FREEZE_HANDOFF block below, so it covers the direct-campaign path too.
#
# EVERY NON-MATCHING OUTCOME IS AN EXPLICIT STOP, enumerated, not inferred:
if [ -n "$HOLD_FILE" ] && [ -n "$DECISION_LEDGER" ]; then
  # No hold, or a hold this cannot parse, both leave HOLD_RUN empty and skip the
  # guard — proceed as today. A malformed hold is not silently swallowed: the
  # hold-integrity reconciler above already alarms `gate_hold_tampered` on
  # exactly that, and a second alarm for one condition is two notifications for
  # one problem.
  HOLD_RUN=""
  if [ -s "$HOLD_FILE" ] && jq -e 'type == "object"' "$HOLD_FILE" >/dev/null 2>&1; then
    HOLD_RUN="$(jq -r '.runId // empty' "$HOLD_FILE" 2>/dev/null)"
  fi
  if [ -n "$HOLD_RUN" ]; then
    HOLD_DECISION="$(hold_decision_state "$HOLD_RUN")"
    case "$HOLD_DECISION" in
      decided)
        # Answered. Fall through — the round re-opens exactly as it always did,
        # on the normal completedSha/candidate path. No restart, nobody
        # remembering to un-pause anything.
        ;;
      unknown)
        # The ledger could not be read (unset path, missing dir, unreadable
        # file). FAIL OPEN: proceed as if this feature were not deployed. A
        # defensive stop here would be the shape that took the fleet down twice
        # on 2026-08-25 — failing closed on something unavailable where the code
        # runs. The hold still blocks promotion regardless.
        ;;
      *)
        # `undecided`, and anything a future edit might return that is not one
        # of the two above. A question is open; do not spend a campaign
        # re-asking it. Alarm on an interval rather than latching once: this
        # wake is now the ONLY thing that surfaces the pending decision, and a
        # latch that can go permanently silent is not a safety mechanism, it is
        # one shaped like one (same argument as the overrun alarm above).
        HOLD_SINCE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.holdPendingWakeAt // empty' <<<"$STATE")") ))"
        if [ "$(jq -r '.holdPendingRunId // empty' <<<"$STATE")" != "$HOLD_RUN" ] ||
           [ "$HOLD_SINCE_WAKE" -ge "$HOLD_ALERT_SECONDS" ]; then
          STATE="$(jq -c --arg r "$HOLD_RUN" --arg now "$NOW" \
            '.holdPendingRunId=$r | .holdPendingWakeAt=$now' <<<"$STATE")"
          write_state "$STATE"
          jq -cn --arg run "$HOLD_RUN" --arg sha "$(jq -r '.sha // empty' "$HOLD_FILE" 2>/dev/null)" \
            --arg verdict "$(jq -r '.verdict // empty' "$HOLD_FILE" 2>/dev/null)" \
            --arg reason "$(jq -r '.reason // empty' "$HOLD_FILE" 2>/dev/null)" \
            --arg raised "$(jq -r '.raisedAt // empty' "$HOLD_FILE" 2>/dev/null)" \
            --arg source "$SOURCE_SHA" --arg ledger "$DECISION_LEDGER" \
            --argjson age "$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.raisedAt // empty' "$HOLD_FILE" 2>/dev/null)") ))" \
            '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_hold_undecided",
              holdRunId:$run,holdSha:$sha,holdVerdict:$verdict,holdReason:$reason,
              raisedAt:$raised,pendingSeconds:$age,currentSha:$source,
              hint:("A promotion hold is waiting on a human and no campaign will open until it is answered. Promotion is blocked either way — this is about the QA loop, not the gate. Record the decision as an `override` on target `smoke_hold:" + $run + "` in " + $ledger + ".")}}'
          exit 0
        fi
        emit_no_wake "hold_undecided"
        exit 0
        ;;
    esac
  fi
fi

# Four network calls in this post-relock region DO run under the lock,
# deliberately: the freeze-PR abandonment check (`gh pr view`, above), the
# preflight command below (up to SMOKE_GATE_PREFLIGHT_TIMEOUT), the freeze
# helper, and the parent-SHA lookup. Each sits INSIDE a read-modify-write on
# STATE — throttle latches, candidate bookkeeping, the handoff slot — so
# releasing around one would mean writing back a snapshot taken before the
# release and silently clobbering a concurrent `progress` stamp. That trades a
# retryable error for a LOST liveness signal, which is the worse failure. All
# four are reached only when a campaign is actually being opened (once per
# campaign, not once per poll), and a caller that loses the wait to them gets
# the retryable `gate_lock_busy` shape, never a not-active refusal.
#
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
    # A live ack for this exact reason outranks the re-arm rules. Same silent
    # shape as the throttled branch below, including not persisting the reason:
    # the latch must keep comparing against the last reason we ALARMED on.
    if ack_silences preflight_failed "$PREFLIGHT_REASON"; then
      emit_no_wake "preflight_failed"
      exit 0
    fi
    if { [ "$PREFLIGHT_REASON" != "$LAST_REASON" ] &&
         [ "$SINCE_WAKE" -ge "$PREFLIGHT_REARM_FLOOR_SECONDS" ]; } ||
       [ "$SINCE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
      STATE="$(jq -c --arg r "$PREFLIGHT_REASON" --arg now "$NOW" \
        '.preflightReason=$r | .preflightWakeAt=$now' <<<"$STATE")"
      # This wake owes a fresh disposition — an expired or differently
      # fingerprinted one must not carry over to it.
      drop_disposition preflight_failed
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
  # inheriting a throttle window from an outage that is already repaired. The
  # disposition goes with it: a condition that cleared and came back is a new
  # incident, not the one somebody acked.
  STATE="$(jq -c '.preflightReason=null | .preflightWakeAt=null' <<<"$STATE")"
  drop_disposition preflight_failed
fi

PREVIOUS_SHA="$COMPLETED_SHA"
if [ -z "$PREVIOUS_SHA" ]; then
  PREVIOUS_SHA="$(timeout 8 gh api "repos/$REPO/commits/$SOURCE_SHA" --jq '.parents[0].sha // empty' 2>/dev/null || true)"
fi

if [ "$FREEZE_HANDOFF" = true ]; then
  # Campaign cadence floor. Polls are token-free, but every freeze becomes a
  # full campaign (coordinator + workers + challenger — measured ~$65-70 on
  # the coordinator side alone, 2026-08-13), and each campaign's findings
  # feed the fix lane, which costs more still. Removing the old wake window
  # uncapped campaigns/day; this floor re-caps them without bringing the
  # window back. Sits AFTER the settle/debounce checks and BEFORE any state
  # mark: emit_no_wake preserves the settled candidate, so the first poll
  # past the cooldown freezes whatever develop has settled on BY THEN —
  # everything that merged during the cooldown batches into one campaign
  # instead of queueing several.
  if [ "$FREEZE_MIN_INTERVAL_SECONDS" -gt 0 ]; then
    SINCE_LAST_FREEZE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.lastFreezeOpenedAt // empty' <<<"$STATE")") ))"
    if [ "$SINCE_LAST_FREEZE" -lt "$FREEZE_MIN_INTERVAL_SECONDS" ]; then
      emit_no_wake "freeze_cooldown"
      exit 0
    fi
  fi
  # This is the exact point poll would otherwise open a develop_build_settled
  # campaign. Cut a freeze PR instead and hand the campaign off — zero agent
  # tokens spent here, it is a subprocess call, not a dispatch.
  # Timed out, like every other network call in this file. The helper makes
  # five sequential GitHub calls and was the only untimed one — and it runs
  # holding the state lock, so a hung forge would have wedged the gate for as
  # long as the call hung rather than for a bounded window. Exit 124 falls
  # straight into the throttled freeze-failure alarm below.
  FREEZE_JSON="$(timeout "${SMOKE_GATE_FREEZE_HELPER_TIMEOUT:-90}" "$FREEZE_HELPER" "$SOURCE_SHA" 2>/dev/null)"
  FREEZE_RC=$?
  if [ "$FREEZE_RC" -ne 0 ] || ! jq -e 'type == "object" and has("prNumber") and has("freezeSha")' \
       <<<"$FREEZE_JSON" >/dev/null 2>&1; then
    # The helper itself failed (branch collision, PR create failure, etc).
    # Same throttle shape as preflight above: one wake per distinct reason,
    # never a re-spam, and the candidate survives untouched so the very next
    # poll retries once the underlying problem is fixed.
    FREEZE_REASON="$(jq -r '.error // empty' <<<"$FREEZE_JSON" 2>/dev/null)"
    [ -n "$FREEZE_REASON" ] || FREEZE_REASON="freeze helper exited $FREEZE_RC with no parseable output"
    # smoke-freeze-pr.sh's own "branch already exists" error already carries
    # the deterministic branch name (smoke/freeze-<sha12>) as a `branch`
    # field — surface it here too. This is the retry-after-a-lost-attempt
    # case: an earlier freeze that helper-succeeded but never got recorded in
    # our state (a crash or race between the helper call and write_state)
    # leaves an orphaned PR/branch that this later collision is the only
    # trace of; without the name, the responder has to guess it.
    FREEZE_ORPHAN_BRANCH="$(jq -r '.branch // empty' <<<"$FREEZE_JSON" 2>/dev/null)"
    LAST_FREEZE_REASON="$(jq -r '.freezeFailReason // empty' <<<"$STATE")"
    SINCE_FREEZE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.freezeFailWakeAt // empty' <<<"$STATE")") ))"
    # A live ack for this exact reason outranks the re-arm rules. This is the
    # 2026-08-25/26 case: three identical wakes 6h apart, nothing dispositioned.
    if ack_silences develop_freeze_failed "$FREEZE_REASON"; then
      emit_no_wake "develop_freeze_failed"
      exit 0
    fi
    if { [ "$FREEZE_REASON" != "$LAST_FREEZE_REASON" ] && [ "$SINCE_FREEZE_WAKE" -ge "$PREFLIGHT_REARM_FLOOR_SECONDS" ]; } ||
       [ "$SINCE_FREEZE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
      STATE="$(jq -c --arg r "$FREEZE_REASON" --arg now "$NOW" '.freezeFailReason=$r | .freezeFailWakeAt=$now' <<<"$STATE")"
      # This wake owes a fresh disposition.
      drop_disposition develop_freeze_failed
      write_state "$STATE"
      jq -cn --arg reason "$FREEZE_REASON" --arg sha "$SOURCE_SHA" --argjson rc "$FREEZE_RC" \
        --arg branch "$FREEZE_ORPHAN_BRANCH" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:"develop_freeze_failed",sourceSha:$sha,reason:$reason,exitCode:$rc,
          orphanBranch:(if $branch == "" then null else $branch end)}}'
      exit 0
    fi
    STATE="$(jq -c --arg r "$FREEZE_REASON" '.freezeFailReason=$r' <<<"$STATE")"
    emit_no_wake "develop_freeze_failed"
    exit 0
  fi
  # Success — clear the failure latch so the next failure alarms immediately
  # instead of inheriting a throttle window from an outage already repaired.
  FREEZE_PR_NUM="$(jq -r '.prNumber' <<<"$FREEZE_JSON")"
  FREEZE_SHA_OUT="$(jq -r '.freezeSha' <<<"$FREEZE_JSON")"
  STATE="$(jq -c \
    --arg sha "$SOURCE_SHA" --arg now "$NOW" --argjson pr "$FREEZE_PR_NUM" --arg freezeSha "$FREEZE_SHA_OUT" \
    '.handoffFreezePr=$pr | .handoffFreezeSha=$freezeSha | .handoffTargetSha=$sha | .handoffOpenedAt=$now |
     .lastFreezeOpenedAt=$now |
     .freezeFailReason=null | .freezeFailWakeAt=null |
     .candidateSha=null | .candidateFirstSeen=null' <<<"$STATE")"
  # Condition cleared — a later recurrence is a new incident, not the acked one.
  drop_disposition develop_freeze_failed
  write_state "$STATE"
  jq -cn \
    --arg repo "$REPO" --arg branch "$BRANCH" --arg sha "$SOURCE_SHA" --arg previous "$PREVIOUS_SHA" \
    --argjson pr "$FREEZE_PR_NUM" --arg freezeSha "$FREEZE_SHA_OUT" \
    '{wakeAgent:false,data:{
      schemaVersion:1, trigger:"develop_freeze_opened",
      repo:$repo, branch:$branch, sourceSha:$sha,
      previousCompletedSha:(if $previous == "" then null else $previous end),
      freezePr:$pr, freezeSha:$freezeSha, targetSha:$sha
    }}'
  exit 0
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
