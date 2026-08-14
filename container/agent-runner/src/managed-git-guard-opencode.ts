import { guardManagedGitCommandOrThrow } from './managed-git-guard.js';

type ToolBeforeInput = { tool: string };
type ToolBeforeOutput = { args?: Record<string, unknown> };

export const ManagedGitWorktreeGuard = async () => ({
  'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
    if (input.tool !== 'bash') return;
    const command = output.args?.command;
    if (typeof command === 'string') guardManagedGitCommandOrThrow(command);
  },
});
