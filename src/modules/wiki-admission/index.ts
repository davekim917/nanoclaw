import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { readContainerConfigStrict } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { taskSeriesId } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { resolveGitHubToken } from '../../github-token.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { decideHooksMountStrategy, MANAGED_GIT_HOOKS_SCAN_DIR } from '../../managed-git-hooks.js';
import { readOriginPin, withHostRepositoryLock } from '../../repository-workspaces.js';
import { resolveTaskSession, writeSessionMessageIfNew } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { WikiAdmission, reviewPrompt } from '../../wiki-admission/engine.js';
import { candidateDirectory, WikiGit } from '../../wiki-admission/git.js';
import { assertWikiActorConfig, readWikiPublicationPolicy, wikiEnrollment } from '../../wiki-admission/policy.js';
import { retrieveSource } from '../../wiki-admission/sources.js';
import { CandidateStore } from '../../wiki-admission/store.js';
import { REPOSITORY_REQUEST_ID_PATTERN, runRepositoryActionDetached } from '../repository-workspaces/job-runner.js';

function currentPolicy() {
  const loaded = readWikiPublicationPolicy();
  if (!loaded) throw new Error('Wiki admission is not enrolled');
  const pin = readOriginPin(loaded.policy.workgroupId, loaded.policy.repository);
  if (!pin || pin.kind === 'local-only') throw new Error('Wiki remote origin pin is unavailable');
  return { ...loaded, origin: pin.origin };
}

function engine(store: CandidateStore): WikiAdmission {
  return new WikiAdmission(store, {
    policy: currentPolicy,
    git: (candidate) =>
      new WikiGit(
        candidateDirectory(store.root, candidate.id),
        candidate.origin,
        currentPolicy().policy.defaultRef,
        async () => {
          const token = await resolveGitHubToken('', {});
          if (!token) throw new Error('Host wiki publication authentication unavailable');
          return { GH_TOKEN: token, GIT_ALLOW_PROTOCOL: 'https' };
        },
        () => {
          if (decideHooksMountStrategy() !== 'scan') throw new Error('Managed wiki scan hook unavailable');
          return MANAGED_GIT_HOOKS_SCAN_DIR;
        },
      ),
    source: retrieveSource,
    verifierSession: async (id) =>
      (await resolveTaskSession(currentPolicy().policy.verifierGroupId, `wiki-verify-${id}`)).session.id,
    deliverReview: async (candidate) => {
      if (!candidate.verifierSession) throw new Error('Verifier session unavailable');
      await writeSessionMessageIfNew(
        currentPolicy().policy.verifierGroupId,
        candidate.verifierSession,
        {
          id: `wiki-review-${candidate.id}`,
          kind: 'task',
          timestamp: candidate.createdAt,
          content: JSON.stringify({ prompt: reviewPrompt(candidate), muteChat: true, quietStatus: true }),
          processAfter: new Date().toISOString(),
          recurrence: null,
          trigger: 1,
        },
        { hostOrigin: true },
      );
    },
    notify: async (candidate) => {
      const target = currentPolicy().policy.notification;
      const adapter = getDeliveryAdapter();
      if (!adapter) throw new Error('Wiki publication notice adapter unavailable');
      const result = await adapter.deliver(
        target.channelType,
        target.platformId,
        target.threadId,
        'chat',
        JSON.stringify({
          text: `Wiki updated with an independently sourced fact/correction (${candidate.head.slice(0, 12)}).`,
        }),
        undefined,
        target.instance,
      );
      if (!result) throw new Error('Wiki publication notice delivery unconfirmed');
    },
  });
}

async function withEngine<T>(fn: (admission: WikiAdmission) => Promise<T>): Promise<T> {
  const { policy } = currentPolicy();
  return withHostRepositoryLock(policy.workgroupId, policy.repository, async () => {
    const store = new CandidateStore(path.join(DATA_DIR, 'wiki-admission', 'candidates'));
    try {
      return await fn(engine(store));
    } finally {
      store.close();
    }
  });
}

async function assertActor(session: Session, operation: unknown): Promise<void> {
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new Error('Unknown wiki actor');
  const config = readContainerConfigStrict(group.folder);
  const enrollment = wikiEnrollment(group.id, config.wikiMaintenance === true);
  if (!enrollment) throw new Error('Unenrolled wiki actor');
  assertWikiActorConfig(config, enrollment, group.workgroup_id ?? '');
  if (
    enrollment.role === 'writer' &&
    (operation === 'verdict' || taskSeriesId(session.thread_id) !== enrollment.policy.seriesId)
  ) {
    throw new Error('Wiki writer is outside the enrolled series');
  }
  if (enrollment.role === 'verifier' && operation !== 'verdict') throw new Error('Verifier cannot create candidates');
}

async function apply(content: Record<string, unknown>, session: Session): Promise<void> {
  await assertActor(session, content.operation);
  let response: unknown;
  try {
    response = await withEngine(async (admission) => {
      if (content.operation === 'begin') return admission.begin(session.id, String(content.requestId));
      if (content.operation === 'submit')
        return { state: await admission.submit(session.id, String(content.candidateId), content.replacements) };
      if (content.operation === 'verdict') return { state: await admission.verdict(session.id, content) };
      throw new Error('Unknown wiki operation');
    });
  } catch {
    response = { error: 'Wiki admission failed closed; no new publication is authorized by this response.' };
    log.warn('Wiki admission request failed closed', { sessionId: session.id, operation: content.operation });
  }
  await writeSessionMessageIfNew(
    session.agent_group_id,
    session.id,
    {
      id: `wiki-response-${content.requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify(response),
      trigger: 0,
    },
    { hostOrigin: true },
  );
}

const action = defineGuardedAction({
  action: 'wiki.admission',
  decide: (input) => {
    const p = readWikiPublicationPolicy()?.policy;
    return p && input.actor.kind === 'agent' && [p.writerGroupId, p.verifierGroupId].includes(input.actor.agentGroupId)
      ? ALLOW('enrolled wiki actor; operation identity rechecked by apply')
      : DENY('wiki actor not enrolled');
  },
});

registerDeliveryAction(
  'wiki_admission',
  (content, session) => runRepositoryActionDetached('wiki_admission', apply, content, session, 'wiki-admission'),
  {
    guardAction: action,
    precheck: async (content, session) => {
      if (
        typeof content.requestId !== 'string' ||
        !REPOSITORY_REQUEST_ID_PATTERN.test(content.requestId) ||
        !['begin', 'submit', 'verdict'].includes(String(content.operation)) ||
        Buffer.byteLength(JSON.stringify(content)) > 1024 * 1024
      ) {
        throw new Error('Invalid wiki protocol request');
      }
      await assertActor(session, content.operation);
      return true;
    },
    requestHold: async () => {
      throw new Error('Wiki admission never requests per-fact approval');
    },
  },
);

let recovering = false;
registerSweepDutySource('wiki-admission', () =>
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK3,
    phase: 'tick:housekeeping',
    order: 9500,
    run: () => {
      if (
        recovering ||
        !readWikiPublicationPolicy() ||
        !fs.existsSync(path.join(DATA_DIR, 'wiki-admission', 'candidates', 'state.db'))
      )
        return;
      recovering = true;
      void withEngine((admission) => admission.recover())
        .then((failures) => {
          if (failures) log.warn('Wiki admission recovery isolated candidate failures', { failures });
        })
        .catch(() => {
          log.warn('Wiki admission recovery failed closed');
        })
        .finally(() => {
          recovering = false;
        });
    },
  }),
);
