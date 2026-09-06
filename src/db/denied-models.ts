import { withCentralSync, withRawDb } from './central-lease.js';

/**
 * Operator-curated blocklist of forbidden (provider, slug) pairs.
 *
 * The agent's reachable model set comes from `opencode models` inside the
 * container (live, OpenCode-CLI-knows-everything). This table is the small
 * "operator says no" layer that filters that live set: anything in here is
 * never offered to the agent and `change_model` / `ncl groups config update
 * --model X` reject it with the recorded reason.
 *
 * Replaces the 037 allowlist (which was over-engineered) — see migration
 * 039 docstring for rationale.
 */
export interface DeniedModel {
  provider: string;
  slug: string;
  reason: string | null;
  created_at: string;
}

export function listDeniedModels(provider?: string): Promise<DeniedModel[]> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        if (provider) {
          return db
            .prepare('SELECT * FROM denied_models WHERE provider = ? ORDER BY slug ASC')
            .all(provider) as DeniedModel[];
        }
        return db.prepare('SELECT * FROM denied_models ORDER BY provider ASC, slug ASC').all() as DeniedModel[];
      }),
    'denied-models.listDeniedModels',
  );
}

export function getDeniedModel(provider: string, slug: string): Promise<DeniedModel | undefined> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        return db.prepare('SELECT * FROM denied_models WHERE provider = ? AND slug = ?').get(provider, slug) as
          | DeniedModel
          | undefined;
      }),
    'denied-models.getDeniedModel',
  );
}

/** True when (provider, slug) is in the blocklist. */
export async function isDeniedModel(provider: string, slug: string): Promise<boolean> {
  return (await getDeniedModel(provider, slug)) !== undefined;
}

export function addDeniedModel(provider: string, slug: string, reason: string | null): Promise<void> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare(
          `INSERT INTO denied_models (provider, slug, reason, created_at)
       VALUES (?, ?, ?, ?)`,
        ).run(provider, slug, reason, new Date().toISOString());
      }),
    'denied-models.addDeniedModel',
  );
}

export function removeDeniedModel(provider: string, slug: string): Promise<void> {
  return withCentralSync(
    () =>
      withRawDb((db) => {
        db.prepare('DELETE FROM denied_models WHERE provider = ? AND slug = ?').run(provider, slug);
      }),
    'denied-models.removeDeniedModel',
  );
}
