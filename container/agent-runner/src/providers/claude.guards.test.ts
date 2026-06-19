import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  createSelfApprovalBlockHook,
  createBlockSnowflakeConnectorHook,
  createBlockGitCloneHook,
  createEmailGateHook,
} from './claude.js';
import { buildSecretEnvVarList } from './secret-env.js';
import * as messagesOut from '../db/messages-out.js';
import * as sessionRouting from '../db/session-routing.js';
import * as deliveryAcks from '../db/delivery-acks.js';

// Fixture core paths — claude.ts resolves these via NANOCLAW_DESTRUCTIVE_GUARD_CORE
// (block-destructive) and NANOCLAW_EMAIL_GATE_CORE (email).
const STUB_CORE = new URL('./__test-fixtures__/guard-core-stub.ts', import.meta.url).pathname;
const BROKEN_CORE = new URL('./__test-fixtures__/guard-core-broken.ts', import.meta.url).pathname;
const THROWING_CORE = new URL('./__test-fixtures__/guard-core-throwing.ts', import.meta.url).pathname;
const EMAIL_STUB_CORE = new URL('./__test-fixtures__/email-gate-core-stub.ts', import.meta.url).pathname;
const EMAIL_MALFORMED_CORE = new URL('./__test-fixtures__/email-gate-core-malformed.ts', import.meta.url).pathname;

const EMPTY_CTX = {} as Parameters<HookCallback>[1];
const EMPTY_OPTS = {} as Parameters<HookCallback>[2];

/** Drive a PreToolUse hook with a Bash command and return its decision shape. */
async function runBashHook(hook: HookCallback, command: string): Promise<{
  permissionDecision?: string;
  permissionDecisionReason?: string;
  raw: unknown;
}> {
  const input = { tool_name: 'Bash', tool_input: { command } } as unknown as PreToolUseHookInput;
  const out = await hook(input as Parameters<HookCallback>[0], EMPTY_CTX, EMPTY_OPTS);
  const hso = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })
    ?.hookSpecificOutput;
  return { permissionDecision: hso?.permissionDecision, permissionDecisionReason: hso?.permissionDecisionReason, raw: out };
}

// ── E1: createSelfApprovalBlockHook delegates to the core ──
describe('E1 createSelfApprovalBlockHook', () => {
  const savedGuard = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedGuard;
  });

  it('test_claude_self_approval_blocks_via_core', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
    // The stub blocks on STUB_SELF_APPROVAL with a distinct reason, proving the
    // verdict came from the delegated core (not the inline fallback regex, which
    // keys on `.claude-destructive-gate`).
    const r = await runBashHook(createSelfApprovalBlockHook(), 'echo STUB_SELF_APPROVAL');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('STUB-CORE: self-approval blocked');
  });

  it('test_claude_self_approval_fallback_blocks_when_core_absent', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    // Core import fails → inline fail-closed fallback blocks the marker.
    const r = await runBashHook(createSelfApprovalBlockHook(), 'touch .claude-destructive-gate');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('Self-approval');
  });

  it('falls back (fail-closed) when the core export is malformed', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = BROKEN_CORE;
    const r = await runBashHook(createSelfApprovalBlockHook(), 'echo > .claude-destructive-gate');
    expect(r.permissionDecision).toBe('deny');
  });

  it('falls back (fail-closed) when the core evaluator throws', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = THROWING_CORE;
    const r = await runBashHook(createSelfApprovalBlockHook(), 'rm -f .claude-destructive-gate');
    expect(r.permissionDecision).toBe('deny');
  });

  it('allows a benign command via the core', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
    const r = await runBashHook(createSelfApprovalBlockHook(), 'ls -la');
    expect(r.permissionDecision).toBeUndefined();
  });

  it('test_claude_self_approval_signature_unchanged', () => {
    // The factory takes no args and returns a HookCallback — runner.ts imports
    // and calls it as createSelfApprovalBlockHook() (review S2 invariant).
    expect(createSelfApprovalBlockHook).toHaveLength(0);
    const hook = createSelfApprovalBlockHook();
    expect(typeof hook).toBe('function');
  });
});

// ── E2: createBlockSnowflakeConnectorHook delegates ──
describe('E2 createBlockSnowflakeConnectorHook', () => {
  const savedGuard = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedGuard;
  });

  it('test_claude_snowflake_blocks_via_core', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
    const r = await runBashHook(createBlockSnowflakeConnectorHook(), 'echo STUB_SNOWFLAKE');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('STUB-CORE: snowflake connector blocked');
  });

  it('test_claude_snowflake_allows_snow_cli', async () => {
    // `snow sql` is NOT the python connector — neither the core stub nor the
    // inline fallback should block it. Verified under both core states.
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
    const viaCore = await runBashHook(createBlockSnowflakeConnectorHook(), "snow sql -q 'select 1'");
    expect(viaCore.permissionDecision).toBeUndefined();

    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    const viaFallback = await runBashHook(createBlockSnowflakeConnectorHook(), "snow sql -q 'select 1'");
    expect(viaFallback.permissionDecision).toBeUndefined();
  });

  it('test_claude_snowflake_fallback_when_core_absent', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/guard-core.ts';
    // Inline fallback blocks the python snowflake.connector form.
    const r = await runBashHook(
      createBlockSnowflakeConnectorHook(),
      'python -c "import snowflake.connector"',
    );
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('snowflake.connector');
  });

  it('falls back (fail-closed) when the core evaluator throws', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = THROWING_CORE;
    const r = await runBashHook(
      createBlockSnowflakeConnectorHook(),
      'python3 -c "import snowflake.connector"',
    );
    expect(r.permissionDecision).toBe('deny');
  });

  it('signature unchanged (no args → HookCallback)', () => {
    expect(createBlockSnowflakeConnectorHook).toHaveLength(0);
    expect(typeof createBlockSnowflakeConnectorHook()).toBe('function');
  });
});

// ── E3: createEmailGateHook uses core verdict, keeps async ack round-trip ──
// The DB layer the hook dynamic-imports (writeMessageOut / getSessionRouting /
// awaitDeliveryAck) is replaced with spyOn on the live module namespaces. This
// is deliberately NOT mock.module (which leaks process-globally and poisons
// sibling files — Bun's mock.restore does NOT undo mock.module) and NOT the real
// initTestSessionDb (a process-global singleton whose teardown by parallel
// sibling files races the hook's awaitDeliveryAck poll). spyOn mutates only the
// imported module object and mockRestore() reverts it cleanly per-test, so E3 is
// deterministic AND leak-free. The hook's `await import('../db/...')` returns the
// same cached namespace these spies patch.
describe('E3 createEmailGateHook', () => {
  const savedEmail = process.env.NANOCLAW_EMAIL_GATE_CORE;
  const savedSched = process.env.NANOCLAW_IS_SCHEDULED_TASK;

  let staged: Array<{ id: string } & Record<string, unknown>>;
  let ackToReturn: deliveryAcks.DeliveryAck | null;
  let ackedRequestId: string | null;
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    staged = [];
    ackToReturn = { status: 'delivered' };
    ackedRequestId = null;
    spies.length = 0;
    spies.push(
      spyOn(messagesOut, 'writeMessageOut').mockImplementation((row: { id: string; content: string }) => {
        try {
          staged.push({ id: row.id, ...(JSON.parse(row.content) as Record<string, unknown>) });
        } catch {
          staged.push({ id: row.id, content: row.content });
        }
        return 1;
      }),
    );
    spies.push(
      spyOn(sessionRouting, 'getSessionRouting').mockImplementation(() => ({
        channel_type: null,
        platform_id: null,
        thread_id: null,
      })),
    );
    spies.push(
      spyOn(deliveryAcks, 'awaitDeliveryAck').mockImplementation(async (messageId: string) => {
        ackedRequestId = messageId;
        return ackToReturn;
      }),
    );
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    if (savedEmail === undefined) delete process.env.NANOCLAW_EMAIL_GATE_CORE;
    else process.env.NANOCLAW_EMAIL_GATE_CORE = savedEmail;
    if (savedSched === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = savedSched;
  });

  const gateCard = () => staged.find((c) => c.action === 'request_bash_gate');

  it('test_claude_email_gate_verdict_from_core', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to a@b.com');
    // Approved → hook allows. The staged card carries the CORE's label/summary,
    // proving the verdict came from the core (not the inline fallback, which
    // would render a real "*To:* a@b.com" envelope rather than the stub text).
    expect(r.permissionDecision).toBeUndefined();
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.label).toBe('STUB-CORE email label');
    expect(card!.summary).toBe('STUB-CORE email summary');
  });

  it('test_claude_email_gate_preserves_async_ack', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    // Admin DECLINES → the async round-trip resolves to failed → hook denies.
    ackToReturn = { status: 'failed', error: 'admin declined' };
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to a@b.com');
    // Round-trip preserved: staged a request_bash_gate AND awaited its ack keyed
    // on the same requestId (proving writeMessageOut → awaitDeliveryAck plumbing).
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.action).toBe('request_bash_gate');
    expect(ackedRequestId).toBe(card!.id);
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('admin declined');
  });

  it('approved ack → allow (round-trip both directions)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to a@b.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('timeout ack (null) → deny', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = null; // awaitDeliveryAck timed out
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to a@b.com');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('timed out');
  });

  it('scheduled tasks bypass the gate (verdict allow, no staging)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    process.env.NANOCLAW_IS_SCHEDULED_TASK = '1';
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to a@b.com');
    expect(r.permissionDecision).toBeUndefined();
    expect(gateCard()).toBeUndefined(); // nothing staged
    expect(ackedRequestId).toBeNull(); // and no ack round-trip
  });

  it('test_claude_email_gate_fallback_when_core_absent', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // Core import fails → inline fallback still gates a real gws send and runs
    // the async ack round-trip. Admin approves → allow.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to attacker@example.com --subject hi --body x',
    );
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
    // Fallback built the card from the parsed envelope (real To: rendered) —
    // distinct from the stub's fixed label, proving the inline path ran.
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('attacker@example.com');
  });

  it('inline fallback: a real --dry-run argv token bypasses the gate (allow, no staging)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    // --dry-run as a genuine argv token in a simple gws command → bypass.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to attacker@example.com --subject hi --body x --dry-run',
    );
    expect(r.permissionDecision).toBeUndefined();
    expect(gateCard()).toBeUndefined(); // bypassed → nothing staged
    expect(ackedRequestId).toBeNull(); // and no ack round-trip
  });

  it('inline fallback: a bypass flag after a redirection does NOT bypass — it gates (QA codex re-pass #3)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // `<<< --dry-run` makes --dry-run a here-string operand, not gws argv — the
    // mail still sends. The inline fallback's metacharacter fail-closed must
    // refuse the bypass and gate (parity with the SoT redirection regression).
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to victim@evil.com --subject hi --body x <<< --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated, not bypassed
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined(); // delivered ack → allow after gate
  });

  it('inline fallback: a bypass flag after a # comment does NOT bypass — it gates (QA codex re-pass #4)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // `# --dry-run` is a bash comment — gws sends without --dry-run. The `#`
    // metacharacter must fail closed in the inline fallback too.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to victim@evil.com --subject hi --body x # --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: a fake first send segment does NOT suppress the gate on a later real send (QA codex re-pass #4)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // First segment is a harmless `:` no-op carrying --dry-run; the real send is
    // segment 2. Every send segment must independently bypass — the real send
    // doesn't, so it gates, and the card surfaces the real recipient.
    const r = await runBashHook(
      createEmailGateHook(),
      ': gws gmail +send --dry-run; gws gmail +send --to victim@evil.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: a wrapper prefix (exec -a) does NOT bypass — it gates (QA codex re-pass #8)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // `exec -a --dry-run gws …` makes --dry-run the argv0 name, not a gws flag —
    // gws sends. The inline fallback must require a DIRECT gws invocation.
    const r = await runBashHook(
      createEmailGateHook(),
      'exec -a --dry-run gws gmail +send --to victim@evil.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: a bypass flag consumed as a prior option value does NOT bypass — it gates (QA codex re-pass #8)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // `--subject --dry-run` feeds --dry-run to --subject; gws sends.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --subject --dry-run --to victim@evil.com --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: the real creds-prefix dry-run form still bypasses (no over-block, codex #8)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const r = await runBashHook(
      createEmailGateHook(),
      'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/x.json gws gmail +send --to a@b.com --body z --dry-run',
    );
    expect(r.permissionDecision).toBeUndefined();
    expect(gateCard()).toBeUndefined(); // bypassed → nothing staged
    expect(ackedRequestId).toBeNull();
  });

  it('inline fallback: adjacent-quote concatenation does NOT manufacture a bypass — it gates (QA codex re-pass #7)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // bash concatenates `'x'--dry-run` into the word `x--dry-run` (no real flag,
    // it sends). The inline fallback's sentinel replacement must keep it one
    // token so the gate fires.
    const r = await runBashHook(
      createEmailGateHook(),
      `gws gmail +send --to victim@evil.com --subject hi --body 'x'--dry-run`,
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: backslash-escaped whitespace before a bypass flag does NOT bypass — it gates (QA codex re-pass #6)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // `\ ` is an escaped (literal) space — bash joins it into the body value, so
    // gws gets no real --dry-run flag and sends. The inline fallback must fail
    // closed on the unquoted backslash.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to victim@evil.com --subject hi --body \\ --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: form-feed (non-IFS whitespace) before a bypass flag does NOT bypass — it gates (QA codex re-pass #6)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // bash keeps `x\f--dry-run` as one word (sends); the inline fallback splits
    // tokens on bash IFS only, so it stays one token ≠ --dry-run → gate.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to victim@evil.com --body x\f--dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: a newline-separated decoy does NOT suppress the gate on a later real send (QA codex re-pass #5)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // Decoy --dry-run on line 1; real send on line 2. The newline is a command
    // separator — the inline fallback's metachar set must include \n so the
    // whole-command bypass fails closed and the real send gates.
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --dry-run\ngws gmail +send --to victim@evil.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: a real --dry-run with ANSI-C $\'…\' body still bypasses (QA codex re-pass #4)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const r = await runBashHook(
      createEmailGateHook(),
      `gws gmail +send --to a@b.com --body $'cost is $5' --dry-run`,
    );
    expect(r.permissionDecision).toBeUndefined();
    expect(gateCard()).toBeUndefined(); // bypassed → nothing staged
    expect(ackedRequestId).toBeNull();
  });

  it('inline fallback: a bypass flag inside quoted body content does NOT bypass — it gates (QA codex-#2)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // --dry-run lives only inside the quoted --body; it is NOT a real argv flag.
    const r = await runBashHook(
      createEmailGateHook(),
      `gws gmail +send --to victim@evil.com --subject hi --body "please --dry-run this"`,
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated, not bypassed
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('malformed core verdict falls back to inline fail-closed (gates, not allow) — codex #126 F2', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_MALFORMED_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = { status: 'delivered' };
    // The core returns {action:'bogus'} — untrusted. The hook must NOT treat the
    // non-'gate' action as allow; it falls back to the inline evaluator, which
    // gates an interactive real send (card carries the real recipient).
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send --to victim@evil.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated via inline fallback, NOT allowed
    expect(card!.summary as string).toContain('victim@evil.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined(); // delivered ack → allow after gate
  });

  it('sanitizer unset-prefix does NOT over-block a real --dry-run (strips exact prefix) — codex #126 F1', async () => {
    // Reproduce the prod chain: createSanitizeBashHook prepends `unset <vars>
    // 2>/dev/null; ` before the email gate sees the command. A legit dry-run must
    // still bypass — the gate strips the exact reconstructed prefix first.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test'; // ensure buildSecretEnvVarList is non-empty
    try {
      process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts'; // inline path
      delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
      const prefix = `unset ${buildSecretEnvVarList().join(' ')} 2>/dev/null; `;
      // dry-run → bypass (allow, no staging) despite the sanitizer prefix
      const dry = await runBashHook(
        createEmailGateHook(),
        `${prefix}gws gmail +send --to a@b.com --subject hi --body x --dry-run`,
      );
      expect(dry.permissionDecision).toBeUndefined();
      expect(gateCard()).toBeUndefined();
      expect(ackedRequestId).toBeNull();

      // …but a real (non-dry-run) send behind the same prefix STILL gates: the
      // strip only removes the known prefix, leaving the real send fully checked.
      staged.length = 0;
      ackToReturn = { status: 'delivered' };
      const real = await runBashHook(
        createEmailGateHook(),
        `${prefix}gws gmail +send --to victim@evil.com --subject hi --body x`,
      );
      const card = gateCard();
      expect(card).toBeDefined();
      expect(card!.summary as string).toContain('victim@evil.com');
      expect(real.permissionDecision).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('non-email commands are a no-op (allow, no staging)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    const r = await runBashHook(createEmailGateHook(), 'ls -la');
    expect(r.permissionDecision).toBeUndefined();
    expect(staged).toHaveLength(0);
  });

  it('signature unchanged (no args → HookCallback)', () => {
    expect(createEmailGateHook).toHaveLength(0);
    expect(typeof createEmailGateHook()).toBe('function');
  });
});

// ── E6 (Claude side): dispatch coverage at the real entrypoints ──
// The Codex-side dispatch coverage lives in runner.test.ts; this drives each
// Claude guard factory directly and asserts the migrated guards + uniform
// fail-closed direction. The git-clone guard is included for parity.
describe('E6 claude dispatch — each guard', () => {
  const savedGuard = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  afterEach(() => {
    if (savedGuard === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedGuard;
  });

  it('test_claude_dispatch_each_guard', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = STUB_CORE;
    type Case = { name: string; hook: HookCallback; block: string; allow: string };
    const cases: Case[] = [
      {
        name: 'self-approval',
        hook: createSelfApprovalBlockHook(),
        block: 'echo STUB_SELF_APPROVAL',
        allow: 'echo ok',
      },
      {
        name: 'snowflake',
        hook: createBlockSnowflakeConnectorHook(),
        block: 'echo STUB_SNOWFLAKE',
        allow: 'snow sql -q "select 1"',
      },
      {
        name: 'git-clone',
        hook: createBlockGitCloneHook(),
        block: 'git clone https://github.com/x/y STUB_GIT_CLONE',
        allow: 'git status',
      },
    ];
    for (const c of cases) {
      const blocked = await runBashHook(c.hook, c.block);
      expect(blocked.permissionDecision, `${c.name} should block`).toBe('deny');
      const allowed = await runBashHook(c.hook, c.allow);
      expect(allowed.permissionDecision, `${c.name} should allow`).toBeUndefined();
    }
  });

  it('every bash guard is fail-closed when its core export is malformed', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = BROKEN_CORE;
    // Each guard must fall back to its inline policy and still BLOCK the marker.
    const selfApproval = await runBashHook(createSelfApprovalBlockHook(), 'touch .claude-destructive-gate');
    expect(selfApproval.permissionDecision).toBe('deny');
    const snowflake = await runBashHook(
      createBlockSnowflakeConnectorHook(),
      'python -c "import snowflake.connector"',
    );
    expect(snowflake.permissionDecision).toBe('deny');
    const gitClone = await runBashHook(
      createBlockGitCloneHook(),
      'git clone https://github.com/x/y /workspace/agent/y',
    );
    expect(gitClone.permissionDecision).toBe('deny');
  });
});
