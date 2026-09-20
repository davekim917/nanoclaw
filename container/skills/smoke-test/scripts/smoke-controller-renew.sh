#!/usr/bin/env bash
# Task-script: one tick of the claim RENEWER for the live PR smoke-campaign
# controller. It is its own scheduled series, script-only, and it never wakes
# an agent -- the last stdout line is always {"wakeAgent":false,"data":{...}}.
#
#   ncl tasks create --name smoke-controller-renew \
#     --recurrence '*/5 * * * *' \
#     --script 'bash /app/skills/smoke-test/scripts/smoke-controller-renew.sh' \
#     --prompt 'Never runs: this series gates every fire.'
#
# WHY IT EXISTS
# -------------
# A claimed run's liveness used to depend on the controller firing. The gate's
# shared coordinator lease is 900 s (smoke-pr-gate.sh:220,
# LEASE_TTL_SECONDS) and its only stamp is `progress`, which the live wrapper
# issues once per fire (smoke-controller-live-worker.py:601-610). But:
#
#   * the controller cannot fire while an owner turn is running. A series
#     arms its next occurrence only when the current one is resolved
#     (src/modules/scheduling/recurrence.ts:1-11), so a 10-minute series with
#     a 50-minute owner turn fires once in 50 minutes; and
#   * the owner may not stamp it itself. `progress` is claimant-guarded
#     (smoke-pr-gate.sh:3489 -> claimant_guard:1336) and the owner calls the
#     gate as the legacy coordinator, so it is refused `claimantMismatch`
#     (references/controller-owner-router.md:113-115).
#
# So any judgment step longer than 900 s dropped the lease under itself: on
# run xzo-pr-pr2022-...-20260920T052052Z the lanes step went `enqueued` at
# 06:20:47Z, the lease lapsed at 06:35:49Z, four lane markers were refused by
# smoke-run-scaffold.sh, a recovery poll rebound the lease to a fresh token,
# and the run finished BLOCKED (XZO #2024).
#
# This tick closes that hole from OUTSIDE both clocks: its own series, its own
# session (one session per series -- src/session-manager.ts:428-433), so
# neither the owner's turn nor the controller's cadence can hold it up.
#
# WHAT IT MAY DO, AND NOTHING ELSE
# --------------------------------
# One verb: `smoke-pr-gate.sh progress <runId> <ownerToken>` as the
# controller. `progress` renews the lease AND stamps `activeProgressAt`
# (smoke-pr-gate.sh:3495-3502); the second half matters, because a lease kept
# live while `activeProgressAt` went stale is exactly the state in which the
# next `poll` reclaims the run under a fresh token (active_run_is_live:1491,
# PROGRESS_STALE_SECONDS:68) -- the `recovery_owner_token_mismatch` wedge that
# followed the same run at 07:15Z. It never claims, never finishes, never
# posts, never writes the journal, never writes a run artifact, never writes
# `activeRunId`/`activeLeaseOwner`/`activeClaimant`. It reads the controller's
# journal and the briefs' ack files; the gate owns every write.
#
# WHEN IT RENEWS -- all four must hold, per run:
#   1. the journal's newest record for an `owner` obligation is `enqueued`
#      (not `done`, `abandoned`, `failed_terminal`, and not a bare `intent`);
#   2. the owner acked that brief -- <run>/controller/brief-<step>.ack exists.
#      The ack is the owner router's first act (controller-owner-router.md:31)
#      and the owner WITHDRAWS it to hand the step back, so it is the only
#      evidence on disk that a turn is actually holding the step. No ack, no
#      renewal: an un-acked brief is a run nobody is working;
#   3. the run's `run/claim` obligation is still open and carries the owner
#      token the controller claimed with;
#   4. the step is younger than the CEILING.
#
# THE CEILING is OWNER_STEP_SLA_SECONDS (3600 s,
# smoke-campaign-controller.py:131), measured from the obligation's FIRST
# journal record -- the same clock the controller uses to call a step overdue
# and escalate (owner_step:1975-1987). Past it this tick stops renewing, the
# lease lapses within its remaining TTL, and the existing overdue/escalation
# and `pr_run_stalled` paths take over untouched. A lease that renews forever
# would be a worse defect than the one this fixes, so the override
# SMOKE_CONTROLLER_RENEW_CEILING_SECONDS can only clamp the ceiling DOWN.
#
# DEGRADATION. Every failure path here renews nothing: no env file, kill
# switch off, missing/unreadable/torn journal, missing jq, a refused gate
# call. "Renew nothing" is exactly today's behaviour -- the claim expires on
# its own TTL. There is no path on which this script makes a run look alive
# while nothing is working it, because the only thing it can do is forward a
# liveness stamp for a step the journal and the ack file both say is held.
#
# CONCURRENCY. It takes no lock of its own. The gate's `progress` takes that
# PR's lock for the length of one small write; a fire that meets it waits
# milliseconds. In the other direction this tick waits only briefly for a lock
# a fire holds (SMOKE_GATE_LOCK_WAIT_SECONDS below) and then gives up until
# the next tick, so it can never stall a fire behind itself.
set -uo pipefail
exec 3>&1 1>&2

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
[ -n "$NOW" ] || NOW="$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T' -1)"
NOW_EPOCH="$(date -u +%s 2>/dev/null)" || NOW_EPOCH=0

CEILING_MAX=3600          # = OWNER_STEP_SLA_SECONDS; the override clamps DOWN only
GATE_CALL_TIMEOUT=20      # same budget the live fire gives one `progress`
MAX_RENEWALS=16           # a tick is bounded even if the journal is huge

RESULT_RENEWED='[]'
RESULT_SKIPPED='[]'

final() { # <status> <detail-or-empty>
  local status="$1" detail="${2:-}"
  if ! jq -cn --arg tick "$NOW" --arg status "$status" --arg detail "$detail" \
      --argjson renewed "$RESULT_RENEWED" --argjson skipped "$RESULT_SKIPPED" \
      '{wakeAgent:false,data:({tick:$tick,status:$status,renewed:$renewed,skipped:$skipped}
        + (if $detail == "" then {} else {detail:$detail} end))}' >&3 2>/dev/null; then
    # No jq, or jq refused. Still a well-formed, never-waking line.
    printf '{"wakeAgent":false,"data":{"tick":"%s","status":"unrenderable"}}\n' "$NOW" >&3
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || final no-jq "jq is unavailable; nothing renewed"

# -- configuration, read as DATA ---------------------------------------------
# Same rule as the live wrapper (smoke-controller-live-worker.py:249-284): the
# gate env file is configuration, not code, so it is never sourced here. Only
# `[export] NAME='literal'` lines for the four keys this tick needs are read,
# and the file overrides the process env. SMOKE_GATE_CLAIMANT is never taken
# from it -- the gate wrapper sources that file for every caller, so a
# claimant there would stamp the legacy coordinator's calls as the
# controller's; this tick sets it per call instead.
ENV_FILE="${SMOKE_CONTROLLER_ENV_FILE:-/workspace/agent/smoke-gate-env.sh}"
env_value() { # <key> -- last literal assignment in the env file, or empty
  [ -f "$ENV_FILE" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1=('([^']*)'|\"([^\"\$\`\\\\]*)\"|([^[:space:]'\"\$\`\\\\;&|<>()]*))[[:space:]]*(#.*)?\$/\3\4\5/p" \
    "$ENV_FILE" 2>/dev/null | tail -n 1
}
if [ -f "$ENV_FILE" ] && grep -Eq '\bSMOKE_GATE_CLAIMANT\b' "$ENV_FILE" 2>/dev/null; then
  # The gate wrapper sources this file for every caller, so a claimant in it
  # would override the one this tick passes per call -- and would stamp the
  # legacy coordinator's calls as the controller's. Same refusal as the live
  # worker (smoke-controller-live-worker.py:307-311).
  final misconfigured "the env file names SMOKE_GATE_CLAIMANT; nothing renewed"
fi
for key in SMOKE_CONTROLLER_MODE SMOKE_CONTROLLER_OUT_DIR SMOKE_CONTROLLER_GATE_CMD SMOKE_GATE_RUN_ROOT; do
  if [ -f "$ENV_FILE" ] && grep -Eq "^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)*$key([[:space:]]|\$)" "$ENV_FILE" 2>/dev/null; then
    unset "$key"
    continue
  fi
  value="$(env_value "$key")"
  if [ -n "$value" ]; then
    export "$key=$value"
  elif [ -f "$ENV_FILE" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$key=" "$ENV_FILE" 2>/dev/null; then
    # Assigned, but not to a literal this reader accepts. Falling back to the
    # process env would run under configuration the operator did not write.
    final misconfigured "the env file assigns a non-literal value to $key; nothing renewed"
  fi
done

MODE="${SMOKE_CONTROLLER_MODE:-shadow}"
[ "$MODE" = live ] || final not-live "SMOKE_CONTROLLER_MODE is '$MODE', not live: this tick does nothing"

RUN_ROOT="${SMOKE_GATE_RUN_ROOT:-}"
[ -n "$RUN_ROOT" ] || final misconfigured "SMOKE_GATE_RUN_ROOT is unset"
GATE_CMD="${SMOKE_CONTROLLER_GATE_CMD:-/workspace/agent/smoke-pr-gate.sh}"
[ -f "$GATE_CMD" ] || final misconfigured "gate wrapper $GATE_CMD is not a file"
# Same derivation as the live worker (smoke-controller-live-worker.py:329-330).
OUT="${SMOKE_CONTROLLER_OUT_DIR:-$(dirname "${RUN_ROOT%/}")/controller}"
JOURNAL="$OUT/journal.ndjson"
[ -f "$JOURNAL" ] || final no-journal "no controller journal at $JOURNAL"

CEILING="$CEILING_MAX"
RAW_CEILING="${SMOKE_CONTROLLER_RENEW_CEILING_SECONDS:-}"
if [ -n "$RAW_CEILING" ]; then
  if [[ "$RAW_CEILING" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$RAW_CEILING" -le "$CEILING_MAX" ]; then
    CEILING="$RAW_CEILING"
  fi
  # An out-of-range override is ignored, never honoured upward: the ceiling is
  # the whole safety property.
fi

# -- which runs have an owner step genuinely in flight ------------------------
# Read-only fold of the append-only journal, no lock: the controller appends
# whole records under its own lock and this tick writes nothing, so the worst
# a concurrent append can do is leave a torn LAST line. That one is dropped;
# an unparseable line ANYWHERE ELSE refuses the whole tick (nothing renewed),
# because a journal we cannot read is not evidence that a step is held.
CANDIDATES="$(jq -cRn --argjson now "$NOW_EPOCH" '
  [inputs] as $raw
  | ($raw | length) as $n
  | [ $raw
      | to_entries[]
      | select(.value | test("^[[:space:]]*$") | not)
      | . as $e
      | (try ($e.value | fromjson) catch null) as $rec
      | if ($rec | type) == "object" then $rec
        elif $e.key == $n - 1 then empty
        else error("journal line \($e.key + 1) is not a JSON object")
        end ] as $recs
  | (reduce $recs[] as $r ({};
      .[$r.key] = {
        runId: $r.runId, kind: $r.kind, slot: $r.slot, state: $r.state,
        firstAt: (.[$r.key].firstAt // $r.at),
        detail: ((.[$r.key].detail // {}) + ($r.detail // {}))
      })) as $obs
  | ([ $obs[]
       | select(.kind == "run" and .slot == "claim"
                and (.state == "done" or .state == "abandoned" | not))
       | {key: .runId, value: (.detail.ownerToken // "")} ] | from_entries) as $tokens
  | [ $obs[]
      | select(.kind == "owner" and .state == "enqueued")
      | {runId: .runId, step: .slot, token: ($tokens[.runId] // ""),
         age: (try ($now - (.firstAt | fromdateiso8601)) catch null)} ]
  | .[]' <"$JOURNAL" 2>/dev/null)" || \
  final journal-unreadable "the controller journal could not be folded; nothing renewed"

[ -n "$CANDIDATES" ] || final idle "no owner step is enqueued"

# -- renew, one gate call per in-flight step ----------------------------------
note() { # <runId> <step> <reason>
  RESULT_SKIPPED="$(jq -c --arg r "$1" --arg s "$2" --arg why "$3" \
    '. + [{runId:$r,step:$s,reason:$why}]' <<<"$RESULT_SKIPPED")"
}

RENEWALS=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  RUN_ID="$(jq -r '.runId // ""' <<<"$candidate")"
  STEP="$(jq -r '.step // ""' <<<"$candidate")"
  TOKEN="$(jq -r '.token // ""' <<<"$candidate")"
  AGE="$(jq -r '.age // "null"' <<<"$candidate")"

  # Charset-checked before either value reaches a path or the gate: the run id
  # is the gate's own (smoke-pr-gate.sh run_id_ok) and the step is a
  # controller slot. Anything else is refused rather than sanitized.
  if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,200}$ ]] || ! [[ "$STEP" =~ ^[a-z][a-z0-9-]{0,40}$ ]]; then
    note "$RUN_ID" "$STEP" "refused: run id or step is not well formed"
    continue
  fi
  if [ -z "$TOKEN" ]; then
    note "$RUN_ID" "$STEP" "no open claim with an owner token for this run"
    continue
  fi
  if [ ! -f "$RUN_ROOT/$RUN_ID/controller/brief-$STEP.ack" ]; then
    # Brief written but not acked, or the ack withdrawn to hand the step back.
    # Either way no turn is holding it, so it gets no liveness.
    note "$RUN_ID" "$STEP" "brief-$STEP.ack absent: no owner turn holds this step"
    continue
  fi
  if [ "$AGE" = null ] || ! [[ "$AGE" =~ ^-?[0-9]+$ ]] || [ "$AGE" -lt 0 ]; then
    note "$RUN_ID" "$STEP" "step start time is unusable; not renewed"
    continue
  fi
  if [ "$AGE" -gt "$CEILING" ]; then
    note "$RUN_ID" "$STEP" "past the ${CEILING}s ceiling (${AGE}s); the overdue path owns it now"
    continue
  fi
  if [ "$RENEWALS" -ge "$MAX_RENEWALS" ]; then
    note "$RUN_ID" "$STEP" "tick renewal cap ($MAX_RENEWALS) reached"
    continue
  fi

  GATE_OUT="$(SMOKE_GATE_CLAIMANT=controller SMOKE_GATE_LOCK_WAIT_SECONDS="${SMOKE_GATE_LOCK_WAIT_SECONDS:-2}" \
    timeout -k 2 "$GATE_CALL_TIMEOUT" bash "$GATE_CMD" progress "$RUN_ID" "$TOKEN" 2>/dev/null | tail -n 1)"
  # `.ok // true` would be wrong twice over: jq's `//` treats a literal false
  # as empty, and a missing `ok` is not a success.
  if [ "$(jq -r 'if type == "object" and .ok == true then "yes" else "no" end' \
      <<<"${GATE_OUT:-{}}" 2>/dev/null)" = yes ]; then
    RENEWALS=$((RENEWALS + 1))
    RESULT_RENEWED="$(jq -c --arg r "$RUN_ID" --arg s "$STEP" --argjson age "$AGE" \
      '. + [{runId:$r,step:$s,ageSeconds:$age}]' <<<"$RESULT_RENEWED")"
  else
    # A refusal is the gate holding its own line (the run was reclaimed or
    # finished, the token retired, the lock busy). Recorded, never retried in
    # a loop, never worked around.
    note "$RUN_ID" "$STEP" \
      "gate refused progress: $(jq -r 'if type == "object" then (.error // "no result") else "no result" end' \
        <<<"${GATE_OUT:-{}}" 2>/dev/null | cut -c1-160)"
  fi
done <<<"$CANDIDATES"

final ok ""
