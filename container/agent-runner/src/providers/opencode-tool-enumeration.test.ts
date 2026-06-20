import { describe, it, expect } from 'bun:test';

import * as fs from 'fs';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
// SINGLE SOURCE: the Claude SDK-disallowed tool names are imported from the
// Claude provider, never copied here (D15). If that list grows, this test must
// re-check OpenCode against the new names automatically.
import { SDK_DISALLOWED_TOOLS } from './claude.js';
import type { McpServerConfig } from './types.js';

/**
 * OpenCode's built-in tool inventory, captured from the LIVE binary at the
 * version the container actually pins — **opencode@1.17.7** (container/Dockerfile
 * `ARG OPENCODE_VERSION`) — NOT from memory or the SDK types (which model the
 * tool set as a dynamic `[key: string]: boolean` map, so they don't enumerate
 * names). Keep OPENCODE_CAPTURED_VERSION below in lock-step with that ARG.
 *
 * Source of truth, reproducible (run against the PINNED version):
 *   1. `npx opencode-ai@<pinned> debug agent build|general|plan` → the `tools`
 *      object keys (per-agent enable/disable, but the NAMES are the registry).
 *   2. The running server's `GET /experimental/tool/ids` endpoint, which
 *      returns the canonical built-in tool-id array — the superset used here
 *      (it adds `websearch` + `apply_patch` over the per-agent `tools` dict).
 *
 * Re-derive with: `npx opencode-ai@<pinned> serve --port 0` + `curl $URL/experimental/tool/ids`.
 * (Verified 2026-06-19: the 1.17.7 list is identical to the prior 1.15.7 capture
 * — no built-in was added or renamed across that bump.)
 *
 * LIMITATION — this is a STATIC snapshot, not a live query (codex #126 F4).
 * Spawning a real `opencode` server in CI to enumerate tools at test time was
 * deliberately rejected as too heavy (design D13/C7), and opencode isn't an
 * agent-runner npm dep so it isn't even present in the `bun test` CI env. So
 * this list does NOT auto-detect a new built-in on an opencode UPGRADE: until
 * someone re-captures it, `test_oc_every_tool_classified` keeps checking the OLD
 * names. The mitigation is procedural and now self-checking: OPENCODE_CAPTURED_VERSION
 * is asserted against the Dockerfile `OPENCODE_VERSION` ARG below, so a version
 * bump that forgets to re-capture FAILS this test (turning a silent drift into a
 * loud one). Re-deriving the list is part of the opencode upgrade checklist.
 */
// Lock-step with container/Dockerfile `ARG OPENCODE_VERSION`. Bump BOTH together
// and re-derive OPENCODE_BUILTIN_TOOLS from the new binary (see above).
const OPENCODE_CAPTURED_VERSION = '1.17.7';
const OPENCODE_BUILTIN_TOOLS = [
  'invalid',
  'question',
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'todowrite',
  'websearch',
  'skill',
  'apply_patch',
] as const;

/** Capability classes. A tool maps to exactly one. */
type Capability =
  | 'fs-read' // read-only filesystem / search
  | 'fs-write' // mutating filesystem
  | 'shell' // arbitrary command execution (guarded by the opencode-guard plugin)
  | 'net' // outbound network (fetch/search)
  | 'planning' // todo / question / task orchestration — no external side effect
  | 'meta' // internal opencode bookkeeping (e.g. `invalid` sentinel)
  | 'denied'; // capability OpenCode must NOT expose (parity with Claude blocks)

/**
 * MINIMAL capability map: every built-in tool → a known capability class.
 * `denied` would be assigned to any tool that maps to a Claude-blocked capability
 * (the SDK_DISALLOWED_TOOLS surface: cron scheduling, plan-mode/worktree UI
 * affordances, the blocking AskUserQuestion). OpenCode exposes NONE of those as
 * built-ins, so no built-in is classified `denied` — that absence IS the parity
 * the F4 task asserts. The test FAILS if any exposed tool is unrecognized
 * (rot guard) OR classifies as `denied` (a denied-capability leak).
 */
const CAPABILITY_MAP: Record<string, Capability> = {
  invalid: 'meta',
  question: 'planning',
  bash: 'shell',
  read: 'fs-read',
  glob: 'fs-read',
  grep: 'fs-read',
  edit: 'fs-write',
  write: 'fs-write',
  task: 'planning',
  webfetch: 'net',
  todowrite: 'planning',
  websearch: 'net',
  skill: 'planning',
  apply_patch: 'fs-write',
};

/** A capability the agent must never get via a built-in (Claude-block parity). */
const DENIED_CAPABILITIES = new Set<Capability>(['denied']);

/**
 * Classify one exposed tool. Returns its capability, or null if the tool is not
 * recognized (built-in not in the map AND not a well-formed MCP tool name).
 *
 * MCP tools surface in OpenCode as `<serverName>_<toolName>` (ToolPart.tool).
 * They are known-safe by construction: NanoClaw chooses exactly which MCP servers
 * to wire (mcpServersToOpenCodeConfig), so an MCP tool routes through a
 * deliberately-exposed server, and the destructive-action guard plugin's
 * tool.execute.before hook still gates the dangerous ones. We accept any tool
 * whose prefix matches a configured server name.
 */
function classifyTool(tool: string, mcpServerNames: Set<string>): Capability | null {
  if (tool in CAPABILITY_MAP) return CAPABILITY_MAP[tool];
  for (const server of mcpServerNames) {
    if (tool === server || tool.startsWith(`${server}_`)) return 'net'; // MCP = deliberately-wired, guard-gated
  }
  return null; // unrecognized → caller fails the test
}

/**
 * The classify-or-fail gate, factored out so the live-inventory test and the
 * "prove the net catches an injected tool" test run the IDENTICAL logic. Throws
 * on the first unrecognized OR denied-capability tool; returns the per-tool
 * classification otherwise.
 */
function assertAllToolsSafe(tools: string[], mcpServerNames: Set<string>): Map<string, Capability> {
  const out = new Map<string, Capability>();
  for (const tool of tools) {
    const cap = classifyTool(tool, mcpServerNames);
    if (cap === null) {
      throw new Error(`unrecognized/unclassified tool: ${tool}`);
    }
    if (DENIED_CAPABILITIES.has(cap)) {
      throw new Error(`tool exposes a denied capability: ${tool} (${cap})`);
    }
    out.set(tool, cap);
  }
  return out;
}

/** The full set of tool names OpenCode exposes for a given MCP wiring. */
function enumerateExposedTools(mcpServers: Record<string, McpServerConfig>): {
  tools: string[];
  mcpServerNames: Set<string>;
} {
  // mcpServersToOpenCodeConfig is the exact mapping the provider uses to wire MCP
  // into the opencode config; its keys are the server names OpenCode will prefix
  // tool ids with.
  const mcpConfig = mcpServersToOpenCodeConfig(mcpServers);
  const mcpServerNames = new Set(Object.keys(mcpConfig));
  // Simulate the runtime tool surface: built-ins + one representative tool per
  // wired MCP server (real servers expose many; the naming/classification is
  // identical for all of them).
  const mcpTools = [...mcpServerNames].map((s) => `${s}_example_tool`);
  return { tools: [...OPENCODE_BUILTIN_TOOLS, ...mcpTools], mcpServerNames };
}

describe('OpenCode tool enumeration — classify-or-fail (F4)', () => {
  const MCP_SERVERS: Record<string, McpServerConfig> = {
    nanoclaw: { type: 'stdio', command: 'node', args: ['nanoclaw-mcp.js'] },
    granola: { type: 'http', url: 'https://granola.example/mcp' },
  };

  it('test_oc_snapshot_matches_pinned_dockerfile_version: the captured version tracks OPENCODE_VERSION (codex #126 F4)', () => {
    // Turn the silent drift Codex flagged into a LOUD failure: if the Dockerfile
    // bumps OPENCODE_VERSION without re-deriving OPENCODE_BUILTIN_TOOLS (and
    // bumping OPENCODE_CAPTURED_VERSION to match), this test fails — forcing the
    // re-capture rather than letting the snapshot silently lag the real binary.
    const dockerfile = fs.readFileSync(
      new URL('../../../Dockerfile', import.meta.url).pathname,
      'utf-8',
    );
    const m = dockerfile.match(/ARG\s+OPENCODE_VERSION=([\w.-]+)/);
    expect(m, 'Dockerfile must declare ARG OPENCODE_VERSION').not.toBeNull();
    expect(m![1]).toBe(OPENCODE_CAPTURED_VERSION);
  });

  it('test_oc_exposes_no_denied_builtin: none of the 9 SDK_DISALLOWED_TOOLS names appear in OpenCode built-ins', () => {
    // Absence = parity with the Claude block surface (D-D / M3). OpenCode's
    // built-ins (bash/read/glob/...) are a disjoint namespace from Claude's
    // PascalCase SDK builtins (CronCreate/EnterPlanMode/...).
    const builtins = new Set<string>(OPENCODE_BUILTIN_TOOLS);
    expect(SDK_DISALLOWED_TOOLS.length).toBe(9); // pin the expected surface size
    for (const denied of SDK_DISALLOWED_TOOLS) {
      expect(builtins.has(denied)).toBe(false);
    }
  });

  it('test_oc_every_tool_classified: every exposed tool classifies as known-safe (no unrecognized, no denied)', () => {
    const { tools, mcpServerNames } = enumerateExposedTools(MCP_SERVERS);
    expect(tools.length).toBeGreaterThan(0);
    // The gate throws on the first unsafe tool; reaching the assertion means the
    // entire live inventory (built-ins + MCP-wired) is classified known-safe.
    const classified = assertAllToolsSafe(tools, mcpServerNames);
    expect(classified.size).toBe(tools.length);
    // Every built-in is covered (no MCP tool snuck into the built-in count).
    for (const builtin of OPENCODE_BUILTIN_TOOLS) {
      expect(classified.has(builtin)).toBe(true);
    }
  });

  it('test_oc_enumeration_fails_on_unrecognized_tool: an injected unknown / denied tool makes the gate FAIL', () => {
    const { tools, mcpServerNames } = enumerateExposedTools(MCP_SERVERS);

    // 1) Unknown built-in (not in the capability map, not an MCP-prefixed name)
    //    → the SAME gate that passes the real inventory now throws on it.
    expect(() => assertAllToolsSafe([...tools, 'newfangled_builtin'], mcpServerNames)).toThrow(
      /unrecognized\/unclassified tool: newfangled_builtin/,
    );

    // 2) A tool that maps to a denied capability → caught by the denied check.
    //    Inject a name into the capability map for the duration of this check.
    CAPABILITY_MAP.pretend_denied = 'denied';
    try {
      expect(() => assertAllToolsSafe([...tools, 'pretend_denied'], mcpServerNames)).toThrow(
        /denied capability: pretend_denied/,
      );
    } finally {
      delete CAPABILITY_MAP.pretend_denied;
    }
  });

  it('test_denylist_single_source: SDK_DISALLOWED_TOOLS is imported from claude.ts (not duplicated)', () => {
    // The exact 9 Claude-disallowed names, asserted against the imported symbol.
    // This file declares no local copy — the import IS the single source. If the
    // import were removed/forked, this test would not compile or would drift.
    expect(SDK_DISALLOWED_TOOLS).toEqual([
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
    ]);
  });
});
