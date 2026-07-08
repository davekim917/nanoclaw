/**
 * design_review — MCP tool for the design-artifact-loop (Option B, Group C).
 *
 * One call = one round. It canonically re-renders the artifact at the pinned
 * viewports, runs the deterministic supplement linter, folds in the L1 critic's
 * findings (gathered by the SKILL loop on the prior render and passed in), records
 * the round in disk-atomic state with carry-forward, and returns the R9 gate status.
 *
 * Loop (see SKILL.md): write/​revise artifact under <root>/<id>/ (root = DEFAULT_BASE_DIR)
 * → call design_review → it returns screenshotPaths + open must-fixes + status →
 * the agent spawns the L1 critic (which READS a screenshot PNG → vision) → passes the
 * critic's findings back on the next call. Ship when status != 'continue'; on 'blocked'
 * surface the unresolved highs.
 *
 * Standalone: exposed over stdio by server/index.ts (see .mcp.json at the plugin root).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { lintArtifact, type Finding, type Severity } from './linter.js';
import { renderViewports } from './render.js';
import { recordRound, openFindings, readState, DEFAULT_BASE_DIR, type RunStatus } from './state.js';

export interface McpToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const ALLOWED_ROOT = DEFAULT_BASE_DIR;

function isSeverity(v: unknown): v is Severity {
  return v === 'high' || v === 'medium' || v === 'low';
}

/**
 * Normalize a critic-supplied severity case-insensitively (Codex P2: "High"/"HIGH" must
 * not be silently demoted to medium). Unknown-but-stronger words map UP, never down — a
 * "critical"/"blocker" finding becomes high, so an unresolved visual must-fix can't ship
 * as a mere disclosure.
 */
export function normalizeSeverity(v: unknown): Severity {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (isSeverity(s)) return s;
  if (s === 'critical' || s === 'blocker' || s === 'crit' || s === 'p0' || s === 'p1') return 'high';
  return 'medium';
}

/**
 * A critic pass counts as a review of the CURRENT artifact only when (a) the agent passed a
 * criticReviewToken matching this version's reviewToken AND (b) it passed an actual
 * criticFindings ARRAY (empty allowed = "critic looked, found nothing"). Requiring the array
 * (Codex P1) closes the trivial bypass of echoing back just the token from a prior `continue`
 * response to flip criticReviewed=true without running the critic. The deeper trust boundary
 * remains — the tool cannot itself run the vision critic, so a fully fabricated
 * {criticFindings:[], criticReviewToken} can't be detected — but the explicit array is the floor.
 */
export function criticReviewedFor(criticToken: string, reviewToken: string, criticFindingsInput: unknown): boolean {
  return criticToken !== '' && criticToken === reviewToken && Array.isArray(criticFindingsInput);
}

export interface DirectiveInput {
  renderUnsafe: boolean;
  criticStale: boolean;
  status: RunStatus;
  criticReviewed: boolean;
  openCount: number;
  hasHigh: boolean;
}

/**
 * The `next` directive the tool returns. Pure so it is unit-testable. Key correctness point
 * (Codex P2): on `continue` with open deterministic findings, point the agent at FIXING them —
 * do NOT claim "no deterministic findings" and send it to the critic (which wastes rounds and
 * can burn the cap without addressing the real blocker).
 */
export function nextDirective(d: DirectiveInput): string {
  if (d.renderUnsafe) {
    return 'Render was SKIPPED — the artifact contains executable JS or an external network '
      + 'construct (see mustFixOpen). Remove every no-js:/network: finding (static HTML/CSS only, '
      + 'self-contained), then call design_review again; screenshots are produced once it is clean.';
  }
  if (d.criticStale) {
    return 'Your criticFindings were for an older artifact version and were DROPPED. Run the L1 '
      + 'critic on THIS call\'s screenshotPaths (it must READ a PNG for vision), then call again with '
      + 'criticFindings + criticReviewToken set to the reviewToken above.';
  }
  if (d.status === 'blocked') {
    // The loop is terminal — state the REAL reason (Codex P2). mustFixOpen can be empty when
    // the block is "the mandatory critic never reviewed this version", not "unresolved HIGHs".
    if (d.hasHigh) {
      return 'At cap with unresolved HIGH findings (see mustFixOpen) — surface them to the user; do not ship silently.';
    }
    if (!d.criticReviewed) {
      return 'At cap, but the mandatory independent L1 critic never reviewed this version. The loop has ended — '
        + 'surface to the user that the design could not be critic-verified within the round budget; do not ship un-reviewed.';
    }
    return 'At cap with unresolved findings — surface them to the user; do not ship silently.';
  }
  if (d.status !== 'continue') {
    return 'Shippable. Deliver the HTML + a preview PNG + trace.json.';
  }
  // continue: open findings take priority over the critic prompt.
  if (d.openCount > 0) {
    return 'Fix the open findings (mustFixOpen lists the HIGH ones)'
      + (d.criticReviewed ? '' : ', and run the independent L1 critic on screenshotPaths (it must READ a PNG for vision)')
      + ', then call design_review again with criticFindings + criticReviewToken=reviewToken.';
  }
  return 'No deterministic findings, but the independent L1 critic has not reviewed this version yet. '
    + 'Run it on screenshotPaths (it must READ a PNG for vision), then call design_review again with '
    + 'criticFindings + criticReviewToken=reviewToken (an empty criticFindings array with a matching token is fine if it found nothing).';
}

/** Validate + normalize the agent-supplied L1 critic findings. */
function normalizeCritic(input: unknown): Finding[] {
  if (!Array.isArray(input)) return [];
  const out: Finding[] = [];
  for (const f of input) {
    if (f && typeof f === 'object') {
      const o = f as Record<string, unknown>;
      const sev = normalizeSeverity(o.severity);
      const locus = typeof o.locus === 'string' ? o.locus : 'taste';
      const id = typeof o.id === 'string' && o.id.includes(':') ? o.id : `taste-${sev}:${locus}`;
      out.push({
        id,
        severity: sev,
        locus,
        message: typeof o.message === 'string' ? o.message : 'critic finding',
        source: 'critic',
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
      + `on "blocked" fix the unresolved high findings. The artifact MUST live under ${ALLOWED_ROOT}/<id>/.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: `Stable run id (alphanumeric, \`_\`/\`-\`, NO dots); state/screenshots live under ${ALLOWED_ROOT}/<id>/.` },
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
    // E (cycle-3, Codex P2): the loop ROOT itself must not be a symlink. If
    // the loop root were symlinked (e.g. -> /tmp/out) before the
    // first call, realpath would relocate the whole tree there and an artifact "under
    // realRoot" would still pass — defeating containment to the persistent design dir.
    try {
      if (fs.lstatSync(ALLOWED_ROOT).isSymbolicLink()) {
        return err('design-artifact-loop root is a symlink — rejected.');
      }
    } catch { /* root not yet created — fine; state.ts will mkdir it as a real dir */ }
    // The run dir <id> must be a REAL directory, not a symlink — even one pointing to
    // another dir UNDER the root (Codex P2): otherwise two distinct ids could share and
    // clobber the same trace.json / shots/ via the symlink.
    if (fs.lstatSync(runDir).isSymbolicLink()) {
      return err('run dir <id> is a symlink — use a real directory (distinct ids must not alias).');
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

    // Terminal short-circuit BEFORE rendering (Codex P2): if this id already reached a
    // terminal finalStatus, the bounded loop is over. Do NOT render — that would burn a
    // chromium pass and hand back fresh screenshots/reviewToken for an artifact that was
    // never recorded or critic-reviewed (a stale agent reusing a shipped/blocked id with
    // changed HTML). Return the recorded terminal state and tell the agent to use a new id.
    const prior = readState(id);
    if (prior.finalStatus) {
      return ok(JSON.stringify({
        round: prior.rounds.length,
        status: prior.finalStatus,
        terminal: true,
        findings: openFindings(prior),
        tracePath: path.join(runDir, 'trace.json'),
        next: `This design loop (id="${id}") already terminated with status "${prior.finalStatus}". `
          + 'It will not accept further rounds — start a NEW id for a new design. No screenshots were '
          + 'produced for this call.',
      }, null, 2));
    }

    // Codex P1: lint BEFORE rendering. If the artifact carries executable JS or an external
    // network construct, do NOT feed it to chromium — rendering it would execute the script
    // / issue the fetch (violating the no-JS/no-egress guarantee) precisely for the artifacts
    // the lockdown exists to catch. Render only once the artifact is script/egress-clean.
    const lintFindings = lintArtifact(html);
    const renderUnsafe = lintFindings.some(
      (f) => f.severity === 'high' && (f.id.startsWith('no-js:') || f.id.startsWith('network:')),
    );

    let renderFindings: Finding[] = [];
    let screenshotPaths: string[] = [];
    if (!renderUnsafe) {
      // The shots dir must be a REAL directory, not a symlink (Codex P2): mkdirSync(recursive)
      // would happily follow a pre-existing `shots` symlink and write PNGs/temp files outside
      // the run dir while still returning in-tree-looking paths.
      const shotsDir = path.join(runDir, 'shots');
      try {
        if (fs.lstatSync(shotsDir).isSymbolicLink()) {
          return err('shots dir is a symlink — rejected (screenshots must stay inside the run dir).');
        }
      } catch { /* not created yet — renderViewports will mkdir it as a real dir */ }
      const renders = renderViewports(realArtifact, shotsDir, reviewToken);
      renderFindings = renders.flatMap((r) => r.findings);
      // Only expose screenshots that actually exist — a failed/timed-out viewport leaves
      // no PNG (it was unlinked pre-render), so it must not appear as a dangling path the
      // critic would try to Read (Codex P2).
      screenshotPaths = renders.map((r) => r.pngPath).filter((p) => fs.existsSync(p));
    }

    const criticToken = typeof args.criticReviewToken === 'string' ? args.criticReviewToken : '';
    const criticRaw = normalizeCritic(args.criticFindings);
    const criticStale = criticRaw.length > 0 && criticToken !== reviewToken;
    const critic = criticStale ? [] : criticRaw;
    // A critic pass counts only when it reviewed THIS artifact version AND an explicit
    // criticFindings array was supplied (empty allowed = "looked, found nothing"). See
    // criticReviewedFor — this is the gate that blocks shipping a clean artifact the visual
    // critic never reviewed, and resists the echo-the-token bypass (Codex P1).
    const criticReviewed = criticReviewedFor(criticToken, reviewToken, args.criticFindings);

    const roundFindings: Finding[] = [...renderFindings, ...lintFindings, ...critic];

    // E#7: the whole read → merge → decide → write is one locked transaction.
    const { state, status, mustFixOpen } = recordRound(id, roundFindings, DEFAULT_BASE_DIR, criticReviewed);
    const round = state.rounds[state.rounds.length - 1].round;
    const open = openFindings(state);

    const result = {
      round,
      status,
      designSystem,
      reviewToken,
      findings: open,
      mustFixOpen,
      screenshotPaths,
      tracePath: path.join(runDir, 'trace.json'),
      ...(renderUnsafe ? { renderSkipped: 'artifact has high no-JS/network findings — not rendered until script/egress is removed' } : {}),
      ...(criticStale ? { staleCriticFindingsDropped: criticRaw.length } : {}),
      next: nextDirective({ renderUnsafe, criticStale, status, criticReviewed, openCount: open.length, hasHigh: open.some((f) => f.severity === 'high') }),
    };
    return ok(JSON.stringify(result, null, 2));
  },
};

export const designReviewTools = [designReviewTool];
