import { describe, it, expect } from 'bun:test';
import { classifyRender, BLANK_MIN_BYTES } from './render.js';

const HEALTHY = { scrollWidth: 1440, scrollHeight: 2000, textLen: 500 };

describe('classifyRender — blank/overflow thresholds', () => {
  it('test_good_render_no_findings', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: true, pngBytes: 50_000, dom: HEALTHY });
    expect(f).toHaveLength(0);
  });

  it('test_nonzero_exit_is_blank_high', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: false, pngBytes: 50_000 });
    expect(f.find((x) => x.id === 'render-blank:desktop')?.severity).toBe('high');
  });

  it('test_tiny_png_is_blank', () => {
    const f = classifyRender({ viewport: 'mobile', viewportWidth: 390, viewportHeight: 844, exitOk: true, pngBytes: BLANK_MIN_BYTES - 1 });
    expect(f.some((x) => x.id === 'render-blank:mobile')).toBe(true);
  });

  it('test_empty_dom_is_blank', () => {
    // measured: no text and no content height beyond the viewport ⇒ empty render (Codex P1:
    // this branch is now reachable because renderViewports actually measures the DOM)
    const f = classifyRender({
      viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: true, pngBytes: 9000,
      dom: { scrollWidth: 1440, scrollHeight: 900, textLen: 0 },
    });
    expect(f.some((x) => x.id === 'render-blank:desktop')).toBe(true);
  });

  it('test_content_present_not_blank', () => {
    // a tall page with text is NOT blank even though it is one solid background colour
    const f = classifyRender({
      viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: true, pngBytes: 9000,
      dom: { scrollWidth: 1440, scrollHeight: 3200, textLen: 1200 },
    });
    expect(f.some((x) => x.id === 'render-blank:desktop')).toBe(false);
  });

  it('test_overflow_flagged', () => {
    const f = classifyRender({
      viewport: 'mobile', viewportWidth: 390, viewportHeight: 844, exitOk: true, pngBytes: 40_000,
      dom: { scrollWidth: 520, scrollHeight: 1200, textLen: 300 },
    });
    expect(f.find((x) => x.id === 'overflow:mobile')?.severity).toBe('high');
  });

  it('test_within_slack_no_overflow', () => {
    const f = classifyRender({
      viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: true, pngBytes: 40_000,
      dom: { scrollWidth: 1441, scrollHeight: 2000, textLen: 300 },
    });
    expect(f.some((x) => x.id.startsWith('overflow:'))).toBe(false);
  });

  it('test_floored_viewport_no_false_overflow', () => {
    // Regression: headless chromium floored the 390 request to a wider layout (or used the
    // ~980 no-viewport-meta fallback). scrollWidth equals the ACTUAL layout width (clientWidth)
    // ⇒ NOT overflow, even though scrollWidth > the requested viewportWidth. Previously this
    // false-high'd on every page (a blank page tripped overflow:mobile too).
    const f = classifyRender({
      viewport: 'mobile', viewportWidth: 390, viewportHeight: 844, exitOk: true, pngBytes: 40_000,
      dom: { scrollWidth: 500, scrollHeight: 1200, textLen: 300, clientWidth: 500 },
    });
    expect(f.some((x) => x.id.startsWith('overflow:'))).toBe(false);
  });

  it('test_real_overflow_against_clientWidth', () => {
    // Content genuinely wider than the actual layout viewport ⇒ still flagged high.
    const f = classifyRender({
      viewport: 'mobile', viewportWidth: 390, viewportHeight: 844, exitOk: true, pngBytes: 40_000,
      dom: { scrollWidth: 700, scrollHeight: 1200, textLen: 300, clientWidth: 500 },
    });
    expect(f.find((x) => x.id === 'overflow:mobile')?.severity).toBe('high');
  });

  it('test_unmeasured_dom_skips_overflow_and_dom_blank', () => {
    // measure pass failed (dom undefined) ⇒ overflow + empty-DOM checks skipped (no false high)
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, viewportHeight: 900, exitOk: true, pngBytes: 40_000 });
    expect(f.some((x) => x.id.startsWith('overflow:'))).toBe(false);
    expect(f.some((x) => x.id.startsWith('render-blank:'))).toBe(false);
  });
});
