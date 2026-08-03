/**
 * End-to-end test of scripts/migrate-repo-store.ts against a synthetic legacy
 * workgroup: a canonical clone parked on a dirty branch (real work + injected
 * artifacts), a named workgroup-root linked worktree with unpushed commits,
 * and a per-thread linked worktree with uncommitted dirt — all recorded with
 * container-absolute gitdir pointers, as production containers write them.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'migrate-repo-store.ts');

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

let root: string;
let dataDir: string;
let wgDir: string;
let remote: string;
let canonical: string;

function runMigration(execute: boolean): string {
  return execFileSync(
    'pnpm',
    ['exec', 'tsx', SCRIPT, '--workgroup', 'testwg', '--root', root, ...(execute ? ['--execute'] : [])],
    {
      cwd: process.cwd(),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 180_000,
      env: { ...process.env, NANOCLAW_DATA_DIR: dataDir, PATH: process.env.PATH },
    },
  ).toString();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-repo-store-'));
  dataDir = path.join(root, 'data');
  wgDir = path.join(dataDir, 'workgroups', 'testwg');
  fs.mkdirSync(wgDir, { recursive: true });

  // Minimal central DB — the script scopes thread-worktree conversion and
  // legacy-dir namespacing by DB ownership and fail-safes to skipping both
  // without it.
  const db = new BetterSqlite3(path.join(dataDir, 'v2.db'));
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT);
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, platform_id TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT);
    INSERT INTO agent_groups VALUES ('ag-t', 'testwg-agent', 'testwg');
    INSERT INTO messaging_groups VALUES ('mg-t', 'slack:CTEST20001');
    INSERT INTO sessions VALUES ('sess-t', 'ag-t', 'mg-t', 'slack:CTEST20001:123');
  `);
  db.close();

  // Real remote (bare) with two commits on main.
  remote = path.join(root, 'remote', 'PROJ.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'model.sql'), 'select 1\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'init']);
  execFileSync('git', ['clone', '-q', '--bare', seed, remote], { stdio: 'pipe' });
  fs.rmSync(seed, { recursive: true, force: true });

  // Legacy canonical, parked on a feature branch with mixed dirt.
  canonical = path.join(wgDir, 'PROJ');
  execFileSync('git', ['clone', '-q', remote, canonical], { stdio: 'pipe' });
  git(canonical, ['checkout', '-q', '-b', 'TICKET-1-fix']);
  fs.writeFileSync(path.join(canonical, 'model.sql'), 'select 2 -- parked work\n');
  fs.writeFileSync(path.join(canonical, 'validation.sql'), 'select 3\n');
  fs.mkdirSync(path.join(canonical, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(canonical, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(canonical, 'AGENTS.md'), 'injected\n');

  // Named workgroup-root worktree with an UNPUSHED commit.
  const namedWt = path.join(wgDir, 'PROJ-pr213-review');
  git(canonical, ['worktree', 'add', '-q', '-b', 'fix/pr213-followups', namedWt]);
  fs.writeFileSync(path.join(namedWt, 'followup.sql'), 'select 4\n');
  git(namedWt, ['add', '-A']);
  git(namedWt, ['commit', '-q', '-m', 'unpushed followup']);

  // Thread worktree with uncommitted dirt.
  const threadWt = path.join(dataDir, 'v2-threads', 'slack_CTEST20001_123', 'worktrees', 'PROJ');
  fs.mkdirSync(path.dirname(threadWt), { recursive: true });
  git(canonical, ['worktree', 'add', '-q', '-b', 'thread-sess-PROJ', threadWt]);
  fs.writeFileSync(path.join(threadWt, 'wip.sql'), 'select 5 -- uncommitted\n');

  // Containers record container-absolute pointers; simulate that exactly.
  const metaRoot = path.join(canonical, '.git', 'worktrees');
  for (const metaName of fs.readdirSync(metaRoot)) {
    const gitdirFile = path.join(metaRoot, metaName, 'gitdir');
    const hostTarget = fs.readFileSync(gitdirFile, 'utf-8').trim();
    const containerTarget = hostTarget.startsWith(path.join(dataDir, 'v2-threads'))
      ? hostTarget.replace(/^.*\/worktrees\/PROJ\/\.git$/, '/workspace/worktrees/PROJ/.git')
      : hostTarget.replace(wgDir, '/workspace/workgroup');
    fs.writeFileSync(gitdirFile, containerTarget + '\n');
    const wtDir = hostTarget.replace(/\/\.git$/, '');
    fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: /workspace/workgroup/PROJ/.git/worktrees/${metaName}\n`);
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migrate-repo-store', () => {
  it('dry-run prints the plan and changes nothing', { timeout: 120_000 }, () => {
    const out = runMigration(false);
    expect(out).toContain('DRY-RUN');
    expect(out).toContain('rescue-archive');
    expect(out).toContain('2 real work file(s)');
    expect(out).toContain('2 injected artifact(s)');
    expect(fs.existsSync(path.join(wgDir, '.repos'))).toBe(false);
    expect(git(canonical, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('TICKET-1-fix');
  });

  it('execute converts the layout and preserves every piece of parked work', { timeout: 120_000 }, () => {
    const out = runMigration(true);
    expect(out).toContain('Done.');

    // Mirror exists, serves the real remote, and holds the parked branches.
    const mirror = path.join(wgDir, '.repos', 'PROJ.git');
    expect(git(mirror, ['config', '--get', 'remote.origin.url'])).toBe(remote);
    const branches = git(mirror, ['branch', '--list']);
    expect(branches).toContain('TICKET-1-fix');
    expect(branches).toContain('fix/pr213-followups');
    expect(branches).toMatch(/nanoclaw-rescue\//);

    // Old canonical path is now a DETACHED snapshot at the remote default.
    expect(git(canonical, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    const remoteMain = git(remote, ['rev-parse', 'refs/heads/main']);
    expect(git(canonical, ['rev-parse', 'HEAD'])).toBe(remoteMain);
    expect(git(canonical, ['status', '--porcelain'])).toBe('');

    // The rescue commit captured the REAL work off the parked canonical.
    const rescueBranch = git(mirror, ['branch', '--list', 'nanoclaw-rescue/*']).replace(/^\*?\s*/, '');
    const rescued = git(mirror, ['show', `${rescueBranch}:validation.sql`]);
    expect(rescued).toBe('select 3');
    // Injected artifacts must NOT ride along on the rescue branch (they are
    // preserved in the tarball + moved canonical instead).
    const rescueFiles = git(mirror, ['ls-tree', '-r', '--name-only', rescueBranch]);
    expect(rescueFiles).not.toContain('AGENTS.md');
    expect(rescueFiles).not.toContain('.claude/settings.json');

    // Named worktree with unpushed commits: standalone clone under
    // .worktrees/, discoverable through a root symlink.
    const movedWt = path.join(wgDir, '.worktrees', 'PROJ-pr213-review');
    expect(fs.statSync(path.join(movedWt, '.git')).isDirectory()).toBe(true);
    expect(git(movedWt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fix/pr213-followups');
    expect(git(movedWt, ['show', 'HEAD:followup.sql'])).toBe('select 4');
    expect(fs.lstatSync(path.join(wgDir, 'PROJ-pr213-review')).isSymbolicLink()).toBe(true);

    // Thread worktree: transplanted to a standalone clone in place, then the
    // DB-owned legacy dir moves under the wg namespace, dirt intact.
    const nsThreadWt = path.join(dataDir, 'v2-threads', 'wg-testwg', 'slack_CTEST20001_123', 'worktrees', 'PROJ');
    expect(fs.statSync(path.join(nsThreadWt, '.git')).isDirectory()).toBe(true);
    expect(git(nsThreadWt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('thread-sess-PROJ');
    expect(fs.readFileSync(path.join(nsThreadWt, 'wip.sql'), 'utf-8')).toContain('uncommitted');
    expect(git(nsThreadWt, ['status', '--porcelain'])).toContain('wip.sql');

    // Full archives + index exist; the old canonical was moved, not deleted.
    const rescues = path.join(wgDir, '.rescues');
    const run = fs.readdirSync(rescues)[0];
    for (const f of ['PROJ.bundle', 'PROJ-tree.tgz', 'PROJ-old', 'INDEX.md']) {
      expect(fs.existsSync(path.join(rescues, run, f))).toBe(true);
    }
    const index = fs.readFileSync(path.join(rescues, run, 'INDEX.md'), 'utf-8');
    expect(index).toContain('nanoclaw-rescue');
    expect(fs.readdirSync(path.join(wgDir, 'memory')).some((f) => f.startsWith('repo-store-migration-'))).toBe(true);
  });
});
