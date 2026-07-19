import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readVerifiedSource, type DiscoveredSource } from '../graphify/discovery.js';
import type { ExtractionBundle, GraphEvidence } from '../graphify/types.js';
import { runManagedProcess, type ProcessRun } from './process.js';

const MAX_FILES = 4_000;
const MAX_BYTES = 64 * 1024 * 1024;

export interface CodeWorkerSource extends DiscoveredSource {
  /** Path relative to the one immutable root mounted at /source. */
  rootRelativePath: string;
}

export interface GraphifyCodeWorkerOptions {
  image: string;
  graphifyVersion: string;
  dockerBinary?: string;
  processRun?: ProcessRun;
  tempRoot?: string;
  installLabel?: string;
}

interface UpstreamNode {
  id: string;
  label?: string;
  name?: string;
  type?: string;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}
interface UpstreamLink {
  source: string;
  target: string;
  relation?: string;
  type?: string;
  source_file?: string;
  source_location?: string;
  [key: string]: unknown;
}

export interface PreprocessedSection {
  kind: string;
  locator: string;
  text: string;
  provenance: { page?: number; sheet?: string };
}
export interface BinaryPreprocessResult {
  status: 'ok' | 'empty' | 'failed';
  sections: PreprocessedSection[];
  truncated: boolean;
  error: string | null;
}

function sha256(...parts: Array<string | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function lineOf(location: unknown): number | undefined {
  const match = typeof location === 'string' ? /^L(\d+)/.exec(location) : undefined;
  return match ? Number(match[1]) : undefined;
}

function withoutGraphKeys(value: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...value };
  for (const key of ['id', 'label', 'name', 'type', 'source', 'target', 'relation', 'source_file', 'source_location'])
    delete copy[key];
  return copy;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function stageSource(
  sourceRoot: string,
  inputRoot: string,
  source: CodeWorkerSource,
  maximumBytes: number,
): Promise<Buffer> {
  const trustedRoot = await realpath(resolve(sourceRoot));
  const actual = await realpath(resolve(source.absolutePath));
  if (!isInside(trustedRoot, actual)) {
    throw new Error(`source escapes extraction root: ${source.relativePath}`);
  }
  if (
    !source.rootRelativePath ||
    isAbsolute(source.rootRelativePath) ||
    resolve(trustedRoot, source.rootRelativePath) !== actual ||
    relative(trustedRoot, actual).startsWith(`..${sep}`)
  ) {
    throw new Error(`source path does not match extraction root: ${source.relativePath}`);
  }
  const bytes = await readVerifiedSource(source, maximumBytes);
  const staged = resolve(inputRoot, source.rootRelativePath);
  if (staged === inputRoot || !isInside(inputRoot, staged)) {
    throw new Error(`invalid staged source path: ${source.relativePath}`);
  }
  await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
  await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
  return bytes;
}

export class GraphifyCodeWorker {
  private readonly run: ProcessRun;
  constructor(private readonly options: GraphifyCodeWorkerOptions) {
    if (!options.image.trim() || !options.graphifyVersion.trim())
      throw new Error('image and graphifyVersion are required');
    this.run = options.processRun ?? runManagedProcess;
  }

  async cleanupOrphans(): Promise<void> {
    const filters = ['--filter', 'label=nanoclaw.graphify-job=true'];
    if (this.options.installLabel) filters.push('--filter', `label=${this.options.installLabel}`);
    const listed = await this.run(this.options.dockerBinary ?? 'docker', ['ps', '-aq', ...filters], {
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (listed.exitCode !== 0)
      throw new Error(`failed to enumerate orphan Graphify jobs: ${listed.stderr.slice(-1000)}`);
    const ids = listed.stdout.split(/\s+/).filter(Boolean);
    if (ids.length)
      await this.run(this.options.dockerBinary ?? 'docker', ['rm', '-f', ...ids], {
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
  }

  async preprocess(
    sourceRoot: string,
    source: CodeWorkerSource,
    signal?: AbortSignal,
  ): Promise<BinaryPreprocessResult> {
    if (!isAbsolute(sourceRoot)) throw new Error('source root must be absolute');
    if (!/\.(?:pdf|docx|xlsx)$/i.test(source.rootRelativePath)) throw new Error('unsupported binary preprocess source');
    const tempRoot = this.options.tempRoot ?? tmpdir();
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const jobRoot = await mkdtemp(join(tempRoot, 'nanoclaw-graphify-preprocess-'));
    const inputRoot = join(jobRoot, 'input');
    const outputRoot = join(jobRoot, 'output');
    const descriptorPath = join(jobRoot, 'descriptor.json');
    await mkdir(inputRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    const jobName = `nanoclaw-graphify-pre-${sha256(source.id, source.sha256).slice(0, 16)}-${randomUUID().slice(0, 8)}`;
    const cleanup = async (): Promise<void> => {
      await this.run(this.options.dockerBinary ?? 'docker', ['rm', '-f', jobName], {
        timeoutMs: 15_000,
        maxOutputBytes: 256 * 1024,
      }).catch(() => undefined);
    };
    try {
      const raw = await stageSource(sourceRoot, inputRoot, source, 50 * 1024 * 1024);
      await writeFile(
        descriptorPath,
        JSON.stringify({
          operation: 'preprocess',
          source_root: '/source',
          output_root: '/output',
          source: {
            path: source.rootRelativePath,
            sha256: createHash('sha256').update(raw).digest('hex'),
            bytes: raw.byteLength,
          },
          graphify_version: this.options.graphifyVersion,
          limits: { address_space_bytes: 1024 ** 3, file_bytes: 64 * 1024 ** 2, process_count: 0 },
        }),
        { mode: 0o600 },
      );
      const args = [
        'run',
        '--rm',
        '--name',
        jobName,
        '--label',
        'nanoclaw.graphify-job=true',
        ...(this.options.installLabel ? ['--label', this.options.installLabel] : []),
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
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '-v',
        `${inputRoot}:/source:ro`,
        '-v',
        `${outputRoot}:/output:rw`,
        '-v',
        `${descriptorPath}:/job/descriptor.json:ro`,
        '--entrypoint',
        '/opt/graphify/bin/python',
        this.options.image,
        '/opt/graphify/graphify-worker.py',
        '/job/descriptor.json',
      ];
      await cleanup();
      const result = await this.run(this.options.dockerBinary ?? 'docker', args, {
        signal,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (result.terminationReason) throw new Error(`Graphify preprocess ${result.terminationReason}`);
      if (result.exitCode !== 0)
        throw new Error(`Graphify preprocess failed (${result.exitCode}): ${result.stderr.slice(-2000)}`);
      const artifact = JSON.parse(
        await readFile(join(outputRoot, 'preprocessed.json'), 'utf8'),
      ) as BinaryPreprocessResult;
      if (!['ok', 'empty', 'failed'].includes(artifact.status) || !Array.isArray(artifact.sections))
        throw new Error('invalid preprocess artifact');
      return artifact;
    } finally {
      await cleanup();
      await rm(jobRoot, { recursive: true, force: true });
    }
  }

  async extract(
    workgroupId: string,
    sourceRoot: string,
    provenancePrefix: string,
    sources: CodeWorkerSource[],
    signal?: AbortSignal,
  ): Promise<Map<string, ExtractionBundle>> {
    if (!isAbsolute(sourceRoot)) throw new Error('source root must be absolute');
    if (sources.length === 0) return new Map();
    if (sources.length > MAX_FILES) throw new Error(`Graphify code batch exceeds ${MAX_FILES} files`);
    const total = sources.reduce((sum, source) => sum + source.bytes, 0);
    if (total > MAX_BYTES) throw new Error(`Graphify code batch exceeds ${MAX_BYTES} bytes`);
    const tempRoot = this.options.tempRoot ?? tmpdir();
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const jobRoot = await mkdtemp(join(tempRoot, 'nanoclaw-graphify-code-'));
    const inputRoot = join(jobRoot, 'input');
    const outputRoot = join(jobRoot, 'output');
    const descriptorPath = join(jobRoot, 'descriptor.json');
    await mkdir(inputRoot, { mode: 0o700 });
    await mkdir(outputRoot, { mode: 0o700 });
    const jobName = `nanoclaw-graphify-${sha256(workgroupId, provenancePrefix, ...sources.map((source) => `${source.id}:${source.sha256}`)).slice(0, 16)}-${randomUUID().slice(0, 8)}`;
    const cleanup = async (): Promise<void> => {
      await this.run(this.options.dockerBinary ?? 'docker', ['rm', '-f', jobName], {
        timeoutMs: 15_000,
        maxOutputBytes: 256 * 1024,
      }).catch(() => undefined);
    };
    try {
      const files = [];
      for (const source of sources) {
        const raw = await stageSource(sourceRoot, inputRoot, source, 10 * 1024 * 1024);
        files.push({
          path: source.rootRelativePath,
          sha256: createHash('sha256').update(raw).digest('hex'),
          md5: createHash('md5').update(raw).digest('hex'),
          bytes: raw.byteLength,
          graphify_hash: createHash('sha256')
            .update(raw)
            .update('\0')
            .update(source.rootRelativePath.toLowerCase())
            .digest('hex'),
        });
      }
      await writeFile(
        descriptorPath,
        JSON.stringify({
          operation: 'extract',
          source_root: '/source',
          output_root: '/output',
          files,
          assets: [],
          graphify_version: this.options.graphifyVersion,
          limits: { address_space_bytes: 1024 ** 3, file_bytes: 64 * 1024 ** 2, process_count: 0 },
        }),
        { mode: 0o600 },
      );
      const args = [
        'run',
        '--rm',
        '--name',
        jobName,
        '--label',
        'nanoclaw.graphify-job=true',
        '--label',
        `nanoclaw.graphify-workgroup=${workgroupId}`,
        ...(this.options.installLabel ? ['--label', this.options.installLabel] : []),
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
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '-v',
        `${inputRoot}:/source:ro`,
        '-v',
        `${outputRoot}:/output:rw`,
        '-v',
        `${descriptorPath}:/job/descriptor.json:ro`,
        '--entrypoint',
        '/opt/graphify/bin/python',
        this.options.image,
        '/opt/graphify/graphify-worker.py',
        '/job/descriptor.json',
      ];
      // A prior daemon crash can leave a labeled unique job behind. Cleanup
      // before launch and again in finally so aborting the attached Docker CLI
      // cannot strand the extraction container.
      await cleanup();
      const result = await this.run(this.options.dockerBinary ?? 'docker', args, {
        signal,
        timeoutMs: 20 * 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      if (result.terminationReason === 'aborted') throw new Error('Graphify worker was preempted');
      if (result.terminationReason === 'timeout') throw new Error('Graphify worker timed out');
      if (result.terminationReason === 'output_limit') throw new Error('Graphify worker exceeded its output limit');
      if (result.exitCode !== 0)
        throw new Error(`Graphify worker failed (${result.exitCode}): ${result.stderr.slice(-2000)}`);
      const parsed = JSON.parse(await readFile(join(outputRoot, 'graph.json'), 'utf8')) as {
        nodes?: unknown;
        links?: unknown;
      };
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links))
        throw new Error('Graphify worker returned an invalid graph');
      return this.convert(
        workgroupId,
        provenancePrefix,
        sources,
        parsed.nodes as UpstreamNode[],
        parsed.links as UpstreamLink[],
      );
    } finally {
      await cleanup();
      await rm(jobRoot, { recursive: true, force: true });
    }
  }

  private convert(
    workgroupId: string,
    prefix: string,
    sources: CodeWorkerSource[],
    nodes: UpstreamNode[],
    links: UpstreamLink[],
  ): Map<string, ExtractionBundle> {
    const byPath = new Map(sources.map((source) => [source.rootRelativePath, source]));
    const bundles = new Map<string, ExtractionBundle>();
    for (const source of sources) bundles.set(source.id, { nodes: [], edges: [], hyperedges: [] });
    const upstreamById = new Map(nodes.map((node) => [node.id, node]));
    const namespaced = new Map(nodes.map((node) => [node.id, `graphify_${sha256(workgroupId, prefix, node.id)}`]));
    const graphNode = (node: UpstreamNode, owner: CodeWorkerSource, supporting: boolean) => {
      const actual = node.source_file ? byPath.get(node.source_file) : undefined;
      const evidence: GraphEvidence[] | undefined =
        actual?.id === owner.id
          ? [
              {
                sourceId: owner.id,
                relativePath: owner.relativePath,
                ...(lineOf(node.source_location) ? { line: lineOf(node.source_location) } : {}),
              },
            ]
          : undefined;
      return {
        id: namespaced.get(node.id)!,
        name: String(node.label ?? node.name ?? node.id),
        type: String(node.type ?? 'code_symbol'),
        properties: {
          ...withoutGraphKeys(node),
          sourcePath: actual?.relativePath ?? node.source_file,
          ...(supporting ? { supportingEndpoint: true } : {}),
        },
        ...(evidence ? { evidence } : {}),
      };
    };
    for (const node of nodes) {
      const source = node.source_file ? byPath.get(node.source_file) : undefined;
      if (!source || !namespaced.get(node.id)) continue;
      bundles.get(source.id)!.nodes.push(graphNode(node, source, false));
    }
    for (const [index, link] of links.entries()) {
      const owner = link.source_file ? byPath.get(link.source_file) : undefined;
      const from = upstreamById.get(link.source);
      const to = upstreamById.get(link.target);
      if (!owner || !from || !to || !namespaced.has(link.source) || !namespaced.has(link.target)) {
        throw new Error('Graphify link has unknown provenance or endpoint');
      }
      const bundle = bundles.get(owner.id)!;
      for (const endpoint of [from, to]) {
        const id = namespaced.get(endpoint.id)!;
        if (!bundle.nodes.some((node) => node.id === id)) bundle.nodes.push(graphNode(endpoint, owner, true));
      }
      const line = lineOf(link.source_location);
      bundle.edges.push({
        id: `graphify_edge_${sha256(workgroupId, prefix, String(index), link.source, link.target, String(link.relation ?? link.type ?? 'related'))}`,
        from: namespaced.get(link.source)!,
        to: namespaced.get(link.target)!,
        type: String(link.relation ?? link.type ?? 'related'),
        structural: true,
        properties: { ...withoutGraphKeys(link), sourcePath: owner.relativePath },
        evidence: [{ sourceId: owner.id, relativePath: owner.relativePath, ...(line ? { line } : {}) }],
      });
    }
    return bundles;
  }
}
