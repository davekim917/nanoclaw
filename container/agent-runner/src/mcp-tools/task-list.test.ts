import { describe, expect, test } from 'bun:test';

import { TASK_LIST_WAITING_ON_MAX } from '../task-list.js';
import { updateTaskList } from './task-list.js';

describe('update_task_list registration', () => {
  test('is always loaded for Claude, never deferred behind tool search', () => {
    // A deferred tool is only a name until the model loads it; unprompted
    // list use needs the full description in the prompt every turn.
    expect(updateTaskList.tool._meta?.['anthropic/alwaysLoad']).toBe(true);
  });

  test('tells the model to start a list unprompted for multi-step work', () => {
    expect(updateTaskList.tool.description).toContain('proactively');
  });

  test('the schema admits a waiting item, which a strict provider would otherwise reject before the parser', () => {
    const item = (
      updateTaskList.tool.inputSchema.properties as {
        items: { items: { properties: Record<string, { enum?: string[]; maxLength?: number }> } };
      }
    ).items.items.properties;
    expect(item.status.enum).toContain('waiting');
    expect(item.waiting_on.maxLength).toBe(TASK_LIST_WAITING_ON_MAX);
  });
});
