/**
 * Phase 0 data migration: v1 Claude Code auto-memory → v2.
 *
 * Companion to `scripts/import-v1-memories.ts`. The two scripts cover
 * DIFFERENT memory systems:
 *
 *   - import-v1-memories.ts  : v1's SQLite `memories` table (the memory
 *                              MCP tool's rows — user/project/feedback/
 *                              reference, explicitly written by agents)
 *   - THIS SCRIPT            : Claude Code's auto-memory files (MEMORY.md
 *                              + the individual `*.md` notes it writes
 *                              into `~/.claude/projects/<hash>/memory/`)
 *
 * Both are needed. The former gives v2 the explicit remembered-facts; the
 * latter gives v2 the lived conversational context Claude Code builds up
 * on its own.
 *
 * Source layout (v1):
 *   /home/ubuntu/nanoclaw/data/sessions/<v1-folder>/.claude/projects/
 *     └── -workspace-group/memory/   ← v1 cwd was /workspace/group
 *         ├── MEMORY.md
 *         ├── user_*.md
 *         ├── project_*.md
 *         ├── feedback_*.md
 *         └── reference_*.md
 *
 * Target layout (v2):
 *   /home/ubuntu/nanoclaw-v2/data/v2-sessions/<v2-agent-group-id>/.claude-shared/projects/
 *     └── -workspace-agent/memory/   ← v2 cwd is /workspace/agent (different hash)
 *
 * The project-hash differs because v1 runs the SDK with cwd=/workspace/group
 * and v2 runs with cwd=/workspace/agent (see container/agent-runner/src/index.ts
 * CWD constant). The memory *content* is identical — it's just filed under
 * whatever project-hash Claude Code derived at the time it was written.
 *
 * Merge policy: overwrite-from-v1. v2's auto-memory has been frozen since
 * the Apr 17 UID bug (see commit fixing the node UID remap), so there's
 * essentially no v2 state worth preserving. Any existing v2 file is
 * backed up with a .pre-import suffix next to it before being overwritten,
 * so a rollback is a one-liner.
 *
 * Usage:
 *   # dry-run (default — prints plan, no copies):
 *   npx tsx scripts/import-v1-claude-memory.ts
 *
 *   # with folder remapping (v1 folder → v2 folder):
 *   npx tsx scripts/import-v1-claude-memory.ts --map illysium=illysium-v2 --map main=main
 *
 *   # commit:
 *   npx tsx scripts/import-v1-claude-memory.ts --map illysium=illysium-v2 --commit
 *
 * Run this during Phase 4 cutover, after v1 stops and alongside
 * import-v1-memories.ts. The two together restore v2 to full memory
 * parity with v1.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';

const V1_SESSIONS_DIR = '/home/ubuntu/nanoclaw/data/sessions';
const V1_PROJECT_HASH = '-workspace-group';
const V2_PROJECT_HASH = '-workspace-agent';
const V2_DB = path.join(DATA_DIR, 'v2.db');
const CONTAINER_UID = 1001;
const CONTAINER_GID = 1001;

function parseMap(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--map' && args[i + 1]) {
      const [from, to] = args[i + 1].split('=');
      if (from && to) m.set(from, to);
      i++;
    }
  }
  return m;
}

interface PlanEntry {
  v1Folder: string;
  v2Folder: string;
  agentGroupId: string;
  sourceDir: string;
  targetDir: string;
  files: string[];
}

function listMemoryFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => {
      const full = path.join(dir, f);
      try {
        return fs.statSync(full).isFile() && (f === 'MEMORY.md' || f.endsWith('.md'));
      } catch {
        return false;
      }
    })
    .sort();
}

function copyWithBackup(sourceDir: string, targetDir: string, files: string[]): { copied: number; backedUp: number } {
  fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  let backedUp = 0;
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    if (fs.existsSync(dst)) {
      fs.renameSync(dst, `${dst}.pre-import`);
      backedUp++;
    }
    fs.copyFileSync(src, dst);
    copied++;
  }
  return { copied, backedUp };
}

function chownDir(dir: string): void {
  // Use sudo only if we're not already that uid (script may run as root
  // during cutover, or as ubuntu; either way align final ownership with
  // the container's UID mapping — see fix(container): remap node UID).
  try {
    execFileSync('chown', ['-R', `${CONTAINER_UID}:${CONTAINER_GID}`, dir], { stdio: 'ignore' });
  } catch (err) {
    // If not running as root, chown will EPERM. Fall back to sudo.
    try {
      execFileSync('sudo', ['-n', 'chown', '-R', `${CONTAINER_UID}:${CONTAINER_GID}`, dir], { stdio: 'ignore' });
    } catch {
      console.warn(`chown ${dir} → ${CONTAINER_UID}:${CONTAINER_GID} failed: ${err instanceof Error ? err.message : String(err)}`);
      console.warn('  Container may not be able to write new memories into this dir until chown runs manually.');
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const folderMap = parseMap(args);

  initDb(V2_DB);
  const v2AgentGroups = getAllAgentGroups();
  const folderToId = new Map(v2AgentGroups.map((ag) => [ag.folder, ag.id]));

  console.log(`V1 sessions dir: ${V1_SESSIONS_DIR}`);
  console.log(`V2 sessions dir: ${DATA_DIR}/v2-sessions`);
  console.log(`V2 agent groups: ${v2AgentGroups.length}`);
  console.log(
    `Folder remapping: ${folderMap.size ? [...folderMap].map(([k, v]) => `${k}→${v}`).join(', ') : '(none — direct match)'}`,
  );
  console.log();

  if (!fs.existsSync(V1_SESSIONS_DIR)) {
    console.log(`V1 sessions dir does not exist — nothing to import.`);
    return;
  }

  const v1Folders = fs
    .readdirSync(V1_SESSIONS_DIR)
    .filter((f) => fs.statSync(path.join(V1_SESSIONS_DIR, f)).isDirectory());

  const plan: PlanEntry[] = [];
  const skipped: Array<{ folder: string; reason: string }> = [];

  for (const v1Folder of v1Folders) {
    const sourceDir = path.join(V1_SESSIONS_DIR, v1Folder, '.claude', 'projects', V1_PROJECT_HASH, 'memory');
    const files = listMemoryFiles(sourceDir);
    if (files.length === 0) {
      skipped.push({ folder: v1Folder, reason: 'no memory files' });
      continue;
    }
    const v2Folder = folderMap.get(v1Folder) ?? v1Folder;
    const agentGroupId = folderToId.get(v2Folder);
    if (!agentGroupId) {
      skipped.push({
        folder: v1Folder,
        reason: `no v2 agent group with folder "${v2Folder}" — add --map ${v1Folder}=<v2-folder>`,
      });
      continue;
    }
    const targetDir = path.join(
      DATA_DIR,
      'v2-sessions',
      agentGroupId,
      '.claude-shared',
      'projects',
      V2_PROJECT_HASH,
      'memory',
    );
    plan.push({ v1Folder, v2Folder, agentGroupId, sourceDir, targetDir, files });
  }

  console.log('Plan:');
  for (const p of plan) {
    console.log(`  ${p.v1Folder.padEnd(18)} → ${p.v2Folder.padEnd(18)} (${p.agentGroupId})  ${p.files.length} files`);
  }
  if (skipped.length) {
    console.log();
    console.log('Skipped:');
    for (const s of skipped) console.log(`  ${s.folder.padEnd(18)} — ${s.reason}`);
  }
  console.log();

  if (!commit) {
    console.log('Dry-run. Pass --commit to perform the copy.');
    return;
  }

  let totalCopied = 0;
  let totalBackedUp = 0;
  for (const p of plan) {
    const { copied, backedUp } = copyWithBackup(p.sourceDir, p.targetDir, p.files);
    totalCopied += copied;
    totalBackedUp += backedUp;
    // Chown the whole .claude-shared tree for the group so subsequent dirs
    // Claude Code creates also inherit the right ownership.
    const shareRoot = path.join(DATA_DIR, 'v2-sessions', p.agentGroupId, '.claude-shared');
    chownDir(shareRoot);
    console.log(`  ${p.v1Folder}: copied ${copied}${backedUp ? `, backed up ${backedUp}` : ''}`);
  }

  console.log();
  console.log(`Committed. files-copied=${totalCopied} pre-import-backups=${totalBackedUp}`);
}

main();
