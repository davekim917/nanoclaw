/**
 * Mount list for `/home/node/.claude` inside per-session agent containers.
 *
 * Four nested bind mounts, ordered by specificity. Docker applies mount
 * rules in the order they appear and more-specific paths override less-
 * specific ones, so this ordering is load-bearing — do not reshuffle:
 *
 *   1. Group-shared parent `.claude-shared/` → `/home/node/.claude`
 *      Keeps agents, settings.json, plugins, statsig, and shell-snapshots
 *      group-scoped (initialized once by initGroupFilesystem, read-mostly
 *      at runtime, races are benign).
 *
 *   2. Trunk skills `container/skills/` → `/home/node/.claude/skills` (ro)
 *      Container skills are framework-provided and identical across every
 *      group. Mounting trunk directly removes the per-group drift problem —
 *      a trunk fix to a skill reaches every group on its next container
 *      spawn, instead of being permanently stuck at whatever trunk looked
 *      like when the group was first initialized.
 *
 *   3. Per-session `projects/<hash>/` → `/home/node/.claude/projects/<hash>/`
 *      Isolates the SDK's active-session state: `<session_id>.jsonl`
 *      transcripts and `sessions-index.json`. Without this, concurrent
 *      sessions in the same agent group race on `sessions-index.json` and
 *      can silently lose transcripts, causing the next `resume` to start a
 *      fresh Claude session instead of reloading prior context.
 *
 *   4. Group-shared `memory/` → `/home/node/.claude/projects/<hash>/memory`
 *      Overlays the SDK's auto-memory path inside the per-session projects
 *      mount so auto-memory stays group-shared across every thread. Matches
 *      v1's nested-mount pattern (v1 container-runner.ts:1935-1945).
 */
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import {
  CLAUDE_CODE_PROJECTS_DIR,
  groupClaudeMemoryDir,
  prepareSessionClaudeDir,
  sessionClaudeProjectsDir,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

/**
 * Build the ordered mount triple for this session's `/home/node/.claude`.
 * Call this once at mount-list construction; the returned list MUST be
 * spread into `mounts` contiguously so the nested-mount ordering holds.
 *
 * Ensures `prepareSessionClaudeDir` ran for this session — idempotent and
 * cheap, so calling on every wake is fine and also covers sessions that
 * predate the per-session layout (they never went through `initSessionFolder`
 * on the new code path and need their shared-dir transcripts migrated).
 */
export function getSessionClaudeMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {
  prepareSessionClaudeDir(agentGroup.id, session.id);
  const parent = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  const trunkSkills = path.resolve(GROUPS_DIR, '..', 'container', 'skills');
  return [
    { hostPath: parent, containerPath: '/home/node/.claude', readonly: false },
    { hostPath: trunkSkills, containerPath: '/home/node/.claude/skills', readonly: true },
    {
      hostPath: sessionClaudeProjectsDir(agentGroup.id, session.id),
      containerPath: `/home/node/.claude/projects/${CLAUDE_CODE_PROJECTS_DIR}`,
      readonly: false,
    },
    {
      hostPath: groupClaudeMemoryDir(agentGroup.id),
      containerPath: `/home/node/.claude/projects/${CLAUDE_CODE_PROJECTS_DIR}/memory`,
      readonly: false,
    },
  ];
}
