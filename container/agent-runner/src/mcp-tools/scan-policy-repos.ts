/**
 * Runner-side source for the scan-policy repo list (scan-policy-repos.json). Kept plain (no Bun imports, JSON
 * read with fs) so src/managed-git-hooks.test.ts can load the same file and assert it equals the host's
 * SCAN_POLICY_REPOSITORY_NAMES. Never loaded at module import: every MCP tool imports this transitively.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-policy-repos.json');

/** Returns the list only when it is a non-empty array of non-empty strings; null on any failure. Never throws. */
export function loadScanPolicyRepositoryNames(dataPath: string = DATA_PATH): readonly string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(dataPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) return null;
  return parsed;
}
