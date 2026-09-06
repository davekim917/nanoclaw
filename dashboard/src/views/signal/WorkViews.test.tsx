import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { SignalDecision, SignalAgent, SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
import type { ThreadDetailResponse } from '../../lib/api.js';
import { DecisionQueue, AgentWorkspace, ThreadWorkspace } from './WorkViews.js';
import * as api from '../../lib/api.js';
import * as signalApi from '../../lib/signal-api.js';
vi.mock('../../lib/signal-api.js', () => ({ getSignalThreadContext: vi.fn() }));
vi.mock('../../lib/api.js', async (original) => ({
  ...(await original<typeof api>()),
  listThreads: vi.fn(),
  getThreadDetail: vi.fn(),
  postThreadMessage: vi.fn(),
}));
vi.mock('../../lib/sse.ts', () => ({ subscribe: () => () => {} }));
vi.mock('../console/ThreadConsole.js', () => ({ ThreadConsole: () => <div>Legacy transcript console</div> }));
vi.mock('../console/CloseControl.js', () => ({ CloseThreadControl: () => <button>Close work</button> }));
const decision = (id: string, overrides: Partial<SignalDecision> = {}): SignalDecision => ({
  id,
  workgroup_id: 'wg',
  project_id: null,
  source_kind: 'thread-question',
  source_id: id,
  source_as_of: '2026-09-05T00:00:00Z',
  source_url: null,
  question: `Question ${id}`,
  context: 'Evidence',
  next_action: 'Choose a contract',
  owner_hint: null,
  owner: null,
  evidence_hash: id,
  version: 0,
  state: 'open',
  answer: null,
  answered_by: null,
  answered_at: null,
  thread_id: 't1',
  agent_group_id: 'a1',
  blocks_release: false,
  dispatch_state: 'not_requested',
  dispatch_error: null,
  capabilities: { claim: true, answer: true, dispatch: true },
  history: [],
  ...overrides,
});
const agent: SignalAgent = {
  id: 'a1',
  name: 'Builder',
  workgroup_id: 'wg',
  provider: 'codex',
  awake: true,
  active: false,
  last_seen_at: null,
  current_tool: null,
  claims: ['issue-27'],
  thread_ids: ['t1'],
};
const detail: ThreadDetailResponse = {
  thread: {
    thread_id: 't1',
    synthetic: false,
    channel_key: 'channel',
    channel_name: 'Engineering',
    title: 'Account contract',
    participants: [{ agent_group_id: 'a1', name: 'Builder', session_id: 's1', avatarUrl: null, provider: 'codex' }],
    assignable_agents: [],
    last_activity_at: null,
    state: 'needs_you',
    session_ids: ['s1'],
    container_status: 'idle',
    provider_status: null,
    current_tool: null,
    tool_started_at: null,
    reply_target_session_id: 's1',
    snoozed: false,
    needs_you_reason: { cause: 'ask_question', text: 'Choose the identity key.' },
  } as ThreadDetailResponse['thread'],
  transcript: [
    {
      direction: 'out',
      kind: 'text',
      seq: 1,
      timestamp: '2026-09-05T00:00:00Z',
      text: 'Exact conversation evidence',
      author: null,
      session_id: 's1',
      agent_group_id: 'a1',
      agent_name: 'Builder',
    },
  ],
};
const authMe = { user_id: 'reviewer', scopes: { role: 'owner', no_filter: true, allowed_group_ids: [] } };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listThreads).mockResolvedValue({ threads: [detail.thread] });
  vi.mocked(api.getThreadDetail).mockResolvedValue(detail);
  vi.mocked(signalApi.getSignalThreadContext).mockResolvedValue({
    as_of: '2026-09-06T00:00:00Z', workgroups: [], projects: [], decisions: [], agents: [], activity: [], sources: [],
    capabilities: { manage_projects: false },
  });
});
describe('work-first interaction', () => {
  it('loads project and decision context for an exact off-page thread', async () => {
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [] });
    const context: SignalOverview = {
      as_of: '2026-09-06T00:00:00Z', workgroups: [{ id: 'wg', name: 'Workspace' }],
      projects: [{ id: 'mapped', workgroup_id: 'wg', name: 'Mapped project', description: 'Exact mapped objective',
        repositories: [], channel_keys: ['channel'], version: 1, updated_at: null, unmapped: false,
        thread_ids: ['t1'], decision_ids: ['off-page'], items: [] }],
      decisions: [decision('off-page')], agents: [], activity: [], sources: [], capabilities: { manage_projects: false },
    };
    vi.mocked(signalApi.getSignalThreadContext).mockResolvedValue(context);
    render(<SWRConfig value={{ provider: () => new Map() }}>
      <ThreadWorkspace authMe={authMe} workgroup="all" query="" id="t1" overview={{ ...context, projects: [], decisions: [] }} />
    </SWRConfig>);
    expect(await screen.findByText('Exact mapped objective')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Question off-page/ })).toBeInTheDocument();
    expect(signalApi.getSignalThreadContext).toHaveBeenCalledWith('t1', 'all');
  });

  it('refetches exact context when the workspace changes for the same thread', async () => {
    vi.mocked(signalApi.getSignalThreadContext).mockImplementation(async (_id, workgroup) => ({
      as_of: '2026-09-06T00:00:00Z', workgroups: [], projects: [],
      decisions: [decision(workgroup, { workgroup_id: workgroup })],
      agents: [], activity: [], sources: [], capabilities: { manage_projects: false },
    }));
    const cache = new Map();
    const view = (workgroup: string) => <SWRConfig value={{ provider: () => cache }}>
      <ThreadWorkspace authMe={authMe} workgroup={workgroup} query="" id="t1" overview={undefined} />
    </SWRConfig>;
    const rendered = render(view('workspace-one'));
    expect(await screen.findByText('Question workspace-one')).toBeInTheDocument();
    rendered.rerender(view('workspace-two'));
    expect(await screen.findByText('Question workspace-two')).toBeInTheDocument();
    expect(screen.queryByText('Question workspace-one')).toBeNull();
    expect(signalApi.getSignalThreadContext).toHaveBeenLastCalledWith('t1', 'workspace-two');
  });

  it('encodes the selected workspace in the exact context request', async () => {
    const actual = await vi.importActual<typeof signalApi>('../../lib/signal-api.js');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      await actual.getSignalThreadContext('thread/one', 'workspace/one');
      expect(fetch).toHaveBeenCalledWith(
        '/dashboard/api/observatory/v2?workgroup=workspace%2Fone&thread_id=thread%2Fone',
        expect.objectContaining({ method: 'GET' }),
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it.each(['request failure', 'unavailable source', 'healthy empty source'] as const)(
    'preserves loaded context only when needed after an exact %s', async (result) => {
      const overview: SignalOverview = {
        as_of: '2026-09-06T00:00:00Z', workgroups: [{ id: 'wg', name: 'Workspace' }],
        projects: [{ id: 'mapped', workgroup_id: 'wg', name: 'Mapped project', description: 'Loaded objective',
          repositories: [], channel_keys: ['channel'], version: 1, updated_at: null, unmapped: false,
          thread_ids: ['t1'], decision_ids: ['loaded'], items: [] }],
        decisions: [decision('loaded'), decision('unrelated', { thread_id: 'other' })],
        agents: [], activity: [], sources: [], capabilities: { manage_projects: false },
      };
      if (result === 'request failure') {
        vi.mocked(signalApi.getSignalThreadContext).mockRejectedValue(new Error('Unavailable'));
      } else {
        vi.mocked(signalApi.getSignalThreadContext).mockResolvedValue({
          ...overview, projects: [], decisions: [],
          sources: [{ workgroup_id: 'wg', source: 'threads', as_of: null, detail: null,
            status: result === 'unavailable source' ? 'unavailable' : 'available' }],
        });
      }
      render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <ThreadWorkspace authMe={authMe} workgroup="all" query="" id="t1" overview={overview} />
      </SWRConfig>);
      await screen.findByText('Choose the identity key.');
      if (result === 'healthy empty source') {
        expect(await screen.findByText('No explicit project objective is mapped to this conversation.')).toBeInTheDocument();
        expect(screen.queryByText('Question loaded')).toBeNull();
      } else {
        expect(screen.getByText('Loaded objective')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /Question loaded/ })).toBeInTheDocument();
      }
      expect(screen.queryByText('Question unrelated')).toBeNull();
    },
  );

  it('selects an exact decision from a grouped queue and distinguishes reviewed from sent', () => {
    const choose = vi.fn();
    render(
      <DecisionQueue
        timezone="America/Los_Angeles"
        decisions={[
          decision('blocking', { blocks_release: true, state: 'changed' }),
          decision('recorded', { state: 'answered', answer: 'Use ID' }),
        ]}
        selectedId="blocking"
        onSelect={choose}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Blocking release' })).toBeInTheDocument();
    expect(screen.getAllByTitle('Sep 4, 2026, 5:00 PM')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Reviewed' })).toBeInTheDocument();
    expect(screen.getByText(/Recorded only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Question recorded/ }));
    expect(choose).toHaveBeenCalledWith('recorded');
    expect(screen.getByRole('button', { name: /Question blocking/ })).toHaveAttribute('aria-pressed', 'true');
  });
  it('focuses agent work using exact associations with conversations secondary', () => {
    render(
      <AgentWorkspace
        agents={[agent]}
        decisions={[decision('linked'), decision('unrelated', { agent_group_id: 'other', thread_id: 'other' })]}
        selectedId="a1"
        timezone="UTC"
      />,
    );
    expect(screen.getByText('issue-27', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Question linked')).toBeInTheDocument();
    expect(screen.queryByText('Question unrelated')).toBeNull();
    expect(screen.getByText('Conversation evidence · 1 linked threads').closest('details')).not.toHaveAttribute('open');
  });
  it('opens the work brief first, discloses conversation on demand, and sends separately to a named agent', async () => {
    vi.mocked(api.postThreadMessage).mockResolvedValue({
      task_id: 'task',
      thread_id: 't1',
      agent_group_id: 'a1',
      session_id: 's1',
      message_id: 'message',
      echo_status: 'sent',
      created_session: false,
      handoff: null,
    });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <ThreadWorkspace authMe={authMe} workgroup="all" query="" id="t1" overview={undefined} />
      </SWRConfig>,
    );
    await screen.findByText('Choose the identity key.');
    expect(screen.getByRole('heading', { name: 'Objective' })).toBeInTheDocument();
    expect(screen.queryByText('Exact conversation evidence')).toBeNull();
    expect(screen.queryByText('Legacy transcript console')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Recent conversation' }));
    expect(screen.getByText('Exact conversation evidence')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'Use internal ID.' } });
    expect(api.postThreadMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await waitFor(() =>
      expect(api.postThreadMessage).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ agent_group_id: 'a1', text: 'Use internal ID.' }),
      ),
    );
    await screen.findByText(/Instruction accepted for Builder/);
    fireEvent.click(screen.getByRole('button', { name: 'Full conversation ↗' }));
    expect(screen.getByText('Legacy transcript console')).toBeInTheDocument();
  });
  it('allows correcting a definitive pre-write validation rejection without unlocking uncertain delivery', async () => {
    const pending = new Map();
    vi.mocked(api.postThreadMessage).mockRejectedValueOnce({ status: 400, error: 'message_too_long' });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <ThreadWorkspace authMe={authMe} workgroup="all" query="" id="t1" overview={undefined} pendingInstructions={pending} />
      </SWRConfig>,
    );
    await screen.findByText('Choose the identity key.');
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'Overlong instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await screen.findByText('too long — shorten it');
    expect(pending.size).toBe(0);
    expect(screen.getByLabelText('Work instruction')).toBeEnabled();
    expect(screen.getByLabelText('Work instruction')).toHaveValue('Overlong instruction');
    expect(screen.getByLabelText('Work instruction recipient')).toBeEnabled();
    const rejectedKey = vi.mocked(api.postThreadMessage).mock.calls[0][1].idempotency_key;
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'Short instruction' } });
    vi.mocked(api.postThreadMessage).mockRejectedValueOnce(new Error('Network uncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await screen.findByText('request failed');
    expect(screen.getByLabelText('Work instruction')).toBeDisabled();
    expect(pending.size).toBe(1);
    const retryPayload = vi.mocked(api.postThreadMessage).mock.calls[1][1];
    expect(retryPayload.text).toBe('Short instruction');
    expect(retryPayload.idempotency_key).not.toBe(rejectedKey);
    vi.mocked(api.postThreadMessage).mockRejectedValueOnce(new Error('Still uncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.postThreadMessage).mock.calls[2][1]).toEqual(retryPayload);
  });
  it('retains uncertain delivery keys across navigation and keeps old completion out of the new draft', async () => {
    vi.mocked(api.getThreadDetail).mockImplementation(async (id) => ({
      ...detail,
      thread: { ...detail.thread, thread_id: id, title: `Work ${id}` },
    }));
    let rejectSend!: (reason: Error) => void;
    vi.mocked(api.postThreadMessage).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const cache = new Map();
    const view = (id: string) => (
      <SWRConfig value={{ provider: () => cache }}>
        <ThreadWorkspace authMe={authMe} workgroup="all" query="" id={id} overview={undefined} />
      </SWRConfig>
    );
    const rendered = render(view('t1'));
    await screen.findByText('Work t1');
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'First instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(1));
    const original = vi.mocked(api.postThreadMessage).mock.calls[0][1];
    rendered.rerender(view('t2'));
    await screen.findByText('Work t2');
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'New draft' } });
    rejectSend(new Error('Network uncertain'));
    await waitFor(() => expect(screen.getByLabelText('Work instruction')).toHaveValue('New draft'));
    expect(screen.queryByText('Network uncertain')).toBeNull();
    rendered.rerender(view('t1'));
    await screen.findByText('Work t1');
    expect(screen.getByLabelText('Work instruction')).toHaveValue('First instruction');
    expect(screen.getByLabelText('Work instruction')).toBeDisabled();
    vi.mocked(api.postThreadMessage).mockRejectedValue(new Error('Still uncertain'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry same instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.postThreadMessage).mock.calls[1]).toEqual(['t1', original]);
  });
  it('keeps unresolved instructions across view remounts and isolates signed-in users', async () => {
    const pending = new Map();
    const cache = new Map();
    let finish!: (value: Awaited<ReturnType<typeof api.postThreadMessage>>) => void;
    vi.mocked(api.postThreadMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = (user = authMe) => (
      <SWRConfig value={{ provider: () => cache }}>
        <ThreadWorkspace
          authMe={user}
          workgroup="all"
          query=""
          id="t1"
          overview={undefined}
          pendingInstructions={pending}
        />
      </SWRConfig>
    );
    let rendered = render(view());
    await screen.findByText('Choose the identity key.');
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'Private pending instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(1));
    rendered.unmount();
    rendered = render(view());
    await screen.findByText('Choose the identity key.');
    expect(screen.getByLabelText('Work instruction')).toHaveValue('Private pending instruction');
    rendered.rerender(view({ ...authMe, user_id: 'different-reviewer' }));
    await waitFor(() => expect(screen.getByLabelText('Work instruction')).toHaveValue(''));
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'Other user draft' } });
    finish({
      task_id: 'task',
      thread_id: 't1',
      agent_group_id: 'a1',
      session_id: 's1',
      message_id: 'message',
      echo_status: 'sent',
      created_session: false,
      handoff: null,
    });
    await waitFor(() => expect(pending.size).toBe(1));
    expect(screen.getByLabelText('Work instruction')).toHaveValue('Other user draft');
    expect(screen.queryByText(/Instruction accepted for/)).toBeNull();
  });
  it('reconciles a remounted retry when the original send completes first', async () => {
    const pending = new Map();
    const cache = new Map();
    const completions: Array<(value: Awaited<ReturnType<typeof api.postThreadMessage>>) => void> = [];
    vi.mocked(api.postThreadMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(resolve);
        }),
    );
    const view = () => (
      <SWRConfig value={{ provider: () => cache }}>
        <ThreadWorkspace
          authMe={authMe}
          workgroup="all"
          query=""
          id="t1"
          overview={undefined}
          pendingInstructions={pending}
        />
      </SWRConfig>
    );
    let rendered = render(view());
    await screen.findByText('Choose the identity key.');
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'One immutable instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await waitFor(() => expect(completions).toHaveLength(1));
    rendered.unmount();
    rendered = render(view());
    await screen.findByText('Choose the identity key.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry same instruction →' }));
    await waitFor(() => expect(completions).toHaveLength(2));
    const result = {
      task_id: 'task',
      thread_id: 't1',
      agent_group_id: 'a1',
      session_id: 's1',
      message_id: 'message',
      echo_status: 'sent' as const,
      created_session: false,
      handoff: null,
    };
    completions[0](result);
    completions[1](result);
    await screen.findByText(/Instruction accepted for Builder/);
    expect(screen.getByLabelText('Work instruction')).not.toBeDisabled();
    expect(pending.size).toBe(0);
    expect(vi.mocked(api.postThreadMessage).mock.calls[0]).toEqual(vi.mocked(api.postThreadMessage).mock.calls[1]);
  });
  it('keeps the newer retry busy when an older request rejects after remount', async () => {
    const pending = new Map();
    const cache = new Map();
    let rejectOriginal!: (reason: Error) => void;
    let finishRetry!: (value: Awaited<ReturnType<typeof api.postThreadMessage>>) => void;
    vi.mocked(api.postThreadMessage)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOriginal = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          }),
      );
    const view = () => (
      <SWRConfig value={{ provider: () => cache }}>
        <ThreadWorkspace
          authMe={authMe}
          workgroup="all"
          query=""
          id="t1"
          overview={undefined}
          pendingInstructions={pending}
        />
      </SWRConfig>
    );
    let rendered = render(view());
    await screen.findByText('Choose the identity key.');
    fireEvent.change(screen.getByLabelText('Work instruction recipient'), { target: { value: 'a1' } });
    fireEvent.change(screen.getByLabelText('Work instruction'), { target: { value: 'One immutable instruction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(1));
    rendered.unmount();
    rendered = render(view());
    await screen.findByText('Choose the identity key.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry same instruction →' }));
    await waitFor(() => expect(api.postThreadMessage).toHaveBeenCalledTimes(2));
    rejectOriginal(new Error('Original request ended late'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same instruction →' })).toBeDisabled(),
    );
    finishRetry({
      task_id: 'task',
      thread_id: 't1',
      agent_group_id: 'a1',
      session_id: 's1',
      message_id: 'message',
      echo_status: 'sent',
      created_session: false,
      handoff: null,
    });
    await screen.findByText(/Instruction accepted for Builder/);
    expect(pending.size).toBe(0);
  });
  it('preserves an ownerless source context without offering conversation-only actions', async () => {
    const source = {
      ...detail.thread,
      thread_id: 'board:synthetic-item',
      title: 'Source-only work',
      participants: [],
      assignable_agents: [{ agent_group_id: 'a1', name: 'Builder' }],
      session_ids: [],
      reply_target_session_id: null,
      attention_source: {
        kind: 'release-board',
        as_of: '2026-09-05T00:00:00Z',
        stale: false,
        url: null,
        next_action: 'Assign an agent.',
        assigned: null,
        assigned_expired: null,
      },
    } as ThreadDetailResponse['thread'];
    vi.mocked(api.listThreads).mockResolvedValue({ threads: [source] });
    vi.mocked(api.getThreadDetail).mockResolvedValue({ thread: source, transcript: [] });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <ThreadWorkspace authMe={authMe} workgroup="all" query="" id={source.thread_id} overview={undefined} />
      </SWRConfig>,
    );
    await screen.findByText('Source record has no conversation yet');
    expect(screen.getByRole('heading', { name: 'Source-only work' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Work instruction recipient')).toBeNull();
    expect(screen.queryByLabelText('Work instruction')).toBeNull();
    expect(screen.queryByRole('button', { name: /Snooze/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close work' })).toBeNull();
    expect(api.postThreadMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Full conversation ↗' }));
    expect(screen.getByText('Legacy transcript console')).toBeInTheDocument();
  });
});
