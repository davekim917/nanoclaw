import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { HealthRecorder, resetHealthRecorder } from './health.js';

beforeEach(() => {
  resetHealthRecorder();
});

afterEach(() => {
  resetHealthRecorder();
});

describe('health recorder', () => {
  it('test_recordTurnClassified_aggregates', () => {
    const hr = new HealthRecorder();

    hr.recordTurnClassified('ag-1', 2, 100);
    hr.recordTurnClassified('ag-1', 3, 150);
    hr.recordTurnClassified('ag-1', 0, 80);
    hr.recordTurnClassified('ag-1', 5, 200);
    hr.recordTurnClassified('ag-1', 1, 120);

    const groupState = (
      hr as unknown as { groups: Map<string, { factsLast24h: number; classifierFails24h: number }> }
    ).groups.get('ag-1');
    expect(groupState).toBeDefined();
    expect(groupState!.factsLast24h).toBe(11);
    expect(groupState!.classifierFails24h).toBe(0);
  });

  it('test_flush_writes_atomic', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');

    try {
      const hr = new HealthRecorder();
      hr.recordTurnClassified('ag-1', 5, 100);
      hr.setPrereqVerification(true, { db: true });

      await hr.flush(healthPath);

      expect(fs.existsSync(healthPath)).toBe(true);
      expect(fs.existsSync(`${healthPath}.tmp`)).toBe(false);

      const raw = fs.readFileSync(healthPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toBeDefined();
      expect(parsed.prereqVerification).toBeDefined();
      expect(parsed.prereqVerification.ok).toBe(true);
      expect(parsed.groups['ag-1']).toBeDefined();
      expect(parsed.groups['ag-1'].factsLast24h).toBe(5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_recallTopKDistribution_buckets', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-dist-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');

    try {
      const hr = new HealthRecorder();
      const counts = [0, 0, 1, 2, 3, 4, 4, 5, 6];

      for (const c of counts) {
        hr.recordRecallLatency('ag-1', 50, c);
      }

      await hr.flush(healthPath);

      const raw = fs.readFileSync(healthPath, 'utf8');
      const parsed = JSON.parse(raw);
      const dist = parsed.groups['ag-1'].recallTopKDistribution24h;

      expect(dist['0']).toBe(2);
      expect(dist['1-3']).toBe(3);
      expect(dist['4-5']).toBe(3);
      expect(dist['6+']).toBe(1);
      expect(dist['0'] + dist['1-3'] + dist['4-5'] + dist['6+']).toBe(9);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
