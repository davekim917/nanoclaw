/**
 * Quarantine every `<session>/.host/` this host did not create.
 *
 * WHY THIS EXISTS. `.host/` is the directory the host keeps `inbound.db` in,
 * overlaid read-only into the container. A container can nevertheless CREATE
 * it: under a mount set built before the directory existed, `/workspace` is
 * bind-mounted read-write and nothing is overlaid over a path that is not
 * there, so `mkdir` and a write inside it both succeed and land host-side
 * (verified in Docker against the production image). The next spawn's
 * migration would then find a host-owned file present, see the inodes diverge,
 * and re-link the legacy name onto the PLANTED inode — adopting the attacker's
 * database whole. The provenance gate (migration 079) refuses that at spawn;
 * this is the same question asked at the deploy boundary, so a planted
 * directory is removed rather than merely refused.
 *
 * THE PREDICATE IS PROVENANCE, NOT AGE OR SHAPE, so this is safe to run on
 * EVERY deploy rather than once:
 *
 *  - Before this layout ships, no host binary has ever created `.host/`, and no
 *    provenance row exists, so everything found is container-created and every
 *    one is quarantined. Exactly right.
 *  - Afterwards the host records what it creates, so only a directory with no
 *    matching record is quarantined — which is precisely the planted case.
 *
 * A missing `host_inbound_provenance` table reads as "no rows", which is the
 * correct answer on this change's first deploy: migrations run at host startup
 * (`src/main.ts`), not from the deploy script, so at pre-restart time the table
 * legitimately does not exist yet.
 *
 * QUARANTINE NEVER LOSES DATA, which is what makes failing closed acceptable
 * here. `<session>/inbound.db` is a hard link to the same inode, so moving
 * `.host/` aside leaves the database reachable under the legacy name; the next
 * spawn migrates from it again and records fresh provenance. A directory
 * quarantined in error costs one re-migration, not a mailbox.
 *
 * Directories are MOVED, never deleted, to a location outside `v2-sessions/`
 * so no container mount can reach them again and an operator can still inspect
 * what was planted.
 *
 * Usage:
 *   pnpm exec tsx scripts/quarantine-planted-host-dirs.ts           # dry run
 *   pnpm exec tsx scripts/quarantine-planted-host-dirs.ts --apply   # move them
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { fileIdentityOf, readHostInboundProvenance } from '../src/db/host-inbound-provenance.js';
import { hostInboundDbPathFor, hostInboundDirFor } from '../src/modules/mailbox/index.js';

await initDb(path.join(DATA_DIR, 'v2.db'));

const APPLY = process.argv.includes('--apply');
const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
const quarantineRoot = path.join(DATA_DIR, 'quarantine', 'planted-host-dirs');

if (!fs.existsSync(sessionsRoot)) {
  console.log(`No sessions directory at ${sessionsRoot} — nothing to sweep.`);
  process.exit(0);
}

/**
 * Is this `.host/` one the host recorded creating?
 *
 * Every failure answers "no": a missing table (this change's first deploy), an
 * unreadable database, a row that names a different file. Quarantine is
 * recoverable — see the header — so the unanswerable cases fail closed.
 */
async function hostCreatedIt(agentGroupId: string, sessionId: string, hostDb: string): Promise<boolean> {
  const identity = fileIdentityOf(hostDb);
  if (!identity) return false;
  try {
    const row = await readHostInboundProvenance(agentGroupId, sessionId);
    return row !== null && row.device === identity.device && row.inode === identity.inode;
  } catch {
    return false;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let planted = 0;
let recognised = 0;

for (const agentGroupId of fs.readdirSync(sessionsRoot)) {
  const agentGroupDir = path.join(sessionsRoot, agentGroupId);
  if (!fs.statSync(agentGroupDir).isDirectory()) continue;

  for (const sessionId of fs.readdirSync(agentGroupDir)) {
    const sessionPath = path.join(agentGroupDir, sessionId);
    const hostDir = hostInboundDirFor(sessionPath);
    if (!fs.existsSync(hostDir)) continue;

    if (await hostCreatedIt(agentGroupId, sessionId, hostInboundDbPathFor(sessionPath))) {
      recognised += 1;
      continue;
    }

    planted += 1;
    const contents = fs.readdirSync(hostDir).join(', ') || '(empty)';
    console.log(`PLANTED  ${agentGroupId}/${sessionId}/.host  [${contents}]`);
    if (!APPLY) continue;

    const destination = path.join(quarantineRoot, stamp, agentGroupId, sessionId);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(hostDir, destination);
    console.log(`  [quarantined] ${destination}`);
  }
}

console.log(`\n${recognised} host-created, ${planted} without provenance.`);
if (planted > 0 && !APPLY) console.log('Dry run — re-run with --apply to quarantine them.');
