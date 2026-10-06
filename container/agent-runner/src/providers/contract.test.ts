import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoverPortableSkills, type AgentRuntime } from '../plugin-skill-discovery.js';
import { declaredContractNames, providerContract } from './contract.js';
import './index.js';
import './mock.js';
import { listProviderNames } from './provider-registry.js';

describe('provider contracts', () => {
  it('every registered provider declares a contract, and nothing else does', () => {
    expect([...declaredContractNames()].sort()).toEqual([...listProviderNames()].sort());
  });

  it('matches names case-insensitively, like the provider factory', () => {
    expect(providerContract('Codex')).toBe(providerContract('codex'));
  });

  it('an undeclared provider fails loudly, including names an object prototype would answer', () => {
    for (const name of ['bogus', 'toString', 'constructor', '__proto__']) {
      expect(() => providerContract(name)).toThrow(/No provider contract/);
    }
  });

  it('core code outside providers/ compares no provider names', () => {
    const root = path.join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'providers' || entry.name === 'node_modules' || entry.name.startsWith('__')) continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const lines = fs.readFileSync(full, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          if (/[=!]==?\s*['"](claude|codex|opencode)['"]|['"](claude|codex|opencode)['"]\s*[=!]==?|case\s+['"](claude|codex|opencode)['"]/.test(line)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('skill delivery follows the contract', () => {
  let root: string;

  function writeSkill(dir: string, name: string, invocable: boolean): void {
    fs.mkdirSync(dir, { recursive: true });
    const flag = invocable ? '' : 'user-invocable: false\n';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n${flag}---\n\nbody\n`);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-skills-'));
    // `native`: a Claude manifest plus the Codex manifest that marks the plugin as loaded natively by Codex.
    fs.mkdirSync(path.join(root, 'native', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'native', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'native' }));
    fs.mkdirSync(path.join(root, 'native', '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'native', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'native' }));
    writeSkill(path.join(root, 'native', 'skills', 'visible'), 'visible', true);
    writeSkill(path.join(root, 'native', 'skills', 'helper'), 'helper', false);
    // `plain`: no Codex manifest, so every runtime mirrors it.
    fs.mkdirSync(path.join(root, 'plain', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plain', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plain' }));
    writeSkill(path.join(root, 'plain', 'skills', 'shared'), 'shared', true);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const names = (runtime: AgentRuntime): string[] =>
    discoverPortableSkills(root, { runtime })
      .map((s) => s.name)
      .sort();

  it('a runtime that loads plugins natively skips them in the mirror', () => {
    expect(providerContract('codex').skills.nativePluginLoading).toBe(true);
    expect(names('codex')).toEqual(['shared']);
    expect(names('claude')).toEqual(['shared', 'visible']);
  });

  it('only a runtime whose mirror is its sole delivery gets non-invocable helpers', () => {
    expect(providerContract('opencode').skills.mirrorIsSoleDelivery).toBe(true);
    expect(names('opencode')).toEqual(['helper', 'shared', 'visible']);
    expect(names('claude')).not.toContain('helper');
  });
});
