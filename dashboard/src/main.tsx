import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { InboxBoard } from './views/InboxBoard.js';
import { ScheduledBoard } from './views/ScheduledBoard.js';
import { WorkgroupDashboard } from './views/WorkgroupDashboard.js';
import { SessionDetail } from './views/SessionDetail.js';
import { authMe as fetchAuthMe } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import type { AuthMe } from './lib/api.js';
import type { BoardRoute } from './views/BoardShell.js';
import './styles.css';

// Design-tool tweak variant. Switchable classes documented in styles.css.
const TWEAK_CLASS = 'tw-no-heat tw-no-grid';

function parseHash(): { route: BoardRoute | 'session'; sessionId?: string } {
  const hash = location.hash.slice(1) || '/inbox';
  if (hash.startsWith('/session/')) return { route: 'session', sessionId: hash.slice(9) };
  if (hash === '/scheduled') return { route: 'scheduled' };
  if (hash === '/workgroup') return { route: 'workgroup' };
  // Any other/stale hash (including the removed /board and /task/:id routes)
  // falls back to the inbox rather than rendering nothing.
  return { route: 'inbox' };
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
    location.hash = r === 'scheduled' ? '#/scheduled' : r === 'workgroup' ? '#/workgroup' : '#/inbox';
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
      {hashState.route === 'inbox' && me && <InboxBoard authMe={me} route="inbox" onRouteChange={navigate} />}
      {hashState.route === 'scheduled' && me && (
        <ScheduledBoard authMe={me} route="scheduled" onRouteChange={navigate} />
      )}
      {hashState.route === 'workgroup' && me && (
        <WorkgroupDashboard authMe={me} route="workgroup" onRouteChange={navigate} />
      )}
      {hashState.route === 'session' && hashState.sessionId && me && (
        <SessionDetail authMe={me} sessionId={hashState.sessionId} />
      )}
    </div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
