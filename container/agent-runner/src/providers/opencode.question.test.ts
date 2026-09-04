import { describe, it, expect } from 'bun:test';

import {
  autoAnswerQuestion,
  drainPendingQuestions,
  handleQuestionAsked,
  QUESTION_STEERING_TEXT,
  type QuestionClient,
} from './opencode.js';

type ReplyCall = { requestID: string; answers: string[][] };

function fakeQuestionClient(
  opts: {
    pending?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>;
    listError?: unknown;
    listThrows?: boolean;
    replyError?: unknown;
    replyThrows?: boolean;
    replyHangs?: boolean;
    listHangs?: boolean;
  } = {},
): { client: QuestionClient; replies: ReplyCall[]; listCalls: number } {
  const replies: ReplyCall[] = [];
  const state = { listCalls: 0 };
  const client: QuestionClient = {
    question: {
      async reply(params) {
        replies.push({ requestID: params.requestID, answers: params.answers });
        if (opts.replyThrows) throw new Error('reply blew up');
        if (opts.replyHangs) await new Promise(() => {});
        return opts.replyError ? { error: opts.replyError } : { data: true };
      },
      async list() {
        state.listCalls += 1;
        if (opts.listThrows) throw new Error('list blew up');
        if (opts.listHangs) await new Promise(() => {});
        return opts.listError ? { error: opts.listError } : { data: opts.pending ?? [] };
      },
    },
  };
  return {
    client,
    replies,
    get listCalls() {
      return state.listCalls;
    },
  };
}

describe('autoAnswerQuestion', () => {
  it('test_oc_question_answers_every_subquestion: one steering answer per sub-question', async () => {
    const fake = fakeQuestionClient();
    await autoAnswerQuestion(fake.client, { id: 'q1', questions: [{}, {}, {}] });
    expect(fake.replies).toEqual([
      {
        requestID: 'q1',
        answers: [[QUESTION_STEERING_TEXT], [QUESTION_STEERING_TEXT], [QUESTION_STEERING_TEXT]],
      },
    ]);
  });

  it('defaults to a single answer when the request carries no question list', async () => {
    const fake = fakeQuestionClient();
    await autoAnswerQuestion(fake.client, { id: 'q1' });
    expect(fake.replies[0]?.answers).toEqual([[QUESTION_STEERING_TEXT]]);
  });

  it('is a no-op without a request id — nothing to answer', async () => {
    const fake = fakeQuestionClient();
    await autoAnswerQuestion(fake.client, {});
    expect(fake.replies).toEqual([]);
  });

  it('test_oc_question_reply_failure_is_swallowed: a thrown reply does not propagate', async () => {
    const fake = fakeQuestionClient({ replyThrows: true });
    await autoAnswerQuestion(fake.client, { id: 'q1' });
    expect(fake.replies).toHaveLength(1);
  });

  it('an error-shaped reply response does not propagate either', async () => {
    const fake = fakeQuestionClient({ replyError: { message: 'nope' } });
    await autoAnswerQuestion(fake.client, { id: 'q1' });
    expect(fake.replies).toHaveLength(1);
  });
});

describe('handleQuestionAsked', () => {
  it('test_oc_question_answers_foreign_session: answers regardless of which session asked', async () => {
    // The OpenCode server is shared across sessions, so one unanswered question
    // wedges every session on the runtime, not just the asker.
    const fake = fakeQuestionClient();
    await handleQuestionAsked(fake.client, { id: 'q1', sessionID: 'some-other-session' });
    expect(fake.replies.map((r) => r.requestID)).toEqual(['q1']);
  });

  it('test_oc_question_reply_timeout_fails_open: a hung reply returns instead of stalling the turn', async () => {
    const fake = fakeQuestionClient({ replyHangs: true });
    const started = Date.now();
    await handleQuestionAsked(fake.client, { id: 'q1' }, 15);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('drainPendingQuestions', () => {
  it('test_oc_question_drain_answers_backlog: answers every request already pending at startup', async () => {
    const fake = fakeQuestionClient({
      pending: [
        { id: 'q1', sessionID: 's1', questions: [{}] },
        { id: 'q2', sessionID: 's2', questions: [{}, {}] },
      ],
    });
    await drainPendingQuestions(fake.client);
    expect(fake.replies.map((r) => r.requestID)).toEqual(['q1', 'q2']);
    expect(fake.replies[1]?.answers).toHaveLength(2);
  });

  it('an empty backlog replies to nothing', async () => {
    const fake = fakeQuestionClient({ pending: [] });
    await drainPendingQuestions(fake.client);
    expect(fake.replies).toEqual([]);
  });

  it('test_oc_question_drain_list_error_fails_open: a failing list does not block startup', async () => {
    const errored = fakeQuestionClient({ listError: { message: 'boom' } });
    await drainPendingQuestions(errored.client);
    expect(errored.replies).toEqual([]);

    const threw = fakeQuestionClient({ listThrows: true });
    await drainPendingQuestions(threw.client);
    expect(threw.replies).toEqual([]);
  });

  it('test_oc_question_drain_timeout_fails_open: a hung list returns within the budget', async () => {
    const fake = fakeQuestionClient({ listHangs: true });
    const started = Date.now();
    await drainPendingQuestions(fake.client, 15);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
