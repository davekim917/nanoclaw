/**
 * Pins what patches/@chat-adapter__shared@4.41.1.patch exists for: the adapters' bare-@mention
 * rewrite leaves fences (3+ backticks), double-backtick spans (which may cross lines) and one-line
 * single-backtick spans byte-identical. Unpatched, the shared scanner reads a double-backtick span
 * as two empty spans and rewrites the @name inside it.
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
  ['``@first\n@second`` then @bob', '``@first\n@second`` then <@bob>'],
  ['``a` @inside`` then @bob', '``a` @inside`` then <@bob>'],
  ['Use <arg ``@scope/pkg\n@inner``> then @bob', 'Use <arg ``@scope/pkg\n@inner``> then <@bob>'],
  ['```\n@inside\n```` then @bob', '```\n@inside\n```` then <@bob>'],
  ['```js\n@x\n```@tail', '```js\n@x\n```<@tail>'],
  ['`@inline`@tail', '`@inline`<@tail>'],
  ['`one\n@two` then @bob', '`one\n<@two>` then <@bob>'],
  ['unclosed ``x so @bob is rewritten', 'unclosed ``x so <@bob> is rewritten'],
  ['already <@U123> stays', 'already <@U123> stays'],
];

describe('@chat-adapter mention rewrite leaves code regions alone', () => {
  it.each(CASES)('slack: %j', (input, expected) => {
    expect(slackFinalize(input)).toBe(expected);
  });

  it.each(CASES)('discord: %j', (input, expected) => {
    expect(discordMentions(input)).toBe(expected);
  });
});
