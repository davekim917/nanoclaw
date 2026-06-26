#!/bin/bash
# Monthly design-artifact-loop drift check.
#
# Two layers of drift against the upstream we vendored from (nexu-io/open-design):
#
#   1. MECHANICAL (deterministic) — compares our vendored design-system files
#      (DESIGN.md + tokens.css) against upstream by git blob SHA, and detects systems
#      ADDED upstream since our last check. Both map to a concrete "re-vendor" action.
#      Note: the static gap between our curated subset and upstream's full catalog
#      (e.g. "18 of 151") is a deliberate curation choice, NOT drift — it is logged for
#      context but never triggers a notification (otherwise every month would be noise).
#
#   2. TECHNIQUE (LLM judgment) — the author-then-conform *mechanism* is the idea we
#      ported (not the daemon/editor/exports/UI, which are explicit non-goals). A
#      headless `claude -p` pass reviews upstream's CHANGELOG + commit subjects since
#      the last check, with OUR current technique inlined (SKILL.md + linter.ts +
#      state.ts), and judges whether the *technique* evolved in a way we should adopt,
#      revise, or improve. It is told to ignore daemon/UI/packaging/data churn.
#
# Notifies only when something is actionable (like check-onecli-drift.sh): a vendored
# file changed upstream, a brand-new system appeared, or the LLM flags genuine technique
# drift. Otherwise it logs and exits silently. The report is posted to the Discord
# #axie-dev channel — where the operator's other drift checks (codex, upstream-nanoclaw)
# report — via the same CLI-socket inbound transport as scripts/check-onecli-drift.sh.
# Transport detail: a `to`-addressed cli.sock frame becomes an InboundEvent (src/channels/
# cli.ts) that wakes the channel's agent to relay the report; it is not a verbatim post,
# so the injected text instructs relay-only (advisory, do not auto-implement).
#
# Run by systemd timer (scripts/systemd/design-drift-check.timer). Logs to journalctl.
#
# Manual run:    bash scripts/check-design-drift.sh
# Preview only:  bash scripts/check-design-drift.sh --dry-run   (no DM, no state write)

set -uo pipefail   # NOT -e: optional layers degrade gracefully; we check rc explicitly.

NANOCLAW_DIR="/home/ubuntu/nanoclaw-v2"
cd "$NANOCLAW_DIR" || { echo "design-drift: cannot cd to $NANOCLAW_DIR" >&2; exit 1; }

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

UPSTREAM_REPO="nexu-io/open-design"
SKILL_DIR="container/skills/design-artifact-loop"
VENDOR_DIR="$SKILL_DIR/design-systems"
STATE_FILE="data/design-drift-state.json"
CLI_SOCK="$NANOCLAW_DIR/data/cli.sock"
# #axie-dev Discord channel — the Claude axie agent instance. The codex/opencode siblings
# share this channel under different channel_type rows; injecting channelType='discord'
# wakes only the Claude agent, which posts the report to the channel for everyone.
AXIE_DEV_MG_ID="mg-discord-axie-dev"

API="https://api.github.com/repos/$UPSTREAM_REPO"
RAW="https://raw.githubusercontent.com/$UPSTREAM_REPO"

log() { echo "design-drift: $*"; }

# ---------------------------------------------------------------------------
# 0. Resolve upstream default branch (also our reachability probe).
# ---------------------------------------------------------------------------
DEFAULT_BRANCH="$(curl -fsS "$API" 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("default_branch",""))' 2>/dev/null)"
if [ -z "$DEFAULT_BRANCH" ]; then
  log "ERROR: cannot reach $UPSTREAM_REPO (network / rate-limit). Skipping run; state unchanged."
  exit 1
fi
log "upstream default branch: $DEFAULT_BRANCH"

# ---------------------------------------------------------------------------
# 1. MECHANICAL layer — blob-SHA diff of vendored systems + current upstream catalog.
#    Upstream blob SHAs come from one recursive Trees API call; local blob SHAs are
#    computed the same way git does (sha1 of "blob <len>\0<bytes>"), so they match
#    upstream byte-for-byte without shelling `git hash-object` per file.
# ---------------------------------------------------------------------------
TREE_JSON="$(curl -fsS "$API/git/trees/$DEFAULT_BRANCH?recursive=1" 2>/dev/null)"
if [ -z "$TREE_JSON" ]; then
  log "ERROR: could not fetch upstream tree. Skipping run; state unchanged."
  exit 1
fi

# NOTE: pass the tree via a temp file (not a pipe): `python3 - <<'PY'` reads the SCRIPT
# from stdin, so a piped payload would never reach json.load.
TREE_FILE="$(mktemp)"
printf '%s' "$TREE_JSON" > "$TREE_FILE"
MECH_JSON="$(VENDOR_DIR="$VENDOR_DIR" TREE_FILE="$TREE_FILE" python3 - <<'PY'
import json, os, hashlib

vendor_dir = os.environ["VENDOR_DIR"]
tree = json.load(open(os.environ["TREE_FILE"], encoding="utf-8"))
if tree.get("truncated"):
    # Defensive: a truncated tree would under-report. Fail loud rather than lie.
    print(json.dumps({"error": "upstream tree truncated"})); raise SystemExit

up = {e["path"]: e["sha"] for e in tree.get("tree", [])
      if e.get("type") == "blob" and e["path"].startswith("design-systems/")}
up_systems = sorted({p.split("/")[1] for p in up if len(p.split("/")) >= 3})

def blob_sha(path):
    data = open(path, "rb").read()
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()

our_systems = sorted(
    d for d in os.listdir(vendor_dir)
    if os.path.isdir(os.path.join(vendor_dir, d))
)

changed = []
for sysname in our_systems:
    for fn in ("DESIGN.md", "tokens.css"):
        local = os.path.join(vendor_dir, sysname, fn)
        if not os.path.exists(local):
            continue
        key = f"design-systems/{sysname}/{fn}"
        usha = up.get(key)
        if usha is None:
            changed.append(f"{sysname}/{fn} (gone upstream)")
        elif usha != blob_sha(local):
            changed.append(f"{sysname}/{fn}")

print(json.dumps({
    "changed": changed,
    "changed_systems": sorted({c.split('/')[0] for c in changed}),
    "upstream_systems": up_systems,
    "our_count": len(our_systems),
    "upstream_count": len(up_systems),
}))
PY
)"
rm -f "$TREE_FILE"

if [ -z "$MECH_JSON" ] || printf '%s' "$MECH_JSON" | grep -q '"error"'; then
  log "ERROR: mechanical diff failed: ${MECH_JSON:-<empty>}. Skipping run; state unchanged."
  exit 1
fi

CHANGED_SYSTEMS="$(printf '%s' "$MECH_JSON" | python3 -c 'import sys,json;print(", ".join(json.load(sys.stdin)["changed_systems"]))')"
CHANGED_COUNT="$(printf '%s' "$MECH_JSON"   | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["changed_systems"]))')"
OUR_COUNT="$(printf '%s' "$MECH_JSON"       | python3 -c 'import sys,json;print(json.load(sys.stdin)["our_count"])')"
UPSTREAM_COUNT="$(printf '%s' "$MECH_JSON"  | python3 -c 'import sys,json;print(json.load(sys.stdin)["upstream_count"])')"
US_JSON="$(printf '%s' "$MECH_JSON"         | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["upstream_systems"]))')"

# ---------------------------------------------------------------------------
# 2. State — last-check date (scopes the LLM window) + previous upstream catalog
#    snapshot (so we report only NEWLY-added systems, not the static curation gap).
# ---------------------------------------------------------------------------
STATE_JSON="$(cat "$STATE_FILE" 2>/dev/null || true)"

SINCE="$(printf '%s' "$STATE_JSON" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("last_check","") or "")
except Exception: print("")' 2>/dev/null)"
if ! printf '%s' "$SINCE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  SINCE="$(date -u -d '90 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-90d +%Y-%m-%d)"
  log "no valid state; defaulting technique-review window to since $SINCE (baseline run)"
fi

# Newly-added upstream systems = current catalog minus the previous snapshot.
# First run (no prior snapshot) baselines silently — added is empty.
NEWLY_JSON="$(PREV="$STATE_JSON" CUR="$US_JSON" python3 - <<'PY'
import os, json
try:
    prevobj = json.loads(os.environ.get("PREV") or "{}")
except Exception:
    prevobj = {}
have_prev = isinstance(prevobj, dict) and "upstream_systems" in prevobj
prev = set(prevobj.get("upstream_systems", [])) if have_prev else set()
cur = json.loads(os.environ["CUR"])
added = [s for s in cur if s not in prev] if have_prev else []
print(json.dumps(added))
PY
)"
NEW_COUNT="$(printf '%s' "$NEWLY_JSON" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')"
NEW_SYSTEMS="$(printf '%s' "$NEWLY_JSON" | python3 -c 'import sys,json
a=json.load(sys.stdin)
print(", ".join(a[:20]) + (f", +{len(a)-20} more" if len(a)>20 else ""))')"

UNCURATED=$(( UPSTREAM_COUNT - OUR_COUNT ))
log "mechanical: $CHANGED_COUNT of $OUR_COUNT vendored systems changed; $NEW_COUNT newly added upstream; $UNCURATED uncurated (informational, not flagged)"

# ---------------------------------------------------------------------------
# 3. TECHNIQUE layer — LLM review of the changelog + commits since last check.
#    Degrades gracefully: any failure yields drift="unknown" + a note, rather than
#    aborting the mechanical notification.
# ---------------------------------------------------------------------------
CHANGELOG="$(curl -fsS "$RAW/$DEFAULT_BRANCH/CHANGELOG.md" 2>/dev/null || true)"
[ -z "$CHANGELOG" ] && CHANGELOG="(no CHANGELOG.md in upstream)"

COMMITS="$(curl -fsS "$API/commits?since=${SINCE}T00:00:00Z&per_page=100" 2>/dev/null \
  | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print("\n".join("- "+c["commit"]["message"].splitlines()[0] for c in d) if isinstance(d,list) else "(commit fetch error)")
except Exception:
    print("(commit fetch error)")' 2>/dev/null)"
[ -z "$COMMITS" ] && COMMITS="(no commits since $SINCE)"

PROMPT_FILE="$(mktemp)"
trap 'rm -f "$PROMPT_FILE"' EXIT
{
  cat <<'HDR'
You are auditing whether an upstream open-source project's *technique* has evolved in a
way that should change OUR implementation.

BACKGROUND: NanoClaw's `design-artifact-loop` ported ONE idea from the upstream "Open
Design" project — "author-then-conform" (commit a concrete design system before writing
markup) plus render-grounded iteration and an independent vision critic. We deliberately
do NOT track upstream's product/architecture: its daemon/orchestrator, Electron canvas
editor, file exports (PPTX/MP4/PDF), packaging, or UI. Those are explicit non-goals —
ignore changes to them entirely. New/updated vendored design-system DATA is tracked
separately by a mechanical diff — do not flag "new/updated design system" as technique drift.

OUR CURRENT TECHNIQUE (the only thing in scope) follows.

===== SKILL.md =====
HDR
  cat "$SKILL_DIR/SKILL.md" 2>/dev/null || echo "(SKILL.md unreadable)"
  echo
  echo "===== linter.ts (deterministic artifact-contract checks) ====="
  cat container/agent-runner/src/mcp-tools/design-review/linter.ts 2>/dev/null || echo "(linter.ts unreadable)"
  echo
  echo "===== state.ts (round/cap state machine + must-fix carry-forward) ====="
  cat container/agent-runner/src/mcp-tools/design-review/state.ts 2>/dev/null || echo "(state.ts unreadable)"
  echo
  echo "===== UPSTREAM CHANGES since $SINCE ====="
  echo "--- CHANGELOG.md ---"
  printf '%s\n' "$CHANGELOG"
  echo "--- commit subjects ---"
  printf '%s\n' "$COMMITS"
  cat <<'TASK'

TASK: Decide whether upstream evolved the *technique* (the design-quality method: how it
commits a design system, what it checks for to avoid slop, how it critiques/iterates, the
rubric, the cap/carry-forward logic) in a way we should adopt, revise, or improve on our
end. Be skeptical — most changes will be irrelevant (daemon/UI/packaging/data). Only flag
GENUINE technique improvements.

OUTPUT FORMAT (strict):
- First line MUST be exactly "DRIFT: none" or "DRIFT: yes".
- If yes: up to 4 bullets, each a concrete recommendation naming which of our files/checks
  to change and why. ~150 words max total. No preamble, no closing remarks.
- Answer ONLY from the text provided above. Do not use any tools.
TASK
} > "$PROMPT_FILE"

# Resolve claude by absolute path: under systemd (User=ubuntu, non-login shell) the
# default PATH excludes ~/.local/bin, so `command -v claude` alone would fail there.
# Model traffic uses the operator's ~/.claude login directly (not the gateway), so
# $HOME is all the auth context it needs.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[ -z "$CLAUDE_BIN" ] && [ -x /home/ubuntu/.local/bin/claude ] && CLAUDE_BIN=/home/ubuntu/.local/bin/claude
VERDICT=""
if [ -n "$CLAUDE_BIN" ]; then
  VERDICT="$(timeout 420 "$CLAUDE_BIN" -p --output-format text < "$PROMPT_FILE" 2>/dev/null || true)"
fi

if [ -z "$VERDICT" ]; then
  VERDICT_DRIFT="unknown"
  VERDICT_BODY="(technique review unavailable this run — claude headless call failed or absent)"
else
  if printf '%s' "$VERDICT" | head -1 | grep -qi 'DRIFT:[[:space:]]*yes'; then
    VERDICT_DRIFT="yes"
  else
    VERDICT_DRIFT="none"
  fi
  # Body = everything except DRIFT: marker lines and blank lines.
  VERDICT_BODY="$(printf '%s\n' "$VERDICT" | sed '/^[[:space:]]*DRIFT:/d;/^[[:space:]]*$/d')"
  [ -z "$VERDICT_BODY" ] && VERDICT_BODY="(no detail)"
fi
log "technique verdict: drift=$VERDICT_DRIFT"

# ---------------------------------------------------------------------------
# 4. Decide whether to notify. Silent when fully clean.
#    "unknown" technique alone does not spam a DM — the mechanical layer governs then.
# ---------------------------------------------------------------------------
NOTIFY=0
[ "$CHANGED_COUNT" -gt 0 ] && NOTIFY=1
[ "$NEW_COUNT" -gt 0 ] && NOTIFY=1
[ "$VERDICT_DRIFT" = "yes" ] && NOTIFY=1

MECH_LINE_CHANGED="none changed"
[ "$CHANGED_COUNT" -gt 0 ] && MECH_LINE_CHANGED="$CHANGED_COUNT of $OUR_COUNT changed upstream ($CHANGED_SYSTEMS)"
MECH_LINE_NEW="none"
[ "$NEW_COUNT" -gt 0 ] && MECH_LINE_NEW="$NEW_COUNT newly added ($NEW_SYSTEMS)"

NOTIFICATION="System notification (monthly design-loop drift check):
• Vendored systems: $MECH_LINE_CHANGED
• New systems upstream (since last check): $MECH_LINE_NEW
• Technique review (LLM): $VERDICT_DRIFT
$VERDICT_BODY

Re-vendor changed/new systems by copying design-systems/<name>/{DESIGN.md,tokens.css} from github.com/$UPSTREAM_REPO into $SKILL_DIR/design-systems/ and updating index.md + ATTRIBUTION.md. Technique recommendations (if any) are advisory — apply at your discretion. ($OUR_COUNT of $UPSTREAM_COUNT systems vendored.)"

if [ "$NOTIFY" -eq 0 ]; then
  log "no actionable drift (vendored data clean, no new systems, technique drift=$VERDICT_DRIFT). Nothing to notify."
  if [ "$DRY_RUN" -eq 0 ]; then
    SF="$STATE_FILE" TODAY="$(date -u +%Y-%m-%d)" US="$US_JSON" python3 -c 'import os,json;open(os.environ["SF"],"w").write(json.dumps({"last_check":os.environ["TODAY"],"upstream_systems":json.loads(os.environ["US"])}))' 2>/dev/null \
      && log "state updated -> last_check $(date -u +%Y-%m-%d), $UPSTREAM_COUNT systems snapshotted"
  fi
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN — would post the following report to #axie-dev (wrapped in a relay-only directive):"
  printf '%s\n' "$NOTIFICATION" | sed 's/^/    /'
  log "DRY RUN — state file NOT updated."
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Post the report to #axie-dev via the CLI socket. The `to`-addressed frame is an
#    InboundEvent that wakes the channel's Claude agent to relay the report — so we
#    frame it as relay-only (advisory, do not auto-implement) and set isMention so a
#    mention-engage channel still fires.
# ---------------------------------------------------------------------------
CHAN_ROW="$(sqlite3 -separator '|' "$NANOCLAW_DIR/data/v2.db" \
  "SELECT channel_type, platform_id FROM messaging_groups WHERE id='$AXIE_DEV_MG_ID' LIMIT 1;")"
CHAN_TYPE="${CHAN_ROW%%|*}"
CHAN_PID="${CHAN_ROW#*|}"
if [ -z "$CHAN_TYPE" ] || [ "$CHAN_ROW" = "$CHAN_TYPE" ] || [ -z "$CHAN_PID" ]; then
  log "ERROR: cannot resolve #axie-dev channel ($AXIE_DEV_MG_ID missing/malformed). Drift detected but not delivered." >&2
  exit 1
fi

POST_TEXT="📋 Automated monthly design-loop drift check (host job \`scripts/check-design-drift.sh\`). Relay the report below to this channel for operator review, then STOP — these are advisory findings for a human to decide on, NOT a work order. Do not implement any recommendation yourself.

$NOTIFICATION"

log "drift detected; posting to #axie-dev ($CHAN_TYPE / $CHAN_PID) via CLI socket"
POST_TEXT="$POST_TEXT" CHAN_TYPE="$CHAN_TYPE" CHAN_PID="$CHAN_PID" CLI_SOCK="$CLI_SOCK" python3 <<'EOF'
import json, os, socket, time
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["CLI_SOCK"])
payload = json.dumps({
    "text": os.environ["POST_TEXT"],
    "senderId": "system:design-drift-check",
    "sender": "Design Loop Drift Check",
    "isMention": True,
    "to": {"channelType": os.environ["CHAN_TYPE"], "platformId": os.environ["CHAN_PID"], "threadId": None},
}) + "\n"
sock.sendall(payload.encode("utf-8"))
time.sleep(0.5)  # let the router read before close
sock.close()
print("design-drift: report posted to #axie-dev")
EOF

TODAY="$(date -u +%Y-%m-%d)" US="$US_JSON" SF="$STATE_FILE" python3 -c 'import os,json;open(os.environ["SF"],"w").write(json.dumps({"last_check":os.environ["TODAY"],"upstream_systems":json.loads(os.environ["US"])}))' \
  && log "state updated -> last_check $(date -u +%Y-%m-%d), $UPSTREAM_COUNT systems snapshotted"
