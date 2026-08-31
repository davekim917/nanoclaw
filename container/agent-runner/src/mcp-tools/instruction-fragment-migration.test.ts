/**
 * Acceptance criterion 3 (instruction-stack-prune plan, L2): relocation, not
 * just deletion. Retiring an always-on `.instructions.md` fragment is only
 * safe once its content actually lands somewhere an agent still sees it —
 * this test asserts the migrated markers on the registered tool definitions
 * (and the onecli-gateway skill doc) BEFORE the corresponding fragment files
 * may be deleted. See docs/specs/instruction-stack-prune/plan.md criterion 3.
 */
import { describe, it, expect, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';

mock.module('./server.js', () => ({
  registerTools: (_tools: unknown) => {}, // no-op — this file only inspects tool definitions
}));

// Side-effect imports register each tool via registerTools() above.
const { createAgent } = await import('./agents.js');
const { installPackages, addMcpServer } = await import('./self-mod.js');

describe('agents.instructions.md content migrated into create_agent', () => {
  it('description carries the destination contract and persistent-workspace guidance', () => {
    const description = createAgent.tool.description;
    // Destination contract — bidirectional send_message addressing.
    expect(description).toMatch(/destination/i);
    // Persistent workspace — a full standalone agent, not a stateless sub-query.
    expect(description).toContain('own container, workspace, and persistent memory');
    // Companions-vs-collaborators framing.
    expect(description.toLowerCase()).toContain('companion');
    expect(description.toLowerCase()).toContain('collaborator');
    // When-NOT-to-use guidance.
    expect(description).toMatch(/Do NOT use it for a one-off lookup/);
    // Fire-and-forget semantics.
    expect(description.toLowerCase()).toContain('fire-and-forget');
  });

  it('instructions param description carries what to write into it', () => {
    const instructionsParam = createAgent.tool.inputSchema.properties.instructions as { description: string };
    expect(instructionsParam.description).toContain('instructions.prepend.md');
    expect(instructionsParam.description).toMatch(/role/i);
  });
});

describe('self-mod.instructions.md content migrated into install_packages / add_mcp_server', () => {
  it('install_packages description carries the apt-vs-npm / persistence framing', () => {
    const description = installPackages.tool.description;
    expect(description).toContain('persist for all future turns');
    expect(description).toMatch(/pnpm install/);
  });

  it('add_mcp_server description carries the onecli-managed credential-placeholder rule', () => {
    const description = addMcpServer.tool.description;
    expect(description).toContain('"onecli-managed"');
    expect(description).toMatch(/credential/i);
    expect(description).toMatch(/never ask the user for credentials|fabricate/i);
  });
});

describe('onecli-gateway/instructions.md content merged into SKILL.md', () => {
  const skillPath = path.join(process.cwd(), '..', '..', 'container', 'skills', 'onecli-gateway', 'SKILL.md');

  it('the always-on fragment file is gone', () => {
    const fragmentPath = path.join(process.cwd(), '..', '..', 'container', 'skills', 'onecli-gateway', 'instructions.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);
  });

  it('SKILL.md description carries the 401/403 connect_url display contract', () => {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = raw.split('---')[1] ?? '';
    expect(frontmatter).toMatch(/401/);
    expect(frontmatter).toMatch(/403/);
    expect(frontmatter).toContain('connect_url');
  });

  it('SKILL.md body still carries the bare-URL display rule', () => {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    expect(raw).toMatch(/bare URL/i);
  });
});
