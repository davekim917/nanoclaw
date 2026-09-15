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

  it('still asks for the override when the only always-on.md is at the repo root', () => {
    // `subPluginDirs` returns `<repo>/plugins/<sub>` and `<repo>/<sub>`, never
    // the repo itself, so `<repo>/always-on.md` is read by NOBODY. Counting it
    // as "the plugin has its own" would suppress the override for a repo whose
    // ruleset nothing composes, and an OpenCode group would get neither. The
    // enabler's eligibility must be the composer's set, not a superset that
    // looks like it — the first version of this test asserted the superset,
    // which is an oracle written from the same wrong belief as the code.
    seedPlugin('root-only', { ownRulesetAt: 'always-on.md' });
    expect(runEnabler('root-only')).toMatch(AUTHOR_OVERRIDE);
  });
});
