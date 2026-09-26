import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Complete stub, not a spread: log.ts installs process-wide exit handlers at
// module scope.
const logState = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: logState.warn, error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

// The flag is whatever a test sets here; shadow-flag.test.ts covers how it is read.
const flagState = vi.hoisted(() => ({ on: false }));
vi.mock('./shadow-flag.js', () => ({ readShadowFlag: () => flagState.on, isShadowProcess: () => flagState.on }));

import { getContainerImageBase } from './install-slug.js';
import { imageRepository, shadowImageViolation } from './shadow-host.js';

const OWN_BASE = 'nanoclaw-agent-v2-aaaaaaaa';
const OTHER_BASE = 'nanoclaw-agent-v2-bbbbbbbb';

async function loadFresh(
  shadow: boolean,
  env: Record<string, string | undefined> = {},
): Promise<typeof import('./shadow-host.js')> {
  vi.resetModules();
  flagState.on = shadow;
  vi.stubEnv('CONTAINER_IMAGE', undefined);
  vi.stubEnv('CONTAINER_IMAGE_BASE', undefined);
  vi.stubEnv('WEBHOOK_PORT', undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('./shadow-host.js');
}

describe('imageRepository', () => {
  it('strips a tag', () => {
    expect(imageRepository(`${OWN_BASE}:latest`)).toBe(OWN_BASE);
  });
  it('keeps a registry port and strips only the tag', () => {
    expect(imageRepository(`registry.example:5000/${OWN_BASE}:dev`)).toBe(`registry.example:5000/${OWN_BASE}`);
    expect(imageRepository(`registry.example:5000/${OWN_BASE}`)).toBe(`registry.example:5000/${OWN_BASE}`);
  });
  it('strips a digest', () => {
    expect(imageRepository(`${OWN_BASE}@sha256:${'0'.repeat(64)}`)).toBe(OWN_BASE);
  });
});

describe('shadowImageViolation', () => {
  it('accepts the checkout default and any tag in its own namespace', () => {
    expect(shadowImageViolation(`${OWN_BASE}:latest`, OWN_BASE, OWN_BASE)).toBeNull();
    expect(shadowImageViolation(`${OWN_BASE}:ag-123`, OWN_BASE, OWN_BASE)).toBeNull();
  });

  it("refuses another install's default image and names the retag route", () => {
    const message = shadowImageViolation(`${OTHER_BASE}:latest`, OWN_BASE, OWN_BASE);
    expect(message).toContain(`${OTHER_BASE}:latest`);
    expect(message).toContain(`docker tag <production image>:latest ${OWN_BASE}:latest`);
  });

  it('refuses a foreign base even when the image itself is in the own namespace', () => {
    expect(shadowImageViolation(`${OWN_BASE}:latest`, OTHER_BASE, OWN_BASE)).not.toBeNull();
  });

  it('refuses an unrelated image', () => {
    expect(shadowImageViolation('some-other-image:dev', OWN_BASE, OWN_BASE)).not.toBeNull();
  });
});

describe('enterShadowHostMode', () => {
  let tmpRoot: string;

  beforeEach(() => {
    logState.warn.mockClear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-host-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
    vi.stubEnv('TMPDIR', process.env.TMPDIR);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does nothing when shadow mode is off, whatever the image', async () => {
    const tmpBefore = process.env.TMPDIR;
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'SLACK_BOT_TOKEN=xoxb-production\n');
    const mod = await loadFresh(false, { CONTAINER_IMAGE: `${OTHER_BASE}:latest`, DISCORD_BOT_TOKEN: 'production' });
    expect(mod.isShadowHost()).toBe(false);
    expect(mod.enterShadowHostMode()).toBeNull();
    expect(process.env.TMPDIR).toBe(tmpBefore);
    expect(logState.warn).not.toHaveBeenCalled();
  });

  it('points TMPDIR into the checkout and logs what shadow mode changed', async () => {
    const mod = await loadFresh(true, { WEBHOOK_PORT: '3999' });
    expect(mod.enterShadowHostMode()).toBeNull();
    const tmpDir = path.join(tmpRoot, 'data', 'tmp');
    expect(process.env.TMPDIR).toBe(tmpDir);
    expect(os.tmpdir()).toBe(tmpDir);
    expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
    expect(logState.warn).toHaveBeenCalledTimes(1);
    expect(logState.warn.mock.calls[0][0]).toMatch(/allowlisted.*image builds.*host credential mounts/);
  });

  it("refuses when CONTAINER_IMAGE points at another install's image, and changes nothing", async () => {
    const tmpBefore = process.env.TMPDIR;
    const mod = await loadFresh(true, { CONTAINER_IMAGE: `${OTHER_BASE}:latest` });
    const violation = mod.enterShadowHostMode();
    expect(violation).toContain(`${OTHER_BASE}:latest`);
    expect(violation).toContain(`${getContainerImageBase(tmpRoot)}:latest`);
    expect(process.env.TMPDIR).toBe(tmpBefore);
    expect(logState.warn).not.toHaveBeenCalled();
  });

  it('refuses without a WEBHOOK_PORT of its own, and changes nothing', async () => {
    const tmpBefore = process.env.TMPDIR;
    const mod = await loadFresh(true);
    expect(mod.enterShadowHostMode()).toMatch(/needs its own WEBHOOK_PORT \(got none\)/);
    expect(process.env.TMPDIR).toBe(tmpBefore);
    expect(logState.warn).not.toHaveBeenCalled();
  });

  it('refuses a WEBHOOK_PORT that is not a port number', async () => {
    for (const bad of ['abc', '0', '65536', '3000x']) {
      const mod = await loadFresh(true, { WEBHOOK_PORT: bad });
      expect(mod.enterShadowHostMode()).toContain(JSON.stringify(bad));
    }
  });

  it("accepts a WEBHOOK_PORT from this checkout's .env, which boot loads only later", async () => {
    fs.writeFileSync(path.join(tmpRoot, '.env'), 'WEBHOOK_PORT=3999\n');
    const mod = await loadFresh(true);
    expect(mod.enterShadowHostMode()).toBeNull();
  });

  it('refuses when CONTAINER_IMAGE_BASE is overridden to another namespace', async () => {
    const mod = await loadFresh(true, { CONTAINER_IMAGE_BASE: OTHER_BASE });
    expect(mod.enterShadowHostMode()).not.toBeNull();
  });
});

describe('per-spawn rules', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allow everything when shadow mode is off', async () => {
    const mod = await loadFresh(false);
    expect(mod.shadowSpawnImageViolation(`${OTHER_BASE}:ag-1`)).toBeNull();
    expect(mod.shadowProviderViolation('codex')).toBeNull();
    expect(mod.onecliAgentIdentifier('ag-123')).toBe('ag-123');
  });

  it("refuse a group imageTag in another install's namespace and allow its own", async () => {
    const ownBase = getContainerImageBase(process.cwd());
    const mod = await loadFresh(true);
    const refusal = mod.shadowSpawnImageViolation(`${OTHER_BASE}:ag-1`);
    expect(refusal).toContain(`${OTHER_BASE}:ag-1`);
    expect(refusal).toContain(`${ownBase}:<tag>`);
    expect(mod.shadowSpawnImageViolation(`${ownBase}:ag-1`)).toBeNull();
  });

  it('run Claude-provider sessions only on a shadow host', async () => {
    const mod = await loadFresh(true);
    expect(mod.shadowProviderViolation('claude')).toBeNull();
    expect(mod.shadowProviderViolation('codex')).toContain('codex');
    expect(mod.shadowProviderViolation('opencode')).not.toBeNull();
  });

  it('give a shadow OneCLI identity that never equals the group id and stays valid', async () => {
    const mod = await loadFresh(true);
    const identifier = mod.onecliAgentIdentifier('ag-123');
    expect(identifier).not.toBe('ag-123');
    expect(identifier.endsWith('-ag-123')).toBe(true);
    expect(identifier).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('call sites', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

  it('main() refuses a shadow boot before it binds the CLI socket or starts any service', () => {
    const source = read('src/main.ts');
    const check = source.indexOf('const shadowViolation = enterShadowHostMode();');
    const fatal = source.indexOf('if (shadowViolation) bootFatal(shadowViolation');
    const firstService = source.indexOf('await startCliServer();');
    expect(check).toBeGreaterThan(-1);
    expect(fatal).toBeGreaterThan(check);
    expect(firstService).toBeGreaterThan(fatal);
  });

  it('spawn checks the resolved image before the deps-drift check can request a rebuild', () => {
    const source = read('src/container-runner.ts');
    const resolved = source.indexOf('const spawnImageRef = containerConfig.imageTag || CONTAINER_IMAGE;');
    const refusal = source.indexOf('if (shadowImageRefusal) throw new Error(shadowImageRefusal);');
    const driftCheck = source.indexOf('await checkAgentRunnerDepsDrift(spawnImageRef)');
    expect(resolved).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(resolved);
    expect(driftCheck).toBeGreaterThan(refusal);
  });

  it('spawn derives the OneCLI identity through the shadow-aware helper', () => {
    expect(read('src/container-runner.ts')).toContain('const agentIdentifier = onecliAgentIdentifier(agentGroup.id);');
  });

  it('spawn refuses a non-Claude provider before the group filesystem or provider contribution is set up', () => {
    const source = read('src/container-runner.ts');
    const refusal = source.indexOf('if (shadowProviderRefusal) throw new Error(shadowProviderRefusal);');
    const groupInit = source.indexOf('initGroupFilesystem({ ...agentGroup');
    const contribution = source.indexOf('await resolveProviderContribution(spawnSession');
    expect(refusal).toBeGreaterThan(-1);
    expect(groupInit).toBeGreaterThan(refusal);
    expect(contribution).toBeGreaterThan(refusal);
  });
});
