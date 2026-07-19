import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';

import { checkAgentRunnerDepsDrift, computeAgentRunnerDepsHash } from './agent-runner-image-check.js';
import { CONTAINER_IMAGE, REPO_ROOT } from './config.js';

describe('computeAgentRunnerDepsHash', () => {
  it('matches sha256(sha256(package.json) || sha256(bun.lock)) sliced to 16 chars', async () => {
    const pkg = await readFile(path.join(REPO_ROOT, 'container/agent-runner/package.json'));
    const lock = await readFile(path.join(REPO_ROOT, 'container/agent-runner/bun.lock'));
    const pkgHash = createHash('sha256').update(pkg).digest('hex');
    const lockHash = createHash('sha256').update(lock).digest('hex');
    const expected = createHash('sha256')
      .update(pkgHash + lockHash)
      .digest('hex')
      .slice(0, 16);
    const actual = await computeAgentRunnerDepsHash();
    expect(actual).toBe(expected);
    expect(actual).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across invocations', async () => {
    const a = await computeAgentRunnerDepsHash();
    const b = await computeAgentRunnerDepsHash();
    expect(a).toBe(b);
  });
});

describe('checkAgentRunnerDepsDrift', () => {
  it('does not misclassify a nonexistent image as missing-label', async () => {
    const fakeRef = `nanoclaw-agent-test-${Date.now()}-does-not-exist:never`;
    const r = await checkAgentRunnerDepsDrift(fakeRef);
    expect(r.ok).toBe(false);
    // 'no-image' when docker is present and image is absent;
    // 'inspect-error' when docker itself is unavailable (CI sandbox without
    // docker, daemon down, permission denied). Both are valid outcomes — the
    // contract is "never misclassify as missing-label".
    expect(r.lookup.kind === 'no-image' || r.lookup.kind === 'inspect-error').toBe(true);
    expect(r.lookup.kind).not.toBe('missing');
  });

  it('emits the base rebuild hint when imageRef is CONTAINER_IMAGE', async () => {
    const { CONTAINER_IMAGE } = await import('./config.js');
    const r = await checkAgentRunnerDepsDrift(CONTAINER_IMAGE);
    // Either ok (in-sync) or drift — message should never reach for the
    // per-agent branch since ref IS the base.
    expect(r.message).not.toMatch(/per-agent override image/);
  });

  it('emits the per-agent rebuild hint for override refs that are missing entirely', async () => {
    const r = await checkAgentRunnerDepsDrift('nanoclaw-agent-per-group-test-does-not-exist:x');
    // Override ref + no-image → fail closed with the per-agent rebuild hint
    // (the override genuinely doesn't exist, can't spawn from nothing).
    // Override ref + inspect-error (docker down) → no per-agent hint; we just
    // can't reach the daemon. Skip the assertion when docker isn't there.
    if (r.lookup.kind === 'no-image') {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/per-agent override image/);
    } else {
      expect(r.lookup.kind).toBe('inspect-error');
    }
  });
});

describe('agent runner image global CLI PATH', () => {
  it('keeps pnpm-installed CLIs visible to login shells and non-pnpm PATHs', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');
    const shimBlockIndex = dockerfile.indexOf('/etc/profile.d/nanoclaw-pnpm.sh');
    expect(shimBlockIndex).toBeGreaterThan(0);

    const globalInstallIndexes = [...dockerfile.matchAll(/pnpm install -g/g)].map((m) => m.index ?? -1);
    expect(globalInstallIndexes.length).toBeGreaterThan(0);
    expect(globalInstallIndexes.every((i) => i > 0 && i < shimBlockIndex)).toBe(true);

    expect(dockerfile).toContain('ENV PNPM_HOME="/pnpm"');
    expect(dockerfile).toContain('ENV PATH="$PNPM_HOME:$PATH"');
    expect(dockerfile).toContain('"export PNPM_HOME=/pnpm"');
    expect(dockerfile).toContain('export PATH=\\"/pnpm:\\$PATH\\"');
    expect(dockerfile).toContain('find /pnpm -maxdepth 1 -type f -perm /111');
    expect(dockerfile).toContain('/usr/local/bin/\\$(basename \\"\\$1\\")');
  });
});

describe('agent runner image Graphify runtime', () => {
  it('test_image_source_installs_ripgrep_for_agent_source_navigation', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');
    const finalImageStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM node:22-slim'));
    const systemPackages = finalImageStage.match(
      /apt-get update && apt-get install -y --no-install-recommends \\\n([\s\S]*?)\n\s*&& if \[ "\$INSTALL_CJK_FONTS"/,
    );

    expect(systemPackages).not.toBeNull();
    expect(systemPackages?.[1]).toMatch(/^\s*ripgrep\s*\\$/m);
  });

  it('test_image_source_retires_gitnexus_and_installs_private_graphify', async () => {
    const dockerfile = await readFile(path.join(REPO_ROOT, 'container/Dockerfile'), 'utf-8');

    for (const retiredSurface of [
      'GITNEXUS_VERSION',
      'gitnexus-builder',
      '/pnpm/gitnexus',
      '/opt/gitnexus-home',
      '.lbdb',
      'install-duckdb-extension.mjs',
      'only-built-dependencies[]=gitnexus',
      'only-built-dependencies[]=@ladybugdb/core',
      'only-built-dependencies[]=onnxruntime-node',
    ]) {
      expect(dockerfile).not.toContain(retiredSurface);
    }
    expect(dockerfile).not.toMatch(/\n\s*(?:make|g\+\+)\s*\\/);

    expect(dockerfile).toContain('python3 -m venv /opt/graphify');
    expect(dockerfile).toContain('COPY graphify-requirements.lock graphify-wheel-audit.json');
    expect(dockerfile).toContain('graphify-v0.9.16-nanoclaw.patch');
    expect(dockerfile).toContain('--require-hashes');
    expect(dockerfile).toContain('--only-binary=:all:');
    expect(dockerfile).toContain('--no-deps');
    expect(dockerfile).toContain('--no-index');
    expect(dockerfile).toContain('git apply --check');
    expect(dockerfile).toContain('git apply /opt/graphify/graphify-v0.9.16-nanoclaw.patch');
    expect(dockerfile).toContain('COPY graphify-gateway.py /usr/local/bin/graphify');
    expect(dockerfile).toContain('COPY graphify-worker.py /opt/graphify/graphify-worker.py');
    expect(dockerfile).toContain('rm -f /opt/graphify/bin/graphify');
    expect(dockerfile).not.toMatch(/ENV PATH=.*\/opt\/graphify\/bin/);
  });

  it('test_finished_image_probe_tracks_required_empty_asset_descriptor', async () => {
    const testSource = await readFile(path.join(REPO_ROOT, 'src/agent-runner-image-check.test.ts'), 'utf-8');
    const probeStart = testSource.lastIndexOf('const shellContract = String.raw`');
    const probeEnd = testSource.lastIndexOf('const imageOutput = run');
    expect(probeStart).toBeGreaterThan(0);
    expect(probeEnd).toBeGreaterThan(probeStart);

    const probe = testSource.slice(probeStart, probeEnd);
    expect(probe.match(/'assets': \[\],/g)).toHaveLength(1);

    const worker = await readFile(path.join(REPO_ROOT, 'container/graphify-worker.py'), 'utf-8');
    expect(worker).toContain('raw_assets = descriptor.get("assets")');
    expect(worker).toContain('raise WorkerValidationError("missing or invalid asset descriptor")');
  });

  it.runIf(process.env.NANOCLAW_RUN_IMAGE_CONTRACTS === '1')(
    'test_built_image_exposes_only_enforcing_graphify_cli',
    () => {
      const run = (args: string[]): string =>
        execFileSync('docker', args, {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

      const shellContract = String.raw`
set -eu
test "$(command -v rg)" = /usr/bin/rg
printf 'graphify source navigation\n' | rg -q 'source navigation'
test "$(command -v graphify)" = /usr/local/bin/graphify
test ! -e /opt/graphify/bin/graphify
case ":$PATH:" in *:/opt/graphify/bin:*) exit 91 ;; esac
! command -v graphify-worker
! /usr/bin/python3 -c 'import graphify'
test ! -e /pnpm/gitnexus
test ! -e /opt/gitnexus-home
test ! -e /home/node/.lbdb
! command -v gitnexus
test -z "$(find /opt /pnpm /usr/local/bin /home/node -iname '*gitnexus*' -print 2>/dev/null)"

rm -rf /workspace/.cache/graphify /workspace/.graphify-stage /run/nanoclaw-graphify
graphify --help >/tmp/graphify-help
graphify query --help >/tmp/graphify-query-help
graphify path -h >/tmp/graphify-path-help
graphify --version >/tmp/graphify-version
grep -q 'query TEXT' /tmp/graphify-help
cmp /tmp/graphify-help /tmp/graphify-query-help
cmp /tmp/graphify-help /tmp/graphify-path-help
grep -q '^nanoclaw-graphify 0.9.16$' /tmp/graphify-version
test ! -e /workspace/.cache/graphify
test ! -e /workspace/.graphify-stage
test ! -e /run/nanoclaw-graphify

mkdir -p /workspace/worktrees/topology-guard
git init -q /workspace/worktrees/topology-guard
printf 'needle = 1\n' >/workspace/worktrees/topology-guard/example.py
! (cd /workspace/worktrees/topology-guard && graphify query needle >/tmp/graphify-unsafe.out 2>/tmp/graphify-unsafe.err)
grep -q 'required Graphify runtime topology is unavailable' /tmp/graphify-unsafe.err
test ! -s /tmp/graphify-unsafe.out
test ! -e /workspace/.cache/graphify
test ! -e /workspace/.graphify-stage
test ! -e /run/nanoclaw-graphify
rm -rf /workspace/worktrees/topology-guard

! graphify extract . >/dev/null 2>&1
! graphify install >/dev/null 2>&1
! graphify watch >/dev/null 2>&1
! graphify mcp >/dev/null 2>&1
! graphify query needle --graph=/tmp/hostile.json >/dev/null 2>&1
! graphify query needle --out=/tmp/hostile >/dev/null 2>&1
! env GRAPHIFY_OUT=/tmp/hostile graphify query needle >/dev/null 2>&1

/opt/graphify/bin/python - <<'PY'
from importlib.metadata import distributions
import re
from pathlib import Path

canonical = lambda name: re.sub(r"[-_.]+", "-", name).lower()
locked = {}
for raw in Path('/opt/graphify/graphify-requirements.lock').read_text().splitlines():
    if not raw or raw.startswith('#'):
        continue
    name, rest = raw.split('==', 1)
    locked[canonical(name)] = rest.split()[0]
site = next(Path('/opt/graphify/lib').glob('python*/site-packages'))
installed = {
    canonical(dist.metadata['Name']): dist.version
    for dist in distributions(path=[str(site)])
    if canonical(dist.metadata['Name']) not in {'pip', 'setuptools'}
}
assert installed == locked, (installed, locked)
PY

rm -rf /tmp/graphify-real
mkdir -p /tmp/graphify-real/source-one/one /tmp/graphify-real/source-one/two
mkdir -p /tmp/graphify-real/source-two/one /tmp/graphify-real/source-two/two
printf 'def service_one():\n    return 1\n' >/tmp/graphify-real/source-one/one/service.py
printf 'def service_two():\n    return 2\n' >/tmp/graphify-real/source-one/two/service.py
cp -a /tmp/graphify-real/source-one/one/. /tmp/graphify-real/source-two/one/
cp -a /tmp/graphify-real/source-one/two/. /tmp/graphify-real/source-two/two/

/opt/graphify/bin/python - <<'PY'
import hashlib, json
from pathlib import Path

base = Path('/tmp/graphify-real')
def item(root, relative):
    raw = (root / relative).read_bytes()
    return {
        'path': relative,
        'sha256': hashlib.sha256(raw).hexdigest(),
        'md5': hashlib.md5(raw, usedforsecurity=False).hexdigest(),
        'bytes': len(raw),
        'graphify_hash': hashlib.sha256(raw + b'\0' + relative.lower().encode()).hexdigest(),
    }
for suffix in ('one', 'two'):
    root = base / f'source-{suffix}'
    descriptor = {
        'operation': 'extract',
        'graphify_version': '0.9.16',
        'source_root': str(root),
        'output_root': str(base / f'out-{suffix}'),
        'files': [item(root, 'one/service.py'), item(root, 'two/service.py')],
        'assets': [],
        'limits': {'address_space_bytes': 1073741824, 'file_bytes': 67108864, 'process_count': 0},
    }
    (base / f'extract-{suffix}.json').write_text(json.dumps(descriptor))
PY

/opt/graphify/bin/python /opt/graphify/graphify-worker.py /tmp/graphify-real/extract-one.json >/tmp/graphify-real/extract-one.out 2>/tmp/graphify-real/extract-one.err
mkdir -p /tmp/graphify-real/out-two/graphify-out/cache/ast/v0.9.16
cp -a /tmp/graphify-real/out-one/ast/. /tmp/graphify-real/out-two/graphify-out/cache/ast/v0.9.16/
/opt/graphify/bin/python /opt/graphify/graphify-worker.py /tmp/graphify-real/extract-two.json >/tmp/graphify-real/extract-two.out 2>/tmp/graphify-real/extract-two.err

/opt/graphify/bin/python - <<'PY'
import json
from pathlib import Path
base = Path('/tmp/graphify-real')
expected = ['one/service.py', 'two/service.py']
for suffix in ('one', 'two'):
    graph = json.loads((base / f'out-{suffix}' / 'graph.json').read_text())
    sources = sorted({node['source_file'] for node in graph['nodes'] if node.get('source_file')})
    assert sources == expected, sources
assert sorted(p.name for p in (base / 'out-one' / 'ast').glob('*.json')) == sorted(
    p.name for p in (base / 'out-two' / 'ast').glob('*.json')
)
query = {
    'operation': 'query', 'graphify_version': '0.9.16',
    'graph': str(base / 'out-two' / 'graph.json'),
    'command': 'query', 'arguments': ['service'],
    'limits': {'address_space_bytes': 1073741824, 'file_bytes': 67108864, 'process_count': 0},
}
(base / 'query.json').write_text(json.dumps(query))
PY
/opt/graphify/bin/python /opt/graphify/graphify-worker.py /tmp/graphify-real/query.json >/tmp/graphify-real/query.out 2>/tmp/graphify-real/query.err
grep -q 'service' /tmp/graphify-real/query.out
grep -q '"reason": "ok"' /tmp/graphify-real/extract-one.err
grep -q '"reason": "ok"' /tmp/graphify-real/extract-two.err
grep -q '"reason": "ok"' /tmp/graphify-real/query.err
echo IMAGE_GRAPHIFY_CONTRACT_OK
`;

      const imageOutput = run(['run', '--rm', '--entrypoint', '/bin/sh', CONTAINER_IMAGE, '-c', shellContract]);
      expect(imageOutput).toContain('IMAGE_GRAPHIFY_CONTRACT_OK');

      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? uid;
      const sourceContracts = [
        'container.tests.test_graphify_supply_chain.SupplyChainTest.test_offline_no_deps_install_contract',
        'container.tests.test_graphify_gateway.GatewayTest.test_gateway_help_and_version_are_side_effect_free',
        'container.tests.test_graphify_gateway.GatewayTest.test_gateway_runtime_topology_requires_exact_mounts_and_bounded_tmpfs',
        'container.tests.test_graphify_gateway.GatewayTest.test_gateway_query_fails_before_repository_access_without_runtime_topology',
        'container.tests.test_graphify_gateway.GatewayTest.test_gateway_main_enospc_is_concise_and_never_reads_stale_live',
        'container.tests.test_graphify_gateway.GatewayTest.test_gateway_timeout_terminates_refresh_and_query_process_groups',
        'container.tests.test_graphify_worker.WorkerTest.test_worker_kernel_refuses_memory_file_process_and_thread_growth',
        'container.tests.test_graphify_worker.WorkerTest.test_worker_duplicate_basenames_keep_relative_sources_and_portable_ast',
        'container.tests.test_graphify_worker.WorkerTest.test_worker_mcp_config_is_applicable_and_preserves_hidden_source_name',
        'container.tests.test_graphify_worker.WorkerTest.test_worker_task_guards_refuse_child_processes_and_threads',
      ];
      const testOutput = run([
        'run',
        '--rm',
        '--user',
        `${uid}:${gid}`,
        '--volume',
        `${REPO_ROOT}:/mnt/repo:ro`,
        '--workdir',
        '/mnt/repo',
        '--entrypoint',
        '/bin/sh',
        CONTAINER_IMAGE,
        '-c',
        `GRAPHIFY_WHEELHOUSE=/opt/graphify/wheelhouse /opt/graphify/bin/python -m unittest -v ${sourceContracts.join(' ')}`,
      ]);
      expect(testOutput).not.toContain('FAILED');
    },
    180_000,
  );
});

describe('Graphify container agent instructions', () => {
  it('test_graphify_skill_is_safe_and_automatic', async () => {
    const skill = await readFile(path.join(REPO_ROOT, 'container/skills/graphify/SKILL.md'), 'utf-8');

    expect(skill).toMatch(/^---\nname: graphify\ndescription:/);
    expect(skill).toContain('allowed-tools:');
    for (const command of ['query', 'path', 'explain', 'affected']) {
      expect(skill).toContain(`graphify ${command}`);
    }
    expect(skill).toMatch(/automatically reconciles current source before every (?:read|query)/i);
    expect(skill).toMatch(/source and tests are authoritative/i);
    expect(skill).toMatch(/inspect (?:the )?source directly/i);
    expect(skill).not.toMatch(/`graphify (?:extract|install|update|watch|mcp|serve|daemon|hook)\b/i);
    expect(skill).not.toMatch(/(?:run|perform|trigger) (?:a )?manual (?:refresh|index|extract)/i);
    expect(skill).not.toMatch(/--(?:out|graph|global)\b/);
  });

  it('test_environment_scoped_instructions_have_no_runtime_contradiction', async () => {
    const instructions = await readFile(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf-8');
    const codeIntelligence = instructions.slice(instructions.indexOf('## Code intelligence'));

    expect(codeIntelligence).toContain('NANOCLAW_CONTAINER=1');
    expect(codeIntelligence).toMatch(/container sessions[\s\S]*Graphify/i);
    expect(codeIntelligence).toMatch(/host\/operator sessions[\s\S]*GitNexus/i);
    expect(codeIntelligence).toMatch(/container sessions[\s\S]*do not apply[\s\S]*GitNexus/i);
    expect(codeIntelligence).toMatch(/Graphify[\s\S]*source and tests remain authoritative/i);
  });
});
