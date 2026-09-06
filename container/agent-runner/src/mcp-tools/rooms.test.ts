/**
 * create_room / add_to_room write ONE outbound system row and nothing else.
 *
 * That is the whole container-side contract: the host resolves names, calls
 * Slack, wires participants and decides authorization, so what is testable
 * here is the payload shape the host parses and the argument validation that
 * saves the agent a round trip.
 *
 * As in agents.test.ts and self-mod.test.ts: do NOT mock.module
 * '../db/messages-out.js'. bun runs every test file sequentially in ONE
 * process and mock.module is process-global and permanent, so stubbing
 * writeMessageOut would send every later file's outbound writes nowhere.
 * Assert against the real in-memory session DB instead.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';

const registeredToolNames: string[][] = [];
mock.module('./server.js', () => ({
  registerTools: (tools: Array<{ tool: { name: string } }>) =>
    registeredToolNames.push(tools.map((tool) => tool.tool.name)),
}));

const { createRoom, addToRoom } = await import('./rooms.js');

/** The most recent system action written to the outbound DB. */
function lastSystemAction(): Record<string, unknown> | undefined {
  const row = getOutboundDb()
    .prepare(`SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1`)
    .get() as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as Record<string, unknown>) : undefined;
}

function systemActionCount(): number {
  return (
    (
      getOutboundDb().prepare(`SELECT COUNT(*) AS c FROM messages_out WHERE kind = 'system'`).get() as {
        c: number;
      }
    ).c ?? 0
  );
}

beforeEach(() => {
  registeredToolNames.length = 0;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('create_room', () => {
  it('writes one create_room system row carrying the trimmed name and agent list', async () => {
    const result = await createRoom.handler({ name: '  Ops Room  ', agents: [' mate ', 'scout'] });

    expect(result.isError).toBeUndefined();
    const payload = lastSystemAction()!;
    expect(payload.action).toBe('create_room');
    expect(payload.name).toBe('Ops Room');
    expect(payload.agents).toEqual(['mate', 'scout']);
    expect(typeof payload.requestId).toBe('string');
    // purpose is omitted rather than sent as an empty string — the host's
    // card text reads `purpose` as present-or-absent.
    expect('purpose' in payload).toBe(false);
    expect(systemActionCount()).toBe(1);
  });

  it('carries a purpose when one is given', async () => {
    await createRoom.handler({ name: 'Ops', agents: ['mate'], purpose: '  ship the release  ' });

    expect(lastSystemAction()!.purpose).toBe('ship the release');
  });

  it('rejects a missing name and an empty agent list without writing a row', async () => {
    expect((await createRoom.handler({ agents: ['mate'] })).isError).toBe(true);
    expect((await createRoom.handler({ name: '   ', agents: ['mate'] })).isError).toBe(true);
    expect((await createRoom.handler({ name: 'Ops', agents: [] })).isError).toBe(true);
    expect((await createRoom.handler({ name: 'Ops', agents: ['  ', ''] })).isError).toBe(true);

    expect(systemActionCount()).toBe(0);
  });
});

describe('add_to_room', () => {
  it('writes one add_to_room system row carrying the trimmed room and agent', async () => {
    const result = await addToRoom.handler({ room: ' ops ', agent: ' mate ' });

    expect(result.isError).toBeUndefined();
    const payload = lastSystemAction()!;
    expect(payload.action).toBe('add_to_room');
    expect(payload.room).toBe('ops');
    expect(payload.agent).toBe('mate');
    expect(typeof payload.requestId).toBe('string');
    expect(systemActionCount()).toBe(1);
  });

  it('never forwards host-side resolution keys the container could forge', async () => {
    // The host's precheck overwrites every authorization stamp from live rows,
    // but the tool must not offer them as parameters in the first place.
    await addToRoom.handler({
      room: 'ops',
      agent: 'mate',
      caller_workgroup_id: 'x',
      target_workgroup_id: 'x',
      room_platform_id: 'slack:CELSEWHERE',
    });

    expect(Object.keys(lastSystemAction()!).sort()).toEqual(['action', 'agent', 'requestId', 'room']);
    expect(Object.keys(addToRoom.tool.inputSchema.properties).sort()).toEqual(['agent', 'room']);
  });

  it('rejects a missing room or agent without writing a row', async () => {
    expect((await addToRoom.handler({ agent: 'mate' })).isError).toBe(true);
    expect((await addToRoom.handler({ room: 'ops' })).isError).toBe(true);
    expect((await addToRoom.handler({ room: '  ', agent: 'mate' })).isError).toBe(true);

    expect(systemActionCount()).toBe(0);
  });
});

describe('registration', () => {
  it('registers both tools under the names the host dispatches on', () => {
    // Registration happened at import time, before this file's first
    // beforeEach cleared the recorder, so assert on the definitions the
    // barrel handed to registerTools rather than on the recorder's contents.
    expect(createRoom.tool.name).toBe('create_room');
    expect(addToRoom.tool.name).toBe('add_to_room');
  });

  it('keeps the room guidance in the tool descriptions, not an always-on fragment', () => {
    // Every *.instructions.md beside an MCP tool module is loaded into EVERY
    // group's composed CLAUDE.md; this fork retired that tier
    // (instruction-fragment-migration.test.ts). The guidance lives here.
    expect(createRoom.tool.description).toMatch(/ONCE naming all of them/);
    expect(createRoom.tool.description).toMatch(/same workspace/);
    expect(createRoom.tool.description.toLowerCase()).toContain('fire-and-forget');
    expect(addToRoom.tool.description).toMatch(/does not move/);
    // The agent proposes the add, so it has to know what it is proposing:
    // Slack hands a new channel member everything already in the room.
    expect(addToRoom.tool.description).toMatch(/prior history/i);
    expect(createRoom.tool.description).toMatch(/never reuses an existing channel/i);
    expect(addToRoom.tool.description).toMatch(/another workgroup/);
    expect(addToRoom.tool.description).toMatch(/admin approval/);
  });

  it('the mounted room skill states the same disclosure the tools and the card do', () => {
    // The skill is what an agent actually reads before proposing an add, so
    // wording that understated the disclosure there would undo the fix in the
    // tool description. Same shape as the onecli-gateway assertions in
    // instruction-fragment-migration.test.ts.
    const skill = fs.readFileSync(
      path.join(process.cwd(), '..', '..', 'container', 'skills', 'slack-a2a-rooms', 'SKILL.md'),
      'utf-8',
    );
    // \s+ not a literal space: the file is hard-wrapped, so any of these
    // phrases can straddle a line break.
    expect(skill).toMatch(/whole conversation to\s+date/i);
    expect(skill).toMatch(/never reuses an existing\s+channel/i);
  });
});
