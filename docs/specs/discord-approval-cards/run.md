# Discord approval card reliability run

## Implementation evidence

- Discord forwarded interactions now decode the adapter's newline-delimited `custom_id` before option resolution.
- Registered and OneCLI approvals accept only explicit approve/reject outcomes; unknown values remain pending.
- Card decision context is rendered through the native card subtitle and persisted for terminal rendering.
- Migration 45 adds non-null, default-empty `question` columns to pending questions and all three pending approval tables.
- The existing delivery target policy is unchanged.

## Verification before review

- Focused approval/channel/migration suite: 7 files, 147 tests passed.
- Self-mod and memory dependency follow-up: 2 files, 25 tests passed.
- Full host suite: 231 files passed; 3,192 tests passed, 1 skipped, 1 todo.
- `pnpm run build`: passed.
- `git diff --check`: passed.

Checked failure paths include literal Discord `0\n0`, unresolved indexed options, malformed authorized responses, unauthorized approval resolution, DM and guild interaction identity, initial and resolved card rendering, fresh schema migration, channel approvals, sender approvals, and approval rejection.

## Review

Independent implementation review: `must_fix` from Claude Opus 5 at high effort, completed through the required read-only transport.

- Accepted MUST-FIX: `pending_questions` shadowed the persisted approval render record but did not carry `question`, so generic interactive cards could lose context on resolution. Corrected by extending migration 45, persistence, render lookup, and a shadowing-path regression test.
- Rejected MUST-FIX: migration 45 might run before the permission tables exist. Migrations 11 and 12 create those tables, migration 13 already alters both unconditionally, and migration 45 runs later; the proposed failure mode is not reachable through the migration registry.
- Rejected MUST-FIX: legitimate non-binary outcomes would be discarded. Registered approval options are fixed to approve, reject, and reject-with-reason; reject-with-reason is handled before the explicit binary branch. OneCLI is binary. Permission and agent-selection cards use separate handlers.
- Rejected SHOULD-FIX: subtitle rendering and edit support were unverified. The installed Discord adapter maps `Card.subtitle` to embed description and newline-decodes `custom_id`; the installed Slack adapter maps it to an mrkdwn context block. Existing and new bridge tests cover post/edit payloads.
- Rejected SHOULD-FIX: moving question text to subtitle introduces a new length failure. Discord maps both the prior `CardText` and subtitle to the same embed description; Slack applies platform block limits to either representation. The change does not expand accepted input or remove fallback text.

Correction verification:

- Focused correction suite: 4 files, 66 tests passed.
- `pnpm run build`: passed.
- Implementation review result after verified correction: `clear`; no verified MUST-FIX remains.

## Ship

Fresh preflight verification:

- Full corrected host suite: 231 files passed; 3,193 tests passed, 1 skipped, 1 todo.
- TypeScript build and focused correction suite remain green.

Pending direct publish and live deployment.
