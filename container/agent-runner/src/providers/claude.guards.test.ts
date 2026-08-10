import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  createSanitizeBashHook,
  wrapJestSerialized,
  createSelfApprovalBlockHook,
  createBlockSnowflakeConnectorHook,
  createBlockGitCloneHook,
  createBlockSnapshotMutationHook,
  createBlockCodexCompanionHook,
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
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
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
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
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
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
    expect(ackedRequestId).not.toBeNull();
    expect(r.permissionDecision).toBeUndefined();
  });

  it('timeout ack (null) → deny', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    delete process.env.NANOCLAW_IS_SCHEDULED_TASK;
    ackToReturn = null; // awaitDeliveryAck timed out
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('timed out');
  });

  it('scheduled tasks bypass the gate (verdict allow, no staging)', async () => {
    process.env.NANOCLAW_EMAIL_GATE_CORE = EMAIL_STUB_CORE;
    process.env.NANOCLAW_IS_SCHEDULED_TASK = '1';
    const r = await runBashHook(createEmailGateHook(), 'gws gmail +send STUB_EMAIL_GATE --to person8@fixture1.example.com');
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

  it('inline fallback: a real --dry-run with ANSI-C $\'…\' body still bypasses (QA codex re-pass #4)', async () => {
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
        `${prefix}gws gmail +send --to person8@fixture1.example.com --subject hi --body x --dry-run`,
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
        `${prefix}gws gmail +send --to person25@fixture4.example.com --subject hi --body x`,
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

// ── createSanitizeBashHook: codex exec stdin /dev/null wrap ──
describe('createSanitizeBashHook codex exec stdin fix', () => {
  async function sanitize(command: string): Promise<string | undefined> {
    const input = { tool_name: 'Bash', tool_input: { command } } as unknown as PreToolUseHookInput;
    const out = await createSanitizeBashHook()(
      input as Parameters<HookCallback>[0],
      EMPTY_CTX,
      EMPTY_OPTS,
    );
    const hso = (out as { hookSpecificOutput?: { updatedInput?: { command?: string } } })
      ?.hookSpecificOutput;
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
    const out = await sanitize('codex exec --yolo "x" </dev/null');
    // Already has </dev/null → no group wrap added.
    expect(out).not.toMatch(/\} <\/dev\/null$/);
  });

  it('does not wrap non-codex commands', async () => {
    const out = await sanitize('ls -la /workspace');
    expect(out ?? 'ls -la /workspace').not.toContain('</dev/null');
  });
});

describe('createBlockSnapshotMutationHook (inline fallback — no core mounted)', () => {
  const saved = process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  beforeEach(() => {
    process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = '/nonexistent/core.ts';
  });
  afterEach(() => {
    if (saved !== undefined) process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE = saved;
    else delete process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE;
  });

  it('blocks a checkout aimed at a snapshot path', async () => {
    const r = await runBashHook(
      createBlockSnapshotMutationHook(),
      'cd /workspace/workgroup/REPO-A && git checkout TICKET-1-fix',
    );
    expect(r.permissionDecision).toBe('deny');
    expect(r.permissionDecisionReason).toContain('read-only snapshot');
  });

  it('blocks git -C mutations in a snapshot', async () => {
    const r = await runBashHook(createBlockSnapshotMutationHook(), 'git -C /workspace/workgroup/REPO-B commit -am wip');
    expect(r.permissionDecision).toBe('deny');
  });

  it('allows read-only git in a snapshot', async () => {
    const r = await runBashHook(createBlockSnapshotMutationHook(), 'git -C /workspace/workgroup/REPO-B log --oneline -5');
    expect(r.permissionDecision).toBeUndefined();
  });

  it('allows mutations in thread worktrees and .worktrees checkouts', async () => {
    for (const cmd of [
      'git -C /workspace/worktrees/XZO commit -am wip',
      'git -C /workspace/workgroup/.worktrees/XZO-pr213-review commit -am wip',
    ]) {
      const r = await runBashHook(createBlockSnapshotMutationHook(), cmd);
      expect(r.permissionDecision).toBeUndefined();
    }
  });

  it('does not false-positive on mutation verbs in ARGUMENTS of read-only commands', async () => {
    const r = await runBashHook(
      createBlockSnapshotMutationHook(),
      'git -C /workspace/workgroup/REPO-B log --grep commit --oneline',
    );
    expect(r.permissionDecision).toBeUndefined();
  });

  it('blocks ref surgery aimed at the mirror and rescue namespaces', async () => {
    for (const cmd of [
      'git -C /workspace/workgroup/.repos/XZO.git update-ref refs/heads/main deadbeef',
      'git -C /workspace/workgroup/.repos/XZO.git branch -D some-branch',
      'cd /workspace/workgroup/.rescues/2026 && git reset --hard HEAD~1',
    ]) {
      const r = await runBashHook(createBlockSnapshotMutationHook(), cmd);
      expect(r.permissionDecision).toBe('deny');
    }
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

describe('createSanitizeBashHook: jest serialization', () => {
  const runHook = async (command: string): Promise<string> => {
    const hook = createSanitizeBashHook();
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
