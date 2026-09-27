/**
 * Per-channel operating rules: room policy, not voice (tone has its own single slot). No fleet-wide fallback
 * directory on purpose; fleet-wide rules belong in standing-instructions.md.
 */
import fs from 'fs';
import path from 'path';

const CHANNEL_INSTRUCTIONS_DIR = '/workspace/channel-instructions';

/** The name arrives as an env string and indexes a filename: anything but one lowercase path segment is a path-traversal read. */
export function isSafeInstructionsProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/** Absolute path of `<name>.md`, or null when the name is unsafe or unknown. */
export function resolveChannelInstructionsPath(name: string, dir: string = CHANNEL_INSTRUCTIONS_DIR): string | null {
  if (!isSafeInstructionsProfileName(name)) return null;
  const candidate = path.join(dir, `${name}.md`);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Profile body, or null when the name is unsafe, unknown, or unreadable. */
export function readChannelInstructions(name: string, dir: string = CHANNEL_INSTRUCTIONS_DIR): string | null {
  const file = resolveChannelInstructionsPath(name, dir);
  if (!file) return null;
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/** Selectable profile names in the mount, sorted. Empty when nothing is mounted. */
export function listChannelInstructionsNames(dir: string = CHANNEL_INSTRUCTIONS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length))
      .filter(isSafeInstructionsProfileName)
      .sort();
  } catch {
    return [];
  }
}
