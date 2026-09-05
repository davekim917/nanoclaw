import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SWRConfig } from 'swr';
import { DecisionPane } from './SignalApp.js';
import type { SignalDecisionDetail } from '../../../../src/dashboard/observatory-v2/types.js';
import * as api from '../../lib/signal-api.js';
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
  recipients: [{ id: 'a1', name: 'Theo' }],
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
  vi.mocked(api.reviewSignalDecision).mockResolvedValue({ decision: fixture.decision });
});
describe('decision context and distinct authority', () => {
  it('shows exact question, source reason, recommendation and owner without an approval button', async () => {
    mount();
    await screen.findByText('Which identity contract?');
    expect(screen.getByText('Account names overlap across markets.')).toBeInTheDocument();
    expect(screen.getByText('Keep source keys in a mapping table.')).toBeInTheDocument();
    expect(screen.getByText('A source key repeats in two markets.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your decision'), { target: { value: 'Use the internal ID.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record decision →' }));
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
    expect(api.dispatchSignalDecision).not.toHaveBeenCalled();
    await screen.findByText('Decision recorded. No instruction has been sent.');
  });
  it('prevents overwriting another reviewer and keeps original approval destination', async () => {
    const other = structuredClone(fixture);
    other.decision.owner = { id: 'reviewerTwo', name: 'Reviewer Two' };
    vi.mocked(api.getSignalDecision).mockResolvedValue(other);
    mount();
    await screen.findByText('Reviewer Two owns this review.');
    expect(screen.getByLabelText('Your decision')).toBeDisabled();
  });
  it('requires an explicit destination recipient for separate dispatch', async () => {
    const answered = structuredClone(fixture);
    answered.decision.answer = 'Use internal ID.';
    answered.decision.state = 'answered';
    vi.mocked(api.getSignalDecision).mockResolvedValue(answered);
    vi.mocked(api.dispatchSignalDecision).mockResolvedValue({ decision: answered.decision });
    mount();
    const send = await screen.findByRole('button', { name: 'Send recorded instruction →' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Instruction recipient'), { target: { value: 'a1' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 2,
        evidence_hash: 'hash7',
        agent_group_id: 'a1',
      }),
    );
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

  it('retries uncertain delivery using the persisted recipient and evidence after reload', async () => {
    const pending = structuredClone(fixture);
    Object.assign(pending.decision, {
      answer: 'Use internal ID.',
      state: 'changed',
      dispatch_state: 'pending',
      evidence_hash: 'new-hash',
      dispatch_evidence_hash: 'reserved-hash',
      dispatch_agent_group_id: 'a1',
      dispatch_target_thread_id: 't1',
    });
    vi.mocked(api.getSignalDecision).mockResolvedValue(pending);
    vi.mocked(api.dispatchSignalDecision).mockResolvedValue({ decision: pending.decision });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Send recorded instruction →' }));
    await waitFor(() =>
      expect(api.dispatchSignalDecision).toHaveBeenCalledWith('d1', {
        expected_version: 2,
        evidence_hash: 'reserved-hash',
        agent_group_id: 'a1',
      }),
    );
    expect(screen.getByLabelText('Instruction recipient')).toBeDisabled();
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
