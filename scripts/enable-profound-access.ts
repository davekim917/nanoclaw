/**
 * Add Profound OneCLI secret declarations to workgroup-level baselines.
 *
 * Usage:
 *   pnpm exec tsx scripts/enable-profound-access.ts
 *   pnpm exec tsx scripts/enable-profound-access.ts --include-log-ingestion
 *
 * This script stores secret NAMES, not values. It validates that the named
 * OneCLI secrets exist before writing. Existing Madison Reed workgroup secrets
 * are preserved and Profound names are appended if missing.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveSecretUuids } from '../src/onecli-secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

const DEFAULT_PROFOUND_SECRET = 'Profound';
const DEFAULT_LOG_INGESTION_SECRET = 'Profound-Log-Ingestion';
const MADISON_REED_WORKGROUP = 'madison-reed';

export interface EnableProfoundAccessOptions {
  workgroupId?: string;
  secretName?: string;
  includeLogIngestion?: boolean;
  logIngestionSecretName?: string;
  dbPath?: string;
}

interface WorkgroupRow {
  id: string;
  onecli_secrets: string;
}

function parseSecretArray(raw: string, workgroupId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    throw new Error(`workgroup "${workgroupId}" has invalid onecli_secrets JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error(`workgroup "${workgroupId}" onecli_secrets must be a JSON string array`);
  }
  return parsed as string[];
}

function appendMissing(existing: string[], additions: string[]): { next: string[]; changed: boolean } {
  const seen = new Set(existing);
  const next = [...existing];
  let changed = false;
  for (const name of additions) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push(name);
    changed = true;
  }
  return { next, changed };
}

function selectedWorkgroup(db: Database.Database, workgroupId: string): WorkgroupRow {
  if (workgroupId !== MADISON_REED_WORKGROUP) {
    throw new Error(`Profound access is scoped to "${MADISON_REED_WORKGROUP}" only, got "${workgroupId}"`);
  }

  const row = db.prepare('SELECT id, onecli_secrets FROM workgroups WHERE id = ?').get(workgroupId) as
    | WorkgroupRow
    | undefined;
  if (!row) {
    throw new Error(`workgroup "${workgroupId}" not found`);
  }
  return row;
}

function missingCredentialHelp(): string {
  return [
    'Create the Profound REST secret with:',
    "  onecli secrets create --name Profound --type generic --value '<PROFOUND_API_KEY>' --host-pattern api.tryprofound.com --path-pattern '/*' --header-name X-API-Key --value-format '{value}'",
    '',
    'For Agent Analytics custom log ingestion, create the separate ingestion token secret with:',
    "  onecli secrets create --name Profound-Log-Ingestion --type generic --value '<PROFOUND_LOG_INGESTION_TOKEN>' --host-pattern artemis.api.tryprofound.com --path-pattern '/v1/logs/custom' --header-name x-api-key --value-format '{value}'",
  ].join('\n');
}

export function enableProfoundAccess(opts: EnableProfoundAccessOptions): number {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const workgroupId = opts.workgroupId ?? MADISON_REED_WORKGROUP;
  const secretName = opts.secretName ?? DEFAULT_PROFOUND_SECRET;
  const secretsToAdd = [secretName];
  if (opts.includeLogIngestion) {
    secretsToAdd.push(opts.logIngestionSecretName ?? DEFAULT_LOG_INGESTION_SECRET);
  }

  const db = new Database(dbPath);
  try {
    let row: WorkgroupRow;
    try {
      row = selectedWorkgroup(db, workgroupId);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    try {
      resolveSecretUuids(secretsToAdd);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(missingCredentialHelp());
      return 1;
    }

    const updated: string[] = [];
    const unchanged: string[] = [];
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      const existing = parseSecretArray(row.onecli_secrets, row.id);
      const { next, changed } = appendMissing(existing, secretsToAdd);
      if (!changed) {
        unchanged.push(row.id);
        return;
      }
      db.prepare('UPDATE workgroups SET onecli_secrets = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(next),
        now,
        row.id,
      );
      updated.push(row.id);
    });

    try {
      tx();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    console.log(`Profound secret declarations: ${secretsToAdd.join(', ')}`);
    console.log(`Updated workgroups: ${updated.length ? updated.join(', ') : '(none)'}`);
    console.log(`Already configured: ${unchanged.length ? unchanged.join(', ') : '(none)'}`);
    return 0;
  } finally {
    db.close();
  }
}

function parseArgv(argv: string[]): EnableProfoundAccessOptions | null {
  if (argv.includes('--workgroups')) return null;

  const workgroupIdx = argv.indexOf('--workgroup');
  const workgroupId =
    workgroupIdx === -1 ? undefined : workgroupIdx + 1 < argv.length ? argv[workgroupIdx + 1]?.trim() : undefined;
  if (workgroupIdx !== -1 && (!workgroupId || workgroupId.startsWith('-'))) return null;

  const secretIdx = argv.indexOf('--secret');
  const secretName =
    secretIdx === -1 ? undefined : secretIdx + 1 < argv.length ? argv[secretIdx + 1]?.trim() : undefined;
  if (secretIdx !== -1 && (!secretName || secretName.startsWith('-'))) return null;

  const logSecretIdx = argv.indexOf('--log-secret');
  const logIngestionSecretName =
    logSecretIdx === -1 ? undefined : logSecretIdx + 1 < argv.length ? argv[logSecretIdx + 1]?.trim() : undefined;
  if (logSecretIdx !== -1 && (!logIngestionSecretName || logIngestionSecretName.startsWith('-'))) return null;

  const dbIdx = argv.indexOf('--db');
  const dbPath = dbIdx === -1 ? undefined : dbIdx + 1 < argv.length ? argv[dbIdx + 1]?.trim() : undefined;
  if (dbIdx !== -1 && (!dbPath || dbPath.startsWith('-'))) return null;

  return {
    workgroupId,
    secretName,
    includeLogIngestion: argv.includes('--include-log-ingestion'),
    logIngestionSecretName,
    dbPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts) {
    console.error(
      'Usage: pnpm exec tsx scripts/enable-profound-access.ts [--workgroup madison-reed] [--secret Profound] [--include-log-ingestion] [--log-secret Profound-Log-Ingestion] [--db data/v2.db]',
    );
    process.exit(2);
  }
  process.exit(enableProfoundAccess(opts));
}
