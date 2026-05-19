/**
 * Structural assertions: projection chokepoint bidirectional.
 *
 * Verifies that:
 * 1. Only thread-search.ts queries messages_archive (no orphan queries elsewhere).
 * 2. backlog.ts retains agent_group_id filters on its own tables.
 * 3. server.ts retains agent_group_id filter for agent_group_capabilities.
 * 4. dispatch.ts has a tasks query (bounded by parent_session_id, not agent_group_id —
 *    this is intentional since projection is already scoped by parent_agent_group_id).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MCP_TOOLS_DIR = path.join(process.cwd(), 'container/agent-runner/src/mcp-tools');

function readFile(name: string): string {
  return fs.readFileSync(path.join(MCP_TOOLS_DIR, name), 'utf-8');
}

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

describe('projection chokepoint structural assertions', () => {
  it('test_no_orphan_messages_archive_queries', () => {
    // Walk all non-test .ts files under MCP_TOOLS_DIR.
    // Assert every file that mentions messages_archive is thread-search.ts.
    const files = walkTsFiles(MCP_TOOLS_DIR);
    const violators: string[] = [];
    for (const filePath of files) {
      const base = path.basename(filePath);
      if (base === 'thread-search.ts') continue; // allowed
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/messages_archive/.test(content)) {
        violators.push(base);
      }
    }
    expect(
      violators,
      `files outside thread-search.ts that query messages_archive: ${violators.join(', ')}`,
    ).toEqual([]);
  });

  it('test_backlog_queries_retain_agent_group_id_filter', () => {
    // Read backlog.ts; each db.prepare(…) call targeting backlog_items or
    // ship_log must include an agent_group_id filter.
    const content = readFile('backlog.ts');

    // Extract all SQL string literals passed to db.prepare() that reference
    // backlog_items or ship_log.
    const prepareBlocks = content.match(/\.prepare\(\s*`[\s\S]*?`\s*\)/g) ?? [];
    const targetBlocks = prepareBlocks.filter(
      (b) => /backlog_items|ship_log/.test(b),
    );

    expect(targetBlocks.length).toBeGreaterThan(0);

    for (const block of targetBlocks) {
      const hasFilter =
        /agent_group_id\s*=\s*\?/.test(block) ||
        /agent_group_id\s*=\s*\$/.test(block);
      expect(
        hasFilter,
        `backlog.ts SQL block missing agent_group_id filter:\n${block}`,
      ).toBe(true);
    }
  });

  it('test_server_orchestrator_query_retains_filter', () => {
    // Read server.ts; the query against agent_group_capabilities must include
    // WHERE agent_group_id = ?
    const content = readFile('server.ts');
    expect(content).toMatch(/WHERE\s+agent_group_id\s*=\s*\?/);
  });

  it('test_tasks_query_not_required_to_filter_by_agent_group_id', () => {
    // dispatch.ts (where the tasks/list_spawned_tasks query lives).
    // Note: tasks is bounded by the projection's parent_agent_group_id filter
    // applied at projection-build time — no in-tool agent_group_id filter needed.
    // This test just verifies the file exists and contains a tasks query.
    const content = readFile('dispatch.ts');
    expect(content).toMatch(/FROM\s+tasks/);
  });
});
