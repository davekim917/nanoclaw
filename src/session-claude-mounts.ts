/**
 * Mount list for `/home/node/.claude` in session containers: group-shared `.claude-shared/`, trunk
 * `container/skills/` (read-only, so a skill fix reaches every group at its next spawn), the per-session
 * `projects/<hash>/` (concurrent sessions sharing it race on `sessions-index.json` and lose transcripts), and the
 * workgroup memory compatibility view. Nested mounts: the order is load-bearing, most specific last.
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
 * The returned list MUST be spread into `mounts` contiguously so the nested ordering holds. The only caller of
 * `prepareSessionClaudeDir`, so a session that never wakes never gets a `.claude-projects/` dir.
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
