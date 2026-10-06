/**
 * Kill accountability: an agent whose container is stopped while it still owes work (edits only on disk, a task list
 * with items not done) and with nothing armed to bring it back sits until a human pings. Same row machinery and cap
 * as the ceiling wake. Kept free of top-level side effects so other families can import it without registering this
 * one. The host never inspects checkouts or the list itself; the runner writes both records.
 */
import { SELF_HEAL_ENABLED } from '../../config.js';
import { sessionStillActive } from '../../container-runner.js';
import { withCentralSync } from '../../db/central-lease.js';
import { withQuietInvalidationSync } from '../../db/sessions.js';
import { writeOutboundWhenStopped, writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession, TaskListInFlight, WorktreeInFlight } from '../mailbox/index.js';
import { WORK_CONTINUATION_RESUME_MAX_ATTEMPTS } from '../mailbox/ops/continuation.js';
import { decideReapFollowUp, type ReapFollowUp } from './decide.js';
import { containerStartedAtMs, openCardSince, readKillArmed, REAP_RESPAWN_ID_PREFIX } from './kill-state.js';

export const ACCOUNT_FOR_STATE = 'post ONE message accounting for state — done / lost / next';

export const RESTART_SURVIVAL_RULES =
  `Re-check any work claims in claims/ before resuming a seam — a sibling may have taken it over while you were down. ` +
  `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
  `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay.`;

const MAX_FILES_NAMED = 20;
const MAX_ITEMS_NAMED = 5;
const CONTAINER_WORKTREES_DIR = '/workspace/worktrees';

export interface StrandingKill {
  reason: string;
  minutes?: number;
}

/**
 * The only kills that may queue the wake, and how the note names each. Every other stop is one somebody asked for
 * (a restart, a self-mod respawn, a repository-mount change) or a task session's normal exit.
 */
const STRANDING_KILLS: ReadonlyMap<string, (kill: StrandingKill) => string> = new Map([
  ['chat-idle-reap', (kill) => `was stopped by the ${kill.minutes}-minute chat idle reap after your turn ended`],
  ['absolute-ceiling', (kill) => `was killed by the ${kill.minutes}-minute idle ceiling`],
  ['provider-unavailable', () => `was stopped mid-turn because its model provider became unavailable`],
]);

interface KillEvidence {
  checkouts: WorktreeInFlight['checkouts'];
  unfinished: TaskListInFlight['unfinished'];
  waiting: number;
  /** Something was recorded, all of it by an earlier container. */
  stale: boolean;
}

/** A record stamped before the killed container started was left by an earlier one and must never wake the session. */
function readKillEvidence(mailbox: NanoclawMailboxSession, startedAtMs: number): KillEvidence {
  const worktree = mailbox.readWorktreeInFlight();
  const list = mailbox.readTaskListInFlight();
  const during = (at: string): boolean => Date.parse(at) >= startedAtMs;
  const checkouts = worktree && during(worktree.at) ? worktree.checkouts : [];
  const fresh = list && during(list.at) ? list : null;
  const unfinished = fresh?.unfinished ?? [];
  const recorded = (worktree?.checkouts.length ?? 0) + (list?.unfinished.length ?? 0);
  return {
    checkouts,
    unfinished,
    waiting: fresh?.waiting ?? 0,
    stale: recorded > 0 && checkouts.length + unfinished.length === 0,
  };
}

function describeCheckouts(checkouts: KillEvidence['checkouts']): string {
  let namesLeft = MAX_FILES_NAMED;
  return checkouts
    .map((checkout) => {
      const upstream = checkout.upstream
        ? `pushed upstream ${checkout.upstream}${checkout.upstream_head ? ` at ${checkout.upstream_head.slice(0, 12)}` : ''}`
        : 'no upstream';
      const parts = [
        `- ${CONTAINER_WORKTREES_DIR}/${checkout.name}: branch ${checkout.branch ?? '(detached)'}, ${upstream}`,
      ];
      if (checkout.unpushed > 0) parts.push(`${checkout.unpushed} commit(s) not on the upstream`);
      if (checkout.file_count > 0) {
        const named = checkout.files.slice(0, Math.max(namesLeft, 0));
        namesLeft -= named.length;
        const more = checkout.file_count - named.length;
        parts.push(
          `${checkout.file_count} uncommitted file(s)` +
            (named.length > 0 ? `: ${named.join(', ')}` : '') +
            (more > 0 ? ` (+${more} more)` : ''),
        );
      }
      return parts.join('; ');
    })
    .join('\n');
}

const ITEM_STATE = { in_progress: 'in progress', pending: 'pending', open: 'open' } as const;

function describeUnfinished(unfinished: KillEvidence['unfinished']): string {
  const lines = unfinished.slice(0, MAX_ITEMS_NAMED).map((item) => `- ${ITEM_STATE[item.status]}: ${item.text}`);
  const more = unfinished.length - lines.length;
  if (more > 0) lines.push(`(+${more} more)`);
  return lines.join('\n');
}

function wakeText(cause: string, evidence: KillEvidence): string {
  const sections = [`[system] Your previous container ${cause}.`];
  if (evidence.checkouts.length > 0) {
    sections.push(
      `It left work that is not committed and pushed:\n${describeCheckouts(evidence.checkouts)}\n` +
        `Resume what is safely resumable — commit and push what is ready — and ${ACCOUNT_FOR_STATE}. ` +
        `A commit, a push or a PR is evidence; a description of what you meant to do is not. ` +
        `If this work is not yours (siblings in this thread share these checkouts) or is deliberately parked, ` +
        `say so in one line.`,
    );
  }
  if (evidence.unfinished.length > 0) {
    // Work only on disk must be accounted for in a message; a list alone can be settled in the list.
    const silent =
      evidence.checkouts.length === 0
        ? ` Post a message only if work was lost or that ask was never made; otherwise the updated list is the answer.`
        : '';
    sections.push(
      `Its task list still had ${evidence.unfinished.length} item(s) neither done nor marked waiting, and nothing ` +
        `was armed to bring you back to them:\n${describeUnfinished(evidence.unfinished)}\n` +
        `Settle each one now with update_task_list. If it is in fact finished, mark it done. ` +
        `If the work is still owed, do the next item now. ` +
        `If you will check on it later (a peer agent you are waiting on counts), arm wait or continue_work naming ` +
        `what you will check and when — prose does not keep this thread alive. ` +
        `If you cannot move it yourself, mark it waiting on whoever owes the next move.${silent}`,
    );
  }
  sections.push(RESTART_SURVIVAL_RULES);
  return sections.join('\n');
}

/**
 * Call after the killed container has exited, with `containerName` read before the kill (the registry entry is gone
 * after exit). The write sits under the outbound guard although the row is inbound: a replacement that already took
 * the session is handling the thread, and the row would greet the NEXT container with a stale notice.
 */
export async function followUpKill(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerName: string | null,
  kill: StrandingKill,
): Promise<ReapFollowUp> {
  const fields: Record<string, unknown> = { sessionId: session.id, killReason: kill.reason };
  const decided = (followUp: ReapFollowUp): ReapFollowUp => {
    log.info('Kill follow-up decided', { ...fields, outcome: followUp.action === 'none' ? followUp.reason : 'wake' });
    return followUp;
  };
  const cause = STRANDING_KILLS.get(kill.reason);
  if (!cause) return decided({ action: 'none', reason: 'reason-not-covered' });
  const startedAtMs = containerStartedAtMs(containerName);
  if (startedAtMs === null) return decided({ action: 'none', reason: 'nothing-in-flight' });

  const evidence = readKillEvidence(mailbox, startedAtMs);
  const checkouts = evidence.checkouts.map((checkout) => checkout.name);
  fields.evidence = [
    ...(evidence.checkouts.length > 0 ? ['worktree'] : []),
    ...(evidence.unfinished.length > 0 ? ['task-list'] : []),
  ];
  fields.checkouts = checkouts;
  fields.unfinishedItems = evidence.unfinished.length;
  fields.waitingItems = evidence.waiting;
  const inFlight = {
    inFlightCheckouts: evidence.checkouts.length,
    unfinishedItems: evidence.unfinished.length,
    staleEvidence: evidence.stale,
  };
  const armed = inFlight.inFlightCheckouts + inFlight.unfinishedItems > 0 ? readKillArmed(mailbox) : null;
  if (armed) fields.armedBy = armed.by;
  const early = decideReapFollowUp({ ...inFlight, armed: armed !== null, priorAttempts: 0 });
  if (early.action === 'none') return decided(early);

  fields.maxAttempts = WORK_CONTINUATION_RESUME_MAX_ATTEMPTS;
  const followUp = await withCentralSync(
    () =>
      writeOutboundWhenStopped(session, mailbox, (): ReapFollowUp => {
        // The sweep never wakes a closed or archived session, so the row would sit due forever.
        if (sessionStillActive(session.id)() !== true) return { action: 'none', reason: 'not-wakeable' };
        const priorAttempts = mailbox.countRecoveryAttemptsSinceRealInbound(REAP_RESPAWN_ID_PREFIX);
        fields.priorAttempts = priorAttempts;
        const decision = decideReapFollowUp({
          ...inFlight,
          humanPending:
            openCardSince(session.id, new Date(startedAtMs).toISOString(), new Date().toISOString()) !== null,
          priorAttempts,
        });
        if (decision.action === 'none') return decision;
        if (!SELF_HEAL_ENABLED) {
          log.info('self-heal: would queue chat-reap accountability wake', {
            class: 'killed-with-work-in-flight',
            ...fields,
          });
          return { action: 'none', reason: 'shadow' };
        }
        // A tick may have quiet-marked this stopped session since the kill; the mark must die with the write.
        const written = withQuietInvalidationSync(session.id, () =>
          writeSystemWake(
            mailbox,
            session,
            `${REAP_RESPAWN_ID_PREFIX}${startedAtMs}`,
            wakeText(cause(kill), evidence),
            {
              kind: 'agent_reap_respawn',
              checkouts,
              ...(evidence.unfinished.length > 0 ? { unfinished_items: evidence.unfinished.length } : {}),
            },
          ),
        );
        if (written) return decision;
        fields.armedBy = 'already-queued';
        return { action: 'none', reason: 'armed' };
      }),
    'kill follow-up',
  );
  if (followUp === undefined) {
    fields.armedBy = 'replacement-container';
    return decided({ action: 'none', reason: 'armed' });
  }
  return decided(followUp);
}
