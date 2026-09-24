# An Actions job GitHub never started: completed with no runner ever assigned
# and no step run. That is the billing lockout's shape — "The job was not
# started because recent account payments have failed..." (annotation on check
# run 105741202176, run 35388540873, 2026-09-18: runner_id 0, runner_name "",
# steps []) — against a job that ran and failed, which always has a runner and
# steps (run 35185456083: runner "GitHub Actions 1000006727", 25 steps).
#
# codex-review.sh (never_started_runs, required_status_red) decides with it
# whether a `CI (host)` status may stand in for a required workflow. Loaded
# with `jq -L <this directory>` and `include "never-started";`.
def never_started: .status == "completed" and ((.steps // []) | length) == 0 and (.runner_id // 0) == 0 and (.runner_name // "") == "";

# The same question about a whole ATTEMPT of a run, given its jobs listing as
# `--paginate --slurp` prints it (an array of pages, each `{jobs: [...]}`):
# at least one job, every one of them never_started, and one of them `failure`.
# A run with no jobs at all answers false — not knowing is never an excuse.
def run_never_started: [ .[].jobs[]? ] | length > 0 and all(.[]; never_started) and any(.[]; .conclusion == "failure");

# A quick-tier attempt, given its jobs listing in the same slurped shape: the
# repo's CI ran only its cheap per-push checks on this commit and failed its
# `CI Quick` gate on purpose, because the full suite runs only when that run is
# re-run (the repo's .github/workflows/ci.yml declares the two tiers). Its job named
# `CI Quick` concluded failure and every other job succeeded or was skipped; any
# other failure is a real red. It is not evidence about the head either way:
# ci_verdict reads it as ci_quick (never green, never red), ci-wait answers it
# by requesting the re-run, and never_started_runs skips an earlier quick
# attempt instead of counting it as a genuine failure.
def quick_only: [ .[].jobs[]? ] as $jobs
  | ($jobs | any(.[]; .name == "CI Quick" and .conclusion == "failure"))
    and ($jobs | all(.[]; .name == "CI Quick" or ((.conclusion // "") | IN("success", "skipped", "neutral"))));
