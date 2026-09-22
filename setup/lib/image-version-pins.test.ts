/**
 * The container-image pins are recorded twice: the Dockerfile ARG (and the
 * runner's package.json) is what the build installs, versions.json is what
 * /update-nanoclaw diffs across an update. Tie them so a bump that edits one
 * cannot leave the other claiming a different version.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { effectiveDockerArgBeforeFinalRun } from './dockerfile-version.js';
import { readVersionPin } from './version-pins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = fs.readFileSync(path.join(root, 'container', 'Dockerfile'), 'utf-8');
const runnerPkg = JSON.parse(fs.readFileSync(path.join(root, 'container', 'agent-runner', 'package.json'), 'utf-8'));

describe('container-image pins in versions.json match what the build installs', () => {
  it.each([
    ['claude-code', 'CLAUDE_CODE_VERSION', '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"'],
    ['codex-cli', 'CODEX_VERSION', '"@openai/codex@${CODEX_VERSION}"'],
  ])('%s equals the Dockerfile %s the install RUN sees', (component, arg, consumer) => {
    expect(effectiveDockerArgBeforeFinalRun(dockerfile, arg, consumer)).toBe(readVersionPin(component));
  });

  it('claude-agent-sdk equals container/agent-runner/package.json', () => {
    expect(runnerPkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(readVersionPin('claude-agent-sdk'));
  });

  // claude-code 2.1.N ships with claude-agent-sdk 0.3.N; the CLI carries model
  // support, the SDK is its protocol wrapper, and a mismatched pair is untested.
  it('claude-code and claude-agent-sdk share a patch number', () => {
    const patch = (v: string) => v.split('.')[2];
    expect(patch(readVersionPin('claude-agent-sdk'))).toBe(patch(readVersionPin('claude-code')));
  });
});
