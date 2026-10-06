/**
 * After a chat idle reap: if the killed container's last turn end recorded work only on disk, queue one accountable
 * respawn. The reap itself stays unconditional — an idle container runs nothing, so holding it would only delay the
 * kill. The host never inspects the checkouts itself; the runner writes the record (worktree-in-flight.ts).
 */
import { containerStartedAtMs } from '../../container-runner.js';
import { withCentralSync } from '../../db/central-lease.js';
import { withQuietInvalidationSync } from '../../db/sessions.js';
import { writeOutboundWhenStopped, type SweepSessionContext } from '../../host-sweep.js';
import { log } from '../../log.js';
import { applyReapFollowUp } from '../sweep-continuation/reap-respawn.js';

/**
 * `containerName` is read before the kill (the registry entry is gone after exit). A record stamped before that
 * container started was left by an earlier one and must never wake this session; with no name, nothing is attributable.
 */
async function followUpChatReap(
  ctx: SweepSessionContext,
  containerName: string | null,
  idleMinutes: number,
): Promise<void> {
  const { session } = ctx;
  const startedAtMs = containerStartedAtMs(containerName);
  if (startedAtMs === null) return;
  await ctx.runIn('session:health:post-kill', async (mailbox) => {
    const record = mailbox.readWorktreeInFlight();
    if (!record || record.checkouts.length === 0 || Date.parse(record.at) < startedAtMs) return;
    await withCentralSync(() =>
      // Under the outbound guard although the row is inbound: a replacement that already took the session (a human
      // replied) is handling the thread, and the row would greet the NEXT container with a stale notice.
      writeOutboundWhenStopped(session, mailbox, () =>
        applyReapFollowUp(mailbox, session, String(startedAtMs), record, idleMinutes, (write) =>
          // A tick may have quiet-marked this stopped session since the kill; the mark must die with the write.
          withQuietInvalidationSync(session.id, write),
        ),
      ),
    );
  });
}

const reapFollowUps = new Set<Promise<void>>();

/** Runs from `killContainer`'s `onExit`, after the tick that reaped has moved on, so nothing may throw into it. */
export function startChatReapFollowUp(
  ctx: SweepSessionContext,
  containerName: string | null,
  idleMinutes: number,
): void {
  const tracked = followUpChatReap(ctx, containerName, idleMinutes)
    .catch((err: unknown) => {
      log.warn('Chat-reap follow-up failed', { sessionId: ctx.session.id, err });
    })
    .finally(() => {
      reapFollowUps.delete(tracked);
    });
  reapFollowUps.add(tracked);
}

/** Test-only: settle every follow-up still running. */
export function _settleChatReapFollowUpsForTesting(): Promise<void> {
  return Promise.all([...reapFollowUps]).then(() => undefined);
}
