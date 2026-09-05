import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getRawDb, initTestDb, closeDb } from './connection.js';
import { getWorkgroupOnecliSecrets } from './agent-groups.js';

describe('getWorkgroupOnecliSecrets', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    db.exec(`
      CREATE TABLE workgroups (
        id TEXT PRIMARY KEY,
        onecli_secrets TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        agent_provider TEXT,
        workgroup_id TEXT REFERENCES workgroups(id),
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO workgroups (id, onecli_secrets) VALUES (?, ?)`).run(
      'wg-retail',
      JSON.stringify(['Slack-User-Token-example-retail', 'Anthropic']),
    );
    db.prepare(`INSERT INTO workgroups (id, onecli_secrets) VALUES (?, ?)`).run('wg-empty', '[]');
    const insertAg = db.prepare(
      `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insertAg.run('ag-retail', 'retail', 'retail', 'wg-retail', '2026-01-01');
    insertAg.run('ag-empty', 'e', 'e', 'wg-empty', '2026-01-01');
    insertAg.run('ag-no-wg', 'n', 'n', null, '2026-01-01');
  });

  afterEach(() => closeDb());

  it('returns the workgroup secret declarations for a member group', async () => {
    expect(await getWorkgroupOnecliSecrets('ag-retail')).toEqual(['Slack-User-Token-example-retail', 'Anthropic']);
  });

  it('returns [] when the workgroup declares none', async () => {
    expect(await getWorkgroupOnecliSecrets('ag-empty')).toEqual([]);
  });

  it('returns [] when the group has no workgroup', async () => {
    expect(await getWorkgroupOnecliSecrets('ag-no-wg')).toEqual([]);
  });

  it('returns [] for an unknown group id', async () => {
    expect(await getWorkgroupOnecliSecrets('does-not-exist')).toEqual([]);
  });

  it('returns [] (not a throw) when onecli_secrets holds malformed JSON', async () => {
    getRawDb().prepare(`UPDATE workgroups SET onecli_secrets = ? WHERE id = ?`).run('{not json', 'wg-retail');
    expect(await getWorkgroupOnecliSecrets('ag-retail')).toEqual([]);
  });
});
