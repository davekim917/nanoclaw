#!/usr/bin/env node
/**
 * Stop hook: capture the most recent CC turn-pair (user → assistant) into
 * the synthetic agent group's sources/inbox/ for the mnemon classifier.
 *
 * Step 1 of CC mnemon integration. Scoped to nanoclaw-v2 via project-local
 * .claude/settings.json wiring. Step 2 will generalize to per-project stores.
 *
 * Output format mirrors the container's memory-capture.ts contract:
 *   - plain UTF-8 text
 *   - 50KB cap (matches MAX_CAPTURE_BYTES)
 *   - atomic write with `flag: 'wx'` (no clobber)
 *   - deterministic hash filename so re-runs on the same turn no-op
 *
 * Skips:
 *   - turns with no user text or no assistant text
 *   - user messages under 20 chars (low signal-to-noise — `git status` etc.)
 *   - assistant messages with no text content (tool-only turns)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INBOX = '/home/ubuntu/nanoclaw-v2/groups/host-claude-code/sources/inbox';
const MAX_BYTES = 50_000;
const TRUNCATION_NOTICE = '\n\n[Truncated by cc-mnemon capture: exceeded 50KB cap.]\n';
const MIN_USER_LEN = 20;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return null;
  }
}

function extractText(msg) {
  const c = msg && msg.message && msg.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function userMessageHasText(msg) {
  // Skip pure tool_result user turns — they're system-level, not user prose.
  const c = msg && msg.message && msg.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
}

function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8') + TRUNCATION_NOTICE;
}

function main() {
  const input = readInput();
  if (!input) process.exit(0);

  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id;
  if (!transcriptPath || !sessionId) process.exit(0);
  if (!fs.existsSync(transcriptPath)) process.exit(0);
  if (!fs.existsSync(INBOX)) process.exit(0);

  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    process.exit(0);
  }

  const events = [];
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch {
      // Skip malformed lines silently.
    }
  }

  let assistantMsg = null;
  let userMsg = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!assistantMsg && e.type === 'assistant' && e.message && e.message.role === 'assistant') {
      assistantMsg = e;
      continue;
    }
    if (assistantMsg && !userMsg && e.type === 'user' && e.message && e.message.role === 'user' && userMessageHasText(e)) {
      userMsg = e;
      break;
    }
  }
  if (!assistantMsg || !userMsg) process.exit(0);

  const userText = extractText(userMsg).trim();
  const assistantText = extractText(assistantMsg).trim();
  if (!userText || !assistantText) process.exit(0);
  if (userText.length < MIN_USER_LEN) process.exit(0);

  const ts = assistantMsg.timestamp || new Date().toISOString();
  const text = `[CC session: ${sessionId}, turn: ${ts}]\n\nUSER:\n${userText}\n\nASSISTANT:\n${assistantText}\n`;
  const bounded = truncateToBytes(text, MAX_BYTES);

  const key = `${sessionId}|${assistantMsg.uuid || ts}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  const dest = path.join(INBOX, `cc-${hash}.txt`);
  if (fs.existsSync(dest)) process.exit(0);

  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, bounded, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(tmp, dest);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }

  process.exit(0);
}

main();
