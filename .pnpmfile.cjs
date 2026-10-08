// pnpm requires this file before any other work on every command (install, run, exec), which makes it the one
// place a refusal precedes the modules-directory purge: with CI=true, pnpm 10.34 empties a node_modules whose
// .modules.yaml disagrees with the project (everything but .pnpm) before it runs pnpm:devPreinstall or any other
// lifecycle script. pnpm resolves node_modules through a symlink and rewrites the target, so an install through
// a link rewrites another checkout's install. --ignore-pnpmfile skips this file, as it skips every pnpmfile.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Why `<root>/node_modules` must not be installed into, or null when it is absent or this project's own directory. */
function linkedModulesDir(root) {
  const modules = path.join(root, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(modules);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink()) return `it is a symlink to ${fs.readlinkSync(modules)}`;
  const resolved = fs.realpathSync(modules);
  const expected = path.join(fs.realpathSync(root), 'node_modules');
  return resolved === expected ? null : `it resolves to ${resolved}, outside this project`;
}

const reason = linkedModulesDir(__dirname);
if (reason) {
  throw new Error(
    `refusing to run pnpm against ${path.join(__dirname, 'node_modules')}: ${reason}. ` +
      "A worktree gets its own install: remove the link, then run 'pnpm install --frozen-lockfile --offline' here.",
  );
}

module.exports = {};
