/**
 * The one reading of `NANOCLAW_SHADOW` (shadow-host.ts says what the mode
 * does). Imports only env-file.ts, which imports only node builtins, because
 * the deploy crash guard asks the same question before the application module
 * graph loads.
 */
import { readEnvValue } from './env-file.js';

/**
 * The process environment wins over `<root>/.env`; only the literal `1` turns
 * it on. An absent `.env` means off, but one that exists and cannot be read
 * throws: reading it as "off" would boot a shadow with no protections.
 */
export function readShadowFlag(root: string): boolean {
  return readEnvValue(root, 'NANOCLAW_SHADOW') === '1';
}
