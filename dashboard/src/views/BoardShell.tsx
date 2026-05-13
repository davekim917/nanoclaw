import { useEffect, useState, type ReactNode } from 'react';
import { GroupTitle } from './GroupTitle.js';
import type { GroupSummary } from '../lib/api.js';
import type { GroupFilter } from '../lib/use-group-filter.js';

/**
 * Composable building blocks shared between `/dashboard/board` (KanbanBoard)
 * and `/dashboard/inbox` (InboxBoard, added in C8). The two views differ in
 * what they put inside the frame — task-status columns vs. attention-state
 * lanes — but the chrome (frame wrapper, brand, route nav, archive toggle)
 * is identical, and the inbox needs to render it the same way the board
 * does today.
 *
 * Pure refactor: every primitive in this file replaces an inline equivalent
 * inside KanbanBoard.tsx with byte-identical output. No new DOM nodes, no
 * reordered children. C8 reuses the same primitives without forking them.
 */

export type BoardRoute = 'board' | 'inbox' | 'sessions';

const MOBILE_QUERY = '(max-width: 899px)';

/**
 * Tracks the viewport breakpoint. Lifted out of KanbanBoard so InboxBoard
 * can call the same hook and get the identical isMobile signal — useful
 * when both routes mount on the same page-load and a switch shouldn't
 * trigger a remeasure flicker.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

/**
 * Outer frame wrapper. Owns the `nc-mobile`/`nc-desktop` class so children
 * can rely on the viewport class chain without duplicating the ternary.
 */
export function BoardFrame({ isMobile, children }: { isMobile: boolean; children: ReactNode }) {
  return <div className={`nc-frame ${isMobile ? 'nc-mobile' : 'nc-desktop'}`}>{children}</div>;
}

/**
 * Brand block: mark glyph + GroupTitle dropdown. Same shape on mobile and
 * desktop — only the *surrounding* container class differs (`.nc-brand` in
 * both cases, just nested differently per breakpoint).
 */
export function BoardBrand({
  groups,
  groupFilter,
  onGroupFilter,
  fallback = 'Agent Board',
}: {
  groups: GroupSummary[];
  groupFilter: GroupFilter;
  onGroupFilter: (next: GroupFilter) => void;
  fallback?: string;
}) {
  return (
    <div className="nc-brand">
      <span className="mark" aria-hidden="true"></span>
      <GroupTitle groups={groups} selectedId={groupFilter} onChange={onGroupFilter} fallback={fallback} />
    </div>
  );
}

/**
 * Primary nav (Board / Inbox) for the mobile pulse header. Sessions has
 * been demoted to a small debug link in the desktop pulse-meta strip;
 * mobile only surfaces the two primary routes to keep the header tight.
 *
 * Active-route highlighting still drives off `route === ...` so the same
 * component renders correctly on the SessionList route (neither button
 * active) and on /dashboard/board or /dashboard/inbox.
 */
export function MobileRouteNav({
  route,
  onRouteChange,
}: {
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}) {
  return (
    <nav className="nc-pulse-actions">
      <button className={`nav-link ${route === 'board' ? 'active' : ''}`} onClick={() => onRouteChange('board')}>
        Board
      </button>
      <button className={`nav-link ${route === 'inbox' ? 'active' : ''}`} onClick={() => onRouteChange('inbox')}>
        Inbox
      </button>
    </nav>
  );
}

/**
 * The "debug → sessions" footer link rendered in the pulse-meta strip on
 * both layouts. Sessions is the raw row-by-row table view; the inbox board
 * supersedes it for normal use but the raw view stays accessible for
 * debugging (e.g., spotting orphaned sessions with no recent activity).
 */
export function SessionsDebugLink({
  route,
  onRouteChange,
}: {
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}) {
  return (
    <button
      type="button"
      className={`nc-debug-link ${route === 'sessions' ? 'active' : ''}`}
      onClick={() => onRouteChange('sessions')}
      title="Raw sessions table — debug view"
    >
      debug · sessions
    </button>
  );
}

/**
 * "Show archived" checkbox. Same look in mobile and desktop toolbars.
 */
export function ShowArchivedToggle({
  showArchived,
  onChange,
}: {
  showArchived: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="nc-archive-toggle">
      <input type="checkbox" checked={showArchived} onChange={(e) => onChange(e.target.checked)} />
      <span>Show archived</span>
    </label>
  );
}
