import fs from 'node:fs';
import path from 'node:path';

import { writeResourceTelemetry } from './modules/mailbox/index.js';

export { writeResourceTelemetry };

export interface CgroupMemorySnapshot {
  currentBytes: number;
  peakBytes: number | null;
  maxBytes: number | null;
  oomEvents: number;
  oomKillEvents: number;
  /**
   * memory.events:max — times the cgroup hit its ceiling and had to reclaim.
   * Fires BEFORE anything is killed, so it is the only pre-kill signal here.
   */
  maxEvents: number;
}

function readInteger(filePath: string, optional = false): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw === 'max') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid integer ${JSON.stringify(raw)}`);
    return value;
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

function readMemoryEvents(filePath: string): Map<string, number> {
  const events = new Map<string, number>();
  for (const line of fs.readFileSync(filePath, 'utf8').trim().split('\n')) {
    const [name, rawValue] = line.trim().split(/\s+/, 2);
    if (!name || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value) && value >= 0) events.set(name, value);
  }
  return events;
}

export function readCgroupMemorySnapshot(cgroupRoot = '/sys/fs/cgroup'): CgroupMemorySnapshot | null {
  try {
    const currentBytes = readInteger(path.join(cgroupRoot, 'memory.current'));
    const maxBytes = readInteger(path.join(cgroupRoot, 'memory.max'));
    const peakBytes = readInteger(path.join(cgroupRoot, 'memory.peak'), true);
    const events = readMemoryEvents(path.join(cgroupRoot, 'memory.events'));
    if (currentBytes === null) return null;
    return {
      currentBytes,
      peakBytes,
      maxBytes,
      oomEvents: events.get('oom') ?? 0,
      oomKillEvents: events.get('oom_kill') ?? 0,
      maxEvents: events.get('max') ?? 0,
    };
  } catch {
    return null;
  }
}

export function startResourceTelemetry(
  log: (message: string) => void,
  options: { intervalMs?: number; cgroupRoot?: string } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  let warnedUnavailable = false;
  const sample = () => {
    const snapshot = readCgroupMemorySnapshot(cgroupRoot);
    if (!snapshot) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        log(`cgroup v2 memory telemetry unavailable at ${cgroupRoot}`);
      }
      return;
    }
    writeResourceTelemetry(snapshot);
  };

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
