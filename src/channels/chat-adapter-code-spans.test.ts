/**
 * Pins the behaviour patches/@chat-adapter__shared@4.41.1.patch exists for: the adapters'
 * bare-@mention rewrite must leave every code span alone, including ``double-backtick``
 * spans, which upstream's scanner reads as two empty single-backtick spans.
 */
import { DiscordFormatConverter } from '@chat-adapter/discord';
import { SlackFormatConverter } from '@chat-adapter/slack';
import { describe, expect, it } from 'vitest';

const slackFinalize = (text: string): string =>
  (new SlackFormatConverter() as unknown as { finalize(text: string): string }).finalize(text);
const discordMentions = (text: string): string =>
  (
    new DiscordFormatConverter() as unknown as { convertMentionsToDiscord(text: string): string }
  ).convertMentionsToDiscord(text);

const CASES: ReadonlyArray<[input: string, expected: string]> = [
  ['run ``npm i @scope/pkg`` then ping @bob', 'run ``npm i @scope/pkg`` then ping <@bob>'],
  ['`@inline` and ```\n@fenced\n``` but @carol', '`@inline` and ```\n@fenced\n``` but <@carol>'],
  ['already <@U123> stays', 'already <@U123> stays'],
];

describe('@chat-adapter mention rewrite leaves code spans alone', () => {
  it.each(CASES)('slack: %j', (input, expected) => {
    expect(slackFinalize(input)).toBe(expected);
  });

  it.each(CASES)('discord: %j', (input, expected) => {
    expect(discordMentions(input)).toBe(expected);
  });
});
