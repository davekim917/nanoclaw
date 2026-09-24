import { describe, expect, test } from 'bun:test';

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
});
