/**
 * The wake seam.
 *
 * Every "make this session's container run" call site migrates from
 * importing `wakeContainer` directly to `requestWake`, giving wake intent a
 * single chokepoint so it can later be recorded durably (`wake_signals` in
 * src/db/coordination.ts) and served event-driven. The implementation below
 * is a pure delegation — byte-equivalent to calling `wakeContainer` directly
 * with the same arguments — and MUST stay that way until the durable rows
 * become authoritative: no logging, no signal writes, no behavior.
 *
 * This is a RE-DERIVATION of upstream's seam
 * (`nanocoai/nanoclaw@3c2fd4f82:src/request-wake.ts`), not a byte-copy — see
 * docs/specs/upstream-theme-ports/plan.md T0 §3.1/§3.2/§4.1. Upstream's
 * `requestWake(session, reason)` drops the fork's `MemoryAdmissionPriority`
 * and `WakeGuard` arguments that six call sites depend on today. Upstream's
 * `WakeReason` union also includes `'interactive'`, which collides with the
 * fork's distinct `MemoryAdmissionPriority` value of the same name (see
 * `src/memory-admission.ts`) — a mechanical port would typecheck while
 * silently dropping priority and guard at those sites. Priority and guard
 * therefore travel through a named `WakeRequest` object, never a second
 * positional argument, so that collision cannot recur.
 *
 * `'interactive'` (the `WakeReason`, upstream's ask-user-question answer) is
 * deliberately NOT reproduced here: the fork's
 * `src/modules/interactive/index.ts` never wakes on an interactive answer
 * (see the comment there) because a trigger-1 row there re-woke a dead
 * session every sweep for 24h, holding a memory-budget slot the whole time.
 * Do not add a caller that reintroduces that wake.
 */
import { wakeContainer, type WakeGuard } from './container-runner.js';
import type { MemoryAdmissionPriority } from './memory-admission.js';
import type { Session } from './types.js';

/**
 * Why the session should be running. Later recorded on the wake-signal row;
 * extend the union as call sites migrate. This is upstream's `WakeReason`
 * union minus `'interactive'` (see the module comment above) — the fork-only
 * call sites converted in a later PR of this series reuse these reasons;
 * none has needed a reason upstream did not already declare.
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

/**
 * The fork's extra wake arguments, carried as a named object rather than
 * upstream's plain two-argument form — see the module comment.
 */
export interface WakeRequest {
  /** Forwarded to `wakeContainer`'s `priority` parameter; defaults there to `'interactive'`. */
  priority?: MemoryAdmissionPriority;
  /** Forwarded to `wakeContainer`'s `options.guard`. */
  guard?: WakeGuard;
}

export async function requestWake(session: Session, _reason: WakeReason, request: WakeRequest = {}): Promise<boolean> {
  return wakeContainer(session, request.priority, { guard: request.guard });
}
