import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundGraphRunner, InteractivePressureScanner, scanInteractivePressure } from './background-runner.js';
import { CodexSemanticBackend } from './codex-backend.js';
import { GraphifyCodeWorker } from './code-worker.js';

const roots: string[] = [];
function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GraphifyCodeWorker', () => {
  it('test_graphify_code_worker_isolated_and_bounded', async () => {
    const root = temp('graphify-code');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
    writeFileSync(join(root, '.env'), 'SECRET=must-not-be-mounted');
    let descriptor: Record<string, unknown> | undefined;
    let stagedInput = '';
    let stagedMode = 0;
    let secretWasVisible = true;
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      const sourceMount = args.find((value) => value.includes(':/source:ro'))!;
      stagedInput = sourceMount.slice(0, -':/source:ro'.length);
      stagedMode = statSync(join(stagedInput, 'a.ts')).mode & 0o777;
      secretWasVisible = existsSync(join(stagedInput, '.env'));
      const descriptorMount = args.find((value) => value.includes(':/job/descriptor.json:ro'))!;
      descriptor = JSON.parse(readFileSync(descriptorMount.slice(0, -':/job/descriptor.json:ro'.length), 'utf8'));
      const outputMount = args.find((value) => value.includes(':/output:rw'))!;
      const output = outputMount.slice(0, -':/output:rw'.length);
      mkdirSync(output, { recursive: true });
      writeFileSync(
        join(output, 'graph.json'),
        JSON.stringify({
          nodes: [{ id: 'a', label: 'a', source_file: 'a.ts' }],
          links: [],
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const worker = new GraphifyCodeWorker({ image: 'nanoclaw:test', graphifyVersion: '0.9.20', processRun });
    await worker.extract('wg', root, 'agents/ag/repo', [
      {
        id: 'source-a',
        workgroupId: 'wg',
        relativePath: 'agents/ag/repo/a.ts',
        absolutePath: join(root, 'a.ts'),
        rootRelativePath: 'a.ts',
        kind: 'code',
        bytes: 19,
        mtimeMs: 1,
        sha256: sha('export const a = 1;'),
        state: 'pending',
      },
    ]);
    const args = processRun.mock.calls.find((call) => call[1][0] === 'run')![1];
    expect(args).toEqual(
      expect.arrayContaining([
        'run',
        '--rm',
        '--network',
        'none',
        '--memory',
        '3g',
        '--memory-reservation',
        '1536m',
        '--cpus',
        '1',
        '--pids-limit',
        '128',
        '--read-only',
        'nanoclaw:test',
        '--entrypoint',
        '/opt/graphify/bin/python',
        '/opt/graphify/graphify-worker.py',
        '/job/descriptor.json',
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--name',
        expect.stringMatching(/^nanoclaw-graphify-/),
        '--label',
        'nanoclaw.graphify-job=true',
      ]),
    );
    expect(descriptor?.files as unknown[]).toHaveLength(1);
    expect((descriptor?.files as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({ path: 'a.ts', bytes: 19 }),
    );
    expect(stagedInput).not.toBe(root);
    expect(stagedMode).toBe(0o600);
    expect(secretWasVisible).toBe(false);
    await expect(
      worker.extract(
        'wg',
        root,
        'x',
        Array.from({ length: 4001 }, (_, index) => ({
          id: `s${index}`,
          workgroupId: 'wg',
          relativePath: `x/${index}.ts`,
          absolutePath: join(root, 'a.ts'),
          rootRelativePath: `${index}.ts`,
          kind: 'code' as const,
          bytes: 1,
          mtimeMs: 1,
          sha256: 'x',
          state: 'pending' as const,
        })),
      ),
    ).rejects.toThrow(/4000/);
  });

  it('rejects a source outside its declared extraction root', async () => {
    const root = temp('graphify-root');
    const outside = temp('graphify-outside');
    writeFileSync(join(outside, 'a.ts'), 'a');
    const worker = new GraphifyCodeWorker({
      image: 'image',
      graphifyVersion: '0.9.20',
      processRun: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    await expect(
      worker.extract('wg', root, 'agents/a', [
        {
          id: 's',
          workgroupId: 'wg',
          relativePath: 'agents/a/a.ts',
          absolutePath: join(outside, 'a.ts'),
          rootRelativePath: 'a.ts',
          kind: 'code',
          bytes: 1,
          mtimeMs: 1,
          sha256: sha('a'),
          state: 'pending',
        },
      ]),
    ).rejects.toThrow(/escapes extraction root/);
  });

  it('test_graphify_code_worker_converts_upstream_graph_with_provenance', async () => {
    const root = temp('graphify-convert');
    writeFileSync(join(root, 'a.ts'), 'a');
    writeFileSync(join(root, 'b.ts'), 'b');
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      const output = args.find((value) => value.includes(':/output:rw'))!.slice(0, -':/output:rw'.length);
      writeFileSync(
        join(output, 'graph.json'),
        JSON.stringify({
          nodes: [
            { id: 'raw-a', label: 'A', type: 'function', source_file: 'a.ts', source_location: 'L3' },
            { id: 'raw-b', label: 'B', type: 'function', source_file: 'b.ts', source_location: 'L8' },
          ],
          links: [{ source: 'raw-a', target: 'raw-b', relation: 'calls', source_file: 'a.ts', source_location: 'L4' }],
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const sources = ['a.ts', 'b.ts'].map((file) => ({
      id: `source-${file[0]}`,
      workgroupId: 'wg',
      relativePath: `agents/ag/repo/${file}`,
      absolutePath: join(root, file),
      rootRelativePath: file,
      kind: 'code' as const,
      bytes: 1,
      mtimeMs: 1,
      sha256: sha(file[0]),
      state: 'pending' as const,
    }));
    const bundles = await new GraphifyCodeWorker({ image: 'image', graphifyVersion: '0.9.20', processRun }).extract(
      'wg',
      root,
      'agents/ag/repo',
      sources,
    );
    const a = bundles.get('source-a')!;
    expect(a.nodes.some((node) => node.name === 'A')).toBe(true);
    expect(a.edges[0]).toEqual(expect.objectContaining({ type: 'calls', structural: true }));
    expect(a.edges[0].evidence).toEqual([
      expect.objectContaining({ sourceId: 'source-a', relativePath: 'agents/ag/repo/a.ts', line: 4 }),
    ]);
    expect(a.nodes.every((node) => node.id.startsWith('graphify_'))).toBe(true);
  });

  it('forces Docker cleanup when extraction is aborted', async () => {
    const root = temp('graphify-abort');
    writeFileSync(join(root, 'a.ts'), 'a');
    const processRun = vi.fn(async (_command: string, args: string[]) =>
      args[0] === 'run'
        ? { exitCode: 143, stdout: '', stderr: '', terminationReason: 'aborted' as const }
        : { exitCode: 0, stdout: '', stderr: '' },
    );
    const worker = new GraphifyCodeWorker({ image: 'image', graphifyVersion: '0.9.20', processRun });
    await expect(
      worker.extract('wg', root, 'agents/a', [
        {
          id: 's',
          workgroupId: 'wg',
          relativePath: 'agents/a/a.ts',
          absolutePath: join(root, 'a.ts'),
          rootRelativePath: 'a.ts',
          kind: 'code',
          bytes: 1,
          mtimeMs: 1,
          sha256: sha('a'),
          state: 'pending',
        },
      ]),
    ).rejects.toThrow(/preempted/);
    const cleanupCalls = processRun.mock.calls.filter((call) => call[1][0] === 'rm');
    expect(cleanupCalls).toHaveLength(2);
    expect(cleanupCalls[0][1].slice(0, 2)).toEqual(['rm', '-f']);
    expect(cleanupCalls[1][1][2]).toBe(cleanupCalls[0][1][2]);
  });

  it('uses a unique Docker name for identical invocations', async () => {
    const root = temp('graphify-unique');
    writeFileSync(join(root, 'a.ts'), 'a');
    const names: string[] = [];
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      names.push(args[args.indexOf('--name') + 1]);
      const output = args.find((value) => value.includes(':/output:rw'))!.slice(0, -':/output:rw'.length);
      writeFileSync(
        join(output, 'graph.json'),
        JSON.stringify({ nodes: [{ id: 'a', label: 'a', source_file: 'a.ts' }], links: [] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const worker = new GraphifyCodeWorker({ image: 'image', graphifyVersion: '0.9.20', processRun });
    const source = {
      id: 's',
      workgroupId: 'wg',
      relativePath: 'agents/a/a.ts',
      absolutePath: join(root, 'a.ts'),
      rootRelativePath: 'a.ts',
      kind: 'code' as const,
      bytes: 1,
      mtimeMs: 1,
      sha256: sha('a'),
      state: 'pending' as const,
    };
    await worker.extract('wg', root, 'agents/a', [source]);
    await worker.extract('wg', root, 'agents/a', [source]);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it('wires the strict one-file PDF office preprocess descriptor and provenance artifact', async () => {
    const root = temp('graphify-preprocess');
    writeFileSync(join(root, 'brief.pdf'), '%PDF fixture');
    let descriptor: Record<string, unknown> | undefined;
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '' };
      const mounted = args.find((value) => value.includes(':/job/descriptor.json:ro'))!;
      descriptor = JSON.parse(readFileSync(mounted.slice(0, -':/job/descriptor.json:ro'.length), 'utf8'));
      const output = args.find((value) => value.includes(':/output:rw'))!.slice(0, -':/output:rw'.length);
      writeFileSync(
        join(output, 'preprocessed.json'),
        JSON.stringify({
          status: 'ok',
          sections: [{ kind: 'document', locator: 'page:1', text: 'Executive summary', provenance: { page: 1 } }],
          truncated: false,
          error: null,
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const source = {
      id: 's',
      workgroupId: 'wg',
      relativePath: 'agents/a/brief.pdf',
      absolutePath: join(root, 'brief.pdf'),
      rootRelativePath: 'brief.pdf',
      kind: 'document' as const,
      bytes: 12,
      mtimeMs: 1,
      sha256: sha('%PDF fixture'),
      state: 'pending' as const,
    };
    const result = await new GraphifyCodeWorker({ image: 'image', graphifyVersion: '0.9.20', processRun }).preprocess(
      root,
      source,
    );
    expect(descriptor).toEqual(
      expect.objectContaining({
        operation: 'preprocess',
        source_root: '/source',
        output_root: '/output',
        source: expect.objectContaining({ path: 'brief.pdf', bytes: 12 }),
      }),
    );
    expect(result.sections[0]).toEqual(expect.objectContaining({ locator: 'page:1', provenance: { page: 1 } }));
  });
});

describe('CodexSemanticBackend', () => {
  it('test_codex_semantic_backend_uses_luna_medium_then_terra_high', async () => {
    const calls: string[][] = [];
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      const output = args[args.indexOf('--output-last-message') + 1];
      if (calls.length === 1) return { exitCode: 1, stdout: '', stderr: 'transient' };
      writeFileSync(output, JSON.stringify({ sources: [{ sourceId: 's', nodes: [], edges: [], hyperedges: [] }] }));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp('codex') });
    await backend.extract({ id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'doc.md', contentHash: 'h' }, [
      'safe text',
    ]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort="medium"']),
    );
    expect(calls[1]).toEqual(
      expect.arrayContaining(['--model', 'gpt-5.6-terra', '--config', 'model_reasoning_effort="high"']),
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '--ask-for-approval',
        'never',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--disable',
        'shell_tool',
        'apps',
        'plugins',
        '--sandbox',
        'read-only',
        '--output-schema',
        '--output-last-message',
      ]),
    );
    expect(calls[0]).not.toContain('--yolo');
    expect(calls[0]).not.toContain('--search');
    expect(calls[0].some((value) => value.includes('dangerously-bypass'))).toBe(false);
    const prompt = calls[0].at(-1)!;
    expect(prompt).toContain('[{"sourceId":"s"');
    expect(prompt).not.toContain('"[{\\"sourceId\\"');
    const disabled = [
      'unified_exec',
      'shell_tool',
      'apps',
      'plugins',
      'browser_use',
      'browser_use_external',
      'browser_use_full_cdp_access',
      'computer_use',
      'image_generation',
      'multi_agent',
      'multi_agent_v2',
      'goals',
      'code_mode_host',
      'tool_suggest',
      'remote_plugin',
      'skill_mcp_dependency_install',
      'auth_elicitation',
      'tool_call_mcp_elicitation',
      'hooks',
      'in_app_browser',
    ];
    expect(calls[0].filter((value) => value === '--disable')).toHaveLength(disabled.length);
    for (const feature of disabled)
      expect(calls[0].some((value, index) => value === '--disable' && calls[0][index + 1] === feature)).toBe(true);
  });

  it('test_codex_semantic_backend_rejects_structural_semantic_edges', async () => {
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1],
        JSON.stringify({
          sources: [
            {
              sourceId: 's',
              nodes: [
                { id: 'a', name: 'a', type: 'concept' },
                { id: 'b', name: 'b', type: 'concept' },
              ],
              edges: [{ id: 'e', from: 'a', to: 'b', type: 'related', structural: true }],
              hyperedges: [],
            },
          ],
        }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp('codex-invalid') });
    await expect(
      backend.extract({ id: 's', workgroupId: 'wg', kind: 'document', relativePath: 'doc.md', contentHash: 'h' }, [
        'safe',
      ]),
    ).rejects.toThrow(/structural/);
  });

  it('verifies local raster containment type size and hash immediately before Codex', async () => {
    const root = temp('codex-image');
    const image = join(root, 'plot.png');
    writeFileSync(image, 'png-bytes');
    const contentHash = createHash('sha256').update('png-bytes').digest('hex');
    let attachment = '';
    let attachmentBytes = '';
    let attachmentMode = 0;
    const processRun = vi.fn(async (_command: string, args: string[]) => {
      attachment = args[args.indexOf('--image') + 1];
      writeFileSync(image, 'swapped-after-verification');
      attachmentBytes = readFileSync(attachment, 'utf8');
      attachmentMode = statSync(attachment).mode & 0o777;
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1],
        JSON.stringify({ sources: [{ sourceId: 'img', nodes: [], edges: [], hyperedges: [] }] }),
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const backend = new CodexSemanticBackend({ processRun, tempRoot: temp('codex-image-jobs') });
    const source = { id: 'img', workgroupId: 'wg', kind: 'image' as const, relativePath: 'plot.png', contentHash };
    await backend.extractBatch([{ source, segments: ['chart'], imagePath: image, imageRoot: root }]);
    expect(attachment).not.toBe(image);
    expect(attachmentBytes).toBe('png-bytes');
    expect(attachmentMode).toBe(0o600);
    await expect(
      backend.extractBatch([{ source, segments: ['chart'], imagePath: image, imageRoot: root }]),
    ).rejects.toThrow(/changed/);
    const target = join(root, 'real.png');
    writeFileSync(target, 'png-bytes');
    const link = join(root, 'link.png');
    symlinkSync(target, link);
    await expect(
      backend.extractBatch([{ source, segments: ['chart'], imagePath: link, imageRoot: root }]),
    ).rejects.toThrow(/non-symlink/);
  });
});

function sessionPressureFixture(kind: string, ack?: string): string {
  const sessions = temp('sessions');
  const dir = join(sessions, 'ag', 'sess');
  mkdirSync(dir, { recursive: true });
  const inbound = new Database(join(dir, 'inbound.db'));
  inbound.exec('CREATE TABLE messages_in (id TEXT, kind TEXT, status TEXT, trigger INTEGER, process_after TEXT)');
  inbound.prepare("INSERT INTO messages_in VALUES ('m', ?, 'pending', 1, NULL)").run(kind);
  inbound.close();
  const outbound = new Database(join(dir, 'outbound.db'));
  outbound.exec('CREATE TABLE processing_ack (message_id TEXT, status TEXT, status_changed TEXT)');
  if (ack) outbound.prepare("INSERT INTO processing_ack VALUES ('m', ?, ?)").run(ack, new Date().toISOString());
  outbound.close();
  return sessions;
}

describe('BackgroundGraphRunner', () => {
  it('caches unchanged inactive session databases and rescans on inbound mutation', () => {
    const sessions = sessionPressureFixture('task');
    let inspections = 0;
    const scanner = new InteractivePressureScanner(sessions, () => {
      inspections += 1;
      return false;
    });
    expect(scanner.scan()).toBe(false);
    expect(inspections).toBe(1);
    expect(scanner.scan()).toBe(false);
    expect(inspections).toBe(1);

    const inboundPath = join(sessions, 'ag', 'sess', 'inbound.db');
    const changed = new Date(Date.now() + 5_000);
    utimesSync(inboundPath, changed, changed);
    expect(scanner.scan()).toBe(false);
    expect(inspections).toBe(2);
  });

  it('keeps active pressure cached until inbound or outbound state changes', () => {
    const sessions = sessionPressureFixture('chat', 'processing');
    let inspections = 0;
    const scanner = new InteractivePressureScanner(sessions, () => {
      inspections += 1;
      return true;
    });
    expect(scanner.scan()).toBe(true);
    expect(scanner.scan()).toBe(true);
    expect(inspections).toBe(1);

    const outboundPath = join(sessions, 'ag', 'sess', 'outbound.db');
    const changed = new Date(Date.now() + 5_000);
    utimesSync(outboundPath, changed, changed);
    expect(scanner.scan()).toBe(true);
    expect(inspections).toBe(2);
  });

  it('test_interactive_chat_preempts_background_graph_job', async () => {
    const sessions = sessionPressureFixture('chat', 'processing');
    expect(scanInteractivePressure(sessions)).toBe(true);
    const runner = new BackgroundGraphRunner({ sessionsRoot: sessions, freeMemory: () => 10_000_000_000, pollMs: 10 });
    const result = await runner.run(async () => 'never');
    expect(result.status).toBe('preempted');
  });

  it('test_scheduled_task_does_not_preempt_background_graph_job', async () => {
    const sessions = sessionPressureFixture('task');
    expect(scanInteractivePressure(sessions)).toBe(false);
    const runner = new BackgroundGraphRunner({ sessionsRoot: sessions, freeMemory: () => 10_000_000_000, pollMs: 10 });
    const result = await runner.run(async () => 'done');
    expect(result).toEqual({ status: 'completed', value: 'done' });
  });

  it('requires six GiB of free memory before a background worker starts', async () => {
    const below = new BackgroundGraphRunner({
      sessionsRoot: temp('empty-sessions'),
      freeMemory: () => 6 * 1024 ** 3 - 1,
    });
    expect(await below.run(async () => 'no')).toEqual({ status: 'deferred', reason: 'memory' });
    const boundary = new BackgroundGraphRunner({
      sessionsRoot: temp('empty-sessions'),
      freeMemory: () => 6 * 1024 ** 3,
    });
    expect(await boundary.run(async () => 'yes')).toEqual({ status: 'completed', value: 'yes' });
  });
});
