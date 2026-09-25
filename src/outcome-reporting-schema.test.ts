import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { canonicalWorkItem, renderWorkOutcome, requestWorkItem } from './outcome-reporting-schema.js';

describe('outcome wire contract', () => {
  it('normalizes durable identities, rejects phases and preserves separate work items', () => {
    expect(canonicalWorkItem('https://github.com/ORG/Repo/pull/17?x=1#discussion')).toBe('github:org/repo:pull:17');
    expect(canonicalWorkItem('https://org.slack.com/archives/c123/p1700000000000001?thread_ts=1')).toBe(
      'slack:org.slack.com:C123:1700000000000001',
    );
    for (const value of [
      'review-round-2',
      'pr-17',
      'https://github.com/org/repo/pull/17/files',
      'https://evil.example/17',
    ])
      expect(() => canonicalWorkItem(value)).toThrow();
    expect(canonicalWorkItem('https://github.com/org/repo/issues/17')).not.toBe(
      canonicalWorkItem('https://github.com/org/repo/pull/17'),
    );
  });
  it('rejects long or invalid evidence while allowing a concise outcome without a URL', () => {
    const evidence = {
      workItem: 'https://github.com/org/repo/pull/17',
      verified: 'Tests passed',
      evidence: 'https://github.com/org/repo/pull/17',
    };
    expect(() => renderWorkOutcome('x'.repeat(321), evidence)).toThrow();
    expect(() => renderWorkOutcome('Fixed', { ...evidence, evidence: '/workspace/report.md' })).toThrow();
    expect(renderWorkOutcome('Checkout works again.', evidence).text).toContain('No action needed.');
    expect(
      renderWorkOutcome('Checkout works again.', { workItem: evidence.workItem, verified: 'Tests passed' }).text,
    ).not.toContain('Details:');
  });
  it('derives shared opaque keys from a trusted platform origin and session fallback otherwise', () => {
    const a = {
      sessionId: 'session-a',
      messageId: 'platform-1:agent-a',
      sequence: 2,
      origin: { channelType: 'discord', platformId: 'discord:g:c', platformMessageId: 'platform-1' },
    };
    const b = { ...a, sessionId: 'session-b', messageId: 'platform-1:agent-b', sequence: 8 };
    expect(requestWorkItem(a)).toBe(requestWorkItem(b));
    expect(requestWorkItem({ ...a, origin: undefined })).not.toBe(requestWorkItem({ ...b, origin: undefined }));
    expect(renderWorkOutcome('Done.', { requestId: 2, verified: 'Checked' }, a).key).toBe(requestWorkItem(a));
    expect(() => renderWorkOutcome('Done.', { requestId: 4, verified: 'Checked' }, a)).toThrow();
  });
  it('keeps host and separately packaged runner validation identical', () => {
    // Each tree exports only what its own callers use, so `export` may differ.
    // RUNNER_ONLY names a one-line declaration the runner's tools use and the
    // host never reads; the host omits it instead of carrying dead code. Every
    // other byte must match, and the list must stay exact: each name has to be
    // declared in the runner and absent from the host.
    const RUNNER_ONLY = ['OUTCOME_PURPOSES'];
    const declaration = (name: string) => new RegExp(`^(?:export )?const ${name}\\b.*\\n\\n`, 'm');
    const runner = fs.readFileSync('container/agent-runner/src/outcome-reporting-schema.ts', 'utf8');
    const host = fs.readFileSync('src/outcome-reporting-schema.ts', 'utf8');
    for (const name of RUNNER_ONLY) {
      expect(runner).toMatch(declaration(name));
      expect(host).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    const body = (source: string) => source.replace(/^export /gm, '');
    const runnerShared = RUNNER_ONLY.reduce((source, name) => source.replace(declaration(name), ''), runner);
    expect(body(runnerShared)).toBe(body(host));
  });
});
