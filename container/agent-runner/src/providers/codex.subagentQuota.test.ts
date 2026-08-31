import { describe, expect, it } from 'bun:test';

import {
  CODEX_CHILD_AGENT_ERROR_FRAMING_RE,
  CODEX_CHILD_AGENT_TURN_FAILED_RE,
  classifyCodexError,
  detectCodexChildAgentQuotaFailure,
  extractCodexThreadItemText,
  isCodexOAuthRotationEligible,
} from './codex.js';

// The real usage-limit sentence, same fixture as codex.quota.test.ts. The
// reset date and billing URL vary per account.
const REAL_QUOTA_SENTENCE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";

// Upstream's verbatim trailing sentence, read out of the installed codex
// 0.151.0 binary (`format_inter_agent_completion_message`).
const UPSTREAM_TURN_FAILED_SENTENCE =
  "This agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.";

/** What upstream injects into the PARENT when a child agent's turn errors. */
function framedChildError(errorText: string): string {
  return `Agent errored: ${errorText}\n\n${UPSTREAM_TURN_FAILED_SENTENCE}`;
}

describe('detectCodexChildAgentQuotaFailure — the multi_agent_v2 injected-message surface', () => {
  it('detects a child agent that died on the account quota', () => {
    const detected = detectCodexChildAgentQuotaFailure({
      id: 'item_1',
      type: 'agentMessage',
      text: framedChildError(REAL_QUOTA_SENTENCE),
    });
    expect(detected).not.toBeNull();
    expect(detected).toStartWith('codex_child_agent_quota_exhausted: ');
  });

  it('routes into the EXISTING rotation path, not a new one', () => {
    // This is the whole point of the fix: the caller attributes the detection
    // to the parent turn as a structured UsageLimitExceeded, and every
    // downstream decision is the one that already existed.
    const classification = classifyCodexError(
      detectCodexChildAgentQuotaFailure({ type: 'agentMessage', text: framedChildError(REAL_QUOTA_SENTENCE) })!,
      'UsageLimitExceeded',
    );
    expect(classification).toBe('quota');
    expect(isCodexOAuthRotationEligible(classification)).toBe(true);
  });

  it('detects the other quota phrasings the app-server uses', () => {
    for (const phrasing of [
      'usage limit reached for this account',
      'Purchase more credits to continue.',
      'You have hit your usage limit.',
    ]) {
      expect(
        detectCodexChildAgentQuotaFailure({ type: 'agentMessage', text: framedChildError(phrasing) }),
      ).not.toBeNull();
    }
  });

  it('tolerates a leading agent-path/nickname prefix line and markdown quoting', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'userMessage',
        text: `/root/task_3 (worker)\n> Agent errored: ${REAL_QUOTA_SENTENCE}\n\n${UPSTREAM_TURN_FAILED_SENTENCE}`,
      }),
    ).not.toBeNull();
  });
});

describe('detectCodexChildAgentQuotaFailure — the multi_agent v1 tool-result surface', () => {
  it('detects the framed child error inside a functionCallOutput payload', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        id: 'item_9',
        type: 'functionCallOutput',
        name: 'wait_agent',
        output: framedChildError(REAL_QUOTA_SENTENCE),
      }),
    ).not.toBeNull();
  });

  it('detects it through a nested content-block result', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'dynamicToolCall',
        result: { content: [{ type: 'text', text: framedChildError(REAL_QUOTA_SENTENCE) }] },
      }),
    ).not.toBeNull();
  });

  it('does NOT detect an UNFRAMED quota error in a tool result', () => {
    // Deliberate, documented gap. Under multi_agent v1 the child's raw error
    // text can reach the parent without upstream's framing; matching bare
    // quota prose in a tool result would make every agent that quotes a
    // usage-limit message rotate a healthy credential slot. A missed v1
    // detection costs the pre-fix behavior; a false rotation kills live turns.
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'functionCallOutput',
        name: 'wait_agent',
        output: REAL_QUOTA_SENTENCE,
      }),
    ).toBeNull();
  });
});

describe('detectCodexChildAgentQuotaFailure — false-positive guard', () => {
  it('does not fire on an agent merely discussing quota handling', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'agentMessage',
        text:
          'I looked at the rotation path. When a subagent hits the usage limit, codex tells the user to ' +
          'purchase more credits, which we must never surface as an instruction.',
      }),
    ).toBeNull();
  });

  it('does not fire on prose quoting the REAL error message verbatim', () => {
    // An agent working on this very file will paste this sentence.
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'agentMessage',
        text: `The app-server throws: "${REAL_QUOTA_SENTENCE}" — that string is what CODEX_USAGE_LIMIT_RE keys on.`,
      }),
    ).toBeNull();
  });

  it('does not fire on prose naming the framing inline alongside the quota text', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'agentMessage',
        text:
          `Upstream forwards it to the parent as "Agent errored: ${REAL_QUOTA_SENTENCE}", ` +
          'so the parent ends up holding text telling it to purchase more credits.',
      }),
    ).toBeNull();
  });

  it('does not fire when the framing prefix is present but the turn-failed sentence is not', () => {
    expect(
      detectCodexChildAgentQuotaFailure({ type: 'agentMessage', text: `Agent errored: ${REAL_QUOTA_SENTENCE}` }),
    ).toBeNull();
  });

  it('does not fire when the turn-failed sentence is present but the framing prefix is not', () => {
    expect(
      detectCodexChildAgentQuotaFailure({
        type: 'agentMessage',
        text: `${REAL_QUOTA_SENTENCE}\n\n${UPSTREAM_TURN_FAILED_SENTENCE}`,
      }),
    ).toBeNull();
  });

  it('does not fire on a framed child error that is NOT a quota error', () => {
    for (const other of [
      'apply_patch failed: file not found',
      'Turn interrupted',
      'ServerOverloaded: try again shortly',
      'Unauthorized: token has been invalidated',
    ]) {
      expect(detectCodexChildAgentQuotaFailure({ type: 'agentMessage', text: framedChildError(other) })).toBeNull();
    }
  });

  it('does not fire on ordinary items the turn produces constantly', () => {
    expect(detectCodexChildAgentQuotaFailure({ type: 'reasoning', summary: ['thinking about limits'] })).toBeNull();
    expect(
      detectCodexChildAgentQuotaFailure({ type: 'commandExecution', command: 'grep -r "usage limit" .', output: '' }),
    ).toBeNull();
  });
});

describe('detectCodexChildAgentQuotaFailure — hostile and malformed shapes never throw', () => {
  it('returns null for non-object and empty payloads', () => {
    for (const value of [null, undefined, '', 0, false, 'Agent errored:', [], {}, Symbol('x')]) {
      expect(detectCodexChildAgentQuotaFailure(value)).toBeNull();
    }
  });

  it('survives a cyclic payload', () => {
    const cyclic: Record<string, unknown> = { type: 'agentMessage' };
    cyclic.content = cyclic;
    cyclic.text = framedChildError(REAL_QUOTA_SENTENCE);
    expect(detectCodexChildAgentQuotaFailure(cyclic)).not.toBeNull();
  });

  it('survives a deeply nested payload without recursing forever', () => {
    let nested: unknown = framedChildError(REAL_QUOTA_SENTENCE);
    for (let i = 0; i < 200; i++) nested = { content: nested };
    expect(() => detectCodexChildAgentQuotaFailure(nested)).not.toThrow();
  });

  it('survives getters that throw', () => {
    const hostile = {
      type: 'agentMessage',
      get text(): string {
        throw new Error('boom');
      },
    };
    expect(() => detectCodexChildAgentQuotaFailure(hostile)).not.toThrow();
    expect(detectCodexChildAgentQuotaFailure(hostile)).toBeNull();
  });

  it('extractCodexThreadItemText never throws on odd values', () => {
    expect(extractCodexThreadItemText(undefined)).toBe('');
    expect(extractCodexThreadItemText(() => 'x')).toBe('');
    expect(extractCodexThreadItemText([null, undefined, 'a', 1, true])).toBe('a\n1\ntrue');
  });
});

describe('framing regexes', () => {
  it('the framing prefix is line-anchored, not substring-anchored', () => {
    expect(CODEX_CHILD_AGENT_ERROR_FRAMING_RE.test('Agent errored: boom')).toBe(true);
    expect(CODEX_CHILD_AGENT_ERROR_FRAMING_RE.test('prefix\nAgent errored: boom')).toBe(true);
    expect(CODEX_CHILD_AGENT_ERROR_FRAMING_RE.test('it said Agent errored: boom')).toBe(false);
  });

  it('the turn-failed sentence tolerates re-wrapped whitespace and a curly apostrophe', () => {
    expect(CODEX_CHILD_AGENT_TURN_FAILED_RE.test(UPSTREAM_TURN_FAILED_SENTENCE)).toBe(true);
    expect(CODEX_CHILD_AGENT_TURN_FAILED_RE.test(UPSTREAM_TURN_FAILED_SENTENCE.replace(/ /g, '\n'))).toBe(true);
    expect(CODEX_CHILD_AGENT_TURN_FAILED_RE.test(UPSTREAM_TURN_FAILED_SENTENCE.replace("'", '’'))).toBe(true);
  });
});
