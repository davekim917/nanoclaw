#!/usr/bin/env tsx
/** Build a content-addressed Git seed for a checkout whose original admin directory is already gone. */
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  createReviewedExactGitAdminRecoveryProposal,
  createReviewedMissingAdminRecoveryProposal,
  type LegacyCheckoutCandidate,
} from '../src/repository-migration.js';
import { observedOriginsSha256, recoverySeedGitDirSha256 } from '../src/repository-migration-recovery.js';
import { safeGitArgs, safeGitEnv } from '../src/safe-git.js';

interface Args {
  target?: string;
  output?: string;
  workgroupId?: string;
  repo?: string;
  checkouts: string[];
  includeOriginDecision: boolean;
}

function parseArgs(argv: string[]): Required<Args> {
  const args: Args = { checkouts: [], includeOriginDecision: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--target') args.target = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--workgroup') args.workgroupId = argv[++index];
    else if (value === '--repo') args.repo = argv[++index];
    else if (value === '--checkout') args.checkouts.push(argv[++index]);
    else if (value === '--no-origin-decision') args.includeOriginDecision = false;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.target || !args.output || !args.workgroupId || !args.repo || args.checkouts.length === 0) {
    throw new Error('--target, --output, --workgroup, --repo, and at least one --checkout are required');
  }
  return args as Required<Args>;
}

function contained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function git(
  gitDir: string,
  args: string[],
  options: { input?: Buffer | string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync('git', safeGitArgs(['--git-dir', gitDir, ...args], path.join(gitDir, 'config')), {
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeGitEnv({ ...process.env, ...options.env }),
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function gitRaw(gitDir: string, args: string[]): Buffer {
  return execFileSync('git', safeGitArgs(['--git-dir', gitDir, ...args], path.join(gitDir, 'config')), {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeGitEnv(process.env),
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

// These are generated dependency/build-cache directories, not repository
// work. The original checkout remains byte-for-byte retained by the migration;
// excluding them here keeps the independent recovery seed bounded without
// dropping source-like dist/build trees that may be intentionally tracked.
const GENERATED_CACHE_DIRECTORIES = new Set([
  'node_modules',
  '.cache',
  '.pnpm-store',
  'coverage',
  'allure-results',
  '.next',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
]);

interface VisibleFile {
  path: string;
  absolutePath: string;
  mode: string;
  symlinkBytes?: Buffer;
}

function walkVisibleFiles(checkoutPath: string): VisibleFile[] {
  const result: VisibleFile[] = [];
  const walk = (directory: string, relativeRoot: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (relativeRoot === '' && name === '.git') continue;
      if (GENERATED_CACHE_DIRECTORIES.has(name)) continue;
      const absolute = path.join(directory, name);
      const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(absolute, relative);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        result.push({ path: relative, absolutePath: absolute, mode: stat.mode & 0o111 ? '100755' : '100644' });
      } else if (stat.isSymbolicLink()) {
        result.push({
          path: relative,
          absolutePath: absolute,
          mode: '120000',
          symlinkBytes: fs.readlinkSync(absolute, { encoding: 'buffer' }),
        });
      } else {
        throw new Error(`recovery seed refuses special filesystem entry: ${absolute}`);
      }
    }
  };
  walk(checkoutPath, '');
  return result;
}

function hashVisibleFiles(gitDir: string, visible: VisibleFile[]): Array<VisibleFile & { objectId: string }> {
  const objectIds = new Map<string, string>();
  const regular = visible.filter((entry) => entry.symlinkBytes === undefined);
  // Pass paths as argv entries so embedded whitespace/newlines remain exact.
  // Keep each batch far below ARG_MAX; this replaces one Git process per file
  // with one process per bounded batch.
  for (let offset = 0; offset < regular.length; offset += 256) {
    const batch = regular.slice(offset, offset + 256);
    const output = execFileSync(
      'git',
      safeGitArgs(
        ['--git-dir', gitDir, 'hash-object', '-w', '--no-filters', '--', ...batch.map((entry) => entry.absolutePath)],
        path.join(gitDir, 'config'),
      ),
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeGitEnv(process.env),
        timeout: 300_000,
        maxBuffer: 256 * 1024 * 1024,
      },
    )
      .trimEnd()
      .split('\n');
    if (output.length !== batch.length) throw new Error(`recovery seed hash-object count mismatch for ${gitDir}`);
    batch.forEach((entry, index) => objectIds.set(entry.path, output[index]));
  }
  for (const entry of visible) {
    if (entry.symlinkBytes === undefined) continue;
    objectIds.set(
      entry.path,
      git(gitDir, ['hash-object', '--no-filters', '-w', '--stdin'], { input: entry.symlinkBytes }),
    );
  }
  return visible.map((entry) => {
    const objectId = objectIds.get(entry.path);
    if (!objectId) throw new Error(`recovery seed did not hash ${entry.absolutePath}`);
    return { ...entry, objectId };
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function verifySnapshot(
  gitDir: string,
  snapshot: { checkoutPath: string; head: string; entries: Array<{ path: string; mode: string; objectId: string }> },
): void {
  const actual = gitRaw(gitDir, ['ls-tree', '-r', '-z', '--full-tree', snapshot.head]);
  const records = actual.subarray(
    0,
    actual.length > 0 && actual[actual.length - 1] === 0 ? actual.length - 1 : actual.length,
  );
  const parsed =
    records.length === 0
      ? []
      : records
          .toString('utf8')
          .split('\0')
          .map((record) => {
            const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
            if (!match)
              throw new Error(`recovery seed contains a non-blob or malformed tree entry for ${snapshot.checkoutPath}`);
            return { mode: match[1], objectId: match[2], path: match[3] };
          });
  const expected = snapshot.entries
    .map(({ path: entryPath, mode, objectId }) => [entryPath, mode, objectId] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  const normalizedActual = parsed
    .map(({ path: entryPath, mode, objectId }) => [entryPath, mode, objectId] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  if (JSON.stringify(normalizedActual) !== JSON.stringify(expected)) {
    throw new Error(`recovery seed tree path/mode/object inventory mismatch for ${snapshot.checkoutPath}`);
  }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const fd = fs.openSync(temp, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const seedRoot = path.resolve(
    process.env.NANOCLAW_REPOSITORY_RECOVERY_SEED_ROOT ??
      '/home/ubuntu/backups/nanoclaw-worktree-recovery/repository-seeds',
  );
  const target = path.resolve(args.target);
  if (!contained(target, seedRoot)) throw new Error(`recovery seed target escapes ${seedRoot}`);
  if (fs.existsSync(target)) throw new Error(`recovery seed target already exists: ${target}`);
  for (const checkout of args.checkouts) {
    const resolved = fs.realpathSync(checkout);
    const marker = fs.lstatSync(path.join(resolved, '.git'));
    if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) {
      throw new Error(`checkout lacks a safe Git marker: ${resolved}`);
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  execFileSync('git', safeGitArgs(['init', '--bare', '-q', target]), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeGitEnv(process.env),
  });
  fs.chmodSync(target, 0o700);
  git(target, ['config', 'core.hooksPath', '/dev/null']);
  git(target, ['config', 'core.fsmonitor', 'false']);
  git(target, ['config', 'gc.auto', '0']);

  const snapshots: Array<{
    checkoutPath: string;
    branch: string;
    head: string;
  }> = [];
  for (const checkout of args.checkouts.map((entry) => fs.realpathSync(entry))) {
    const tempIndex = path.join('/tmp', `nanoclaw-seed-${process.pid}-${randomBytes(8).toString('hex')}.index`);
    try {
      const env = { GIT_INDEX_FILE: tempIndex };
      git(target, ['read-tree', '--empty'], { env });
      const records: Buffer[] = [];
      const entries = hashVisibleFiles(target, walkVisibleFiles(checkout));
      for (const entry of entries) {
        records.push(Buffer.from(`${entry.mode} ${entry.objectId}\t${entry.path}\0`));
      }
      git(target, ['update-index', '-z', '--index-info'], { env, input: Buffer.concat(records) });
      const tree = git(target, ['write-tree'], { env });
      const branch = `recovery/${args.repo.replace(/[^A-Za-z0-9._-]+/g, '-')}-${sha256(checkout).slice(0, 16)}`;
      const date = new Date(fs.lstatSync(checkout).mtimeMs).toISOString();
      const head = git(target, ['commit-tree', tree], {
        input: `NanoClaw visible-state recovery seed\n\nSource: ${checkout}\n`,
        env: {
          GIT_AUTHOR_NAME: 'NanoClaw Repository Recovery',
          GIT_AUTHOR_EMAIL: 'repository-recovery@localhost',
          GIT_COMMITTER_NAME: 'NanoClaw Repository Recovery',
          GIT_COMMITTER_EMAIL: 'repository-recovery@localhost',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
      git(target, ['update-ref', `refs/heads/${branch}`, head]);
      // Verify while this checkout's source bytes are in scope, then release
      // them before walking the next checkout. Retaining all file buffers until
      // the end makes large monorepo recovery sets consume memory proportional
      // to checkout count even though Git already deduplicates their objects.
      verifySnapshot(target, { checkoutPath: checkout, head, entries });
      snapshots.push({ checkoutPath: checkout, branch, head });
    } finally {
      fs.rmSync(tempIndex, { force: true });
    }
  }
  git(target, ['symbolic-ref', 'HEAD', `refs/heads/${snapshots[0].branch}`]);
  git(target, ['fsck', '--full']);
  const seedSha256 = recoverySeedGitDirSha256(target);
  const hasExactStandaloneAdmin = snapshots.some((snapshot) =>
    fs.lstatSync(path.join(snapshot.checkoutPath, '.git')).isDirectory(),
  );
  const checkouts = snapshots.map((snapshot) => {
    const candidate: LegacyCheckoutCandidate = {
      workgroupId: args.workgroupId,
      repo: args.repo,
      checkoutPath: snapshot.checkoutPath,
      workUnit: {
        workgroupId: args.workgroupId,
        kind: 'session',
        key: `session:legacy:${sha256(snapshot.checkoutPath).slice(0, 24)}`,
        id: sha256(`${args.workgroupId}\0${snapshot.checkoutPath}`).slice(0, 32),
      },
      candidateCommonGitDirs: [],
    };
    const marker = fs.lstatSync(path.join(snapshot.checkoutPath, '.git'));
    if (marker.isDirectory()) {
      return {
        ...createReviewedExactGitAdminRecoveryProposal({
          candidate,
          selectedGitDir: path.join(snapshot.checkoutPath, '.git'),
          action: 'archive-visible-state',
        }),
        supplementalSeedGitDir: target,
        supplementalSeedGitDirSha256: seedSha256,
      };
    }
    return createReviewedMissingAdminRecoveryProposal({
      candidate,
      selectedCommonGitDir: target,
      selectedHead: snapshot.head,
      selectedBranch: snapshot.branch,
      action: 'archive-visible-state',
      externalSeedGitDirSha256: seedSha256,
    });
  });
  atomicJson(path.resolve(args.output), {
    version: 2,
    checkouts,
    origins: args.includeOriginDecision
      ? [
          {
            workgroupId: args.workgroupId,
            repo: args.repo,
            observedOriginsSha256: observedOriginsSha256(hasExactStandaloneAdmin ? [null] : []),
            selectedOrigin: null,
          },
        ]
      : [],
  });
  console.log(`Recovery seed: ${target}`);
  console.log(`Git directory sha256: ${seedSha256}`);
  console.log(`Snapshots: ${snapshots.length}`);
  console.log(`Reviewed decision file: ${path.resolve(args.output)}`);
}

main();
