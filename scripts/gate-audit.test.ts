import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

/**
 * .github/scripts/gate-audit.sh, main-provenance.yml's gate-audit job: for the PR a
 * push to main merged, run `codex-review.sh audit` and file one `gate-bypass` issue
 * per PR it flags. `gh` is faked; so is the audit helper (CODEX_REVIEW), whose own
 * rules scripts/codex-review.test.ts covers.
 */

const SCRIPT = path.resolve('.github/scripts/gate-audit.sh');
const SHA = '1234567890123456789012345678901234567890';
const roots: string[] = [];

interface Audit {
  status: number;
  out: string;
}

function audit(opts: {
  prs?: number[];
  audits?: Record<number, Audit>;
  filed?: { number: number; body: string }[];
  issueCreateFails?: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-audit-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(root, 'pulls.json'),
    JSON.stringify(
      (opts.prs ?? []).map((number) => ({
        number,
        merged_at: '2026-09-11T18:43:58Z',
        base: { ref: 'main' },
        merge_commit_sha: SHA,
      })),
    ),
  );
  fs.writeFileSync(path.join(root, 'issues.json'), JSON.stringify(opts.filed ?? []));
  if (opts.issueCreateFails) fs.writeFileSync(path.join(root, 'issue-create-fails'), '');
  for (const [pr, result] of Object.entries(opts.audits ?? {})) {
    fs.writeFileSync(path.join(root, `audit-${pr}.out`), result.out);
    fs.writeFileSync(path.join(root, `audit-${pr}.status`), String(result.status));
  }
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$MOCK_DIR/calls"
case "$1 $2" in
  "api repos/example/repository/commits/${SHA}/pulls") cat "$MOCK_DIR/pulls.json" ;;
  "api --paginate") cat "$MOCK_DIR/issues.json" ;;
  "label create") : ;;
  "issue create")
    if [ -f "$MOCK_DIR/issue-create-fails" ]; then echo 'gh: HTTP 403' >&2; exit 1; fi
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) printf '%s' "$2" > "$MOCK_DIR/issue-title" ;;
        --label) printf '%s' "$2" > "$MOCK_DIR/issue-label" ;;
        --body) printf '%s' "$2" > "$MOCK_DIR/issue-body" ;;
      esac
      shift
    done
    echo "https://github.com/example/repository/issues/900"
    ;;
  *) echo "unexpected gh $*" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const helper = path.join(root, 'codex-review.sh');
  fs.writeFileSync(
    helper,
    `#!/usr/bin/env bash
printf 'audit pr=%s %s\\n' "$PR" "$*" >> "$MOCK_DIR/calls"
cat "$MOCK_DIR/audit-$PR.out"
exit "$(cat "$MOCK_DIR/audit-$PR.status")"
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [SCRIPT, SHA], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REPO: 'example/repository',
      GH_TOKEN: 'unused',
      MOCK_DIR: root,
      CODEX_REVIEW: helper,
    },
  });
  const read = (name: string) =>
    fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;
  return {
    ...result,
    calls: read('calls') ?? '',
    title: read('issue-title'),
    label: read('issue-label'),
    body: read('issue-body'),
  };
}

const VIOLATION =
  "audit=violation pr=675 head=2e262d8a0 base=f2189f64e merged=2026-09-11T18:43:58Z verdict=skip: a fix PR merged with no 'Fixes-PR:' line in its body at merge time";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('gate-audit.sh', () => {
  it('files one gate-bypass issue, carrying the finding and its marker, for a PR the audit flags', () => {
    const result = audit({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } } });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('audit pr=675 audit');
    expect(result.calls).toMatch(/^gh label create gate-bypass --repo example\/repository --force /m);
    expect(result.title).toBe("Gate bypass: #675 merged without the merge gate's evidence");
    expect(result.label).toBe('gate-bypass');
    expect(result.body).toContain(VIOLATION);
    expect(result.body).toMatch(/<!-- gate-bypass pr=675 -->$/);
    expect(result.stdout).toContain('::warning::#675 merged without the merge gate');
  });

  it('never files a second issue for a PR already filed, whatever state that issue is in', () => {
    const result = audit({
      prs: [675],
      audits: { 675: { status: 28, out: VIOLATION } },
      filed: [
        { number: 812, body: 'first finding\n\n<!-- gate-bypass pr=674 -->' },
        { number: 813, body: 'first finding\n\n<!-- gate-bypass pr=675 -->' },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#675 is already filed as #813');
    expect(result.calls).not.toContain('gh issue create');
  });

  it("does not take another PR's issue for this one's", () => {
    const result = audit({
      prs: [675],
      audits: { 675: { status: 28, out: VIOLATION } },
      filed: [{ number: 812, body: '<!-- gate-bypass pr=6750 --> <!-- gate-bypass pr=67 -->' }],
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('gh issue create');
  });

  it.each([
    ['passes', { status: 0, out: 'audit=pass pr=675 head=h base=b merged=t verdict=skip: no risky file' }],
    ['was a legacy repo', { status: 0, out: 'audit=legacy pr=675 head=h base=b merged=t: not risk-scoped' }],
  ])('files nothing for a PR that %s', (_case, result) => {
    const run = audit({ prs: [675], audits: { 675: result } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(result.out);
    expect(run.calls).not.toMatch(/gh (label|issue) create/);
  });

  it('fails the job loudly, filing nothing, when the audit cannot judge the merge', () => {
    const result = audit({ prs: [675], audits: { 675: { status: 1, out: '' } } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::the gate audit could not judge #675 (exit 1)');
    expect(result.calls).not.toMatch(/gh (label|issue) create/);
  });

  it('fails the job loudly when the issue cannot be filed', () => {
    const result = audit({ prs: [675], audits: { 675: { status: 28, out: VIOLATION } }, issueCreateFails: true });
    expect(result.status).toBe(1);
  });

  it('audits nothing for a push that no merged PR produced, after waiting for the link', () => {
    const result = audit({ prs: [] });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${SHA} is no merged PR's merge commit`);
    expect(result.calls.match(/^gh api repos\/example\/repository\/commits\/\S+\/pulls$/gm)).toHaveLength(13);
    expect(result.calls).not.toContain('audit pr=');
  });

  it('audits every PR the push merged, and fails if any one cannot be judged', () => {
    const result = audit({
      prs: [675, 676],
      audits: { 675: { status: 28, out: VIOLATION }, 676: { status: 1, out: '' } },
    });
    expect(result.status).toBe(1);
    expect(result.calls).toContain('audit pr=675 audit');
    expect(result.calls).toContain('audit pr=676 audit');
    expect(result.calls).toContain('gh issue create');
  });
});
