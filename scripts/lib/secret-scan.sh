# Shared secret-shaped-content detector. Sourced by scripts/git-safety.sh
# (groups/ snapshot, single-tier: refuses the WHOLE commit before anything
# is staged) and scripts/wiki-pre-push-hook.sh (two-tier BLOCK/WARN: a
# `pre-push` hook the host installs into
# data/managed-git-hooks/nanoclaw-secret-patterns.sh — a byte-for-byte copy
# of this file, made at host startup by src/managed-git-hooks.ts, so the
# pattern set has exactly ONE source of truth regardless of which caller
# runs where). Both callers MUST call secret_scan_selftest immediately
# after sourcing and fail closed if it returns nonzero.
#
# Broad, case-insensitive, and deliberately over-inclusive: refusing a
# non-secret line costs a manual `git diff` and a re-run; missing a real one
# costs a leaked credential. Covers common vendor token shapes (OpenAI,
# Stripe, GitHub PAT/OAuth/App, Slack bot/app, AWS, Google), PEM/PGP private
# keys, JWTs, connection-string credentials, env/export assignments, and
# JSON/YAML/plain "key: value" or "key=value" forms for
# password/secret/token/api_key (the bare "token" alternative also matches
# "access_token", "refresh_token", etc. as a substring — deliberately, so
# the list doesn't need every compound name spelled out).
# \b before sk- matters: without it, "sk-" matches as a mid-word substring
# of any longer hyphenated token that happens to contain it (e.g. a
# "desk-<40-char-hash>" config value) — the historical false-positive driver
# per #628. It also makes a separate sk-ant- alternative redundant: an
# Anthropic key ("sk-ant-api03-...") already satisfies \bsk- followed by
# 20+ [A-Za-z0-9_-] characters. gh[ousr]_ covers OAuth/User-to-server/
# Server-to-server/Refresh tokens (gho_/ghu_/ghs_/ghr_) at a 20-char
# minimum; ghp_ (classic PAT) keeps its own longer 30-char minimum — kept
# as two separate alternatives (not merged into one gh[pousr]_ class) so
# SECRET_BLOCK_RE below can copy exactly these two and stay a true subset
# (a merged form would let a 20-29 char ghp_ token match BLOCK while
# missing SECRET_RE's own 30-char requirement — found in #666 review).
# xox[abpre]- adds the legacy/rotation xoxe- prefix; (AKIA|ASIA) adds AWS
# STS temporary credentials. The PEM alternative also matches a PGP private
# key block, whose trailer text differs ("...KEY BLOCK-----", not
# "...KEY-----"). The identifier alternative matches ANY name containing
# key/secret/token/password/passphrase/pass (exported or not) followed by
# `=` or `:` and a value, so it also catches `*_PASSPHRASE=`, `*_PASS=`,
# and a plain unexported `MY_KEY=...` that never had "export" in front of
# it.
# [^A-Za-z0-9]{0,6} in that last alternative (not {0,3}): under this file's
# LC_ALL=C (see secret_scan_extract_added below), a character class counts
# BYTES, not characters — a single multibyte punctuation character (e.g. a
# smart quote at 3 bytes each in UTF-8) can burn most of a small budget by
# itself. `{0,3}` let a real match — `“password” : x`, curly close-quote
# plus space before the colon, 4 bytes — slip through under a UTF-8 locale
# but miss under LC_ALL=C; `{0,6}` restores headroom for a couple of
# multibyte punctuation characters plus ordinary whitespace without
# meaningfully loosening the ASCII case.
SECRET_RE='(\bsk-[A-Za-z0-9_-]{20,}|(sk|rk)_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{30,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|(AKIA|ASIA)[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN (PGP PRIVATE KEY BLOCK|[A-Z ]*PRIVATE KEY)-----|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+|[A-Za-z][A-Za-z0-9+.-]*://[^/@[:space:]:]+:[^/@[:space:]]+@|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{10,}|[A-Za-z_][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PASS)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]|(token|api[_-]?key|password|secret)[^A-Za-z0-9]{0,6}[:=][[:space:]]*[^[:space:]])'

# High-confidence subset of SECRET_RE only: a fixed vendor prefix plus a
# long enough random-looking suffix. These essentially never appear by
# coincidence in prose, config comments, or binary/font blobs, so a
# wiki-pre-push-hook.sh BLOCK on one is safe — contrast the fuzzier
# remainder of SECRET_RE (identifier assignment forms, connection strings,
# JWTs), which is too collision-prone with ordinary prose/config to block a
# push on and is only ever used as WARN there (secret_scan_warn_hits below
# reuses SECRET_RE itself, case-insensitively — see its comment).
#
# EVERY alternative here is a literal copy of, or a narrower pattern than,
# a SECRET_RE alternative above, so SECRET_BLOCK_RE is provably a subset:
# anything BLOCK matches, SECRET_RE also matches (asserted directly by a
# selfcheck case in both scripts/git-safety-selfcheck.sh and
# scripts/wiki-pre-push-hook-selfcheck.sh, over every BLOCK fixture). AKIA
# is split out from SECRET_RE's combined (AKIA|ASIA) alternative — ASIA
# (AWS STS temporary credentials) stays WARN-only; only permanent AKIA
# access-key IDs are high-confidence enough to block on.
SECRET_BLOCK_RE='(\bsk-[A-Za-z0-9_-]{20,}|(sk|rk)_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{30,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN (PGP PRIVATE KEY BLOCK|[A-Z ]*PRIVATE KEY)-----)'

# AWS's own official "this is never a real key" documentation example
# (used throughout aws-cli/boto3/Terraform docs and fixtures). A
# case-sensitive BLOCK still matches its AKIA-shaped literal — allowlisted
# by this EXACT string only, nothing broader (no wildcard, no path, no
# pattern) — see secret_scan_count below.
SECRET_SCAN_ALLOWLISTED_LITERAL='AKIAIOSFODNN7EXAMPLE'

# The unified-diff/log "added line" marker every git diff/log call in both
# callers passes via --output-indicator-new=$SECRET_SCAN_NEW_INDICATOR
# (context/old lines keep git's defaults, ' '/'-', so they never collide
# with this). A single non-printable byte (ASCII SOH) that cannot appear at
# the start of any real source line, unlike '+': an ADDED line is itself
# printed as the indicator followed by its own content, so a real added
# line whose content happened to start with "++ " (e.g.
# "++ token=abc123...") used to come out as "+++ token=abc123..." on the
# wire — syntactically identical to a `+++ ` file-header line, so a
# blanket `^\+\+\+ ` header exclusion silently dropped it (#666 review
# P3-3, and the same bug independently in #658 before that). Overriding
# the indicator removes the ambiguity entirely instead of trying to
# pattern-match every header shape git might emit: the `+++`/`---` file
# header lines are untouched by --output-indicator-new (confirmed
# empirically against both the host's git 2.43.0 and the agent image's git
# 2.39.5), so they never start with this byte either.
SECRET_SCAN_NEW_INDICATOR=$'\x01'

# secret_scan_extract_added <text>
# Emits lines from <text> that start with SECRET_SCAN_NEW_INDICATOR —
# i.e. every line a caller's git diff/log call marked as added via
# --output-indicator-new, PLUS (wiki-pre-push-hook.sh) any non-diff text a
# caller rendered with that same prefix itself, such as a commit message
# body (git's own --output-indicator-new only touches diff/patch content,
# never `git log --format=%B` message text — a secret typed directly into
# a commit message needs its own render path; see that script). The
# indicator byte stays part of the emitted line: no SECRET_RE/BLOCK/WARN
# alternative anchors to the start of the line, so counting against the
# untouched line is exactly as accurate as against a stripped one, and
# skipping the strip avoids one more tool invocation.
secret_scan_extract_added() {
  LC_ALL=C grep -E "^${SECRET_SCAN_NEW_INDICATOR}" <<<"$1"
}

# secret_scan_count <extracted-lines-text> <regex> <sensitive|insensitive>
# Counts lines matching <regex>, applying the allowlisted-literal exclusion
# above first. Echoes the count and returns 0 whenever grep could run at
# all (0 or 1 matches found is exit 0/1 respectively, and both are valid
# results with `-c`). On any grep failure (exit >=2: malformed regex,
# read error) echoes NOTHING and returns 1 — never a non-integer, and
# callers MUST treat a nonzero return as fail-closed, never read the
# missing echo as a count of 0. Never fails under `set -e` on its own: the
# explicit `local rc=$?` capture is the only place that reads grep's exit
# status, so a `set -e` caller sourcing this file is unaffected by whether
# the eventual match count is 0.
secret_scan_count() {
  local text="$1" re="$2" case_mode="$3"
  local -a grep_opts=(-c -E)
  [ "$case_mode" = insensitive ] && grep_opts+=(-i)
  local filtered
  filtered=$(LC_ALL=C grep -vF "$SECRET_SCAN_ALLOWLISTED_LITERAL" <<<"$text")
  local out
  out=$(LC_ALL=C grep "${grep_opts[@]}" "$re" <<<"$filtered")
  local rc=$?
  if [ "$rc" -ge 2 ]; then
    return 1
  fi
  printf '%s' "$out"
  return 0
}

# secret_scan_selftest
# Validates the pattern set is usable at all: the extraction/counting
# functions exist, and every pattern this file exports is non-empty and
# compiles (a `grep -E` against it on empty input returns 0 or 1, never
# >=2). Both callers run this immediately after `source`-ing this file and
# fail closed (refuse to proceed) if it returns nonzero — otherwise a
# corrupt copy of this file (a zero-byte file, one truncated mid-function,
# one with an unbalanced regex, or one where a pattern variable is unset)
# lets `source` return 0 anyway, and the ONLY thing standing between that
# and every secret silently passing through is `${hits:-0}` reading a
# missing/empty result as zero (#666 review P2-1: 4 of 6 corrupt-file
# variants failed exactly this way before this function existed).
secret_scan_selftest() {
  local fn
  for fn in secret_scan_extract_added secret_scan_count; do
    if ! declare -F "$fn" >/dev/null 2>&1; then
      echo "secret-scan selftest: missing function $fn" >&2
      return 1
    fi
  done
  local re
  # ${VAR:-} (never bare "$VAR") — under the callers' `set -u`, a totally
  # unset SECRET_RE/SECRET_BLOCK_RE (e.g. a pattern file truncated above
  # the assignment) must still reach the -z check below and this
  # function's own "an expected pattern is empty" message, not die on
  # bash's own blunt "unbound variable" error one line earlier.
  for re in "${SECRET_RE:-}" "${SECRET_BLOCK_RE:-}"; do
    if [ -z "$re" ]; then
      echo "secret-scan selftest: an expected pattern is empty" >&2
      return 1
    fi
    LC_ALL=C grep -E "$re" </dev/null >/dev/null 2>&1
    local rc=$?
    if [ "$rc" -ge 2 ]; then
      echo "secret-scan selftest: a pattern does not compile (grep exit $rc)" >&2
      return 1
    fi
  done
  if [ -z "${SECRET_SCAN_NEW_INDICATOR:-}" ]; then
    echo "secret-scan selftest: SECRET_SCAN_NEW_INDICATOR is unset" >&2
    return 1
  fi
  return 0
}

# secret_scan_hits <unified-diff-text>
# git-safety.sh's single-tier gate: counts ADDED lines (per
# secret_scan_extract_added — the caller's `git diff` must pass
# --output-indicator-new=$SECRET_SCAN_NEW_INDICATOR) matching SECRET_RE,
# case-insensitively. Callers refuse the change whenever this returns
# nonzero (a scan failure) OR echoes a value greater than 0 — see
# secret_scan_count's contract; do not read a missing echo as 0.
secret_scan_hits() {
  secret_scan_count "$(secret_scan_extract_added "$1")" "$SECRET_RE" insensitive
}
