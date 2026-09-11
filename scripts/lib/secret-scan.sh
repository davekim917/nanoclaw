# Shared secret-shaped-content detector. Sourced by scripts/git-safety.sh
# (groups/ snapshot) — kept in its own file so the pattern set has exactly
# one copy for any future caller to share.
#
# Broad, case-insensitive, and deliberately over-inclusive: refusing a
# non-secret line costs a manual `git diff` and a re-run; missing a real one
# costs a leaked credential. Covers common vendor token shapes (OpenAI,
# Stripe, GitHub PAT/OAuth/App, Slack bot/app, AWS, Google), PEM private
# keys, JWTs, connection-string credentials, env/export assignments, and
# JSON/YAML/plain "key: value" or "key=value" forms for
# password/secret/token/api_key (the bare "token" alternative also matches
# "access_token", "refresh_token", etc. as a substring — deliberately, so
# the list doesn't need every compound name spelled out).
# \b before sk- matters: without it, "sk-" matches as a mid-word substring
# of any longer hyphenated token that happens to contain it (e.g. a
# "desk-<40-char-hash>" config value) — the historical false-positive driver
# per #628. gh[ousr]_ covers OAuth/User-to-server/Server-to-server/Refresh
# tokens (gho_/ghu_/ghs_/ghr_); xox[abpre]- adds the legacy/rotation xoxe-
# prefix; (AKIA|ASIA) adds AWS STS temporary credentials. The identifier
# alternative matches ANY name containing key/secret/token/password/
# passphrase/pass (exported or not) followed by `=` or `:` and a value, so
# it also catches `*_PASSPHRASE=`, `*_PASS=`, and a plain unexported
# `MY_KEY=...` that never had "export" in front of it.
SECRET_RE='(\bsk-[A-Za-z0-9_-]{20,}|(sk|rk)_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{30,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|(AKIA|ASIA)[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+|[A-Za-z][A-Za-z0-9+.-]*://[^/@[:space:]:]+:[^/@[:space:]]+@|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{10,}|[A-Za-z_][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PASS)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]|(token|api[_-]?key|password|secret)[^A-Za-z0-9]{0,3}[:=][[:space:]]*[^[:space:]])'

# secret_scan_hits <unified-diff-text>
# Counts ADDED lines (unified-diff `+` lines, excluding the `+++` file
# header) that match SECRET_RE, case-insensitively. Callers refuse the
# change whenever this is > 0. Never fails under `set -e`: an empty/no-match
# grep would otherwise return 1 and abort the caller.
#
# LC_ALL=C on all three greps: under the installed units' LANG=en_US.UTF-8,
# GNU grep classifies a diff containing an invalid UTF-8 byte (a truncated
# multibyte sequence — common in a binary-ish paste, a foreign-language
# comment with a bad encoding, or an adversarial line built to exploit
# exactly this) as a BINARY file. In binary mode `-c` reports "binary file
# matches" / a bare 0 instead of the actual matching lines, so the FIRST
# grep in this pipe (`^\+`) silently stops emitting any line at all — the
# downstream secret grep then sees nothing and counts 0 hits, even with a
# live secret sitting right next to the bad byte (verified empirically: a
# diff line combining bytes 0x80-0x82 with a real xapp- token counts 0
# hits under LANG=en_US.UTF-8, 1 under LC_ALL=C). C locale treats every
# byte as plain text, so this binary misclassification never triggers.
secret_scan_hits() {
  LC_ALL=C grep -E '^\+' <<<"$1" | LC_ALL=C grep -vE '^\+\+\+ ' | LC_ALL=C grep -icE "$SECRET_RE" || true
}
