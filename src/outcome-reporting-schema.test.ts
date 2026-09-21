import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { canonicalWorkItem, renderWorkOutcome } from './outcome-reporting-schema.js';

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
  it('rejects long or missing evidence rather than producing an unreadable/truncated report', () => {
    const evidence = {
      workItem: 'https://github.com/org/repo/pull/17',
      verified: 'Tests passed',
      evidence: 'https://github.com/org/repo/pull/17',
    };
    expect(() => renderWorkOutcome('x'.repeat(321), evidence)).toThrow();
    expect(() => renderWorkOutcome('Fixed', { ...evidence, evidence: '/workspace/report.md' })).toThrow();
    expect(renderWorkOutcome('Checkout works again.', evidence).text).toContain('No action needed.');
  });
  it('keeps host and separately packaged runner validation identical', () => {
    expect(fs.readFileSync('container/agent-runner/src/outcome-reporting-schema.ts', 'utf8')).toBe(
      fs.readFileSync('src/outcome-reporting-schema.ts', 'utf8'),
    );
  });
});
