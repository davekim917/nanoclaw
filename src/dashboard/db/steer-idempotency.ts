import { getDb } from '../../db/connection.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';

type SteerTargetType = 'task' | 'session';

export interface SteerTarget {
  type: SteerTargetType;
  id: string;
}

export interface SteerResponse {
  target_type: SteerTargetType;
  target_id: string;
  message_id: string;
  echo_status: string;
}

export interface ReservedSteer {
  id: number;
  messageId: string;
  status: 'pending' | 'applied';
  storedText: string;
  echoAttempted: boolean;
  cached?: SteerResponse;
}

export class IdempotencyConflict extends Error {
  readonly conflictKind: 'target' | 'request_hash';
  constructor(kind: 'target' | 'request_hash') {
    super(`Idempotency conflict: ${kind} mismatch`);
    this.conflictKind = kind;
  }
}

interface ExistingRow {
  id: number;
  message_id: string;
  target_type: SteerTargetType;
  target_id: string;
  request_hash: string;
  status: 'pending' | 'applied';
  echo_attempted: number;
  text: string;
  cached_response: string | null;
}

async function selectExisting(userId: string, idempotencyKey: string): Promise<ExistingRow | undefined> {
  return getDb().get<ExistingRow>(
    `SELECT id, message_id, target_type, target_id, request_hash, status, echo_attempted, text, cached_response
       FROM steer_idempotency
      WHERE user_id = ? AND idempotency_key = ?`,
    userId,
    idempotencyKey,
  );
}

/** Convert an existing row into the caller's result, or throw on a mismatched replay. */
function fromExistingRow(existing: ExistingRow, target: SteerTarget, requestHash: string): ReservedSteer {
  if (existing.target_type !== target.type || existing.target_id !== target.id) {
    throw new IdempotencyConflict('target');
  }
  if (existing.request_hash !== requestHash) throw new IdempotencyConflict('request_hash');
  // Row values for target_type/target_id win over legacy cached_response JSON, which lacked them.
  const cached =
    existing.status === 'applied' && existing.cached_response
      ? ({
          ...(JSON.parse(existing.cached_response) as Record<string, unknown>),
          target_type: existing.target_type,
          target_id: existing.target_id,
        } as SteerResponse)
      : undefined;
  return {
    id: existing.id,
    messageId: existing.message_id,
    status: existing.status,
    storedText: existing.text,
    echoAttempted: existing.echo_attempted === 1,
    cached,
  };
}

/**
 * Reserves (or replays) a steer slot for (user, idempotency_key). A replay with a different target raises
 * `IdempotencyConflict('target')` rather than letting one key write to two destinations. Two concurrent reserves can
 * both see no row; `insertOrAdopt` makes the loser adopt the winner's row and run the same conflict check as a
 * replay.
 */
export async function reserveIdempotency(
  userId: string,
  idempotencyKey: string,
  target: SteerTarget,
  messageId: string,
  text: string,
  requestHash: string,
): Promise<ReservedSteer> {
  const existing = await selectExisting(userId, idempotencyKey);
  if (existing) return fromExistingRow(existing, target, requestHash);

  // Widened to `Record<string, unknown>` because `insertOrAdopt` shares one type parameter between `candidate` and
  // `reload`, whose SELECT projection differs from the INSERT columns; neither return value is read.
  const candidate: Record<string, unknown> = {
    user_id: userId,
    idempotency_key: idempotencyKey,
    target_type: target.type,
    target_id: target.id,
    message_id: messageId,
    text,
    request_hash: requestHash,
    // ISO, never datetime('now').
    reserved_at: new Date().toISOString(),
  };

  // `ExistingRow` has no index signature, so the cast on reload's return is required.
  const { created } = await insertOrAdopt(
    candidate,
    async (row) => {
      await getDb().run(
        `INSERT INTO steer_idempotency
           (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
         VALUES (@user_id, @idempotency_key, @target_type, @target_id, @message_id, @text, @request_hash, @reserved_at, 'pending', 0)`,
        row,
      );
    },
    async () => (await selectExisting(userId, idempotencyKey)) as Record<string, unknown> | undefined,
  );

  // Re-read regardless of `created`: the INSERT has no RETURNING, and the adopted branch needs the full row for the
  // conflict check.
  const row = await selectExisting(userId, idempotencyKey);
  if (!row) throw new Error('reserveIdempotency: row vanished immediately after insert/adopt');
  if (!created) return fromExistingRow(row, target, requestHash);

  return {
    id: row.id,
    messageId: row.message_id,
    status: row.status,
    storedText: row.text,
    echoAttempted: row.echo_attempted === 1,
  };
}

export async function applyIdempotency(userId: string, idempotencyKey: string, response: SteerResponse): Promise<void> {
  await getDb().run(
    `UPDATE steer_idempotency
       SET status = 'applied', applied_at = @applied_at, cached_response = @cached_response
     WHERE user_id = @user_id AND idempotency_key = @idempotency_key AND status != 'applied'`,
    {
      user_id: userId,
      idempotency_key: idempotencyKey,
      cached_response: JSON.stringify(response),
      // ISO, never datetime('now').
      applied_at: new Date().toISOString(),
    },
  );
}

export async function markEchoAttempted(idempotencyRowId: number): Promise<void> {
  await getDb().run('UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ?', idempotencyRowId);
}

/**
 * Atomically claims the echo slot (sets `echo_attempted = 1` only if it was 0); true iff this call won. Use instead
 * of read-then-write, which lets two concurrent retries both echo.
 */
export async function claimEchoAttempted(idempotencyRowId: number): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ? AND echo_attempted = 0',
    idempotencyRowId,
  );
  return result.changes > 0;
}
