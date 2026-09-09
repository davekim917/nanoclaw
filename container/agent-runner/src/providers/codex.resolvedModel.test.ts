/**
 * `AgentQuery.resolvedModel` is REQUIRED so no provider can be forgotten.
 *
 * It was optional for one release and codex and opencode simply did not
 * implement it — which is how an unpinned pure task fire on those providers
 * would have landed in `task_run_outcomes` with a NULL model, the same hole
 * three earlier review rounds each closed at one more Claude site.
 *
 * These assert the two non-Claude providers report what they actually resolve,
 * from their OWN default chains rather than a copy of Claude's.
 */
import { describe, it, expect } from 'bun:test';

import { resolveQueryModel } from './codex.js';
import { OPENCODE_NATIVE_DEFAULT_MODEL } from './opencode.js';

describe('non-Claude providers name the model they resolved', () => {
  it('codex falls back to its own configured model, never to absence', () => {
    // codex's chain is stickyConfig.model ?? CODEX_MODEL ?? 'gpt-5.6-sol', and
    // resolveQueryModel is the function the query path uses to apply it.
    expect(resolveQueryModel(undefined, 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveQueryModel('gpt-6-astra', 'gpt-5.6-sol')).toBe('gpt-6-astra');
    // A non-codex model is refused and the fallback still NAMES something.
    expect(resolveQueryModel('claude-sonnet-5', 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('opencode reports a named known-unknown rather than absence', () => {
    // OpenCode picks server-side when nothing names a model and never tells
    // the client which. The ledger has to distinguish "ran on opencode's own
    // default" from "nobody recorded a model", so absence is not an option.
    expect(OPENCODE_NATIVE_DEFAULT_MODEL).toBeTruthy();
    expect(typeof OPENCODE_NATIVE_DEFAULT_MODEL).toBe('string');
    expect(OPENCODE_NATIVE_DEFAULT_MODEL).not.toBe('');
  });
});
