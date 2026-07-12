import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateWikiLintGate } from './wiki-lint-gate.js';

const SERIES_ID = 'memory-lint-ag-1';
const OLD = '2000-01-01T00:00:00.000Z';
const COMPLETED = '2001-01-01T00:00:00.000Z';
const NEW = '2002-01-01T00:00:00.000Z';
const tempDirs: string[] = [];

interface Fixtures {
  dir: string;
  wikiPath: string;
  inboundPath: string;
  outboundPath: string;
  inbound: Database;
  outbound: Database;
}

function fixtures(): Fixtures {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-lint-gate-'));
  tempDirs.push(dir);
  const wikiPath = path.join(dir, 'wiki');
  const inboundPath = path.join(dir, 'inbound.db');
  const outboundPath = path.join(dir, 'outbound.db');
  fs.mkdirSync(wikiPath);

  const inbound = new Database(inboundPath);
  inbound.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      series_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  const outbound = new Database(outboundPath);
  outbound.exec(`
    CREATE TABLE processing_ack (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);

  return { dir, wikiPath, inboundPath, outboundPath, inbound, outbound };
}

function writeWikiFile(f: Fixtures, relativePath: string, contents = '# Page\n'): string {
  const filePath = path.join(f.wikiPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function setMtime(filePath: string, timestamp: string): void {
  const date = new Date(timestamp);
  fs.utimesSync(filePath, date, date);
}

function setTreeMtime(root: string, timestamp: string): void {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) setTreeMtime(entryPath, timestamp);
    setMtime(entryPath, timestamp);
  }
  setMtime(root, timestamp);
}

function addOccurrence(
  f: Fixtures,
  id: string,
  ackStatus: 'completed' | 'failed' | 'processing',
  statusChanged: string,
  inboundStatus = 'pending',
): void {
  f.inbound
    .prepare('INSERT INTO messages_in (id, kind, series_id, status) VALUES (?, ?, ?, ?)')
    .run(id, 'task', SERIES_ID, inboundStatus);
  f.outbound
    .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
    .run(id, ackStatus, statusChanged);
}

function closeFixtures(f: Fixtures): void {
  f.inbound.close();
  f.outbound.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('evaluateWikiLintGate', () => {
  it('skips an empty wiki', () => {
    const f = fixtures();
    closeFixtures(f);

    expect(evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath)).toEqual({
      wakeAgent: false,
      data: {
        reason: 'wiki-empty',
        latestWikiChange: null,
        lastCompletedRun: null,
        baselineAt: null,
        contentFiles: 0,
      },
    });
  });

  it('treats a wiki containing only log.md as empty', () => {
    const f = fixtures();
    writeWikiFile(f, 'log.md', '# Wiki activity log\n');
    setTreeMtime(f.wikiPath, NEW);
    closeFixtures(f);

    const result = evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath);
    expect(result.wakeAgent).toBe(false);
    expect(result.data.reason).toBe('wiki-empty');
    expect(result.data.contentFiles).toBe(0);
  });

  it('wakes for a populated wiki when lint has never completed', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    setTreeMtime(f.wikiPath, OLD);
    closeFixtures(f);

    expect(evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath).wakeAgent).toBe(true);
  });

  it('uses an explicit deployment baseline until the series has a completed run', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    setTreeMtime(f.wikiPath, OLD);
    closeFixtures(f);

    const result = evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath, COMPLETED);
    expect(result.wakeAgent).toBe(false);
    expect(result.data.baselineAt).toBe(COMPLETED);
  });

  it('uses outbound completion time even before inbound status sync', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    setTreeMtime(f.wikiPath, OLD);
    addOccurrence(f, 'task-1', 'completed', COMPLETED, 'pending');
    closeFixtures(f);

    const result = evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath);
    expect(result.wakeAgent).toBe(false);
    expect(result.data.lastCompletedRun).toBe(COMPLETED);
  });

  it('wakes when a wiki file changed after the latest completed lint', () => {
    const f = fixtures();
    const indexPath = writeWikiFile(f, 'index.md');
    setTreeMtime(f.wikiPath, OLD);
    setMtime(indexPath, NEW);
    addOccurrence(f, 'task-1', 'completed', COMPLETED);
    closeFixtures(f);

    const result = evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath);
    expect(result.wakeAgent).toBe(true);
    expect(result.data.latestWikiChange).toBe(NEW);
  });

  it('ignores log-only edits after the latest completed lint', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    const logPath = writeWikiFile(f, 'log.md');
    setTreeMtime(f.wikiPath, OLD);
    setMtime(logPath, NEW);
    addOccurrence(f, 'task-1', 'completed', COMPLETED);
    closeFixtures(f);

    expect(evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath).wakeAgent).toBe(false);
  });

  it('detects a deleted page from the containing directory mtime', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    const deletedPath = writeWikiFile(f, 'entities/deleted.md');
    setTreeMtime(f.wikiPath, OLD);
    addOccurrence(f, 'task-1', 'completed', COMPLETED);
    fs.rmSync(deletedPath);
    closeFixtures(f);

    expect(evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath).wakeAgent).toBe(true);
  });

  it('does not let a failed occurrence suppress the next lint', () => {
    const f = fixtures();
    writeWikiFile(f, 'index.md');
    setTreeMtime(f.wikiPath, OLD);
    addOccurrence(f, 'task-1', 'failed', NEW);
    closeFixtures(f);

    expect(evaluateWikiLintGate(SERIES_ID, f.wikiPath, f.inboundPath, f.outboundPath).wakeAgent).toBe(true);
  });
});
