# QA handoff ledger acknowledgement

Fix the independently reproduced terminal-handoff defect: a failed ledger append
followed by an empty readback must not count as successful delivery. Require the
append to succeed and the readback to contain the exact matching receipt. Preserve
the existing owner-fenced retry path, slot and lease when delivery fails.

Acceptance: under a non-root runtime user, an unwritable ledger leaves finish
unsuccessful, handoff unwritten and ownership retained. After restoring write
permission, same-run retry appends one receipt and completes. Include a regression
that detects empty readback even when tests execute with elevated filesystem
permissions. Run the gate suite against the exact candidate and independently
review the narrow change. Deploy mounted source only after reviewed publication;
no host/image build or restart is needed. Preserve historical QA and promotion holds.
