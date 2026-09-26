/**
 * The one reading of `NANOCLAW_SHADOW` (shadow-host.ts says what the mode
 * does). Imports only env-text.ts, which imports only node builtins, because
 * the deploy crash guard and the `.env` readers ask the same question before
 * the application module graph loads.
 */
import { readEnvValueRaw } from './env-text.js';

/**
 * The process environment wins over `<root>/.env`; only the literal `1` turns
 * it on. An absent `.env` means off, but one that exists and cannot be read
 * throws: reading it as "off" would boot a shadow with no protections.
 */
export function readShadowFlag(root: string): boolean {
  return readEnvValueRaw(root, 'NANOCLAW_SHADOW') === '1';
}

let shadowProcess: boolean | undefined;

/**
 * Whether this process is a shadow host, decided once from the working
 * directory on first use (boot) and fixed for the process's lifetime: a
 * `.env` edited or made unreadable later changes nothing.
 */
export function isShadowProcess(): boolean {
  shadowProcess ??= readShadowFlag(process.cwd());
  return shadowProcess;
}

/** Test-only: forget the decision so the next call re-reads the flag. */
export function _resetShadowProcessForTesting(): void {
  shadowProcess = undefined;
}
