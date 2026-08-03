import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { discoverMirrors, refreshOne, runFreshnessOnce } from './repo-freshness.js';
import { log } from './log.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

let root: string;

/** remote (bare, seeded) + mirror under <root>/<wg>/.repos/<name>.git */
function fixture(wg: string, name: string): { remote: string; mirror: string; snapshot: string } {
  const remote = path.join(root, 'remotes', `${name}.git`);
  const work = path.join(root, 'remotes', `${name}-work`);
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  execFileSync('git', ['clone', '-q', '--bare', work, remote], { stdio: 'pipe' });
  fs.rmSync(work, { recursive: true, force: true });

  const mirror = path.join(root, wg, '.repos', `${name}.git`);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', remote, mirror], { stdio: 'pipe' });
  execFileSync('git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], { cwd: mirror, stdio: 'pipe' });
  return { remote, mirror, snapshot: path.join(root, wg, name) };
}

function advanceRemote(remote: string, file: string): string {
  const scratch = path.join(root, 'scratch');
  execFileSync('git', ['clone', '-q', remote, scratch], { stdio: 'pipe' });
  fs.writeFileSync(path.join(scratch, file), 'x\n');
  git(scratch, ['add', '-A']);
  git(scratch, ['commit', '-q', '-m', `add ${file}`]);
  git(scratch, ['push', '-q', 'origin', 'main']);
  const oid = git(scratch, ['rev-parse', 'HEAD']);
  fs.rmSync(scratch, { recursive: true, force: true });
  return oid;
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-freshness-'));
  // Fixture remotes are local paths; production pins github-only origins.
  process.env.NANOCLAW_FRESHNESS_ALLOW_ANY_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_FRESHNESS_ALLOW_ANY_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(`${root}.repo-pins`, { recursive: true, force: true });
});

describe('repo-freshness', () => {
  it('discovers mirrors and creates + advances the detached snapshot to the fetched OID', async () => {
    const { remote, snapshot } = fixture('illysium', 'proj');
    const targets = discoverMirrors(root);
    expect(targets).toHaveLength(1);

    const first = await refreshOne(targets[0], root);
    expect(first.fetchOk).toBe(true);
    expect(fs.existsSync(path.join(snapshot, 'README.md'))).toBe(true);
    // Detached — no branch to park.
    expect(git(snapshot, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');

    const newOid = advanceRemote(remote, 'later.txt');
    const second = await refreshOne(targets[0], root);
    expect(second.oid).toBe(newOid);
    expect(git(snapshot, ['rev-parse', 'HEAD'])).toBe(newOid);
    expect(fs.existsSync(path.join(snapshot, 'later.txt'))).toBe(true);

    const freshnessFile = path.join(root, 'illysium', '.repos', 'proj.freshness.json');
    const recorded = JSON.parse(fs.readFileSync(freshnessFile, 'utf-8'));
    expect(recorded.oid).toBe(newOid);
    expect(recorded.ref).toBe('refs/heads/main');
    expect(recorded.fetchOk).toBe(true);
  });

  it('refuses to advance a dirty snapshot and records the error loudly', async () => {
    fixture('illysium', 'proj');
    const targets = discoverMirrors(root);
    await refreshOne(targets[0], root);
    const snapshot = targets[0].snapshotPath;
    fs.writeFileSync(path.join(snapshot, 'README.md'), 'local edit\n');

    const result = await refreshOne(targets[0], root);
    expect(result.error).toBe('snapshot has local modifications');
    expect(fs.readFileSync(path.join(snapshot, 'README.md'), 'utf-8')).toBe('local edit\n');
    expect(log.error).toHaveBeenCalled();
  });

  it('marks fetchOk=false and screams when the remote is unreachable', async () => {
    const { remote } = fixture('illysium', 'proj');
    fs.rmSync(remote, { recursive: true, force: true });
    const [target] = discoverMirrors(root);
    const result = await refreshOne(target, root);
    expect(result.fetchOk).toBe(false);
    expect(log.error).toHaveBeenCalled();
    // Snapshot still materializes from the mirror's last-known state.
    expect(fs.existsSync(path.join(target.snapshotPath, 'README.md'))).toBe(true);
  });

  it('runFreshnessOnce covers every workgroup mirror', async () => {
    fixture('illysium', 'proj-a');
    fixture('madison-reed', 'proj-b');
    await runFreshnessOnce(root);
    expect(fs.existsSync(path.join(root, 'illysium', 'proj-a', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'madison-reed', 'proj-b', 'README.md'))).toBe(true);
  });
});
