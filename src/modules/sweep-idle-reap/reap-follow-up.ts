/**
 * After a chat idle reap: if the killed container left recent work only on disk, queue one accountable respawn.
 * The reap itself stays unconditional — an idle container runs nothing, so holding it would only delay the kill.
 */
import { resolveSessionRepositoryWorkUnit } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { writeOutboundWhenStopped, type SweepSessionContext } from '../../host-sweep.js';
import { log } from '../../log.js';
import { topicWorktreesDir } from '../../repository-workspaces.js';
import { applyReapFollowUp } from '../sweep-continuation/reap-respawn.js';
import { inspectWorktreesForReap } from './worktree-evidence.js';

/** The worktrees root `buildMounts` gave this session's container, read-write. */
async function sessionWorktreesDir(ctx: SweepSessionContext): Promise<string | null> {
  const agentGroup = await getAgentGroup(ctx.session.agent_group_id);
  if (!agentGroup) return null;
  // The spawn persists the workgroup it resolved onto the agent group row, so this is the key the mount used.
  const unit = await resolveSessionRepositoryWorkUnit(ctx.session, agentGroup.workgroup_id ?? agentGroup.folder);
  return topicWorktreesDir(unit);
}

/**
 * `spawnedAtMs` is read before the kill (the registry entry is gone after exit) and bounds recency: dirt older than
 * this container was left by an earlier one and must never wake this session. 0 means untracked, so nothing is
 * provable. An adopted container's value is its adoption time, so its pre-restart edits are not counted.
 */
async function followUpChatReap(ctx: SweepSessionContext, spawnedAtMs: number, idleMinutes: number): Promise<void> {
  const { session } = ctx;
  if (spawnedAtMs <= 0) return;
  const worktreesDir = await sessionWorktreesDir(ctx);
  if (!worktreesDir) return;
  const evidence = await inspectWorktreesForReap(worktreesDir, spawnedAtMs);
  // An unread checkout is not evidence of work: waking on it would re-fire on every reap of a session with one
  // broken checkout. It is reported instead, and in-flight evidence from the others still counts.
  if (evidence.unreadable.length > 0) {
    log.warn('Chat-reap worktree check could not read some checkouts — not counted as work in flight', {
      sessionId: session.id,
      worktreesDir,
      unreadable: evidence.unreadable,
      inFlight: evidence.inFlight.length,
    });
  }
  if (evidence.inFlight.length === 0) return;
  await ctx.runIn('session:health:post-kill', (mailbox) =>
    // Under the outbound guard although the row is inbound: a replacement that already took the session (a human
    // replied) is handling the thread, and the row would greet the NEXT container with a stale notice.
    writeOutboundWhenStopped(session, mailbox, () =>
      applyReapFollowUp(mailbox, session, String(spawnedAtMs), evidence, idleMinutes),
    ),
  );
}

const reapFollowUps = new Set<Promise<void>>();

/** Runs from `killContainer`'s `onExit`, after the tick that reaped has moved on, so nothing may throw into it. */
export function startChatReapFollowUp(ctx: SweepSessionContext, spawnedAtMs: number, idleMinutes: number): void {
  const tracked = followUpChatReap(ctx, spawnedAtMs, idleMinutes)
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
