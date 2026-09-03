/**
 * Seam-2-owned test hook: the mailbox nesting-guard depth probe.
 *
 * R-10 asserts that every real `wakeContainer`/`killContainer` call the sweep
 * makes happens at mailbox depth zero. The probe itself is one read of the
 * nesting guard's own `AsyncLocalStorage` store, which `session-manager.ts`
 * owns and exports as `_mailboxSessionDepthForTesting`.
 *
 * It lived as a re-export in `src/modules/mailbox/session.ts` until upstream's
 * mailbox seam began deleting that file. Nothing about the probe is
 * mailbox-module business — it exists only so seam 2's registry and family
 * suites can make the I-3 assertion — so it moves here, beside the seam that
 * needs it, rather than riding an import block the mailbox seam rewrites.
 *
 * Test-only. No production code imports this file.
 */
export { _mailboxSessionDepthForTesting } from './session-manager.js';
