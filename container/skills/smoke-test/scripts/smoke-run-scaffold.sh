#!/usr/bin/env bash
# Write the run's completion contract and lane markers, so their shape cannot
# drift away from what smoke-evidence-barrier.sh validates.
#
# Freehand artifacts are why the barrier silently failed open: on the
# 2026-08-07 marketing campaign the contract carried `lanes[]`/`markerDir`
# while the barrier required `requiredLaneMarkers[]`, and markers carried
# `finishedAt` with no `sourceSha`. The barrier could only ever return
# ready:false, so the run proceeded on prose self-discipline while reporting a
# barrier-governed posture it did not have. A gate whose failure mode is
# silent reversion to vibes is worse than no gate.
#
#   smoke-run-scaffold.sh contract    <run-dir> <source-sha> <lane>[:kind[:title]]... [--regenerate] [--evidence <lane-id>=api]...
#   smoke-run-scaffold.sh marker      <run-dir> <lane-id> <status> [summary] [evidence-csv] [--confirmed-findings <id>[,<id>...]]
#   smoke-run-scaffold.sh redispatch  <run-dir> <lane-id>
#   smoke-run-scaffold.sh adopt       <run-dir> <source-sha>
#
# `adopt` is the fenced ownership transition for a RECOVERED run: the gate's
# current owner rebinds an existing same-SHA contract to itself, leaving lanes,
# generations, markers and `createdAt` untouched. See CONTRACT ADOPTION below.
#
# `--evidence <lane-id>=api` declares a `floor` lane's proof is an API
# contract by design (a guard that must not be exercised through the UI),
# writing `evidence:"api"` onto that lane's contract entry. It is the ONLY way
# to set it — never inferred from a marker, never assumed from a lane's kind —
# because a coordinator that could wave off a floor lane's browser-evidence
# requirement after the fact could quietly launder any floor pass through it.
# smoke-evidence-barrier.sh requires real screenshot/video evidence on every
# `floor` lane's `pass` marker unless its contract entry carries this flag.
#
# The marker verb reads sourceSha from the contract rather than taking it as
# an argument. A worker therefore cannot stamp a marker with a build it was
# not assigned, which is the property the barrier's SHA check exists to
# enforce and the one freehand markers dropped.
#
# `--confirmed-findings` writes the marker's `confirmedFindings` array, which
# smoke-evidence-barrier.sh's finding_clip_problem() then requires a
# `clips/<id>.mp4` or `clip-skipped: <id>: <reason>` entry for, per id, in
# `evidence`. Omit the flag entirely and the field is omitted too — hand-
# writing a marker is refused for provenance (see below), so before this flag
# existed the barrier's clip check had no writer and was structurally
# unreachable, exactly the "enforcing a field nothing could emit" failure
# mode the LANE GENERATIONS section below describes for `generation`.
#
# LANE GENERATIONS. smoke-evidence-barrier.sh validates a marker's
# `.generation` against the contract's `.lanes[].generation`, which closes two
# holes a sourceSha check cannot see: a lane RE-DISPATCHED mid-run (its old
# terminal marker is still SHA-correct and still terminal, so the barrier
# reported ready while a live worker was mid-flight) and a contract
# RE-SCAFFOLDED into the same run dir on the same SHA (a lane id repurposed to
# mean something else, with the old marker still validating). This script is
# the ONLY sanctioned writer of either artifact — SKILL.md forbids hand-writing
# them — so until it could produce a generation, that whole check was
# unreachable and the barrier was enforcing a field nothing could emit.
#
# Two writers, matching the two holes:
#   * `contract --regenerate` refuses a silent overwrite whenever this run
#     ALREADY HAS A CONTRACT on the same sourceSha — marker count is irrelevant,
#     since lanes get redefined before any marker lands — and, when forced,
#     bumps EVERY lane past the highest generation found in the old contract OR
#     in any marker on disk. (A re-freeze on a NEW SHA needs none of this: the
#     barrier's sourceSha check already retires those markers, loudly.)
#   * `redispatch <lane-id>` bumps ONE lane, for the ordinary case of
#     re-running a single lane while the finished lanes keep counting.
# Both leave the stale markers on disk on purpose: the barrier then names them
# in `invalid[]` with a "stale generation" reason, which is loud. Deleting them
# would make a re-dispatch look identical to a lane that never ran.
set -euo pipefail

# `--regenerate` and `--confirmed-findings <csv>` may appear anywhere in the
# argument list, same convention as `--takeover` in the gate scripts, so no
# verb has to know its position and a stale positional can never mean
# "retire every marker" or "these findings are confirmed".
REGENERATE=false
CONFIRMED_FINDINGS_CSV=""
_CF_WANT_VALUE=false
EVIDENCE_DECLS=()
_EV_WANT_VALUE=false
_ARGS=()
for _a in "$@"; do
  if [ "$_CF_WANT_VALUE" = true ]; then
    CONFIRMED_FINDINGS_CSV="$_a"
    _CF_WANT_VALUE=false
    continue
  fi
  if [ "$_EV_WANT_VALUE" = true ]; then
    EVIDENCE_DECLS+=("$_a")
    _EV_WANT_VALUE=false
    continue
  fi
  case "$_a" in
    --regenerate) REGENERATE=true ;;
    --confirmed-findings) _CF_WANT_VALUE=true ;;
    --evidence) _EV_WANT_VALUE=true ;;
    *) _ARGS+=("$_a") ;;
  esac
done
set -- ${_ARGS[@]+"${_ARGS[@]}"}

COMMAND="${1:-}"
RUN_DIR="${2:-}"

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

[ "$_CF_WANT_VALUE" = false ] || die "--confirmed-findings requires a value"
[ -z "$CONFIRMED_FINDINGS_CSV" ] || [ "$COMMAND" = marker ] ||
  die "--confirmed-findings is only valid with the marker command"

[ "$_EV_WANT_VALUE" = false ] || die "--evidence requires a value"
[ "${#EVIDENCE_DECLS[@]}" -eq 0 ] || [ "$COMMAND" = contract ] ||
  die "--evidence is only valid with the contract command"
# Validated eagerly, before the contract's own lane loop, so a malformed
# `--evidence` argument fails the same way for every command path rather than
# surfacing only once a matching lane id happens to be declared.
for _ev in "${EVIDENCE_DECLS[@]:-}"; do
  [ -n "$_ev" ] || continue
  case "$_ev" in
    *=*) ;;
    *) die "--evidence must be <lane-id>=api (got: $_ev)" ;;
  esac
  _ev_id="${_ev%%=*}"
  _ev_val="${_ev#*=}"
  printf '%s' "$_ev_id" | grep -Eq '^[A-Za-z0-9_-]+$' ||
    die "--evidence lane id must be alphanumeric/dash/underscore: $_ev_id"
  # "api" is the only recognized value on purpose: it names one exemption
  # (this floor entry's proof is an API contract by design), not an open
  # vocabulary a coordinator could grow into a general escape hatch.
  [ "$_ev_val" = api ] ||
    die "--evidence only supports the value 'api' (got: $_ev_val for lane $_ev_id)"
done

iso_now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

valid_utc_timestamp() {
  local value="$1"
  printf '%s' "$value" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' &&
    [ "$(date -u -d "$value" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" = "$value" ]
}

# The contract and the lane markers are COORDINATOR-owned slots, and until now
# nothing here had any notion of WHO was writing: a challenger-side worker on
# the right sourceSha, writing a lane the contract had declared, passed every
# other check. That is not theoretical — it happened three times in one run on
# 2026-08-20 (lanes S2, B1, B2) and twice more on 2026-08-22, once overwriting
# a real coordinator marker. Had the barrier fired in that window, a
# challenger's independent conclusion would have counted as the coordinator's
# own lane, collapsing the two-lane contract into one source while the run
# record still claimed two. Briefs telling workers not to do it are a
# mitigation; refusing to resolve the path is the fix.
#
# Fail closed on an unset role. A missing marker is loud — the barrier names it
# in `missing[]` and the run stalls visibly. A wrongly attributed one is
# silent, which is the failure this exists to make impossible.
require_coordinator_role() {
  case "${SMOKE_LANE_ROLE:-}" in
    coordinator) ;;
    challenger)
      die "SMOKE_LANE_ROLE=challenger may not write $1 — challenger output belongs under challenger/, and the barrier never waits on it" ;;
    "")
      die "SMOKE_LANE_ROLE is unset — export it as the writing worker's role (coordinator|challenger) before writing $1" ;;
    *)
      die "SMOKE_LANE_ROLE must be 'coordinator' or 'challenger' (got: ${SMOKE_LANE_ROLE})" ;;
  esac
}

# Being the right role and run id is not ownership. After an expired lease is
# reclaimed under the same run id, stale private state still says activeRunId
# matches. Fence every metadata write with the shared owner lease used by the
# PR gate, and hold both locks through the atomic artifact replacement.
DEFAULT_OWNER="${SMOKE_GATE_OWNER:-${HOSTNAME:-unknown-host}}"
SHARED_LEASE_ROOT="${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}"
LEASE_DIR="${SMOKE_GATE_LEASE_DIR:-$SHARED_LEASE_ROOT/qa-coordinator/leases}"
LOCK_WAIT="${SMOKE_GATE_LOCK_WAIT_SECONDS:-15}"

prepare_lease_dir() {
  local root ancestor ancestor_real dir probe
  [ -d "$SHARED_LEASE_ROOT" ] || die "shared lease root $SHARED_LEASE_ROOT is missing — refusing metadata writes"
  command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$SHARED_LEASE_ROOT" ||
    die "shared lease root $SHARED_LEASE_ROOT is not a mounted filesystem — refusing metadata writes"
  root="$(cd -P "$SHARED_LEASE_ROOT" 2>/dev/null && pwd -P)" ||
    die "shared lease root $SHARED_LEASE_ROOT cannot be resolved"
  case "$LEASE_DIR" in "$SHARED_LEASE_ROOT"/*) ;; *)
    die "configured lease directory $LEASE_DIR is outside $SHARED_LEASE_ROOT" ;; esac
  ancestor="$LEASE_DIR"
  while [ "$ancestor" != / ] && [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do ancestor="$(dirname "$ancestor")"; done
  ancestor_real="$(cd -P "$ancestor" 2>/dev/null && pwd -P)" || die "lease directory has no resolvable ancestor"
  case "$ancestor_real" in "$root"|"$root"/*) ;; *) die "lease directory resolves through a non-shared path" ;; esac
  mkdir -p -- "$LEASE_DIR" 2>/dev/null || die "could not create shared lease directory $LEASE_DIR"
  dir="$(cd -P "$LEASE_DIR" 2>/dev/null && pwd -P)" || die "could not resolve shared lease directory $LEASE_DIR"
  case "$dir" in "$root"/*) ;; *) die "lease directory resolves outside shared root" ;; esac
  probe="$(mktemp "$dir/.lease-probe.XXXXXX" 2>/dev/null)" || die "shared lease directory is not writable"
  printf 'probe\n' > "$probe" 2>/dev/null && rm -f "$probe" 2>/dev/null || die "shared lease directory cannot complete an atomic write"
  LEASE_DIR="$dir"
}

begin_active_run_fence() {  # <artifact description>
  local description="$1" state_dir="${SMOKE_GATE_STATE_DIR:-}" run_id f count=0
  local state owner pr lease authority expires_epoch state_kind=""
  run_id="$(basename "$RUN_DIR")"
  [ -n "$state_dir" ] || die "SMOKE_GATE_STATE_DIR is unset — the run's gate claim cannot be verified, so $description is refused"
  FENCED_STATE_FILE=""
  for f in "$state_dir"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.activeRunId // empty' "$f" 2>/dev/null)" = "$run_id" ]; then
      FENCED_STATE_FILE="$f"; state_kind="pr"; count=$(( count + 1 ))
    fi
  done
  if [ -e "$state_dir/develop-state.json" ] &&
     [ "$(jq -r '.activeRunId // empty' "$state_dir/develop-state.json" 2>/dev/null)" = "$run_id" ]; then
    FENCED_STATE_FILE="$state_dir/develop-state.json"; state_kind="develop"; count=$(( count + 1 ))
  fi
  # A certification, re-verification or evidence-recovery run has no PR and no
  # develop campaign — `smoke-pr-gate.sh task-claim` writes this third shape.
  # Before this branch existed, such a run matched neither of the two above,
  # so `count` stayed 0 and every task-scoped write was refused outright; the
  # gap made coordinators hand-compose the contract and markers directly,
  # skipping every check in this function.
  if [ -e "$state_dir/task-$run_id-state.json" ] &&
     [ "$(jq -r '.activeRunId // empty' "$state_dir/task-$run_id-state.json" 2>/dev/null)" = "$run_id" ]; then
    FENCED_STATE_FILE="$state_dir/task-$run_id-state.json"; state_kind="task"; count=$(( count + 1 ))
  fi
  [ "$count" -eq 1 ] || die "run '$run_id' does not hold the gate in exactly one active slot — STOP this campaign; do not write $description"
  # Recorded into the contract below so the barrier can tell a `develop`-fenced
  # run (the only shape a null coordinatorOwnerToken is ever legitimate for)
  # apart from a pr/task run whose null token means it was never actually
  # claimed.
  FENCED_STATE_KIND="$state_kind"
  state="$(jq -c '.' "$FENCED_STATE_FILE" 2>/dev/null)" || die "active PR state is unreadable — refusing $description"
  if [ "$state_kind" = develop ]; then
    FENCED_ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$state")"
    FENCED_OWNER=""
    return 0
  fi
  if [ "$state_kind" = task ]; then
    owner="$(jq -r '.activeLeaseOwner // empty' <<<"$state")"
    [ -n "$owner" ] && [ "$owner" = "$DEFAULT_OWNER" ] ||
      die "caller owner does not match the owner recorded by task-claim — STOP this run; do not write $description"
    prepare_lease_dir
    exec 8>"$LEASE_DIR/task-lease-$run_id.lock" || die "could not open shared task lease lock"
    flock -w "$LOCK_WAIT" 8 || die "shared task lease lock is busy — retry this metadata write"
    state="$(jq -c '.' "$FENCED_STATE_FILE" 2>/dev/null)" || die "active task state became unreadable under the shared fence"
    [ "$(jq -r '.activeRunId // empty' <<<"$state")" = "$run_id" ] &&
      [ "$(jq -r '.activeLeaseOwner // empty' <<<"$state")" = "$DEFAULT_OWNER" ] ||
      die "run ownership changed before the metadata write — STOP this run"
    FENCED_ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$state")"
    FENCED_OWNER="$DEFAULT_OWNER"
    lease="$(jq -c 'select(type == "object" and .schemaVersion == 1 and .kind == "task" and
      (.runId|type == "string" and length > 0) and
      (.deploySha|type == "string" and test("^[0-9a-f]{40}$")) and
      (.owner|type == "string" and length > 0) and
      (.claimedAt|type == "string" and length > 0) and
      (.renewedAt|type == "string" and length > 0) and
      (.expiresAt|type == "string" and length > 0))' \
      "$LEASE_DIR/task-lease-$run_id.json" 2>/dev/null)" || die "shared task lease is missing or malformed — refusing $description"
    [ "$(jq -r '.owner' <<<"$lease")" = "$DEFAULT_OWNER" ] || die "shared task lease belongs to another owner — STOP this run"
    [ "$(jq -r '.runId' <<<"$lease")" = "$run_id" ] || die "shared task lease belongs to another run — STOP this run"
    [ "$(jq -r '.deploySha' <<<"$lease")" = "$FENCED_ACTIVE_SHA" ] || die "shared task lease belongs to another deploy — STOP this run"
    for timestamp_field in claimedAt renewedAt expiresAt; do
      valid_utc_timestamp "$(jq -r --arg field "$timestamp_field" '.[$field]' <<<"$lease")" ||
        die "shared task lease has an invalid UTC timestamp — refusing $description"
    done
    expires_epoch="$(date -u -d "$(jq -r '.expiresAt' <<<"$lease")" +%s 2>/dev/null || printf 0)"
    [ "$(date -u +%s)" -lt "$expires_epoch" ] || die "shared task lease expired — STOP this run"
    return 0
  fi
  owner="$(jq -r '.activeLeaseOwner // empty' <<<"$state")"
  [ -n "$owner" ] && [ "$owner" = "$DEFAULT_OWNER" ] ||
    die "caller owner does not match the owner recorded by claim — STOP this campaign; do not write $description"
  pr="$(jq -r '.pr // empty' <<<"$state")"
  printf '%s' "$pr" | grep -Eq '^[0-9]+$' || die "active PR state has no valid PR number"
  prepare_lease_dir
  exec 7>"$LEASE_DIR/pr-$pr-lifecycle.lock" || die "could not open shared lifecycle lock"
  flock -w "$LOCK_WAIT" 7 || die "shared lifecycle lock is busy — retry this metadata write"
  exec 8>"$LEASE_DIR/lease-$run_id.lock" || die "could not open shared run lease lock"
  flock -w "$LOCK_WAIT" 8 || die "shared run lease lock is busy — retry this metadata write"
  state="$(jq -c '.' "$FENCED_STATE_FILE" 2>/dev/null)" || die "active PR state became unreadable under the shared fence"
  [ "$(jq -r '.activeRunId // empty' <<<"$state")" = "$run_id" ] &&
    [ "$(jq -r '.activeLeaseOwner // empty' <<<"$state")" = "$DEFAULT_OWNER" ] ||
    die "run ownership changed before the metadata write — STOP this campaign"
  FENCED_ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$state")"
  FENCED_OWNER="$DEFAULT_OWNER"
  lease="$(jq -c 'select(type == "object" and .schemaVersion == 1 and
    (.pr|type == "number" and . >= 1 and . == floor) and
    (.owner|type == "string" and length > 0) and
    (.claimedAt|type == "string" and length > 0) and
    (.renewedAt|type == "string" and length > 0) and
    (.expiresAt|type == "string" and length > 0))' \
    "$LEASE_DIR/lease-$run_id.json" 2>/dev/null)" || die "shared coordinator lease is missing or malformed — refusing $description"
  [ "$(jq -r '.owner' <<<"$lease")" = "$DEFAULT_OWNER" ] || die "shared coordinator lease belongs to another owner — STOP this campaign"
  [ "$(jq -r '.pr' <<<"$lease")" = "$pr" ] || die "shared coordinator lease belongs to another PR — STOP this campaign"
  for timestamp_field in claimedAt renewedAt expiresAt; do
    valid_utc_timestamp "$(jq -r --arg field "$timestamp_field" '.[$field]' <<<"$lease")" ||
      die "shared coordinator lease has an invalid UTC timestamp — refusing $description"
  done
  expires_epoch="$(date -u -d "$(jq -r '.expiresAt' <<<"$lease")" +%s 2>/dev/null || printf 0)"
  [ "$(date -u +%s)" -lt "$expires_epoch" ] || die "shared coordinator lease expired — STOP this campaign"
  authority="$(jq -c --argjson pr "$pr" '
    select(type == "object" and .schemaVersion == 1 and .pr == $pr and
      (.runId|type == "string" and length > 0) and
      (.owner|type == "string" and length > 0) and
      (.boundAt|type == "string" and length > 0))' \
    "$LEASE_DIR/pr-$pr-authority.json" 2>/dev/null)" ||
    die "shared PR authority is missing or malformed — refusing $description"
  [ "$(jq -r '.runId' <<<"$authority")" = "$run_id" ] &&
    [ "$(jq -r '.owner' <<<"$authority")" = "$DEFAULT_OWNER" ] ||
    die "shared PR authority belongs to another run or owner — STOP this campaign"
}

require_fenced_source_sha() {
  [ "$1" = "$FENCED_ACTIVE_SHA" ] ||
    die "artifact sourceSha does not match the SHA claimed by this run — refusing metadata write"
}

# The refusal names `adopt` because a caller that reaches this line has ALREADY
# passed begin_active_run_fence — it is the gate's current owner, not a stale
# one (a stale owner dies earlier, on "caller owner does not match"). Before
# `adopt` existed the only exit from here was `contract --regenerate`, which
# retires every valid marker of a run whose previews may already be gone
# (the recovery-owner wedge).
require_contract_owner() {
  local bound
  bound="$(jq -r '.coordinatorOwnerToken // empty' "$CONTRACT" 2>/dev/null || printf '')"
  [ "$bound" = "$FENCED_OWNER" ] ||
    die "completion contract belongs to a different coordinator owner — STOP writing. If you are the RECOVERY owner of this same run on the same sourceSha, run 'adopt <run-dir> <source-sha>' once and retry; on a different sourceSha only 'contract --regenerate' applies. Otherwise STOP this campaign"
}

# A re-dispatched lane gets a newer generation before its replacement marker
# lands. Preserve the prior raw marker at that boundary so recovering missing
# evidence produces an auditable forward replay instead of rewriting history.
# `ln` creates the history file atomically without overwriting one another
# worker may already have written; the old marker and its archive remain the
# same inode until the replacement `mv` below swaps the live path.
archive_prior_marker_if_superseded() {
  local marker_path="$1" current_generation="$2" prior_generation history_dir history_path
  [ -f "$marker_path" ] || return 0

  prior_generation="$(jq -r '(.generation // 1) | tostring' "$marker_path" 2>/dev/null || printf '')"
  printf '%s' "$prior_generation" | grep -Eq '^[1-9][0-9]*$' || prior_generation=1
  [ "$prior_generation" -lt "$current_generation" ] || return 0

  history_dir="$RUN_DIR/markers/history"
  history_path="$history_dir/$LANE.generation-$prior_generation.json"
  mkdir -p "$history_dir"

  if [ -e "$history_path" ]; then
    cmp -s "$marker_path" "$history_path" ||
      die "refusing to replace $marker_path: $history_path already exists with different raw evidence"
    return 0
  fi

  if ln "$marker_path" "$history_path" 2>/dev/null; then
    return 0
  fi

  # A concurrent recovery may have created the archive after the existence
  # check. Accept only byte-identical history; never overwrite a disagreement.
  if [ -e "$history_path" ] && cmp -s "$marker_path" "$history_path"; then
    return 0
  fi
  die "could not atomically archive superseded marker at $history_path; refusing to replace $marker_path"
}

[ -n "$COMMAND" ] || die "usage: smoke-run-scaffold.sh <contract|marker|redispatch|adopt> <run-dir> ..."
[ -n "$RUN_DIR" ] || die "a run directory is required"

CONTRACT="$RUN_DIR/completion-contract.json"

case "$COMMAND" in
contract)
  require_coordinator_role "the completion contract"
  SOURCE_SHA="${3:-}"
  shift 3 || die "contract requires a run dir, a source SHA, and at least one lane"
  printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
    die "contract requires the 40-character frozen source SHA"
  [ "$#" -gt 0 ] || die "contract requires at least one lane"
  begin_active_run_fence "the completion contract"
  require_fenced_source_sha "$SOURCE_SHA"

  # Same-SHA re-scaffold guard.
  #
  # Re-freezing on a NEW build already invalidates every old marker — the
  # barrier's sourceSha check does that, loudly, and nothing here needs to
  # help. The hole is the SAME sourceSha: a freeze PR pins one SHA for the
  # whole campaign, so a lane repurposed mid-run (the documented incident: B2
  # went from "permission crossings" to "publish/exports") overwrote the
  # contract while its old marker stayed sourceSha-correct, lane-id-correct and
  # terminal — and generation defaulted to 1 on both sides, so it validated
  # against a definition it had never seen.
  #
  # The guard arms on a PRIOR CONTRACT ALONE — never on marker count. Markers
  # are the LAST thing to land and lane definitions get rewritten BEFORE any of
  # them exist, so an "only if markers are present" condition leaves the entire
  # early-run window open: rewrite at generation 1, then the worker still
  # briefed on the old B2 stamps its marker and INHERITS generation 1, and the
  # barrier reports ready on old-definition evidence. That is the original
  # incident, unchanged. A contract file that exists but cannot be read as one
  # (truncated, corrupt) REFUSES too: that is the case where this script knows
  # least about what the run already committed to, which makes it the worst
  # possible moment to fail open.
  GENERATION=1
  if [ -e "$CONTRACT" ]; then
    PRIOR_SHA="$(jq -r 'if (type == "object" and (.sourceSha | type) == "string")
                        then .sourceSha else "" end' "$CONTRACT" 2>/dev/null || printf '')"
    printf '%s' "$PRIOR_SHA" | grep -Eq '^[0-9a-f]{40}$' || PRIOR_SHA=""
    if [ "$REGENERATE" != true ]; then
      [ -n "$PRIOR_SHA" ] ||
        die "refusing to overwrite $CONTRACT: the file exists but does not read as a contract (truncated or corrupt), so this script cannot tell which lane definitions the run already committed to, nor which markers a rewrite would leave validating. Re-run with --regenerate to retire every existing marker, or remove the run directory and start clean."
      [ "$PRIOR_SHA" != "$SOURCE_SHA" ] ||
        die "refusing to overwrite $CONTRACT: this run already has a contract on the SAME sourceSha. Any marker against it — one already on disk, or one a worker still briefed on the old lane definitions is about to write — would keep validating against lane ids this rewrite may have redefined. Re-run with --regenerate to retire every existing marker, use 'redispatch <lane-id>' to retire just one lane, or write markers against the contract that is already there."
    fi
    if [ "$REGENERATE" = true ]; then
      # Highest generation anywhere in this run dir: the old contract's lanes
      # AND every marker on disk. The markers matter on their own — a truncated
      # contract carries no lanes to read, and bumping to 1 there would re-bless
      # the exact markers --regenerate exists to retire.
      GENERATION="$( {
          jq -r '.lanes[]? | select(type == "object") | (.generation // 1)' "$CONTRACT" 2>/dev/null
          for m in "$RUN_DIR"/markers/*.json; do
            [ -f "$m" ] || continue
            jq -r 'select(type == "object") | (.generation // 1)' "$m" 2>/dev/null
          done
        } | grep -E '^[0-9]+$' | sort -n | tail -1 || true )"
      printf '%s' "$GENERATION" | grep -Eq '^[0-9]+$' || GENERATION=0
      GENERATION=$(( GENERATION + 1 ))
    fi
  fi

  LANES='[]'
  MARKERS='[]'
  DECLARED_IDS=()
  for spec in "$@"; do
    id="${spec%%:*}"
    rest="${spec#"$id"}"; rest="${rest#:}"
    kind="${rest%%:*}"
    title="${rest#"$kind"}"; title="${title#:}"
    printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_-]+$' ||
      die "lane id must be alphanumeric/dash/underscore: $id"
    DECLARED_IDS+=("$id")
    lane_evidence=""
    for _ev in "${EVIDENCE_DECLS[@]:-}"; do
      [ -n "$_ev" ] || continue
      case "$_ev" in
        "$id="*) lane_evidence="${_ev#*=}" ;;
      esac
    done
    LANES="$(jq -c --arg id "$id" --arg kind "${kind:-lane}" --arg title "$title" \
      --arg evidence "$lane_evidence" --argjson gen "$GENERATION" \
      '. + [{id:$id,kind:$kind,title:(if $title == "" then null else $title end),generation:$gen}
        + (if $evidence == "" then {} else {evidence:$evidence} end)]' <<<"$LANES")"
    MARKERS="$(jq -c --arg m "markers/$id.json" '. + [$m]' <<<"$MARKERS")"
  done

  # An `--evidence` entry naming a lane id that was never declared on this call
  # is silently a no-op above — fail loudly instead, the same reasoning as
  # every other fail-closed check in this script: a typo here would otherwise
  # leave a floor lane requiring browser evidence it was meant to be exempted
  # from, discovered only when the barrier refuses it.
  for _ev in "${EVIDENCE_DECLS[@]:-}"; do
    [ -n "$_ev" ] || continue
    _ev_id="${_ev%%=*}"
    _ev_found=false
    for _d in "${DECLARED_IDS[@]:-}"; do
      [ "$_d" = "$_ev_id" ] && { _ev_found=true; break; }
    done
    [ "$_ev_found" = true ] ||
      die "--evidence declares lane '$_ev_id' which is not among the lanes being scaffolded"
  done

  # Deployment-specific fields (environment, leasePolicy, frontendDeploySha…)
  # merge in from $SMOKE_CONTRACT_EXTRA so this script never grows tenant knobs.
  EXTRA="${SMOKE_CONTRACT_EXTRA:-{\}}"
  jq -e 'type == "object"' <<<"$EXTRA" >/dev/null 2>&1 ||
    die "SMOKE_CONTRACT_EXTRA must be a JSON object"

  mkdir -p "$RUN_DIR/markers"
  tmp="$(mktemp "$RUN_DIR/.completion-contract.XXXXXX")"
  jq -n \
    --arg runId "$(basename "$RUN_DIR")" \
    --arg sha "$SOURCE_SHA" \
    --arg now "$(iso_now)" \
    --arg owner "$FENCED_OWNER" \
    --arg kind "$FENCED_STATE_KIND" \
    --argjson lanes "$LANES" \
    --argjson markers "$MARKERS" \
    --argjson extra "$EXTRA" \
    '$extra + {
      schemaVersion: 1,
      runId: $runId,
      sourceSha: $sha,
      coordinatorOwnerToken:(if $owner == "" then null else $owner end),
      ownershipKind: $kind,
      requiredLaneMarkers: $markers,
      lanes: $lanes,
      markerDir: "markers",
      terminalStatuses: ["pass","fail","blocked","void","completed"],
      createdAt: $now
    }' > "$tmp"
  mv "$tmp" "$CONTRACT"
  jq -cn --arg path "$CONTRACT" --argjson lanes "$LANES" \
    '{ok:true,contract:$path,laneCount:($lanes|length)}'
  ;;

marker)
  require_coordinator_role "a coordinator lane marker"
  begin_active_run_fence "a coordinator lane marker"
  LANE="${3:-}"
  STATUS="${4:-}"
  SUMMARY="${5:-}"
  EVIDENCE_CSV="${6:-}"
  [ -n "$LANE" ] || die "marker requires a lane id"
  [ -s "$CONTRACT" ] || die "no completion contract at $CONTRACT — write it before any marker"
  require_contract_owner
  case "$STATUS" in
    pass|fail|blocked|void|completed) ;;
    *) die "status must be one of: pass fail blocked void completed" ;;
  esac

  # The lane must be one the contract declared. An undeclared lane is either a
  # typo — which would leave the real lane forever missing and the barrier
  # forever false — or scope the manifest never committed to.
  jq -e --arg m "markers/$LANE.json" 'any(.requiredLaneMarkers[]; . == $m)' \
    "$CONTRACT" >/dev/null 2>&1 ||
    die "lane '$LANE' is not declared in the contract — add it there first"

  SOURCE_SHA="$(jq -r '.sourceSha' "$CONTRACT")"
  require_fenced_source_sha "$SOURCE_SHA"
  # A marker INHERITS the lane's current generation from the contract, exactly
  # the way it already inherits sourceSha: the writer never states it, so a
  # worker cannot stamp a marker for a dispatch it was not part of. Defaults to
  # 1 for a contract with no lanes[] (or no entry for this lane), which is what
  # the barrier defaults to on both sides — pre-existing contracts are
  # unaffected.
  GENERATION="$(jq -r --arg id "$LANE" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.generation // 1)][0] // 1' \
    "$CONTRACT" 2>/dev/null || printf '')"
  printf '%s' "$GENERATION" | grep -Eq '^[0-9]+$' || GENERATION=1
  # Trailing newline is load-bearing: with no input line `jq -R` emits nothing
  # and --argjson then receives an empty string rather than `[]`.
  EVIDENCE="$(printf '%s\n' "$EVIDENCE_CSV" | jq -Rc 'split(",") | map(select(length > 0))')"
  NOW="$(iso_now)"

  # `--confirmed-findings` is optional; omitting it omits `confirmedFindings`
  # from the marker entirely (CONFIRMED_FINDINGS stays the JSON `null`
  # sentinel below, never an empty array) — every marker written before this
  # flag existed round-trips unchanged, and the barrier's finding_clip_problem
  # already treats a marker with no such key as unaffected.
  CONFIRMED_FINDINGS=null
  if [ -n "$CONFIRMED_FINDINGS_CSV" ]; then
    CONFIRMED_FINDINGS="$(printf '%s\n' "$CONFIRMED_FINDINGS_CSV" | jq -Rc 'split(",") | map(select(length > 0))')"
    jq -e 'length > 0' <<<"$CONFIRMED_FINDINGS" >/dev/null 2>&1 ||
      die "--confirmed-findings requires at least one non-empty id"
    jq -e 'all(.[]; test("^[A-Za-z0-9_-]+$"))' <<<"$CONFIRMED_FINDINGS" >/dev/null 2>&1 ||
      die "--confirmed-findings ids must be alphanumeric/dash/underscore: $CONFIRMED_FINDINGS_CSV"
  fi

  mkdir -p "$RUN_DIR/markers"
  archive_prior_marker_if_superseded "$RUN_DIR/markers/$LANE.json" "$GENERATION"
  tmp="$(mktemp "$RUN_DIR/markers/.marker.XXXXXX")"
  jq -n \
    --arg lane "$LANE" \
    --arg sha "$SOURCE_SHA" \
    --arg status "$STATUS" \
    --arg now "$NOW" \
    --arg summary "$SUMMARY" \
    --argjson evidence "$EVIDENCE" \
    --argjson generation "$GENERATION" \
    --argjson confirmedFindings "$CONFIRMED_FINDINGS" \
    '{schemaVersion:1,
      lane:$lane,
      sourceSha:$sha,
      generation:$generation,
      status:$status,
      completedAt:$now,
      finishedAt:$now,
      summary:(if $summary == "" then null else $summary end),
      evidence:$evidence}
      + (if $confirmedFindings == null then {} else {confirmedFindings:$confirmedFindings} end)' > "$tmp"
  mv "$tmp" "$RUN_DIR/markers/$LANE.json"
  jq -cn --arg lane "$LANE" --arg sha "$SOURCE_SHA" --arg status "$STATUS" \
    --argjson generation "$GENERATION" --argjson confirmedFindings "$CONFIRMED_FINDINGS" \
    '{ok:true,lane:$lane,sourceSha:$sha,generation:$generation,status:$status}
      + (if $confirmedFindings == null then {} else {confirmedFindings:$confirmedFindings} end)'
  ;;

redispatch)
  # Retire ONE lane's evidence before re-running it. Bumping the whole contract
  # would retire the finished lanes too and stall the run; leaving the old
  # marker in place with a stale generation is what makes the barrier say
  # "a fresh marker has not landed yet" instead of "ready".
  require_coordinator_role "a lane generation bump"
  begin_active_run_fence "a lane generation bump"
  LANE="${3:-}"
  [ -n "$LANE" ] || die "redispatch requires a lane id"
  [ -s "$CONTRACT" ] || die "no completion contract at $CONTRACT — write it before redispatching a lane"
  require_contract_owner
  SOURCE_SHA="$(jq -r '.sourceSha // empty' "$CONTRACT" 2>/dev/null || printf '')"
  require_fenced_source_sha "$SOURCE_SHA"
  jq -e --arg m "markers/$LANE.json" 'any(.requiredLaneMarkers[]; . == $m)' \
    "$CONTRACT" >/dev/null 2>&1 ||
    die "lane '$LANE' is not declared in the contract — add it there first"

  tmp="$(mktemp "$RUN_DIR/.completion-contract.XXXXXX")"
  # A contract written before lanes[] existed (or by an older scaffold) may
  # carry no entry for this id at all. Create one at generation 2 rather than
  # failing: generation 1 is what every marker already written defaults to, so
  # 2 is the first value that actually retires them.
  jq --arg id "$LANE" '
    (.lanes //= []) |
    if any(.lanes[]?; type == "object" and .id == $id)
    then .lanes = [ .lanes[] |
           if (type == "object" and .id == $id)
           then .generation = ((.generation // 1) + 1)
           else . end ]
    else .lanes += [{id:$id, kind:"lane", title:null, generation:2}] end
  ' "$CONTRACT" > "$tmp"
  mv "$tmp" "$CONTRACT"
  NEXT_GEN="$(jq -r --arg id "$LANE" \
    '[.lanes[]? | select(type=="object") | select(.id == $id) | (.generation // 1)][0] // 1' "$CONTRACT")"
  jq -cn --arg lane "$LANE" --argjson generation "$NEXT_GEN" \
    --argjson retired "$([ -s "$RUN_DIR/markers/$LANE.json" ] && echo true || echo false)" \
    '{ok:true,lane:$lane,generation:$generation,retiredExistingMarker:$retired}'
  ;;

adopt)
  # CONTRACT ADOPTION — the fenced ownership transition for a recovered run.
  #
  # `smoke-pr-gate.sh poll` mints a fresh owner token on EVERY wake, same-run
  # recovery included (smoke-pr-gate.sh:4337), and writes it to the state, the
  # lease and the PR authority — but never to the contract. The recovery owner
  # therefore passes begin_active_run_fence and then dies in
  # require_contract_owner, with `contract --regenerate` (which retires every
  # marker) as the only exit. This verb is the missing transition.
  #
  # What keeps it safe is that it adds NO new authority check of its own: the
  # caller must already be the one current owner under the lifecycle + run
  # lease locks (state == lease == authority == caller, lease unexpired), which
  # is exactly what every other write here requires. A stale or previous owner
  # is refused by that fence before this block runs, before AND after an
  # adoption, because adoption never touches state, lease or authority. It
  # never copies the prior token anywhere and never re-authorizes it.
  #
  # Deliberately NOT changed: lanes, generations, requiredLaneMarkers, markers,
  # `createdAt`, and the gate's challengerDeadline (this script cannot write
  # gate state at all) — so valid prior evidence keeps validating and recovery
  # buys no fresh time budget. The successor is recorded as an ADOPTER in
  # `ownerAdoptions[]`, never as the author.
  require_coordinator_role "a completion-contract ownership adoption"
  SOURCE_SHA="${3:-}"
  printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
    die "adopt requires the 40-character frozen source SHA"
  begin_active_run_fence "a completion-contract ownership adoption"
  # A develop-fenced contract carries a null token by construction
  # (FENCED_OWNER="" above), so there is no owner binding to move.
  [ "$FENCED_STATE_KIND" != develop ] ||
    die "adopt does not apply to a develop-fenced run — its contract carries no coordinator owner"
  require_fenced_source_sha "$SOURCE_SHA"
  # A task run's LIFETIME identity is the shared binding, not the private
  # slot: `task-finish` commits `.terminal` there FIRST and clears the lease
  # and private slot afterwards (smoke-pr-gate.sh:3072-3083), so a crash in
  # between leaves state + lease looking live for a run that is already
  # terminal. The task fence above reads only state and lease, so adoption
  # checks the binding itself. It is read under fd 8, which is the same
  # `task-lease-<runId>.lock` file the gate serializes binding writes on
  # (smoke-pr-gate.sh:628 and :678) — no new lock. Fail closed on a missing
  # or malformed record: every current task-claim writes one.
  if [ "$FENCED_STATE_KIND" = task ]; then
    TASK_BINDING_FILE="$LEASE_DIR/task-binding-$(basename "$RUN_DIR").json"
    # SOURCE OF TRUTH: read_task_binding in smoke-pr-gate.sh:631-663 — the jq
    # predicate at :638-650 and the calendar round-trip of boundAt and
    # terminal.completedAt at :654-661. Duplicated verbatim because the gate
    # is an executable, not a sourceable library; keep the two in step. A
    # looser check here would adopt a contract onto a binding every gate
    # lifecycle verb then refuses as malformed.
    TASK_BINDING="$(jq -ce --arg run "$(basename "$RUN_DIR")" '
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
    ' "$TASK_BINDING_FILE" 2>/dev/null)" ||
      die "shared task binding is missing or malformed — this run's lifetime identity cannot be verified, refusing adoption"
    for _stamp in "$(jq -r '.boundAt' <<<"$TASK_BINDING")" "$(jq -r '.terminal.completedAt // empty' <<<"$TASK_BINDING")"; do
      [ -z "$_stamp" ] || valid_utc_timestamp "$_stamp" ||
        die "shared task binding is missing or malformed — this run's lifetime identity cannot be verified, refusing adoption"
    done
    [ "$(jq -r '.deploySha' "$TASK_BINDING_FILE")" = "$SOURCE_SHA" ] ||
      die "shared task binding names a different deploy SHA — refusing adoption"
    [ "$(jq -r '.terminal == null' "$TASK_BINDING_FILE")" = true ] ||
      die "this task run is already terminal in the shared task binding — nothing to adopt; re-run the exact task-finish to reconcile the lease and private slot"
  fi
  [ -s "$CONTRACT" ] || die "no completion contract at $CONTRACT — nothing to adopt; write it with the contract command"
  jq -e 'type == "object" and .schemaVersion == 1 and
         (.sourceSha | type) == "string" and (.requiredLaneMarkers | type) == "array" and
         ((.ownerAdoptions // []) | type) == "array"' "$CONTRACT" >/dev/null 2>&1 ||
    die "completion contract at $CONTRACT does not read as a scaffold contract (truncated or corrupt) — adoption would bless lane definitions this script cannot see; use 'contract --regenerate'"
  [ "$(jq -r '.sourceSha' "$CONTRACT")" = "$SOURCE_SHA" ] ||
    die "completion contract is bound to a different sourceSha — adoption only continues the SAME campaign; a different build requires 'contract --regenerate'"
  [ "$(jq -r '.ownershipKind // empty' "$CONTRACT")" = "$FENCED_STATE_KIND" ] ||
    die "completion contract ownershipKind does not match this run's active $FENCED_STATE_KIND slot — refusing adoption"
  [ "$(jq -r '.runId // empty' "$CONTRACT")" = "$(basename "$RUN_DIR")" ] ||
    die "completion contract names a different run — refusing adoption"
  PRIOR_OWNER="$(jq -r '.coordinatorOwnerToken // empty' "$CONTRACT")"
  # A null token on a pr/task contract did not come from a live claim
  # (smoke-evidence-barrier.sh:55-70 refuses it too); there is nothing
  # legitimate to continue.
  [ -n "$PRIOR_OWNER" ] ||
    die "completion contract carries no coordinator owner — it was not written under a live claim; use 'contract --regenerate'"
  # Exact retry: the contract already names the caller. No write, no second
  # history entry — byte-identical file.
  if [ "$PRIOR_OWNER" = "$FENCED_OWNER" ]; then
    jq -cn --arg path "$CONTRACT" \
      --argjson adoptions "$(jq -c '(.ownerAdoptions // []) | length' "$CONTRACT")" \
      '{ok:true,contract:$path,adopted:false,alreadyOwner:true,adoptionCount:$adoptions}'
    exit 0
  fi
  tmp="$(mktemp "$RUN_DIR/.completion-contract.XXXXXX")"
  # The history entry carries NOTHING derived from an owner value — no token
  # and no digest of one. An owner is not always a gate-minted 256-bit token:
  # task-claim takes an arbitrary caller-supplied owner and otherwise defaults
  # to the hostname (smoke-pr-gate.sh:2775), so an unsalted digest would be
  # enumerable back to a reusable credential. `index` + `adoptedAt` record that
  # and when ownership changed hands; who holds it now is the token above.
  jq --arg owner "$FENCED_OWNER" --arg now "$(iso_now)" \
    '.coordinatorOwnerToken = $owner |
     .ownerAdoptions = ((.ownerAdoptions // []) +
       [{index:(((.ownerAdoptions // []) | length) + 1), adoptedAt:$now}])' \
    "$CONTRACT" > "$tmp"
  # Deterministic regression seam for a crash between validation and commit,
  # same guard as smoke-pr-gate.sh:4388. Production wrappers never set it.
  if [ -n "${SMOKE_GATE_SHARED_ROOT+x}" ] && [ "$SMOKE_GATE_SHARED_ROOT" != /workspace/workgroup ] &&
     [ "${SMOKE_SCAFFOLD_TEST_CRASH_BEFORE_ADOPT_COMMIT:-}" = 1 ]; then
    kill -KILL "$$"
  fi
  mv "$tmp" "$CONTRACT"
  jq -cn --arg path "$CONTRACT" \
    --argjson adoptions "$(jq -c '.ownerAdoptions | length' "$CONTRACT")" \
    '{ok:true,contract:$path,adopted:true,alreadyOwner:false,adoptionCount:$adoptions}'
  ;;

*)
  die "unknown command: $COMMAND (expected contract, marker, redispatch or adopt)"
  ;;
esac
