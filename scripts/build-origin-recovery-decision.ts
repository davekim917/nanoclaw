#!/usr/bin/env tsx
/** Build one hash-bound, credential-free reviewed origin selection. */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadReviewedRecoveryDecisions } from '../src/repository-migration-recovery.js';

interface Args {
  output?: string;
  workgroupId?: string;
  repo?: string;
  observedOriginsSha256?: string;
  selectedOrigin?: string | null;
  selectedOriginSupplied: boolean;
  archiveOnly: boolean;
}

function parseArgs(argv: string[]): Required<Args> {
  const args: Args = { selectedOriginSupplied: false, archiveOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--output') args.output = argv[++index];
    else if (value === '--workgroup') args.workgroupId = argv[++index];
    else if (value === '--repo') args.repo = argv[++index];
    else if (value === '--observed-origins-sha256') args.observedOriginsSha256 = argv[++index];
    else if (value === '--selected-origin') {
      const selected = argv[++index];
      args.selectedOrigin = selected === 'none' ? null : selected;
      args.selectedOriginSupplied = true;
    } else if (value === '--archive-only') {
      args.archiveOnly = true;
    } else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.output || !args.workgroupId || !args.repo || !args.observedOriginsSha256 || !args.selectedOriginSupplied) {
    throw new Error('--output, --workgroup, --repo, --observed-origins-sha256, and --selected-origin are required');
  }
  if (!/^[a-f0-9]{64}$/.test(args.observedOriginsSha256)) {
    throw new Error('--observed-origins-sha256 must be a lowercase SHA-256 digest');
  }
  if (args.archiveOnly && args.selectedOrigin !== null) {
    throw new Error('--archive-only requires --selected-origin none');
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
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(args.output);
  atomicJson(output, {
    version: 2,
    checkouts: [],
    origins: [
      {
        workgroupId: args.workgroupId,
        repo: args.repo,
        observedOriginsSha256: args.observedOriginsSha256,
        selectedOrigin: args.selectedOrigin,
        ...(args.archiveOnly ? { archiveOnly: true } : {}),
      },
    ],
  });
  try {
    loadReviewedRecoveryDecisions(output);
  } catch (error) {
    fs.rmSync(output, { force: true });
    throw error;
  }
  console.log(`Reviewed origin decision: ${output}`);
  console.log(`Repository: ${args.workgroupId}/${args.repo}`);
}

main();
