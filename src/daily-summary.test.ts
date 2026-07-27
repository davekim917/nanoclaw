import { describe, expect, it } from 'vitest';

import { extractRepo, formatDigest, isCommitScanEntry } from './daily-summary.js';
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

  it('renders Open Backlog with priority emoji + in-progress suffix', () => {
    const out = formatDigest(WG, {
      ...emptySummary(),
      openBacklog: [
        backlogItem({ id: 'b1', title: 'high-thing', priority: 'high', status: 'open' }),
        backlogItem({ id: 'b2', title: 'mid-thing', priority: 'medium', status: 'in_progress' }),
        backlogItem({ id: 'b3', title: 'low-thing', priority: 'low', status: 'open' }),
      ],
    });
    expect(out).toContain('📌 **Open Backlog** (3):');
    expect(out).toContain('🔴 high-thing');
    expect(out).toContain('🟡 mid-thing [in progress]');
    expect(out).toContain('⚪ low-thing');
    expect(out).not.toContain('🔴 high-thing [in progress]');
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
