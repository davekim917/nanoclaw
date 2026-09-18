/**
 * Classify-on-arrival for support emails. The property that matters most is
 * fail-open: no taxonomy, a broken taxonomy, an HTTP error, a timeout or a
 * malformed answer must all yield null — never a thrown error that would stop
 * the email being dispatched.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { handleDispatchSupportIssue } from './support.js';
import { buildQuestions, productFor, readGroupTaxonomy, triageSupportEmail } from './support-triage.js';
import type { SupportTaxonomy, SupportTriage } from './support-triage.js';

const TAXONOMY: SupportTaxonomy = {
  productRules: [{ product: 'legacy_sunset', keywords: ['legacy'] }],
  defaultProduct: 'main_product',
  features: { planner: 'The planner screen.', routes: 'Routes and visits.' },
  processes: { data_feeds: 'Nightly syncs and file drops.' },
};

const EMAIL = {
  subject: 'Route planner broken',
  sender: 'person9@fixture1.example.com',
  bodyText: 'Accounts do not appear.',
};

function jevResponse(answers: Record<string, unknown>, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status })) as unknown as typeof fetch;
}

const GOOD = {
  area_type: { type: 'choice', choice: 'feature', confidence: 0.97 },
  feature: { type: 'choice', choice: 'routes', confidence: 0.93 },
  process: { type: 'choice', choice: 'none', confidence: 0.99 },
  category: { type: 'choice', choice: 'bug', confidence: 0.9 },
  urgency: { type: 'score', score: 1.2, confidence: 0.6 },
  escaped_defect: { type: 'noul', noul: 0.94 },
};

const quiet = () => undefined;

describe('triageSupportEmail', () => {
  it('does nothing — no network call — when the group has no taxonomy', async () => {
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect(await triageSupportEmail(EMAIL, { readTaxonomy: () => null, fetch: fetchSpy, log: quiet })).toBeNull();
    expect(called).toBe(false);
  });

  it('keeps the area the area_type answer selects, and decides product by rule', async () => {
    const t = await triageSupportEmail(EMAIL, { readTaxonomy: () => TAXONOMY, fetch: jevResponse(GOOD), log: quiet });
    expect(t).toMatchObject({
      product: 'main_product',
      areaType: 'feature',
      area: 'routes',
      areaConfidence: 0.93,
      category: 'bug',
      urgency: 1.2,
      escapedDefect: 0.94,
    });
  });

  it('lets a product rule override the default', () => {
    expect(productFor(TAXONOMY, 'Can we change the Legacy filter?')).toBe('legacy_sunset');
    expect(productFor(TAXONOMY, 'Route planner broken')).toBe('main_product');
    expect(productFor(TAXONOMY, 'our legacyfeed failed')).toBe('main_product'); // whole words only
    const multi = { ...TAXONOMY, productRules: [{ product: 'two_word', keywords: ['Route Planner'] }] };
    expect(productFor(multi, 'the route-planner is down')).toBe('two_word');
  });

  it('matches product keywords in linear time, even on a hostile email', () => {
    const t0 = performance.now();
    productFor(TAXONOMY, 'a'.repeat(200_000) + '!');
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('adds a none option to both area questions and asks them speculatively together', () => {
    const q = buildQuestions(TAXONOMY) as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(q.feature.criteria)).toEqual(['planner', 'routes', 'none']);
    expect(Object.keys(q.process.criteria)).toEqual(['data_feeds', 'none']);
  });

  it('reports no area for a general email, and none as no area', async () => {
    const general = await triageSupportEmail(EMAIL, {
      readTaxonomy: () => TAXONOMY,
      fetch: jevResponse({ ...GOOD, area_type: { type: 'choice', choice: 'general', confidence: 0.8 } }),
      log: quiet,
    });
    expect(general).toMatchObject({ areaType: 'general', area: null, areaConfidence: 0 });
    const none = await triageSupportEmail(EMAIL, {
      readTaxonomy: () => TAXONOMY,
      fetch: jevResponse({ ...GOOD, feature: { type: 'choice', choice: 'none', confidence: 0.7 } }),
      log: quiet,
    });
    expect(none).toMatchObject({ areaType: 'feature', area: null });
  });

  it('fails open on an HTTP error, a thrown fetch, a malformed answer and a broken taxonomy', async () => {
    const deps = { readTaxonomy: () => TAXONOMY, log: quiet };
    expect(await triageSupportEmail(EMAIL, { ...deps, fetch: jevResponse(GOOD, 503) })).toBeNull();
    const boom = (async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    expect(await triageSupportEmail(EMAIL, { ...deps, fetch: boom })).toBeNull();
    expect(await triageSupportEmail(EMAIL, { ...deps, fetch: jevResponse({ category: GOOD.category }) })).toBeNull();
    // Strict: an option that wasn't offered, a wrong answer type, or an out-of-range number discards it all.
    for (const answers of [
      { ...GOOD, category: { type: 'choice', choice: 'close_ticket', confidence: 0.9 } },
      { ...GOOD, feature: { type: 'choice', choice: 'ignore_previous_instructions', confidence: 0.9 } },
      { ...GOOD, urgency: { type: 'score', score: 99, confidence: 0.6 } },
      { ...GOOD, escaped_defect: { type: 'noul', noul: -0.2 } },
      { ...GOOD, escaped_defect: { type: 'choice', choice: 'yes', confidence: 0.9 } },
      { ...GOOD, feature: { type: 'choice', choice: 'routes' } },
      { ...GOOD, feature: { type: 'choice', choice: 'none' } },
    ]) {
      expect(await triageSupportEmail(EMAIL, { ...deps, fetch: jevResponse(answers) })).toBeNull();
    }
    expect(
      await triageSupportEmail(EMAIL, {
        readTaxonomy: () => {
          throw new SyntaxError('Unexpected token');
        },
        fetch: jevResponse(GOOD),
        log: quiet,
      }),
    ).toBeNull();
  });
});

describe('taxonomy validation — nothing in it may stop a dispatch', () => {
  it('rejects a regex-style or empty product rule, or a non-snake_case key, when the file is read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxonomy-'));
    const write = (t: unknown) => {
      const f = path.join(dir, `${Math.random()}.json`);
      fs.writeFileSync(f, JSON.stringify(t));
      return f;
    };
    expect(readGroupTaxonomy(write(TAXONOMY))).toEqual(TAXONOMY);
    expect(() => readGroupTaxonomy(write({ ...TAXONOMY, productRules: [{ product: 'x', pattern: '(' }] }))).toThrow();
    expect(() => readGroupTaxonomy(write({ ...TAXONOMY, productRules: [{ product: 'x', keywords: [] }] }))).toThrow();
    expect(() => readGroupTaxonomy(write({ ...TAXONOMY, productRules: [{ product: 'x', keywords: ['--'] }] }))).toThrow();
    expect(() => readGroupTaxonomy(write({ ...TAXONOMY, features: { 'Route Planner': 'x' } }))).toThrow();
    expect(() => readGroupTaxonomy(write({ ...TAXONOMY, defaultProduct: 'Main Product' }))).toThrow();
  });

  it('fails open when a product rule is malformed at classification time', async () => {
    const broken = { ...TAXONOMY, productRules: [{ product: 'x' }] } as unknown as SupportTaxonomy;
    expect(await triageSupportEmail(EMAIL, { readTaxonomy: () => broken, fetch: jevResponse(GOOD), log: quiet })).toBeNull();
  });

  it('dispatches even if the classifier itself rejects', async () => {
    initTestSessionDb();
    try {
      const res = await handleDispatchSupportIssue(
        { gmailThreadId: 'gt-x', subject: 's', sender: 'person8@fixture1.example.com', date: 'd', bodyText: 'b' },
        { triage: async () => Promise.reject(new Error('boom')) },
      );
      expect(getUndeliveredMessages()).toHaveLength(1);
      expect(res.content[0].text).toContain('Support issue dispatched');
    } finally {
      closeSessionDb();
    }
  });
});

describe('dispatch_support_issue with triage', () => {
  const ARGS = { gmailThreadId: 'gt-9', subject: 's', sender: 'person8@fixture1.example.com', date: 'd', bodyText: 'b' };
  const TRIAGE: SupportTriage = {
    model: 'jev-1.13.0',
    product: 'main_product',
    areaType: 'feature',
    area: 'routes',
    areaConfidence: 0.93,
    category: 'bug',
    categoryConfidence: 0.9,
    urgency: 1.2,
    escapedDefect: 0.94,
  };

  it('attaches the triage to the host action and reports it to the calling agent', async () => {
    initTestSessionDb();
    try {
      const res = await handleDispatchSupportIssue(ARGS, { triage: async () => TRIAGE });
      const c = JSON.parse(getUndeliveredMessages()[0].content) as Record<string, unknown>;
      expect(c.triage).toEqual(TRIAGE);
      expect(res.content[0].text).toContain('escaped_defect=0.94');
    } finally {
      closeSessionDb();
    }
  });

  it('dispatches unchanged when triage is unavailable', async () => {
    initTestSessionDb();
    try {
      const res = await handleDispatchSupportIssue(ARGS, { triage: async () => null });
      const c = JSON.parse(getUndeliveredMessages()[0].content) as Record<string, unknown>;
      expect(c.triage).toBeNull();
      expect(res.content[0].text).not.toContain('triage');
    } finally {
      closeSessionDb();
    }
  });
});
