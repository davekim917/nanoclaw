import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readPhase } from './rollout-reader.js';
import { classifyError } from './failure-class.js';
import { emitTurnMetric, emitUnhealthyEvent } from './metrics-emit.js';

const execFileP = promisify(execFile);
const GUIDE_PATH = '/home/node/.mnemon/prompt/guide.md';

// Per-session schema-mismatch cache (cycle 2 SF11 — design.md).
// Keyed by store. Populated at SessionStart, read at every UserPromptSubmit/Stop.
type SchemaCheckResult = 'ok' | 'mismatch' | 'unknown';
const schemaCache: Map<string, SchemaCheckResult> = new Map();

// Overrideable for testing — production code never sets this.
let _detectOverride: ((store: string) => Promise<SchemaCheckResult>) | null = null;

async function detectSchemaMismatch(store: string): Promise<SchemaCheckResult> {
  if (_detectOverride) return _detectOverride(store);
  try {
    // mnemon status emits JSON by default (no --json flag).
    const { stdout, stderr } = await execFileP('mnemon', ['status', '--store', store], { timeout: 3000 });
    if (/schema.*(mismatch|version|incompatible)/i.test(stdout + stderr)) return 'mismatch';
    return 'ok';
  } catch (err) {
    const cls = classifyError(err as Error);
    if (cls.reason === 'schema-mismatch') return 'mismatch';
    // binary-missing → treat as mismatch so we block rather than silently proceed
    if (cls.reason === 'binary-missing') return 'mismatch';
    return 'unknown';
  }
}

export function createMnemonPrimeHook(store: string) {
  return async (_input: unknown) => {
    const start = Date.now();
    try {
      const phase = readPhase(store);
      let guide = '';
      try { guide = fs.readFileSync(GUIDE_PATH, 'utf8'); } catch { /* missing guide is recoverable */ }

      // Schema-mismatch detection: run once per session, cache the result (SF11).
      if (!schemaCache.has(store)) {
        const verdict = await detectSchemaMismatch(store);
        schemaCache.set(store, verdict);
        if (verdict === 'mismatch') {
          console.error(`[mnemon] prime BLOCKING: schema-mismatch on store=${store}`);
          emitUnhealthyEvent(store, 'schema-mismatch');
        }
      }

      // On schema mismatch, DO NOT inject the mnemon guide. Telling the agent how to use
      // mnemon when the binary's schema is incompatible would result in commands that fail
      // or silently misbehave; better to skip the guide and let the agent run without
      // mnemon context for this session. The unhealthy event is already emitted above for
      // operator visibility.
      if (schemaCache.get(store) === 'mismatch') {
        return {};
      }

      const phaseNote = phase === 'shadow'
        ? '\n\n[mnemon] Phase 1 shadow — recall not yet active for this group.'
        : '';
      return { hookSpecificOutput: { hookEventName: 'SessionStart' as const, additionalContext: guide + phaseNote } };
    } catch (err) {
      const cls = classifyError(err as Error);
      if (cls.class === 'blocking') {
        console.error(`[mnemon] prime BLOCKING: ${cls.reason}`);
        emitUnhealthyEvent(store, cls.reason);
      } else {
        console.warn(`[mnemon] prime recoverable: ${cls.reason}`);
      }
      return {}; // safe default
    } finally {
      emitTurnMetric({ hook: 'prime', store, latencyMs: Date.now() - start });
    }
  };
}

export function createMnemonRemindHook(store: string) {
  return async (_input: unknown) => {
    const start = Date.now();
    try {
      // Read schema verdict from cache populated at SessionStart (SF11). No re-detection.
      const schemaVerdict = schemaCache.get(store) ?? 'unknown';
      if (schemaVerdict === 'mismatch') {
        // Stay quiet on the hot path — the unhealthy event was already emitted at SessionStart.
        return {};
      }
      const phase = readPhase(store);
      const reminder = phase === 'shadow'
        ? '[mnemon] Phase 1 shadow — only consider remember; recall not yet active. Skip recall this turn.'
        : '[mnemon] Evaluate: recall needed? After responding, evaluate: remember needed?';
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: reminder } };
    } catch (err) {
      const cls = classifyError(err as Error);
      if (cls.class === 'blocking') {
        console.error(`[mnemon] remind BLOCKING: ${cls.reason}`);
        emitUnhealthyEvent(store, cls.reason);
      } else {
        console.warn(`[mnemon] remind recoverable: ${cls.reason}`);
      }
      return {};
    } finally {
      emitTurnMetric({ hook: 'remind', store, latencyMs: Date.now() - start });
    }
  };
}

export function createMnemonNudgeHook(store: string) {
  return async (_input: unknown) => {
    const start = Date.now();
    try {
      // Stop hook is side-effect only (cycle 2 MF3 — SDK does not support additionalContext on Stop).
      emitTurnMetric({ hook: 'nudge', store, latencyMs: Date.now() - start });
      return { continue: true };
    } catch (err) {
      const cls = classifyError(err as Error);
      if (cls.class === 'blocking') {
        console.error(`[mnemon] nudge BLOCKING: ${cls.reason}`);
        emitUnhealthyEvent(store, cls.reason);
      } else {
        console.warn(`[mnemon] nudge recoverable: ${cls.reason}`);
      }
      return { continue: true };
    }
  };
}

// Test-only helpers. Not for production use.
export function __resetSchemaCacheForTesting(): void { schemaCache.clear(); }
export function __setDetectOverrideForTesting(fn: ((store: string) => Promise<SchemaCheckResult>) | null): void {
  _detectOverride = fn;
}
