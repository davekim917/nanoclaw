/**
 * Claude-format subagent `.md` → OpenCode agent `.md` converter. Always emits `mode: subagent`; `model`, `tools`,
 * `color` and `proactive` are dropped (OpenCode inherits the parent's model when `model` is unset).
 *
 * Effort goes under `options.reasoningEffort`, not `variant:`: OpenCode resolves an agent's `variant` only when
 * the agent names its own `model:`, which these shims deliberately don't, so `variant` would be dropped silently.
 * `reasoningEffort` is the OpenAI-family spelling, passed through unvalidated: a provider that knows the key can
 * reject an out-of-range value (a loud failure on one shim, preferred over silently dropping the effort).
 */
import type { ClaudeAgent } from './claude-agent-md.js';

const MANAGED_MARKER = '# managed by nanoclaw opencode-sync';

export function formatOpenCodeAgentMd(agent: ClaudeAgent): string {
  const lines: string[] = ['---', MANAGED_MARKER, `description: ${yamlScalar(agent.description)}`, 'mode: subagent'];
  if (agent.effort) {
    // Always double-quoted, never `yamlScalar`: its block scalar would close the `options:` map, and OpenCode
    // silently skips an agent whose frontmatter won't parse.
    lines.push('options:', `  reasoningEffort: ${doubleQuotedYaml(agent.effort)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${agent.body.trimEnd()}\n`;
}

/** False means a user wrote the file by hand: leave it alone. */
export function isManagedOpenCodeAgent(content: string): boolean {
  return content.startsWith(`---\n${MANAGED_MARKER}\n`) || content.startsWith(`---\r\n${MANAGED_MARKER}\r\n`);
}

/** A YAML double-quoted scalar, always on one line, so it can't break out of a nested map's indentation. */
function doubleQuotedYaml(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Not a full YAML emitter: covers top-level description values only (block scalar indent is fixed). */
function yamlScalar(value: string): string {
  if (value.includes('\n')) {
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `>-\n${indented}`;
  }
  const needsQuoting = /^[!&*?|>%@`]/.test(value) || /:\s|\s#/.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
