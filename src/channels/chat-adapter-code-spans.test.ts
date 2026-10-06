/**
 * Pins the behaviour patches/@chat-adapter__shared@4.41.1.patch exists for: the adapters'
 * bare-@mention rewrite must leave every code span alone: a span opens with a run of N backticks
 * and closes on the next run of exactly N, which upstream's scanner gets wrong for N >= 2.
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
  ['``@first\n@second`` then @bob', '``@first\n@second`` then <@bob>'],
  ['``a``` x` @inside`` then @bob', '``a``` x` @inside`` then <@bob>'],
  ['````\n@four ``` still code\n```` then @bob', '````\n@four ``` still code\n```` then <@bob>'],
  ['unclosed ``x so @bob is rewritten', 'unclosed ``x so <@bob> is rewritten'],
];

describe('@chat-adapter mention rewrite leaves code spans alone', () => {
  it.each(CASES)('slack: %j', (input, expected) => {
    expect(slackFinalize(input)).toBe(expected);
  });

  it.each(CASES)('discord: %j', (input, expected) => {
    expect(discordMentions(input)).toBe(expected);
  });
});
