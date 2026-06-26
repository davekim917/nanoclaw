import { describe, it, expect } from 'bun:test';
import { lintArtifact, maxSeverity } from './linter.js';

const GOOD = `<!doctype html><html><head><style>
  :root { --bg:#faf9f5; --fg:#141413; --accent:#c96442; }
  body { background: var(--bg); color: var(--fg); }
  .cta { background: var(--accent); font-family: "Newsreader", Georgia, serif; }
</style></head><body><main><h1>Hi</h1></main></body></html>`;

const SLOP = `<!doctype html><html><head><style>
  body { background:#ffffff; color:#777777; }
  h1 { font-family: "Inter", sans-serif; }
</style></head><body><h1>Hi</h1></body></html>`;

describe('lintArtifact — supplement checks', () => {
  it('test_hardcoded_hex_outside_root_flagged', () => {
    const html = `<style>:root{--x:#000}</style><div style="color:#c0ffee">x</div>`;
    const findings = lintArtifact(html);
    const f = findings.find((f) => f.id === 'token-trace:#c0ffee');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('test_inline_script_high', () => {
    const findings = lintArtifact(`<div>ok</div><script>alert(1)</script>`);
    const f = findings.find((f) => f.id.startsWith('no-js:'));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('test_external_script_and_fetch_flagged', () => {
    const findings = lintArtifact(`<script src="https://evil.example/x.js"></script><style>a{}</style>`);
    // both the <script> (no-js) and the external src (network) fire
    expect(findings.some((f) => f.id.startsWith('no-js:'))).toBe(true);
    expect(findings.some((f) => f.id.startsWith('network:'))).toBe(true);
  });

  it('test_clean_good_artifact_passes', () => {
    const findings = lintArtifact(GOOD);
    expect(findings.filter((f) => f.severity === 'high')).toHaveLength(0);
    expect(maxSeverity(findings)).toBeNull();
  });

  it('test_slop_artifact_flags', () => {
    const findings = lintArtifact(SLOP);
    // hardcoded #ffffff / #777777 outside :root → high; "Inter" → medium
    expect(findings.some((f) => f.id.startsWith('token-trace:'))).toBe(true);
    expect(findings.some((f) => f.id === 'font-denylist:Inter')).toBe(true);
    expect(maxSeverity(findings)).toBe('high');
  });

  it('test_root_tokens_not_flagged', () => {
    // hex appears only inside :root → it is a definition, not a violation
    const findings = lintArtifact(`<style>:root{--bg:#abcdef}</style><body style="background:var(--bg)"></body>`);
    expect(findings.some((f) => f.id.startsWith('token-trace:'))).toBe(false);
  });

  it('test_justified_font_not_flagged', () => {
    const html = `<style>/* font-justified: DESIGN.md picks Inter */ h1{font-family:"Inter"}</style>`;
    const findings = lintArtifact(html);
    expect(findings.some((f) => f.id === 'font-denylist:Inter')).toBe(false);
  });

  it('test_finding_ids_are_stable_for_carry_forward', () => {
    const html = `<div style="color:#c0ffee">x</div>`;
    const a = lintArtifact(html).map((f) => f.id).sort();
    const b = lintArtifact(html).map((f) => f.id).sort();
    expect(a).toEqual(b); // deterministic ids — required for R9 carry-forward
  });

  // ── QA cycle-1 (Validator CD #1): content-keyed IDs survive removal of an earlier match ──
  it('test_no_js_id_stable_when_earlier_script_removed', () => {
    const two = lintArtifact(`<script>a</script><script>b</script>`).filter((f) => f.id.startsWith('no-js:'));
    const one = lintArtifact(`<div>x</div><script>b</script>`).filter((f) => f.id.startsWith('no-js:'));
    // the surviving script keeps the SAME id (no positional shift) → correct carry-forward
    expect(two.map((f) => f.id)).toContain('no-js:script');
    expect(one.map((f) => f.id)).toContain('no-js:script');
  });

  // ── QA cycle-1 (Validator CD #2): egress evasion vectors must all be caught ──
  it('test_inline_event_handler_is_no_js', () => {
    expect(lintArtifact(`<img onerror="x" src="data:,">`).some((f) => f.id === 'no-js:inline-handler')).toBe(true);
  });
  it('test_protocol_relative_src_flagged', () => {
    expect(lintArtifact(`<img src="//evil.example/x.png">`).some((f) => f.id === 'network:evil.example')).toBe(true);
  });
  it('test_external_stylesheet_link_flagged', () => {
    expect(lintArtifact(`<link rel="stylesheet" href="https://evil.example/x.css">`).some((f) => f.id === 'network:evil.example')).toBe(true);
  });
  it('test_css_import_flagged', () => {
    expect(lintArtifact(`<style>@import "https://evil.example/x.css";</style>`).some((f) => f.id === 'network:evil.example')).toBe(true);
  });
  it('test_css_url_flagged', () => {
    expect(lintArtifact(`<style>.a{background:url(https://evil.example/x.png)}</style>`).some((f) => f.id === 'network:evil.example')).toBe(true);
  });
  it('test_srcset_flagged', () => {
    expect(lintArtifact(`<img srcset="https://evil.example/x.png 2x">`).some((f) => f.id === 'network:evil.example')).toBe(true);
  });
  it('test_srcset_scans_every_candidate', () => {
    // Codex P2: the browser may pick ANY candidate by DPR/width — an allowlisted first
    // host must not mask a non-allowlisted later one.
    const f = lintArtifact(`<img srcset="https://fonts.gstatic.com/a 1x, https://evil.example/b 2x, //also.evil/c 3x">`);
    expect(f.some((x) => x.id === 'network:evil.example')).toBe(true);
    expect(f.some((x) => x.id === 'network:also.evil')).toBe(true);
    expect(f.some((x) => x.id === 'network:fonts.gstatic.com')).toBe(false); // allowlisted
  });
  it('test_font_cdn_is_allowlisted', () => {
    const f = lintArtifact(`<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">`);
    expect(f.some((x) => x.id.startsWith('network:'))).toBe(false); // declared font CDN permitted
  });
  it('test_anchor_href_not_flagged', () => {
    // a navigational link is NOT an egress fetch
    expect(lintArtifact(`<a href="https://example.com/page">link</a>`).some((x) => x.id.startsWith('network:'))).toBe(false);
  });
  it('test_external_base_href_flagged', () => {
    // Codex P1: an external <base href> silently rewrites every relative URL to that origin
    const f = lintArtifact(`<head><base href="https://evil.example/"></head><body><img src="/pixel.png"></body>`);
    expect(f.some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_relative_base_href_not_flagged', () => {
    // a same-document relative base does not egress
    expect(lintArtifact(`<base href="/assets/">`).some((x) => x.id.startsWith('network:'))).toBe(false);
  });
  it('test_object_data_flagged', () => {
    expect(lintArtifact(`<object data="https://evil.example/p.svg"></object>`).some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_poster_flagged', () => {
    expect(lintArtifact(`<video poster="https://evil.example/p.png"></video>`).some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_data_src_not_a_fetch', () => {
    // Codex P2: data-src is lazy-load metadata, not a browser fetch — must NOT be flagged
    expect(lintArtifact(`<div data-src="https://example.com/mock.png">x</div>`).some((x) => x.id.startsWith('network:'))).toBe(false);
  });
  it('test_real_src_still_flagged_after_boundary_fix', () => {
    expect(lintArtifact(`<img src="https://evil.example/a.png">`).some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_encoded_srcdoc_script_flagged', () => {
    expect(lintArtifact(`<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`).some((x) => x.id === 'no-js:srcdoc-script')).toBe(true);
  });
  it('test_data_text_html_flagged', () => {
    expect(lintArtifact(`<iframe src="data:text/html;base64,PHNjcmlwdD4="></iframe>`).some((x) => x.id === 'no-js:data-html')).toBe(true);
  });

  // ── QA cycle-4 (Codex re-review) ──
  it('test_svg_image_href_flagged', () => {
    expect(lintArtifact(`<svg><image href="https://evil.example/p.png"/></svg>`).some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_svg_use_xlink_href_flagged', () => {
    expect(lintArtifact(`<svg><use xlink:href="https://evil.example/s.svg#i"/></svg>`).some((x) => x.id === 'network:evil.example')).toBe(true);
  });
  it('test_anchor_href_still_not_flagged', () => {
    // the SVG href patterns are tag-scoped — a navigational <a href> must stay allowed
    expect(lintArtifact(`<a href="https://example.com/page">go</a>`).some((x) => x.id.startsWith('network:'))).toBe(false);
  });
  it('test_decimal_entity_srcdoc_script_flagged', () => {
    expect(lintArtifact(`<iframe srcdoc="&#60;script&#62;alert(1)&#60;/script&#62;"></iframe>`).some((x) => x.id === 'no-js:srcdoc-script')).toBe(true);
  });
  it('test_unquoted_inline_style_color_flagged', () => {
    expect(lintArtifact(`<div style=color:red>x</div>`).some((x) => x.id === 'token-trace:red')).toBe(true);
  });
  it('test_visible_code_sample_not_a_network_call', () => {
    // Codex P2: an API code sample shown as page content must NOT trip a network finding
    const f = lintArtifact(`<style>:root{--c:#000}body{color:var(--c)}</style><pre><code>fetch('/v1/items')</code></pre>`);
    expect(f.some((x) => x.id.startsWith('network:'))).toBe(false);
  });

  // ── QA cycle-5 (Codex re-review) ──
  it('test_unquoted_srcdoc_script_flagged', () => {
    expect(lintArtifact(`<iframe srcdoc=&lt;script&gt;alert(1)&lt;/script&gt;></iframe>`).some((x) => x.id === 'no-js:srcdoc-script')).toBe(true);
  });
  it('test_no_root_token_block_flagged', () => {
    // Codex P2: var(--…) with no :root token block = no committed design system
    const f = lintArtifact(`<style>body{color:var(--fg,#000);background:var(--bg)}</style>`);
    expect(f.some((x) => x.id === 'token-trace:no-root')).toBe(true);
  });
  it('test_declared_root_with_tokens_not_no_root_flagged', () => {
    const f = lintArtifact(`<style>:root{--fg:#141413;--bg:#faf9f5}body{color:var(--fg);background:var(--bg)}</style>`);
    expect(f.some((x) => x.id === 'token-trace:no-root')).toBe(false);
  });
  it('test_no_styling_no_root_finding', () => {
    // an artifact with no var() usage is not required to declare :root
    expect(lintArtifact(`<main><h1>Hi</h1></main>`).some((x) => x.id === 'token-trace:no-root')).toBe(false);
  });

  // ── QA cycle-6 (Codex re-review) ──
  it('test_undeclared_token_reference_flagged', () => {
    // Codex P2: :root declares --bg but body references an undeclared --fg
    const f = lintArtifact(`<style>:root{--bg:#fff}body{color:var(--fg);background:var(--bg)}</style>`);
    expect(f.some((x) => x.id === 'token-trace:undeclared:--fg')).toBe(true);
    expect(f.some((x) => x.id === 'token-trace:undeclared:--bg')).toBe(false); // declared
  });
  it('test_theme_scoped_token_not_flagged_undeclared', () => {
    // a token declared on a non-:root selector still counts as declared
    const f = lintArtifact(`<style>:root{--bg:#fff}.dark{--accent:#f00}.btn{color:var(--accent)}body{background:var(--bg)}</style>`);
    expect(f.some((x) => x.id.startsWith('token-trace:undeclared'))).toBe(false);
  });
  it('test_color_literal_in_css_comment_not_flagged', () => {
    // Codex P3: a colour literal living only in a CSS comment does not render
    const f = lintArtifact(`<style>:root{--c:#000}body{color:var(--c)}/* legacy brand #ff0000 was here */</style>`);
    expect(f.some((x) => x.id.startsWith('token-trace:'))).toBe(false);
  });

  // ── QA cycle-7 (Codex re-review) ──
  it('test_commented_root_does_not_satisfy_token_block', () => {
    // Codex P2: a commented-out :root must not be mistaken for a real declaration
    const f = lintArtifact(`<style>/* :root{--fg:#000} */ body{color:var(--fg)}</style>`);
    expect(f.some((x) => x.id === 'token-trace:no-root')).toBe(true);
  });
  it('test_relative_src_flagged_not_self_contained', () => {
    expect(lintArtifact(`<img src="./hero.png">`).some((x) => x.id === 'self-contained:./hero.png')).toBe(true);
    expect(lintArtifact(`<img src="hero.png">`).some((x) => x.id === 'self-contained:hero.png')).toBe(true);
  });
  it('test_relative_stylesheet_link_flagged', () => {
    expect(lintArtifact(`<link rel="stylesheet" href="./style.css">`).some((x) => x.id === 'self-contained:./style.css')).toBe(true);
  });
  it('test_absolute_and_inline_src_not_self_contained_flagged', () => {
    // absolute (already a network finding), data: URI, and protocol-relative are not "relative subresource"
    expect(lintArtifact(`<img src="https://cdn.example/x.png">`).some((x) => x.id.startsWith('self-contained:'))).toBe(false);
    expect(lintArtifact(`<img src="data:image/png;base64,iVBOR">`).some((x) => x.id.startsWith('self-contained:'))).toBe(false);
    expect(lintArtifact(`<use href="#icon"/>`).some((x) => x.id.startsWith('self-contained:'))).toBe(false);
  });
  it('test_canonical_link_and_anchor_not_flagged', () => {
    // non-fetch-bearing <link rel=canonical> and navigational <a> are not subresources
    expect(lintArtifact(`<link rel="canonical" href="./page"><a href="./other">x</a>`).some((x) => x.id.startsWith('self-contained:'))).toBe(false);
  });

  // ── QA cycle-3 (Codex re-review): token-trace scans CSS contexts only ──
  it('test_visible_text_hex_not_flagged', () => {
    // a hex shown as page content (colour-picker value, ticket id) is NOT CSS — no finding
    const f = lintArtifact(`<style>:root{--c:#000}body{color:var(--c)}</style><span>#ff0000</span><p>ticket #123456</p>`);
    expect(f.some((x) => x.id.startsWith('token-trace:'))).toBe(false);
  });
  it('test_named_color_at_start_of_inline_style_flagged', () => {
    expect(lintArtifact(`<div style="color:red">x</div>`).some((x) => x.id === 'token-trace:red')).toBe(true);
  });
  it('test_hex_in_inline_style_flagged', () => {
    expect(lintArtifact(`<div style="background:#abc123">x</div>`).some((x) => x.id === 'token-trace:#abc123')).toBe(true);
  });

  // ── QA cycle-1 (Codex E): token-trace reuse + non-hex colours + javascript: ──
  it('test_token_hex_reuse_outside_root_flagged', () => {
    // hardcoding a literal is a violation even if the same hex is a token value
    const f = lintArtifact(`<style>:root{--brand:#123456}.x{color:#123456}</style>`);
    expect(f.some((x) => x.id === 'token-trace:#123456')).toBe(true);
  });
  it('test_rgb_literal_outside_root_flagged', () => {
    expect(lintArtifact(`<style>.x{background:rgb(1 2 3)}</style>`).some((x) => x.id.startsWith('token-trace:rgb'))).toBe(true);
  });
  it('test_hsl_literal_outside_root_flagged', () => {
    expect(lintArtifact(`<style>.x{color:hsl(200,50%,50%)}</style>`).some((x) => x.id.startsWith('token-trace:hsl'))).toBe(true);
  });
  it('test_var_with_hex_fallback_not_flagged', () => {
    // a hex inside var(...) is a legit token fallback, not a hardcoded literal
    expect(lintArtifact(`<style>:root{--c:#000}.x{color:var(--c, #fff)}</style>`).some((x) => x.id.startsWith('token-trace:'))).toBe(false);
  });
  it('test_javascript_url_flagged', () => {
    expect(lintArtifact(`<a href="javascript:alert(1)">x</a>`).some((x) => x.id === 'no-js:javascript-url')).toBe(true);
  });

  // ── QA cycle-2 (Codex re-review): unquoted attrs + named/modern colours ──
  it('test_unquoted_inline_handler_flagged', () => {
    expect(lintArtifact(`<body onload=alert(1)>x</body>`).some((x) => x.id === 'no-js:inline-handler')).toBe(true);
  });
  it('test_unquoted_external_src_flagged', () => {
    expect(lintArtifact(`<img src=https://evil.test/a.png>`).some((x) => x.id === 'network:evil.test')).toBe(true);
  });
  it('test_oklch_literal_flagged', () => {
    expect(lintArtifact(`<style>.x{background:oklch(60% 0.12 250)}</style>`).some((x) => x.id.startsWith('token-trace:oklch'))).toBe(true);
  });
  it('test_named_color_flagged', () => {
    expect(lintArtifact(`<style>.x{color:rebeccapurple}</style>`).some((x) => x.id === 'token-trace:rebeccapurple')).toBe(true);
  });
  it('test_color_keyword_not_flagged', () => {
    const f = lintArtifact(`<style>:root{--fg:#000}.a{color:transparent}.b{background:inherit}.c{color:var(--fg)}</style>`);
    expect(f.some((x) => x.id.startsWith('token-trace:'))).toBe(false);
  });
  it('test_gradient_keyword_not_false_positive', () => {
    // the gradient function name must not be mistaken for a named colour
    expect(lintArtifact(`<style>:root{--a:#111;--b:#222}.x{background:linear-gradient(90deg,var(--a),var(--b))}</style>`).some((x) => x.id.startsWith('token-trace:'))).toBe(false);
  });
});
