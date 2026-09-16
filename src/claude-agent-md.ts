/**
 * Claude-format subagent (`.md` with YAML frontmatter) → Codex TOML converter.
 *
 * Claude bootstraps subagent files as `agents/<name>.md` with YAML frontmatter
 * carrying `name`, `description`, optional `model`/`tools`/`color`, then a
 * markdown body that becomes the subagent's system prompt. Codex's app-server
 * reads `~/.codex/agents/<name>.toml` with required fields `name`,
 * `description`, `developer_instructions` (the body) and optional
 * `model`/`model_reasoning_effort`/`sandbox_mode`/`mcp_servers`/`skills.config`.
 *
 * Mapping (mechanical, no semantic translation):
 *   frontmatter.name        → toml name
 *   frontmatter.description → toml description
 *   frontmatter.effort      → toml model_reasoning_effort (omitted when absent)
 *   markdown body           → toml developer_instructions (multiline `"""…"""`)
 *
 * Every converted role inherits its parent's model. No name carries a
 * provider-specific model pin any more: the one that did (`worker-frontier`,
 * via `CODEX_WORKER_MODELS`) was deleted along with the bootstrap worker-policy
 * file it was rendered from. Delegation picks a reasoning effort, not a model —
 * hence the `effort` mapping above.
 *
 * Why `model_reasoning_effort` is the key, and why writing it is safe: a role
 * file deserializes as `RawAgentRoleFileToml`, whose non-role fields are
 * `#[serde(flatten)]`ed into `ConfigToml` (codex-rs 0.154.0
 * `agent-roles/src/agent_role_config.rs:20-28`) — the same flatten that carries
 * `developer_instructions`. `model_reasoning_effort: Option<ReasoningEffort>`
 * is a top-level `ConfigToml` field (`config/src/config_toml.rs:371`), so it
 * belongs at the top level of the role TOML, beside the keys we already write.
 * That struct is `#[serde(deny_unknown_fields)]`, so a misspelled key would
 * fail the WHOLE file to parse — which is why the name is cited rather than
 * assumed. `ReasoningEffort`'s `FromStr` maps the nine known spellings
 * (none/minimal/low/medium/high/xhigh/max/ultra/persistent) and turns any other
 * non-empty string into `Custom(String)` rather than an error
 * (`protocol/src/openai_models.rs:137-155`), so an unrecognised frontmatter
 * effort degrades to a value Codex carries, not a file it rejects. The empty
 * string is that impl's only hard error; `parseClaudeAgentMd` already folds a
 * blank `effort:` to absent, and the emitter re-checks before writing.
 *
 * Without this key a role runs at the GLOBAL
 * `[agents].default_subagent_reasoning_effort` (`src/providers/codex.ts`) — how
 * all five `worker-{low,medium,high,xhigh,max}` shims came to run at `high`
 * while each description, a routing signal Codex's orchestrator reads,
 * advertised a different level. A native `spawn_agent`'s own `reasoning_effort`
 * still overrides this per task.
 *
 * Dropped (no Codex equivalent or runtime-specific):
 *   frontmatter.model       — Claude model names differ, and `inherit` (what
 *                              the delegation shims carry) is not a Codex id
 *   frontmatter.tools       — Claude tool-restriction model; Codex uses
 *                              mcp_servers / skills.config at a coarser level
 *   frontmatter.color       — Claude UI only
 *   frontmatter.proactive   — Claude routing hint
 */

const MANAGED_MARKER = '# managed by nanoclaw codex-sync';

export interface ClaudeAgent {
  name: string;
  description: string;
  body: string;
  /**
   * The `effort:` frontmatter scalar when the source carries one, else
   * undefined. Both converters write it — `model_reasoning_effort` here,
   * `options.reasoningEffort` in opencode-agent-md.ts.
   */
  effort?: string;
}

/**
 * Slice a Claude subagent `.md` into its frontmatter block and its body.
 * Returns null when there is no frontmatter block at all.
 *
 * Exported because callers need the frontmatter itself, not just the fields
 * `parseClaudeAgentMd` keeps — `model:` in particular, which no converter
 * writes.
 */
export function splitClaudeAgentMd(content: string): { frontmatter: string; body: string } | null {
  // Normalize line endings up front. The parser is line-oriented, and any
  // stray `\r` in a value or scalar key would otherwise fail the regex
  // matchers below and the trailing-`\r` in the frontmatter content would
  // make scalar values fail equality assertions.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const rest = normalized.slice('---\n'.length);
  const endIdx = rest.indexOf('\n---');
  if (endIdx < 0) return null;
  // Skip past the closing `---` and the line break that follows it.
  let bodyStart = endIdx + '\n---'.length;
  if (rest[bodyStart] === '\n') bodyStart++;
  return { frontmatter: rest.slice(0, endIdx), body: rest.slice(bodyStart) };
}

/**
 * Parse a Claude subagent `.md` file's text content. Returns null when the
 * frontmatter is missing or doesn't have the required `name`/`description`.
 */
export function parseClaudeAgentMd(content: string): ClaudeAgent | null {
  const split = splitClaudeAgentMd(content);
  if (!split) return null;
  const { frontmatter: frontmatterRaw, body } = split;

  const name = extractScalar(frontmatterRaw, 'name');
  const description = extractScalar(frontmatterRaw, 'description');
  if (!name || !description) return null;
  // Optional. An empty or whitespace-only `effort:` is the same as absent —
  // a converter must never emit `reasoningEffort: ""` to a provider.
  const effortRaw = extractScalar(frontmatterRaw, 'effort')?.trim();
  const effort = effortRaw ? effortRaw : undefined;

  // Drop leading blank lines from the body — Claude's `.md` convention puts
  // a blank line between the closing `---` and the first prose line, and
  // forwarding that blank into developer_instructions would just confuse
  // the model with a leading empty paragraph.
  return { name, description, body: body.replace(/^\n+/, '').trimEnd(), ...(effort ? { effort } : {}) };
}

/**
 * Pull a scalar value from YAML-like frontmatter. Handles three shapes
 * Claude subagents use in practice:
 *   key: plain-value
 *   key: "double-quoted with \"escapes\" and \n literal newlines"
 *   key: |
 *     folded
 *     block
 *
 * NOT a full YAML parser — we only need scalars on the top-level keys we
 * care about. Returns the raw scalar with quotes unwrapped and escape
 * sequences resolved; null when the key is missing.
 */
export function extractScalar(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] !== key) continue;
    const value = m[2].trim();

    // Folded block scalar: `key: |` then indented lines below.
    if (value === '|' || value === '|-' || value === '|+' || value === '>') {
      const collected: string[] = [];
      // Find the indent of the first continuation line.
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
      // Double-quoted: handle \" \\ \n escapes.
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

/**
 * TOML basic string (double-quoted, single line). Rejects newlines — use
 * `tomlMultilineString` when the value can be multi-line.
 */
function tomlBasicString(value: string): string {
  if (value.includes('\n')) {
    throw new Error('Use tomlMultilineString for multi-line values');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * TOML multi-line basic string (`"""…"""`). Escapes any inner `"""` runs
 * to keep the closing delimiter unambiguous. Trailing newline before the
 * close is fine and preferred by spec.
 */
function tomlMultilineString(value: string): string {
  // Escape backslashes first to avoid double-escaping the closing-delimiter
  // sentinel we inject below. Then split runs of three or more quotes so
  // none of them collide with the TOML delimiter.
  const escapedBackslashes = value.replace(/\\/g, '\\\\');
  const safe = escapedBackslashes.replace(/"""/g, '""\\"');
  return `"""\n${safe}\n"""`;
}

/**
 * Render a Claude-format subagent as a Codex TOML file. Always emits the
 * managed-by header so the sync layer can identify and overwrite its own
 * output (and leave manually-authored TOMLs alone).
 */
export function formatCodexAgentToml(agent: ClaudeAgent): string {
  const lines: string[] = [
    MANAGED_MARKER,
    '',
    `name = ${tomlBasicString(agent.name)}`,
    // Description can contain literal newlines (Claude's frontmatter often
    // packs multi-line "Examples" lists in description). Single-line basic
    // strings can't carry newlines, so pick multiline when needed.
    agent.description.includes('\n')
      ? `description = ${tomlMultilineString(agent.description)}`
      : `description = ${tomlBasicString(agent.description)}`,
  ];
  // Only when the source frontmatter actually carried one: a role already
  // converted without `effort:` must keep running at Codex's global subagent
  // default, not acquire a pin this sync invented. The `.trim()` guard makes an
  // effort that is present-but-blank behave as absent for a caller that built
  // the ClaudeAgent by hand rather than through `parseClaudeAgentMd` — an empty
  // `model_reasoning_effort` is the one value `ReasoningEffort::from_str`
  // rejects outright (see the module note), which would fail the whole file.
  if (agent.effort?.trim()) {
    lines.push(`model_reasoning_effort = ${tomlBasicString(agent.effort.trim())}`);
  }
  lines.push(`developer_instructions = ${tomlMultilineString(agent.body)}`, '');
  return lines.join('\n');
}

/**
 * True when an existing TOML file was written by this sync (so we can
 * safely overwrite). False means a user wrote it by hand — leave alone.
 */
export function isManagedToml(content: string): boolean {
  return content.startsWith(MANAGED_MARKER);
}

export { MANAGED_MARKER };
