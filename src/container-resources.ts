import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_MEMORY_RESERVATION,
  CONTAINER_MEMORY_SWAP_LIMIT,
  CONTAINER_PIDS_LIMIT,
} from './config.js';

export interface ContainerMemoryResources {
  requestMb?: number;
  limitMb?: number;
  /** Docker --memory-swap total (RAM + swap), not swap-only bytes. */
  memorySwapLimitMb?: number;
}

export interface ContainerResources {
  memory?: ContainerMemoryResources;
  cpus?: number;
  pidsLimit?: number;
}

export interface EffectiveContainerResources {
  memory: {
    requestMb: number;
    limitMb: number;
    memorySwapLimitMb: number;
  };
  cpus: number | undefined;
  pidsLimit: number;
}

export interface ContainerResourceDefaults {
  memoryLimit: string;
  memoryReservation: string;
  memorySwapLimit: string;
  cpuLimit: string;
  pidsLimit: number;
}

export function installContainerResourceDefaults(): ContainerResourceDefaults {
  return {
    memoryLimit: CONTAINER_MEMORY_LIMIT,
    memoryReservation: CONTAINER_MEMORY_RESERVATION,
    memorySwapLimit: CONTAINER_MEMORY_SWAP_LIMIT,
    cpuLimit: CONTAINER_CPU_LIMIT,
    pidsLimit: CONTAINER_PIDS_LIMIT,
  };
}

export function parseMemoryMb(value: string): number {
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/.exec(normalized);
  if (!match) throw new Error(`Invalid memory size: ${JSON.stringify(value)}`);

  const amount = Number(match[1]);
  const unit = match[2] ?? 'm';
  const multipliers: Record<string, number> = {
    b: 1 / (1024 * 1024),
    k: 1 / 1024,
    kb: 1 / 1024,
    kib: 1 / 1024,
    m: 1,
    mb: 1,
    mib: 1,
    g: 1024,
    gb: 1024,
    gib: 1024,
    t: 1024 * 1024,
    tb: 1024 * 1024,
    tib: 1024 * 1024,
  };
  const mb = amount * multipliers[unit];
  if (!Number.isFinite(mb) || mb <= 0) throw new Error(`Memory size must be positive: ${JSON.stringify(value)}`);
  return Math.ceil(mb);
}

export function formatMemoryMb(mb: number): string {
  if (!Number.isInteger(mb) || mb <= 0) throw new Error(`Memory MiB must be a positive integer: ${mb}`);
  return mb % 1024 === 0 ? `${mb / 1024}g` : `${mb}m`;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

export function resolveContainerResources(
  declared?: ContainerResources,
  defaults: ContainerResourceDefaults = installContainerResourceDefaults(),
): EffectiveContainerResources {
  const defaultLimitMb = parseMemoryMb(defaults.memoryLimit);
  const limitMb =
    declared?.memory?.limitMb === undefined
      ? defaultLimitMb
      : positiveInteger(declared.memory.limitMb, 'resources.memory.limitMb');
  const requestMb =
    declared?.memory?.requestMb === undefined
      ? declared?.memory?.limitMb === undefined
        ? parseMemoryMb(defaults.memoryReservation)
        : limitMb
      : positiveInteger(declared.memory.requestMb, 'resources.memory.requestMb');
  const memorySwapLimitMb =
    declared?.memory?.memorySwapLimitMb === undefined
      ? declared?.memory?.limitMb === undefined
        ? parseMemoryMb(defaults.memorySwapLimit)
        : limitMb
      : positiveInteger(declared.memory.memorySwapLimitMb, 'resources.memory.memorySwapLimitMb');

  if (requestMb > limitMb) {
    throw new Error('resources.memory.requestMb must be less than or equal to resources.memory.limitMb');
  }
  if (memorySwapLimitMb < limitMb) {
    throw new Error('resources.memory.memorySwapLimitMb must be greater than or equal to resources.memory.limitMb');
  }

  const defaultCpu = defaults.cpuLimit.trim();
  const cpus =
    declared?.cpus === undefined
      ? defaultCpu
        ? positiveNumber(Number(defaultCpu), 'CONTAINER_CPU_LIMIT')
        : undefined
      : positiveNumber(declared.cpus, 'resources.cpus');
  const pidsLimit =
    declared?.pidsLimit === undefined
      ? positiveInteger(defaults.pidsLimit, 'CONTAINER_PIDS_LIMIT')
      : positiveInteger(declared.pidsLimit, 'resources.pidsLimit');

  return {
    memory: { requestMb, limitMb, memorySwapLimitMb },
    cpus,
    pidsLimit,
  };
}

export function validateContainerResources(resources: ContainerResources | undefined): void {
  resolveContainerResources(resources);
}
