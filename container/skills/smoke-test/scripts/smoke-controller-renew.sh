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
# WHEN IT RENEWS -- all five must hold, per run:
#   1. the journal's newest record for an `owner` obligation is `enqueued`
#      (not `done`, `abandoned`, `failed_terminal`, and not a bare `intent`);
#   2. the owner acked that brief -- <run>/controller/brief-<step>.ack exists.
#      The ack is the owner router's first act (controller-owner-router.md:31),
#      so it is what says the step was taken at all. No ack, no renewal;
#   3. the coordinator side of the run has been WRITTEN TO recently -- see
#      FRESHNESS below. The ack answers "was this step taken"; it cannot
#      answer "is anyone still working it";
#   4. the run's `run/claim` obligation is still open and carries the owner
#      token the controller claimed with;
#   5. the step is younger than the CEILING.
#
# FRESHNESS. The ack is written ONCE and never again: the router creates it
# (controller-owner-router.md:31), the controller only ever tests it for
# existence (smoke-campaign-controller.py:1966) and re-offers the wake only
# while it is ABSENT (:1961-1972), and a step that needs more than one turn
# continues through `continue_work` (router :43), which resumes in-session and
# does not re-run the router's first act. Nothing in this repo refreshes or
# removes it. So its mtime is the time of the FIRST wake, and treating that as
# a liveness signal would have stopped renewing PR #2022's `lanes` step at
# 06:41:06Z -- five minutes AFTER the 06:35:49Z expiry this script exists to
# prevent. (Run …-20260920T052052Z: one `brief-lanes.ack` at 06:21:06Z for a
# step that ran to ~07:08Z. `brief-intake.ack` has three mtimes only because
# that morning a human withdrew it twice by hand; that is not a mechanism.)
#
# What a live owner DOES refresh is the run tree: it writes its artifacts
# there continuously. Freshness is therefore
#   max(ack mtime, newest mtime under <run>/ EXCLUDING <run>/challenger/)
# against RENEW_FRESHNESS_SECONDS (1200 s). Measured on that same step: 507
# writes over 46 minutes, largest gap between writes 253 s (next 153, 126,
# 123). 1200 s clears the worst real gap by 4.7x -- anyone tightening this
# window needs that number, because below ~300 s it starts cutting into
# ordinary owner think-time.
#
# <run>/challenger/ is EXCLUDED on purpose. The challenger is the other side
# of the campaign, in its own session with its own lifetime, and the lease
# being renewed here is the COORDINATOR's. A healthy challenger writing its
# disposition says nothing about whether the coordinator's owner is alive, and
# counting it would let a live challenger hold a dead owner's claim open for
# the full ceiling -- the same defect this freshness check exists to close,
# arriving from a different directory.
#
# A scan that cannot complete can only make the tree look OLDER (a truncated
# `find` sees fewer files, so its maximum can only fall), so every scan
# failure degrades to "not fresh" -> no renewal. That is the safe direction,
# and the reason is recorded in the tick's own line rather than swallowed.
#
# THE CEILING is OWNER_STEP_SLA_SECONDS (3600 s,
# smoke-campaign-controller.py:131), measured from the obligation's FIRST
# journal record -- the same clock the controller uses to call a step overdue
# and escalate (owner_step:1975-1987). Past it this tick stops renewing, the
# lease lapses within its remaining TTL, and the existing overdue/escalation
# and `pr_run_stalled` paths take over untouched. A lease that renews forever
# would be a worse defect than the one this fixes, so the overrides
# SMOKE_CONTROLLER_RENEW_CEILING_SECONDS and
# SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS can only clamp DOWN.
#
# THE ACTUAL BOUND, stated plainly: renewal continues while the owner is
# still writing under the run. After the owner dies it stops within one
# freshness window (<= 1200 s), or sooner if the controller reconciles the
# step first -- whichever comes first -- and in the worst case the ceiling
# stops it at 3600 s from the step's first journal record. It does NOT stop
# instantly, and nothing here should be read as claiming that it does.
#
# DEGRADATION. Every failure path here renews nothing: no env file, kill
# switch off, a journal that is missing, unreadable or holds one corrupt
# record, missing jq, an unreadable run tree, a refused gate call. "Renew
# nothing" is exactly today's behaviour -- the claim expires on its own TTL.
# There is no path on which this script makes a run look alive while nothing
# is working it, because the only thing it can do is forward a liveness stamp
# for a step the journal says is enqueued, the ack file says was taken, and
# the coordinator side of the run tree says is still being written to.
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
FRESHNESS_MAX=1200        # 4.7x the largest measured gap between owner writes
GATE_CALL_TIMEOUT=20      # same budget the live fire gives one `progress`
SCAN_TIMEOUT=10           # a run tree is thousands of files; bound the walk
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
# Same rule as the live wrapper (smoke-controller-live-worker.py, load_config):
# the gate env file is configuration, not code, so it is never sourced here.
# Only `[export] NAME='literal'` and `unset NAME` lines are read, and the file
# overrides the process env.
#
# THE ENV FILE IS THE LIST OF KEYS, WITHIN ONE NAMESPACE. This tick used to
# read a hardcoded four, which is the XZO #2047 shape: a list of names owned by
# a DIFFERENT file goes stale the moment the install adds one, silently. It now
# reads every `SMOKE_*` name the file mentions, so a new SMOKE_ key works with
# no change here.
#
# The prefix is the scope, and it is not a list that can drift -- it is the
# namespace the install's configuration owns (verified: every key in the
# deployed env files is SMOKE_*, and the whole skill's env vocabulary is
# SMOKE_*). Everything else -- PATH, LD_PRELOAD, PYTHONPATH, BASH_ENV,
# BUN_OPTIONS (`--preload` runs a module before Bun's main script) -- is simply
# not this file's configuration and is IGNORED, exactly as it was before
# XZO #2047. not_config() below is only for the dangerous SMOKE_ names.
ENV_FILE="${SMOKE_CONTROLLER_ENV_FILE:-/workspace/agent/smoke-gate-env.sh}"
CONFIG_PREFIX=SMOKE_
not_config() { # <name> -- 0 when a SMOKE_ name still must not come from the file
  case "$1" in
    # This tick's own seam, and the one name that is authority rather than
    # configuration (refused outright just below, before this loop runs).
    SMOKE_CONTROLLER_ENV_FILE|SMOKE_GATE_CLAIMANT) return 0 ;;
  esac
  return 1
}
# Every name the file assigns or unsets, first mention first, deduplicated.
env_names() {
  [ -f "$ENV_FILE" ] || return 0
  {
    sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*$/\2/p' "$ENV_FILE"
    sed -n -E 's/^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_[:space:]]*)$/\1/p' "$ENV_FILE" | tr -s '[:space:]' '\n'
  } 2>/dev/null | awk 'NF && !seen[$0]++'
}
env_value() { # <key> -- "=<value>" for the last accepted literal, else empty.
  # The "=" prefix is what distinguishes an EMPTY literal (`FOO=`, which is a
  # value) from "no literal assignment at all" (which is a refusal below).
  [ -f "$ENV_FILE" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1=('([^']*)'|\"([^\"\$\`\\\\]*)\"|([^[:space:]'\"\$\`\\\\;&|<>()]*))[[:space:]]*(#.*)?\$/=\3\4\5/p" \
    "$ENV_FILE" 2>/dev/null | tail -n 1
}
ACTIVE_ENV=""
if [ -f "$ENV_FILE" ]; then
  ACTIVE_ENV="$(sed '/^[[:space:]]*#/d' "$ENV_FILE" 2>/dev/null)"
fi
if [[ "$ACTIVE_ENV" =~ (^|[^A-Za-z0-9_])SMOKE_GATE_CLAIMANT([^A-Za-z0-9_]|$) ]]; then
  # The gate wrapper sources this file for every caller, so a claimant in it
  # would override the one this tick passes per call -- and would stamp the
  # legacy coordinator's calls as the controller's. Same refusal as the live
  # worker (smoke-controller-live-worker.py, the SMOKE_GATE_CLAIMANT branch of
  # load_config and the end_fire it feeds).
  # The wrapper SOURCES this file, so shell forms beyond env_names() can
  # override authority too (readonly, export with multiple names, unset -v).
  # Ignore only full comment lines; stripping inline '#' would misread quotes.
  # Conservative refusal of remaining mentions preserves the old guard.
  final misconfigured "the env file assigns SMOKE_GATE_CLAIMANT; nothing renewed"
fi
# CONFIG NEVER TOUCHES THIS SHELL'S OWN VARIABLES. It is collected into a map
# that becomes the GATE CALL's environment and nothing else. `export
# "$key=$value"` here would let the env file rename this script's internals --
# the ceiling, the clock, the journal path -- which no deny list can fix in
# general, because those names are OURS and may change at any time. Observed
# (Codex review, PR #968): CEILING_MAX=9999 in the file disabled the renewal
# ceiling, and `unset NOW` made the tick exit with no JSON at all, breaking the
# final-line contract.
declare -A CFG_SET=()     # SMOKE_ name -> the literal value the file assigns
declare -A CFG_UNSET=()   # SMOKE_ name -> set when the file unsets it
for key in $(env_names); do
  case "$key" in "$CONFIG_PREFIX"*) ;; *) continue ;; esac
  not_config "$key" && continue
  if grep -Eq "^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)*$key([[:space:]]|\$)" "$ENV_FILE" 2>/dev/null; then
    CFG_UNSET[$key]=1
    continue
  fi
  value="$(env_value "$key")"
  if [ -n "$value" ]; then
    CFG_SET[$key]="${value#=}"
  else
    # Assigned, but not to a literal this reader accepts. Falling back to the
    # process env would run under configuration the operator did not write.
    # Only SMOKE_ names reach here, so an ordinary line the file happens to
    # carry (EXTRA="$HOME/cache") is ignored, as it always was.
    final misconfigured "the env file assigns a non-literal value to $key; nothing renewed"
  fi
done
# The effective value of one config name, for this tick's OWN decisions: the
# file's, else the process env's, and empty when the file unsets it. Reads
# only -- it assigns nothing.
cfg() { # <name>
  local n="$1"
  [ -z "${CFG_UNSET[$n]:-}" ] || return 0
  if [ -n "${CFG_SET[$n]+x}" ]; then printf '%s' "${CFG_SET[$n]}"; return 0; fi
  printf '%s' "${!n-}"
}
# The gate call's environment: this process's, with the file's config applied
# on top. Built once, passed explicitly, never exported here.
GATE_ENV=(env)
[ "${#CFG_UNSET[@]}" -eq 0 ] || for n in "${!CFG_UNSET[@]}"; do GATE_ENV+=(-u "$n"); done
[ "${#CFG_SET[@]}" -eq 0 ] || for n in "${!CFG_SET[@]}"; do GATE_ENV+=("$n=${CFG_SET[$n]}"); done

MODE="$(cfg SMOKE_CONTROLLER_MODE)"; MODE="${MODE:-shadow}"
[ "$MODE" = live ] || final not-live "SMOKE_CONTROLLER_MODE is '$MODE', not live: this tick does nothing"

RUN_ROOT="$(cfg SMOKE_GATE_RUN_ROOT)"
[ -n "$RUN_ROOT" ] || final misconfigured "SMOKE_GATE_RUN_ROOT is unset"
GATE_CMD="$(cfg SMOKE_CONTROLLER_GATE_CMD)"; GATE_CMD="${GATE_CMD:-/workspace/agent/smoke-pr-gate.sh}"
[ -f "$GATE_CMD" ] || final misconfigured "gate wrapper $GATE_CMD is not a file"
# Same derivation as the live worker (smoke-controller-live-worker.py:329-330).
OUT="$(cfg SMOKE_CONTROLLER_OUT_DIR)"; OUT="${OUT:-$(dirname "${RUN_ROOT%/}")/controller}"
JOURNAL="$OUT/journal.ndjson"
[ -f "$JOURNAL" ] || final no-journal "no controller journal at $JOURNAL"

# Both windows clamp DOWN only. An out-of-range override is ignored, never
# honoured upward: these two numbers are the whole safety property.
clamp_down() { # <target-var> <env-value> <max>
  local raw="$2" max="$3"
  printf -v "$1" '%s' "$max"
  [ -n "$raw" ] || return 0
  if [[ "$raw" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$raw" -le "$max" ]; then
    printf -v "$1" '%s' "$raw"
  fi
}
clamp_down CEILING "${SMOKE_CONTROLLER_RENEW_CEILING_SECONDS:-}" "$CEILING_MAX"
clamp_down FRESHNESS "${SMOKE_CONTROLLER_RENEW_FRESHNESS_SECONDS:-}" "$FRESHNESS_MAX"

# -- which runs have an owner step genuinely in flight ------------------------
# Read-only fold of the append-only journal, no lock: the controller appends
# whole records with one write under its own lock and this tick writes
# nothing, so the only damage a concurrent append can do is leave the LAST
# line UNTERMINATED. That is the only line this tick may drop, and only when
# the file does not end in a newline — a newline-terminated line that does not
# parse is complete corruption, not an interrupted append, and it refuses the
# whole tick. So does any record that fails the schema check below. A journal
# we cannot read in full is not evidence that a step is held, and the refusal
# is recorded in the tick's own line.
#
# Does the file end in a newline? `$(...)` strips trailing newlines, so an
# empty capture of the last byte means the last byte WAS one (or the file is
# empty); anything else means the final line is torn.
JOURNAL_TORN_TAIL=0
[ -n "$(tail -c 1 -- "$JOURNAL" 2>/dev/null)" ] && JOURNAL_TORN_TAIL=1

JQ_ERR="$(mktemp "${TMPDIR:-/tmp}/smoke-renew-jq.XXXXXX" 2>/dev/null)" || JQ_ERR=/dev/null
trap 'rm -f -- "$JQ_ERR" 2>/dev/null || true' EXIT

# jq 1.6 date parsing is affected by DST in the process timezone. Journal
# timestamps are UTC; localize the correction to this reader, not gate calls.
CANDIDATES="$(TZ=UTC jq -cRn --argjson now "$NOW_EPOCH" --argjson torn "$JOURNAL_TORN_TAIL" '
  # The controller records exactly these states for the two kinds this tick
  # reads (smoke-campaign-controller.py record() call sites for kind "run" and
  # kind "owner"). Anything else is a journal this tick does not understand,
  # and an ununderstood state must never be read as "the claim is open".
  def known_states: ["intent","enqueued","done","abandoned","failed_terminal"];
  def str($f): ($f | type) == "string" and ($f | length) > 0;
  def check($ln):
    if (str(.key) and str(.at) and str(.runId) and str(.kind) and str(.slot) and str(.state)) | not
      then error("journal line \($ln): record is missing a required field")
    elif (has("detail") and (.detail | type) != "object")
      then error("journal line \($ln): detail is not an object")
    # `.state` has to be bound first: inside index() the input is the array.
    elif ((.kind == "run" or .kind == "owner") and (.state as $s | known_states | index($s)) == null)
      then error("journal line \($ln): unknown \(.kind) state")
    else . end;
  [inputs] as $raw
  | ($raw | length) as $n
  | [ $raw
      | to_entries[]
      | select(.value | test("^[[:space:]]*$") | not)
      | . as $e
      | (try ($e.value | fromjson) catch null) as $rec
      | if ($rec | type) == "object" then ($rec | check($e.key + 1))
        elif $torn == 1 and $e.key == $n - 1 then empty
        else error("journal line \($e.key + 1) is not a JSON object")
        end ] as $recs
  | (reduce $recs[] as $r ({};
      .[$r.key] = {
        runId: $r.runId, kind: $r.kind, slot: $r.slot, state: $r.state,
        firstAt: (.[$r.key].firstAt // $r.at),
        detail: ((.[$r.key].detail // {}) + ($r.detail // {}))
      })) as $obs
  # An OPEN claim is named positively. "not done and not abandoned" admitted
  # every state the schema check has not seen, which is the wrong default for
  # the one field that decides whether a run may be renewed at all.
  | ([ $obs[]
       | select(.kind == "run" and .slot == "claim"
                and (.state == "intent" or .state == "enqueued"))
       | {key: .runId, value: (.detail.ownerToken // "")} ] | from_entries) as $tokens
  | [ $obs[]
      | select(.kind == "owner" and .state == "enqueued")
      | {runId: .runId, step: .slot, token: ($tokens[.runId] // ""),
         age: (try ($now - (.firstAt | fromdateiso8601)) catch null)} ]
  | .[]' <"$JOURNAL" 2>"$JQ_ERR")" || \
  final journal-unreadable \
    "the controller journal could not be folded; nothing renewed: $(tr -d '\000' <"$JQ_ERR" 2>/dev/null | tail -n 1 | cut -c1-200)"

[ -n "$CANDIDATES" ] || final idle "no owner step is enqueued"

# -- renew, one gate call per in-flight step ----------------------------------
note() { # <runId> <step> <reason>
  RESULT_SKIPPED="$(jq -c --arg r "$1" --arg s "$2" --arg why "$3" \
    '. + [{runId:$r,step:$s,reason:$why}]' <<<"$RESULT_SKIPPED")"
}

# Newest mtime under the run, in epoch seconds, EXCLUDING <run>/challenger/ --
# the other side of the campaign, whose liveness is not the coordinator's.
# Prints 0 when it cannot answer, which the caller reads as "not fresh": a
# truncated or failed walk can only lower the maximum, so every failure of
# this function errs toward not renewing.
coordinator_activity_epoch() { # <run-dir>
  local dir="$1"
  [ -d "$dir" ] || { printf '0'; return 0; }
  # `-type f` on purpose: a directory's mtime moves when an entry is added or
  # removed in it, so counting directories would let the one-time `mkdir` of
  # <run>/challenger/ bump <run>'s own mtime and defeat the prune. A write is
  # a file; a directory timestamp is a side effect of one.
  timeout -k 2 "$SCAN_TIMEOUT" \
    find "$dir" -path "$dir/challenger" -prune -o -type f -printf '%T@\n' 2>/dev/null |
    awk 'BEGIN { m = 0 } { v = $1 + 0; if (v > m) m = v } END { printf "%d", m }'
}

RENEWALS=0
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  RUN_ID="$(jq -r '.runId // ""' <<<"$candidate")"
  STEP="$(jq -r '.step // ""' <<<"$candidate")"
  TOKEN="$(jq -r '.token // ""' <<<"$candidate")"
  AGE="$(jq -r '.age // "null"' <<<"$candidate")"

  # Charset-checked before either value reaches a path or the gate. This is
  # the gate's own rule, `..` rejection included (smoke-pr-gate.sh:202,
  # run_id_ok): the charset alone admits `..`, which is a legal run id by
  # charset and a directory escape as a path component — the ack lookup below
  # builds a path out of it. The step is a controller slot. Anything else is
  # refused by name rather than sanitized.
  if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,200}$ ]] || [ "$RUN_ID" = ".." ] ||
     ! [[ "$STEP" =~ ^[a-z][a-z0-9-]{0,40}$ ]]; then
    note "$RUN_ID" "$STEP" "refused: run id or step is not well formed"
    continue
  fi
  if [ -z "$TOKEN" ]; then
    note "$RUN_ID" "$STEP" "no open claim with an owner token for this run"
    continue
  fi
  ACK="$RUN_ROOT/$RUN_ID/controller/brief-$STEP.ack"
  if [ ! -f "$ACK" ]; then
    # Brief written but not acked, or the ack removed to hand the step back.
    # Either way the step was never taken, so it gets no liveness.
    note "$RUN_ID" "$STEP" "brief-$STEP.ack absent: no owner turn holds this step"
    continue
  fi
  # The ack says the step was TAKEN; only the run tree says it is still being
  # WORKED. See FRESHNESS in the header for why the ack's own mtime cannot
  # answer the second question and what 1200 s was measured against.
  ACK_AT="$(stat -c %Y -- "$ACK" 2>/dev/null || printf '0')"
  ACTIVITY_AT="$(coordinator_activity_epoch "$RUN_ROOT/$RUN_ID")"
  [[ "$ACK_AT" =~ ^[0-9]+$ ]] || ACK_AT=0
  [[ "$ACTIVITY_AT" =~ ^[0-9]+$ ]] || ACTIVITY_AT=0
  NEWEST="$ACK_AT"
  [ "$ACTIVITY_AT" -gt "$NEWEST" ] && NEWEST="$ACTIVITY_AT"
  if [ "$NEWEST" -le 0 ]; then
    note "$RUN_ID" "$STEP" "could not read the run's coordinator-side activity; not renewed"
    continue
  fi
  QUIET=$((NOW_EPOCH - NEWEST))
  if [ "$QUIET" -gt "$FRESHNESS" ]; then
    # Nothing coordinator-side has been written for a whole window. The owner
    # is finished or gone; the controller's overdue path owns it from here.
    note "$RUN_ID" "$STEP" \
      "no coordinator-side write for ${QUIET}s (window ${FRESHNESS}s); the owner is not working this step"
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

  # GATE_ENV carries the file's config into the CHILD only; the claimant and
  # the lock wait are this tick's, applied after it (env takes NAME=value
  # arguments left to right, and neither name can be in the map -- the
  # claimant is refused outright above).
  GATE_OUT="$("${GATE_ENV[@]}" SMOKE_GATE_CLAIMANT=controller \
    SMOKE_GATE_LOCK_WAIT_SECONDS="${SMOKE_GATE_LOCK_WAIT_SECONDS:-2}" \
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
