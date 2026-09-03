/**
 * The fork's registry test — the stand-in for upstream's
 * `src/mailbox/registry.test.ts`, which cannot be carried byte-for-byte here.
 *
 * Four of upstream's assertions describe upstream's own tree rather than this
 * migration's end state: two of the five files it reads do not exist in the
 * fork, and it forbids `better-sqlite3` in `session-manager.ts` and
 * `host-sweep.ts`, where the fork legitimately holds CENTRAL-DB access the
 * mailbox seam never claimed to move. Its entry-chain assertion names
 * `src/index.ts`, which in this fork is a three-line deploy crash-guard shim
 * with the barrel import one file further in. The full reasoning, and the
 * machine-checked link back to this file, live in `UNPORTABLE_UPSTREAM_FILES`
 * (src/mailbox-seam-manifest.ts).
 *
 * Every invariant upstream asserts is asserted here, against the topology the
 * fork actually has. See docs/specs/upstream-mailbox-seam/plan.md §4.1.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from '../../mailbox/index.js';
import { SqliteAgentMailbox } from '../../mailbox/sqlite/index.js';
import type { AgentMailbox } from '../../mailbox/types.js';
import { computeOffenders } from '../../mailbox-seam-ratchet.js';
import { NanoclawAgentMailbox } from './index.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const read = (relPath: string): string => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

const composedFactory = resetAgentMailboxForTesting();
const fakeMailbox = (): AgentMailbox => ({}) as AgentMailbox;

beforeEach(() => {
  resetAgentMailboxForTesting();
});

afterEach(() => {
  resetAgentMailboxForTesting();
  if (composedFactory) registerAgentMailbox(composedFactory);
});

describe('agent mailbox registry', () => {
  it('uses the explicitly registered OSS implementation', () => {
    registerAgentMailbox(() => new SqliteAgentMailbox());
    expect(getAgentMailbox()).toBeInstanceOf(SqliteAgentMailbox);
  });

  it('composes the fork implementation through the one sanctioned slot', () => {
    // Upstream registers SqliteAgentMailbox in its own compose.ts; the fork's
    // is the single file allowed to differ, and this is what it must say.
    expect(read('src/mailbox/compose.ts')).toContain('registerAgentMailbox(() => new NanoclawAgentMailbox());');
    registerAgentMailbox(() => new NanoclawAgentMailbox());
    expect(getAgentMailbox()).toBeInstanceOf(NanoclawAgentMailbox);
    expect(getAgentMailbox()).toBeInstanceOf(SqliteAgentMailbox);
  });

  it('keeps the host entrypoint on the real composition barrel', () => {
    expect(read('src/modules/index.ts')).toContain("import '../mailbox/compose.js';");
    // The fork's `src/index.ts` is a deploy crash-guard shim that must stay
    // free of static imports, so the barrel is reached from `main.ts` — which
    // that shim is the only thing that loads.
    expect(read('src/index.ts')).toContain("await import('./main.js')");
    expect(read('src/main.ts')).toContain("import './modules/index.js';");
  });

  it('keeps session SQLite code inside the mailbox modules', () => {
    // The transitional re-export façade is gone (mailbox seam PR 7); upstream's
    // driver copy is where the session-DB statements live.
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/db/session-db.ts'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'src/mailbox/sqlite/session-db.ts'))).toBe(true);

    // Upstream checks five host files for raw SQLite. Two of them do not exist
    // in this fork; of the three that do, `session-manager.ts` and
    // `host-sweep.ts` still hold CENTRAL-DB access, which is a different
    // database and out of the seam's scope. What must be true of all of them
    // is the seam's actual invariant: no session-DB opener, no session-DB path
    // helper, and no passed session handle — which is exactly the question the
    // ratchet scanner answers, so this asks it rather than writing a second
    // pattern set that could drift from it.
    const offenders = new Set(computeOffenders().map((o) => o.file));
    for (const relative of ['src/session-manager.ts', 'src/modules/scheduling/recurrence.ts']) {
      expect(offenders.has(relative), `${relative} still reaches a session DB directly`).toBe(false);
    }
    // `src/host-sweep.ts` is deliberately absent from that list: its usage
    // rollup reads outbound.db through the module's open funnel on purpose
    // (the seam's existence gate is inbound-keyed and stranded turn_usage
    // rows), so it is a documented entry on RATCHET.json rather than a clean
    // file. `src/mailbox-seam-ratchet.test.ts` is what pins that exemption —
    // asserting it here too would just duplicate the pin in a second place.
  });

  it('does not hide a missing composition behind a fallback', () => {
    expect(() => getAgentMailbox()).toThrow('No agent mailbox registered');
  });

  it('lets a skill install the active implementation without a selector', () => {
    const mailbox = fakeMailbox();
    registerAgentMailbox(() => mailbox);
    expect(getAgentMailbox()).toBe(mailbox);
  });

  it('rejects two implementations for the same capability', () => {
    registerAgentMailbox(fakeMailbox);
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });

  it('rejects registration after the fallback was resolved', () => {
    registerAgentMailbox(fakeMailbox);
    getAgentMailbox();
    expect(() => registerAgentMailbox(fakeMailbox)).toThrow('already registered');
  });
});
