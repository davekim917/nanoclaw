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
import { isSlackChannelType } from '../../router.js';
import { formatLocalTime } from '../../timezone.js';
import { notifyAgent, pickApprovalDelivery, pickOwnersFirst } from '../approvals/primitive.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { resolveUserChannelType } from '../permissions/user-dm.js';

const INTAKE_TTL_MS = 24 * 60 * 60_000;
const FINISHED_RETENTION_MS = 60 * 60_000;
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const HOST_PATTERN_RE = /^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/;
const PATH_PATTERN_RE = /^\/[!-~]{0,255}$/;
const VALUE_FORMAT_RE = /^[ -~]{1,200}$/;
const MAX_PENDING_PER_SESSION = 3;
const OPEN_AUTHORITY_WAIT_MS = 1000;
const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL_RE = /^[^|\n]{1,40}$/;
const MAX_FIELDS = 5;

type SecretIntakeStatus = 'pending' | 'storing' | 'stored' | 'failed' | 'expired';

export type SecretIntakeCaller = { kind: 'host' } | { kind: 'agent'; sessionId: string; agentGroupId: string };

export interface StartSecretIntakeInput {
  name: string;
  rotate: boolean;
  hostPattern?: string;
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  fields?: string[];
  compose?: string;
  groups: string[];
  workgroups: string[];
  caller: SecretIntakeCaller;
}

type Compose = 'single' | 'basic' | 'separate';

interface FormField {
  id: string;
  label: string;
  optional: boolean;
}

interface VaultTarget {
  name: string;
  injection: OnecliInjectionSpec | null;
  fieldIds: string[];
}

interface Intake {
  id: string;
  secretName: string;
  rotate: boolean;
  compose: Compose;
  fields: FormField[];
  targets: VaultTarget[];
  groups: string[];
  workgroups: string[];
  sessionId: string | null;
  requester: { agentGroupId: string; agentName: string; workgroupId: string | null } | null;
  card: {
    channelType: string;
    platformId: string;
    threadId: string | null;
    instance: string;
    messageId: string | null;
  };
  deliveredTo: string;
  expiresAt: number;
  status: SecretIntakeStatus;
  detail: string | null;
  finishedAt: number | null;
}

export interface SecretIntakeView {
  intakeId: string;
  secretName: string;
  secrets: string[];
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
    secrets: intake.targets.map((target) => target.name),
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

function grantsLine(groups: string[], workgroups: string[], rotate: boolean): string {
  const parts = [
    ...(groups.length ? [`groups ${groups.join(', ')}`] : []),
    ...(workgroups.length ? [`workgroups ${workgroups.join(', ')}`] : []),
  ];
  if (rotate) return `New grants: ${parts.length ? parts.join('; ') : 'none; current holders keep it'}`;
  return `Granted to: ${parts.length ? parts.join('; ') : 'nobody yet (vault only)'}`;
}

function injectionLine(spec: OnecliInjectionSpec): string {
  const where = `${spec.hostPattern}${spec.pathPattern ? ` (path ${spec.pathPattern})` : ''}`;
  return `Sent only to ${where}, as header \`${spec.headerName}: ${spec.valueFormat.replace('{value}', '<secret>')}\``;
}

function hostAndPath(input: StartSecretIntakeInput): { hostPattern: string; pathPattern: string | null } {
  const hostPattern = input.hostPattern?.trim() ?? '';
  if (hostPattern.length > 253 || !HOST_PATTERN_RE.test(hostPattern)) {
    throw new Error(
      '--host-pattern is required: one exact host such as api.example.com (no scheme, path or wildcard).',
    );
  }
  const pathPattern = input.pathPattern?.trim() || null;
  if (pathPattern !== null && !PATH_PATTERN_RE.test(pathPattern)) {
    throw new Error('--path-pattern must start with / and contain no spaces.');
  }
  return { hostPattern, pathPattern };
}

function headerAndFormat(rawHeader: string | undefined, rawFormat: string | undefined, defaultFormat: string) {
  const headerName = rawHeader?.trim() || 'Authorization';
  if (!HEADER_NAME_RE.test(headerName)) throw new Error(`Invalid header name: "${headerName}"`);
  const valueFormat = rawFormat ?? defaultFormat;
  if (!VALUE_FORMAT_RE.test(valueFormat) || !valueFormat.includes('{value}')) {
    throw new Error(`Value format "${valueFormat}" must be one line of plain text containing {value}.`);
  }
  return { headerName, valueFormat };
}

function injectionFor(input: StartSecretIntakeInput, name: string, defaultFormat: string): OnecliInjectionSpec | null {
  if (input.rotate) return null;
  return { name, ...hostAndPath(input), ...headerAndFormat(input.headerName, input.valueFormat, defaultFormat) };
}

interface FieldSpec extends FormField {
  header?: string;
  format?: string;
}

function parseFieldSpec(spec: string): FieldSpec {
  const [rawId = '', rawLabel, header, ...formatParts] = spec.split('|');
  const optional = rawId.trim().endsWith('?');
  const id = rawId.trim().replace(/\?$/, '');
  if (!FIELD_ID_RE.test(id)) {
    throw new Error(`Field name "${id}" must be 1-32 lowercase letters, digits or "_", starting with a letter.`);
  }
  const label = rawLabel?.trim() || id;
  if (!LABEL_RE.test(label)) throw new Error(`Field label "${label}" must be one line of at most 40 characters.`);
  return {
    id,
    label,
    optional,
    header: header?.trim() || undefined,
    format: formatParts.length ? formatParts.join('|') : undefined,
  };
}

function planForm(
  input: StartSecretIntakeInput,
  name: string,
): { compose: Compose; fields: FormField[]; targets: VaultTarget[] } {
  if (input.rotate && (input.hostPattern || input.pathPattern || input.headerName || input.valueFormat)) {
    throw new Error(
      '--rotate replaces only the value; the host, path, header and format stay as the secret has them. Drop those flags.',
    );
  }
  const specs = (input.fields ?? []).map(parseFieldSpec);
  if (specs.length === 0) {
    if (input.compose !== undefined) throw new Error('--compose needs --field.');
    const id = 'secret_value';
    return {
      compose: 'single',
      fields: [{ id, label: input.rotate ? 'New value' : 'Secret value', optional: false }],
      targets: [{ name, injection: injectionFor(input, name, 'Bearer {value}'), fieldIds: [id] }],
    };
  }
  if (specs.length > MAX_FIELDS) throw new Error(`At most ${MAX_FIELDS} --field entries.`);
  const duplicate = specs.find((spec, i) => specs.findIndex((other) => other.id === spec.id) !== i);
  if (duplicate) throw new Error(`Field "${duplicate.id}" is declared twice.`);
  const compose = (input.compose ?? (specs.length === 1 ? 'single' : 'separate')) as Compose;
  if (!['single', 'basic', 'separate'].includes(compose)) throw new Error('--compose must be basic or separate.');
  const plain = (spec: FieldSpec): FormField => ({ id: spec.id, label: spec.label, optional: spec.optional });

  if (compose !== 'separate') {
    const perField = specs.find((spec) => spec.header || spec.format);
    if (perField) {
      throw new Error(
        `Field "${perField.id}" names a header or format; only --compose separate takes those per field.`,
      );
    }
    if (compose === 'basic' && (specs.length !== 2 || specs.some((spec) => spec.optional))) {
      throw new Error(
        '--compose basic needs exactly two required fields (user or client ID, then password or secret).',
      );
    }
    if (compose === 'single' && (specs.length !== 1 || specs[0].optional)) {
      throw new Error('A single field is the whole secret, so it cannot be optional; declare two or more to compose.');
    }
    const defaultFormat = compose === 'basic' ? 'Basic {value}' : 'Bearer {value}';
    return {
      compose,
      fields: specs.map(plain),
      targets: [{ name, injection: injectionFor(input, name, defaultFormat), fieldIds: specs.map((spec) => spec.id) }],
    };
  }

  if (specs.length < 2) throw new Error('--compose separate needs two or more fields.');
  if (input.headerName !== undefined || input.valueFormat !== undefined) {
    throw new Error('With --compose separate, give each field its own header and format in --field, not --header.');
  }
  const where = input.rotate ? null : hostAndPath(input);
  const headers = new Set<string>();
  const targets = specs.map((spec): VaultTarget => {
    const secretName = `${name}-${spec.id}`;
    if (!SECRET_NAME_RE.test(secretName)) throw new Error(`Secret name "${secretName}" is longer than 64 characters.`);
    if (!where) {
      if (spec.header || spec.format) {
        throw new Error('--rotate replaces only values; drop the header and format from each --field.');
      }
      return { name: secretName, injection: null, fieldIds: [spec.id] };
    }
    if (!spec.header)
      throw new Error(`Field "${spec.id}" needs a header: --field '${spec.id}|${spec.label}|<Header>'.`);
    const injection = { name: secretName, ...where, ...headerAndFormat(spec.header, spec.format, '{value}') };
    if (headers.has(injection.headerName.toLowerCase())) {
      throw new Error(`Two fields are sent as header "${injection.headerName}".`);
    }
    headers.add(injection.headerName.toLowerCase());
    return { name: secretName, injection, fieldIds: [spec.id] };
  });
  const fields = specs.map((spec) => ({ ...plain(spec), optional: spec.optional || input.rotate }));
  return { compose, fields, targets };
}

function fieldsLine(compose: Compose, fields: FormField[]): string {
  if (fields.length === 1) return `The form has one field, "${fields[0].label}": paste the key exactly as issued.`;
  const listed = fields.map((field) => `"${field.label}"${field.optional ? ' (optional)' : ''}`).join(', ');
  const how = compose === 'basic' ? 'The host joins and encodes them' : 'The host stores each as its own secret';
  return `The form asks for ${listed}: paste each exactly as issued. ${how}, so nothing needs preparing first.`;
}

function targetLines(intake: Pick<Intake, 'compose' | 'fields' | 'targets'>): string[] {
  return intake.targets.map((target) => {
    const where = target.injection
      ? injectionLine(target.injection)
      : 'Replaces the value; where it is sent stays unchanged.';
    if (intake.compose !== 'separate') return where;
    const label = intake.fields.find((field) => field.id === target.fieldIds[0])?.label;
    return `"${label}" → ${target.name}. ${where}`;
  });
}

type Composed =
  | { ok: true; writes: Array<{ target: VaultTarget; value: string }> }
  | { ok: false; message: string; field: string };

function composeValues(
  intake: Pick<Intake, 'compose' | 'fields' | 'targets'>,
  values: Record<string, string>,
): Composed {
  const read = new Map<string, string>();
  for (const field of intake.fields) {
    const value = (values[field.id] ?? '').trim();
    if (!value && !field.optional)
      return { ok: false, field: field.id, message: `Paste a value for "${field.label}".` };
    if (/\s/.test(value)) {
      return {
        ok: false,
        field: field.id,
        message: `"${field.label}" contains spaces or line breaks; paste only the value.`,
      };
    }
    read.set(field.id, value);
  }
  const writes: Array<{ target: VaultTarget; value: string }> = [];
  for (const target of intake.targets) {
    const parts = target.fieldIds.map((id) => read.get(id) ?? '');
    if (parts.every((part) => !part)) continue;
    if (intake.compose !== 'basic') {
      writes.push({ target, value: parts[0] });
      continue;
    }
    if (parts[0].includes(':')) {
      return { ok: false, field: target.fieldIds[0], message: `"${intake.fields[0].label}" cannot contain a colon.` };
    }
    writes.push({ target, value: Buffer.from(`${parts[0]}:${parts[1]}`, 'utf8').toString('base64') });
  }
  if (writes.length === 0) return { ok: false, field: intake.fields[0].id, message: 'Fill in at least one field.' };
  return { ok: true, writes };
}

/** An agent may grant only to its own group and its own workgroup, whatever its cli_scope. */
async function grantTargets(
  rawGroups: string[],
  rawWorkgroups: string[],
  caller: SecretIntakeCaller,
  defaultToOwnGroup: boolean,
): Promise<{ groups: string[]; workgroups: string[] }> {
  let groups = splitList(rawGroups);
  const workgroups = splitList(rawWorkgroups);
  if (caller.kind === 'agent') {
    if (defaultToOwnGroup && groups.length === 0 && workgroups.length === 0) groups = [caller.agentGroupId];
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
  const { compose, fields, targets } = planForm(input, name);

  const caller = input.caller;
  const callerGroup = caller.kind === 'agent' ? await getAgentGroup(caller.agentGroupId) : undefined;
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, caller, !input.rotate);

  for (const target of targets) {
    const existing = await findOnecliSecretByName(target.name);
    if (existing && !input.rotate) {
      throw new Error(`"${target.name}" already exists in the vault. Pass --rotate to replace its value.`);
    }
    if (!existing && input.rotate) {
      throw new Error(`"${target.name}" is not in the vault, so there is nothing to rotate.`);
    }
  }

  const session = caller.kind === 'agent' ? await getSession(caller.sessionId) : undefined;
  const originMg = session?.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  let card: Intake['card'];
  let deliveredTo: string;
  if (originMg && session && isSlackChannelType(originMg.channel_type) && callerGroup && !input.rotate) {
    card = {
      channelType: originMg.channel_type,
      platformId: originMg.platform_id,
      threadId: session.thread_id,
      instance: originMg.instance ?? originMg.channel_type,
      messageId: null,
    };
    deliveredTo = `the requesting conversation (${originMg.name ?? originMg.platform_id})`;
  } else {
    const target = await slackOwnerDm();
    if (!target) throw new Error('No owner or global admin has a reachable Slack DM to receive the secret form.');
    card = {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      threadId: null,
      instance: target.messagingGroup.instance ?? target.messagingGroup.channel_type,
      messageId: null,
    };
    deliveredTo = target.userId;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('Channel delivery is not ready yet; try again in a moment.');

  const intake: Intake = {
    id: `si-${randomBytes(8).toString('hex')}`,
    secretName: name,
    rotate: input.rotate,
    compose,
    fields,
    targets,
    groups,
    workgroups,
    sessionId: caller.kind === 'agent' ? caller.sessionId : null,
    requester:
      caller.kind === 'agent' && callerGroup
        ? { agentGroupId: callerGroup.id, agentName: callerGroup.name, workgroupId: callerGroup.workgroup_id ?? null }
        : null,
    card,
    deliveredTo,
    expiresAt: now + INTAKE_TTL_MS,
    status: 'pending',
    detail: null,
    finishedAt: null,
  };

  const requester = callerGroup ? `Agent "${callerGroup.name}"` : 'The host operator';
  const body = [
    `${requester} is asking for this secret.`,
    ...targetLines({ compose, fields, targets }),
    grantsLine(groups, workgroups, input.rotate),
    callerGroup && !input.rotate
      ? `An owner, a global admin, or an admin of "${callerGroup.name}" can enter it.`
      : 'Only an owner or global admin can enter it.',
    fieldsLine(compose, fields),
    `The value goes straight to the vault — no agent sees it. Expires ${formatLocalTime(new Date(intake.expiresAt).toISOString(), TIMEZONE)}.`,
  ].join('\n');

  // Checked here, after the last await, so two concurrent requests cannot both pass.
  const pending = [...intakes.values()].filter((other) => other.status === 'pending' || other.status === 'storing');
  const names = new Set(targets.map((target) => target.name));
  const overlapping = pending.filter(
    (other) => other.secretName === name || other.targets.some((target) => names.has(target.name)),
  );
  const replaceable = (other: Intake) => other.status === 'pending' && other.sessionId === intake.sessionId;
  const duplicate = overlapping.find((other) => !replaceable(other));
  if (duplicate) {
    throw new Error(
      `An intake for "${name}" is already waiting (${duplicate.id}); it expires at ${formatLocalTime(new Date(duplicate.expiresAt).toISOString(), TIMEZONE)}.`,
    );
  }
  if (
    intake.sessionId &&
    pending.filter((other) => other.sessionId === intake.sessionId && !overlapping.includes(other)).length >=
      MAX_PENDING_PER_SESSION
  ) {
    throw new Error(
      `This session already has ${MAX_PENDING_PER_SESSION} secret requests waiting; let them finish or expire.`,
    );
  }
  for (const old of overlapping) {
    old.status = 'expired';
    old.finishedAt = now;
    void editCard(old, `${cardTitle(old)}\n\nReplaced by a newer request — nothing was stored.`);
  }
  intakes.set(intake.id, intake);
  try {
    intake.card.messageId =
      (await adapter.deliver(
        intake.card.channelType,
        intake.card.platformId,
        intake.card.threadId,
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
  if (!intake.card.messageId) return;
  await deliverToCard(intake, 'chat-sdk', { operation: 'edit', messageId: intake.card.messageId, text });
}

async function deliverToCard(intake: Intake, kind: string, content: Record<string, unknown>): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      intake.card.channelType,
      intake.card.platformId,
      intake.card.threadId,
      kind,
      JSON.stringify(content),
      undefined,
      intake.card.instance,
    );
  } catch (err) {
    log.warn('Secret intake: could not post to the card conversation', { intakeId: intake.id, err });
  }
}

type Authority = 'owner' | 'group-admin' | null;

function mayEnter(intake: Intake): string {
  const who =
    intake.requester && !intake.rotate
      ? `an owner, a global admin or an admin of "${intake.requester.agentName}"`
      : 'an owner or global admin';
  return `Only ${who} can enter this secret.`;
}

function authorityOf(intake: Intake, namespacedUserId: string): Promise<Authority> {
  return withCentralSync(() => {
    if (isOwner(namespacedUserId) || isGlobalAdmin(namespacedUserId)) return 'owner' as const;
    if (!intake.rotate && intake.requester && isAdminOfAgentGroup(namespacedUserId, intake.requester.agentGroupId)) {
      return 'group-admin' as const;
    }
    return null;
  }, 'secret intake authority');
}

async function slackOwnerDm(): ReturnType<typeof pickApprovalDelivery> {
  for (const userId of await pickOwnersFirst(null)) {
    const type = await resolveUserChannelType(userId);
    if (!type || !isSlackChannelType(type)) continue;
    const target = await pickApprovalDelivery([userId], type);
    if (target) return target;
  }
  return null;
}

async function noticeOwners(
  intake: Intake,
  namespacedUserId: string,
  stored: string[],
  partial: boolean,
): Promise<void> {
  try {
    const adapter = getDeliveryAdapter();
    const target = await pickApprovalDelivery(await pickOwnersFirst(null), '');
    if (!adapter || !target) throw new Error('no owner DM is reachable');
    const who = (await getUser(namespacedUserId))?.display_name || namespacedUserId;
    const where = targetLines({ ...intake, targets: intake.targets.filter((x) => stored.includes(x.name)) }).join(' ');
    const granted = partial
      ? 'A later write failed, so nothing was granted.'
      : `${grantsLine(intake.groups, intake.workgroups, intake.rotate)}.`;
    const text = `🔐 ${who} stored ${quoted(stored)} for agent "${intake.requester?.agentName}". ${where} ${granted}`;
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      target.messagingGroup.instance ?? target.messagingGroup.channel_type,
    );
  } catch (err) {
    log.error('Secret intake: the owner notice for a group-admin store failed', { intakeId: intake.id, err });
  }
}

async function tellRequester(intake: Intake, text: string): Promise<void> {
  if (!intake.sessionId) return;
  const session = await getSession(intake.sessionId);
  if (session) await notifyAgent(session, text);
}

function unavailable(intake: Intake | undefined): string | null {
  if (!intake) return 'This secret request has expired or no longer exists. Ask for a new one.';
  return intake.status === 'pending' ? null : `This secret request is already ${intake.status}.`;
}

class PartialStoreError extends Error {}

async function failIntake(intake: Intake, err: unknown): Promise<void> {
  if (intake.status !== 'storing') {
    log.warn('Secret intake: follow-up after the store failed', { intakeId: intake.id, err });
    return;
  }
  intake.status = 'failed';
  intake.finishedAt = Date.now();
  intake.detail = err instanceof Error ? err.message : String(err);
  const outcome = err instanceof PartialStoreError ? 'only partly stored' : 'NOT stored';
  log.warn('Secret intake: not stored', { intakeId: intake.id, detail: intake.detail });
  await editCard(intake, `${cardTitle(intake)}\n\n${outcome}: ${intake.detail}`);
  await tellRequester(intake, `Secret "${intake.secretName}" was ${outcome}: ${intake.detail}`);
}

function quoted(names: string[]): string {
  return `secret${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')}`;
}

async function writeVault(
  writes: Array<{ target: VaultTarget; value: string }>,
): Promise<{ stored: string[]; failure: { name: string; err: unknown } | null }> {
  const stored: string[] = [];
  for (const { target, value } of writes) {
    try {
      if (target.injection) {
        await createOnecliSecret(target.injection, value);
      } else {
        const existing = await findOnecliSecretByName(target.name);
        if (!existing) throw new Error(`"${target.name}" is no longer in the vault`);
        await updateOnecliSecretValue(existing, value);
      }
    } catch (err) {
      return { stored, failure: { name: target.name, err } };
    }
    stored.push(target.name);
  }
  return { stored, failure: null };
}

async function completeIntake(
  intake: Intake,
  namespacedUserId: string,
  writes: Array<{ target: VaultTarget; value: string }>,
): Promise<void> {
  const authority = await authorityOf(intake, namespacedUserId);
  const refusal = authority ? null : mayEnter(intake);
  if (refusal) {
    intake.status = 'pending';
    log.warn('Secret intake: submit refused', { intakeId: intake.id, authority });
    await deliverToCard(intake, 'chat', { text: `${refusal} Nothing was stored; the request is still open.` });
    return;
  }
  const { stored, failure } = await writeVault(writes);
  if (authority === 'group-admin' && stored.length) await noticeOwners(intake, namespacedUserId, stored, !!failure);
  if (failure) {
    if (!stored.length) throw failure.err;
    const reason = failure.err instanceof Error ? failure.err.message : String(failure.err);
    const done = intake.rotate ? 'replaced, now live for every holder' : 'stored but granted to no one';
    throw new PartialStoreError(`${quoted(stored)} ${done}; then "${failure.name}" failed: ${reason}`, {
      cause: failure.err,
    });
  }

  const failedGrants: string[] = [];
  for (const name of stored) {
    for (const g of intake.groups) {
      try {
        await declareGroupSecret(g, name);
      } catch (err) {
        failedGrants.push(`group ${g} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    for (const w of intake.workgroups) {
      try {
        await addWorkgroupOnecliSecret(w, name);
      } catch (err) {
        failedGrants.push(`workgroup ${w} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  intake.status = 'stored';
  intake.finishedAt = Date.now();
  intake.detail = failedGrants.length ? `stored, but these grants failed: ${failedGrants.join('; ')}` : null;
  log.info('Secret intake stored', { intakeId: intake.id, stored, failedGrants });

  const granted = grantsLine(intake.groups, intake.workgroups, intake.rotate);
  const effect = intake.rotate
    ? 'The new value applies to the next request; no restart needed.'
    : 'A newly granted group picks it up at its next container start (ncl groups restart --id <group>).';
  await editCard(
    intake,
    `${cardTitle(intake)}\n\nStored ${quoted(stored)}. ${granted}.${intake.detail ? `\n\n⚠️ ${intake.detail}` : ''}`,
  );
  await tellRequester(
    intake,
    `${quoted(stored).replace(/^s/, 'S')} stored in the vault (${intake.rotate ? 'rotated' : 'created'}); you never saw the value. ${granted}. ${effect}${intake.detail ? ` WARNING: ${intake.detail}` : ''}`,
  );
}

export function secretIntakeHooks(channelType: string): SecretIntakeHooks {
  const namespaced = (userId: string): string => (userId.includes(':') ? userId : `${channelType}:${userId}`);
  return {
    // The trigger window can close before the lease frees, so open waits briefly and completeIntake decides.
    async open(intakeId, userId) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = unavailable(intake);
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      let timer: NodeJS.Timeout | undefined;
      const early = await Promise.race([
        authorityOf(intake, namespaced(userId)).catch(() => 'undecided' as const),
        new Promise<'undecided'>((resolve) => {
          timer = setTimeout(() => resolve('undecided'), OPEN_AUTHORITY_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (early === null) return { ok: false, message: mayEnter(intake) };
      return {
        ok: true,
        form: {
          title: intake.rotate ? 'Rotate secret' : 'Store secret',
          body: [`*${intake.secretName}*`, ...targetLines(intake)].join('\n'),
          inputs: intake.fields,
        },
      };
    },
    async submit(intakeId, userId, values) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = unavailable(intake);
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      const composed = composeValues(intake, values);
      if (!composed.ok) return composed;
      intake.status = 'storing';
      completeIntake(intake, namespaced(userId), composed.writes)
        .catch((err) => failIntake(intake, err))
        .catch((err) => log.error('Secret intake: completion failed', { intakeId: intake.id, err }));
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
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, input.caller, false);
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
