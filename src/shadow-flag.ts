/**
 * The one reading of `NANOCLAW_SHADOW` (shadow-host.ts says what the mode
 * does). Imports only node builtins and env-parse.ts, because the deploy crash
 * guard asks the same question before the application module graph loads.
 */
import fs from 'fs';
import path from 'path';

import { parseEnvContent } from './env-parse.js';

const SHADOW_ENV_KEY = 'NANOCLAW_SHADOW';

/** The process environment wins over `<root>/.env`; only the literal `1` turns it on. */
export function readShadowFlag(root: string): boolean {
  const fromEnv = process.env[SHADOW_ENV_KEY];
  if (fromEnv !== undefined) return fromEnv === '1';
  let content: string;
  try {
    content = fs.readFileSync(path.join(root, '.env'), 'utf-8');
  } catch (err) {
    if (typeof (err as NodeJS.ErrnoException).code === 'string') return false;
    throw err;
  }
  return parseEnvContent(content, (key) => key === SHADOW_ENV_KEY)[SHADOW_ENV_KEY] === '1';
}
