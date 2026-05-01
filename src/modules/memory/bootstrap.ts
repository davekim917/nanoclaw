/**
 * Single source of truth for "make memory work for this group". Called by:
 *
 *   - `scripts/enable-memory.ts` — operator CLI, single group at a time.
 *   - `scripts/bulk-enable-memory.ts` — operator CLI, all groups at once.
 *   - `src/modules/agent-to-agent/create-agent.ts` — when a parent agent
 *     spawns a child group via the `create_agent` delivery action and the
 *     child's effective container config has `memory.enabled: true` (the
 *     emptyConfig default).
 *
 * Lives under `src/modules/memory/` rather than `scripts/lib/` so it can be
 * imported by both the host (which runs `create_agent`) and the CLI scripts;
 * the host's tsconfig rootDir excludes `scripts/`.
 *
 * # Why a shared helper
 *
 * Codex F5 (review of the default-on memory flip): if `emptyConfig()` writes
 * `memory: { enabled: true }` but only enable-memory.ts runs the side-effects
 * (sources/ subdirs, mnemon store create, synth task schedule), then a
 * default-on group born via `create_agent` flips the flag without ever
 * scaffolding the supporting state. The container would have MNEMON_STORE
 * set but the daemon would have no store to write into. This helper is the
 * fix: same bootstrap, both call sites.
 *
 * # Idempotence
 *
 * Every step is safe to re-run:
 *   - `mkdir -p` is naturally idempotent.
 *   - `mnemon store create` returns "already exists" → treated as success.
 *   - `scheduleTask` upserts on `seriesId`, so re-running just updates the
 *     row's processAfter / cron / content.
 *
 * # F6 stagger
 *
 * The `synthOffsetMinutes` parameter lets a bulk caller offset each group's
 * processAfter so the cron's first-fire isn't all clustered at the same
 * instant. Callers without staggering needs pass 0.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { scheduleTask } from '../../db/scheduled-tasks.js';

export const MEMORY_SOURCE_SUBDIRS = [
  'inbox',
  'articles',
  'docs',
  'transcripts',
  'clips',
  'media',
  'processed',
] as const;

// Default cron: 03:00 local. Bulk-enable overrides per-group with a staggered
// minute offset so 11 groups don't all wake their Opus/high synth turn at the
// same instant (Codex F6). Single-group enable uses the default.
export const SYNTH_CRON_DEFAULT = '0 3 * * *';
export const SYNTH_SERIES_PREFIX = 'memory-synth-';

const SYNTH_PROMPT = `Run wiki synthesise per /app/container/skills/wiki/SKILL.md.

READ FACTS IN FULL — DO NOT SKIM. Before writing or updating any wiki page, run \`mnemon recall <query>\` for the entity/concept/timeline at hand and read every returned fact end-to-end. Claude 4 models have a known tendency to partial-read or truncate long inputs and then apologize after the fact when the user notices missing context. For wiki synthesis that pattern produces silently-wrong pages: the fact you skipped is often the one correcting an earlier error or providing disambiguating detail. There is no time pressure on this task — favor completeness over speed.

If two facts contradict, surface both rather than silently picking one. If a fact contains a parenthetical alias or definition not corroborated in other facts, treat it skeptically — it may be a classifier confabulation that should not be promoted into the wiki.`;

export interface BootstrapResult {
  step1_sourcesDirsCreated: boolean;
  step2_mnemonStoreStatus: 'created' | 'exists' | 'failed' | 'binary-missing';
  step2_mnemonStoreError?: string;
  step3_synthTaskScheduled: boolean;
  step3_synthSeriesId: string;
  step3_synthCron: string;
}

export interface BootstrapOptions {
  /**
   * Cron expression for the synth task. Defaults to SYNTH_CRON_DEFAULT
   * ("0 3 * * *"). Bulk-enable passes a per-group staggered cron (e.g.,
   * "5 3 * * *", "10 3 * * *") so the daily fire is spread across the 03:00
   * hour, not just the initial run (Codex F6 — earlier processAfter-only
   * stagger only worked once).
   */
  synthCron?: string;
  /**
   * If true, synth task scheduling failures throw rather than warning. Default
   * false — single-group enable wants to keep going even if scheduling failed
   * (operator can re-run); bulk-enable wants the same.
   */
  strict?: boolean;
}

/**
 * Idempotently create the sources/ subdirs, mnemon store, and synth scheduled
 * task for a memory-enabled group. Does NOT touch container.json (caller's
 * responsibility — single-group enable writes it explicitly; create_agent
 * relies on the emptyConfig default). Does NOT restart containers (also
 * caller's responsibility — create_agent's spawn-once flow already gets
 * fresh env, while enable-memory.ts needs the explicit docker stop).
 */
export async function bootstrapMemoryForGroup(
  folder: string,
  agentGroupId: string,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const synthCron = opts.synthCron ?? SYNTH_CRON_DEFAULT;
  const result: BootstrapResult = {
    step1_sourcesDirsCreated: false,
    step2_mnemonStoreStatus: 'failed',
    step3_synthTaskScheduled: false,
    step3_synthSeriesId: `${SYNTH_SERIES_PREFIX}${agentGroupId}`,
    step3_synthCron: synthCron,
  };

  // Step 1: sources subdirs
  const sourcesDir = path.join(GROUPS_DIR, folder, 'sources');
  for (const sub of MEMORY_SOURCE_SUBDIRS) {
    fs.mkdirSync(path.join(sourcesDir, sub), { recursive: true });
  }
  result.step1_sourcesDirsCreated = true;

  // Step 2: mnemon store create (idempotent)
  const mnemonResult = spawnSync('mnemon', ['store', 'create', agentGroupId], {
    encoding: 'utf8',
    env: process.env,
  });
  if (mnemonResult.error) {
    result.step2_mnemonStoreStatus = 'binary-missing';
    result.step2_mnemonStoreError = mnemonResult.error.message;
  } else if (mnemonResult.status !== 0) {
    const stderr = (mnemonResult.stderr || '').toLowerCase();
    if (stderr.includes('already exists') || stderr.includes('already created')) {
      result.step2_mnemonStoreStatus = 'exists';
    } else {
      result.step2_mnemonStoreStatus = 'failed';
      result.step2_mnemonStoreError = mnemonResult.stderr;
    }
  } else {
    result.step2_mnemonStoreStatus = 'created';
  }

  // Step 3: synth task schedule (idempotent via seriesId UPDATE).
  // processAfter is set to "now" so a fresh-enabled group can synthesise
  // anything pending from prior conversations on its first cron evaluation.
  // The DAILY stagger comes from the cron itself (see synthCron above);
  // processAfter only affects the very first evaluation, then recurrence
  // re-derives the next fire from the cron.
  const processAfter = new Date().toISOString();
  const taskId = `task-${result.step3_synthSeriesId}-${Date.now()}`;

  try {
    await scheduleTask(
      {
        id: taskId,
        agentGroupId,
        cron: synthCron,
        processAfter,
        seriesId: result.step3_synthSeriesId,
        prompt: SYNTH_PROMPT,
        quietStatus: true,
        // Wiki synthesis is a high-leverage low-frequency reasoning task —
        // read N mnemon facts, dedupe, organize across multiple wiki pages,
        // update index. Run on Opus with reasoning_effort=high once a day;
        // chat in the same group keeps the agent's sticky config (typically
        // Sonnet) since these are turn-only overrides.
        flagIntent: {
          turnModel: 'claude-opus-4-7',
          turnEffort: 'high',
        },
      },
      DATA_DIR,
    );
    result.step3_synthTaskScheduled = true;
  } catch (err) {
    if (opts.strict) throw err;
    // else: caller decides whether to log
  }

  return result;
}
