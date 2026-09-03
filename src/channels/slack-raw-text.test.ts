/**
 * Slack pasted-table recovery.
 *
 * Two layers:
 *  - the pure projection (`extractSlackRawText`) over the raw Slack event;
 *  - the real bridge path, driven through the Chat SDK's own dispatch, which
 *    is where the ordering bug lives: our bridge REBUILDS `serialized.text`
 *    from the mdast AST after the point upstream appends rescued text, so an
 *    append placed there is silently discarded. The integration test goes red
 *    if `appendRawText` moves back above `reconstructInboundText`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';
import { Message, parseMarkdown } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import { appendRawText, createChatSdkBridge } from './chat-sdk-bridge.js';
import { extractSlackRawText } from './slack-raw-text.js';

const pastedTableEvent = {
  text: 'Analyze this attendee list:',
  attachments: [
    {
      fallback: '[no preview available]',
      blocks: [
        {
          type: 'table',
          rows: [
            [
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'text', text: 'Company', style: { bold: true } }],
                  },
                ],
              },
              {
                type: 'rich_text',
                elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Title' }] }],
              },
            ],
            [
              { type: 'raw_text', text: 'Agria Pet Insurance' },
              { type: 'raw_text', text: 'Head of IT Operations' },
            ],
            [
              { type: 'raw_text', text: 'AVEVA' },
              { type: 'raw_text', text: 'Head of Cyber Security Risk and Assurance' },
            ],
          ],
        },
      ],
    },
  ],
};

describe('extractSlackRawText', () => {
  it('flattens table attachment blocks into readable rows', () => {
    expect(extractSlackRawText(pastedTableEvent)).toBe(
      [
        'Company | Title',
        'Agria Pet Insurance | Head of IT Operations',
        'AVEVA | Head of Cyber Security Risk and Assurance',
      ].join('\n'),
    );
  });

  it('ignores ordinary attachments and malformed table blocks', () => {
    expect(extractSlackRawText({ text: 'hello' })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ fallback: 'link preview' }] })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows: 'bad' }] }] })).toBeNull();
  });

  const cellRaw = (elements: unknown[]) => ({
    attachments: [
      {
        blocks: [
          {
            type: 'table',
            rows: [[{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] }]],
          },
        ],
      },
    ],
  });

  it('renders rich_text elements that carry no `text` field', () => {
    // Slack's own spacing lives in the text runs between the elements.
    const raw = cellRaw([
      { type: 'user', user_id: 'U9' },
      { type: 'text', text: ' shipped ' },
      { type: 'emoji', name: 'tada', unicode: '1f389' },
      { type: 'text', text: ' to ' },
      { type: 'channel', channel_id: 'C7' },
      { type: 'text', text: ', cc ' },
      { type: 'usergroup', usergroup_id: 'S3' },
      { type: 'text', text: ' ' },
      { type: 'broadcast', range: 'here' },
      { type: 'text', text: ' — see ' },
      { type: 'link', url: 'https://example.com/report' },
      { type: 'text', text: ' and ' },
      { type: 'link', url: 'https://example.com/x', text: 'the labeled one' },
    ]);

    expect(extractSlackRawText(raw)).toBe(
      '<@U9> shipped \u{1F389} to <#C7>, cc <!subteam^S3> @here \u2014 see https://example.com/report and the labeled one',
    );
  });

  it('falls back to :name: when an emoji carries no unicode codepoints', () => {
    expect(extractSlackRawText(cellRaw([{ type: 'emoji', name: 'shipit' }]))).toBe(':shipit:');
  });

  it('does not invent whitespace between adjacent runs of one word', () => {
    // `**AC**ME` reaches us as two adjacent text runs. Joining on a space
    // would recover it as "AC ME".
    const raw = cellRaw([
      { type: 'text', text: 'AC', style: { bold: true } },
      { type: 'text', text: 'ME' },
    ]);
    expect(extractSlackRawText(raw)).toBe('ACME');
  });

  it('separates structural sections, and keeps a cell to one line', () => {
    const raw = {
      attachments: [
        {
          blocks: [
            {
              type: 'table',
              rows: [
                [
                  {
                    type: 'rich_text',
                    elements: [
                      { type: 'rich_text_section', elements: [{ type: 'text', text: 'first' }] },
                      { type: 'rich_text_section', elements: [{ type: 'text', text: 'second' }] },
                      { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'a\nb' }] },
                    ],
                  },
                ],
              ],
            },
          ],
        },
      ],
    };
    expect(extractSlackRawText(raw)).toBe('first second a b');
  });

  it('returns null for a table whose cells are all empty', () => {
    const raw = {
      attachments: [
        {
          blocks: [
            {
              type: 'table',
              rows: [[{ type: 'rich_text', elements: [] }], [{ type: 'rich_text', elements: [] }]],
            },
          ],
        },
      ],
    };
    expect(extractSlackRawText(raw)).toBeNull();
  });

  it('caps unexpectedly large pasted tables', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => [
      { type: 'raw_text', text: `row-${index}-with-padding` },
    ]);
    const text = extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows }] }] });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain('[table truncated]');
  });
});

describe('appendRawText', () => {
  it('leaves the body byte-identical with no extractor and with nothing recovered', () => {
    const noExtractor: Record<string, unknown> = { text: 'hello' };
    appendRawText(noExtractor, pastedTableEvent, undefined);
    expect(noExtractor.text).toBe('hello');

    const nothingRecovered: Record<string, unknown> = { text: 'hello' };
    appendRawText(nothingRecovered, { text: 'hello' }, extractSlackRawText);
    expect(nothingRecovered.text).toBe('hello');
  });

  it('uses the rescued text alone when the message carried no text', () => {
    const serialized: Record<string, unknown> = {};
    appendRawText(serialized, pastedTableEvent, extractSlackRawText);
    expect(serialized.text).toBe(
      [
        'Company | Title',
        'Agria Pet Insurance | Head of IT Operations',
        'AVEVA | Head of Cyber Security Risk and Assurance',
      ].join('\n'),
    );
  });
});

/**
 * Drive the bridge's real inbound path: bridge.setup() registers handlers on a
 * real Chat instance (captured from the mocked webhook registration), then
 * chat.processMessage dispatches a Slack-shaped message through it.
 */
async function inboundThroughBridge(
  raw: Record<string, unknown>,
  text: string,
  opts: { extract?: boolean; transformInboundText?: (t: string) => string } = {},
): Promise<InboundMessage> {
  const adapter = {
    name: 'slack',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;

  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    extractRawText: opts.extract === false ? undefined : extractSlackRawText,
    transformInboundText: opts.transformInboundText,
  });

  const received: InboundMessage[] = [];
  await bridge.setup({
    onInbound: async (_platformId: string, _threadId: string | null, message: InboundMessage) => {
      received.push(message);
    },
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: () => {},
  } as unknown as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();

  const message = new Message({
    id: 'ts-1',
    threadId: 'slack:C1:ts-1',
    text,
    formatted: parseMarkdown(text),
    raw,
    author: { userId: 'U1', userName: 'gavriel', fullName: 'Gavriel C' },
    metadata: { dateSent: new Date('2026-09-02T10:00:00Z'), edited: false },
    attachments: [],
  } as never);

  await chat.processMessage(adapter, 'slack:C1:ts-1', message);
  expect(received).toHaveLength(1);
  return received[0];
}

/**
 * Thread-context replay: the router rebuilds an unengaged thread's history
 * through bridge.fetchThreadHistory, which reads `.text` only. A table-only
 * message has empty text and would be skipped outright.
 */
function historyBridge(messages: Array<Record<string, unknown>>, extract = true) {
  const adapter = {
    name: 'slack',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    fetchMessages: async () => ({ messages }),
  } as unknown as Adapter;
  return createChatSdkBridge({
    adapter,
    supportsThreads: true,
    extractRawText: extract ? extractSlackRawText : undefined,
  });
}

const historyAuthor = { userId: 'U1', fullName: 'Gavriel C', userName: 'gavriel', isMe: false };
const historyMeta = { dateSent: new Date('2026-09-02T10:00:00Z') };

describe('Slack pasted tables in replayed thread context', () => {
  it('recovers a table-only history message instead of skipping it as empty', async () => {
    const bridge = historyBridge([
      {
        id: 'm1',
        text: '',
        raw: { attachments: pastedTableEvent.attachments },
        author: historyAuthor,
        metadata: historyMeta,
      },
    ]);
    const history = await bridge.fetchThreadHistory!('slack:C1:ts-1');
    expect(history).toHaveLength(1);
    expect(history[0].text).toContain('Agria Pet Insurance | Head of IT Operations');
  });

  it('replays the table alongside its introductory sentence', async () => {
    const bridge = historyBridge([
      {
        id: 'm1',
        text: 'Analyze this attendee list:',
        raw: pastedTableEvent,
        author: historyAuthor,
        metadata: historyMeta,
      },
    ]);
    const history = await bridge.fetchThreadHistory!('slack:C1:ts-1');
    expect(history[0].text).toBe(
      'Analyze this attendee list:\n\nCompany | Title\nAgria Pet Insurance | Head of IT Operations\nAVEVA | Head of Cyber Security Risk and Assurance',
    );
  });

  it('still skips a genuinely empty message when there is nothing to recover', async () => {
    const bridge = historyBridge([
      { id: 'm1', text: '', raw: { text: '' }, author: historyAuthor, metadata: historyMeta },
      { id: 'm2', text: 'hello', raw: {}, author: historyAuthor, metadata: historyMeta },
    ]);
    const history = await bridge.fetchThreadHistory!('slack:C1:ts-1');
    expect(history.map((h) => h.text)).toEqual(['hello']);
  });

  it('leaves history byte-identical for an adapter with no extractor', async () => {
    const bridge = historyBridge(
      [
        {
          id: 'm1',
          text: 'Analyze this attendee list:',
          raw: pastedTableEvent,
          author: historyAuthor,
          metadata: historyMeta,
        },
      ],
      false,
    );
    const history = await bridge.fetchThreadHistory!('slack:C1:ts-1');
    expect(history[0].text).toBe('Analyze this attendee list:');
  });
});

describe('Slack pasted tables through the chat-sdk bridge', () => {
  beforeEach(() => {
    captured.chat = null;
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('persists the rescued table AFTER the mdast rebuild, and still drops raw', async () => {
    const inbound = await inboundThroughBridge(pastedTableEvent, 'Analyze this attendee list:');
    const content = inbound.content as Record<string, unknown>;

    expect(content.text).toBe(
      [
        'Analyze this attendee list:',
        '',
        'Company | Title',
        'Agria Pet Insurance | Head of IT Operations',
        'AVEVA | Head of Cyber Security Risk and Assurance',
      ].join('\n'),
    );
    expect(content.raw).toBeUndefined();
  });

  it('leaves the body untouched when the adapter declares no extractor', async () => {
    const inbound = await inboundThroughBridge(pastedTableEvent, 'Analyze this attendee list:', { extract: false });
    expect((inbound.content as Record<string, unknown>).text).toBe('Analyze this attendee list:');
  });

  it('recovers a table whose only content is a native Slack mention', async () => {
    const raw = {
      text: 'who owns this:',
      attachments: [
        {
          blocks: [
            {
              type: 'table',
              rows: [[{ type: 'rich_text', elements: [{ type: 'user', user_id: 'U9' }] }]],
            },
          ],
        },
      ],
    };
    const inbound = await inboundThroughBridge(raw, 'who owns this:', {
      transformInboundText: (t) => t.replaceAll('<@U9>', '@alice'),
    });
    expect((inbound.content as Record<string, unknown>).text).toBe('who owns this:\n\n@alice');
  });

  it('runs the rescued text through transformInboundText, so cell mentions resolve', async () => {
    const rawWithMention = {
      text: 'who is this:',
      attachments: [{ blocks: [{ type: 'table', rows: [[{ type: 'raw_text', text: '<@U9>' }]] }] }],
    };
    const inbound = await inboundThroughBridge(rawWithMention, 'who is this:', {
      transformInboundText: (t) => t.replaceAll('<@U9>', '@alice'),
    });
    expect((inbound.content as Record<string, unknown>).text).toBe('who is this:\n\n@alice');
  });
});
