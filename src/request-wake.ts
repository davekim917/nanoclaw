/**
 * The wake seam.
 *
 * Every "make this session's container run" call site migrates from
 * importing `wakeContainer` directly to `requestWake`, giving wake intent a
 * single chokepoint so it can later be recorded durably (`wake_signals` in
 * src/db/coordination.ts) and served event-driven. The implementation below
 * is a pure delegation — byte-equivalent to calling `wakeContainer` — and
 * MUST stay that way until the durable rows become authoritative: no
 * logging, no signal writes, no behavior.
 *
 * Upstream's `'interactive'` reason is deliberately absent: it collides with the MemoryAdmissionPriority of the same
 * name (hence the named WakeRequest), and an interactive-answer wake re-woke dead sessions every sweep.
 */
import { wakeContainer, type WakeGuard } from './container-runner.js';
import type { MemoryAdmissionPriority } from './memory-admission.js';
import type { Session } from './types.js';

/**
 * Why the session should be running. Later recorded on the wake-signal row;
 * extend the union as call sites migrate.
 */
export type WakeReason =
  | 'inbound-message'
  | 'due-message'
  | 'container-restart'
  | 'self-mod-apply'
  | 'agent-created'
  | 'cli'
  | 'approval-response'
  | 'adoption';

/** The fork's extra wake arguments, as a named object so they never collide with a positional reason. */
export interface WakeRequest {
  /** Forwarded to `wakeContainer`'s `priority` parameter; defaults there to `'interactive'`. */
  priority?: MemoryAdmissionPriority;
  /** Forwarded to `wakeContainer`'s `options.guard`. */
  guard?: WakeGuard;
}

export async function requestWake(session: Session, _reason: WakeReason, request: WakeRequest = {}): Promise<boolean> {
  return wakeContainer(session, request.priority, { guard: request.guard });
}
