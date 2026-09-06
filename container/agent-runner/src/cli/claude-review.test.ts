import { allowSubprocess } from '../test-hermeticity.js';
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { startClaudeReviewService, type ClaudeReviewService } from './claude-review-service.js';
import { requestClaudeReview } from './claude-review.js';
import {
  parseClaudeReviewArgs,
  reviewCliArgs,
  toClaudeReviewWireRequest,
  validateClaudeReviewRequest,
  MAX_CLAUDE_REVIEW_PROMPT_BYTES,
  type ClaudeReviewRequest,
} from './claude-review-contract.js';
import { isPreInferenceCredentialFailure } from '../providers/claude-review-classification.js';

allowSubprocess(['claude-fake', path.basename(process.execPath)]);

const quota = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  result: "You've hit your session limit · resets 2:40pm (America/New_York)",
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
};
const success = { type: 'result', is_error: false, result: 'review complete' };
const dirs: string[] = [];
const services: ClaudeReviewService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const request = (cwd: string): ClaudeReviewRequest => ({
  cwd,
  model: 'claude-fable-5-1',
  effort: 'high',
  jsonSchema: '{"type":"object"}',
  stdin: Buffer.concat([Buffer.from('review\n日本語\n'), Buffer.from([0, 255])]),
});
async function fixture(env: NodeJS.ProcessEnv = {}, mode = 'normal') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  dirs.push(dir);
  const cli = path.join(dir, 'claude-fake');
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nimport fs from 'node:fs';\nconst input=await Bun.stdin.bytes();\nconst key=process.env.ANTHROPIC_API_KEY||process.env.CLAUDE_CODE_OAUTH_TOKEN||'none';\nfs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))},JSON.stringify({key,argv:process.argv.slice(2),stdin:Buffer.from(input).toString('base64'),cwd:process.cwd(),auth:Object.keys(process.env).filter(k=>/^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)/.test(k))})+'\\n');\nif(process.env.MODE==='hang'){fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))},String(process.pid));setInterval(()=>{},1000);await new Promise(()=>{});}\nif(process.env.MODE==='tree'){const child=Bun.spawn([process.execPath,'-e',\"process.on('SIGTERM',()=>{});require('fs').writeFileSync('grandchild-pid',String(process.pid));setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);await child.exited;}\nif(process.env.MODE==='overflow'){await Bun.write(Bun.stdout,'x'.repeat(17*1024*1024));process.exit(1);}\nif(process.env.MODE==='nonquota'){console.log('bad configuration');process.exit(7);}\nif(process.env.MODE==='leak'){console.log(JSON.stringify({is_error:false,result:key}));console.error(key);process.exit(0);}\nconst fail=key!=='healthy'||process.env.MODE==='exhaust';console.log(JSON.stringify(fail?${JSON.stringify(quota)}:${JSON.stringify(success)}));process.exit(fail?1:0);\n`,
    { mode: 0o700 },
  );
  const snapshot = { PATH: process.env.PATH, MODE: mode, ...env };
  const service = await startClaudeReviewService({ executable: cli, getEnv: () => snapshot });
  services.push(service);
  return {
    dir,
    service,
    snapshot,
    calls: () =>
      fs.existsSync(path.join(dir, 'calls'))
        ? fs
            .readFileSync(path.join(dir, 'calls'), 'utf8')
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s))
        : [],
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await Bun.sleep(20);
  }
}

describe('Claude review credential rotation', () => {
  it('preserves ordinary auth behavior with no configured ring', async () => {
    const f = await fixture();
    const result = await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(result.exitCode).toBe(1);
    expect(f.calls().map((c) => c.key)).toEqual(['none']);
  });
  it('reads the current runner credential on each new review', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited', CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy' });
    await requestClaudeReview(f.service.socketPath, request(f.dir));
    f.snapshot.CLAUDE_CODE_OAUTH_TOKEN = 'healthy';
    await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(f.calls().map((c) => c.key)).toEqual(['limited', 'healthy', 'healthy']);
  });
  it('contains a spawn failure rather than crashing the runner', async () => {
    const service = await startClaudeReviewService({ executable: '/nonexistent/claude-fake', getEnv: () => ({}) });
    services.push(service);
    const result = await requestClaudeReview(service.socketPath, request('/tmp'));
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('unable to start original CLI');
  });

  it('retries the incident session-limit result with the next credential and preserves review input and arguments', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited', CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy' });
    const req = request(f.dir),
      result = await requestClaudeReview(f.service.socketPath, req);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(success);
    expect(f.calls().map((c) => c.key)).toEqual(['limited', 'healthy']);
    for (const c of f.calls()) {
      expect(c.stdin).toBe(req.stdin.toString('base64'));
      expect(c.argv).toEqual(reviewCliArgs(req));
      expect(c.cwd).toBe(req.cwd);
      expect(c.auth).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    }
    expect(result.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN_2');
    expect(result.stderr).not.toContain('limited');
  });
  it('bounds and deduplicates the credential ring in numeric order', async () => {
    const f = await fixture(
      {
        CLAUDE_CODE_OAUTH_TOKEN: 'first',
        CLAUDE_CODE_OAUTH_TOKEN_10: 'last',
        CLAUDE_CODE_OAUTH_TOKEN_2: 'second',
        CLAUDE_CODE_OAUTH_TOKEN_3: 'first',
      },
      'exhaust',
    );
    const result = await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(quota);
    expect(f.calls().map((c) => c.key)).toEqual(['first', 'second', 'last']);
  });
  it('keeps authentication families separate', async () => {
    const f = await fixture({
      ANTHROPIC_API_KEY: 'limited',
      ANTHROPIC_API_KEY_2: 'healthy',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_OAUTH_TOKEN_2: 'other',
    });
    expect((await requestClaudeReview(f.service.socketPath, request(f.dir))).exitCode).toBe(0);
    expect(f.calls().map((c) => c.auth)).toEqual([['ANTHROPIC_API_KEY'], ['ANTHROPIC_API_KEY']]);
  });
  it('never emits credentials or changes parent environment', async () => {
    const f = await fixture(
      { CLAUDE_CODE_OAUTH_TOKEN: 'secret-unique-value', CLAUDE_CODE_OAUTH_TOKEN_2: 'other-secret' },
      'leak',
    );
    const result = await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(JSON.stringify(result)).not.toContain('secret-unique-value');
    expect(result.stdout).toContain('[redacted]');
    expect(f.snapshot.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-unique-value');
  });
  it('does not retry non-quota errors and preserves exit status', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'first', CLAUDE_CODE_OAUTH_TOKEN_2: 'second' }, 'nonquota');
    const result = await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('bad configuration\n');
    expect(f.calls()).toHaveLength(1);
  });
  it('does not replay successful or unsafe failures', () => {
    expect(isPreInferenceCredentialFailure(JSON.stringify(quota))).toBe(true);
    for (const bad of [
      { ...quota, is_error: false },
      { ...quota, result: 'API Error: Server is temporarily limiting requests (not your usage limit)' },
      { ...quota, usage: { ...quota.usage, input_tokens: 1 } },
      { ...quota, usage: { ...quota.usage, cache_read_input_tokens: 1 } },
      { ...quota, modelUsage: { model: { outputTokens: 1 } } },
      { ...quota, usage: undefined },
    ])
      expect(isPreInferenceCredentialFailure(JSON.stringify(bad))).toBe(false);
    expect(isPreInferenceCredentialFailure('bad json')).toBe(false);
  });
  it('passes other CLI invocations through', () => {
    const args = reviewCliArgs(request('/tmp'));
    expect(parseClaudeReviewArgs(args)).not.toBeNull();
    for (const bad of [
      [],
      ['--version'],
      [...args, '--settings', 'evil'],
      [...args, '--model', 'other'],
      args.filter((a) => a !== '--safe-mode'),
      args.flatMap((a, i) => (a === '--tools' || args[i - 1] === '--tools' ? [] : [a])),
    ])
      expect(parseClaudeReviewArgs(bad)).toBeNull();
  });
  it('rejects unsafe service requests and accepts large raw input', () => {
    const wire = toClaudeReviewWireRequest(request('/tmp'));
    for (const bad of [
      { ...wire, env: {} },
      { ...wire, executable: '/tmp/evil' },
      { ...wire, model: '--settings' },
      { ...wire, cwd: 'relative' },
      { ...wire, stdinBase64: '!!!!' },
    ])
      expect(() => validateClaudeReviewRequest(bad)).toThrow();
    const large = Buffer.alloc(4 * 1024 * 1024, 97);
    expect(validateClaudeReviewRequest({ ...wire, stdinBase64: large.toString('base64') }).stdin).toEqual(large);
    expect(() =>
      validateClaudeReviewRequest({
        ...wire,
        stdinBase64: Buffer.alloc(MAX_CLAUDE_REVIEW_PROMPT_BYTES + 1).toString('base64'),
      }),
    ).toThrow();
  });
  it('rejects unsafe socket requests before launching a child', async () => {
    const f = await fixture();
    const payload = { ...toClaudeReviewWireRequest(request(f.dir)), env: { ANTHROPIC_API_KEY: 'injected' } };
    const raw = await new Promise<string>((resolve, reject) => {
      const s = net.createConnection(f.service.socketPath);
      let out = '';
      s.on('connect', () => s.write(JSON.stringify(payload) + '\n'));
      s.on('data', (c) => (out += c));
      s.on('end', () => resolve(out));
      s.on('error', reject);
    });
    expect(JSON.parse(raw).exitCode).toBe(2);
    expect(f.calls()).toHaveLength(0);
  });
  it('works with a sanitized client environment', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited', CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy' });
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'claude-review.ts'), '--nanoclaw-review', ...reviewCliArgs(request(f.dir))],
      {
        cwd: f.dir,
        env: { PATH: process.env.PATH, NANOCLAW_CLAUDE_REVIEW_SOCKET: f.service.socketPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const out: Buffer[] = [];
    child.stdout!.on('data', (c) => out.push(c));
    child.stderr!.resume();
    child.stdin!.end('hello');
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    expect(JSON.parse(Buffer.concat(out).toString())).toEqual(success);
    expect(f.calls()).toHaveLength(2);
  });
  it('cancels the foreground child when its client is killed after upload', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited', CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy' }, 'hang');
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dir, 'claude-review.ts'), '--nanoclaw-review', ...reviewCliArgs(request(f.dir))],
      {
        cwd: f.dir,
        env: { PATH: process.env.PATH, NANOCLAW_CLAUDE_REVIEW_SOCKET: f.service.socketPath },
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    child.stdin!.end('hello');
    await until(() => fs.existsSync(path.join(f.dir, 'pid')));
    const pid = Number(fs.readFileSync(path.join(f.dir, 'pid'), 'utf8'));
    child.kill('SIGKILL');
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(f.calls()).toHaveLength(1);
  });
  it('stops active children and removes its private socket', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited' }, 'hang');
    const pending = requestClaudeReview(f.service.socketPath, request(f.dir)).catch(() => null);
    await until(() => fs.existsSync(path.join(f.dir, 'pid')));
    expect(fs.statSync(path.dirname(f.service.socketPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.service.socketPath).mode & 0o777).toBe(0o600);
    await f.service.stop();
    await pending;
    expect(fs.existsSync(f.service.socketPath)).toBe(false);
  });

  it('kills a TERM-resistant grandchild after the CLI shim exits', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited' }, 'tree');
    const client = net.createConnection(f.service.socketPath);
    client.on('error', () => undefined);
    client.on('connect', () => client.write(JSON.stringify(toClaudeReviewWireRequest(request(f.dir))) + '\n'));
    await until(() => fs.existsSync(path.join(f.dir, 'grandchild-pid')));
    const pid = Number(fs.readFileSync(path.join(f.dir, 'grandchild-pid'), 'utf8'));
    client.destroy();
    await until(() => {
      try {
        process.kill(pid, 0);
        // Orphaned children can be zombies briefly while the container init reaps.
        return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ');
      } catch {
        return true;
      }
    });
    expect(f.calls()).toHaveLength(1);
  });
  it('reports output overflow explicitly', async () => {
    const f = await fixture({ CLAUDE_CODE_OAUTH_TOKEN: 'limited' }, 'overflow');
    const r = await requestClaudeReview(f.service.socketPath, request(f.dir));
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('exceeded');
  });
});
