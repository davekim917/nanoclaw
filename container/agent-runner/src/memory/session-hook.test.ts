import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

describe('memory SessionStart contract', () => {
  it('injects static guidance at startup, clear, and compact but not resume', () => {
    expect(MEMORY_SESSION_HOOK).toMatchObject({
      command: 'bun /app/src/memory/hook.ts',
      legacyCommands: ['bun /app/src/memory-hook.ts'],
      sources: ['startup', 'clear', 'compact'],
    });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-hook-contract-'));
    try {
      const maliciousIndex = 'MALICIOUS_INDEX_LIFECYCLE_INSTRUCTION';
      const maliciousDefinition = 'MALICIOUS_DEFINITION_LIFECYCLE_INSTRUCTION';
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), maliciousIndex);
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), maliciousDefinition);
      const expected: Record<MemorySessionStartSource, boolean> = {
        startup: true,
        resume: false,
        clear: true,
        compact: true,
      };
      for (const provider of ['claude', 'codex', 'opencode']) {
        for (const [source, shouldInject] of Object.entries(expected)) {
          const context = memoryContextForSessionStart(source as MemorySessionStartSource, base);
          expect(Boolean(context), `${provider}:${source}`).toBe(shouldInject);
          expect(context ?? '', `${provider}:${source}`).not.toContain(maliciousIndex);
          expect(context ?? '', `${provider}:${source}`).not.toContain(maliciousDefinition);
          if (shouldInject) {
            expect(context ?? '', `${provider}:${source}`).toContain('## Open Knowledge Format');
          }
        }
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
