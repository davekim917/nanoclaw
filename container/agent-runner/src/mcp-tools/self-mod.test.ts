import { beforeEach, describe, expect, it, mock } from 'bun:test';

const registeredToolNames: string[][] = [];
mock.module('./server.js', () => ({
  registerTools: (tools: Array<{ tool: { name: string } }>) => registeredToolNames.push(tools.map((tool) => tool.tool.name)),
}));

const { unavailableModelInventory, registerProviderSpecificSelfModTools } = await import('./self-mod.js');

beforeEach(() => {
  registeredToolNames.length = 0;
});

describe('list_models', () => {
  it('does not present an OpenCode inventory as a Codex catalog', () => {
    const result = unavailableModelInventory('codex')!;
    expect(result.content[0]?.text).toContain('codex model catalog');
    expect(result.content[0]?.text).toContain('set_channel_model');
  });

  it('does not expose the OpenCode inventory tool to Codex agents', () => {
    registerProviderSpecificSelfModTools('codex');
    expect(registeredToolNames.flat()).not.toContain('list_models');
  });
});
