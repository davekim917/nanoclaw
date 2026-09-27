# Sourced by a long shell suite that marks its independent cases:
#
#   if smoke_case <name>; then ...; fi      # a block at the top level
#   smoke_case "<name>" || continue         # first in a top-level loop's body
#   smoke_cases_done                        # after the last case
#
# Never inside another case: every process must reach the same smoke_case
# calls in the same order, whichever cases it skips.
#
# smoke_case answers whether this process runs the named case.
#   SMOKE_CASE=<glob>   only the cases whose name matches (a glob matching no
#                       case fails the suite, so a typo never passes green);
#   SMOKE_SHARD=<k>/<n> every n-th case starting at the k-th, so n processes
#                       with k=1..n together run each case exactly once.
# With neither set every case runs, in order, as one process. Both filters
# skip cases, so a case may use only what code outside every case sets up and
# what it builds itself: prove a new case with SMOKE_CASE=<its name> alone.
# SMOKE_CASE_LOG=<file> appends the name of each case this process runs.
SMOKE_CASE_SEQ=0
SMOKE_CASE_RAN=0
if [ -n "${SMOKE_SHARD:-}" ]; then
  case "$SMOKE_SHARD" in
    */*) ;;
    *) echo "SMOKE_SHARD must be <k>/<n>, got: $SMOKE_SHARD" >&2; exit 2 ;;
  esac
  SMOKE_SHARD_K="${SMOKE_SHARD%/*}" SMOKE_SHARD_N="${SMOKE_SHARD#*/}"
  if ! [[ "$SMOKE_SHARD_K" =~ ^[1-9][0-9]*$ && "$SMOKE_SHARD_N" =~ ^[1-9][0-9]*$ ]] ||
    [ "$SMOKE_SHARD_K" -gt "$SMOKE_SHARD_N" ]; then
    echo "SMOKE_SHARD must be <k>/<n> with 1 <= k <= n, got: $SMOKE_SHARD" >&2
    exit 2
  fi
fi

smoke_case() { # <name>
  SMOKE_CASE_SEQ=$((SMOKE_CASE_SEQ + 1))
  # shellcheck disable=SC2053
  if [ -n "${SMOKE_CASE:-}" ] && [[ "$1" != $SMOKE_CASE ]]; then return 1; fi
  if [ -n "${SMOKE_SHARD:-}" ] && [ $(((SMOKE_CASE_SEQ - 1) % SMOKE_SHARD_N + 1)) != "$SMOKE_SHARD_K" ]; then
    return 1
  fi
  SMOKE_CASE_RAN=$((SMOKE_CASE_RAN + 1))
  [ -z "${SMOKE_CASE_LOG:-}" ] || printf '%s\n' "$1" >>"$SMOKE_CASE_LOG"
  return 0
}

smoke_cases_done() {
  if [ -n "${SMOKE_CASE:-}" ] && [ "$SMOKE_CASE_RAN" = 0 ]; then
    echo "SMOKE_CASE=$SMOKE_CASE matched none of the $SMOKE_CASE_SEQ cases" >&2
    exit 1
  fi
}
