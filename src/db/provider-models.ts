import { getDb } from './connection.js';

export interface ProviderModel {
  provider: string;
  slug: string;
  display_name: string | null;
  notes: string | null;
  default_effort: 'low' | 'medium' | 'high' | null;
  supports_effort: number;
  is_default: number;
  created_at: string;
}

export interface ProviderModelInput {
  provider: string;
  slug: string;
  display_name?: string | null;
  notes?: string | null;
  default_effort?: 'low' | 'medium' | 'high' | null;
  supports_effort?: boolean;
  is_default?: boolean;
}

/** All models for a provider, default-first then alphabetical. */
export function listProviderModels(provider?: string): ProviderModel[] {
  if (provider) {
    return getDb()
      .prepare('SELECT * FROM provider_models WHERE provider = ? ORDER BY is_default DESC, slug ASC')
      .all(provider) as ProviderModel[];
  }
  return getDb()
    .prepare('SELECT * FROM provider_models ORDER BY provider ASC, is_default DESC, slug ASC')
    .all() as ProviderModel[];
}

export function getProviderModel(provider: string, slug: string): ProviderModel | undefined {
  return getDb().prepare('SELECT * FROM provider_models WHERE provider = ? AND slug = ?').get(provider, slug) as
    | ProviderModel
    | undefined;
}

/** True when (provider, slug) exists in the allowlist. */
export function isAllowedModel(provider: string, slug: string): boolean {
  return getProviderModel(provider, slug) !== undefined;
}

export function addProviderModel(input: ProviderModelInput): void {
  const supportsEffort = input.supports_effort ? 1 : 0;
  const isDefault = input.is_default ? 1 : 0;
  const now = new Date().toISOString();

  const db = getDb();
  // If marking as default, clear any other default for this provider first.
  // Wrap in a transaction so we never end up with two defaults mid-flight.
  if (isDefault === 1) {
    db.transaction(() => {
      db.prepare('UPDATE provider_models SET is_default = 0 WHERE provider = ? AND is_default = 1').run(input.provider);
      db.prepare(
        `INSERT INTO provider_models
           (provider, slug, display_name, notes, default_effort, supports_effort, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.provider,
        input.slug,
        input.display_name ?? null,
        input.notes ?? null,
        input.default_effort ?? null,
        supportsEffort,
        1,
        now,
      );
    })();
    return;
  }
  db.prepare(
    `INSERT INTO provider_models
       (provider, slug, display_name, notes, default_effort, supports_effort, is_default, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.provider,
    input.slug,
    input.display_name ?? null,
    input.notes ?? null,
    input.default_effort ?? null,
    supportsEffort,
    0,
    now,
  );
}

export function removeProviderModel(provider: string, slug: string): void {
  getDb().prepare('DELETE FROM provider_models WHERE provider = ? AND slug = ?').run(provider, slug);
}
