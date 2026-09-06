import { createContext, useContext, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  ArrowUpRight,
  CircleDot,
  Layers,
  Diamond,
  Users,
  MessagesSquare,
  CalendarClock,
  Search,
  RefreshCw,
} from 'lucide-react';
import type { SignalProject, SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
import { listThreads, getThreadDetail, type AuthMe } from '../../lib/api.js';
import {
  getSignalOverview,
  getSignalDecision,
  reviewSignalDecision,
  dispatchSignalDecision,
  saveSignalProject,
  SignalApiError,
} from '../../lib/signal-api.js';
import { subscribe } from '../../lib/sse.ts';
import { DecisionQueue, AgentWorkspace, ThreadWorkspace, type PendingInstructions } from './WorkViews.js';
import { ThreadConsole } from '../console/ThreadConsole.js';
import { signalRoute, threadHref } from './routes.js';
import { readVisitBaseline, saveVisitBaseline, type VisitBaseline } from './visit-changes.js';
import { mergeSignalPages } from './paging.js';
import { signalStamp, resolveDependency } from './source-display.js';

const navigation = [
  { page: 'overview', label: 'Overview', icon: CircleDot },
  { page: 'projects', label: 'Projects', icon: Layers },
  { page: 'decisions', label: 'Decisions', icon: Diamond },
  { page: 'agents', label: 'Agents', icon: Users },
  { page: 'threads', label: 'Threads', icon: MessagesSquare },
  { page: 'schedule', label: 'Schedule', icon: CalendarClock },
] as const;
const TimezoneContext = createContext<string | null>(null);
const ProjectsContext = createContext<SignalProject[]>([]);
function useStamp() {
  const timezone = useContext(TimezoneContext);
  return (value: string | null) => signalStamp(value, timezone);
}
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed. Please retry.');
export function SignalApp({ authMe }: { authMe: AuthMe }) {
  const [route, setRoute] = useState(() => signalRoute(location.hash));
  const [workgroup, setWorkgroup] = useState('all');
  const pendingInstructions = useRef<PendingInstructions>(new Map());
  useEffect(() => {
    if (!route.id || window.innerWidth > 850) return;
    const timer = window.setTimeout(() => {
      document
        .querySelector('.signal-decision, [data-testid="agent-work"], [data-testid="work-brief"]')
        ?.scrollIntoView?.({ block: 'start' });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [route.page, route.id]);

  const [query, setQuery] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<'all' | 'open' | 'mine' | 'unclaimed' | 'recorded' | 'release'>(
    'all',
  );
  const visitBaselines = useRef(new Map<string, VisitBaseline | null>());
  const visitKey = `${authMe.user_id}:${workgroup}`;
  if (!visitBaselines.current.has(visitKey))
    visitBaselines.current.set(visitKey, readVisitBaseline(localStorage, authMe.user_id, workgroup));
  const baseline = visitBaselines.current.get(visitKey) ?? null;
  const [connection, setConnection] = useState('Connecting');
  const search = useRef<HTMLInputElement>(null);
  const {
    data: firstPage,
    error,
    mutate,
    isValidating,
  } = useSWR(
    ['signal', workgroup],
    () =>
      getSignalOverview(workgroup).then((result) => {
        setExtraPages(null);
        return result;
      }),
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
      dedupingInterval: 1000,
    },
  );
  const [extraPages, setExtraPages] = useState<{ base: SignalOverview; pages: SignalOverview[] } | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const currentBase = useRef(firstPage);
  currentBase.current = firstPage;
  const data =
    firstPage && extraPages?.base === firstPage ? extraPages.pages.reduce(mergeSignalPages, firstPage) : firstPage;
  async function loadPage(group: string, offset: number) {
    if (!firstPage || pageLoading) return;
    const base = firstPage;
    setPageLoading(true);
    setPageError('');
    try {
      const page = await getSignalOverview(group, offset);
      if (currentBase.current === base)
        setExtraPages((previous) => ({ base, pages: [...(previous?.base === base ? previous.pages : []), page] }));
    } catch (failure) {
      setPageError(message(failure));
    } finally {
      setPageLoading(false);
    }
  }
  useEffect(() => {
    if (data) saveVisitBaseline(localStorage, authMe.user_id, workgroup, data.decisions);
  }, [data, authMe.user_id, workgroup]);
  const timezone = data?.timezone ?? null;
  const stamp = (value: string | null) => signalStamp(value, timezone);
  useEffect(() => {
    const update = () => setRoute(signalRoute(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void mutate();
      }, 400);
    };
    const off = ['session_event', 'task_event', 'inbound_message'].map((kind) =>
      subscribe(kind as 'session_event', refresh),
    );
    off.push(
      subscribe<{ connected: boolean }>('connection', (event) => {
        setConnection(event.connected ? 'Connected' : 'Disconnected');
        if (event.connected) refresh();
      }),
    );
    return () => {
      off.forEach((fn) => fn());
      clearTimeout(timer);
    };
  }, [mutate]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const needle = query.toLowerCase().trim();
  const matches = (...parts: (string | null)[]) => !needle || parts.join(' ').toLowerCase().includes(needle);
  const projects =
    data?.projects
      .filter((p) => matches(p.name, p.description, ...p.repositories, ...p.items.map((i) => i.title)))
      .sort((a, b) => Number(a.unmapped) - Number(b.unmapped)) ?? [];
  const decisions =
    data?.decisions
      .filter(
        (d) =>
          matches(d.question, d.context, d.owner?.name ?? null, d.owner_hint) &&
          ((route.page !== 'decisions' && route.page !== 'overview') ||
            decisionFilter === 'all' ||
            (decisionFilter === 'release' && d.blocks_release && d.state !== 'answered') ||
            (decisionFilter === 'open' && d.state !== 'answered') ||
            (decisionFilter === 'mine' && d.owner?.id === authMe.user_id) ||
            (decisionFilter === 'unclaimed' && !d.owner && d.state !== 'answered') ||
            (decisionFilter === 'recorded' && d.state === 'answered')),
      )
      .sort(
        (a, b) =>
          Number(a.state === 'answered') - Number(b.state === 'answered') ||
          Number(b.blocks_release) - Number(a.blocks_release) ||
          Number(b.state === 'changed') - Number(a.state === 'changed') ||
          (b.source_as_of ?? '').localeCompare(a.source_as_of ?? ''),
      ) ?? [];
  const releaseWorkspace = data?.workgroups.find((w) => w.id === import.meta.env.VITE_SATURDAY_RELEASE_WORKGROUP);
  const releaseCalls =
    data?.decisions.filter(
      (d) => d.workgroup_id === releaseWorkspace?.id && d.blocks_release && d.state !== 'answered',
    ) ?? [];
  const selected = route.id
    ? decisions.find((d) => d.id === route.id)
    : (decisions.find((d) => d.state !== 'answered') ?? decisions[0]);
  const label = navigation.find((n) => n.page === route.page)!.label;
  const operational = route.page === 'schedule';
  const unavailable = data?.sources.filter((s) => s.status !== 'available') ?? [];
  return (
    <TimezoneContext.Provider value={timezone}>
      <ProjectsContext.Provider value={data?.projects ?? []}>
        <div className="signal-shell">
          <aside className="signal-rail">
            <a className="signal-brand" href="#/overview">
              <svg viewBox="0 0 28 28" aria-hidden="true">
                <path d="M23 15a10 10 0 1 1-10-11" />
                <circle cx="14" cy="14" r="4" />
                <circle className="point" cx="22" cy="5" r="3" />
              </svg>
              Observatory
            </a>
            <label className="signal-workspace">
              <span>Workspace</span>
              <select
                value={workgroup}
                onChange={(e) => {
                  setWorkgroup(e.target.value);
                  location.hash = `#/${route.page}`;
                }}
                aria-label="Workspace"
              >
                <option value="all">All workspaces</option>
                {data?.workgroups.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <nav aria-label="Observatory">
              {navigation.map(({ page, label: title, icon: Icon }) => (
                <a key={page} href={`#/${page}`} aria-current={route.page === page ? 'page' : undefined}>
                  <Icon size={16} />
                  <span>{title}</span>
                  {page === 'decisions' && data && (
                    <small>{data.decisions.filter((d) => d.state !== 'answered').length}</small>
                  )}
                </a>
              ))}
            </nav>
            <div className="signal-rail-projects">
              <div className="signal-overline">Projects</div>
              {data?.projects
                .filter((p) => !p.unmapped)
                .slice(0, 6)
                .map((p) => (
                  <a key={p.id} href="#/projects" onClick={() => setQuery(p.name)}>
                    {p.name}
                  </a>
                ))}
            </div>
            <div className="signal-person">
              <span>Signed in</span>
              <small>{authMe.scopes.role} · Shared workspace</small>
            </div>
          </aside>
          <main className="signal-main">
            <header className="signal-top">
              <span>
                {data?.workgroups.find((w) => w.id === workgroup)?.name ?? 'All workspaces'}{' '}
                <span className="signal-divider">/</span> <b>{label}</b>
              </span>
              <label className="signal-search">
                <Search size={14} />
                <input
                  ref={search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search work"
                  aria-label="Search work"
                />
                <kbd>⌘ K</kbd>
              </label>
            </header>
            {operational ? (
              <div className="signal-operations">
                <ThreadConsole
                  authMe={authMe}
                  externalWorkgroup={workgroup}
                  onWorkgroupChange={setWorkgroup}
                  externalQuery={query}
                  deepLinkId={route.page === 'threads' ? route.id : null}
                />
              </div>
            ) : (
              <div className={`signal-content ${route.id ? 'work-explicit-detail' : ''}`}>
                {route.id && (
                  <a className="work-back-list" href={`#/${route.page}`}>
                    ← Back to {label.toLowerCase()}
                  </a>
                )}
                <div className="signal-title">
                  <div>
                    {route.page !== 'agents' && route.page !== 'threads' && (
                      <div className="signal-overline">Signal / {label}</div>
                    )}
                    <h1>
                      {route.page === 'overview'
                        ? 'Decide what moves next.'
                        : label === 'Decisions'
                          ? 'Give the work direction.'
                          : label === 'Projects'
                            ? 'Where the work stands.'
                            : route.page === 'threads'
                              ? 'Work in context.'
                              : 'The people behind the work.'}
                    </h1>
                  </div>
                  <button className="signal-refresh" onClick={() => void mutate()} aria-label="Refresh records">
                    <RefreshCw size={14} className={isValidating ? 'signal-spinning' : ''} /> Refresh
                  </button>
                </div>
                <p className="signal-brief">
                  {data ? (
                    <>
                      {data.projects.filter((p) => !p.unmapped).length} mapped projects.{' '}
                      {data.agents.filter((a) => a.active).length}{' '}
                      {data.agents.filter((a) => a.active).length === 1 ? 'agent' : 'agents'} working.{' '}
                      <em>{data.decisions.filter((d) => d.state !== 'answered').length} decisions awaiting review.</em>
                    </>
                  ) : (
                    'Reading workspace records and source evidence.'
                  )}
                </p>
                {releaseWorkspace && (route.page === 'overview' || route.page === 'decisions') && (
                  <section className="work-release-focus" aria-label="Saturday release">
                    <div>
                      <strong>{releaseWorkspace.name} · Saturday release</strong>
                      <p>
                        <code>develop → main</code> · {releaseCalls.length} source-reported human{' '}
                        {releaseCalls.length === 1 ? 'call' : 'calls'} blocking promotion
                      </p>
                      <small>Standing weekly cadence. Source flags are not a fresh release-readiness check.</small>
                    </div>
                    {releaseCalls.length > 0 && (
                      <button
                        onClick={() => {
                          setQuery('');
                          setWorkgroup(releaseWorkspace.id);
                          setDecisionFilter('release');
                          location.hash = `#/decisions/${encodeURIComponent(releaseCalls[0]!.id)}`;
                        }}
                      >
                        Review release blockers →
                      </button>
                    )}
                  </section>
                )}
                {data?.thread_coverage?.some((c) => c.has_more) && (
                  <details className="work-coverage">
                    <summary>Historical coverage is partial</summary>
                    <p>
                      Historical thread coverage is incomplete. Counts and search cover loaded pages; use Load more
                      below to inspect older work.
                    </p>
                  </details>
                )}
                {connection === 'Disconnected' && (
                  <div className="signal-alert" role="status">
                    Live connection interrupted. Records refresh every 30 seconds; reconnecting.
                  </div>
                )}
                {error && (
                  <div className="signal-alert" role="alert">
                    {data
                      ? 'Refresh failed. Showing the last received records. '
                      : 'Could not load workspace records. '}
                    {message(error)} <button onClick={() => void mutate()}>Retry</button>
                  </div>
                )}
                {!data && !error && (
                  <div className="signal-empty" role="status">
                    Loading project records and decisions…
                  </div>
                )}
                {!!unavailable.length && (
                  <details className="work-source-health">
                    <summary>{unavailable.length} sources stale or unavailable — coverage is partial</summary>
                    {unavailable.map((s, i) => (
                      <p key={i}>
                        {s.workgroup_id} / {s.source}: {s.status}. {s.detail} · {stamp(s.as_of)}
                      </p>
                    ))}
                  </details>
                )}
                {data && (
                  <>
                    {(route.page === 'overview' || route.page === 'projects' || route.page === 'decisions') && (
                      <div
                        className={`signal-area ${route.page === 'projects' ? 'signal-projects-only' : 'work-decision-workspace'}`}
                      >
                        <section className="signal-projects">
                          {route.page !== 'projects' ? (
                            <>
                              <div className="signal-section-head">
                                <h2>Decision queue</h2>
                                <span>{decisions.length} records</span>
                              </div>
                              <div className="signal-decision-filters" aria-label="Filter decisions">
                                {(
                                  [
                                    ['all', 'All'],
                                    ['open', 'Open'],
                                    ['release', 'Release blockers'],
                                    ['mine', 'My reviews'],
                                    ['unclaimed', 'Unclaimed'],
                                    ['recorded', 'Recorded'],
                                  ] as const
                                ).map(([value, title]) => (
                                  <button
                                    key={value}
                                    aria-pressed={decisionFilter === value}
                                    onClick={() => setDecisionFilter(value)}
                                  >
                                    {title}
                                  </button>
                                ))}
                              </div>
                              <DecisionQueue
                                baseline={baseline}
                                decisions={decisions}
                                selectedId={selected?.id ?? null}
                                onSelect={(id) => {
                                  location.hash = `#/decisions/${encodeURIComponent(id)}`;
                                }}
                              />
                              {!decisions.length && (
                                <p className="signal-empty">
                                  No decisions match this view. Source availability is shown above.
                                </p>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="signal-section-head">
                                <h2>Where the work stands</h2>
                                <span>Goal → next step</span>
                              </div>
                              {projects.map((p) => (
                                <Project
                                  key={p.id}
                                  project={p}
                                  canEdit={data.capabilities.manage_projects}
                                  refresh={() => void mutate()}
                                />
                              ))}
                              {!projects.length && <p className="signal-empty">No projects match this view.</p>}
                              {route.page === 'projects' && data.capabilities.manage_projects && (
                                <ProjectForm workgroups={data.workgroups} refresh={() => void mutate()} />
                              )}
                            </>
                          )}
                        </section>
                        {route.page !== 'projects' &&
                          (route.id || selected ? (
                            <DecisionPane
                              key={route.id ?? selected!.id}
                              id={route.id ?? selected!.id}
                              authMe={authMe}
                              refresh={() => void mutate()}
                            />
                          ) : (
                            <aside className="signal-decision">
                              <span className="signal-overline">Decision context</span>
                              <h2>No decision selected.</h2>
                              <p>New source questions will appear here. Missing sources remain visible above.</p>
                            </aside>
                          ))}
                      </div>
                    )}
                    {route.page === 'agents' && (
                      <AgentWorkspace
                        agents={data.agents.filter((a) => matches(a.name, a.provider, ...(a.claims ?? [])))}
                        decisions={data.decisions}
                        selectedId={route.id}
                        timezone={timezone}
                      />
                    )}
                    {route.page === 'threads' && (
                      <ThreadWorkspace
                        pendingInstructions={pendingInstructions.current}
                        authMe={authMe}
                        workgroup={workgroup}
                        query={query}
                        id={route.id}
                        overview={data}
                      />
                    )}
                    {!!data.thread_coverage?.some((c) => c.has_more) && (
                      <section className="signal-page-coverage" aria-label="Thread coverage">
                        <h2>More historical work is available</h2>
                        <p>
                          Counts and search include loaded thread pages. Release-source items are complete. Refresh
                          returns to the first page.
                        </p>
                        {data.thread_coverage
                          .filter((c) => c.has_more && c.next_offset !== null)
                          .map((c) => (
                            <button
                              key={c.workgroup_id}
                              disabled={pageLoading}
                              onClick={() => void loadPage(c.workgroup_id, c.next_offset!)}
                            >
                              Load more threads ·{' '}
                              {data.workgroups.find((w) => w.id === c.workgroup_id)?.name ?? c.workgroup_id}
                            </button>
                          ))}
                      </section>
                    )}
                    {pageError && (
                      <p className="signal-alert" role="alert">
                        Could not load more threads: {pageError}. Loaded records are retained; retry using Load more.
                      </p>
                    )}
                    <footer className="signal-footer">
                      <span>{connection} · File sources checked every 30s</span>
                      <span>
                        Records received {stamp(data.as_of)} · {timezone ?? 'timezone unavailable'}
                      </span>
                    </footer>
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      </ProjectsContext.Provider>
    </TimezoneContext.Provider>
  );
}

function Project({ project: p, canEdit, refresh }: { project: SignalProject; canEdit: boolean; refresh: () => void }) {
  const stamp = useStamp();
  const allProjects = useContext(ProjectsContext);
  const [edit, setEdit] = useState(false);
  if (p.unmapped)
    return (
      <article className="signal-unmapped">
        <details>
          <summary>
            <strong>{p.workgroup_id}</strong> — {p.thread_ids.length} unmapped threads · {p.items.length} source items
          </summary>
          <p>These records have no declared project mapping.</p>
          {p.items.map((item) => (
            <div className="signal-source-item" key={item.id}>
              <strong>{item.title}</strong>
              <p>{item.next_action ?? 'No next action declared.'}</p>
              {item.source_url && <SafeLink href={item.source_url}>Open source ↗</SafeLink>}
            </div>
          ))}
          {p.thread_ids.map((id, i) => (
            <a className="signal-block-link" key={id} href={threadHref(id)}>
              Inspect thread {i + 1} ↗
            </a>
          ))}
        </details>
      </article>
    );
  return (
    <article className="signal-lane">
      <div className="signal-lane-heading">
        <h3>{p.name}</h3>
        <span className={p.unmapped ? 'signal-amber' : 'signal-meta'}>
          {p.unmapped ? 'Mapping needed' : `${p.decision_ids.length} decisions`}
        </span>
      </div>
      <div className="signal-flow">
        <div>
          <span className="signal-meta">Project goal</span>
          <p>{p.description || 'Goal not declared.'}</p>
          <small>{p.repositories.join(' · ') || 'Repository not mapped'}</small>
        </div>
        <span className="signal-arrow">⟶</span>
        <div>
          <span className="signal-meta">Next step</span>
          <p>
            {(() => {
              const action = p.items.find((i) => i.next_action)?.next_action ?? 'Next action not declared.';
              return action.length > 200 ? `${action.slice(0, 200)}…` : action;
            })()}
          </p>
          <small>{p.items.find((i) => i.owner_hint)?.owner_hint ?? 'Owner not declared'}</small>
        </div>
      </div>
      <div className="signal-relationship">
        {p.items.some((i) => i.depends_on?.length) ? (
          <>
            <span>↳ Declared dependencies</span>
            <ul>
              {[...new Set(p.items.flatMap((i) => i.depends_on ?? []))].map((id) => {
                const match = resolveDependency(allProjects, p.workgroup_id, id);
                return (
                  <li key={id}>
                    {match ? (
                      <>
                        {match.project.name} ·{' '}
                        {match.item.source_url ? (
                          <SafeLink href={match.item.source_url}>{match.item.title} ↗</SafeLink>
                        ) : (
                          <span>{match.item.title} — source link not supplied</span>
                        )}
                      </>
                    ) : (
                      <span>{id} — unresolved in visible source records</span>
                    )}
                  </li>
                );
              })}
            </ul>
            {p.items.some((i) => i.depends_on === null) && (
              <small>Other source items have undeclared dependencies.</small>
            )}
          </>
        ) : p.items.length && p.items.every((i) => i.depends_on !== null) ? (
          '↳ Source declares no dependencies.'
        ) : (
          '↳ Dependencies not declared — independence is unknown.'
        )}
      </div>
      <details>
        <summary>
          Inspect {p.items.length} source items · {p.thread_ids.length} threads
        </summary>
        {p.items.map((i) => (
          <div className="signal-source-item" key={i.id}>
            <strong>{i.title}</strong>
            <p>{i.next_action || 'No next action supplied'}</p>
            <small>
              {i.owner_hint ?? 'No owner'} · {stamp(i.as_of)}
            </small>
            {i.source_url && <SafeLink href={i.source_url}>Open source ↗</SafeLink>}
          </div>
        ))}
        {p.thread_ids.map((id, i) => (
          <a className="signal-block-link" key={id} href={threadHref(id)}>
            Open thread {i + 1} ↗
          </a>
        ))}
        <small>Mapping updated {stamp(p.updated_at)}</small>
      </details>
      {canEdit && !p.unmapped && (
        <button className="signal-text-button" onClick={() => setEdit(!edit)}>
          {edit ? 'Cancel edit' : 'Edit project mapping'}
        </button>
      )}
      {edit && (
        <ProjectForm
          project={p}
          workgroups={[{ id: p.workgroup_id, name: p.workgroup_id }]}
          refresh={() => {
            setEdit(false);
            refresh();
          }}
        />
      )}
    </article>
  );
}
export function DecisionPane({ id, authMe, refresh }: { id: string; authMe: AuthMe; refresh: () => void }) {
  const stamp = useStamp();
  const { data, error, mutate } = useSWR(['signal-decision', id], () => getSignalDecision(id), {
    refreshInterval: 30000,
    revalidateOnFocus: true,
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshDetail = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void mutate();
        }, 400);
    };
    const off = (['session_event', 'task_event', 'inbound_message', 'connection'] as const).map((kind) =>
      subscribe(kind, refreshDetail),
    );
    return () => {
      off.forEach((fn) => fn());
      clearTimeout(timer);
    };
  }, [mutate]);
  const [text, setText] = useState('');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const d = data?.decision;
  const [targetThread, setTargetThread] = useState('');
  const { data: targetThreads, error: targetsError } = useSWR(
    d?.answer && !d.thread_id && d.capabilities.dispatch ? ['signal-targets', d.workgroup_id] : null,
    () => listThreads({ workgroup: d!.workgroup_id }),
    { revalidateOnFocus: true },
  );
  const { data: targetDetail, error: targetError } = useSWR(
    targetThread ? ['signal-target-detail', targetThread] : null,
    () => getThreadDetail(targetThread),
  );
  const dispatchRecipient = d?.dispatch_agent_group_id ?? recipient;
  const dispatchTarget = d?.dispatch_target_thread_id ?? targetThread;
  const recipients = d?.thread_id
    ? (data?.recipients ?? [])
    : (targetDetail?.thread.participants.map((p) => ({ id: p.agent_group_id, name: p.name })) ?? []);
  async function act(action: 'claim' | 'release' | 'answer' | 'dispatch') {
    if (!d) return;
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      if (action === 'dispatch')
        await dispatchSignalDecision(id, {
          expected_version: d.version,
          evidence_hash: d.dispatch_evidence_hash ?? d.evidence_hash,
          agent_group_id: dispatchRecipient,
          ...(!d.thread_id ? { target_thread_id: dispatchTarget } : {}),
        });
      else {
        const fingerprint = JSON.stringify([action, d.version, d.evidence_hash, text]);
        if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
        await reviewSignalDecision(id, {
          expected_version: d.version,
          evidence_hash: d.evidence_hash,
          action,
          ...(action === 'answer' ? { text } : {}),
          idempotency_key: attempt.current.key,
        });
      }
      setNotice(
        action === 'answer'
          ? 'Decision recorded. No instruction has been sent.'
          : action === 'dispatch'
            ? 'Delivery request processed. See delivery state below.'
            : action === 'claim'
              ? 'You are reviewing this decision.'
              : 'Review ownership released.',
      );
      if (action === 'answer') setText('');
      await mutate();
      refresh();
    } catch (err) {
      await mutate();
      refresh();
      setFailure(
        err instanceof SignalApiError && err.status === 409
          ? 'This decision changed or another reviewer owns it. The latest record has been requested; review it before trying again.'
          : message(err),
      );
      if (err instanceof SignalApiError && err.status === 409) {
        await mutate();
        refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  const ownedElsewhere = !!d?.owner && d.owner.id !== authMe.user_id;
  return (
    <aside className="signal-decision" aria-label="Decision context">
      {!d ? (
        <p role={error ? 'alert' : 'status'}>
          {error ? `Could not load exact decision context: ${message(error)}` : 'Loading exact decision evidence…'}
          {error && <button onClick={() => void mutate()}>Retry</button>}
        </p>
      ) : (
        <>
          <div className="signal-decision-top">
            <span>
              ◇{' '}
              {d.source_kind === 'approval'
                ? 'Privileged approval'
                : d.state === 'changed'
                  ? 'Evidence changed · review again'
                  : d.state === 'answered'
                    ? 'Decision recorded'
                    : 'Decision needed'}
            </span>
            <span>v{d.version}</span>
          </div>
          <h2>{d.question.length > 260 ? `${d.question.slice(0, 260)}…` : d.question}</h2>
          {d.question.length > 260 && (
            <details>
              <summary>Read full question</summary>
              <p>{d.question}</p>
            </details>
          )}
          <p className="work-footnote">Source observed {stamp(d.source_as_of)}</p>
          {d.capabilities.answer && (
            <button
              className="signal-primary work-decision-jump"
              onClick={(event) => {
                const input = event.currentTarget
                  .closest('aside')
                  ?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your decision"]');
                input?.scrollIntoView({ block: 'center' });
                input?.focus({ preventScroll: true });
              }}
            >
              Write your decision ↓
            </button>
          )}
          <div className="signal-intro">
            <h3>Why this needs a decision</h3>
            {d.context ? (
              <SourceExcerpt text={d.context} limit={300} label="Read full source reason" />
            ) : (
              'The source did not provide a reason. Inspect the evidence before deciding.'
            )}
          </div>
          <div className="signal-ownership">
            <span>
              Source owner hint <strong>{d.owner_hint || 'Not declared'}</strong>
            </span>
            <span>
              Reviewing <strong>{d.owner?.name || 'Unclaimed'}</strong>
            </span>
          </div>
          <h3>Next action from source</h3>
          <div className="signal-recommendation">
            <SourceExcerpt
              text={d.next_action || 'No recommendation or next step supplied.'}
              limit={240}
              label="Read full source next step"
            />
          </div>
          <details className="signal-evidence-disclosure">
            <summary>Inspect source evidence · {data.evidence.length} records</summary>
            {data.evidence.length ? (
              <ul className="signal-evidence">
                {data.evidence.map((e, i) => (
                  <li key={i}>
                    <strong>{e.title}</strong>
                    <p>{e.text}</p>
                    <small>{stamp(e.at)}</small>
                    {e.url && <SafeLink href={e.url}>Open evidence ↗</SafeLink>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="signal-muted">No additional evidence supplied.</p>
            )}
          </details>
          <details>
            <summary>Source identity and review history</summary>
            <div className="signal-version">
              <span>Review applies to</span>
              <code>{d.evidence_hash.slice(0, 16)}</code>
            </div>

            <code>
              {d.source_kind} / {d.source_id}
            </code>
            <p>{stamp(d.source_as_of)}</p>
            {d.history.map((h, i) => (
              <p key={i}>
                {h.actor.name} · {h.action} · {stamp(h.at)}
                {h.note && <span className="signal-block-link">{h.note}</span>}
              </p>
            ))}
            {!d.history.length && <p>No previous review recorded.</p>}
          </details>
          <div className="signal-links">
            {d.source_url && (
              <SafeLink href={d.source_url}>
                Open original source <ArrowUpRight size={12} />
              </SafeLink>
            )}
            {d.thread_id && <a href={threadHref(d.thread_id)}>Inspect exact thread ↗</a>}
          </div>
          {error && (
            <p className="signal-alert" role="alert">
              Refresh failed. Actions paused until the current source can be read.
            </p>
          )}
          {d.source_kind === 'approval' ? (
            <p className="signal-alert">
              Resolve this approval at its original destination to preserve its authorization rules. Recording a chat
              reply does not approve it.
            </p>
          ) : (
            <>
              <div className="signal-actions">
                {!d.owner && d.capabilities.claim && (
                  <button disabled={busy || !!error} onClick={() => void act('claim')}>
                    Claim review
                  </button>
                )}
                {d.owner && (d.owner.id === authMe.user_id || authMe.scopes.no_filter) && d.capabilities.release && (
                  <button disabled={busy || !!error} onClick={() => void act('release')}>
                    Release review
                  </button>
                )}
              </div>
              {d.answer && (
                <div className="signal-recorded">
                  <h3>Recorded decision</h3>
                  <p>{d.answer}</p>
                  <small>
                    {d.answered_by?.name} · {stamp(d.answered_at)}
                  </small>
                </div>
              )}
              {d.capabilities.answer && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('answer');
                  }}
                >
                  <label className="signal-field">
                    Your decision
                    <textarea
                      aria-label="Your decision"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="Write the decision and relevant constraints…"
                      disabled={ownedElsewhere || busy || !!error}
                    />
                  </label>
                  <button className="signal-primary" disabled={!text.trim() || ownedElsewhere || busy || !!error}>
                    Record decision →
                  </button>
                  <p className="signal-action-note">Saves shared review history. Sending is a separate step.</p>
                </form>
              )}
              {ownedElsewhere && <p className="signal-muted">{d.owner?.name} owns this review.</p>}
              {d.answer && (
                <div className="signal-dispatch">
                  <h3>Instruction delivery</h3>
                  <p>
                    {d.dispatch_state === 'sent'
                      ? 'Instruction sent. Agent work is not yet verified complete.'
                      : d.dispatch_state === 'pending'
                        ? 'Delivery pending or uncertain. Retry checks the same instruction.'
                        : d.dispatch_state === 'failed'
                          ? `Delivery failed: ${d.dispatch_error ?? 'See source thread.'}`
                          : 'No instruction sent.'}
                  </p>
                  {d.capabilities.dispatch &&
                  (d.state === 'answered' || d.dispatch_state === 'pending' || d.dispatch_state === 'failed') &&
                  d.dispatch_state !== 'sent' ? (
                    <>
                      {!d.thread_id && !d.dispatch_target_thread_id && (
                        <label className="signal-field">
                          Existing destination thread
                          <select
                            aria-label="Destination thread"
                            value={targetThread}
                            onChange={(e) => {
                              setTargetThread(e.target.value);
                              setRecipient('');
                            }}
                          >
                            <option value="">Choose an existing thread</option>
                            {targetThreads?.threads
                              .filter((t) => !t.synthetic && t.participants.length)
                              .map((t) => (
                                <option key={t.thread_id} value={t.thread_id}>
                                  {t.channel_name} · {t.title ?? t.thread_id}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                      {(targetsError || targetError) && (
                        <p role="alert">Could not load destination context. Retry by reopening this decision.</p>
                      )}
                      <label className="signal-field">
                        Recipient
                        <select
                          disabled={!!d.dispatch_agent_group_id}
                          aria-label="Instruction recipient"
                          value={dispatchRecipient}
                          onChange={(e) => setRecipient(e.target.value)}
                        >
                          <option value="">Choose an agent</option>
                          {d.dispatch_agent_group_id && (
                            <option value={d.dispatch_agent_group_id}>
                              {d.dispatch_agent_group_id} · reserved recipient
                            </option>
                          )}
                          {recipients.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        disabled={!dispatchRecipient || busy || !!error || (!d.thread_id && !dispatchTarget)}
                        onClick={() => void act('dispatch')}
                      >
                        Send recorded instruction →
                      </button>
                    </>
                  ) : (
                    d.dispatch_state !== 'sent' && (
                      <p className="signal-muted">
                        No safe delivery path is available here. Inspect the original source.
                      </p>
                    )
                  )}
                </div>
              )}
            </>
          )}
          {failure && (
            <p className="signal-alert" role="alert">
              {failure}
            </p>
          )}
          {notice && (
            <p className="signal-notice" role="status">
              {notice}
            </p>
          )}
        </>
      )}
    </aside>
  );
}
function SourceExcerpt({ text, limit, label }: { text: string; limit: number; label: string }) {
  return (
    <>
      <p>{text.length > limit ? `${text.slice(0, limit)}…` : text}</p>
      {text.length > limit && (
        <details>
          <summary>{label}</summary>
          <p>{text}</p>
        </details>
      )}
    </>
  );
}
function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!/^(https?:\/\/|#\/|\/observatory\/)/i.test(href)) return <span>{children} (source link unavailable)</span>;
  return (
    <a href={href} {...(href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>
      {children}
    </a>
  );
}
function ProjectForm({
  project,
  workgroups,
  refresh,
}: {
  project?: SignalProject;
  workgroups: SignalOverview['workgroups'];
  refresh: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [goal, setGoal] = useState(project?.description ?? '');
  const [repo, setRepo] = useState(project?.repositories.join('\n') ?? '');
  const [channels, setChannels] = useState<string[]>(project?.channel_keys ?? []);
  const [group, setGroup] = useState(project?.workgroup_id ?? workgroups[0]?.id ?? '');
  const { data: channelThreads, error: channelsError } = useSWR(group ? ['signal-project-channels', group] : null, () =>
    listThreads({ workgroup: group }),
  );
  const channelOptions = [
    ...new Map(
      (channelThreads?.threads ?? []).filter((t) => !t.synthetic).map((t) => [t.channel_key, t.channel_name]),
    ).entries(),
  ];
  const hiddenCount = channels.filter((key) => !channelOptions.some(([id]) => id === key)).length;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="signal-project-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await saveSignalProject(project?.id ?? crypto.randomUUID(), {
            workgroup_id: group,
            name,
            description: goal,
            repositories: repo
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
            channel_keys: channels,
            expected_version: project?.version ?? 0,
          });
          refresh();
          if (!project) {
            setName('');
            setGoal('');
            setRepo('');
            setChannels([]);
          }
        } catch (err) {
          setError(message(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{project ? 'Edit project mapping' : 'Map a project'}</h3>
      <p>Choose the repositories and conversation channels that belong to this project.</p>
      <label className="signal-field">
        Workspace
        <select
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            setChannels([]);
          }}
          disabled={!!project}
        >
          {workgroups.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="signal-field">
        Project name
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="signal-field">
        Goal
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label className="signal-field">
        Repositories · owner/repository, one per line
        <textarea value={repo} onChange={(e) => setRepo(e.target.value)} />
      </label>
      <fieldset className="signal-channel-picker">
        <legend>Conversation channels</legend>
        {channelOptions.map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={channels.includes(key)}
              onChange={(e) =>
                setChannels((previous) => (e.target.checked ? [...previous, key] : previous.filter((id) => id !== key)))
              }
            />
            <span>{label}</span>
          </label>
        ))}
        {!channelOptions.length && (
          <p>
            {channelsError
              ? 'Channels could not be loaded. Existing mappings are preserved.'
              : channelThreads
                ? 'No visible conversation channels in this workspace.'
                : 'Loading channels…'}
          </p>
        )}
        {!!hiddenCount && (
          <p>{hiddenCount} existing channel mappings have no thread in this view and will be preserved.</p>
        )}
      </fieldset>
      <button className="signal-primary" disabled={busy || !name.trim() || !group}>
        Save project mapping
      </button>
      {error && (
        <p className="signal-alert" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
