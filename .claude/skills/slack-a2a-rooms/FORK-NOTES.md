# Fork notes — slack-a2a-rooms

`SKILL.md` and the payload beside it are upstream's, byte-for-byte at
`b76fcb3db`. Nothing in the apply steps has been rewritten or removed. This
file records what the steps need that this install does not have yet.

**Requires the provisioning port (tracked separately).** Apply step 1 is a
precondition gate, so running the skill today stops there rather than
half-installing. The frontmatter description says so too, because descriptions
are the discovery mechanism and an agent picking this skill for a live request
would otherwise land in a workflow that cannot finish.

## Dependency

| Needed by | Symbol / path | State here |
|---|---|---|
| Apply step 1 (`effect:check`), step 2's `slack-a2a.ts` payload | `src/channels/slack-a2a-guard.ts` exporting `setBotInboundPolicy` | **Missing** |

The guard is the seam `slack-a2a.ts` registers its admission policy onto. It
ships with the Slack channel payload on upstream's `channels` branch and is not
on this fork's `channels` branch.

## What that changes about behaviour here

This install already carries a different answer to the same problem, and the
two are not compatible — which is why the port is a port and not a merge.
Upstream's guard drops every bot-authored inbound message at the bridge and
re-admits it only for rooms in `SLACK_A2A_ROOMS`. Here `isSiblingBotSender`
(`src/modules/permissions/access.ts`) admits sibling bots in every
conversation, and `src/channels/slack-hop-limit.ts` bounds a runaway per thread
at `SLACK_MAX_BOT_HOPS` (default 24, counting only this host's own bots).

Installing the guard therefore flips the default for bot-authored traffic
fork-wide, not just inside A2A rooms. That is a deliberate decision for
whoever lands the provisioning port, not a side effect to discover afterwards.
`slack-hop-limit.ts`'s header comment carries the full comparison.
