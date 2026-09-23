import { getConfig } from './config.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { getAgentMailbox } from './mailbox/index.js';

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
 * The model id the provider reports actually SERVED this turn's requests.
 *
 * `model` above is what was asked for, and a request may be a family alias:
 * a task pinned `-m opus` resolves to the literal string `opus`, which the
 * API then serves as `claude-opus-5-5`. Printing the request put `opus`
 * under replies (seen live 2026-09-23 on the support-poller task). When a
 * provider observes the served id, the footer prints that instead. Like the
 * context figure it is a measurement of one turn, so it clears per result.
 */
let servedModel: string | null = null;

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
 * Subagents this turn deployed, keyed by the provider's own handle for one
 * deployment (Claude: the Task tool_use id; Codex: the child thread id) so a
 * worker that emits many frames is counted once.
 *
 * `model` is OBSERVED where a provider reports what actually ran; `effort` is
 * whatever that provider can say, which is not always the same kind of fact —
 * see each provider's capture site. `null` on either means "this provider did
 * not tell us", and the renderer omits it rather than guessing.
 */
const subagents = new Map<string, { type: string | null; model: string | null; effort: string | null }>();

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
  const next = Math.round(tokens);
  if (next === contextTokens && !persistFailed) return;
  contextTokens = next;
  persist();
}

/**
 * Record the model id a provider observed serving a request.
 *
 * Rejects the SDK's placeholder ids (`<synthetic>`, on frames the CLI makes up
 * itself) along with empty values: those name no model, and printing one
 * would be worse than falling back to the configured model.
 */
export function recordServedModel(id: string | null | undefined): void {
  if (typeof id !== 'string') return;
  const next = id.trim();
  if (!next || next.startsWith('<')) return;
  if (next === servedModel && !persistFailed) return;
  servedModel = next;
  persist();
}

/**
 * Set the model/effort the turn in flight is running at.
 *
 * `nextModel` should be the provider's RESOLVED model, not what was requested:
 * an unpinned turn requests nothing and only the provider can say which model
 * the group default became (the same reasoning as `modelInForce` in
 * poll-loop.ts, whose value this mirrors).
 */
export function setTurnSettings(nextModel?: string | null, nextEffort?: string | null, nextUltracode?: boolean): void {
  model = nextModel ?? null;
  effort = nextEffort ?? null;
  ultracode = nextUltracode === true;
  persist();
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
  if (contextTokens === null && servedModel === null && !persistFailed) return;
  contextTokens = null;
  // The served model is the same kind of fact — one turn's measurement — and
  // goes with it, so a turn that observes none falls back to the configured
  // model rather than inheriting the previous turn's.
  servedModel = null;
  persist();
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
  persist();
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

/**
 * Is an outbound row a scheduled task's post to a platform?
 *
 * An isolated task session has no conversation of its own: its routing is a
 * `system:tasks:*` thread with no platform (db/session-routing.ts:28), and
 * send_message refuses to guess a target there (mcp-tools/core.ts:222). Every
 * chat row it writes is the task's output to a destination it named, so
 * without this the own-conversation gate leaves every scheduled post bare.
 * Agent-to-agent rows (`channel_type: 'agent'`) are not a platform post.
 * Reads the routing from the inbound DB, so it answers the same in the MCP
 * subprocess as in poll-loop.
 */
export function isTaskOutput(channelType?: string | null, platformId?: string | null): boolean {
  if (!channelType || !platformId || channelType === 'agent') return false;
  // FAILS CLOSED: a routing read that throws must cost a decoration, never
  // the send it decorates.
  try {
    return getTaskSeriesId() !== null;
  } catch {
    return false;
  }
}

/**
 * CROSS-PROCESS: the store lives in the session DB, not only in memory.
 *
 * The runner is two processes. poll-loop (and the provider inside it) sets the
 * turn's model, effort, context and conversation — but the `send_message` MCP
 * tool runs in a SEPARATE stdio subprocess (mcp-tools/server.ts:114) with its
 * own, empty copy of this module. It writes its chat row there, so an
 * in-memory-only store made `isOwnConversation` answer false for every reply
 * sent through the tool. That is the default reply path whenever outcome
 * reporting is on, and it shipped: in production 55 of 57 replies went out
 * unstamped, while every test passed because tests run in ONE process.
 *
 * The snapshot rides session state — the same mailbox-backed channel that
 * carries `in_reply_to` across the same boundary (db/session-state.ts).
 * Writes happen only on change; `stampStatusSubtext` hydrates before deciding.
 * Every access is guarded: a decoration must never be able to break a write.
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
  // The roster crosses the same boundary for the same reason: the provider
  // records it in poll-loop, but send_message stamps from the MCP subprocess.
  subagents?: [string, { type: string | null; model: string | null; effort: string | null }][];
}

/**
 * True in the process that SETS turn state (poll-loop + provider). That
 * process's memory is authoritative and is never overwritten from the DB —
 * if a persist ever failed, hydrating would replace good state with stale.
 * A process that never set state (the MCP subprocess) re-reads every time,
 * because it is long-lived across turns and the snapshot keeps moving.
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
    // No mailbox (unit tests) or a transient DB error: the in-memory store
    // still serves this process. Remember the failure, so the skip-if-unchanged
    // checks in the setters don't strand the snapshot on a value that never
    // reached the DB — the next setter call writes again even if nothing moved
    // (#1023).
    persistFailed = true;
  }
}

/** True when the last snapshot write failed and the DB copy is behind memory. */
let persistFailed = false;

/** Load the persisted snapshot into this process. Returns false if none. */
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
 * FAIL CLOSED in a process that does not own the store (#1023).
 *
 * The MCP subprocess is long-lived across turns. If a read of the snapshot
 * fails (e.g. SQLITE_BUSY while poll-loop is writing) and it kept what the
 * previous successful read loaded, `isOwnConversation` would answer for the
 * PREVIOUS turn's conversation — and in an agent-shared session a send to that
 * channel would be stamped, putting the fleet's model and context into a
 * conversation that is not this turn's. An unreadable snapshot means "route
 * unknown", which the gate answers with no stamp.
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
 * Record (or refine) one subagent deployment.
 *
 * Idempotent per `key` and MERGING: providers learn the pieces at different
 * moments — Claude sees the agent type on the Task call and the model on the
 * worker's first frame; Codex sees the thread id on the activity item and the
 * model/effort only after reading that thread. A later call fills gaps without
 * erasing what is already known, so an out-of-order arrival cannot blank a
 * field that was already answered.
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
  // Claude calls this once per worker frame, so a large fan-out would otherwise
  // write thousands of identical snapshots. Persist only on a real change (#1028).
  if (prior && prior.type === next.type && prior.model === next.model && prior.effort === next.effort && !persistFailed)
    return;
  subagents.set(key, next);
  persist();
}

/**
 * Forget the roster at a turn boundary — same reasoning as
 * `clearContextTokens`: a roster describes ONE turn's delegation, and carrying
 * it into the next would report workers that are no longer running.
 */
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
/** Longest roster rendered before the tail collapses into "+N more". */
const MAX_RENDERED_SUBAGENT_GROUPS = 3;

/**
 * Render the roster as one clause: `3 subagents: 2x sonnet-5/high, haiku/low`.
 *
 * GROUPED BY (model, effort), not listed per worker. A coordinator can fan out
 * a dozen workers across two tiers, and twelve near-identical entries would
 * stop being subtext; what the operator is actually asking is "what tiers did
 * this turn deploy, and how many of each". The count before the colon is the
 * true total, so it stays honest even when the list is capped.
 *
 * A group whose model is unknown renders by whatever it does know — the
 * provider's agent type, else nothing but the count. Null when the turn
 * deployed nobody, which is the overwhelmingly common case and must add
 * nothing to the line.
 */
export function formatSubagentRoster(): string | null {
  if (subagents.size === 0) return null;

  const groups = new Map<string, { label: string; count: number }>();
  for (const entry of subagents.values()) {
    // Identity of a GROUP is what it would render as, so two workers that
    // display identically always collapse — including two that are equally
    // unknown.
    const model = entry.model ? shortModelName(entry.model) : null;
    const label = [model ?? entry.type ?? null, entry.effort ?? null].filter(Boolean).join('/');
    const key = label || 'unknown';
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { label, count: 1 });
  }

  // A group we know NOTHING about contributes to the total but has no label to
  // print. Dropping it here rather than rendering a bare count keeps the line
  // from saying "1 subagent: 1", which reads as a name.
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
  // `ultracode` is not an effort level — it is a separate setting that forces
  // xhigh AND turns on standing workflow orchestration (see the ULTRACODE note
  // in the host's flag-parser.ts). Printing `xhigh` for it would hide the half
  // of the setting that changes how the agent works, so it displaces the
  // effort value the way the host's own flag confirmation displaces it.
  if (ultracode) parts.push('ultracode');
  else if (effort) parts.push(effort);
  if (contextTokens !== null) parts.push(`${formatTokens(contextTokens)} context`);
  // Last, and only when the turn actually delegated: it is the one clause that
  // varies in length, so it belongs where it cannot push the facts that are
  // always present off the end of a narrow display.
  const roster = formatSubagentRoster();
  if (roster) parts.push(roster);
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
 * THIS IS THE ONLY STAMPING DECISION. It is called through `withStatusSubtext`
 * at each reply call site (see there for why not inside `writeMessageOut`). There are two unrelated
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
 * marked `agentReply`, because `kind: 'chat'` alone is broader than "text the
 * agent composed" — the runner's own `/clear` notice is a routed chat row that
 * no turn authored. (`send_file` IS marked when it carries a caption: the
 * caption is agent text, often the whole report.) Then: the agent's own
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
  // Read the turn's state from the session DB, not this process's memory: the
  // send_message tool runs in its own subprocess, where nothing set it.
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
  // Never overwrite a subtext the handler set itself.
  if (Object.prototype.hasOwnProperty.call(payload, 'subtext')) return msg.content;
  payload.subtext = subtext;
  return JSON.stringify(payload);
}

/**
 * Stamp a row at its call site, then strip the marker before the write.
 *
 * WHY AT THE CALL SITE and not inside `writeMessageOut`: `db/messages-out.ts`
 * is a byte-identical upstream shim, guarded by src/mailbox/UPSTREAM-MANIFEST.json
 * (the drift lane fails on any edit). It also builds the mailbox payload field
 * by field, so a marker on the row could never reach a mailbox override. And a
 * seam bought nothing here: every stampable row already needs an explicit
 * `agentReply` at its call site, so the sites that set it are exactly the
 * sites that call this. `grep -rn withStatusSubtext container/agent-runner/src`
 * lists them; they are deliberately not enumerated here, because a list in a
 * comment goes stale the first time a writer is added.
 */
export function withStatusSubtext<
  T extends { kind: string; channel_type?: string | null; platform_id?: string | null; content: string },
>(row: T & { agentReply?: boolean }): T {
  const { agentReply, ...rest } = row;
  return { ...(rest as unknown as T), content: stampStatusSubtext({ ...rest, agentReply }) };
}
