import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/publish-workgroups-drive.sh');
const SECRET = 'host-only content';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// The stub records the bytes of every `--upload` path, so a test can assert on
// what would have left the host rather than on what the script says it did.
// Every call is also logged to GWS_CALLS, so a test can assert on "no Drive
// traffic at all". GWS_KILL_AFTER=N signals the publisher on its Nth upload,
// before that upload succeeds.
const GWS_STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$GWS_CALLS"
up=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --upload ]]; then up="$2"; shift; fi
  shift
done
if [[ -n "$up" ]]; then
  printf 'UPLOAD %s %s\\n' "$up" "$(cat -- "$up")" >> "$GWS_LOG"
  if [[ -n "\${GWS_KILL_AFTER:-}" && "$(wc -l < "$GWS_LOG")" -eq "$GWS_KILL_AFTER" ]]; then
    # The publisher itself, not a command-substitution subshell (same argv)
    # between it and this stub: climb while the parent is still running the
    # script, and stop at the first ancestor that is not.
    pid=$PPID target=""
    while [[ "$pid" -gt 1 ]] && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q '^bash [^ ]*publish-workgroups-drive\\.sh'; do
      target=$pid
      pid=$(awk '{print $4}' "/proc/$pid/stat")
    done
    [[ -n "$target" ]] && kill "-\${GWS_KILL_SIG:-TERM}" "$target"
    exit 1
  fi
fi
# One reply serves every call: a list finds nothing, a create returns an id.
echo '{"id":"id-'"$RANDOM"'","files":[]}'
`;

function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  expect(r.status, r.stderr).toBe(0);
}

// Swaps a file for a symlink the moment the publisher looks that file up on
// Drive: after every check on it has passed, before gws opens it.
const JQ_SWAP_STUB = `#!/bin/bash
for a in "$@"; do
  if [[ -n "\${SWAP_NAME:-}" && "$a" == *"name = '$SWAP_NAME'"*"mimeType !="* ]]; then
    ln -sfn "$SWAP_TO" "$SWAP_PATH"
  fi
done
exec "$REAL_JQ" "$@"
`;

const REAL_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();

type Fixture = ReturnType<typeof fixture>;

// `files` are committed (the tracked set); `untracked` are written after the
// commit, so only the allowlist can reach them.
function fixture(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-publish-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(bin, 'gws'), GWS_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'jq'), JQ_SWAP_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(outside, 'secret.pdf'), SECRET);
  git(repo, 'init', '-q');
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  for (const [rel, body] of Object.entries(untracked)) write(rel, body);
  return {
    root,
    repo,
    bin,
    outside,
    write,
    state: path.join(root, 'state.tsv'),
    gwsLog: path.join(root, 'gws.log'),
    gwsCalls: path.join(root, 'gws.calls'),
  };
}

const DELIVERABLE_EXTS = ['pdf', 'html', 'htm', 'pptx', 'xlsx', 'docx', 'md', 'csv', 'png', 'jpg', 'jpeg', 'svg'];

// Writes the config at the default location, the repo-root .drive-publish.json.
function config(f: Fixture, overrides: Record<string, unknown> = {}) {
  const cfg = {
    include_roots: ['wg1/artifacts'],
    extensions: DELIVERABLE_EXTS,
    exclude_dirs: ['node_modules', 'repos', 'worktrees', 'wt-*', 'scratch', 'tmp', '__pycache__'],
    max_file_mb: 50,
    ...overrides,
  };
  fs.writeFileSync(path.join(f.repo, '.drive-publish.json'), JSON.stringify(cfg));
}

function run(f: Fixture, env: Record<string, string> = {}, args: string[] = [], cmd: string[] = ['bash']) {
  const result = spawnSync(cmd[0], [...cmd.slice(1), SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      DRIVE_ROOT_NAME: 'test-root',
      DRIVE_REPO: f.repo,
      DRIVE_STATE_FILE: f.state,
      GWS_LOG: f.gwsLog,
      GWS_CALLS: f.gwsCalls,
      REAL_JQ,
      ...env,
    },
  });
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const uploads = read(f.gwsLog);
  const calls = read(f.gwsCalls);
  for (const p of [f.gwsLog, f.gwsCalls]) fs.rmSync(p, { force: true });
  return { ...result, uploads, calls };
}

// Marks folders as already on Drive. A folder the run creates itself is known
// empty, so the publisher skips the per-file lookup inside it; the swap stub
// hooks that lookup, so the swap tests need pre-existing folders.
function seedFolders(f: Fixture, dirs: string[]) {
  fs.writeFileSync(f.state, ['.', ...dirs].map((d, i) => `D\t${d}\tdir-${i}\n`).join(''));
}

// Repo-relative paths with an F row in the state file.
function statePaths(f: Fixture): string[] {
  if (!fs.existsSync(f.state)) return [];
  return fs
    .readFileSync(f.state, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('F\t'))
    .map((l) => l.split('\t')[1])
    .sort();
}

describe('publish-workgroups-drive.sh', () => {
  it('uploads a normal tracked file', () => {
    const f = fixture({ 'a/ok.txt': 'deliverable' });
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.uploads).toContain('UPLOAD f/ok.txt deliverable');
    expect(r.stderr).toMatch(/ADD a\/ok\.txt/);

    const again = run(f);
    expect(again.status, again.stderr).toBe(0);
    expect(again.uploads).toBe('');
    expect(again.stderr).toMatch(/skipped=1 /);
  });

  it('refuses a tracked file replaced by a symlink to a file outside the tree', () => {
    const f = fixture({ 'a/ok.txt': 'deliverable', 'a/report.txt': 'original' });
    fs.rmSync(path.join(f.repo, 'a/report.txt'));
    fs.symlinkSync(path.join(f.outside, 'secret.txt'), path.join(f.repo, 'a/report.txt'));

    const r = run(f);

    expect(r.uploads).not.toContain(SECRET);
    expect(r.uploads).not.toContain('a/report.txt');
    expect(r.uploads).toContain('UPLOAD f/ok.txt deliverable');
    expect(r.stderr).toMatch(/ERROR REFUSED a\/report\.txt/);
    expect(r.status).not.toBe(0);
  });

  it('refuses a tracked file whose parent directory was replaced by a symlink', () => {
    const f = fixture({ 'a/ok.txt': 'deliverable', 'b/secret.txt': 'original' });
    fs.rmSync(path.join(f.repo, 'b'), { recursive: true });
    fs.symlinkSync(f.outside, path.join(f.repo, 'b'));

    const r = run(f);

    expect(r.uploads).not.toContain(SECRET);
    expect(r.uploads).not.toContain('b/secret.txt');
    expect(r.uploads).toContain('UPLOAD f/ok.txt deliverable');
    expect(r.stderr).toMatch(/ERROR REFUSED b\/secret\.txt/);
    expect(r.status).not.toBe(0);
  });

  it('uploads the bytes it checked when the file is swapped for a symlink after the check', () => {
    const f = fixture({ 'a/report.txt': 'original' });
    seedFolders(f, ['a']);

    const r = run(f, {
      SWAP_NAME: 'report.txt',
      SWAP_TO: path.join(f.outside, 'secret.txt'),
      SWAP_PATH: path.join(f.repo, 'a/report.txt'),
    });

    expect(fs.lstatSync(path.join(f.repo, 'a/report.txt')).isSymbolicLink()).toBe(true);
    expect(r.uploads).not.toContain(SECRET);
    expect(r.uploads).toMatch(/UPLOAD \S*report\.txt original/);
  });

  describe('deliverables allowlist', () => {
    it('with no config file publishes exactly the tracked set, as before', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        { 'wg1/artifacts/deck.pdf': 'deck', 'wg1/artifacts/notes.md': 'notes' },
      );

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(r.uploads.trim().split('\n')).toEqual(['UPLOAD f/board.md board']);
      expect(statePaths(f)).toEqual(['wg1/records/board.md']);
      expect(r.stderr).toMatch(/done: .* tracked=1$/m);
      expect(r.stderr).not.toMatch(/allowlisted=/);
    });

    it('publishes the union of the tracked set and the allowlist, leaving tracked files unfiltered', () => {
      const f = fixture(
        {
          'wg1/records/board.md': 'board',
          // Tracked files keep publishing even where the allowlist filters
          // would reject them: a tracked .sql inside an include root.
          'wg1/artifacts/tracked.sql': 'select 1',
        },
        {
          'wg1/artifacts/decks/q3.pdf': 'deck',
          'wg1/artifacts/notes.md': 'notes',
          'wg1/elsewhere/report.pdf': 'not under an include root',
          'wg2/artifacts/chart.png': 'not under an include root either',
        },
      );
      config(f);

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(statePaths(f)).toEqual([
        'wg1/artifacts/decks/q3.pdf',
        'wg1/artifacts/notes.md',
        'wg1/artifacts/tracked.sql',
        'wg1/records/board.md',
      ]);
      expect(r.uploads).not.toContain('not under an include root');
      expect(r.stderr).toMatch(/done: .* tracked=2 allowlisted=2 oversize=0 excluded=0/);

      const again = run(f);
      expect(again.status, again.stderr).toBe(0);
      expect(again.uploads).toBe('');
      expect(again.stderr).toMatch(/skipped=4 /);
    });

    it('publishes only allowed extensions, case-insensitively', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        {
          'wg1/artifacts/query.sql': 'sql',
          'wg1/artifacts/result.json': 'json',
          'wg1/artifacts/run.log': 'log',
          'wg1/artifacts/Final.PDF': 'upper-case pdf',
          'wg1/artifacts/table.csv': 'csv',
        },
      );
      config(f);

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(statePaths(f)).toEqual(['wg1/artifacts/Final.PDF', 'wg1/artifacts/table.csv', 'wg1/records/board.md']);
    });

    it('prunes excluded and hidden directories without walking them', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        {
          'wg1/artifacts/keep/report.md': 'kept',
          'wg1/artifacts/node_modules/pkg/README.md': 'x',
          'wg1/artifacts/wt-feature/notes.md': 'x',
          'wg1/artifacts/sub/repos/clone/README.md': 'x',
          'wg1/artifacts/scratch/deep/a.md': 'x',
          'wg1/artifacts/.cache/b.md': 'x',
          'wg1/artifacts/.git/c.md': 'x',
        },
      );
      config(f);
      // An unreadable directory inside a pruned one: if find descended into
      // node_modules it would report "Permission denied" for this.
      const locked = path.join(f.repo, 'wg1/artifacts/node_modules/locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o000);
      try {
        const r = run(f);
        expect(r.status, r.stderr).toBe(0);
        expect(statePaths(f)).toEqual(['wg1/artifacts/keep/report.md', 'wg1/records/board.md']);
        expect(r.stderr).not.toMatch(/Permission denied/);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });

    it('skips and logs a file over the size cap', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        { 'wg1/artifacts/small.pdf': 'small', 'wg1/artifacts/big.pdf': 'x'.repeat(1024 * 1024 + 1) },
      );
      config(f, { max_file_mb: 1 });

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(statePaths(f)).toEqual(['wg1/artifacts/small.pdf', 'wg1/records/board.md']);
      expect(r.stderr).toMatch(/SKIP oversize wg1\/artifacts\/big\.pdf \(1048577 bytes > 1048576\)/);
      expect(r.stderr).toMatch(/oversize=1 /);
    });

    it('never follows a symlink out of the tree', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' }, { 'wg1/artifacts/ok.pdf': 'ok' });
      fs.symlinkSync(path.join(f.outside, 'secret.pdf'), path.join(f.repo, 'wg1/artifacts/leak.pdf'));
      fs.symlinkSync(f.outside, path.join(f.repo, 'wg1/artifacts/linked'));
      config(f);

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(r.uploads).not.toContain(SECRET);
      expect(statePaths(f)).toEqual(['wg1/artifacts/ok.pdf', 'wg1/records/board.md']);
      expect(r.stderr).toMatch(/SKIP symlink wg1\/artifacts\/leak\.pdf/);
    });

    it('refuses an include root that is itself a symlink out of the tree', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' });
      fs.mkdirSync(path.join(f.repo, 'wg1/artifacts'), { recursive: true });
      fs.symlinkSync(f.outside, path.join(f.repo, 'wg1/artifacts/escape'));
      config(f, { include_roots: ['wg1/artifacts/escape'] });

      const r = run(f);

      expect(r.uploads).not.toContain(SECRET);
      expect(r.stderr).toMatch(/ERROR REFUSED include root wg1\/artifacts\/escape/);
      expect(r.status).not.toBe(0);
    });

    it('uploads the bytes it checked when an allowlisted file is swapped for a symlink after the check', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' }, { 'wg1/artifacts/report.pdf': 'original' });
      config(f);
      seedFolders(f, ['wg1', 'wg1/artifacts']);

      const r = run(f, {
        SWAP_NAME: 'report.pdf',
        SWAP_TO: path.join(f.outside, 'secret.pdf'),
        SWAP_PATH: path.join(f.repo, 'wg1/artifacts/report.pdf'),
      });

      expect(fs.lstatSync(path.join(f.repo, 'wg1/artifacts/report.pdf')).isSymbolicLink()).toBe(true);
      expect(r.uploads).not.toContain(SECRET);
      expect(r.uploads).toMatch(/UPLOAD \S*report\.pdf original/);
    });

    it('refuses dotfiles and secret-looking names regardless of extension', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        {
          'wg1/artifacts/ok.md': 'ok',
          'wg1/artifacts/.hidden.md': 'x',
          'wg1/artifacts/.env.md': 'x',
          'wg1/artifacts/api-TOKEN-notes.md': 'x',
          'wg1/artifacts/client_credentials.csv': 'x',
          'wg1/artifacts/id_rsa.png': 'x',
          'wg1/artifacts/secrets/plan.md': 'x',
          'wg1/artifacts/db-password.md': 'x',
        },
      );
      config(f);

      const r = run(f);

      expect(r.status, r.stderr).toBe(0);
      expect(statePaths(f)).toEqual(['wg1/artifacts/ok.md', 'wg1/records/board.md']);
      expect(r.stderr).toMatch(/SKIP dotfile wg1\/artifacts\/\.hidden\.md/);
      expect(r.stderr).toMatch(/SKIP secret-pattern wg1\/artifacts\/api-TOKEN-notes\.md/);
      expect(r.stderr).toMatch(/SKIP secret-pattern wg1\/artifacts\/secrets\/plan\.md/);
      expect(r.stderr).toMatch(/excluded=7/);
    });

    it('fails loudly, uploading nothing, on a malformed config or a named config that is missing', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' }, { 'wg1/artifacts/deck.pdf': 'deck' });
      const cases: Array<[Record<string, unknown> | string, RegExp]> = [
        ['{not json', /FATAL invalid config/],
        [{ include_roots: [] }, /include_roots must be a non-empty array/],
        [{ include_root: ['wg1/artifacts'] }, /unknown key\(s\): include_root/],
        [{ include_roots: ['../elsewhere'] }, /invalid include root/],
        [{ include_roots: ['/abs/path'] }, /invalid include root/],
        [{ extensions: ['p/df'] }, /invalid extension/],
        [{ max_file_mb: 0 }, /max_file_mb must be a positive integer/],
      ];
      for (const [cfg, expected] of cases) {
        if (typeof cfg === 'string') fs.writeFileSync(path.join(f.repo, '.drive-publish.json'), cfg);
        else config(f, cfg);
        const r = run(f);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(expected);
        expect(r.calls).toBe('');
      }

      fs.rmSync(path.join(f.repo, '.drive-publish.json'));
      const missing = run(f, { DRIVE_PUBLISH_CONFIG: path.join(f.root, 'nope.json') });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/FATAL DRIVE_PUBLISH_CONFIG=.* is not a file/);
      expect(missing.calls).toBe('');
    });

    it('dry-run reports per-workgroup counts and bytes, with no Drive calls and no state writes', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        {
          'wg1/artifacts/deck.pdf': '12345',
          'wg1/artifacts/old.md': '1234567',
          'wg2/artifacts/chart.png': '123',
          'wg2/artifacts/query.sql': 'not allowlisted',
        },
      );
      config(f, { include_roots: ['wg1/artifacts', 'wg2/artifacts'] });
      const seeded = 'F\twg1/artifacts/old.md\tsha\tid-old\n';
      fs.writeFileSync(f.state, seeded);

      const r = run(f, { DRIVE_ROOT_NAME: '' }, ['--dry-run']);

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split('\n').slice(1)).toEqual([
        'workgroup\ttracked\tallowlist_files\tallowlist_bytes\tunpublished_files\tunpublished_bytes',
        'wg1\t1\t2\t12\t1\t5',
        'wg2\t0\t1\t3\t1\t3',
        'TOTAL\t1\t3\t15\t2\t8',
        'skipped: oversize=0 excluded=0 refused=0',
        '',
      ]);
      expect(r.calls).toBe('');
      expect(fs.readFileSync(f.state, 'utf8')).toBe(seeded);
      expect(fs.existsSync(`${f.state}.lock`)).toBe(false);
    });

    it('does not overlap a run that holds the lock', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' }, { 'wg1/artifacts/deck.pdf': 'deck' });
      config(f);

      // flock(1) holds the lock on its own open of the file while the
      // publisher runs underneath it; the publisher's open is a second one.
      const r = run(f, {}, [], ['flock', `${f.state}.lock`, 'bash']);

      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/SKIP another publisher run holds/);
      expect(r.calls).toBe('');
      expect(fs.existsSync(f.state)).toBe(false);
    });

    it('resumes an interrupted run without re-uploading finished files or losing unreached rows', () => {
      const f = fixture(
        { 'wg1/records/board.md': 'board' },
        { 'wg1/artifacts/a.md': 'a1', 'wg1/artifacts/b.md': 'b1', 'wg1/artifacts/c.md': 'c1' },
      );
      config(f);

      // Cold run killed on its 3rd upload (b.md): board.md and a.md are done.
      const cold = run(f, { GWS_KILL_AFTER: '3' });
      expect(cold.status).not.toBe(0);
      expect(statePaths(f)).toEqual(['wg1/artifacts/a.md', 'wg1/records/board.md']);

      const resumed = run(f);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.uploads.trim().split('\n')).toEqual(['UPLOAD f/b.md b1', 'UPLOAD f/c.md c1']);
      expect(statePaths(f)).toHaveLength(4);

      // Steady state: a.md and c.md change; the run is killed on a.md's
      // update, before b.md and c.md are reached. Their rows must survive, so
      // the next run skips b.md instead of re-uploading it.
      f.write('wg1/artifacts/a.md', 'a2');
      f.write('wg1/artifacts/c.md', 'c2');
      const interrupted = run(f, { GWS_KILL_AFTER: '1' });
      expect(interrupted.status).not.toBe(0);
      expect(statePaths(f)).toHaveLength(4);

      const after = run(f);
      expect(after.status, after.stderr).toBe(0);
      expect(after.uploads.trim().split('\n')).toEqual(['UPLOAD f/a.md a2', 'UPLOAD f/c.md c2']);
      expect(after.stderr).toMatch(/added=0 updated=2 skipped=2 /);
    });

    it('checkpoints progress so even a SIGKILL loses at most the last few uploads', () => {
      const f = fixture({ 'wg1/records/board.md': 'board' }, { 'wg1/artifacts/a.md': 'a', 'wg1/artifacts/b.md': 'b' });
      config(f);

      const killed = run(f, { GWS_KILL_AFTER: '3', GWS_KILL_SIG: 'KILL', DRIVE_CHECKPOINT_EVERY: '1' });
      expect(killed.status).not.toBe(0);
      expect(statePaths(f)).toEqual(['wg1/artifacts/a.md', 'wg1/records/board.md']);
    });
  });
});
