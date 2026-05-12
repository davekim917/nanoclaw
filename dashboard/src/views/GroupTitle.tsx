/**
 * GroupTitle — the brand-line slot that morphs to the active group's name
 * when a filter is selected, falling back to a configurable label otherwise
 * (typically "Agent Board").
 *
 * Behavior:
 *   - selectedId === 'all'     → renders `fallback`
 *   - selectedId === <id>      → renders the matching group.name
 *   - groups.length === 1      → renders the single group as static text
 *                                (no chevron / no menu — a control with one
 *                                option is a lie)
 *   - groups.length > 1        → renders a chevron trigger that opens a
 *                                menu (All + each group)
 *
 * Keyboard: Enter / Space toggles the menu; Esc closes; arrow keys are not
 * wired (small list, simple click target).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupSummary } from '../lib/api.js';
import type { GroupFilter } from '../lib/use-group-filter.js';

interface GroupTitleProps {
  groups: GroupSummary[];
  selectedId: GroupFilter;
  onChange: (next: GroupFilter) => void;
  fallback: string;
}

export const GroupTitle: React.FC<GroupTitleProps> = ({
  groups,
  selectedId,
  onChange,
  fallback,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, close]);

  const selectedName = (() => {
    if (selectedId === 'all') return fallback;
    const match = groups.find((g) => g.id === selectedId);
    return match?.name ?? fallback;
  })();

  // Single-group user: no dropdown affordance. Render the group name as
  // static text so the slot still carries meaningful context.
  if (groups.length <= 1) {
    const onlyName = groups[0]?.name ?? fallback;
    return <span className="nc-group-title nc-group-title-static">{onlyName}</span>;
  }

  return (
    <div className="nc-group-title" ref={rootRef}>
      <button
        type="button"
        className="nc-group-title-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selectedName}</span>
        <span className="nc-group-title-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="nc-group-title-menu" role="listbox">
          <li
            role="option"
            aria-selected={selectedId === 'all'}
            className={selectedId === 'all' ? 'active' : ''}
            onClick={() => {
              onChange('all');
              close();
            }}
          >
            {fallback}
            <span className="hint">all groups</span>
          </li>
          {groups.map((g) => (
            <li
              key={g.id}
              role="option"
              aria-selected={selectedId === g.id}
              className={selectedId === g.id ? 'active' : ''}
              onClick={() => {
                onChange(g.id);
                close();
              }}
            >
              {g.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
