import React from 'react';
import useSWR from 'swr';
import { listSessions } from '../lib/api.js';
import { relAge } from '../lib/derive.js';
import type { AuthMe } from '../lib/api.js';

interface SessionListProps {
  authMe: AuthMe;
  route: 'board' | 'sessions';
  onRouteChange: (r: 'board' | 'sessions') => void;
}

export const SessionList: React.FC<SessionListProps> = ({
  authMe: _authMe,
  route,
  onRouteChange,
}) => {
  const { data } = useSWR('/dashboard/api/sessions', () => listSessions());
  const sessions = data?.sessions ?? [];

  return (
    <div className="nc-frame">
      <header className="nc-pulse">
        <div className="nc-pulse-top">
          <div className="nc-brand">
            <span className="mark" aria-hidden="true"></span>
            <span>NanoClaw</span>
          </div>
          <nav className="nc-pulse-actions">
            <button
              className={`nav-link ${route === 'board' ? 'active' : ''}`}
              onClick={() => onRouteChange('board')}
            >
              Board
            </button>
            <button
              className={`nav-link ${route === 'sessions' ? 'active' : ''}`}
              onClick={() => onRouteChange('sessions')}
            >
              Sessions
            </button>
          </nav>
        </div>
      </header>

      <div className="nc-sessions">
        <h2>Sessions · {sessions.length}</h2>
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
                  <th>Container</th>
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
