#!/usr/bin/env bash
# Setup helper: install-node — bundles Node 22 install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

# Floor is the highest node:22.x requirement any locked dependency declares
# (eslint@10 / eslint-visitor-keys@5 need ^22.13.0; vite@8 needs >=22.12.0).
# Must match package.json's engines.node and setup.sh's NODE_MIN_VERSION;
# bump all three together.
NODE_MIN_VERSION="22.13.0"

# Returns success if dotted numeric version $1 >= $2 (e.g. "22.13.0" >= "22.13.0").
version_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i x y
  for i in 0 1 2; do
    x=${a[i]:-0}
    y=${b[i]:-0}
    if [ "$x" -gt "$y" ] 2>/dev/null; then return 0; fi
    if [ "$x" -lt "$y" ] 2>/dev/null; then return 1; fi
  done
  return 0
}

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

if command -v node >/dev/null 2>&1; then
  EXISTING_VERSION=$(node --version | sed 's/^v//')
  if version_ge "$EXISTING_VERSION" "$NODE_MIN_VERSION" 2>/dev/null; then
    echo "STATUS: already-installed"
    echo "NODE_VERSION: $(node --version)"
    echo "=== END ==="
    exit 0
  fi
  echo "STEP: existing-node-too-old (found $(node --version), need >=${NODE_MIN_VERSION} — upgrading)"
fi

if command -v uvx >/dev/null 2>&1; then
  echo "STEP: uvx-nodeenv"
  uvx nodeenv -n lts ~/node
  mkdir -p ~/.local/bin
  ln -sf ~/node/bin/node ~/.local/bin/node
  ln -sf ~/node/bin/npm ~/.local/bin/npm
  ln -sf ~/node/bin/npx ~/.local/bin/npx
  ln -sf ~/node/bin/pnpm ~/.local/bin/pnpm
else
  case "$(uname -s)" in
    Darwin)
      echo "STEP: brew-install-node"
      if ! command -v brew >/dev/null 2>&1; then
        echo "STATUS: failed"
        echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
        echo "=== END ==="
        exit 1
      fi
      brew install node@22
      ;;
    Linux)
      echo "STEP: nodesource-setup"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      echo "STEP: apt-install-nodejs"
      sudo apt-get install -y nodejs
      ;;
    *)
      echo "STATUS: failed"
      echo "ERROR: Unsupported platform: $(uname -s)"
      echo "=== END ==="
      exit 1
      ;;
  esac
fi

if ! command -v node >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: node not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

# `command -v node` finding a binary isn't enough — if an older node earlier
# on PATH shadows the one just installed (uvx: ~/.local/bin not ahead of
# /usr/bin; brew: node@22 is keg-only and not linked), this would otherwise
# report success while `node --version` still prints the old major.
FINAL_VERSION=$(node --version | sed 's/^v//')
if ! version_ge "$FINAL_VERSION" "$NODE_MIN_VERSION" 2>/dev/null; then
  echo "STATUS: failed"
  echo "ERROR: node on PATH is still v${FINAL_VERSION} (need >=${NODE_MIN_VERSION}) — an older node is shadowing the new install. Open a new shell, or fix PATH directly: uvx installs put it at ~/.local/bin/node (put that ahead of $(command -v node)); Homebrew's node@22 is keg-only — run 'brew link --force node@22' or prepend \"\$(brew --prefix node@22)/bin\" to PATH."
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: $(node --version)"
echo "=== END ==="
