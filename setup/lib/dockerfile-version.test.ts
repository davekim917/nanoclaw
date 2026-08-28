import { describe, expect, it } from 'vitest';

import {
  effectiveDockerArgBeforeFinalRun,
  hasDockerRunConsumer,
  parseDockerInstructions,
} from './dockerfile-version.js';

describe('Dockerfile provider version parsing', () => {
  it('ignores full-line and shell comments while finding a continued RUN consumer', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim',
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
    expect(parseDockerInstructions(dockerfile).filter((instruction) => instruction.name === 'RUN')).toEqual([
      { name: 'RUN', value: `pnpm install -g ${packageText}` },
    ]);
  });

  it('requires a global package-manager install rather than arbitrary RUN text', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const unpinnedInstallThenEcho = [
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.1',
      'RUN pnpm install -g "@openai/codex@latest"',
      `RUN echo ${packageText}`,
      '',
    ].join('\n');
    const pinnedInstallThenEcho = [
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.1',
      `RUN pnpm install -g ${packageText} && echo ${packageText}`,
      '',
    ].join('\n');

    expect(hasDockerRunConsumer(unpinnedInstallThenEcho, packageText)).toBe(false);
    expect(effectiveDockerArgBeforeFinalRun(unpinnedInstallThenEcho, 'CODEX_VERSION', packageText)).toBeUndefined();
    expect(hasDockerRunConsumer(pinnedInstallThenEcho, packageText)).toBe(true);
    expect(effectiveDockerArgBeforeFinalRun(pinnedInstallThenEcho, 'CODEX_VERSION', packageText)).toBe('0.150.1');
  });

  it.each([['pnpm install -g'], ['npm install --global'], ['bun install -g'], ['bun add -g']])(
    'recognizes a real global %s consumer',
    (install) => {
      const packageText = '"@openai/codex@${CODEX_VERSION}"';
      const dockerfile = [
        'FROM node:22-slim',
        'ARG CODEX_VERSION=0.150.1',
        `RUN --mount=type=cache,target=/tmp/cache ${install} ${packageText}`,
        '',
      ].join('\n');

      expect(hasDockerRunConsumer(dockerfile, packageText)).toBe(true);
      expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('0.150.1');
    },
  );

  it.each([
    ['CLAUDE_CODE_VERSION', '2.1.250', '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"'],
    ['CODEX_VERSION', '0.150.1', '"@openai/codex@${CODEX_VERSION}"'],
    ['OPENCODE_VERSION', '1.18.23', '"opencode-ai@${OPENCODE_VERSION}"'],
  ])('uses the final %s declaration before its real install', (name, version, packageText) => {
    const latest = `FROM node:22\nARG ${name}=latest\nARG ${name}=${version}\nRUN pnpm install -g ${packageText}\n`;
    expect(effectiveDockerArgBeforeFinalRun(latest, name, packageText)).toBe(version);

    const mutable = `FROM node:22\nARG ${name}=${version}\nARG ${name}=latest\nRUN pnpm install -g ${packageText}\n`;
    expect(effectiveDockerArgBeforeFinalRun(mutable, name, packageText)).toBe('latest');
  });

  it('requires an ARG to be redeclared inside the consuming stage', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'ARG CODEX_VERSION=0.150.1',
      'FROM node:22-slim',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });

  it('uses a global default after the consuming stage redeclares the ARG', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'ARG CODEX_VERSION=0.150.1',
      'FROM node:22-slim',
      'ARG CODEX_VERSION',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('0.150.1');
  });

  it('uses the consuming stage default over its global declaration', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'ARG CODEX_VERSION=0.150.1',
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.2',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('0.150.2');
  });

  it('does not leak an ARG from a prior stage into the consuming stage', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim AS build',
      'ARG CODEX_VERSION=0.150.1',
      'FROM node:22-slim',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });

  it('rejects a version ENV that shadows the exact ARG before the consuming RUN', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.1',
      'ENV CODEX_VERSION=latest',
      'RUN pnpm install -g ' + packageText,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });

  it('allows an unrelated ENV before the consuming RUN', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.1',
      'ENV OTHER_VERSION=latest',
      'RUN pnpm install -g ' + packageText,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('0.150.1');
  });

  it('does not let a later ARG undo an intervening version ENV', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim',
      'ARG CODEX_VERSION=0.150.1',
      'ENV CODEX_VERSION=latest',
      'ARG CODEX_VERSION=0.150.2',
      'RUN pnpm install -g ' + packageText,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });

  it('rejects an ENV shadow inherited through named-stage aliases', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim AS base',
      'ENV CODEX_VERSION=latest',
      'FROM base AS intermediate',
      'FROM intermediate',
      'ARG CODEX_VERSION=0.150.1',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });

  it('allows an unrelated inherited ENV and ignores an ENV after the consumer', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'FROM node:22-slim AS base',
      'ENV OTHER_VERSION=latest',
      'FROM base AS final',
      'ARG CODEX_VERSION=0.150.1',
      `RUN pnpm install -g ${packageText}`,
      'ENV CODEX_VERSION=latest',
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBe('0.150.1');
  });

  it('fails closed when the consuming stage base is unresolved', () => {
    const packageText = '"@openai/codex@${CODEX_VERSION}"';
    const dockerfile = [
      'ARG RUNTIME_IMAGE=node:22-slim',
      'FROM ${RUNTIME_IMAGE}',
      'ARG CODEX_VERSION=0.150.1',
      `RUN pnpm install -g ${packageText}`,
      '',
    ].join('\n');

    expect(effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', packageText)).toBeUndefined();
  });
});
