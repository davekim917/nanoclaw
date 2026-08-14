#!/usr/bin/env tsx
/** Build a hash-bound reviewed decision selecting one surviving per-worktree Git admin. */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  createReviewedExactGitAdminRecoveryProposal,
  type LegacyCheckoutCandidate,
} from '../src/repository-migration.js';

interface Args {
  checkout?: string;
  gitDir?: string;
  output?: string;
  workgroupId?: string;
  repo?: string;
  action?: 'restore-visible-state' | 'archive-visible-state';
}

function parseArgs(argv: string[]): Required<Args> {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--checkout') args.checkout = argv[++index];
    else if (value === '--git-dir') args.gitDir = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--workgroup') args.workgroupId = argv[++index];
    else if (value === '--repo') args.repo = argv[++index];
    else if (value === '--action') {
      const action = argv[++index];
      if (action !== 'restore-visible-state' && action !== 'archive-visible-state') {
        throw new Error('--action must be restore-visible-state or archive-visible-state');
      }
      args.action = action;
    } else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.checkout || !args.gitDir || !args.output || !args.workgroupId || !args.repo || !args.action) {
    throw new Error('--checkout, --git-dir, --output, --workgroup, --repo, and --action are required');
  }
  return args as Required<Args>;
}

function atomicJson(file: string, value: unknown): void {
  const resolved = path.resolve(file);
  const temporaryRoot = `${path.resolve('/tmp')}${path.sep}`;
  if (!resolved.startsWith(temporaryRoot)) throw new Error('--output must be below /tmp');
  if (fs.existsSync(resolved)) throw new Error(`output already exists: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temp = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const fd = fs.openSync(temp, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, resolved);
  fs.chmodSync(resolved, 0o600);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const checkoutPath = fs.realpathSync(args.checkout);
  const gitDir = fs.realpathSync(args.gitDir);
  const commonGitDir = fs.realpathSync(
    path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()),
  );
  const identity = createHash('sha256').update(`${args.workgroupId}\0${checkoutPath}`).digest('hex');
  const candidate: LegacyCheckoutCandidate = {
    workgroupId: args.workgroupId,
    repo: args.repo,
    checkoutPath,
    workUnit: {
      workgroupId: args.workgroupId,
      kind: 'session',
      key: `session:legacy:${identity.slice(0, 24)}`,
      id: identity.slice(0, 32),
    },
    candidateCommonGitDirs: [commonGitDir],
  };
  const proposal = createReviewedExactGitAdminRecoveryProposal({
    candidate,
    selectedGitDir: gitDir,
    action: args.action,
  });
  const output = path.resolve(args.output);
  atomicJson(output, { version: 2, checkouts: [proposal], origins: [] });
  console.log(`Reviewed exact-admin decision: ${output}`);
  console.log(`Checkout state sha256: ${proposal.visibleStateSha256}`);
  console.log(`Raw index sha256: ${proposal.selectedIndexSha256 ?? '(absent)'}`);
}

main();
