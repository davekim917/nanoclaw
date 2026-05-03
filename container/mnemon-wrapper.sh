#!/usr/bin/env bash
# Mnemon CLI wrapper — write locking, store-arg discipline, MNEMON_READ_ONLY gate.
# Installed at /usr/local/bin/mnemon (symlink → this file); real binary at /usr/local/bin/mnemon-real.
set -euo pipefail

STORE="${MNEMON_STORE:-default}"

# Reject malformed STORE values. Defends against (a) jq filter injection,
# (b) path traversal via `..` segments in the lock-file mkdir, and
# (c) printf format-string corruption. Agent group IDs follow `ag-<digits>-<alnum>`;
# this regex permits that and any reasonable test store value.
if [[ ! "$STORE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "mnemon-wrapper: invalid MNEMON_STORE value: '${STORE}'" >&2
  exit 2
fi

SUBCOMMAND="${1:-}"

# `gc` is dual-mode: default suggest mode reads the store and lists candidates,
# while `--keep` boosts an insight's retention (a write). Detect once and reuse
# below for both the read-only gate and the dispatch path.
GC_IS_WRITE=0
if [[ "$SUBCOMMAND" == "gc" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "--keep" || "$arg" == --keep=* ]]; then
      GC_IS_WRITE=1
      break
    fi
  done
fi

# MNEMON_READ_ONLY=1: reject write subcommands so daemon-only writes are enforced.
# Read-path subcommands (recall, status, gc-suggest, etc.) pass through unaffected.
if [[ "${MNEMON_READ_ONLY:-}" == "1" ]]; then
  case "$SUBCOMMAND" in
    remember|forget|link|embed|store|setup)
      echo "mnemon-wrapper: write subcommand '${SUBCOMMAND}' is rejected in read-only mode (MNEMON_READ_ONLY=1)" >&2
      exit 2
      ;;
  esac
  if [[ "$SUBCOMMAND" == "gc" && "$GC_IS_WRITE" == "1" ]]; then
    echo "mnemon-wrapper: 'gc --keep' is rejected in read-only mode (MNEMON_READ_ONLY=1); 'mnemon gc' suggest mode is allowed" >&2
    exit 2
  fi
fi

# Reject any user-supplied --store argument that doesn't match MNEMON_STORE. Combined with the
# host-side mount narrowing (only this group's data dir is mounted into the container), cross-
# tenant access is blocked at both filesystem and argument-parsing levels.
prev=""
for arg in "$@"; do
  case "$arg" in
    --store=*)
      requested="${arg#--store=}"
      if [[ "$requested" != "$STORE" ]]; then
        echo "mnemon-wrapper: --store='${requested}' does not match MNEMON_STORE='${STORE}'; rejected" >&2
        exit 2
      fi
      ;;
  esac
  if [[ "$prev" == "--store" && "$arg" != "$STORE" ]]; then
    echo "mnemon-wrapper: --store '${arg}' does not match MNEMON_STORE='${STORE}'; rejected" >&2
    exit 2
  fi
  prev="$arg"
done

# flock timeout (seconds). 30s lets real writes complete while bounding stale-lock hangs.
FLOCK_TIMEOUT=30

case "$SUBCOMMAND" in
  recall|search|related)
    exec /usr/local/bin/mnemon-real "$@"
    ;;

  gc)
    if [[ "$GC_IS_WRITE" == "1" ]]; then
      LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
      mkdir -p "$(dirname "$LOCK_PATH")"
      if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" /usr/local/bin/mnemon-real "$@"; then
        rc=$?
        if [[ "$rc" == "1" ]]; then
          echo "mnemon-wrapper: flock timeout after ${FLOCK_TIMEOUT}s on ${LOCK_PATH}" >&2
        fi
        exit "$rc"
      fi
    else
      exec /usr/local/bin/mnemon-real "$@"
    fi
    ;;

  remember|link|forget|embed)
    LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
    mkdir -p "$(dirname "$LOCK_PATH")"
    if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" /usr/local/bin/mnemon-real "$@"; then
      rc=$?
      if [[ "$rc" == "1" ]]; then
        echo "mnemon-wrapper: flock timeout after ${FLOCK_TIMEOUT}s on ${LOCK_PATH}" >&2
      fi
      exit "$rc"
    fi
    ;;

  store|setup)
    # Admin commands: locked via flock with same timeout.
    LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
    mkdir -p "$(dirname "$LOCK_PATH")"
    if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" /usr/local/bin/mnemon-real "$@"; then
      rc=$?
      if [[ "$rc" == "1" ]]; then
        echo "mnemon-wrapper: flock timeout after ${FLOCK_TIMEOUT}s on ${LOCK_PATH}" >&2
      fi
      exit "$rc"
    fi
    ;;

  status|viz|version|help|""|--version|--help)
    exec /usr/local/bin/mnemon-real "$@"
    ;;

  *)
    echo "mnemon-wrapper: unrecognized subcommand '${SUBCOMMAND}'" >&2
    exit 2
    ;;
esac
