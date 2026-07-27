import { describe, expect, it } from 'vitest';

import { namespacedPlatformId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('leaves a default channel id that already carries its own prefix untouched', () => {
    expect(namespacedPlatformId('discord', 'discord:G:C')).toBe('discord:G:C');
    expect(namespacedPlatformId('telegram', 'telegram:123')).toBe('telegram:123');
  });

  it('does NOT double-prefix a suffixed multi-bot channel type (regression)', () => {
    // The Chat SDK discord adapter emits the same base-prefixed id for every
    // bot, regardless of which suffixed channel type it's registered under.
    // Re-prefixing here produced "discord-opencode:discord:G:C", which the
    // adapter later rejected as an invalid thread id at delivery time.
    expect(namespacedPlatformId('discord-opencode', 'discord:G:C')).toBe('discord:G:C');
    expect(namespacedPlatformId('discord-codex', 'discord:G:C')).toBe('discord:G:C');
    expect(namespacedPlatformId('slack-foo', 'slack:T123:C456')).toBe('slack:T123:C456');
  });

  it('is idempotent when the id already carries the full suffixed channel prefix', () => {
    expect(namespacedPlatformId('discord-opencode', 'discord-opencode:discord:G:C')).toBe(
      'discord-opencode:discord:G:C',
    );
  });

  it('still prefixes a genuinely bare id for a suffixed channel type', () => {
    expect(namespacedPlatformId('discord-opencode', '12345')).toBe('discord-opencode:12345');
  });

  it('prefixes a bare numeric id for a non-suffixed channel type', () => {
    expect(namespacedPlatformId('telegram', '12345')).toBe('telegram:12345');
  });

  it('leaves native-adapter id formats untouched (@, +, group:, deltachat)', () => {
    expect(namespacedPlatformId('whatsapp-cloud', 'person3@fixture15.example.com')).toBe(
      'person3@fixture15.example.com',
    );
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc')).toBe('group:abc');
    expect(namespacedPlatformId('deltachat', '12')).toBe('12');
  });
});
