#!/usr/bin/env node
// generate-workstreams.mjs — build the workstream map by reading each agent
// group's container.json from a NanoClaw checkout.
//
//   node generate-workstreams.mjs [--groups <dir>] [--include-siblings]
//                                 [--teammate] [--describe]
//
// Default (operator mode): emits JSON { "<folder>": "<agentGroupId>", ... } —
// the launcher map for someone whose own vault already holds the host's agent
// identities (i.e. the person who runs the NanoClaw host).
//
// --teammate: emits { "<folder>": "<folder>", ... } — uses the folder NAME as
// the OneCLI identifier instead of the host's opaque agentGroupId. A teammate
// creates fresh agents in their OWN vault, so a self-documenting identifier
// ("madison-reed") beats reusing the host operator's internal id.
//
// --describe: emits a richer object keyed by folder:
//   { "<folder>": { "identifier": "...", "secrets": [...], "tools": [...] } }
// for the setup wizard to drive the per-workstream OAuth/secret walkthrough.
// Combine with --teammate to set identifier = folder. `secrets` is the group's
// declared onecliSecrets; `tools` is its tools list (both may be empty).
//
// By default *-codex and *-opencode sibling folders are excluded (those map to
// other providers; for local *Claude* you want the Claude/parent groups).
// Pass --include-siblings to keep them.
//
// The agentGroupId is the OneCLI agent identifier the host uses for that group
// (see src/container-runner.ts ensureAgent + onecli-secrets.ts), so under
// `onecli run --agent <id>` the same identity resolves the same selective
// secret set.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let groupsDir = null;
let includeSiblings = false;
let teammate = false;
let describe = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--groups') groupsDir = args[++i];
  else if (args[i] === '--include-siblings') includeSiblings = true;
  else if (args[i] === '--teammate') teammate = true;
  else if (args[i] === '--describe') describe = true;
}

// Default: ./groups relative to cwd (run from the NanoClaw repo root).
groupsDir = groupsDir || join(process.cwd(), 'groups');
if (!existsSync(groupsDir)) {
  console.error(`generate-workstreams: groups dir not found: ${groupsDir}`);
  console.error('Run from your NanoClaw repo root, or pass --groups <path>.');
  process.exit(1);
}

const simple = {};
const detailed = {};
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
  const agentGroupId = cfg.agentGroupId;
  if (!agentGroupId) {
    console.error(`generate-workstreams: skipping ${name} (no agentGroupId)`);
    continue;
  }
  // Teammates create fresh identities in their own vault, so the folder name is
  // the natural identifier. Operators reuse the host's existing agentGroupId.
  const identifier = teammate ? name : agentGroupId;
  simple[name] = identifier;
  detailed[name] = {
    identifier,
    secrets: Array.isArray(cfg.onecliSecrets) ? cfg.onecliSecrets : [],
    tools: Array.isArray(cfg.tools) ? cfg.tools : [],
  };
}

if (Object.keys(simple).length === 0) {
  console.error('generate-workstreams: no groups with agentGroupId found.');
  process.exit(1);
}

process.stdout.write(JSON.stringify(describe ? detailed : simple, null, 2) + '\n');
