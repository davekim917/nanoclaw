/**
 * User DM resolution.
 *
 * Exposes one primitive: `ensureUserDm(userId)` returns (or lazily creates)
 * the `messaging_groups` row that the host should deliver to when it wants
 * to DM a given user. Everything that needs to cold-DM a user — approvals,
 * pairing handshakes, host notifications — goes through this function.
 *
 * ## Two-class resolution
 *
 * Channels split cleanly into two classes based on whether the user id is
 * already the DM platform id:
 *
 *   - **Direct-addressable** (Telegram, WhatsApp, iMessage, email, Matrix):
 *     user handle IS the DM chat id. No adapter method needed; we just
 *     mint a messaging_group row with `platform_id = handle`.
 *
 *   - **Resolution-required** (Discord, Slack, Teams, Webex, gChat):
 *     user id and DM channel id are different. The adapter must implement
 *     `openDM(handle)`, which Chat SDK's `chat.openDM` handles for us via
 *     the bridge. The returned channel id becomes the `platform_id`.
 *
 * ## Caching
 *
 * Successful resolutions are persisted in `user_dms (user_id, channel_type
 * → messaging_group_id)`. The cache survives restarts; first-time DMs on a
 * given channel pay one `openDM` round trip, everyone after is a pure DB
 * read.
 *
 * The underlying platform APIs (`POST /users/@me/channels` on Discord,
 * `conversations.open` on Slack, etc.) are idempotent and return the same
 * channel on repeated calls, so re-resolving after a cache miss is always
 * safe — worst case we round-trip redundantly.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import { getMessagingGroup, getMessagingGroupByPlatform, createMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, User } from '../../types.js';
import { getUser } from './db/users.js';
import { getUserDm, upsertUserDm } from './db/user-dms.js';

/**
 * Return a messaging_group usable to DM this user, creating it lazily if
 * needed. Returns null when:
 *   - the user id isn't namespaced (no `kind:handle` prefix)
 *   - the user's channel has no adapter registered
 *   - the channel needs openDM but its adapter doesn't implement it
 *   - openDM throws (platform error, user blocked bot, etc.)
 *
 * Callers should treat null as "this user is unreachable on this channel".
 *
 * `instance` names the adapter instance the DM should belong to — normally
 * the instance of the conversation that prompted it. It matters only when the
 * row has to be created: `createMessagingGroup` stamps `instance =
 * channel_type` for an unset value, and on an install whose bots are all
 * NAMED instances nothing is registered under the bare channel type, so a row
 * created without it is undeliverable by any caller that dispatches on the
 * exact instance key (`getChannelAdapterExact`). Omit it and the previous
 * behavior is unchanged.
 *
 * Known limitation, unchanged here: `user_dms` is keyed
 * (user_id, channel_type), not instance, so a user already cached from one
 * instance keeps that row even when a different instance asks with no
 * instance of its own — an unaddressed caller still gets whichever instance
 * cached first. Widening the cache key is a schema change and out of scope
 * for this fix. A caller that DOES name an instance, though, never receives
 * a cached row stamped with a DIFFERENT one: see the cache-hit check below.
 */
export async function ensureUserDm(userId: string, instance?: string): Promise<MessagingGroup | null> {
  const user = await getUser(userId);
  if (!user) {
    log.warn('ensureUserDm: user not found', { userId });
    return null;
  }

  const { channelType, handle } = parseUserId(user);
  if (!channelType || !handle) {
    log.warn('ensureUserDm: user id not namespaced', { userId });
    return null;
  }

  // Cache hit: existing user_dms row → load and return the messaging_group.
  const cached = await getUserDm(userId, channelType);
  if (cached) {
    const mg = getMessagingGroup(cached.messaging_group_id);
    if (mg) {
      // The cache key is (user_id, channel_type), not instance. A caller
      // that named an instance is about to dispatch delivery on THIS row's
      // exact instance key — handing it a row cached from a DIFFERENT
      // instance would deliver content that originated on bot A through bot
      // B's adapter/identity. Treat that as a miss and re-resolve on the
      // requested instance below; the find-or-create re-caches it, so a
      // user active on two named bots simply alternates which row is
      // cached, always correct for whichever instance is asking. A caller
      // that did NOT name an instance keeps today's behavior unchanged.
      const cachedInstance = mg.instance ?? channelType;
      if (!instance || cachedInstance === instance) return mg;
      log.info('ensureUserDm: cached DM is on a different instance, re-resolving', {
        userId,
        cachedInstance,
        requestedInstance: instance,
      });
    } else {
      // Row points to a deleted messaging_group — fall through and re-resolve.
      log.warn('ensureUserDm: cached row references missing messaging_group, re-resolving', {
        userId,
        messagingGroupId: cached.messaging_group_id,
      });
    }
  }

  // Cache miss: resolve the DM platform_id either via openDM or directly.
  // Resolved through the requested instance when there is one: on Slack the
  // DM channel a bot opens is per-bot, so asking the wrong sibling would
  // return a channel the intended bot cannot post in.
  const dmPlatformId = await resolveDmPlatformId(channelType, handle, instance);
  if (!dmPlatformId) return null;

  // Find-or-create the underlying messaging_group. A DM we received
  // earlier may already have a row matching (channel_type, platform_id).
  //
  // Scoped to the requested instance. Without it this lookup resolves
  // default-instance-first and then the lexically-first NAMED instance, so on
  // a multi-bot direct-addressable channel — where platform_id is the user's
  // handle and therefore identical across bots — it returns a sibling's row
  // and the instance we were asked for is silently discarded. The caller then
  // dispatches on that row's exact instance and reaches the wrong bot. The
  // table is UNIQUE(channel_type, platform_id, instance), so a per-instance
  // row is the intended shape; exact-only here means a miss creates one.
  const now = new Date().toISOString();
  let mg = await getMessagingGroupByPlatform(channelType, dmPlatformId, instance);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      // Unset falls back to `instance = channel_type` in createMessagingGroup,
      // which is right for a single-instance install and undeliverable on a
      // named-instance one — see the doc comment.
      instance,
      platform_id: dmPlatformId,
      name: user.display_name,
      is_group: 0,
      // Deliberately 'strict', NOT the channel's declared DM policy: this row
      // backs a host-initiated DM to a known privileged user (approver,
      // admin). Consulting the declaration would let a 'public' DM
      // declaration open the approval-delivery channel to strangers.
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    // The lookup above yields (async driver), so two cold DMs to the same
    // user can both miss and both insert on the UNIQUE(channel_type,
    // platform_id, instance) key. The loser adopts the winner's row and
    // continues to `upsertUserDm` + delivery, so both callers cache and DM the
    // SAME messaging group rather than one aborting mid-approval.
    const { row: resolved, created } = await insertOrAdopt(mg, createMessagingGroup, () =>
      getMessagingGroupByPlatform(channelType, dmPlatformId, instance),
    );
    mg = resolved;
    if (created) {
      log.info('ensureUserDm: created DM messaging_group', {
        userId,
        channelType,
        instance: mg.instance ?? channelType,
        messagingGroupId: mgId,
      });
    } else {
      log.info('ensureUserDm: adopted concurrently created DM messaging_group', {
        userId,
        channelType,
        instance: mg.instance ?? channelType,
        messagingGroupId: mg.id,
      });
    }
  }

  await upsertUserDm({
    user_id: userId,
    channel_type: channelType,
    messaging_group_id: mg.id,
    resolved_at: now,
  });

  return mg;
}

/**
 * Call the adapter's openDM if it has one; otherwise fall through to using
 * the handle directly. Returns null if the adapter is missing entirely.
 */
async function resolveDmPlatformId(channelType: string, handle: string, instance?: string): Promise<string | null> {
  // getChannelAdapter, not the exact variant: this is one of the
  // channelType-only call sites the fallback exists for, so an unnamed or
  // offline instance still resolves through a sibling rather than failing.
  const adapter = getChannelAdapter(instance ?? channelType);
  if (!adapter) {
    log.warn('ensureUserDm: no adapter for channel', { channelType, instance });
    return null;
  }
  if (!adapter.openDM) {
    // Direct-addressable channel — handle doubles as the DM chat id.
    return handle;
  }
  try {
    return await adapter.openDM(handle);
  } catch (err) {
    log.error('ensureUserDm: adapter.openDM failed', { channelType, handle, err });
    return null;
  }
}

function parseUserId(user: User): { channelType: string; handle: string } | { channelType: null; handle: null } {
  const idx = user.id.indexOf(':');
  if (idx < 0) return { channelType: null, handle: null };
  const prefix = user.id.slice(0, idx);
  const handle = user.id.slice(idx + 1);
  if (!prefix || !handle) return { channelType: null, handle: null };
  // Teams user IDs use a `29:` prefix, not `teams:`. When the id prefix
  // isn't a registered adapter, fall back to user.kind and treat the full
  // id as the handle.
  if (!getChannelAdapter(prefix) && user.kind && getChannelAdapter(user.kind)) {
    return { channelType: user.kind, handle: user.id };
  }
  return { channelType: prefix, handle };
}

/**
 * The channel kind a user is actually reachable on — the same answer
 * `ensureUserDm` resolves internally, exposed for callers that must decide
 * reachability BEFORE paying for a DM resolution.
 *
 * Not the same thing as the user id's prefix. Teams ids carry a Bot Framework
 * `29:` prefix rather than `teams:`, so a caller that splits the id itself
 * reads `29` and compares it against a channel_type of `teams` — the match
 * fails and the approver is dropped before `ensureUserDm` is ever called.
 * Routing that question through `parseUserId` is what keeps the two layers
 * from disagreeing: whatever kind ensureUserDm would DM this user on is the
 * kind reported here.
 *
 * Returns null when the user is unknown or the id is not resolvable to a
 * channel at all — callers should read that as "not reachable on any origin".
 */
export async function resolveUserChannelType(userId: string): Promise<string | null> {
  const user = await getUser(userId);
  if (!user) return null;
  return parseUserId(user).channelType;
}
