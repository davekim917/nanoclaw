import { describe, expect, it, vi } from 'vitest';

const startLogin = vi.hoisted(() => vi.fn(async () => ({ name: 'x', authorizeUrl: 'https://auth.example.com' })));

vi.mock('../../modules/mcp-oauth/service.js', () => ({
  startLogin,
  completeLogin: vi.fn(),
  refreshExpiringMcpOAuthIntegrations: vi.fn(),
  removeIntegration: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => ({ id, name: id })),
}));

import { lookup } from '../registry.js';
import './integrations.js';

describe('ncl integrations login --authorize-param', () => {
  const base = { name: 'example', url: 'https://mcp.example.com/mcp', group: 'ag-1' };

  it.each([
    [['a=1', 'b=2'], { a: '1', b: '2' }],
    [['a=1,b=2', 'c=3'], { a: '1', b: '2', c: '3' }],
    ['a=1,b=2', { a: '1', b: '2' }],
  ])('accepts %j as a repeatable flag', async (authorizeParam, expected) => {
    const cmd = lookup('integrations-login');
    expect(cmd?.listArgs).toContain('authorize_param');
    await cmd!.handler(cmd!.parseArgs({ ...base, 'authorize-param': authorizeParam }), { caller: 'host' });
    expect(startLogin).toHaveBeenLastCalledWith(expect.objectContaining({ extraAuthorizeParams: expected }));
  });
});
