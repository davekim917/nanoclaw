#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_NODE_VERSION = '22.19.0';

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isNodeVersionSupported(version) {
  const parsed = parseVersion(version);
  const minimum = parseVersion(MIN_NODE_VERSION);
  if (!parsed || !minimum) return false;

  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] !== minimum[index]) return parsed[index] > minimum[index];
  }
  return true;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const version = process.argv[2] ?? process.versions.node;
  if (!isNodeVersionSupported(version)) {
    console.error(`Unsupported Node.js ${version}; NanoClaw requires >=${MIN_NODE_VERSION}.`);
    process.exitCode = 1;
  }
}
