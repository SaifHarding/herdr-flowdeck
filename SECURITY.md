# Flowdeck security model

Flowdeck handles a credential that can read everything in an n8n instance. This file says where that credential and your workflow data go, and what stops them going anywhere else.

## The key

- **Where it's kept.** On macOS it goes in the login Keychain as a generic password: service `herdr.flowdeck`, account the profile id, label "Flowdeck for n8n". On Linux it goes in the Secret Service through `secret-tool` (GNOME Keyring or KWallet). Elsewhere, or with "Remember" off, it goes in Herdr's in-memory `sessionStorage` and is gone when Herdr quits.
- **How it gets there.** A key is never put on a command line, where `ps` would show it to other users. Flowdeck writes it to a randomly named file (mode 600) inside `~/.config/herdr-app/.flowdeck` (mode 700). The keychain tool reads it from stdin (`security -i`, `secret-tool store`) and the file is deleted in the same shell command, with a second delete afterwards in case the first failed. Leftover files older than 10 minutes are swept when Flowdeck starts.
- **What it may look like.** Only `[A-Za-z0-9._-]`, 20 to 4096 characters, which covers n8n's JWT keys and tokens. This also means it never needs quoting in the keychain command.
- **What's stored in the open.** In Herdr's `shared.json`: the profile's name, base URL, mode (API or MCP), the key's last 4 characters, and where the key is kept. Never the key itself.
- **Forgetting it.** "Disconnect and forget key" deletes the keychain item and the profile.

## The network

- **One destination.** Requests go only to the base URL you entered. Herdr's `fetch` refuses a cross-origin redirect that would replay a caller-supplied header such as `X-N8N-API-KEY`. Flowdeck also checks that every response's final URL has the instance's origin, and discards it if not.
- **Encryption.** `https://` is required for every public host. `http://` is accepted only for loopback, RFC 1918, link-local and CGNAT (Tailscale) addresses, and for `*.local`, `*.lan`, `*.internal`, `*.home.arpa`, `*.ts.net` and `host.docker.internal`. Flowdeck shows a warning when it's used. URLs with a user name or password in them are refused.
- **Read-only.** REST: only `GET /api/v1/workflows`, `GET /api/v1/executions` and `GET /api/v1/executions/:id`. Execution ids are checked against `[A-Za-z0-9_-]{1,64}` before they go into a path. MCP: `initialize`, `tools/call` for `search_workflows` and `get_workflow_details`, and nothing else. A call to any other tool throws before a request is made.
- **Bounded.** At most 1,000 workflows, 3,000 executions (7 days), 300 failure details and 6 MiB per response. Failure details are fetched 3 at a time, and polling backs off on HTTP 429.

## Your workflow data

- **Kept in memory only**, inside the pane's process, and dropped when you switch instance or close the pane.
- **Run payloads aren't kept.** From an execution's details Flowdeck keeps the error message, its description, the failing node and the order nodes ran in. The items that flowed through the run (customer data, for instance) are dropped as soon as the response is read.
- **Shown as text.** n8n's data is drawn as native text, never as HTML or markdown, so a workflow can't inject UI.

## Asking Claude

- **Consent.** Nothing goes to Claude until you've seen what will be sent and said yes. The note under the question box repeats it.
- **What's sent.** For "All workflows": names, node types, triggers, run and failure counts, and recent error messages. For one workflow: its nodes, their parameters and connections, and its recent errors.
- **What's never sent.** Credentials (n8n doesn't include them in workflow JSON anyway; Flowdeck sends only the credential *type* name), pinned data, and execution items.
- **What's masked.** Before anything leaves, parameters go through `redact()`. Fields whose names look like secrets (password, token, apiKey, authorization, secret, cookie, signature, private key…) are replaced with `[redacted]`. So are `{ name, value }` header pairs with such names, strings that look like keys (`sk-…`, `xox…-`, `ghp_…`, `AKIA…`, `AIza…`, JWTs, `Bearer …`, long hex, PEM private keys), credentials inside URLs (`user:pass@`, `?api_key=`), and the same patterns inside error messages. Long text is cut. `tests/model.test.js` checks this against the demo's planted secret.
- **How Claude runs.** `claude -p --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands`, from Flowdeck's private folder. That means no tools, no MCP servers, no user, project or local settings (so no hooks), and no saved session. The prompt goes in on stdin from a mode-600 file that is deleted when Claude finishes. The model is one of three fixed names.
- **Prompt injection.** Workflow text is wrapped in a data block. Any text inside it that tries to close that block is defused, and the system prompt tells Claude to treat it as data. Claude has no tools, so the worst a malicious workflow can do is make the answer wrong. Links in answers open only if they point at your own instance or n8n's docs.

## Reporting a problem

Please open a private security advisory on the GitHub repository rather than a public issue.
