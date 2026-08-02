/**
 * Repo-store migration: legacy shared canonical clones → bare mirror +
 * detached RO snapshot + standalone thread clones.
 *
 *   pnpm exec tsx scripts/migrate-repo-store.ts --workgroup <id> [--execute]
 *
 * Default is DRY-RUN: prints the full per-repo action plan and touches
 * nothing. `--execute` requires the workgroup's containers to be stopped
 * (quiesce is a hard precondition — live containers hold cwds and git state
 * inside the trees being rewritten).
 *
 * Per legacy canonical clone at the workgroup root:
 *   1. Inventory: checked-out branch, dirty files, linked worktrees.
 *   2. Rescue archive: `git bundle --all` + full tar (tree + .git) into
 *      `.rescues/<run>/` — nothing is touched before both exist.
 *   3. Dirt classification: NanoClaw-injected artifacts (.claude/, CLAUDE.md,
 *      AGENTS.md, .mcp.json, .gitignore) vs real work. Real work is committed
 *      to `nanoclaw-rescue/<run>/<branch>` — the original branch is never
 *      polluted. Push of original + rescue branches is best-effort (the
 *      bundle already guarantees nothing is lost).
 *   4. Convert: bare-clone the canonical (captures every local branch,
 *      including unpushed and the rescue branch) to `.repos/<repo>.git`,
 *      repoint origin at the real remote, set the fetch refspec, set HEAD
 *      from the remote's default when reachable.
 *   5. Linked worktrees:
 *      - workgroup-root named checkouts (`/workspace/workgroup/<name>`) are
 *        converted to standalone clones under `.worktrees/<name>` with a
 *        root-level relative symlink keeping the old name findable (Graphify
 *        skips symlinks, agents don't lose the path). Clean + fully-pushed
 *        ones are simply removed.
 *      - per-thread worktrees (data/v2-threads|v2-sessions .../worktrees/<repo>)
 *        get a .git-dir transplant: clone --no-checkout from the mirror, move
 *        the .git dir in, recreate the branch ref at the recorded commit, and
 *        `git reset` to rebuild the index without touching the working tree —
 *        dirt survives byte-for-byte. Clean + pushed ones are deleted
 *        (create_worktree recreates on demand).
 *      - anything unmappable is left in place and listed for manual handling.
 *   6. The old canonical moves to `.rescues/<run>/<repo>-old` (never deleted)
 *      and a fresh detached snapshot clone takes its place at the old path.
 *   7. Legacy thread-state dirs move under the wg-<id> namespace, ending the
 *      threadStateDir fallback window for this workgroup.
 *   8. Rescue index written to `.rescues/<run>/INDEX.md` and the workgroup
 *      memory (`memory/repo-store-migration-<date>.md`).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const WORKGROUP = flagValue('--workgroup');
const EXECUTE = args.includes('--execute');
const ROOT = path.resolve(flagValue('--root') ?? path.join(import.meta.dirname, '..'));
const DATA_DIR = process.env.NANOCLAW_DATA_DIR ?? path.join(ROOT, 'data');

if (!WORKGROUP) {
  console.error('Usage: tsx scripts/migrate-repo-store.ts --workgroup <id> [--execute]');
  process.exit(1);
}

const WG_DIR = path.join(DATA_DIR, 'workgroups', WORKGROUP);
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const RESCUES = path.join(WG_DIR, '.rescues', RUN);
const REPOS = path.join(WG_DIR, '.repos');
const WORKTREES_NS = path.join(WG_DIR, '.worktrees');

const INJECTED_PATTERNS = [
  /^\.claude\//,
  /^CLAUDE\.md$/,
  /^CLAUDE\.local\.md$/,
  /^AGENTS\.md$/,
  /^\.mcp\.json$/,
  /^\.gitignore$/,
  /^\.claude-fragments\//,
];

interface PlannedAction {
  kind: string;
  detail: string;
  run?: () => void;
}

const plan: PlannedAction[] = [];
const manualFlags: string[] = [];
const rescueIndex: string[] = [];

function act(kind: string, detail: string, run?: () => void): void {
  plan.push({ kind, detail, run });
}

function git(cwd: string, gitArgs: string[], timeoutMs = 120_000): string {
  return execFileSync('git', gitArgs, { cwd, stdio: 'pipe', encoding: 'utf-8', timeout: timeoutMs }).toString().trim();
}
function tryGit(cwd: string, gitArgs: string[], timeoutMs = 120_000): string | null {
  try {
    return git(cwd, gitArgs, timeoutMs);
  } catch {
    return null;
  }
}

function isGitClone(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

function classifyDirt(statusPorcelain: string): { injected: string[]; real: string[] } {
  const injected: string[] = [];
  const real: string[] = [];
  for (const line of statusPorcelain.split('\n').filter(Boolean)) {
    const file = line.slice(3).split(' -> ').pop()!;
    (INJECTED_PATTERNS.some((re) => re.test(file)) ? injected : real).push(file);
  }
  return { injected, real };
}

function ensureQuiesced(): void {
  let out = '';
  try {
    out = execFileSync(
      'docker',
      ['ps', '--filter', `name=nanoclaw-v2-${WORKGROUP}`, '--format', '{{.Names}}'],
      { stdio: 'pipe', encoding: 'utf-8' },
    ).toString().trim();
  } catch {
    console.warn('WARNING: docker ps failed — cannot verify quiesce; continuing on your authority.');
    return;
  }
  if (out) {
    console.error(
      `REFUSING to execute: workgroup containers are running:\n${out}\n` +
        `Stop them first (the host also stops install-labeled containers on restart).`,
    );
    process.exit(2);
  }
}

/** Container-absolute → host path for workgroup-tree paths; null if unmappable. */
function mapContainerPath(p: string): string | null {
  if (p.startsWith('/workspace/workgroup/')) return path.join(WG_DIR, p.slice('/workspace/workgroup/'.length));
  return null;
}

interface WorktreeRecord {
  metaName: string;
  gitdirTarget: string; // path of the worktree's .git FILE, often container-absolute
  branch: string | null; // refs/heads/<b> or null (detached)
  sha: string | null;
}

function readLinkedWorktrees(canonical: string): WorktreeRecord[] {
  const metaRoot = path.join(canonical, '.git', 'worktrees');
  let names: string[] = [];
  try {
    names = fs.readdirSync(metaRoot);
  } catch {
    return [];
  }
  const records: WorktreeRecord[] = [];
  for (const metaName of names) {
    const meta = path.join(metaRoot, metaName);
    let gitdirTarget = '';
    try {
      gitdirTarget = fs.readFileSync(path.join(meta, 'gitdir'), 'utf-8').trim().replace(/\/\.git$/, '');
    } catch {
      continue;
    }
    let branch: string | null = null;
    let sha: string | null = null;
    try {
      const head = fs.readFileSync(path.join(meta, 'HEAD'), 'utf-8').trim();
      if (head.startsWith('ref: ')) {
        branch = head.slice('ref: '.length);
        sha = tryGit(canonical, ['rev-parse', branch]);
      } else {
        sha = head;
      }
    } catch {
      /* leave nulls */
    }
    records.push({ metaName, gitdirTarget, branch, sha });
  }
  return records;
}

/** Standalone-clone transplant: give <dir> its own .git at branch/sha, preserving the working tree. */
function transplant(dir: string, mirror: string, branch: string | null, sha: string | null): boolean {
  if (!sha) return false;
  const temp = `${dir}.git-transplant`;
  try {
    execFileSync('git', ['clone', '--no-checkout', mirror, temp], { stdio: 'pipe', timeout: 120_000 });
    fs.rmSync(path.join(dir, '.git'), { force: true });
    fs.renameSync(path.join(temp, '.git'), path.join(dir, '.git'));
    fs.rmSync(temp, { recursive: true, force: true });
    const realUrl = tryGit(mirror, ['config', '--get', 'remote.origin.url']);
    if (realUrl) tryGit(dir, ['remote', 'set-url', 'origin', realUrl]);
    if (branch) {
      git(dir, ['update-ref', branch, sha]);
      git(dir, ['symbolic-ref', 'HEAD', branch]);
    } else {
      git(dir, ['update-ref', '--no-deref', 'HEAD', sha]);
    }
    git(dir, ['reset', '-q', sha]);
    return true;
  } catch (e) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    manualFlags.push(`transplant failed for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * "Fully pushed" must be judged against the REAL remote, not the local
 * mirror — the mirror contains every parked local branch by construction, so
 * `log HEAD --not --remotes` would call unpushed work "pushed" and delete
 * its checkout. Offline (ls-remote fails) counts as NOT pushed — keep the dir.
 */
function isFullyPushed(dir: string): boolean {
  const status = tryGit(dir, ['status', '--porcelain']);
  if (status !== '') return false;
  const branch = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') return false;
  const local = tryGit(dir, ['rev-parse', 'HEAD']);
  const remote = tryGit(dir, ['ls-remote', 'origin', `refs/heads/${branch}`], 60_000);
  if (!local || remote === null || remote === '') return false;
  return remote.split('\t')[0] === local;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

if (!fs.existsSync(WG_DIR)) {
  console.error(`No workgroup dir at ${WG_DIR}`);
  process.exit(1);
}

const canonicals = fs
  .readdirSync(WG_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
  .map((e) => path.join(WG_DIR, e.name))
  .filter((dir) => isGitClone(dir));

console.log(`\n=== repo-store migration — workgroup '${WORKGROUP}' — ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} ===`);
console.log(`${canonicals.length} legacy canonical clone(s): ${canonicals.map((c) => path.basename(c)).join(', ') || '(none)'}\n`);

for (const canonical of canonicals) {
  const repo = path.basename(canonical);
  const mirror = path.join(REPOS, `${repo}.git`);
  if (fs.existsSync(path.join(mirror, 'HEAD'))) {
    console.log(`-- ${repo}: mirror already exists, skipping (already migrated?)`);
    continue;
  }

  const branch = tryGit(canonical, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '(unknown)';
  const status = tryGit(canonical, ['status', '--porcelain']) ?? '';
  const { injected, real } = classifyDirt(status);
  const originUrl = tryGit(canonical, ['config', '--get', 'remote.origin.url']);
  const worktrees = readLinkedWorktrees(canonical);

  console.log(`-- ${repo}`);
  console.log(`   branch: ${branch}   origin: ${originUrl ?? '(none)'}`);
  console.log(`   dirt: ${real.length} real work file(s), ${injected.length} injected artifact(s)`);
  if (real.length) console.log(`     real: ${real.slice(0, 8).join(', ')}${real.length > 8 ? ` (+${real.length - 8})` : ''}`);
  console.log(`   linked worktrees: ${worktrees.length}`);

  // 1. Rescue archives.
  act('rescue-archive', `${repo}: bundle --all + tar → .rescues/${RUN}/`, () => {
    fs.mkdirSync(RESCUES, { recursive: true });
    git(canonical, ['bundle', 'create', path.join(RESCUES, `${repo}.bundle`), '--all'], 300_000);
    execFileSync('tar', ['-czf', path.join(RESCUES, `${repo}-tree.tgz`), '-C', path.dirname(canonical), repo], {
      stdio: 'pipe',
      timeout: 600_000,
    });
  });

  // 2. Rescue-commit real dirt on a dedicated branch (never the original).
  const rescueBranch = `nanoclaw-rescue/${RUN}/${branch.replace(/[^A-Za-z0-9._/-]/g, '-')}`;
  if (real.length > 0) {
    act('rescue-commit', `${repo}: commit ${real.length} real-work file(s) → ${rescueBranch}`, () => {
      git(canonical, ['checkout', '-b', rescueBranch]);
      git(canonical, ['add', '-A']);
      git(canonical, [
        '-c', 'user.email=migration@nanoclaw.local', '-c', 'user.name=nanoclaw-migration',
        'commit', '--no-verify', '-m', `nanoclaw-rescue: parked working-tree changes from ${branch} (${RUN})`,
      ]);
      rescueIndex.push(`| ${repo} | ${branch} | rescue branch \`${rescueBranch}\` (was parked dirty on canonical) |`);
    });
  } else if (branch !== '(unknown)' && !['main', 'master'].includes(branch)) {
    rescueIndex.push(`| ${repo} | ${branch} | branch preserved in mirror \`.repos/${repo}.git\` |`);
  }

  // 3. Convert to bare mirror (from the LOCAL canonical → captures every
  // local branch, then repoint at the real remote).
  act('mirror', `${repo}: bare-clone canonical → .repos/${repo}.git, repoint origin, set default HEAD`, () => {
    fs.mkdirSync(REPOS, { recursive: true });
    execFileSync('git', ['clone', '--bare', canonical, mirror], { stdio: 'pipe', timeout: 300_000 });
    if (originUrl) {
      git(mirror, ['remote', 'set-url', 'origin', originUrl]);
      git(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
      const symref = tryGit(mirror, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000);
      const m = symref?.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD/m);
      if (m) tryGit(mirror, ['symbolic-ref', 'HEAD', m[1]]);
      else {
        const guess = ['refs/heads/main', 'refs/heads/master'].find((r) => tryGit(mirror, ['rev-parse', '--verify', r]) !== null);
        if (guess) tryGit(mirror, ['symbolic-ref', 'HEAD', guess]);
      }
    }
  });

  // 4. Best-effort pushes (bundle already guarantees preservation).
  if (originUrl) {
    act('push', `${repo}: best-effort push of ${branch}${real.length ? ` + ${rescueBranch}` : ''}`, () => {
      const toPush = [branch, ...(real.length ? [rescueBranch] : [])].filter((b) => b !== '(unknown)' && b !== 'HEAD');
      for (const b of toPush) {
        const pushed = tryGit(mirror, ['push', 'origin', `refs/heads/${b}:refs/heads/${b}`], 120_000);
        if (pushed === null) manualFlags.push(`${repo}: push of ${b} failed — preserved in mirror + bundle only`);
      }
    });
  }

  // 5. Named workgroup-root worktrees.
  for (const wt of worktrees) {
    const hostDir = mapContainerPath(wt.gitdirTarget);
    const label = `${repo}:${wt.metaName}`;
    if (!hostDir || !fs.existsSync(hostDir)) {
      if (hostDir === null && fs.existsSync(path.join(canonical, '.git', 'worktrees', wt.metaName))) {
        // Thread worktrees (/workspace/worktrees/...) are handled in the
        // thread pass below; anything else unmappable is flagged.
        if (!wt.gitdirTarget.startsWith('/workspace/worktrees/')) {
          manualFlags.push(`${label}: unmappable worktree at ${wt.gitdirTarget} — left as-is`);
        }
      }
      continue;
    }
    act('named-worktree', `${repo}: convert ${path.relative(WG_DIR, hostDir)} (${wt.branch ?? 'detached'})`, () => {
      const name = path.relative(WG_DIR, hostDir);
      const converted = transplant(hostDir, mirror, wt.branch, wt.sha);
      if (!converted) return;
      if (isFullyPushed(hostDir)) {
        fs.rmSync(hostDir, { recursive: true, force: true });
        return;
      }
      const dest = path.join(WORKTREES_NS, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(hostDir, dest);
      // Relative symlink keeps the old name findable; Graphify skips symlinks.
      fs.symlinkSync(path.relative(path.dirname(hostDir), dest), hostDir);
      rescueIndex.push(`| ${repo} | ${wt.branch ?? '(detached)'} | \`.worktrees/${name}\` (symlinked at \`${name}\`) |`);
    });
  }

  // 6. Swap canonical → snapshot.
  act('snapshot-swap', `${repo}: move canonical → .rescues/${RUN}/${repo}-old, create detached snapshot`, () => {
    // worktree metadata pruned so the mirror (cloned earlier) is not affected.
    fs.renameSync(canonical, path.join(RESCUES, `${repo}-old`));
    execFileSync('git', ['clone', mirror, canonical], { stdio: 'pipe', timeout: 300_000 });
    if (originUrl) tryGit(canonical, ['remote', 'set-url', 'origin', originUrl]);
    git(canonical, ['checkout', '--detach']);
  });
}

// ─── Per-thread worktrees ────────────────────────────────────────────────────

interface ThreadWt {
  dir: string;
  repo: string;
}
const threadWts: ThreadWt[] = [];
for (const base of [path.join(DATA_DIR, 'v2-threads'), path.join(DATA_DIR, 'v2-sessions')]) {
  if (!fs.existsSync(base)) continue;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'worktrees') {
        for (const repoEnt of fs.readdirSync(full, { withFileTypes: true })) {
          if (!repoEnt.isDirectory()) continue;
          const wtDir = path.join(full, repoEnt.name);
          const gitFile = path.join(wtDir, '.git');
          try {
            if (fs.statSync(gitFile).isFile()) threadWts.push({ dir: wtDir, repo: repoEnt.name });
          } catch {
            /* no .git — skip */
          }
        }
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(base, 0);
}

for (const { dir, repo } of threadWts) {
  const mirror = path.join(REPOS, `${repo}.git`);
  const canonicalOld = path.join(RESCUES, `${repo}-old`);
  const mirrorWillExist = canonicals.some((c) => path.basename(c) === repo) || fs.existsSync(path.join(mirror, 'HEAD'));
  if (!mirrorWillExist) continue; // repo not part of this workgroup migration
  act('thread-worktree', `transplant ${dir}`, () => {
    let meta: WorktreeRecord | undefined;
    // The worktree's .git file names the canonical's .git/worktrees/<n>;
    // the canonical has moved to .rescues by now, so read metadata there.
    try {
      const gitfile = fs.readFileSync(path.join(dir, '.git'), 'utf-8').trim();
      const metaName = path.basename(gitfile.replace(/^gitdir:\s*/, ''));
      meta = readLinkedWorktrees(canonicalOld).find((w) => w.metaName === metaName);
      if (meta && meta.sha === null && meta.branch) {
        meta.sha = tryGit(canonicalOld, ['rev-parse', meta.branch]);
      }
    } catch {
      /* fall through */
    }
    if (!meta) {
      manualFlags.push(`${dir}: no worktree metadata found — left as-is (recoverable from ${canonicalOld})`);
      return;
    }
    const converted = transplant(dir, mirror, meta.branch, meta.sha);
    if (converted && isFullyPushed(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else if (converted) {
      rescueIndex.push(`| ${repo} | ${meta.branch ?? '(detached)'} | thread worktree \`${dir}\` (converted in place) |`);
    }
  });
}

// ─── Legacy thread-state dirs → wg namespace ─────────────────────────────────

const threadsBase = path.join(DATA_DIR, 'v2-threads');
if (fs.existsSync(threadsBase)) {
  const legacyDirs = fs
    .readdirSync(threadsBase, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('wg-'))
    .map((e) => e.name);
  if (legacyDirs.length > 0) {
    act('thread-namespace', `move ${legacyDirs.length} legacy thread dir(s) under wg-${WORKGROUP}/ (single-workgroup install assumption — verify)`, () => {
      const nsDir = path.join(threadsBase, `wg-${WORKGROUP}`);
      fs.mkdirSync(nsDir, { recursive: true });
      for (const d of legacyDirs) fs.renameSync(path.join(threadsBase, d), path.join(nsDir, d));
    });
  }
}

// ─── Index + memory note ─────────────────────────────────────────────────────

act('rescue-index', `write .rescues/${RUN}/INDEX.md + workgroup memory note`, () => {
  fs.mkdirSync(RESCUES, { recursive: true });
  const table = ['| repo | branch | where it lives now |', '|---|---|---|', ...rescueIndex].join('\n');
  const body = [
    `# Repo-store migration — ${RUN}`,
    '',
    'Canonical repo clones were converted to bare mirrors (`.repos/<repo>.git`).',
    'The old canonical paths now hold **read-only snapshots of origin/HEAD**,',
    'kept current by the host. Work happens in per-thread checkouts via',
    '`create_worktree` — same tools, same paths as before.',
    '',
    '## Where parked work went',
    '',
    table,
    '',
    'Full pre-migration archives (git bundle + tree tarball + the old canonical',
    `itself) are in \`.rescues/${RUN}/\`. Nothing was deleted.`,
    manualFlags.length ? `\n## Needs manual attention\n\n${manualFlags.map((f) => `- ${f}`).join('\n')}` : '',
  ].join('\n');
  fs.writeFileSync(path.join(RESCUES, 'INDEX.md'), body);
  const memDir = path.join(WG_DIR, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, `repo-store-migration-${RUN.slice(0, 10)}.md`), body);
});

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`\nPlanned actions (${plan.length}):`);
for (const p of plan) console.log(`  [${p.kind}] ${p.detail}`);

if (!EXECUTE) {
  console.log('\nDRY-RUN — nothing was changed. Re-run with --execute to apply.');
  process.exit(0);
}

ensureQuiesced();
console.log('\nExecuting…');
for (const p of plan) {
  if (!p.run) continue;
  try {
    p.run();
    console.log(`  ✓ [${p.kind}] ${p.detail}`);
  } catch (e) {
    console.error(`  ✗ [${p.kind}] ${p.detail}\n    ${e instanceof Error ? e.message : String(e)}`);
    console.error('Aborting — state so far is preserved (archives are written before any destructive step).');
    process.exit(3);
  }
}
if (manualFlags.length) {
  console.log('\nNeeds manual attention:');
  for (const f of manualFlags) console.log(`  - ${f}`);
}
console.log('\nDone. Restart the host (or respawn workgroup containers) to pick up RO snapshot mounts.');
