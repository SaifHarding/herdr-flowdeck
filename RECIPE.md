# Flowdeck for n8n

A pane that connects to an n8n instance (with an API key, or an MCP token) and shows how it's doing. There's an overview of the last day, every workflow drawn as a live graph with any run laid over it, a week of failures grouped by cause, and a box for asking Claude about any of it. A toast fires the moment a run fails. A demo mode with a made-up instance lets people try it before connecting anything.

![Flowdeck for n8n](preview.png)

## What you see

The mod fills its pane (a tab: `tab.new {name: "n8n", mod: "flowdeck"}`). Every surface colour is the theme's (`canvas` behind, `surface` for cards, `chrome` for the header and side lists, `border`, `foreground`, `muted`, `dim`, `hover`, `raised`). Flowdeck's own colours are below; in light themes the darker value in brackets is used.

- Brand coral: `#ff7a5c` (`#e8553b`), with hover `#ffb35c`.
- Ok `#3fb950` (`#1a7f37`), error `#ff5d5d` (`#cf222e`), warning `#e3b341` (`#9a6700`) and running `#58a6ff` (`#0969da`).
- Node kinds: trigger `#ff8a4c`, flow `#9aa5bd`, code `#f2c14e`, HTTP `#4cc9f0`, AI `#c084fc`, data `#5b8def`, message `#3ddc84`, email `#2dd4bf`, other apps `#8b93ff`.

**Connect screen** (when no instance is connected). Behind everything, three soft lights drift slowly. Each is three concentric discs at 3.5–5% opacity, in coral, violet `#8b5cf6` and cyan `#22d3ee`. Centred in a 500 px column:

- A 52 px coral tile with the Flowdeck glyph, the title "Connect your n8n" at 24 px semibold, and a one-line pitch.
- A 16 px-rounded card holding:
  - A segmented control: API key | MCP token.
  - Three 38 px fields: instance address, the key (masked, with an eye toggle) and an optional name.
  - A switch: "Remember in macOS Keychain" (or "your system keyring"; disabled when neither exists).
  - Error and warning lines.
  - A coral Connect button and "Try with demo data".
  - Two lines on where to find the key.
- Under the card, three trust points with icons: Keys stay local, Read-only, You choose.

**Header** (52 px, `chrome`), left to right:

- A 30 px coral logo tile, "Flowdeck", and the instance name. A pulsing green dot shows it's live (amber on error). An API, MCP or DEMO tag follows, and a chevron opens the instance menu.
- Centred pill tabs: Overview, Workflows, Failures (with a red count of new failure groups) and Ask Claude.
- On the right: "Synced 12s ago", a refresh button (it spins while syncing), and a gear button that opens the menu.
- Below 980 px wide, the tabs show icons only.

**Instance menu** (310 px popover, top right): the instances with their address, mode and key tail (✓ on the current one), the demo instance, "Connect another instance", a read-only note, where the key is kept, and "Disconnect and forget key" in red.

**Overview**, scrolling:

- A greeting with a summary line.
- Five 150 px+ KPI tiles: runs in 24h (Δ vs the 24h before), success rate (with a 40 px ring: green ≥97%, amber ≥85%, red below), failures in 24h (green when down), median run time, and active/total workflows.
- An Activity card: 24 hourly stacked bars (failed red on top of running blue on top of ok green), 120 px tall, or 28 six-hour bars for 7 days. Bars grow up from zero with a 14 ms stagger. Hovering one shows its counts in the subtitle.
- A 340 px "Busiest today" card: the top 6 workflows by runs, with bars that grow in (amber when the workflow failed today).
- "Needs attention": the top 5 failure groups, each with an icon for the kind of fault, workflow › node, the message, a 14-bin sparkline, and count · age.
- "Live runs": the latest 11 executions, with a status dot (pulsing while running), name, mode, duration and age.

**Workflows**:

- A 318 px list: search (name, tag, node name or type), chips for All / Active / Failing, then rows. Each row has a health dot, the name, a red failures-today badge, "trigger · N nodes · last run", and a 14-bar run strip. Bars are coloured by status, and taller bars mean slower runs.
- The main area has a header (name, Active pill, trigger, node count, tags, "edited …", Ask about this, Open in n8n).
- Under it, the runs bar: "RUNS · 7 DAYS", a 48-run strip whose bars can be clicked, the selected run's status, time, node count and duration, and Replay.
- Then the graph canvas (`canvas`, with a dot grid that moves with it). Node cards are 184×58, 11 px corners, with a 32 px tinted kind tile, the name at 12.5 px semibold and the type at 10.5 px `dim`. AI sub-nodes are 136×40 pills. Triggers have a small bolt disc on their left edge.
- Main connections are curves from the right side to the left side, with arrowheads. Multi-output nodes label their ports (true/false, done/loop). AI connections are dashed and rise into the agent's bottom edge.
- At the bottom right are zoom − % + and fit. At the bottom left is a legend. A node inspector (320 px) opens on the right when a node is clicked.

**Failures**:

- A 410 px list of groups: a fault-kind icon, the workflow, "at node", the message, a red count pill, a sparkline and the age. Chips switch between the last 7 days and the last 24h.
- The detail pane has the title "workflow › node" (node in red), "Explain with Claude", "Show in graph" and Open run.
- Below that come a tinted hint card, the "What n8n said" card (message at 14 px, description in a monospace well, HTTP code tag), a 330 px card with the graph of the latest failing run, and "When it happened": 28 six-hour bars plus the 8 latest runs.

**Flo**, the focus sprite (`sprite/flo-r.svg`, `flo-l.svg`): a 16×16 pixel-art bot, drawn with `image()` at 30–52 px depending on zoom. Its body is coral `#ff7a5c` with shade `#d94f37`, outline `#2b1d33`, a cream screen face `#fff4ea` with 2×2 eyes and pink cheeks `#ff8fa3`, and a yellow antenna `#ffd36e` with a soft breathing glow. It stands on the middle of a node card's top edge with a shadow on the edge under it. While it's idle it bobs 2.5 px every 1.1 s; while thinking it bobs 4 px every 0.52 s. Its bubbles: thinking dots in a coral-bordered pill, a red "!" pill (pulsing) on a failure, or a green ✓.

**Ask Claude**, a centred 860 px column (780 px with the focus panel):

- A question card: scope chips (All workflows, the selected workflow, or the failure), an auto-growing textarea with a send button (stop while answering), a privacy note, and a model picker (Haiku, Sonnet, Opus).
- Before the first question, a consent card says exactly what is sent and what never is.
- When the question is about one workflow or failure (or Claude names a workflow), a "Claude's focus" panel sits on the right: 440 px wide, or 360 px below 1,320 px of pane width, and hidden below 960 px. It has a header with a live dot and the workflow name, that workflow's graph with Flo on it, and a caption: "Looking at **node**" with a step counter such as `4/11`.
- Answers are cards, newest first, each under its question bubble. While waiting they show "Reading your workflows" with animated dots, then markdown that types itself out with a ▍ cursor. Each answer ends with its time and cost.

## How it behaves

- **Sync.** On open it fetches all workflows and the last 7 days of executions, paginated. Every 30 s it fetches the newest 100 executions; every 5 minutes it does a full sync. After a 429 it waits 2 minutes. Error details load in the background: the newest 60 first, then in batches of 60 up to 300, 3 at a time.
- **Alerts.** A newly failed run fires a Herdr toast, `level: "error"`, with the workflow, node and error. Clicking it runs `tab.select` on Flowdeck's tab. Every copy shares a high-water mark of execution ids in `shared("flowdeck.alerted")`, so each failure alerts once. The first load never alerts on history.
- **Run overlay.** Picking a run lays it over the graph. Nodes that ran get a green ring and a ✓ badge. The failing node gets a red ring, a ✕ badge and a breathing red halo. Nodes the run didn't reach fade to 40%. Travelled edges glow green with a slow pulse, and the edge into the failing node pulses red. With no run selected, an active workflow's edges shimmer coral.
- **Replay** steps through the run's node order every 520 ms. The next node shows a spinner badge, and a "Replaying · n of N" chip sits top left.
- **Flo** moves with a bouncy spring (response 620 ms, damping 0.6) and turns to face where it's going.
  - In Workflows: on the replay's current node (thinking); with a run selected, on the failing node ("!") or the last node (✓); on a clicked node; else on the trigger.
  - In Failures: on the failing node.
  - In Ask: Flo walks the nodes in the order Claude's answer names them (`mentionsInOrder`, repeats in a row collapsed), one hop every 700 ms, so the tour plays out even when the text arrives in one burst. The panel's camera centres Flo's node at a readable zoom (55–90%) and glides after it until the person pans.
- **Graph.** Drag to pan. Scroll pans; ⌘/Ctrl-scroll zooms around the pointer (25–200%). The buttons zoom by 1.2×, and fit springs to fit. Until you pan or zoom, the graph refits whenever the pane resizes. Clicking a node opens the inspector, and clicking the background closes it.
- **Hints** read the error: 401/403, expired or "credentials" → auth; 429 or "rate limit" → rate; timeouts and connection resets → network; "cannot read properties", TypeError → code; 5xx → server; "not found" → missing.
- **Ask.** It runs `claude -p` in the background with no tools, streaming `stream-json` that is read every 160 ms. Stop kills only that process. The answer is cut off after 4 minutes.
- **Entrances.** Every view rises 8 px and fades in, staggered 40–60 ms. Bars and meters grow from zero. All motion is native (`.transition`, `.spring`, `.loop`, `.spin`, `.frames`); timers only fetch data, and replay steps once per node.
- **Keys** (`flowdeck.<command>`): `overview`, `workflows`, `failures`, `ask`, `ask-about`, `refresh`, `demo`, `next`, `prev`, `replay`.

## Built from

- `mod.json`: `{ "place": "none", "title": "Flowdeck", "overlay": { "kind": "dialog", "width": 0.94, "height": 0.92 } }`. In a dialog, a header button pops it out to a tab.
- `main.js` holds the view, profiles, sync, alerts, navigation, the header and the menu. The other files:
  - `n8n.js`: the REST client, MCP client (streamable HTTP, JSON or SSE answers) and demo source.
  - `vault.js`: the keychain.
  - `claude.js`: the Claude Code runner.
  - `model.js`: pure logic covering node kinds, URL and key rules, redaction, stats, grouping, hints, graph layout and the Claude context.
  - `graph.js`: the graph.
  - `ui.js`: parts and motion.
  - One file per view: `connect.js`, `overview.js`, `workflows.js`, `failures.js`, `ask.js`.
  - `demo.js`: the made-up instance.
  - `icons/`: 16 px stroke SVGs, tinted.
  - `sprite/`: Flo, in two facings.
- From `herdr`: `exec`, `readTextFile`, `shared`/`setShared`, `notify`, `panes` (to find its own tab for the toast), `props`, `closeOverlay`, `run` (`tab.new`, `tab.select`), `nextCommand` and `appHome`. From gpui: `PathBuilder` + `window.paint_path` for edges, arrows, the dot grid and the ring; `Input`/`InputState` and `Textarea`/`TextareaState`; and `TextView.markdown`.
- Programs: `security` (macOS) or `secret-tool` (Linux); `claude`; `open`, `xdg-open` or `rundll32`; `mkdir`, `chmod`, `rm`, `find`, `pkill`.
- n8n endpoints: `GET /api/v1/workflows`, `GET /api/v1/executions`, `GET /api/v1/executions/:id?includeData=true`, and `POST /mcp-server/http` (`initialize`, `tools/call` for `search_workflows` and `get_workflow_details`).

## Watch out

- `InputState`, `Input`, `TextareaState`, `Textarea` and `TextView` come from `gpui-base`, not `gpui-kit`. The runtime says "Could not find export".
- `"transparent"` isn't a colour; use `#00000000`.
- `h_flex()` centres its children vertically. Rows of cards with different heights need `.items_start()`, and a canvas beside an inspector needs `.items_stretch()` and `.h_full()`, or it collapses to its content height.
- A graph fitted on the first `on_size_change` fits a pane that hasn't settled yet. Keep refitting until the person moves it.
- `node --check file.js` doesn't parse ES modules: copy a file to `.mjs` to syntax-check it. Herdr's parse errors can point at the wrong line.
- Herdr docks a copy of any new mod folder into the shown layout the first time it sees it, unless `mod.json` already says `"place": "none"`. Write `mod.json` first.
- Herdr's `fetch` has no timeout option (it gives up after about 30 s), no response headers and no redirect option. It refuses cross-origin redirects that would replay caller headers, which is what keeps the key safe.
- `exec` has no stdin and a 30 s limit, so secrets and prompts go through a private file. Claude runs in the background, and its stream is read from a file.
- n8n's MCP server has no executions: Failures shows a "needs an API key" screen in MCP mode.
- Hard limits: 1,000 workflows, 3,000 executions, 300 failure details, 400 rows in the list and 6 MiB per answer.
- Platform names from `os.platform()` are `macos`, `linux` and `windows`.

## Done when

- `herdr-app check mods/flowdeck` passes and `node --test tests/` passes (12 tests).
- "Try with demo data" shows the Overview with numbers, bars that grow in, and a live feed.
- On Workflows, "Stripe → HubSpot deal sync" shows its latest failed run: Stripe Trigger, Big deal? and Create deal ringed green, Notify #sales red and pulsing, Update contact faded. Replay walks it node by node.
- Asking "Walk me through what this workflow does, node by node" about Lead enrichment makes Flo walk Form submitted → Enrich company → … in the order the answer names them, with the counter counting up.
- "Support ticket triage (AI)" draws OpenAI model and Ticket memory as pills with dashed lines into the agent's bottom edge.
- Failures shows the "Lead enrichment › Enrich company" group with the auth hint. Explain with Claude streams an answer that mentions the expired key and never shows `sk_live_4f9a8b7c6d5e4f3a2b1c` (the planted secret).
- Against `tools/mock-n8n.mjs`, a wrong key gives "n8n refused the key", and `/redirect-test` gives the redirect refusal with no LEAK line in the port 5680 log.
- After connecting, `security find-generic-password -s herdr.flowdeck` finds the key and `shared.json` has no key in it. Disconnect removes both.
