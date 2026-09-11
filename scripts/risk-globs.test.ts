import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

import { globsForRiskHigh } from './review-outcomes.js';
import { assertFullyClassified, containerRiskGlobs, hostRiskGlobs, splitRiskGlobs } from './risk-globs.js';

// Pure string filtering plus one real-file read (the integration case below) — no
// subprocess or network use.
enforceHermeticity();

describe('hostRiskGlobs', () => {
  it('keeps src/ and scripts/ globs that target .ts files (literal or a directory glob)', () => {
    expect(hostRiskGlobs(['src/router.ts', 'src/guard/**', 'scripts/check-public-boundary.ts'])).toEqual([
      'src/router.ts',
      'src/guard/**',
      'scripts/check-public-boundary.ts',
    ]);
  });

  it('drops non-.ts files under src/ or scripts/', () => {
    expect(hostRiskGlobs(['scripts/deploy.sh', 'scripts/git-safety*.sh', 'scripts/wiki-autopush.sh'])).toEqual([]);
  });

  it('drops container/, config, and doc globs', () => {
    expect(
      hostRiskGlobs([
        'container/agent-runner/src/poll-loop.ts',
        'pnpm-workspace.yaml',
        'container/Dockerfile',
        '.github/**',
        '.husky/**',
        '.public-boundary-allowlist.json',
        'docs/review-policy.md',
      ]),
    ).toEqual([]);
  });
});

describe('containerRiskGlobs', () => {
  it('keeps only container/agent-runner/ globs', () => {
    expect(
      containerRiskGlobs([
        'container/agent-runner/src/poll-loop.ts',
        'container/agent-runner/src/mailbox/sqlite/**',
        'src/router.ts',
        'container/Dockerfile',
        'container/skills/pr-review-loop/**',
      ]),
    ).toEqual(['container/agent-runner/src/poll-loop.ts', 'container/agent-runner/src/mailbox/sqlite/**']);
  });
});

describe('assertFullyClassified', () => {
  it('does not throw when every glob is host, container, or a known non-code path', () => {
    expect(() =>
      assertFullyClassified(['src/router.ts', 'container/agent-runner/src/poll-loop.ts', 'pnpm-workspace.yaml']),
    ).not.toThrow();
  });

  it('throws on a glob that is neither host, container, nor known non-code (e.g. a wrong extension)', () => {
    expect(() => assertFullyClassified(['src/some-new-thing.tsx'])).toThrow(/neither host code, container code/i);
  });

  it('throws on a glob under a directory outside src/, scripts/, and container/agent-runner/', () => {
    expect(() => assertFullyClassified(['lib/new-module/**'])).toThrow(/lib\/new-module\/\*\*/);
  });

  it('lists every offending glob in the error, not just the first', () => {
    expect(() => assertFullyClassified(['a.tsx', 'b.tsx'])).toThrow(/a\.tsx.*b\.tsx/s);
  });
});

describe('splitRiskGlobs', () => {
  it('splits into host/container after asserting full classification', () => {
    expect(splitRiskGlobs(['src/router.ts', 'container/agent-runner/src/poll-loop.ts', '.github/**'])).toEqual({
      host: ['src/router.ts'],
      container: ['container/agent-runner/src/poll-loop.ts'],
    });
  });

  it('throws instead of splitting when a glob is unclassified', () => {
    expect(() => splitRiskGlobs(['lib/**'])).toThrow();
  });
});

describe('classification against the real .github/labeler.yml', () => {
  it('every current risk:high glob is host code, container code, or a known non-code path', () => {
    const labelerPath = path.join(__dirname, '..', '.github', 'labeler.yml');
    const config = parseYaml(fs.readFileSync(labelerPath, 'utf8')) as Record<string, unknown>;
    const riskHighGlobs = globsForRiskHigh(config);
    expect(() => assertFullyClassified(riskHighGlobs)).not.toThrow();
  });
});
