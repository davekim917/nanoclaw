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
  "ownershipKind": "develop",
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
  "ownershipKind": "develop",
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
{"schemaVersion":1,"sourceSha":"cccccccccccccccccccccccccccccccccccccccc","ownershipKind":"develop","requiredLaneMarkers":["markers/B1.json"]}
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

# A marker naming a CONFIRMED finding must carry that finding's clip, or a
# stated skip reason — silence fails the barrier. This applies independent of
# `status` (a confirmed finding pairs naturally with a `fail` lane, not a
# `pass` one), so exercise it on a non-pass marker to prove it is not
# piggybacking on the pass-evidence check above.
CLIP_DIR="$(mktemp -d)"
mkdir -p "$CLIP_DIR/markers" "$CLIP_DIR/clips"
cat >"$CLIP_DIR/completion-contract.json" <<'JSON'
{"schemaVersion":1,"sourceSha":"dddddddddddddddddddddddddddddddddddddddd","ownershipKind":"develop","requiredLaneMarkers":["markers/B1.json"]}
JSON

# No clip, no skip line: silence must fail the barrier.
cat >"$CLIP_DIR/markers/B1.json" <<'JSON'
{"schemaVersion":1,"lane":"B1","sourceSha":"dddddddddddddddddddddddddddddddddddddddd","status":"fail","completedAt":"2026-09-11T10:00:00Z","confirmedFindings":["F1"],"evidence":["screenshot: unrelated"]}
JSON
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("has no clip evidence"))' >/dev/null || {
  echo "expected a confirmed finding with no clip and no skip reason to fail" >&2; echo "$RESULT" >&2; exit 1; }

# A stated clip-skipped reason satisfies the check on its own — "a failed
# recording never blocks" — with no clip file required.
jq '.evidence = ["clip-skipped: F1: no browser lease available"]' "$CLIP_DIR/markers/B1.json" \
  >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a stated clip-skipped reason to clear the barrier with no clip file" >&2; exit 1; }

# An empty reason after the prefix does not count as "stated".
jq '.evidence = ["clip-skipped: F1: "]' "$CLIP_DIR/markers/B1.json" >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes || true)"
echo "$RESULT" | jq -e '.ready == false' >/dev/null || {
  echo "expected an empty clip-skipped reason to still fail the barrier" >&2; echo "$RESULT" >&2; exit 1; }

# Referencing the clip without the file existing must fail — a promised clip
# path is not durable evidence until the file is actually there.
jq '.evidence = ["clips/F1.mp4"]' "$CLIP_DIR/markers/B1.json" >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("clip is missing"))' >/dev/null || {
  echo "expected a referenced-but-missing clip file to fail" >&2; echo "$RESULT" >&2; exit 1; }

# A real, nonempty clip file clears the barrier.
printf '%s\n' 'fake mp4 bytes' >"$CLIP_DIR/clips/F1.mp4"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a real, nonempty clip file to clear the barrier" >&2; exit 1; }

# An empty clip file is not durable evidence either, same as pass evidence.
: >"$CLIP_DIR/clips/F1.mp4"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("clip is empty"))' >/dev/null || {
  echo "expected an empty clip file to fail" >&2; echo "$RESULT" >&2; exit 1; }

# Backward compatible: a marker with no confirmedFindings field at all is
# unaffected by any of this.
printf '%s\n' 'fake mp4 bytes' >"$CLIP_DIR/clips/F1.mp4"
jq 'del(.confirmedFindings) | .evidence = ["screenshot: unrelated"]' "$CLIP_DIR/markers/B1.json" \
  >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a marker with no confirmedFindings field to be unaffected" >&2; exit 1; }

rm -rf "$CLIP_DIR"

# --- ownershipKind and coordinatorOwnerToken: the certify-1657 shape -------
# A hand-composed contract is refused two ways: it never carries
# `ownershipKind` at all (only the scaffold's `contract` verb ever writes
# that field), and even a contract that fakes a `pr`/`task` ownershipKind
# still can't fake a non-null coordinatorOwnerToken (only a live claim
# produces one — see smoke-evidence-barrier.sh's comments for the file:line
# proof). A `develop`-owned contract's null token is the one legitimate case
# and must never trip either check.
OWNER_DIR="$(mktemp -d)"
mkdir -p "$OWNER_DIR/markers"

# No ownershipKind field at all — the exact shape of every hand-composed
# contract, since nothing outside the scaffold ever writes this field.
cat >"$OWNER_DIR/completion-contract.json" <<'JSON'
{
  "schemaVersion": 1,
  "sourceSha": "cccccccccccccccccccccccccccccccccccccccc",
  "requiredLaneMarkers": ["markers/B1.json"]
}
JSON
NO_KIND_OUT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$OWNER_DIR" lanes || true)"
echo "$NO_KIND_OUT" | jq -e '
  (.ready == false) and (.invalid == ["'"$OWNER_DIR"'/completion-contract.json"]) and
  (.invalidReasons[0] | contains("no ownershipKind") and contains("claim") and contains("scaffold"))
' >/dev/null || {
  echo "expected a contract with no ownershipKind field to be refused, naming claim + the scaffold as the fix" >&2
  echo "$NO_KIND_OUT" >&2; exit 1; }

# A `task` ownershipKind with a null token — claims to be scaffold-written
# but carries the one field only a live claim can produce as non-null.
jq '.ownershipKind = "task" | .coordinatorOwnerToken = null' "$OWNER_DIR/completion-contract.json" \
  >"$OWNER_DIR/.contract.tmp"
mv "$OWNER_DIR/.contract.tmp" "$OWNER_DIR/completion-contract.json"
NULL_TOKEN_OUT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$OWNER_DIR" lanes || true)"
echo "$NULL_TOKEN_OUT" | jq -e '
  (.ready == false) and (.invalid == ["'"$OWNER_DIR"'/completion-contract.json"]) and
  (.invalidReasons[0] | contains("task") and contains("no coordinatorOwnerToken") and contains("task-claim"))
' >/dev/null || {
  echo "expected a task-owned contract with a null token to be refused, naming task-claim as the fix" >&2
  echo "$NULL_TOKEN_OUT" >&2; exit 1; }

# Same shape for a `pr` ownership kind.
jq '.ownershipKind = "pr"' "$OWNER_DIR/completion-contract.json" >"$OWNER_DIR/.contract.tmp"
mv "$OWNER_DIR/.contract.tmp" "$OWNER_DIR/completion-contract.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$OWNER_DIR" lanes >/dev/null 2>&1 && {
  echo "expected a pr-owned contract with a null token to be refused too" >&2; exit 1; }

# A `develop`-owned contract with a null token is exactly the legitimate
# shape begin_active_run_fence's develop branch produces — never refused on
# either ground. (Still refused on missing markers, which is what "not
# ready" below asserts; it must not be refused as an invalid CONTRACT.)
jq '.ownershipKind = "develop"' "$OWNER_DIR/completion-contract.json" >"$OWNER_DIR/.contract.tmp"
mv "$OWNER_DIR/.contract.tmp" "$OWNER_DIR/completion-contract.json"
DEVELOP_OUT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$OWNER_DIR" lanes || true)"
echo "$DEVELOP_OUT" | jq -e '.invalid != ["'"$OWNER_DIR"'/completion-contract.json"]' >/dev/null || {
  echo "expected a develop-owned contract with a null token to be refused only for missing markers, not as an invalid contract" >&2
  echo "$DEVELOP_OUT" >&2; exit 1; }

rm -rf "$OWNER_DIR"

echo "smoke evidence barrier tests passed"
