import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  listWorkgroups,
  getObservatory,
  listScheduled,
  type AuthMe,
  type ObservatorySnapshot,
  type ObservatoryRoom,
  type ObservatoryAgent,
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
import {
  assignItem,
  getIssueBrief,
  getSessionDetail,
  nudgeClaim,
  steerWork,
  type IssueBrief,
  type SessionTranscriptEntry,
} from '../lib/api.js';
import { TranscriptList, normalizeSessionEntry } from './TranscriptList.js';
import { OfficeMap } from './OfficeMap.js';
import { buildOfficeData, agentState } from './office-data.js';
import { WorkgroupPicker } from './WorkgroupDashboard.js';


/**
 * Observatory — the layer above Slack: one page that answers what is stuck,
 * what needs a person, and what is moving on its own, before any interaction.
 *
 * The page is FIXED at the top and switched at the bottom:
 *
 *   1. the headline — three equal stats (stalled, need a person, moving on
 *      their own) and the coverage gaps that qualify them, stated once;
 *   2. the office — the vendored <office-map> custom element, a hand-authored
 *      tile plan where each channel is a room and each agent sits in the room
 *      it last worked in. Geometry is FIXED; only occupancy comes from data.
 *      Picking a room opens the room sheet and filters what is below;
 *   3. ONE content region, chosen by the segmented control in the top bar:
 *      overview (the needs-attention queue) or the job board, which carries the
 *      claims and schedule cards beneath it.
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

/** Whether the floor is unfolded. Absent means expanded — the default view. */
const MAP_OPEN_KEY = 'nc-obs-map-open';

/** Map zoom: persisted like the fold state, same reasoning — an operator who
    picks a zoom level should not have to pick it again on every visit. */
const MAP_SCALE_KEY = 'nc-obs-map-scale';
const MAP_SCALE_MIN = 0.6;
const MAP_SCALE_MAX = 3;
const MAP_SCALE_STEP = 0.2;
/* obs.C.15 — default view zoomed in enough that a room reads at a glance
   without the floor plan vanishing to a postage stamp. */
const MAP_SCALE_DEFAULT = 1.7;
const clampMapScale = (v: number) => Math.min(MAP_SCALE_MAX, Math.max(MAP_SCALE_MIN, +v.toFixed(2)));

/**
 * The segmented control. Local state — the Observatory has exactly one URL.
 *
 * Three segments, not five. "Claims" and "Schedule" each showed exactly the
 * card the job board already carries beneath its table, so picking them swapped
 * a three-card view for a one-card one and called it a different place. The
 * cards themselves are untouched — they live under Job board, where the work
 * they describe is.
 *
 * "Decisions" earns its place on the opposite argument: it is not a card that
 * exists somewhere else. It is the one question a two-person shop opens this
 * page to ask — what is waiting on ME — and answering it from Overview meant
 * reading past a floor plan, a filter bar and every row an agent already owns.
 */
const VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'board', label: 'Job board' },
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
  // Folding the floor away is a lasting preference, not a per-visit mood: an
  // operator who works from the rows should not re-hide a full screen of
  // illustration every time they open the page. Expanded unless they said so.
  const [mapOpen, setMapOpen] = useState(() => localStorage.getItem(MAP_OPEN_KEY) !== 'false');
  useEffect(() => {
    localStorage.setItem(MAP_OPEN_KEY, String(mapOpen));
  }, [mapOpen]);
  const [mapScale, setMapScale] = useState(() => {
    const saved = Number(localStorage.getItem(MAP_SCALE_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampMapScale(saved) : MAP_SCALE_DEFAULT;
  });
  useEffect(() => {
    localStorage.setItem(MAP_SCALE_KEY, String(mapScale));
  }, [mapScale]);
  const zoomMapBy = (delta: number) => setMapScale((s) => clampMapScale(s + delta));
  const resetMapScale = () => setMapScale(MAP_SCALE_DEFAULT);
  const [jobTab, setJobTab] = useState<JobTabKey>('queue');
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [flowFilter, setFlowFilter] = useState<FlowSlice | null>(null);
  const [teleportTo, setTeleportTo] = useState<string | null>(null);
  const [expandedClaim, setExpandedClaim] = useState<string | null>(null);
  // The agent whose pin was clicked — opens the agent drawer over whatever
  // view is showing. Independent of selectedRoom: picking a room and picking
  // a person are two different questions now.
  const [agentDrawerId, setAgentDrawerId] = useState<string | null>(null);
  // Which room the agent was clicked IN — the drawer answers about
  // (agent, room), not the agent's global ledger, so this travels with
  // agentDrawerId rather than being re-derived from the agent's own
  // (possibly different) current location.
  const [agentDrawerRoomKey, setAgentDrawerRoomKey] = useState<string | null>(null);
  const closeAgentDrawer = () => {
    setAgentDrawerId(null);
    setAgentDrawerRoomKey(null);
  };

  const rooms = useMemo(() => sortRooms(snapshot?.rooms ?? []), [snapshot]);
  const agents = snapshot?.agents ?? [];
  const claims = useMemo(() => sortClaims(snapshot?.claims ?? []), [snapshot]);
  // "answer in #dispatch" is only worth an anchor when #dispatch has a URL.
  const roomLinks = useMemo(() => roomLinkIndex(rooms), [rooms]);
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
  const officeData = useMemo(
    () => buildOfficeData(rooms, agents, allItems, snapshot?.themedSlots),
    [rooms, agents, allItems, snapshot?.themedSlots],
  );

  // The occupants of the selected room, with the live fields the sheet needs
  // (holding, session) that the map's plan data does not carry. Uncapped, on
  // purpose: the plan seats two, but a filter that silently ignored the third
  // occupant would under-report the room.
  const selectedRoomAgents = useMemo(() => {
    if (!selectedRoom) return null;
    // Joined by room KEY, not by list position: officeData.rooms drops the
    // overflow rooms, so the two lists stop being index-parallel the moment a
    // floor runs out of slots — and the sheet would then show a different
    // room's people (and their claims) under the picked room's name.
    const room = officeData.rooms.find((r) => r.slot === selectedRoom);
    if (!room) return null;
    // You steer WORK, not a worker. `holding` is claim slugs, so join it back
    // to the claims to get the thread each piece of work actually lives in.
    const bySlug = new Map(claims.map((c) => [c.slug, c]));
    return {
      label: room.label,
      key: room.key,
      agents: agents
        .filter((a) => a.location === room.key)
        .map((a) => ({
          id: a.id,
          name: a.name,
          avatarUrl: a.avatarUrl,
          held: a.holding.map((slug) => {
            const c = bySlug.get(slug);
            return {
              slug,
              // Read off the claim, never assumed: the sheet used to hardcode
              // "not pushable" and so offered strictly less than the claims
              // card on the same piece of work.
              pushable: c ? claimPushable(c) : false,
              threadId: c?.threadId ?? null,
              threadUrl: c?.threadUrl ?? null,
              sessionId: c?.sessionId ?? null,
            };
          }),
          state: room.agents.find((x) => x.name === a.name)?.status ?? 'idle',
        })),
    };
  }, [selectedRoom, officeData, agents, claims]);

  const roomOwners = useMemo(
    () => (selectedRoomAgents ? new Set(selectedRoomAgents.agents.map((a) => a.name)) : null),
    [selectedRoomAgents],
  );

  const ownerFilteredItems = roomOwners
    ? allItems.filter((i) => i.owner && roomOwners.has(i.owner))
    : allItems;

  const ledgerCounts = useMemo(() => buildLedger(ownerFilteredItems).counts, [ownerFilteredItems]);

  // The Decisions badge counts EVERY item whose next mover is a person,
  // breached ones included — a decision that has already slipped its deadline
  // is still a decision, and it is the one you want at the top of the list.
  // Deliberately not the headline's "need a person" tile, which excludes the
  // breach tier; see the note on that tile.
  const decisionCount = ownerFilteredItems.filter((i) => i.nextMover === 'human').length;

  // The office map's own notion of "in trouble" (office-data.ts's
  // agentState), recomputed here off the FULL board rather than the
  // room-filtered one — the drawer answers about one agent, not one room.
  const breachedOwners = useMemo(
    () =>
      new Set(
        buildLedger(allItems)
          .rows.filter((r) => r.state === 'breached' || r.state === 'unowned')
          .map((r) => r.item.owner)
          .filter((o): o is string => typeof o === 'string' && o.length > 0),
      ),
    [allItems],
  );
  const agentDrawerAgent = agents.find((a) => a.id === agentDrawerId) ?? null;
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

  const pickRoom = (k: string) => {
    setSelectedRoom((prev) => (prev === k ? '' : k));
  };
  const closeRoom = () => {
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
      ? { workgroupId: selectedId, agents: agents.map((a) => ({ id: a.id, name: a.name })), rooms }
      : undefined;

  // The right of the bar states the context of the view you are ON, not a
  // fixed headcount — the same slot the comp gives to "18 jobs today".
  const barMeta =
    view === 'board'
      ? releaseCounts(ownerFilteredItems) || 'nothing open'
      : view === 'decisions'
        ? `${decisionCount} awaiting a person`
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
              {/* Same count grammar the job-board tabs use — a number beside
                  the label, never a badge with its own colour. */}
              {v.key === 'decisions' && <> <span className="nc-of-tab-n">{decisionCount}</span></>}
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
            {/* Layout law 1: the OFFICE first, then the commitments it
                explains, then whatever the segmented control is pointing at.
                The tiles used to sit ABOVE the floor on every segment, which
                put a screen of numbers between the reader and the product's
                own picture — and repeated a summary of the queue on two views
                (Decisions, Job board) that already state their own totals in
                the bar. They belong to the Overview, under the floor whose
                rooms they are counting. */}

            <div className="nc-obs-main">
              {/* The floor is the vendored <office-map> custom element: a
                  tile-based, hand-authored plan with real furniture, pan, and
                  teleport. Geometry is FIXED; only who is in which room comes
                  from data. */}
              <div className="nc-of-left">
              {/* Overview only. The floor is the answer to "what is going on",
                  which is the overview's question; on the job board it was a
                  full screen of illustration between the reader and the rows
                  they came for. The room FILTER it sets outlives it — the sheet
                  stays, so a board narrowed to a room still says which one. */}
              {view === 'overview' && (
              <section className={`nc-of-mapcard ${mapOpen ? '' : 'collapsed'}`}>
                <div className="nc-of-mapcard-head">
                  <span className="nc-of-mapcard-title">The office</span>
                  {mapOpen && (
                    <span className="nc-of-mapcard-hint">drag to pan · tap a room to filter what is below</span>
                  )}
                  {/* obs.C.15 — one flex unit, not four independent chips. Each
                      chip carrying its own margin-left:auto meant flex-wrap
                      broke the line after whichever chip claimed the push,
                      stranding it alone; grouping them lets the whole cluster
                      wrap together on a narrow header. */}
                  <div className="nc-of-mapcard-actions">
                    {mapOpen && selectedRoom && (
                      <button type="button" className="nc-of-chip" onClick={closeRoom}>
                        All rooms
                      </button>
                    )}
                    {mapOpen && (
                      <>
                        <button
                          type="button"
                          className="nc-of-chip nc-of-zoom"
                          onClick={() => zoomMapBy(-MAP_SCALE_STEP)}
                          disabled={mapScale <= MAP_SCALE_MIN}
                          aria-label="Zoom out"
                          title="Zoom out"
                        >
                          −
                        </button>
                        <button
                          type="button"
                          className="nc-of-chip nc-of-zoom"
                          onClick={resetMapScale}
                          aria-label="Reset zoom"
                          title="Reset zoom"
                        >
                          Reset
                        </button>
                        <button
                          type="button"
                          className="nc-of-chip nc-of-zoom"
                          onClick={() => zoomMapBy(MAP_SCALE_STEP)}
                          disabled={mapScale >= MAP_SCALE_MAX}
                          aria-label="Zoom in"
                          title="Zoom in"
                        >
                          +
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="nc-of-chip nc-of-mapfold"
                      data-map-open={mapOpen}
                      aria-expanded={mapOpen}
                      onClick={() => setMapOpen(!mapOpen)}
                    >
                      {mapOpen ? 'hide the floor' : 'show the floor'}
                    </button>
                  </div>
                </div>
                {mapOpen && (
                  <>
                    <OfficeMap
                      data={officeData}
                      {...(startSlot ? { start: startSlot } : {})}
                      selected={selectedRoom}
                      onSelect={pickRoom}
                      onAgentSelect={({ name, room: slot }) => {
                        // The drawer answers about (agent, room): who they
                        // are AND which room they were clicked in — picking a
                        // room on its own stays its own, independent action.
                        const a = agents.find((x) => x.name === name);
                        if (a) {
                          setAgentDrawerId(a.id);
                          setAgentDrawerRoomKey(officeData.rooms.find((r) => r.slot === slot)?.key ?? null);
                        }
                      }}
                      teleportTo={teleportTo}
                      scale={String(mapScale)}
                      onScaleChange={(s) => setMapScale(clampMapScale(s))}
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
                  </>
                )}
              </section>
              )}

              {/* The commitments the floor above is standing on. Overview
                  only, and BELOW the map: the picture answers "what is going
                  on", these three numbers qualify it, and the queue under
                  them is what the numbers open into. */}
              {view === 'overview' && (
                <CommitmentStrip items={ownerFilteredItems} slice={flowFilter} onSlice={setFlowFilter} />
              )}

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
                        <li key={a.id} data-agent={a.name}>
                          <span className="nc-of-sheet-who">
                            <i className={`nc-of-sd ${a.state}`} />
                            {/* The same face the floor shows, so the person you
                                clicked on the map is recognisably the person in
                                the sheet. Absent when the bot has no avatar —
                                a face is never invented. */}
                            {a.avatarUrl && (
                              <img className="nc-of-sheet-face" src={a.avatarUrl} alt="" width={20} height={20} />
                            )}
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
                                <HeldRow
                                  key={h.slug}
                                  slug={h.slug}
                                  pushable={h.pushable}
                                  threadId={h.threadId}
                                  threadUrl={h.threadUrl}
                                  sessionId={h.sessionId}
                                  ownerAgent={a.id}
                                  room={{
                                    key: selectedRoomAgents.key,
                                    name: selectedRoomAgents.label,
                                  }}
                                  {...(assign ? { assign } : {})}
                                />
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
                    <LedgerBoard
                      items={ownerFilteredItems}
                      slice={flowFilter}
                      roomLinks={roomLinks}
                      {...(assign ? { assign } : {})}
                    />
                  </section>
                )}

                {view === 'decisions' && (
                  <DecisionsCard
                    items={ownerFilteredItems}
                    roomLinks={roomLinks}
                    {...(assign ? { assign } : {})}
                  />
                )}

                {view === 'board' && (
                  <>
                    <JobBoard
                      items={ownerFilteredItems}
                      tab={jobTab}
                      onTab={setJobTab}
                      releaseState={snapshot.releaseState}
                      roomLinks={roomLinks}
                      {...(assign ? { assign } : {})}
                    />
                    <div className="nc-of-twoup">
                      <ClaimsCard
                        claims={claims}
                        expandedSlug={expandedClaim}
                        onClaimClick={claimClicked}
                        {...(assign ? { assign } : {})}
                      />
                      <ScheduleCard
                        rows={schedRows}
                        names={personaById}
                        failed={Boolean(schedError) && !schedData}
                        onMutated={() => void schedMutate()}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Fixed overlay, independent of the segmented view — a click on a
                person opens the same drawer whichever screen they were seen
                on, and switching screens under it does not close it. */}
            {agentDrawerAgent && (
              <AgentDrawer
                agent={agentDrawerAgent}
                roomKey={agentDrawerRoomKey}
                rooms={rooms}
                claims={claims}
                items={allItems}
                roomLinks={roomLinks}
                breachedOwners={breachedOwners}
                {...(assign ? { assign } : {})}
                onClose={closeAgentDrawer}
              />
            )}
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

/**
 * Channel name (as release items write it, e.g. `#dispatch`) → that room's own
 * permalink. Only rooms that HAVE one are in the index, so a lookup miss is the
 * honest "there is nowhere to send them" and the row stays plain text.
 */
export function roomLinkIndex(rooms: ObservatoryRoom[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rooms) {
    if (r.permalink) out.set(r.name.replace(/^#/, '').toLowerCase(), r.permalink);
  }
  return out;
}

/** Link that always leaves the page safely. */
function OutLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="nc-of-link" href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  );
}

/**
 * One held-claim row: slug, then the same action row every other claim gets.
 * Shared by the room sheet and the agent drawer — the answer to "what is this
 * piece of work and where do I steer it" never changes shape, and a claim
 * being HEALTHY is not a reason to be able to do less to it than a stuck one.
 */
function HeldRow({
  slug,
  pushable,
  threadId,
  threadUrl,
  sessionId,
  ownerAgent,
  room,
  assign,
}: {
  slug: string;
  /** See claimPushable — the caller reads it off the claim, never assumes it. */
  pushable: boolean;
  threadId: string | null;
  threadUrl: string | null;
  sessionId: string | null;
  ownerAgent: string | null;
  /** The room this row is being VIEWED in — see workRoom. */
  room?: { key?: string | null; name?: string | null };
  assign?: AssignWiring;
}) {
  return (
    <div className="nc-of-sheet-held-row">
      <span className="nc-of-sheet-held-slug">{slug}</span>
      <WorkActions
        target={{ kind: 'claim', slug, pushable }}
        threadUrl={threadUrl}
        sessionId={sessionId}
        room={workRoom(threadId, room)}
        ownerAgent={ownerAgent}
        {...(assign ? { wiring: assign } : {})}
      />
    </div>
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
  { key: 'flight', label: 'In flight', hint: 'next move belongs to an agent' },
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
  roomLinks,
  now = Date.now(),
}: {
  items: ReleaseItem[];
  tab: JobTabKey;
  onTab: (t: JobTabKey) => void;
  roomLinks?: Map<string, string>;
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
        <ItemTable key={tab} rows={rows} now={now} {...(assign ? { assign } : {})} {...(roomLinks ? { roomLinks } : {})} />
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
        {/* Three equal tiles, one grammar: number over label. Disjoint slices
            of one denominator — no tile outranks another. */}
        <div className="nc-of-tiles">
          <button
            type="button"
            className={`nc-of-tile nc-of-hero ${slice === 'stalled' ? 'on' : ''}`}
            aria-pressed={slice === 'stalled'}
            onClick={pick('stalled')}
          >
            <span className="nc-of-tile-n stop">{counts.breached}</span>
            <span className="nc-of-tile-l">
              stalled
              <span className="nc-of-tile-sub">past a promised deadline, or owned by nobody</span>
            </span>
          </button>
          <button
            type="button"
            className={`nc-of-tile nc-of-slice ${slice === 'person' ? 'on' : ''}`}
            aria-pressed={slice === 'person'}
            onClick={pick('person')}
          >
            <span className="nc-of-tile-n warn">{counts.person}</span>
            <span className="nc-of-tile-l">need a person</span>
          </button>
          <button
            type="button"
            className={`nc-of-tile nc-of-slice ${slice === 'moving' ? 'on' : ''}`}
            aria-pressed={slice === 'moving'}
            onClick={pick('moving')}
          >
            <span className="nc-of-tile-n go">{counts.onTrack}</span>
            <span className="nc-of-tile-l">moving on their own</span>
          </button>
        </div>
        {/* The three numbers are DISJOINT slices of one denominator: every
            commitment is in exactly one. Without saying so, a reader reads
            30 and 8 as subsets of 32 and finds an arithmetic contradiction
            where there is none. */}
        <span className="nc-of-sub-total">{items.length} open commitments, split three ways</span>
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
  /** The floor's rooms — narrows a row's option list to the agents wired there. */
  rooms?: ObservatoryRoom[];
}

/* ─── One row grammar — thread, steer, hand it over ──────────────────────── */

/**
 * The agents that can act on a row, narrowed to the ROOM the row belongs to.
 *
 * Offering the whole floor on every row was offering to make an agent speak
 * somewhere it isn't wired — the server refuses that, so the option should
 * never have been there. A row whose room we cannot resolve (a claim with no
 * thread, an item with no channel, a channel not on this floor) keeps the full
 * list: narrowing on a guess would hide the only agent that can help.
 */
export function agentsForRoom(
  agents: { id: string; name: string }[],
  rooms: ObservatoryRoom[] | undefined,
  room: { key?: string | null; name?: string | null },
): { id: string; name: string }[] {
  if (!rooms || rooms.length === 0) return agents;
  const hit = room.key
    ? rooms.find((r) => r.key === room.key)
    : room.name
      ? rooms.find((r) => roomNameKey(r.name) === roomNameKey(room.name!))
      : undefined;
  if (!hit) return agents;
  const wired = new Set(hit.memberAgentIds);
  return agents.filter((a) => wired.has(a.id));
}

/**
 * Why an action was refused, in the operator's words. Shared by every surface,
 * because they all hit the same two endpoints — two rows must never explain the
 * same refusal two different ways.
 */
export function actionError(e: unknown, who: string, where?: string): string {
  const err = e as { error?: string; status?: number };
  // These endpoints ship restart-gated: until the host restarts they simply
  // aren't routed, and "unknown" would read as a bug in the work.
  if (err.status === 404 && err.error !== 'claim_not_found' && err.error !== 'item_not_on_board') {
    return 'not active until the next host restart';
  }
  if (err.error === 'claim_has_no_thread') return 'that claim has no thread recorded yet';
  if (err.error === 'item_has_no_thread') return 'the board records no thread for this item';
  if (err.error === 'recently_nudged') return 'already pushed in the last few minutes';
  if (err.error === 'recently_assigned') return 'already assigned in the last few minutes';
  if (err.error === 'just_sent_that') return 'you just sent that';
  if (err.error === 'empty_text') return 'say something first';
  if (err.error === 'text_too_long') return 'too long — keep it under 2000 characters';
  if (err.error === 'agent_not_wired_to_thread_channel') return `${who} is not wired to that thread's channel`;
  if (err.error === 'agent_not_wired_to_channel') return `${who} is not wired to ${where ?? 'that channel'}`;
  return err.error ?? 'failed';
}

/**
 * Which room a claim's actions belong to.
 *
 * Its OWN thread wins whenever it has one — that is where the work actually
 * lives, and it is the only attribution a claim file carries. A claim with no
 * thread has no room of its own, so it borrows the one it is being LOOKED at
 * in: steering a thread-less claim from a room opens its thread in that room,
 * which is a human's decision about where the work belongs rather than a guess
 * the server made. Viewed somewhere with no room either (the claims card), it
 * stays roomless and the server refuses rather than picking.
 */
export function workRoom(
  threadId: string | null,
  surface?: { key?: string | null; name?: string | null },
): { key?: string | null; name?: string | null } {
  const own = claimChannelKey(threadId);
  return own ? { key: own } : (surface ?? {});
}

/** Room names arrive with and without the hash depending on the surface. */
const hashed = (name?: string | null): string => (!name ? 'its room' : name.startsWith('#') ? name : `#${name}`);

/** What a row IS, for the one component that acts on all of them. */
export type WorkTarget =
  | {
      kind: 'claim';
      slug: string;
      /** Whether the push-forward button is offered at all — see claimPushable. */
      pushable: boolean;
    }
  | { kind: 'item'; id: string; channel?: string | undefined; assignable: boolean };

/**
 * Whether a claim can be pushed forward.
 *
 * Two conditions, and BOTH are the server's, not a UI preference:
 *
 * - it has stopped moving (or was already escalated). A live claim is being
 *   done, and a push is a demand for an answer, not a ping;
 * - it has a thread. `POST /observatory/nudge` composes the demand into the
 *   claim's OWN thread and 409s `claim_has_no_thread` when there is none — it
 *   deliberately has no named-room fallback (steer's is a different doctrine:
 *   see nudge.ts's header). A button whose only outcome is that 409 is worse
 *   than no button.
 *
 * Read off the claim by every surface that draws one, so the room sheet, the
 * agent drawer and the claims card can never disagree about which work is
 * pushable — the room sheet used to hardcode "no" and silently offered less.
 */
export function claimPushable(c: Pick<ObservatoryClaim, 'state' | 'escalated' | 'threadId'>): boolean {
  return (c.state !== 'live' || c.escalated) && Boolean(c.threadId);
}

/**
 * Transcripts already fetched this page-load, keyed by session.
 *
 * ponytail: no invalidation and no SSE subscription — the pane is "what was
 * just said, so you know what you are answering", and re-opening a composer
 * must not re-hit the API. Subscribe it to `session_event` the way
 * SessionDetail does if a steer's own reply ever needs to land here live.
 */
const threadCache = new Map<string, SessionTranscriptEntry[]>();

/**
 * The conversation, inline, above the box you are about to type in.
 *
 * The legacy dashboard made you leave the board to read a thread; a claim slug
 * is a code name, so steering one meant steering work you could not identify.
 * Same renderer the session page uses ({@link TranscriptList}) — a thread must
 * not read two different ways in two places — but ordered oldest-first and
 * pinned to the bottom, because what you are answering is the LAST thing said.
 */
function ThreadPane({ sessionId }: { sessionId: string | null }) {
  const [entries, setEntries] = useState<SessionTranscriptEntry[] | null>(
    sessionId ? (threadCache.get(sessionId) ?? null) : null,
  );
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sessionId) {
      setEntries(null);
      return;
    }
    const hit = threadCache.get(sessionId);
    if (hit) {
      setEntries(hit);
      return;
    }
    let live = true;
    setFailed(false);
    void getSessionDetail(sessionId)
      .then((d) => {
        threadCache.set(sessionId, d.transcript);
        if (live) setEntries(d.transcript);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (!sessionId) return <p className="nc-obs-steer-nopane">no conversation yet — this opens the first one</p>;
  if (failed) return <p className="nc-obs-steer-nopane">couldn’t load the conversation</p>;
  if (!entries) return <p className="nc-obs-steer-nopane">reading the thread…</p>;
  return (
    <div className="nc-obs-steer-thread" ref={box} data-thread={sessionId}>
      <TranscriptList entries={[...entries].reverse().map(normalizeSessionEntry)} />
    </div>
  );
}

/**
 * The action row every claim and every item gets, everywhere it renders: the
 * link back to its thread, a composer for saying something into that thread,
 * and the select that hands it to somebody.
 *
 * ONE component on purpose. These affordances used to be three near-identical
 * controls bolted onto whichever surface last needed them, so the claims card
 * could push work forward and the room sheet could only link at it. A row is a
 * row wherever it is drawn.
 *
 * The composer is collapsed until asked for, which is what lets the same
 * component sit in a dense held-claims list and on a full-width table row
 * without two layouts.
 */
function WorkActions({
  target,
  threadUrl,
  sessionId,
  wiring,
  room,
  ownerAgent,
  decide,
}: {
  target: WorkTarget;
  threadUrl: string | null;
  /**
   * The conversation behind this row, when there is one. A claim slug is a
   * coded name — you cannot know what `xzo-whats-new-817` is about without
   * reading its thread, so opening the composer opens the thread WITH it.
   */
  sessionId?: string | null;
  wiring?: AssignWiring;
  /** The room this row belongs to — narrows the option list. Both fields may be null. */
  room: { key?: string | null; name?: string | null };
  /** The current owner as an agent id — the default addressee. Null when a human holds it. */
  ownerAgent: string | null;
  /**
   * Decisions view only: open the composer already, with the ask in the box.
   * The composer, the confirm line and the send are the SAME ones every other
   * row gets — this only decides what is in the box when it opens.
   */
  decide?: { prefill: string };
}) {
  // The thread this row knows about. `threadUrl` is what the snapshot said;
  // `opened` is what a send just created — a steer that OPENS a thread hands it
  // back in the response, and the row must not keep claiming it has none for
  // the fifteen seconds until the next poll agrees.
  const [opened, setOpened] = useState<string | null>(null);
  const liveThreadUrl = threadUrl ?? opened;

  // A claim with no thread has no room of its own, and no surface to borrow one
  // from when it is looked at on the claims card. That used to end the row: no
  // room, no controls. But "which room does this open in" is a human's decision
  // the server has always been willing to take (steer's `channel`), so the row
  // ASKS instead of going quiet. Only offered where there is genuinely nothing
  // else to aim at — a row with a thread, or viewed inside a room, never sees it.
  const [pickedRoom, setPickedRoom] = useState('');
  const roomChoices = wiring?.rooms ?? [];
  const needsRoom = !liveThreadUrl && !room.name && roomChoices.length > 0;
  const land = needsRoom && pickedRoom ? { name: pickedRoom } : room;

  const choices = wiring ? agentsForRoom(wiring.agents, wiring.rooms, land) : [];
  // Somewhere for the ask to LAND: the work's own thread, or a room — named by
  // the surface it is being viewed in, or picked above (either lets the server
  // open one). Neither means no action is offered at all — a button whose only
  // outcome is the server refusing it is worse than the honest empty state.
  const canLand = Boolean(liveThreadUrl) || Boolean(land.name);
  // Whether this row can send AT ALL. The Decisions view opens the composer on
  // expand, so this gate matters: a member, or a row with nowhere to land,
  // would otherwise get a prefilled box whose send can only ever be refused.
  const canSteer = Boolean(wiring) && canLand && choices.length > 0;

  const [rawAgentId, setAgentId] = useState(
    ownerAgent && choices.some((a) => a.id === ownerAgent) ? ownerAgent : '',
  );
  // Picking a room re-narrows the addressees, so an agent chosen against the
  // PREVIOUS room can fall out of the list. The select would render blank while
  // the state still held them — and the send would then go to somebody the
  // operator can no longer see. Nobody is the honest reading of that.
  const agentId = choices.some((a) => a.id === rawAgentId) ? rawAgentId : '';
  const [composing, setComposing] = useState(Boolean(decide) && canSteer);
  const [text, setText] = useState(decide?.prefill ?? '');
  const box = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; note?: string; url?: string }>({
    phase: 'idle',
  });

  const who = choices.find((a) => a.id === agentId)?.name ?? 'that agent';
  const busy = state.phase === 'busy';

  // A chip only fills the box. Sending is still the operator reading what is
  // about to go out and pressing send — a one-tap chip that also SENT would be
  // a one-tap way to say "no" to the wrong piece of work.
  const tap = (t: string) => {
    setText(t);
    const el = box.current;
    if (el) {
      el.focus();
      el.setSelectionRange(t.length, t.length);
    }
  };

  const primary =
    target.kind === 'claim'
      ? target.pushable
        ? { label: 'push it forward', busyLabel: 'pushing…' }
        : null
      : target.assignable && target.channel
        ? { label: `task it in ${target.channel}`, busyLabel: 'assigning…' }
        : null;

  const runPrimary = async () => {
    if (!wiring || !agentId) return;
    setState({ phase: 'busy' });
    try {
      if (target.kind === 'claim') {
        const r = await nudgeClaim(wiring.workgroupId, target.slug, agentId);
        setState({ phase: 'done', note: 'pushed — the ask landed in its thread', ...(r.threadUrl ? { url: r.threadUrl } : {}) });
      } else {
        const r = await assignItem(wiring.workgroupId, target.id, agentId);
        setState({ phase: 'done', note: `assigned — ${r.agent} was tasked in ${r.channel}` });
      }
    } catch (e) {
      setState({ phase: 'error', note: actionError(e, who, target.kind === 'item' ? target.channel : undefined) });
    }
  };

  const send = async () => {
    if (!wiring || !agentId || !text.trim()) return;
    setState({ phase: 'busy' });
    try {
      const what = target.kind === 'claim' ? { claimSlug: target.slug } : { itemId: target.id };
      const r = await steerWork(wiring.workgroupId, what, agentId, text.trim(), land.name ?? undefined);
      setText('');
      setComposing(false);
      // The thread the server just opened is this row's thread from now on —
      // for a claim the server also records it back onto the claim file, so
      // the next poll agrees. Until then, this is what stops the row from
      // offering to open a SECOND one.
      if (r.threadUrl) setOpened(r.threadUrl);
      setState({ phase: 'done', note: `sent — ${who} was asked in the thread`, ...(r.threadUrl ? { url: r.threadUrl } : {}) });
    } catch (e) {
      setState({ phase: 'error', note: actionError(e, who, land.name ?? undefined) });
    }
  };

  return (
    <div className="nc-obs-actions" data-actions={target.kind}>
      <div className="nc-obs-actions-row">
        {liveThreadUrl ? (
          <OutLink href={liveThreadUrl}>open thread</OutLink>
        ) : (
          <span className="nc-of-sheet-nothread">no thread recorded</span>
        )}
        {/* The one question this row cannot answer for itself. Nothing is
            offered downstream of it until it is answered — picking a room is
            what gives the ask somewhere to land. */}
        {wiring && needsRoom && (
          <select
            aria-label="Room to open this in"
            className="nc-obs-actions-room"
            value={pickedRoom}
            onChange={(e) => setPickedRoom(e.target.value)}
            disabled={busy}
          >
            <option value="">open it in…</option>
            {roomChoices.map((r) => (
              <option key={r.key} value={r.name}>
                {hashed(r.name)}
              </option>
            ))}
          </select>
        )}
        {wiring &&
          canLand &&
          (choices.length === 0 ? (
            <span className="nc-obs-actions-none">no agent is wired to this room</span>
          ) : (
            <>
              <select
                aria-label="Agent for this work"
                className="nc-obs-actions-who"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                disabled={busy}
              >
                <option value="">hand it to…</option>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="nc-obs-actions-steer"
                aria-expanded={composing}
                onClick={() => setComposing((c) => !c)}
                disabled={!agentId || busy}
              >
                steer
              </button>
              {primary && (
                <button type="button" onClick={runPrimary} disabled={!agentId || busy}>
                  {busy ? primary.busyLabel : primary.label}
                </button>
              )}
            </>
          ))}
      </div>
      {composing && (
        <>
          {/* Where this is about to land, stated before it is sent. With no
              thread yet the send OPENS one, and the room it opens in is the
              thing an operator must be able to see and change their mind
              about — the server is never the one choosing it. */}
          <p className="nc-obs-steer-target">
            {liveThreadUrl ? 'goes into the existing thread' : `opens a new thread in ${hashed(land.name)}`}
          </p>
          <ThreadPane sessionId={sessionId ?? null} />
          {decide && (
            <div className="nc-obs-steer-chips" role="group" aria-label="One-tap answers">
              {DECISION_CHIPS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className="nc-of-chip"
                  data-chip={c.label}
                  onClick={() => tap(c.text)}
                  disabled={busy}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <div className="nc-obs-steer">
            <textarea
              ref={box}
              aria-label="Steer message"
              rows={2}
              maxLength={2000}
              placeholder={`say something to ${who}…`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
            <button type="button" onClick={send} disabled={!text.trim() || busy}>
              {busy ? 'sending…' : 'send'}
            </button>
          </div>
        </>
      )}
      {state.phase === 'done' && (
        <div className="nc-obs-actions-done">
          {state.note}
          {state.url ? <> — <OutLink href={state.url}>open thread</OutLink></> : null}
        </div>
      )}
      {state.phase === 'error' && <span className="nc-obs-actions-err">{state.note}</span>}
    </div>
  );
}

/**
 * What the linked issue actually says, fetched live when the row opens. A
 * person deciding needs the body QA wrote and the latest comments (where a
 * proposed default and its do-by live) — without leaving the page. Ids-only
 * to the server; the module cache means re-expanding a row costs nothing.
 */
const briefCache = new Map<string, IssueBrief>();

/** Test-only — the cache is module-level and would bleed between tests. */
export function _resetBriefCacheForTesting(): void {
  briefCache.clear();
}

function IssueBriefPane({ workgroupId, itemId }: { workgroupId: string; itemId: string }) {
  const [brief, setBrief] = useState<IssueBrief | null>(briefCache.get(`${workgroupId}:${itemId}`) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (brief) return;
    let gone = false;
    getIssueBrief(workgroupId, itemId)
      .then((b) => {
        briefCache.set(`${workgroupId}:${itemId}`, b);
        if (!gone) setBrief(b);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
    };
  }, [workgroupId, itemId, brief]);

  if (failed) return <div className="nc-obs-brief-empty">couldn’t read the issue — use the link above</div>;
  if (!brief) return <div className="nc-obs-brief-empty">reading the issue…</div>;
  const now = Date.now();
  return (
    <div className="nc-obs-brief">
      <div className="nc-obs-brief-labels">
        <span className={`nc-obs-brief-state ${brief.state}`}>{brief.state}</span>
        {brief.labels.map((l) => (
          <span key={l} className="nc-obs-brief-label">{l}</span>
        ))}
      </div>
      {brief.body && (
        <div className="nc-obs-brief-body">
          {brief.body}
          {brief.bodyTruncated && '…'}
        </div>
      )}
      {brief.comments.length > 0 && (
        <div className="nc-obs-brief-comments">
          {brief.commentCount > brief.comments.length && (
            <div className="nc-obs-brief-more">
              {brief.commentCount - brief.comments.length} earlier — latest {brief.comments.length} shown
            </div>
          )}
          {brief.comments.map((c) => (
            <div key={c.at} className="nc-obs-brief-comment">
              <span className="nc-obs-brief-author">
                {c.author} · {magnitude(now - Date.parse(c.at), now)} ago
              </span>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      )}
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
  roomLinks,
  decide = false,
}: {
  c: Commitment;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  assign?: AssignWiring;
  /** Channel name → room permalink; see roomLinkIndex. */
  roomLinks?: Map<string, string>;
  /** Decisions view: the ask reads on the row, and the composer opens with it. */
  decide?: boolean;
}) {
  const item = c.item;
  const roomLink = item.channel ? roomLinks?.get(item.channel.replace(/^#/, '').toLowerCase()) : undefined;
  const ship = decide ? shipInstruction(item.nextAction) : null;
  const shipTo = ship ? shipAddressee(ship, assign?.agents ?? []) : null;
  const [shipState, setShipState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; note?: string; url?: string }>(
    { phase: 'idle' },
  );
  // One click fires the send (operator ruling,
  // 2026-08-18: "clicking should be 1 click instead of it opening up the row
  // and having to click send again"). The
  // button only renders when the instruction names an addressee on this
  // floor, so the one click can never land on a dead composer; an
  // unresolvable handle keeps the old open-the-row behavior instead.
  const fireShip = async () => {
    if (!assign || !ship || !shipTo) return;
    setShipState({ phase: 'busy' });
    const who = assign.agents.find((a) => a.id === shipTo)?.name ?? 'that agent';
    try {
      const r = await steerWork(assign.workgroupId, { itemId: item.id }, shipTo, ship, item.channel ?? undefined);
      setShipState({ phase: 'done', note: `sent — ${who} was asked in the thread`, ...(r.threadUrl ? { url: r.threadUrl } : {}) });
    } catch (e) {
      setShipState({ phase: 'error', note: actionError(e, who, item.channel ?? undefined) });
    }
  };
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
      {/* On the Decisions view the ask is the point of the row, so it reads
          BEFORE the row is opened — a ranked list you have to expand item by
          item to find out what is being asked is not one pass. */}
      {decide && (item.nextAction || ship) && (
        <div className="nc-obs-decide-line">
          {item.nextAction && <p className="nc-obs-decide-ask">{item.nextAction}</p>}
          {/* The board named an exact instruction, so the button IS that
              instruction — one click sends it as you (operator ruling, 2026-08-18;
              this replaced the earlier open-the-confirm step). Collapsed rows
              only: once the composer is open it is the surface, and a button
              that ignored text the operator had edited would be worse than
              either. An instruction whose handle matches nobody on this floor
              falls back to opening the row, never to a guessed addressee. */}
          {ship && assign && !expanded && shipState.phase !== 'done' && (
            <button
              type="button"
              className="nc-obs-ship"
              data-ship={ship}
              title={shipTo ? 'sends into the work’s thread as you' : 'opens the row to pick who this goes to'}
              onClick={shipTo ? fireShip : onToggle}
              disabled={shipState.phase === 'busy'}
            >
              {shipState.phase === 'busy' ? 'sending…' : (
                <>send: <span className="mono">{ship}</span></>
              )}
            </button>
          )}
          {shipState.phase === 'done' && (
            <div className="nc-obs-actions-done">
              {shipState.note}
              {shipState.url ? <> — <OutLink href={shipState.url}>open thread</OutLink></> : null}
            </div>
          )}
          {shipState.phase === 'error' && <span className="nc-obs-actions-err">{shipState.note}</span>}
        </div>
      )}
      {expanded && (
        <div className="nc-obs-ledger-detail">
          {/* Not repeated when the row already states it above. */}
          {item.nextAction && !decide && <div className="nc-obs-ledger-next">next: {item.nextAction}</div>}
          {item.why && <div>{item.why}</div>}
          <div className="nc-obs-ledger-meta">
            {LEDGER_STATE_LABEL[c.state]}
            {item.owner ? ` · ${item.owner}` : ''}
          </div>
          {item.url && <OutLink href={item.url}>{itemLinkLabel(item.kind)}</OutLink>}
          {/* The decision needs what the ISSUE says, not just the board's one
              line — body, labels, latest comments, fetched live on open. */}
          {decide && assign && item.url && <IssueBriefPane workgroupId={assign.workgroupId} itemId={item.id} />}
          {/* Handing a person's own item to an agent is not the move — the
              whole point of this row is that a PERSON has to answer it. It
              says where, instead of offering to route it away — and takes them
              there when the room has a permalink. The arrow belongs to the
              link: dead text pointing nowhere is worse than a plain sentence. */}
          {item.nextMover === 'human' && (
            <div className="nc-obs-needsyou">
              this needs you
              {item.channel && roomLink ? (
                <>
                  {' — '}
                  <OutLink href={roomLink}>{`answer in ${item.channel}`}</OutLink>
                </>
              ) : item.channel ? (
                ` — answer in ${item.channel}`
              ) : (
                ''
              )}
            </div>
          )}
          {/* The same actions every other row gets. An item the board says a
              PERSON must answer still gets a thread link and a composer — it
              just isn't offered an agent to route it away to. */}
          <WorkActions
            target={{
              kind: 'item',
              id: item.id,
              channel: item.channel,
              assignable: item.nextMover !== 'human',
            }}
            threadUrl={null}
            room={{ name: item.channel ?? null }}
            // The instruction names who must act, so the confirm opens with
            // them already selected. Every other surface still defaults to
            // nobody — there is no addressee to read off an ordinary row.
            ownerAgent={shipAddressee(ship, assign?.agents ?? [])}
            {...(assign ? { wiring: assign } : {})}
            {...(decide ? { decide: { prefill: ship ?? '' } } : {})}
          />
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
  roomLinks,
  head = true,
  decide = false,
}: {
  rows: Commitment[];
  now: number;
  assign?: AssignWiring;
  roomLinks?: Map<string, string>;
  /** The column header. On by default; the queue is titled by its card. */
  head?: boolean;
  /** Passed straight down — see ItemRow. */
  decide?: boolean;
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
            decide={decide}
            {...(assign ? { assign } : {})}
            {...(roomLinks ? { roomLinks } : {})}
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

/* ─── The queue's own filters ────────────────────────────────────────────── */

/**
 * The two commitment states worth a chip. Five states exist; the other three
 * (undated, due-soon, on-track) describe work behaving itself, and a chip per
 * enum value turns a filter into a legend — the same choice the claims card
 * made in picking two of four.
 */
export const QUEUE_FILTERS: { key: Commitment['state']; label: string; empty: string }[] = [
  { key: 'breached', label: 'past its promise', empty: 'is past its promise' },
  { key: 'unowned', label: 'nobody owns it', empty: 'is unowned' },
];

export type QueueSort = 'oldest' | 'newest';

/** Distinct owners on these rows, sorted — the vocabulary of the owner select. */
export function queueOwners(rows: Commitment[]): string[] {
  const named = rows.map((r) => r.item.owner).filter((o): o is string => !!o);
  return [...new Set(named)].sort((a, b) => a.localeCompare(b));
}

/** Distinct rooms on these rows, sorted — the vocabulary of the room select. */
export function queueRooms(rows: Commitment[]): string[] {
  const named = rows.map((r) => r.item.channel).filter((c): c is string => !!c);
  return [...new Set(named)].sort((a, b) => a.localeCompare(b));
}

export interface QueueFilter {
  state: Commitment['state'] | null;
  owner: string | null;
  room: string | null;
}

/**
 * Rows narrowed by state, owner and room. All three COMPOSE — the answer to
 * "what has ava let slip in #dispatch" is one list, not three unioned ones.
 * A null on any axis means "don't narrow on this".
 */
export function filterQueue(rows: Commitment[], f: QueueFilter): Commitment[] {
  const key = (s: string) => s.trim().toLowerCase().replace(/^#/, '');
  return rows.filter(
    (r) =>
      (!f.state || r.state === f.state) &&
      (!f.owner || (r.item.owner ? key(r.item.owner) === key(f.owner) : false)) &&
      (!f.room || (r.item.channel ? key(r.item.channel) === key(f.room) : false)),
  );
}

/**
 * By age, oldest or newest first. Rows whose age is UNKNOWN sort last either
 * way: an item with no `since` has no place on a time axis, and defaulting it
 * to zero would park every undated row at one end and call that an ordering.
 */
export function sortQueue(rows: Commitment[], order: QueueSort): Commitment[] {
  return [...rows].sort((a, b) => {
    if (a.ageMs === null || b.ageMs === null) return (a.ageMs === null ? 1 : 0) - (b.ageMs === null ? 1 : 0);
    return order === 'oldest' ? b.ageMs - a.ageMs : a.ageMs - b.ageMs;
  });
}

/** What the queue narrowed to, in words, for the empty state. */
export function queueFilterPhrase(f: QueueFilter): string {
  const parts = [
    f.state ? (QUEUE_FILTERS.find((q) => q.key === f.state)?.empty ?? `is ${f.state}`) : null,
    f.owner ? `is owned by ${f.owner}` : null,
    f.room ? `lives in ${f.room}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'to show' : parts.join(' and ');
}

/** The queue's filter row — Fix C's grammar, one more select and a sort toggle. */
function QueueFilterBar({
  filter,
  onFilter,
  owners,
  rooms,
  sort,
  onSort,
}: {
  filter: QueueFilter;
  onFilter: (f: QueueFilter) => void;
  owners: string[];
  rooms: string[];
  sort: QueueSort | null;
  onSort: (s: QueueSort | null) => void;
}) {
  const active = filter.state || filter.owner || filter.room || sort;
  return (
    <div className="nc-of-filters" role="group" aria-label="Filter the queue">
      {QUEUE_FILTERS.map((q) => (
        <button
          key={q.key}
          type="button"
          className={`nc-of-chip ${filter.state === q.key ? 'on' : ''}`}
          data-queue-filter={q.key}
          aria-pressed={filter.state === q.key}
          onClick={() => onFilter({ ...filter, state: filter.state === q.key ? null : q.key })}
        >
          {q.label}
        </button>
      ))}
      {owners.length > 0 && (
        <select
          aria-label="Filter the queue by owner"
          value={filter.owner ?? ''}
          onChange={(e) => onFilter({ ...filter, owner: e.target.value || null })}
        >
          <option value="">any owner</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      {rooms.length > 0 && (
        <select
          aria-label="Filter the queue by room"
          value={filter.room ?? ''}
          onChange={(e) => onFilter({ ...filter, room: e.target.value || null })}
        >
          <option value="">any room</option>
          {rooms.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
      {/* Off by default: the ledger's own ranking — worst first, oldest failure
          leading — is the answer to "what is stuck", and a sort that overrides
          it is a deliberate question about time, not a default view. */}
      <button
        type="button"
        className={`nc-of-chip ${sort ? 'on' : ''}`}
        data-queue-sort={sort ?? 'off'}
        aria-pressed={sort !== null}
        onClick={() => onSort(sort === null ? 'oldest' : sort === 'oldest' ? 'newest' : null)}
      >
        {sort === 'oldest' ? 'oldest first' : sort === 'newest' ? 'newest first' : 'by age'}
      </button>
      {active && (
        <button
          type="button"
          className="nc-of-clearfilter"
          onClick={() => {
            onFilter({ state: null, owner: null, room: null });
            onSort(null);
          }}
        >
          show all
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
  roomLinks,
}: {
  items: ReleaseItem[];
  now?: number;
  roomLinks?: Map<string, string>;
  /** Headline slice the queue is filtered to, or null for everything open. */
  slice?: FlowSlice | null;
  /** Present only for roles that may assign; absent hides the control. */
  assign?: AssignWiring;
}) {
  const [filter, setFilter] = useState<QueueFilter>({ state: null, owner: null, room: null });
  const [sort, setSort] = useState<QueueSort | null>(null);
  const ledger = useMemo(() => buildLedger(items, now), [items, now]);
  // Unfiltered, the queue is everything NOT moving on its own; picking
  // "moving" is the one case that widens it rather than narrowing it.
  //
  // Filtered on the SAME slices the headline counts, deliberately. The old
  // default (state !== 'on-track') admitted agent-owned undated rows that the
  // headline had already counted under "moving", so the board's own "62 of 70"
  // could disagree with the number of rows under it.
  const all = ledger.rows.filter((r) => (slice ? flowSlice(r) === slice : flowSlice(r) !== 'moving'));
  // The selects offer what is in THIS slice, so a filter can never name a
  // vocabulary the rows in front of you don't have.
  const owners = queueOwners(all);
  const rooms = queueRooms(all);
  const narrowed = filterQueue(all, filter);
  const shown = sort ? sortQueue(narrowed, sort) : narrowed;

  const bar = (
    <QueueFilterBar
      filter={filter}
      onFilter={setFilter}
      owners={owners}
      rooms={rooms}
      sort={sort}
      onSort={setSort}
    />
  );

  // The two coverage gaps are stated ONCE, in the headline above. Repeating
  // them here read as two separate warnings about two separate problems.
  if (all.length === 0) {
    return (
      <div className="nc-obs-ledger-empty">
        {slice ? 'nothing in this slice' : 'every open commitment is on track'}
      </div>
    );
  }
  return (
    <>
      {bar}
      {shown.length === 0 ? (
        <div className="nc-obs-ledger-empty">{`nothing here ${queueFilterPhrase(filter)}`}</div>
      ) : (
        <ItemTable
          // A filter change is a different list; the fold and any open row
          // belong to the list they were opened in.
          key={`${filter.state}|${filter.owner}|${filter.room}|${sort}`}
          rows={shown}
          now={now}
          head={false}
          {...(assign ? { assign } : {})}
          {...(roomLinks ? { roomLinks } : {})}
        />
      )}
    </>
  );
}

/* ─── Decisions — what is waiting on a person ────────────────────────────── */

/**
 * Every item whose next mover is a PERSON, in the ledger's own order.
 *
 * Not `flowSlice(r) === 'person'`, deliberately: that slice drops anything in
 * the breach tier, and a decision that has already blown its deadline is the
 * first one you want to see, not the one that vanishes. Ranking is
 * `buildLedger`'s — release blockers outright first, then the oldest breach —
 * so this view and the queue never disagree about which item is worst.
 */
export function decisionRows(items: ReleaseItem[], now = Date.now()): Commitment[] {
  const rows = buildLedger(items, now).rows.filter((r) => r.item.nextMover === 'human');
  // Within a severity tier, the ask that names its exact instruction leads its
  // peers: it is the cheapest row on the page to clear (one tap), and ship
  // instructions are usually undated, so ledger order alone buried the ship
  // button below the first page behind older prose asks. Tiers still win —
  // a release blocker or a breach never drops below an on-track one-tap, so
  // the tier key mirrors everything the ledger sort ranks above age.
  const tier = (r: Commitment) => `${Boolean(r.item.blocksRelease)}|${r.state}`;
  const out: Commitment[] = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && tier(rows[j]) === tier(rows[i])) j++;
    const run = rows.slice(i, j);
    out.push(
      ...run.filter((r) => shipInstruction(r.item.nextAction)),
      ...run.filter((r) => !shipInstruction(r.item.nextAction)),
    );
    i = j;
  }
  return out;
}

/**
 * The relayable instruction inside an ask, if there is one.
 *
 * Real asks read "<person> record @<bot> ship 869; <someone> or a human
 * presses the merge -- self-authored -- stalled 28h". The decision is a
 * sentence of context, but the ACTION is the four words in the middle, and
 * those are the words that have to reach the agent. Everything else is prose
 * for the human and would be noise in the agent's thread — so the box gets the
 * instruction alone, and prose-only asks get an empty box rather than a
 * paraphrase this function invented.
 */
export function shipInstruction(nextAction?: string): string | null {
  return nextAction?.match(/@[\w-]+\s+ship\s+[\w-]+(?:\s+\d+)?/i)?.[0] ?? null;
}

/**
 * The agent an instruction is ADDRESSED to — "@nova ship 912" names nova.
 *
 * Only ever a lookup: a handle matching no agent on this floor resolves to
 * null and the operator picks from the select as before. The ship button needs
 * this or its one tap lands on a confirm whose send is disabled, which is not
 * a confirm, it is a dead end.
 */
export function shipAddressee(instruction: string | null, agents: { id: string; name: string }[]): string | null {
  const handle = instruction?.match(/^@([\w-]+)/)?.[1]?.toLowerCase();
  return (handle && agents.find((a) => a.name.trim().toLowerCase() === handle)?.id) || null;
}

/**
 * The one-tap answers. Chips SET the box and nothing else — the send is still
 * the operator reading what is about to go out. "no" is left mid-sentence on
 * purpose: a refusal with no reason is the one answer that always costs
 * another round trip.
 */
const DECISION_CHIPS: { label: string; text: string }[] = [
  { label: 'approve as proposed', text: 'approve as proposed' },
  { label: 'hold — need more info', text: 'hold — need more info' },
  { label: 'no — …', text: 'no — ' },
];

/**
 * The Decisions view: the ranked queue of what awaits a human, each row
 * carrying its ask and a composer already holding the answer.
 *
 * It builds nothing new. The rows are the ledger's, the row grammar is
 * `ItemRow`'s, the composer and its confirm line are `WorkActions`', and the
 * send is the same `POST /observatory/steer` every other steer uses. What is
 * new is only that they arrive together, filtered to the one question a
 * two-person shop actually opens this page to ask.
 */
function DecisionsCard({
  items,
  now = Date.now(),
  assign,
  roomLinks,
}: {
  items: ReleaseItem[];
  now?: number;
  assign?: AssignWiring;
  roomLinks?: Map<string, string>;
}) {
  const rows = useMemo(() => decisionRows(items, now), [items, now]);
  return (
    <section className="nc-of-card" data-section="decisions">
      <header className="nc-of-card-head">
        <span className="nc-of-card-title">Waiting on you</span>
        <span className="nc-of-card-meta">
          {rows.length === 0 ? 'nothing open' : `${rows.length} of ${items.length} · worst first`}
        </span>
      </header>
      {rows.length === 0 ? (
        <div className="nc-obs-ledger-empty">nothing needs a human right now</div>
      ) : (
        <ItemTable
          rows={rows}
          now={now}
          head={false}
          decide
          {...(assign ? { assign } : {})}
          {...(roomLinks ? { roomLinks } : {})}
        />
      )}
    </section>
  );
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

/**
 * The claims filter — the same grammar the queue uses (Fix D): chips for the
 * states worth singling out, a native select for "whose". Two chips, not four:
 * `expiring` and `live` are the claims working AS INTENDED, and a chip per
 * enum value would have turned a filter into a legend.
 */
export const CLAIM_FILTERS: { key: ObservatoryClaimState; label: string; empty: string }[] = [
  // `empty` is the chip label bent into a sentence — "nothing is abandoned"
  // works, "nothing is needs an owner" does not, so each chip carries its own
  // fragment rather than the empty state gluing "is" onto whatever it finds.
  { key: 'stale', label: 'abandoned', empty: 'is abandoned' },
  { key: 'parked', label: 'needs an owner', empty: 'needs an owner' },
];

/** Distinct claim owners, sorted — the vocabulary of the "by agent" select. */
export function claimOwners(claims: ObservatoryClaim[]): string[] {
  const named = claims.map((c) => c.owner).filter((o): o is string => !!o && o !== 'unknown');
  return [...new Set(named)].sort((a, b) => a.localeCompare(b));
}

/**
 * Claims narrowed by state and/or owner. Both filters COMPOSE — picking
 * "abandoned" and then an owner asks for that owner's abandoned work, not for
 * the union. A null on either side means "don't narrow on this".
 */
export function filterClaims(
  claims: ObservatoryClaim[],
  state: ObservatoryClaimState | null,
  owner: string | null,
): ObservatoryClaim[] {
  return claims.filter(
    (c) =>
      (!state || c.state === state) &&
      (!owner || c.owner?.trim().toLowerCase() === owner.trim().toLowerCase()),
  );
}

/**
 * What the operator asked for, in words, for the empty state. A board that
 * answers a narrowed question with a bare "nothing here" makes them re-derive
 * their own filters to understand the emptiness.
 */
export function activeFilterPhrase(state: ObservatoryClaimState | null, owner: string | null): string {
  const frag = state ? (CLAIM_FILTERS.find((f) => f.key === state)?.empty ?? `is ${state}`) : null;
  if (frag && owner) return `${owner} holds ${frag}`;
  if (frag) return frag;
  if (owner) return `is held by ${owner}`;
  return 'to show';
}

/**
 * The filter row: chips for state, a native select for whose. One grammar,
 * shared with the queue — chips narrow by a fixed vocabulary, the select
 * narrows by a name the data supplies. Native controls throughout; a custom
 * dropdown here would be a worse <select> that also has to be maintained.
 */
function ClaimFilterBar({
  state,
  onState,
  owner,
  owners,
  onOwner,
}: {
  state: ObservatoryClaimState | null;
  onState: (s: ObservatoryClaimState | null) => void;
  owner: string | null;
  owners: string[];
  onOwner: (o: string | null) => void;
}) {
  return (
    <div className="nc-of-filters" role="group" aria-label="Filter work claims">
      {CLAIM_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          className={`nc-of-chip ${state === f.key ? 'on' : ''}`}
          data-claim-filter={f.key}
          aria-pressed={state === f.key}
          onClick={() => onState(state === f.key ? null : f.key)}
        >
          {f.label}
        </button>
      ))}
      {owners.length > 0 && (
        <select
          aria-label="Filter claims by agent"
          value={owner ?? ''}
          onChange={(e) => onOwner(e.target.value || null)}
        >
          <option value="">any agent</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      {(state || owner) && (
        <button type="button" className="nc-of-clearfilter" onClick={() => { onState(null); onOwner(null); }}>
          show all
        </button>
      )}
    </div>
  );
}

/** Red once the deadline has passed or the claim was announced; amber inside the grace window. */
function claimTone(c: ObservatoryClaim): string {
  if (c.state === 'stale' || c.escalated) return 'stop';
  if (c.state === 'expiring') return 'warn';
  return '';
}

/**
 * The owner cell. A parked claim carries the name of whoever PUT IT DOWN, not
 * of anyone currently working it — and the row already says "needs an owner"
 * a few pixels away. A bare name in that position read as the current owner
 * and flatly contradicted the tag beside it, so say what the name means.
 */
export function claimOwnerLabel(c: ObservatoryClaim): string {
  const named = c.owner && c.owner !== 'unknown' ? c.owner : null;
  if (!named) return 'owner unknown';
  return c.state === 'parked' ? `parked by ${named}` : named;
}


/** The claim's owner, as an agent id — null when a human (or nobody known) holds it. */
function ownerAgentId(claim: ObservatoryClaim, agents: { id: string; name: string }[]): string | null {
  const owner = claim.owner?.trim().toLowerCase();
  if (!owner || owner === 'unknown') return null;
  return agents.find((a) => a.name.trim().toLowerCase() === owner)?.id ?? null;
}

/**
 * One claim row: title/owner/age, expanding to the note, thread link, and
 * (when it has stopped moving) push-forward / hand-over controls. Shared by
 * the claims card and the agent drawer's "needs a human" section — same row,
 * same controls, wherever a claim is stuck enough to need one.
 */
function ClaimRow({
  c,
  expanded,
  onToggle,
  room,
  assign,
}: {
  c: ObservatoryClaim;
  expanded: boolean;
  onToggle: () => void;
  /** The room this row is being VIEWED in — see workRoom. */
  room?: { key?: string | null; name?: string | null };
  assign?: AssignWiring;
}) {
  const ownerAgent = assign ? ownerAgentId(c, assign.agents) : null;
  return (
    <li className={`nc-obs-claim-row ${c.state}`} data-slug={c.slug}>
      <button type="button" className="nc-obs-claim-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span className="nc-obs-claim-title">
          <span className="nc-obs-claim-slug mono">{c.slug}</span>
          {c.state === 'parked' && <span className="nc-obs-claim-tag">needs an owner</span>}
          {c.escalated && <span className="nc-obs-claim-tag">escalated in channel</span>}
        </span>
        <span className="nc-obs-claim-owner">
          {c.owner && c.owner !== 'unknown' ? claimOwnerLabel(c) : <em>owner unknown</em>}
        </span>
        <span className={`nc-obs-claim-age ${claimTone(c)}`}>{claimAgeLabel(c)}</span>
      </button>
      {expanded && (
        <div className="nc-obs-claim-detail">
          {c.note && <div className="nc-obs-claim-note">{c.note}</div>}
          <WorkActions
            target={{ kind: 'claim', slug: c.slug, pushable: claimPushable(c) }}
            threadUrl={c.threadUrl}
            sessionId={c.sessionId}
            room={workRoom(c.threadId, room)}
            ownerAgent={ownerAgent}
            {...(assign ? { wiring: assign } : {})}
          />
        </div>
      )}
    </li>
  );
}

function ClaimsCard({
  claims,
  expandedSlug,
  onClaimClick,
  assign,
}: {
  claims: ObservatoryClaim[];
  expandedSlug: string | null;
  onClaimClick: (claim: ObservatoryClaim) => void;
  assign?: AssignWiring;
}) {
  const [stateFilter, setStateFilter] = useState<ObservatoryClaimState | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const owners = useMemo(() => claimOwners(claims), [claims]);
  const shown = useMemo(() => filterClaims(claims, stateFilter, ownerFilter), [claims, stateFilter, ownerFilter]);
  // An owner who has dropped off the board must not keep filtering the card
  // down to nothing from a select that no longer offers them.
  const owner = ownerFilter && owners.includes(ownerFilter) ? ownerFilter : null;

  return (
    <section className="nc-of-card" data-section="claims">
      <header className="nc-of-card-head">
        <span className="nc-of-card-title">Work claims</span>
        <span className="nc-of-card-meta">{claimSummary(claims)}</span>
      </header>
      {claims.length > 0 && (
        <ClaimFilterBar
          state={stateFilter}
          onState={setStateFilter}
          owner={owner}
          owners={owners}
          onOwner={setOwnerFilter}
        />
      )}
      {claims.length === 0 ? (
        <div className="nc-obs-ledger-empty">nobody has picked anything up</div>
      ) : shown.length === 0 ? (
        <div className="nc-obs-ledger-empty">{`nothing ${activeFilterPhrase(stateFilter, owner)}`}</div>
      ) : (
        <ul className="nc-obs-claim-rows">
          {shown.map((c) => (
            <ClaimRow
              key={c.slug}
              c={c}
              expanded={expandedSlug === c.slug}
              onToggle={() => onClaimClick(c)}
              {...(assign ? { assign } : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─── Agent drawer — one person's day ─────────────────────────────────────── */

/**
 * A claim's `threadId` already encodes its channel — same two-segment
 * derivation the host's `threadPlatformId` uses server-side to resolve a
 * permalink. Reading it off the claim directly means the drawer never has to
 * invent room attribution claims don't carry: no thread id (a channel-level
 * claim, or one written before thread ids existed) means "unknown room",
 * honestly, not "this room".
 */
export function claimChannelKey(threadId: string | null): string | null {
  if (!threadId) return null;
  const parts = threadId.split(':');
  return parts.length >= 2 ? parts.slice(0, 2).join(':') : null;
}

/** Normalize a channel name for comparison — same rule `filterQueue` uses. */
function roomNameKey(s: string): string {
  return s.trim().toLowerCase().replace(/^#/, '');
}

/**
 * Opened by a click on a person on the floor, for the ROOM they were clicked
 * in — the drawer answers about (agent, room), not the agent's global
 * ledger. "Working on now" leads with the agent's actual live thread in this
 * room when there is one; held claims and needs-a-human items attributable to
 * this room's channel render in the main sections, everything else folds
 * into one "elsewhere" group so a global ledger is still reachable without
 * being the default view.
 *
 * A fixed slide-over, independent of the segmented view underneath it (the
 * click that opens it only happens on Overview, but the drawer itself does
 * not care which segment is showing). Closes on its own ✕, Esc, or a click
 * outside — same convention as GroupTitle's menu and the scheduled-series
 * drawer.
 */
function AgentDrawer({
  agent,
  roomKey,
  rooms,
  claims,
  items,
  roomLinks,
  breachedOwners,
  assign,
  onClose,
}: {
  agent: ObservatoryAgent;
  /** The room this drawer was opened FOR — the slot-resolved channel key, or
   *  null when it couldn't be resolved. Not the agent's own `location`. */
  roomKey: string | null;
  rooms: ObservatoryRoom[];
  claims: ObservatoryClaim[];
  /** Full board, unfiltered by room — split into here/elsewhere below. */
  items: ReleaseItem[];
  roomLinks: Map<string, string>;
  breachedOwners: Set<string>;
  assign?: AssignWiring;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onEsc);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  const room = rooms.find((r) => r.key === roomKey) ?? null;
  const roomName = room ? (room.name.startsWith('#') ? room.name : `#${room.name}`) : null;
  const roomLink = room ? roomLinks.get(roomNameKey(room.name)) : undefined;
  // Room-scoped, like everything else in this drawer: an agent is only
  // "working" in the one room its live session points at. No room resolved →
  // not seated on the floor, which agentState reads as idle unless blocked.
  const status = agentState(agent, breachedOwners, roomKey ?? '');

  // The agent's actual live activity in THIS room — null the moment it
  // points anywhere else, however active that elsewhere is.
  const liveHere = roomKey && agent.liveSession?.channelKey === roomKey ? agent.liveSession : null;

  const held = claims.filter((c) => agent.holding.includes(c.slug));
  // Which SECTION a held claim belongs in — has it stopped moving, or been
  // escalated in its channel. Whether it can be PUSHED is a stricter question
  // (it also needs a thread); see claimPushable, which every row asks itself.
  const healthy = held.filter((c) => c.state === 'live' && !c.escalated);
  const troubled = held.filter((c) => c.state !== 'live' || c.escalated);
  const inRoom = (c: ObservatoryClaim) => Boolean(roomKey) && claimChannelKey(c.threadId) === roomKey;
  const healthyHere = healthy.filter(inRoom);
  const healthyElsewhere = healthy.filter((c) => !inRoom(c));
  const troubledHere = troubled.filter(inRoom);
  const troubledElsewhere = troubled.filter((c) => !inRoom(c));

  const ledgerRows = useMemo(() => buildLedger(items).rows, [items]);
  const stalledOwned = useMemo(
    () => ledgerRows.filter((r) => r.item.owner === agent.name && (r.state === 'breached' || r.state === 'unowned')),
    [ledgerRows, agent.name],
  );
  const itemInRoom = (r: Commitment) =>
    Boolean(room) && Boolean(r.item.channel) && roomNameKey(r.item.channel!) === roomNameKey(room!.name);
  const stalledHere = stalledOwned.filter(itemInRoom);
  const stalledElsewhere = stalledOwned.filter((r) => !itemInRoom(r));

  const attentionEmpty = troubledHere.length === 0 && stalledHere.length === 0;
  const elsewhereCount = healthyElsewhere.length + troubledElsewhere.length + stalledElsewhere.length;

  return (
    <aside
      className="nc-sched-drawer nc-agent-drawer"
      role="dialog"
      aria-label={`${agent.name}'s work`}
      data-testid="agent-drawer"
      ref={rootRef}
    >
      <header className="nc-sched-drawer-head">
        <span className="nc-agent-drawer-who">
          {agent.avatarUrl && (
            <img className="nc-of-sheet-face" src={agent.avatarUrl} alt="" width={24} height={24} />
          )}
          <h3>{roomName ? `${agent.name} in ${roomName}` : agent.name}</h3>
          <span className={`nc-agent-drawer-state ${status}`}>
            <i className={`nc-of-sd ${status}`} />
            {status}
          </span>
        </span>
        <button type="button" className="nc-sched-drawer-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="nc-sched-drawer-body">
        <p className="nc-agent-drawer-where">
          {roomName ? (
            roomLink ? (
              <>
                standing in <OutLink href={roomLink}>{roomName}</OutLink>
              </>
            ) : (
              `standing in ${roomName}`
            )
          ) : (
            'not seated on the floor'
          )}
        </p>

        <section className="nc-agent-drawer-section" data-section="working-now">
          <h4>Working on now</h4>
          {room ? (
            <>
              <div className="nc-agent-drawer-live">
                {/* "live here" is a claim about NOW, so it follows the same
                    recency gate the pulse does. A stale thread is still worth
                    linking — it just isn't live. */}
                {liveHere ? (
                  <>
                    {agent.active ? 'live here' : 'last spoke here'}
                    {liveHere.threadUrl ? (
                      <>
                        {' — '}
                        <OutLink href={liveHere.threadUrl}>open the thread</OutLink>
                      </>
                    ) : (
                      ' — no thread recorded'
                    )}
                  </>
                ) : (
                  'no live thread here'
                )}
              </div>
              {agent.nextTask && (
                <div className="nc-agent-drawer-next">
                  next: {agent.nextTask.title} — {relTime(agent.nextTask.at)}
                </div>
              )}
              {healthyHere.length > 0 && (
                <div className="nc-of-sheet-held">
                  {healthyHere.map((c) => (
                    <HeldRow
                      key={c.slug}
                      slug={c.slug}
                      pushable={claimPushable(c)}
                      threadId={c.threadId}
                      threadUrl={c.threadUrl}
                      sessionId={c.sessionId}
                      ownerAgent={agent.id}
                      room={{ key: roomKey, name: room?.name ?? null }}
                      {...(assign ? { assign } : {})}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="nc-obs-ledger-empty">nothing queued right now</div>
          )}
        </section>

        <section className="nc-agent-drawer-section" data-section="needs-human">
          <h4>Needs a human</h4>
          {attentionEmpty ? (
            <div className="nc-obs-ledger-empty">nothing needs a human right now</div>
          ) : (
            <>
              {troubledHere.length > 0 && (
                <ul className="nc-obs-claim-rows">
                  {troubledHere.map((c) => (
                    <ClaimRow
                      key={c.slug}
                      c={c}
                      expanded={expandedSlug === c.slug}
                      onToggle={() => setExpandedSlug((p) => (p === c.slug ? null : c.slug))}
                      room={{ key: roomKey, name: room?.name ?? null }}
                      {...(assign ? { assign } : {})}
                    />
                  ))}
                </ul>
              )}
              {stalledHere.length > 0 && (
                <ItemTable rows={stalledHere} now={Date.now()} head={false} roomLinks={roomLinks} {...(assign ? { assign } : {})} />
              )}
            </>
          )}
        </section>

        {/* Everything true about this agent that isn't attributable to THIS
            room — a global ledger stays reachable, it just isn't the default
            view a room click opens onto. Native <details>: no open/close
            state to wire up for a fold nobody needs to persist. */}
        {elsewhereCount > 0 && (
          <details className="nc-agent-drawer-section nc-agent-drawer-elsewhere" data-section="elsewhere">
            <summary>elsewhere ({elsewhereCount})</summary>
            {healthyElsewhere.length > 0 && (
              <div className="nc-of-sheet-held">
                {healthyElsewhere.map((c) => (
                  <HeldRow
                    key={c.slug}
                    slug={c.slug}
                    pushable={claimPushable(c)}
                    threadId={c.threadId}
                    threadUrl={c.threadUrl}
                    sessionId={c.sessionId}
                    ownerAgent={agent.id}
                    room={{ key: roomKey, name: room?.name ?? null }}
                    {...(assign ? { assign } : {})}
                  />
                ))}
              </div>
            )}
            {troubledElsewhere.length > 0 && (
              <ul className="nc-obs-claim-rows">
                {troubledElsewhere.map((c) => (
                  <ClaimRow
                    key={c.slug}
                    c={c}
                    expanded={expandedSlug === c.slug}
                    onToggle={() => setExpandedSlug((p) => (p === c.slug ? null : c.slug))}
                    room={{ key: roomKey, name: room?.name ?? null }}
                    {...(assign ? { assign } : {})}
                  />
                ))}
              </ul>
            )}
            {stalledElsewhere.length > 0 && (
              <ItemTable rows={stalledElsewhere} now={Date.now()} head={false} roomLinks={roomLinks} {...(assign ? { assign } : {})} />
            )}
          </details>
        )}
      </div>
    </aside>
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
