import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach } from 'vitest';

const createdRoots: string[] = [];

/**
 * A fixture root unique to this process and this call.
 *
 * Fixed roots (`/tmp/nanoclaw-<suite>`) made two vitest runs in two worktrees
 * share fixture state: whichever run lost the race failed as `disk I/O error`
 * or a missing directory somewhere unrelated to the change under test, never as
 * an assertion. `fileParallelism: false` only ever covered the single-process
 * case. See issue #274.
 *
 * The directory is NOT created — suites that assert on an absent root, or that
 * exercise code whose job is to create it, keep that behavior. Every root
 * handed out is removed after the test file finishes.
 *
 * This is installed on `globalThis` rather than exported because its main
 * callers are `vi.hoisted` factories, which vitest hoists above the file's
 * imports and which therefore cannot reference an imported binding. Setup files
 * run before the test module loads, so the global is already in place.
 */
function uniqueTmpRoot(name: string): string {
  const root = path.join(os.tmpdir(), `nanoclaw-${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
  createdRoots.push(root);
  return root;
}

declare global {
  // eslint-disable-next-line no-var
  var uniqueTmpRoot: (name: string) => string;
}

globalThis.uniqueTmpRoot = uniqueTmpRoot;

afterAll(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await import('./mailbox/compose.js');
});
