/**
 * Insert-or-verify one controller-send chat row atomically with its attachment digests and the per-run budget.
 * A named op here because the runner's raw-access allowlist must stay exactly empty
 * (src/mailbox-seam-ratchet.test.ts).
 */
import { createOutboundRecord } from '../../mailbox/model.generated.js';
import { getInboundDb, getOutboundDb } from '../../mailbox/sqlite/connection.js';

interface ControllerSendRowPayload {
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  deliver_after: string | null;
  content: string;
}

type ControllerSendDigests = Array<{ name: string; sha256: string }>;

interface ControllerSendBudgetState {
  total: number;
  fire: string;
  fireCount: number;
  fingerprints: Record<string, number>;
}

function controllerSendDigestKey(id: string): string {
  return `controller_send_files:${id}`;
}

function controllerSendBudgetKey(runId: string): string {
  return `controller_send_budget:${runId}`;
}

/** The digests recorded with an existing row; null when absent or unreadable. */
function readControllerSendDigests(id: string): ControllerSendDigests | null {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(controllerSendDigestKey(id)) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (d) => d && typeof d === 'object' && typeof d.name === 'string' && /^[0-9a-f]{64}$/.test(String(d.sha256)),
      )
    ) {
      return parsed as ControllerSendDigests;
    }
  } catch {
    // fall through: unreadable is not "no files"
  }
  return null;
}

/**
 * The per-run budget counters. Throws through `onUnreadable` rather than
 * returning zeroes: an unreadable counter must not read as "nothing sent".
 */
function readControllerSendBudget(runId: string, onUnreadable: (runId: string) => Error): ControllerSendBudgetState {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(controllerSendBudgetKey(runId)) as { value: string } | undefined;
  if (!row) return { total: 0, fire: '', fireCount: 0, fingerprints: {} };
  try {
    const parsed = JSON.parse(row.value) as ControllerSendBudgetState;
    return {
      total: Number(parsed.total) || 0,
      fire: String(parsed.fire ?? ''),
      fireCount: Number(parsed.fireCount) || 0,
      fingerprints: parsed.fingerprints && typeof parsed.fingerprints === 'object' ? parsed.fingerprints : {},
    };
  } catch {
    throw onUnreadable(runId);
  }
}

export interface ControllerSendRowInput {
  id: string;
  runId: string;
  fire: string;
  fingerprint: string | null | undefined;
  wanted: ControllerSendRowPayload;
  digests: ControllerSendDigests;
  /** Runs inside the write transaction before the row exists (the host reads `<outbox>/<id>/` on delivery); a crash leaves a directory the retry overwrites. */
  stageAttachments: () => void;
  samePayload: (a: ControllerSendRowPayload, b: ControllerSendRowPayload) => boolean;
  sameDigests: (stored: ControllerSendDigests | null, wanted: ControllerSendDigests) => boolean;
  budgetRefusal: (state: ControllerSendBudgetState, fire: string, fingerprint: string | null | undefined) => string | null;
  /** Built by the caller so the CLI keeps ownership of its exit-code taxonomy. */
  mismatchError: (message: string) => Error;
  budgetError: (message: string) => Error;
  unreadableBudgetError: (runId: string) => Error;
}

export interface ControllerSendRowResult {
  outcome: 'enqueued' | 'replay';
  seq: number;
}

/**
 * Insert-or-verify, atomic with the budget. Requires a started mailbox (the
 * CLI) or initTestSessionDb() (tests).
 */
export function writeControllerSendRow(input: ControllerSendRowInput): ControllerSendRowResult {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();
  const select = outbound.prepare(
    'SELECT seq, kind, platform_id, channel_type, thread_id, in_reply_to, deliver_after, content FROM messages_out WHERE id = ?',
  );
  outbound.exec('BEGIN IMMEDIATE');
  try {
    const existing = select.get(input.id) as (ControllerSendRowPayload & { seq: number }) | undefined;
    if (existing) {
      outbound.exec('ROLLBACK');
      if (!input.samePayload(existing, input.wanted)) {
        throw input.mismatchError(`id ${input.id} already holds a different payload; refusing to overwrite`);
      }
      if (!input.sameDigests(readControllerSendDigests(input.id), input.digests)) {
        throw input.mismatchError(
          `id ${input.id} already holds different attachment bytes (or no digest record); refusing to overwrite`,
        );
      }
      return { outcome: 'replay', seq: existing.seq };
    }

    const budget = readControllerSendBudget(input.runId, input.unreadableBudgetError);
    const refusal = input.budgetRefusal(budget, input.fire, input.fingerprint);
    if (refusal) throw input.budgetError(refusal);

    input.stageAttachments();

    // Same rule as upstream's sqliteWriteMessageOut: the container claims odd seq numbers above every row on both sides.
    const maxOut = (
      outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out').get() as { value: number }
    ).value;
    const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in').get() as { value: number })
      .value;
    const max = Math.max(maxOut, maxIn);
    const sequence = max % 2 === 0 ? max + 1 : max + 2;
    const record = createOutboundRecord(
      {
        id: input.id,
        kind: 'chat',
        platformId: input.wanted.platform_id,
        channelType: input.wanted.channel_type,
        threadId: input.wanted.thread_id,
        content: input.wanted.content,
      },
      sequence,
      new Date().toISOString(),
    );
    const inserted = outbound
      .prepare(
        `INSERT INTO messages_out
           (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
         VALUES
           ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        $id: record.id,
        $seq: record.sequence,
        $in_reply_to: record.inReplyTo,
        $timestamp: record.timestamp,
        $deliver_after: record.deliverAfter,
        $recurrence: record.recurrence,
        $kind: record.kind,
        $platform_id: record.platformId,
        $channel_type: record.channelType,
        $thread_id: record.threadId,
        $content: record.content,
      });
    const back = select.get(input.id) as (ControllerSendRowPayload & { seq: number }) | undefined;
    if (!back || !input.samePayload(back, input.wanted)) {
      throw input.mismatchError(`read-back of ${input.id} does not match the payload written`);
    }
    if (inserted.changes === 1 && input.digests.length) {
      outbound
        .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(controllerSendDigestKey(input.id), JSON.stringify(input.digests), new Date().toISOString());
    }
    if (inserted.changes === 1) {
      const fireCount = budget.fire === input.fire ? budget.fireCount : 0;
      const next: ControllerSendBudgetState = {
        total: budget.total + 1,
        fire: input.fire,
        fireCount: fireCount + 1,
        fingerprints: input.fingerprint
          ? { ...budget.fingerprints, [input.fingerprint]: (budget.fingerprints[input.fingerprint] ?? 0) + 1 }
          : budget.fingerprints,
      };
      outbound
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(controllerSendBudgetKey(input.runId), JSON.stringify(next), new Date().toISOString());
    }
    outbound.exec('COMMIT');
    return { outcome: inserted.changes === 1 ? 'enqueued' : 'replay', seq: back.seq };
  } catch (err) {
    if (outbound.inTransaction) outbound.exec('ROLLBACK');
    throw err;
  }
}
