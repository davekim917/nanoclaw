import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

describe('memory curator user-path isolation', () => {
  it('keeps router and delivery limited to synchronous archive scheduling with no model dependency', () => {
    for (const file of ['src/router.ts', 'src/delivery.ts']) {
      const text = source(file);
      expect(text).toContain("import { archiveMessageAndScheduleMemoryCuration } from './message-archive.js'");
      expect(text).not.toMatch(/await\s+archiveMessageAndScheduleMemoryCuration\s*\(/);
      expect(text).not.toMatch(/curator-(?:backend|worker)|callClaudeStructured|MemoryCuratorBackend/);
    }

    const archive = source('src/message-archive.ts');
    const start = archive.indexOf('export function archiveMessageAndScheduleMemoryCuration(');
    const end = archive.indexOf('\nfunction toMemoryCurationEpisode', start);
    const schedulingPath = archive.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(schedulingPath).not.toMatch(/\bawait\b|\bfetch\s*\(|MemoryCurator|callClaude/);
    expect(schedulingPath).toContain('const tx = db.transaction');
  });

  it('starts model work only from the non-overlapping fire-and-forget host sweep pump', () => {
    const sweep = source('src/host-sweep.ts');
    expect(sweep).toMatch(
      /import\s*\{[^}]*runMemoryCurationInBackground[^}]*stopMemoryCurationInBackground[^}]*\}\s*from '\.\/modules\/memory\/curator-worker\.js'/,
    );
    expect(sweep).toMatch(/void runMemoryCurationInBackground\(\)\.catch/);
    expect(sweep).not.toMatch(/await\s+runMemoryCurationInBackground\(\)/);
  });
});
