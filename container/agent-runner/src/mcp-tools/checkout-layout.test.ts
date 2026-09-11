import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { checkoutDirName, checkoutShapeAt, listTopicCheckouts, parseCheckoutDirName } from './checkout-layout';

interface Fixtures {
  checkoutDirName: Array<{ repo: string; branch: string | null; name: string }>;
  parseCheckoutDirName: Array<{ name: string; expected: { repo: string; slug: string | null } | null }>;
}

const fixtures: Fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./checkout-layout.fixtures.json', import.meta.url)), 'utf8'),
);

// P2-1 (container side, plan §9): every fixture vector parses back, `feat/x`
// and `feat-x` never collide, and staging/cache dot-prefixed dirs never parse
// as checkouts.
describe('checkout layout primitive (container copy)', () => {
  test('checkout names round-trip and never collide', () => {
    for (const vector of fixtures.checkoutDirName) {
      expect(checkoutDirName(vector.repo, vector.branch)).toBe(vector.name);
    }
    for (const vector of fixtures.parseCheckoutDirName) {
      expect(parseCheckoutDirName(vector.name)).toEqual(vector.expected);
    }

    // Every checkoutDirName vector also round-trips through parseCheckoutDirName.
    for (const vector of fixtures.checkoutDirName) {
      const parsed = parseCheckoutDirName(vector.name);
      expect(parsed).not.toBeNull();
      expect(parsed!.repo).toBe(vector.repo);
      expect(parsed!.slug).toBe(vector.branch === null ? null : vector.name.slice(vector.repo.length + 1));
    }

    // feat/x and feat-x never collide.
    expect(checkoutDirName('app', 'feat/x')).not.toBe(checkoutDirName('app', 'feat-x'));

    // Dot-prefixed staging/cache/tmp dirs never parse as checkouts.
    expect(parseCheckoutDirName('.staging')).toBeNull();
    expect(parseCheckoutDirName('.pnpm-store')).toBeNull();
    expect(parseCheckoutDirName('.app.tmp-123')).toBeNull();
  });

  test('listTopicCheckouts enumerates only parseable names and gives each a shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'checkout-layout-'));
    try {
      // Missing topic dir → no checkouts, not an error.
      expect(listTopicCheckouts(join(root, 'missing'))).toEqual([]);

      const topic = join(root, 'worktrees');
      mkdirSync(topic, { recursive: true });

      // A clone: `.git` is a directory.
      mkdirSync(join(topic, 'app', '.git'), { recursive: true });
      // A linked worktree: `.git` is a file.
      mkdirSync(join(topic, 'app@feat-x'), { recursive: true });
      writeFileSync(join(topic, 'app@feat-x', '.git'), 'gitdir: /elsewhere\n');
      // Unknown shape: no `.git` at all.
      mkdirSync(join(topic, 'app@no-git'), { recursive: true });
      // Non-parsing entries are excluded entirely.
      mkdirSync(join(topic, '.staging'), { recursive: true });
      writeFileSync(join(topic, 'not-a-dir'), 'file, not a directory\n');

      const checkouts = listTopicCheckouts(topic);
      expect(checkouts.map((c) => c.name)).toEqual(['app', 'app@feat-x', 'app@no-git']);
      expect(checkouts.find((c) => c.name === 'app')!.shape).toBe('clone');
      expect(checkouts.find((c) => c.name === 'app@feat-x')!.shape).toBe('linked');
      expect(checkouts.find((c) => c.name === 'app@no-git')!.shape).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('checkoutShapeAt is unknown for a symlinked .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'checkout-layout-shape-'));
    try {
      const real = join(root, 'real-git');
      mkdirSync(real, { recursive: true });
      const checkout = join(root, 'checkout');
      mkdirSync(checkout, { recursive: true });
      symlinkSync(real, join(checkout, '.git'));
      expect(checkoutShapeAt(checkout)).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
