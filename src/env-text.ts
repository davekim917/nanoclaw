/**
 * Raw `.env` reads with src/env.ts semantics (trimmed lines, `#` comments,
 * first `=` splits, matched surrounding quotes stripped, empty values read as
 * absent). Unfiltered: host code reads keys through env-file.ts or env.ts,
 * which apply the shadow-host key allowlist; this module exists so the flag
 * itself can be read without a cycle.
 *
 * Node builtins only: the deploy crash guard reaches this module before the
 * application module graph loads.
 */
import fs from 'fs';
import path from 'path';

export function envPath(rootDir: string): string {
  return path.join(rootDir, '.env');
}

export function readEnvText(rootDir: string): string {
  try {
    return fs.readFileSync(envPath(rootDir), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Parse one KEY from dotenv-style text with src/env.ts semantics. Last line wins. */
export function parseEnvText(text: string, key: string): string | undefined {
  let result: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result = value;
  }
  return result;
}

/** Process env first, then `${rootDir}/.env`, with no shadow-host filtering. */
export function readEnvValueRaw(rootDir: string, key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  return parseEnvText(readEnvText(rootDir), key);
}
