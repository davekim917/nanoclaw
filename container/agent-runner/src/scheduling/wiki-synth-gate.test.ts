import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateWikiSynthGate } from './wiki-synth-gate.js';

const tempDirs: string[] = [];

function fixtures(): { memoryPath: string; inboundPath: string; memory: Database; inbound: Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-synth-gate-'));
  tempDirs.push(dir);
  const memoryPath = path.join(dir, 'mnemon.db');
  const inboundPath = path.join(dir, 'inbound.db');
  const memory = new Database(memoryPath);
  const inbound = new Database(inboundPath);
  memory.exec(`
    CREATE TABLE insights (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE edges (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE oplog (
      operation TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  inbound.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      series_id TEXT,
      status TEXT NOT NULL,
      process_after TEXT
    );
  `);
  return { memoryPath, inboundPath, memory, inbound };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('evaluateWikiSynthGate', () => {
  it('skips an empty store with no prior run', () => {
    const f = fixtures();
    f.memory.close();
    f.inbound.close();

    expect(evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath)).toEqual({
      wakeAgent: false,
      data: {
        reason: 'no-memory-change',
        latestMemoryChange: null,
        lastCompletedRun: null,
        baselineAt: null,
      },
    });
  });

  it('wakes for existing memory when synthesis has never completed', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO insights VALUES (?, ?, NULL)').run('i-1', '2026-07-10T12:00:00Z');
    f.memory.close();
    f.inbound.close();

    expect(evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath).wakeAgent).toBe(true);
  });

  it('uses an explicit deployment baseline until the series has a completed run', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO insights VALUES (?, ?, NULL)').run('i-1', '2026-07-10T12:00:00Z');
    f.memory.close();
    f.inbound.close();

    const result = evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath, '2026-07-12T12:00:00Z');
    expect(result.wakeAgent).toBe(false);
    expect(result.data.baselineAt).toBe('2026-07-12T12:00:00Z');
  });

  it('skips when the latest memory mutation predates the last completed run', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO insights VALUES (?, ?, NULL)').run('i-1', '2026-07-10T12:00:00Z');
    f.inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)')
      .run('t-1', 'task', 'memory-synth-ag-1', 'completed', '2026-07-11T03:00:00.000Z');
    f.memory.close();
    f.inbound.close();

    expect(evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath).wakeAgent).toBe(false);
  });

  it('wakes when memory changed after the last completed run', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO insights VALUES (?, ?, NULL)').run('i-1', '2026-07-12T12:00:00Z');
    f.inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)')
      .run('t-1', 'task', 'memory-synth-ag-1', 'completed', '2026-07-11T03:00:00.000Z');
    f.memory.close();
    f.inbound.close();

    expect(evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath).wakeAgent).toBe(true);
  });

  it('does not let a failed occurrence suppress the next synthesis', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO insights VALUES (?, ?, NULL)').run('i-1', '2026-07-12T12:00:00Z');
    f.inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)')
      .run('t-1', 'task', 'memory-synth-ag-1', 'failed', '2026-07-13T03:00:00.000Z');
    f.memory.close();
    f.inbound.close();

    expect(evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath).wakeAgent).toBe(true);
  });

  it('treats deletions and graph-edge writes as memory changes', () => {
    const f = fixtures();
    f.memory
      .prepare('INSERT INTO insights VALUES (?, ?, ?)')
      .run('i-1', '2026-07-09T12:00:00Z', '2026-07-12T12:00:00Z');
    f.memory.prepare('INSERT INTO edges VALUES (?, ?, ?)').run('i-1', 'i-2', '2026-07-12T13:00:00Z');
    f.inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)')
      .run('t-1', 'task', 'memory-synth-ag-1', 'completed', '2026-07-12T11:00:00.000Z');
    f.memory.close();
    f.inbound.close();

    const result = evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath);
    expect(result.wakeAgent).toBe(true);
    expect(result.data.latestMemoryChange).toBe('2026-07-12T13:00:00Z');
  });

  it('uses mutating oplog entries but ignores recall/search activity', () => {
    const f = fixtures();
    f.memory.prepare('INSERT INTO oplog VALUES (?, ?)').run('recall', '2026-07-13T14:00:00Z');
    f.memory.prepare('INSERT INTO oplog VALUES (?, ?)').run('recall:basic', '2026-07-13T14:30:00Z');
    f.memory.prepare('INSERT INTO oplog VALUES (?, ?)').run('search', '2026-07-13T15:00:00Z');
    f.memory.prepare('INSERT INTO oplog VALUES (?, ?)').run('link', '2026-07-12T13:00:00Z');
    f.inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?)')
      .run('t-1', 'task', 'memory-synth-ag-1', 'completed', '2026-07-12T11:00:00.000Z');
    f.memory.close();
    f.inbound.close();

    const result = evaluateWikiSynthGate('memory-synth-ag-1', f.memoryPath, f.inboundPath);
    expect(result.wakeAgent).toBe(true);
    expect(result.data.latestMemoryChange).toBe('2026-07-12T13:00:00Z');
  });
});
