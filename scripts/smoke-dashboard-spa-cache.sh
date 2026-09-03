#!/usr/bin/env bash
#
# Manual smoke for the dashboard SPA build gate (scripts/build-dashboard-spa.ts).
#
# Exercises both entry points, because they have different cache rights:
#   build:dashboard (--install) installs from the lockfile, so it may seed the cache
#   build:spa       (no install) may READ the cache but never write to it
# Both run the same build, so every cached bundle is a typechecked bundle.
#
# Sequence: cold miss -> warm hit -> forced rebuild -> input change misses ->
# revert hits -> the no-install path reads the cache -> with the cache emptied
# the no-install path builds WITHOUT seeding it -> a type error fails the
# install path instead of being cached.
#
# NOT wired into CI on purpose: a GitHub runner has no `dashboard/node_modules`,
# so the cold run would pay the very install this gate exists to avoid, on every
# PR. The decision logic itself is covered by scripts/build-dashboard-spa.test.ts,
# which CI does run.
#
# Requires dashboard/node_modules (`pnpm --dir dashboard install`). Run from the
# repo root. Never modifies a tracked file: hash changes come from a scratch file
# the exit trap removes, so an interrupted or failing run leaves a clean tree.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BUNDLE=dist/dashboard-spa
CACHE=data/build-cache/dashboard-spa
PROBE=dashboard/.smoke-probe          # git-visible (so it moves the hash), outside tsconfig's include
# Not a dotfile: tsconfig's `src/**/*` glob does not match paths starting with a
# dot, so a dot-named probe would never be typechecked and this assertion would
# pass vacuously.
BADTS=dashboard/src/smoke-bad-type.ts

# Registered BEFORE anything is created: `set -e` must not be able to exit
# between a write and its cleanup.
cleanup() { rm -f "$PROBE" "$BADTS"; }
trap cleanup EXIT HUP INT TERM

if [ ! -d dashboard/node_modules ]; then
  echo "SKIP: dashboard/node_modules missing — run: pnpm --dir dashboard install" >&2
  exit 0
fi

step() { # step <label> <script> [extra-env...]
  local label="$1" script="$2"; shift 2
  rm -rf "$BUNDLE"                      # what scripts/deploy.sh's `rm -rf dist` does
  local start end
  start=$(date +%s.%N)
  env "$@" pnpm run "$script" > "/tmp/spa-smoke-$label.log" 2>&1
  end=$(date +%s.%N)
  printf '%-9s %-16s %6.1fs  %s\n' "$label" "$script" "$(echo "$end - $start" | bc)" \
    "$(grep -oE 'cache hit [0-9a-f]+|cache-miss [0-9a-f]+|forced [0-9a-f]+|not cached.*' "/tmp/spa-smoke-$label.log" | head -1)"
}

expect() { grep -q "$2" "/tmp/spa-smoke-$1.log" || { echo "FAIL($1): expected '$2'" >&2; exit 1; }; }

rm -rf "$CACHE"
step cold   build:dashboard
step warm   build:dashboard
step forced build:dashboard DASHBOARD_BUILD_FORCE=1
test -f "$BUNDLE/index.html" || { echo "FAIL: no bundle after the install path" >&2; exit 1; }

# A changed input must miss; removing it again must hit the still-cached bundle.
echo 'smoke' > "$PROBE"
step dirty  build:dashboard
rm -f "$PROBE"
step revert build:dashboard

# The no-install path reads the cache...
step devhit build:spa
test -f "$BUNDLE/index.html" || { echo "FAIL: no bundle after the dev path" >&2; exit 1; }

# ...but must never write to it, or the deploy's build:spa call would seed a
# bundle built against the previous deploy's node_modules and the later
# build:dashboard --install would skip the frozen install on that hit.
rm -rf "$CACHE"
step devmiss build:spa
if [ -d "$CACHE" ] && [ -n "$(ls -A "$CACHE" 2>/dev/null)" ]; then
  echo "FAIL: the no-install path seeded the cache" >&2; exit 1
fi

# A type error must fail the install path rather than be cached. Vite transpiles
# without typechecking, so a cache seeded by a bare `vite build` would hide this
# from every later build that restores it.
rm -rf "$CACHE"
printf 'export const wrong: number = "not a number";\n' > "$BADTS"
if pnpm run build:dashboard > /tmp/spa-smoke-badtype.log 2>&1; then
  echo "FAIL: a dashboard type error did not fail build:dashboard" >&2; exit 1
fi
if [ -d "$CACHE" ] && [ -n "$(ls -A "$CACHE" 2>/dev/null)" ]; then
  echo "FAIL: a failed typecheck still seeded the cache" >&2; exit 1
fi
rm -f "$BADTS"
echo "badtype   build:dashboard        --  failed as expected, cache left empty"

expect warm    'cache hit'
expect forced  'forced'
expect dirty   'cache-miss'
expect revert  'cache hit'
expect devhit  'cache hit'
expect devmiss 'not cached'
echo "PASS"
