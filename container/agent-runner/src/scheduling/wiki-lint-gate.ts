import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WIKI_DIR = '/workspace/agent/wiki';
const DEFAULT_INBOUND_DB = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_DB = '/workspace/outbound.db';

interface TaskIdRow {
  id: string;
}

interface CompletedAckRow {
  status_changed: string;
}

interface WikiTreeState {
  contentFiles: number;
  latestChangeMs: number | null;
}

export interface WikiLintGateResult {
  wakeAgent: boolean;
  data: {
    reason: 'wiki-changed' | 'no-wiki-change' | 'wiki-empty';
    latestWikiChange: string | null;
    lastCompletedRun: string | null;
    baselineAt: string | null;
    contentFiles: number;
  };
}

/**
 * Return the newest content-file or directory mtime under wiki/. Directory
 * mtimes make page creates, deletes, and renames observable even when the
 * affected file no longer exists. Root log.md is deliberately excluded: it
 * is an audit sink, not source material that should trigger another lint.
 */
function scanWikiTree(wikiDir: string): WikiTreeState {
  if (!fs.existsSync(wikiDir)) return { contentFiles: 0, latestChangeMs: null };

  let contentFiles = 0;
  let latestChangeMs = Number.NEGATIVE_INFINITY;
  const visitedDirectories = new Set<string>();

  const visit = (entryPath: string, relativePath: string): void => {
    if (relativePath === 'log.md') return;

    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      const realPath = fs.realpathSync(entryPath);
      if (visitedDirectories.has(realPath)) return;
      visitedDirectories.add(realPath);
      latestChangeMs = Math.max(latestChangeMs, stat.mtimeMs);

      for (const name of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, name), relativePath ? path.join(relativePath, name) : name);
      }
      return;
    }

    if (stat.isFile()) {
      contentFiles += 1;
      latestChangeMs = Math.max(latestChangeMs, stat.mtimeMs);
    }
  };

  visit(wikiDir, '');
  return {
    contentFiles,
    latestChangeMs: contentFiles === 0 ? null : latestChangeMs,
  };
}

/**
 * Read completion truth from outbound.db. The host eventually mirrors this
 * status into inbound.db, but the container owns processing_ack and updates
 * it immediately after the lint finishes. Using status_changed means edits
 * made by that lint predate its boundary and cannot retrigger it next week.
 */
function lastCompletedRun(seriesId: string, inboundDbPath: string, outboundDbPath: string): string | null {
  const inbound = new Database(inboundDbPath, { readonly: true });
  const outbound = new Database(outboundDbPath, { readonly: true });

  try {
    const taskIds = inbound
      .prepare("SELECT id FROM messages_in WHERE kind = 'task' AND series_id = ?")
      .all(seriesId) as TaskIdRow[];
    const completedAck = outbound.prepare(
      "SELECT status_changed FROM processing_ack WHERE message_id = ? AND status = 'completed'",
    );

    let latestTimestamp: string | null = null;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const { id } of taskIds) {
      const row = completedAck.get(id) as CompletedAckRow | null;
      if (!row) continue;

      const changedMs = Date.parse(row.status_changed);
      if (Number.isNaN(changedMs)) throw new Error(`invalid lint completion timestamp: ${row.status_changed}`);
      if (changedMs > latestMs) {
        latestMs = changedMs;
        latestTimestamp = row.status_changed;
      }
    }
    return latestTimestamp;
  } finally {
    outbound.close();
    inbound.close();
  }
}

/** Wake weekly wiki lint only when wiki content changed after its last success. */
export function evaluateWikiLintGate(
  seriesId: string,
  wikiDir: string = DEFAULT_WIKI_DIR,
  inboundDbPath: string = DEFAULT_INBOUND_DB,
  outboundDbPath: string = DEFAULT_OUTBOUND_DB,
  baselineAt: string | null = null,
): WikiLintGateResult {
  const wiki = scanWikiTree(wikiDir);
  const lastCompleted = lastCompletedRun(seriesId, inboundDbPath, outboundDbPath);
  const comparisonBoundary = lastCompleted ?? baselineAt;
  const boundaryMs = comparisonBoundary ? Date.parse(comparisonBoundary) : Number.NaN;

  if (comparisonBoundary && Number.isNaN(boundaryMs)) {
    throw new Error(`invalid lint boundary: ${comparisonBoundary}`);
  }

  const latestWikiChange = wiki.latestChangeMs === null ? null : new Date(wiki.latestChangeMs).toISOString();
  const wakeAgent = wiki.latestChangeMs !== null && (comparisonBoundary === null || wiki.latestChangeMs > boundaryMs);

  return {
    wakeAgent,
    data: {
      reason: wiki.contentFiles === 0 ? 'wiki-empty' : wakeAgent ? 'wiki-changed' : 'no-wiki-change',
      latestWikiChange,
      lastCompletedRun: lastCompleted,
      baselineAt,
      contentFiles: wiki.contentFiles,
    },
  };
}

function main(): void {
  const seriesId = process.argv[2];
  const baselineAt = process.argv[3] ?? null;
  if (!seriesId) throw new Error('wiki lint gate requires a task series id');

  console.log(
    JSON.stringify(
      evaluateWikiLintGate(seriesId, DEFAULT_WIKI_DIR, DEFAULT_INBOUND_DB, DEFAULT_OUTBOUND_DB, baselineAt),
    ),
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    // Fail open: a broken gate must not silently suppress wiki maintenance.
    console.log(
      JSON.stringify({
        wakeAgent: true,
        data: { gateError: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
}
