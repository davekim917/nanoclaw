import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { parseAttentionSources } from '../../attention-sources.js';
import { resolveContainedRoot, readContainedFile } from '../api/attention-fs.js';
import type { ScheduledSnapshot } from '../api/scheduled-assembly.js';
import { getScheduledCache } from '../api/scheduled-shared.js';
import { getDb } from '../../db/connection.js';
import {
  buildObservatoryScene,
  type ObservatoryScene,
  type ReleaseStateItem,
  type ReleaseState,
  decorateSteeredThreads,
  threadPermalink,
} from '../api/observatory.js';
import { buildThreadList, buildThreadDetail, type ThreadSummary } from '../api/threads.js';
import { readSessionOutbound } from '../../modules/mailbox/index.js';
import type { AuthedRequestContext } from '../router.js';
import type { SignalDecision, SignalOverview, SignalProject, SignalWorkItem, SignalSourceHealth } from './types.js';
import { decisionId, digest, decorateReview, readRecord, type ReviewRow } from './state.js';

export interface SourceDecision extends SignalDecision {
  channel_key?: string | null;
  repository?: string | null;
  exact_context?: boolean;
}
export interface ProjectRow {
  id: string;
  workgroup_id: string;
  name: string;
  description: string;
  repositories: string;
  channel_keys: string;
  version: number;
  updated_at: string;
}
export interface SourceDeps {
  threadOffset?: number;
  threadLimit?: number;
  /** Exact thread lookup for a decision outside the current overview page. */
  threadId?: string;
  /** Preview runtime scene override; canonical releases and schedules stay live. */
  runtimeScene?: (workgroupId: string) => Promise<ObservatoryScene>;
  scene?: (workgroupId: string) => Promise<ObservatoryScene>;
  release?: (workgroupId: string) => Promise<ReleaseState | null>;
  threads?: (ctx: AuthedRequestContext, workgroupId: string) => Promise<ThreadSummary[]>;
  question?: typeof readPendingQuestion;
  now?: number;
}
export interface SignalData extends SignalOverview {
  rawDecisions: SourceDecision[];
}
/** Read the declared board at its canonical contained workgroup root. */
export async function readSignalRelease(
  workgroupId: string,
  env: { groupsRoot?: string; dataRoot?: string } = {},
): Promise<ReleaseState | null> {
  const row = await getDb().get<{ attention_sources: string | null }>(
    'SELECT attention_sources FROM workgroups WHERE id=?',
    workgroupId,
  );
  const declarations = parseAttentionSources(row?.attention_sources).decls.filter((d) => d.kind === 'release-board');
  let newest: ReleaseState | null = null;
  for (const decl of declarations) {
    const root = resolveContainedRoot(
      'Signal release board',
      env.groupsRoot ?? GROUPS_DIR,
      workgroupId,
      decl.root,
      env.dataRoot,
    );
    if (!root) continue;
    const file = readContainedFile('Signal release board', root, 'release-state.json', workgroupId);
    if (!file) continue;
    try {
      const state = JSON.parse(file.text) as ReleaseState;
      if (typeof state.asOf !== 'string' || !Array.isArray(state.items)) continue;
      const asOf = Date.parse(state.asOf);
      if (!Number.isFinite(asOf)) continue;
      if (!newest || asOf > Date.parse(newest.asOf)) newest = state;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      /* health surface reports unavailable rather than an empty board */
    }
  }
  return decorateSteeredThreads(workgroupId, newest);
}
export function globalAdmin(ctx: AuthedRequestContext): boolean {
  return ctx.scopes.no_filter && (ctx.scopes.role === 'owner' || ctx.scopes.role === 'global_admin');
}
export function groupVisible(ctx: AuthedRequestContext, group: string | null): boolean {
  return !!group && (ctx.scopes.no_filter || ctx.scopes.allowed_group_ids.includes(group));
}
export function canReview(ctx: AuthedRequestContext, source: SourceDecision): boolean {
  if (source.source_kind === 'approval' || (source as SourceDecision).exact_context === false) return false;
  if (globalAdmin(ctx)) return true;
  return (
    ctx.scopes.role === 'admin_of_group' &&
    (source.source_kind === 'release-item' || groupVisible(ctx, source.agent_group_id))
  );
}
export async function visibleWorkgroups(ctx: AuthedRequestContext) {
  return getDb().all<{ id: string; name: string }>(
    `SELECT w.id, COALESCE(w.display_name,w.id) AS name FROM workgroups w
     WHERE ? = 1 OR EXISTS (SELECT 1 FROM agent_groups a WHERE a.workgroup_id=w.id AND a.id IN (${ctx.scopes.allowed_group_ids.map(() => '?').join(',') || "''"}))
     ORDER BY COALESCE(w.display_name,w.id)`,
    ctx.scopes.no_filter ? 1 : 0,
    ...ctx.scopes.allowed_group_ids,
  );
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined || value === null || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

function validSteeredThread(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) &&
      typeof value.threadId === 'string' &&
      optionalString(value.threadUrl) &&
      typeof value.at === 'string' &&
      typeof value.by === 'string')
  );
}

/** Release boards are external JSON; malformed rows must not reach the typed overview. */
function validReleaseItem(value: unknown): value is ReleaseStateItem {
  if (!isRecord(value)) return false;
  const nextMover = value.nextMover;
  const meta = value.meta;
  return (
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.title === 'string' &&
    (nextMover === 'human' || nextMover === 'agent' || nextMover === 'nobody') &&
    optionalString(value.owner) &&
    optionalBoolean(value.blocksRelease) &&
    optionalString(value.why) &&
    optionalString(value.since) &&
    optionalString(value.url) &&
    optionalString(value.dueAt) &&
    optionalString(value.nextAction) &&
    optionalString(value.channel) &&
    optionalStringArray(value.dependsOn) &&
    validSteeredThread(value.steeredThread) &&
    (meta === undefined || meta === null || (isRecord(meta) && optionalString(meta.repo))) &&
    optionalString(value.headSha) &&
    optionalString(value.head)
  );
}

/** Only structured repository metadata or an exact GitHub URL can name a repo. */
export function repositoryOf(item: ReleaseStateItem): string | null {
  const meta = (item as ReleaseStateItem & { meta?: { repo?: unknown } }).meta;
  if (typeof meta?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(meta.repo)) return meta.repo.toLowerCase();
  const url = safeUrl(item.url);
  if (!url) return null;
  const u = new URL(url);
  if (u.hostname !== 'github.com') return null;
  const m = /^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(u.pathname);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
function blankDecision(wg: string, kind: SignalDecision['source_kind'], sourceId: string): SourceDecision {
  return {
    id: decisionId(wg, kind, sourceId),
    workgroup_id: wg,
    project_id: null,
    source_kind: kind,
    source_id: sourceId,
    source_as_of: null,
    source_url: null,
    question: '',
    context: '',
    next_action: null,
    owner_hint: null,
    owner: null,
    evidence_hash: '',
    version: 0,
    state: 'open',
    answer: null,
    answered_by: null,
    answered_at: null,
    thread_id: null,
    agent_group_id: null,
    blocks_release: false,
    dispatch_state: 'not_requested',
    dispatch_error: null,
    capabilities: { claim: false, answer: false, dispatch: false },
    history: [],
  };
}
function materialMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  return Object.fromEntries(
    ['repo', 'head', 'headSha', 'base', 'baseSha', 'commit', 'pullRequest', 'issue', 'dependencies']
      .filter((k) => k in record)
      .map((k) => [k, record[k]]),
  );
}
export function readPendingQuestion(
  agentGroupId: string,
  sessionId: string,
): { seq: number; text: string; timestamp: string } | null {
  const rows = readSessionOutbound({ agentGroupId, sessionId }, (box) => box.listOutboundTail(50)) ?? [];
  return pendingQuestionFromRows(rows);
}
export function pendingQuestionFromRows(
  rows: { seq: number; kind: string; content: string; timestamp: string }[],
): { seq: number; text: string; timestamp: string } | null {
  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    if (row.kind !== 'chat-sdk' && !row.kind.includes('ask_question')) continue;
    try {
      const content = JSON.parse(row.content) as {
        type?: string;
        question?: unknown;
        prompt?: unknown;
        text?: unknown;
      };
      if (content.type !== 'ask_question' && !row.kind.includes('ask_question')) continue;
      const text = content.question ?? content.prompt ?? content.text;
      if (typeof text === 'string' && text.trim()) return { seq: row.seq, text: text.trim(), timestamp: row.timestamp };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      /* malformed row is not an answerable question */
    }
  }
  return null;
}
export function releaseDecision(wg: string, item: ReleaseStateItem, asOf: string): SourceDecision {
  const d = {
    ...blankDecision(wg, 'release-item', item.id),
    source_as_of: asOf,
    source_url: safeUrl(item.url),
    question: item.title,
    context: item.why ?? '',
    next_action: item.nextAction ?? null,
    owner_hint: item.owner ?? null,
    blocks_release: item.blocksRelease === true,
    thread_id: item.steeredThread?.threadId ?? null,
    channel_key: item.channel ?? null,
    repository: repositoryOf(item),
    exact_context: true,
  };
  // Head refs and dependency assertions are material; watcher age is not.
  const extended = item as ReleaseStateItem & { meta?: unknown; headSha?: unknown; head?: unknown };
  d.evidence_hash = digest([
    wg,
    d.source_kind,
    item.id,
    d.question,
    d.context,
    d.next_action,
    d.source_url,
    item.dependsOn ?? null,
    item.blocksRelease ?? null,
    materialMeta(extended.meta),
    extended.headSha ?? extended.head ?? null,
  ]);
  return d;
}
function projectMatches(p: SignalProject, repository: string | null, channel: string | null): boolean {
  return (!!repository && p.repositories.includes(repository)) || (!!channel && p.channel_keys.includes(channel));
}
function matchingProjects(
  projects: SignalProject[],
  repository: string | null,
  channel: string | null,
): SignalProject[] {
  return projects.filter((project) => !project.unmapped && projectMatches(project, repository, channel));
}
function health(
  wg: string,
  source: string,
  asOf: string | null,
  now: number,
  detail: string | null = null,
): SignalSourceHealth {
  const at = asOf ? Date.parse(asOf) : NaN;
  return {
    workgroup_id: wg,
    source,
    as_of: asOf,
    status: !asOf || !Number.isFinite(at) ? 'unavailable' : now - at > 2 * 60 * 60_000 ? 'stale' : 'available',
    detail,
  };
}
function materialThread(d: SourceDecision, identity: unknown): string {
  return digest([d.workgroup_id, d.source_kind, d.source_id, d.question, d.context, d.next_action, identity]);
}

export async function buildSignalData(
  ctx: AuthedRequestContext,
  selected = 'all',
  deps: SourceDeps = {},
): Promise<SignalData> {
  const now = deps.now ?? Date.now();
  const visible = await visibleWorkgroups(ctx);
  const workgroups = selected === 'all' ? visible : visible.filter((w) => w.id === selected);
  let scheduled: ScheduledSnapshot | null = null;
  if (!deps.scene) {
    try {
      const cache = getScheduledCache();
      // Full schedule scans belong to Schedule, never the decision critical path.
      scheduled = cache.data && cache.expiresMs > now ? (cache.data as unknown as ScheduledSnapshot) : null;
    } catch {
      /* per-workgroup health below */
    }
  }
  const result: SignalData = {
    as_of: new Date(now).toISOString(),
    timezone: TIMEZONE,
    thread_coverage: [],
    workgroups: visible,
    projects: [],
    decisions: [],
    agents: [],
    activity: [],
    sources: [],
    capabilities: { manage_projects: globalAdmin(ctx) },
    rawDecisions: [],
  };
  // Sequential workgroups bounds heavy scene/transcript IO, including All.
  for (const wg of workgroups) {
    if (!deps.scene && !scheduled)
      result.sources.push(
        health(wg.id, 'scheduled work', null, now, 'No fresh schedule snapshot. Open Schedule to load upcoming work.'),
      );
    const groupRows = await getDb().all<{ id: string }>('SELECT id FROM agent_groups WHERE workgroup_id=?', wg.id);
    const allowed = new Set(groupRows.map((g) => g.id).filter((g) => groupVisible(ctx, g)));
    const stored = await getDb().all<ProjectRow>(
      'SELECT * FROM observatory_projects WHERE workgroup_id=? ORDER BY name',
      wg.id,
    );
    const projects: SignalProject[] = stored.map((p) => ({
      ...p,
      repositories: JSON.parse(p.repositories),
      channel_keys: JSON.parse(p.channel_keys),
      unmapped: false,
      thread_ids: [],
      decision_ids: [],
      items: [],
    }));
    const unmapped: SignalProject = {
      id: `unmapped:${wg.id}`,
      workgroup_id: wg.id,
      name: 'Unmapped work',
      description: 'No explicit project mapping has been recorded.',
      repositories: [],
      channel_keys: [],
      version: 0,
      updated_at: null,
      unmapped: true,
      thread_ids: [],
      decision_ids: [],
      items: [],
    };
    projects.push(unmapped);
    let scene: ObservatoryScene | null = null;
    let threads: ThreadSummary[] = [];
    let malformedReleaseItem = false;
    let ambiguousProjectMapping = false;
    try {
      scene = await (deps.runtimeScene ?? deps.scene ?? buildObservatoryScene)(wg.id);
    } catch {
      result.sources.push(health(wg.id, 'agents', null, now, 'Agent scene could not be read.'));
    }
    // Independent source failures must not hide a healthy release board.
    const sceneBase = scene ?? {
      workgroupId: wg.id,
      asOf: new Date(now).toISOString(),
      rooms: [],
      agents: [],
      claims: [],
      releaseState: null,
    };
    try {
      scene = {
        ...sceneBase,
        releaseState: deps.release
          ? await deps.release(wg.id)
          : deps.scene
            ? sceneBase.releaseState
            : await readSignalRelease(wg.id),
      };
    } catch {
      scene = sceneBase;
      result.sources.push(health(wg.id, 'release board', null, now, 'Declared release source could not be read.'));
    }
    const offset = deps.threadOffset ?? 0;
    const limit = deps.threadLimit ?? 200;
    const injectedThreads = !!deps.threads;
    try {
      threads = await (
        deps.threads ??
        (async (c, w) =>
          (
            await buildThreadList(c, {
              workgroupId: w,
              groupId: null,
              includeArchived: false,
              sinceHours: null,
              limit: limit + 1,
              offset,
              threadId: deps.threadId,
            })
          ).threads)
      )(ctx, wg.id);
    } catch {
      result.sources.push(health(wg.id, 'threads', null, now, 'Thread source could not be read.'));
    }
    const localOffset = injectedThreads ? offset : 0;
    const backed = threads.filter((t) => t.session_ids.length > 0);
    const hasMore = backed.length > localOffset + limit;
    result.thread_coverage!.push({
      workgroup_id: wg.id,
      offset,
      limit,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    });
    threads = backed.slice(localOffset, localOffset + limit);
    const realThreads = threads.filter((t) => t.session_ids.length > 0);
    if (scene) {
      // Existing scene ownership is an exact normalized name/folder match.
      // Only unique slug ownership may expose richer context; never infer it
      // from a similar name or the scene's fallback session attachment.
      const claimThreads = scene.claims.length
        ? await getDb().all<{ agent_group_id: string; thread_id: string }>(
            `SELECT DISTINCT s.agent_group_id,s.thread_id FROM sessions s
             JOIN agent_groups a ON a.id=s.agent_group_id
             WHERE a.workgroup_id=? AND s.thread_id IS NOT NULL`,
            wg.id,
          )
        : [];
      for (const agent of scene.agents.filter((a) => allowed.has(a.id))) {
        const nextScheduled = scheduled?.rows
          .filter((r) => r.agent_group_id === agent.id && r.next_fire_utc && r.health !== 'paused')
          .sort((a, b) => a.next_fire_utc!.localeCompare(b.next_fire_utc!))[0];
        const ownThreads = realThreads.filter((t) => t.participants.some((p) => p.agent_group_id === agent.id));
        result.agents.push({
          id: agent.id,
          workgroup_id: wg.id,
          name: agent.name,
          provider: agent.provider,
          awake: agent.awake,
          active: agent.active,
          last_seen_at: agent.lastSeenAt,
          thread_ids: ownThreads.map((t) => t.thread_id),
          current_tool: ownThreads.find((t) => t.current_tool)?.current_tool ?? null,
          claims: agent.holding,
          claim_details: scene.claims
            .filter(
              (claim) =>
                agent.holding.includes(claim.slug) &&
                scene.agents.filter((candidate) => candidate.holding.includes(claim.slug)).length === 1 &&
                scene.claims.filter((candidate) => candidate.slug === claim.slug).length === 1,
            )
            .map((claim) => {
              const linked =
                claim.threadId !== null &&
                claimThreads.some(
                  (thread) => thread.agent_group_id === agent.id && thread.thread_id === claim.threadId,
                );
              return {
                slug: claim.slug,
                owner: claim.owner,
                note: claim.note,
                state: claim.state,
                stale_ms: claim.staleMs,
                escalated: claim.escalated,
                thread_id: linked ? claim.threadId : null,
                source_url: linked ? safeUrl(claim.threadUrl) : null,
              };
            }),
          next_task: nextScheduled
            ? { title: nextScheduled.series_id, at: nextScheduled.next_fire_utc! }
            : agent.nextTask,
        });
      }
      for (const item of scene.releaseState?.items ?? []) {
        if (!validReleaseItem(item)) {
          malformedReleaseItem = true;
          continue;
        }
        const matchingRooms = scene.rooms.filter(
          (r) => r.key === item.channel || r.name.replace(/^#/, '') === item.channel?.replace(/^#/, ''),
        );
        const channel = matchingRooms.length === 1 ? matchingRooms[0]!.key : null;
        const matches = matchingProjects(projects, repositoryOf(item), channel);
        const project = matches.length === 1 ? matches[0]! : unmapped;
        ambiguousProjectMapping ||= matches.length > 1;
        const work: SignalWorkItem = {
          id: item.id,
          title: item.title,
          owner_hint: item.owner ?? null,
          next_action: item.nextAction ?? null,
          next_mover: item.nextMover,
          depends_on: Array.isArray(item.dependsOn) ? item.dependsOn : null,
          source_url: safeUrl(item.url),
          as_of: scene.releaseState!.asOf,
        };
        project.items.push(work);
        if (item.nextMover === 'human') {
          const decision = releaseDecision(wg.id, item, scene.releaseState!.asOf);
          decision.project_id = project.id;
          result.rawDecisions.push(decision);
        }
      }
    }
    for (const thread of realThreads) {
      const matches = matchingProjects(projects, null, thread.channel_key);
      const project = matches.length === 1 ? matches[0]! : unmapped;
      ambiguousProjectMapping ||= matches.length > 1;
      project.thread_ids.push(thread.thread_id);
      if (thread.last_activity_at)
        result.activity.push({
          id: thread.thread_id,
          workgroup_id: wg.id,
          at: thread.last_activity_at,
          title: thread.title ?? thread.channel_name,
          detail: `${thread.state} · ${thread.participants.map((p) => p.name).join(', ')}`,
          thread_id: thread.thread_id,
          kind: 'thread',
        });
      if (thread.state !== 'needs_you') continue;
      const target =
        thread.participants.find((p) => p.session_id === thread.reply_target_session_id) ?? thread.participants[0];
      if (!target || !allowed.has(target.agent_group_id)) continue;
      let question = thread.needs_you_reason?.text ?? 'Open the thread to inspect what input is needed.';
      let sequence: string | number = thread.last_activity_at ?? 'unknown';
      let exact = true;
      if (thread.needs_you_reason?.cause === 'ask_question') {
        // Only threads actually waiting on a question open a mailbox, bounded
        // by the thread page. Never disable a visible question due to order.
        try {
          const pending = (deps.question ?? readPendingQuestion)(target.agent_group_id, target.session_id);
          if (pending) {
            question = pending.text;
            sequence = pending.seq;
          } else exact = false;
        } catch {
          exact = false;
        }
      }
      const sourceId = JSON.stringify([target.session_id, thread.needs_you_reason?.cause ?? 'input', sequence]);
      const d: SourceDecision = {
        ...blankDecision(wg.id, 'thread-question', sourceId),
        project_id: project.id,
        source_as_of: thread.last_activity_at,
        source_url: await threadPermalink(thread.thread_id),
        question,
        context: thread.title ?? thread.channel_name,
        next_action: 'Reply to the agent on this thread.',
        thread_id: thread.thread_id,
        agent_group_id: target.agent_group_id,
        channel_key: thread.channel_key,
        exact_context: exact,
      };
      d.evidence_hash = materialThread(d, sequence);
      result.rawDecisions.push(d);
    }
    if (scene)
      result.sources.push(
        health(
          wg.id,
          'release board',
          malformedReleaseItem ? null : (scene.releaseState?.asOf ?? null),
          now,
          malformedReleaseItem
            ? 'Skipped malformed release-board item; healthy items remain available.'
            : scene.releaseState
              ? null
              : 'No release board has been published.',
        ),
      );
    if (ambiguousProjectMapping)
      result.sources.push(
        health(
          wg.id,
          'project mappings',
          null,
          now,
          'Multiple project mappings match source facts; affected work remains under Unmapped work.',
        ),
      );
    // Never serialize approval payload/options; titles can be reviewed only by
    // the named approver or an appropriate administrator, plus exact group scope.
    const approvals = await getDb()
      .all<{
        approval_id: string;
        agent_group_id: string | null;
        session_id: string | null;
        title: string;
        action: string;
        created_at: string;
        expires_at: string | null;
        approver_user_id: string | null;
        channel_type: string | null;
        platform_id: string | null;
        platform_message_id: string | null;
      }>(
        `SELECT p.approval_id, COALESCE(p.agent_group_id,s.agent_group_id) AS agent_group_id,p.session_id,p.title,p.action,p.created_at,p.expires_at,p.approver_user_id,p.channel_type,p.platform_id,p.platform_message_id
       FROM pending_approvals p LEFT JOIN sessions s ON s.id=p.session_id JOIN agent_groups a ON a.id=COALESCE(p.agent_group_id,s.agent_group_id)
       WHERE a.workgroup_id=? AND p.status='pending'`,
        wg.id,
      )
      .catch(() => {
        result.sources.push(health(wg.id, 'pending approvals', null, now, 'Approval metadata could not be read.'));
        return [];
      });
    for (const p of approvals) {
      if (!groupVisible(ctx, p.agent_group_id)) continue;
      if (p.expires_at && Date.parse(p.expires_at) <= now) continue;
      if (
        p.approver_user_id
          ? p.approver_user_id !== ctx.user.id
          : !(globalAdmin(ctx) || ctx.scopes.role === 'admin_of_group')
      )
        continue;
      const d = blankDecision(wg.id, 'approval', p.approval_id);
      d.question = p.title || 'Pending privileged approval';
      d.context = `${p.action}: resolve using the original approval card. This review does not grant permission.`;
      d.agent_group_id = p.agent_group_id;
      d.source_as_of = p.created_at;
      d.next_action = 'Open the original approval card.';
      if (p.channel_type?.startsWith('slack') && p.platform_id && p.platform_message_id) {
        const channel = p.platform_id.replace(/^slack:/, '');
        d.source_url = `https://slack.com/archives/${encodeURIComponent(channel)}/p${p.platform_message_id.replace('.', '')}`;
      }
      d.evidence_hash = digest([
        wg.id,
        'approval',
        p.approval_id,
        p.title,
        p.action,
        p.created_at,
        p.expires_at,
        p.approver_user_id,
      ]);
      result.rawDecisions.push(d);
    }
    const reviews = await getDb().all<ReviewRow>('SELECT * FROM observatory_reviews WHERE workgroup_id=?', wg.id);
    const byId = new Map(reviews.map((r) => [r.id, r]));
    for (const source of result.rawDecisions.filter((d) => d.workgroup_id === wg.id)) {
      const editable = canReview(ctx, source) && source.exact_context !== false;
      source.capabilities = {
        claim: editable,
        answer: editable,
        dispatch: editable && source.source_kind !== 'approval',
      };
      const decision = decorateReview(source, byId.get(source.id));
      decision.capabilities.release =
        editable && !!decision.owner && (decision.owner.id === ctx.user.id || globalAdmin(ctx));
      if (decision.owner && decision.owner.id !== ctx.user.id)
        decision.capabilities = { ...decision.capabilities, answer: false, dispatch: false };
      result.decisions.push(decision);
      (projects.find((p) => p.id === decision.project_id) ?? unmapped).decision_ids.push(decision.id);
    }
    for (const row of reviews) {
      if (result.rawDecisions.some((d) => d.id === row.id)) continue;
      const saved = readRecord(row) as ReturnType<typeof readRecord> & { snapshot?: SourceDecision };
      const previous = saved.snapshot;
      if (!previous) continue;
      const currentThread = previous.thread_id
        ? realThreads.find((thread) => thread.thread_id === previous.thread_id)
        : undefined;
      const currentMember = currentThread?.participants.some(
        (participant) =>
          participant.agent_group_id === previous.agent_group_id && allowed.has(participant.agent_group_id),
      );
      const snapshotVisible =
        row.source_kind === 'release-item' ||
        (previous.agent_group_id !== null &&
          allowed.has(previous.agent_group_id) &&
          groupVisible(ctx, previous.agent_group_id));
      const retainedThreadReview =
        row.source_kind === 'thread-question' &&
        (saved.answer !== null || saved.owner !== null || saved.history.length > 0) &&
        snapshotVisible;
      // Answered records remain visible when a later question is active. A
      // claim without an answer becomes unavailable only when this page proves
      // its question cleared or changed; off-page history stays read-only and unknown.
      const offPageUnknown = !currentThread && !deps.threadId;
      const keepRecorded = offPageUnknown || !!currentMember;
      if (retainedThreadReview && keepRecorded) {
        const unavailable = saved.answer === null && !!currentThread;
        const recorded: SourceDecision = {
          ...previous,
          evidence_hash: unavailable ? digest([row.evidence_hash, 'source_unavailable']) : row.evidence_hash,
          exact_context: false,
          capabilities: { claim: false, answer: false, dispatch: false },
        };
        result.rawDecisions.push(recorded);
        result.decisions.push(decorateReview(recorded, row));
        (projects.find((p) => p.id === recorded.project_id) ?? unmapped).decision_ids.push(recorded.id);
        if (unavailable)
          result.sources.push(
            health(
              wg.id,
              previous.question,
              null,
              now,
              'Previously reviewed source is absent or unreadable. History is retained; absence is not completion.',
            ),
          );
        continue;
      }
      // Only an exact lookup that does not find its reviewed thread proves a
      // thread source is gone. Overview pagination leaves that fact unknown.
      const sourceGone =
        row.source_kind === 'release-item' ||
        (!!deps.threadId && previous.thread_id === deps.threadId && !currentThread);
      if (!sourceGone || !snapshotVisible) continue;
      const missing: SourceDecision = {
        ...previous,
        evidence_hash: digest([row.evidence_hash, 'source_unavailable']),
        exact_context: false,
        capabilities: {
          claim: false,
          answer: false,
          dispatch:
            saved.dispatch?.state === 'pending' &&
            saved.owner?.id === ctx.user.id &&
            canReview(ctx, { ...previous, exact_context: true }),
        },
      };
      result.rawDecisions.push(missing);
      result.decisions.push(decorateReview(missing, row));
      (projects.find((p) => p.id === missing.project_id) ?? unmapped).decision_ids.push(missing.id);
      result.sources.push(
        health(
          wg.id,
          previous.question,
          null,
          now,
          'Previously reviewed source is absent or unreadable. History is retained; absence is not completion.',
        ),
      );
    }
    result.projects.push(...projects);
  }
  result.activity.sort((a, b) => b.at.localeCompare(a.at));
  result.activity = result.activity.slice(0, 100);
  return result;
}
export async function scopedThreadDetail(threadId: string, ctx: AuthedRequestContext) {
  return buildThreadDetail(threadId, ctx);
}
