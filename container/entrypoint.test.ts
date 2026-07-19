import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ENTRYPOINT = path.resolve(import.meta.dirname, 'entrypoint.sh');

describe('container entrypoint', () => {
  it('test_entrypoint_contains_no_gitnexus_registration_or_hook_setup', () => {
    const source = fs.readFileSync(ENTRYPOINT, 'utf8');
    expect(source).not.toMatch(/gitnexus/i);
    expect(source).not.toMatch(/repo auto-registration|post-commit-verify|repo-readiness-guard/i);
  });

  it('test_entrypoint_preserves_non_gitnexus_initialization', () => {
    const source = fs.readFileSync(ENTRYPOINT, 'utf8');
    const markers = [
      'export XDG_CONFIG_HOME=/tmp/.chromium',
      'export AGENT_BROWSER_PROXY="$RESIDENTIAL_PROXY_URL"',
      '\n    gh auth setup-git',
      'render workspace set',
      'export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/tmp/.gws',
      'exec bun run /app/src/index.ts < /tmp/input.json',
    ];
    for (const marker of markers) expect(source).toContain(marker);
    const ordered = markers.map((marker) => source.indexOf(marker));
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });
});
