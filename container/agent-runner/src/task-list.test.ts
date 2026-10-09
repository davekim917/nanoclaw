import { describe, expect, it } from 'bun:test';

import {
  applyTaskListUpdate,
  describeOutcome,
  markTaskListStale,
  parseTaskListInput,
  parseTaskListState,
  renderBody,
  renderSubtext,
  TASK_LIST_RENDER_MAX,
  TASK_LIST_DISCORD_REPOST_AFTER_MS,
  TASK_LIST_REPOST_AFTER_MS,
  TASK_LIST_STATE_KEY,
  taskListReminder,
  type TaskItem,
  type TaskListDeps,
  type TaskListState,
} from './task-list.js';

const SLACK = { channelType: 'slack', platformId: 'slack:C0AAA', threadId: 'slack:C0AAA:1786621514.008659' };

/** In-memory store + outbound log standing in for the mailbox and the host. */
function harness(opts: { deliver?: 'ok' | 'pending' | 'failed'; messagesAfter?: number; inboundSeq?: number } = {}) {
  let state: TaskListState | null = null;
  let clock = Date.parse('2026-09-24T15:00:00.000Z');
  let seq = 1;
  const writes: Array<{ id: string; seq: number; content: Record<string, unknown> }> = [];
  const platformIds = new Map<string, string>();
  // Each row's fate is fixed when it is written, as on the real host: a
  // failed row stays failed; a pending one delivers once the host catches up.
  const fates = new Map<string, 'ok' | 'pending' | 'failed'>();
  const trafficQueries: Array<[number, number]> = [];
  const deps: TaskListDeps = {
    load: () => (state ? structuredClone(state) : null),
    save: (s) => {
      state = structuredClone(s);
    },
    async write(content) {
      const id = `out-${writes.length + 1}`;
      seq += 2;
      writes.push({ id, seq, content });
      platformIds.set(id, `1786621600.00${writes.length}`);
      fates.set(id, opts.deliver ?? 'ok');
      return { id, seq };
    },
    async awaitPlatformId(outboundId) {
      const mode = fates.get(outboundId) ?? 'ok';
      if (mode === 'failed') return { platformId: null, failed: true };
      if (mode === 'pending') return { platformId: null, failed: false };
      return { platformId: platformIds.get(outboundId) ?? null, failed: false };
    },
    inboundSeq: () => opts.inboundSeq ?? 0,
    messagesAfter: (outboundSeq, inboundSeq) => {
      trafficQueries.push([outboundSeq, inboundSeq]);
      return opts.messagesAfter ?? 0;
    },
    now: () => new Date(clock),
  };
  return {
    deps,
    writes,
    trafficQueries,
    get state() {
      return state;
    },
    advance(ms: number) {
      clock += ms;
    },
    setDeliver(mode: 'ok' | 'pending' | 'failed') {
      opts.deliver = mode;
      if (mode === 'ok') for (const [id, fate] of fates) if (fate === 'pending') fates.set(id, 'ok');
    },
  };
}

const items = (...specs: Array<[string, TaskItem['status']]>): TaskItem[] =>
  specs.map(([text, status]) => ({ text, status }));

const input = (title: string, list: TaskItem[], newList = false) => ({ title, items: list, newList });

describe('parseTaskListInput', () => {
  it('accepts a whole list and trims whitespace', () => {
    const parsed = parseTaskListInput({
      title: '  Migrating orders  ',
      items: [{ text: ' Run  the\nmigration ', status: 'in_progress' }],
    });
    expect(parsed).toEqual({
      title: 'Migrating orders',
      items: items(['Run the migration', 'in_progress']),
      newList: false,
    });
  });

  it('rejects unknown fields, empty lists and bad statuses with a usable message', () => {
    expect(parseTaskListInput({ title: 't', items: [], extra: 1 })).toEqual({ error: 'unknown field(s): extra' });
    expect(parseTaskListInput({ title: 't', items: [] })).toHaveProperty('error');
    expect(parseTaskListInput({ title: 't', items: [{ text: 'x', status: 'doing' }] })).toEqual({
      error: 'items[0].status must be pending, in_progress, waiting or done',
    });
    expect(parseTaskListInput({ items: [{ text: 'x', status: 'done' }] })).toHaveProperty('error');
  });

  it('accepts a waiting item only with who or what it waits on, bounded and on one line', () => {
    expect(
      parseTaskListInput({
        title: 't',
        items: [{ text: 'Merge the fix', status: 'waiting', waiting_on: '  Dana\n to  approve ' }],
      }),
    ).toEqual({
      title: 't',
      items: [{ text: 'Merge the fix', status: 'waiting', waitingOn: 'Dana to approve' }],
      newList: false,
    });
    expect(parseTaskListInput({ title: 't', items: [{ text: 'x', status: 'waiting' }] })).toEqual({
      error: 'items[0].waiting_on is required with status waiting: who or what it waits on',
    });
    expect(parseTaskListInput({ title: 't', items: [{ text: 'x', status: 'waiting', waiting_on: '   ' }] })).toEqual({
      error: 'items[0].waiting_on is required with status waiting: who or what it waits on',
    });
    expect(
      parseTaskListInput({ title: 't', items: [{ text: 'x', status: 'waiting', waiting_on: 'y'.repeat(81) }] }),
    ).toEqual({ error: 'items[0].waiting_on is 81 chars; max is 80' });
  });

  it('keeps waiting_on only on a waiting item', () => {
    expect(parseTaskListInput({ title: 't', items: [{ text: 'x', status: 'done', waiting_on: 'Dana' }] })).toEqual({
      title: 't',
      items: [{ text: 'x', status: 'done' }],
      newList: false,
    });
  });
});

describe('rendering', () => {
  it('marks done / in progress / pending and puts the title first', () => {
    expect(
      renderBody('Verifying', items(['A written', 'done'], ['Reviewing B', 'in_progress'], ['Post C', 'pending'])),
    ).toBe('Verifying\n✓ A written\n✱ Reviewing B\n○ Post C');
  });

  it('renders the interrupted form: the running item is marked, nothing else changes', () => {
    expect(renderBody('T', items(['A', 'done'], ['B', 'in_progress'], ['C', 'pending']), true)).toBe(
      'T\n✓ A\n◌ B (interrupted)\n○ C',
    );
  });

  it('renders a waiting item with who it waits on, live and interrupted alike', () => {
    const list: TaskItem[] = [
      { text: 'A', status: 'done' },
      { text: 'Merge the fix', status: 'waiting', waitingOn: 'Dana' },
    ];
    expect(renderBody('T', list)).toBe('T\n✓ A\n◷ Merge the fix (waiting on Dana)');
    expect(renderBody('T', list, true)).toBe('T\n✓ A\n◷ Merge the fix (waiting on Dana)');
  });

  it('says who an interrupted list waits on only when every open item is waiting', () => {
    const at = '2026-09-24T15:00:00.000Z';
    const waiting = (text: string, waitingOn: string): TaskItem => ({ text, status: 'waiting', waitingOn });
    expect(
      renderSubtext('discord', at, true, [{ text: 'A', status: 'done' }, waiting('B', 'Dana'), waiting('C', 'Dana')]),
    ).toBe('waiting on Dana · todos as of <t:1790262000:t> (<t:1790262000:R>)');
    expect(
      renderSubtext('discord', at, true, [waiting('B', 'Dana'), waiting('C', 'the deploy bot'), waiting('D', 'CI')]),
    ).toStartWith('waiting on Dana, the deploy bot (+1 more) · todos as of ');
    expect(renderSubtext('discord', at, true, [waiting('B', 'Dana'), { text: 'C', status: 'pending' }])).toStartWith(
      'stopped · todos as of ',
    );
    expect(renderSubtext('discord', at, true, [{ text: 'A', status: 'done' }])).toStartWith('stopped · ');
    expect(renderSubtext('discord', at, false, [waiting('B', 'Dana')])).toStartWith('todos as of ');
  });

  it('folds the oldest done items first when the list outgrows one message', () => {
    const long = 'x'.repeat(280);
    const list = [
      ...Array.from({ length: 10 }, (_, i) => ({ text: `${i} ${long}`, status: 'done' as const })),
      { text: 'running now', status: 'in_progress' as const },
      { text: 'still to do', status: 'pending' as const },
    ];
    const body = renderBody('Big job', list);
    expect(body.length).toBeLessThanOrEqual(TASK_LIST_RENDER_MAX);
    expect(body).toContain('earlier items done');
    expect(body).toContain('✱ running now');
    expect(body).toContain('○ still to do');
  });

  it('uses each platform’s self-updating time in the footer', () => {
    const at = '2026-09-24T15:00:00.000Z';
    expect(renderSubtext('slack', at)).toMatch(/^todos as of <!date\^1790262000\^\{time\} \(\{ago\}\)\|.+>$/);
    expect(renderSubtext('discord', at)).toBe('todos as of <t:1790262000:t> (<t:1790262000:R>)');
    expect(renderSubtext('slack', at, true)).toStartWith('stopped · todos as of ');
  });
});

describe('applyTaskListUpdate', () => {
  it('posts the first list and remembers where it lives', async () => {
    const h = harness();
    const out = await applyTaskListUpdate(input('Migrating', items(['Run it', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'posted' });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].content.operation).toBeUndefined();
    expect(h.writes[0].content.taskList).toEqual({ generation: 1, revision: 1, activeText: 'Run it' });
    expect(h.state).toMatchObject({ generation: 1, postOutboundId: 'out-1', platformMessageId: '1786621600.001' });
  });

  it('edits the same message in place, with the new title and items', async () => {
    const h = harness();
    await applyTaskListUpdate(input('Migrating', items(['Run it', 'in_progress'])), SLACK, h.deps);
    const out = await applyTaskListUpdate(
      input('Migrating the orders table', items(['Ran it: 14 tables', 'done'], ['Verify', 'in_progress'])),
      SLACK,
      h.deps,
    );
    expect(out).toMatchObject({ ok: true, action: 'edited' });
    expect(h.writes[1].content).toMatchObject({ operation: 'edit', messageId: '1786621600.001' });
    // A changed headline is the same list, not a new one.
    expect(h.state?.generation).toBe(1);
  });

  it('writes nothing when nothing visible changed', async () => {
    const h = harness();
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    h.advance(60_000);
    const out = await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'unchanged' });
    expect(h.writes).toHaveLength(1);
    // The on-screen time stays; the touch the host's kill fence reads does not.
    expect(h.state?.updatedAt).toBe('2026-09-24T15:00:00.000Z');
    expect(h.state?.touchedAt).toBe('2026-09-24T15:01:00.000Z');
  });

  it('stamps touchedAt on a save while the post is still undelivered', async () => {
    const h = harness({ deliver: 'pending' });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    h.advance(30_000);
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(h.state?.touchedAt).toBe('2026-09-24T15:00:30.000Z');
  });

  it('starts a new list after a finished one and deletes the old one', async () => {
    // Conversation below the finished list: the new one goes at the bottom.
    const h = harness({ messagesAfter: 1 });
    await applyTaskListUpdate(input('First', items(['A', 'done'])), SLACK, h.deps);
    expect(h.state?.finished).toBe(true);
    const out = await applyTaskListUpdate(input('Second', items(['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'posted' });
    expect(h.state?.generation).toBe(2);
    expect(h.writes).toHaveLength(3);
    expect(h.writes[2].content).toEqual({ operation: 'delete', messageId: '1786621600.001' });
  });

  it('new_list starts a separate list even while the old one is unfinished', async () => {
    const h = harness();
    await applyTaskListUpdate(input('First', items(['A', 'in_progress'])), SLACK, h.deps);
    await applyTaskListUpdate(input('Other', items(['B', 'pending']), true), SLACK, h.deps);
    expect(h.state?.generation).toBe(2);
    // Nothing below it, but the unfinished list must stay on screen: a new post.
    expect(h.writes[1].content.operation).toBeUndefined();
  });

  it('does not reuse a post whose record predates the inbound cursor', async () => {
    const h = harness({ messagesAfter: 0 });
    await applyTaskListUpdate(input('First', items(['A', 'done'])), SLACK, h.deps);
    const legacy = { ...h.state! } as Partial<TaskListState>;
    delete legacy.postInboundSeq;
    h.deps.save(legacy as TaskListState);
    const out = await applyTaskListUpdate(input('Second', items(['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'posted' });
    expect(h.writes[1].content.operation).toBeUndefined();
  });

  it('takes over a finished list’s post when nothing sits below it', async () => {
    const h = harness({ messagesAfter: 0 });
    await applyTaskListUpdate(input('First', items(['A', 'done'])), SLACK, h.deps);
    const out = await applyTaskListUpdate(input('Second', items(['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'edited' });
    expect(h.state?.generation).toBe(2);
    expect(h.state?.finished).toBe(false);
    // One post, edited in place — no second list and nothing deleted.
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].content).toMatchObject({ operation: 'edit', messageId: '1786621600.001' });
    expect(String(h.writes[1].content.text)).toContain('Second');
  });

  it('a list left behind by /clear is replaced, not edited', async () => {
    const h = harness();
    await applyTaskListUpdate(input('Old', items(['A', 'in_progress'])), SLACK, h.deps);
    const store = {
      getState: (key: string) =>
        key === TASK_LIST_STATE_KEY && h.state ? { value: JSON.stringify(h.state) } : undefined,
      setState: (_k: string, v: string) => h.deps.save(JSON.parse(v) as TaskListState),
    };
    markTaskListStale(store);
    const out = await applyTaskListUpdate(input('New', items(['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ action: 'posted' });
    expect(h.state?.generation).toBe(2);
  });

  it('reposts at the bottom of a busy thread after 15 minutes, deleting the old copy', async () => {
    const h = harness({ messagesAfter: 3 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), SLACK, h.deps);
    h.advance(TASK_LIST_REPOST_AFTER_MS);
    const out = await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'reposted' });
    expect(h.state?.generation).toBe(1);
    expect(h.state?.postOutboundId).toBe('out-2');
    expect(h.writes[2].content).toEqual({ operation: 'delete', messageId: '1786621600.001' });
  });

  it('counts busy-thread traffic from each mailbox’s own cursor', async () => {
    // The host numbers inbound rows from inbound.db alone, so inbound can sit
    // well below the list's outbound seq: 4 while the post is 3+.
    const h = harness({ inboundSeq: 4 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), SLACK, h.deps);
    h.advance(TASK_LIST_REPOST_AFTER_MS);
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(h.trafficQueries).toEqual([[h.writes[0].seq, 4]]);
  });

  it('deletes the old copy only once the repost is on screen', async () => {
    const h = harness({ messagesAfter: 3 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), SLACK, h.deps);
    h.advance(TASK_LIST_REPOST_AFTER_MS);
    h.setDeliver('pending');
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    // The repost has not shown: the old copy is still the visible list.
    expect(h.writes).toHaveLength(2);
    expect(h.state?.supersedes).toEqual({ outboundId: 'out-1', platformMessageId: '1786621600.001' });
    h.setDeliver('ok');
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'done'])), SLACK, h.deps);
    expect(h.writes[2].content).toEqual({ operation: 'delete', messageId: '1786621600.001' });
    expect(h.writes[3].content).toMatchObject({ operation: 'edit', messageId: '1786621600.002' });
    expect(h.state?.supersedes).toBeNull();
  });

  it('never deletes a list for a replacement that failed', async () => {
    const h = harness({ messagesAfter: 1 });
    await applyTaskListUpdate(input('T', items(['A', 'done'])), SLACK, h.deps);
    h.setDeliver('failed');
    await applyTaskListUpdate(input('Next', items(['B', 'in_progress']), true), SLACK, h.deps);
    expect(h.writes).toHaveLength(2);
    expect(h.state?.supersedes).toEqual({ outboundId: 'out-1', platformMessageId: '1786621600.001' });
    // The next fresh post inherits the replacement and deletes the original once it shows.
    h.setDeliver('ok');
    await applyTaskListUpdate(input('Next', items(['B', 'done'])), SLACK, h.deps);
    expect(h.writes[3].content).toEqual({ operation: 'delete', messageId: '1786621600.001' });
    expect(h.state?.supersedes).toBeNull();
  });

  it('reposts a Discord list before its 1-hour edit cap, even in a quiet channel', async () => {
    const DISCORD = { channelType: 'discord', platformId: 'discord:1:2', threadId: null };
    const h = harness({ messagesAfter: 0 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), DISCORD, h.deps);
    h.advance(TASK_LIST_DISCORD_REPOST_AFTER_MS);
    const out = await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), DISCORD, h.deps);
    expect(out).toMatchObject({ action: 'reposted' });
    expect(h.writes[2].content).toEqual({ operation: 'delete', messageId: '1786621600.001' });
  });

  it('does not repost a quiet thread', async () => {
    const h = harness({ messagesAfter: 0 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), SLACK, h.deps);
    h.advance(TASK_LIST_REPOST_AFTER_MS * 2);
    const out = await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ action: 'edited' });
  });

  it('refuses to stack a second list under an undelivered one, and the identical retry still goes out', async () => {
    const h = harness({ deliver: 'pending' });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    const final = input('T', items(['A', 'done'], ['B', 'done']));
    const out = await applyTaskListUpdate(final, SLACK, h.deps);
    expect(out.ok).toBe(false);
    expect(h.writes).toHaveLength(1);
    expect(h.state?.items).toHaveLength(2);
    // The post lands; retrying the SAME final update must reach the platform,
    // not be mistaken for "nothing changed".
    h.setDeliver('ok');
    const retry = await applyTaskListUpdate(final, SLACK, h.deps);
    expect(retry).toMatchObject({ ok: true, action: 'edited' });
    expect(h.writes[1].content).toMatchObject({ operation: 'edit', text: 'T\n✓ A\n✓ B' });
    expect(h.state?.finished).toBe(true);
  });

  it('a post the host gave up on is replaced by a fresh post', async () => {
    const h = harness({ deliver: 'failed' });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    h.setDeliver('ok');
    const out = await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ action: 'posted' });
  });

  it('a list in another thread is left alone', async () => {
    const h = harness();
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'])), SLACK, h.deps);
    const other = { ...SLACK, threadId: 'slack:C0AAA:1786629999.000100' };
    await applyTaskListUpdate(input('U', items(['B', 'in_progress'])), other, h.deps);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].content.operation).toBeUndefined();
  });

  it('stores the interrupted form the host posts if the container dies', async () => {
    const h = harness();
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(h.state?.interruptedText).toBe('T\n✓ A\n◌ B (interrupted)');
    expect(h.state?.interruptedSubtext).toStartWith('stopped · todos as of ');
  });

  it('carries a waiting item from the tool arguments to the record and the posted text', async () => {
    const h = harness();
    const parsed = parseTaskListInput({
      title: 'Shipping',
      items: [
        { text: 'Built it', status: 'done' },
        { text: 'Merge the fix', status: 'waiting', waiting_on: 'Dana' },
      ],
    });
    if ('error' in parsed) throw new Error(parsed.error);

    const out = await applyTaskListUpdate(parsed, SLACK, h.deps);

    expect(h.state?.items[1]).toEqual({ text: 'Merge the fix', status: 'waiting', waitingOn: 'Dana' });
    expect(h.state?.finished).toBe(false);
    expect(h.writes[0].content.text).toBe('Shipping\n✓ Built it\n◷ Merge the fix (waiting on Dana)');
    expect(h.state?.interruptedText).toBe('Shipping\n✓ Built it\n◷ Merge the fix (waiting on Dana)');
    expect(h.state?.interruptedSubtext).toStartWith('waiting on Dana · todos as of ');
    expect(parseTaskListState(JSON.stringify(h.state))?.items[1].waitingOn).toBe('Dana');
    if (!out.ok) throw new Error(out.error);
    expect(describeOutcome(out)).toBe('Task list posted (1 done, 0 in progress, 0 pending, 1 waiting).');
    expect(taskListReminder(h.state)).toContain('◷ Merge the fix (waiting on Dana)');
  });
});

describe('state and reminders', () => {
  it('reads anything malformed as no list', () => {
    expect(parseTaskListState(undefined)).toBeNull();
    expect(parseTaskListState('not json')).toBeNull();
    expect(parseTaskListState(JSON.stringify({ version: 2 }))).toBeNull();
  });

  it('reminds only about an unfinished, current list', async () => {
    const h = harness();
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(taskListReminder(h.state)).toContain('✱ B');
    await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'done'])), SLACK, h.deps);
    expect(taskListReminder(h.state)).toBeNull();
    expect(taskListReminder(null)).toBeNull();
  });
});
