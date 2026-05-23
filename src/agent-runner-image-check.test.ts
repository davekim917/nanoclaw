import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';

import { computeAgentRunnerDepsHash } from './agent-runner-image-check.js';
import { REPO_ROOT } from './config.js';

describe('computeAgentRunnerDepsHash', () => {
  it('matches sha256(sha256(package.json) || sha256(bun.lock)) sliced to 16 chars', async () => {
    const pkg = await readFile(path.join(REPO_ROOT, 'container/agent-runner/package.json'));
    const lock = await readFile(path.join(REPO_ROOT, 'container/agent-runner/bun.lock'));
    const pkgHash = createHash('sha256').update(pkg).digest('hex');
    const lockHash = createHash('sha256').update(lock).digest('hex');
    const expected = createHash('sha256')
      .update(pkgHash + lockHash)
      .digest('hex')
      .slice(0, 16);
    const actual = await computeAgentRunnerDepsHash();
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across invocations', async () => {
    const a = await computeAgentRunnerDepsHash();
    const b = await computeAgentRunnerDepsHash();
    expect(a).toBe(b);
  });
});
