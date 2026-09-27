import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach } from 'vitest';

import { stripInheritedGitEnv } from './test-git-env.js';

stripInheritedGitEnv();

const createdRoots: string[] = [];

/**
 * A fixture root unique to this process and call: fixed roots let concurrent vitest runs in two worktrees share
 * fixture state. NOT created (suites asserting an absent root keep that behavior); removed after the test file.
 * On `globalThis`, not exported, because its callers are `vi.hoisted` factories, which cannot reference an import.
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
