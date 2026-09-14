#!/usr/bin/env node
/**
 * Local, task-scoped authorization for one direct update of a protected Git
 * ref. This is intentionally a local workflow guard, not a substitute for
 * server-side branch protection: anyone able to alter .git can already bypass
 * client hooks. It exists so an operator's normal approval of a reviewed task
 * can be bound to the exact before/after ref state without making them copy a
 * commit hash into chat.
 *
 * Receipts live under the common Git directory rather than the worktree so a
 * linked worktree cannot accidentally mint or consume an approval belonging to
 * a different repository. A receipt remains usable until expiry because a
 * pre-push hook runs before the remote accepts the update; exact old and new
 * SHAs make a successful push impossible to replay.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECEIPT_DIR = 'nanoclaw-task-approvals';
const RECEIPT_KEYS = [
  'version',
  'id',
  'task',
  'remoteName',
  'remoteRef',
  'expectedLocalSha',
  'expectedRemoteSha',
  'pushUrlHash',
  'approvedAt',
  'expiresAt',
];

function usage() {
  return `Usage:
  node scripts/local-git-task-approval.mjs grant --repo-root <path> --remote <name> --remote-ref <ref> --task <summary>
  node scripts/local-git-task-approval.mjs verify --git-common-dir <path> --remote-name <name> --refs-file <path>`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error(usage());
    values.set(key, value);
  }
  return { command, values };
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing ${key}\n${usage()}`);
  return value;
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function absoluteGitCommonDir(repoRoot) {
  return git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

function receiptDir(gitCommonDir) {
  return path.join(gitCommonDir, RECEIPT_DIR);
}

function mustBeSecureDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      throw new Error('Local task approval directory is not a private directory');
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function validTask(task) {
  // Intentionally reject every ASCII control, including those outside whitespace.
  // eslint-disable-next-line no-control-regex
  return typeof task === 'string' && task.length > 0 && task.length <= 500 && !/[\x00-\x1F\x7F]/.test(task);
}

function validPushUrl(value) {
  // Intentionally reject every ASCII control, including those outside whitespace.
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1F\x7F]/.test(value);
}

function pushUrlHash(pushUrl) {
  return createHash('sha256').update(pushUrl).digest('hex');
}

function parseRemoteSha(output, remoteRef) {
  const rows = output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  if (rows.length !== 1 || rows[0]?.[1] !== remoteRef || !SHA_RE.test(rows[0]?.[0] ?? '')) {
    throw new Error(`Could not resolve the current remote tip for ${remoteRef}`);
  }
  return rows[0][0];
}

function writeReceipt(directory, receipt) {
  const file = path.join(directory, `${receipt.id}.json`);
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function grant(values) {
  const repoRoot = path.resolve(required(values, '--repo-root'));
  const remoteName = required(values, '--remote');
  const remoteRef = required(values, '--remote-ref');
  const task = required(values, '--task');
  if (!REMOTE_RE.test(remoteName) || !REF_RE.test(remoteRef) || !validTask(task))
    throw new Error('Invalid task approval scope');

  const localSha = git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!SHA_RE.test(localSha)) throw new Error('HEAD is not a commit');
  const pushUrl = git(repoRoot, ['remote', 'get-url', '--push', remoteName]);
  if (!validPushUrl(pushUrl)) throw new Error(`Could not resolve the push destination for ${remoteName}`);
  const remoteSha = parseRemoteSha(git(repoRoot, ['ls-remote', '--refs', pushUrl, remoteRef]), remoteRef);
  if (localSha.length !== remoteSha.length) throw new Error('Local and remote object formats differ');

  const approvedAt = new Date();
  const receipt = {
    version: VERSION,
    id: randomUUID(),
    task,
    remoteName,
    remoteRef,
    expectedLocalSha: localSha,
    expectedRemoteSha: remoteSha,
    pushUrlHash: pushUrlHash(pushUrl),
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(approvedAt.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  const directory = receiptDir(absoluteGitCommonDir(repoRoot));
  mustBeSecureDirectory(directory);
  writeReceipt(directory, receipt);
}

function parseReceipt(file, now) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return undefined;
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    // A malformed/unreadable local receipt can never authorize a push.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return undefined;
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined;
  if (
    Object.keys(receipt).length !== RECEIPT_KEYS.length ||
    RECEIPT_KEYS.some((key) => !(key in receipt)) ||
    Object.keys(receipt).some((key) => !RECEIPT_KEYS.includes(key))
  ) {
    return undefined;
  }
  if (
    receipt.version !== VERSION ||
    typeof receipt.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(receipt.id) ||
    !validTask(receipt.task) ||
    typeof receipt.remoteName !== 'string' ||
    !REMOTE_RE.test(receipt.remoteName) ||
    typeof receipt.remoteRef !== 'string' ||
    !REF_RE.test(receipt.remoteRef) ||
    typeof receipt.expectedLocalSha !== 'string' ||
    !SHA_RE.test(receipt.expectedLocalSha) ||
    typeof receipt.expectedRemoteSha !== 'string' ||
    !SHA_RE.test(receipt.expectedRemoteSha) ||
    receipt.expectedLocalSha.length !== receipt.expectedRemoteSha.length ||
    typeof receipt.pushUrlHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(receipt.pushUrlHash) ||
    typeof receipt.approvedAt !== 'string' ||
    typeof receipt.expiresAt !== 'string'
  ) {
    return undefined;
  }
  const approvedAt = Date.parse(receipt.approvedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= approvedAt)
    return undefined;
  if (expiresAt - approvedAt > MAX_TTL_MS || approvedAt > now + 60_000) return undefined;
  return receipt;
}

function protectedMainUpdate(refsFile) {
  const lines = fs.readFileSync(refsFile, 'utf8').split('\n').filter(Boolean);
  const updates = lines
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4 && fields[2] === 'refs/heads/main');
  if (updates.length !== 1) return undefined;
  const [localRef, localSha, remoteRef, remoteSha] = updates[0];
  if (
    localRef === '(delete)' ||
    !SHA_RE.test(localSha) ||
    !SHA_RE.test(remoteSha) ||
    localSha.length !== remoteSha.length
  ) {
    return undefined;
  }
  return { localSha, remoteRef, remoteSha };
}

function verify(values) {
  const gitCommonDir = path.resolve(required(values, '--git-common-dir'));
  const remoteName = required(values, '--remote-name');
  const remoteUrl = required(values, '--remote-url');
  const refsFile = path.resolve(required(values, '--refs-file'));
  if (!validPushUrl(remoteUrl)) return false;
  const update = protectedMainUpdate(refsFile);
  if (!update) return false;

  const directory = receiptDir(gitCommonDir);
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o022) !== 0)
      return false;
    // No receipt directory means no task approval.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }

  const now = Date.now();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const receipt = parseReceipt(path.join(directory, entry.name), now);
    if (
      receipt &&
      receipt.remoteName === remoteName &&
      receipt.remoteRef === update.remoteRef &&
      receipt.expectedLocalSha === update.localSha &&
      receipt.expectedRemoteSha === update.remoteSha &&
      receipt.pushUrlHash === pushUrlHash(remoteUrl)
    ) {
      return true;
    }
  }
  return false;
}

function main() {
  try {
    const { command, values } = parseArgs(process.argv.slice(2));
    if (command === 'grant') {
      grant(values);
      return;
    }
    if (command === 'verify') {
      process.exitCode = verify(values) ? 0 : 1;
      return;
    }
    throw new Error(usage());
    // CLI errors are intentionally rendered for the local operator rather than rethrown.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

main();
