/**
 * A card click, as the host turns it into a response payload.
 *
 * The channel seam hands a click to `ChannelSetup.onAction` as four values
 * (adapter.ts:29): the question id baked into the button, the chosen value,
 * the clicker, and the platform id of the message the click was made on. This
 * is the one place they become a `ResponsePayload`, so every adapter's clicks
 * reach the handlers behind `dispatch` in the same shape.
 *
 * It lives here rather than inline in main.ts so a test can exercise the real
 * construction instead of rebuilding it. A test that supplies its own
 * `messageId` proves nothing about production: `messageId` is optional on the
 * payload, so dropping it here would still compile and still leave such a test
 * green, while every genuine click lost the binding the approvals handler
 * refuses without (modules/approvals/response-handler.ts). Exercised by
 * src/modules/approvals/click-binding.test.ts.
 */
import { log } from '../log.js';
import type { ResponsePayload } from '../response-registry.js';
import type { ChannelSetup } from './adapter.js';

/** The four values a click carries, as one payload. */
export function actionResponsePayload(
  channelType: string,
  questionId: string,
  selectedOption: string,
  userId: string,
  messageId: string | null,
): ResponsePayload {
  return {
    questionId,
    value: selectedOption,
    userId,
    channelType,
    // platformId/threadId aren't surfaced by the current onAction signature —
    // registered handlers look them up from the pending_question /
    // pending_approval row.
    platformId: '',
    threadId: null,
    // The clicked message, which approvals bind the click to.
    messageId,
  };
}

/** `ChannelSetup.onAction` for one channel type: build the payload, dispatch it, never throw at the adapter. */
export function makeOnAction(
  channelType: string,
  dispatch: (payload: ResponsePayload) => Promise<void>,
): ChannelSetup['onAction'] {
  return (questionId, selectedOption, userId, messageId) => {
    dispatch(actionResponsePayload(channelType, questionId, selectedOption, userId, messageId)).catch((err) => {
      log.error('Failed to handle question response', { questionId, err });
    });
  };
}
