import { describe, expect, it } from 'vitest';

import { UPDATE_CONTAINER_PROMPT } from './discord-slash-commands.js';

describe('/update-container deterministic workflow', () => {
  it('delegates detection and mutation to the shared CLI behind approval', () => {
    expect(UPDATE_CONTAINER_PROMPT).toContain('scripts/container-updates.ts audit --format json');
    expect(UPDATE_CONTAINER_PROMPT).toContain('scripts/container-updates.ts apply --repo <clone> --items');
    expect(UPDATE_CONTAINER_PROMPT).toContain('do not clone, edit, branch, commit, push, or open a PR before');
    expect(UPDATE_CONTAINER_PROMPT).toContain('Keep host and container changes in separate NanoClaw PRs');
    expect(UPDATE_CONTAINER_PROMPT).toContain('fails its installed-engine behavior contract');
    expect(UPDATE_CONTAINER_PROMPT).toContain('Never merge, deploy, restart services');
  });

  it('does not ask the agent to scrape release sources itself', () => {
    expect(UPDATE_CONTAINER_PROMPT).not.toContain('npm view');
    expect(UPDATE_CONTAINER_PROMPT).not.toContain('gh release view');
    expect(UPDATE_CONTAINER_PROMPT).not.toContain('extract every package install');
  });
});
