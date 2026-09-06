#!/bin/sh
# Eligibility uses a dedicated non-match status. Runtime/load failures must not
# silently send a review through the original CLI without credential rotation.
bun /app/src/cli/claude-review.ts --nanoclaw-review-eligible "$@"
case $? in
  0) exec bun /app/src/cli/claude-review.ts --nanoclaw-review "$@" ;;
  64) exec /pnpm/claude-real "$@" ;;
  *) echo 'claude review launcher: unavailable' >&2; exit 2 ;;
esac
