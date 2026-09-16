import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPortableSkills, resolvePluginRoots, syncSkillSymlinks } from './plugin-skill-discovery.js';
import { copyOpenCodeSkills, mirrorSourceRootsByName } from './providers/opencode.js';

/**
 * The host reads plugin-chosen paths and writes the result into a directory
 * mounted into an OpenCode container. A symlink out of a plugin repository
 * therefore moves HOST-ONLY state across that boundary — the host does the read
 * and hands the bytes over, with no container escape involved. That a plugin's
 * code is already trusted to RUN in the container is a different permission
 * (#829, the generalization of the #826 finding to this second reader).
 *
 * These cases walk the real production path end to end: discover under a fake
 * `~/plugins`, mirror with `syncSkillSymlinks`, then copy the mirror into a
 * stand-in session XDG with `copyOpenCodeSkills`. Asserting on the final copy is
 * deliberate — it is the only place that matches what a container can read.
 */
describe('plugin skill mirror containment', () => {
  let tmp: string;
  let plugins: string;
  let secretDir: string;
  let secret: string;

  const writeSkill = (dir: string, name: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nbody\n`);
  };

  /** Discover → mirror → copy, exactly as opencode-sync + the provider do. */
  const runPipeline = (): { mirror: string; xdg: string; refused: string[] } => {
    const mirror = path.join(tmp, 'mirror');
    const xdg = path.join(tmp, 'xdg');
    const discovered = discoverPortableSkills(plugins, { runtime: 'opencode' });
    const result = syncSkillSymlinks(mirror, discovered);
    copyOpenCodeSkills(mirror, xdg, {
      allowedRoots: resolvePluginRoots(plugins),
      sourceRootsByName: mirrorSourceRootsByName(plugins),
    });
    return { mirror, xdg, refused: result.refused };
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-containment-'));
    plugins = path.join(tmp, 'plugins');
    secretDir = path.join(tmp, 'host-only');
    fs.mkdirSync(secretDir, { recursive: true });
    secret = path.join(secretDir, 'auth.json');
    fs.writeFileSync(secret, 'HOST-ONLY-SECRET');
    writeSkill(path.join(plugins, 'good', 'skills', 'helper'), 'helper');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not copy a skill child symlinked outside its own plugin repository', () => {
    const skillDir = path.join(plugins, 'evil', 'skills', 'leak');
    writeSkill(skillDir, 'leak');
    fs.symlinkSync(secret, path.join(skillDir, 'notes.md'));

    const { mirror, xdg, refused } = runPipeline();

    expect(refused).toContain('leak/notes.md');
    expect(fs.existsSync(path.join(mirror, 'leak', 'notes.md'))).toBe(false);
    expect(fs.existsSync(path.join(xdg, 'leak', 'notes.md'))).toBe(false);
    // The rest of the skill is untouched: the escape is refused, not the feature.
    expect(fs.existsSync(path.join(xdg, 'leak', 'SKILL.md'))).toBe(true);
    // And the host-only file is not anywhere in the container-visible copy.
    expect(readAll(xdg)).not.toContain('HOST-ONLY-SECRET');
  });

  it('does not copy a SKILL.md symlinked outside the repository', () => {
    // SKILL.md is COPIED rather than linked, so this read happens at mirror
    // time and nothing downstream could see it as a link.
    const skillDir = path.join(plugins, 'evil', 'skills', 'leak');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(secret, path.join(skillDir, 'SKILL.md'));

    const { mirror, xdg } = runPipeline();

    expect(fs.existsSync(path.join(mirror, 'leak', 'SKILL.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('HOST-ONLY-SECRET');
  });

  it('does not walk a skill DIRECTORY symlinked outside the repository', () => {
    const outside = path.join(tmp, 'outside-skill');
    writeSkill(outside, 'ghost');
    fs.writeFileSync(path.join(outside, 'stolen.md'), 'HOST-ONLY-SECRET');
    fs.mkdirSync(path.join(plugins, 'evil', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(plugins, 'evil', 'skills', 'ghost'));

    const { xdg, refused } = runPipeline();

    expect(refused).toContain('ghost');
    expect(fs.existsSync(path.join(xdg, 'ghost'))).toBe(false);
    expect(readAll(xdg)).not.toContain('HOST-ONLY-SECRET');
  });

  it('a sibling directory named <root>-evil does not prefix-match the containment root', () => {
    // `good-evil` is NOT inside `good`; a containment check comparing raw
    // string prefixes without a separator boundary would say it is.
    const sibling = path.join(plugins, 'good-evil');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'stolen.md'), 'HOST-ONLY-SECRET');
    fs.symlinkSync(path.join(sibling, 'stolen.md'), path.join(plugins, 'good', 'skills', 'helper', 'notes.md'));

    const { refused, xdg } = runPipeline();

    expect(refused).toContain('helper/notes.md');
    expect(fs.existsSync(path.join(xdg, 'helper', 'notes.md'))).toBe(false);
  });

  it('still mirrors an IN-REPO symlink, including one crossing into a sibling directory', () => {
    const shared = path.join(plugins, 'good', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'ref.md'), 'in-repo reference');
    fs.symlinkSync(path.join(shared, 'ref.md'), path.join(plugins, 'good', 'skills', 'helper', 'notes.md'));

    const { mirror, xdg, refused } = runPipeline();

    expect(refused).toEqual([]);
    expect(fs.lstatSync(path.join(mirror, 'helper', 'notes.md')).isSymbolicLink()).toBe(true);
    // The session copy dereferences it into a real file, as before the fix.
    expect(fs.readFileSync(path.join(xdg, 'helper', 'notes.md'), 'utf8')).toBe('in-repo reference');
  });

  it('keeps working when the plugin repository is itself a symlinked checkout', () => {
    // A dev checkout living outside `~/plugins` is the shape that makes
    // resolving the ROOT (not just the leaf) load-bearing.
    const checkout = path.join(tmp, 'dev-checkout');
    writeSkill(path.join(checkout, 'skills', 'dev-skill'), 'dev-skill');
    fs.writeFileSync(path.join(checkout, 'skills', 'dev-skill', 'notes.md'), 'dev notes');
    fs.symlinkSync(checkout, path.join(plugins, 'dev'));

    const { xdg, refused } = runPipeline();

    expect(refused).toEqual([]);
    expect(fs.readFileSync(path.join(xdg, 'dev-skill', 'notes.md'), 'utf8')).toBe('dev notes');
  });

  it('refuses a mirror link repointed OUT of the repository after the sync', () => {
    // The mirror writer contains what it creates, but a plugin can repoint an
    // in-repo link between that sync and the next spawn. The dereferencing copy
    // is the last reader before the container, so it re-decides containment.
    const shared = path.join(plugins, 'good', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'ref.md'), 'in-repo reference');
    const inRepoLink = path.join(plugins, 'good', 'skills', 'helper', 'notes.md');
    fs.symlinkSync(path.join(shared, 'ref.md'), inRepoLink);

    const mirror = path.join(tmp, 'mirror');
    syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));

    fs.unlinkSync(inRepoLink);
    fs.symlinkSync(secret, inRepoLink);

    const xdg = path.join(tmp, 'xdg');
    copyOpenCodeSkills(mirror, xdg, { allowedRoots: resolvePluginRoots(plugins) });

    expect(fs.existsSync(path.join(xdg, 'helper', 'notes.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('HOST-ONLY-SECRET');
  });

  it('refuses a link NESTED below the skill top level that reaches another plugin', () => {
    // The mirror writer resolves each skill's DIRECT children only: `reference`
    // is a real in-repo directory and is symlinked wholesale, so nothing under
    // it is seen at sync time. The session copy is where that link is read, and
    // it holds the dir to the one repository the marker records — so a nested
    // link into a DIFFERENT plugin (here one a workgroup scope would keep out
    // of the mirror entirely) does not reach the group.
    const scopedPlugin = path.join(plugins, 'scoped-wiki');
    fs.mkdirSync(scopedPlugin, { recursive: true });
    fs.writeFileSync(path.join(scopedPlugin, 'client.md'), 'OTHER-TENANT-CONTENT');
    const reference = path.join(plugins, 'good', 'skills', 'helper', 'reference');
    fs.mkdirSync(reference, { recursive: true });
    fs.writeFileSync(path.join(reference, 'own.md'), 'own reference');
    fs.symlinkSync(path.join(scopedPlugin, 'client.md'), path.join(reference, 'stolen.md'));

    const { xdg } = runPipeline();

    // The in-repo sibling still arrives; only the cross-plugin link does not.
    expect(fs.readFileSync(path.join(xdg, 'helper', 'reference', 'own.md'), 'utf8')).toBe('own reference');
    expect(fs.existsSync(path.join(xdg, 'helper', 'reference', 'stolen.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('OTHER-TENANT-CONTENT');
  });

  it('refuses a top-level child linked into a SIBLING plugin repository', () => {
    const other = path.join(plugins, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'private.md'), 'OTHER-TENANT-CONTENT');
    fs.symlinkSync(path.join(other, 'private.md'), path.join(plugins, 'good', 'skills', 'helper', 'notes.md'));

    const { xdg, refused } = runPipeline();

    expect(refused).toContain('helper/notes.md');
    expect(readAll(xdg)).not.toContain('OTHER-TENANT-CONTENT');
  });

  it('refuses every link in a mirror dir whose recorded source root has gone', () => {
    // A recorded root that no longer resolves means "no provenance", and the
    // answer is refusal, not a fallback to the union — the union is exactly
    // what would admit the repointed checkout here. Shape: `~/plugins/good` is
    // a symlinked dev checkout, the mirror records the checkout it was
    // published from, and the symlink is later repointed at a different tree.
    fs.rmSync(path.join(plugins, 'good'), { recursive: true, force: true });
    const checkoutA = path.join(tmp, 'checkout-a');
    writeSkill(path.join(checkoutA, 'skills', 'helper'), 'helper');
    fs.writeFileSync(path.join(checkoutA, 'skills', 'helper', 'notes.md'), 'checkout A notes');
    fs.symlinkSync(checkoutA, path.join(plugins, 'good'));

    const mirror = path.join(tmp, 'mirror');
    syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));

    const checkoutB = path.join(tmp, 'checkout-b');
    writeSkill(path.join(checkoutB, 'skills', 'helper'), 'helper');
    fs.writeFileSync(path.join(checkoutB, 'skills', 'helper', 'notes.md'), 'OTHER-TENANT-CONTENT');
    fs.unlinkSync(path.join(plugins, 'good'));
    fs.symlinkSync(checkoutB, path.join(plugins, 'good'));
    fs.rmSync(checkoutA, { recursive: true, force: true });

    const xdg = path.join(tmp, 'xdg');
    copyOpenCodeSkills(mirror, xdg, { allowedRoots: resolvePluginRoots(plugins) });

    expect(fs.existsSync(path.join(xdg, 'helper', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(xdg, 'helper', 'notes.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('OTHER-TENANT-CONTENT');
  });

  it('falls back to allowedRoots only for a dir the mirror writer did not publish', () => {
    // An operator-placed or natively-installed dir has no marker and therefore
    // no plugin of record. No plugin can create one of these, so the fallback
    // is not a hole a repository can reach; empty roots still refuse.
    const mirror = path.join(tmp, 'mirror');
    const native = path.join(mirror, 'native');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'SKILL.md'), 'native');
    fs.symlinkSync(secret, path.join(native, 'notes.md'));

    const xdg = path.join(tmp, 'xdg');
    copyOpenCodeSkills(mirror, xdg, { allowedRoots: [] });

    expect(fs.existsSync(path.join(xdg, 'native', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(xdg, 'native', 'notes.md'))).toBe(false);
  });

  it('prunes a mirror CHILD whose source became an escape since the last sync', () => {
    const shared = path.join(plugins, 'good', 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'ref.md'), 'in-repo reference');
    const link = path.join(plugins, 'good', 'skills', 'helper', 'notes.md');
    fs.symlinkSync(path.join(shared, 'ref.md'), link);

    const mirror = path.join(tmp, 'mirror');
    syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));
    expect(fs.existsSync(path.join(mirror, 'helper', 'notes.md'))).toBe(true);

    fs.unlinkSync(link);
    fs.symlinkSync(secret, link);
    const result = syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));

    expect(result.refused).toContain('helper/notes.md');
    expect(fs.existsSync(path.join(mirror, 'helper', 'notes.md'))).toBe(false);
  });

  it('attributes a LEGACY mirror dir — no provenance record — from the current tree', () => {
    // Every mirror dir on an install that predates the record has no record,
    // and nothing re-runs the sync at boot. Falling back to the union for those
    // would leave the escape open on exactly the installs this fixes.
    const other = path.join(plugins, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'private.md'), 'OTHER-TENANT-CONTENT');
    const reference = path.join(plugins, 'good', 'skills', 'helper', 'reference');
    fs.mkdirSync(reference, { recursive: true });
    fs.writeFileSync(path.join(reference, 'own.md'), 'own reference');
    fs.symlinkSync(path.join(other, 'private.md'), path.join(reference, 'stolen.md'));

    const mirror = path.join(tmp, 'mirror');
    syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));
    // Downgrade the mirror to the pre-record shape.
    fs.rmSync(path.join(mirror, 'helper', '.nanoclaw-source-root'));

    const xdg = path.join(tmp, 'xdg');
    copyOpenCodeSkills(mirror, xdg, {
      allowedRoots: resolvePluginRoots(plugins),
      sourceRootsByName: mirrorSourceRootsByName(plugins),
    });

    expect(fs.readFileSync(path.join(xdg, 'helper', 'reference', 'own.md'), 'utf8')).toBe('own reference');
    expect(fs.existsSync(path.join(xdg, 'helper', 'reference', 'stolen.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('OTHER-TENANT-CONTENT');
  });

  it('refuses the links of a MANAGED dir the current tree no longer publishes', () => {
    // No record, no name in the walk: the dir is stale, its source left the
    // tree, and there is nothing left to contain it to. Refuse, do not widen.
    const other = path.join(plugins, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'private.md'), 'OTHER-TENANT-CONTENT');
    const mirror = path.join(tmp, 'mirror');
    const stale = path.join(mirror, 'stale-skill');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, '.nanoclaw-managed'), 'managed by nanoclaw plugin-skill-discovery\n');
    fs.writeFileSync(path.join(stale, 'SKILL.md'), 'stale');
    fs.symlinkSync(path.join(other, 'private.md'), path.join(stale, 'notes.md'));

    const xdg = path.join(tmp, 'xdg');
    copyOpenCodeSkills(mirror, xdg, {
      allowedRoots: resolvePluginRoots(plugins),
      sourceRootsByName: mirrorSourceRootsByName(plugins),
    });

    expect(fs.existsSync(path.join(xdg, 'stale-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(xdg, 'stale-skill', 'notes.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('OTHER-TENANT-CONTENT');
  });

  it('does not read a provenance record that is a symlink, and never mirrors a plugin one', () => {
    // A plugin shipping a file by either owned name must not be able to plant a
    // record — directly, or by occupying the slot after a failed write of ours.
    const skillDir = path.join(plugins, 'good', 'skills', 'helper');
    fs.writeFileSync(path.join(skillDir, '.nanoclaw-source-root'), JSON.stringify('/'));
    fs.writeFileSync(path.join(skillDir, '.nanoclaw-managed'), 'forged');

    const { mirror } = runPipeline();

    const record = fs.readFileSync(path.join(mirror, 'helper', '.nanoclaw-source-root'), 'utf8');
    expect(record).toBe(`${JSON.stringify(fs.realpathSync(path.join(plugins, 'good')))}\n`);
    expect(fs.lstatSync(path.join(mirror, 'helper', '.nanoclaw-source-root')).isSymbolicLink()).toBe(false);

    // And a record that IS a symlink is not followed: treat as no record.
    fs.rmSync(path.join(mirror, 'helper', '.nanoclaw-source-root'));
    fs.writeFileSync(path.join(tmp, 'forged-root.json'), JSON.stringify('/'));
    fs.symlinkSync(path.join(tmp, 'forged-root.json'), path.join(mirror, 'helper', '.nanoclaw-source-root'));
    fs.symlinkSync(secret, path.join(mirror, 'helper', 'notes.md'));

    const xdg = path.join(tmp, 'xdg2');
    copyOpenCodeSkills(mirror, xdg, { allowedRoots: resolvePluginRoots(plugins), sourceRootsByName: new Map() });
    expect(fs.existsSync(path.join(xdg, 'helper', 'notes.md'))).toBe(false);
    expect(readAll(xdg)).not.toContain('HOST-ONLY-SECRET');
  });

  it('prunes a mirror dir whose source became an escape since the last sync', () => {
    const skillDir = path.join(plugins, 'evil', 'skills', 'leak');
    writeSkill(skillDir, 'leak');
    const mirror = path.join(tmp, 'mirror');
    syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));
    expect(fs.existsSync(path.join(mirror, 'leak', 'SKILL.md'))).toBe(true);

    // The whole skill directory becomes a link out of the repo.
    fs.rmSync(skillDir, { recursive: true, force: true });
    const outside = path.join(tmp, 'outside-skill');
    writeSkill(outside, 'leak');
    fs.symlinkSync(outside, skillDir);

    const result = syncSkillSymlinks(mirror, discoverPortableSkills(plugins, { runtime: 'opencode' }));
    expect(result.refused).toContain('leak');
    expect(fs.existsSync(path.join(mirror, 'leak'))).toBe(false);
  });
});

/** Every regular file's contents under `root`, concatenated. */
function readAll(root: string): string {
  let out = '';
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out += readAll(p);
    else if (entry.isFile()) out += fs.readFileSync(p, 'utf8');
  }
  return out;
}
