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
import { transformInsideInlineCode, transformOutsideProtectedRegions } from '../text-styles.js';

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
  /**
   * Workspace base URL as reported by `auth.test` (`https://acme.slack.com/`).
   * The only piece a thread permalink needs that isn't already in a thread id,
   * and it arrives free on a call the adapter already makes at init. Optional:
   * an older cached identity or a stubbed client may not carry it, and a
   * missing URL degrades to no link rather than a wrong one.
   */
  workspaceUrl?: string;
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

/**
 * Slack thread permalink, or null when one can't be built exactly.
 *
 * A thread id already carries both halves Slack needs — channel and the
 * parent message `ts` (`slack:C0AAA:1786621514.008659`) — and the workspace
 * base URL rides along on the identity captured at adapter init. Slack's own
 * link form drops the dot from the ts:
 * `https://acme.slack.com/archives/C0AAA/p1786621514008659`.
 *
 * Returns null rather than guessing. A link that 404s is worse than no link,
 * so an unregistered workspace, a channel-level (unthreaded) destination, or
 * a thread id that isn't a Slack ts all decline instead of improvising.
 */
export function slackPermalink(channelType: string, platformId: string, threadId: string | null): string | null {
  if (!threadId) return null;
  const base = knownSlackBots.get(channelType)?.workspaceUrl;
  if (!base) return null;

  const parts = threadId.split(':');
  const ts = parts[parts.length - 1];
  const channel = parts.length >= 2 ? parts[parts.length - 2] : platformId.split(':').pop();
  if (!channel || !/^\d+\.\d+$/.test(ts)) return null;

  return `${base.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
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
 * Resolve a sibling bot author to the name users see in this Slack workspace.
 *
 * Chat SDK author fields can retain the app's legacy install-time name even
 * after the bot profile is renamed. Trust the live bot registry instead, but
 * only inside the current bot's workspace so a matching Slack user id from a
 * different tenant can never acquire the wrong name.
 */
export function getSlackBotSenderName(channelType: string, userId: string): string | null {
  const self = knownSlackBots.get(channelType);
  if (!self) return null;
  for (const bot of knownSlackBots.values()) {
    if (bot.teamId === self.teamId && bot.userId === userId) {
      return bot.displayName || bot.realName || bot.username || null;
    }
  }
  return null;
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

  // The release-digest contract uses a structured `Who:` field. Models have
  // repeatedly emitted the correct human names there while dropping the `@`
  // required to make them real Slack mentions (the same post then mentions
  // those people correctly elsewhere). Treat only this explicit owner field
  // as semantic: unambiguous live-workspace names become canonical mentions;
  // ordinary prose is untouched. This is a mechanical backstop for the
  // contract, not a general "guess names and ping people" pass.
  const structured = resolveStructuredWhoMentions(text, currentBot.teamId, bots, humans);

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
  // The lookbehind also excludes URL-structural chars (`=?&#` on top of
  // `/:`) so `?owner=@alice`, `&cc=@alice`, and `#@alice` fragments inside
  // URLs stay literal — `transformOutsideProtectedRegions` shields only
  // code spans, so URL safety lives here.
  const WORD = String.raw`\w\p{L}\p{M}\p{N}`;
  const USERNAME = String.raw`[${WORD}-]+(?:\.[${WORD}-]+)*`;
  const BRACKETED_RE = new RegExp(String.raw`(?<![${WORD}/:=?&#])<@(${USERNAME})>`, 'gu');
  const BARE_RE = new RegExp(String.raw`(?<![${WORD}/:=?&#])@(${USERNAME})`, 'gu');

  // Bot-ID → name map for the inline-code normalization pass below.
  const botNameById = new Map<string, string>();
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    botNameById.set(ident.userId, (ident.displayName || ident.realName || ident.username).toLowerCase());
  }

  const resolved = transformOutsideProtectedRegions(structured, (segment) => {
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

  // Agents write gate-syntax examples in inline code and — taught by their
  // own thread transcripts — sometimes use the raw bot ID form
  // (`<@U…> ship 297`), which humans can't read or type. Normalize known
  // same-workspace BOT IDs inside inline code back to the plain typed name.
  // Unknown IDs and human IDs pass through (a deliberate raw-ID display in
  // a debugging discussion keeps its meaning); fenced blocks are untouched.
  // Broad capture, narrow rewrite: anything `<@…>`-shaped is looked up, but
  // only a registered same-team bot ID is replaced — the map is the gate,
  // not the pattern.
  return transformInsideInlineCode(resolved, (inner) =>
    inner.replace(/<@([^<>\s]+)>/g, (match, id: string) => {
      const name = botNameById.get(id);
      return name ? `@${name}` : match;
    }),
  );
}

/** Escape a literal value before embedding it in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve names only inside an explicit `Who:` owner field. Alias conflicts
 * fail closed: if two workspace identities claim the same visible name, the
 * name remains plain text instead of pinging the wrong person.
 */
function resolveStructuredWhoMentions(
  text: string,
  teamId: string,
  bots: ReadonlyMap<string, SlackBotIdentity>,
  humans: ReadonlyMap<string, SlackBotIdentity[]>,
): string {
  if (!/^\s*(?:[-*◦•]\s+)?(?:\*\*)?Who(?::(?:\*\*)?|\*\*:)/imu.test(text)) return text;

  const claims = new Map<string, { alias: string; userId: string }>();
  const ambiguous = new Set<string>();
  const claim = (alias: string | undefined, userId: string): void => {
    const literal = alias?.trim();
    if (!literal) return;
    const key = literal.toLocaleLowerCase();
    const prior = claims.get(key);
    if (prior && prior.userId !== userId) {
      ambiguous.add(key);
      return;
    }
    claims.set(key, { alias: literal, userId });
  };
  for (const identity of bots.values()) {
    if (identity.teamId !== teamId) continue;
    claim(identity.username, identity.userId);
    claim(identity.displayName, identity.userId);
    claim(identity.realName, identity.userId);
  }
  for (const identity of humans.get(teamId) ?? []) {
    claim(identity.username, identity.userId);
    claim(identity.displayName, identity.userId);
    claim(identity.realName, identity.userId);
  }

  const aliases = [...claims.entries()]
    .filter(([key]) => !ambiguous.has(key))
    .map(([, value]) => value)
    .sort((left, right) => right.alias.length - left.alias.length);
  if (aliases.length === 0) return text;

  return transformOutsideProtectedRegions(text, (segment) =>
    segment.replace(
      /^(\s*(?:[-*◦•]\s+)?(?:\*\*)?Who(?::(?:\*\*)?|\*\*:)\s*)(.*)$/gimu,
      (_line, prefix: string, owners: string) => {
        // Preserve canonical Slack mentions already present in the field.
        const parts = owners.split(/(<@[^>\n]+>)/g);
        for (let i = 0; i < parts.length; i += 2) {
          let plain = parts[i];
          for (const { alias, userId } of aliases) {
            const literal = escapeRegExp(alias);
            const re = new RegExp(String.raw`(?<![@\p{L}\p{M}\p{N}\w])${literal}(?![\p{L}\p{M}\p{N}\w])`, 'giu');
            plain = plain.replace(re, `<@${userId}>`);
          }
          parts[i] = plain;
        }
        return prefix + parts.join('');
      },
    ),
  );
}

/**
 * Keep ordered digest items in one Slack Markdown list when their detail lines
 * use the release template's visible `•`/`◦` marker. Slack resets an ordered
 * list across the template's blank item separators, rendering each explicit
 * number as `1.`. Remove only blanks whose next nonblank line is another
 * ordered item, and indent any unindented detail markers. The blank separating
 * the list from the following section is preserved.
 */
export function normalizeSlackOrderedListContinuations(text: string): string {
  const lines = text.split('\n');
  let insideOrderedList = false;
  const normalized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\d+\.\s+\S/u.test(line)) {
      insideOrderedList = true;
      normalized.push(line);
      continue;
    }
    if (!insideOrderedList) {
      normalized.push(line);
      continue;
    }
    if (/^[◦•]\s+\S/u.test(line)) {
      normalized.push(`   ${line}`);
      continue;
    }
    if (/^\s+\S/u.test(line)) {
      normalized.push(line);
      continue;
    }
    if (/^\s*$/u.test(line)) {
      const nextNonblank = lines.slice(index + 1).find((candidate) => /\S/u.test(candidate));
      if (nextNonblank && /^\d+\.\s+\S/u.test(nextNonblank)) continue;
    }
    insideOrderedList = false;
    normalized.push(line);
  }
  return normalized.join('\n');
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
      url?: string;
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
    return { userId: res.user_id, username: res.user, teamId: res.team_id, workspaceUrl: res.url };
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

/**
 * Inbound raw-id resolution. Slack wire text carries mentions as `<@U…>` (or
 * `<@U…|label>`), and unlike Discord the bridge never resolved them — so
 * every agent reading a channel where humans type gate syntax ("@skipper
 * hold 304" arrives as "<@U…> hold 304") learns the raw form and echoes it
 * back into its own output. Resolving inbound kills the echo at its origin:
 * agents only ever see `@name`, so `@name` is the only form they reproduce.
 * Scoped to the workspace's known bots and humans; unknown ids pass through
 * untouched (better a raw id the model treats as opaque than a wrong name).
 */
/**
 * True when the bot's mention appears OUTSIDE code regions of the inbound
 * text. Slack's markdown_text parser fires app_mention even for a literal
 * `@name` inside backticks (documented gate syntax like \`@gatebot ship 42\`),
 * so the platform's isMention alone wakes mention-mode agents off their own
 * documentation. Inbound text at this point has raw ids already resolved to
 * @name (resolveInboundSlackIds), so both forms are checked.
 */
export function slackMentionOutsideCode(text: string, identity: SlackBotIdentity): boolean {
  const outsideCode = text.replace(/(`{3,}[\s\S]*?`{3,}|``[\s\S]*?``|`[^`\n]+`)/g, ' ');
  if (outsideCode.includes(`<@${identity.userId}>`)) return true;
  const lower = outsideCode.toLocaleLowerCase('en-US');
  return [identity.displayName, identity.realName, identity.username]
    .filter((name): name is string => !!name)
    .some((name) => lower.includes(`@${name.toLocaleLowerCase('en-US')}`));
}

export function resolveInboundSlackIds(text: string, channelType: string): string {
  // Chat SDK's inbound parser can hand this seam either Slack's raw
  // `<@U…>` token or its already-flattened `@U…` form. Supporting only the
  // former left thread-history context contaminated with raw bot IDs even
  // after the original inbound fix.
  if (!text.includes('<@') && !/@U[A-Z0-9_-]{2,}/u.test(text)) return text;
  const self = knownSlackBots.get(channelType);
  // Fail closed to pass-through: without this workspace's own identity there
  // is no teamId to scope by, and an unscoped loop would rewrite a pasted
  // foreign raw id to ANOTHER workspace's bot name — an isolation violation
  // worse than the raw id it hides.
  if (!self) return text;
  const teamId = self.teamId;
  let out = text;
  const substitute = (identity: SlackBotIdentity, name: string | undefined): void => {
    if (!name) return;
    const id = escapeRegExp(identity.userId);
    out = out.replace(new RegExp(`<@${id}(\\|[^>]*)?>`, 'g'), `@${name}`);
    out = out.replace(new RegExp(`(?<![\\w])@${id}(?![A-Z0-9_-])`, 'g'), `@${name}`);
  };
  for (const bot of knownSlackBots.values()) {
    if (teamId && bot.teamId !== teamId) continue;
    substitute(bot, bot.displayName || bot.realName || bot.username);
  }
  if (teamId) {
    for (const human of knownSlackHumans.get(teamId) ?? []) {
      substitute(human, human.displayName || human.realName || human.username);
    }
  }
  return out;
}
