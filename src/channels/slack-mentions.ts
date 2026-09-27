/**
 * Slack outbound mention rewriter, sibling to `resolveDiscordMentions`. Slack renders a mention only as `<@USER_ID>`;
 * plain `@name` gets no chip, no notification and no mention wake. Bot user ids come from `auth.test` at factory
 * time.
 * Lookup is scoped to bots sharing the current workspace's `teamId`: bots cannot mention across Slack tenants, and an
 * unscoped match could resolve to another workspace's id.
 */
import { log } from '../log.js';
import { transformInsideInlineCode, transformOutsideProtectedRegions } from '../text-styles.js';

export interface SlackBotIdentity {
  /** The value substituted into `<@…>`. */
  userId: string;
  /**
   * Legacy install-time `user.name` from `auth.test`. Slack's autocomplete prefers `displayName`/`realName` when
   * present, so this alone is not enough.
   */
  username: string;
  /** Per-workspace profile `display_name`, often empty; autocomplete prefers it when set. Registered as an alias. */
  displayName?: string;
  /** Profile `real_name`, autocomplete's fallback when `display_name` is empty. Registered as an alias. */
  realName?: string;
  /** Scopes cross-bot resolution to siblings in the same workspace. */
  teamId: string;
  /** Public slack-edge avatar URL (image_192 preferred); absent until upgradeSlackBotProfile runs. */
  imageUrl?: string;
  /**
   * Workspace base URL from `auth.test`, the only piece of a permalink not in the thread id. Missing degrades to no
   * link, never a wrong one.
   */
  workspaceUrl?: string;
}

const knownSlackBots = new Map<string, SlackBotIdentity>();

/**
 * Workspace humans keyed by teamId, from `users.list` at init and hourly, so agent-emitted `@Alice` resolves without
 * a hand-maintained roster.
 */
const knownSlackHumans = new Map<string, SlackBotIdentity[]>();

export function registerSlackBot(channelType: string, identity: SlackBotIdentity): void {
  knownSlackBots.set(channelType, identity);
}

export function unregisterSlackBot(channelType: string, identity: SlackBotIdentity): void {
  if (knownSlackBots.get(channelType) === identity) knownSlackBots.delete(channelType);
}

export function registerSlackWorkspaceHumans(teamId: string, humans: SlackBotIdentity[]): void {
  knownSlackHumans.set(teamId, humans);
}

export function getKnownSlackBots(): ReadonlyMap<string, SlackBotIdentity> {
  return knownSlackBots;
}

/**
 * Thread permalink, or null when it cannot be built exactly. The query half (`?thread_ts=<ts>&cid=<C>`, as
 * chat.getPermalink returns) is what makes it a THREAD link; `/archives/<C>/p<ts>` alone opens the channel scrolled
 * to the message. Never guesses: an unregistered workspace, an unthreaded destination or a non-ts thread id returns
 * null.
 */
export function slackPermalink(channelType: string, platformId: string, threadId: string | null): string | null {
  if (!threadId) return null;
  const base = knownSlackBots.get(channelType)?.workspaceUrl;
  if (!base) return null;

  const parts = threadId.split(':');
  const ts = parts[parts.length - 1];
  const channel = parts.length >= 2 ? parts[parts.length - 2] : platformId.split(':').pop();
  if (!channel || !/^\d+\.\d+$/.test(ts)) return null;

  return `${base.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}?thread_ts=${ts}&cid=${channel}`;
}

/**
 * Channel link, separate from `slackPermalink`, which is a thread link and declines a null thread id by contract.
 * Null when it cannot be built exactly.
 */
export function slackChannelPermalink(channelType: string, platformId: string): string | null {
  const base = knownSlackBots.get(channelType)?.workspaceUrl;
  const channel = platformId.split(':').pop();
  if (!base || !channel) return null;
  return `${base.replace(/\/+$/, '')}/archives/${channel}`;
}

export function getKnownSlackHumans(): ReadonlyMap<string, SlackBotIdentity[]> {
  return knownSlackHumans;
}

/**
 * Precedence matches Slack's autocomplete: `display_name`, then `real_name`, then the `auth.test` username. Null when
 * the bot is not registered yet (e.g. a spawn racing adapter init); the caller falls through to the next resolver.
 */
export function getSlackBotDisplayName(channelType: string): string | null {
  const bot = knownSlackBots.get(channelType);
  if (!bot) return null;
  return bot.displayName || bot.realName || bot.username || null;
}

/**
 * Chat SDK author fields can keep the app's legacy install-time name after a rename, so trust the live registry, but
 * only within the current bot's workspace.
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
 * Rewrites `@name` and `<@name>` to `<@USER_ID>` for sibling bots and humans in the same workspace. Passes through:
 * canonical `<@U…>`, code and bare-URL regions, unknown names, and other workspaces. Two passes as in
 * `resolveDiscordMentions`: bracketed `<@Name>` first (agents misapplying the `<@U123>` template), then bare `@Name`.
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

  // name → userId, scoped by teamId. `username`, `displayName` and `realName` must all resolve (Slack keeps the
  // install-time username after an app rename), plus separator-normalized aliases of each. Conflicts: literal
  // usernames win, display/real literals fill empty slots, normalized aliases fill what remains; every bot stays
  // mentionable by its own literal.
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
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    tryAddAlias(ident.displayName, ident.userId);
    tryAddAlias(ident.realName, ident.userId);
  }
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
  // Workspace humans, after every bot alias, so bots win any collision. Usernames register before display/real names
  // (usernames are unique per workspace, display names are free text). A display/real alias shared by two humans is
  // dropped rather than first-writer-wins, which would ping the wrong person.
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

  // Mechanical backstop for the release digest's `Who:` owner field, where models drop the `@`. Only that explicit
  // field is treated as names; ordinary prose is untouched.
  const structured = resolveStructuredWhoMentions(text, currentBot.teamId, bots, humans);

  // A base plus optional `.suffix` segments so a sentence-ending period is not captured. `(?<![…/:=?&#])` keeps
  // emails, URL paths, query values and fragments literal (transformOutsideProtectedRegions shields only code).
  // `\p{L}\p{M}\p{N}` match whole Unicode names like `@José`; ASCII `\w` would capture a truncated prefix that could
  // ping the wrong person.
  const WORD = String.raw`\w\p{L}\p{M}\p{N}`;
  const USERNAME = String.raw`[${WORD}-]+(?:\.[${WORD}-]+)*`;
  const BRACKETED_RE = new RegExp(String.raw`(?<![${WORD}/:=?&#])<@(${USERNAME})>`, 'gu');
  const BARE_RE = new RegExp(String.raw`(?<![${WORD}/:=?&#])@(${USERNAME})`, 'gu');

  const botNameById = new Map<string, string>();
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    botNameById.set(ident.userId, (ident.displayName || ident.realName || ident.username).toLowerCase());
  }

  const resolved = transformOutsideProtectedRegions(structured, (segment) => {
    const rewriteByName = (match: string, name: string): string => {
      // Already a canonical Slack user id.
      if (/^U[A-Z0-9]{7,}$/.test(name)) return match;
      const literal = name.toLowerCase();
      // Literal first so an exact handle always beats a fuzzy collision.
      const id = byName.get(literal) ?? byName.get(normalizeHandle(literal));
      return id ? `<@${id}>` : match;
    };

    const afterBracketed = segment.replace(BRACKETED_RE, rewriteByName);
    return afterBracketed.replace(BARE_RE, (match, name: string, offset: number) => {
      // Pass 1 already handled bracketed forms.
      if (offset > 0 && afterBracketed[offset - 1] === '<') return match;
      return rewriteByName(match, name);
    });
  });

  // Known same-workspace BOT ids inside inline code become the plain typed name (agents copy the raw form into
  // gate-syntax examples, which humans cannot read or type). Unknown and human ids pass through; fenced blocks are
  // untouched. The map is the gate, not the pattern.
  return transformInsideInlineCode(resolved, (inner) =>
    inner.replace(/<@([^<>\s]+)>/g, (match, id: string) => {
      const name = botNameById.get(id);
      return name ? `@${name}` : match;
    }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Only inside an explicit `Who:` field. Alias conflicts fail closed: a name two identities claim stays plain text. */
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
 * Slack resets an ordered list across the digest template's blank separators, renumbering every item `1.`. Removes
 * only blanks followed by another ordered item and indents unindented detail markers; the blank before the next
 * section stays.
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

/** Strips `-`, `_`, `.` for fuzzy matching, used only after a literal lookup misses. */
function normalizeHandle(handle: string): string {
  return handle.replace(/[-_.]/g, '');
}

/**
 * One `auth.test` call at init, cached for the process. Hard timeout because channel-registry awaits factories
 * serially, so a stalled call at boot would block every later adapter.
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
          image_192?: string;
          image_72?: string;
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
 * Adds `display_name`, `real_name` and the avatar from `users.info` to an already-registered identity.
 * Fire-and-forget: adapters init serially, so awaiting would add up to 5s per workspace to boot. Without these
 * aliases, the name operators actually type (autocomplete resolves against profile fields, not `auth.test.user`)
 * ships as plain text.
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
    const imageUrl = profile?.image_192 || profile?.image_72 || undefined;
    if (!displayName && !realName && !imageUrl) return;
    // Re-read in case the entry changed meanwhile.
    const current = knownSlackBots.get(channelType);
    if (!current) return;
    registerSlackBot(channelType, { ...current, displayName, realName, imageUrl });
  } catch (err) {
    log.warn('Slack users.info fetch failed — outbound @-mentions limited to username only', {
      channelType,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Inbound raw-id resolution: Slack wire text carries mentions as `<@U…>` (or `<@U…|label>`), and agents that read the
 * raw form echo it back. Resolving inbound means agents only ever see `@name`. Scoped to the workspace's known bots
 * and humans; unknown ids pass through (better opaque than a wrong name).
 */
/**
 * Blanks out Slack code regions so mention detection only sees prose. A fence (3+ backticks) closes only at a run at
 * least as long as its opener (CommonMark's rule); an unterminated fence runs to the end. A 1-2 backtick span closes
 * at the next run of exactly the same length on the same line. Tildes are NOT fences: Slack has no `~~~` syntax, so a
 * tilde-wrapped mention still pings.
 */
function stripSlackCodeRegions(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== '`') {
      out += text[i];
      i++;
      continue;
    }
    let j = i;
    while (j < n && text[j] === '`') j++;
    const runLen = j - i;

    if (runLen >= 3) {
      let k = j;
      let closeEnd = -1;
      while (k < n) {
        if (text[k] !== '`') {
          k++;
          continue;
        }
        let m = k;
        while (m < n && text[m] === '`') m++;
        if (m - k >= runLen) {
          closeEnd = m;
          break;
        }
        k = m;
      }
      out += ' ';
      i = closeEnd === -1 ? n : closeEnd; // An unterminated fence: the rest is code.
      continue;
    }

    let k = j;
    let closeStart = -1;
    let closeEnd = -1;
    while (k < n && text[k] !== '\n') {
      if (text[k] !== '`') {
        k++;
        continue;
      }
      let m = k;
      while (m < n && text[m] === '`') m++;
      if (m - k === runLen) {
        closeStart = k;
        closeEnd = m;
        break;
      }
      k = m;
    }
    if (closeStart === -1) {
      // No same-length closer on this line: keep the backticks as literal text.
      out += text.slice(i, j);
      i = j;
    } else {
      out += ' ';
      i = closeEnd;
    }
  }
  return out;
}

/**
 * True when the bot's mention appears outside code. Slack fires app_mention even for `@name` inside backticks, which
 * would wake mention-mode agents off their own documentation. Raw ids are already resolved to @name here, so both
 * forms are checked.
 */
export function slackMentionOutsideCode(text: string, identity: SlackBotIdentity): boolean {
  const outsideCode = stripSlackCodeRegions(text);
  if (outsideCode.includes(`<@${identity.userId}>`)) return true;
  const lower = outsideCode.toLocaleLowerCase('en-US');
  return [identity.displayName, identity.realName, identity.username]
    .filter((name): name is string => !!name)
    .some((name) => lower.includes(`@${name.toLocaleLowerCase('en-US')}`));
}

export function resolveInboundSlackIds(text: string, channelType: string): string {
  // Chat SDK can pass either raw `<@U…>` or its flattened `@U…` form; both must be handled.
  if (!text.includes('<@') && !/@U[A-Z0-9_-]{2,}/u.test(text)) return text;
  const self = knownSlackBots.get(channelType);
  // Fail closed to pass-through: without this workspace's identity there is no teamId, and an unscoped rewrite could
  // name another workspace's bot.
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
