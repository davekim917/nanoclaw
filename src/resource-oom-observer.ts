interface OomObservation {
  spawnedAtMs: number;
  count: number;
}

/** Tracks cgroup oom_kill counter deltas per concrete container lifetime. */
export class OomKillObserver {
  private readonly observations = new Map<string, OomObservation>();

  observe(sessionId: string, spawnedAtMs: number, count: number): number {
    const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const previous = this.observations.get(sessionId);
    if (!previous || previous.spawnedAtMs !== spawnedAtMs || normalized < previous.count) {
      this.observations.set(sessionId, { spawnedAtMs, count: normalized });
      return normalized;
    }
    const delta = normalized - previous.count;
    this.observations.set(sessionId, { spawnedAtMs, count: normalized });
    return delta;
  }
}
