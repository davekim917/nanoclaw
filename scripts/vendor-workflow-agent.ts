/**
 * CLI shim — vendor ~/plugins/bootstrap's worker agent def into the container tree.
 * All logic (and the vendored path map) lives in src/workflow-agent-vendor.ts.
 */
import { vendorWorkflowAgent } from '../src/workflow-agent-vendor.js';

const changed = vendorWorkflowAgent();
for (const p of changed) console.log(`synced ${p}`);
console.log(
  changed.length === 0
    ? 'already in sync'
    : `${changed.length} path(s) synced — review with git diff, run tests, commit`,
);
