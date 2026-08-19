import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Every routed surface, mounted under the single light theme.
 *
 * The Observatory is the only screen this track redesigns, but re-pointing the
 * base palette touched EVERY surface that reads a token — which is all of them.
 * These are mount checks with a token assertion, not redesign tests: the legacy
 * boards are meant to look correct under the new theme, not to look different.
 */

vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, error: undefined, mutate }));
  return { default: useSWR };
});

vi.mock('../lib/api.js', () => ({
  listWorkgroups: vi.fn(),
  listSessions: vi.fn(),
  listGroups: vi.fn(),
  getObservatory: vi.fn(),
  listScheduled: vi.fn(),
  getSessionDetail: vi.fn(),
  postSessionMessage: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  getWorkgroupSummary: vi.fn(),
  getWorkgroupUsage: vi.fn(),
  getWorkgroupClaims: vi.fn(),
  assignItem: vi.fn(),
  nudgeClaim: vi.fn(),
  steerWork: vi.fn(),
  getIssueBrief: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
}));

vi.mock('../lib/sse.ts', () => ({ subscribe: vi.fn(() => () => {}), startSSE: vi.fn(), stopSSE: vi.fn() }));
vi.mock('./ScheduledDrawer.js', () => ({ ScheduledDrawer: () => <div data-testid="sched-drawer" /> }));

import { Observatory } from './Observatory.js';
import { InboxBoard } from './InboxBoard.js';
import { WorkgroupDashboard } from './WorkgroupDashboard.js';
import { SessionDetail } from './SessionDetail.js';
import { AuthGate } from '../auth/AuthGate.js';
import useSWR from 'swr';

const authMe = { user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } };
const noop = () => {};

beforeEach(() => {
  vi.mocked(useSWR).mockImplementation(
    () => ({ data: undefined, error: undefined, mutate: vi.fn() }) as unknown as ReturnType<typeof useSWR>,
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('every route still mounts', () => {
  it('#/observatory', () => {
    const { container } = render(<Observatory authMe={authMe} route="observatory" onRouteChange={noop} />);
    expect(container.querySelector('.nc-frame')).toBeTruthy();
  });

  it('#/inbox (legacy — kept working, not redesigned)', () => {
    const { container } = render(<InboxBoard authMe={authMe} route="inbox" onRouteChange={noop} />);
    expect(container.querySelector('.nc-frame')).toBeTruthy();
  });

  it('#/workgroup (legacy — kept working, not redesigned)', () => {
    const { container } = render(<WorkgroupDashboard authMe={authMe} route="workgroup" onRouteChange={noop} />);
    expect(container.querySelector('.nc-frame')).toBeTruthy();
  });

  it('#/session/:id', () => {
    const { container } = render(<SessionDetail authMe={authMe} sessionId="s-1" />);
    expect(container.textContent).toBeTruthy();
  });

  it('the unauthenticated gate', () => {
    const { getByRole } = render(<AuthGate onAuthenticated={noop} />);
    expect(getByRole('main')).toBeTruthy();
  });
});

/** Read a project file. Vitest runs from `dashboard/`. */
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the single light theme', () => {
  it('is declared once, with no dark palette to fall back to', () => {
    const styles = read('src/styles.css');
    const theme = read('src/theme.css');
    const html = read('index.html');

    // One theme means one declaration of the ground, and light.
    expect(styles).toContain('color-scheme: light');
    expect(styles).not.toContain('color-scheme: dark');
    expect(html).toContain('content="light"');
    // The pre-mount flash guard must paint the canvas the stylesheet then
    // confirms — not a colour it contradicts a frame later.
    expect(html).toContain('background: #fafafa');
    // ...and only one ground: no media query flipping it on a system setting
    // the stylesheet then contradicts. Scoped to the <style> block, since the
    // comment above it explains the rule by naming the feature.
    const guard = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(guard).not.toContain('@media');
    // shadcn's stock dark block was dropped rather than shipped uncalibrated.
    expect(theme).not.toMatch(/^\.dark\s*\{/m);
  });

  it('leaves no dark-palette colour behind in the stylesheet', () => {
    const styles = read('src/styles.css');
    // Every one of these was a near-black surface or a saturated dark-theme
    // accent. They are tokens now, and the tokens are light.
    expect(styles).not.toContain('oklch(');
    expect(styles).not.toContain('#0e1116');
  });

  it('requests no font from a third party, and rounds no corner', () => {
    const styles = read('src/styles.css');
    expect(styles).not.toContain('fonts.googleapis.com');
    // Sharp corners are the brand. `50%` is a circle (a status dot), not a
    // rounded rectangle, and `var(--r)` resolves to 0.
    const radii = [...styles.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(radii.length).toBeGreaterThan(0);
    for (const r of radii) {
      expect(['0', '50%', 'var(--r)', 'var(--r, 0)']).toContain(r);
    }
  });
});
