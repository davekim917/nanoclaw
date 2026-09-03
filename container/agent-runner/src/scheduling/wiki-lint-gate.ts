import fs from 'node:fs';
import path from 'node:path';

import { readSeriesLastCompletedRun } from '../modules/mailbox/index.js';

const DEFAULT_WIKI_DIR = '/workspace/agent/wiki';

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

/** Wake weekly wiki lint only when wiki content changed after its last success. */
export function evaluateWikiLintGate(
  seriesId: string,
  wikiDir: string = DEFAULT_WIKI_DIR,
  baselineAt: string | null = null,
): WikiLintGateResult {
  const wiki = scanWikiTree(wikiDir);
  const lastCompleted = readSeriesLastCompletedRun(seriesId);
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

  console.log(JSON.stringify(evaluateWikiLintGate(seriesId, DEFAULT_WIKI_DIR, baselineAt)));
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
