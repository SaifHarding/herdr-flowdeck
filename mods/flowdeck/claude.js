// Asking Claude about workflows, through the person's own Claude Code (`claude -p`). It runs with every tool turned
// off, no MCP servers, no settings, hooks, skills or session saved, from Flowdeck's private folder, so whatever a
// workflow's text says, the model can only write an answer. The question and the workflow context go in on stdin
// from a file only this user can read, never on the command line, and that file is deleted when Claude finishes.
// It runs in the background so a long answer isn't cut off by exec's 30 second limit; the mod reads the stream as it
// grows, which is what makes the answer type itself out.

import { exec, readTextFile } from "herdr";
import * as fs from "fs/promises";
import { randomBytes } from "crypto";
import { ensurePrivateDir } from "./vault.js";

export const MODELS = [
  { id: "haiku", label: "Haiku", note: "fastest" },
  { id: "sonnet", label: "Sonnet", note: "balanced" },
  { id: "opus", label: "Opus", note: "deepest" },
];

export async function claudeInstalled() {
  try { return (await exec("sh", ["-c", "command -v claude >/dev/null 2>&1"])).code === 0; } catch { return false; }
}

const SCRIPT = [
  'cd "$1" || exit 1',
  "umask 077",
  '( claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --setting-sources "" '
    + '--no-session-persistence --disable-slash-commands --model "$2" --system-prompt "$3" < "$4" > "$5" 2> "$6"; echo $? > "$7"; rm -f "$4" ) '
    + "</dev/null >/dev/null 2>&1 &",
  "echo $!",
].join("\n");

export async function startAsk({ prompt, system, model }) {
  if (!MODELS.some((m) => m.id === model)) throw new Error("Unknown model");
  const dir = await ensurePrivateDir();
  const id = randomBytes(6).toString("hex");
  const f = (ext) => `${dir}/ask-${id}.${ext}`;
  await fs.writeFile(f("in"), prompt);
  await exec("chmod", ["600", f("in")]);
  const r = await exec("sh", ["-c", SCRIPT, "sh", dir, model, system, f("in"), f("out"), f("err"), f("code")]);
  const pid = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isInteger(pid) || pid <= 1) throw new Error("Couldn't start Claude Code");
  return { id, pid, out: f("out"), err: f("err"), code: f("code"), started: Date.now() };
}

// What the stream says so far: the answer's text, and whether Claude has finished.
export async function readAsk(job) {
  let raw = (await readTextFile(job.out).catch(() => null)) ?? "";
  // readTextFile stops at 1 MiB; a very long answer's stream outgrows that, so read its last part instead (the result
  // line, which carries the whole text, is always last).
  if (!raw || raw.length >= 1024 * 1024 - 1) {
    const t = await exec("tail", ["-c", "1000000", job.out]).catch(() => null);
    if (t?.code === 0 && t.stdout) raw = t.stdout.slice(t.stdout.indexOf("\n") + 1);
  }
  let text = "", result = null, error = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") text += j.event.delta.text;
    else if (j.type === "result") {
      result = j;
      if (j.is_error || j.subtype !== "success") error = String(j.result ?? j.subtype ?? "Claude stopped").slice(0, 400);
      else if (typeof j.result === "string") text = j.result;
    }
  }
  // Done once the shell has written Claude's exit code: after that nothing else writes into the folder.
  const code = (await readTextFile(job.code).catch(() => null))?.trim();
  const done = code !== undefined && code !== null && code !== "";
  if (done && !result && !error) {
    const err = ((await readTextFile(job.err).catch(() => null)) ?? "").trim();
    error = /not logged in|login|authenticate|api key/i.test(err) ? "Claude Code isn't signed in. Run `claude` once in a terminal to sign in." : (err.split("\n").pop() || `Claude Code exited with ${code}`).slice(0, 300);
  }
  return { text, done, error, cost: result?.total_cost_usd ?? null };
}

export async function cleanupAsk(job) {
  for (const ext of ["in", "out", "err", "code"]) await exec("rm", ["-f", `${job.out.replace(/\.out$/, "")}.${ext}`]).catch(() => {});
}

export async function cancelAsk(job) {
  if (Number.isInteger(job?.pid) && job.pid > 1) {
    // Only the claude we started: its parent subshell, and claude under it.
    await exec("sh", ["-c", 'pkill -TERM -P "$1" 2>/dev/null; kill -TERM "$1" 2>/dev/null; exit 0', "sh", String(job.pid)]).catch(() => {});
  }
  await cleanupAsk(job);
}
