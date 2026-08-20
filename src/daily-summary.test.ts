import { describe, expect, it, vi } from 'vitest';

import { splitForLimit } from './channels/chat-sdk-bridge.js';
import {
  deliverBacklogThread,
  extractRepo,
  formatDigest,
  formatDigestParts,
  isCommitScanEntry,
  rankBacklog,
} from './daily-summary.js';
import type { ShipLogEntry, BacklogItem } from './db/backlog.js';

function shipEntry(over: Partial<ShipLogEntry> = {}): ShipLogEntry {
  return {
    id: 'ship-1',
    agent_group_id: 'ag-x',
    title: 'untitled',
    description: null,
    pr_url: null,
    branch: null,
    tags: null,
    shipped_at: '2026-05-12T12:00:00.000Z',
    ...over,
  };
}

function backlogItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'bl-1',
    agent_group_id: 'ag-x',
    title: 'untitled',
    description: null,
    status: 'open',
    priority: 'medium',
    tags: null,
    notes: null,
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
    resolved_at: null,
    ...over,
  };
}

function emptySummary() {
  return { agentShipped: [], otherCommits: [], resolved: [], openBacklog: [] };
}

describe('extractRepo', () => {
  it('parses owner/repo from a github PR url', () => {
    expect(extractRepo(shipEntry({ pr_url: 'https://github.com/Example Labs-ai/example-app/pull/1234' }))).toBe(
      'Example Labs-ai/example-app',
    );
  });

  it('parses owner/repo from a github issues url', () => {
    expect(extractRepo(shipEntry({ pr_url: 'https://github.com/davekim917/nanoclaw/issues/42' }))).toBe(
      'davekim917/nanoclaw',
    );
  });

  it('uses comma-separated tag fallback (commit-scan format)', () => {
    expect(extractRepo(shipEntry({ tags: 'commit-digest,nanoclaw-v2' }))).toBe('nanoclaw-v2');
  });

  it('uses JSON-array tag fallback (legacy v1 format)', () => {
    expect(extractRepo(shipEntry({ tags: '["commit-digest","example-app"]' }))).toBe('example-app');
  });

  it('uses title prefix when colon appears in first 40 chars', () => {
    expect(extractRepo(shipEntry({ title: 'nanoclaw-v2: bump foo' }))).toBe('nanoclaw-v2');
  });

  it("returns 'Other' when title colon is past char 40", () => {
    expect(extractRepo(shipEntry({ title: 'this is a very long title with no colon for fifty chars: ok' }))).toBe(
      'Other',
    );
  });

  it("returns 'Other' when nothing matches", () => {
    expect(extractRepo(shipEntry({ title: 'just a plain title' }))).toBe('Other');
  });

  it('prefers pr_url over title prefix', () => {
    expect(
      extractRepo(
        shipEntry({
          pr_url: 'https://github.com/owner/repo/pull/1',
          title: 'something-else: blah',
        }),
      ),
    ).toBe('owner/repo');
  });
});

describe('isCommitScanEntry', () => {
  it('is false when no tags', () => {
    expect(isCommitScanEntry(shipEntry({ tags: null }))).toBe(false);
  });

  it('detects the comma-separated commit-scan tag', () => {
    expect(isCommitScanEntry(shipEntry({ tags: 'commit-digest,nanoclaw-v2' }))).toBe(true);
  });

  it('detects the legacy JSON-array commit-digest tag', () => {
    expect(isCommitScanEntry(shipEntry({ tags: '["commit-digest","example-app"]' }))).toBe(true);
  });

  it('is false for agent-recorded entries (non commit-digest tags)', () => {
    expect(isCommitScanEntry(shipEntry({ tags: 'feature,backend' }))).toBe(false);
    expect(isCommitScanEntry(shipEntry({ tags: '["feature"]' }))).toBe(false);
  });
});

describe('formatDigest', () => {
  const WG = 'example-retail';

  it('emits only the header when all sources are empty', () => {
    const out = formatDigest(WG, emptySummary());
    // Header line only — caller is expected to skip-empty before formatting.
    expect(out).toBe('📋 **Daily Summary** — example-retail');
  });

  it('uses the provided workgroup label in the header', () => {
    expect(formatDigest('example-labs', emptySummary())).toContain('— example-labs');
  });

  it('renders Agent Shipped without per-repo header when only one repo', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      agentShipped: [
        shipEntry({ title: 'fix: x', pr_url: 'https://github.com/o/r/pull/1' }),
        shipEntry({ id: 'ship-2', title: 'feat: y', pr_url: 'https://github.com/o/r/pull/2' }),
      ],
    });
    expect(out).toContain('🤖 **Agent Shipped** (2):');
    expect(out).not.toContain('**o/r**');
    expect(out).toContain('• fix: x — https://github.com/o/r/pull/1');
    expect(out).toContain('• feat: y — https://github.com/o/r/pull/2');
  });

  it('renders a separate Other commits section for commit-scan work', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      agentShipped: [shipEntry({ title: 'agent: did a thing', pr_url: 'https://github.com/o/r/pull/9' })],
      otherCommits: [shipEntry({ id: 'c1', title: 'human fix', tags: 'commit-digest,nanoclaw-v2' })],
    });
    expect(out).toContain('🤖 **Agent Shipped** (1):');
    expect(out).toContain('• agent: did a thing — https://github.com/o/r/pull/9');
    expect(out).toContain('🛠 **Other commits** (1):');
    expect(out).toContain('• human fix');
  });

  it('emits per-repo header when multiple repos', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      agentShipped: [
        shipEntry({ title: 'a', pr_url: 'https://github.com/o/r1/pull/1' }),
        shipEntry({ id: 'ship-2', title: 'b', pr_url: 'https://github.com/o/r2/pull/2' }),
      ],
    });
    expect(out).toContain('**o/r1**');
    expect(out).toContain('**o/r2**');
  });

  it('omits PR-url suffix when entry has no pr_url', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      agentShipped: [shipEntry({ title: 'plain-shipped', pr_url: null })],
    });
    expect(out).toContain('• plain-shipped');
    expect(out).not.toContain('• plain-shipped —');
  });

  it('renders Resolved with the right emoji per status', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      resolved: [
        backlogItem({ id: 'b1', title: 'fixed-issue', status: 'resolved' }),
        backlogItem({ id: 'b2', title: 'wont-do', status: 'wont_fix' }),
      ],
    });
    expect(out).toContain('✅ **Resolved** (2):');
    expect(out).toContain('✅ fixed-issue');
    expect(out).toContain('🚫 wont-do');
  });

  it('parent carries the backlog headline; the ranked list lives in the thread part', () => {
    const { parent, backlogThread } = formatDigestParts(WG, {
      ...emptySummary(),
      openBacklog: [
        backlogItem({ id: 'b1', title: 'high-thing', priority: 'high', status: 'open' }),
        backlogItem({ id: 'b2', title: 'mid-thing', priority: 'medium', status: 'in_progress' }),
        backlogItem({ id: 'b3', title: 'low-thing', priority: 'low', status: 'open' }),
      ],
    });
    expect(parent).toContain('📌 **Open Backlog** (3) — ranked list in 🧵');
    expect(parent).not.toContain('high-thing');
    expect(backlogThread).toContain('🔴 high-thing');
    expect(backlogThread).toContain('🟡 mid-thing');
    expect(backlogThread).toContain('· in progress');
    expect(backlogThread).toContain('⚪ low-thing');
    expect(backlogThread).toContain('👉 **Address first:**');
  });

  it('ranks in-progress first, then priority, then oldest', () => {
    const ranked = rankBacklog([
      backlogItem({ id: 'b1', title: 'old-low', priority: 'low', status: 'open', created_at: '2026-01-01T00:00:00Z' }),
      backlogItem({
        id: 'b2',
        title: 'new-high',
        priority: 'high',
        status: 'open',
        created_at: '2026-07-01T00:00:00Z',
      }),
      backlogItem({
        id: 'b3',
        title: 'old-high',
        priority: 'high',
        status: 'open',
        created_at: '2026-02-01T00:00:00Z',
      }),
      backlogItem({
        id: 'b4',
        title: 'wip-low',
        priority: 'low',
        status: 'in_progress',
        created_at: '2026-06-01T00:00:00Z',
      }),
    ]);
    expect(ranked.map((i) => i.title)).toEqual(['wip-low', 'old-high', 'new-high', 'old-low']);
  });

  it('shows item descriptions as an indented why-line in the thread', () => {
    const { backlogThread } = formatDigestParts(WG, {
      ...emptySummary(),
      openBacklog: [
        backlogItem({
          id: 'b1',
          title: 'thing',
          priority: 'high',
          status: 'open',
          description: 'exists because X breaks Y',
        }),
      ],
    });
    expect(backlogThread).toContain('↳ exists because X breaks Y');
  });

  it('shipLog:false drops the shipped sections but keeps backlog + resolved', () => {
    const { parent } = formatDigestParts(
      WG,
      {
        ...emptySummary(),
        agentShipped: [shipEntry({ title: 'agent-ship' })],
        otherCommits: [shipEntry({ title: 'human-ship', tags: 'commit-digest,repo' })],
        resolved: [backlogItem({ id: 'r1', title: 'fixed-thing', status: 'resolved' })],
        openBacklog: [backlogItem({ id: 'b1', title: 'open-thing', priority: 'low', status: 'open' })],
      },
      { includeShipLog: false },
    );
    expect(parent).not.toContain('agent-ship');
    expect(parent).not.toContain('human-ship');
    expect(parent).toContain('fixed-thing');
    expect(parent).toContain('📌 **Open Backlog** (1)');
  });

  it('resolved:false produces an open-backlog-only parent when shipLog is also false', () => {
    const { parent, backlogThread } = formatDigestParts(
      WG,
      {
        ...emptySummary(),
        agentShipped: [shipEntry({ title: 'agent-ship' })],
        otherCommits: [shipEntry({ title: 'human-ship', tags: 'commit-digest,repo' })],
        resolved: [backlogItem({ id: 'r1', title: 'fixed-thing', status: 'resolved' })],
        openBacklog: [backlogItem({ id: 'b1', title: 'open-thing', priority: 'high', status: 'open' })],
      },
      { includeShipLog: false, includeResolved: false },
    );
    expect(parent).toBe('📋 **Daily Summary** — example-retail\n\n📌 **Open Backlog** (1) — ranked list in 🧵');
    expect(backlogThread).toContain('🔴 open-thing');
  });

  it('omits sections that have no entries', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      agentShipped: [shipEntry({ title: 'only-ship' })],
    });
    expect(out).toContain('🤖 **Agent Shipped**');
    expect(out).not.toContain('🛠 **Other commits**');
    expect(out).not.toContain('✅ **Resolved**');
    expect(out).not.toContain('📌 **Open Backlog**');
  });
});

describe('deliverBacklogThread', () => {
  it('creates a real thread from the parent message when the adapter supports it (Discord shape)', async () => {
    const createThread = vi.fn().mockResolvedValue({ threadId: '999888777', messageId: 'm1' });
    const deliver = vi.fn().mockResolvedValue('m2');

    await deliverBacklogThread({ deliver, createThread }, 'discord', 'discord:guild:chan', 'parent-msg-id', 'short list');

    // Regression guard for the 404 "Unknown Channel" bug: a Discord thread id
    // is a real channel that must come from createThread, never a bare
    // `<platform_id>:<parentMessageId>` string built by hand.
    expect(createThread).toHaveBeenCalledWith('discord', 'discord:guild:chan', 'parent-msg-id', 'Open Backlog', 'short list');
    expect(deliver).not.toHaveBeenCalled(); // single chunk — no remainder to send
  });

  it('sends remaining chunks into the created thread when the list exceeds one message', async () => {
    const createThread = vi.fn().mockResolvedValue({ threadId: 'thread-1', messageId: 'm1' });
    const deliver = vi.fn().mockResolvedValue('m2');
    // Real production lists run this long (a 60-item workgroup's ranked
    // backlog is ~14k chars) — split() at THREAD_MESSAGE_LIMIT (1900)
    // guarantees more than one chunk here.
    const longList = Array.from({ length: 400 }, (_, i) => `item ${i} some description text`).join('\n');
    const expectedChunks = splitForLimit(longList, 1900);
    expect(expectedChunks.length).toBeGreaterThan(1); // sanity: the fixture actually needs multiple messages

    await deliverBacklogThread({ deliver, createThread }, 'discord', 'discord:guild:chan', 'parent-msg-id', longList);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread).toHaveBeenCalledWith('discord', 'discord:guild:chan', 'parent-msg-id', 'Open Backlog', expectedChunks[0]);
    expect(deliver).toHaveBeenCalledTimes(expectedChunks.length - 1);
    for (const [i, call] of deliver.mock.calls.entries()) {
      expect(call).toEqual([
        'discord',
        'discord:guild:chan',
        'discord:guild:chan:thread-1',
        'chat',
        JSON.stringify({ text: expectedChunks[i + 1] }),
      ]);
    }
  });

  it('falls back to a flat thread_ts post when the adapter has no createThread (Slack-only-deliver shape)', async () => {
    const deliver = vi.fn().mockResolvedValue('m2');

    await deliverBacklogThread({ deliver }, 'slack', 'slack:T1:C1', 'parent-ts', 'short list');

    expect(deliver).toHaveBeenCalledWith('slack', 'slack:T1:C1', 'slack:T1:C1:parent-ts', 'chat', JSON.stringify({ text: 'short list' }));
  });

  it('falls back to a channel-root post when the parent post returned no id', async () => {
    const createThread = vi.fn().mockResolvedValue({ threadId: 'thread-1', messageId: 'm1' });
    const deliver = vi.fn().mockResolvedValue('m2');

    await deliverBacklogThread({ deliver, createThread }, 'discord', 'discord:guild:chan', undefined, 'short list');

    expect(createThread).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith('discord', 'discord:guild:chan', null, 'chat', JSON.stringify({ text: 'short list' }));
  });
});
