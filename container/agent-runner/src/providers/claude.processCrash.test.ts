import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from './claude.js';

const provider = new ClaudeProvider({});

describe('ClaudeProvider.isLocalProcessCrash', () => {
  it('matches a signal death reported through the sh wrapper as 128+N', () => {
    const err = new Error(
      'Claude Code process exited with code 134. stderr: Claude configuration file not found at: /home/node/.claude.json',
    );
    expect(provider.isLocalProcessCrash(err)).toBe(true);
    expect(provider.isLocalProcessCrash(new Error('Claude Code process exited with code 137'))).toBe(true);
    expect(provider.isLocalProcessCrash(new Error('Claude Code process terminated by signal SIGSEGV'))).toBe(true);
  });

  it('leaves the CLI’s own deliberate failures to the other rungs', () => {
    expect(provider.isLocalProcessCrash(new Error('Claude Code process exited with code 1. stderr: auth'))).toBe(false);
    expect(provider.isLocalProcessCrash(new Error('Claude Code process exited with code 128'))).toBe(false);
    expect(provider.isLocalProcessCrash(new Error('Rate limit [seven_day] (resets soon)'))).toBe(false);
    expect(provider.isLocalProcessCrash(new Error('stderr: Claude Code process exited with code 134'))).toBe(false);
  });
});
