#!/usr/bin/env bash
# Capture a labelled contact sheet of every screen a diff touches, at desktop
# and phone width, as one image a human can react to in a few seconds instead
# of opening N screenshots. This is deterministic evidence collection — no
# LLM browser time — same motivation as smoke-build-identity.sh.
#
# Usage: smoke-contact-sheet.sh <run-dir> <base-url> <auth-state.json> [source-sha]
#
#   <run-dir>          an existing smoke-test run directory. Reads
#                       <run-dir>/contact-sheet/shots.json (already written by
#                       the caller) and writes everything else under
#                       <run-dir>/contact-sheet/.
#   <base-url>          e.g. https://pr-1234.onrender.com — joined with each
#                       shot's `path`.
#   <auth-state.json>   an agent-browser `state save` file (QA-seat cookies +
#                       storage). Loaded fresh into a brand-new session for
#                       every screen — same saved state file each time, never
#                       a fresh login (see "Fresh state per screen" below).
#                       MUST live outside the run dir and outside the shared
#                       workgroup tree — see the security note below. The
#                       caller deletes this file once the sheet is captured;
#                       this script never does (it doesn't own the file).
#   [source-sha]        optional. The frozen build SHA the caller already
#                       knows (40 hex chars) — recorded in manifest.json as
#                       `buildSha` verbatim, no page sniff needed. Malformed
#                       values are refused (exit 2) rather than written into
#                       the manifest. Omit it to fall back to sniffing the
#                       served page for `meta[name="build-sha"]`,
#                       `window.__BUILD_SHA__`, or a `data-build-sha`
#                       attribute — the app may expose none of those, in
#                       which case `buildSha` ends up empty.
#
# SECURITY: the auth state file holds a live session token. This script
# REFUSES a path that resolves (realpath) inside <run-dir> or anywhere under
# the shared workgroup tree ($SMOKE_WORKGROUP_ROOT, default
# /workspace/workgroup) — both are shared/durable trees other sessions and,
# for the run dir, eventual posting/review can read, and that is exactly
# where a QA-token leak has happened before. Keep the auth state in a private
# path instead, e.g. /tmp/contact-sheet-auth-<runId>.json, and delete it after
# this script exits. This script only ever passes that PATH to `agent-browser
# state load` — it never reads the file's bytes itself, so auth content never
# reaches manifest.json, the HTML grid, or this script's own output.
#
# shots.json shape (written by the caller, capped here at 8 entries):
#   [{ "name": "settings-pricing", "path": "/settings",
#      "steps": ["click text=Pricing", "wait 500"] }, ...]
#
# `steps` supports exactly two verbs, run in order against that screen's
# session:
#   click text=<value>   -> agent-browser find text "<value>" click
#   click <selector>      -> agent-browser click "<selector>" (CSS or XPath,
#                            whatever `agent-browser click --help` accepts)
#   wait <args...>        -> agent-browser wait <args...> (ms, --text, --url,
#                            --load, verbatim)
# Any other verb fails that one screen with `unsupported step` — never
# silently skipped.
#
# Fresh state per screen: every screen navigates in its OWN, never-before-used
# `--session` name (a fresh browser context), with the same saved auth state
# loaded fresh into it — never a fresh login (a login rate limit is shared
# across the seat; loading the same saved state file locally isn't a login).
# One shared session for the whole run used to carry a previous screen's DOM
# state — e.g. a nav drawer opened by an earlier screen's `steps` — into every
# later screenshot; xzo-pr-pr1792-cac47f6f1153-20260912T113129Z's three 390px
# shots all showed the drawer open, and the shadow critic graded all three
# BROKEN partly on that capture artifact, which corrupts the agreement score
# the whole critic feature is judged on. A same-URL, same-viewport `open` can
# look like a fresh load while a SPA keeps UI state in localStorage/session
# state across it (see `record start` dropping `localStorage` for the same
# reason, in the `agent-browser` skill) — a real fresh context is the only
# thing that reliably drops it while keeping the cookie-based auth state.
# Each screen's manifest entry records `freshNavigation: true` so a later
# reader can tell a real default state from a leftover one.
#
# Real syntax verified against agent-browser 0.33.0 in the agent image
# (`docker run --rm --entrypoint bash nanoclaw-agent-v2-2a38bd3e:latest`):
#   - `click "text=..."` is NOT a selector agent-browser understands — CSS/
#     XPath only (`click --help`). The text locator is `find text "<v>" click`.
#   - `state load <path>` must run BEFORE `open`, in the same session: it sets
#     the state path, applied on the session's next navigation.
#   - `set viewport <w> <h>` and `screenshot --full <path>` behave exactly as
#     documented.
#   - a `--session <name>` this script has not used before starts fresh: the
#     `agent-browser` skill documents a REUSED session name as the thing that
#     "persists across invocations... instead of starting fresh"
#     (`container/skills/agent-browser/SKILL.md:79-83`) — by the same line, an
#     unseen name has nothing to reuse and starts a fresh browser context.
#     `record start` separately documents that a fresh context it opens drops
#     `localStorage` but keeps cookies (`SKILL.md:109-111`) — the same shape
#     of state a leftover DOM/localStorage flag (e.g. "nav drawer open")
#     would bleed through if the run kept reusing one session end to end.
# See the PR body for the transcript this was verified against.
#
# A screen that fails to capture is recorded as `failed: <reason>` and still
# gets a placeholder tile in the grid — never silently dropped. This script
# exits non-zero ONLY when zero screens captured anything; per-screen
# failures alone do not fail the run, because a partial sheet is still useful
# evidence and the manifest already names every gap.
#
# One JSON line on stdout. Exit 2 on a usage/input refusal (nothing captured,
# nothing written), 1 when it ran but captured zero screens, 0 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_SHOTS=8
# A resize-driven drawer transition in the observed PR #1857 campaign was
# still mid-slide immediately after the 390px viewport switch and settled by
# 1.5 seconds. Keep a small margin and make the mobile capture wait explicit:
# a timing artifact is not acceptable visual evidence.
MOBILE_VIEWPORT_SETTLE_MS=1600

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

RUN_DIR="${1:-}"
BASE_URL="${2:-}"
AUTH_STATE="${3:-}"
SOURCE_SHA="${4:-}"

[ -n "$RUN_DIR" ] && [ -n "$BASE_URL" ] && [ -n "$AUTH_STATE" ] ||
  die "usage: smoke-contact-sheet.sh <run-dir> <base-url> <auth-state.json> [source-sha]"
[ -d "$RUN_DIR" ] || die "run dir does not exist: $RUN_DIR"
printf '%s' "$BASE_URL" | grep -Eq '^https?://' ||
  die "base url must start with http:// or https://"
[ -s "$AUTH_STATE" ] || die "auth state file is missing or empty: $AUTH_STATE"
# A caller-supplied SHA is trusted verbatim into a shared, durable manifest —
# refuse a malformed value rather than writing junk (e.g. a branch name, or
# an accidentally-passed URL) into evidence other sessions read as fact.
if [ -n "$SOURCE_SHA" ]; then
  printf '%s' "$SOURCE_SHA" | grep -Eq '^[0-9a-f]{40}$' ||
    die "source sha must be 40 lowercase hex characters: $SOURCE_SHA"
fi

# The auth state file holds a live session token — refuse it inside either
# shared, durable tree. `realpath -e` on RUN_DIR/AUTH_STATE is safe (both are
# already proven to exist above); the workgroup root is resolved with `-m`
# (no existence requirement) since a test double or a host without
# /workspace/workgroup must still compare correctly.
WORKGROUP_ROOT="${SMOKE_WORKGROUP_ROOT:-/workspace/workgroup}"
RUN_DIR_RESOLVED="$(realpath -e "$RUN_DIR")"
AUTH_STATE_RESOLVED="$(realpath -e "$AUTH_STATE")"
WORKGROUP_ROOT_RESOLVED="$(realpath -m "$WORKGROUP_ROOT")"

case "$AUTH_STATE_RESOLVED" in
  "$RUN_DIR_RESOLVED"|"$RUN_DIR_RESOLVED"/*)
    die "auth state must not live inside the run dir (shared, readable evidence tree): $AUTH_STATE"
    ;;
esac
case "$AUTH_STATE_RESOLVED" in
  "$WORKGROUP_ROOT_RESOLVED"|"$WORKGROUP_ROOT_RESOLVED"/*)
    die "auth state must not live under the shared workgroup tree ($WORKGROUP_ROOT): $AUTH_STATE"
    ;;
esac

CS_DIR="$RUN_DIR/contact-sheet"
SHOTS_JSON="$CS_DIR/shots.json"
SHOTS_DIR="$CS_DIR/shots"

[ -s "$SHOTS_JSON" ] || die "shots file is missing or empty: $SHOTS_JSON"
jq -e 'type == "array"' "$SHOTS_JSON" >/dev/null 2>&1 ||
  die "shots file is not a JSON array: $SHOTS_JSON"
REQUESTED="$(jq 'length' "$SHOTS_JSON")"
[ "$REQUESTED" -gt 0 ] ||
  die "shots file lists zero screens: $SHOTS_JSON"

mkdir -p "$SHOTS_DIR"

CAPPED=false
[ "$REQUESTED" -gt "$MAX_SHOTS" ] && CAPPED=true || true
SHOTS_LIST="$(jq -c ".[0:$MAX_SHOTS]" "$SHOTS_JSON")"

command -v agent-browser >/dev/null 2>&1 ||
  die "agent-browser is not on PATH"

# A fresh `--session` name per screen (never a shared one across the whole
# sheet) — a shared session let one screen's DOM/localStorage state (e.g. a
# nav drawer some earlier screen's `steps` opened) bleed into every later
# screenshot. See the "Fresh state per screen" header note above. Base name
# is derived from the run dir so two concurrent runs never collide, sanitized
# to characters agent-browser session names are known to accept; each screen
# (and the preflight probe and the final grid render) appends its own suffix.
SESSION_BASE_RAW="cs-$(basename "$RUN_DIR")-$$"
SESSION_BASE="$(printf '%s' "$SESSION_BASE_RAW" | tr -c 'A-Za-z0-9_-' '-')"

# Every session name this script ever opens is recorded here so cleanup can
# close all of them on exit, however far the script got — one shared $SESSION
# variable can't do that once each screen has its own.
SESSIONS_FILE="$(mktemp)"
cleanup() {
  if [ -s "$SESSIONS_FILE" ]; then
    while IFS= read -r s; do
      [ -n "$s" ] && agent-browser --session "$s" close >/dev/null 2>&1 || true
    done <"$SESSIONS_FILE"
  fi
  rm -f "$SESSIONS_FILE"
}
trap cleanup EXIT

# A dedicated probe session, closed right after: verifies the auth state file
# itself is loadable before attempting any screen, so a fundamentally broken
# file refuses up front (exit 2, nothing written) rather than failing all N
# screens individually and exiting 1 as if it had merely captured zero.
PREFLIGHT_SESSION="${SESSION_BASE}-preflight"
printf '%s\n' "$PREFLIGHT_SESSION" >>"$SESSIONS_FILE"
if ! LOAD_OUT="$(agent-browser --session "$PREFLIGHT_SESSION" state load "$AUTH_STATE" 2>&1)"; then
  die "agent-browser could not load auth state: $LOAD_OUT"
fi
agent-browser --session "$PREFLIGHT_SESSION" close >/dev/null 2>&1 || true

RESULTS_FILE="$(mktemp)"
trap 'rm -f "$RESULTS_FILE"; cleanup' EXIT
# Caller-supplied SHA wins outright — the sniff loop below only runs while
# BUILD_SHA is still empty, so passing SOURCE_SHA skips it entirely.
BUILD_SHA="$SOURCE_SHA"
BUILD_SHA_JS='(document.querySelector("meta[name=\"build-sha\"]")||{}).content || (typeof window!=="undefined" && window.__BUILD_SHA__) || (document.querySelector("[data-build-sha]")||{}).dataset && document.querySelector("[data-build-sha]").dataset.buildSha || ""'

# run_step VERB REST -> 0/1, sets STEP_ERR on failure. See the header comment
# for the two supported verbs; anything else fails closed.
run_step() {
  local verb="$1" rest="$2" out
  case "$verb" in
    click)
      case "$rest" in
        text=*)
          if out="$(agent-browser --session "$SESSION" find text "${rest#text=}" click 2>&1)"; then
            return 0
          fi
          ;;
        *)
          if out="$(agent-browser --session "$SESSION" click "$rest" 2>&1)"; then
            return 0
          fi
          ;;
      esac
      STEP_ERR="click $rest: $out"
      return 1
      ;;
    wait)
      # shellcheck disable=SC2086 # intentional word-splitting: `wait` takes
      # multiple tokens (e.g. `--text Success`), and shots.json's step string
      # is space-delimited exactly the way agent-browser's own CLI args are.
      if out="$(agent-browser --session "$SESSION" wait $rest 2>&1)"; then
        return 0
      fi
      STEP_ERR="wait $rest: $out"
      return 1
      ;;
    *)
      STEP_ERR="unsupported step: $verb $rest"
      return 1
      ;;
  esac
}

I=0
while IFS= read -r SCREEN; do
  IDX="$(printf '%02d' "$I")"
  NAME="$(printf '%s' "$SCREEN" | jq -r '.name // ("screen-" + $i)' --arg i "$IDX")"
  SAFE_NAME="$(printf '%s' "$NAME" | tr -c 'A-Za-z0-9_-' '-')"
  [ -n "$SAFE_NAME" ] || SAFE_NAME="screen"
  BASENAME="${IDX}-${SAFE_NAME}"
  SCREEN_PATH="$(printf '%s' "$SCREEN" | jq -r '.path // "/"')"
  case "$SCREEN_PATH" in
    /*) ;;
    *) SCREEN_PATH="/$SCREEN_PATH" ;;
  esac
  URL="${BASE_URL%/}${SCREEN_PATH}"

  # A never-before-used session name per screen — a fresh browser context,
  # not a URL this script has navigated in before. Registered for cleanup
  # before use so a mid-screen crash still gets it closed.
  SESSION="${SESSION_BASE}-scr${IDX}"
  printf '%s\n' "$SESSION" >>"$SESSIONS_FILE"

  STATE_OK=true
  STATE_ERR=""
  if ! OUT="$(agent-browser --session "$SESSION" state load "$AUTH_STATE" 2>&1)"; then
    STATE_OK=false
    STATE_ERR="state load: $OUT"
  fi

  OPEN_OK=true
  OPEN_ERR=""
  if [ "$STATE_OK" = true ]; then
    if ! OUT="$(agent-browser --session "$SESSION" open "$URL" 2>&1)"; then
      OPEN_OK=false
      OPEN_ERR="open $URL: $OUT"
    fi
  else
    OPEN_OK=false
    OPEN_ERR="$STATE_ERR"
  fi

  if [ "$OPEN_OK" = true ] && [ -z "$BUILD_SHA" ]; then
    SHA_OUT="$(agent-browser --session "$SESSION" eval "$BUILD_SHA_JS" 2>/dev/null || true)"
    SHA_OUT="$(printf '%s' "$SHA_OUT" | tr -d '"' | tr -d '[:space:]')"
    [ -n "$SHA_OUT" ] && [ "$SHA_OUT" != "null" ] && BUILD_SHA="$SHA_OUT" || true
  fi

  STEP_OK=true
  STEP_ERR=""
  if [ "$OPEN_OK" = true ]; then
    while IFS= read -r STEP; do
      [ -n "$STEP" ] || continue
      VERB="${STEP%% *}"
      if [ "$VERB" = "$STEP" ]; then REST=""; else REST="${STEP#* }"; fi
      if ! run_step "$VERB" "$REST"; then
        STEP_OK=false
        break
      fi
    done < <(printf '%s' "$SCREEN" | jq -r '(.steps // [])[]')
    # Best-effort settle after steps navigate/mutate the page. Never fails the
    # screen on its own — some apps keep a long-lived connection open and
    # never go idle, and a screenshot of a not-perfectly-settled page is still
    # useful evidence.
    [ "$STEP_OK" = true ] &&
      agent-browser --session "$SESSION" wait --load networkidle >/dev/null 2>&1 || true
  fi

  NAV_OK=$([ "$OPEN_OK" = true ] && [ "$STEP_OK" = true ] && echo true || echo false)
  NAV_ERR="$OPEN_ERR"
  [ "$OPEN_OK" = true ] && [ "$STEP_OK" = false ] && NAV_ERR="$STEP_ERR" || true

  DESKTOP_FILE="$SHOTS_DIR/${BASENAME}-1280.png"
  DESKTOP_CAPTURED=false
  DESKTOP_REASON=""
  if [ "$NAV_OK" = true ]; then
    if agent-browser --session "$SESSION" set viewport 1280 900 >/dev/null 2>&1 &&
       SHOT_OUT="$(agent-browser --session "$SESSION" screenshot --full "$DESKTOP_FILE" 2>&1)"; then
      [ -s "$DESKTOP_FILE" ] && DESKTOP_CAPTURED=true || DESKTOP_REASON="screenshot produced no file"
    else
      DESKTOP_REASON="${SHOT_OUT:-desktop viewport/screenshot failed}"
    fi
  else
    DESKTOP_REASON="$NAV_ERR"
  fi

  MOBILE_FILE="$SHOTS_DIR/${BASENAME}-390.png"
  MOBILE_CAPTURED=false
  MOBILE_REASON=""
  if [ "$NAV_OK" = true ]; then
    if ! agent-browser --session "$SESSION" set viewport 390 844 >/dev/null 2>&1; then
      MOBILE_REASON="mobile viewport failed"
    elif ! SETTLE_OUT="$(agent-browser --session "$SESSION" wait "$MOBILE_VIEWPORT_SETTLE_MS" 2>&1)"; then
      MOBILE_REASON="mobile viewport settle failed: $SETTLE_OUT"
    elif SHOT_OUT="$(agent-browser --session "$SESSION" screenshot --full "$MOBILE_FILE" 2>&1)"; then
      [ -s "$MOBILE_FILE" ] && MOBILE_CAPTURED=true || MOBILE_REASON="screenshot produced no file"
    else
      MOBILE_REASON="${SHOT_OUT:-mobile screenshot failed}"
    fi
  else
    MOBILE_REASON="$NAV_ERR"
  fi

  if [ "$DESKTOP_CAPTURED" = true ] && [ "$MOBILE_CAPTURED" = true ]; then
    STATUS=captured
  elif [ "$DESKTOP_CAPTURED" = true ] || [ "$MOBILE_CAPTURED" = true ]; then
    STATUS=partial
  else
    STATUS=failed
  fi

  # Close this screen's session now rather than waiting for the run-wide
  # cleanup trap — it already did its job (a fresh context this screen alone
  # navigated in) and there is no reason to keep N browser contexts alive at
  # once as the sheet grows.
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true

  jq -cn \
    --arg name "$NAME" --arg path "$SCREEN_PATH" --arg status "$STATUS" \
    --argjson dcap "$DESKTOP_CAPTURED" --arg dfile "shots/${BASENAME}-1280.png" --arg dreason "$DESKTOP_REASON" \
    --argjson mcap "$MOBILE_CAPTURED" --arg mfile "shots/${BASENAME}-390.png" --arg mreason "$MOBILE_REASON" \
    '{
      name: $name, path: $path, status: $status,
      # Every screen navigates in its own never-before-used session (see the
      # "Fresh state per screen" header note) — always true by construction,
      # not conditioned on whether the navigation itself succeeded, so a
      # later reader can tell a real default state from a leftover one.
      freshNavigation: true,
      desktop: ({captured: $dcap} + (if $dcap then {file: $dfile} else {file: null, reason: $dreason} end)),
      mobile: ({captured: $mcap} + (if $mcap then {file: $mfile} else {file: null, reason: $mreason} end))
    }' >>"$RESULTS_FILE"

  I=$((I + 1))
done < <(printf '%s' "$SHOTS_LIST" | jq -c '.[]')

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RENDER_SCRIPT="$(mktemp)"
trap 'rm -f "$RESULTS_FILE" "$RENDER_SCRIPT"; cleanup' EXIT
cat >"$RENDER_SCRIPT" <<'PYEOF'
import html
import json
import os
import sys

cs_dir, base_url, build_sha, requested, capped, generated_at = sys.argv[1:7]
requested = int(requested)
capped = capped == "1"

screens = [json.loads(line) for line in sys.stdin if line.strip()]

totals = {"screens": len(screens), "captured": 0, "partial": 0, "failed": 0}
for s in screens:
    totals[s["status"]] = totals.get(s["status"], 0) + 1

manifest = {
    "schemaVersion": 1,
    "baseUrl": base_url,
    # No authState field, deliberately — the auth state path is never copied
    # into this shared, durable artifact (see the security note in the
    # script header). This script never reads the file's bytes either way.
    "buildSha": build_sha,
    "generatedAt": generated_at,
    "requested": requested,
    "capped": capped,
    "maxShots": 8,
    "screens": screens,
    "totals": totals,
    "sheetImage": "sheet.png",
}
with open(os.path.join(cs_dir, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")


def tile(entry, css_class):
    if entry["captured"]:
        return '<img class="%s" src="%s">' % (css_class, html.escape(entry["file"], quote=True))
    reason = entry.get("reason") or "capture failed"
    return '<div class="%s placeholder">FAILED<br>%s</div>' % (css_class, html.escape(reason))


rows = []
for s in screens:
    rows.append(
        '<div class="row"><div class="label">%s<br><span class="path">%s</span>'
        '<br><span class="status status-%s">%s</span></div>'
        '<div class="shot">%s</div><div class="shot mobile">%s</div></div>'
        % (
            html.escape(s["name"]),
            html.escape(s["path"]),
            html.escape(s["status"]),
            html.escape(s["status"]),
            tile(s["desktop"], "desktop"),
            tile(s["mobile"], "mobile"),
        )
    )

doc = """<!doctype html>
<html><head><meta charset="utf-8"><title>contact sheet</title>
<style>
body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#111;}
.row{display:flex;gap:16px;padding:16px;border-bottom:1px solid #ddd;align-items:flex-start;}
.label{width:260px;flex:0 0 260px;font-weight:600;font-size:14px;}
.label .path{font-weight:400;color:#666;font-size:12px;}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;text-transform:uppercase;}
.status-captured{background:#dcfce7;color:#166534;}
.status-partial{background:#fef9c3;color:#854d0e;}
.status-failed{background:#fee2e2;color:#991b1b;}
.shot{display:flex;align-items:flex-start;}
img.desktop{max-width:1280px;border:1px solid #ccc;}
img.mobile{max-width:390px;border:1px solid #ccc;}
.placeholder{display:flex;align-items:center;justify-content:center;text-align:center;
  border:2px dashed #f87171;color:#991b1b;background:#fef2f2;font-size:12px;padding:8px;}
.placeholder.desktop{width:1280px;height:200px;}
.placeholder.mobile{width:390px;height:200px;}
</style></head>
<body>
%s
</body></html>
""" % "\n".join(rows)

with open(os.path.join(cs_dir, "grid.html"), "w") as f:
    f.write(doc)
PYEOF

CAPPED_FLAG=0
[ "$CAPPED" = true ] && CAPPED_FLAG=1 || true
python3 "$RENDER_SCRIPT" "$CS_DIR" "$BASE_URL" "$BUILD_SHA" "$REQUESTED" "$CAPPED_FLAG" "$GENERATED_AT" \
  <"$RESULTS_FILE"
rm -f "$RENDER_SCRIPT"

# Render the grid itself: wide enough for both columns side by side with no
# horizontal scroll (1280 + 390 + gutters). Its own session — it's a local
# file, not an authenticated page, so it doesn't need the saved auth state.
GRID_SESSION="${SESSION_BASE}-grid"
printf '%s\n' "$GRID_SESSION" >>"$SESSIONS_FILE"
SHEET_FILE="$CS_DIR/sheet.png"
if ! SHEET_OUT="$(agent-browser --session "$GRID_SESSION" open "file://$CS_DIR/grid.html" 2>&1)"; then
  jq -cn --arg e "$SHEET_OUT" '{ok:false,error:("could not open the rendered grid: " + $e)}'
  exit 1
fi
if ! SHEET_OUT="$(agent-browser --session "$GRID_SESSION" set viewport 1750 1000 2>&1)"; then
  # The grid session is brand new, unlike each captured screen. A failed
  # viewport command here would silently emit a clipped/default-width sheet,
  # which is the primary visual evidence for the campaign. Fail visibly rather
  # than uploading an artifact whose two-column comparison cannot be trusted.
  jq -cn --arg e "$SHEET_OUT" '{ok:false,error:("could not set the rendered grid viewport: " + $e)}'
  exit 1
fi
if ! SHEET_OUT="$(agent-browser --session "$GRID_SESSION" screenshot --full "$SHEET_FILE" 2>&1)"; then
  jq -cn --arg e "$SHEET_OUT" '{ok:false,error:("could not screenshot the rendered grid: " + $e)}'
  exit 1
fi

CAPTURED_COUNT="$(jq -s '[.[] | select(.status != "failed")] | length' "$RESULTS_FILE")"
FAILED_COUNT="$(jq -s '[.[] | select(.status == "failed")] | length' "$RESULTS_FILE")"

if [ "$CAPTURED_COUNT" -eq 0 ]; then
  jq -cn --arg m "$CS_DIR/manifest.json" --arg s "$SHEET_FILE" --argjson f "$FAILED_COUNT" \
    '{ok:false,error:"zero screens captured",failed:$f,manifest:$m,sheet:$s}'
  exit 1
fi

jq -cn --arg m "$CS_DIR/manifest.json" --arg s "$SHEET_FILE" \
  --argjson c "$CAPTURED_COUNT" --argjson f "$FAILED_COUNT" --argjson r "$REQUESTED" --argjson capd "$CAPPED" \
  '{ok:true,requested:$r,capped:$capd,captured:$c,failed:$f,manifest:$m,sheet:$s}'
