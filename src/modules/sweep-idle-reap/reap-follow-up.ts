/**
 * After a chat idle reap: queue the kill follow-up once the container is gone. The reap itself stays unconditional —
 * an idle container runs nothing, so holding it would only delay the kill.
 */
import { containerStartedAtMs } from '../../container-runner.js';
import { type SweepSessionContext } from '../../host-sweep.js';
import { log } from '../../log.js';
import { CHAT_IDLE_REAP_KILL } from '../sweep-continuation/kill-state.js';
import { followUpKill } from '../sweep-continuation/reap-respawn.js';

async function followUpChatReap(
  ctx: SweepSessionContext,
  containerName: string | null,
  idleMinutes: number,
): Promise<void> {
  await ctx.runIn('session:health:post-kill', (mailbox) =>
    followUpKill(mailbox, ctx.session, containerStartedAtMs(containerName), {
      reason: CHAT_IDLE_REAP_KILL,
      minutes: idleMinutes,
    }),
  );
}

const reapFollowUps = new Set<Promise<void>>();

/**
 * Runs from `killContainer`'s `onExit`, after the tick that reaped has moved on, so nothing may throw into it.
 * `containerName` is read before the kill.
 */
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
