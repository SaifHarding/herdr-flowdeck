// Talking to n8n: its public REST API with an API key, or its instance MCP server with an access token. Read-only by
// design: nothing here creates, changes, runs or deletes anything in n8n, and the MCP client refuses every tool but
// the two that read workflows.
//
// The key is only ever put in a header to the instance's own address. Herdr's fetch refuses a cross-origin redirect
// that would replay it, and every answer's final URL is checked against the instance too.

import { demoInstance, demoExecution } from "./demo.js";
import { DAY, startOf } from "./model.js";

const MAX_WORKFLOWS = 1000;
const MAX_EXECUTIONS = 3000;
const MAX_BODY = 6 * 1024 * 1024;

export class N8nError extends Error {
  constructor(message, kind = "network", status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function explain(status, body) {
  if (status === 401 || status === 403) return new N8nError("n8n refused the key. Check it's current and has access to this instance.", "auth", status);
  if (status === 404) return new N8nError("n8n's API isn't at this address. Check the URL, and that the public API is turned on (Settings → n8n API).", "notfound", status);
  if (status === 429) return new N8nError("n8n is rate limiting requests. Flowdeck will try again shortly.", "rate", status);
  let msg = "";
  try { msg = JSON.parse(body)?.message ?? ""; } catch {}
  return new N8nError(`n8n answered ${status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`, "server", status);
}

function sameOrigin(base, url) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

async function getJson(base, path, headers) {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  } catch (e) {
    const m = String(e?.message ?? e);
    if (/redirect/i.test(m)) throw new N8nError("The address redirects somewhere else. Use the final address of your instance.", "redirect");
    throw new N8nError(/timed? ?out|failed:/i.test(m) ? `Couldn't reach ${new URL(base).host}. Is it running, and is the address right?` : m, "network");
  }
  if (res.url && !sameOrigin(base, res.url)) throw new N8nError("The answer came from a different address than your instance. Refusing it.", "redirect");
  const text = await res.text();
  if (!res.ok) throw explain(res.status, text);
  if (text.length > MAX_BODY) throw new N8nError("n8n sent more than Flowdeck will read in one answer.", "server");
  try { return JSON.parse(text); } catch { throw new N8nError("n8n's answer wasn't JSON. Is this the n8n address, not a login page?", "server"); }
}

// ── REST ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class RestSource {
  constructor(base, key) {
    this.base = base;
    this.headers = { "X-N8N-API-KEY": key };
    this.kind = "api";
    this.has = { executions: true, details: true };
  }

  async check() {
    await getJson(this.base, "/api/v1/workflows?limit=1", this.headers);
  }

  async workflows() {
    const out = [];
    let cursor = null;
    do {
      const page = await getJson(this.base, `/api/v1/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, this.headers);
      out.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor && out.length < MAX_WORKFLOWS);
    return out.filter((w) => !w.isArchived);
  }

  // The last week of runs, newest first, without their data.
  async executions(since = Date.now() - 7 * DAY) {
    const out = [];
    let cursor = null;
    do {
      const page = await getJson(this.base, `/api/v1/executions?limit=250&includeData=false${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, this.headers);
      const data = page.data ?? [];
      out.push(...data);
      cursor = page.nextCursor ?? null;
      if (data.length && startOf(data[data.length - 1]) < since) break;
    } while (cursor && out.length < MAX_EXECUTIONS);
    return out.filter((e) => startOf(e) >= since || !e.startedAt);
  }

  async recent() {
    return (await getJson(this.base, "/api/v1/executions?limit=100&includeData=false", this.headers)).data ?? [];
  }

  async execution(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new N8nError("Bad execution id", "server");
    return getJson(this.base, `/api/v1/executions/${encodeURIComponent(id)}?includeData=true`, this.headers);
  }
}

// ── MCP ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MCP_READ_TOOLS = new Set(["search_workflows", "get_workflow_details"]);

// n8n's instance MCP server (Settings → Instance-level MCP), over streamable HTTP. It lists and describes workflows;
// it has no executions, so failures need an API key.
export class McpSource {
  constructor(base, token) {
    this.base = base;
    this.url = `${base}/mcp-server/http`;
    this.headers = { Authorization: `Bearer ${token}` };
    this.kind = "mcp";
    this.has = { executions: false, details: false };
    this.seq = 0;
    this.ready = false;
  }

  async rpc(method, params, notification = false) {
    const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++this.seq }) });
    let res;
    try {
      res = await fetch(this.url, { method: "POST", headers: { ...this.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body });
    } catch (e) {
      throw new N8nError(/redirect/i.test(String(e)) ? "The address redirects somewhere else. Use the final address of your instance." : `Couldn't reach ${new URL(this.base).host}.`, "network");
    }
    if (res.url && !sameOrigin(this.base, res.url)) throw new N8nError("The answer came from a different address than your instance. Refusing it.", "redirect");
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new N8nError("n8n refused the MCP token. Copy a fresh one from Settings → Instance-level MCP.", "auth", res.status);
    if (res.status === 404) throw new N8nError("No MCP server at this address. Turn on Instance-level MCP in n8n's settings.", "notfound", 404);
    if (!res.ok && res.status !== 202) throw explain(res.status, text);
    if (notification) return null;
    if (text.length > MAX_BODY) throw new N8nError("n8n sent more than Flowdeck will read in one answer.", "server");
    // Streamable HTTP answers either with JSON or with a short event stream: take the message with our id.
    const messages = text.trim().startsWith("{") ? [text] : text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (const m of messages) {
      let j;
      try { j = JSON.parse(m); } catch { continue; }
      if (j.id !== this.seq) continue;
      if (j.error) throw new N8nError(`MCP error: ${String(j.error.message ?? "").slice(0, 200)}`, "server");
      return j.result;
    }
    throw new N8nError("The MCP server's answer was empty.", "server");
  }

  async init() {
    if (this.ready) return;
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flowdeck-herdr", version: "0.1.0" } });
    await this.rpc("notifications/initialized", null, true);
    this.ready = true;
  }

  async call(name, args) {
    if (!MCP_READ_TOOLS.has(name)) throw new Error(`Flowdeck never calls ${name}`);
    await this.init();
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = r?.content?.find((c) => c.type === "text")?.text;
    if (r?.isError) throw new N8nError(String(text ?? "The MCP tool failed").slice(0, 300), "server");
    if (r?.structuredContent) return r.structuredContent;
    try { return JSON.parse(text ?? "null"); } catch { return text; }
  }

  async check() {
    await this.init();
  }

  async workflows() {
    const r = await this.call("search_workflows", { limit: 200 });
    const list = Array.isArray(r) ? r : r?.data ?? r?.workflows ?? r?.items ?? [];
    // Details fill in nodes and connections; until then a workflow has what search gave.
    const out = [];
    for (const w of list.slice(0, 200)) out.push({ ...w, id: String(w.id), nodes: w.nodes ?? [], connections: w.connections ?? {}, partial: true });
    return out;
  }

  async workflow(id) {
    const r = await this.call("get_workflow_details", { workflowId: String(id) });
    const w = r?.workflow ?? r;
    return { ...w, id: String(w?.id ?? id), partial: false };
  }

  async executions() { return []; }
  async recent() { return []; }
  async execution() { throw new N8nError("Execution details need an API key.", "unsupported"); }
}

// ── Demo ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class DemoSource {
  constructor() {
    this.kind = "demo";
    this.base = "https://demo.flowdeck.invalid";
    this.has = { executions: true, details: true };
    this.inst = demoInstance(Date.now());
  }
  async check() {}
  async workflows() { return this.inst.workflows; }
  async executions() { return this.inst.executions.filter((e) => startOf(e) <= Date.now()); }
  async recent() { return (await this.executions()).slice(0, 100); }
  async execution(id) { return demoExecution(this.inst, id); }
}

export function sourceFor(profile, secret) {
  if (profile.mode === "demo") return new DemoSource();
  return profile.mode === "mcp" ? new McpSource(profile.base, secret) : new RestSource(profile.base, secret);
}

// Links into the n8n editor, always under the instance's own address.
export const links = {
  workflow: (base, id) => `${base}/workflow/${encodeURIComponent(id)}`,
  execution: (base, wid, id) => `${base}/workflow/${encodeURIComponent(wid)}/executions/${encodeURIComponent(id)}`,
  executions: (base) => `${base}/home/executions`,
  apiSettings: (base) => `${base}/settings/api`,
};
