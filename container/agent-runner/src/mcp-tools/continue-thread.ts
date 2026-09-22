/**
 * `continue_thread` on send_message/send_file (core.ts). Shape only: the host
 * (src/continue-thread.ts) resolves the value against the destination and adopts
 * it only when it has seen that thread there, so a wrong value costs a new
 * thread, never a misroute.
 */

// The host's CONTINUE_THREAD_MAX_LENGTH.
const CONTINUE_THREAD_MAX_LENGTH = 512;
const CONTINUE_THREAD_PATTERN = /^(?:https:\/\/\S+|[A-Za-z0-9][A-Za-z0-9._:-]*)$/;

export const CONTINUE_THREAD_DESCRIPTION =
  'Optional, and only together with thread_key. An EXISTING thread in the same destination that this key should continue instead of opening a new one: its id as search_threads prints it (thread=...), the bare thread id, or its Discord/Slack link. Used only by the first post under a key that has no thread yet: the host confirms the thread is in this destination, posts there, and every later post with the key goes there too. A key that already has a thread ignores it. If the host cannot confirm the thread, the post opens a new thread as usual.';

/**
 * Validate an optional continue_thread argument against its thread_key. Blank or
 * absent → none.
 */
export function parseContinueThread(
  raw: unknown,
  threadKey: string | null,
): { continueThread: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { continueThread: null };
  if (typeof raw !== 'string') return { error: 'continue_thread must be a string' };
  const value = raw.trim();
  if (!value) return { continueThread: null };
  if (!threadKey) {
    return { error: 'continue_thread needs thread_key: it names the thread that key continues in' };
  }
  if (value.length > CONTINUE_THREAD_MAX_LENGTH) {
    return { error: `continue_thread is too long (${value.length} characters, max ${CONTINUE_THREAD_MAX_LENGTH})` };
  }
  if (!CONTINUE_THREAD_PATTERN.test(value)) {
    return { error: 'continue_thread must be a thread id (letters, digits, . _ : -) or an https link to the thread' };
  }
  return { continueThread: value };
}
