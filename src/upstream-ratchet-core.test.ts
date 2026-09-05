/**
 * Upstream-ownership ratchet — the arbitrator's boundary matrix.
 *
 * `scripts/upstream-ratchet-report.ts` is what decides GROWTH vs SHRINK, what
 * `--write` may write, and whether the tree can be measured at all. None of that
 * could be tested while it lived inside the script: `src/test-hermeticity.ts`
 * mocks `child_process` for every host suite, so a test can never drive the CLI.
 * The decisions live in `src/upstream-ratchet-core.ts` as pure functions over
 * strings and maps, and this suite drives them directly.
 *
 * RESIDUE: no test here proves that real `git` output has the shape the parsers
 * expect, or that the script calls them in the right order. That is covered by
 * running the script for real — the CI job fetches the pinned commit and runs
 * the report on every PR.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { enforceHermeticity, hermeticityAttempts } from './test-hermeticity.js';
import {
  buildManifest,
  classify,
  decideCheckOutcome,
  findDirectoryShadows,
  findUntrackedShadows,
  hashBlobContent,
  hashCatFileBatch,
  isBlocking,
  parseCatFileBatch,
  parseLsFiles,
  parseLsTree,
  parseLsTreeEntries,
  parseNumstat,
  RatchetError,
  writeGate,
  type NumstatRecord,
  type Row,
} from './upstream-ratchet-core.js';
import {
  checkTree,
  hashFile,
  sealManifest,
  validateManifestShape,
  type Finding,
  type GitMode,
  type UpstreamRatchetEntry,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

beforeAll(() => enforceHermeticity());

const NUL = '\0';
const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

function manifestOf(files: Record<string, UpstreamRatchetEntry>): UpstreamRatchetManifest {
  return sealManifest({ upstream: 'a'.repeat(40), paths: '', files });
}

function verdictOf(rows: readonly Row[], relPath: string): string {
  const row = rows.find((r) => r.path === relPath);
  return row === undefined ? 'ABSENT' : row.verdict;
}

describe('parsing git output', () => {
  it('reads modes and paths out of ls-tree, including spaces and non-ASCII', () => {
    const stdout =
      `100644 blob aaaa\tsrc/router.ts${NUL}` +
      `100755 blob bbbb\tbin/ncl${NUL}` +
      `120000 blob cccc\tAGENTS.md${NUL}` +
      `100644 blob dddd\tdocs/a naïve file.md${NUL}`;
    expect([...parseLsTree(stdout)]).toEqual([
      ['src/router.ts', '100644'],
      ['bin/ncl', '100755'],
      ['AGENTS.md', '120000'],
      ['docs/a naïve file.md', '100644'],
    ]);
  });

  it('refuses a fork submodule standing where upstream owns files', () => {
    // The shape that actually happens: upstream owns vendor/a.ts, the fork
    // replaces the whole vendor/ directory with a submodule. Nothing in the
    // index matches vendor/a.ts, so an exact-path check sees nothing and every
    // path under the gitlink records as cleanly deleted — after which moving the
    // submodule pointer changes no number in the manifest at all.
    const build = (forkIndex: Array<[string, string]>): unknown =>
      buildManifest({
        upstream: 'a'.repeat(40),
        upstreamModes: new Map<string, GitMode>([
          ['vendor/a.ts', '100644'],
          ['vendor/deep/b.ts', '100644'],
          ['src/router.ts', '100644'],
        ]),
        forkIndex: new Map(forkIndex),
        numstat: new Map(),
        modeOf: () => null,
        hashOf: () => null,
        ignored: new Set<string>(),
      });

    expect(() => build([['vendor', '160000']])).toThrow(RatchetError);
    expect(() => build([['vendor', '160000']])).toThrow(/vendor is a gitlink in the fork/);
    // The message names a shadowed path, so the reader knows what was hidden.
    expect(() => build([['vendor', '160000']])).toThrow(/stands where upstream owns vendor\/(a\.ts|deep\/b\.ts)/);
    // A deeper ancestor counts too.
    expect(() => build([['vendor/deep', '160000']])).toThrow(/stands where upstream owns vendor\/deep\/b\.ts/);
    // A gitlink that shadows nothing upstream owns is not this tool's business.
    expect(() => build([['unrelated/thing', '160000']])).not.toThrow();
    // And a prefix that is not a DIRECTORY ancestor must not false-positive.
    expect(() => build([['vend', '160000']])).not.toThrow();
  });

  it('refuses an ignored path that is also tracked', () => {
    // The `ignored` flag waives the presence, mode and hash checks, and the only
    // thing that makes that defensible is that untracked bytes are not fork
    // source. check-ignore is index-aware and should never hand over a tracked
    // path, so this never fires in practice — which is the point: the exemption
    // must not rest on one flag's default behaviour.
    expect(() =>
      buildManifest({
        upstream: 'a'.repeat(40),
        upstreamModes: new Map<string, GitMode>([['src/router.ts', '100644']]),
        forkIndex: new Map([['src/router.ts', '100644']]),
        numstat: new Map(),
        modeOf: () => '100644',
        hashOf: () => hash('1'),
        ignored: new Set(['src/router.ts']),
      }),
    ).toThrow(/matched by a .gitignore rule but is TRACKED/);
  });

  it('refuses a submodule on either side rather than recording it as something else', () => {
    // A gitlink has no bytes to hash and no lines to count, so every check the
    // ratchet makes would be vacuously true for it.
    expect(() => parseLsTree(`160000 commit abcd\tvendor/thing${NUL}`)).toThrow(RatchetError);
    expect(() => parseLsTree(`160000 commit abcd\tvendor/thing${NUL}`)).toThrow(/submodules are not supported/);
    expect(() =>
      buildManifest({
        upstream: 'a'.repeat(40),
        upstreamModes: new Map<string, GitMode>([['vendor/thing', '100644']]),
        forkIndex: new Map([['vendor/thing', '160000']]),
        numstat: new Map(),
        modeOf: () => '100644',
        hashOf: () => hash('1'),
        ignored: new Set<string>(),
      }),
    ).toThrow(/gitlink in the fork/);
  });

  it('rejects an unknown mode instead of coercing it', () => {
    expect(() => parseLsTree(`100777 blob abcd\tweird${NUL}`)).toThrow(/unexpected git mode/);
  });

  it('reads ls-files stage records for the tracked set', () => {
    const stdout = `100644 aaaa 0\tsrc/router.ts${NUL}120000 bbbb 0\tAGENTS.md${NUL}`;
    expect([...parseLsFiles(stdout)]).toEqual([
      ['src/router.ts', '100644'],
      ['AGENTS.md', '120000'],
    ]);
  });

  it('sums added and deleted lines and marks binary records', () => {
    const stdout = `12\t7\tsrc/router.ts${NUL}0\t40\tdocs/gone.md${NUL}-\t-\tassets/logo.png${NUL}`;
    const stats = parseNumstat(stdout);
    expect(stats.get('src/router.ts')).toEqual({ lines: 19 });
    expect(stats.get('docs/gone.md')).toEqual({ lines: 40 });
    expect(stats.get('assets/logo.png')).toEqual({ lines: null });
    // An empty diff is an empty map, not a parse error.
    expect(parseNumstat('').size).toBe(0);
  });

  it('refuses a malformed record rather than guessing', () => {
    expect(() => parseNumstat(`12 7 src/router.ts${NUL}`)).toThrow(/could not parse numstat record/);
    expect(() => parseNumstat(`x\ty\tsrc/router.ts${NUL}`)).toThrow(/could not parse numstat counts/);
    expect(() => parseLsTree(`100644 blob aaaa src/router.ts${NUL}`)).toThrow(/could not parse ls-tree record/);
  });
});

describe('commit-source parsing (--check <ref>)', () => {
  it('reads mode and blob id for any tree, including a 120000 symlink and a 160000 gitlink', () => {
    const stdout =
      `100644 blob aaaa1111\tsrc/router.ts${NUL}` +
      `100755 blob bbbb2222\tbin/ncl${NUL}` +
      `120000 blob cccc3333\tAGENTS.md${NUL}` +
      // Unlike parseLsTree, a gitlink is recorded rather than rejected: this
      // parser reads the CHECKED ref's own tree, and a fork-side gitlink is
      // caught by assertNoGitlinkShadows, not by the parser.
      `160000 commit dddd4444\tvendor/thing${NUL}`;
    expect([...parseLsTreeEntries(stdout)]).toEqual([
      ['src/router.ts', { mode: '100644', blob: 'aaaa1111' }],
      ['bin/ncl', { mode: '100755', blob: 'bbbb2222' }],
      ['AGENTS.md', { mode: '120000', blob: 'cccc3333' }],
      ['vendor/thing', { mode: '160000', blob: 'dddd4444' }],
    ]);
  });

  it('refuses a malformed ls-tree record rather than guessing', () => {
    expect(() => parseLsTreeEntries(`100644 blob aaaa src/router.ts${NUL}`)).toThrow(/could not parse ls-tree record/);
  });

  /** One `cat-file --batch` record: `<id> SP blob SP <size> LF <content> LF`. */
  function batchRecord(id: string, content: Buffer): Buffer {
    return Buffer.concat([Buffer.from(`${id} blob ${content.length}\n`, 'utf8'), content, Buffer.from('\n', 'utf8')]);
  }

  it('parses cat-file --batch framing back into id → content, including binary bytes', () => {
    const idA = 'a'.repeat(40);
    const idB = 'b'.repeat(40);
    const binary = Buffer.from([0x00, 0xff, 0x0a, 0x50, 0x4e, 0x47]); // a raw byte string with an embedded LF
    const stdout = Buffer.concat([batchRecord(idA, Buffer.from('hello\n', 'utf8')), batchRecord(idB, binary)]);
    const parsed = parseCatFileBatch(stdout, [idA, idB]);
    expect(parsed.get(idA)?.toString('utf8')).toBe('hello\n');
    expect(parsed.get(idB)).toEqual(binary);
  });

  it('refuses a missing object and truncated framing rather than guessing', () => {
    const id = 'c'.repeat(40);
    expect(() => parseCatFileBatch(Buffer.from(`${id} missing\n`, 'utf8'), [id])).toThrow(/is missing from this clone/);
    // Header present, content shorter than the declared size.
    expect(() => parseCatFileBatch(Buffer.from(`${id} blob 10\nabc\n`, 'utf8'), [id])).toThrow(
      /truncated or missing its trailing newline while reading the content/,
    );
    // No trailing LF at all — the header itself never terminates.
    expect(() => parseCatFileBatch(Buffer.from(`${id} blob 3`, 'utf8'), [id])).toThrow(
      /truncated while reading the header/,
    );
    // The declared size is exactly right (3 bytes, "abc"), but git's MANDATORY
    // trailing LF after the content is simply absent — a different boundary
    // than "header never terminates" (no header LF at all, above) and than
    // "content shorter than declared size" (below): here the size field lied
    // about the record being fully framed, not about the content's length.
    expect(() => parseCatFileBatch(Buffer.from(`${id} blob 3\nabc`, 'utf8'), [id])).toThrow(
      /truncated or missing its trailing newline/,
    );
  });

  it('refuses a record whose returned object id or type does not match the request', () => {
    const requested = 'd'.repeat(40);
    const returned = 'e'.repeat(40);
    // A different id than the one requested — the response is out of sync
    // with the request (a caller bug, or a desynced stream from an earlier
    // misparsed record) and must not be attributed to `requested`'s path.
    expect(() => parseCatFileBatch(batchRecord(returned, Buffer.from('x', 'utf8')), [requested])).toThrow(
      /out of sync with the request/,
    );
    // A non-blob type (this parser is only ever used for blob content).
    const nonBlob = Buffer.concat([
      Buffer.from(`${requested} tree 1\n`, 'utf8'),
      Buffer.from('x', 'utf8'),
      Buffer.from('\n', 'utf8'),
    ]);
    expect(() => parseCatFileBatch(nonBlob, [requested])).toThrow(/expected blob/);
  });

  it('refuses trailing bytes left over after every requested record is read', () => {
    const id = 'f'.repeat(40);
    const clean = batchRecord(id, Buffer.from('ok\n', 'utf8'));
    // Well-formed record, PLUS bytes that don't belong to any requested id —
    // a stream that promised exactly `ids.length` records but delivered more.
    const withGarbage = Buffer.concat([clean, Buffer.from('unexpected trailing junk', 'utf8')]);
    expect(() => parseCatFileBatch(withGarbage, [id])).toThrow(/unexpected trailing byte/);
    // The clean version alone must NOT throw — the garbage is what triggers it.
    expect(() => parseCatFileBatch(clean, [id])).not.toThrow();
  });

  it('hashes batch content to sha256, matching a direct hash of the same bytes', () => {
    const id = 'd'.repeat(40);
    const content = Buffer.from('src/router.ts contents\n', 'utf8');
    const stdout = batchRecord(id, content);
    const expected = createHash('sha256').update(content).digest('hex');
    expect(hashCatFileBatch(stdout, [id]).get(id)).toBe(expected);
  });

  it('hashes a fixture BOTH ways — hashFile (fs/lstat) and hashCatFileBatch (cat-file --batch simulated) — and agrees', () => {
    // This is the load-bearing equivalence: a manifest entry written from a
    // worktree's WORKING TREE (hashFile) must check identical against the
    // SAME commit's blobs read via cat-file --batch (hashCatFileBatch), or
    // `--check` would flag every file as STALE-MANIFEST regardless of truth.
    const root = uniqueTmpRoot('upstream-ratchet-check-hash-equivalence');
    fs.mkdirSync(root, { recursive: true });

    // A regular file: git's blob content for it is exactly its bytes.
    const fileContent = Buffer.from('#!/bin/sh\necho hi\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tool.sh'), fileContent);
    const fileId = 'e'.repeat(40);
    const fileBatch = batchRecord(fileId, fileContent);
    expect(hashCatFileBatch(fileBatch, [fileId]).get(fileId)).toBe(hashFile(path.join(root, 'tool.sh')));

    // A symlink: git's blob content for a 120000 entry IS the target string,
    // which is exactly what hashFile hashes for a symlink (fs.readlinkSync,
    // never the pointee) — so no special-casing is needed for mode 120000.
    fs.symlinkSync('tool.sh', path.join(root, 'link'));
    const linkTarget = Buffer.from('tool.sh', 'utf8');
    const linkId = 'f'.repeat(40);
    const linkBatch = batchRecord(linkId, linkTarget);
    expect(hashCatFileBatch(linkBatch, [linkId]).get(linkId)).toBe(hashFile(path.join(root, 'link')));
  });

  it('hashes a NON-UTF8 symlink target as raw bytes, matching what a git blob for it stores', () => {
    // Round 2 hashed a symlink target through `Buffer.from(readlinkSync(abs), 'utf8')`
    // — decode-then-reencode, which is lossless for ASCII/valid-UTF8 targets
    // (both of this fork's real symlinks) but MANGLES a target that is not
    // valid UTF-8: Node's string-mode readlinkSync decodes with the invalid
    // sequence replaced (U+FFFD), so the "fixed" bytes are never recoverable
    // by re-encoding. `hashFile` now reads the target as a raw Buffer
    // (`{ encoding: 'buffer' }`), which is the only way to agree with a git
    // blob for a 120000 entry — git stores that target string as opaque
    // bytes, with no encoding of its own.
    const root = uniqueTmpRoot('upstream-ratchet-check-symlink-non-utf8');
    fs.mkdirSync(root, { recursive: true });
    // 0xff/0xfe are never valid as the first byte of a UTF-8 sequence, and
    // 0x81/0x82 are lone continuation bytes with no valid lead — guaranteed
    // to be mangled by a decode/re-encode round trip. No NUL byte: a symlink
    // target is a path, and paths cannot contain one on any platform.
    const rawTarget = Buffer.from([0x2e, 0x2f, 0xff, 0xfe, 0x81, 0x82]);
    fs.symlinkSync(rawTarget, path.join(root, 'weird-link'));

    // The raw bytes really did survive on disk (proves the fixture is real,
    // not testing a Node bug).
    expect(fs.readlinkSync(path.join(root, 'weird-link'), { encoding: 'buffer' })).toEqual(rawTarget);

    const expected = hashBlobContent(rawTarget);
    expect(hashFile(path.join(root, 'weird-link'))).toBe(expected);
    // The OLD decode/re-encode behavior would NOT have matched — pinning the
    // regression, not just the new behavior.
    const mangled = Buffer.from(fs.readlinkSync(path.join(root, 'weird-link')), 'utf8');
    expect(mangled.equals(rawTarget), 'the fixture must actually exercise a lossy round trip').toBe(false);
  });
});

describe('--check exit decision (decideCheckOutcome)', () => {
  const finding = (path: string): Finding => ({ kind: 'changed', path, detail: 'x', hint: 'y' });
  const present = (diff: number): UpstreamRatchetEntry => ({ diff, mode: '100644', sha256: 'a'.repeat(64) });

  it('growth-only fails, with no currency findings', () => {
    const rows = classify(manifestOf({ f: present(10) }), manifestOf({ f: present(11) }));
    const outcome = decideCheckOutcome(rows, []);
    expect(outcome.failing).toBe(true);
    expect(outcome.blocking.map((r) => r.path)).toEqual(['f']);
    expect(outcome.currencyFindings).toEqual([]);
  });

  it('stale-manifest-only fails, even when classify() sees nothing blocking', () => {
    // This is the case the extraction exists to guarantee: classify() only
    // ever looks at `diff`/mode/binary/deleted-state, never at whether the
    // manifest's recorded sha256 is still accurate — an UNCHANGED verdict here
    // (identical diff on both sides) must not silently swallow a currency
    // finding, or `runCheck` computing `failing` from `blocking` alone would
    // pass a manifest whose recorded sha256 disagrees with the ref's real tree.
    const rows = classify(manifestOf({ f: present(10) }), manifestOf({ f: present(10) }));
    expect(rows.every((r) => !isBlocking(r.verdict))).toBe(true);
    const outcome = decideCheckOutcome(rows, [finding('f')]);
    expect(outcome.failing).toBe(true);
    expect(outcome.currencyFindings).toEqual([finding('f')]);
  });

  it('a clean tree — no growth, no currency findings — passes', () => {
    const rows = classify(manifestOf({ f: present(10) }), manifestOf({ f: present(10) }));
    const outcome = decideCheckOutcome(rows, []);
    expect(outcome.failing).toBe(false);
  });

  it('both failing at once still reports exactly one row of STALE-MANIFEST evidence', () => {
    const rows = classify(manifestOf({ f: present(10) }), manifestOf({ f: present(11) }));
    const outcome = decideCheckOutcome(rows, [finding('f')]);
    expect(outcome.failing).toBe(true);
    expect(outcome.blocking).toHaveLength(1);
    expect(outcome.currencyFindings).toHaveLength(1);
  });

  describe('a malformed manifest read from an arbitrary ref (`--check` cannot trust `git show`)', () => {
    // `--check <ref>` reads `committed` from `git show <ref>:...json` — an
    // ARBITRARY ref's content, never guaranteed well-formed the way the
    // default report's local `readManifest` effectively always is.
    // `checkTree` already validates this shape without crashing (it
    // early-returns a `malformed` finding); `classify` and `counts`
    // (scripts/upstream-ratchet-report.ts) do not. `runCheck` reuses
    // `checkTree`'s `malformed` findings to decide whether to call `classify`
    // at all — these two cases pin BOTH halves: the shape is safely detected,
    // and calling `classify` on it directly (what `runCheck` no longer does)
    // really does throw, which is why the guard exists.
    const root = uniqueTmpRoot('upstream-ratchet-check-malformed-manifest');

    it('"files": null is caught by checkTree without throwing, and WOULD throw classify', () => {
      const brokenManifest = { upstream: 'a'.repeat(40), paths: '', files: null } as unknown as UpstreamRatchetManifest;
      const findings = checkTree(brokenManifest, root);
      expect(findings.some((f) => f.kind === 'malformed')).toBe(true);

      // Regression pin: this is exactly what `runCheck` skips by checking
      // `currencyFindings` for a `malformed` kind BEFORE calling classify.
      expect(() => classify(brokenManifest, manifestOf({}))).toThrow();

      // decideCheckOutcome, given the findings and an EMPTY rows array (what
      // runCheck passes when it skips classify), still fails correctly.
      const outcome = decideCheckOutcome([], findings);
      expect(outcome.failing).toBe(true);
    });

    it('a null entry is caught by checkTree without throwing, and WOULD throw classify', () => {
      const brokenManifest = sealManifest({
        upstream: 'a'.repeat(40),
        paths: '',
        files: { 'src/router.ts': null as unknown as UpstreamRatchetEntry },
      });
      const findings = checkTree(brokenManifest, root);
      expect(findings.some((f) => f.kind === 'malformed' && f.path === 'src/router.ts')).toBe(true);

      expect(() => classify(brokenManifest, manifestOf({}))).toThrow();

      const outcome = decideCheckOutcome([], findings);
      expect(outcome.failing).toBe(true);
    });
  });

  describe('validateManifestShape — the ONE place that closes the "throws instead of reporting" class', () => {
    // Every shape here would otherwise throw on the very next dereference
    // (`committed.upstream` in `resolveCommit`, called by BOTH `runCheck` and
    // `main()`) rather than report a finding. Each case is driven through
    // `decideCheckOutcome` with an EMPTY rows array — what both call sites now
    // pass when `validateManifestShape` (or `checkTree`, which calls it first)
    // finds anything wrong — to prove the exit-1 decision, not just that a
    // finding exists.
    const rejects = (value: unknown, expectDetail: RegExp): void => {
      const findings = validateManifestShape(value);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.kind === 'malformed')).toBe(true);
      expect(findings.some((f) => expectDetail.test(f.detail))).toBe(true);
      expect(decideCheckOutcome([], findings).failing).toBe(true);
    };

    it('rejects a top-level null without throwing', () => {
      expect(() => validateManifestShape(null)).not.toThrow();
      rejects(null, /not an object/);
    });

    it('rejects a top-level array without throwing', () => {
      expect(() => validateManifestShape([])).not.toThrow();
      rejects([], /not an object/);
    });

    it('rejects a missing/non-string "upstream" without throwing', () => {
      rejects({ paths: '', files: {} }, /"upstream" is not a string/);
      rejects({ upstream: 12345, paths: '', files: {} }, /"upstream" is not a string/);
    });

    it('rejects a non-object "files" (including null) without throwing', () => {
      rejects({ upstream: 'a'.repeat(40), paths: '', files: null }, /"files" is missing or is not an object/);
      rejects({ upstream: 'a'.repeat(40), paths: '', files: [] }, /"files" is missing or is not an object/);
    });

    it('accepts a well-shaped manifest (empty findings) — a real one, and the first-run empty fallback', () => {
      expect(validateManifestShape(manifestOf({}))).toEqual([]);
      expect(validateManifestShape({ upstream: '', paths: '', files: {} })).toEqual([]);
    });

    it('checkTree calls validateManifestShape FIRST, so it never reaches its own field checks on an unusable value', () => {
      // Same shape as the top-level-null case above, but through checkTree —
      // proves the wiring, not just the standalone function.
      expect(() => checkTree(null as unknown as UpstreamRatchetManifest, uniqueTmpRoot('validate-shape-checktree'))).not.toThrow();
      const findings = checkTree(null as unknown as UpstreamRatchetManifest, uniqueTmpRoot('validate-shape-checktree-2'));
      expect(findings).toEqual(validateManifestShape(null));
    });
  });
});

describe('untracked shadows', () => {
  const upstream = ['docs/gone.md', 'src/router.ts', 'templates/README.md'];

  it('flags an upstream path that exists on disk but is not tracked', () => {
    // `git diff <commit>` only looks at tracked paths, so this path reads as
    // fully deleted while lstat and hashFile happily consume whatever is there.
    const tracked = new Set(['src/router.ts']);
    const exists = (p: string): boolean => p !== 'templates/README.md';
    expect(findUntrackedShadows(upstream, tracked, exists)).toEqual(['docs/gone.md']);
  });

  it('flags an IGNORED shadow, which an untracked-file enumeration would miss', () => {
    // This is the hole in `git ls-files -o --exclude-standard`: it omits ignored
    // files by default, and a fork-deleted upstream path recreated as an ignored
    // file is exactly the case worth catching. Asking "is it tracked?" has no
    // such exception — an ignored file is not tracked either.
    expect(findUntrackedShadows(['logs/app.log'], new Set(), () => true)).toEqual(['logs/app.log']);
  });

  it('flags a path that is now a directory', () => {
    // A directory is not a tracked path and it lstat-exists, so the same rule
    // covers it with nothing extra.
    expect(findUntrackedShadows(['docs/gone.md'], new Set(['docs/gone.md/inner.md']), () => true)).toEqual([
      'docs/gone.md',
    ]);
  });

  it('exempts an IGNORED path, which is declared divergence rather than a shadow', () => {
    // The fork deleted it and told git to ignore it; something recreating it is
    // the runtime doing its job. Refusing here would make the tool unusable on a
    // live install — .claude/scheduled_tasks.lock reappears whenever the system
    // runs. The rule itself is counted in .gitignore's own entry.
    const lock = '.claude/scheduled_tasks.lock';
    expect(findUntrackedShadows([lock], new Set(), () => true)).toEqual([lock]);
    expect(findUntrackedShadows([lock], new Set(), () => true, new Set([lock]))).toEqual([]);
    // And the exemption is per-path, not a blanket switch.
    expect(findUntrackedShadows([lock, 'other.md'], new Set(), () => true, new Set([lock]))).toEqual(['other.md']);
  });

  it('is silent on a genuinely deleted path and on a tracked one', () => {
    expect(findUntrackedShadows(upstream, new Set(upstream), () => true)).toEqual([]);
    expect(findUntrackedShadows(upstream, new Set(), () => false)).toEqual([]);
  });
});

describe('directory shadows (--check <ref>)', () => {
  it('flags an upstream-owned path that is a directory in the ref, not a blob', () => {
    // upstream owns `foo` as a file; the ref replaces it with a directory
    // holding `foo/bar` — ls-tree -r lists `foo/bar` and never mentions `foo`
    // at all, which an ordinary lookup would misread as "foo is deleted".
    const shadows = findDirectoryShadows(['foo', 'src/router.ts'], ['foo/bar', 'src/router.ts']);
    expect(shadows).toEqual([{ upstreamPath: 'foo', example: 'foo/bar' }]);
  });

  it('flags a shadow at any depth, and only the paths that are actually shadowed', () => {
    const shadows = findDirectoryShadows(['a', 'a/b', 'untouched.md'], ['a/b/c.txt', 'untouched.md']);
    // Both `a` and `a/b` are directory ancestors of `a/b/c.txt` — both shadowed.
    expect(shadows.map((s) => s.upstreamPath).sort()).toEqual(['a', 'a/b']);
    // `untouched.md` is a real blob in the ref, not a directory — never shadowed.
    expect(shadows.some((s) => s.upstreamPath === 'untouched.md')).toBe(false);
  });

  it('does not flag an upstream path that is genuinely deleted (absent, not a directory)', () => {
    expect(findDirectoryShadows(['gone.md'], ['other.txt'])).toEqual([]);
  });

  it('does not flag an upstream path that is present as an ordinary blob', () => {
    expect(findDirectoryShadows(['src/router.ts'], ['src/router.ts'])).toEqual([]);
  });

  it('is unaffected by which paths are filtered OUT of upstreamPaths — the shadow is a property of refPaths alone', () => {
    // The shadowing path itself (foo/bar) is typically fork-added, not
    // upstream-owned — passing the ref's FULL path list (not pre-filtered to
    // upstream-owned paths) is what lets this fire at all.
    expect(findDirectoryShadows(['foo'], ['foo/bar', 'unrelated/fork-added.txt'])).toEqual([
      { upstreamPath: 'foo', example: 'foo/bar' },
    ]);
  });
});

describe('building entries from the working tree', () => {
  const base = {
    upstream: 'a'.repeat(40),
    forkIndex: new Map<string, string>(),
    hashOf: (): string | null => hash('1'),
  };

  function build(
    upstreamModes: Array<[string, GitMode]>,
    numstat: Array<[string, NumstatRecord]>,
    modeOf: (p: string) => GitMode | null,
    hashOf: (p: string) => string | null = base.hashOf,
    ignored: string[] = [],
  ): Record<string, UpstreamRatchetEntry> {
    return buildManifest({
      upstream: base.upstream,
      upstreamModes: new Map(upstreamModes),
      // An ignored path is by construction NOT in the index — check-ignore is
      // index-aware and never reports a tracked one, and buildManifest refuses
      // the pair. The fixture has to reflect that or it is testing a shape that
      // cannot occur.
      forkIndex: new Map(upstreamModes.filter(([p]) => !ignored.includes(p)).map(([p]) => [p, '100644'])),
      numstat: new Map(numstat),
      modeOf,
      hashOf,
      ignored: new Set(ignored),
    }).files;
  }

  it('scores an identical file zero', () => {
    expect(build([['a.md', '100644']], [], () => '100644')['a.md']).toEqual({
      diff: 0,
      mode: '100644',
      sha256: hash('1'),
    });
  });

  it('counts a mode-only change as one unit, which nothing else would see', () => {
    // Identical bytes and an empty numstat: without the mode term the whole
    // ratchet reports UNCHANGED for `chmod -x`.
    expect(build([['bin/x', '100755']], [], () => '100644')['bin/x']).toEqual({
      diff: 1,
      mode: '100644',
      sha256: hash('1'),
    });
  });

  it('adds the mode unit on top of the line delta', () => {
    expect(build([['bin/x', '100644']], [['bin/x', { lines: 9 }]], () => '100755')['bin/x'].diff).toBe(10);
  });

  it('records upstream mode and the full line count for a fork-deleted path', () => {
    expect(
      build(
        [['gone.md', '100755']],
        [['gone.md', { lines: 40 }]],
        () => null,
        () => null,
      )['gone.md'],
    ).toEqual({
      diff: 40,
      mode: '100755',
      sha256: null,
      deleted: true,
    });
  });

  it('scores a differing binary one unit for its bytes', () => {
    expect(build([['logo.png', '100644']], [['logo.png', { lines: null }]], () => '100644')['logo.png']).toEqual({
      diff: 1,
      mode: '100644',
      sha256: hash('1'),
      binary: true,
    });
    // Plus the mode unit when that moved too.
    expect(build([['logo.png', '100755']], [['logo.png', { lines: null }]], () => '100644')['logo.png'].diff).toBe(2);
  });

  it('records an ignored path without ever consulting the tree', () => {
    // `.gitignore` covering an upstream path is divergence the fork DECLARED.
    // Whatever is or is not sitting there is runtime state — the live case is
    // .claude/scheduled_tasks.lock, a lock file the running system recreates —
    // so neither `modeOf` nor `hashOf` may be called for it.
    let consulted = 0;
    const files = build(
      [['.claude/scheduled_tasks.lock', '100644']],
      [['.claude/scheduled_tasks.lock', { lines: 1 }]],
      () => {
        consulted += 1;
        return '100644';
      },
      () => {
        consulted += 1;
        return hash('1');
      },
      ['.claude/scheduled_tasks.lock'],
    );
    expect(files['.claude/scheduled_tasks.lock']).toEqual({
      diff: 1,
      mode: '100644',
      sha256: null,
      deleted: true,
      ignored: true,
    });
    expect(consulted, 'the working tree must not be consulted for an ignored path').toBe(0);
  });

  it('keeps upstream mode and line count on an ignored path', () => {
    const files = build(
      [['bin/gen', '100755']],
      [['bin/gen', { lines: 40 }]],
      () => null,
      () => null,
      ['bin/gen'],
    );
    expect(files['bin/gen']).toEqual({ diff: 40, mode: '100755', sha256: null, deleted: true, ignored: true });
  });

  it('refuses a path the manifest could not safely address', () => {
    expect(() => build([['../escape.md' as string, '100644']], [], () => '100644')).toThrow(/unusable path/);
  });
});

describe('classification boundary matrix', () => {
  const present = (diff: number, extra: Partial<UpstreamRatchetEntry> = {}): UpstreamRatchetEntry => ({
    diff,
    mode: '100644',
    sha256: hash('1'),
    ...extra,
  });

  it('names growth, shrink, stale, new and unchanged', () => {
    const before = manifestOf({
      grew: present(10),
      shrank: present(10),
      stale: present(10),
      fresh: present(0),
      same: present(10),
    });
    const after = manifestOf({
      grew: present(11),
      shrank: present(4),
      stale: present(0),
      fresh: present(3),
      same: present(10),
    });
    const rows = classify(before, after);
    expect(verdictOf(rows, 'grew')).toBe('GROWTH');
    expect(verdictOf(rows, 'shrank')).toBe('SHRINK');
    expect(verdictOf(rows, 'stale')).toBe('STALE');
    expect(verdictOf(rows, 'fresh')).toBe('NEW');
    expect(verdictOf(rows, 'same')).toBe('UNCHANGED');
    // Only the first two stop a build. Shrink is always allowed; a stale entry
    // owes a regeneration but has moved TOWARD upstream.
    expect(
      rows
        .filter((r) => isBlocking(r.verdict))
        .map((r) => r.path)
        .sort(),
    ).toEqual(['fresh', 'grew']);
  });

  it('treats a presence flip in either direction as blocking', () => {
    const deleted = (diff: number): UpstreamRatchetEntry => ({ diff, mode: '100644', sha256: null, deleted: true });
    const dropped = classify(manifestOf({ f: present(4) }), manifestOf({ f: deleted(40) }));
    expect(verdictOf(dropped, 'f')).toBe('NEW');
    const restored = classify(manifestOf({ f: deleted(40) }), manifestOf({ f: present(4) }));
    expect(verdictOf(restored, 'f')).toBe('GROWTH');
    expect(restored.find((r) => r.path === 'f')?.reason).toBe('restored in fork');
  });

  it('blocks a binary whose bytes changed while its diff stayed at one', () => {
    // Every differing binary scores 1 forever, so swapping it for arbitrary new
    // bytes moves no number at all — the one case where the line count is not a
    // measurement.
    const bin = (sha: string): UpstreamRatchetEntry => ({ diff: 1, mode: '100644', sha256: sha, binary: true });
    const changed = classify(manifestOf({ 'logo.png': bin(hash('1')) }), manifestOf({ 'logo.png': bin(hash('2')) }));
    expect(verdictOf(changed, 'logo.png')).toBe('GROWTH');
    expect(changed[0].reason).toBe('binary bytes changed');

    // NEW: was byte-identical, now divergent.
    const fresh = classify(
      manifestOf({ 'logo.png': { diff: 0, mode: '100644', sha256: hash('1') } }),
      manifestOf({ 'logo.png': bin(hash('2')) }),
    );
    expect(verdictOf(fresh, 'logo.png')).toBe('NEW');

    // Restored to upstream's bytes: a shrink, always allowed.
    const restored = classify(
      manifestOf({ 'logo.png': bin(hash('1')) }),
      manifestOf({ 'logo.png': { diff: 0, mode: '100644', sha256: hash('9') } }),
    );
    expect(verdictOf(restored, 'logo.png')).toBe('STALE');
    expect(isBlocking('STALE')).toBe(false);

    // Same bytes, same diff: nothing happened.
    const idle = classify(manifestOf({ 'logo.png': bin(hash('1')) }), manifestOf({ 'logo.png': bin(hash('1')) }));
    expect(verdictOf(idle, 'logo.png')).toBe('UNCHANGED');
  });

  it('blocks a binary-to-text transition and a text-to-binary one', () => {
    // A divergent binary recorded at diff 1 can become divergent TEXT whose
    // numstat is also 1: the bytes changed, the binary flag went away, and every
    // number stayed put. Keying the fingerprint check on the CURRENT entry alone
    // let that through as UNCHANGED.
    const bin = (sha: string): UpstreamRatchetEntry => ({ diff: 1, mode: '100644', sha256: sha, binary: true });
    const text = (sha: string, diff = 1): UpstreamRatchetEntry => ({ diff, mode: '100644', sha256: sha });

    const toText = classify(manifestOf({ f: bin(hash('1')) }), manifestOf({ f: text(hash('2')) }));
    expect(verdictOf(toText, 'f')).toBe('GROWTH');
    expect(toText[0].reason).toBe('binary bytes changed');

    const toBinary = classify(manifestOf({ f: text(hash('1')) }), manifestOf({ f: bin(hash('2')) }));
    expect(verdictOf(toBinary, 'f')).toBe('GROWTH');

    // Binary → binary with changed bytes, at the same diff: still blocked.
    expect(verdictOf(classify(manifestOf({ f: bin(hash('1')) }), manifestOf({ f: bin(hash('3')) })), 'f')).toBe(
      'GROWTH',
    );

    // Binary → identical to upstream: never blocked. The verdict is STALE — the
    // manifest owes a regeneration — and what matters is that it lets through.
    const gone = classify(manifestOf({ f: bin(hash('1')) }), manifestOf({ f: text(hash('4'), 0) }));
    expect(verdictOf(gone, 'f')).toBe('STALE');
    expect(gone.filter((r) => isBlocking(r.verdict))).toEqual([]);

    // A binary shrinking but still divergent, with changed bytes, is blocked:
    // the number went down but the line count was never the measurement.
    const shrankBytes = classify(
      manifestOf({ f: { diff: 2, mode: '100644', sha256: hash('1'), binary: true } }),
      manifestOf({ f: bin(hash('5')) }),
    );
    expect(verdictOf(shrankBytes, 'f')).toBe('GROWTH');

    // Same bytes on both sides: nothing happened, whatever the flags say.
    expect(verdictOf(classify(manifestOf({ f: bin(hash('1')) }), manifestOf({ f: bin(hash('1')) })), 'f')).toBe(
      'UNCHANGED',
    );
  });

  it('blocks a mode change even when the diff total does not move', () => {
    // The mode unit normally surfaces as GROWTH on its own. This is the case it
    // cannot: a mode change and a one-line shrink that cancel out.
    const rows = classify(
      manifestOf({ 'bin/x': { diff: 5, mode: '100755', sha256: hash('1') } }),
      manifestOf({ 'bin/x': { diff: 5, mode: '100644', sha256: hash('1') } }),
    );
    expect(verdictOf(rows, 'bin/x')).toBe('GROWTH');
    expect(rows[0].reason).toBe('mode 100755 → 100644');
  });

  it('does NOT block a text file re-edited to the same line count', () => {
    // Deliberate: for text, added+deleted IS the metric, and an equal-size edit
    // has not grown the fork's divergence. Blocking it would make every reformat
    // need an --accept and train people to reach for --accept-all.
    const rows = classify(
      manifestOf({ 'src/router.ts': present(20) }),
      manifestOf({ 'src/router.ts': present(20, { sha256: hash('7') }) }),
    );
    expect(verdictOf(rows, 'src/router.ts')).toBe('UNCHANGED');
  });

  it('reports a path that left upstream and never fails for it', () => {
    const rows = classify(manifestOf({ old: present(9) }), manifestOf({}));
    expect(verdictOf(rows, 'old')).toBe('DROPPED');
    expect(isBlocking('DROPPED')).toBe(false);
  });

  it('treats an unlisted path as NEW, which is what a first pin produces', () => {
    const rows = classify(manifestOf({}), manifestOf({ anything: present(0) }));
    expect(verdictOf(rows, 'anything')).toBe('NEW');
  });

  it('sorts rows by path so two regenerations produce the same report', () => {
    const rows = classify(manifestOf({}), manifestOf({ b: present(1), a: present(1), c: present(1) }));
    expect(rows.map((r) => r.path)).toEqual(['a', 'b', 'c']);
  });
});

describe('the write gate', () => {
  const rows: Row[] = [
    {
      verdict: 'GROWTH',
      path: 'src/host-sweep.ts',
      before: 10,
      after: 11,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    { verdict: 'NEW', path: 'a file.md', before: 0, after: 4, deletedBefore: false, deletedAfter: false, reason: null },
    {
      verdict: 'SHRINK',
      path: 'src/router.ts',
      before: 10,
      after: 2,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'STALE',
      path: 'tsconfig.json',
      before: 5,
      after: 0,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'UNCHANGED',
      path: 'README.md',
      before: 3,
      after: 3,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'DROPPED',
      path: 'old.md',
      before: 2,
      after: 0,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
  ];

  it('blocks only growth and new divergence', () => {
    const gate = writeGate(rows, new Set(), false);
    expect(gate.blocking.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
    expect(gate.unaccepted.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
  });

  it('clears exactly the accepted paths and no others', () => {
    const partial = writeGate(rows, new Set(['src/host-sweep.ts']), false);
    expect(partial.unaccepted.map((r) => r.path)).toEqual(['a file.md']);
    // Accepting a path that is not blocking changes nothing.
    const irrelevant = writeGate(rows, new Set(['src/router.ts']), false);
    expect(irrelevant.unaccepted.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
    const both = writeGate(rows, new Set(['src/host-sweep.ts', 'a file.md']), false);
    expect(both.unaccepted).toEqual([]);
    expect(both.blocking).toHaveLength(2);
  });

  it('accept-all clears everything, which is what a re-pin implies', () => {
    const gate = writeGate(rows, new Set(), true);
    expect(gate.unaccepted).toEqual([]);
    expect(gate.blocking).toHaveLength(2);
  });

  it('lets a clean tree through', () => {
    expect(
      writeGate(
        rows.filter((r) => !isBlocking(r.verdict)),
        new Set(),
        false,
      ).unaccepted,
    ).toEqual([]);
  });
});

describe('hermeticity', () => {
  it('the core module never spawns a subprocess or reaches the network', () => {
    expect(hermeticityAttempts().map((a) => `${a.kind} ${a.api}(${a.target})`)).toEqual([]);
  });
});
