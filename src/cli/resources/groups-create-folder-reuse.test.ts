/**
 * A4 — folder-reuse refusal (plan-review security finding "immutable
 * identity"). Cases 9, 10, 14 (theme T2 PR 3, docs/specs/upstream-theme-ports/
 * plan.md §5).
 *
 * `ncl groups delete` never removes `groups/<folder>/` (declared contract of
 * the delete handler), so a folder on disk with no claiming DB row is
 * deleted-group residue or an operator-placed dir. Minting a NEW agent-group
 * id over it would silently adopt the old group's data (memory, skills,
 * CLAUDE.md) under a new identity. The fresh-create branch of
 * `ncl groups create` must refuse; idempotent reuse of a LIVE folder's group
 * (DB row exists) is untouched.
 *
 * Adopted from upstream 92a3518b7's own `groups-create-folder-reuse.test.ts`
 * with two fork-side fixes: a unique `uniqueTmpRoot` root instead of upstream's
 * hardcoded shared `/tmp` path (§3.6 — the shared path reintroduces cross-suite
 * collisions under parallel vitest), and `initMigratedTestDb` + the async
 * `getAgentGroupByFolder`/`getContainerConfig` accessors instead of upstream's
 * synchronous `getDb().prepare(...)`, since the fork's central DB is async
 * (seam 3) and this file must not name the raw handle (`src/db/raw-db-ratchet
 * .test.ts` pins that set, shrink-only).
 *
 * Separate file from groups.test.ts on purpose, matching upstream's own
 * layout: this suite must mock GROUPS_DIR (groups.test.ts mocks it too, but
 * keeping this suite upstream-shaped keeps the ratchet diff meaningful).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('test-groups-create-folder-reuse') }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_ROOT}/data`,
    GROUPS_DIR: `${TEST_ROOT}/groups`,
  };
});

const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

import { initMigratedTestDb, closeDb } from '../../db/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including create).
import './groups.js';

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function create(folder: string) {
  return dispatch(
    {
      id: `req-create-${folder}-${Math.random().toString(36).slice(2, 8)}`,
      command: 'groups-create',
      args: { folder },
    },
    { caller: 'host' },
  );
}

describe('groups-create — folder-reuse refusal (A4 / case 9, 10)', () => {
  it('refuses to mint a new group over undisposed on-disk residue (case 9)', async () => {
    // Deleted-group residue: the folder is on disk, no DB row claims it.
    fs.mkdirSync(path.join(GROUPS_DIR, 'recycled'));
    fs.writeFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'old group memory\n');

    const resp = await create('recycled');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { message: string } }).error;
    expect(error.message).toContain('already exists on disk');
    expect(error.message).toContain('recycled');
    // No row minted, residue untouched.
    expect(await getAgentGroupByFolder('recycled')).toBeUndefined();
    expect(fs.readFileSync(path.join(GROUPS_DIR, 'recycled', 'memory.md'), 'utf8')).toBe('old group memory\n');
  });

  it('refuses when the residue is a dangling symlink at groups/<folder> (case 9)', async () => {
    // Residue can be a symlink whose target is gone (e.g. an operator linked
    // the folder elsewhere and the target was removed). It still occupies the
    // name — mkdir would EEXIST — so the fresh-create branch must refuse it
    // like any other on-disk presence. `groupFolderExistsOnDisk` uses lstat,
    // not existsSync, so it still counts as present.
    fs.symlinkSync(path.join(TEST_ROOT, 'no-such-target'), path.join(GROUPS_DIR, 'linked'));

    const resp = await create('linked');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { message: string } }).error;
    expect(error.message).toContain('already exists on disk');
    expect(await getAgentGroupByFolder('linked')).toBeUndefined();
  });

  it('allows creation when the folder is absent (scaffolds folder + config row)', async () => {
    const resp = await create('fresh');

    expect(resp.ok).toBe(true);
    const row = await getAgentGroupByFolder('fresh');
    expect(row).toBeDefined();
    expect(fs.existsSync(path.join(GROUPS_DIR, 'fresh'))).toBe(true);
    expect(await getContainerConfig(row!.id)).toBeDefined();
  });

  it('returns the SAME group when the folder is live — idempotency on --folder pinned (case 10)', async () => {
    const first = await create('steady');
    expect(first.ok).toBe(true);
    const firstId = (first as { ok: true; data: { id: string } }).data.id;

    // The folder now exists on disk AND a DB row claims it. The refusal must
    // sit on the fresh-create branch only — a second create with the same
    // --folder returns the existing group, exactly as documented
    // ("Idempotent on --folder").
    const second = await create('steady');
    expect(second.ok).toBe(true);
    expect((second as { ok: true; data: { id: string } }).data.id).toBe(firstId);
  });
});

describe('groups-create — bare create validates the folder grammar (case 14)', () => {
  it('refuses a folder the runtime label grammar would reject', async () => {
    const resp = await create('has a space');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { message: string } }).error;
    expect(error.message).toMatch(/Invalid group folder/);
    expect(await getAgentGroupByFolder('has a space')).toBeUndefined();
  });

  it('returns a LIVE group whose folder predates the current grammar, unchanged (github Codex review, PR #486)', async () => {
    // Grammar validation must sit strictly after the existing-row lookup and
    // the on-disk probe, not before — an older bare-create path accepted
    // folder names the current grammar refuses (e.g. a dot), and that group
    // is still live. Validating earlier would break documented idempotence
    // on --folder for every such legacy group: a repeat `groups create` with
    // its own folder would throw "Invalid group folder" instead of returning
    // the existing row.
    const legacyFolder = 'legacy.folder';
    await createAgentGroup({
      id: 'ag-legacy',
      name: 'Legacy',
      folder: legacyFolder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const resp = await create(legacyFolder);

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { id: string } }).data.id).toBe('ag-legacy');
  });
});
