import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';

import {
  _resetOpenCodeAuthCacheForTesting,
  buildOpenCodeConfig,
  parseLimitEnv,
  resolveModelLimit,
  resolveModelModalities,
} from './opencode.js';

const GUARD_PLUGIN = '/workspace/plugins/bootstrap/plugins/workflow/hooks/guards/opencode-guard.ts';

const spies: Array<{ mockRestore: () => void }> = [];

function stubGuardPresent(): void {
  spies.push(spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => String(p) === GUARD_PLUGIN));
}

const CAPABILITY_VARS = [
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
];

beforeEach(() => {
  _resetOpenCodeAuthCacheForTesting();
  process.env.OPENCODE_MODEL = 'nvidia/test-model';
  delete process.env.OPENCODE_SMALL_MODEL;
  delete process.env.OPENCODE_PROVIDER;
  delete process.env.OPENCODE_EFFORT;
  delete process.env.OPENCODE_ALLOW_UNGUARDED;
  for (const v of CAPABILITY_VARS) delete process.env[v];
});

afterEach(() => {
  _resetOpenCodeAuthCacheForTesting();
  for (const s of spies.splice(0)) s.mockRestore();
  for (const v of CAPABILITY_VARS) delete process.env[v];
});

function mainModelEntry(): Record<string, unknown> | undefined {
  const cfg = buildOpenCodeConfig({}, {}) as {
    provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
  };
  return cfg.provider?.nvidia?.models?.['test-model'];
}

describe('parseLimitEnv', () => {
  it('accepts a bare positive integer', () => {
    expect(parseLimitEnv('X', '128000')).toBe(128000);
    expect(parseLimitEnv('X', '  128000 ')).toBe(128000);
  });

  it('test_oc_limit_rejects_units_and_zero: rejects everything that Number() would silently coerce', () => {
    // "64k" -> NaN, which makes the emitted config unparseable JSON and stops
    // OpenCode booting. "" and "0" -> 0, which is the exact value that silently
    // disables compaction. Both are treated as unset instead.
    expect(parseLimitEnv('X', '64k')).toBeUndefined();
    expect(parseLimitEnv('X', '')).toBeUndefined();
    expect(parseLimitEnv('X', '   ')).toBeUndefined();
    expect(parseLimitEnv('X', '0')).toBeUndefined();
    expect(parseLimitEnv('X', '-5')).toBeUndefined();
    expect(parseLimitEnv('X', '1.5')).toBeUndefined();
  });

  it('an unset var is undefined, not an error', () => {
    expect(parseLimitEnv('X', undefined)).toBeUndefined();
  });
});

describe('resolveModelLimit', () => {
  it('test_oc_limit_requires_both_halves: emits nothing unless context AND output are valid', () => {
    // opencode 1.18.x's config schema is
    // `limit: optional(Struct({context: Finite, input: optional(Finite), output: Finite}))`
    // — a `limit` carrying only `context` fails validation and takes the WHOLE
    // config down, MCP servers and guard plugin included. Verified live against
    // opencode 1.18.18: a context-only limit exits 1 with "Missing key
    // provider.<p>.models.<m>.limit.output"; adding the output limit loads.
    expect(resolveModelLimit({ OPENCODE_MODEL_CONTEXT_LIMIT: '128000' })).toBeUndefined();
    expect(resolveModelLimit({ OPENCODE_MODEL_OUTPUT_LIMIT: '8192' })).toBeUndefined();
    expect(
      resolveModelLimit({ OPENCODE_MODEL_CONTEXT_LIMIT: '128000', OPENCODE_MODEL_OUTPUT_LIMIT: '64k' }),
    ).toBeUndefined();
    expect(resolveModelLimit({ OPENCODE_MODEL_CONTEXT_LIMIT: '128000', OPENCODE_MODEL_OUTPUT_LIMIT: '8192' })).toEqual({
      context: 128000,
      output: 8192,
    });
  });

  it('unset on both halves is undefined', () => {
    expect(resolveModelLimit({})).toBeUndefined();
  });
});

describe('resolveModelModalities', () => {
  it('test_oc_modalities_normalize: trims, lowercases, dedupes and always leads with text', () => {
    expect(resolveModelModalities({ OPENCODE_MODEL_INPUT_MODALITIES: ' Image , pdf ,image ' })).toEqual({
      input: ['text', 'image', 'pdf'],
      output: ['text'],
    });
  });

  it('test_oc_modalities_reject_unknown: drops entries opencode does not accept', () => {
    // An unknown modality makes OpenCode reject the whole config.
    expect(resolveModelModalities({ OPENCODE_MODEL_INPUT_MODALITIES: 'image,hologram' })).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(resolveModelModalities({ OPENCODE_MODEL_INPUT_MODALITIES: 'hologram' })).toBeUndefined();
  });

  it('text alone declares nothing — it is already the baseline', () => {
    expect(resolveModelModalities({ OPENCODE_MODEL_INPUT_MODALITIES: 'text' })).toBeUndefined();
    expect(resolveModelModalities({})).toBeUndefined();
  });
});

describe('buildOpenCodeConfig — model capability declarations', () => {
  it('test_oc_limits_absent_by_default: emits no limit/modalities keys when nothing is declared', () => {
    stubGuardPresent();
    const entry = mainModelEntry();
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('limit');
    expect(entry).not.toHaveProperty('modalities');
    expect(entry).not.toHaveProperty('attachment');
  });

  it('test_oc_limits_declared_on_main_model: declares limit + modalities on the effective model', () => {
    stubGuardPresent();
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '128000';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image,pdf';
    const entry = mainModelEntry();
    expect(entry?.limit).toEqual({ context: 128000, output: 8192 });
    expect(entry?.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] });
    expect(entry?.attachment).toBe(true);
    // Effort/tool_call registration is untouched.
    expect(entry?.tool_call).toBe(true);
  });

  it('test_oc_limits_not_on_small_model: a distinct small model gets a bare entry', () => {
    // The env vars name no small-model equivalent, so spreading the main
    // model's context window and media support onto it would be a lie.
    stubGuardPresent();
    process.env.OPENCODE_SMALL_MODEL = 'nvidia/test-small';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '128000';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image';
    const cfg = buildOpenCodeConfig({}, {}) as {
      provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
    };
    const small = cfg.provider?.nvidia?.models?.['test-small'];
    expect(small).toEqual({ id: 'test-small', name: 'test-small', tool_call: true });
    expect(cfg.provider?.nvidia?.models?.['test-model']?.limit).toEqual({ context: 128000, output: 8192 });
  });

  it('test_oc_limits_follow_configured_model_not_turn_override: a `-m` switch does not inherit them', () => {
    // The env vars describe the model the operator measured — the group's
    // configured default. A per-turn `-m` selects a different model, and with
    // effort active runtimeConfigKey rebuilds the runtime, so inheriting these
    // would declare the configured model's context window and media support on
    // a model that has neither: premature or absent compaction, and modality
    // claims the backend rejects.
    stubGuardPresent();
    process.env.OPENCODE_MODEL = 'nvidia/test-model';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '128000';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    process.env.OPENCODE_MODEL_INPUT_MODALITIES = 'image';

    const cfg = buildOpenCodeConfig({}, { model: 'nvidia/other-model' }) as {
      provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
    };
    const overridden = cfg.provider?.nvidia?.models?.['other-model'];
    expect(overridden).toEqual({ id: 'other-model', name: 'other-model', tool_call: true });
    expect(overridden).not.toHaveProperty('limit');
    expect(overridden).not.toHaveProperty('modalities');
  });

  it('a `-m` that names the configured model still gets the declarations', () => {
    stubGuardPresent();
    process.env.OPENCODE_MODEL = 'nvidia/test-model';
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '128000';
    process.env.OPENCODE_MODEL_OUTPUT_LIMIT = '8192';
    const cfg = buildOpenCodeConfig({}, { model: 'nvidia/test-model' }) as {
      provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
    };
    expect(cfg.provider?.nvidia?.models?.['test-model']?.limit).toEqual({ context: 128000, output: 8192 });
  });

  it('test_oc_limits_half_set_is_dropped: a context limit with no output limit emits nothing', () => {
    stubGuardPresent();
    process.env.OPENCODE_MODEL_CONTEXT_LIMIT = '128000';
    expect(mainModelEntry()).not.toHaveProperty('limit');
  });
});
