/**
 * design_review — MCP tool for the design-artifact-loop (Option B, Group C).
 *
 * One call = one round. It canonically re-renders the artifact at the pinned
 * viewports, runs the deterministic supplement linter, folds in the L1 critic's
 * findings (gathered by the SKILL loop on the prior render and passed in), records
 * the round in disk-atomic state with carry-forward, and returns the R9 gate status.
 *
 * Loop (see SKILL.md): write/​revise artifact under /workspace/agent/design-artifact-loop/<id>/
 * → call design_review → it returns screenshotPaths + open must-fixes + status →
 * the agent spawns the L1 critic (which READS a screenshot PNG → vision) → passes the
 * critic's findings back on the next call. Ship when status != 'continue'; on 'blocked'
 * surface the unresolved highs.
 *
 * Provider-agnostic (registered once in the barrel; all three providers invoke it).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { registerTools } from '../server.js';
import type { McpToolDefinition } from '../types.js';
import { lintArtifact, type Finding, type Severity } from './linter.js';
import { renderViewports } from './render.js';
import { recordRound, openFindings, DEFAULT_BASE_DIR } from './state.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const ALLOWED_ROOT = DEFAULT_BASE_DIR; // /workspace/agent/design-artifact-loop

function isSeverity(v: unknown): v is Severity {
  return v === 'high' || v === 'medium' || v === 'low';
}

/** Validate + normalize the agent-supplied L1 critic findings. */
function normalizeCritic(input: unknown): Finding[] {
  if (!Array.isArray(input)) return [];
  const out: Finding[] = [];
  for (const f of input) {
    if (f && typeof f === 'object') {
      const o = f as Record<string, unknown>;
      const sev = isSeverity(o.severity) ? o.severity : 'medium';
      const locus = typeof o.locus === 'string' ? o.locus : 'taste';
      const id = typeof o.id === 'string' && o.id.includes(':') ? o.id : `taste-${sev}:${locus}`;
      out.push({
        id,
        severity: sev,
        locus,
        message: typeof o.message === 'string' ? o.message : 'critic finding',
      });
    }
  }
  return out;
}

const designReviewTool: McpToolDefinition = {
  tool: {
    name: 'design_review',
    description:
      'Render-grounded design review for the design-artifact-loop. One call = one round: '
      + 'canonically re-renders the artifact (1440x900 + 390x844), runs the deterministic linter '
      + '(token-trace, no-JS, network, font-denylist), folds in your L1 critic findings, records '
      + 'the round with carry-forward, and returns the R9 status. Ship when status != "continue"; '
      + 'on "blocked" fix the unresolved high findings. The artifact MUST live under '
      + '/workspace/agent/design-artifact-loop/<id>/.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable run id (alphanumeric, `_`/`-`, NO dots); state/screenshots live under /workspace/agent/design-artifact-loop/<id>/.' },
        artifactPath: { type: 'string', description: 'Path to the single self-contained HTML artifact (must be under the run dir).' },
        designSystem: { type: 'string', description: 'Name of the committed design system (for the trace; informational).' },
        criticFindings: {
          type: 'array',
          description: 'Findings from the L1 taste critic you ran on the screenshot of THIS artifact version (the critic must READ the screenshot PNG for vision). Each: {id?, severity, locus, message}.',
          items: { type: 'object' },
        },
        criticReviewToken: {
          type: 'string',
          description: 'The `reviewToken` returned by the design_review call whose screenshots your criticFindings reviewed. Required when sending criticFindings — if it does not match the current artifact, the (stale) findings are dropped.',
        },
      },
      required: ['id', 'artifactPath'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const id = typeof args.id === 'string' ? args.id : '';
    const artifactPath = typeof args.artifactPath === 'string' ? args.artifactPath : '';
    const designSystem = typeof args.designSystem === 'string' ? args.designSystem : undefined;
    // E#1: no dots — reject '.', '..', and any dotted id that path.join would normalize past the root.
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return err('A valid `id` (alphanumeric, `_` or `-`, no dots) is required.');
    if (!artifactPath) return err('`artifactPath` is required.');

    const runDir = path.join(ALLOWED_ROOT, id);
    const resolved = path.resolve(artifactPath);
    // C3/C8: the artifact must live under the run dir (lexical: no path traversal).
    if (resolved !== runDir && !resolved.startsWith(runDir + path.sep)) {
      return err(`artifactPath must be inside ${runDir}/.`);
    }
    if (!fs.existsSync(resolved)) return err(`artifact not found: ${resolved}`);

    // E#2: realpath guard — a symlink under <id>/ pointing outside must not escape.
    let realArtifact: string;
    let realRun: string;
    try {
      realArtifact = fs.realpathSync(resolved);
      realRun = fs.realpathSync(runDir);
    } catch (e) {
      return err(`could not resolve real path: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (realArtifact !== realRun && !realArtifact.startsWith(realRun + path.sep)) {
      return err('artifactPath resolves (via symlink) outside its run dir — rejected.');
    }
    // E#2 (cycle-2): the run dir ITSELF must resolve under the allowed root — else a
    // symlinked <id>/ (good -> /tmp/out) would let an artifact "inside realRun" escape.
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(ALLOWED_ROOT);
    } catch (e) {
      return err(`could not resolve allowed root: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (realRun !== realRoot && !realRun.startsWith(realRoot + path.sep)) {
      return err('run dir resolves (via symlink) outside the allowed root — rejected.');
    }
    if (!fs.statSync(realArtifact).isFile()) return err('artifactPath is not a regular file.');

    let html: string;
    try {
      html = fs.readFileSync(realArtifact, 'utf-8');
    } catch (e) {
      return err(`could not read artifact: ${e instanceof Error ? e.message : String(e)}`);
    }

    // E#10: tie critic findings to the artifact version they reviewed. reviewToken =
    // hash of the CURRENT artifact; critic findings are only folded in if they were
    // generated against this exact version (criticReviewToken matches) — otherwise they
    // are STALE (the agent revised after the critic looked) and are dropped, not merged.
    const reviewToken = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);

    // canonical render at the pinned viewports → screenshots + render findings
    const renders = renderViewports(realArtifact, path.join(runDir, 'shots'));
    const renderFindings = renders.flatMap((r) => r.findings);
    const screenshotPaths = renders.map((r) => r.pngPath);

    const lintFindings = lintArtifact(html);

    const criticToken = typeof args.criticReviewToken === 'string' ? args.criticReviewToken : '';
    const criticRaw = normalizeCritic(args.criticFindings);
    const criticStale = criticRaw.length > 0 && criticToken !== reviewToken;
    const critic = criticStale ? [] : criticRaw;

    const roundFindings: Finding[] = [...renderFindings, ...lintFindings, ...critic];

    // E#7: the whole read → merge → decide → write is one locked transaction.
    const { state, status, mustFixOpen } = recordRound(id, roundFindings);
    const round = state.rounds[state.rounds.length - 1].round;

    const result = {
      round,
      status,
      designSystem,
      reviewToken,
      findings: openFindings(state),
      mustFixOpen,
      screenshotPaths,
      tracePath: path.join(runDir, 'trace.json'),
      ...(criticStale ? { staleCriticFindingsDropped: criticRaw.length } : {}),
      next:
        criticStale
          ? 'Your criticFindings were for an older artifact version and were DROPPED. Run the L1 critic on THIS call\'s screenshotPaths (it must READ a PNG for vision), then call again with criticFindings + criticReviewToken set to the reviewToken above.'
          : status === 'continue'
            ? 'Run the L1 critic on screenshotPaths (it must READ a PNG for vision), revise against mustFixOpen, then call design_review again with criticFindings + criticReviewToken=reviewToken.'
            : status === 'blocked'
              ? 'At cap with unresolved HIGH findings — fix them and surface remaining ones to the user; do not ship silently.'
              : 'Shippable. send_file the HTML + a preview PNG + trace.json.',
    };
    return ok(JSON.stringify(result, null, 2));
  },
};

export const designReviewTools = [designReviewTool];
registerTools(designReviewTools);
