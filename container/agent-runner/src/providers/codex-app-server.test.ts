import { describe, it, expect } from 'bun:test';

import { buildCodexHooksJson } from './codex-app-server.js';

describe('buildCodexHooksJson', () => {
  it('emits a PreToolUse and PostToolUse entry with command type', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse).toHaveLength(1);
    expect(data.hooks.PostToolUse).toHaveLength(1);
    expect(data.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(data.hooks.PostToolUse[0].hooks[0].type).toBe('command');
  });

  it('points commands at /app/src/codex-hooks/cli.ts via bun', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe('bun /app/src/codex-hooks/cli.ts PreToolUse');
    expect(data.hooks.PostToolUse[0].hooks[0].command).toBe('bun /app/src/codex-hooks/cli.ts PostToolUse');
  });

  it('defaults PreToolUse timeout to 3600s (1h, for email-gate approval wait)', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PreToolUse[0].hooks[0].timeout).toBe(3600);
  });

  it('honors emailGateTimeoutSec override on PreToolUse', () => {
    const data = buildCodexHooksJson({ emailGateTimeoutSec: 7200 });
    expect(data.hooks.PreToolUse[0].hooks[0].timeout).toBe(7200);
  });

  it('PostToolUse uses a short 30s timeout', () => {
    const data = buildCodexHooksJson();
    expect(data.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);
  });
});
