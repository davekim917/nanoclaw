/** Tone profile resolution: the group-local mount wins over the shared fleet-wide one. */
import fs from 'fs';
import path from 'path';

const GROUP_TONE_DIR = '/workspace/tone-profiles-group';
const SHARED_TONE_DIR = '/workspace/tone-profiles';

export const WRITING_RULES_FILE = 'writing-rules.md';
export const SELECTION_GUIDE_FILE = 'selection-guide.md';

const SEARCH_DIRS = [GROUP_TONE_DIR, SHARED_TONE_DIR];

/** `get_tone_profile` takes the name from the agent: anything but one path segment is a path-traversal read. */
export function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/** Absolute path of `<name>.md`, or null when no mount has it. */
function resolveToneProfilePath(name: string, dirs: string[] = SEARCH_DIRS): string | null {
  if (!isSafeProfileName(name)) return null;
  for (const dir of dirs) {
    const candidate = path.join(dir, `${name}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Profile body, or null when the name is unsafe or unknown. */
export function readToneProfile(name: string, dirs: string[] = SEARCH_DIRS): string | null {
  const file = resolveToneProfilePath(name, dirs);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

export function readToneAuxFile(filename: string, dirs: string[] = SEARCH_DIRS): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      try {
        return fs.readFileSync(candidate, 'utf-8');
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Selectable profile names across both mounts, deduped, group-local shadowing shared. */
export function listToneProfileNames(dirs: string[] = SEARCH_DIRS): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === WRITING_RULES_FILE || f === SELECTION_GUIDE_FILE) continue;
      names.add(f.slice(0, -'.md'.length));
    }
  }
  return [...names].sort();
}
