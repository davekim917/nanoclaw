/**
 * Step: cli-agent — Create the first agent wired to the CLI channel.
 *
 * Thin wrapper around `scripts/init-first-agent.ts --cli-only`. Emits a
 * status block so /new-setup SKILL.md can parse the result without having
 * to read the script's plain stdout.
 *
 * Args:
 *   --display-name <name>   (required) operator's display name
 *   --agent-name   <name>   (optional) agent persona name, defaults to display-name
 *   --welcome      <text>   (optional) system welcome instruction
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): {
  displayName: string;
  agentName?: string;
  welcome?: string;
} {
  let displayName: string | undefined;
  let agentName: string | undefined;
  let welcome: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--display-name':
        displayName = val;
        i++;
        break;
      case '--agent-name':
        agentName = val;
        i++;
        break;
      case '--welcome':
        welcome = val;
        i++;
        break;
    }
  }

  if (!displayName) {
    emitStatus('CLI_AGENT', {
      STATUS: 'failed',
      ERROR: 'missing_display_name',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { displayName, agentName, welcome };
}

export async function run(args: string[]): Promise<void> {
  const { displayName, agentName, welcome } = parseArgs(args);

  const projectRoot = process.cwd();
  const script = path.join(projectRoot, 'scripts', 'init-first-agent.ts');

  const scriptArgs = ['exec', 'tsx', script, '--cli-only', '--display-name', displayName];
  if (agentName) scriptArgs.push('--agent-name', agentName);
  if (welcome) scriptArgs.push('--welcome', welcome);

  log.info('Invoking init-first-agent in cli-only mode', { displayName, agentName });

  try {
    execFileSync('pnpm', scriptArgs, {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    log.error('init-first-agent failed', {
      status: e.status,
      stdout: e.stdout,
      stderr: e.stderr,
    });
    emitStatus('CLI_AGENT', {
      STATUS: 'failed',
      ERROR: 'init_script_failed',
      EXIT_CODE: e.status ?? -1,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitStatus('CLI_AGENT', {
    DISPLAY_NAME: displayName,
    AGENT_NAME: agentName || displayName,
    CHANNEL: 'cli/local',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
