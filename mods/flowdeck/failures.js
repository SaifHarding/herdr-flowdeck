// Failures: every fault of the last week, grouped by workflow, node and error so a run that fails 200 times is one
// line. The chosen one shows what n8n said, a first idea of why, where it broke on the graph, and every run it hit.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { alpha, icon, button, chip, sparkline, empty, spinner, rise, mono, card } from "./ui.js";
import { graphView, GraphState } from "./graph.js";
import { ago, duration, durationOf, when, hint, startOf, plural, histogram, DAY } from "./model.js";
import { links } from "./n8n.js";

const TONE_ICON = { auth: "key", rate: "clock", network: "globe", code: "code", server: "cube", missing: "search" };

function rows(view, c, m, groups) {
  const sel = view.sel.failureKey;
  return v_flex().id("fail-rows").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
    .children(groups.map((g, i) => {
      const on = g.key === sel, h = hint(g);
      return h_flex().id(`fg-${i}`).px(10).py(10).gap(11).items_start().rounded(10).cursor_pointer()
        .bg(on ? alpha(c.err, 0.09) : "#00000000").border(1).border_color(on ? alpha(c.err, 0.4) : "#00000000")
        .hover((s) => s.bg(on ? alpha(c.err, 0.12) : c.hover))
        .on_click((_e, cx) => {
          view.sel.failureKey = g.key;
          view.failGraph = null;
          if (g.pending) cx.spawn(async (cx) => view.fetchRuns(g.runs.slice(0, 12).map((e) => String(e.id)), cx));
          cx.notify();
        })
        .child(h_flex().size(32).flex_none().rounded(9).items_center().justify_center().bg(alpha(c.err, 0.13))
          .child(icon(TONE_ICON[h?.tone] ?? "alert", 15, c.err)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).min_w(0)
            .child(div().truncate().text_size(12.8).font_semibold().child(g.workflow)))
          .child(div().truncate().text_size(11.5).text_color(c.dim).child(g.node ? `at ${g.node}` : `${plural(g.count, "run")} not yet looked at`))
          .child(div().text_size(12).text_color(c.muted).child(g.pending ? (g.runs.some((e) => view.data.pending.has(String(e.id))) ? "Loading details…" : "Older failures · select to load why") : (g.message ?? "Unknown error").slice(0, 140))))
        .child(v_flex().items_end().gap(5).flex_none()
          .child(h_flex().h(19).px(7).rounded(10).items_center().bg(c.err).text_color("#ffffff").text_size(11).font_bold().child(`${g.count}×`))
          .child(sparkline(c, { id: `fg-sp-${i}`, values: g.daily, color: alpha(c.err, 0.85), width: 58, height: 14 }))
          .child(div().text_size(10.8).text_color(c.dim).child(ago(startOf(g.latest), m.now))));
    }));
}

function detail(view, c, m, g) {
  const w = m.byId.get(g.workflowId);
  const run = view.data.runs.get(String(g.latest.id)) ?? null;
  const h = hint(g);
  const first = g.runs[g.runs.length - 1];
  const base = view.profile?.base;
  const demo = view.profile?.mode === "demo";
  const en = Boolean(view.entered.failures);
  if (!view.failGraph || view.failGraph.key !== g.key) { view.failGraph = new GraphState(); view.failGraph.key = g.key; view.failGraph.entered = true; view.failGraph.pad = 20; }
  const graph = w && !w.partial ? view.graphOf(w) : null;
  const toneColor = h?.tone === "rate" || h?.tone === "network" ? c.warn : h?.tone === "auth" ? c.brand : c.run;

  return v_flex().id("fail-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(20).gap(16)
    .child(h_flex().justify_between().items_start().gap(12).map(rise(en, 0, 6))
      .child(v_flex().min_w(0).gap(4)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().truncate().text_size(17).font_semibold().child(g.workflow))
          .when(Boolean(g.node), (e) => e.child(icon("chevron", 13, c.dim)).child(div().truncate().text_size(17).font_semibold().text_color(c.err).child(g.node))))
        .child(div().text_size(12).text_color(c.dim).child(`${plural(g.count, "failure")} in 7 days · ${g.last24} in the last 24h · first ${ago(startOf(first), m.now)}, last ${ago(startOf(g.latest), m.now)}`)))
      .child(h_flex().gap(8).flex_none()
        .child(button(c, { id: "explain", label: "Explain with Claude", iconName: "spark", kind: "primary", size: "sm",
          onClick: (_e, cx) => view.ask(`Why is "${g.node ?? "this workflow"}" failing in "${g.workflow}", and what exactly should I change to fix it?`, cx, { kind: "failure", workflowId: g.workflowId, runId: String(g.latest.id), label: `${g.workflow}${g.node ? ` › ${g.node}` : ""}` }) }))
        .child(button(c, { id: "show-graph", label: "Show in graph", iconName: "flow", size: "sm", onClick: (_e, cx) => view.showWorkflow(g.workflowId, cx, { runId: String(g.latest.id), node: g.node }) }))
        .when(!demo, (e) => e.child(button(c, { id: "open-run", iconName: "external", size: "sm", tooltip: "Open this run in n8n", onClick: () => view.openLink(links.execution(base, g.workflowId, g.latest.id)) })))))
    .when(Boolean(h), (e) => e.child(h_flex().px(13).py(11).gap(11).items_start().rounded(10).bg(alpha(toneColor, 0.1)).border(1).border_color(alpha(toneColor, 0.35)).map(rise(en, 60, 6))
      .child(icon(TONE_ICON[h.tone] ?? "spark", 15, toneColor))
      .child(div().flex_1().text_size(12.8).text_color(c.foreground).child(h.text))))
    .child(card(c).p(15).gap(10).map(rise(en, 120, 6))
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(11).font_semibold().text_color(c.dim).child("WHAT N8N SAID"))
        .when(Boolean(g.httpCode), (e) => e.child(div().px(7).h(18).rounded(5).flex().items_center().text_size(10.5).font_bold().font_family(mono()).bg(alpha(c.err, 0.14)).text_color(c.err).child(`HTTP ${g.httpCode}`))))
      .child(g.pending && !run ? h_flex().gap(8).items_center().child(spinner(13, c.dim)).child(div().text_size(12.5).text_color(c.muted).child("Loading the run…"))
        : div().text_size(14).font_medium().text_color(c.foreground).child(g.message ?? "n8n recorded a failure without a message."))
      .when(Boolean(g.description), (e) => e.child(div().p(10).rounded(8).bg(c.background).border(1).border_color(c.border).text_size(11.8).font_family(mono()).text_color(c.muted).child(g.description))))
    .when(Boolean(graph), (e) => e.child(card(c).id("fail-graph-card").h(330).overflow_hidden().map(rise(en, 180, 6))
      .child(h_flex().px(14).py(9).justify_between().items_center().border_b(1).border_color(c.border)
        .child(div().text_size(11).font_semibold().text_color(c.dim).child("WHERE IT BROKE · LATEST RUN"))
        .child(div().text_size(11).text_color(c.dim).child(run ? `${run.order.length} nodes ran before it stopped` : "")))
      .child(div().relative().flex_1().min_h(0).child(graphView(c, { id: "fail-graph", graph, state: view.failGraph, run, replay: null, selected: g.node, active: false, focus: g.node ? { node: g.node, mood: "error", label: `Failed at ${g.node}` } : null,
        onSelect: (_n, cx) => cx.notify(), onChange: (cx) => cx.notify() })))))
    .child(card(c).p(15).gap(10).map(rise(en, 240, 6))
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(11).font_semibold().text_color(c.dim).child("WHEN IT HAPPENED"))
        .child(div().text_size(11).text_color(c.dim).child("last 7 days, 6-hour slots")))
      .child(h_flex().id("fail-hist").h(46).w_full().items_end().gap(3).children(histogram(g.runs, m.now, 7 * DAY, 28).map((b, i) =>
        div().id(`fh-${i}`).flex_1().rounded(2).bg(b.err ? c.err : c.border).h(b.err ? Math.max(6, (b.err / Math.max(1, ...histogram(g.runs, m.now, 7 * DAY, 28).map((x) => x.err))) * 46) : 2)
          .tooltip(b.err ? `${plural(b.err, "failure")} · ${when(b.t, m.now)}` : when(b.t, m.now)))))
      .child(v_flex().gap(1).pt(4)
        .children(g.runs.slice(0, 8).map((e) => h_flex().id(`occ-${e.id}`).px(8).py(6).mx(-8).gap(10).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(c.hover))
          .on_click((_e, cx) => view.showWorkflow(g.workflowId, cx, { runId: String(e.id), node: g.node }))
          .child(div().w(70).flex_none().text_size(11.5).font_family(mono()).text_color(c.dim).child(`#${e.id}`))
          .child(div().flex_1().text_size(12).text_color(c.muted).child(when(startOf(e), m.now)))
          .child(div().w(70).flex_none().text_size(11.5).font_family(mono()).text_color(c.dim).child(duration(durationOf(e))))
          .child(icon("chevron", 12, c.dim))))
        .when(g.runs.length > 8, (e) => e.child(div().pt(4).text_size(11.5).text_color(c.dim).child(`and ${g.runs.length - 8} more`)))));
}

export function failuresView(view, c) {
  const m = view.derived();
  if (view.data.loading) return v_flex().size_full().items_center().justify_center().child(spinner(20, c.brand));
  if (!view.source?.has.executions) return empty(c, { iconName: "key", title: "Failures need an API key", body: "n8n's MCP server shares workflows but not their runs. Connect the same instance with an API key to see what's failing.",
    action: button(c, { id: "add-api", label: "Connect with an API key", iconName: "key", kind: "primary", onClick: (_e, cx) => { view.form.mode = "api"; view.inputs.url.set_value(view.profile?.base ?? ""); view.showConnect(cx, { adding: true }); cx.notify(); } }) });
  const f = view.sel.failFilter;
  const groups = m.groups.filter((g) => f !== "24h" || g.last24 > 0);
  if (!m.groups.length) return empty(c, { iconName: "check", title: "Nothing failing", body: "No run has failed in the last 7 days. Flowdeck will toast you the moment one does." });
  const g = groups.find((x) => x.key === view.sel.failureKey) ?? groups[0];
  if (g && view.sel.failureKey !== g.key) view.sel.failureKey = g.key;
  const total = m.groups.reduce((s, x) => s + x.count, 0);
  return h_flex().id("failures").size_full()
    .child(v_flex().w(410).flex_none().h_full().border_r(1).border_color(c.border).bg(c.chrome ?? c.surface)
      .child(v_flex().p(14).gap(10).border_b(1).border_color(c.border)
        .child(h_flex().justify_between().items_center()
          .child(div().text_size(14).font_semibold().child("Failures"))
          .child(div().text_size(11.5).text_color(c.dim).child(`${plural(total, "run")} · ${plural(m.groups.length, "cause")}`)))
        .child(h_flex().gap(6)
          .child(chip(c, { id: "ff-open", label: "Last 7 days", active: f !== "24h", onClick: (_e, cx) => { view.sel.failFilter = "open"; cx.notify(); } }))
          .child(chip(c, { id: "ff-24h", label: "Last 24h", count: m.groups.filter((x) => x.last24).length, active: f === "24h", onClick: (_e, cx) => { view.sel.failFilter = "24h"; cx.notify(); } }))))
      .child(groups.length ? rows(view, c, m, groups) : div().p(20).text_size(12).text_color(c.dim).text_center().child("Nothing failed in the last 24 hours.")))
    .child(g ? detail(view, c, m, g) : div().flex_1());
}
