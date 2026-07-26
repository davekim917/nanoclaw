# Specification Status

Specification directories are design and execution records, not operator
runbooks or current-runtime documentation.

A specification is active only while its own directory contains
`.team-auto-active`. During that window, its approved design is the normative
contract for the in-progress workflow. Once the sentinel is removed, every
brief, design, plan, review, drift report, QA report, pause note, and decision
record in that directory is historical evidence—even when its old status text
says `APPROVED`, `READY`, or `SHIPPED`.

After a workflow closes, current source, tests, operator skills, and the
top-level documentation indexed from `AGENTS.md` are authoritative. Never
execute commands from a historical spec without revalidating them against
those current surfaces.

In particular, all Mnemon, Ollama, memory-daemon, provider-native auto-memory,
and per-agent memory-store specs are superseded by
`workgroup-memory-and-session-capabilities/` and `docs/memory.md`.
