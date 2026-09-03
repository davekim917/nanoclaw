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

import { computeOffenders, RATCHET_SCAN_ROOTS } from './mailbox-seam-ratchet.js';
import { DEFERRED_UPSTREAM_FILES, UNPORTABLE_UPSTREAM_FILES, UPSTREAM_FILES } from './mailbox-seam-manifest.js';
import type { DeliveryActionHandler } from './delivery.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const RATCHET_PATH = path.join(REPO_ROOT, 'src/mailbox/RATCHET.json');
const allowlist: string[] = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
const allowlistSet = new Set(allowlist);

/**
 * The host half of the allowlist is DONE (PR 7), so it is no longer a
 * shrinking subset — it is an exact set, and this is what it may contain.
 * Every entry is a DOCUMENTED exemption with its rationale written at the top
 * of the file it names; adding a third means writing that justification first.
 *
 *  - `src/storage-manager.ts`: reclaim probes run in a worker thread over an
 *    INJECTED sessions root, which the DATA_DIR-keyed mailbox cannot address,
 *    and they are strictly read-only.
 *  - `src/host-sweep.ts`: the usage rollup reads outbound.db through the
 *    module's own open funnel rather than a mailbox session. The seam's
 *    existence check is keyed on inbound.db, so routing a pure OUTBOUND
 *    projection through it stranded the `turn_usage` rows of every session
 *    whose inbound.db was gone (mailbox seam PR 5). The funnel also carries
 *    PR 5's unopenable-DB classification, which the read-only session does
 *    not, so this is a behavior requirement rather than a style preference.
 */
const HOST_ALLOWLIST_EXEMPTIONS = ['src/host-sweep.ts', 'src/storage-manager.ts'];
const RUNNER_ROOT = 'container/agent-runner/src';
const isRunnerPath = (relPath: string): boolean => relPath.startsWith(RUNNER_ROOT + '/');

describe('no raw session-DB access or passed session handle outside the mailbox modules except the committed allowlist', () => {
  const offenders = computeOffenders();
  const offenderFileSet = new Set(offenders.map((o) => o.file));

  // H-1b, host half. The runner half is still a subset check (R3 empties it);
  // the host half is now an EXACT set — anything outside the documented
  // exemptions is a regression, not a migration still in flight.
  it('the host allowlist is empty except the documented probes', () => {
    const hostEntries = allowlist.filter((relPath) => !isRunnerPath(relPath));
    expect(
      hostEntries,
      `The host half of the mailbox seam is complete (docs/specs/upstream-mailbox-seam/plan.md PR 7). ` +
        `src/mailbox/RATCHET.json may list only ${HOST_ALLOWLIST_EXEMPTIONS.join(', ')} under src/. ` +
        `A new host caller belongs behind withMailboxSession/withExistingMailboxSession and a named op ` +
        `in src/modules/mailbox/, not on this list.`,
    ).toEqual(HOST_ALLOWLIST_EXEMPTIONS);
    // And the scan really does cover the host tree, so an emptied list is a
    // finished migration rather than a scanner that stopped looking.
    expect(RATCHET_SCAN_ROOTS).toContain('src');
  });

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

  // (e) PR 3 landed the two-argument contract: DeliveryActionHandler is
  // upstream's (content, session), and no handler receives a session handle
  // any more (docs/specs/upstream-mailbox-seam/plan.md §4.5b, invariant I-9).
  // This is now a ratchet, not a target — a third parameter must never come
  // back, because the delivery loop holds no session while a handler runs and
  // a handle passed across that boundary would be closed or nesting.
  it('DeliveryActionHandler is 2-argument (content, session) — no handler receives a session handle', () => {
    expectTypeOf<Parameters<DeliveryActionHandler>['length']>().toEqualTypeOf<2>();
  });

  // The two upstream registry.test.ts files were deliberately held out of
  // UPSTREAM_FILES: they assert the migration's END state (no raw
  // src/db/session-db.ts, entrypoints import the mailbox barrel), which only
  // holds once a tree's callers are all behind the seam.
  //
  // The original tripwire keyed on the WHOLE allowlist reaching zero. That can
  // never happen now — src/storage-manager.ts is a permanent documented
  // exemption (see the top of that file) — so the check would have sat dead
  // forever. It is per-half instead: the runner's entry lands when the runner
  // half is done, which is R3's gate.
  it("once the runner allowlist is empty, the runner's deferred registry test must be ported", () => {
    const runnerEntries = allowlist.filter(isRunnerPath);
    if (runnerEntries.length > 0) return;
    for (const deferred of DEFERRED_UPSTREAM_FILES) {
      expect(
        UPSTREAM_FILES,
        `the runner half of RATCHET.json is empty but ${deferred} is still deferred — port it and add it back to UPSTREAM_FILES`,
      ).toContain(deferred);
    }
  });

  // The host's registry.test.ts is not deferred, it is UNPORTABLE: four of its
  // assertions describe upstream's own tree rather than this migration's end
  // state (see UNPORTABLE_UPSTREAM_FILES for the reasons). Both halves of that
  // decision are checked, so it cannot rot into a silent omission: the
  // fork-owned replacement has to exist, and the upstream path must stay out
  // of UPSTREAM_FILES — adding it would put a permanently red test in CI.
  for (const entry of UNPORTABLE_UPSTREAM_FILES) {
    it(`${entry.upstream} is replaced by ${entry.forkTest}, not carried verbatim`, () => {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.forkTest)), `${entry.forkTest} is missing`).toBe(true);
      expect(entry.reason.length, `${entry.upstream} needs a written reason`).toBeGreaterThan(0);
      expect(
        UPSTREAM_FILES,
        `${entry.upstream} cannot pass byte-for-byte on this fork — see UNPORTABLE_UPSTREAM_FILES`,
      ).not.toContain(entry.upstream);
    });
  }
});
