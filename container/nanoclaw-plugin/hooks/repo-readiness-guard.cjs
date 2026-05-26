#!/usr/bin/env node
/**
 * GitNexus Index Guard — PreToolUse hook
 *
 * Fires before Edit/Write/MultiEdit to check if the target repo has a
 * current GitNexus index. Without one, the post-commit blast radius
 * hook silently no-ops and changes go unvalidated.
 *
 * Checks once per repo per container session (marker in /tmp).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return {};
  }
}

function findGitRoot(startDir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    timeout: 3000,
    cwd: startDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status === 0) return (result.stdout || '').trim();
  return null;
}

/**
 * Locate the .gitnexus index dir for a repo. The index lives at the repo root
 * on a normal checkout, but for a LINKED worktree (container agents commit in
 * /workspace/worktrees/<repo>) it sits beside the BASE clone
 * (/workspace/agent/<repo>/.gitnexus) — a sibling that --show-toplevel never
 * points at. Resolve the base clone via git's COMMON dir and check there too.
 * Returns the .gitnexus dir path, or null when no index exists anywhere.
 */
function findGitNexusDir(repoPath) {
  const direct = path.join(repoPath, '.gitnexus');
  if (fs.existsSync(path.join(direct, 'meta.json'))) return direct;
  try {
    const common = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (common.status === 0) {
      const gitDir = (common.stdout || '').trim();
      if (gitDir) {
        const baseRoot = path.dirname(path.resolve(repoPath, gitDir));
        const candidate = path.join(baseRoot, '.gitnexus');
        if (fs.existsSync(path.join(candidate, 'meta.json'))) return candidate;
      }
    }
  } catch {
    /* ignore — fall through to null */
  }
  return null;
}

/**
 * Returns 'missing' | 'stale' | 'current'
 */
function checkGitNexusIndex(repoPath) {
  const gnDir = findGitNexusDir(repoPath);
  if (!gnDir) return 'missing';

  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gnDir, 'meta.json'), 'utf-8'));
    const lastCommit = meta.lastCommit || '';

    // Compare against the HEAD of the repo the index DESCRIBES (the dir that
    // contains .gitnexus — the base clone for a worktree), not the worktree's
    // thread-branch tip. The thread branch always diverges from the indexed
    // base, which would otherwise read as perpetually 'stale'.
    const indexRepo = path.dirname(gnDir);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd: indexRepo,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const currentHead = (head.stdout || '').trim();

    if (currentHead && currentHead !== lastCommit) return 'stale';
    return 'current';
  } catch {
    return 'missing';
  }
}

const CHECKED_MARKER_DIR = '/tmp/.gitnexus-index-checked';

function markerPath(repoPath) {
  return path.join(CHECKED_MARKER_DIR, Buffer.from(repoPath).toString('base64url'));
}

function alreadyChecked(repoPath) {
  return fs.existsSync(markerPath(repoPath));
}

function markChecked(repoPath) {
  try {
    fs.mkdirSync(CHECKED_MARKER_DIR, { recursive: true });
    fs.writeFileSync(markerPath(repoPath), '');
  } catch {
    /* best effort */
  }
}

function main() {
  try {
    const input = readInput();
    if ((input.hook_event_name || '') !== 'PreToolUse') return;

    const toolName = input.tool_name || '';
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit')
      return;

    const filePath = (input.tool_input || {}).file_path || '';
    if (!filePath || !path.isAbsolute(filePath)) return;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) return;

    const repoPath = findGitRoot(dir);
    if (!repoPath) return;

    if (alreadyChecked(repoPath)) return;

    const indexState = checkGitNexusIndex(repoPath);
    markChecked(repoPath);
    if (indexState === 'current') return;

    const repoName = path.basename(repoPath);
    const action =
      indexState === 'missing'
        ? 'No GitNexus index found.'
        : 'GitNexus index is stale.';

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext:
            `**${action}** (\`${repoName}\`)\n` +
            'Follow the **gitnexus-index-setup** skill to create/refresh the index before proceeding. ' +
            'Without a current index, the post-commit blast radius hook will silently skip.',
        },
      }),
    );
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('Index guard error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
