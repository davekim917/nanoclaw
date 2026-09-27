/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import {
  findDestinationRowByName,
  findDestinationRowByRouting,
  getDestinationRows,
  type DestinationRow,
} from './modules/mailbox/index.js';
import { outcomeReportingEnabled } from './outcome-reporting.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

export type SessionMode = { kind: 'chat' } | { kind: 'task'; taskId: string };

function rowToEntry(row: DestinationRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  return getDestinationRows().map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = findDestinationRowByName(name);
  return row ? rowToEntry(row) : undefined;
}

export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const row = findDestinationRowByRouting(channelType, platformId);
  return row ? rowToEntry(row) : undefined;
}

/** displayName is untrusted (adapters auto-create destinations from platform metadata): strip control chars so it cannot inject prompt structure. */
function sanitizeDisplayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name
    .replace(/[\r\n\t\x00-\x1f]+/g, ' ')
    .replace(/[`#*_~]/g, '')
    .slice(0, 80);
}

/**
 * Generate the system-prompt addendum: agent identity + communication
 * invariants + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, mode: SessionMode = { kind: 'chat' }): string {
  const sections: string[] = [];

  if (assistantName) {
    const workgroupId = typeof process !== 'undefined' ? process.env?.NANOCLAW_WORKGROUP_ID : undefined;
    // An explicit name -> user_id map stops the model collapsing a shared display-name prefix into a self-reference.
    const peerSpec = readPeersFromEnv();
    const selfUserId = peerSpec?.self?.userId;
    const selfChannelName = typeof peerSpec?.self?.name === 'string' ? sanitizeDisplayName(peerSpec.self.name) : '';
    const selfAliases = [
      selfUserId ? `canonical user_id \`<@${selfUserId}>\`` : '',
      selfChannelName ? `channel @-handle **@${selfChannelName}**` : '',
    ].filter(Boolean);
    const headerLines = [
      '# You are ' + assistantName,
      '',
      selfUserId
        ? `Your name is **${assistantName}** (${selfAliases.join('; ')}). Those aliases refer to YOU, never a peer. If a direct mention is routed to this session, answer it or state the concrete blocker; do not silently step back because another peer might own the thread. Use the name when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature; never @-mention yourself in outbound.`
        : `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
    ];
    if (workgroupId) {
      headerLines.push(
        '',
        `Your workgroup is **${workgroupId}** — this is the multi-agent tenant boundary you operate under. Peers in the same workgroup share your chat archive and memory; agents in other workgroups do not.`,
      );
    }
    sections.push(headerLines.join('\n'));

    const peerSection = buildPeersSection(peerSpec?.peers ?? []);
    if (peerSection) sections.push(peerSection);
  }

  // Must be in the appended system prompt, not only CLAUDE.md, which is not reliably loaded.
  sections.push(
    [
      '## Communication conventions',
      '',
      // Without this the agent sometimes emits "No response requested." as its whole turn.
      outcomeReportingEnabled()
        ? 'The harness posts the bounded receipt/liveness state. Answer explicit requests and questions through the structured tools; do not add a second acknowledgment or emit meta-responses like "No response requested."'
        : 'Answer explicit requests and questions directly. Do not emit meta-responses like "No response requested." or claim that a user message does not require a response.',
      '',
      'Never ask a user to paste API keys, OAuth tokens, passwords, or other credentials into chat. If a capability is unavailable due to missing credentials, say so and stop — do not suggest the user share the credential with you.',
    ].join('\n'),
  );

  sections.push(buildDestinationsSection(mode, outcomeReportingEnabled()));

  return sections.join('\n\n');
}

interface PeerEntry {
  name: string;
  userId?: string;
}

interface PeerSpec {
  self?: { name?: string; userId?: string };
  peers: PeerEntry[];
}

/** Fails soft: undefined when unset or malformed. */
function readPeersFromEnv(): PeerSpec | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.NANOCLAW_PEERS : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.peers)) {
      return parsed as PeerSpec;
    }
  } catch {
    // ignore — fall through to undefined
  }
  return undefined;
}

/** Case-insensitive peer match; lets the dispatcher recover a sibling addressed as a destination instead of dropping it. */
export function findPeerName(name: string): string | undefined {
  const spec = readPeersFromEnv();
  if (!spec) return undefined;
  const target = name.trim().toLowerCase();
  const match = spec.peers.find((p) => typeof p?.name === 'string' && p.name.trim().toLowerCase() === target);
  return match?.name;
}

function buildPeersSection(peers: PeerEntry[]): string | null {
  const cleaned = peers
    .map((p) => ({
      name: typeof p?.name === 'string' ? sanitizeDisplayName(p.name) : '',
      userId: typeof p?.userId === 'string' && /^[\w]+$/.test(p.userId) ? p.userId : undefined,
    }))
    .filter((p) => p.name.length > 0);
  if (cleaned.length === 0) return null;

  const lines = ['## Peer agents in this channel', ''];
  if (cleaned.length === 1) {
    const p = cleaned[0];
    const idSuffix = p.userId ? ` (canonical user_id \`<@${p.userId}>\`)` : '';
    lines.push(`You are sharing this channel with **${p.name}**${idSuffix}.`);
  } else {
    lines.push('You are sharing this channel with these peers:');
    lines.push('');
    for (const p of cleaned) {
      const idSuffix = p.userId ? ` (\`<@${p.userId}>\`)` : '';
      lines.push(`- **${p.name}**${idSuffix}`);
    }
  }
  lines.push('');
  lines.push(
    'Peers are NOT destinations. Do NOT address a peer with `<message to="<peer>">` or `send_message(to: "<peer>")` — there is no destination by that name and the message is dropped. To reach a peer, send to your normal channel destination (the one the request came `from`) and put `@<Peer>` in the message BODY. When referring to a peer in prose, use their full name from the list above — never a shared display-name prefix or shortened form. To hand off active work or coordinate next steps, `@`-mention the peer (e.g. `@<Name>`) in the body of that reply; the outbound rewriter resolves it to the peer\'s canonical user_id and wakes them. Stop @-mentioning only when the work is verifiably DONE.',
  );
  return lines.join('\n');
}

function buildDestinationsSection(mode: SessionMode, structuredReporting: boolean): string {
  const all = getAllDestinations();
  const lines = ['## Sending messages', ''];

  if (all.length === 0) {
    lines.push('You currently have no configured destinations. You cannot send messages until an admin wires one up.');
    if (mode.kind === 'chat') return lines.join('\n');
  } else if (all.length === 1) {
    const d = all[0];
    lines.push(`Your destination is \`${d.name}\`${destinationLabel(d)}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      lines.push(`- \`${d.name}\`${destinationLabel(d)}`);
    }
  }

  lines.push('');

  if (mode.kind === 'task') {
    lines.push(
      'This is an isolated task run with no attached chat. Only notify someone when the task asks you to. For a user-visible message, call `send_message` with an explicit named destination and purpose; for a file, call `send_file` with `to`. Always pass the explicit named destination.',
    );

    // A task run has no `here`; without this steer the agent escalates into a sibling agent, which reaches no person.
    const channelDestinations = all.filter((destination) => destination.type === 'channel');
    const agentDestinations = all.filter((destination) => destination.type === 'agent');
    if (channelDestinations.length > 0) {
      // No fallback channel list for an unrouted task: an unstamped task is --isolated and fail-closed by contract,
      // and offering channels would let it post anywhere.
      lines.push(
        '',
        `For user-visible escalation — a blocker, a question you need answered, anything a person has to act on — send to the destination named in this task's \`<task from="name">\` attribute. That is the conversation the task was created in, and where whoever scheduled it is watching.`,
        '',
        'If the task carries no `from`, it was created isolated on purpose. Send only when the task text itself names who to tell; do not pick a destination just because one is available.',
      );
      lines.push(
        '',
        "Keep the whole run in one place. Interim notes and the final escalation go to the SAME destination — do not report progress in one channel and the outcome in someone's DM.",
      );
      if (agentDestinations.length > 0) {
        const agentNames = agentDestinations.map((destination) => `\`${destination.name}\``).join(', ');
        lines.push(
          '',
          `${agentNames} ${agentDestinations.length === 1 ? 'is an agent-type destination' : 'are agent-type destinations'} — another agent, not a person. Route through one ONLY when this task explicitly calls for it, never as your default escalation path.`,
        );
      }
    }

    lines.push(
      '',
      `Your final output is not sent to the user. End with a concise work-log summary. It is recorded automatically in \`tasks/${mode.taskId}.md\`. Read that file when you need context from earlier runs. Use \`ncl tasks append-log --msg "…"\` only for optional mid-run notes.`,
    );
    return lines.join('\n');
  }

  lines.push(
    structuredReporting
      ? 'Public replies use the `send_message` tool with an explicit purpose. Omit `to` for the current conversation; pass a named destination only when the request explicitly asks you to reach a different channel, agent, or DM. Final and interim model text is an internal work record and is not delivered.'
      : 'Legacy final-response delivery is active: wrap public final text in `<message to="name">...</message>` (`to="here"` for this conversation) and put private scratchpad text in `<internal>...</internal>`. You may instead use `send_message`; omit `to` for this conversation and name a destination only when the request asks for another channel, agent, or DM.',
  );
  lines.push('');
  lines.push(
    'Keep the WHOLE conversation in the place it started. Progress updates, interim status, and the final result for work you were asked to do all go back to the destination the request came `from` — including across a long, multi-step task (e.g. a `/team-auto` run or a loop). Do NOT redirect status or completion reports to someone\'s DM, even the owner\'s, just because it feels like "telling them" — that splits the conversation across two places. Address a DM or a different channel ONLY when the person explicitly asked you to message there.',
  );
  lines.push('');
  if (structuredReporting)
    lines.push(
      'The harness posts bounded accepted/working state for a human-triggered turn. Use `send_message` for requested replies, a completed outcome, a material decision or urgent correction, and actionable handoffs. `purpose="progress"` records work internally. Do not send a second acknowledgment or unchanged status.',
    );
  return lines.join('\n');
}

function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.channelType) parts.push(d.channelType);
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}
