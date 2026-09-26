import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetShadowProcessForTesting, isShadowProcess, readShadowFlag } from './shadow-flag.js';

describe('readShadowFlag', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-flag-'));
    vi.stubEnv('NANOCLAW_SHADOW', undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is off with no environment variable and no .env', () => {
    expect(readShadowFlag(root)).toBe(false);
  });

  it('turns on from .env, quoted or not', () => {
    fs.writeFileSync(path.join(root, '.env'), 'OTHER=x\nNANOCLAW_SHADOW="1"\n');
    expect(readShadowFlag(root)).toBe(true);
  });

  it('treats only the literal 1 as on', () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=true\n');
    expect(readShadowFlag(root)).toBe(false);
  });

  it('fails closed when .env exists but cannot be read, instead of reading it as off', () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=1\n');
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw denied;
    });
    expect(() => readShadowFlag(root)).toThrow(denied);
  });

  it('still answers from the process environment when .env is unreadable', () => {
    vi.stubEnv('NANOCLAW_SHADOW', '1');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(readShadowFlag(root)).toBe(true);
  });

  it('lets the process environment override .env in both directions', () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=1\n');
    vi.stubEnv('NANOCLAW_SHADOW', '0');
    expect(readShadowFlag(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=0\n');
    vi.stubEnv('NANOCLAW_SHADOW', '1');
    expect(readShadowFlag(root)).toBe(true);
  });
});

describe('isShadowProcess', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-process-'));
    vi.stubEnv('NANOCLAW_SHADOW', undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    _resetShadowProcessForTesting();
  });

  afterEach(() => {
    _resetShadowProcessForTesting();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('decides once, from the working directory, and ignores a later .env edit', () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=1\n');
    expect(isShadowProcess()).toBe(true);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=0\n');
    expect(isShadowProcess()).toBe(true);
    fs.rmSync(path.join(root, '.env'));
    expect(isShadowProcess()).toBe(true);
  });

  it('stays off for the process when it starts off', () => {
    expect(isShadowProcess()).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SHADOW=1\n');
    expect(isShadowProcess()).toBe(false);
  });
});
