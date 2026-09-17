#!/usr/bin/env bash
# Hermetic: no browser, no network, no critic model. Fixtures are hand-built
# manifest.json files in the shape smoke-contact-sheet.sh writes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VC="$SCRIPT_DIR/smoke-visual-candidates.py"
BARRIER="$SCRIPT_DIR/smoke-evidence-barrier.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
printf '# rubric\n' >"$TMP/design-rubric.md"

fail() { echo "FAIL: $1" >&2; [ -z "${2:-}" ] || echo "$2" >&2; exit 1; }

# A run that is otherwise synthesis-ready: one terminal lane, both conclusions.
new_run() { # <name> [confirmed-finding-id]
  local run="$TMP/runs/$1"
  mkdir -p "$run/markers" "$run/coordinator" "$run/challenger"
  jq -n --arg sha "$SHA" '{schemaVersion:1,sourceSha:$sha,ownershipKind:"develop",
    requiredLaneMarkers:["markers/UI.json"]}' >"$run/completion-contract.json"
  jq -n --arg sha "$SHA" --arg f "${2:-}" '{sourceSha:$sha,status:"fail",completedAt:"2026-09-17T10:00:00Z"}
    + (if $f == "" then {} else {confirmedFindings:[$f],evidence:["clip-skipped: " + $f + ": no ffmpeg in the image"]} end)' \
    >"$run/markers/UI.json"
  printf '# preliminary\n' >"$run/coordinator/preliminary.md"
  printf '# disposition\n' >"$run/challenger/disposition.md"
  printf '%s' "$run"
}

# manifest <run> <generatedAt> <screens-json>; width entries built by w().
manifest() {
  mkdir -p "$1/contact-sheet/shots"
  jq -n --arg at "$2" --argjson screens "$3" \
    '{schemaVersion:2,buildSha:"",generatedAt:$at,screens:$screens}' >"$1/contact-sheet/manifest.json"
}
w() { # <file-or-empty> [settled] [diff-status]
  jq -cn --arg f "$1" --argjson settled "${2:-true}" --arg d "${3:-}" '
    (if $f == "" then {captured:false,file:null,reason:"open failed: timeout"}
     else {captured:true,file:("shots/" + $f),graded:"viewport",settled:$settled,fullPage:null} end)
    + (if $d == "" then {} else {diff:{status:$d}} end)'
}
screen() { jq -cn --arg n "$1" --argjson d "$2" --argjson m "$3" '{name:$n,path:("/" + $n),status:"captured",desktop:$d,mobile:$m}'; }
LANTERN="[$(screen lantern "$(w 01-lantern-1280.png)" "$(w 01-lantern-390.png)")]"

barrier() { bash "$BARRIER" "$1" synthesis || true; }
critic() { python3 "$VC" record-critic "$1" --rubric "$TMP/design-rubric.md" --design-system-version 41c27273; }
dispose() { python3 "$VC" dispose "$@" --by ui-adversary; }

# --- no user-visible surface: byte-identical barrier output ------------------
RUN="$(new_run none)"
[ "$(barrier "$RUN")" = "{\"ready\":true,\"phase\":\"synthesis\",\"sourceSha\":\"$SHA\",\"missing\":[],\"invalid\":[],\"invalidReasons\":[]}" ] ||
  fail "a run with no contact sheet must produce the barrier's pre-existing ready output byte for byte" "$(barrier "$RUN")"
rm "$RUN/challenger/disposition.md"
[ "$(barrier "$RUN")" = "{\"ready\":false,\"phase\":\"synthesis\",\"sourceSha\":\"$SHA\",\"missing\":[\"challenger/disposition.md\"],\"invalid\":[],\"invalidReasons\":[]}" ] ||
  fail "a run with no contact sheet must produce the barrier's pre-existing not-ready output byte for byte" "$(barrier "$RUN")"
[ "$(python3 "$VC" barrier "$RUN")" = '{"missing":[],"invalid":[],"invalidReasons":[]}' ] || fail "no sheet owes nothing"

# --- a required sheet that was never captured --------------------------------
RUN="$(new_run never-captured)"
mkdir -p "$RUN/contact-sheet"; echo '[{"name":"lantern","path":"/lantern"}]' >"$RUN/contact-sheet/shots.json"
barrier "$RUN" | jq -e '.ready == false and .missing == ["contact-sheet/manifest.json"]
  and (.invalidReasons[0] | contains("does not waive visual review"))' >/dev/null ||
  fail "shots.json with no manifest must be missing evidence" "$(barrier "$RUN")"

# Owed by the gate's pinned journeys even when the owner wrote no shots.json.
RUN="$(new_run journeys-owed)"
mkdir -p "$RUN/journeys"
echo '{"matchedJourneys":[{"id":"J1"}]}' >"$RUN/journeys/selection.json"
echo '{"journeys":[{"id":"J1","captureRecipes":[{"name":"lantern","path":"/lantern"}]}]}' >"$RUN/journeys/catalogue.json"
python3 "$VC" barrier "$RUN" | jq -e '.missing == ["contact-sheet/manifest.json"]
  and (.invalidReasons[0] | contains("pinned journeys carry capture recipes"))' >/dev/null ||
  fail "pinned journeys with capture recipes owe a sheet"
# ...and a screen they require that the manifest never attempted is missing evidence.
manifest "$RUN" 2026-09-17T10:00:00Z "[$(screen other "$(w 01-other-1280.png)" "$(w 01-other-390.png)")]"
printf 'FINE · 01-other-1280.png · ok\nFINE · 01-other-390.png · ok\n' | critic "$RUN" >/dev/null
python3 "$VC" barrier "$RUN" | jq -e '(.missing | sort) == ["contact-sheet/dispositions.json#lantern@desktop","contact-sheet/dispositions.json#lantern@mobile"]' >/dev/null ||
  fail "a journey-required screen absent from the manifest is missing evidence"

# --- critic absent with a required sheet -------------------------------------
RUN="$(new_run lantern)"
manifest "$RUN" 2026-09-17T10:00:00Z "$LANTERN"
barrier "$RUN" | jq -e '.ready == false and .missing == ["contact-sheet/critic.json"]
  and (.invalidReasons[0] | contains("a critic that did not run does not waive visual review"))' >/dev/null ||
  fail "a sheet with no critic record must not be ready" "$(barrier "$RUN")"

# A critic that skipped a screen, or emitted something unparseable, is refused.
if printf 'FINE · 01-lantern-1280.png · ok\n' | critic "$RUN" >/dev/null; then fail "a skipped screen is not a FINE"; fi
if printf 'FINE · 01-lantern-1280.png · ok\nlooks good to me\n' | critic "$RUN" >/dev/null; then fail "garbage critic line accepted"; fi
[ ! -e "$RUN/contact-sheet/critic.json" ] || fail "a refused critic record must write nothing"

# --- BROKEN undispositioned => not ready; FINE is never a candidate -----------
printf 'NOTE · design system changed since calibration (41c27273 → 99999999)\nFINE · 01-lantern-1280.png · ok at 1280\nBROKEN · 01-lantern-390.png · Shelf label clipped at 390\n' |
  critic "$RUN" | jq -e '.ok and .candidates == ["lantern@mobile"]' >/dev/null || fail "record-critic"
jq -e '.rubric.sha256 and .designSystemVersion == "41c27273" and (.notes | length) == 1
  and .manifestGeneratedAt == "2026-09-17T10:00:00Z"' "$RUN/contact-sheet/critic.json" >/dev/null || fail "critic.json shape"
barrier "$RUN" | jq -e '.ready == false and .missing == [] and .invalid == ["contact-sheet/dispositions.json#lantern@mobile"]
  and (.invalidReasons[0] | contains("no owner") and contains("Shelf label clipped"))' >/dev/null ||
  fail "an undispositioned BROKEN must block synthesis readiness" "$(barrier "$RUN")"
python3 "$VC" list "$RUN" | jq -e '.undispositioned == ["lantern@mobile"] and .candidates[0].kinds == ["critic-broken"]' >/dev/null || fail "list"

# --- each disposition kind => ready -------------------------------------------
printf 'png' >"$RUN/contact-sheet/repro-lantern-390.png"
if dispose "$RUN" lantern@desktop blocked --reason x >/dev/null; then fail "a FINE screen is not a candidate"; fi
if dispose "$RUN" lantern@mobile refuted-capture-artifact --reason "drawer left open" >/dev/null; then fail "refuted needs the live viewport evidence"; fi
if dispose "$RUN" lantern@mobile deferred --owner design >/dev/null; then fail "deferred needs a revisit trigger"; fi
if dispose "$RUN" lantern@mobile blocked >/dev/null; then fail "blocked needs a reason"; fi

dispose "$RUN" lantern@mobile refuted-capture-artifact --reason "nav drawer left open by the capture recipe" \
  --evidence contact-sheet/repro-lantern-390.png >/dev/null
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "refuted-capture-artifact => ready" "$(barrier "$RUN")"
dispose "$RUN" lantern@mobile deferred --owner design-lead --trigger "next mobile layout change or a claim of 390 support" | jq -e '.replaced == true' >/dev/null
jq -e '.dispositions | length == 1' "$RUN/contact-sheet/dispositions.json" >/dev/null || fail "a candidate keeps exactly one disposition"
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "deferred => ready"
dispose "$RUN" lantern@mobile blocked --reason "preview was torn down before the viewport repro" >/dev/null
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "blocked => ready"

# confirmed is only complete once it IS a normal finding: a lane marker's
# confirmedFindings carries the id, which is what the clip rule then enforces.
dispose "$RUN" lantern@mobile confirmed --finding V1 --evidence contact-sheet/repro-lantern-390.png >/dev/null
barrier "$RUN" | jq -e '.ready == false and (.invalidReasons[0] | contains("no required lane marker lists it in confirmedFindings"))' >/dev/null ||
  fail "confirmed without a finding in the lifecycle must not be ready" "$(barrier "$RUN")"
CONFIRMED="$(new_run lantern-confirmed V1)"
cp -r "$RUN/contact-sheet" "$CONFIRMED/"
barrier "$CONFIRMED" | jq -e '.ready == true' >/dev/null || fail "confirmed + confirmedFindings => ready" "$(barrier "$CONFIRMED")"

# Two dispositions for one candidate is not "exactly one".
jq '.dispositions += [.dispositions[0]]' "$RUN/contact-sheet/dispositions.json" >"$RUN/d.tmp" && mv "$RUN/d.tmp" "$RUN/contact-sheet/dispositions.json"
barrier "$RUN" | jq -e '.ready == false and (.invalidReasons[0] | contains("exactly one"))' >/dev/null || fail "duplicate dispositions"

# --- required capture failed and not re-captured => missing evidence ----------
RUN="$(new_run capture-failed)"
manifest "$RUN" 2026-09-17T10:00:00Z "[$(screen lantern "$(w 01-lantern-1280.png)" "$(w "")")]"
printf 'FINE · 01-lantern-1280.png · ok\n' | critic "$RUN" >/dev/null
barrier "$RUN" | jq -e '.ready == false and .missing == ["contact-sheet/dispositions.json#lantern@mobile"]
  and (.invalidReasons[0] | contains("MISSING EVIDENCE") and contains("open failed: timeout"))' >/dev/null ||
  fail "a failed required capture is missing evidence" "$(barrier "$RUN")"
printf 'png' >"$RUN/contact-sheet/x.png"
if dispose "$RUN" lantern@mobile refuted-capture-artifact --reason flake --evidence contact-sheet/x.png >/dev/null; then
  fail "a capture that never happened cannot be refuted as a capture artifact"; fi
if dispose "$RUN" lantern@mobile deferred --owner a --trigger b >/dev/null; then fail "an unseen screen cannot be deferred"; fi
# Re-captured: the candidate is gone, and the old critic record no longer covers the new capture.
manifest "$RUN" 2026-09-17T11:00:00Z "$LANTERN"
barrier "$RUN" | jq -e '.ready == false and .invalid == ["contact-sheet/critic.json"]
  and (.invalidReasons[0] | contains("graded a different capture"))' >/dev/null || fail "a re-capture needs a re-grade" "$(barrier "$RUN")"
printf 'FINE · 01-lantern-1280.png · ok\nFINE · 01-lantern-390.png · ok\n' | critic "$RUN" >/dev/null
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "re-captured and graded FINE => ready"
# Not re-captured, honestly blocked: ready, and it stays on the record as untested.
manifest "$RUN" 2026-09-17T12:00:00Z "[$(screen lantern "$(w 01-lantern-1280.png)" "$(w "")")]"
printf 'FINE · 01-lantern-1280.png · ok\n' | critic "$RUN" >/dev/null
dispose "$RUN" lantern@mobile blocked --reason "preview rejects the 390 viewport session; three attempts" >/dev/null
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "blocked capture => ready"

# --- unsettled -----------------------------------------------------------------
RUN="$(new_run unsettled)"
manifest "$RUN" 2026-09-17T10:00:00Z "[$(screen lantern "$(w 01-lantern-1280.png false)" "$(w 01-lantern-390.png)")]"
printf 'FINE · 01-lantern-1280.png · ok\nFINE · 01-lantern-390.png · ok\n' | critic "$RUN" | jq -e '.candidates == ["lantern@desktop"]' >/dev/null ||
  fail "settled:false is a candidate even when graded FINE"

# --- freeze vs author-PR: DEGRADED is a candidate only on a screen the diff says changed
RUN="$(new_run freeze)" # no baseline => no diff in the manifest
manifest "$RUN" 2026-09-17T10:00:00Z "$LANTERN"
printf 'DEGRADED · 01-lantern-1280.png · off-token grey\nDEGRADED · 01-lantern-390.png · off-token grey\n' | critic "$RUN" | jq -e '.candidates == []' >/dev/null ||
  fail "without a baseline diff, DEGRADED is not a candidate"
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "freeze DEGRADED => ready"
RUN="$(new_run author-pr)"
manifest "$RUN" 2026-09-17T10:00:00Z "[$(screen lantern "$(w 01-lantern-1280.png true changed)" "$(w 01-lantern-390.png true unchanged)"),$(screen list "$(w 02-list-1280.png true changed)" "$(w 02-list-390.png true failed)")]"
# lantern@mobile is `unchanged`, so the critic may skip it; list@desktop changed but FINE.
printf 'DEGRADED · 01-lantern-1280.png · spacing off the scale\nFINE · 02-list-1280.png · ok\nDEGRADED · 02-list-390.png · spacing off the scale\n' |
  critic "$RUN" | jq -e '.candidates == ["lantern@desktop"]' >/dev/null ||
  fail "author-PR: only changed+DEGRADED is a candidate (not changed+FINE, not DEGRADED with a failed diff)"
barrier "$RUN" | jq -e '.ready == false and .invalid == ["contact-sheet/dispositions.json#lantern@desktop"]' >/dev/null || fail "changed+DEGRADED blocks readiness"

# --- critic recorded as not run ------------------------------------------------
RUN="$(new_run critic-down)"
manifest "$RUN" 2026-09-17T10:00:00Z "$LANTERN"
python3 "$VC" record-critic "$RUN" --unavailable "critic provider returned 529 three times" | jq -e '.candidates == ["critic@sheet"]' >/dev/null || fail "unavailable"
barrier "$RUN" | jq -e '.ready == false and .invalid == ["contact-sheet/dispositions.json#critic@sheet"]' >/dev/null || fail "an unrun critic is owed a disposition"
printf 'png' >"$RUN/contact-sheet/x.png"
if dispose "$RUN" critic@sheet refuted-capture-artifact --reason x --evidence contact-sheet/x.png >/dev/null; then fail "an unrun critic cannot be refuted"; fi
dispose "$RUN" critic@sheet blocked --reason "critic provider down for the whole campaign window" >/dev/null
barrier "$RUN" | jq -e '.ready == true' >/dev/null || fail "unrun critic, blocked => ready"

# --- derived shared views: refuted artifacts are kept for reuse -----------------
RUN="$(new_run reuse)"
manifest "$RUN" 2026-09-17T10:00:00Z "$LANTERN"
printf 'FINE · 01-lantern-1280.png · ok\nBROKEN · 01-lantern-390.png · header overlaps content\n' | critic "$RUN" >/dev/null
printf 'png' >"$RUN/contact-sheet/repro.png"
dispose "$RUN" lantern@mobile refuted-capture-artifact --reason "sticky header stitched mid-page by the full-page capture" --evidence contact-sheet/repro.png >/dev/null
python3 "$VC" aggregate "$TMP/runs" known-artifacts | jq -e '
  any(.knownCaptureArtifacts[]; .screen == "lantern" and .width == "mobile" and .runId == "reuse"
    and (.reason | contains("sticky header")))' >/dev/null || fail "a refuted artifact must be derivable for the next critic"
python3 "$VC" aggregate "$TMP/runs" critic-log | jq -se '
  any(.[]; .runId == "reuse" and .grade == "BROKEN" and .disposition == "refuted-capture-artifact")
  and any(.[]; .runId == "critic-down" and .grade == "NOT_RUN")
  and ([.[] | .runId] | unique | length) >= 6' >/dev/null || fail "critic-log is derived from every run dir"

echo "smoke visual candidates tests passed"
