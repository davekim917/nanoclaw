import { describe, expect, it } from 'vitest';

import {
  formatMemoryMb,
  parseMemoryMb,
  resolveContainerResources,
  type ContainerResourceDefaults,
} from './container-resources.js';
import { DEFAULT_CONTAINER_PIDS_LIMIT } from './config.js';

const defaults: ContainerResourceDefaults = {
  memoryLimit: '3g',
  memoryReservation: '3g',
  memorySwapLimit: '3g',
  cpuLimit: '',
  cpuShares: '',
  pidsLimit: 512,
};

describe('container resource resolution', () => {
  it('test_install_default_pids_limit_leaves_codex_worker_headroom', () => {
    expect(DEFAULT_CONTAINER_PIDS_LIMIT).toBe(1024);
  });

  it('test_resource_defaults_preserve_3gb_compatibility', () => {
    expect(resolveContainerResources(undefined, defaults)).toEqual({
      memory: {
        requestMb: 3072,
        limitMb: 3072,
        memorySwapLimitMb: 3072,
      },
      cpus: undefined,
      cpuShares: undefined,
      pidsLimit: 512,
    });
  });

  it('test_group_resource_override_resolves_5gb_no_swap', () => {
    expect(
      resolveContainerResources(
        {
          memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
        },
        defaults,
      ),
    ).toEqual({
      memory: {
        requestMb: 5120,
        limitMb: 5120,
        memorySwapLimitMb: 5120,
      },
      cpus: undefined,
      cpuShares: undefined,
      pidsLimit: 512,
    });
  });

  it('test_cpu_shares_default_env_applies_when_no_group_override', () => {
    expect(resolveContainerResources(undefined, { ...defaults, cpuShares: '512' }).cpuShares).toBe(512);
  });

  it('test_cpu_shares_group_override_beats_install_default', () => {
    expect(resolveContainerResources({ cpuShares: 2048 }, { ...defaults, cpuShares: '512' }).cpuShares).toBe(2048);
  });

  it('test_cpu_shares_rejects_values_docker_would_reject', () => {
    expect(() => resolveContainerResources({ cpuShares: 1 }, defaults)).toThrow(/between 2 and 262144/);
    expect(() => resolveContainerResources({ cpuShares: 262145 }, defaults)).toThrow(/between 2 and 262144/);
    expect(() => resolveContainerResources({ cpuShares: 1.5 }, defaults)).toThrow(/positive integer/);
  });

  it('test_resource_validation_rejects_request_above_limit', () => {
    expect(() =>
      resolveContainerResources({ memory: { requestMb: 4096, limitMb: 3072, memorySwapLimitMb: 4096 } }, defaults),
    ).toThrow(/requestMb.*limitMb/);
  });

  it('test_resource_validation_rejects_swap_total_below_limit', () => {
    expect(() =>
      resolveContainerResources({ memory: { requestMb: 3072, limitMb: 4096, memorySwapLimitMb: 3072 } }, defaults),
    ).toThrow(/memorySwapLimitMb.*limitMb/);
  });

  it('test_memory_size_parser_uses_binary_docker_units', () => {
    expect(parseMemoryMb('3g')).toBe(3072);
    expect(parseMemoryMb('5120m')).toBe(5120);
    expect(parseMemoryMb('1.5g')).toBe(1536);
    expect(formatMemoryMb(5120)).toBe('5g');
    expect(formatMemoryMb(3584)).toBe('3584m');
  });
});
