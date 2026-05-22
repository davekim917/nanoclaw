/**
 * Claude-format subagent (`.md` with YAML frontmatter) → OpenCode agent
 * (also `.md` with YAML frontmatter, but with OpenCode-specific keys) converter.
 *
 * OpenCode's `opencode agent create` writes agents as Markdown files at
 * `<root>/agents/<name>.md`. The YAML frontmatter requires `description` and
 * `mode: subagent` and optionally a `permission:` deny-list. The body becomes
 * the agent's system prompt. OpenCode discovers agents from `$XDG_CONFIG_HOME/
 * opencode/agent/` (singular `agent` AND plural `agents` both work — verified
 * empirically against opencode-ai@1.15.7).
 *
 * Mapping (mechanical, no semantic translation):
 *   frontmatter.name        → file basename (already implicit in path)
 *   frontmatter.description → frontmatter.description (folded if multi-line)
 *   markdown body           → body (unchanged)
 *
 * Dropped (no OpenCode equivalent or runtime-specific):
 *   frontmatter.model       — Claude model names; let OpenCode inherit
 *   frontmatter.tools       — Claude allow-list; OpenCode uses deny-list with
 *                              different tool names. Let OpenCode inherit.
 *   frontmatter.color       — Claude UI only
 *   frontmatter.proactive   — Claude routing hint
 *
 * Always emits `mode: subagent` (we only sync subagents — primary agents are
 * harness-specific). Managed marker is a YAML comment `# managed by nanoclaw
 * opencode-sync` so the sync layer can identify its own output (and leave
 * hand-authored .md files alone).
 */
import type { ClaudeAgent } from './claude-agent-md.js';

const MANAGED_MARKER = '# managed by nanoclaw opencode-sync';

/**
 * Render a Claude-format subagent as an OpenCode agent .md file. Always emits
 * the managed-by header so the sync layer can identify and overwrite its own
 * output (and leave manually-authored .md files alone).
 */
export function formatOpenCodeAgentMd(agent: ClaudeAgent): string {
  const lines: string[] = [
    '---',
    MANAGED_MARKER,
    `description: ${yamlScalar(agent.description)}`,
    'mode: subagent',
    '---',
  ];
  // Body ends without trailing newline from the parser; add one so the file
  // ends with `\n` like every other text file.
  return `${lines.join('\n')}\n${agent.body.trimEnd()}\n`;
}

/**
 * True when an existing .md file was written by this sync (so we can safely
 * overwrite). False means a user wrote it by hand — leave alone.
 */
export function isManagedOpenCodeAgent(content: string): boolean {
  // Match either Unix or Windows line endings to match the parser's
  // normalization tolerance.
  return content.startsWith(`---\n${MANAGED_MARKER}\n`) || content.startsWith(`---\r\n${MANAGED_MARKER}\r\n`);
}

/**
 * Render a value as a YAML scalar. Picks the shape based on content:
 *   - single-line, no special chars → plain
 *   - single-line with quotes / colons / special chars → double-quoted with escapes
 *   - multi-line → folded block scalar (`>-` for chomped trailing newline)
 *
 * Not a full YAML emitter — covers the shapes we actually need for description
 * fields, which is the only multi-line value we produce.
 */
function yamlScalar(value: string): string {
  if (value.includes('\n')) {
    // Folded block scalar — `>-` strips trailing newlines (matches opencode's
    // emitted format observed via `opencode agent create`).
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `>-\n${indented}`;
  }
  // Plain scalar is safe when no YAML-special chars at the start and no `: `
  // separator in the value. Otherwise quote.
  const needsQuoting = /^[!&*?|>%@`]/.test(value) || /:\s|\s#/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export { MANAGED_MARKER };
