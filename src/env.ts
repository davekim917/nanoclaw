import fs from 'fs';
import path from 'path';
import { parseEnvContent } from './env-parse.js';
import { log } from './log.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const wanted = new Set(keys);
  return parseEnvFile((key) => wanted.has(key));
}

/**
 * Return all .env keys that match a regex, as a map of full-key → value.
 * Useful for scanning variable-suffix patterns like `SLACK_BOT_TOKEN(_<SUFFIX>)?`.
 */
export function readEnvFileMatching(pattern: RegExp): Record<string, string> {
  return parseEnvFile((key) => pattern.test(key));
}

function parseEnvFile(include: (key: string) => boolean): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  return parseEnvContent(content, include);
}
