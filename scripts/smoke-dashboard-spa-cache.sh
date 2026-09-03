#!/usr/bin/env bash
#
# Manual smoke for the dashboard SPA build gate (scripts/build-dashboard-spa.ts).
#
# Runs `build:spa` three times and prints wall-clock for each:
#   1. cold      — cache miss, real `vite build`
#   2. warm      — cache hit, restore only (this is the deploy saving)
#   3. forced    — DASHBOARD_BUILD_FORCE=1, real `vite build` again
# then edits a source file and confirms the hash gate notices (4. dirty).
#
# NOT wired into CI on purpose: a GitHub runner has no `dashboard/node_modules`,
# so run 1 would pay the very `pnpm install --ignore-workspace` this gate exists
# to avoid, on every PR. The decision logic itself is covered by
# scripts/build-dashboard-spa.test.ts, which CI does run.
#
# Requires dashboard/node_modules (`pnpm --dir dashboard install`). Run from the
# repo root. Safe in a worktree; it only writes dist/ and data/build-cache/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BUNDLE=dist/dashboard-spa
CACHE=data/build-cache/dashboard-spa

if [ ! -d dashboard/node_modules ]; then
  echo "SKIP: dashboard/node_modules missing — run: pnpm --dir dashboard install" >&2
  exit 0
fi

step() { # step <label> <extra-env...>
  local label="$1"; shift
  rm -rf "$BUNDLE"                      # what scripts/deploy.sh's `rm -rf dist` does
  local start end
  start=$(date +%s.%N)
  env "$@" pnpm run build:spa > "/tmp/spa-smoke-$label.log" 2>&1
  end=$(date +%s.%N)
  printf '%-8s %6.1fs  %s\n' "$label" "$(echo "$end - $start" | bc)" \
    "$(grep -o 'cache hit [0-9a-f]*\|cache-miss [0-9a-f]*\|forced [0-9a-f]*' "/tmp/spa-smoke-$label.log" | head -1)"
  test -f "$BUNDLE/index.html" || { echo "FAIL($label): no $BUNDLE/index.html" >&2; exit 1; }
}

rm -rf "$CACHE"
step cold
step warm
step forced DASHBOARD_BUILD_FORCE=1

echo "-- cache entries: $(ls "$CACHE" | tr '\n' ' ')"

# A real source edit must miss, then revert must hit the still-cached bundle.
cp dashboard/src/main.tsx /tmp/spa-smoke-main.tsx.bak
printf '\n// smoke\n' >> dashboard/src/main.tsx
step dirty
cp /tmp/spa-smoke-main.tsx.bak dashboard/src/main.tsx
step revert

grep -q 'cache hit' /tmp/spa-smoke-warm.log   || { echo "FAIL: warm run rebuilt" >&2; exit 1; }
grep -q 'forced'    /tmp/spa-smoke-forced.log || { echo "FAIL: force did not rebuild" >&2; exit 1; }
grep -q 'cache-miss' /tmp/spa-smoke-dirty.log || { echo "FAIL: source edit did not invalidate" >&2; exit 1; }
grep -q 'cache hit' /tmp/spa-smoke-revert.log || { echo "FAIL: revert did not hit cache" >&2; exit 1; }
echo "PASS"
