import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';
import fsSync from 'fs';
import cpSync from 'child_process';

import {
  checkAgentRunnerDepsDrift,
  classifyLabels,
  computeAgentRunnerDepsHash,
  LABEL_RETRY_DELAY_MS,
  resetDepsDriftCacheForTests,
} from './agent-runner-image-check.js';
import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';

// The cache is module-scoped (see agent-runner-image-check.ts), so any test
// in this file that gets an `ok: true` result would otherwise leak a cache
// entry into a later test using the same imageRef + unchanged files — e.g. a
// scripted-mock test asserting `inspect.calls()` would silently see 0 calls
// instead of the count it expects. Reset before every test so each case
// starts from "nothing cached", matching the pre-caching behaviour every
// existing test below was written against.
beforeEach(() => {
  resetDepsDriftCacheForTests();
});

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
  it('does not misclassify a nonexistent image as missing-label', async () => {
    const fakeRef = `nanoclaw-agent-test-${Date.now()}-does-not-exist:never`;
    const r = await checkAgentRunnerDepsDrift(fakeRef);
    expect(r.ok).toBe(false);
    // 'no-image' when docker is present and image is absent;
    // 'inspect-error' when docker itself is unavailable (CI sandbox without
    // docker, daemon down, permission denied). Both are valid outcomes — the
    // contract is "never misclassify as missing-label".
    expect(r.lookup.kind === 'no-image' || r.lookup.kind === 'inspect-error').toBe(true);
    expect(r.lookup.kind).not.toBe('missing');
  });

  it('emits the base rebuild hint when imageRef is CONTAINER_IMAGE', async () => {
    const { CONTAINER_IMAGE } = await import('./config.js');
    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE);
    // Either ok (in-sync) or drift — message should never reach for the
    // per-agent branch since ref IS the base.
    expect(r.message).not.toMatch(/per-agent override image/);
  });

  it('emits the per-agent rebuild hint for override refs that are missing entirely', async () => {
    const r = await checkAgentRunnerDepsDrift('nanoclaw-agent-per-group-test-does-not-exist:x');
    // Override ref + no-image → fail closed with the per-agent rebuild hint
    // (the override genuinely doesn't exist, can't spawn from nothing).
    // Override ref + inspect-error (docker down) → no per-agent hint; we just
    // can't reach the daemon. Skip the assertion when docker isn't there.
    if (r.lookup.kind === 'no-image') {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/per-agent override image/);
    } else {
      expect(r.lookup.kind).toBe('inspect-error');
    }
  });
});

/**
 * Regression cover for the 2026-09-01/02 spawn refusals: `container/build.sh`
 * re-stamps the retention LABEL layer periodically, and while that export
 * rewrites the canonical tag's OCI index `docker inspect` can return a config
 * with no label map — exit 0, empty output. Reading a single key by name made
 * that indistinguishable from an image genuinely built by an older build.sh.
 */
describe('checkAgentRunnerDepsDrift label-read classification', () => {
  const labeled = (hash: string): string =>
    JSON.stringify({ 'nanoclaw.commit': 'abc123', 'nanoclaw.agentRunnerDepsHash': hash });

  /** Fake `docker inspect` that replays a scripted sequence of stdout reads. */
  function scriptedInspect(reads: string[]): { run: (ref: string) => Promise<string>; calls: () => number } {
    let i = 0;
    return {
      run: async () => {
        const value = reads[Math.min(i, reads.length - 1)];
        i += 1;
        return value;
      },
      calls: () => i,
    };
  }

  it('classifies an absent label map as unresolved, not missing', () => {
    expect(classifyLabels('null').kind).toBe('unresolved');
    expect(classifyLabels('').kind).toBe('unresolved');
    expect(classifyLabels('   \n').kind).toBe('unresolved');
    expect(classifyLabels('{}').kind).toBe('unresolved');
    expect(classifyLabels('<no value>').kind).toBe('unresolved');
  });

  it('classifies a populated map without our key as missing', () => {
    expect(classifyLabels(JSON.stringify({ 'nanoclaw.commit': 'abc123' })).kind).toBe('missing');
  });

  it('classifies our key as found', () => {
    expect(classifyLabels(labeled('69f4456d09a8f88f'))).toEqual({ kind: 'found', value: '69f4456d09a8f88f' });
  });

  it('re-reads once and recovers when the first read lands mid-relabel', async () => {
    const expected = await computeAgentRunnerDepsHash();
    const inspect = scriptedInspect(['null', labeled(expected)]);

    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, { inspect: inspect.run, retryDelayMs: 0 });

    expect(r.ok).toBe(true);
    expect(r.retried).toBe(true);
    expect(r.actual).toBe(expected);
    expect(inspect.calls()).toBe(2);
    expect(r.message).toBe('agent-runner deps in sync');
  });

  it('retries at most once — a persistently absent label map still refuses with the rebuild hint', async () => {
    const inspect = scriptedInspect(['null']);

    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, { inspect: inspect.run, retryDelayMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.retried).toBe(true);
    expect(inspect.calls()).toBe(2);
    expect(r.lookup.kind).toBe('unresolved');
    expect(r.message).toMatch(/no nanoclaw\.agentRunnerDepsHash label/);
    expect(r.message).toMatch(/no label map resolved on two reads/);
    expect(r.message).toMatch(/rebuild: cd container\/agent-runner && bun install/);
  });

  it('refuses a genuinely unlabeled image immediately, without spending a retry', async () => {
    const inspect = scriptedInspect([JSON.stringify({ 'nanoclaw.commit': 'abc123' })]);

    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, { inspect: inspect.run, retryDelayMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(inspect.calls()).toBe(1);
    expect(r.lookup.kind).toBe('missing');
    expect(r.message).toMatch(/the image is labeled but carries no such label/);
    expect(r.message).toMatch(/rebuild: cd container\/agent-runner && bun install/);
  });

  it('still refuses on real drift, with no retry', async () => {
    const expected = await computeAgentRunnerDepsHash();
    const inspect = scriptedInspect([labeled('0000000000000000')]);

    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, { inspect: inspect.run, retryDelayMs: 0 });

    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(inspect.calls()).toBe(1);
    expect(r.message).toBe(
      `agent-runner deps drift on ${CONTAINER_IMAGE}: image baked from 0000000000000000, ` +
        `current files hash to ${expected}. Run: cd container/agent-runner && bun install && cd ../.. && ./container/build.sh`,
    );
  });

  it('says "inspect failed" rather than "no label" when the daemon is unreachable', async () => {
    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, {
      inspect: async () => {
        throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      },
      retryDelayMs: 0,
    });

    expect(r.ok).toBe(false);
    expect(r.lookup.kind).toBe('inspect-error');
    expect(r.message).toMatch(/docker inspect .* failed, so no label was read/);
    expect(r.message).toMatch(/NOT a missing label/);
    expect(r.message).not.toMatch(/has no nanoclaw\.agentRunnerDepsHash label/);
  });

  it('keeps the retry bounded to a couple of seconds', () => {
    expect(LABEL_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(LABEL_RETRY_DELAY_MS).toBeLessThanOrEqual(3_000);
  });
});

describe('agent runner image global CLI PATH', () => {
  it('keeps pnpm-installed CLIs visible to login shells and non-pnpm PATHs', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');
    const shimBlockIndex = dockerfile.indexOf('/etc/profile.d/nanoclaw-pnpm.sh');
    expect(shimBlockIndex).toBeGreaterThan(0);

    const globalInstallIndexes = [...dockerfile.matchAll(/pnpm install -g/g)].map((m) => m.index ?? -1);
    expect(globalInstallIndexes.length).toBeGreaterThan(0);
    expect(globalInstallIndexes.every((i) => i > 0 && i < shimBlockIndex)).toBe(true);

    expect(dockerfile).toContain('ENV PNPM_HOME="/pnpm"');
    expect(dockerfile).toContain('ENV PATH="$PNPM_HOME:$PATH"');
    expect(dockerfile).toContain('"export PNPM_HOME=/pnpm"');
    expect(dockerfile).toContain('export PATH=\\"/pnpm:\\$PATH\\"');
    expect(dockerfile).toContain('find /pnpm -maxdepth 1 -type f -perm /111');
    expect(dockerfile).toContain('/usr/local/bin/\\$(basename \\"\\$1\\")');
  });
});

describe('agent runner image source navigation', () => {
  it('test_image_source_installs_ripgrep_for_agent_source_navigation', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');
    const finalImageStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM node:22-slim'));
    const systemPackages = finalImageStage.match(
      /apt-get update && apt-get install -y --no-install-recommends \\\n([\s\S]*?)\n\s*&& if \[ "\$INSTALL_CJK_FONTS"/,
    );

    expect(systemPackages).not.toBeNull();
    expect(systemPackages?.[1]).toMatch(/^\s*ripgrep\s*\\$/m);
  });

  it('test_image_source_retires_gitnexus_and_graphify', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');

    for (const retiredSurface of [
      'GITNEXUS_VERSION',
      'gitnexus-builder',
      '/pnpm/gitnexus',
      '/opt/gitnexus-home',
      '.lbdb',
      'install-duckdb-extension.mjs',
      'only-built-dependencies[]=gitnexus',
      'only-built-dependencies[]=@ladybugdb/core',
      'only-built-dependencies[]=onnxruntime-node',
    ]) {
      expect(dockerfile).not.toContain(retiredSurface);
    }
    expect(dockerfile).not.toMatch(/\n\s*(?:make|g\+\+)\s*\\/);

    // Graphify is decommissioned. Nothing may reintroduce the venv, the
    // wheelhouse, the gateway, or the in-image Python contracts.
    expect(dockerfile).not.toMatch(/graphify/i);
  });
});

/**
 * Perf follow-up to PR #315: the spawn path logs this stage's wall time and
 * it was showing up as the next-largest cost after that PR — most of it
 * spent on a `docker inspect` round-trip (occasionally plus the
 * LABEL_RETRY_DELAY_MS relabel-race pause) that answers the same "still in
 * sync" question every spawn already knows the answer to. These tests cover
 * the cache added to buy that back.
 */
describe('checkAgentRunnerDepsDrift result cache', () => {
  const scriptedInspect = (reads: string[]): { run: (ref: string) => Promise<string>; calls: () => number } => {
    let i = 0;
    return {
      run: async () => {
        const value = reads[Math.min(i, reads.length - 1)];
        i += 1;
        return value;
      },
      calls: () => i,
    };
  };
  const labeled = (hash: string): string => JSON.stringify({ 'nanoclaw.agentRunnerDepsHash': hash });

  it('skips re-inspecting the image on a second call with unchanged inputs', async () => {
    const expected = await computeAgentRunnerDepsHash();
    const imageRef = 'nanoclaw-agent-cache-test:hit';
    const inspect = scriptedInspect([labeled(expected)]);

    const r1 = await checkAgentRunnerDepsDrift(imageRef, { inspect: inspect.run, retryDelayMs: 0 });
    expect(r1.ok).toBe(true);
    expect(inspect.calls()).toBe(1);

    // Second call passes an inspect that would fail the test if it were ever
    // invoked — the only way this call can still succeed is via the cache.
    const r2 = await checkAgentRunnerDepsDrift(imageRef, {
      inspect: async () => {
        throw new Error('cache miss: docker inspect was re-run for unchanged inputs');
      },
      retryDelayMs: 0,
    });

    expect(r2).toEqual(r1);
    expect(inspect.calls()).toBe(1); // still 1 — the second call never touched the real inspect
  });

  it('never caches a failing result — every call re-checks until it passes', async () => {
    const imageRef = 'nanoclaw-agent-cache-test:miss';
    const inspect = scriptedInspect([labeled('0000000000000000')]);

    const r1 = await checkAgentRunnerDepsDrift(imageRef, { inspect: inspect.run, retryDelayMs: 0 });
    expect(r1.ok).toBe(false);

    const r2 = await checkAgentRunnerDepsDrift(imageRef, { inspect: inspect.run, retryDelayMs: 0 });
    expect(r2.ok).toBe(false);

    // Both calls actually re-ran the check — a cached failure would have
    // left calls() at 1.
    expect(inspect.calls()).toBe(2);
  });

  it('is keyed on imageRef — a per-agent override never serves the base image cache or vice versa', async () => {
    const expected = await computeAgentRunnerDepsHash();
    const inspectBase = scriptedInspect([labeled(expected)]);
    const inspectOverride = scriptedInspect([labeled(expected)]);

    await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, { inspect: inspectBase.run, retryDelayMs: 0 });
    expect(inspectBase.calls()).toBe(1);

    // Different imageRef, same underlying files: must still hit the network,
    // not the base image's cache entry.
    const r = await checkAgentRunnerDepsDrift('nanoclaw-agent-cache-test:override', {
      inspect: inspectOverride.run,
      retryDelayMs: 0,
    });
    expect(r.ok).toBe(true);
    expect(inspectOverride.calls()).toBe(1);
  });

  it('resetDepsDriftCacheForTests forces a fresh check even with unchanged inputs', async () => {
    const expected = await computeAgentRunnerDepsHash();
    const imageRef = 'nanoclaw-agent-cache-test:reset';
    const inspect1 = scriptedInspect([labeled(expected)]);
    await checkAgentRunnerDepsDrift(imageRef, { inspect: inspect1.run, retryDelayMs: 0 });
    expect(inspect1.calls()).toBe(1);

    resetDepsDriftCacheForTests();

    const inspect2 = scriptedInspect([labeled(expected)]);
    const r = await checkAgentRunnerDepsDrift(imageRef, { inspect: inspect2.run, retryDelayMs: 0 });
    expect(r.ok).toBe(true);
    expect(inspect2.calls()).toBe(1); // re-ran for real, not served from the cleared cache
  });
});

/**
 * Tripwire: this stage must never fall back to a synchronous fs/child_process
 * call. Every real call it makes today (readFile, execFile-via-promisify,
 * plus the stat added for the cache) is already async — this guards against
 * a future edit reintroducing a sync one (readFileSync/statSync/existsSync,
 * execSync/execFileSync/spawnSync), which would block the host's event loop
 * for the same multi-second `docker inspect` cost PR #315's follow-up exists
 * to get off the spawn path.
 *
 * Pattern from src/host-sweep-registry.test.ts: spy on the sync members only
 * (the async ones — execFile via the `inspect` option, readFile for hashing
 * — stay real) so an accidental sync call throws loudly instead of silently
 * spawning a real process/reading a real file, and record calls so the test
 * fails even if the code under test happens to swallow the throw.
 */
describe('checkAgentRunnerDepsDrift stays off the sync fs/child_process surface', () => {
  it('throws if any sync fs or child_process API fires across a cache-miss, cache-hit, and failing call', async () => {
    const record: string[] = [];
    const tripwire =
      (name: string) =>
      (...args: unknown[]): never => {
        record.push(name);
        throw new Error(`sync call attempted during deps-drift-check: ${name}(${JSON.stringify(args[0])})`);
      };

    const spies = [
      vi.spyOn(fsSync, 'readFileSync').mockImplementation(tripwire('readFileSync') as typeof fsSync.readFileSync),
      vi.spyOn(fsSync, 'statSync').mockImplementation(tripwire('statSync') as typeof fsSync.statSync),
      vi.spyOn(fsSync, 'existsSync').mockImplementation(tripwire('existsSync') as typeof fsSync.existsSync),
      vi.spyOn(cpSync, 'execSync').mockImplementation(tripwire('execSync') as typeof cpSync.execSync),
      vi
        .spyOn(cpSync, 'execFileSync')
        .mockImplementation(tripwire('execFileSync') as unknown as typeof cpSync.execFileSync),
      vi.spyOn(cpSync, 'spawnSync').mockImplementation(tripwire('spawnSync') as unknown as typeof cpSync.spawnSync),
    ];

    try {
      const expected = await computeAgentRunnerDepsHash();

      // Cache miss, passing result (populates the cache).
      const r1 = await checkAgentRunnerDepsDrift('nanoclaw-agent-tripwire-test', {
        inspect: async () => JSON.stringify({ 'nanoclaw.agentRunnerDepsHash': expected }),
        retryDelayMs: 0,
      });
      expect(r1.ok).toBe(true);

      // Cache hit, unchanged inputs — must not touch inspect or the sync surface.
      const r2 = await checkAgentRunnerDepsDrift('nanoclaw-agent-tripwire-test', {
        inspect: async () => {
          throw new Error('should not be called on a cache hit');
        },
        retryDelayMs: 0,
      });
      expect(r2.ok).toBe(true);

      // Failing path (real drift: a present-but-mismatched label — this
      // fails closed regardless of imageRef, unlike an unresolved/missing
      // label map which opt-out branches ok:true for a non-base override).
      const r3 = await checkAgentRunnerDepsDrift('nanoclaw-agent-tripwire-test-fail', {
        inspect: async () => JSON.stringify({ 'nanoclaw.agentRunnerDepsHash': '0000000000000000' }),
        retryDelayMs: 0,
      });
      expect(r3.ok).toBe(false);

      // Unresolved-label retry-sleep path, on the base image so it fails
      // closed rather than opt-out branching to ok:true.
      const r4 = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE, {
        inspect: async () => 'null',
        retryDelayMs: 0,
      });
      expect(r4.ok).toBe(false);
      expect(r4.retried).toBe(true);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    expect(record).toEqual([]);
  });
});
