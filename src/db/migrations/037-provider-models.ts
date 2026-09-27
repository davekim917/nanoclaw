import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/** `provider_models`: a per-provider allowlist of model slugs, replaced by the `denied_models` blocklist in 039. */
export const migration037: Migration = {
  version: 37,
  name: 'provider-models',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_models (
        provider        TEXT NOT NULL,
        slug            TEXT NOT NULL,
        display_name    TEXT,
        notes           TEXT,
        default_effort  TEXT CHECK (default_effort IN ('low', 'medium', 'high') OR default_effort IS NULL),
        supports_effort INTEGER NOT NULL DEFAULT 0 CHECK (supports_effort IN (0, 1)),
        is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at      TEXT NOT NULL,
        PRIMARY KEY (provider, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider);

      -- Enforce: ≤1 default per provider. Partial unique index.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models_default
        ON provider_models(provider) WHERE is_default = 1;
    `);

    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO provider_models
        (provider, slug, display_name, notes, default_effort, supports_effort, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const opencodeSeed: Array<[string, string, string, 'low' | 'medium' | 'high' | null, 0 | 1, 0 | 1]> = [
      [
        'opencode/kimi-k2.6',
        'Kimi K2.6',
        'Default. Moonshot — strongest agentic coding on Go subscription. Effort clamps to low|medium|high.',
        'high',
        1,
        1,
      ],
      [
        'opencode/kimi-k2.6-thinking',
        'Kimi K2.6 Thinking',
        'K2.6 with extended reasoning. Slower, deeper on hard problems.',
        'high',
        1,
        0,
      ],
      [
        'opencode/gemini-3.5-flash',
        'Gemini 3.5 Flash',
        'Google — fast + cheap. Good for high-throughput non-critical work.',
        'medium',
        1,
        0,
      ],
      [
        'opencode/deepseek-v4-flash-free',
        'DeepSeek V4 Flash (free)',
        'DeepSeek — free tier. Reasonable fallback when token budget matters.',
        'high',
        1,
        0,
      ],
      ['opencode/glm-5.1', 'GLM 5.1', 'Zhipu — solid general-purpose. Effort capped at high.', 'high', 1, 0],
    ];

    for (const [slug, name, notes, defaultEffort, supportsEffort, isDefault] of opencodeSeed) {
      insert.run('opencode', slug, name, notes, defaultEffort, supportsEffort, isDefault, now);
    }

    const codexSeed: Array<[string, string, string, 'low' | 'medium' | 'high' | null, 0 | 1, 0 | 1]> = [
      ['gpt-5.3-codex', 'GPT-5.3 Codex', 'Default. OpenAI — strongest Codex variant.', 'high', 1, 1],
      ['gpt-5.2-codex', 'GPT-5.2 Codex', 'Previous-gen Codex. Cheaper.', 'high', 1, 0],
      ['gpt-5.1-codex', 'GPT-5.1 Codex', 'Older Codex generation.', 'high', 1, 0],
    ];

    for (const [slug, name, notes, defaultEffort, supportsEffort, isDefault] of codexSeed) {
      insert.run('codex', slug, name, notes, defaultEffort, supportsEffort, isDefault, now);
    }

    const claudeSeed: Array<[string, string, string, 'low' | 'medium' | 'high' | null, 0 | 1, 0 | 1]> = [
      ['claude-opus-4-7', 'Claude Opus 4.7', 'Anthropic — current strongest.', null, 0, 1],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Anthropic — fast + capable.', null, 0, 0],
      ['claude-haiku-4-5', 'Claude Haiku 4.5', 'Anthropic — cheapest + fastest tier.', null, 0, 0],
    ];

    for (const [slug, name, notes, defaultEffort, supportsEffort, isDefault] of claudeSeed) {
      insert.run('claude', slug, name, notes, defaultEffort, supportsEffort, isDefault, now);
    }
  },
};
