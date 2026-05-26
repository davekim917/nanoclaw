/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  // Suffixed multi-bot channel types ("discord-codex", "discord-opencode",
  // "slack-<x>", ...) reuse the SAME Chat SDK adapter as their base platform,
  // which emits the base-prefixed id ("discord:guild:chan") for every bot.
  // Without this, seeding a messaging group for a suffixed channel type
  // double-prefixes ("discord-opencode:discord:guild:chan") — the adapter then
  // rejects it as an invalid thread id at delivery time. Only fires when raw is
  // already base-namespaced; native id formats (handled below) are untouched.
  const dash = channel.indexOf('-');
  if (dash > 0 && raw.startsWith(`${channel.slice(0, dash)}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}
