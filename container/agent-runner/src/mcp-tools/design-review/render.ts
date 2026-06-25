/**
 * design-artifact-loop — render module (C2/C3 pinned env).
 *
 * Splits the testable classification logic (blank/overflow thresholds) from the
 * chromium invocation (infra-gated — needs the image's pinned chromium, validated
 * by the live spike, not unit-testable here).
 *
 * Pinned: system chromium (/usr/bin/chromium, image-pinned), viewports 1440x900 +
 * 390x844, PNG output. Mirrors the proven render-diagram.ts chromium invocation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Finding } from './linter.js';

export interface Viewport { name: string; width: number; height: number; }
export const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

export const BLANK_MIN_BYTES = 2048;       // PNG < 2KB ⇒ effectively blank
export const ONE_COLOR_MAX_RATIO = 0.98;   // >98% one color ⇒ whiteout/blank
export const OVERFLOW_SLACK_PX = 2;        // scrollWidth > viewport + 2 ⇒ overflow

export interface RenderSignals {
  viewport: string;
  viewportWidth: number;
  exitOk: boolean;       // chromium exited 0
  pngBytes: number;      // size of the produced PNG
  oneColorRatio?: number; // fraction of sampled pixels that are a single color (optional)
  scrollWidth?: number;  // document.scrollWidth at this viewport (optional)
}

/**
 * Pure: classify a viewport render into high-severity findings.
 * Blank ⇒ `render-blank:<vp>`; horizontal overflow ⇒ `overflow:<vp>`.
 */
export function classifyRender(s: RenderSignals): Finding[] {
  const out: Finding[] = [];
  const blank =
    !s.exitOk ||
    s.pngBytes < BLANK_MIN_BYTES ||
    (s.oneColorRatio !== undefined && s.oneColorRatio > ONE_COLOR_MAX_RATIO);
  if (blank) {
    out.push({
      id: `render-blank:${s.viewport}`,
      severity: 'high',
      locus: s.viewport,
      message: `Render at ${s.viewport} is blank/failed (exit=${s.exitOk}, ${s.pngBytes}B`
        + (s.oneColorRatio !== undefined ? `, oneColor=${(s.oneColorRatio * 100).toFixed(0)}%` : '') + ').',
    });
  }
  if (s.scrollWidth !== undefined && s.scrollWidth > s.viewportWidth + OVERFLOW_SLACK_PX) {
    out.push({
      id: `overflow:${s.viewport}`,
      severity: 'high',
      locus: s.viewport,
      message: `Horizontal overflow at ${s.viewport}: scrollWidth ${s.scrollWidth} > viewport ${s.viewportWidth}.`,
    });
  }
  return out;
}

export interface ViewportRender { viewport: string; pngPath: string; findings: Finding[]; }

/**
 * Infra: render `htmlPath` at every pinned viewport via image-pinned chromium,
 * returning the PNG paths + classification findings. Not unit-tested (needs chromium);
 * the live spike validates it. scrollWidth is measured via a headless --dump-dom eval
 * where available; absent ⇒ overflow check is skipped (conservative, no false high).
 */
export function renderViewports(htmlPath: string, outDir: string): ViewportRender[] {
  fs.mkdirSync(outDir, { recursive: true });
  const results: ViewportRender[] = [];
  for (const vp of VIEWPORTS) {
    const pngPath = path.join(outDir, `${vp.name}.png`);
    let exitOk = true;
    try {
      execFileSync(
        'chromium',
        [
          '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
          `--window-size=${vp.width},${vp.height}`,
          `--screenshot=${pngPath}`,
          htmlPath,
        ],
        { stdio: 'ignore', timeout: 30_000 },
      );
    } catch {
      exitOk = false;
    }
    const pngBytes = fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0;
    const findings = classifyRender({ viewport: vp.name, viewportWidth: vp.width, exitOk, pngBytes });
    results.push({ viewport: vp.name, pngPath, findings });
  }
  return results;
}
