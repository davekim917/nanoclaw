#!/usr/bin/env tsx
/**
 * CLI shim — print the current mailbox-seam raw-access offender set.
 * All logic lives in src/mailbox-seam-ratchet.ts.
 */
import { computeOffenders } from '../src/mailbox-seam-ratchet.js';

const offenders = computeOffenders();
for (const o of offenders) console.log(`${o.file}  [${o.patterns.join(',')}]`);
console.log(`\n${offenders.length} offending file(s)`);
