import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process AND fs before importing the module under test.
// fs must be mocked (not spyOn'd) — the ESM module namespace is non-
// configurable, so vi.spyOn(fs, 'readFileSync') throws "Cannot redefine
// property". vi.mock substitutes the entire module before bind.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = (await vi.importActual('fs')) as typeof import('fs');
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { spawn } from 'child_process';
import * as fs from 'fs';
import { ClassifierParseError } from '../classifier-client.js';
import { makeCodexBackend } from './codex.js';

const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockMkdtempSync = vi.mocked(fs.mkdtempSync);

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
});

const validOutput = {
  worth_storing: true,
  facts: [
    {
      content: 'User prefers dark mode',
      category: 'preference',
      importance: 3,
      entities: ['user'],
      source_role: 'user',
    },
  ],
};

interface ChildOpts {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  outputFileContent?: string;
  errorEvent?: Error;
}

function makeChildMock(opts: ChildOpts = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  if (opts.errorEvent) {
    setImmediate(() => child.emit('error', opts.errorEvent));
  } else {
    setImmediate(() => {
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      child.emit('close', opts.exitCode ?? 0, null);
    });
  }
  return child;
}

function stubOutputFile(content: string) {
  mockReadFileSync.mockImplementation(((p: unknown) => {
    if (typeof p === 'string' && p.includes('output.json')) return content;
    if (typeof p === 'string' && p.includes('schema.json')) return '{}';
    throw new Error(`unexpected readFileSync(${p})`);
  }) as unknown as typeof fs.readFileSync);
}

describe('codex backend', () => {
  it('test_codex_parses_valid_json_from_output_file', async () => {
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    const result = await backend('sys', 'user');

    expect(result.worth_storing).toBe(true);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('User prefers dark mode');
  });

  it('test_codex_passes_correct_args', async () => {
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await backend('sys prompt', 'user prompt');

    const call = mockSpawn.mock.calls[0];
    const args = call[1] as string[];
    expect(args).toContain('exec');
    expect(args).toContain('--yolo');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--output-schema');
    expect(args).toContain('--output-last-message');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('--config');
    expect(args).toContain('model_reasoning_effort=medium');
    // The combined prompt is the final arg.
    expect(args[args.length - 1]).toContain('sys prompt');
    expect(args[args.length - 1]).toContain('user prompt');
  });

  it('test_codex_default_effort_omits_reasoning_flag', async () => {
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'default' });
    await backend('sys', 'user');

    const args = mockSpawn.mock.calls[0][1] as string[];
    const reasoningArg = args.find((a) => a.startsWith('model_reasoning_effort='));
    expect(reasoningArg).toBeUndefined();
  });

  it('test_codex_high_effort_passes_high_flag', async () => {
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5-codex', effort: 'high' });
    await backend('sys', 'user');

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('test_codex_uses_stdio_ignore_for_stdin', async () => {
    // stdin must be ignored — codex hangs forever otherwise (per file header
    // comment). spawn() options should reflect that.
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await backend('sys', 'user');

    const spawnOpts = mockSpawn.mock.calls[0][2] as { stdio?: unknown };
    expect(spawnOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('test_codex_unique_tempdir_per_call', async () => {
    // Concurrent sweeps must not share tempdirs (would trample each other's
    // schema/output files). vi.mock at top wires mkdtempSync through to real
    // implementation; just observe the call args returned.
    const child1 = makeChildMock({ exitCode: 0 });
    const child2 = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValueOnce(child1 as unknown as ReturnType<typeof spawn>);
    mockSpawn.mockReturnValueOnce(child2 as unknown as ReturnType<typeof spawn>);
    stubOutputFile(JSON.stringify(validOutput));

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await Promise.all([backend('sys', 'user1'), backend('sys', 'user2')]);

    // mockMkdtempSync was pre-wired to call the real impl — each invocation
    // returned a distinct temp path. Verify by inspecting return values.
    expect(mockMkdtempSync).toHaveBeenCalledTimes(2);
    const dirs = mockMkdtempSync.mock.results.map((r) => r.value as string);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it('test_codex_exit_code_nonzero_throws_parse_error', async () => {
    // mockImplementation so each .rejects assertion (which invokes the backend
    // again) gets a fresh EventEmitter that fires 'close' once. mockReturnValue
    // would give the same child to both calls and the second hangs.
    mockSpawn.mockImplementation(
      () =>
        makeChildMock({ exitCode: 1, stderr: 'codex auth required' }) as unknown as ReturnType<typeof spawn>,
    );

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await expect(backend('sys', 'user')).rejects.toThrow(ClassifierParseError);
    await expect(backend('sys', 'user')).rejects.toThrow(/exited with code 1/);
  });

  it('test_codex_invalid_json_output_throws_parse_error', async () => {
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile('not valid json at all');

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await expect(backend('sys', 'user')).rejects.toThrow(ClassifierParseError);
  });

  it('test_codex_strips_markdown_fence_in_output', async () => {
    // Even with --output-schema, codex sometimes wraps output in a fence
    // because the underlying model template hasn't matured. Same fence-strip
    // path as Anthropic backend so behavior is consistent.
    const child = makeChildMock({ exitCode: 0 });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    stubOutputFile('```json\n' + JSON.stringify(validOutput) + '\n```');

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    const result = await backend('sys', 'user');
    expect(result.worth_storing).toBe(true);
  });

  it('test_codex_spawn_error_throws_parse_error', async () => {
    const child = makeChildMock({ errorEvent: new Error('ENOENT: codex not found') });
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const backend = makeCodexBackend({ model: 'gpt-5.5', effort: 'medium' });
    await expect(backend('sys', 'user')).rejects.toThrow(ClassifierParseError);
  });
});
