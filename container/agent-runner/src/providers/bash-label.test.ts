import { describe, expect, test } from 'bun:test';
import { sanitizeBashLabel } from './bash-label.js';

describe('sanitizeBashLabel', () => {
  test('empty input', () => {
    expect(sanitizeBashLabel('')).toBe('Running command');
    expect(sanitizeBashLabel('   ')).toBe('Running command');
  });

  test('safe-verbose binary shows full sanitized command', () => {
    expect(sanitizeBashLabel('dbt build --select fct_orders')).toBe('Running: dbt build --select fct_orders');
    expect(sanitizeBashLabel('git commit -m "fix thing"')).toBe('Running: git commit -m "fix thing"');
    expect(sanitizeBashLabel('jq -r .foo')).toBe('Running: jq -r .foo');
  });

  test('risky binary collapses to binary + subcommand', () => {
    expect(sanitizeBashLabel('curl -H "Authorization: Bearer xxx" https://api.example.com')).toBe('Running: curl');
    expect(sanitizeBashLabel('aws s3 ls s3://bucket')).toBe('Running: aws s3');
    expect(sanitizeBashLabel('gh pr create --title foo')).toBe('Running: gh pr');
  });

  test('payload-is-arg binaries collapse to binary only', () => {
    expect(sanitizeBashLabel('echo $SECRET_TOKEN')).toBe('Running: echo');
    expect(sanitizeBashLabel('export FOO=bar')).toBe('Running: export <env>=<value>');
    expect(sanitizeBashLabel('printf "%s" "$PASSWORD"')).toBe('Running: printf');
  });

  test('absolute paths replaced with <path>', () => {
    expect(sanitizeBashLabel("jq -r '.[0].text' /home/node/.claude/projects/-workspace-agent/abc.jsonl")).toBe(
      "Running: jq -r '.[0].text' <path>",
    );
    expect(sanitizeBashLabel('cat ~/.ssh/config')).toBe('Running: cat <path>');
  });

  test('$VAR references redacted', () => {
    expect(sanitizeBashLabel('node scripts/foo.js $API_URL')).toBe('Running: node scripts/foo.js $…');
  });

  test('leading env assignments stripped', () => {
    expect(sanitizeBashLabel('AWS_PROFILE=foo aws s3 ls')).toBe('Running: aws s3');
    expect(sanitizeBashLabel('FOO=bar BAZ=qux dbt run --select x')).toBe('Running: dbt run --select x');
  });

  test('sudo/nohup/time prefixes stripped', () => {
    expect(sanitizeBashLabel('sudo dbt build')).toBe('Running: dbt build');
    expect(sanitizeBashLabel('time python scripts/foo.py')).toBe('Running: python scripts/foo.py');
  });

  test('export of env var sanitized as a whole', () => {
    expect(
      sanitizeBashLabel('export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/foo.json'),
    ).toBe('Running: export <env>=<value>');
  });

  test('bare VAR=val standalone', () => {
    expect(sanitizeBashLabel('MY_TOKEN=abc123')).toBe('Running: <env>=<value>');
  });

  test('secret-shape scrub: JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456';
    expect(sanitizeBashLabel(`jq -r .sig ${jwt}`)).toBe('Running: jq -r .sig <redacted>');
  });

  test('secret-shape scrub: GitHub PAT', () => {
    expect(sanitizeBashLabel('git push https://ghp_abcdefghijklmnopqrstuvwxyz012345678901@github.com/foo')).toContain(
      '<redacted>',
    );
  });

  test('secret-shape scrub: OpenAI-style key in SAFE_VERBOSE context', () => {
    expect(sanitizeBashLabel('jq -r .text sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toContain('<redacted>');
  });

  test('long identifiers (digests, random mixed-case) are NOT redacted', () => {
    expect(sanitizeBashLabel('dbt build --select sha256_aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5a')).toContain(
      'sha256_aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5a',
    );
  });

  test('URL query param secrets', () => {
    // curl is risky, so this becomes binary only anyway; but the scrub still runs if it ever escapes.
    expect(sanitizeBashLabel('curl https://api.example.com/foo?api_key=xxx&other=ok')).toBe('Running: curl');
  });

  test('truncation at word boundary', () => {
    const long =
      'dbt build --select tag:nightly --exclude tag:slow --vars "{start_date: 2024-01-01, end_date: 2024-12-31}"';
    const out = sanitizeBashLabel(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(110);
    expect(out.startsWith('Running: dbt build')).toBe(true);
  });

  test('long snake_case dbt model names are NOT redacted', () => {
    expect(
      sanitizeBashLabel('dbt build --select fct_customer_breakback_allocation_by_market_parent_sku'),
    ).toContain('fct_customer_breakback_allocation_by_market_parent_sku');
  });

  test('long SCREAMING_SNAKE table names are NOT redacted', () => {
    expect(sanitizeBashLabel('dbt run --vars TABLE=CUSTOMER_BREAKBACK_ALLOCATION_BY_MARKET_PARENT_SKU')).toContain(
      'CUSTOMER_BREAKBACK_ALLOCATION_BY_MARKET_PARENT_SKU',
    );
  });

  test('unknown binary: conservative binary + subcommand only', () => {
    expect(sanitizeBashLabel('someweirdcli subcommand --flag')).toBe('Running: someweirdcli subcommand');
    expect(sanitizeBashLabel('xyz --flag')).toBe('Running: xyz');
  });

  test('absolute binary path normalized', () => {
    expect(sanitizeBashLabel('/usr/bin/jq -r .foo /some/path')).toBe('Running: jq -r .foo <path>');
  });

  test('pipe chain: labels first stage only (first line scoped)', () => {
    expect(sanitizeBashLabel('curl -H "Authorization: Bearer xxx" https://foo | jq .')).toBe('Running: curl');
  });
});
