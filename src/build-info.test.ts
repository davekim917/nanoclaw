import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  changedPathsBetween,
  commitCountBetween,
  describeBuildDrift,
  formatBuildInfoLog,
  isMaterialDrift,
  isMaterialPath,
  readBuildInfo,
  readCheckoutHead,
} from './build-info.js';

describe('formatBuildInfoLog', () => {
  it('formats a clean build as info-level provenance', () => {
    const { msg, data } = formatBuildInfoLog({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: false,
    });
    expect(msg).toBe('Build provenance');
    expect(data).toEqual({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: false,
    });
  });

  it('flags a dirty build in the message', () => {
    const { msg, data } = formatBuildInfoLog({
      sha: 'b'.repeat(40),
      shortSha: 'bbbbbbb',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: true,
    });
    expect(msg).toContain('DIRTY');
    expect(data.dirty).toBe(true);
  });
});

describe('readBuildInfo', () => {
  it('returns null when dist/BUILD_INFO.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the file is malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), '{ "sha": "x"'); // truncated JSON
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when required fields are missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), JSON.stringify({ sha: 'abc' }));
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a well-formed file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      const info = {
        sha: 'c'.repeat(40),
        shortSha: 'ccccccc',
        builtAt: '2026-08-20T00:00:00.000Z',
        branch: 'main',
        dirty: false,
      };
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), JSON.stringify(info));
      expect(readBuildInfo(dir)).toEqual(info);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readCheckoutHead', () => {
  it('returns null when the directory is not a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-nogit-'));
    try {
      expect(readCheckoutHead(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the sha of a real repo HEAD', () => {
    // This repo (or the worktree it was invoked from) is itself a git repo —
    // exercise the real git path rather than mocking child_process.
    const repoRoot = path.resolve(__dirname, '..');
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(readCheckoutHead(repoRoot)).toBe(expected);
  });
});

describe('describeBuildDrift', () => {
  const info = {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    builtAt: '2026-08-20T00:00:00.000Z',
    branch: 'main',
    dirty: false,
  };

  it('returns null when info is null', () => {
    expect(describeBuildDrift(null, 'b'.repeat(40))).toBeNull();
  });

  it('returns null when head is null', () => {
    expect(describeBuildDrift(info, null)).toBeNull();
  });

  it('returns null when the shas match', () => {
    expect(describeBuildDrift(info, info.sha)).toBeNull();
  });

  it('returns a payload naming both shas on a genuine mismatch', () => {
    const head = 'b'.repeat(40);
    const result = describeBuildDrift(info, head);
    expect(result).not.toBeNull();
    expect(result!.msg).toContain(info.shortSha);
    expect(result!.msg).toContain(info.sha);
    expect(result!.msg).toContain(head.slice(0, 7));
    expect(result!.msg).toContain(head);
    expect(result!.msg.toLowerCase()).toContain('restart alone will not fix this');
    expect(result!.msg).toContain('agent-runner');
    // Must not claim the split has already happened — it's latent until the
    // NEXT restart re-snapshots agent-runner source against this stale dist/.
    expect(result!.msg.toLowerCase()).toContain('consistent right now');
    expect(result!.data).toEqual({ buildSha: info.sha, headSha: head, builtAt: info.builtAt });
  });
});

describe('isMaterialDrift', () => {
  it('is not material when nothing changed', () => {
    expect(isMaterialDrift([])).toBe(false);
  });

  it('is not material for docs-only changes', () => {
    expect(isMaterialDrift(['docs/architecture.md', 'README.md'])).toBe(false);
  });

  it('is not material for agent-runner-only changes — separate activation path, not this drift', () => {
    expect(isMaterialDrift(['container/agent-runner/src/providers/codex-app-server.ts'])).toBe(false);
  });

  it('is not material for a src/**/*.test.ts-only change', () => {
    expect(isMaterialDrift(['src/agent-worktree-gc.test.ts', 'src/build-info.test.ts'])).toBe(false);
  });

  it('is material for a real src/** change', () => {
    expect(isMaterialDrift(['src/agent-worktree-gc.ts'])).toBe(true);
  });

  it('is material when a real src/** change is mixed in among non-material paths', () => {
    expect(
      isMaterialDrift(['docs/README.md', 'src/foo.test.ts', 'src/foo.ts', 'container/agent-runner/src/x.ts']),
    ).toBe(true);
  });
});

describe('changedPathsBetween / commitCountBetween', () => {
  const repoRoot = path.resolve(__dirname, '..');

  it('changedPathsBetween returns an empty (not null) list comparing a commit to itself', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(changedPathsBetween(repoRoot, head, head)).toEqual([]);
  });

  it('changedPathsBetween returns null (never throws) for an unreachable sha', () => {
    expect(changedPathsBetween(repoRoot, 'f'.repeat(40), 'HEAD')).toBeNull();
  });

  it('changedPathsBetween returns null (never throws) when the directory is not a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-nogit-'));
    try {
      expect(changedPathsBetween(dir, 'HEAD~1', 'HEAD')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commitCountBetween returns 0 (never throws) comparing a commit to itself', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    expect(commitCountBetween(repoRoot, head, head)).toBe(0);
  });

  it('commitCountBetween returns null (never throws) for an unreachable sha', () => {
    expect(commitCountBetween(repoRoot, 'f'.repeat(40), 'HEAD')).toBeNull();
  });
});

describe('isMaterialPath — generated runtime artifacts', () => {
  it('treats dashboard sources as material (they build dist/dashboard-spa, served by static.ts)', () => {
    expect(isMaterialPath('dashboard/src/App.tsx')).toBe(true);
    expect(isMaterialDrift(['docs/x.md', 'dashboard/src/App.tsx'])).toBe(true);
  });

  it('treats dependency manifests as material (they need the install+build flow)', () => {
    expect(isMaterialPath('package.json')).toBe(true);
    expect(isMaterialPath('pnpm-lock.yaml')).toBe(true);
  });

  it('excludes test files wherever they live, including .tsx', () => {
    expect(isMaterialPath('src/foo.test.ts')).toBe(false);
    expect(isMaterialPath('dashboard/src/App.test.tsx')).toBe(false);
  });

  it('still excludes the non-build trees', () => {
    expect(isMaterialPath('docs/plan.md')).toBe(false);
    expect(isMaterialPath('scripts/deploy.sh')).toBe(false);
    expect(isMaterialPath('container/agent-runner/src/providers/codex.ts')).toBe(false);
  });

  it('does not treat a nested package.json as a root manifest', () => {
    expect(isMaterialPath('container/agent-runner/package.json')).toBe(false);
  });
});
