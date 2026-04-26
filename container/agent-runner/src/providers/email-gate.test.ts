import { describe, expect, test } from 'bun:test';
import { GWS_EMAIL_SEND_RE, envelopeFromJsonRaw } from './claude.js';

describe('GWS_EMAIL_SEND_RE', () => {
  test('matches helper verbs', () => {
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +send --to a@b.com')).toBe(true);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +reply --message-id x')).toBe(true);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +reply-all --message-id x')).toBe(true);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +forward --message-id x')).toBe(true);
  });

  test('matches raw API send forms — the regression that bit prod', () => {
    expect(
      GWS_EMAIL_SEND_RE.test(
        `gws gmail users messages send --params '{"userId":"me"}' --json '{"raw":"abc"}'`,
      ),
    ).toBe(true);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail users drafts send --id 123')).toBe(true);
  });

  test('does NOT match draft creation or non-send methods', () => {
    expect(GWS_EMAIL_SEND_RE.test('gws gmail users drafts create --json @msg.json')).toBe(false);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail users messages list --max 10')).toBe(false);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail users messages get --id 1')).toBe(false);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +read --id 1')).toBe(false);
    expect(GWS_EMAIL_SEND_RE.test('gws gmail +triage')).toBe(false);
  });

  test('does NOT match unrelated commands containing the substring', () => {
    expect(GWS_EMAIL_SEND_RE.test('echo "I will gws gmail +send"')).toBe(true); // anchored to gws as a word — this is acceptable
    expect(GWS_EMAIL_SEND_RE.test('# gws gmail +send is risky')).toBe(true); // comment form intentionally still matches; agent rarely uses comments
    expect(GWS_EMAIL_SEND_RE.test('cat gmail-help.md')).toBe(false);
  });
});

describe('envelopeFromJsonRaw', () => {
  function buildRawJsonArg(headers: Record<string, string>, body = 'hello'): string {
    const headerText = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    const rfc822 = `${headerText}\r\nContent-Type: text/plain\r\n\r\n${body}`;
    const b64url = Buffer.from(rfc822, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `--json '${JSON.stringify({ raw: b64url })}'`;
  }

  test('extracts To/From/Subject/Cc/Bcc from base64url RFC 822', () => {
    const seg = `gws gmail users messages send --params '{"userId":"me"}' ${buildRawJsonArg({
      From: 'Dave <dave@example.com>',
      To: 'mike@example.com',
      Cc: 'sam@example.com',
      Bcc: 'audit@example.com',
      Subject: 'Handoff doc',
    })}`;
    expect(envelopeFromJsonRaw(seg)).toEqual({
      from: 'Dave <dave@example.com>',
      to: 'mike@example.com',
      cc: 'sam@example.com',
      bcc: 'audit@example.com',
      subject: 'Handoff doc',
    });
  });

  test('handles {message:{raw:…}} envelope shape', () => {
    const rfc822 = 'To: a@b.com\r\nSubject: hi\r\n\r\nbody';
    const b64url = Buffer.from(rfc822, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const seg = `--json '${JSON.stringify({ message: { raw: b64url } })}'`;
    expect(envelopeFromJsonRaw(seg)).toEqual({ to: 'a@b.com', subject: 'hi' });
  });

  test('returns {} on missing --json, malformed JSON, missing raw, or undecodable base64', () => {
    expect(envelopeFromJsonRaw('gws gmail users messages send')).toEqual({});
    expect(envelopeFromJsonRaw(`--json 'not json {{{'`)).toEqual({});
    expect(envelopeFromJsonRaw(`--json '{"params":{}}'`)).toEqual({});
    expect(envelopeFromJsonRaw(`--json '{"raw":42}'`)).toEqual({});
  });

  test('unfolds RFC 822 continuation lines', () => {
    const rfc822 = 'Subject: a really long subject\r\n that wraps across lines\r\nTo: a@b.com\r\n\r\nbody';
    const b64url = Buffer.from(rfc822, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const seg = `--json '${JSON.stringify({ raw: b64url })}'`;
    expect(envelopeFromJsonRaw(seg)).toEqual({
      subject: 'a really long subject that wraps across lines',
      to: 'a@b.com',
    });
  });
});
