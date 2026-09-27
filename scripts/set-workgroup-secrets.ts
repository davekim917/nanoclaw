/**
 * Operator CLI to set a workgroup's OneCLI secret declarations.
 *
 *   pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>
 *
 * Exit: 0 success, 1 workgroup not found or a name unresolvable (no DB write), 2 invalid arguments.
 * Names are validated against the vault before any write and stored as names, not UUIDs, so a
 * vault rename is picked up at the next spawn. Workgroup secrets are a floor every member
 * inherits; a group's container.json can add to it, never subtract.
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

export async function setWorkgroupSecrets(opts: SetWorkgroupSecretsOptions): Promise<number> {
  const { workgroupId, secrets, dbPath = DEFAULT_DB_PATH } = opts;

  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT id FROM workgroups WHERE id = ?').get(workgroupId) as { id: string } | undefined;
    if (!row) {
      console.error(`Error: workgroup "${workgroupId}" not found in workgroups table`);
      console.error('Run the migration first or check the workgroup id with:');
      console.error(`  pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM workgroups"`);
      return 1;
    }

    // Validated BEFORE any DB write.
    if (secrets.length > 0) {
      try {
        await resolveSecretUuids(secrets);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts) {
    console.error('Usage: pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <name1,name2,...>');
    process.exit(2);
  }
  const code = await setWorkgroupSecrets(opts);
  process.exit(code);
}
