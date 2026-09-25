import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vendoredEngineFiles } from '../../src/design-artifact-loop-vendor.js';
import { scanComments } from './comments.js';

export interface Finding {
  check: 'knip' | 'jscpd' | 'comments';
  kind: string;
  location: string;
  message: string;
}

interface JscpdPolicy {
  mirrors?: { files: string[]; reason: string }[];
  [option: string]: unknown;
}

/** A knip JSON-reporter entry; a duplicate export arrives as the list of its names. */
type KnipItem = KnipSymbol | KnipSymbol[];

interface KnipSymbol {
  name: string;
  line?: number;
}

interface JscpdFragment {
  name: string;
  start: number;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TOOL_PATH = [path.join(REPO_ROOT, 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter);

/** Each directory is analysed with the `knip.json` it holds. */
const KNIP_WORKSPACES = ['.', 'container/agent-runner'];
const SOURCE_ROOTS = ['src', 'setup', 'scripts', 'container/agent-runner/src', 'container/agent-runner/scripts'];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const NOT_SOURCE =
  /(?:^|\/)(?:node_modules|__fixtures__|__test-fixtures__|test-fixtures|transaction-fixtures)\/|\.test\.[cm]?[jt]s$/;

/**
 * Files whose findings are fixed somewhere other than this tree, so no check reports them.
 * `upstream`: upstream-owned files still byte-identical to the pinned upstream commit, per
 * src/upstream-ratchet.json and the bytes on disk now; editing one would grow the divergence
 * the ratchet tracks. `vendored`: the design-review engine, fixed in the plugin repo and
 * re-vendored.
 */
export interface Exempt {
  upstream: Set<string>;
  vendored: Set<string>;
}

/** Read and hashed here rather than through src/upstream-ratchet.ts, so what this exempts is decided in reviewed code. */
function regularFileSha256(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

export function exemptFiles(root: string): Exempt {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'upstream-ratchet.json'), 'utf8')) as {
    files: Record<string, { diff: number; sha256: string | null }>;
  };
  const upstream = new Set<string>();
  for (const [file, entry] of Object.entries(manifest.files)) {
    if (entry.diff === 0 && entry.sha256 !== null && regularFileSha256(path.join(root, file)) === entry.sha256) {
      upstream.add(file);
    }
  }
  return { upstream, vendored: new Set(vendoredEngineFiles(root)) };
}

const isExempt = (exempt: Exempt, file: string) => exempt.upstream.has(file) || exempt.vendored.has(file);

function toolOptions(cwd: string) {
  return { cwd, encoding: 'utf8' as const, env: { ...process.env, PATH: TOOL_PATH }, maxBuffer: 256 * 1024 * 1024 };
}

function stdoutOf(tool: string, result: SpawnSyncReturns<string>): string {
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
    throw new Error(`${tool} failed (${reason}): ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

/** Non-test source under the scanned roots, as sorted root-relative POSIX paths. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of SOURCE_ROOTS) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })) {
      const file = path.posix.join(dir, entry.split(path.sep).join('/'));
      if (SOURCE_FILE.test(file) && !NOT_SOURCE.test(file)) files.push(file);
    }
  }
  return files.sort();
}

export function knipFindings(root: string, workspace: string): Finding[] {
  const output = stdoutOf(
    'knip',
    spawnSync(
      'knip',
      ['--config', 'knip.json', '--reporter', 'json', '--no-exit-code', '--no-progress'],
      toolOptions(path.join(root, workspace)),
    ),
  );
  const report = JSON.parse(output) as { issues: Record<string, unknown>[] };
  const findings: Finding[] = [];
  for (const row of report.issues) {
    const file = path.posix.join(workspace, String(row.file));
    for (const [kind, items] of Object.entries(row)) {
      if (kind === 'owners' || !Array.isArray(items)) continue;
      for (const item of items as KnipItem[]) {
        const symbols = [item].flat();
        const line = symbols[0]?.line;
        findings.push({
          check: 'knip',
          kind,
          location: line === undefined ? file : `${file}:${line}`,
          message: kind === 'files' ? 'unused file' : symbols.map((symbol) => symbol.name).join(' = '),
        });
      }
    }
  }
  return findings;
}

/**
 * Clones among `files`, except those between two files that `.jscpd.json` lists as one mirror
 * and those between two exempt files. A clone with one exempt side is reported at the other.
 */
export function jscpdFindings(
  root: string,
  files: string[],
  exempt: Exempt = { upstream: new Set(), vendored: new Set() },
): Finding[] {
  const { mirrors = [], ...options } = JSON.parse(
    fs.readFileSync(path.join(root, '.jscpd.json'), 'utf8'),
  ) as JscpdPolicy;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-jscpd-'));
  try {
    const config = path.join(out, 'config.json');
    fs.writeFileSync(config, JSON.stringify(options));
    stdoutOf(
      'jscpd',
      spawnSync(
        'jscpd',
        ['--config', config, '--reporters', 'json', '--output', out, '--absolute', '--silent', ...files],
        toolOptions(root),
      ),
    );
    const report = JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8')) as {
      duplicates: { firstFile: JscpdFragment; secondFile: JscpdFragment; lines: number }[];
    };
    const realRoot = fs.realpathSync(root);
    const where = (fragment: JscpdFragment) => path.relative(realRoot, fragment.name).split(path.sep).join('/');
    const usedMirrors = new Set<number>();
    const findings: Finding[] = [];
    for (const clone of report.duplicates) {
      const [first, second] = [where(clone.firstFile), where(clone.secondFile)];
      const mirror =
        first === second ? -1 : mirrors.findIndex((m) => m.files.includes(first) && m.files.includes(second));
      if (mirror >= 0) {
        usedMirrors.add(mirror);
        continue;
      }
      if (isExempt(exempt, first) && isExempt(exempt, second)) continue;
      const [ours, theirs] = isExempt(exempt, first)
        ? [`${second}:${clone.secondFile.start}`, `${first}:${clone.firstFile.start}`]
        : [`${first}:${clone.firstFile.start}`, `${second}:${clone.secondFile.start}`];
      findings.push({
        check: 'jscpd',
        kind: 'clone',
        location: ours,
        message: `${clone.lines} lines also at ${theirs}`,
      });
    }
    mirrors.forEach((mirror, index) => {
      if (usedMirrors.has(index)) return;
      findings.push({
        check: 'jscpd',
        kind: 'stale-mirror',
        location: '.jscpd.json',
        message: `no clone left between ${mirror.files.join(' and ')}; remove the entry`,
      });
    });
    return findings;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

export function commentFindings(root: string, files: string[]): Finding[] {
  return files.flatMap((file) =>
    scanComments(file, fs.readFileSync(path.join(root, file), 'utf8')).map((finding) => ({
      check: 'comments' as const,
      kind: finding.rule,
      location: `${file}:${finding.line}`,
      message: finding.excerpt,
    })),
  );
}

/** Every finding the tree owns: exempt files are still analysed, so knip and jscpd see their references. */
export function hygieneFindings(root: string, exempt: Exempt): Finding[] {
  const files = sourceFiles(root);
  const knip = KNIP_WORKSPACES.flatMap((workspace) => knipFindings(root, workspace)).filter(
    (finding) => !isExempt(exempt, finding.location.replace(/:\d+$/, '')),
  );
  return [
    ...knip,
    ...jscpdFindings(root, files, exempt),
    ...commentFindings(
      root,
      files.filter((file) => !isExempt(exempt, file)),
    ),
  ];
}

function print(findings: Finding[]): void {
  for (const check of ['knip', 'jscpd', 'comments'] as const) {
    const group = findings.filter((finding) => finding.check === check);
    const kinds = new Map<string, number>();
    for (const finding of group) kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);
    const breakdown = [...kinds].map(([kind, count]) => `${kind} ${count}`).join(', ');
    console.log(`\n${check}: ${group.length} finding(s)${breakdown ? ` (${breakdown})` : ''}`);
    for (const finding of group) console.log(`  ${finding.kind}  ${finding.location}  ${finding.message}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--report')) {
    console.error('usage: pnpm exec tsx scripts/hygiene/run.ts [--report]');
    process.exit(2);
  }
  for (const workspace of KNIP_WORKSPACES) {
    if (fs.existsSync(path.join(REPO_ROOT, workspace, 'node_modules'))) continue;
    // Without installed packages knip cannot see peer dependencies and reports them as unused.
    console.error(`hygiene: install ${path.posix.join(workspace, 'node_modules')} first; knip's results depend on it`);
    process.exit(2);
  }
  const exempt = exemptFiles(REPO_ROOT);
  const findings = hygieneFindings(REPO_ROOT, exempt);
  print(findings);
  console.log(
    `\nexempt: ${exempt.upstream.size} file(s) byte-identical to upstream, ${exempt.vendored.size} vendored design-review file(s)`,
  );
  const report = args.includes('--report');
  console.log(`\nhygiene: ${findings.length} finding(s)${report ? ' (report mode, not failing)' : ''}`);
  process.exitCode = findings.length > 0 && !report ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
