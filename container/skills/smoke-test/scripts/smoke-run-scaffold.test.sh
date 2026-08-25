#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(mktemp -d)/run-fixture"
trap 'rm -rf "$(dirname "$FIXTURE_DIR")"' EXIT
mkdir -p "$FIXTURE_DIR"

SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTHER_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
# Every legitimate caller of the scaffold is coordinator-side; the role checks
# below are the only cases that override this.
export SMOKE_LANE_ROLE=coordinator
# ...and holds the gate. The scaffold reads the gate's own state file rather
# than taking a second token: `activeRunId` IS the fencing token.
GATE_STATE="$(mktemp -d)"
export SMOKE_GATE_STATE_DIR="$GATE_STATE"
gate_owns() {
  printf '{"schemaVersion":1,"pr":5,"activeRunId":"%s"}\n' "$1" > "$GATE_STATE/pr-5-state.json"
}
gate_owns "$(basename "$FIXTURE_DIR")"
scaffold() { bash "$SCRIPT_DIR/smoke-run-scaffold.sh" "$@"; }
barrier() { bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$@"; }

# A short SHA is the shape a freehand contract would happily accept.
if scaffold contract "$FIXTURE_DIR" deadbeef B1 >/dev/null 2>&1; then
  echo "expected a non-40-character SHA to be refused" >&2
  exit 1
fi

if scaffold contract "$FIXTURE_DIR" "$SHA" >/dev/null 2>&1; then
  echo "expected a contract with no lanes to be refused" >&2
  exit 1
fi

SMOKE_CONTRACT_EXTRA='{"environment":"https://dev.example","leasePolicy":"one at a time"}' \
  scaffold contract "$FIXTURE_DIR" "$SHA" B1:browser:'Program master' S1:source:'Fund ledger' \
  | jq -e '.ok == true and .laneCount == 2' >/dev/null

# The generated contract must satisfy the barrier's schema AND keep the richer
# fields real runs read — the two shapes that drifted apart are now one file.
jq -e '
  .schemaVersion == 1 and
  (.requiredLaneMarkers | sort == ["markers/B1.json","markers/S1.json"]) and
  (.lanes | length == 2) and
  .markerDir == "markers" and
  .environment == "https://dev.example" and
  .leasePolicy == "one at a time"
' "$FIXTURE_DIR/completion-contract.json" >/dev/null

# Deployment extras must never be able to forge the fields the barrier checks.
SMOKE_CONTRACT_EXTRA="{\"sourceSha\":\"$OTHER_SHA\",\"requiredLaneMarkers\":[]}" \
  scaffold contract "$FIXTURE_DIR" "$SHA" B1:browser S1:source >/dev/null
jq -e --arg sha "$SHA" '.sourceSha == $sha and (.requiredLaneMarkers | length == 2)' \
  "$FIXTURE_DIR/completion-contract.json" >/dev/null

if barrier "$FIXTURE_DIR" lanes >/dev/null 2>&1; then
  echo "expected missing markers to block the lanes phase" >&2
  exit 1
fi

if scaffold marker "$FIXTURE_DIR" B1 finished >/dev/null 2>&1; then
  echo "expected a non-terminal status to be refused" >&2
  exit 1
fi

# An undeclared lane would leave the real lane forever missing and the barrier
# forever false — the silent-stall shape this scaffold exists to prevent.
if scaffold marker "$FIXTURE_DIR" B9 pass >/dev/null 2>&1; then
  echo "expected an undeclared lane to be refused" >&2
  exit 1
fi

# P1 regression: the writer's ROLE gates the coordinator-owned paths. A
# challenger-side worker on the right sourceSha writing a DECLARED lane passed
# every other check here — which is exactly what happened three times in one
# run on 2026-08-20 and twice more on 2026-08-22, once destroying a real
# coordinator marker. Refusing to resolve the path is the fix; briefing workers
# not to write it is the mitigation that already failed twice.
for role_case in challenger "" bogus; do
  ROLE_OUT="$(SMOKE_LANE_ROLE="$role_case" scaffold marker "$FIXTURE_DIR" B1 pass 'challenger conclusion' 2>&1 || true)"
  jq -e '.ok == false and (.error | test("SMOKE_LANE_ROLE"))' <<<"$ROLE_OUT" >/dev/null || {
    echo "expected SMOKE_LANE_ROLE='$role_case' to be refused a coordinator marker, got: $ROLE_OUT" >&2
    exit 1
  }
  if [ -e "$FIXTURE_DIR/markers/B1.json" ]; then
    echo "expected the refused write to leave no marker behind" >&2; exit 1
  fi
  # The contract is coordinator-owned for the same reason: a rival re-scaffold
  # rewrites every lane definition and invalidates every marker.
  ROLE_OUT="$(SMOKE_LANE_ROLE="$role_case" scaffold contract "$FIXTURE_DIR" "$OTHER_SHA" Z9:source 2>&1 || true)"
  jq -e '.ok == false and (.error | test("SMOKE_LANE_ROLE"))' <<<"$ROLE_OUT" >/dev/null || {
    echo "expected SMOKE_LANE_ROLE='$role_case' to be refused the contract, got: $ROLE_OUT" >&2
    exit 1
  }
  jq -e --arg sha "$SHA" '.sourceSha == $sha' "$FIXTURE_DIR/completion-contract.json" >/dev/null
done

# P1 regression: being the right ROLE is not the same as still OWNING the run.
# `--takeover` (and an ordinary stale reclaim) flips the gate's activeRunId and
# nothing else — a displaced coordinator kept writing markers into the run tree
# its successor was now using, which is where pr1105's damage happened. Fail
# closed on a state dir that cannot be read at all, too: an unverifiable claim
# is not a claim.
gate_owns "some-other-run"
for FENCE_VERB in marker contract; do
  case "$FENCE_VERB" in
    marker)   OUT="$(scaffold marker "$FIXTURE_DIR" B1 pass 'displaced write' 2>&1 || true)" ;;
    contract) OUT="$(scaffold contract "$FIXTURE_DIR" "$OTHER_SHA" Z9:source 2>&1 || true)" ;;
  esac
  jq -e '.ok == false and (.error | test("does not hold the gate")) and (.error | test("STOP"))' \
    <<<"$OUT" >/dev/null || {
    echo "expected a displaced run to be refused $FENCE_VERB, got: $OUT" >&2; exit 1; }
done
[ -e "$FIXTURE_DIR/markers/B1.json" ] && { echo "displaced marker was written" >&2; exit 1; } || true
jq -e --arg sha "$SHA" '.sourceSha == $sha' "$FIXTURE_DIR/completion-contract.json" >/dev/null
OUT="$(SMOKE_GATE_STATE_DIR= scaffold marker "$FIXTURE_DIR" B1 pass 2>&1 || true)"
jq -e '.ok == false and (.error | test("SMOKE_GATE_STATE_DIR"))' <<<"$OUT" >/dev/null || {
  echo "expected an unverifiable gate claim to fail closed, got: $OUT" >&2; exit 1; }
gate_owns "$(basename "$FIXTURE_DIR")"

scaffold marker "$FIXTURE_DIR" B1 fail 'three P1 defects' 'screenshots/a.png,evidence/b.json' \
  | jq -e '.ok == true' >/dev/null
scaffold marker "$FIXTURE_DIR" S1 completed 'wallet math deviates' >/dev/null

# sourceSha comes from the contract, never from the caller: a worker cannot
# stamp a marker against a build it was not assigned.
jq -e --arg sha "$SHA" '
  .sourceSha == $sha and
  .status == "fail" and
  (.completedAt | length > 0) and
  (.finishedAt | length > 0) and
  (.evidence == ["screenshots/a.png","evidence/b.json"])
' "$FIXTURE_DIR/markers/B1.json" >/dev/null

# Absent evidence must be [], not a jq failure that writes nothing.
jq -e '.evidence == [] and .summary == "wallet math deviates"' \
  "$FIXTURE_DIR/markers/S1.json" >/dev/null

barrier "$FIXTURE_DIR" lanes | jq -e '.ready == true' >/dev/null

if barrier "$FIXTURE_DIR" synthesis >/dev/null 2>&1; then
  echo "expected missing parent conclusions to block synthesis" >&2
  exit 1
fi

mkdir -p "$FIXTURE_DIR/coordinator" "$FIXTURE_DIR/challenger"
printf '%s\n' '# preliminary' >"$FIXTURE_DIR/coordinator/preliminary.md"
printf '%s\n' '# disposition' >"$FIXTURE_DIR/challenger/disposition.md"
barrier "$FIXTURE_DIR" synthesis | jq -e '.ready == true' >/dev/null

# Re-freezing on a new build must invalidate every marker bound to the old one,
# rather than letting stale lanes vouch for a build they never touched.
scaffold contract "$FIXTURE_DIR" "$OTHER_SHA" B1:browser S1:source >/dev/null
# The barrier exits non-zero when not ready, so capture before asserting —
# under `pipefail` a direct pipe would fail the test on the exit code alone.
REFROZEN="$(barrier "$FIXTURE_DIR" lanes || true)"
jq -e '.ready == false and (.invalid | sort == ["markers/B1.json","markers/S1.json"])' \
  <<<"$REFROZEN" >/dev/null

# F2. The barrier has always honoured `.generation`, but NOTHING could write
# one — the scaffold is the only sanctioned writer and it emitted no such field,
# so the whole stale-marker protection was unreachable. These cases prove the
# two writers that make it real.
FRESH="$(dirname "$FIXTURE_DIR")/gen-fixture"
mkdir -p "$FRESH"
gate_owns "$(basename "$FRESH")"
scaffold contract "$FRESH" "$SHA" B1:browser B2:browser >/dev/null
scaffold marker "$FRESH" B1 pass 'lane one' >/dev/null
scaffold marker "$FRESH" B2 pass 'lane two' >/dev/null
mkdir -p "$FRESH/coordinator" "$FRESH/challenger"
printf '# p\n' >"$FRESH/coordinator/preliminary.md"
printf '# d\n' >"$FRESH/challenger/disposition.md"

# A marker inherits the contract's generation, exactly the way it inherits
# sourceSha — never stated by the caller.
jq -e '.generation == 1' "$FRESH/markers/B1.json" >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# A same-SHA re-scaffold over existing markers is REFUSED. This is the concrete
# incident: a lane repurposed mid-run under a pinned freeze SHA, whose old
# marker stayed sourceSha-correct, lane-id-correct and terminal.
OUT="$(scaffold contract "$FRESH" "$SHA" B1:browser B2:browser:'repurposed' 2>&1 || true)"
jq -e '.ok == false and (.error | test("--regenerate"))' <<<"$OUT" >/dev/null || {
  echo "expected a same-SHA re-scaffold over existing markers to be refused, got: $OUT" >&2
  exit 1; }
jq -e '.lanes[1].title == null' "$FRESH/completion-contract.json" >/dev/null

# With --regenerate it goes through, every lane is bumped, and every stale
# marker now FAILS the barrier instead of vouching for a definition it never saw.
scaffold contract "$FRESH" "$SHA" B1:browser B2:browser:'repurposed' --regenerate \
  | jq -e '.ok == true' >/dev/null
jq -e 'all(.lanes[]; .generation == 2)' "$FRESH/completion-contract.json" >/dev/null
REGEN="$(barrier "$FRESH" lanes || true)"
jq -e '.ready == false and (.invalid | sort == ["markers/B1.json","markers/B2.json"]) and
       (.invalidReasons | map(test("stale generation")) | all)' <<<"$REGEN" >/dev/null || {
  echo "expected bumped generations to retire every stale marker, got: $REGEN" >&2
  exit 1; }

# Fresh markers land at the new generation and the barrier clears again.
scaffold marker "$FRESH" B1 pass 'redone' | jq -e '.generation == 2' >/dev/null
scaffold marker "$FRESH" B2 pass 'redone' >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# redispatch bumps ONE lane: its old marker is retired, the finished lane keeps
# counting. Bumping the whole contract here would stall the run.
scaffold redispatch "$FRESH" B2 | jq -e '.ok == true and .generation == 3 and .retiredExistingMarker == true' >/dev/null
ONE="$(barrier "$FRESH" lanes || true)"
jq -e '.ready == false and (.invalid == ["markers/B2.json"])' <<<"$ONE" >/dev/null || {
  echo "expected redispatch to retire only its own lane, got: $ONE" >&2; exit 1; }
scaffold marker "$FRESH" B2 pass 'second attempt' | jq -e '.generation == 3' >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# redispatch is coordinator-owned and gate-fenced like every other write.
gate_owns "someone-else"
OUT="$(scaffold redispatch "$FRESH" B2 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not hold the gate"))' <<<"$OUT" >/dev/null
gate_owns "$(basename "$FRESH")"
OUT="$(SMOKE_LANE_ROLE=challenger scaffold redispatch "$FRESH" B2 2>&1 || true)"
jq -e '.ok == false and (.error | test("SMOKE_LANE_ROLE"))' <<<"$OUT" >/dev/null
OUT="$(scaffold redispatch "$FRESH" NOPE 2>&1 || true)"
jq -e '.ok == false and (.error | test("not declared"))' <<<"$OUT" >/dev/null

echo "smoke run scaffold tests passed"
