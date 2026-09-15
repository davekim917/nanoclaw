/**
 * The deploy's long-running-service restart, exercised rather than grepped.
 *
 * `scripts/deploy.sh` restarted `nanoclaw-v2` and nothing else, so
 * `nanoclaw-codex-sync.service` — `pnpm exec tsx src/codex-sync-watcher.ts`,
 * whose tsx process loads the TypeScript once at start — sat two days behind
 * main and kept re-mirroring a stale `CODEX_WORKER_MODELS`
 * (`src/claude-agent-md.ts:40`, read at `:161`). A string assertion that
 * `deploy.sh` mentions that unit would have passed with the restart appended
 * BELOW the `systemctl restart nanoclaw-v2` that kills the script, i.e. on a
 * line that never runs. So these tests run the real tail of the script against
 * a fake `systemctl` that records every invocation and, for `nanoclaw-v2`,
 * SIGKILLs its caller the way systemd's default `control-group` KillMode does
 * (`src/channels/discord-slash-commands.ts:110-118` spawns the deploy detached,
 * which changes its process group but not its cgroup). Anything on the far side
 * of that restart is therefore unreachable in the harness too.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf-8');

/** Pull a top-level shell function out of deploy.sh by name. */
function shellFunction(name: string): string {
  const body = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))?.[0];
  expect(body, `deploy.sh no longer defines ${name}()`).toBeDefined();
  return body!;
}

/**
 * Everything from the planted-host-dir sweep — the last step before the restart
 * sequence, and a different concern from it — to the end of the file. The
 * anchor sits ABOVE the sibling-restart block and stays above it however that
 * block or the crash-guard manifest is moved, so a mutation that relocates the
 * restarts below the nanoclaw-v2 handoff still lands inside this slice, and is
 * then caught by the SIGKILL.
 */
function deployTail(): string {
  const anchor = script.indexOf('write_status "running" "planted host-dir sweep" ""');
  expect(anchor, 'planted host-dir sweep anchor missing from deploy.sh').toBeGreaterThan(0);
  return script.slice(anchor);
}

interface FakeUnit {
  id: string;
  type: string;
  workingDirectory: string;
  active: boolean;
}

interface Harness {
  dir: string;
  bin: string;
  unitsFile: string;
  callsFile: string;
  repoRoot: string;
}

let harness: Harness;

/**
 * A `systemctl` that answers from a unit table, plus a `sudo` that just execs
 * its arguments so the stub is what `sudo systemctl restart X` reaches.
 *
 * KILL_ON models the real thing: `systemctl restart nanoclaw-v2` tears down the
 * cgroup the deploy script lives in. `sudo` is exec'd, not forked, so the
 * stub's PPID is the script shell itself.
 */
function writeFakes(bin: string, unitsFile: string, callsFile: string): void {
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  // The slice opens with the planted-host-dir sweep (`pnpm exec tsx ...`),
  // which is somebody else's gate and already has its own tests.
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    [
      '#!/bin/sh',
      `echo "$*" >> "${callsFile}"`,
      '[ -n "$SYSTEMCTL_BROKEN" ] && exit 1',
      'sub="$1"; shift',
      'case "$sub" in',
      '  list-units)',
      // The flag is the protection, so the double has to honour it: with
      // --state=active only active units are listed, without it (--all) every
      // loaded unit is. A fake that always filters would let the flag be
      // deleted and still pass.
      '    only_active=0',
      '    for arg in "$@"; do',
      '      [ "$arg" = "--state=active" ] && only_active=1',
      '    done',
      '    while IFS="|" read -r id type wd act; do',
      '      [ "$only_active" = 1 ] && [ "$act" != "1" ] && continue',
      '      if [ "$act" = "1" ]; then s="active running"; else s="inactive dead"; fi',
      '      printf "%s loaded %s Fake unit\\n" "$id" "$s"',
      `    done < "${unitsFile}"`,
      '    ;;',
      '  show)',
      '    first=1',
      '    for arg in "$@"; do',
      '      case "$arg" in --*) continue ;; esac',
      '      while IFS="|" read -r id type wd act; do',
      '        [ "$id" = "$arg" ] || continue',
      '        [ "$first" = 1 ] || printf "\\n"',
      '        first=0',
      // Deliberately not alphabetical, and Id in the middle: systemctl does not
      // promise an order, so the parser must key on the property name.
      '        printf "Type=%s\\nWorkingDirectory=%s\\nId=%s\\n" "$type" "$wd" "$id"',
      `      done < "${unitsFile}"`,
      '    done',
      '    ;;',
      '  is-active)',
      '    for arg in "$@"; do',
      '      case "$arg" in --*) continue ;; esac',
      '      while IFS="|" read -r id type wd act; do',
      '        [ "$id" = "$arg" ] || continue',
      '        [ "$act" = "1" ] && exit 0',
      `      done < "${unitsFile}"`,
      '    done',
      '    exit 1',
      '    ;;',
      '  restart)',
      '    [ "$1" = "$KILL_ON" ] && kill -KILL "$PPID"',
      '    [ "$1" = "$FAIL_UNIT" ] && exit 1',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function writeUnits(units: FakeUnit[]): void {
  fs.writeFileSync(
    harness.unitsFile,
    `${units.map((u) => `${u.id}|${u.type}|${u.workingDirectory}|${u.active ? 1 : 0}`).join('\n')}\n`,
  );
}

function runProbe(body: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const probe = path.join(harness.dir, 'probe.sh');
  fs.writeFileSync(probe, body);
  return spawnSync('bash', [probe], {
    cwd: harness.dir,
    env: { ...process.env, PATH: `${harness.bin}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
}

function calls(): string[] {
  if (!fs.existsSync(harness.callsFile)) return [];
  return fs.readFileSync(harness.callsFile, 'utf-8').split('\n').filter(Boolean);
}

function restartCalls(): string[] {
  return calls()
    .filter((line) => line.startsWith('restart '))
    .map((line) => line.slice('restart '.length));
}

function status(): { status?: string; step?: string; error?: string } {
  return JSON.parse(fs.readFileSync(path.join(harness.dir, 'status.json'), 'utf-8')) as {
    status?: string;
    step?: string;
    error?: string;
  };
}

/** The crash-guard manifest onward, with the pieces the slice reads set up. */
function tailProbe(): string {
  return [
    '#!/usr/bin/env bash',
    `REPO_ROOT="${harness.repoRoot}"`,
    `STATUS_FILE="${path.join(harness.dir, 'status.json')}"`,
    `LOG="${path.join(harness.dir, 'deploy.log')}"`,
    'PRE_COMMIT="0000000000000000000000000000000000000000"',
    'IMAGE_SAVED_BASE=""',
    'MIGRATION_CHANGES=""',
    'RESTART_ATTEMPTED_UNITS=""',
    'COMMIT_RESTORED=0',
    'DEPLOY_HANDOFF=0',
    // Stands in for restore_before_restart: what the rollback would have to put
    // back is whatever this variable holds when the script leaves.
    `trap 'printf "%s" "$RESTART_ATTEMPTED_UNITS" > "${path.join(harness.dir, 'attempted')}"' EXIT`,
    shellFunction('write_status'),
    shellFunction('long_running_repo_units'),
    deployTail(),
    '',
  ].join('\n');
}

function attempted(): string[] {
  if (!fs.existsSync(path.join(harness.dir, 'attempted'))) return [];
  return fs.readFileSync(path.join(harness.dir, 'attempted'), 'utf-8').split(' ').filter(Boolean);
}

const THIS_HOST: FakeUnit[] = [
  { id: 'nanoclaw-v2.service', type: 'simple', workingDirectory: '/srv/checkout', active: true },
  { id: 'nanoclaw-codex-sync.service', type: 'simple', workingDirectory: '/srv/checkout', active: true },
  // oneshot: re-executed per timer fire, so it always has current code.
  { id: 'nanoclaw-storage-gc.service', type: 'oneshot', workingDirectory: '/srv/checkout', active: true },
  // Type=simple but not this checkout's code (this host really has one:
  // nanoclaw-container-limits.service -> /usr/local/sbin).
  { id: 'nanoclaw-container-limits.service', type: 'simple', workingDirectory: '', active: true },
  { id: 'sshd.service', type: 'notify', workingDirectory: '/', active: true },
];

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-siblings-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  harness = {
    dir,
    bin,
    unitsFile: path.join(dir, 'units'),
    callsFile: path.join(dir, 'calls'),
    repoRoot: '/srv/checkout',
  };
  writeFakes(bin, harness.unitsFile, harness.callsFile);
  writeUnits(THIS_HOST);
});

afterEach(() => {
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

describe('deploy long-running-service discovery', () => {
  function discover(units: FakeUnit[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
    writeUnits(units);
    return runProbe(
      [
        '#!/usr/bin/env bash',
        `REPO_ROOT="${harness.repoRoot}"`,
        shellFunction('long_running_repo_units'),
        'if long_running_repo_units; then echo "rc=0"; else echo "rc=$?"; fi',
        '',
      ].join('\n'),
      env,
    );
  }

  it('finds every active non-oneshot unit rooted in this checkout, and nothing else', () => {
    const out = discover(THIS_HOST).stdout.trim().split('\n');
    expect(out).toEqual(['nanoclaw-v2.service', 'nanoclaw-codex-sync.service', 'rc=0']);
  });

  it('is not a list of names — a future watcher is found without editing deploy.sh', () => {
    // Not `Type=simple`, not `nanoclaw-`-prefixed, and its WorkingDirectory
    // carries systemd's optional `-` prefix. All three are shapes a hardcoded
    // second unit name, a `simple`-only filter or a naive parse would miss.
    const out = discover([
      ...THIS_HOST,
      { id: 'quota-daemon.service', type: 'notify', workingDirectory: '-/srv/checkout', active: true },
    ])
      .stdout.trim()
      .split('\n');
    expect(out).toContain('quota-daemon.service');
  });

  it('never starts a unit the operator has stopped or disabled', () => {
    const out = discover([
      ...THIS_HOST,
      { id: 'nanoclaw-parked.service', type: 'simple', workingDirectory: '/srv/checkout', active: false },
    ]).stdout;
    expect(out).not.toContain('nanoclaw-parked.service');
  });

  it('answers "could not look" with a non-zero exit, never with an empty list', () => {
    const broken = discover(THIS_HOST, { SYSTEMCTL_BROKEN: '1' });
    expect(broken.stdout.trim()).toBe('rc=1');
  });
});

/**
 * The shell's in-memory unit list dies with the `systemctl restart nanoclaw-v2`
 * that kills the script, so the post-handoff crash rollback
 * (src/deploy-crash-guard.ts `performRollback`) cannot read it. The manifest
 * carries it across. These tests pin the producing half of that contract;
 * src/deploy-crash-guard.test.ts pins the consuming half.
 */
describe('deploy records what it restarted for the crash guard', () => {
  function manifest(): { restartedUnits?: unknown } | null {
    const file = path.join(harness.dir, 'data', 'deploy-rollback.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as { restartedUnits?: unknown };
  }

  it('lists the units it restarted, as valid JSON', () => {
    runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2' });
    expect(manifest()?.restartedUnits).toEqual(['nanoclaw-codex-sync.service']);
  });

  it('emits an empty list, not an absent field, on a sibling-free host', () => {
    // Absent means "written by a deploy.sh that predates this"; `[]` means
    // "this deploy looked and found none". The guard reports them differently.
    writeUnits(THIS_HOST.filter((u) => u.id !== 'nanoclaw-codex-sync.service'));
    runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2' });
    expect(manifest()?.restartedUnits).toEqual([]);
  });

  it('arms no rollback point at all when a sibling restart failed', () => {
    // The manifest is written after the loop, so a deploy whose siblings did
    // not come back can never hand the crash guard a list it cannot trust.
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2', FAIL_UNIT: 'nanoclaw-codex-sync.service' });
    expect(run.status).toBe(1);
    expect(manifest()).toBeNull();
  });
});

describe('deploy restarts every long-running service before the handoff', () => {
  it('restarts the siblings on the reachable side of the script-killing restart', () => {
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2' });
    // The fake killed the script exactly where systemd would, which is the
    // whole point: if the sibling restart moved below that line, the recorded
    // calls would stop at nanoclaw-v2 and this assertion would fail.
    expect(run.signal).toBe('SIGKILL');
    expect(restartCalls()).toEqual(['nanoclaw-codex-sync.service', 'nanoclaw-v2']);
    expect(status()).toMatchObject({ status: 'ok', step: 'done' });
  });

  it('deploys normally on a host that has no sibling services', () => {
    // A fork/upstream install never installs scripts/nanoclaw-codex-sync.service
    // (setup/service.ts:409-434 writes only the main unit). "No siblings" is a
    // legitimate answer and must not be read as a broken enumeration.
    writeUnits(THIS_HOST.filter((u) => u.id !== 'nanoclaw-codex-sync.service'));
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2' });
    expect(run.signal).toBe('SIGKILL');
    expect(restartCalls()).toEqual(['nanoclaw-v2']);
    expect(status()).toMatchObject({ status: 'ok' });
  });

  it('reports failed, names the unit and never restarts the host when a sibling restart fails', () => {
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2', FAIL_UNIT: 'nanoclaw-codex-sync.service' });
    expect(run.status).toBe(1);
    expect(run.signal).toBeNull();
    expect(restartCalls()).toEqual(['nanoclaw-codex-sync.service']);
    const s = status();
    expect(s.status).toBe('failed');
    expect(s.step).toBe('sibling service restart');
    expect(s.error).toContain('nanoclaw-codex-sync.service');
    // Recorded BEFORE the attempt, so the unit whose restart failed — the one
    // now in an unknown state — is exactly the one the rollback puts back.
    expect(attempted()).toEqual(['nanoclaw-codex-sync.service']);
  });

  it('refuses the deploy when the enumeration loses its own control unit', () => {
    // nanoclaw-v2 is running but the discovery cannot see it — a REPO_ROOT that
    // does not match the unit byte for byte, a moved `systemctl show` shape. The
    // same empty answer a sibling-free host gives, so the control is the only
    // thing that tells them apart.
    writeUnits(
      THIS_HOST.map((u) => (u.id === 'nanoclaw-v2.service' ? { ...u, workingDirectory: '/srv/checkout/' } : u)),
    );
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2' });
    expect(run.status).toBe(1);
    expect(restartCalls()).toEqual([]);
    expect(status()).toMatchObject({ status: 'failed', step: 'sibling service restart' });
    expect(status().error).toContain('nanoclaw-v2.service');
  });

  it('refuses the deploy when systemctl cannot be read at all', () => {
    const run = runProbe(tailProbe(), { KILL_ON: 'nanoclaw-v2', SYSTEMCTL_BROKEN: '1' });
    expect(run.status).toBe(1);
    expect(restartCalls()).toEqual([]);
    expect(status()).toMatchObject({ status: 'failed', step: 'sibling service restart' });
    expect(status().error).toContain('enumerate');
  });
});

describe('deploy rollback puts restarted siblings back on the restored build', () => {
  function rollbackProbe(porcelain: string): string {
    // `git`: `status --porcelain` answers $PORCELAIN, `reset --hard` succeeds.
    fs.writeFileSync(
      path.join(harness.bin, 'git'),
      '#!/bin/sh\nif [ "$1" = "status" ]; then printf "%s" "$PORCELAIN"; fi\nexit 0\n',
      { mode: 0o755 },
    );
    return [
      '#!/usr/bin/env bash',
      `STATUS_FILE="${path.join(harness.dir, 'status.json')}"`,
      `LOG="${path.join(harness.dir, 'deploy.log')}"`,
      'PRE_COMMIT="0000000000000000000000000000000000000000"',
      'IMAGE_SAVED_BASE=""',
      'ROLLBACK_READY=1',
      'DEPLOY_HANDOFF=0',
      'COMMIT_RESTORED=0',
      'RESTART_ATTEMPTED_UNITS="nanoclaw-codex-sync.service "',
      `PORCELAIN='${porcelain}'`,
      'export PORCELAIN',
      shellFunction('tracked_changes'),
      shellFunction('restore_before_restart'),
      'false',
      'restore_before_restart',
      '',
    ].join('\n');
  }

  it('restarts them back after the commit reset', () => {
    // Rolling the checkout back without this leaves the sibling resident on the
    // code the rollback just removed — the same class, mirrored.
    const run = runProbe(rollbackProbe(''));
    expect(run.status).toBe(1);
    expect(restartCalls()).toEqual(['nanoclaw-codex-sync.service']);
  });

  it('leaves them alone when the reset was skipped to preserve tracked changes', () => {
    // No reset means the checkout is still at the new commit, which is what the
    // sibling is already running; restarting it would change nothing.
    const run = runProbe(rollbackProbe(' M src/foo.ts'));
    expect(run.status).toBe(1);
    expect(restartCalls()).toEqual([]);
  });
});
