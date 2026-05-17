#!/usr/bin/env node
// Live verification: post a test message via the Discord REST API
// containing the wire form our patched pipeline produces, then fetch it
// back to confirm `mentions[]` is populated. This is the test I should
// have run before claiming any of PRs #90, #91, #92, #97 worked.

import { readFileSync } from 'node:fs';

const envText = readFileSync('/home/ubuntu/nanoclaw-v2/.env', 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')];
    }),
);

const AXIE_TOKEN = env.DISCORD_BOT_TOKEN;
const AXIE_CODEX_ID = '1505246118940770375';
const CHANNEL_ID = '1491839654528548989'; // axie-dev channel in Axie AI guild — guild context, both bots members

if (!AXIE_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bot ${AXIE_TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'nanoclaw-verify-script',
};

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function probe(wireContent, label) {
  console.log(`\n=== ${label} ===`);
  console.log(`  posting content: ${JSON.stringify(wireContent)}`);
  const posted = await api('POST', `/channels/${CHANNEL_ID}/messages`, {
    content: wireContent,
  });
  console.log(`  posted id: ${posted.id}`);
  const fetched = await api('GET', `/channels/${CHANNEL_ID}/messages/${posted.id}`);
  console.log(`  fetched content: ${JSON.stringify(fetched.content)}`);
  console.log(`  fetched mentions: ${JSON.stringify(fetched.mentions.map((m) => ({ id: m.id, username: m.username })))}`);
  const mentionedIds = new Set(fetched.mentions.map((m) => m.id));
  await api('DELETE', `/channels/${CHANNEL_ID}/messages/${posted.id}`);
  console.log(`  deleted (cleanup)`);
  return { content: fetched.content, mentionedIds };
}

// Case 1: the EXACT wire form our patched pipeline produces.
// Expect: content preserved, mentions[] contains AXIE_CODEX_ID.
const r1 = await probe(
  `Your turn, <@${AXIE_CODEX_ID}>. Try to keep up.`,
  'patched pipeline output (clean <@id>.)',
);

// Case 2: what the UN-patched pipeline produced (the bug we're fixing).
// Expect: mentions[] empty (or just AXIE), because <<@id>> isn't a real mention.
const r2 = await probe(
  `Your turn, <<@${AXIE_CODEX_ID}>>. Try to keep up.`,
  'double-wrapped (old bug — should NOT mention)',
);

// Case 3: the visible-failure form from the 5/17 screenshot.
const r3 = await probe(
  `Your turn, <@Axie>-Codex. Try to keep up.`,
  'literal name in brackets (5/17 screenshot bug)',
);

console.log(`\n=== verdict ===`);
console.log(
  `case 1 (clean <@id>.): mentions Axie-Codex? ${r1.mentionedIds.has(AXIE_CODEX_ID) ? 'YES ✓' : 'NO ✗'}`,
);
console.log(
  `case 2 (<<@id>>): mentions Axie-Codex? ${r2.mentionedIds.has(AXIE_CODEX_ID) ? 'YES (unexpected)' : 'NO (expected — wire broken)'}`,
);
console.log(
  `case 3 (<@Axie>-Codex): mentions Axie-Codex? ${r3.mentionedIds.has(AXIE_CODEX_ID) ? 'YES (unexpected)' : 'NO (expected — literal name)'}`,
);

if (!r1.mentionedIds.has(AXIE_CODEX_ID)) {
  console.error(
    '\n✗ FAILED: the patched pipeline output does NOT produce a real mention. The fix is incomplete.',
  );
  process.exit(1);
}
console.log('\n✓ Patched pipeline output IS a real mention. Fix is correct on the wire.');
