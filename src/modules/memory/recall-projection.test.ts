import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { GENERATED_MEMORY_RELATIVE_PATH } from './curator-contract.js';
import {
  _resetTokenStreamCacheForTest,
  _tokenStreamCacheStatsForTest,
  passageWindows,
  PRE_TURN_BOUNDS,
  tokenizeForRecall,
  tokenStreamForRecall,
} from './pre-turn-context.js';
import { runProjectionBuild } from './recall-projection-build.js';
import {
  buildAndPromoteProjection,
  buildProjectionCandidates,
  hydrateLane,
  LANE_EXCERPT_CHARS,
  openRecallProjection,
  projectionPath,
  RECALL_PROJECTION_SCHEMA_VERSION,
  readProjectionSummary,
  termsOf,
  windowsEqual,
  writeProjection,
  type ProjectionCandidate,
} from './recall-projection.js';

const temporaryDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recall-projection-${prefix}-`));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

function writeFile(root: string, relative: string, content: string | Buffer): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function factLine(text: string, id: string, capturedAt: string): string {
  return `- ${text} <!-- nanoclaw-memory:id=${id};evidence=msg_1;captured=${capturedAt} -->`;
}

/** Minimal tree: two ranked files, one skipped core file, a two-fact ledger. */
function smallTree(): string {
  const root = scratch('tree');
  writeFile(root, 'index.md', '# Core\n\nCore index, excluded from the ranked scan.\n');
  writeFile(root, 'system/definition.md', '# Definition\n\nNon-recall path.\n');
  writeFile(root, 'preferences/sender-one.md', '# Sender One\n\nPreference lane, excluded from the ranked scan.\n');
  writeFile(root, 'concepts/routing.md', '# Routing\n\nThe router hands a message to the delivery seam.\n');
  writeFile(root, 'domain/ledgers.md', '# Ledgers\n\nA ledger accumulates facts the curator appends.\n');
  writeFile(
    root,
    GENERATED_MEMORY_RELATIVE_PATH,
    [
      '# Generated workgroup memory',
      '',
      factLine('The delivery seam retries transient overload.', 'mem_00000000000000a1', '2026-08-01T00:00:00.000Z'),
      factLine('Curator rewrites append only.', 'mem_00000000000000b2', '2026-13-45T99:99:99Z'),
      '',
    ].join('\n'),
  );
  return root;
}

function built(root: string): { directory: string; live: string } {
  const directory = scratch('proj');
  buildAndPromoteProjection({ root, directory });
  return { directory, live: path.join(directory, 'index.db') };
}

describe('recall projection schema and build', () => {
  it('round-trips a built store: lanes, per-lane scan order, and the skipped-path exclusions', () => {
    const root = smallTree();
    const { live } = built(root);

    const db = openRecallProjection(live);
    expect(db).not.toBeNull();
    const files = hydrateLane(db!, 'file');
    const facts = hydrateLane(db!, 'fact');

    // The ranked scan skips CORE_PATHS, NON_RECALL_PATHS and preferences/.
    expect(files.map((row) => row.path)).toEqual(['concepts/routing.md', 'domain/ledgers.md']);
    // scan_order is 0-based PER LANE, not a shared build-time counter.
    expect(files.map((row) => row.scanOrder)).toEqual([0, 1]);
    expect(facts.map((row) => row.scanOrder)).toEqual([0, 1]);
    expect(facts.map((row) => row.factId)).toEqual(['mem_00000000000000a1', 'mem_00000000000000b2']);
    expect(files.every((row) => row.factId === null)).toBe(true);

    // source_file carries every listed path, including the ones the scan skipped.
    const sourcePaths = (db!.prepare('SELECT path FROM source_file ORDER BY path').all() as { path: string }[]).map(
      (row) => row.path,
    );
    expect(sourcePaths).toEqual([
      'concepts/routing.md',
      'domain/ledgers.md',
      GENERATED_MEMORY_RELATIVE_PATH,
      'index.md',
      'preferences/sender-one.md',
      'system/definition.md',
    ]);

    const summary = readProjectionSummary(db!);
    expect(summary.schemaVersion).toBe(String(RECALL_PROJECTION_SCHEMA_VERSION));
    expect(summary.markdownScannedBytes).toBe(PRE_TURN_BOUNDS.markdownScannedBytes);
    expect(summary.scannedBytes).toBeGreaterThan(0);
    db!.close();
  });

  it('hydrates candidates identical to the in-memory build, in scan order', () => {
    const root = smallTree();
    const { live } = built(root);
    const inMemory = buildProjectionCandidates(root).candidates;

    const db = openRecallProjection(live)!;
    const hydrated = [...hydrateLane(db, 'file'), ...hydrateLane(db, 'fact')];
    db.close();

    expect(hydrated).toEqual(inMemory);
  });

  it('reproduces the fact lane ONE shared headings array, headingsOf truncation included', () => {
    const root = scratch('headings');
    const longHeading = 'H'.repeat(400);
    const ledger = [
      '# Generated workgroup memory',
      // 30 headings > markdownHeadings (24), the FIRST of them longer than
      // markdownHeadingChars (240), so both clamps are exercised at once.
      `## ${longHeading}`,
      ...Array.from({ length: 29 }, (_, index) => `## heading ${index}`),
      '',
      factLine('First fact.', 'mem_0000000000000001', '2026-08-01T00:00:00Z'),
      factLine('Second fact.', 'mem_0000000000000002', '2026-08-02T00:00:00Z'),
      factLine('Third fact.', 'mem_0000000000000003', '2026-08-03T00:00:00Z'),
      '',
    ].join('\n');
    writeFile(root, GENERATED_MEMORY_RELATIVE_PATH, ledger);
    const { live } = built(root);

    const db = openRecallProjection(live)!;
    const facts = hydrateLane(db, 'fact');
    db.close();

    expect(facts).toHaveLength(3);
    // ONE array instance shared by reference across every fact from the ledger.
    expect(facts[0]!.headings).toBe(facts[1]!.headings);
    expect(facts[1]!.headings).toBe(facts[2]!.headings);
    // headingsOf's truncation is reproduced, not corrected: 24 entries, and the
    // long one clipped to markdownHeadingChars with the truncation marker.
    expect(facts[0]!.headings).toHaveLength(PRE_TURN_BOUNDS.markdownHeadings);
    expect(facts[0]!.headings[0]).toBe('Generated workgroup memory');
    expect(facts[0]!.headings.at(-1)).toBe('heading 21');
    const clipped = 'H'.repeat(PRE_TURN_BOUNDS.markdownHeadingChars - '[truncated:heading]'.length);
    expect(facts[0]!.headings[1]).toBe(`${clipped}[truncated:heading]`);
  });

  it('stores capturedAt as a raw unparsed string', () => {
    const root = smallTree();
    const { live } = built(root);
    const db = openRecallProjection(live)!;
    const facts = hydrateLane(db, 'fact');
    db.close();

    // The second fact carries a stamp no date parser accepts. Storing it
    // verbatim is what keeps byRecency's codepoint tie-break identical.
    expect(facts.map((row) => row.capturedAt)).toEqual(['2026-08-01T00:00:00.000Z', '2026-13-45T99:99:99Z']);
    expect(Number.isNaN(Date.parse(facts[1]!.capturedAt))).toBe(true);
  });

  it('P2.5-AC4: persisted token stream and passage windows are byte-identical to a live call', () => {
    const root = smallTree();
    const { live } = built(root);
    const db = openRecallProjection(live)!;
    const hydrated = [...hydrateLane(db, 'file'), ...hydrateLane(db, 'fact')];
    db.close();

    expect(hydrated.length).toBeGreaterThan(0);
    for (const candidate of hydrated) {
      expect(candidate.tokens).toEqual(tokenizeForRecall(candidate.searchable));
      const fresh = passageWindows(candidate.searchable, LANE_EXCERPT_CHARS[candidate.lane]).map((window) => ({
        text: window.text,
        tokens: [...window.tokens],
      }));
      expect(candidate.windows).toEqual(fresh);
    }
  });

  it('P2.5-AC5: NUL bytes and malformed UTF-8 survive the round trip byte-identically', () => {
    const root = scratch('adversarial');
    // Raw bytes: an embedded NUL, then a lone 0xFF/0xFE pair that is not valid
    // UTF-8. `readBoundedFile` decodes with toString('utf8'), so the candidate
    // text the live path sees already holds U+0000 and U+FFFD — the projection
    // must carry both through SQLite TEXT unchanged.
    const raw = Buffer.concat([
      Buffer.from('# Adversarial\n\nbefore', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('after', 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(' tail nulcarrier\n', 'utf8'),
    ]);
    writeFile(root, 'concepts/adversarial.md', raw);
    const inMemory = buildProjectionCandidates(root).candidates;
    expect(inMemory).toHaveLength(1);
    const source = inMemory[0]!;
    expect(source.content).toContain('\u0000');
    expect(source.content).toContain('�');

    const { live } = built(root);
    const db = openRecallProjection(live)!;
    const hydrated = hydrateLane(db, 'file');
    db.close();

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]!.content).toBe(source.content);
    expect(hydrated[0]!.searchable).toBe(source.searchable);
    expect(hydrated[0]!.tokens).toEqual(source.tokens);
    expect(hydrated[0]!.windows).toEqual(source.windows);
    // And the persisted stream still agrees with a fresh tokenization.
    expect(hydrated[0]!.tokens).toEqual(tokenizeForRecall(hydrated[0]!.searchable));
  });

  it('unions window-only tokens from a non-sliceable candidate into the term set (decision 8)', () => {
    const root = scratch('chopped');
    // One sentence long enough that sentenceSpans hard-chops it at maxChars,
    // with the cut landing inside a word so the fallback tokenization mints a
    // fragment the whole-candidate stream never produces.
    const relative = 'concepts/chopped.md';
    // sentenceSpans chunks a too-long sentence in maxChars steps measured from
    // THAT SENTENCE's start, so the hard chop lands at content index maxChars,
    // not at maxChars minus the `path\nheadings\n` prefix. Straddle it with a
    // word whose two halves canonicalize to tokens the whole-candidate stream
    // never produces.
    const filler = 'alpha '.repeat(400);
    const content = `${filler.slice(0, LANE_EXCERPT_CHARS.file - 4)}zebracrossing ${filler}`;
    writeFile(root, relative, content);

    const candidates = buildProjectionCandidates(root).candidates;
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;

    const whole = new Set(tokenizeForRecall(candidate.searchable));
    const windowOnly = termsOf(candidate).filter((token) => !whole.has(token));
    // The precondition is asserted, not assumed: if the fixture stopped
    // producing a chopped fragment this test fails instead of passing vacuously.
    expect(windowOnly.length).toBeGreaterThan(0);

    const { live } = built(root);
    const db = openRecallProjection(live)!;
    const indexed = (
      db.prepare('SELECT token FROM term ORDER BY token').all() as {
        token: string;
      }[]
    ).map((row) => row.token);
    db.close();
    for (const token of windowOnly) expect(indexed).toContain(token);
  });

  it('reconstructs every window byte-identically from stored offsets', () => {
    const root = smallTree();
    const result = buildAndPromoteProjection({ root, directory: scratch('offsets') });
    // Everything in this tree is offset-sliceable, so nothing takes the escape hatch.
    expect(result.windowsStoredWhole).toBe(0);

    const db = openRecallProjection(result.path)!;
    const hydrated = [...hydrateLane(db, 'file'), ...hydrateLane(db, 'fact')];
    // Windows really are stored as offsets, not as the literal shape.
    const encodings = (db.prepare('SELECT DISTINCT windows_encoded AS e FROM candidate').all() as { e: number }[]).map(
      (row) => row.e,
    );
    db.close();
    expect(encodings).toEqual([1]);

    expect(hydrated.length).toBeGreaterThan(0);
    for (const candidate of hydrated) {
      const fresh = passageWindows(candidate.searchable, LANE_EXCERPT_CHARS[candidate.lane]).map((window) => ({
        text: window.text,
        tokens: [...window.tokens],
      }));
      // Deep equality over value, start, end AND window ordering.
      expect(windowsEqual(candidate.windows, fresh)).toBe(true);
      expect(candidate.windows).toEqual(fresh);
      expect(candidate.stream).toEqual([...tokenStreamForRecall(candidate.searchable)]);
    }
  });

  it('falls back to storing whole windows when the offset form cannot be proven exact', () => {
    const root = scratch('fallback');
    // The non-sliceable candidate from the decision-8 fixture: its windows are
    // re-tokenized independently, so their token offsets index the WINDOW and
    // the offset form cannot reproduce them.
    const filler = 'alpha '.repeat(400);
    writeFile(root, 'concepts/chopped.md', `${filler.slice(0, LANE_EXCERPT_CHARS.file - 4)}zebracrossing ${filler}`);
    writeFile(root, 'concepts/plain.md', '# Plain\n\nA short, offset-sliceable candidate.\n');
    const result = buildAndPromoteProjection({ root, directory: scratch('fallback-proj') });

    // The escape hatch fired for exactly the chopped candidate.
    expect(result.windowsStoredWhole).toBe(1);

    const db = openRecallProjection(result.path)!;
    const rows = db.prepare('SELECT path, windows_encoded AS e FROM candidate ORDER BY path').all() as {
      path: string;
      e: number;
    }[];
    const hydrated = hydrateLane(db, 'file');
    db.close();
    expect(rows).toEqual([
      { path: 'concepts/chopped.md', e: 0 },
      { path: 'concepts/plain.md', e: 1 },
    ]);

    // Byte-identity holds on BOTH paths — the fallback is not an approximation.
    for (const candidate of hydrated) {
      const fresh = passageWindows(candidate.searchable, LANE_EXCERPT_CHARS[candidate.lane]).map((window) => ({
        text: window.text,
        tokens: [...window.tokens],
      }));
      expect(windowsEqual(candidate.windows, fresh)).toBe(true);
    }
  });

  it('rejects a projection whose schema_version does not match', () => {
    const root = smallTree();
    const { live } = built(root);
    expect(openRecallProjection(live)).not.toBeNull();

    const writable = new Database(live);
    writable.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run('999');
    writable.close();

    // A mismatch is a rebuild trigger, not a thrown error (decision 14).
    expect(openRecallProjection(live)).toBeNull();
  });

  it('treats a missing or unopenable projection as absent rather than throwing', () => {
    const directory = scratch('absent');
    expect(openRecallProjection(path.join(directory, 'index.db'))).toBeNull();
    fs.writeFileSync(path.join(directory, 'index.db'), 'not a database at all');
    expect(openRecallProjection(path.join(directory, 'index.db'))).toBeNull();
  });

  it('resolves the per-workgroup projection path outside the authoritative memory tree', () => {
    expect(projectionPath('wg-1', '/data')).toBe('/data/memory-recall/workgroups/wg-1/index.db');
  });
});

describe('recall projection promote protocol (P2.5-AC8)', () => {
  it('leaves the previous index.db untouched and servable when a rebuild fails before the rename', () => {
    const root = smallTree();
    const { directory, live } = built(root);
    const before = fs.readFileSync(live);
    const beforeCandidates = hydrateLane(openRecallProjection(live)!, 'file').length;

    // Kill the rebuild at its earliest failure point: the tree it reads is gone.
    fs.rmSync(root, { recursive: true, force: true });
    expect(() => buildAndPromoteProjection({ root, directory })).toThrow(/canonical memory tree missing/);

    expect(fs.readFileSync(live).equals(before)).toBe(true);
    const db = openRecallProjection(live);
    expect(db).not.toBeNull();
    expect(hydrateLane(db!, 'file')).toHaveLength(beforeCandidates);
    db!.close();
  });

  it('leaves the previous index.db untouched when the side-file write dies mid-transaction', () => {
    const root = smallTree();
    const { directory, live } = built(root);
    const before = fs.readFileSync(live);

    // A duplicate (lane, scan_order) trips the unique index partway through the
    // finalizing transaction — a stand-in for any mid-write death.
    const set = buildProjectionCandidates(root);
    const clash: ProjectionCandidate = { ...set.candidates[0]!, scanOrder: set.candidates[0]!.scanOrder };
    const nextPath = path.join(directory, 'index.next-killed.db');
    expect(() => writeProjection(nextPath, { ...set, candidates: [...set.candidates, clash] })).toThrow();

    expect(fs.readFileSync(live).equals(before)).toBe(true);
    expect(openRecallProjection(live)).not.toBeNull();
    // The half-written side file has no completeness marker, so it is absent.
    expect(openRecallProjection(nextPath)).toBeNull();
  });

  it('treats a file renamed into place before its marker committed as absent, not partial', () => {
    const root = smallTree();
    const { directory, live } = built(root);

    // Reproduce "killed after rename, before the marker's transaction commits":
    // a structurally valid database whose meta lacks `complete`.
    const markerless = path.join(directory, 'index.next-markerless.db');
    const db = new Database(markerless);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE candidate (id INTEGER)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(RECALL_PROJECTION_SCHEMA_VERSION),
    );
    db.close();
    fs.renameSync(markerless, live);

    expect(openRecallProjection(live)).toBeNull();
  });

  it('promotes a rebuild by renaming a side file over index.db, not by writing in place', () => {
    const root = smallTree();
    const { directory, live } = built(root);
    const beforeIno = fs.statSync(live).ino;
    expect(hydrateLane(openRecallProjection(live)!, 'file')).toHaveLength(2);

    writeFile(root, 'concepts/added.md', '# Added\n\nA file the first build never saw.\n');
    buildAndPromoteProjection({ root, directory });

    // A different inode is the observable signature of promote-by-rename: an
    // in-place rebuild would keep the same file (decision 12).
    expect(fs.statSync(live).ino).not.toBe(beforeIno);
    const db = openRecallProjection(live);
    expect(db).not.toBeNull();
    expect(hydrateLane(db!, 'file').map((row) => row.path)).toEqual([
      'concepts/added.md',
      'concepts/routing.md',
      'domain/ledgers.md',
    ]);
    db!.close();
    expect(fs.readdirSync(directory).filter((entry) => entry.startsWith('index.next-'))).toEqual([]);
  });

  it('sweeps orphaned index.next-* side files left by a killed build', () => {
    const root = smallTree();
    const { directory } = built(root);
    fs.writeFileSync(path.join(directory, 'index.next-orphan.db'), 'partial');

    buildAndPromoteProjection({ root, directory });

    expect(fs.readdirSync(directory).filter((entry) => entry.startsWith('index.next-'))).toEqual([]);
  });
});

describe('recall projection worker-thread build', () => {
  it('runs the build off the caller event loop and promotes a servable index', async () => {
    const root = smallTree();
    const directory = scratch('worker');
    _resetTokenStreamCacheForTest();

    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    let result;
    try {
      result = await runProjectionBuild({ root, directory });
    } finally {
      clearInterval(timer);
    }

    expect(result.path).toBe(path.join(directory, 'index.db'));
    expect(result.fileCandidates).toBe(2);
    expect(result.factCandidates).toBe(2);
    expect(result.termRows).toBeGreaterThan(0);
    expect(result.bytes).toBeGreaterThan(0);

    // The caller's event loop kept turning while the build ran.
    expect(ticks).toBeGreaterThan(0);
    // Stronger, and not timing-dependent: tokenization populates the
    // process-wide TOKEN_STREAM_CACHE. The caller's copy is still untouched, so
    // the build cannot have run in this thread.
    expect(_tokenStreamCacheStatsForTest().size).toBe(0);

    const db = openRecallProjection(result.path);
    expect(db).not.toBeNull();
    expect(hydrateLane(db!, 'fact')).toHaveLength(2);
    db!.close();
  }, 30_000);

  it('rejects rather than throwing on the caller when the build fails in the worker', async () => {
    const directory = scratch('worker-fail');
    await expect(runProjectionBuild({ root: path.join(directory, 'nope'), directory })).rejects.toThrow(
      /canonical memory tree missing/,
    );
  }, 30_000);
});
