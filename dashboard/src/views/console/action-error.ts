import type { ApiError } from '../../lib/api.js';

/**
 * Why an action was refused, in the operator's words.
 *
 * Ported from the legacy Observatory's `actionError`, and for its reason:
 * shared by every surface, because they all hit the same two endpoints — two
 * rows must never explain the same refusal two different ways. The console has
 * four call sites (the queue's close and snooze, triage's verdicts, the
 * composer's send) and before this they each printed the raw wire code.
 *
 * The claim / release-item branches did not come across: this surface has no
 * claim slug and no board item to refuse.
 */

/**
 * 404s the console genuinely produces at runtime — a permission gate answering
 * §2a's disclose-as-not-found, a thread that has aged out, a session that was
 * archived under the operator. Everything ELSE that 404s is the restart rule
 * below, and this set is what keeps the two apart. The legacy version kept the
 * same list under the names `claim_not_found` / `item_not_on_board`.
 */
const REAL_404 = new Set(['not_found', 'thread_not_found', 'session_not_found']);

export function actionError(e: unknown, who?: string): string {
  const err = e as Partial<ApiError> | null;
  const code = err?.error ?? '';

  // These endpoints ship restart-gated: until the host restarts they simply
  // aren't routed, and "unknown" would read as a bug in the work.
  if (err?.status === 404 && !REAL_404.has(code)) return 'not active until the next host restart';

  if (code === 'not_found') return 'you cannot act on this thread';
  if (code === 'thread_not_found') return 'that thread is no longer in the window';
  if (code === 'session_not_found') return 'that session is gone — reload the queue';

  // Rate limiting, both shapes: the executor's window, and the reserve-before-
  // write idempotency check that catches the same words twice.
  if (code === 'rate_limit_exceeded') {
    const wait = err?.retry_after;
    return wait ? `too fast — try again in ${Math.ceil(wait)}s` : 'too fast — wait a moment';
  }
  if (code === 'mismatched_idempotency_payload') return 'you just sent that';

  if (code === 'empty_message') return 'say something first';
  if (code === 'message_too_long') return 'too long — shorten it';
  if (code === 'agent_not_wired_to_thread_channel')
    return `${who ?? 'that agent'} is not wired to this thread's channel`;
  if (code === 'invalid_request') return 'the console sent a malformed request';

  return code || 'request failed';
}
