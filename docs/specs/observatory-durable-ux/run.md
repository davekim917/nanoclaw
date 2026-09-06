# Execution record

User authorized following through on the durable deployment repair after a later normal host deployment replaced an earlier local-only build. Integration begins at published main 9532fa638. Prior reviewed UX source is retained at bab551c14, but newer published fixes must be preserved rather than overwritten.

One integration builder uses the requested Astra Medium model. Root owns publication, activation and live verification. Pending: implementation checks, final diff review, publication parity, deployment and production evidence.

Implementation f4d3bcd05 restores the work-first interface while retaining current review history, draft evidence binding, project revision conflict handling, source validation, pagination, and async driver behavior. Optional claim details remain scoped to a uniquely owning visible agent; thread links require an actual same-agent session relationship. Schedule assembly is absent from the overview critical path.

Final verification: 27 dashboard test files / 409 tests passed; 30 scoped API/source/state tests passed; host/scripts typecheck passed; dashboard TypeScript/Vite build passed; ratchet report delta zero. Independent review found a definitive validation-rejection composer lock. Corrected known pre-write HTTP400 failures to retain an editable draft; uncertain failures retain immutable retry payload/key. Reviewer rechecked and reported no remaining blocker. Regression covers both branches.

Publication scope: only the restored Observatory UI, optional claim details, cache-only schedule read, regression tests, and product/design documentation. No dependency, provider, container, migration or access-role changes. The installation selects the Saturday workspace in ignored dashboard/.env.local; no real workspace identifier is added to published configuration.
