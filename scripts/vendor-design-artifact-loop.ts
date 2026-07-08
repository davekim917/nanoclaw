/**
 * CLI shim — vendor ~/plugins/design-artifact-loop into the container tree.
 * All logic (and the vendored path map) lives in src/design-artifact-loop-vendor.ts.
 */
import { vendorDesignArtifactLoop } from '../src/design-artifact-loop-vendor.js';

const changed = vendorDesignArtifactLoop();
for (const p of changed) console.log(`synced ${p}`);
console.log(changed.length === 0 ? 'already in sync' : `${changed.length} path(s) synced — review with git diff, run tests, commit`);
