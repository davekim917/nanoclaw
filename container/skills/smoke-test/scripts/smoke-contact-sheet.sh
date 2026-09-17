#!/usr/bin/env bash
# Capture a labelled contact sheet of every screen a diff touches, at desktop
# and phone width, as one image a human can react to in a few seconds instead
# of opening N screenshots. This is deterministic evidence collection — no
# LLM browser time — same motivation as smoke-build-identity.sh.
#
# Usage: smoke-contact-sheet.sh <run-dir> <base-url> <auth-state.json> \
#          [source-sha] [baseline-url] [baseline-auth-state.json]
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
#                       which case `buildSha` ends up empty. Pass "" to
#                       skip it when a baseline follows.
#   [baseline-url]      optional. The deployment this build is compared
#                       against (e.g. the develop deployment). See "Baseline
#                       diff" below. Omitted: no baseline is touched and no
#                       diff key appears anywhere in the outputs.
#   [baseline-auth-state.json]
#                       optional, defaults to <auth-state.json>. Cookies are
#                       origin-scoped, so a baseline on another origin needs
#                       a state file valid there. Same placement rules as
#                       <auth-state.json>, same refusal.
#
# What is graded: for every screen and width, `file` in manifest.json is a
# VIEWPORT-sized capture (1280x900, 390x844) taken with CSS animations and
# transitions frozen, after two consecutive captures matched pixel for pixel
# (`settled`). `fullPage` is a second, full-height capture named `*-full.png`,
# kept for context only and never graded: full-page stitching misplaces
# fixed/sticky headers and drawers, which has produced false BROKEN findings.
# A page that never stops moving is still captured, with `settled: false` and
# an UNSETTLED badge on its tile — such a tile is not evidence of breakage.
#
# Baseline diff: with a baseline url, each screen/width is first captured
# from the baseline with the IDENTICAL recipe (own fresh session, state load,
# open, the same `steps`, freeze, viewport, settle) into `*-base.png`, then
# checked for the same final path, then pixel-diffed against the head page (`agent-browser diff screenshot`), and
# the manifest entry gains `diff: {status: changed|unchanged|failed, pct,
# differentPixels, image, baseline, reason}`. Tiles are ordered changed
# (largest first), then diff-failed, then unchanged. Baseline capture is
# STRICTLY READ-ONLY — navigation, the declared `steps`, the local freeze
# style, screenshot; no build-sha sniff, no full-page capture, nothing else.
# Any baseline failure degrades to `diff.status: "failed"` with a reason for
# that screen/width; it never fails or alters the head capture.
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
# Optional `finalPath`: the pathname the screen must be on when captured.
# Defaults to `path` (query/hash ignored). Every capture, head and baseline
# alike, reads `location.pathname` after it settles and FAILS with a reason
# when it differs — a bounce to a login route (expired or wrong-origin auth
# state) must never be graded, or diffed as a confident `changed`. Purely a
# path comparison, no page-content heuristics; declare `finalPath` only when
# a `steps` click navigates on purpose.
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
#   - `set viewport <w> <h>`, `screenshot <path>` (viewport) and
#     `screenshot --full <path>` behave exactly as documented.
#   - `--json diff screenshot --baseline <png> -o <png>` screenshots the
#     session's CURRENT page and compares it to the file: exit 0 either way,
#     `{"success":true,"data":{"match":false,"mismatchPercentage":4.44375,
#     "differentPixels":51192,"totalPixels":1152000,"dimensionMismatch":null,
#     "diffPath":"..."}}`. On a match it writes NO diff image. A size
#     mismatch reports `dimensionMismatch:{expected,actual}` at 100%. An
#     unreadable baseline is exit 1 with `success:false`.
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
# Settling is measured, not slept: a capture is settled when the live page
# still matches it pixel for pixel. A resize-driven drawer in the PR #1857
# campaign was mid-slide right after the 390px switch; the freeze below stops
# CSS-driven motion outright and this loop covers what CSS cannot (JS-driven
# motion, late data).
SETTLE_MAX_ATTEMPTS=4
SETTLE_INTERVAL_MS=400
# Zero-duration rather than `animation:none`: an entry animation that ends at
# opacity:1 from a base style of opacity:0 must land on its END state, not be
# cancelled back to invisible. Idempotent, so it is re-asserted per capture.
FREEZE_JS='(function(){var i="smoke-contact-sheet-freeze";if(!document.getElementById(i)){var s=document.createElement("style");s.id=i;s.textContent="*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}";document.documentElement.appendChild(s)}return "frozen"})()'

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

RUN_DIR="${1:-}"
BASE_URL="${2:-}"
AUTH_STATE="${3:-}"
SOURCE_SHA="${4:-}"
BASELINE_URL="${5:-}"
BASELINE_AUTH="${6:-$AUTH_STATE}"

[ -n "$RUN_DIR" ] && [ -n "$BASE_URL" ] && [ -n "$AUTH_STATE" ] ||
  die "usage: smoke-contact-sheet.sh <run-dir> <base-url> <auth-state.json> [source-sha] [baseline-url] [baseline-auth-state.json]"
[ -d "$RUN_DIR" ] || die "run dir does not exist: $RUN_DIR"
printf '%s' "$BASE_URL" | grep -Eq '^https?://' ||
  die "base url must start with http:// or https://"
[ -s "$AUTH_STATE" ] || die "auth state file is missing or empty: $AUTH_STATE"
if [ -n "$BASELINE_URL" ]; then
  printf '%s' "$BASELINE_URL" | grep -Eq '^https?://' ||
    die "baseline url must start with http:// or https://"
  [ -s "$BASELINE_AUTH" ] || die "baseline auth state file is missing or empty: $BASELINE_AUTH"
fi
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
WORKGROUP_ROOT_RESOLVED="$(realpath -m "$WORKGROUP_ROOT")"

refuse_shared_auth() {
  local resolved
  resolved="$(realpath -e "$1")"
  case "$resolved" in
    "$RUN_DIR_RESOLVED"|"$RUN_DIR_RESOLVED"/*)
      die "auth state must not live inside the run dir (shared, readable evidence tree): $1"
      ;;
  esac
  case "$resolved" in
    "$WORKGROUP_ROOT_RESOLVED"|"$WORKGROUP_ROOT_RESOLVED"/*)
      die "auth state must not live under the shared workgroup tree ($WORKGROUP_ROOT): $1"
      ;;
  esac
}
refuse_shared_auth "$AUTH_STATE"
[ -z "$BASELINE_URL" ] || refuse_shared_auth "$BASELINE_AUTH"

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
  rm -f "$SESSIONS_FILE" "$SESSIONS_FILE.settle.png"
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

# open_screen SIDE SESSION AUTH URL STEPS_JSON -> 0/1, sets SESSION and, on
# failure, NAV_ERR. The one navigation recipe, shared by head and baseline so
# the two captures cannot drift apart. SIDE=base skips the build-sha sniff:
# the baseline is read-only and its sha is not this build's.
open_screen() {
  local side="$1" auth="$3" url="$4" steps="$5" out step verb rest
  SESSION="$2"
  NAV_ERR=""
  # Registered for cleanup before use so a mid-screen crash still closes it.
  printf '%s\n' "$SESSION" >>"$SESSIONS_FILE"
  if ! out="$(agent-browser --session "$SESSION" state load "$auth" 2>&1)"; then
    NAV_ERR="state load: $out"
    return 1
  fi
  if ! out="$(agent-browser --session "$SESSION" open "$url" 2>&1)"; then
    NAV_ERR="open $url: $out"
    return 1
  fi
  if [ "$side" = head ] && [ -z "$BUILD_SHA" ]; then
    out="$(agent-browser --session "$SESSION" eval "$BUILD_SHA_JS" 2>/dev/null || true)"
    out="$(printf '%s' "$out" | tr -d '"' | tr -d '[:space:]')"
    [ -n "$out" ] && [ "$out" != "null" ] && BUILD_SHA="$out" || true
  fi
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    verb="${step%% *}"
    if [ "$verb" = "$step" ]; then rest=""; else rest="${step#* }"; fi
    if ! run_step "$verb" "$rest"; then
      NAV_ERR="$STEP_ERR"
      return 1
    fi
  done < <(printf '%s' "$steps" | jq -r '.[]')
  # Best-effort: some apps keep a long-lived connection open and never go
  # idle. The per-capture settle loop below is what the image relies on.
  agent-browser --session "$SESSION" wait --load networkidle >/dev/null 2>&1 || true
  return 0
}

# norm_path PATH -> pathname only, no query/hash, no trailing slash.
norm_path() {
  local p="${1%%[?#]*}"
  [ "$p" = "/" ] || p="${p%/}"
  printf '%s' "${p:-/}"
}

# capture_view W H FILE -> 0/1 in $SESSION, sets CAP_REASON and CAP_SETTLED.
# Reads $EXPECT_PATH (see `finalPath` in the header).
# Viewport-sized, animations frozen, re-captured until the live page still
# matches the file (see SETTLE_* above).
SETTLE_DIFF="$SESSIONS_FILE.settle.png"
capture_view() {
  local w="$1" h="$2" file="$3" out attempt=1
  CAP_REASON=""
  CAP_SETTLED=false
  if ! out="$(agent-browser --session "$SESSION" set viewport "$w" "$h" 2>&1)"; then
    CAP_REASON="viewport ${w}x${h} failed: $out"
    return 1
  fi
  if ! out="$(agent-browser --session "$SESSION" eval "$FREEZE_JS" 2>&1)" ||
     ! printf '%s' "$out" | grep -q frozen; then
    CAP_REASON="animation freeze failed: $out"
    return 1
  fi
  while :; do
    rm -f "$file"
    if ! out="$(agent-browser --session "$SESSION" screenshot "$file" 2>&1)"; then
      CAP_REASON="${out:-screenshot failed}"
      return 1
    fi
    [ -s "$file" ] || { CAP_REASON="screenshot produced no file"; return 1; }
    if out="$(agent-browser --session "$SESSION" --json diff screenshot --baseline "$file" -o "$SETTLE_DIFF" 2>/dev/null)" &&
       printf '%s' "$out" | jq -e '.data.match == true' >/dev/null 2>&1; then
      CAP_SETTLED=true
    fi
    rm -f "$SETTLE_DIFF"
    [ "$CAP_SETTLED" = true ] || [ "$attempt" -ge "$SETTLE_MAX_ATTEMPTS" ] && break
    attempt=$((attempt + 1))
    agent-browser --session "$SESSION" wait "$SETTLE_INTERVAL_MS" >/dev/null 2>&1 || true
  done
  # Checked after the capture, so it is the location of the image just taken.
  out="$(agent-browser --session "$SESSION" eval "location.pathname" 2>&1)" || out=""
  out="$(norm_path "$(printf '%s' "$out" | tr -d '"' | tr -d '[:space:]')")"
  if [ "$out" != "$EXPECT_PATH" ]; then
    rm -f "$file"
    CAP_REASON="landed on $out, expected $EXPECT_PATH (redirected — e.g. to a login route)"
    return 1
  fi
  return 0
}

# diff_view BASE_FILE BASE_REASON DIFF_FILE REL_BASE REL_DIFF -> DIFF_JSON.
# Compares $SESSION's current (just-captured, frozen) page to the baseline
# capture. Never fails the caller.
diff_view() {
  local base_file="$1" base_reason="$2" diff_file="$3" rel_base="$4" rel_diff="$5" out
  if [ -n "$base_reason" ]; then
    DIFF_JSON="$(jq -cn --arg r "baseline: $base_reason" '{status:"failed",reason:$r}')"
    return 0
  fi
  rm -f "$diff_file"
  if ! out="$(agent-browser --session "$SESSION" --json diff screenshot --baseline "$base_file" -o "$diff_file" 2>&1)" ||
     ! printf '%s' "$out" | jq -e '.success == true and (.data | type == "object")' >/dev/null 2>&1; then
    DIFF_JSON="$(jq -cn --arg r "diff failed: $out" --arg b "$rel_base" '{status:"failed",baseline:$b,reason:$r}')"
    return 0
  fi
  local rel_image=""
  [ -s "$diff_file" ] && rel_image="$rel_diff" || true
  DIFF_JSON="$(printf '%s' "$out" | jq -c --arg b "$rel_base" --arg img "$rel_image" '.data |
    if .dimensionMismatch != null then
      {status:"failed", baseline:$b, reason:("dimension mismatch: " + (.dimensionMismatch | tojson))}
    else
      {status:(if .match then "unchanged" else "changed" end),
       pct:.mismatchPercentage, differentPixels:.differentPixels,
       image:(if $img == "" then null else $img end), baseline:$b}
    end')"
}

# The baseline auth state gets the same up-front load probe, but a failure
# only disables the diff — it must never stop the head capture.
BASELINE_DISABLED=""
if [ -n "$BASELINE_URL" ] && [ "$BASELINE_AUTH" != "$AUTH_STATE" ]; then
  printf '%s\n' "${SESSION_BASE}-basepreflight" >>"$SESSIONS_FILE"
  if ! LOAD_OUT="$(agent-browser --session "${SESSION_BASE}-basepreflight" state load "$BASELINE_AUTH" 2>&1)"; then
    BASELINE_DISABLED="could not load baseline auth state: $LOAD_OUT"
  fi
  agent-browser --session "${SESSION_BASE}-basepreflight" close >/dev/null 2>&1 || true
fi

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
  STEPS="$(printf '%s' "$SCREEN" | jq -c '.steps // []')"
  EXPECT_PATH="$(norm_path "$(printf '%s' "$SCREEN" | jq -r --arg p "$SCREEN_PATH" '.finalPath // $p')")"

  # Baseline first, in its own never-before-used session, so the head page is
  # the live one when the diff runs. BASE_REASON_<w> non-empty = no baseline
  # image for that width.
  BASE_REASON_1280=""
  BASE_REASON_390=""
  if [ -n "$BASELINE_URL" ]; then
    if [ -n "$BASELINE_DISABLED" ]; then
      BASE_REASON_1280="$BASELINE_DISABLED"
      BASE_REASON_390="$BASELINE_DISABLED"
    else
      if open_screen base "${SESSION_BASE}-base${IDX}" "$BASELINE_AUTH" "${BASELINE_URL%/}${SCREEN_PATH}" "$STEPS"; then
        capture_view 1280 900 "$SHOTS_DIR/${BASENAME}-1280-base.png" || BASE_REASON_1280="$CAP_REASON"
        capture_view 390 844 "$SHOTS_DIR/${BASENAME}-390-base.png" || BASE_REASON_390="$CAP_REASON"
      else
        BASE_REASON_1280="$NAV_ERR"
        BASE_REASON_390="$NAV_ERR"
      fi
      agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
    fi
  fi

  # A never-before-used session name per screen — a fresh browser context,
  # not a URL this script has navigated in before.
  NAV_OK=true
  open_screen head "${SESSION_BASE}-scr${IDX}" "$AUTH_STATE" "${BASE_URL%/}${SCREEN_PATH}" "$STEPS" || NAV_OK=false

  CAPTURED_ANY=false
  CAPTURED_ALL=true
  WIDTHS_JSON='{}'
  for VIEW in "desktop 1280 900" "mobile 390 844"; do
    # shellcheck disable=SC2086 # intentional split of the fixed triple above
    set -- $VIEW
    KEY="$1" W="$2" H="$3"
    REL="shots/${BASENAME}-${W}"
    if [ "$NAV_OK" = true ] && capture_view "$W" "$H" "$CS_DIR/$REL.png"; then
      CAPTURED_ANY=true
      DIFF_JSON=null
      if [ -n "$BASELINE_URL" ]; then
        BASE_REASON_VAR="BASE_REASON_${W}"
        diff_view "$CS_DIR/$REL-base.png" "${!BASE_REASON_VAR}" "$CS_DIR/$REL-diff.png" "$REL-base.png" "$REL-diff.png"
      fi
      # Context only, after the graded capture and the diff so its scrolling
      # cannot disturb either. Best-effort: its absence changes no status.
      FULL_REL=""
      if agent-browser --session "$SESSION" screenshot --full "$CS_DIR/$REL-full.png" >/dev/null 2>&1 &&
         [ -s "$CS_DIR/$REL-full.png" ]; then
        FULL_REL="$REL-full.png"
      fi
      ENTRY="$(jq -cn --arg f "$REL.png" --arg full "$FULL_REL" --argjson settled "$CAP_SETTLED" --argjson diff "$DIFF_JSON" \
        '{captured:true, file:$f, graded:"viewport", settled:$settled,
          fullPage:(if $full == "" then null else $full end)}
         + (if $diff == null then {} else {diff:$diff} end)')"
    else
      CAPTURED_ALL=false
      REASON="$CAP_REASON"
      [ "$NAV_OK" = true ] || REASON="$NAV_ERR"
      ENTRY="$(jq -cn --arg r "$REASON" --argjson b "$([ -n "$BASELINE_URL" ] && echo true || echo false)" \
        '{captured:false, file:null, reason:$r}
         + (if $b then {diff:{status:"failed",reason:"head not captured"}} else {} end)')"
    fi
    WIDTHS_JSON="$(printf '%s' "$WIDTHS_JSON" | jq -c --arg k "$KEY" --argjson e "$ENTRY" '. + {($k): $e}')"
  done

  if [ "$CAPTURED_ALL" = true ]; then
    STATUS=captured
  elif [ "$CAPTURED_ANY" = true ]; then
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
    --arg name "$NAME" --arg path "$SCREEN_PATH" --arg status "$STATUS" --argjson widths "$WIDTHS_JSON" \
    '{
      name: $name, path: $path, status: $status,
      # Every screen navigates in its own never-before-used session (see the
      # "Fresh state per screen" header note) — always true by construction,
      # not conditioned on whether the navigation itself succeeded, so a
      # later reader can tell a real default state from a leftover one.
      freshNavigation: true
    } + $widths' >>"$RESULTS_FILE"

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

cs_dir, base_url, build_sha, requested, capped, generated_at, baseline_url = sys.argv[1:8]
requested = int(requested)
capped = capped == "1"

screens = [json.loads(line) for line in sys.stdin if line.strip()]

totals = {"screens": len(screens), "captured": 0, "partial": 0, "failed": 0}
for s in screens:
    totals[s["status"]] = totals.get(s["status"], 0) + 1

WIDTHS = ("desktop", "mobile")
if baseline_url:
    totals["diff"] = {"changed": 0, "unchanged": 0, "failed": 0}
    for s in screens:
        for w in WIDTHS:
            totals["diff"][s[w]["diff"]["status"]] += 1

manifest = {
    # 2: `file` became the graded VIEWPORT capture (was full-page); the
    # full-page image moved to `fullPage`, context only.
    "schemaVersion": 2,
    "capture": {
        "graded": "viewport",
        "animationsFrozen": True,
        "fullPage": "context only, never graded",
    },
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
if baseline_url:
    manifest["baselineUrl"] = baseline_url
with open(os.path.join(cs_dir, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")


def badges(entry):
    out = []
    if entry["captured"] and not entry["settled"]:
        out.append(("failed", "unsettled"))
    diff = entry.get("diff")
    if diff:
        label = {
            "changed": "changed %.2f%%" % diff.get("pct", 0),
            "unchanged": "unchanged",
            "failed": "diff failed: %s" % diff.get("reason", ""),
        }[diff["status"]]
        out.append((diff["status"], label))
    return "".join(
        '<span class="status badge-%s">%s</span>' % (k, html.escape(v)) for k, v in out
    )


def tile(entry, css_class):
    if not entry["captured"]:
        reason = entry.get("reason") or "capture failed"
        return '<div class="%s placeholder">FAILED<br>%s</div>' % (css_class, html.escape(reason))
    parts = [badges(entry), '<img class="%s" src="%s">' % (css_class, html.escape(entry["file"], quote=True))]
    image = (entry.get("diff") or {}).get("image")
    if image:
        parts.append('<img class="%s diff" src="%s">' % (css_class, html.escape(image, quote=True)))
    return '<div class="tile">%s</div>' % "".join(parts)


def diff_rank(s):
    # changed (largest first), then diff-failed (unknown — needs eyes), then
    # unchanged. Stable, so ties keep shots.json order.
    diffs = [s[w]["diff"] for w in WIDTHS]
    if any(d["status"] == "changed" for d in diffs):
        return (0, -max(d.get("pct", 0) for d in diffs))
    return (1, 0) if any(d["status"] == "failed" for d in diffs) else (2, 0)


# manifest.json keeps shots.json order; only the sheet is reordered.
rows = []
for s in sorted(screens, key=diff_rank) if baseline_url else screens:
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
.tile{display:flex;flex-direction:column;gap:6px;align-items:flex-start;}
.badge-changed{background:#fed7aa;color:#9a3412;}
.badge-unchanged{background:#e5e7eb;color:#374151;}
.badge-failed{background:#fee2e2;color:#991b1b;}
img.diff{border-color:#f97316;}
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
python3 "$RENDER_SCRIPT" "$CS_DIR" "$BASE_URL" "$BUILD_SHA" "$REQUESTED" "$CAPPED_FLAG" "$GENERATED_AT" "$BASELINE_URL" \
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

jq -c --arg m "$CS_DIR/manifest.json" --arg s "$SHEET_FILE" \
  --argjson c "$CAPTURED_COUNT" --argjson f "$FAILED_COUNT" --argjson r "$REQUESTED" --argjson capd "$CAPPED" \
  '{ok:true,requested:$r,capped:$capd,captured:$c,failed:$f,manifest:$m,sheet:$s}
   + (if .totals.diff then {diff:.totals.diff} else {} end)' "$CS_DIR/manifest.json"
