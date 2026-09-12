# PR #710 fix round (Codex CHANGES + Opus adjudication)

Head at start of this round: cc82408e3 (pushed, PR ready-for-review)

Source docs: /home/ubuntu/scratch/autoagent-0912/verify-710/ADJUDICATION.md,
/home/ubuntu/scratch/autoagent-0912/codex-710-review.md, probes in verify-710/probes/.

Scope for this round (per team lead): F2 and F4 only. F1 (click-binding across
approval kinds) and F3 (formatter escaping) are separate PRs; #710's PR body must
say so explicitly rather than claim they're fixed.

## Plan

- [ ] F2: key choice_receipts by approval_id (PK), request_id indexed non-unique.
      Drop ON CONFLICT DO NOTHING. Refuse a request_choice whose choiceId matches
      a currently-PENDING approval's request_id. Add approval_id to the
      choice_response host note. Amend migration 077 in place (unmerged).
- [ ] F4: stamp platformMessageId only from genuine native adapter ingress
      (main.ts onInbound, excluding the 'cli' channelType, whose onInbound path
      also carries host-synthesized ids). onInboundEvent (CLI to: transport,
      Discord slash, messaging-groups send) never sets it.
- [ ] Tests (each shown failing without its fix first):
      - host strip: agent chat/chat-sdk write carrying platformMsgId is stripped
      - router stamp: native ingress stamps, CLI to: transport and Discord slash do not
      - duplicate choiceId against a pending approval is refused
      - losing-click test fails when the CAS guard is removed (assert single
        delivery, not just receipt count) — probes/host-f1-f2-f4seam.test.ts F2
        case is the template
      - receipt-failure log.error asserted with vi.spyOn
- [ ] PR body corrections: delete-cli-agent.ts teardown deletes receipts;
      platform_msg_id native-ingress-only; receipts not yet authoritative until
      the click-binding PR (F1) lands; formatter escaping is a separate PR.
- [ ] Host tsc, container tsc, targeted suites, full host suite, full container
      suite — all detached + polled by hand, evidence in the report.
- [ ] Regenerate ratchet if new upstream-owned files grow further.
- [ ] Push, update PR body, report to team-lead. No merge.

## Log

- F2 implemented: migration 077 amended in place (approval_id PK, request_id
  indexed non-unique), ON CONFLICT DO NOTHING removed, duplicate-choiceId
  refusal added in modules/interactive/choice.ts (scoped globally via
  getPendingApprovalByRequestId), approval_id added to the choice_response
  host note (formatChoiceResponse). Added getChoiceReceiptsByRequestId.
- F4 implemented: InboundEvent.message.nativeId added (adapter.ts), set only
  by main.ts's onInbound for non-CLI adapters, router.ts's write site reads
  event.message.nativeId instead of event.message.id.
- Tests added/updated: choices.test.ts (getChoiceReceipt now keyed by
  approval_id, losing-click test asserts single delivery via handler call
  count, new F2 two-receipts test, log.error spy on receipt-write failure),
  choice.test.ts (duplicate-choiceId refusal test, approval_id in
  formatChoiceResponse assertions), host-origin.test.ts (new "reserved
  platformMsgId field" describe block: strip on agent/a2a writes, survives
  only via the write option), new src/router.native-message-id.test.ts
  (native ingress stamps, CLI to: transport and Discord slash don't).
- Verified EVERY new/changed assertion fails without its fix by temporarily
  reverting each fix in isolation, running the test, confirming red, then
  restoring: F2 schema+ON CONFLICT (choices.test.ts "two approvals sharing"),
  CAS guard bypass (choices.test.ts "losing second click" — handler call
  count catches it), log.error removal (choices.test.ts "logs the error"),
  duplicate-choiceId check removal (choice.test.ts), router.ts nativeId→id
  revert (router.native-message-id.test.ts — both CLI and slash cases red),
  stripPlatformMessageId no-op (host-origin.test.ts — both cases red).
- pnpm exec tsc --noEmit: clean. pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit: clean.
- Ratchet regenerated (--accept) for docs/agent-runner-details.md,
  src/channels/adapter.ts, src/db/index.ts, src/router.ts — all additive
  (new doc lines, new optional field + its doc comment, one more export,
  8 more lines of comment+logic in the write call).
- Round 2 finished: full host + container suites green, pushed as f6bcb1850.

## Round 3 (Codex CHANGES on f6bcb1850, two P2s)

Review: /home/ubuntu/scratch/autoagent-0912/codex-710b-review.md

- [x] P2.1 atomic duplicate-choiceId reservation. choice.ts:141's pre-check
      crosses awaits before primitive.ts inserts; two sessions racing the same
      choiceId produced two pending approvals + two cards + no refusal.
      Shape: migration 078, partial UNIQUE index on
      pending_approvals(request_id) WHERE action='request_choice' AND
      status='pending' — scoped to the action because the uniqueness claim is
      request_choice's alone (onecli redelivery and bash-gate have their own
      request_id reuse semantics and must not be newly constrained).
      createPendingApproval already answers changes>0; requestApproval must
      honour it and report 'duplicate-request' so no card posts.
      Live-install precheck re-run read-only before authoring: 13 pending
      approvals, 13 distinct request_ids, 0 null, no dupes, choice_receipts
      absent — the index cannot fail on live data.
- [x] P2.2 mutation-proof the tests: real ingress producer for platform + CLI
      adapters; conflicting-receipt insert instead of DROP TABLE; an ordering
      assertion that kills "insert after the pending-row deletion".
- [x] Stale docs: migration 077's "nothing else deletes" names the
      scripts/delete-cli-agent.ts teardown exception; request-choice.ts's
      documented response line gains approval_id, pinned by a drift test.
- [ ] tsc (host + container), targeted, counterfactual table, full suites,
      ratchet, push, PR body.

## Round 3 log

- P2.1: migration 078 adds a partial UNIQUE index on
  `pending_approvals(request_id)` WHERE action='request_choice' AND
  status='pending'. Scoped to the action because other kinds reuse a
  request_id on purpose (the gateway re-arms an existing row on redelivery,
  bash-gate keys on its outbound message id); scoped to pending because a
  resolved or retired row is deleted immediately after. It retires any
  pre-existing live duplicate BEFORE creating the index — migrations run at
  every host start, so a throw there would crash-loop the boot rather than
  fail closed usefully. `createPendingApproval` already reported changes>0;
  the new `requestApprovalOutcome` turns a false into 'duplicate-request'
  before the card posts, and `requestApproval` stays a boolean wrapper for
  the other callers. choice.ts's pre-check is kept but demoted to a fast
  path, with the same refusal text either way.
- P2.2: the ingress producer moved to `src/channels/inbound-event.ts`
  (`adapterInboundEvent`); main.ts's onInbound delegates to it. The router
  test drives it for a platform adapter AND for the CLI adapter against a
  real wired 'cli' messaging group, so both mutations bite. choices.test.ts
  swaps DROP TABLE for a preseeded conflicting receipt (kills restoring ON
  CONFLICT DO NOTHING) and adds a write-time probe on the pending row (kills
  moving the insert after the delete).
- Docs: 077 names scripts/delete-cli-agent.ts:50-59 as the one deleter; the
  tool description documents approval_id and is pinned to
  formatChoiceResponse by a drift test in choice.test.ts.
- Live-install precheck, read-only, before authoring the migration: 13
  pending approvals, 13 distinct request_ids, 0 null, no duplicates,
  choice_receipts absent — the index cannot fail on live data.
- Host tsc clean; container tsc clean; targeted 8 files / 99 tests pass.
  (review-notes.test.ts checks cited paths against HEAD, not the working
  tree, so the two new files had to be committed before it went green.)
- Ratchet: 5 growths accepted — adapter.ts +2, migrations/index.ts +7,
  registry.test.ts +1, sessions.ts +12, primitive.ts +49.
- Counterfactuals, ALL RED (script /tmp/cf-710.sh, log
  .r3-counterfactual.log): M1 migration 078 absent, M2 reservation result
  ignored, M3 ON CONFLICT DO NOTHING restored, M4 insert moved after the
  delete, M5 nativeId assignment deleted, M6 CLI exclusion deleted, M7 tool
  description reverted to the stale key order.
- Commit 10e73c25. Next: full host + container suites, commit the ratchet,
  push, update the PR body.
