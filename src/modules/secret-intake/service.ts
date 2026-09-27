// The value lives only between the form submit and the vault write: never logged, returned, persisted or posted.
import { randomBytes } from 'crypto';

import type { SecretIntakeHooks } from '../../channels/adapter.js';
import { TIMEZONE } from '../../config.js';
import { withCentralSync } from '../../db/central-lease.js';
import { addWorkgroupOnecliSecret, getAgentGroup, workgroupExists } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { declareGroupSecret } from '../../onecli-secret-grants.js';
import {
  createOnecliSecret,
  findOnecliSecretByName,
  updateOnecliSecretValue,
  type OnecliInjectionSpec,
} from '../../onecli-secret-writer.js';
import { formatLocalTime } from '../../timezone.js';
import { notifyAgent, pickApprovalDelivery, pickOwnersFirst } from '../approvals/primitive.js';
import { isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';

const INTAKE_TTL_MS = 15 * 60_000;
const FINISHED_RETENTION_MS = 60 * 60_000;
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const HOST_PATTERN_RE = /^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/;
const PATH_PATTERN_RE = /^\/[!-~]{0,255}$/;
const VALUE_FORMAT_RE = /^[ -~]{1,200}$/;
const MAX_PENDING_PER_SESSION = 3;

type SecretIntakeStatus = 'pending' | 'storing' | 'stored' | 'failed' | 'expired';

export type SecretIntakeCaller = { kind: 'host' } | { kind: 'agent'; sessionId: string; agentGroupId: string };

export interface StartSecretIntakeInput {
  name: string;
  rotate: boolean;
  hostPattern?: string;
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  groups: string[];
  workgroups: string[];
  caller: SecretIntakeCaller;
}

interface Intake {
  id: string;
  secretName: string;
  rotate: boolean;
  injection: OnecliInjectionSpec | null;
  groups: string[];
  workgroups: string[];
  sessionId: string | null;
  card: { channelType: string; platformId: string; instance: string; messageId: string | null };
  deliveredTo: string;
  expiresAt: number;
  status: SecretIntakeStatus;
  detail: string | null;
  finishedAt: number | null;
}

export interface SecretIntakeView {
  intakeId: string;
  secretName: string;
  mode: 'create' | 'rotate';
  status: SecretIntakeStatus;
  detail: string | null;
  deliveredTo: string;
  expiresAt: string;
  groups: string[];
  workgroups: string[];
}

const intakes = new Map<string, Intake>();

function view(intake: Intake): SecretIntakeView {
  return {
    intakeId: intake.id,
    secretName: intake.secretName,
    mode: intake.rotate ? 'rotate' : 'create',
    status: intake.status,
    detail: intake.detail,
    deliveredTo: intake.deliveredTo,
    expiresAt: new Date(intake.expiresAt).toISOString(),
    groups: intake.groups,
    workgroups: intake.workgroups,
  };
}

function prune(now: number): void {
  for (const [id, intake] of intakes) {
    if (intake.status === 'pending' && now >= intake.expiresAt) {
      intake.status = 'expired';
      intake.finishedAt = now;
      void editCard(intake, `${cardTitle(intake)}\n\nExpired — nothing was stored.`);
    }
    if (intake.finishedAt !== null && now - intake.finishedAt >= FINISHED_RETENTION_MS) intakes.delete(id);
  }
}

function splitList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((v) => v.split(','))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function cardTitle(intake: Pick<Intake, 'rotate' | 'secretName'>): string {
  return `🔐 ${intake.rotate ? 'Rotate' : 'New'} secret: ${intake.secretName}`;
}

function grantsLine(groups: string[], workgroups: string[]): string {
  const parts = [
    ...(groups.length ? [`groups ${groups.join(', ')}`] : []),
    ...(workgroups.length ? [`workgroups ${workgroups.join(', ')}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'nobody yet (vault only)';
}

function injectionLine(spec: OnecliInjectionSpec): string {
  const where = `${spec.hostPattern}${spec.pathPattern ? ` (path ${spec.pathPattern})` : ''}`;
  return `Sent only to ${where}, as header \`${spec.headerName}: ${spec.valueFormat.replace('{value}', '<secret>')}\``;
}

function validateInjection(input: StartSecretIntakeInput): OnecliInjectionSpec | null {
  if (input.rotate) {
    if (input.hostPattern || input.pathPattern || input.headerName || input.valueFormat) {
      throw new Error(
        '--rotate replaces only the value; the host, path, header and format stay as the secret has them. Drop those flags.',
      );
    }
    return null;
  }
  const hostPattern = input.hostPattern?.trim() ?? '';
  if (hostPattern.length > 253 || !HOST_PATTERN_RE.test(hostPattern)) {
    throw new Error(
      '--host-pattern is required: one exact host such as api.example.com (no scheme, path or wildcard).',
    );
  }
  const headerName = input.headerName?.trim() || 'Authorization';
  if (!HEADER_NAME_RE.test(headerName)) throw new Error(`Invalid header name: "${headerName}"`);
  const valueFormat = input.valueFormat ?? 'Bearer {value}';
  if (!VALUE_FORMAT_RE.test(valueFormat) || !valueFormat.includes('{value}')) {
    throw new Error('--value-format must be one line of plain text containing {value}.');
  }
  const pathPattern = input.pathPattern?.trim() || null;
  if (pathPattern !== null && !PATH_PATTERN_RE.test(pathPattern)) {
    throw new Error('--path-pattern must start with / and contain no spaces.');
  }
  return { name: input.name, hostPattern, pathPattern, headerName, valueFormat };
}

/** An agent may grant only to its own group and its own workgroup, whatever its cli_scope. */
async function grantTargets(
  rawGroups: string[],
  rawWorkgroups: string[],
  caller: SecretIntakeCaller,
): Promise<{ groups: string[]; workgroups: string[] }> {
  let groups = splitList(rawGroups);
  const workgroups = splitList(rawWorkgroups);
  if (caller.kind === 'agent') {
    if (groups.length === 0 && workgroups.length === 0) groups = [caller.agentGroupId];
    const foreignGroup = groups.find((g) => g !== caller.agentGroupId);
    if (foreignGroup) throw new Error(`An agent can grant a secret only to its own group, not ${foreignGroup}.`);
    const ownWorkgroup = (await getAgentGroup(caller.agentGroupId))?.workgroup_id;
    const foreignWorkgroup = workgroups.find((w) => w !== ownWorkgroup);
    if (foreignWorkgroup) {
      throw new Error(`An agent can grant a secret only to its own workgroup, not ${foreignWorkgroup}.`);
    }
  }
  for (const g of groups) {
    if (!(await getAgentGroup(g))) throw new Error(`Agent group not found: ${g}`);
  }
  for (const w of workgroups) {
    if (!(await workgroupExists(w))) throw new Error(`Workgroup not found: ${w}`);
  }
  return { groups, workgroups };
}

export async function startSecretIntake(input: StartSecretIntakeInput): Promise<SecretIntakeView> {
  const now = Date.now();
  prune(now);

  const name = input.name.trim();
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(
      'Secret names are 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit.',
    );
  }
  const injection = validateInjection({ ...input, name });

  const caller = input.caller;
  const callerGroup = caller.kind === 'agent' ? await getAgentGroup(caller.agentGroupId) : undefined;
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, caller);

  const existing = await findOnecliSecretByName(name);
  if (existing && !input.rotate) {
    throw new Error(`"${name}" already exists in the vault. Pass --rotate to replace its value.`);
  }
  if (!existing && input.rotate) throw new Error(`"${name}" is not in the vault, so there is nothing to rotate.`);

  const session = caller.kind === 'agent' ? await getSession(caller.sessionId) : undefined;
  const originMg = session?.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const target = await pickApprovalDelivery(await pickOwnersFirst(null), originMg?.channel_type ?? '');
  if (!target) throw new Error('No owner or global admin has a reachable DM to receive the secret form.');
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('Channel delivery is not ready yet; try again in a moment.');

  const intake: Intake = {
    id: `si-${randomBytes(8).toString('hex')}`,
    secretName: name,
    rotate: input.rotate,
    injection,
    groups,
    workgroups,
    sessionId: caller.kind === 'agent' ? caller.sessionId : null,
    card: {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      instance: target.messagingGroup.instance ?? target.messagingGroup.channel_type,
      messageId: null,
    },
    deliveredTo: target.userId,
    expiresAt: now + INTAKE_TTL_MS,
    status: 'pending',
    detail: null,
    finishedAt: null,
  };

  const requester = callerGroup ? `Agent "${callerGroup.name}"` : 'The host operator';
  const body = [
    `${requester} is asking for this secret.`,
    injection ? injectionLine(injection) : 'Replaces the value; where it is sent stays unchanged.',
    `Granted to: ${grantsLine(groups, workgroups)}`,
    `The value goes straight to the vault — no agent sees it. Expires ${formatLocalTime(new Date(intake.expiresAt).toISOString(), TIMEZONE)}.`,
  ].join('\n');

  // Checked here, after the last await, so two concurrent requests cannot both pass.
  const pending = [...intakes.values()].filter((other) => other.status === 'pending');
  const duplicate = pending.find((other) => other.secretName === name);
  if (duplicate) {
    throw new Error(
      `An intake for "${name}" is already waiting (${duplicate.id}); it expires at ${formatLocalTime(new Date(duplicate.expiresAt).toISOString(), TIMEZONE)}.`,
    );
  }
  if (
    intake.sessionId &&
    pending.filter((other) => other.sessionId === intake.sessionId).length >= MAX_PENDING_PER_SESSION
  ) {
    throw new Error(
      `This session already has ${MAX_PENDING_PER_SESSION} secret requests waiting; let them finish or expire.`,
    );
  }
  intakes.set(intake.id, intake);
  try {
    intake.card.messageId =
      (await adapter.deliver(
        intake.card.channelType,
        intake.card.platformId,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'secret_intake',
          intakeId: intake.id,
          title: cardTitle(intake),
          body,
          buttonLabel: intake.rotate ? 'Enter new value' : 'Enter secret',
        }),
        undefined,
        intake.card.instance,
      )) ?? null;
  } catch (err) {
    intakes.delete(intake.id);
    throw new Error(`Could not post the secret form: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  log.info('Secret intake posted', { intakeId: intake.id, secretName: name, rotate: input.rotate });
  return view(intake);
}

export function getSecretIntake(intakeId: string): SecretIntakeView | undefined {
  prune(Date.now());
  const intake = intakes.get(intakeId);
  return intake ? view(intake) : undefined;
}

async function editCard(intake: Intake, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !intake.card.messageId) return;
  try {
    await adapter.deliver(
      intake.card.channelType,
      intake.card.platformId,
      null,
      'chat-sdk',
      JSON.stringify({ operation: 'edit', messageId: intake.card.messageId, text }),
      undefined,
      intake.card.instance,
    );
  } catch (err) {
    log.warn('Secret intake: could not edit the card', { intakeId: intake.id, err });
  }
}

async function tellRequester(intake: Intake, text: string): Promise<void> {
  if (!intake.sessionId) return;
  const session = await getSession(intake.sessionId);
  if (session) await notifyAgent(session, text);
}

async function refusal(intake: Intake | undefined, namespacedUserId: string): Promise<string | null> {
  if (!intake) return 'This secret request has expired or no longer exists. Ask for a new one.';
  if (intake.status !== 'pending') return `This secret request is already ${intake.status}.`;
  const allowed = await withCentralSync(
    () => isOwner(namespacedUserId) || isGlobalAdmin(namespacedUserId),
    'secret intake authority',
  );
  return allowed ? null : 'Only an owner or global admin can enter a secret.';
}

async function completeIntake(intake: Intake, value: string): Promise<void> {
  try {
    if (intake.injection) {
      await createOnecliSecret(intake.injection, value);
    } else {
      const existing = await findOnecliSecretByName(intake.secretName);
      if (!existing) throw new Error(`"${intake.secretName}" is no longer in the vault`);
      await updateOnecliSecretValue(existing, value);
    }
  } catch (err) {
    intake.status = 'failed';
    intake.finishedAt = Date.now();
    intake.detail = err instanceof Error ? err.message : String(err);
    log.warn('Secret intake: vault write failed', { intakeId: intake.id, detail: intake.detail });
    await editCard(intake, `${cardTitle(intake)}\n\nNot stored: ${intake.detail}`);
    await tellRequester(intake, `Secret "${intake.secretName}" was NOT stored: ${intake.detail}`);
    return;
  }

  const failedGrants: string[] = [];
  for (const g of intake.groups) {
    try {
      await declareGroupSecret(g, intake.secretName);
    } catch (err) {
      failedGrants.push(`group ${g} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  for (const w of intake.workgroups) {
    try {
      await addWorkgroupOnecliSecret(w, intake.secretName);
    } catch (err) {
      failedGrants.push(`workgroup ${w} (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  intake.status = 'stored';
  intake.finishedAt = Date.now();
  intake.detail = failedGrants.length ? `stored, but these grants failed: ${failedGrants.join('; ')}` : null;
  log.info('Secret intake stored', { intakeId: intake.id, secretName: intake.secretName, failedGrants });

  const granted = grantsLine(intake.groups, intake.workgroups);
  const effect = intake.rotate
    ? 'The new value applies to the next request; no restart needed.'
    : 'A newly granted group picks it up at its next container start (ncl groups restart --id <group>).';
  await editCard(
    intake,
    `${cardTitle(intake)}\n\nStored. Granted to: ${granted}.${intake.detail ? `\n\n⚠️ ${intake.detail}` : ''}`,
  );
  await tellRequester(
    intake,
    `Secret "${intake.secretName}" is stored in the vault (${intake.rotate ? 'rotated' : 'created'}); you never saw its value. Granted to: ${granted}. ${effect}${intake.detail ? ` WARNING: ${intake.detail}` : ''}`,
  );
}

export function secretIntakeHooks(channelType: string): SecretIntakeHooks {
  const namespaced = (userId: string): string => (userId.includes(':') ? userId : `${channelType}:${userId}`);
  return {
    async open(intakeId, userId) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = await refusal(intake, namespaced(userId));
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      return {
        ok: true,
        form: {
          title: intake.rotate ? 'Rotate secret' : 'Store secret',
          body: `*${intake.secretName}*\n${intake.injection ? injectionLine(intake.injection) : 'Replaces the current value.'}`,
          inputLabel: intake.rotate ? 'New value' : 'Secret value',
        },
      };
    },
    async submit(intakeId, userId, value) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = await refusal(intake, namespaced(userId));
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      const trimmed = value.trim();
      if (!trimmed) return { ok: false, message: 'Paste the secret value.' };
      if (/\s/.test(trimmed)) return { ok: false, message: 'Paste only the key: it contains spaces or line breaks.' };
      // Re-read after the authority await: a concurrent submit may have claimed it, and must not write twice.
      if (intake.status !== 'pending')
        return { ok: false, message: `This secret request is already ${intake.status}.` };
      intake.status = 'storing';
      completeIntake(intake, trimmed).catch((err) => {
        log.error('Secret intake: completion failed', { intakeId: intake.id, err });
      });
      return { ok: true };
    },
  };
}

export interface SecretGrantResult {
  secretName: string;
  addedGroups: string[];
  addedWorkgroups: string[];
  alreadyGranted: string[];
}

/** A declared name missing from the vault aborts every spawn that inherits it. */
export async function grantSecret(input: {
  name: string;
  groups: string[];
  workgroups: string[];
  caller: SecretIntakeCaller;
}): Promise<SecretGrantResult> {
  if (splitList(input.groups).length === 0 && splitList(input.workgroups).length === 0) {
    throw new Error('Name at least one --groups or --workgroups.');
  }
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, input.caller);
  if (!(await findOnecliSecretByName(input.name))) {
    throw new Error(`"${input.name}" is not in the vault. Store it first with ncl secrets intake.`);
  }
  const result: SecretGrantResult = {
    secretName: input.name,
    addedGroups: [],
    addedWorkgroups: [],
    alreadyGranted: [],
  };
  for (const g of groups) {
    if (await declareGroupSecret(g, input.name)) result.addedGroups.push(g);
    else result.alreadyGranted.push(`group ${g}`);
  }
  for (const w of workgroups) {
    if (await addWorkgroupOnecliSecret(w, input.name)) result.addedWorkgroups.push(w);
    else result.alreadyGranted.push(`workgroup ${w}`);
  }
  return result;
}

export function __resetSecretIntakesForTest(): void {
  intakes.clear();
}
