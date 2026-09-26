import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ shadow: false, getAgentGroup: vi.fn() }));

vi.mock('./shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
// Complete stub, not a spread: log.ts installs process-wide exit handlers.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/agent-groups.js')>()),
  getAgentGroup: state.getAgentGroup,
}));

const { buildAgentGroupImage } = await import('./container-runner.js');

describe('buildAgentGroupImage under shadow mode', () => {
  beforeEach(() => {
    state.getAgentGroup.mockReset();
    state.getAgentGroup.mockResolvedValue(undefined);
  });

  it('proceeds to the agent group lookup when shadow mode is off', async () => {
    state.shadow = false;
    await expect(buildAgentGroupImage('ag-unknown')).rejects.toThrow('Agent group not found');
    expect(state.getAgentGroup).toHaveBeenCalledWith('ag-unknown');
  });

  it('refuses before touching the DB or docker on a shadow host', async () => {
    state.shadow = true;
    await expect(buildAgentGroupImage('ag-unknown')).rejects.toThrow(/disabled on a shadow host/);
    expect(state.getAgentGroup).not.toHaveBeenCalled();
  });
});
