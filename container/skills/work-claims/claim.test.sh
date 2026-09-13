#!/usr/bin/env bash
# Claim lifecycle, the two refusals that protect a sibling's live work, and the
# merged-PR exception (gh stubbed via PATH so the verify runs offline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAIM="$SCRIPT_DIR/claim.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/workgroup/claims" "$ROOT/bin"
export CLAIMS_DIR="$ROOT/workgroup/claims"
export PATH="$ROOT/bin:$PATH"
export NANOCLAW_ASSISTANT_NAME=ava
export NANOCLAW_THREAD_ID=slack:C0AAA:1786621514.008659

# gh stub — PR number decides the state, so both branches are exercised.
cat > "$ROOT/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$3" in
  733) echo MERGED ;;
  *)   echo OPEN ;;
esac
STUB
chmod +x "$ROOT/bin/gh" "$CLAIM"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Unclaimed reads free.
bash "$CLAIM" check acme-pr-733 | grep -q '^unclaimed' || fail "fresh slug not unclaimed"

# 2. Taking records every field, including thread_id from the environment.
bash "$CLAIM" take acme-pr-733 4 publish-gate seam >/dev/null
jq -e '
  .owner == "ava" and .ttl_hours == 4 and
  .thread_id == "slack:C0AAA:1786621514.008659" and
  .note == "publish-gate seam" and (.claimed_at | endswith("Z"))
' "$CLAIMS_DIR/acme-pr-733.json" >/dev/null || fail "claim fields wrong"

# 3. Your own live claim reads YOURS, not LIVE — you are not blocked by yourself.
bash "$CLAIM" check acme-pr-733 | grep -q '^YOURS' || fail "own claim not YOURS"

# 4. A sibling's live claim is refused with exit 3, and the file is untouched.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pr-733 4 stealing it >/dev/null 2>&1 \
  && fail "took a live claim off a sibling"
[ "$(NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" check acme-pr-733 >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "sibling check did not exit 3 on a live claim"
[ "$(jq -r .owner "$CLAIMS_DIR/acme-pr-733.json")" = ava ] || fail "refused take still wrote"

# 5. A sibling may not delete it either.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" release acme-pr-733 >/dev/null 2>&1 \
  && fail "sibling deleted a live claim"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] || fail "refused release still deleted"

# 6. Past its TTL the same claim goes stale and is takeable, and the takeover
#    is recorded in the note rather than silently overwriting the history.
jq '.claimed_at = "2020-01-01T00:00:00Z"' "$CLAIMS_DIR/acme-pr-733.json" > "$ROOT/t" \
  && mv "$ROOT/t" "$CLAIMS_DIR/acme-pr-733.json"
bash "$CLAIM" check acme-pr-733 | grep -q '^STALE' || fail "expired claim not stale"
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pr-733 4 resuming >/dev/null
jq -e '.owner == "bo" and (.note | startswith("took over stale claim from ava"))' \
  "$CLAIMS_DIR/acme-pr-733.json" >/dev/null || fail "stale takeover not recorded"

# 7. An unparseable claim is stale, never an indefinite lock on the slug.
echo '{"owner":"ghost","note":"no timestamps"}' > "$CLAIMS_DIR/broken.json"
bash "$CLAIM" check broken | grep -q '^STALE' || fail "unparseable claim wedged the slug"

# 8. The merged-PR exception verifies with gh instead of trusting the caller:
#    an OPEN pr is refused, a MERGED one clears a sibling's completed claim.
bash "$CLAIM" release acme-pr-733 --merged-pr 999 >/dev/null 2>&1 \
  && fail "cleared a sibling claim on an OPEN pr"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] || fail "OPEN-pr release still deleted"
bash "$CLAIM" release acme-pr-733 --merged-pr 733 >/dev/null || fail "MERGED release refused"
[ -f "$CLAIMS_DIR/acme-pr-733.json" ] && fail "MERGED release did not delete"

# 9. Releasing your own claim deletes it; releasing nothing is not an error.
bash "$CLAIM" take acme-seam 2 my own work >/dev/null
bash "$CLAIM" release acme-seam >/dev/null
[ -f "$CLAIMS_DIR/acme-seam.json" ] && fail "own release did not delete"
bash "$CLAIM" release never-existed >/dev/null || fail "releasing a missing claim errored"

# 10. A channel-level session (no thread) omits thread_id rather than writing "".
NANOCLAW_THREAD_ID= bash "$CLAIM" take acme-chan 4 channel level >/dev/null
jq -e 'has("thread_id") | not' "$CLAIMS_DIR/acme-chan.json" >/dev/null \
  || fail "empty thread id was written"

# 11. A note is mandatory, and a non-numeric ttl is rejected.
bash "$CLAIM" take acme-nonote 4 >/dev/null 2>&1 && fail "accepted a claim with no note"
bash "$CLAIM" take acme-badttl soon because >/dev/null 2>&1 && fail "accepted a non-numeric ttl"

# 12. No workgroup tree => skip the convention, exit 0, write nothing.
CLAIMS_DIR="$ROOT/absent/claims" bash "$CLAIM" check anything | grep -q 'does not apply' \
  || fail "missing workgroup tree did not skip"
[ -d "$ROOT/absent" ] && fail "skip path created a tree"

# 13. list renders one row per claim with its state.
bash "$CLAIM" list | grep -q 'broken' || fail "list omitted a claim"

# 14. Parking your own live claim rewrites it with status parked and appends
#     a "parked" ledger line carrying the note.
bash "$CLAIM" take acme-park 3 building the seam >/dev/null
bash "$CLAIM" park acme-park handed off, seam half-built, needs tests >/dev/null
jq -e '
  .status == "parked" and .owner == "ava" and
  .note == "handed off, seam half-built, needs tests" and
  (.parked_at | endswith("Z")) and (.claimed_at | endswith("Z"))
' "$CLAIMS_DIR/acme-park.json" >/dev/null || fail "park did not rewrite fields correctly"
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "parked" and .slug == "acme-park" and .owner == "ava" and
  .note == "handed off, seam half-built, needs tests"
' >/dev/null || fail "park did not write a ledger line"

# 15. check on a parked claim reads PARKED and free to take, exit 0.
bash "$CLAIM" check acme-park | grep -q '^PARKED — was ava:.*free to take' \
  || fail "parked claim did not read PARKED/free to take"

# 15b. A park nobody came back for lapses into stale — parked is a waypoint,
#      not a terminus. Backdate parked_at past PARK_GRACE_HOURS and re-check.
bash "$CLAIM" take acme-lapsed 3 seam work >/dev/null
bash "$CLAIM" park acme-lapsed stepping off, needs an owner >/dev/null
jq '.parked_at = "2020-01-01T00:00:00Z"' "$CLAIMS_DIR/acme-lapsed.json" > "$CLAIMS_DIR/.tmp" \
  && mv "$CLAIMS_DIR/.tmp" "$CLAIMS_DIR/acme-lapsed.json"
bash "$CLAIM" check acme-lapsed | grep -qi 'stale' \
  || fail "a park past its grace window did not lapse to stale"

# 15c. A park with NO ttl_hours still lapses — an absent field must not grant
#      immortality. park only carries ttl forward when the claim had one.
bash "$CLAIM" park acme-nottl advertising this, no ttl on the file >/dev/null
jq -e '.ttl_hours == null' "$CLAIMS_DIR/acme-nottl.json" >/dev/null \
  || fail "expected a park of an unclaimed slug to carry no ttl_hours"
jq '.parked_at = "2020-01-01T00:00:00Z"' "$CLAIMS_DIR/acme-nottl.json" > "$CLAIMS_DIR/.tmp" \
  && mv "$CLAIMS_DIR/.tmp" "$CLAIMS_DIR/acme-nottl.json"
bash "$CLAIM" check acme-nottl | grep -qi 'stale' \
  || fail "a ttl-less park past its grace window did not lapse to stale"

# 16. Parking an unclaimed slug creates it (coordinator advertising work).
bash "$CLAIM" park acme-fresh-park nobody started this yet, needs an owner >/dev/null
jq -e '.status == "parked" and .owner == "ava"' "$CLAIMS_DIR/acme-fresh-park.json" >/dev/null \
  || fail "parking an unclaimed slug did not create it"

# 17. take on a parked claim is always allowed and records the resume note.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-park 2 resuming the seam >/dev/null
jq -e '
  .owner == "bo" and .status != "parked" and
  (.note | startswith("resumed parked work from ava: "))
' "$CLAIMS_DIR/acme-park.json" >/dev/null || fail "take on parked did not record resume note"

# 17b. An explicit operator pause never lapses into stale work and cannot be
# resumed by an ordinary take. A deliberate `resume` leaves an audit trail.
bash "$CLAIM" take acme-pause 2 implementation held for operator >/dev/null
bash "$CLAIM" pause acme-pause "explicit operator hold; resume only after a new instruction" >/dev/null
jq -e '.status == "paused" and (.paused_at | endswith("Z"))' "$CLAIMS_DIR/acme-pause.json" >/dev/null \
  || fail "pause did not write explicit hold state"
[ "$(bash "$CLAIM" check acme-pause >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "paused claim was treated as takeable"
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pause 2 accidental resume >/dev/null 2>&1 \
  && fail "ordinary take resumed an explicit operator pause"
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" resume acme-pause 2 explicit operator resume >/dev/null
jq -e '.owner == "bo" and .status != "paused" and (.note | startswith("resumed explicit operator pause from ava: "))' \
  "$CLAIMS_DIR/acme-pause.json" >/dev/null || fail "explicit resume did not record the prior hold"

# 18. A sibling may not park another agent's LIVE claim; file untouched.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-park-live 4 owned by bo >/dev/null
[ "$(bash "$CLAIM" park acme-park-live nope >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "park of a sibling's live claim did not exit 3"
[ "$(jq -r .owner "$CLAIMS_DIR/acme-park-live.json")" = bo ] \
  || fail "refused park still wrote"

# 19. A sibling may not park another agent's STALE claim either — hint says
#     take it over first.
jq '.claimed_at = "2020-01-01T00:00:00Z"' "$CLAIMS_DIR/acme-park-live.json" > "$ROOT/t" \
  && mv "$ROOT/t" "$CLAIMS_DIR/acme-park-live.json"
bash "$CLAIM" check acme-park-live | grep -q '^STALE' || fail "expired park target not stale"
bash "$CLAIM" park acme-park-live nope >/dev/null 2>&1 \
  && fail "parked a sibling's stale claim"
[ "$(jq -r .owner "$CLAIMS_DIR/acme-park-live.json")" = bo ] \
  || fail "refused stale park still wrote"

# 20. release writes a "released" ledger line with the full note, before the
#     claim file disappears.
bash "$CLAIM" take acme-release-ledger 2 own work, needs the full note preserved >/dev/null
bash "$CLAIM" release acme-release-ledger >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "released" and .slug == "acme-release-ledger" and .owner == "ava" and
  .note == "own work, needs the full note preserved"
' >/dev/null || fail "release did not write a released ledger line with the full note"

# 21. --merged-pr clearing (a different owner than the caller) writes a
#     cleared_merged ledger line with the pr number.
NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-pr-733 4 publish-gate seam >/dev/null
bash "$CLAIM" release acme-pr-733 --merged-pr 733 >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "cleared_merged" and .slug == "acme-pr-733" and .pr == 733 and .owner == "bo"
' >/dev/null || fail "merged-pr release did not write cleared_merged with pr number"

# 22. Every ledger line is valid single-line JSON.
while IFS= read -r line; do
  echo "$line" | jq -e . >/dev/null || fail "ledger line is not valid JSON: $line"
done < "$CLAIMS_DIR/ledger.ndjson"

# 23. ledger.ndjson is never picked up by list.
bash "$CLAIM" list | grep -q 'ledger' && fail "list picked up the ledger file"

# 24. --source records assignment provenance on take and survives a park.
bash "$CLAIM" take acme-sourced 4 build the widget --source "QA hand-off run r123" >/dev/null
jq -e '.source == "QA hand-off run r123"' "$CLAIMS_DIR/acme-sourced.json" >/dev/null \
  || fail "take --source not recorded"
bash "$CLAIM" park acme-sourced half built, needs owner >/dev/null
jq -e '.source == "QA hand-off run r123" and .status == "parked"' \
  "$CLAIMS_DIR/acme-sourced.json" >/dev/null || fail "park dropped the source"

# 25. park --source sets provenance when advertising fresh work.
bash "$CLAIM" park acme-advertised needs an owner from the start --source "operator, #build" >/dev/null
jq -e '.source == "operator, #build"' "$CLAIMS_DIR/acme-advertised.json" >/dev/null \
  || fail "park --source not recorded"

# 26. A claim taken with no thread (relayer / task session) gets one backfilled
#     from the environment, overwritten by a later explicit id, and refuses
#     when there is neither an argument nor a variable to read.
NANOCLAW_THREAD_ID= bash "$CLAIM" take acme-backfill 4 claimed by a relayer >/dev/null
jq -e 'has("thread_id") | not' "$CLAIMS_DIR/acme-backfill.json" >/dev/null \
  || fail "backfill fixture started with a thread_id"
bash "$CLAIM" thread acme-backfill >/dev/null
jq -e '.thread_id == "slack:C0AAA:1786621514.008659"' "$CLAIMS_DIR/acme-backfill.json" >/dev/null \
  || fail "thread did not backfill from the environment"
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "thread" and .slug == "acme-backfill" and .owner == "ava" and
  .thread_id == "slack:C0AAA:1786621514.008659" and .note == "claimed by a relayer"
' >/dev/null || fail "thread did not write a ledger line"
bash "$CLAIM" thread acme-backfill discord:987:654 >/dev/null
jq -e '.thread_id == "discord:987:654" and .note == "claimed by a relayer" and .ttl_hours == 4' \
  "$CLAIMS_DIR/acme-backfill.json" >/dev/null || fail "second thread call did not overwrite in place"
NANOCLAW_THREAD_ID= bash "$CLAIM" thread acme-backfill >/dev/null 2>&1 \
  && fail "accepted a thread call with no id and no environment"

# 27. thread only touches your own claim, and a slug with no claim is an error.
NANOCLAW_THREAD_ID= NANOCLAW_ASSISTANT_NAME=bo bash "$CLAIM" take acme-thread-sib 4 bo owns this >/dev/null
[ "$(bash "$CLAIM" thread acme-thread-sib >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "thread on a sibling's claim did not exit 3"
jq -e 'has("thread_id") | not' "$CLAIMS_DIR/acme-thread-sib.json" >/dev/null \
  || fail "refused thread still wrote"
bash "$CLAIM" thread never-claimed >/dev/null 2>&1 && fail "threaded a slug with no claim"

# 28. The three attribution events append with exactly the documented fields.
#     pr is a NUMBER so one jq select finds a slug's history across event types.
GATES="$ROOT/workgroup/releases/gates"
mkdir -p "$GATES"
printf '{"gate":"human authorization record","pr":42}\n' > "$GATES/2026-08-29.jsonl"
GATES_BEFORE="$(cd "$GATES" && ls | sort && cat ./*.jsonl | sha256sum)"

bash "$CLAIM" record-review-start DEMO-REPO 42 abc1234 reviewer-a >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "review_start" and .repo == "DEMO-REPO" and .pr == 42 and
  .head_sha == "abc1234" and .reviewer == "reviewer-a" and (.ts | endswith("Z"))
' >/dev/null || fail "record-review-start did not write the documented fields"

# A second context cannot spend a duplicate review on the same immutable head.
[ "$(bash "$CLAIM" record-review-start DEMO-REPO 42 abc1234 reviewer-b >/dev/null 2>&1; echo $?)" = 3 ] \
  || fail "duplicate same-head review was not refused"

bash "$CLAIM" record-verdict DEMO-REPO 42 abc1234 reviewer-a NO_GO >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "review_verdict" and .repo == "DEMO-REPO" and .pr == 42 and
  .head_sha == "abc1234" and .reviewer == "reviewer-a" and .verdict == "NO_GO" and
  (.ts | endswith("Z"))
' >/dev/null || fail "record-verdict did not write the documented fields"
[ "$(find "$CLAIMS_DIR/review-leases" -name '*.json' -type f | wc -l)" = 0 ] \
  || fail "verdict did not release its review lease"

# A second review is possible only with a durable reason for the independent
# risk. It gets a separate lease and each verdict clears only its own lease.
bash "$CLAIM" record-review-start DEMO-REPO 43 def5678 reviewer-a >/dev/null
bash "$CLAIM" record-review-start DEMO-REPO 43 def5678 reviewer-b --parallel "migration rollback lens" >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "review_start" and .reviewer == "reviewer-b" and .parallel_reason == "migration rollback lens"
' >/dev/null || fail "parallel review did not record its reason"
[ "$(find "$CLAIMS_DIR/review-leases" -name '*.json' -type f | wc -l)" = 2 ] \
  || fail "parallel reviews did not hold distinct leases"
bash "$CLAIM" record-verdict DEMO-REPO 43 def5678 reviewer-a CLEAR >/dev/null
[ "$(find "$CLAIMS_DIR/review-leases" -name '*.json' -type f | wc -l)" = 1 ] \
  || fail "first parallel verdict cleared the wrong lease"
bash "$CLAIM" record-verdict DEMO-REPO 43 def5678 reviewer-b CLEAR >/dev/null

bash "$CLAIM" record-merge DEMO-REPO 42 executor-a reviewer-a abc1234 gates/2026-01-01.jsonl merged >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .event == "merge" and .repo == "DEMO-REPO" and .pr == 42 and .executor == "executor-a" and
  .claim_owner == "reviewer-a" and .head_sha == "abc1234" and
  .gate_ref == "gates/2026-01-01.jsonl" and .result == "merged" and (.ts | endswith("Z"))
' >/dev/null || fail "record-merge did not write the documented fields"

# 29. An executor with no claim behind it records claim_owner "none", and
#     "auto-lane" is an accepted gate_ref — the auto lane has no human gate.
bash "$CLAIM" record-merge DEMO-REPO 43 executor-a none def5678 auto-lane merged >/dev/null
tail -n1 "$CLAIMS_DIR/ledger.ndjson" | jq -e '
  .claim_owner == "none" and .gate_ref == "auto-lane" and .pr == 43
' >/dev/null || fail "record-merge rejected the none/auto-lane placeholders"

# 30. THE RULE THIS LAYER EXISTS FOR: an execution event never lands in a gates
#     file. releases/gates/*.jsonl are human AUTHORIZATION records; a merge or
#     review event appearing there is the audit failure, not a convenience.
[ "$(cd "$GATES" && ls | sort && cat ./*.jsonl | sha256sum)" = "$GATES_BEFORE" ] \
  || fail "recording events touched releases/gates/"
grep -rlE '"event":"(merge|review_start|review_verdict)"' "$GATES" 2>/dev/null \
  && fail "an execution event was written into a gates file"

# 30b. Even a CLAIMS_DIR misconfigured onto a gates tree refuses rather than
#      appending — the rule is enforced by the script, not by convention.
[ "$(CLAIMS_DIR="$GATES" bash "$CLAIM" record-merge XZO 1 a b c auto-lane merged >/dev/null 2>&1; echo $?)" = 2 ] \
  || fail "a gates-rooted CLAIMS_DIR was allowed to append"
[ -f "$GATES/ledger.ndjson" ] && fail "refused gates-rooted append still wrote a ledger"

# 31. Arity and emptiness are checked exactly — a field guessed from position is
#     worse than no event at all. Nothing is appended on a bad call.
LEDGER_LINES="$(wc -l < "$CLAIMS_DIR/ledger.ndjson")"
bash "$CLAIM" record-review-start DEMO-REPO 42 abc1234 >/dev/null 2>&1 \
  && fail "record-review-start accepted 3 of 4 arguments"
bash "$CLAIM" record-review-start DEMO-REPO 42 abc1234 reviewer-a extra >/dev/null 2>&1 \
  && fail "record-review-start accepted a 5th argument"
bash "$CLAIM" record-verdict DEMO-REPO 42 abc1234 reviewer-a >/dev/null 2>&1 \
  && fail "record-verdict accepted 4 of 5 arguments"
bash "$CLAIM" record-merge DEMO-REPO 42 executor-a reviewer-a abc1234 gates/x.jsonl >/dev/null 2>&1 \
  && fail "record-merge accepted 6 of 7 arguments"
bash "$CLAIM" record-verdict DEMO-REPO 42 abc1234 "" NO_GO >/dev/null 2>&1 \
  && fail "record-verdict accepted an empty reviewer"
bash "$CLAIM" record-review-start XZO "#42" abc1234 reviewer-a >/dev/null 2>&1 \
  && fail "record-review-start accepted a non-numeric pr"
[ "$(wc -l < "$CLAIMS_DIR/ledger.ndjson")" = "$LEDGER_LINES" ] \
  || fail "a rejected record call still appended to the ledger"

# 32. An unknown subcommand still fails loudly rather than becoming a no-op.
bash "$CLAIM" record-something-else DEMO-REPO 42 >/dev/null 2>&1 \
  && fail "an unknown subcommand did not fail"

# 33. Re-check every ledger line — including the new events — is single-line JSON.
[ "$(wc -l < "$CLAIMS_DIR/ledger.ndjson")" = "$(jq -s length "$CLAIMS_DIR/ledger.ndjson")" ] \
  || fail "ledger is not one JSON object per line"

echo "all claim.sh tests passed"
