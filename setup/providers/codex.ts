/**
 * Codex provider setup — auth walk-through + install verification. Codex-owned payload: its only
 * trunk reach-ins are one import and one picker entry in setup/auto.ts.
 *
 * Everything lands in the OneCLI vault, nothing in .env or the container. A ChatGPT login runs
 * with CODEX_HOME pointed at a throwaway dir and its auth.json is vaulted WHOLE; an API key is
 * stored as an `openai` secret.
 *
 * The vaulted ChatGPT session must be DEDICATED to the gateway — never a copy of the user's live
 * ~/.codex/auth.json. OpenAI rotates refresh tokens, so two consumers of one session strand each
 * other, and replaying a stale token invalidates the whole session family server-side, for the
 * gateway AND the user's own Codex CLI.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from '../lib/bright-select.js';
import { type AssistContext, failureReferences } from '../lib/claude-assist.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { effectiveDockerArgBeforeFinalRun, finalDockerArg, hasDockerRunConsumer } from '../lib/dockerfile-version.js';
import { type FailureAssistResult, registerSetupProvider } from './registry.js';

export interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

function listSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], { encoding: 'utf-8' });
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
}

const CODEX_CREDENTIAL_HOSTS = new Set(['api.openai.com', 'chatgpt.com']);

/** Whether OneCLI will route a secret to either Codex authentication endpoint. */
export function hasCodexCredentialRoute(secret: OnecliSecret): boolean {
  // Gateway routing is host-pattern based. Name and type are descriptive
  // metadata, so neither proves that this secret reaches a Codex endpoint.
  return secret.hostPattern !== null && CODEX_CREDENTIAL_HOSTS.has(secret.hostPattern.toLowerCase());
}

function findOpenAISecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find(hasCodexCredentialRoute);
}

function openAISecretExists(): boolean {
  try {
    return findOpenAISecret(listSecrets()) !== undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return false;
  }
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

export async function runCodexAuthStep(): Promise<void> {
  if (openAISecretExists()) {
    p.log.success(brandBody('Your OpenAI account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'openai-secret-already-present', PROVIDER: 'codex' });
    return;
  }

  const method = ensureAnswer(
    await brightSelect<'browser' | 'device' | 'api' | 'skip'>({
      message: 'How would you like to connect Codex?',
      options: [
        {
          value: 'browser',
          label: 'Sign in with my ChatGPT subscription',
          hint: 'recommended if you have Plus or Pro — opens a browser',
        },
        {
          value: 'device',
          label: 'ChatGPT device pairing',
          hint: 'no browser handoff — shows a URL and a code',
        },
        {
          value: 'api',
          label: 'Paste an OpenAI API key',
          hint: 'pay-per-use; stored in OneCLI, never copied into the container',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'Codex groups will start, but model calls will fail auth',
        },
      ],
    }),
  );
  setupLog.userInput('codex_auth_method', method);

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: "Skip Codex sign-in? Codex won't be able to answer until you connect an OpenAI account.",
        initialValue: false,
      }),
    );
    if (!confirmed) return runCodexAuthStep();
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped', PROVIDER: 'codex' });
    p.log.warn(brandBody('Codex sign-in skipped. Add an OpenAI account to OneCLI before using Codex groups.'));
    return;
  }

  if (method === 'api') {
    await runCodexApiKeyAuth();
    return;
  }

  await runCodexLoginAuth(method);
}

async function runCodexApiKeyAuth(): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Paste your OpenAI API key (sk-…)',
      validate: (v) => (v && v.trim().startsWith('sk-') ? undefined : 'That does not look like an OpenAI API key.'),
    }),
  ) as string;

  try {
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Codex',
        '--type',
        'openai',
        '--value',
        key.trim(),
        '--host-pattern',
        'api.openai.com',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: 'api', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your OpenAI key to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'codex', METHOD: 'api' });
  p.log.success(brandBody('OpenAI account connected.'));
}

export async function runCodexLoginAuth(method: 'browser' | 'device'): Promise<void> {
  const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (codexCheck.status !== 0) {
    p.log.error(
      brandBody(
        'The Codex CLI is not installed on this machine. Install it with `npm install -g @openai/codex`, then re-run setup — or choose the API key option instead.',
      ),
    );
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: method, ERROR: 'codex_cli_missing' });
    process.exit(1);
  }

  if (method === 'browser') {
    p.log.step(brandBody('Opening the Codex sign-in flow…'));
    console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  } else {
    p.log.step(brandBody('Starting Codex device-code pairing…'));
    console.log(k.dim('   (a URL and code will appear below — open the URL and enter the code)'));
  }
  console.log();

  // Throwaway CODEX_HOME: the vaulted session must never be shared with ~/.codex (see file header).
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-login-'));
  // Holds a live credential after login — must go on every exit path. The
  // failure branches call process.exit, which skips finally blocks, so each
  // removes it explicitly.
  const removeLoginHome = (): void => fs.rmSync(loginHome, { recursive: true, force: true });

  const args = method === 'device' ? ['login', '--device-auth'] : ['login'];
  const start = Date.now();
  const code = await runInherit('codex', args, { CODEX_HOME: loginHome });
  const durationMs = Date.now() - start;
  console.log();

  if (code !== 0) {
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, EXIT_CODE: String(code) });
    p.log.error(
      brandBody(
        "Couldn't complete the Codex sign-in. Re-run setup and try again, or choose the API key option instead.",
      ),
    );
    process.exit(1);
  }

  const authJsonPath = path.join(loginHome, 'auth.json');
  if (!fs.existsSync(authJsonPath)) {
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: 'auth_json_not_found' });
    p.log.error(
      brandBody('Codex login succeeded but no auth.json was written. Try again, or paste an API key instead.'),
    );
    process.exit(1);
  }

  try {
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Codex',
        '--type',
        'openai',
        '--file',
        authJsonPath,
        '--host-pattern',
        'chatgpt.com',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your Codex credentials to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  removeLoginHome();
  setupLog.step('auth', 'success', durationMs, { PROVIDER: 'codex', METHOD: method });
  p.log.success(brandBody('OpenAI account connected — credentials live in your OneCLI vault, never in the container.'));
}

function runInherit(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Needs ~/.codex/auth.json too: an API-key-only install keeps the key in the vault, so the host CLI can't authenticate. */
function isCodexCliUsable(): boolean {
  const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (codexCheck.status !== 0) return false;
  return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
}

export function buildCodexFailurePrompt(ctx: AssistContext, projectRoot: string): string {
  const references = failureReferences(ctx, projectRoot);

  const lines: string[] = [
    "The user is running NanoClaw's interactive setup flow and hit a failure.",
    '',
    `Failed step: ${ctx.stepName}`,
    `Error: ${ctx.msg}`,
  ];

  if (ctx.hint) lines.push(`Hint: ${ctx.hint}`);

  lines.push(
    '',
    'Your job: help them diagnose and fix this issue. Read the referenced files',
    'and logs to understand what went wrong, then help them fix it. You can read',
    'files, run commands, check logs, and explain what happened. Be concise.',
    "When they're ready to resume setup, tell them to exit Codex.",
    '',
    'Relevant files (read as needed):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/** Returns 'unavailable' when the CLI can't run here, so the dispatcher falls back to its Claude offer. */
async function offerCodexFailureAssist(ctx: AssistContext, projectRoot: string): Promise<FailureAssistResult> {
  if (!isCodexCliUsable()) return 'unavailable';

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want to debug this with Codex?',
      initialValue: true,
    }),
  );
  if (!want) return 'declined';

  const prompt = buildCodexFailurePrompt(ctx, projectRoot);

  note(
    [
      'Launching Codex to help debug this failure.',
      'It has the context of what went wrong.',
      '',
      k.dim("Exit Codex (Ctrl-C or /quit) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Codex',
  );

  return new Promise<FailureAssistResult>((resolve) => {
    // codex accepts a positional initial prompt for the interactive TUI.
    const child = spawn('codex', [prompt], { cwd: projectRoot, stdio: 'inherit' });
    child.on('close', () => {
      p.log.success(brandBody("Back from Codex. Let's continue."));
      resolve('launched');
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex.");
      resolve('unavailable');
    });
  });
}

/** The same pre-flight as /add-codex: a failed check means the install step should run. */
export function verifyCodexInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const requiredFiles = [
    'src/providers/codex.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of [
    'src/providers/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'setup/providers/index.ts',
  ]) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './codex.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const dockerfilePath = path.join(root, 'container', 'Dockerfile');
  const dockerfile = fs.existsSync(dockerfilePath) ? fs.readFileSync(dockerfilePath, 'utf-8') : '';
  const pinnedInstall = '"@openai/codex@${CODEX_VERSION}"';
  const hasPinnedInstall = hasDockerRunConsumer(dockerfile, pinnedInstall);
  const effectivePin = effectiveDockerArgBeforeFinalRun(dockerfile, 'CODEX_VERSION', pinnedInstall);
  const pinToValidate = hasPinnedInstall ? effectivePin : finalDockerArg(dockerfile, 'CODEX_VERSION');
  if (!pinToValidate || !/^\d+\.\d+\.\d+$/.test(pinToValidate)) {
    problems.push('container/Dockerfile missing an exact numeric ARG CODEX_VERSION pin');
  }
  if (!hasPinnedInstall) {
    problems.push('container/Dockerfile missing the pinned @openai/codex install');
  }

  return { ok: problems.length === 0, problems };
}

async function runCodexInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the Codex provider install…'));
  const { ok, problems } = verifyCodexInstall();
  if (ok) {
    setupLog.step('codex-install', 'success', 0, {});
    p.log.success(brandBody('Codex installed properly.'));
    return;
  }

  setupLog.step('codex-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Codex provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open Codex CLI or Claude Code in this repo and run the /add-codex skill. Setup will continue — Codex groups will work once the install completes.',
    ),
  );
}

// Codex's only reach-in to the setup flow, guarded by the barrel-driven registration test.
registerSetupProvider({
  value: 'codex',
  label: 'Codex',
  hint: 'OpenAI — ChatGPT subscription or API key',
  runAuth: runCodexAuthStep,
  runInstallCheck: runCodexInstallCheck,
  offerFailureAssist: offerCodexFailureAssist,
});
