import { describe, it, expect, mock, beforeEach } from 'bun:test';
import path from 'path';
import crypto from 'crypto';

// We mock 'fs' before importing the module under test. atomicWrite uses
// writeFileSync (with flag: 'wx') + linkSync to publish + unlinkSync to clean
// up the tmp file — mocks for all four are needed.
const mockWriteFileSync = mock(() => {});
const mockRenameSync = mock(() => {}); // legacy; kept for any future test that uses it
const mockMkdirSync = mock(() => {});
const mockExistsSync = mock(() => false);
const mockLinkSync = mock(() => {});
const mockUnlinkSync = mock(() => {});

mock.module('fs', () => ({
  default: {
    writeFileSync: mockWriteFileSync,
    renameSync: mockRenameSync,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
    linkSync: mockLinkSync,
    unlinkSync: mockUnlinkSync,
  },
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  linkSync: mockLinkSync,
  unlinkSync: mockUnlinkSync,
}));

import {
  createMemoryCaptureMcpHook,
  createMemoryCaptureWebFetchHook,
  createMemoryCaptureBashHook,
  MCP_CAPTURE_TOOLS,
} from './memory-capture.js';

function sha8(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

const INBOX_DIR = '/workspace/agent/sources/inbox';

beforeEach(() => {
  mockWriteFileSync.mockClear();
  mockRenameSync.mockClear();
  mockMkdirSync.mockClear();
  mockExistsSync.mockClear();
  mockLinkSync.mockClear();
  mockUnlinkSync.mockClear();
  mockExistsSync.mockImplementation(() => false);
});

describe('MCP_CAPTURE_TOOLS', () => {
  it('is a ReadonlyArray containing the original 4 tools plus Exa coverage', () => {
    const names = MCP_CAPTURE_TOOLS.map((t) => t.name);
    // The mounted Granola server is the local stdio wrapper at
    // container/agent-runner/src/granola-mcp-server.ts which exposes
    // list_meetings + get_meeting (singular). The hosted-MCP names
    // (`get_meetings` plural, `get_meeting_transcript`) are NOT mounted.
    expect(names).toContain('mcp__granola__get_meeting');
    // Authoritative Pocket tool name per docs.heypocketai.com/docs/mcp.
    // Pocket MCP exposes only transcripts (no LLM notes); see capture comment.
    expect(names).toContain('mcp__pocket__get_pocket_conversation');
    // Linear MCP is mounted as `linear` (mcpServers.linear in container-runner.ts).
    expect(names).toContain('mcp__linear__get_issue');
    expect(names).toContain('mcp__github__get_pr');
    // Exa MCP tools — content-producing research/crawl results route through
    // the same source pipeline ("fetch is the curation signal").
    expect(names).toContain('mcp__exa__crawling_exa');
    expect(names).toContain('mcp__exa__web_search_exa');
    expect(names).toContain('mcp__exa__web_search_advanced_exa');
    expect(names).toContain('mcp__exa__company_research_exa');
    expect(names).toContain('mcp__exa__people_search_exa');
    expect(names).toContain('mcp__exa__deep_researcher_check');
    expect(names).toContain('mcp__exa__get_code_context_exa');
    // 1 granola + 1 pocket + 1 linear + 1 github + 7 exa = 11
    expect(MCP_CAPTURE_TOOLS.length).toBe(11);
  });
});

describe('test_mcp_hook_writes_tmp_then_rename', () => {
  it('writes .tmp then renames to final granola-meeting-<sha8>.md', async () => {
    const hook = createMemoryCaptureMcpHook();
    // The local Granola MCP exposes get_meeting (singular); hashOf includes
    // include_transcript so notes-only and notes+transcript captures don't
    // collide on the same recording.
    const input = {
      tool_name: 'mcp__granola__get_meeting',
      tool_input: { id: 'meet-abc123' }, // include_transcript defaults to false → 'notes' suffix
      tool_response: { title: 'Standup', notes: 'hello world' },
    };

    await hook(input as Parameters<typeof hook>[0]);

    const hash = sha8('meet-abc123|notes');
    const finalPath = path.join(INBOX_DIR, `granola-meeting-${hash}.md`);
    const tmpPathPrefix = finalPath + '.';

    // atomicWrite uses a randomized tmp suffix to avoid collisions on the
    // tmp filename under concurrent writers; assert on prefix + .tmp shape
    // and final-path link, not exact temp path.
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${finalPath.replace(/[/.]/g, '\\$&')}\\.[0-9a-f]+\\.tmp$`)),
      expect.any(String),
      expect.objectContaining({ flag: 'wx' }),
    );
    expect(mockLinkSync).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${finalPath.replace(/[/.]/g, '\\$&')}\\.[0-9a-f]+\\.tmp$`)),
      finalPath,
    );
    void tmpPathPrefix;
  });
});

describe('test_mcp_hook_skips_existing_file', () => {
  it('does not write when the final file already exists', async () => {
    mockExistsSync.mockImplementation(() => true);
    const hook = createMemoryCaptureMcpHook();
    const input = {
      tool_name: 'mcp__granola__get_meeting',
      tool_input: { id: 'meet-already-exists', include_transcript: true },
      tool_response: { title: 'Old meeting' },
    };

    await hook(input as Parameters<typeof hook>[0]);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLinkSync).not.toHaveBeenCalled();
  });
});

describe('test_mcp_hook_skips_unknown_tool', () => {
  it('no-ops when matcher fires for an MCP tool not in the allowlist', async () => {
    const hook = createMemoryCaptureMcpHook();
    const input = {
      tool_name: 'mcp__unknown_server__some_tool',
      tool_input: { foo: 'bar' },
      tool_response: { result: 'whatever' },
    };

    await hook(input as Parameters<typeof hook>[0]);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLinkSync).not.toHaveBeenCalled();
  });
});

describe('test_webfetch_hook_writes_url_content', () => {
  it('writes web-<sha8>.md atomically for a WebFetch result', async () => {
    const hook = createMemoryCaptureWebFetchHook();
    const url = 'https://example.com/article';
    const content = '# Article title\nBody text here';
    const input = { tool_input: { url }, tool_response: { content } };

    await hook(input as Parameters<typeof hook>[0]);

    const hash = sha8(url);
    const finalPath = path.join(INBOX_DIR, `web-${hash}.md`);
    const tmpRe = new RegExp(`^${finalPath.replace(/[/.]/g, '\\$&')}\\.[0-9a-f]+\\.tmp$`);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(tmpRe),
      content,
      expect.objectContaining({ flag: 'wx' }),
    );
    expect(mockLinkSync).toHaveBeenCalledWith(expect.stringMatching(tmpRe), finalPath);
  });
});

describe('test_bash_hook_matches_gws_docs_read', () => {
  it('captures gws docs read command output to gws-<sha8>.md', async () => {
    const hook = createMemoryCaptureBashHook();
    const command = 'gws docs read 1abc';
    const stdout = 'Document content here';
    const input = { tool_input: { command }, tool_response: { stdout } };

    await hook(input as Parameters<typeof hook>[0]);

    const hash = sha8(command);
    const finalPath = path.join(INBOX_DIR, `gws-${hash}.md`);
    const tmpRe = new RegExp(`^${finalPath.replace(/[/.]/g, '\\$&')}\\.[0-9a-f]+\\.tmp$`);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(tmpRe),
      stdout,
      expect.objectContaining({ flag: 'wx' }),
    );
    expect(mockLinkSync).toHaveBeenCalledWith(expect.stringMatching(tmpRe), finalPath);
  });
});

describe('test_bash_hook_skips_dry_run', () => {
  it('does not write when --dry-run flag is present', async () => {
    const hook = createMemoryCaptureBashHook();
    const command = 'gws docs read 1abc --dry-run';
    const stdout = 'Would read document';
    const input = { tool_input: { command }, tool_response: { stdout } };

    await hook(input as Parameters<typeof hook>[0]);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLinkSync).not.toHaveBeenCalled();
  });
});

describe('test_bash_hook_ignores_unrelated_command', () => {
  it('does not write for unrelated bash commands', async () => {
    const hook = createMemoryCaptureBashHook();
    const command = 'ls -la';
    const stdout = 'total 0\ndrwxr-xr-x 1 root root 4096 Jan 1 00:00 .';
    const input = { tool_input: { command }, tool_response: { stdout } };

    await hook(input as Parameters<typeof hook>[0]);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLinkSync).not.toHaveBeenCalled();
  });
});
