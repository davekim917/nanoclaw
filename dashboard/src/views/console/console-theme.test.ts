import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * The palette, machine-checked (DESIGN.md §7).
 *
 * Colour rules are the ones that ship broken in silence: nothing throws, no
 * test fails, and a filled chip is simply unreadable for anyone who happens to
 * be in dark mode. So the contrast maths runs here rather than living in a
 * reviewer's head.
 */

// Vitest runs from `dashboard/`; `import.meta.url` is an http URL under jsdom.
const css = fs.readFileSync(path.join(process.cwd(), 'src/views/console/console.css'), 'utf8');
/** The same file with comments stripped — a rule that names the banned faces in
 *  prose must not be mistaken for one that uses them. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Tokens declared in one selector block of console.css. */
function tokensIn(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  expect(at, `${selector} must exist in console.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (
    0.2126 * channel(((n >> 16) & 255) / 255) +
    0.7152 * channel(((n >> 8) & 255) / 255) +
    0.0722 * channel((n & 255) / 255)
  );
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const LIGHT = tokensIn(':root {');
/** Both dark triggers must define the same palette — a toggle that disagrees
 *  with the system setting is two designs, not one. */
const DARK_MEDIA = tokensIn(":root:not([data-theme='light'])");
const DARK_ATTR = tokensIn(":root[data-theme='dark']");

const AA = 4.5;

describe('the full light palette is declared on bare :root', () => {
  it('carries every token the dark blocks redefine', () => {
    // A colour whose ONLY definition lives inside a media query has no value at
    // all when the query does not match.
    for (const key of Object.keys(DARK_MEDIA)) expect(LIGHT, `${key} missing from :root`).toHaveProperty(key);
  });

  it('matches DESIGN §7.1 exactly', () => {
    expect(LIGHT['--ncc-page']).toBe('#f7f7f7');
    expect(LIGHT['--ncc-topbar']).toBe('#f3f3f3');
    expect(LIGHT['--ncc-sidebar']).toBe('#f0f0f0');
    expect(LIGHT['--ncc-wash']).toBe('#ffe0da');
    expect(LIGHT['--ncc-border']).toBe('#cecece');
    expect(LIGHT['--ncc-chip']).toBe('#dedede');
    expect(LIGHT['--ncc-wash-chip']).toBe('#eacfca');
    expect(LIGHT['--ncc-divider']).toBe('#dfdfdf');
    expect(LIGHT['--ncc-ink']).toBe('#141414');
    expect(LIGHT['--ncc-secondary']).toBe('#525252');
    expect(LIGHT['--ncc-muted']).toBe('#636363');
    expect(LIGHT['--ncc-attention']).toBe('#b32322');
    expect(LIGHT['--ncc-live']).toBe('#006c24');
    expect(LIGHT['--ncc-decor']).toBe('#808080');
  });
});

describe('dark mode answers BOTH triggers, identically', () => {
  it('the system setting yields to an explicit light choice', () => {
    // `:root:not([data-theme='light'])` inside the media query is the whole
    // point — without the guard, choosing light in a dark OS does nothing.
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('the explicit toggle wins in a light system too', () => {
    expect(Object.keys(DARK_ATTR).length).toBeGreaterThan(0);
    expect(DARK_ATTR).toEqual(DARK_MEDIA);
  });

  it('matches DESIGN §7.1 exactly', () => {
    expect(DARK_ATTR['--ncc-page']).toBe('#0d0d0d');
    expect(DARK_ATTR['--ncc-wash']).toBe('#2c110f');
    expect(DARK_ATTR['--ncc-border']).toBe('#292929');
    expect(DARK_ATTR['--ncc-chip']).toBe('#292929');
    expect(DARK_ATTR['--ncc-ink']).toBe('#dedede');
    expect(DARK_ATTR['--ncc-secondary']).toBe('#989898');
    expect(DARK_ATTR['--ncc-muted']).toBe('#868686');
    expect(DARK_ATTR['--ncc-attention']).toBe('#f66e5c');
    expect(DARK_ATTR['--ncc-live']).toBe('#45b164');
  });
});

describe('§7.2 — filled chips flip their text colour in dark mode', () => {
  it('white on a dark accent is exactly the failure the rule exists to stop', () => {
    // Stated as a fact, not an opinion: this is why the flip is a rule.
    expect(contrast('#ffffff', DARK_ATTR['--ncc-attention']!)).toBeLessThan(AA);
    expect(contrast('#ffffff', DARK_ATTR['--ncc-live']!)).toBeLessThan(AA);
  });

  it('--ncc-on-accent is near-black in dark and clears AA on both accents', () => {
    const onAccent = DARK_ATTR['--ncc-on-accent']!;
    expect(luminance(onAccent)).toBeLessThan(0.05);
    expect(contrast(onAccent, DARK_ATTR['--ncc-attention']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(onAccent, DARK_ATTR['--ncc-live']!)).toBeGreaterThanOrEqual(AA);
  });

  it('and stays near-white in light, where the light accents are dark enough', () => {
    const onAccent = LIGHT['--ncc-on-accent']!;
    expect(contrast(onAccent, LIGHT['--ncc-attention']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(onAccent, LIGHT['--ncc-live']!)).toBeGreaterThanOrEqual(AA);
  });

  it('applies to the inverse-filled chip too (verb button, top-bar button)', () => {
    for (const p of [LIGHT, DARK_ATTR]) {
      expect(contrast(p['--ncc-solid-ink']!, p['--ncc-solid']!)).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('§7.2 — every text pairing clears AA on the surface it actually sits on', () => {
  // "The binding constraint is the darkest light surface or the lightest dark
  // surface a colour touches, not the page background."
  const surfaces = (p: Record<string, string>) => [
    p['--ncc-page']!,
    p['--ncc-topbar']!,
    p['--ncc-sidebar']!,
    p['--ncc-wash']!,
  ];
  const inks = (p: Record<string, string>) => ({
    ink: p['--ncc-ink']!,
    secondary: p['--ncc-secondary']!,
    muted: p['--ncc-muted']!,
    attention: p['--ncc-attention']!,
    live: p['--ncc-live']!,
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK_ATTR],
  ])('%s', (_name, palette) => {
    for (const surface of surfaces(palette)) {
      for (const [role, colour] of Object.entries(inks(palette))) {
        expect(contrast(colour, surface), `${role} ${colour} on ${surface}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('keeps `muted` OFF the chip surfaces, where it is the one pairing that fails', () => {
    // 4.47:1 light, 4.00:1 dark — below AA in both. This is why `.ncc-face
    // .tm-avatar-mark` and every other chip take `--ncc-secondary`, and the
    // assertion is here so nobody "simplifies" that back to muted.
    for (const p of [LIGHT, DARK_ATTR]) {
      expect(contrast(p['--ncc-muted']!, p['--ncc-chip']!)).toBeLessThan(AA);
      expect(contrast(p['--ncc-secondary']!, p['--ncc-chip']!)).toBeGreaterThanOrEqual(AA);
      expect(contrast(p['--ncc-secondary']!, p['--ncc-wash-chip']!)).toBeGreaterThanOrEqual(AA);
    }
    expect(css).toMatch(/\.ncc-face \.tm-avatar-mark[\s\S]*?color: var\(--ncc-secondary\)/);
  });
});

describe('§7 — type', () => {
  it('uses Public Sans for prose and JetBrains Mono for machine values', () => {
    expect(LIGHT['--ncc-font-sans']).toContain('Public Sans');
    expect(LIGHT['--ncc-font-mono']).toContain('JetBrains Mono');
  });

  it('never falls back to a banned face, and self-hosts both', () => {
    for (const banned of ['Inter', 'Roboto', 'Arial', 'Fraunces']) {
      expect(code, `${banned} is banned including in fallback stacks`).not.toContain(banned);
    }
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).toContain("@import '@fontsource-variable/public-sans'");
    expect(css).toContain("@import '@fontsource-variable/jetbrains-mono'");
  });
});

describe('§7.1 — two functional signals only', () => {
  it('introduces no third status hue', () => {
    // Every literal colour in the file, minus the greys (r≈g≈b) and the two
    // sanctioned accents. A third hue means someone amended the design without
    // amending DESIGN.md.
    const hues = new Set<string>();
    for (const m of code.matchAll(/#([0-9a-f]{6})\b/g)) {
      const hex = m[1]!;
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 6) continue; // grey
      hues.add(`#${hex}`);
    }
    expect([...hues].sort()).toEqual(
      ['#006c24', '#2c110f', '#3a1a17', '#45b164', '#b32322', '#eacfca', '#f66e5c', '#ffe0da'].sort(),
    );
  });
});
