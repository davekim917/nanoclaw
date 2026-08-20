import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { formatBuildInfoLog, readBuildInfo } from './build-info.js';

describe('formatBuildInfoLog', () => {
  it('formats a clean build as info-level provenance', () => {
    const { msg, data } = formatBuildInfoLog({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: false,
    });
    expect(msg).toBe('Build provenance');
    expect(data).toEqual({
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: false,
    });
  });

  it('flags a dirty build in the message', () => {
    const { msg, data } = formatBuildInfoLog({
      sha: 'b'.repeat(40),
      shortSha: 'bbbbbbb',
      builtAt: '2026-08-20T00:00:00.000Z',
      branch: 'main',
      dirty: true,
    });
    expect(msg).toContain('DIRTY');
    expect(data.dirty).toBe(true);
  });
});

describe('readBuildInfo', () => {
  it('returns null when dist/BUILD_INFO.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the file is malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), '{ "sha": "x"'); // truncated JSON
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when required fields are missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), JSON.stringify({ sha: 'abc' }));
      expect(readBuildInfo(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a well-formed file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist'));
      const info = {
        sha: 'c'.repeat(40),
        shortSha: 'ccccccc',
        builtAt: '2026-08-20T00:00:00.000Z',
        branch: 'main',
        dirty: false,
      };
      fs.writeFileSync(path.join(dir, 'dist', 'BUILD_INFO.json'), JSON.stringify(info));
      expect(readBuildInfo(dir)).toEqual(info);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
