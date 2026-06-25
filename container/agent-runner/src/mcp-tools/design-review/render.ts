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
export const OVERFLOW_SLACK_PX = 2;        // scrollWidth > viewport + 2 ⇒ overflow

/** Layout metrics measured from the rendered page (all-or-nothing — present iff the measure pass succeeded). */
export interface DomMetrics {
  scrollWidth: number;   // document.documentElement.scrollWidth at this viewport
  scrollHeight: number;  // document.documentElement.scrollHeight at this viewport
  textLen: number;       // body.innerText length (trimmed)
}

export interface RenderSignals {
  viewport: string;
  viewportWidth: number;
  viewportHeight: number;
  exitOk: boolean;       // chromium exited 0
  pngBytes: number;      // size of the produced PNG
  dom?: DomMetrics;      // present iff the headless measure pass returned metrics
}

/**
 * Pure: classify a viewport render into high-severity findings.
 * Blank ⇒ `render-blank:<vp>`; horizontal overflow ⇒ `overflow:<vp>`.
 *
 * Blank is detected from (a) a failed chromium exit, (b) a sub-2KB PNG, or (c) an
 * EMPTY DOM (no text and no content height beyond the viewport). NOTE: (c) catches a
 * truly empty render; a styled-but-invisible whiteout (e.g. white-on-white text) has
 * DOM text so it is NOT caught here — true pixel-ratio whiteout detection needs a PNG
 * decoder (supply-chain-gated dep, deferred). The L1 vision critic, which Reads the PNG,
 * is the backstop for that case.
 */
export function classifyRender(s: RenderSignals): Finding[] {
  const out: Finding[] = [];
  const domBlank =
    s.dom !== undefined &&
    s.dom.textLen === 0 &&
    s.dom.scrollHeight <= s.viewportHeight + OVERFLOW_SLACK_PX;
  const blank = !s.exitOk || s.pngBytes < BLANK_MIN_BYTES || domBlank;
  if (blank) {
    out.push({
      id: `render-blank:${s.viewport}`,
      severity: 'high',
      locus: s.viewport,
      message: `Render at ${s.viewport} is blank/failed (exit=${s.exitOk}, ${s.pngBytes}B`
        + (domBlank ? ', empty DOM' : '') + ').',
    });
  }
  if (s.dom !== undefined && s.dom.scrollWidth > s.viewportWidth + OVERFLOW_SLACK_PX) {
    out.push({
      id: `overflow:${s.viewport}`,
      severity: 'high',
      locus: s.viewport,
      message: `Horizontal overflow at ${s.viewport}: scrollWidth ${s.dom.scrollWidth} > viewport ${s.viewportWidth}.`,
    });
  }
  return out;
}

export interface ViewportRender { viewport: string; pngPath: string; findings: Finding[]; }

// Mirror render-diagram.ts's proven hardened flags: no sandbox escape, no /dev/shm
// exhaustion, no local file:// cross-origin reads.
const CHROMIUM_BASE_ARGS = [
  '--headless',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-file-access-from-files',
  '--hide-scrollbars',
];

const MEASURE_SENTINEL = '__NC_DR__';

/**
 * Measure layout metrics at `width` by rendering a COPY of the artifact with a tiny
 * measurement script injected (mirrors render-diagram.ts's __NC_DIAG_H__ pattern). The
 * script writes scrollWidth,scrollHeight,textLen into <title>; we read it back via
 * `--dump-dom` (which waits for load). The injected script runs only in this throwaway
 * copy in the sandbox — the artifact under test stays no-JS. Returns null if anything
 * fails (⇒ overflow/empty-DOM checks are conservatively skipped, no false high).
 */
function measureDom(html: string, outDir: string, vpName: string, width: number): DomMetrics | null {
  const inject =
    `<script>window.addEventListener('load',function(){`
    + `var d=document.documentElement,b=document.body;`
    + `document.title='${MEASURE_SENTINEL}:'+d.scrollWidth+','+d.scrollHeight+','+`
    + `((b&&b.innerText||'').trim().length);});</script>`;
  const measured = html.includes('</body>')
    ? html.replace('</body>', `${inject}</body>`)
    : html + inject;
  const tmp = path.join(outDir, `.measure-${vpName}.html`);
  try {
    fs.writeFileSync(tmp, measured);
    const dom = execFileSync(
      'chromium',
      [...CHROMIUM_BASE_ARGS, `--window-size=${width},900`, '--dump-dom', `file://${tmp}`],
      { timeout: 15_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const m = dom.match(new RegExp(`${MEASURE_SENTINEL}:(\\d+),(\\d+),(\\d+)`));
    if (!m) return null;
    const [scrollWidth, scrollHeight, textLen] = [m[1], m[2], m[3]].map((n) => parseInt(n, 10));
    if (![scrollWidth, scrollHeight, textLen].every(Number.isFinite)) return null;
    return { scrollWidth, scrollHeight, textLen };
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Infra: render `htmlPath` at every pinned viewport via image-pinned chromium,
 * returning the PNG paths + classification findings. Not unit-tested (needs chromium);
 * the live spike validates it. Layout metrics (scrollWidth/scrollHeight/textLen) are
 * measured via an injected-script + --dump-dom pass so the overflow/empty-DOM checks
 * actually fire in production; when the measure pass fails those checks are skipped.
 */
export function renderViewports(htmlPath: string, outDir: string): ViewportRender[] {
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const results: ViewportRender[] = [];
  for (const vp of VIEWPORTS) {
    const pngPath = path.join(outDir, `${vp.name}.png`);
    let exitOk = true;
    try {
      execFileSync(
        'chromium',
        [
          ...CHROMIUM_BASE_ARGS,
          `--window-size=${vp.width},${vp.height}`,
          `--screenshot=${pngPath}`,
          `file://${htmlPath}`,
        ],
        { stdio: 'ignore', timeout: 30_000 },
      );
    } catch {
      exitOk = false;
    }
    const pngBytes = fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0;
    const dom = measureDom(html, outDir, vp.name, vp.width) ?? undefined;
    const findings = classifyRender({
      viewport: vp.name, viewportWidth: vp.width, viewportHeight: vp.height, exitOk, pngBytes, dom,
    });
    results.push({ viewport: vp.name, pngPath, findings });
  }
  return results;
}
