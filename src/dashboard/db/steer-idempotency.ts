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
  // Row truth for target_type/target_id wins over whatever shape the
  // legacy cached_response JSON used — pre-C5 deploys persisted
  // `{task_id, message_id, echo_status}` only. Overriding from the
  // existing row fixes those replays without a JSON migration sweep.
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
 * Reserve (or replay) a steer slot for the given (user, idempotency_key). The
 * `target` ties the key to a specific (task or session) — replay with a
 * mismatched target raises `IdempotencyConflict('target')` rather than
 * silently letting one key write to two destinations.
 *
 * The select-then-insert below is exactly the race `insertOrAdopt` (seam 3
 * §4.5) exists for: under the async driver, two concurrent reserves for the
 * SAME key can both see "no existing row" and both attempt the INSERT. The
 * loser adopts the winner's row and runs it through the same conflict check
 * `fromExistingRow` applies to an ordinary replay — a concurrent race and a
 * later replay are the same case from this function's point of view.
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

  // Typed as the wide `Record<string, unknown>` rather than the literal
  // insert-column shape on purpose: `insertOrAdopt`'s type parameter is
  // shared between `candidate` and `reload`'s return, and `reload` here is
  // `selectExisting`, which returns the narrower `ExistingRow` (a SELECT
  // projection, not the INSERT columns) — the two shapes genuinely differ
  // (e.g. `reserved_at` vs `status`/`echo_attempted`). Neither branch's
  // result is read off the primitive's own return value below (both re-read
  // via `selectExisting` directly at line ~138), so the exact row shape
  // insertOrAdopt threads through is never observed — only that both
  // arguments satisfy ONE shared type, which `Record<string, unknown>` does.
  const candidate: Record<string, unknown> = {
    user_id: userId,
    idempotency_key: idempotencyKey,
    target_type: target.type,
    target_id: target.id,
    message_id: messageId,
    text,
    request_hash: requestHash,
    // ISO, never datetime('now') — the naive shape sorts below ISO as TEXT and
    // is misparsed as local by `new Date()`. See the CLAUDE.md timestamp rule.
    reserved_at: new Date().toISOString(),
  };

  // `ExistingRow` (a plain `interface`) has no index signature, so it is not
  // structurally assignable to `Record<string, unknown>` even though every
  // one of its properties is — hence the explicit widening cast on reload's
  // return rather than relying on assignability.
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

  // Re-read regardless of `created`: the plain INSERT above carries no
  // RETURNING, and the adopted-row branch needs the full row for the
  // conflict check the same way an ordinary replay does.
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
      // ISO, never datetime('now') — see reserveIdempotency above.
      applied_at: new Date().toISOString(),
    },
  );
}

export async function markEchoAttempted(idempotencyRowId: number): Promise<void> {
  await getDb().run('UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ?', idempotencyRowId);
}

/**
 * Atomically claim the echo-attempt slot — sets `echo_attempted = 1` if and only
 * if it was currently 0. Returns true iff this call won the race.
 *
 * Use this in lieu of the read-then-write check `if (!reserved.echoAttempted) ...
 * markEchoAttempted(...)` to prevent the echo-duplication race where two concurrent
 * retries of the same idempotency_key both see echo_attempted=0 at reservation
 * time and both schedule adapter.deliver, resulting in duplicate Slack/Discord
 * messages. Post-build QA fix SF-1.
 */
export async function claimEchoAttempted(idempotencyRowId: number): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ? AND echo_attempted = 0',
    idempotencyRowId,
  );
  return result.changes > 0;
}
