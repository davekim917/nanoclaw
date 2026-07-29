#!/usr/bin/env node
/**
 * scripts/audit-memory-splitting.ts — is the curator fragmenting facts?
 *
 * The curator may split an over-long fact into several candidates. That is
 * correct when the content really is several facts and wrong when the parts
 * only make sense together, because retrieval ranks each fact independently:
 * a query can surface part two without part one, and every part carries its
 * own provenance marker, so the overhead multiplies.
 *
 * Facts written by ONE decision share an identical evidence-ID set and an
 * identical captured= stamp — both are derived from the same episode. Those
 * groups are the only population where splitting can have happened; everything
 * else was written independently. Co-capture is normal and healthy on its own
 * (one episode legitimately yields several distinct facts), so this reports
 * groups for inspection rather than calling them defects.
 *
 * What to look for: a rising share of facts in groups, groups growing past
 * three or four, or members that read as sentence fragments of one thought
 * rather than standalone facts. The decisive test is semantic — does each
 * member stand alone? — and is left to the reader or a judge model.
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-memory-splitting.ts [--workgroup <id>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';

interface Group {
  workgroupId: string;
  capturedAt: string;
  evidence: string;
  facts: string[];
}

const MARKER = /evidence=([^;]+);captured=([^\s]+?)\s*-->/;

export function groupCoCapturedFacts(content: string, workgroupId: string): Group[] {
  const byKey = new Map<string, Group>();
  for (const line of content.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const marker = MARKER.exec(line);
    const markerAt = line.indexOf('<!--');
    if (!marker || markerAt < 0) continue;
    const key = `${marker[1]}\u0000${marker[2]}`;
    const group = byKey.get(key) ?? {
      workgroupId,
      capturedAt: marker[2]!,
      evidence: marker[1]!,
      facts: [],
    };
    group.facts.push(line.slice(2, markerAt).trim());
    byKey.set(key, group);
  }
  return [...byKey.values()];
}

function main(): void {
  const argv = process.argv.slice(2);
  const only = argv.includes('--workgroup') ? argv[argv.indexOf('--workgroup') + 1] : undefined;
  const asJson = argv.includes('--json');

  const root = path.join(DATA_DIR, 'workgroups');
  const groups: Group[] = [];
  let totalFacts = 0;
  for (const workgroupId of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (only && workgroupId !== only) continue;
    const file = path.join(root, workgroupId, 'memory', 'generated', 'memory.md');
    if (!fs.existsSync(file)) continue;
    const found = groupCoCapturedFacts(fs.readFileSync(file, 'utf8'), workgroupId);
    totalFacts += found.reduce((sum, group) => sum + group.facts.length, 0);
    groups.push(...found.filter((group) => group.facts.length > 1));
  }

  const inGroups = groups.reduce((sum, group) => sum + group.facts.length, 0);
  const sizes: Record<number, number> = {};
  for (const group of groups) sizes[group.facts.length] = (sizes[group.facts.length] ?? 0) + 1;
  const summary = {
    totalFacts,
    coCapturedGroups: groups.length,
    factsInGroups: inGroups,
    percentInGroups: totalFacts ? Number(((100 * inGroups) / totalFacts).toFixed(1)) : 0,
    groupSizes: sizes,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ summary, groups }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `facts ${summary.totalFacts}  groups ${summary.coCapturedGroups}  ` +
      `in-groups ${summary.factsInGroups} (${summary.percentInGroups}%)  sizes ${JSON.stringify(sizes)}\n\n`,
  );
  for (const group of [...groups].sort((a, b) => b.facts.length - a.facts.length)) {
    process.stdout.write(`-- ${group.workgroupId}  ${group.facts.length} facts  ${group.capturedAt}\n`);
    // Does each line below stand alone? That is the whole question.
    for (const fact of group.facts) process.stdout.write(`     * ${fact.slice(0, 160)}\n`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) main();
