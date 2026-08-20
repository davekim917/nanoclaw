import { describe, it, expect } from 'vitest';
import { actionError } from './action-error.js';

/**
 * The point of this module is that two rows never explain the same refusal two
 * different ways — so the tests that matter are the ones asserting one input
 * produces one sentence, and that the restart rule does not swallow a real 404.
 */
describe('actionError', () => {
  it('reads an unrecognised 404 as an unrouted endpoint, not a bug in the work', () => {
    expect(actionError({ status: 404, error: 'unknown' })).toBe('not active until the next host restart');
    // No body at all is the same fact.
    expect(actionError({ status: 404, error: '' })).toBe('not active until the next host restart');
  });

  it('does NOT apply the restart rule to the 404s this surface really produces', () => {
    expect(actionError({ status: 404, error: 'not_found' })).toBe('you cannot act on this thread');
    expect(actionError({ status: 404, error: 'thread_not_found' })).toBe('that thread is no longer in the window');
    expect(actionError({ status: 404, error: 'session_not_found' })).toBe('that session is gone — reload the queue');
  });

  it('names the wait when the rate limiter supplies one, and does not invent one when it does not', () => {
    expect(actionError({ status: 429, error: 'rate_limit_exceeded', retry_after: 12 })).toBe(
      'too fast — try again in 12s',
    );
    expect(actionError({ status: 429, error: 'rate_limit_exceeded' })).toBe('too fast — wait a moment');
  });

  it('translates the executor refusals the composer can hit', () => {
    expect(actionError({ status: 409, error: 'mismatched_idempotency_payload' })).toBe('you just sent that');
    expect(actionError({ status: 400, error: 'empty_message' })).toBe('say something first');
    expect(actionError({ status: 400, error: 'message_too_long' })).toBe('too long — shorten it');
  });

  it('names the agent in the wiring refusal, and falls back when nobody was named', () => {
    expect(actionError({ status: 409, error: 'agent_not_wired_to_thread_channel' }, 'ava')).toBe(
      "ava is not wired to this thread's channel",
    );
    expect(actionError({ status: 409, error: 'agent_not_wired_to_thread_channel' })).toBe(
      "that agent is not wired to this thread's channel",
    );
  });

  it('survives a thrown value that is not an ApiError at all', () => {
    expect(actionError(new Error('network down'))).toBe('request failed');
    expect(actionError(null)).toBe('request failed');
    expect(actionError(undefined)).toBe('request failed');
  });

  it('gives every caller the SAME sentence for the same refusal', () => {
    const refusal = { status: 404, error: 'thread_not_found' };
    expect(actionError(refusal)).toBe(actionError(refusal, 'ava'));
  });
});
