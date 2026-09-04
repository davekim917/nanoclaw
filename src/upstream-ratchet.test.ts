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
 * is CURRENT — every upstream-owned file still hashes to what it hashed when its
 * `diff` was measured, and every entry is internally well formed. They cannot
 * prove a `diff` value is the true line count; only `scripts/upstream-ratchet-report.ts`,
 * which has git, can do that, and it is the piece that arbitrates GROWTH vs SHRINK.
 * See docs/upstream-ratchet.md.
 */
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { enforceHermeticity, hermeticityAttempts } from './test-hermeticity.js';
import {
  checkTree,
  formatFindings,
  hashFile,
  readManifest,
  REGENERATE_HINT,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const manifest: UpstreamRatchetManifest = readManifest(REPO_ROOT);
const entries = Object.entries(manifest.files);

// This suite touches nothing outside the checkout and a temp fixture, so it is
// held to the strict guard rather than the repo's `warn` default.
beforeAll(() => enforceHermeticity());

describe('upstream-ownership ratchet', () => {
  it('manifest pins one upstream commit and covers every entry with a well-formed diff and hash', () => {
    expect(manifest.upstream, 'the pinned upstream commit must be a full 40-character sha').toMatch(/^[0-9a-f]{40}$/);
    expect(entries.length, 'the manifest must cover the whole upstream tree').toBeGreaterThan(0);

    const malformed = entries.filter(([, entry]) => {
      const diffOk = Number.isInteger(entry.diff) && entry.diff >= 0;
      const hashOk = entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256);
      return !diffOk || !hashOk;
    });
    expect(
      malformed.map(([p]) => p),
      'every entry needs a non-negative integer diff and a sha256 or null',
    ).toEqual([]);

    // Sorted by path, so a regeneration is a readable diff rather than a reshuffle.
    expect(Object.keys(manifest.files)).toEqual([...Object.keys(manifest.files)].sort());
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
      if (entry.deleted === true && present) resurrected.push(relPath);
      if (entry.deleted !== true && !present) missing.push(relPath);
    }
    expect(
      resurrected,
      `re-adopting a deleted upstream file is new divergence — ${REGENERATE_HINT} --accept <path>`,
    ).toEqual([]);
    expect(missing, `deleting an upstream file is new divergence — ${REGENERATE_HINT} --accept <path>`).toEqual([]);
  });

  it('checkTree reports changed, missing, resurrected against a fixture tree', () => {
    const root = uniqueTmpRoot('upstream-ratchet');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kept.txt'), 'unchanged\n');
    fs.writeFileSync(path.join(root, 'edited.txt'), 'edited after the manifest was written\n');
    fs.writeFileSync(path.join(root, 'resurrected.txt'), 'the fork took this back\n');
    fs.symlinkSync('kept.txt', path.join(root, 'link'));

    const fixture: UpstreamRatchetManifest = {
      upstream: 'a'.repeat(40),
      files: {
        // Present and untouched since the manifest was written.
        'kept.txt': { diff: 3, sha256: hashFile(path.join(root, 'kept.txt')) },
        // Hashed against different bytes than the tree now holds.
        'edited.txt': { diff: 3, sha256: 'b'.repeat(64) },
        // Recorded as present, absent from the tree.
        'gone.txt': { diff: 7, sha256: 'c'.repeat(64) },
        // Recorded as deleted, present in the tree.
        'resurrected.txt': { diff: 12, sha256: null, deleted: true },
        // A symlink is hashed by its TARGET STRING, not the pointee.
        link: { diff: 0, sha256: hashFile(path.join(root, 'link')) },
      },
    };

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
    expect(badPin[0]).toMatchObject({ kind: 'malformed', path: 'src/upstream-ratchet.json' });
  });

  it('the manifest carries no unaudited headroom', () => {
    // HONEST LIMIT: this case cannot recompute a diff. It has no git, and the
    // CI clone has no upstream objects. What it CAN close is every way an entry
    // could carry a number nothing stands behind — a diff with no hash to pin it
    // to, a hash with no file, a deletion that also claims content. Combined
    // with case 2 (the hash still matches the tree), an entry's `diff` is then
    // exactly the number the report script measured for exactly these bytes.
    // The git-side proof that the number is CORRECT lives in
    // scripts/upstream-ratchet-report.ts; running it is the definition of done
    // for a PR that touches an upstream-owned file.
    const violations: string[] = [];
    for (const [relPath, entry] of entries) {
      // A deleted path has no fork bytes; a present one always has some.
      if (entry.deleted === true && entry.sha256 !== null) violations.push(`${relPath}: deleted but carries a sha256`);
      if (entry.deleted !== true && entry.sha256 === null) violations.push(`${relPath}: present but sha256 is null`);
      // Deleted means the whole upstream file reads as removed — that is never
      // zero divergence, so a `deleted` entry claiming diff 0 is unaudited.
      if (entry.deleted === true && entry.diff === 0) violations.push(`${relPath}: deleted but claims diff 0`);
      // diff 0 means byte-identical to upstream, which a deleted or a differing
      // binary path can never be.
      if (entry.diff === 0 && entry.binary === true) violations.push(`${relPath}: diff 0 but flagged binary`);
      // A binary path has no lines to count; the report records one unit.
      if (entry.binary === true && entry.diff !== 1) violations.push(`${relPath}: binary but diff is not 1`);
      // Only `true` is ever written for the two optional flags — `false` would
      // read as an audited "no" that nothing produced.
      if ('deleted' in entry && entry.deleted !== true) violations.push(`${relPath}: "deleted" present but not true`);
      if ('binary' in entry && entry.binary !== true) violations.push(`${relPath}: "binary" present but not true`);
    }
    expect(violations, `regenerate the manifest: ${REGENERATE_HINT}`).toEqual([]);
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
