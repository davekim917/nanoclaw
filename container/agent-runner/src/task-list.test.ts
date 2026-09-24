import { describe, expect, it } from 'bun:test';

import {
  applyTaskListUpdate,
  latestListLink,
  markTaskListStale,
  parseTaskListInput,
  parseTaskListState,
  renderBody,
  renderSubtext,
  TASK_LIST_RENDER_MAX,
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
      error: 'items[0].status must be pending, in_progress or done',
    });
    expect(parseTaskListInput({ items: [{ text: 'x', status: 'done' }] })).toHaveProperty('error');
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

  it('links to the new list only when every id is a real Slack id', () => {
    expect(latestListLink('slack', 'slack:C0AAA', 'slack:C0AAA:1786621514.008659', '1786621600.001')).toBe(
      'https://slack.com/archives/C0AAA/p1786621600001?thread_ts=1786621514.008659&cid=C0AAA',
    );
    expect(latestListLink('discord', 'discord:1:2', null, '123')).toBeNull();
    expect(latestListLink('slack', 'slack:C0AAA', null, null)).toBeNull();
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

  it('starts a new list after a finished one and points the old one at it', async () => {
    const h = harness();
    await applyTaskListUpdate(input('First', items(['A', 'done'])), SLACK, h.deps);
    expect(h.state?.finished).toBe(true);
    const out = await applyTaskListUpdate(input('Second', items(['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'posted' });
    expect(h.state?.generation).toBe(2);
    const pointer = h.writes[2].content;
    expect(pointer).toMatchObject({ operation: 'edit', messageId: '1786621600.001', taskList: { superseded: true } });
    expect(pointer.text).toBe(
      '[Latest task list →](https://slack.com/archives/C0AAA/p1786621600002?thread_ts=1786621514.008659&cid=C0AAA)',
    );
  });

  it('new_list starts a separate list even while the old one is unfinished', async () => {
    const h = harness();
    await applyTaskListUpdate(input('First', items(['A', 'in_progress'])), SLACK, h.deps);
    await applyTaskListUpdate(input('Other', items(['B', 'pending']), true), SLACK, h.deps);
    expect(h.state?.generation).toBe(2);
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

  it('reposts at the bottom of a busy thread after 15 minutes, collapsing the old copy', async () => {
    const h = harness({ messagesAfter: 3 });
    await applyTaskListUpdate(input('T', items(['A', 'in_progress'], ['B', 'pending'])), SLACK, h.deps);
    h.advance(TASK_LIST_REPOST_AFTER_MS);
    const out = await applyTaskListUpdate(input('T', items(['A', 'done'], ['B', 'in_progress'])), SLACK, h.deps);
    expect(out).toMatchObject({ ok: true, action: 'reposted' });
    expect(h.state?.generation).toBe(1);
    expect(h.state?.postOutboundId).toBe('out-2');
    expect(h.writes[2].content).toMatchObject({ operation: 'edit', messageId: '1786621600.001' });
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
