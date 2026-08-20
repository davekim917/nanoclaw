import { describe, expect, it } from 'vitest';

import {
  MEMORY_PRESSURE_NOTICE_THRESHOLD,
  OOM_NOTICE_MIN_INTERVAL_MS,
  OomKillObserver,
} from './resource-oom-observer.js';

const T0 = 1_700_000_000_000;

function sample(oomKillCount: number, pressureCount = 0, now = T0) {
  return { oomKillCount, pressureCount, now };
}

describe('OomKillObserver', () => {
  it('test_oom_observer_reports_counter_increase_once', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('session-1', 1000, sample(0)).killDelta).toBe(0);
    expect(observer.observe('session-1', 1000, sample(2)).killDelta).toBe(2);
    expect(observer.observe('session-1', 1000, sample(2)).killDelta).toBe(0);
  });

  it('test_oom_observer_resets_for_new_container_spawn', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('session-1', 1000, sample(1)).killDelta).toBe(1);
    expect(observer.observe('session-1', 2000, sample(0)).killDelta).toBe(0);
    expect(observer.observe('session-1', 2000, sample(1)).killDelta).toBe(1);
  });

  it('test_many_kills_produce_one_notice_per_ten_minutes_not_one_per_kill', () => {
    const observer = new OomKillObserver();
    let notices = 0;
    // 346 kills over 19.6 minutes — the real observed burst, sampled every
    // 15s like the container telemetry does. One notice at the first kill;
    // a second only once ten minutes have passed AND the count is 10x
    // larger, which by then means the agent kept hammering after being told.
    for (let i = 1; i <= 346; i++) {
      const now = T0 + Math.round((i / 346) * 19.6 * 60_000);
      if (observer.observe('session-1', 1000, sample(i, 0, now)).notifyKills) notices++;
    }
    expect(notices).toBe(2);
  });

  it('test_one_notice_when_the_burst_is_shorter_than_the_interval', () => {
    const observer = new OomKillObserver();
    let notices = 0;
    for (let i = 1; i <= 346; i++) {
      const now = T0 + Math.round((i / 346) * 9 * 60_000);
      if (observer.observe('session-1', 1000, sample(i, 0, now)).notifyKills) notices++;
    }
    expect(notices).toBe(1);
  });

  it('test_second_notice_needs_a_materially_larger_count', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('s', 1000, sample(20, 0, T0)).notifyKills).toBe(true);
    // Past the interval, but 199 is under the 10x threshold of 200.
    expect(observer.observe('s', 1000, sample(199, 0, T0 + OOM_NOTICE_MIN_INTERVAL_MS)).notifyKills).toBe(false);
    // Materially larger AND past the interval.
    expect(observer.observe('s', 1000, sample(400, 0, T0 + OOM_NOTICE_MIN_INTERVAL_MS)).notifyKills).toBe(true);
  });

  it('test_second_notice_needs_the_interval_to_have_passed', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('s', 1000, sample(20, 0, T0)).notifyKills).toBe(true);
    // 15x growth, but one minute in — a fast burst stays one notice.
    expect(observer.observe('s', 1000, sample(300, 0, T0 + 60_000)).notifyKills).toBe(false);
  });

  it('test_no_kills_produces_no_notice', () => {
    const observer = new OomKillObserver();

    for (let i = 0; i < 20; i++) {
      const decision = observer.observe('quiet', 1000, sample(0, 3, T0 + i * 15_000));
      expect(decision.notifyKills).toBe(false);
      expect(decision.notifyPressure).toBe(false);
    }
  });

  it('test_pressure_notice_fires_once_per_lifetime_before_any_kill', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('s', 1000, sample(0, MEMORY_PRESSURE_NOTICE_THRESHOLD - 1)).notifyPressure).toBe(false);
    expect(observer.observe('s', 1000, sample(0, MEMORY_PRESSURE_NOTICE_THRESHOLD)).notifyPressure).toBe(true);
    expect(observer.observe('s', 1000, sample(0, 5_000)).notifyPressure).toBe(false);
    // A respawn is a new cgroup, so the counter and the notice both reset.
    expect(observer.observe('s', 2000, sample(0, MEMORY_PRESSURE_NOTICE_THRESHOLD)).notifyPressure).toBe(true);
  });

  it('test_pressure_notice_yields_to_the_kill_notice', () => {
    const observer = new OomKillObserver();

    const decision = observer.observe('s', 1000, sample(3, 10_000));
    expect(decision.notifyKills).toBe(true);
    expect(decision.notifyPressure).toBe(false);
  });
});
