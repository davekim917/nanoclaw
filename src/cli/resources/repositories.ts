/**
 * Operator seam for adopting workgroup-shared checkouts as host canonicals.
 *
 * These verbs must run inside the host process: quiescence stops containers
 * through the runtime process map, and the in-memory workgroup mount claim that
 * closes spawn admission is per-process. A standalone script could write the
 * durable ingress fence but could not stop a live container, so it would move a
 * directory out from under an active bind mount.
 */
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import {
  quiesceSessionsForRepositoryMounts,
  releaseRepositoryMountQuiescence,
  wakeRepositoryMountSessions,
  RepositoryMountQuiescenceError,
} from '../../container-restart.js';
import { log } from '../../log.js';
import {
  activateCanonicalRepository,
  planRepositoryActivation,
  rollbackCanonicalRepository,
  type LegacyCheckout,
  type RepositoryActivationResult,
} from '../../repository-activation.js';
import { withWorkgroupRepositoryMountClaim } from '../../repository-workspaces.js';
import { registerResource, type ColumnDef, type CustomOperation } from '../crud.js';
import type { CallerContext } from '../frame.js';

const workgroupArg: ColumnDef = {
  name: 'workgroup',
  type: 'string',
  description: 'Workgroup id to reconcile.',
  required: true,
};

const reposArg: ColumnDef = {
  name: 'repos',
  type: 'string',
  description: 'Comma-separated repository names. Omit to use every adoptable checkout in the plan.',
};

function requiredWorkgroup(args: Record<string, unknown>): string {
  const value = args.workgroup;
  if (typeof value !== 'string' || !value.trim()) throw new Error('--workgroup is required');
  return value.trim();
}

function selectedRepos(args: Record<string, unknown>): string[] | null {
  const value = args.repos;
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function describe(checkout: LegacyCheckout): string {
  const state: string[] = [];
  if (checkout.localOnlyCommits > 0) state.push(`${checkout.localOnlyCommits} local-only commit(s)`);
  if (checkout.unpushedBranches > 0) state.push(`${checkout.unpushedBranches} unpushed branch(es)`);
  if (checkout.dirtyPaths.length > 0) state.push(`${checkout.dirtyPaths.length} dirty/untracked path(s)`);
  const head = checkout.detached ? `detached ${checkout.head.slice(0, 8)}` : checkout.head;
  return `${checkout.repo} [${head}] ${state.length > 0 ? state.join(', ') : 'clean'}`;
}

/**
 * Fence and stop every container in the workgroup, run `body`, then release and
 * wake. One quiescence covers every repository so a workgroup is paused once
 * rather than once per repository.
 */
async function withWorkgroupQuiescence<T>(workgroupId: string, body: () => Promise<T>): Promise<T> {
  const groupIds = getAllAgentGroups()
    .filter((group) => (group.workgroup_id ?? group.folder) === workgroupId)
    .map((group) => group.id);
  if (groupIds.length === 0) throw new Error(`no agent groups belong to workgroup ${workgroupId}`);

  return withWorkgroupRepositoryMountClaim(workgroupId, async () => {
    const sessions = groupIds.flatMap((id) => getSessionsByAgentGroup(id));
    const quiescence = await quiesceSessionsForRepositoryMounts(
      sessions,
      `repository-activation:${workgroupId}:${Date.now()}`,
    );
    // Release runs on both paths, but a release failure must never mask why the
    // body failed — an unreleased fence and a failed move are different
    // incidents and the operator needs to see both.
    let result: T | undefined;
    let bodyError: unknown;
    try {
      result = await body();
    } catch (error) {
      bodyError = error;
    }

    let wake = quiescence.sessions;
    try {
      const due = await releaseRepositoryMountQuiescence(quiescence);
      wake = [...new Map([...wake, ...due].map((session) => [session.id, session])).values()];
    } catch (releaseError) {
      // A still-active fence strands every session in the workgroup.
      log.error('Failed to release repository activation quiescence', { workgroupId, err: releaseError });
      if (bodyError) {
        throw new AggregateError(
          [bodyError, releaseError],
          `repository activation failed for ${workgroupId} and its ingress barrier could not be released`,
          { cause: releaseError },
        );
      }
      throw releaseError;
    }

    wakeRepositoryMountSessions(wake);
    if (bodyError) throw bodyError;
    return result as T;
  });
}

function operation(
  access: 'open' | 'approval',
  description: string,
  args: ColumnDef[],
  handler: CustomOperation['handler'],
  examples?: string[],
  formatHuman?: (data: unknown) => string,
): CustomOperation {
  return { access, description, args, handler, examples, hostOnly: true, formatHuman };
}

registerResource({
  name: 'Repository activation',
  plural: 'repositories',
  table: 'workgroups',
  description:
    'Adopt workgroup-shared repository checkouts as host canonicals so topics get isolated linked worktrees. Operator-only.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    plan: operation(
      'open',
      'Classify every checkout in a workgroup and show what activation would adopt, skip, and preserve. Read-only.',
      [workgroupArg],
      async (args: Record<string, unknown>, _ctx: CallerContext) => planRepositoryActivation(requiredWorkgroup(args)),
      ['ncl repositories plan --workgroup example-retail'],
      (data) => {
        const plan = data as ReturnType<typeof planRepositoryActivation>;
        const lines = [
          `workgroup: ${plan.workgroupId}`,
          `legacy:    ${plan.legacyRoot}`,
          `canonical: ${plan.canonicalRoot}`,
          '',
          `ADOPT (${plan.adopt.length}):`,
          ...plan.adopt.map((checkout) => `  ${describe(checkout)}`),
          '',
          `SKIP (${plan.skip.length}):`,
          ...plan.skip.map((checkout) => `  ${describe(checkout)} — ${checkout.reason ?? 'not adoptable'}`),
        ];
        return lines.join('\n');
      },
    ),
    activate: operation(
      'approval',
      'Adopt the planned canonicals under one workgroup-wide quiescence. Stops the workgroup briefly; other workgroups keep running.',
      [workgroupArg, reposArg],
      async (args: Record<string, unknown>, _ctx: CallerContext) => {
        const workgroupId = requiredWorkgroup(args);
        const only = selectedRepos(args);
        const plan = planRepositoryActivation(workgroupId);
        const targets = only ? plan.adopt.filter((checkout) => only.includes(checkout.repo)) : plan.adopt;
        if (only) {
          const missing = only.filter((repo) => !targets.some((checkout) => checkout.repo === repo));
          if (missing.length > 0) throw new Error(`not adoptable in ${workgroupId}: ${missing.join(', ')}`);
        }
        if (targets.length === 0) return { workgroupId, activated: [], failed: [] };

        const activated: RepositoryActivationResult[] = [];
        const failed: Array<{ repo: string; error: string }> = [];
        try {
          await withWorkgroupQuiescence(workgroupId, async () => {
            for (const checkout of targets) {
              try {
                activated.push(await activateCanonicalRepository({ workgroupId, checkout }));
              } catch (error) {
                // One bad repository must not abandon the rest mid-quiescence;
                // each adoption is independently atomic under its own lock.
                failed.push({ repo: checkout.repo, error: error instanceof Error ? error.message : String(error) });
              }
            }
          });
        } catch (error) {
          if (error instanceof RepositoryMountQuiescenceError) {
            throw new Error(
              `workgroup ${workgroupId} could not be quiesced; no repository was moved: ${error.message}`,
              { cause: error },
            );
          }
          throw error;
        }
        return { workgroupId, activated, failed };
      },
      ['ncl repositories activate --workgroup example-retail --repos app'],
    ),
    rollback: operation(
      'approval',
      'Move named canonicals back to the workgroup shared tree and drop their origin pins.',
      [workgroupArg, { ...reposArg, required: true }],
      async (args: Record<string, unknown>, _ctx: CallerContext) => {
        const workgroupId = requiredWorkgroup(args);
        const repos = selectedRepos(args);
        if (!repos || repos.length === 0) throw new Error('--repos is required');
        const restored: Array<{ repo: string; restoredPath: string }> = [];
        await withWorkgroupQuiescence(workgroupId, async () => {
          for (const repo of repos) restored.push(await rollbackCanonicalRepository({ workgroupId, repo }));
        });
        return { workgroupId, restored };
      },
      ['ncl repositories rollback --workgroup example-retail --repos app'],
    ),
  },
});
