/**
 * One-shot migration: wire each existing group up to global memory via
 * an in-tree symlink + @-import.
 *
 * Claude Code's @-import only follows paths inside cwd, so a direct
 * `@/workspace/global/CLAUDE.md` or `@../global/CLAUDE.md` silently does
 * nothing (the import line is parsed but the target file is never
 * loaded into context). The working approach:
 *
 *   1. Symlink `groups/<folder>/.claude-global.md` →
 *      `/workspace/global/CLAUDE.md` (container path; dangling on host,
 *      valid inside the container via the /workspace/global mount).
 *   2. Have the group's CLAUDE.md import the symlink:
 *      `@./.claude-global.md`.
 *
 * This script:
 *   - Creates the symlink if missing.
 *   - Replaces any existing broken `@/workspace/global/CLAUDE.md` or
 *     `@../global/CLAUDE.md` import line with the symlink form.
 *   - Prepends the symlink import if neither form is present.
 *   - Skips entirely if `groups/global/CLAUDE.md` doesn't exist.
 *
 * Idempotent — safe to re-run.
 *
 * Usage: pnpm exec tsx scripts/migrate-group-claude-md.ts
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';

const GLOBAL_CLAUDE_MD = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
const GLOBAL_MEMORY_CONTAINER_PATH = '/workspace/global/CLAUDE.md';
const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
const IMPORT_LINE = `@./${GLOBAL_MEMORY_LINK_NAME}`;

// Match any existing @-import that points at global/CLAUDE.md, whether
// via absolute path, relative path, or the new symlink form.
const EXISTING_IMPORT_REGEX =
  /^@(?:\/workspace\/global\/CLAUDE\.md|\.\.\/global\/CLAUDE\.md|\.\/\.claude-global\.md)\s*$/m;

if (!fs.existsSync(GLOBAL_CLAUDE_MD)) {
  console.error(`No global CLAUDE.md at ${GLOBAL_CLAUDE_MD} — nothing to migrate.`);
  process.exit(1);
}

if (!fs.existsSync(GROUPS_DIR)) {
  console.error(`No groups dir at ${GROUPS_DIR} — nothing to migrate.`);
  process.exit(1);
}

const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
let updated = 0;
let alreadyWired = 0;
let missingClaudeMd = 0;
let symlinksCreated = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (entry.name === 'global') continue;

  const groupDir = path.join(GROUPS_DIR, entry.name);

  // Symlink (idempotent — skip if already present)
  const linkPath = path.join(groupDir, GLOBAL_MEMORY_LINK_NAME);
  let linkExists = false;
  try {
    fs.lstatSync(linkPath);
    linkExists = true;
  } catch {
    /* missing */
  }
  if (!linkExists) {
    fs.symlinkSync(GLOBAL_MEMORY_CONTAINER_PATH, linkPath);
    console.log(`[link]  ${entry.name}: created ${GLOBAL_MEMORY_LINK_NAME}`);
    symlinksCreated++;
  }

  // CLAUDE.md import wiring
  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    console.log(`[skip]  ${entry.name}: no CLAUDE.md`);
    missingClaudeMd++;
    continue;
  }

  const body = fs.readFileSync(claudeMd, 'utf-8');
  const match = body.match(EXISTING_IMPORT_REGEX);

  if (match && match[0] === IMPORT_LINE) {
    console.log(`[wired] ${entry.name}: already imports ${IMPORT_LINE}`);
    alreadyWired++;
    continue;
  }

  let newBody: string;
  if (match) {
    // Replace the broken import with the working form
    newBody = body.replace(EXISTING_IMPORT_REGEX, IMPORT_LINE);
    console.log(`[fix]   ${entry.name}: rewrote ${match[0]} → ${IMPORT_LINE}`);
  } else {
    // Prepend fresh
    newBody = `${IMPORT_LINE}\n\n${body}`;
    console.log(`[ok]    ${entry.name}: prepended ${IMPORT_LINE}`);
  }

  fs.writeFileSync(claudeMd, newBody);
  updated++;
}

console.log(
  `\nDone. updated=${updated} alreadyWired=${alreadyWired} missingClaudeMd=${missingClaudeMd} symlinksCreated=${symlinksCreated}`,
);
