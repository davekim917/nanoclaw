import { describe, expect, it } from 'vitest';

import {
  carriesAgentIdentity,
  hostReachableProxy,
  renderBoard,
  repoOf,
  severityOf,
  type BoardIssue,
} from './backlog-canvas.js';

function issue(over: Partial<BoardIssue> = {}): BoardIssue {
  return {
    identifier: 'EX-1',
    title: 'thing',
    url: 'https://linear.app/example/issue/EX-1',
    priority: 0,
    status: 'Backlog',
    statusType: 'backlog',
    labels: [],
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('repoOf', () => {
  it('reads the repo: label, the only repo signal that survives GitHub sync', () => {
    expect(repoOf(issue({ labels: ['bug', 'repo:EX-ANALYTICS'] }))).toBe('EX-ANALYTICS');
  });

  it('buckets unlabelled rows instead of dropping them', () => {
    expect(repoOf(issue({ labels: ['Bug'] }))).toContain('Unattributed');
  });
});

describe('severityOf', () => {
  it('prefers the severity label, which is what GitHub-synced rows carry', () => {
    expect(severityOf(issue({ labels: ['severity:p1'], priority: 4 }))).toBe('p1');
  });

  it('falls back to Linear priority for native tickets that have no label', () => {
    expect(severityOf(issue({ priority: 1 }))).toBe('p0'); // 1 = Urgent
    expect(severityOf(issue({ priority: 4 }))).toBe('p3'); // 4 = Low
  });

  it('treats Linear priority 0 as unset, not as lowest', () => {
    expect(severityOf(issue({ priority: 0 }))).toBe('unset');
  });
});

describe('renderBoard', () => {
  // Load-bearing, not cosmetic: canvases.edit takes ONE operation per call and
  // a section is a header plus its body, so a second header would strand
  // A channel canvas pins its first block, so the title is written once at
  // create and survives every replace. Emitting a heading here would stack a
  // second title under the pinned one on every refresh — which is exactly the
  // bug that put eight copies of the board on screen.
  it('emits no markdown heading, because the pinned canvas block owns the title', () => {
    const cases = [
      [],
      [issue()],
      [issue({ labels: ['repo:example-app'] }), issue({ identifier: 'EX-2', labels: ['repo:example-analytics'] })],
    ];
    for (const issues of cases) {
      expect((renderBoard(issues).match(/^#/gm) || []).length).toBe(0);
    }
  });

  it('groups by repo, then by severity within each repo', () => {
    const md = renderBoard([
      issue({ identifier: 'EX-A', labels: ['repo:example-app', 'severity:p2'] }),
      issue({ identifier: 'EX-B', labels: ['repo:example-app', 'severity:p0'] }),
      issue({ identifier: 'EX-C', labels: ['repo:example-analytics', 'severity:p1'] }),
    ]);
    expect(md).toContain('**example-analytics — 1**');
    expect(md).toContain('**example-app — 2**');
    // p0 before p2 inside the example-app group
    expect(md.indexOf('EX-B')).toBeLessThan(md.indexOf('EX-A'));
  });

  it('sorts the unattributed bucket last, since it is the least actionable', () => {
    const md = renderBoard([
      issue({ identifier: 'EX-N', labels: [] }),
      issue({ identifier: 'EX-Z', labels: ['repo:ZEBRA'] }),
    ]);
    expect(md.indexOf('ZEBRA')).toBeLessThan(md.indexOf('Unattributed'));
  });

  it('strips repo and severity from the row, since both are already the grouping', () => {
    const md = renderBoard([issue({ labels: ['repo:example-app', 'severity:p1', 'smoke-finding'] })]);
    expect(md).toContain('`smoke-finding`');
    expect(md).not.toContain('`repo:example-app`');
    expect(md).not.toContain('`severity:p1`');
  });

  it('marks in-progress rows without adding a third grouping axis', () => {
    expect(renderBoard([issue({ statusType: 'started' })])).toContain('_in progress_');
  });

  it('links each row to its tracker item', () => {
    expect(renderBoard([issue()])).toContain('[EX-1](https://linear.app/example/issue/EX-1)');
  });

  it('says so when the board is empty rather than rendering a bare header', () => {
    expect(renderBoard([])).toContain('Nothing open.');
  });
});

describe('carriesAgentIdentity', () => {
  // The gateway picks WHICH credentials to inject from the identity in the
  // proxy URL's userinfo. The host's own HTTPS_PROXY has none, so it resolves
  // to the Default Agent — which does not hold the workgroup-scoped Linear
  // secret. That is 686 consecutive 401s on one install.
  it('accepts the container-style URL that actually carries an identity', () => {
    expect(carriesAgentIdentity('http://x:aoc_deadbeef@host.docker.internal:10255')).toBe(true);
  });

  it('rejects the bare host proxy URL, which silently means Default Agent', () => {
    expect(carriesAgentIdentity('http://127.0.0.1:10255')).toBe(false);
  });

  it('is not fooled by an @ that appears after the host', () => {
    // Without anchoring the userinfo before the first slash, a path containing
    // @ would read as an identity and we would send an unauthenticated request
    // believing it was scoped.
    expect(carriesAgentIdentity('http://127.0.0.1:10255/path@notuserinfo')).toBe(false);
  });

  it('rejects empty input rather than throwing', () => {
    expect(carriesAgentIdentity('')).toBe(false);
  });
});

describe('hostReachableProxy', () => {
  // getContainerConfig answers with the URL a CONTAINER would use. Using it
  // verbatim on the host fails as a bare "fetch failed" with no mention of
  // proxies, which is a miserable thing to debug.
  const container = 'http://x:aoc_token@host.docker.internal:10255';

  it('keeps the agent identity but takes the address from the host proxy', () => {
    expect(hostReachableProxy(container, { HTTPS_PROXY: 'http://127.0.0.1:10255' })).toBe(
      'http://x:aoc_token@127.0.0.1:10255',
    );
  });

  it('does not inherit the host proxy identity, only its address', () => {
    // The host's own proxy resolves to the Default Agent. Carrying its
    // userinfo across would silently undo the whole fix.
    expect(hostReachableProxy(container, { HTTPS_PROXY: 'http://x:someothertoken@127.0.0.1:10255' })).toBe(
      'http://x:aoc_token@127.0.0.1:10255',
    );
  });

  it('leaves the URL alone when no host proxy is configured', () => {
    expect(hostReachableProxy(container, {})).toBe(container);
  });

  it('leaves an identity-less URL alone rather than inventing one', () => {
    expect(hostReachableProxy('http://host.docker.internal:10255', { HTTPS_PROXY: 'http://127.0.0.1:10255' })).toBe(
      'http://host.docker.internal:10255',
    );
  });
});
