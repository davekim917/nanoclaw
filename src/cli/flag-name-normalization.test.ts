/**
 * Flag names must survive the dispatcher's `-` → `_` key normalization.
 *
 * Every command parser built by `registerResource` runs `normalizeArgs` before
 * `validateArgs` (`src/cli/crud.ts:474` and `:646`), and the socket server's
 * dispatcher calls exactly that parser — `cmd.parseArgs(req.args)`,
 * `src/cli/dispatch.ts:167`. So `--authorize-param` arrives at validation as
 * the key `authorize_param`, while `validateArgs` compares those keys against
 * `ColumnDef.name` verbatim (`src/cli/crud.ts:505-511`). A ColumnDef declared
 * with a hyphen therefore matches nothing and its own flag is rejected as
 * `unknown flag --authorize-param`; the display side is unaffected because
 * help and error text hyphenate on the way out (`flagName`,
 * `src/cli/help-render.ts:16-18`).
 *
 * `ncl integrations` shipped with hyphenated ColumnDef names, which made every
 * hyphenated flag on it unusable — including `complete --redirect-url`, the
 * required flag with no alternative, so no OAuth login could be finished.
 * These cases pin the fix, and the sweep below stops the class recurring on any
 * resource.
 */
import { describe, expect, it } from 'vitest';

// Production barrel — side-effect imports register every real resource and its
// per-resource help command (`src/cli/commands/index.ts` → `resources/index.ts`),
// which is the same population step the host performs before the CLI socket
// server accepts connections (`src/cli/registry.ts:1-10`).
import './commands/index.js';

import { getResources, type ColumnDef, type ResourceDef } from './crud.js';
import { lookup } from './registry.js';

/** The parser the dispatcher would call for `ncl <command>` (dispatch.ts:167). */
function parseAs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  const cmd = lookup(command);
  if (!cmd) throw new Error(`command not registered: ${command}`);
  return cmd.parseArgs(args) as Record<string, unknown>;
}

describe('ncl integrations accepts its hyphenated flags through the real parser', () => {
  it('login takes --authorize-param, --redirect-uri and --client-name', () => {
    const parsed = parseAs('integrations-login', {
      name: 'dropbox-files',
      url: 'https://mcp.dropbox.com/mcp',
      group: 'ag-123',
      'authorize-param': 'token_access_type=offline',
      'redirect-uri': 'http://127.0.0.1:9000/callback',
      'client-name': 'NanoClaw',
    });

    // Normalized to the keys the handler reads
    // (`src/cli/resources/integrations.ts` login handler).
    expect(parsed).toMatchObject({
      authorize_param: 'token_access_type=offline',
      redirect_uri: 'http://127.0.0.1:9000/callback',
      client_name: 'NanoClaw',
    });
  });

  it('login takes the remaining hyphenated flags (--no-resource, --listen-timeout, --device-endpoint)', () => {
    const parsed = parseAs('integrations-login', {
      name: 'acme',
      url: 'https://mcp.example.com/mcp',
      group: 'ag-123',
      'no-resource': true,
      'listen-timeout': '900',
      'device-endpoint': 'https://auth.example.com/device',
    });

    expect(parsed).toMatchObject({
      no_resource: true,
      listen_timeout: 900, // coerced by the declared `number` type
      device_endpoint: 'https://auth.example.com/device',
    });
  });

  it('complete takes --redirect-url, the flag no login can finish without', () => {
    const parsed = parseAs('integrations-complete', {
      name: 'dropbox-files',
      'redirect-url': 'http://127.0.0.1:8765/callback?code=abc&state=xyz',
    });

    expect(parsed.redirect_url).toBe('http://127.0.0.1:8765/callback?code=abc&state=xyz');
  });

  it('remove takes --delete-secret', () => {
    expect(parseAs('integrations-remove', { name: 'dropbox-files', 'delete-secret': true })).toMatchObject({
      delete_secret: true,
    });
  });

  it('still rejects a genuinely unknown flag', () => {
    expect(() =>
      parseAs('integrations-complete', { name: 'dropbox-files', 'redirect-url': 'x', 'not-a-flag': '1' }),
    ).toThrow('unknown flag --not-a-flag');
  });
});

describe('every declared ColumnDef name is normalization-safe', () => {
  // `getResources()` (`src/cli/crud.ts:164`) returns every ResourceDef that
  // `registerResource` recorded — i.e. every module the resource barrel
  // imported (`src/cli/resources/index.ts`).
  const resources: ResourceDef[] = getResources();

  it('the real registry is populated (guards against an empty sweep)', () => {
    expect(resources.length).toBeGreaterThan(10);
    expect(resources.map((r) => r.plural)).toContain('integrations');
  });

  it('no column or custom-operation arg declares a name outside /^[a-z0-9_]+$/', () => {
    const offenders: string[] = [];
    const check = (where: string, defs: ColumnDef[] | undefined) => {
      for (const def of defs ?? []) {
        if (!/^[a-z0-9_]+$/.test(def.name)) offenders.push(`${where}.${def.name}`);
      }
    };

    for (const resource of resources) {
      check(`${resource.plural}.columns`, resource.columns);
      for (const [verb, op] of Object.entries(resource.customOperations ?? {})) {
        check(`${resource.plural} ${verb}`, op.args);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every declared arg round-trips: display name → normalized key → itself', () => {
    // `flagName` hyphenates for display; the dispatcher un-hyphenates on the
    // way in. A name that does not survive that round trip is unreachable.
    const broken: string[] = [];
    const roundTrip = (name: string) => name.replace(/_/g, '-').replace(/-/g, '_');

    for (const resource of resources) {
      const all = [
        ...resource.columns,
        ...Object.values(resource.customOperations ?? {}).flatMap((op) => op.args ?? []),
      ];
      for (const def of all) {
        if (roundTrip(def.name) !== def.name) broken.push(`${resource.plural}.${def.name}`);
      }
    }

    expect(broken).toEqual([]);
  });
});
