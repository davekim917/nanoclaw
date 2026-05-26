import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { blastRadiusAdvisory } from './git-worktrees';

// The advisory shells out to `node <post-commit-verify.cjs>`. Where node is
// absent the helper must fail safe (return null) — but the parse-path tests
// genuinely need node, so guard them. The container image ships node 22.
function nodeAvailable(): boolean {
  try {
    execFileSync('node', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const hasNode = nodeAvailable();

/** Run blastRadiusAdvisory with NANOCLAW_POSTCOMMIT_CJS pointed at `cjs`. */
function withAnalyzer(cjs: string, worktreeDir: string): string | null {
  const prev = process.env.NANOCLAW_POSTCOMMIT_CJS;
  const prevRoot = process.env.CLAUDE_PLUGINS_ROOT;
  process.env.NANOCLAW_POSTCOMMIT_CJS = cjs;
  delete process.env.CLAUDE_PLUGINS_ROOT; // don't let a real mount interfere
  try {
    return blastRadiusAdvisory(worktreeDir);
  } finally {
    if (prev !== undefined) process.env.NANOCLAW_POSTCOMMIT_CJS = prev;
    else delete process.env.NANOCLAW_POSTCOMMIT_CJS;
    if (prevRoot !== undefined) process.env.CLAUDE_PLUGINS_ROOT = prevRoot;
  }
}

function stubAnalyzer(body: string): { dir: string; cjs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pcv-'));
  const cjs = join(dir, 'stub.cjs');
  writeFileSync(cjs, body);
  return { dir, cjs };
}

describe('blastRadiusAdvisory', () => {
  test('returns null when no analyzer .cjs is resolvable (fail-safe)', () => {
    expect(withAnalyzer('/nonexistent/post-commit-verify.cjs', tmpdir())).toBeNull();
  });

  test.skipIf(!hasNode)('parses additionalContext from analyzer stdout', () => {
    const { dir, cjs } = stubAnalyzer(
      `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '## Post-Commit Verification CHECKLIST-MARKER' } }));`,
    );
    expect(withAnalyzer(cjs, dir)).toContain('CHECKLIST-MARKER');
  });

  test.skipIf(!hasNode)('returns null on empty analyzer output (no index / early-return)', () => {
    const { dir, cjs } = stubAnalyzer(`// analyzer printed nothing — mirrors the no-index early return`);
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });

  test.skipIf(!hasNode)('returns null on malformed analyzer output (fail-safe parse)', () => {
    const { dir, cjs } = stubAnalyzer(`console.log('not json at all');`);
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });

  test.skipIf(!hasNode)('returns null when additionalContext is blank', () => {
    const { dir, cjs } = stubAnalyzer(
      `console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: '   ' } }));`,
    );
    expect(withAnalyzer(cjs, dir)).toBeNull();
  });
});
