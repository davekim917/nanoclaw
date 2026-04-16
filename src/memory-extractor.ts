/**
 * Haiku-driven memory extraction.
 *
 * Runs periodically while a session is active, extracting facts worth
 * remembering from the conversation. Fire-and-forget — never blocks the
 * user-facing response.
 *
 * Ported from v1 fork's `memory-extractor.ts`. Key changes in v2:
 * - Scope key: `sessionId` (instead of `chatJid`) for throttle/in-flight tracking
 * - Memory scope: `agentGroupId` (instead of `groupFolder`) for persistence
 * - Abstracted message input: `ConversationMessage` instead of v1's `NewMessage`,
 *   so callers (delivery.ts hook + host-sweep interval) can produce it from
 *   either messages_in or messages_out DB rows
 */
import fs from 'fs';
import path from 'path';

import { listMemories } from './db/memories.js';
import { callHaiku } from './llm.js';
import { log } from './log.js';
import { deleteMemory, saveMemory, updateMemory } from './memory-store.js';
import type { Memory } from './types.js';

/**
 * Conversation message input. Callers adapt from `MessageIn`/`MessageOut`
 * DB rows when invoking extraction.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  senderName: string;
  content: string;
}

const THROTTLE_MS = 60_000;
const lastExtraction = new Map<string, number>();
const inFlight = new Set<string>();

/** Clean up per-session state when a session ends. */
export function clearExtractionState(sessionId: string): void {
  lastExtraction.delete(sessionId);
}

// Tunable prompt template — loaded from file if present
const PROMPT_TEMPLATE_PATH = path.join(process.cwd(), 'prompts', 'memory-extraction.md');

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const MEMORY_CONTENT_PREVIEW_CHARS = 200;

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
interface ExtractedDelete {
  action: 'delete';
  id: string;
}
type Extracted = ExtractedSave | ExtractedUpdate | ExtractedDelete | { action: 'skip' };

/**
 * Fire-and-forget entry point. Call after delivery confirms a chat message
 * reached the user, and from the host-sweep interval for long sessions.
 *
 * @param sessionId Unique per session — throttle key so concurrent sessions
 *   don't block each other even within the same agent group.
 */
export function extractMemoriesAsync(
  agentGroupId: string,
  sessionId: string,
  messages: ConversationMessage[],
  latestAgentText: string,
): void {
  extractMemories(agentGroupId, sessionId, messages, latestAgentText).catch((err) => {
    log.warn('Memory extraction failed (non-fatal)', { err, agentGroupId, sessionId });
  });
}

async function extractMemories(
  agentGroupId: string,
  sessionId: string,
  messages: ConversationMessage[],
  latestAgentText: string,
): Promise<void> {
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) return;

  const now = Date.now();
  const last = lastExtraction.get(sessionId) ?? 0;
  if (now - last < THROTTLE_MS) return;
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);

  try {
    const existing = listMemories(agentGroupId, 30);
    const prompt = buildPrompt(messages, latestAgentText, existing);

    const raw = await callHaiku(prompt, { timeoutMs: 30_000 });
    lastExtraction.set(sessionId, now);
    const extracted = parseResponse(raw);
    if (extracted.length === 0) return;

    let saved = 0;
    let updated = 0;
    let deleted = 0;

    for (const item of extracted) {
      if (item.action === 'skip') continue;

      if (item.action === 'save') {
        if (!item.name || !item.content) continue;
        if (!VALID_TYPES.has(item.type)) item.type = 'reference';

        const dupe = existing.find((m) => m.name.toLowerCase() === item.name.toLowerCase());
        if (dupe) {
          updateMemory(agentGroupId, dupe.id, {
            content: item.content,
            ...(item.description ? { description: item.description } : {}),
          });
          updated++;
        } else {
          saveMemory(agentGroupId, item.type, item.name, item.description || item.name, item.content);
          saved++;
        }
      } else if (item.action === 'update') {
        if (!item.id || !item.fields) continue;
        if (!existing.some((m) => m.id === item.id)) continue;
        updateMemory(agentGroupId, item.id, item.fields);
        updated++;
      } else if (item.action === 'delete') {
        if (!item.id) continue;
        if (!existing.some((m) => m.id === item.id)) continue;
        deleteMemory(agentGroupId, item.id);
        deleted++;
      }
    }

    if (saved > 0 || updated > 0 || deleted > 0) {
      log.info('Memory extraction complete', { agentGroupId, sessionId, saved, updated, deleted });
    }
  } finally {
    inFlight.delete(sessionId);
  }
}

function buildPrompt(messages: ConversationMessage[], agentResponse: string, existing: Memory[]): string {
  const template = loadTemplate();
  if (template) {
    const subs: Record<string, string> = {
      MESSAGES: formatMessages(messages),
      USER_MESSAGES: formatMessages(messages),
      AGENT_RESPONSE: agentResponse.slice(-2000),
      EXISTING_MEMORIES: formatExistingMemories(existing),
    };
    return template.replace(
      /\{\{(MESSAGES|USER_MESSAGES|AGENT_RESPONSE|EXISTING_MEMORIES)\}\}/g,
      (_, key: string) => subs[key] ?? '',
    );
  }

  const existingSection =
    existing.length > 0
      ? `\n## Existing Memories (do not duplicate)\n${formatExistingMemories(existing)}\n`
      : '';

  return `You are a memory extraction system. Analyze this conversation and decide what to remember, update, or delete for future conversations.

Today's date: ${new Date().toISOString().slice(0, 10)}

## Conversation
<messages>
${formatMessages(messages)}
</messages>

<latest_assistant_response>
${agentResponse.slice(-2000)}
</latest_assistant_response>
${existingSection}
## Types

- *user*: Facts about people — name, role, preferences, expertise, relationships, communication style
- *project*: Company/project info — tech stack, architecture, decisions, deadlines, what's being worked on
- *reference*: External resources — URLs, systems, credentials patterns, config details
- *feedback*: User corrections or preferences about assistant behavior

## Rules

- Only extract facts from USER messages or confirmed decisions — never from assistant output alone
- Attribute facts to the correct person — "I prefer X" said by [user] Alice means Alice prefers X, not anyone else
- Do NOT assume or infer attributes not explicitly stated (e.g., gender, age, ethnicity) — use "they" or the person's name
- Be selective — only save things useful in a future conversation
- Do NOT extract transient task details (e.g., "user asked me to fix a bug")
- When new information CONTRADICTS an existing memory, DELETE the old memory and SAVE the corrected version
- When new information REFINES an existing memory (adds detail, same direction), UPDATE it
- If a fact is already covered by an existing memory with no new information, skip it

## Actions

Reply with ONLY a JSON array (no markdown fences, no explanation):
[
  {"action": "save", "type": "user", "name": "short name", "description": "one-line why this matters", "content": "the fact"},
  {"action": "update", "id": "mem-xxx", "fields": {"content": "refined fact"}},
  {"action": "delete", "id": "mem-xxx"}
]

If nothing is worth extracting, reply with: []`;
}

function formatMessages(messages: ConversationMessage[]): string {
  return messages
    .map((m) => `[${m.role}] ${m.senderName}: ${m.content.slice(0, 500)}`)
    .join('\n')
    .slice(0, 3000);
}

function formatExistingMemories(memories: Memory[]): string {
  return memories
    .map((m) => {
      const content =
        m.content.length > MEMORY_CONTENT_PREVIEW_CHARS
          ? m.content.slice(0, MEMORY_CONTENT_PREVIEW_CHARS) + '…'
          : m.content;
      return `[${m.id}] (${m.type}) ${m.name}: ${content}`;
    })
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
          item.action === 'delete' ||
          item.action === 'skip'),
    ) as Extracted[];
  } catch {
    log.debug('Memory extraction: failed to parse Haiku JSON', { raw: raw.slice(0, 200) });
    return [];
  }
}
