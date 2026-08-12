---
name: work-claims
description: >-
  Claim a unit of work (a PR, a code seam, an issue) before starting on it, so
  sibling agents in the same workgroup don't duplicate or clobber it. Use
  before starting substantive work on anything a sibling could concurrently
  pick up — opening or continuing a PR, building a named seam, working an
  issue — and after resuming from an idle-ceiling or host-restart kill, before
  resuming any in-flight seam. Not needed for read-only work, one-off
  questions, or work confined to your own private workspace.
---

# Work claims

A file-based convention — not a lock server — for sibling agents in a
workgroup to avoid duplicating work. Origin: a container killed by the
30-minute idle ceiling came back to find a sibling had already built five of
its six remaining seams, and its own open PR had been superseded and closed
with no record of who took it.

One claim = one file at `/workspace/workgroup/claims/<slug>.json`. If
`/workspace/workgroup` doesn't exist, this install hasn't enabled workgroup
shared FS — there's nothing to claim against, skip this convention.

`<slug>` is a stable id for the unit of work, not a random token —
`acme-pr-733`, `acme-seam-publish-gate`. Reuse the same slug every time you
touch that PR/seam/issue so siblings recognize it.

Claim shape:

```json
{
  "owner": "ava",
  "session_id": "a1b2c3d4",
  "claimed_at": "2026-08-10T18:22:00Z",
  "ttl_hours": 4,
  "note": "publish-gate seam, PR #733"
}
```

## Rules

1. **Check before starting** substantive work on a claimable unit.
2. **Write your claim before starting**, not after.
3. **Delete your claim on completion or handoff.**
4. **A claim past `claimed_at + ttl_hours` is stale** — anyone may take it
   over. Taking over means overwriting it with your own claim and a `note`
   that says it was a takeover.
5. **Never delete another agent's live (non-stale) claim.**
6. **After an idle-ceiling or host-restart recovery**, re-check the claim for
   whatever seam you were mid-work on before resuming — a sibling may have
   taken it over while you were down.

## Mechanics

```bash
CLAIMS_DIR=/workspace/workgroup/claims
mkdir -p "$CLAIMS_DIR"
SLUG="acme-pr-733"          # your stable slug for this unit of work
FILE="$CLAIMS_DIR/$SLUG.json"
```

**Check / stale test:**

```bash
if [ -f "$FILE" ]; then
  OWNER=$(jq -r .owner "$FILE")
  CLAIMED_AT=$(jq -r .claimed_at "$FILE")
  TTL=$(jq -r .ttl_hours "$FILE")
  EXPIRES=$(date -u -d "$CLAIMED_AT + ${TTL} hours" +%s)
  NOW=$(date -u +%s)
  if [ "$NOW" -gt "$EXPIRES" ]; then
    echo "STALE — owned by $OWNER, may be taken over"
  else
    echo "LIVE — owned by $OWNER, do not start this unless you are $OWNER"
  fi
else
  echo "unclaimed"
fi
```

**Claim (fresh or takeover) — atomic write:**

```bash
NOTE="publish-gate seam, PR #733"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp "$CLAIMS_DIR/.tmp.XXXXXX")
jq -n --arg owner "$NANOCLAW_ASSISTANT_NAME" --arg sid "$(hostname)" \
      --arg at "$NOW_ISO" --arg note "$NOTE" \
      '{owner:$owner, session_id:$sid, claimed_at:$at, ttl_hours:4, note:$note}' > "$TMP"
mv "$TMP" "$FILE"
```

`$NANOCLAW_ASSISTANT_NAME` is your own canonical name, already set in your
container's environment. `mktemp` + `mv` within the same directory is an
atomic rename — no other reader ever sees a half-written claim file.

**Release (only your own claim):**

```bash
if [ -f "$FILE" ] && [ "$(jq -r .owner "$FILE")" = "$NANOCLAW_ASSISTANT_NAME" ]; then
  rm "$FILE"
else
  echo "not your claim — do not delete"
fi
```

**Releasing means DELETING the file.** Do not stamp `released_at` or
`status: done` and leave it behind. A claim file is a live-work marker, not a
log — the record of what you did belongs in the PR, the ledger, or your own
notes. A finished claim left on disk keeps showing up as live work: it hides
the item from sweeps that skip claimed work, and it looks abandoned to anyone
reading the directory.

**One exception to "only your own": work that is provably complete.** If the
PR the claim names has MERGED, delete the claim whatever the owner says. The
ownership rule exists to stop you taking live work off someone — a merged PR
is not live work, and its owner is not coming back to tidy up. Verify the
merge first (`gh pr view <n> --json state,mergedAt`), never infer it from a
stale timestamp, and say in your report which claims you cleared and why.
Anything short of a confirmed merge, leave alone and escalate instead.

**List all live claims:**

```bash
for f in "$CLAIMS_DIR"/*.json; do
  [ -e "$f" ] || continue
  echo "$(basename "$f" .json): $(jq -c . "$f")"
done
```

## Known ceiling

No daemon and no garbage collection — stale claim files accumulate forever
and are only ever overwritten, never pruned. The take-over rule (rule 4) is
what keeps this working: a stale file is inert, it just sits there until
someone takes it over or deletes it on completion. If a workgroup's
`claims/` directory gets large enough that listing it is unpleasant, the
upgrade path is a host sweep that prunes files past some multiple of their
TTL — not a change to this skill.
