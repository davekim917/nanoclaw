/**
 * The status-subtext store and its rendering.
 *
 * The interesting cases are the partial ones: this line is assembled from
 * three facts that arrive from different places and any of them can be
 * missing, so "renders whatever it has" is the contract, not "renders when
 * complete".
 */
import { beforeEach, describe, expect, it } from 'bun:test';

import {
  clearContextTokens,
  formatStatusSubtext,
  formatTokens,
  recordContextTokens,
  resetTurnStatus,
  setTurnSettings,
  shortModelName,
} from './turn-status.js';

beforeEach(() => resetTurnStatus());

describe('shortModelName', () => {
  it('drops the vendor prefix and the context-window tag', () => {
    expect(shortModelName('claude-opus-5[1m]')).toBe('opus-5');
    expect(shortModelName('claude-fable-5-1')).toBe('fable-5-1');
  });

  it('keeps the model segment of an opencode slug', () => {
    expect(shortModelName('anthropic/claude-opus-5')).toBe('opus-5');
    expect(shortModelName('moonshotai/kimi-k2.6')).toBe('kimi-k2.6');
  });

  it('passes a codex id through', () => {
    expect(shortModelName('gpt-5.4-codex')).toBe('gpt-5.4-codex');
  });
});

describe('formatTokens', () => {
  it('renders under a thousand exactly, then in k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(830)).toBe('830');
    expect(formatTokens(7249)).toBe('7.2k');
    expect(formatTokens(142_400)).toBe('142k');
    expect(formatTokens(1_004_000)).toBe('1004k');
  });
});

describe('recordContextTokens', () => {
  it('takes the latest reading', () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    recordContextTokens(10_000);
    recordContextTokens(142_400);
    expect(formatStatusSubtext()).toBe('opus-5 · high · 142k context');
  });

  it('ignores a value no provider should have produced', () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    recordContextTokens(NaN);
    recordContextTokens(-1);
    recordContextTokens(undefined);
    recordContextTokens(null);
    // The figure is absent rather than wrong — a bad reading must not print.
    expect(formatStatusSubtext()).toBe('opus-5 · high');
  });
});

describe('formatStatusSubtext', () => {
  it('is null when nothing is known', () => {
    expect(formatStatusSubtext()).toBeNull();
  });

  it('renders the context figure alone when the model was never resolved', () => {
    recordContextTokens(88_000);
    expect(formatStatusSubtext()).toBe('88k context');
  });

  it('renders model and effort with no context figure', () => {
    // Every provider reports context today, but a provider that reports none
    // should still tell the operator what it is running on.
    setTurnSettings('gpt-5.4-codex', 'xhigh');
    expect(formatStatusSubtext()).toBe('gpt-5.4-codex · xhigh');
  });

  it('shows ultracode in place of the effort level it forces', () => {
    // ultracode is xhigh PLUS standing workflow orchestration; printing
    // 'xhigh' would hide the half that changes how the agent works.
    setTurnSettings('claude-opus-5[1m]', 'xhigh', true);
    recordContextTokens(142_400);
    expect(formatStatusSubtext()).toBe('opus-5 · ultracode · 142k context');
  });

  it('follows a mid-turn model change', () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    recordContextTokens(142_400);
    setTurnSettings('claude-haiku-4-5-20251001', 'low');
    expect(formatStatusSubtext()).toBe('haiku-4-5-20251001 · low · 142k context');
  });

  it('clears ultracode when a later turn does not set it', () => {
    setTurnSettings('claude-opus-5[1m]', 'xhigh', true);
    setTurnSettings('claude-opus-5[1m]', 'medium');
    expect(formatStatusSubtext()).toBe('opus-5 · medium');
  });
});

describe('clearContextTokens — the turn boundary', () => {
  it('drops the figure but keeps model and effort', () => {
    // Model and effort describe standing configuration and stay true across a
    // turn boundary; the context number is a measurement of ONE turn.
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    recordContextTokens(142_400);
    clearContextTokens();
    expect(formatStatusSubtext()).toBe('opus-5 · xhigh');
  });

  it('stops a turn with no usage frame from inheriting the previous turn`s figure', () => {
    // The reported bug: recordContextTokens ignores an absent reading, so
    // without a boundary the next turn prints a stale measurement beside a
    // newly selected model, as though it belonged to that reply.
    setTurnSettings('claude-opus-5[1m]', 'xhigh');
    recordContextTokens(142_400);

    clearContextTokens();
    setTurnSettings('claude-haiku-4-5-20251001', 'low');
    recordContextTokens(undefined); // a turn whose frames carried no usage

    expect(formatStatusSubtext()).toBe('haiku-4-5-20251001 · low');
  });

  it('a fresh measurement after the boundary renders normally', () => {
    setTurnSettings('claude-opus-5[1m]', 'high');
    recordContextTokens(142_400);
    clearContextTokens();
    recordContextTokens(12_800);
    expect(formatStatusSubtext()).toBe('opus-5 · high · 13k context');
  });
});
