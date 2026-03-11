/**
 * Thread Search: FTS5 keyword search + Haiku semantic reranking.
 *
 * Container agents call `search_threads` via IPC to find relevant past threads
 * in their group. FTS5 does fast keyword matching, then Haiku reranks the
 * top candidates by semantic relevance.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import {
  ThreadMetadataRow,
  searchThreadsFTS,
  upsertThreadIndex,
} from './db.js';
import { getAnthropicApiKey } from './env.js';
import { logger } from './logger.js';

export interface ThreadSearchResult {
  thread_key: string;
  group_folder: string;
  thread_id: string;
  platform: string;
  topic_summary: string;
  last_activity: string;
}

/**
 * Search threads by query with FTS5 keyword search + Haiku reranking.
 * Scoped to a single group folder for security.
 */
export async function searchThreads(
  groupFolder: string,
  query: string,
  limit: number = 5,
): Promise<ThreadSearchResult[]> {
  // Sanitize query for FTS5: remove special characters that break MATCH syntax
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  // FTS5 keyword search — get top 20 candidates
  let candidates: ThreadMetadataRow[];
  try {
    candidates = searchThreadsFTS(groupFolder, sanitized, 20);
  } catch (err) {
    logger.warn({ err, query: sanitized }, 'FTS5 search failed');
    return [];
  }

  if (candidates.length === 0) return [];

  const results = candidates
    .filter((c) => c.topic_summary)
    .map((c) => ({
      thread_key: c.thread_key,
      group_folder: c.group_folder,
      thread_id: c.thread_id,
      platform: c.platform,
      topic_summary: c.topic_summary!,
      last_activity: c.last_activity,
    }));

  // If few enough results, skip Haiku reranking (FTS5 rank order is good enough)
  if (results.length <= limit) return results;

  // Haiku reranking — pick best semantic matches
  // Use sanitized query in the prompt to prevent injection via crafted search terms
  try {
    const reranked = await rerankWithHaiku(sanitized, results, limit);
    return reranked;
  } catch (err) {
    logger.warn({ err }, 'Haiku reranking failed, returning FTS5 results');
    return results.slice(0, limit);
  }
}

/**
 * Sanitize a user query for FTS5 MATCH syntax.
 * Wraps each word in quotes to prevent syntax errors from special chars.
 * Hyphens are replaced with spaces since FTS5's unicode61 tokenizer
 * treats them as token delimiters (e.g. "dirt-market" → "dirt" "market").
 * Uses Unicode-aware regex to preserve accented/non-Latin characters.
 */
function sanitizeFtsQuery(query: string): string {
  const words = query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip non-letter/non-number chars (Unicode-aware)
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return '';
  // Use OR to match any keyword (broad search, Haiku will narrow down)
  return words.map((w) => `"${w}"`).join(' OR ');
}

async function rerankWithHaiku(
  query: string,
  candidates: ThreadSearchResult[],
  limit: number,
): Promise<ThreadSearchResult[]> {
  const apiKey = getAnthropicApiKey();

  const summaryList = candidates
    .map((c, i) => `${i + 1}. [${c.thread_key}] ${c.topic_summary}`)
    .join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Given this search query: "${query}"

Rank these thread summaries by relevance to the query. Return ONLY the numbers of the top ${limit} most relevant threads, comma-separated, most relevant first.

${summaryList}

Reply with ONLY the numbers (e.g., "3,1,7"):`,
        },
      ],
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    throw new Error(`Haiku API error: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === 'text')?.text?.trim() || '';

  // Parse comma-separated numbers
  const indices = text
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10) - 1) // 1-indexed → 0-indexed
    .filter((i) => !isNaN(i) && i >= 0 && i < candidates.length);

  if (indices.length === 0) {
    // Haiku returned garbage — fall back to FTS5 order
    return candidates.slice(0, limit);
  }

  // Deduplicate while preserving order
  const seen = new Set<number>();
  const result: ThreadSearchResult[] = [];
  for (const i of indices) {
    if (!seen.has(i) && result.length < limit) {
      seen.add(i);
      result.push(candidates[i]);
    }
  }

  return result;
}

/**
 * Derive platform from threadId format.
 * Slack thread timestamps contain a dot (e.g. "1773071476.205929").
 * Discord snowflake IDs are purely numeric (e.g. "1234567890123456").
 */
function detectPlatform(threadId: string): string {
  if (threadId.includes('.')) return 'slack';
  return 'discord';
}

/**
 * Index a single thread's summary after an agent run completes.
 * Much cheaper than a full scan — only reads one file.
 */
export function indexSingleThread(
  groupFolder: string,
  threadId: string,
): boolean {
  const summaryPath = path.join(
    GROUPS_DIR,
    groupFolder,
    'threads',
    threadId,
    'summary.txt',
  );

  let summary: string;
  try {
    summary = fs.readFileSync(summaryPath, 'utf-8').trim();
  } catch {
    return false; // file doesn't exist or unreadable
  }
  if (!summary) return false;

  try {
    const platform = detectPlatform(threadId);
    const threadKey = `${groupFolder}:thread:${threadId}`;
    return upsertThreadIndex(
      threadKey,
      groupFolder,
      threadId,
      platform,
      summary,
    );
  } catch (err) {
    logger.warn(
      { err, groupFolder, threadId },
      'Failed to index thread summary',
    );
    return false;
  }
}

/**
 * Index all thread summaries from group thread workspaces.
 * Called on startup to catch crash-orphaned summaries.
 */
export function indexThreadSummaries(): number {
  let indexed = 0;

  // Scan all group folders for threads with summary.txt
  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(GROUPS_DIR).filter((f) => {
      try {
        return fs.statSync(path.join(GROUPS_DIR, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return 0;
  }

  for (const groupFolder of groupFolders) {
    const threadsDir = path.join(GROUPS_DIR, groupFolder, 'threads');
    if (!fs.existsSync(threadsDir)) continue;

    let threadIds: string[];
    try {
      threadIds = fs.readdirSync(threadsDir).filter((f) => {
        try {
          return fs.statSync(path.join(threadsDir, f)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    for (const threadId of threadIds) {
      if (indexSingleThread(groupFolder, threadId)) {
        indexed++;
      }
    }
  }

  if (indexed > 0) {
    logger.info({ indexed }, 'Indexed thread summaries');
  }

  return indexed;
}
