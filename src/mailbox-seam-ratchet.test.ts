/**
 * Raw-access ratchet for the mailbox seam.
 *
 * scripts/mailbox-seam-ratchet-scan.ts finds every non-test .ts file, outside
 * the mailbox driver and the fork's mailbox module, that still touches raw
 * session-DB internals or receives a passed session handle. That set must
 * shrink monotonically as the mailbox-seam PR series (docs/specs/upstream-mailbox-seam/plan.md)
 * moves each caller behind withMailboxSession/withExistingMailboxSession — a
 * file can leave src/mailbox/RATCHET.json, never re-enter it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { computeOffenders } from './mailbox-seam-ratchet.js';
import { DEFERRED_UPSTREAM_FILES, UPSTREAM_FILES } from './mailbox-seam-manifest.js';
import type { DeliveryActionHandler } from './delivery.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const RATCHET_PATH = path.join(REPO_ROOT, 'src/mailbox/RATCHET.json');
const allowlist: string[] = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
const allowlistSet = new Set(allowlist);

describe('no raw session-DB access or passed session handle outside the mailbox modules except the committed allowlist', () => {
  const offenders = computeOffenders();
  const offenderFileSet = new Set(offenders.map((o) => o.file));

  it('every offending file is in the committed allowlist (RATCHET.json only shrinks)', () => {
    const newOffenders = offenders.filter((o) => !allowlistSet.has(o.file));
    expect(
      newOffenders,
      newOffenders.length > 0
        ? `New raw session-DB access outside the mailbox modules in: ${newOffenders
            .map((o) => `${o.file} [${o.patterns.join(',')}]`)
            .join(', ')}. ` +
            'RATCHET.json is a ratchet — it may only shrink as callers move behind ' +
            'withMailboxSession/withExistingMailboxSession. If this file is intentionally ' +
            'joining the allowlist for a still-in-progress migration PR, add it to ' +
            'src/mailbox/RATCHET.json explicitly rather than relying on this test to pass.'
        : undefined,
    ).toEqual([]);
  });

  it('every allowlisted path is still a real offender (stale entries — deleted or already cleaned up — must be pruned)', () => {
    // Existence alone isn't enough: a caller batch that removes raw DB access
    // from a file but forgets to prune RATCHET.json would pass an
    // existence-only check forever, silently defeating "never re-enter" — the
    // subset check above only catches NEW offenders, not stale allowlist
    // entries that are no longer offenders at all. Require every allowlisted
    // path to still be in the CURRENT offender set.
    const stale = allowlist.filter((relPath) => !offenderFileSet.has(relPath));
    expect(
      stale,
      stale.length > 0
        ? `${stale.join(', ')} no longer matches any raw-access pattern; remove ${
            stale.length === 1 ? 'it' : 'them'
          } from src/mailbox/RATCHET.json (the allowlist only shrinks)`
        : undefined,
    ).toEqual([]);
  });

  // (e) Ratchet target: DeliveryActionHandler is still 3-argument (content, session, inDb).
  // PR 3 removes the inDb parameter and this assertion flips from 3 to 2 — see
  // docs/specs/upstream-mailbox-seam/plan.md §4.5b. Do not change src/delivery.ts to make
  // this pass; it documents where the ratchet is heading, not a target for this PR.
  it('DeliveryActionHandler is still 3-argument — PR 3 narrows it to 2 (upstream contract)', () => {
    expectTypeOf<Parameters<DeliveryActionHandler>['length']>().toEqualTypeOf<3>();
  });

  // The two upstream registry.test.ts files were deliberately deferred out of
  // UPSTREAM_FILES for this PR (they assert the migration's END state — no raw
  // src/db/session-db.ts, entrypoints import the mailbox barrel — which only
  // holds once RATCHET.json is empty). This assertion is the tripwire that
  // catches the deferral being forgotten: once every caller has moved behind
  // the mailbox seam and the allowlist is emptied, both deferred files MUST be
  // back in UPSTREAM_FILES (PR 7 / R3).
  it('once the raw-access allowlist is empty, both deferred registry tests must be ported', () => {
    if (allowlist.length === 0) {
      for (const deferred of DEFERRED_UPSTREAM_FILES) {
        expect(
          UPSTREAM_FILES,
          `RATCHET.json is empty but ${deferred} is still deferred — port it and add it back to UPSTREAM_FILES`,
        ).toContain(deferred);
      }
    }
  });
});
