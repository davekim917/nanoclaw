/**
 * Tone profile resolution — group-local first, shared fallback.
 *
 * Two mounts, one namespace:
 *
 *   /workspace/tone-profiles-group   groups/<folder>/tone-profiles/  (private groups repo)
 *   /workspace/tone-profiles         tone-profiles/                  (shared, fleet-wide)
 *
 * A group's own directory wins, so a workgroup can add profiles nobody else
 * sees (agent personas) or override a shared name for itself, without editing
 * the shared set. The shared set stays the common vocabulary.
 *
 * This is what makes voice per-CHANNEL selectable. A persona written as a
 * group-local profile is chosen through `messaging_group_agents.default_tone`
 * like any other tone, so one agent group can be its persona in one channel
 * and a plain shared tone in another. Voice lives in exactly one slot; there
 * is no second always-on voice layer to arbitrate against.
 */
import fs from 'fs';
import path from 'path';

export const GROUP_TONE_DIR = '/workspace/tone-profiles-group';
export const SHARED_TONE_DIR = '/workspace/tone-profiles';

export const WRITING_RULES_FILE = 'writing-rules.md';
export const SELECTION_GUIDE_FILE = 'selection-guide.md';

/** Resolution order: group-local overrides shared. */
const SEARCH_DIRS = [GROUP_TONE_DIR, SHARED_TONE_DIR];

/**
 * Profile names index a filename, and `get_tone_profile` takes its name from
 * the agent — so an unconstrained name is a path-traversal read of the whole
 * container FS. Names are single path segments, nothing else.
 */
export function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/** Absolute path of `<name>.md`, or null when no mount has it. */
export function resolveToneProfilePath(name: string, dirs: string[] = SEARCH_DIRS): string | null {
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

/** An auxiliary file (writing rules, selection guide), group-local first. */
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
