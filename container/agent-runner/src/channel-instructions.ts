/**
 * Per-channel operating instructions — the room's rule set, not its voice.
 *
 * One mount, one namespace:
 *
 *   /workspace/channel-instructions   groups/<folder>/channel-instructions/
 *
 * The host resolves `messaging_group_agents.instructions_profile` for the
 * wiring this session belongs to and forwards the name as
 * NANOCLAW_INSTRUCTIONS_PROFILE; this module turns that name into content.
 *
 * Deliberately NOT the tone slot. Tone is voice and has exactly one always-on
 * layer by invariant (see index.ts). Operating rules are a different axis —
 * "in this room you may only write to lab-* repos and never ask a question"
 * is a policy, not a register — and they are injected AHEAD of the tone block
 * so the agent reads what it may do before how it should sound.
 *
 * There is no shared fleet-wide fallback directory on purpose. A rule set that
 * applies everywhere is the group's standing-instructions.md, which is already
 * in every prompt; a second fleet-wide copy would only be a way for the two to
 * disagree. Workgroup siblings share one file by symlink, resolved host-side
 * at mount time, so the container always sees a real file.
 */
import fs from 'fs';
import path from 'path';

const CHANNEL_INSTRUCTIONS_DIR = '/workspace/channel-instructions';

/**
 * The name indexes a filename, and it arrives from the host as an env string,
 * so an unconstrained value is a path-traversal read of the whole container
 * FS. Single lowercase path segment, nothing else — stricter than the tone
 * profile rule (which predates this and also accepts uppercase and dots)
 * because these names are only ever created through `ncl wirings`, which
 * enforces the same pattern at the CLI.
 */
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
