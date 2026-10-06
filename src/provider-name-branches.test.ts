import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Provider-specific behaviour on the host is declared where the provider is (`src/providers/`), not compared
 * by name elsewhere. The agent runner enforces zero (`container/agent-runner/src/providers/contract.test.ts`);
 * the host pins today's count per file so it can only fall. Lower a number when a comparison moves behind a
 * declaration; never raise one.
 */
const PINNED: Record<string, number> = {
  'src/claude-md-compose.ts': 3,
  'src/codex-accounts.ts': 1,
  'src/container-runner.ts': 7,
  'src/daily-summary.ts': 1,
  'src/db/container-configs.ts': 1,
  'src/db/usage-trust.ts': 2,
  'src/flag-parser.ts': 2,
  'src/modules/channel-config/index.ts': 1,
  'src/modules/self-mod/apply.ts': 1,
  'src/onecli-secrets.ts': 1,
  'src/plugin-skill-discovery.ts': 5,
  'src/repository-discovery.ts': 1,
  'src/wiki-admission/runtime.ts': 2,
};

const PROVIDER_NAME_COMPARISON =
  /[=!]==?\s*['"](claude|codex|opencode)['"]|['"](claude|codex|opencode)['"]\s*[=!]==?|case\s+['"](claude|codex|opencode)['"]/g;

function countBranches(root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === path.join(root, 'src', 'providers')) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const hits = fs.readFileSync(full, 'utf-8').match(PROVIDER_NAME_COMPARISON)?.length ?? 0;
      if (hits > 0) counts[path.relative(root, full)] = hits;
    }
  };
  walk(path.join(root, 'src'));
  return counts;
}

describe('provider-name branches outside src/providers/', () => {
  it('never grow past the pinned count per file', () => {
    expect(countBranches(path.resolve(import.meta.dirname, '..'))).toEqual(PINNED);
  });
});
