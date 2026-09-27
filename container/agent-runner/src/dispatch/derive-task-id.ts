/**
 * IDENTICAL algorithm to the host's src/modules/orchestrator-dispatch/derive-task-id.ts (separate package trees,
 * no import); kept in sync by the contract test against tests/fixtures/spawn-task-id-vectors.json.
 * Length-prefixed so a user-supplied idempotency key containing ':' cannot collide with another pair.
 */
import { createHash } from 'crypto';

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
