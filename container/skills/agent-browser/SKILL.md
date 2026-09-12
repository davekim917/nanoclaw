---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Quick start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser close             # Close browser
```

## Core workflow

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Commands

### Navigation

```bash
agent-browser open <url>      # Navigate to URL
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser close           # Close browser
```

### Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
```

### Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser dblclick @e1        # Double-click
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select dropdown option
agent-browser scroll down 500     # Scroll page
agent-browser upload @e1 file.pdf # Upload files
```

### Get information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get count ".item"   # Count matching elements
```

### Sessions & viewport

```bash
agent-browser --session myapp open <url>     # Named session: persists across
                                              # invocations, so a later call
                                              # with the same --session reuses
                                              # the same daemon/browser state
                                              # instead of starting fresh.
agent-browser set viewport 1280 900          # Resize the viewport (w h)
agent-browser set device "iPhone 14"         # Or use a named device preset
```

`--session <name>` is a global option (works on every command, before the
subcommand). It's how one script drives the same browser across multiple
`agent-browser` invocations — e.g. loading auth state once, then navigating
and capturing several screens without re-authenticating each time.

### Screenshots, PDF & video

```bash
agent-browser screenshot          # Save to temp directory
agent-browser screenshot path.png # Save to specific path
agent-browser screenshot --full   # Full page
agent-browser pdf output.pdf      # Save as PDF

agent-browser record start clip.mp4   # Start recording (name it .mp4 → H.264)
agent-browser record stop             # Stop and save
```

Record only the span worth watching — a clip covering a whole session is
unwatchable. Never record across a login: recording captures typed keystrokes,
so a clip that spans authentication publishes the password.

**`record start` opens a fresh browser context and drops `localStorage`.**
Cookies survive; `localStorage` does not — verified on 0.33.2, whose own
`record --help` wrongly claims it "preserves cookies and localStorage". So on
an app that keeps its auth token in `localStorage`, signing in first and then
recording starts the clip logged OUT, while signing in after the recorder
starts puts the password on camera. Both orders fail, which is why this needs
a recipe rather than a rule:

```bash
# 1. Authenticate BEFORE recording — this part is never filmed.
agent-browser open https://app.example.com
#    ...sign in...
agent-browser storage local get --json > /tmp/auth.json   # capture while authed

# 2. Start the recorder, then restore what it dropped.
agent-browser record start clip.mp4
agent-browser storage local set <key> <value>             # one per key from auth.json
agent-browser reload

# 3. PROVE you are still signed in before walking the flow.
agent-browser get url        # not the login page?
agent-browser snapshot -i    # authed-only element present?

agent-browser record stop
```

Step 3 is the durable part. Whatever the tool does with context in a future
version, confirm the session survived `record start` before you record a flow —
otherwise you produce a clean recording of a logged-out app and don't find out
until someone watches it.

### Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text
agent-browser wait --url "**/dashboard"    # Wait for URL pattern
agent-browser wait --load networkidle      # Wait for network idle
```

### Waiting for a custom condition — ALWAYS bound it

Prefer the built-in `wait` subcommands above. Only fall back to `eval`-polling
when you must wait on a custom JS condition (e.g. a spinner disappearing or a
"Send" button re-enabling in a chat UI).

**Never write an unbounded wait loop.** A bare `until … do sleep; done` that
polls a page condition will loop *forever* if the condition never becomes true
(page failed to load, selector changed, network stalled). That does not just
fail the command — it wedges the entire agent turn: the runner keeps the model
stream open, later messages get silently swallowed, and the container can hang
for hours without the host's stuck-detection firing.

Always cap the wait with BOTH a wall-clock `timeout` and a max-attempts counter,
and always exit the loop (never leave a `sleep` loop as the last thing running):

```bash
# Bounded wait: succeeds when the condition is met, gives up after ~90s.
timeout 90 bash -c '
  for i in $(seq 1 30); do
    if agent-browser eval "document.querySelector(\".loading\") === null" 2>/dev/null | grep -q true; then
      echo READY; exit 0
    fi
    sleep 3
  done
  echo TIMEOUT; exit 1
'
# Check the exit status / output: on TIMEOUT, snapshot the page and decide —
# do NOT re-enter another unbounded wait.
```

If the wait times out, treat it as a real failure: take a `snapshot -i` or
`screenshot` to see the actual page state, report what you found, and move on.
Retrying the same unbounded wait is what causes the hang.

### Semantic locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
```

`click`/`fill`/etc. take a CSS selector, XPath, or `@ref` only — **not** a
`text=...` prefix (that's a different tool's shorthand agent-browser doesn't
recognize; it fails with "Element not found" instead of erroring on the
syntax). To click or fill by visible text, use `find text "<value>" click`
above, not `click "text=<value>"`.

### Authentication with saved state

```bash
# Login once
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "username"
agent-browser fill @e2 "password"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Later: load saved state
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Cookies & Storage

```bash
agent-browser cookies                     # Get all cookies
agent-browser cookies set name value      # Set cookie
agent-browser cookies clear               # Clear cookies
agent-browser storage local               # Get localStorage
agent-browser storage local set k v       # Set value
```

### Network captures — never write raw output to disk

```bash
agent-browser network requests --json          # List captured requests (headers included)
agent-browser network request <requestId>       # Full request/response detail, including body
agent-browser network har start                 # Begin recording a HAR
agent-browser network har stop <path>           # Export the recording to <path>
```

**Both forms persist live credentials in plain text: `requests`/`request` include
the `Authorization`/`Cookie` header values verbatim, and `har stop` writes a HAR
file straight to `<path>` with live bearer tokens and cookies in `headers`,
`cookies`, and request/response bodies.** A redirected `> file.json` or a
durable/shared `<path>` on `har stop` puts a working credential on disk in the
clear — this has happened in production. Never do either directly. Route every
capture that will touch disk through
`/app/skills/agent-browser/scripts/ab-net-redact.sh` instead — it
structurally drops or redacts credential-bearing fields before anything
reaches storage, and fails closed (nothing written) if a capture can't be
parsed or redaction itself fails:

```bash
# In place of: agent-browser network requests --json > requests.json
/app/skills/agent-browser/scripts/ab-net-redact.sh requests --json > requests.json

# In place of: agent-browser network request 1234.5 --json > request.json
/app/skills/agent-browser/scripts/ab-net-redact.sh request 1234.5 --json > request.json

# In place of: agent-browser network har stop evidence.har
/app/skills/agent-browser/scripts/ab-net-redact.sh har-stop evidence.har.json
```

Which URLs may keep their body is install config, not this skill's call — see
`AB_NET_REDACT_ALLOW_FILE` in the script's own header comment.

`har-stop` records to a private temp file, redacts it, and only then moves the
redacted result to the path you gave — the raw HAR never lands at a durable
path, not even briefly. A capture kept only in the model's own context (never
written to a file, chat, log, or shared path) is not covered by this — the
requirement is about what touches disk or leaves the container.

### JavaScript

```bash
agent-browser eval "document.title"   # Run JavaScript
```

## Example: Form submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Example: Data extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e1  # Get product title
agent-browser get attr @e2 href  # Get link URL
agent-browser screenshot products.png
```
