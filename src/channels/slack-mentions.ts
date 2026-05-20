/**
 * Slack outbound mention rewriter — sibling to `resolveDiscordMentions`
 * in discord.ts. Discord's adapter has had this since the sibling-handoff
 * work; Slack didn't, which meant agent-emitted `@illie-codex` rendered
 * as plain text on Slack (no chip, no notification, peer doesn't get a
 * mention-engage wake — it only wakes because the channel's full feed
 * reaches it anyway).
 *
 * Slack requires `<@USER_ID>` (a real Slack user ID like `U0AKALV5HRP`)
 * to render a mention. The bot user IDs are discovered via `auth.test`
 * at factory time and cached in `knownSlackBots`.
 *
 * Cross-workspace isolation: bots in workspace A can't @-mention bots in
 * workspace B (different Slack tenants). Lookup is scoped to bots that
 * share the current workspace's `teamId`. Without this scoping, an agent
 * in MR's Slack writing `@illie-codex` (an Illysium bot) could resolve
 * to a stale or wrong user ID.
 */
import { log } from '../log.js';
import { transformOutsideProtectedRegions } from '../text-styles.js';

export interface SlackBotIdentity {
  /** Slack user_id, e.g. "U0AKALV5HRP" — the value to substitute into `<@…>`. */
  userId: string;
  /** Slack username (display handle), e.g. "illie-codex" — case-insensitive lookup. */
  username: string;
  /** Slack workspace identifier (team_id). Used to scope cross-bot resolution to siblings in the same workspace. */
  teamId: string;
}

const knownSlackBots = new Map<string, SlackBotIdentity>();

export function registerSlackBot(channelType: string, identity: SlackBotIdentity): void {
  knownSlackBots.set(channelType, identity);
}

export function getKnownSlackBots(): ReadonlyMap<string, SlackBotIdentity> {
  return knownSlackBots;
}

/**
 * Rewrite `@bot-username` and `<@bot-username>` to Slack's canonical
 * `<@USER_ID>` mention syntax for every sibling bot that lives in the
 * same Slack workspace as `currentChannelType`.
 *
 * Pass-through cases (intentional):
 *   - `<@U0AKALV5HRP>` (already canonical) — left alone; the user-id
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
): string {
  if (bots.size === 0) return text;

  const currentBot = bots.get(currentChannelType);
  if (!currentBot) return text;

  // Build username → userId map scoped to the current Slack workspace
  // (matches by teamId). Includes the current bot itself — harmless because
  // self-mentions are filtered by Slack's own UI ("you can't @-mention
  // yourself") and re-trigger by the adapter's echo filter on the inbound
  // side.
  //
  // Each bot contributes TWO keys: its literal lowercase username AND a
  // separator-stripped form (`bo-codex` ↔ `bocodex`). Slack usernames are
  // operator-typed when the app is created, so they often diverge from the
  // logical name the agent emits — e.g. agent_group `madison-reed-codex`
  // ends up as Slack username `bocodex` (no hyphen) because the operator
  // typed it that way. The agent (per CLAUDE.md "Working with peer agents")
  // emits `@Bo-codex`, the rewriter looked up literal `bo-codex` only, missed,
  // and the @-mention shipped as plain text → no Slack mention event → peer
  // didn't wake. Separator-normalized fallback closes that gap without
  // requiring the operator to rename either side.
  //
  // Conflict resolution: literal keys win. If bot A's literal happens to
  // equal bot B's normalized form, bot A is reachable via literal lookup
  // and bot B is reachable via its own literal (just not via the colliding
  // normalized form). Both bots remain mentionable; the only loss is
  // "fuzzy" reachability for the second bot. That's the right priority —
  // literal matches the operator's chosen Slack handle exactly, and Slack's
  // own UI never produces ambiguous separator variants.
  const byName = new Map<string, string>();
  const literalKeys = new Set<string>();
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    const literal = ident.username.toLowerCase();
    byName.set(literal, ident.userId);
    literalKeys.add(literal);
  }
  // Second pass for normalized aliases, only filling slots no literal owns.
  for (const ident of bots.values()) {
    if (ident.teamId !== currentBot.teamId) continue;
    const literal = ident.username.toLowerCase();
    const normalized = normalizeHandle(literal);
    if (normalized === literal) continue;
    if (literalKeys.has(normalized)) continue;
    if (byName.has(normalized)) continue;
    byName.set(normalized, ident.userId);
  }
  if (byName.size === 0) return text;

  // Slack usernames allow `[a-z0-9._-]` per Slack's user-handle rules.
  // Composed as a base + optional `.SUFFIX` segments so a trailing
  // sentence-ending period ("Your turn, @illie-codex.") doesn't get
  // gobbled into the capture — matches Discord's pattern in discord.ts:328.
  //
  // Boundary: `(?<![\w/:])` keeps `user@domain.com` from parsing as
  // `@domain.com` AND skips `@`-after-URL-path/scheme cases like
  // `https://example.com/@illie-codex` or `path/@illie-codex/sub`. Without
  // the `/` and `:` in the exclude class, the bare-mention pass corrupts
  // URLs (path char `/` is not `\w`, so `(?<!\w)` alone would let it
  // through). `transformOutsideProtectedRegions` only shields code spans,
  // not URL regions — so URL safety has to live in the lookbehind itself.
  const USERNAME = String.raw`[\w-]+(?:\.[\w-]+)*`;
  const BRACKETED_RE = new RegExp(String.raw`(?<![\w/:])<@(${USERNAME})>`, 'g');
  const BARE_RE = new RegExp(String.raw`(?<![\w/:])@(${USERNAME})`, 'g');

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
 * Strip Slack-handle separators (`-`, `_`, `.`) so `bo-codex` ≡ `bocodex` ≡
 * `bo_codex` for fuzzy matching. Used only as a fallback after literal
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
}

export async function fetchSlackBotIdentity(client: SlackAuthTestClient): Promise<SlackBotIdentity | null> {
  try {
    const racer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Slack auth.test timed out after ${SLACK_AUTH_TIMEOUT_MS}ms`)),
        SLACK_AUTH_TIMEOUT_MS,
      ),
    );
    const res = await Promise.race([client.auth.test(), racer]);
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
