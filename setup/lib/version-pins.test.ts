/**
 * versions.json is the machine-checkable source for sanctioned component
 * versions: setup steps read it, /update-nanoclaw diffs it across updates.
 * These tests go red if the file, the pin, or the onecli-step wiring is
 * deleted — the pin moving back to a hardcoded constant is the regression
 * this guards against.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { effectiveDockerArgBeforeFinalRun } from './dockerfile-version.js';
import { readVersionPin } from './version-pins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('readVersionPin', () => {
  it('resolves the onecli-gateway pin from the real versions.json', () => {
    expect(readVersionPin('onecli-gateway')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves the onecli-cli pin from the real versions.json', () => {
    expect(readVersionPin('onecli-cli')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('throws for a component with no pin', () => {
    expect(() => readVersionPin('no-such-component')).toThrow(/no pin/);
  });
});

describe('onecli step wiring', () => {
  it('reads its gateway pin from versions.json, not a hardcoded constant', () => {
    const source = fs.readFileSync(path.join(here, '..', 'onecli.ts'), 'utf-8');
    expect(source).toContain("readVersionPin('onecli-gateway')");
    expect(source).not.toMatch(/ONECLI_GATEWAY_VERSION = '\d/);
  });

  it('reads its CLI pin from versions.json and never resolves "latest"', () => {
    const source = fs.readFileSync(path.join(here, '..', 'onecli.ts'), 'utf-8');
    expect(source).toContain("readVersionPin('onecli-cli')");
    expect(source).not.toMatch(/ONECLI_CLI(?:_FALLBACK)?_VERSION = '\d/);
    // The upstream installer and the /releases/latest redirect probe both
    // chase "latest" — reintroducing either bypasses the sanctioned pin.
    expect(source).not.toContain('onecli.sh/cli/install');
    expect(source).not.toContain('/releases/latest');
  });
});

// The container-image pins are recorded twice: the Dockerfile ARG is what the
// build installs, versions.json is what /update-nanoclaw diffs. Tie them so a
// bump that edits one cannot leave the other claiming a different version.
describe('container-image pins match the Dockerfile and the runner manifest', () => {
  const root = path.resolve(here, '..', '..');
  const dockerfile = fs.readFileSync(path.join(root, 'container', 'Dockerfile'), 'utf-8');
  const runnerPkg = JSON.parse(fs.readFileSync(path.join(root, 'container', 'agent-runner', 'package.json'), 'utf-8'));

  it.each([
    ['claude-code', 'CLAUDE_CODE_VERSION', '"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"'],
    ['codex-cli', 'CODEX_VERSION', '"@openai/codex@${CODEX_VERSION}"'],
  ])('%s equals the Dockerfile %s the install RUN sees', (component, arg, consumer) => {
    expect(effectiveDockerArgBeforeFinalRun(dockerfile, arg, consumer)).toBe(readVersionPin(component));
  });

  it('claude-agent-sdk equals container/agent-runner/package.json', () => {
    expect(runnerPkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(readVersionPin('claude-agent-sdk'));
  });
});
