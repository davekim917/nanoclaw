/**
 * Wiring creation/update against channel declarations: the resolveDefaults
 * hook fills omitted engage defaults from the adapter declaration ({name}
 * substituted), explicit flags always win, undeclared channels keep the
 * legacy static defaults (back-compat contract), and the create/update
 * validation rejects combinations that could never engage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

// wirings' postCommit projects destinations into live session DBs — no
// sessions run in this test, but the module must not open on-disk DB files.
vi.mock('../../modules/agent-to-agent/write-destinations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/agent-to-agent/write-destinations.js')>()),
  writeDestinations: vi.fn(),
}));

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { getRawDb } from '../../db/connection.js';
import { createMessagingGroupAgent, getMessagingGroupAgent } from '../../db/messaging-groups.js';
import { lookup } from '../registry.js';
// Side-effect import: registers wirings-create / wirings-update.
import './wirings.js';

const hostCtx = { caller: 'host' as const };
const now = () => new Date().toISOString();

// Registration-tier declarations only — no adapter is live, which is exactly
// the environment `ncl` sees for offline instances and setup scripts.
const declared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: 'hey {name}!', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('declchan', { factory: () => null, defaults: declared });

const neverDeclared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '{name}', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};
registerChannelAdapter('neverchan', { factory: () => null, defaults: neverDeclared });

function mg(id: string, channelType: string, isGroup: number) {
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: `pid-${id}`,
    name: null,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

async function create(args: Record<string, unknown>) {
  return (await lookup('wirings-create')!.handler(args, hostCtx)) as Record<string, unknown>;
}

async function update(args: Record<string, unknown>) {
  return (await lookup('wirings-update')!.handler(args, hostCtx)) as Record<string, unknown>;
}

beforeEach(async () => {
  await initTestDb();
  runMigrations(getRawDb());
  createAgentGroup({
    id: 'ag-1',
    name: 'Helper Bot',
    folder: 'helper-bot',
    agent_provider: null,
    created_at: now(),
  });
  mg('mg-dm', 'declchan', 0);
  mg('mg-group', 'declchan', 1);
  mg('mg-never', 'neverchan', 1);
  mg('mg-stale', 'stalechan', 1); // no declaration anywhere
});

afterEach(async () => {
  await closeDb();
});

describe('wirings-create — declaration-derived defaults', () => {
  it('fills DM defaults from the declaration with {name} substituted', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('hey Helper Bot!');
  });

  it('fills group defaults from the declaration', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('mention-sticky');
    const persisted = getMessagingGroupAgent(row.id as string);
    expect(persisted!.engage_pattern).toBeNull();
  });

  it('explicit --engage-mode wins over the declaration', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', engage_mode: 'mention' });
    expect(row.engage_mode).toBe('mention');
  });

  it('undeclared channels keep the legacy static default (back-compat)', async () => {
    const row = await create({ messaging_group_id: 'mg-stale', agent_group_id: 'ag-1' });
    expect(row.engage_mode).toBe('mention');
    expect(row.engage_pattern).toBeUndefined();
  });
});

describe('wirings-create — validation', () => {
  it('rejects pattern mode without --engage-pattern', async () => {
    await expect(
      create({ messaging_group_id: 'mg-stale', agent_group_id: 'ag-1', engage_mode: 'pattern' }),
    ).rejects.toThrow(/--engage-pattern/);
  });

  it("rejects mention modes on a channel declaring mentions: 'never'", async () => {
    await expect(
      create({ messaging_group_id: 'mg-never', agent_group_id: 'ag-1', engage_mode: 'mention' }),
    ).rejects.toThrow(/mentions: 'never'/);
  });

  it('coerces explicit mention-sticky to mention when the declared context has threads=false', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', engage_mode: 'mention-sticky' });
    expect(row.engage_mode).toBe('mention');
  });

  it('coerces mention-sticky when --threads false overrides a threaded declaration', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      engage_mode: 'mention-sticky',
      threads: 'false',
    });
    expect(row.engage_mode).toBe('mention');
    expect(row.threads).toBe(0);
  });

  it('keeps mention-sticky when the declared group context has threads=true', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', engage_mode: 'mention-sticky' });
    expect(row.engage_mode).toBe('mention-sticky');
  });
});

describe('wirings — threads and priority columns', () => {
  it('omitted --threads stores NULL (inherit declaration)', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(getMessagingGroupAgent(row.id as string)!.threads).toBeNull();
  });

  it('--threads true/false stores 1/0', async () => {
    const on = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', threads: 'true' });
    expect(getMessagingGroupAgent(on.id as string)!.threads).toBe(1);
    const off = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', threads: 'false' });
    expect(getMessagingGroupAgent(off.id as string)!.threads).toBe(0);
  });

  it('rejects a non-boolean --threads value', async () => {
    await expect(create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', threads: 'bogus' })).rejects.toThrow(
      /--threads must be true or false/,
    );
  });

  it('--priority is settable on create and defaults to 0', async () => {
    const dflt = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    expect(dflt.priority).toBe(0);
    const high = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', priority: '5' });
    expect(high.priority).toBe(5);
  });
});

describe('wirings-update — same validation as create', () => {
  it('rejects switching to pattern mode when no engage_pattern exists', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' }); // sticky, no pattern
    await expect(update({ id: row.id, engage_mode: 'pattern' })).rejects.toThrow(/--engage-pattern/);
  });

  it("rejects switching to a mention mode on a mentions:'never' channel", async () => {
    const row = await create({
      messaging_group_id: 'mg-never',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
    await expect(update({ id: row.id, engage_mode: 'mention' })).rejects.toThrow(/mentions: 'never'/);
  });

  it('coerces an existing sticky wiring to mention when --threads is turned off', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' }); // mention-sticky
    const updated = (await update({ id: row.id, threads: 'false' })) as { engage_mode: string; threads: number };
    expect(updated.threads).toBe(0);
    expect(updated.engage_mode).toBe('mention');
  });

  it('updates threads and priority', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    const updated = (await update({ id: row.id, threads: 'true', priority: '3' })) as {
      threads: number;
      priority: number;
    };
    expect(updated.threads).toBe(1);
    expect(updated.priority).toBe(3);
  });

  it('allows unrelated updates to a legacy pattern row with NULL engage_pattern', async () => {
    // Rows created on main before engage_pattern defaults existed: pattern
    // mode + NULL pattern, which the router evaluates as match-all.
    createMessagingGroupAgent({
      id: 'mga-legacy',
      messaging_group_id: 'mg-stale',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    });

    const updated = (await update({ id: 'mga-legacy', priority: '5' })) as { priority: number };
    expect(updated.priority).toBe(5);
    // The pattern fields stay untouched — no silent backfill.
    expect(getMessagingGroupAgent('mga-legacy')!.engage_pattern).toBeNull();

    // But actually changing the pattern fields to an invalid combination
    // still rejects.
    await expect(update({ id: 'mga-legacy', engage_pattern: '' })).rejects.toThrow(/--engage-pattern/);
  });
});

describe('wirings — per-channel tone/model/effort overrides', () => {
  // These three columns existed and drove behavior for months while being
  // neither readable nor writable through ncl. A sticky `-m` on one channel
  // was invisible here, and a channel silently missing its tone looked
  // identical to one that never had it. Assertions read the persisted row,
  // since create() returns the assembled values, not a DB read.
  const stored = (id: unknown) => getMessagingGroupAgent(id as string)!;

  it('omitted overrides stay NULL so the group default is inherited', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(stored(row.id).default_tone).toBeNull();
    expect(stored(row.id).default_model).toBeNull();
    expect(stored(row.id).default_effort).toBeNull();
  });

  it('create accepts all three', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      default_tone: 'gilfoyle',
      instructions_profile: null,
      default_model: 'sonnet',
      default_effort: 'xhigh',
    });
    expect(stored(row.id).default_tone).toBe('gilfoyle');
    expect(stored(row.id).default_model).toBe('sonnet');
    expect(stored(row.id).default_effort).toBe('xhigh');
  });

  it('update sets an override on an existing wiring', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    await update({ id: row.id, default_tone: 'engineering' });
    expect(stored(row.id).default_tone).toBe('engineering');
  });

  it('--default-tone "" clears back to NULL, not to empty string', async () => {
    // NULL and '' are NOT equivalent downstream: NULL falls through to
    // container.json `tone`, '' resolves to no tone at all AND suppresses the
    // group default. A column that can be set but never unset is the trap.
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      default_tone: 'jian-yang',
      instructions_profile: null,
    });
    await update({ id: row.id, default_tone: '' });
    expect(stored(row.id).default_tone).toBeNull();
  });

  it('clears model and effort the same way', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      default_model: 'sonnet',
      default_effort: 'xhigh',
    });
    await update({ id: row.id, default_model: '', default_effort: '' });
    expect(stored(row.id).default_model).toBeNull();
    expect(stored(row.id).default_effort).toBeNull();
  });
});

describe('wirings — per-channel instructions profile', () => {
  // The second per-channel always-on layer. It is NOT the tone slot: tone
  // carries voice and only voice, and the two must stay independently
  // settable, so every assertion here also pins that they don't clobber each
  // other. Assertions read the persisted row, since create() returns the
  // assembled values rather than a DB read.
  const stored = (id: unknown) => getMessagingGroupAgent(id as string)!;

  it('omitted stays NULL — no channel gains instructions by default', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(stored(row.id).instructions_profile).toBeNull();
  });

  it('create accepts a profile name', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      instructions_profile: 'lab',
    });
    expect(stored(row.id).instructions_profile).toBe('lab');
  });

  it('create sets tone and instructions independently', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      default_tone: 'gilfoyle',
      instructions_profile: 'lab',
    });
    expect(stored(row.id).default_tone).toBe('gilfoyle');
    expect(stored(row.id).instructions_profile).toBe('lab');
  });

  it('update sets it on an existing wiring', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    await update({ id: row.id, instructions_profile: 'lab' });
    expect(stored(row.id).instructions_profile).toBe('lab');
  });

  it('--instructions-profile "" clears back to NULL, not to empty string', async () => {
    // '' would forward as an env value the runner then fails to resolve every
    // spawn, logging a warning forever. A column that can be set but never
    // unset is the trap this pins shut.
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      instructions_profile: 'lab',
    });
    await update({ id: row.id, instructions_profile: '' });
    expect(stored(row.id).instructions_profile).toBeNull();
  });

  it('clearing instructions leaves tone untouched', async () => {
    const row = await create({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-1',
      default_tone: 'gilfoyle',
      instructions_profile: 'lab',
    });
    await update({ id: row.id, instructions_profile: '' });
    expect(stored(row.id).instructions_profile).toBeNull();
    expect(stored(row.id).default_tone).toBe('gilfoyle');
  });

  it.each([
    ['Lab', 'uppercase'],
    ['../etc/passwd', 'path traversal'],
    ['lab profile', 'a space'],
    ['-lab', 'a leading dash'],
    ['lab.md', 'a dot'],
    ['lab_x', 'an underscore'],
  ])('create rejects %s (%s)', async (name) => {
    await expect(
      create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', instructions_profile: name }),
    ).rejects.toThrow(/--instructions-profile must match/);
  });

  it('update rejects an invalid name too', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    await expect(update({ id: row.id, instructions_profile: '../../etc/shadow' })).rejects.toThrow(
      /--instructions-profile must match/,
    );
    expect(stored(row.id).instructions_profile).toBeNull();
  });

  it('a rejected create writes no row at all', async () => {
    // Validation runs before the INSERT, so a bad name must not leave a
    // half-configured wiring behind that the operator then has to notice.
    await expect(
      create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', instructions_profile: 'BAD' }),
    ).rejects.toThrow();
    const rows = getRawDb()
      .prepare(`SELECT id FROM messaging_group_agents WHERE messaging_group_id = 'mg-dm'`)
      .all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });
});
