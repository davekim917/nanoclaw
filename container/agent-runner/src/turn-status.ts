import { getConfig } from './config.js';

/**
 * The "what am I running on" line stamped under an agent's own replies.
 *
 * A long-lived thread drifts: `-m`/`-e` were set twenty turns ago and nobody
 * remembers what took effect. This module holds the three facts that answer
 * it — model, effort, and how much context the last request actually carried —
 * and renders them as one short line the delivery path turns into platform
 * subtext (Slack context block, Discord `-# `).
 *
 * WHY A MODULE-LEVEL STORE rather than a field on `TurnUsageInfo`: the two
 * numbers answer different questions and have different arithmetic. The usage
 * ledger reports a turn's DELTA — Claude's running totals are differenced by
 * `toTurnDelta` (modules/mailbox/turn-usage.ts) before they are written —
 * while context occupancy is an ABSOLUTE reading of the most recent request's
 * prompt. Routing it through the ledger's seam would mean either deltaing a
 * number that must not be deltaed, or carrying a "don't delta this one" flag
 * through code whose whole subject is deltas. It is also needed mid-turn, for
 * interim `<message>` blocks, which the result-scoped ledger cannot serve.
 *
 * One runner process serves one session, so a module-level store is the whole
 * lifetime that matters (same shape as runtime-context.ts).
 */

/**
 * Tokens occupying the context window as of the most recent provider request.
 *
 * Each provider reports this itself rather than handing over raw fields for a
 * shared seam to add up, because the addition is provider-specific and getting
 * it wrong is silent: Anthropic reports `input_tokens` EXCLUDING cache reads
 * and cache writes (so occupancy is the sum of all three), while OpenAI/Codex
 * reports cached tokens as a SUBSET of the input count (so the sum
 * double-counts the cached prefix). Providers call `recordContextTokens` with
 * a finished number.
 */
let contextTokens: number | null = null;

/** Effective model/effort for the turn in flight, as poll-loop resolved them. */
let model: string | null = null;
let effort: string | null = null;
let ultracode = false;

/**
 * The conversation this session belongs to, as poll-loop resolved it.
 *
 * The subtext describes the machinery answering YOU, so it belongs under a
 * reply in the thread you are in and nowhere else. A cross-destination send —
 * a sibling agent's DM, another channel, or a message the operator asked the
 * agent to relay on their behalf — carries somebody else's words to somebody
 * else's conversation, and stamping our model and context onto that would be
 * both noise and a small leak of how the fleet is configured.
 */
let ownChannelType: string | null = null;
let ownPlatformId: string | null = null;

/**
 * Record the context occupancy observed on a provider request.
 *
 * Called per request, not per turn: a turn makes many round trips and the
 * latest one is the honest reading.
 *
 * ZERO IS REJECTED ALONG WITH negatives and non-finites. Every real request
 * carries a prompt, so 0 never means "the window is empty" — it means the
 * provider reported nothing usable, which is how each provider's occupancy
 * helper signals an absent or empty usage block. Accepting it would let a
 * mid-turn frame that happens to carry no usage overwrite a good reading and
 * render `0 context` under the reply. The guard lives HERE rather than at the
 * three provider call sites so no future caller can forget it.
 */
export function recordContextTokens(tokens: number | null | undefined): void {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return;
  contextTokens = Math.round(tokens);
}

/**
 * Set the model/effort the turn in flight is running at.
 *
 * `nextModel` should be the provider's RESOLVED model, not what was requested:
 * an unpinned turn requests nothing and only the provider can say which model
 * the group default became (the same reasoning as `modelInForce` in
 * poll-loop.ts, whose value this mirrors).
 */
export function setTurnSettings(
  nextModel?: string | null,
  nextEffort?: string | null,
  nextUltracode?: boolean,
): void {
  model = nextModel ?? null;
  effort = nextEffort ?? null;
  ultracode = nextUltracode === true;
}

/**
 * Forget the context reading at a turn boundary.
 *
 * `recordContextTokens` deliberately ignores an absent reading, so without
 * this a turn that produces a reply WITHOUT a usable usage frame would inherit
 * the previous turn's figure — and print it beside whatever model is now in
 * force, asserting a stale measurement as belonging to the current reply. The
 * honest answer for missing telemetry is to omit the context part, which is
 * what an empty store renders.
 *
 * Called per RESULT, right before `closeResultScope` (poll-loop.ts), after
 * every dispatch for that result has run — so clearing never strips the figure
 * from the reply that earned it. NOT at `emitTurnEnd`: one query serves many
 * turns (its generator stays open for follow-up pushes), so emitTurnEnd fires
 * once per query and would let a later turn inherit an earlier turn's figure.
 * It still calls this as a backstop for a query that ends without a result.
 *
 * Model and effort deliberately SURVIVE: they describe the session's standing
 * configuration, not a measurement, and remain true until something changes
 * them.
 */
export function clearContextTokens(): void {
  contextTokens = null;
}

/**
 * Record which conversation is this session's own, for the own-voice gate.
 *
 * Set once per turn beside `setTurnSettings`, from the same `routing` the
 * turn is being processed under.
 */
export function setOwnConversation(channelType?: string | null, platformId?: string | null): void {
  ownChannelType = channelType ?? null;
  ownPlatformId = platformId ?? null;
}

/**
 * Is an outbound row addressed to this session's own conversation?
 *
 * FAILS CLOSED on an unknown route. A row with no platform, or one written
 * before any turn established the session's routing, answers NO — an
 * unstamped reply is a missing decoration, while a wrongly stamped one puts
 * the fleet's configuration into somebody else's conversation.
 */
export function isOwnConversation(channelType?: string | null, platformId?: string | null): boolean {
  if (!ownPlatformId || !platformId) return false;
  return channelType === ownChannelType && platformId === ownPlatformId;
}

/** Test seam — reset the store between cases. */
export function resetTurnStatus(): void {
  contextTokens = null;
  model = null;
  effort = null;
  ultracode = false;
  ownChannelType = null;
  ownPlatformId = null;
}

/**
 * Shorten a model id to what a human scanning a thread needs.
 *
 * `claude-opus-5[1m]` → `opus-5`; `anthropic/claude-opus-5` → `claude-opus-5`
 * (opencode slugs keep the segment after the last `/`, which is the model);
 * `gpt-5.4-codex` is already short and passes through. The `[1m]` suffix is a
 * context-window tag, not part of the model's name, and it is redundant beside
 * a context figure.
 */
export function shortModelName(raw: string): string {
  let name = raw.trim();
  const slash = name.lastIndexOf('/');
  if (slash !== -1) name = name.slice(slash + 1);
  name = name.replace(/\[[^\]]*\]$/, '');
  name = name.replace(/^claude-/, '');
  return name;
}

/**
 * Render a token count the way a status line should: `142k`, `7.2k`, `830`.
 * Rounded, never padded — this is a glanceable figure, not an accounting one.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * The line itself, or null when there is nothing worth showing.
 *
 * Parts are omitted individually: a provider that reports no context figure
 * still gets `opus-5 · high`, and a model the runner never resolved (a
 * provider running its own default) still gets the context figure. Null only
 * when every part is missing, so the delivery path can skip the subtext
 * entirely rather than post an empty one.
 */
export function formatStatusSubtext(): string | null {
  const parts: string[] = [];
  if (model) parts.push(shortModelName(model));
  // `ultracode` is not an effort level — it is a separate setting that forces
  // xhigh AND turns on standing workflow orchestration (see the ULTRACODE note
  // in the host's flag-parser.ts). Printing `xhigh` for it would hide the half
  // of the setting that changes how the agent works, so it displaces the
  // effort value the way the host's own flag confirmation displaces it.
  if (ultracode) parts.push('ultracode');
  else if (effort) parts.push(effort);
  if (contextTokens !== null) parts.push(`${formatTokens(contextTokens)} context`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Is this group's status subtext turned on?
 *
 * Never throws. `getConfig()` throws when the config was never loaded, and a
 * footer is decoration — it must not be able to take a reply down with it. An
 * unreadable config answers NO rather than yes: the flag exists so a group can
 * ask for silence, and honouring that ask is the one outcome that matters if
 * we cannot tell which group this is.
 */
function statusSubtextEnabled(): boolean {
  try {
    return getConfig().statusSubtext;
  } catch {
    return false;
  }
}

/**
 * Stamp the status subtext onto an outbound chat payload, or return it
 * unchanged.
 *
 * THIS IS THE ONLY STAMPING SITE, and it sits at the shared outbound seam
 * (db/messages-out.ts) rather than at any one sender. There are two unrelated
 * ways an agent's reply reaches a conversation, and which one runs depends on
 * a config flag most installs never touch:
 *
 *   - `<message to="here">` envelopes, dispatched by sendToDestination.
 *   - The `send_message` MCP tool, which writes its own chat row directly
 *     (mcp-tools/core.ts:355). Outcome reporting — ON unless a group sets
 *     `outcomeReporting: false` (src/container-config.ts:1399) — instructs the
 *     agent to reply this way (destinations.ts:320), so on a default install
 *     this is THE reply path, not an alternative one.
 *
 * Stamping in either sender alone therefore covers roughly half the fleet
 * while looking complete in tests.
 *
 * Scope is deliberately narrow, and the first gate is OPT-IN: the row must be
 * marked `agentReply`, because `kind: 'chat'` alone is far broader than "a
 * reply the agent composed" — `send_file` captions and the runner's own
 * `/clear` notice are both routed chat rows. Then: the agent's own
 * conversation only (`isOwnConversation`), and an existing `subtext` key is
 * never overwritten.
 *
 * Known gap, accepted: "post in THIS thread, as me" resolves to the origin and
 * is stamped. No routing fact distinguishes it from a normal reply; only the
 * agent's intent does. The alternative — a suppress flag on the sending tool —
 * fails in the worse direction, because an agent that forgets to pass it
 * stamps the operator's words rather than merely missing a line.
 */
export function stampStatusSubtext(msg: {
  kind: string;
  agentReply?: boolean;
  channel_type?: string | null;
  platform_id?: string | null;
  content: string;
}): string {
  if (msg.agentReply !== true || msg.kind !== 'chat') return msg.content;
  if (!isOwnConversation(msg.channel_type, msg.platform_id)) return msg.content;
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
  // Never overwrite a subtext the handler set itself.
  if (Object.prototype.hasOwnProperty.call(payload, 'subtext')) return msg.content;
  payload.subtext = subtext;
  return JSON.stringify(payload);
}
