/** Read-only default-migration inventory from the authoritative spawn-time files. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_DB_PATH, GROUPS_DIR } from '../src/config.js';
import { effectiveOutcomeReporting, readContainerConfig } from '../src/container-config.js';

const db = new Database(CENTRAL_DB_PATH, { readonly: true, fileMustExist: true });
let hasErrors = false;
try {
  const groups = db.prepare('SELECT folder FROM agent_groups ORDER BY name').all() as Array<{ folder: string }>;
  for (const group of groups) {
    const file = path.join(GROUPS_DIR, group.folder, 'container.json');
    let configured: boolean | 'absent' | 'invalid' | 'unreadable' = 'unreadable';
    let error: string | undefined;
    let fileText: string | undefined;
    try {
      fileText = fs.readFileSync(file, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') configured = 'absent';
      else {
        configured = 'unreadable';
        const code = (cause as NodeJS.ErrnoException).code;
        error =
          typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `unreadable_config:${code}` : 'unreadable_config';
      }
    }
    if (fileText !== undefined) {
      try {
        const raw = JSON.parse(fileText) as Record<string, unknown>;
        configured =
          raw.outcomeReporting === undefined
            ? 'absent'
            : typeof raw.outcomeReporting === 'boolean'
              ? raw.outcomeReporting
              : 'invalid';
        if (configured === 'invalid') error = 'invalid_outcome_reporting';
      } catch {
        configured = 'invalid';
        error = 'invalid_json';
      }
    }

    let effective: boolean | null = null;
    let reservedChannels: string[] = [];
    if (configured !== 'invalid' && configured !== 'unreadable') {
      try {
        const resolved = readContainerConfig(group.folder);
        effective = effectiveOutcomeReporting(resolved);
        reservedChannels = resolved.outcomeReportingExternalChannels ?? [];
      } catch {
        configured = 'invalid';
        error = 'resolution_failed';
      }
    }
    if (configured === 'invalid' || configured === 'unreadable') hasErrors = true;
    console.log(
      JSON.stringify({
        group: group.folder,
        configured,
        effective,
        reservedChannels,
        ...(error ? { error } : {}),
      }),
    );
  }
} finally {
  db.close();
}
if (hasErrors) process.exitCode = 1;
