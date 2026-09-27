#!/usr/bin/env bash
# smoke-case.sh: SMOKE_CASE and SMOKE_SHARD over a fixture suite of five cases,
# two of them inside a loop. Shards partition the cases; a filter that matches
# nothing, or a malformed shard, fails the suite.
set -u
unset SMOKE_CASE SMOKE_SHARD SMOKE_CASE_LOG
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILED=0
ok() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=1; }

cat >"$T/suite.sh" <<EOF
set -euo pipefail
. "$SCRIPT_DIR/smoke-case.sh"
SHARED=from-setup
if smoke_case alpha; then echo "alpha \$SHARED"; fi
if smoke_case beta; then echo beta; fi
for n in one two; do
  smoke_case "loop-\$n" || continue
  echo "loop-\$n"
done
if smoke_case gamma; then echo gamma; fi
smoke_cases_done
EOF
ran() { bash "$T/suite.sh" 2>"$T/err" | tr '\n' ',' | sed 's/,$//'; }

[ "$(ran)" = "alpha from-setup,beta,loop-one,loop-two,gamma" ] && ok "no filter runs every case in order" ||
  fail "no filter: $(ran)"
[ "$(SMOKE_CASE=beta ran)" = "beta" ] && ok "SMOKE_CASE picks one case" || fail "SMOKE_CASE=beta: $(SMOKE_CASE=beta ran)"
[ "$(SMOKE_CASE='loop-*' ran)" = "loop-one,loop-two" ] && ok "SMOKE_CASE is a glob, loop cases included" ||
  fail "SMOKE_CASE=loop-*: $(SMOKE_CASE='loop-*' ran)"
if SMOKE_CASE=nope bash "$T/suite.sh" >/dev/null 2>"$T/err"; then
  fail "a SMOKE_CASE matching nothing passed"
else
  grep -q "matched none of the 5 cases" "$T/err" && ok "a SMOKE_CASE matching nothing fails" || fail "no-match message: $(cat "$T/err")"
fi
ALL=""
for k in 1 2 3; do ALL="$ALL,$(SMOKE_SHARD=$k/3 ran)"; done
[ "$(tr ',' '\n' <<<"$ALL" | sed '/^$/d' | sort | tr '\n' ',')" = "alpha from-setup,beta,gamma,loop-one,loop-two," ] &&
  ok "three shards run each case exactly once" || fail "shards 1..3 ran: $ALL"
[ "$(SMOKE_SHARD=2/3 ran)" = "beta,gamma" ] && ok "shard k/n takes every n-th case from the k-th" ||
  fail "SMOKE_SHARD=2/3: $(SMOKE_SHARD=2/3 ran)"
[ "$(SMOKE_SHARD=1/9 ran)" = "alpha from-setup" ] && ok "more shards than cases leaves some shards empty, not failing" ||
  fail "SMOKE_SHARD=1/9: $(SMOKE_SHARD=1/9 ran)"
for bad in 0/3 4/3 3 a/b 1/0; do
  if SMOKE_SHARD="$bad" bash "$T/suite.sh" >/dev/null 2>&1; then fail "SMOKE_SHARD=$bad was accepted"; else rc=$?; fi
  [ "${rc:-0}" = 2 ] && ok "SMOKE_SHARD=$bad is refused" || fail "SMOKE_SHARD=$bad exit ${rc:-0}"
  unset rc
done
LOG="$T/cases.log"
SMOKE_CASE_LOG="$LOG" SMOKE_SHARD=1/2 bash "$T/suite.sh" >/dev/null
[ "$(tr '\n' ',' <"$LOG")" = "alpha,loop-one,gamma," ] && ok "SMOKE_CASE_LOG records the cases this process ran" ||
  fail "case log: $(cat "$LOG")"

[ "$FAILED" = 0 ] || { echo "smoke-case tests FAILED" >&2; exit 1; }
echo "smoke-case tests passed"
