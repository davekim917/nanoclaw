# Inbound attachment limit

The 4.41 chat adapters download every attachment through one function in `@chat-adapter/shared`, which refuses
anything over 25 MiB. Before them, Slack files up to at least 41 MiB reached agents. The fork's existing patch on that
package now also lets the host hand it a limit.

## @chat-adapter/shared 4.41.1 → 4.41.1

Source: patches/@chat-adapter__shared@4.41.1.patch
Override: inbound files over 25 MiB dropped since the 2026-10-06 adapter bump; a patch at the shipped version. This PR adds the attachment-download tests, which count for later changes once merged

- Slack downloads take the host's limit (100 MiB, `INBOUND_ATTACHMENT_MAX_BYTES`) instead of the 25 MiB default · test: src/channels/slack-live-path.test.ts
- Discord downloads take the same limit · test: src/channels/discord-live-path.test.ts
- a file over the host's limit is refused before its body is read, and its message still arrives without the bytes · test: src/channels/slack-live-path.test.ts
- a test may serve downloads through a transport set the same way; production never sets one · not covered: the fake transport is the test seam itself
