/**
 * Bash progress-label sanitizer.
 *
 * Produces a short human-friendly label for an assistant Bash tool call
 * that surfaces *intent* (binary + subcommand) without leaking paths,
 * env var names, auth headers, or tokens to chat channels.
 *
 * SECURITY — residual risk that this file deliberately accepts:
 *   - Agent inlines a novel opaque token (not matching any prefix and
 *     shorter than 40 chars) in a quoted string argument to a SAFE_VERBOSE
 *     binary. Backstopped by the host-side scrubSecrets at delivery time
 *     (src/secret-scrubber.ts — keep its pattern list in sync with this one).
 *   - Multi-stage shell expansion (`cmd "$(decode_secret)"`). By the time
 *     the subshell runs, the label has already been captured.
 *
 * Do NOT widen without adding a matching pattern here AND in
 * src/secret-scrubber.ts on the host. These two lists are the defense
 * pair — the label generator sanitizes at source, the host scrubber
 * catches anything that slipped through.
 */

const SAFE_VERBOSE_BINS = new Set([
  'git',
  'dbt',
  'jq',
  'grep',
  'rg',
  'ls',
  'cat',
  'find',
  'head',
  'tail',
  'bun',
  'pnpm',
  'npm',
  'node',
  'python',
  'python3',
  'ruby',
  'cargo',
  'make',
  'tsc',
  'prettier',
  'eslint',
  'tree',
  'wc',
  'diff',
]);

/**
 * Binaries that commonly embed auth in args (headers, --user flags,
 * connection URIs). Collapsing to binary + first subcommand sidesteps
 * the leak surface entirely — even if the secret-shape scrubber misses
 * a new token format, it never enters the label.
 */
const RISKY_BINS = new Set([
  'curl',
  'wget',
  'aws',
  'gcloud',
  'gh',
  'psql',
  'mysql',
  'mongo',
  'redis-cli',
  'ssh',
  'scp',
  'rsync',
  'http',
  'httpie',
]);

/**
 * Binaries where the argument IS the payload (echo $X exposes X,
 * export NAME=val exposes NAME). Always collapse to binary-only.
 */
const PAYLOAD_IS_ARG_BINS = new Set(['echo', 'export', 'printf', 'eval', 'base64', 'set', 'source']);

/**
 * Secret-shape scrubber. Applied to whatever label text remains after
 * the path/env/$VAR passes. Mirrored in src/secret-scrubber.ts on the
 * host side.
 */
const SECRET_SHAPE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization headers (Bearer / Basic / Digest)
  [/Authorization:\s*(?:Bearer|Basic|Digest)\s+[^\s'"]+/gi, 'Authorization: <redacted>'],
  // Common secret-bearing custom headers via curl -H "Name: value"
  [/-H\s+['"]?(?:X-API-Key|X-Auth-Token|X-Access-Token|Api-Key|X-Token)[:=]\s*[^'"\s]+['"]?/gi, '-H <redacted>'],
  // user:pass flags
  [/(?:-u|--user)\s+[^:\s]+:[^\s]+/g, '-u <redacted>'],
  // URL query params with secret-shaped names
  [
    /([?&])(api[_-]?key|token|access[_-]?token|password|passwd|pwd|auth|sig|signature)=[^&\s"'`]+/gi,
    '$1$2=<redacted>',
  ],
  // Known vendor token prefixes
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '<redacted>'],
  [/\bxox[abpr]-[A-Za-z0-9-]+\b/g, '<redacted>'],
  [/\bghp_[A-Za-z0-9]+\b/g, '<redacted>'],
  [/\bglpat-[A-Za-z0-9_-]+\b/g, '<redacted>'],
  // JWTs (three base64url segments joined by dots)
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted>'],
];

/**
 * No high-entropy catch-all. Previous iterations used length thresholds
 * (±composition heuristics) to catch unknown opaque tokens — but every
 * variant destroyed legitimate long identifiers (dbt model names,
 * Snowflake table names, content-addressed digests, trace IDs). The
 * false-positive rate is inherent to pattern-matching against natural
 * language, and tightening the heuristic only shifted which identifiers
 * get eaten.
 *
 * Accepted residual risk: a token from a vendor we haven't added a
 * prefix pattern for may slip through. The fix when that happens is a
 * one-line prefix rule here + in src/secret-scrubber.ts, NOT a heuristic.
 * OneCLI proxy (Layer 1) + vendor prefixes (above) + contextual patterns
 * (Authorization:, -u, ?api_key=) + .env-value registry on the host are
 * the real defenses. Re-adding any form of length-only catch-all is a
 * regression.
 */
function scrubSecretShapes(s: string): string {
  let out = s;
  for (const [re, repl] of SECRET_SHAPE_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

function binaryName(firstToken: string): string {
  // /usr/bin/foo → foo; ./script.sh → script.sh
  const stripped = firstToken.replace(/^[./]+/, '');
  const last = stripped.split('/').pop() ?? stripped;
  // Strip trailing shell metachars if a pipe/redirect was jammed against it
  return last.replace(/[;&|<>].*$/, '');
}

export function sanitizeBashLabel(raw: string): string {
  if (!raw) return 'Running command';
  // First line only — multi-line heredocs/scripts are too variable to label usefully.
  let s = raw.split('\n')[0].trim();
  if (!s) return 'Running command';

  // Strip leading VAR=val VAR2=val cmd-env prefix
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
  // Strip leading sudo/nohup/time wrappers
  s = s.replace(/^(?:sudo(?:\s+-[^\s]+)*|nohup|time)\s+/, '');

  const firstToken = s.split(/\s+/)[0] ?? '';
  const bin = binaryName(firstToken);
  if (!bin) return 'Running command';
  // Normalize the first token so the path-redaction pass below doesn't
  // swallow the binary's own absolute path (/usr/bin/jq → jq).
  if (firstToken !== bin) s = bin + s.slice(firstToken.length);

  // Whole-command rewrites run BEFORE the PAYLOAD_IS_ARG check so that
  // `export NAME=/path/to/file` shows as `export <env>=<value>` rather
  // than collapsing all the way to `export`.
  s = s.replace(/^export\s+[A-Za-z_][A-Za-z0-9_]*=\S+/i, 'export <env>=<value>');
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(s)) return 'Running: <env>=<value>';
  if (s === 'export <env>=<value>') return `Running: ${s}`;

  if (PAYLOAD_IS_ARG_BINS.has(bin)) return `Running: ${bin}`;

  // Redact $VAR / ${VAR} references (keeps structure, hides name)
  s = s.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '$…');
  // Redact absolute and home paths (start-of-string, after whitespace, after = or quote)
  s = s.replace(/(^|[\s="'`])(\/[^\s'"()`]+|~\/[^\s'"()`]+)/g, '$1<path>');

  // Secret-shape scrub applies regardless of bin category.
  s = scrubSecretShapes(s);

  // Risky binaries: binary + first non-flag subcommand, nothing else.
  if (RISKY_BINS.has(bin)) {
    const parts = s.split(/\s+/);
    const sub = parts[1];
    return sub && /^[A-Za-z][\w:-]*$/.test(sub) ? `Running: ${bin} ${sub}` : `Running: ${bin}`;
  }

  // Safe verbose binaries: full sanitized command, truncated on word boundary.
  if (SAFE_VERBOSE_BINS.has(bin)) {
    if (s.length > 100) s = s.slice(0, 99).replace(/\s\S*$/, '') + '…';
    return `Running: ${s}`;
  }

  // Unknown binary: same conservative default as RISKY.
  const parts = s.split(/\s+/);
  const sub = parts[1];
  return sub && /^[A-Za-z][\w:-]*$/.test(sub) ? `Running: ${bin} ${sub}` : `Running: ${bin}`;
}
