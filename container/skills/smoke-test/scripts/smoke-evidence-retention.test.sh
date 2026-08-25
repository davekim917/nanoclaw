#!/usr/bin/env bash
# Dry-run-deletes-nothing, age threshold, active-run protection,
# verdict/hold-referenced protection, media-pruned-but-record-survives,
# empty clips dirs removed, and nothing-to-do exits 0. No network — plain
# tmpdir fixtures, same offline convention as the sibling *.test.sh files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-evidence-retention.sh"

FIXTURE_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$FIXTURE_ROOT"; }
trap cleanup EXIT

RUNS="$FIXTURE_ROOT/runs"
STATE_DIR="$FIXTURE_ROOT/gate-state"
mkdir -p "$RUNS" "$STATE_DIR"
export SMOKE_GATE_STATE_DIR="$STATE_DIR"
export SMOKE_RETENTION_MEDIA_DAYS=14

# make_run <id> <age-days> [screenshot-count]
make_run() {
  local id="$1" age="$2" shots="${3:-2}" dir="$RUNS/$1"
  mkdir -p "$dir/screenshots" "$dir/lanes" "$dir/markers"
  printf '# run record\n' > "$dir/run-record.md"
  printf '{"lane":"B1","status":"pass"}\n' > "$dir/markers/B1.json"
  printf '# lane B1\n' > "$dir/lanes/B1.md"
  for i in $(seq 1 "$shots"); do
    printf 'fake-png-bytes' > "$dir/screenshots/shot-$i.png"
  done
  touch -d "-${age} days" "$dir" "$dir/screenshots" "$dir/lanes" "$dir/markers"
}

make_empty_clips() {
  mkdir -p "$RUNS/$1/clips"
  touch -d "-${2} days" "$RUNS/$1/clips" "$RUNS/$1"
}

# --- 1. Dry-run deletes nothing, even for a clearly-eligible old run --------
make_run old-plain 30
OUT="$(bash "$SCRIPT" "$RUNS")"
jq -e '.ok == true and .dryRun == true and .runsPruned == 1 and .mediaFiles == 2' <<<"$OUT" >/dev/null
[ -e "$RUNS/old-plain/screenshots/shot-1.png" ] || { echo "dry run deleted a file" >&2; exit 1; }
[ -e "$RUNS/old-plain/run-record.md" ] || { echo "dry run touched the record" >&2; exit 1; }
rm -rf "$RUNS/old-plain"

# --- 2. Age threshold respected: a fresh run is left alone, even with --delete
make_run fresh-run 2
bash "$SCRIPT" "$RUNS" --delete | jq -e '.runsPruned == 0 and .tooYoung == 1' >/dev/null
[ -e "$RUNS/fresh-run/screenshots/shot-1.png" ] || { echo "too-young run was pruned" >&2; exit 1; }
rm -rf "$RUNS/fresh-run"

# --- 3. Active run protected regardless of age -----------------------------
make_run active-run 90
printf '{"schemaVersion":1,"pr":7,"activeRunId":"active-run"}\n' > "$STATE_DIR/pr-7-state.json"
OUT="$(bash "$SCRIPT" "$RUNS" --delete)"
jq -e '.protected == 1 and .runsPruned == 0 and .protectionSources.stateDirFound == true' <<<"$OUT" >/dev/null
[ -e "$RUNS/active-run/screenshots/shot-1.png" ] || { echo "active run was pruned" >&2; exit 1; }
rm -f "$STATE_DIR/pr-7-state.json"
rm -rf "$RUNS/active-run"

# --- 4. Run referenced by the current published verdict is protected -------
make_run verdict-run 90
PUBLISH_FILE="$FIXTURE_ROOT/latest-verdict.json"
printf '{"schemaVersion":1,"sha":"deadbeef","runId":"verdict-run","verdict":"GO"}\n' > "$PUBLISH_FILE"
export SMOKE_GATE_PUBLISH_FILE="$PUBLISH_FILE"
OUT="$(bash "$SCRIPT" "$RUNS" --delete)"
jq -e '.protected == 1 and .runsPruned == 0 and .protectionSources.publishFileFound == true' <<<"$OUT" >/dev/null
[ -e "$RUNS/verdict-run/screenshots/shot-1.png" ] || { echo "verdict-referenced run was pruned" >&2; exit 1; }
unset SMOKE_GATE_PUBLISH_FILE
rm -rf "$RUNS/verdict-run"

# --- 4b. Run referenced by the current hold file is protected --------------
make_run hold-run 90
HOLD_FILE="$FIXTURE_ROOT/develop-hold.json"
printf '{"schemaVersion":1,"sha":"deadbeef","runId":"hold-run","verdict":"NO_GO"}\n' > "$HOLD_FILE"
export SMOKE_GATE_HOLD_FILE="$HOLD_FILE"
bash "$SCRIPT" "$RUNS" --delete | jq -e '.protected == 1 and .protectionSources.holdFileFound == true' >/dev/null
[ -e "$RUNS/hold-run/screenshots/shot-1.png" ] || { echo "hold-referenced run was pruned" >&2; exit 1; }
unset SMOKE_GATE_HOLD_FILE
rm -rf "$RUNS/hold-run"

# --- 4c. Run referenced by a recent handoff-ledger entry is protected ------
make_run handoff-run 90
LEDGER="$STATE_DIR/handoff-ledger.jsonl"
printf '{"schemaVersion":1,"targetSha":"aaa","runId":"some-older-run","verdict":"GO","finishedAt":"2026-01-01T00:00:00Z"}\n' > "$LEDGER"
printf '{"schemaVersion":1,"targetSha":"bbb","runId":"handoff-run","verdict":"NO_GO","finishedAt":"2026-08-20T00:00:00Z"}\n' >> "$LEDGER"
bash "$SCRIPT" "$RUNS" --delete | jq -e '.protected == 1 and .protectionSources.handoffLedgerFound == true' >/dev/null
[ -e "$RUNS/handoff-run/screenshots/shot-1.png" ] || { echo "handoff-ledger-referenced run was pruned" >&2; exit 1; }
rm -f "$LEDGER"
rm -rf "$RUNS/handoff-run"

# --- 5. Media pruned, markdown/JSON record survives -------------------------
make_run media-vs-record 30
bash "$SCRIPT" "$RUNS" --delete | jq -e '.runsPruned == 1 and .mediaFiles == 2' >/dev/null
[ -e "$RUNS/media-vs-record/screenshots/shot-1.png" ] && { echo "png survived pruning" >&2; exit 1; }
[ -e "$RUNS/media-vs-record/run-record.md" ] || { echo "run-record.md was pruned" >&2; exit 1; }
[ -e "$RUNS/media-vs-record/lanes/B1.md" ] || { echo "lane markdown was pruned" >&2; exit 1; }
[ -e "$RUNS/media-vs-record/markers/B1.json" ] || { echo "marker json was pruned" >&2; exit 1; }
rm -rf "$RUNS/media-vs-record"

# --- 6. Empty clips/ dirs are removed on an eligible run --------------------
make_run with-empty-clips 30 0
make_empty_clips with-empty-clips 30
[ -d "$RUNS/with-empty-clips/clips" ] || { echo "fixture setup broken" >&2; exit 1; }
bash "$SCRIPT" "$RUNS" --delete | jq -e '.emptyDirsRemoved >= 1' >/dev/null
[ -d "$RUNS/with-empty-clips/clips" ] && { echo "empty clips dir survived" >&2; exit 1; }
[ -e "$RUNS/with-empty-clips/run-record.md" ] || { echo "record was destroyed alongside the empty clips dir" >&2; exit 1; }
rm -rf "$RUNS/with-empty-clips"

# --- 7. Nothing to do: empty run root exits 0 with a clean report ----------
EMPTY_ROOT="$FIXTURE_ROOT/empty-runs"
mkdir -p "$EMPTY_ROOT"
bash "$SCRIPT" "$EMPTY_ROOT" --delete | jq -e '
  .ok == true and .scanned == 0 and .runsPruned == 0 and .affected == []
' >/dev/null

# --- 8. Usage errors ---------------------------------------------------------
OUT="$(bash "$SCRIPT" 2>&1 || true)"
jq -e '.ok == false and (.error | test("usage"))' <<<"$OUT" >/dev/null
OUT="$(bash "$SCRIPT" "$FIXTURE_ROOT/does-not-exist" 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not exist"))' <<<"$OUT" >/dev/null

# --- 9. --delete fails closed when NO protection source resolved -----------
# The protection set is the only thing keeping an active or verdict-referenced
# run out of the prune list. If every source is missing it is vacuously empty,
# which is indistinguishable in the output from "nothing needed protecting" —
# so deleting then is protection-did-not-run, not protection-found-nothing.
NAKED="$FIXTURE_ROOT/naked-runs"
mkdir -p "$NAKED"
RUNS_SAVE="$RUNS"; RUNS="$NAKED"
make_run unprotectable 30 3
RUNS="$RUNS_SAVE"
(
  unset SMOKE_GATE_STATE_DIR SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE
  unset SMOKE_RETENTION_HANDOFF_LEDGER SMOKE_GATE_HANDOFF_LEDGER
  OUT="$(bash "$SCRIPT" "$NAKED" --delete 2>&1 || true)"
  jq -e '.ok == false and (.error | test("no protection source resolved"))' <<<"$OUT" >/dev/null \
    || { echo "expected --delete to refuse with no protection source, got: $OUT" >&2; exit 1; }
) || exit 1
find "$NAKED/unprotectable" -name '*.png' | grep -q . \
  || { echo "media was deleted despite the refusal" >&2; exit 1; }

# ...and the explicit escape hatch still deletes, so the guard is a gate and
# not a wall for a corpus that genuinely has no live gate behind it.
(
  unset SMOKE_GATE_STATE_DIR SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE
  unset SMOKE_RETENTION_HANDOFF_LEDGER SMOKE_GATE_HANDOFF_LEDGER
  bash "$SCRIPT" "$NAKED" --delete --unprotected | jq -e '.ok == true and .runsPruned >= 1' >/dev/null
) || exit 1

# A dry run must still REPORT with no protection source — that empty
# protectionSources block is how an operator discovers a mis-mounted state dir.
(
  unset SMOKE_GATE_STATE_DIR SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE
  unset SMOKE_RETENTION_HANDOFF_LEDGER SMOKE_GATE_HANDOFF_LEDGER
  bash "$SCRIPT" "$NAKED" | jq -e '.ok == true and .dryRun == true' >/dev/null
) || exit 1
rm -rf "$NAKED"

echo "smoke evidence retention tests passed"
