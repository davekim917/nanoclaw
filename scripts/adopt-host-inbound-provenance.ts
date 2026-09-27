/**
 * THE DOCUMENTED OVERRIDE: adopt existing `<session>/.host/inbound.db` files as this host's own,
 * after a restore or a rebuilt central DB left them without a provenance record (migration 079).
 *
 * READ THIS BEFORE `--all`. Adopting declares the files on disk ARE yours: run it only when the
 * tree is known trusted, before any container has run against it. Running it to clear an
 * unexpected refusal adopts whatever a container planted; quarantine instead
 * (`scripts/quarantine-planted-host-dirs.ts`).
 *
 * Usage:
 *   pnpm exec tsx scripts/adopt-host-inbound-provenance.ts --all            # dry run
 *   pnpm exec tsx scripts/adopt-host-inbound-provenance.ts --all --apply
 *   pnpm exec tsx scripts/adopt-host-inbound-provenance.ts \
 *     --agent-group <id> --session <id> --apply
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import {
  fileIdentityOf,
  readHostInboundProvenance,
  recordHostInboundProvenance,
} from '../src/db/host-inbound-provenance.js';

await initDb(path.join(DATA_DIR, 'v2.db'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const onlyAgentGroup = args.includes('--agent-group') ? args[args.indexOf('--agent-group') + 1] : null;
const onlySession = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;

if (!ALL && !(onlyAgentGroup && onlySession)) {
  console.error('Pass --all, or both --agent-group <id> and --session <id>.');
  process.exit(2);
}

const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
if (!fs.existsSync(sessionsRoot)) {
  console.error(`No sessions directory at ${sessionsRoot}`);
  process.exit(1);
}

let adopted = 0;
let alreadyRecorded = 0;

for (const agentGroupId of fs.readdirSync(sessionsRoot)) {
  if (onlyAgentGroup && agentGroupId !== onlyAgentGroup) continue;
  const agentGroupDir = path.join(sessionsRoot, agentGroupId);
  if (!fs.statSync(agentGroupDir).isDirectory()) continue;

  for (const sessionId of fs.readdirSync(agentGroupDir)) {
    if (onlySession && sessionId !== onlySession) continue;
    const hostDb = path.join(agentGroupDir, sessionId, '.host', 'inbound.db');
    if (!fs.existsSync(hostDb)) continue;

    const identity = fileIdentityOf(hostDb);
    if (!identity) {
      console.log(`SKIP     ${agentGroupId}/${sessionId} — could not identify ${hostDb}`);
      continue;
    }

    const existing = await readHostInboundProvenance(agentGroupId, sessionId);
    if (existing && existing.device === identity.device && existing.inode === identity.inode) {
      alreadyRecorded += 1;
      continue;
    }

    const why = existing ? 're-pointing a stale record at the file on disk' : 'no record';
    console.log(`ADOPT    ${agentGroupId}/${sessionId} — ${why} (inode ${identity.inode})`);
    adopted += 1;
    if (APPLY) await recordHostInboundProvenance(agentGroupId, sessionId, identity);
  }
}

console.log(`\n${alreadyRecorded} already recorded, ${adopted} to adopt.`);
if (adopted > 0 && !APPLY) console.log('Dry run — re-run with --apply to record them.');
