import { createHash } from 'crypto';

/** Length-prefix canonicalization: a user-supplied idempotency key containing ':' must not collide with another (parent_session_id, key) pair. */
export function deriveSpawnTaskId(parentSessionId: string, idempotencyKey: string): string {
  const canonical = `${parentSessionId.length}:${parentSessionId}${idempotencyKey.length}:${idempotencyKey}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `spawn-${hash}`;
}

export function computeRequestHash(content: string, deadline?: string | null): string {
  const d = deadline ?? '';
  const canonical = `${content.length}:${content}` + `${d.length}:${d}`;
  return createHash('sha256').update(canonical).digest('hex');
}
