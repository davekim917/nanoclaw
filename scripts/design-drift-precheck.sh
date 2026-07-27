#!/bin/bash
# Pre-task script for the monthly design-artifact-loop drift check.
#
# Runs IN the example-agent container as the scheduling pre-check (see
# container/agent-runner/src/scheduling/task-script.ts). It does the deterministic
# MECHANICAL layer only — the technique judgment is the agent's job (the prompt). It
# prints exactly one JSON line as its LAST stdout line:
#
#     {"wakeAgent": <bool>, "data": { ... }}
#
# wakeAgent=true only when something is worth the agent's attention: a vendored file
# changed upstream, a system was added upstream since last check, or the upstream
# CHANGELOG moved. A clean baseline run is silent (wakeAgent=false) and just snapshots.
#
# Constraints (task-script.ts): 30s timeout, 1MB stdout cap, ONLY the last stdout line
# is parsed — so all logging goes to stderr. Tools: curl + jq + git (all in the image;
# the upstream-check pre-check uses the same set). No python, no claude here.
#
# Env overrides (for host testing; container uses the defaults):
#   DRIFT_VENDOR_DIR  - vendored design-systems dir (default: container mount path)
#   DRIFT_STATE_DIR   - where the snapshot state file lives (default: /workspace/agent)
#
# Host test:
#   DRIFT_VENDOR_DIR=container/skills/design-artifact-loop/design-systems \
#   DRIFT_STATE_DIR=/tmp DRIFT_RESET=1 bash scripts/design-drift-precheck.sh | jq .

set -uo pipefail

UPSTREAM_REPO="nexu-io/open-design"
VENDOR_DIR="${DRIFT_VENDOR_DIR:-/app/skills/design-artifact-loop/design-systems}"
STATE_DIR="${DRIFT_STATE_DIR:-/workspace/agent}"
STATE_FILE="$STATE_DIR/.design-drift-state.json"
API="https://api.github.com/repos/$UPSTREAM_REPO"
RAW="https://raw.githubusercontent.com/$UPSTREAM_REPO"

log() { echo "[design-drift-precheck] $*" >&2; }
# On any unexpected failure, emit a silent (no-wake) result so the scheduler skips the
# turn rather than the task erroring out. Advisory check — a flaky API is not an alarm.
emit_silent() { jq -cn --arg e "$1" '{wakeAgent:false, data:{error:$e}}'; exit 0; }

command -v jq  >/dev/null 2>&1 || { echo '{"wakeAgent":false,"data":{"error":"jq missing"}}'; exit 0; }
command -v git >/dev/null 2>&1 || emit_silent "git missing"

TMP_TREE="$(mktemp)"
trap 'rm -f "$TMP_TREE"' EXIT

# --- 0. default branch (reachability probe) ---
BRANCH="$(curl -fsS "$API" 2>/dev/null | jq -r '.default_branch // empty' 2>/dev/null)"
[ -z "$BRANCH" ] && emit_silent "cannot reach $UPSTREAM_REPO"
log "default branch: $BRANCH"

# --- 1. upstream tree (one recursive call) ---
if ! curl -fsS "$API/git/trees/$BRANCH?recursive=1" -o "$TMP_TREE" 2>/dev/null; then
  emit_silent "tree fetch failed"
fi
jq -e '.tree' "$TMP_TREE" >/dev/null 2>&1 || emit_silent "tree malformed"
if [ "$(jq -r '.truncated // false' "$TMP_TREE")" = "true" ]; then
  emit_silent "upstream tree truncated"   # would under-report; fail safe
fi

# --- 2. local blob SHAs for the vendored files (git's own blob hashing) ---
LOCAL_NDJSON=""
for sysdir in "$VENDOR_DIR"/*/; do
  [ -d "$sysdir" ] || continue
  sys="$(basename "$sysdir")"
  for fn in DESIGN.md tokens.css; do
    f="$sysdir$fn"
    [ -f "$f" ] || continue
    sha="$(git hash-object "$f" 2>/dev/null)"
    [ -z "$sha" ] && continue
    LOCAL_NDJSON+="$(jq -cn --arg p "design-systems/$sys/$fn" --arg s "$sha" '{path:$p,sha:$s}')"$'\n'
  done
done
LOCAL_JSON="$(printf '%s' "$LOCAL_NDJSON" | jq -s '.' 2>/dev/null)"
[ -z "$LOCAL_JSON" ] && emit_silent "no vendored files found at $VENDOR_DIR"

# --- 3. compare: changed vendored files + upstream catalog (one jq pass) ---
COMPARE="$(jq -cn --argjson local "$LOCAL_JSON" --slurpfile treearr "$TMP_TREE" '
  ($treearr[0]) as $tree
  | [ $tree.tree[] | select(.type=="blob" and (.path|startswith("design-systems/"))) ] as $blobs
  | (reduce $blobs[] as $b ({}; .[$b.path]=$b.sha)) as $up
  | ([ $blobs[] | (.path|split("/")) | select(length>=3) | .[1] ] | unique) as $up_systems
  | {
      changed: [ $local[]
                 | (($up[.path]) // null) as $u
                 | select($u == null or $u != .sha)
                 | { system: (.path|split("/")[1]), file: (.path|split("/")[2]),
                     reason: (if $u == null then "gone-upstream" else "changed" end) } ],
      up_systems: $up_systems,
      our_count: ($local | map(.path|split("/")[1]) | unique | length),
      upstream_count: ($up_systems | length)
    }' 2>/dev/null)"
[ -z "$COMPARE" ] && emit_silent "compare failed"

CHANGED="$(jq -c '.changed' <<<"$COMPARE")"
CHANGED_COUNT="$(jq '.changed | length' <<<"$COMPARE")"
UP_SYSTEMS="$(jq -c '.up_systems' <<<"$COMPARE")"
OUR_COUNT="$(jq '.our_count' <<<"$COMPARE")"
UP_COUNT="$(jq '.upstream_count' <<<"$COMPARE")"

# --- 4. prior snapshot (newly-added detection + changelog-change + commit window) ---
PREV='{}'
if [ "${DRIFT_RESET:-0}" != "1" ] && [ -f "$STATE_FILE" ]; then
  PREV="$(cat "$STATE_FILE" 2>/dev/null || echo '{}')"
  jq -e . >/dev/null 2>&1 <<<"$PREV" || PREV='{}'
fi
PREV_SYSTEMS="$(jq -c '.upstream_systems // null' <<<"$PREV")"
PREV_CL_SHA="$(jq -r '.changelog_sha // ""' <<<"$PREV")"
PREV_LAST="$(jq -r '.last_check // ""' <<<"$PREV")"

if [ "$PREV_SYSTEMS" = "null" ]; then
  NEWLY='[]'; BASELINE=true
else
  NEWLY="$(jq -cn --argjson cur "$UP_SYSTEMS" --argjson prev "$PREV_SYSTEMS" '$cur - $prev')"
  BASELINE=false
fi
NEWLY_COUNT="$(jq 'length' <<<"$NEWLY")"

# --- 5. changelog change (hash compare) + recent commit subjects ---
CL="$(curl -fsS "$RAW/$BRANCH/CHANGELOG.md" 2>/dev/null || true)"
if [ -n "$CL" ]; then CL_SHA="$(printf '%s' "$CL" | git hash-object --stdin 2>/dev/null)"; else CL_SHA=""; fi
if [ -z "$PREV_CL_SHA" ]; then
  CL_CHANGED=false
elif [ "$CL_SHA" != "$PREV_CL_SHA" ]; then
  CL_CHANGED=true
else
  CL_CHANGED=false
fi

SINCE="$PREV_LAST"
echo "$SINCE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || \
  SINCE="$(date -u -d '90 days ago' +%Y-%m-%d 2>/dev/null || date -u +%Y-%m-%d)"
COMMITS="$(curl -fsS "$API/commits?since=${SINCE}T00:00:00Z&per_page=100" 2>/dev/null \
  | jq -c '[ .[]? | .commit.message | split("\n")[0] ] | .[0:25]' 2>/dev/null || echo '[]')"
[ -z "$COMMITS" ] && COMMITS='[]'

# --- 6. gate + snapshot ---
WAKE=false
if [ "$CHANGED_COUNT" -gt 0 ] || [ "$NEWLY_COUNT" -gt 0 ] || [ "$CL_CHANGED" = true ]; then WAKE=true; fi
log "changed=$CHANGED_COUNT newly=$NEWLY_COUNT changelog_changed=$CL_CHANGED baseline=$BASELINE -> wakeAgent=$WAKE"

TODAY="$(date -u +%Y-%m-%d)"
mkdir -p "$STATE_DIR" 2>/dev/null || true
jq -cn --argjson sys "$UP_SYSTEMS" --arg sha "$CL_SHA" --arg d "$TODAY" \
  '{last_check:$d, upstream_systems:$sys, changelog_sha:$sha}' > "$STATE_FILE" 2>/dev/null \
  || log "warning: could not persist state to $STATE_FILE"

# --- 7. the one and only stdout line ---
CL_EXCERPT="$(printf '%s' "$CL" | head -c 8000)"
jq -cn \
  --argjson wake "$WAKE" \
  --argjson changed "$CHANGED" \
  --argjson newly "$NEWLY" \
  --argjson changed_count "$CHANGED_COUNT" \
  --argjson newly_count "$NEWLY_COUNT" \
  --argjson our_count "$OUR_COUNT" \
  --argjson up_count "$UP_COUNT" \
  --argjson cl_changed "$CL_CHANGED" \
  --arg cl_excerpt "$CL_EXCERPT" \
  --argjson commits "$COMMITS" \
  --arg since "$SINCE" \
  --argjson baseline "$BASELINE" \
  '{wakeAgent:$wake, data:{
     repo:"nexu-io/open-design",
     changed:$changed, changed_count:$changed_count,
     newly_added:$newly, newly_added_count:$newly_count,
     our_count:$our_count, upstream_count:$up_count,
     changelog_changed:$cl_changed, changelog_excerpt:$cl_excerpt,
     commits_since:$commits, since:$since, baseline:$baseline
   }}'
