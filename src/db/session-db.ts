/**
 * Transitional re-export façade over `src/modules/mailbox/`.
 *
 * Every session-DB SQL statement on the host now lives in the fork's mailbox
 * module; this file exists only so the callers that have not yet moved behind
 * `withMailboxSession` / `withExistingMailboxSession` keep their import path
 * and signatures unchanged. Nothing here executes SQL, and nothing new should
 * be added — a new caller imports from `src/modules/mailbox/` (or, better,
 * takes a `MailboxSession`).
 *
 * Deleted by PR 7 of docs/specs/upstream-mailbox-seam/plan.md, once PRs 3-6
 * have emptied `src/mailbox/RATCHET.json`.
 */
export {
  SessionDbMissingError,
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  openOutboundDbWritable,
  recoverHotJournal,
} from '../modules/mailbox/openers.js';

export {
  ensureSchema,
  migrateDeliveredTable,
  migrateMessagesInTable,
  migrateSessionRoutingTable,
} from '../modules/mailbox/schema.js';

export {
  activateRepoIngressFence,
  admitRepoIngressFenceMessage,
  readRepoIngressFence,
  readRepositoryMountBarrierAck,
  releaseRepoIngressFence,
  repoIngressFenceAckToken,
} from '../modules/mailbox/ops/fence.js';
export type {
  RepoIngressAdmissionResult,
  RepoIngressFence,
  RepoIngressReleaseResult,
} from '../modules/mailbox/ops/fence.js';

export {
  getInboundSourceSessionId,
  getMostRecentPeerSourceSessionId,
  insertDeferredMessageWithContextIfNew,
  insertMessage,
  insertMessageIfNew,
  insertMessageWithContext,
  insertMessageWithContextIfNew,
  nextEvenSeq,
  readSessionRouting,
  replaceDestinations,
  sessionInboundHasMessage,
  upsertSessionRouting,
} from '../modules/mailbox/ops/ingress.js';
export type { DestinationRow, MessageInsert, SessionRouting } from '../modules/mailbox/ops/ingress.js';

export {
  getDeliveredIds,
  getDueOutboundMessages,
  markDelivered,
  markDeliveryFailed,
  markPending,
} from '../modules/mailbox/ops/delivery.js';
export type { OutboundMessage } from '../modules/mailbox/ops/delivery.js';

export {
  countDueMessages,
  deleteOrphanProcessingClaims,
  expireStalePending,
  getContainerState,
  getDueWakePriority,
  getMessageForRetry,
  getNextFutureProcessAfter,
  getProcessingClaims,
  INTERACTIVE_WAKE_MAX_AGE_MS,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
} from '../modules/mailbox/ops/sweep.js';
export type { ContainerState, ProcessingClaim } from '../modules/mailbox/ops/sweep.js';
