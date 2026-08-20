import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkgroupFilter } from './use-workgroup-filter.js';

const KEY = 'nc:dash:workgroup_filter:u1';

describe('useWorkgroupFilter', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to "all" when nothing is stored', () => {
    const { result } = renderHook(() => useWorkgroupFilter('u1', ['example-labs']));
    expect(result.current[0]).toBe('all');
  });

  it('hydrates a stored workgroup that is still listed', () => {
    localStorage.setItem(KEY, 'example-labs');
    const { result } = renderHook(() => useWorkgroupFilter('u1', ['example-labs', 'example-dev']));
    expect(result.current[0]).toBe('example-labs');
  });

  // The reason this file exists: a stale selection must fall back, never
  // silently filter the whole queue to nothing.
  it('falls back to "all" when the stored workgroup is no longer listed', () => {
    localStorage.setItem(KEY, 'retired-workgroup');
    const { result } = renderHook(() => useWorkgroupFilter('u1', ['example-labs', 'example-dev']));
    expect(result.current[0]).toBe('all');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  // A scoped user whose access to every sibling of `example-labs` was revoked no
  // longer gets `example-labs` from the (already scope-filtered) workgroups
  // endpoint, so the same guard covers revocation.
  it('falls back when the list shrinks under a live selection', () => {
    localStorage.setItem(KEY, 'example-labs');
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useWorkgroupFilter('u1', ids), {
      initialProps: { ids: ['example-labs', 'example-dev'] },
    });
    expect(result.current[0]).toBe('example-labs');
    rerender({ ids: ['example-dev'] });
    expect(result.current[0]).toBe('all');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('does not treat a not-yet-loaded (empty) list as a stale selection', () => {
    localStorage.setItem(KEY, 'example-labs');
    const { result, rerender } = renderHook(({ ids }: { ids: string[] }) => useWorkgroupFilter('u1', ids), {
      initialProps: { ids: [] as string[] },
    });
    expect(result.current[0]).toBe('example-labs');
    expect(localStorage.getItem(KEY)).toBe('example-labs');
    rerender({ ids: ['example-labs'] });
    expect(result.current[0]).toBe('example-labs');
  });

  it('setter writes to localStorage and updates state', () => {
    const { result } = renderHook(() => useWorkgroupFilter('u1', ['example-labs']));
    act(() => result.current[1]('example-labs'));
    expect(result.current[0]).toBe('example-labs');
    expect(localStorage.getItem(KEY)).toBe('example-labs');
  });

  it('setting back to "all" removes the storage key', () => {
    localStorage.setItem(KEY, 'example-labs');
    const { result } = renderHook(() => useWorkgroupFilter('u1', ['example-labs']));
    act(() => result.current[1]('all'));
    expect(result.current[0]).toBe('all');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keys are isolated per user', () => {
    localStorage.setItem(KEY, 'example-labs');
    localStorage.setItem('nc:dash:workgroup_filter:u2', 'example-dev');
    const { result: r1 } = renderHook(() => useWorkgroupFilter('u1', ['example-labs', 'example-dev']));
    const { result: r2 } = renderHook(() => useWorkgroupFilter('u2', ['example-labs', 'example-dev']));
    expect(r1.current[0]).toBe('example-labs');
    expect(r2.current[0]).toBe('example-dev');
  });
});
