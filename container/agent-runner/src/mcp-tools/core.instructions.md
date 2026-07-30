## Outbound tools

The runtime system prompt lists your destinations and explains how final output
is handled in this session. Each tool's own description says when to pass `to`
and when to omit it.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad —
logged but not sent. This is a formatter convention, not a tool parameter.
