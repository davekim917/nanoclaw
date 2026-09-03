/**
 * #315 regression suite for the archive projection.
 *
 * The projection used to be rebuilt synchronously on the host's main thread on
 * every container spawn, which is what parked the event loop for a p50 of 18 s.
 * These tests hold three properties: the contents a session sees are unchanged,
 * an unchanged source is not rebuilt, and a rebuild that fails still aborts the
 * spawn.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
} from './per-agent-projections.js';

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
  `);
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
  constructor(private readonly behavior: 'build' | 'fail' = 'build') {
    super();
  }
  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    queueMicrotask(() => {
      if (this.behavior === 'fail') {
        this.emit('message', { id: message.id, ok: false, error: 'source is corrupt' });
        return;
      }
      try {
        buildArchiveProjection(
          message.srcPath as string,
          message.dstPath as string,
          message.agentGroupId as string,
          message.workgroupMemberIds as string[] | undefined,
        );
        this.emit('message', { id: message.id, ok: true, bytes: fs.statSync(message.dstPath as string).size });
      } catch (error) {
        this.emit('message', { id: message.id, ok: false, error: (error as Error).message });
      }
    });
  }
}

function useFakeWorker(behavior: 'build' | 'fail' = 'build'): FakeWorker {
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
  it('skips the second build when nothing moved', async () => {
    const src = makeTwoWorkgroupSource('reuse');
    const worker = useFakeWorker();
    const dst = tmpPath('reuse-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(1);

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(1);
  });

  it('ignores the order the workgroup members arrive in', async () => {
    const src = makeTwoWorkgroupSource('order');
    const worker = useFakeWorker();
    const dst = tmpPath('order-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-b', 'ag-one-a']);
    expect(worker.posted).toHaveLength(1);
  });

  it('rebuilds when the source file changes', async () => {
    const src = makeTwoWorkgroupSource('changed');
    const worker = useFakeWorker();
    const dst = tmpPath('changed-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(1);

    // An EDIT, not an append: this is the case a row-count or MAX(sent_at)
    // watermark would miss, and why the stamp keys on file identity instead.
    const db = new Database(src);
    db.prepare("UPDATE messages_archive SET text = 'edited in place' WHERE id = 'w1-a-a'").run();
    db.close();

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(2);
    expect(allRows(dst).map((row) => row.text)).toContain('edited in place');
  });

  it('rebuilds when the workgroup membership changes', async () => {
    const src = makeTwoWorkgroupSource('scope');
    const worker = useFakeWorker();
    const dst = tmpPath('scope-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(allRows(dst).map((row) => row.text)).toContain('answer from b');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);
    expect(worker.posted).toHaveLength(2);
    expect(allRows(dst).map((row) => row.text)).not.toContain('answer from b');
  });

  it('rebuilds when the projection file has been deleted underneath it', async () => {
    const src = makeTwoWorkgroupSource('deleted');
    const worker = useFakeWorker();
    const dst = tmpPath('deleted-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    fs.unlinkSync(dst);

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(2);
    expect(fs.existsSync(dst)).toBe(true);
  });

  it('does not treat a stamp from an older builder as fresh', async () => {
    const src = makeTwoWorkgroupSource('version');
    const worker = useFakeWorker();
    const dst = tmpPath('version-dst');

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    const stamp = computeArchiveProjectionStamp(src, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    fs.writeFileSync(archiveProjectionStampPath(dst), JSON.stringify({ ...stamp, version: stamp.version - 1 }));

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(2);
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

    const worker = useFakeWorker('build');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);
    expect(worker.posted).toHaveLength(1);
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
   * every healthy install. Treating its existence as a write in flight would
   * fail every freshness check and rebuild on every spawn.
   */
  it('reuses the projection when a zero-byte journal sits next to the source', async () => {
    const src = makeTwoWorkgroupSource('zero-journal');
    const worker = useFakeWorker();
    const dst = tmpPath('zero-journal-dst');

    fs.writeFileSync(`${src}-journal`, '');
    tmpFiles.push(`${src}-journal`);

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(1);

    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a', 'ag-one-b']);
    expect(worker.posted).toHaveLength(1);
    expect(computeArchiveProjectionStamp(src, 'ag-one-a', ['ag-one-a', 'ag-one-b']).journal).toBeNull();
  });

  it('still refuses to reuse while a non-empty journal shows a write in flight', async () => {
    const src = makeTwoWorkgroupSource('hot-journal');
    const worker = useFakeWorker();
    const dst = tmpPath('hot-journal-dst');
    const scope = ['ag-one-a', 'ag-one-b'];

    await ensureArchiveProjection(src, dst, 'ag-one-a', scope);
    expect(worker.posted).toHaveLength(1);
    expect(archiveProjectionIsFresh(dst, computeArchiveProjectionStamp(src, 'ag-one-a', scope))).toBe(true);

    // Asserted at the freshness gate rather than by driving another build: a
    // genuinely hot journal makes SQLite refuse the read-only open of the
    // source, so the build behind it fails closed anyway.
    fs.writeFileSync(`${src}-journal`, 'rollback pages in flight');
    tmpFiles.push(`${src}-journal`);

    const hotStamp = computeArchiveProjectionStamp(src, 'ag-one-a', scope);
    expect(hotStamp.journal).not.toBeNull();
    expect(archiveProjectionIsFresh(dst, hotStamp)).toBe(false);
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
    expect(computeArchiveProjectionStamp(src, 'ag-one-a', ['ag-one-a']).journal).toBeNull();

    const worker = useFakeWorker();
    const dst = tmpPath('real-truncate-dst');
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);
    await ensureArchiveProjection(src, dst, 'ag-one-a', ['ag-one-a']);
    expect(worker.posted).toHaveLength(1);
  });
});
