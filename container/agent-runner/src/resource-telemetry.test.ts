import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCgroupMemorySnapshot, writeResourceTelemetry } from './resource-telemetry.js';

const tempDirs: string[] = [];

function tempCgroup(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cgroup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cgroup resource telemetry', () => {
  it('test_read_cgroup_v2_memory_snapshot', () => {
    const dir = tempCgroup();
    fs.writeFileSync(path.join(dir, 'memory.current'), '104857600\n');
    fs.writeFileSync(path.join(dir, 'memory.peak'), '209715200\n');
    fs.writeFileSync(path.join(dir, 'memory.max'), '5368709120\n');
    fs.writeFileSync(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 3\noom 2\noom_kill 1\n');

    expect(readCgroupMemorySnapshot(dir)).toEqual({
      currentBytes: 104857600,
      peakBytes: 209715200,
      maxBytes: 5368709120,
      oomEvents: 2,
      oomKillEvents: 1,
    });
  });

  it('test_read_cgroup_snapshot_tolerates_optional_files', () => {
    const dir = tempCgroup();
    fs.writeFileSync(path.join(dir, 'memory.current'), '1024\n');
    fs.writeFileSync(path.join(dir, 'memory.max'), 'max\n');
    fs.writeFileSync(path.join(dir, 'memory.events'), 'oom 0\noom_kill 0\n');

    expect(readCgroupMemorySnapshot(dir)).toEqual({
      currentBytes: 1024,
      peakBytes: null,
      maxBytes: null,
      oomEvents: 0,
      oomKillEvents: 0,
    });
  });

  it('test_write_resource_telemetry_persists_host_visible_state', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE container_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        memory_current_bytes INTEGER,
        memory_peak_bytes INTEGER,
        memory_max_bytes INTEGER,
        memory_oom_events INTEGER,
        memory_oom_kill_events INTEGER,
        memory_telemetry_at TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    writeResourceTelemetry(
      {
        currentBytes: 10,
        peakBytes: 20,
        maxBytes: 30,
        oomEvents: 2,
        oomKillEvents: 1,
      },
      db,
    );

    expect(db.prepare('SELECT * FROM container_state WHERE id = 1').get()).toMatchObject({
      memory_current_bytes: 10,
      memory_peak_bytes: 20,
      memory_max_bytes: 30,
      memory_oom_events: 2,
      memory_oom_kill_events: 1,
    });
    db.close();
  });
});
