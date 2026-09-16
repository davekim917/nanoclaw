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
 *   frontmatter.effort      → options.reasoningEffort (omitted when absent)
 *   markdown body           → body (unchanged)
 *
 * Why `options.reasoningEffort` and not a top-level `reasoningEffort:`. Both
 * land in the same place, and the placement here is the explicit one. OpenCode
 * decodes an agent `.md`'s frontmatter with its v1 agent schema: the schema is
 * a `Schema.StructWithRest(..., [Schema.Record(Schema.String, Schema.Any)])`,
 * so unknown keys are accepted, and its `normalize` folds every key outside
 * `KNOWN_KEYS` into `options` — which `KNOWN_KEYS` itself lists, so an explicit
 * `options:` map is merged rather than overwritten
 * (`packages/core/src/v1/config/agent.ts` at sst/opencode v1.18.29, the version
 * installed on this host; the markdown path that feeds it is
 * `packages/opencode/src/config/agent.ts:load`, which spreads `md.data` into
 * the decoded config). `options` is passed to the provider as model options
 * (https://opencode.ai/docs/agents/, "Additional"). Writing the key under
 * `options` therefore cannot be captured by a future top-level field of the
 * same name.
 *
 * `reasoningEffort` is a PROVIDER-SPECIFIC option — it is the OpenAI-family
 * spelling. A provider that does not know it ignores it; this converter does
 * not try to translate per provider, because the sync has no idea which
 * provider a given OpenCode sibling is pointed at.
 *
 * Dropped (no OpenCode equivalent or runtime-specific):
 *   frontmatter.model       — Claude model names, and `inherit` is not one.
 *                              OpenCode inherits the parent's model when the
 *                              key is unset, which is what the delegation
 *                              shims want, so it is never written.
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
  const lines: string[] = ['---', MANAGED_MARKER, `description: ${yamlScalar(agent.description)}`, 'mode: subagent'];
  if (agent.effort) {
    // ALWAYS double-quoted, never `yamlScalar`: that helper emits a folded
    // BLOCK scalar for a multi-line value, at a fixed two-space indent that is
    // correct at the top level and wrong one level in — it would close the
    // `options:` map instead of nesting under it. An effort is a bare word
    // ("low" … "max") so this never fires in practice, but a malformed
    // frontmatter block is not a loud failure: OpenCode's markdown loader
    // SKIPS a file whose frontmatter won't parse (`ConfigMarkdown.parse(item)
    // .catch(() => undefined)` then `continue`, packages/opencode/src/config/
    // agent.ts:load), so the agent would vanish with no error anywhere.
    lines.push('options:', `  reasoningEffort: ${doubleQuotedYaml(agent.effort)}`);
  }
  lines.push('---');
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
 * A YAML double-quoted scalar, on ONE line whatever the input. Newlines, tabs
 * and carriage returns become their escape sequences, so the value can never
 * break out of a nested map's indentation the way a block scalar would.
 */
function doubleQuotedYaml(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
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
