/**
 * Materialize plugin skills whose `SKILL.md` upstream ships as a SYMLINK.
 *
 * Codex's native plugin loader silently skips such a skill (verified in-container
 * 2026-07-22: humanizer ships `skills/humanizer/SKILL.md -> ../../SKILL.md` and
 * loaded 0 skills, while impeccable's real file loaded fine). Some upstreams use
 * that shape deliberately, keeping a root-level SKILL.md as the source of truth.
 *
 * We therefore write a real skills tree under `<plugin>/.nanoclaw/codex-skills/`
 * — a real dir per skill holding a REAL `SKILL.md` copy plus symlinks for sibling
 * files — and point the generated `.codex-plugin` manifest at it. The path sits
 * inside the plugin clone but under NanoClaw's own `.nanoclaw/` namespace, so it
 * stays untracked by the plugin's git and never conflicts with `git pull`.
 *
 * Because the SKILL.md is a COPY, it would go stale after an upstream update.
 * `refreshMaterializedCodexSkills()` re-materializes every already-materialized
 * plugin and is called from the hourly plugin-update refresh, BEFORE the codex
 * plugin cache is re-copied — so a `git pull` propagates all the way through to
 * what Codex actually reads.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** NanoClaw-owned, git-untracked skills root we materialize into. */
export const CODEX_MATERIALIZED_ROOT = path.join('.nanoclaw', 'codex-skills');

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

/**
 * If any skill under `<dir>/<skillsRoot>` has a symlinked SKILL.md, materialize the
 * whole set into `<dir>/.nanoclaw/codex-skills/` and return that root. Otherwise
 * return `skillsRoot` unchanged (nothing to do — Codex reads the originals fine).
 */
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
          // Real copy — the whole point: Codex must see a regular file here.
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
  /** Plugin folders that had an existing materialized tree and were refreshed. */
  refreshed: string[];
}

/**
 * Re-materialize every plugin that already has a `.nanoclaw/codex-skills/` tree.
 *
 * Deliberately only touches plugins already set up that way — this is a staleness
 * refresh, not a discovery pass, so it never invents materialized trees for plugins
 * the operator hasn't enabled for Codex.
 */
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
