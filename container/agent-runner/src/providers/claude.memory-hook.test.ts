import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { ClaudeProvider } from './claude.js';

let configDir: string;
let previousConfigDir: string | undefined;
/**
 * The real registration points at /app, which exists only in the container image.
 * `writeMemorySessionHook` refuses to register a hook whose module is missing, so
 * a suite running on a host has to supply one that is actually there — otherwise
 * it is asserting against the refusal path, not the write path.
 */
let presentHook: typeof MEMORY_SESSION_HOOK;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-hook-'));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const modulePath = path.join(configDir, 'hook.ts');
  fs.writeFileSync(modulePath, '// stand-in for the container module\n');
  presentHook = { ...MEMORY_SESSION_HOOK, modulePath };
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('Claude memory SessionStart registration', () => {
  it('writes the shared command once without disturbing other hooks', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        customValue: 'preserved',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
          SessionStart: [
            { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
            {
              matcher: '.*',
              hooks: [
                { type: 'command', command: 'bun /app/src/memory-hook.ts' },
                { type: 'command', command: 'custom-start' },
              ],
            },
          ],
        },
      }),
    );

    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook(presentHook);
    provider.registerMemorySessionHook(presentHook);

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.customValue).toBe('preserved');
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'custom-stop' }] }]);
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'custom-start' }] },
      {
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
      },
    ]);
  });
});

describe('host-config leak guard', () => {
  // Twice now, running this code outside a container has registered a
  // SessionStart hook into a developer's own ~/.claude/settings.json, pointing at
  // /app/src/memory/hook.ts — a path that exists only in the container image — so
  // every host session started with a module-not-found error. `claudeConfigDir()`
  // falls back to $HOME/.claude when CLAUDE_CONFIG_DIR is unset, and containers
  // legitimately depend on that fallback, so the fallback itself cannot go. The
  // module's presence is what separates the two cases.
  it('refuses to register when the hook module does not exist', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    const provider = new ClaudeProvider();

    provider.registerMemorySessionHook({ ...MEMORY_SESSION_HOOK, modulePath: path.join(configDir, 'absent.ts') });

    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it('leaves an existing settings file untouched when the module is missing', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    const before = JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } });
    fs.writeFileSync(settingsFile, before);

    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook({ ...MEMORY_SESSION_HOOK, modulePath: '/definitely/not/here.ts' });

    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(before);
  });

  it('still registers when the module is present', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    const provider = new ClaudeProvider();

    provider.registerMemorySessionHook(presentHook);

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(MEMORY_SESSION_HOOK.command);
  });
});
