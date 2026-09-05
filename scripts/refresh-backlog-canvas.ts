/**
 * Refresh the backlog canvas once, now, without restarting the host.
 *
 * Useful for verifying a render change and for the first write after wiring a
 * new `backlogCanvas` block into a container.json.
 *
 *   pnpm exec tsx scripts/refresh-backlog-canvas.ts
 *   pnpm exec tsx scripts/refresh-backlog-canvas.ts --preview [team]
 *
 * `--preview` fetches and renders but writes nothing to Slack — the way to
 * iterate on the board layout without touching a live channel.
 */
import path from 'path';

import { fetchLinearIssues, renderBoard, runTick } from '../src/backlog-canvas.js';
import { DATA_DIR } from '../src/config.js';
import { readContainerConfig } from '../src/container-config.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';

await initDb(path.join(DATA_DIR, 'v2.db'));

const preview = process.argv.includes('--preview');
const team = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) || 'XZO';

const run = preview
  ? async () => {
      // Linear is reached with the OPTED-IN GROUP's OneCLI identity, because
      // the Linear credential is scoped to that workgroup's agent and not to
      // the host's default one. Same resolution runTick does.
      const group = (await getAllAgentGroups()).find(
        (g) => readContainerConfig(g.folder).backlogCanvas?.messagingGroupId,
      );
      if (!group) {
        console.error('No group declares backlogCanvas.messagingGroupId — nothing to preview.');
        process.exit(1);
      }
      const issues = await fetchLinearIssues(team, group.id);
      const md = renderBoard(issues);
      console.log(
        `--- ${issues.length} issues · ${md.length} bytes · ${(md.match(/^#/gm) || []).length} header(s) ---`,
      );
      console.log(md);
    }
  : runTick;

run()
  .then(() => {
    console.log(preview ? '\n(preview only — nothing written)' : 'backlog canvas refresh complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('backlog canvas refresh failed:', err);
    process.exit(1);
  });
