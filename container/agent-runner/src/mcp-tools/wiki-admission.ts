import { randomBytes } from 'node:crypto';
import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const wikiAdmissionTool: McpToolDefinition = {
  tool: {
    name: 'wiki_admission',
    description:
      'Restricted wiki maintenance: begin a host snapshot, submit Markdown replacements with primary-source URLs, or return the assigned independent verdict. This never grants general Git access.',
    inputSchema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['begin', 'submit', 'verdict'] },
        candidateId: { type: 'string' },
        inputDigest: { type: 'string' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'replacementMarkdown', 'sourceLocators'],
            properties: {
              path: { type: 'string' },
              replacementMarkdown: { type: 'string' },
              sourceLocators: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        verdict: { type: 'string', enum: ['accept', 'reject'] },
        reasons: { type: 'string' },
        support: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'passage', 'sourceIds'],
            properties: {
              path: { type: 'string' },
              passage: { type: 'string' },
              sourceIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  handler: async (args) => {
    const requestId = `repo-${Date.now()}-${randomBytes(8).toString('hex')}`;
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ ...args, action: 'wiki_admission', requestId }),
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const row = getMessageIn(`wiki-response-${requestId}`);
      if (row) {
        markCompleted([row.id]);
        return { content: [{ type: 'text', text: row.content }] };
      }
      await Bun.sleep(200);
    }
    return {
      isError: true,
      content: [{ type: 'text', text: 'Wiki request timed out. Do not publish or bypass admission.' }],
    };
  },
};

if (process.env.NANOCLAW_WIKI_MAINTENANCE === '1') registerTools([wikiAdmissionTool]);
