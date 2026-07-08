/**
 * design-artifact-loop — deterministic supplement linter.
 *
 * A broader taste linter (e.g. the impeccable plugin) may own taste-tell checks
 * (overused fonts, AI editorial markers, em-dash overuse, etc.). This module
 * covers the artifact-specific structural/security checks such a linter does
 * NOT: :root token-trace, no-JS policy, network-construct lockdown.
 *
 * Pure function — no DOM dependency (Bun-native regex), so no new package
 * (supply-chain C6). Render-level checks (blank/overflow) live in render.ts and
 * are merged by the design_review tool; this module is HTML-static only.
 *
 * Finding identity is `<check-key>:<locus>` so the design_review state machine
 * can carry findings forward across rounds (R9).
 */

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  /** Stable identity `<check-key>:<locus>` — same id across rounds = same finding. */
  id: string;
  severity: Severity;
  locus: string;
  message: string;
  /**
   * Provenance. Deterministic findings (lint/render) are re-derived every round, so their
   * absence means "fixed". A `critic` finding is only present when the agent supplies it, so
   * its absence does NOT mean fixed unless a fresh critic pass reviewed the current version —
   * the state machine keeps it open until then (see mergeRound). Omitted ⇒ deterministic.
   */
  source?: 'lint' | 'render' | 'critic';
}

export interface LintOpts {
  /**
   * Marker substring an artifact may place in a CSS comment next to a
   * deliberately-chosen denylist font to justify it (e.g. the DESIGN.md picked it).
   * Defaults to `font-justified`.
   */
  fontJustificationMarker?: string;
}

/** Convergent AI-tell typefaces (mirrors impeccable's overused-font set). */
const FONT_DENYLIST = ['Inter', 'Roboto', 'Space Grotesk', 'Geist', 'Plus Jakarta Sans', 'Fraunces'];

export function lintArtifact(html: string, opts: LintOpts = {}): Finding[] {
  const findings: Finding[] = [];
  const marker = opts.fontJustificationMarker ?? 'font-justified';

  // ── 1. No-JS policy (C8): no <script> AND no inline event handlers (also JS). ──
  // IDs are CONTENT-keyed (the construct kind), not positional, so they stay stable
  // across rounds for carry-forward: a finding persists while ANY instance remains.
  if (/<script\b/i.test(html)) {
    findings.push({
      id: 'no-js:script',
      severity: 'high',
      locus: '<script>',
      message: 'v0 artifacts are static HTML/CSS only — no <script> (inline or external) permitted.',
    });
  }
  // quote-optional: catches unquoted handlers like <body onload=alert(1)> (Codex E#3 cycle-2)
  const handlers = [...new Set(Array.from(html.matchAll(/\son([a-z]+)\s*=/gi), (m) => m[1].toLowerCase()))];
  if (handlers.length) {
    findings.push({
      id: 'no-js:inline-handler',
      severity: 'high',
      locus: handlers.map((h) => `on${h}`).join(', '),
      message: `Inline event handler(s) (${handlers.map((h) => `on${h}`).join(', ')}) are executable JS — not allowed.`,
    });
  }
  if (/\bjavascript:/i.test(html)) {
    findings.push({
      id: 'no-js:javascript-url',
      severity: 'high',
      locus: 'javascript:',
      message: 'javascript: URL is executable JS — not allowed in a static artifact.',
    });
  }
  // Embedded documents can smuggle JS past the literal <script> scan (Codex P1): an
  // ENTITY-encoded script inside srcdoc (`srcdoc="&lt;script&gt;…"`), or a data:text/html
  // payload. (A *literal* <script> inside srcdoc is already caught above.) Render egress is
  // blocked at the chromium layer, so this is a delivery-cleanliness check, not the boundary.
  // iframe srcdoc can smuggle JS the literal <script> scan misses. Extract the srcdoc value
  // (quoted OR unquoted — Codex P2), decode the entity forms a browser resolves to `<`
  // (&lt; / hex &#x3c; / decimal &#60;), then look for a script/javascript: inside THAT value
  // only — scoping to the attribute avoids false-positives on displayed code samples.
  const SRCDOC = /\bsrcdoc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(SRCDOC)) {
    const decoded = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&lt;|&#x0*3c;|&#0*60;/gi, '<');
    if (/<\s*script\b/i.test(decoded) || /\bjavascript:/i.test(decoded)) {
      findings.push({ id: 'no-js:srcdoc-script', severity: 'high', locus: 'srcdoc', message: 'Embedded/encoded <script> or javascript: inside an iframe srcdoc is executable JS — not allowed.' });
      break;
    }
  }
  if (/\bdata:text\/html/i.test(html)) {
    findings.push({ id: 'no-js:data-html', severity: 'high', locus: 'data:text/html', message: 'data:text/html embeds a separate document (may carry JS) — artifacts must be a single static HTML/CSS file.' });
  }

  // ── 2. Network-construct lockdown (C8/C3): no egress beyond the declared font CDN. ──
  // External resources are keyed by HOST (stable); the documented font CDN is allowlisted.
  // NOTE: fetch()/XMLHttpRequest text-scans were REMOVED (Codex P2) — they only execute
  // inside JS, which is already a `no-js:script` finding, so scanning raw document text just
  // produced false positives on artifacts that *display* an API code sample
  // (`<code>fetch('/v1')</code>`), wrongly setting renderUnsafe and blocking visual review.
  // Entity-encoded URLs (e.g. `src='https:&#x2f;&#x2f;evil/x'`) are deliberately NOT decoded
  // here: decoding entities document-wide would re-introduce false-positives on displayed
  // code/text, and the actual egress is already prevented at the render layer by chromium's
  // --host-resolver-rules allowlist (see render.ts) — so an entity-evaded URL cannot fetch
  // regardless of this scan. This check stays a fast advisory pass over plain URL forms.
  const FONT_CDN_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
  // Capture external resource URLs from src=, <link href>, css url(), @import, srcset.
  // quote-optional throughout (Codex E#4 cycle-2: <img src=https://evil/x> must be caught).
  // addHost takes the post-scheme remainder (host[/path][?query]) and keys by HOST only;
  // NOT <a href> (navigation, allowed). The documented font CDN is allowlisted.
  const seenHosts = new Set<string>();
  const addHost = (rest: string) => {
    const host = rest.toLowerCase().split(/[/?#\s]/)[0];
    if (!host || FONT_CDN_HOSTS.has(host) || seenHosts.has(host)) return;
    seenHosts.add(host);
    findings.push({
      id: `network:${host}`,
      severity: 'high',
      locus: host,
      message: `External resource fetch to ${host} — artifacts must be self-contained (only the declared font CDN is allowed).`,
    });
  };
  // Single-URL constructs: group 2 = host[+path], stops at quote/space/> (so unquoted attrs terminate).
  // - `(?<![-\w])src` requires a real attribute boundary so `data-src` (lazy-load METADATA the
  //   browser does NOT fetch without JS) is not a false `network:` finding (Codex P2).
  // - <base href> (Codex P1): an external base silently rewrites EVERY relative resource URL
  //   to that origin, so it must trip the lockdown like a direct external src.
  // - <object data> + poster (video/audio): fetchable resources. This list is NOT exhaustive
  //   by design — the render's --host-resolver-rules allowlist is the actual egress boundary,
  //   so these patterns are fast advisory feedback, not a security guarantee.
  // SVG <image>/<use> href (incl. xlink:href) is scoped to those tags so a navigational
  // <a href> is NOT mis-flagged (Codex P2).
  const urlRes: RegExp[] = [
    /(?<![-\w])src\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /<link\b[^>]*\bhref\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /<base\b[^>]*\bhref\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /<object\b[^>]*\bdata\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /<(?:image|use)\b[^>]*\b(?:xlink:href|href)\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /\bposter\s*=\s*["']?(https?:\/\/|\/\/)([^"'\s>]+)/gi,
    /url\(\s*["']?(https?:\/\/|\/\/)([^"')\s]+)/gi,
    /@import\s+(?:url\()?\s*["']?(https?:\/\/|\/\/)([^"'\s)]+)/gi,
  ];
  for (const re of urlRes) for (const m of html.matchAll(re)) addHost(m[2]);
  // srcset is a COMMA-separated candidate list — a browser may pick ANY candidate by
  // DPR/width, so scan EVERY URL in the attribute, not just the first (Codex P2). Grab the
  // whole attribute value (quoted or bare), then pull each absolute/protocol-relative URL.
  const SRCSET_ATTR = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(SRCSET_ATTR)) {
    const val = m[1] ?? m[2] ?? m[3] ?? '';
    for (const um of val.matchAll(/(?:https?:\/\/|\/\/)([^\s,]+)/gi)) addHost(um[1]);
  }
  // Relative fetch-bearing subresources break self-containment (Codex P2): delivery sends only
  // the HTML, so `<img src="./hero.png">` / `<link rel=stylesheet href="x.css">` arrive broken.
  // Flag relative (non-scheme, non-data/blob, non-#fragment) src= and fetch-bearing <link href>.
  // Medium — doesn't block render (the asset may resolve locally), but must be inlined before ship.
  const seenRel = new Set<string>();
  const flagRelative = (val: string) => {
    const v = val.trim();
    if (!v || /^(?:[a-z]+:|\/\/|#)/i.test(v) || seenRel.has(v)) return; // absolute scheme / protocol-relative / inline-data / fragment
    seenRel.add(v);
    findings.push({
      id: `self-contained:${v}`,
      severity: 'medium',
      locus: v,
      message: `Relative subresource "${v}" — the artifact must be a SINGLE self-contained file (inline the asset as a data: URI or inline SVG/CSS); a relative path ships broken.`,
    });
  };
  for (const m of html.matchAll(/(?<![-\w])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    flagRelative(m[1] ?? m[2] ?? m[3] ?? '');
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?(?:stylesheet|preload|icon|apple-touch-icon)/i.test(m[0])) continue; // only fetch-bearing rels
    const hm = m[0].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (hm) flagRelative(hm[1] ?? hm[2] ?? hm[3] ?? '');
  }
  // DECLINED (advisory long-tail, documented): entity-encoded URLs/schemes (`java&#x73;cript:`,
  // `https:&#x2f;&#x2f;`), `imagesrcset`, and `<meta http-equiv=refresh>` are NOT chased here.
  // The render's --host-resolver-rules allowlist blocks the actual egress regardless of construct
  // (render.ts), and the container sandbox bounds an adversarial agent — so these checks would be
  // advisory-only, and decoding entities document-wide reintroduces displayed-code false-positives.

  // ── 3. :root token-trace (A8): EVERY colour literal outside :root must come from a
  // token via var(--…). Scan only CSS CONTEXTS — `<style>` block bodies + `style="…"`
  // attribute values — NOT the whole document, so visible page text like a colour-picker
  // label `#ff0000` or a ticket id `#123456` is not mistaken for a hardcoded colour (Codex
  // P2). Each fragment is `;`-wrapped so a colour at the START of an inline style
  // (`style="color:red"`) still sits behind a `[;{]` boundary for the named-colour scan.
  // Then strip (a) :root blocks (token definitions) and (b) var(...) refs (incl. hex
  // fallbacks) and flag remaining literals — hardcoding is flagged even if the value is also
  // a token (Codex E#5).
  // NOTE: BEST-EFFORT regex detection (hex, the colour functions below, bare named colours
  // in colour properties). Exotic CSS may slip; the L1 vision critic + sandboxed render are
  // the backstop, and a real CSS parser is the documented future hardening (supply-chain-
  // approved dep, deliberately deferred). Non-colour token conformance (spacing/radii) and
  // WCAG contrast are intentionally the CRITIC's job (it sees the render + DESIGN.md), not
  // this deterministic linter's — adding half-built versions here would be false confidence.
  const styleBlocks = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi), (m) => m[1]);
  // quoted OR unquoted style="" (Codex P2: `<div style=color:red>` must be traced too).
  const styleAttrs = Array.from(
    html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi),
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
  const usage = [...styleBlocks, ...styleAttrs]
    .map((c) => `;${c};`)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip CSS comments (Codex P3: a colour in a comment does not render)
    .replace(/:root\s*\{[^}]*\}/g, '')
    .replace(/var\([^)]*\)/g, 'var()');
  const seenOutsideRoot = new Set<string>();
  const flagLiteral = (raw: string) => {
    const lit = raw.toLowerCase().replace(/\s+/g, '');
    if (seenOutsideRoot.has(lit)) return;
    seenOutsideRoot.add(lit);
    findings.push({
      id: `token-trace:${lit}`,
      severity: 'high',
      locus: lit,
      message: `Hardcoded colour ${raw} used outside :root — every colour must reference a design-system token via var(--…).`,
    });
  };
  // (a) hex + colour functions (rgb/rgba/hsl/hsla/hwb/lab/lch/oklab/oklch/color())
  const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi;
  for (const m of usage.matchAll(COLOR_LITERAL)) flagLiteral(m[0]);
  // (b) bare named colours as a colour-property value (e.g. `color:rebeccapurple`).
  // Excludes CSS-wide keywords and function/var values (token-trace already covers var()).
  const COLOR_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'none', 'auto', 'var']);
  const COLOR_PROP = /(?:^|[;{]\s*)(?:color|background|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color|column-rule-color|accent-color)\s*:\s*([a-z]+)\b(?![-(\w])/gi;
  for (const m of usage.matchAll(COLOR_PROP)) {
    const name = m[1].toLowerCase();
    if (!COLOR_KEYWORDS.has(name)) flagLiteral(name);
  }
  // (c) a committed design system means real, declared tokens (Codex P2). cssText excludes
  // comments so a commented-out declaration/reference doesn't count.
  const cssText = [...styleBlocks, ...styleAttrs].join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const usesTokens = /var\(\s*--/.test(cssText);
  // Detect :root from the COMMENT-STRIPPED css, not raw HTML (Codex P2): a commented-out or
  // displayed `/* :root{--fg:#000} */` must not be mistaken for a real token declaration.
  const declaresInRoot = /:root\b[^{]*\{[^}]*--[\w-]+\s*:/.test(cssText);
  // every declared custom property, in ANY rule (tokens may be theme-scoped, not only :root)
  const declared = new Set(Array.from(cssText.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1].toLowerCase()));
  if (usesTokens && !declaresInRoot) {
    findings.push({
      id: 'token-trace:no-root',
      severity: 'high',
      locus: ':root',
      message: 'CSS references var(--…) tokens but declares no :root{ --token: value } block — commit a concrete design system (lift the :root block from the chosen tokens.css) before styling.',
    });
  }
  // Every referenced token must be DECLARED somewhere — a typo'd/undeclared var() silently
  // falls back (or drops), so a non-conforming artifact would otherwise pass (Codex P2). Only
  // when ≥1 token is declared; otherwise the no-root finding already covers "no system at all".
  if (declared.size > 0) {
    const seenRef = new Set<string>();
    for (const m of cssText.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const ref = m[1].toLowerCase();
      if (declared.has(ref) || seenRef.has(ref)) continue;
      seenRef.add(ref);
      findings.push({
        id: `token-trace:undeclared:${ref}`,
        severity: 'high',
        locus: ref,
        message: `var(${ref}) references a token that is never declared (no \`${ref}: …\` in any rule) — declare it in :root or fix the typo.`,
      });
    }
  }

  // ── 4. Font denylist (medium) — impeccable also covers this; kept as a structured finding. ──
  for (const font of FONT_DENYLIST) {
    const re = new RegExp(`font-family\\s*:[^;}]*${font.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'i');
    const m = re.exec(html);
    if (m && !html.slice(Math.max(0, m.index - 80), m.index + 80).includes(marker)) {
      findings.push({
        id: `font-denylist:${font}`,
        severity: 'medium',
        locus: `${font} @${m.index}`,
        message: `"${font}" is a convergent AI-tell typeface — choose a distinctive face or justify it with a /* ${marker} */ marker.`,
      });
    }
  }

  return findings;
}

/** Convenience: highest severity present, or null when clean. */
export function maxSeverity(findings: Finding[]): Severity | null {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  if (findings.some((f) => f.severity === 'low')) return 'low';
  return null;
}
