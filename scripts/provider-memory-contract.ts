/**
 * Fail-closed conformance gate for registry-branch provider payloads.
 *
 * Provider skills publish missing files create-only from the long-lived
 * `providers` branch and accept existing files only when byte-identical. This
 * validator reads the candidate ref before publication and the composed tree
 * afterward so a stale registry branch cannot silently restore provider-native
 * memory, bypass the shared pre-turn contract, or overwrite a customization.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type MemoryConformantProvider = 'codex' | 'opencode';

export const PROVIDER_PAYLOAD_FILES: Readonly<Record<MemoryConformantProvider, readonly string[]>> = {
  codex: [
    'src/providers/codex.ts',
    'src/providers/codex-registration.test.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
    'container/agent-runner/src/providers/exchange-archive.ts',
    'container/agent-runner/src/providers/exchange-archive.test.ts',
    'container/agent-runner/src/providers/codex-registration.test.ts',
    'container/agent-runner/src/providers/codex.factory.test.ts',
    'container/agent-runner/src/providers/codex-app-server.test.ts',
    'setup/providers/codex.ts',
    'setup/providers/codex.test.ts',
    'setup/providers/codex-registration.test.ts',
  ],
  opencode: [
    '.claude/skills/add-opencode/SKILL.md',
    'src/providers/opencode.ts',
    'src/providers/opencode-registration.test.ts',
    'container/agent-runner/src/providers/opencode.ts',
    'container/agent-runner/src/providers/mcp-to-opencode.ts',
    'container/agent-runner/src/providers/mcp-to-opencode.test.ts',
    'container/agent-runner/src/providers/opencode.factory.test.ts',
    'container/agent-runner/src/providers/opencode-registration.test.ts',
  ],
};

export type PayloadReader = (relativePath: string) => string | undefined;

interface InstallSnapshot {
  path: string;
  bytes?: Buffer;
}

function resolvePayloadTarget(projectRoot: string, relativePath: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (
    path.isAbsolute(relativePath) ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${relativePath}: provider payload path escapes the project root`);
  }
  return target;
}

function assertPayloadParentChain(projectRoot: string, relativePath: string, createMissing = false): string {
  const root = path.resolve(projectRoot);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${relativePath}: project root is not a safe directory`);
  }
  const target = resolvePayloadTarget(root, relativePath);
  const parentRelative = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of parentRelative ? parentRelative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!createMissing) break;
      try {
        fs.mkdirSync(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error(`${relativePath}: symlinked parent is not allowed: ${current}`);
    if (!stat.isDirectory()) throw new Error(`${relativePath}: non-directory parent is not allowed: ${current}`);
  }
  return target;
}

function atomicCreate(projectRoot: string, relativePath: string, bytes: Buffer, mode = 0o644): void {
  const target = assertPayloadParentChain(projectRoot, relativePath, true);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, mode);
    // Same-directory hard-link publication is atomic and create-only. Unlike
    // rename, it cannot replace a customization that appears after preflight.
    fs.linkSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function requireMatch(issues: string[], file: string, source: string, pattern: RegExp, description: string): void {
  if (!pattern.test(source)) issues.push(`${file}: missing ${description}`);
}

function rejectMatch(issues: string[], file: string, source: string, pattern: RegExp, description: string): void {
  if (pattern.test(source)) issues.push(`${file}: contains forbidden ${description}`);
}

export function validateProviderMemoryPayload(
  provider: MemoryConformantProvider,
  read: PayloadReader,
  options: { requirePayloadRoster?: boolean } = {},
): string[] {
  const issues: string[] = [];
  if (options.requirePayloadRoster) {
    for (const file of PROVIDER_PAYLOAD_FILES[provider]) {
      if (read(file) === undefined) issues.push(`${file}: missing from provider payload`);
    }
  }

  const runtimeFile = `container/agent-runner/src/providers/${provider}.ts`;
  const runtime = read(runtimeFile);
  if (runtime !== undefined) {
    requireMatch(
      issues,
      runtimeFile,
      runtime,
      /from ['"]\.\.\/memory\/session-hook\.js['"]/,
      'shared trusted-static lifecycle import',
    );
    requireMatch(
      issues,
      runtimeFile,
      runtime,
      /memoryContextForSessionStart\(['"]startup['"]\)/,
      'startup lifecycle guidance',
    );
    requireMatch(
      issues,
      runtimeFile,
      runtime,
      /registerMemorySessionHook\s*\(/,
      'provider lifecycle registration seam',
    );
    requireMatch(
      issues,
      runtimeFile,
      runtime,
      /input\.systemContext\?\.instructions/,
      'host-provided system context consumption',
    );
    rejectMatch(
      issues,
      runtimeFile,
      runtime,
      /from ['"]\.\.\/memory\/context\.js['"]|readMemoryContext|readMemoryFiles|\/workspace\/(?:agent|workgroup)\/memory/,
      'direct canonical-memory read in a provider lifecycle',
    );
  }

  if (provider === 'codex') {
    const appServerFile = 'container/agent-runner/src/providers/codex-app-server.ts';
    const appServer = read(appServerFile);
    if (appServer !== undefined) {
      requireMatch(
        issues,
        appServerFile,
        appServer,
        /['"]memories\.generate_memories=false['"]/,
        'Codex memory-generation disable override',
      );
      requireMatch(
        issues,
        appServerFile,
        appServer,
        /['"]memories\.use_memories=false['"]/,
        'Codex memory-retrieval disable override',
      );
      requireMatch(
        issues,
        appServerFile,
        appServer,
        /baseInstructions\??:\s*string/,
        'baseInstructions request contract',
      );
    }

    const appServerTestFile = 'container/agent-runner/src/providers/codex-app-server.test.ts';
    const appServerTest = read(appServerTestFile);
    if (appServerTest !== undefined) {
      requireMatch(
        issues,
        appServerTestFile,
        appServerTest,
        /memories\.generate_memories=false/,
        'test for disabled Codex memory generation',
      );
      requireMatch(
        issues,
        appServerTestFile,
        appServerTest,
        /memories\.use_memories=false/,
        'test for disabled Codex memory retrieval',
      );
    }
  } else {
    const skillFile = '.claude/skills/add-opencode/SKILL.md';
    const skill = read(skillFile);
    if (skill !== undefined) {
      requireMatch(
        issues,
        skillFile,
        skill,
        /provider-memory-contract\.ts --provider opencode --ref "\$remote\/providers" --install/,
        'create-only fetched-ref installer',
      );
      requireMatch(
        issues,
        skillFile,
        skill,
        /OPENCODE_VERSION=\$\(sed -nE[\s\S]*@opencode-ai\/sdk@"?\$\{OPENCODE_VERSION\}"?/,
        'Dockerfile-derived OpenCode SDK pin',
      );
      requireMatch(
        issues,
        skillFile,
        skill,
        /ncl groups config update --id <group-id> --provider opencode/,
        'container-config provider selection',
      );
      requireMatch(
        issues,
        skillFile,
        skill,
        /fails closed before the first write[\s\S]*possible local[\s\S]*customization/i,
        'customization-preserving fail-closed contract',
      );
      rejectMatch(issues, skillFile, skill, /AGENT_PROVIDER/, 'retired AGENT_PROVIDER configuration');
      rejectMatch(
        issues,
        skillFile,
        skill,
        /git show (?:origin|"\$remote")\/providers:/,
        'wholesale provider overwrite',
      );
      rejectMatch(
        issues,
        skillFile,
        skill,
        /user edits[\s\S]{0,80}won't survive/i,
        'customization-destructive reapply',
      );
      rejectMatch(issues, skillFile, skill, /1\.4\.17/, 'stale OpenCode version pin');
      rejectMatch(issues, skillFile, skill, /skip to \*\*Configuration\*\*/i, 'installed-state gate bypass');
    }
  }

  return issues;
}

export function compareProviderPayloadBytes(
  provider: MemoryConformantProvider,
  expected: PayloadReader,
  actual: PayloadReader,
): string[] {
  const issues: string[] = [];
  for (const relativePath of PROVIDER_PAYLOAD_FILES[provider]) {
    const expectedBytes = expected(relativePath);
    const actualBytes = actual(relativePath);
    if (expectedBytes === undefined) issues.push(`${relativePath}: missing from expected provider payload`);
    else if (actualBytes === undefined) issues.push(`${relativePath}: missing from composed provider tree`);
    else if (actualBytes !== expectedBytes)
      issues.push(`${relativePath}: composed bytes differ from fetched provider payload`);
  }
  return issues;
}

/**
 * Install a fully-read, prevalidated provider payload without overwriting any
 * existing path. If later publication fails, already-published create-only
 * files are deliberately retained: there is no portable atomic
 * compare-and-unlink, so automatic deletion cannot prove it still owns a path.
 */
export function installProviderMemoryPayload(
  provider: MemoryConformantProvider,
  readCandidate: PayloadReader,
  projectRoot: string,
  testHooks: { afterWrite?: (relativePath: string, index: number) => void } = {},
): void {
  const candidate = new Map<string, string>();
  for (const relativePath of PROVIDER_PAYLOAD_FILES[provider]) {
    const source = readCandidate(relativePath);
    if (source !== undefined) candidate.set(relativePath, source);
  }
  const candidateIssues = validateProviderMemoryPayload(provider, (file) => candidate.get(file), {
    requirePayloadRoster: true,
  });
  if (candidateIssues.length > 0) throw new Error(candidateIssues.join('\n'));

  const targets = new Map(
    PROVIDER_PAYLOAD_FILES[provider].map((relativePath) => [
      relativePath,
      assertPayloadParentChain(projectRoot, relativePath),
    ]),
  );
  for (const relativePath of PROVIDER_PAYLOAD_FILES[provider]) {
    const target = targets.get(relativePath)!;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) {
        throw new Error(`${relativePath}: existing target is not a regular file; refusing to replace customization`);
      }
      if (!fs.readFileSync(target).equals(Buffer.from(candidate.get(relativePath)!, 'utf8'))) {
        throw new Error(
          `${relativePath}: existing bytes differ from the fetched provider payload; refusing to overwrite possible customization`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const snapshots: InstallSnapshot[] = PROVIDER_PAYLOAD_FILES[provider].map((relativePath) => {
    const target = targets.get(relativePath)!;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) {
        throw new Error(`${relativePath}: existing target is not a regular file; refusing to replace customization`);
      }
      const bytes = fs.readFileSync(target);
      if (!bytes.equals(Buffer.from(candidate.get(relativePath)!, 'utf8'))) {
        throw new Error(
          `${relativePath}: existing bytes changed during install preflight; refusing to overwrite possible customization`,
        );
      }
      return { path: relativePath, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { path: relativePath };
    }
  });

  const created = new Set<string>();
  try {
    PROVIDER_PAYLOAD_FILES[provider].forEach((relativePath, index) => {
      const prior = snapshots[index];
      if (prior.bytes === undefined) {
        atomicCreate(projectRoot, relativePath, Buffer.from(candidate.get(relativePath)!, 'utf8'), 0o644);
        created.add(relativePath);
      }
      testHooks.afterWrite?.(relativePath, index);
    });
    const postIssues = validateProviderMemoryPayload(provider, treeReader(projectRoot), {
      requirePayloadRoster: true,
    });
    postIssues.push(...compareProviderPayloadBytes(provider, (file) => candidate.get(file), treeReader(projectRoot)));
    if (postIssues.length > 0) throw new Error(postIssues.join('\n'));
  } catch (error) {
    if (created.size === 0) throw error;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        'Create-only retention policy kept every path published by this attempt; inspect before retry:\n' +
        [...created].sort().join('\n'),
      { cause: error },
    );
  }
}

export function gitRefReader(projectRoot: string, ref: string): PayloadReader {
  return (relativePath) => {
    try {
      return execFileSync('git', ['show', `${ref}:${relativePath}`], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return undefined;
    }
  };
}

export function treeReader(projectRoot: string): PayloadReader {
  return (relativePath) => {
    try {
      return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return undefined;
    }
  };
}

function parseCli(argv: string[]): {
  provider: MemoryConformantProvider;
  projectRoot: string;
  ref?: string;
  requirePayloadRoster: boolean;
  install: boolean;
  matchRef?: string;
} {
  let provider: MemoryConformantProvider | undefined;
  let projectRoot = process.cwd();
  let ref: string | undefined;
  let requirePayloadRoster = false;
  let install = false;
  let matchRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      const value = argv[++i];
      if (value === 'codex' || value === 'opencode') provider = value;
      else throw new Error(`unsupported provider: ${value ?? '(missing)'}`);
    } else if (arg === '--root') {
      projectRoot = path.resolve(argv[++i] ?? '');
    } else if (arg === '--ref') {
      ref = argv[++i];
      if (!ref) throw new Error('--ref requires a git ref');
    } else if (arg === '--require-payload') {
      requirePayloadRoster = true;
    } else if (arg === '--install') {
      install = true;
    } else if (arg === '--match-ref') {
      matchRef = argv[++i];
      if (!matchRef) throw new Error('--match-ref requires a git ref');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!provider) throw new Error('--provider codex|opencode is required');
  if (install && !ref) throw new Error('--install requires --ref');
  if (ref && matchRef) throw new Error('--ref and --match-ref are mutually exclusive');
  return { provider, projectRoot, ref, requirePayloadRoster, install, matchRef };
}

export function runProviderMemoryContractCli(argv: string[]): number {
  try {
    const { provider, projectRoot, ref, requirePayloadRoster, install, matchRef } = parseCli(argv);
    if (install) {
      installProviderMemoryPayload(provider, gitRefReader(projectRoot, ref!), projectRoot);
      console.log(`${provider} provider payload installed create-only (${ref})`);
      return 0;
    }
    const issues = validateProviderMemoryPayload(
      provider,
      ref ? gitRefReader(projectRoot, ref) : treeReader(projectRoot),
      { requirePayloadRoster: ref !== undefined || matchRef !== undefined || requirePayloadRoster },
    );
    if (matchRef) {
      issues.push(
        ...compareProviderPayloadBytes(provider, gitRefReader(projectRoot, matchRef), treeReader(projectRoot)),
      );
    }
    if (issues.length > 0) {
      console.error(
        [
          `${provider} provider payload is not memory-conformant${ref ? ` at ${ref}` : ''}:`,
          ...issues.map((issue) => `- ${issue}`),
          ref
            ? 'No provider files were copied. Sync the providers branch before retrying.'
            : 'The composed provider tree is not conformant. Repair or reapply the provider payload before continuing.',
        ].join('\n'),
      );
      return 1;
    }
    console.log(
      `${provider} provider memory contract: OK${
        ref ? ` (${ref})` : matchRef ? ` (composed bytes match ${matchRef})` : ''
      }`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runProviderMemoryContractCli(process.argv.slice(2));
}
