import { LayoutGrid, Inbox, LayoutPanelTop, CalendarDays } from 'lucide-react';

/**
 * The app shell's navigation: a fixed bottom tab bar on a phone, a sticky
 * sidebar on a desktop. Same four destinations either way, same active state,
 * same handler — only the arrangement differs, so a destination can never
 * exist on one form factor and not the other.
 *
 * These are the four places this product actually has. Three of them are bands
 * of the Observatory itself (it is one long page on a phone, and jumping to a
 * band is the whole point of a tab bar); the fourth is the inbox route, which
 * is still reachable and still real. Nothing here navigates somewhere that does
 * not exist.
 */

export const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'inbox', label: 'Inbox', Icon: Inbox },
  { key: 'office', label: 'Office', Icon: LayoutPanelTop },
  { key: 'scheduled', label: 'Scheduled', Icon: CalendarDays },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

export interface AppNavProps {
  active: NavKey;
  isMobile: boolean;
  onSelect: (key: NavKey) => void;
  /** Which floor is being read, e.g. "Example Workgroup". */
  scope?: string | undefined;
  /** One line of standing context under the nav on desktop. */
  foot?: string | undefined;
}

export function AppNav({ active, isMobile, onSelect, scope, foot }: AppNavProps) {
  if (isMobile) {
    return (
      <nav className="tm-tabbar" data-testid="app-tabbar" aria-label="Sections">
        {NAV_ITEMS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`tm-tabbar-item tm-tap ${active === key ? 'is-active' : ''}`}
            data-nav={key}
            aria-current={active === key ? 'page' : undefined}
            onClick={() => onSelect(key)}
          >
            <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    );
  }
  return (
    <aside className="tm-sidebar" data-testid="app-sidebar">
      <span className="tm-wordmark">Observatory</span>
      {scope && <span className="tm-sidebar-scope">{scope}</span>}
      <nav aria-label="Sections">
        {NAV_ITEMS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`tm-sidebar-item tm-tap ${active === key ? 'is-active' : ''}`}
            data-nav={key}
            aria-current={active === key ? 'page' : undefined}
            onClick={() => onSelect(key)}
          >
            <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
      {foot && <span className="tm-sidebar-foot">{foot}</span>}
    </aside>
  );
}
