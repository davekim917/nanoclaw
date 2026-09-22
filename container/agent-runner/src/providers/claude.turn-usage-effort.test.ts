/**
 * End-to-end: a Claude turn run at a known effort records THAT effort in the
 * session's `turn_usage` row.
 *
 * "End-to-end" means the whole seam, not a unit: the real ClaudeProvider
 * resolves the effort from its own precedence chain, translates a mocked SDK
 * `result` into a ProviderEvent, and the usage entries are then handed to
 * `recordTurnUsage` exactly the way poll-loop.ts does (one call per model,
 * sharing one TurnMeta). The assertion is on the row read back out of SQLite.
 *
 * Harness mirrors claude.rate-limit-usage.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  // Async iterable PLUS the live-control surface applySettings drives
  // (setModel / applyFlagSettings), so an in-flight `-m` can be exercised.
  query: () => {
    const it = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    return Object.assign(it, {
      setModel: async () => {},
      applyFlagSettings: async () => {},
    });
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb } = await import('../modules/mailbox/testing.js');
const { getTurnUsageRows, recordTurnUsage, _resetCumulativeTrackingForTesting } =
  await import('../modules/mailbox/turn-usage.js');
import type { TurnUsageInfo } from './types.js';

let tmp: string;
let prevHome: string | undefined;
let prevOpus: string | undefined;
let prevSonnet: string | undefined;
let prevOverride: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-effort-usage-'));
  prevHome = process.env.HOME;
  prevOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  prevSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  prevOverride = process.env.NANOCLAW_EFFORT_OVERRIDE;
  process.env.HOME = tmp;
  delete process.env.NANOCLAW_EFFORT_OVERRIDE;
  initTestSessionDb();
  _resetCumulativeTrackingForTesting();
});

afterEach(() => {
  for (const [key, value] of [
    ['HOME', prevHome],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', prevOpus],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', prevSonnet],
    ['NANOCLAW_EFFORT_OVERRIDE', prevOverride],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Run one turn and persist its usage the way poll-loop.ts does — one
 * recordTurnUsage per model entry, all sharing the turn's meta.
 */
async function runTurnAndRecord(input: { model?: string; effort?: string } = {}): Promise<void> {
  // Faithful to production: index.ts constructs the provider with
  // `env: { ...process.env }`, which is how the host-injected alias env
  // (ANTHROPIC_DEFAULT_*_MODEL) reaches the resolution used for attribution.
  const provider = new ClaudeProvider({ env: { ...process.env } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp, ...input });
  for await (const e of q.events) {
    if (e.type !== 'result') continue;
    const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
    for (const u of Array.isArray(usage) ? usage : [usage]) {
      recordTurnUsage('claude', u ?? {}, undefined, 'sess-1');
    }
  }
}

/** A `result` whose modelUsage names the given models with real token counts. */
function resultWithModels(models: string[]): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: '<message to="user">hi</message>',
    modelUsage: Object.fromEntries(
      models.map((m, i) => [
        m,
        {
          inputTokens: 100 * (i + 1),
          outputTokens: 10,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 1,
          costUSD: 0.5,
        },
      ]),
    ),
  };
}

describe('claude turn effort -> turn_usage row', () => {
  it('uses same-model parent and child cumulative totals, not per-turn main-loop usage', async () => {
    sdkMessages.length = 0;
    const result = (input: number, cost: number, mainInput: number) => ({
      type: 'result',
      subtype: 'success',
      result: '',
      total_cost_usd: cost,
      usage: { input_tokens: mainInput, output_tokens: 1, cache_read_input_tokens: 2 },
      modelUsage: {
        'claude-fable-5-1': {
          inputTokens: input,
          outputTokens: input,
          cacheReadInputTokens: input,
          cacheCreationInputTokens: input,
          costUSD: cost,
        },
      },
    });
    sdkMessages.push(result(100, 10, 20), result(150, 12, 3));
    await runTurnAndRecord();
    expect(getTurnUsageRows().map((r) => [r.input_tokens, r.cache_read_tokens, r.cost_usd])).toEqual([
      [100, 100, 10],
      [50, 50, 2],
    ]);
  });

  it('retains the same counter basis when a second model first appears', async () => {
    sdkMessages.length = 0;
    const first = resultWithModels(['claude-opus-5']) as Record<string, unknown>;
    const second = resultWithModels(['claude-opus-5', 'claude-haiku-4-5-20251001']) as Record<string, unknown>;
    sdkMessages.push(first, second);
    await runTurnAndRecord();
    expect(getTurnUsageRows().map((r) => [r.model, r.input_tokens, r.cost_usd])).toEqual([
      ['claude-opus-5', 100, 0.5],
      ['claude-haiku-4-5-20251001', 200, 0.5],
    ]);
  });

  it('starts a new counter for a new query even when the continuation id is unchanged', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(resultWithModels(['claude-opus-5']));
    await runTurnAndRecord();
    await runTurnAndRecord();
    expect(getTurnUsageRows().map((r) => [r.input_tokens, r.cost_usd])).toEqual([
      [100, 0.5],
      [100, 0.5],
    ]);
  });

  it('records fallback main-loop usage per turn and leaves cumulative cost unknown', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      ...[10, 30].map((input) => ({
        type: 'result',
        subtype: 'success',
        result: '',
        total_cost_usd: input,
        usage: { input_tokens: input, output_tokens: input, cache_read_input_tokens: input },
      })),
    );
    await runTurnAndRecord();
    expect(getTurnUsageRows().map((r) => [r.input_tokens, r.cost_usd])).toEqual([
      [10, null],
      [30, null],
    ]);
  });

  it('attributes an UNPINNED SCHEDULED TASK turn that spawned a subagent', async () => {
    // The shape poll-loop.ts produces for a pure task wake with no stored
    // -m/-e: it passes the BARE ALIAS `sonnet` at xhigh. The SDK expands that
    // to the canonical id and keys modelUsage by it, so an exact comparison
    // against the alias matched nothing and the whole turn recorded NULL
    // effort — a turn that demonstrably ran at xhigh reading as "effort was
    // never configured", which is precisely what this column exists to catch.
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-sonnet-5', 'claude-haiku-4-5-20251001']),
    );

    await runTurnAndRecord({ model: 'sonnet', effort: 'xhigh' });

    const rows = getTurnUsageRows();
    expect(rows.map((r) => [r.model, r.effort])).toEqual([
      ['claude-sonnet-5', 'xhigh'],
      // Still NULL, and for the RIGHT reason: we never set a subagent's effort.
      ['claude-haiku-4-5-20251001', null],
    ]);
  });

  it('re-resolves the alias after a LIVE -m switch on an active query', async () => {
    // The finding's second half: `applySettings` changes the model inside a
    // running query, and `-m sonnet` arrives there as a bare alias exactly as
    // it does at query time. If only the query-time path canonicalized, every
    // turn after a live switch would silently go back to NULL.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-5';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-sonnet-5', 'claude-haiku-4-5-20251001']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    // `-e xhigh` up front so the switch to sonnet (whose family default is
    // also xhigh) moves the MODEL without moving the effort. That keeps the
    // turn attributable, which is what lets this test assert on alias
    // canonicalization rather than on the transition counter.
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'xhigh' });
    await q.applySettings!({ model: 'sonnet' });
    for await (const e of q.events) {
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('claude', u ?? {}, undefined, 'sess-1');
    }

    expect(getTurnUsageRows().map((r) => [r.model, r.effort])).toEqual([
      // Sonnet's family default, resolved from the alias the switch supplied.
      ['claude-sonnet-5', 'xhigh'],
      ['claude-haiku-4-5-20251001', null],
    ]);
  });

  it('records NULL for a turn whose effort changed MID-flight, not the final setting', async () => {
    // poll-loop.ts's follow-up path: a message arrives while the turn is still
    // executing, so it calls applySettings and pushes into the SAME stream.
    // The SDK merges both inputs into one `result`, whose usage covers work
    // under the old effort AND the new one. Stamping that aggregate `xhigh`
    // reports tokens under an effort they did not all run at — and
    // `usage summary --by effort` would carry it straight through.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [] } },
      resultWithModels(['claude-opus-5[1m]']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'high' });
    const it = q.events[Symbol.asyncIterator]();
    // Consume up to the first in-turn message, THEN change effort — the turn
    // is now in flight and straddles the boundary.
    await it.next();
    await it.next();
    await q.applySettings!({ effort: 'xhigh' });
    for (let ev = await it.next(); !ev.done; ev = await it.next()) {
      const e = ev.value;
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('claude', u ?? {}, undefined, 'sess-1');
    }

    const [row] = getTurnUsageRows();
    // Not 'xhigh', and not 'high' either — the turn ran at both.
    expect(row!.effort).toBeNull();
    expect(row!.effort_requested).toBeNull();
  });

  it('records NULL when a turn`s effort changes TWICE and returns to its starting value', async () => {
    // Endpoint comparison called this constant: snapshot xhigh, admit two
    // follow-ups that move it to low and back, and the ends match while part
    // of the turn ran at low. A counter is indifferent to where the value
    // lands, which is the property that makes it correct — any movement at
    // all leaves the aggregate unattributable.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [] } },
      resultWithModels(['claude-opus-5[1m]']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'xhigh' });
    const it = q.events[Symbol.asyncIterator]();
    await it.next();
    await it.next(); // turn is now in flight
    await q.applySettings!({ effort: 'low' });
    await q.applySettings!({ effort: 'xhigh' }); // back where it started
    for (let ev = await it.next(); !ev.done; ev = await it.next()) {
      const e = ev.value;
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('claude', u ?? {}, undefined, 'sess-1');
    }

    const [row] = getTurnUsageRows();
    // NOT 'xhigh' — some of this turn ran at low.
    expect(row!.effort).toBeNull();
    expect(row!.effort_requested).toBeNull();
  });

  it('records NULL when an effort-changing follow-up is PUSHED INTO a running turn', async () => {
    // poll-loop's follow-up path while Claude is still executing: applySettings
    // then push, and the SDK MERGES that input into the turn already running,
    // emitting one `result` for both. A reset on the push erased the very
    // transition this counter exists to catch and stamped the aggregate with
    // the post-change effort — the confidently-wrong value the column must
    // never carry. Whether a push merges or starts a turn is not knowable at
    // push time, so the push no longer resets anything.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [] } },
      resultWithModels(['claude-opus-5[1m]']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'high' });
    const it = q.events[Symbol.asyncIterator]();
    await it.next();
    await it.next(); // turn is in flight
    // Exactly poll-loop's order: change, then push into the SAME stream.
    await q.applySettings!({ effort: 'low' });
    q.push('follow-up merged into this turn');
    for (let ev = await it.next(); !ev.done; ev = await it.next()) {
      const e = ev.value;
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      for (const u of Array.isArray(usage) ? usage : [usage]) recordTurnUsage('claude', u ?? {}, undefined, 'sess-1');
    }

    const [row] = getTurnUsageRows();
    expect(row!.effort).toBeNull();
    expect(row!.effort_requested).toBeNull();
  });

  it('records NULL when effort changes after the PUSH but before the first SDK event', async () => {
    // The boundary case. Once the prompt is pushed the CLI has already issued
    // the request under the old effort, but no message has been emitted yet.
    // Resetting on the first MESSAGE erased a transition that had already
    // happened, labelling the aggregate with a value part of it never ran
    // under. This window is mid-turn, not between turns.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]']),
      { type: 'assistant', message: { content: [] } },
      resultWithModels(['claude-opus-5[1m]']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'high' });
    const it = q.events[Symbol.asyncIterator]();
    const rows: Array<TurnUsageInfo | undefined> = [];
    for (let ev = await it.next(); !ev.done; ev = await it.next()) {
      const e = ev.value;
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      rows.push(Array.isArray(usage) ? usage[0] : usage);
      if (rows.length === 1) {
        // Push FIRST — the turn has begun — and only then change effort.
        q.push('follow-up');
        await q.applySettings!({ effort: 'low' });
      }
    }

    expect(rows[0]?.effort).toBe('high'); // clean turn, unaffected
    expect(rows[1]?.effort).toBeNull(); // began under high, finished under low
    expect(rows[1]?.effortRequested).toBeNull();
  });

  it('records NULL for a turn whose effort changed between turns — constancy is not provable', async () => {
    // The ordinary path, and the one a naive "did effort ever change" flag
    // would wrongly void: nothing is in flight, the setting changes, then the
    // next turn runs entirely under it. That turn IS attributable.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]']),
      { type: 'assistant', message: { content: [] } },
      resultWithModels(['claude-opus-5[1m]']),
    );

    const provider = new ClaudeProvider({ env: { ...process.env } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp, effort: 'high' });
    const it = q.events[Symbol.asyncIterator]();
    const rows: Array<TurnUsageInfo | undefined> = [];
    for (let ev = await it.next(); !ev.done; ev = await it.next()) {
      const e = ev.value;
      if (e.type !== 'result') continue;
      const usage = e.usage as TurnUsageInfo | TurnUsageInfo[] | undefined;
      rows.push(Array.isArray(usage) ? usage[0] : usage);
      // Change effort AFTER the first turn closed, then push — which is what
      // poll-loop does, and what actually starts the next turn. Both steps
      // matter: the change lands with nothing in flight, and the push is the
      // boundary that opens the new turn's effort window.
      if (rows.length === 1) {
        await q.applySettings!({ effort: 'xhigh' });
        q.push('follow-up');
      }
    }

    expect(rows[0]?.effort).toBe('high'); // untouched turn keeps its effort
    // Deliberately NULL, not 'xhigh'. The change lands between two turns, but
    // whether it took effect before the CLI picked up the next prompt is not
    // observable from here — so it cannot be PROVEN to have governed the whole
    // turn. The invariant is fail-safe: decline rather than guess. Recovering
    // this case would need a boundary on the push path, which is the shape
    // that produced two regressions.
    expect(rows[1]?.effort).toBeNull();
  });

  it('attributes a bare `opus` alias through the host-injected alias env', async () => {
    // Same class, the other family, and it proves the [1m] suffix survives:
    // the env carries the suffixed id and modelUsage is keyed by it.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5[1m]';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]', 'claude-sonnet-5']),
    );

    await runTurnAndRecord({ model: 'opus' });

    expect(getTurnUsageRows().map((r) => [r.model, r.effort])).toEqual([
      ['claude-opus-5[1m]', 'high'],
      ['claude-sonnet-5', null],
    ]);
  });

  it('leaves the row NULL when an alias cannot be resolved, rather than guessing', async () => {
    // No alias env injected (a host too old, or a unit-test spawn). Matching
    // nothing is the intended direction: under-claim, never invent.
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-sonnet-5', 'claude-haiku-4-5-20251001']),
    );

    await runTurnAndRecord({ model: 'sonnet', effort: 'xhigh' });

    expect(getTurnUsageRows().every((r) => r.effort === null)).toBe(true);
  });

  it('records the family-default effort a turn actually ran at', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]']),
    );

    await runTurnAndRecord();

    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(1);
    // Opus's family default. Before this column existed, this fact was only
    // available by reading defaultEffortForModel.
    expect(rows[0]).toMatchObject({
      model: 'claude-opus-5[1m]',
      effort: 'high',
      effort_requested: 'high',
    });
  });

  it('records an explicit per-turn -e over the family default', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]']),
    );

    await runTurnAndRecord({ effort: 'xhigh' });

    expect(getTurnUsageRows()[0]).toMatchObject({ effort: 'xhigh', effort_requested: 'xhigh' });
  });

  it('records the sonnet default when the group is pinned to sonnet, not opus`s', async () => {
    // The bug class this column measures: an effort that is right for the
    // configured model and wrong for the one that actually ran was, until now,
    // invisible in the ledger.
    sdkMessages.length = 0;
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' }, resultWithModels(['claude-sonnet-5']));

    await runTurnAndRecord({ model: 'claude-sonnet-5' });

    expect(getTurnUsageRows()[0]).toMatchObject({ model: 'claude-sonnet-5', effort: 'xhigh' });
  });

  it('records a clamped-away Haiku effort as NULL effective + the requested value', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-haiku-4-5-20251001']),
    );

    await runTurnAndRecord({ model: 'claude-haiku-4-5-20251001', effort: 'high' });

    const [row] = getTurnUsageRows();
    expect(row!.effort).toBeNull();
    expect(row!.effort_requested).toBe('high');
  });

  it('attributes a multi-model turn to the model the effort was resolved for only', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-5';
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultWithModels(['claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']),
    );

    await runTurnAndRecord();

    const rows = getTurnUsageRows();
    expect(rows.map((r) => [r.model, r.effort])).toEqual([
      ['claude-opus-5[1m]', 'high'],
      ['claude-sonnet-5', null],
      ['claude-haiku-4-5-20251001', null],
    ]);
  });
});
