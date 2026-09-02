import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 063 — per-channel (messaging_group_agents) instructions profile.
 *
 * The second per-channel always-on layer, and deliberately NOT the tone one.
 * `default_tone` (migration 016) carries VOICE and only voice — a documented
 * invariant with exactly one slot (see container/agent-runner/src/index.ts).
 * Operating rules are a different axis: "in this room you may only write to
 * lab-* repos, commit straight to main, never ask a question" is not a voice,
 * and folding it into a tone profile would make the voice slot arbitrate two
 * unrelated concerns.
 *
 * Why a channel column instead of the group's standing instructions: standing
 * instructions are per-agent-group and therefore identical in every room that
 * group is wired into. A rule set that applies in ONE channel would otherwise
 * have to be conditional prose taxed against every other channel's always-on
 * budget, and unenforceable besides.
 *
 * Value is a profile NAME resolving to
 * `groups/<folder>/channel-instructions/<name>.md`, mounted read-only at
 * /workspace/channel-instructions and injected by the runner. NULL (the norm)
 * means no channel instructions — there is no group-level fallback, because a
 * group-level operating rule set is what standing-instructions.md already is.
 */
export const migration063: Migration = {
  version: 63,
  name: 'channel-instructions-profile',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('instructions_profile')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN instructions_profile TEXT`);
    }
  },
};
