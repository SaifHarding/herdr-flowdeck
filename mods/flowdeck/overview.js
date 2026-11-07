// Overview: how the instance is doing right now. Five numbers, the last day of runs hour by hour, what needs
// attention, the busiest workflows and a live feed of runs as they land.

import { div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { alpha, icon, kpi, card, stackedBars, sparkline, dot, statusColor, rise, empty, button, MOTION, mono } from "./ui.js";
import { ago, duration, plural, clock, hint, startOf, running, DAY, weekday } from "./model.js";

function ring(c, rate, size = 40) {
  const r = size / 2 - 4, cx = size / 2, cy = size / 2, w = 5;
  const bg = PathBuilder.stroke(w).move_to(cx, cy - r).arc_to(r, r, 0, false, true, cx, cy + r).arc_to(r, r, 0, false, true, cx, cy - r).build();
  const v = Math.max(0.0001, Math.min(0.9999, rate ?? 0));
  const a = v * Math.PI * 2;
  const fg = PathBuilder.stroke(w).move_to(cx, cy - r).arc_to(r, r, 0, v > 0.5, true, cx + r * Math.sin(a), cy - r * Math.cos(a)).build();
  const col = rate === null ? c.dim : rate >= 0.97 ? c.ok : rate >= 0.85 ? c.warn : c.err;
  return div().relative().size(size).flex_none()
    .child(window.paint_path(bg, alpha(c.foreground, 0.1)).absolute().top(0).left(0).size(size))
    .when(rate !== null, (e) => e.child(window.paint_path(fg, col).absolute().top(0).left(0).size(size)));
}

const delta = (now, prev, goodWhenDown) => {
  if (!prev && !now) return { text: "no change", color: null };
  if (!prev) return { text: "new today", color: null };
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return { text: "same as yesterday", color: null };
  const up = pct > 0;
  return { text: `${up ? "▲" : "▼"} ${Math.abs(pct)}% vs yesterday`, good: goodWhenDown ? !up : up };
};

function greeting(now) {
  const h = new Date(now).getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function chartCard(view, c, m, en) {
  const wide = view.overviewSpan === "7d";
  const bins = wide ? m.daily : m.hourly;
  const span = wide ? 7 * DAY : DAY;
  const step = span / bins.length;
  const hov = view.hoverBar;
  const b = hov !== null && hov !== undefined ? bins[hov] : null;
  const total = bins.reduce((s, x) => s + x.ok + x.err + x.run, 0), errs = bins.reduce((s, x) => s + x.err, 0);
  const labelAt = (t) => (wide ? weekday(t) : clock(t));
  const ticks = wide ? [0, 4, 8, 12, 16, 20, 24] : [0, 6, 12, 18];
  const seg = (id, text) => h_flex().id(`span-${id}`).h(24).px(9).items_center().rounded(6).cursor_pointer().text_size(11.5)
    .text_color(view.overviewSpan === id || (!view.overviewSpan && id === "24h") ? c.foreground : c.dim)
    .bg(view.overviewSpan === id || (!view.overviewSpan && id === "24h") ? c.raised : "#00000000")
    .on_click((_e, cx) => { view.overviewSpan = id; view.entered.overview = false; cx.timer.after(40, (cx) => { view.entered.overview = true; cx.notify(); }); cx.notify(); })
    .child(text);
  return card(c).id("activity").flex_1().min_w(0).p(16).gap(14).map(rise(en, 220))
    .child(h_flex().justify_between().items_start()
      .child(v_flex().gap(3)
        .child(div().text_size(13).font_semibold().child("Activity"))
        .child(div().text_size(12).text_color(c.muted).child(b
          ? `${wide ? `${weekday(b.t, false)} ${clock(b.t)}–${clock(b.t + step)}` : `${clock(b.t)}–${clock(b.t + step)}`} · ${b.ok} succeeded · ${b.err} failed${b.run ? ` · ${b.run} running` : ""}`
          : `${plural(total, "run")} · ${plural(errs, "failure")} in the last ${wide ? "7 days" : "24 hours"}`)))
      .child(h_flex().gap(2).p(2).rounded(8).bg(alpha(c.foreground, 0.05)).child(seg("24h", "24h")).child(seg("7d", "7 days"))))
    .child(stackedBars(c, { id: "bars", bins, height: 120, entered: en, gap: wide ? 3 : 4, hovered: hov, onHover: (i, cx) => { view.hoverBar = i; cx.notify(); } }))
    .child(div().relative().h(14).w_full().children(ticks.map((i) => div().absolute().top(0).left(`${(i / bins.length) * 100}%`).text_size(10.5).font_family(mono()).text_color(c.dim)
      .child(i === bins.length ? "now" : labelAt(bins[i]?.t ?? Date.now())))))
    .child(h_flex().gap(14).text_size(11.5).text_color(c.muted)
      .child(h_flex().gap(6).items_center().child(dot(c.ok, 8)).child(div().child("Succeeded")))
      .child(h_flex().gap(6).items_center().child(dot(c.err, 8)).child(div().child("Failed")))
      .child(h_flex().gap(6).items_center().child(dot(c.run, 8)).child(div().child("Running"))));
}

function busiest(view, c, m, en) {
  const rows = view.data.workflows.map((w) => ({ w, s: m.stats.get(w.id) })).filter((x) => x.s?.runs24).sort((a, b) => b.s.runs24 - a.s.runs24).slice(0, 6);
  const max = Math.max(1, ...rows.map((r) => r.s.runs24));
  return card(c).id("busiest").w(340).flex_none().p(16).gap(12).map(rise(en, 280))
    .child(div().text_size(13).font_semibold().child("Busiest today"))
    .when(!rows.length, (e) => e.child(div().text_size(12).text_color(c.dim).child("Nothing has run in the last day.")))
    .children(rows.map((r, i) => v_flex().id(`busy-${r.w.id}`).gap(5).cursor_pointer().on_click((_e, cx) => view.showWorkflow(r.w.id, cx))
      .child(h_flex().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(c.foreground).child(r.w.name))
        .child(div().flex_none().text_size(11.5).font_family(mono()).text_color(r.s.fails24 ? c.err : c.muted).child(r.s.fails24 ? `${r.s.runs24} · ${r.s.fails24}✕` : String(r.s.runs24))))
      .child(div().relative().h(6).w_full().rounded(3).bg(alpha(c.foreground, 0.07))
        .child(div().absolute().top(0).left(0).h_full().rounded(3).bg(r.s.fails24 ? c.warn : c.run)
          .w(en ? `${(r.s.runs24 / max) * 100}%` : "0%").transition("width", { ...MOTION.bar, delay: 300 + i * 60 })))));
}

function attention(view, c, m, en) {
  const groups = m.groups.slice(0, 5);
  return card(c).id("attention").flex_1().min_w(0).p(16).gap(8).map(rise(en, 340))
    .child(h_flex().justify_between().items_center()
      .child(div().text_size(13).font_semibold().child("Needs attention"))
      .when(m.groups.length > 5, (e) => e.child(button(c, { id: "all-fails", label: `All ${m.groups.length}`, size: "sm", kind: "subtle", onClick: (_e, cx) => view.go("failures", cx) }))))
    .when(!groups.length, (e) => e.child(h_flex().py(18).gap(10).items_center().justify_center()
      .child(icon("check", 16, c.ok)).child(div().text_size(12.5).text_color(c.muted).child(view.source?.has.executions ? "No failures in the last 7 days. Nice." : "Failures need an API key: MCP doesn't share run history."))))
    .children(groups.map((g, i) => {
      const h = hint(g);
      return h_flex().id(`att-${i}`).px(10).py(9).mx(-10).gap(11).items_center().rounded(9).cursor_pointer().hover((s) => s.bg(c.hover))
        .on_click((_e, cx) => { view.sel.failureKey = g.key; view.go("failures", cx); })
        .child(h_flex().size(30).flex_none().rounded(8).items_center().justify_center().bg(alpha(c.err, 0.13)).child(icon(h?.tone === "auth" ? "key" : h?.tone === "rate" ? "clock" : h?.tone === "code" ? "code" : "alert", 14, c.err)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).min_w(0).child(div().truncate().text_size(12.5).font_medium().child(g.workflow))
            .when(Boolean(g.node), (e) => e.child(div().flex_none().text_size(11.5).text_color(c.dim).child(`› ${g.node}`))))
          .child(div().truncate().text_size(11.8).text_color(c.muted).child(g.pending ? "Loading details…" : g.message ?? "Unknown error")))
        .child(v_flex().items_end().gap(3).flex_none()
          .child(sparkline(c, { id: `att-sp-${i}`, values: g.daily, color: c.err, width: 56, height: 14 }))
          .child(div().text_size(10.5).text_color(c.dim).child(`${g.count}× · ${ago(startOf(g.latest), m.now)}`)));
    }));
}

function feed(view, c, m, en) {
  const list = view.data.executions.slice(0, 11);
  return card(c).id("feed").flex_1().min_w(0).p(16).gap(4).map(rise(en, 400))
    .child(h_flex().justify_between().items_center().pb(4)
      .child(h_flex().gap(8).items_center().child(div().text_size(13).font_semibold().child("Live runs")).child(dot(c.ok, 7, true)))
      .child(div().text_size(11.5).text_color(c.dim).child(m.kpis.running ? `${m.kpis.running} running now` : "")))
    .when(!list.length, (e) => e.child(div().py(18).text_size(12.5).text_color(c.dim).text_center().child(view.source?.has.executions ? "No runs in the last 7 days." : "Run history needs an API key.")))
    .children(list.map((e) => {
      const w = m.byId.get(e.workflowId);
      const st = e.status ?? (e.finished ? "success" : "error");
      const col = statusColor(c, st);
      return h_flex().id(`feed-${e.id}`).px(10).py(7).mx(-10).gap(10).items_center().rounded(8).cursor_pointer().hover((s) => s.bg(c.hover))
        .on_click((_e, cx) => view.showWorkflow(e.workflowId, cx, { runId: String(e.id) }))
        .child(dot(col, 8, running(e)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(w?.name ?? `Workflow ${e.workflowId}`))
        .child(div().flex_none().text_size(11).text_color(c.dim).child(e.mode ?? ""))
        .child(div().w(64).flex_none().text_size(11.5).font_family(mono()).text_color(c.muted).child(running(e) ? "running" : duration(e.stoppedAt ? Date.parse(e.stoppedAt) - Date.parse(e.startedAt) : null)))
        .child(div().w(58).flex_none().text_size(11.5).text_color(c.dim).child(ago(startOf(e), m.now)));
    }));
}

export function overviewView(view, c) {
  const d = view.data, m = view.derived(), k = m.kpis, en = Boolean(view.entered.overview);
  if (d.loading) return v_flex().size_full().items_center().justify_center().gap(12).child(div().size(10)).child(div().text_size(12.5).text_color(c.muted).child("Loading your workflows…"));
  if (!d.workflows.length) return empty(c, { iconName: "flow", title: "No workflows yet", body: "This instance has no workflows the key can see." });
  const narrow = (view.size?.width ?? 1200) < 980;
  const runsD = delta(k.runs, k.runsPrev, false), failD = delta(k.failures, k.failuresPrev, true);
  const failingNow = [...m.stats.values()].filter((s) => s.health === "failing").length;
  const noRuns = !view.source?.has.executions;
  const row = (kids) => (narrow ? v_flex() : h_flex().items_start()).gap(14).w_full().children(kids);
  return v_flex().id("overview").size_full().overflow_y_scrollbar().px(20).py(18).gap(14)
    .child(h_flex().justify_between().items_end().map(rise(en, 0, 6))
      .child(v_flex().gap(4)
        .child(div().text_size(20).font_semibold().child(greeting(m.now)))
        .child(div().text_size(13).text_color(c.muted).child(`${k.active} of ${plural(k.workflows, "workflow")} active${failingNow ? ` · ${failingNow} failing on the last run` : " · all healthy on their last run"}${noRuns ? " · connected over MCP, run history needs an API key" : ""}`))))
    .child(h_flex().gap(12).w_full().flex_wrap()
      .child(kpi(c, { id: "k-runs", title: "Runs · 24h", value: noRuns ? "–" : k.runs, sub: noRuns ? "needs an API key" : runsD.text, iconName: "pulse", accent: c.run, entered: en, delay: 40 }))
      .child(kpi(c, { id: "k-rate", title: "Success rate", value: k.success === null ? "–" : `${(k.success * 100).toFixed(k.success > 0.995 ? 1 : 1)}%`, sub: k.success === null ? "no finished runs" : `${(k.runs - k.failures - k.running)} of ${(k.runs - k.running)} finished ok`, iconName: "check", accent: c.ok, entered: en, delay: 80, extra: ring(c, k.success) }))
      .child(kpi(c, { id: "k-fail", title: "Failures · 24h", value: noRuns ? "–" : String(k.failures), sub: noRuns ? "needs an API key" : failD.text, subColor: failD.good === false ? c.err : failD.good ? c.ok : null, iconName: "alert", accent: c.err, entered: en, delay: 120 }))
      .child(kpi(c, { id: "k-dur", title: "Median run", value: duration(k.median), sub: k.running ? `${k.running} running now` : "across all workflows", iconName: "clock", accent: c.brand2, entered: en, delay: 160 }))
      .child(kpi(c, { id: "k-wf", title: "Active workflows", value: `${k.active}/${k.workflows}`, sub: `${plural(d.workflows.filter((w) => !w.active).length, "inactive", "inactive")}`, iconName: "flow", accent: c.brand, entered: en, delay: 200 })))
    .child(row([chartCard(view, c, m, en), narrow ? busiest(view, c, m, en).w_full() : busiest(view, c, m, en)]))
    .child(row([attention(view, c, m, en), feed(view, c, m, en)]));
}
