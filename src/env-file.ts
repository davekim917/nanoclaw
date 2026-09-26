/**
 * .env read/write helpers shared by host code that manages .env keys.
 *
 * Read semantics MUST stay compatible with src/env.ts readEnvFile (trimmed
 * lines, `#` comments, first `=` splits, matched surrounding quotes stripped,
 * empty values read as absent) — everything written here is read back through
 * that parser. Write conventions for module and skill code that manages .env
 * keys: replace the key's line in place, preserve every other line (comments
 * and blanks included), append with a clean trailing newline.
 *
 * Values written here include live credentials: never log values, only key
 * names. (No log calls exist in this file — keep it that way.)
 */
import { randomUUID } from 'node:crypto';
import fs from 'fs';

import { envPath, parseEnvText, readEnvText, readEnvValueRaw } from './env-text.js';
import { shadowMayReadEnvKey } from './shadow-allowlist.js';

/**
 * Process env first, then `${rootDir}/.env` — the same order everywhere. On a
 * shadow host a key outside the shadow allowlist reads as absent, however
 * often it is re-read and whatever `.env` holds by then.
 */
export function readEnvValue(rootDir: string, key: string): string | undefined {
  if (!shadowMayReadEnvKey(key)) return undefined;
  return readEnvValueRaw(rootDir, key);
}

/**
 * Replace KEY's line(s) in place, else append; creates .env when absent.
 * Every matching line is rewritten (not just the first) so the parser's
 * last-line-wins read can never resurface a stale value.
 */
export function upsertEnvKey(rootDir: string, key: string, value: string): void {
  upsertEnvKeys(rootDir, { [key]: value });
}

/** Publish related credentials together, with owner-only permissions. */
export function upsertEnvKeys(rootDir: string, values: Record<string, string>): void {
  let text = readEnvText(rootDir);
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error('Invalid environment assignment');
    }
    const line = `${key}=${value}`;
    let replaced = false;
    const next = text.split('\n').map((existing) => {
      const trimmed = existing.trim();
      if (trimmed.startsWith('#')) return existing;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key) return existing;
      replaced = true;
      return line;
    });
    text = replaced ? next.join('\n') : text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  }
  const target = envPath(rootDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Set-union `entry` into KEY's comma-separated list (file value, not process
 * env — the list's readers parse .env only). Creates the key when absent.
 * Returns true iff the entry was newly added.
 */
export function appendToEnvList(rootDir: string, key: string, entry: string): boolean {
  const current = parseEnvText(readEnvText(rootDir), key);
  const entries = (current ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.includes(entry)) return false;
  upsertEnvKey(rootDir, key, [...entries, entry].join(','));
  return true;
}
