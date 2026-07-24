#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const sourceDir = args.get('--source');
const memoryDir = args.get('--memory');
if (!sourceDir || !memoryDir) {
  throw new Error('Usage: migrate-auto-memory.mjs --source <staged-dir> --memory <memory-dir>');
}

const importedDir = path.join(memoryDir, 'imported', 'claude-auto');
if (fs.existsSync(importedDir)) {
  throw new Error(`Refusing to overwrite existing destination: ${importedDir}`);
}

for (const entry of walk(sourceDir)) {
  if (entry.kind === 'symlink' || entry.kind === 'special') {
    throw new Error(`Unsafe staged path (${entry.kind}): ${entry.path}`);
  }
  if (entry.kind === 'directory' && entry.path !== sourceDir) {
    throw new Error(`Nested staged directories require operator review: ${entry.path}`);
  }
}

const sourceFiles = fs
  .readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

const markdownFiles = sourceFiles.filter((name) => name.endsWith('.md'));
const omittedFiles = sourceFiles.filter((name) => name === '.consolidate-lock');
const unsupportedFiles = sourceFiles.filter((name) => !name.endsWith('.md') && name !== '.consolidate-lock');
if (unsupportedFiles.length > 0) {
  throw new Error(`Unsupported staged files require operator review: ${unsupportedFiles.join(', ')}`);
}

fs.mkdirSync(importedDir, { recursive: true });

const outcomes = [];
const concepts = [];
for (const name of markdownFiles) {
  const sourcePath = path.join(sourceDir, name);
  const destinationName = name === 'MEMORY.md' ? 'legacy-summary.md' : name;
  const destinationPath = path.join(importedDir, destinationName);
  const inferredType = inferType(name);
  const original = fs.readFileSync(sourcePath, 'utf8');
  const migrated = ensureTopLevelType(original, inferredType);
  fs.writeFileSync(destinationPath, migrated);
  concepts.push({ name: destinationName, type: inferredType });
  outcomes.push({
    source: sourcePath,
    destination: destinationPath,
    outcome: 'preserved-content-with-okf-type',
  });
}

const indexPath = path.join(importedDir, 'index.md');
fs.writeFileSync(indexPath, renderIndex(concepts));

const rootIndexPath = path.join(memoryDir, 'index.md');
const rootIndex = fs.readFileSync(rootIndexPath, 'utf8');
const link = '- [Imported Claude auto-memory](imported/claude-auto/index.md) - legacy durable notes preserved during the provider-neutral memory migration';
if (!rootIndex.includes('(imported/claude-auto/index.md)')) {
  fs.writeFileSync(rootIndexPath, `${rootIndex.trimEnd()}\n${link}\n`);
}

for (const name of omittedFiles) {
  outcomes.push({
    source: path.join(sourceDir, name),
    destination: null,
    outcome: 'omitted-runtime-lock-file',
  });
}

console.log(
  JSON.stringify(
    {
      sourceDir,
      importedDir,
      sourceFileCount: sourceFiles.length,
      migratedMarkdownCount: markdownFiles.length,
      omittedFiles,
      outcomes,
    },
    null,
    2,
  ),
);

function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      yield { kind: 'symlink', path: current };
      continue;
    }
    if (stat.isDirectory()) {
      yield { kind: 'directory', path: current };
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
      continue;
    }
    if (stat.isFile()) {
      yield { kind: 'file', path: current };
      continue;
    }
    yield { kind: 'special', path: current };
  }
}

function inferType(name) {
  if (name === 'MEMORY.md') return 'legacy-index';
  if (name === 'identity.md') return 'identity';
  if (name.startsWith('feedback_')) return 'feedback';
  if (name.startsWith('project_')) return 'project';
  if (name.startsWith('reference_')) return 'reference';
  if (name.startsWith('user_')) return 'person';
  return 'legacy-memory';
}

function ensureTopLevelType(content, inferredType) {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return `---\ntype: ${inferredType}\n---\n\n${normalized}`;
  }

  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) return `---\ntype: ${inferredType}\n---\n\n${normalized}`;

  const frontmatter = normalized.slice(4, end).split('\n');
  const existingTypeIndex = frontmatter.findIndex((line) => /^type:\s*\S/.test(line));
  const typeLine = existingTypeIndex >= 0 ? frontmatter.splice(existingTypeIndex, 1)[0] : `type: ${inferredType}`;
  return `---\n${typeLine}\n${frontmatter.join('\n')}\n---\n${normalized.slice(end + 5)}`;
}

function renderIndex(concepts) {
  const groups = new Map();
  for (const concept of concepts) {
    if (!groups.has(concept.type)) groups.set(concept.type, []);
    groups.get(concept.type).push(concept.name);
  }

  const lines = [
    '# Imported Claude Auto-Memory',
    '',
    'Legacy durable note content preserved with normalized OKF metadata during the provider-neutral memory migration.',
    'Each concept has a top-level OKF `type`; the original staged directory remains the rollback copy until operator approval.',
    '',
  ];
  for (const [type, names] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${titleCase(type)}`, '');
    for (const name of names.sort()) lines.push(`- [${titleCase(path.basename(name, '.md'))}](${name})`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function titleCase(value) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
