# Flowdeck for n8n

Your n8n instance in a [Herdr](https://herdr.dev) pane. Connect it with an API key and you get:

- **Overview**: how the instance is doing right now. Runs, success rate, failures and median duration over 24 hours, compared with yesterday. An hour-by-hour activity chart (or day by day for the week), the busiest workflows, what needs attention, and a live feed of runs as they land.
- **Workflows**: every workflow drawn as a live graph, laid out the way you arranged it in n8n. Pick any run from the strip above the graph and its path lights up: green for nodes that ran, red and pulsing for the one that failed, faded for nodes the run never reached. Replay walks a run node by node. Click a node to inspect its settings, with secrets hidden. Pan as in n8n: hold the scroll wheel and drag (or drag empty canvas), and ⌘/Ctrl-scroll to zoom.
- **Failures**: a week of failures, grouped by workflow, node and error, so a run that failed 200 times is one line. Each group shows what n8n said, a first idea of why (expired credential, rate limit, timeout, bad data in a Code node, and so on), where it broke on the graph, and when it happened.
- **Ask Claude**: ask about the whole instance, one workflow or one failure: "Why is this failing?", "Which workflows haven't run this week?", "What does this one do, step by step?". The answer streams in through your own Claude Code. Quote a title, ID or email from a run (`"Weekly Billing Digest…" came out blank`) and Flowdeck finds that run. If you agree, it lets Claude see what each node produced. Then **Look further** checks the run before or after it, or the same text in other workflows. Ask from the Ask tab, or dock Claude beside the graph ("Ask about this", or "Explain with Claude" on a failure) and fold the workflow list into a rail to give the graph room.
- **Focus sprites**: a pixel-art sprite marks the node that has the attention, and travels the real edge when the attention moves. Pick one in the instance menu (or `flowdeck.sprite-<name>`):
  - **Probe** (the default): a drone hovers over the node and scans it, its eye following the scan line. It flies along the wire with its thrusters lit.
  - **Goose**: stands on the node and pecks it. Every third stop it honks and the node shakes. It walks off the card and waddles along the wire.
  - **Brackets**: orange corner brackets breathe around the node, shrink to a dot that runs along the wire, and open around the next.
  - **Flo**: the little coral bot.
  - **Off**: no sprite.

  "Motion" follows the system's reduce-motion setting. Set it to Reduce and sprites jump straight to the node and hold still.
- **Flo, and what every sprite follows**: whatever sprite you pick stands wherever the attention is. On a replay Flo hops node to node as the run plays, standing on the failing node with a red "!" (or a green ✓ when it finished). While Claude answers, Flo walks the graph in the order Claude names the nodes, and a scanning beam sweeps each one. When the answer is in, Flo goes to the node it blames, raises a red "!", and pins a pulsing **Likely cause** flag to it.
- **Chat history**: past Ask Claude conversations per instance, kept in Flowdeck's private folder on your machine. Reopen one to carry on, or delete it.
- **Alerts**: a Herdr toast the moment a run fails, with the failing node and the error. Clicking it brings you to Flowdeck.

There's a demo mode with a made-up instance, so you can try it before connecting anything.

![Workflows](preview.png)

| Overview | Failures | Ask Claude, with Flo following the answer |
|---|---|---|
| ![Overview](docs/overview.png) | ![Failures](docs/failures.png) | ![Claude's focus](docs/ask-focus.png) |

## Install

Ask your agent: *"add the Herdr mod at github.com/SaifHarding/herdr-flowdeck"*. Or by hand:

```sh
cp -r mods/flowdeck ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/flowdeck
herdr-app do tab.new --name n8n --mod flowdeck
```

For a quick look without a tab, `mod.open:flowdeck` opens it as a large dialog, with a button that pops it out to a tab.

### A button in your header (optional)

Put a small Flowdeck button in any bar of your layout. It goes to your Flowdeck tab, or opens one, and shows a red badge with the number of new failure causes. Add this block to a row, such as the one beside your tabs. Clone a shipped layout first (`herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`), because Herdr's own layouts are read-only:

```json
{ "id": "flowdeck-bar", "type": "block", "content": { "mod": "flowdeck", "props": { "bar": true } }, "size": { "px": 48 } }
```

The button syncs nothing itself; it reads the badge that an open Flowdeck tab publishes.

**Before you add it:** Flowdeck reaches the network (only your n8n address). It runs programs: `security` or `secret-tool` for the keychain, `claude` when you ask a question, and `open`/`xdg-open` for links. It reads and writes one private folder, `~/.config/herdr-app/.flowdeck` (mode 700), for a few seconds at a time. [SECURITY.md](SECURITY.md) covers each of these.

### Keys (optional)

Merge [keys.json](keys.json) into `~/.config/herdr-app/keys.json`:

- `ctrl-shift-n` opens Flowdeck in a new tab.
- While Flowdeck has focus: `ctrl-b` folds the workflow list. `ctrl-1` to `ctrl-4` switch views, `ctrl-r` refreshes, `ctrl-j`/`ctrl-k` move to the next or previous workflow or failure, `ctrl-shift-r` replays the selected run, and `ctrl-shift-a` docks Claude beside the selected workflow.

## Connecting

In n8n, open **Settings → n8n API** and create an API key; Flowdeck sends it as the `X-N8N-API-KEY` header.

The address can be an n8n Cloud one (`https://you.app.n8n.cloud`) or self-hosted. Paste it however you copied it: `/home/workflows`, `/api/v1` and the like are trimmed off. Public addresses must be `https://`. Plain `http://` works for this machine (`localhost`). For a private network (`192.168.x.x`, `*.local`, Tailscale), you have to tick "Allow plain http on this network", and an amber HTTP badge stays in the header from then on.

You can connect several instances (production and staging, say) and switch between them from the instance menu in the header.

## Security, in short

- **Keys live in the macOS Keychain** or the Linux system keyring (GNOME Keyring or KWallet, through `secret-tool`). Where there's neither, a key lasts only until Herdr quits. A key is never written to settings, shared state, logs or a command line. Each key is tied to its instance's address, so it can't be redirected.
- **Read-only.** Flowdeck only ever sends GET requests to n8n's REST API.
- **Your key goes only to your instance.** Herdr refuses to replay a key across a redirect to another host, and Flowdeck rejects any answer that came from a different address.
- **Claude sees only what you ask about, after you've said yes for that instance and scope.** "See exactly what's sent" shows the context word for word. It gets workflow structure and error messages. It never gets credentials or pinned data. When a question quotes something ("why is the article "…" blank?"), Flowdeck finds the run that produced it. It only sends what that run's nodes output (the first two items each, masked) after you click "Send run data", one question at a time. Secrets in parameters, headers, bodies, URLs and code are masked first, by pattern, so check the preview if your workflows keep secrets outside n8n credentials. Claude runs with every tool, MCP server, hook and setting turned off. Answers are drawn without images or HTML, and their links only open your own workflow pages or n8n's docs.
- **Run data stays in memory** while the pane is open. Nothing about your workflows is written to disk.

Full details: [SECURITY.md](SECURITY.md).

## Requirements

- Herdr 0.1.13 (the version it was built and tested on).
- For Ask Claude: [Claude Code](https://claude.com/claude-code), signed in once with `claude`. Everything else works without it.
- On Linux, `secret-tool` (package `libsecret-tools`) to remember keys.

## Developing

```sh
node --test tests/*.test.js           # model, redaction, layout, URL and paging rules
node tools/mock-n8n.mjs 5679 &        # a fake n8n: REST API and a redirect trap
node tools/mock-n8n.mjs 5680 &        # catches any key that follows a redirect (logs LEAK)
```

The mock server's API key is `demo-key-0123456789abcdef`. Connect to `http://127.0.0.1:5679`.

Herdr's `herdr-app check` catches what the runtime refuses, but a `.js` file isn't syntax-checked by `node --check` (it treats it as CommonJS and skips it). Copy a file to `.mjs` to check it with Node.

## Licence

MIT, for Flowdeck's own code and art. The n8n mark (`mods/flowdeck/icons/n8n.svg`, taken from n8n's design system) is a trademark of n8n GmbH. Flowdeck uses it only to show where it's talking about n8n. Flowdeck is an independent project and isn't affiliated with or endorsed by n8n.
