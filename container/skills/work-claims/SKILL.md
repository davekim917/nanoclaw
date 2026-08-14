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
  "thread_id": "slack:C0AAA:1786621514.008659",
  "claimed_at": "2026-08-10T18:22:00Z",
  "ttl_hours": 4,
  "note": "publish-gate seam, PR #733"
}
```

`thread_id` is `$NANOCLAW_THREAD_ID` verbatim — your own routing id, already in
your environment. Write it unedited and omit the field when the variable is
empty (a channel-level session has no thread). It is what lets an abandoned-
claim alert link a human back to where the work was happening; `session_id` is
a local nickname and cannot. Never hand-assemble one.

## Rules

1. **Check before starting** substantive work on a claimable unit.
2. **Write your claim before starting**, not after.
3. **Delete your claim on completion or handoff** (release), **or park it**
   if you're stopping without finishing — see states below.
4. **A claim past `claimed_at + ttl_hours` is stale** — anyone may take it
   over. Taking over means overwriting it with your own claim and a `note`
   that says it was a takeover.
5. **Never delete or park another agent's live (non-stale) claim.**
6. **After an idle-ceiling or host-restart recovery**, re-check the claim for
   whatever seam you were mid-work on before resuming — a sibling may have
   taken it over while you were down.

## The four states

`claimed` (live, TTL-bound) → `parked` (off it, NOT done — a third state for
the case that used to get stuffed into a note like "RELEASED, not done") →
either `taken` (a sibling or you resumes it, always allowed regardless of who
parked it) or `released` (deleted, done). A stale claim (past its TTL) is a
variant of `claimed` that anyone may take over; `parked` overrides TTL
entirely — a parked claim is never stale, it just sits there until someone
takes it.

## Mechanics — always the script, never hand-rolled JSON

```bash
CLAIM=/app/skills/work-claims/claim.sh

bash $CLAIM check   acme-pr-733
bash $CLAIM take    acme-pr-733 4 "publish-gate seam, PR #733" --source "QA hand-off run r123"
bash $CLAIM park    acme-pr-733 "not done: schema done, handlers TODO"
bash $CLAIM release acme-pr-733
bash $CLAIM list
```

`--source` (optional, on `take` and `park`) records where the assignment came
from — a QA hand-off, a human in a channel, a review thread. Everything else
you might want to record (PR, branch, files) belongs in the note as prose.

**Do not assemble a claim with `jq` yourself.** The fields are not a shape to
remember — `owner`, `session_id` and `thread_id` all come from your environment,
and the script reads them for you. This replaced a hand-written snippet, and the
reason is worth one line: when `thread_id` was added, 0 of 16 live claims carried
it, and the first claim written afterwards left it out too, with the variable set
and the updated skill mounted. Agents write from memory of a format. There is now
nothing to remember.

Exit codes make it scriptable: **0** ok, **2** usage error, **3** held live by
another agent. So `bash $CLAIM check <slug> || exit` is a correct guard.

What the script enforces, so you do not have to:

- Atomic same-directory `mktemp` + `mv` — no reader ever sees a half-written file.
- `take` REFUSES a live claim that is not yours (exit 3). `--takeover` records an
  override; it does not make one correct. Taking a **parked** claim is always
  allowed, whoever parked it — the note records `resumed parked work from <them>:`.
- A stale takeover keeps the previous owner in the note instead of erasing them.
- A claim with no parseable expiry counts as **stale**, never an indefinite lock —
  a corrupt file must not wedge a slug forever. `parked` overrides this: a parked
  claim is never reclassified as stale by its TTL.
- `park` REFUSES another agent's live claim (exit 3, same as `take`) and another
  agent's stale claim ("take it over first, then park") — you can only park your
  own claim, or an unclaimed slug (advertising work that needs an owner).
- `release` deletes only your own claim, and `--merged-pr <n>` verifies the merge
  against GitHub rather than trusting your assertion.
- `release` and `park` both append a line to `claims/ledger.ndjson` first —
  see below.
- No `/workspace/workgroup` → prints that the convention does not apply and exits
  0, so you can call it unconditionally.

The JSON shape above is still documented because you will READ claims — yours,
siblings', and the ones the digest reports. Reading them is normal; writing them
by hand is not.

**Releasing still means DELETING the file.** `release` writes your full note to
`claims/ledger.ndjson` automatically before it deletes, so deleting costs you
nothing — the record survives. Do not stamp `released_at` or `status: done`
and leave the claim file behind instead: a claim file is a live-work marker,
not a log, and a finished claim left on disk keeps showing up as live work —
it hides the item from sweeps that skip claimed work and looks abandoned to
anyone reading the directory. If you're stopping without finishing, that's
`park`, not a note left on a claim you keep — see states above.

`claims/ledger.ndjson` is append-only history: one JSON line per `released`,
`parked`, or `cleared_merged` event, each carrying the full note at that
moment. Read it ad hoc with `jq` (e.g. `jq 'select(.slug=="acme-pr-733")' claims/ledger.ndjson`
for one slug's history) — never edit it, and it never shows up in `list`.

**One exception to "only your own": work that is provably complete.** If the
PR the claim names has MERGED, delete the claim whatever the owner says. The
ownership rule exists to stop you taking live work off someone — a merged PR
is not live work, and its owner is not coming back to tidy up. Use
`bash $CLAIM release <slug> --merged-pr <n>` — it checks the PR state itself and
refuses on anything but `MERGED`, so the merge is never inferred from a stale
timestamp or from your own belief. Say in your report which claims you cleared
and why. Anything short of a confirmed merge, leave alone and escalate instead.

## Known ceiling

No daemon and no garbage collection — stale claim files accumulate forever
and are only ever overwritten, never pruned. The take-over rule (rule 4) is
what keeps this working: a stale file is inert, it just sits there until
someone takes it over or deletes it on completion. If a workgroup's
`claims/` directory gets large enough that listing it is unpleasant, the
upgrade path is a host sweep that prunes files past some multiple of their
TTL — not a change to this skill.
