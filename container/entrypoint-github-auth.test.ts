import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

/**
 * Gate for `entrypoint-github-auth.test.sh`. The shell test is the real one —
 * it lifts the GitHub credential block out of the shipped entrypoint and runs
 * it with bash — but nothing in this repo executes `*.test.sh`, so without this
 * wrapper it would only ever run when someone remembered to. `container/*.test.ts`
 * is in the vitest include list, so this puts it in `pnpm test` and CI.
 */
describe('container entrypoint GitHub credential wiring', () => {
  it('passes the bash suite (credential helper, gh shim, org scoping, legacy env fallback)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.join(here, 'entrypoint-github-auth.test.sh');
    let output: string;
    try {
      output = execFileSync('bash', [script], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`entrypoint-github-auth.test.sh failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
    }
    expect(output).toContain('PASS — container GitHub credential wiring');
  }, 60_000);
});
