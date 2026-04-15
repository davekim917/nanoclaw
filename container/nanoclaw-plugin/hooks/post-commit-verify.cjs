#!/usr/bin/env node
/**
 * Post-Commit Blast Radius Verification Hook
 *
 * PostToolUse — fires after `git commit`, analyzes what changed using
 * GitNexus impact analysis, and injects a verification checklist as
 * context so the agent knows what to test.
 *
 * Works in both host Claude Code sessions and container agents (via
 * the gitnexus plugin hooks.json).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_SYMBOLS = 15;
const TIMEOUT_BUDGET_MS = 25000; // leave 5s headroom from the 30s hook timeout

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return {};
  }
}

function findGitNexusDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getRepoName(gitnexusDir) {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(gitnexusDir, 'meta.json'), 'utf-8'),
    );
    return meta.repoName || path.basename(path.dirname(gitnexusDir));
  } catch {
    return path.basename(path.dirname(gitnexusDir));
  }
}

let _gitnexusOnPath = null;
function isGitNexusOnPath() {
  if (_gitnexusOnPath === null) {
    try {
      const which = spawnSync('which', ['gitnexus'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      _gitnexusOnPath = which.status === 0;
    } catch {
      _gitnexusOnPath = false;
    }
  }
  return _gitnexusOnPath;
}

function runGitNexusCli(args, cwd, timeout) {
  if (isGitNexusOnPath()) {
    return spawnSync('gitnexus', args, {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawnSync('npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Extract function/class names from git diff @@ context headers.
 * Lines like: @@ -100,5 +100,7 @@ function buildMcpServers(tools)
 */
function extractSymbolsFromDiff(cwd) {
  const result = spawnSync(
    'git',
    ['diff', 'HEAD~1', '-p', '--diff-filter=AMCR'],
    { encoding: 'utf-8', timeout: 5000, cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) return [];

  const symbols = new Set();
  const lines = (result.stdout || '').split('\n');

  for (const line of lines) {
    const contextMatch = line.match(
      /^@@.*@@\s+(?:(?:export\s+)?(?:async\s+)?function\s+|(?:export\s+)?class\s+|(?:export\s+)?(?:const|let|var)\s+)(\w+)/,
    );
    if (contextMatch && contextMatch[1].length >= 3) {
      symbols.add(contextMatch[1]);
    }

    // Match added/modified function declarations in the diff itself
    const declMatch = line.match(
      /^[+-]\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    );
    if (declMatch && declMatch[1].length >= 3 && !line.startsWith('---') && !line.startsWith('+++')) {
      symbols.add(declMatch[1]);
    }

    // Match class declarations
    const classMatch = line.match(/^[+-]\s*(?:export\s+)?class\s+(\w+)/);
    if (classMatch && classMatch[1].length >= 3 && !line.startsWith('---') && !line.startsWith('+++')) {
      symbols.add(classMatch[1]);
    }
  }

  return [...symbols].slice(0, MAX_SYMBOLS);
}

function getChangedFiles(cwd) {
  const result = spawnSync('git', ['diff', 'HEAD~1', '--name-only'], {
    encoding: 'utf-8',
    timeout: 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return [];
  return (result.stdout || '').trim().split('\n').filter(Boolean);
}

function getCommitInfo(cwd) {
  const result = spawnSync(
    'git',
    ['log', '-1', '--format=%h %s'],
    { encoding: 'utf-8', timeout: 3000, cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return (result.stdout || '').trim();
}

/**
 * Run impact analysis on a single symbol.
 * Returns { symbol, risk, dependents: [{ name, file, depth, relation }] }
 */
function analyzeSymbol(symbol, repoName, cwd) {
  const result = runGitNexusCli(
    ['impact', symbol, '-d', 'upstream', '--depth', '2', '-r', repoName],
    cwd,
    7000,
  );
  if (result.status !== 0) return null;

  try {
    const data = JSON.parse(result.stdout || '');
    if (!data || data.impactedCount === 0) return null;

    const dependents = [];
    for (const [depth, items] of Object.entries(data.byDepth || {})) {
      for (const item of items || []) {
        dependents.push({
          name: item.name,
          file: item.filePath || '',
          depth: parseInt(depth, 10),
          relation: item.relationType || (item.edges || []).map((e) => e.type).join(', ') || 'unknown',
        });
      }
    }

    return {
      symbol,
      risk: data.risk || 'UNKNOWN',
      dependents,
      affectedProcesses: data.affected_processes || [],
    };
  } catch {
    return null;
  }
}

/**
 * Build a Markdown verification checklist from impact results.
 */
function buildChecklist(commitInfo, changedFiles, results) {
  // Determine overall risk
  const risks = results.map((r) => r.risk);
  const overallRisk = risks.includes('CRITICAL')
    ? 'CRITICAL'
    : risks.includes('HIGH')
      ? 'HIGH'
      : risks.includes('MEDIUM')
        ? 'MEDIUM'
        : 'LOW';

  const lines = [];
  lines.push(`## Post-Commit Verification (Risk: ${overallRisk})`);
  lines.push('');
  lines.push(`Commit: ${commitInfo}`);
  lines.push(`Changed: ${changedFiles.length} file(s), ${results.length} symbol(s) analyzed`);

  // Collect all d=1 and d=2 dependents across all symbols
  const d1 = new Map(); // key: name, value: { file, relations, sources }
  const d2 = new Map();

  for (const result of results) {
    for (const dep of result.dependents) {
      const map = dep.depth === 1 ? d1 : d2;
      const key = dep.name;
      if (!map.has(key)) {
        map.set(key, { file: dep.file, relations: new Set(), sources: new Set() });
      }
      map.get(key).relations.add(dep.relation);
      map.get(key).sources.add(result.symbol);
    }
  }

  if (d1.size > 0) {
    lines.push('');
    lines.push('### MUST VERIFY (d=1 — direct dependents, WILL BREAK if contract changed)');
    for (const [name, info] of d1) {
      const rel = [...info.relations].join(', ');
      const src = [...info.sources].join(', ');
      const file = info.file ? ` in ${info.file}` : '';
      lines.push(`- [ ] \`${name}\`${file} [${rel} ${src}]`);
    }
  }

  if (d2.size > 0) {
    lines.push('');
    lines.push('### SHOULD TEST (d=2 — indirect dependents)');
    for (const [name, info] of [...d2].slice(0, 10)) {
      const file = info.file ? ` in ${info.file}` : '';
      lines.push(`- [ ] \`${name}\`${file}`);
    }
    if (d2.size > 10) {
      lines.push(`- ... and ${d2.size - 10} more`);
    }
  }

  // Collect affected execution flows
  const processes = new Set();
  for (const result of results) {
    for (const p of result.affectedProcesses) {
      processes.add(p.name || p);
    }
  }
  if (processes.size > 0) {
    lines.push('');
    lines.push('### Affected Execution Flows');
    for (const p of processes) {
      lines.push(`- ${p}`);
    }
  }

  if (d1.size === 0 && d2.size === 0) {
    lines.push('');
    lines.push('No upstream dependents found — changes appear self-contained.');
  }

  return lines.join('\n');
}

function main() {
  const startTime = Date.now();

  try {
    const input = readInput();
    if ((input.hook_event_name || '') !== 'PostToolUse') return;
    if ((input.tool_name || '') !== 'Bash') return;

    const command = (input.tool_input || {}).command || '';
    if (!/\bgit\s+(commit)(\s|$)/.test(command)) return;

    // Only proceed if the command succeeded
    const toolOutput = input.tool_output || {};
    if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

    const cwd = input.cwd || process.cwd();
    if (!path.isAbsolute(cwd)) return;

    const gitnexusDir = findGitNexusDir(cwd);
    if (!gitnexusDir) return;

    // Check HEAD~1 exists (not initial commit)
    const parentCheck = spawnSync('git', ['rev-parse', 'HEAD~1'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (parentCheck.status !== 0) return;

    const repoName = getRepoName(gitnexusDir);
    const commitInfo = getCommitInfo(cwd);
    const changedFiles = getChangedFiles(cwd);
    if (changedFiles.length === 0) return;

    const symbols = extractSymbolsFromDiff(cwd);
    if (symbols.length === 0) return;

    // Run impact analysis for each symbol, respecting timeout budget
    const results = [];
    for (const symbol of symbols) {
      if (Date.now() - startTime > TIMEOUT_BUDGET_MS) {
        break;
      }
      const impact = analyzeSymbol(symbol, repoName, cwd);
      if (impact) results.push(impact);
    }

    if (results.length === 0) return;

    const checklist = buildChecklist(commitInfo, changedFiles, results);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: checklist,
        },
      }),
    );
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error(
        'Post-commit verify hook error:',
        (err.message || '').slice(0, 200),
      );
    }
  }
}

main();
