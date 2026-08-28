import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { effectiveDockerArgBeforeFinalRun } from '../setup/providers/dockerfile-version.js';

const root = process.cwd();
const dockerfile = fs.readFileSync(path.join(root, 'container/Dockerfile'), 'utf8');
const agentRunnerPackage = JSON.parse(
  fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8'),
) as { dependencies: Record<string, string> };

describe('provider version contracts', () => {
  it('test_claude_cli_agent_sdk_lockstep', () => {
    const cliVersion = effectiveDockerArgBeforeFinalRun(
      dockerfile,
      'CLAUDE_CODE_VERSION',
      '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"',
    );
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(agentRunnerPackage.dependencies['@anthropic-ai/claude-agent-sdk']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('test_codex_pin_is_exact_and_consumed', () => {
    const pin = effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', '"@openai/codex@${CODEX_VERSION}"');
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain('"@openai/codex@${CODEX_VERSION}"');

    const skill = fs.readFileSync(path.join(root, '.claude/skills/add-codex/SKILL.md'), 'utf8');
    expect(skill).toContain('verifyCodexInstall');
  });

  it('test_opencode_all_operational_pins_match', () => {
    const pin = effectiveDockerArgBeforeFinalRun(dockerfile, 'OPENCODE_VERSION', '"opencode-ai@${OPENCODE_VERSION}"');
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(agentRunnerPackage.dependencies['@opencode-ai/sdk']).toBe(pin);

    const capture = fs.readFileSync(
      path.join(root, 'container/agent-runner/src/providers/opencode-tool-enumeration.test.ts'),
      'utf8',
    );
    expect(capture).toMatch(new RegExp(`OPENCODE_CAPTURED_VERSION = '${pin}'`));

    const addSkill = fs.readFileSync(path.join(root, '.claude/skills/add-opencode/SKILL.md'), 'utf8');
    const cloneSkill = fs.readFileSync(path.join(root, '.claude/skills/clone-as-opencode/SKILL.md'), 'utf8');
    expect(addSkill).not.toContain('mapfile');
    expect(addSkill).toContain('OPENCODE_VERSION="$(sed -nE');
    expect(addSkill).toContain("grep -Ec '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    expect(addSkill).toContain('replace any\nexisting `ARG OPENCODE_VERSION=...` declaration');
    expect(addSkill).toContain('@opencode-ai/sdk@"${OPENCODE_VERSION}"');
    expect(addSkill).toContain(`ARG OPENCODE_VERSION=${pin}`);
    expect(addSkill.indexOf(`ARG OPENCODE_VERSION=${pin}`)).toBeLessThan(
      addSkill.indexOf('OPENCODE_VERSION="$(sed -nE'),
    );
    expect(cloneSkill).not.toContain('mapfile');
    expect(cloneSkill).toContain('OPENCODE_VERSION="$(sed -nE');
    expect(cloneSkill).toContain("grep -Ec '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
  });

  it.each([
    ['CLAUDE_CODE_VERSION', '2.1.250', '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"'],
    ['CODEX_VERSION', '0.150.1', '"@openai/codex@${CODEX_VERSION}"'],
    ['OPENCODE_VERSION', '1.18.23', '"opencode-ai@${OPENCODE_VERSION}"'],
  ])('uses the effective %s declaration before its final install', (name, version, consumingInstall) => {
    const overridden = `ARG ${name}=${version}\nARG ${name}=latest\nRUN pnpm install -g ${consumingInstall}\n`;
    expect(effectiveDockerArgBeforeFinalRun(overridden, name, consumingInstall)).toBe('latest');

    const corrected = `ARG ${name}=latest\nARG ${name}=${version}\nRUN pnpm install -g ${consumingInstall}\n`;
    expect(effectiveDockerArgBeforeFinalRun(corrected, name, consumingInstall)).toBe(version);
  });
});
