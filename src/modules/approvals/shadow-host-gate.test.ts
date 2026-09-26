import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  shadow: false,
  adapterReady: [] as Array<(adapter: unknown) => void>,
  start: vi.fn(),
}));

vi.mock('../../shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
vi.mock('../../delivery.js', () => ({
  onDeliveryAdapterReady: (cb: (adapter: unknown) => void) => state.adapterReady.push(cb),
}));
vi.mock('../../response-registry.js', () => ({ registerResponseHandler: vi.fn() }));
vi.mock('../../host-lifecycle.js', () => ({ onHostShutdown: vi.fn() }));
vi.mock('./response-handler.js', () => ({ handleApprovalsResponse: vi.fn() }));
vi.mock('./onecli-approvals.js', () => ({
  startOneCLIApprovalHandler: state.start,
  stopOneCLIApprovalHandler: vi.fn(),
}));
vi.mock('./primitive.js', () => ({ requestApproval: vi.fn(), registerApprovalHandler: vi.fn(), notifyAgent: vi.fn() }));
vi.mock('./reason-capture.js', () => ({ sweepAwaitingReasonRejects: vi.fn() }));

await import('./index.js');

describe('approvals module under shadow mode', () => {
  beforeEach(() => {
    state.start.mockClear();
  });

  it('registers exactly one adapter-ready callback', () => {
    expect(state.adapterReady).toHaveLength(1);
  });

  it('starts the OneCLI approval handler when shadow mode is off', () => {
    state.shadow = false;
    const adapter = { deliver: vi.fn() };
    state.adapterReady[0](adapter);
    expect(state.start).toHaveBeenCalledWith(adapter);
  });

  it('never starts the OneCLI approval handler on a shadow host', () => {
    state.shadow = true;
    state.adapterReady[0]({ deliver: vi.fn() });
    expect(state.start).not.toHaveBeenCalled();
  });
});
