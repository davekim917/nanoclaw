import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The shell's geometry, machine-checked.
 *
 * Layout is the other thing that ships broken in silence: nothing throws, every
 * component test passes, and the operator gets a scrolling document where an
 * app was specified — sidebar scrolling away with the page, composer only
 * reachable at the bottom of it, transcript never at its newest message. All
 * three were ONE missing constraint, so it is pinned here rather than left to
 * be re-derived from the symptoms next time.
 *
 * jsdom applies no CSS and lays nothing out, so these read the stylesheet as
 * text — the same tactic `console-theme.test.ts` uses for the palette.
 */

// Vitest runs from `dashboard/`.
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
const css = read('src/views/console/console.css');
/** Comments stripped: prose describing a rule must not be read as the rule. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one top-level rule, found by its exact selector line. */
function block(selector: string): string {
  const at = code.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist in console.css`).toBeGreaterThan(-1);
  const open = code.indexOf('{', at);
  return code.slice(open + 1, code.indexOf('}', open));
}

const BREAKPOINT = '@media (max-width: 899px)';

/** The whole mobile block, brace-matched rather than sliced at the first `}`. */
function mobileBlock(): { body: string; at: number; end: number } {
  const at = code.indexOf(BREAKPOINT);
  expect(at, 'the §8 mobile block must exist').toBeGreaterThan(-1);
  let depth = 0;
  let i = code.indexOf('{', at);
  const open = i;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) break;
  }
  return { body: code.slice(open + 1, i), at, end: i };
}

const mobile = mobileBlock();

describe('the shell is a fixed-viewport app, not a scrolling document', () => {
  const shell = block('.ncc');

  it('is exactly one viewport tall and never scrolls itself', () => {
    // `dvh`, because mobile is the primary viewport and `vh` is measured
    // against the browser chrome's largest state — a `vh` shell hangs its last
    // 60-90px below the fold on a phone. `vh` stays as the fallback.
    expect(shell).toMatch(/height:\s*100dvh/);
    expect(shell).toMatch(/height:\s*100vh/);
    expect(shell).toMatch(/overflow:\s*hidden/);
    // THE defect. A `min-height` root grows to its content, so no pane below
    // ever has to shrink, none of their overflow regions engage, and every
    // scroll escapes to one page scroll.
    expect(shell).not.toMatch(/min-height:\s*100/);
  });

  it('does not sit inside a taller wrapper that reintroduces the page scroll', () => {
    expect(read('src/main.tsx')).not.toMatch(/minHeight:\s*'100vh'/);
  });

  it('gives each pane its own scroll region', () => {
    for (const sel of ['.ncc-side', '.ncc-list', '.ncc-transcript'])
      expect(block(sel), sel).toMatch(/overflow-y:\s*auto/);
  });

  it('lets every flex child shrink below its content', () => {
    // Without `min-height: 0` a flex child refuses to shrink past its content
    // size, so the `overflow-y: auto` above never engages. This is the specific
    // property whose absence produced all three complaints.
    for (const sel of ['.ncc-body', '.ncc-list-pane', '.ncc-detail', '.ncc-detail-wrap', '.ncc-transcript'])
      expect(block(sel), sel).toMatch(/min-height:\s*0/);
  });

  it('pins the composer to the bottom of the thread column', () => {
    expect(block('.ncc-detail')).toMatch(/flex-direction:\s*column/);
    // Fixed head, scrolling transcript, fixed composer — the composer is
    // visible without scrolling the page only because it cannot grow.
    expect(block('.ncc-detail-head')).toMatch(/flex-shrink:\s*0/);
    expect(block('.ncc-composer')).toMatch(/flex-shrink:\s*0/);
    expect(block('.ncc-transcript')).toMatch(/flex-grow:\s*1/);
  });

  it('scrolls the transcript on a box separate from the one it measures', () => {
    // A ResizeObserver on the scroller never fires — its border box is pinned
    // by the shell. The anchor in ThreadDetail observes `-inner`, so `-inner`
    // must be the box that carries the content.
    expect(block('.ncc-transcript-inner')).toMatch(/display:\s*flex/);
    expect(block('.ncc-transcript')).not.toMatch(/padding/);
  });
});

describe('the breakpoint moves controls, it does not delete them (§8)', () => {
  it('is the last block in the file, where source order lets it win', () => {
    // Every rule in it has to beat a base rule of the same specificity
    // (`.ncc-list-pane`, `.ncc-triage`, `.ncc-side`), and at equal specificity
    // source order decides. One block, at the end.
    expect(code.split(BREAKPOINT)).toHaveLength(2);
    expect(code.slice(mobile.end + 1).trim()).toBe('');
  });

  it('keeps the sidebar reachable as a sheet instead of hiding it', () => {
    // The previous revision's `.ncc-side, .ncc-detail-wrap, .ncc-detail
    // { display: none }` is what stranded the operator at 390px.
    expect(mobile.body).toMatch(/\.ncc\[data-nav='open'\]\s*\.ncc-side\s*\{[^}]*display:\s*flex/);
    expect(mobile.body).toMatch(/\.ncc-bottom\s*\{[^}]*display:\s*flex/);
    expect(mobile.body).not.toMatch(/\.ncc-detail(-wrap)?\s*[,{][^}]*display:\s*none/);
  });

  it('shows one pane at a time WITHOUT unmounting the other', () => {
    // `visibility`, never `display: none`: a display-toggled box comes back at
    // scrollTop 0, and the queue has to return at the offset it left at.
    expect(mobile.body).toMatch(/\.ncc\[data-pane='detail'\]\s*\.ncc-list-pane\s*\{\s*visibility:\s*hidden/);
    expect(mobile.body).toMatch(/\.ncc\[data-pane='list'\]\s*\.ncc-detail-wrap\s*\{\s*visibility:\s*hidden/);
    expect(mobile.body).not.toMatch(/\.ncc-list-pane\s*\{\s*display:\s*none/);
    expect(mobile.body).toMatch(/\.ncc-back\s*\{[^}]*display:\s*inline-flex/);
  });

  it('sizes every tap target explicitly (§7.2)', () => {
    expect(block('.ncc-bottom')).toMatch(/height:\s*56px/);
    expect(block('.ncc-bottom-item')).toMatch(/min-height:\s*56px/);
    for (const sel of ['.ncc-side-item', '.ncc-row-side .ncc-verb'])
      expect(mobile.body, sel).toMatch(new RegExp(`${sel.replace(/[.\s]/g, '\\$&')}\\s*\\{[^}]*min-height:\\s*44px`));
    // The chrome's own controls are 28px at desktop density — the hamburger
    // (item 2's Filters replacement) joins the same group.
    expect(mobile.body).toMatch(/\.ncc-select,[\s\S]*?\.ncc-hamburger\s*\{\s*min-height:\s*44px/);
  });

  it('collapses the row to §8 — 24px faces, two-line title, channel · age', () => {
    expect(mobile.body).toMatch(/--ncc-face-size:\s*24px/);
    expect(mobile.body).toMatch(/-webkit-line-clamp:\s*2/);
    expect(mobile.body).toMatch(/\.ncc-row-meta\s*\.agents,\s*\.ncc-row-meta\s*\.sep-agents\s*\{\s*display:\s*none/);
    // The verb survives only on rows that want something; the rest say they are
    // tappable rather than leaving a blank column.
    expect(mobile.body).toMatch(/\.ncc-row:not\(\.attention\)\s*\.ncc-verb\s*\{\s*display:\s*none/);
    expect(mobile.body).toMatch(/\.ncc-row:not\(\.attention\)\s*\.ncc-row-side::after/);
  });

  it('wraps the top bar rather than letting the page scroll sideways', () => {
    expect(mobile.body).toMatch(/\.ncc-top\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(mobile.body).toMatch(/\.ncc-search\s*\{[^}]*width:\s*auto/);
    // Item 1: the hamburger appears and the brand drops, so the workgroup
    // selector — DESIGN §3.5's primary filter axis — always has room.
    expect(mobile.body).toMatch(/\.ncc-hamburger\s*\{\s*display:\s*inline-flex/);
    expect(mobile.body).toMatch(/\.ncc-brand\s*\{\s*display:\s*none/);
  });

  it('swaps the quick-reply row for a dropdown, so it costs no row of its own (item 3)', () => {
    expect(mobile.body).toMatch(/\.ncc-composer-chips\s*\{\s*display:\s*none/);
    expect(mobile.body).toMatch(/\.ncc-composer-quickmenu\s*\{\s*display:\s*inline-flex/);
    // And the desktop default is the reverse — both are always in the DOM
    // (ThreadDetail.tsx), only the breakpoint decides which is on screen.
    expect(block('.ncc-composer-chips')).toMatch(/display:\s*flex/);
    expect(block('.ncc-composer-quickmenu')).toMatch(/display:\s*none/);
  });
});
