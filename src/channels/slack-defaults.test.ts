/**
 * Slack's channel-defaults declaration.
 *
 * The integration point is the REGISTRATION, not the constant: importing
 * slack.ts must put SLACK_DEFAULTS on the registry entry for every workspace
 * suffix, so `hasDeclaredChannelDefaults` flips to true and the `ncl`/wizard
 * creation surfaces stop falling into the lenient undeclared-adapter path.
 * These tests drive the real `readEnvFileMatching` seam with a fake env and
 * then ask the real resolvers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  values: {} as Record<string, string>,
}));

vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFileMatching: () => env.values,
  readEnvFile: () => env.values,
}));

type Registry = typeof import('./channel-registry.js');
type Defaults = typeof import('./channel-defaults.js');

/**
 * Fresh module graph per arm — the registry map is module-level, so a
 * registration from one test would otherwise leak into the next.
 */
async function loadWithWorkspaces(values: Record<string, string>): Promise<{
  registry: Registry;
  defaults: Defaults;
  slack: typeof import('./slack.js');
}> {
  vi.resetModules();
  env.values = values;
  const slack = await import('./slack.js');
  const registry = await import('./channel-registry.js');
  const defaults = await import('./channel-defaults.js');
  return { registry, defaults, slack };
}

const PRIMARY = { SLACK_BOT_TOKEN: 'xoxb-primary', SLACK_SIGNING_SECRET: 'sec-primary' };
const SUFFIXED = {
  SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs',
  SLACK_SIGNING_SECRET_EXAMPLE_LABS: 'sec-labs',
};

afterEach(() => {
  vi.resetModules();
});

describe('Slack adapter registration declares channel defaults', () => {
  it('stops every Slack wiring from resolving through the undeclared-adapter fallback', async () => {
    const { registry } = await loadWithWorkspaces(PRIMARY);
    expect(registry.getRegisteredChannelNames()).toContain('slack');
    expect(registry.hasDeclaredChannelDefaults('slack')).toBe(true);
  });

  it('declares on every suffixed workspace instance, not just the primary app', async () => {
    const { registry, slack } = await loadWithWorkspaces({ ...PRIMARY, ...SUFFIXED });
    expect(registry.getRegisteredChannelNames()).toEqual(expect.arrayContaining(['slack', 'slack-example-labs']));
    for (const key of ['slack', 'slack-example-labs']) {
      expect(registry.hasDeclaredChannelDefaults(key)).toBe(true);
      expect(registry.getChannelDefaults(key)).toEqual(slack.SLACK_DEFAULTS);
    }
  });

  it('resolves the fork policies at wiring/messaging-group creation', async () => {
    const { registry, defaults } = await loadWithWorkspaces(PRIMARY);
    expect(registry.hasDeclaredChannelDefaults('slack')).toBe(true);

    // Group: plain mention (NOT upstream's mention-sticky), public policy.
    expect(defaults.resolveWiringDefaults('slack', true, 'Nano')).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
    });
    expect(defaults.resolveUnknownSenderPolicy('slack', true)).toBe('public');

    // DM: every message engages; unknown DM senders still need approval.
    expect(defaults.resolveWiringDefaults('slack', false, 'Nano')).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
    expect(defaults.resolveUnknownSenderPolicy('slack', false)).toBe('request_approval');
  });
});

describe('Declaration is resolvable without usable credentials', () => {
  it('registers the declaration when the signing secret has not been pasted yet', async () => {
    const { registry, defaults } = await loadWithWorkspaces({ SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs' });

    // No live adapter can exist, but the creation-time value must not be the
    // legacy `strict` schema default — that would survive the credentials
    // being completed.
    expect(registry.hasDeclaredChannelDefaults('slack-example-labs')).toBe(true);
    expect(defaults.resolveUnknownSenderPolicy('slack-example-labs', true)).toBe('public');
    expect(defaults.resolveUnknownSenderPolicy('slack-example-labs', false)).toBe('request_approval');
  });

  it('covers the reverse order too — a signing secret pasted before the token', async () => {
    const { registry } = await loadWithWorkspaces({ SLACK_SIGNING_SECRET_EXAMPLE_LABS: 'sec-labs' });
    expect(registry.hasDeclaredChannelDefaults('slack-example-labs')).toBe(true);
  });

  it('declares the default instance when nothing is configured at all', async () => {
    // setup/register.ts and an offline `ncl` run in exactly this state.
    const { registry, defaults } = await loadWithWorkspaces({});
    expect(registry.hasDeclaredChannelDefaults('slack')).toBe(true);
    expect(defaults.resolveUnknownSenderPolicy('slack', true)).toBe('public');
  });

  it('does not advertise a phantom `slack` on a host whose workspaces are all suffixed', async () => {
    const { registry } = await loadWithWorkspaces(SUFFIXED);
    expect(registry.hasDeclaredChannelDefaults('slack-example-labs')).toBe(true);
    expect(registry.getRegisteredChannelNames()).not.toContain('slack');
  });

  it('yields no adapter for a declaration-only instance', async () => {
    const { registry } = await loadWithWorkspaces({ SLACK_BOT_TOKEN: 'xoxb-primary' });
    await registry.initChannelAdapters(
      () =>
        ({
          onInbound: async () => {},
          onInboundEvent: async () => {},
          onMetadata: () => {},
          onAction: () => {},
        }) as never,
    );
    expect(registry.getChannelAdapterExact('slack')).toBeUndefined();
    // The declaration is still resolvable through the registration.
    expect(registry.hasDeclaredChannelDefaults('slack')).toBe(true);
  });

  it('classifies complete, half-configured and unconfigured env correctly', async () => {
    const { slack } = await loadWithWorkspaces(PRIMARY);
    expect(
      slack.declarationOnlySlackTypes({
        ...PRIMARY,
        SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-labs',
        SLACK_SIGNING_SECRET_ORPHAN: 'sec-only',
      }),
    ).toEqual(['slack-example-labs', 'slack-orphan']);
    // A complete workspace is left to the live factory loop.
    expect(slack.declarationOnlySlackTypes(PRIMARY)).toEqual([]);
    expect(slack.declarationOnlySlackTypes({})).toEqual(['slack']);
  });

  it('never shadows a complete workspace with the null factory', async () => {
    const { registry } = await loadWithWorkspaces({ ...PRIMARY, ...SUFFIXED });
    // Both are complete, so neither is declaration-only; the live factories own
    // the keys and the declaration still resolves.
    expect(registry.hasDeclaredChannelDefaults('slack')).toBe(true);
    expect(registry.hasDeclaredChannelDefaults('slack-example-labs')).toBe(true);
  });
});

describe('Slack defaults do not flip existing live wirings', () => {
  /**
   * `threads` is the only declared value re-read on every routed message
   * (resolveThreadPolicy, wiring.threads NULL = inherit). Nearly every live
   * Slack wiring stores NULL, so the declared value has to resolve to exactly
   * what the undeclared fallback resolved to, in both contexts. Goes red if
   * upstream's dm.threads:false is adopted verbatim.
   */
  it('resolves an inherit (NULL threads) wiring identically to the old fallback', async () => {
    const { registry, defaults, slack } = await loadWithWorkspaces(PRIMARY);
    const fallback = registry.fallbackChannelDefaults(true);

    for (const isGroup of [true, false]) {
      expect(defaults.resolveThreadPolicy(null, slack.SLACK_DEFAULTS, isGroup, true)).toBe(
        defaults.resolveThreadPolicy(null, fallback, isGroup, true),
      );
    }
    expect(defaults.resolveThreadPolicy(null, slack.SLACK_DEFAULTS, false, true)).toBe(true);
  });

  it('keeps the router auto-create policy byte-identical in both contexts', async () => {
    const { registry, slack } = await loadWithWorkspaces(PRIMARY);
    const fallback = registry.fallbackChannelDefaults(true);
    expect(slack.SLACK_DEFAULTS.group.unknownSenderPolicy).toBe(fallback.group.unknownSenderPolicy);
    expect(slack.SLACK_DEFAULTS.dm.unknownSenderPolicy).toBe(fallback.dm.unknownSenderPolicy);
  });

  it('leaves an explicit per-wiring threads override in charge', async () => {
    const { defaults, slack } = await loadWithWorkspaces(PRIMARY);
    expect(defaults.resolveThreadPolicy(0, slack.SLACK_DEFAULTS, false, true)).toBe(false);
    expect(defaults.resolveThreadPolicy(1, slack.SLACK_DEFAULTS, true, true)).toBe(true);
  });

  it('never coerces a mention-sticky wiring, since both contexts keep thread ids', async () => {
    const { defaults } = await loadWithWorkspaces(PRIMARY);
    for (const is_group of [1, 0]) {
      const wiring = { engage_mode: 'mention-sticky' as string | undefined, threads: null };
      defaults.validateEngageAgainstChannel(wiring, {
        id: 'mg-1',
        channel_type: 'slack',
        instance: 'slack',
        is_group,
      } as never);
      expect(wiring.engage_mode).toBe('mention-sticky');
    }
  });
});
