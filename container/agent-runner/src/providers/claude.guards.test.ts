import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  createBashCommandRewriteHook,
  wrapJestSerialized,
  createSelfApprovalBlockHook,
  createBlockSnowflakeConnectorHook,
  createBlockGitCloneHook,
  createBlockCodexCompanionHook,
  createEmailGateHook,
  resetGateClaimApiForTest,
} from './claude.js';
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
async function runBashHook(
  hook: HookCallback,
  command: string,
): Promise<{
  permissionDecision?: string;
  permissionDecisionReason?: string;
  raw: unknown;
}> {
  const input = { tool_name: 'Bash', tool_input: { command } } as unknown as PreToolUseHookInput;
  const out = await hook(input as Parameters<HookCallback>[0], EMPTY_CTX, EMPTY_OPTS);
  const hso = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } })
    ?.hookSpecificOutput;
  return {
    permissionDecision: hso?.permissionDecision,
    permissionDecisionReason: hso?.permissionDecisionReason,
    raw: out,
  };
}

/** Drive createBashCommandRewriteHook and return the command it produced. */
async function runRewriteHook(command: string): Promise<string> {
  const input = { tool_name: 'Bash', tool_input: { command } } as unknown as PreToolUseHookInput;
  const out = await createBashCommandRewriteHook()(input as Parameters<HookCallback>[0], EMPTY_CTX, EMPTY_OPTS);
  const hso = (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } })?.hookSpecificOutput;
  return hso?.updatedInput?.command ?? command;
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
    const r = await runBashHook(createBlockSnowflakeConnectorHook(), 'python -c "import snowflake.connector"');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('snowflake.connector');
  });

  it('falls back (fail-closed) when the core evaluator throws', async () => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = THROWING_CORE;
    const r = await runBashHook(createBlockSnowflakeConnectorHook(), 'python3 -c "import snowflake.connector"');
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
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com',
    );
    // Approved → hook allows. The staged card carries the CORE's label/summary,
    // proving the verdict came from the core (not the inline fallback, which
    // would render a real "*To:* person8@fixture1.example.com" envelope rather than the stub text).
    expect(r.permissionDecision).toBeUndefined();
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.label).toBe('STUB-CORE email label');
    expect(card!.summary).toBe('STUB-CORE email summary');
    expect(card!.command).toBe('gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
  });

  it('test_claude_email_gate_preserves_async_ack', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    // Admin DECLINES → the async round-trip resolves to failed → hook denies.
    ackToReturn = { status: 'failed', error: 'admin declined' };
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com',
    );
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
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com',
    );
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('timeout ack (null) → deny', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = null; // awaitDeliveryAck timed out
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com',
    );
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('timed out');
  });

  it('scheduled tasks bypass the gate (verdict allow, no staging)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    process.env.NANOCLAW_IS_SCHEDULED_TASK = '1';
    const r = await runBashHook(
      createEmailGateHook(),
      'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com',
    );
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

  it('inline fallback: the bounded gws help probe bypasses without staging', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const r = await runBashHook(
      createEmailGateHook(),
      'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/primary.json && gws gmail users messages send --help 2>&1 | head -60',
    );
    expect(r.permissionDecision).toBeUndefined();
    expect(gateCard()).toBeUndefined();
    expect(ackedRequestId).toBeNull();
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
      'gws gmail +send --to person25@fixture4.example.com --subject hi --body x <<< --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated, not bypassed
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --to person25@fixture4.example.com --subject hi --body x # --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      ': gws gmail +send --dry-run; gws gmail +send --to person25@fixture4.example.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'exec -a --dry-run gws gmail +send --to person25@fixture4.example.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --subject --dry-run --to person25@fixture4.example.com --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('inline fallback: the real creds-prefix dry-run form still bypasses (no over-block, codex #8)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const r = await runBashHook(
      createEmailGateHook(),
      'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/x.json gws gmail +send --to person8@fixture1.example.com --body z --dry-run',
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
      `gws gmail +send --to person25@fixture4.example.com --subject hi --body 'x'--dry-run`,
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --to person25@fixture4.example.com --subject hi --body \\ --dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --to person25@fixture4.example.com --body x\f--dry-run',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --dry-run\ngws gmail +send --to person25@fixture4.example.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined();
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it("inline fallback: a real --dry-run with ANSI-C $'…' body still bypasses (QA codex re-pass #4)", async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts';
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    const r = await runBashHook(
      createEmailGateHook(),
      `gws gmail +send --to person8@fixture1.example.com --body $'cost is $5' --dry-run`,
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
      `gws gmail +send --to person25@fixture4.example.com --subject hi --body "please --dry-run this"`,
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated, not bypassed
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
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
      'gws gmail +send --to person25@fixture4.example.com --subject hi --body x',
    );
    const card = gateCard();
    expect(card).toBeDefined(); // gated via inline fallback, NOT allowed
    expect(card!.summary as string).toContain('person25@fixture4.example.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined(); // delivered ack → allow after gate
  });

  it('the Bash rewrite hook prepends NO unset prefix, so the gate sees what the agent typed', async () => {
    // Was codex #126 F1: createBashCommandRewriteHook used to prepend
    // `unset <vars> 2>/dev/null; `, which the email gate then had to strip so a
    // legit --dry-run wasn't refused for starting with `unset` + `;`. The prefix
    // is gone — a container's shell keeps the credential the container runs on —
    // so the gate evaluates the raw command and both outcomes must still hold.
    //
    // MUTATION CHECK: restoring the unset prefix in createBashCommandRewriteHook
    // fails the first two assertions below.
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      process.env.NANOCLAW_EMAIL_GATE_CORE = '/nonexistent/email-gate-core.ts'; // inline path
      delete process.env.NANOCLAW_IS_SCHEDULED_TASK;

      const emailCommand = 'gws gmail +send --to person8@fixture1.example.com --subject hi --body x --dry-run';
      const rewritten = await runRewriteHook(emailCommand);
      expect(rewritten).toBe(emailCommand); // untouched: no unset, no wrap
      expect(rewritten).not.toContain('ANTHROPIC_API_KEY');

      // dry-run → bypass (allow, no staging)
      const dry = await runBashHook(createEmailGateHook(), rewritten);
      expect(dry.permissionDecision).toBeUndefined();
      expect(gateCard()).toBeUndefined();
      expect(ackedRequestId).toBeNull();

      // …a real (non-dry-run) send STILL gates.
      staged.length = 0;
      ackToReturn = { status: 'delivered' };
      const real = await runBashHook(
        createEmailGateHook(),
        'gws gmail +send --to person25@fixture4.example.com --subject hi --body x',
      );
      const card = gateCard();
      expect(card).toBeDefined();
      expect(card!.summary as string).toContain('person25@fixture4.example.com');
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

  it('still callable with NO args, and the one option it gained is optional', () => {
    // The option (`sharedApprovalClaim`) is what arms the one-card-per-tool-call
    // claim, and it must stay opt-in: every existing caller constructs this hook
    // with no arguments and must keep its unclaimed behaviour.
    expect(typeof createEmailGateHook()).toBe('function');
    expect(createEmailGateHook.length).toBe(1); // one FORMAL param, none required
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
    const snowflake = await runBashHook(createBlockSnowflakeConnectorHook(), 'python -c "import snowflake.connector"');
    expect(snowflake.permissionDecision).toBe('deny');
    const gitClone = await runBashHook(
      createBlockGitCloneHook(),
      'git clone https://github.com/x/y /workspace/agent/y',
    );
    expect(gitClone.permissionDecision).toBe('deny');
  });
});

// ── createBlockCodexCompanionHook: block /codex:* companion in-container ──
describe('createBlockCodexCompanionHook', () => {
  it('denies a direct codex-companion.mjs invocation with a redirect to codex exec --yolo', async () => {
    const r = await runBashHook(
      createBlockCodexCompanionHook(),
      'node /workspace/plugins/codex/plugins/codex/scripts/codex-companion.mjs review --cwd /workspace/agent',
    );
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('codex exec --yolo');
  });

  it('denies the bare companion name too (rescue path)', async () => {
    const r = await runBashHook(createBlockCodexCompanionHook(), 'node codex-companion review');
    expect(r.permissionDecision).toBe('deny');
  });

  it('allows the correct in-container path (codex exec --yolo)', async () => {
    const r = await runBashHook(createBlockCodexCompanionHook(), 'codex exec --yolo "reply OK"');
    expect(r.permissionDecision).toBeUndefined();
  });

  it('does not match unrelated commands that merely mention codex', async () => {
    const r = await runBashHook(createBlockCodexCompanionHook(), 'echo "running codex review later"');
    expect(r.permissionDecision).toBeUndefined();
  });
});

// ── createBashCommandRewriteHook: the container credential reaches the shell ──
describe('createBashCommandRewriteHook credential passthrough', () => {
  const SLOTS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_2', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_3'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SLOTS) {
      saved[k] = process.env[k];
      process.env[k] = 'test-value';
    }
  });
  afterEach(() => {
    for (const k of SLOTS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // An agent must be able to run `claude -p` headless under the credential its
  // own container runs on, the way `codex exec` and `opencode run` already
  // could. MUTATION CHECK: restoring the `unset <vars> 2>/dev/null; ` prefix in
  // createBashCommandRewriteHook fails every assertion here.
  it('leaves an ordinary command byte-identical — no unset prefix, no rewrite', async () => {
    for (const cmd of ['claude -p "review this"', 'printenv ANTHROPIC_API_KEY', 'ls -la /workspace']) {
      const out = await runRewriteHook(cmd);
      expect(out).toBe(cmd);
      expect(out).not.toContain('unset ');
    }
  });

  it('never names a credential slot in a rewritten command either', async () => {
    // The two rewrites that DO fire (codex stdin, jest lock) must not reintroduce one.
    for (const cmd of ['codex exec --yolo "x"', 'npx jest']) {
      const out = await runRewriteHook(cmd);
      expect(out).not.toBe(cmd); // a rewrite really did happen
      for (const slot of SLOTS) expect(out).not.toContain(slot);
    }
  });
});

// ── createBashCommandRewriteHook: codex exec stdin /dev/null wrap ──
describe('createBashCommandRewriteHook codex exec stdin fix', () => {
  async function sanitize(command: string): Promise<string | undefined> {
    const input = { tool_name: 'Bash', tool_input: { command } } as unknown as PreToolUseHookInput;
    const out = await createBashCommandRewriteHook()(input as Parameters<HookCallback>[0], EMPTY_CTX, EMPTY_OPTS);
    const hso = (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } })?.hookSpecificOutput;
    return hso?.updatedInput?.command;
  }

  it('wraps a codex exec command so its stdin is /dev/null', async () => {
    const out = await sanitize('codex exec --yolo "reply OK"');
    expect(out).toContain('codex exec --yolo "reply OK"');
    expect(out).toMatch(/^\{ .* ; \} <\/dev\/null$/);
  });

  it('wraps even with a cd prefix (last command is codex)', async () => {
    const out = await sanitize('cd /workspace/agent && codex exec --yolo "x"');
    expect(out).toMatch(/\} <\/dev\/null$/);
    expect(out).toContain('cd /workspace/agent && codex exec');
  });

  it('does not double-redirect when stdin is already /dev/null', async () => {
    const command = 'codex exec --yolo "x" </dev/null';
    const out = await sanitize(command);
    // Already has </dev/null → no group wrap added. With no credential prefix
    // left to prepend either, the hook has nothing to rewrite and returns no
    // updatedInput at all (claude.ts: `if (rewritten === command) return {}`).
    expect(out).toBeUndefined();
    expect(out ?? command).not.toMatch(/\} <\/dev\/null$/);
  });

  it('does not wrap non-codex commands', async () => {
    const out = await sanitize('ls -la /workspace');
    expect(out ?? 'ls -la /workspace').not.toContain('</dev/null');
  });
});

// ── wrapJestSerialized: one jest at a time, and OOM kills reported as void ──
describe('wrapJestSerialized', () => {
  it('takes a lock that FAILS rather than queues, with a distinct conflict code', () => {
    const out = wrapJestSerialized('npx jest');
    // -E 126: flock's default conflict exit is 1, which is also jest's exit for
    // ordinary test failures — the two would be indistinguishable.
    expect(out).toContain('flock -n -E 126 /tmp/.nanoclaw-jest.lock');
    expect(out).not.toContain('flock -w');
  });

  it('preserves the real exit code so a red suite still reads as red', () => {
    expect(wrapJestSerialized('npx jest')).toContain('exit $__nc_rc');
  });

  it('reports an OOM delta as VOID rather than as test failures', () => {
    const out = wrapJestSerialized('npx jest');
    expect(out).toContain('oom_kill');
    expect(out).toContain('VOID');
  });

  it('passes the command through a single argument, quoting included', () => {
    // A naive concatenation would break on the quotes real invocations carry.
    const out = wrapJestSerialized(`npx jest --testPathPattern "a b"`);
    expect(out).toContain(JSON.stringify(`npx jest --testPathPattern "a b"`));
  });
});

describe('createBashCommandRewriteHook: jest serialization', () => {
  const runHook = async (command: string): Promise<string> => {
    const hook = createBashCommandRewriteHook();
    const res = (await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never,
      undefined as never,
      undefined as never,
    )) as { hookSpecificOutput?: { updatedInput?: { command?: string } } };
    return res.hookSpecificOutput?.updatedInput?.command ?? command;
  };

  it('serialises the shapes agents actually type', async () => {
    for (const cmd of ['npx jest --selectProjects unit', 'npm test', 'npm run test:unit', 'yarn test']) {
      expect(await runHook(cmd)).toContain('flock -n -E 126');
    }
  });

  it('leaves an already-locked command alone rather than nesting locks', async () => {
    const out = await runHook('flock -n /tmp/mine.lock npx jest');
    expect(out).not.toContain('/tmp/.nanoclaw-jest.lock');
  });

  it('does not fire on unrelated commands that merely mention testing', async () => {
    // "jest" as a bare word in prose, and a test-named script that is not jest.
    for (const cmd of ['echo "jest is the runner"', 'ls src/__tests__']) {
      expect(await runHook(cmd)).not.toContain('.nanoclaw-jest.lock');
    }
  });

  it('keeps the codex stdin wrap when codex is the one running jest', async () => {
    const out = await runHook('codex exec --yolo "npm test"');
    expect(out).toContain('</dev/null');
    expect(out).toContain('flock -n -E 126');
  });
});

// ── One approval card per tool call (#833) ──
// In a Codex container this hook and the plugin's codex-guard.ts both run on
// every tool call — concurrently, with the same tool_use_id — and both reach the
// outbound-email gate. These tests pin that this hook joins the shared claim
// rather than staging a second card.
describe('createEmailGateHook — one approval card per tool call', () => {
  const CLAIM_CORE = new URL('./__test-fixtures__/gate-claim-core-stub.ts', import.meta.url).pathname;
  const savedEmail = process.env.NANOCLAW_EMAIL_GATE_CORE;
  const savedGuard = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  const savedSched = process.env.NANOCLAW_IS_SCHEDULED_TASK;

  let staged: Array<{ id: string } & Record<string, unknown>>;
  let ackedRequestIds: string[];
  const spies: Array<{ mockRestore: () => void }> = [];

  interface Recorder {
    keyArgs: unknown[][];
    claims: string[];
    published: Array<[string, string]>;
    abandoned: string[];
    peerRequestId: string | null;
    peerAlreadyDecided: boolean;
    decidedChecks: string[];
  }
  const rec = (): Recorder => (globalThis as { __nanoclawGateClaimRec: Recorder }).__nanoclawGateClaimRec;

  const GATED = 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com';

  async function runWithToolUseId(toolUseId: string | undefined): Promise<{ permissionDecision?: string }> {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: GATED },
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    } as unknown as PreToolUseHookInput;
    const out = await createEmailGateHook({ sharedApprovalClaim: true })(
      input as Parameters<HookCallback>[0],
      EMPTY_CTX,
      EMPTY_OPTS,
    );
    return {
      permissionDecision: (out as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput
        ?.permissionDecision,
    };
  }

  beforeEach(() => {
    staged = [];
    ackedRequestIds = [];
    spies.length = 0;
    (globalThis as { __nanoclawGateClaimRec?: Recorder }).__nanoclawGateClaimRec = {
      keyArgs: [],
      claims: [],
      published: [],
      abandoned: [],
      peerRequestId: null,
      peerAlreadyDecided: false,
      decidedChecks: [],
    };
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = CLAIM_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    resetGateClaimApiForTest();
    spies.push(
      spyOn(messagesOut, 'writeMessageOut').mockImplementation((row: { id: string; content: string }) => {
        staged.push({ id: row.id, ...(JSON.parse(row.content) as Record<string, unknown>) });
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
        ackedRequestIds.push(messageId);
        return { status: 'delivered' } as deliveryAcks.DeliveryAck;
      }),
    );
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    resetGateClaimApiForTest();
    if (savedEmail === undefined) delete process.env.NANOCLAW_EMAIL_GATE_CORE;
    else process.env.NANOCLAW_EMAIL_GATE_CORE = savedEmail;
    if (savedGuard === undefined) delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
    else process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = savedGuard;
    if (savedSched === undefined) delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    else process.env.NANOCLAW_IS_SCHEDULED_TASK = savedSched;
  });

  it('keys the claim on the TOOL CALL and the gate — never on the command', async () => {
    // This hook gates the SANITIZED command while the plugin adapter gates the
    // raw one (codex hands every handler one input_json, built before any of
    // them runs). A command-keyed claim produced two keys for one tool call and
    // both guards staged anyway — the exact behaviour the claim removes.
    await runWithToolUseId('exec-abc');
    expect(rec().keyArgs).toEqual([['exec-abc', 'request_bash_gate']]);
  });

  it('as the claim OWNER, stages one card and publishes its requestId', async () => {
    await runWithToolUseId('exec-abc');
    expect(staged).toHaveLength(1);
    expect(rec().published).toEqual([['key:exec-abc|request_bash_gate', staged[0].id as string]]);
    expect(rec().abandoned).toEqual([]);
  });

  it('as a LOSER, stages NOTHING and waits on the peer’s requestId', async () => {
    rec().peerRequestId = 'gate-peer-1';
    const r = await runWithToolUseId('exec-abc');
    expect(staged).toEqual([]);
    expect(ackedRequestIds).toEqual(['gate-peer-1']);
    expect(r.permissionDecision).toBeUndefined(); // peer approved → allow
  });

  it('a LOSER honours the peer’s DENIAL rather than raising its own card', async () => {
    rec().peerRequestId = 'gate-peer-1';
    spies[2].mockRestore();
    spies[2] = spyOn(deliveryAcks, 'awaitDeliveryAck').mockImplementation(
      async () => ({ status: 'failed', error: 'admin declined' }) as deliveryAcks.DeliveryAck,
    );
    const r = await runWithToolUseId('exec-abc');
    expect(staged).toEqual([]);
    expect(r.permissionDecision).toBe('deny');
  });

  it('with NO tool_use_id, behaves exactly as before — one card, no claim', async () => {
    await runWithToolUseId(undefined);
    expect(rec().claims).toEqual([]);
    expect(staged).toHaveLength(1);
  });

  it('is NOT armed unless the caller opts in — the Claude path never claims', async () => {
    // `tool_use_id` is a REQUIRED field of the Claude SDK's PreToolUse input, so
    // keying on its presence would arm the claim where this hook is the only
    // gate and no peer will ever publish.
    const input = {
      tool_name: 'Bash',
      tool_input: { command: GATED },
      tool_use_id: 'exec-abc',
    } as unknown as PreToolUseHookInput;
    await createEmailGateHook()(input as Parameters<HookCallback>[0], EMPTY_CTX, EMPTY_OPTS);
    expect(rec().claims).toEqual([]);
    expect(staged).toHaveLength(1);
  });

  it('WAITS on a peer whose card is still PENDING — the live case', async () => {
    // The host writes a `pending` row the moment it posts the card and leaves
    // it there for the whole decision window, so `pending` is exactly what a
    // loser should wait on. A replay check that counted a pending row as
    // decided would stage a second card for every loser arriving more than one
    // host poll after the owner — the duplication this whole mechanism removes.
    rec().peerRequestId = 'gate-peer-pending';
    rec().peerAlreadyDecided = false;
    await runWithToolUseId('exec-abc');
    expect(rec().decidedChecks).toEqual(['gate-peer-pending']);
    expect(staged).toEqual([]);
    expect(ackedRequestIds).toEqual(['gate-peer-pending']);
  });

  it('REFUSES an already-decided peer requestId and stages its own card', async () => {
    // The claim directory is under /tmp, which the agent can write to. A
    // published id that already carries a `delivered` row is not a live peer —
    // it is a past approval being replayed at a different command, and
    // honouring it would skip the gate outright.
    rec().peerRequestId = 'gate-replayed-1';
    rec().peerAlreadyDecided = true;
    await runWithToolUseId('exec-abc');
    expect(rec().decidedChecks).toEqual(['gate-replayed-1']);
    expect(staged).toHaveLength(1); // its own card, not the replayed decision
    expect(ackedRequestIds).toEqual([staged[0].id as string]);
  });

  it('releases the claim when staging THROWS, so a peer is not left waiting', async () => {
    spies[0].mockRestore();
    spies[0] = spyOn(messagesOut, 'writeMessageOut').mockImplementation(() => {
      throw new Error('outbound.db unavailable');
    });
    await expect(runWithToolUseId('exec-abc')).rejects.toThrow(/outbound.db unavailable/);
    expect(rec().abandoned).toEqual(['key:exec-abc|request_bash_gate']);
    expect(rec().published).toEqual([]);
  });
});
