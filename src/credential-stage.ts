import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { log } from './log.js';

export const DBT_CONTAINER_DIR = '/home/node/.dbt';

export function copySecretFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface StagedProfile {
  outputs: Record<string, unknown>;
  keys: Array<{ src: string; rel: string }>;
}

interface Refusal {
  refused: string;
  at: string;
}

function findInlineKey(v: unknown, at: string): string | null {
  if (Array.isArray(v)) {
    for (const [i, item] of v.entries()) {
      const hit = findInlineKey(item, `${at}[${i}]`);
      if (hit) return hit;
    }
  } else if (isRecord(v)) {
    for (const [k, item] of Object.entries(v)) {
      if (k === 'private_key') return `${at}.${k}`;
      const hit = findInlineKey(item, `${at}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveKeyPath(keyPath: unknown, home: string): { src: string; rel: string } | string {
  if (typeof keyPath !== 'string') return 'private_key_path is not a string';
  if (!path.isAbsolute(keyPath) && !keyPath.startsWith('~/')) return 'private_key_path is not absolute';
  let src: string;
  try {
    src = fs.realpathSync(path.resolve(home, keyPath.startsWith('~/') ? keyPath.slice(2) : keyPath));
  } catch {
    return 'private_key_path does not exist';
  }
  const rel = path.relative(fs.realpathSync(home), src);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
    return 'private_key_path is outside the home directory';
  if (!fs.statSync(src).isFile()) return 'private_key_path is not a file';
  return { src, rel };
}

function stageProfileOutputs(outputs: Record<string, unknown>, home: string): StagedProfile | Refusal {
  const staged: Record<string, unknown> = {};
  const keys: StagedProfile['keys'] = [];
  for (const [name, output] of Object.entries(outputs)) {
    if (!isRecord(output) || output.private_key_path === undefined) {
      staged[name] = output;
      continue;
    }
    const key = resolveKeyPath(output.private_key_path, home);
    if (typeof key === 'string') return { refused: key, at: `outputs.${name}.private_key_path` };
    keys.push(key);
    staged[name] = { ...output, private_key_path: path.posix.join(DBT_CONTAINER_DIR, 'keys', key.rel) };
  }
  return { outputs: staged, keys };
}

/** Inline `private_key` refuses the whole profile: agents print the staged profiles.yml into transcripts. */
export function stageDbtProfiles(opts: {
  profilesPath: string;
  home: string;
  dest: string;
  allowedProfiles: string[] | null;
  agent: string;
}): void {
  const parsed: unknown = YAML.parse(fs.readFileSync(opts.profilesPath, 'utf-8'), { merge: true }) ?? {};
  if (!isRecord(parsed)) throw new Error('profiles.yml is not a mapping');

  const refuse = (profile: string, r: Refusal): void =>
    log.warn('dbt profile not staged (fail closed)', { agent: opts.agent, profile, at: r.at, reason: r.refused });

  const staged: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(parsed)) {
    if (opts.allowedProfiles && !opts.allowedProfiles.includes(name)) continue;
    const inline = findInlineKey(profile, name);
    if (inline) {
      refuse(name, { refused: 'inline private_key', at: inline });
      continue;
    }
    if (!isRecord(profile) || !isRecord(profile.outputs)) {
      staged[name] = profile;
      continue;
    }
    const result = stageProfileOutputs(profile.outputs, opts.home);
    if ('refused' in result) {
      refuse(name, result);
      continue;
    }
    for (const key of result.keys) copySecretFile(key.src, path.join(opts.dest, 'keys', key.rel));
    staged[name] = { ...profile, outputs: result.outputs };
  }
  fs.writeFileSync(path.join(opts.dest, 'profiles.yml'), YAML.stringify(staged), { mode: 0o600 });
}
