#!/usr/bin/env bash
# The sweep half of main-provenance.yml's job pair — see that workflow's header comment
# for the full split. Checks GitHub's repository Activity API over the last WINDOW_HOURS
# of main, instead of walking `git log --since`: `--since` filters on committer date, a
# value the pusher controls, so a backdated commit carrying a skip-CI commit-message
# marker would hide itself, and every earlier commit in the window, from a history walk
# (PR #656 round-2 review, P1 — a real fail-open, not hypothetical). The Activity API's
# `timestamp` is recorded by GitHub when it processed the ref update; nothing a push
# carries can forge it.
#
# Endpoint: GET /repos/{owner}/{repo}/activity ("List repository activities",
# https://docs.github.com/rest/repos/repos#list-repository-activities). GitHub's
# permissions-required-for-github-apps reference lists it under "Contents" read only —
# no pull-requests permission needed, unlike check-provenance-commit.sh's PR-link call.
#
# `time_period` only takes day/week/month/quarter/year (docs: "day will filter for
# activity that occurred in the past 24 hours, and week ... past 7 days (168 hours)"),
# not an arbitrary hour count, so this asks GitHub for `week` — the smallest option that
# safely covers WINDOW_HOURS — and applies the real cutoff client-side against each
# item's `timestamp`. `gh api --paginate` follows the Link-header cursor and merges every
# page's JSON array into one; this repo's busiest 50h stretch on main had 292 events
# (206 in one day) — well over one per_page=100 page, so pagination is load-bearing, not
# an optimization. `set -euo pipefail` plus the `$(...)` assignments below already fail
# the job if any page request errors: a simple command's exit status propagates through
# `set -e` even inside a command substitution assigned to a variable.
#
# A GitHub-made merge into main is recorded as activity_type `pr_merge` or, if this repo
# ever turns on a merge queue, `merge_queue_merge` — the same provenance guarantee a
# normal PR merge gives, so it's accepted too even though this repo does not use one
# today. `pr_merge` covers every way GitHub itself performs a merge, INCLUDING a rebase
# merge: this repo's one rebase merge (PR #74, see main-provenance.yml's header comment)
# shows up in the live feed as `pr_merge`, not `push` — confirmed via `gh api`, not
# guessed. So this sweep passes a legitimate rebase merge; only check-provenance-commit.sh's
# signed-tip check (which a rebase merge fails, since GitHub doesn't sign one) catches
# it. That split is fine: a rebase merge IS a genuine PR merge, just one this repo's
# separate signed-tip rule happens not to accept. Every other activity_type this repo's
# full history has ever produced on main — `push` and `force_push`
# (`branch_creation`/`branch_deletion` are still possible in principle, never observed)
# — reached main without a merged PR and fails the sweep.
#
# POLICY_START is a floor under the WINDOW_HOURS cutoff: six known, already-accepted
# direct pushes to main (2026-09-09T17:11Z through 2026-09-10T22:04Z, predating this
# check) would otherwise turn main red for days once WINDOW_HOURS next covers them. The
# floor is a timestamp after the last of those pushes; every push after it is new
# history this check is meant to catch.
#
# Freshness guard: the Activity API can lag a live push. Scanning a feed that hasn't
# caught up yet would either miss a real offender (worse than useless) or, in the
# degenerate case of an empty response, print "checked 0" and pass green for the wrong
# reason. Before scanning, this reads main's ACTUAL tip from the API — never
# `git rev-parse HEAD` or `${{ github.sha }}`, because a workflow_dispatch run from a
# non-main ref checks out that ref, and either of those would compare against the wrong
# commit — and requires it to appear somewhere in the full WEEK query (not the
# WINDOW_HOURS/POLICY_START-floored slice below: a quiet week with zero merges must
# still prove the feed reflects that, not silently pass because nothing matched a
# narrower window). The tip is read BEFORE the feed, so a merge landing mid-check can
# only make the feed more complete, never less. One retry after 60s absorbs ordinary
# lag; if the tip still isn't there, this fails rather than scan a feed that might be
# silently missing recent history — including the case of a genuinely empty feed, which
# is worth a human's attention, not a quiet pass.
#
# Usage: sweep-main-activity.sh [window_hours=50]
# Env: GH_TOKEN, REPO (both already required by `gh api` in the caller).
set -euo pipefail

window_hours="${1:-50}"
policy_start='2026-09-11T00:00:00Z'

if [ "$window_hours" -gt 168 ]; then
  echo "::error::window_hours=$window_hours exceeds the 168h (week) ceiling this script's time_period=week query can return" >&2
  exit 1
fi

fetch_main_tip() {
  gh api "repos/$REPO/commits/main" --jq '.sha'
}

fetch_activity_week() {
  gh api --paginate "repos/$REPO/activity?ref=refs/heads/main&time_period=week&per_page=100"
}

tip_in_feed() {
  jq -e --arg sha "$1" 'any(.[]; .after == $sha)' <<<"$2" >/dev/null
}

tip_sha=$(fetch_main_tip)
items=$(fetch_activity_week)

if ! tip_in_feed "$tip_sha" "$items"; then
  echo "main's tip ($tip_sha) is not yet in the Activity API's week feed; waiting 60s for lag and re-checking once"
  sleep 60
  tip_sha=$(fetch_main_tip)
  items=$(fetch_activity_week)
  if ! tip_in_feed "$tip_sha" "$items"; then
    echo "::error::main's tip ($tip_sha) never appeared in the Activity API feed after a 60s retry; the feed may be stale, lagging, or genuinely empty (no push to main this week) — failing rather than scan a feed that might be missing recent history" >&2
    exit 1
  fi
fi

window_cutoff_epoch=$(date -u -d "${window_hours} hours ago" +%s)
policy_start_epoch=$(date -u -d "$policy_start" +%s)
cutoff_epoch=$window_cutoff_epoch
[ "$policy_start_epoch" -gt "$cutoff_epoch" ] && cutoff_epoch=$policy_start_epoch
cutoff_iso=$(date -u -d "@$cutoff_epoch" -Iseconds)

in_window=$(jq --argjson cutoff "$cutoff_epoch" \
  '[.[] | select((.timestamp | fromdateiso8601) >= $cutoff)]' <<<"$items")
checked=$(jq 'length' <<<"$in_window")
echo "checked $checked activity record(s) on main since $cutoff_iso (last ${window_hours}h, floored at $policy_start)"

offenders=$(jq \
  '[.[] | select(.activity_type != "pr_merge" and .activity_type != "merge_queue_merge")]' \
  <<<"$in_window")
offender_count=$(jq 'length' <<<"$offenders")

if [ "$offender_count" -eq 0 ]; then
  echo "no activity outside a merged PR reached main since $cutoff_iso"
  exit 0
fi

jq -r '.[] | "::error::main moved to \(.after) via a \(.activity_type), not a merged PR (actor \(.actor.login // "unknown"), at \(.timestamp))"' <<<"$offenders"
exit 1
