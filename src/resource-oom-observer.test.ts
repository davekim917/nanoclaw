import { describe, expect, it } from 'vitest';

import { OomKillObserver } from './resource-oom-observer.js';

describe('OomKillObserver', () => {
  it('test_oom_observer_reports_counter_increase_once', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('session-1', 1000, 0)).toBe(0);
    expect(observer.observe('session-1', 1000, 2)).toBe(2);
    expect(observer.observe('session-1', 1000, 2)).toBe(0);
  });

  it('test_oom_observer_resets_for_new_container_spawn', () => {
    const observer = new OomKillObserver();

    expect(observer.observe('session-1', 1000, 1)).toBe(1);
    expect(observer.observe('session-1', 2000, 0)).toBe(0);
    expect(observer.observe('session-1', 2000, 1)).toBe(1);
  });
});
