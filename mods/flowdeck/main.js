// Flowdeck: n8n in a Herdr pane. Connect an instance with an API key, then see how it's doing, what
// each workflow looks like and how its runs went, what's failing and why, and ask Claude about any of it.
//
// Open it as a tab: herdr-app do tab.new --name n8n --mod flowdeck   (or mod.open:flowdeck for a quick look).
//
// What it keeps: instance names and addresses in shared state; keys in the OS keychain (vault.js); workflow and run
// data in memory only, for as long as the pane is open. It never changes anything in n8n.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, TextareaState } from "gpui-base";
import { shared, setShared, notify, panes, props, closeOverlay, run, exec, nextCommand } from "herdr";
import os from "os";
import { randomBytes } from "crypto";
import { colors, alpha, icon, spinner, button, dot, ENTER_MS, MOTION, mono, n8nMark } from "./ui.js";
import { sourceFor, links, N8nError } from "./n8n.js";
import { saveSecret, loadSecret, deleteSecret, sweepPrivateDir, vaultKind } from "./vault.js";
import { normalizeUrl, checkKey, tail, indexRuns, groupFailures, kpis, histogram, extractRun, layoutGraph, failed, running, startOf, DAY, HOUR, ago } from "./model.js";
import { GraphState } from "./graph.js";
import { connectView } from "./connect.js";
import { overviewView } from "./overview.js";
import { workflowsView, sortedWorkflows } from "./workflows.js";
import { failuresView } from "./failures.js";
import { askView, AskSession } from "./ask.js";
import { claudeInstalled } from "./claude.js";
import { SPRITES, SPRITE_KEY, spriteKind, motionPrefs } from "./sprites.js";
import { TICK } from "./motion.js";

const PROFILES = "flowdeck.profiles";
const ACTIVE = "flowdeck.active";
const ALERTED = "flowdeck.alerted";
const SEEN = "flowdeck.seen";
const LIST_COLLAPSED = "flowdeck.list-collapsed";
const BADGE = "flowdeck.badge";
const MOTION_KEY = "flowdeck.motion";
const POLL_MS = 30e3;
const FULL_MS = 15 * 60e3;
const DETAIL_BATCH = 30;
const DETAIL_MAX = 150;
const TABS = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "workflows", label: "Workflows", icon: "flow" },
  { id: "failures", label: "Failures", icon: "inbox" },
  { id: "ask", label: "Ask Claude", icon: "spark" },
];

// The system's "reduce motion": macOS accessibility, or GNOME's animations switch.
async function systemReducesMotion() {
  const p = os.platform();
  try {
    if (p === "macos" || p === "darwin") return (await exec("defaults", ["read", "com.apple.universalaccess", "reduceMotion"])).stdout.trim() === "1";
    if (p === "linux") return (await exec("gsettings", ["get", "org.gnome.desktop.interface", "enable-animations"])).stdout.trim() === "false";
  } catch {}
  return false;
}

const sleep = (cx, ms) => new Promise((r) => cx.timer.after(ms, () => r()));
const newId = () => `p-${randomBytes(5).toString("hex")}`;
const numeric = (id) => (/^\d+$/.test(String(id)) ? Number(id) : null);

export default class Flowdeck extends View {
  init(_props, cx) {
    // A copy in a bar (`props: { bar: true }`) is only a button that opens Flowdeck: it syncs nothing itself and reads
    // the failure badge the full copy publishes.
    this.isBar = Boolean(props()?.bar);
    if (this.isBar) return;
    this.mode = "loading";
    this.form = { mode: "api", show: false, remember: true, busy: false, error: null, warning: null, entered: false };
    this.inputs = {
      url: InputState.new({ placeholder: "https://your-team.app.n8n.cloud" }),
      key: InputState.new({ placeholder: "Paste the key" }),
      name: InputState.new({ placeholder: "Production (optional)" }),
      search: InputState.new({ placeholder: "Search workflows" }),
      ask: TextareaState.new({ placeholder: "Ask anything about your workflows…" }),
    };
    this.inputs.key.set_masked(true);
    this.inputs.ask.set_auto_grow(1, 6);
    this.inputs.url.on("change", (_e, cx) => {
      const u = normalizeUrl(this.inputs.url.value(), { allowInsecure: true });
      this.form.error = null;
      this.form.needsOptIn = Boolean(u.insecure);
      if (!u.insecure) this.form.allowInsecure = false;
      this.form.warning = u.insecure ? u.warning : null;
      cx.notify();
    });
    this.inputs.key.on("change", (_e, cx) => { this.form.error = null; cx.notify(); });
    this.inputs.key.on("submit", (_e, cx) => this.connect(cx));
    this.inputs.url.on("submit", (_e, cx) => this.inputs.key.focus());
    this.inputs.search.on("change", (_e, cx) => cx.notify());
    this.inputs.ask.on("submit", (e, cx) => { if (!e.shift) this.askCurrent(cx); });
    this.tab = "overview";
    this.entered = {};
    this.sel = { workflowId: null, node: null, runId: null, failureKey: null, filter: "all", failFilter: "open" };
    this.graph = new GraphState();
    this.replay = null;
    this.menu = false;
    this.hoverBar = null;
    this.dockOpen = false;
    this.listCollapsed = Boolean(shared(LIST_COLLAPSED));
    this.asking = new AskSession();
    this.data = this.emptyData();
    this.vault = null;
    this.platform = os.platform();
    cx.spawn(async (cx) => {
      this.systemReduce = await systemReducesMotion();
      this.vault = await vaultKind();
      await sweepPrivateDir().catch(() => {});
      this.asking.installed = await claudeInstalled().catch(() => false);
      const p = this.activeProfile();
      if (p) await this.open(p, cx);
      else this.showConnect(cx);
      cx.notify();
    });
    // Key commands: "flowdeck.<command>" in keys.json (see keys.json in the repo).
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        this.command(String(cmd), cx);
        cx.notify();
      }
    });
    cx.timer.every(TICK, (cx) => {
      if (this.mode !== "app" || !this.motionWanted()) return;
      for (const g of [this.graph, this.failGraph, this.askGraph]) if (g) g.needsTick = false;
      cx.notify();
    });
    cx.timer.every(POLL_MS, (cx) => {
      if (this.mode !== "app" || !this.source || Date.now() < (this.data.backoff ?? 0)) return;
      const full = Date.now() - (this.data.fullAt ?? 0) > FULL_MS;
      cx.spawn(async (cx) => this.refresh(cx, { full, quiet: true }));
    });
  }

  async close() {
    if (this.isBar) return;
    await this.asking.cancel();
  }

  // ── The header button ─────────────────────────────────────────────────────────────────────────────────────────

  // Goes to the Flowdeck tab if there is one, else opens one.
  static openFlowdeck() {
    const mine = panes().find((p) => p.mod === "flowdeck");
    if (mine) run("tab.select", { id: mine.tab });
    else run("tab.new", { name: "n8n", mod: "flowdeck" });
  }

  renderBar() {
    const c = colors();
    const b = shared(BADGE) ?? {};
    const fresh = Number(b.unseen) || 0;
    const tip = fresh ? `Flowdeck: ${fresh} new failure cause${fresh === 1 ? "" : "s"}${b.name ? ` on ${b.name}` : ""}` : `Open Flowdeck${b.name ? ` · ${b.name}` : ""}`;
    return h_flex().id("fd-bar").size_full().px(4).items_center().justify_center().bg(c.chrome ?? c.surface).border_b(1).border_color(c.border)
      .child(h_flex().id("fd-btn").relative().h(26).px(7).gap(6).rounded(5).items_center().cursor_pointer()
        .hover((s) => s.bg(c.hover)).tooltip(tip)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => Flowdeck.openFlowdeck())
        .child(icon("logo", 16, fresh ? c.foreground : c.muted))
        .when(fresh > 0, (e) => e.child(h_flex().h(15).min_w(15).px(4).rounded(8).items_center().justify_center().bg(c.err)
          .loop("opacity", { from: 0.7, to: 1, period: 1400 })
          .child(div().text_size(9.5).font_bold().text_color("#ffffff").child(fresh > 99 ? "99+" : String(fresh))))));
  }

  // What the header button shows, written only when it changes (every write re-renders every mod).
  updateBadge() {
    if (this.isBar || !this.profile) return;
    const seen = (shared(SEEN) ?? {})[this.profile.id] ?? 0;
    const unseen = this.derived().groups.filter((g) => startOf(g.latest) > seen).length;
    const next = { unseen, name: this.profile.name };
    const cur = shared(BADGE);
    if (!cur || cur.unseen !== next.unseen || cur.name !== next.name) setShared(BADGE, next);
  }

  emptyData() {
    return { workflows: [], executions: [], runs: new Map(), loading: true, syncing: false, error: null, synced: 0, fullAt: 0, version: 0, pending: new Set(), unreadable: new Set(), memo: null };
  }

  command(cmd, cx) {
    if (TABS.some((t) => t.id === cmd) && this.mode === "app") this.go(cmd, cx);
    else if (cmd === "refresh" && this.mode === "app") cx.spawn(async (cx) => this.refresh(cx, { full: true }));
    else if (cmd === "demo") cx.spawn(async (cx) => this.tryDemo(cx));
    else if (cmd === "ask-about" && this.mode === "app") {
      const w = this.derived().byId.get(this.sel.workflowId);
      if (w && this.tab === "workflows") { if (this.dockOpen) this.closeDock(cx); else this.openDock(w, cx); }
      else { if (w) this.asking.scope = { kind: "workflow", workflowId: w.id, label: w.name }; this.go("ask", cx); }
    }
    else if (cmd === "toggle-list") this.toggleList(cx);
    else if (cmd.startsWith("sprite-") && SPRITES.some((sp) => sp.id === cmd.slice(7))) setShared(SPRITE_KEY, cmd.slice(7));
    else if (cmd === "next-sprite") { const i = SPRITES.findIndex((sp) => sp.id === spriteKind()); setShared(SPRITE_KEY, SPRITES[(i + 1) % SPRITES.length].id); }
    else if (cmd === "connect") { this.menu = false; this.inputs.url.set_value(""); this.showConnect(cx, { adding: Boolean(this.activeProfile()) }); }
    else if (cmd === "replay" && this.tab === "workflows") { if (this.replay) this.stopReplay(); else this.startReplay(cx); }
    else if (cmd === "next" || cmd === "prev") {
      const list = this.tab === "failures" ? this.derived().groups.map((g) => g.key) : sortedWorkflows(this).map((w) => w.id);
      const cur = list.indexOf(this.tab === "failures" ? this.sel.failureKey : this.sel.workflowId);
      const next = list[Math.max(0, Math.min(list.length - 1, cur + (cmd === "next" ? 1 : -1)))];
      if (!next) return;
      if (this.tab === "failures") { this.sel.failureKey = next; this.failGraph = null; }
      else this.showWorkflow(next, cx);
    }
  }

  // ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────

  profiles() { return Array.isArray(shared(PROFILES)) ? shared(PROFILES) : []; }
  activeProfile() {
    const id = shared(ACTIVE);
    if (id === "demo") return { id: "demo", name: "Demo instance", base: "https://demo.flowdeck.invalid", mode: "demo" };
    return this.profiles().find((p) => p.id === id) ?? null;
  }

  showConnect(cx, { adding = false } = {}) {
    this.mode = "connect";
    this.adding = adding;
    this.form = { ...this.form, busy: false, error: null, entered: false };
    cx.timer.after(ENTER_MS, (cx) => { this.form.entered = true; cx.notify(); });
    cx.timer.after(120, () => { try { this.inputs.url.focus(); } catch {} });
  }

  async connect(cx) {
    if (this.form.busy) return;
    // An address pasted into the key field: put it where it belongs if that's empty, and say what's missing.
    const pasted = checkKey(this.inputs.key.value());
    if (pasted.url) {
      if (!this.inputs.url.value().trim()) this.inputs.url.set_value(pasted.url);
      this.inputs.key.set_value("");
      this.form.error = pasted.error;
      cx.notify();
      return;
    }
    const url = normalizeUrl(this.inputs.url.value(), { allowInsecure: this.form.allowInsecure });
    this.form.needsOptIn = Boolean(url.needsOptIn) || (Boolean(url.insecure) && this.form.allowInsecure);
    if (url.error) { this.form.error = url.error; cx.notify(); return; }
    const k = checkKey(this.inputs.key.value());
    if (k.error) { this.form.error = k.error; cx.notify(); return; }
    this.form.busy = true;
    this.form.error = null;
    cx.notify();
    const mode = this.form.mode;
    try {
      const source = sourceFor({ mode, base: url.base }, k.key);
      await source.check();
      const id = newId();
      const vault = await saveSecret(id, url.base, k.key, { remember: this.form.remember });
      const profile = { id, name: this.inputs.name.value().trim().slice(0, 40) || url.host, base: url.base, mode, tail: tail(k.key), vault, insecure: url.insecure, added: new Date().toISOString() };
      setShared(PROFILES, [...this.profiles(), profile]);
      setShared(ACTIVE, id);
      this.inputs.key.set_value("");
      this.inputs.name.set_value("");
      this.form.busy = false;
      await this.open(profile, cx, source);
    } catch (e) {
      this.form.busy = false;
      this.form.error = e instanceof N8nError || e instanceof Error ? e.message : String(e);
      cx.notify();
    }
  }

  async tryDemo(cx) {
    setShared(ACTIVE, "demo");
    await this.open(this.activeProfile(), cx);
  }

  async open(profile, cx, source = null) {
    this.profile = profile;
    this.data = this.emptyData();
    this.sel = { ...this.sel, workflowId: null, node: null, runId: null, failureKey: null };
    this.asking.reset();
    this.menu = false;
    this.mode = "app";
    this.go(this.tab, cx);
    cx.notify();
    try {
      if (!source) {
        if (profile.mode === "mcp") throw new N8nError("Flowdeck no longer connects over MCP. Connect this instance again with an API key.", "nokey");
        // Shared state is writable by any mod: check the stored address against the same rules as the connect form
        // before a key goes anywhere near it.
        if (profile.mode !== "demo") {
          const u = normalizeUrl(profile.base, { allowInsecure: Boolean(profile.insecure) });
          if (u.error || u.base !== profile.base) throw new N8nError(`This instance's saved address isn't allowed (${u.error ?? "it changed"}). Connect it again.`, "nokey");
        }
        const secret = profile.mode === "demo" ? null : await loadSecret(profile.id, profile.base);
        if (profile.mode !== "demo" && !secret) {
          this.data.loading = false;
          this.data.error = { kind: "nokey", message: profile.vault === "session" ? "This instance's key was kept only until Herdr quit. Connect it again." : "Couldn't read this instance's key from the keychain." };
          cx.notify();
          return;
        }
        source = sourceFor(profile, secret);
      }
      this.source = source;
      await this.refresh(cx, { full: true });
    } catch (e) {
      this.data.loading = false;
      this.data.error = { kind: e.kind ?? "error", message: e.message ?? String(e) };
      cx.notify();
    }
  }

  switchTo(id, cx) {
    setShared(ACTIVE, id);
    const p = this.activeProfile();
    if (p) cx.spawn(async (cx) => this.open(p, cx));
  }

  async disconnect(cx) {
    const p = this.profile;
    if (!p) return;
    await this.asking.cancel();
    if (p.mode !== "demo") {
      await deleteSecret(p.id, p.base);
      setShared(PROFILES, this.profiles().filter((x) => x.id !== p.id));
      for (const k of [ALERTED, SEEN]) {
        const v = { ...(shared(k) ?? {}) };
        delete v[p.id];
        setShared(k, v);
      }
    }
    this.source = null;
    this.profile = null;
    this.data = this.emptyData();
    const next = this.profiles()[0];
    setShared(ACTIVE, next?.id ?? null);
    if (next) await this.open(next, cx);
    else { this.showConnect(cx); cx.notify(); }
  }

  // ── Data ────────────────────────────────────────────────────────────────────────────────────────────────────

  async refresh(cx, { full = false, quiet = false } = {}) {
    const d = this.data, source = this.source;
    if (!source || d.syncing) return;
    d.syncing = true;
    if (!quiet) cx.notify();
    try {
      if (full || !d.workflows.length) {
        const [workflows, executions] = await Promise.all([source.workflows(), source.executions()]);
        if (this.source !== source) return;
        d.workflows = workflows;
        this.mergeRuns(executions, cx, true);
        d.fullAt = Date.now();
      } else {
        const recent = await source.recent();
        if (this.source !== source) return;
        this.mergeRuns(recent, cx, false);
      }
      d.error = null;
      d.synced = Date.now();
    } catch (e) {
      d.error = { kind: e.kind ?? "error", message: e.message ?? String(e) };
      // Rate limited: leave the instance alone for two minutes.
      if (e.kind === "rate") d.backoff = Date.now() + 2 * 60e3;
    } finally {
      d.syncing = false;
      d.loading = false;
      d.version++;
      cx.notify();
    }
    if (this.source === source) this.loadDetails(cx);
    if (this.tab === "workflows") this.selectDefault(cx);
    this.updateBadge();
  }

  mergeRuns(list, cx, replace) {
    const d = this.data;
    const first = !d.synced;
    const known = new Map(d.executions.map((e) => [String(e.id), e]));
    // Newly failed: not seen before, or seen running and failed since.
    const fresh = list.filter((e) => failed(e) && !(known.has(String(e.id)) && failed(known.get(String(e.id)))));
    for (const e of list) {
      const old = known.get(String(e.id));
      if (old && old.status !== e.status) d.runs.delete(String(e.id));
    }
    if (replace) {
      // A full sync is the truth for the week, but keeps anything newer it raced with.
      const newest = list.reduce((m, e) => Math.max(m, startOf(e)), 0);
      for (const [id, e] of known) if (startOf(e) <= newest) known.delete(id);
    }
    for (const e of list) known.set(String(e.id), e);
    const cutoff = Date.now() - 7 * DAY;
    d.executions = [...known.values()].filter((e) => startOf(e) >= cutoff || !e.startedAt).sort((a, b) => startOf(b) - startOf(a));
    if (first) this.markAlerted(d.executions);
    else if (fresh.length) this.alert(fresh, cx);
  }

  // A toast for runs that failed since this instance was last looked at, once across every Flowdeck copy.
  markAlerted(list) {
    const ids = list.filter(failed).map((e) => numeric(e.id)).filter((n) => n !== null);
    if (!ids.length || !this.profile) return;
    const all = shared(ALERTED) ?? {};
    const max = ids.reduce((m, n) => Math.max(m, n), 0);
    if ((all[this.profile.id] ?? 0) < max) setShared(ALERTED, { ...all, [this.profile.id]: max });
  }

  alert(fresh, cx) {
    const all = shared(ALERTED) ?? {};
    const seen = all[this.profile.id] ?? 0;
    const news = fresh.filter((e) => (numeric(e.id) ?? Infinity) > seen);
    this.markAlerted(fresh);
    if (!news.length) return;
    cx.spawn(async (cx) => {
      await this.fetchRuns(news.slice(0, 5).map((e) => String(e.id)), cx);
      const e = news[0];
      const w = this.data.workflows.find((x) => x.id === e.workflowId);
      const r = this.data.runs.get(String(e.id));
      const mine = panes().find((p) => p.mod === "flowdeck");
      notify({
        title: news.length > 1 ? `${news.length} n8n runs failed` : `${w?.name ?? "A workflow"} failed`,
        body: r?.node ? `${r.node}: ${r.message ?? "error"}`.slice(0, 160) : "Open Flowdeck to see why.",
        level: "error",
        icon: "mods/flowdeck/icons/alert.svg",
        timeout: 8000,
        ...(mine ? { action: { name: "tab.select", args: { id: mine.tab } } } : {}),
      });
      cx.notify();
    });
  }

  // Details for the newest failures, a few at a time, in the background. Only the error and the run order are kept.
  // The newest first, then on through the week in batches, so older causes group properly too; capped so a noisy
  // instance isn't asked for thousands of runs.
  loadDetails(cx) {
    if (!this.source?.has.details || this.data.loadingDetails) return;
    const source = this.source;
    this.data.loadingDetails = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const want = this.data.executions.filter(failed).slice(0, DETAIL_MAX).map((e) => String(e.id)).filter((id) => !this.data.runs.has(id) && !this.data.pending.has(id) && !this.data.unreadable.has(id)).slice(0, DETAIL_BATCH);
          if (!want.length || this.source !== source) break;
          await this.fetchRuns(want, cx);
          await sleep(cx, 400);
        }
      } finally {
        this.data.loadingDetails = false;
      }
    });
  }

  async fetchRuns(ids, cx) {
    const d = this.data, source = this.source;
    const todo = ids.filter((id) => !d.runs.has(id) && !d.pending.has(id) && !d.unreadable.has(id));
    for (const id of todo) d.pending.add(id);
    const worker = async () => {
      while (todo.length) {
        // Rate limited: everything waits, details included.
        while (Date.now() < (d.backoff ?? 0)) await sleep(cx, Math.min(5000, d.backoff - Date.now()));
        if (this.source !== source) return;
        const id = todo.shift();
        try {
          const detail = await source.execution(id);
          if (this.source !== source) return;
          d.runs.set(id, extractRun(detail));
        } catch (e) {
          // Rate limited: wait and let a later batch retry. Anything else: don't ask for this run again.
          if (e.kind === "rate") { d.backoff = Date.now() + 60e3; todo.push(id); }
          else d.unreadable.add(id);
        } finally {
          d.pending.delete(id);
        }
      }
    };
    // Two at a time: each response is held as text while it's read, and every mod shares one heap.
    await Promise.all([worker(), worker()]);
    d.version++;
    this.updateBadge();
    cx.notify();
  }

  // Everything views read, worked out once per change of data (or minute, for "24h" windows).
  derived() {
    const d = this.data, now = Date.now(), minute = Math.floor(now / 60e3);
    if (d.memo && d.memo.version === d.version && d.memo.minute === minute) return d.memo;
    const byId = new Map(d.workflows.map((w) => [w.id, w]));
    const stats = indexRuns(d.workflows, d.executions, now);
    const groups = groupFailures(d.executions, d.runs, byId, now);
    d.memo = {
      version: d.version, minute, now, byId, stats, groups,
      kpis: kpis(d.workflows, d.executions, now),
      hourly: histogram(d.executions, now, DAY, 24),
      daily: histogram(d.executions, now, 7 * DAY, 28),
      graphs: new Map(),
    };
    return d.memo;
  }

  graphOf(w) {
    const m = this.derived();
    let g = m.graphs.get(w.id);
    if (!g) { g = layoutGraph(w); g.key = `${w.id}|${w.updatedAt ?? ""}|${(w.nodes ?? []).length}`; m.graphs.set(w.id, g); }
    return g;
  }

  // ── Navigation ──────────────────────────────────────────────────────────────────────────────────────────────

  go(tab, cx) {
    this.tab = tab;
    this.menu = false;
    this.entered[tab] = false;
    if (tab === "failures" && this.profile) { setShared(SEEN, { ...(shared(SEEN) ?? {}), [this.profile.id]: Date.now() }); this.updateBadge(); }
    if (tab === "workflows") { this.graph.entered = false; this.selectDefault(cx); }
    cx.timer.after(ENTER_MS, (cx) => { this.entered[tab] = true; this.graph.entered = true; cx.notify(); });
    if (tab === "ask") cx.timer.after(80, () => { try { this.inputs.ask.focus(); } catch {} });
    cx.notify();
  }

  // Shows one workflow, and optionally one run of it, in the Workflows tab.
  showWorkflow(id, cx, opts = {}) {
    const changed = this.sel.workflowId !== id;
    this.selectWorkflow(id, cx, opts);
    if (this.tab !== "workflows") this.go("workflows", cx);
    else if (changed) { this.graph.entered = false; cx.timer.after(ENTER_MS, (cx) => { this.graph.entered = true; cx.notify(); }); }
  }

  selectWorkflow(id, cx, { runId = null, node = null } = {}) {
    if (this.sel.workflowId !== id) this.graph = new GraphState();
    this.stopReplay();
    this.sel.workflowId = id;
    this.sel.node = node;
    this.sel.centerNode = node;
    this.sel.runId = runId;
    cx.spawn(async (cx) => {
      const s = this.derived().stats.get(id);
      const pick = runId ?? s?.runs.find((r) => !running(r))?.id ?? null;
      if (pick && this.source?.has.details) await this.fetchRuns([String(pick)], cx);
      if (!this.sel.runId && pick && this.sel.workflowId === id) { this.sel.runId = String(pick); cx.notify(); }
    });
    cx.notify();
  }

  // The Workflows tab never opens empty: failing ones first.
  selectDefault(cx) {
    if (this.sel.workflowId || !this.data.workflows.length) return;
    const first = sortedWorkflows(this)[0];
    if (first) this.selectWorkflow(first.id, cx);
  }

  pickRun(id, cx) {
    this.stopReplay();
    this.sel.runId = String(id);
    cx.spawn(async (cx) => this.fetchRuns([String(id)], cx));
    cx.notify();
  }

  // Walks the selected run node by node. A timer steps it (bounded: one tick per node); the motion between steps is
  // native transitions.
  startReplay(cx) {
    const r = this.data.runs.get(String(this.sel.runId));
    if (!r?.order?.length) return;
    this.stopReplay();
    this.replay = { step: 0, total: r.order.length };
    this.replay.task = cx.timer.every(520, (cx) => {
      if (!this.replay) return;
      this.replay.step++;
      if (this.replay.step > this.replay.total) this.stopReplay();
      cx.notify();
    });
    cx.notify();
  }

  stopReplay() {
    this.replay?.task?.cancel();
    this.replay = null;
  }

  // Opens a page of the person's own instance, never anywhere else.
  openLink(url) {
    const base = this.profile?.base;
    if (!base || this.profile.mode === "demo" || !(url === base || url.startsWith(`${base}/`))) return;
    this.openExternal(url);
  }

  openExternal(url) {
    if (!/^https?:\/\/[^\s]+$/.test(url)) return;
    const p = this.platform;
    const [cmd, args] = p === "macos" || p === "darwin" ? ["open", [url]] : p === "windows" || p === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    exec(cmd, args).catch(() => {});
  }

  toggleList(cx) {
    this.listCollapsed = !this.listCollapsed;
    setShared(LIST_COLLAPSED, this.listCollapsed);
    cx.notify();
  }

  // Ask Claude beside the graph. About the selected run's failure when there is one, else the workflow.
  openDock(w, cx, { runId = null } = {}) {
    const id = runId ?? this.sel.runId;
    const run = id ? this.data.runs.get(String(id)) : null;
    this.asking.scope = run?.node
      ? { kind: "failure", workflowId: w.id, runId: String(id), label: `${w.name} › ${run.node}` }
      : { kind: "workflow", workflowId: w.id, label: w.name };
    this.stopReplay();
    this.dockOpen = true;
    this.inspectFromDock = false;
    this.sel.node = null;
    cx.timer.after(80, () => { try { this.inputs.ask.focus(); } catch {} });
    cx.notify();
  }

  closeDock(cx) {
    this.dockOpen = false;
    cx.notify();
  }

  // ── Asking ──────────────────────────────────────────────────────────────────────────────────────────────────

  lookFurther(t, mode, cx) {
    cx.spawn(async (cx) => this.asking.lookFurther(this, t, mode, cx));
  }

  askCurrent(cx) {
    const q = this.inputs.ask.value().trim();
    if (!q) return;
    this.inputs.ask.set_value("");
    this.ask(q, cx);
  }

  ask(question, cx, scope) {
    if (scope) this.asking.scope = scope;
    // Docked beside a workflow, the answer comes there; otherwise in the Ask tab.
    if (this.tab !== "ask" && !(this.tab === "workflows" && this.dockOpen)) this.go("ask", cx);
    cx.spawn(async (cx) => {
      const sc = this.asking.scope;
      if (sc.kind === "failure" && sc.runId) await this.fetchRuns([String(sc.runId)], cx);
      await this.asking.ask(question, this, cx);
    });
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────────

  reducedMotion() {
    const pref = shared(MOTION_KEY);
    return pref === "reduce" ? true : pref === "full" ? false : Boolean(this.systemReduce);
  }

  // A sprite's move steps every TICK ms while it travels (and through a honk). The ticker below runs from init (a
  // timer started during render never fires); it redraws only while a drawn graph says a move is under way, so it
  // costs nothing while sprites dwell.
  motionWanted() {
    return [this.graph, this.failGraph, this.askGraph].some((g) => g?.needsTick);
  }

  render(cx) {
    if (this.isBar) return this.renderBar();
    motionPrefs.reduced = this.reducedMotion();
    const c = colors();
    const inOverlay = Boolean(props()?.overlay);
    if (this.mode === "loading") {
      return v_flex().id("root").size_full().bg(c.canvas ?? c.background).items_center().justify_center().child(spinner(22, c.brand));
    }
    if (this.mode === "connect") return connectView(this, c, cx);
    const body = this.tab === "overview" ? overviewView(this, c)
      : this.tab === "workflows" ? workflowsView(this, c)
      : this.tab === "failures" ? failuresView(this, c)
      : askView(this, c);
    return v_flex().id("root").size_full().relative().bg(c.canvas ?? c.background).text_color(c.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.header(c, inOverlay))
      .child(this.banner(c))
      .child(div().flex_1().min_h(0).w_full().child(body))
      .when(this.menu, (e) => e.child(this.menuPanel(c)));
  }

  header(c, inOverlay) {
    const d = this.data, p = this.profile;
    const m = this.derived();
    const seen = (shared(SEEN) ?? {})[p?.id] ?? 0;
    const unseen = m.groups.filter((g) => startOf(g.latest) > seen).length;
    const compact = (this.size?.width ?? 1200) < 980;
    const live = !d.error && d.synced && Date.now() - d.synced < POLL_MS * 3;
    const modeTag = p?.mode === "demo" ? "DEMO" : "API";
    const nav = TABS.map((t) => {
      const on = this.tab === t.id;
      const badge = t.id === "failures" ? (unseen || null) : null;
      return h_flex().id(`tab-${t.id}`).relative().h(30).px(compact ? 9 : 12).gap(7).items_center().rounded(8).cursor_pointer()
        .text_size(13).font_medium().text_color(on ? c.foreground : c.muted)
        .bg(on ? c.raised : "#00000000").hover((s) => s.bg(on ? c.raised : c.hover))
        .on_click((_e, cx) => this.go(t.id, cx))
        .child(icon(t.icon, 14, on ? (t.id === "ask" ? c.brand : c.foreground) : c.dim))
        .when(!compact, (e) => e.child(div().child(t.label)))
        .when(Boolean(badge), (e) => e.child(h_flex().h(17).px(6).rounded(9).items_center().bg(c.err).text_color("#ffffff").text_size(10.5).font_bold().child(String(badge))));
    });
    return h_flex().id("header").h(52).flex_none().px(14).gap(14).items_center().justify_between().bg(c.chrome ?? c.surface).border_b(1).border_color(c.border)
      .child(h_flex().gap(10).items_center().min_w(0)
        .child(h_flex().size(30).flex_none().rounded(9).items_center().justify_center().bg(c.brand).child(icon("logo", 17, "#ffffff")))
        .child(v_flex().min_w(0).gap(0)
          .child(div().text_size(13.5).font_semibold().child("Flowdeck"))
          .child(h_flex().id("instance").gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.menu = !this.menu; cx.notify(); })
            .child(dot(d.error ? c.warn : live ? c.ok : c.dim, 7, Boolean(live)))
            .child(n8nMark(c, 7))
            .child(div().max_w(220).truncate().text_size(11.5).text_color(c.muted).child(p?.name ?? ""))
            .child(div().px(5).h(15).rounded(4).flex().items_center().text_size(9.5).font_bold().text_color(p?.mode === "demo" ? c.brand : c.dim).border(1).border_color(p?.mode === "demo" ? alpha(c.brand, 0.6) : c.border).child(modeTag))
            .when(Boolean(p?.insecure), (e) => e.child(h_flex().px(5).h(15).gap(3).rounded(4).items_center().text_size(9.5).font_bold().text_color(c.warn).border(1).border_color(alpha(c.warn, 0.6))
              .tooltip("Plain http: your key crosses this network unencrypted. Put n8n behind https to fix it.").child(icon("alert", 9, c.warn)).child(div().child("HTTP"))))
            .child(icon("chevron-down", 11, c.dim)))))
      .child(h_flex().gap(4).items_center().p(3).rounded(10).bg(alpha(c.foreground, 0.04)).children(nav))
      .child(h_flex().gap(8).items_center().flex_none()
        .when(!compact, (e) => e.child(div().text_size(11.5).text_color(d.error ? c.warn : c.dim).child(d.syncing ? "Syncing…" : d.error ? "Sync failed" : d.synced ? `Synced ${ago(d.synced)}` : "")))
        .child(button(c, { id: "refresh", iconName: "refresh", kind: "subtle", loading: d.syncing, tooltip: "Refresh now", onClick: (_e, cx) => cx.spawn(async (cx) => this.refresh(cx, { full: true })) }))
        .when(Boolean(inOverlay), (e) => e.child(button(c, { id: "popout", iconName: "external", kind: "subtle", tooltip: "Open as a tab", onClick: () => { closeOverlay(props().overlay); run("tab.new", { name: "n8n", mod: "flowdeck" }); } })))
        .child(button(c, { id: "menu", iconName: "settings", kind: "subtle", tooltip: "Instances and settings", onClick: (_e, cx) => { this.menu = !this.menu; cx.notify(); } })));
  }

  banner(c) {
    const e = this.data.error;
    if (!e) return div();
    const fix = e.kind === "auth" || e.kind === "nokey";
    return h_flex().id("banner").flex_none().mx(14).mt(10).px(12).py(9).gap(10).items_center().rounded(9)
      .bg(alpha(c.warn, 0.12)).border(1).border_color(alpha(c.warn, 0.45))
      .child(icon("alert", 15, c.warn))
      .child(div().flex_1().text_size(12.5).text_color(c.foreground).child(e.message))
      .when(fix, (el) => el.child(button(c, { id: "reconnect", label: "Reconnect", size: "sm", kind: "solid", onClick: (_e, cx) => {
        this.inputs.url.set_value(this.profile?.base ?? "");
        this.inputs.name.set_value(this.profile?.name ?? "");
        cx.spawn(async (cx) => { if (this.profile?.mode !== "demo") { await deleteSecret(this.profile.id, this.profile.base); setShared(PROFILES, this.profiles().filter((x) => x.id !== this.profile.id)); } this.showConnect(cx); cx.notify(); });
      } })))
      .when(!fix, (el) => el.child(button(c, { id: "retry", label: "Retry", size: "sm", onClick: (_e, cx) => cx.spawn(async (cx) => this.refresh(cx, { full: true })) })));
  }

  menuPanel(c) {
    const ps = this.profiles();
    const row = (id, iconName, text, sub, fn, { active = false, danger = false } = {}) => h_flex().id(id).px(10).py(8).gap(10).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(c.hover)).on_click((_e, cx) => fn(cx))
      .child(icon(iconName, 14, danger ? c.err : active ? c.brand : c.muted))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(12.5).text_color(danger ? c.err : c.foreground).child(text))
        .when(Boolean(sub), (e) => e.child(div().truncate().text_size(11).text_color(c.dim).child(sub))))
      .when(active, (e) => e.child(icon("check", 13, c.brand)));
    return div().id("menu-scrim").absolute().top(0).left(0).size_full()
      .on_mouse_down("left", (_e, cx) => { this.menu = false; cx.notify(); })
      .child(v_flex().id("menu").absolute().top(56).right(14).w(310).p(6).gap(2).rounded(11).bg(c.popover ?? c.surface).border(1).border_color(c.border).shadow_lg()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .opacity(1)
        .child(div().px(10).pt(6).pb(4).text_size(11).font_semibold().text_color(c.dim).child("INSTANCES"))
        .children(ps.map((p) => row(`p-${p.id}`, "key", p.name, `${p.base.replace(/^https?:\/\//, "")} · ${p.tail ?? ""}`, (cx) => this.switchTo(p.id, cx), { active: this.profile?.id === p.id })))
        .child(row("p-demo", "play", "Demo instance", "Made-up data, nothing leaves your machine", (cx) => this.switchTo("demo", cx), { active: this.profile?.mode === "demo" }))
        .child(row("add", "plus", "Connect another instance", null, (cx) => { this.menu = false; this.inputs.url.set_value(""); this.showConnect(cx, { adding: true }); cx.notify(); }))
        .child(div().h(1).bg(c.border).my(4))
        .child(div().px(10).pt(4).pb(2).text_size(11).font_semibold().text_color(c.dim).child("FOCUS SPRITE"))
        .child(h_flex().px(8).pb(4).gap(4).flex_wrap().children(SPRITES.map((sp) => {
          const on = spriteKind() === sp.id;
          return h_flex().id(`sprite-${sp.id}`).h(24).px(9).rounded(6).items_center().cursor_pointer().text_size(11.5).tooltip(sp.note)
            .bg(on ? alpha(c.brand, 0.16) : "#00000000").border(1).border_color(on ? alpha(c.brand, 0.6) : c.border).text_color(on ? c.foreground : c.muted)
            .hover((st) => st.bg(c.hover)).on_click((_e, cx) => { setShared(SPRITE_KEY, sp.id); cx.notify(); }).child(sp.label);
        })))
        .child(h_flex().px(10).py(4).gap(8).items_center()
          .child(div().flex_1().text_size(11.5).text_color(c.muted).child(`Motion${shared(MOTION_KEY) ? "" : this.systemReduce ? " (system: reduced)" : ""}`))
          .child(h_flex().gap(2).p(2).rounded(7).bg(alpha(c.foreground, 0.05)).children([["auto", "Auto"], ["reduce", "Reduce"], ["full", "Full"]].map(([id, text]) => {
            const on = (shared(MOTION_KEY) ?? "auto") === id;
            return h_flex().id(`motion-${id}`).h(22).px(8).rounded(5).items_center().cursor_pointer().text_size(11).text_color(on ? c.foreground : c.dim).bg(on ? c.raised : "#00000000")
              .on_click((_e, cx) => { setShared(MOTION_KEY, id === "auto" ? null : id); cx.notify(); }).child(text);
          }))))
        .child(div().h(1).bg(c.border).my(4))
        .child(v_flex().px(10).py(6).gap(4)
          .child(h_flex().gap(7).items_center().child(icon("shield", 13, c.ok)).child(div().flex_1().min_w(0).text_size(11.5).text_color(c.muted).child("Read-only. Flowdeck never changes your n8n.")))
          .child(h_flex().gap(7).items_center().child(icon("lock", 13, c.dim)).child(div().flex_1().min_w(0).text_size(11.5).text_color(c.muted)
            .child(this.profile?.mode === "demo" ? "Demo: no key stored." : `Key in ${this.profile?.vault === "session" ? "memory only" : this.vault === "secret-service" ? "the system keyring" : "the macOS Keychain"} ${this.profile?.tail ?? ""}`))))
        .when(this.profile?.mode !== "demo", (e) => e.child(row("disconnect", "trash", "Disconnect and forget key", "Removes the key from this machine", (cx) => cx.spawn(async (cx) => this.disconnect(cx)), { danger: true }))));
  }
}
