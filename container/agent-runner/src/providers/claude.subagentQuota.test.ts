import { describe, it, expect } from 'bun:test';

import {
  QUOTA_EMBEDDED_RE,
  QUOTA_RESULT_RE,
  SUBAGENT_QUOTA_REPLACEMENT_TEXT,
  SUBSCRIPTION_BLOCKED_EMBEDDED_RE,
  SUBAGENT_TOOL_MATCHER,
  SUBAGENT_TOOL_NAMES,
  SUBSCRIPTION_BLOCKED_RE,
  classifySubagentQuotaText,
  createSubagentQuotaHook,
  subagentQuotaFromTaskNotification,
} from './claude.js';

// Every real wording enumerated in the claude.ts comment block, plus the
// curly-apostrophe variant. The anchored form guards the top-level `result`
// path; the unanchored form guards a subagent's tool_response, where the same
// prose arrives buried mid-string. Both are derived from ONE pattern body, and
// this table is the check that they stay in lockstep — the historical failure
// is a wording that keeps rotating on one surface and silently stops on the
// other.
const QUOTA_WORDINGS = [
  // weekly / extra usage cap
  "You're out of extra usage · resets 3pm",
  'You’re out of extra usage · resets 3pm',
  "You're out of usage · resets later",
  "You're out of weekly usage",
  // 5-hour session-window cap
  "You've hit your session limit · resets 10:30pm (America/New_York)",
  'You’ve hit your session limit · resets 10:30pm',
  "You've reached your session limit",
  "You've hit your usage limit · resets soon",
  // org / credit monthly spend cap (2026-06-11 incident wording)
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
  'You’ve hit your org’s monthly spend limit · resets July 1',
  "You've reached your account's monthly credit limit",
  "You've hit your team's daily token limit",
];

const BLOCKED_WORDINGS = [
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
  'Your organization has disabled Claude Code access',
  'Your admin has disabled Claude access for your team',
  'Your team has disabled Claude subscription access',
];

/** How a quota message actually reaches us from a subagent: buried mid-string. */
function embed(wording: string): string {
  return [
    'Subagent report',
    '',
    'I started reviewing the diff and then the run stopped.',
    wording,
    '',
    'Nothing else was completed.',
  ].join('\n');
}

describe('quota patterns: anchored and embedded stay in lockstep', () => {
  it('matches every real quota wording in result position AND embedded position', () => {
    for (const wording of QUOTA_WORDINGS) {
      expect(QUOTA_RESULT_RE.test(wording)).toBe(true);
      expect(QUOTA_EMBEDDED_RE.test(wording)).toBe(true);
      // The whole point of the unanchored twin: mid-string still matches,
      // where the anchored form (correctly) does not.
      expect(QUOTA_EMBEDDED_RE.test(embed(wording))).toBe(true);
      expect(QUOTA_RESULT_RE.test(embed(wording))).toBe(false);
    }
  });

  it('matches every org-disabled wording in result position AND embedded position', () => {
    for (const wording of BLOCKED_WORDINGS) {
      expect(SUBSCRIPTION_BLOCKED_RE.test(wording)).toBe(true);
      expect(SUBSCRIPTION_BLOCKED_EMBEDDED_RE.test(wording)).toBe(true);
      expect(SUBSCRIPTION_BLOCKED_EMBEDDED_RE.test(embed(wording))).toBe(true);
      expect(SUBSCRIPTION_BLOCKED_RE.test(embed(wording))).toBe(false);
    }
  });

  it('keeps the anchored forms rejecting benign prose (unchanged behavior)', () => {
    expect(QUOTA_RESULT_RE.test('Your usage of the API looks healthy.')).toBe(false);
    expect(QUOTA_RESULT_RE.test("You've hit a snag with the retry limit downstream.")).toBe(false);
    expect(SUBSCRIPTION_BLOCKED_RE.test('Your organization has disabled SSO for this app.')).toBe(false);
  });
});

// Self-match guard: the hook rewrites the very output it matched on. If the
// replacement text re-matched, the replayed turn would look quota-exhausted
// again and rotation would loop.
describe('SUBAGENT_QUOTA_REPLACEMENT_TEXT', () => {
  it('does not match the quota or blocked patterns', () => {
    expect(QUOTA_EMBEDDED_RE.test(SUBAGENT_QUOTA_REPLACEMENT_TEXT)).toBe(false);
    expect(QUOTA_RESULT_RE.test(SUBAGENT_QUOTA_REPLACEMENT_TEXT)).toBe(false);
    expect(SUBSCRIPTION_BLOCKED_EMBEDDED_RE.test(SUBAGENT_QUOTA_REPLACEMENT_TEXT)).toBe(false);
    expect(SUBSCRIPTION_BLOCKED_RE.test(SUBAGENT_QUOTA_REPLACEMENT_TEXT)).toBe(false);
  });

  it('does not tell the model to get anyone to raise a limit', () => {
    expect(SUBAGENT_QUOTA_REPLACEMENT_TEXT).not.toMatch(/raise it|claude\.ai\/settings\/usage/i);
  });
});

type HookHarness = {
  hook: ReturnType<typeof createSubagentQuotaHook>;
  detections: string[];
  interrupts: number;
};

function harness(interruptImpl?: () => Promise<unknown>): HookHarness {
  const detections: string[] = [];
  const state = { interrupts: 0 };
  const hook = createSubagentQuotaHook({
    onDetect: (marked) => detections.push(marked),
    interrupt: () => {
      state.interrupts++;
      return interruptImpl ? interruptImpl() : Promise.resolve(undefined);
    },
  });
  return {
    hook,
    detections,
    get interrupts() {
      return state.interrupts;
    },
  } as HookHarness;
}

function invoke(h: HookHarness, toolResponse: unknown, toolName = 'Agent') {
  return h.hook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: { prompt: 'review the diff' },
      tool_response: toolResponse,
      tool_use_id: 'toolu_test',
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/workspace',
      permission_mode: 'bypassPermissions',
    } as never,
    'toolu_test',
    { signal: new AbortController().signal },
  );
}

describe('createSubagentQuotaHook', () => {
  it('records the quota marker and rewrites the output, for every response shape', async () => {
    const wording =
      "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage";
    const shapes: unknown[] = [
      embed(wording),
      [{ type: 'text', text: embed(wording) }],
      [
        { type: 'text', text: 'partial notes' },
        { type: 'text', text: embed(wording) },
      ],
      { content: [{ type: 'text', text: embed(wording) }] },
      { content: embed(wording) },
    ];

    for (const shape of shapes) {
      const h = harness();
      const out = (await invoke(h, shape)) as {
        hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: unknown };
      };
      expect(h.detections.length).toBe(1);
      expect(h.detections[0].startsWith('subscription_quota_exhausted: ')).toBe(true);
      expect(h.interrupts).toBe(1);
      expect(out.hookSpecificOutput?.hookEventName).toBe('PostToolUse');
      expect(out.hookSpecificOutput?.updatedToolOutput).toBe(SUBAGENT_QUOTA_REPLACEMENT_TEXT);
    }
  });

  it('fires under the legacy tool name too', async () => {
    const h = harness();
    await invoke(h, embed("You've hit your session limit · resets 10:30pm"), 'Task');
    expect(h.detections.length).toBe(1);
    expect(h.interrupts).toBe(1);
  });

  it('uses the access-disabled marker for an org block', async () => {
    const h = harness();
    const out = (await invoke(h, [
      { type: 'text', text: embed('Your organization has disabled Claude subscription access for Claude Code') },
    ])) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
    expect(h.detections.length).toBe(1);
    expect(h.detections[0].startsWith('subscription_access_disabled: ')).toBe(true);
    expect(out.hookSpecificOutput?.updatedToolOutput).toBe(SUBAGENT_QUOTA_REPLACEMENT_TEXT);
  });

  it('leaves a normal Task response untouched — no detection, no rewrite', async () => {
    const h = harness();
    const out = (await invoke(h, [
      {
        type: 'text',
        text: 'Reviewed the diff. Two findings, both in src/router.ts. The rate limit on the endpoint is 100 req/min.',
      },
    ])) as { hookSpecificOutput?: unknown; continue?: boolean };
    expect(h.detections).toEqual([]);
    expect(h.interrupts).toBe(0);
    // No rewrite at all, not an identity rewrite: an identity rewrite races
    // sibling PostToolUse hooks last-write-wins and can clobber a redaction.
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.continue).toBe(true);
  });

  it('never throws on an unexpected or hostile tool_response shape', async () => {
    const cyclic: Record<string, unknown> = { type: 'text' };
    cyclic.self = cyclic;
    for (const shape of [undefined, null, 0, false, [], {}, cyclic, Symbol('x')]) {
      const h = harness();
      const out = (await invoke(h, shape)) as { continue?: boolean; hookSpecificOutput?: unknown };
      expect(h.detections).toEqual([]);
      expect(out.continue).toBe(true);
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  it('swallows a rejected interrupt instead of failing the hook', async () => {
    const h = harness(() => Promise.reject(new Error('interrupt unavailable')));
    const out = (await invoke(h, embed("You've hit your session limit · resets 10:30pm"))) as {
      hookSpecificOutput?: { updatedToolOutput?: unknown };
    };
    expect(h.detections.length).toBe(1);
    expect(out.hookSpecificOutput?.updatedToolOutput).toBe(SUBAGENT_QUOTA_REPLACEMENT_TEXT);
    // Let the rejected promise settle so the .catch() runs before teardown.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ── Async subagents: the task_notification surface ──
//
// An agent that launches a subagent ASYNCHRONOUSLY gets an `Agent` tool_result of
// just "Async agent launched successfully…" — the PostToolUse hook above has
// nothing to match on. The death arrives later as a system/task_notification.
// Verbatim from the 2026-09-02 03:17 UTC incident:
const INCIDENT_SUMMARY =
  'Agent "Wave 2A trade spend web pages" failed: Agent terminated early due to an API error: ' +
  "You've hit your session limit · resets 12am (America/New_York) (error type rate_limit, HTTP 429, " +
  'request id req_011CedtTBWyKFHtu1UsNPTug, model sent to the API: claude-sonnet-5)';

describe('classifySubagentQuotaText', () => {
  it('classifies the incident summary as quota exhaustion', () => {
    expect(classifySubagentQuotaText(INCIDENT_SUMMARY)).toBe('subscription_quota_exhausted');
  });

  it('classifies an org block as access disabled', () => {
    expect(
      classifySubagentQuotaText(
        'Agent "docs sweep" failed: Your organization has disabled Claude subscription access for Claude Code',
      ),
    ).toBe('subscription_access_disabled');
  });

  it('returns null for benign text and for the empty string', () => {
    expect(classifySubagentQuotaText('Reviewed the diff; two findings in src/router.ts.')).toBe(null);
    expect(classifySubagentQuotaText('')).toBe(null);
  });

  it('is the single source both detection surfaces agree on', () => {
    // Whatever the hook's embedded regexes match, the classifier must too —
    // this is the lockstep guard for the two-surface split.
    for (const wording of QUOTA_WORDINGS)
      expect(classifySubagentQuotaText(embed(wording))).toBe('subscription_quota_exhausted');
    for (const wording of BLOCKED_WORDINGS)
      expect(classifySubagentQuotaText(embed(wording))).toBe('subscription_access_disabled');
    // And the replacement text must not classify, or a replayed turn would
    // look quota-exhausted forever.
    expect(classifySubagentQuotaText(SUBAGENT_QUOTA_REPLACEMENT_TEXT)).toBe(null);
  });
});

describe('subagentQuotaFromTaskNotification', () => {
  it('detects the incident notification and marks it for rotation', () => {
    const marked = subagentQuotaFromTaskNotification({ status: 'failed', summary: INCIDENT_SUMMARY }, 'Agent');
    expect(marked).not.toBe(null);
    expect(marked!.startsWith('subscription_quota_exhausted: ')).toBe(true);
    expect(marked!.length).toBeLessThanOrEqual('subscription_quota_exhausted: '.length + 300);
  });

  it('detects an org block on the same surface', () => {
    const marked = subagentQuotaFromTaskNotification(
      { status: 'failed', summary: 'Agent "x" failed: Your organization has disabled Claude Code access' },
      'Task',
    );
    expect(marked?.startsWith('subscription_access_disabled: ')).toBe(true);
  });

  it('treats an absent tool_use_id (unclassifiable planned task) as a subagent', () => {
    // shouldForwardTaskNotification's documented default: an unknown tool is
    // the planned-task case the feature was built for, so it is NOT suppressed.
    expect(subagentQuotaFromTaskNotification({ status: 'failed', summary: INCIDENT_SUMMARY }, undefined)).not.toBe(
      null,
    );
  });

  // ── Negative cases: the framing the synchronous surface cannot require ──

  it('ignores a COMPLETED notification whose summary quotes the exact quota string', () => {
    // A subagent reporting ON quota handling is not an outage. This is the
    // false positive the sync hook is knowingly exposed to and this surface
    // is not.
    expect(subagentQuotaFromTaskNotification({ status: 'completed', summary: INCIDENT_SUMMARY }, 'Task')).toBe(null);
    expect(
      subagentQuotaFromTaskNotification(
        { status: 'completed', summary: 'Documented the retry path for "You\'ve hit your session limit".' },
        'Task',
      ),
    ).toBe(null);
  });

  it('ignores a STOPPED notification, including the no-completion-record wording', () => {
    expect(
      subagentQuotaFromTaskNotification(
        { status: 'stopped', summary: 'No completion record was found for this agent.' },
        'Task',
      ),
    ).toBe(null);
    expect(subagentQuotaFromTaskNotification({ status: 'stopped', summary: INCIDENT_SUMMARY }, 'Task')).toBe(null);
  });

  it('ignores a FAILED notification whose error is not a quota error', () => {
    expect(
      subagentQuotaFromTaskNotification(
        {
          status: 'failed',
          summary: 'Agent "x" failed: Agent terminated early due to an API error: 500 internal server error',
        },
        'Task',
      ),
    ).toBe(null);
  });

  it('ignores a backgrounded Bash task, whose summary is raw command text', () => {
    expect(subagentQuotaFromTaskNotification({ status: 'failed', summary: INCIDENT_SUMMARY }, 'Bash')).toBe(null);
    expect(subagentQuotaFromTaskNotification({ status: 'failed', summary: INCIDENT_SUMMARY }, 'WebFetch')).toBe(null);
  });

  it('ignores a missing status or a missing summary', () => {
    expect(subagentQuotaFromTaskNotification({ summary: INCIDENT_SUMMARY }, 'Task')).toBe(null);
    expect(subagentQuotaFromTaskNotification({ status: 'failed' }, 'Task')).toBe(null);
    expect(subagentQuotaFromTaskNotification({ status: 'failed', summary: undefined }, 'Task')).toBe(null);
  });
});

// The subagent tool is named `Agent` on this SDK — sdk-tools.d.ts declares
// AgentInput (with subagent_type / run_in_background) and has NO TaskInput.
// `Task` is the old name. A hook registered under `matcher: 'Task'` matches
// nothing here, which is exactly how the synchronous detection path shipped
// dead.
describe('SUBAGENT_TOOL_MATCHER', () => {
  // Replicates the CLI's own matcher semantics (verified against the installed
  // claude 2.1.258): a matcher of the plain-list shape /^[a-zA-Z0-9_|]+$/ is
  // split on `|` and compared to the tool name by EXACT membership; only a
  // matcher failing that shape is compiled as an unanchored RegExp.
  const PLAIN_LIST_SHAPE = /^[a-zA-Z0-9_|]+$/;
  function cliMatches(matcher: string, toolName: string): boolean {
    if (PLAIN_LIST_SHAPE.test(matcher)) {
      return matcher
        .split('|')
        .map((n) => n.trim())
        .filter(Boolean)
        .includes(toolName);
    }
    return new RegExp(matcher).test(toolName);
  }

  it('takes the CLI plain-list path, not the unanchored-regex fallback', () => {
    expect(PLAIN_LIST_SHAPE.test(SUBAGENT_TOOL_MATCHER)).toBe(true);
  });

  it('matches the live subagent tool name and the legacy one', () => {
    expect(cliMatches(SUBAGENT_TOOL_MATCHER, 'Agent')).toBe(true);
    expect(cliMatches(SUBAGENT_TOOL_MATCHER, 'Task')).toBe(true);
  });

  it('does not match Bash, so a backgrounded command never trips the hook', () => {
    expect(cliMatches(SUBAGENT_TOOL_MATCHER, 'Bash')).toBe(false);
  });

  it('does not leak onto the unrelated Task* management tools', () => {
    // The reason the matcher must stay plain-list shaped: an unanchored
    // `new RegExp('Task')` would match every one of these.
    for (const t of ['TaskOutput', 'TaskStop', 'TaskCreate', 'TaskList', 'AgentTaskThing']) {
      expect(cliMatches(SUBAGENT_TOOL_MATCHER, t)).toBe(false);
    }
  });

  it('agrees with shouldForwardTaskNotification on every subagent name', () => {
    // The hook matcher and the task_notification gate must cover the same
    // tools, or one surface detects a quota death the other ignores.
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect(cliMatches(SUBAGENT_TOOL_MATCHER, name)).toBe(true);
      expect(subagentQuotaFromTaskNotification({ status: 'failed', summary: INCIDENT_SUMMARY }, name)).not.toBe(null);
    }
  });
});
