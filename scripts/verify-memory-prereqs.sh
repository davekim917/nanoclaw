#!/usr/bin/env bash
set -euo pipefail

MNEMON_VERSION="0.1.2"
ERRORS=()

# 1. Ollama service active
if ! systemctl is-active --quiet ollama 2>/dev/null; then
  ERRORS+=("FAIL: ollama service is not active (run: sudo systemctl start ollama)")
fi

# 2. nomic-embed-text model pulled
if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
  ERRORS+=("FAIL: nomic-embed-text model not found (run: ollama pull nomic-embed-text)")
fi

# 3. mnemon binary version matches expected
MNEMON_BIN="${HOME}/.local/bin/mnemon"
if ! command -v mnemon &>/dev/null && [ ! -x "${MNEMON_BIN}" ]; then
  ERRORS+=("FAIL: mnemon binary not found in PATH or ~/.local/bin (expected version ${MNEMON_VERSION})")
else
  FOUND_VERSION=$(mnemon --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [ "${FOUND_VERSION}" != "${MNEMON_VERSION}" ]; then
    ERRORS+=("FAIL: mnemon version mismatch — expected ${MNEMON_VERSION}, got '${FOUND_VERSION}'")
  fi
fi

# 4. Disk free for ~/.mnemon: >= 1G available
MNEMON_DIR="${HOME}/.mnemon"
mkdir -p "${MNEMON_DIR}"
AVAIL_BYTES=$(df -B1 "${MNEMON_DIR}" | awk 'NR==2 {print $4}')
AVAIL_GB=$(( AVAIL_BYTES / 1073741824 ))
if [ "${AVAIL_GB}" -lt 1 ]; then
  ERRORS+=("FAIL: insufficient disk space at ~/.mnemon — ${AVAIL_GB}GB available, need >= 1GB")
fi

# 5. inotify max_user_watches >= 1024
MAX_WATCHES=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)
if [ "${MAX_WATCHES}" -lt 1024 ]; then
  ERRORS+=("FAIL: inotify max_user_watches=${MAX_WATCHES} is below 1024 (run: echo 65536 | sudo tee /proc/sys/fs/inotify/max_user_watches)")
fi

# 6. sqlite3 in PATH
if ! command -v sqlite3 &>/dev/null; then
  ERRORS+=("FAIL: sqlite3 not found in PATH (run: sudo apt-get install sqlite3)")
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "Memory prereq checks FAILED:" >&2
  for err in "${ERRORS[@]}"; do
    echo "  ${err}" >&2
  done
  exit 1
fi

echo "All memory prereq checks passed."
