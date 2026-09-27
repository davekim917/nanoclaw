/**
 * Codex's plugin loader silently skips a skill whose `SKILL.md` is a symlink, so such plugins get a real tree under
 * `<plugin>/.nanoclaw/codex-skills/` (a real SKILL.md copy plus symlinked siblings; untracked by the plugin's git),
 * which the generated `.codex-plugin` manifest points at. The copy goes stale on `git pull`, so the hourly plugin
 * refresh re-materializes BEFORE the Codex plugin cache is re-copied.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const CODEX_MATERIALIZED_ROOT = path.join('.nanoclaw', 'codex-skills');

/** Skill-root layouts we know how to materialize from, in discovery preference order. */
const SKILLS_ROOT_CANDIDATES = [path.join('.agents', 'skills'), 'skills', path.join('plugin', 'skills')];

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findCodexSkillsRoot(dir: string): string | null {
  for (const rel of SKILLS_ROOT_CANDIDATES) {
    if (isDirectory(path.join(dir, rel))) return rel;
  }
  return null;
}

/** Materialize when any skill's SKILL.md is a symlink; otherwise `skillsRoot` unchanged. */
export function materializeSymlinkedSkills(dir: string, skillsRoot: string, dryRun = false): string {
  const srcRoot = path.join(dir, skillsRoot);
  let entries: string[];
  try {
    entries = fs.readdirSync(srcRoot);
  } catch {
    return skillsRoot;
  }
  const symlinked = entries.filter((e) => {
    try {
      return fs.lstatSync(path.join(srcRoot, e, 'SKILL.md')).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (symlinked.length === 0) return skillsRoot;
  if (dryRun) return CODEX_MATERIALIZED_ROOT;

  for (const skill of entries) {
    const from = path.join(srcRoot, skill);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
    const to = path.join(dir, CODEX_MATERIALIZED_ROOT, skill);
    fs.mkdirSync(to, { recursive: true });
    for (const child of fs.readdirSync(from)) {
      const childSrc = path.join(from, child);
      const childDst = path.join(to, child);
      try {
        fs.rmSync(childDst, { recursive: true, force: true });
        if (child === 'SKILL.md') {
          // Codex must see a regular file here.
          fs.writeFileSync(childDst, fs.readFileSync(childSrc));
        } else {
          fs.symlinkSync(fs.realpathSync(childSrc), childDst);
        }
      } catch {
        /* best-effort per child; a partial skill dir still beats none */
      }
    }
  }
  return CODEX_MATERIALIZED_ROOT;
}

export interface MaterializeRefreshResult {
  refreshed: string[];
}

/** Staleness refresh of plugins already materialized; never materializes a plugin not set up that way. */
export function refreshMaterializedCodexSkills(
  pluginsRoot = path.join(os.homedir(), 'plugins'),
): MaterializeRefreshResult {
  const refreshed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(pluginsRoot);
  } catch {
    return { refreshed };
  }
  for (const name of names) {
    const dir = path.join(pluginsRoot, name);
    if (!isDirectory(path.join(dir, CODEX_MATERIALIZED_ROOT))) continue;
    const root = findCodexSkillsRoot(dir);
    if (root === null || root === CODEX_MATERIALIZED_ROOT) continue;
    materializeSymlinkedSkills(dir, root, false);
    refreshed.push(name);
  }
  return { refreshed };
}
