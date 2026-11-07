// Ask Claude: questions about the whole instance, one workflow, or one failure, answered by the person's own Claude
// Code with no tools. The newest answer sits right under the question box and types itself out as it streams.
// Before the first question, Flowdeck says exactly what leaves the machine and waits for a yes.

import { div } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextView } from "gpui-base";
import { shared, setShared } from "herdr";
import { alpha, icon, button, chip, spinner, rise, mono, card } from "./ui.js";
import { buildContext, buildPrompt, SYSTEM_PROMPT } from "./model.js";
import { MODELS, startAsk, readAsk, cancelAsk, cleanupAsk } from "./claude.js";

const CONSENT = "flowdeck.ask-consent";
const MODEL = "flowdeck.ask-model";
const POLL = 160;
const MAX_MS = 4 * 60e3;

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
    const job = this.job;
    this.job = null;
    if (job) {
      const t = this.turns.find((p) => p.a.job === job)?.a;
      if (t) { t.streaming = false; t.stopped = true; }
      await cancelAsk(job);
    }
  }

  async ask(question, view, cx) {
    if (this.busy) return;
    if (!shared(CONSENT)) { this.pending = question; cx.notify(); return; }
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
      const m = view.derived();
      const workflow = scope.kind !== "all" ? m.byId.get(scope.workflowId) : null;
      const failure = scope.kind === "failure" ? m.groups.find((g) => g.latest && String(g.latest.id) === String(scope.runId)) ?? { latest: { id: scope.runId } } : null;
      const context = buildContext({ scope: workflow ? "workflow" : "all", workflows: view.data.workflows, stats: m.stats, groups: m.groups, runs: view.data.runs, workflow, failure, instance: view.profile?.name });
      a.chars = context.length;
      const job = await startAsk({ prompt: buildPrompt(context, history, question), system: SYSTEM_PROMPT, model: this.model });
      a.job = job;
      this.job = job;
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
    .child(h_flex().gap(10).items_center().child(icon("shield", 17, c.brand)).child(div().text_size(14).font_semibold().child("Before your first question")))
    .child(div().text_size(12.8).text_color(c.foreground).child(`To answer, Flowdeck sends ${what} to Claude, through your own Claude Code sign-in.`))
    .child(v_flex().gap(6)
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok)).child(div().text_size(12.3).text_color(c.muted).child("Never sent: credentials, pinned data, or the items your runs processed.")))
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok)).child(div().text_size(12.3).text_color(c.muted).child("Fields named like secrets, and values that look like keys or tokens, are masked first.")))
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok)).child(div().text_size(12.3).text_color(c.muted).child("Claude runs with every tool switched off: it can read what's sent and write an answer, nothing else."))))
    .child(h_flex().gap(10).pt(2)
      .child(button(c, { id: "consent-yes", label: "Ask Claude", iconName: "spark", kind: "primary", onClick: (_e, cx) => { setShared(CONSENT, true); const q = view.asking.pending; view.asking.pending = null; if (q) view.ask(q, cx); } }))
      .child(button(c, { id: "consent-no", label: "Not now", kind: "subtle", onClick: (_e, cx) => { view.asking.pending = null; cx.notify(); } })));
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
    .when(Boolean(md), (e) => e.child(TextView.markdown(`md-${t.id}`, t.streaming ? `${md} ▍` : md).selectable(true).text_size(13).text_color(c.foreground)
      .on_link_click((url) => openSafe(url))))
    .when(Boolean(t.error), (e) => e.child(h_flex().gap(8).items_start().child(icon("alert", 13, c.err)).child(div().flex_1().text_size(12.5).text_color(c.err).child(t.error))))
    .when(Boolean(t.stopped), (e) => e.child(div().text_size(11.5).text_color(c.dim).child("Stopped.")));
}

const question = (c, t) => h_flex().id(`turn-${t.id}`).justify_end().child(div().max_w("80%").px(14).py(9).rounded(14).bg(alpha(c.brand, 0.14)).border(1).border_color(alpha(c.brand, 0.3))
  .text_size(13).text_color(c.foreground).child(t.text));

// An answer is written by a model that read untrusted workflow text, so its links only open when they point at the
// person's own instance (through openLink's check) or n8n's documentation.
let openSafe = () => {};

export function askView(view, c) {
  openSafe = (url) => {
    const u = String(url);
    if (/^https:\/\/(docs\.n8n\.io|community\.n8n\.io)(\/|$)/.test(u)) view.openExternal(u);
    else view.openLink(u);
  };
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
  return v_flex().id("ask").size_full().overflow_y_scrollbar().items_center()
    .child(v_flex().w_full().max_w(860).px(20).py(20).gap(14)
      .child(composer.map(rise(en, 0, 8)))
      .when(Boolean(s.pending), (e) => e.child(consentCard(view, c)))
      .when(s.installed === false, (e) => e.child(h_flex().px(12).py(9).gap(9).items_center().rounded(9).bg(alpha(c.warn, 0.1)).border(1).border_color(alpha(c.warn, 0.4))
        .child(icon("alert", 13, c.warn)).child(div().text_size(12.3).child("Claude Code isn't installed here. Ask uses it to answer; everything else works without it."))))
      .when(!turns.length && !s.pending, (e) => e.child(v_flex().pt(18).gap(14).map(rise(en, 100, 8))
        .child(v_flex().items_center().gap(8)
          .child(h_flex().size(46).rounded(14).items_center().justify_center().bg(alpha(c.brand, 0.14)).child(icon("spark", 22, c.brand)))
          .child(div().text_size(16).font_semibold().child(s.scope.kind === "all" ? "Ask about your workflows" : `Ask about ${s.scope.label}`))
          .child(div().text_size(12.5).text_color(c.muted).child("Claude reads the structure and recent errors, then answers. Try one of these:")))
        .child(h_flex().flex_wrap().gap(10).justify_center().children(sug.map((q, i) => h_flex().id(`sug-${i}`).w(380).px(14).py(11).gap(10).items_center().rounded(11)
          .bg(c.surface).border(1).border_color(c.border).cursor_pointer().hover((st) => st.border_color(alpha(c.brand, 0.6)).bg(c.hover))
          .map(rise(en, 160 + i * 60, 8))
          .on_click((_e, cx) => view.ask(q, cx))
          .child(icon("spark", 13, c.brand)).child(div().flex_1().text_size(12.8).child(q)).child(icon("chevron", 12, c.dim)))))))
      .children(turns.map((p, i) => v_flex().id(`pair-${p.q.id}`).gap(10).child(question(c, p.q)).child(answer(c, p.a, i))))
      .when(turns.length > 0 && !busy, (e) => e.child(h_flex().justify_center().pt(4).child(button(c, { id: "ask-clear", label: "Clear conversation", size: "sm", kind: "subtle", onClick: (_e, cx) => { s.turns = []; cx.notify(); } })))));
}
