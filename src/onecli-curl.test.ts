/**
 * The two primitives both OneCLI curl callers depend on (issue #876 P2-1).
 *
 * The escaping case is not hypothetical: the MCP OAuth writer puts a whole JSON
 * body through it, and a token is arbitrary bytes. The round-trip encoded here
 * was checked against curl 8.5.0 with a real request — a body containing both a
 * quote and a backslash arrives byte-identical at the server.
 */
import { describe, expect, it } from 'vitest';

import { curlConfigEscape, OnecliCurlError, sanitizeCurlFailure } from './onecli-curl.js';
import { enforceHermeticity } from './test-hermeticity.js';

enforceHermeticity();

describe('curlConfigEscape', () => {
  it('doubles backslashes before quotes, so neither escapes the other', () => {
    expect(curlConfigEscape('plain')).toBe('plain');
    expect(curlConfigEscape('a"b')).toBe('a\\"b');
    expect(curlConfigEscape('a\\b')).toBe('a\\\\b');
    // The order matters: escaping quotes first would then escape the
    // backslash it just introduced.
    expect(curlConfigEscape('a\\"b')).toBe('a\\\\\\"b');
  });

  it('keeps a JSON body intact, including the two-character \\n that JSON emits', () => {
    const body = JSON.stringify({ value: 'line1\nline2', name: 'X"Y\\Z' });
    // No literal newline survives into the config line — that would end the
    // parameter early.
    expect(curlConfigEscape(body)).not.toMatch(/\n/);
    expect(curlConfigEscape(body)).toContain('\\\\n');
  });
});

describe('sanitizeCurlFailure', () => {
  const label = 'PATCH /api/secrets/abc';

  it('reports the exit code and its meaning, never the error text', () => {
    const raw: NodeJS.ErrnoException = new Error('Command failed: curl -H "Authorization: Bearer SECRET" …');
    raw.code = 7 as unknown as string;
    const sanitized = sanitizeCurlFailure(label, raw);
    expect(sanitized).toBeInstanceOf(OnecliCurlError);
    expect(sanitized.message).toBe(`OneCLI ${label} failed: curl exit code 7 (could not connect)`);
    expect(sanitized.message).not.toContain('SECRET');
    // No `cause` chain either: structured loggers print it.
    expect((sanitized as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('handles a signal, a Node-level error code, and an unrecognized shape', () => {
    expect(sanitizeCurlFailure(label, { signal: 'SIGKILL' }).message).toContain('killed by SIGKILL');
    expect(sanitizeCurlFailure(label, { code: 'ENOENT' }).message).toContain('could not be run (ENOENT)');
    expect(sanitizeCurlFailure(label, undefined).message).toBe(`OneCLI ${label} failed: curl failed`);
  });

  it('does not invent a meaning for an exit code it has no entry for', () => {
    expect(sanitizeCurlFailure(label, { code: 91 }).message).toBe(`OneCLI ${label} failed: curl exit code 91`);
  });
});
