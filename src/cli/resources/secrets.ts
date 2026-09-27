// `intake` needs no approval: nothing is stored until an owner fills in the form, which is the consent.
import { TIMEZONE } from '../../config.js';
import {
  getSecretIntake,
  grantSecret,
  startSecretIntake,
  type SecretGrantResult,
  type SecretIntakeView,
} from '../../modules/secret-intake/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

function optionalString(raw: unknown): string | undefined {
  return raw === undefined || raw === null ? undefined : String(raw);
}

function list(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

function formatIntake(v: SecretIntakeView): string {
  return [
    `Intake ${v.intakeId} — ${v.mode} "${v.secretName}": ${v.status}${v.detail ? ` (${v.detail})` : ''}`,
    `Form sent to: ${v.deliveredTo}`,
    `Grants:       ${[...v.groups.map((g) => `group ${g}`), ...v.workgroups.map((w) => `workgroup ${w}`)].join(', ') || '(none)'}`,
    `Expires:      ${formatLocalTime(v.expiresAt, TIMEZONE)}`,
  ].join('\n');
}

const grantArgs = [
  {
    name: 'group',
    type: 'string' as const,
    description: 'Agent group id(s) to grant it to, comma-separated. An agent may name only its own group.',
  },
  {
    name: 'workgroup',
    type: 'string' as const,
    description: 'Workgroup id(s) to grant it to, comma-separated; every member group inherits it.',
  },
];

registerResource({
  name: 'secret',
  plural: 'secrets',
  table: 'workgroups',
  description:
    'Store or rotate an API key in the OneCLI vault through a form the owner fills in, and grant secrets to groups or workgroups by name. No secret value ever passes through chat, argv or this CLI.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    intake: {
      access: 'open',
      description:
        "Ask the owner for a secret. Posts a card to an owner's DM; its button opens a form, and the value typed there goes straight to the vault — you never see it. Returns at once; the requesting agent is told when it is stored (host callers: `ncl secrets intake-status`).\n\n" +
        'New secret: --host-pattern is required and decides where the gateway sends the value, so name the API host exactly. ' +
        'Rotation (--rotate): replaces only the value; the secret keeps its host, header and grants, and takes effect on the next request.\n\n' +
        'From an agent with no --group/--workgroup, the secret is granted to the calling group. A new grant takes effect at the next container start.',
      args: [
        { name: 'name', type: 'string', description: 'Vault name, e.g. Linear-API-Key.', required: true },
        { name: 'rotate', type: 'boolean', description: 'Replace the value of an existing secret.' },
        {
          name: 'host_pattern',
          type: 'string',
          description: 'Host the value is injected for, e.g. api.linear.app. Required for a new secret.',
        },
        { name: 'path_pattern', type: 'string', description: 'Optional path match, e.g. /v1/*.' },
        { name: 'header', type: 'string', description: 'Header to inject (default Authorization).' },
        {
          name: 'value_format',
          type: 'string',
          description: 'Header value template containing {value} (default "Bearer {value}").',
        },
        ...grantArgs,
      ],
      examples: [
        'ncl secrets intake --name Linear-API-Key --host-pattern api.linear.app --value-format "{value}"',
        'ncl secrets intake --name Exa-API-Key --host-pattern api.exa.ai --header x-api-key --value-format "{value}" --workgroup example-wg',
        'ncl secrets intake --name Linear-API-Key --rotate',
      ],
      handler: async (args, ctx) =>
        startSecretIntake({
          name: String(args.name),
          rotate: args.rotate === true || args.rotate === 'true',
          hostPattern: optionalString(args.host_pattern),
          pathPattern: optionalString(args.path_pattern),
          headerName: optionalString(args.header),
          valueFormat: optionalString(args.value_format),
          groups: list(args.group),
          workgroups: list(args.workgroup),
          caller:
            ctx.caller === 'agent'
              ? { kind: 'agent', sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId }
              : { kind: 'host' },
        }),
      formatHuman: (data) =>
        `${formatIntake(data as SecretIntakeView)}\n\nThe owner enters the value in the card's form; nothing is stored until then.`,
    },

    'intake-status': {
      access: 'open',
      description: 'Show where an intake stands: pending, storing, stored, failed or expired. Kept for an hour.',
      args: [{ name: 'id', type: 'string', description: 'Intake id from `ncl secrets intake`.', required: true }],
      handler: async (args) => {
        const found = getSecretIntake(String(args.id));
        if (!found)
          throw new Error(`No intake ${String(args.id)} (unknown, older than an hour, or the host restarted).`);
        return found;
      },
      formatHuman: (data) => formatIntake(data as SecretIntakeView),
    },

    grant: {
      access: 'approval',
      description:
        'Grant a secret already in the vault to agent groups or workgroups, by name. Takes effect at each group’s next container start. An agent’s call waits for admin approval.',
      args: [{ name: 'name', type: 'string', description: 'Vault name.', required: true }, ...grantArgs],
      examples: ['ncl secrets grant --name Linear-API-Key --workgroup example-wg'],
      handler: async (args) =>
        grantSecret({ name: String(args.name), groups: list(args.group), workgroups: list(args.workgroup) }),
      formatHuman: (data) => {
        const d = data as SecretGrantResult;
        return [
          `Granted "${d.secretName}":`,
          `  groups:     ${d.addedGroups.join(', ') || '(none new)'}`,
          `  workgroups: ${d.addedWorkgroups.join(', ') || '(none new)'}`,
          ...(d.alreadyGranted.length ? [`  already had it: ${d.alreadyGranted.join(', ')}`] : []),
          'Restart a group to pick it up: ncl groups restart --id <group>',
        ].join('\n');
      },
    },
  },
});
