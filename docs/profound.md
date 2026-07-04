# Profound Access For Madison Reed Agents

Profound is scoped to the Madison Reed workgroup only. NanoClaw should expose Profound through OneCLI, not raw environment variables. Madison Reed container agents make normal HTTPS requests; the OneCLI gateway injects credentials at the proxy boundary.

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

Add Profound to the Madison Reed workgroup baseline:

```bash
pnpm exec tsx scripts/enable-profound-access.ts
```

Include the custom log ingestion token only if Madison Reed agents should send logs:

```bash
pnpm exec tsx scripts/enable-profound-access.ts --include-log-ingestion
```

The script validates that the named OneCLI secrets exist before writing. It appends missing names to `workgroups.onecli_secrets` for `madison-reed` and preserves existing declarations. The script rejects non-Madison-Reed workgroups.

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
