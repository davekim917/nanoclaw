import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const HELPER = path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh');
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SINCE = '2026-09-05T00:00:00Z';
const REVIEWER = 'chatgpt-codex-connector';

type Page = Record<string, unknown>;

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
  roots.push(root);
  return root;
}

function connectionPage(
  connection: string,
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
  headRefOid = HEAD,
): Page {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          [connection]: { pageInfo: { hasNextPage, endCursor }, nodes },
        },
      },
    },
  };
}

function thread(isResolved: boolean, reviewId = 'review-1'): Page {
  return {
    isResolved,
    comments: { nodes: [{ author: { login: REVIEWER }, pullRequestReview: { id: reviewId } }] },
  };
}

function review(submittedAt: string, commit = HEAD): Page {
  return { author: { login: REVIEWER }, submittedAt, commit: { oid: commit } };
}

function reaction(createdAt: string): Page {
  return { content: 'THUMBS_UP', createdAt, user: { login: REVIEWER } };
}

function writePage(root: string, connection: string, page: number, value: Page): void {
  fs.writeFileSync(path.join(root, `${connection}-${page}.json`), JSON.stringify(value));
}

function writeMocks(root: string): { bin: string; calls: string; sleepLog: string; dateValues: string } {
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  const sleepLog = path.join(root, 'sleep');
  const dateValues = path.join(root, 'dates');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
query=""
after="null"
for arg in "$@"; do
  case "$arg" in
    query=*) query="\${arg#query=}" ;;
    after=*) after="\${arg#after=}" ;;
  esac
done
case "$query" in
  *reviewThreads*) connection=reviewThreads ;;
  *reviews*) connection=reviews ;;
  *reactions*) connection=reactions ;;
  *) echo "unexpected GraphQL query" >&2; exit 64 ;;
esac
page=1
[ "$after" = "null" ] || page=2
printf '%s %s\\n' "$connection" "$after" >> "$MOCK_CALLS"
if [ "$connection" = "reviewThreads" ] && [ -f "$MOCK_DIR/threads-after-review.json" ] && grep -q '^reviews ' "$MOCK_CALLS"; then
  cat "$MOCK_DIR/threads-after-review.json"
else
  cat "$MOCK_DIR/$connection-$page.json"
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'sleep'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_SLEEP_LOG"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'date'),
    `#!/usr/bin/env bash
set -euo pipefail
value=$(head -n 1 "$MOCK_DATE_VALUES")
sed -i '1d' "$MOCK_DATE_VALUES"
printf '%s\\n' "$value"
`,
    { mode: 0o755 },
  );
  return { bin, calls, sleepLog, dateValues };
}

function run(root: string, command: string, minutes?: string, sha = HEAD) {
  const { bin, calls, sleepLog, dateValues } = writeMocks(root);
  fs.writeFileSync(dateValues, '0\n0\n0\n60\n60\n');
  const result = spawnSync('bash', [HELPER, command, sha, SINCE, ...(minutes ? [minutes] : [])], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: 'example/repository',
      PR: '1',
      MOCK_DIR: root,
      MOCK_CALLS: calls,
      MOCK_SLEEP_LOG: sleepLog,
      MOCK_DATE_VALUES: dateValues,
    },
  });
  return {
    ...result,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    sleep: fs.existsSync(sleepLog) ? fs.readFileSync(sleepLog, 'utf8') : '',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('codex-review status and foreground wait', () => {
  it('paginates all GraphQL connections and ignores stale review and reaction evidence', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(true)], true, 'threads-2'));
    writePage(root, 'reviewThreads', 2, connectionPage('reviewThreads', [thread(true, 'review-2')]));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-04T23:59:59Z')], true, 'reviews-2'));
    writePage(root, 'reviews', 2, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(
      root,
      'reactions',
      1,
      connectionPage('reactions', [reaction('2026-09-04T23:59:59Z')], true, 'reactions-2'),
    );
    writePage(root, 'reactions', 2, connectionPage('reactions', [reaction('2026-09-05T00:02:00Z')]));

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=1 last_review_at=2026-09-05T00:01:00Z`);
    expect(result.stdout).toContain('reaction=1 last_thumbs_up_at=2026-09-05T00:02:00Z rounds=2');
    expect(result.calls).toContain('reviewThreads threads-2');
    expect(result.calls).toContain('reviews reviews-2');
    expect(result.calls).toContain('reactions reactions-2');
  });

  it('includes findings published with a review between the separate GraphQL requests', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));
    fs.writeFileSync(
      path.join(root, 'threads-after-review.json'),
      JSON.stringify(connectionPage('reviewThreads', [thread(false)])),
    );

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(10);
    expect(result.stdout).toContain(`codex=findings head=${HEAD} open=1 review=1`);
    expect(result.stdout).not.toContain('codex=clean');
  });

  it('reports unresolved Codex threads as findings even when they are from an older round', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(false)]));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-04T23:59:59Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', [reaction('2026-09-04T23:59:59Z')]));

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `codex=findings head=${HEAD} open=1 review=0 last_review_at=2026-09-04T23:59:59Z reaction=0 last_thumbs_up_at=2026-09-04T23:59:59Z`,
    );
  });

  it('reports a changed PR head as nonclean before accepting fresh evidence', () => {
    const root = tempRoot();
    const otherHead = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [], false, null, otherHead));
    writePage(
      root,
      'reviews',
      1,
      connectionPage('reviews', [review('2026-09-05T00:01:00Z', otherHead)], false, null, otherHead),
    );
    writePage(
      root,
      'reactions',
      1,
      connectionPage('reactions', [reaction('2026-09-05T00:02:00Z')], false, null, otherHead),
    );

    const result = run(root, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=head-changed head=${otherHead} open=0 review=1`);
  });

  it('accepts a documented short SHA after verifying it against the full PR head', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'status', undefined, HEAD.slice(0, 12));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`codex=clean head=${HEAD} open=0 review=1`);
  });

  it('fails a missing GraphQL connection instead of reporting a clean review', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));

    const result = run(root, 'status');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GraphQL reactions request failed');
    expect(result.stdout).not.toContain('codex=clean');
  });

  it('returns immediately for a clean foreground observation', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', [review('2026-09-05T00:01:00Z')]));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=clean');
    expect(result.sleep).toBe('');
  });

  it('returns immediately when an unresolved thread starts a new review round', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', [thread(false)]));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(10);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=findings');
    expect(result.sleep).toBe('');
  });

  it('returns a distinct timeout after foreground ticks at 60-second intervals', () => {
    const root = tempRoot();
    writePage(root, 'reviewThreads', 1, connectionPage('reviewThreads', []));
    writePage(root, 'reviews', 1, connectionPage('reviews', []));
    writePage(root, 'reactions', 1, connectionPage('reactions', []));

    const result = run(root, 'wait', '1');
    expect(result.status).toBe(11);
    expect(result.stdout).toContain('wait tick=0 elapsed=0s/60s codex=pending');
    expect(result.stdout).toContain('wait tick=1 elapsed=60s/60s codex=pending');
    expect(result.stderr).toContain('wait timeout after 1m; last observation: codex=pending');
    expect(result.sleep).toBe('60\n');
  });
});
