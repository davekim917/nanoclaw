import { describe, it, expect } from 'bun:test';

import { QUOTA_RESULT_RE, SUBSCRIPTION_BLOCKED_RE } from './claude.js';

// QUOTA_RESULT_RE gates OAuth-fallback rotation: when a top-level `result`
// text matches, the provider throws `subscription_quota_exhausted` so the
// poll loop advances to the next CLAUDE_CODE_OAUTH_TOKEN_N. A wording the
// regex misses = rotation silently fails and the dead-stop quota message is
// dispatched to the user instead (the prod incident this test guards).
describe('QUOTA_RESULT_RE', () => {
  it('matches the weekly/extra-usage cap wording', () => {
    expect(QUOTA_RESULT_RE.test('You’re out of extra usage · resets 3pm')).toBe(true);
    expect(QUOTA_RESULT_RE.test("You're out of usage · resets later")).toBe(true);
    expect(QUOTA_RESULT_RE.test("You're out of weekly usage")).toBe(true);
  });

  it('matches the 5-hour session-window cap wording (the regression)', () => {
    expect(
      QUOTA_RESULT_RE.test("You've hit your session limit · resets 10:30pm (America/New_York)"),
    ).toBe(true);
    expect(QUOTA_RESULT_RE.test("You've hit your usage limit · resets soon")).toBe(true);
    expect(QUOTA_RESULT_RE.test("You've reached your session limit")).toBe(true);
  });

  it('matches the org/credit monthly-spend cap wording (2026-06-11 incident)', () => {
    // Exact text captured from illysium + dirt-market outbound DBs,
    // 2026-06-11 ~21:49–22:01 UTC.
    expect(
      QUOTA_RESULT_RE.test(
        "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage",
      ),
    ).toBe(true);
    // Plausible near-future variants the repeated-qualifier class must absorb.
    expect(QUOTA_RESULT_RE.test("You've hit your monthly spend limit")).toBe(true);
    expect(QUOTA_RESULT_RE.test('You’ve hit your org’s monthly spend limit · resets July 1')).toBe(
      true,
    );
    expect(QUOTA_RESULT_RE.test("You've reached your account's monthly credit limit")).toBe(true);
    expect(QUOTA_RESULT_RE.test("You've hit your team's daily token limit")).toBe(true);
  });

  it('does not match benign agent prose mentioning usage/limit in passing', () => {
    expect(QUOTA_RESULT_RE.test('Your usage of the API looks healthy.')).toBe(false);
    expect(QUOTA_RESULT_RE.test("You've hit a snag with the retry limit downstream.")).toBe(false);
    expect(QUOTA_RESULT_RE.test('The rate limit on the endpoint is 100 req/min.')).toBe(false);
    expect(QUOTA_RESULT_RE.test('Here is a summary of your token usage limit settings.')).toBe(false);
  });
});

// SUBSCRIPTION_BLOCKED_RE gates the same rotation path for accounts whose
// org has disabled Claude Code subscription access entirely (as opposed to
// quota exhaustion). Surfaced 2026-06-11 on a fallback token mid-rotation.
describe('SUBSCRIPTION_BLOCKED_RE', () => {
  it('matches the org access-disabled wording (2026-06-11 incident)', () => {
    // Exact text captured from the illysium outbound DB, 2026-06-11 22:22 UTC.
    expect(
      SUBSCRIPTION_BLOCKED_RE.test(
        'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
      ),
    ).toBe(true);
    // Plausible near-future variants.
    expect(SUBSCRIPTION_BLOCKED_RE.test('Your organization has disabled Claude Code access')).toBe(
      true,
    );
    expect(SUBSCRIPTION_BLOCKED_RE.test('Your admin has disabled Claude access for your team')).toBe(
      true,
    );
    expect(SUBSCRIPTION_BLOCKED_RE.test('Your team has disabled Claude subscription access')).toBe(
      true,
    );
  });

  it('does not match agent prose about other disabled things', () => {
    expect(SUBSCRIPTION_BLOCKED_RE.test('Your organization has disabled SSO for this app.')).toBe(
      false,
    );
    expect(
      SUBSCRIPTION_BLOCKED_RE.test('Your organization has disabled access to the staging cluster.'),
    ).toBe(false);
    expect(
      SUBSCRIPTION_BLOCKED_RE.test('I checked: your organization has Claude access enabled.'),
    ).toBe(false);
  });
});
