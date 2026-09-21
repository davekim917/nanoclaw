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
 * Record the context occupancy observed on a provider request.
 *
 * Called per request, not per turn: a turn makes many round trips and the
 * latest one is the honest reading. Non-finite and negative values are ignored
 * rather than rendered — a provider that reports nothing usable should leave
 * the figure off the line, not print `NaN context`.
 */
export function recordContextTokens(tokens: number | null | undefined): void {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return;
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

/** Test seam — reset the store between cases. */
export function resetTurnStatus(): void {
  contextTokens = null;
  model = null;
  effort = null;
  ultracode = false;
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
