// Chat history: past Ask Claude conversations, per instance, in Flowdeck's private folder (~/.config/herdr-app/.flowdeck,
// mode 700; each file mode 600). Never in shared state, which every mod can read. What's kept is the conversation
// people saw: questions, answers, and which run was shared. The run data sent to Claude is never kept.

import { readTextFile, exec } from "herdr";
import * as fs from "fs/promises";
import { ensurePrivateDir, privateDir } from "./vault.js";

export const MAX_CONVERSATIONS = 50;
const MAX_TURNS = 40;
const MAX_TEXT = 40000;

const file = (profileId) => {
  if (!/^[a-z0-9-]{1,40}$/.test(String(profileId))) throw new Error("bad profile id");
  return `${privateDir()}/history-${profileId}.json`;
};

const clean = (c) => ({
  id: String(c.id).slice(0, 40),
  title: String(c.title ?? "").slice(0, 120),
  scope: c.scope && typeof c.scope === "object" ? { kind: c.scope.kind, workflowId: c.scope.workflowId ?? null, runId: c.scope.runId ?? null, label: String(c.scope.label ?? "").slice(0, 120) } : { kind: "all", label: "All workflows" },
  created: Number(c.created) || Date.now(),
  updated: Number(c.updated) || Date.now(),
  turns: (Array.isArray(c.turns) ? c.turns : []).slice(-MAX_TURNS).map((t) => ({
    q: String(t.q ?? "").slice(0, 4000),
    a: String(t.a ?? "").slice(0, MAX_TEXT),
    model: t.model ? String(t.model).slice(0, 20) : null,
    error: t.error ? String(t.error).slice(0, 400) : null,
    scope: String(t.scope ?? "").slice(0, 120),
    workflowId: t.workflowId ?? null,
    found: t.found ? { id: String(t.found.id), workflowId: t.found.workflowId ?? null, needle: t.found.needle ?? null, shared: Boolean(t.found.shared), startedAt: t.found.startedAt ?? null, status: t.found.status ?? null } : null,
    at: Number(t.at) || null,
  })),
});

export async function loadHistory(profileId) {
  try {
    const raw = await readTextFile(file(profileId));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map(clean).filter((c) => c.turns.length).slice(0, MAX_CONVERSATIONS) : [];
  } catch {
    return [];
  }
}

export async function saveHistory(profileId, list) {
  await ensurePrivateDir();
  const path = file(profileId);
  await fs.writeFile(path, JSON.stringify(list.slice(0, MAX_CONVERSATIONS).map(clean)));
  await exec("chmod", ["600", path]).catch(() => {});
}

export async function clearHistory(profileId) {
  await exec("rm", ["-f", file(profileId)]).catch(() => {});
}

// One conversation from the live session (turns are kept newest first there; stored oldest first).
export function snapshot(session) {
  const turns = session.turns.slice().reverse().filter((p) => p.a && !p.a.streaming && !p.a.confirm && !p.a.searching).map((p) => ({
    q: p.q.text, a: p.a.text, model: p.a.model, error: p.a.error ?? null, scope: p.a.scope, workflowId: p.a.workflowId ?? null,
    found: p.a.found ?? null, at: p.a.started ?? null,
  }));
  if (!turns.length) return null;
  return clean({ id: session.convId, title: turns[0].q, scope: session.scope, created: session.convCreated, updated: Date.now(), turns });
}

// Back into the session's shape, newest first, as finished answers.
export function restoreTurns(conv) {
  return conv.turns.map((t, k) => ({
    q: { id: `hq${conv.id}-${k}`, role: "user", text: t.q, scope: t.scope },
    a: { id: `ha${conv.id}-${k}`, role: "assistant", text: t.a, streaming: false, scope: t.scope, model: t.model, error: t.error, workflowId: t.workflowId, found: t.found, started: t.at, restored: true },
  })).reverse();
}
