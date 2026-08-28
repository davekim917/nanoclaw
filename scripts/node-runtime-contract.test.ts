import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { getDeployEnvironment } from '../src/channels/discord-slash-commands.js';

const ROOT = resolve(import.meta.dirname, '..');
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function executable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function nodeStub(path: string, version: string): void {
  executable(
    path,
    `if [[ "\${1:-}" == "--version" ]]; then echo v${version}; else exec ${JSON.stringify(process.execPath)} "$@"; fi`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Node runtime contract', () => {
  it('test_node_floor_boundaries', async () => {
    const checker = join(ROOT, 'scripts/check-node-version.mjs');
    const mod = (await import(pathToFileURL(checker).href)) as {
      isNodeVersionSupported(version: string): boolean;
    };

    expect(mod.isNodeVersionSupported('20.20.2')).toBe(false);
    expect(mod.isNodeVersionSupported('22.18.0')).toBe(false);
    expect(mod.isNodeVersionSupported('22.19.0')).toBe(true);
    expect(mod.isNodeVersionSupported('v22.19.0')).toBe(true);
    expect(mod.isNodeVersionSupported('22.23.2')).toBe(true);
    expect(mod.isNodeVersionSupported('24.0.0')).toBe(true);
    expect(mod.isNodeVersionSupported('22.19.0-rc.1')).toBe(false);
    expect(mod.isNodeVersionSupported('not-a-version')).toBe(false);
  });

  it('test_install_node_upgrades_unsupported_existing_node', () => {
    const root = tempDir('nanoclaw-node-install-');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const calls = join(root, 'calls.log');
    mkdirSync(join(home, 'node', 'bin'), { recursive: true });

    executable(
      join(bin, 'node'),
      `if [[ "\${1:-}" == "--version" ]]; then echo v20.20.2; else exec ${JSON.stringify(process.execPath)} "$@"; fi`,
    );
    executable(
      join(bin, 'uvx'),
      `echo "uvx $*" >> ${JSON.stringify(calls)}
mkdir -p "$HOME/node/bin"
cat > "$HOME/node/bin/node" <<'EOF'
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo v22.19.0; else exec ${JSON.stringify(process.execPath)} "$@"; fi
EOF
chmod +x "$HOME/node/bin/node"
for tool in npm npx pnpm; do ln -sf node "$HOME/node/bin/$tool"; done`,
    );

    const result = spawnSync('bash', [join(ROOT, 'setup/install-node.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STEP: upgrade-node');
    expect(result.stdout).not.toContain('STATUS: already-installed');
    expect(readFileSync(calls, 'utf8')).toContain('uvx nodeenv --force -n lts');
  });

  it.each([
    { platform: 'Darwin', installer: 'Homebrew' },
    { platform: 'Linux', installer: 'NodeSource' },
  ])('test_setup_reuses_the_$installer_node_instead_of_a_stale_local_node', ({ platform }) => {
    const root = tempDir(`nanoclaw-node-selected-${platform.toLowerCase()}-`);
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const staleLocal = join(home, '.local', 'bin', 'node');
    const status = join(root, 'install-node.status');
    const selectedPrefix = platform === 'Darwin' ? join(root, 'opt', 'node@22') : bin;
    const selectedNode = platform === 'Darwin' ? join(selectedPrefix, 'bin', 'node') : join(bin, 'node');

    nodeStub(join(bin, 'node'), '20.20.2');
    nodeStub(staleLocal, '18.20.8');
    executable(join(bin, 'uname'), `echo ${platform}`);

    if (platform === 'Darwin') {
      nodeStub(selectedNode, '22.19.0');
      executable(
        join(bin, 'brew'),
        `if [[ "\${1:-}" == "--prefix" ]]; then echo ${JSON.stringify(selectedPrefix)}; fi`,
      );
    } else {
      const installedNode = join(root, 'installed-node');
      nodeStub(installedNode, '22.19.0');
      executable(join(bin, 'curl'), 'exit 0');
      executable(
        join(bin, 'sudo'),
        `if [[ "\${1:-}" == "-E" ]]; then cat >/dev/null; exit 0; fi
if [[ "\${1:-}" == "apt-get" ]]; then cp ${JSON.stringify(installedNode)} ${JSON.stringify(selectedNode)}; exit 0; fi
exit 1`,
      );
    }

    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -o pipefail; ` +
          `bash ${JSON.stringify(join(ROOT, 'setup/install-node.sh'))} | tee ${JSON.stringify(status)}; ` +
          `source ${JSON.stringify(join(ROOT, 'setup/lib/node-runtime.sh'))}; ` +
          `activate_bootstrap_node ${JSON.stringify(status)}; ` +
          `printf 'ACTIVE_NODE: %s\\n' "$(command -v node)"`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          PROJECT_ROOT: ROOT,
        },
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('STEP: upgrade-node');
    expect(result.stdout).toContain(`NODE_PATH: ${selectedNode}`);
    expect(result.stdout).toContain(`ACTIVE_NODE: ${selectedNode}`);
    expect(result.stdout).not.toContain(`ACTIVE_NODE: ${staleLocal}`);
  });

  it('test_setup_activates_the_installer_reported_node_path', () => {
    const source = readFileSync(join(ROOT, 'setup.sh'), 'utf8');
    const install = source.indexOf('bash "$PROJECT_ROOT/setup/install-node.sh"');
    const activate = source.indexOf('activate_bootstrap_node "$INSTALL_NODE_STATUS"', install);
    const check = source.indexOf('check_node', activate);

    expect(install).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(install);
    expect(check).toBeGreaterThan(activate);
    expect(source).not.toContain('[ -x "$HOME/.local/bin/node" ]');
  });

  it('test_parent_shell_activates_the_bootstrap_node_and_pnpm', () => {
    const root = tempDir('nanoclaw-node-parent-');
    const oldBin = join(root, 'old-bin');
    const newBin = join(root, 'new-bin');
    const status = join(root, 'bootstrap.log');

    executable(join(oldBin, 'node'), 'echo v20.20.2');
    executable(join(oldBin, 'pnpm'), 'echo old-pnpm');
    executable(
      join(newBin, 'node'),
      `if [[ "\${1:-}" == "--version" ]]; then echo v22.19.0; else exec ${JSON.stringify(process.execPath)} "$@"; fi`,
    );
    executable(join(newBin, 'pnpm'), 'echo new-pnpm');
    writeFileSync(status, `NODE_PATH: ${join(newBin, 'node')}\nSTATUS: success\n`);

    const result = spawnSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(join(ROOT, 'setup/lib/node-runtime.sh'))}; ` +
          `activate_bootstrap_node ${JSON.stringify(status)}; command -v node; command -v pnpm`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: ROOT, PATH: `${oldBin}:/usr/bin:/bin` },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([join(newBin, 'node'), join(newBin, 'pnpm')]);
  });

  it('test_parent_shell_rejects_an_invalid_bootstrap_node_path', () => {
    const root = tempDir('nanoclaw-node-parent-invalid-');
    const status = join(root, 'bootstrap.log');
    writeFileSync(status, 'NODE_PATH: not_found\nSTATUS: success\n');

    const result = spawnSync(
      'bash',
      [
        '-c',
        `source ${JSON.stringify(join(ROOT, 'setup/lib/node-runtime.sh'))}; ` +
          `activate_bootstrap_node ${JSON.stringify(status)}`,
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: ROOT } },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not report an executable Node path');
  });

  it('test_deploy_stops_before_restart_on_unsupported_node', () => {
    const root = tempDir('nanoclaw-node-deploy-');
    const bin = join(root, 'bin');
    const calls = join(root, 'calls.log');
    const deploy = join(root, 'deploy.sh');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'setup/lib'), { recursive: true });
    cpSync(join(ROOT, 'scripts/check-node-version.mjs'), join(root, 'scripts/check-node-version.mjs'));
    cpSync(join(ROOT, 'setup/lib/install-slug.sh'), join(root, 'setup/lib/install-slug.sh'));

    writeFileSync(
      deploy,
      readFileSync(join(ROOT, 'scripts/deploy.sh'), 'utf8').replace(
        'cd /home/ubuntu/nanoclaw-v2',
        `cd ${JSON.stringify(root)}`,
      ),
    );
    chmodSync(deploy, 0o755);

    executable(
      join(bin, 'node'),
      `if [[ "\${1:-}" == "--version" ]]; then echo v20.20.2; elif [[ "\${1:-}" == "-p" ]]; then echo 2.1.53; else exec ${JSON.stringify(process.execPath)} "$@"; fi`,
    );
    for (const command of ['git', 'pnpm', 'docker', 'sudo', 'systemctl']) {
      executable(join(bin, command), `echo "${command} $*" >> ${JSON.stringify(calls)}; exit 0`);
    }

    const missingRuntime = spawnSync('bash', [deploy], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        NANOCLAW_NODE_BIN: '',
      },
    });
    expect(missingRuntime.status).not.toBe(0);
    expect(`${missingRuntime.stdout}\n${missingRuntime.stderr}`).toContain('service Node runtime path not supplied');
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');

    const result = spawnSync('bash', [deploy], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        NANOCLAW_NODE_BIN: join(bin, 'node'),
      },
    });
    const recorded = existsSync(calls) ? readFileSync(calls, 'utf8') : '';

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Node .*22\.19\.0|unsupported Node/i);
    expect(recorded).not.toMatch(/pnpm (install|run build)|systemctl restart/);
    expect(readFileSync(join(root, 'logs/deploy-status.json'), 'utf8')).not.toContain('"status":"ok"');
  });

  it('test_deploy_uses_the_running_service_node', () => {
    expect(
      getDeployEnvironment({ KEEP_ME: 'yes', PATH: '/usr/bin', NANOCLAW_NODE_BIN: '/stale/node' }, '/service/bin/node'),
    ).toEqual({
      KEEP_ME: 'yes',
      PATH: `/service/bin${delimiter}/usr/bin`,
      NANOCLAW_NODE_BIN: '/service/bin/node',
    });
  });

  it('test_engine_strict_blocks_old_node', () => {
    const root = tempDir('nanoclaw-engine-strict-');
    const packageManager = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager as string;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'engine-strict-contract',
        version: '1.0.0',
        packageManager,
        engines: { node: '>=999.0.0' },
      }),
    );
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    if (existsSync(join(ROOT, '.npmrc'))) cpSync(join(ROOT, '.npmrc'), join(root, '.npmrc'));

    const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported environment/);
  });

  it('test_node_22_19_24_ci_matrix', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toMatch(/node-version:\s*\[22\.19\.0, 24\]/);
    expect(workflow).toMatch(/pnpm install --frozen-lockfile/);
    expect(workflow).toMatch(/Format check[\s\S]*Public repository boundary[\s\S]*Typecheck host/);
    expect(workflow).toMatch(/Typecheck container[\s\S]*Host tests[\s\S]*Container tests/);
    expect(workflow).toMatch(/^\s{2}ci:\s*$/m);
    expect(workflow).toMatch(/needs:\s*test/);
  });

  it('test_setup_launchers_activate_bootstrap_node_before_pnpm', () => {
    for (const launcher of ['nanoclaw.sh', 'migrate-v2.sh']) {
      const source = readFileSync(join(ROOT, launcher), 'utf8');
      const activate = source.indexOf('activate_bootstrap_node "$BOOTSTRAP_RAW"');
      const firstPnpmAfterBootstrap = source.indexOf('command -v pnpm', activate);
      expect(activate, launcher).toBeGreaterThan(-1);
      expect(firstPnpmAfterBootstrap, launcher).toBeGreaterThan(activate);
    }
  });
});
