/**
 * The operator blocklist, on the async driver (seam 3 PR 5d).
 *
 * This leaf had no test file before the conversion, and no caller's suite
 * exercises its SQL — `cli/resources/denied-models.ts`, `cli/resources/groups.ts`
 * and `modules/self-mod/apply.ts` all mock it. Converting the four statements
 * from `db.prepare(...).all/get/run` to `getDb().all/get/run` changes how the
 * POSITIONAL parameters reach better-sqlite3 (the driver spreads them), and the
 * `listDeniedModels` branch means one export binds a different number of them
 * per call. A dropped binding there would silently make the blocklist read
 * empty, which fails OPEN — the operator's "no" stops being enforced — so both
 * branches and every ordering are pinned here.
 *
 * Schema comes from migration 039 itself rather than a restated CREATE TABLE,
 * so the fixture cannot drift from the live one.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addDeniedModel,
  getDenialFor,
  getDeniedModel,
  isDeniedModel,
  listDeniedModels,
  removeDeniedModel,
} from './denied-models.js';
import { CODEX_FAMILY_DEFAULTS, DEFAULT_FABLE_MODEL } from '../flag-parser.js';
import { closeDb, getDb, initTestDb } from './index.js';
import { migration039 } from './migrations/039-denied-models.js';

/** Migration 039's `up` only ever calls `exec`, so a recorder captures its exact DDL. */
function migration039Ddl(): string {
  const statements: string[] = [];
  migration039.up({ exec: (sql: string) => statements.push(sql) } as unknown as Database.Database);
  return statements.join('\n');
}

describe('the denied-models blocklist on the async driver', () => {
  beforeEach(async () => {
    await initTestDb();
    await getDb().exec(migration039Ddl());
  });
  afterEach(() => closeDb());

  it('records a denial with its reason and reads it back by (provider, slug)', async () => {
    await addDeniedModel('opencode', 'some-model', 'too expensive');

    const row = await getDeniedModel('opencode', 'some-model');
    expect(row).toMatchObject({ provider: 'opencode', slug: 'some-model', reason: 'too expensive' });
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('accepts a null reason and still denies', async () => {
    await addDeniedModel('claude', 'some-model', null);

    expect(await getDeniedModel('claude', 'some-model')).toMatchObject({ reason: null });
    expect(await isDeniedModel('claude', 'some-model')).toBe(true);
  });

  it('getDenialFor refuses a family name whose current target is denied', async () => {
    await addDeniedModel('codex', CODEX_FAMILY_DEFAULTS.sol, 'no sol');
    await addDeniedModel('claude', DEFAULT_FABLE_MODEL, 'no fable');

    expect(await getDenialFor('codex', 'sol')).toMatchObject({ reason: 'no sol' });
    expect(await getDenialFor('claude', 'fable')).toMatchObject({ reason: 'no fable' });
    expect(await getDenialFor('codex', CODEX_FAMILY_DEFAULTS.sol)).toMatchObject({ reason: 'no sol' });
    expect(await getDenialFor('codex', 'luna')).toBeUndefined();
    // A literal denial of the family word itself still holds.
    await addDeniedModel('codex', 'astra', 'no astra word');
    expect(await getDenialFor('codex', 'astra')).toMatchObject({ reason: 'no astra word' });
    expect(await getDenialFor('codex', 'ASTRA')).toMatchObject({ reason: 'no astra word' });
    expect(await getDenialFor('codex', 'SOL')).toMatchObject({ reason: 'no sol' });
  });

  it('is a miss, not an error, for a pair that was never denied', async () => {
    expect(await getDeniedModel('claude', 'never-denied')).toBeUndefined();
    expect(await isDeniedModel('claude', 'never-denied')).toBe(false);
  });

  it('keys on BOTH columns — the same slug under another provider is not denied', async () => {
    await addDeniedModel('opencode', 'shared-slug', 'no');

    expect(await isDeniedModel('opencode', 'shared-slug')).toBe(true);
    expect(await isDeniedModel('claude', 'shared-slug')).toBe(false);
  });

  it('lists every denial provider-then-slug ordered when no provider is given', async () => {
    await addDeniedModel('opencode', 'b-model', null);
    await addDeniedModel('claude', 'z-model', null);
    await addDeniedModel('opencode', 'a-model', null);

    expect((await listDeniedModels()).map((r) => `${r.provider}/${r.slug}`)).toEqual([
      'claude/z-model',
      'opencode/a-model',
      'opencode/b-model',
    ]);
  });

  it('lists one provider slug-ordered when a provider is given', async () => {
    await addDeniedModel('opencode', 'b-model', null);
    await addDeniedModel('claude', 'z-model', null);
    await addDeniedModel('opencode', 'a-model', null);

    expect((await listDeniedModels('opencode')).map((r) => r.slug)).toEqual(['a-model', 'b-model']);
    expect(await listDeniedModels('nobody')).toEqual([]);
  });

  it('removes only the named pair', async () => {
    await addDeniedModel('opencode', 'a-model', null);
    await addDeniedModel('opencode', 'b-model', null);

    await removeDeniedModel('opencode', 'a-model');

    expect((await listDeniedModels('opencode')).map((r) => r.slug)).toEqual(['b-model']);
    // Idempotent: removing an absent pair is a no-op, not a throw.
    await expect(removeDeniedModel('opencode', 'a-model')).resolves.toBeUndefined();
  });
});
