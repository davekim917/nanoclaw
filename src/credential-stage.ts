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

function stageProfileOutputs(
  outputs: Record<string, unknown>,
  home: string,
): StagedProfile | { refused: string; output: string } {
  const staged: Record<string, unknown> = {};
  const keys: StagedProfile['keys'] = [];
  for (const [name, output] of Object.entries(outputs)) {
    if (!isRecord(output)) {
      staged[name] = output;
      continue;
    }
    if (output.private_key !== undefined) return { refused: 'inline private_key', output: name };
    const keyPath = output.private_key_path;
    if (keyPath === undefined) {
      staged[name] = output;
      continue;
    }
    if (typeof keyPath !== 'string') return { refused: 'private_key_path is not a string', output: name };
    if (!path.isAbsolute(keyPath) && !keyPath.startsWith('~/')) {
      return { refused: 'private_key_path is not absolute', output: name };
    }
    const abs = path.resolve(home, keyPath.startsWith('~/') ? keyPath.slice(2) : keyPath);
    const rel = path.relative(home, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { refused: 'private_key_path is outside the home directory', output: name };
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { refused: 'private_key_path does not exist', output: name };
    }
    keys.push({ src: abs, rel });
    staged[name] = { ...output, private_key_path: path.posix.join(DBT_CONTAINER_DIR, 'keys', rel) };
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
  const parsed: unknown = YAML.parse(fs.readFileSync(opts.profilesPath, 'utf-8')) ?? {};
  if (!isRecord(parsed)) throw new Error('profiles.yml is not a mapping');

  const staged: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(parsed)) {
    if (opts.allowedProfiles && !opts.allowedProfiles.includes(name)) continue;
    if (!isRecord(profile) || !isRecord(profile.outputs)) {
      staged[name] = profile;
      continue;
    }
    const result = stageProfileOutputs(profile.outputs, opts.home);
    if ('refused' in result) {
      log.warn('dbt profile not staged (fail closed)', {
        agent: opts.agent,
        profile: name,
        output: result.output,
        reason: result.refused,
      });
      continue;
    }
    for (const key of result.keys) copySecretFile(key.src, path.join(opts.dest, 'keys', key.rel));
    staged[name] = { ...profile, outputs: result.outputs };
  }
  fs.writeFileSync(path.join(opts.dest, 'profiles.yml'), YAML.stringify(staged), { mode: 0o600 });
}
