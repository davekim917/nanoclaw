#!/usr/bin/env bun
import path from 'node:path';

import {
  applySelectedUpdates,
  auditRepository,
  buildScheduledAuditGate,
  describeUpstreamPolicy,
  renderAuditMarkdown,
} from '../src/container-updates.js';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error(
    'usage: bun scripts/container-updates.ts audit [--repo PATH] [--format json|markdown|task]\n'
      + '   or: bun scripts/container-updates.ts apply --repo PATH --items id[,id...]',
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const repoRoot = path.resolve(valueAfter(args, '--repo') ?? process.cwd());
  if (command === 'audit') {
    const format = valueAfter(args, '--format') ?? 'markdown';
    if (!['json', 'markdown', 'task'].includes(format)) usage();
    const items = await auditRepository(repoRoot);
    const upstreamPolicy = await describeUpstreamPolicy(repoRoot);
    if (format === 'task') {
      process.stdout.write(`${JSON.stringify(buildScheduledAuditGate(items, upstreamPolicy))}\n`);
    } else if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), upstreamPolicy, items }, null, 2)}\n`,
      );
    } else {
      const age = upstreamPolicy.generatedAt ? `, generated ${upstreamPolicy.generatedAt}` : '';
      process.stdout.write(`${renderAuditMarkdown(items)}\nUpstream policy source: ${upstreamPolicy.source}${age}\n`);
    }
    if (format !== 'task') {
      process.exitCode = items.some((item) => item.status === 'unknown' || item.status === 'blocked') ? 2 : 0;
    }
    return;
  }
  if (command === 'apply') {
    const rawItems = valueAfter(args, '--items');
    if (!valueAfter(args, '--repo') || !rawItems) usage();
    const selectedIds = rawItems.split(',').map((item) => item.trim()).filter(Boolean);
    const items = await auditRepository(repoRoot);
    await applySelectedUpdates({ repoRoot, items, selectedIds });
    process.stdout.write(`Applied ${selectedIds.length} selected update(s). Review and test the diff before publishing.\n`);
    return;
  }
  usage();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
