/**
 * Haiku-generated session titles for the inbox board.
 *
 * Why: a bare session id is meaningless on the inbox board. A short
 * Haiku-generated label ("EXAMPLE-71 — rollout fix", "Slack auto-wire") makes
 * the card scannable without opening the thread.
 *
 * What the sweep does, once per host-sweep tick (60s by default):
 *   1. Picks up to {@link CONCURRENCY_CAP} sessions that need a title:
 *      either no title yet, OR last generated ≥1h ago AND ≥10 new
 *      messages since `title_basis_seq`.
 *   2. For each, opens the session's `inbound.db` + `outbound.db`,
 *      grabs the last few messages, calls Haiku via {@link callTitleBackend},
 *      writes the result back to `sessions.title` along with the basis
 *      seq + timestamp.
 *
 * Why a sweep, not on-write: title generation is best-effort and bounded
 * by API cost. Doing it on every inbound write would amplify by 1 LLM
 * call per message; once-per-minute capped at 3 concurrent keeps the cost
 * predictable and the operator never waits on it (the inbox renders the
 * session id or last-progress text as a fallback).
 *
 * Why ≥10 new messages for refresh: a stale title is better than a churning
 * title. If only a handful of messages came in, the topic almost certainly
 * hasn't changed — and a refresh that reshuffles a card's label on every
 * inbox refresh would be more distracting than useful.
 */
import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { DATA_DIR } from '../config.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import {
  anthropicCredentialHttpError,
  callWithCredentialRotation,
  listClaudeStructuredCredentialSlots,
  type StructuredCredential,
} from '../llm.js';

// `callTitleBackend` rotates credentials through src/llm.ts's
// `callWithCredentialRotation`, which keeps its "which slot last succeeded"
// and "which slots are currently parked" state at MODULE level in llm.ts —
// not per-call, not per-caller. That state is shared across every
// concurrent candidate in a single sweep tick, not just across ticks: once
// candidate 1 discovers a slot needs parking (quota-exhausted with a long
// retry-after) or has already rotated past a dead one, candidates 2 and 3
// see that same state on every attempt they make AFTER that point — a
// dead/parked slot does not get separately re-tried by all CONCURRENCY_CAP
// candidates in the same tick. This is "for free" from llm.ts, not
// something this file implements — verified via src/llm.test.ts's
// credential-rotation/parking suites, which exercise the same shared state
// this sweep's production path (below, non-test-override branch) goes
// through.
//
// CONCURRENCY_CAP no longer means real concurrency at the request level:
// `callWithCredentialRotation` now queues behind a process-wide gate
// (`withCredentialRotationGate` in llm.ts) that allows at most one in-flight
// request at a time, spaced by a minimum interval — added because this cap's
// "up to 3 at once" WAS the concurrency that produced the short-window
// bursts tripping otherwise-healthy accounts' rate limits (see llm.ts's gate
// doc comment). This constant now just bounds how many candidates get
// PICKED per tick (`pickCandidates(CONCURRENCY_CAP)` below) and dispatched
// into that queue — the queue itself, not this cap, is what limits in-flight
// requests.
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

/**
 * Title backend override hook for tests + dependency injection. Production
 * default is the Anthropic /v1/messages call below; tests inject a
 * synchronous stub so the sweep is deterministic.
 */
export type TitleBackendFn = (system: string, user: string) => Promise<string>;

let _backendOverride: TitleBackendFn | null = null;

export function setTitleBackendForTest(fn: TitleBackendFn | null): void {
  _backendOverride = fn;
}

export function _resetTitleBackendForTest(): void {
  _backendOverride = null;
}

/**
 * Sweep-level cooldown, engaged by the circuit breaker (see
 * `logFailuresWithBreaker` / `BREAKER_CONSECUTIVE_FAILURES` below).
 *
 * The per-tick breaker alone only de-duplicates LOG LINES — with
 * CONCURRENCY_CAP=3 candidates per tick, a fully-failed batch has nothing
 * left in it to "abandon". It does nothing to reduce the actual call volume:
 * the sweep would keep issuing 3 Haiku calls every 60s (~180/hr) regardless
 * of whether the backend is 429ing, starving the other host Haiku callers
 * (thread titling included) with a steady drumbeat of doomed requests. This
 * cooldown is what actually cuts spend during a sustained rate-limit window,
 * the same way `isBackendConfigured()` below already fails closed instead of
 * burning 3 doomed calls/tick when there's no credential at all.
 */
export const BREAKER_COOLDOWN_BASE_MS = 5 * 60_000;
export const BREAKER_COOLDOWN_CAP_MS = 30 * 60_000;

/** 0 = no cooldown in effect. */
let _cooldownUntilMs = 0;
/**
 * Duration of the most recently engaged cooldown, in ms. 0 means either no
 * cooldown has ever been engaged, or the escalation was reset by a
 * subsequent success. Doubles (capped) when the very next batch to actually
 * run after a cooldown expires trips the breaker again — a sustained
 * rate-limit shouldn't be re-probed every 5 minutes.
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

/** Any successful title means the backend is not (fully) rate-limited — drop the escalation. */
function resetCooldownEscalation(): void {
  _lastCooldownMs = 0;
}

/** Test-only: clear cooldown state so it doesn't leak between tests (or into production on a module reload race). */
export function _resetCooldownForTest(): void {
  _cooldownUntilMs = 0;
  _lastCooldownMs = 0;
}

/** Test-only: read current cooldown state for deterministic assertions. */
export function _getCooldownStateForTest(): { cooldownUntilMs: number; lastCooldownMs: number } {
  return { cooldownUntilMs: _cooldownUntilMs, lastCooldownMs: _lastCooldownMs };
}

/**
 * Returns true when the host process has a viable path to Anthropic —
 * ANY configured credential slot, not just the primary. Resolved through
 * the same {@link listClaudeStructuredCredentialSlots} (src/llm.ts) that
 * backs `callHaiku` and this sweep's own {@link callTitleBackend}, so
 * "is a backend configured" and "which slot will actually be tried" can
 * never drift apart — a stale slot 1 alone used to report "configured"
 * here while the request path had 3 more slots it never tried.
 *
 * The test backend override is always considered configured so unit
 * tests don't need to set any env vars.
 */
export function isBackendConfigured(): boolean {
  if (_backendOverride !== null) return true;
  return listClaudeStructuredCredentialSlots().length > 0;
}

// Lazy-init the proxy dispatcher on first use so tests do not inherit stale
// state from earlier proxy env, and a service restart after env changes works
// without another initialization path.
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

/**
 * One request against a single resolved credential — the request-builder
 * callback {@link callWithCredentialRotation} (src/llm.ts) needs, since this
 * sweep's request shape (system + user messages, its own model/token
 * settings, its own per-attempt timeout) differs from `callHaiku`'s fixed
 * prompt shape. Rotation/retry policy does NOT live here — see
 * {@link callTitleBackend}.
 */
async function callTitleBackendOnce(system: string, user: string, credential: StructuredCredential): Promise<string> {
  const baseUrl = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com';
  const model = process.env['NANOCLAW_SESSION_TITLE_MODEL'] ?? DEFAULT_MODEL;

  // When a proxy is configured, route through undici with EnvHttpProxyAgent
  // so the OneCLI gateway can swap the placeholder OAuth token for the
  // real vault token at request time.
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
 * Generate one title. The test override bypasses credential resolution and
 * rotation entirely — a single direct call, raced against its own timeout —
 * so unit tests stay deterministic without touching real credentials.
 *
 * The production path rotates across every configured Anthropic credential
 * slot via {@link callWithCredentialRotation} (src/llm.ts) — the SAME
 * rotation policy `callHaiku` uses, rather than a second copy pinned to the
 * primary slot. Previously this only ever tried
 * `process.env['CLAUDE_CODE_OAUTH_TOKEN']` (slot 1), so once that slot's
 * quota was exhausted this sweep 429'd forever while slots 2-4 sat unused.
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

/**
 * Strip surrounding quotes / "Title: " preambles / trailing periods and cap
 * the label at {@link HAIKU_MAX_TITLE_CHARS}. Haiku is reliable about
 * following the system prompt's "no preamble" rule but the post-process
 * costs nothing and earns the corner case.
 */
export function postProcessTitle(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(title:|topic:|label:)\s*/i, '');
  s = s.replace(/\.+$/, '');
  // Drop newlines — title is a single line by contract.
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, HAIKU_MAX_TITLE_CHARS);
}

/**
 * Pick up to `cap` sessions that need a title. SQL keeps the gate purely
 * column-driven so we don't iterate every session, and the WHERE clause
 * matches the refresh contract (no title, OR cooldown + new message
 * threshold). The "newer messages" predicate is delegated to a
 * per-session probe below — checking the session's inbound.db file size
 * mtime would be faster but unreliable; we just open the DB and run a
 * MAX(seq) lookup.
 */
function pickCandidates(cap: number): CandidateRow[] {
  const cooldownIso = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString();
  // Gate purely on `title_generated_at` — a stamped failure-backoff row
  // (see `stampFailureBackoff`) shouldn't slip back into the candidate
  // set just because its `title` column is still NULL. The refresh case
  // (title present + new messages) is gated in JS by `shouldGenerate`.
  //
  // ORDER: untitled sessions first (`title IS NOT NULL` sorts 0 before 1), then
  // most-recently-active first. This is load-bearing: the old "oldest
  // title_generated_at ASC" surfaced the oldest-CREATED sessions, which on a
  // long-lived install are overwhelmingly empty/churned shells with no content
  // to summarize. The sweep would pick LIMIT empties, skip them all (0
  // generated), and — because an empty session was never stamped — get the SAME
  // empties next tick, starving every real session forever. Prioritizing
  // recently-active untitled sessions titles the visible inbox cards first; the
  // empty-skip stamp in the loop below drains the rest of the shells.
  const rows = getDb()
    .prepare(
      `SELECT id, agent_group_id, title, title_generated_at, title_basis_seq
         FROM sessions
        WHERE status = 'active'
          AND (title_generated_at IS NULL OR title_generated_at < ?)
        ORDER BY (title IS NOT NULL), COALESCE(last_active, created_at) DESC
        LIMIT ?`,
    )
    .all(cooldownIso, cap * 4) as CandidateRow[];
  return rows;
}

interface SliceResult {
  text: string;
  maxSeq: number;
  /**
   * True when every inbound row for this session has `trigger = 0`
   * ("accumulate as context only" — see messages_in.trigger in
   * db/session-db.ts). A session with no `trigger = 1` row was never woken:
   * `engage_mode` never let it spawn a container or produce an agent
   * response, so there is nothing for Haiku to summarize even though the
   * content column is non-empty. This is the bot-spam-thread case
   * (Snowflake/Linear notifications into a `mention`-mode channel) — the
   * sweep treats it the same as an empty slice rather than burning a Haiku
   * call on a transcript with no agent side. A later real wake (trigger=1)
   * flips this back to false and the session re-enters titling normally.
   */
  neverWoken: boolean;
}

/**
 * Read the last N inbound + outbound message contents from the per-session
 * DBs, in seq order, and concatenate into a single user-prompt slice for
 * Haiku. `maxSeq` is returned so the caller can stamp `title_basis_seq`
 * — if the slice was empty (file missing or no messages) we return -1
 * which the sweep treats as "skip this session for now".
 *
 * Best-effort: any IO failure returns an empty slice rather than throwing
 * so the rest of the sweep's session list can still be processed.
 */
function readSessionSlice(agentGroupId: string, sessionId: string): SliceResult {
  const inboundPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  const outboundPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'outbound.db');

  let inboundLines: Array<{ seq: number; content: string; kind: string }> = [];
  let outboundLines: Array<{ seq: number; content: string; kind: string }> = [];
  let neverWoken = false;

  if (fs.existsSync(inboundPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(inboundPath, { readonly: true });
      db.pragma('busy_timeout = 1000');
      inboundLines = db
        .prepare(
          `SELECT seq, content, kind FROM messages_in
            WHERE content IS NOT NULL AND content <> ''
            ORDER BY seq DESC
            LIMIT ?`,
        )
        .all(MAX_MESSAGES_PER_SLICE) as typeof inboundLines;
      // `trigger` was added after the initial schema (LEGACY-COMPAT in
      // db/session-db.ts backfills existing rows to 1). A missing column on
      // an old/test DB is caught separately so it fails closed to "has
      // woken" — never suppresses a real title, and never triggers the
      // "read failed" warning below for what is otherwise a clean read.
      try {
        const woke = db.prepare(`SELECT 1 FROM messages_in WHERE trigger = 1 LIMIT 1`).get();
        neverWoken = woke === undefined;
      } catch {
        neverWoken = false;
      }
    } catch (err) {
      log.warn('session-title: inbound.db read failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      db?.close();
    }
  }

  if (fs.existsSync(outboundPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(outboundPath, { readonly: true });
      db.pragma('busy_timeout = 1000');
      outboundLines = db
        .prepare(
          `SELECT seq, content, kind FROM messages_out
            WHERE content IS NOT NULL AND content <> ''
            ORDER BY seq DESC
            LIMIT ?`,
        )
        .all(MAX_MESSAGES_PER_SLICE) as typeof outboundLines;
    } catch (err) {
      log.warn('session-title: outbound.db read failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      db?.close();
    }
  }

  // Merge by seq ascending and trim to a window.
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

function persistTitle(sessionId: string, title: string, basisSeq: number, generatedAt: string): void {
  getDb()
    .prepare(
      `UPDATE sessions
          SET title = ?,
              title_generated_at = ?,
              title_basis_seq = ?
        WHERE id = ?`,
    )
    .run(title, generatedAt, basisSeq, sessionId);
}

/**
 * Stamp `title_generated_at` to a near-future timestamp so the same row
 * doesn't re-enter the candidate set on the next sweep tick. Without this,
 * a session whose Haiku call keeps failing (network flake, content too
 * short to summarize) would be picked 3-per-tick on every 60s tick,
 * starving fresher sessions.
 *
 * Backoff is calibrated to {@link FAILURE_BACKOFF_MINUTES} from "now" so
 * the cooldown predicate (`title_generated_at < now-1h`) hides the row
 * for at least one quarter-hour. We do NOT write a fake `title` because
 * a NULL title is still the operator-visible truth (the inbox falls back
 * to the session id).
 */
function stampFailureBackoff(sessionId: string): void {
  const stamp = new Date(Date.now() - (COOLDOWN_HOURS * 60 - FAILURE_BACKOFF_MINUTES) * 60_000).toISOString();
  getDb().prepare(`UPDATE sessions SET title_generated_at = ? WHERE id = ?`).run(stamp, sessionId);
}

/**
 * Decide whether a candidate's existing title is still fresh enough to skip
 * regeneration this tick. Returns true if we should generate. The "≥10 new
 * messages since last basis seq" rule is implemented here using the slice's
 * maxSeq — the slice has already been read, so the marginal cost is zero.
 */
function shouldGenerate(row: CandidateRow, sliceMaxSeq: number): boolean {
  if (sliceMaxSeq < 0) return false; // empty session — nothing to summarize
  if (!row.title) return true; // first-time
  if (row.title_basis_seq == null) return true; // legacy / corrupted
  if (sliceMaxSeq - row.title_basis_seq < REFRESH_MIN_NEW_MESSAGES) return false;
  return true;
}

/**
 * One sweep tick. Picks candidates, generates titles for up to
 * {@link CONCURRENCY_CAP} of them in parallel. Each call is independently
 * try/caught — a single backend failure must not poison the rest of the
 * batch (the next sweep will retry the same candidate naturally).
 *
 * Returns a small status struct for tests + logs.
 */
// Re-entrancy guard: prevents a 60s tick from kicking off a second batch
// while the previous batch's Haiku calls are still mid-flight. Without this
// a slow Anthropic response (5-6s near the timeout) overlapped with a fast
// `pickCandidates` query could trigger a second concurrent batch on the
// next tick, exceeding the documented concurrency cap of 3.
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
  // Fail-closed early when no viable Anthropic backend is wired. Without
  // this gate every tick burns 3 doomed Haiku calls and stamps 3 failure
  // backoffs, churning ~150 wasted attempts/hour for nothing. Log once
  // per process lifetime so the operator sees it but the log doesn't
  // flood every 60s.
  if (!isBackendConfigured()) {
    if (!_missingBackendLogged) {
      _missingBackendLogged = true;
      log.info(
        'session-title: no Anthropic backend configured — sweep is a no-op. Set ANTHROPIC_API_KEY or wire HTTPS_PROXY + CLAUDE_CODE_OAUTH_TOKEN (OneCLI gateway).',
      );
    }
    return { generated: 0, skipped: 0 };
  }

  // Fail-closed while the circuit breaker's cooldown is in effect (see
  // engageCooldown / BREAKER_CONSECUTIVE_FAILURES). Same reasoning as the
  // isBackendConfigured() gate above: a sustained 429 wave produces
  // identical waste (3 doomed calls/tick) that gate doesn't cover, since a
  // credential IS configured — it's just being rate-limited. Logged once at
  // the moment the cooldown is engaged, not on every suppressed tick.
  if (isCoolingDown(Date.now())) {
    return { generated: 0, skipped: 0 };
  }

  const candidates = pickCandidates(CONCURRENCY_CAP);
  if (candidates.length === 0) return { generated: 0, skipped: 0 };

  let generated = 0;
  let skipped = 0;
  const tasks: Array<Promise<TaskOutcome>> = [];

  for (const row of candidates) {
    if (tasks.length >= CONCURRENCY_CAP) break;
    const slice = readSessionSlice(row.agent_group_id, row.id);
    // Empty / no-usable-content session, OR a session that has never woken the
    // agent (bot-spam threads under engage_mode=mention — see `neverWoken`
    // above): nothing to summarize. STAMP a backoff so it exits the candidate
    // pool rather than re-entering every tick. Without this, a backlog of
    // empty/unwoken NULL-title shells permanently occupies the LIMIT and
    // starves real sessions (the sweep skips all N and generates 0 forever —
    // the clog this fix targets). A stamped shell that later gains content or
    // a real wake re-enters after the cooldown ages out and gets titled then.
    if (slice.maxSeq < 0 || !slice.text || slice.neverWoken) {
      try {
        stampFailureBackoff(row.id);
      } catch {
        /* stamp failure is non-fatal — next tick will retry */
      }
      skipped++;
      continue;
    }
    // Has content but not enough NEW messages to justify a refresh — leave it on
    // its natural cooldown (it already has a title + title_generated_at); do NOT
    // re-stamp, which would churn its refresh clock.
    if (!shouldGenerate(row, slice.maxSeq)) {
      skipped++;
      continue;
    }
    tasks.push(
      (async (): Promise<TaskOutcome> => {
        try {
          // Timeout/abort is per-attempt inside callTitleBackend now — a
          // credential rotation may make several attempts across several
          // slots, and each needs its own fresh timeout budget rather than
          // sharing one controller across all of them (see
          // callTitleBackendOnce).
          const raw = await callTitleBackend(SYSTEM_PROMPT, slice.text);
          const title = postProcessTitle(raw);
          if (!title) {
            skipped++;
            return { sessionId: row.id, ok: true };
          }
          persistTitle(row.id, title, slice.maxSeq, new Date().toISOString());
          generated++;
          return { sessionId: row.id, ok: true };
        } catch (err) {
          try {
            stampFailureBackoff(row.id);
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

  // Any successful title this tick proves the backend isn't (fully)
  // rate-limited — drop the escalation so a LATER, unrelated trip starts
  // fresh at the base cooldown instead of picking up where a stale one left
  // off. A tripped breaker (only possible when the WHOLE batch failed
  // transiently, so it can never coincide with generated > 0) engages/
  // escalates the cooldown that actually cuts call volume.
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
 * A run of {@link BREAKER_CONSECUTIVE_FAILURES} consecutive transient
 * failures (candidate order — the deterministic, testable analog of
 * "consecutive" under a concurrently-dispatched batch, and equivalent to it
 * whenever CONCURRENCY_CAP <= this threshold, as it is today) collapses into
 * ONE warn naming the breaker instead of one warn per candidate. This sweep
 * is the dominant consumer of the shared OAuth quota (120 failed 429s
 * measured in a single day) and starves the other host Haiku callers —
 * including thread titling (src/topic-title.ts) — so a tick where the
 * backend is clearly rate-limited must not also flood the log on top of
 * flooding the quota. Non-transient failures are never batched: they're
 * real per-candidate problems (bad content, etc.), not backend-wide distress.
 */
const BREAKER_CONSECUTIVE_FAILURES = 3;

/** Returns true iff the breaker tripped (a run of >= BREAKER_CONSECUTIVE_FAILURES occurred). */
function logFailuresWithBreaker(outcomes: TaskOutcome[]): boolean {
  // Buffer each run of consecutive transient failures and decide how to log
  // it only once the run ends (a success, a non-transient failure, or the
  // end of the batch) — a run that reaches the threshold collapses into ONE
  // warn; a shorter run logs individually, same as before the breaker.
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
 * 429/529/timeout/network-blip — used only to decide whether a FINAL,
 * all-slots-exhausted failure counts toward the circuit breaker's
 * consecutive-failure run (see {@link logFailuresWithBreaker}) and cooldown
 * escalation above. This is coarser than — and serves a different purpose
 * from — `classifyCredentialFailure` in src/llm.ts: by the time an error
 * reaches here, {@link callWithCredentialRotation} has already rotated
 * across every configured credential slot for quota-exhaustion 429s and
 * backed off in place for transient ones, so a 429 surfacing here means
 * EVERY slot was tried and still failed — "the backend is in real
 * distress" either way. It intentionally does NOT distinguish
 * transient-vs-quota-exhausted the way llm.ts's rotation loop does; that
 * split is retry/rotation policy, this one is breaker/log-volume policy,
 * and conflating the two here would just be a second copy of the same
 * concern living in the wrong layer.
 */
function isTransientBackendFailure(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 529 || (err as Error).name === 'AbortError' || !status;
}
