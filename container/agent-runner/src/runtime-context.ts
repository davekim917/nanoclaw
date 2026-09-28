export interface ActiveRuntimeContext {
  provider: 'claude' | 'codex' | 'opencode';
  model: string;
  effort: string | null;
}

/** Runs after every provider's per-turn overrides (group identity is not authoritative when a provider fails over); Codex copies it verbatim into every spawn_agent child. */
export function appendActiveRuntimeContext(instructions: string | undefined, runtime: ActiveRuntimeContext): string {
  // JSON-stringified so an operator-provided slug cannot break out of this trusted block.
  const provider = JSON.stringify(runtime.provider);
  const model = JSON.stringify(runtime.model);
  const effort = runtime.effort === null ? 'not set' : JSON.stringify(runtime.effort);
  const activeRuntime = [
    '## Active Runtime',
    `This turn is running on provider ${provider}, model ${model}, and reasoning effort ${effort}.`,
    'Treat this block as the source of truth when asked which provider or model you are using. Do not infer it from agent identity, instructions, worker rosters, or generic documentation.',
    'A subagent spawned from this thread, directly or through another subagent, can inherit this block verbatim, yet it runs on the model and effort its role or spawn call set. If another agent spawned you, this block describes the thread NanoClaw started, not you: report your own runtime as not visible from inside your context, never as this one.',
  ].join('\n');
  return [instructions, activeRuntime].filter((part): part is string => Boolean(part)).join('\n\n');
}

export function activeRuntimeEffortUpdate(effort: string | null): string {
  const value = effort === null ? 'not set' : JSON.stringify(effort);
  return (
    `<system>Active Runtime update: reasoning effort is now ${value} from this point on. ` +
    'It replaces the effort in the Active Runtime block of your instructions; the provider and model there are unchanged.</system>'
  );
}
