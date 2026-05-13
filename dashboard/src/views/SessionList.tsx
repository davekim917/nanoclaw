import React from 'react';
import useSWR from 'swr';
import { listSessions, listGroups } from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import { useGroupFilter } from '../lib/use-group-filter.js';
import { BoardBrand, MobileRouteNav, type BoardRoute } from './BoardShell.js';
import type { AuthMe, GroupSummary } from '../lib/api.js';

interface SessionListProps {
  authMe: AuthMe;
  route: BoardRoute;
  onRouteChange: (r: BoardRoute) => void;
}

/**
 * Raw row-by-row sessions table. C8 demoted this from a primary nav
 * destination to a debug view — the inbox board is the user-facing
 * sessions experience now. SessionList stays for ops/debugging only.
 */
export const SessionList: React.FC<SessionListProps> = ({ authMe, route, onRouteChange }) => {
  const { data } = useSWR('/dashboard/api/sessions', () => listSessions());
  const { data: groupsData } = useSWR('/dashboard/api/groups', () => listGroups());
  const sessions = data?.sessions ?? [];
  const groups: GroupSummary[] = groupsData?.groups ?? [];
  const [groupFilter, setGroupFilter] = useGroupFilter(
    authMe.user_id,
    authMe.scopes.allowed_group_ids,
    authMe.scopes.no_filter,
  );

  return (
    <div className="nc-frame">
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <BoardBrand groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter} />
          <MobileRouteNav route={route} onRouteChange={onRouteChange} />
        </div>
      </header>

      <div className="nc-sessions">
        <h2>Sessions · {sessions.length} (debug view)</h2>
        {sessions.length === 0 && (
          <div className="nc-empty" style={{ margin: 0 }}>
            no live sessions
          </div>
        )}
        {sessions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Agent Group</th>
                  <th>Session</th>
                  <th>Title</th>
                  <th>Container</th>
                  <th>Attention</th>
                  <th>Last Active</th>
                  <th>Messaging Group</th>
                  <th>Thread</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td className="mono">{s.agent_group_id}</td>
                    <td className="mono">{s.session_id}</td>
                    <td>{s.title ?? '—'}</td>
                    <td>
                      <span
                        className="nc-pill"
                        style={{
                          background:
                            s.container_status === 'running'
                              ? 'var(--st-running-bg)'
                              : s.container_status === 'stale'
                                ? 'var(--st-failed-bg)'
                                : 'oklch(0.30 0.008 60)',
                          color:
                            s.container_status === 'running'
                              ? 'var(--st-running)'
                              : s.container_status === 'stale'
                                ? 'var(--st-failed)'
                                : 'var(--fg-2)',
                        }}
                      >
                        {s.container_status}
                      </span>
                    </td>
                    <td className="mono">{s.attention_state ?? '—'}</td>
                    <td>{s.last_active ? `${relAge(s.last_active)} ago` : '—'}</td>
                    <td className="mono">{s.messaging_group_id ?? '—'}</td>
                    <td className="mono">{s.thread_id ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
