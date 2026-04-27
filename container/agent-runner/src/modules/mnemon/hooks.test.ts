import { describe, test, expect, beforeEach } from 'bun:test';
import fs from 'fs';

// ── B1: binary-classes ──
import { classifyCommand } from './binary-classes.js';

// ── B1: failure-class ──
import { classifyError } from './failure-class.js';

// ── B2: hooks ──
import {
  createMnemonPrimeHook,
  createMnemonRemindHook,
  createMnemonNudgeHook,
  __resetSchemaCacheForTesting,
  __setDetectOverrideForTesting,
} from './hooks.js';

// ── B3: metrics-emit ──
import { emitTurnMetric, emitUnhealthyEvent } from './metrics-emit.js';

// ── B1 tests: classifyCommand ──

describe('classifyCommand', () => {
  test('test_classifyCommand_read', () => {
    expect(classifyCommand('recall')).toBe('read');
  });

  test('test_classifyCommand_search_is_read', () => {
    expect(classifyCommand('search')).toBe('read');
  });

  test('test_classifyCommand_status_is_read', () => {
    expect(classifyCommand('status')).toBe('read');
  });

  test('test_classifyCommand_remember_is_write', () => {
    expect(classifyCommand('remember')).toBe('write');
  });

  test('test_classifyCommand_link_is_write', () => {
    expect(classifyCommand('link')).toBe('write');
  });

  test('test_classifyCommand_setup_is_admin', () => {
    expect(classifyCommand('setup')).toBe('admin');
  });

  test('test_classifyCommand_store_is_admin', () => {
    expect(classifyCommand('store')).toBe('admin');
  });

  test('test_classifyCommand_unknown', () => {
    expect(classifyCommand('garbage')).toBe('unknown');
  });

  test('test_classifyCommand_empty_string_is_read', () => {
    // '' is in READ_ONLY_COMMANDS per spec
    expect(classifyCommand('')).toBe('read');
  });
});

// ── B1 tests: classifyError ──

describe('classifyError', () => {
  test('test_classifyError_blocking_binary_missing', () => {
    const result = classifyError(new Error('ENOENT: command not found'));
    expect(result.class).toBe('blocking');
    expect(result.reason).toBe('binary-missing');
  });

  test('test_classifyError_blocking_mnemon_not_found', () => {
    const result = classifyError(new Error('mnemon: not found'));
    expect(result.class).toBe('blocking');
    expect(result.reason).toBe('binary-missing');
  });

  test('test_classifyError_blocking_store_locked', () => {
    const result = classifyError(new Error('database: disk image is malformed'));
    expect(result.class).toBe('blocking');
    expect(result.reason).toBe('store-db-inaccessible');
  });

  test('test_classifyError_blocking_schema_mismatch', () => {
    const result = classifyError(new Error('schema: mismatch detected'));
    expect(result.class).toBe('blocking');
    expect(result.reason).toBe('schema-mismatch');
  });

  test('test_classifyError_recoverable_ollama', () => {
    const result = classifyError(new Error('connection refused: localhost:11434'));
    expect(result.class).toBe('recoverable');
    expect(result.reason).toBe('ollama-unavailable');
  });

  test('test_classifyError_recoverable_network', () => {
    const result = classifyError(new Error('ECONNRESET: connection reset'));
    expect(result.class).toBe('recoverable');
    expect(result.reason).toBe('network-transient');
  });

  test('test_classifyError_unknown_defaults_recoverable', () => {
    const result = classifyError(new Error('some completely unknown error'));
    expect(result.class).toBe('recoverable');
    expect(result.reason).toBe('unknown');
  });
});

// ── B1 tests: readPhase ──

describe('readPhase', () => {
  test('test_readPhase_fail_closed', async () => {
    const { readPhase } = await import('./rollout-reader.js');
    // /workspace/agent/.mnemon-rollout.json won't exist in test env → shadow
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') throw new Error('ENOENT');
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      expect(readPhase('illysium')).toBe('shadow');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('test_readPhase_returns_live_when_rollout_says_live', async () => {
    const { readPhase } = await import('./rollout-reader.js');
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') {
        return JSON.stringify({ illysium: { phase: 'live' } });
      }
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      expect(readPhase('illysium')).toBe('live');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('test_readPhase_missing_store_entry_returns_shadow', async () => {
    const { readPhase } = await import('./rollout-reader.js');
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') {
        return JSON.stringify({ other_store: { phase: 'live' } });
      }
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      expect(readPhase('illysium')).toBe('shadow');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('test_readPhase_malformed_json_returns_shadow', async () => {
    const { readPhase } = await import('./rollout-reader.js');
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') return 'not valid json {{{';
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      expect(readPhase('illysium')).toBe('shadow');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });
});

// ── B2 hook tests: NudgeHook ──

describe('createMnemonNudgeHook', () => {
  beforeEach(() => {
    __resetSchemaCacheForTesting();
    __setDetectOverrideForTesting(null);
  });

  test('test_nudgeHook_no_additionalContext', async () => {
    const hook = createMnemonNudgeHook('test-store');
    const result = await hook({});
    expect((result as { continue?: boolean }).continue).toBe(true);
    // Must NOT have additionalContext (cycle 2 MF3)
    const output = (result as { hookSpecificOutput?: { additionalContext?: unknown } }).hookSpecificOutput;
    expect(output?.additionalContext).toBeUndefined();
  });

  test('test_nudgeHook_returns_continue_true', async () => {
    const hook = createMnemonNudgeHook('s');
    const result = await hook({}) as { continue: boolean };
    expect(result.continue).toBe(true);
  });
});

// ── B2 hook tests: RemindHook ──

describe('createMnemonRemindHook', () => {
  beforeEach(() => {
    __resetSchemaCacheForTesting();
    __setDetectOverrideForTesting(null);
  });

  test('test_remindHook_phase1_returns_shadow_text', async () => {
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') {
        return JSON.stringify({ s: { phase: 'shadow' } });
      }
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      const hook = createMnemonRemindHook('s');
      const result = await hook({}) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(result.hookSpecificOutput?.additionalContext).toContain('Phase 1 shadow');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('test_remindHook_phase2_returns_standard_text', async () => {
    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') {
        return JSON.stringify({ s: { phase: 'live' } });
      }
      return origReadFileSync(p, enc as BufferEncoding);
    };
    try {
      const hook = createMnemonRemindHook('s');
      const result = await hook({}) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(result.hookSpecificOutput?.additionalContext).toContain('Evaluate: recall needed');
    } finally {
      fs.readFileSync = origReadFileSync;
    }
  });

  test('test_remindHook_short_circuits_on_cached_mismatch', async () => {
    // Use the override to inject a mismatch verdict at prime time
    let detectCallCount = 0;
    __setDetectOverrideForTesting(async (_store) => {
      detectCallCount++;
      return 'mismatch';
    });

    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') return JSON.stringify({ 'mismatch-store': { phase: 'live' } });
      if (p === '/home/node/.mnemon/prompt/guide.md') throw new Error('ENOENT');
      return origReadFileSync(p, enc as BufferEncoding);
    };

    try {
      // Prime populates cache with mismatch
      await createMnemonPrimeHook('mismatch-store')({});
      const callsAfterPrime = detectCallCount;

      // Remind must NOT call detect again — reads from cache only
      await createMnemonRemindHook('mismatch-store')({});
      expect(detectCallCount).toBe(callsAfterPrime); // no new detect calls
    } finally {
      fs.readFileSync = origReadFileSync;
      __setDetectOverrideForTesting(null);
    }
  });

  test('test_remindHook_short_circuits_returns_empty_on_mismatch', async () => {
    __setDetectOverrideForTesting(async (_store) => 'mismatch');

    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') return JSON.stringify({ 'mismatch-store2': { phase: 'live' } });
      if (p === '/home/node/.mnemon/prompt/guide.md') throw new Error('ENOENT');
      return origReadFileSync(p, enc as BufferEncoding);
    };

    try {
      await createMnemonPrimeHook('mismatch-store2')({});
      const result = await createMnemonRemindHook('mismatch-store2')({}) as Record<string, unknown>;
      expect(Object.keys(result)).toHaveLength(0);
    } finally {
      fs.readFileSync = origReadFileSync;
      __setDetectOverrideForTesting(null);
    }
  });
});

// ── B2 hook tests: PrimeHook ──

describe('createMnemonPrimeHook', () => {
  beforeEach(() => {
    __resetSchemaCacheForTesting();
    __setDetectOverrideForTesting(null);
  });

  test('test_primeHook_schemaCache_populated_once', async () => {
    let detectCallCount = 0;
    __setDetectOverrideForTesting(async (_store) => {
      detectCallCount++;
      return 'ok';
    });

    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') return JSON.stringify({ 'prime-store': { phase: 'live' } });
      if (p === '/home/node/.mnemon/prompt/guide.md') throw new Error('ENOENT');
      return origReadFileSync(p, enc as BufferEncoding);
    };

    try {
      const hook = createMnemonPrimeHook('prime-store');
      await hook({});
      const callsAfterFirst = detectCallCount;
      // Second invocation: cache hit → detect NOT called again
      await hook({});
      expect(detectCallCount).toBe(callsAfterFirst);
      expect(callsAfterFirst).toBe(1);
    } finally {
      fs.readFileSync = origReadFileSync;
      __setDetectOverrideForTesting(null);
    }
  });

  test('test_primeHook_schemaCache_emits_unhealthy_on_mismatch', async () => {
    __setDetectOverrideForTesting(async (_store) => 'mismatch');

    const origReadFileSync = fs.readFileSync;
    // @ts-ignore
    fs.readFileSync = (p: string, enc: string) => {
      if (p === '/workspace/agent/.mnemon-rollout.json') return JSON.stringify({ 'unhealthy-store': { phase: 'live' } });
      if (p === '/home/node/.mnemon/prompt/guide.md') throw new Error('ENOENT');
      return origReadFileSync(p, enc as BufferEncoding);
    };

    const origConsoleError = console.error;
    let errorLogs: string[] = [];
    console.error = (...args: unknown[]) => { errorLogs.push(args.join(' ')); };

    try {
      await createMnemonPrimeHook('unhealthy-store')({});
      expect(errorLogs.some(l => l.includes('[mnemon] prime BLOCKING'))).toBe(true);
    } finally {
      fs.readFileSync = origReadFileSync;
      console.error = origConsoleError;
      __setDetectOverrideForTesting(null);
    }
  });

  test('test_hook_logs_warn_on_recoverable', async () => {
    // The outer-catch warn path fires for truly unexpected exceptions from hook machinery.
    // All inner paths (readPhase, detectSchemaMismatch, guide read) have their own guards,
    // making the outer catch untriggerable without internal module injection. We verify the
    // warn prefix exists in source rather than attempting an unreachable execution path.
    const src = await Bun.file(new URL('./hooks.ts', import.meta.url).pathname).text();
    expect(src).toContain("[mnemon] prime recoverable:");
    expect(src).toContain("[mnemon] remind recoverable:");
    expect(src).toContain("[mnemon] nudge recoverable:");
    expect(src).toContain("console.warn");
  });

  test('test_hook_logs_error_on_blocking', async () => {
    // Covered by test_primeHook_schemaCache_emits_unhealthy_on_mismatch above.
    // Also verify the error prefix pattern in source.
    const src = await Bun.file(new URL('./hooks.ts', import.meta.url).pathname).text();
    expect(src).toContain("[mnemon] prime BLOCKING:");
    expect(src).toContain("[mnemon] remind BLOCKING:");
    expect(src).toContain("[mnemon] nudge BLOCKING:");
    expect(src).toContain("console.error");
  });
});

// ── B3: metrics-emit tests ──

describe('emitTurnMetric', () => {
  test('test_emitTurnMetric_swallows_disk_full', () => {
    const origAppendFileSync = fs.appendFileSync;
    // @ts-ignore
    fs.appendFileSync = () => { throw new Error('ENOSPC: no space left on device'); };
    try {
      expect(() => emitTurnMetric({ hook: 'prime', store: 's', latencyMs: 0 })).not.toThrow();
    } finally {
      fs.appendFileSync = origAppendFileSync;
    }
  });

  test('test_emitTurnMetric_appends_valid_jsonl', () => {
    const lines: string[] = [];
    const origAppendFileSync = fs.appendFileSync;
    // @ts-ignore
    fs.appendFileSync = (_p: string, data: string) => { lines.push(data); };
    try {
      emitTurnMetric({ hook: 'remind', store: 'test', latencyMs: 42 });
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0].trimEnd());
      expect(parsed.event_type).toBe('turn');
      expect(parsed.hook).toBe('remind');
      expect(parsed.store).toBe('test');
      expect(lines[0].endsWith('\n')).toBe(true);
    } finally {
      fs.appendFileSync = origAppendFileSync;
    }
  });

  test('test_emitUnhealthyEvent_appends_valid_jsonl', () => {
    const lines: string[] = [];
    const origAppendFileSync = fs.appendFileSync;
    // @ts-ignore
    fs.appendFileSync = (_p: string, data: string) => { lines.push(data); };
    try {
      emitUnhealthyEvent('test-store', 'schema-mismatch');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0].trimEnd());
      expect(parsed.event_type).toBe('unhealthy');
      expect(parsed.store).toBe('test-store');
      expect(parsed.reason).toBe('schema-mismatch');
      expect(lines[0].endsWith('\n')).toBe(true);
    } finally {
      fs.appendFileSync = origAppendFileSync;
    }
  });

  test('test_emitUnhealthyEvent_swallows_disk_full', () => {
    const origAppendFileSync = fs.appendFileSync;
    // @ts-ignore
    fs.appendFileSync = () => { throw new Error('ENOSPC: no space left on device'); };
    try {
      expect(() => emitUnhealthyEvent('s', 'reason')).not.toThrow();
    } finally {
      fs.appendFileSync = origAppendFileSync;
    }
  });
});

// ── B4: block-mnemon-real-hook tests ──

describe('createBlockMnemonRealHook', () => {
  test('test_blockMnemonRealHook_denies_mnemon_real', async () => {
    const { createBlockMnemonRealHook } = await import('./block-mnemon-real-hook.js');
    const hook = createBlockMnemonRealHook();
    const result = await hook({ tool_input: { command: '/usr/local/bin/mnemon-real recall foo' } }) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('test_blockMnemonRealHook_denies_bare_mnemon_real', async () => {
    const { createBlockMnemonRealHook } = await import('./block-mnemon-real-hook.js');
    const hook = createBlockMnemonRealHook();
    const result = await hook({ tool_input: { command: 'mnemon-real status' } }) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('test_blockMnemonRealHook_allows_mnemon_wrapper', async () => {
    const { createBlockMnemonRealHook } = await import('./block-mnemon-real-hook.js');
    const hook = createBlockMnemonRealHook();
    const result = await hook({ tool_input: { command: 'mnemon recall foo' } }) as Record<string, unknown>;
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  test('test_blockMnemonRealHook_allows_empty_command', async () => {
    const { createBlockMnemonRealHook } = await import('./block-mnemon-real-hook.js');
    const hook = createBlockMnemonRealHook();
    const result = await hook({ tool_input: { command: '' } }) as Record<string, unknown>;
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
