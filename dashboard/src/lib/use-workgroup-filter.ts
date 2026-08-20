/**
 * Workgroup-filter persistence hook.
 *
 * The console's primary filter axis is the WORKGROUP, not the agent group.
 * Siblings (`example-labs`, `example-labs-b`, `example-labs-c`, …) share one
 * workgroup and most threads are multi-agent, so keying the filter on an agent
 * group forced the operator to pick one sibling and hid the rest of the
 * thread's participants.
 *
 * Stores the selection in localStorage under `nc:dash:workgroup_filter:<userId>`.
 * Qualified by userId so multi-account households sharing one browser don't
 * clobber each other's selection.
 *
 * `workgroupIds` is the list the selector is actually rendering, which
 * `GET /dashboard/api/workgroups` has ALREADY scope-filtered: a workgroup where
 * the caller is allowed no sibling never appears in it. So it is the authority
 * for owners and scoped users alike, and there is no `no_filter` exemption —
 * a stored workgroup that is gone (deleted, or access revoked between sessions)
 * falls back to "all" rather than leaving a header pointing at a workgroup that
 * silently filters the queue to nothing.
 */
import { useCallback, useEffect, useState } from 'react';

export type WorkgroupFilter = string | 'all';

const KEY_PREFIX = 'nc:dash:workgroup_filter:';

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function readStored(userId: string): WorkgroupFilter {
  try {
    return localStorage.getItem(storageKey(userId)) || 'all';
  } catch {
    return 'all';
  }
}

export function useWorkgroupFilter(
  userId: string,
  workgroupIds: string[],
): [WorkgroupFilter, (next: WorkgroupFilter) => void] {
  // Hydrate raw: the workgroup list arrives from a fetch, so there is nothing
  // to validate against on the first render. The effect below corrects it.
  const [filter, setFilter] = useState<WorkgroupFilter>(() => readStored(userId));

  useEffect(() => {
    if (filter === 'all') return;
    // An empty list is "not loaded yet", not "your workgroup is gone" — the
    // same rule the queue's channel filter applies to an empty window.
    if (workgroupIds.length === 0) return;
    if (workgroupIds.includes(filter)) return;
    try {
      localStorage.removeItem(storageKey(userId));
    } catch {
      /* ignore */
    }
    setFilter('all');
  }, [workgroupIds, filter, userId]);

  const update = useCallback(
    (next: WorkgroupFilter) => {
      setFilter(next);
      try {
        if (next === 'all') {
          localStorage.removeItem(storageKey(userId));
        } else {
          localStorage.setItem(storageKey(userId), next);
        }
      } catch {
        /* private mode / quota — accept the in-memory state */
      }
    },
    [userId],
  );

  return [filter, update];
}
