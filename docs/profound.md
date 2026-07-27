# Profound Access For Example Retail Agents

Profound is scoped to the Example Retail workgroup only. NanoClaw should expose Profound through OneCLI, not raw environment variables. Example Retail container agents make normal HTTPS requests; the OneCLI gateway injects credentials at the proxy boundary.

## Secrets

Create the REST/reporting API secret in OneCLI:

```bash
onecli secrets create --name Profound --type generic --value '<PROFOUND_API_KEY>' --host-pattern api.tryprofound.com --path-pattern '/*' --header-name X-API-Key --value-format '{value}'
```

For Agent Analytics custom log ingestion, create the separate ingestion secret:

```bash
onecli secrets create --name Profound-Log-Ingestion --type generic --value '<PROFOUND_LOG_INGESTION_TOKEN>' --host-pattern artemis.api.tryprofound.com --path-pattern '/v1/logs/custom' --header-name x-api-key --value-format '{value}'
```

## Workgroup Access

First inspect the workgroup's existing baseline:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT onecli_secrets FROM workgroups WHERE id = '<workgroup-id>'"
```

Then set the complete desired baseline, preserving every existing entry and
adding `Profound`:

```bash
pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> \
  --secrets <existing-secret-1,existing-secret-2,Profound>
```

Include `Profound-Log-Ingestion` in that same complete list only when the
workgroup should send logs. `set-workgroup-secrets.ts` validates every name
before writing, but it replaces the baseline rather than appending to it; an
omitted existing name is intentionally removed.

Restart or respawn containers after updating workgroup secrets. Secret assignments are applied at spawn time.

## Verification

Inside a respawned container with Profound access, verify reporting API auth:

```bash
curl -fsS https://api.tryprofound.com/v1/org/categories
```

For custom log ingestion, use a tiny valid test batch only after the user confirms it is acceptable to create an ingestion event:

```bash
curl -fsS https://artemis.api.tryprofound.com/v1/logs/custom \
  -H 'Content-Type: application/json' \
  --data '[{"timestamp":"2026-07-04T00:00:00Z","method":"GET","host":"example.com","path":"/","status_code":200,"ip":"127.0.0.1","user_agent":"NanoClaw verification"}]'
```

## Integration Notes

Profound REST API auth uses `X-API-Key` on `api.tryprofound.com`. Profound Agent Analytics custom ingestion uses `x-api-key` on `artemis.api.tryprofound.com`. The hosted Profound MCP endpoint, `https://mcp.tryprofound.com/mcp`, is OAuth-based and read-only, so it is not the integration setup path.
