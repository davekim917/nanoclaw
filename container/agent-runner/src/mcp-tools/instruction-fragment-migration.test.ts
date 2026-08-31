/**
 * Acceptance criterion 3 (instruction-stack-prune plan, L2): relocation, not
 * just deletion. Retiring an always-on `.instructions.md` fragment is only
 * safe once its content actually lands somewhere an agent still sees it —
 * this test asserts the migrated markers on the registered tool definitions
 * (and the onecli-gateway skill doc) BEFORE the corresponding fragment files
 * may be deleted. See docs/specs/instruction-stack-prune/plan.md criterion 3.
 *
 * The container/CLAUDE.md tool-prose round (L3) follows the same pattern:
 * base-file prose describing TOOL behavior drifts when the tool changes, so
 * it moves into the tool's own description instead. These assertions must
 * hold BEFORE the corresponding base-file prose is removed.
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
const { continueWork, proposeDone } = await import('./work-continuation.js');
const { wait } = await import('./wait.js');
const { sendMessage, sendFile } = await import('./core.js');
const { createWorktreeTool, gitCommitTool, openPrTool } = await import('./git-worktrees.js');

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
    expect(instructionsParam.description).toContain('standing-instructions.md');
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
    const fragmentPath = path.join(
      process.cwd(),
      '..',
      '..',
      'container',
      'skills',
      'onecli-gateway',
      'instructions.md',
    );
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

describe('container/CLAUDE.md "Container lifecycle" prose migrated into the lifecycle tools (L3)', () => {
  it('continue_work description carries the persistence/resume/prose-does-nothing contract', () => {
    const description = continueWork.tool.description;
    expect(description).toMatch(/does nothing/);
    expect(description).toContain('resuming after any input that already arrived');
    expect(description).toContain('survives container and host restarts');
    expect(description).toMatch(/cancel_continuation cancels it/);
  });

  it('propose_done description carries the proposal-not-close and close-thread-message contract', () => {
    const description = proposeDone.tool.description;
    expect(description).toContain('not a close');
    expect(description).toContain('Callable only once you have delivered the result and hold no continuation');
    expect(description).toContain('asked to close this thread');
    expect(description).toMatch(/done \/ lost \/ next/);
  });

  it('wait description carries the ncl-tasks-is-for-never-ending-jobs contrast', () => {
    const description = wait.tool.description;
    expect(description).toMatch(/ncl tasks create/);
    expect(description).toContain('"never"');
    expect(description).toContain('wait loop');
  });
});

describe('container/CLAUDE.md "Working with Repos" prose migrated into the repo tools (L3)', () => {
  it('open_pr description carries the after-every-PR ship-log/backlog contract', () => {
    const description = openPrTool.tool.description;
    expect(description).toContain('add_ship_log');
    expect(description).toContain('update_backlog_item');
    expect(description).toContain('add_backlog_item');
  });

  it('git_commit description carries the sibling dirty-state and no-footer rules', () => {
    const description = gitCommitTool.tool.description;
    expect(description).toMatch(/same-topic siblings/);
    expect(description).toContain('Co-Authored-By');
    expect(description).toContain('Generated with Claude Code');
  });

  it('create_worktree description and continueFromThreadId param carry the tool-sequence and rollback guidance', () => {
    const description = createWorktreeTool.tool.description;
    expect(description).toMatch(/git_commit.*git_push.*open_pr/);
    const continueFromThreadId = createWorktreeTool.tool.inputSchema.properties.continueFromThreadId as {
      description: string;
    };
    expect(continueFromThreadId.description).toContain('ask the operator rather than recreating a branch');
  });
});

describe('container/CLAUDE.md "container path is never openable" prose migrated into send_file/send_message (L3)', () => {
  it('send_message description tells the agent to attach or excerpt instead of naming a path', () => {
    const description = sendMessage.tool.description;
    expect(description).toMatch(/means nothing to the user/);
    expect(description).toMatch(/send_file/);
  });

  it('send_file description states it is how the user actually receives a container file', () => {
    const description = sendFile.tool.description;
    expect(description).toMatch(/never openable by the user directly/);
  });
});
