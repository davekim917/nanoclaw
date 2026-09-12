import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

/**
 * GitHub rejects `gh label create --description` over 100 characters with
 * `HTTP 422: description is too long (maximum is 100 characters)`. A workflow
 * step that hits this doesn't fail the job — the three `gh label create`
 * calls in shadow-review.yml were each followed by `|| echo "::warning::..."`
 * — so the label is silently never created or updated, and any later step
 * that depends on the label existing (e.g. `gh issue create --label
 * shadow-review`) fails whenever it actually runs.
 *
 * This is what happened: shadow-review.yml's `shadow-review` and
 * `shadow-review-failed` descriptions were both over 100 characters, the
 * `shadow-review` label was never created, and `gh issue create --label
 * shadow-review` failed every time a review produced findings — so findings
 * were never filed.
 *
 * This test parses every `gh label create ... --description "..."` call in
 * every workflow under .github/workflows/ and asserts the description is at
 * most 100 characters. GitHub counts characters, not bytes — an em dash is 1
 * character but 3 UTF-8 bytes — so this checks both, read fresh every run
 * rather than hardcoding today's descriptions, so a future edit is caught too.
 */

const WORKFLOWS_DIR = path.resolve('.github/workflows');
const MAX_LABEL_DESCRIPTION_LENGTH = 100;

// Pairs each `gh label create <name>` with the `--description "..."` that
// follows it (non-greedy, so it stops at the very next `--description`
// rather than skipping ahead to some later label's). None of the current
// descriptions embed a literal double quote, so a plain `[^"]*` capture is
// enough to read them back exactly as `gh` would receive them.
const LABEL_CREATE_RE = /gh label create\s+(\S+)[\s\S]*?--description\s+"([^"]*)"/g;

interface LabelDescription {
  file: string;
  label: string;
  description: string;
}

function findLabelDescriptions(): LabelDescription[] {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const found: LabelDescription[] = [];
  for (const file of files) {
    const contents = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    for (const m of contents.matchAll(LABEL_CREATE_RE)) {
      found.push({ file, label: m[1], description: m[2] });
    }
  }
  return found;
}

describe('workflow gh label create descriptions', () => {
  it('finds at least one gh label create call to check (the test would pass vacuously otherwise)', () => {
    expect(findLabelDescriptions().length).toBeGreaterThan(0);
  });

  it('keeps every gh label create --description at or under the 100-character limit GitHub enforces', () => {
    const overLong = findLabelDescriptions()
      .map(({ file, label, description }) => ({
        file,
        label,
        chars: [...description].length,
        bytes: Buffer.byteLength(description, 'utf8'),
      }))
      .filter(({ chars, bytes }) => chars > MAX_LABEL_DESCRIPTION_LENGTH || bytes > MAX_LABEL_DESCRIPTION_LENGTH);

    expect(overLong).toEqual([]);
  });
});
