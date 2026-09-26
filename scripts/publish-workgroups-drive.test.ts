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
const GWS_STUB = `#!/bin/bash
up=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --upload ]]; then up="$2"; shift; fi
  shift
done
if [[ -n "$up" ]]; then
  printf 'UPLOAD %s %s\\n' "$up" "$(cat -- "$up")" >> "$GWS_LOG"
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

// Swaps a tracked file for a symlink the moment the publisher looks that file
// up on Drive: after every check on it has passed, before gws opens it.
const JQ_SWAP_STUB = `#!/bin/bash
for a in "$@"; do
  if [[ -n "\${SWAP_NAME:-}" && "$a" == *"name = '$SWAP_NAME'"*"mimeType !="* ]]; then
    ln -sfn "$SWAP_TO" "$SWAP_PATH"
  fi
done
exec "$REAL_JQ" "$@"
`;

const REAL_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();

function fixture(files: Record<string, string>) {
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
  git(repo, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'fixture');
  return { root, repo, bin, outside, gwsLog: path.join(root, 'gws.log') };
}

function run(f: ReturnType<typeof fixture>, swap: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      DRIVE_ROOT_NAME: 'test-root',
      DRIVE_REPO: f.repo,
      DRIVE_STATE_FILE: path.join(f.root, 'state.tsv'),
      GWS_LOG: f.gwsLog,
      REAL_JQ,
      ...swap,
    },
  });
  const uploads = fs.existsSync(f.gwsLog) ? fs.readFileSync(f.gwsLog, 'utf8') : '';
  return { ...result, uploads };
}

describe('publish-workgroups-drive.sh', () => {
  it('uploads a normal tracked file', () => {
    const f = fixture({ 'a/ok.txt': 'deliverable' });
    const r = run(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.uploads).toContain('UPLOAD f/ok.txt deliverable');
    expect(r.stderr).toMatch(/ADD a\/ok\.txt/);

    fs.rmSync(f.gwsLog);
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

    const r = run(f, {
      SWAP_NAME: 'report.txt',
      SWAP_TO: path.join(f.outside, 'secret.txt'),
      SWAP_PATH: path.join(f.repo, 'a/report.txt'),
    });

    expect(fs.lstatSync(path.join(f.repo, 'a/report.txt')).isSymbolicLink()).toBe(true);
    expect(r.uploads).not.toContain(SECRET);
    expect(r.uploads).toMatch(/UPLOAD \S*report\.txt original/);
  });
});
