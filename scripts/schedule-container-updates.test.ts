import { describe, expect, it } from 'vitest';

import { prompt, taskDefinition } from './schedule-container-updates.js';

describe('weekly container update advisory', () => {
  it('preserves the live series and uses a quiet deterministic pre-check', () => {
    const task = taskDefinition();
    expect(task.id).toBe('task-1782756339349-y4fdli');
    expect(task.seriesId).toBe(task.id);
    expect(task.cron).toBe('0 14 * * 1');
    expect(task.destination).toEqual({
      platformId: 'discord:1479489865702703155:1491839654528548989',
      channelType: 'discord',
      threadId: null,
    });
    expect(task.quietStatus).toBe(true);
    expect(task.script).toContain('container-updates.ts" audit');
  });

  it('is advisory-only and directs interactive work to the slash command', () => {
    expect(prompt).toContain('Do not re-query registries');
    expect(prompt).toContain('Run /update-container');
    expect(prompt).not.toContain('gh pr create');
  });
});
