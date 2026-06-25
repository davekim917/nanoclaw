import { describe, it, expect, mock } from 'bun:test';

// design_review/index.ts calls registerTools at module scope — no-op it for the test.
mock.module('../server.js', () => ({ registerTools: () => {} }));

const { designReviewTools } = await import('./index.js');
const tool = designReviewTools[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (args: Record<string, unknown>): Promise<any> => tool.handler(args) as Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (r: any): string => r.content[0].text as string;

describe('design_review — input validation (Codex E#1/E#2 security guards)', () => {
  it('test_rejects_dot_dot_id', async () => {
    const r = await call({ id: '..', artifactPath: '/workspace/agent/anything.html' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('id');
  });

  it('test_rejects_dotted_id', async () => {
    const r = await call({ id: 'a.b', artifactPath: '/workspace/agent/design-artifact-loop/a.b/x.html' });
    expect(r.isError).toBe(true);
  });

  it('test_rejects_single_dot_id', async () => {
    const r = await call({ id: '.', artifactPath: '/workspace/agent/design-artifact-loop/x.html' });
    expect(r.isError).toBe(true);
  });

  it('test_rejects_path_outside_run_dir', async () => {
    const r = await call({ id: 'ok', artifactPath: '/etc/passwd' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('inside');
  });

  it('test_rejects_missing_artifact', async () => {
    const r = await call({ id: 'okrun', artifactPath: '/workspace/agent/design-artifact-loop/okrun/nope.html' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not found');
  });
});
