import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';

import { checkAgentRunnerDepsDrift, computeAgentRunnerDepsHash } from './agent-runner-image-check.js';
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

describe('checkAgentRunnerDepsDrift', () => {
  it('classifies a nonexistent image as no-image (not missing-label)', async () => {
    const fakeRef = `nanoclaw-agent-test-${Date.now()}-does-not-exist:never`;
    const r = await checkAgentRunnerDepsDrift(fakeRef);
    expect(r.ok).toBe(false);
    expect(r.lookup.kind).toBe('no-image');
    expect(r.message).toMatch(/not found/);
  });

  it('emits the base rebuild hint when imageRef is CONTAINER_IMAGE', async () => {
    const { CONTAINER_IMAGE } = await import('./config.js');
    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE);
    // Either ok (in-sync) or drift — message should never reach for the
    // per-agent branch since ref IS the base.
    expect(r.message).not.toMatch(/per-agent override image/);
  });

  it('emits the per-agent rebuild hint for override refs', async () => {
    const r = await checkAgentRunnerDepsDrift('nanoclaw-agent-per-group-test-does-not-exist:x');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/per-agent override image/);
  });
});
