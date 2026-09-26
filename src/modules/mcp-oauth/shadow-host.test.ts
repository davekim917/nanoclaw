import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  shadow: false,
  methods: [] as string[],
  list: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../../shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: () => false,
}));
vi.mock('../../db/mcp-oauth-integrations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/mcp-oauth-integrations.js')>()),
  listMcpOAuthIntegrations: state.list,
}));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (_bin: string, _argv: string[], _options: unknown, callback: unknown) => {
      const done = callback as (e: Error | null, out: string, err: string) => void;
      let stdin = '';
      queueMicrotask(() => {
        const method = /--request (\w+)/.exec(stdin)?.[1] ?? '?';
        state.methods.push(method);
        done(null, method === 'GET' ? '[]\n200' : '\n204', '');
      });
      return {
        stdin: {
          on: () => undefined,
          end: (chunk?: string) => {
            stdin = chunk ?? '';
          },
        },
      };
    },
  };
});

const { deleteOnecliSecret, putOnecliBearerSecret } = await import('./onecli-secret-writer.js');
const { refreshExpiringMcpOAuthIntegrations } = await import('./service.js');

const SPEC = {
  name: 'Example-MCP',
  hostPattern: 'mcp.example.com',
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
};

describe('MCP OAuth under shadow mode', () => {
  beforeEach(() => {
    state.methods.length = 0;
    state.list.mockClear();
  });

  it('writes OneCLI secrets when shadow mode is off', async () => {
    state.shadow = false;
    await expect(deleteOnecliSecret('secret-1')).resolves.toBe(true);
    expect(state.methods).toEqual(['DELETE']);
  });

  it('refuses every OneCLI secret write on a shadow host, and still reads', async () => {
    state.shadow = true;
    await expect(putOnecliBearerSecret(SPEC, 'token')).rejects.toThrow(/disabled on a shadow host/);
    await expect(deleteOnecliSecret('secret-1')).rejects.toThrow(/disabled on a shadow host/);
    expect(state.methods).toEqual(['GET']);
  });

  it('refreshes integrations when shadow mode is off', async () => {
    state.shadow = false;
    await refreshExpiringMcpOAuthIntegrations();
    expect(state.list).toHaveBeenCalledTimes(1);
  });

  it('never looks at an integration, let alone refreshes it, on a shadow host', async () => {
    state.shadow = true;
    const outcome = await refreshExpiringMcpOAuthIntegrations(() => {
      throw new Error('no network call expected');
    });
    expect(outcome).toEqual({ checked: 0, refreshed: [], failed: [], needsLogin: [] });
    expect(state.list).not.toHaveBeenCalled();
  });
});
