/**
 * Test-only cross-language fixture producer. It initializes a NEW disposable
 * central DB, posts a scoped request_choice through the registered host action,
 * runs an authorized card callback through handleApprovalsResponse, then emits
 * the real host-origin response line. The private policy test decodes that
 * line and reads the receipt this callback wrote; it must not hand-author a
 * receipt, response, or approval id.
 */
import fs from 'fs';
import path from 'path';

import type { AgentGroup, MessagingGroup, MessagingGroupAgent, Session } from '../src/types.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  const dbPath = path.resolve(option('--db'));
  // A fixture must never attach to an existing database, where a stale
  // approval/receipt could make its claimed callback path ambiguous.
  if (fs.existsSync(dbPath)) throw new Error(`fixture database already exists: ${dbPath}`);
  const fixtureRoot = path.dirname(dbPath);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  // config.ts fixes DATA_DIR when it is imported. Import host modules only
  // after changing into this fixture root, so mailbox writes stay disposable.
  process.chdir(fixtureRoot);

  const [
    db,
    agentGroups,
    messagingGroups,
    sessions,
    delivery,
    sessionManager,
    mailboxPaths,
    users,
    userRoles,
    responses,
    choiceModule,
    scopeModule,
    adoption,
  ] = await Promise.all([
    import('../src/db/index.js'),
    import('../src/db/agent-groups.js'),
    import('../src/db/messaging-groups.js'),
    import('../src/db/sessions.js'),
    import('../src/delivery.js'),
    import('../src/session-manager.js'),
    import('../src/mailbox/sqlite/paths.js'),
    import('../src/modules/permissions/db/users.js'),
    import('../src/modules/permissions/db/user-roles.js'),
    import('../src/modules/approvals/response-handler.js'),
    import('../src/modules/interactive/choice.js'),
    import('../src/modules/approvals/release-ship-scope.js'),
    import('../src/db/insert-or-adopt.js'),
  ]);
  // The real host process imports this composition root at startup. The
  // disposable fixture does the same before provisioning its session mailbox.
  await import('../src/mailbox/compose.js');
  const Database = (await import('better-sqlite3')).default;

  const channelType = option('--channel-type');
  const clicker = option('--clicker');
  const clickerPrefix = `${channelType}:`;
  if (!clicker.startsWith(clickerPrefix) || clicker.length === clickerPrefix.length) {
    throw new Error('--clicker must be a namespaced id for --channel-type');
  }
  const scope = scopeModule.parseReleaseShipScope({
    purpose: 'release_ship',
    repository: option('--repository'),
    pullRequest: Number(option('--pr')),
    base: option('--base'),
    headSha: option('--head'),
  });
  if (!scope) throw new Error('invalid release scope arguments');

  const agentGroupId = option('--group');
  const platformId = option('--platform');
  const requestId = option('--request-id');
  const sessionId = 'fixture-session';
  const messagingGroupId = 'fixture-messaging-group';

  // Reuse the async driver-backed migrated test primitive rather than opening
  // a new synchronous raw-handle migration caller in this script. The real
  // callback writes to this fresh host DB; its final snapshot is the fixture
  // database the private reader consumes below.
  await db.initMigratedTestDb();
  try {
    const agentGroup: AgentGroup = {
      id: agentGroupId,
      name: 'Fixture release agent',
      folder: 'fixture-release-agent',
      agent_provider: null,
      created_at: now(),
    };
    await adoption.insertOrAdopt(agentGroup, agentGroups.createAgentGroup, () =>
      agentGroups.getAgentGroup(agentGroupId),
    );
    const messagingGroup: MessagingGroup = {
      id: messagingGroupId,
      channel_type: channelType,
      platform_id: platformId,
      name: 'Fixture release channel',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    };
    await adoption.insertOrAdopt(messagingGroup, messagingGroups.createMessagingGroup, () =>
      messagingGroups.getMessagingGroup(messagingGroupId),
    );
    const wiring: MessagingGroupAgent = {
      id: 'fixture-wiring',
      messaging_group_id: messagingGroupId,
      agent_group_id: agentGroupId,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    };
    await adoption.insertOrAdopt(wiring, messagingGroups.createMessagingGroupAgent, () =>
      messagingGroups.getMessagingGroupAgentByPair(messagingGroupId, agentGroupId),
    );
    const session: Session = {
      id: sessionId,
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    };
    await adoption.insertOrAdopt(session, sessions.createSession, () => sessions.getSession(sessionId));
    sessionManager.initSessionFolder(agentGroupId, sessionId);
    await users.upsertUser({ id: clicker, kind: channelType, display_name: 'Fixture approver', created_at: now() });
    await userRoles.grantRole({
      user_id: clicker,
      role: 'admin',
      agent_group_id: agentGroupId,
      granted_by: null,
      granted_at: now(),
    });

    let deliverySequence = 0;
    delivery.setDeliveryAdapter({
      async deliver(): Promise<string> {
        deliverySequence += 1;
        return `fixture-card-${deliverySequence}`;
      },
    });
    await delivery.getDeliveryAction(choiceModule.REQUEST_CHOICE_ACTION)!(
      { action: choiceModule.REQUEST_CHOICE_ACTION, choiceId: requestId, approvalScope: scope },
      {
        id: sessionId,
        agent_group_id: agentGroupId,
        messaging_group_id: messagingGroupId,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: now(),
        created_at: now(),
      },
    );
    const pending = await sessions.getPendingApprovalByRequestId(requestId);
    if (!pending?.platform_message_id) throw new Error('fixture card was not posted');
    const handled = await responses.handleApprovalsResponse({
      questionId: pending.approval_id,
      value: 'ship',
      userId: clicker.slice(clickerPrefix.length),
      channelType,
      platformId,
      threadId: null,
      messageId: pending.platform_message_id,
    });
    if (!handled) throw new Error('fixture callback was not claimed');

    // The cross-language consumer needs a real disposable database after this
    // process exits. Export only after the actual registered action and
    // authorized callback populated the fresh async-driver test database.
    await db.getDb().exec(`VACUUM INTO ${sqliteString(dbPath)}`);

    const mailbox = new Database(mailboxPaths.inboundDbPath(agentGroupId, sessionId), { readonly: true });
    try {
      const row = mailbox
        .prepare('SELECT content FROM messages_in WHERE id = ?')
        .get(`choice-answer-${pending.approval_id}`) as { content?: string } | undefined;
      const text = row?.content ? (JSON.parse(row.content) as { text?: unknown }).text : undefined;
      if (typeof text !== 'string' || !text.startsWith('choice_response ')) {
        throw new Error('fixture callback did not write a host choice response');
      }
      process.stdout.write(`${JSON.stringify({ response: text })}\n`);
    } finally {
      mailbox.close();
    }
  } finally {
    await db.closeDb();
  }
}

await main();
