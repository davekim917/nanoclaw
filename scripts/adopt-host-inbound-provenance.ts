/**
 * THE DOCUMENTED OVERRIDE: adopt existing `<session>/.host/inbound.db` files as
 * this host's own.
 *
 * WHEN YOU NEED IT. The spawn path refuses to touch a host-owned inbound.db
 * that carries no provenance record in the central DB (migration 079), because
 * a container can create that path itself and adopting it would replace the
 * session's authoritative database. Two legitimate situations produce exactly
 * that shape, and neither is an attack:
 *
 *   - a restore from a rescue archive, where the session directories came back
 *     but the central DB did not come back with them;
 *   - a rebuilt or replaced central DB, where the files are the ones this host
 *     has been using all along but the record of creating them is gone.
 *
 * In both, the operator knows something the host cannot: that the tree is
 * trusted. This script is where that knowledge is applied deliberately, in one
 * auditable step, rather than by weakening the gate.
 *
 * READ THIS BEFORE `--all`. Adopting is a decision that the files on disk ARE
 * yours. Run it only when you know the tree is trusted — right after a restore,
 * before any container has run against it. Running it to clear an unexpected
 * refusal would adopt whatever a container planted, which is precisely the
 * outcome the refusal exists to prevent. If a refusal is unexpected, quarantine
 * instead: `scripts/quarantine-planted-host-dirs.ts`.
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
