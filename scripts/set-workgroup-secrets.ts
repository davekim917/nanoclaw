/**
 * scripts/set-workgroup-secrets.ts — operator CLI to set workgroup-level
 * OneCLI secret declarations.
 *
 * Usage:
 *   pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>
 *
 * Exit codes:
 *   0 — success (workgroups.onecli_secrets updated; updated_at set)
 *   1 — workgroup not found OR any secret name unresolvable (no DB write)
 *   2 — invalid arguments
 *
 * What this does:
 *   1. Validates all secret names resolve in the OneCLI vault (fail before
 *      any DB write — the same fail-closed posture as applyOnecliSecrets).
 *   2. Writes the names (not the resolved UUIDs) to workgroups.onecli_secrets
 *      as a JSON string array. The container-runner resolves names → UUIDs at
 *      spawn time via the existing mergeWorkgroupAndGroupSecrets + applyOnecliSecrets
 *      pipeline, so a vault rename is handled by the next spawn rather than
 *      requiring this script to be re-run.
 *   3. Sets updated_at to the current UTC timestamp.
 *
 * Intent: workgroup secrets are the baseline that every member inherits.
 * Per-group container.json.onecliSecrets extends (additive) but cannot
 * subtract from the workgroup floor.
 *
 * Example:
 *   pnpm exec tsx scripts/set-workgroup-secrets.ts example-labs --secrets Anthropic,Exa
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveSecretUuids } from '../src/onecli-secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

export interface SetWorkgroupSecretsOptions {
  workgroupId: string;
  secrets: string[];
  dbPath?: string;
}

/**
 * Core logic — exported so tests can call it directly without spawning a
 * subprocess. Returns the exit code.
 */
export async function setWorkgroupSecrets(opts: SetWorkgroupSecretsOptions): Promise<number> {
  const { workgroupId, secrets, dbPath = DEFAULT_DB_PATH } = opts;

  const db = new Database(dbPath);
  try {
    // Step 1: verify workgroup exists
    const row = db.prepare('SELECT id FROM workgroups WHERE id = ?').get(workgroupId) as { id: string } | undefined;
    if (!row) {
      console.error(`Error: workgroup "${workgroupId}" not found in workgroups table`);
      console.error('Run the migration first or check the workgroup id with:');
      console.error(`  pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM workgroups"`);
      return 1;
    }

    // Step 2: validate secret names against the vault BEFORE any DB write.
    // resolveSecretUuids throws on unresolvable names — we catch and exit 1.
    if (secrets.length > 0) {
      try {
        await resolveSecretUuids(secrets);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // Step 3: persist names (not UUIDs) to workgroups.onecli_secrets.
    // Names are stored so a vault rename is handled by the next spawn
    // rather than requiring this script to be re-run.
    const secretsJson = JSON.stringify(secrets);
    const now = new Date().toISOString();

    db.prepare('UPDATE workgroups SET onecli_secrets = ?, updated_at = ? WHERE id = ?').run(
      secretsJson,
      now,
      workgroupId,
    );

    console.log(`Updated workgroup "${workgroupId}" secrets: ${secretsJson}`);
    return 0;
  } finally {
    db.close();
  }
}

function parseArgv(argv: string[]): SetWorkgroupSecretsOptions | null {
  // argv = process.argv.slice(2) — first positional is workgroupId, then
  // --secrets <csv>
  const workgroupId = argv[0];
  if (!workgroupId || workgroupId.startsWith('-')) {
    return null;
  }

  const secretsIdx = argv.indexOf('--secrets');
  if (secretsIdx === -1 || secretsIdx + 1 >= argv.length) {
    return null;
  }

  const secretsCsv = argv[secretsIdx + 1];
  if (!secretsCsv || secretsCsv.startsWith('-')) {
    return null;
  }

  const secrets = secretsCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { workgroupId, secrets };
}

// Only run when executed directly (not when imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts) {
    console.error('Usage: pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>');
    process.exit(2);
  }
  const code = await setWorkgroupSecrets(opts);
  process.exit(code);
}
