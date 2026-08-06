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
import BetterSqlite3 from 'better-sqlite3';

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
// process.exit above doesn't narrow for closures — pin the non-null value.
const WG: string = WORKGROUP;

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
    // git() trims output, so the FIRST line loses its leading status space
    // (` M x` → `M x`) — a fixed slice(3) truncates that filename. Parse the
    // 1-2 char status token explicitly instead.
    const m = line.match(/^[MTADRCU?!\s]{1,2}\s(.*)$/);
    const file = (m ? m[1] : line).split(' -> ').pop()!;
    (INJECTED_PATTERNS.some((re) => re.test(file)) ? injected : real).push(file);
  }
  return { injected, real };
}

function ensureQuiesced(): void {
  // Container names derive from agent_groups.folder, NOT the workgroup id —
  // filter by every member folder (codex native review P1 #1). No DB means
  // we cannot enumerate members: refuse unless --force.
  const members = workgroupAgentGroups();
  if (members === null) {
    if (args.includes('--force')) {
      console.warn('WARNING: central DB unavailable — member containers unverifiable, continuing under --force.');
      return;
    }
    console.error('REFUSING to execute: central DB unavailable, cannot enumerate member containers. Pass --force to override.');
    process.exit(2);
  }
  let out = '';
  try {
    out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { stdio: 'pipe', encoding: 'utf-8' })
      .toString()
      .trim()
      .split('\n')
      .filter((name) => members.some((m) => name.startsWith(`nanoclaw-v2-${m.folder}-`) || name === `nanoclaw-v2-${m.folder}`))
      .join('\n');
  } catch {
    // Quiesce is a hard precondition — an unverifiable state is a refusal,
    // not a shrug (codex final review P1 #5). --force overrides on the
    // operator's explicit authority.
    if (args.includes('--force')) {
      console.warn('WARNING: docker ps failed — quiesce unverified, continuing under --force.');
      return;
    }
    console.error('REFUSING to execute: docker ps failed, cannot verify workgroup containers are stopped. Pass --force to override.');
    process.exit(2);
  }
  if (out) {
    console.error(
      `REFUSING to execute: workgroup containers are running:\n${out}\n` +
        `Stop them first (the host also stops install-labeled containers on restart).`,
    );
    process.exit(2);
  }
}

/**
 * Migration lock: the live host's freshness worker discovers mirrors as they
 * appear and would advance snapshots while this script is mid-swap. The lock
 * file under .repos/ makes the worker skip this workgroup for the duration.
 */
const MIGRATION_LOCK = path.join(REPOS, '.migration-lock');
function withMigrationLock(fn: () => void): void {
  fs.mkdirSync(REPOS, { recursive: true });
  fs.writeFileSync(MIGRATION_LOCK, `${RUN} pid=${process.pid}\n`);
  try {
    fn();
  } finally {
    try { fs.rmSync(MIGRATION_LOCK, { force: true }); } catch { /* ignore */ }
  }
}

/** Container-absolute → host path for workgroup-tree paths; null if unmappable
 *  or escaping the workgroup dir (stale/malformed gitdir with `..`). */
function mapContainerPath(p: string): string | null {
  if (!p.startsWith('/workspace/workgroup/')) return null;
  const mapped = path.resolve(WG_DIR, p.slice('/workspace/workgroup/'.length));
  if (mapped !== WG_DIR && !mapped.startsWith(WG_DIR + path.sep)) return null;
  return mapped;
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

/**
 * Standalone-clone transplant: give <dir> its own .git at branch/sha,
 * preserving the working tree.
 *
 * Prepare-then-swap: the replacement .git is FULLY configured (refs, HEAD,
 * origin URL) inside a temp clone before the original .git file is touched,
 * and the sha is verified reachable in the mirror up front — any preparation
 * failure leaves the original checkout byte-for-byte untouched (codex final
 * review P0 #2). Only the post-swap `git reset` (index rebuild) can fail
 * after the swap; the .git dir is already valid then, so the checkout stays
 * usable and the failure is flagged rather than destructive.
 */
function transplant(dir: string, mirror: string, branch: string | null, sha: string | null): boolean {
  if (!sha) return false;
  if (tryGit(mirror, ['cat-file', '-e', `${sha}^{commit}`]) === null) {
    manualFlags.push(`transplant skipped for ${dir}: commit ${sha.slice(0, 12)} not in mirror — left untouched`);
    return false;
  }
  const temp = `${dir}.git-transplant`;
  try {
    fs.rmSync(temp, { recursive: true, force: true });
    execFileSync('git', ['clone', '--no-checkout', mirror, temp], { stdio: 'pipe', timeout: 120_000 });
    const realUrl = tryGit(mirror, ['config', '--get', 'remote.origin.url']);
    if (realUrl) git(temp, ['remote', 'set-url', 'origin', realUrl]);
    // The clone only transfers objects reachable from the mirror's CURRENT
    // refs; a parked tip preserved under nanoclaw-parked/ (or any sha the
    // clone missed) is fetched explicitly from the local mirror.
    if (tryGit(temp, ['cat-file', '-e', `${sha}^{commit}`]) === null) {
      git(temp, ['fetch', mirror, sha]);
    }
    if (branch) {
      git(temp, ['update-ref', branch, sha]);
      git(temp, ['symbolic-ref', 'HEAD', branch]);
    } else {
      git(temp, ['update-ref', '--no-deref', 'HEAD', sha]);
    }
  } catch (e) {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    manualFlags.push(`transplant preparation failed for ${dir} (checkout untouched): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  try {
    fs.rmSync(path.join(dir, '.git'), { force: true });
    fs.renameSync(path.join(temp, '.git'), path.join(dir, '.git'));
    fs.rmSync(temp, { recursive: true, force: true });
  } catch (e) {
    manualFlags.push(`transplant swap failed for ${dir}: ${e instanceof Error ? e.message : String(e)} — prepared .git at ${temp}`);
    return false;
  }
  if (tryGit(dir, ['reset', '-q', sha]) === null) {
    manualFlags.push(`transplant index rebuild failed for ${dir} — .git is valid; run \`git -C ${dir} reset ${sha}\` manually`);
  }
  return true;
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

// Rerun repair: a prior partial run may have left a valid mirror with a
// missing canonical (crash between the two swap renames). Recreate the
// snapshot from the mirror before the per-canonical pass, which only sees
// dirs that exist.
if (fs.existsSync(REPOS)) {
  for (const entry of fs.readdirSync(REPOS)) {
    if (!entry.endsWith('.git')) continue;
    const repo = entry.slice(0, -'.git'.length);
    const mirror = path.join(REPOS, entry);
    const canonical = path.join(WG_DIR, repo);
    if (fs.existsSync(canonical)) continue;
    if (tryGit(mirror, ['rev-parse', '--is-bare-repository']) !== 'true') continue;
    act('rerun-repair', `${repo}: mirror exists but canonical path is missing — recreate snapshot`, () => {
      const tmp = `${canonical}.snapshot-tmp`;
      fs.rmSync(tmp, { recursive: true, force: true });
      execFileSync('git', ['clone', mirror, tmp], { stdio: 'pipe', timeout: 300_000 });
      const url = tryGit(mirror, ['config', '--get', 'remote.origin.url']);
      if (url) git(tmp, ['remote', 'set-url', 'origin', url]);
      git(tmp, ['checkout', '--detach']);
      fs.renameSync(tmp, canonical);
    });
  }
}

for (const canonical of canonicals) {
  const repo = path.basename(canonical);
  const mirror = path.join(REPOS, `${repo}.git`);
  if (fs.existsSync(mirror)) {
    if (tryGit(mirror, ['rev-parse', '--is-bare-repository']) === 'true') {
      console.log(`-- ${repo}: valid mirror already exists, skipping (already migrated?)`);
    } else {
      manualFlags.push(
        `${repo}: mirror dir ${mirror} exists but is NOT a valid bare repo (partial clone?) — ` +
          `remove it and re-run; canonical left untouched`,
      );
      console.log(`-- ${repo}: INVALID mirror present — flagged for manual attention, skipping`);
    }
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
      // Stage ONLY the classified real-work paths — `add -A` would also
      // commit (and best-effort push) the injected artifacts this migration
      // promises to exclude (codex native review P1 #2). `-A --` handles
      // deletions and renames within the given pathspecs.
      git(canonical, ['add', '-A', '--', ...real]);
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
  act('mirror', `${repo}: bare-clone canonical → .repos/${repo}.git, repoint origin, fetch, set default HEAD`, () => {
    fs.mkdirSync(REPOS, { recursive: true });
    try {
      execFileSync('git', ['clone', '--bare', canonical, mirror], { stdio: 'pipe', timeout: 300_000 });
    } catch (e) {
      // A partial dir would be mistaken for a mirror on rerun — remove it.
      try { fs.rmSync(mirror, { recursive: true, force: true }); } catch { /* ignore */ }
      throw e;
    }
    git(mirror, ['config', 'gc.auto', '0']);
    if (originUrl) {
      git(mirror, ['remote', 'set-url', 'origin', originUrl]);
      git(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
      // The canonical may be arbitrarily stale — fetch so the snapshot cut
      // from this mirror starts at CURRENT origin, not the parked state.
      // Best-effort: offline, the snapshot serves last-known state and the
      // freshness worker catches up.
      // NO --prune: with the +refs/heads/*:refs/heads/* refspec, prune would
      // DELETE the parked/rescue branches this mirror exists to preserve —
      // they don't exist on origin (caught by the e2e test).
      //
      // The refspec is also FORCED: a parked branch whose NAME exists on
      // origin at a different tip gets clobbered by this fetch (and by every
      // later freshness fetch — hit live on a parked thread-session branch
      // during the first rollout). Record local tips first; any tip the fetch moves is
      // preserved under a LOCAL-ONLY nanoclaw-parked/<run>/ name that origin
      // fetches can never touch — reachable, clonable, in the rescue index.
      const preFetchTips = (tryGit(mirror, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/']) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const sp = l.lastIndexOf(' ');
          return { branch: l.slice(0, sp), tip: l.slice(sp + 1) };
        });
      if (tryGit(mirror, ['fetch', 'origin'], 300_000) === null) {
        manualFlags.push(`${repo}: mirror fetch from ${originUrl} failed — snapshot starts at last-known local state`);
      }
      for (const { branch: b, tip } of preFetchTips) {
        if (b.startsWith('nanoclaw-parked/') || b.startsWith('nanoclaw-rescue/')) continue;
        const now = tryGit(mirror, ['rev-parse', '--verify', `refs/heads/${b}`]);
        if (now !== tip) {
          git(mirror, ['update-ref', `refs/heads/nanoclaw-parked/${RUN}/${b}`, tip]);
          rescueIndex.push(`| ${repo} | ${b} | parked tip preserved as nanoclaw-parked/${RUN}/${b} (origin moved the branch name) |`);
        }
      }
      const symref = tryGit(mirror, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000);
      const m = symref?.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD/m);
      // Only point HEAD at a ref that actually resolves locally — a remote
      // default absent from the fetch would make the snapshot clone fail
      // after the canonical had already moved.
      const candidates = [...(m ? [m[1]] : []), 'refs/heads/main', 'refs/heads/master'];
      const target = candidates.find((r) => tryGit(mirror, ['rev-parse', '--verify', r]) !== null);
      if (target) git(mirror, ['symbolic-ref', 'HEAD', target]);
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

  // 6. Swap canonical → snapshot. Prepare-then-swap: the snapshot clone is
  // fully built at a temp path BEFORE the canonical moves, so a clone or
  // detach failure aborts with the canonical untouched (codex final review
  // P0 #1). The two renames are same-filesystem — the "no canonical at the
  // old path" window is two rename syscalls, not a network clone.
  act('snapshot-swap', `${repo}: build snapshot, then swap canonical → .rescues/${RUN}/${repo}-old`, () => {
    const tmp = `${canonical}.snapshot-tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    execFileSync('git', ['clone', mirror, tmp], { stdio: 'pipe', timeout: 300_000 });
    if (originUrl) git(tmp, ['remote', 'set-url', 'origin', originUrl]);
    git(tmp, ['checkout', '--detach']);
    fs.renameSync(canonical, path.join(RESCUES, `${repo}-old`));
    fs.renameSync(tmp, canonical);
  });
}

// ─── Per-thread worktrees ────────────────────────────────────────────────────
// Scoped by DB ownership (codex final review P1 #3): repo NAME alone cannot
// decide eligibility — two workgroups may clone same-named repos, and a
// global scan would transplant the other workgroup's checkout against this
// workgroup's mirror. Only walk session dirs of THIS workgroup's agent
// groups and thread dirs whose key belongs to THIS workgroup. No DB → skip
// the pass entirely (fail-safe, flagged).

let cachedMembers: Array<{ id: string; folder: string }> | null | undefined;
function workgroupAgentGroups(): Array<{ id: string; folder: string }> | null {
  if (cachedMembers !== undefined) return cachedMembers;
  const centralDb = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(centralDb)) return (cachedMembers = null);
  try {
    // In-process read, not a `pnpm exec tsx q.ts` subprocess: nested pnpm
    // inherits pnpm_config_verify_deps_before_run and burns ~80s of CPU per
    // exec before running anything (observed pnpm 10.33), which blew this
    // call's timeout and silently degraded the migration to "no DB".
    const db = new BetterSqlite3(centralDb, { readonly: true, fileMustExist: true });
    try {
      cachedMembers = db
        .prepare('SELECT id, folder FROM agent_groups WHERE COALESCE(workgroup_id, folder) = ?')
        .all(WG) as Array<{ id: string; folder: string }>;
    } finally {
      db.close();
    }
    return cachedMembers;
  } catch {
    return (cachedMembers = null);
  }
}

function workgroupAgentGroupIds(): Set<string> | null {
  const members = workgroupAgentGroups();
  return members === null ? null : new Set(members.map((m) => m.id));
}

interface ThreadWt {
  dir: string;
  repo: string;
}
const threadWts: ThreadWt[] = [];
const ownedAgentGroups = workgroupAgentGroupIds();
const ownedThreadSlugs = workgroupThreadSlugs();
if (ownedAgentGroups === null || ownedThreadSlugs === null) {
  manualFlags.push(
    'thread-worktrees: central DB unavailable — per-thread worktree conversion SKIPPED for safety; ' +
      're-run once the DB is readable',
  );
}
const threadBases: string[] = [];
if (ownedAgentGroups !== null && ownedThreadSlugs !== null) {
  const threadsRoot = path.join(DATA_DIR, 'v2-threads');
  if (fs.existsSync(threadsRoot)) {
    for (const e of fs.readdirSync(threadsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === `wg-${WG}` || (!e.name.startsWith('wg-') && ownedThreadSlugs.has(e.name))) {
        threadBases.push(path.join(threadsRoot, e.name));
      }
    }
  }
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  if (fs.existsSync(sessionsRoot)) {
    for (const e of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (e.isDirectory() && ownedAgentGroups.has(e.name)) threadBases.push(path.join(sessionsRoot, e.name));
    }
  }
}
for (const base of threadBases) {
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
// Ownership comes from the central DB: a legacy dir moves only when its
// thread key belongs to a session of THIS workgroup. Multi-workgroup installs
// have interleaved legacy dirs — a blanket move would hand other workgroups'
// thread state to this one.

function fsSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

function workgroupThreadSlugs(): Set<string> | null {
  const centralDb = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(centralDb)) return null;
  try {
    // In-process read — see workgroupAgentGroups for why this must not be a
    // nested `pnpm exec` subprocess.
    const db = new BetterSqlite3(centralDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT COALESCE(s.thread_id, 'dm-' || mg.platform_id) AS tid
             FROM sessions s
             JOIN messaging_groups mg ON mg.id = s.messaging_group_id
             JOIN agent_groups ag ON ag.id = s.agent_group_id
            WHERE COALESCE(ag.workgroup_id, ag.folder) = ?`,
        )
        .all(WG) as Array<{ tid: string }>;
      return new Set(rows.map((r) => fsSlug(r.tid)));
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`WARNING: cannot read central DB for thread ownership (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

const threadsBase = path.join(DATA_DIR, 'v2-threads');
if (fs.existsSync(threadsBase)) {
  const legacyDirs = fs
    .readdirSync(threadsBase, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('wg-'))
    .map((e) => e.name);
  const owned = ownedThreadSlugs;
  if (owned === null) {
    manualFlags.push(
      `thread-namespace: central DB unavailable — ${legacyDirs.length} legacy thread dir(s) left un-namespaced`,
    );
  } else {
    const toMove = legacyDirs.filter((d) => owned.has(d));
    const foreign = legacyDirs.length - toMove.length;
    if (toMove.length > 0) {
      act(
        'thread-namespace',
        `move ${toMove.length} of ${legacyDirs.length} legacy thread dir(s) under wg-${WORKGROUP}/ (${foreign} belong to other workgroups or are orphaned — left in place)`,
        () => {
          const nsDir = path.join(threadsBase, `wg-${WORKGROUP}`);
          fs.mkdirSync(nsDir, { recursive: true });
          for (const d of toMove) fs.renameSync(path.join(threadsBase, d), path.join(nsDir, d));
        },
      );
    }
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
    '',
    'NanoClaw-injected artifacts (.claude/, CLAUDE.md, AGENTS.md, .mcp.json,',
    '.gitignore edits) were NOT committed to rescue branches — they are',
    'pollution, not work. If one of those was a deliberate edit, recover it',
    'from the tree tarball or the moved canonical above.',
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
let aborted = false;
withMigrationLock(() => {
  for (const p of plan) {
    if (!p.run) continue;
    try {
      p.run();
      console.log(`  ✓ [${p.kind}] ${p.detail}`);
    } catch (e) {
      console.error(`  ✗ [${p.kind}] ${p.detail}\n    ${e instanceof Error ? e.message : String(e)}`);
      console.error('Aborting — state so far is preserved (archives are written before any destructive step).');
      aborted = true; // no process.exit inside the lock — finally must release it
      break;
    }
  }
});
if (aborted) process.exit(3);
if (manualFlags.length) {
  console.log('\nNeeds manual attention:');
  for (const f of manualFlags) console.log(`  - ${f}`);
}
console.log('\nDone. Restart the host (or respawn workgroup containers) to pick up RO snapshot mounts.');
