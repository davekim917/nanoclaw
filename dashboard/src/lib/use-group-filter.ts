/**
 * Group-filter persistence hook.
 *
 * Stores the dashboard's selected group filter in localStorage under
 * `nc:dash:group_filter:<userId>`. Qualified by userId so multi-account
 * households sharing one browser don't clobber each other's selection.
 *
 * On hydrate, the stored value is validated against the current
 * `allowedIds`: a stale id (group access revoked between sessions, or
 * a multi-user browser where account A had access to ag-5 but account
 * B doesn't) is silently dropped back to "all" rather than rendering
 * a header that points at a group the user can't see.
 */
import { useCallback, useEffect, useState } from 'react';

export type GroupFilter = string | 'all';

const KEY_PREFIX = 'nc:dash:group_filter:';

function storageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function readStored(userId: string, allowedIds: string[], noFilter: boolean): GroupFilter {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw || raw === 'all') return 'all';
    // Owners / global admins (no_filter) can pick any group; otherwise the
    // id must be in the allowed set or we silently fall back to "all".
    if (noFilter || allowedIds.includes(raw)) return raw;
    localStorage.removeItem(storageKey(userId));
    return 'all';
  } catch {
    return 'all';
  }
}

export function useGroupFilter(
  userId: string,
  allowedIds: string[],
  noFilter: boolean,
): [GroupFilter, (next: GroupFilter) => void] {
  const [filter, setFilter] = useState<GroupFilter>(() => readStored(userId, allowedIds, noFilter));

  // If allowedIds shrinks (group revoked) and the selected filter is no
  // longer valid, reset to "all". Owners (noFilter) are exempt.
  useEffect(() => {
    if (filter === 'all') return;
    if (noFilter) return;
    if (!allowedIds.includes(filter)) {
      try { localStorage.removeItem(storageKey(userId)); } catch { /* ignore */ }
      setFilter('all');
    }
  }, [allowedIds, filter, noFilter, userId]);

  const update = useCallback(
    (next: GroupFilter) => {
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
