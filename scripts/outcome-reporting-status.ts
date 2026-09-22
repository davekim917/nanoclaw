/** Read-only default-migration inventory from the authoritative spawn-time files. */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_DB_PATH, GROUPS_DIR } from '../src/config.js';
import { effectiveOutcomeReporting, readContainerConfig } from '../src/container-config.js';

const db = new Database(CENTRAL_DB_PATH, { readonly: true, fileMustExist: true });
try {
  const groups = db.prepare('SELECT folder FROM agent_groups ORDER BY name').all() as Array<{ folder: string }>;
  for (const group of groups) {
    const file = path.join(GROUPS_DIR, group.folder, 'container.json');
    let configured: boolean | 'absent';
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      configured = typeof raw.outcomeReporting === 'boolean' ? raw.outcomeReporting : 'absent';
    } catch (error) {
      throw new Error(`Cannot inspect ${file}`, { cause: error });
    }
    const resolved = readContainerConfig(group.folder);
    console.log(
      JSON.stringify({
        group: group.folder,
        configured,
        effective: effectiveOutcomeReporting(resolved),
        reservedChannels: resolved.outcomeReportingExternalChannels ?? [],
      }),
    );
  }
} finally {
  db.close();
}
