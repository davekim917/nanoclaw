/**
 * Slack outbound mention rewriter — sibling to `resolveDiscordMentions`
 * in discord.ts. Discord's adapter has had this since the sibling-handoff
 * work; Slack didn't, which meant agent-emitted `@helper-codex` rendered
 * as plain text on Slack (no chip, no notification, peer doesn't get a
 * mention-engage wake — it only wakes because the channel's full feed
 * reaches it anyway).
 *
 * Slack requires `<@USER_ID>` (a real Slack user ID like `UTEST00021`)
 * to render a mention. The bot user IDs are discovered via `auth.test`
 * at factory time and cached in `knownSlackBots`.
 *
 * Cross-workspace isolation: bots in workspace A can't @-mention bots in
 * workspace B (different Slack tenants). Lookup is scoped to bots that
 * share the current workspace's `teamId`. Without this scoping, an agent
 * in Example Retail's Slack writing `@helper-codex` (an Example Labs bot) could resolve
 * to a stale or wrong user ID.
 */
import { log } from '../log.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';

export interface SlackBotIdentity {
  /** Slack user_id, e.g. "UTEST00021" — the value to substitute into `<@…>`. */
  userId: string;
  /**
   * Slack `user.name` field as returned by `auth.test` — the legacy username
   * fixed at app install time. Slack's UI autocomplete does NOT prefer this
   * field when `displayName` or `realName` are present, so it's necessary
   * but not sufficient for the rewriter on its own (e.g. Example Assistant has `name=beau`
   * but operators @-mention it as `@beacon`).
   */
  username: string;
  /**
   * Profile `display_name` (per-workspace customizable, often empty). When
   * present, Slack's UI autocomplete prefers this over `username` and
   * `realName`. Registered as a rewriter alias.
   */
  displayName?: string;
  /**
   * Profile `real_name`, e.g. "Example Assistant" or "Example Assistant Codex". Slack falls back to this
   * for autocomplete when `display_name` is empty. The user-facing handle
   * Operator actually types in Slack typically matches this lowercased.
   * Registered as a rewriter alias.
   */
  realName?: string;
  /** Slack workspace identifier (team_id). Used to scope cross-bot resolution to siblings in the same workspace. */
  teamId: string;
}

const knownSlackBots = new Map<string, SlackBotIdentity>();

/**
 * Workspace humans, keyed by teamId. Populated from `users.list` at adapter
 * init (and refreshed hourly) so agent-emitted `@Alice` / `<@bob>` resolve
 * to real mentions without any hand-maintained roster. Same identity shape
 * as bots; resolution is scoped to the current workspace like bots are.
 */
const knownSlackHumans = new Map<string, SlackBotIdentity[]>();

export function registerSlackBot(channelType: string, identity: SlackBotIdentity): void {
  knownSlackBots.set(channelType, identity);
}

export function registerSlackWorkspaceHumans(teamId: string, humans: SlackBotIdentity[]): void {
  knownSlackHumans.set(teamId, humans);
}

export function getKnownSlackBots(): ReadonlyMap<string, SlackBotIdentity> {
  return knownSlackBots;
}

export function getKnownSlackHumans(): ReadonlyMap<string, SlackBotIdentity[]> {
  return knownSlackHumans;
}

/**
 * Resolve the bot's user-facing display name for a Slack channel_type.
 * Precedence matches what Slack's UI itself uses for @-mention autocomplete:
 *   1. `profile.display_name` (per-workspace customizable; preferred)
 *   2. `profile.real_name` (autocomplete fallback when display_name is empty)
 *   3. `auth.test.user` (legacy install-time username, last resort)
 *
 * Returns null when the bot isn't registered (yet) — e.g. a spawn that
 * races adapter init before auth.test completes, or an admin/cli session
 * with no Slack adapter. The caller (`resolveAssistantName` in
 * container-runner) treats null as "fall through to the next platform
 * resolver or the agent_group.name floor".
 */
export function getSlackBotDisplayName(channelType: string): string | null {
  const bot = knownSlackBots.get(channelType);
  if (!bot) return null;
  return bot.displayName || bot.realName || bot.username || null;
}

/**
 * Rewrite `@beacont-username` and `<@beacont-username>` to Slack's canonical
 * `<@USER_ID>` mention syntax for every sibling bot that lives in the
 * same Slack workspace as `currentChannelType`.
 *
 * Pass-through cases (intentional):
 *   - `<@UTEST00021>` (already canonical) — left alone; the user-id
 *     character class doesn't match a username, so the lookup misses
 *     and the original text is preserved.
 *   - Mentions inside code/links — `transformOutsideProtectedRegions`
 *     skips fenced code, inline code, and bare-URL regions.
 *   - Unknown @-names — pass through as plain text (fail-soft).
 *   - Mentions of bots in a different Slack workspace — scoped out by teamId.
 *
 * Two-pass design mirrors `resolveDiscordMentions`:
 *   1. `<@Name>` bracketed form (agents sometimes emit when they
 *      recall the `<@U123>` template but substitute the username).
 *   2. `@Name` canonical bare form per container/CLAUDE.md guidance.
 */
export function resolveSlackMentions(
  text: string,
  currentChannelType: string,
  bots: ReadonlyMap<string, SlackBotIdentity> = knownSlackBots,
  humans: ReadonlyMap<string, SlackBotIdentity[]> = knownSlackHumans,
): string {
  if (bots.size === 0) return text;

  const currentBot = bots.get(currentChannelType);
  if (!currentBot) return text;

  // Build name → userId map scoped to the current Slack workspace (matches
  // by teamId). Includes the current bot itself — harmless because
  // self-mentions are filtered by Slack's own UI ("you can't @-mention
  // yourself") and re-trigger by the adapter's echo filter on the inbound
  // side.
  //
  // Three Slack identity fields all need to resolve to the same user_id:
  //
  //   1. `username` (`user.name` from auth.test) — legacy install-time
  //      handle. Stays even if the operator renames the App's Default Name
  //      in the App config. e.g. Example Assistant's `name` is `beau` because that was the
  //      original install name; renaming the App to "Example Assistant" doesn't propagate
  //      to existing bot user records.
  //   2. `displayName` — per-workspace customizable. When set, Slack's UI
  //      autocomplete prefers this over `name` and `realName`.
  //   3. `realName` — Slack's autocomplete fallback when `displayName` is
  //      empty. The user-facing handle Operator actually sees in Slack
  //      typically matches this (lowercased). e.g. Example Assistant's `real_name` is "Example Assistant"
  //      and that's what `@beacon` autocompletes against in Example Retail Slack.
  //
  // Plus separator-normalized aliases of each (`example-assistant-codex` ↔ `example-assistant-codex` ↔
  // `example-assistant-codex`) for operator-typed handles that drop hyphens/underscores.
  //
  // Conflict resolution: literal `username` keys win (they match the
  // canonical Slack handle exactly). `displayName`/`realName` literals
  // fill empty slots. Normalized variants fill remaining empty slots only.
  // Both bots in any A/B collision remain individually mentionable via
  // their own literals; only the "fuzzy" path may be claimed by one side.
  const byName = new Map<string, string>();
  const literalKeys = new Set<string>();
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    const username = ident.username.toLowerCase();
    byName.set(username, ident.userId);
    literalKeys.add(username);
  }
  const tryAddAlias = (alias: string | undefined, userId: string): void => {
    if (!alias) return;
    const lower = alias.toLowerCase();
    if (!lower) return;
    if (literalKeys.has(lower)) return;
    if (byName.has(lower)) return;
    byName.set(lower, userId);
  };
  // Second pass: displayName + realName literals.
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    tryAddAlias(ident.displayName, ident.userId);
    tryAddAlias(ident.realName, ident.userId);
  }
  // Third pass: separator-normalized aliases of every populated field.
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    for (const candidate of [ident.username, ident.displayName, ident.realName]) {
      if (!candidate) continue;
      const literal = candidate.toLowerCase();
      const normalized = normalizeHandle(literal);
      if (normalized === literal) continue;
      tryAddAlias(normalized, ident.userId);
    }
  }
  // Fourth pass: workspace humans (from users.list). All human aliases go
  // through tryAddAlias, so every bot alias — literal or normalized — wins
  // any collision with a human handle. Same-team scoping as bots.
  //
  // Usernames register before display/real names: Slack guarantees usernames
  // unique per workspace, display names are free-text — an earlier user's
  // display name must never capture a later user's canonical username. And a
  // display/real alias shared by two different humans is dropped entirely
  // rather than first-writer-wins, which would silently ping the wrong person
  // half the time.
  const teamHumans = humans.get(currentBot.teamId) ?? [];
  for (const ident of teamHumans) tryAddAlias(ident.username, ident.userId);
  const humanClaims = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  const claimHumanAlias = (alias: string | undefined, userId: string): void => {
    if (!alias) return;
    const lower = alias.toLowerCase();
    if (!lower) return;
    const prior = humanClaims.get(lower);
    if (prior !== undefined && prior !== userId) {
      ambiguousAliases.add(lower);
      return;
    }
    humanClaims.set(lower, userId);
  };
  for (const ident of teamHumans) {
    claimHumanAlias(ident.displayName, ident.userId);
    claimHumanAlias(ident.realName, ident.userId);
    for (const candidate of [ident.username, ident.displayName, ident.realName]) {
      if (!candidate) continue;
      const normalized = normalizeHandle(candidate.toLowerCase());
      if (normalized !== candidate.toLowerCase()) claimHumanAlias(normalized, ident.userId);
    }
  }
  for (const [alias, userId] of humanClaims) {
    if (!ambiguousAliases.has(alias)) tryAddAlias(alias, userId);
  }
  if (byName.size === 0) return text;

  // Slack usernames allow `[a-z0-9._-]` per Slack's user-handle rules.
  // Composed as a base + optional `.SUFFIX` segments so a trailing
  // sentence-ending period ("Your turn, @helper-codex.") doesn't get
  // gobbled into the capture — matches Discord's pattern in discord.ts:328.
  //
  // Boundary: `(?<![\w/:])` keeps `user@domain.com` from parsing as
  // `@domain.com` AND skips `@`-after-URL-path/scheme cases like
  // `https://example.com/@helper-codex` or `path/@helper-codex/sub`. Without
  // the `/` and `:` in the exclude class, the bare-mention pass corrupts
  // URLs (path char `/` is not `\w`, so `(?<!\w)` alone would let it
  // through). `transformOutsideProtectedRegions` only shields code spans,
  // not URL regions — so URL safety has to live in the lookbehind itself.
  // `\p{L}\p{M}\p{N}` widen `\w` to Unicode letters (accents via combining
  // marks, CJK) so human display names like `@José` match whole — ASCII-only
  // `\w` would capture `@Jos`, and a truncated prefix that happens to be a
  // registered alias would ping the wrong person. Same classes in the
  // lookbehind so a mention can't start mid-word after a Unicode letter.
  const WORD = String.raw`\w\p{L}\p{M}\p{N}`;
  const USERNAME = String.raw`[${WORD}-]+(?:\.[${WORD}-]+)*`;
  const BRACKETED_RE = new RegExp(String.raw`(?<![${WORD}/:])<@(${USERNAME})>`, 'gu');
  const BARE_RE = new RegExp(String.raw`(?<![${WORD}/:])@(${USERNAME})`, 'gu');

  return transformOutsideProtectedRegions(text, (segment) => {
    const rewriteByName = (match: string, name: string): string => {
      // Skip names that look like Slack user IDs (`U…` followed by 8+
      // uppercase alphanumerics) — those are already canonical and shouldn't
      // be looked up as usernames.
      if (/^U[A-Z0-9]{7,}$/.test(name)) return match;
      const literal = name.toLowerCase();
      // Literal first so an exact operator-chosen Slack handle always wins
      // over a fuzzy collision; fall back to separator-normalized lookup.
      const id = byName.get(literal) ?? byName.get(normalizeHandle(literal));
      return id ? `<@${id}>` : match;
    };

    const afterBracketed = segment.replace(BRACKETED_RE, rewriteByName);
    return afterBracketed.replace(BARE_RE, (match, name: string, offset: number) => {
      // Skip if `@` is preceded by `<` — pass 1 already handled bracketed
      // forms, and `<@USER_ID>` / `<#CHANNEL>` syntax stays untouched.
      if (offset > 0 && afterBracketed[offset - 1] === '<') return match;
      return rewriteByName(match, name);
    });
  });
}

/**
 * Strip Slack-handle separators (`-`, `_`, `.`) so `example-assistant-codex` ≡ `example-assistant-codex` ≡
 * `example-assistant-codex` for fuzzy matching. Used only as a fallback after literal
 * lookup misses — never replaces literal equality.
 */
function normalizeHandle(handle: string): string {
  return handle.replace(/[-_.]/g, '');
}

/**
 * Look up this bot's identity via Slack's `auth.test` endpoint. One round
 * trip on adapter init; the result is cached in `knownSlackBots` for the
 * lifetime of the process.
 *
 * Hard timeout: channel-registry awaits factories serially, so a stalled
 * Slack API connection at host boot would block every adapter that
 * registers after Slack. 5s is well above Slack's typical p99 for this
 * endpoint and short enough that a hung connection doesn't visibly delay
 * startup.
 */
const SLACK_AUTH_TIMEOUT_MS = 5000;

interface SlackAuthTestClient {
  auth: {
    test(): Promise<{
      ok?: boolean;
      user_id?: string;
      user?: string;
      team_id?: string;
    }>;
  };
  users?: {
    info(args: { user: string }): Promise<{
      ok?: boolean;
      user?: {
        name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
        };
      };
    }>;
  };
}

export async function fetchSlackBotIdentity(client: SlackAuthTestClient): Promise<SlackBotIdentity | null> {
  try {
    const authRacer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Slack auth.test timed out after ${SLACK_AUTH_TIMEOUT_MS}ms`)),
        SLACK_AUTH_TIMEOUT_MS,
      ),
    );
    const res = await Promise.race([client.auth.test(), authRacer]);
    if (!res.ok || !res.user_id || !res.user || !res.team_id) {
      log.warn('Slack auth.test returned incomplete identity — outbound @-mentions for this bot will not resolve', {
        ok: res.ok,
        hasUserId: !!res.user_id,
        hasUser: !!res.user,
        hasTeamId: !!res.team_id,
      });
      return null;
    }
    return { userId: res.user_id, username: res.user, teamId: res.team_id };
  } catch (err) {
    log.warn('Slack bot identity fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Best-effort upgrade for an already-registered bot identity: fetch
 * `profile.display_name` + `profile.real_name` via `users.info` and rewrite
 * the existing registry entry to include them.
 *
 * Fire-and-forget — call from the adapter factory with `void`. Channel
 * adapters init serially during host boot, so awaiting this would extend
 * boot latency by up to 5s per Slack workspace when Slack's profile API is
 * slow (codex P2 review on PR #111). Running it after `registerSlackBot` lets
 * the rewriter already resolve outbound mentions on the `username` key
 * while the profile call fans out in the background; once the profile
 * arrives, the registry entry gains `displayName` + `realName` aliases.
 *
 * Why the profile fields matter: Slack's UI autocomplete resolves
 * @-mentions against `profile.display_name` (preferred when set) or
 * `profile.real_name` (fallback), NOT `auth.test.user`. Example Assistant's
 * `auth.test.user` is the legacy `legacybot` but operators type `@beacon` in Slack
 * because `profile.real_name` is "Example Assistant". Without the alias, an outbound
 * `@beacon` ships as plain text.
 */
export async function upgradeSlackBotProfile(
  client: Pick<SlackAuthTestClient, 'users'>,
  channelType: string,
): Promise<void> {
  const identity = knownSlackBots.get(channelType);
  if (!identity) return;
  if (!client.users?.info) return;
  try {
    const profileRacer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Slack users.info timed out after ${SLACK_AUTH_TIMEOUT_MS}ms`)),
        SLACK_AUTH_TIMEOUT_MS,
      ),
    );
    const profileRes = await Promise.race([client.users.info({ user: identity.userId }), profileRacer]);
    if (!profileRes.ok || !profileRes.user) return;
    const profile = profileRes.user.profile;
    const displayName = profile?.display_name || undefined;
    const realName = profile?.real_name || undefined;
    if (!displayName && !realName) return;
    // Re-register with augmented identity. Re-read first in case another
    // call to registerSlackBot happened in the meantime (unlikely — adapter
    // factories only register once — but defensive against future callers).
    const current = knownSlackBots.get(channelType);
    if (!current) return;
    registerSlackBot(channelType, { ...current, displayName, realName });
  } catch (err) {
    log.warn('Slack users.info fetch failed — outbound @-mentions limited to username only', {
      channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
