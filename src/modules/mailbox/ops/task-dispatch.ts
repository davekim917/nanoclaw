import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

import { insertTaskRow, type TaskRowInsert } from './tasks.js';
import { readTaskSettlement } from './task-settlement.js';
import { taskThreadId } from '../../../db/sessions.js';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
export const TASK_DISPATCH_MAX_RECOVERIES = 2;

export function validateDispatchKey(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !KEY_RE.test(value) || value.trim() !== value) {
    throw new Error(`${name} must be 1–200 ASCII letters, digits or . _ : / # -`);
  }
}

export function dispatchSeriesId(contextKey: string): string {
  validateDispatchKey(contextKey, 'context key');
  return `dispatch-${createHash('sha256').update(contextKey).digest('hex')}`;
}

export function dispatchEventId(contextKey: string, eventKey: string): string {
  validateDispatchKey(contextKey, 'context key');
  validateDispatchKey(eventKey, 'event key');
  return `event-${createHash('sha256')
    .update(JSON.stringify([contextKey, eventKey]))
    .digest('hex')}`;
}

export interface TaskDispatchInput {
  contextKey: string;
  eventKey: string;
  retryOf?: string;
  prompt: string;
  originSessionId: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  muteChat: boolean;
  quietStatus: boolean;
}

export interface TaskDispatchResult {
  rowId: string;
  seriesId: string;
  status: string;
  admission: 'inserted' | 'replay';
  attempt: number;
}

interface DispatchMetadata {
  contextKey: string;
  eventKey: string;
  retryOf: string | null;
  attempt: number;
}

interface StoredEvent {
  id: string;
  series_id: string;
  status: string;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

function metadata(row: StoredEvent): DispatchMetadata {
  const value = (JSON.parse(row.content) as { dispatch?: DispatchMetadata }).dispatch;
  if (!value || !Number.isInteger(value.attempt) || value.attempt < 0 || value.attempt > TASK_DISPATCH_MAX_RECOVERIES) {
    throw new Error('invalid stored dispatch metadata');
  }
  return value;
}

/** One transaction owns collision checks, recovery admission and the inert row insert. */
export function dispatchTaskEvent(
  db: Database.Database,
  input: TaskDispatchInput,
  outbound: Database.Database | null = null,
): TaskDispatchResult {
  const seriesId = dispatchSeriesId(input.contextKey);
  const rowId = dispatchEventId(input.contextKey, input.eventKey);
  if (input.retryOf !== undefined) validateDispatchKey(input.retryOf, 'retry-of');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64_000) {
    throw new Error('dispatch prompt must contain 1–64000 characters');
  }
  return db
    .transaction((): TaskDispatchResult => {
      const find = (id: string) =>
        db.prepare("SELECT * FROM messages_in WHERE id = ? AND kind = 'task'").get(id) as StoredEvent | undefined;
      const existing = find(rowId);
      const contextRows = db
        .prepare("SELECT * FROM messages_in WHERE series_id = ? AND kind = 'task'")
        .all(seriesId) as StoredEvent[];
      for (const prior of contextRows) {
        const priorOrigin = (JSON.parse(prior.content) as { originSessionId?: string | null }).originSessionId ?? null;
        if (
          prior.platform_id !== input.platformId ||
          prior.channel_type !== input.channelType ||
          prior.thread_id !== input.threadId ||
          priorOrigin !== input.originSessionId
        ) {
          throw new Error('dispatch context collision: routing or origin changed');
        }
      }
      let attempt = 0;
      if (existing) {
        attempt = metadata(existing).attempt;
      } else if (input.retryOf !== undefined) {
        const previous = find(dispatchEventId(input.contextKey, input.retryOf));
        if (!previous || previous.series_id !== seriesId) throw new Error('retry predecessor not found in context');
        const settlement = readTaskSettlement(db, outbound, previous.id, taskThreadId(seriesId));
        const providerFailed =
          previous.status === 'completed' && settlement.executionSettled && settlement.outcome === 'error';
        if (previous.status !== 'failed' && previous.status !== 'expired' && !providerFailed) {
          throw new Error(`retry predecessor is ${previous.status}; only failed or expired events can recover`);
        }
        attempt = metadata(previous).attempt + 1;
        if (attempt > TASK_DISPATCH_MAX_RECOVERIES) throw new Error('dispatch recovery limit reached');
        if (contextRows.some((row) => metadata(row).retryOf === input.retryOf))
          throw new Error('retry predecessor already has a recovery event');
        if (!settlement.executionSettled)
          throw new Error('retry predecessor still has work or unknown execution state');
      }
      const row: TaskRowInsert = {
        id: rowId,
        seriesId,
        processAfter: new Date().toISOString(),
        recurrence: null,
        platformId: input.platformId,
        channelType: input.channelType,
        threadId: input.threadId,
        content: JSON.stringify({
          prompt: input.prompt,
          script: null,
          originSessionId: input.originSessionId,
          muteChat: input.muteChat,
          quietStatus: input.quietStatus,
          threadAnchor: false,
          dispatch: { contextKey: input.contextKey, eventKey: input.eventKey, retryOf: input.retryOf ?? null, attempt },
        }),
      };
      if (existing) {
        if (
          existing.series_id !== seriesId ||
          existing.content !== row.content ||
          existing.platform_id !== row.platformId ||
          existing.channel_type !== row.channelType ||
          existing.thread_id !== row.threadId
        ) {
          throw new Error('dispatch event key collision: content or routing changed');
        }
        return { rowId, seriesId, status: existing.status, admission: 'replay', attempt };
      }
      insertTaskRow(db, row);
      return { rowId, seriesId, status: 'pending', admission: 'inserted', attempt };
    })
    .immediate();
}
