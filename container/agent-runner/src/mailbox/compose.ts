/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { NanoclawAgentMailbox } from '../modules/mailbox/index.js';

registerAgentMailbox(() => new NanoclawAgentMailbox());
