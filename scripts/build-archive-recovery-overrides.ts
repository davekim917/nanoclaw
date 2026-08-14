#!/usr/bin/env tsx
/** Convert reviewed checkout evidence into explicit archive-only checkout decisions. */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadReviewedRecoveryDecisions } from '../src/repository-migration-recovery.js';

interface Args {
  input?: string;
  output?: string;
  checkouts: string[];
}

function parseArgs(argv: string[]): Required<Args> {
  const args: Args = { checkouts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') args.input = argv[++index];
    else if (value === '--output') args.output = argv[++index];
    else if (value === '--checkout') args.checkouts.push(path.resolve(argv[++index]));
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.input || !args.output || args.checkouts.length === 0) {
    throw new Error('--input, --output, and at least one --checkout are required');
  }
  if (new Set(args.checkouts).size !== args.checkouts.length) throw new Error('duplicate --checkout');
  return args as Required<Args>;
}

function atomicJson(file: string, value: unknown): void {
  const resolved = path.resolve(file);
  const temporaryRoot = `${path.resolve('/tmp')}${path.sep}`;
  if (!resolved.startsWith(temporaryRoot)) throw new Error('--output must be below /tmp');
  if (fs.existsSync(resolved)) throw new Error(`output already exists: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temporary, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Atomically published or never created.
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadReviewedRecoveryDecisions(args.input);
  if (!loaded) throw new Error('reviewed recovery input was not loaded');
  const byPath = new Map(loaded.checkouts.map((decision) => [path.resolve(decision.checkoutPath), decision]));
  const checkouts = args.checkouts.map((checkoutPath) => {
    const decision = byPath.get(checkoutPath);
    if (!decision) throw new Error(`input has no reviewed checkout decision for ${checkoutPath}`);
    return { ...decision, action: 'archive-visible-state' as const };
  });
  atomicJson(args.output, { version: 2, checkouts, origins: [] });
  try {
    loadReviewedRecoveryDecisions(args.output);
  } catch (error) {
    fs.rmSync(args.output, { force: true });
    throw error;
  }
  console.log(`Archive recovery overrides: ${path.resolve(args.output)}`);
  console.log(`Checkouts: ${checkouts.length}`);
}

main();
