import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { ContainerConfig } from '../../container-config.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup } from '../../types.js';

const HOST_MNEMON_DIR = path.join(homedir(), '.mnemon');
const ROLLOUT_FILE = path.join(DATA_DIR, 'mnemon-rollout.json');

export interface ApplyMountsArgs {
  mounts: VolumeMount[];
  agentGroup: AgentGroup;
  containerConfig: ContainerConfig;
}

export interface ApplyEnvArgs {
  args: string[];
  agentGroup: AgentGroup;
  containerConfig: ContainerConfig;
}

export function applyMnemonMounts({ mounts, agentGroup, containerConfig }: ApplyMountsArgs): void {
  if (!containerConfig.mnemon?.enabled) return;

  // Per-store data directory (RW). Mounting only this group's store prevents cross-tenant
  // filesystem access — other groups' stores are never visible inside the container.
  // mkdirSync ensures the dir exists before Docker tries to bind-mount it.
  const storeDataDir = path.join(HOST_MNEMON_DIR, 'data', agentGroup.id);
  fs.mkdirSync(storeDataDir, { recursive: true });
  mounts.push({ hostPath: storeDataDir, containerPath: `/home/node/.mnemon/data/${agentGroup.id}`, readonly: false });

  // Prompt directory (RO). Containers read guide.md / skill.md but cannot modify, blocking the
  // persistent prompt-injection vector where an agent writes its own future SessionStart context.
  const promptDir = path.join(HOST_MNEMON_DIR, 'prompt');
  fs.mkdirSync(promptDir, { recursive: true });
  mounts.push({ hostPath: promptDir, containerPath: '/home/node/.mnemon/prompt', readonly: true });

  // Rollout state JSON (RO). Host owns it; containers read phase per hook.
  mounts.push({ hostPath: ROLLOUT_FILE, containerPath: '/workspace/agent/.mnemon-rollout.json', readonly: true });

  // Per-group turn metrics file (RW). Container hooks append to /workspace/agent/.mnemon-metrics.jsonl,
  // which already maps to the host group folder via container-runner. The collector now reads from
  // groups/<folder>/.mnemon-metrics.jsonl directly — no bridging mount needed here. Comment exists
  // so a future maintainer doesn't add a redundant turn-metrics mount.
}

/**
 * Atomically write `content` to `filePath` via temp-file + rename. POSIX `rename(2)` is
 * atomic on the same filesystem, so any concurrent reader (e.g., a running container reading
 * mnemon-rollout.json on every hook invocation) sees either the old content or the new
 * content — never a torn write. Used for any host-side write that containers consume.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

export function applyMnemonEnv({ args, agentGroup, containerConfig }: ApplyEnvArgs): void {
  if (!containerConfig.mnemon?.enabled) return;

  // MNEMON_STORE: per-group isolation (covers [HARD] C4).
  args.push('-e', `MNEMON_STORE=${agentGroup.id}`);

  if (containerConfig.mnemon.embeddings) {
    args.push('-e', 'MNEMON_EMBED_ENDPOINT=http://host.docker.internal:11434');
    args.push('-e', 'MNEMON_EMBED_MODEL=nomic-embed-text');
  }
}
