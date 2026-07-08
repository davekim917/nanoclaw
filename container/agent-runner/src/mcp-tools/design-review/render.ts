/**
 * design-artifact-loop — render module (C2/C3 pinned env).
 *
 * Splits the testable classification logic (blank/overflow thresholds) from the
 * chromium invocation (infra-gated — needs the image's pinned chromium, validated
 * by the live spike, not unit-testable here).
 *
 * Chromium binary: $CHROMIUM_BIN if set, else `chromium` on PATH. Viewports
 * 1440x900 + 390x844, PNG output.
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
  // documentElement.clientWidth = the ACTUAL layout-viewport width chromium used. Overflow is
  // judged against this, not the requested vp.width: headless chromium can floor a small
  // --window-size (e.g. 390) to a wider layout — or fall back to the ~980 default when the
  // artifact has no viewport meta — which made content that actually fits false-positive
  // against the requested width (every page, even blank, tripped overflow:mobile). Optional
  // with a viewportWidth fallback so older callers/tests are byte-unaffected. See classifyRender.
  clientWidth?: number;
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
  // Judge overflow against the ACTUAL layout width chromium used (clientWidth), not the
  // requested vp.width — the canonical `scrollWidth > clientWidth` idiom. This is immune to
  // headless chromium flooring a small --window-size (or the no-viewport-meta ~980 fallback),
  // which otherwise false-positived every page against the requested width. Falls back to
  // viewportWidth when clientWidth is absent (older callers/tests). See DomMetrics.clientWidth.
  const layoutWidth = s.dom?.clientWidth ?? s.viewportWidth;
  if (s.dom !== undefined && s.dom.scrollWidth > layoutWidth + OVERFLOW_SLACK_PX) {
    out.push({
      id: `overflow:${s.viewport}`,
      severity: 'high',
      locus: s.viewport,
      message: `Horizontal overflow at ${s.viewport}: scrollWidth ${s.dom.scrollWidth} > layout width ${layoutWidth}.`,
    });
  }
  return out;
}

export interface ViewportRender { viewport: string; pngPath: string; findings: Finding[]; }

// Mirror render-diagram.ts's proven hardened flags: no sandbox escape, no /dev/shm
// exhaustion, no local file:// cross-origin reads.
//
// EGRESS ISOLATION (the robust no-egress boundary — verified against the container's
// chromium 149): --host-resolver-rules fails DNS for every host EXCEPT the declared font
// CDN, so the render cannot fetch ANY external resource regardless of how the artifact
// tries (src/<base>/object/iframe/url()/srcdoc/…). This makes the deterministic linter's
// network checks advisory (fast feedback + keeping the DELIVERED artifact clean) rather
// than the security boundary — so we don't chase every fetch-bearing HTML construct in
// regex. The font CDN allowlist mirrors linter.ts's FONT_CDN_HOSTS. JS may still execute
// during a render, but with the network blocked and the render thrown away it cannot
// egress or persist (and --blink-settings=scriptEnabled=false breaks --screenshot on
// chromium 149, so it is deliberately not used).
const FONT_CDN_RESOLVER_RULE =
  'MAP * ~NOTFOUND , EXCLUDE fonts.googleapis.com , EXCLUDE fonts.gstatic.com';
const CHROMIUM_BASE_ARGS = [
  '--headless',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-file-access-from-files',
  '--hide-scrollbars',
  `--host-resolver-rules=${FONT_CDN_RESOLVER_RULE}`,
];

const CHROMIUM = process.env.CHROMIUM_BIN || 'chromium';

const MEASURE_SENTINEL = '__NC_DR__';

// Monotonic suffix so each render call's throwaway measure file is unique even for
// overlapping calls on the same id/token/viewport (Codex P2): otherwise one call's
// `finally` unlink could delete a file another call is mid-`--dump-dom` on.
let measureSeq = 0;

/**
 * Measure layout metrics at `width` by rendering a COPY of the artifact with a tiny
 * measurement script injected (mirrors render-diagram.ts's __NC_DIAG_H__ pattern). The
 * script writes scrollWidth,scrollHeight,textLen into <title>; we read it back via
 * `--dump-dom` (which waits for load). The injected script runs only in this throwaway
 * copy in the sandbox — the artifact under test stays no-JS. Returns null if anything
 * fails (⇒ overflow/empty-DOM checks are conservatively skipped, no false high).
 */
function measureDom(html: string, outDir: string, vpName: string, width: number, height: number): DomMetrics | null {
  const inject =
    `<script>window.addEventListener('load',function(){`
    + `var d=document.documentElement,b=document.body;`
    + `document.title='${MEASURE_SENTINEL}:'+d.scrollWidth+','+d.scrollHeight+','+`
    + `((b&&b.innerText||'').trim().length)+','+d.clientWidth;});</script>`;
  // Strip any Content-Security-Policy <meta> from the THROWAWAY measure copy (Codex P2):
  // a `script-src 'none'` CSP would block the sentinel script, making measureDom return
  // null and silently skip the overflow/blank checks. The artifact itself (screenshot +
  // lint) is untouched; CSP in a static artifact is harmless and only blinds our probe.
  // Match is attribute-ORDER-independent: a <meta> is dropped if it carries BOTH an
  // http-equiv=content-security-policy and any content= (the content may precede http-equiv).
  const stripped = html.replace(/<meta\b[^>]*>/gi, (tag) =>
    /http-equiv\s*=\s*["']?content-security-policy\b/i.test(tag) ? '' : tag,
  );
  const measured = stripped.includes('</body>')
    ? stripped.replace('</body>', `${inject}</body>`)
    : stripped + inject;
  const tmp = path.join(outDir, `.measure-${vpName}-${process.pid}-${++measureSeq}.html`);
  try {
    fs.writeFileSync(tmp, measured);
    const dom = execFileSync(
      CHROMIUM,
      // probe at the SAME height as the screenshot viewport so scrollHeight is comparable
      // to viewportHeight (Codex P2: 900 ≠ the 844 mobile height ⇒ missed render-blank:mobile)
      [...CHROMIUM_BASE_ARGS, `--window-size=${width},${height}`, '--dump-dom', `file://${tmp}`],
      { timeout: 15_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const m = dom.match(new RegExp(`${MEASURE_SENTINEL}:(\\d+),(\\d+),(\\d+),(\\d+)`));
    if (!m) return null;
    const [scrollWidth, scrollHeight, textLen, clientWidth] = [m[1], m[2], m[3], m[4]].map((n) =>
      parseInt(n, 10),
    );
    if (![scrollWidth, scrollHeight, textLen, clientWidth].every(Number.isFinite)) return null;
    return { scrollWidth, scrollHeight, textLen, clientWidth };
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
export function renderViewports(htmlPath: string, outDir: string, token = ''): ViewportRender[] {
  fs.mkdirSync(outDir, { recursive: true });
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const results: ViewportRender[] = [];
  // Filenames are keyed by the artifact's reviewToken (Codex P2) so two overlapping
  // design_review calls for the same id write DISTINCT PNGs — an earlier response's
  // screenshotPaths can never point at a later artifact's pixels.
  const prefix = token ? `${token}-` : '';
  for (const vp of VIEWPORTS) {
    const pngPath = path.join(outDir, `${prefix}${vp.name}.png`);
    // Unlink any PNG from a PRIOR round first (Codex P2): if this chromium run times out
    // or crashes before writing, the existence check below must not pick up a stale
    // screenshot from an earlier artifact version (which the critic would then review as if
    // it were the current pixels).
    fs.rmSync(pngPath, { force: true });
    let exitOk = true;
    try {
      execFileSync(
        CHROMIUM,
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
    const dom = measureDom(html, outDir, vp.name, vp.width, vp.height) ?? undefined;
    const findings = classifyRender({
      viewport: vp.name, viewportWidth: vp.width, viewportHeight: vp.height, exitOk, pngBytes, dom,
    });
    results.push({ viewport: vp.name, pngPath, findings });
  }
  return results;
}
