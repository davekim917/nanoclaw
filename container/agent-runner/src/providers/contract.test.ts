import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { declaredContractNames, providerContract } from './contract.js';
import './index.js';
import './mock.js';
import { listProviderNames } from './provider-registry.js';

describe('provider contracts', () => {
  it('every registered provider declares a contract, and nothing else does', () => {
    expect([...declaredContractNames()].sort()).toEqual([...listProviderNames()].sort());
  });

  it('an undeclared provider fails loudly', () => {
    expect(() => providerContract('bogus')).toThrow(/No provider contract/);
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
          if (/[=!]==?\s*['"](claude|codex|opencode)['"]/.test(line)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
