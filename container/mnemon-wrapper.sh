#!/usr/bin/env bash
# Mnemon CLI wrapper — phase gating, write locking, store-arg discipline, observability.
# Installed at /usr/local/bin/mnemon (symlink → this file); real binary at /usr/local/bin/mnemon-real.
set -euo pipefail

ROLLOUT_FILE="/workspace/agent/.mnemon-rollout.json"
METRICS_FILE="/workspace/agent/.mnemon-metrics.jsonl"
STORE="${MNEMON_STORE:-default}"

# Reject malformed STORE values. Defends against (a) jq filter injection in the phase lookup
# below, (b) path traversal via `..` segments in the lock-file mkdir, and (c) printf
# format-string corruption in metric emission. Agent group IDs follow `ag-<digits>-<alnum>`;
# this regex permits that and any reasonable test store value.
if [[ ! "$STORE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "mnemon-wrapper: invalid MNEMON_STORE value: '${STORE}'" >&2
  exit 2
fi

# Resolve phase per-store from rollout JSON. jq --arg keeps STORE outside the filter syntax
# tree (defense in depth — STORE is already validated above).
if [[ -f "$ROLLOUT_FILE" ]]; then
  PHASE=$(jq -r --arg s "$STORE" '.[$s].phase // "shadow"' "$ROLLOUT_FILE" 2>/dev/null || echo "shadow")
else
  PHASE="shadow"
fi

# Validate phase value — anything unexpected fails closed to shadow (cycle 3 F3).
# `unhealthy` is treated like shadow so an operator-marked unhealthy store doesn't serve recall.
case "$PHASE" in
  shadow|live) ;;
  unhealthy) PHASE="shadow" ;;
  *) PHASE="shadow" ;;
esac

SUBCOMMAND="${1:-}"

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

emit_metric() {
  local event_type="$1"
  local extra="${2:-}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  # All variables interpolated below have been validated. STORE is regex-checked above;
  # SUBCOMMAND is bound to a case statement; PHASE is enum-validated. Format-string
  # injection therefore cannot occur via these fields.
  printf '{"ts":"%s","event_type":"%s","subcommand":"%s","phase":"%s","store":"%s"%s}\n' \
    "$ts" "$event_type" "$SUBCOMMAND" "$PHASE" "$STORE" "$extra" \
    >> "$METRICS_FILE" 2>/dev/null || true
}

# flock timeout (seconds). 30s lets real writes complete while bounding stale-lock hangs.
FLOCK_TIMEOUT=30

case "$SUBCOMMAND" in
  recall|search|related)
    if [[ "$PHASE" == "live" ]]; then
      emit_metric "turn"
      exec /usr/local/bin/mnemon-real "$@"
    else
      # Shadow phase: block recall — return empty results without hitting binary.
      emit_metric "turn"
      printf '{"results":[]}\n'
      exit 0
    fi
    ;;

  remember|link|forget|embed|gc)
    emit_metric "turn"
    LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
    mkdir -p "$(dirname "$LOCK_PATH")"
    if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" /usr/local/bin/mnemon-real "$@"; then
      rc=$?
      if [[ "$rc" == "1" ]]; then
        emit_metric "unhealthy" ',"reason":"flock-timeout"'
        echo "mnemon-wrapper: flock timeout after ${FLOCK_TIMEOUT}s on ${LOCK_PATH}" >&2
      fi
      exit "$rc"
    fi
    ;;

  store|setup)
    # Admin commands: audited, locked via flock with same timeout.
    emit_metric "turn"
    LOCK_PATH="${HOME}/.mnemon/data/${STORE}/.write.lock"
    mkdir -p "$(dirname "$LOCK_PATH")"
    if ! flock -w "$FLOCK_TIMEOUT" "$LOCK_PATH" /usr/local/bin/mnemon-real "$@"; then
      rc=$?
      if [[ "$rc" == "1" ]]; then
        emit_metric "unhealthy" ',"reason":"flock-timeout"'
        echo "mnemon-wrapper: flock timeout after ${FLOCK_TIMEOUT}s on ${LOCK_PATH}" >&2
      fi
      exit "$rc"
    fi
    ;;

  status|viz|version|help|""|--version|--help)
    emit_metric "turn"
    exec /usr/local/bin/mnemon-real "$@"
    ;;

  *)
    emit_metric "unhealthy" ',"reason":"unknown-subcommand"'
    echo "mnemon-wrapper: unknown subcommand: ${SUBCOMMAND}" >&2
    exit 2
    ;;
esac
