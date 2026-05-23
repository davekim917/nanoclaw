import { getDb } from './connection.js';

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

export function listDeniedModels(provider?: string): DeniedModel[] {
  if (provider) {
    return getDb()
      .prepare('SELECT * FROM denied_models WHERE provider = ? ORDER BY slug ASC')
      .all(provider) as DeniedModel[];
  }
  return getDb().prepare('SELECT * FROM denied_models ORDER BY provider ASC, slug ASC').all() as DeniedModel[];
}

export function getDeniedModel(provider: string, slug: string): DeniedModel | undefined {
  return getDb().prepare('SELECT * FROM denied_models WHERE provider = ? AND slug = ?').get(provider, slug) as
    | DeniedModel
    | undefined;
}

/** True when (provider, slug) is in the blocklist. */
export function isDeniedModel(provider: string, slug: string): boolean {
  return getDeniedModel(provider, slug) !== undefined;
}

export function addDeniedModel(provider: string, slug: string, reason: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO denied_models (provider, slug, reason, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(provider, slug, reason, new Date().toISOString());
}

export function removeDeniedModel(provider: string, slug: string): void {
  getDb().prepare('DELETE FROM denied_models WHERE provider = ? AND slug = ?').run(provider, slug);
}
