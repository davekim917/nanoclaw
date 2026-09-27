/**
 * Claude-format subagent (`.md` + YAML frontmatter) → Codex role TOML (`~/.codex/agents/<name>.toml`):
 *   frontmatter.name        → toml name
 *   frontmatter.description → toml description
 *   frontmatter.effort      → toml model_reasoning_effort (omitted when absent)
 *   markdown body           → toml developer_instructions (multiline `"""…"""`)
 * Dropped: `model` (Claude names; `inherit` is not a Codex id), `tools`, `color`, `proactive`.
 *
 * The role file denies unknown fields, so a misspelled key fails the WHOLE file, not just the key. An unrecognised
 * effort value is carried as a custom value; only an empty string is rejected.
 *
 * A role's effort BEATS the spawn call's `reasoning_effort` (a shim named for a level must run at it) and is
 * validated against the child model, so `worker-max` spawned onto a model without `max` fails the spawn instead of
 * silently downgrading.
 */

const MANAGED_MARKER = '# managed by nanoclaw codex-sync';

export interface ClaudeAgent {
  name: string;
  description: string;
  body: string;
  /** Both converters write it (`model_reasoning_effort` here, `options.reasoningEffort` in opencode-agent-md.ts). */
  effort?: string;
}

/** Frontmatter block and body, or null when there is no frontmatter block. */
function splitClaudeAgentMd(content: string): { frontmatter: string; body: string } | null {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const rest = normalized.slice('---\n'.length);
  const endIdx = rest.indexOf('\n---');
  if (endIdx < 0) return null;
  let bodyStart = endIdx + '\n---'.length;
  if (rest[bodyStart] === '\n') bodyStart++;
  return { frontmatter: rest.slice(0, endIdx), body: rest.slice(bodyStart) };
}

/** Null when the frontmatter is missing or lacks `name`/`description`. */
export function parseClaudeAgentMd(content: string): ClaudeAgent | null {
  const split = splitClaudeAgentMd(content);
  if (!split) return null;
  const { frontmatter: frontmatterRaw, body } = split;

  const name = extractScalar(frontmatterRaw, 'name');
  const description = extractScalar(frontmatterRaw, 'description');
  if (!name || !description) return null;
  // Blank `effort:` is absent: a converter must never emit an empty effort.
  const effortRaw = extractScalar(frontmatterRaw, 'effort')?.trim();
  const effort = effortRaw ? effortRaw : undefined;

  return { name, description, body: body.replace(/^\n+/, '').trimEnd(), ...(effort ? { effort } : {}) };
}

/**
 * Scalar value of a top-level key, handling the shapes Claude subagents use: plain, double-quoted with `\"`/`\\`/`\n`
 * escapes, and `|` block scalars. Not a YAML parser. Null when the key is missing.
 */
function extractScalar(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] !== key) continue;
    const value = m[2].trim();

    if (value === '|' || value === '|-' || value === '|+' || value === '>') {
      const collected: string[] = [];
      let indent: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j];
        if (cont.length === 0) {
          if (collected.length > 0) collected.push('');
          continue;
        }
        const leading = cont.match(/^(\s+)/);
        if (!leading) break;
        if (indent === null) indent = leading[1];
        if (!cont.startsWith(indent)) break;
        collected.push(cont.slice(indent.length));
      }
      return collected.join(value === '>' ? ' ' : '\n').trimEnd();
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      const inner = value.slice(1, -1);
      return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1);
    }
    return value;
  }
  return null;
}

/** Single-line only; throws on a newline. */
function tomlBasicString(value: string): string {
  if (value.includes('\n')) {
    throw new Error('Use tomlMultilineString for multi-line values');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escapes inner `"""` runs so the closing delimiter stays unambiguous. */
function tomlMultilineString(value: string): string {
  // Backslashes first, so the quote-splitting escapes below are not double-escaped.
  const escapedBackslashes = value.replace(/\\/g, '\\\\');
  const safe = escapedBackslashes.replace(/"""/g, '""\\"');
  return `"""\n${safe}\n"""`;
}

/** Always emits the managed-by header so the sync overwrites only its own output. */
export function formatCodexAgentToml(agent: ClaudeAgent): string {
  const lines: string[] = [
    MANAGED_MARKER,
    '',
    `name = ${tomlBasicString(agent.name)}`,
    agent.description.includes('\n')
      ? `description = ${tomlMultilineString(agent.description)}`
      : `description = ${tomlBasicString(agent.description)}`,
  ];
  // Only when the source carried one. Unusable values drop to no key rather than throw: `syncCodexSubagents` does
  // not guard this call, so a throw would abort conversion of every later role. Blank is the one value Codex
  // rejects; a block scalar would make `tomlBasicString` throw.
  const effort = agent.effort?.trim();
  if (effort && !effort.includes('\n')) {
    lines.push(`model_reasoning_effort = ${tomlBasicString(effort)}`);
  }
  lines.push(`developer_instructions = ${tomlMultilineString(agent.body)}`, '');
  return lines.join('\n');
}

/** False means a hand-written TOML: leave it alone. */
export function isManagedToml(content: string): boolean {
  return content.startsWith(MANAGED_MARKER);
}

export { MANAGED_MARKER };
