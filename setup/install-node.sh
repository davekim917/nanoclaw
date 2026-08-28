#!/usr/bin/env bash
# Setup helper: install-node — bundles Node 22 install into one idempotent
# script so /new-setup can run it without needing `curl | sudo -E bash -` in
# the allowlist (that pattern is inherently unmatchable — bash reads from
# stdin, so pre-approval can't inspect what's being executed).
#
# The script itself is the allowlisted unit; the pipes and sudo live inside
# it. Pure bash by design — runs before Node exists on the host.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH=""

echo "=== NANOCLAW SETUP: INSTALL_NODE ==="

if command -v node >/dev/null 2>&1; then
  NODE_PATH="$(command -v node)"
  NODE_VERSION="$("$NODE_PATH" --version 2>/dev/null | sed 's/^v//')"
  if "$NODE_PATH" "$PROJECT_ROOT/scripts/check-node-version.mjs" "$NODE_VERSION" >/dev/null 2>&1; then
    echo "STATUS: already-installed"
    echo "NODE_VERSION: v$NODE_VERSION"
    echo "NODE_PATH: $NODE_PATH"
    echo "=== END ==="
    exit 0
  fi
  echo "STEP: upgrade-node"
fi

if command -v uvx >/dev/null 2>&1; then
  echo "STEP: uvx-nodeenv"
  uvx nodeenv --force -n lts ~/node
  mkdir -p ~/.local/bin
  ln -sf ~/node/bin/node ~/.local/bin/node
  ln -sf ~/node/bin/npm ~/.local/bin/npm
  ln -sf ~/node/bin/npx ~/.local/bin/npx
  ln -sf ~/node/bin/pnpm ~/.local/bin/pnpm
  NODE_PATH="$HOME/.local/bin/node"
  export PATH="$HOME/.local/bin:$PATH"
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
      NODE_PATH="$(brew --prefix node@22)/bin/node"
      export PATH="$(dirname "$NODE_PATH"):$PATH"
      ;;
    Linux)
      echo "STEP: nodesource-setup"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      echo "STEP: apt-install-nodejs"
      sudo apt-get install -y nodejs
      NODE_PATH=""
      while IFS= read -r candidate; do
        if [[ "$candidate" == */bin/node ]] && [ -x "$candidate" ]; then
          NODE_PATH="$candidate"
          break
        fi
      done < <(dpkg-query -L nodejs)
      ;;
    *)
      echo "STATUS: failed"
      echo "ERROR: Unsupported platform: $(uname -s)"
      echo "=== END ==="
      exit 1
      ;;
  esac
fi

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  echo "STATUS: failed"
  echo "ERROR: installer did not report an executable Node path"
  echo "=== END ==="
  exit 1
fi

NODE_VERSION="$("$NODE_PATH" --version 2>/dev/null | sed 's/^v//')"
if ! "$NODE_PATH" "$PROJECT_ROOT/scripts/check-node-version.mjs" "$NODE_VERSION" >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: Node v$NODE_VERSION is below the required 22.19.0"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "NODE_VERSION: v$NODE_VERSION"
echo "NODE_PATH: $NODE_PATH"
echo "=== END ==="
