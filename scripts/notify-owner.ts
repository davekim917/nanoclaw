/**
 * CLI entry point for the notify-owner alert primitive; the delivery core lives in
 * src/notify-owner.ts because `dist/` compiles only `src/**`.
 *
 * Usage:
 *   tsx scripts/notify-owner.ts --title "<title>" --body "<body>"
 *   tsx scripts/notify-owner.ts --title "<title>" --body -   # body from stdin
 *
 * Exit codes (distinct on purpose — shell watchdogs branch on them):
 *   0 — delivered, receipt verified. One safe line on stdout (channel id only).
 *   2 — cannot even try: no owner DM row, an unsupported channel type, or no bot token.
 *   1 — tried and failed: Slack API error, `ok:false`, or a network failure.
 * A token value is NEVER printed, logged, or included in any exit message.
 */
import path from 'path';
import { pathToFileURL } from 'url';

import { notifyOwner } from '../src/notify-owner.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseArgs(argv: string[]): { title: string; body: string } {
  let title: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') title = argv[++i];
    else if (argv[i] === '--body') body = argv[++i];
  }
  if (title === undefined || body === undefined) {
    throw new Error('Usage: tsx scripts/notify-owner.ts --title "<title>" --body "<body>" (or --body - for stdin)');
  }
  return { title, body };
}

async function main(): Promise<number> {
  let title: string, bodyArg: string;
  try {
    ({ title, body: bodyArg } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    // A malformed invocation is "cannot even try" too.
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const body = bodyArg === '-' ? await readStdin() : bodyArg;
  const result = await notifyOwner({ title, body });
  if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  return result.code;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
