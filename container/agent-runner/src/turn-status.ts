import { getConfig } from './config.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { getAgentMailbox } from './mailbox/index.js';

/**
 * Context occupancy is kept here, not on `TurnUsageInfo`: the usage ledger
 * stores per-turn deltas, and occupancy is an absolute reading that must not be
 * deltaed. It is also needed mid-turn, which the result-scoped ledger cannot serve.
 */

/**
 * Providers pass a finished number because the sum is provider-specific: Anthropic's `input_tokens` EXCLUDES
 * cache reads and writes (add all three), while Codex counts cached tokens as a SUBSET of input.
 */
let contextTokens: number | null = null;

let model: string | null = null;
let effort: string | null = null;
let ultracode = false;

/**
 * The model id the provider reports actually served the turn. `model` may be a
 * family alias (`opus`), so this wins when known. A per-turn measurement: it
 * clears per result.
 */
let servedModel: string | null = null;

/**
 * This session's own conversation. The subtext belongs only under replies in
 * it: stamping a cross-destination send leaks fleet configuration into
 * somebody else's conversation.
 */
let ownChannelType: string | null = null;
let ownPlatformId: string | null = null;

/**
 * Subagents deployed this turn, keyed by the provider's handle for one
 * deployment (Claude: Task tool_use id; Codex: child thread id) so a worker
 * emitting many frames counts once. `null` fields mean the provider did not say.
 */
const subagents = new Map<string, { type: string | null; model: string | null; effort: string | null }>();

/**
 * Called per request, not per turn. Zero is rejected with negatives: every real
 * request carries a prompt, so 0 means "no usable usage block" and must not
 * overwrite a good reading.
 */
export function recordContextTokens(tokens: number | null | undefined): void {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return;
  const next = Math.round(tokens);
  if (next === contextTokens && !persistFailed) return;
  contextTokens = next;
  persist();
}

/** Ignores the SDK's placeholder ids (`<synthetic>`), which name no model. */
export function recordServedModel(id: string | null | undefined): void {
  if (typeof id !== 'string') return;
  const next = id.trim();
  if (!next || next.startsWith('<')) return;
  if (next === servedModel && !persistFailed) return;
  servedModel = next;
  persist();
}

/**
 * `nextModel` must be the provider's RESOLVED model, not the request: an
 * unpinned turn requests nothing.
 */
export function setTurnSettings(nextModel?: string | null, nextEffort?: string | null, nextUltracode?: boolean): void {
  model = nextModel ?? null;
  effort = nextEffort ?? null;
  ultracode = nextUltracode === true;
  persist();
}

/**
 * Forget the per-turn measurements, or a turn with no usable usage frame would
 * print the previous turn's figure. Call per RESULT, after that result's
 * dispatches, not at `emitTurnEnd`: one query serves many turns. Model and
 * effort survive: they are standing configuration.
 */
export function clearContextTokens(): void {
  if (contextTokens === null && servedModel === null && !persistFailed) return;
  contextTokens = null;
  servedModel = null;
  persist();
}

export function setOwnConversation(channelType?: string | null, platformId?: string | null): void {
  ownChannelType = channelType ?? null;
  ownPlatformId = platformId ?? null;
  persist();
}

/**
 * FAILS CLOSED on an unknown route: a missing stamp is harmless, a wrong one
 * leaks fleet configuration into another conversation.
 */
export function isOwnConversation(channelType?: string | null, platformId?: string | null): boolean {
  if (!ownPlatformId || !platformId) return false;
  return channelType === ownChannelType && platformId === ownPlatformId;
}

/**
 * A scheduled task's platform post. An isolated task session's routing has no
 * platform, so without this the own-conversation gate leaves every task post
 * bare. Reads routing from the inbound DB so the MCP subprocess answers the same.
 */
function isTaskOutput(channelType?: string | null, platformId?: string | null): boolean {
  if (!channelType || !platformId || channelType === 'agent') return false;
  // A routing read that throws must cost a decoration, never the send.
  try {
    return getTaskSeriesId() !== null;
  } catch {
    return false;
  }
}

/**
 * The store is persisted to session state because `send_message` runs in a
 * separate MCP subprocess with its own empty copy of this module; an
 * in-memory-only store leaves its replies unstamped (single-process tests
 * cannot catch this). Every access is guarded: a decoration must never break a
 * write.
 */
const SNAPSHOT_KEY = 'status_subtext_snapshot';

interface Snapshot {
  model: string | null;
  effort: string | null;
  ultracode: boolean;
  contextTokens: number | null;
  servedModel?: string | null;
  ownChannelType: string | null;
  ownPlatformId: string | null;
  subagents?: [string, { type: string | null; model: string | null; effort: string | null }][];
}

/**
 * True in the process that SETS turn state. Its memory is authoritative and is
 * never hydrated from the DB, which may be stale after a failed persist. A process
 * that never sets state (the MCP subprocess, long-lived across turns) re-reads every time.
 */
let ownsStore = false;

function persist(): void {
  ownsStore = true;
  const snap: Snapshot = {
    model,
    effort,
    ultracode,
    contextTokens,
    servedModel,
    ownChannelType,
    ownPlatformId,
    subagents: [...subagents.entries()],
  };
  try {
    getAgentMailbox().operations.setState(SNAPSHOT_KEY, JSON.stringify(snap));
    persistFailed = false;
  } catch {
    // Remember the failure so the setters' skip-if-unchanged checks write again.
    persistFailed = true;
  }
}

let persistFailed = false;

export function hydrateTurnStatus(): boolean {
  if (ownsStore) return false;
  let raw: string | undefined;
  try {
    raw = getAgentMailbox().operations.getState(SNAPSHOT_KEY)?.value;
  } catch {
    forgetForeignState();
    return false;
  }
  if (!raw) {
    forgetForeignState();
    return false;
  }
  try {
    const snap = JSON.parse(raw) as Partial<Snapshot>;
    model = snap.model ?? null;
    effort = snap.effort ?? null;
    ultracode = snap.ultracode === true;
    contextTokens = typeof snap.contextTokens === 'number' ? snap.contextTokens : null;
    servedModel = typeof snap.servedModel === 'string' ? snap.servedModel : null;
    ownChannelType = snap.ownChannelType ?? null;
    ownPlatformId = snap.ownPlatformId ?? null;
    subagents.clear();
    for (const [key, fields] of snap.subagents ?? []) subagents.set(key, fields);
    return true;
  } catch {
    forgetForeignState();
    return false;
  }
}

/**
 * FAIL CLOSED in a non-owning process: keeping the last good read after a
 * failed one would answer for the PREVIOUS turn's conversation and stamp a send
 * to it.
 */
function forgetForeignState(): void {
  contextTokens = null;
  servedModel = null;
  model = null;
  effort = null;
  ultracode = false;
  ownChannelType = null;
  ownPlatformId = null;
  subagents.clear();
}

/**
 * MERGES per `key`: providers learn type, model and effort at different
 * moments, and a later call must not blank a field already known.
 */
export function recordSubagent(
  key: string,
  fields: { type?: string | null; model?: string | null; effort?: string | null },
): void {
  if (!key) return;
  const prior = subagents.get(key);
  const next = {
    type: fields.type ?? prior?.type ?? null,
    model: fields.model ?? prior?.model ?? null,
    effort: fields.effort ?? prior?.effort ?? null,
  };
  // Claude calls this once per worker frame; persist only on a real change.
  if (prior && prior.type === next.type && prior.model === next.model && prior.effort === next.effort && !persistFailed)
    return;
  subagents.set(key, next);
  persist();
}

export function clearSubagents(): void {
  if (subagents.size === 0 && !persistFailed) return;
  subagents.clear();
  persist();
}

/** Test seam — reset the store between cases. */
export function resetTurnStatus(): void {
  contextTokens = null;
  servedModel = null;
  model = null;
  effort = null;
  ultracode = false;
  ownChannelType = null;
  ownPlatformId = null;
  subagents.clear();
  ownsStore = false;
  persistFailed = false;
  try {
    getAgentMailbox().operations.deleteState(SNAPSHOT_KEY);
  } catch {
    // no mailbox in this test
  }
}

/** Test seam — make this process behave as the MCP subprocess does. */
export function _forgetOwnershipForTest(): void {
  ownsStore = false;
  contextTokens = null;
  servedModel = null;
  model = null;
  effort = null;
  ultracode = false;
  ownChannelType = null;
  ownPlatformId = null;
  subagents.clear();
}

/** `claude-opus-5[1m]` → `opus-5`; opencode slugs keep the part after the last `/`. */
export function shortModelName(raw: string): string {
  let name = raw.trim();
  const slash = name.lastIndexOf('/');
  if (slash !== -1) name = name.slice(slash + 1);
  name = name.replace(/\[[^\]]*\]$/, '');
  name = name.replace(/^claude-/, '');
  return name;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

const MAX_RENDERED_SUBAGENT_GROUPS = 3;

/**
 * `3 subagents: 2x sonnet-5/high, haiku/low`, grouped by rendered label. The
 * leading count is the true total even when the list is capped. Null when the
 * turn deployed nobody.
 */
export function formatSubagentRoster(): string | null {
  if (subagents.size === 0) return null;

  const groups = new Map<string, { label: string; count: number }>();
  for (const entry of subagents.values()) {
    const model = entry.model ? shortModelName(entry.model) : null;
    const label = [model ?? entry.type ?? null, entry.effort ?? null].filter(Boolean).join('/');
    const key = label || 'unknown';
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { label, count: 1 });
  }

  // An unlabeled group counts toward the total but is not listed: "1 subagent: 1" reads as a name.
  const ordered = [...groups.values()]
    .filter((g) => g.label !== '')
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const shown = ordered.slice(0, MAX_RENDERED_SUBAGENT_GROUPS);
  const hidden = ordered.length - shown.length;
  const rendered = shown.map((g) => (g.count > 1 ? `${g.count}x ${g.label}` : g.label));
  if (hidden > 0) rendered.push(`+${hidden} more`);

  const total = subagents.size;
  const noun = total === 1 ? 'subagent' : 'subagents';
  const detail = rendered.filter(Boolean).join(', ');
  return detail ? `${total} ${noun}: ${detail}` : `${total} ${noun}`;
}

export function formatStatusSubtext(): string | null {
  const parts: string[] = [];
  const shown = servedModel ?? model;
  if (shown) parts.push(shortModelName(shown));
  // `ultracode` forces xhigh AND turns on workflow orchestration, so it
  // displaces the effort value rather than printing `xhigh`.
  if (ultracode) parts.push('ultracode');
  else if (effort) parts.push(effort);
  if (contextTokens !== null) parts.push(`${formatTokens(contextTokens)} context`);
  // Variable-length, so last: it must not push the fixed facts off a narrow display.
  const roster = formatSubagentRoster();
  if (roster) parts.push(roster);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Never throws: `getConfig()` throws when config was never loaded, and a footer
 * must not take a reply down. Unreadable config answers NO, honouring a group's
 * opt-out.
 */
function statusSubtextEnabled(): boolean {
  try {
    return getConfig().statusSubtext;
  } catch {
    return false;
  }
}

/**
 * The only stamping decision, reached through `withStatusSubtext`. Both reply
 * paths (`<message>` envelopes and the `send_message` MCP tool, the default
 * with outcome reporting on) must go through it, or half the fleet is unstamped.
 *
 * Opt-in: only rows marked `agentReply` (runner-authored chat rows like the
 * `/clear` notice are also `kind: 'chat'`), only the own conversation or a task
 * post, and an existing `subtext` is never overwritten.
 */
export function stampStatusSubtext(msg: {
  kind: string;
  agentReply?: boolean;
  channel_type?: string | null;
  platform_id?: string | null;
  content: string;
}): string {
  if (msg.agentReply !== true || msg.kind !== 'chat') return msg.content;
  // Hydrate first: in the send_message subprocess nothing set this state in memory.
  hydrateTurnStatus();
  if (!isOwnConversation(msg.channel_type, msg.platform_id) && !isTaskOutput(msg.channel_type, msg.platform_id)) {
    return msg.content;
  }
  if (!statusSubtextEnabled()) return msg.content;
  const subtext = formatStatusSubtext();
  if (!subtext) return msg.content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return msg.content;
  const payload = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(payload, 'subtext')) return msg.content;
  payload.subtext = subtext;
  return JSON.stringify(payload);
}

/**
 * Stamps at the call site, then strips the marker. Not inside `writeMessageOut`:
 * `db/messages-out.ts` is a byte-identical upstream shim, and it builds the
 * mailbox payload field by field, so a marker would never reach it.
 */
export function withStatusSubtext<
  T extends { kind: string; channel_type?: string | null; platform_id?: string | null; content: string },
>(row: T & { agentReply?: boolean }): T {
  const { agentReply, ...rest } = row;
  return { ...(rest as unknown as T), content: stampStatusSubtext({ ...rest, agentReply }) };
}
