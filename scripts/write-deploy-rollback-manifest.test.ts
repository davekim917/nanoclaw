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
const script = path.join(root, 'scripts', 'write-deploy-rollback-manifest.mjs');
const SHA = 'a'.repeat(40);

interface Manifest {
  commit: string;
  imageBase: string;
  timestamp: string;
  node: string;
  restartedUnits?: unknown;
}

function run(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('node', [script], {
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

describe('write-deploy-rollback-manifest', () => {
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
