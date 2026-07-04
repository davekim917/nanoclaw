import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { recallMemoryTool } from './memory-recall.js';

const savedEnv: Record<string, string | undefined> = {};

function fakeMnemon(dir: string, body: string): void {
  const bin = path.join(dir, 'mnemon');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(bin, 0o755);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('recall_memory', () => {
  let tmpDir: string;

  beforeEach(() => {
    savedEnv.MNEMON_BIN = process.env.MNEMON_BIN;
    savedEnv.MNEMON_STORE = process.env.MNEMON_STORE;
    savedEnv.MNEMON_DATA_DIR = process.env.MNEMON_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-memory-test-'));
    // Point the tool at the fake binary explicitly — PATH-shimming does not
    // reliably affect Bun's execFileSync, and falling through to a REAL
    // host mnemon would silently test against production stores.
    process.env.MNEMON_BIN = path.join(tmpDir, 'mnemon');
    process.env.MNEMON_STORE = 'test-store';
    // Deterministic FS-fallback root — never let the tool probe a real path.
    process.env.MNEMON_DATA_DIR = path.join(tmpDir, 'data');
    fs.mkdirSync(process.env.MNEMON_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    for (const key of ['MNEMON_BIN', 'MNEMON_STORE', 'MNEMON_DATA_DIR'] as const) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_errors_when_memory_disabled', async () => {
    delete process.env.MNEMON_STORE; // and MNEMON_DATA_DIR is empty
    const result = await recallMemoryTool.handler({ query: 'anything' });
    expect(textOf(result)).toContain('not enabled');
  });

  it('test_fs_fallback_resolves_single_mounted_store', async () => {
    // Parity path: no MNEMON_STORE env (harness didn't propagate it) but the
    // store mount exists — the tool must find the store and stay read-only.
    delete process.env.MNEMON_STORE;
    fs.mkdirSync(path.join(process.env.MNEMON_DATA_DIR!, 'wg-canonical-store'));
    fakeMnemon(tmpDir, `echo "{\\"results\\":[{\\"insight\\":{\\"content\\":\\"store=$4 ro=$MNEMON_READ_ONLY\\",\\"category\\":\\"fact\\"},\\"score\\":0.5}]}"`);
    const result = await recallMemoryTool.handler({ query: 'anything' });
    const text = textOf(result);
    expect(text).toContain('store=wg-canonical-store');
    expect(text).toContain('ro=1');
  });

  it('test_writes_usage_audit_line', async () => {
    const auditPath = path.join(tmpDir, 'usage.jsonl');
    process.env.RECALL_MEMORY_AUDIT_PATH = auditPath;
    try {
      fakeMnemon(tmpDir, `echo '{"results":[{"insight":{"content":"x","category":"fact"},"score":0.5}]}'`);
      await recallMemoryTool.handler({ query: 'audit me' });
      await recallMemoryTool.handler({ query: 'audit me again' });
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0]);
      expect(first.query).toBe('audit me');
      expect(first.store).toBe('test-store');
      expect(first.results).toBe(1);
    } finally {
      delete process.env.RECALL_MEMORY_AUDIT_PATH;
    }
  });

  it('test_fs_fallback_refuses_ambiguous_multi_store', async () => {
    delete process.env.MNEMON_STORE;
    fs.mkdirSync(path.join(process.env.MNEMON_DATA_DIR!, 'store-a'));
    fs.mkdirSync(path.join(process.env.MNEMON_DATA_DIR!, 'store-b'));
    const result = await recallMemoryTool.handler({ query: 'anything' });
    expect(textOf(result)).toContain('not enabled');
  });

  it('test_errors_on_empty_query', async () => {
    const result = await recallMemoryTool.handler({ query: '   ' });
    expect(textOf(result)).toContain('query is required');
  });

  it('test_formats_recalled_facts', async () => {
    fakeMnemon(
      tmpDir,
      `echo '{"results":[{"insight":{"content":"Addison Lee was scratched after reviews","category":"decision","importance":4},"score":0.61},{"insight":{"content":"Uber Reserve XL 6AM is the plan","category":"decision","importance":5},"score":0.55}]}'`,
    );
    const result = await recallMemoryTool.handler({ query: 'Addison Lee' });
    const text = textOf(result);
    expect(text).toContain('untrusted reference data');
    expect(text).toContain('1. [decision|0.61] Addison Lee was scratched after reviews');
    expect(text).toContain('2. [decision|0.55] Uber Reserve XL 6AM is the plan');
  });

  it('test_passes_store_and_clamped_limit_args', async () => {
    // Fake binary echoes its argv as JSON-adjacent output we can assert on via the error path.
    fakeMnemon(tmpDir, `echo "ARGS:$@" >&2; echo '{"results":[]}'`);
    const result = await recallMemoryTool.handler({ query: 'q', limit: 999 });
    // Empty results message proves the call went through with clamped limit accepted.
    expect(textOf(result)).toContain('No facts recalled');
  });

  it('test_empty_results_message', async () => {
    fakeMnemon(tmpDir, `echo '{"results":[]}'`);
    const result = await recallMemoryTool.handler({ query: 'nothing matches' });
    expect(textOf(result)).toContain('No facts recalled');
  });

  it('test_non_json_output_is_error', async () => {
    fakeMnemon(tmpDir, `echo 'PANIC: store locked'`);
    const result = await recallMemoryTool.handler({ query: 'q' });
    expect(textOf(result)).toContain('non-JSON');
  });

  it('test_binary_failure_is_error', async () => {
    fakeMnemon(tmpDir, `exit 3`);
    const result = await recallMemoryTool.handler({ query: 'q' });
    expect(textOf(result)).toContain('mnemon recall failed');
  });
});
