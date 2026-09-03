#!/usr/bin/env tsx
/**
 * CLI shim — read or regenerate src/mailbox/UPSTREAM-MANIFEST.json.
 * All logic lives in src/mailbox-seam-manifest.ts.
 */
import { computeManifestFromGit, MANIFEST_PATH, readManifest, writeManifest } from '../src/mailbox-seam-manifest.js';

const args = process.argv.slice(2);
const updateIdx = args.indexOf('--update');
if (updateIdx === -1) {
  // No CLI action requested — just validate the file exists and print it.
  console.log(JSON.stringify(readManifest(), null, 2));
} else {
  const sha = args[updateIdx + 1];
  if (!sha) {
    console.error('Usage: mailbox-seam-manifest.ts --update <upstream-sha>');
    process.exit(1);
  }
  const manifest = computeManifestFromGit(sha);
  writeManifest(manifest);
  console.log(`Wrote ${MANIFEST_PATH} for upstream ${sha} (${Object.keys(manifest.files).length} files)`);
}
