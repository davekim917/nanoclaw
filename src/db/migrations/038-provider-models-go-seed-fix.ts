import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Corrects 037's OpenCode seed against the authoritative `/zen/go/v1/models` list (one slug did not exist, two were
 * Zen-only). Slugs keep the `opencode/` prefix because that is what `container_configs.model` and the runtime env
 * carry.
 */
export const migration038: Migration = {
  version: 38,
  name: 'provider-models-go-seed-fix',
  up(db: Database.Database) {
    db.prepare(
      `DELETE FROM provider_models WHERE provider = 'opencode' AND slug IN (
         'opencode/kimi-k2.6-thinking',
         'opencode/gemini-3.5-flash',
         'opencode/deepseek-v4-flash-free'
       )`,
    ).run();

    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO provider_models
        (provider, slug, display_name, notes, default_effort, supports_effort, is_default, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // kimi-k2.6 keeps is_default=1 from 037 and is not re-inserted.
    const goSeed: Array<[string, string, string, 'low' | 'medium' | 'high' | null, 0 | 1]> = [
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
