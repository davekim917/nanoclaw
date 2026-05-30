#!/usr/bin/env node
// generate-workstreams.mjs — build the workstream -> OneCLI-identity map by
// reading each agent group's container.json from a NanoClaw checkout.
//
//   node generate-workstreams.mjs [--groups <dir>] [--include-siblings]
//
// Emits JSON on stdout: { "<folder>": "<agentGroupId>", ... }
// By default, *-codex and *-opencode sibling folders are excluded (those map to
// other providers; for local *Claude* you want the Claude/parent groups). Pass
// --include-siblings to keep them.
//
// The agentGroupId is the OneCLI agent identifier the host uses for that group
// (see src/container-runner.ts ensureAgent + onecli-secrets.ts), so the same
// identity resolves the same selective secret set under `onecli run --agent`.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let groupsDir = null;
let includeSiblings = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--groups') groupsDir = args[++i];
  else if (args[i] === '--include-siblings') includeSiblings = true;
}

// Default: ./groups relative to cwd (run from the NanoClaw repo root).
groupsDir = groupsDir || join(process.cwd(), 'groups');
if (!existsSync(groupsDir)) {
  console.error(`generate-workstreams: groups dir not found: ${groupsDir}`);
  console.error('Run from your NanoClaw repo root, or pass --groups <path>.');
  process.exit(1);
}

const map = {};
for (const folder of readdirSync(groupsDir, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const name = folder.name;
  if (!includeSiblings && (/-codex$/.test(name) || /-opencode$/.test(name))) continue;
  const cfgPath = join(groupsDir, name, 'container.json');
  if (!existsSync(cfgPath)) continue;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`generate-workstreams: skipping ${name} (bad JSON: ${e.message})`);
    continue;
  }
  const id = cfg.agentGroupId;
  if (!id) {
    console.error(`generate-workstreams: skipping ${name} (no agentGroupId)`);
    continue;
  }
  map[name] = id;
}

if (Object.keys(map).length === 0) {
  console.error('generate-workstreams: no groups with agentGroupId found.');
  process.exit(1);
}

process.stdout.write(JSON.stringify(map, null, 2) + '\n');
