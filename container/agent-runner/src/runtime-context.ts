export interface ActiveRuntimeContext {
  provider: 'claude' | 'codex' | 'opencode';
  model: string;
  effort: string | null;
}

/**
 * Add the resolved runtime identity after every provider has applied its
 * per-turn overrides. Agent identity and group instructions describe the role
 * the agent plays; they are not authoritative when a provider fails over.
 */
export function appendActiveRuntimeContext(instructions: string | undefined, runtime: ActiveRuntimeContext): string {
  // JSON stringification keeps an operator-provided model slug from breaking
  // out of this trusted system block if it contains Markdown or newlines.
  const provider = JSON.stringify(runtime.provider);
  const model = JSON.stringify(runtime.model);
  const effort = runtime.effort === null ? 'not set' : JSON.stringify(runtime.effort);
  const activeRuntime = [
    '## Active Runtime',
    `This turn is running on provider ${provider}, model ${model}, and reasoning effort ${effort}.`,
    'Treat this block as the source of truth when asked which provider or model you are using. Do not infer it from agent identity, instructions, worker rosters, or generic documentation.',
  ].join('\n');
  return [instructions, activeRuntime].filter((part): part is string => Boolean(part)).join('\n\n');
}
