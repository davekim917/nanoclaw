/**
 * Detail-on-demand contract for `get_capabilities`.
 *
 * The pre-turn block carries a ROSTER — one line per wired service, so no
 * service is ever evicted for budget and the agent always knows what it has.
 * The mini-manual for a service (`useFor` / `activation`) is served from here
 * instead. Two things must hold or that split is a regression rather than a
 * fix: the roster's handle must be enough to look the service up, and what
 * comes back must be byte-identical to the host-written text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findCapabilityService, readCapabilities } from './capabilities.js';

const ROOT = path.join(os.tmpdir(), 'nanoclaw-get-capabilities-test');
const SNAPSHOT = path.join(ROOT, 'capabilities.json');

/**
 * Host-shaped entries. The `useFor` / `activation` strings are trimmed
 * stand-ins for the real ones — this test is about the transport (does the
 * exact stored text come back, keyed off a roster handle), not about the
 * prose, which `src/capabilities.test.ts` owns.
 */
const SERVICES = [
  {
    name: 'Google Workspace',
    cli: 'gws',
    summary: 'Gmail, Calendar, Drive, Docs, Sheets, Slides as ops@example.com',
    activation:
      'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/<name>.json (valid names: ops). Verify with `gws auth status` — WITHOUT this env var gws reports auth_method: none even though creds are mounted.',
  },
  {
    name: 'GitHub',
    cli: 'gh',
    summary: 'repos, PRs, pushes, and CI/Actions status',
    activation: '`gh` pre-authenticated. CI/Actions is included, not a separate integration.',
  },
  {
    name: 'Hex',
    cli: 'hex',
    summary: 'Hex CLI: list/read/run projects and cells',
    activation: '`hex` CLI ready. Skill at `/app/skills/hex/SKILL.md` documents the full command surface.',
  },
  {
    name: 'Looker',
    mcpNamespace: 'mcp__looker__*',
    summary: 'Query explores, run raw SQL, inspect LookML',
    useFor: "Looker via Google's MCP Toolbox (--prebuilt looker), instance `https://example.cloud.looker.com`.",
  },
  {
    name: 'Pocket',
    mcpNamespace: 'mcp__pocket__*',
    summary: 'Personal knowledge / memory via https://public.heypocketai.com/mcp.',
    useFor:
      'Personal knowledge / memory via https://public.heypocketai.com/mcp. Auth pre-injected (Authorization: Bearer). Use Pocket tools to save references, recall prior context, search personal knowledge.',
    retainUnderBudget: true,
  },
  {
    name: 'Dropbox',
    mcpNamespace: 'mcp__dropbox__*',
    summary: 'https://mcp.dropbox.com/mcp',
    useFor: 'MCP server `dropbox` (https://mcp.dropbox.com/mcp); tools self-describe under `mcp__dropbox__*`.',
  },
  {
    name: 'Slack',
    cli: 'curl',
    summary: 'LIVE here: slack.com/api by curl with NO auth header',
    useFor: 'LIVE in THIS session: `curl https://slack.com/api/<method>` with NO auth header.',
    retainUnderBudget: true,
  },
  {
    name: 'SELECT',
    cli: 'curl',
    summary: 'api.select.dev — Snowflake cost & usage analytics',
    useFor: 'Snowflake cost & usage analytics REST API at https://api.select.dev.',
  },
];

function writeSnapshot(services: unknown[] = SERVICES): void {
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({
      version: '2.0.0',
      channels: { registered: ['slack'], active: ['slack'] },
      session: { agentGroupId: 'ag-a', howToUse: 'EVERY service listed here is wired in.', services },
    }),
  );
}

function text(result: { content: Array<{ text: string }>; isError?: boolean }): string {
  return result.content.map((part) => part.text).join('');
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  writeSnapshot();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('get_capabilities detail on demand', () => {
  it.each([
    ['Slack', 'Slack'],
    ['GitHub', 'GitHub'],
    ['Hex', 'Hex'],
    ['Looker', 'Looker'],
    ['Pocket', 'Pocket'],
    ['Dropbox', 'Dropbox'],
  ])('returns %s byte-identical to the host-written entry', (query, name) => {
    const entry = SERVICES.find((service) => service.name === name)!;
    const result = readCapabilities({ service: query }, SNAPSHOT);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result));
    expect(parsed).toEqual(entry);
    // The point of the whole split: the prose the roster no longer carries is
    // here, unchanged, not paraphrased or re-clipped.
    const prose = (entry as { useFor?: string; activation?: string }).useFor ?? entry.activation;
    expect(text(result)).toContain(JSON.stringify(prose).slice(1, -1));
  });

  it('matches case-insensitively, by CLI, and by MCP namespace or bare server name', () => {
    for (const query of ['looker', 'LOOKER', 'mcp__looker__*', 'Mcp__Looker__*']) {
      expect(JSON.parse(text(readCapabilities({ service: query }, SNAPSHOT))).name, query).toBe('Looker');
    }
    expect(JSON.parse(text(readCapabilities({ service: 'gh' }, SNAPSHOT))).name).toBe('GitHub');
    expect(JSON.parse(text(readCapabilities({ service: 'dropbox' }, SNAPSHOT))).name).toBe('Dropbox');
  });

  it('resolves a prefix of a long roster name', () => {
    // "Google Workspace" is what the roster line shows and what an agent will
    // type; a partial is the realistic second attempt.
    expect(JSON.parse(text(readCapabilities({ service: 'google' }, SNAPSHOT))).name).toBe('Google Workspace');
  });

  it('refuses an ambiguous handle instead of guessing', () => {
    // Slack, SELECT and every other REST-only service share `cli: 'curl'`.
    // Returning the first would hand the agent the wrong manual and look like
    // a correct answer.
    const result = readCapabilities({ service: 'curl' }, SNAPSHOT);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('matches more than one service');
    expect(text(result)).toContain('Slack');
    expect(text(result)).toContain('SELECT');
  });

  it('names every wired service when nothing matches', () => {
    const result = readCapabilities({ service: 'quickbooks' }, SNAPSHOT);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No wired service matches "quickbooks"');
    expect(text(result)).toContain('Looker');
  });

  it('still returns the whole session section, and the whole snapshot', () => {
    const session = JSON.parse(text(readCapabilities({ section: 'session' }, SNAPSHOT)));
    expect(session.services).toEqual(SERVICES);

    const all = JSON.parse(text(readCapabilities({}, SNAPSHOT)));
    expect(all.version).toBe('2.0.0');
    expect(all.session.services).toEqual(SERVICES);
  });

  it('reports an unknown section rather than returning nothing', () => {
    const result = readCapabilities({ section: 'nope' }, SNAPSHOT);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Unknown section: nope');
  });

  it('says so when the snapshot carries no session service list', () => {
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ version: '2.0.0' }));
    const result = readCapabilities({ service: 'Slack' }, SNAPSHOT);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no per-session service list');
  });

  it('tolerates a malformed entry rather than failing the lookup', () => {
    // One bad entry must not cost the whole call — the host snapshot builder
    // takes the same position for a malformed container.json MCP entry
    // (src/capabilities.ts, the `server === null` skip).
    writeSnapshot([null, 'not-an-object', ...SERVICES]);
    expect(JSON.parse(text(readCapabilities({ service: 'Hex' }, SNAPSHOT))).name).toBe('Hex');
  });
});

describe('findCapabilityService', () => {
  it('treats an empty query as no match', () => {
    expect(findCapabilityService(SERVICES, '   ')).toEqual({ missing: true });
  });

  it('prefers an exact handle over a longer name that merely starts with it', () => {
    const services = [{ name: 'Hexagon Analytics' }, { name: 'Hex', cli: 'hex' }];
    expect(findCapabilityService(services, 'Hex')).toEqual({ match: services[1]! });
  });
});
