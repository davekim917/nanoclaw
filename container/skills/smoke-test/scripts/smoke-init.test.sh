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
E='def e(k): [.mandatory[], .recommended[] | select(.key == k)][0];'
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
check "netlify template is a hint, never a value" "$OUT" '.mandatory[] | select(.key == "SMOKE_GATE_FRONTEND_SERVICE") | .value == null and (.find | contains("https://deploy-preview-{pr}--<site>.netlify.app"))'
check "prefixes are never filled in" "$OUT" "$E"' [e("SMOKE_GATE_FRONTEND_PREFIX"), e("SMOKE_GATE_BACKEND_PREFIX"), e("SMOKE_GATE_MIGRATIONS_PREFIX")] | map(.value) == [null, null, null]'
check "the dirs seen are listed for each prefix" "$OUT" "$E"' (e("SMOKE_GATE_FRONTEND_PREFIX").find | contains("web/")) and (e("SMOKE_GATE_BACKEND_PREFIX").find | contains("api/")) and (e("SMOKE_GATE_MIGRATIONS_PREFIX").find | contains("api/migrations/"))'
check "the health path is never filled in" "$OUT" "$E"' e("SMOKE_GATE_HEALTH_PATH").value == null'
check "the next step is the gates' config check" "$OUT" '.next | test("config")'
check "every entry says why and how to find it" "$OUT" '[.mandatory[], .recommended[] | (.why | length > 0) and (.find | length > 0)] | all'
check "every mandatory key is proposed" "$OUT" '[.mandatory[].key] == ["SMOKE_GATE_REPO","SMOKE_PREVIEW_PROVIDER","SMOKE_GATE_FRONTEND_SERVICE","SMOKE_GATE_BACKEND_SERVICE","SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX","SMOKE_GATE_MIGRATIONS_PREFIX"]'
check "static: only the repo and provider are filled in" "$OUT" '[.mandatory[] | select(.value != null) | .key] == ["SMOKE_GATE_REPO","SMOKE_PREVIEW_PROVIDER"]'
OPENED="$(python3 - "$INIT" "$T/netlify" <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("smoke_init", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
root, opened = os.path.realpath(sys.argv[2]), []
def hook(event, args):
    if event == "open" and isinstance(args[0], (str, bytes)):
        p = os.path.realpath(os.fsdecode(args[0]))
        if p.startswith(root + os.sep):
            opened.append(os.path.relpath(p, root))
sys.addaudithook(hook)
mod.detect(sys.argv[2])
print(json.dumps(sorted(opened)))
PY
)"
check "detect opens the manifests and nothing else (no source, no host file)" "$OPENED" '. == ["api/requirements.txt","web/package.json"]'

# --- 2. Render: the render provider, no template ---------------------------
mkrepo render git@github.com:acme/gizmo.git
mkdir -p "$T/render/backend"
printf 'services:\n  - type: web\n' >"$T/render/render.yaml"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/render/backend/package.json"
OUT="$(python3 "$INIT" propose "$T/render")"
check "render maps to the render provider" "$OUT" '(.mandatory[] | select(.key == "SMOKE_PREVIEW_PROVIDER") | .value) == "render"'
check "scp-style origin parsed" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_REPO") | .value) == "acme/gizmo"'
check "backend dir listed from its name" "$OUT" "$E"' e("SMOKE_GATE_BACKEND_PREFIX").find | contains("backend/")'
check "no migration dir: no guessed prefix" "$OUT" '(.mandatory[] | select(.key == "SMOKE_GATE_MIGRATIONS_PREFIX") | .value) == null'
check "render: the develop gate's dev URL is mandatory" "$OUT" '[.mandatory[] | .key] | index("SMOKE_GATE_DEV_URL") != null'
check "render: only the repo and provider are filled in, not the backend service" "$OUT" '[.mandatory[] | select(.value != null) | .key] == ["SMOKE_GATE_REPO","SMOKE_PREVIEW_PROVIDER"] and ([.mandatory[].key] | index("SMOKE_GATE_BACKEND_SERVICE") != null)'

# --- 3. Cloudflare Pages + Vite: {branch} alias template -------------------
mkrepo pages https://github.com/acme/site
echo '{"devDependencies":{"vite":"6.0.0"},"dependencies":{"react":"19.0.0"}}' >"$T/pages/package.json"
printf 'name = "site"\npages_build_output_dir = "dist"\n' >"$T/pages/wrangler.toml"
OUT="$(python3 "$INIT" propose "$T/pages")"
check "cloudflare branch-alias template is a hint, never a value" "$OUT" '.mandatory[] | select(.key == "SMOKE_GATE_FRONTEND_SERVICE") | .value == null and (.find | contains("https://{branch}.<project>.pages.dev"))'
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
check "no supported host: the provider is left to the operator" "$OUT" "$E"' e("SMOKE_PREVIEW_PROVIDER").value == null'
check "no supported host named as a gap" "$OUT" '.gaps | any(startswith("no preview host with an adapter"))'
mkrepo twohost https://github.com/acme/twin
printf 'services: []\n' >"$T/twohost/render.yaml"
printf '[build]\n' >"$T/twohost/netlify.toml"
OUT="$(python3 "$INIT" propose "$T/twohost")"
check "two supported hosts: no provider picked" "$OUT" "$E"' e("SMOKE_PREVIEW_PROVIDER").value == null'
check "two supported hosts named as a gap" "$OUT" '.gaps | any(startswith("several preview hosts (netlify, render)"))'

# --- 4b. Migration dirs come from the tree; Go and Rails dirs are services ----
mkrepo prisma https://github.com/acme/ledger
mkdir -p "$T/prisma/api/prisma/migrations"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/prisma/api/package.json"
OUT="$(python3 "$INIT" propose "$T/prisma")"
check "prisma migrations dir listed, nothing guessed" "$OUT" "$E"' e("SMOKE_GATE_MIGRATIONS_PREFIX") | .value == null and (.find | contains("api/prisma/migrations/")) and (.find | contains("api/migrations/, ") | not)'
mkrepo rails https://github.com/acme/shop
mkdir -p "$T/rails/web" "$T/rails/server/db/migrate" "$T/rails/worker"
echo '{"dependencies":{"next":"15.0.0"}}' >"$T/rails/web/package.json"
printf "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n" >"$T/rails/server/Gemfile"
printf 'module example.test/worker\n' >"$T/rails/worker/go.mod"
OUT="$(python3 "$INIT" propose "$T/rails")"
check "go and rails dirs recorded as services" "$OUT" '.detected.serviceDirs == ["server/","web/","worker/"]'
check "rails db/migrate listed" "$OUT" "$E"' e("SMOKE_GATE_MIGRATIONS_PREFIX").find | contains("server/db/migrate/")'
mkrepo twomig https://github.com/acme/depot
mkdir -p "$T/twomig/api/migrations" "$T/twomig/data/migrations"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/twomig/api/package.json"
OUT="$(python3 "$INIT" propose "$T/twomig")"
check "two migration dirs both listed" "$OUT" "$E"' e("SMOKE_GATE_MIGRATIONS_PREFIX") | .value == null and (.find | contains("api/migrations/, data/migrations/"))'

mkrepo twofront https://github.com/acme/suite
mkdir -p "$T/twofront/apps/frontend" "$T/twofront/packages/web" "$T/twofront/api"
echo '{"dependencies":{"next":"15.0.0"}}' >"$T/twofront/apps/frontend/package.json"
echo '{"dependencies":{"react":"19.0.0"}}' >"$T/twofront/packages/web/package.json"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/twofront/api/package.json"
OUT="$(python3 "$INIT" propose "$T/twofront")"
check "two frontend dirs both listed" "$OUT" "$E"' e("SMOKE_GATE_FRONTEND_PREFIX") | .value == null and (.find | contains("apps/frontend/, packages/web/"))'
check "the backend dir listed on its own" "$OUT" "$E"' e("SMOKE_GATE_BACKEND_PREFIX").find | contains("(seen in this repo: api/)")'

mkrepo deepmig https://github.com/acme/vault
mkdir -p "$T/deepmig/apps/api/prisma/migrations" "$T/deepmig/supabase/migrations"
echo '{"dependencies":{"express":"4.0.0"}}' >"$T/deepmig/apps/api/package.json"
OUT="$(python3 "$INIT" propose "$T/deepmig")"
check "a deep migration dir is listed" "$OUT" "$E"' e("SMOKE_GATE_MIGRATIONS_PREFIX").find | contains("apps/api/prisma/migrations/, supabase/migrations/")'

# --- 4c. A symlinked manifest is never read: it can point outside the repo ---
mkrepo linked https://github.com/acme/linked
mkdir -p "$T/outside/web" "$T/linked/web"
echo '{"dependencies":{"next":"15.0.0"}}' >"$T/outside/web/package.json"
ln -s "$T/outside/web/package.json" "$T/linked/web/package.json"
OUT="$(python3 "$INIT" detect "$T/linked")"
check "a symlinked manifest is not read" "$OUT" '.frameworks == {} and .serviceDirs == []'
mkrepo dirlink https://github.com/acme/dirlink
mkdir -p "$T/outside/migrations"
ln -s "$T/outside" "$T/dirlink/ext"
OUT="$(python3 "$INIT" detect "$T/dirlink")"
check "a symlinked directory is not traversed" "$OUT" '.frameworks == {} and .serviceDirs == [] and .migrationDirs == []'

# --- 5. The draft: private dir only, never overwritten, never inside the skill
mkdir -p "$T/group"
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$T/group")"
check "draft path reported" "$OUT" '.draft | endswith("/smoke-gate-env.draft.sh")'
if grep -q "^# export SMOKE_GATE_REPO='acme/widget'$" "$T/group/smoke-gate-env.draft.sh"; then ok "draft carries the known values, commented out"; else fail "draft content"; fi
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$T/group")"; RC=$?
[ "$RC" -eq 2 ] && check "an existing draft is never overwritten" "$OUT" '.ok == false and (.error | contains("already exists"))' || fail "overwrite: rc=$RC $OUT"
mkdir -p "$T/group-dangling"
ln -s "$T/dangling-target" "$T/group-dangling/smoke-gate-env.draft.sh"
OUT="$(python3 "$INIT" propose "$T/netlify" --group-dir "$T/group-dangling")"; RC=$?
[ "$RC" -eq 2 ] && check "a dangling symlink at the draft path is refused" "$OUT" '.ok == false and (.error | contains("already exists"))' || fail "dangling symlink: rc=$RC $OUT"
[ ! -e "$T/dangling-target" ] && ok "nothing written through a dangling symlink" || fail "draft written through a dangling symlink"
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

# The writer's own refusal, reached directly: a control character in a line or
# a quote in a value never reaches the file.
for bad in 'value:a'"'"'b' 'why:a
touch PWN'; do
  G="$T/group4-${bad%%:*}"; mkdir -p "$G"
  OUT="$(python3 - "$INIT" "$G" "${bad%%:*}" "${bad#*:}" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("smoke_init", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
entry = {"key": "SMOKE_GATE_X", "value": "ok", "why": "w", "find": "f"}
entry[sys.argv[3]] = sys.argv[4]
mod.write_draft(sys.argv[2], {"mandatory": [entry], "recommended": []})
PY
)"; RC=$?
  if [ "$RC" -eq 2 ] && [ ! -e "$G/smoke-gate-env.draft.sh" ]; then ok "the writer refuses an unsafe ${bad%%:*}"; else fail "unsafe ${bad%%:*}: rc=$RC $OUT"; fi
done

[ "$FAILED" -eq 0 ] && echo "PASS smoke-init.test.sh" || { echo "FAIL smoke-init.test.sh"; exit 1; }
