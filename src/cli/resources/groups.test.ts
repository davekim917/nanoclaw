/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-cli-groups') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { recordDeliveryAttempt } from '../../db/coordination.js';
import { dispatch } from '../dispatch.js';
import { readContainerConfig } from '../../container-config.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { isSiblingBoundField } from '../../sibling-parity.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getRawDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    await createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    await createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getRawDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // The agent's ncl execution ledger is retained on a terminal signal rather
    // than a clock, so a claim the group delete leaves behind never expires.
    db.prepare(
      `INSERT INTO cli_request_executions (session_id, request_id, command, status, response, claimed_at, completed_at)
       VALUES (?, 'cli-1-abcdef', 'tasks-create', 'done', '{"id":"cli-1-abcdef","ok":true,"data":1}', ?, ?)`,
    ).run(SID, now(), now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
      cli_request_executions: 1,
    });

    // The group and every dependent row must be gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM cli_request_executions WHERE session_id = ?', SID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    await createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getRawDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it('two overlapping deletes for the same group: one succeeds, the other refuses instead of a hollow cascade', async () => {
    // github Codex review, PR #437, groups.ts:218: the awaited existence
    // check before the transaction is a fast-path UX check, not the
    // authoritative one — two overlapping approved `groups delete` calls for
    // the same id can both pass it. Without a re-check INSIDE the
    // transaction, the second caller's cascade runs against an
    // already-deleted row: every DELETE matches 0 rows, and it would report
    // `{ ok: true, data: { removed: {...all zeros} } }` as if it succeeded.
    const GID = 'ag-race';
    await createAgentGroup({ id: GID, name: 'race', folder: 'race', agent_provider: null, created_at: now() });

    const [first, second] = await Promise.all([
      dispatch({ id: 'req-del-race-1', command: 'groups-delete', args: { id: GID } }, { caller: 'host' }),
      dispatch({ id: 'req-del-race-2', command: 'groups-delete', args: { id: GID } }, { caller: 'host' }),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((o) => o.ok);
    const failed = outcomes.filter((o) => !o.ok) as { ok: false; error: { code: string; message: string } }[];

    // Exactly one lands; the other gets the same documented not-found error
    // a delete against an unknown id gets — never a silent no-op success.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error.message).toMatch(/not found/i);

    // The one that landed actually removed the row.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });

  it('refuses to delete a paired sibling — leaves twin intact and surfaces the error', async () => {
    const SEED = 'ag-seed';
    const TWIN = 'ag-seed-codex';
    const WG = 'example-retail';
    const db = getRawDb();
    await createAgentGroup({ id: SEED, name: 'seed', folder: 'seed', agent_provider: null, created_at: now() });
    await createAgentGroup({
      id: TWIN,
      name: 'seed-codex',
      folder: 'seed-codex',
      agent_provider: null,
      created_at: now(),
    });
    // Workgroups row must exist before workgroup_id FK can be set.
    db.prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run(WG, now());
    // Bind both to the same workgroup (the migration-036 invariant)
    db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id IN (?, ?)').run(WG, SEED, TWIN);

    const resp = await dispatch(
      { id: 'req-del-seed', command: 'groups-delete', args: { id: SEED } },
      { caller: 'host' },
    );

    // Pre-flight refused before the transaction ran.
    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(
      /paired in workgroup/,
    );
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toContain(TWIN);

    // Both agents AND the workgroup row survive.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', SEED)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', TWIN)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM workgroups WHERE id = ?', WG)).toBe(1);
  });

  it('cleans up the orphan workgroups row when deleting an unpaired agent', async () => {
    const SOLO = 'ag-solo';
    const WG = 'solo';
    const db = getRawDb();
    await createAgentGroup({ id: SOLO, name: 'solo', folder: 'solo', agent_provider: null, created_at: now() });
    // Seed the workgroups row as migration-036 would for a solo agent.
    db.prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run(WG, now());
    db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(WG, SOLO);

    const resp = await dispatch(
      { id: 'req-del-solo', command: 'groups-delete', args: { id: SOLO } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.workgroups).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', SOLO)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM workgroups WHERE id = ?', WG)).toBe(0);
  });

  it("deleting a group removes its sessions' delivery_attempts rows", async () => {
    // Delivery retry counts (migration 071) are keyed to the session and have
    // no cascading foreign key. Only a delivery loop clears one, and a deleted
    // session has none — so the cascade is the last thing that can.
    const GID = 'ag-attempts';
    const SID = 'sess-attempts-1';

    await createAgentGroup({ id: GID, name: 'attempts', folder: 'attempts', agent_provider: null, created_at: now() });
    await createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    await recordDeliveryAttempt({
      messageId: 'out-doomed',
      sessionId: SID,
      now: now(),
      nextAttemptAt: null,
      error: 'boom',
    });

    const resp = await dispatch(
      { id: 'req-del-attempts', command: 'groups-delete', args: { id: GID } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.delivery_attempts).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM delivery_attempts WHERE session_id = ?', SID)).toBe(0);
  });
});

describe('groups CLI resource config', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('test_groups_config_update_persists_file_canonical_resources', async () => {
    const id = 'ag-resource-test';
    const folder = 'resource-test';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    getRawDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(id, now());
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, null, 2) +
        '\n',
    );

    const response = await dispatch(
      {
        id: 'req-resource-update',
        command: 'groups-config-update',
        args: {
          id,
          memory_request_mb: 5120,
          memory_limit_mb: 5120,
          memory_swap_limit_mb: 5120,
          cpus: 2,
          pids_limit: 768,
        },
      },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    expect(readContainerConfig(folder).resources).toEqual({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });
    expect((response as { ok: true; data: Record<string, unknown> }).data.effective_resources).toEqual({
      memory: { requestMb: 5120, limitMb: 5120, memorySwapLimitMb: 5120 },
      cpus: 2,
      pidsLimit: 768,
    });
  });

  it('test_groups_config_get_reports_declared_and_effective_security', async () => {
    // A privilege-weakening override in container.json must be visible to the
    // normal config audit. Reporting only the docker args at spawn time hides
    // a narrowed capDrop or a disabled no-new-privileges from every operator.
    const id = 'ag-security-audit';
    const folder = 'security-audit';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    getRawDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(id, now());
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify(
        {
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: 'all',
          security: { capDrop: [], capAdd: ['SYS_ADMIN'], noNewPrivileges: false },
        },
        null,
        2,
      ) + '\n',
    );

    const response = await dispatch(
      { id: 'req-security-get', command: 'groups-config-get', args: { id } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    const data = (response as { ok: true; data: Record<string, unknown> }).data;
    expect(data.security).toEqual({ capDrop: [], capAdd: ['SYS_ADMIN'], noNewPrivileges: false });
    expect(data.effective_security).toEqual({ capDrop: [], capAdd: ['SYS_ADMIN'], noNewPrivileges: false });
  });

  it('test_groups_config_get_reports_safe_effective_security_when_undeclared', async () => {
    const id = 'ag-security-default';
    const folder = 'security-default';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    getRawDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(id, now());
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, null, 2) +
        '\n',
    );

    const response = await dispatch(
      { id: 'req-security-get-default', command: 'groups-config-get', args: { id } },
      { caller: 'host' },
    );

    expect(response.ok).toBe(true);
    const data = (response as { ok: true; data: Record<string, unknown> }).data;
    expect(data.security).toBeNull();
    expect(data.effective_security).toEqual({ capDrop: ['ALL'], capAdd: [], noNewPrivileges: true });
  });

  it('test_groups_config_update_mirrors_runtime_scalars_into_container_json', async () => {
    // The spawn path and the in-container runner read provider/model/effort
    // from container.json; the DB row only feeds flag vocabulary and
    // task-flag validation. Writing the DB alone left a group booting its
    // OLD provider while `config get` reported the new one.
    const id = 'ag-provider-mirror';
    const folder = 'provider-mirror';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    getRawDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, 'codex', 'gpt-5.6-sol', 'high', NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(id, now());
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({
        provider: 'codex',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        onecliSecrets: ['Keep-Me'],
      }) + '\n',
    );

    const response = await dispatch(
      {
        id: 'req-provider-mirror',
        command: 'groups-config-update',
        args: { id, provider: 'claude', model: 'claude-fable-5[1m]', effort: 'high' },
      },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);

    const file = readContainerConfig(folder);
    expect(file.provider).toBe('claude');
    expect(file.model).toBe('claude-fable-5[1m]');
    expect(file.effort).toBe('high');
    // Unrelated operator-owned fields survive the mirror.
    expect(file.onecliSecrets).toEqual(['Keep-Me']);
    // DB projection still updated too.
    expect((await getContainerConfig(id))?.provider).toBe('claude');
  });

  it('test_groups_config_update_without_runtime_scalars_leaves_provider_alone', async () => {
    const id = 'ag-no-mirror';
    const folder = 'no-mirror';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    getRawDb()
      .prepare(
        `INSERT INTO container_configs
           (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
            skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
         VALUES (?, 'codex', NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
      )
      .run(id, now());
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ provider: 'codex', mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const response = await dispatch(
      { id: 'req-no-mirror', command: 'groups-config-update', args: { id, assistant_name: 'Renamed' } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    expect(readContainerConfig(folder).provider).toBe('codex');
    // assistant_name IS mirrored — the spawn path reads it from the file, so
    // a DB-only write would silently keep the old name (same trap as provider).
    expect(readContainerConfig(folder).assistantName).toBe('Renamed');
  });

  it('test_groups_config_add_mcp_server_accepts_a_remote_http_url', async () => {
    const id = 'ag-remote-mcp';
    const folder = 'remote-mcp';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const response = await dispatch(
      {
        id: 'req-remote-mcp',
        command: 'groups-config-add-mcp-server',
        args: {
          id,
          name: 'datafold',
          url: 'https://app.datafold.com/mcp/',
          headers: JSON.stringify({ Authorization: 'Key onecli-managed' }),
        },
      },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);

    // Dual-write: container.json is what the spawn reads, the DB row is the
    // projection `groups config get` reports.
    expect(readContainerConfig(folder).mcpServers.datafold).toEqual({
      type: 'http',
      url: 'https://app.datafold.com/mcp/',
      headers: { Authorization: 'Key onecli-managed' },
    });
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).datafold).toMatchObject({ type: 'http' });
  });

  it('test_groups_config_add_mcp_server_rejects_an_unsafe_remote_url', async () => {
    const id = 'ag-remote-mcp-bad';
    const folder = 'remote-mcp-bad';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);

    const insecure = await dispatch(
      {
        id: 'req-remote-mcp-http',
        command: 'groups-config-add-mcp-server',
        args: { id, name: 'insecure', url: 'http://example.com/mcp' },
      },
      { caller: 'host' },
    );
    expect(insecure.ok).toBe(false);
    expect(JSON.stringify(insecure)).toMatch(/must use HTTPS/);

    const leaky = await dispatch(
      {
        id: 'req-remote-mcp-header',
        command: 'groups-config-add-mcp-server',
        args: {
          id,
          name: 'leaky',
          url: 'https://example.com/mcp',
          headers: JSON.stringify({ Authorization: 'Bearer real-token' }),
        },
      },
      { caller: 'host' },
    );
    expect(leaky.ok).toBe(false);
    expect(JSON.stringify(leaky)).toMatch(/onecli-managed/);

    // Nothing was written on either rejection.
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers)).toEqual({});
  });

  it('test_groups_create_timezone_lands_in_the_db_row_not_only_container_json', async () => {
    // initGroupFilesystem deliberately skips the container_configs insert, so
    // without an explicit stamp the scalar write here updates zero rows — the
    // container would get the requested zone while host-side scheduling kept
    // following the install one until the next startup backfill.
    const response = await dispatch(
      {
        id: 'req-create-tz',
        command: 'groups-create',
        args: { folder: 'created-with-tz', name: 'Created With TZ', timezone: 'Europe/Lisbon' },
      },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const created = response.data as { id: string; folder: string };
    expect((await getContainerConfig(created.id))?.timezone).toBe('Europe/Lisbon');
    expect(readContainerConfig(created.folder).timezone).toBe('Europe/Lisbon');
  });

  it('test_groups_config_update_timezone_dual_writes_and_clears', async () => {
    // Same trap as provider: scheduling reads the DB row, the container's TZ
    // env comes from container.json. A one-sided write splits the two.
    const id = 'ag-timezone';
    const folder = 'timezone-group';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const set = await dispatch(
      { id: 'req-tz-set', command: 'groups-config-update', args: { id, timezone: 'Europe/Lisbon' } },
      { caller: 'host' },
    );
    expect(set.ok).toBe(true);
    expect((await getContainerConfig(id))?.timezone).toBe('Europe/Lisbon');
    expect(readContainerConfig(folder).timezone).toBe('Europe/Lisbon');

    // `--timezone ""` clears both sides back to the install default.
    const clear = await dispatch(
      { id: 'req-tz-clear', command: 'groups-config-update', args: { id, timezone: '' } },
      { caller: 'host' },
    );
    expect(clear.ok).toBe(true);
    expect((await getContainerConfig(id))?.timezone).toBeNull();
    expect(readContainerConfig(folder).timezone).toBeUndefined();
  });

  it('test_groups_config_update_rejects_a_fixed_offset_and_canonicalizes_an_alias', async () => {
    const id = 'ag-timezone-canon';
    const folder = 'timezone-canon';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    // Intl accepts all of these; POSIX TZ reads them differently — "+01:00"
    // with the opposite sign, "CST" as a zero-offset abbreviation, and
    // "europe/lisbon" is not a zoneinfo path at all, since the lookup is a
    // case-sensitive file path. None of these depends on which tzdata the
    // machine carries, unlike a retired alias such as Asia/Calcutta, which is
    // pruned on some hosts and shipped on others.
    for (const bad of ['+01:00', '-05:00', 'CST', 'EST', 'europe/lisbon']) {
      const rejected = await dispatch(
        { id: `req-tz-${bad}`, command: 'groups-config-update', args: { id, timezone: bad } },
        { caller: 'host' },
      );
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).toMatch(/invalid --timezone/);
    }
    expect((await getContainerConfig(id))?.timezone).toBeNull();

    // A spelling the zone database has is stored VERBATIM — no ICU rewriting.
    // That is the whole point: ICU maps Asia/Kolkata onto Asia/Calcutta, whose
    // file some hosts prune, so storing the resolved name would have handed
    // the container a zone it cannot open. Which aliases exist varies by
    // machine, so drive the case off the database rather than assuming.
    const zoneExists = (tz: string): boolean => fs.existsSync(path.join('/usr/share/zoneinfo', tz));
    const shipped = ['Europe/Lisbon', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/Kyiv'].filter(zoneExists);
    expect(shipped.length).toBeGreaterThan(0);
    for (const typed of shipped) {
      const ok = await dispatch(
        { id: `req-tz-canon-${typed}`, command: 'groups-config-update', args: { id, timezone: typed } },
        { caller: 'host' },
      );
      expect(ok.ok).toBe(true);
      expect((await getContainerConfig(id))?.timezone).toBe(typed);
      expect(readContainerConfig(folder).timezone).toBe(typed);
    }
  });

  it('test_groups_config_update_rejects_a_non_iana_timezone', async () => {
    const id = 'ag-timezone-bad';
    const folder = 'timezone-bad';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);

    const response = await dispatch(
      { id: 'req-tz-bad', command: 'groups-config-update', args: { id, timezone: 'Not/AZone' } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).toMatch(/invalid --timezone/);
    expect((await getContainerConfig(id))?.timezone).toBeNull();
  });

  it('test_legacy_gitnexus_key_is_behaviorally_inert', () => {
    const folder = 'legacy-gitnexus';
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    const base = { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' };

    fs.writeFileSync(`${groupDir}/container.json`, JSON.stringify({ ...base, gitnexusInjectAgentsMd: true }));
    expect(readContainerConfig(folder).gitnexusInjectAgentsMd).toBe(true);
    fs.writeFileSync(`${groupDir}/container.json`, JSON.stringify({ ...base, gitnexusInjectAgentsMd: false }));
    expect(readContainerConfig(folder).gitnexusInjectAgentsMd).toBe(false);
    expect(isSiblingBoundField('gitnexusInjectAgentsMd')).toBe(false);
  });

  it('test_current_config_generators_do_not_emit_gitnexus_fields', () => {
    const generatorSources = [
      fs.readFileSync(new URL('../../../scripts/init-first-agent.ts', import.meta.url), 'utf8'),
      fs.readFileSync(new URL('../../../setup/migrate-v2/groups.ts', import.meta.url), 'utf8'),
    ];
    for (const source of generatorSources) {
      expect(source).not.toMatch(/gitnexusInjectAgentsMd|GITNEXUS_INJECT_AGENTS_MD/);
    }
  });
});

describe('groups config add-mount / remove-mount (host-only)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });
  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds a mount idempotently and removes it (host caller)', async () => {
    const GID = 'ag-mount';
    await createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    await ensureContainerConfig(GID);
    const groupDir = `${TEST_DIR}/groups/m`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, null, 2) +
        '\n',
    );
    const args = { id: GID, host: '/data/.gmail-mcp', container: '/home/node/.gmail-mcp', ro: true };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    const expectedMounts = [{ hostPath: '/data/.gmail-mcp', containerPath: '/home/node/.gmail-mcp', readonly: true }];
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toEqual(expectedMounts);
    expect(readContainerConfig('m').additionalMounts).toEqual(expectedMounts);

    // idempotent: a second add does not duplicate
    await dispatch({ id: 'r2', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toHaveLength(1);
    expect(readContainerConfig('m').additionalMounts).toHaveLength(1);

    const rm = await dispatch(
      {
        id: 'r3',
        command: 'groups-config-remove-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container: '/home/node/.gmail-mcp' },
      },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse((await getContainerConfig(GID))!.additional_mounts)).toEqual([]);
    expect(readContainerConfig('m').additionalMounts).toEqual([]);
  });
});

// Cases 9, 10, 14 live in the sibling file groups-create-folder-reuse.test.ts
// (adopted from upstream, unique-tmp-root fixed — see that file's header).

// Cases 11, 12 — re-derived against `mcpServerPluginOwner` directly (upstream's
// `groups-plugin-guard.test.ts` is not adopted: it imports `templates/manifest.ts`
// and `templates/extension.ts`, both absent, and most of its cases are restamp
// cases this theme defers). Same refusal messages as upstream's guard-site
// commit (6b08907a7).
describe('plugin-owned MCP server guard on config add/remove-mcp-server (cases 11, 12)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });
  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  async function seedGroupWithPluginServer(folder: string, id: string) {
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({
        mcpServers: {
          docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
        },
        packages: { apt: [], npm: [] },
        skills: 'all',
      }) + '\n',
    );
    await updateContainerConfigJson(id, 'mcp_servers', {
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });
  }

  it('refuses to overwrite a plugin-owned server (case 11)', async () => {
    const id = 'ag-plugin-guard-add';
    await seedGroupWithPluginServer('plugin-guard-add', id);

    const res = await dispatch(
      {
        id: 'req-1',
        command: 'groups-config-add-mcp-server',
        args: { id, name: 'docs', url: 'https://evil.example.com/mcp' },
      },
      { caller: 'host' },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Pinned wording, not upstream's: this fork has no in-place restamp
      // verb (github Codex review, PR #486) — the remediation must point at
      // something that exists today, and never mention `restamp`.
      expect(res.error.message).toMatch(/managed by plugin "sdr"/);
      expect(res.error.message).not.toMatch(/restamp/i);
    }
    expect(readContainerConfig('plugin-guard-add').mcpServers.docs).toMatchObject({
      url: 'https://mcp.example.com/mcp',
    });
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).docs).toMatchObject({
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('refuses to remove a plugin-owned server (case 12)', async () => {
    const id = 'ag-plugin-guard-remove';
    await seedGroupWithPluginServer('plugin-guard-remove', id);

    const res = await dispatch(
      { id: 'req-2', command: 'groups-config-remove-mcp-server', args: { id, name: 'docs' } },
      { caller: 'host' },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toMatch(/managed by plugin "sdr"/);
      expect(res.error.message).not.toMatch(/restamp/i);
    }
    expect(readContainerConfig('plugin-guard-remove').mcpServers.docs).toBeDefined();
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).docs).toBeDefined();
  });

  it('leaves an unmarked server fully editable (add and remove both succeed)', async () => {
    const id = 'ag-plugin-guard-unmarked';
    const folder = 'plugin-guard-unmarked';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const added = await dispatch(
      {
        id: 'req-3',
        command: 'groups-config-add-mcp-server',
        args: { id, name: 'mine', url: 'https://mine.example.com/mcp' },
      },
      { caller: 'host' },
    );
    expect(added.ok).toBe(true);

    const removed = await dispatch(
      { id: 'req-4', command: 'groups-config-remove-mcp-server', args: { id, name: 'mine' } },
      { caller: 'host' },
    );
    expect(removed.ok).toBe(true);
    expect(readContainerConfig(folder).mcpServers.mine).toBeUndefined();
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).mine).toBeUndefined();
  });
});

// Case 13 — the structural dual-write test the plan flags as the place the
// container.json + container_configs invariant (§3.1 of the scope report) can
// silently die. Walks every config-mutating custom operation this PR touches
// (plus the pre-existing scalar mirror on `config update`) and asserts BOTH
// stores were written, not just the one a narrower test happened to check.
describe('groups config — the container.json + container_configs dual write holds everywhere (case 13)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });
  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('config update mirrors every runtime-selecting scalar into both stores', async () => {
    const id = 'ag-dual-write-update';
    const folder = 'dual-write-update';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const res = await dispatch(
      {
        id: 'req-dual-update',
        command: 'groups-config-update',
        args: {
          id,
          provider: 'codex',
          model: 'gpt-6-dual',
          effort: 'high',
          assistant_name: 'Dual',
          timezone: 'Europe/Lisbon',
        },
      },
      { caller: 'host' },
    );
    expect(res.ok).toBe(true);

    const file = readContainerConfig(folder);
    expect(file.provider).toBe('codex');
    expect(file.model).toBe('gpt-6-dual');
    expect(file.effort).toBe('high');
    expect(file.assistantName).toBe('Dual');
    expect(file.timezone).toBe('Europe/Lisbon');

    const row = (await getContainerConfig(id))!;
    expect(row.provider).toBe('codex');
    expect(row.model).toBe('gpt-6-dual');
    expect(row.effort).toBe('high');
    expect(row.assistant_name).toBe('Dual');
    expect(row.timezone).toBe('Europe/Lisbon');
  });

  it('config add-mcp-server and remove-mcp-server both write file and DB', async () => {
    const id = 'ag-dual-write-mcp';
    const folder = 'dual-write-mcp';
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    const groupDir = `${TEST_DIR}/groups/${folder}`;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      `${groupDir}/container.json`,
      JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, skills: 'all' }) + '\n',
    );

    const added = await dispatch(
      {
        id: 'req-dual-add',
        command: 'groups-config-add-mcp-server',
        args: { id, name: 'both', url: 'https://both.example.com/mcp' },
      },
      { caller: 'host' },
    );
    expect(added.ok).toBe(true);
    expect(readContainerConfig(folder).mcpServers.both).toBeDefined();
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).both).toBeDefined();

    const removed = await dispatch(
      { id: 'req-dual-remove', command: 'groups-config-remove-mcp-server', args: { id, name: 'both' } },
      { caller: 'host' },
    );
    expect(removed.ok).toBe(true);
    expect(readContainerConfig(folder).mcpServers.both).toBeUndefined();
    expect(JSON.parse((await getContainerConfig(id))!.mcp_servers).both).toBeUndefined();
  });
});
