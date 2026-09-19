#!/usr/bin/env bash
# Host CI for this repository: the commands of .github/workflows/ci.yml's
# pull_request lane (job `typecheck`), for container/skills/pr-review-loop/
# scripts/run-host-ci.sh to run against a PR head when GitHub Actions cannot.
# Run with bash from the repository root of a scratch checkout of that head.
#
# The steps below are exactly ci.yml's `run:` steps, in order, a step with a
# `working-directory` written as `(cd <dir> && <cmd>)`. scripts/host-ci-
# declaration.test.ts fails when the two differ, so change them together.
# What this cannot mirror is ci.yml's `uses:` toolchain setup: the runner's
# node, pnpm and bun are whatever this machine has (ci.yml pins node 22 and
# bun 1.3.14). `set -euo pipefail` must stay the first line of code: the test
# refuses anything above it. The one vitest step is a single file on one
# worker, so it runs without run-host-ci.sh's $HOST_CI_VITEST_LOCK (a flock
# prefix here would no longer be ci.yml's line).
set -euo pipefail

pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run scripts/host-ci-declaration.test.ts --maxWorkers=1
