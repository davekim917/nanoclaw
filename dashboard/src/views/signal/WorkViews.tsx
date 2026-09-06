import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { SignalAgent, SignalDecision, SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
import { getThreadDetail, listThreads, postThreadMessage, type AuthMe, type ApiError } from '../../lib/api.js';
import { subscribe } from '../../lib/sse.ts';
import { getSignalThreadContext } from '../../lib/signal-api.js';
import { ThreadConsole } from '../console/ThreadConsole.js';
import { CloseThreadControl } from '../console/CloseControl.js';
import { setSnoozed } from '../console/actions.js';
import { actionError } from '../console/action-error.js';
import { decisionVisitChange, type VisitBaseline } from './visit-changes.js';
import { agentDecisions, decisionGroup, sourceAge } from './work-context.js';
import { signalStamp } from './source-display.js';
import { threadHref } from './routes.js';

export function DecisionQueue({
  decisions,
  selectedId,
  onSelect,
  baseline = null,
  timezone,
}: {
  timezone: string | null;
  baseline?: VisitBaseline | null;
  decisions: SignalDecision[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = ['Blocking release', 'Evidence changed', 'Awaiting decision', 'Reviewed'];
  return (
    <div className="work-queue" aria-label="Decision queue" data-testid="decision-queue">
      {groups.map((group) => {
        const items = decisions.filter((d) => decisionGroup(d) === group);
        if (!items.length) return null;
        return (
          <section key={group}>
            <div className="work-queue-group">
              <h3>{group}</h3>
              <span>{items.length}</span>
            </div>
            {items.map((d) => (
              <button
                type="button"
                key={d.id}
                className={`work-queue-row ${d.id === selectedId ? 'selected' : ''}`}
                aria-pressed={d.id === selectedId}
                onClick={() => onSelect(d.id)}
              >
                {decisionVisitChange(d, baseline) && (
                  <span className="work-change-chip">
                    {decisionVisitChange(d, baseline) === 'new' ? 'New to you' : 'Changed since your visit'}
                  </span>
                )}
                <span className="work-row-title">{d.question}</span>
                <span className="work-row-meta">
                  <span>
                    {d.source_kind === 'release-item'
                      ? 'Release source'
                      : d.source_kind === 'approval'
                        ? 'Approval'
                        : 'Agent question'}
                  </span>
                  <time title={signalStamp(d.source_as_of, timezone)}>{sourceAge(d.source_as_of)}</time>
                </span>
                <span className="work-row-owner">
                  {d.owner ? `${d.owner.name} reviewing` : 'Unclaimed'}
                  {d.state === 'answered'
                    ? ` · ${d.dispatch_state === 'sent' ? 'Instruction sent' : 'Recorded only'}`
                    : ''}
                </span>
              </button>
            ))}
          </section>
        );
      })}
      {!decisions.length && <p className="signal-empty">No decisions match this view.</p>}
    </div>
  );
}

function ClaimedWork({ agent }: { agent: SignalAgent }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [focused, setFocused] = useState<string | null>(null);
  const order = { live: 0, expiring: 1, stale: 2, parked: 3 };
  const claims = [...(agent.claims ?? [])].sort(
    (a, b) =>
      order[agent.claim_details?.find((d) => d.slug === a)?.state ?? 'parked'] -
      order[agent.claim_details?.find((d) => d.slug === b)?.state ?? 'parked'],
  );
  const note = (slug: string) => agent.claim_details?.find((detail) => detail.slug === slug);
  const filtered = claims.filter((slug) =>
    `${slug} ${note(slug)?.note ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const detail = focused ? note(focused) : null;
  return (
    <section>
      <h3>Reported work</h3>
      {claims.slice(0, 3).map((slug) => (
        <p className="work-assignment" key={slug}>
          <small>Source claim{note(slug) ? ` · ${note(slug)!.state}` : ''} · completion unverified</small>
          {note(slug)?.note || slug}
          {note(slug)?.note && <small>{slug}</small>}
        </p>
      ))}
      {!claims.length && <p className="work-missing">No active claims reported.</p>}
      {!!claims.length && (
        <details>
          <summary>Inspect all {claims.length} claimed work identifiers</summary>
          <label className="signal-field">
            Find claimed work
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(5);
              }}
            />
          </label>
          {filtered.slice(0, limit).map((slug) => (
            <button
              className="work-context-row"
              key={slug}
              onClick={() => setFocused(slug)}
              aria-pressed={focused === slug}
            >
              {note(slug)?.note || slug}
            </button>
          ))}
          {filtered.length > limit && <button onClick={() => setLimit(limit + 5)}>Show 5 more</button>}
          {!filtered.length && <p>No matching claims.</p>}
          {focused && (
            <article className="work-claim-detail">
              <h4>{focused}</h4>
              <p>{detail?.note ?? 'No descriptive source note supplied.'}</p>
              {detail && (
                <p>
                  Source claim state: {detail.state}
                  {detail.escalated ? ' · Escalated' : ''}
                </p>
              )}
              {detail?.thread_id && <a href={threadHref(detail.thread_id)}>Inspect linked work →</a>}
              {detail?.source_url && (
                <a href={detail.source_url} target="_blank" rel="noreferrer">
                  Original claim source ↗
                </a>
              )}
            </article>
          )}
        </details>
      )}
    </section>
  );
}

export function AgentWorkspace({
  agents,
  decisions,
  selectedId,
  timezone,
}: {
  agents: SignalAgent[];
  decisions: SignalDecision[];
  selectedId: string | null;
  timezone: string | null;
}) {
  const selected = selectedId ? agents.find((a) => a.id === selectedId) : agents[0];
  const related = selected ? agentDecisions(selected, decisions) : [];
  return (
    <div className="work-split">
      <section className="work-selector" aria-label="Agent assignments">
        <div className="work-section-heading">
          <h2>Agents</h2>
          <span>{agents.length}</span>
        </div>
        {agents.map((a) => {
          const work = agentDecisions(a, decisions);
          return (
            <a
              className={`work-agent-row ${a.id === selected?.id ? 'selected' : ''}`}
              aria-current={a.id === selected?.id ? 'true' : undefined}
              key={a.id}
              href={`#/agents/${encodeURIComponent(a.id)}`}
            >
              <strong>{a.name}</strong>
              <span>{a.active ? 'Working' : a.awake ? 'Awake' : 'Not awake'}</span>
              <small>
                {a.claims?.length ?? 0} claims · {work.filter((d) => d.state !== 'answered').length} decisions
              </small>
            </a>
          );
        })}
      </section>
      <section className="work-canvas" aria-label="Agent work" data-testid="agent-work">
        {selected ? (
          <>
            <h2>{selected.name}</h2>
            <p className="work-subtitle">
              {selected.provider} ·{' '}
              {selected.active
                ? 'Currently working'
                : selected.awake
                  ? 'Awake; no active work reported'
                  : 'Not currently awake'}
            </p>
            <div className="work-context-grid">
              <ClaimedWork key={selected.id} agent={selected} />
              <section>
                <h3>Next scheduled work</h3>
                <p>{selected.next_task?.title ?? 'No scheduled work reported.'}</p>
                {selected.next_task && <small>{signalStamp(selected.next_task.at, timezone)}</small>}
              </section>
            </div>
            <h3 className="work-section-label">Blockers & decisions</h3>
            {related
              .filter((d) => d.state !== 'answered')
              .map((d) => (
                <a className="work-context-row" key={d.id} href={`#/decisions/${encodeURIComponent(d.id)}`}>
                  <span className="signal-amber">{decisionGroup(d)}</span>
                  <strong>{d.question}</strong>
                  <span>Inspect decision →</span>
                </a>
              ))}
            {!related.some((d) => d.state !== 'answered') && (
              <p className="work-missing">
                No open decisions are explicitly linked to this agent. Unlinked work may exist.
              </p>
            )}
            <h3 className="work-section-label">Recorded decisions</h3>
            {related
              .filter((d) => d.state === 'answered')
              .map((d) => (
                <article className="work-context-row" key={d.id}>
                  <strong>{d.question}</strong>
                  <p>{d.answer}</p>
                  <small>
                    {d.dispatch_state === 'sent'
                      ? 'Instruction delivered; completion not verified'
                      : 'Decision recorded; no confirmed delivery'}
                  </small>
                </article>
              ))}
            {!related.some((d) => d.state === 'answered') && (
              <p className="work-missing">No recorded decisions explicitly linked.</p>
            )}
            <details className="work-evidence">
              <summary>Conversation evidence · {selected.thread_ids.length} linked threads</summary>
              {selected.thread_ids.map((id, i) => (
                <a key={id} href={threadHref(id)}>
                  Inspect conversation {i + 1} ↗
                </a>
              ))}
            </details>
            <p className="work-footnote">
              Last observed {signalStamp(selected.last_seen_at, timezone)}
              {selected.current_tool ? ` · Using ${selected.current_tool}` : ''}
            </p>
          </>
        ) : (
          <p className="signal-empty">Select an agent to inspect its reported work.</p>
        )}
      </section>
    </div>
  );
}

export type PendingInstructions = Map<string, { text: string; recipient: string; key: string }>;

export function ThreadWorkspace({
  authMe,
  workgroup,
  query,
  id,
  overview,
  pendingInstructions,
}: {
  authMe: AuthMe;
  workgroup: string;
  query: string;
  id: string | null;
  overview: SignalOverview | undefined;
  pendingInstructions?: PendingInstructions;
}) {
  const [full, setFull] = useState(false);
  const {
    data: list,
    error: listError,
    mutate: refreshList,
  } = useSWR(['work-threads', workgroup], () => listThreads(workgroup === 'all' ? {} : { workgroup }), {
    refreshInterval: 30000,
  });
  const visible =
    list?.threads.filter((t) => [t.title, t.channel_name].join(' ').toLowerCase().includes(query.toLowerCase())) ?? [];
  const selectedId = id ?? visible[0]?.thread_id ?? null;
  const { data, error, mutate } = useSWR(
    selectedId ? ['work-thread', selectedId] : null,
    () => getThreadDetail(selectedId!),
    { refreshInterval: 30000 },
  );
  const { data: context, error: contextError, mutate: refreshContext } = useSWR(
    selectedId ? ['work-thread-context', authMe.user_id, workgroup, selectedId] : null,
    () => getSignalThreadContext(selectedId!, workgroup),
    { refreshInterval: 30000 },
  );
  const [tab, setTab] = useState<'context' | 'conversation'>('context');
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [sent, setSent] = useState('');
  const scopeKey = JSON.stringify([authMe.user_id, selectedId]);
  const activeScope = useRef<string | null>(scopeKey);
  activeScope.current = scopeKey;
  const localAttempts = useRef<PendingInstructions>(new Map());
  const attempts = { current: pendingInstructions ?? localAttempts.current };
  useEffect(() => {
    activeScope.current = scopeKey;
    return () => {
      activeScope.current = null;
    };
  }, [scopeKey]);
  const attempt = attempts.current.get(scopeKey);
  useEffect(() => {
    setBusy(false);
    setTab('context');
    const pending = attempts.current.get(scopeKey);
    setRecipient(pending?.recipient ?? '');
    setText(pending?.text ?? '');
    setFailure('');
    setSent('');
    setFull(false);
  }, [scopeKey]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void mutate();
          void refreshList();
          void refreshContext();
        }, 400);
    };
    const off = (['connection', 'session_event', 'inbound_message'] as const).map((kind) => subscribe(kind, refresh));
    return () => {
      off.forEach((fn) => fn());
      clearTimeout(timer);
    };
  }, [mutate, refreshList, refreshContext]);
  const thread = data?.thread;
  const hasConversation = (thread?.session_ids.length ?? 0) > 0;
  const contextUnavailable = context?.sources.some(
    (source) => source.source === 'threads' && source.status === 'unavailable',
  );
  // A healthy exact response is authoritative, including an empty mapping.
  // Preserve already-loaded context while the exact source is unavailable.
  const workContext = context && !contextUnavailable ? context : overview ?? context;
  const related =
    workContext?.decisions.filter((d) => d.thread_id === selectedId || d.dispatch_target_thread_id === selectedId) ?? [];
  const project = workContext?.projects.find((p) => p.thread_ids.includes(selectedId ?? ''));
  const contextStatus = contextError
    ? 'Exact work context could not be loaded.'
    : !context
      ? 'Loading exact work context…'
      : contextUnavailable
        ? 'Exact thread source is unavailable; project and decision coverage may be incomplete.'
        : null;
  const maySend = authMe.scopes.role !== 'member';
  async function send() {
    if (!thread || !recipient || !text.trim()) return;
    setBusy(true);
    setFailure('');
    setSent('');
    // A retry keeps the same immutable payload and delivery key, but gets a new
    // object identity. Older requests can then no longer settle the newer one.
    const sending = { ...(attempts.current.get(scopeKey) ?? { text, recipient, key: crypto.randomUUID() }) };
    attempts.current.set(scopeKey, sending);
    try {
      const result = await postThreadMessage(thread.thread_id, {
        agent_group_id: sending.recipient,
        text: sending.text,
        idempotency_key: sending.key,
      });
      if (attempts.current.get(scopeKey) !== sending || activeScope.current !== scopeKey) return;
      attempts.current.delete(scopeKey);
      setSent(
        `Instruction accepted for ${thread.participants.find((p) => p.agent_group_id === recipient)?.name ?? thread.assignable_agents.find((a) => a.agent_group_id === recipient)?.name ?? 'selected agent'}. Delivery echo: ${result.echo_status}. Work completion is not yet verified.`,
      );
      setText('');
      setBusy(false);
      void mutate();
    } catch (err) {
      if (activeScope.current === scopeKey && attempts.current.get(scopeKey) === sending) {
        const rejection = err as Partial<ApiError> | null;
        // These validations run before sendThreadMessage can reserve or write anything.
        // An uncertain transport/server failure must keep its immutable retry payload.
        if (rejection?.status === 400 && ['invalid_request', 'empty_message', 'message_too_long'].includes(rejection.error ?? ''))
          attempts.current.delete(scopeKey);
        setFailure(actionError(err));
        setBusy(false);
      }
    }
  }
  if (full)
    return (
      <div className="work-full-conversation" data-testid="full-conversation">
        <button onClick={() => setFull(false)}>← Back to work detail</button>
        <ThreadConsole authMe={authMe} externalWorkgroup={workgroup} externalQuery={query} deepLinkId={selectedId} />
      </div>
    );
  return (
    <div className="work-thread-surface">
      <div className="work-surface-title">
        <button onClick={() => setFull(true)}>Full conversation ↗</button>
      </div>
      {listError && (
        <p role="alert" className="signal-alert">
          The conversation list could not load. Direct links still open their exact source.
        </p>
      )}
      <div className="work-split">
        <section className="work-selector" aria-label="Work conversations">
          <p className="work-footnote">
            {list?.threads.length ?? 0} available conversations · recent 7-day window and scheduled work
          </p>
          <div className="work-section-heading">
            <h2>Recent work</h2>
            <span>{visible.length}</span>
          </div>
          {visible.map((t) => (
            <a
              className={`work-agent-row ${t.thread_id === selectedId ? 'selected' : ''}`}
              key={t.thread_id}
              href={threadHref(t.thread_id)}
            >
              <strong>{t.title ?? t.channel_name}</strong>
              <small>
                {t.state.replaceAll('_', ' ')} · {sourceAge(t.last_activity_at)}
              </small>
            </a>
          ))}
          {!visible.length && (
            <p className="work-missing">{list ? 'No matching conversations.' : 'Loading conversations…'}</p>
          )}
        </section>
        <section className="work-canvas" aria-label="Work detail" data-testid="work-brief">
          {error ? (
            <p role="alert">
              Could not load this exact work record. <button onClick={() => void mutate()}>Retry</button>
            </p>
          ) : !thread ? (
            <p role="status">{selectedId ? 'Loading work context…' : 'Select a conversation to inspect its work.'}</p>
          ) : (
            <>
              <div className="work-breadcrumb">
                {thread.channel_name} / {thread.state.replaceAll('_', ' ')}
              </div>
              <h2>{thread.title ?? 'Untitled conversation'}</h2>
              <div className="work-tabs" role="tablist" aria-label="Work detail views">
                <button role="tab" aria-selected={tab === 'context'} onClick={() => setTab('context')}>
                  Work context
                </button>
                <button role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}>
                  Recent conversation
                </button>
              </div>
              {tab === 'context' ? (
                <div role="tabpanel">
                  <div className="work-context-grid">
                    <section>
                      <h3>Objective</h3>
                      <p>{project?.description || contextStatus || 'No explicit project objective is mapped to this conversation.'}</p>
                      {project && <small>{project.name}</small>}
                    </section>
                    <section>
                      <h3>Current state</h3>
                      <p>{thread.state.replaceAll('_', ' ')}</p>
                      <small>
                        {thread.current_tool ? `Using ${thread.current_tool}` : `Container ${thread.container_status}`}
                      </small>
                    </section>
                  </div>
                  <section className="work-current-question">
                    <h3>What needs attention</h3>
                    <p>
                      {thread.needs_you_reason?.text ||
                        'No explicit question or blocker is reported for this conversation.'}
                    </p>
                  </section>
                  {thread.done_proposal && (
                    <section className="work-current-question">
                      <h3>Agent-reported outcome</h3>
                      <p>{thread.done_proposal.reason}</p>
                      <small>Reported by the agent; completion has not been independently verified.</small>
                    </section>
                  )}
                  <h3 className="work-section-label">Related decisions</h3>
                  {related.map((d) => (
                    <a className="work-context-row" key={d.id} href={`#/decisions/${encodeURIComponent(d.id)}`}>
                      <span>{decisionGroup(d)}</span>
                      <strong>{d.question}</strong>
                    </a>
                  ))}
                  {!related.length && (
                    <p className="work-missing">{contextStatus || 'No decision explicitly references this conversation.'}</p>
                  )}
                  <details className="work-evidence">
                    <summary>Source evidence & participants</summary>
                    <p>Last activity {signalStamp(thread.last_activity_at, overview?.timezone ?? null)}</p>
                    {thread.participants.map((p) => (
                      <p key={p.agent_group_id}>
                        {p.name} · {p.provider}
                      </p>
                    ))}
                    <code>{thread.thread_id}</code>
                  </details>
                </div>
              ) : (
                <div role="tabpanel" className="work-transcript">
                  {data.transcript.slice(-20).map((entry) => (
                    <article key={`${entry.session_id}:${entry.direction}:${entry.seq}`}>
                      <header>
                        <strong>{entry.author?.name ?? entry.agent_name}</strong>
                        <time>{signalStamp(entry.timestamp, overview?.timezone ?? null)}</time>
                      </header>
                      <p>{entry.text}</p>
                    </article>
                  ))}
                  {!data.transcript.length && <p>No conversation entries available.</p>}
                </div>
              )}
              {hasConversation ? (
                <>
                  <section className="work-composer">
                    <h3>Give the work direction</h3>
                    <p>Send one instruction to one named agent in this conversation.</p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send();
                      }}
                    >
                      <label className="signal-field">
                        Recipient
                        <select
                          required
                          aria-label="Work instruction recipient"
                          value={recipient}
                          onChange={(e) => setRecipient(e.target.value)}
                          disabled={busy || !!attempt || !maySend}
                        >
                          <option value="">Choose an agent</option>
                          {[
                            ...thread.participants,
                            ...thread.assignable_agents.filter(
                              (a) => !thread.participants.some((p) => p.agent_group_id === a.agent_group_id),
                            ),
                          ].map((a) => (
                            <option key={a.agent_group_id} value={a.agent_group_id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="signal-field">
                        Instruction
                        <textarea
                          aria-label="Work instruction"
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          disabled={busy || !!attempt || !maySend}
                          placeholder="Describe the next action and its constraints…"
                        />
                      </label>
                      <button className="signal-primary" disabled={busy || !maySend || !recipient || !text.trim()}>
                        {attempt ? 'Retry same instruction →' : 'Send instruction →'}
                      </button>
                    </form>
                    {attempt && !busy && (
                      <p role="status">Delivery is unresolved. Retry preserves the exact instruction and delivery key.</p>
                    )}
                    {!maySend && <p>Read-only access. An authorized reviewer can send instructions.</p>}
                    {failure && (
                      <p className="signal-alert" role="alert">
                        {failure}
                      </p>
                    )}
                    {sent && (
                      <p role="status" className="signal-notice">
                        {sent}
                      </p>
                    )}
                  </section>
                  <div className="work-secondary-actions">
                    <button
                      onClick={async () => {
                        try {
                          await setSnoozed(thread.thread_id, !thread.snoozed);
                          await mutate();
                        } catch (err) {
                          if (activeScope.current === scopeKey) setFailure(actionError(err));
                        }
                      }}
                    >
                      {thread.snoozed ? 'Unsnooze' : 'Snooze'}
                    </button>
                    <CloseThreadControl thread={thread} onClosed={() => void mutate()} />
                  </div>
                </>
              ) : (
                <section className="work-composer" role="status">
                  <h3>Source record has no conversation yet</h3>
                  <p>Open Full conversation to assign this source in its work context.</p>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
