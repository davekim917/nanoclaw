import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from './test-hermeticity.js';
import { snapshotTopics, type TopicSnapshotOptions } from './topic-snapshot.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Every entry under `dir` with the attributes any write would change. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      out.set(path.relative(dir, full), `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ino}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

let root: string;
let data: string;
let topics: string;
let remote: string;
let options: TopicSnapshotOptions;

function topic(name: string, repo = 'app'): string {
  const dir = path.join(topics, 'wg', name, 'worktrees', repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return dir;
}

function manifest(): string {
  return fs.existsSync(options.manifestPath) ? fs.readFileSync(options.manifestPath, 'utf8') : '';
}

beforeEach(() => {
  enforceHermeticity();
  allowSubprocess(['git', 'tar', 'mkfifo']);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-snapshot-test-')));
  // The install's own checkout encloses data/, as on the host.
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, '.gitignore'), 'data/\nout/\n');
  data = path.join(root, 'data');
  topics = path.join(data, 'v2-topics');
  fs.mkdirSync(topics, { recursive: true });
  fs.mkdirSync(path.join(root, 'out'));
  remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  const seed = path.join(root, 'seed');
  git(root, 'init', '-q', seed);
  fs.writeFileSync(path.join(seed, 'app.txt'), 'base\n');
  git(seed, 'add', 'app.txt');
  git(seed, 'commit', '-qm', 'base');
  fs.appendFileSync(path.join(seed, 'app.txt'), 'second\n');
  git(seed, 'commit', '-qam', 'second');
  git(seed, 'push', '-q', remote, 'HEAD:refs/heads/main');
  options = {
    dataRoot: data,
    outDir: path.join(root, 'out', 'topics'),
    manifestPath: path.join(root, 'out', 'MANIFEST.txt'),
    patterns: [path.join(topics, '*', '*', 'worktrees', '*')],
    timeoutMs: 30_000,
    maxUntrackedBytes: 1000,
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('snapshotTopics', () => {
  it('restores a shallow clone byte-identical (unpushed branch, stash, edits, new file) without writing under data/', async () => {
    const clone = topic('topic-a');
    git(root, 'clone', '-q', '--depth', '1', `file://${remote}`, clone);
    git(clone, 'checkout', '-q', '-b', 'feature');
    fs.appendFileSync(path.join(clone, 'app.txt'), 'unpushed\n');
    git(clone, 'commit', '-qam', 'unpushed');
    fs.appendFileSync(path.join(clone, 'app.txt'), 'stashed\n');
    git(clone, 'stash', 'push', '-q');
    fs.appendFileSync(path.join(clone, 'app.txt'), 'edited\n');
    fs.writeFileSync(path.join(clone, 'new-file.txt'), 'new\n');
    const unpushed = git(clone, 'rev-parse', 'feature');
    const stash = git(clone, 'rev-parse', 'refs/stash');
    // Where a pin would be written: a write through this symref would move `feature`.
    fs.mkdirSync(path.join(clone, '.git', 'refs', 'git-safety', 'stash'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'refs', 'git-safety', 'stash', stash), 'ref: refs/heads/feature\n');
    const before = fingerprint(data);

    const result = await snapshotTopics(options);

    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ captured: 1, bundled: 1 });
    expect(fingerprint(data)).toEqual(before);
    const [label] = fs.readdirSync(options.outDir);
    const dir = path.join(options.outDir, label);
    const restore = path.join(root, 'restore');
    git(root, 'clone', '-q', remote, restore);
    git(restore, 'fetch', '-q', path.join(dir, 'unpushed-commits.bundle'), 'refs/*:refs/restored/*');
    git(restore, 'cat-file', '-e', stash);
    git(restore, 'checkout', '-q', unpushed);
    const patch = fs.readdirSync(dir).find((name) => name.endsWith('.patch.gz'))!;
    execFileSync('git', ['apply', '--binary'], {
      cwd: restore,
      input: zlib.gunzipSync(fs.readFileSync(path.join(dir, patch))),
    });
    const tarball = fs.readdirSync(dir).find((name) => name.endsWith('-untracked.tgz'))!;
    execFileSync('tar', ['xzf', path.join(dir, tarball), '-C', restore]);
    for (const file of ['app.txt', 'new-file.txt']) {
      expect(fs.readFileSync(path.join(restore, file), 'utf8')).toBe(fs.readFileSync(path.join(clone, file), 'utf8'));
    }
  });

  it('bundles a store repo once for two linked worktrees and captures each, one registered under a container path', async () => {
    const store = path.join(data, 'repositories', 'wg', 'store');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    git(root, 'clone', '-q', remote, store);
    const one = topic('topic-b', 'store');
    const two = topic('topic-c', 'store');
    git(store, 'worktree', 'add', '-q', '-b', 'topic-b', one);
    git(store, 'worktree', 'add', '-q', '-b', 'topic-c', two);
    fs.appendFileSync(path.join(one, 'app.txt'), 'b-work\n');
    git(one, 'commit', '-qam', 'unpushed on topic-b');
    fs.appendFileSync(path.join(one, 'app.txt'), 'b-edit\n');
    fs.appendFileSync(path.join(two, 'app.txt'), 'c-edit\n');
    fs.writeFileSync(
      path.join(git(one, 'rev-parse', '--absolute-git-dir'), 'gitdir'),
      '/workspace/worktrees/store/.git\n',
    );
    const before = fingerprint(data);

    const result = await snapshotTopics(options);

    expect(result.failures).toEqual([]);
    expect(result).toMatchObject({ captured: 2, bundled: 1 });
    expect(fingerprint(data)).toEqual(before);
    for (const checkout of [one, two]) {
      expect(manifest().split(`${checkout}  HEAD=`)).toHaveLength(2);
    }
  });

  it('lists checkouts git cannot open, never resolving one to the enclosing checkout or a repo outside data/', async () => {
    const orphan = topic('topic-d', 'gone');
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(root, 'no-such-admin')}\n`);
    const plain = topic('topic-e', 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'file.txt'), 'loose\n');
    const outside = path.join(root, 'outside');
    git(root, 'clone', '-q', remote, outside);
    const linkedOutside = topic('topic-g', 'outside');
    git(outside, 'worktree', 'add', '-q', '-b', 'topic-g', linkedOutside);
    fs.appendFileSync(path.join(linkedOutside, 'app.txt'), 'edit\n');
    const symlinked = topic('topic-s', 'link');
    fs.symlinkSync(outside, symlinked);
    // Admin dirs `g` and `g<LF>`: reading the second through `$(...)`-style trimming would land on the first.
    const admins = path.join(data, 'admins');
    fs.mkdirSync(admins);
    for (const name of ['g', 'g\n']) {
      const src = fs.mkdtempSync(path.join(root, 'admin-src-'));
      git(src, 'init', '-q');
      fs.writeFileSync(path.join(src, 'f.txt'), 'f\n');
      git(src, 'add', 'f.txt');
      git(src, 'commit', '-qm', 'base');
      fs.renameSync(path.join(src, '.git'), path.join(admins, name));
    }
    const lf = topic('topic-lf');
    fs.mkdirSync(lf);
    fs.writeFileSync(path.join(lf, 'f.txt'), 'edited\n');
    fs.symlinkSync(path.join(admins, 'g\n'), path.join(lf, '.git'));

    const result = await snapshotTopics(options);

    expect(result.captured).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.unreadable.map((entry) => entry.checkout).sort()).toEqual(
      [orphan, plain, linkedOutside, symlinked, lf].sort(),
    );
    expect(manifest()).toContain('topic checkouts git cannot open (not snapshotted): 5');
    expect(manifest()).not.toContain('HEAD=');
  });

  it('captures checkouts whose paths hold inner and trailing spaces', async () => {
    const spaced = path.join(topics, 'wg', 'topic f', 'worktrees', 'app two');
    const trailing = path.join(topics, 'wg', 'topic-i', 'worktrees', 'app ');
    for (const checkout of [spaced, trailing]) {
      fs.mkdirSync(path.dirname(checkout), { recursive: true });
      git(root, 'clone', '-q', remote, checkout);
      fs.appendFileSync(path.join(checkout, 'app.txt'), 'edit\n');
    }

    const result = await snapshotTopics(options);

    expect(result.failures).toEqual([]);
    expect(result.captured).toBe(2);
    expect(manifest()).toContain(`${spaced}  HEAD=`);
    expect(manifest()).toContain(`${trailing}  HEAD=`);
  });

  it('never runs a program the repo configures: fsmonitor, filter driver, reference-transaction hook, promisor transport', async () => {
    const log = path.join(root, 'ran');
    const logger = path.join(root, 'logger.sh');
    fs.writeFileSync(logger, `#!/bin/sh\necho "$0 $*" >> '${log}'\n`, { mode: 0o755 });
    const filter = path.join(root, 'filter.sh');
    fs.writeFileSync(filter, `#!/bin/sh\necho filter >> '${log}'\ncat\n`, { mode: 0o755 });

    const hostile = topic('topic-x');
    git(root, 'init', '-q', hostile);
    fs.writeFileSync(path.join(hostile, '.gitattributes'), 'x.dat filter=evil\n');
    fs.writeFileSync(path.join(hostile, 'x.dat'), 'data\n');
    git(hostile, 'add', '.');
    git(hostile, 'commit', '-qm', 'base');
    git(hostile, 'config', 'filter.evil.clean', filter);
    git(hostile, 'config', 'core.fsmonitor', logger);
    fs.copyFileSync(logger, path.join(hostile, '.git', 'hooks', 'reference-transaction'));
    fs.writeFileSync(path.join(hostile, 'new.txt'), 'untracked\n');

    const lazy = topic('topic-y');
    git(root, 'init', '-q', lazy);
    fs.writeFileSync(path.join(lazy, 'f.txt'), 'one\n');
    git(lazy, 'add', 'f.txt');
    git(lazy, 'commit', '-qm', 'base');
    const blob = git(lazy, 'rev-parse', 'HEAD:f.txt');
    fs.renameSync(path.join(lazy, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), path.join(root, 'missing-blob'));
    git(lazy, 'config', 'remote.evil.url', 'ssh://evil.invalid/x');
    git(lazy, 'config', 'remote.evil.promisor', 'true');
    git(lazy, 'config', 'extensions.partialclone', 'evil');
    git(lazy, 'config', 'core.sshCommand', logger);
    fs.appendFileSync(path.join(lazy, 'f.txt'), 'two\n');

    const stampDirty = (): void => {
      const when = new Date(Date.now() - 1_000_000 - Math.floor(Math.random() * 100_000));
      fs.utimesSync(path.join(hostile, 'x.dat'), when, when);
    };
    const fired = (run: () => void): boolean => {
      fs.rmSync(log, { force: true });
      try {
        run();
      } catch {
        // A probe only needs to reach the configured program.
      }
      return fs.existsSync(log);
    };
    stampDirty();
    expect(
      fired(() =>
        execFileSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], { cwd: hostile, stdio: 'ignore' }),
      ),
    ).toBe(true);
    stampDirty();
    expect(
      fired(() =>
        execFileSync('git', ['-c', 'filter.evil.clean=cat', 'status', '--porcelain'], {
          cwd: hostile,
          stdio: 'ignore',
        }),
      ),
    ).toBe(true);
    expect(
      fired(() => execFileSync('git', ['update-ref', 'refs/probe', 'HEAD'], { cwd: hostile, stdio: 'ignore' })),
    ).toBe(true);
    execFileSync('git', ['update-ref', '-d', 'refs/probe'], { cwd: hostile, stdio: 'ignore' });
    expect(fired(() => execFileSync('git', ['diff-index', '-p', 'HEAD'], { cwd: lazy, stdio: 'ignore' }))).toBe(true);

    fs.rmSync(log, { force: true });
    stampDirty();
    const result = await snapshotTopics(options);

    expect(fs.existsSync(log)).toBe(false);
    expect(result.captured).toBe(1);
    // The blob a lazy fetch would have pulled is missing, so its bundle and its diff both fail, loudly.
    expect(result.failures.length).toBeGreaterThan(0);
    for (const failure of result.failures) expect(failure).toContain('topic-y');
  });

  it('neutralizes a filter whatever its name, and fails a checkout whose filter name it cannot carry', async () => {
    const log = path.join(root, 'filter-ran');
    const driver = path.join(root, 'filter-driver.sh');
    fs.writeFileSync(driver, `#!/bin/sh\necho ran >> '${log}'\ncat\n`, { mode: 0o755 });
    const names: Buffer[] = [Buffer.from(''), Buffer.from('a=b'), Buffer.from('a\u2028b'), Buffer.from([0x61, 0xff])];
    const checkouts = names.map((name, index) => {
      const checkout = topic(`topic-f${index}`);
      git(root, 'clone', '-q', remote, checkout);
      fs.appendFileSync(
        path.join(checkout, '.git', 'config'),
        Buffer.concat([Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = ${driver}\n`)]),
      );
      fs.writeFileSync(
        path.join(checkout, '.git', 'info', 'attributes'),
        Buffer.concat([Buffer.from('* filter='), name, Buffer.from('\n')]),
      );
      fs.writeFileSync(path.join(checkout, 'new.txt'), 'untracked\n');
      return checkout;
    });
    const stampDirty = (): void => {
      const when = new Date(Date.now() - 1_000_000);
      for (const checkout of checkouts) fs.utimesSync(path.join(checkout, 'app.txt'), when, when);
    };
    for (const checkout of checkouts) {
      fs.rmSync(log, { force: true });
      stampDirty();
      execFileSync('git', ['status', '--porcelain'], { cwd: checkout, stdio: 'ignore' });
      expect(fs.existsSync(log)).toBe(true);
    }

    fs.rmSync(log, { force: true });
    stampDirty();
    const result = await snapshotTopics(options);

    expect(fs.existsSync(log)).toBe(false);
    expect(result.captured).toBe(3);
    expect(result.failures).toEqual([expect.stringContaining(checkouts[3])]);
  });

  it('reports a failed or stuck read as a failure, never as an empty result', async () => {
    const badStatus = topic('topic-h');
    git(root, 'clone', '-q', remote, badStatus);
    fs.appendFileSync(path.join(badStatus, 'app.txt'), 'edit\n');
    git(badStatus, 'config', 'status.showUntrackedFiles', 'invalid');
    const badLog = topic('topic-w');
    git(root, 'clone', '-q', remote, badLog);
    fs.appendFileSync(path.join(badLog, 'app.txt'), 'stashed\n');
    git(badLog, 'stash', 'push', '-q');
    git(badLog, 'config', 'log.date', 'INVALID');
    const stuck = topic('topic-z');
    git(root, 'clone', '-q', remote, stuck);
    fs.appendFileSync(path.join(stuck, 'app.txt'), 'edit\n');
    git(stuck, 'add', 'app.txt');
    const fifo = path.join(root, 'attributes-fifo');
    execFileSync('mkfifo', [fifo]);
    git(stuck, 'config', 'core.attributesFile', fifo);

    const started = Date.now();
    const result = await snapshotTopics({ ...options, timeoutMs: 2000 });

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result.captured).toBe(0);
    const failures = result.failures.join('\n');
    expect(failures).toContain(`${badStatus}: git status`);
    expect(failures).toContain('git stash list');
    expect(failures).toMatch(/killed after 2s/);
  });

  it('leaves secret-shaped and over-cap untracked files out, listing each, and captures an unborn checkout', async () => {
    const fresh = topic('topic-u');
    git(root, 'init', '-q', fresh);
    fs.writeFileSync(path.join(fresh, 'notes.md'), 'keep\n');
    fs.writeFileSync(path.join(fresh, '.env'), 'TOKEN=x\n');
    fs.writeFileSync(path.join(fresh, 'big.bin'), Buffer.alloc(2000));

    const result = await snapshotTopics(options);

    expect(result.failures).toEqual([]);
    expect(result.captured).toBe(1);
    expect(manifest()).toContain('excluded ".env" from snapshot (secret-shaped filename)');
    expect(manifest()).toContain('skipped "big.bin" (2000 bytes, >= 1000 cap)');
    expect(manifest()).toContain('HEAD=(unborn)');
    const [label] = fs.readdirSync(options.outDir);
    const tarball = fs.readdirSync(path.join(options.outDir, label)).find((name) => name.endsWith('-untracked.tgz'))!;
    const listed = execFileSync('tar', ['tzf', path.join(options.outDir, label, tarball)], { encoding: 'utf8' });
    expect(listed.trim().split('\n')).toEqual(['notes.md']);
  });

  it('counts a git call killed during admission as a failure, not as a checkout git cannot open', async () => {
    const stalled = topic('topic-q');
    git(root, 'clone', '-q', remote, stalled);
    const fifo = path.join(root, 'config-fifo');
    execFileSync('mkfifo', [fifo]);
    git(stalled, 'config', 'include.path', fifo);

    const result = await snapshotTopics({ ...options, timeoutMs: 2000 });

    expect(result.unreadable).toEqual([]);
    expect(result.failures).toEqual([expect.stringMatching(/killed after 2s/)]);
  });

  it('reports a topic it cannot list or stat, a symlinked topic dir and a pattern matching nothing; never skips them', async () => {
    const good = topic('topic-ok');
    git(root, 'clone', '-q', remote, good);
    fs.appendFileSync(path.join(good, 'app.txt'), 'edit\n');
    const unlistable = path.dirname(topic('topic-locked'));
    const unsearchable = path.dirname(topic('topic-blind'));
    fs.mkdirSync(path.join(unsearchable, 'app'));
    const outside = path.join(root, 'outside-topic');
    fs.mkdirSync(path.join(outside, 'worktrees'), { recursive: true });
    const linked = path.join(topics, 'wg', 'topic-link');
    fs.symlinkSync(outside, linked);
    fs.chmodSync(unlistable, 0o000);
    fs.chmodSync(unsearchable, 0o644);
    let result: Awaited<ReturnType<typeof snapshotTopics>>;
    try {
      result = await snapshotTopics({ ...options, patterns: [...options.patterns, path.join(root, 'nowhere', '*')] });
    } finally {
      fs.chmodSync(unlistable, 0o755);
      fs.chmodSync(unsearchable, 0o755);
    }

    expect(result.captured).toBe(1);
    expect(result.failures).toHaveLength(3);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${unlistable}: EACCES`),
        expect.stringContaining(`${path.join(unsearchable, 'app')}: EACCES`),
        `pattern ${path.join(root, 'nowhere', '*')}: matched nothing`,
      ]),
    );
    expect(result.unreadable).toEqual([{ kind: 'unreadable', checkout: linked, reason: 'a symlink' }]);
  });

  it('fails a checkout git cannot fully read, rather than capturing what it could see', async () => {
    const trackedOnly = topic('topic-t1');
    git(root, 'clone', '-q', remote, trackedOnly);
    fs.mkdirSync(path.join(trackedOnly, 'sub'));
    fs.writeFileSync(path.join(trackedOnly, 'sub', 'kept.txt'), 'kept\n');
    git(trackedOnly, 'add', 'sub');
    git(trackedOnly, 'commit', '-qm', 'sub');
    fs.appendFileSync(path.join(trackedOnly, 'sub', 'kept.txt'), 'edit\n');
    const mixed = topic('topic-t2');
    git(root, 'clone', '-q', remote, mixed);
    fs.mkdirSync(path.join(mixed, 'sub'));
    fs.writeFileSync(path.join(mixed, 'sub', 'kept.txt'), 'kept\n');
    git(mixed, 'add', 'sub');
    git(mixed, 'commit', '-qm', 'sub');
    fs.appendFileSync(path.join(mixed, 'app.txt'), 'edit\n');
    const untracked = topic('topic-t3');
    git(root, 'clone', '-q', remote, untracked);
    fs.mkdirSync(path.join(untracked, 'fresh'));
    fs.writeFileSync(path.join(untracked, 'fresh', 'new.txt'), 'new\n');
    fs.appendFileSync(path.join(untracked, 'app.txt'), 'edit\n');
    const sealed = [path.join(trackedOnly, 'sub'), path.join(mixed, 'sub'), path.join(untracked, 'fresh')];
    for (const dir of sealed) fs.chmodSync(dir, 0o000);
    let result: Awaited<ReturnType<typeof snapshotTopics>>;
    try {
      result = await snapshotTopics(options);
    } finally {
      for (const dir of sealed) fs.chmodSync(dir, 0o755);
    }

    expect(result.captured).toBe(0);
    expect(result.failures).toHaveLength(3);
    for (const checkout of [trackedOnly, mixed, untracked]) {
      expect(result.failures).toContainEqual(expect.stringContaining(checkout));
    }
  });

  it('fails a checkout whose untracked file tar cannot read, rather than archiving without it', async () => {
    const checkout = topic('topic-perm');
    git(root, 'clone', '-q', remote, checkout);
    fs.writeFileSync(path.join(checkout, 'kept.txt'), 'kept\n');
    fs.writeFileSync(path.join(checkout, 'sealed.txt'), 'sealed\n');
    fs.chmodSync(path.join(checkout, 'sealed.txt'), 0o000);

    const result = await snapshotTopics(options);

    expect(result.captured).toBe(0);
    expect(result.failures).toEqual([expect.stringMatching(/sealed\.txt: Warning: Cannot open: Permission denied/)]);
  });

  it('refuses an output location under data/', async () => {
    await expect(snapshotTopics({ ...options, outDir: path.join(data, 'out') })).rejects.toThrow(
      /refusing to write under/,
    );
  });
});
