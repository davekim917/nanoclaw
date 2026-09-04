/**
 * Upstream-ownership ratchet — the hermetic half.
 *
 * This suite is `fs` + `crypto` only: no git, no network, no writes outside a
 * `uniqueTmpRoot` fixture. That is not a stylistic choice — `src/test-hermeticity.ts`
 * mocks `child_process` for every host suite, and the fork's CI clone carries no
 * upstream commit objects, so a test here could not shell out to git even if it
 * wanted to.
 *
 * What that buys and what it does not: these cases prove the committed manifest
 * is CURRENT — every upstream-owned file still hashes and still has the mode it
 * had when its `diff` was measured, the pinned path set is complete, and every
 * entry is internally well formed. They cannot prove a `diff` value is the true
 * line count; only `scripts/upstream-ratchet-report.ts`, which has git, can do
 * that, and it is the piece that arbitrates GROWTH vs SHRINK. Its decisions are
 * tested in src/upstream-ratchet-core.test.ts. See docs/upstream-ratchet.md.
 */
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { enforceHermeticity, hermeticityAttempts } from './test-hermeticity.js';
import {
  ancestorEscape,
  checkTree,
  fileModeOf,
  formatFindings,
  hashFile,
  MANIFEST_REL,
  pathsSeal,
  readManifest,
  REGENERATE_HINT,
  sealManifest,
  serializeManifest,
  shellQuote,
  validateRelPath,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const manifest: UpstreamRatchetManifest = readManifest(REPO_ROOT);
const entries = Object.entries(manifest.files);

// This suite touches nothing outside the checkout and a temp fixture, so it is
// held to the strict guard rather than the repo's `warn` default.
beforeAll(() => enforceHermeticity());

/** A fixture manifest with a correct coverage seal, so seal findings stay opt-in. */
function sealed(files: UpstreamRatchetManifest['files'], upstream = 'a'.repeat(40)): UpstreamRatchetManifest {
  return sealManifest({ upstream, paths: '', files });
}

describe('upstream-ownership ratchet', () => {
  it('manifest pins one upstream commit and covers every entry with a well-formed diff and hash', () => {
    expect(manifest.upstream, 'the pinned upstream commit must be a full 40-character sha').toMatch(/^[0-9a-f]{40}$/);
    expect(entries.length, 'the manifest must cover the whole upstream tree').toBeGreaterThan(0);

    const malformed = entries.filter(([, entry]) => {
      const diffOk = Number.isInteger(entry.diff) && entry.diff >= 0;
      const hashOk = entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256);
      const modeOk = entry.mode === '100644' || entry.mode === '100755' || entry.mode === '120000';
      return !diffOk || !hashOk || !modeOk;
    });
    expect(
      malformed.map(([p]) => p),
      'every entry needs a non-negative integer diff, a git blob mode, and a sha256 or null',
    ).toEqual([]);

    // Sorted by path, so a regeneration is a readable diff rather than a reshuffle.
    expect(Object.keys(manifest.files)).toEqual([...Object.keys(manifest.files)].sort());

    // Exactly three top-level fields. `paths` is a seal over the key SET, not an
    // aggregate over the entries' contents, so it is stable across ordinary
    // regenerations; a total or a timestamp would change on every one whatever
    // moved, and every PR would then collide on it.
    expect(Object.keys(manifest), 'the manifest carries only "upstream", "paths" and "files"').toEqual([
      'upstream',
      'paths',
      'files',
    ]);

    // The ON-DISK bytes are exactly the canonical serialization: one line per
    // file entry, sorted, fixed key order, optional flags only when true. This
    // is three guarantees in one assertion — the merge-friendly layout is not
    // just a convention, `--write` is idempotent on an unchanged tree (the same
    // input can only produce these bytes), and prettier has not reflowed the
    // file back into an indented shape (it is in .prettierignore for that).
    const onDisk = fs.readFileSync(path.join(REPO_ROOT, MANIFEST_REL), 'utf8');
    expect(
      onDisk,
      `${MANIFEST_REL} is not in canonical form — do not hand-edit or reformat it, regenerate: ${REGENERATE_HINT}`,
    ).toBe(serializeManifest(manifest));
    const bodyLines = onDisk.trimEnd().split('\n').slice(1, -1);
    expect(bodyLines.length, 'one line per file entry').toBe(entries.length);
  });

  it('every upstream-owned file matches the manifest — a divergence change without a regenerated manifest fails', () => {
    const findings = checkTree(manifest, REPO_ROOT);
    expect(
      findings,
      findings.length === 0
        ? ''
        : `The fork's copy of ${findings.length} upstream-owned file(s) moved since src/upstream-ratchet.json was ` +
            `written, so the diff sizes it records are no longer proven. Regenerate it — growth needs an explicit ` +
            `--accept and a reason in the PR body:\n\n${formatFindings(findings)}\n\n` +
            `  ${REGENERATE_HINT}\n`,
    ).toEqual([]);
  });

  it('deleted-in-fork entries stay deleted and present entries stay present', () => {
    const resurrected: string[] = [];
    const missing: string[] = [];
    for (const [relPath, entry] of entries) {
      const abs = path.join(REPO_ROOT, relPath);
      let present: boolean;
      try {
        fs.lstatSync(abs);
        present = true;
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        void error;
        present = false;
      }
      // An ignored entry is runtime state, not fork content — see the
      // dedicated case below.
      if (entry.ignored === true) continue;
      if (entry.deleted === true && present) resurrected.push(relPath);
      if (entry.deleted !== true && !present) missing.push(relPath);
    }
    expect(
      resurrected,
      `re-adopting a deleted upstream file is new divergence — ${REGENERATE_HINT} --accept <path>`,
    ).toEqual([]);
    expect(missing, `deleting an upstream file is new divergence — ${REGENERATE_HINT} --accept <path>`).toEqual([]);
  });

  it('every recorded mode agrees with the file on disk', () => {
    // A mode change carries no bytes and no lines: `chmod -x` on an upstream-owned
    // file leaves the hash identical and `git diff --numstat` empty, so before
    // `mode` existed the whole ratchet reported UNCHANGED for it. The recorded
    // mode comes from the WORKING TREE (lstat), not the index, so an unstaged
    // chmod is caught here rather than hiding until it is committed.
    const wrong: string[] = [];
    for (const [relPath, entry] of entries) {
      if (entry.deleted === true) continue;
      const actual = fileModeOf(path.join(REPO_ROOT, relPath));
      if (actual !== entry.mode) wrong.push(`${relPath}: recorded ${entry.mode}, on disk ${actual}`);
    }
    expect(wrong, `a mode change is divergence too — regenerate: ${REGENERATE_HINT}`).toEqual([]);

    // And the two halves of the mapping the recorded modes rely on.
    for (const [relPath, entry] of entries) {
      if (entry.deleted === true) continue;
      const abs = path.join(REPO_ROOT, relPath);
      const stat = fs.lstatSync(abs);
      expect(stat.isSymbolicLink(), `${relPath}: symlink ⇔ mode 120000`).toBe(entry.mode === '120000');
      if (!stat.isSymbolicLink()) {
        expect((stat.mode & 0o100) !== 0, `${relPath}: owner exec bit ⇔ mode 100755`).toBe(entry.mode === '100755');
      }
    }
  });

  it('the coverage seal fails when an entry is removed by hand', () => {
    // Without the seal, deleting one entry line leaves valid, sorted, canonical
    // JSON: every per-entry check passes because there is no entry left to
    // check, and that upstream-owned path is silently unprotected.
    expect(manifest.paths, 'the committed seal covers exactly the committed key set').toBe(
      pathsSeal(Object.keys(manifest.files)),
    );

    const files = { ...manifest.files };
    const victim = Object.keys(files).find((p) => files[p].deleted !== true) ?? Object.keys(files)[0];
    delete files[victim];
    const gutted: UpstreamRatchetManifest = { upstream: manifest.upstream, paths: manifest.paths, files };

    // Still perfectly well-formed on every other axis.
    expect(Object.keys(gutted.files)).toEqual([...Object.keys(gutted.files)].sort());
    expect(JSON.parse(serializeManifest(gutted)).files[victim]).toBeUndefined();

    const findings = checkTree(gutted, REPO_ROOT);
    expect(findings.map((f) => [f.kind, f.path])).toContainEqual(['malformed', MANIFEST_REL]);
    expect(findings.find((f) => f.path === MANIFEST_REL)?.detail).toMatch(/seal .* does not cover/);

    // Adding an entry by hand fails the same way.
    const padded = sealManifest(manifest);
    const extra: UpstreamRatchetManifest = {
      upstream: manifest.upstream,
      paths: padded.paths,
      files: { ...manifest.files, 'invented/by/hand.md': { diff: 3, mode: '100644', sha256: 'd'.repeat(64) } },
    };
    expect(checkTree(extra, REPO_ROOT).some((f) => f.path === MANIFEST_REL)).toBe(true);
  });

  it('checkTree reports changed, missing, resurrected against a fixture tree', () => {
    const root = uniqueTmpRoot('upstream-ratchet');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kept.txt'), 'unchanged\n');
    fs.writeFileSync(path.join(root, 'edited.txt'), 'edited after the manifest was written\n');
    fs.writeFileSync(path.join(root, 'resurrected.txt'), 'the fork took this back\n');
    fs.symlinkSync('kept.txt', path.join(root, 'link'));

    const fixture = sealed({
      // Present and untouched since the manifest was written.
      'kept.txt': { diff: 3, mode: '100644', sha256: hashFile(path.join(root, 'kept.txt')) },
      // Hashed against different bytes than the tree now holds.
      'edited.txt': { diff: 3, mode: '100644', sha256: 'b'.repeat(64) },
      // Recorded as present, absent from the tree.
      'gone.txt': { diff: 7, mode: '100644', sha256: 'c'.repeat(64) },
      // Recorded as deleted, present in the tree.
      'resurrected.txt': { diff: 12, mode: '100644', sha256: null, deleted: true },
      // A symlink is hashed by its TARGET STRING, not the pointee.
      link: { diff: 0, mode: '120000', sha256: hashFile(path.join(root, 'link')) },
    });

    const findings = checkTree(fixture, root);
    expect(findings.map((f) => [f.kind, f.path])).toEqual([
      ['changed', 'edited.txt'],
      ['missing', 'gone.txt'],
      ['resurrected', 'resurrected.txt'],
    ]);
    // Every finding names the command that fixes it, so a fresh-context agent
    // reading only the failure output knows what to run.
    for (const finding of findings) expect(finding.hint).toContain('ratchet:report');

    // Hashing the link target rather than following the link: re-aiming the
    // symlink at identical content is still a change.
    fs.unlinkSync(path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'other.txt'), 'unchanged\n');
    fs.symlinkSync('other.txt', path.join(root, 'link'));
    expect(checkTree(fixture, root).map((f) => [f.kind, f.path])).toContainEqual(['changed', 'link']);

    // Manifest-level shape is checked too, not just per-entry state.
    const badPin = checkTree({ ...fixture, upstream: 'upstream/main' }, root);
    expect(badPin[0]).toMatchObject({ kind: 'malformed', path: MANIFEST_REL });
  });

  it('checkTree reports a chmod and a file-to-symlink transition', () => {
    const root = uniqueTmpRoot('upstream-ratchet-mode');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'tool.sh'), '#!/bin/sh\necho hi\n');
    fs.writeFileSync(path.join(root, 'note.md'), 'a note\n');
    fs.writeFileSync(path.join(root, 'target.md'), 'a note\n');

    const fixture = sealed({
      'tool.sh': { diff: 0, mode: '100644', sha256: hashFile(path.join(root, 'tool.sh')) },
      'note.md': { diff: 0, mode: '100644', sha256: hashFile(path.join(root, 'note.md')) },
    });
    expect(checkTree(fixture, root), 'the fixture starts clean').toEqual([]);

    // chmod +x — identical bytes, so `changed` never fires and numstat would be
    // empty. Only the mode check sees it.
    fs.chmodSync(path.join(root, 'tool.sh'), 0o755);
    const afterChmod = checkTree(fixture, root);
    expect(afterChmod.map((f) => [f.kind, f.path])).toEqual([['mode', 'tool.sh']]);
    expect(afterChmod[0].detail).toContain('expected 100644, got 100755');
    fs.chmodSync(path.join(root, 'tool.sh'), 0o644);

    // Regular file → symlink pointing at identical content. The bytes a reader
    // sees through the link are the same; the blob is not.
    fs.unlinkSync(path.join(root, 'note.md'));
    fs.symlinkSync('target.md', path.join(root, 'note.md'));
    const afterSwap = checkTree(fixture, root);
    expect(afterSwap.map((f) => f.kind).sort()).toEqual(['changed', 'mode']);
    expect(afterSwap.find((f) => f.kind === 'mode')?.detail).toContain('expected 100644, got 120000');

    // A path that is neither a regular file nor a symlink has no blob mode.
    fs.unlinkSync(path.join(root, 'note.md'));
    fs.mkdirSync(path.join(root, 'note.md'));
    expect(checkTree(fixture, root).find((f) => f.path === 'note.md')?.detail).toContain('no git blob mode');
  });

  it('an ignored upstream path present on disk produces no finding', () => {
    // `.claude/scheduled_tasks.lock` is upstream-tracked, deleted in this fork,
    // AND gitignored here — it is a RUNTIME LOCK FILE. On the production
    // checkout some process recreates it whenever the system is running, so a
    // presence check turns the host suite red on a file that is not source, and
    // the report refuses the whole tree as a shadow. Neither is a real finding.
    //
    // The divergence that IS real is the .gitignore rule, and that is already
    // counted: .gitignore is an upstream-owned file with its own entry, so
    // adding or removing the rule moves a diff there. So the manifest records
    // `ignored` and checks nothing else about the path.
    const root = uniqueTmpRoot('upstream-ratchet-ignored');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });

    const fixture = sealed({
      '.claude/scheduled_tasks.lock': { diff: 1, mode: '100644', sha256: null, deleted: true, ignored: true },
    });

    // Absent: no finding.
    expect(checkTree(fixture, root)).toEqual([]);

    // Present, with arbitrary runtime content: still no finding. Without the
    // flag this is exactly the `resurrected` red that would fire on every
    // production checkout with the system running.
    fs.writeFileSync(path.join(root, '.claude/scheduled_tasks.lock'), 'pid 4242\n');
    expect(checkTree(fixture, root)).toEqual([]);

    // A plain deleted entry at the same path DOES fire, so the exemption comes
    // from the flag and not from something else being lenient.
    const unflagged = sealed({
      '.claude/scheduled_tasks.lock': { diff: 1, mode: '100644', sha256: null, deleted: true },
    });
    expect(checkTree(unflagged, root).map((f) => f.kind)).toEqual(['resurrected']);

    // The flag is only ever `true`, and only ever alongside `deleted`:
    // check-ignore is index-aware and never reports a tracked path, so an
    // `ignored` entry without `deleted` could not have been generated — and it
    // would switch off the presence and hash checks for a file the tree owns.
    const notDeleted = sealed({
      'src/router.ts': { diff: 1, mode: '100644', sha256: 'a'.repeat(64), ignored: true },
    });
    expect(checkTree(notDeleted, root).find((f) => f.path === 'src/router.ts')?.detail).toContain(
      'must also be "deleted"',
    );
    const notTrue = sealed({
      'x.md': { diff: 1, mode: '100644', sha256: null, deleted: true, ignored: false as unknown as true },
    });
    expect(checkTree(notTrue, root).find((f) => f.path === 'x.md')?.detail).toContain(
      '"ignored" may only be present as true',
    );

    // And it round-trips through the serializer in a fixed position.
    expect(serializeManifest(fixture)).toContain(
      '".claude/scheduled_tasks.lock":{"diff":1,"mode":"100644","sha256":null,"deleted":true,"ignored":true}',
    );
  });

  it('checkTree rejects unusable manifest paths before touching the filesystem', () => {
    const root = uniqueTmpRoot('upstream-ratchet-paths');
    fs.mkdirSync(root, { recursive: true });

    // A manifest key is joined to the repo root and then lstat-ed and READ. The
    // hermeticity tripwire guards writes, not reads, so `../../.ssh/id_rsa` as a
    // key would quietly read outside the checkout. The manifest is generated, so
    // none of this fires unless somebody hand-edits it — which is exactly when
    // it is worth having.
    const cases: Array<[string, RegExp]> = [
      ['../../.ssh/id_rsa', /".." segment/],
      ['a/../../b', /".." segment/],
      ['/etc/passwd', /absolute/],
      ['C:/Windows/win.ini', /absolute/],
      ['a//b.md', /empty segment/],
      ['a/./b.md', /"\." or ".." segment/],
      ['a\\b.md', /backslash/],
      ['bad\0name.md', /NUL/],
      ['', /empty/],
    ];
    for (const [key, pattern] of cases) {
      const findings = checkTree(sealed({ [key]: { diff: 1, mode: '100644', sha256: 'e'.repeat(64) } }), root);
      const finding = findings.find((f) => f.path === key);
      expect(finding, `${JSON.stringify(key)} must be rejected`).toBeDefined();
      expect(finding?.kind).toBe('malformed');
      expect(finding?.detail, `${JSON.stringify(key)}: ${finding?.detail}`).toMatch(pattern);
    }

    // The same rule, at the unit level.
    expect(validateRelPath('src/host-sweep.ts', root)).toBeNull();
    expect(validateRelPath('.agents/skills', root)).toBeNull();
    expect(validateRelPath('a b/c d.md', root)).toBeNull();
    expect(validateRelPath('..', root)).not.toBeNull();
  });

  it('rejects a path whose ancestor directory symlinks out of the repository', () => {
    // `validateRelPath` is lexical and `path.resolve` never touches the disk, so
    // every traversal rule can pass while an ancestor DIRECTORY is a symlink
    // pointing anywhere. This checkout's own `node_modules` is exactly that
    // shape. Reads are not covered by the hermeticity tripwire, so nothing else
    // would notice.
    const root = uniqueTmpRoot('upstream-ratchet-escape');
    const outside = uniqueTmpRoot('upstream-ratchet-outside');
    fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(outside, 'nested/secret.md'), 'content outside the repository\n');
    fs.symlinkSync(outside, path.join(root, 'escape'));

    // The sha256 is the REAL hash of the out-of-tree file. Without the guard
    // checkTree reads it, the hash matches, and the entry passes clean — the
    // escape is silent. With the guard it never gets that far.
    const realHash = hashFile(path.join(outside, 'nested/secret.md'));
    expect(realHash, 'the fixture target really is readable').toMatch(/^[0-9a-f]{64}$/);

    const findings = checkTree(
      sealed({ 'escape/nested/secret.md': { diff: 2, mode: '100644', sha256: realHash } }),
      root,
    );
    expect(findings.map((f) => f.kind)).toEqual(['malformed']);
    expect(findings[0].detail).toContain('ancestor directory resolves outside the repository');

    // The unit rule, directly.
    expect(ancestorEscape('escape/nested/secret.md', root)).toContain('outside the repository');
    expect(ancestorEscape('escape/anything/at/all.md', root)).toContain('outside the repository');
    // A real path inside the root, and one whose ancestors do not exist yet, are
    // both fine — a segment that does not exist cannot be a symlink.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    expect(ancestorEscape('src/router.ts', root)).toBeNull();
    expect(ancestorEscape('not/created/yet.md', root)).toBeNull();
    // A symlink at the FINAL component is not followed: hashFile hashes the link
    // target string, which is what git stores, so this must stay allowed.
    fs.symlinkSync('router.ts', path.join(root, 'src/alias.ts'));
    expect(ancestorEscape('src/alias.ts', root)).toBeNull();
  });

  it('the manifest carries no unaudited headroom', () => {
    // HONEST LIMIT: this case cannot recompute a diff. It has no git, and the
    // CI clone has no upstream objects until the ratchet's CI step fetches them.
    // What it CAN close is every way an entry could carry a number nothing
    // stands behind — a diff with no hash to pin it to, a hash with no file, a
    // deletion that also claims content. Combined with case 2 (the hash still
    // matches the tree), the mode case above, and the coverage seal, an entry's
    // `diff` is then exactly the number the report script measured for exactly
    // these bytes at exactly this mode. The git-side proof that the number is
    // CORRECT lives in scripts/upstream-ratchet-report.ts and runs in CI.
    const violations: string[] = [];
    for (const [relPath, entry] of entries) {
      // A deleted path has no fork bytes; a present one always has some.
      if (entry.deleted === true && entry.sha256 !== null) violations.push(`${relPath}: deleted but carries a sha256`);
      if (entry.deleted !== true && entry.sha256 === null) violations.push(`${relPath}: present but sha256 is null`);
      // Deleted means the whole upstream file reads as removed — that is never
      // zero divergence, so a `deleted` entry claiming diff 0 is unaudited.
      if (entry.deleted === true && entry.diff === 0) violations.push(`${relPath}: deleted but claims diff 0`);
      // diff 0 means byte- AND mode-identical to upstream, which a differing
      // binary can never be.
      if (entry.diff === 0 && entry.binary === true) violations.push(`${relPath}: diff 0 but flagged binary`);
      // A binary path has no lines to count: one unit for the bytes, plus at
      // most one more for a differing mode.
      if (entry.binary === true && (entry.diff < 1 || entry.diff > 2)) {
        violations.push(`${relPath}: binary but diff is ${entry.diff}, not 1 or 2`);
      }
      // An ignored path is one git does not track, which this manifest records
      // as deleted; check-ignore never reports a tracked path, so the pair is
      // not a convention but a consequence. This assertion is load-bearing: the
      // `ignored` flag switches off the presence, mode and hash checks, and it
      // is only defensible while it really does mean "not fork source". See the
      // reasoning block at the top of src/upstream-ratchet.ts.
      if (entry.ignored === true && entry.deleted !== true) violations.push(`${relPath}: ignored but not deleted`);
      // Only `true` is ever written for the three optional flags — `false` would
      // read as an audited "no" that nothing produced.
      if ('deleted' in entry && entry.deleted !== true) violations.push(`${relPath}: "deleted" present but not true`);
      if ('ignored' in entry && entry.ignored !== true) violations.push(`${relPath}: "ignored" present but not true`);
      if ('binary' in entry && entry.binary !== true) violations.push(`${relPath}: "binary" present but not true`);
    }
    expect(violations, `regenerate the manifest: ${REGENERATE_HINT}`).toEqual([]);
  });

  it('printed commands survive a copy-paste for any valid path', () => {
    // `-z` parsing already handles a path with a space or a newline; the hint
    // that tells someone what to run has to as well, or the advertised command
    // splits into two arguments or is read as an option.
    expect(shellQuote('src/host-sweep.ts')).toBe('src/host-sweep.ts');
    expect(shellQuote('a file.md')).toBe("'a file.md'");
    expect(shellQuote("it's.md")).toBe(`'it'\\''s.md'`);
    expect(shellQuote('line\nbreak.md')).toBe("'line\nbreak.md'");
    expect(shellQuote('--not-a-flag.md')).toBe("'--not-a-flag.md'");
    expect(shellQuote('-dash.md')).toBe("'-dash.md'");
    expect(shellQuote('naïve.md')).toBe("'naïve.md'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a;rm -rf /.md')).toBe("'a;rm -rf /.md'");

    // And the hints really carry the quoted form.
    const root = uniqueTmpRoot('upstream-ratchet-quote');
    fs.mkdirSync(root, { recursive: true });
    const findings = checkTree(sealed({ 'a file.md': { diff: 4, mode: '100644', sha256: 'f'.repeat(64) } }), root);
    expect(findings[0].hint).toContain("--accept 'a file.md'");
  });

  it('the ratchet library never spawns a subprocess or reaches the network', () => {
    // src/upstream-ratchet.ts must stay fs + crypto only: the whole point of a
    // committed hash manifest is that the test half needs no git. The
    // child_process/network/fs-write tripwire in src/test-hermeticity.ts is
    // armed for every host suite and records each escape; every case above has
    // already run by now, so an empty record is the proof.
    expect(hermeticityAttempts().map((a) => `${a.kind} ${a.api}(${a.target})`)).toEqual([]);
  });
});
