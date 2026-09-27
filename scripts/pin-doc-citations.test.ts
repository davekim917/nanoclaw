import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

import { citationRuns, gitRead } from './lib/doc-citations.js';
import { citationClause, noteAnchors, pinDocs } from './pin-doc-citations.js';

allowSubprocess(['git']);
enforceHermeticity();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gitRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-doc-citations-'));
  roots.push(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'docs', 'review-notes'), { recursive: true });
  return root;
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function commit(root: string, message = 'fixture'): string {
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', message, '--no-gpg-sign'], { cwd: root });
  return (gitRead(root, ['rev-parse', '--short=9', 'HEAD']) ?? '').trim();
}

const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const NOTE = 'docs/review-notes/1.md';

describe('citationRuns', () => {
  it('groups same-file continuations and joined citations into one run with one pin', () => {
    const [run] = citationRuns('see `a.ts:3`, `:9-11` and `b.ts:2` at abc1234 for it');
    expect(run.pinnedSha).toBe('abc1234');
    expect(run.links.map((link) => `${link.file}:${link.span}`)).toEqual(['a.ts:3', 'a.ts:9-11', 'b.ts:2']);
  });

  it('keeps separate runs apart when prose sits between them', () => {
    const runs = citationRuns('`a.ts:3` does one thing, and `b.ts:4` at abc1234 another');
    expect(runs.map((run) => run.pinnedSha)).toEqual([null, 'abc1234']);
  });
});

describe('noteAnchors', () => {
  it('takes identifiers from code spans and identifier-shaped prose words, not plain English or the file name', () => {
    const anchors = noteAnchors(
      'the `retryBudget` reset in drainQueue() skipped MAX_RETRIES while the queue stayed full (`queue.ts:4`)',
      ['src/queue.ts'],
    );
    expect(anchors).toEqual(expect.arrayContaining(['retryBudget', 'drainQueue', 'MAX_RETRIES']));
    expect(anchors).not.toContain('while');
    expect(anchors).not.toContain('queue');
  });

  it('keeps a quoted test name whole, and ignores apostrophes in prose', () => {
    const anchors = noteAnchors("the key's lock is held ('two writers make one root')", []);
    expect(anchors).toContain('two writers make one root');
    expect(anchors.some((anchor) => anchor.startsWith('s lock'))).toBe(false);
  });

  it('does not cut a clause at a semicolon inside a code span', () => {
    const text = 'guarded by `if (x) { a(); return; }` (`f.ts:2`), then more';
    const start = text.indexOf('`f.ts');
    expect(citationClause(text, start, start + '`f.ts:2`'.length)).toContain('if (x) { a(); return; }');
  });
});

describe('pinDocs', () => {
  it('pins a note written in the fixing commit to the code before the fix when only that holds what it describes', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'import x;\n\nfunction retryWithoutBudget() {}\n');
    const before = commit(root, 'code');
    write(root, 'src/code.ts', 'import x;\nconst budget = 3;\nconst other = 1;\n\nfunction retryWithBudget() {}\n');
    write(root, NOTE, '- the old `retryWithoutBudget` at `src/code.ts:3` looped forever\n');
    commit(root, 'fix and note');

    const [outcome] = pinDocs(root, [NOTE], ['src/code.ts']);
    expect(outcome).toMatchObject({ kind: 'pinned', sha: before });
    expect(read(root, NOTE)).toContain(`\`src/code.ts:3\` at ${before} looped`);
  });

  it('pins to the commit that introduced the citation, not a later docs-only edit of the same line', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\nb\nfunction drainQueue() {}\n');
    write(root, 'src/other.ts', 'function flushAll() {}\n');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:3` and `flushAll` in `src/other.ts:1` both drop items\n');
    const introduced = commit(root, 'code and note');
    write(root, 'src/code.ts', 'new\nnew\na\nb\nfunction drainQueue() {}\n');
    commit(root, 'shift the code');
    write(
      root,
      NOTE,
      `- \`drainQueue\` at \`src/code.ts:3\` and \`flushAll\` in \`src/other.ts:1\` at ${introduced} both drop items\n`,
    );
    commit(root, 'docs-only pin of the other citation');

    const outcomes = pinDocs(root, [NOTE], ['src/code.ts']);
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'pinned', sha: introduced })]);
    expect(read(root, NOTE)).toContain(`\`src/code.ts:3\` at ${introduced} and`);
  });

  it('refuses a doc that differs from --rev by more than pins', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` once dropped items\n');
    commit(root, 'note');
    write(
      root,
      NOTE,
      '- `drainQueue` at `src/code.ts:1` once dropped items\n- `drainQueue` at `src/code.ts:1` again\n',
    );

    expect(pinDocs(root, [NOTE], [])).toEqual([
      expect.objectContaining({ kind: 'refused', line: 1, reason: expect.stringMatching(/commit it first/) }),
      expect.objectContaining({ kind: 'refused', line: 2, reason: expect.stringMatching(/commit it first/) }),
    ]);
  });

  it('ignores a later pin of an earlier citation on the same line', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\nb\nfunction drainQueue() {}\n');
    write(root, 'src/other.ts', 'function flushAll() {}\n');
    write(root, NOTE, '- `flushAll` in `src/other.ts:1`; `drainQueue` at `src/code.ts:3` drops items\n');
    const introduced = commit(root, 'code and note');
    write(root, 'src/code.ts', 'x\ny\nconst q = drainQueue();\na\nb\nfunction drainQueue() {}\n');
    commit(root, 'shift the code');
    write(
      root,
      NOTE,
      `- \`flushAll\` in \`src/other.ts:1\` at ${introduced}; \`drainQueue\` at \`src/code.ts:3\` drops items\n`,
    );
    commit(root, 'docs-only pin of the earlier citation');

    expect(pinDocs(root, [NOTE], ['src/code.ts'])).toEqual([
      expect.objectContaining({ kind: 'pinned', sha: introduced }),
    ]);
  });

  it('pins a note re-added after an earlier removal to its surviving addition', () => {
    const root = gitRoot();
    const line = '- the queue `drainQueue` at `src/code.ts:1` drops items\n';
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, line);
    commit(root, 'first note');
    write(root, NOTE, '- nothing yet\n');
    commit(root, 'drop the note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, line);
    const readded = commit(root, 're-add the note');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: readded })]);
  });

  it('refuses a note that names nothing to check the cited lines against, and leaves the doc unchanged', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\nb\nc\n');
    const text = '- this was wrong at `src/code.ts:2` for a while\n';
    write(root, NOTE, text);
    commit(root);

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'refused' })]);
    expect(read(root, NOTE)).toBe(text);
  });

  it('refuses when no revision holds the identifier at the cited lines', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\nb\nfunction other() {}\n');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:3` drops items\n');
    commit(root);

    const [outcome] = pinDocs(root, [NOTE], []);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/drainQueue/);
  });

  it("refuses when the note's own commit and the one before it both match with different code", () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\nb\nif (drainQueue()) skip();\n');
    commit(root, 'code');
    write(root, 'src/code.ts', 'a\nb\nif (drainQueue()) retry();\n');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:3` decides it\n');
    commit(root, 'change and note');

    expect(pinDocs(root, [NOTE], [])).toEqual([
      expect.objectContaining({ kind: 'refused', reason: expect.stringMatching(/both .* match/) }),
    ]);
  });

  it("checks the ambiguity around the note's own commit for every file in a joined run", () => {
    const root = gitRoot();
    write(root, 'src/a.ts', 'function drainQueue() {}\n');
    write(root, 'src/b.ts', 'drainQueue(skip);\n');
    commit(root, 'code');
    write(root, 'src/b.ts', 'drainQueue(retry);\n');
    write(root, NOTE, '- `drainQueue` at `src/a.ts:1` and `src/b.ts:1` decides it\n');
    commit(root, 'change b and note');

    expect(pinDocs(root, [NOTE], [])).toEqual([
      expect.objectContaining({ kind: 'refused', reason: expect.stringMatching(/both .* match/) }),
    ]);
  });

  it("finds the origin in the note's own doc, not a later note elsewhere with the same wording", () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, '- old finding: the `drainQueue` function at `src/code.ts:1` dropped items\n');
    const original = commit(root, 'old note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(
      root,
      'docs/review-notes/2.md',
      '- new finding: the `drainQueue` function at `src/code.ts:1` takes a limit\n',
    );
    commit(root, 'new note');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: original })]);
  });

  it('keeps the introducing commit through later prose edits on the same line', () => {
    const root = gitRoot();
    const pad = ' '.repeat(50);
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, `- OLD introduction${pad}the \`drainQueue\` function at \`src/code.ts:1\` dropped items\n`);
    const introduced = commit(root, 'note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, `- NEW introduction${pad}the \`drainQueue\` function at \`src/code.ts:1\` dropped items\n`);
    commit(root, 'reword the note');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: introduced })]);
  });

  it('finds a committed note again after an earlier run pinned another citation on its line', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, 'src/other.ts', 'function flushAll() {}\n');
    write(root, NOTE, '- `flushAll` in `src/other.ts:1`; `drainQueue` at `src/code.ts:1` drops items\n');
    const introduced = commit(root, 'note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');

    pinDocs(root, [NOTE], ['src/other.ts']);
    expect(pinDocs(root, [NOTE], ['src/code.ts'])).toEqual([
      expect.objectContaining({ kind: 'pinned', sha: introduced }),
    ]);
  });

  it('traces the right one of two identical note lines', () => {
    const root = gitRoot();
    const note = '- `drainQueue` at `src/code.ts:1` drops items\n';
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, `# First\n${note}`);
    const first = commit(root, 'first note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, `# First\n${note}# Second\n${note}`);
    const second = commit(root, 'second note');

    expect(pinDocs(root, [NOTE], []).map((outcome) => outcome.kind === 'pinned' && outcome.sha)).toEqual([
      first,
      second,
    ]);
  });

  it('traces identical notes to their own commits after an earlier run pinned another citation on both', () => {
    const root = gitRoot();
    const note = '- `flushAll` in `src/other.ts:1`; `drainQueue` at `src/code.ts:1` drops items\n';
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, 'src/other.ts', 'function flushAll() {}\n');
    write(root, NOTE, note);
    const first = commit(root, 'first note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, note + note);
    const second = commit(root, 'second note');
    write(root, 'src/code.ts', 'function drainQueue(limit, later) {}\n');
    commit(root, 'change the code again');

    pinDocs(root, [NOTE], ['src/other.ts']);
    expect(pinDocs(root, [NOTE], ['src/code.ts']).map((outcome) => outcome.kind === 'pinned' && outcome.sha)).toEqual([
      first,
      second,
    ]);
  });

  it('follows the line through a merge that kept the citation', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` drops items\n');
    const introduced = commit(root, 'note');
    const main = (gitRead(root, ['branch', '--show-current']) ?? '').trim();
    spawnSync('git', ['checkout', '-qb', 'side'], { cwd: root });
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` drops items on the side\n');
    commit(root, 'side prose');
    spawnSync('git', ['checkout', '-q', main], { cwd: root });
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` drops items on main\n');
    commit(root, 'main prose');
    spawnSync('git', ['merge', '-q', 'side', '--no-edit', '--no-gpg-sign'], { cwd: root });
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` drops items on both\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '--no-edit', '--no-gpg-sign'], { cwd: root });
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: introduced })]);
  });

  it('does not take a longer line number for the cited one in the line history', () => {
    const root = gitRoot();
    const lines = (body: string): string =>
      [`function ${body}() {}`, ...Array(8).fill('x'), `function ${body}() {}`, ''].join('\n');
    write(root, 'src/code.ts', lines('drainQueueOld'));
    write(root, NOTE, '- `drainQueueOld` at `src/code.ts:10` is old\n');
    commit(root, 'note on line 10');
    write(root, 'src/code.ts', lines('drainQueue'));
    commit(root, 'change the code');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` is current\n');
    const retargeted = commit(root, 'point the note at line 1');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: retargeted })]);
  });

  it('follows a note line that starts with its citation through a later prose edit', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, 'src/code.ts:1 — `drainQueue` drops items\n');
    const introduced = commit(root, 'note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, 'src/code.ts:1 — `drainQueue` drops items under load\n');
    commit(root, 'reword');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: introduced })]);
  });

  it('reads a note line that itself starts with dashes', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, NOTE, '-- `drainQueue` at `src/code.ts:1` drops items\n');
    const introduced = commit(root, 'note');
    write(root, 'src/code.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change the code');
    write(root, NOTE, '-- `drainQueue` at `src/code.ts:1` drops items under load\n');
    commit(root, 'reword');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: introduced })]);
  });

  it('dates a joined run from the newest of its citations', () => {
    const root = gitRoot();
    write(root, 'src/a.ts', 'function drainQueue() {}\n');
    write(root, 'src/b.ts', 'function drainQueue() {}\n');
    write(root, NOTE, '- `drainQueue` at `src/a.ts:1` drops items\n');
    commit(root, 'note on a');
    write(root, 'src/b.ts', 'function drainQueue(limit) {}\n');
    commit(root, 'change b');
    write(root, NOTE, '- `drainQueue` at `src/a.ts:1` and `src/b.ts:1` drops items\n');
    const extended = commit(root, 'extend the note to b');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: extended })]);
  });

  it('dates a continuation by the file it continues, not an equal continuation of another file', () => {
    const root = gitRoot();
    write(root, 'src/a.ts', 'function drainQueue() {}\nx\ndrainQueue(a);\n');
    write(root, 'src/b.ts', 'function drainQueue() {}\nx\ndrainQueue(old);\n');
    write(root, NOTE, '- `drainQueue` at `src/a.ts:1`, `:3`; `drainQueue` at `src/b.ts:1` drops items\n');
    commit(root, 'note');
    write(root, 'src/b.ts', 'function drainQueue() {}\nx\ndrainQueue(newLimit);\n');
    commit(root, 'change b');
    write(root, NOTE, '- `drainQueue` at `src/a.ts:1`, `:3`; `drainQueue` at `src/b.ts:1`, `:3` drops items\n');
    const extended = commit(root, 'extend the b run');

    expect(pinDocs(root, [NOTE], ['src/b.ts'])).toEqual([expect.objectContaining({ kind: 'pinned', sha: extended })]);
  });

  it('matches a named identifier whole, not inside a longer one', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    const named = commit(root, 'code');
    write(root, 'src/code.ts', 'function drainQueueLater() {}\n');
    commit(root, 'rename');
    write(root, NOTE, '- `drainQueue` at `src/code.ts:1` dropped items\n');
    commit(root, 'note');

    expect(pinDocs(root, [NOTE], [])).toEqual([expect.objectContaining({ kind: 'pinned', sha: named })]);
  });

  it('leaves pinned citations and citations of other files alone', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    write(root, 'src/other.ts', 'function flushAll() {}\n');
    const sha = commit(root);
    const text = `- \`drainQueue\` at \`src/code.ts:1\` at ${sha}; \`flushAll\` at \`src/other.ts:1\`\n`;
    write(root, NOTE, text);
    commit(root);

    expect(pinDocs(root, [NOTE], ['src/code.ts'])).toEqual([]);
    expect(read(root, NOTE)).toBe(text);
  });

  it('skips a citation-shaped token that names no file in the repo history', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'a\n');
    write(root, NOTE, '- the `drainQueue` proxy on `127.0.0.1:8080` and a 4.5:1 ratio\n');
    commit(root);

    expect(pinDocs(root, [NOTE], [])).toEqual([]);
  });

  it('writes nothing on a dry run', () => {
    const root = gitRoot();
    write(root, 'src/code.ts', 'function drainQueue() {}\n');
    const text = '- `drainQueue` at `src/code.ts:1` drops items\n';
    write(root, NOTE, text);
    commit(root);

    expect(pinDocs(root, [NOTE], [], { write: false })).toEqual([expect.objectContaining({ kind: 'pinned' })]);
    expect(read(root, NOTE)).toBe(text);
  });
});
