import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';

const HEALTH_FILE = path.join(DATA_DIR, 'memory-health.json');

interface LatencyBucket {
  '0': number;
  '1-3': number;
  '4-5': number;
  '6+': number;
}

interface PerGroupState {
  factsLast24h: number;
  classifierFails24h: number;
  deadLettersOpen: number;
  deadLettersPoisoned: number;
  oldestRetryDue: string | null;
  recallLatencies: number[];
  recallFailOpen24h: number;
  recallResults: number[];
  lastSynthesiseSucceededAt: string | null;
  redactionCount: number;
  classifierFalsePositiveSignal24h: number;
  lagSec: number | null;
}

function emptyGroupState(): PerGroupState {
  return {
    factsLast24h: 0,
    classifierFails24h: 0,
    deadLettersOpen: 0,
    deadLettersPoisoned: 0,
    oldestRetryDue: null,
    recallLatencies: [],
    recallFailOpen24h: 0,
    recallResults: [],
    lastSynthesiseSucceededAt: null,
    redactionCount: 0,
    classifierFalsePositiveSignal24h: 0,
    lagSec: null,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildTopKDistribution(results: number[]): LatencyBucket {
  const dist: LatencyBucket = { '0': 0, '1-3': 0, '4-5': 0, '6+': 0 };
  for (const count of results) {
    if (count === 0) dist['0']++;
    else if (count <= 3) dist['1-3']++;
    else if (count <= 5) dist['4-5']++;
    else dist['6+']++;
  }
  return dist;
}

function buildGroupJson(state: PerGroupState): Record<string, unknown> {
  const sorted = [...state.recallLatencies].sort((a, b) => a - b);
  const totalRecall = state.recallResults.length;
  const emptyRecalls = state.recallResults.filter((r) => r === 0).length;

  const now = new Date();
  const synthesiseStaleHours = state.lastSynthesiseSucceededAt
    ? (now.getTime() - new Date(state.lastSynthesiseSucceededAt).getTime()) / 3_600_000
    : null;

  return {
    lagSec: state.lagSec,
    factsLast24h: state.factsLast24h,
    classifierFails24h: state.classifierFails24h,
    deadLettersOpen: state.deadLettersOpen,
    deadLettersPoisoned: state.deadLettersPoisoned,
    oldestRetryDue: state.oldestRetryDue,
    recallP50Ms: percentile(sorted, 50),
    recallP95Ms: percentile(sorted, 95),
    recallFailOpen24h: state.recallFailOpen24h,
    recallEmptyRate24h: totalRecall > 0 ? emptyRecalls / totalRecall : 0,
    recallTopKDistribution24h: buildTopKDistribution(state.recallResults),
    lastSynthesiseSucceededAt: state.lastSynthesiseSucceededAt,
    synthesiseStaleHours,
    redactionCount: state.redactionCount,
    classifierFalsePositiveSignal24h: state.classifierFalsePositiveSignal24h,
  };
}

interface MemoryEnabledCheckFailureEntry {
  count: number;
  lastError: string;
  lastAt: string;
}

export class HealthRecorder {
  private groups = new Map<string, PerGroupState>();
  private prereqVerification: { ok: boolean; checks: object } | null = null;
  private lastSweepAt: string | null = null;
  private memoryEnabledCheckFailures = new Map<string, MemoryEnabledCheckFailureEntry>();

  private group(agentGroupId: string): PerGroupState {
    if (!this.groups.has(agentGroupId)) {
      this.groups.set(agentGroupId, emptyGroupState());
    }
    return this.groups.get(agentGroupId)!;
  }

  recordTurnClassified(agentGroupId: string, factsWritten: number, _latencyMs: number): void {
    const g = this.group(agentGroupId);
    g.factsLast24h += factsWritten;
  }

  recordClassifierFailure(agentGroupId: string, _error: Error): void {
    const g = this.group(agentGroupId);
    g.classifierFails24h++;
  }

  recordSourceIngest(agentGroupId: string, factsWritten: number, _contentHash: string): void {
    const g = this.group(agentGroupId);
    g.factsLast24h += factsWritten;
  }

  recordRecallLatency(agentGroupId: string, latencyMs: number, resultCount: number): void {
    const g = this.group(agentGroupId);
    g.recallLatencies.push(latencyMs);
    g.recallResults.push(resultCount);
  }

  recordRecallFailOpen(agentGroupId: string, _reason: string): void {
    const g = this.group(agentGroupId);
    g.recallFailOpen24h++;
  }

  recordRedaction(agentGroupId: string, _reason: string): void {
    const g = this.group(agentGroupId);
    g.redactionCount++;
  }

  recordSynthesiseSucceeded(agentGroupId: string, at: Date): void {
    const g = this.group(agentGroupId);
    g.lastSynthesiseSucceededAt = at.toISOString();
  }

  recordMemoryEnabledCheckFailure(agentGroupId: string, error: string): void {
    const existing = this.memoryEnabledCheckFailures.get(agentGroupId);
    if (existing) {
      existing.count++;
      existing.lastError = error;
      existing.lastAt = new Date().toISOString();
    } else {
      this.memoryEnabledCheckFailures.set(agentGroupId, {
        count: 1,
        lastError: error,
        lastAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Clear a group's failure entry after a successful config read. Without
   * this, transient errors stay in memory-health.json indefinitely after the
   * config is fixed, and stale group directories grow the map until the
   * daemon restarts. Idempotent — no-op if no entry exists.
   */
  clearMemoryEnabledCheckFailure(agentGroupId: string): void {
    this.memoryEnabledCheckFailures.delete(agentGroupId);
  }

  /**
   * Prune failure entries that no longer correspond to a known group. The
   * caller passes the set of currently-discovered group keys (folder names);
   * any entry not in that set is dropped. The synthetic `__groups_dir__` key
   * is always retained — it has its own clear path. This handles the case
   * where a group directory is deleted between sweeps: the per-loop clear
   * never visits the deleted entry, so it would otherwise zombie until
   * daemon restart.
   */
  pruneMemoryEnabledCheckFailures(knownGroupKeys: Set<string>): void {
    for (const key of this.memoryEnabledCheckFailures.keys()) {
      if (key === '__groups_dir__') continue;
      if (!knownGroupKeys.has(key)) {
        this.memoryEnabledCheckFailures.delete(key);
      }
    }
  }

  setPrereqVerification(ok: boolean, checks: object): void {
    this.prereqVerification = { ok, checks };
  }

  async flush(healthFilePath?: string): Promise<void> {
    const outputPath = healthFilePath ?? HEALTH_FILE;
    this.lastSweepAt = new Date().toISOString();

    const groupsJson: Record<string, unknown> = {};
    for (const [agentGroupId, state] of this.groups) {
      groupsJson[agentGroupId] = buildGroupJson(state);
    }

    const memoryEnabledCheckFailuresJson: Record<string, MemoryEnabledCheckFailureEntry> = {};
    for (const [agentGroupId, entry] of this.memoryEnabledCheckFailures) {
      memoryEnabledCheckFailuresJson[agentGroupId] = entry;
    }

    const payload = {
      lastSweepAt: this.lastSweepAt,
      prereqVerification: this.prereqVerification,
      groups: groupsJson,
      memoryEnabledCheckFailures: memoryEnabledCheckFailuresJson,
    };

    const json = JSON.stringify(payload, null, 2);
    const tmpPath = `${outputPath}.tmp`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, outputPath);
  }
}

let _instance: HealthRecorder | null = null;

export function getHealthRecorder(): HealthRecorder {
  if (!_instance) {
    _instance = new HealthRecorder();
  }
  return _instance;
}

/** For tests: reset the singleton. */
export function resetHealthRecorder(): void {
  _instance = null;
}
