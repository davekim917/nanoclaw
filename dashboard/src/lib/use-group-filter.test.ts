import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupFilter } from './use-group-filter.js';

describe('useGroupFilter', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to "all" when nothing is stored', () => {
    const { result } = renderHook(() => useGroupFilter('u1', ['ag-1'], false));
    expect(result.current[0]).toBe('all');
  });

  it('hydrates a stored value if it is in allowedIds', () => {
    localStorage.setItem('nc:dash:group_filter:u1', 'ag-1');
    const { result } = renderHook(() => useGroupFilter('u1', ['ag-1', 'ag-2'], false));
    expect(result.current[0]).toBe('ag-1');
  });

  it('falls back to "all" if stored id is no longer in allowedIds', () => {
    localStorage.setItem('nc:dash:group_filter:u1', 'ag-stale');
    const { result } = renderHook(() => useGroupFilter('u1', ['ag-1', 'ag-2'], false));
    expect(result.current[0]).toBe('all');
    expect(localStorage.getItem('nc:dash:group_filter:u1')).toBeNull();
  });

  it('owners (no_filter) hydrate any stored value even if not in allowedIds', () => {
    localStorage.setItem('nc:dash:group_filter:owner', 'ag-99');
    const { result } = renderHook(() => useGroupFilter('owner', [], true));
    expect(result.current[0]).toBe('ag-99');
  });

  it('setter writes to localStorage and updates state', () => {
    const { result } = renderHook(() => useGroupFilter('u1', ['ag-1'], false));
    act(() => result.current[1]('ag-1'));
    expect(result.current[0]).toBe('ag-1');
    expect(localStorage.getItem('nc:dash:group_filter:u1')).toBe('ag-1');
  });

  it('setting back to "all" removes the storage key', () => {
    localStorage.setItem('nc:dash:group_filter:u1', 'ag-1');
    const { result } = renderHook(() => useGroupFilter('u1', ['ag-1'], false));
    act(() => result.current[1]('all'));
    expect(result.current[0]).toBe('all');
    expect(localStorage.getItem('nc:dash:group_filter:u1')).toBeNull();
  });

  it('keys are isolated per user', () => {
    localStorage.setItem('nc:dash:group_filter:u1', 'ag-1');
    localStorage.setItem('nc:dash:group_filter:u2', 'ag-2');
    const { result: r1 } = renderHook(() => useGroupFilter('u1', ['ag-1', 'ag-2'], false));
    const { result: r2 } = renderHook(() => useGroupFilter('u2', ['ag-1', 'ag-2'], false));
    expect(r1.current[0]).toBe('ag-1');
    expect(r2.current[0]).toBe('ag-2');
  });
});
