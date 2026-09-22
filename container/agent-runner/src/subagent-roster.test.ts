/**
 * The subagent clause of the status subtext.
 *
 * A coordinator turn's whole question is "what did you deploy, and at what
 * tier". The roster answers it in one clause, which puts two competing
 * pressures on this code: it has to stay short enough to remain subtext while
 * a fan-out can be a dozen workers, and it has to stay HONEST when a provider
 * only half-answers — Claude reports an observed model but no effort, Codex
 * reports configured model AND effort, OpenCode reports neither today.
 *
 * So the cases here are mostly about partial knowledge and about collapsing,
 * not about the happy path.
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import {
  clearSubagents,
  formatStatusSubtext,
  formatSubagentRoster,
  recordContextTokens,
  recordSubagent,
  resetTurnStatus,
  setTurnSettings,
} from './turn-status.js';

beforeEach(() => resetTurnStatus());

describe('formatSubagentRoster', () => {
  it('is null when the turn delegated nothing', () => {
    // The overwhelmingly common case: it must add NOTHING to the line.
    expect(formatSubagentRoster()).toBeNull();
  });

  it('renders one worker with its model and effort', () => {
    recordSubagent('t1', { model: 'gpt-5.4-codex', effort: 'high' });
    expect(formatSubagentRoster()).toBe('1 subagent: gpt-5.4-codex/high');
  });

  it('collapses workers on the same tier into a count', () => {
    // Six identical workers must not produce six entries.
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      recordSubagent(id, { model: 'claude-sonnet-5', effort: 'high' });
    }
    expect(formatSubagentRoster()).toBe('6 subagents: 6x sonnet-5/high');
  });

  it('orders tiers by how many ran, then by name', () => {
    recordSubagent('a', { model: 'claude-sonnet-5', effort: 'high' });
    recordSubagent('b', { model: 'claude-sonnet-5', effort: 'high' });
    recordSubagent('c', { model: 'claude-haiku-4-5', effort: 'low' });
    expect(formatSubagentRoster()).toBe('3 subagents: 2x sonnet-5/high, haiku-4-5/low');
  });

  it('caps the list but keeps the total honest', () => {
    // The count before the colon is the real number even when the tail is
    // hidden — a capped list must not understate the fan-out.
    recordSubagent('a', { model: 'm1', effort: 'high' });
    recordSubagent('b', { model: 'm2', effort: 'high' });
    recordSubagent('c', { model: 'm3', effort: 'high' });
    recordSubagent('d', { model: 'm4', effort: 'high' });
    recordSubagent('e', { model: 'm5', effort: 'high' });

    const roster = formatSubagentRoster()!;
    expect(roster.startsWith('5 subagents: ')).toBe(true);
    expect(roster).toContain('+2 more');
  });

  it('renders model alone when the provider reports no effort', () => {
    // Claude's case today: observed model, effort not on the frame and
    // deliberately not inferred from the agent type's name.
    recordSubagent('t1', { type: 'worker-xhigh', model: 'claude-sonnet-5' });
    expect(formatSubagentRoster()).toBe('1 subagent: sonnet-5');
  });

  it('falls back to the agent type when the model is unknown', () => {
    // Codex between the activity item and the thread read, or a thread list
    // that failed: we still know it delegated, and to what.
    recordSubagent('t1', { type: 'reviewer' });
    expect(formatSubagentRoster()).toBe('1 subagent: reviewer');
  });

  it('still counts a worker it knows nothing about', () => {
    recordSubagent('t1', {});
    expect(formatSubagentRoster()).toBe('1 subagent');
  });
});

describe('recordSubagent — merging', () => {
  it('fills gaps across calls without erasing what is known', () => {
    // Codex's real sequence: the activity item names the agent path, and the
    // model/effort arrive only after the end-of-turn thread read.
    recordSubagent('thread-9', { type: 'reviewer' });
    recordSubagent('thread-9', { model: 'gpt-5.4-codex', effort: 'xhigh' });
    expect(formatSubagentRoster()).toBe('1 subagent: gpt-5.4-codex/xhigh');
  });

  it('counts one worker once however many frames it emits', () => {
    // Claude keys on parent_tool_use_id precisely so a chatty worker is not
    // counted twenty times.
    for (let i = 0; i < 20; i++) recordSubagent('toolu_1', { model: 'claude-sonnet-5' });
    expect(formatSubagentRoster()).toBe('1 subagent: sonnet-5');
  });

  it('ignores an empty key rather than inventing a worker', () => {
    recordSubagent('', { model: 'claude-sonnet-5' });
    expect(formatSubagentRoster()).toBeNull();
  });
});

describe('the roster inside the full subtext', () => {
  it('appends after the context figure', () => {
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    recordContextTokens(142_400);
    recordSubagent('a', { model: 'claude-sonnet-5', effort: 'high' });
    recordSubagent('b', { model: 'claude-sonnet-5', effort: 'high' });

    expect(formatStatusSubtext()).toBe('opus-5 · xhigh · 142k context · 2 subagents: 2x sonnet-5/high');
  });

  it('leaves the line untouched on a turn that delegated nothing', () => {
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    recordContextTokens(142_400);
    expect(formatStatusSubtext()).toBe('opus-5 · xhigh · 142k context');
  });

  it('is dropped at the turn boundary', () => {
    // A roster describes ONE turn's delegation; carrying it forward would
    // name workers that are no longer running.
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    recordSubagent('a', { model: 'claude-sonnet-5', effort: 'high' });
    clearSubagents();
    expect(formatStatusSubtext()).toBe('opus-5 · xhigh');
  });
});
