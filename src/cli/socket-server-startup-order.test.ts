import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

function at(fragment: string): number {
  const index = main.indexOf(fragment);
  expect(index, `src/main.ts must contain ${fragment}`).toBeGreaterThan(-1);
  return index;
}

describe('host ownership startup order', () => {
  it('claims the kernel lock before any shared startup mutation or central DB initialization', () => {
    const ownership = at('await startCliServer()');

    expect(ownership).toBeLessThan(at('await enforceStartupBackoff()'));
    expect(ownership).toBeLessThan(at('await initDb(dbPath)'));
    expect(ownership).toBeLessThan(at('runMigrations(db)'));
  });

  it('keeps ownership through shutdown teardown until process exit', () => {
    const stop = at('await stopCliServer({ retainOwnership: true })');

    expect(stop).toBeLessThan(at('await teardownChannelAdapters()'));
    expect(stop).toBeLessThan(at('await stopHostInstanceLease()'));
    expect(stop).toBeLessThan(at('process.exit(0)'));
  });
});
