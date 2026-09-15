/**
 * The rollback manifest's encoder.
 *
 * r2 [high]: `scripts/deploy.sh` built this object with a `printf` template, so
 * a unit id carrying a backslash — which systemd's own escaping produces, e.g.
 * `nanoclaw-worker@blue\x2dgreen.service` — emitted `"...blue\x2dgreen..."`,
 * which is not valid JSON. The write succeeded, the restart handed off, and on
 * the next boot `readJson` (src/deploy-crash-guard.ts:111-117) caught the parse
 * error and answered null, `evaluateBoot` (:134) read null as `no-op`, and
 * `runDeployCrashGuard` (:273) returned — silently losing automatic rollback
 * for the host and every sibling, on a deployment that was crash-looping.
 *
 * These tests run the real script with crafted environments and assert the
 * bytes parse back to exactly what went in. They exercise characters the shell
 * pipeline above the encoder cannot actually carry (a unit id cannot hold
 * whitespace — systemd escapes it) precisely because the encoder must not
 * depend on that: the defect was a producer that was only correct while its
 * inputs happened to be tame.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'write-deploy-json.mjs');
const SHA = 'a'.repeat(40);

interface Manifest {
  commit: string;
  imageBase: string;
  timestamp: string;
  node: string;
  restartedUnits?: unknown;
}

function run(
  env: Record<string, string>,
  shape = 'rollback-manifest',
): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('node', [script, shape], {
    cwd: root,
    env: { ...process.env, NANOCLAW_ROLLBACK_COMMIT: SHA, ...env },
    encoding: 'utf8',
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

/** Parse the way the guard's readJson does: any throw is a lost rollback. */
function parsed(env: Record<string, string>): Manifest {
  const out = run(env);
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Manifest;
}

describe('write-deploy-json: rollback-manifest', () => {
  it('round-trips a unit id holding a backslash, a quote and a control character', () => {
    const hostile = 'nanoclaw-worker@blue\\x2dgreen\\x22quote"\tliteral.service';
    expect(hostile).toContain('\\');
    expect(hostile).toContain('"');
    expect(hostile).toContain('\t');
    expect(parsed({ NANOCLAW_ROLLBACK_UNITS: hostile }).restartedUnits).toEqual([hostile]);
  });

  it('the exact counterexample from the review parses (r2 [high] regression)', () => {
    // systemd-escape output. The old printf template wrote this raw and
    // produced "Bad escaped character in JSON".
    const unit = 'nanoclaw-worker@blue\\x2dgreen.service';
    expect(parsed({ NANOCLAW_ROLLBACK_UNITS: unit }).restartedUnits).toEqual([unit]);
  });

  it('carries every field through the encoder, not just the list', () => {
    // `commit` and `imageBase` cannot hold a metacharacter today, but that is a
    // property of their producers, not of the format. Encoding them all means a
    // field added later is safe without anyone re-deriving this argument.
    const m = parsed({
      NANOCLAW_ROLLBACK_IMAGE_BASE: 'image\\with"both',
      NANOCLAW_ROLLBACK_NODE: 'v22\\"0',
      NANOCLAW_ROLLBACK_TIMESTAMP: '2026-09-15T00:00:00Z',
      NANOCLAW_ROLLBACK_UNITS: '',
    });
    expect(m.imageBase).toBe('image\\with"both');
    expect(m.node).toBe('v22\\"0');
    expect(m.timestamp).toBe('2026-09-15T00:00:00Z');
  });

  it('splits the list on newlines only, and always emits the key', () => {
    const m = parsed({ NANOCLAW_ROLLBACK_UNITS: 'a.service\nb.service\n' });
    expect(m.restartedUnits).toEqual(['a.service', 'b.service']);
    // `[]` and an absent key are different answers to the guard, so an empty
    // input must still produce the key.
    const none = parsed({ NANOCLAW_ROLLBACK_UNITS: '' });
    expect(none.restartedUnits).toEqual([]);
    expect(Object.keys(none)).toContain('restartedUnits');
    const unset = parsed({});
    expect(unset.restartedUnits).toEqual([]);
  });

  it('refuses to emit a manifest without a usable commit', () => {
    // A manifest the guard cannot act on is worse than none: deploy.sh fails
    // the deploy on a non-zero exit here, while its trap can still restore.
    for (const commit of ['', 'not-a-sha', 'A'.repeat(40), `${SHA}extra`]) {
      const out = run({ NANOCLAW_ROLLBACK_COMMIT: commit });
      expect(out.status, commit).toBe(1);
      expect(out.stdout, commit).toBe('');
      expect(out.stderr).toContain('NANOCLAW_ROLLBACK_COMMIT');
    }
  });
});

/**
 * r3: the manifest got the encoder and the STATUS did not, so the failure
 * status naming a unit id still pasted it into a template — the same defect at
 * the call site the first fix did not audit, on the artifact the announcer and
 * the health alert read.
 */
describe('write-deploy-json: status', () => {
  function statusOf(env: Record<string, string>): { status: number | null; parsed: Record<string, string> } {
    const out = run({ NANOCLAW_STATUS_STATUS: 'failed', ...env }, 'status');
    expect(out.status, out.stderr).toBe(0);
    return { status: out.status, parsed: JSON.parse(out.stdout) as Record<string, string> };
  }

  it('round-trips an error holding a backslash, a quote and a control character', () => {
    const message = 'systemctl restart nanoclaw-worker@blue\\x2dgreen"q".service\tfailed';
    expect(message).toContain('\\');
    expect(message).toContain('"');
    expect(message).toContain('\t');
    expect(statusOf({ NANOCLAW_STATUS_ERROR: message }).parsed.error).toBe(message);
  });

  it('carries step and timestamp through the encoder too', () => {
    const p = statusOf({
      NANOCLAW_STATUS_STEP: 'sibling "service" restart\\',
      NANOCLAW_STATUS_TIMESTAMP: '2026-09-15T00:00:00Z',
    }).parsed;
    expect(p.step).toBe('sibling "service" restart\\');
    expect(p.timestamp).toBe('2026-09-15T00:00:00Z');
    expect(p.status).toBe('failed');
  });

  it('refuses a status outside the announcer’s vocabulary', () => {
    // deploy.sh's fallback reproduces `status` from a closed set of three shell
    // literals. That is only sound because nothing else can get through here.
    for (const value of ['', 'OK', 'done', 'failed\\"']) {
      const out = run({ NANOCLAW_STATUS_STATUS: value }, 'status');
      expect(out.status, value).toBe(1);
      expect(out.stdout, value).toBe('');
    }
    for (const value of ['ok', 'running', 'failed']) {
      expect(run({ NANOCLAW_STATUS_STATUS: value }, 'status').status, value).toBe(0);
    }
  });

  it('refuses an unknown shape rather than guessing one', () => {
    for (const shape of ['', 'manifest', 'Status']) {
      const out = run({ NANOCLAW_STATUS_STATUS: 'ok' }, shape);
      expect(out.status, shape).toBe(1);
      expect(out.stdout, shape).toBe('');
    }
  });
});
