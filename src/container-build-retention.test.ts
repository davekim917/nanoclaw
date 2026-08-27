import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const buildScript = path.join(projectRoot, 'container', 'build.sh');
const dockerfilePath = path.join(projectRoot, 'container', 'Dockerfile');

describe('container image retention metadata', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function runBuild(tag: string, owner?: string): string[] {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-build-retention-'));
    tempDirs.push(tempDir);
    const capturePath = path.join(tempDir, 'args.txt');
    const fakeRuntime = path.join(tempDir, 'fake-runtime');
    fs.writeFileSync(fakeRuntime, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_PATH"\n', { mode: 0o755 });

    execFileSync('bash', [buildScript, tag], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CONTAINER_RUNTIME: fakeRuntime,
        CAPTURE_PATH: capturePath,
        NANOCLAW_IMAGE_RETENTION_OWNER: owner ?? '',
      },
      stdio: 'pipe',
    });
    return fs.readFileSync(capturePath, 'utf8').trim().split('\n');
  }

  function buildArg(args: string[], key: string): string | undefined {
    const entry = args.find((value) => value.startsWith(`${key}=`));
    return entry?.slice(key.length + 1);
  }

  it('gives non-latest builds a seven-day lease and propagates the owner', () => {
    const args = runBuild('candidate-image', 'session-019f6c2b');

    expect(buildArg(args, 'NANOCLAW_RETENTION_HOURS')).toBe('168');
    expect(buildArg(args, 'NANOCLAW_RETENTION_OWNER')).toBe('session-019f6c2b');
    expect(buildArg(args, 'NANOCLAW_IMAGE_ROLE')).toBe('candidate');
    expect(buildArg(args, 'NANOCLAW_RETENTION_CREATED_AT')).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('marks latest as canonical without a temporary lease', () => {
    const args = runBuild('latest');

    expect(buildArg(args, 'NANOCLAW_RETENTION_HOURS')).toBe('0');
    expect(buildArg(args, 'NANOCLAW_IMAGE_ROLE')).toBe('canonical');
  });

  it('uses ARG-driven Dockerfile labels so cached rebuilds renew metadata', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const first = buildArg(runBuild('cached-candidate'), 'NANOCLAW_RETENTION_CREATED_AT');
    const second = buildArg(runBuild('cached-candidate'), 'NANOCLAW_RETENTION_CREATED_AT');

    expect(first).not.toBe(second);
    expect(dockerfile).toContain('ARG NANOCLAW_RETENTION_CREATED_AT');
    expect(dockerfile).toContain('nanoclaw.retention.created_at=$NANOCLAW_RETENTION_CREATED_AT');
    expect(dockerfile).toContain('nanoclaw.retention.hours=$NANOCLAW_RETENTION_HOURS');
    expect(dockerfile).toContain('nanoclaw.retention.owner=$NANOCLAW_RETENTION_OWNER');
    expect(dockerfile).toContain('nanoclaw.image.role=$NANOCLAW_IMAGE_ROLE');
  });

  it('sets deterministic runtime-readable modes for copied agent files', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toContain('COPY --chmod=0644 agent-runner/package.json agent-runner/bun.lock ./');
    expect(dockerfile).toContain('COPY --chmod=0755 slack-mcp-wrapper.sh /usr/local/bin/slack-mcp-server');
    expect(dockerfile).toContain('COPY --chmod=0755 hex-wrapper.sh /usr/local/bin/hex-wrapper.sh');
    expect(dockerfile).toContain('chmod -R a+rX /opt/remotion');
    expect(dockerfile).toContain('COPY --chmod=0644 puppeteer-config.json /app/puppeteer-config.json');
    expect(dockerfile).toContain('COPY --chmod=0755 entrypoint.sh /app/entrypoint.sh');
    expect(dockerfile).toContain('find /opt/remotion \\( -type f ! -readable -o -type d ! -executable \\)');
    expect(dockerfile).toContain('test -x /usr/local/bin/slack-mcp-server');
  });

  it('marks derived group images with the group owner and role', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'src', 'container-runner.ts'), 'utf8');

    expect(source).toContain('nanoclaw.retention.owner=${JSON.stringify(agentGroupId)}');
    expect(source).toContain('nanoclaw.image.role=agent-group');
    expect(source).toContain('nanoclaw.agent_group_id=${JSON.stringify(agentGroupId)}');
  });
});
