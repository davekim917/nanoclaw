import fs from 'fs';
import path from 'path';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';

/**
 * Per-thread archive for providers with no on-disk transcript, called from the provider's own
 * `onExchangeComplete`; the runner never archives on a provider's behalf. The filename's date is the thread's
 * creation day and stays stable across later appends.
 */

const DEFAULT_CONVERSATIONS_DIR = '/workspace/agent/conversations';

export interface ProviderExchangeArchiveOptions {
  provider: string;
  prompt: string;
  result: string | null | undefined;
  continuation?: string;
  status: string;
  timestamp?: Date;
  conversationsDir?: string;
}

/** Returns the thread-stable filename, or null when the result is empty (nothing archived). */
export function archiveProviderExchange(options: ProviderExchangeArchiveOptions): string | null {
  const result = options.result?.trim();
  if (!result) return null;

  const timestamp = options.timestamp ?? new Date();
  const conversationsDir =
    options.conversationsDir || process.env.NANOCLAW_CONVERSATIONS_DIR || DEFAULT_CONVERSATIONS_DIR;
  fs.mkdirSync(conversationsDir, { recursive: true });

  const filename = threadArchiveFilename(conversationsDir, options.provider, options.continuation, timestamp);
  const filePath = path.join(conversationsDir, filename);

  // Each block leads with a blank line + `---` so the separator renders as a thematic break, not a setext
  // heading underline on the prior line.
  const parts: string[] = [];
  if (!fs.existsSync(filePath)) {
    parts.push(
      `# ${titleCase(options.provider)} Conversation`,
      '',
      `Provider: ${options.provider}`,
      `Continuation/thread id: ${options.continuation || '(none)'}`,
    );
  }
  parts.push(
    '',
    '---',
    '',
    `Archived: ${formatLocalStamp(timestamp, TIMEZONE)} · Status: ${options.status}`,
    '',
    `**User**: ${truncate(options.prompt)}`,
    '',
    `**Assistant**: ${truncate(result)}`,
    '',
  );
  fs.appendFileSync(filePath, parts.join('\n'));
  return filename;
}

function threadArchiveFilename(
  dir: string,
  provider: string,
  continuation: string | undefined,
  timestamp: Date,
): string {
  const thread = sanitizeSlug(continuation || 'no-thread').slice(0, 48) || 'no-thread';
  const suffix = `${sanitizeSlug(provider)}-${thread}.md`;
  const dated = /^\d{4}-\d{2}-\d{2}-/;
  const existing = fs.readdirSync(dir).find((f) => dated.test(f) && f.replace(dated, '') === suffix);
  if (existing) return existing;
  // Local calendar day: evening sessions west of UTC would otherwise land under tomorrow's date.
  return `${formatLocalStamp(timestamp, TIMEZONE).slice(0, 10)}-${suffix}`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : 'Provider';
}

function truncate(value: string): string {
  return value.length > 2000 ? value.slice(0, 2000) + '...' : value;
}
