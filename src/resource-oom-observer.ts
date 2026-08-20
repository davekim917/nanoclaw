/**
 * Per-container-lifetime bookkeeping for cgroup memory telemetry.
 *
 * Two counters, both read from `/sys/fs/cgroup/memory.events` by the
 * agent-runner and mirrored into `container_state`:
 *
 * - `oom_kill` — processes the kernel killed inside the cgroup. It kills
 *   CHILDREN, never PID 1, so the container survives and the agent sees a
 *   command that exited with no output rather than an OOM.
 * - `max` — times the cgroup hit its ceiling and had to reclaim. It fires
 *   BEFORE anything dies; a high `max` with zero kills is a container
 *   thrashing at the wall.
 *
 * Both counters are per-cgroup, so a respawn resets them; the lifetime key
 * is (sessionId, spawnedAtMs).
 */

/** No second kill notice inside this window, however fast the counter climbs. */
export const OOM_NOTICE_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** A second notice needs the cumulative count to have grown by this factor. */
export const OOM_NOTICE_GROWTH_FACTOR = 10;
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
  /** memory.events:max — ceiling hits that forced reclaim. */
  pressureCount: number | null | undefined;
  now: number;
}

export interface OomTelemetryDecision {
  /** New kills since the previous sample of this container lifetime. */
  killDelta: number;
  /** Cumulative kills this container lifetime. */
  killCount: number;
  /** Cumulative reclaim events this container lifetime. */
  pressureCount: number;
  /** Tell the agent about kills now. */
  notifyKills: boolean;
  /** Tell the agent it is thrashing at the ceiling, nothing killed yet. */
  notifyPressure: boolean;
}

function normalize(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Tracks cgroup memory-event counter deltas per concrete container lifetime. */
export class OomKillObserver {
  private readonly observations = new Map<string, OomObservation>();

  observe(sessionId: string, spawnedAtMs: number, sample: OomTelemetrySample): OomTelemetryDecision {
    const killCount = normalize(sample.oomKillCount);
    const pressureCount = normalize(sample.pressureCount);
    const previous = this.observations.get(sessionId);
    // A respawn (or a counter that went backwards, which means the same
    // thing) starts a fresh lifetime: the whole count is new.
    const fresh = !previous || previous.spawnedAtMs !== spawnedAtMs || killCount < previous.count;
    const observation: OomObservation = fresh
      ? { spawnedAtMs, count: 0, pressure: 0, notifiedKills: 0, notifiedPressure: false, notifiedAtMs: 0 }
      : previous;

    const killDelta = killCount - observation.count;
    // One notice per lifetime, unless the count materially grew AND enough
    // time passed. 346 kills in 20 minutes must not become 346 messages.
    const notifyKills =
      killCount > 0 &&
      (observation.notifiedKills === 0 ||
        (killCount >= observation.notifiedKills * OOM_NOTICE_GROWTH_FACTOR &&
          sample.now - observation.notifiedAtMs >= OOM_NOTICE_MIN_INTERVAL_MS));
    // Pre-kill signal only — once anything has been killed the louder notice
    // above says everything this one would.
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
