import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 039 — denied-models
 *
 * Drops the `provider_models` allowlist created in 037 (and patched in 038)
 * and replaces it with a much smaller `denied_models` blocklist.
 *
 * Why the flip:
 *   - The allowlist was over-engineered. Empirically (talking with Operator),
 *     OpenCode itself already knows the set of reachable models given its
 *     auth.json + env-configured providers — `opencode models` enumerates
 *     them grouped by provider prefix (opencode-go/*, opencode/*, nvidia/*,
 *     etc.). Curating a parallel DB allowlist is duplicate bookkeeping that
 *     drifts from what OpenCode actually serves.
 *   - The legitimate operator concern is the opposite: "agent must never
 *     pick THIS specific slug" (e.g. `anthropic/claude-opus-4-7` to prevent
 *     a wrong-subscription bill). That's a blocklist, not an allowlist.
 *   - container/agent-runner's list_models MCP tool will now query
 *     `opencode models` directly inside the container and filter by this
 *     denylist, so the reachable set is always live + operator-curated
 *     forbids are the only DB-side knob.
 *
 * Schema (much smaller than 037's `provider_models`):
 *   provider   TEXT  — matches the container's agent_provider (opencode | codex | claude)
 *   slug       TEXT  — the runtime model identifier WITH prefix
 *                      (e.g. 'anthropic/claude-opus-4-7', 'opencode-go/kimi-k2.6').
 *                      Match is exact-string against the slug the container would set.
 *   reason     TEXT  — operator note shown in error messages when denied.
 *   created_at TEXT
 *   PRIMARY KEY (provider, slug)
 *
 * No seed data — operator adds explicit denials via `ncl denied-models add`
 * when they actually want to forbid something.
 */
export const migration039: Migration = {
  version: 39,
  name: 'denied-models',
  up(db: Database.Database) {
    // Drop the over-engineered allowlist table. Indexes go with it.
    db.exec(`DROP TABLE IF EXISTS provider_models;`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS denied_models (
        provider   TEXT NOT NULL,
        slug       TEXT NOT NULL,
        reason     TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_denied_models_provider ON denied_models(provider);
    `);
  },
};
