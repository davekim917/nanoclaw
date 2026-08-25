#!/usr/bin/env bash
# Prunes aged run evidence under a smoke-test run root. Nothing here prunes by
# itself: it is a script an operator or a scheduled task runs deliberately.
#
# Media (screenshots/clips/binaries, by extension) ages out on its own short
# clock; the markdown/JSON record (run-record.md, lane files, markers,
# manifests, dispositions, verdicts) is small and IS the audit trail, so it
# survives independently and much longer by default (forever, unless
# SMOKE_RETENTION_RECORD_DAYS is explicitly set).
#
# Two protections apply BEFORE any age check, and a protected run is skipped
# entirely — no media pruning, no record pruning:
#   1. Any run id currently live as `activeRunId` in a pr-*-state.json or
#      develop-state.json under SMOKE_GATE_STATE_DIR (reused from the gate
#      scripts — same env, same default). Deliberately NOT liveness-checked
#      (active_run_is_live()'s staleness window is the gate's own concern,
#      not this script's); an active claim is protected regardless of age.
#   2. Any run id named by the current SMOKE_GATE_PUBLISH_FILE (latest
#      published verdict), SMOKE_GATE_HOLD_FILE (current promotion hold), or
#      the most recent SMOKE_RETENTION_HANDOFF_RECENT_COUNT lines of the
#      handoff ledger (SMOKE_GATE_HANDOFF_LEDGER, same default path the
#      develop gate uses: $SMOKE_GATE_STATE_DIR/handoff-ledger.jsonl). These
#      are the durable artifacts a release decision or a human audit reads
#      back — pruning their evidence out from under them defeats the point of
#      keeping a hold/verdict file at all.
# Any of the three sources being absent/unset/unreadable just contributes no
# protected ids from that source — never a hard failure — but the JSON report
# always states which sources it actually found, so a misconfigured deployment
# is a visible field, not a silent hole in the protection set. A ledger with
# torn/malformed lines is skipped line-by-line rather than truncating the scan,
# and the count is reported as `protectionSources.handoffLedgerMalformedLines`.
#
# OPERATOR ESCAPE HATCH: `--unprotected` skips the fail-closed refusal below and
# deletes on a corpus with no live gate. It is deliberately NOT named in the
# refusal's `error` string — that string is machine-parsed, and advertising the
# bypass there teaches an automated caller to defeat the guard. It IS printed
# by `--help`, for the human who actually needs it.
#
# Dry run by DEFAULT. Pass --delete to actually remove anything. One JSON line
# on stdout, same convention as the sibling gate scripts. Exit 0 on success
# (including nothing-to-prune), 1 on nothing to prune only when the run root
# itself is missing... no: exit 0 is success, non-zero only on a real error
# (bad args, unreadable run root). See the `die`/arg checks below.
set -u

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

# `--delete` may appear anywhere in the argument list, same convention as
# `--takeover` in the gate scripts.
DELETE=false
UNPROTECTED=false
HELP=false
_ARGS=()
for _a in "$@"; do
  case "$_a" in
    --delete) DELETE=true ;;
    --unprotected) UNPROTECTED=true ;;
    -h|--help) HELP=true ;;
    *) _ARGS+=("$_a") ;;
  esac
done
set -- ${_ARGS[@]+"${_ARGS[@]}"}

# Human-facing, so it goes to stderr and leaves the one-JSON-line stdout
# contract intact for every other path.
if [ "$HELP" = true ]; then
  cat >&2 <<'USAGE'
smoke-evidence-retention.sh <run-root> [--delete] [--unprotected]

  <run-root>       directory whose immediate subdirectories are run ids
  --delete         actually remove things (default is a dry run)
  --unprotected    OPERATOR ONLY. Skip the fail-closed refusal that fires when
                   no protection source resolved, and delete anyway. Use only
                   on an archived corpus with no live gate behind it: with no
                   protection set, an active run's evidence is indistinguishable
                   from an abandoned one and will be pruned out from under the
                   gate still reading it.
  -h, --help       this text

Environment: SMOKE_RETENTION_MEDIA_DAYS, SMOKE_RETENTION_RECORD_DAYS,
SMOKE_RETENTION_MEDIA_EXTENSIONS, SMOKE_RETENTION_HANDOFF_RECENT_COUNT,
SMOKE_GATE_STATE_DIR, SMOKE_GATE_PUBLISH_FILE, SMOKE_GATE_HOLD_FILE,
SMOKE_GATE_HANDOFF_LEDGER.
USAGE
  exit 0
fi

RUN_ROOT="${1:-}"
[ -n "$RUN_ROOT" ] || die "usage: smoke-evidence-retention.sh <run-root> [--delete] (see --help)"
[ -d "$RUN_ROOT" ] || die "run root does not exist or is not a directory: $RUN_ROOT"

MEDIA_DAYS="${SMOKE_RETENTION_MEDIA_DAYS:-14}"
RECORD_DAYS="${SMOKE_RETENTION_RECORD_DAYS:-0}"
MEDIA_EXTENSIONS="${SMOKE_RETENTION_MEDIA_EXTENSIONS:-png,jpg,jpeg,gif,webp,mp4,webm,mov}"
HANDOFF_RECENT_COUNT="${SMOKE_RETENTION_HANDOFF_RECENT_COUNT:-20}"
STATE_DIR="${SMOKE_GATE_STATE_DIR:-/workspace/agent/smoke-gate}"
PUBLISH_FILE="${SMOKE_GATE_PUBLISH_FILE:-}"
HOLD_FILE="${SMOKE_GATE_HOLD_FILE:-}"
HANDOFF_LEDGER="${SMOKE_GATE_HANDOFF_LEDGER:-$STATE_DIR/handoff-ledger.jsonl}"

printf '%s' "$MEDIA_DAYS" | grep -Eq '^[0-9]+$' || die "SMOKE_RETENTION_MEDIA_DAYS must be a non-negative integer"
printf '%s' "$RECORD_DAYS" | grep -Eq '^[0-9]+$' || die "SMOKE_RETENTION_RECORD_DAYS must be a non-negative integer"
if [ "$RECORD_DAYS" -ne 0 ] && [ "$RECORD_DAYS" -lt "$MEDIA_DAYS" ]; then
  die "SMOKE_RETENTION_RECORD_DAYS must be 0 (never) or >= SMOKE_RETENTION_MEDIA_DAYS"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PROTECTED_FILE="$TMP_DIR/protected.txt"
: > "$PROTECTED_FILE"

STATE_DIR_FOUND=false
if [ -d "$STATE_DIR" ]; then
  STATE_DIR_FOUND=true
  for f in "$STATE_DIR"/pr-*-state.json "$STATE_DIR"/develop-state.json; do
    [ -e "$f" ] || continue
    jq -r '.activeRunId // empty' "$f" 2>/dev/null
  done >> "$PROTECTED_FILE"
fi

PUBLISH_FOUND=false
if [ -n "$PUBLISH_FILE" ] && [ -s "$PUBLISH_FILE" ]; then
  PUBLISH_FOUND=true
  jq -r '.runId // empty' "$PUBLISH_FILE" 2>/dev/null >> "$PROTECTED_FILE"
fi

HOLD_FOUND=false
if [ -n "$HOLD_FILE" ] && [ -s "$HOLD_FILE" ]; then
  HOLD_FOUND=true
  jq -r '.runId // empty' "$HOLD_FILE" 2>/dev/null >> "$PROTECTED_FILE"
fi

LEDGER_FOUND=false
LEDGER_MALFORMED=0
if [ -s "$HANDOFF_LEDGER" ]; then
  LEDGER_FOUND=true
  LEDGER_TAIL="$TMP_DIR/ledger-tail.txt"
  tail -n "$HANDOFF_RECENT_COUNT" "$HANDOFF_LEDGER" > "$LEDGER_TAIL"
  # `-R` + `fromjson?` per line: a malformed line is SKIPPED and the scan keeps
  # going. Plain `jq -r` streams the file as one document and aborts at the
  # first bad line, so every NEWER protected id after it was silently lost —
  # and `2>/dev/null` hid the abort while the report still said
  # handoffLedgerFound:true. Under --delete that pruned runs the gate still
  # reads. The ledger is append-only from another process, so a torn final
  # write is a normal event, not an exotic one.
  jq -rR 'fromjson? | select(type == "object") | .runId // empty' \
    "$LEDGER_TAIL" 2>/dev/null >> "$PROTECTED_FILE"
  LEDGER_NONBLANK="$(grep -cve '^[[:space:]]*$' "$LEDGER_TAIL" 2>/dev/null || true)"
  LEDGER_PARSED="$(jq -rRn '[inputs | fromjson? | select(type == "object")] | length' \
    "$LEDGER_TAIL" 2>/dev/null || printf '')"
  printf '%s' "$LEDGER_NONBLANK" | grep -Eq '^[0-9]+$' || LEDGER_NONBLANK=0
  printf '%s' "$LEDGER_PARSED" | grep -Eq '^[0-9]+$' || LEDGER_PARSED=0
  if [ "$LEDGER_NONBLANK" -gt "$LEDGER_PARSED" ]; then
    LEDGER_MALFORMED="$(( LEDGER_NONBLANK - LEDGER_PARSED ))"
  fi
fi

sort -u -o "$PROTECTED_FILE" "$PROTECTED_FILE"
# `--` because a run id may legitimately start with `-` (a run prefix from a
# wrapper, a hand-made directory), and grep would otherwise parse it as an
# option, fail, and report the run UNPROTECTED — a delete-side fail-open.
is_protected() { grep -qxF -- "$1" "$PROTECTED_FILE" 2>/dev/null; }

# Extension list -> a `find -iname` OR-expression, built once.
IFS=',' read -ra EXT_LIST <<<"$MEDIA_EXTENSIONS"
FIND_EXPR=()
for ext in "${EXT_LIST[@]}"; do
  ext="$(printf '%s' "$ext" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [ -n "$ext" ] || continue
  [ "${#FIND_EXPR[@]}" -gt 0 ] && FIND_EXPR+=(-o)
  FIND_EXPR+=(-iname "*.$ext")
done

# Fail closed when NO protection source resolved. The protection set is the
# only thing standing between this script and a run the gate still needs; if
# every source is missing, that set is vacuously empty and every aged run looks
# unprotected. Deleting then is not "nothing to protect", it is "protection did
# not run" — and the two are indistinguishable from the output, which is
# exactly how a safety mechanism becomes ceremony. A dry run still reports
# normally: seeing the empty protection block is how an operator discovers the
# state dir is not mounted where they thought.
if [ "$DELETE" = true ] && [ "$UNPROTECTED" != true ] &&
   [ "$STATE_DIR_FOUND" != true ] && [ "$PUBLISH_FOUND" != true ] &&
   [ "$HOLD_FOUND" != true ] && [ "$LEDGER_FOUND" != true ]; then
  # The message deliberately does NOT name the bypass flag. This `error` string
  # is machine-parsed, and a scheduled-task LLM reading "pass --unprotected to
  # delete anyway" will eventually do exactly that — the refusal would be
  # teaching its own defeat. The escape hatch still exists for an operator; it
  # is documented in the header comment and in `--help`.
  jq -cn --arg runRoot "$RUN_ROOT" \
    '{ok:false,
      error:"refusing to delete: no protection source resolved, so active and verdict-referenced runs cannot be excluded. Set SMOKE_GATE_STATE_DIR, SMOKE_GATE_PUBLISH_FILE, SMOKE_GATE_HOLD_FILE or the handoff ledger and re-run. Re-run without --delete to see what would be pruned.",
      runRoot:$runRoot,
      protectionSources:{stateDirFound:false, publishFileFound:false,
                         holdFileFound:false, handoffLedgerFound:false}}'
  exit 1
fi

NOW="$(date -u +%s)"
SCANNED=0
PROTECTED_COUNT=0
TOO_YOUNG=0
RUNS_PRUNED=0
RUNS_REMOVED=0
MEDIA_FILES_TOTAL=0
MEDIA_BYTES_TOTAL=0
EMPTY_DIRS_TOTAL=0
AFFECTED='[]'
OLDEST_AGE=-1
OLDEST_RUN=""
NEWEST_AGE=999999999
NEWEST_RUN=""

while IFS= read -r run_dir; do
  [ -n "$run_dir" ] || continue
  run_id="$(basename "$run_dir")"
  SCANNED=$((SCANNED + 1))

  if is_protected "$run_id"; then
    PROTECTED_COUNT=$((PROTECTED_COUNT + 1))
    continue
  fi

  mtime="$(stat -c %Y "$run_dir" 2>/dev/null || echo "$NOW")"
  age_days=$(( (NOW - mtime) / 86400 ))
  if [ "$age_days" -lt "$MEDIA_DAYS" ]; then
    TOO_YOUNG=$((TOO_YOUNG + 1))
    continue
  fi

  MEDIA_LIST="$TMP_DIR/media-$SCANNED.txt"
  find "$run_dir" -type f \( "${FIND_EXPR[@]}" \) > "$MEDIA_LIST" 2>/dev/null
  file_count="$(wc -l < "$MEDIA_LIST" | tr -d ' ')"
  byte_total=0
  if [ "$file_count" -gt 0 ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      sz="$(stat -c %s "$f" 2>/dev/null || echo 0)"
      byte_total=$((byte_total + sz))
    done < "$MEDIA_LIST"
  fi

  will_remove_whole_run=false
  if [ "$RECORD_DAYS" -ne 0 ] && [ "$age_days" -ge "$RECORD_DAYS" ]; then
    will_remove_whole_run=true
  fi

  if [ "$DELETE" = true ]; then
    if [ "$file_count" -gt 0 ]; then
      xargs -r rm -f -- < "$MEDIA_LIST"
    fi
    if [ "$will_remove_whole_run" = true ]; then
      rm -rf -- "$run_dir"
      RUNS_REMOVED=$((RUNS_REMOVED + 1))
    else
      # find -depth visits children before their parent, so an emptied
      # screenshots/clips dir is removed before we ask whether the run dir
      # itself is now empty too (it usually isn't — the record files remain).
      empty_before="$(find "$run_dir" -depth -type d -empty 2>/dev/null | wc -l | tr -d ' ')"
      find "$run_dir" -depth -type d -empty -delete 2>/dev/null || true
      EMPTY_DIRS_TOTAL=$((EMPTY_DIRS_TOTAL + empty_before))
    fi
  fi

  if [ "$file_count" -gt 0 ] || [ "$will_remove_whole_run" = true ]; then
    RUNS_PRUNED=$((RUNS_PRUNED + 1))
    MEDIA_FILES_TOTAL=$((MEDIA_FILES_TOTAL + file_count))
    MEDIA_BYTES_TOTAL=$((MEDIA_BYTES_TOTAL + byte_total))
    AFFECTED="$(jq -c --arg id "$run_id" --argjson age "$age_days" \
      --argjson files "$file_count" --argjson bytes "$byte_total" \
      --argjson wholeRun "$will_remove_whole_run" \
      '. + [{runId:$id, ageDays:$age, mediaFiles:$files, mediaBytes:$bytes, runRemoved:$wholeRun}]' \
      <<<"$AFFECTED")"
    if [ "$age_days" -gt "$OLDEST_AGE" ]; then OLDEST_AGE="$age_days"; OLDEST_RUN="$run_id"; fi
    if [ "$age_days" -lt "$NEWEST_AGE" ]; then NEWEST_AGE="$age_days"; NEWEST_RUN="$run_id"; fi
  fi
done < <(find "$RUN_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)

jq -cn \
  --argjson ok true \
  --argjson dryRun "$([ "$DELETE" = true ] && echo false || echo true)" \
  --arg runRoot "$RUN_ROOT" \
  --argjson mediaDays "$MEDIA_DAYS" \
  --argjson recordDays "$RECORD_DAYS" \
  --argjson scanned "$SCANNED" \
  --argjson protectedCount "$PROTECTED_COUNT" \
  --argjson tooYoung "$TOO_YOUNG" \
  --argjson runsPruned "$RUNS_PRUNED" \
  --argjson runsRemoved "$RUNS_REMOVED" \
  --argjson mediaFiles "$MEDIA_FILES_TOTAL" \
  --argjson mediaBytes "$MEDIA_BYTES_TOTAL" \
  --argjson emptyDirsRemoved "$EMPTY_DIRS_TOTAL" \
  --argjson affected "$AFFECTED" \
  --arg oldestRun "$OLDEST_RUN" --arg newestRun "$NEWEST_RUN" \
  --argjson stateDirFound "$STATE_DIR_FOUND" \
  --argjson publishFileFound "$PUBLISH_FOUND" \
  --argjson holdFileFound "$HOLD_FOUND" \
  --argjson handoffLedgerFound "$LEDGER_FOUND" \
  --argjson handoffLedgerMalformedLines "$LEDGER_MALFORMED" \
  '{ok:$ok, dryRun:$dryRun, runRoot:$runRoot,
    mediaDays:$mediaDays, recordDays:$recordDays,
    scanned:$scanned, protected:$protectedCount, tooYoung:$tooYoung,
    runsPruned:$runsPruned, runsRemoved:$runsRemoved,
    mediaFiles:$mediaFiles, mediaBytes:$mediaBytes,
    emptyDirsRemoved:$emptyDirsRemoved,
    oldestAffectedRun:(if $oldestRun == "" then null else $oldestRun end),
    newestAffectedRun:(if $newestRun == "" then null else $newestRun end),
    affected:$affected,
    protectionSources:{stateDirFound:$stateDirFound, publishFileFound:$publishFileFound,
                        holdFileFound:$holdFileFound, handoffLedgerFound:$handoffLedgerFound,
                        handoffLedgerMalformedLines:$handoffLedgerMalformedLines}}'
exit 0
