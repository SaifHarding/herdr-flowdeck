# Flowdeck security model

Flowdeck handles a credential that can read everything in an n8n instance. This file says where that credential and your workflow data go, what stops them going anywhere else, and where the limits are.

## The key

- **Where it's kept.** On macOS it goes in the login Keychain, as a generic password with service `herdr.flowdeck`. On Linux it goes in the Secret Service through `secret-tool`. Elsewhere, or with "Remember" off, it goes in Herdr's in-memory `sessionStorage` and is gone when Herdr quits.
- **Who can read it.** The keychain encrypts the key at rest, and it is never written to a file, a setting, a log or a command line. A program already running as you can still ask the keychain for it, as with any keychain item created by a command-line tool. Flowdeck doesn't claim per-app protection.
- **Bound to its instance.** The keychain account is `<profile id>@<instance origin>`. Profiles live in Herdr's shared state, which any mod can write. If one is edited to point somewhere else, the lookup finds no key, so the key can't be redirected. Every saved address is also checked again, against the same rules as the connect form, each time it loads.
- **How it gets there.** A key is never put on a command line, where `ps` would show it.
  - Flowdeck writes it to a random file inside `~/.config/herdr-app/.flowdeck` and sets the file to mode 600. Before writing anything, it confirms the folder is mode 700, owned by you, and isn't a symlink.
  - The keychain tool reads the key from stdin (`security -i`, `secret-tool store`), and the file is deleted in the same shell command and again afterwards.
  - Leftovers older than 10 minutes are swept when Flowdeck starts.
- **What it may look like.** Only `[A-Za-z0-9._-]`, 20 to 4096 characters, so it never needs quoting.
- **What's stored in the open** (Herdr's `shared.json`): the profile's name, base URL, mode, the key's last 4 characters, where the key is kept, and whether plain http was allowed. Never the key itself.
- **Forgetting it.** "Disconnect and forget key" deletes the keychain item, the profile and its bookkeeping.

## The network

- **One destination.** Requests go only to the instance's base URL. Herdr's `fetch` refuses a cross-origin redirect that would replay a caller-supplied header such as `X-N8N-API-KEY`. Flowdeck also discards any response whose final URL has a different origin.
- **Encryption.**
  - Public hosts must use `https://`.
  - Plain `http://` is accepted without asking only for this machine (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `host.docker.internal`).
  - Plain http to a private network (RFC 1918, link-local, 100.64/10, `*.local`, `*.lan`, `*.internal`, `*.home.arpa`, `*.ts.net`) needs an explicit "Allow plain http on this network" opt-in. After that, the header shows an amber **HTTP** badge for as long as the instance is used, because a laptop carries a home address like `192.168.1.50` to every café whose network uses the same range.
  - Cloud metadata addresses are refused, and so are URLs with a user name or password in them.
- **Read-only.** Only `GET /api/v1/workflows`, `GET /api/v1/executions` and `GET /api/v1/executions/:id`, with execution ids checked against `[A-Za-z0-9_-]{1,64}`.
- **Bounded.**
  - Paging stops after 20 pages, on an empty page, or on a cursor the server already gave.
  - Lists are cut to 1,000 workflows and 3,000 executions (7 days), with 250 items a page.
  - Failure details stop at 300, fetched 3 at a time. Graphs lay out at most 300 nodes.
  - Responses over 6 MiB (8 MiB for one execution) are refused, and error bodies are cut to 4 KB before parsing.
  - Executions and workflow pages are read lean: a walker over the JSON text builds only the fields Flowdeck shows. Run items, pinned data and static data are stepped over and never become objects. Every mod shares one JavaScript heap, so a full parse of a busy AI workflow's run could exhaust it for all of Herdr.
  - After an HTTP 429, everything waits: the refresh for 2 minutes, and failure details for a minute.
- **Redaction can't be hung.** Text is cut to its display length before any pattern runs, and every pattern has bounded repetition. A multi-megabyte error crafted to make a regex backtrack is handled in milliseconds (a test covers this).

## Your workflow data

- **In memory only**, in the pane's process, and dropped when you switch instance or close the pane.
- **Run payloads aren't kept.** From an execution's details, Flowdeck keeps the error message, the description, the failing node and the order nodes ran in. The items that flowed through the run are dropped as soon as the response is read.
- **Searching runs for quoted text.** When a question quotes something (`"…"`), Flowdeck reads the newest runs one at a time, up to 50 (of the workflow asked about, else of the instance), as raw text. It checks each for the quote and drops it. Nothing from them is kept or sent.
- **n8n's data is drawn as text.** Names, errors and parameters are native text, never HTML or markdown.
- **Claude's answers are drawn as markdown, made safe first.** Images, raw HTML tags and link reference definitions are removed before an answer is rendered, outside code blocks. That's because an image would load without a click, which would make it a silent way to send data out. Links in an answer open only if they point at your instance's workflow or execution pages, or at docs.n8n.io. Webhook and form URLs, which a click would run, don't open.

## Asking Claude

- **Consent per instance and per scope.** The first question about one workflow or failure on an instance asks first. The first question about "all workflows" on that instance asks again. "See exactly what's sent" shows the full context, word for word, before you say yes.
- **What's sent.**
  - For "All workflows": names, node types, triggers, run and failure counts, and recent error messages.
  - For one workflow: its nodes, their parameters and connections, and its recent errors.
- **What's never sent.** Credentials (Flowdeck sends only the credential *type* name) and pinned data.
- **Run data, only when you say yes, one question at a time.** If a search finds the run a question is about, the answer card asks before anything from it is sent: "Send run data" or "Answer without it". On yes, Claude gets each node's status and timing, plus the first two items of each node's output, masked like everything else and capped at 40 KB. Nothing else from the run goes, and the yes isn't remembered.
- **What's masked.** Before anything leaves, `redact()` replaces with `[redacted]`:
  - everything under a key named like a secret, whatever its shape (password, token, key, apiKey, auth…, secret, cookie, signature, private key, session, subscription, dsn, webhookUrl…)
  - `{ name, value }` header and query pairs with such names
  - JSON held inside strings (it's parsed and masked)
  - assignments like `apiKey = "…"` in code
  - vendor key formats: `sk-`/`rk-`/`pk-`, `xox…-`, `xapp-`, `ghp_`, `github_pat_`, `glpat-`, `AKIA`/`ASIA`, `AIza`, `SG.`, `shpat_`, `secret_`, `ntn_`, `whsec_`
  - JWTs, `Bearer`/`Basic`/`Token` values, hex of 32 characters or more, and PEM private keys, ended or not
  - Slack, Discord, Telegram and Teams webhook URLs, URL user parts (DSNs), and secret-named query parameters
  - any 24+ character token that mixes letters and digits like a key
  - webhook and form paths

  `tests/model.test.js` checks each of these. **The limit:** masking works by pattern, so a secret in a format no rule recognises can get through. If a workflow holds secrets in its parameters, check the preview before saying yes. Better still, move them into n8n credentials, which never leave n8n.
- **How Claude runs.** `claude -p --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands`, from Flowdeck's private folder. That means no built-in tools, no MCP servers or connectors, no user, project or local settings (so no hooks), and no saved session. The prompt goes in on stdin from a mode-600 file that is deleted when Claude finishes, and the model is one of three fixed names.
- **Prompt injection.** Workflow text and earlier answers go inside blocks whose tags carry a random suffix for each question. Tag-like text naming those blocks is defused too, including spacing, full-width and zero-width tricks. The system prompt tells Claude to treat the block as data and never to output images, HTML or outside links. With no tools, the worst a hostile workflow can do is make an answer wrong. The rendering rules above stop it using the answer to send data out or to run a webhook.

## Reporting a problem

Please open a private security advisory on the GitHub repository rather than a public issue.
