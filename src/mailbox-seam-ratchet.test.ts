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

import {
  computeOffenders,
  findOutboundOnlySessions,
  findUnguardedOutboundWrites,
  hostSourcesForOutboundScan,
  OUTBOUND_WRITE_GUARD,
  RATCHET_SCAN_ROOTS,
} from './mailbox-seam-ratchet.js';
import { _classifyCompositionForTesting, computeOpSides, outboundWriteOps } from './modules/mailbox/op-sides.js';
import { composeNanoclawSession } from './modules/mailbox/index.js';
import { DEFERRED_UPSTREAM_FILES, UNPORTABLE_UPSTREAM_FILES, UPSTREAM_FILES } from './mailbox-seam-manifest.js';
import type { DeliveryActionHandler } from './delivery.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const RATCHET_PATH = path.join(REPO_ROOT, 'src/mailbox/RATCHET.json');
const allowlist: string[] = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
const allowlistSet = new Set(allowlist);

/**
 * The host half of the allowlist is DONE (PR 7), so it is no longer a
 * shrinking subset — it is an exact set, and this is what it may contain.
 *
 * `src/storage-manager.ts` is the single documented exemption: its reclaim
 * probes run in a worker thread over an INJECTED sessions root, which the
 * DATA_DIR-keyed mailbox cannot address, and they are strictly read-only. The
 * rationale lives at the top of that file; adding a second entry here means
 * writing the same kind of justification there first.
 */
const HOST_ALLOWLIST_EXEMPTIONS = ['src/storage-manager.ts'];
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
  // R3 emptied the runner half, so it is an EXACT set too, symmetric with the
  // host assertion above. Without this, the generic subset and stale-entry
  // checks below both ACCEPT a newly added runner entry (it is not a "new
  // offender" once listed, and it is not stale while it still matches), and
  // the port gate right below returns early the moment one exists — so a
  // finished half could silently reopen while all three tests stayed green.
  // "Leave once, never re-enter" has to be asserted, not just narrated.
  it('the runner allowlist is empty and stays empty', () => {
    expect(
      allowlist.filter(isRunnerPath),
      'The runner half of the mailbox seam is complete (R3). A new runner caller belongs behind the ' +
        'runner mailbox module, not on src/mailbox/RATCHET.json — this list may not grow again.',
    ).toEqual([]);
    expect(RATCHET_SCAN_ROOTS).toContain(RUNNER_ROOT);
  });

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

  // An inbound-keyed session whose action needs nothing from inbound.db
  // answers `undefined` for a session whose inbound.db is gone while
  // outbound.db remains, and the caller then reports outbound state as empty
  // when it is not. Two instances of that shipped before this rule existed:
  // the usage rollup, and thread-close's done-proposal read. The fix is
  // `withExistingNanoclawOutbound`, which asks an outbound-only existence
  // question.
  //
  // EMPTY, and it got there the honest way — every entry was fixed, none was
  // deleted. `router.ts` in round 4 (both notices moved to the outbound
  // funnel); `container-restart.ts`'s drain probe and `host-sweep.ts`'s usage
  // rollup by PR 4 and PR 6, arriving with the cascade.
  //
  // Worth keeping the record of why `router.ts` was ever allowlisted, because
  // the reasoning was wrong in an instructive way: the entry said the writes go
  // to a session the router has just resolved, so inbound.db is "almost
  // certainly there". Resolving a session is a central-DB fact; it says nothing
  // about whether that session's inbound.db still exists on disk. Review caught
  // it. "Safe today" was never the question this rule asks — the question is
  // whether the existence check is keyed on the file the action actually
  // touches.
  const OUTBOUND_ONLY_SESSION_ALLOWLIST: string[] = [];

  it('no NEW inbound-keyed session does outbound-only work', () => {
    const matches = findOutboundOnlySessions(hostSourcesForOutboundScan(), computeOpSides());
    const offenders = matches.filter((m) => !OUTBOUND_ONLY_SESSION_ALLOWLIST.includes(m.file));
    expect(
      offenders.map((m) => `${m.file}:${m.line} [${m.ops.join(',')}]`),
      offenders.length > 0
        ? 'These actions use only outbound-side ops inside an inbound-keyed mailbox session, so they ' +
            'answer `undefined` for a session whose inbound.db is gone while outbound.db remains. Use ' +
            '`withExistingNanoclawOutbound` instead — it asks an outbound-only existence question.'
        : undefined,
    ).toEqual([]);
  });

  it('every allowlisted file still has such a call (stale entries must be pruned)', () => {
    const files = new Set(findOutboundOnlySessions(hostSourcesForOutboundScan(), computeOpSides()).map((m) => m.file));
    const stale = OUTBOUND_ONLY_SESSION_ALLOWLIST.filter((f) => !files.has(f));
    expect(
      stale,
      stale.length > 0 ? `${stale.join(', ')} no longer matches; remove it from the allowlist` : undefined,
    ).toEqual([]);
  });

  // The checker itself, driven over a string so the property is pinned even
  // once every real call site is fixed: this is exactly the shape
  // thread-close.ts carried before it moved to the outbound funnel.
  it('flags an inbound-keyed session doing an outbound-only read', () => {
    const bad = `
      async function readSessionProposal(agentGroupId: string, sessionId: string) {
        return (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.readDoneProposal())) ?? null;
      }`;
    const hits = findOutboundOnlySessions([{ file: 'fixture.ts', src: bad }], computeOpSides());
    expect(hits).toHaveLength(1);
    expect(hits[0].ops).toEqual(['readDoneProposal']);
  });

  it('does not flag a session that also touches inbound', () => {
    const fine = `
      await withExistingMailboxSession(a, b, (mailbox) => {
        mailbox.readDoneProposal();
        return mailbox.inboundHasMessage('m-1');
      });`;
    expect(findOutboundOnlySessions([{ file: 'fixture.ts', src: fine }], computeOpSides())).toEqual([]);
  });
});

describe('host outbound writes go through the stopped-container guard', () => {
  // `outbound.db` has ONE writer. A host write to a session a container owns
  // deletes the fresh runner's processing claim, pushes its continuation back
  // to `queued`, or contends for the write lock — and the window is real,
  // because opening a mailbox session is a yield and a wake can land in it.
  // Review found four instances of this by reading; reading is not a check.
  //
  // The sanctioned shape is `withStoppedContainerSession`, which re-checks
  // container ownership INSIDE the session, immediately before the write.

  // The op set is derived from the composition, so this pins the derivation
  // rather than the list: a write from each half, and no read from either.
  it('the write-op set is derived from both halves of the composed session', () => {
    const writes = outboundWriteOps();
    expect(writes.has('writeOutboundDirect'), 'fork half: forkOps over writableOutbound').toBe(true);
    expect(writes.has('deleteOrphanProcessingClaims'), 'upstream half: wrapSqliteOutbound over writable()').toBe(true);
    for (const read of ['readDoneProposal', 'readWorkContinuation', 'getDueMessages', 'getProcessingClaims']) {
      expect(writes.has(read), `${read} is a read and must not be in the write set`).toBe(false);
    }
  });

  // A ratchet, not a target — and the two entries are NOT the same kind of
  // debt:
  //
  //  - src/host-sweep.ts leaves on the cascade merge. PR 5's head puts both
  //    continuation writes behind `withStoppedContainerSession`; running this
  //    checker over that host-sweep.ts reports nothing.
  // EMPTY. `src/host-sweep.ts` left it exactly as predicted when the rule was
  // written: PR 5's `withStoppedContainerSession` arrived with the cascade and
  // both continuation writes are behind it.
  //
  // `src/router.ts` left for a different reason, and NOT because the property
  // now holds there — because its two notices moved to
  // `withExistingNanoclawOutbound`, which is not a `with*Session` call and so
  // is outside this rule's lexical reach entirely. This rule covers writes made
  // through the MAILBOX SESSION. Writes through the outbound funnel (the
  // router's notices, thread-close's force-clear) are a separate class,
  // deliberately made while a container may be running, and
  // `withStoppedContainerSession` is not their remedy — allowlisting them here
  // would only record "this one is fine" under a rule whose fix does not apply.
  // If that class wants a check, it wants its own.
  const OUTBOUND_WRITE_ALLOWLIST: string[] = [];

  it('no NEW host outbound write sits outside the guard', () => {
    const matches = findUnguardedOutboundWrites(hostSourcesForOutboundScan(), outboundWriteOps());
    const offenders = matches.filter((m) => !OUTBOUND_WRITE_ALLOWLIST.includes(m.file));
    expect(
      offenders.map((m) => `${m.file}:${m.line} [${m.ops.join(',')}]`),
      offenders.length > 0
        ? `These session actions write outbound.db without ${OUTBOUND_WRITE_GUARD}, so a container that ` +
            'takes the session during the open owns the file the write lands on. Wrap the action in ' +
            `${OUTBOUND_WRITE_GUARD} — it re-checks ownership inside the session, immediately before the write.`
        : undefined,
    ).toEqual([]);
  });

  it('every allowlisted file still has such a write (stale entries must be pruned)', () => {
    const files = new Set(
      findUnguardedOutboundWrites(hostSourcesForOutboundScan(), outboundWriteOps()).map((m) => m.file),
    );
    const stale = OUTBOUND_WRITE_ALLOWLIST.filter((f) => !files.has(f));
    expect(
      stale,
      stale.length > 0 ? `${stale.join(', ')} no longer matches; remove it from the allowlist` : undefined,
    ).toEqual([]);
  });

  // The checker driven over strings, so the property stays pinned once the
  // cascade has emptied the host-sweep half of the allowlist. This first
  // fixture is the pre-round-7 shape verbatim.
  it('flags the pre-round-7 continuation write', () => {
    const bad = `
      async function incrementStoppedContinuationAttempt(session: Session, expectedId: string) {
        const result = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          expectedId !== 'legacy-pending-next'
            ? mailbox.incrementWorkContinuationResumeAttempt(expectedId)
            : mailbox.migrateLegacyWorkContinuationForRecovery(),
        );
        return result ?? null;
      }`;
    const hits = findUnguardedOutboundWrites([{ file: 'fixture.ts', src: bad }], outboundWriteOps());
    expect(hits).toHaveLength(1);
    expect(hits[0].ops.sort()).toEqual([
      'incrementWorkContinuationResumeAttempt',
      'migrateLegacyWorkContinuationForRecovery',
    ]);
    expect(hits[0].opener).toBe('withExistingMailboxSession');
  });

  it('does not flag the same write once it is behind the guard', () => {
    const fine = `
      async function incrementStoppedContinuationAttempt(session: Session, expectedId: string) {
        const result = await withStoppedContainerSession(session, (mailbox) =>
          mailbox.incrementWorkContinuationResumeAttempt(expectedId),
        );
        return result ?? null;
      }`;
    expect(findUnguardedOutboundWrites([{ file: 'fixture.ts', src: fine }], outboundWriteOps())).toEqual([]);
  });

  // The guard is itself built out of a mailbox session; that inner session
  // must not read as an offender, however deeply the write is nested in it.
  it('does not flag a session nested inside the guard', () => {
    const fine = `
      await withStoppedContainerSession(session, () =>
        withExistingMailboxSession(a, b, (mailbox) => mailbox.writeOutboundDirect(message)),
      );`;
    expect(findUnguardedOutboundWrites([{ file: 'fixture.ts', src: fine }], outboundWriteOps())).toEqual([]);
  });

  it('does not flag a read-only session', () => {
    const fine = `
      await withExistingMailboxSession(a, b, (mailbox) => mailbox.readWorkContinuation());`;
    expect(findUnguardedOutboundWrites([{ file: 'fixture.ts', src: fine }], outboundWriteOps())).toEqual([]);
  });

  // The derivation is only trustworthy if it names EVERY op the session has.
  // `composeNanoclawSession` builds closures and touches no database until one
  // is called, so its key set is available from stub handles and is ground
  // truth. A parser that quietly missed an entry is the failure this module
  // has actually suffered; this is the assertion that cannot miss it.
  it('the derived map names exactly the ops the composed session has', () => {
    const stub = {} as never;
    const actual = Object.keys(
      composeNanoclawSession(
        stub,
        () => stub,
        () => stub,
        true,
      ),
    ).sort();
    const sides = computeOpSides();
    const derived = [...sides.inbound, ...sides.outbound].sort();
    expect(derived).toEqual(actual);
    // And the two halves partition it — no op in both, none in neither.
    expect([...sides.inbound].filter((k) => sides.outbound.has(k))).toEqual([]);
  });

  // The grammar cases a text scanner silently dropped. Each one is a valid
  // composition; each used to remove its ops from BOTH sets, which made both
  // ratchet rules stop covering them while every test stayed green.
  describe('op-side parsing covers the grammar a scanner could not', () => {
    it('a comma inside a string literal does not split an entry', () => {
      const src = `
        function comp(inbound: never, readableOutbound: never) {
          return {
            inboundOp: () => query(inbound, 'SELECT a, b, c FROM t'),
            outboundOp: () => query(readableOutbound(), 'SELECT x, y FROM u'),
          };
        }`;
      const sides = _classifyCompositionForTesting(src, 'comp');
      expect([...sides.inbound]).toEqual(['inboundOp']);
      expect([...sides.outbound]).toEqual(['outboundOp']);
    });

    it('a handle name inside a string is not a handle reference', () => {
      const src = `
        function comp(inbound: never) {
          return {
            looksLikeAWrite: () => log(inbound, 'writableOutbound is not called here'),
          };
        }`;
      const sides = _classifyCompositionForTesting(src, 'comp');
      // Classified from the AST, so the string is text — not a use of the handle.
      expect([...sides.inbound]).toEqual(['looksLikeAWrite']);
      expect([...sides.outbound]).toEqual([]);
    });

    it('a computed key with a literal name is classified, not dropped', () => {
      const src = `
        function comp(readableOutbound: never) {
          return {
            ['computedOutbound']: () => readableOutbound(),
          };
        }`;
      const sides = _classifyCompositionForTesting(src, 'comp');
      expect([...sides.outbound]).toEqual(['computedOutbound']);
    });

    it('a method-syntax and a shorthand entry are both classified', () => {
      const src = `
        const shorthandOp = () => readableOutbound();
        function comp(inbound: never, readableOutbound: never) {
          return {
            methodOp() {
              return inbound;
            },
            shorthandOp,
          };
        }`;
      const sides = _classifyCompositionForTesting(src, 'comp');
      expect([...sides.inbound]).toEqual(['methodOp']);
      expect([...sides.outbound]).toEqual(['shorthandOp']);
    });

    it('a NESTED spread is followed to its leaves', () => {
      const src = `
        function inner(writableOutbound: never) {
          return { innerWrite: () => writableOutbound() };
        }
        function middle(inbound: never, writableOutbound: never) {
          return { ...inner(writableOutbound), middleRead: () => inbound };
        }
        function comp(inbound: never, writableOutbound: never) {
          return { ...middle(inbound, writableOutbound), own: () => inbound };
        }`;
      const sides = _classifyCompositionForTesting(src, 'comp');
      expect([...sides.outbound]).toEqual(['innerWrite']);
      expect([...sides.inbound].sort()).toEqual(['middleRead', 'own']);
    });

    it('a key it cannot evaluate THROWS rather than vanishing', () => {
      const src = `
        function comp(readableOutbound: never) {
          return { [dynamicName]: () => readableOutbound() };
        }`;
      expect(() => _classifyCompositionForTesting(src, 'comp')).toThrow(/computed key/);
    });

    it('a spread it cannot resolve THROWS rather than contributing nothing', () => {
      const src = `
        function comp(inbound: never) {
          return { ...somethingFromAnotherModule, own: () => inbound };
        }`;
      expect(() => _classifyCompositionForTesting(src, 'comp')).toThrow(/cannot resolve/);
    });

    it('a spread cycle THROWS instead of recursing forever', () => {
      const src = `
        function a(inbound: never) {
          return { ...b(inbound) };
        }
        function b(inbound: never) {
          return { ...a(inbound) };
        }`;
      expect(() => _classifyCompositionForTesting(src, 'a')).toThrow(/spread cycle/);
    });
  });

  // Same property, the sibling rule. This one used the length-CHANGING strip
  // and reported a call under a three-line block comment three lines early.
  it('the outbound-only rule reports the real line too', () => {
    const src = [
      '/* one',
      ' * two',
      ' */',
      'const x = 1;',
      'await withExistingMailboxSession(a, b, (m) => m.readDoneProposal());',
    ].join('\n');
    const hits = findOutboundOnlySessions([{ file: 'fixture.ts', src }], computeOpSides());
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(5);
  });

  // Line numbers are the real file's — a failure message that sent the next
  // engineer to the wrong line would be worse than no message.
  it('reports the line the call is on, not the line after comments are removed', () => {
    const src = [
      '/* one',
      ' * two',
      ' */',
      'const x = 1;',
      'await withExistingMailboxSession(a, b, (m) => m.writeOutboundDirect(v));',
    ].join('\n');
    const hits = findUnguardedOutboundWrites([{ file: 'fixture.ts', src }], outboundWriteOps());
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(5);
  });
});
