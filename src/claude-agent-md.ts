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
 *   markdown body           → toml developer_instructions (multiline `"""…"""`)
 *
 * Model tiering (`CODEX_WORKER_TIERS`): the tiered `worker*` defs exist to put
 * cheap work on a cheap model, and that intent does not survive a name-only
 * copy — a Codex role with no `model` silently inherits the parent's, so every
 * "tier" resolves to the same model while its description still claims
 * otherwise. Named workers therefore get an explicit Codex model + reasoning
 * effort, and their trailing "Runs on <Claude model>" sentence is rewritten to
 * name the Codex one. Unmapped agents keep the old inherit-from-parent
 * behavior, which is correct for roles that aren't tiers (codex-rescue, etc).
 *
 * Dropped (no Codex equivalent or runtime-specific):
 *   frontmatter.model       — Claude model names differ; Codex model comes
 *                              from CODEX_WORKER_TIERS, not from frontmatter
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
}

export interface CodexWorkerTier {
  model: string;
  effort: string;
}

/**
 * Codex equivalents of the tiered Claude workers. Cheaper models carry a
 * higher reasoning effort to compensate. worker-high matches the parent's
 * own model at high effort — escalating from worker there buys reasoning
 * depth rather than a bigger model. worker-frontier is the top rung: same
 * model as worker-high, pushed to max effort, for frontier-hard work or
 * after worker-high has failed. Only tiers belong here — a role that is a
 * *kind* of worker rather than a rung (worker-codex, codex-rescue) is left
 * to inherit.
 */
export const CODEX_WORKER_TIERS: Record<string, CodexWorkerTier> = {
  'worker-fast': { model: 'gpt-5.6-luna', effort: 'max' },
  worker: { model: 'gpt-5.6-terra', effort: 'xhigh' },
  'worker-high': { model: 'gpt-5.6-sol', effort: 'high' },
  'worker-frontier': { model: 'gpt-5.6-sol', effort: 'max' },
};

/**
 * Parse a Claude subagent `.md` file's text content. Returns null when the
 * frontmatter is missing or doesn't have the required `name`/`description`.
 */
export function parseClaudeAgentMd(content: string): ClaudeAgent | null {
  // Normalize line endings up front. The parser is line-oriented, and any
  // stray `\r` in a value or scalar key would otherwise fail the regex
  // matchers below and the trailing-`\r` in the frontmatter content would
  // make scalar values fail equality assertions.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const rest = normalized.slice('---\n'.length);
  const endIdx = rest.indexOf('\n---');
  if (endIdx < 0) return null;
  const frontmatterRaw = rest.slice(0, endIdx);
  // Skip past the closing `---` and the line break that follows it.
  let bodyStart = endIdx + '\n---'.length;
  if (rest[bodyStart] === '\n') bodyStart++;
  const body = rest.slice(bodyStart);

  const name = extractScalar(frontmatterRaw, 'name');
  const description = extractScalar(frontmatterRaw, 'description');
  if (!name || !description) return null;

  // Drop leading blank lines from the body — Claude's `.md` convention puts
  // a blank line between the closing `---` and the first prose line, and
  // forwarding that blank into developer_instructions would just confuse
  // the model with a leading empty paragraph.
  return { name, description, body: body.replace(/^\n+/, '').trimEnd() };
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
function extractScalar(frontmatter: string, key: string): string | null {
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
  const tier = CODEX_WORKER_TIERS[agent.name];
  const description = tier ? retargetRunsOnSentence(agent.description, tier) : agent.description;
  const lines: string[] = [
    MANAGED_MARKER,
    '',
    `name = ${tomlBasicString(agent.name)}`,
    // Description can contain literal newlines (Claude's frontmatter often
    // packs multi-line "Examples" lists in description). Single-line basic
    // strings can't carry newlines, so pick multiline when needed.
    description.includes('\n')
      ? `description = ${tomlMultilineString(description)}`
      : `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(agent.body)}`,
  ];
  if (tier) {
    lines.push(`model = ${tomlBasicString(tier.model)}`);
    lines.push(`model_reasoning_effort = ${tomlBasicString(tier.effort)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Replace the Claude-model claim that ends a tiered worker's description
 * ("Runs on Sonnet at xhigh effort.") with the Codex model it actually runs
 * on. Left alone when the sentence isn't there — the description is a routing
 * signal, so a wrong model name in it actively mis-routes the orchestrator.
 *
 * Matches up to the LAST period on the description's final line, not the
 * first — a model name with a version number ("Fable 5.1") contains its own
 * period, and `[^.]*` would stop there and leave the clause unstripped.
 */
function retargetRunsOnSentence(description: string, tier: CodexWorkerTier): string {
  const stripped = description.replace(/\s*Runs on [^\n]*\.\s*$/, '');
  return `${stripped} Runs on ${tier.model} at ${tier.effort} reasoning.`;
}

/**
 * True when an existing TOML file was written by this sync (so we can
 * safely overwrite). False means a user wrote it by hand — leave alone.
 */
export function isManagedToml(content: string): boolean {
  return content.startsWith(MANAGED_MARKER);
}

export { MANAGED_MARKER };
