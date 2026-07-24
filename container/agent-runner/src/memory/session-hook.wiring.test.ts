import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('provider memory lifecycle wiring', () => {
  const providerSources = Object.fromEntries(
    ['claude', 'codex', 'opencode'].map((name) => [
      name,
      fs.readFileSync(path.join(import.meta.dir, '..', 'providers', `${name}.ts`), 'utf-8'),
    ]),
  );
  const runnerSource = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');
  const providerTypesSource = fs.readFileSync(path.join(import.meta.dir, '..', 'providers', 'types.ts'), 'utf-8');
  const codexAppServerSource = fs.readFileSync(
    path.join(import.meta.dir, '..', 'providers', 'codex-app-server.ts'),
    'utf-8',
  );
  const groupInitSource = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', '..', '..', 'src', 'group-init.ts'),
    'utf-8',
  );

  it('requires and registers the shared lifecycle contract for every provider', () => {
    expect(runnerSource).toMatch(/provider\.registerMemorySessionHook\(MEMORY_SESSION_HOOK\)/);
    expect(providerTypesSource).toMatch(/registerMemorySessionHook\(hook: MemorySessionHookRegistration\): void/);
    for (const source of Object.values(providerSources)) {
      expect(source).toMatch(/registerMemorySessionHook\(hook: MemorySessionHookRegistration\)/);
      expect(source).toContain('memorySessionHook');
    }
  });

  it('uses one authoritative file-memory path and disables Codex opaque memory', () => {
    expect(providerSources.claude).not.toContain('memorySessionStartHook');
    expect(providerSources.claude).not.toContain('providesMemorySessionHook');
    expect(providerSources.codex).toMatch(/memoryContextForSessionStart\('startup'\)/);
    expect(providerSources.opencode).toMatch(/memoryContextForSessionStart\('startup'\)/);
    expect(codexAppServerSource).toContain("'memories.generate_memories=false'");
    expect(codexAppServerSource).toContain("'memories.use_memories=false'");
    expect(groupInitSource).not.toContain('MEMORY_SESSION_START_MATCHER');
  });
});
