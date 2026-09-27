/**
 * Quarantine every `<session>/.host/` this host did not create.
 *
 * `.host/` holds `inbound.db`, overlaid read-only into the container, but a container can CREATE
 * it under a mount set built before it existed; the next spawn's migration would then adopt the
 * planted database. Migration 079's provenance gate refuses that at spawn; this removes it at the
 * deploy boundary.
 *
 * THE PREDICATE IS PROVENANCE, NOT AGE OR SHAPE, so this is safe on every deploy: only a
 * directory with no matching host record is quarantined. A missing `host_inbound_provenance`
 * table reads as "no rows": migrations run at host startup, after this deploy-time step.
 *
 * QUARANTINE NEVER LOSES DATA, which is what makes failing closed acceptable: `inbound.db` is a
 * hard link to the same inode, so the next spawn re-migrates. Directories are MOVED, never
 * deleted, outside `v2-sessions/` where no container mount can reach them.
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

/** Every failure answers "no" (quarantine is recoverable, so unanswerable cases fail closed). */
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
