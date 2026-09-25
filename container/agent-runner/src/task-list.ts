/**
 * Live task list — the agent's visible progress checklist in a conversation
 * (docs/specs/slack-task-list/plan.md).
 *
 * The agent calls `update_task_list` (mcp-tools/task-list.ts) with the WHOLE
 * list every time; this module owns everything after that: which message the
 * list lives in, whether an update edits it or posts a fresh one, how it
 * renders, and the durable record the host reads if the container dies.
 *
 * One list per session, stored in `session_state.task_list` (outbound.db).
 * The list is posted once as a `kind: 'task_list'` row and then edited in
 * place with `operation: 'edit'` rows of the same kind, so it rides the
 * ordinary delivery path (routing, permission, anchors, secret scrub) while
 * the host can still tell it apart from a reply: it never counts as the
 * answer, never pauses the typing indicator, never lands in the archive.
 *
 * Identity is a GENERATION, never the title — a headline naturally changes as
 * work moves, and keying on it would post a new list every step. A new
 * generation starts only when the agent asks (`new_list`), the previous list
 * is finished (every item done) or was left behind by a context reset.
 */
import { TIMEZONE } from './timezone.js';

/** Spawn-scoped switch (host sets NANOCLAW_TASK_LIST=1): changing host config never reshapes a running container. */
export function taskListEnabled(): boolean {
  return process.env.NANOCLAW_TASK_LIST === '1';
}

export const TASK_LIST_STATE_KEY = 'task_list';
export const TASK_LIST_TITLE_MAX = 200;
export const TASK_LIST_ITEM_MAX = 300;
export const TASK_LIST_ITEMS_MAX = 30;
/** Claude Tag's cap; also keeps one list inside one Slack/Discord message. */
export const TASK_LIST_RENDER_MAX = 2000;
/** A list older than this, with conversation below it, is reposted at the bottom. */
export const TASK_LIST_REPOST_AFTER_MS = 15 * 60 * 1000;
/** How much conversation below the list counts as "busy". */
export const TASK_LIST_REPOST_MIN_MESSAGES = 2;
/**
 * Discord caps edits to a message older than 1 hour (API error 30046), so a
 * Discord list is reposted before then — while its old copy can still be
 * edited into a pointer.
 */
export const TASK_LIST_DISCORD_REPOST_AFTER_MS = 50 * 60 * 1000;

export type TaskItemStatus = 'pending' | 'in_progress' | 'done';

export interface TaskItem {
  text: string;
  status: TaskItemStatus;
}

export interface TaskListState {
  version: 1;
  generation: number;
  revision: number;
  title: string;
  items: TaskItem[];
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** messages_out id / seq of the visible post; null until it is written. */
  postOutboundId: string | null;
  postSeq: number | null;
  /** Highest inbound seq when the post was written — the repost check's inbound cursor. */
  postInboundSeq?: number | null;
  /**
   * The list still on screen that this post replaces (a busy-thread repost's
   * old copy, or the previous generation). It is collapsed into a pointer only
   * once this post has a platform id — until then it IS the visible list, so
   * it is also what the host marks interrupted if the container dies first.
   */
  supersedes?: { outboundId: string; platformMessageId: string } | null;
  /** Platform id of the visible post, once the host has delivered it. */
  platformMessageId: string | null;
  postedAt: string | null;
  updatedAt: string;
  /**
   * When this container last wrote the record — on EVERY save, unlike
   * `updatedAt`, which an unchanged or still-pending update leaves alone
   * because it is the time on screen. The host's kill fence reads it: a
   * record touched after a kill began belongs to the replacement container.
   */
  touchedAt?: string;
  /** Every item done: the next update starts a new list. */
  finished: boolean;
  /** Left behind by a context reset (/clear, fresh task fire): the next update starts a new list. */
  stale?: boolean;
  /** What the host edits the post to if the container dies mid-list. */
  interruptedText: string;
  interruptedSubtext: string;
  /** The last text/subtext actually written, so an unchanged update writes nothing. */
  text: string;
  subtext: string;
}

export interface TaskListInput {
  title: string;
  items: TaskItem[];
  newList: boolean;
}

const STATUS_MARK: Record<TaskItemStatus, string> = { done: '✓', in_progress: '✱', pending: '○' };

/** Validate raw tool arguments. Returns the parsed input or a one-line error for the agent. */
export function parseTaskListInput(args: Record<string, unknown>): TaskListInput | { error: string } {
  const unknown = Object.keys(args).filter((k) => k !== 'title' && k !== 'items' && k !== 'new_list');
  if (unknown.length > 0) return { error: `unknown field(s): ${unknown.join(', ')}` };
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return { error: 'title is required — one short line naming the work' };
  if (title.length > TASK_LIST_TITLE_MAX) {
    return { error: `title is ${title.length} chars; max is ${TASK_LIST_TITLE_MAX}` };
  }
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return { error: 'items is required: the whole list, every item with text and status' };
  }
  if (args.items.length > TASK_LIST_ITEMS_MAX) {
    return { error: `${args.items.length} items; max is ${TASK_LIST_ITEMS_MAX} — group smaller steps` };
  }
  const items: TaskItem[] = [];
  for (const [i, raw] of args.items.entries()) {
    const item = raw as { text?: unknown; status?: unknown } | null;
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { error: `items[${i}].text is required` };
    if (text.length > TASK_LIST_ITEM_MAX) {
      return { error: `items[${i}].text is ${text.length} chars; max is ${TASK_LIST_ITEM_MAX}` };
    }
    const status = item?.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') {
      return { error: `items[${i}].status must be pending, in_progress or done` };
    }
    items.push({ text, status });
  }
  if (args.new_list !== undefined && typeof args.new_list !== 'boolean') {
    return { error: 'new_list must be true or false' };
  }
  return { title, items, newList: args.new_list === true };
}

/**
 * The time in a platform's own self-updating form. Slack and Discord render
 * both the clock time AND "(25 minutes ago)" client-side, so the footer ages
 * without an edit; anything else gets a fixed local time.
 */
export function renderTime(channelType: string, iso: string, timezone = TIMEZONE): string {
  const unix = Math.floor(Date.parse(iso) / 1000);
  const local = new Date(iso).toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  if (channelType.startsWith('slack')) return `<!date^${unix}^{time} ({ago})|${local}>`;
  if (channelType.startsWith('discord')) return `<t:${unix}:t> (<t:${unix}:R>)`;
  return local;
}

function renderLine(item: TaskItem, interrupted: boolean): string {
  if (interrupted && item.status === 'in_progress') return `◌ ${item.text} (interrupted)`;
  return `${STATUS_MARK[item.status]} ${item.text}`;
}

/**
 * Title plus one line per item, within TASK_LIST_RENDER_MAX. Over the cap,
 * the oldest DONE items fold into one count line first — what is left and
 * what is running matters more than a long tail of ticks.
 */
export function renderBody(title: string, items: TaskItem[], interrupted = false): string {
  const lines = items.map((item) => renderLine(item, interrupted));
  const build = (folded: number, rest: string[]) =>
    [title, ...(folded > 0 ? [`✓ ${folded} earlier item${folded === 1 ? '' : 's'} done`] : []), ...rest].join('\n');
  let body = build(0, lines);
  if (body.length <= TASK_LIST_RENDER_MAX) return body;
  const doneIdx = items.map((item, i) => (item.status === 'done' ? i : -1)).filter((i) => i >= 0);
  let folded = 0;
  const drop = new Set<number>();
  for (const i of doneIdx) {
    drop.add(i);
    folded++;
    body = build(
      folded,
      lines.filter((_, j) => !drop.has(j)),
    );
    if (body.length <= TASK_LIST_RENDER_MAX) return body;
  }
  return body.slice(0, TASK_LIST_RENDER_MAX - 1) + '…';
}

export function renderSubtext(channelType: string, updatedAt: string, interrupted = false): string {
  const when = renderTime(channelType, updatedAt);
  return interrupted ? `stopped · todos as of ${when}` : `todos as of ${when}`;
}

/** The item the agent is on right now, for the platform's "is working…" status line. */
export function activeText(items: TaskItem[]): string | null {
  const active = items.find((item) => item.status === 'in_progress');
  return active ? active.text : null;
}

/**
 * A link to the new list for the superseded one to point at. Slack only, and
 * only when every part is a real Slack id; otherwise the pointer is plain
 * text — a link that 404s is worse than none. The domain-less
 * `slack.com/archives` form redirects to the reader's workspace.
 */
export function latestListLink(
  channelType: string,
  platformId: string,
  threadId: string | null,
  platformMessageId: string | null,
): string | null {
  if (!channelType.startsWith('slack') || !platformMessageId) return null;
  const channel = platformId.split(':').pop();
  const threadTs = threadId ? threadId.split(':').pop() : null;
  if (!channel || !/^[A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(platformMessageId)) return null;
  const query = threadTs && /^\d+\.\d+$/.test(threadTs) ? `?thread_ts=${threadTs}&cid=${channel}` : '';
  return `https://slack.com/archives/${channel}/p${platformMessageId.replace('.', '')}${query}`;
}

export function supersededText(link: string | null): string {
  return link ? `[Latest task list →](${link})` : 'Latest task list ↓';
}

/** Parse the stored record; anything malformed reads as "no list". */
export function parseTaskListState(raw: string | undefined): TaskListState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TaskListState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.items) || typeof parsed.generation !== 'number') return null;
    if (typeof parsed.channelType !== 'string' || typeof parsed.platformId !== 'string') return null;
    return parsed as TaskListState;
  } catch {
    return null;
  }
}

/**
 * Everything a store/transport must provide. Injected so the decision logic
 * is testable without a mailbox.
 */
export interface TaskListDeps {
  load(): TaskListState | null;
  save(state: TaskListState): void;
  /** Write one outbound task_list row; returns its id and seq. */
  write(content: Record<string, unknown>, routing: TaskListRouting): Promise<{ id: string; seq: number }>;
  /**
   * The platform id the host recorded for an outbound row, waiting up to
   * `timeoutMs`. `failed` means the host gave up on the row; a null id with
   * `failed: false` means delivery is still pending.
   */
  awaitPlatformId(outboundId: string, timeoutMs: number): Promise<{ platformId: string | null; failed: boolean }>;
  /** Highest inbound sequence number so far. */
  inboundSeq(): number;
  /** Conversation messages (human or agent chat) after these outbound / inbound cursors. */
  messagesAfter(outboundSeq: number, inboundSeq: number): number;
  now(): Date;
}

export interface TaskListRouting {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type TaskListOutcome =
  | { ok: true; action: 'posted' | 'edited' | 'unchanged' | 'reposted'; state: TaskListState }
  | { ok: false; error: string };

const POST_ACK_TIMEOUT_MS = 15_000;

function sameRoute(a: TaskListRouting, b: TaskListState): boolean {
  return a.channelType === b.channelType && a.platformId === b.platformId && a.threadId === b.threadId;
}

/**
 * Apply one `update_task_list` call. The single writer of the task_list
 * record: every decision about post vs edit vs repost is made here.
 */
export async function applyTaskListUpdate(
  input: TaskListInput,
  routing: TaskListRouting,
  deps: TaskListDeps,
): Promise<TaskListOutcome> {
  const prev = deps.load();
  const nowDate = deps.now();
  const now = nowDate.toISOString();
  const save = (state: TaskListState): void => deps.save({ ...state, touchedAt: now });
  const finished = input.items.every((item) => item.status === 'done');
  const text = renderBody(input.title, input.items);
  const subtext = renderSubtext(routing.channelType, now);
  // Point a replaced list at the one now on screen.
  const collapse = async (messageId: string, latest: string): Promise<void> => {
    const link = latestListLink(routing.channelType, routing.platformId, routing.threadId, latest);
    await deps.write(
      { operation: 'edit', messageId, text: supersededText(link), taskList: { superseded: true } },
      routing,
    );
  };

  // The list this update continues, if any, and the platform id of its
  // visible post. A post the host reported as failed is no post at all:
  // start over rather than edit nothing.
  let current: TaskListState | null =
    prev && !prev.finished && prev.stale !== true && !input.newList && sameRoute(routing, prev) ? prev : null;
  let target: string | null = null;
  if (current) {
    target = current.platformMessageId;
    if (!target && current.postOutboundId) {
      const ack = await deps.awaitPlatformId(current.postOutboundId, POST_ACK_TIMEOUT_MS);
      if (ack.failed) current = null;
      else target = ack.platformId;
    }
    if (current && !target) {
      // Delivery still pending. Keep the new items so the next call carries
      // them, and say so rather than stack a second list under this one.
      save({ ...current, title: input.title, items: input.items, revision: current.revision + 1 });
      return { ok: false, error: 'the task list post has not been delivered yet; call update_task_list again shortly' };
    }
    if (current && target && current.supersedes) {
      // The post is on screen now: the list it replaced can become a pointer.
      await collapse(current.supersedes.platformMessageId, target);
      current = { ...current, supersedes: null };
    }
  }

  // A new list whose finished predecessor is still the last thing in this
  // conversation takes over that post instead of stacking under it, which
  // would leave a "Latest task list" pointer aimed at the message right below.
  // Only a finished list — an unfinished one replaced by `new_list` stays
  // visible as it was.
  let reused = false;
  if (
    !current &&
    prev &&
    prev.finished &&
    prev.stale !== true &&
    sameRoute(routing, prev) &&
    prev.platformMessageId &&
    prev.postSeq !== null &&
    // Without its own inbound cursor nothing proves the thread is quiet.
    prev.postInboundSeq != null &&
    deps.messagesAfter(prev.postSeq, prev.postInboundSeq) === 0
  ) {
    current = prev;
    target = prev.platformMessageId;
    reused = true;
    if (prev.supersedes) {
      await collapse(prev.supersedes.platformMessageId, target);
      current = { ...prev, supersedes: null };
    }
  }

  const next: TaskListState = {
    version: 1,
    generation: current && !reused ? current.generation : (prev?.generation ?? 0) + 1,
    revision: (prev?.revision ?? 0) + 1,
    title: input.title,
    items: input.items,
    channelType: routing.channelType,
    platformId: routing.platformId,
    threadId: routing.threadId,
    postOutboundId: current?.postOutboundId ?? null,
    postSeq: current?.postSeq ?? null,
    postInboundSeq: current?.postInboundSeq ?? null,
    supersedes: current?.supersedes ?? null,
    platformMessageId: target,
    postedAt: current?.postedAt ?? null,
    updatedAt: now,
    finished,
    interruptedText: renderBody(input.title, input.items, true),
    interruptedSubtext: renderSubtext(routing.channelType, now, true),
    text,
    subtext,
  };
  const meta = {
    generation: next.generation,
    revision: next.revision,
    activeText: finished ? null : activeText(input.items),
  };

  const postAge = current?.postedAt ? nowDate.getTime() - Date.parse(current.postedAt) : 0;
  const busy =
    current !== null &&
    current.postedAt !== null &&
    current.postSeq !== null &&
    ((postAge >= TASK_LIST_REPOST_AFTER_MS &&
      // A record from before the inbound cursor existed falls back to postSeq.
      deps.messagesAfter(current.postSeq, current.postInboundSeq ?? current.postSeq) >=
        TASK_LIST_REPOST_MIN_MESSAGES) ||
      (routing.channelType.startsWith('discord') && postAge >= TASK_LIST_DISCORD_REPOST_AFTER_MS));

  if (current && target && !busy) {
    if (current.text === text) {
      // The platform already shows this render (only the footer time would
      // change); skip the edit (rate limits). Compared against what was last
      // WRITTEN, not the stored items: an update saved while the post was
      // still undelivered is not on screen yet and must go out on the retry.
      save({ ...next, text: current.text, subtext: current.subtext, updatedAt: current.updatedAt });
      return { ok: true, action: 'unchanged', state: next };
    }
    await deps.write({ operation: 'edit', messageId: target, text, subtext, taskList: meta }, routing);
    save(next);
    return { ok: true, action: 'edited', state: next };
  }

  // Post a fresh list: a new generation, or a repost at the bottom of a busy thread.
  // What it replaces on screen: on a repost this list's own copy; otherwise the
  // previous generation's post, or — when that post never showed — whatever
  // it was itself going to replace. Same conversation only: a list left in
  // another thread stays as it was.
  const replaced =
    busy && current?.postOutboundId && target
      ? { outboundId: current.postOutboundId, platformMessageId: target }
      : prev && sameRoute(routing, prev)
        ? prev.postOutboundId && prev.platformMessageId
          ? { outboundId: prev.postOutboundId, platformMessageId: prev.platformMessageId }
          : (prev.supersedes ?? null)
        : null;
  const post = await deps.write({ text, subtext, taskList: meta }, routing);
  next.postOutboundId = post.id;
  next.postSeq = post.seq;
  next.postInboundSeq = deps.inboundSeq();
  next.postedAt = now;
  next.platformMessageId = null;
  next.supersedes = replaced;
  save(next);
  const ack = await deps.awaitPlatformId(post.id, POST_ACK_TIMEOUT_MS);
  if (ack.platformId) {
    next.platformMessageId = ack.platformId;
    // Collapse the replaced list only now that its replacement is on screen;
    // a pending post collapses it on the next update, a failed one never
    // does (the next fresh post inherits `supersedes`). Best effort: a
    // missing pointer only leaves the old list showing its last state.
    if (replaced) {
      await collapse(replaced.platformMessageId, ack.platformId);
      next.supersedes = null;
    }
    save(next);
  }
  return { ok: true, action: busy ? 'reposted' : 'posted', state: next };
}

/** Short tool result: counts, not the whole list (the model just sent it). */
export function describeOutcome(outcome: Extract<TaskListOutcome, { ok: true }>): string {
  const items = outcome.state.items;
  const count = (s: TaskItemStatus) => items.filter((item) => item.status === s).length;
  const tally = `${count('done')} done, ${count('in_progress')} in progress, ${count('pending')} pending`;
  switch (outcome.action) {
    case 'posted':
      return `Task list posted (${tally}).`;
    case 'reposted':
      return `Task list moved to the bottom of the thread (${tally}).`;
    case 'unchanged':
      return `Task list unchanged (${tally}).`;
    default:
      return outcome.state.finished ? `Task list finished (${tally}).` : `Task list updated (${tally}).`;
  }
}

/**
 * The reminder re-injected after a context compaction or into a fresh
 * context that inherits an unfinished list: the list is state the model
 * must keep maintaining, and compaction can summarize it away.
 */
export function taskListReminder(state: TaskListState | null): string | null {
  if (!state || state.finished || state.stale) return null;
  const lines = state.items.map((item) => `${STATUS_MARK[item.status]} ${item.text}`).join('\n');
  return (
    `[system] Your live task list in this conversation (keep it current with update_task_list, sending the whole list):\n` +
    `${state.title}\n${lines}`
  );
}

/** The two state operations the runner-side helpers below need. */
interface TaskListStore {
  getState(key: string): { value: string } | undefined;
  setState(key: string, value: string): void;
}

export function loadTaskListState(store: TaskListStore): TaskListState | null {
  return parseTaskListState(store.getState(TASK_LIST_STATE_KEY)?.value);
}

/**
 * `/clear` started the conversation over: the list on screen belongs to the
 * old context, so the next update starts a new one (and points the old one
 * at it) instead of editing a list the model no longer knows.
 */
export function markTaskListStale(store: TaskListStore): void {
  const state = loadTaskListState(store);
  if (!state || state.finished || state.stale) return;
  store.setState(TASK_LIST_STATE_KEY, JSON.stringify({ ...state, stale: true }));
}
