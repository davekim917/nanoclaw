#!/usr/bin/env bash
# Runs every *.test.py beside this file. The skill-shell gate
# (container/skill-shell-tests.test.ts) discovers only *.test.sh, so until
# this runner existed the Python suites here -- the phase-dispatch admission
# tests included -- ran nowhere: the parser that could not read a real
# `ncl --json` answer (pr2121) shipped past them. Globbed, so a new suite is
# gated the day it lands; an empty glob is a failure, not a pass.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
shopt -s nullglob
suites=(*.test.py)
[ "${#suites[@]}" -gt 0 ] || { echo "no *.test.py suites found beside $0" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required (smoke-owner-dispatch.test.py compares fakes against it)" >&2; exit 1; }
failed=0
for suite in "${suites[@]}"; do
  echo "== $suite =="
  PYTHONDONTWRITEBYTECODE=1 python3 "$suite" || { echo "FAILED: $suite" >&2; failed=$((failed + 1)); }
done
[ "$failed" = 0 ] || { echo "$failed python suite(s) failed" >&2; exit 1; }
echo "PASS (${#suites[@]} python suites)"
