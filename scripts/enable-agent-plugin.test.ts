/**
 * `scripts/enable-agent-plugin.ts` prints the operator's next steps, and step 3
 * tells them to author `~/plugins/<name>/.nanoclaw-always-on.md`. That file is
 * the OVERRIDE for a plugin we do not control. A plugin we maintain already
 * carries its directive as its own generic `always-on.md`, and writing the
 * override beside it delivers the directive twice: on OpenCode the plugin's own
 * file AND the override, on Codex the override on top of the plugin's own
 * SessionStart hook.
 *
 * Driven as a subprocess against a fixture `HOME`, not by importing the module:
 * the script calls `main()` at module scope, so an import would run it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./enable-agent-plugin.ts', import.meta.url));

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-enabler-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A plugin with a SessionStart hook, optionally carrying its own ruleset. */
function seedPlugin(name: string, opts: { ownRulesetAt?: string } = {}): void {
  const dir = path.join(home, 'plugins', name);
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
  );
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  if (opts.ownRulesetAt) {
    const file = path.join(dir, opts.ownRulesetAt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Always do the thing.\n');
  }
}

function runEnabler(name: string): string {
  return execFileSync('npx', ['tsx', SCRIPT, name, '--dry-run'], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const AUTHOR_OVERRIDE = /Author .*\.nanoclaw-always-on\.md/;

describe('enable-agent-plugin next steps', () => {
  it('tells the operator to author the override for a plugin that has no ruleset of its own', () => {
    seedPlugin('third-party');
    expect(runEnabler('third-party')).toMatch(AUTHOR_OVERRIDE);
  });

  it.each([
    ['under plugins/<sub>', path.join('plugins', 'wwbd', 'always-on.md')],
    ['at <sub>/ in the root layout', path.join('wwbd', 'always-on.md')],
  ])('never asks for the override when the plugin ships its own always-on.md %s', (_label, rel) => {
    // EXACTLY the two layouts the composer walks — the enabler has to recognise
    // the composer's set (`subPluginDirs`, src/claude-md-compose.ts), or it
    // instructs a double delivery for the repos we maintain.
    seedPlugin('ours', { ownRulesetAt: rel });
    const out = runEnabler('ours');
    expect(out).not.toMatch(AUTHOR_OVERRIDE);
    expect(out).toContain('ships its own always-on.md');
  });

  it('never asks for the override when the only always-on.md is at the repo root', () => {
    // A single-plugin repo has no sub-plugin to carry its directive, so the
    // composer reads the repo ROOT's own always-on.md for OpenCode and this
    // must agree — a repo we maintain has to reach OpenCode without a
    // NanoClaw-specific file. The two sides are one decision: if this counted
    // the root while the composer did not, the override would be suppressed for
    // a repo whose ruleset nothing composed and the group would get neither.
    seedPlugin('root-only', { ownRulesetAt: 'always-on.md' });
    const out = runEnabler('root-only');
    expect(out).not.toMatch(AUTHOR_OVERRIDE);
    expect(out).toContain('ships its own always-on.md');
  });
});

describe('enable-agent-plugin Claude manifest for a marketplace repo', () => {
  /** A repo shipping only `.claude-plugin/marketplace.json`, its plugins sourced from `sources`. */
  function seedMarketplace(name: string, sources: string[]): string {
    const dir = path.join(home, 'plugins', name);
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
    fs.writeFileSync(
      path.join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name, plugins: sources.map((source, i) => ({ name: `p${i}`, source, skills: [] })) }),
    );
    return dir;
  }

  function report(name: string): { generatedManifest: boolean } {
    return JSON.parse(
      execFileSync('npx', ['tsx', SCRIPT, name, '--dry-run', '--report-json'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as { generatedManifest: boolean };
  }

  it.each([
    // The container walk registers a directory only by plugin.json, so a marketplace whose plugins are all the
    // repo root loads nothing on a Claude group unless the root gets one.
    ['every plugin sourced from the repo root', ['./', '.'], true],
    // Sub-plugins carry their own manifests; a root one would register the whole repo a second time.
    ['plugins in sub-directories', ['./data', './'], false],
  ])('generates a root manifest only when %s', (_label, sources, expected) => {
    const dir = seedMarketplace('market', sources);
    expect(report('market').generatedManifest).toBe(expected);
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))).toBe(false);
  });
});
