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
 * Returns true when the host process has a viable path to Anthropic. Two
 * supported modes:
 *
 *   1. Direct API key — `ANTHROPIC_API_KEY` is set on the process.
 *   2. OneCLI gateway proxy — `HTTPS_PROXY` (or HTTP_PROXY) is set AND
 *      `CLAUDE_CODE_OAUTH_TOKEN` is non-empty. The gateway substitutes
 *      the literal "placeholder" Bearer with the vault token at request
 *      time. This is the production path; the systemd unit wires
 *      HTTPS_PROXY=http://127.0.0.1:10255 + CLAUDE_CODE_OAUTH_TOKEN
 *      =placeholder.
 *
 * The test backend override is always considered configured so unit
 * tests don't need to set any env vars.
 */
export function isBackendConfigured(): boolean {
  if (_backendOverride !== null) return true;
  if (process.env['ANTHROPIC_API_KEY']) return true;
  const hasProxy = !!(
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
  return hasProxy && !!process.env['CLAUDE_CODE_OAUTH_TOKEN'];
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

async function callTitleBackend(system: string, user: string, signal: AbortSignal): Promise<string> {
  if (_backendOverride !== null) {
    return await Promise.race([
      _backendOverride(system, user),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
  }

  const directApiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '';
  const useOauth = !directApiKey && oauthToken;
  if (!directApiKey && !useOauth) {
    throw new Error('session-title: no Anthropic credentials available');
  }

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

  const authHeaders: Record<string, string> = useOauth
    ? { authorization: `Bearer ${oauthToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
    : { 'x-api-key': directApiKey };

  const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`session-title: Anthropic returned ${resp.status}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return text;
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
  if (merged.length === 0) return { text: '', maxSeq: -1 };

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
  return { text: lines.join('\n'), maxSeq: tail[tail.length - 1]!.seq };
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

  const candidates = pickCandidates(CONCURRENCY_CAP);
  if (candidates.length === 0) return { generated: 0, skipped: 0 };

  let generated = 0;
  let skipped = 0;
  const tasks: Array<Promise<void>> = [];

  for (const row of candidates) {
    if (tasks.length >= CONCURRENCY_CAP) break;
    const slice = readSessionSlice(row.agent_group_id, row.id);
    // Empty / no-usable-content session: nothing to summarize. STAMP a backoff
    // so it exits the candidate pool rather than re-entering every tick. Without
    // this, a backlog of empty NULL-title shells permanently occupies the LIMIT
    // and starves real sessions (the sweep skips all N and generates 0 forever
    // — the clog this fix targets). A stamped shell that later gains content
    // re-enters after the cooldown ages out and gets titled then.
    if (slice.maxSeq < 0 || !slice.text) {
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
      (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
        try {
          const raw = await callTitleBackend(SYSTEM_PROMPT, slice.text, controller.signal);
          const title = postProcessTitle(raw);
          if (!title) {
            skipped++;
            return;
          }
          persistTitle(row.id, title, slice.maxSeq, new Date().toISOString());
          generated++;
        } catch (err) {
          log.warn('session-title: backend call failed', {
            sessionId: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
          try {
            stampFailureBackoff(row.id);
          } catch {
            /* stamp failure is non-fatal — next tick will retry */
          }
          skipped++;
        } finally {
          clearTimeout(timer);
        }
      })(),
    );
  }

  await Promise.all(tasks);
  return { generated, skipped };
}
