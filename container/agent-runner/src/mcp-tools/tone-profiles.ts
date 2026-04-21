/**
 * Tone Profile MCP tools (Phase 5.1).
 *
 * Agents read profiles from /workspace/tone-profiles/ (mounted RO by
 * the host in Phase 5.0-C). `writing-rules.md` is appended to every
 * profile so the universal banned-vocabulary / structural rules travel
 * with any tone load.
 *
 * Usage pattern: agent's CLAUDE.md declares a default tone; agent calls
 * `get_tone_profile` before drafting any written content. Ad-hoc
 * overrides (e.g. "respond in a pirate voice") work by passing any
 * name — unknown names return an instruction to interpret ad-hoc.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const TONE_PROFILES_DIR = '/workspace/tone-profiles';
const WRITING_RULES_FILE = 'writing-rules.md';
const SELECTION_GUIDE_FILE = 'selection-guide.md';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export const getToneProfileTool: McpToolDefinition = {
  tool: {
    name: 'get_tone_profile',
    description:
      'Load a specific tone profile for a one-off override. The session\'s default tone is already injected into your system prompt at spawn time — you do NOT need to call this for every response. ONLY call this when: (a) the user explicitly asks for a different tone ("use professional tone", "make this medieval"), or (b) you need the writing-rules file for a long-form drafting task that benefits from an explicit refresher.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Tone profile name (e.g. "professional", "engineering", "direct", "assistant"). Unknown names fall back to ad-hoc interpretation.',
        },
      },
      required: ['name'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) return ok('Error: name is required');

    const profilePath = path.join(TONE_PROFILES_DIR, `${name}.md`);
    if (fs.existsSync(profilePath)) {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const rulesPath = path.join(TONE_PROFILES_DIR, WRITING_RULES_FILE);
      const rules = fs.existsSync(rulesPath)
        ? '\n\n---\n\n' + fs.readFileSync(rulesPath, 'utf-8')
        : '';
      return ok(content + rules);
    }

    return ok(
      `No saved profile for "${name}". Interpret "${name}" as an ad-hoc style hint for this response. If this tone is used repeatedly, suggest creating a profile with /add-tone-profile.`,
    );
  },
};

export const listToneProfilesTool: McpToolDefinition = {
  tool: {
    name: 'list_tone_profiles',
    description:
      'List all available saved tone profiles. Also returns the selection-guide, which maps recipient/context to the recommended profile.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  handler: async () => {
    if (!fs.existsSync(TONE_PROFILES_DIR)) {
      return ok('No tone profiles directory mounted.');
    }
    const files = fs.readdirSync(TONE_PROFILES_DIR)
      .filter((f) => f.endsWith('.md') && f !== WRITING_RULES_FILE && f !== SELECTION_GUIDE_FILE);
    const profiles = files.map((f) => f.replace('.md', ''));

    const selectionGuidePath = path.join(TONE_PROFILES_DIR, SELECTION_GUIDE_FILE);
    const selectionGuide = fs.existsSync(selectionGuidePath)
      ? '\n\n---\n\n' + fs.readFileSync(selectionGuidePath, 'utf-8')
      : '';

    const list = profiles.length > 0
      ? `Available tone profiles: ${profiles.join(', ')}`
      : 'No saved tone profiles.';
    return ok(list + selectionGuide);
  },
};

export const toneProfileTools: McpToolDefinition[] = [getToneProfileTool, listToneProfilesTool];

registerTools(toneProfileTools);
