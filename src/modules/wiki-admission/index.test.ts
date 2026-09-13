import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: uniqueTmpRoot('wiki-module'),
  handlers: new Map<string, { handler: (...args: any[]) => any; options: any }>(),
  head: 'a'.repeat(40),
  writes: [] as any[],
  token: vi.fn(async () => 'fixture-host-token'),
  notice: vi.fn(async () => 'fixture-notice'),
}));
vi.mock('../../config.js', () => ({ DATA_DIR: fixture.root, GROUPS_DIR: path.join(fixture.root, 'groups') }));
vi.mock('../../container-config.js', () => ({
  readContainerConfigStrict: () => ({ wikiMaintenance: true, provider: 'codex' }),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => ({ id, folder: id, workgroup_id: 'example' }),
}));
vi.mock('../../db/sessions.js', () => ({ taskSeriesId: () => 'synth-example' }));
vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (name: string, handler: any, options: any) =>
    fixture.handlers.set(name, { handler, options }),
  getDeliveryAdapter: () => ({ deliver: fixture.notice }),
}));
vi.mock('../../guard/index.js', () => ({
  defineGuardedAction: (value: any) => value,
  ALLOW: () => 'allow',
  DENY: () => 'deny',
}));
vi.mock('../../github-token.js', () => ({ resolveGitHubToken: fixture.token }));
vi.mock('../../host-sweep.js', () => ({
  registerSweepDuty: vi.fn(),
  registerSweepDutySource: vi.fn(),
  SWEEP_DUTY_INVENTORY: { FORK3: 'wiki' },
}));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../managed-git-hooks.js', () => ({
  decideHooksMountStrategy: () => 'scan',
  MANAGED_GIT_HOOKS_SCAN_DIR: '/fixture/managed-scan',
}));
vi.mock('../../repository-workspaces.js', () => ({
  readOriginPin: () => ({ kind: 'remote', origin: 'https://github.com/example/fixture.wiki.git' }),
  withHostRepositoryLock: async (_workgroup: string, _repository: string, fn: () => unknown) => fn(),
}));
vi.mock('../../session-manager.js', () => ({
  resolveTaskSession: async () => ({ session: { id: 'fresh-verifier' } }),
  writeSessionMessageIfNew: async (...args: any[]) => {
    fixture.writes.push(args);
    return true;
  },
}));
vi.mock('../repository-workspaces/job-runner.js', () => ({
  REPOSITORY_REQUEST_ID_PATTERN: /^repo-[0-9]+-[a-f0-9]{16}$/,
  runRepositoryActionDetached: async (_action: string, apply: any, content: any, session: any) =>
    apply(content, session),
}));
vi.mock('../../wiki-admission/sources.js', () => ({
  retrieveSource: async (url: string) => ({
    id: 'primary',
    url,
    sha256: 'fixture',
    body: 'Primary fact.',
    retrievedAt: new Date().toISOString(),
  }),
}));
vi.mock('../../wiki-admission/git.js', () => ({
  candidateDirectory: (root: string, id: string) => path.join(root, id),
  replacements: (value: unknown) => value,
  WikiGit: class {
    constructor(
      _dir: string,
      readonly remote: string,
      readonly ref: string,
      readonly auth: () => Promise<any>,
      readonly hooks: () => string,
    ) {}
    async initialize() {
      return fixture.head;
    }
    async pages(head: string) {
      return { 'domain/fact.md': head === 'a'.repeat(40) ? '# Fact\n' : '# Fact\nPrimary fact.\n' };
    }
    async create() {
      return { head: 'b'.repeat(40), tree: 'c'.repeat(40), diff: 'fixture diff' };
    }
    async assertFrozen() {}
    async remoteHead() {
      return fixture.head;
    }
    async push(base: string, head: string, authorizePush: () => void) {
      expect(base).toBe(fixture.head);
      expect(await this.auth()).toEqual({ GH_TOKEN: 'fixture-host-token', GIT_ALLOW_PROTOCOL: 'https' });
      expect(this.hooks()).toBe('/fixture/managed-scan');
      authorizePush();
      fixture.head = head;
    }
  },
}));

import './index.js';
import { CandidateStore } from '../../wiki-admission/store.js';

const request = { requestId: 'repo-1-0123456789abcdef' };
const writer = { id: 'writer-session', agent_group_id: 'writer', thread_id: 'task-fixture' };
const policy = {
  version: 1,
  workgroupId: 'example',
  repository: 'wiki',
  defaultRef: 'refs/heads/main',
  writerGroupId: 'writer',
  verifierGroupId: 'verifier',
  seriesId: 'synth-example',
  sourcePrefixes: ['https://primary.example/'],
  notification: { channelType: 'test', instance: 'wiki-test', platformId: 'fixture', threadId: null },
};
const identityPath = () => path.join(fixture.root, 'groups', '_ops', 'wiki', 'actors.json');
beforeEach(() => {
  fixture.head = 'a'.repeat(40);
  fixture.writes.length = 0;
  fixture.token.mockClear();
  fixture.notice.mockClear();
  fs.mkdirSync(path.dirname(identityPath()), { recursive: true });
  fs.writeFileSync(identityPath(), JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }));
  fs.writeFileSync(path.join(path.dirname(identityPath()), 'admission.json'), JSON.stringify(policy));
});
afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

describe('restricted host publisher integration', () => {
  it.each([false, true])(
    'binds real identity/policy/store through the registered action (revoke=%s)',
    async (revoke) => {
      const action = fixture.handlers.get('wiki_admission')!;
      expect(action.options.guardAction.decide({ actor: { kind: 'agent', agentGroupId: 'writer' } })).toBe('allow');
      expect(action.options.guardAction.decide({ actor: { kind: 'agent', agentGroupId: 'ordinary' } })).toBe('deny');
      const begin = { ...request, operation: 'begin' };
      expect(await action.options.precheck(begin, writer)).toBe(true);
      await action.handler(begin, writer);
      const response = JSON.parse(fixture.writes.at(-1)[2].content);
      await action.handler(
        {
          ...request,
          operation: 'submit',
          candidateId: response.candidateId,
          replacements: [
            {
              path: 'domain/fact.md',
              replacementMarkdown: '# Fact\nPrimary fact.\n',
              sourceLocators: ['https://primary.example/fact'],
            },
          ],
        },
        writer,
      );
      expect(fixture.writes.some((args) => args[1] === 'fresh-verifier' && args[2].kind === 'task')).toBe(true);
      expect(fixture.token).not.toHaveBeenCalled();
      const store = new CandidateStore(path.join(fixture.root, 'wiki-admission', 'candidates'));
      const candidate = store.get(response.candidateId)!;
      store.close();
      const result = {
        ...request,
        operation: 'verdict',
        candidateId: candidate.id,
        inputDigest: candidate.inputDigest,
        verdict: 'accept',
        reasons: 'Direct primary support.',
        support: [{ path: 'domain/fact.md', passage: 'Primary fact.', sourceIds: ['primary'] }],
      };
      const verifier = { id: 'fresh-verifier', agent_group_id: 'verifier', thread_id: 'task-verifier' };
      if (revoke) {
        fs.writeFileSync(identityPath(), JSON.stringify({ version: 1, actorGroupIds: ['writer', 'retired'] }));
        await expect(action.options.precheck(result, verifier)).rejects.toThrow('identity');
        await expect(action.handler(result, verifier)).rejects.toThrow('identity');
        expect(fixture.head).toBe(candidate.base);
        expect(fixture.token).not.toHaveBeenCalled();
        expect(fixture.notice).not.toHaveBeenCalled();
      } else {
        expect(await action.options.precheck(result, verifier)).toBe(true);
        await action.handler(result, verifier);
        expect(fixture.head).toBe(candidate.head);
        expect(fixture.token).toHaveBeenCalledOnce();
        expect(fixture.notice).toHaveBeenCalledOnce();
        expect(fixture.notice).toHaveBeenLastCalledWith(
          'test',
          'fixture',
          null,
          'chat',
          expect.any(String),
          undefined,
          'wiki-test',
        );
        expect(JSON.stringify(fixture.writes)).not.toContain('fixture-host-token');
      }
    },
  );
});
