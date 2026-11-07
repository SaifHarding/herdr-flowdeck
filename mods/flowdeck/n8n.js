// Talking to n8n: its public REST API, with an API key. Read-only by design: nothing here creates, changes, runs or
// deletes anything in n8n.
//
// The key is only ever put in a header to the instance's own address. Herdr's fetch refuses a cross-origin redirect
// that would replay it, and every answer's final URL is checked against the instance too.

import { demoInstance, demoExecution } from "./demo.js";
import { DAY, startOf } from "./model.js";

const MAX_WORKFLOWS = 1000;
const MAX_EXECUTIONS = 3000;
const MAX_BODY = 6 * 1024 * 1024;
const MAX_PAGES = 20;

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
  try { msg = JSON.parse(String(body).slice(0, 4096))?.message ?? ""; } catch {}
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
  if (!res.ok) throw explain(res.status, text.slice(0, 4096));
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

  // Pages until n8n says there are no more, the cap is reached, or the server misbehaves (an empty page, a cursor it
  // already gave): a buggy or hostile server can't keep Flowdeck fetching forever.
  async paged(path, max, stop) {
    const out = [], seen = new Set();
    let cursor = null;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const page = await getJson(this.base, `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, this.headers);
      const data = Array.isArray(page?.data) ? page.data.slice(0, 250) : [];
      for (const x of data) if (out.length < max) out.push(x);
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
      if (!data.length || !cursor || seen.has(cursor) || out.length >= max || stop?.(data)) break;
      seen.add(cursor);
    }
    return out;
  }

  async workflows() {
    const out = await this.paged("/api/v1/workflows?limit=250", MAX_WORKFLOWS);
    return out.filter((w) => w && typeof w === "object" && !w.isArchived);
  }

  // The last week of runs, newest first, without their data.
  async executions(since = Date.now() - 7 * DAY) {
    const out = await this.paged("/api/v1/executions?limit=250&includeData=false", MAX_EXECUTIONS, (data) => startOf(data[data.length - 1]) < since);
    return out.filter((e) => e && typeof e === "object" && (startOf(e) >= since || !e.startedAt));
  }

  async recent() {
    const page = await getJson(this.base, "/api/v1/executions?limit=100&includeData=false", this.headers);
    return Array.isArray(page?.data) ? page.data.slice(0, 100) : [];
  }

  async execution(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new N8nError("Bad execution id", "server");
    return getJson(this.base, `/api/v1/executions/${encodeURIComponent(id)}?includeData=true`, this.headers);
  }
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
  return new RestSource(profile.base, secret);
}

// Links into the n8n editor, always under the instance's own address.
export const links = {
  workflow: (base, id) => `${base}/workflow/${encodeURIComponent(id)}`,
  execution: (base, wid, id) => `${base}/workflow/${encodeURIComponent(wid)}/executions/${encodeURIComponent(id)}`,
  executions: (base) => `${base}/home/executions`,
  apiSettings: (base) => `${base}/settings/api`,
};
