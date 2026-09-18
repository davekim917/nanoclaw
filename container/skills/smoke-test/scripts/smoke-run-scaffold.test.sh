#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_BASE="$(mktemp -d)"
FIXTURE_DIR="$FIXTURE_BASE/run-fixture"
STUB_BIN="$FIXTURE_BASE/bin"
SHARED_ROOT="$FIXTURE_BASE/workgroup"
export SMOKE_GATE_SHARED_ROOT="$SHARED_ROOT"
export SMOKE_GATE_LEASE_DIR="$SHARED_ROOT/lease-fixture"
export SMOKE_GATE_OWNER=scaffold-owner
trap 'rm -rf "$FIXTURE_BASE"' EXIT
mkdir -p "$FIXTURE_DIR"
mkdir -p "$STUB_BIN" "$SHARED_ROOT"
cat > "$STUB_BIN/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
chmod +x "$STUB_BIN/mountpoint"
export PATH="$STUB_BIN:$PATH"

SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
OTHER_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
# Every legitimate caller of the scaffold is coordinator-side; the role checks
# below are the only cases that override this.
export SMOKE_LANE_ROLE=coordinator
# ...and holds the gate plus its shared coordinator lease.
GATE_STATE="$FIXTURE_BASE/gate-state"
mkdir -p "$GATE_STATE" "$SMOKE_GATE_LEASE_DIR"
export SMOKE_GATE_STATE_DIR="$GATE_STATE"
gate_owns() {
  local run="$1" active_sha="${2:-$SHA}" owner="${3:-$SMOKE_GATE_OWNER}" now expires
  now="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  expires="$(date -u -d '@'$(( $(date -u +%s) + 3600 )) +'%Y-%m-%dT%H:%M:%SZ')"
  printf '{"schemaVersion":1,"pr":5,"activeRunId":"%s","activeSha":"%s","activeLeaseOwner":"%s"}\n' \
    "$run" "$active_sha" "$owner" > "$GATE_STATE/pr-5-state.json"
  printf '{"schemaVersion":1,"pr":5,"owner":"%s","claimedAt":"%s","renewedAt":"%s","expiresAt":"%s","repoSlug":"org__repo"}\n' \
    "$owner" "$now" "$now" "$expires" > "$SMOKE_GATE_LEASE_DIR/lease-$run.json"
  printf '{"schemaVersion":1,"pr":5,"runId":"%s","owner":"%s","boundAt":"%s"}\n' \
    "$run" "$owner" "$now" > "$SMOKE_GATE_LEASE_DIR/pr-5-authority.json"
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
  .schemaVersion == 2 and
  .pr == 5 and .repoSlug == "org__repo" and
  (.requiredLaneMarkers | sort == ["markers/B1.json","markers/S1.json"]) and
  (.lanes | length == 2) and
  .markerDir == "markers" and
  .environment == "https://dev.example" and
  .leasePolicy == "one at a time"
' "$FIXTURE_DIR/completion-contract.json" >/dev/null

# Deployment extras must never be able to forge the fields the barrier checks
# — the campaign identity included. (`--regenerate` because this is a
# deliberate same-SHA rewrite of a contract that already exists — the
# re-scaffold guard refuses one without it.)
SMOKE_CONTRACT_EXTRA="{\"sourceSha\":\"$OTHER_SHA\",\"requiredLaneMarkers\":[],\"pr\":9,\"repoSlug\":\"evil__repo\",\"schemaVersion\":1}" \
  scaffold contract "$FIXTURE_DIR" "$SHA" B1:browser S1:source --regenerate >/dev/null
jq -e --arg sha "$SHA" '.sourceSha == $sha and (.requiredLaneMarkers | length == 2) and
  .schemaVersion == 2 and .pr == 5 and .repoSlug == "org__repo"' \
  "$FIXTURE_DIR/completion-contract.json" >/dev/null

# Valid JSON with an invalid UTC timestamp is not a usable shared lease.
jq '.expiresAt="not-a-timestamp"' "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$FIXTURE_DIR").json" \
  > "$SMOKE_GATE_LEASE_DIR/.bad-time"
mv "$SMOKE_GATE_LEASE_DIR/.bad-time" "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$FIXTURE_DIR").json"
OUT="$(scaffold marker "$FIXTURE_DIR" B1 fail bad-time 2>&1 || true)"
jq -e '.ok == false and (.error | test("missing or malformed|invalid UTC timestamp"))' <<<"$OUT" >/dev/null
[ ! -e "$FIXTURE_DIR/markers/B1.json" ]
gate_owns "$(basename "$FIXTURE_DIR")"

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

# Expiry/reclaim may preserve the published run id. A stale coordinator must
# not adopt the successor's token from shared state or keep writing contract,
# marker, or generation metadata under that same basename.
STALE="$FIXTURE_BASE/stale-owner-run"
mkdir -p "$STALE"
gate_owns "$(basename "$STALE")" "$SHA" owner-a
SMOKE_GATE_OWNER=owner-a scaffold contract "$STALE" "$SHA" B1:browser >/dev/null
STALE_CONTRACT_SHA="$(sha256sum "$STALE/completion-contract.json" | cut -d' ' -f1)"
gate_owns "$(basename "$STALE")" "$OTHER_SHA" owner-b
for stale_verb in marker redispatch contract; do
  case "$stale_verb" in
    marker) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold marker "$STALE" B1 fail stale 2>&1 || true)" ;;
    redispatch) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold redispatch "$STALE" B1 2>&1 || true)" ;;
    contract) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold contract "$STALE" "$SHA" B1:source --regenerate 2>&1 || true)" ;;
  esac
  jq -e '.ok == false and (.error | test("caller owner does not match"))' <<<"$OUT" >/dev/null || {
    echo "expected stale owner $stale_verb to be refused, got: $OUT" >&2; exit 1; }
done
[ "$(sha256sum "$STALE/completion-contract.json" | cut -d' ' -f1)" = "$STALE_CONTRACT_SHA" ]
[ ! -e "$STALE/markers/B1.json" ]
# DELIBERATE CONTRACT CHANGE. This block used to assert
# "the successor cannot inherit A's contract" with `--regenerate` as the only
# exit. It still cannot inherit SILENTLY — an unadopted marker is refused, and
# the refusal now names `adopt` — but a same-SHA successor may take the fenced
# `adopt` transition (cases below). B here reclaimed on a DIFFERENT sourceSha,
# which is a different campaign: adopt is refused and `--regenerate` remains
# the only path.
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold marker "$STALE" B1 fail successor 2>&1 || true)"
jq -e '.ok == false and (.error | test("different coordinator owner")) and (.error | test("adopt"))' <<<"$OUT" >/dev/null
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$STALE" "$OTHER_SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("different sourceSha")) and (.error | test("--regenerate"))' <<<"$OUT" >/dev/null || {
  echo "expected a different-SHA adopt to be refused toward --regenerate, got: $OUT" >&2; exit 1; }
# ...and naming the OLD sha does not get around it: the fence binds the verb to
# the SHA this run actually claimed.
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$STALE" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not match the SHA claimed"))' <<<"$OUT" >/dev/null
[ "$(sha256sum "$STALE/completion-contract.json" | cut -d' ' -f1)" = "$STALE_CONTRACT_SHA" ]
SMOKE_GATE_OWNER=owner-b scaffold contract "$STALE" "$OTHER_SHA" B1:browser --regenerate >/dev/null
SMOKE_GATE_OWNER=owner-b scaffold marker "$STALE" B1 fail successor >/dev/null

# --- Fenced adoption: same run id, same sourceSha, recovered under a new owner.
# A wrote the contract, finished B1, re-dispatched S1 (generation 2) and wrote
# its gen-2 marker, and never got to B2 — partially completed lane generations.
ADOPT="$FIXTURE_BASE/adopt-run"
mkdir -p "$ADOPT"
gate_owns "$(basename "$ADOPT")" "$SHA" owner-a
SMOKE_GATE_OWNER=owner-a scaffold contract "$ADOPT" "$SHA" B1:browser S1:source B2:browser >/dev/null
SMOKE_GATE_OWNER=owner-a scaffold marker "$ADOPT" B1 fail 'by the original owner' >/dev/null
SMOKE_GATE_OWNER=owner-a scaffold redispatch "$ADOPT" S1 >/dev/null
SMOKE_GATE_OWNER=owner-a scaffold marker "$ADOPT" S1 completed 'gen 2 by the original owner' >/dev/null
ADOPT_B1_HASH="$(sha256sum "$ADOPT/markers/B1.json" | cut -d' ' -f1)"
ADOPT_S1_HASH="$(sha256sum "$ADOPT/markers/S1.json" | cut -d' ' -f1)"
ADOPT_LANES="$(jq -c '[.lanes, .requiredLaneMarkers, .createdAt, .sourceSha, .runId]' "$ADOPT/completion-contract.json")"
# The original owner adopting its own contract is the exact-retry no-op shape.
ADOPT_BEFORE="$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)"
SMOKE_GATE_OWNER=owner-a scaffold adopt "$ADOPT" "$SHA" |
  jq -e '.ok == true and .adopted == false and .alreadyOwner == true and .adoptionCount == 0' >/dev/null
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_BEFORE" ]

# Recovery: the gate rebinds state, lease and authority to B on the SAME sha.
gate_owns "$(basename "$ADOPT")" "$SHA" owner-b
# Old owner still alive, BEFORE adoption: every verb, adopt included, dies on
# the fence — never on the contract check, which A would otherwise still pass.
for stale_verb in marker redispatch adopt contract; do
  case "$stale_verb" in
    marker) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold marker "$ADOPT" B2 fail stale 2>&1 || true)" ;;
    redispatch) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold redispatch "$ADOPT" B1 2>&1 || true)" ;;
    adopt) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)" ;;
    contract) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold contract "$ADOPT" "$SHA" B1:source --regenerate 2>&1 || true)" ;;
  esac
  jq -e '.ok == false and (.error | test("caller owner does not match"))' <<<"$OUT" >/dev/null || {
    echo "expected pre-adoption stale owner $stale_verb to be refused by the fence, got: $OUT" >&2; exit 1; }
done
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_BEFORE" ]
[ ! -e "$ADOPT/markers/B2.json" ]
# The successor is still refused until it adopts explicitly.
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold marker "$ADOPT" B2 fail unadopted 2>&1 || true)"
jq -e '.ok == false and (.error | test("different coordinator owner"))' <<<"$OUT" >/dev/null
[ ! -e "$ADOPT/markers/B2.json" ]
# A third identity that holds nothing cannot adopt either (the loser of two
# competing recoveries is exactly this caller).
OUT="$(SMOKE_GATE_OWNER=owner-c scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("caller owner does not match"))' <<<"$OUT" >/dev/null
# Role and expiry gates apply to adopt like every other write.
OUT="$(SMOKE_LANE_ROLE=challenger SMOKE_GATE_OWNER=owner-b scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("SMOKE_LANE_ROLE"))' <<<"$OUT" >/dev/null
jq '.expiresAt="2000-01-01T00:00:00Z"' "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$ADOPT").json" > "$SMOKE_GATE_LEASE_DIR/.expired"
mv "$SMOKE_GATE_LEASE_DIR/.expired" "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$ADOPT").json"
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("lease expired"))' <<<"$OUT" >/dev/null
gate_owns "$(basename "$ADOPT")" "$SHA" owner-b
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_BEFORE" ]

# Crash between validation and the contract write: the live contract is
# byte-identical (tmp + mv), and the retry succeeds.
SMOKE_SCAFFOLD_TEST_CRASH_BEFORE_ADOPT_COMMIT=1 SMOKE_GATE_OWNER=owner-b \
  scaffold adopt "$ADOPT" "$SHA" >/dev/null 2>&1 && {
  echo "expected the crash seam to kill adopt before its commit" >&2; exit 1; } || true
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_BEFORE" ]
SMOKE_GATE_OWNER=owner-b scaffold adopt "$ADOPT" "$SHA" |
  jq -e '.ok == true and .adopted == true and .adoptionCount == 1' >/dev/null

# Only the owner binding moved. Lanes, generations, marker list, createdAt,
# sourceSha and runId are untouched; no marker file was rewritten.
[ "$(jq -c '[.lanes, .requiredLaneMarkers, .createdAt, .sourceSha, .runId]' "$ADOPT/completion-contract.json")" = "$ADOPT_LANES" ]
[ "$(sha256sum "$ADOPT/markers/B1.json" | cut -d' ' -f1)" = "$ADOPT_B1_HASH" ]
[ "$(sha256sum "$ADOPT/markers/S1.json" | cut -d' ' -f1)" = "$ADOPT_S1_HASH" ]
# History records THAT ownership changed hands and when — nothing derived from
# either owner value: no token, and no digest of one (a task owner may be a
# hostname, so an unsalted digest is enumerable). The successor is an adopter;
# nothing anywhere names it as the author.
jq -e '
  .coordinatorOwnerToken == "owner-b" and
  (.ownerAdoptions | length == 1) and
  (.ownerAdoptions[0] | keys == ["adoptedAt","index"]) and
  .ownerAdoptions[0].index == 1 and
  (.ownerAdoptions[0].adoptedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' "$ADOPT/completion-contract.json" >/dev/null
for leaked in owner-a "$(printf '%s' owner-a | sha256sum | cut -d' ' -f1)" \
              "$(printf '%s' owner-b | sha256sum | cut -d' ' -f1)"; do
  if grep -qF "$leaked" "$ADOPT/completion-contract.json"; then
    echo "adoption stored a predecessor token or an owner-derived digest in the contract" >&2; exit 1
  fi
done
# Exact retry is a no-op: same bytes, no second history entry.
ADOPT_AFTER="$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)"
SMOKE_GATE_OWNER=owner-b scaffold adopt "$ADOPT" "$SHA" |
  jq -e '.ok == true and .adopted == false and .alreadyOwner == true and .adoptionCount == 1' >/dev/null
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_AFTER" ]

# Old owner still alive, AFTER adoption: still the fence, still nothing written.
for stale_verb in marker redispatch adopt contract; do
  case "$stale_verb" in
    marker) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold marker "$ADOPT" B2 fail stale 2>&1 || true)" ;;
    redispatch) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold redispatch "$ADOPT" B1 2>&1 || true)" ;;
    adopt) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)" ;;
    contract) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold contract "$ADOPT" "$SHA" B1:source --regenerate 2>&1 || true)" ;;
  esac
  jq -e '.ok == false and (.error | test("caller owner does not match"))' <<<"$OUT" >/dev/null || {
    echo "expected post-adoption stale owner $stale_verb to be refused by the fence, got: $OUT" >&2; exit 1; }
done
[ "$(sha256sum "$ADOPT/completion-contract.json" | cut -d' ' -f1)" = "$ADOPT_AFTER" ]
[ ! -e "$ADOPT/markers/B2.json" ]

# The successor finishes the missing lane. A's markers keep validating at the
# generations A wrote them at, and the barrier goes ready without a regenerate.
SMOKE_GATE_OWNER=owner-b scaffold marker "$ADOPT" B2 fail 'by the recovery owner' |
  jq -e '.ok == true and .generation == 1' >/dev/null
jq -e '.generation == 1' "$ADOPT/markers/B1.json" >/dev/null
jq -e '.generation == 2' "$ADOPT/markers/S1.json" >/dev/null
barrier "$ADOPT" lanes | jq -e '.ready == true' >/dev/null
# redispatch works for the adopter too, and retires only the lane it names.
SMOKE_GATE_OWNER=owner-b scaffold redispatch "$ADOPT" B2 | jq -e '.ok == true and .generation == 2' >/dev/null
jq -e '[.lanes[] | {(.id): .generation}] | add == {"B1":1,"S1":2,"B2":2}' "$ADOPT/completion-contract.json" >/dev/null

# Already-terminal run: the slot is gone, so there is nothing to adopt into.
printf '{"schemaVersion":1,"pr":5,"activeRunId":null,"completedRunId":"%s"}\n' "$(basename "$ADOPT")" \
  > "$GATE_STATE/pr-5-state.json"
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$ADOPT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not hold the gate"))' <<<"$OUT" >/dev/null

# Nothing to adopt, and nothing legitimate to continue.
NOCONTRACT="$FIXTURE_BASE/adopt-no-contract"
mkdir -p "$NOCONTRACT"
gate_owns "$(basename "$NOCONTRACT")" "$SHA" owner-b
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$NOCONTRACT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("nothing to adopt"))' <<<"$OUT" >/dev/null
printf '{"schemaVersion":1,"runId":"%s","sourceSha":"%s","ownershipKind":"pr","coordinatorOwnerToken":null,"requiredLaneMarkers":[]}\n' \
  "$(basename "$NOCONTRACT")" "$SHA" > "$NOCONTRACT/completion-contract.json"
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$NOCONTRACT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("no coordinator owner"))' <<<"$OUT" >/dev/null
printf '{"schemaVersion":1,"sourceSha"' > "$NOCONTRACT/completion-contract.json"
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$NOCONTRACT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("truncated or corrupt"))' <<<"$OUT" >/dev/null
OUT="$(SMOKE_GATE_OWNER=owner-b scaffold adopt "$NOCONTRACT" deadbeef 2>&1 || true)"
jq -e '.ok == false and (.error | test("40-character"))' <<<"$OUT" >/dev/null

# Separate private state roots are the original failure shape: A's state still
# names A while B has reclaimed the one shared lease. Shared validation must
# stop A before it can alter either contract or marker.
SEPARATE="$FIXTURE_BASE/separate-owner-run"
SEP_A="$FIXTURE_BASE/state-a" SEP_B="$FIXTURE_BASE/state-b"
mkdir -p "$SEPARATE" "$SEP_A" "$SEP_B"
GATE_STATE="$SEP_A"; export SMOKE_GATE_STATE_DIR="$SEP_A"
gate_owns "$(basename "$SEPARATE")" "$SHA" owner-a
SMOKE_GATE_OWNER=owner-a scaffold contract "$SEPARATE" "$SHA" B1:browser >/dev/null
SMOKE_GATE_OWNER=owner-a scaffold marker "$SEPARATE" B1 fail original >/dev/null
SEP_CONTRACT_HASH="$(sha256sum "$SEPARATE/completion-contract.json" | cut -d' ' -f1)"
SEP_MARKER_HASH="$(sha256sum "$SEPARATE/markers/B1.json" | cut -d' ' -f1)"
GATE_STATE="$SEP_B"; export SMOKE_GATE_STATE_DIR="$SEP_B"
gate_owns "$(basename "$SEPARATE")" "$OTHER_SHA" owner-b
export SMOKE_GATE_STATE_DIR="$SEP_A"
for stale_verb in marker redispatch contract; do
  case "$stale_verb" in
    marker) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold marker "$SEPARATE" B1 fail stale 2>&1 || true)" ;;
    redispatch) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold redispatch "$SEPARATE" B1 2>&1 || true)" ;;
    contract) OUT="$(SMOKE_GATE_OWNER=owner-a scaffold contract "$SEPARATE" "$SHA" B1:source --regenerate 2>&1 || true)" ;;
  esac
  jq -e '.ok == false and (.error | test("another owner|different coordinator|belongs to another"))' <<<"$OUT" >/dev/null || {
    echo "expected separate-state stale owner $stale_verb to be refused, got: $OUT" >&2; exit 1; }
done
[ "$(sha256sum "$SEPARATE/completion-contract.json" | cut -d' ' -f1)" = "$SEP_CONTRACT_HASH" ]
[ "$(sha256sum "$SEPARATE/markers/B1.json" | cut -d' ' -f1)" = "$SEP_MARKER_HASH" ]
GATE_STATE="$FIXTURE_BASE/gate-state"; export SMOKE_GATE_STATE_DIR="$GATE_STATE"

# Resume the ordinary fixture as its original owner.
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

# Neither marker above passed --confirmed-findings; the field must be
# entirely absent, not an empty array — that's what makes every marker
# written before this flag existed round-trip unchanged.
jq -e 'has("confirmedFindings") | not' "$FIXTURE_DIR/markers/B1.json" >/dev/null || {
  echo "expected no --confirmed-findings flag to omit the field entirely" >&2; exit 1; }

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
gate_owns "$(basename "$FIXTURE_DIR")" "$OTHER_SHA"
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
mkdir -p "$FRESH/evidence"
printf '%s\n' 'B1 first receipt' >"$FRESH/evidence/b1-first.txt"
printf '%s\n' 'B2 first receipt' >"$FRESH/evidence/b2-first.txt"
printf '%s\n' 'B1 replay receipt' >"$FRESH/evidence/b1-replay.txt"
printf '%s\n' 'B2 replay receipt' >"$FRESH/evidence/b2-replay.txt"
printf '%s\n' 'B2 redispatch receipt' >"$FRESH/evidence/b2-redispatch.txt"
gate_owns "$(basename "$FRESH")"
scaffold contract "$FRESH" "$SHA" B1:browser B2:browser >/dev/null
scaffold marker "$FRESH" B1 pass 'lane one' 'evidence/b1-first.txt' >/dev/null
scaffold marker "$FRESH" B2 pass 'lane two' 'evidence/b2-first.txt' >/dev/null
mkdir -p "$FRESH/coordinator" "$FRESH/challenger"
printf '# p\n' >"$FRESH/coordinator/preliminary.md"
printf '# d\n' >"$FRESH/challenger/disposition.md"

# A marker inherits the contract's generation, exactly the way it inherits
# sourceSha — never stated by the caller.
jq -e '.generation == 1' "$FRESH/markers/B1.json" >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# N1-A regression: the guard must arm on the PRIOR CONTRACT, not on marker
# count. Lanes get redefined BEFORE any marker lands, so an "only if markers
# exist" condition left the whole early-run window open: rewrite at generation
# 1, then the worker still briefed on the OLD lane stamps its marker, inherits
# generation 1, and the barrier reports ready on old-definition evidence.
# Reproduced end-to-end before this fix.
EARLY="$(dirname "$FIXTURE_DIR")/early-fixture"
mkdir -p "$EARLY/coordinator" "$EARLY/challenger"
printf '# p\n' >"$EARLY/coordinator/preliminary.md"
printf '# d\n' >"$EARLY/challenger/disposition.md"
gate_owns "$(basename "$EARLY")"
scaffold contract "$EARLY" "$SHA" B1:browser B2:browser:'permission crossings' >/dev/null
[ -z "$(ls -A "$EARLY/markers" 2>/dev/null)" ] || { echo "fixture: expected no markers yet" >&2; exit 1; }
OUT="$(scaffold contract "$EARLY" "$SHA" B1:browser B2:browser:'publish exports' 2>&1 || true)"
jq -e '.ok == false and (.error | test("SAME sourceSha"))' <<<"$OUT" >/dev/null || {
  echo "expected a same-SHA re-scaffold with NO markers yet to be refused, got: $OUT" >&2
  exit 1; }
jq -e '.lanes[1].title == "permission crossings"' "$EARLY/completion-contract.json" >/dev/null

# N1-B regression: a contract file that exists but does NOT read as one
# (truncated mid-write, corrupt) must refuse too. `-s`/parse-failure used to
# fall through to "allow", which is fail-open at the exact moment this script
# knows least — and it re-blessed every stale marker at generation 1.
scaffold marker "$EARLY" B1 pass 'stale one' >/dev/null
scaffold marker "$EARLY" B2 pass 'stale two' >/dev/null
: > "$EARLY/completion-contract.json"
OUT="$(scaffold contract "$EARLY" "$SHA" B1:browser B2:browser:'publish exports' 2>&1 || true)"
jq -e '.ok == false and (.error | test("truncated or corrupt"))' <<<"$OUT" >/dev/null || {
  echo "expected a truncated contract to refuse rather than fail open, got: $OUT" >&2
  exit 1; }
[ ! -s "$EARLY/completion-contract.json" ] || { echo "the refused write still landed" >&2; exit 1; }
# ...and --regenerate over a truncated contract must still bump PAST the
# markers on disk. There are no lanes[] left to read, so a contract-only scan
# would reset to 1 and re-bless the very markers it was asked to retire.
scaffold contract "$EARLY" "$SHA" B1:browser B2:browser:'publish exports' --regenerate \
  | jq -e '.ok == true' >/dev/null
jq -e 'all(.lanes[]; .generation == 2)' "$EARLY/completion-contract.json" >/dev/null || {
  echo "expected --regenerate over a truncated contract to bump past the markers on disk" >&2
  exit 1; }
EARLY_OUT="$(barrier "$EARLY" lanes || true)"
jq -e '.ready == false and (.invalid | sort == ["markers/B1.json","markers/B2.json"])' \
  <<<"$EARLY_OUT" >/dev/null || {
  echo "expected the stale markers to be retired, got: $EARLY_OUT" >&2; exit 1; }
gate_owns "$(basename "$FRESH")"

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

# Fresh markers land at the new generation with fresh receipts and the barrier
# clears again. This is the recovery path after a stale or missing pass marker:
# redispatch first, then a new timestamped marker — never backfill the old one.
scaffold marker "$FRESH" B1 pass 'redone' 'evidence/b1-replay.txt' | jq -e '.generation == 2' >/dev/null
scaffold marker "$FRESH" B2 pass 'redone' 'evidence/b2-replay.txt' >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# redispatch bumps ONE lane: its old marker is retired, the finished lane keeps
# counting. Bumping the whole contract here would stall the run.
scaffold redispatch "$FRESH" B2 | jq -e '.ok == true and .generation == 3 and .retiredExistingMarker == true' >/dev/null
ONE="$(barrier "$FRESH" lanes || true)"
jq -e '.ready == false and (.invalid == ["markers/B2.json"])' <<<"$ONE" >/dev/null || {
  echo "expected redispatch to retire only its own lane, got: $ONE" >&2; exit 1; }
scaffold marker "$FRESH" B2 pass 'second attempt' 'evidence/b2-redispatch.txt' | jq -e '.generation == 3' >/dev/null
barrier "$FRESH" lanes | jq -e '.ready == true' >/dev/null

# A receipt-recovery replay must preserve the original empty-evidence marker
# byte-for-byte before replacing it with the next generation's fresh pass.
RECOVERY="$(dirname "$FIXTURE_DIR")/receipt-recovery"
mkdir -p "$RECOVERY/evidence"
printf '%s\n' 'fresh recovery receipt' >"$RECOVERY/evidence/r1-replay.txt"
gate_owns "$(basename "$RECOVERY")"
scaffold contract "$RECOVERY" "$SHA" R1:browser >/dev/null
scaffold marker "$RECOVERY" R1 pass 'original pass lost its receipt' >/dev/null
OLD_MARKER_SHA="$(sha256sum "$RECOVERY/markers/R1.json")"
OLD_MARKER_SHA="${OLD_MARKER_SHA%% *}"
OLD_COMPLETED="$(jq -r '.completedAt' "$RECOVERY/markers/R1.json")"
RECOVERY_BLOCKED="$(barrier "$RECOVERY" lanes || true)"
jq -e '(.ready == false) and (.invalidReasons[0] | contains("nonempty evidence array"))' \
  <<<"$RECOVERY_BLOCKED" >/dev/null || {
  echo "expected the original empty-evidence pass to block recovery" >&2; exit 1; }

scaffold redispatch "$RECOVERY" R1 | jq -e '.generation == 2' >/dev/null
scaffold marker "$RECOVERY" R1 pass 'fresh recovery replay' 'evidence/r1-replay.txt' \
  | jq -e '.generation == 2 and .status == "pass"' >/dev/null
ARCHIVE="$RECOVERY/markers/history/R1.generation-1.json"
[ -f "$ARCHIVE" ] || { echo "expected superseded marker history to exist" >&2; exit 1; }
ARCHIVED_SHA="$(sha256sum "$ARCHIVE")"
ARCHIVED_SHA="${ARCHIVED_SHA%% *}"
[ "$ARCHIVED_SHA" = "$OLD_MARKER_SHA" ] || {
  echo "expected archived marker to preserve the original raw bytes" >&2; exit 1; }
jq -e --arg at "$OLD_COMPLETED" \
  '.generation == 1 and .evidence == [] and .completedAt == $at' "$ARCHIVE" >/dev/null
jq -e '.generation == 2 and .evidence == ["evidence/r1-replay.txt"]' \
  "$RECOVERY/markers/R1.json" >/dev/null
barrier "$RECOVERY" lanes | jq -e '.ready == true' >/dev/null

# Rewriting an ordinary same-generation marker keeps existing behavior: it is
# not a recovery boundary and must not create synthetic history.
scaffold marker "$RECOVERY" R1 pass 'same generation update' 'evidence/r1-replay.txt' >/dev/null
[ ! -e "$RECOVERY/markers/history/R1.generation-2.json" ] || {
  echo "ordinary same-generation marker update was incorrectly archived" >&2; exit 1; }

# A pre-existing, different history record is never overwritten. The new pass
# is refused before the live old marker can be replaced.
CONFLICT="$(dirname "$FIXTURE_DIR")/receipt-conflict"
mkdir -p "$CONFLICT/evidence" "$CONFLICT/markers/history"
printf '%s\n' 'conflict replay receipt' >"$CONFLICT/evidence/c1-replay.txt"
gate_owns "$(basename "$CONFLICT")"
scaffold contract "$CONFLICT" "$SHA" C1:browser >/dev/null
scaffold marker "$CONFLICT" C1 pass 'original' >/dev/null
scaffold redispatch "$CONFLICT" C1 >/dev/null
printf '%s\n' 'different history must survive' >"$CONFLICT/markers/history/C1.generation-1.json"
OUT="$(scaffold marker "$CONFLICT" C1 pass 'replacement' 'evidence/c1-replay.txt' 2>&1 || true)"
jq -e '.ok == false and (.error | test("different raw evidence"))' <<<"$OUT" >/dev/null || {
  echo "expected unequal marker history to refuse replacement, got: $OUT" >&2; exit 1; }
jq -e '.generation == 1 and .evidence == []' "$CONFLICT/markers/C1.json" >/dev/null
[ "$(cat "$CONFLICT/markers/history/C1.generation-1.json")" = 'different history must survive' ] || {
  echo "unequal history was overwritten" >&2; exit 1; }

# redispatch is coordinator-owned and gate-fenced like every other write.
gate_owns "someone-else"
OUT="$(scaffold redispatch "$FRESH" B2 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not hold the gate"))' <<<"$OUT" >/dev/null
gate_owns "$(basename "$FRESH")"
OUT="$(SMOKE_LANE_ROLE=challenger scaffold redispatch "$FRESH" B2 2>&1 || true)"
jq -e '.ok == false and (.error | test("SMOKE_LANE_ROLE"))' <<<"$OUT" >/dev/null
OUT="$(scaffold redispatch "$FRESH" NOPE 2>&1 || true)"
jq -e '.ok == false and (.error | test("not declared"))' <<<"$OUT" >/dev/null

# --confirmed-findings: the only writer of smoke-evidence-barrier.sh's
# finding_clip_problem() input. Isolated fixture — a marker with
# confirmedFindings set changes what the barrier's `lanes` phase requires,
# so this must not share state with the FIXTURE_DIR/FRESH assertions above.
CLIP="$(dirname "$FIXTURE_DIR")/clip-fixture"
mkdir -p "$CLIP/clips"
gate_owns "$(basename "$CLIP")"
scaffold contract "$CLIP" "$SHA" B1:browser >/dev/null

scaffold marker "$CLIP" B1 fail 'two confirmed findings' --confirmed-findings F1,F2 \
  | jq -e '.ok == true and .confirmedFindings == ["F1","F2"]' >/dev/null || {
  echo "expected --confirmed-findings to appear in the ok:true result" >&2; exit 1; }
jq -e '.confirmedFindings == ["F1","F2"]' "$CLIP/markers/B1.json" >/dev/null || {
  echo "expected confirmedFindings to be written into the marker" >&2; exit 1; }

# Same convention as --regenerate: works from any position in the argument
# list, not just trailing.
scaffold marker "$CLIP" --confirmed-findings F3 B1 fail 'repositioned flag' >/dev/null
jq -e '.confirmedFindings == ["F3"]' "$CLIP/markers/B1.json" >/dev/null || {
  echo "expected --confirmed-findings to work from any argument position" >&2; exit 1; }

# Malformed input is refused, not silently coerced.
if scaffold marker "$CLIP" B1 fail 'bad ids' --confirmed-findings 'not an id!' >/dev/null 2>&1; then
  echo "expected a non-alphanumeric finding id to be refused" >&2; exit 1
fi
if scaffold marker "$CLIP" B1 fail 'no value' --confirmed-findings >/dev/null 2>&1; then
  echo "expected a trailing --confirmed-findings with no value to be refused" >&2; exit 1
fi
if scaffold contract "$CLIP" "$SHA" B1:browser --confirmed-findings F1 --regenerate >/dev/null 2>&1; then
  echo "expected --confirmed-findings on a non-marker command to be refused" >&2; exit 1
fi

# End to end: the barrier actually enforces what the scaffold just wrote.
# F3 has no clip and no clip-skipped line yet — the lanes phase must refuse.
barrier "$CLIP" lanes >/dev/null 2>&1 && {
  echo "expected the barrier to refuse a confirmed finding with no clip evidence" >&2; exit 1; }

# A stated clip-skipped reason (still written through the scaffold's normal
# evidence-csv positional, since it is just another evidence-array string)
# clears the barrier with no clip file.
scaffold marker "$CLIP" B1 fail 'skipped clip' 'clip-skipped: F3: no browser lease' \
  --confirmed-findings F3 >/dev/null
barrier "$CLIP" lanes | jq -e '.ready == true' >/dev/null || {
  echo "expected a stated clip-skipped reason to clear the barrier" >&2; exit 1; }

# A real, nonempty clip file also clears it.
printf 'fake mp4 bytes\n' >"$CLIP/clips/F3.mp4"
scaffold marker "$CLIP" B1 fail 'real clip' 'clips/F3.mp4' --confirmed-findings F3 >/dev/null
barrier "$CLIP" lanes | jq -e '.ready == true' >/dev/null || {
  echo "expected a real clip file to clear the barrier" >&2; exit 1; }

# --- Task-scoped certification: the same shared ownership check as a PR run -
# begin_active_run_fence had exactly two accepted active-slot shapes (`pr`,
# `develop`). A task-scoped certification/re-verification/evidence-recovery
# run matched neither, so contract/marker/redispatch refused it outright —
# and coordinators hand-composed the artifacts directly instead, bypassing
# every check below. `smoke-pr-gate.sh task-claim` is the real
# production entry path; call it here rather than hand-writing a fixture, so
# this proves the actual claim -> scaffold write chain, not just a schema
# match.
gate() { bash "$SCRIPT_DIR/smoke-pr-gate.sh" "$@"; }

TASK_RUN="$FIXTURE_BASE/task-run-fixture"
mkdir -p "$TASK_RUN/evidence"
TASK_RUN_ID="$(basename "$TASK_RUN")"

# The bypass itself: with no claim at all, the scaffold refuses exactly like
# an unclaimed PR run. This is the defect the fix closes.
NOCLAIM_OUT="$(scaffold contract "$TASK_RUN" "$SHA" B1:browser 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not hold the gate")) and (.error | test("STOP"))' \
  <<<"$NOCLAIM_OUT" >/dev/null || {
  echo "expected an unclaimed task-scoped run to be refused, got: $NOCLAIM_OUT" >&2; exit 1; }
[ ! -e "$TASK_RUN/completion-contract.json" ] || { echo "the refused write still landed" >&2; exit 1; }

# A legitimate task-claim opens exactly the same door a PR claim does.
gate task-claim "$TASK_RUN_ID" "$SHA" | jq -e '.ok == true' >/dev/null
scaffold contract "$TASK_RUN" "$SHA" B1:browser:'certification lane' \
  | jq -e '.ok == true and .laneCount == 1' >/dev/null
printf 'ok\n' >"$TASK_RUN/evidence/ok.txt"
scaffold marker "$TASK_RUN" B1 pass 'certified' 'evidence/ok.txt' | jq -e '.ok == true' >/dev/null
barrier "$TASK_RUN" lanes | jq -e '.ready == true' >/dev/null || {
  echo "expected the barrier to accept a task-scoped run's contract and marker" >&2; exit 1; }

# task-progress renews the shared lease; the scaffold keeps working under it.
gate task-progress "$TASK_RUN_ID" | jq -e '.ok == true and .leaseRenewed == true' >/dev/null
scaffold redispatch "$TASK_RUN" B1 | jq -e '.ok == true and .generation == 2' >/dev/null

# After task-release, the run is unclaimed again and every write refuses —
# same "does not hold the gate" shape as a finished/reclaimed PR run.
gate task-release "$TASK_RUN_ID" | jq -e '.ok == true' >/dev/null
RELEASED_OUT="$(scaffold marker "$TASK_RUN" B1 pass 'after release' 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not hold the gate"))' <<<"$RELEASED_OUT" >/dev/null || {
  echo "expected a released task run to be refused, got: $RELEASED_OUT" >&2; exit 1; }

# A run displaced by --takeover to a different owner is refused exactly like
# the stale-PR-owner case above — same check, same message.
STALE_TASK="$FIXTURE_BASE/task-run-stale"
mkdir -p "$STALE_TASK"
gate task-claim "$(basename "$STALE_TASK")" "$SHA" >/dev/null
scaffold contract "$STALE_TASK" "$SHA" B1:browser >/dev/null
SMOKE_GATE_OWNER=someone-else gate task-claim "$(basename "$STALE_TASK")" "$SHA" --takeover >/dev/null
STALE_TASK_OUT="$(scaffold marker "$STALE_TASK" B1 fail 'stale' 2>&1 || true)"
jq -e '.ok == false and (.error | test("caller owner does not match"))' <<<"$STALE_TASK_OUT" >/dev/null || {
  echo "expected a takeover-displaced task owner to be refused, got: $STALE_TASK_OUT" >&2; exit 1; }

# The contract's sourceSha must still match the claimed deploySha — a task run
# gets the same "artifact SHA still the claimed SHA" guarantee as a PR run.
SHA_MISMATCH="$FIXTURE_BASE/task-run-sha-mismatch"
mkdir -p "$SHA_MISMATCH"
gate task-claim "$(basename "$SHA_MISMATCH")" "$SHA" >/dev/null
MISMATCH_OUT="$(scaffold contract "$SHA_MISMATCH" "$OTHER_SHA" B1:browser 2>&1 || true)"
jq -e '.ok == false and (.error | test("does not match the SHA claimed"))' <<<"$MISMATCH_OUT" >/dev/null || {
  echo "expected a contract SHA mismatched with the task claim to be refused, got: $MISMATCH_OUT" >&2; exit 1; }

# --- Task-scoped run, end to end: claim -> scaffold -> barrier -> finish ---
# The gate unit tests (smoke-pr-gate.test.sh) cover task-finish in isolation,
# against a hand-written fixture state file. This is the actual production
# chain: a real task-claim lease, a scaffold-written contract and marker, a
# real barrier check, and only then task-finish — proving the verdict is
# reachable through the full governed path, not just through the gate script
# alone.
TASK_FIN="$FIXTURE_BASE/task-run-finish"
mkdir -p "$TASK_FIN/evidence"
TASK_FIN_ID="$(basename "$TASK_FIN")"
gate task-claim "$TASK_FIN_ID" "$SHA" | jq -e '.ok == true' >/dev/null
scaffold contract "$TASK_FIN" "$SHA" B1:browser:'certification lane' | jq -e '.ok == true' >/dev/null
printf 'ok\n' >"$TASK_FIN/evidence/ok.txt"
scaffold marker "$TASK_FIN" B1 pass 'certified' 'evidence/ok.txt' | jq -e '.ok == true' >/dev/null
barrier "$TASK_FIN" lanes | jq -e '.ready == true' >/dev/null || {
  echo "expected the barrier to accept the finish-fixture task run" >&2; exit 1; }
gate task-finish "$TASK_FIN_ID" "$SHA" GO | jq -e '.ok == true and .leaseReleased == true and .verdict == "GO"' >/dev/null
jq -e --arg sha "$SHA" --arg run "$TASK_FIN_ID" '.sha == $sha and .runId == $run and .verdict == "GO"' \
  "$GATE_STATE/runs/$TASK_FIN_ID/verdict.json" >/dev/null
[ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-$TASK_FIN_ID.json" ] ||
  { echo "expected task-finish to remove the shared task lease" >&2; exit 1; }
jq -e '.activeRunId == null and .completedRunId == "'"$TASK_FIN_ID"'" and .completedVerdict == "GO"' \
  "$GATE_STATE/task-$TASK_FIN_ID-state.json" >/dev/null

# --- The install's ONE env file, not this test file's ambient export -------
# Item 2 of the ownership review: SKILL.md's task-claim example used to call
# the raw skill script directly (`/app/skills/smoke-test/scripts/
# smoke-pr-gate.sh`), unlike the documented PR `claim` example, which goes
# through an install's deployed wrapper. Bypassing the wrapper meant
# task-claim wrote into the gate's hardcoded defaults (smoke-pr-gate.sh's own
# STATE_DIR/LEASE_DIR fallbacks) — a directory no scaffold/barrier call, and
# no later task-progress/task-finish invocation, would ever share.
#
# The fix is ONE versioned env file the install owns: the wrapper sources it
# (never repeats its exports) before `exec`ing the gate, and a coordinator's
# direct scaffold/barrier calls source that SAME file — not a fresh per-run
# copy of the same values, which is how they used to drift. This proves that
# with NO ambient SMOKE_GATE_STATE_DIR/SMOKE_GATE_LEASE_DIR export from the
# rest of this test file: only what the real wrapper (which sources the env
# file) and a coordinator (who also sources it directly) would see.
(
  unset SMOKE_GATE_STATE_DIR SMOKE_GATE_LEASE_DIR
  WRAPPER_STATE_DIR="$FIXTURE_BASE/wrapper-state"
  WRAPPER_LEASE_DIR="$SHARED_ROOT/wrapper-leases"
  mkdir -p "$WRAPPER_STATE_DIR" "$WRAPPER_LEASE_DIR"

  # The install's one env file — the single source of truth.
  GATE_ENV="$FIXTURE_BASE/install-gate-env.sh"
  {
    printf 'export SMOKE_GATE_STATE_DIR=%q\n' "$WRAPPER_STATE_DIR"
    printf 'export SMOKE_GATE_LEASE_DIR=%q\n' "$WRAPPER_LEASE_DIR"
  } > "$GATE_ENV"

  # The wrapper sources that file rather than repeating its exports.
  WRAPPER="$FIXTURE_BASE/install-wrapper.sh"
  {
    printf '#!/usr/bin/env bash\nset -u\n'
    printf '. %q\n' "$GATE_ENV"
    printf 'exec bash %q "$@"\n' "$SCRIPT_DIR/smoke-pr-gate.sh"
  } > "$WRAPPER"
  chmod +x "$WRAPPER"

  WIRED_RUN="$FIXTURE_BASE/task-run-wired"
  mkdir -p "$WIRED_RUN/evidence"
  WIRED_RUN_ID="$(basename "$WIRED_RUN")"

  bash "$WRAPPER" task-claim "$WIRED_RUN_ID" "$SHA" | jq -e '.ok == true' >/dev/null

  # A coordinator's direct scaffold/barrier calls source the SAME install
  # env file the wrapper used above — no second, hand-copied file.
  (
    set -a; . "$GATE_ENV"; set +a
    scaffold contract "$WIRED_RUN" "$SHA" B1:browser:'certification lane' | jq -e '.ok == true' >/dev/null
    printf 'ok\n' >"$WIRED_RUN/evidence/ok.txt"
    scaffold marker "$WIRED_RUN" B1 pass 'certified' 'evidence/ok.txt' | jq -e '.ok == true' >/dev/null
    barrier "$WIRED_RUN" lanes | jq -e '.ready == true' >/dev/null
  ) || { echo "expected the wrapper-claimed task run's env to also satisfy the scaffold and barrier" >&2; exit 1; }

  bash "$WRAPPER" task-finish "$WIRED_RUN_ID" "$SHA" GO | jq -e '.ok == true and .leaseReleased == true' >/dev/null
  [ -e "$WRAPPER_STATE_DIR/runs/$WIRED_RUN_ID/verdict.json" ] || {
    echo "expected task-finish through the wrapper to record a verdict under the wrapper's own state dir" >&2; exit 1; }
) || exit 1

# --- --evidence: declaring a floor lane's proof is API-only by design ------
EVID_RUN="$FIXTURE_BASE/evidence-flag-run"
mkdir -p "$EVID_RUN"
gate_owns "$(basename "$EVID_RUN")"

# The value is a fixed vocabulary of one, on purpose (see the flag's own
# comment in smoke-run-scaffold.sh) — anything else is refused.
OUT="$(scaffold contract "$EVID_RUN" "$SHA" F1:floor --evidence F1=screenshot 2>&1 || true)"
jq -e '.ok == false and (.error | test("only supports the value .api."))' <<<"$OUT" >/dev/null || {
  echo "expected a non-'api' --evidence value to be refused, got: $OUT" >&2; exit 1; }

# Declaring evidence for a lane id that is not among the lanes being
# scaffolded on this call must be refused rather than silently ignored.
OUT="$(scaffold contract "$EVID_RUN" "$SHA" F1:floor --evidence F9=api 2>&1 || true)"
jq -e '.ok == false and (.error | test("not among the lanes being scaffolded"))' <<<"$OUT" >/dev/null || {
  echo "expected --evidence naming an undeclared lane to be refused, got: $OUT" >&2; exit 1; }

# --evidence is contract-only.
OUT="$(scaffold marker "$EVID_RUN" F1 pass '' '' --evidence F1=api 2>&1 || true)"
jq -e '.ok == false and (.error | test("only valid with the contract command"))' <<<"$OUT" >/dev/null || {
  echo "expected --evidence on the marker command to be refused, got: $OUT" >&2; exit 1; }

# A valid declaration lands on the matching lane's contract entry, and only
# that lane — a second lane in the same call with no --evidence stays bare.
scaffold contract "$EVID_RUN" "$SHA" F1:floor:'Payout walk' S1:source --evidence F1=api \
  | jq -e '.ok == true and .laneCount == 2' >/dev/null
jq -e '
  (.lanes[] | select(.id == "F1") | .evidence) == "api" and
  (.lanes[] | select(.id == "S1") | has("evidence") | not)
' "$EVID_RUN/completion-contract.json" >/dev/null || {
  echo "expected only F1's contract entry to carry evidence:\"api\"" >&2
  cat "$EVID_RUN/completion-contract.json" >&2; exit 1; }

# The declaration is what the barrier actually reads: an F1 pass with only an
# API receipt (no screenshot) clears the barrier because the CONTRACT says so.
mkdir -p "$EVID_RUN/evidence" "$EVID_RUN/coordinator" "$EVID_RUN/challenger"
printf '{"status":200}\n' >"$EVID_RUN/evidence/api-receipt.json"
scaffold marker "$EVID_RUN" F1 pass 'api proof' 'evidence/api-receipt.json' | jq -e '.ok == true' >/dev/null
printf 'source receipt\n' >"$EVID_RUN/evidence/s1.txt"
scaffold marker "$EVID_RUN" S1 pass 'unit proof' 'evidence/s1.txt' | jq -e '.ok == true' >/dev/null
printf '# p\n' >"$EVID_RUN/coordinator/preliminary.md"
printf '# d\n' >"$EVID_RUN/challenger/disposition.md"
barrier "$EVID_RUN" lanes | jq -e '.ready == true' >/dev/null || {
  echo "expected a declared API-only floor lane's API receipt to satisfy the barrier" >&2; exit 1; }

# Redispatching F1 preserves the evidence declaration — regenerating a lane's
# generation must not silently strip an exemption a coordinator already made.
scaffold redispatch "$EVID_RUN" F1 | jq -e '.ok == true and .generation == 2' >/dev/null
jq -e '(.lanes[] | select(.id == "F1") | .evidence) == "api"' "$EVID_RUN/completion-contract.json" >/dev/null || {
  echo "expected redispatch to preserve F1's evidence declaration" >&2
  cat "$EVID_RUN/completion-contract.json" >&2; exit 1; }

# Resume the ordinary fixture as its original owner, in case anything is ever
# appended after this block.
gate_owns "$(basename "$FIXTURE_DIR")"

# --- Campaign identity lives in the fenced contract ---------------------------
# The barrier looks a pr campaign's journeys pin up by the contract's
# pr + repoSlug + sourceSha alone, so the scaffold stamps both under the gate
# fence — pr from the fenced state, repoSlug from the gate's lease else
# SMOKE_GATE_REPO normalized as journeys_repo_slug — and never lets them change.
IDENT="$FIXTURE_BASE/run-ident"; mkdir -p "$IDENT"
gate_owns "$(basename "$IDENT")"
scaffold contract "$IDENT" "$SHA" B1:browser | jq -e '.ok == true' >/dev/null
jq -e '.schemaVersion == 2 and .pr == 5 and .repoSlug == "org__repo"' "$IDENT/completion-contract.json" >/dev/null
# Conflicting sources (lease vs env) are refused; neither source is refused.
OUT="$(SMOKE_GATE_REPO=other/fork scaffold contract "$IDENT" "$SHA" B1:browser --regenerate 2>&1 || true)"
jq -e '.ok == false and (.error | test("repo identity conflicts") and test("other__fork"))' <<<"$OUT" >/dev/null || {
  echo "expected a lease/env repo conflict to be refused, got: $OUT" >&2; exit 1; }
jq 'del(.repoSlug)' "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$IDENT").json" > "$SMOKE_GATE_LEASE_DIR/.noslug"
mv "$SMOKE_GATE_LEASE_DIR/.noslug" "$SMOKE_GATE_LEASE_DIR/lease-$(basename "$IDENT").json"
OUT="$(scaffold contract "$IDENT" "$SHA" B1:browser --regenerate 2>&1 || true)"
jq -e '.ok == false and (.error | test("repo identity is unknown") and test("SMOKE_GATE_REPO"))' <<<"$OUT" >/dev/null || {
  echo "expected a contract with no repo identity to be refused, got: $OUT" >&2; exit 1; }
# ...and the environment backfills a lease written before repoSlug existed.
SMOKE_GATE_REPO=org/repo scaffold contract "$IDENT" "$SHA" B1:browser --regenerate | jq -e '.ok == true' >/dev/null
jq -e '.repoSlug == "org__repo" and .pr == 5' "$IDENT/completion-contract.json" >/dev/null
gate_owns "$(basename "$IDENT")"
# Identity never changes: a rewrite or an adoption onto a contract naming
# another repo or PR is refused.
jq '.repoSlug = "other__fork"' "$IDENT/completion-contract.json" > "$IDENT/.c"; mv "$IDENT/.c" "$IDENT/completion-contract.json"
OUT="$(scaffold contract "$IDENT" "$SHA" B1:browser --regenerate 2>&1 || true)"
jq -e '.ok == false and (.error | test("bound to repo other__fork") and test("never changes"))' <<<"$OUT" >/dev/null || {
  echo "expected a regenerate over another repo's contract to be refused, got: $OUT" >&2; exit 1; }
gate_owns "$(basename "$IDENT")" "$SHA" owner-z   # the gate recovered the slot to a successor...
OUT="$(SMOKE_GATE_OWNER=owner-z scaffold adopt "$IDENT" "$SHA" 2>&1 || true)"
jq -e '.ok == false and (.error | test("bound to repo other__fork"))' <<<"$OUT" >/dev/null || {
  echo "expected an adoption onto another repo's contract to be refused, got: $OUT" >&2; exit 1; }
gate_owns "$(basename "$IDENT")"                   # ...and back to the original owner
jq '.repoSlug = "org__repo" | .pr = 6' "$IDENT/completion-contract.json" > "$IDENT/.c"; mv "$IDENT/.c" "$IDENT/completion-contract.json"
OUT="$(scaffold contract "$IDENT" "$SHA" B1:browser --regenerate 2>&1 || true)"
jq -e '.ok == false and (.error | test("bound to PR #6, not #5"))' <<<"$OUT" >/dev/null || {
  echo "expected a regenerate over another PR's contract to be refused, got: $OUT" >&2; exit 1; }
# A contract that predates campaign identity (schemaVersion 1, no pr/repoSlug)
# is backfilled by a fenced adoption — the already-owner retry included — so
# an in-flight run is recovered with its evidence, not regenerated.
jq '.schemaVersion = 1 | del(.pr) | del(.repoSlug)' "$IDENT/completion-contract.json" > "$IDENT/.c"; mv "$IDENT/.c" "$IDENT/completion-contract.json"
scaffold marker "$IDENT" B1 fail 'before identity' | jq -e '.ok == true' >/dev/null
scaffold adopt "$IDENT" "$SHA" | jq -e '.ok == true and .adopted == false and .alreadyOwner == true and .identityBackfilled == true' >/dev/null
jq -e '.schemaVersion == 2 and .pr == 5 and .repoSlug == "org__repo" and ((.ownerAdoptions // []) | length == 0)' "$IDENT/completion-contract.json" >/dev/null
scaffold adopt "$IDENT" "$SHA" | jq -e '.ok == true and .alreadyOwner == true and .identityBackfilled == false' >/dev/null
jq '.schemaVersion = 1 | del(.pr) | del(.repoSlug)' "$IDENT/completion-contract.json" > "$IDENT/.c"; mv "$IDENT/.c" "$IDENT/completion-contract.json"
gate_owns "$(basename "$IDENT")" "$SHA" owner-successor
SMOKE_GATE_OWNER=owner-successor scaffold adopt "$IDENT" "$SHA" |
  jq -e '.ok == true and .adopted == true and .identityBackfilled == true and .adoptionCount == 1' >/dev/null
jq -e '.schemaVersion == 2 and .pr == 5 and .repoSlug == "org__repo" and .coordinatorOwnerToken == "owner-successor"' "$IDENT/completion-contract.json" >/dev/null
jq -e '.status == "fail"' "$IDENT/markers/B1.json" >/dev/null   # the evidence survived
SMOKE_GATE_OWNER=owner-successor barrier "$IDENT" lanes | jq -e '.ready == true' >/dev/null
gate_owns "$(basename "$FIXTURE_DIR")"

echo "smoke run scaffold tests passed"
