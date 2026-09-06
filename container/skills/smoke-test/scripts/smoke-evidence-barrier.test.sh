#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

mkdir -p "$FIXTURE_DIR/coordinator" "$FIXTURE_DIR/challenger"

cat >"$FIXTURE_DIR/completion-contract.json" <<'JSON'
{
  "schemaVersion": 1,
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "requiredLaneMarkers": [
    "coordinator/browser.complete.json",
    "challenger/challenge.complete.json"
  ]
}
JSON

if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" lanes >/dev/null 2>&1; then
  echo "expected missing markers to block lanes phase" >&2
  exit 1
fi

cat >"$FIXTURE_DIR/coordinator/browser.complete.json" <<'JSON'
{
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "blocked",
  "completedAt": "2026-08-04T20:00:00Z"
}
JSON

cat >"$FIXTURE_DIR/challenger/challenge.complete.json" <<'JSON'
{
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "fail",
  "completedAt": "2026-08-04T20:01:00Z"
}
JSON

bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" lanes \
  | jq -e '.ready == true and .phase == "lanes"' >/dev/null

if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" synthesis >/dev/null 2>&1; then
  echo "expected missing parent conclusions to block synthesis" >&2
  exit 1
fi

printf '%s\n' '# independent coordinator preliminary' >"$FIXTURE_DIR/coordinator/preliminary.md"
printf '%s\n' '# independent challenger disposition' >"$FIXTURE_DIR/challenger/disposition.md"

bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" synthesis \
  | jq -e '.ready == true and .phase == "synthesis"' >/dev/null

# The disposition gate: the challenger may post only once BOTH conclusions are
# durable. Its own file alone is not enough — that is the ordering that broke
# on 2026-08-07, when a posted disposition landed in the coordinator's context
# before the coordinator had written a line.
DISP_DIR="$(mktemp -d)/run"
mkdir -p "$DISP_DIR/coordinator" "$DISP_DIR/challenger"
cp "$FIXTURE_DIR/completion-contract.json" "$DISP_DIR/completion-contract.json"

if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$DISP_DIR" disposition >/dev/null 2>&1; then
  echo "expected an empty run to block the disposition post" >&2
  exit 1
fi

printf '%s\n' '# challenger disposition' >"$DISP_DIR/challenger/disposition.md"
if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$DISP_DIR" disposition >/dev/null 2>&1; then
  echo "expected a missing coordinator preliminary to block the disposition post" >&2
  exit 1
fi
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$DISP_DIR" disposition \
  | jq -e '.missing == ["coordinator/preliminary.md"]' >/dev/null || true

printf '%s\n' '# coordinator preliminary' >"$DISP_DIR/coordinator/preliminary.md"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$DISP_DIR" disposition \
  | jq -e '.ready == true and .phase == "disposition"' >/dev/null

# It must NOT wait on the coordinator's lane markers: the challenger can never
# be made to queue behind the lanes it exists to challenge.
[ ! -e "$DISP_DIR/coordinator/browser.complete.json" ]
rm -rf "$(dirname "$DISP_DIR")"

# --- generation/staleness (2026-08-24, PR #1188 run) ------------------------
# A marker from a superseded dispatch, or written against a lane definition
# the contract has since re-scaffolded, must NOT satisfy the barrier — see
# the `generation` comment block in smoke-evidence-barrier.sh for the two live
# incidents this closes.
GEN_DIR="$(mktemp -d)"
mkdir -p "$GEN_DIR/markers" "$GEN_DIR/evidence"
printf '%s\n' 'B1 browser proof' >"$GEN_DIR/evidence/b1.txt"
printf '%s\n' 'B2 browser proof' >"$GEN_DIR/evidence/b2.txt"

cat >"$GEN_DIR/completion-contract.json" <<'JSON'
{
  "schemaVersion": 1,
  "sourceSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "requiredLaneMarkers": ["markers/B1.json", "markers/B2.json"],
  "lanes": [
    {"id": "B1", "kind": "browser", "title": "Depletions planner"},
    {"id": "B2", "kind": "browser", "title": "Publish/export ledger", "generation": 2}
  ]
}
JSON

# A contract with no `generation` on a lane entry (B1, default 1) must accept
# a marker that never mentions generation at all — full backward compatibility
# with every marker written before this feature existed.
cat >"$GEN_DIR/markers/B1.json" <<'JSON'
{"schemaVersion":1,"lane":"B1","sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"pass","completedAt":"2026-08-24T16:00:00Z","evidence":["evidence/b1.txt"]}
JSON

# B2's marker was written against generation 1 (the lane's OLD meaning, before
# a re-scaffold bumped the contract to generation 2) — same shape PR #1188's
# stale B2 marker actually had. It must be reported invalid, and reported as
# stale specifically, not as any other failure mode.
cat >"$GEN_DIR/markers/B2.json" <<'JSON'
{"schemaVersion":1,"lane":"B2","sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"pass","completedAt":"2026-08-24T16:30:00Z","evidence":["evidence/b2.txt"]}
JSON

RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$GEN_DIR" lanes || true)"
echo "$RESULT" | jq -e '.ready == false' >/dev/null \
  || { echo "expected a generation mismatch to block the lanes phase" >&2; exit 1; }
echo "$RESULT" | jq -e '.invalid == ["markers/B2.json"]' >/dev/null \
  || { echo "expected exactly markers/B2.json to be invalid, not B1"; echo "$RESULT" >&2; exit 1; }
echo "$RESULT" | jq -e '.invalidReasons[0] | contains("stale generation")' >/dev/null \
  || { echo "expected the invalidReasons entry to name staleness, not a generic reason"; echo "$RESULT" >&2; exit 1; }

# Writing a FRESH B2 marker at generation 2 (the current dispatch) must clear
# the barrier — this is the re-dispatch actually landing, not just staleness
# detection working.
cat >"$GEN_DIR/markers/B2.json" <<'JSON'
{"schemaVersion":1,"lane":"B2","sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"pass","completedAt":"2026-08-24T17:00:00Z","generation":2,"evidence":["evidence/b2.txt"]}
JSON
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$GEN_DIR" lanes \
  | jq -e '.ready == true' >/dev/null \
  || { echo "expected a matching-generation marker to satisfy the barrier" >&2; exit 1; }

# A marker whose `lane` field disagrees with its filename (copy-paste from a
# different lane) must also be invalid, reported as an identity mismatch
# rather than mis-attributed to generation.
cat >"$GEN_DIR/markers/B1.json" <<'JSON'
{"schemaVersion":1,"lane":"B4","sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"pass","completedAt":"2026-08-24T16:00:00Z"}
JSON
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$GEN_DIR" lanes || true)"
echo "$RESULT" | jq -e '.invalidReasons[0] | contains("lane field mismatch")' >/dev/null \
  || { echo "expected a lane/filename mismatch to be reported as an identity mismatch"; echo "$RESULT" >&2; exit 1; }

rm -rf "$GEN_DIR"

# A pass marker needs real, durable evidence under the run root. These cases
# exercise the barrier directly so a future writer cannot weaken it by merely
# changing scaffold defaults. A non-pass marker remains a valid terminal
# account of a concrete blocker without fabricated success evidence.
EVIDENCE_DIR="$(mktemp -d)"
mkdir -p "$EVIDENCE_DIR/markers" "$EVIDENCE_DIR/evidence"
cat >"$EVIDENCE_DIR/completion-contract.json" <<'JSON'
{"schemaVersion":1,"sourceSha":"cccccccccccccccccccccccccccccccccccccccc","requiredLaneMarkers":["markers/B1.json"]}
JSON

cat >"$EVIDENCE_DIR/markers/B1.json" <<'JSON'
{"schemaVersion":1,"lane":"B1","sourceSha":"cccccccccccccccccccccccccccccccccccccccc","status":"pass","completedAt":"2026-08-24T18:00:00Z"}
JSON
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("nonempty evidence array"))' >/dev/null || {
  echo "expected an evidence-free pass marker to fail" >&2; exit 1; }

jq '.evidence = ["evidence/missing.txt"]' "$EVIDENCE_DIR/markers/B1.json" >"$EVIDENCE_DIR/markers/.marker.json"
mv "$EVIDENCE_DIR/markers/.marker.json" "$EVIDENCE_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("evidence file is missing"))' >/dev/null || {
  echo "expected a missing evidence path to fail" >&2; exit 1; }

: >"$EVIDENCE_DIR/evidence/empty.txt"
jq '.evidence = ["evidence/empty.txt"]' "$EVIDENCE_DIR/markers/B1.json" >"$EVIDENCE_DIR/markers/.marker.json"
mv "$EVIDENCE_DIR/markers/.marker.json" "$EVIDENCE_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("evidence file is empty"))' >/dev/null || {
  echo "expected an empty evidence file to fail" >&2; exit 1; }

# Lexical path checks alone are insufficient: a symlinked parent directory can
# make an apparently in-run path resolve outside the immutable run tree.
OUTSIDE_DIR="$(mktemp -d)"
printf '%s\n' 'outside receipt' >"$OUTSIDE_DIR/outside.txt"
ln -s "$OUTSIDE_DIR" "$EVIDENCE_DIR/evidence/escape"
jq '.evidence = ["evidence/escape/outside.txt"]' "$EVIDENCE_DIR/markers/B1.json" >"$EVIDENCE_DIR/markers/.marker.json"
mv "$EVIDENCE_DIR/markers/.marker.json" "$EVIDENCE_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("resolves outside the run root"))' >/dev/null || {
  echo "expected a parent symlink escaping the run root to fail" >&2; exit 1; }
rm -rf "$OUTSIDE_DIR"

printf '%s\n' 'fresh browser receipt' >"$EVIDENCE_DIR/evidence/fresh.txt"
jq '.evidence = ["evidence/fresh.txt"]' "$EVIDENCE_DIR/markers/B1.json" >"$EVIDENCE_DIR/markers/.marker.json"
mv "$EVIDENCE_DIR/markers/.marker.json" "$EVIDENCE_DIR/markers/B1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || { echo "expected real evidence to clear a pass marker" >&2; exit 1; }

jq '.status = "blocked" | del(.evidence)' "$EVIDENCE_DIR/markers/B1.json" >"$EVIDENCE_DIR/markers/.marker.json"
mv "$EVIDENCE_DIR/markers/.marker.json" "$EVIDENCE_DIR/markers/B1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$EVIDENCE_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || { echo "expected a blocked marker without success evidence to remain terminal" >&2; exit 1; }
rm -rf "$EVIDENCE_DIR"

echo "smoke evidence barrier tests passed"
