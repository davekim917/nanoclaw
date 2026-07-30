# Discord approval card reliability

## Problem

Discord component interactions encode a button action id and value as a newline-delimited `custom_id`. NanoClaw's forwarded Gateway path parsed the raw value as if it were already decoded, so a click could arrive downstream as `0\n0`. The approval handler then treated every non-approve value as rejection. Approval cards also need to retain enough decision context to remain understandable before and after resolution.

## Requirements

1. Decode Discord's real wire format before resolving a card option.
2. Accept only explicit approval outcomes; malformed or unknown values must leave the request pending.
3. Show the approval title and decision context on Discord and Slack, and retain them when the card resolves.
4. Preserve the existing delivery policy: admin/system approvals use an eligible approver DM by default; work-level gates may explicitly select the originating thread.
5. Persist the render metadata required after a restart without changing existing approval authority.

## Scope

- Chat SDK card rendering and Discord forwarded interaction handling.
- Registered and OneCLI approval response validation.
- Pending approval, channel-approval, and sender-approval render metadata.
- Migration and regression coverage.

No channel-routing policy change, new approval authority, container image change, or external API change is in scope.

## Verification and rollout

- Exercise Discord's literal newline-delimited wire value, unresolved values, explicit approve/reject, initial and resolved cards, permission approval variants, and migrations.
- Run the full host test suite and TypeScript build.
- Publish narrowly to `origin/main`, build the active checkout, restart the system-level `nanoclaw-v2.service`, and verify migration 45, service health, startup logs, and remote SHA parity.

## Rollback

Revert the code commit and rebuild/restart the host. Migration 45 is additive and backward-compatible; the added columns can remain unused during rollback.
