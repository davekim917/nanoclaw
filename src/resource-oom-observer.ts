/**
 * Per-container-lifetime bookkeeping for the cgroup `memory.events` counters the runner mirrors into
 * `container_state`: `oom_kill` counts processes the kernel OOM-killed in the cgroup (often a child the agent sees
 * only as a command exiting with no output); `max` counts ceiling hits that forced reclaim. Both reset on respawn,
 * so the lifetime key is (sessionId, spawnedAtMs).
 */

/** No second kill notice inside this window, however fast the counter climbs. */
export const OOM_NOTICE_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** A second notice needs the cumulative count to have grown by this factor. */
const OOM_NOTICE_GROWTH_FACTOR = 10;
/** Reclaim events in one lifetime before the (quieter) pressure notice fires. */
export const MEMORY_PRESSURE_NOTICE_THRESHOLD = 500;

interface OomObservation {
  spawnedAtMs: number;
  count: number;
  pressure: number;
  notifiedKills: number;
  notifiedPressure: boolean;
  notifiedAtMs: number;
}

export interface OomTelemetrySample {
  oomKillCount: number | null | undefined;
  pressureCount: number | null | undefined;
  now: number;
}

export interface OomTelemetryDecision {
  killDelta: number;
  killCount: number;
  pressureCount: number;
  notifyKills: boolean;
  notifyPressure: boolean;
}

function normalize(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export class OomKillObserver {
  private readonly observations = new Map<string, OomObservation>();

  observe(sessionId: string, spawnedAtMs: number, sample: OomTelemetrySample): OomTelemetryDecision {
    const killCount = normalize(sample.oomKillCount);
    const pressureCount = normalize(sample.pressureCount);
    const previous = this.observations.get(sessionId);
    // A respawn, or a counter that went backwards, starts a fresh lifetime: the whole count is new.
    const fresh = !previous || previous.spawnedAtMs !== spawnedAtMs || killCount < previous.count;
    const observation: OomObservation = fresh
      ? { spawnedAtMs, count: 0, pressure: 0, notifiedKills: 0, notifiedPressure: false, notifiedAtMs: 0 }
      : previous;

    const killDelta = killCount - observation.count;
    // One notice per lifetime, unless the count grew by the factor AND the interval passed.
    const notifyKills =
      killCount > 0 &&
      (observation.notifiedKills === 0 ||
        (killCount >= observation.notifiedKills * OOM_NOTICE_GROWTH_FACTOR &&
          sample.now - observation.notifiedAtMs >= OOM_NOTICE_MIN_INTERVAL_MS));
    // Pre-kill signal only: once anything is killed, the louder notice says everything this one would.
    const notifyPressure =
      killCount === 0 && !observation.notifiedPressure && pressureCount >= MEMORY_PRESSURE_NOTICE_THRESHOLD;

    observation.count = killCount;
    observation.pressure = pressureCount;
    if (notifyKills) {
      observation.notifiedKills = killCount;
      observation.notifiedAtMs = sample.now;
    }
    if (notifyPressure) observation.notifiedPressure = true;
    this.observations.set(sessionId, observation);

    return { killDelta, killCount, pressureCount, notifyKills, notifyPressure };
  }
}
