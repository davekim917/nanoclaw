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

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../../config.js';
import { getPrimaryMessagingGroupByAgentGroup } from '../../db/messaging-groups.js';
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

// Default cron: Sundays 10:00 local. Bulk-enable passes a per-group staggered
// minute offset so 11+ groups don't all hit Opus simultaneously at 10:00 every
// Sunday — same F6 reasoning as synth, except weekly instead of daily.
export const LINT_CRON_DEFAULT = '0 10 * * 0';
export const LINT_SERIES_PREFIX = 'memory-lint-';

const SYNTH_PROMPT = `Run wiki synthesise per /app/container/skills/wiki/SKILL.md.

READ FACTS IN FULL — DO NOT SKIM. Before writing or updating any wiki page, run \`mnemon recall <query>\` for the entity/concept/timeline at hand and read every returned fact end-to-end. Claude 4 models have a known tendency to partial-read or truncate long inputs and then apologize after the fact when the user notices missing context. For wiki synthesis that pattern produces silently-wrong pages: the fact you skipped is often the one correcting an earlier error or providing disambiguating detail. There is no time pressure on this task — favor completeness over speed.

If two facts contradict, surface both rather than silently picking one. If a fact contains a parenthetical alias or definition not corroborated in other facts, treat it skeptically — it may be a classifier confabulation that should not be promoted into the wiki.

REPORT DISCIPLINE: at the end of the task, if you made ZERO new pages and ZERO updates to existing pages, do not send any chat reply — complete the turn silently. Otherwise, send ONE concise line summarising what changed (e.g. "Updated 2 entity pages, created 1 timeline page."). Do not narrate the work, do not list every page touched, and do not send a status update if nothing meaningful happened.`;

const LINT_PROMPT = `Run wiki lint per the lint section of /app/container/skills/wiki/SKILL.md.

Walk wiki/ and check for:
- Contradictions (page A says X, page B says ¬X)
- Stale claims (superseded by newer sources/decisions in log.md)
- Orphan pages (no inbound links from index.md or other pages)
- Missing cross-references (page mentions an entity that has its own page but doesn't link to it)
- Concept gaps (repeated topic across multiple pages with no dedicated concept page)
- Index drift (pages on disk not in index.md, or index entries pointing at deleted files)

REPORT DISCIPLINE: report findings to the parent channel FIRST and wait for the user's go-ahead before fixing anything. Do not fix silently. If zero findings, complete the turn silently — no chat reply. If findings exist, post ONE structured summary listing the categories with counts and a brief example of each, then wait. Once the user approves, fix the findings and append a single audit entry to wiki/log.md.`;

export interface BootstrapResult {
  step1_sourcesDirsCreated: boolean;
  step2_mnemonStoreStatus: 'created' | 'exists' | 'failed' | 'binary-missing';
  step2_mnemonStoreError?: string;
  step3_synthTaskScheduled: boolean;
  step3_synthSeriesId: string;
  step3_synthCron: string;
  step4_lintTaskScheduled: boolean;
  step4_lintSeriesId: string;
  step4_lintCron: string;
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
   * Cron expression for the weekly wiki-lint task. Defaults to
   * LINT_CRON_DEFAULT ("0 10 * * 0" — Sundays 10:00 local). Bulk-enable
   * passes a per-group staggered minute offset across the 10:00 hour for the
   * same F6 reasoning that applies to synth.
   */
  lintCron?: string;
  /**
   * If true, synth/lint task scheduling failures throw rather than warning.
   * Default false — single-group enable wants to keep going even if
   * scheduling failed (operator can re-run); bulk-enable wants the same.
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
  const lintCron = opts.lintCron ?? LINT_CRON_DEFAULT;
  const result: BootstrapResult = {
    step1_sourcesDirsCreated: false,
    step2_mnemonStoreStatus: 'failed',
    step3_synthTaskScheduled: false,
    step3_synthSeriesId: `${SYNTH_SERIES_PREFIX}${agentGroupId}`,
    step3_synthCron: synthCron,
    step4_lintTaskScheduled: false,
    step4_lintSeriesId: `${LINT_SERIES_PREFIX}${agentGroupId}`,
    step4_lintCron: lintCron,
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

  // Route the synth task's chat reply to the agent group's primary messaging
  // group's parent channel (threadId=null) instead of inheriting whichever
  // thread happened to spawn the session. Without this, every synth report
  // landed inside the most recent chat thread — burying chat with the agent
  // and getting lost. If the agent has no wired channel yet (brand-new
  // groups from create_agent), skip destination — falls back to the legacy
  // session-routing behavior which the operator can fix by re-running
  // enable-memory.ts after wiring channels.
  const primaryMg = getPrimaryMessagingGroupByAgentGroup(agentGroupId);
  const destination = primaryMg
    ? {
        platformId: primaryMg.platform_id,
        channelType: primaryMg.channel_type,
        threadId: null,
      }
    : undefined;

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
        ...(destination ? { destination } : {}),
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

  // Step 4: weekly wiki-lint task (idempotent via seriesId UPDATE). Cron is
  // weekly so processAfter must be the NEXT cron fire (not "now") — otherwise
  // a re-bootstrap fires lint immediately, ahead of the user's expected
  // "Sundays at 10am" cadence. Same destination as synth (parent channel,
  // threadId=null), same Opus+high config, same quietStatus:true.
  let lintProcessAfter: string;
  try {
    const { CronExpressionParser } = await import('cron-parser');
    // .toISOString() is typed `string | null` (CronDate accepts invalid
    // dates); coalesce to "now" for the same fallback as the catch branch.
    lintProcessAfter =
      CronExpressionParser.parse(lintCron, { tz: TIMEZONE }).next().toISOString() ?? new Date().toISOString();
  } catch {
    // Fallback: schedule for "now" if cron parsing fails — daemon will fire
    // immediately, recurrence handler then computes a proper next fire.
    lintProcessAfter = new Date().toISOString();
  }
  const lintTaskId = `task-${result.step4_lintSeriesId}-${Date.now()}`;
  try {
    await scheduleTask(
      {
        id: lintTaskId,
        agentGroupId,
        cron: lintCron,
        processAfter: lintProcessAfter,
        seriesId: result.step4_lintSeriesId,
        prompt: LINT_PROMPT,
        quietStatus: true,
        ...(destination ? { destination } : {}),
        flagIntent: {
          turnModel: 'claude-opus-4-7',
          turnEffort: 'high',
        },
      },
      DATA_DIR,
    );
    result.step4_lintTaskScheduled = true;
  } catch (err) {
    if (opts.strict) throw err;
    // else: caller decides whether to log
  }

  return result;
}
