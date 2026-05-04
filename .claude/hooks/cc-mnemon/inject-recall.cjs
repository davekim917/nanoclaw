#!/usr/bin/env node
/**
 * UserPromptSubmit hook: query the per-project mnemon store for facts
 * relevant to the user's prompt and inject them as additionalContext so
 * Claude Code sees `[Recalled context]` before processing the turn.
 *
 * Step 1 of CC mnemon integration. Scoped to nanoclaw-v2 via project-local
 * .claude/settings.json wiring. Step 2 will derive the store name from
 * cwd → project slug for any opted-in CC project.
 *
 * No-ops on:
 *   - prompts under 10 chars (slash commands, single words)
 *   - bare slash commands (e.g. /help) — the leading `/` plus no spaces
 *   - mnemon binary missing
 *   - empty recall results
 *   - timeout (5s hard cap so slow recall never blocks the user)
 *
 * Output schema: hookSpecificOutput.additionalContext is the documented
 * UserPromptSubmit channel for adding context that Claude sees before the
 * user's prompt.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

const STORE = 'host-cc-nanoclaw-v2';
const MNEMON = '/home/ubuntu/.local/bin/mnemon';
const RECALL_LIMIT = 8;
const RECALL_TIMEOUT_MS = 5000;
const MIN_PROMPT_LEN = 10;
const MAX_RECALL_QUERY_CHARS = 200;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return null;
  }
}

function main() {
  const input = readInput();
  if (!input) process.exit(0);

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt.length < MIN_PROMPT_LEN) process.exit(0);
  if (prompt.startsWith('/') && !prompt.includes(' ')) process.exit(0);

  if (!fs.existsSync(MNEMON)) process.exit(0);

  const keyword = prompt.slice(0, MAX_RECALL_QUERY_CHARS);
  const result = spawnSync(
    MNEMON,
    ['recall', keyword, '--limit', String(RECALL_LIMIT), '--store', STORE],
    { encoding: 'utf-8', timeout: RECALL_TIMEOUT_MS },
  );

  if (result.error) process.exit(0);
  if (result.status !== 0) process.exit(0);
  const out = (result.stdout || '').trim();
  if (!out) process.exit(0);

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    process.exit(0);
  }
  const results = Array.isArray(parsed && parsed.results) ? parsed.results : [];
  if (results.length === 0) process.exit(0);

  const lines = results
    .map((r) => {
      const content = r && r.insight && typeof r.insight.content === 'string' ? r.insight.content.trim() : '';
      if (!content) return null;
      const cat = r.insight.category ? `${r.insight.category}` : 'fact';
      const src = r.insight.source ? `, src=${r.insight.source}` : '';
      return `- [${cat}${src}] ${content}`;
    })
    .filter(Boolean);
  if (lines.length === 0) process.exit(0);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        '[Recalled context — ambient memory from prior CC sessions in this project]\n' + lines.join('\n'),
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main();
