import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildManagedAppManifest } from './slack-manifest.js';

describe('manual Slack manifest', () => {
  it('retains the upstream manifest builder byte-for-byte', () => {
    const source = fs.readFileSync(new URL('./slack-manifest.ts', import.meta.url), 'utf8');
    expect(
      createHash('sha256')
        .update(source.slice(source.indexOf('export const BOT_SCOPES')))
        .digest('hex'),
    ).toBe('51e4ff7ca8bbe6d2db766ee003f35270f31b528a34617b42595e4b967c3c6483');
    expect(buildManagedAppManifest({ name: 'Fixture Bot', agentView: false })).toMatchObject({
      display_information: { name: 'Fixture Bot' },
      settings: { socket_mode_enabled: true },
    });
  });

  it('does not reintroduce manager credentials or automatic app provisioning', () => {
    const directories = [new URL('.', import.meta.url), new URL('../modules/slack-agent-flow/', import.meta.url)];
    for (const directory of directories) {
      for (const entry of fs.readdirSync(directory)) {
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        const source = fs.readFileSync(new URL(entry, directory), 'utf8');
        expect(source, fileURLToPath(new URL(entry, directory))).not.toMatch(
          /SLACK_MANAGER_TOKEN|apps\.manifest\.create|apps\.managedInstall|SLACK_SERVICE_BASE/,
        );
      }
    }
  });
});
