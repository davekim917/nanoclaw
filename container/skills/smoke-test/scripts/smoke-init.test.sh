#!/usr/bin/env bash
# smoke-init.py: stack detection and the proposed private config, over
# fictional repos, one per stack shape. No network; git only for a local origin.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT="$SCRIPT_DIR/smoke-init.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export PYTHONDONTWRITEBYTECODE=1
FAILED=0
ok() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=1; }
check() { # <label> <json> <jq predicate>
  if jq -e "$3" <<<"$2" >/dev/null 2>&1; then ok "$1"; else fail "$1: $2"; fi
}
mkrepo() { mkdir -p "$T/$1" && git -C "$T/$1" init -q && git -C "$T/$1" remote add origin "$2"; }

# --- 1. Netlify + Next.js frontend, FastAPI backend with a health route -----
mkrepo netlify https://github.com/acme/widget.git
mkdir -p "$T/netlify/web" "$T/netlify/api/migrations"
echo '{"dependencies":{"next":"15.0.0","react":"19.0.0","@supabase/supabase-js":"2.0.0"}}' >"$T/netlify/web/package.json"
printf 'fastapi==0.115\nuvicorn\n' >"$T/netlify/api/requirements.txt"
printf '@app.get("/healthz")\ndef health(): return {}\n' >"$T/netlify/api/main.py"
printf '[build]\ncommand = "npm run build"\n' >"$T/netlify/netlify.toml"
OUT="$(python3 "$INIT" propose "$T/netlify")"
check "frameworks and auth detected" "$OUT" '.detected.frameworks | has("Next.js") and has("FastAPI")'
check "auth provider detected" "$OUT" '.detected.auth | has("Supabase Auth")'
check "repo slug from origin" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_REPO") | .value) == "acme/widget"'
check "netlify maps to the static provider" "$OUT" '(.mandatory[] | select(.key == "SMOKE_PREVIEW_PROVIDER") | .value) == "static"'
check "netlify deploy-preview template" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_FRONTEND_SERVICE") | .value) == "https://deploy-preview-{pr}--<site>.netlify.app"'
check "service dir prefixes" "$OUT" '([.mandatory[] | select(.key == "SMOKE_GATE_FRONTEND_PREFIX" or .key == "SMOKE_GATE_BACKEND_PREFIX" or .key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value]) == ["web/","api/","api/migrations/"]'
check "health route found" "$OUT" '(.recommended[] | select(.key == "SMOKE_GATE_HEALTH_PATH") | .value) == "/healthz"'
# The proposed prefixes pass the gates' own layout validator.
PROBLEMS="$(env $(jq -r '.mandatory[] | select(.key | endswith("_PREFIX")) | "\(.key)=\(.value)"' <<<"$OUT") \
  bash -c '. "$1"; layout_prefix_problems' _ "$SCRIPT_DIR/smoke-gate-layout.sh")"
[ -z "$PROBLEMS" ] && ok "proposed prefixes pass smoke-gate-layout.sh" || fail "proposed prefixes refused by the gate:$PROBLEMS"
check "the next step is the gates' config check" "$OUT" '.next | test("config")'
check "every entry says why and how to find it" "$OUT" '[.mandatory[], .recommended[] | (.why | length > 0) and (.find | length > 0)] | all'

# --- 2. Render: the render provider, no template ---------------------------
mkrepo render git@github.com:acme/gizmo.git
mkdir -p "$T/render/backend"
printf 'services:\n  - type: web\n' >"$T/render/render.yaml"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/render/backend/package.json"
OUT="$(python3 "$INIT" propose "$T/render")"
check "render maps to the render provider" "$OUT" '(.mandatory[] | select(.key == "SMOKE_PREVIEW_PROVIDER") | .value) == "render"'
check "scp-style origin parsed" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_REPO") | .value) == "acme/gizmo"'
check "backend prefix from dir name" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_BACKEND_PREFIX") | .value) == "backend/"'
check "no migration dir: no guessed prefix" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value) == null'
check "no migration dir named as a gap" "$OUT" '.gaps | any(startswith("no migration directory"))'
check "render: the develop gate's dev URL is mandatory" "$OUT" '[.mandatory[] | .key] | index("SMOKE_GATE_DEV_URL") != null'

# --- 3. Cloudflare Pages + Vite: {branch} alias template -------------------
mkrepo pages https://github.com/acme/site
echo '{"devDependencies":{"vite":"6.0.0"},"dependencies":{"react":"19.0.0"}}' >"$T/pages/package.json"
printf 'name = "site"\npages_build_output_dir = "dist"\n' >"$T/pages/wrangler.toml"
OUT="$(python3 "$INIT" propose "$T/pages")"
check "cloudflare branch-alias template" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_FRONTEND_SERVICE") | .value) == "https://{branch}.<project>.pages.dev"'
check "static needs a version route" "$OUT" '(.recommended[] | select(.key == "SMOKE_PREVIEW_VERSION_PATH") | .value) == "/version"'
check "static: no develop-gate dev URL proposed" "$OUT" '[.mandatory[], .recommended[] | .key] | index("SMOKE_GATE_DEV_URL") == null'

# --- 4. Hosts without an adapter, native apps, no GitHub origin -----------
mkdir -p "$T/fly"
echo '{"dependencies":{"expo":"52.0.0","react-native":"0.76.0"}}' >"$T/fly/package.json"
printf 'app = "x"\n' >"$T/fly/fly.toml"
OUT="$(python3 "$INIT" propose "$T/fly")"
check "unsupported host named as a gap" "$OUT" '.gaps | any(startswith("fly: no preview adapter"))'
check "native app named as a gap" "$OUT" '.gaps | any(startswith("native app"))'
check "missing GitHub origin named as a gap" "$OUT" '.gaps | any(startswith("no GitHub origin"))'
check "detect alone lists hosts" "$(python3 "$INIT" detect "$T/fly")" '.previewHosts | has("fly")'

# --- 4b. Migration dirs come from the tree; Go and Rails dirs are services ----
mkrepo prisma https://github.com/acme/ledger
mkdir -p "$T/prisma/api/prisma/migrations"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/prisma/api/package.json"
OUT="$(python3 "$INIT" propose "$T/prisma")"
check "prisma migrations dir, not a guessed api/migrations/" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value) == "api/prisma/migrations/"'
mkrepo rails https://github.com/acme/shop
mkdir -p "$T/rails/web" "$T/rails/server/db/migrate" "$T/rails/api"
echo '{"dependencies":{"next":"15.0.0"}}' >"$T/rails/web/package.json"
printf "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n" >"$T/rails/server/Gemfile"
printf 'module example.test/api\n' >"$T/rails/api/go.mod"
OUT="$(python3 "$INIT" propose "$T/rails")"
check "go and rails dirs recorded as services" "$OUT" '.detected.serviceDirs == ["api/","server/","web/"]'
check "rails db/migrate is the migrations prefix" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value) == "server/db/migrate/"'
PROBLEMS="$(env $(jq -r '.mandatory[] | select(.key | endswith("_PREFIX")) | "\(.key)=\(.value)"' <<<"$OUT") \
  bash -c '. "$1"; layout_prefix_problems' _ "$SCRIPT_DIR/smoke-gate-layout.sh")"
[ -z "$PROBLEMS" ] && ok "go/rails prefixes pass smoke-gate-layout.sh" || fail "go/rails prefixes refused by the gate:$PROBLEMS"
mkrepo twomig https://github.com/acme/depot
mkdir -p "$T/twomig/api/migrations" "$T/twomig/data/migrations"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/twomig/api/package.json"
OUT="$(python3 "$INIT" propose "$T/twomig")"
check "two migration dirs: no prefix chosen" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value) == null'
check "two migration dirs named as a gap" "$OUT" '.gaps | any(startswith("several migration directories (api/migrations/, data/migrations/)"))'

# --- 5. The draft: private dir only, never overwritten, never inside the skill
mkdir -p "$T/group"
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$T/group")"
check "draft path reported" "$OUT" '.draft | endswith("/smoke-gate-env.draft.sh")'
if grep -q "^# export SMOKE_GATE_REPO='acme/widget'$" "$T/group/smoke-gate-env.draft.sh"; then ok "draft carries the known values, commented out"; else fail "draft content"; fi
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$T/group")"; RC=$?
[ "$RC" -eq 2 ] && check "an existing draft is never overwritten" "$OUT" '.ok == false and (.error | contains("already exists"))' || fail "overwrite: rc=$RC $OUT"
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$SCRIPT_DIR")"; RC=$?
[ "$RC" -eq 2 ] && check "a draft inside the skill is refused" "$OUT" '.ok == false and (.error | contains("inside the skill"))' || fail "skill dir: rc=$RC $OUT"
[ ! -e "$SCRIPT_DIR/smoke-gate-env.draft.sh" ] && ok "nothing written into the skill" || fail "draft written into the skill"
mkrepo tokenish https://github.com/acme/abcdefghijklmnopqrstuvwxyzABCDEFGH12
mkdir -p "$T/group2"
OUT="$(python3 "$INIT" propose "$T/tokenish" --group-dir "$T/group2")"; RC=$?
[ "$RC" -eq 2 ] && check "a credential-shaped value stops the draft" "$OUT" '.ok == false and (.error | contains("looks like a credential"))' || fail "credential: rc=$RC $OUT"
[ ! -e "$T/group2/smoke-gate-env.draft.sh" ] && ok "no draft written beside a credential-shaped value" || fail "draft written with a credential-shaped value"

# A directory name outside the gates' prefix grammar never reaches the draft:
# a newline in it would end the comment and leave a live shell command.
mkrepo evil https://github.com/acme/evil
EVIL_DIR="$T/evil/payload"$'\n'"touch PWN #"
mkdir -p "$EVIL_DIR/web" "$T/evil/api" "$T/group3"
echo '{"dependencies":{"next":"15.0.0"}}' >"$EVIL_DIR/web/package.json"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/evil/api/package.json"
OUT="$(python3 "$INIT" propose "$T/evil" --group-dir "$T/group3")"
check "a directory name outside the prefix grammar is not recorded" "$OUT" '.detected.serviceDirs == ["api/"]'
if [ -f "$T/group3/smoke-gate-env.draft.sh" ] && ! grep -qv '^\(#.*\)\?$' "$T/group3/smoke-gate-env.draft.sh"; then
  ok "every draft line is a comment"
else
  fail "draft has a live line: $(grep -v '^\(#.*\)\?$' "$T/group3/smoke-gate-env.draft.sh" 2>&1)"
fi

[ "$FAILED" -eq 0 ] && echo "PASS smoke-init.test.sh" || { echo "FAIL smoke-init.test.sh"; exit 1; }
