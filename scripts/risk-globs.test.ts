import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

import { containerRiskGlobs, hostRiskGlobs } from './risk-globs.js';

// Pure string filtering — no subprocess or network use.
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
