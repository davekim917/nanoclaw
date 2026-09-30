import fs from 'fs';
import os from 'os';
import path from 'path';

import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stageDbtProfiles } from './credential-stage.js';

let home: string;
let dest: string;

function writeKey(rel: string): void {
  const p = path.join(home, '.snowflake', 'keys', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `fake-key-${rel}`);
}

function writeProfiles(profiles: Record<string, unknown>): string {
  const p = path.join(home, '.dbt', 'profiles.yml');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(profiles));
  return p;
}

function snowflakeProfile(auth: Record<string, unknown>): Record<string, unknown> {
  return { target: 'dev', outputs: { dev: { type: 'snowflake', account: 'acct', user: 'u', ...auth } } };
}

type StagedProfiles = Record<string, { outputs: Record<string, Record<string, unknown>> }>;

function stage(allowedProfiles: string[] | null): StagedProfiles {
  stageDbtProfiles({ profilesPath: path.join(home, '.dbt', 'profiles.yml'), home, dest, allowedProfiles, agent: 't' });
  return YAML.parse(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')) as StagedProfiles;
}

function stagedKeys(): string[] {
  const keysDir = path.join(dest, 'keys');
  if (!fs.existsSync(keysDir)) return [];
  return fs
    .readdirSync(keysDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(keysDir, path.join(e.parentPath, e.name)))
    .sort();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-stage-home-'));
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-stage-dest-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

describe('stageDbtProfiles', () => {
  it('refuses a profile whose output carries an inline private_key, keeping the others', () => {
    writeKey('ok/rsa_key.p8');
    writeProfiles({
      inline: {
        target: 'dev',
        outputs: {
          dev: { type: 'snowflake', private_key_path: path.join(home, '.snowflake/keys/ok/rsa_key.p8') },
          prod: { type: 'snowflake', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' },
        },
      },
      pw: snowflakeProfile({ password: 'x' }),
    });

    const staged = stage(null);

    expect(Object.keys(staged)).toEqual(['pw']);
    expect(fs.readFileSync(path.join(dest, 'profiles.yml'), 'utf-8')).not.toContain('PRIVATE KEY');
    expect(stagedKeys()).toEqual([]);
  });

  it('rewrites private_key_path to the container dir and copies only the referenced key at 0600', () => {
    writeKey('mr/rsa_key.p8');
    writeKey('mr/rsa_key.pub');
    writeKey('other/rsa_key.p8');
    writeProfiles({ mr: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/mr/rsa_key.p8') }) });

    const staged = stage(null);

    expect(staged.mr.outputs.dev.private_key_path).toBe('/home/node/.dbt/keys/.snowflake/keys/mr/rsa_key.p8');
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 'mr', 'rsa_key.p8')]);
    const copied = path.join(dest, 'keys', '.snowflake', 'keys', 'mr', 'rsa_key.p8');
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(copied, 'utf-8')).toBe('fake-key-mr/rsa_key.p8');
  });

  it('expands a ~/ private_key_path against home', () => {
    writeKey('t/rsa_key.p8');
    writeProfiles({ t: snowflakeProfile({ private_key_path: '~/.snowflake/keys/t/rsa_key.p8' }) });

    expect(stage(null).t.outputs.dev.private_key_path).toBe('/home/node/.dbt/keys/.snowflake/keys/t/rsa_key.p8');
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 't', 'rsa_key.p8')]);
  });

  it('scoped staging copies only the keys of the allowed profiles', () => {
    writeKey('a/rsa_key.p8');
    writeKey('b/rsa_key.p8');
    writeProfiles({
      a: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/a/rsa_key.p8') }),
      b: snowflakeProfile({ private_key_path: path.join(home, '.snowflake/keys/b/rsa_key.p8') }),
    });

    const staged = stage(['a']);

    expect(Object.keys(staged)).toEqual(['a']);
    expect(stagedKeys()).toEqual([path.join('.snowflake', 'keys', 'a', 'rsa_key.p8')]);
  });

  it.each([
    ['outside home', '/etc/passwd'],
    ['relative', 'keys/rsa_key.p8'],
    ['traversing out of home', '~/../escape.p8'],
    ['missing', '~/.snowflake/keys/none.p8'],
  ])('refuses a profile whose private_key_path is %s', (_label, keyPath) => {
    writeProfiles({ bad: snowflakeProfile({ private_key_path: keyPath }), pw: snowflakeProfile({ password: 'x' }) });

    expect(Object.keys(stage(null))).toEqual(['pw']);
    expect(stagedKeys()).toEqual([]);
  });

  it('throws on a profiles.yml that is not a mapping', () => {
    fs.mkdirSync(path.join(home, '.dbt'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dbt', 'profiles.yml'), '- a\n- b\n');

    expect(() => stage(null)).toThrow('not a mapping');
  });
});
