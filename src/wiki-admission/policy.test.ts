import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedWikiOutbound,
  assertWikiActorConfig,
  parsePolicy,
  readWikiPublicationPolicy,
  wikiEnrollment,
  type Enrollment,
} from './policy.js';
import { publicAddress, sourceUrl } from './sources.js';
import { privateWikiRuntime, wikiProviderContribution, wikiRuntimeEnvironment } from './runtime.js';
import type { ContainerConfig } from '../container-config.js';

const policy = parsePolicy({
  version: 1,
  workgroupId: 'example',
  repository: 'wiki',
  defaultRef: 'refs/heads/main',
  writerGroupId: 'writer',
  verifierGroupId: 'verifier',
  seriesId: 'synth-example',
  sourcePrefixes: ['https://primary.example/'],
  notification: { channelType: 'test', instance: 'test', platformId: 'example', threadId: null },
});
const enrollment: Enrollment = { policy, role: 'writer', digest: 'test' };
const config: ContainerConfig = {
  wikiMaintenance: true,
  provider: 'codex',
  model: 'gpt-6-astra',
  effort: 'medium',
  skills: [],
  tools: [],
  mcpServers: {},
  additionalMounts: [],
  packages: { apt: [], npm: [] },
};
let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('maintenance authority', () => {
  it('requires an exact channel instance for the host publication notice', () => {
    const withoutInstance = {
      ...policy,
      notification: { channelType: 'test', platformId: 'example', threadId: null },
    };
    expect(() => parsePolicy(withoutInstance)).toThrow('notification');
  });

  it('requires both host enrollment and an actor marker; a missing policy is never unrestricted', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-policy-'));
    const file = path.join(root, 'policy.json');
    expect(() => wikiEnrollment('writer', true, file)).toThrow('no host enrollment');
    expect(wikiEnrollment('ordinary', false, file)).toBeNull();
    fs.writeFileSync(
      path.join(root, 'actors.json'),
      JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }),
    );
    fs.writeFileSync(file, JSON.stringify(policy));
    expect(() => wikiEnrollment('writer', false, file)).toThrow('marker');
    expect(wikiEnrollment('writer', true, file)?.role).toBe('writer');
    fs.writeFileSync(file, '{}');
    expect(() => wikiEnrollment('writer', true, file)).toThrow();
  });
  it.each(['{malformed', '{}', null])(
    'isolates broken publication policy %# without releasing marked or unmarked actors',
    (raw) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-policy-'));
      const file = path.join(root, 'admission.json');
      fs.writeFileSync(
        path.join(root, 'actors.json'),
        JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier', 'retired'] }),
      );
      if (raw !== null) fs.writeFileSync(file, raw);
      expect(wikiEnrollment('ordinary', false, file)).toBeNull();
      for (const actor of ['writer', 'verifier', 'retired']) {
        expect(() => wikiEnrollment(actor, false, file)).toThrow('marker');
        expect(() => wikiEnrollment(actor, true, file)).toThrow();
      }
      expect(() => wikiEnrollment('ordinary', true, file)).toThrow('identity');
    },
  );
  it('the publisher requires both identities and binds the durable restriction record', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-policy-'));
    const file = path.join(root, 'admission.json');
    const actors = path.join(root, 'actors.json');
    fs.writeFileSync(file, JSON.stringify(policy));
    expect(() => readWikiPublicationPolicy(file)).toThrow('identity');
    expect(() => wikiEnrollment('ordinary', false, file)).toThrow('identity');
    fs.writeFileSync(actors, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'other'] }));
    expect(() => readWikiPublicationPolicy(file)).toThrow('identity');
    fs.writeFileSync(actors, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }));
    const first = readWikiPublicationPolicy(file)!;
    expect(first.policy).toEqual(policy);
    fs.writeFileSync(actors, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier', 'retired'] }));
    expect(readWikiPublicationPolicy(file)!.digest).not.toBe(first.digest);
    expect(() => wikiEnrollment('retired', false, file)).toThrow('marker');
    expect(() => wikiEnrollment('retired', true, file)).toThrow('active publication');
  });
  it.each(['{broken', '{}', JSON.stringify({ version: 1, actorGroupIds: ['writer', 'writer'] })])(
    'never silently reconstructs malformed identity %#',
    (raw) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-policy-'));
      const file = path.join(root, 'admission.json');
      fs.writeFileSync(file, JSON.stringify(policy));
      fs.writeFileSync(path.join(root, 'actors.json'), raw);
      expect(() => wikiEnrollment('ordinary', false, file)).toThrow();
      expect(() => wikiEnrollment('writer', false, file)).toThrow();
      expect(() => readWikiPublicationPolicy(file)).toThrow();
    },
  );
  it('refuses symlinked identity and never follows it', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-policy-'));
    const file = path.join(root, 'admission.json');
    fs.writeFileSync(file, JSON.stringify(policy));
    fs.symlinkSync(file, path.join(root, 'actors.json'));
    expect(() => wikiEnrollment('ordinary', false, file)).toThrow();
    expect(() => readWikiPublicationPolicy(file)).toThrow();
  });
  // `codexHostAuth` is a RETIRED key: `assertWikiActorConfig` refuses it as an
  // unknown key rather than as a named capability, and `materializeContainerConfig`
  // drops it before the spawn path anyway (src/container-config.ts:1290). Kept
  // deliberately — 17 on-disk `groups/*/container.json` still carry it and
  // `SIBLING_BOUND_FIELDS` still names it (src/sibling-parity.ts:53), so it
  // remains a key a config can present. Drop it here when that entry goes.
  it.each(['githubTokenEnv', 'credentialFolder', 'providerFallback', 'onecliSecrets', 'codexHostAuth', 'wixHostAuth'])(
    'rejects application capability %s before spawn',
    (key) => {
      expect(() => assertWikiActorConfig({ ...config, [key]: 'unexpected' }, enrollment, 'example')).toThrow();
    },
  );
  it('accepts the narrow profile and refuses shared/application mounts and credential environment', () => {
    expect(() => assertWikiActorConfig(config, enrollment, 'example')).not.toThrow();
    expect(() => assertWikiActorConfig(config, enrollment, 'another')).toThrow('workgroup');
    expect(() =>
      wikiProviderContribution(
        { mounts: [{ hostPath: '/host', containerPath: '/host', readonly: false }] },
        '/session',
        'codex',
      ),
    ).toThrow();
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_TOKEN_FILE', 'HTTPS_PROXY', 'RENDER_API_KEY']) {
      expect(() => wikiRuntimeEnvironment('codex', 'gpt-6-astra', 'medium', { [key]: 'fake' }, 'example')).toThrow();
    }
    expect(
      wikiRuntimeEnvironment(
        'claude',
        undefined,
        undefined,
        { ANTHROPIC_API_KEY: 'primary', ANTHROPIC_API_KEY_2: 'fallback' },
        'example',
      ),
    ).toMatchObject({ ANTHROPIC_API_KEY: 'primary', ANTHROPIC_API_KEY_2: 'fallback' });
    const env = wikiRuntimeEnvironment(
      'codex',
      'gpt-6-astra',
      'medium',
      { OPENAI_API_KEY: 'fake-model-only' },
      'example',
    );
    expect(env.NANOCLAW_WIKI_MAINTENANCE).toBe('1');
    expect(env.GH_TOKEN).toBeUndefined();
    // setup-token credentials carry user:inference only; claiming user:profile
    // makes the CLI call endpoints that 403 and then 429 for these tokens.
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe('user:inference');
  });
  it('private runtime mounts no mutable group source, repository or shared memory', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-runtime-'));
    const mounts = privateWikiRuntime(root, config);
    expect(mounts.filter((m) => !m.readonly).map((m) => m.hostPath)).toEqual([
      path.join(root, 'agent'),
      path.join(root, 'claude'),
    ]);
    const host = path.join(root, 'host');
    expect(mounts.filter((m) => m.readonly).every((m) => m.hostPath.startsWith(host + '/'))).toBe(true);
  });
  it('the outbound gate denies raw message and privileged-action bypasses', () => {
    for (const kind of ['chat', 'chat-sdk', 'status', 'file']) expect(allowedWikiOutbound(kind, '')).toBe(false);
    for (const action of ['repository_publish', 'cli_request', 'create_agent', 'install_packages', 'agent_message']) {
      expect(allowedWikiOutbound('system', action)).toBe(false);
    }
    expect(allowedWikiOutbound('system', 'wiki_admission')).toBe(true);
    expect(allowedWikiOutbound('system', 'turn_end')).toBe(true);
    expect(allowedWikiOutbound('task_log', null)).toBe(true);
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '2002:7f00:1::',
  ])('does not connect to nonpublic address %s', (ip) => expect(publicAddress(ip)).toBe(false));
  it('validates the primary publisher and scheme, without an agent-controlled URL proxy', () => {
    expect(sourceUrl('https://primary.example/materials', policy).host).toBe('primary.example');
    for (const url of [
      'file:///tmp/report',
      'https://primary.example.evil/materials',
      'https://primary.example@evil/x',
      'http://primary.example/x',
      'https://primary.example/x?token=fake',
      'https://127.0.0.1/',
    ]) {
      expect(() => sourceUrl(url, policy)).toThrow();
    }
    expect(publicAddress('8.8.8.8')).toBe(true);
  });
});
