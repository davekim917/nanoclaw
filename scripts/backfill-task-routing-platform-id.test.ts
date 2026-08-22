import { describe, expect, it } from 'vitest';

import { decideRoutingStamp } from './backfill-task-routing-platform-id.js';

describe('decideRoutingStamp', () => {
  it('skips a session whose thread is not task-shaped, even with a resolvable platform_id', () => {
    const outcome = decideRoutingStamp(
      { thread_id: 'slack:C123:1699999999.001', task_routing_platform_id: null },
      [{ platform_id: 'slack:C123' }],
    );
    expect(outcome).toEqual({ kind: 'skip-non-task-thread' });
  });

  it('treats a null thread_id as non-task-shaped', () => {
    const outcome = decideRoutingStamp({ thread_id: null, task_routing_platform_id: null }, [
      { platform_id: 'slack:C123' },
    ]);
    expect(outcome).toEqual({ kind: 'skip-non-task-thread' });
  });

  it('skips a session already stamped, even when its messages disagree', () => {
    const outcome = decideRoutingStamp(
      { thread_id: 'system:tasks:series-1', task_routing_platform_id: 'slack:C999' },
      [{ platform_id: 'slack:C111' }, { platform_id: 'slack:C222' }],
    );
    expect(outcome).toEqual({ kind: 'skip-already-stamped' });
  });

  it('resolves when every task row agrees on one platform_id', () => {
    const outcome = decideRoutingStamp(
      { thread_id: 'system:tasks:series-2', task_routing_platform_id: null },
      [{ platform_id: 'slack:C111' }, { platform_id: 'slack:C111' }, { platform_id: null }],
    );
    expect(outcome).toEqual({ kind: 'resolved', platformId: 'slack:C111' });
  });

  it('reports unresolvable when no task row carries a platform_id', () => {
    const outcome = decideRoutingStamp(
      { thread_id: 'system:tasks:series-3', task_routing_platform_id: null },
      [{ platform_id: null }, { platform_id: null }],
    );
    expect(outcome).toEqual({ kind: 'unresolvable' });
  });

  it('reports unresolvable when there are no task rows at all', () => {
    const outcome = decideRoutingStamp({ thread_id: 'system:tasks:series-empty', task_routing_platform_id: null }, []);
    expect(outcome).toEqual({ kind: 'unresolvable' });
  });

  it('refuses to guess when task rows disagree on platform_id, and reports every distinct value sorted', () => {
    const outcome = decideRoutingStamp(
      { thread_id: 'system:tasks:series-4', task_routing_platform_id: null },
      [{ platform_id: 'slack:C111' }, { platform_id: 'discord:g:c222' }, { platform_id: 'slack:C111' }],
    );
    expect(outcome).toEqual({ kind: 'conflict', platformIds: ['discord:g:c222', 'slack:C111'] });
  });

  it('treats the bare legacy shared task thread as task-shaped too', () => {
    const outcome = decideRoutingStamp({ thread_id: 'system:tasks', task_routing_platform_id: null }, [
      { platform_id: 'slack:C111' },
    ]);
    expect(outcome).toEqual({ kind: 'resolved', platformId: 'slack:C111' });
  });
});
