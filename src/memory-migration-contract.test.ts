import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve('.');
const claudeSkills = path.join(root, '.claude', 'skills');
const agentsSkills = path.join(root, '.agents', 'skills');
const migrateSkillPath = path.join(claudeSkills, 'migrate-memory', 'SKILL.md');
const updateSkillPath = path.join(claudeSkills, 'update-nanoclaw', 'SKILL.md');
const obsoleteHelperPath = path.join(claudeSkills, 'migrate-memory', 'scripts', 'migrate-auto-memory.mjs');

const migrateSkill = fs.readFileSync(migrateSkillPath, 'utf8');
const updateSkill = fs.readFileSync(updateSkillPath, 'utf8');
const addCodexSkill = fs.readFileSync(path.join(claudeSkills, 'add-codex', 'SKILL.md'), 'utf8');
const removeCodexSkill = fs.readFileSync(path.join(claudeSkills, 'add-codex', 'REMOVE.md'), 'utf8');
const cloneAsCodexSkill = fs.readFileSync(path.join(claudeSkills, 'clone-as-codex', 'SKILL.md'), 'utf8');
const cloneAsOpenCodeSkill = fs.readFileSync(path.join(claudeSkills, 'clone-as-opencode', 'SKILL.md'), 'utf8');
const migrateFromOpenClawSkill = fs.readFileSync(path.join(claudeSkills, 'migrate-from-openclaw', 'SKILL.md'), 'utf8');
const removeMigrateFromOpenClawSkill = fs.readFileSync(
  path.join(claudeSkills, 'migrate-from-openclaw', 'REMOVE.md'),
  'utf8',
);
const migrateFromV1Skill = fs.readFileSync(path.join(claudeSkills, 'migrate-from-v1', 'SKILL.md'), 'utf8');
const memoryDoc = fs.readFileSync(path.join(root, 'docs', 'memory.md'), 'utf8');
const workgroupsDoc = fs.readFileSync(path.join(root, 'docs', 'workgroups.md'), 'utf8');
const providerMigrationDoc = fs.readFileSync(path.join(root, 'docs', 'provider-migration.md'), 'utf8');
const v1ToV2Doc = fs.readFileSync(path.join(root, 'docs', 'v1-to-v2-changes.md'), 'utf8');
const v1MigrationShell = fs.readFileSync(path.join(root, 'migrate-v2.sh'), 'utf8');
const v1GroupsMigration = fs.readFileSync(path.join(root, 'setup', 'migrate-v2', 'groups.ts'), 'utf8');
const claudeMdComposeSource = fs.readFileSync(path.join(root, 'src', 'claude-md-compose.ts'), 'utf8');
const memoryDefinition = fs.readFileSync(
  path.join(root, 'container', 'agent-runner', 'src', 'memory', 'templates', 'system', 'definition.md'),
  'utf8',
);
const containerInstructions = fs.readFileSync(path.join(root, 'container', 'CLAUDE.md'), 'utf8');
const preTurnContextSource = fs.readFileSync(
  path.join(root, 'src', 'modules', 'memory', 'pre-turn-context.ts'),
  'utf8',
);
const migrationSource = fs.readFileSync(path.join(root, 'scripts', 'migrate-workgroup-memory.ts'), 'utf8');
const retiredMemorySpecFamilies = [
  path.join(root, 'docs', 'specs', 'mnemon-rearchitecture'),
  path.join(root, 'docs', 'specs', 'instrumented-memory-recall'),
  path.join(root, 'docs', 'specs', 'workgroup-scoped-data-layer'),
];
const retiredMemoryRootDocs = [
  path.join(root, 'docs', 'codex-parity-test-plan.md'),
  path.join(root, 'docs', 'specs', 'workgroup-shared-fs.md'),
];
const specificationStatusPolicy = fs.readFileSync(path.join(root, 'docs', 'specs', 'README.md'), 'utf8');

function position(haystack: string, needle: string): number {
  const found = haystack.indexOf(needle);
  expect(found, `missing contract step: ${needle}`).toBeGreaterThanOrEqual(0);
  return found;
}

describe('workgroup memory migration operator contract', () => {
  it('keeps memory inventory and recall ordering independent of the host locale', () => {
    expect(preTurnContextSource).not.toContain('.localeCompare(');
    expect(migrationSource).not.toContain('.localeCompare(');
  });

  it('runs the real CLI and distinguishes blocked apply from post-apply rollback', () => {
    const inventory = 'pnpm exec tsx scripts/migrate-workgroup-memory.ts inventory --all --report "$REPORT"';
    const apply = 'pnpm exec tsx scripts/migrate-workgroup-memory.ts apply --report "$REPORT"';
    const verify = 'pnpm exec tsx scripts/verify-workgroup-memory-runtime.ts --all --json --require-applied-migration';
    const rollback = 'pnpm exec tsx scripts/migrate-workgroup-memory.ts rollback --report "$REPORT"';

    expect(position(migrateSkill, inventory)).toBeLessThan(position(migrateSkill, apply));
    expect(position(migrateSkill, apply)).toBeLessThan(position(migrateSkill, verify));
    expect(position(migrateSkill, verify)).toBeLessThan(position(migrateSkill, rollback));
    expect(migrateSkill).toMatch(
      /apply failure[\s\S]{0,240}fail(?:s|ed)? closed[\s\S]{0,240}cutover-started[\s\S]{0,240}automatically restor/i,
    );
    expect(migrateSkill).toMatch(/blocked report[\s\S]{0,180}fresh inventory report/i);
    expect(migrateSkill).toMatch(/status\s+`applied`[\s\S]{0,240}runtime verification fails[\s\S]{0,240}rollback/i);
    expect(migrateSkill).not.toMatch(/any apply or runtime verification failure requires rollback/i);
    expect(migrateSkill).toMatch(/do not (?:restart|activate)[\s\S]{0,240}(?:verification|rollback)/i);
    expect(memoryDoc).toMatch(
      /apply failure fails closed[\s\S]{0,240}do not run explicit rollback[\s\S]{0,180}blocked report/i,
    );
    expect(memoryDoc).toMatch(
      /apply reached\s+`applied`[\s\S]{0,160}runtime verification fails[\s\S]{0,160}explicit rollback/i,
    );
  });

  it('defines one workgroup canon and discovers every current or future sibling source', () => {
    expect(migrateSkill).toContain('data/workgroups/<workgroup-id>/memory');
    expect(migrateSkill).toContain('/workspace/workgroup/memory');
    expect(migrateSkill).toContain('/workspace/agent/memory');
    expect(migrateSkill).toMatch(/every current and future sibling/i);
    expect(migrateSkill).toMatch(/discover(?:s|ed)? at\s+(?:inventory|execution) time/i);
    expect(migrateSkill).not.toMatch(/(?:exactly|only)\s+three\s+(?:stores|sources|agents)/i);
  });

  it('preserves every byte with permanent rollback, collision imports, and origin provenance', () => {
    expect(migrateSkill).toMatch(/permanent[\s-]+host-only[\s\S]{0,120}(?:snapshot|rollback)/i);
    expect(migrateSkill).toMatch(/SHA-256/i);
    expect(migrateSkill).toContain('imports/<source-group>/');
    expect(migrateSkill).toMatch(/coherent tree/i);
    expect(migrateSkill).toMatch(/relative Markdown link[\s\S]{0,240}(?:block|abort|fail)/i);
    expect(migrateSkill).toMatch(/exact whole-tree duplicates[\s\S]{0,160}every origin retained/i);
    expect(migrateSkill).toMatch(/deterministic SHA-qualified collision/i);
    expect(migrateSkill).toMatch(/rollback material[\s\S]{0,120}(?:never|no automatic) cleanup/i);
  });

  it('keeps provider identity, config, state, and non-memory customization separate', () => {
    for (const phrase of ['provider identity', 'provider config', 'provider state', 'non-memory customizations']) {
      expect(migrateSkill).toContain(phrase);
    }
    expect(migrateSkill).toMatch(/preserv(?:e|ed)[\s\S]{0,180}byte-for-byte/i);
    expect(migrateSkill).toMatch(/provider-native[\s\S]{0,160}(?:compatibility )?views/i);
    expect(migrateSkill).toMatch(/views[\s\S]{0,120}not\s+(?:memory )?authorit/i);
    expect(migrateSkill).toMatch(
      /only[\s\S]{0,100}(?:group-local|group) memory roots[\s\S]{0,140}recognized provider-native memory roots/i,
    );
    expect(migrateSkill).toMatch(
      /(?:\.seed\.md|`\.seed\.md`)[\s\S]{0,180}CLAUDE\.local\.md[\s\S]{0,220}not memory migration inputs/i,
    );
    expect(migrateSkill).toMatch(/legacy instruction reconciliation[\s\S]{0,180}explicit separate operator workflow/i);
  });

  it('forbids winner selection, semantic merge, opaque activation, and provider self-migration', () => {
    expect(migrateSkill).toMatch(/never choose (?:a|one) (?:source )?winner/i);
    expect(migrateSkill).toMatch(/never semantically merge/i);
    expect(migrateSkill).toMatch(/never (?:silently )?activate opaque/i);
    expect(migrateSkill).toMatch(/never ask[\s\S]{0,120}(?:Claude|Codex|OpenCode|provider)[\s\S]{0,120}migrat/i);

    expect(migrateSkill).not.toContain('.memory-migration-staging');
    expect(migrateSkill).not.toContain('.memory-migration-quarantine');
    expect(migrateSkill).not.toContain('Organize with the invoking harness');
  });

  it('deletes the semantic organizer helper and leaves no tracked references', () => {
    expect(fs.existsSync(obsoleteHelperPath)).toBe(false);

    let output = '';
    try {
      output = execFileSync(
        'git',
        ['grep', '-n', 'migrate-auto-memory', '--', '.', ':!src/memory-migration-contract.test.ts'],
        { cwd: root, encoding: 'utf8' },
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    expect(output).toBe('');
  });
});

describe('retired memory surfaces', () => {
  it('defines one mechanical active-versus-historical specification rule', () => {
    expect(specificationStatusPolicy).toContain('.team-auto-active');
    expect(specificationStatusPolicy).toMatch(/active only while/i);
    expect(specificationStatusPolicy).toMatch(/sentinel is removed[\s\S]{0,180}historical evidence/i);
    expect(fs.existsSync(path.join(root, '.context/specs/README.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.context/specs/mnemon-integration/plan.md'))).toBe(false);
  });

  it('marks every retired memory spec artifact as archived and superseded', () => {
    const familyDocs = retiredMemorySpecFamilies.flatMap((directory) =>
      fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.md'))
        .map((name) => path.join(directory, name)),
    );

    for (const file of [...familyDocs, ...retiredMemoryRootDocs]) {
      const header = fs.readFileSync(file, 'utf8').split('\n').slice(0, 12).join('\n');
      expect(header, `${path.relative(root, file)} lacks an archive banner`).toMatch(/ARCHIVED/i);
      expect(header, `${path.relative(root, file)} lacks a current-contract pointer`).toMatch(
        /current|one-canon|workgroup-memory-and-session-capabilities/i,
      );
    }
  });

  it('keeps the retired central semantic-memory store out of runtime code', () => {
    expect(fs.existsSync(path.join(root, 'src', 'db', 'memories.ts'))).toBe(false);
    const types = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
    expect(types).not.toContain('export type MemoryType');
    expect(types).not.toContain('export interface Memory {');
  });

  it('does not cite the retired recall-injection module from active source', () => {
    const retiredModule = ['recall', 'injection.ts'].join('-');
    let output = '';
    try {
      output = execFileSync('git', ['grep', '-n', retiredModule, '--', 'src', 'container', 'scripts', 'setup'], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    expect(output).toBe('');
  });
});

describe('dependent provider and v1 migration surfaces', () => {
  it('never reverse-migrates memory during provider switches after canon activation', () => {
    for (const surface of [addCodexSkill, removeCodexSkill]) {
      expect(surface).toMatch(
        /once[\s\S]{0,120}(?:workgroup )?canon[\s\S]{0,120}active[\s\S]{0,180}no\s+memory migration/i,
      );
      expect(surface).toMatch(/shared-memory cutover[\s\S]{0,140}incomplete[\s\S]{0,180}\/migrate-memory/i);
      expect(surface).not.toMatch(/migrate-memory[\s\S]{0,120}(?:carry back|carry across)/i);
      expect(surface).not.toMatch(/migrate-memory[\s\S]{0,180}(?:\.seed\.md|CLAUDE\.local\.md)/i);
    }
  });

  it('keeps v1 standing instructions byte-preserved and outside memory consolidation', () => {
    for (const surface of [migrateFromV1Skill, v1ToV2Doc]) {
      expect(surface).toMatch(/CLAUDE\.local\.md[\s\S]{0,220}(?:byte-preserved|preserv(?:e|ed) byte-for-byte)/i);
      expect(surface).toMatch(
        /(?:group-local|group) memory\s+roots[\s\S]{0,180}recognized provider-native memory\s+roots/i,
      );
      expect(surface).toMatch(/legacy instruction\s+reconciliation[\s\S]{0,180}explicit\s+separate operator workflow/i);
      expect(surface).toMatch(/never[\s\S]{0,120}(?:move|distill)[\s\S]{0,140}(?:instruction|CLAUDE\.local)/i);
    }

    expect(migrateFromV1Skill).not.toMatch(/moves the v1 `CLAUDE\.local\.md` into the shared `memory\/` tree/i);
    expect(migrateFromV1Skill).not.toMatch(/distill standing identity into `instructions\.prepend\.md`/i);
    expect(v1ToV2Doc).not.toMatch(/`\/migrate-memory` to move and distill/i);
  });

  it('cuts over imported memory before the first real-message v2 smoke test', () => {
    const memoryCutover = position(migrateFromV1Skill, '### 0b — Cut over imported memory before first spawn');
    const smoke = position(migrateFromV1Skill, '### 0c — Smoke test, then continue');
    expect(memoryCutover).toBeLessThan(smoke);
    expect(migrateFromV1Skill).toMatch(
      /substantive imported memory[\s\S]{0,240}migration-required[\s\S]{0,240}refus(?:e|es|ing) container spawn/i,
    );
    expect(migrateFromV1Skill).toMatch(
      /\/migrate-memory[\s\S]{0,240}before[\s\S]{0,160}(?:real test\s+message|first spawn)/i,
    );
  });

  it('keeps deterministic v1 copy and cutover surfaces on the separate instruction contract', () => {
    // The v1 migrator still produces CLAUDE.local.md; the composer now retires
    // it into standing-instructions.md. Neither ever routes it to memory.
    for (const surface of [v1MigrationShell, v1GroupsMigration]) {
      expect(surface).toMatch(/CLAUDE\.local\.md[\s\S]{0,220}standing instruction/i);
    }
    expect(claudeMdComposeSource).toMatch(/CLAUDE\.local\.md[\s\S]{0,600}standing-instructions\.md/);
    for (const surface of [v1MigrationShell, v1GroupsMigration, claudeMdComposeSource]) {
      expect(surface).not.toMatch(
        /CLAUDE\.local\.md[\s\S]{0,220}\/migrate-memory|\/migrate-memory[\s\S]{0,220}CLAUDE\.local\.md/i,
      );
      expect(surface).not.toMatch(/CLAUDE\.local\.md[\s\S]{0,220}(?:per-group|group) memory/i);
    }

    expect(v1GroupsMigration).toContain('fs.copyFileSync(v1Claude, v2Local)');
    expect(v1GroupsMigration).toMatch(/explicit, separate legacy instruction\s+reconciliation/i);
    expect(v1GroupsMigration).toMatch(/never a memory migration input/i);
  });
});

describe('clone and OpenClaw migration surfaces', () => {
  it('makes every present and future provider sibling inherit one workgroup canon', () => {
    for (const surface of [cloneAsCodexSkill, cloneAsOpenCodeSkill]) {
      expect(surface).toContain('data/workgroups/<workgroup-id>/memory');
      expect(surface).toContain('/workspace/workgroup/memory');
      expect(surface).toContain('/workspace/agent/memory');
      expect(surface).toMatch(/every (?:current|present) and future sibling/i);
      expect(surface).toMatch(
        /workgroup membership[\s\S]{0,220}(?:inherit|share)[\s\S]{0,180}(?:one|the) (?:workgroup )?(?:memory )?canon/i,
      );
      expect(surface).toMatch(
        /once[\s\S]{0,120}(?:workgroup )?canon[\s\S]{0,120}active[\s\S]{0,180}no\s+memory migration/i,
      );
      expect(surface).not.toMatch(/reverse[\s-]+migrat(?:e|ion)[\s\S]{0,100}memory/i);
    }
  });

  it('shares the persona as standing instruction state rather than per-group memory', () => {
    for (const surface of [cloneAsCodexSkill, cloneAsOpenCodeSkill]) {
      expect(surface).toMatch(/standing-instructions\.md[\s\S]{0,180}persona[\s\S]{0,180}not (?:a )?memory/i);
      // One file for the whole sibling set: a link, never a copy that can drift.
      expect(surface).toContain('ln -sfn ../${SOURCE_FOLDER}/standing-instructions.md standing-instructions.md');
      // The retired file must not be re-created for a new sibling.
      expect(surface).not.toMatch(/ln -sfn[^\n]*CLAUDE\.local\.md/);
      expect(surface).not.toMatch(/per-group memory/i);
    }
  });

  it('imports OpenClaw memory losslessly through the canonical inventory/apply/verify gate', () => {
    expect(migrateFromOpenClawSkill).toContain('data/workgroups/<workgroup-id>/memory');
    expect(migrateFromOpenClawSkill).toContain('/workspace/workgroup/memory');
    expect(migrateFromOpenClawSkill).toMatch(/every (?:current|present) and future sibling/i);
    expect(migrateFromOpenClawSkill).toMatch(/byte-for-byte/i);
    expect(migrateFromOpenClawSkill).toMatch(/SHA-256/i);
    expect(migrateFromOpenClawSkill).toContain(
      'pnpm exec tsx scripts/migrate-workgroup-memory.ts inventory --all --report "$REPORT"',
    );
    expect(migrateFromOpenClawSkill).toContain(
      'pnpm exec tsx scripts/migrate-workgroup-memory.ts apply --report "$REPORT"',
    );
    expect(migrateFromOpenClawSkill).toContain(
      'pnpm exec tsx scripts/verify-workgroup-memory-runtime.ts --all --json --require-applied-migration',
    );
    expect(migrateFromOpenClawSkill).toMatch(/permanent pre-import snapshot/i);
    expect(migrateFromOpenClawSkill).toMatch(
      /pre-import snapshot[\s\S]{0,300}(?:blocked apply|runtime verification failure)[\s\S]{0,300}restor/i,
    );
    expect(migrateFromOpenClawSkill).not.toMatch(/groups\/<folder>\/memory/);
    expect(migrateFromOpenClawSkill).not.toMatch(/<group_dir>\/memory/);
  });

  it('keeps the OpenClaw removal contract on the workgroup canon and permanent rollback path', () => {
    expect(removeMigrateFromOpenClawSkill).toContain('data/workgroups/<workgroup-id>/memory/');
    expect(removeMigrateFromOpenClawSkill).toContain('/workspace/agent/memory');
    expect(removeMigrateFromOpenClawSkill).toMatch(/only a[\s\S]{0,80}compatibility link/i);
    expect(removeMigrateFromOpenClawSkill).toMatch(/Never delete[\s\S]{0,160}snapshots automatically/i);
    expect(removeMigrateFromOpenClawSkill).toMatch(/blocked report[\s\S]{0,100}(?:not|never)[\s\S]{0,80}rollback/i);
    expect(removeMigrateFromOpenClawSkill).not.toMatch(/groups\/(?:\\?\\*)?\/memory/);
    expect(removeMigrateFromOpenClawSkill).not.toMatch(/groups\/<folder>\/memory/);
    expect(removeMigrateFromOpenClawSkill).not.toMatch(/There is no automatic rollback/i);
  });

  it('preserves OpenClaw instruction files outside memory without semantic distillation', () => {
    expect(migrateFromOpenClawSkill).toMatch(
      /IDENTITY\.md[\s\S]{0,120}SOUL\.md[\s\S]{0,120}USER\.md[\s\S]{0,220}instruction state/i,
    );
    expect(migrateFromOpenClawSkill).toMatch(
      /instruction files[\s\S]{0,220}(?:byte-preserved|preserv(?:e|ed) byte-for-byte)/i,
    );
    expect(migrateFromOpenClawSkill).toMatch(
      /legacy instruction reconciliation[\s\S]{0,180}explicit separate operator workflow/i,
    );
    expect(migrateFromOpenClawSkill).toMatch(/never[\s\S]{0,120}(?:distill|weave)[\s\S]{0,180}memory/i);
    expect(migrateFromOpenClawSkill).not.toMatch(/weave[\s\S]{0,100}instructions\.prepend\.md/i);
    expect(migrateFromOpenClawSkill).not.toMatch(/extract durable facts/i);
    expect(migrateFromOpenClawSkill).not.toMatch(/judgment calls about what's core vs\. reference material/i);
  });
});

describe('one tracked skill canon', () => {
  it('resolves .agents skills to .claude skills with byte-identical contracts', () => {
    let agentsSkillStat: fs.Stats;
    try {
      agentsSkillStat = fs.lstatSync(agentsSkills);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    expect(agentsSkillStat.isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(agentsSkills)).toBe(fs.realpathSync(claudeSkills));
    for (const skillName of ['migrate-memory', 'update-nanoclaw']) {
      const claudeBytes = fs.readFileSync(path.join(claudeSkills, skillName, 'SKILL.md'));
      const agentBytes = fs.readFileSync(path.join(agentsSkills, skillName, 'SKILL.md'));
      expect(agentBytes.equals(claudeBytes)).toBe(true);
    }
  });
});

describe('customization-first update gate', () => {
  it('audits clean auto-merges across every customization dependency path', () => {
    expect(updateSkill).toMatch(/customizations[\s\S]{0,120}outrank upstream defaults/i);
    expect(updateSkill).toMatch(/full merge/i);
    expect(updateSkill).toMatch(/clean auto-merge/i);
    expect(updateSkill).toMatch(/dependency (?:closure|code|path)/i);
    expect(updateSkill).toMatch(/regression verification/i);
  });

  it('blocks activation while any memory gate is unresolved and shows rollback', () => {
    expect(updateSkill).toMatch(
      /(?:memory inventory|memory migration|runtime verification)[\s\S]{0,320}(?:unresolved|failed|incomplete)[\s\S]{0,320}(?:block|do not)[\s\S]{0,160}(?:restart|activation)/i,
    );
    expect(updateSkill).not.toContain('Restart anyway');
    expect(updateSkill).toContain('git reset --hard <backup-tag-from-step-1>');
    expect(updateSkill).toMatch(/rollback[\s\S]{0,200}pre-update/i);

    const summaryGate = updateSkill.slice(position(updateSkill, '# Step 9: Summary + rollback instructions'));
    const hardGate = position(summaryGate, 'If `MEMORY_ACTIVATION_BLOCKED=yes`, stop.');
    expect(hardGate).toBeLessThan(position(summaryGate, 'Tell the user:'));
    expect(summaryGate).toMatch(
      /If `MEMORY_ACTIVATION_BLOCKED=yes`, stop\.[\s\S]{0,260}do not show or execute[\s\S]{0,120}restart/i,
    );
  });
});

describe('memory documentation and provider instructions', () => {
  it('documents the safe operator contract for preserving and intentionally changing workgroup membership', () => {
    expect(workgroupsDoc).toMatch(
      /Omitting `container\.json\.workgroup_id` preserves an existing non-null DB\s+assignment/i,
    );
    expect(workgroupsDoc).toMatch(
      /neither an explicit config value nor an existing DB assignment defaults to\s+its own folder slug/i,
    );
    expect(workgroupsDoc).toMatch(
      /intentionally unpair[\s\S]{0,180}set `container\.json\.workgroup_id` explicitly[\s\S]{0,180}removing the field does not unpair/i,
    );
    expect(workgroupsDoc).not.toMatch(
      /When `container\.json\.workgroup_id` is omitted, the workgroup defaults to the agent group's own folder slug/i,
    );
  });

  it('documents one sibling-shared canon, bounded automatic recall, and exact provenance', () => {
    const docs = `${memoryDoc}\n${workgroupsDoc}\n${providerMigrationDoc}`;
    expect(docs).toContain('data/workgroups/<workgroup-id>/memory');
    expect(docs).toContain('/workspace/workgroup/memory');
    expect(docs).toMatch(/same-thread/i);
    expect(docs).toMatch(/workgroup[\s-]+wide (?:archive )?recall/i);
    expect(docs).toMatch(/every admissible turn/i);
    expect(docs).toMatch(/explicit degraded/i);
    expect(docs).toMatch(/exact (?:Slack\/Discord )?permalink provenance/i);
    expect(docs).toMatch(/provider-native[\s\S]{0,140}views[\s\S]{0,100}not authorit/i);
  });

  it('requires guarded Markdown writes and treats raw projections as read-only', () => {
    const docsAndTemplate = `${memoryDoc}\n${providerMigrationDoc}\n${memoryDefinition}\n${containerInstructions}`;
    expect(docsAndTemplate).toContain('write_memory_file');
    expect(docsAndTemplate).toMatch(/expected SHA/i);
    expect(docsAndTemplate).toMatch(/raw[\s\S]{0,100}(?:projection|provider-native)[\s\S]{0,100}read-only/i);
    expect(memoryDefinition).toMatch(/write_memory_file[\s\S]{0,80}edit Markdown/i);
    expect(containerInstructions).toContain('/workspace/workgroup/memory/');
    expect(containerInstructions).toMatch(/write_memory_file[\s\S]{0,180}SHA-256/i);
    expect(containerInstructions).not.toMatch(/memory\/[\s\S]{0,100}Update it directly/i);
  });

  it('keeps provider and non-memory state separate from the shared memory canon', () => {
    expect(providerMigrationDoc).toMatch(/provider identity/i);
    expect(providerMigrationDoc).toMatch(/provider config/i);
    expect(providerMigrationDoc).toMatch(/provider state/i);
    expect(providerMigrationDoc).toMatch(/non-memory customizations/i);
    expect(providerMigrationDoc).toMatch(/not (?:copied|merged|migrated) into (?:the )?memory/i);
  });
});
