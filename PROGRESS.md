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
- Next: full host + container suites, then commit/push, update PR body.
