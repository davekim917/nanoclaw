import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (content: Record<string, unknown>, session: Session) => Promise<void>>(),
  provider: 'claude',
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  notices: [] as string[],
}));

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: (
    name: string,
    handler: (content: Record<string, unknown>, session: Session) => Promise<void>,
  ) => fixture.handlers.set(name, handler),
}));
vi.mock('../../db/central-lease.js', () => ({ withCentralSync: async (fn: () => unknown) => fn() }));
vi.mock('../../caller-identity.js', () => ({ deriveCallerId: async () => 'slack:U0OWNER' }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => ({ id, name: 'agent', agent_provider: fixture.provider }),
}));
vi.mock('../../db/container-configs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/container-configs.js')>()),
  getContainerConfig: async () => ({ provider: fixture.provider }),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupAgentByPair: async () => ({ id: 'wiring-1' }),
  getMessagingGroupByPlatform: async () => null,
  updateMessagingGroupAgent: async (id: string, patch: Record<string, unknown>) => {
    fixture.updates.push({ id, patch });
  },
}));
vi.mock('../../session-manager.js', () => ({ withExistingMailboxSession: async () => undefined }));
vi.mock('../approvals/primitive.js', () => ({
  notifyAgent: async (_session: Session, text: string) => {
    fixture.notices.push(text);
  },
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  isOwner: () => true,
  isGlobalAdmin: () => false,
  isAdminOfAgentGroup: () => false,
}));

await import('./index.js');

const session = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1', agent_provider: null } as Session;

function run(action: string, content: Record<string, unknown>): Promise<void> {
  return fixture.handlers.get(action)!(content, session);
}

beforeEach(() => {
  fixture.provider = 'claude';
  fixture.updates.length = 0;
  fixture.notices.length = 0;
});

describe('set_channel_model / set_channel_effort', () => {
  it('pins a non-Codex model id the flag vocabulary does not know, verbatim', async () => {
    await run('set_channel_model', { model: 'claude-future-model-9' });
    expect(fixture.updates).toEqual([{ id: 'wiring-1', patch: { default_model: 'claude-future-model-9' } }]);
  });

  it('refuses a Codex-only effort level on a Claude wiring', async () => {
    await run('set_channel_effort', { effort: 'ultra' });
    expect(fixture.updates).toEqual([]);
    expect(fixture.notices[0]).toMatch(/^set_channel_effort failed/);
  });
});
