/**
 * Checks for the narrated-deck container skill's renderer.
 *
 * Lives at container/ top level because vitest includes `container/*.test.ts`
 * (see vitest.config.ts). Only the pure pieces run here — the full render
 * needs chromium, ffmpeg and the OneCLI gateway, which the host test lane does
 * not have. What these guard is the part that fails silently: a deck that
 * renders but plays the wrong slide at the wrong time, or a player page that a
 * stray "</script>" in narration breaks.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import {
  buildPlayerHtml,
  concatList,
  parseArgs,
  slideLabel,
  slugify,
  timeline,
  ttsCacheKey,
  validateDeck,
} from './skills/narrated-deck/render-deck.mjs';

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills', 'narrated-deck');
const read = (name: string) => fs.readFileSync(path.join(SKILL_DIR, name), 'utf8');

const slide = (extra: Record<string, unknown> = {}) => ({ narration: 'Revenue is up.', html: '<h1>Up</h1>', ...extra });

describe('validateDeck', () => {
  it('accepts the shipped example deck', () => {
    const { errors } = validateDeck(JSON.parse(read('example-deck.json')));
    expect(errors).toEqual([]);
  });

  it('requires a title, slides, and narration on every slide', () => {
    expect(validateDeck({ slides: [slide()] }).errors).toContain('title: required, non-empty string');
    expect(validateDeck({ title: 't', slides: [] }).errors).toContain('slides: required, non-empty array');
    expect(validateDeck({ title: 't', slides: [slide({ narration: '  ' })] }).errors).toContain(
      'slides[0].narration: required, non-empty string',
    );
  });

  it('requires exactly one visual per slide', () => {
    const none = validateDeck({ title: 't', slides: [{ narration: 'x' }] });
    expect(none.errors[0]).toMatch(/exactly one of html \| image \| jsonRender \(got none\)/);
    const two = validateDeck({ title: 't', slides: [slide({ image: 'a.png' })] });
    expect(two.errors[0]).toMatch(/got html, image/);
  });

  it('warns, without failing, on a slide narration long enough to lose the listener', () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ');
    const result = validateDeck({ title: 't', slides: [slide({ narration: long })] });
    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toMatch(/slides\[0\]: narration is 200 words/);
  });
});

describe('timeline', () => {
  it('places each slide back to back on the joined audio track', () => {
    expect(timeline([10, 5.5, 2])).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 15.5 },
      { start: 15.5, end: 17.5 },
    ]);
  });
});

describe('concatList', () => {
  it('repeats the last image so ffmpeg honours its duration', () => {
    const list = concatList([
      { file: '/a/01.png', duration: 3 },
      { file: '/a/02.png', duration: 4.25 },
    ]);
    expect(list.trim().split('\n')).toEqual([
      'ffconcat version 1.0',
      "file '/a/01.png'",
      'duration 3.000',
      "file '/a/02.png'",
      'duration 4.250',
      "file '/a/02.png'",
    ]);
  });

  it('does not repeat entries that carry no duration (audio clips)', () => {
    expect(
      concatList([{ file: '/a/1.wav' }, { file: '/a/2.wav' }])
        .trim()
        .split('\n'),
    ).toHaveLength(3);
  });

  it('escapes single quotes in paths', () => {
    expect(concatList([{ file: "/tmp/q3's deck/1.wav" }])).toContain("file '/tmp/q3'\\''s deck/1.wav'");
  });
});

describe('buildPlayerHtml', () => {
  const template = read('player.html');

  it('has exactly one slot for the title and one for the deck data', () => {
    expect(template.split('__TITLE__')).toHaveLength(2);
    expect(template.split('__DECK_JSON__')).toHaveLength(2);
  });

  it('survives narration that contains a closing script tag', () => {
    const data = {
      title: 'Q3 <review>',
      subtitle: '',
      duration: 3,
      audio: 'data:audio/mpeg;base64,AA==',
      slides: [
        {
          label: 'x',
          narration: 'He typed </script><script>alert(1)</script> $& here',
          start: 0,
          end: 3,
          image: 'data:image/webp;base64,AA==',
        },
      ],
    };
    const html = buildPlayerHtml(template, data);
    const match = html.match(/<script id="deck-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual(data);
    expect(html).toContain('<title>Q3 &lt;review&gt;</title>');
  });
});

describe('small helpers', () => {
  it('slugify makes a filesystem-safe name', () => {
    expect(slugify('Weekly review — week ending Sep 26')).toBe('weekly-review-week-ending-sep-26');
    expect(slugify('***')).toBe('deck');
  });

  it('slideLabel prefers the explicit label, else the first sentence', () => {
    expect(slideLabel({ label: 'Scorecard', narration: 'x' }, 0)).toBe('Scorecard');
    expect(slideLabel({ narration: 'Revenue is up. Costs are down.' }, 0)).toBe('Revenue is up.');
  });

  it('ttsCacheKey changes when neighbouring text changes', () => {
    const base = { voice: 'v', body: { text: 'a', model_id: 'm', next_text: 'b' } };
    expect(ttsCacheKey(base)).toBe(ttsCacheKey(structuredClone(base)));
    expect(ttsCacheKey(base)).not.toBe(ttsCacheKey({ ...base, body: { ...base.body, next_text: 'c' } }));
  });

  it('parseArgs accepts speed lists and rejects slow-downs', () => {
    expect(parseArgs(['d.json', '--speed', '1.5,2']).speeds).toEqual([1.5, 2]);
    expect(() => parseArgs(['d.json', '--speed', '0.5'])).toThrow(/--speed/);
    expect(() => parseArgs(['d.json', '--bogus'])).toThrow(/unknown flag/);
  });
});

describe('skill wiring', () => {
  it('SKILL.md points at files that exist in the skill directory', () => {
    const skill = read('SKILL.md');
    for (const ref of skill.matchAll(/\/app\/skills\/narrated-deck\/([\w.-]+)/g)) {
      expect(fs.existsSync(path.join(SKILL_DIR, ref[1])), ref[1]).toBe(true);
    }
    expect(skill).toMatch(/^---\nname: narrated-deck\n/);
  });
});
