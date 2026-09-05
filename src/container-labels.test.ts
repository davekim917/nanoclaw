/**
 * Container scope labels and the pinned name prefix (restart-survival seam,
 * series C).
 *
 * Two things are pinned here.
 *
 * 1. The five `--label` pairs every spawn stamps. Nothing reads them yet; the
 *    boot-quiescence door added later in the seam computes its scoped stop set
 *    from the container runtime, because the in-process `activeContainers`
 *    registry is empty at startup and cannot see a survivor.
 * 2. `CONTAINER_NAME_PREFIX`, which is load-bearing in a way that is easy to
 *    miss. `pruneAgentRunnerSnapshots` selects live containers by name prefix
 *    (src/agent-runner-source.ts); a SUCCESSFUL `docker ps` that matches
 *    nothing returns an empty set, and only a docker FAILURE returns null. So
 *    adopting upstream's `ncl-…` grammar, or letting one of the two sites keep
 *    a literal while the other moves to the constant, makes the pruner delete
 *    every snapshot except the active one — including one a running container
 *    has bind-mounted, which empties its /app/src live.
 *
 * See docs/specs/upstream-restart-survival-seam/plan.md §3.5 divergence 1
 * and §7.C.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// The subject is a pure flag-list builder, but importing container-runner.ts
// pulls its module graph in. Stub the logger rather than letting a unit test
// reach the production log module (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_NAME_PREFIX,
  CONTAINER_ROLE_LABEL_KEY,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
} from './config.js';
import { containerLabelArgs } from './container-runner.js';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * The only two files that may name the prefix. Shrink-or-equal: a third
 * importer means a third place the grammar can drift, and this file is the
 * one place that says so.
 */
const PREFIX_IMPORTERS: readonly string[] = ['src/agent-runner-source.ts', 'src/container-runner.ts'];

/** Defines the constant, so it is not an importer. */
const PREFIX_DEFINER = 'src/config.ts';
const SELF = 'src/container-labels.test.ts';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function listTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  };
  for (const root of ['src', 'scripts', 'setup']) walk(path.join(REPO_ROOT, root));
  return out.sort();
}

function currentPrefixImporters(): string[] {
  return listTsFiles()
    .filter((rel) => rel !== PREFIX_DEFINER && rel !== SELF)
    .filter((rel) =>
      /\bCONTAINER_NAME_PREFIX\b/.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))),
    );
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('container scope labels', () => {
  it('spawn args carry install, group, session, workgroup and role labels', () => {
    expect(containerLabelArgs('ag-fixture', 'sess-fixture', 'wg-fixture')).toEqual([
      '--label',
      CONTAINER_INSTALL_LABEL,
      '--label',
      `${CONTAINER_GROUP_LABEL_KEY}=ag-fixture`,
      '--label',
      `${CONTAINER_SESSION_LABEL_KEY}=sess-fixture`,
      '--label',
      `${CONTAINER_WORKGROUP_LABEL_KEY}=wg-fixture`,
      '--label',
      `${CONTAINER_ROLE_LABEL_KEY}=agent`,
    ]);
  });

  it('the container name uses the pinned prefix', () => {
    // The value itself is the pin: every container already running on an
    // install carries it, and the pruner below selects by it.
    expect(CONTAINER_NAME_PREFIX).toBe('nanoclaw-v2-');

    // The spawn path builds its name from the constant, not from a literal
    // that happens to match it today.
    const runner = stripComments(read('src/container-runner.ts'));
    const nameLine = /const containerName = `([^`]*)`/.exec(runner);
    expect(nameLine, 'the spawn path no longer assigns containerName from a template literal').not.toBeNull();
    expect(nameLine?.[1]).toBe('${CONTAINER_NAME_PREFIX}${agentGroup.folder}-${Date.now()}');

    // …and what it builds does start with the prefix.
    const built = `${CONTAINER_NAME_PREFIX}some-group-${Date.now()}`;
    expect(built.startsWith(CONTAINER_NAME_PREFIX)).toBe(true);
  });

  it('the snapshot pruner and the spawn name share one prefix constant', () => {
    const files = listTsFiles();
    // Guards the scanner: a broken walk would report an empty set and pass
    // the assertions below while checking nothing.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(PREFIX_DEFINER);
    expect(files).toContain(SELF);

    const current = new Set(currentPrefixImporters());
    const pinned = new Set(PREFIX_IMPORTERS);

    const added = [...current].filter((f) => !pinned.has(f)).sort();
    expect(
      added,
      'a NEW file names CONTAINER_NAME_PREFIX. The set only shrinks: the prefix is how the ' +
        'snapshot pruner filters live containers, so every extra site is another place it can drift. ' +
        'See docs/specs/upstream-restart-survival-seam/plan.md §3.5 divergence 1.',
    ).toEqual([]);

    const removed = PREFIX_IMPORTERS.filter((f) => !current.has(f));
    expect(removed, 'these pinned files no longer name the constant — did one revert to a literal?').toEqual([]);

    // The literal must not reappear at either site: a file can import the
    // constant and still hard-code the old string somewhere else in it.
    for (const rel of PREFIX_IMPORTERS) {
      expect(
        stripComments(read(rel)),
        `${rel} re-introduces the literal container-name prefix — use CONTAINER_NAME_PREFIX`,
      ).not.toContain(CONTAINER_NAME_PREFIX);
    }
  });

  it('a workgroup-less session still emits the workgroup label with an empty value', () => {
    const args = containerLabelArgs('ag-fixture', 'sess-fixture', undefined);
    // Emitted, not dropped: "no workgroup" and "container predates the
    // labels" must stay distinguishable at the boot inventory.
    expect(args).toContain('--label');
    expect(args).toContain(`${CONTAINER_WORKGROUP_LABEL_KEY}=`);
    expect(args.filter((a) => a === '--label')).toHaveLength(5);
  });
});
