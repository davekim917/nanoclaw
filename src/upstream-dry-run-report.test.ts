import { describe, expect, it } from 'vitest';

import { formatLocalTime } from './timezone.js';
import {
  buildReportMarkdown,
  classifyArea,
  detectMigrationCollisions,
  extractConflictPath,
  extractMigrationName,
  extractMigrationOrdinal,
  parseBreakingChangelogLines,
  parseMergeTreeConflicts,
  parseNewMigrationFiles,
  type NewMigration,
} from './upstream-dry-run-report.js';

// Captured verbatim from a real
// `git merge-tree --write-tree --name-only origin/main upstream/main`
// run against this fork on 2026-09-04, trimmed to a representative slice
// that exercises every CONFLICT phrasing git emits: content, modify/delete,
// add/add, rename-into-collision (which names two paths), and rename/delete
// (also two paths — reproduced against a throwaway repo to confirm git
// substitutes the actual ref names passed as arguments, not literal
// "ours"/"theirs").
const MERGE_TREE_FIXTURE = `202f8a8359ab19db7a8ed40a4c42f5313f09d033
.claude/skills/add-codex/SKILL.md
container/agent-runner/src/formatter.ts
setup/service.ts
docs/architecture.md
src/cli/resources/tasks.ts
src/modules/permissions/guard.ts
src/modules/scheduling/create.ts
src/modules/scheduling/runner.ts
src/router.ts
src/db/migrations/index.ts

Auto-merging .claude/skills/add-atomic-chat-tool/SKILL.md
CONFLICT (content): Merge conflict in .claude/skills/add-codex/SKILL.md
CONFLICT (content): Merge conflict in container/agent-runner/src/formatter.ts
CONFLICT (modify/delete): setup/service.ts deleted in upstream/main and modified in origin/main.  Version origin/main of setup/service.ts left in tree.
CONFLICT (content): Merge conflict in docs/architecture.md
CONFLICT (content): Merge conflict in src/cli/resources/tasks.ts
CONFLICT (content): Merge conflict in src/modules/permissions/guard.ts
CONFLICT (add/add): Merge conflict in src/db/migrations/index.ts
CONFLICT (content): Merge conflict in src/router.ts
CONFLICT (rename involved in collision): rename of src/modules/scheduling/db.test.ts -> src/mailbox/sqlite/tasks.test.ts has content conflicts AND collides with another path; this may result in nested conflict markers.
CONFLICT (rename involved in collision): rename of src/modules/scheduling/db.ts -> src/mailbox/sqlite/tasks.ts has content conflicts AND collides with another path; this may result in nested conflict markers.
CONFLICT (rename/delete): src/modules/scheduling/old-runner.ts renamed to src/modules/scheduling/runner.ts in origin/main, but deleted in upstream/main.
`;

const CLEAN_MERGE_TREE_FIXTURE = `9a1b2c3d
docs/architecture.md
`;

describe('classifyArea', () => {
  it('buckets agent-runner/src before the generic src/ rules', () => {
    expect(classifyArea('container/agent-runner/src/formatter.ts')).toBe('agent-runner/src');
  });

  it('buckets src/modules/<name> by module name', () => {
    expect(classifyArea('src/modules/permissions/guard.ts')).toBe('src/modules/permissions');
    expect(classifyArea('src/modules/scheduling/create.ts')).toBe('src/modules/scheduling');
  });

  it('buckets setup/ and setup.sh', () => {
    expect(classifyArea('setup/service.ts')).toBe('setup');
    expect(classifyArea('setup.sh')).toBe('setup');
  });

  it('buckets .claude/, docs/, src/cli/', () => {
    expect(classifyArea('.claude/skills/add-codex/SKILL.md')).toBe('.claude');
    expect(classifyArea('docs/architecture.md')).toBe('docs');
    expect(classifyArea('src/cli/resources/tasks.ts')).toBe('src/cli');
  });

  it('falls back to other', () => {
    expect(classifyArea('src/router.ts')).toBe('other');
    expect(classifyArea('src/db/migrations/index.ts')).toBe('other');
    expect(classifyArea('package.json')).toBe('other');
  });
});

describe('extractConflictPath', () => {
  it('returns null for a non-CONFLICT line', () => {
    expect(extractConflictPath('Auto-merging src/router.ts')).toBeNull();
  });

  it('parses a content conflict', () => {
    expect(extractConflictPath('CONFLICT (content): Merge conflict in src/router.ts')).toBe('src/router.ts');
  });

  it('parses an add/add conflict', () => {
    expect(extractConflictPath('CONFLICT (add/add): Merge conflict in src/db/migrations/index.ts')).toBe(
      'src/db/migrations/index.ts',
    );
  });

  it('parses a modify/delete conflict', () => {
    expect(
      extractConflictPath(
        'CONFLICT (modify/delete): setup/service.ts deleted in upstream/main and modified in origin/main.  Version origin/main of setup/service.ts left in tree.',
      ),
    ).toBe('setup/service.ts');
  });

  it('parses a rename-into-collision conflict as the destination path', () => {
    expect(
      extractConflictPath(
        'CONFLICT (rename involved in collision): rename of src/modules/scheduling/db.ts -> src/mailbox/sqlite/tasks.ts has content conflicts AND collides with another path; this may result in nested conflict markers.',
      ),
    ).toBe('src/mailbox/sqlite/tasks.ts');
  });

  it('parses a rename/delete conflict as the destination (renamed-to) path', () => {
    expect(
      extractConflictPath(
        'CONFLICT (rename/delete): src/modules/scheduling/old-runner.ts renamed to src/modules/scheduling/runner.ts in origin/main, but deleted in upstream/main.',
      ),
    ).toBe('src/modules/scheduling/runner.ts');
  });
});

describe('parseMergeTreeConflicts', () => {
  it('counts every CONFLICT line by area and matches grep -c total', () => {
    const result = parseMergeTreeConflicts(MERGE_TREE_FIXTURE);
    // 11 CONFLICT lines in the fixture above (including the two
    // rename-into-collision lines and the one rename/delete line, each
    // their own CONFLICT line).
    expect(result.total).toBe(11);
    expect(result.byArea.get('.claude')).toBe(1);
    expect(result.byArea.get('agent-runner/src')).toBe(1);
    expect(result.byArea.get('setup')).toBe(1);
    expect(result.byArea.get('docs')).toBe(1);
    expect(result.byArea.get('src/cli')).toBe(1);
    expect(result.byArea.get('src/modules/permissions')).toBe(1);
    // The rename/delete conflict lands on its destination path, correctly
    // triaged into the module it renames within rather than "other".
    expect(result.byArea.get('src/modules/scheduling')).toBe(1);
    // other: src/db/migrations/index.ts, src/router.ts, and both
    // rename-into-collision destination paths.
    expect(result.byArea.get('other')).toBe(4);
  });

  it('reports zero conflicts on a clean merge-tree run', () => {
    const result = parseMergeTreeConflicts(CLEAN_MERGE_TREE_FIXTURE);
    expect(result.total).toBe(0);
    expect(result.byArea.size).toBe(0);
  });
});

describe('extractMigrationOrdinal', () => {
  it('reads the leading digit run', () => {
    expect(extractMigrationOrdinal('src/db/migrations/070-foo.ts')).toBe(70);
    expect(extractMigrationOrdinal('021-bar.ts')).toBe(21);
  });

  it('returns null for a non-numbered file', () => {
    expect(extractMigrationOrdinal('src/db/migrations/index.ts')).toBeNull();
    expect(extractMigrationOrdinal('src/db/migrations/module-approvals.ts')).toBeNull();
  });
});

describe('extractMigrationName', () => {
  it('reads a single-quoted name field', () => {
    expect(
      extractMigrationName(
        `export const m: Migration = {\n  version: 7,\n  name: 'pending-approvals-title-options',\n`,
      ),
    ).toBe('pending-approvals-title-options');
  });

  it('reads a double-quoted name field', () => {
    expect(extractMigrationName(`name: "some-migration",`)).toBe('some-migration');
  });

  it('returns null when absent', () => {
    expect(extractMigrationName('export const x = 1;')).toBeNull();
  });
});

describe('parseNewMigrationFiles', () => {
  it('keeps only ordinal-numbered .ts migration files, dropping tests and index/module helpers', () => {
    const diffOutput = [
      'src/db/migrations/021-agent-defaults.ts',
      'src/db/migrations/021-agent-defaults.test.ts',
      'src/db/migrations/index.ts',
      'src/db/migrations/module-container-configs.ts',
      '',
    ].join('\n');
    expect(parseNewMigrationFiles(diffOutput)).toEqual(['src/db/migrations/021-agent-defaults.ts']);
  });

  it('returns empty for no new migrations', () => {
    expect(parseNewMigrationFiles('')).toEqual([]);
  });
});

describe('detectMigrationCollisions', () => {
  const forkExistingFiles = [
    'src/db/migrations/067-cli-request-executions.ts',
    'src/db/migrations/068-sessions-sweep-quiet-until.ts',
    'src/db/migrations/069-messaging-group-name-source.ts',
  ];

  it('flags an upstream ordinal that exactly matches an existing fork file', () => {
    const newMigrations: NewMigration[] = [
      { file: 'src/db/migrations/068-upstream-thing.ts', ordinal: 68, name: 'upstream-thing' },
    ];
    const collisions = detectMigrationCollisions(newMigrations, forkExistingFiles, 70);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      file: 'src/db/migrations/068-upstream-thing.ts',
      ordinal: 68,
      collidesWithForkFile: 'src/db/migrations/068-sessions-sweep-quiet-until.ts',
    });
  });

  it('does not flag an ordinal at or above the fork next-free number', () => {
    const newMigrations: NewMigration[] = [
      { file: 'src/db/migrations/070-upstream-thing.ts', ordinal: 70, name: 'upstream-thing' },
    ];
    expect(detectMigrationCollisions(newMigrations, forkExistingFiles, 70)).toEqual([]);
  });

  it('flags a below-next-free ordinal even with no exact fork file match', () => {
    const newMigrations: NewMigration[] = [{ file: 'src/db/migrations/050-gap.ts', ordinal: 50, name: 'gap' }];
    const collisions = detectMigrationCollisions(newMigrations, forkExistingFiles, 70);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].collidesWithForkFile).toBe('(none — below next-free ordinal)');
  });
});

describe('parseBreakingChangelogLines', () => {
  it('extracts only added [BREAKING] lines', () => {
    const diff = [
      '--- a/CHANGELOG.md',
      '+++ b/CHANGELOG.md',
      '@@ -1,3 +1,5 @@',
      ' ## 2.4.0',
      '+- [BREAKING] Slack Agents provisioning replaces suffix-token bots',
      '+- Minor fix, not breaking',
      '-- old removed line',
      '',
    ].join('\n');
    expect(parseBreakingChangelogLines(diff)).toEqual([
      '- [BREAKING] Slack Agents provisioning replaces suffix-token bots',
    ]);
  });

  it('ignores the +++ file header', () => {
    expect(parseBreakingChangelogLines('+++ b/CHANGELOG.md\n')).toEqual([]);
  });

  it('returns empty when nothing is breaking', () => {
    expect(parseBreakingChangelogLines('+- a regular changelog line\n')).toEqual([]);
  });
});

describe('buildReportMarkdown', () => {
  it('renders a full report with conflicts, migrations, and breaking lines', () => {
    const md = buildReportMarkdown({
      base: '641963c1e4b7ba4f000a18dfc5e2fea29069feec',
      commitsBehind: 490,
      commitsAhead: 3046,
      conflicts: parseMergeTreeConflicts(MERGE_TREE_FIXTURE),
      newMigrations: [{ file: 'src/db/migrations/068-upstream-thing.ts', ordinal: 68, name: 'upstream-thing' }],
      migrationCollisions: [
        {
          file: 'src/db/migrations/068-upstream-thing.ts',
          ordinal: 68,
          name: 'upstream-thing',
          collidesWithForkFile: 'src/db/migrations/068-sessions-sweep-quiet-until.ts',
        },
      ],
      forkNextFreeOrdinal: 70,
      breakingLines: ['- [BREAKING] Something changed'],
      ratchetSummary: null,
      generatedAt: '2026-09-08T09:00:00.000Z',
      timezone: 'America/New_York',
    });

    // Heading renders in the given install timezone, not the raw UTC ISO
    // stamp (Codex P1: agent/user-facing timestamps must be localized).
    expect(md).toContain(
      `## Upstream dry-run report — ${formatLocalTime('2026-09-08T09:00:00.000Z', 'America/New_York')}`,
    );
    expect(md).not.toContain('2026-09-08T09:00:00.000Z');
    expect(md).toContain('490 commits behind upstream/main, 3046 ahead');
    expect(md).toContain('Merge-tree conflicts (11 total)');
    expect(md).toContain('| agent-runner/src | 1 |');
    expect(md).toContain('New upstream migrations (1)');
    expect(md).toContain('**COLLISION** with src/db/migrations/068-sessions-sweep-quiet-until.ts');
    expect(md).toContain('Breaking changes (1)');
    expect(md).toContain('- [BREAKING] Something changed');
    expect(md).not.toContain('Ratchet report');
  });

  it('includes the ratchet section only when a summary is provided', () => {
    const md = buildReportMarkdown({
      base: 'abc123',
      commitsBehind: 0,
      commitsAhead: 0,
      conflicts: parseMergeTreeConflicts(CLEAN_MERGE_TREE_FIXTURE),
      newMigrations: [],
      migrationCollisions: [],
      forkNextFreeOrdinal: 70,
      breakingLines: [],
      ratchetSummary: 'ratchet: 3 offenders (down from 5)',
      generatedAt: '2026-09-08T09:00:00.000Z',
      timezone: 'UTC',
    });

    expect(md).toContain('### Ratchet report');
    expect(md).toContain('ratchet: 3 offenders (down from 5)');
    expect(md).toContain('Merge-tree conflicts (0 total)');
    expect(md).toContain('None.');
  });
});
