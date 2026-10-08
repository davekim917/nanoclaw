#!/usr/bin/env tsx
/**
 * Exit 1 when `<root>/node_modules` holds a package link that leaves the checkout or dangles. Default root: cwd.
 *
 *   tsx scripts/check-dependency-links.ts [--root <dir>]
 */
import path from 'node:path';

import { brokenDependencyLinks, describeBrokenDependencyLink } from '../src/dependency-links.js';

const rootFlag = process.argv.indexOf('--root');
const root = path.resolve(rootFlag === -1 ? process.cwd() : (process.argv[rootFlag + 1] ?? process.cwd()));

const broken = brokenDependencyLinks(root);
if (broken.length === 0) {
  console.log(`dependency links: ok (${path.join(root, 'node_modules')})`);
  process.exit(0);
}
console.error(`dependency links: ${broken.length} link(s) under ${path.join(root, 'node_modules')} leave the checkout or dangle:`);
for (const b of broken) console.error(`  ${describeBrokenDependencyLink(root, b)}`);
console.error('A fresh `pnpm install --frozen-lockfile` from this checkout rewrites them.');
process.exit(1);
