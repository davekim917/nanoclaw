import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/unit-failure-alert.sh');
const UNIT = 'example.service';
const OUT_NAME = `20260101T000000-unitfail-${UNIT}.md`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// A fixed clock makes the alert's file name predictable, which is exactly the
// property an agent with write access to the outbox could exploit.
function fixture(): { root: string; outbox: string; bin: string; tmp: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-alert-'));
  roots.push(root);
  const outbox = path.join(root, 'outbox');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(outbox);
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  fs.writeFileSync(
    path.join(bin, 'date'),
    '#!/bin/sh\ncase "$*" in *%H%M%S*) echo 20260101T000000 ;; *) echo "2026-01-01 00:00" ;; esac\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho "unit status line"\nexit 3\n', { mode: 0o755 });
  return { root, outbox, bin, tmp };
}

function run(outbox: string, bin: string, tmp: string) {
  return spawnSync('bash', [SCRIPT, UNIT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, UNIT_ALERT_OUTBOX: outbox },
  });
}

describe('unit-failure-alert.sh', () => {
  it('queues the alert as a regular .md file, staged outside the outbox, with no temp file left', () => {
    const { outbox, bin, tmp } = fixture();
    const result = run(outbox, bin, tmp);
    expect(result.status, result.stderr).toBe(0);
    const out = path.join(outbox, OUT_NAME);
    expect(fs.lstatSync(out).isFile()).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toContain('unit status line');
    expect(fs.readdirSync(outbox)).toEqual([OUT_NAME]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('replaces a symlink planted at the alert name instead of writing through it', () => {
    const { root, outbox, bin, tmp } = fixture();
    const victim = path.join(root, 'victim');
    fs.writeFileSync(victim, 'untouched\n');
    fs.symlinkSync(victim, path.join(outbox, OUT_NAME));

    const result = run(outbox, bin, tmp);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(fs.lstatSync(path.join(outbox, OUT_NAME)).isFile()).toBe(true);
  });

  it('replaces a planted symlink to a directory instead of moving the alert into it', () => {
    const { root, outbox, bin, tmp } = fixture();
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(outbox, OUT_NAME));

    const result = run(outbox, bin, tmp);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.lstatSync(path.join(outbox, OUT_NAME)).isFile()).toBe(true);
  });
});
