#!/usr/bin/env bash

# Activate the exact Node executable that setup.sh validated in a child process.
# Callers run in parent shells, so setup.sh's PATH export cannot reach them.
activate_bootstrap_node() {
  local status_file="$1"
  local node_path node_dir node_version

  node_path=$(sed -n 's/^NODE_PATH: *//p' "$status_file" | head -1)
  if [ -z "$node_path" ] || [ "$node_path" = "not_found" ] || [ ! -x "$node_path" ]; then
    echo "Bootstrap did not report an executable Node path: ${node_path:-missing}" >&2
    return 1
  fi

  node_dir=$(dirname "$node_path")
  export PATH="$node_dir${PATH:+:$PATH}"
  hash -r 2>/dev/null || true

  node_version=$("$node_path" --version 2>/dev/null || true)
  if ! "$node_path" "$PROJECT_ROOT/scripts/check-node-version.mjs" "$node_version" >/dev/null 2>&1; then
    echo "Bootstrap Node runtime is unsupported: $node_path (${node_version:-unknown})" >&2
    return 1
  fi
}
