/**
 * Haiku-generated session titles for the inbox board, refreshed by a sweep: each tick picks up to
 * {@link CONCURRENCY_CAP} sessions with no title, or with a title older than the cooldown AND at least
 * REFRESH_MIN_NEW_MESSAGES new messages. A sweep rather than on-write keeps LLM cost bounded; a stale title beats a
 * churning one.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { readSessionInbound, readSessionOutbound, type MessageTailRow } from '../modules/mailbox/index.js';
import {
  anthropicCredentialHttpError,
  callWithCredentialRotation,
  listClaudeStructuredCredentialSlots,
  type StructuredCredential,
} from '../llm.js';

// Bounds how many candidates are PICKED per tick, not in-flight requests: `callWithCredentialRotation` (src/llm.ts)
// queues behind a process-wide gate allowing one request at a time, because bursts from this sweep tripped account
// rate limits. Slot rotation and parking state is module-level in llm.ts, so candidates in one tick share it.
export const CONCURRENCY_CAP = 3;
export const COOLDOWN_HOURS = 1;
export const REFRESH_MIN_NEW_MESSAGES = 10;
const FAILURE_BACKOFF_MINUTES = 15;
const MAX_MESSAGES_PER_SLICE = 12;
const HAIKU_MAX_TITLE_CHARS = 60;
const HAIKU_TIMEOUT_MS = 6000;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Generate a short (≤60 char) plain-text label that captures the topic of the conversation. No quotes, no prefix, no markdown — just the topic.

Good labels: "EXAMPLE-71 rollout fix", "Slack auto-wire debug", "Snowflake credential audit".
Bad labels: "Conversation about X" (filler), "Here's a label: ..." (preamble), "**bold**" (markdown).`;

interface CandidateRow {
  id: string;
  agent_group_id: string;
  title: string | null;
  title_generated_at: string | null;
  title_basis_seq: number | null;
}

export type TitleBackendFn = (system: string, user: string) => Promise<string>;

let _backendOverride: TitleBackendFn | null = null;

export function setTitleBackendForTest(fn: TitleBackendFn | null): void {
  _backendOverride = fn;
}

export function _resetTitleBackendForTest(): void {
  _backendOverride = null;
}

/**
 * Sweep-level cooldown engaged by the circuit breaker. The per-tick breaker only de-duplicates log lines; this is
 * what actually stops doomed calls during a sustained 429 window, which would otherwise starve the other host Haiku
 * callers.
 */
export const BREAKER_COOLDOWN_BASE_MS = 5 * 60_000;
export const BREAKER_COOLDOWN_CAP_MS = 30 * 60_000;

let _cooldownUntilMs = 0;
/**
 * Duration of the most recent cooldown, 0 when none or after a success. Doubles (capped) when the first batch after a
 * cooldown trips again.
 */
let _lastCooldownMs = 0;

function isCoolingDown(nowMs: number): boolean {
  return nowMs < _cooldownUntilMs;
}

function engageCooldown(nowMs: number): void {
  const cooldownMs =
    _lastCooldownMs > 0 ? Math.min(BREAKER_COOLDOWN_CAP_MS, _lastCooldownMs * 2) : BREAKER_COOLDOWN_BASE_MS;
  _lastCooldownMs = cooldownMs;
  _cooldownUntilMs = nowMs + cooldownMs;
  log.warn('session-title: circuit breaker cooldown engaged — suppressing sweep', {
    cooldownMs,
    untilIso: new Date(_cooldownUntilMs).toISOString(),
  });
}

function resetCooldownEscalation(): void {
  _lastCooldownMs = 0;
}

/** Test-only: clears cooldown state between tests. */
export function _resetCooldownForTest(): void {
  _cooldownUntilMs = 0;
  _lastCooldownMs = 0;
}

export function _getCooldownStateForTest(): { cooldownUntilMs: number; lastCooldownMs: number } {
  return { cooldownUntilMs: _cooldownUntilMs, lastCooldownMs: _lastCooldownMs };
}

/**
 * True when ANY configured credential slot exists, resolved through the same
 * {@link listClaudeStructuredCredentialSlots} the request path rotates across, so "configured" and "what gets tried"
 * cannot drift. The test override always counts as configured.
 */
export function isBackendConfigured(): boolean {
  if (_backendOverride !== null) return true;
  return listClaudeStructuredCredentialSlots().length > 0;
}

// Lazy so tests do not inherit stale proxy env and a restart after env changes needs no other init path.
let _envProxyDispatcher: Dispatcher | null | undefined;
function getProxyDispatcher(): Dispatcher | null {
  if (_envProxyDispatcher !== undefined) return _envProxyDispatcher;
  const hasProxyEnv = !!(
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
  _envProxyDispatcher = hasProxyEnv ? new EnvHttpProxyAgent() : null;
  return _envProxyDispatcher;
}

export function _resetProxyDispatcherForTest(): void {
  _envProxyDispatcher = undefined;
}

let _missingBackendLogged = false;

/** One request against a single resolved credential; rotation and retry live in {@link callTitleBackend}. */
async function callTitleBackendOnce(system: string, user: string, credential: StructuredCredential): Promise<string> {
  const baseUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com';
  const model = process.env['NANOCLAW_SESSION_TITLE_MODEL'] ?? DEFAULT_MODEL;

  // Through the proxy so the OneCLI gateway can swap the placeholder OAuth token for the vault token.
  const dispatcher = getProxyDispatcher();
  const fetchImpl: typeof fetch = dispatcher
    ? (url, init) =>
        undiciFetch(
          url as string,
          { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
        ) as unknown as Promise<Response>
    : fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...credential.headers,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 80,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw await anthropicCredentialHttpError(resp);
    }
    const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
    return data.content?.find((c) => c.type === 'text')?.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The test override is one direct call raced against its own timeout. Production rotates across every configured
 * credential slot via {@link callWithCredentialRotation}, the same policy `callHaiku` uses.
 */
async function callTitleBackend(system: string, user: string): Promise<string> {
  if (_backendOverride !== null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
    try {
      return await Promise.race([
        _backendOverride(system, user),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error('aborted'));
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const { value } = await callWithCredentialRotation({
    attempt: (credential) => callTitleBackendOnce(system, user, credential),
    logLabel: 'session-title',
    noCredentialsMessage: 'session-title: no Anthropic credentials available',
  });
  return value;
}

/** Strips quotes, "Title: " preambles and trailing periods, and caps at {@link HAIKU_MAX_TITLE_CHARS}. */
export function postProcessTitle(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(title:|topic:|label:)\s*/i, '');
  s = s.replace(/\.+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, HAIKU_MAX_TITLE_CHARS);
}

/**
 * Up to `cap` sessions needing a title, gated purely on columns; the new-message threshold is checked per session
 * from the mailbox's `seq` in `shouldGenerate` (inbound.db size and mtime are unreliable proxies).
 */
async function pickCandidates(cap: number): Promise<CandidateRow[]> {
  const cooldownIso = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString();
  // Gate on `title_generated_at` so a failure-backoff stamp keeps a NULL-title row out. ORDER is load-bearing:
  // untitled first, then most recently active. Oldest-first picks empty shells that are skipped every tick, starving
  // every real session forever.
  return getDb().all<CandidateRow>(
    `SELECT id, agent_group_id, title, title_generated_at, title_basis_seq
       FROM sessions
      WHERE status = 'active'
        AND (title_generated_at IS NULL OR title_generated_at < ?)
      ORDER BY (title IS NOT NULL), COALESCE(last_active, created_at) DESC
      LIMIT ?`,
    cooldownIso,
    cap * 4,
  );
}

interface SliceResult {
  text: string;
  maxSeq: number;
  /**
   * True when no inbound row has `trigger = 1`: the session never woke the agent (e.g. bot notifications into a
   * `mention`-mode channel), so there is nothing to summarize. A later real wake flips it back.
   */
  neverWoken: boolean;
}

/**
 * The last N inbound and outbound contents in seq order as one prompt slice. `maxSeq` is -1 for an empty slice ("skip
 * for now"). Best-effort: IO failures return an empty slice.
 */
function readSessionSlice(agentGroupId: string, sessionId: string): SliceResult {
  const location = { agentGroupId, sessionId };

  let inboundLines: MessageTailRow[] = [];
  let outboundLines: MessageTailRow[] = [];
  let neverWoken = false;

  try {
    readSessionInbound(location, (mailbox) => {
      inboundLines = mailbox.listInboundTail(MAX_MESSAGES_PER_SLICE);
      // A missing `trigger` column on an old DB fails closed to "has woken": it must never suppress a real title or
      // trip the read-failed warning.
      try {
        neverWoken = !mailbox.hasTriggeredInboundRow();
      } catch {
        neverWoken = false;
      }
    });
  } catch (err) {
    log.warn('session-title: inbound.db read failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    outboundLines = readSessionOutbound(location, (mailbox) => mailbox.listOutboundTail(MAX_MESSAGES_PER_SLICE)) ?? [];
  } catch (err) {
    log.warn('session-title: outbound.db read failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const merged = [...inboundLines, ...outboundLines].sort((a, b) => a.seq - b.seq);
  if (merged.length === 0) return { text: '', maxSeq: -1, neverWoken };

  const tail = merged.slice(-MAX_MESSAGES_PER_SLICE);
  const lines: string[] = [];
  for (const row of tail) {
    let text: string;
    try {
      const parsed = JSON.parse(row.content) as { text?: unknown; prompt?: unknown; question?: unknown };
      text = String(parsed.text ?? parsed.prompt ?? parsed.question ?? '').trim();
    } catch {
      text = row.content;
    }
    if (!text) continue;
    const prefix = row.kind === 'chat-sdk' || row.kind === 'system' ? 'agent: ' : 'user: ';
    lines.push(prefix + text.slice(0, 200));
  }
  return { text: lines.join('\n'), maxSeq: tail[tail.length - 1]!.seq, neverWoken };
}

async function persistTitle(sessionId: string, title: string, basisSeq: number, generatedAt: string): Promise<void> {
  await getDb().run(
    `UPDATE sessions
        SET title = ?,
            title_generated_at = ?,
            title_basis_seq = ?
      WHERE id = ?`,
    title,
    generatedAt,
    basisSeq,
    sessionId,
  );
}

/**
 * Stamps `title_generated_at` so the cooldown predicate hides the row for FAILURE_BACKOFF_MINUTES; otherwise a
 * session that keeps failing is re-picked every tick and starves fresher ones. Never writes a fake `title`: NULL is
 * the truth.
 */
async function stampFailureBackoff(sessionId: string): Promise<void> {
  const stamp = new Date(Date.now() - (COOLDOWN_HOURS * 60 - FAILURE_BACKOFF_MINUTES) * 60_000).toISOString();
  await getDb().run(`UPDATE sessions SET title_generated_at = ? WHERE id = ?`, stamp, sessionId);
}

/** True if the title should be (re)generated. */
function shouldGenerate(row: CandidateRow, sliceMaxSeq: number): boolean {
  if (sliceMaxSeq < 0) return false;
  if (!row.title) return true;
  if (row.title_basis_seq == null) return true;
  if (sliceMaxSeq - row.title_basis_seq < REFRESH_MIN_NEW_MESSAGES) return false;
  return true;
}

/** One sweep tick. Each candidate is independently try/caught so one backend failure does not poison the batch. */
// Re-entrancy guard: a slow response must not overlap a second batch on the next tick.
let sweepInProgress = false;

export async function runSessionTitleSweep(): Promise<{ generated: number; skipped: number }> {
  if (sweepInProgress) return { generated: 0, skipped: 0 };
  sweepInProgress = true;
  try {
    return await _runSessionTitleSweepLocked();
  } finally {
    sweepInProgress = false;
  }
}

async function _runSessionTitleSweepLocked(): Promise<{ generated: number; skipped: number }> {
  // Fail closed with no backend: otherwise every tick burns doomed calls and failure stamps. Logged once per process.
  if (!isBackendConfigured()) {
    if (!_missingBackendLogged) {
      _missingBackendLogged = true;
      log.info(
        'session-title: no Anthropic backend configured — sweep is a no-op. Set ANTHROPIC_API_KEY or wire HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN (OneCLI gateway).',
      );
    }
    return { generated: 0, skipped: 0 };
  }

  // Fail closed during the breaker cooldown: a rate-limited but configured credential produces the same waste the
  // gate above cannot see.
  if (isCoolingDown(Date.now())) {
    return { generated: 0, skipped: 0 };
  }

  const candidates = await pickCandidates(CONCURRENCY_CAP);
  if (candidates.length === 0) return { generated: 0, skipped: 0 };

  let generated = 0;
  let skipped = 0;
  const tasks: Array<Promise<TaskOutcome>> = [];

  for (const row of candidates) {
    if (tasks.length >= CONCURRENCY_CAP) break;
    const slice = readSessionSlice(row.agent_group_id, row.id);
    // Empty, contentless, or never-woken session: stamp a backoff so it leaves the candidate pool, or a backlog of
    // such shells occupies the LIMIT and starves real sessions forever. A stamped shell that later gains content
    // re-enters after the cooldown.
    if (slice.maxSeq < 0 || !slice.text || slice.neverWoken) {
      try {
        await stampFailureBackoff(row.id);
      } catch {
        /* stamp failure is non-fatal — next tick will retry */
      }
      skipped++;
      continue;
    }
    // Not enough new messages: leave it on its natural cooldown; re-stamping would churn its refresh clock.
    if (!shouldGenerate(row, slice.maxSeq)) {
      skipped++;
      continue;
    }
    tasks.push(
      (async (): Promise<TaskOutcome> => {
        try {
          // Timeouts are per attempt inside callTitleBackend: a rotation may try several slots, each needing its own
          // budget.
          const raw = await callTitleBackend(SYSTEM_PROMPT, slice.text);
          const title = postProcessTitle(raw);
          if (!title) {
            skipped++;
            return { sessionId: row.id, ok: true };
          }
          await persistTitle(row.id, title, slice.maxSeq, new Date().toISOString());
          generated++;
          return { sessionId: row.id, ok: true };
        } catch (err) {
          try {
            await stampFailureBackoff(row.id);
          } catch {
            /* stamp failure is non-fatal — next tick will retry */
          }
          skipped++;
          return {
            sessionId: row.id,
            ok: false,
            transient: isTransientBackendFailure(err),
            errMessage: err instanceof Error ? err.message : String(err),
          };
        }
      })(),
    );
  }

  const outcomes = await Promise.all(tasks);
  const breakerTripped = logFailuresWithBreaker(outcomes);

  // A success proves the backend is not fully rate-limited, so the escalation resets; a trip (only possible when the
  // whole batch failed) engages the cooldown.
  if (generated > 0) {
    resetCooldownEscalation();
  } else if (breakerTripped) {
    engageCooldown(Date.now());
  }

  return { generated, skipped };
}

interface TaskOutcome {
  sessionId: string;
  ok: boolean;
  transient?: boolean;
  errMessage?: string;
}

/**
 * A run of this many consecutive transient failures, in candidate order, collapses into one warn instead of one per
 * candidate. Non-transient failures are always logged individually.
 */
const BREAKER_CONSECUTIVE_FAILURES = 3;

function logFailuresWithBreaker(outcomes: TaskOutcome[]): boolean {
  // Each run is buffered and logged once it ends; runs shorter than the threshold log individually.
  let run: TaskOutcome[] = [];
  let tripped = false;

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length >= BREAKER_CONSECUTIVE_FAILURES) {
      tripped = true;
      log.warn(
        'session-title: circuit breaker tripped — consecutive transient failures this tick, abandoning rest of batch',
        { consecutiveTransientFailures: run.length, sessionIds: run.map((o) => o.sessionId) },
      );
    } else {
      for (const o of run) {
        log.warn('session-title: backend call failed', { sessionId: o.sessionId, err: o.errMessage });
      }
    }
    run = [];
  };

  for (const outcome of outcomes) {
    if (outcome.ok) {
      flushRun();
      continue;
    }
    if (!outcome.transient) {
      flushRun();
      log.warn('session-title: backend call failed', { sessionId: outcome.sessionId, err: outcome.errMessage });
      continue;
    }
    run.push(outcome);
  }
  flushRun();
  return tripped;
}

/**
 * Breaker/log-volume policy only, deliberately coarser than llm.ts's `classifyCredentialFailure`: every 429 counts
 * toward the breaker, whatever its cause.
 */
function isTransientBackendFailure(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 529 || (err as Error).name === 'AbortError' || !status;
}
