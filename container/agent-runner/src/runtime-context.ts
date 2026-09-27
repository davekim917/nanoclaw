export interface ActiveRuntimeContext {
  provider: 'claude' | 'codex' | 'opencode';
  model: string;
  effort: string | null;
}

/** Runs after every provider's per-turn overrides: group identity is not authoritative when a provider fails over. */
export function appendActiveRuntimeContext(instructions: string | undefined, runtime: ActiveRuntimeContext): string {
  // JSON-stringified so an operator-provided slug cannot break out of this trusted block.
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
