import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applySkill } from './skill-apply.js';
import {
  PROVIDER_PAYLOAD_FILES,
  type MemoryConformantProvider,
  compareProviderPayloadBytes,
  installProviderMemoryPayload,
  runProviderMemoryContractCli,
  validateProviderMemoryPayload,
} from './provider-memory-contract.js';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function treeSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) walk(absolute);
      else snapshot[relative] = fs.readFileSync(absolute).toString('base64');
    }
  };
  walk(root);
  return snapshot;
}

function conformantFixture(provider: MemoryConformantProvider): Map<string, string> {
  const fixture = new Map(PROVIDER_PAYLOAD_FILES[provider].map((file) => [file, '// provider payload\n']));
  fixture.set(
    `container/agent-runner/src/providers/${provider}.ts`,
    [
      "import { memoryContextForSessionStart } from '../memory/session-hook.js';",
      'class Provider {',
      '  registerMemorySessionHook() {}',
      '  run(input: { systemContext?: { instructions?: string } }) {',
      "    const guidance = memoryContextForSessionStart('startup');",
      '    return [input.systemContext?.instructions, guidance];',
      '  }',
      '}',
    ].join('\n'),
  );
  if (provider === 'codex') {
    fixture.set(
      'container/agent-runner/src/providers/codex-app-server.ts',
      [
        'interface StartParams { baseInstructions?: string }',
        "const overrides = ['memories.generate_memories=false', 'memories.use_memories=false'];",
      ].join('\n'),
    );
    fixture.set(
      'container/agent-runner/src/providers/codex-app-server.test.ts',
      "expect(args).toContain('memories.generate_memories=false');\nexpect(args).toContain('memories.use_memories=false');\n",
    );
  } else {
    fixture.set(
      '.claude/skills/add-opencode/SKILL.md',
      [
        'pnpm exec tsx scripts/provider-memory-contract.ts --provider opencode --ref "$remote/providers" --install',
        "OPENCODE_VERSION=$(sed -nE 's/^ARG OPENCODE_VERSION=([0-9]+\\.[0-9]+\\.[0-9]+)$/\\1/p' container/Dockerfile)",
        'cd container/agent-runner && bun add @opencode-ai/sdk@"${OPENCODE_VERSION}" && cd -',
        'ncl groups config update --id <group-id> --provider opencode',
        'The installer fails closed before the first write for a possible local customization.',
      ].join('\n'),
    );
  }
  return fixture;
}

describe('provider registry memory conformance', () => {
  for (const provider of ['codex', 'opencode'] as const) {
    it(`accepts a conformant ${provider} payload`, () => {
      const fixture = conformantFixture(provider);
      expect(
        validateProviderMemoryPayload(provider, (file) => fixture.get(file), { requirePayloadRoster: true }),
      ).toEqual([]);
    });

    it(`rejects a stale ${provider} payload before it can be copied`, () => {
      const fixture = conformantFixture(provider);
      fixture.set(
        `container/agent-runner/src/providers/${provider}.ts`,
        "import { readMemoryContext } from '../memory/context.js';\nconst memory = '/workspace/agent/memory';\n",
      );
      const issues = validateProviderMemoryPayload(provider, (file) => fixture.get(file), {
        requirePayloadRoster: true,
      });
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining('shared trusted-static lifecycle import'),
          expect.stringContaining('startup lifecycle guidance'),
          expect.stringContaining('provider lifecycle registration seam'),
          expect.stringContaining('host-provided system context consumption'),
          expect.stringContaining('direct canonical-memory read'),
        ]),
      );
    });
  }

  it('rejects an incomplete Codex branch payload with every missing path named', () => {
    const issues = validateProviderMemoryPayload('codex', () => undefined, { requirePayloadRoster: true });
    for (const file of PROVIDER_PAYLOAD_FILES.codex) {
      expect(issues).toContain(`${file}: missing from provider payload`);
    }
  });

  it('keeps superseded upstream-only Codex tests outside the customization-first install roster', () => {
    expect(PROVIDER_PAYLOAD_FILES.codex).not.toContain('container/agent-runner/src/providers/codex.turns.test.ts');
    expect(PROVIDER_PAYLOAD_FILES.codex).not.toContain('container/agent-runner/src/providers/codex-cli-tools.test.ts');
    expect(PROVIDER_PAYLOAD_FILES.codex).not.toContain('src/providers/codex-host-contribution.test.ts');
  });

  it('keeps both OpenCode registration guards inside the provider payload roster', () => {
    expect(PROVIDER_PAYLOAD_FILES.opencode).toEqual(
      expect.arrayContaining([
        'src/providers/opencode-registration.test.ts',
        'container/agent-runner/src/providers/opencode-registration.test.ts',
      ]),
    );
  });

  it('requires both Codex opaque-memory disable overrides and their regression tests', () => {
    const fixture = conformantFixture('codex');
    fixture.set(
      'container/agent-runner/src/providers/codex-app-server.ts',
      'interface StartParams { baseInstructions?: string }\n',
    );
    fixture.set('container/agent-runner/src/providers/codex-app-server.test.ts', '// no memory assertions\n');
    const issues = validateProviderMemoryPayload('codex', (file) => fixture.get(file));
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('memory-generation disable override'),
        expect.stringContaining('memory-retrieval disable override'),
        expect.stringContaining('test for disabled Codex memory generation'),
        expect.stringContaining('test for disabled Codex memory retrieval'),
      ]),
    );
  });

  it('the composed-tree roster gate rejects one missing copied file', () => {
    const fixture = conformantFixture('opencode');
    fixture.delete('src/providers/opencode-registration.test.ts');
    expect(
      validateProviderMemoryPayload('opencode', (file) => fixture.get(file), { requirePayloadRoster: true }),
    ).toContain('src/providers/opencode-registration.test.ts: missing from provider payload');
  });

  it('rejects a stale customization-destructive OpenCode operator skill in the fetched branch', () => {
    const fixture = conformantFixture('opencode');
    fixture.set(
      '.claude/skills/add-opencode/SKILL.md',
      [
        'Set AGENT_PROVIDER=opencode.',
        'If installed, skip to **Configuration**.',
        'git show origin/providers:src/providers/opencode.ts > src/providers/opencode.ts',
        "User edits to these files won't survive a re-run.",
        'bun add @opencode-ai/sdk@1.4.17',
      ].join('\n'),
    );

    expect(validateProviderMemoryPayload('opencode', (file) => fixture.get(file))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('create-only fetched-ref installer'),
        expect.stringContaining('Dockerfile-derived OpenCode SDK pin'),
        expect.stringContaining('container-config provider selection'),
        expect.stringContaining('customization-preserving fail-closed contract'),
        expect.stringContaining('retired AGENT_PROVIDER configuration'),
        expect.stringContaining('wholesale provider overwrite'),
        expect.stringContaining('customization-destructive reapply'),
        expect.stringContaining('stale OpenCode version pin'),
        expect.stringContaining('installed-state gate bypass'),
      ]),
    );
  });

  it('the exact-ref parity gate rejects an older tree that is still semantically conformant', () => {
    const fetched = conformantFixture('codex');
    const rolledBack = new Map(fetched);
    rolledBack.set('src/providers/codex.ts', '// older but otherwise unrelated host provider\n');
    expect(
      compareProviderPayloadBytes(
        'codex',
        (file) => fetched.get(file),
        (file) => rolledBack.get(file),
      ),
    ).toContain('src/providers/codex.ts: composed bytes differ from fetched provider payload');
  });

  it('describes a composed-tree failure without claiming that no copy occurred', () => {
    const projectRoot = tempRoot('provider-memory-cli-wording-');
    const messages: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => void messages.push(String(message));
    try {
      expect(runProviderMemoryContractCli(['--provider', 'opencode', '--root', projectRoot, '--require-payload'])).toBe(
        1,
      );
    } finally {
      console.error = original;
    }
    expect(messages.join('\n')).toContain('The composed provider tree is not conformant');
    expect(messages.join('\n')).not.toContain('No provider files were copied');
  });

  it('the create-only OpenCode installer preserves prior bytes and retains publications after failure', () => {
    const projectRoot = tempRoot('provider-memory-retention-');
    const fixture = conformantFixture('opencode');
    for (const [index, relativePath] of PROVIDER_PAYLOAD_FILES.opencode.entries()) {
      if (index === 1) continue;
      const target = path.join(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fixture.get(relativePath)!);
    }
    fs.writeFileSync(path.join(projectRoot, 'unrelated.txt'), 'also-customized\n');
    const before = treeSnapshot(projectRoot);

    expect(() =>
      installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot, {
        afterWrite: (_file, index) => {
          if (index === 3) throw new Error('simulated disk failure');
        },
      }),
    ).toThrow('simulated disk failure');
    const after = treeSnapshot(projectRoot);
    expect(after).toMatchObject(before);
    expect(after[PROVIDER_PAYLOAD_FILES.opencode[1]]).toBe(
      Buffer.from(fixture.get(PROVIDER_PAYLOAD_FILES.opencode[1])!).toString('base64'),
    );
  });

  it('the create-only Codex installer preserves prior bytes and retains publications after failure', () => {
    const projectRoot = tempRoot('provider-memory-codex-retention-');
    const fixture = conformantFixture('codex');
    for (const [index, relativePath] of PROVIDER_PAYLOAD_FILES.codex.entries()) {
      if (index === 2) continue;
      const target = path.join(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fixture.get(relativePath)!);
    }
    fs.writeFileSync(path.join(projectRoot, 'unrelated.txt'), 'also-customized\n');
    const before = treeSnapshot(projectRoot);

    expect(() =>
      installProviderMemoryPayload('codex', (file) => fixture.get(file), projectRoot, {
        afterWrite: (_file, index) => {
          if (index === 7) throw new Error('simulated Codex disk failure');
        },
      }),
    ).toThrow('simulated Codex disk failure');
    const after = treeSnapshot(projectRoot);
    expect(after).toMatchObject(before);
    expect(after[PROVIDER_PAYLOAD_FILES.codex[2]]).toBe(
      Buffer.from(fixture.get(PROVIDER_PAYLOAD_FILES.codex[2])!).toString('base64'),
    );
  });

  it('refuses to overwrite a differing provider-owned file before any write', () => {
    const projectRoot = tempRoot('provider-memory-customization-');
    const fixture = conformantFixture('opencode');
    const customized = PROVIDER_PAYLOAD_FILES.opencode[2];
    const target = path.join(projectRoot, customized);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// operator customization\n');
    fs.writeFileSync(path.join(projectRoot, 'unrelated.txt'), 'must survive\n');
    const before = treeSnapshot(projectRoot);

    expect(() => installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot)).toThrow(
      'refusing to overwrite possible customization',
    );
    expect(treeSnapshot(projectRoot)).toEqual(before);
    for (const relativePath of PROVIDER_PAYLOAD_FILES.opencode) {
      if (relativePath !== customized) expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  it('preserves a customization created after preflight instead of replacing it', () => {
    const projectRoot = tempRoot('provider-memory-concurrent-customization-');
    const fixture = conformantFixture('opencode');
    const racedPath = PROVIDER_PAYLOAD_FILES.opencode[1];

    expect(() =>
      installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot, {
        afterWrite: (_file, index) => {
          if (index !== 0) return;
          const target = path.join(projectRoot, racedPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, '// customization created during install\n');
        },
      }),
    ).toThrow();

    expect(fs.readFileSync(path.join(projectRoot, racedPath), 'utf8')).toBe(
      '// customization created during install\n',
    );
    expect(fs.readFileSync(path.join(projectRoot, PROVIDER_PAYLOAD_FILES.opencode[0]), 'utf8')).toBe(
      fixture.get(PROVIDER_PAYLOAD_FILES.opencode[0]),
    );
    for (const relativePath of PROVIDER_PAYLOAD_FILES.opencode.slice(2)) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  it('never deletes a published path that is customized before a later install failure', () => {
    const projectRoot = tempRoot('provider-memory-published-customization-');
    const fixture = conformantFixture('opencode');
    const publishedPath = PROVIDER_PAYLOAD_FILES.opencode[0];

    expect(() =>
      installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot, {
        afterWrite: (_file, index) => {
          if (index !== 0) return;
          fs.writeFileSync(path.join(projectRoot, publishedPath), '// customization after publication\n');
          throw new Error('simulated later failure');
        },
      }),
    ).toThrow('Create-only retention policy kept every path');

    expect(fs.readFileSync(path.join(projectRoot, publishedPath), 'utf8')).toBe('// customization after publication\n');
  });

  it('the create-only OpenCode installer rejects stale content before writing', () => {
    const projectRoot = tempRoot('provider-memory-stale-');
    fs.writeFileSync(path.join(projectRoot, 'customization.txt'), 'must survive\n');
    const before = treeSnapshot(projectRoot);

    expect(() => installProviderMemoryPayload('opencode', () => '// stale but present\n', projectRoot)).toThrow(
      'shared trusted-static lifecycle import',
    );
    expect(treeSnapshot(projectRoot)).toEqual(before);
  });

  it('the create-only installer rejects an existing symlink before writing and preserves its type and target', () => {
    const projectRoot = tempRoot('provider-memory-symlink-');
    const externalRoot = tempRoot('provider-memory-symlink-external-');
    const fixture = conformantFixture('opencode');
    const relativePath = PROVIDER_PAYLOAD_FILES.opencode[0];
    const target = path.join(projectRoot, relativePath);
    const external = path.join(externalRoot, 'custom-provider.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(external, 'external-customization\n');
    fs.symlinkSync(external, target);

    expect(() => installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot)).toThrow(
      'existing target is not a regular file',
    );
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(external);
    expect(fs.readFileSync(external, 'utf8')).toBe('external-customization\n');
    for (const other of PROVIDER_PAYLOAD_FILES.opencode.slice(1)) {
      expect(fs.existsSync(path.join(projectRoot, other))).toBe(false);
    }
  });

  it('rejects a symlinked parent before publishing any provider payload outside the project root', () => {
    const projectRoot = tempRoot('provider-memory-parent-symlink-');
    const externalRoot = tempRoot('provider-memory-parent-symlink-external-');
    const fixture = conformantFixture('opencode');
    fs.symlinkSync(externalRoot, path.join(projectRoot, 'src'));

    expect(() => installProviderMemoryPayload('opencode', (file) => fixture.get(file), projectRoot)).toThrow(
      /symlinked parent/i,
    );
    expect(fs.readdirSync(externalRoot)).toEqual([]);
    for (const relativePath of PROVIDER_PAYLOAD_FILES.opencode) {
      expect(fs.existsSync(path.join(projectRoot, relativePath))).toBe(false);
    }
  });

  it('the real add-codex apply leaves a customized tree byte-identical when the branch preflight fails', async () => {
    const projectRoot = tempRoot('provider-memory-skill-');
    for (const dir of ['src/providers', 'container/agent-runner/src/providers', 'setup/providers', 'container']) {
      fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(projectRoot, 'src/providers/index.ts'), '// customized host barrel\n');
    fs.writeFileSync(
      path.join(projectRoot, 'container/agent-runner/src/providers/index.ts'),
      '// customized container barrel\n',
    );
    fs.writeFileSync(path.join(projectRoot, 'setup/providers/index.ts'), '// customized setup barrel\n');
    fs.writeFileSync(path.join(projectRoot, 'container/cli-tools.json'), '[{"name":"custom","version":"1.0.0"}]\n');
    fs.writeFileSync(path.join(projectRoot, 'customization.txt'), 'must survive\n');
    const before = treeSnapshot(projectRoot);
    const commands: string[] = [];

    const result = await applySkill(path.join(process.cwd(), '.claude/skills/add-codex'), projectRoot, {
      inputs: {},
      resolveRemote: () => 'origin',
      exec: (command) => {
        commands.push(command);
        if (command.includes('provider-memory-contract.ts') && command.includes('--ref')) {
          throw new Error('stale providers branch');
        }
      },
    });

    expect(commands.some((command) => command.includes('git fetch'))).toBe(true);
    expect(commands.some((command) => command.includes('git show'))).toBe(false);
    expect(result.agentTasks).toHaveLength(1);
    expect(result.journal.filter((entry) => entry.op !== 'ran')).toEqual([]);
    expect(treeSnapshot(projectRoot)).toEqual(before);
  });

  it('add-codex preserves this fork Dockerfile pin convention', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), '.claude/skills/add-codex/SKILL.md'), 'utf8');
    const removal = fs.readFileSync(path.join(process.cwd(), '.claude/skills/add-codex/REMOVE.md'), 'utf8');

    expect(skill).toContain('CODEX_VERSION=$(sed -nE');
    expect(skill).toContain('"@openai/codex@${CODEX_VERSION}"');
    expect(skill).not.toContain('nc:json-merge into:container/cli-tools.json');
    expect(skill).not.toContain('{ "name": "@openai/codex"');
    expect(removal).toContain('Retain the install-wide Codex CLI');
    expect(removal).not.toContain('filter((t) => t.name !== "@openai/codex")');
  });

  it('add-opencode validates the fetched ref before its first redirect and the composed roster before integration', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), '.claude/skills/add-opencode/SKILL.md'), 'utf8');
    const install = skill.indexOf(
      'provider-memory-contract.ts --provider opencode --ref "$remote/providers" --install',
    );
    const postCopy = skill.indexOf('provider-memory-contract.ts --provider opencode --require-payload');
    const firstIntegration = skill.indexOf("import './opencode.js';", postCopy);
    const installFenceStart = skill.lastIndexOf('```bash', install);
    const installFence = skill.slice(installFenceStart, skill.indexOf('```', install));

    expect(install).toBeGreaterThan(-1);
    expect(postCopy).toBeGreaterThan(install);
    expect(firstIntegration).toBeGreaterThan(postCopy);
    expect(installFence).toContain('set -euo pipefail');
    expect(installFence).toContain('remote=$(resolve_channels_remote)');
    expect(skill).not.toContain('git show origin/providers:');
    expect(skill).not.toContain('PROVIDERS_REMOTE');
    expect(skill).not.toMatch(/skip to \*\*Configuration\*\*/);
    expect(skill).not.toContain('data/v2-sessions/*/agent-runner-src');
    expect(skill).toContain('ncl groups config update --id <group-id> --provider opencode');
    expect(skill).toContain('ncl groups restart --id <group-id>');
    expect(skill).toMatch(/fails\s+closed before the first write/i);
    expect(skill).toMatch(/possible local\s+customization/i);
  });

  it('add-codex treats provider reapply differences as customizations, not overwrite permission', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), '.claude/skills/add-codex/SKILL.md'), 'utf8');
    expect(skill).toMatch(/fails\s+closed before the first write/i);
    expect(skill).toMatch(/local customization/i);
    expect(skill).toMatch(/full-merge customization audit/i);
    expect(skill).not.toContain('overwrite each provider-owned file');
  });

  it('add-opencode removal never mutates retired per-group source overlays', () => {
    const removal = fs.readFileSync(path.join(process.cwd(), '.claude/skills/add-opencode/REMOVE.md'), 'utf8');

    expect(removal).not.toContain('data/v2-sessions/*/agent-runner-src');
    expect(removal).toContain('ncl groups config update --id <group-id> --provider claude');
    expect(removal).toContain('ncl groups restart --id <group-id>');
    expect(removal).not.toContain('set `"provider": "claude"` in `groups/<folder>/container.json`');
  });
});
