/**
 * A Codex container reports the account it just rotated away from at its quota wall. The reported path is one of
 * the reporting group's own mounts; it is mapped to the host account so sibling groups sharing that account skip it.
 */

import { codexAccountRing, markCodexAccountExhausted } from '../../codex-accounts.js';
import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function handleCodexAccountExhausted(content: Record<string, unknown>, session: Session): Promise<void> {
  const home = typeof content.home === 'string' ? content.home : null;
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!home || !agentGroup) return;

  const containerConfig = readContainerConfig(agentGroup.folder);
  const account = codexAccountRing(agentGroup.folder, containerConfig.codexAuthFallbacks).find(
    (entry) => entry.containerPath === home,
  );
  if (!account) {
    log.warn('codex_account_exhausted: rejected — not one of this group Codex accounts', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      home,
    });
    return;
  }
  markCodexAccountExhausted(account.hostHome);
  log.warn('Codex account at its quota — new containers start on the next account for an hour', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    hostHome: account.hostHome,
  });
}
