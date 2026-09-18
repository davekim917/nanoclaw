/**
 * Classify-on-arrival for support emails, using TypeSafe's Jev
 * (docs.typesafe.ai). `dispatch_support_issue` calls this before it hands the
 * email to the host, so every per-issue session starts knowing what it is
 * looking at: which product, which feature or process, what kind of ask, how
 * urgent, and how likely it is to be a user-facing defect.
 *
 * Opt-in per group, and generic: the taxonomy is the GROUP's file
 * (`/workspace/agent/support-taxonomy.json`). With no file there is no
 * classification and no network call — trunk carries no product names.
 *
 * Fail-open, always. A support email must never wait on, or be lost to, a
 * classifier: a missing key, an HTTP error, a timeout or a malformed answer
 * returns null and the dispatch proceeds exactly as it did before this existed.
 *
 * The key is never in this process. Requests go through the OneCLI proxy, which
 * injects the group's `TypeSafe` secret at the boundary.
 *
 * Product is decided by rules, not the model: most emails never name the
 * product, and a sunset product is recognisable by name. Jev answers only the
 * questions that need meaning.
 */
import fs from 'fs';

export const TRIAGE_MODEL = 'jev-1.13.0'; // pinned: thresholds mean nothing across an alias move
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TAXONOMY_PATH = '/workspace/agent/support-taxonomy.json';
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_EMAIL_CHARS = 12_000; // well inside Jev's 32k state budget; the head carries the ask

export interface SupportTaxonomy {
  /** Product rules, first match wins; tested against subject + body, case-insensitive. */
  productRules?: { product: string; pattern: string }[];
  defaultProduct?: string;
  /** Option key → plain-language description. `none` is added when absent. */
  features: Record<string, string>;
  processes: Record<string, string>;
}

export interface SupportTriage {
  model: string;
  product: string | null;
  areaType: 'feature' | 'process' | 'general';
  area: string | null;
  areaConfidence: number;
  category: string;
  categoryConfidence: number;
  /** 0 = no time pressure, 2 = blocked / deadline / many users. */
  urgency: number;
  /** P(the newest message reports the product misbehaving for a user). */
  escapedDefect: number;
}

// Generic across products; only features and processes are group data.
const CATEGORIES: Record<string, string> = {
  bug: 'Reports the app misbehaving: an error, a broken screen or action, wrong data shown.',
  question: 'How to do something, or how something works.',
  access_request: 'Needs access, a login, an invite, SSO or whitelisting.',
  data_request: 'Needs data sent, loaded, corrected or investigated.',
  feature_request: 'Asks for new or changed functionality.',
  follow_up: 'Chases or gives a status update on an earlier request, with no new ask of its own.',
  acknowledgement: 'Only thanks, an acknowledgement or an out-of-office, with no new ask.',
  automated_notice: 'An automated system notification or alert.',
};

type JevAnswer = { type?: string; noul?: number; choice?: string; score?: number; confidence?: number };

export interface TriageDependencies {
  fetch?: typeof fetch;
  readTaxonomy?: () => SupportTaxonomy | null;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export function readGroupTaxonomy(path: string = TAXONOMY_PATH): SupportTaxonomy | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return null; // not opted in
  }
  const parsed = JSON.parse(raw) as SupportTaxonomy; // a present-but-broken file is a config error: surface it
  if (!isOptionMap(parsed.features) || !isOptionMap(parsed.processes)) {
    throw new Error(`${path}: "features" and "processes" must be non-empty maps of option → description`);
  }
  return parsed;
}

function isOptionMap(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    Object.keys(v).length > 0 &&
    Object.values(v as object).every((d) => typeof d === 'string')
  );
}

function withNone(options: Record<string, string>, none: string): Record<string, string> {
  return 'none' in options ? options : { ...options, none };
}

export function productFor(taxonomy: SupportTaxonomy, text: string): string | null {
  for (const rule of taxonomy.productRules ?? []) {
    if (new RegExp(rule.pattern, 'i').test(text)) return rule.product;
  }
  return taxonomy.defaultProduct ?? null;
}

export function buildQuestions(taxonomy: SupportTaxonomy): Record<string, unknown> {
  return {
    area_type: {
      type: 'choice',
      instructions:
        'Is the email about a product feature (something a user does in the app) or an operational process around the product?',
      criteria: {
        feature: 'A feature of the product that users work with in the app.',
        process: 'An operational process around the product: data feeds, access, data corrections, setup.',
        general: 'Neither: a general question, thanks, or no specific subject.',
      },
    },
    // Both area questions are asked speculatively; code keeps the one area_type selects.
    feature: {
      type: 'choice',
      instructions: 'If this email is about a product feature, which one?',
      criteria: withNone(taxonomy.features, 'Not about a specific product feature.'),
    },
    process: {
      type: 'choice',
      instructions: 'If this email is about an operational process, which one?',
      criteria: withNone(taxonomy.processes, 'Not about an operational process.'),
    },
    category: {
      type: 'choice',
      instructions: 'What is the sender asking for in the newest message?',
      criteria: CATEGORIES,
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is the newest message?',
      criteria: [
        'No time pressure.',
        'Wants it soon, but work is not blocked.',
        'Work is blocked, a deadline is stated, or many users are affected.',
      ],
    },
    escaped_defect: {
      type: 'noul',
      instructions:
        'The newest message reports the product misbehaving for a user: an error, a broken screen or action, or wrong data shown. A question, an access request or a data request is not this.',
    },
  };
}

function num(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : null;
}

export function parseTriage(answers: Record<string, JevAnswer>, product: string | null): SupportTriage | null {
  const areaType = answers.area_type?.choice;
  const category = answers.category?.choice;
  const urgency = num(answers.urgency?.score, 2);
  const escaped = num(answers.escaped_defect?.noul, 1);
  const categoryConfidence = num(answers.category?.confidence, 1);
  if (
    (areaType !== 'feature' && areaType !== 'process' && areaType !== 'general') ||
    typeof category !== 'string' ||
    urgency === null ||
    escaped === null ||
    categoryConfidence === null
  ) {
    return null;
  }
  const areaAnswer = areaType === 'general' ? undefined : answers[areaType];
  const area = areaAnswer?.choice && areaAnswer.choice !== 'none' ? areaAnswer.choice : null;
  return {
    model: TRIAGE_MODEL,
    product,
    areaType,
    area,
    areaConfidence: area ? (num(areaAnswer?.confidence, 1) ?? 0) : 0,
    category,
    categoryConfidence,
    urgency,
    escapedDefect: escaped,
  };
}

export async function triageSupportEmail(
  email: { subject: string; sender: string; bodyText: string },
  deps: TriageDependencies = {},
): Promise<SupportTriage | null> {
  const log = deps.log ?? ((m: string) => console.error(`[support-triage] ${m}`));
  let taxonomy: SupportTaxonomy | null;
  try {
    taxonomy = (deps.readTaxonomy ?? readGroupTaxonomy)();
  } catch (e) {
    log(`taxonomy unreadable, dispatching without triage: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!taxonomy) return null;

  const text = `${email.subject}\n${email.bodyText}`;
  const product = productFor(taxonomy, text);
  const body = JSON.stringify({
    model: TRIAGE_MODEL,
    state: {
      subject: email.subject,
      sender: email.sender,
      email: email.bodyText.slice(0, MAX_EMAIL_CHARS),
    },
    questions: buildQuestions(taxonomy),
  });
  try {
    const res = await (deps.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      log(`Jev HTTP ${res.status}; dispatching without triage`);
      return null;
    }
    const out = (await res.json()) as { answers?: Record<string, JevAnswer> };
    const triage = parseTriage(out.answers ?? {}, product);
    if (!triage) log('Jev answer malformed; dispatching without triage');
    return triage;
  } catch (e) {
    log(`Jev unreachable (${e instanceof Error ? e.name : 'error'}); dispatching without triage`);
    return null;
  }
}

/** One line for the tool result, so the poller can act on it (e.g. the escaped-defect post). */
export function describeTriage(t: SupportTriage): string {
  const area = t.area ? `${t.area} (${t.areaType}, ${t.areaConfidence.toFixed(2)})` : t.areaType;
  return (
    `triage: product=${t.product ?? 'unknown'} · area=${area} · category=${t.category} (${t.categoryConfidence.toFixed(2)})` +
    ` · urgency=${t.urgency.toFixed(1)}/2 · escaped_defect=${t.escapedDefect.toFixed(2)}`
  );
}
