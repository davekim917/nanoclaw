import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { allowSubprocess, resetHermeticityAllowances } from '../test-hermeticity.js';
import { hookFailureDenyReason, recordHookFailure, summarizeHookError } from './hook-failure.js';

describe('summarizeHookError', () => {
  it('keeps the error class and message on one line', () => {
    const err = new TypeError('database is locked\n    at open (connection.ts:55)');
    expect(summarizeHookError(err)).toBe('TypeError: database is locked at open (connection.ts:55)');
  });

  it('bounds a long message', () => {
    const summary = summarizeHookError(new Error('x'.repeat(500)));
    expect(summary.length).toBe(201);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('never includes the stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at secretFrame (/workspace/agent/secret.ts:1:1)';
    expect(summarizeHookError(err)).not.toContain('secretFrame');
  });

  it('stringifies a non-Error throw', () => {
    expect(summarizeHookError('plain failure')).toBe('plain failure');
  });
});

describe('hookFailureDenyReason', () => {
  it('names the stage and cause and asks for one retry, not a report-only halt', () => {
    const reason = hookFailureDenyReason('mailbox start', new Error('database is locked'));
    expect(reason.startsWith('BLOCKED: ')).toBe(true);
    expect(reason).toContain('at mailbox start (Error: database is locked)');
    expect(reason).toContain('not a policy verdict');
    expect(reason).toContain('retry the command once');
    expect(reason).toContain('UTC time');
    expect(reason).not.toContain('rather than retrying');
  });
});

describe('recordHookFailure', () => {
  afterEach(() => closeSessionDb());

  it('writes a record-only work_log row naming the stage and cause', async () => {
    initTestSessionDb();
    await recordHookFailure('hook chain', new Error('database is locked'));
    const rows = getUndeliveredMessages().filter((row) => row.kind === 'work_log');
    expect(rows).toHaveLength(1);
    const text = (JSON.parse(rows[0].content) as { text: string }).text;
    expect(text).toContain('PreToolUse failed closed at hook chain');
    expect(text).toContain('Error: database is locked');
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('resolves without throwing when no mailbox is available', async () => {
    await expect(recordHookFailure('mailbox start', new Error('unable to open database file'))).resolves.toBeUndefined();
  });
});

describe('codex hook CLI fail-closed deny', () => {
  const BASE = '/tmp/nanoclaw-codex-hook-failure-test';

  beforeEach(() => {
    allowSubprocess(['bun']);
    fs.rmSync(BASE, { recursive: true, force: true });
    fs.mkdirSync(BASE, { recursive: true });
  });
  afterEach(() => {
    resetHermeticityAllowances();
    fs.rmSync(BASE, { recursive: true, force: true });
  });

  // With no session DBs reachable the mailbox cannot start, which is the stage this exercises.
  it.skipIf(fs.existsSync('/workspace/outbound.db'))('denies with the stage and cause when the mailbox cannot start', () => {
    const inputFile = path.join(BASE, 'input.json');
    fs.writeFileSync(
      inputFile,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command: 'echo hi' } }),
    );
    const proc = Bun.spawnSync(['bun', path.join(import.meta.dir, 'cli.ts'), 'PreToolUse'], {
      stdin: Bun.file(inputFile),
    });
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('at mailbox start (');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('retry the command once');
    expect(proc.stderr.toString()).toContain('runtime error in PreToolUse at mailbox start');
  });
});
