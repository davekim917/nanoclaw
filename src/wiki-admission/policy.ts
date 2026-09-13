import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import type { ContainerConfig } from '../container-config.js';

export interface WikiPolicy {
  version: 1;
  workgroupId: string;
  repository: string;
  defaultRef: string;
  writerGroupId: string;
  verifierGroupId: string;
  seriesId: string;
  sourcePrefixes: string[];
  notification: { channelType: string; platformId: string; threadId: string | null };
}
export type Enrollment = { policy: WikiPolicy; digest: string; role: 'writer' | 'verifier' };
export const digest = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const POLICY_FILE = path.join(GROUPS_DIR, '_ops', 'wiki', 'admission.json');

export function parsePolicy(value: unknown): WikiPolicy {
  const p = value as WikiPolicy;
  if (
    !p ||
    p.version !== 1 ||
    ![p.workgroupId, p.repository, p.writerGroupId, p.verifierGroupId, p.seriesId].every(
      (v) => typeof v === 'string' && ID.test(v),
    ) ||
    p.writerGroupId === p.verifierGroupId
  )
    throw new Error('Invalid wiki admission identity policy');
  if (!/^refs\/heads\/[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(p.defaultRef) || p.defaultRef.endsWith('/')) {
    throw new Error('Invalid wiki admission default ref');
  }
  if (!Array.isArray(p.sourcePrefixes) || !p.sourcePrefixes.length || p.sourcePrefixes.length > 16) {
    throw new Error('Wiki primary source policy is empty or too large');
  }
  for (const prefix of p.sourcePrefixes) {
    const u = new URL(prefix);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      u.search ||
      u.hash ||
      u.href !== prefix ||
      !u.pathname.endsWith('/')
    )
      throw new Error('Invalid wiki primary source prefix');
  }
  if (
    !p.notification ||
    !p.notification.channelType ||
    !p.notification.platformId ||
    (p.notification.threadId !== null && typeof p.notification.threadId !== 'string')
  ) {
    throw new Error('Invalid wiki notification destination');
  }
  return p;
}

/** Host-only records; never read from the wiki or a mounted group. */
function readHostRecord(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 16_384) throw new Error('Invalid wiki policy file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readWikiPolicy(file = POLICY_FILE): { policy: WikiPolicy; digest: string } | null {
  const raw = readHostRecord(file);
  return raw === null ? null : { policy: parsePolicy(JSON.parse(raw)), digest: digest(raw) };
}

function readActorIdentity(file: string): { actorGroupIds: string[]; digest: string } | null {
  const raw = readHostRecord(path.join(path.dirname(file), 'actors.json'));
  if (raw === null) return null;
  const record = JSON.parse(raw);
  if (
    !record ||
    record.version !== 1 ||
    !Array.isArray(record.actorGroupIds) ||
    record.actorGroupIds.length < 2 ||
    record.actorGroupIds.length > 128 ||
    record.actorGroupIds.some((id: unknown) => typeof id !== 'string' || !ID.test(id)) ||
    new Set(record.actorGroupIds).size !== record.actorGroupIds.length
  ) {
    throw new Error('Invalid wiki actor identity record');
  }
  return { actorGroupIds: record.actorGroupIds, digest: digest(raw) };
}

/** Publication needs both records; identity alone grants no publisher capability. */
export function readWikiPublicationPolicy(file = POLICY_FILE): { policy: WikiPolicy; digest: string } | null {
  const loaded = readWikiPolicy(file);
  if (!loaded) return null;
  const identity = readActorIdentity(file);
  if (
    !identity ||
    ![loaded.policy.writerGroupId, loaded.policy.verifierGroupId].every((id) => identity.actorGroupIds.includes(id))
  ) {
    throw new Error('Wiki publication policy is missing durable actor identity');
  }
  return { policy: loaded.policy, digest: digest(JSON.stringify([loaded.digest, identity.digest])) };
}

export function wikiEnrollment(groupId: string, marked: boolean, file = POLICY_FILE): Enrollment | null {
  const identity = readActorIdentity(file);
  if (!identity) {
    if (marked || fs.lstatSync(file, { throwIfNoEntry: false }))
      throw new Error('Wiki actor has no host enrollment identity');
    return null;
  }
  const listed = identity.actorGroupIds.includes(groupId);
  if (!listed) {
    if (marked) throw new Error('Marked wiki actor has no host enrollment identity');
    return null;
  }
  if (!marked) throw new Error('Enrolled wiki actor is missing its restricted-profile marker');
  const loaded = readWikiPublicationPolicy(file);
  const role =
    loaded?.policy.writerGroupId === groupId
      ? 'writer'
      : loaded?.policy.verifierGroupId === groupId
        ? 'verifier'
        : null;
  if (!role) throw new Error('Marked wiki actor has no active publication policy');
  return role && loaded ? { ...loaded, role } : null;
}

/** Reject configuration expansion rather than silently dropping permissions. */
export function assertWikiActorConfig(config: ContainerConfig, enrollment: Enrollment, workgroup: string): void {
  if (workgroup !== enrollment.policy.workgroupId) throw new Error('Wiki actor workgroup changed');
  const allowed = new Set([
    'wikiMaintenance',
    'mcpServers',
    'packages',
    'additionalMounts',
    'skills',
    'provider',
    'model',
    'effort',
    'groupName',
    'assistantName',
    'agentGroupId',
    'timezone',
    'resources',
    'security',
    'workgroup_id',
    'providerConfig',
    'tools',
    'maxMessagesPerPrompt',
  ]);
  if (Object.entries(config).some(([key, value]) => value !== undefined && !allowed.has(key)))
    throw new Error('Wiki actor has extra runtime configuration');
  if (
    !['claude', 'codex'].includes(config.provider ?? 'claude') ||
    Object.keys(config.mcpServers ?? {}).length ||
    config.additionalMounts?.length ||
    config.skills === 'all' ||
    config.skills?.length ||
    config.tools?.length ||
    config.packages?.apt?.length ||
    config.packages?.npm?.length ||
    config.security?.capAdd?.length ||
    config.security?.noNewPrivileges === false ||
    Object.keys(config.providerConfig ?? {}).some((key) => !['model', 'reasoning_effort', 'effort'].includes(key))
  ) {
    throw new Error('Wiki actor may only use the base model runtime');
  }
}

export function allowedWikiOutbound(kind: string, action: unknown): boolean {
  return kind === 'task_log' || (kind === 'system' && ['wiki_admission', 'turn_end'].includes(String(action)));
}
