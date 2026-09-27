#!/usr/bin/env python3
"""Detect a repository's stack and propose the private smoke-test config it needs.

    smoke-init.py detect  <repo-dir>
    smoke-init.py propose <repo-dir> [--group-dir <dir>]

`detect` prints one JSON object: frameworks, preview hosts, auth, database,
monorepo service dirs and migration dirs, each with the file that showed it.
It reads manifests only (never source files, never a symlink). `propose` turns
that into MANDATORY keys (without them the gates refuse to run) and RECOMMENDED
keys (they make campaigns sharper), each with why it matters and how to find
its value.

`--group-dir` also writes `smoke-gate-env.draft.sh` there: every proposed key
commented out, a value filled in only where the repo settles it (the GitHub
slug, and the provider when exactly one preview host is found). Prefixes and
service ids are the operator's: the draft lists what it saw, never picks. It
refuses to overwrite a file, to write inside a checkout of this skill, and to
write at all when any proposed value looks like a credential. Review the draft, move the keys you keep into the
install's `smoke-gate-env.sh`, then run each gate wrapper with `config`: it names any key the gate
would still refuse on.
"""
import argparse
import json
import os
import re
import subprocess
import sys

JS_FRAMEWORKS = [
    ("next", "Next.js"), ("@remix-run/react", "Remix"), ("astro", "Astro"),
    ("nuxt", "Nuxt"), ("@sveltejs/kit", "SvelteKit"), ("@angular/core", "Angular"),
    ("expo", "Expo"), ("react-native", "React Native"), ("vite", "Vite"),
    ("react", "React"), ("vue", "Vue"), ("svelte", "Svelte"),
    ("express", "Express"), ("fastify", "Fastify"), ("@nestjs/core", "NestJS"), ("hono", "Hono"),
]
PY_FRAMEWORKS = [("django", "Django"), ("fastapi", "FastAPI"), ("flask", "Flask")]
AUTH = [
    ("@supabase/supabase-js", "Supabase Auth"), ("@clerk/", "Clerk"), ("next-auth", "Auth.js"),
    ("@auth/", "Auth.js"), ("auth0", "Auth0"), ("firebase", "Firebase Auth"),
    ("@aws-amplify/", "Amplify/Cognito"),
]
HOST_FILES = [
    ("render.yaml", "render"), ("vercel.json", "vercel"), (".vercel/project.json", "vercel"),
    ("netlify.toml", "netlify"), ("fly.toml", "fly"), ("railway.json", "railway"),
    ("railway.toml", "railway"), ("wrangler.toml", "cloudflare"), ("wrangler.json", "cloudflare"),
    ("wrangler.jsonc", "cloudflare"), ("amplify.yml", "amplify"), ("app.yaml", "app-engine"),
    ("eas.json", "expo-eas"), ("Procfile", "procfile"),
]
# Hosts the gate has a preview adapter for: the provider, and a static host's per-PR URL shape.
PREVIEW_SUPPORT = {
    "render": ("render", None),
    "netlify": ("static", "https://deploy-preview-{pr}--<site>.netlify.app"),
    "cloudflare": ("static", "https://{branch}.<project>.pages.dev"),
}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "__pycache__", "vendor", "target"}
# The gates' layout-prefix grammar (LAYOUT_PREFIX_RE in smoke-gate-layout.sh). A directory
# name outside it is never recorded: it could not be a prefix, and it lands in a shell draft.
DIR_RE = re.compile(r"(?:[A-Za-z0-9_][A-Za-z0-9._-]*/)+")
UNSAFE_DRAFT_RE = re.compile(r"[\x00-\x1f\x7f]")
SECRET_RE = re.compile(r"(?i)(secret|token|password|passwd|api[_-]?key|private[_-]?key)|^(sk|pk|ghp|gho|xox[abp])[-_]|[A-Za-z0-9+/]{32,}")


def read(path):
    try:
        with open(path, encoding="utf8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError):
        return None


def walk(root):
    """(relative dir, file names) for the whole repo tree, without vendored dirs."""
    for dirpath, dirs, files in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".") or d in (".vercel", ".github")]
        yield ("" if rel == "." else rel), files


def add_dir(bucket, rel):
    if DIR_RE.fullmatch(rel + "/"):
        bucket.append(rel + "/")


def hit(bucket, name, where):
    bucket.setdefault(name, [])
    if where not in bucket[name]:
        bucket[name].append(where)


def detect(root):
    found = {"frameworks": {}, "previewHosts": {}, "auth": {}, "databases": {}, "serviceDirs": [],
             "migrationDirs": [], "githubRepo": None, "ci": []}
    for rel, files in walk(root):
        parts = rel.split(os.sep) if rel else []
        if parts[-1:] == ["migrations"] or parts[-2:] in (["db", "migrate"], ["alembic", "versions"]):
            add_dir(found["migrationDirs"], rel)
        for f in files:
            path = os.path.join(rel, f) if rel else f
            full = os.path.join(root, path)
            # A symlink can point outside the repo, at a credential file.
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            if f == "package.json":
                pkg = read(full)
                try:
                    data = json.loads(pkg) if pkg else {}
                except ValueError:
                    data = {}
                deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
                for dep, label in JS_FRAMEWORKS:
                    if dep in deps:
                        hit(found["frameworks"], label, path)
                for prefix, label in AUTH:
                    if any(d == prefix or d.startswith(prefix) for d in deps):
                        hit(found["auth"], label, path)
                if any(d in deps for d in ("pg", "postgres", "@prisma/client", "drizzle-orm", "knex")):
                    hit(found["databases"], "Postgres (likely)", path)
                if rel and any(k in deps for k, _ in JS_FRAMEWORKS):
                    add_dir(found["serviceDirs"], rel)
            elif f in ("requirements.txt", "pyproject.toml", "Pipfile"):
                text = (read(full) or "").lower()
                for mod, label in PY_FRAMEWORKS:
                    if re.search(r"(^|[^a-z])" + mod + r"([^a-z]|$)", text):
                        hit(found["frameworks"], label, path)
                        if rel:
                            add_dir(found["serviceDirs"], rel)
            elif f == "Gemfile" and re.search(r"gem ['\"]rails['\"]", read(full) or ""):
                hit(found["frameworks"], "Rails", path)
                if rel:
                    add_dir(found["serviceDirs"], rel)
            elif f == "go.mod":
                hit(found["frameworks"], "Go", path)
                if rel:
                    add_dir(found["serviceDirs"], rel)
            if path == "supabase/config.toml":
                hit(found["databases"], "Supabase (local stack)", path)
            if f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
                hit(found["previewHosts"], "docker-compose (local)", path)
            for name, host in HOST_FILES:
                if path == name or (rel and path.endswith("/" + name) and name.count("/") == 0):
                    hit(found["previewHosts"], host, path)
            if rel.startswith(".github/workflows") and f.endswith((".yml", ".yaml")):
                found["ci"].append(path)
    found["serviceDirs"] = sorted(set(found["serviceDirs"]))
    found["migrationDirs"].sort()
    try:
        url = subprocess.run(["git", "-C", root, "remote", "get-url", "origin"], capture_output=True,
                             text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        url = ""
    m = re.match(r"^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9._-]+/[A-Za-z0-9._-]+?)(?:\.git)?$", url)
    found["githubRepo"] = m.group(1) if m else None
    return found


def candidates(dirs, words):
    return [d for d in dirs if d.rstrip("/").split("/")[-1].lower() in words]


def seen(text, dirs):
    return text + (" (seen in this repo: " + ", ".join(dirs) + ")" if dirs else "")


def propose(found):
    hosts = [h for h in found["previewHosts"] if h in dict(HOST_FILES).values()]
    supported = sorted({h for h in hosts if h in PREVIEW_SUPPORT})
    provider, template = PREVIEW_SUPPORT[supported[0]] if len(supported) == 1 else (None, None)
    dirs = found["serviceDirs"]
    if provider == "render":
        service_find = "the base Render service id from the dashboard"
    elif provider == "static":
        service_find = "the host's per-PR preview URL with the real names filled in, e.g. " + template
    else:
        service_find = "a base Render service id (render) or the host's per-PR preview URL template (static)"
    # The prefixes decide what the gates check and refuse, and a wrong one passes `config`
    # while silently weakening a gate, so they are listed as seen, never filled in.
    mandatory = [
        {"key": "SMOKE_GATE_REPO", "value": found["githubRepo"],
         "why": "the GitHub repo whose labeled PRs the gate watches; every gate reads it through gh",
         "find": "owner/repo from `git remote get-url origin`"},
        {"key": "SMOKE_PREVIEW_PROVIDER", "value": provider,
         "why": "where each PR's preview comes from",
         "find": "render if previews are Render preview environments, else static with URL templates"},
        {"key": "SMOKE_GATE_FRONTEND_SERVICE", "value": None,
         "why": "the frontend preview: a base Render service id (render) or a URL template with {pr}/{branch} (static)",
         "find": service_find},
        {"key": "SMOKE_GATE_BACKEND_SERVICE", "value": None,
         "why": "the backend preview, same form as the frontend one; the gate probes its health path",
         "find": "as above, for the API service"},
        {"key": "SMOKE_GATE_FRONTEND_PREFIX", "value": None,
         "why": "a diff under it requires the frontend preview to match the head; ends in /, and differs from the other two prefixes",
         "find": seen("the frontend app's directory", candidates(dirs, {"web", "frontend", "client", "app", "ui", "site"}))},
        {"key": "SMOKE_GATE_BACKEND_PREFIX", "value": None,
         "why": "the backend's directory; freeze markers live under it; ends in /",
         "find": seen("the API app's directory", candidates(dirs, {"api", "backend", "server", "service"}))},
        {"key": "SMOKE_GATE_MIGRATIONS_PREFIX", "value": None,
         "why": "an ordinary PR touching it is refused (migrations never run against shared dev); ends in /",
         "find": seen("the directory holding schema migrations", found["migrationDirs"])},
    ]
    if provider != "static":
        mandatory.append(
            {"key": "SMOKE_GATE_DEV_URL", "value": None,
             "why": "Render installs: the shared dev environment the develop gate smoke-tests; that gate refuses without it",
             "find": "the dev environment's public URL"})
    recommended = [
        {"key": "SMOKE_GATE_HEALTH_PATH", "value": None,
         "why": "the backend readiness probe; default /healthz",
         "find": "the route the backend answers 200 on only once it can serve traffic"},
        {"key": "SMOKE_GATE_LABEL", "value": None,
         "why": "the PR label that opts a PR into smoke campaigns; default render-preview",
         "find": "the label your preview host or team already uses"},
        {"key": "SMOKE_GATE_RUN_PREFIX", "value": None,
         "why": "names run ids; never change it once campaigns exist (dedup keys hash it)",
         "find": "a short install slug"},
        {"key": "SMOKE_GATE_PREFLIGHT_CMD", "value": None,
         "why": "checks test accounts and fixtures before a campaign is claimed",
         "find": "a script that logs in each QA seat" + (" (" + ", ".join(found["auth"]) + ")" if found["auth"] else "")},
        {"key": "SMOKE_JOURNEYS_CATALOGUE", "value": None,
         "why": "maps changed paths to the user journeys a campaign must drive",
         "find": "start from references/journeys.example.json with the product's key flows"},
        {"key": "SMOKE_PREVIEW_VERSION_PATH", "value": "/version" if provider == "static" else None,
         "why": "static provider only: where each preview reports the 40-character commit it serves",
         "find": "add a /version route returning {\"sha\": \"<commit>\"} or a <meta name=\"build-sha\"> tag"},
    ]
    gaps = []
    for h in hosts:
        if h not in PREVIEW_SUPPORT:
            gaps.append("{}: no preview adapter; use SMOKE_PREVIEW_PROVIDER=static if it gives each PR a "
                        "predictable URL, or open an adapter request".format(h))
    if len(supported) > 1:
        gaps.append("several preview hosts ({}): set SMOKE_PREVIEW_PROVIDER for the one that builds PR "
                    "previews".format(", ".join(supported)))
    elif not supported:
        gaps.append("no preview host with an adapter found: set SMOKE_PREVIEW_PROVIDER yourself")
    if "Expo" in found["frameworks"] or "React Native" in found["frameworks"]:
        gaps.append("native app: campaigns drive web previews only; native changes need a manual test packet")
    if not found["githubRepo"]:
        gaps.append("no GitHub origin found: every gate reads PRs, CI and trees through gh")
    if provider == "static":
        gaps.append("static provider: the develop gate and freeze helper are Render-only (PR-scoped campaigns only)")
    return {"detected": found, "mandatory": mandatory, "recommended": recommended, "gaps": gaps}


def refuse(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(2)


def write_draft(group_dir, plan):
    skill_dir = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    target_dir = os.path.realpath(group_dir)
    if target_dir == skill_dir or target_dir.startswith(skill_dir + os.sep) or target_dir.startswith("/app/skills"):
        refuse("--group-dir is inside the skill; drafts go only to the install's private group directory")
    if not os.path.isdir(target_dir):
        refuse("--group-dir does not exist")
    out = os.path.join(target_dir, "smoke-gate-env.draft.sh")
    if os.path.exists(out):
        refuse("{} already exists; move it aside first".format(out))
    lines = ["# Draft from smoke-init.py propose. Review each line, then move the keys you",
             "# keep into smoke-gate-env.sh. Credentials never go here: the gateway injects them.",
             "# Then run each gate wrapper with `config` to confirm the gate accepts them.", ""]
    for e in plan["mandatory"] + plan["recommended"]:
        if e["value"] is not None and SECRET_RE.search(str(e["value"])):
            refuse("the proposed {} looks like a credential; no draft written".format(e["key"]))
    for section, entries in (("MANDATORY", plan["mandatory"]), ("RECOMMENDED", plan["recommended"])):
        lines.append("# --- {} ---".format(section))
        for e in entries:
            value = e["value"]
            lines.append("# {}".format(e["why"]))
            lines.append("# export {}={}".format(e["key"], "'" + value + "'" if value else "  # " + e["find"]))
        lines.append("")
    if any(UNSAFE_DRAFT_RE.search(line) for line in lines) or any(
            "'" in str(e["value"]) for e in plan["mandatory"] + plan["recommended"] if e["value"] is not None):
        refuse("a proposed line is not safe to write into a shell file; no draft written")
    with open(out, "x", encoding="utf8") as fh:
        fh.write("\n".join(lines))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detect")
    d.add_argument("repo")
    p = sub.add_parser("propose")
    p.add_argument("repo")
    p.add_argument("--group-dir")
    args = ap.parse_args()
    if not os.path.isdir(args.repo):
        refuse("repo directory not found")
    found = detect(args.repo)
    if args.cmd == "detect":
        print(json.dumps({"ok": True, **found}, indent=2))
        return
    plan = propose(found)
    plan["next"] = "run each gate wrapper with `config` once the keys are in smoke-gate-env.sh"
    if args.group_dir:
        plan["draft"] = write_draft(args.group_dir, plan)
    print(json.dumps({"ok": True, **plan}, indent=2))


if __name__ == "__main__":
    main()
