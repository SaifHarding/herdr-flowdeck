// A made-up n8n instance, shaped exactly like n8n's public API answers it: the "Try the demo" mode draws from it, and
// so does the test server in tools/. Nothing here is real data. No imports, so it runs under node as well.

const HOUR = 3600e3, DAY = 24 * HOUR;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [name, type, x, y, parameters?]; edges: [from, to, output = 0, type = "main"]
function wf(id, name, active, tags, nodes, edges, extra = {}) {
  const connections = {};
  for (const [from, to, output = 0, type = "main"] of edges) {
    const byType = (connections[from] ??= {});
    const outs = (byType[type] ??= []);
    while (outs.length <= output) outs.push([]);
    outs[output].push({ node: to, type, index: 0 });
  }
  return {
    id, name, active,
    createdAt: "2026-06-02T09:14:00.000Z",
    updatedAt: extra.updatedAt ?? "2026-10-28T16:40:00.000Z",
    isArchived: false,
    tags: tags.map((t, i) => ({ id: `tag${i}${t.length}`, name: t })),
    nodes: nodes.map(([n, type, x, y, parameters = {}], i) => ({
      id: `${id}-n${i}`, name: n, type, typeVersion: 1, position: [x, y], parameters,
      ...(type.includes("Trigger") || type.endsWith("webhook") ? { webhookId: undefined } : {}),
    })),
    connections,
    settings: { executionOrder: "v1", errorWorkflow: id === "wf-errors" ? undefined : "wf-errors" },
  };
}

const B = "n8n-nodes-base.", L = "@n8n/n8n-nodes-langchain.";

export const DEMO_WORKFLOWS = [
  wf("wf-stripe", "Stripe → HubSpot deal sync", true, ["sales", "billing"], [
    ["Stripe Trigger", B + "stripeTrigger", 0, 300, { events: ["invoice.paid"] }],
    ["Big deal?", B + "if", 240, 300, { conditions: { number: [{ value1: "={{ $json.amount }}", operation: "larger", value2: 100000 }] } }],
    ["Create deal", B + "hubspot", 480, 200, { resource: "deal", operation: "create", stage: "closedwon" }],
    ["Update contact", B + "hubspot", 480, 400, { resource: "contact", operation: "upsert" }],
    ["Notify #sales", B + "slack", 720, 200, { channel: "#sales", text: "=🎉 {{ $json.customer }} paid {{ $json.amount / 100 }}" }],
  ], [["Stripe Trigger", "Big deal?"], ["Big deal?", "Create deal", 0], ["Big deal?", "Update contact", 1], ["Create deal", "Notify #sales"]]),

  wf("wf-digest", "Daily sales digest", true, ["sales", "reports"], [
    ["Every morning", B + "scheduleTrigger", 0, 300, { rule: { interval: [{ field: "cronExpression", expression: "0 8 * * 1-5" }] } }],
    ["Yesterday's orders", B + "postgres", 240, 300, { operation: "executeQuery", query: "select * from orders where created_at > now() - interval '1 day'" }],
    ["Summarise", B + "code", 480, 300, { jsCode: "const total = $input.all().reduce((s, i) => s + i.json.amount, 0);\nreturn [{ json: { total, count: $input.all().length } }];" }],
    ["Email the team", B + "gmail", 720, 300, { sendTo: "team@example.com", subject: "=Sales for {{ $now.minus(1, 'day').toFormat('DDD') }}" }],
  ], [["Every morning", "Yesterday's orders"], ["Yesterday's orders", "Summarise"], ["Summarise", "Email the team"]]),

  wf("wf-leads", "Lead enrichment", true, ["marketing"], [
    ["Form submitted", B + "webhook", 0, 300, { path: "lead", httpMethod: "POST" }],
    ["Enrich company", B + "httpRequest", 240, 200, { url: "https://api.enrich.example.com/v2/companies/find", authentication: "genericCredentialType", headerParameters: { parameters: [{ name: "Authorization", value: "Bearer sk_live_4f9a8b7c6d5e4f3a2b1c" }] } }],
    ["Score lead", B + "code", 240, 400, { jsCode: "return items.map(i => ({ json: { ...i.json, score: i.json.employees > 200 ? 'A' : 'B' } }));" }],
    ["Merge", B + "merge", 480, 300, { mode: "combine", combineBy: "combineByPosition" }],
    ["Save to Airtable", B + "airtable", 720, 300, { operation: "create", base: "appLeads", table: "Leads" }],
    ["Reply", B + "respondToWebhook", 960, 300, { respondWith: "json" }],
  ], [["Form submitted", "Enrich company"], ["Form submitted", "Score lead"], ["Enrich company", "Merge"], ["Score lead", "Merge"], ["Merge", "Save to Airtable"], ["Save to Airtable", "Reply"]]),

  wf("wf-triage", "Support ticket triage (AI)", true, ["support", "ai"], [
    ["New conversation", B + "intercomTrigger", 0, 300, {}],
    ["Triage agent", L + "agent", 260, 300, { promptType: "define", text: "=Classify this ticket as bug, billing or question: {{ $json.body }}" }],
    ["OpenAI model", L + "lmChatOpenAi", 200, 500, { model: "gpt-4.1-mini" }],
    ["Ticket memory", L + "memoryBufferWindow", 360, 500, {}],
    ["Route", B + "switch", 560, 300, { rules: { values: ["bug", "billing", "question"] } }],
    ["File Linear issue", B + "linear", 800, 160, { teamId: "ENG", title: "={{ $json.summary }}" }],
    ["Ping billing", B + "slack", 800, 300, { channel: "#billing" }],
    ["Draft answer", B + "gmail", 800, 440, { operation: "draft" }],
  ], [["New conversation", "Triage agent"], ["OpenAI model", "Triage agent", 0, "ai_languageModel"], ["Ticket memory", "Triage agent", 0, "ai_memory"],
    ["Triage agent", "Route"], ["Route", "File Linear issue", 0], ["Route", "Ping billing", 1], ["Route", "Draft answer", 2]]),

  wf("wf-invoices", "Invoice OCR → Sheets", true, ["finance", "ai"], [
    ["Invoice email", B + "gmailTrigger", 0, 300, { filters: { q: "has:attachment subject:invoice" } }],
    ["Read PDF", B + "extractFromFile", 240, 300, { operation: "pdf" }],
    ["Extract fields", L + "openAi", 480, 300, { resource: "text", prompt: "Return vendor, total and due date as JSON" }],
    ["Normalise", B + "code", 720, 300, { jsCode: "const inv = $json.message.content;\nreturn [{ json: { vendor: inv.vendor, total: inv.amounts.total, due: inv.due } }];" }],
    ["Append row", B + "googleSheets", 960, 300, { operation: "append", sheetName: "Invoices" }],
  ], [["Invoice email", "Read PDF"], ["Read PDF", "Extract fields"], ["Extract fields", "Normalise"], ["Normalise", "Append row"]]),

  wf("wf-release", "GitHub release notes", true, ["engineering"], [
    ["New release", B + "githubTrigger", 0, 300, { events: ["release"] }],
    ["Format notes", B + "code", 240, 300, { jsCode: "return [{ json: { md: $json.body.release.body } }];" }],
    ["Publish to Notion", B + "notion", 480, 220, { resource: "databasePage" }],
    ["Announce", B + "discord", 480, 380, { channel: "releases" }],
  ], [["New release", "Format notes"], ["Format notes", "Publish to Notion"], ["Format notes", "Announce"]]),

  wf("wf-shopify", "Shopify inventory sync", true, ["ops"], [
    ["Every 15 min", B + "scheduleTrigger", 0, 300, { rule: { interval: [{ field: "minutes", minutesInterval: 15 }] } }],
    ["Get products", B + "shopify", 240, 300, { operation: "getAll", returnAll: true }],
    ["Get sheet", B + "googleSheets", 240, 480, { operation: "read", sheetName: "Stock" }],
    ["Compare", B + "compareDatasets", 480, 380, { mergeByFields: { values: [{ field1: "sku", field2: "sku" }] } }],
    ["Update stock", B + "shopify", 720, 300, { operation: "update" }],
    ["Log drift", B + "googleSheets", 720, 480, { operation: "append", sheetName: "Drift" }],
  ], [["Every 15 min", "Get products"], ["Every 15 min", "Get sheet"], ["Get products", "Compare"], ["Get sheet", "Compare"], ["Compare", "Update stock", 0], ["Compare", "Log drift", 1]]),

  wf("wf-onboarding", "Onboarding drip", false, ["marketing"], [
    ["Hourly", B + "scheduleTrigger", 0, 300, {}],
    ["New signups", B + "supabase", 240, 300, { operation: "getAll", tableId: "profiles" }],
    ["Loop", B + "splitInBatches", 480, 300, { batchSize: 10 }],
    ["Wait a day", B + "wait", 720, 220, { amount: 1, unit: "days" }],
    ["Send welcome", B + "sendGrid", 960, 220, { templateId: "d-welcome" }],
  ], [["Hourly", "New signups"], ["New signups", "Loop"], ["Loop", "Wait a day", 1], ["Wait a day", "Send welcome"], ["Send welcome", "Loop"]], { updatedAt: "2026-09-01T10:00:00.000Z" }),

  wf("wf-errors", "Error alerts", true, ["ops"], [
    ["On any error", B + "errorTrigger", 0, 300, {}],
    ["Alert #alerts", B + "slack", 260, 300, { channel: "#alerts", text: "=❌ {{ $json.workflow.name }} failed: {{ $json.execution.error.message }}" }],
  ], [["On any error", "Alert #alerts"]]),

  wf("wf-calendar", "Calendar → Notion", false, ["personal"], [
    ["Event created", B + "googleCalendarTrigger", 0, 300, {}],
    ["Create page", B + "notion", 260, 300, {}],
  ], [["Event created", "Create page"]], { updatedAt: "2026-07-14T08:00:00.000Z" }),
];

// How often each live workflow runs and how it breaks. `node` is where the failure happens.
const PROFILES = {
  "wf-stripe": { perDay: 26, failRate: 0.07, ms: [900, 2600], failures: [
    { node: "Create deal", w: 3, message: "The service is receiving too many requests from you", description: "HubSpot returned 429: You have reached your secondly limit.", http: 429 },
    { node: "Notify #sales", w: 1, message: "channel_not_found", description: "Slack API error: The channel #sales could not be found or the bot is not in it." },
  ] },
  "wf-digest": { every: DAY, at: 8 * HOUR, failRate: 0.0, ms: [3000, 7000], failures: [] },
  "wf-leads": { perDay: 40, failRate: 0.12, ms: [600, 1800], failures: [
    { node: "Enrich company", w: 5, message: "Authorization failed - please check your credentials", description: "401 - {\"error\":\"invalid_api_key\",\"message\":\"API key expired on 2026-11-04\"}", http: 401, since: 3 * DAY },
    { node: "Save to Airtable", w: 1, message: "Field \"Company Size\" cannot accept the provided value", description: "INVALID_VALUE_FOR_COLUMN" },
  ] },
  "wf-triage": { perDay: 55, failRate: 0.04, ms: [4000, 14000], failures: [
    { node: "Triage agent", w: 2, message: "Rate limit reached for gpt-4.1-mini in organization org-demo on tokens per min", description: "OpenAI 429" },
    { node: "File Linear issue", w: 1, message: "Argument Validation Error - title must be shorter than 256 characters", description: "Linear GraphQL error" },
  ] },
  "wf-invoices": { perDay: 9, failRate: 0.3, ms: [5000, 16000], failures: [
    { node: "Normalise", w: 4, message: "Cannot read properties of undefined (reading 'total') [line 2]", description: "TypeError in Code node: inv.amounts is undefined for invoices without line items." },
  ] },
  "wf-release": { perDay: 0.6, failRate: 0, ms: [1200, 2400], failures: [] },
  "wf-shopify": { every: 15 * 60e3, failRate: 0.02, ms: [8000, 26000], failures: [
    { node: "Get products", w: 1, message: "The connection timed out, consider setting the 'Retry on Fail' option in the node settings", description: "ETIMEDOUT" },
  ] },
  "wf-errors": { followsErrors: true, ms: [300, 700], failures: [] },
};

// Every node a run reaches, in order, from the trigger: the first branch of an IF or Switch, the AI sub-nodes before
// their agent. A failed run stops at its failing node.
function reaches(w, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (w.connections[from]?.main ?? []).flat().some((x) => reaches(w, x.node, target, seen));
}

function pathOf(w, failNode, r) {
  const main = (n) => (w.connections[n]?.main ?? []);
  const trigger = w.nodes.find((n) => /trigger|webhook/i.test(n.type))?.name ?? w.nodes[0].name;
  const seen = new Set(), order = [];
  const queue = [trigger];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const sub of w.nodes) {
      const c = w.connections[sub.name];
      if (c && Object.keys(c).some((t) => t !== "main" && c[t].flat().some((x) => x.node === n)) && !seen.has(sub.name)) {
        seen.add(sub.name);
        order.push(sub.name);
      }
    }
    order.push(n);
    if (n === failNode) break;
    const outs = main(n);
    const branching = outs.length > 1;
    // A run that fails takes the branch that leads to its failing node.
    const leads = failNode ? outs.filter((o) => o.some((x) => reaches(w, x.node, failNode))) : [];
    const pick = !branching ? outs : leads.length ? [leads[0]] : [outs[Math.floor(r() * outs.length)] ?? []];
    for (const o of pick) for (const x of o) queue.push(x.node);
  }
  return order;
}

export function demoInstance(now = Date.now()) {
  const r = rng(20261107);
  const executions = [];
  const from = now - 7 * DAY;
  for (const w of DEMO_WORKFLOWS) {
    const p = PROFILES[w.id];
    if (!p || !w.active || p.followsErrors) continue;
    const starts = [];
    if (p.every) {
      const dayStart = new Date(from).setHours(0, 0, 0, 0);
      for (let t = p.every === DAY ? dayStart + p.at : from + r() * p.every; t < now; t += p.every) if (t >= from) starts.push(t);
    } else {
      // Busier in working hours: thin out night-time runs.
      const n = Math.round(p.perDay * 7);
      for (let i = 0; i < n * 1.6 && starts.length < n; i++) {
        const t = from + r() * 7 * DAY, h = new Date(t).getHours();
        if (h >= 8 && h <= 19 ? r() < 0.95 : r() < 0.35) starts.push(t);
      }
    }
    for (const t of starts) {
      const live = p.failures.filter((f) => !f.since || t > now - f.since);
      // The expired key in "Lead enrichment" fails most runs since it expired.
      const burst = live.find((f) => f.since);
      const failRate = burst ? 0.62 : p.failRate;
      const fails = live.length && r() < failRate;
      let failure = null;
      if (fails) {
        const pool = burst ? [burst] : live;
        const total = pool.reduce((s, f) => s + f.w, 0);
        let x = r() * total;
        failure = pool.find((f) => (x -= f.w) < 0) ?? pool[0];
      }
      const ms = p.ms[0] + r() * (p.ms[1] - p.ms[0]) * (fails ? 0.6 : 1);
      executions.push({ workflowId: w.id, startedAt: t, ms, failure, seed: Math.floor(r() * 1e9) });
    }
  }
  executions.sort((a, b) => a.startedAt - b.startedAt);
  // The error workflow runs once for every failure.
  const withAlerts = [];
  for (const e of executions) {
    withAlerts.push(e);
    if (e.failure) withAlerts.push({ workflowId: "wf-errors", startedAt: e.startedAt + e.ms + 400, ms: 500, failure: null, seed: e.seed + 1 });
  }
  withAlerts.sort((a, b) => a.startedAt - b.startedAt);
  // One run of the Shopify sync still going right now.
  withAlerts.push({ workflowId: "wf-shopify", startedAt: now - 9000, ms: null, failure: null, seed: 7, running: true });

  const list = [], details = {};
  withAlerts.forEach((e, i) => {
    const id = String(48000 + i);
    const w = DEMO_WORKFLOWS.find((x) => x.id === e.workflowId);
    const status = e.running ? "running" : e.failure ? "error" : "success";
    const startedAt = new Date(e.startedAt).toISOString();
    const stoppedAt = e.running ? null : new Date(e.startedAt + e.ms).toISOString();
    const mode = /schedule/i.test(w.nodes[0].type) ? "trigger" : /webhook|Trigger/.test(w.nodes[0].type) ? "webhook" : "trigger";
    list.push({ id, finished: status === "success", mode, retryOf: null, retrySuccessId: null, startedAt, stoppedAt, workflowId: w.id, waitTill: null, status });
    details[id] = { e, w, id, status, startedAt, stoppedAt, mode };
  });
  return { workflows: DEMO_WORKFLOWS, executions: list.reverse(), details };
}

// GET /executions/:id?includeData=true, built when asked so the list stays small.
export function demoExecution(instance, id) {
  const d = instance.details[id];
  if (!d) return null;
  const { e, w } = d;
  const r = rng(e.seed);
  const order = pathOf(w, e.failure?.node, r);
  const runData = {};
  let t = e.startedAt;
  const total = e.ms ?? 9000;
  order.forEach((name, i) => {
    const last = i === order.length - 1;
    const share = total / Math.max(1, order.length) * (0.5 + r());
    const failed = e.failure && name === e.failure.node;
    runData[name] = [{
      startTime: Math.round(t), executionTime: Math.round(share), executionStatus: failed ? "error" : "success", source: [],
      ...(failed ? { error: { message: e.failure.message, description: e.failure.description, name: "NodeApiError" } } : {}),
      data: { main: [[{ json: { demo: true, item: i } }]] },
    }];
    t += share;
    if (last && d.status === "running") delete runData[name][0].executionStatus;
  });
  const node = e.failure ? w.nodes.find((n) => n.name === e.failure.node) : null;
  return {
    id, finished: d.status === "success", mode: d.mode, startedAt: d.startedAt, stoppedAt: d.stoppedAt, workflowId: w.id, status: d.status,
    data: { resultData: {
      runData,
      lastNodeExecuted: order[order.length - 1],
      ...(e.failure ? { error: {
        message: e.failure.message, description: e.failure.description, name: "NodeApiError",
        ...(e.failure.http ? { httpCode: String(e.failure.http) } : {}),
        node: { name: node.name, type: node.type, typeVersion: 1 },
        stack: `NodeApiError: ${e.failure.message}\n    at ExecuteContext.execute (/usr/local/lib/node_modules/n8n/node_modules/n8n-nodes-base/dist/nodes/…)`,
      } } : {}),
    } },
  };
}
