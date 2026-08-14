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

CLAIMS_DIR="${CLAIMS_DIR:-/workspace/workgroup/claims}"
WORKGROUP_ROOT="$(dirname "$CLAIMS_DIR")"

die() { echo "$*" >&2; exit 2; }

usage() {
  cat >&2 <<'USAGE'
usage:
  claim.sh check   <slug>
  claim.sh take    <slug> <ttl_hours> <note...>   [--takeover]
  claim.sh park    <slug> <note...>
  claim.sh release <slug> [--merged-pr <n>]
  claim.sh list

exit codes: 0 ok · 2 usage/error · 3 held live by another agent
USAGE
  exit 2
}

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
ledger_append() {
  local event="$1" slug="$2" owner="$3" note="$4" claimed_at="$5" thread_id="$6" pr="$7"
  local lock="$CLAIMS_DIR/.ledger.lock" now line
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
  ( flock -x 200 && printf '%s\n' "$line" >> "$CLAIMS_DIR/ledger.ndjson" ) 200>"$lock" \
    || die "failed to append ledger entry for $slug — claim left in place"
}

# Echoes: state<TAB>owner<TAB>note   where state is unclaimed|yours|live|stale|parked
inspect() {
  local f="$1" owner claimed_at ttl expires now note status
  if [ ! -f "$f" ]; then printf 'unclaimed\t\t\n'; return; fi

  owner="$(jq -r '.owner // "unknown"' "$f")"
  note="$(jq -r '.note // ""' "$f")"
  status="$(jq -r '.status // ""' "$f")"
  claimed_at="$(jq -r '.claimed_at // empty' "$f")"
  ttl="$(jq -r '.ttl_hours // empty' "$f")"

  # A parked claim is a declared third state, not a timestamp — it wins over
  # TTL classification even if claimed_at/ttl_hours are still on the file.
  if [ "$status" = "parked" ]; then printf 'parked\t%s\t%s\n' "$owner" "$note"; return; fi

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
  esac
}

cmd_take() {
  local slug="${1:-}" ttl="${2:-}"; shift 2 2>/dev/null || usage
  [ -n "$slug" ] && [ -n "$ttl" ] || usage

  local takeover=0 note_parts=()
  for a in "$@"; do
    if [ "$a" = "--takeover" ]; then takeover=1; else note_parts+=("$a"); fi
  done
  local note="${note_parts[*]:-}"
  [ -n "$note" ] || die "a note is required — say what you are taking and why"
  case "$ttl" in ''|*[!0-9]*) die "ttl_hours must be a whole number of hours" ;; esac

  require_workgroup
  local f state owner
  f="$(file_for "$slug")"
  IFS=$'\t' read -r state owner _ <<<"$(inspect "$f")"

  if [ "$state" = "live" ] && [ "$takeover" -ne 1 ]; then
    echo "REFUSED — $slug is held live by $owner. Never take live work off a sibling." >&2
    echo "If they are genuinely gone, wait for it to go stale or escalate; --takeover only" >&2
    echo "records the override, it does not make it correct." >&2
    exit 3
  fi
  [ "$state" = "live" ] && note="TAKEOVER from $owner: $note"
  [ "$state" = "stale" ] && note="took over stale claim from $owner: $note"
  [ "$state" = "parked" ] && note="resumed parked work from $owner: $note"

  local tmp
  tmp="$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")"
  # thread_id is omitted rather than written empty — a channel-level session
  # has no thread, and an empty string would render as a broken link.
  jq -n --arg owner "$(me)" --arg sid "$(hostname)" \
        --arg tid "${NANOCLAW_THREAD_ID:-}" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson ttl "$ttl" --arg note "$note" \
     '{owner:$owner, session_id:$sid, claimed_at:$at, ttl_hours:$ttl, note:$note}
      + (if $tid == "" then {} else {thread_id:$tid} end)' > "$tmp"
  mv "$tmp" "$f"   # same-directory rename: no reader ever sees a partial file

  echo "claimed $slug for $(me), ttl ${ttl}h"
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
  local note="$*"
  [ -n "$note" ] || die "a note is required — say what state the work is in and what's needed"

  require_workgroup
  local f state owner
  f="$(file_for "$slug")"
  IFS=$'\t' read -r state owner _ <<<"$(inspect "$f")"

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
        --argjson ttl "${ttl_hours:-null}" --arg note "$note" \
     '{owner:$owner, session_id:$sid, claimed_at:$claimed_at, status:"parked",
       parked_at:$parked_at, note:$note}
      + (if $ttl == null then {} else {ttl_hours:$ttl} end)
      + (if $tid == "" then {} else {thread_id:$tid} end)' > "$tmp"

  ledger_append parked "$slug" "$owner_out" "$note" "$claimed_at" "$thread_id" ""
  mv "$tmp" "$f"   # same-directory rename: no reader ever sees a partial file

  echo "parked $slug"
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
  release) shift; cmd_release "$@" ;;
  list)    shift; cmd_list "$@" ;;
  *)       usage ;;
esac
