#!/usr/bin/env tsx
/** Merge validated recovery decisions while requiring explicit conflict overrides. */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { loadReviewedRecoveryDecisions } from '../src/repository-migration-recovery.js';
import { mergeReviewedRecoveryDecisions } from '../src/repository-recovery-merge.js';

interface Args {
  bases: string[];
  overrides: string[];
  output?: string;
}

function parseArgs(argv: string[]): Required<Args> {
  const args: Args = { bases: [], overrides: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') args.bases.push(argv[++index]);
    else if (value === '--override') args.overrides.push(argv[++index]);
    else if (value === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (args.bases.length === 0) throw new Error('at least one --input is required');
  if (!args.output) throw new Error('--output is required');
  return args as Required<Args>;
}

function load(file: string) {
  const loaded = loadReviewedRecoveryDecisions(file);
  if (!loaded) throw new Error(`recovery decision file was not loaded: ${file}`);
  return loaded;
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
    const parent = fs.openSync(path.dirname(resolved), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
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
  const bases = args.bases.map(load);
  const overrides = args.overrides.map(load);
  const merged = mergeReviewedRecoveryDecisions({ bases, overrides });
  atomicJson(args.output, merged);
  console.log(`Merged recovery decisions: ${path.resolve(args.output)}`);
  console.log(`Checkouts: ${merged.checkouts.length}`);
  console.log(`Origins: ${merged.origins.length}`);
}

main();
