/**
 * Test-only (no production import): re-exports the mailbox nesting-guard depth so seam 2's registry and family
 * suites can assert every sweep `wakeContainer`/`killContainer` call happens at mailbox depth zero.
 */
export { _mailboxSessionDepthForTesting } from './session-manager.js';
