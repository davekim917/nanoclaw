/**
 * Provider self-registration registry.
 *
 * Mirrors `src/channels/channel-registry.ts` on the host. Each provider module
 * calls `registerProvider()` at top level; the barrel (`providers/index.ts`)
 * imports every provider module for its side effect so registrations fire
 * before `createProvider()` is called.
 */
import { z } from 'zod';
import type { AgentProvider, ProviderOptions } from './types.js';

export type ProviderFactory = (options: ProviderOptions) => AgentProvider;

const registry = new Map<string, ProviderFactory>();
const schemaRegistry = new Map<string, z.ZodType>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  if (registry.has(name)) {
    throw new Error(`Provider already registered: ${name}`);
  }
  registry.set(name, factory);
}

export function getProviderFactory(name: string): ProviderFactory {
  const factory = registry.get(name);
  if (!factory) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return factory;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}

export function registerProviderConfigSchema(name: string, schema: z.ZodType): void {
  if (schemaRegistry.has(name)) {
    throw new Error(`Provider config schema already registered: ${name}`);
  }
  schemaRegistry.set(name, schema);
}

export function getProviderConfigSchema(name: string): z.ZodType | undefined {
  return schemaRegistry.get(name);
}

export type ProviderConfigValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export function validateProviderConfig(name: string, input: unknown): ProviderConfigValidation {
  const schema = schemaRegistry.get(name) ?? z.strictObject({});
  const normalized = input === undefined ? {} : input;
  const result = schema.safeParse(normalized);
  if (result.success) {
    return { ok: true, data: result.data as Record<string, unknown> };
  }
  const error = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error };
}
