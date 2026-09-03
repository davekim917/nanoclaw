/**
 * Fixture only — never imported outside
 * scripts/mailbox-seam-unreachable.test.ts's negative control. Exercises a
 * top-level mailbox seam call so that test can prove its reset +
 * `vi.resetModules()` harness actually detects a reachable seam op, not just
 * an absent one.
 */
import { getAgentMailbox } from '../../src/mailbox/index.js';

export const mailbox = getAgentMailbox();
