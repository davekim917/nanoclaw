/**
 * Schedule (or update) the monthly design-artifact-loop drift check as an in-session
 * recurring task on the axie-dev (Claude) agent — matching the upstream-nanoclaw and
 * codex drift checks. Idempotent via seriesId: re-running updates the existing series.
 *
 *   pnpm exec tsx scripts/schedule-design-drift-task.ts
 *
 * Mechanism: a pre-task `script` (scripts/design-drift-precheck.sh) runs in-container,
 * does the deterministic mechanical diff vs upstream nexu-io/open-design, and gates the
 * agent (wakeAgent). When it wakes, the agent does the technique judgment by reading our
 * actual impl and posts to #axie-dev — only if something is actionable.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { scheduleTask, type TaskDef } from '../src/db/scheduled-tasks.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// axie-dev (Claude) agent group + the #axie-dev Discord channel it's wired to.
const AGENT_GROUP_ID = 'ag-1776735605480-ymhokes';
const CHANNEL_PLATFORM_ID = 'discord:1479489865702703155:1491839654528548989';
const SERIES_ID = 'task-design-drift-axie-dev';

const script = fs.readFileSync(path.join(repoRoot, 'scripts/design-drift-precheck.sh'), 'utf8');

const prompt = `You are running the monthly **design-artifact-loop drift check**. A deterministic pre-check already ran; its result is in scriptOutput (the MECHANICAL layer). Do the technique judgment + a concise report — but ONLY post if something is actionable.

scriptOutput compares OUR design-artifact-loop skill against upstream **nexu-io/open-design** (where the "author-then-conform" mechanism's design-system corpus is vendored from). NOTE: the skill + design_review engine are developed in the standalone plugin repo **github.com/davekim917/design-artifact-loop** (host clone: ~/plugins/design-artifact-loop); the files you read below are byte-identical vendored copies synced into NanoClaw via scripts/vendor-design-artifact-loop.ts. Any re-vendor or technique change must land in the PLUGIN repo first, then be synced.
- changed: vendored design-system files (DESIGN.md/tokens.css) that now differ from upstream — re-vendor candidates. Each: {system, file, reason}.
- newly_added: design systems ADDED upstream since our last check (names).
- our_count / upstream_count: systems we've vendored vs upstream's full catalog. We intentionally vendor a curated SUBSET — that gap is EXPECTED, not drift.
- changelog_changed: whether upstream's CHANGELOG moved since last check.
- changelog_excerpt: head of upstream CHANGELOG.md.
- commits_since: upstream commit subjects since \`since\`.

TWO PARTS:

1) MECHANICAL (report from scriptOutput, no judgment): list any \`changed\` vendored systems and any \`newly_added\` systems, concisely. NEVER dump the full catalog — the curated-subset gap is just a count ("we vendor N of M").

2) TECHNIQUE (your judgment): We ported ONLY the "author-then-conform" mechanism — NOT upstream's daemon/orchestrator, Electron editor, file exports (PPTX/MP4/PDF), packaging, or UI. Those are explicit non-goals — IGNORE changes to them. New/updated design-system DATA is the mechanical layer's job — do NOT treat "new design system" as technique drift.
   Read OUR current technique (mounted read-only — Read them directly):
   - /app/skills/design-artifact-loop/SKILL.md  (the loop)
   - /app/src/mcp-tools/design-review/linter.ts  (deterministic artifact-contract checks)
   - /app/src/mcp-tools/design-review/state.ts   (round/cap state machine + must-fix carry-forward)
   Then, from changelog_excerpt + commits_since, judge whether upstream evolved the *technique* (how it commits a design system, what it checks for to avoid slop, how it critiques/iterates, the rubric, the cap/carry-forward) in a way we should ADOPT, REVISE, or IMPROVE. Be skeptical — most changes are irrelevant. Tie each genuine finding to a specific file/check in our impl.

DECIDE: If NOTHING is actionable — no \`changed\`, no \`newly_added\`, and no genuine technique drift — end your turn WITHOUT posting (stay silent). Otherwise post ONE message to this channel:

📐 **Design-Loop Drift — nexu-io/open-design**

**Vendored systems:** {N changed: list | none changed}  (we vendor {our_count} of {upstream_count})
**New systems upstream:** {names | none since last check}

**Technique review:** {"no technique drift" | a short assessment}
{- concrete recommendation tied to a file in our impl, if any}

**Recommendation:** {Re-vendor X into davekim917/design-artifact-loop (then sync via scripts/vendor-design-artifact-loop.ts) | Investigate technique change Y | No action — advisory}
**Reason:** {one sentence}

Use **bold** with double asterisks and \`-\` bullets; keep it concise. These are ADVISORY findings for the operator — do NOT implement any change yourself, just report.`;

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const def: TaskDef = {
    id: SERIES_ID,
    agentGroupId: AGENT_GROUP_ID,
    cron: '0 9 1 * *', // 1st of each month, 09:00 ET
    processAfter: '2026-07-01T13:00:00.000Z', // first fire: 2026-07-01 09:00 ET
    seriesId: SERIES_ID,
    prompt,
    script,
    destination: { platformId: CHANNEL_PLATFORM_ID, channelType: 'discord', threadId: null },
  };

  await scheduleTask(def);
  console.log(
    `Scheduled "${SERIES_ID}" on agent ${AGENT_GROUP_ID} -> #axie-dev\n` +
      `  cron: ${def.cron}   first fire: ${def.processAfter}\n` +
      `  script: ${script.length} bytes   prompt: ${prompt.length} chars`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
