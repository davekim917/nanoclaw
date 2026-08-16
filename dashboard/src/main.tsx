import { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { InboxBoard } from './views/InboxBoard.js';
import { WorkgroupDashboard } from './views/WorkgroupDashboard.js';
import { Observatory } from './views/Observatory.js';
import { SessionDetail } from './views/SessionDetail.js';
import { authMe as fetchAuthMe, exchangeToken } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import { takeUrlToken } from './lib/url-token.js';
import type { AuthMe } from './lib/api.js';
import type { BoardRoute } from './views/BoardShell.js';
import './styles.css';

// Design-tool tweak variant. Switchable classes documented in styles.css.
const TWEAK_CLASS = 'tw-no-heat tw-no-grid';

function parseHash(): { route: BoardRoute | 'session'; sessionId?: string } {
  const hash = location.hash.slice(1) || '/observatory';
  if (hash.startsWith('/session/')) return { route: 'session', sessionId: hash.slice(9) };
  if (hash === '/inbox') return { route: 'inbox' };
  if (hash === '/workgroup') return { route: 'workgroup' };
  // Any other/stale hash (including the removed /board, /scheduled and
  // /task/:id routes) falls back to the Observatory rather than rendering
  // nothing. Scheduled work is a section of the floor now.
  return { route: 'observatory' };
}

function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [me, setMe] = useState<AuthMe | null>(null);
  const [hashState, setHashState] = useState(parseHash);
  const [linkFailed, setLinkFailed] = useState(false);

  useEffect(() => {
    const urlToken = takeUrlToken();
    // A dead link must still land on the paste form rather than a blank one:
    // tokens are single-use, so the second click on the same link always fails.
    const exchanged = urlToken
      ? exchangeToken(urlToken).then(
          () => true,
          () => false,
        )
      : Promise.resolve(true);
    exchanged
      .then((ok) => {
        if (!ok) setLinkFailed(true);
        return fetchAuthMe();
      })
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
    location.hash = r === 'workgroup' ? '#/workgroup' : r === 'inbox' ? '#/inbox' : '#/observatory';
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
        <AuthGate onAuthenticated={handleAuthenticated} linkFailed={linkFailed} />
      </div>
    );
  }

  return (
    <div className={TWEAK_CLASS} style={{ minHeight: '100vh' }}>
      {hashState.route === 'inbox' && me && <InboxBoard authMe={me} route="inbox" onRouteChange={navigate} />}
      {hashState.route === 'workgroup' && me && (
        <WorkgroupDashboard authMe={me} route="workgroup" onRouteChange={navigate} />
      )}
      {hashState.route === 'observatory' && me && (
        <Observatory authMe={me} route="observatory" onRouteChange={navigate} />
      )}
      {hashState.route === 'session' && hashState.sessionId && me && (
        <SessionDetail authMe={me} sessionId={hashState.sessionId} />
      )}
    </div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
