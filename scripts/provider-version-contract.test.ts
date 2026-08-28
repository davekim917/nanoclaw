import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const dockerfile = fs.readFileSync(path.join(root, 'container/Dockerfile'), 'utf8');
const agentRunnerPackage = JSON.parse(
  fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8'),
) as { dependencies: Record<string, string> };

function dockerArg(name: string): string | undefined {
  return dockerfile.match(new RegExp(`^ARG\\s+${name}=([^\\s#]+)\\s*$`, 'm'))?.[1];
}

describe('provider version contracts', () => {
  it('test_claude_cli_agent_sdk_lockstep', () => {
    const cliVersion = dockerArg('CLAUDE_CODE_VERSION');
    expect(cliVersion).toBe('2.1.250');
    expect(agentRunnerPackage.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.250');

    const sdkPackage = JSON.parse(
      fs.readFileSync(
        path.join(root, 'container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
        'utf8',
      ),
    ) as { version: string; claudeCodeVersion: string };
    expect(sdkPackage.version).toBe(agentRunnerPackage.dependencies['@anthropic-ai/claude-agent-sdk']);
    expect(sdkPackage.claudeCodeVersion).toBe(cliVersion);
  });

  it('test_codex_pin_is_exact_and_consumed', () => {
    const pin = dockerArg('CODEX_VERSION');
    expect(pin).toBe('0.150.1');
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain('"@openai/codex@${CODEX_VERSION}"');

    const skill = fs.readFileSync(path.join(root, '.claude/skills/add-codex/SKILL.md'), 'utf8');
    expect(skill).toContain('CODEX_VERSION=$(sed -nE');
    expect(skill).not.toContain('0.145.0');
  });

  it('test_opencode_all_operational_pins_match', () => {
    const pin = dockerArg('OPENCODE_VERSION');
    expect(pin).toBe('1.18.23');
    expect(agentRunnerPackage.dependencies['@opencode-ai/sdk']).toBe(pin);

    const capture = fs.readFileSync(
      path.join(root, 'container/agent-runner/src/providers/opencode-tool-enumeration.test.ts'),
      'utf8',
    );
    expect(capture).toMatch(new RegExp(`OPENCODE_CAPTURED_VERSION = '${pin}'`));

    for (const file of [
      '.claude/skills/add-opencode/SKILL.md',
      '.claude/skills/add-opencode/REMOVE.md',
      '.claude/skills/clone-as-opencode/SKILL.md',
      'scripts/provider-memory-contract.ts',
    ]) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toContain('1.17.18');
    }

    const addSkill = fs.readFileSync(path.join(root, '.claude/skills/add-opencode/SKILL.md'), 'utf8');
    const cloneSkill = fs.readFileSync(path.join(root, '.claude/skills/clone-as-opencode/SKILL.md'), 'utf8');
    expect(addSkill).toContain('OPENCODE_VERSION=$(sed -nE');
    expect(addSkill).toContain('@opencode-ai/sdk@"${OPENCODE_VERSION}"');
    expect(addSkill.indexOf('ARG OPENCODE_VERSION=<exact-version>')).toBeLessThan(
      addSkill.indexOf('OPENCODE_VERSION=$(sed -nE'),
    );
    expect(cloneSkill).toContain('OPENCODE_VERSION=$(sed -nE');
  });

  it('test_no_stale_operational_provider_pins', () => {
    for (const file of [
      '.claude/skills/add-codex/SKILL.md',
      'setup/providers/codex.ts',
      '.claude/skills/add-opencode/SKILL.md',
      '.claude/skills/add-opencode/REMOVE.md',
      '.claude/skills/clone-as-opencode/SKILL.md',
    ]) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(/\b(?:0\.145\.0|1\.17\.18)\b/);
    }
  });
});
