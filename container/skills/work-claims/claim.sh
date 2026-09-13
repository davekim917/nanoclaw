#!/usr/bin/env bash
# Work claims — one code path for check / take / release / list.
#
# Exists because the hand-written jq snippet this replaces was a shape agents
# had to remember, and they wrote it from memory instead of re-reading the
# skill. When `thread_id` was added, 0 of 16 live claims carried it and the
# first claim written afterwards — env var present, updated skill mounted —
# omitted it too. A field you can forget is a field that will be forgotten.
#
# Every rule in SKILL.md that can be enforced mechanically is enforced here:
# atomic writes, never clobbering a live claim you don't own, never deleting
# someone else's claim, and verifying a merge before using the merged-PR
# exception rather than taking the caller's word for it.

set -euo pipefail

# A park is a handoff offer; if nobody takes it inside a day the offer lapsed.
# Mirrors PARK_GRACE_MS in src/claims-board.ts — the board and the script must
# classify the same file the same way.
PARK_GRACE_HOURS=24

CLAIMS_DIR="${CLAIMS_DIR:-/workspace/workgroup/claims}"
WORKGROUP_ROOT="$(dirname "$CLAIMS_DIR")"

die() { echo "$*" >&2; exit 2; }

usage() {
  cat >&2 <<'USAGE'
usage:
  claim.sh check   <slug>
  claim.sh take    <slug> <ttl_hours> <note...>   [--takeover] [--resume] [--source <where this came from>]
  claim.sh park    <slug> <note...>               [--source <where this came from>]
  claim.sh pause   <slug> <reason...>             [--source <where this came from>]
  claim.sh resume  <slug> <ttl_hours> <note...>   [--source <where this came from>]
  claim.sh thread  <slug> [<thread-id>]           (defaults to $NANOCLAW_THREAD_ID)
  claim.sh release <slug> [--merged-pr <n>]
  claim.sh list

attribution events (append-only, claims/ledger.ndjson):
  claim.sh record-review-start <repo> <pr> <head_sha> <reviewer> [--parallel <risk reason>]
  claim.sh record-verdict      <repo> <pr> <head_sha> <reviewer> <verdict>
  claim.sh record-merge        <repo> <pr> <executor> <claim_owner> <head_sha> <gate_ref> <result>

exit codes: 0 ok · 2 usage/error · 3 held live by another agent
USAGE
  exit 2
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# A review has one owner per repo/PR/head by default. The lease prevents a
# watcher and an interactive desk session from spending two frontier reviews on
# the same immutable artifact. A crashed reviewer expires quickly enough to be
# retried, while a still-running one remains visible to the next dispatcher.
REVIEW_LEASE_TTL_SECONDS=3600

# No workgroup tree means this install has no shared FS — SKILL.md says skip
# the convention rather than fail, so callers can invoke this unconditionally.
require_workgroup() {
  if [ ! -d "$WORKGROUP_ROOT" ]; then
    echo "no workgroup shared FS at $WORKGROUP_ROOT — claims convention does not apply here"
    exit 0
  fi
  mkdir -p "$CLAIMS_DIR"
}

file_for() { printf '%s/%s.json' "$CLAIMS_DIR" "$1"; }

me() { printf '%s' "${NANOCLAW_ASSISTANT_NAME:-unknown}"; }

# Appends one append-only ledger line, flock-guarded so a note larger than an
# atomic write can never interleave with a concurrent append. Aborts (exit 2)
# on any failure — callers append BEFORE the mutation that would otherwise
# destroy the record, so a failed append leaves the claim file untouched.
#
# The ledger is the ONLY file any event in this script may be written to. A
# review or merge event appearing in releases/gates/*.jsonl is the audit failure
# this whole layer exists to prevent — gates files are human AUTHORIZATION
# records, the ledger is machine ATTRIBUTION. A CLAIMS_DIR pointed at a gates
# tree would silently blur the two, so refuse rather than append.
ledger_write_line() {
  local line="$1" ctx="${2:-}" lock="$CLAIMS_DIR/.ledger.lock"
  case "$CLAIMS_DIR" in
    */gates|*/gates/*) die "refusing to write the claim ledger under a gates/ tree ($CLAIMS_DIR) — gates files are human authorization records, not execution events" ;;
  esac
  ( flock -x 200 && printf '%s\n' "$line" >> "$CLAIMS_DIR/ledger.ndjson" ) 200>"$lock" \
    || die "failed to append ledger entry${ctx:+ $ctx}"
}

ledger_append() {
  local event="$1" slug="$2" owner="$3" note="$4" claimed_at="$5" thread_id="$6" pr="$7"
  local now line
  now="$(now_utc)"
  line="$(jq -nc \
    --arg event "$event" --arg slug "$slug" --arg owner "$owner" \
    --arg by "$(me)" --arg at "$now" \
    --arg claimed_at "$claimed_at" --arg thread_id "$thread_id" \
    --arg note "$note" --argjson pr "${pr:-null}" \
    '{event:$event, slug:$slug, owner:$owner, by:$by, at:$at}
     + (if $claimed_at == "" then {} else {claimed_at:$claimed_at} end)
     + (if $thread_id == "" then {} else {thread_id:$thread_id} end)
     + (if $pr == null then {} else {pr:$pr} end)
     + {note:$note}')" || die "failed to build ledger entry for $slug — claim left in place"
  ledger_write_line "$line" "for $slug — claim left in place"
}

# Echoes: state<TAB>owner<TAB>note   where state is unclaimed|yours|live|stale|parked|paused
inspect() {
  local f="$1" owner claimed_at ttl expires now note status
  if [ ! -f "$f" ]; then printf 'unclaimed\t\t\n'; return; fi

  owner="$(jq -r '.owner // "unknown"' "$f")"
  note="$(jq -r '.note // ""' "$f")"
  status="$(jq -r '.status // ""' "$f")"
  claimed_at="$(jq -r '.claimed_at // empty' "$f")"
  ttl="$(jq -r '.ttl_hours // empty' "$f")"

  # A parked claim wins over TTL classification even if claimed_at/ttl_hours
  # are still on the file — but it is a WAYPOINT, not a terminus. This used to
  # return here unconditionally, which made parked an absorbing state: a park
  # says "someone should pick this up" and nothing ever did. Seven parked
  # claims were found sitting in one workgroup, three with no ttl_hours at all,
  # the oldest at 93 hours. Past the grace window the offer has lapsed and the
  # slug goes back to stale, which is already the state that means "free to
  # take". PARK_GRACE_HOURS matches PARK_GRACE_MS in src/claims-board.ts.
  if [ "$status" = "parked" ]; then
    local parked_at parked_secs
    parked_at="$(jq -r '.parked_at // empty' "$f")"
    if [ -n "$parked_at" ] && parked_secs="$(date -u -d "$parked_at + $PARK_GRACE_HOURS hours" +%s 2>/dev/null)"; then
      if [ "$(date -u +%s)" -gt "$parked_secs" ]; then
        printf 'stale\t%s\t%s\n' "$owner" "$note"; return
      fi
    fi
    printf 'parked\t%s\t%s\n' "$owner" "$note"; return
  fi

  # A paused claim is an explicit operator hold, not a handoff offer. It has
  # no expiry path: only a deliberate resume may return it to active work.
  if [ "$status" = "paused" ]; then
    printf 'paused\t%s\t%s\n' "$owner" "$note"; return
  fi

  # A claim with no parseable expiry is treated as stale, never as an
  # indefinite lock — an unreadable claim must not wedge a slug forever.
  if [ -z "$claimed_at" ] || [ -z "$ttl" ]; then
    printf 'stale\t%s\t%s\n' "$owner" "$note"; return
  fi
  if ! expires="$(date -u -d "$claimed_at + $ttl hours" +%s 2>/dev/null)"; then
    printf 'stale\t%s\t%s\n' "$owner" "$note"; return
  fi
  now="$(date -u +%s)"

  if [ "$now" -gt "$expires" ]; then printf 'stale\t%s\t%s\n' "$owner" "$note"
  elif [ "$owner" = "$(me)" ]; then printf 'yours\t%s\t%s\n' "$owner" "$note"
  else printf 'live\t%s\t%s\n' "$owner" "$note"
  fi
}

cmd_check() {
  local slug="${1:-}"; [ -n "$slug" ] || usage
  require_workgroup
  local state owner note
  IFS=$'\t' read -r state owner note <<<"$(inspect "$(file_for "$slug")")"

  case "$state" in
    unclaimed) echo "unclaimed — free to take"; exit 0 ;;
    yours)     echo "YOURS — $note"; exit 0 ;;
    stale)     echo "STALE — was $owner: $note — you may take it over"; exit 0 ;;
    live)      echo "LIVE — held by $owner: $note — do not start this"; exit 3 ;;
    parked)    echo "PARKED — was $owner: $note — free to take"; exit 0 ;;
    paused)    echo "PAUSED — held by $owner: $note — resume only after an explicit operator instruction"; exit 3 ;;
  esac
}

cmd_take() {
  local slug="${1:-}" ttl="${2:-}"; shift 2 2>/dev/null || usage
  [ -n "$slug" ] && [ -n "$ttl" ] || usage

  local takeover=0 resume=0 source="" note_parts=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --takeover) takeover=1; shift ;;
      --resume)   resume=1; shift ;;
      --source)   source="${2:-}"; shift 2 ;;
      *)          note_parts+=("$1"); shift ;;
    esac
  done
  local note="${note_parts[*]:-}"
  [ -n "$note" ] || die "a note is required — say what you are taking and why"
  case "$ttl" in ''|*[!0-9]*) die "ttl_hours must be a whole number of hours" ;; esac

  require_workgroup
  local f state owner
  f="$(file_for "$slug")"
  IFS=$'\t' read -r state owner _ <<<"$(inspect "$f")"

  if [ "$state" = "paused" ] && [ "$resume" -ne 1 ]; then
    echo "REFUSED — $slug is explicitly paused by the operator. Resume only after a new explicit instruction, with --resume." >&2
    exit 3
  fi
  if [ "$state" != "paused" ] && [ "$resume" -eq 1 ]; then
    die "--resume applies only to an explicitly paused claim"
  fi

  if [ "$state" = "live" ] && [ "$takeover" -ne 1 ]; then
    echo "REFUSED — $slug is held live by $owner. Never take live work off a sibling." >&2
    echo "If they are genuinely gone, wait for it to go stale or escalate; --takeover only" >&2
    echo "records the override, it does not make it correct." >&2
    exit 3
  fi
  [ "$state" = "live" ] && note="TAKEOVER from $owner: $note"
  [ "$state" = "stale" ] && note="took over stale claim from $owner: $note"
  [ "$state" = "parked" ] && note="resumed parked work from $owner: $note"
  [ "$state" = "paused" ] && note="resumed explicit operator pause from $owner: $note"

  local tmp
  tmp="$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")"
  # thread_id is omitted rather than written empty — a channel-level session
  # has no thread, and an empty string would render as a broken link.
  # source = where the assignment came from ("QA hand-off run X", "the
  # operator, in the build channel"). Adopted from the field agents kept adding by hand — the
  # one thing their improvised schema recorded that this one could not.
  jq -n --arg owner "$(me)" --arg sid "$(hostname)" \
        --arg tid "${NANOCLAW_THREAD_ID:-}" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson ttl "$ttl" --arg note "$note" --arg source "$source" \
     '{owner:$owner, session_id:$sid, claimed_at:$at, ttl_hours:$ttl, note:$note}
      + (if $tid == "" then {} else {thread_id:$tid} end)
      + (if $source == "" then {} else {source:$source} end)' > "$tmp"
  mv "$tmp" "$f"   # same-directory rename: no reader ever sees a partial file

  echo "claimed $slug for $(me), ttl ${ttl}h"
}

cmd_resume() {
  # Keep the atomic claim rewrite in cmd_take while making a deliberate
  # resumption explicit in both the command and resulting claim note.
  cmd_take "$@" --resume
}

cmd_release() {
  local slug="${1:-}"; shift || usage
  [ -n "$slug" ] || usage
  local merged_pr=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --merged-pr) merged_pr="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done

  require_workgroup
  local f owner note claimed_at thread_id
  f="$(file_for "$slug")"
  [ -f "$f" ] || { echo "no claim at $slug — nothing to release"; exit 0; }
  owner="$(jq -r '.owner // "unknown"' "$f")"
  note="$(jq -r '.note // ""' "$f")"
  claimed_at="$(jq -r '.claimed_at // empty' "$f")"
  thread_id="$(jq -r '.thread_id // empty' "$f")"

  if [ "$owner" != "$(me)" ]; then
    [ -n "$merged_pr" ] || {
      echo "REFUSED — $slug belongs to $owner. Release only your own claim." >&2
      echo "If its PR has MERGED, re-run with --merged-pr <n> and the merge is verified here." >&2
      exit 3
    }
    # The skill's one exception. Verified against GitHub, never inferred from a
    # stale timestamp and never taken on the caller's assertion.
    local state
    state="$(gh pr view "$merged_pr" --json state -q .state 2>/dev/null || echo UNKNOWN)"
    [ "$state" = "MERGED" ] || {
      echo "REFUSED — PR #$merged_pr is $state, not MERGED. Leave $owner's claim alone and escalate." >&2
      exit 3
    }
    echo "PR #$merged_pr verified MERGED — clearing $owner's completed claim"
    ledger_append cleared_merged "$slug" "$owner" "$note" "$claimed_at" "$thread_id" "$merged_pr"
  else
    ledger_append released "$slug" "$owner" "$note" "$claimed_at" "$thread_id" ""
  fi

  # releasing still means DELETING the file — the note above just went to
  # claims/ledger.ndjson first, so deleting costs nothing.
  rm -f "$f"
  echo "released $slug"
}

cmd_park() {
  local slug="${1:-}"; shift || usage
  [ -n "$slug" ] || usage
  local source="" note_parts=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) source="${2:-}"; shift 2 ;;
      *)        note_parts+=("$1"); shift ;;
    esac
  done
  local note="${note_parts[*]:-}"
  [ -n "$note" ] || die "a note is required — say what state the work is in and what's needed"

  require_workgroup
  local f state owner
  f="$(file_for "$slug")"
  IFS=$'\t' read -r state owner _ <<<"$(inspect "$f")"

  # A pause is an explicit operator direction, not an owner-managed handoff.
  # Preserve it until `resume` records the new instruction through cmd_take.
  if [ "$state" = "paused" ]; then
    echo "REFUSED — $slug is explicitly paused by the operator. Resume it only after a new explicit instruction; a pause cannot be parked." >&2
    exit 3
  fi

  if [ -f "$f" ] && [ "$owner" != "$(me)" ]; then
    if [ "$state" = "live" ]; then
      echo "REFUSED — $slug is held live by $owner. Park only your own claim." >&2
      exit 3
    fi
    echo "REFUSED — $slug is $state, held by $owner. Take it over first, then park." >&2
    exit 3
  fi

  local claimed_at ttl_hours thread_id
  if [ -f "$f" ]; then
    claimed_at="$(jq -r '.claimed_at // empty' "$f")"
    ttl_hours="$(jq -r '.ttl_hours // empty' "$f")"
    thread_id="$(jq -r '.thread_id // empty' "$f")"
    [ -n "$source" ] || source="$(jq -r '.source // empty' "$f")"
  else
    claimed_at="" ttl_hours="" thread_id=""
  fi
  [ -n "$claimed_at" ] || claimed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -n "$thread_id" ] || thread_id="${NANOCLAW_THREAD_ID:-}"
  local owner_out="${owner:-$(me)}"

  local tmp
  tmp="$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")"
  jq -n --arg owner "$owner_out" --arg sid "$(hostname)" \
        --arg tid "$thread_id" --arg claimed_at "$claimed_at" \
        --arg parked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson ttl "${ttl_hours:-null}" --arg note "$note" --arg source "$source" \
     '{owner:$owner, session_id:$sid, claimed_at:$claimed_at, status:"parked",
       parked_at:$parked_at, note:$note}
      + (if $ttl == null then {} else {ttl_hours:$ttl} end)
      + (if $tid == "" then {} else {thread_id:$tid} end)
      + (if $source == "" then {} else {source:$source} end)' > "$tmp"

  ledger_append parked "$slug" "$owner_out" "$note" "$claimed_at" "$thread_id" ""
  mv "$tmp" "$f"   # same-directory rename: no reader ever sees a partial file

  echo "parked $slug"
}

cmd_pause() {
  local slug="${1:-}"; shift || usage
  [ -n "$slug" ] || usage
  local source="" note_parts=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) source="${2:-}"; shift 2 ;;
      *)        note_parts+=("$1"); shift ;;
    esac
  done
  local note="${note_parts[*]:-}"
  [ -n "$note" ] || die "a pause reason is required — name the explicit operator direction and resume condition"

  require_workgroup
  local f owner claimed_at ttl_hours thread_id
  f="$(file_for "$slug")"
  [ -f "$f" ] || die "no claim at $slug — pause an existing claimed unit, never an unclaimed slug"
  owner="$(jq -r '.owner // "unknown"' "$f")"
  if [ "$owner" != "$(me)" ]; then
    echo "REFUSED — $slug belongs to $owner. Only the current owner may record an operator pause." >&2
    exit 3
  fi
  claimed_at="$(jq -r '.claimed_at // empty' "$f")"
  ttl_hours="$(jq -r '.ttl_hours // empty' "$f")"
  thread_id="$(jq -r '.thread_id // empty' "$f")"
  [ -n "$source" ] || source="$(jq -r '.source // empty' "$f")"
  [ -n "$claimed_at" ] || claimed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local tmp
  tmp="$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")"
  jq -n --arg owner "$owner" --arg sid "$(hostname)" \
        --arg tid "$thread_id" --arg claimed_at "$claimed_at" \
        --arg paused_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson ttl "${ttl_hours:-null}" --arg note "$note" --arg source "$source" \
     '{owner:$owner, session_id:$sid, claimed_at:$claimed_at, status:"paused",
       paused_at:$paused_at, note:$note}
      + (if $ttl == null then {} else {ttl_hours:$ttl} end)
      + (if $tid == "" then {} else {thread_id:$tid} end)
      + (if $source == "" then {} else {source:$source} end)' > "$tmp"

  ledger_append paused "$slug" "$owner" "$note" "$claimed_at" "$thread_id" ""
  mv "$tmp" "$f"   # same-directory rename: no reader sees a partial file
  echo "paused $slug"
}

# take records thread_id once, at claim time, and only if the claiming session
# had one. A relayer claiming on someone else's behalf, or a task session, has
# no thread — and the agent that later works the claim IN a thread had no way to
# say so. The Observatory renders a "steer in thread" link off this field, so a
# claim without it is an ownership record nobody can reach. Hence: set it after
# the fact, from wherever the work actually ended up.
cmd_thread() {
  local slug="${1:-}"; shift || usage
  [ -n "$slug" ] || usage
  [ $# -le 1 ] || usage
  local tid="${1:-${NANOCLAW_THREAD_ID:-}}"
  [ -n "$tid" ] || die "no thread id — pass one, or run this from a thread session where NANOCLAW_THREAD_ID is set"

  require_workgroup
  local f owner note claimed_at
  f="$(file_for "$slug")"
  [ -f "$f" ] || die "no claim at $slug — take it first, then record its thread"
  owner="$(jq -r '.owner // "unknown"' "$f")"
  if [ "$owner" != "$(me)" ]; then
    echo "REFUSED — $slug belongs to $owner. Record the thread on your own claim." >&2
    exit 3
  fi
  note="$(jq -r '.note // ""' "$f")"
  claimed_at="$(jq -r '.claimed_at // empty' "$f")"

  local tmp
  tmp="$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")"
  jq --arg tid "$tid" '.thread_id = $tid' "$f" > "$tmp"
  ledger_append thread "$slug" "$owner" "$note" "$claimed_at" "$tid" ""
  mv "$tmp" "$f"   # same-directory rename: no reader ever sees a partial file

  echo "recorded thread $tid on $slug"
}

# --- attribution events -----------------------------------------------------
#
# A claim says who HOLDS a unit of work. These say who actually reviewed and who
# actually merged it, at which head. The retro that produced them found the two
# were being inferred from whoever happened to be talking in the thread — an
# executor and a claim owner are frequently different agents, and nothing on
# disk recorded the difference.
#
# Positional and fixed-arity on purpose: an event with a field guessed from
# position is worse than no event, so arity is checked exactly and every field
# must be non-empty ("none" is the sanctioned placeholder for claim_owner).

require_args() {
  local want="$1" verb="$2"; shift 2
  [ "$#" -eq "$want" ] || die "$verb takes exactly $want arguments, got $# — see 'claim.sh' usage"
  local a
  for a in "$@"; do
    [ -n "$a" ] || die "$verb: empty argument — every field is required (use \"none\" where a value genuinely does not exist)"
  done
}

# pr is emitted as a NUMBER, matching the pr field cleared_merged already writes,
# so one `jq 'select(.pr==1296)'` finds a slug's whole history across event types.
require_pr() {
  case "$1" in ''|*[!0-9]*) die "pr must be a bare number (1296, not '#1296' or a url)" ;; esac
}

review_lease_key() {
  # A hash keeps untrusted repo/reviewer strings out of filenames while the
  # complete identity remains auditable inside the JSON lease.
  printf '%s\037%s\037%s\037%s' "$1" "$2" "$3" "$4" | sha256sum | awk '{print $1}'
}

review_lease_active() {
  local f="$1" now="$2" expires
  expires="$(jq -r '.expires_at // empty' "$f" 2>/dev/null)" || return 2
  [ -n "$expires" ] || return 2
  expires="$(date -u -d "$expires" +%s 2>/dev/null)" || return 2
  [ "$expires" -gt "$now" ]
}

cmd_record_review_start() {
  local parallel_reason=""
  if [ "${5:-}" = "--parallel" ]; then
    parallel_reason="${6:-}"
    [ -n "$parallel_reason" ] || die "--parallel requires the concrete risk that needs another reviewer"
    [ "$#" -eq 6 ] || usage
    set -- "$1" "$2" "$3" "$4"
  else
    require_args 4 record-review-start "$@"
  fi
  require_pr "$2"
  require_workgroup
  local repo="$1" pr="$2" head="$3" reviewer="$4" lease_dir lease_key
  lease_dir="$CLAIMS_DIR/review-leases"
  lease_key="$(review_lease_key "$repo" "$pr" "$head" "$reviewer")"
  mkdir -p "$lease_dir"

  (
    flock -x 200
    local now_epoch existing existing_repo existing_pr existing_head existing_reviewer status
    now_epoch="$(date -u +%s)"
    for existing in "$lease_dir"/*.json; do
      [ -f "$existing" ] || continue
      existing_repo="$(jq -r '.repo // empty' "$existing" 2>/dev/null)" || { echo "REFUSED — malformed review lease $existing" >&2; exit 2; }
      existing_pr="$(jq -r '.pr // empty' "$existing" 2>/dev/null)" || { echo "REFUSED — malformed review lease $existing" >&2; exit 2; }
      existing_head="$(jq -r '.head_sha // empty' "$existing" 2>/dev/null)" || { echo "REFUSED — malformed review lease $existing" >&2; exit 2; }
      [ "$existing_repo" = "$repo" ] && [ "$existing_pr" = "$pr" ] && [ "$existing_head" = "$head" ] || continue
      if review_lease_active "$existing" "$now_epoch"; then
        existing_reviewer="$(jq -r '.reviewer // "unknown"' "$existing")"
        # --parallel is for a second independent reviewer, not a second
        # execution of the same reviewer identity.  The lease key includes
        # that identity, so admitting this case would overwrite its active
        # lease and let one verdict erase another active review.
        if [ "$existing_reviewer" = "$reviewer" ]; then
          echo "REFUSED — $repo#$pr @$head already has an active review by $reviewer. Parallel review requires a distinct reviewer identity." >&2
          exit 3
        fi
        if [ -z "$parallel_reason" ]; then
          echo "REFUSED — $repo#$pr @$head already has an active review by $existing_reviewer. Reuse its receipt, or pass --parallel with the concrete independent risk." >&2
          exit 3
        fi
      else
        status=$?
        if [ "$status" -eq 2 ]; then
          echo "REFUSED — malformed review lease $existing" >&2
          exit 2
        fi
        rm -f "$existing"
      fi
    done

    local started_at expires_at line tmp
    started_at="$(now_utc)"
    expires_at="$(date -u -d "+ $REVIEW_LEASE_TTL_SECONDS seconds" +%Y-%m-%dT%H:%M:%SZ)"
    line="$(jq -nc --arg ts "$started_at" --arg repo "$repo" --argjson pr "$pr" \
      --arg head_sha "$head" --arg reviewer "$reviewer" --arg parallel_reason "$parallel_reason" \
      '{ts:$ts, event:"review_start", repo:$repo, pr:$pr, head_sha:$head_sha, reviewer:$reviewer}
       + (if $parallel_reason == "" then {} else {parallel_reason:$parallel_reason} end)')"
    ledger_write_line "$line"
    tmp="$(mktemp "$lease_dir/.tmp.XXXXXX")"
    jq -n --arg repo "$repo" --argjson pr "$pr" --arg head_sha "$head" \
      --arg reviewer "$reviewer" --arg owner "$(me)" --arg started_at "$started_at" --arg expires_at "$expires_at" \
      '{repo:$repo, pr:$pr, head_sha:$head_sha, reviewer:$reviewer, owner:$owner,
        started_at:$started_at, expires_at:$expires_at}' > "$tmp"
    mv "$tmp" "$lease_dir/$lease_key.json"
  ) 200>"$CLAIMS_DIR/.review-leases.lock"
  echo "recorded review_start: $repo#$pr @$head by $reviewer"
}

cmd_record_verdict() {
  require_args 5 record-verdict "$@"
  require_pr "$2"
  require_workgroup
  local repo="$1" pr="$2" head="$3" reviewer="$4" verdict="$5" lease_dir lease_key
  lease_dir="$CLAIMS_DIR/review-leases"
  lease_key="$(review_lease_key "$repo" "$pr" "$head" "$reviewer")"
  mkdir -p "$lease_dir"

  (
    flock -x 200
    ledger_write_line "$(jq -nc --arg ts "$(now_utc)" --arg repo "$repo" --argjson pr "$pr" \
      --arg head_sha "$head" --arg reviewer "$reviewer" --arg verdict "$verdict" \
      '{ts:$ts, event:"review_verdict", repo:$repo, pr:$pr, head_sha:$head_sha,
        reviewer:$reviewer, verdict:$verdict}')"
    # Legacy review records may predate leases. Preserve attribution rather than
    # failing the verdict record; every new dispatch is still required to claim.
    rm -f "$lease_dir/$lease_key.json"
  ) 200>"$CLAIMS_DIR/.review-leases.lock"
  echo "recorded review_verdict: $repo#$pr @$head by $reviewer — $verdict"
}

# gate_ref is the releases/gates/<date>.jsonl reference this merge was authorized
# by, or "auto-lane" when the lane needed no human gate. It POINTS AT a gates
# file; it is never written INTO one.
cmd_record_merge() {
  require_args 7 record-merge "$@"
  require_pr "$2"
  require_workgroup
  ledger_write_line "$(jq -nc --arg ts "$(now_utc)" --arg repo "$1" --argjson pr "$2" \
    --arg executor "$3" --arg claim_owner "$4" --arg head_sha "$5" \
    --arg gate_ref "$6" --arg result "$7" \
    '{ts:$ts, event:"merge", repo:$repo, pr:$pr, executor:$executor,
      claim_owner:$claim_owner, head_sha:$head_sha, gate_ref:$gate_ref, result:$result}')"
  echo "recorded merge: $1#$2 @$5 executed by $3 (claim owner $4, gate $6) — $7"
}

cmd_list() {
  require_workgroup
  local any=0 f slug state owner note
  for f in "$CLAIMS_DIR"/*.json; do
    [ -e "$f" ] || continue
    any=1
    slug="$(basename "$f" .json)"
    IFS=$'\t' read -r state owner note <<<"$(inspect "$f")"
    printf '%-8s %-12s %-34s %s\n' "$state" "$owner" "$slug" "$note"
  done
  [ "$any" -eq 1 ] || echo "no claims"
}

case "${1:-}" in
  check)   shift; cmd_check "$@" ;;
  take)    shift; cmd_take "$@" ;;
  park)    shift; cmd_park "$@" ;;
  pause)   shift; cmd_pause "$@" ;;
  resume)  shift; cmd_resume "$@" ;;
  thread)  shift; cmd_thread "$@" ;;
  release) shift; cmd_release "$@" ;;
  list)    shift; cmd_list "$@" ;;
  record-review-start) shift; cmd_record_review_start "$@" ;;
  record-verdict)      shift; cmd_record_verdict "$@" ;;
  record-merge)        shift; cmd_record_merge "$@" ;;
  *)       usage ;;
esac
