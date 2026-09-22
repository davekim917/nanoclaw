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

# A pass marker uses the same evidence array and must accept this exact
# well-formed skip form too. Treating every evidence string as a file path
# would reject this as a missing file before finding_clip_problem got to
# recognize the stated recording exception.
jq '.status = "pass"' "$CLIP_DIR/markers/B1.json" >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a pass marker with a stated clip-skipped reason to clear the barrier" >&2; exit 1; }

# Passing a magic-looking non-file string is never enough: it must name one of
# this marker's confirmed findings with a nonempty reason.
jq '.evidence = ["clip-skipped: F9: unrelated finding"]' "$CLIP_DIR/markers/B1.json" \
  >"$CLIP_DIR/markers/.marker.json"
mv "$CLIP_DIR/markers/.marker.json" "$CLIP_DIR/markers/B1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$CLIP_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("clip-skipped evidence"))' >/dev/null || {
  echo "expected an unconfirmed clip-skipped line on a pass marker to fail" >&2; echo "$RESULT" >&2; exit 1; }

# An empty reason after the prefix does not count as "stated".
jq '.status = "fail" | .evidence = ["clip-skipped: F1: "]' "$CLIP_DIR/markers/B1.json" >"$CLIP_DIR/markers/.marker.json"
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

# --- floor lanes require browser evidence unless declared API-only ---------
# A floor lane resets its entry's staleness clock on `pass` (SKILL.md "The
# coverage floor"). Without this check, a lane with API-only receipts (or no
# evidence at all beyond the bare minimum) could satisfy the barrier and reset
# that clock with no journey ever walked in a browser.
FLOOR_DIR="$(mktemp -d)"
mkdir -p "$FLOOR_DIR/markers" "$FLOOR_DIR/evidence"
cat >"$FLOOR_DIR/completion-contract.json" <<'JSON'
{
  "schemaVersion": 1,
  "sourceSha": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "ownershipKind": "develop",
  "requiredLaneMarkers": ["markers/F1.json"],
  "lanes": [
    {"id": "F1", "kind": "floor", "title": "Payout approval walk"}
  ]
}
JSON

# API-only evidence (a JSON receipt, no image/video extension) on a plain
# `floor` lane — not declared `evidence:"api"` in the contract — must be
# refused, even though the evidence file is real, durable, and non-empty.
printf '{"status":200}\n' >"$FLOOR_DIR/evidence/api-receipt.json"
cat >"$FLOOR_DIR/markers/F1.json" <<'JSON'
{"schemaVersion":1,"lane":"F1","sourceSha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","status":"pass","completedAt":"2026-09-12T10:00:00Z","evidence":["evidence/api-receipt.json"]}
JSON
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("floor pass without browser evidence"))' >/dev/null || {
  echo "expected an API-only pass on an undeclared floor lane to be refused" >&2; echo "$RESULT" >&2; exit 1; }

# A screenshot that actually exists on disk clears the barrier.
printf 'fake png bytes\n' >"$FLOOR_DIR/evidence/screenshot.png"
jq '.evidence = ["evidence/screenshot.png"]' "$FLOOR_DIR/markers/F1.json" >"$FLOOR_DIR/markers/.marker.json"
mv "$FLOOR_DIR/markers/.marker.json" "$FLOOR_DIR/markers/F1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a floor pass with a real screenshot on disk to be ready" >&2; exit 1; }

# A valid clip-skipped account is non-file evidence for a confirmed finding,
# never visual proof of the floor journey itself. The reason deliberately ends
# in .mp4 to prove a filename-looking suffix cannot manufacture browser media.
jq '.confirmedFindings = ["F1"] | .evidence = ["clip-skipped: F1: recorder could not write clips/F1.mp4"]' \
  "$FLOOR_DIR/markers/F1.json" >"$FLOOR_DIR/markers/.marker.json"
mv "$FLOOR_DIR/markers/.marker.json" "$FLOOR_DIR/markers/F1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("floor pass without browser evidence"))' >/dev/null || {
  echo "expected a clip-skipped line not to count as floor browser evidence" >&2; echo "$RESULT" >&2; exit 1; }

# Naming a screenshot that does not exist is refused by pass_evidence_problem
# already (evidence must be durable), and must stay refused for a floor lane
# too — not silently reclassified as the floor-specific reason.
jq 'del(.confirmedFindings) | .evidence = ["evidence/missing-screenshot.png"]' "$FLOOR_DIR/markers/F1.json" >"$FLOOR_DIR/markers/.marker.json"
mv "$FLOOR_DIR/markers/.marker.json" "$FLOOR_DIR/markers/F1.json"
RESULT="$(bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes || true)"
echo "$RESULT" | jq -e '(.ready == false) and (.invalidReasons[0] | contains("evidence file is missing"))' >/dev/null || {
  echo "expected a floor pass naming a nonexistent screenshot to be refused for the missing file" >&2; echo "$RESULT" >&2; exit 1; }

# A lane the contract declares `evidence:"api"` is exempt: its API receipts
# alone clear the barrier, because the declaration lives on the CONTRACT lane
# entry (never inferred from the marker).
jq '.lanes[0].evidence = "api"' "$FLOOR_DIR/completion-contract.json" >"$FLOOR_DIR/.contract.tmp"
mv "$FLOOR_DIR/.contract.tmp" "$FLOOR_DIR/completion-contract.json"
jq '.evidence = ["evidence/api-receipt.json"]' "$FLOOR_DIR/markers/F1.json" >"$FLOOR_DIR/markers/.marker.json"
mv "$FLOOR_DIR/markers/.marker.json" "$FLOOR_DIR/markers/F1.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a declared API-only floor lane with API receipts to be ready" >&2; exit 1; }

# A non-floor lane (default "lane" kind) with the same API-only evidence is
# untouched by this check — it only applies to kind == "floor".
jq '.lanes = [{"id":"F1","kind":"lane"}]' "$FLOOR_DIR/completion-contract.json" >"$FLOOR_DIR/.contract.tmp"
mv "$FLOOR_DIR/.contract.tmp" "$FLOOR_DIR/completion-contract.json"
bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FLOOR_DIR" lanes \
  | jq -e '.ready == true' >/dev/null || {
  echo "expected a non-floor lane with API-only evidence to be unaffected" >&2; exit 1; }

rm -rf "$FLOOR_DIR"

# --- pair re-freeze: lanes must be redispatched after it --------------------
# smoke-pair-identity.sh `refreeze` snapshots the contract's lane generations
# into coordinator/identity.json. A lane whose contract generation is not above
# its snapshot still carries old-pair evidence, so it must not clear `lanes` or
# `synthesis` even with an otherwise valid marker (issue #731, F3). The full
# flow through the real verbs is smoke-pair-identity.test.sh section 5.
RF="$FIXTURE_DIR/rf-run with spaces"
RF_SHA="ffffffffffffffffffffffffffffffffffffffff"
mkdir -p "$RF/markers" "$RF/coordinator" "$RF/challenger"
printf '# preliminary\n' > "$RF/coordinator/preliminary.md"
printf '# disposition\n' > "$RF/challenger/disposition.md"
rf_contract() { # <generation of X> <generation of Y>
  jq -n --arg sha "$RF_SHA" --argjson x "$1" --argjson y "$2" \
    '{schemaVersion:1,sourceSha:$sha,ownershipKind:"develop",
      requiredLaneMarkers:["markers/X.json","markers/Y.json"],
      lanes:[{id:"X",kind:"lane",generation:$x},{id:"Y",kind:"lane",generation:$y}]}' > "$RF/completion-contract.json"
}
rf_marker() { # <lane> <generation>
  jq -n --arg sha "$RF_SHA" --arg l "$1" --argjson g "$2" \
    '{schemaVersion:1,lane:$l,sourceSha:$sha,generation:$g,status:"completed",completedAt:"2026-09-12T10:00:00Z"}' > "$RF/markers/$1.json"
}
rf_identity_refrozen() {
  jq -n --arg sha "$RF_SHA" \
    '{ok:true,freezeGeneration:2,history:[{reason:"backend replaced"}],
      refreezeLaneSnapshot:{contractPresent:true,sourceSha:$sha,lanes:[{id:"X",generation:1},{id:"Y",generation:1}]}}' \
    > "$RF/coordinator/identity.json"
}
rf_barrier() { bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$RF" "$1" || true; }
rf_contract 1 1; rf_marker X 1; rf_marker Y 1

# No identity.json: a run that never used pair identity is unaffected.
rf_barrier synthesis | jq -e '.ready == true' >/dev/null || {
  echo "expected a run with no identity.json to be unaffected" >&2; exit 1; }
# identity.json as `start` writes it, no re-freeze: unaffected.
printf '{"ok":true,"freezeGeneration":1,"history":[]}\n' > "$RF/coordinator/identity.json"
rf_barrier synthesis | jq -e '.ready == true' >/dev/null || {
  echo "expected a run that never re-froze to be unaffected" >&2; exit 1; }

# Re-frozen, and neither lane redispatched: both refused with the re-freeze
# reason, in lanes and synthesis alike.
rf_identity_refrozen
for phase in lanes synthesis; do
  RESULT="$(rf_barrier "$phase")"
  echo "$RESULT" | jq -e '.ready == false and (.invalid | sort) == ["markers/X.json","markers/Y.json"]
    and all(.invalidReasons[]; contains("not redispatched since the pair re-freeze"))' >/dev/null || {
    echo "expected $phase to refuse lanes not redispatched after the re-freeze" >&2; echo "$RESULT" >&2; exit 1; }
  for lane in X Y; do
    printf -v expected_command '%q redispatch %q %q' "$SCRIPT_DIR/smoke-run-scaffold.sh" "$RF" "$lane"
    echo "$RESULT" | jq -e --arg command "run $expected_command, then re-run the lane" \
      'any(.invalidReasons[]; contains($command))' >/dev/null || {
      echo "expected runnable redispatch guidance including the quoted run directory and lane" >&2; exit 1; }
  done
done
# The challenger never waits on lanes, re-freeze or not.
rf_barrier disposition | jq -e '.ready == true' >/dev/null || {
  echo "expected the disposition gate to ignore the re-freeze snapshot" >&2; exit 1; }
# A lane still in flight on the old pair has no marker yet; it is refused for
# the redispatch, not reported as merely missing.
mv "$RF/markers/Y.json" "$RF/y.bak"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.missing == [] and ((.invalid | sort) == ["markers/X.json","markers/Y.json"])' >/dev/null || {
  echo "expected an un-redispatched lane with no marker to be refused for the redispatch" >&2; echo "$RESULT" >&2; exit 1; }
mv "$RF/y.bak" "$RF/markers/Y.json"

# Only X redispatched and re-run: Y is still refused, X clears.
rf_contract 2 1; rf_marker X 2
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and .invalid == ["markers/Y.json"]
  and (.invalidReasons[0] | contains("not redispatched since the pair re-freeze"))' >/dev/null || {
  echo "expected a partial redispatch to refuse only the lane left behind" >&2; echo "$RESULT" >&2; exit 1; }
# Y redispatched but its fresh marker not landed: the ordinary stale-generation
# reason takes over.
rf_contract 2 2
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and .invalid == ["markers/Y.json"] and (.invalidReasons[0] | contains("stale generation"))' >/dev/null || {
  echo "expected a redispatched lane to wait on its fresh marker" >&2; echo "$RESULT" >&2; exit 1; }
rf_marker Y 2
rf_barrier synthesis | jq -e '.ready == true' >/dev/null || {
  echo "expected every lane redispatched and re-run to clear synthesis" >&2; exit 1; }

# Fail closed: a re-frozen identity.json with no snapshot, or one that does not
# parse, refuses instead of reading as "nothing to redispatch".
jq -c 'del(.refreezeLaneSnapshot)' "$RF/coordinator/identity.json" > "$RF/id.tmp" && mv "$RF/id.tmp" "$RF/coordinator/identity.json"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and .invalid == ["coordinator/identity.json"] and (.invalidReasons[0] | contains("no lane snapshot"))' >/dev/null || {
  echo "expected a re-frozen identity.json with no snapshot to refuse" >&2; echo "$RESULT" >&2; exit 1; }
printf 'not json' > "$RF/coordinator/identity.json"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and .invalid == ["coordinator/identity.json"]' >/dev/null || {
  echo "expected an unparsable identity.json to refuse" >&2; echo "$RESULT" >&2; exit 1; }

# --- an emptied or falsified snapshot must not turn the redispatch rule off -
# refreeze-lanes.jq's absent-lane exemption ("a lane the snapshot never named
# is not stale once its generation clears the snapshot's highest") must not
# become a way to silence every required lane by wiping, or falsifying, the
# snapshot instead of deleting it outright (the del() case above).
rf_contract 1 1; rf_marker X 1; rf_marker Y 1

# Bypass 1: `lanes: []` — there is no recorded maximum generation for X or Y
# to legitimately exceed, so both must still be refused.
jq -n --arg sha "$RF_SHA" \
  '{ok:true,freezeGeneration:2,history:[{reason:"backend replaced"}],
    refreezeLaneSnapshot:{contractPresent:true,sourceSha:$sha,lanes:[]}}' \
  > "$RF/coordinator/identity.json"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and (.invalid | sort) == ["markers/X.json","markers/Y.json"]
  and all(.invalidReasons[]; contains("not redispatched since the pair re-freeze"))' >/dev/null || {
  echo "expected an emptied refreeze snapshot (lanes: []) to still refuse every required lane" >&2; echo "$RESULT" >&2; exit 1; }

# Bypass 2: `contractPresent:false` paired with a sourceSha is not a shape
# `refreeze` ever writes — a legitimate contractPresent:false always pairs
# with sourceSha:null — so refuse instead of reading it as "nothing was
# dispatched yet".
jq -n --arg sha "$RF_SHA" \
  '{ok:true,freezeGeneration:2,history:[{reason:"backend replaced"}],
    refreezeLaneSnapshot:{contractPresent:false,sourceSha:$sha,lanes:[]}}' \
  > "$RF/coordinator/identity.json"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '.ready == false and .invalid == ["coordinator/identity.json"]
  and (.invalidReasons[0] | contains("also records a sourceSha"))' >/dev/null || {
  echo "expected contractPresent:false paired with a sourceSha to refuse, not read as \"nothing dispatched yet\"" >&2; echo "$RESULT" >&2; exit 1; }

# A lane the snapshot never named (added after the re-freeze, so it could not
# have run on the old pair) clears once its generation is above the
# snapshot's highest — X and Y, still at the snapshot's own generation, stay
# refused for the real reason; Z, above it, is merely missing a marker.
rf_identity_refrozen
jq '.requiredLaneMarkers += ["markers/Z.json"] | .lanes += [{id:"Z",kind:"lane",generation:2}]' \
  "$RF/completion-contract.json" > "$RF/contract.tmp" && mv "$RF/contract.tmp" "$RF/completion-contract.json"
RESULT="$(rf_barrier synthesis)"
echo "$RESULT" | jq -e '
  (.invalid | sort) == ["markers/X.json","markers/Y.json"]
  and all(.invalidReasons[]; contains("not redispatched since the pair re-freeze"))
  and (.missing == ["markers/Z.json"])
' >/dev/null || {
  echo "expected a lane the snapshot never named, above its highest generation, not to be flagged as un-redispatched" >&2; echo "$RESULT" >&2; exit 1; }

# --- pair identity, when the contract requires it (XZO #2092) ---------------
# Two campaigns synthesised GO and published BLOCKED on "pair identity not ok
# (last check: none)" alone, because the only enforcement point was the
# controller's verdict and this barrier reported ready with no identity record
# at all. A contract carrying pairIdentity:"required" now owes it here. The
# MISSING -> INVALID transitions are asserted exactly: the controller re-offers
# an acknowledged step on a change in invalid[] and never on missing[], so which
# list an absence lands in decides whether the owner is ever told.
PI="$FIXTURE_DIR/pi run with spaces"
PI_SHA="1111111111111111111111111111111111111111"
mkdir -p "$PI/markers" "$PI/coordinator" "$PI/challenger"
pi_contract() { # [pairIdentity value, or "" to omit] [generation]
  jq -n --arg sha "$PI_SHA" --arg mode "${1-required}" --argjson g "${2:-1}" \
    '{schemaVersion:1,sourceSha:$sha,ownershipKind:"develop",
      requiredLaneMarkers:["markers/X.json","markers/Y.json"],
      lanes:[{id:"X",kind:"lane",generation:$g},{id:"Y",kind:"lane",generation:$g}]}
     + (if $mode == "" then {} else {pairIdentity:$mode} end)' > "$PI/completion-contract.json"
}
pi_marker() { # <lane> [generation]
  jq -n --arg sha "$PI_SHA" --arg l "$1" --argjson g "${2:-1}" \
    '{lane:$l,sourceSha:$sha,generation:$g,status:"completed",completedAt:"2026-09-22T10:00:00Z"}' > "$PI/markers/$1.json"
}
pi_freeze() { # [freezeGeneration]
  jq -n --argjson g "${1:-1}" --arg sha "$PI_SHA" \
    '{ok:true,freezeGeneration:$g,history:(if $g > 1 then [{reason:"backend replaced"}] else [] end),
      frontend:{service:"srv-pife000000001",deploy:"dep-pife000000001",commit:$sha},
      backend:{service:"srv-pibe000000001",deploy:"dep-pibe000000001",commit:$sha}}
     + (if $g > 1 then {refreezeLaneSnapshot:{contractPresent:true,sourceSha:$sha,
          lanes:[{id:"X",generation:1},{id:"Y",generation:1}]}} else {} end)' > "$PI/coordinator/identity.json"
}
pi_checks() { printf '%s\n' "$@" > "$PI/coordinator/identity-checks.ndjson"; }
pi_barrier() { bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$PI" "$1" || true; }
pi_expect() { # <phase> <jq predicate> <message>
  local out; out="$(pi_barrier "$1")"
  echo "$out" | jq -e "$2" >/dev/null || { echo "pair identity: $3" >&2; echo "$out" >&2; exit 1; }
}
pi_contract required

# The #2088 shape from the start: nothing frozen, no lane run yet. Normal first
# step, so it is progress (missing), not a refusal the owner is woken for.
pi_expect lanes '.ready == false and (.missing | index("coordinator/identity.json") != null) and .invalid == []' \
  "an unfrozen run with no lane evidence yet must list identity.json as missing, not refuse"
# A lane has written evidence against a pair nobody froze: a refusal, naming
# the PR-preview start command rather than the develop pair.
pi_marker X
pi_expect lanes '.invalid == ["coordinator/identity.json"]
    and (.invalidReasons[0] | contains("never frozen") and contains("smoke-pair-identity.sh start")
         and contains("never the develop pair"))' \
  "lane evidence with no frozen pair must be refused with the start command"
# #2045's shape: frozen, never checked. Lanes still running -> missing.
pi_freeze
pi_expect lanes '.invalid == [] and (.missing | index("coordinator/identity-checks.ndjson") != null)' \
  "a frozen run with lanes still outstanding must list the check record as missing"
# ...and the moment the last marker lands, a refusal carrying the exact check
# command with the FROZEN ids (never the gate env's develop pair).
pi_marker Y
for phase in lanes synthesis; do
  printf '# p\n' > "$PI/coordinator/preliminary.md"; printf '# d\n' > "$PI/challenger/disposition.md"
  pi_expect "$phase" '.ready == false and .invalid == ["coordinator/identity-checks.ndjson"]
      and (.invalidReasons[0] | contains("every lane marker is in")
           and contains("SMOKE_GATE_FRONTEND_SERVICE=srv-pife000000001 SMOKE_GATE_BACKEND_SERVICE=srv-pibe000000001"))' \
    "$phase: finished lanes with no check must be refused with the frozen-id check command"
done
# A clean record clears both phases.
pi_checks '{"label":"X-end","verdict":"ok","freezeGeneration":1}'
pi_expect lanes '.ready == true' "an ok check must clear lanes"
pi_expect synthesis '.ready == true' "an ok check must clear synthesis"
# The frozen record is validated BEFORE any receipt is trusted (#1039 round 3):
# `{}` plus a hand-written ok line used to read as ready, i.e. GO with no pair
# ever recorded. Each malformed shape refuses; the clean one above still passes.
cp "$PI/coordinator/identity.json" "$PI/id.good"
for bad in '{}' \
    "$(jq -c '.ok = false' "$PI/id.good")" \
    "$(jq -c 'del(.backend)' "$PI/id.good")" \
    "$(jq -c '.frontend.commit = ""' "$PI/id.good")" \
    "$(jq -c 'del(.backend.deploy)' "$PI/id.good")" \
    "$(jq -c '.freezeGeneration = 0' "$PI/id.good")" \
    '[]'; do
  printf '%s\n' "$bad" > "$PI/coordinator/identity.json"
  pi_expect synthesis '.ready == false and .invalid == ["coordinator/identity.json"]' \
    "a malformed identity.json ($bad) must refuse, not read as ready"
done
# ...and the round-3 shape is caught by THIS check, not by an unrelated rule.
printf '{}\n' > "$PI/coordinator/identity.json"
pi_expect synthesis '(.invalidReasons[0] | contains("not a frozen pair") and contains("ok is not true"))' \
  "an empty identity.json must be refused as not a frozen pair"
# A PR contract binds the freeze to its sourceSha: the record must name it and
# both frozen commits must equal it. (This hand-made pr contract is incomplete
# for the contract's own rules, so these assert only on identity.json.)
jq '.ownershipKind = "pr" | .coordinatorOwnerToken = "tok-pi-fixture-0001" | .pr = 9001 | .runId = "pi run with spaces"' "$PI/completion-contract.json" > "$PI/c.tmp" && mv "$PI/c.tmp" "$PI/completion-contract.json"
jq -c '. + {expectedSourceSha:"2222222222222222222222222222222222222222"}' "$PI/id.good" > "$PI/coordinator/identity.json"
pi_expect synthesis '(.invalid | index("coordinator/identity.json")) != null and any(.invalidReasons[]; contains("expectedSourceSha does not name"))' \
  "a PR freeze naming another sourceSha must refuse"
jq -c --arg s "$PI_SHA" '. + {expectedSourceSha:$s} | .backend.commit = "3333333333333333333333333333333333333333"' "$PI/id.good" > "$PI/coordinator/identity.json"
pi_expect synthesis '(.invalid | index("coordinator/identity.json")) != null and any(.invalidReasons[]; contains("frozen commits are not"))' \
  "a PR freeze whose commits are not the sourceSha must refuse"
jq -c --arg s "$PI_SHA" '. + {expectedSourceSha:$s}' "$PI/id.good" > "$PI/coordinator/identity.json"
pi_expect synthesis '(.invalid | index("coordinator/identity.json")) == null' "a well-formed PR freeze must not be refused"
pi_contract required
cp "$PI/id.good" "$PI/coordinator/identity.json"
# A genuine mismatch is NOT cleared by a later ok: the pair did change.
for bad in drift source-mismatch; do
  pi_checks "{\"label\":\"X-start\",\"verdict\":\"$bad\",\"freezeGeneration\":1}" \
            '{"label":"X-end","verdict":"ok","freezeGeneration":1}'
  pi_expect synthesis ".ready == false and .invalid == [\"coordinator/identity-checks.ndjson\"]
      and (.invalidReasons[0] | contains(\"recorded $bad\") and contains(\"refreeze\") and contains(\"never re-run start\"))" \
    "a $bad followed by an ok check must stay refused"
done
# A transient unreadable read is cleared by the next good read, but not before.
pi_checks '{"label":"a","verdict":"ok"}' '{"label":"b","verdict":"unreadable"}'
pi_expect lanes '.invalid == ["coordinator/identity-checks.ndjson"] and (.invalidReasons[0] | contains("is unreadable, not ok"))' \
  "a latest unreadable check must be refused"
pi_checks '{"label":"a","verdict":"ok"}' '{"label":"b","verdict":"unreadable"}' '{"label":"c","verdict":"ok"}'
pi_expect lanes '.ready == true' "an unreadable read followed by an ok read must clear"
# A damaged record cannot be healed by appending, so it says so.
pi_checks '{"label":"a","verdict":"ok"}' 'not json'
pi_expect lanes '.invalid == ["coordinator/identity-checks.ndjson"]
    and (.invalidReasons[0] | contains("line 2 is not a JSON object") and contains("cannot repair it"))' \
  "a damaged check record must be refused as unrepairable by another check"
# A refreeze retires the old generation's receipts: a drift at generation 1
# does not block a clean generation-2 record once every lane is redispatched.
pi_contract required 2; pi_marker X 2; pi_marker Y 2; pi_freeze 2
pi_checks '{"label":"X-mid","verdict":"drift","freezeGeneration":1}' '{"label":"X-end","verdict":"ok","freezeGeneration":2}'
pi_expect synthesis '.ready == true' "a drift at a retired freeze generation must not block the current one"
# ...and generation-1 receipts alone do not satisfy generation 2.
pi_checks '{"label":"X-end","verdict":"ok","freezeGeneration":1}'
pi_expect synthesis '.invalid == ["coordinator/identity-checks.ndjson"] and (.invalidReasons[0] | contains("generation 2"))' \
  "receipts from a retired generation alone must not satisfy the current one"
# An unknown mode refuses instead of switching the check off.
pi_contract yes 2
pi_expect lanes '.invalid == ["completion-contract.json"] and (.invalidReasons[0] | contains("the only value is \"required\""))' \
  "an unknown pairIdentity value must refuse"
# No field: the barrier's previous answer, exactly -- identity files or not.
pi_contract "" 2
mv "$PI/coordinator/identity.json" "$PI/coordinator/identity.json.off"
mv "$PI/coordinator/identity-checks.ndjson" "$PI/coordinator/identity-checks.ndjson.off"
pi_expect synthesis '.ready == true' "a contract without pairIdentity must be unaffected by the missing identity record"
# The challenger's disposition gate never waits on pair identity.
pi_contract required
pi_expect disposition '.ready == true' "the disposition gate must ignore pair identity"

echo "smoke evidence barrier tests passed"
