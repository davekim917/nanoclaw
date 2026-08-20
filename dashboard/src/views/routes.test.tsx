import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

/**
 * Every routed surface, mounted.
 *
 * There are two left — the console and the unauthenticated gate — because the
 * legacy Observatory / inbox / workgroup / session routes and the views behind
 * them are deleted. The theme assertions below stay: `styles.css` and
 * `theme.css` still dress the gate and the scheduled drawer, and the single
 * light ground is the rule they were written to hold.
 */

vi.mock('swr', () => {
  const mutate = vi.fn();
  const useSWR = vi.fn(() => ({ data: undefined, error: undefined, mutate }));
  return { default: useSWR };
});

vi.mock('../lib/api.js', () => ({
  listGroups: vi.fn(),
  listThreads: vi.fn(),
  listScheduled: vi.fn(),
  getThreadDetail: vi.fn(),
  authMe: vi.fn(),
  exchangeToken: vi.fn(),
}));

vi.mock('../lib/sse.ts', () => ({ subscribe: vi.fn(() => () => {}), startSSE: vi.fn(), stopSSE: vi.fn() }));
vi.mock('./ScheduledDrawer.js', () => ({ ScheduledDrawer: () => <div data-testid="sched-drawer" /> }));

import { ThreadConsole, lensForHash } from './console/ThreadConsole.js';
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
  it('#/console — and every other hash, which now lands here', () => {
    const { container } = render(<ThreadConsole authMe={authMe} />);
    expect(container.querySelector('.ncc')).toBeTruthy();
  });

  it('#/scheduled opens the Schedule lens rather than redirecting', () => {
    // The redirect is what made the schedule invisible when the Observatory —
    // which carried the only mount point for the drawer — was deleted.
    location.hash = '#/scheduled';
    const { container } = render(<ThreadConsole authMe={authMe} />);
    expect(container.querySelector('[aria-label="Scheduled work"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Threads"]')).toBeNull();
    location.hash = '';
  });

  it('routes every OTHER hash, retired bookmarks included, to the thread queue', () => {
    for (const hash of ['', '#/console', '#/observatory', '#/inbox', '#/workgroup', '#/session/s-1', '#/nonsense']) {
      expect(lensForHash(hash)).toBe('threads');
    }
    expect(lensForHash('#/scheduled')).toBe('schedule');
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
