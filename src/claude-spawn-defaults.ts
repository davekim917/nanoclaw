import {
  DEFAULT_FABLE_MODEL,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
  resolveEffectiveModel,
  vocabFor,
} from './flag-parser.js';
import type { ContainerConfig } from './container-config.js';

/**
 * The container.json fields the claude spawn branch reads.
 *
 * `providerConfig` is deliberately NOT here. It was, briefly, so the seam
 * could notice that `providerConfig.model` outranks the env it feeds and
 * decline to derive an effort — but with every model-dependent decision now
 * living where the model is chosen, the host has no reason to know it exists.
 */
export type ClaudeSpawnConfig = Pick<
  ContainerConfig,
  'model' | 'effort' | 'defaultModel' | 'defaultEffort' | 'autoCompactWindow'
>;

/**
 * Quota caps every Claude container receives (docs/specs/quota-burn/plan.md
 * §Tier 0). One definition, emitted by `claudeSpawnEnv` for BOTH spawn
 * branches in container-runner.ts (ordinary and wiki) and mirrored into each
 * group's `.claude-shared/settings.json` by group-init.ts `REQUIRED_ENV`, so a
 * settings pin can never disagree with the `-e` the spawn path sends.
 *
 * Auto-compact window default: Claude Code 2.1+ has a built-in window well
 * under 200k even on a [1m] model. It was 1_000_000 — the [1m] capacity — with
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 firing compaction around 800k. Both moved
 * on 2026-09-19 (operator decision): the window is 600_000 and the percentage
 * override is gone, so the CLI's own default percentage decides where
 * compaction lands within that window. Compaction ITSELF is unchanged either
 * way — fast-jev-compaction registers a `session.compact` hook, which runs for
 * whichever trigger fires, so these two values move WHEN a session compacts,
 * never HOW. A group lowers it via
 * container.json `autoCompactWindow` (§0.5). Subagent caps: CLI defaults are
 * depth 3 / concurrency 20; these sit under that to bound the five-hour-meter
 * burst (§0.1/0.2).
 *
 * Raised 2026-09-19 from depth 1 / concurrency 3 to match the operator's own
 * host settings, so a container fans out the same way an interactive session
 * does. Depth 1 previously PREVENTED a worker from delegating further; depth 2
 * allows it, which is the intent — nothing forbids re-delegation now, and the
 * installed orchestrate worker definitions never did
 * (`~/plugins/bootstrap/plugins/orchestrate/agents/worker-high.md:8` just says
 * to execute the prompt).
 *
 * Concurrency is NOT per-parent, so depth 2 does not square it: the pinned CLI
 * shares one running-subagent counter and task registry across nested agents,
 * so 5 is 5 slots for the whole session (excluding the main agent) and depth
 * only decides how they may nest. It is not an absolute ceiling over every
 * mechanism either — resumes can bypass admission and agent teams count
 * separately. Verified against the CLI pinned in container/Dockerfile and
 * https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit
 * (an earlier revision of this comment claimed a 5 × 5 worst case; that was
 * wrong, and wrong in the direction that understates the budget's tightness).
 */
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 600_000;
export const CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH = '2';
export const CLAUDE_MAX_CONCURRENT_SUBAGENTS = '5';

/** What the claude spawn branch will put in the container's environment. */
export interface ClaudeSpawnDefaults {
  /**
   * The RESOLVED concrete model id this group's turns run on, which lands in
   * NANOCLAW_CLAUDE_MODEL: family alias mapped, pinned alias mapped, `[1m]`
   * applied.
   *
   * It does NOT land in ANTHROPIC_DEFAULT_OPUS_MODEL. That variable answers
   * the SDK's `opus` ALIAS and is the install's Opus constant for every
   * group, pinned or not — see `claudeSpawnEnv`.
   */
  model: string;
  /**
   * The operator's explicitly configured effort, or undefined to emit no
   * NANOCLAW_EFFORT_OVERRIDE at all. Never a value this seam inferred — see
   * the class comment.
   */
  effort: string | undefined;
  /** One message per value refused, for the caller to log. */
  drops: string[];
}

/**
 * Resolve the model + effort the claude spawn branch exports, and refuse
 * anything that is not valid Claude vocabulary for the resolved model.
 *
 * ## The chains
 *
 * Both walk the SAME three layers the codex branch reads:
 *
 *   per-channel wiring  →  `model` / `effort`  →  `defaultModel` / `defaultEffort`
 *
 * `model`/`effort` are the pair `ncl groups config update --model/--effort`
 * writes — it updates the `container_configs` DB row AND mirrors both into
 * `container.json` (`src/cli/resources/groups.ts`). `defaultModel`/
 * `defaultEffort` are the older hand-authored container.json fields, which
 * have no programmatic writer anywhere in the tree. Reading only the `default*`
 * pair made `ncl groups config update` a silent no-op for every claude group.
 * The codex branch never had that bug; opencode reads `container_configs.effort`
 * straight from the DB (`src/providers/opencode.ts`).
 *
 * ## What this seam may and may not decide
 *
 * > The host makes NO inference about which model runs. It exports what the
 * > operator set; every model-dependent decision belongs where the model is
 * > chosen.
 *
 * Six review rounds converged on that line, each one moving a host-side
 * inference closer to correct instead of removing it: derive from the resolved
 * id rather than the `opus` alias; do not derive when `providerConfig.model`
 * outranks us; do not validate an effort against a model that lost. Every
 * version was wrong in the same way, because the host cannot see the model the
 * container will pick — `providerConfig.model` is parsed container-side and
 * beats the env this seam feeds. So the inferences are gone:
 *
 *   - **No family-default derivation.** `defaultEffortForModel` in
 *     `container/agent-runner/src/providers/claude.ts` is the only place a
 *     family default is chosen, and since the container reads the concrete
 *     resolved id it gets the right argument on every path — including Haiku,
 *     which yields `undefined` and therefore no effort at all, something no
 *     host-side value could express.
 *   - **No per-model effort clamp.** `clampEffortForModel`, next to it, is the
 *     model-aware authority and clamps against the model actually picked.
 *
 * What remains is vocabulary only, and it needs no knowledge of which model
 * wins: refuse a value that is not Claude's at all. That matters because
 * `ncl groups config update --provider claude` leaves the previous provider's
 * `model`/`effort` in place, and NANOCLAW_EFFORT_OVERRIDE bypasses
 * `claudeConfigSchema` entirely (it is read raw from `process.env` at query
 * time), so a codex `ultra` or a `gpt-*` id would otherwise reach the API
 * unchallenged. Candidates are checked against the SAME tables the chat
 * `-m`/`-e` parser uses (`vocabFor('claude')`), and an invalid one is DROPPED
 * so the next layer gets its turn — never passed through, never fatal.
 */
export function resolveClaudeSpawnDefaults(
  containerConfig: ClaudeSpawnConfig,
  channel: { model?: string | null; effort?: string | null } = {},
): ClaudeSpawnDefaults {
  const vocab = vocabFor('claude');
  const drops: string[] = [];

  const modelLayers: Array<[string, string | null | undefined]> = [
    ['channel wiring', channel.model],
    ['container.json model', containerConfig.model],
    ['container.json defaultModel', containerConfig.defaultModel],
  ];
  // An unpinned Claude group runs Opus (operator decision 2026-09-15). This
  // is also the Claude target for an unpinned Codex → Claude fallback: the
  // fallback changes the runtime, and the tier it lands on is the fleet's
  // default tier, not a quieter one chosen by the fallback path.
  //
  // It was DEFAULT_SONNET_MODEL from 7d0e7df3a (2026-09-14) until this line,
  // and because the resolved model was ALSO the `opus` alias answer, the pin
  // `"model": "opus"` that group-init writes into every group's
  // .claude-shared/settings.json resolved to Sonnet 5 — measured live. The
  // alias no longer carries this value (see `claudeSpawnEnv`), so the two
  // decisions are now independent: this is the group's model, that is what
  // the word "opus" means.
  let model = DEFAULT_OPUS_MODEL;
  for (const [layer, raw] of modelLayers) {
    if (!raw) continue;
    const resolved = resolveEffectiveModel(raw);
    if (!vocab.isValidModel(resolved)) {
      drops.push(`model "${raw}" from ${layer} is not a Claude model — ignored`);
      continue;
    }
    model = resolved;
    break;
  }

  const effortLayers: Array<[string, string | null | undefined]> = [
    ['channel wiring', channel.effort],
    ['container.json effort', containerConfig.effort],
    ['container.json defaultEffort', containerConfig.defaultEffort],
  ];
  let effort: string | undefined;
  for (const [layer, raw] of effortLayers) {
    if (!raw) continue;
    const candidate = raw.trim().toLowerCase();
    if (!vocab.validEfforts.has(candidate)) {
      drops.push(`effort "${raw}" from ${layer} is not a Claude effort level — ignored`);
      continue;
    }
    effort = candidate;
    break;
  }

  return { model, effort, drops };
}

/**
 * The complete `-e` block the claude spawn branch emits for model + effort,
 * built as the literal strings that reach `docker run`.
 *
 * Extracted alongside the resolution above for one reason: the emission is
 * where a resolved value gets dropped, and `buildContainerArgs` cannot be
 * executed under vitest (it makes live `onecli` shell calls — see
 * `src/container-runner.test.ts`). Resolving correctly and then failing to
 * emit is the same class of defect as reading the wrong field, and it needs
 * the same kind of executing test rather than a careful read of the diff.
 *
 * The effort entry is CONDITIONAL and must stay that way. NANOCLAW_EFFORT_OVERRIDE
 * is an operator override, not a default: with the variable absent the claude
 * provider applies its own per-model-family default. Emitting it
 * unconditionally — with an empty value, or with a hardcoded fallback — would
 * pin every group in the fleet to one model-blind effort.
 * `claude_spawn_env_omits_effort_when_nothing_configured` guards it.
 *
 * ## The four alias vars carry ALIASES, never the group's model
 *
 * `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` is the SDK's alias short-circuit: the
 * string in it is what the CLI sends when anything — the agent, a subagent's
 * `model:` frontmatter, the `"model": "opus"` pin group-init writes into every
 * group's settings.json — uses that bare family word. All four are therefore
 * install-wide constants emitted verbatim, so `opus` means Opus in every
 * group and `sonnet` means Sonnet in every group. Fable joined them on
 * 2026-09-24: without ANTHROPIC_DEFAULT_FABLE_MODEL a bare `fable` (a task
 * pin, a `model: fable` subagent) ran whatever the CLI build defaults to,
 * not DEFAULT_FABLE_MODEL.
 *
 * The opus one used to carry `resolved.model` instead, which made the word
 * "opus" mean "whatever this group runs". Paired with the unpinned default
 * moving to Sonnet in 7d0e7df3a, every unpinned group's settings.json pin and
 * every `model: opus` subagent silently ran Sonnet 5. The group's model needs
 * its own transport, and has one: NANOCLAW_CLAUDE_MODEL, read by the claude
 * provider at `input.model ?? stickyConfig.model ?? env` (`container/
 * agent-runner/src/providers/claude.ts`). Do not reunite them.
 *
 * `onDrop` receives one message per refused value. Logging lives at the call
 * site so this stays a pure function and the log line carries session context.
 */
export function claudeSpawnEnv(
  containerConfig: ClaudeSpawnConfig,
  channel: { model?: string | null; effort?: string | null } = {},
  onDrop?: (message: string) => void,
): string[] {
  const resolved = resolveClaudeSpawnDefaults(containerConfig, channel);
  if (onDrop) for (const d of resolved.drops) onDrop(d);
  const env = [
    '-e',
    `NANOCLAW_CLAUDE_MODEL=${resolved.model}`,
    '-e',
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${DEFAULT_OPUS_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`,
    '-e',
    `ANTHROPIC_DEFAULT_FABLE_MODEL=${DEFAULT_FABLE_MODEL}`,
  ];
  if (resolved.effort) env.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${resolved.effort}`);
  // Quota caps ride the same primitive so the wiki spawn branch, which builds
  // its own argv and returns before the ordinary branch's env block, cannot
  // fall behind it (PR #810 review F1).
  env.push(
    '-e',
    `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${containerConfig.autoCompactWindow ?? DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW}`,
    '-e',
    `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=${CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH}`,
    '-e',
    `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=${CLAUDE_MAX_CONCURRENT_SUBAGENTS}`,
    // Loads `~/plugins` function-hook plugins (fast-jev-compaction today).
    // A group opts out with container.json `excludePlugins`, like any plugin.
    '-e',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
  );
  return env;
}
