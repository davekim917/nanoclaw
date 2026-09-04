# Fork notes — slack-agent-flow

`SKILL.md`, `REMOVE.md`, `apply-fixtures.json` and the whole payload beside
them are upstream's, byte-for-byte at `b76fcb3db`. No apply step has been
rewritten, reordered or removed. This file records what those steps need that
this install does not have yet.

**Requires the provisioning port (tracked separately).** Apply steps 1 and 2
are precondition gates and both fail here today, so running the skill stops
before it copies anything.

## Dependencies, as the skill's own gates report them

Every row was produced by running the skill's two `effect:check` fences against
this tree, term by term. Seven of the twenty terms already pass and are listed
at the bottom.

### Slack channel payload

| Needed by | Symbol / path | State here |
|---|---|---|
| Step 1 | `src/channels/slack-lib.ts` (shared Web API client + token-key convention) | **Missing** |
| Step 1 | `src/channels/slack.ts` exporting `slackInstanceBridgeFactory` (native `SLACK_INSTANCES` registration) | **Missing** |
| Step 1 | `src/channels/slack-a2a.ts` | **Missing** — installed by `/slack-a2a-rooms`, which has its own dependency on `slack-a2a-guard.ts` |

### Trunk seams

| Needed by | Symbol / path | State here |
|---|---|---|
| Step 2 | `startChannelAdapter` in `src/channels/channel-registry.ts` (adapter hot-start after boot) | **Missing** |
| Step 2 | `registerDeliveryBatchPreview` in `src/delivery.ts` | **Missing** |
| Step 2 | mailbox delivery helper `session: Session) => Promise<void>` in `src/delivery.ts` | **Missing** |
| Step 2 | `trigger?: boolean` in `src/session-manager.ts` | **Missing** |
| Step 2 | `suppressCreatedNotify` in `src/modules/agent-to-agent/create-agent.ts` | **Missing** |
| Step 2 | `extendTool` in `container/agent-runner/src/mcp-tools/server.ts` (container tool-extension hook) | **Missing** |
| Step 2 | `registerChannelPreStep` in `setup/channels/companions.ts` | **Missing** — the file does not exist here |
| Step 2 | `src/project-doc-compose.ts` | **Missing** — this fork's equivalent composer is `src/claude-md-compose.ts` |
| Step 2 | `await action.decide` in `src/guard/guard.ts` (async-capable guard seam) | **Missing** |

The guard term is the one with teeth. Upstream's own note says a `guard()` that
does not await `decide` treats a returned Promise as an allow, so the flow's
`create_agent` and room-action guards would fail open. The check exists to turn
that into a fail-fast, and it does its job here.

### Step 3's `from-branch:channels` payload

Step 3 fetches twenty-one files with `nc:copy from-branch:channels`. They live
on upstream's `channels` branch; this fork's `channels` branch carries none of
them. Sampled and confirmed absent: `src/env-file.ts`,
`src/modules/slack-room-membership/index.ts`,
`src/modules/canvas-actions/index.ts`, `src/modules/slack-onboarding/index.ts`,
`container/agent-runner/src/mcp-tools/canvas.ts`,
`container/skills/slack-construct/SKILL.md`,
`container/skills/canvas-work/SKILL.md`,
`container/skills/welcome/addenda/slack.md`.

### Blocking conflicts with this fork's rules

These are not missing substrate. They are places where upstream's shipped
content and this install's standing rules disagree, so the provisioning port
has to decide them rather than discover them.

| What | Where | Tracked |
|---|---|---|
| The prerequisite puts `NANOCLAW_INSTALL_TOKEN` / `SLACK_MANAGER_TOKEN` in `.env`, and the provisioner reads them from disk. This fork keeps secrets in the OneCLI gateway, injected per request, never on disk — and a workspace-level app-creation token is as privileged as Slack credentials get. | `SKILL.md` prerequisites; `src/modules/slack-agent-flow/env-file.ts`, `provision.ts` | [#387](https://github.com/davekim917/nanoclaw/issues/387) |
| `resolveRoomFamily` matches a room by name across **every** messaging group with no caller or workgroup scoping, and `ensureAgentRoom` opens and wires the replacement MPIM before the `callerInRoom` check runs. `add_to_room` can therefore pull another workgroup's room and its members across the data-pool boundary. | `src/modules/slack-agent-flow/room-actions.ts` (`resolveRoomFamily`) | [#388](https://github.com/davekim917/nanoclaw/issues/388) |

Neither is reachable today, because both apply gates stop the install. Both
become live the moment the port makes it applicable.

### Runtime credential

The flow's prerequisites call for `NANOCLAW_INSTALL_TOKEN` (managed broker) or
`SLACK_MANAGER_TOKEN` (workspace-level app creation) in `.env`. Neither is
configured here. Without one the Slack leg reports `no-credentials` rather than
failing, so this is a prerequisite rather than a gate.

### Terms that already pass

`src/channels/slack.ts`; `export const SLACK_DEFAULTS`; `findCliResponse` in
the runner's `db/messages-in.ts`; `Promise<number>` in the runner's
`db/messages-out.ts`; and `dedupeKey?: string`, `declineText?: string`,
`fyiText?: string` in `src/modules/permissions/sender-approval.ts`.

## Setup-wizard leg

Upstream's `bcc53e88b` also edits `setup/channels/run-channel-skill.ts` and
`setup/channels/slack-auto-register.ts` so the wizard applies declared
companions from the checkout. Those edits are outside both skill directories
and are not part of this port; they belong with the provisioning work, next to
`setup/channels/companions.ts`.
