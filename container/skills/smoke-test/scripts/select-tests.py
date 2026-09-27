#!/usr/bin/env python3
"""Pick the shell suites a change can break, and optionally run them.

  select-tests.py [--base <ref>] [--all] [--run [-j N] [--shards N]] [--explain] [<changed-path>...]

With no paths, the change is everything that differs from the merge base with
--base (default origin/main): committed, staged, unstaged and untracked.
Prints one repo-relative suite per line (the *.test.sh the skill-shell gate,
container/skill-shell-tests.test.ts, runs), or with --run executes them the
way that gate does and exits non-zero if any fails. A suite that marks its
cases (smoke-case.sh) runs as --shards processes that split its cases between
them, unless SMOKE_CASE picks cases.

A suite is selected when it reaches a changed file through a chain of name
references. A file references another when its code (whole-line comments
dropped: a comment runs nothing) holds that file's basename, or its
extension-less stem as a whole word -- so sourcing, exec or spawn by path,
copies, reads-as-text, python imports and `cite <file> <line>` pins all count,
not only imports. A chain passes on only through non-test code under
container/ or scripts/ (outside container/agent-runner/, which no suite runs):
a suite that runs a checker that sources a helper reaches the helper, while a
doc or a test that names a file does not pass it on. A basename several files
share counts only where the text qualifies it with its parent dir, or where the
referrer sits in the same unit (skill dir, else parent dir).

Nothing is ever skipped silently. The FULL set is printed when:
  - a change touches the gate, which decides how every suite runs;
  - a changed file outside NOT_SHELL_INPUT reaches no suite by name -- a
    suite may still reach it by glob or by a path it builds.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = "container/skill-shell-tests.test.ts"
PY_RUNNER = "container/skills/smoke-test/scripts/smoke-python-suites.test.sh"
PY_SUITE_DIR = "container/skills/smoke-test/scripts/"
SUITE_ROOTS = ("container/", "scripts/")
NOT_RUN_BY_SUITES = ("container/agent-runner/",)
NOT_SHELL_INPUT = ("src/", "docs/", "setup/", "dashboard/")
CODE = (".sh", ".bash", ".py", ".js", ".mjs", ".cjs", ".ts", ".jq")
WORD = r"(?<![A-Za-z0-9_]){}(?![A-Za-z0-9_])"
EXCLUDED_MARK = "relPath: '"
DEFAULT_TIMEOUT_S = 400
SLOW_MARK = ".test.sh': "
CASES_LIB = "smoke-case.sh"


def git(root, *args, check=True):
    r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit("select-tests: git {} failed: {}".format(" ".join(args), r.stderr.strip()))
    return r


def lines(text):
    return [l for l in text.splitlines() if l]


class Repo:
    def __init__(self, root):
        self.root = root
        self.cache = {}
        self.stripped = {}
        self.files = set(lines(git(root, "ls-files").stdout)) | set(
            lines(git(root, "ls-files", "-o", "--exclude-standard").stdout))
        self.by_token = {}
        for f in self.files:
            for tok, _ in tokens(f):
                self.by_token.setdefault(tok, set()).add(f)
        self.by_unit = {}
        for f in self.files:
            self.by_unit.setdefault(unit(f), []).append(f)
        self.links = []
        for row in lines(git(root, "ls-files", "-s").stdout):
            meta, path = row.split("\t", 1)
            if meta.startswith("120000 "):
                target = os.path.normpath(os.path.join(os.path.dirname(path), os.readlink(os.path.join(root, path))))
                self.links.append((path, target))
        gate_text = self.read(GATE)
        self.excluded = set()
        self.budgets = {}
        for l in gate_text.splitlines():
            if EXCLUDED_MARK in l:
                self.excluded.add(l.split(EXCLUDED_MARK, 1)[1].split("'", 1)[0])
            elif SLOW_MARK in l:
                rel, ms = l.strip().split("': ")
                self.budgets[rel.strip("'")] = int(ms.rstrip(",").replace("_", "")) // 1000
        self.suites = sorted(
            f for f in self.files
            if f.endswith(".test.sh") and f.startswith(SUITE_ROOTS) and f not in self.excluded
            and os.path.isfile(os.path.join(root, f)))

    def read(self, rel):
        if rel in self.cache:
            return self.cache[rel]
        try:
            with open(os.path.join(self.root, rel), encoding="utf-8", errors="replace") as fh:
                self.cache[rel] = fh.read()
        except OSError:
            self.cache[rel] = ""
        return self.cache[rel]

    def grep(self, patterns, word):
        if not patterns:
            return set()
        with tempfile.NamedTemporaryFile("w", suffix=".pat") as pat:
            pat.write("\n".join(sorted(patterns)) + "\n")
            pat.flush()
            r = git(self.root, "grep", "-l", "-I", "--untracked", "-F", *(["-w"] if word else []), "-f", pat.name,
                    check=False)
        if r.returncode not in (0, 1):
            sys.exit("select-tests: git grep failed: " + r.stderr.strip())
        return set(lines(r.stdout))

    def code(self, rel):
        """The file's text without whole-line comments: a comment runs nothing."""
        if rel not in self.stripped:
            text = self.read(rel)
            if rel.endswith(CODE) or text.startswith("#!"):
                marks = ("//", "/*", "*") if rel.endswith((".ts", ".js", ".mjs", ".cjs")) else ("#",)
                text = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(marks))
            self.stripped[rel] = text
        return self.stripped[rel]

    def referrers(self, level):
        """Every file whose code names a file in `level`."""
        pats = {False: set(), True: set()}
        local = []
        for cur in level:
            for tok, word in tokens(cur):
                if self.by_token.get(tok, set()) - {cur}:
                    pats[word].add("{}/{}".format(os.path.basename(os.path.dirname(cur)), tok))
                    local.append((cur, tok, word))
                else:
                    pats[word].add(tok)
        words = re.compile("|".join(WORD.format(re.escape(p)) for p in sorted(pats[True]))) if pats[True] else None
        found = {x for x in self.grep(pats[False], False) | self.grep(pats[True], True)
                 if any(p in self.code(x) for p in pats[False]) or (words and words.search(self.code(x)))}
        for cur, tok, word in local:
            for x in self.by_unit.get(unit(cur), ()):
                if names(self.code(x), tok, word):
                    found.add(x)
        for cur in level:
            found.update(self.aliases(cur))
        return found

    def aliases(self, f):
        out = []
        for link, target in self.links:
            if f == target:
                out.append(link)
            elif f.startswith(target + "/"):
                out.append(link + f[len(target):])
        return out


def tokens(path):
    base = os.path.basename(path)
    out = [(base, False)]
    stem = base.split(".", 1)[0]
    if stem != base and len(stem) >= 3:
        out.append((stem, True))
    return out


def names(text, tok, word):
    if not word:
        return tok in text
    return re.search(WORD.format(re.escape(tok)), text) is not None


def unit(path):
    parts = path.split("/")
    if parts[:2] == ["container", "skills"] and len(parts) > 3:
        return "/".join(parts[:3])
    return os.path.dirname(path)


def suite_of(repo, f):
    if f in repo.suites:
        return f
    if f.startswith(PY_SUITE_DIR) and f.endswith(".test.py") and "/" not in f[len(PY_SUITE_DIR):]:
        return PY_RUNNER
    return None


def carries(repo, path):
    base = os.path.basename(path)
    if not path.startswith(SUITE_ROOTS) or path.startswith(NOT_RUN_BY_SUITES) or ".test." in base:
        return False
    if base.endswith(CODE):
        return True
    return "." not in base and repo.read(path).startswith("#!")


def may_feed_suites(f):
    return not (f.startswith(NOT_SHELL_INPUT) or ("/" not in f and f.endswith(".md")))


def select(repo, changed):
    """-> (suites, reasons, full_reason or None)"""
    if GATE in changed:
        return list(repo.suites), [], GATE + " runs every suite"
    selected, reasons = {}, {}
    for f in changed:
        seen = {f: 0}
        level, depth, hit = {f}, 0, False
        while level:
            for cur in sorted(level):
                hit = hit or cur in repo.excluded
                s = suite_of(repo, cur)
                if s:
                    hit = True
                    selected.setdefault(s, (f, depth))
            if hit and set(selected) >= set(repo.suites):
                break
            depth += 1
            level = {x for x in repo.referrers({c for c in level if c == f or carries(repo, c)}) if x not in seen}
            for x in level:
                seen[x] = depth
        if not hit and may_feed_suites(f):
            return list(repo.suites), [], "{} reaches no suite by name".format(f)
        if not hit:
            reasons[f] = "outside shell-suite input and no suite names it"
    why = ["{}: {}".format(f, r) for f, r in sorted(reasons.items())]
    why += ["{}: reaches {} at depth {}".format(s, f, d) for s, (f, d) in sorted(selected.items())]
    return sorted(selected), why, None


def changed_files(repo, base):
    mb = git(repo.root, "merge-base", "HEAD", base).stdout.strip()
    diff = lines(git(repo.root, "diff", "--name-only", "--no-renames", mb).stdout)
    untracked = lines(git(repo.root, "ls-files", "-o", "--exclude-standard").stdout)
    return sorted(set(diff) | set(untracked))


def suite_env(home):
    env = dict(os.environ, HOME=home, GIT_CONFIG_NOSYSTEM="1", XDG_CONFIG_HOME=os.path.join(home, ".config"))
    env.pop("GIT_CONFIG_GLOBAL", None)
    env.pop("GIT_CONFIG_SYSTEM", None)
    return env


def run_one(repo, suite, shard, logdir):
    budget = repo.budgets.get(suite, DEFAULT_TIMEOUT_S)
    label = suite if shard is None else "{} [{}]".format(suite, shard)
    log = os.path.join(logdir, label.replace("/", "__").replace(" [", ".").replace("]", "") + ".log")
    with tempfile.TemporaryDirectory(prefix="select-tests-home-") as home, open(log, "w") as out:
        env = suite_env(home)
        if shard is not None:
            env["SMOKE_SHARD"] = shard
        start = time.monotonic()
        rc = subprocess.run(["timeout", "-s", "KILL", "{}s".format(budget), "bash", os.path.join(repo.root, suite)],
                            stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, env=env).returncode
    return label, rc, time.monotonic() - start, log


def jobs_for(repo, suites, shards):
    """One job per suite; a suite that marks its cases (smoke-case.sh) is split
    into `shards` processes that together run each case once."""
    out = []
    for s in suites:
        if shards > 1 and not os.environ.get("SMOKE_CASE") and CASES_LIB in repo.code(s):
            out += [(s, "{}/{}".format(k, shards)) for k in range(1, shards + 1)]
        else:
            out.append((s, None))
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("paths", nargs="*", help="changed repo-relative paths (default: diff against --base)")
    p.add_argument("--base", default="origin/main")
    p.add_argument("--all", action="store_true", help="every suite, whatever changed")
    p.add_argument("--run", action="store_true", help="run the selected suites")
    p.add_argument("-j", "--jobs", type=int, default=2)
    p.add_argument("--shards", type=int, default=4, help="processes per suite that marks its cases")
    p.add_argument("--explain", action="store_true", help="print why each suite was selected, to stderr")
    a = p.parse_args()
    root = git(HERE, "rev-parse", "--show-toplevel").stdout.strip()
    repo = Repo(root)
    if a.all:
        suites, reasons, full = list(repo.suites), [], "--all"
    else:
        suites, reasons, full = select(repo, [os.path.normpath(c) for c in a.paths] or changed_files(repo, a.base))
    if full:
        print("select-tests: FULL set -- " + full, file=sys.stderr)
    elif a.explain:
        for r in reasons:
            print("select-tests: " + r, file=sys.stderr)
    if not a.run:
        for s in suites:
            print(s)
        return 0
    logdir = tempfile.mkdtemp(prefix="select-tests-logs-")
    failed = 0
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        jobs = jobs_for(repo, suites, a.shards)
        for fut in as_completed([pool.submit(run_one, repo, s, k, logdir) for s, k in jobs]):
            suite, rc, secs, log = fut.result()
            print("{} {:6.1f}s {}{}".format("PASS" if rc == 0 else "FAIL", secs, suite,
                                            "" if rc == 0 else "  (log: {})".format(log)), flush=True)
            failed += rc != 0
    print("select-tests: {} suite(s) in {} job(s), {} failed; logs in {}".format(len(suites), len(jobs), failed, logdir))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
