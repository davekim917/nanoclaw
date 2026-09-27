import { resolveEffectiveModel } from '../flag-parser.js';
import { getDb } from './connection.js';

/**
 * Operator blocklist of (provider, slug) pairs, filtering the live model set the container reports: a denied model is
 * never offered, and `change_model` / `ncl groups config update --model` reject it with the recorded reason. Single
 * statements only, so none needs `centralTransaction`.
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
 * Matches the model as typed, lowercased (family names resolve case-insensitively), and as resolved, so a family name
 * is refused when its current target is denied. Checked at write only: a later bump that moves a family onto a denied
 * id is not caught.
 */
export async function getDenialFor(provider: string, model: string): Promise<DeniedModel | undefined> {
  for (const candidate of new Set([model, model.toLowerCase(), resolveEffectiveModel(model)])) {
    const row = await getDeniedModel(provider, candidate);
    if (row) return row;
  }
  return undefined;
}

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
