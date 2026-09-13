import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WikiAdmission, type WikiEffects } from './engine.js';
import { candidateDirectory, replacements, WikiGit } from './git.js';
import { digest, readWikiPublicationPolicy, type WikiPolicy } from './policy.js';
import { CandidateStore } from './store.js';
import { refreshManagedGitHooks, decideHooksMountStrategy } from '../managed-git-hooks.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const policy: WikiPolicy = {
  version: 1,
  workgroupId: 'example',
  repository: 'wiki',
  defaultRef: 'refs/heads/main',
  writerGroupId: 'writer',
  verifierGroupId: 'verifier',
  seriesId: 'wiki-synth-example',
  sourcePrefixes: ['https://primary.example/'],
  notification: { channelType: 'test', instance: 'test', platformId: 'example', threadId: null },
};
const text = '# Materials\nThe marketplace accepts surplus soil.\n';
const edits = [
  { path: 'domain/product.md', replacementMarkdown: text, sourceLocators: ['https://primary.example/materials'] },
];
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args],
    {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8',
      stdio: 'pipe',
    },
  ).trim();

let root: string;
let remote: string;
let seed: string;
let hook: string;
let store: CandidateStore;
let effects: WikiEffects;
let admission: WikiAdmission;
let currentDigest: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-admission-'));
  seed = path.join(root, 'seed');
  remote = path.join(root, 'remote.git');
  hook = path.join(root, 'hooks');
  fs.mkdirSync(path.join(seed, 'domain'), { recursive: true });
  fs.mkdirSync(hook);
  fs.writeFileSync(path.join(hook, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'domain', 'product.md'), '# Materials\n');
  git(seed, 'add', 'domain/product.md');
  git(seed, 'commit', '-qm', 'initial');
  git(root, 'clone', '--bare', seed, remote);
  store = new CandidateStore(path.join(root, 'candidates'));
  currentDigest = digest(JSON.stringify(policy));
  effects = {
    policy: () => ({ policy, digest: currentDigest, origin: remote }),
    git: (candidate) =>
      new WikiGit(
        candidateDirectory(store.root, candidate.id),
        candidate.origin,
        policy.defaultRef,
        async () => ({ GIT_ALLOW_PROTOCOL: 'file' }),
        () => hook,
      ),
    source: vi.fn(async (url) => ({
      id: 'source-1',
      url,
      sha256: digest(text),
      body: text,
      retrievedAt: new Date().toISOString(),
    })),
    verifierSession: async () => 'fresh-verifier-session',
    deliverReview: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  admission = new WikiAdmission(store, effects);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function proposed() {
  const candidate = await admission.begin('writer-session', 'request-1');
  await admission.submit('writer-session', candidate.candidateId, edits);
  return store.get(candidate.candidateId)!;
}
function verdict(id: string) {
  return {
    candidateId: id,
    inputDigest: store.get(id)!.inputDigest,
    verdict: 'accept',
    reasons: 'The primary text directly supports this claim.',
    support: [{ path: 'domain/product.md', passage: 'The marketplace accepts surplus soil.', sourceIds: ['source-1'] }],
  };
}
const head = () => git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main');

describe('host-owned publication', () => {
  it.each(['origin', 'ref'] as const)(
    'refuses a Git instance whose %s differs from the accepted target',
    async (field) => {
      const c = await proposed();
      effects.git = () => {
        const backend = new WikiGit(
          candidateDirectory(store.root, c.id),
          field === 'origin' ? 'https://github.com/example/other.git' : c.origin,
          field === 'ref' ? 'refs/heads/other' : policy.defaultRef,
          async () => ({ GIT_ALLOW_PROTOCOL: 'file' }),
          () => hook,
        );
        backend.remoteHead = async () => c.base;
        return backend;
      };
      vi.mocked(execFile).mockClear();
      expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('uncertain');
      expect(
        vi.mocked(execFile).mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes('push')),
      ).toHaveLength(0);
      expect(head()).toBe(c.base);
    },
  );
  it.each(['verdict', 'recovery'] as const)(
    '%s rechecks identity, policy, origin and ref after deferred credentials and before exec',
    async (entry) => {
      for (const revoke of ['identity', 'policy', 'origin', 'ref'] as const) {
        const file = path.join(root, 'admission.json');
        const identity = path.join(root, 'actors.json');
        fs.writeFileSync(file, JSON.stringify(policy));
        fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }));
        let origin = remote;
        effects.policy = () => {
          const loaded = readWikiPublicationPolicy(file);
          if (!loaded) throw new Error('Publication disabled');
          return { ...loaded, origin };
        };
        const originalGit = effects.git;
        const begun = await admission.begin('writer-session', `deferred-${revoke}`);
        await admission.submit('writer-session', begun.candidateId, edits);
        const c = store.get(begun.candidateId)!;
        let release!: () => void;
        let waiting!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          waiting = resolve;
        });
        let resolutions = 0;
        effects.git = (candidate) =>
          new WikiGit(
            candidateDirectory(store.root, candidate.id),
            candidate.origin,
            policy.defaultRef,
            async () => {
              // The first remote call reads the head; the second would launch the push.
              if (++resolutions === 2) {
                waiting();
                await held;
              }
              return { GIT_ALLOW_PROTOCOL: 'file' };
            },
            () => hook,
          );
        vi.mocked(execFile).mockClear();
        if (entry === 'recovery')
          store.transition(c.id, ['verifying'], 'accepted', {
            receipt: JSON.stringify({ verdict: 'accept', reason: 'fixture acceptance' }),
          });
        const operation =
          entry === 'verdict' ? admission.verdict('fresh-verifier-session', verdict(c.id)) : admission.recover();
        await entered;
        if (revoke === 'identity')
          fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'retired'] }));
        if (revoke === 'policy') fs.unlinkSync(file);
        if (revoke === 'origin') origin = 'https://github.com/example/other.git';
        if (revoke === 'ref') fs.writeFileSync(file, JSON.stringify({ ...policy, defaultRef: 'refs/heads/other' }));
        release();
        await operation;
        const pushExecs = vi
          .mocked(execFile)
          .mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes('push'));
        expect(pushExecs).toHaveLength(0);
        expect(head()).toBe(c.base);
        expect(store.get(c.id)?.state).toBe('uncertain');
        expect(effects.notify).not.toHaveBeenCalled();
        effects.git = originalGit;
        // Remove this fixture's retry eligibility before exercising the next independent case.
        store.transition(c.id, ['uncertain'], 'rejected');
      }
    },
  );
  it.each(['unchanged', 'missing', 'malformed', 'unlisted', 'changed'] as const)(
    'the restricted publisher revalidates durable identity (%s)',
    async (change) => {
      const file = path.join(root, 'admission.json');
      const identity = path.join(root, 'actors.json');
      fs.writeFileSync(file, JSON.stringify(policy));
      fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }));
      effects.policy = () => ({ ...readWikiPublicationPolicy(file)!, origin: remote });
      const c = await proposed();
      const push = vi.spyOn(WikiGit.prototype, 'push');
      if (change === 'missing') fs.unlinkSync(identity);
      if (change === 'malformed') fs.writeFileSync(identity, '{broken');
      if (change === 'unlisted')
        fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'other'] }));
      if (change === 'changed')
        fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier', 'retired'] }));
      if (change === 'unchanged') {
        expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('published');
        expect(head()).toBe(c.head);
        expect(push).toHaveBeenCalledOnce();
      } else {
        await expect(admission.verdict('fresh-verifier-session', verdict(c.id))).rejects.toThrow();
        expect(push).not.toHaveBeenCalled();
        expect(head()).toBe(c.base);
      }
    },
  );
  it.each([undefined, null, '', '  \n', 42, {}, [], 'x'.repeat(2049)])(
    'rejects malformed required reasons %# without a push',
    async (reasons) => {
      const c = await proposed();
      const push = vi.spyOn(WikiGit.prototype, 'push');
      expect(await admission.verdict('fresh-verifier-session', { ...verdict(c.id), reasons })).toBe('rejected');
      expect(push).not.toHaveBeenCalled();
      expect(head()).toBe(c.base);
      expect(JSON.parse(store.get(c.id)!.receipt!).reason).toBe('invalid-verdict');
    },
  );
  it('accepts the bounded reason limit without truncation', async () => {
    const c = await proposed();
    const reasons = 'x'.repeat(2048);
    expect(await admission.verdict('fresh-verifier-session', { ...verdict(c.id), reasons })).toBe('published');
    expect(JSON.parse(store.get(c.id)!.receipt!).reason).toBe(reasons);
  });
  it.each([
    { verdict: 'maybe' },
    { support: null },
    { support: [{}] },
    { support: [{ path: 'domain/product.md', passage: 1, sourceIds: ['source-1'] }] },
    { support: [{ path: 'domain/product.md', passage: 'The marketplace accepts surplus soil.', sourceIds: [null] }] },
  ])('rejects malformed response fields %#', async (fields) => {
    const c = await proposed();
    const push = vi.spyOn(WikiGit.prototype, 'push');
    expect(await admission.verdict('fresh-verifier-session', { ...verdict(c.id), ...fields })).toBe('rejected');
    expect(push).not.toHaveBeenCalled();
  });
  it.each([30 * 60 * 1000, 90 * 24 * 60 * 60 * 1000])(
    'expires a late verdict at age %s without a sweep',
    async (age) => {
      const c = await proposed();
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(c.createdAt) + age);
      const push = vi.spyOn(WikiGit.prototype, 'push');
      expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('rejected');
      expect(store.get(c.id)?.input).toBeNull();
      expect(push).not.toHaveBeenCalled();
      expect(effects.notify).not.toHaveBeenCalled();
    },
  );
  it('expires an old submission before fetching or starting a verifier', async () => {
    const c = await admission.begin('writer-session', 'old-submission');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(store.get(c.candidateId)!.createdAt) + 30 * 60 * 1000);
    expect(await admission.submit('writer-session', c.candidateId, edits)).toBe('rejected');
    expect(effects.source).not.toHaveBeenCalled();
    expect(effects.deliverReview).not.toHaveBeenCalled();
  });
  it('checks the deadline again after asynchronous preparation before sealing', async () => {
    const c = await admission.begin('writer-session', 'slow-submission');
    effects.verifierSession = async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(store.get(c.candidateId)!.createdAt) + 30 * 60 * 1000);
      return 'fresh-verifier-session';
    };
    expect(await admission.submit('writer-session', c.candidateId, edits)).toBe('rejected');
    expect(store.get(c.candidateId)?.verifierSession).toBeNull();
    expect(effects.deliverReview).not.toHaveBeenCalled();
  });
  it.each(['exhausted', 'unreachable', 'policy', 'artifact', 'receipt'] as const)(
    'recovery progresses past 20 %s candidates across store reopen',
    async (failure) => {
      const c = await proposed();
      store.db.prepare('DELETE FROM candidates WHERE id=?').run(c.id);
      for (let i = 0; i < 20; i++)
        store.insert({
          ...c,
          id: `blocked-${i}`,
          requestId: `blocked-${i}`,
          state: 'uncertain',
          attempts: 2,
          policyDigest: failure === 'policy' ? 'obsolete-policy' : c.policyDigest,
          receipt: failure === 'receipt' ? '{invalid' : JSON.stringify({ verdict: 'accept' }),
        });
      store.insert({ ...c, state: 'accepted', receipt: JSON.stringify({ verdict: 'accept' }) });
      const original = effects.git;
      effects.git = (candidate) => {
        const backend = original(c);
        if (candidate.id !== c.id) {
          backend.assertFrozen = async () => {
            if (failure === 'artifact') throw new Error('corrupt artifact');
          };
          backend.remoteHead = async () => {
            if (failure === 'unreachable') throw new Error('network unavailable');
            return c.base;
          };
          backend.push = async () => {
            throw new Error('exhausted candidate must not push');
          };
        }
        return backend;
      };
      const firstFailures = await admission.recover();
      expect(firstFailures).toBe(['policy', 'artifact', 'receipt'].includes(failure) ? 16 : 0);
      expect(store.get(c.id)?.state).toBe('accepted');
      store.close();
      store = new CandidateStore(path.join(root, 'candidates'));
      admission = new WikiAdmission(store, effects);
      await admission.recover();
      expect(store.get(c.id)?.state).toBe('published');
      expect(head()).toBe(c.head);
      expect(effects.notify).toHaveBeenCalledOnce();
      expect(store.get('blocked-0')?.state).toBe(failure === 'exhausted' ? 'rejected' : 'uncertain');
      expect(store.get('blocked-0')?.attempts).toBe(2);
    },
  );
  it('isolates a failed review delivery and continues within the same batch', async () => {
    const c = await proposed();
    store.insert({
      ...c,
      id: 'later',
      requestId: 'later',
      state: 'accepted',
      receipt: JSON.stringify({ verdict: 'accept' }),
    });
    const original = effects.git;
    effects.git = () => original(c);
    effects.deliverReview = async () => {
      throw new Error('verifier unavailable');
    };
    expect(await admission.recover()).toBe(1);
    expect(store.get(c.id)?.state).toBe('verifying');
    expect(store.get('later')?.state).toBe('published');
  });
  it('initializes the recovery cursor for an existing candidate database without changing candidates', async () => {
    const c = await proposed();
    store.db.exec('DROP TABLE recovery_cursor');
    store.close();
    store = new CandidateStore(path.join(root, 'candidates'));
    expect(store.get(c.id)).toEqual(c);
    expect(store.recoverable().map((row) => row.id)).toEqual([c.id]);
  });
  it('expires queued verification even when an earlier accepted artifact is invalid', async () => {
    const c = await proposed();
    store.transition(c.id, ['verifying'], 'accepted', { receipt: '{invalid' });
    store.insert({ ...c, id: 'expired-later', requestId: 'expired-later' });
    expect(await admission.recover(Date.parse(c.createdAt) + 30 * 60 * 1000)).toBe(1);
    expect(store.get(c.id)?.state).toBe('accepted');
    expect(store.get('expired-later')?.state).toBe('rejected');
    expect(head()).toBe(c.base);
  });
  it('publishes exactly the accepted tree, once, then drops full source bodies', async () => {
    const initial = head();
    const c = await proposed();
    expect(head()).toBe(initial);
    expect(c.state).toBe('verifying');
    expect(effects.deliverReview).toHaveBeenCalledOnce();
    expect(JSON.parse(c.input!).sources[0].body).toBe(text);
    expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('published');
    expect(head()).toBe(c.head);
    expect(git(root, '--git-dir', remote, 'show', `${head()}:domain/product.md`)).toBe(text.trim());
    expect(store.get(c.id)?.input).toBeNull();
    await admission.verdict('fresh-verifier-session', verdict(c.id));
    await admission.recover();
    expect(effects.notify).toHaveBeenCalledOnce();
    expect(store.get(c.id)?.attempts).toBe(1);
  });
  it('an unsupported agent report cannot reach commit creation or publication', async () => {
    const initial = head();
    effects.source = vi.fn(async () => {
      throw new Error('report names a query but no primary artifact is readable');
    });
    const c = await admission.begin('writer-session', 'request-1');
    expect(await admission.submit('writer-session', c.candidateId, edits)).toBe('rejected');
    expect(store.get(c.candidateId)?.head).toBe(initial);
    expect(head()).toBe(initial);
    expect(effects.deliverReview).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
    await expect(admission.verdict('writer-session', { ...verdict(c.candidateId), inputDigest: null })).rejects.toThrow(
      'Unbound',
    );
  });
  it('rejects forged session, digest, source receipt and omitted changed-page coverage', async () => {
    const c = await proposed();
    const initial = head();
    await expect(admission.verdict('writer-session', verdict(c.id))).rejects.toThrow('Unbound');
    await expect(admission.verdict('other-verifier', verdict(c.id))).rejects.toThrow('Unbound');
    await expect(
      admission.verdict('fresh-verifier-session', { ...verdict(c.id), inputDigest: 'made-up' }),
    ).rejects.toThrow('Unbound');
    expect(await admission.verdict('fresh-verifier-session', { ...verdict(c.id), support: [] })).toBe('rejected');
    expect(head()).toBe(initial);
    expect(effects.notify).not.toHaveBeenCalled();
  });
  it('rejects acceptance naming a writer-invented source id', async () => {
    const c = await proposed();
    const v = verdict(c.id);
    v.support[0].sourceIds = ['writer-report'];
    expect(await admission.verdict('fresh-verifier-session', v)).toBe('rejected');
    expect(effects.notify).not.toHaveBeenCalled();
  });
  it('does not allow another writer session or resubmission to change the frozen tree', async () => {
    const c = await proposed();
    await expect(admission.submit('other-writer', c.id, edits)).rejects.toThrow('another session');
    expect(await admission.submit('writer-session', c.id, [{ ...edits[0], replacementMarkdown: 'invented' }])).toBe(
      'verifying',
    );
    expect(store.get(c.id)?.head).toBe(c.head);
    expect(() => store.transition(c.id, ['verifying'], 'accepted', { head: 'changed' })).toThrow('Immutable');
  });
  it('a policy change invalidates acceptance', async () => {
    const c = await proposed();
    currentDigest = 'new-policy';
    await expect(admission.verdict('fresh-verifier-session', verdict(c.id))).rejects.toThrow('policy or origin');
    expect(head()).toBe(c.base);
  });
  it('a newer remote head becomes stale and is never overwritten', async () => {
    const c = await proposed();
    fs.writeFileSync(path.join(seed, 'unrelated.txt'), 'other writer');
    git(seed, 'add', 'unrelated.txt');
    git(seed, 'commit', '-qm', 'other writer');
    git(seed, 'push', remote, 'main');
    const moved = head();
    expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('stale');
    expect(head()).toBe(moved);
    expect(store.get(c.id)?.attempts).toBe(0);
  });
  it('the exact lease catches a remote change after its pre-check', async () => {
    const c = await proposed();
    const original = effects.git;
    effects.git = (candidate) => {
      const backend = original(candidate);
      const push = backend.push.bind(backend);
      backend.push = async (base, next, authorizePush) => {
        fs.writeFileSync(path.join(seed, 'race.txt'), 'concurrent');
        git(seed, 'add', 'race.txt');
        git(seed, 'commit', '-qm', 'race');
        git(seed, 'push', remote, 'main');
        return push(base, next, authorizePush);
      };
      return backend;
    };
    expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('uncertain');
    const moved = head();
    await admission.recover();
    expect(store.get(c.id)?.state).toBe('stale');
    expect(head()).toBe(moved);
  });
  it('reconciles a crash after the remote update without a second push', async () => {
    const c = await proposed();
    store.transition(c.id, ['verifying'], 'accepted', { receipt: JSON.stringify({ verdict: 'accept' }) });
    store.transition(c.id, ['accepted'], 'publishing', { attempts: 1 });
    await effects.git(c).push(c.base, c.head, () => {});
    await admission.recover();
    expect(store.get(c.id)?.state).toBe('published');
    expect(store.get(c.id)?.attempts).toBe(1);
    expect(effects.notify).toHaveBeenCalledOnce();
  });
  it('keeps the required pre-push hook on the actual push', async () => {
    const c = await proposed();
    fs.writeFileSync(path.join(hook, 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    expect(await admission.verdict('fresh-verifier-session', verdict(c.id))).toBe('uncertain');
    expect(head()).toBe(c.base);
    expect(effects.notify).not.toHaveBeenCalled();
    await admission.recover();
    await admission.recover();
    expect(store.get(c.id)?.attempts).toBe(2);
  });
  it('the shipped managed scanner refuses a secret-bearing candidate despite a verifier accept', async () => {
    const managed = path.join(root, 'managed-git-hooks', 'scan');
    refreshManagedGitHooks(managed);
    expect(decideHooksMountStrategy(managed, path.join(root, 'managed-git-hooks', 'refuse'))).toBe('scan');
    hook = managed;
    const c = await admission.begin('writer-session', 'secret-control');
    const bad = text + '\n-----BEGIN ' + 'PRIVATE KEY-----\nfixture-only\n';
    await admission.submit('writer-session', c.candidateId, [{ ...edits[0], replacementMarkdown: bad }]);
    expect(await admission.verdict('fresh-verifier-session', verdict(c.candidateId))).toBe('uncertain');
    expect(head()).toBe(c.base);
    expect(effects.notify).not.toHaveBeenCalled();
  });
  it('records a failed publication notice without changing the successful remote outcome', async () => {
    const c = await proposed();
    effects.notify = vi.fn(async () => {
      throw new Error('adapter unavailable');
    });
    await expect(admission.verdict('fresh-verifier-session', verdict(c.id))).rejects.toThrow('notification failed');
    expect(head()).toBe(c.head);
    expect(store.get(c.id)?.state).toBe('published');
    expect(JSON.parse(store.get(c.id)!.receipt!).notification).toBe('failed-or-unconfirmed');
  });
  it('expires unfinished verification quietly and reuses a begin request identity', async () => {
    const c = await proposed();
    expect((await admission.begin('writer-session', 'request-1')).candidateId).toBe(c.id);
    await admission.recover(Date.parse(c.createdAt) + 31 * 60 * 1000);
    expect(store.get(c.id)?.state).toBe('rejected');
    expect(store.get(c.id)?.input).toBeNull();
    expect(effects.notify).not.toHaveBeenCalled();
  });
  it.each([
    '../outside.md',
    'domain/../outside.md',
    'tools/humans.json',
    'domain/link',
    '/domain/a.md',
    'domain/:x.md',
  ])('refuses unsafe candidate path %s', (p) => expect(() => replacements([{ ...edits[0], path: p }])).toThrow());
  it('rejects oversize source context without passing a partial input to the verifier', async () => {
    effects.source = async (url) => ({
      id: 'source-1',
      url,
      sha256: 'digest',
      body: 'x'.repeat(256 * 1024),
      retrievedAt: new Date().toISOString(),
    });
    const c = await admission.begin('writer-session', 'large');
    expect(await admission.submit('writer-session', c.candidateId, edits)).toBe('rejected');
    expect(effects.deliverReview).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
  });
});
