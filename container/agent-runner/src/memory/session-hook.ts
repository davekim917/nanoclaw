import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource | 'resume';

export interface MemorySessionHookRegistration {
  readonly command: string;
  /**
   * The module `command` runs. It exists only inside the agent container, so its
   * presence is what tells us we are writing container settings and not a
   * developer's host config — see the guard in `writeMemorySessionHook`.
   */
  readonly modulePath: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly MemorySessionHookSource[];
}

export const MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: 'bun /app/src/memory/hook.ts',
  modulePath: '/app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: MEMORY_CONTEXT_SOURCES,
};

/** Return memory only when a provider is establishing a new context window. */
export function memoryContextForSessionStart(source: MemorySessionStartSource, baseDir?: string): string | undefined {
  return source === 'resume' ? undefined : renderMemorySection(baseDir);
}
