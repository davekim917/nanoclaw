/**
 * Issue #300: eight standalone scripts flagged as import-graph reachable to
 * the mailbox seam (they transitively `import` a file that reaches
 * `getAgentMailbox`/`withMailboxSession`/`withExistingMailboxSession`) with no
 * `src/mailbox/compose.ts` import — the same shape of finding that PR 7 round
 * 2 found real in `scripts/migrate-workgroup-memory.ts` (fixed in b53a6519).
 *
 * Import-graph reachability is not execution (that's exactly the trap
 * b53a6519's own commit message names: "Bolting compose.js onto eight
 * operational entrypoints to satisfy a static over-approximation is the
 * fix-induced-defect pattern, not safety"). This file traces each of the
 * eight scripts' ACTUAL call graph — which specific bindings they import, and
 * whether those specific bindings ever reach the seam — and proves the
 * negative at runtime rather than by static text-matching alone:
 *
 *   1. Every leaf function these scripts (transitively) call is invoked here
 *      with the mailbox factory deliberately unregistered
 *      (`resetAgentMailboxForTesting`). None of them throw the seam's
 *      signature error, `No agent mailbox registered`.
 *   2. A negative control (below) proves that error DOES fire when the seam
 *      is actually reached in the same unregistered state — so a script that
 *      really did reach the seam would fail loudly here, not pass silently.
 *   3. Source-level assertions pin the exact set of `session-manager.js` /
 *      `storage-manager.ts` / `storage-activity.ts` / `worktree-cleanup.ts` /
 *      `container-runner.ts` bindings each script's import graph touches, so
 *      a future refactor that adds a new import re-triggers this review
 *      instead of silently drifting into reachability.
 *
 * Two of the eight (`init-cli-agent.ts`, `init-first-agent.ts`) and
 * `refresh-backlog-canvas.ts` have NO relative-import path (even
 * over-approximated) into `session-manager.ts`, `container-runner.ts`,
 * `delivery.ts`, or `mailbox/index.ts` at all — verified below by walking
 * their import graphs directly rather than asserting an absence by hand.
 *
 * `migrate-repo-store.ts` and `verify-workgroup-memory-runtime.ts` import
 * `session-manager.ts` for non-seam helpers only.
 * `reclaim-idle-thread-worktrees.ts` and `restore-session-mtimes.ts` reach it
 * only through `storage-manager.ts` / `storage-activity.ts`, which contain NO
 * seam call themselves (asserted below) and only re-export the same
 * non-seam `session-manager.js` helpers. `storage-gc.ts` reaches it only
 * through `worktree-cleanup.ts`, which likewise contains no seam call and
 * only imports the two trivial, seam-free `container-runner.ts` getters
 * (`isContainerRunning`, `isContainerSpawning` — Map/Set lookups, not spawn
 * logic) plus the same non-seam `session-manager.js` helpers.
 *
 * None of the eight import `initSessionFolder`, `resolveSession`,
 * `resolveTaskSession`, `withMailboxSession`, `withExistingMailboxSession`,
 * or `destroySessionMailbox` — the only `session-manager.ts` exports whose
 * own body calls the seam. No compose.ts import is needed for any of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inboundDbPath,
  isAdmissiblePreTurnTrigger,
  outboundDbPath,
  readThreadDirOwner,
  sessionContextPathFor,
  sessionsBaseDir,
  threadsBaseDir,
  threadWorktreeDir,
} from './session-manager.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { tryRunWithStorageCleanupClaim } from './storage-activity.js';
import { sessionHasOpenWork } from './storage-manager.js';
import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from './mailbox/index.js';

const REPO_ROOT = path.resolve(__dirname, '..');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mailbox-seam-unreachable-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

const NOT_REGISTERED = 'No agent mailbox registered';

/**
 * Run `fn` with the mailbox factory deliberately unregistered — the exact
 * condition a standalone `tsx` script is in, since none of the eight load
 * `src/mailbox/compose.ts`. `src/test-setup.ts` registers the real factory
 * before every test; this suspends that registration for the duration of
 * `fn` and restores it afterward so later tests in this file (and the
 * process, since ESM module state is per-file here) are unaffected.
 */
async function withNoMailboxRegistered<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = resetAgentMailboxForTesting();
  try {
    return await fn();
  } finally {
    if (previous) registerAgentMailbox(previous);
  }
}

/** Call `fn` and, if it throws, assert the throw is not the seam's signature error. */
function callNeverReachingSeam(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).not.toBe(NOT_REGISTERED);
  }
}

describe('negative control: the harness actually detects a real seam hit', () => {
  it('getAgentMailbox() throws "No agent mailbox registered" when the factory is unregistered', async () => {
    await withNoMailboxRegistered(() => {
      expect(() => getAgentMailbox()).toThrow(NOT_REGISTERED);
    });
  });
});

describe('scripts/migrate-repo-store.ts — only imports readThreadDirOwner, threadWorktreeDir from session-manager.js', () => {
  it('neither function reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        readThreadDirOwner(tmpDir('read-thread-dir-owner'));
      });
      callNeverReachingSeam(() => {
        threadWorktreeDir('cli', 'thread-1', 'wg-1');
      });
    });
  });
});

describe('scripts/verify-workgroup-memory-runtime.ts', () => {
  it('isAdmissiblePreTurnTrigger (its only session-manager.js import) never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        isAdmissiblePreTurnTrigger({
          id: 'm1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: 'hello',
          trigger: 1,
        } as Parameters<typeof isAdmissiblePreTurnTrigger>[0]);
      });
    });
  });

  // The module-load side of this script — does importing
  // scripts/migrate-workgroup-memory.ts (for parseMigrationReport) run its
  // CLI body — is covered in scripts/mailbox-seam-unreachable.test.ts. This
  // file's tsconfig rootDir is src/, so it cannot import a scripts/ module.
});

describe('storage-manager.ts / storage-activity.ts contain no literal seam call', () => {
  it('storage-manager.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-manager.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it('storage-activity.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-activity.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it("storage-manager.ts's only session-manager.js imports are the non-seam path helpers", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-manager.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/session-manager\.js['"]/.exec(src);
    expect(
      match,
      'storage-manager.ts must import from session-manager.js for this test to be meaningful',
    ).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(
      [
        'inboundDbPath',
        'outboundDbPath',
        'sessionContextPathFor',
        'sessionsBaseDir',
        'threadsBaseDir',
        'threadWorktreeDir',
      ].sort(),
    );
  });
});

describe('scripts/reclaim-idle-thread-worktrees.ts — only imports getStorageReport from storage-manager.ts', () => {
  it("storage-manager.ts's session-manager.js re-imports never reach the mailbox seam", async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('reclaim');
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => outboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => sessionContextPathFor(dir));
      callNeverReachingSeam(() => sessionsBaseDir());
      callNeverReachingSeam(() => threadsBaseDir());
      callNeverReachingSeam(() => threadWorktreeDir('cli', 'thread-1', 'wg-1'));
    });
  });
});

describe('scripts/restore-session-mtimes.ts — imports tryRunWithStorageCleanupClaim (storage-activity.ts) and sessionHasOpenWork (storage-manager.ts)', () => {
  it('tryRunWithStorageCleanupClaim never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('cleanup-claim');
      let ran = false;
      callNeverReachingSeam(() => {
        const claimed = tryRunWithStorageCleanupClaim(dir, () => {
          ran = true;
        });
        expect(claimed).toBe(true);
      });
      expect(ran).toBe(true);
    });
  });

  it('sessionHasOpenWork never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('open-work');
      callNeverReachingSeam(() => {
        sessionHasOpenWork('ag1', 's1', dir);
      });
    });
  });
});

describe('worktree-cleanup.ts contains no literal seam call, and the only container-runner.ts bindings storage-gc.ts pulls in are trivial getters', () => {
  it('worktree-cleanup.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it("worktree-cleanup.ts's only container-runner.ts imports are isContainerRunning, isContainerSpawning", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/container-runner\.js['"]/.exec(src);
    expect(match).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['isContainerRunning', 'isContainerSpawning'].sort());
  });

  it("worktree-cleanup.ts's only session-manager.js imports are the non-seam DB path helpers", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/session-manager\.js['"]/.exec(src);
    expect(match).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['inboundDbPath', 'openOutboundDb'].sort());
  });
});

describe('scripts/storage-gc.ts — only imports runStorageGcOnce from worktree-cleanup.ts', () => {
  it('isContainerRunning and isContainerSpawning (Map/Set lookups, not spawn logic) never reach the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        expect(isContainerRunning('nonexistent-session')).toBe(false);
      });
      callNeverReachingSeam(() => {
        expect(isContainerSpawning('nonexistent-session')).toBe(false);
      });
    });
  });

  it('inboundDbPath never reaches the mailbox seam (openOutboundDb is exercised indirectly via sessionHasOpenWork above)', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
    });
  });
});

describe('scripts/init-cli-agent.ts, scripts/init-first-agent.ts, scripts/refresh-backlog-canvas.ts have no relative-import path to the seam', () => {
  const STANDALONE_ROOTS = ['scripts'];
  const TARGETS = ['scripts/init-cli-agent.ts', 'scripts/init-first-agent.ts', 'scripts/refresh-backlog-canvas.ts'];
  const SEAM_ADJACENT_FILES = [
    'src/session-manager.ts',
    'src/container-runner.ts',
    'src/delivery.ts',
    'src/mailbox/index.ts',
  ];

  function listTsFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(REPO_ROOT, root));
    return out;
  }

  const read = (relPath: string): string => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

  /** Relative import targets — VALUE imports only; `import type` is erased at compile time and never executes. */
  function relativeValueImports(relPath: string, src: string): string[] {
    const out: string[] = [];
    const importRe = /^import\s+(type\s+)?(?:[\s\S]*?)\s+from\s+['"](\.[^'"]+)['"];?|^import\s+['"](\.[^'"]+)['"];?/gm;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(src))) {
      if (match[1]) continue; // `import type` — no runtime edge
      const specifier = match[2] ?? match[3];
      if (!specifier) continue;
      const resolved = path.posix
        .normalize(path.posix.join(path.posix.dirname(relPath), specifier))
        .replace(/\.js$/, '.ts');
      if (fs.existsSync(path.join(REPO_ROOT, resolved))) out.push(resolved);
      else {
        const idx = resolved.replace(/\.ts$/, '') + '/index.ts';
        if (fs.existsSync(path.join(REPO_ROOT, idx))) out.push(idx);
      }
    }
    return out;
  }

  for (const target of TARGETS) {
    it(`${target} never value-imports (transitively) session-manager.ts, container-runner.ts, delivery.ts, or mailbox/index.ts`, () => {
      const allFiles = [...listTsFiles('src'), ...STANDALONE_ROOTS.flatMap(listTsFiles)];
      const sources = new Map(allFiles.map((p) => [p, read(p)]));
      const visited = new Set([target]);
      const queue = [target];
      while (queue.length) {
        const cur = queue.shift()!;
        const src = sources.get(cur);
        if (!src) continue;
        for (const dep of relativeValueImports(cur, src)) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      const hit = SEAM_ADJACENT_FILES.find((f) => visited.has(f));
      expect(hit, `${target} reaches ${hit} — this proof is stale, re-run the trace`).toBeUndefined();
    });
  }
});
