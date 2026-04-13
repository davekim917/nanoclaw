/**
 * Automatic Memory Extraction
 *
 * Runs on a 60-second interval while a container is live, extracting facts
 * worth remembering via a lightweight Haiku call. Fire-and-forget — never
 * blocks the user-facing response.
 */

import fs from 'fs';
import path from 'path';

import { listMemories } from './db.js';
import { callHaiku } from './llm.js';
import { logger } from './logger.js';
import { saveMemory, updateMemory } from './memory-store.js';
import { Memory, NewMessage } from './types.js';

// Rate limit: one extraction per thread (chatJid) per 60 seconds.
// Keyed by chatJid so concurrent containers for different threads in the
// same group don't block each other.
const THROTTLE_MS = 60_000;
const lastExtraction = new Map<string, number>();

// Prevent overlapping Haiku calls for the same thread
const inFlight = new Set<string>();

// Tunable prompt template — loaded from file if present, otherwise default
const PROMPT_TEMPLATE_PATH = path.join(
  process.cwd(),
  'prompts',
  'memory-extraction.md',
);

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

interface ExtractedSave {
  action: 'save';
  type: Memory['type'];
  name: string;
  description: string;
  content: string;
}

interface ExtractedUpdate {
  action: 'update';
  id: string;
  fields: Partial<Pick<Memory, 'type' | 'name' | 'description' | 'content'>>;
}

type Extracted = ExtractedSave | ExtractedUpdate | { action: 'skip' };

/**
 * Fire-and-forget entry point. Call after every successful agent response.
 * @param chatJid Used as throttle/inFlight key so concurrent threads in the
 *   same group don't block each other.
 */
export function extractMemoriesAsync(
  groupFolder: string,
  chatJid: string,
  messages: NewMessage[],
  agentResponseText: string,
): void {
  extractMemories(groupFolder, chatJid, messages, agentResponseText).catch(
    (err) => {
      logger.warn(
        { err, groupFolder, chatJid },
        'Memory extraction failed (non-fatal)',
      );
    },
  );
}

async function extractMemories(
  groupFolder: string,
  chatJid: string,
  messages: NewMessage[],
  agentResponseText: string,
): Promise<void> {
  // Need at least one user message for context
  const userMessages = messages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  if (userMessages.length === 0) return;

  // Throttle per thread
  const now = Date.now();
  const last = lastExtraction.get(chatJid) ?? 0;
  if (now - last < THROTTLE_MS) return;

  // Prevent overlapping Haiku calls for same thread
  if (inFlight.has(chatJid)) return;
  inFlight.add(chatJid);

  try {
    return await extractMemoriesInner(
      groupFolder,
      chatJid,
      messages,
      agentResponseText,
      now,
    );
  } finally {
    inFlight.delete(chatJid);
  }
}

async function extractMemoriesInner(
  groupFolder: string,
  chatJid: string,
  messages: NewMessage[],
  agentResponseText: string,
  now: number,
): Promise<void> {
  // Build prompt — include both user and bot messages for full context
  const existing = listMemories(groupFolder, 30);
  const prompt = buildPrompt(messages, agentResponseText, existing);

  // Call Haiku (30s timeout for structured JSON)
  const raw = await callHaiku(prompt, 30_000);
  lastExtraction.set(groupFolder, now); // stamp after success so failures don't waste the window
  const extracted = parseResponse(raw);

  if (extracted.length === 0) return;

  let saved = 0;
  let updated = 0;

  for (const item of extracted) {
    if (item.action === 'skip') continue;

    if (item.action === 'save') {
      if (!item.name || !item.content) continue;
      if (!VALID_TYPES.has(item.type)) item.type = 'reference';

      // Name-based dedup safety net
      const dupe = existing.find(
        (m) => m.name.toLowerCase() === item.name.toLowerCase(),
      );
      if (dupe) {
        updateMemory(groupFolder, dupe.id, {
          content: item.content,
          ...(item.description ? { description: item.description } : {}),
        });
        updated++;
      } else {
        saveMemory(
          groupFolder,
          item.type,
          item.name,
          item.description || item.name,
          item.content,
        );
        saved++;
      }
    }

    if (item.action === 'update') {
      if (!item.id || !item.fields) continue;
      if (!existing.find((m) => m.id === item.id)) continue; // reject IDs not in known list
      updateMemory(groupFolder, item.id, item.fields);
      updated++;
    }
  }

  if (saved > 0 || updated > 0) {
    logger.info(
      { groupFolder, chatJid, saved, updated },
      'Memory extraction complete',
    );
  }
}

function buildPrompt(
  messages: NewMessage[],
  agentResponse: string,
  existing: Memory[],
): string {
  // Try loading tunable template
  const template = loadTemplate();
  if (template) {
    const subs: Record<string, string> = {
      USER_MESSAGES: formatMessages(messages),
      AGENT_RESPONSE: agentResponse.slice(-2000),
      EXISTING_MEMORIES: formatExistingMemories(existing),
    };
    return template.replace(
      /\{\{(USER_MESSAGES|AGENT_RESPONSE|EXISTING_MEMORIES)\}\}/g,
      (_, key: string) => subs[key] ?? '',
    );
  }

  // Default prompt
  const existingSection =
    existing.length > 0
      ? `\n## Existing Memories (do not duplicate)\n${formatExistingMemories(existing)}\n`
      : '';

  return `You are a memory extraction system. Analyze this conversation and extract facts worth remembering for future conversations with this user/group.

## Conversation
<messages>
${formatMessages(messages)}
</messages>

<latest_assistant_response>
${agentResponse.slice(-2000)}
</latest_assistant_response>
${existingSection}
## What to Extract

- *user*: Facts about people — name, role, preferences, expertise, relationships, communication style
- *project*: Company/project info — tech stack, architecture, decisions, deadlines, what's being worked on
- *reference*: External resources — URLs, systems, credentials patterns, config details
- *feedback*: User corrections or preferences about assistant behavior

## Rules

- Only extract NEW facts not already covered by existing memories
- If new info refines an existing memory, return an UPDATE with the memory id
- Be selective — only save things that would be useful in a future conversation
- Do NOT extract transient task details (e.g., "user asked me to fix a bug")
- Do NOT extract information the assistant said — only facts from the user or confirmed decisions

Reply with ONLY a JSON array (no markdown fences, no explanation):
[
  {"action": "save", "type": "user", "name": "short name", "description": "one-line why this matters", "content": "the fact"},
  {"action": "update", "id": "mem-xxx", "fields": {"content": "refined fact"}}
]

If nothing is worth extracting, reply with: []`;
}

function formatMessages(messages: NewMessage[]): string {
  return messages
    .map((m) => {
      const role = m.is_from_me || m.is_bot_message ? '[assistant]' : '[user]';
      return `${role} ${m.sender_name}: ${m.content.slice(0, 500)}`;
    })
    .join('\n')
    .slice(0, 3000);
}

function formatExistingMemories(memories: Memory[]): string {
  return memories
    .map((m) => `[${m.id}] (${m.type}) ${m.name}: ${m.description}`)
    .join('\n');
}

function loadTemplate(): string | null {
  try {
    if (fs.existsSync(PROMPT_TEMPLATE_PATH)) {
      return fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf-8');
    }
  } catch {
    // Fall through to default
  }
  return null;
}

function parseResponse(raw: string): Extracted[] {
  // Strip markdown fences if Haiku wraps them
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: Record<string, unknown>) =>
        item &&
        typeof item === 'object' &&
        (item.action === 'save' ||
          item.action === 'update' ||
          item.action === 'skip'),
    ) as Extracted[];
  } catch {
    logger.debug(
      { raw: raw.slice(0, 200) },
      'Memory extraction: failed to parse Haiku JSON',
    );
    return [];
  }
}
