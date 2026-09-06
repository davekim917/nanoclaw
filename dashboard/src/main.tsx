import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.js';
import { SignalApp } from './views/signal/SignalApp.js';
import { authMe as fetchAuthMe, exchangeToken } from './lib/api.js';
import { startSSE } from './lib/sse.ts';
import { takeUrlToken } from './lib/url-token.js';
import type { AuthMe } from './lib/api.js';
// theme.css FIRST: its tokens and Tailwind's base layer are the substrate, and
// styles.css (unlayered) is still allowed to win while it is being retired.
import './theme.css';
import './styles.css';
// The console's own token layer, scoped under `.ncc`.
import './views/console/console.css';
import './views/signal/signal.css';

// Design-tool tweak variant. Switchable classes documented in styles.css.
const TWEAK_CLASS = 'tw-no-heat tw-no-grid';

// Authentication remains shared; Signal owns authenticated application routing.

function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [me, setMe] = useState<AuthMe | null>(null);
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

  const handleAuthenticated = (m: AuthMe) => {
    setMe(m);
    setAuthState('authenticated');
    startSSE();
  };

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
    <div className={TWEAK_CLASS}>{me && <SignalApp authMe={me} />}</div>
  );
}

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
