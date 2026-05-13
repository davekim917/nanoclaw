import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { KanbanBoard } from './views/KanbanBoard.js';
import { InboxBoard } from './views/InboxBoard.js';
import { TaskDetail } from './views/TaskDetail.js';
import { SessionDetail } from './views/SessionDetail.js';
import { SessionList } from './views/SessionList.js';
import { authMe as fetchAuthMe } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import type { AuthMe } from './lib/api.js';
import type { BoardRoute } from './views/BoardShell.js';
import './styles.css';

// Design-tool tweak variant. Switchable classes documented in styles.css.
const TWEAK_CLASS = 'tw-no-heat tw-no-phasebar tw-no-grid';

function parseHash(): { route: BoardRoute | 'task' | 'session'; taskId?: string; sessionId?: string } {
  const hash = location.hash.slice(1) || '/board';
  if (hash.startsWith('/task/')) return { route: 'task', taskId: hash.slice(6) };
  if (hash.startsWith('/session/')) return { route: 'session', sessionId: hash.slice(9) };
  if (hash === '/inbox') return { route: 'inbox' };
  if (hash === '/sessions') return { route: 'sessions' };
  return { route: 'board' };
}

function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [me, setMe] = useState<AuthMe | null>(null);
  const [hashState, setHashState] = useState(parseHash);

  useEffect(() => {
    if (location.search.includes('token')) {
      history.replaceState(null, '', location.pathname + location.hash);
    }
    fetchAuthMe()
      .then((m) => {
        setMe(m);
        setAuthState('authenticated');
        startSSE();
      })
      .catch(() => {
        setAuthState('unauthenticated');
      });
  }, []);

  useEffect(() => {
    const handler = () => setHashState(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const handleAuthenticated = useCallback((m: AuthMe) => {
    setMe(m);
    setAuthState('authenticated');
    startSSE();
  }, []);

  const navigate = useCallback((r: BoardRoute) => {
    if (r === 'inbox') location.hash = '#/inbox';
    else if (r === 'sessions') location.hash = '#/sessions';
    else location.hash = '#/board';
  }, []);

  if (authState === 'loading') {
    return (
      <div className={TWEAK_CLASS}>
        <div
          style={{
            padding: 32,
            color: 'var(--fg-3)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Loading…
        </div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return (
      <div className={TWEAK_CLASS}>
        <AuthGate onAuthenticated={handleAuthenticated} />
      </div>
    );
  }

  return (
    <div className={TWEAK_CLASS} style={{ minHeight: '100vh' }}>
      {hashState.route === 'board' && me && <KanbanBoard authMe={me} route="board" onRouteChange={navigate} />}
      {hashState.route === 'inbox' && me && <InboxBoard authMe={me} route="inbox" onRouteChange={navigate} />}
      {hashState.route === 'task' && hashState.taskId && me && <TaskDetail authMe={me} taskId={hashState.taskId} />}
      {hashState.route === 'session' && hashState.sessionId && me && (
        <SessionDetail authMe={me} sessionId={hashState.sessionId} />
      )}
      {hashState.route === 'sessions' && me && (
        <SessionList authMe={me} route="sessions" onRouteChange={navigate} />
      )}
    </div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
