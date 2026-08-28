import { describe, expect, it } from 'vitest';

import {
  effectiveDockerArgBeforeFinalRun,
  finalDockerArg,
  hasDockerRunConsumer,
  parseDockerInstructions,
} from './dockerfile-version.js';

describe('Dockerfile provider version parsing', () => {
  it('ignores full-line and shell comments while finding a continued RUN consumer', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'ARG CODEX_VERSION=0.150.1',
      'ARG CODEX_VERSION=latest',
      'RUN pnpm install -g \\',
      `    # documentation only: ${packageText}`,
      `    ${packageText} # installed through the pin above`,
      'ARG CODEX_VERSION=0.150.1',
      `# later documentation only: ${packageText}`,
      '',
    ].join('\n');

    expect(hasDockerRunConsumer(dockerfile, packageText)).toBe(true);
    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('latest');
    expect(finalDockerArg(dockerfile, 'CODEX_VERSION')).toBe('0.150.1');
    expect(parseDockerInstructions(dockerfile).filter((instruction) => instruction.name === 'RUN')).toEqual([
      { name: 'RUN', value: `pnpm install -g ${packageText}` },
    ]);
  });

  it.each([
    ['CLAUDE_CODE_VERSION', '2.1.250', '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"'],
    ['CODEX_VERSION', '0.150.1', '"@openai/codex@${CODEX_VERSION}"'],
    ['OPENCODE_VERSION', '1.18.23', '"opencode-ai@${OPENCODE_VERSION}"'],
  ])('uses the final %s declaration before its real install', (name, version, packageText) => {
    const latest = `ARG ${name}=latest\nARG ${name}=${version}\nRUN pnpm install -g ${packageText}\n`;
    expect(effectiveDockerArgBeforeFinalRun(latest, name, packageText)).toBe(version);

    const mutable = `ARG ${name}=${version}\nARG ${name}=latest\nRUN pnpm install -g ${packageText}\n`;
    expect(effectiveDockerArgBeforeFinalRun(mutable, name, packageText)).toBe('latest');
  });
});
