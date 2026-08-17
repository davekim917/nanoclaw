import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getObservatory,
  listScheduled,
  type AuthMe,
  type ObservatorySnapshot,
  type ObservatoryRoom,
  type ObservatoryClaim,
  type ObservatoryClaimState,
  type ReleaseItem,
  type ReleaseNextMover,
  type ReleaseState,
  type ScheduledRow,
  type ScheduledSnapshot,
} from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import { type BoardRoute } from './BoardShell.js';
import { ScheduledDrawer } from './ScheduledDrawer.js';
import { buildLedger, classify, dueLabel, type Commitment } from './commitments.js';
import { assignItem } from '../lib/api.js';
import { OfficeMap } from './OfficeMap.js';
import { buildOfficeData } from './office-data.js';
import { WorkgroupPicker } from './WorkgroupDashboard.js';


/**
 * Observatory — the layer above Slack: one page that answers what is stuck,
 * what needs a person, and what is moving on its own, before any interaction.
 *
 * The page is FIXED at the top and switched at the bottom:
 *
 *   1. the headline — one dominant number (stalled), two secondary, and the
 *      coverage gaps that qualify them, stated once;
 *   2. the office — the vendored <office-map> custom element, a hand-authored
 *      tile plan where each channel is a room and each agent sits in the room
 *      it last worked in. Geometry is FIXED; only occupancy comes from data.
 *      Picking a room opens the room sheet and filters what is below;
 *   3. ONE content region, chosen by the segmented control in the top bar:
 *      overview (the needs-attention queue), job board, claims, schedule.
 *
 * The map is on every view on purpose — it is the product's identity, and the
 * thing the segments switch is what sits UNDER it. The segments are local
 * state, not routes: this page has one URL.
 *
 * Everything is the atrium light chrome (see styles.css): one card per section,
 * hairline dividers, sentence case, one accent used for interaction, muted
 * status colours used for nothing else, and monospace reserved for identifiers
 * and cron expressions.
 *
 * Polls GET /dashboard/api/observatory?workgroup=:id every 15s — this is a
 * slow-moving status board, not a live feed. Detail opens IN PLACE, never by
 * navigating away; anything with a URL still links out in a new tab.
 */

const POLL_MS = 15_000;

/** The segmented control. Local state — the Observatory has exactly one URL. */
const VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'board', label: 'Job board' },
  { key: 'claims', label: 'Claims' },
  { key: 'schedule', label: 'Schedule' },
] as const;

export type ObsView = (typeof VIEWS)[number]['key'];

interface ObservatoryProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

// Props are the shell's routing contract, kept so main.tsx and the legacy
// boards stay uniform. The Observatory itself no longer navigates: it is the
// only destination, and detail opens over the floor rather than away from it.
export function Observatory({ authMe }: ObservatoryProps) {
  const { data: wgData } = useSWR('/dashboard/api/workgroups', () => listWorkgroups(), { refreshInterval: 0 });
  const workgroups = wgData?.workgroups ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Remember the operator's office across visits — the first-workgroup default
  // put a viewer of a 13-room workgroup in a 1-room one with no way out.
  useEffect(() => {
    if (selectedId !== null || workgroups.length === 0) return;
    const remembered = localStorage.getItem('nc-obs-workgroup');
    const match = remembered && workgroups.find((w) => w.id === remembered);
    setSelectedId(match ? match.id : workgroups[0]!.id);
  }, [workgroups, selectedId]);

  const selectWorkgroup = (id: string) => {
    localStorage.setItem('nc-obs-workgroup', id);
    setSelectedId(id);
  };

  const {
    data: snapshot,
    error,
  } = useSWR<ObservatorySnapshot>(
    selectedId ? `/dashboard/api/observatory?workgroup=${selectedId}` : null,
    () => getObservatory(selectedId!),
    { refreshInterval: POLL_MS },
  );

  // Scheduled work is its own endpoint. It is read HERE rather than inside the
  // schedule card so the top bar can state the next fire on every view — the
  // card and the bar must never disagree about what is coming.
  const { data: schedData, error: schedError, mutate: schedMutate } = useSWR<ScheduledSnapshot>(
    '/dashboard/api/scheduled',
    () => listScheduled(),
    { refreshInterval: POLL_MS },
  );

  const [view, setView] = useState<ObsView>('overview');
  const [jobTab, setJobTab] = useState<JobTabKey>('queue');
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [flowFilter, setFlowFilter] = useState<FlowSlice | null>(null);
  const [teleportTo, setTeleportTo] = useState<string | null>(null);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);
  // The agent whose pin opened the sheet, emphasised in it so a click on a
  // person lands you on that person's row and not just in their room.
  const [focusAgent, setFocusAgent] = useState<string | null>(null);

  const rooms = useMemo(() => sortRooms(snapshot?.rooms ?? []), [snapshot]);
  const agents = snapshot?.agents ?? [];
  const claims = useMemo(() => sortClaims(snapshot?.claims ?? []), [snapshot]);
  const awakeCount = agents.filter((a) => a.awake).length;

  // The strip above the floor must count the same set every view below shows,
  // so the owner filter is applied once, here, and handed to all of them.
  const allItems = snapshot?.releaseState?.items ?? [];

  const schedRows = useMemo(
    () => upcomingScheduled(schedData?.rows ?? [], agents.map((a) => a.id)),
    [schedData, agents],
  );

  // Selecting a room filters what is below to the people IN that room.
  //
  // Filtering by the room itself is what the design intends, but no release
  // item carries the channel it belongs to (checked 2026-08-16: zero of 71),
  // so there is nothing to match on. Whose desk the work is on IS derivable,
  // and it answers the same question — "what is going on in there" — without
  // inventing a field. It becomes a true room filter the day the watcher
  // publishes `channel`.
  const officeData = useMemo(() => buildOfficeData(rooms, agents, allItems), [rooms, agents, allItems]);

  // The occupants of the selected room, with the live fields the sheet needs
  // (holding, session) that the map's plan data does not carry. Uncapped, on
  // purpose: the plan seats two, but a filter that silently ignored the third
  // occupant would under-report the room.
  const selectedRoomAgents = useMemo(() => {
    if (!selectedRoom) return null;
    const idx = officeData.rooms.findIndex((r) => r.slot === selectedRoom);
    const room = officeData.rooms[idx];
    const src = idx >= 0 ? rooms[idx] : undefined;
    if (!room || !src) return null;
    // You steer WORK, not a worker. `holding` is claim slugs, so join it back
    // to the claims to get the thread each piece of work actually lives in.
    const bySlug = new Map(claims.map((c) => [c.slug, c]));
    return {
      label: room.label,
      agents: agents
        .filter((a) => a.location === src.key)
        .map((a) => ({
          id: a.id,
          name: a.name,
          held: a.holding.map((slug) => ({ slug, threadUrl: bySlug.get(slug)?.threadUrl ?? null })),
          state: room.agents.find((x) => x.name === a.name)?.status ?? 'idle',
        })),
    };
  }, [selectedRoom, officeData, rooms, agents, claims]);

  const roomOwners = useMemo(
    () => (selectedRoomAgents ? new Set(selectedRoomAgents.agents.map((a) => a.name)) : null),
    [selectedRoomAgents],
  );

  const ownerFilteredItems = roomOwners
    ? allItems.filter((i) => i.owner && roomOwners.has(i.owner))
    : allItems;

  const ledgerCounts = useMemo(() => buildLedger(ownerFilteredItems).counts, [ownerFilteredItems]);
  const flowCount = flowFilter
    ? flowFilter === 'stalled'
      ? ledgerCounts.breached
      : flowFilter === 'person'
        ? ledgerCounts.person
        : ledgerCounts.onTrack
    : 0;

  // Where the camera opens. The plan's first slot is at its left edge, so
  // defaulting there spent the first screen on lawn. Open on the room that
  // most needs looking at — worst state first, then most occupied.
  const startSlot = useMemo(() => {
    const rank: Record<string, number> = { blocked: 0, waiting: 1, working: 2, idle: 3 };
    return [...officeData.rooms].sort(
      (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.agents.length - a.agents.length,
    )[0]?.slot;
  }, [officeData]);

  // Picking a room from anywhere but a pin drops the emphasis: it belongs to
  // the click that opened the sheet, not to the room.
  const pickRoom = (k: string) => {
    setFocusAgent(null);
    setSelectedRoom((prev) => (prev === k ? '' : k));
  };
  const closeRoom = () => {
    setFocusAgent(null);
    setSelectedRoom('');
  };

  // Scheduled rows carry the agent group's CODE name; the snapshot carries the
  // persona the operator actually knows. Same id on both sides, so map it —
  // and fall back to whatever the row said rather than to nothing.
  const personaById = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  const claimClicked = (claim: ObservatoryClaim) => {
    setExpandedClaim((prev) => (prev === claim.slug ? null : claim.slug));
  };

  const assign =
    authMe.scopes.role !== 'member' && selectedId
      ? { workgroupId: selectedId, agents: agents.map((a) => ({ id: a.id, name: a.name })) }
      : undefined;

  // The right of the bar states the context of the view you are ON, not a
  // fixed headcount — the same slot the comp gives to "18 jobs today".
  const barMeta =
    view === 'board'
      ? releaseCounts(ownerFilteredItems) || 'nothing open'
      : view === 'claims'
        ? claimSummary(claims)
        : view === 'schedule'
          ? scheduleSummary(schedRows)
          : `${agents.length} agents · ${rooms.length} channels`;

  return (
    <div className="nc-frame nc-of">
      <header className="nc-of-bar">
        <span className="nc-of-bar-title">The Observatory</span>
        <WorkgroupPicker workgroups={workgroups} selectedId={selectedId} onChange={selectWorkgroup} />
        <nav className="nc-of-seg" aria-label="Observatory views">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`nc-of-seg-btn ${view === v.key ? 'on' : ''}`}
              data-view={v.key}
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        {snapshot && (
          <span className="nc-of-bar-meta">
            <span className="nc-of-bar-count">{barMeta}</span>
            <span className="nc-of-live">
              <i className={awakeCount > 0 ? 'on' : ''} />
              {awakeCount} awake
            </span>
          </span>
        )}
      </header>

      <div className="nc-obs-body">
        {!snapshot && !error && <div className="nc-empty">loading observatory…</div>}
        {!snapshot && error && <div className="nc-obs-offline">observatory offline</div>}

        {snapshot && (
          <>
            {/* Layout law 1: one-line summary, then the OFFICE, then whatever
                the segmented control is pointing at. The headline and the
                floor do not move when the segment changes — only the region
                below them does. */}
            <CommitmentStrip items={ownerFilteredItems} slice={flowFilter} onSlice={setFlowFilter} />

            <div className="nc-obs-main">
              {/* The floor is the vendored <office-map> custom element: a
                  tile-based, hand-authored plan with real furniture, pan, and
                  teleport. Geometry is FIXED; only who is in which room comes
                  from data. */}
              <div className="nc-of-left">
              <section className="nc-of-mapcard">
                <div className="nc-of-mapcard-head">
                  <span className="nc-of-mapcard-title">The office</span>
                  <span className="nc-of-mapcard-hint">drag to pan · tap a room to filter what is below</span>
                  {selectedRoom && (
                    <button type="button" className="nc-of-chip" onClick={closeRoom}>
                      All rooms
                    </button>
                  )}
                </div>
                <OfficeMap
                  data={officeData}
                  {...(startSlot ? { start: startSlot } : {})}
                  selected={selectedRoom}
                  onSelect={pickRoom}
                  onAgentSelect={({ name, room }) => {
                    setSelectedRoom(room);
                    setFocusAgent(name);
                  }}
                  teleportTo={teleportTo}
                />
                <div className="nc-of-teleport">
                  {officeData.rooms.map((r) => (
                    <button
                      key={r.slot}
                      type="button"
                      className={`nc-of-chip ${selectedRoom === r.slot ? 'on' : ''}`}
                      onClick={() => {
                        setTeleportTo(r.slot);
                        pickRoom(r.slot);
                      }}
                    >
                      <i className={`nc-of-sd ${r.state}`} />
                      {r.label}
                    </button>
                  ))}
                </div>
                {officeData.overflow.length > 0 && (
                  // Its own line: inside the chip row this dead-end sentence sat
                  // on the same baseline as five controls and read as one.
                  <p className="nc-of-overflow">
                    {officeData.overflow.length} more{' '}
                    {officeData.overflow.length === 1 ? 'channel has' : 'channels have'} no room on this floor
                  </p>
                )}
              </section>

              {selectedRoomAgents && (
                <aside className="nc-of-sheet">
                  <header>
                    <span className="nc-of-sheet-title">{selectedRoomAgents.label}</span>
                    <button type="button" className="nc-of-sheet-x" onClick={closeRoom} aria-label="Close">
                      ✕
                    </button>
                  </header>
                  {selectedRoomAgents.agents.length === 0 ? (
                    <p className="nc-of-sheet-empty">nobody is in this room right now</p>
                  ) : (
                    <ul className="nc-of-sheet-list">
                      {selectedRoomAgents.agents.map((a) => (
                        <li key={a.id} className={a.name === focusAgent ? 'on' : ''} data-agent={a.name}>
                          <span className="nc-of-sheet-who">
                            <i className={`nc-of-sd ${a.state}`} />
                            {a.name}
                          </span>
                          {/* Steer is per PIECE OF WORK, not per agent: one row
                              per held claim, each linking into the thread that
                              work lives in. An agent holding nothing gets no
                              affordance — there is nothing to steer. */}
                          {a.held.length === 0 ? (
                            <span className="nc-of-sheet-holding">holding nothing</span>
                          ) : (
                            <div className="nc-of-sheet-held">
                              {a.held.map((h) => (
                                <div className="nc-of-sheet-held-row" key={h.slug}>
                                  <span className="nc-of-sheet-held-slug">{h.slug}</span>
                                  {h.threadUrl ? (
                                    <OutLink href={h.threadUrl}>steer in thread</OutLink>
                                  ) : (
                                    <span className="nc-of-sheet-nothread">no thread recorded</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </aside>
              )}

              </div>

              <div className="nc-of-right">
                {view === 'overview' && (
                  <section className="nc-of-card" data-section="queue">
                    <header className="nc-of-card-head">
                      <span className="nc-of-card-title">Needs attention</span>
                      {/* "62" alone read as a fourth, unexplained total. Against
                          the denominator it is obviously the two slices that are
                          not moving on their own. */}
                      <span className="nc-of-card-meta">
                        {flowFilter
                          ? `${FLOW_LABEL[flowFilter]} · ${flowCount} of ${ownerFilteredItems.length}`
                          : `${ledgerCounts.breached + ledgerCounts.person} of ${ownerFilteredItems.length}`}
                      </span>
                      {flowFilter && (
                        <button type="button" className="nc-of-clearfilter" onClick={() => setFlowFilter(null)}>
                          show all
                        </button>
                      )}
                    </header>
                    <LedgerBoard items={ownerFilteredItems} slice={flowFilter} {...(assign ? { assign } : {})} />
                  </section>
                )}

                {view === 'board' && (
                  <>
                    <JobBoard
                      items={ownerFilteredItems}
                      tab={jobTab}
                      onTab={setJobTab}
                      releaseState={snapshot.releaseState}
                      {...(assign ? { assign } : {})}
                    />
                    <div className="nc-of-twoup">
                      <ClaimsCard claims={claims} expandedSlug={expandedClaim} onClaimClick={claimClicked} />
                      <ScheduleCard
                        rows={schedRows}
                        names={personaById}
                        failed={Boolean(schedError) && !schedData}
                        onMutated={() => void schedMutate()}
                      />
                    </div>
                  </>
                )}

                {view === 'claims' && (
                  <ClaimsCard claims={claims} expandedSlug={expandedClaim} onClaimClick={claimClicked} />
                )}

                {view === 'schedule' && (
                  <ScheduleCard
                    rows={schedRows}
                    names={personaById}
                    failed={Boolean(schedError) && !schedData}
                    onMutated={() => void schedMutate()}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="nc-obs-footer">
        {snapshot && !error && <span>as of {relAge(snapshot.asOf)} ago — source: live host state</span>}
        {snapshot && error && <span className="nc-obs-stale">stale since {relAge(snapshot.asOf)} ago</span>}
        {!snapshot && !error && <span>—</span>}
      </footer>
    </div>
  );
}

/* ─── Pure helpers (exported for tests) ──────────────────────────────────── */

/** Stable zone ordering — platform, then name. Never by activity. */
export function sortRooms(rooms: ObservatoryRoom[]): ObservatoryRoom[] {
  return [...rooms].sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

const CLAIM_ORDER: ObservatoryClaimState[] = ['stale', 'parked', 'expiring', 'live'];

/** Claims wall order: stale → parked → expiring → live. */
export function sortClaims(claims: ObservatoryClaim[]): ObservatoryClaim[] {
  return [...claims].sort((a, b) => CLAIM_ORDER.indexOf(a.state) - CLAIM_ORDER.indexOf(b.state));
}

/** Zone light level, driven by lastActivityAt: today lit, 1-7d dim, else dusty. */
export function roomActivityClass(lastActivityAt: string | null, now = Date.now()): 'lit' | 'dim' | 'dusty' {
  if (!lastActivityAt) return 'dusty';
  const days = (now - new Date(lastActivityAt).getTime()) / 86_400_000;
  if (days < 1) return 'lit';
  if (days <= 7) return 'dim';
  return 'dusty';
}


// Magnitude of an ms duration, bucketed the same way relAge buckets an
// elapsed-time ISO string — fed a synthesized timestamp so the two never
// drift apart on what "3h" means.
function magnitude(ms: number, now = Date.now()): string {
  return relAge(new Date(now - Math.abs(ms)).toISOString(), now);
}

// Signed relative time ("in 5m" / "3h ago").
function relTime(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  return ms >= 0 ? `in ${magnitude(ms, now)}` : `${magnitude(ms, now)} ago`;
}

/** Claim row age line — phrasing depends on state, magnitude from staleMs. */
export function claimAgeLabel(c: ObservatoryClaim, now = Date.now()): string {
  const mag = magnitude(c.staleMs, now);
  if (c.state === 'live') return `${mag} left`;
  if (c.state === 'parked') return `parked ${mag} ago`;
  return `${mag} past deadline`;
}

/** Link that always leaves the page safely. */
function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="nc-of-link" href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

/* ─── Job board — "what's in the way, and who has to move" ───────────────── */

type ReleaseGroupKey = 'blockers' | ReleaseNextMover;

/** "open PR" for a pull request, "open issue" for everything else. */
function itemLinkLabel(kind: string): string {
  return kind === 'pr' ? 'open PR' : 'open issue';
}

/**
 * Split items into the blockers group plus the three mover groups, with a
 * blocksRelease item appearing ONLY in blockers — never duplicated into its
 * mover group too.
 */
export function groupReleaseItems(items: ReleaseItem[]): {
  blockers: ReleaseItem[];
  human: ReleaseItem[];
  agent: ReleaseItem[];
  nobody: ReleaseItem[];
} {
  const blockers = items.filter((i) => i.blocksRelease);
  const rest = items.filter((i) => !i.blocksRelease);
  return {
    blockers,
    human: rest.filter((i) => i.nextMover === 'human'),
    agent: rest.filter((i) => i.nextMover === 'agent'),
    nobody: rest.filter((i) => i.nextMover === 'nobody'),
  };
}

/** The four tallies, zero terms dropped. The joined form is `releaseCounts`. */
export function releaseCountParts(items: ReleaseItem[]): { key: ReleaseGroupKey; n: number; label: string }[] {
  const g = groupReleaseItems(items);
  return [
    { key: 'blockers' as const, n: g.blockers.length, label: 'blocking' },
    { key: 'human' as const, n: g.human.length, label: 'need a person' },
    { key: 'agent' as const, n: g.agent.length, label: 'automated' },
    { key: 'nobody' as const, n: g.nobody.length, label: 'unowned' },
  ].filter((p) => p.n > 0);
}

/** "2 blocking · 28 need a person · 9 automated · 32 unowned" — zero terms omitted. */
export function releaseCounts(items: ReleaseItem[]): string {
  return releaseCountParts(items)
    .map((p) => `${p.n} ${p.label}`)
    .join(' · ');
}

export type JobTabKey = 'queue' | 'flight' | 'blocking';

/**
 * The three tabs, named for what this board actually knows.
 *
 * The comp asked for "Queue / In flight / Failed today". We have no job runs,
 * no exit codes and no 24h window — every row here is an open COMMITMENT, not
 * a process — so "failed today" would have been a fabricated column. These
 * three are the same read against the data we do have: who has to move it.
 */
export const JOB_TABS: { key: JobTabKey; label: string; hint: string }[] = [
  { key: 'queue', label: 'Queue', hint: 'unclaimed and claimed work, newest promise first' },
  { key: 'flight', label: 'In flight', hint: 'items an agent is actively moving' },
  { key: 'blocking', label: 'Blocks release', hint: 'nothing ships past these' },
];

/**
 * One tab's rows, newest promise first. "Blocks release" deliberately CROSSES
 * the other two rather than draining them: an item does not stop being queued
 * because it also blocks the release, and a tab whose count disagreed with the
 * queue it filters would be the same lie in a smaller box.
 */
export function jobTabItems(items: ReleaseItem[], tab: JobTabKey): ReleaseItem[] {
  const rows =
    tab === 'blocking'
      ? items.filter((i) => i.blocksRelease)
      : tab === 'flight'
        ? items.filter((i) => i.nextMover === 'agent')
        : items.filter((i) => i.nextMover !== 'agent');
  return [...rows].sort((a, b) => Date.parse(b.since ?? '') - Date.parse(a.since ?? '') || 0);
}

function JobBoard({
  items,
  tab,
  onTab,
  releaseState,
  assign,
  now = Date.now(),
}: {
  items: ReleaseItem[];
  tab: JobTabKey;
  onTab: (t: JobTabKey) => void;
  /** Null until the watcher has published — an empty board and an ABSENT one
   *  are different facts and must never render the same sentence. */
  releaseState: ReleaseState | null;
  assign?: AssignWiring;
  now?: number;
}) {
  const rows = useMemo(() => jobTabItems(items, tab).map((i) => classify(i, now)), [items, tab, now]);
  const hint = (JOB_TABS.find((t) => t.key === tab) ?? JOB_TABS[0]!).hint;
  const release = releaseState?.release;
  const empty = !releaseState
    ? 'no release desk — the release watcher has not published release-state.json yet'
    : items.length === 0
      ? 'nothing open — clear to ship pending the usual gates'
      : 'nothing in this slice';

  return (
    <section className="nc-of-card" data-section="board">
      <div className="nc-of-tabs" role="group" aria-label="Job board slice">
        {JOB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`nc-of-tab ${tab === t.key ? 'on' : ''}`}
            data-tab={t.key}
            aria-pressed={tab === t.key}
            onClick={() => onTab(t.key)}
          >
            {t.label} <span className="nc-of-tab-n">{jobTabItems(items, t.key).length}</span>
          </button>
        ))}
        <span className="nc-of-tab-hint">{hint}</span>
      </div>
      {/* A freeze is a fact about the whole board, so it states itself above
          the rows rather than living in a banner the tabs can hide. */}
      {release?.moratorium && <div className="nc-obs-release-moratorium">release-day moratorium active</div>}
      {release?.holds && release.holds.length > 0 && (
        <div className="nc-obs-release-holds">
          {release.holds.map((h, i) => (
            <span key={i} className="nc-obs-release-hold">
              {h.kind}
              {h.reason ? `: ${h.reason}` : ''}
            </span>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="nc-obs-ledger-empty">{empty}</div>
      ) : (
        // A tab change is a new list, so the table remounts: the fold and any
        // open row belong to the slice they were opened in.
        <ItemTable key={tab} rows={rows} now={now} {...(assign ? { assign } : {})} />
      )}
    </section>
  );
}

/**
 * The headline. It used to read "4 awake · 10 channels", which measures agent
 * liveness — a container can be awake, animated and busy-looking while the work
 * it holds rotted three days ago. These three numbers measure FLOW instead:
 * what has already failed its promise, what a person owes, and what is moving.
 */
/** Header wording for a filtered queue. */
const FLOW_LABEL: Record<FlowSlice, string> = {
  stalled: 'stalled',
  person: 'need a person',
  moving: 'moving on their own',
};

export const STATE_WORDS = { stalled: 'stalled', person: 'need a person', moving: 'moving' } as const;

/** Which slice of the headline the queue is showing. */
export type FlowSlice = 'stalled' | 'person' | 'moving';

/** The slice a commitment belongs to. Every row is in exactly one. */
export function flowSlice(c: Commitment): FlowSlice {
  if (c.state === 'breached' || c.state === 'unowned') return 'stalled';
  return c.mover === 'human' ? 'person' : 'moving';
}

export function CommitmentStrip({
  items,
  slice,
  onSlice,
}: {
  items: ReleaseItem[];
  slice?: FlowSlice | null;
  onSlice?: (s: FlowSlice | null) => void;
}) {
  const ledger = useMemo(() => buildLedger(items), [items]);
  const { counts } = ledger;
  if (items.length === 0) return null;
  // The numbers ARE the way into the queue. Reading "30 need a person" and
  // having no way to see which thirty was the gap: the most decision-relevant
  // slice had no entry point.
  const pick = (s: FlowSlice) => () => onSlice?.(slice === s ? null : s);
  return (
    <section className="nc-of-head">
      <div className="nc-of-head-main">
        {/* ONE dominant number. Three equal ones made the reader choose which
            to care about; the ten-second read has to answer that for them. */}
        <button
          type="button"
          className={`nc-of-hero ${slice === 'stalled' ? 'on' : ''}`}
          aria-pressed={slice === 'stalled'}
          onClick={pick('stalled')}
        >
          <span className="nc-of-hero-n">{counts.breached}</span>
          <span className="nc-of-hero-l">
            items are stalled
            <span>past a promised deadline, or owned by nobody</span>
          </span>
        </button>
        <div className="nc-of-sub">
          <button
            type="button"
            className={`nc-of-slice ${slice === 'person' ? 'on' : ''}`}
            aria-pressed={slice === 'person'}
            onClick={pick('person')}
          >
            <b className="warn">{counts.person}</b> need a person
          </button>
          <button
            type="button"
            className={`nc-of-slice ${slice === 'moving' ? 'on' : ''}`}
            aria-pressed={slice === 'moving'}
            onClick={pick('moving')}
          >
            <b className="go">{counts.onTrack}</b> moving on their own
          </button>
          {/* The three numbers are DISJOINT slices of one denominator: every
              commitment is in exactly one. Without saying so, a reader reads
              30 and 8 as subsets of 32 and finds an arithmetic contradiction
              where there is none. */}
          <span className="nc-of-sub-total">{items.length} open commitments, split three ways</span>
        </div>
      </div>
      {/* The gaps in the data, one line each. These are never hidden — they
          report that the numbers above are incomplete, and a collapsed
          disclosure would soften exactly the thing that must not soften. On a
          phone only the ELABORATION drops, so the claim still reads in full
          while the block stops pushing the office below the fold. */}
      <div className="nc-of-notes">
        <p>
          <i className="warn" />
          <span>
            <b>{ledger.datedPct}% of owned work has a deadline.</b>
            <span className="nc-of-note-more">
              {' '}
              Nothing here can be measured as late, so &ldquo;stalled&rdquo; undercounts.
            </span>
          </span>
        </p>
        {ledger.unclassifiedP1 > 0 && (
          <p>
            <i className="stop" />
            <span>
              <b>
                {ledger.unclassifiedP1} p1 security {ledger.unclassifiedP1 === 1 ? 'finding is' : 'findings are'} not
                classified as release-blocking either way.
              </b>
              <span className="nc-of-note-more"> A person has to decide.</span>
            </span>
          </p>
        )}
      </div>
    </section>
  );
}

/* ─── The one table — every commitment, one grammar ──────────────────────── */

const LEDGER_STATE_LABEL: Record<Commitment['state'], string> = {
  unowned: 'nobody owns this',
  breached: 'past its promise',
  undated: 'no deadline set',
  'due-soon': 'due soon',
  'on-track': 'on track',
};

/** Rows on the first screen of the queue. The rest expand on demand. */
const LEDGER_FIRST_PAGE = 15;

interface AssignWiring {
  workgroupId: string;
  agents: { id: string; name: string }[];
}

/**
 * The assign control on one expanded row. Sends three ids; the server owns the
 * prompt, the role gate and the wiring check — a rejection comes back as its
 * error name so the operator learns WHY (not wired, no channel), not just "no".
 */
function AssignControl({ item, wiring }: { item: ReleaseItem; wiring: AssignWiring }) {
  const [agentId, setAgentId] = useState('');
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; note?: string }>({ phase: 'idle' });

  if (!item.channel) return null;
  if (state.phase === 'done') return <div className="nc-obs-assign-done">{state.note}</div>;

  const go = async () => {
    if (!agentId) return;
    setState({ phase: 'busy' });
    try {
      const r = await assignItem(wiring.workgroupId, item.id, agentId);
      setState({ phase: 'done', note: `assigned — ${r.agent} was tasked in ${r.channel}` });
    } catch (e) {
      const err = e as { error?: string; status?: number };
      const why =
        err.error === 'agent_not_wired_to_channel'
          ? `that agent is not wired to ${item.channel}`
          : err.error === 'recently_assigned'
            ? 'already assigned in the last few minutes'
            : (err.error ?? 'failed');
      setState({ phase: 'error', note: why });
    }
  };

  return (
    <div className="nc-obs-assign">
      <select
        aria-label="Assign to agent"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        disabled={state.phase === 'busy'}
      >
        <option value="">assign to…</option>
        {wiring.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={go} disabled={!agentId || state.phase === 'busy'}>
        {state.phase === 'busy' ? 'assigning…' : `task it in ${item.channel}`}
      </button>
      {state.phase === 'error' && <span className="nc-obs-assign-err">{state.note}</span>}
    </div>
  );
}

/**
 * One row, one grammar: id · title · state · owner · room · age. The same row
 * renders in the needs-attention queue and on the job board — two filters over
 * one table, never two tables.
 */
function ItemRow({
  c,
  now,
  expanded,
  onToggle,
  assign,
}: {
  c: Commitment;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  assign?: AssignWiring;
}) {
  const item = c.item;
  return (
    <li
      className={`nc-obs-ledger-row ${c.state} ${item.blocksRelease ? 'blocks' : ''}`}
      data-ledger-id={item.id}
    >
      <button type="button" className="nc-obs-ledger-btn" aria-expanded={expanded} onClick={onToggle}>
        <span className="nc-obs-ledger-id mono">{item.id}</span>
        <span className="nc-obs-ledger-title">
          {item.blocksRelease && <span className="nc-obs-ledger-blocks">blocks release</span>}
          {item.title}
        </span>
        {/* The state dot is the ONLY urgency encoding on the row — no bar, no
            row tint, no coloured title stacked on top of it. */}
        <span className={`nc-obs-ledger-state ${c.state}`}>
          <i className="nc-obs-dot" />
          {dueLabel(c)}
        </span>
        <span className="nc-obs-ledger-owner">{item.owner ?? '—'}</span>
        <span className="nc-obs-ledger-room">{item.channel ?? '—'}</span>
        <span className="nc-obs-ledger-age">{c.ageMs !== null ? magnitude(c.ageMs, now + c.ageMs) : '—'}</span>
      </button>
      {expanded && (
        <div className="nc-obs-ledger-detail">
          {item.nextAction && <div className="nc-obs-ledger-next">next: {item.nextAction}</div>}
          {item.why && <div>{item.why}</div>}
          <div className="nc-obs-ledger-meta">
            {LEDGER_STATE_LABEL[c.state]}
            {item.owner ? ` · ${item.owner}` : ''}
          </div>
          {item.url && <OutLink href={item.url}>{itemLinkLabel(item.kind)}</OutLink>}
          {/* Handing a person's own item to an agent is not the move — the
              whole point of this row is that a PERSON has to answer it. It
              says where, instead of offering to route it away. */}
          {item.nextMover === 'human' ? (
            <div className="nc-obs-needsyou">
              this needs you{item.channel ? ` — answer in ${item.channel} →` : ''}
            </div>
          ) : (
            assign && <AssignControl item={item} wiring={assign} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The table. Both cards render this one; they differ only in what they hand it
 * and whether the column header is on.
 *
 * It pages itself, because the list is ranked: the first screen is the answer
 * and 62 rows at once is the wall of list this page exists to get out from
 * under. The count on the button says how much is behind the fold.
 */
function ItemTable({
  rows,
  now,
  assign,
  head = true,
}: {
  rows: Commitment[];
  now: number;
  assign?: AssignWiring;
  /** The column header. On by default; the queue is titled by its card. */
  head?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, LEDGER_FIRST_PAGE);

  return (
    <div className="nc-obs-ledger">
      {head && (
        <div className="nc-obs-ledger-head" aria-hidden="true">
          <span>Id</span>
          <span>Title</span>
          <span>State</span>
          <span>Owner</span>
          <span>Room</span>
          <span>Age</span>
        </div>
      )}
      <ul className="nc-obs-ledger-rows">
        {shown.map((c) => (
          <ItemRow
            key={c.item.id}
            c={c}
            now={now}
            expanded={expanded === c.item.id}
            onToggle={() => setExpanded((p) => (p === c.item.id ? null : c.item.id))}
            {...(assign ? { assign } : {})}
          />
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" className="nc-obs-ledger-more" onClick={() => setShowAll(true)}>
          show the other {rows.length - shown.length}
        </button>
      )}
    </div>
  );
}

/**
 * The queue. Every open item as a commitment, ordered so that anything that
 * has already failed its promise is first and the oldest failure leads.
 *
 * It is a ranked list on purpose: this has to work on a phone, and the answer
 * to "what is stuck" is a ranking, not a picture.
 */
function LedgerBoard({
  items,
  now = Date.now(),
  slice = null,
  assign,
}: {
  items: ReleaseItem[];
  now?: number;
  /** Headline slice the queue is filtered to, or null for everything open. */
  slice?: FlowSlice | null;
  /** Present only for roles that may assign; absent hides the control. */
  assign?: AssignWiring;
}) {
  const ledger = useMemo(() => buildLedger(items, now), [items, now]);
  // Unfiltered, the queue is everything NOT moving on its own; picking
  // "moving" is the one case that widens it rather than narrowing it.
  //
  // Filtered on the SAME slices the headline counts, deliberately. The old
  // default (state !== 'on-track') admitted agent-owned undated rows that the
  // headline had already counted under "moving", so the board's own "62 of 70"
  // could disagree with the number of rows under it.
  const all = ledger.rows.filter((r) => (slice ? flowSlice(r) === slice : flowSlice(r) !== 'moving'));

  // The two coverage gaps are stated ONCE, in the headline above. Repeating
  // them here read as two separate warnings about two separate problems.
  if (all.length === 0) {
    return (
      <div className="nc-obs-ledger-empty">
        {slice ? 'nothing in this slice' : 'every open commitment is on track'}
      </div>
    );
  }
  return <ItemTable rows={all} now={now} head={false} {...(assign ? { assign } : {})} />;
}

/* ─── Work claims ────────────────────────────────────────────────────────── */

/** [one, many] — the count decides, because "6 needs an owner" is not English. */
const CLAIM_STATE_WORD: Record<ObservatoryClaimState, [string, string]> = {
  stale: ['abandoned', 'abandoned'],
  parked: ['needs an owner', 'need an owner'],
  expiring: ['expired', 'expired'],
  live: ['held', 'held'],
};

/** "1 abandoned · 6 need an owner · 4 held" — zero terms omitted. */
export function claimSummary(claims: ObservatoryClaim[]): string {
  const parts = CLAIM_ORDER.map((s) => ({ n: claims.filter((c) => c.state === s).length, w: CLAIM_STATE_WORD[s] }))
    .filter((p) => p.n > 0)
    .map((p) => `${p.n} ${p.n === 1 ? p.w[0] : p.w[1]}`);
  return parts.length === 0 ? 'nothing claimed' : parts.join(' · ');
}

/** Red once the deadline has passed or the claim was announced; amber inside the grace window. */
function claimTone(c: ObservatoryClaim): string {
  if (c.state === 'stale' || c.escalated) return 'stop';
  if (c.state === 'expiring') return 'warn';
  return '';
}

function ClaimsCard({
  claims,
  expandedSlug,
  onClaimClick,
}: {
  claims: ObservatoryClaim[];
  expandedSlug: string | null;
  onClaimClick: (claim: ObservatoryClaim) => void;
}) {
  return (
    <section className="nc-of-card" data-section="claims">
      <header className="nc-of-card-head">
        <span className="nc-of-card-title">Work claims</span>
        <span className="nc-of-card-meta">{claimSummary(claims)}</span>
      </header>
      {claims.length === 0 ? (
        <div className="nc-obs-ledger-empty">nobody has picked anything up</div>
      ) : (
        <ul className="nc-obs-claim-rows">
          {claims.map((c) => {
            const expanded = expandedSlug === c.slug;
            return (
              <li key={c.slug} className={`nc-obs-claim-row ${c.state}`} data-slug={c.slug}>
                <button
                  type="button"
                  className="nc-obs-claim-toggle"
                  aria-expanded={expanded}
                  onClick={() => onClaimClick(c)}
                >
                  <span className="nc-obs-claim-title">
                    <span className="nc-obs-claim-slug mono">{c.slug}</span>
                    {c.state === 'parked' && <span className="nc-obs-claim-tag">needs an owner</span>}
                    {c.escalated && <span className="nc-obs-claim-tag">escalated in channel</span>}
                  </span>
                  <span className="nc-obs-claim-owner">
                    {c.owner && c.owner !== 'unknown' ? c.owner : <em>owner unknown</em>}
                  </span>
                  <span className={`nc-obs-claim-age ${claimTone(c)}`}>{claimAgeLabel(c)}</span>
                </button>
                {expanded && (
                  <div className="nc-obs-claim-detail">
                    {c.note && <div className="nc-obs-claim-note">{c.note}</div>}
                    {c.threadUrl && <OutLink href={c.threadUrl}>open thread</OutLink>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ─── Scheduled jobs — the next few automatic fires ──────────────────────── */

const SCHED_KIND_LABEL: Record<string, string> = {
  recurring: 'repeating job',
  one_off: 'one-time job',
  thread_loop: 'follow-up check',
};

/**
 * The next `limit` fires belonging to agents on this floor, soonest first.
 * Rows with no next fire (cancelled, finished one-offs) are not upcoming work
 * and drop out.
 */
export function upcomingScheduled(rows: ScheduledRow[], agentGroupIds: string[], limit = 8): ScheduledRow[] {
  const mine = new Set(agentGroupIds);
  return rows
    .filter((r) => mine.has(r.agent_group_id) && r.next_fire_utc)
    .sort((a, b) => Date.parse(a.next_fire_utc!) - Date.parse(b.next_fire_utc!))
    .slice(0, limit);
}

/**
 * "6 on this floor · next in 4m" — the bar's context line for the schedule.
 *
 * The soonest fire leads, so a fire in the PAST means the sweep has not run it
 * yet. That is a fact worth saying in words rather than dressing up as "next
 * 4d ago", which reads as a typo instead of as a late job.
 */
export function scheduleSummary(rows: ScheduledRow[], now = Date.now()): string {
  const next = rows[0];
  if (!next) return 'nothing scheduled';
  const ms = Date.parse(next.next_fire_utc!) - now;
  const when = ms >= 0 ? `next ${relTime(next.next_fire_utc!, now)}` : `next was due ${magnitude(ms, now)} ago`;
  return `${rows.length} on this floor · ${when}`;
}

function ScheduleCard({
  rows,
  names,
  failed,
  onMutated,
}: {
  rows: ScheduledRow[];
  /** agent_group_id → the persona name the operator knows it by. A row whose
   *  id is not on this floor keeps whatever name the API gave it. */
  names: Map<string, string>;
  /** The endpoint failed and there is nothing cached to show. */
  failed: boolean;
  onMutated: () => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // A key whose row has dropped out of the window (it fired, or was cancelled
  // from another tab) must not hold a drawer open over a series that is no
  // longer on this floor.
  const open = rows.some((r) => r.key === openKey) ? openKey : null;

  return (
    <section className="nc-of-card" data-section="schedule">
      <header className="nc-of-card-head">
        <span className="nc-of-card-title">Scheduled jobs</span>
        <span className="nc-of-card-meta">{scheduleSummary(rows)}</span>
      </header>
      {failed && <div className="nc-obs-ledger-empty">couldn&apos;t load scheduled work</div>}
      {!failed && rows.length === 0 && <div className="nc-obs-ledger-empty">nothing scheduled</div>}
      {rows.length > 0 && (
        <ul className="nc-of-sched-rows">
          {rows.map((r) => (
            <li key={r.key} className="nc-of-sched-row" data-sched-key={r.key}>
              <button
                type="button"
                className="nc-of-sched-open"
                onClick={() => setOpenKey(r.key)}
                aria-label={`Open scheduled job ${r.series_id}`}
              >
                <span className="nc-of-sched-name">
                  <span className="nc-of-sched-id mono">{r.series_id}</span>
                  <span className="nc-of-sched-who">
                    {names.get(r.agent_group_id) ?? r.agent_group_name}
                    {r.channel_name ? ` in ${r.channel_name}` : ''}
                  </span>
                </span>
                {/* Monospace is for the cron expression only; a series with no
                    cron says what kind of job it is instead. */}
                {r.cron ? (
                  <span className="nc-of-sched-cron mono">{r.cron}</span>
                ) : (
                  <span className="nc-of-sched-cron">{SCHED_KIND_LABEL[r.kind] ?? 'job'}</span>
                )}
                <span className="nc-of-sched-when">{relTime(r.next_fire_utc!)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ScheduledDrawer
          rowKey={open}
          // The drawer fetches its own row, which carries the code name; the
          // persona is only known out here, so it is handed down.
          groupName={names.get(rows.find((r) => r.key === open)!.agent_group_id) ?? null}
          onClose={() => setOpenKey(null)}
          onMutated={onMutated}
        />
      )}
    </section>
  );
}
