/**
 * PRE-DEPLOY, ONE TIME: quarantine every `<session>/.host/` on disk.
 *
 * WHY THIS EXISTS. Until the #749 host-owned layout ships, NO host binary has
 * ever created `<session>/.host/`. The predicate is therefore total and needs
 * no heuristics: any `.host/` this finds was created by a container. Under a
 * pre-deploy mount set `/workspace` is bind-mounted read-write and `.host` does
 * not exist, so nothing is overlaid over it — a container can `mkdir` it and
 * write its own `inbound.db` inside, which the next spawn's migration would
 * otherwise adopt as authoritative.
 *
 * RUN IT IMMEDIATELY BEFORE THE DEPLOY, not in advance. A clean result is
 * PERISHABLE: any container running between the scan and the deploy can plant
 * one, and a planted `.host/` outlives the container that created it, so
 * restarting containers does not close the window. Stop the host, run this,
 * then deploy.
 *
 * AFTER THE DEPLOY THIS SCRIPT IS WRONG. Once the new binary is running, the
 * host itself creates `.host/` for every session it migrates, and those are
 * legitimate — they carry a provenance record (migration 079). Quarantining
 * them would orphan live mailboxes. This is a one-time pre-deploy step, not a
 * recurring sweep; the standing protection is the provenance gate.
 *
 * Quarantined directories are MOVED, never deleted, to a location outside
 * `v2-sessions/` so no container mount can reach them again and an operator can
 * still inspect what was planted.
 *
 * Usage:
 *   pnpm exec tsx scripts/quarantine-planted-host-dirs.ts           # dry run
 *   pnpm exec tsx scripts/quarantine-planted-host-dirs.ts --apply   # move them
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
const quarantineRoot = path.join(DATA_DIR, 'quarantine', 'planted-host-dirs');

if (!fs.existsSync(sessionsRoot)) {
  console.error(`No sessions directory at ${sessionsRoot}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let found = 0;

for (const agentGroupId of fs.readdirSync(sessionsRoot)) {
  const agentGroupDir = path.join(sessionsRoot, agentGroupId);
  if (!fs.statSync(agentGroupDir).isDirectory()) continue;

  for (const sessionId of fs.readdirSync(agentGroupDir)) {
    const hostDir = path.join(agentGroupDir, sessionId, '.host');
    if (!fs.existsSync(hostDir)) continue;
    found += 1;

    const contents = fs.readdirSync(hostDir).join(', ') || '(empty)';
    console.log(`PLANTED  ${agentGroupId}/${sessionId}/.host  [${contents}]`);
    if (!APPLY) continue;

    const destination = path.join(quarantineRoot, stamp, agentGroupId, sessionId);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(hostDir, destination);
    console.log(`  [quarantined] ${destination}`);
  }
}

if (found === 0) {
  console.log('No `.host/` directories found — nothing was planted.');
  console.log('This result is perishable: deploy now, before another container can plant one.');
} else if (!APPLY) {
  console.log(`\n${found} planted directory(ies). Re-run with --apply to quarantine them.`);
} else {
  console.log(`\n${found} directory(ies) quarantined under ${path.join(quarantineRoot, stamp)}.`);
}
