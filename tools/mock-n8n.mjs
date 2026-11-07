// A stand-in n8n for testing Flowdeck: the public REST API (X-N8N-API-KEY), the instance MCP endpoint (Bearer),
// /healthz, and a redirect trap that reports whether a credential header followed a redirect to another port.
// node tools/mock-n8n.mjs [port]   (from the repo root; a second copy on 5680 catches leaked keys)
import http from "node:http";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const demoPath = new URL("../mods/flowdeck/demo.js", import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? 5679);
const { demoInstance, demoExecution } = await import(pathToFileURL(demoPath).href);
const API_KEY = "demo-key-0123456789abcdef", MCP_TOKEN = "mcp-token-0123456789abcdef";
const inst = demoInstance();
const log = (line) => fs.appendFileSync(new URL("./mock-n8n.log", import.meta.url), `${new Date().toISOString()} ${line}\n`);

const page = (items, q) => {
  const limit = Math.min(250, Number(q.get("limit") ?? 100));
  const offset = q.get("cursor") ? Number(Buffer.from(q.get("cursor"), "base64url").toString()) : 0;
  const data = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString("base64url") : null;
  return { data, nextCursor: next };
};
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  log(`${PORT} ${req.method} ${url.pathname}${url.search} headers=[${Object.keys(req.headers).join(",")}]`);
  if (PORT !== 5679 && (req.headers["x-n8n-api-key"] || req.headers.authorization)) log(`LEAK: credential header reached port ${PORT}`);
  if (url.pathname === "/healthz") return send(res, 200, { status: "ok" });
  if (url.pathname === "/redirect-test/api/v1/workflows") {
    res.writeHead(302, { location: `http://127.0.0.1:5680/leak` });
    return res.end();
  }
  if (url.pathname.startsWith("/api/v1/")) {
    if (req.headers["x-n8n-api-key"] !== API_KEY) return send(res, 401, { message: "unauthorized" });
    if (q.get("slow")) await new Promise((r) => setTimeout(r, Number(q.get("slow"))));
    const parts = url.pathname.slice(8).split("/");
    if (parts[0] === "workflows" && !parts[1]) {
      let items = inst.workflows;
      if (q.get("active")) items = items.filter((w) => String(w.active) === q.get("active"));
      return send(res, 200, page(items, q));
    }
    if (parts[0] === "workflows") {
      const w = inst.workflows.find((x) => x.id === parts[1]);
      return w ? send(res, 200, w) : send(res, 404, { message: "Not Found" });
    }
    if (parts[0] === "executions" && !parts[1]) {
      let items = inst.executions;
      if (q.get("status")) items = items.filter((e) => e.status === q.get("status"));
      if (q.get("workflowId")) items = items.filter((e) => e.workflowId === q.get("workflowId"));
      return send(res, 200, page(items, q));
    }
    if (parts[0] === "executions") {
      const e = demoExecution(inst, parts[1]);
      if (!e) return send(res, 404, { message: "Not Found" });
      if (q.get("includeData") !== "true") delete e.data;
      return send(res, 200, e);
    }
    return send(res, 404, { message: "Not Found" });
  }
  if (url.pathname === "/mcp-server/http" && req.method === "POST") {
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) return send(res, 401, { error: "unauthorized" });
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "n8n MCP Server", version: "1.0.0" } };
    else if (msg.method === "tools/list") result = { tools: [{ name: "search_workflows" }, { name: "get_workflow_details" }, { name: "execute_workflow" }] };
    else if (msg.method === "tools/call" && msg.params.name === "search_workflows") {
      const data = inst.workflows.map(({ id, name, active, createdAt, updatedAt, nodes }) => ({ id, name, active, createdAt, updatedAt, triggerCount: 1, nodes: nodes.map((n) => ({ name: n.name, type: n.type })) }));
      result = { content: [{ type: "text", text: JSON.stringify({ data, count: data.length }) }], structuredContent: { data, count: data.length } };
    } else if (msg.method === "tools/call" && msg.params.name === "get_workflow_details") {
      const w = inst.workflows.find((x) => x.id === msg.params.arguments.workflowId);
      result = w ? { content: [{ type: "text", text: JSON.stringify({ workflow: w, triggerInfo: "Triggered by its first node." }) }] }
        : { isError: true, content: [{ type: "text", text: "Workflow not found" }] };
    } else return send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
  }
  send(res, 404, { message: "Not Found" });
});
server.listen(PORT, "127.0.0.1", () => log(`listening on ${PORT}`));
