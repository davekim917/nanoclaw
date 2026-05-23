import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 038 — provider-models-go-seed-fix
 *
 * Corrects the OpenCode seed shipped in migration 037, which I (the original
 * author of 037) had populated from training-data guesses rather than the
 * authoritative `/zen/go/v1/models` endpoint. Concretely:
 *
 *   - 037 seeded `opencode/kimi-k2.6-thinking` — that slug DOESN'T EXIST in
 *     either Go or Zen catalogs. Fabricated.
 *   - 037 seeded `opencode/gemini-3.5-flash` — exists in Zen credit, NOT in
 *     Go subscription. Wrong tier.
 *   - 037 seeded `opencode/deepseek-v4-flash-free` — `-free` tier slugs are
 *     a Zen-only tier. Go has plain `deepseek-v4-flash` (no `-free` suffix).
 *
 * Authoritative source consulted (curl https://opencode.ai/zen/go/v1/models):
 *   minimax-m2.7, minimax-m2.5, kimi-k2.6, kimi-k2.5, glm-5.1, glm-5,
 *   deepseek-v4-pro, deepseek-v4-flash, qwen3.6-plus, qwen3.5-plus,
 *   mimo-v2-pro, mimo-v2-omni, mimo-v2.5-pro, mimo-v2.5, hy3-preview
 *
 * Convention: OpenCode CLI uses the `opencode/<id>` prefix when selecting
 * a model (env OPENCODE_MODEL_X=opencode/kimi-k2.6 works); the Zen API
 * surface uses unprefixed ids. We store the prefixed form because that's
 * what `container_configs.model` carries and what the OpenCode runtime
 * accepts via env. Operators querying the API directly would drop the prefix.
 */
export const migration038: Migration = {
  version: 38,
  name: 'provider-models-go-seed-fix',
  up(db: Database.Database) {
    // ── 1. Remove the bogus 037 rows ─────────────────────────────────────────
    db.prepare(
      `DELETE FROM provider_models WHERE provider = 'opencode' AND slug IN (
         'opencode/kimi-k2.6-thinking',
         'opencode/gemini-3.5-flash',
         'opencode/deepseek-v4-flash-free'
       )`,
    ).run();

    // ── 2. Insert the actual Go set, default unchanged (kimi-k2.6) ──────────
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO provider_models
        (provider, slug, display_name, notes, default_effort, supports_effort, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Go-included models. is_default left at 0 — the existing kimi-k2.6 row
    // from 037 keeps is_default=1 (already correct). Order here is roughly
    // "what coding-agent operator would pick first": flagship → second-tier.
    const goSeed: Array<[string, string, string, 'low' | 'medium' | 'high' | null, 0 | 1]> = [
      // [slug, display_name, notes, default_effort, supports_effort]
      // (kimi-k2.6 stays the default from 037 — not re-inserted)
      ['opencode/kimi-k2.5', 'Kimi K2.5', 'Moonshot — previous-gen K2 series. Available on Go.', 'high', 1],
      ['opencode/glm-5', 'GLM 5', 'Zhipu — older GLM. Available on Go.', 'high', 1],
      [
        'opencode/deepseek-v4-pro',
        'DeepSeek V4 Pro',
        'DeepSeek — strongest of the V4 line. Available on Go.',
        'high',
        1,
      ],
      ['opencode/deepseek-v4-flash', 'DeepSeek V4 Flash', 'DeepSeek — fast tier. Available on Go.', 'high', 1],
      ['opencode/qwen3.6-plus', 'Qwen 3.6 Plus', 'Alibaba — flagship Qwen. Available on Go.', 'high', 1],
      ['opencode/qwen3.5-plus', 'Qwen 3.5 Plus', 'Alibaba — previous-gen Qwen. Available on Go.', 'high', 1],
      ['opencode/minimax-m2.7', 'MiniMax M2.7', 'MiniMax — flagship. Available on Go.', 'high', 1],
      ['opencode/minimax-m2.5', 'MiniMax M2.5', 'MiniMax — previous-gen. Available on Go.', 'high', 1],
      ['opencode/mimo-v2-pro', 'MiMo V2 Pro', 'Xiaomi MiMo — strongest. Available on Go.', 'high', 1],
      ['opencode/mimo-v2-omni', 'MiMo V2 Omni', 'Xiaomi MiMo — multimodal. Available on Go.', 'high', 1],
      ['opencode/mimo-v2.5-pro', 'MiMo V2.5 Pro', 'Xiaomi MiMo — newer pro tier. Available on Go.', 'high', 1],
      ['opencode/mimo-v2.5', 'MiMo V2.5', 'Xiaomi MiMo — newer base tier. Available on Go.', 'high', 1],
      ['opencode/hy3-preview', 'HY3 (preview)', 'Preview model. Available on Go.', 'high', 1],
    ];

    for (const [slug, name, notes, effort, supports] of goSeed) {
      insert.run('opencode', slug, name, notes, effort, supports, 0, now);
    }
  },
};
