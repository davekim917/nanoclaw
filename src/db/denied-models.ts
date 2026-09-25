import { resolveEffectiveModel } from '../flag-parser.js';
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
 *
 * Seam 3 PR 5d: all four statements run on the async driver. Each is a single
 * statement, so none needs `centralTransaction` (plan §4.1, §4.4).
 */
export interface DeniedModel {
  provider: string;
  slug: string;
  reason: string | null;
  created_at: string;
}

export function listDeniedModels(provider?: string): Promise<DeniedModel[]> {
  if (provider) {
    return getDb().all<DeniedModel>('SELECT * FROM denied_models WHERE provider = ? ORDER BY slug ASC', provider);
  }
  return getDb().all<DeniedModel>('SELECT * FROM denied_models ORDER BY provider ASC, slug ASC');
}

export function getDeniedModel(provider: string, slug: string): Promise<DeniedModel | undefined> {
  return getDb().get<DeniedModel>('SELECT * FROM denied_models WHERE provider = ? AND slug = ?', provider, slug);
}

/**
 * The deny-list row that blocks setting `model` on `provider`, matching the
 * value as typed, its lowercase form (family names resolve case-insensitively,
 * so a denied `astra` must also refuse `ASTRA`), or the id it resolves to — so
 * a family name (`sol`, `opus`) is refused when its current target is denied. Checked at write only: a
 * later bump that moves a family onto a denied id is not caught here.
 */
export async function getDenialFor(provider: string, model: string): Promise<DeniedModel | undefined> {
  for (const candidate of new Set([model, model.toLowerCase(), resolveEffectiveModel(model)])) {
    const row = await getDeniedModel(provider, candidate);
    if (row) return row;
  }
  return undefined;
}

/** True when (provider, slug) is in the blocklist. */
export async function isDeniedModel(provider: string, slug: string): Promise<boolean> {
  return (await getDeniedModel(provider, slug)) !== undefined;
}

export async function addDeniedModel(provider: string, slug: string, reason: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO denied_models (provider, slug, reason, created_at)
       VALUES (?, ?, ?, ?)`,
    provider,
    slug,
    reason,
    new Date().toISOString(),
  );
}

export async function removeDeniedModel(provider: string, slug: string): Promise<void> {
  await getDb().run('DELETE FROM denied_models WHERE provider = ? AND slug = ?', provider, slug);
}
