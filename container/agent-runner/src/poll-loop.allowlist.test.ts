/**
 * Group G — file-event allowlist for the workgroup shared tree.
 *
 * The poll loop watches for agent-produced files and only forwards ones under a
 * fixed prefix set (FILE_EVENT_ALLOWED_PREFIXES). With workgroup shared-FS,
 * collaborative artifacts live under /workspace/workgroup, so that prefix must
 * be allowed too. isAllowedFileEventPath is the boundary; assert it directly.
 *
 * Importing poll-loop.ts pulls in the db/connection module (bun:sqlite), which
 * is fine under bun:test — these assertions are pure and touch no DB.
 */
import { describe, test, expect } from 'bun:test';

import { isAllowedFileEventPath } from './poll-loop.js';

describe('isAllowedFileEventPath (Group G — workgroup shared tree)', () => {
  test('test_file_event_allows_workgroup: true for /workspace/workgroup/<x>', () => {
    expect(isAllowedFileEventPath('/workspace/workgroup/repos/svc/out.png')).toBe(true);
    // Boundary-exact (the dir itself) is allowed, matching the other prefixes.
    expect(isAllowedFileEventPath('/workspace/workgroup')).toBe(true);
    // Existing prefixes still allowed — no regression.
    expect(isAllowedFileEventPath('/workspace/agent/x.txt')).toBe(true);
    expect(isAllowedFileEventPath('/workspace/worktrees/svc/y.txt')).toBe(true);
    expect(isAllowedFileEventPath('/home/node/.codex/generated_images/a.png')).toBe(true);
  });

  test('test_file_event_rejects_outside: false for an unlisted path', () => {
    expect(isAllowedFileEventPath('/etc/passwd')).toBe(false);
    expect(isAllowedFileEventPath('/workspace/secrets/key.pem')).toBe(false);
    // Boundary check: a sibling dir sharing a prefix string must NOT match
    // (the impl uses a path-separator boundary, not bare startsWith).
    expect(isAllowedFileEventPath('/workspace/workgroup-evil/x')).toBe(false);
    expect(isAllowedFileEventPath('/workspace/agentXYZ/x')).toBe(false);
  });
});
