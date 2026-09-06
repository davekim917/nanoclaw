import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SWRConfig } from 'swr';
import { DecisionPane } from './SignalApp.js';
import type { SignalDecisionDetail } from '../../../../src/dashboard/observatory-v2/types.js';
import * as api from '../../lib/signal-api.js';
import * as threadApi from '../../lib/api.js';
vi.mock('../../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof threadApi>()),
  listThreads: vi.fn(),
  getThreadDetail: vi.fn(),
}));
vi.mock('../../lib/signal-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getSignalDecision: vi.fn(),
  reviewSignalDecision: vi.fn(),
  dispatchSignalDecision: vi.fn(),
}));
const authMe = { user_id: 'reviewerOne', scopes: { role: 'owner', no_filter: true, allowed_group_ids: [] } };
const fixture: SignalDecisionDetail = {
  decision: {
    id: 'd1',
    workgroup_id: 'wg',
    project_id: null,
    source_kind: 'thread-question',
    source_id: 's1:7',
    source_as_of: '2026-09-05T00:00:00Z',
    source_url: 'https://example.com/thread',
    question: 'Which identity contract?',
    context: 'Account names overlap across markets.',
    next_action: 'Keep source keys in a mapping table.',
    owner_hint: 'Theo',
    owner: null,
    evidence_hash: 'hash7',
    version: 2,
    state: 'open',
    answer: null,
    answered_by: null,
    answered_at: null,
    thread_id: 't1',
    agent_group_id: 'a1',
    blocks_release: true,
    dispatch_state: 'not_requested',
    dispatch_error: null,
    capabilities: { claim: true, answer: true, dispatch: true },
    history: [],
  },
  evidence: [{ title: 'Exact question', text: 'A source key repeats in two markets.', at: null, url: null }],
  recipients: [
    { id: 'a1', name: 'Theo' },
    { id: 'a2', name: 'Morgan' },
  ],
  destination: {
    thread_id: 't1',
    channel_name: '#project',
    default_agent_group_id: 'a1',
    default_reason: 'origin',
    error: null,
  },
};
const mount = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <DecisionPane id="d1" authMe={authMe} refresh={() => {}} />
    </SWRConfig>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSignalDecision).mockResolvedValue(structuredClone(fixture));
  vi.mocked(api.reviewSignalDecision).mockImplementation(async (_, body) => ({
    decision: {
      ...fixture.decision,
      version: 3,
      state: 'answered',
      answer: body.text?.trim() ?? null,
      answered_by: { id: authMe.user_id, name: 'Reviewer One' },
    },
  }));
  vi.mocked(api.dispatchSignalDecision).mockResolvedValue({
    decision: { ...fixture.decision, dispatch_state: 'sent' },
  });
});
afterEach(() => vi.useRealTimers());
describe('decision context and distinct authority', () => {
  it('shows exact question, source reason, recommendation and owner without an approval button', async () => {
    mount();
    await screen.findByText('Which identity contract?');
    expect(screen.getByText('Account names overlap across markets.')).toBeInTheDocument();
    expect(screen.getByText('Keep source keys in a mapping table.')).toBeInTheDocument();
    expect(screen.getByText('A source key repeats in two markets.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your decision'), { target: { value: 'Use the internal ID.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await waitFor(() =>
      expect(api.reviewSignalDecision).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({
          action: 'answer',
          expected_version: 2,
          evidence_hash: 'hash7',
          text: 'Use the internal ID.',
        }),
      ),
    );
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 3,
        evidence_hash: 'hash7',
        agent_group_id: 'a1',
      }),
    );
    await screen.findByText('Instruction sent. Agent work is not yet verified complete.');
  });
  it('submits an existing draft against the evidence that began it after refresh', async () => {
    vi.useFakeTimers();
    const changed = structuredClone(fixture);
    changed.decision.version = 3;
    changed.decision.evidence_hash = 'hash8';
    vi.mocked(api.getSignalDecision).mockResolvedValue(changed).mockResolvedValueOnce(structuredClone(fixture));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText('Your decision'), { target: { value: 'Use the internal ID.' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('v3')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    });
    expect(api.reviewSignalDecision).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ expected_version: 2, evidence_hash: 'hash7', text: 'Use the internal ID.' }),
    );
  });
  it('prevents overwriting another reviewer and keeps original approval destination', async () => {
    const other = structuredClone(fixture);
    other.decision.owner = { id: 'reviewerTwo', name: 'Reviewer Two' };
    vi.mocked(api.getSignalDecision).mockResolvedValue(other);
    mount();
    await screen.findByText('Reviewer Two owns this review.');
    expect(screen.getByLabelText('Your decision')).toBeDisabled();
  });
  it('defaults to the source agent and sends without a thread picker', async () => {
    const answered = structuredClone(fixture);
    answered.decision.answer = 'Use internal ID.';
    answered.decision.state = 'answered';
    vi.mocked(api.getSignalDecision).mockResolvedValue(answered);
    vi.mocked(api.dispatchSignalDecision).mockResolvedValue({ decision: answered.decision });
    mount();
    const send = await screen.findByRole('button', { name: 'Send decision →' });
    expect(send).toBeEnabled();
    expect(screen.getByLabelText('Instruction recipient')).toHaveValue('a1');
    expect(screen.queryByLabelText('Destination thread')).not.toBeInTheDocument();
    expect(screen.getByText('Default: agent from the original source.')).toBeInTheDocument();
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 2,
        evidence_hash: 'hash7',
        agent_group_id: 'a1',
      }),
    );
  });
  it('preserves an override across refresh and uses it for a new automatic thread', async () => {
    vi.useFakeTimers();
    const answered = structuredClone(fixture);
    Object.assign(answered.decision, { answer: 'Use internal ID.', state: 'answered', thread_id: null });
    answered.destination.thread_id = null;
    answered.destination.default_reason = 'owner';
    vi.mocked(api.getSignalDecision).mockResolvedValue(answered);
    vi.mocked(api.dispatchSignalDecision).mockResolvedValue({ decision: answered.decision });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Starts a new thread in #project.')).toBeInTheDocument();
    expect(threadApi.listThreads).not.toHaveBeenCalled();
    expect(threadApi.getThreadDetail).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Destination thread')).not.toBeInTheDocument();
    expect(screen.getByText('Default: agent identified by the source owner.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Instruction recipient'), { target: { value: 'a2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByLabelText('Instruction recipient')).toHaveValue('a2');
    expect(screen.getByText('Recipient selected by you.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    });
    expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
      expected_version: 2,
      evidence_hash: 'hash7',
      agent_group_id: 'a2',
    });
  });

  it('resets an override when opening another decision', async () => {
    const answered = structuredClone(fixture);
    Object.assign(answered.decision, { answer: 'Use internal ID.', state: 'answered' });
    vi.mocked(api.getSignalDecision).mockImplementation(async (id) => ({
      ...answered,
      decision: { ...answered.decision, id },
    }));
    const provider = new Map();
    const pane = (id: string) => (
      <SWRConfig value={{ provider: () => provider, dedupingInterval: 0 }}>
        <DecisionPane id={id} authMe={authMe} refresh={() => {}} />
      </SWRConfig>
    );
    const view = render(pane('d1'));
    fireEvent.change(await screen.findByLabelText('Instruction recipient'), { target: { value: 'a2' } });
    view.rerender(pane('d2'));
    await waitFor(() => expect(screen.getByLabelText('Instruction recipient')).toHaveValue('a1'));
    view.rerender(pane('d1'));
    await waitFor(() => expect(screen.getByLabelText('Instruction recipient')).toHaveValue('a1'));
  });

  it('locks the recipient while sending', async () => {
    const answered = structuredClone(fixture);
    Object.assign(answered.decision, { answer: 'Use internal ID.', state: 'answered' });
    vi.mocked(api.getSignalDecision).mockResolvedValue(answered);
    let finish!: (value: { decision: typeof answered.decision }) => void;
    vi.mocked(api.dispatchSignalDecision).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send decision →' }));
    expect(screen.getByLabelText('Instruction recipient')).toBeDisabled();
    await act(async () => {
      finish({ decision: answered.decision });
    });
  });

  it('releases owned review even though claim is unavailable', async () => {
    const owned = structuredClone(fixture);
    owned.decision.owner = { id: 'reviewerOne', name: 'Reviewer One' };
    owned.decision.capabilities.claim = false;
    owned.decision.capabilities.release = true;
    vi.mocked(api.getSignalDecision).mockResolvedValue(owned);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Release review' }));
    await waitFor(() =>
      expect(api.reviewSignalDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ action: 'release' })),
    );
  });

  it.each(['t1', ''])(
    'retries reserved delivery with target %j using persisted recipient and evidence',
    async (target) => {
      const pending = structuredClone(fixture);
      Object.assign(pending.decision, {
        answer: 'Use internal ID.',
        state: 'changed',
        dispatch_state: 'pending',
        evidence_hash: 'new-hash',
        dispatch_evidence_hash: 'reserved-hash',
        dispatch_agent_group_id: 'a1',
        dispatch_target_thread_id: target,
      });
      pending.destination.default_agent_group_id = 'a2';
      pending.destination.thread_id = 'another-thread';
      pending.destination.error = 'The source channel is no longer available.';
      vi.mocked(api.getSignalDecision).mockResolvedValue(pending);
      vi.mocked(api.dispatchSignalDecision).mockResolvedValue({ decision: pending.decision });
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Retry send →' }));
      await waitFor(() =>
        expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
          expected_version: 2,
          evidence_hash: 'reserved-hash',
          agent_group_id: 'a1',
        }),
      );
      expect(screen.getByLabelText('Instruction recipient')).toBeDisabled();
    },
  );

  it('explains uncertain thread creation as requiring operator reconciliation', async () => {
    const answered = structuredClone(fixture);
    Object.assign(answered.decision, { answer: 'Use internal ID.', state: 'answered' });
    vi.mocked(api.getSignalDecision).mockResolvedValue(answered);
    vi.mocked(api.dispatchSignalDecision).mockRejectedValue(
      new api.SignalApiError(503, 'thread_creation_uncertain_reconciliation_required'),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send decision →' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An operator must reconcile the source channel before delivery can continue.',
    );
  });

  it('keeps the chosen agent in the same form and sends with one click', async () => {
    mount();
    const input = await screen.findByLabelText('Your decision');
    const select = screen.getByLabelText('Instruction recipient');
    expect(select.closest('form')).toBe(input.closest('form'));
    fireEvent.change(input, { target: { value: 'Use internal ID.' } });
    fireEvent.change(select, { target: { value: 'a2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 3,
        evidence_hash: 'hash7',
        agent_group_id: 'a2',
      }),
    );
  });

  it.each(['save', 'dispatch'])('retries uncertain %s without changing the attempt', async (stage) => {
    const failing = stage === 'save' ? api.reviewSignalDecision : api.dispatchSignalDecision;
    vi.mocked(failing).mockRejectedValueOnce(new Error('Connection lost'));
    mount();
    fireEvent.change(await screen.findByLabelText('Your decision'), { target: { value: 'Use internal ID.' } });
    fireEvent.change(screen.getByLabelText('Instruction recipient'), { target: { value: 'a2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await screen.findByText(/Connection lost/);
    if (stage === 'save') expect(api.dispatchSignalDecision).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Instruction recipient')).toBeDisabled();
    expect(screen.getByLabelText('Your decision')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: stage === 'save' ? 'Retry decision →' : 'Retry send →' }));
    await screen.findByText('Instruction sent. Agent work is not yet verified complete.');
    expect(vi.mocked(failing).mock.calls[0]).toEqual(vi.mocked(failing).mock.calls[1]);
    if (stage === 'dispatch') expect(api.reviewSignalDecision).toHaveBeenCalledTimes(1);
  });

  it.each([403, 409])('does not send after save rejection %s', async (status) => {
    vi.mocked(api.reviewSignalDecision).mockRejectedValueOnce(new api.SignalApiError(status, 'Changed or denied'));
    mount();
    fireEvent.change(await screen.findByLabelText('Your decision'), { target: { value: 'Use internal ID.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await screen.findByText(/Review the latest source and edit/);
    expect(api.dispatchSignalDecision).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send decision →' })).toBeDisabled();
    expect(screen.getByLabelText('Your decision')).toBeEnabled();
  });

  it('rejects a different answer returned by an old save replay', async () => {
    vi.mocked(api.reviewSignalDecision).mockResolvedValue({
      decision: {
        ...fixture.decision,
        state: 'answered',
        answer: 'A different answer',
        answered_by: { id: authMe.user_id, name: 'Reviewer One' },
      },
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Your decision'), { target: { value: 'Use internal ID.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await screen.findByText(/The recorded decision changed/);
    expect(api.dispatchSignalDecision).not.toHaveBeenCalled();
  });

  it('keeps an in-flight attempt across navigation without contaminating another decision', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.reviewSignalDecision>>) => void;
    vi.mocked(api.reviewSignalDecision).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(api.getSignalDecision).mockImplementation(async (id) => ({
      ...fixture,
      decision: { ...fixture.decision, id },
    }));
    const cache = new Map();
    const pane = (id: string) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <DecisionPane id={id} authMe={authMe} refresh={() => {}} />
      </SWRConfig>
    );
    const view = render(pane('d1'));
    fireEvent.change(await screen.findByLabelText('Your decision'), { target: { value: 'Use internal ID.' } });
    fireEvent.change(screen.getByLabelText('Instruction recipient'), { target: { value: 'a2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    view.rerender(pane('d2'));
    await waitFor(() => expect(screen.getByLabelText('Your decision')).toHaveValue(''));
    expect(screen.getByLabelText('Instruction recipient')).toHaveValue('a1');
    view.rerender(pane('d1'));
    await waitFor(() => expect(screen.getByLabelText('Your decision')).toHaveValue('Use internal ID.'));
    expect(screen.getByLabelText('Instruction recipient')).toBeDisabled();
    await act(async () =>
      finish({
        decision: {
          ...fixture.decision,
          version: 3,
          state: 'answered',
          answer: 'Use internal ID.',
          answered_by: { id: authMe.user_id, name: 'Reviewer One' },
        },
      }),
    );
    await screen.findByText('Instruction sent. Agent work is not yet verified complete.');
    expect(api.reviewSignalDecision).toHaveBeenCalledTimes(1);
    expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ agent_group_id: 'a2' }));
  });

  it('reports pending response truthfully and retries without another save', async () => {
    vi.mocked(api.dispatchSignalDecision).mockResolvedValue({
      decision: {
        ...fixture.decision,
        version: 4,
        answer: 'Use internal ID.',
        state: 'answered',
        dispatch_state: 'pending',
      },
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Your decision'), { target: { value: 'Use internal ID.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await screen.findByText('Delivery pending or uncertain. Retry checks the same instruction.');
    expect(screen.queryByText('Instruction sent. Agent work is not yet verified complete.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry send →' }));
    await waitFor(() => expect(api.dispatchSignalDecision).toHaveBeenCalledTimes(2));
    expect(api.reviewSignalDecision).toHaveBeenCalledTimes(1);
  });

  it('allows a new answer when the source changes after a completed delivery', async () => {
    const changed = structuredClone(fixture);
    Object.assign(changed.decision, {
      state: 'changed',
      answer: 'Previous answer',
      dispatch_state: 'sent',
      dispatch_agent_group_id: 'a1',
      dispatch_evidence_hash: 'old-hash',
      evidence_hash: 'hash7',
    });
    vi.mocked(api.getSignalDecision).mockResolvedValue(changed);
    mount();
    expect(await screen.findByLabelText('Your decision')).toBeEnabled();
    expect(
      screen.getByText('Previous instruction sent. Review the changed evidence before sending a new decision.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Instruction recipient')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Your decision'), { target: { value: 'New answer' } });
    fireEvent.change(screen.getByLabelText('Instruction recipient'), { target: { value: 'a2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send decision →' }));
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 3,
        evidence_hash: 'hash7',
        agent_group_id: 'a2',
      }),
    );
  });

  it('privileged approvals expose the exact source link and no generic mutation', async () => {
    const approval = structuredClone(fixture);
    approval.decision.source_kind = 'approval';
    vi.mocked(api.getSignalDecision).mockResolvedValue(approval);
    mount();
    await screen.findByText(/Privileged approval/);
    expect(screen.getByRole('link', { name: /Open original source/ })).toHaveAttribute(
      'href',
      'https://example.com/thread',
    );
    expect(screen.queryByRole('button', { name: 'Claim review' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Your decision')).not.toBeInTheDocument();
  });
});
