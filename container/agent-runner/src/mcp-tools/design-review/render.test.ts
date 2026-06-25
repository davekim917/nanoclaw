import { describe, it, expect } from 'bun:test';
import { classifyRender, BLANK_MIN_BYTES } from './render.js';

describe('classifyRender — blank/overflow thresholds', () => {
  it('test_good_render_no_findings', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, exitOk: true, pngBytes: 50_000, scrollWidth: 1440 });
    expect(f).toHaveLength(0);
  });

  it('test_nonzero_exit_is_blank_high', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, exitOk: false, pngBytes: 50_000 });
    expect(f.find((x) => x.id === 'render-blank:desktop')?.severity).toBe('high');
  });

  it('test_tiny_png_is_blank', () => {
    const f = classifyRender({ viewport: 'mobile', viewportWidth: 390, exitOk: true, pngBytes: BLANK_MIN_BYTES - 1 });
    expect(f.some((x) => x.id === 'render-blank:mobile')).toBe(true);
  });

  it('test_one_color_whiteout_is_blank', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, exitOk: true, pngBytes: 9000, oneColorRatio: 0.99 });
    expect(f.some((x) => x.id === 'render-blank:desktop')).toBe(true);
  });

  it('test_overflow_flagged', () => {
    const f = classifyRender({ viewport: 'mobile', viewportWidth: 390, exitOk: true, pngBytes: 40_000, scrollWidth: 520 });
    expect(f.find((x) => x.id === 'overflow:mobile')?.severity).toBe('high');
  });

  it('test_within_slack_no_overflow', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, exitOk: true, pngBytes: 40_000, scrollWidth: 1441 });
    expect(f.some((x) => x.id.startsWith('overflow:'))).toBe(false);
  });

  it('test_missing_scrollwidth_skips_overflow', () => {
    const f = classifyRender({ viewport: 'desktop', viewportWidth: 1440, exitOk: true, pngBytes: 40_000 });
    expect(f.some((x) => x.id.startsWith('overflow:'))).toBe(false); // conservative: no false high
  });
});
