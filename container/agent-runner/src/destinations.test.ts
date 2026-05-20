import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });
});

describe('buildSystemPromptAddendum — workgroup awareness (NANOCLAW_WORKGROUP_ID)', () => {
  function withWorkgroup<T>(value: string | undefined, fn: () => T): T {
    const snapshot = process.env.NANOCLAW_WORKGROUP_ID;
    try {
      if (value === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
      else process.env.NANOCLAW_WORKGROUP_ID = value;
      return fn();
    } finally {
      if (snapshot === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
      else process.env.NANOCLAW_WORKGROUP_ID = snapshot;
    }
  }

  it('includes "Your workgroup is X" line when env is set', () => {
    withWorkgroup('madison-reed', () => {
      const prompt = buildSystemPromptAddendum('Bo');
      expect(prompt).toContain('Your workgroup is **madison-reed**');
      expect(prompt).toContain('multi-agent tenant boundary');
    });
  });

  it('omits the workgroup line when env is unset (pre-migration / standalone agents)', () => {
    withWorkgroup(undefined, () => {
      const prompt = buildSystemPromptAddendum('Bo');
      expect(prompt).not.toContain('Your workgroup is');
    });
  });

  it('omits the workgroup line when assistantName is missing (no header section to attach to)', () => {
    withWorkgroup('madison-reed', () => {
      const prompt = buildSystemPromptAddendum(undefined);
      expect(prompt).not.toContain('Your workgroup is');
    });
  });
});
