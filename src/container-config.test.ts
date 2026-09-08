import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configFromDb,
  mcpServerPluginOwner,
  opaqueUrlParts,
  parseMcpServerConfig,
  validateMcpServerName,
  readContainerConfig,
  readContainerConfigForSpawn,
  readContainerConfigStrict,
  effectiveTimezone,
  honouredTimezoneOverride,
  resolveGroupTimezone,
  updateContainerConfig,
  writeContainerConfig,
} from './container-config.js';
import { TIMEZONE } from './config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb, getRawDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';
import knownSecretShapes from '../tests/fixtures/mcp-known-secret-shapes.json' with { type: 'json' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cc-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Stub GROUPS_DIR by writing container.json directly into a subfolder of tmpDir
// readContainerConfig takes a folder name and resolves it against GROUPS_DIR.
// Since we can't easily override GROUPS_DIR, we use vi.mock below to redirect it.

import { vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: GROUPS_DIR };
});

const { GROUPS_DIR } = vi.hoisted(() => ({ GROUPS_DIR: uniqueTmpRoot('cc-test-groups') }));

function writeGroupConfig(folder: string, content: object): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(content, null, 2) + '\n');
}

describe('workgroup and capability config', () => {
  it('test_workgroup_id_round_trip', () => {
    // writeContainerConfig + readContainerConfig must preserve workgroup_id
    const folder = 'test-wg-roundtrip';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      workgroup_id: 'my-workgroup-123',
    };
    writeContainerConfig(folder, config);
    const result = readContainerConfig(folder);
    expect(result.workgroup_id).toBe('my-workgroup-123');
  });

  it('test_slack_user_token_round_trip', () => {
    // writeContainerConfig + readContainerConfig must preserve slack_user_token
    // (enabled flag + override allow-list)
    const folder = 'test-slack-user-token-roundtrip';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      slack_user_token: {
        enabled: true,
        also_allowed_in: ['mg-channel-eng-leads-private'],
      },
    };
    writeContainerConfig(folder, config);
    const result = readContainerConfig(folder);
    expect(result.slack_user_token?.enabled).toBe(true);
    expect(result.slack_user_token?.also_allowed_in).toEqual(['mg-channel-eng-leads-private']);
  });

  it('test_slack_user_token_undefined_when_absent', () => {
    const folder = 'test-slack-user-token-absent';
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    writeContainerConfig(folder, {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
    });
    const result = readContainerConfig(folder);
    expect(result.slack_user_token).toBeUndefined();
  });
});

describe('gitIdentity config', () => {
  const baseConfig = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all' as const,
  };

  it('round-trips an explicit per-agent author and committer identity', () => {
    writeContainerConfig('test-git-identity', {
      ...baseConfig,
      gitIdentity: { name: 'Fixture Agent', email: 'fixture-agent@example.invalid' },
    });

    expect(readContainerConfig('test-git-identity').gitIdentity).toEqual({
      name: 'Fixture Agent',
      email: 'fixture-agent@example.invalid',
    });
  });

  it('leaves the established scoped-credential behavior available when absent', () => {
    writeContainerConfig('test-git-identity-absent', baseConfig);
    expect(readContainerConfig('test-git-identity-absent').gitIdentity).toBeUndefined();
  });

  it.each([
    null,
    'fixture',
    {},
    { name: 'Fixture Agent' },
    { email: 'fixture-agent@example.invalid' },
    { name: '', email: 'fixture-agent@example.invalid' },
    { name: 'Fixture <Agent>', email: 'fixture-agent@example.invalid' },
    { name: `Fixture ${String.fromCodePoint(0x9b)} Agent`, email: 'fixture-agent@example.invalid' },
    { name: 'Fixture\nAgent', email: 'fixture-agent@example.invalid' },
    { name: 'Fixture Agent', email: 'not-an-email' },
    { name: 'Fixture Agent', email: '@example.invalid' },
    { name: 'Fixture Agent', email: 'fixture-agent@' },
    { name: 'Fixture Agent', email: 'fixture@agent@example.invalid' },
    { name: 'Fixture Agent', email: `fixture${String.fromCodePoint(0x85)}agent@example.invalid` },
    { name: 'Fixture Agent', email: 'fixture\u0001agent@example.invalid' },
  ])('rejects malformed all-or-nothing identity declarations: %j', (gitIdentity) => {
    writeGroupConfig('test-git-identity-invalid', { ...baseConfig, gitIdentity });
    expect(() => readContainerConfig('test-git-identity-invalid')).toThrow(/gitIdentity/);
  });

  it('validates direct writes as well as hand-edited config files', () => {
    expect(() =>
      writeContainerConfig('test-git-identity-invalid-write', {
        ...baseConfig,
        gitIdentity: { name: 'Fixture Agent', email: '' },
      }),
    ).toThrow(/gitIdentity/);
  });
});

describe('readContainerConfigStrict', () => {
  it('returns the same normalized snapshot for a valid regular file', () => {
    writeGroupConfig('test-strict-valid', { workgroup_id: 'workgroup-a' });
    expect(readContainerConfigStrict('test-strict-valid').workgroup_id).toBe('workgroup-a');
  });

  it('rejects a missing config instead of falling back to empty defaults', () => {
    expect(() => readContainerConfigStrict('test-strict-missing')).toThrow();
    expect(() => readContainerConfigForSpawn('test-strict-missing', true)).toThrow();
    expect(readContainerConfigForSpawn('test-strict-missing', false).mcpServers).toEqual({});
  });

  it('rejects malformed JSON instead of falling back to empty defaults', () => {
    const dir = path.join(GROUPS_DIR, 'test-strict-malformed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'container.json'), '{not-json\n');
    expect(() => readContainerConfigStrict('test-strict-malformed')).toThrow();
    expect(() => readContainerConfigForSpawn('test-strict-malformed', true)).toThrow();
  });
});

describe('readContainerConfig — resource block', () => {
  it('test_container_resources_round_trip', () => {
    writeGroupConfig('test-resources', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: {
        memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
        cpus: 2,
        pidsLimit: 768,
      },
    });

    expect(readContainerConfig('test-resources').resources).toEqual({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });
  });

  it('test_container_resources_invalid_file_fails_closed', () => {
    writeGroupConfig('test-invalid-resources', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      resources: {
        memory: { requestMb: 5120, limitMb: 3072, memorySwapLimitMb: 5120 },
      },
    });

    expect(() => readContainerConfig('test-invalid-resources')).toThrow(/requestMb.*limitMb/);
  });
});

describe('MCP server transport validation', () => {
  it('preserves stdio and Streamable HTTP MCP server configs', () => {
    writeGroupConfig('test-mcp-transports', {
      mcpServers: {
        local: { command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } },
        exa: {
          type: 'http',
          url: 'https://mcp.exa.ai/mcp',
          headers: { Authorization: 'Bearer placeholder' },
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-mcp-transports');

    expect(result.mcpServers.local).toEqual({ command: 'bun', args: ['run', '/app/mcp.ts'], env: { FOO: 'bar' } });
    expect(result.mcpServers.exa).toEqual({
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      headers: { Authorization: 'Bearer placeholder' },
    });
  });

  it('readContainerConfig rejects deprecated SSE MCP servers', () => {
    writeGroupConfig('test-mcp-sse-read', {
      mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    expect(() => readContainerConfig('test-mcp-sse-read')).toThrow(/deprecated SSE transport/);
  });

  it('writeContainerConfig rejects deprecated SSE MCP servers', () => {
    expect(() =>
      writeContainerConfig('test-mcp-sse-write', {
        mcpServers: { legacy: { type: 'sse', url: 'https://example.test/sse' } },
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
      }),
    ).toThrow(/deprecated SSE transport/);
  });
});

describe('MCP server cwd (Agent Plugins fixed forms)', () => {
  it('a stdio server declaring cwd survives the round trip through container.json', () => {
    updateContainerConfig('test-mcp-cwd-roundtrip', (config) => {
      config.mcpServers = {
        plugged: {
          command: 'node',
          args: ['server.js'],
          env: {},
          cwd: '${PLUGIN_ROOT}/scripts',
          pluginRoot: '/workspace/agent/plugins/sales-sdr',
        },
      };
    });

    const result = readContainerConfig('test-mcp-cwd-roundtrip');

    expect(result.mcpServers.plugged).toMatchObject({ cwd: '${PLUGIN_ROOT}/scripts' });
  });

  it('a cwd with no plugin provenance is stripped and logged', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    writeGroupConfig('test-mcp-cwd-no-provenance', {
      mcpServers: {
        naked: { command: 'node', args: [], env: {}, cwd: './scripts' },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });

    const result = readContainerConfig('test-mcp-cwd-no-provenance');

    expect(result.mcpServers.naked).not.toHaveProperty('cwd');
    expect(warnSpy).toHaveBeenCalledWith(
      'Stripping cwd from stored MCP server without plugin provenance',
      expect.objectContaining({ server: 'naked' }),
    );
    warnSpy.mockRestore();
  });

  it('parseMcpServerConfig accepts the three fixed cwd forms and rejects an escape', () => {
    const stdio = parseMcpServerConfig({ command: 'node', cwd: './scripts' }) as { command: string };
    expect(stdio.command).toBe('node');
    expect((parseMcpServerConfig({ command: 'node', cwd: '${PLUGIN_ROOT}/x' }) as { cwd?: string }).cwd).toBe(
      '${PLUGIN_ROOT}/x',
    );
    expect((parseMcpServerConfig({ command: 'node', cwd: '${PLUGIN_DATA}' }) as { cwd?: string }).cwd).toBe(
      '${PLUGIN_DATA}',
    );
    expect(() => parseMcpServerConfig({ command: 'node', cwd: '../escape' })).toThrow(/cwd must be/);
    expect(() => parseMcpServerConfig({ command: 'node', cwd: './a/../b' })).toThrow(/cwd escapes/);
  });

  it('cwd is rejected on a url (http) server', () => {
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp', cwd: './x' })).toThrow(
      /only valid with command/,
    );
  });
});

/**
 * Group-timezone resolution (per-agent-group timezone feature).
 *
 * The chain is: valid per-group override → install-global TIMEZONE. An
 * invalid stored value (hand-edited DB — the ncl write path validates) must
 * fall back to the global timezone, not silently become UTC, and must never
 * be materialized into container.json.
 */
const TZ_GROUP: AgentGroup = {
  id: 'ag-tz',
  name: 'tz',
  folder: 'tz',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('resolveGroupTimezone', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    await createAgentGroup(TZ_GROUP);
    await ensureContainerConfig(TZ_GROUP.id);
  });
  afterEach(async () => {
    await closeDb();
  });

  it('returns the install-global timezone when no override is set', async () => {
    expect(await resolveGroupTimezone(TZ_GROUP.id)).toBe(TIMEZONE);
    expect(await resolveGroupTimezone('ag-no-such-group')).toBe(TIMEZONE);
  });

  it('returns a valid override, and falls back to global on an invalid stored value', async () => {
    await updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(await resolveGroupTimezone(TZ_GROUP.id)).toBe('Asia/Tokyo');

    await updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Not/AZone' });
    expect(await resolveGroupTimezone(TZ_GROUP.id)).toBe(TIMEZONE);
  });

  it('refuses a stored value the write path would have rewritten or refused', async () => {
    // Intl accepts every one of these; the container gets the same string as
    // POSIX `TZ`, where "+01:00" means UTC-1, "CST" is a zero-offset
    // abbreviation rather than America/Chicago, and "europe/lisbon" is not a
    // zoneinfo file at all. A hand-edited row must not split the host clock
    // from the container clock.
    for (const bad of ['+01:00', '-05:00', 'CST', 'EST', 'europe/lisbon']) {
      await updateContainerConfigScalars(TZ_GROUP.id, { timezone: bad });
      expect(await resolveGroupTimezone(TZ_GROUP.id)).toBe(TIMEZONE);
      expect(configFromDb((await getContainerConfig(TZ_GROUP.id))!, TZ_GROUP).timezone).toBeUndefined();
    }
    // Whether a given alias resolves is a property of THIS machine's tzdata,
    // not of the rule: a host that prunes backward links has no
    // Asia/Calcutta, while a GitHub runner ships it. So assert the rule
    // itself — honoured exactly when the zone database has the spelling —
    // rather than hard-coding which names a host happens to carry. This is
    // still what catches storing an ICU-canonical name the host lacks.
    for (const alias of ['Asia/Kolkata', 'Asia/Calcutta', 'Europe/Kyiv', 'Europe/Kiev']) {
      await updateContainerConfigScalars(TZ_GROUP.id, { timezone: alias });
      const expected = fs.existsSync(path.join('/usr/share/zoneinfo', alias)) ? alias : TIMEZONE;
      expect(await resolveGroupTimezone(TZ_GROUP.id)).toBe(expected);
    }
  });

  it('honours a caller-supplied fallback instead of the install timezone', async () => {
    // The one caller with a better default than config's TIMEZONE is the
    // fleet report, which reads the running service's own TZ off its systemd
    // unit. An override still outranks it.
    expect(await resolveGroupTimezone(TZ_GROUP.id, 'America/Denver')).toBe('America/Denver');
    expect(await resolveGroupTimezone('ag-no-such-group', 'America/Denver')).toBe('America/Denver');

    await updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(await resolveGroupTimezone(TZ_GROUP.id, 'America/Denver')).toBe('Asia/Tokyo');
  });

  it('effectiveTimezone is the one predicate the spawn path shares', () => {
    // container-runner.ts holds the container.json value rather than a group
    // id, so it calls this directly. Same verdict either way — the container's
    // POSIX TZ and the host's cron grid can never disagree.
    expect(effectiveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(effectiveTimezone(null)).toBe(TIMEZONE);
    expect(effectiveTimezone('europe/lisbon')).toBe(TIMEZONE);
    expect(effectiveTimezone('+01:00')).toBe(TIMEZONE);
    expect(effectiveTimezone(null, 'America/Denver')).toBe('America/Denver');
    expect(honouredTimezoneOverride('europe/lisbon')).toBeUndefined();
    expect(honouredTimezoneOverride('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('configFromDb ships a valid timezone to the container and drops an invalid one', async () => {
    await updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(configFromDb((await getContainerConfig(TZ_GROUP.id))!, TZ_GROUP).timezone).toBe('Asia/Tokyo');

    await updateContainerConfigScalars(TZ_GROUP.id, { timezone: 'Not/AZone' });
    expect(configFromDb((await getContainerConfig(TZ_GROUP.id))!, TZ_GROUP).timezone).toBeUndefined();
  });

  it('round-trips through container.json so the spawn path sees the override', () => {
    writeContainerConfig('tz-file', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      timezone: 'Asia/Tokyo',
    });
    expect(readContainerConfig('tz-file').timezone).toBe('Asia/Tokyo');
  });
});

/**
 * `parseMcpServerConfig` is the single validator behind the ncl flag path, the
 * approval payload path, and template `.mcp.json` — and it is mirrored by
 * hand in container/agent-runner/src/mcp-tools/self-mod.ts. These pin the
 * rules that mirror has to match.
 */
describe('parseMcpServerConfig', () => {
  it('normalizes a local stdio server and leaves `type` implicit', () => {
    expect(parseMcpServerConfig({ command: 'mcp-fs', args: ['/data'] })).toEqual({
      command: 'mcp-fs',
      args: ['/data'],
      env: {},
    });
  });

  it('parses a remote Streamable HTTP server, with and without headers', () => {
    expect(parseMcpServerConfig({ url: 'https://mcp.deepwiki.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://mcp.deepwiki.com/mcp',
    });
    expect(
      parseMcpServerConfig({
        url: 'https://app.datafold.com/mcp/',
        headers: { Authorization: 'Key onecli-managed' },
      }),
    ).toEqual({
      type: 'http',
      url: 'https://app.datafold.com/mcp/',
      headers: { Authorization: 'Key onecli-managed' },
    });
  });

  it('accepts the "streamable-http" type alias and rejects any other transport', () => {
    expect(parseMcpServerConfig({ type: 'streamable-http', url: 'https://example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    });
    expect(() => parseMcpServerConfig({ type: 'sse', url: 'https://example.com/sse' })).toThrow(
      /unsupported MCP transport/,
    );
  });

  it('requires exactly one transport and keeps their fields apart', () => {
    expect(() => parseMcpServerConfig({})).toThrow(/exactly one of command or url/);
    expect(() => parseMcpServerConfig({ command: 'node', url: 'https://example.com/mcp' })).toThrow(
      /exactly one of command or url/,
    );
    for (const secondary of ['', ' ', 1, null]) {
      expect(() => parseMcpServerConfig({ command: 'node', url: secondary })).toThrow(/exactly one of command or url/);
      expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp', command: secondary })).toThrow(
        /exactly one of command or url/,
      );
    }
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp', args: ['x'] })).toThrow(
      /only valid with command/,
    );
    expect(() => parseMcpServerConfig({ command: 'node', headers: { 'X-A': 'b' } })).toThrow(
      /headers are only valid with url/,
    );
  });

  it('requires HTTPS except on loopback and the docker host gateway', () => {
    expect(() => parseMcpServerConfig({ url: 'http://example.com/mcp' })).toThrow(/must use HTTPS/);
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']) {
      expect(parseMcpServerConfig({ url: `http://${host}:8080/mcp` })).toMatchObject({ type: 'http' });
    }
  });

  it('rejects placeholder credentials on URLs that bypass the OneCLI gateway', () => {
    for (const scheme of ['https', 'http']) {
      for (const host of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']) {
        expect(() =>
          parseMcpServerConfig({
            url: `${scheme}://${host}:8080/mcp`,
            headers: { Authorization: 'Bearer onecli-managed' },
          }),
        ).toThrow(/placeholder headers are not allowed/);
      }
    }
    expect(
      parseMcpServerConfig({
        url: 'http://localhost:8080/mcp',
        headers: { 'Content-Type': 'application/json' },
      }),
    ).toMatchObject({ headers: { 'Content-Type': 'application/json' } });
  });

  it('rejects credentials in the URL and credential-shaped query keys, but keeps ordinary ones', () => {
    expect(() => parseMcpServerConfig({ url: 'https://u:p@example.com/mcp' })).toThrow(/must not contain credentials/);
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp#f' })).toThrow(/must not contain credentials/);
    for (const key of ['authToken', 'api_key', 'clientSecret', 'x-auth', 'jwt']) {
      expect(() => parseMcpServerConfig({ url: `https://example.com/mcp?${key}=v` })).toThrow(
        /looks like a credential/,
      );
    }
    // `author` must not trip the `auth` word — the match is word-bounded.
    expect(parseMcpServerConfig({ url: 'https://example.com/mcp?author=me&tools=a,b' })).toMatchObject({
      url: 'https://example.com/mcp?author=me&tools=a,b',
    });
  });

  it('rejects a raw credential in the path or a query value, not just in a key', () => {
    // The URL is persisted verbatim to container.json and to the approval row,
    // so a Zapier-style token in the path is an on-disk secret.
    expect(() =>
      parseMcpServerConfig({ url: 'https://hooks.example.com/s/sk-ant-api03-J8sK2mN9pQ4rT6vX1zA3/mcp' }),
    ).toThrow(/url path carries a raw credential/);
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp?tools=ghp_deadbeef1234' })).toThrow(
      /carries a raw credential/,
    );
    // Percent-encoding must not smuggle one past the check.
    expect(() => parseMcpServerConfig({ url: 'https://example.com/s/ghp_deadbeef1234/mcp' })).toThrow(/raw credential/);
    // A JWT in a neutral-named query param (no credential-shaped KEY, so the
    // key check misses it) or the path — same shape src/secret-scrubber.ts
    // already redacts. Dotted values are excluded from `looksOpaque`, so this
    // regex is the only net that catches it.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(() => parseMcpServerConfig({ url: `https://example.com/mcp?code=${jwt}` })).toThrow(/raw credential/);
    expect(() => parseMcpServerConfig({ url: `https://example.com/callback/${jwt}` })).toThrow(/raw credential/);
    // An opaque path segment that matches no known credential shape is fine.
    expect(parseMcpServerConfig({ url: 'https://hooks.example.com/s/abc123/mcp' })).toMatchObject({
      url: 'https://hooks.example.com/s/abc123/mcp',
    });
  });

  it('rejects every credential shape TOKEN_SHAPE_PATTERNS recognizes, as a header value', () => {
    // TOKEN_SHAPE_PATTERNS (src/secret-scrubber.ts) is imported rather than
    // hand-copied precisely so this file never falls a round behind it — this
    // pins that promise against a shared fixture instead of trusting it by
    // inspection. tests/fixtures/mcp-known-secret-shapes.json is read by the
    // container-side mirror's own test too, so the two suites fail together
    // if either side drifts from the same list.
    for (const { name, value } of knownSecretShapes as { name: string; value: string }[]) {
      // An allowlisted header, same as the existing `User-Agent` case below —
      // otherwise the "not a known configuration header" check fires first
      // and the raw-credential check under test is never reached.
      expect(
        () => parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'User-Agent': value } }),
        `${name} (${JSON.stringify(value)}) should be rejected as a raw credential`,
      ).toThrow(/raw credential/);
    }
  });

  it('forces credential headers through the OneCLI placeholder, in an exact form', () => {
    expect(() =>
      parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer real' } }),
    ).toThrow(/onecli-managed/);
    // A substring test accepted this: the real secret rides along and is
    // persisted, while the rule that exists to stop it passes.
    expect(() =>
      parseMcpServerConfig({
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer actual-secret onecli-managed' },
      }),
    ).toThrow(/must be exactly/);
    expect(() =>
      parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { Authorization: 'onecli-managed extra' } }),
    ).toThrow(/must be exactly/);
    // The two legal shapes.
    for (const value of ['onecli-managed', 'Bearer onecli-managed', 'Key onecli-managed']) {
      expect(parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { Authorization: value } })).toMatchObject(
        { headers: { Authorization: value } },
      );
    }
    // On an allowlisted configuration header, a literal is legal in general —
    // but a recognizable credential in it is still refused.
    expect(() =>
      parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'User-Agent': 'ghp_deadbeef1234' } }),
    ).toThrow(/raw credential/);
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'bad header': 'v' } })).toThrow(
      /valid HTTP header field name/,
    );
  });

  it('rejects control characters in a header value, allowlisted or not', () => {
    // CRLF injection: a standard HTTP client rejects this at connect time, so
    // the server would be approved and restarted, then unusable.
    expect(() =>
      parseMcpServerConfig({
        url: 'https://example.com/mcp',
        headers: { 'Content-Type': 'application/json\r\nX-Injected: yes' },
      }),
    ).toThrow(/control character/);
    expect(() =>
      parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { Authorization: 'onecli-managed ' } }),
    ).toThrow(/control character/);
    // A plain tab is not rejected — only CR/LF/NUL and other C0 controls are.
    expect(parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'User-Agent': 'a\tb' } })).toMatchObject({
      headers: { 'User-Agent': 'a\tb' },
    });
  });

  it('rejects a header value above U+00FF — Bun/Node Headers is Latin-1, not arbitrary Unicode', () => {
    // Passed a control-character-only check before; the actual MCP transport
    // rejects it at connect time, so the server was approved and restarted,
    // then unusable.
    expect(() => parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'User-Agent': '测试' } })).toThrow(
      /above U\+00FF/,
    );
    // Latin-1 (up to U+00FF) is fine, even outside plain ASCII.
    expect(parseMcpServerConfig({ url: 'https://example.com/mcp', headers: { 'User-Agent': 'café' } })).toMatchObject({
      headers: { 'User-Agent': 'café' },
    });
  });

  it('rejects a case-variant duplicate header name', () => {
    // HTTP header names are case-insensitive; Headers combines "Authorization"
    // and "authorization" into one comma-joined value on the wire, which no
    // longer matches the placeholder form already validated and can leave
    // the server unauthenticated.
    expect(() =>
      parseMcpServerConfig({
        url: 'https://example.com/mcp',
        headers: { Authorization: 'onecli-managed', authorization: 'Bearer onecli-managed' },
      }),
    ).toThrow(/case-insensitive/);
  });

  it('rejects an env key that is not a valid environment variable name', () => {
    expect(() => parseMcpServerConfig({ command: 'node', env: { 'not-an-env-key': 'v' } })).toThrow(
      /environment variable name/,
    );
  });

  it('validateMcpServerName allows the [A-Za-z0-9_-] charset only', () => {
    expect(() => validateMcpServerName('ok_name-1')).not.toThrow();
    for (const bad of ['', 'has space', 'dot.name', 'a'.repeat(65)]) {
      expect(() => validateMcpServerName(bad)).toThrow(/1-64 characters/);
    }
  });

  it('validateMcpServerName rejects names that hit Object.prototype on plain assignment', () => {
    // Every write site does `mcpServers[name] = config` on a plain object.
    // These three names all pass the charset check but resolve to an
    // inherited prototype setter/property instead of an own enumerable key,
    // so the server silently vanishes from JSON.stringify while the caller
    // reports success.
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      expect(() => validateMcpServerName(reserved)).toThrow(/reserved/);
    }
  });

  it('validateMcpServerName rejects "nanoclaw" — the built-in server the runner seeds', () => {
    // container/agent-runner/src/index.ts seeds mcpServers.nanoclaw, then
    // layers every container.json entry on top with the same plain
    // assignment. A static entry named "nanoclaw" would silently replace
    // the built-in.
    expect(() => validateMcpServerName('nanoclaw')).toThrow(/reserved/);
  });
});

describe('mcpServerPluginOwner', () => {
  it('returns undefined for a non-object, a missing plugin, and an empty-string plugin', () => {
    expect(mcpServerPluginOwner(null)).toBeUndefined();
    expect(mcpServerPluginOwner('not-an-object')).toBeUndefined();
    expect(mcpServerPluginOwner({ command: 'npx' })).toBeUndefined();
    expect(mcpServerPluginOwner({ command: 'npx', plugin: '' })).toBeUndefined();
  });

  it('returns the plugin name when present and non-empty', () => {
    expect(mcpServerPluginOwner({ command: 'npx', plugin: 'sales-sdr' })).toBe('sales-sdr');
  });
});

describe('opaqueUrlParts', () => {
  it('names path segments and query values a human should eyeball', () => {
    // These are token-shaped, but equally tenant-id-shaped — nothing in the
    // string separates the two, which is why they warn rather than reject.
    expect(opaqueUrlParts('https://hooks.example.com/s/aB3xY9kLmN2pQ7rS/mcp')).toEqual(['aB3xY9kLmN2pQ7rS']);
    expect(opaqueUrlParts('https://example.com/mcp?workspace=aB3xY9kLmN2pQ7rS')).toEqual(['aB3xY9kLmN2pQ7rS']);
  });

  it('stays quiet on ordinary endpoints, including the ones this install already wires', () => {
    for (const url of [
      'https://mcp.deepwiki.com/mcp',
      'https://app.datafold.com/mcp/',
      'https://mcp.linear.app/mcp',
      'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa',
      'https://example.com/v1/acme-engineering/mcp',
    ]) {
      expect(opaqueUrlParts(url)).toEqual([]);
    }
  });
});
