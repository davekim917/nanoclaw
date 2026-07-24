import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const skill = fs.readFileSync(path.resolve('.claude/skills/update-skills/SKILL.md'), 'utf-8');
const updateSkill = fs.readFileSync(path.resolve('.claude/skills/update-nanoclaw/SKILL.md'), 'utf-8');

describe('installed-skill update contract', () => {
  it('blocks branch replays that would remove newer integration or custom behavior', () => {
    expect(skill).toContain('Treat local customization behavior as the release-blocking invariant');
    expect(skill).toContain('Idempotence does not prove compatibility');
    expect(skill).toContain('candidate missing a file');
    expect(skill).toContain('candidate would regress local behavior');
    expect(skill).toContain('targeted verification');
  });

  it('makes the core updater honor compatibility-aware skill refreshes', () => {
    expect(updateSkill).toContain('compatibility-audits your installed channels/providers');
    expect(updateSkill).toContain('correctly skips a candidate');
    expect(updateSkill).toContain('resolved preservation result');
  });
});
