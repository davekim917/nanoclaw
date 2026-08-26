import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { TEST_ROOT, TEST_WORKGROUP, race } = vi.hoisted(() => ({
  TEST_ROOT: `${process.cwd()}/data`,
  TEST_WORKGROUP: `test-curator-cas-${process.pid}`,
  // One-shot hook fired from inside the merge, i.e. after the CAS base has
  // been read and before the write goes out. That is the only window in which
  // a concurrent writer produces a real conflict, and it is not reachable from
  // the filesystem — hence the module mock.
  race: { fn: null as null | (() => void) },
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

vi.mock('./memory-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memory-index.js')>();
  return {
    ...actual,
    renderFolderIndex: (...args: Parameters<typeof actual.renderFolderIndex>): string => {
      const fire = race.fn;
      race.fn = null;
      fire?.();
      return actual.renderFolderIndex(...args);
    },
  };
});

import { readMemoryTopicFile, syncMemoryIndexes } from './curator-write.js';

const memoryDir = (): string => path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP, 'memory');
const peopleDir = (): string => path.join(memoryDir(), 'people');

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP), { recursive: true, force: true });
  fs.mkdirSync(peopleDir(), { recursive: true });
  race.fn = null;
});

afterEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'workgroups', TEST_WORKGROUP), { recursive: true, force: true });
});

function topic(name: string, body: string): void {
  fs.writeFileSync(path.join(peopleDir(), name), `---\ntype: person\nconsolidated_facts: 1\n---\n\n${body}\n`);
}

// Codex 8. The directory snapshot was taken once, before the CAS loop, and
// reused across retries. Re-reading the FILE on a lost race is only half of
// it: the listing the merge is defined against is exactly as stale, so an
// agent that created `people/alice.md` and added its own bullet mid-retry had
// that bullet read as pointing at a file that does not exist — and dropped.
it('re-derives the directory listing when it loses a CAS race, instead of deleting the winner', async () => {
  topic('mira.md', 'Mira leads the release train.');
  await syncMemoryIndexes(TEST_WORKGROUP);
  const before = readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md');
  expect(before.content).toContain('- [Mira](mira.md)');

  // Make the pass want to write: Mira's hook changes.
  topic('mira.md', 'Mira leads the release train and owns the merge queue.');
  // …and an agent lands `alice.md` plus its own index bullet in the window
  // between our read and our write.
  race.fn = () => {
    topic('alice.md', 'Alice runs payroll integration.');
    fs.writeFileSync(
      path.join(peopleDir(), 'index.md'),
      `${readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md').content}- [Alice](alice.md) - Alice runs payroll integration.\n`,
    );
  };

  const result = await syncMemoryIndexes(TEST_WORKGROUP);
  expect(result.updated).toContain('people/index.md');
  const after = readMemoryTopicFile(TEST_WORKGROUP, 'people/index.md').content;
  expect(after).toContain('(alice.md)');
  expect(after).toContain('Mira leads the release train and owns the merge queue.');
  expect(fs.existsSync(path.join(peopleDir(), 'alice.md'))).toBe(true);
  // Idempotent afterwards: the winner is now part of the derived state.
  expect(await syncMemoryIndexes(TEST_WORKGROUP)).toEqual({ updated: [] });
});
