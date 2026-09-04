/**
 * #315 regression suite for the archive projection.
 *
 * The projection used to be rebuilt synchronously on the host's main thread on
 * every container spawn, which is what parked the event loop for a p50 of 18 s.
 * These tests hold three properties: the contents a session sees are unchanged,
 * an unchanged source is not rebuilt, and a rebuild that fails still aborts the
 * spawn.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowWritesTo, clearHermeticityAttempts, enforceHermeticity } from '../test-hermeticity.js';
import {
  __setArchiveProjectionWorkerFactoryForTest,
  ensureArchiveProjection,
  stopArchiveProjectionWorker,
} from './archive-projection-worker.js';
import {
  archiveProjectionIsFresh,
  archiveProjectionStampPath,
  buildArchiveProjection,
  computeArchiveProjectionStamp,
  materializeArchiveProjection,
  readArchiveProjectionStamp,
  removeArchiveProjectionStamp,
} from './per-agent-projections.js';
import { ARCHIVE_MUTATION_MARKS_SQL } from '../message-archive.js';

// The stamp path (per-agent-projections.js) is always `DATA_DIR/projection-
// stamps/<digest>.json`, regardless of where the projection db itself lives —
// so without this mock every test that writes a real stamp lands in the
// checkout's own `data/projection-stamps/`, which on a live install is
// production session state (issue #305).
const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('archive-projection-worker') }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

enforceHermeticity();

const tmpFiles: string[] = [];

function tmpPath(label: string): string {
  const p = path.join(os.tmpdir(), `ncproj-w-${label}-${process.pid}-${Date.now()}-${Math.random()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(async () => {
  __setArchiveProjectionWorkerFactoryForTest(null);
  await stopArchiveProjectionWorker();
  __setArchiveProjectionWorkerFactoryForTest(null);
  for (const file of tmpFiles) {
    for (const candidate of [file, archiveProjectionStampPath(file)]) {
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* ignore */
      }
    }
  }
  tmpFiles.length = 0;
});

interface Msg {
  id: string;
  agent_group_id: string;
  role: string;
  sender_id: string;
  text: string;
  sent_at: string;
  thread_id?: string;
  messaging_group_id?: string;
}

/**
 * Two workgroups, each with two sibling agents, with a duplicated user message
 * inside each workgroup so the dedup GROUP BY actually does work.
 */
function makeTwoWorkgroupSource(label: string): string {
  const file = tmpPath(label);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      channel_name        TEXT
    );
    CREATE INDEX idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
  `);
  // The mutation counters the freshness stamp reads, taken from the writer that
  // owns them so the fixture cannot drift from what `initSchema` creates.
  db.exec(ARCHIVE_MUTATION_MARKS_SQL);
  const insert = db.prepare(
    `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, platform_id, thread_id,
        role, sender_id, sender_name, text, sent_at, created_at, channel_name)
     VALUES (?, ?, ?, 'slack', 'p1', ?, ?, ?, 'Someone', ?, ?, '2026-01-01T00:00:00Z', 'general')`,
  );
  const rows: Msg[] = [
    // Workgroup ONE — the same user message archived against both siblings.
    {
      id: 'w1-u-a',
      agent_group_id: 'ag-one-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'shared question',
      sent_at: '2026-01-01T10:00:00Z',
    },
    {
      id: 'w1-u-b',
      agent_group_id: 'ag-one-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'shared question',
      sent_at: '2026-01-01T10:00:00Z',
    },
    {
      id: 'w1-a-a',
      agent_group_id: 'ag-one-a',
      role: 'assistant',
      sender_id: 'ag-one-a',
      text: 'answer from a',
      sent_at: '2026-01-01T10:01:00Z',
    },
    {
      id: 'w1-a-b',
      agent_group_id: 'ag-one-b',
      role: 'assistant',
      sender_id: 'ag-one-b',
      text: 'answer from b',
      sent_at: '2026-01-01T10:01:00Z',
    },
    // Workgroup TWO — must never appear in workgroup one's projection.
    {
      id: 'w2-u-a',
      agent_group_id: 'ag-two-a',
      role: 'user',
      sender_id: 'u-9',
      text: 'other tenant secret',
      sent_at: '2026-01-01T11:00:00Z',
    },
    {
      id: 'w2-a-a',
      agent_group_id: 'ag-two-a',
      role: 'assistant',
      sender_id: 'ag-two-a',
      text: 'other tenant reply',
      sent_at: '2026-01-01T11:01:00Z',
    },
  ];
  for (const row of rows) {
    insert.run(
      row.id,
      row.agent_group_id,
      row.messaging_group_id ?? 'mg-1',
      row.thread_id ?? 'thread-1',
      row.role,
      row.sender_id,
      row.text,
      row.sent_at,
    );
  }
  db.close();
  return file;
}

/** Archive one more message against `agentGroupId`, as the host's writer would. */
function archiveInto(file: string, row: Msg): void {
  const db = new Database(file);
  try {
    db.prepare(
      `INSERT INTO messages_archive
         (id, agent_group_id, messaging_group_id, channel_type, platform_id, thread_id,
          role, sender_id, sender_name, text, sent_at, created_at, channel_name)
       VALUES (?, ?, ?, 'slack', 'p1', ?, ?, ?, 'Someone', ?, ?, '2026-01-01T00:00:00Z', 'general')`,
    ).run(
      row.id,
      row.agent_group_id,
      row.messaging_group_id ?? 'mg-1',
      row.thread_id ?? 'thread-1',
      row.role,
      row.sender_id,
      row.text,
      row.sent_at,
    );
  } finally {
    db.close();
  }
}

function allRows(file: string): Array<Record<string, unknown>> {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT * FROM messages_archive ORDER BY id').all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function tableNames(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

/**
 * Stands in for the worker thread: same request/response protocol, same
 * builder, but in process so the suite stays fast and deterministic.
 */
class FakeWorker extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = [];
  readonly terminate = vi.fn(async () => 0);
  constructor(private readonly behavior: 'build' | 'fail' | 'partial' = 'build') {
    super();
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    queueMicrotask(() => {
      // Both failure behaviors drop the stamp first, mirroring
      // `materializeArchiveProjection`: it invalidates before it writes, so a
      // build that dies never leaves a stamp claiming the file is current.
      if (this.behavior === 'fail') {
        removeArchiveProjectionStamp(message.dstPath as string);
        this.emit('message', { id: message.id, ok: false, error: 'source is corrupt' });
        return;
      }
      if (this.behavior === 'partial') {
        // What a build that dies after writing the schema leaves behind: a
        // non-empty file with no rows in it.
        removeArchiveProjectionStamp(message.dstPath as string);
        fs.writeFileSync(message.dstPath as string, 'SQLite format 3\u0000partial');
        this.emit('message', { id: message.id, ok: false, error: 'disk went away mid-build' });
        return;
      }
      try {
        const result = materializeArchiveProjection(
          message.srcPath as string,
          message.dstPath as string,
          message.agentGroupId as string,
          message.workgroupMemberIds as string[] | undefined,
        );
        this.emit('message', { id: message.id, ok: true, ...result });
      } catch (error) {
        this.emit('message', { id: message.id, ok: false, error: (error as Error).message });
      }
    });
  }
}

function useFakeWorker(behavior: 'build' | 'fail' | 'partial' = 'build'): FakeWorker {
  const worker = new FakeWorker(behavior);
  __setArchiveProjectionWorkerFactoryForTest(() => worker as never);
  return worker;
}

describe('#315 — what the session sees is unchanged', () => {
  it('produces byte-identical contents to the synchronous builder, for both workgroups', async () => {
    const src = makeTwoWorkgroupSource('identical');
    const groups: Array<{ agent: string; scope: string[] }> = [
      { agent: 'ag-one-a', scope: ['ag-one-a', 'ag-one-b'] },
      { agent: 'ag-two-a', scope: ['ag-two-a', 'ag-two-b'] },
    ];

    for (const { agent, scope } of groups) {
      const expected = tmpPath(`expected-${agent}`);
      buildArchiveProjection(src, expected, agent, scope);

      useFakeWorker();
      const actual = tmpPath(`actual-${agent}`);
      await ensureArchiveProjection(src, actual, agent, scope);

      expect(allRows(actual)).toEqual(allRows(expected));
      expect(tableNames(actual)).toEqual(tableNames(expected));
    }
  });

  it('keeps the other workgroup out of the projection', async () => {
    const src = makeTwoWorkgroupSource('isolation');
    useFakeWorker();
    const dst = tmpPath('isolation-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    const texts = allRows(dst).map((row) => row.text);
    expect(texts).toContain('shared question');
    expect(texts).not.toContain('other tenant secret');
    expect(texts).not.toContain('other tenant reply');
    // The duplicate user message still collapses to one row.
    expect(texts.filter((text) => text === 'shared question')).toHaveLength(1);
  });

  it('adds no bookkeeping table to the file the container mounts', async () => {
    const src = makeTwoWorkgroupSource('no-meta');
    useFakeWorker();
    const dst = tmpPath('no-meta-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    // The stamp is a sidecar, never a row or a table inside the mounted file.
    expect(tableNames(dst).filter((name) => name.includes('stamp') || name.includes('meta'))).toEqual([]);
    expect(fs.existsSync(archiveProjectionStampPath(dst))).toBe(true);
    expect(archiveProjectionStampPath(dst)).not.toBe(dst);
  });
});

describe('#315 — an unchanged source is not rebuilt', () => {
  /**
   * Since #360 the reuse/append/rebuild decision is made ON the worker, so
   * every call reaches it and `worker.posted.length` no longer distinguishes a
   * reuse from a rebuild. These cases assert the returned `mode` instead, which
   * is the thing that was actually being claimed all along.
   */
  it('skips the second build when nothing moved', async () => {
    const src = makeTwoWorkgroupSource('reuse');
    useFakeWorker();
    const dst = tmpPath('reuse-dst');

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    const mtime = fs.statSync(dst).mtimeMs;

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('reused');
    expect(fs.statSync(dst).mtimeMs).toBe(mtime);
  });

  it('ignores the order the workgroup members arrive in', async () => {
    const src = makeTwoWorkgroupSource('order');
    useFakeWorker();
    const dst = tmpPath('order-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-b', 'ag-one-a'])).mode).toBe('reused');
  });

  it('rebuilds when a projected row is edited in place', async () => {
    const src = makeTwoWorkgroupSource('changed');
    useFakeWorker();
    const dst = tmpPath('changed-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    // An EDIT, not an append. `messages_archive` is upserted with
    // `ON CONFLICT(id) DO UPDATE SET text = ...`, so this moves neither the row
    // count nor MAX(rowid), and an append would carry the stale text past the
    // container forever. The source's mutation counters exist for exactly this
    // case and must force a FULL rebuild, not an append.
    const db = new Database(src);
    db.prepare("UPDATE messages_archive SET text = 'edited in place' WHERE id = 'w1-a-a'").run();
    db.close();

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).toContain('edited in place');
    expect(allRows(dst).map((row) => row.text)).not.toContain('answer from a');
  });

  it('rebuilds when the workgroup membership changes', async () => {
    const src = makeTwoWorkgroupSource('scope');
    useFakeWorker();
    const dst = tmpPath('scope-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(allRows(dst).map((row) => row.text)).toContain('answer from b');

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a'])).mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).not.toContain('answer from b');
  });

  it('rebuilds when the projection file has been deleted underneath it', async () => {
    const src = makeTwoWorkgroupSource('deleted');
    useFakeWorker();
    const dst = tmpPath('deleted-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    fs.unlinkSync(dst);

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    expect(fs.existsSync(dst)).toBe(true);
  });

  it('does not treat a stamp from an older builder as fresh', async () => {
    const src = makeTwoWorkgroupSource('version');
    useFakeWorker();
    const dst = tmpPath('version-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    const stamp = computeArchiveProjectionStamp(src, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    fs.writeFileSync(archiveProjectionStampPath(dst), JSON.stringify({ ...stamp, version: stamp.version - 1 }));

    // A v1 stamp costs exactly one rebuild, then the v2 stamp takes over.
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('reused');
  });
});

describe('#315 — fail-closed is unchanged', () => {
  it('propagates a build failure so the spawn aborts', async () => {
    const src = makeTwoWorkgroupSource('failclosed');
    useFakeWorker('fail');
    const dst = tmpPath('failclosed-dst');

    await expect(ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).rejects.toThrow(
      /source is corrupt/,
    );
    // No stamp: a failed build must never leave something a later spawn reuses.
    expect(fs.existsSync(archiveProjectionStampPath(dst))).toBe(false);
  });

  it('does not reuse after a failed build', async () => {
    const src = makeTwoWorkgroupSource('failthenok');
    useFakeWorker('fail');
    const dst = tmpPath('failthenok-dst');
    await expect(ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a'])).rejects.toThrow();

    useFakeWorker('build');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a'])).mode).toBe('rebuilt');
    expect(allRows(dst).length).toBeGreaterThan(0);
  });

  it('falls back to an in-process build when the worker cannot start, rather than refusing every spawn', async () => {
    const src = makeTwoWorkgroupSource('fallback');
    __setArchiveProjectionWorkerFactoryForTest(() => {
      throw new Error('worker threads unavailable');
    });
    const dst = tmpPath('fallback-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    const expected = tmpPath('fallback-expected');
    buildArchiveProjection(src, expected, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(allRows(dst)).toEqual(allRows(expected));
  });
});

describe('S2-PR16 — F-16.1', () => {
  /**
   * F-16.1, carried from `main` unchanged in substance: the seam-2 integration
   * must not lose #315's reuse/rebuild decision, and it must keep making it on
   * a worker thread rather than the host's own. Both halves in one case,
   * because either alone passes for the wrong reason — a build that never
   * happens is "reused", and a build that always happens is "rebuilt".
   */
  it('a fresh projection is reused and a stale one is rebuilt on a worker thread', async () => {
    const src = makeTwoWorkgroupSource('f16-1');
    const worker = useFakeWorker();
    const dst = tmpPath('f16-1-dst');

    // Build once, then ask again with nothing changed: the second call must
    // write nothing.
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    const second = await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(second.mode, 'a fresh projection was rebuilt').toBe('reused');
    expect(second.rows).toBe(0);

    // An in-place edit — the change a row count or a rowid watermark misses —
    // must force a full rebuild and land in the file.
    const db = new Database(src);
    db.prepare("UPDATE messages_archive SET text = 'edited for F-16.1' WHERE id = 'w1-a-a'").run();
    db.close();

    const third = await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(third.mode, 'a stale projection was reused').toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).toContain('edited for F-16.1');

    // Off-thread, not in process: every decision went through the worker seam,
    // and the host never fell back to running it synchronously.
    expect(worker.posted.map((request) => request.dstPath)).toEqual([dst, dst, dst]);
  });
});

describe('#315 — the real worker thread builds the projection', () => {
  it('produces the same contents off the main thread as the synchronous builder', async () => {
    const src = makeTwoWorkgroupSource('realworker');
    const expected = tmpPath('realworker-expected');
    buildArchiveProjection(src, expected, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    // Default factory — a genuine node:worker_threads Worker.
    __setArchiveProjectionWorkerFactoryForTest(null);
    const dst = tmpPath('realworker-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    expect(allRows(dst)).toEqual(allRows(expected));

    // The stamp is written by whichever thread runs the DECISION, and since
    // #360 that is the worker. A real Worker is a separate module registry that
    // never saw this file's `vi.mock('../config.js')`, so its stamp landed under
    // the REAL DATA_DIR — and the hermeticity guard cannot see a worker
    // thread's writes to tell us. Remove it here rather than leaving a stray
    // file in a live install's data tree (#305); the guard has to be told this
    // one write is deliberate, because it CAN see ours.
    const { DATA_DIR: realDataDir } = await vi.importActual<typeof import('../config.js')>('../config.js');
    const digest = createHash('sha256').update(path.resolve(dst)).digest('hex').slice(0, 32);
    const leakedStamp = path.join(realDataDir, 'projection-stamps', `${digest}.json`);
    expect(fs.existsSync(leakedStamp), 'the real worker did not write its stamp where expected').toBe(true);
    allowWritesTo(path.join(realDataDir, 'projection-stamps'));
    fs.rmSync(leakedStamp, { force: true });
    clearHermeticityAttempts();
  }, 60_000);
});

describe('#315 — the spawn path awaits the projection', () => {
  it('container-runner awaits it and no longer calls the synchronous builder', () => {
    const source = fs.readFileSync(new URL('../container-runner.ts', import.meta.url), 'utf-8');
    expect(source).toContain('await ensureArchiveProjection(');
    // A bare call would rebuild on the main thread again, or drop the rejection.
    expect(source).not.toMatch(/(?<!await )(?<!\w)ensureArchiveProjection\(/);
    expect(source).not.toMatch(/(?<!\w)buildArchiveProjection\(/);
  });
});

describe('#315 review r1 — a TRUNCATE-mode journal must not disable reuse', () => {
  /**
   * `journal_mode = TRUNCATE` commits by truncating the rollback journal to
   * zero bytes rather than deleting it, so `archive.db-journal` is present on
   * every healthy install. The v1 stamp had to stat it, because it inferred the
   * source's state from the main file's size and mtime and a commit in flight
   * made that inference unsafe. The v2 stamp does not infer: `count`,
   * `maxRowid` and `mutations` come from an actual successful read of the
   * source, and a genuinely hot journal makes that read fail outright rather
   * than return something untrustworthy. The stat check and its `journal` stamp
   * field are gone with it; these cases hold the property it was protecting.
   */
  it('reuses the projection when a zero-byte journal sits next to the source', async () => {
    const src = makeTwoWorkgroupSource('zero-journal');
    useFakeWorker();
    const dst = tmpPath('zero-journal-dst');

    fs.writeFileSync(`${src}-journal`, '');
    tmpFiles.push(`${src}-journal`);

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).mode).toBe('reused');
  });

  it('matches what a real TRUNCATE-mode commit leaves on disk', async () => {
    const src = makeTwoWorkgroupSource('real-truncate');
    const db = new Database(src);
    db.pragma('journal_mode = TRUNCATE');
    db.prepare("UPDATE messages_archive SET text = 'committed' WHERE id = 'w1-a-a'").run();
    db.close();
    tmpFiles.push(`${src}-journal`);

    // The commit leaves the journal in place at zero bytes, and that must read
    // as clean rather than as a write in flight.
    expect(fs.existsSync(`${src}-journal`)).toBe(true);
    expect(fs.statSync(`${src}-journal`).size).toBe(0);

    useFakeWorker();
    const dst = tmpPath('real-truncate-dst');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a'])).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a'])).mode).toBe('reused');
  });
});

describe('#315 — ground truth for the projection contents', () => {
  /**
   * Pinned against literal expected rows rather than against the builder, so a
   * change to HOW the builder reads rows — the `.all()` to `.iterate()` switch
   * that removed the 237 MB heap spike, or anything after it — cannot quietly
   * change WHAT a container sees.
   */
  it('matches an explicit expected row set for a two-workgroup fixture', async () => {
    const src = makeTwoWorkgroupSource('ground-truth');
    useFakeWorker();
    const dst = tmpPath('ground-truth-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);

    expect(
      allRows(dst).map((row) => ({
        id: row.id,
        agent_group_id: row.agent_group_id,
        role: row.role,
        sender_id: row.sender_id,
        text: row.text,
        sent_at: row.sent_at,
      })),
    ).toEqual([
      // MIN(id) wins the dedup bucket, so the sibling's copy is dropped.
      {
        id: 'w1-a-a',
        agent_group_id: 'ag-one-a',
        role: 'assistant',
        sender_id: 'ag-one-a',
        text: 'answer from a',
        sent_at: '2026-01-01T10:01:00Z',
      },
      {
        id: 'w1-a-b',
        agent_group_id: 'ag-one-a',
        role: 'assistant',
        sender_id: 'ag-one-b',
        text: 'answer from b',
        sent_at: '2026-01-01T10:01:00Z',
      },
      {
        id: 'w1-u-a',
        agent_group_id: 'ag-one-a',
        role: 'user',
        sender_id: 'u-1',
        text: 'shared question',
        sent_at: '2026-01-01T10:00:00Z',
      },
    ]);
  });

  it('does not hold a source read transaction across the projection write', () => {
    const source = fs.readFileSync(new URL('./per-agent-projections.ts', import.meta.url), 'utf-8');
    // `archive.db` is in `journal_mode = TRUNCATE`, where a reader blocks a
    // writer, and the host's archiveMessage writer is synchronous on the main
    // thread. An open `.iterate()` cursor would hold a shared lock on the
    // canonical archive through the whole insert phase and stall that writer
    // or drop its row. WAL would fix the conflict but is ruled out upstream:
    // containers mount archive.db read-only with no -wal sidecar.
    // Comment lines stripped first — the prose above the read names
    // `.iterate()` on purpose, to say why it is not used.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\.iterate\(/);
    expect(code).toContain('.all(...workgroupMemberIds)');
  });
});

describe('#315 review r2 — the stamp cannot be reached from a container', () => {
  it('keeps the stamp out of the session directory that is bind-mounted read-write', async () => {
    const src = makeTwoWorkgroupSource('stamp-location');
    useFakeWorker();
    const dst = tmpPath('stamp-location-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);

    const stampPath = archiveProjectionStampPath(dst);
    expect(fs.existsSync(stampPath)).toBe(true);
    expect(stampPath).not.toBe(`${dst}.stamp.json`);
    expect(path.dirname(stampPath).endsWith(`${path.sep}projection-stamps`)).toBe(true);

    // The property that matters, stated against a real session layout rather
    // than the test's temp paths: `buildMounts` mounts the whole session
    // directory read-write at /workspace, so nothing the host later writes by
    // name may live inside it. A sidecar there could be swapped for a symlink
    // and the next stamp write would truncate whatever it pointed at.
    const sessionDirectory = path.join(os.tmpdir(), 'v2-sessions', 'ag-mounted', 'sess-mounted');
    const projectionInSession = path.join(sessionDirectory, 'archive.db');
    expect(archiveProjectionStampPath(projectionInSession).startsWith(`${sessionDirectory}${path.sep}`)).toBe(false);
  });

  it('refuses to follow a symlink planted at the stamp path', async () => {
    const src = makeTwoWorkgroupSource('stamp-symlink');
    useFakeWorker();
    const dst = tmpPath('stamp-symlink-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);

    const stampPath = archiveProjectionStampPath(dst);
    const victim = tmpPath('stamp-symlink-victim');
    fs.writeFileSync(victim, 'precious host data');
    fs.rmSync(stampPath, { force: true });
    fs.symlinkSync(victim, stampPath);

    // A symlinked stamp reads as no stamp, and the rebuild that follows
    // replaces the link itself rather than writing through it.
    expect(readArchiveProjectionStamp(dst)).toBeNull();
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious host data');
    expect(fs.lstatSync(stampPath).isSymbolicLink()).toBe(false);
  });
});

describe('#315 review r2 — a partial rebuild is never served as fresh', () => {
  it('does not reuse a partial projection left beside a still-matching earlier stamp', async () => {
    const src = makeTwoWorkgroupSource('partial');
    const scope = ['ag-one-a', 'ag-one-b'];
    const dst = tmpPath('partial-dst');

    // A good build first, so a matching stamp exists on disk.
    useFakeWorker('build');
    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(archiveProjectionIsFresh(dst, computeArchiveProjectionStamp(src, 'ag-one-a', scope))).toBe(true);

    // Storage cleanup reclaims the projection but not the stamp.
    fs.unlinkSync(dst);

    // The rebuild dies after writing the schema, leaving a non-empty file.
    useFakeWorker('partial');
    await expect(ensureArchiveProjection(src, dst, 'ag-one-a', scope)).rejects.toThrow(/disk went away/);
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.statSync(dst).size).toBeGreaterThan(0);

    // The source has not moved, so an earlier stamp surviving here would make
    // this partial file look current.
    expect(archiveProjectionIsFresh(dst, computeArchiveProjectionStamp(src, 'ag-one-a', scope))).toBe(false);

    useFakeWorker('build');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).toContain('shared question');
  });

  it('drops the stamp before writing, not after succeeding', async () => {
    const src = makeTwoWorkgroupSource('invalidate-first');
    const scope = ['ag-one-a'];
    const dst = tmpPath('invalidate-first-dst');

    useFakeWorker('build');
    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(readArchiveProjectionStamp(dst)).not.toBeNull();

    useFakeWorker('fail');
    // Force a rebuild by changing the scope, then fail it.
    await expect(ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b'])).rejects.toThrow();
    expect(readArchiveProjectionStamp(dst)).toBeNull();
  });
});


describe('#360 — a message elsewhere does not rebuild this projection', () => {
  const scope = ['ag-one-a', 'ag-one-b'];

  it('reuses when the OTHER workgroup archives a message', async () => {
    const src = makeTwoWorkgroupSource('cross-wg');
    useFakeWorker();
    const dst = tmpPath('cross-wg-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    const mtime = fs.statSync(dst).mtimeMs;

    // Workgroup two gets a new message. Under the v1 stat stamp this moved
    // `data/archive.db` and invalidated every session's projection on the host.
    archiveInto(src, {
      id: 'w2-u-b',
      agent_group_id: 'ag-two-a',
      role: 'user',
      sender_id: 'u-9',
      text: 'other tenant follow-up',
      sent_at: '2026-01-01T12:00:00Z',
    });

    const result = await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(result.mode).toBe('reused');
    expect(result.rows).toBe(0);
    expect(fs.statSync(dst).mtimeMs).toBe(mtime);
    expect(allRows(dst).map((row) => row.text)).not.toContain('other tenant follow-up');
  });

  it('appends this workgroup\'s new rows and lands what a full rebuild would', async () => {
    const src = makeTwoWorkgroupSource('append-seam');
    useFakeWorker();
    const dst = tmpPath('append-seam-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);

    archiveInto(src, {
      id: 'w1-u-a2',
      agent_group_id: 'ag-one-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'follow-up question',
      sent_at: '2026-01-01T12:00:00Z',
    });
    archiveInto(src, {
      id: 'w1-u-b2',
      agent_group_id: 'ag-one-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'follow-up question',
      sent_at: '2026-01-01T12:00:00Z',
    });
    archiveInto(src, {
      id: 'w1-a-a2',
      agent_group_id: 'ag-one-a',
      role: 'assistant',
      sender_id: 'ag-one-a',
      text: 'follow-up answer',
      sent_at: '2026-01-01T12:01:00Z',
    });

    const result = await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(result.mode).toBe('appended');
    // The sibling pair collapses, so three source rows land as two.
    expect(result.rows).toBe(2);
    expect(result.sinceRowid).toBeGreaterThan(0);

    const expected = tmpPath('append-seam-expected');
    buildArchiveProjection(src, expected, 'ag-one-a', scope);
    const shape = (file: string) =>
      allRows(file)
        .map((r) => [r.messaging_group_id, r.thread_id, r.role, r.sender_id, r.sent_at, r.text, r.agent_group_id])
        .sort();
    expect(shape(dst)).toEqual(shape(expected));
    expect(allRows(dst)).toHaveLength(allRows(expected).length);
  });

  it('inserts nothing when a sibling duplicate of a projected message arrives late', async () => {
    const src = makeTwoWorkgroupSource('late-dup');
    useFakeWorker();
    const dst = tmpPath('late-dup-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    const before = allRows(dst);

    archiveInto(src, {
      id: 'w1-u-b-late',
      agent_group_id: 'ag-one-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'shared question',
      sent_at: '2026-01-01T10:00:00Z',
    });

    const result = await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(result.mode).toBe('appended');
    expect(result.rows).toBe(0);
    expect(allRows(dst)).toEqual(before);
  });

  it('rebuilds when a row disappears from the scope', async () => {
    const src = makeTwoWorkgroupSource('shrunk');
    useFakeWorker();
    const dst = tmpPath('shrunk-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);

    const db = new Database(src);
    db.prepare("DELETE FROM messages_archive WHERE id = 'w1-a-b'").run();
    db.close();

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).not.toContain('answer from b');
  });

  it('rebuilds, once, against an archive with no mutation counters', async () => {
    const src = makeTwoWorkgroupSource('no-marks');
    const db = new Database(src);
    db.exec('DROP TRIGGER messages_archive_mark_update; DROP TRIGGER messages_archive_mark_delete');
    db.exec('DROP TABLE archive_row_marks');
    db.close();
    useFakeWorker();
    const dst = tmpPath('no-marks-dst');

    // Fail closed: an archive that cannot report edits is rebuilt every time,
    // which is exactly the pre-#360 behavior, never an unsound reuse.
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
  });

  it('falls back to a full rebuild when the append itself fails', async () => {
    const src = makeTwoWorkgroupSource('append-fails');
    useFakeWorker();
    const dst = tmpPath('append-fails-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);

    archiveInto(src, {
      id: 'w1-u-a3',
      agent_group_id: 'ag-one-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'row that forces an append',
      sent_at: '2026-01-01T13:00:00Z',
    });

    // Truncate the projection's schema out from under the append. Opening it
    // succeeds, the INSERT does not — the class of failure a corrupt or
    // half-written projection produces.
    const dstDb = new Database(dst);
    dstDb.exec('DROP TABLE messages_archive');
    dstDb.close();

    const result = await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(result.mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).toContain('row that forces an append');
    // A valid stamp afterwards, so the NEXT spawn reuses rather than repeating.
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('reused');
  });

  it('makes the same three decisions in legacy single-agent mode', async () => {
    const src = makeTwoWorkgroupSource('legacy-modes');
    useFakeWorker();
    const dst = tmpPath('legacy-modes-dst');

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a')).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a')).mode).toBe('reused');

    // A message for the sibling is out of scope in legacy mode, so still a reuse.
    archiveInto(src, {
      id: 'w1-u-b4',
      agent_group_id: 'ag-one-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'sibling only',
      sent_at: '2026-01-01T14:00:00Z',
    });
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a')).mode).toBe('reused');

    archiveInto(src, {
      id: 'w1-u-a4',
      agent_group_id: 'ag-one-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'mine only',
      sent_at: '2026-01-01T14:01:00Z',
    });
    const appended = await ensureArchiveProjection(src, dst, 'ag-one-a');
    expect(appended.mode).toBe('appended');
    expect(appended.rows).toBe(1);
    expect(allRows(dst).map((row) => row.text)).toContain('mine only');
    expect(allRows(dst).map((row) => row.text)).not.toContain('sibling only');
  });

  it('makes the same three decisions in process when the worker is unavailable', async () => {
    const src = makeTwoWorkgroupSource('fallback-modes');
    __setArchiveProjectionWorkerFactoryForTest(() => {
      throw new Error('worker threads unavailable');
    });
    const dst = tmpPath('fallback-modes-dst');

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('reused');

    archiveInto(src, {
      id: 'w1-a-a5',
      agent_group_id: 'ag-one-a',
      role: 'assistant',
      sender_id: 'ag-one-a',
      text: 'answered on the main thread',
      sent_at: '2026-01-01T15:00:00Z',
    });
    const appended = await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(appended.mode).toBe('appended');
    expect(appended.rows).toBe(1);
    expect(allRows(dst).map((row) => row.text)).toContain('answered on the main thread');

    const db = new Database(src);
    db.prepare("UPDATE messages_archive SET text = 'edited on the main thread' WHERE id = 'w1-a-a'").run();
    db.close();
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect(allRows(dst).map((row) => row.text)).toContain('edited on the main thread');
  });

  it('reuses an empty projection when there is no source archive yet', async () => {
    useFakeWorker();
    const dst = tmpPath('no-source-dst');
    const src = path.join(os.tmpdir(), `ncproj-w-absent-${process.pid}-${Math.random()}.db`);

    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('rebuilt');
    expect((await ensureArchiveProjection(src, dst, 'ag-one-a', scope)).mode).toBe('reused');
    expect(allRows(dst)).toEqual([]);
  });
});
