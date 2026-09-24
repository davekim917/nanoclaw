/**
 * A sibling bot's live task list must never become a turn for this bot
 * (docs/specs/slack-task-list/plan.md): the Slack inbound filter drops it by
 * the footer only the task-list renderer writes.
 */
import { describe, expect, it } from 'vitest';

import { isSlackTaskListPost } from './slack.js';

const footer = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

describe('isSlackTaskListPost', () => {
  it('recognizes a bot post carrying the live or interrupted list footer', () => {
    const live = footer('todos as of <!date^1790262000^{time} ({ago})|3:00 PM>');
    const stopped = footer('stopped · todos as of <!date^1790262000^{time} ({ago})|3:00 PM>');
    expect(isSlackTaskListPost({ author: { isBot: true }, raw: { blocks: [{ type: 'markdown' }, live] } })).toBe(true);
    expect(isSlackTaskListPost({ author: { isBot: true }, raw: { blocks: [stopped] } })).toBe(true);
  });

  it('lets through a human quoting the phrase, other bot footers, and plain messages', () => {
    const live = footer('todos as of 3:00 PM');
    expect(isSlackTaskListPost({ author: { isBot: false }, raw: { blocks: [live] } })).toBe(false);
    expect(isSlackTaskListPost({ author: { isBot: true }, raw: { blocks: [footer('opus-5-5 · high · 40k')] } })).toBe(
      false,
    );
    expect(isSlackTaskListPost({ author: { isBot: true }, raw: { text: 'todos as of noon' } })).toBe(false);
    expect(isSlackTaskListPost({ author: { isBot: 'unknown' }, raw: { blocks: [live] } })).toBe(false);
  });
});
