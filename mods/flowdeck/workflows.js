// Workflows: every workflow on the left with its last runs as a strip; the chosen one as a graph on the right, with
// any of its runs laid over it, a replay, and an inspector for the node you click.

import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { alpha, icon, button, chip, dot, runStrip, statusColor, empty, spinner, rise, mono } from "./ui.js";
import { graphView, graphControls } from "./graph.js";
import { ago, duration, durationOf, when, triggerOf, redact, nodeInfo, startOf, running, KINDS } from "./model.js";
import { links } from "./n8n.js";

const ORDER = { failing: 0, flaky: 1, healthy: 2, quiet: 3 };

export function sortedWorkflows(view) {
  const m = view.derived();
  const q = view.inputs.search.value().trim().toLowerCase();
  const f = view.sel.filter;
  return view.data.workflows
    .filter((w) => !q || w.name.toLowerCase().includes(q) || (w.tags ?? []).some((t) => String(t.name ?? t).toLowerCase().includes(q)) || (w.nodes ?? []).some((n) => n.name.toLowerCase().includes(q) || String(n.type).toLowerCase().includes(q)))
    .filter((w) => f === "all" || (f === "active" && w.active) || (f === "failing" && ["failing", "flaky"].includes(m.stats.get(w.id)?.health)))
    .sort((a, b) => {
      const sa = m.stats.get(a.id), sb = m.stats.get(b.id);
      if (a.active !== b.active) return a.active ? -1 : 1;
      const ha = ORDER[sa?.health ?? "quiet"], hb = ORDER[sb?.health ?? "quiet"];
      if (ha !== hb) return ha - hb;
      return startOf(sb?.last ?? {}) - startOf(sa?.last ?? {});
    });
}

const runsFor = (s) => (s?.runs ?? []).map((r) => ({ id: r.id, status: r.status ?? (r.finished ? "success" : "error"), ms: durationOf(r), tip: `${r.status} · ${when(startOf(r))} · ${duration(durationOf(r))}` }));

function list(view, c, m) {
  const ws = sortedWorkflows(view);
  const failingCount = [...m.stats.values()].filter((s) => s.health === "failing" || s.health === "flaky").length;
  const f = view.sel.filter;
  const setF = (id) => (_e, cx) => { view.sel.filter = id; cx.notify(); };
  return v_flex().id("wf-list").w(318).flex_none().h_full().border_r(1).border_color(c.border).bg(c.chrome ?? c.surface)
    .child(v_flex().p(12).gap(10).border_b(1).border_color(c.border)
      .child(h_flex().h(34).px(10).gap(8).items_center().rounded(8).border(1).border_color(c.input ?? c.border).bg(c.background).cursor_text()
        .child(icon("search", 13, c.dim)).child(Input.new(view.inputs.search).flex_1().h_full().text_size(12.5).text_color(c.foreground)))
      .child(h_flex().gap(6)
        .child(chip(c, { id: "f-all", label: "All", count: view.data.workflows.length, active: f === "all", onClick: setF("all") }))
        .child(chip(c, { id: "f-active", label: "Active", active: f === "active", onClick: setF("active") }))
        .child(chip(c, { id: "f-failing", label: "Failing", count: failingCount || null, color: c.err, active: f === "failing", onClick: setF("failing") }))))
    .child(v_flex().id("wf-rows").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .when(!ws.length, (e) => e.child(div().p(20).text_size(12).text_color(c.dim).text_center().child("No workflows match.")))
      .children(ws.slice(0, 400).map((w) => {
        const s = m.stats.get(w.id), on = view.sel.workflowId === w.id;
        const col = !w.active ? c.dim : statusColor(c, s?.health);
        return v_flex().id(`wf-${w.id}`).px(10).py(9).gap(6).rounded(9).cursor_pointer()
          .bg(on ? alpha(c.brand, 0.12) : "#00000000").border(1).border_color(on ? alpha(c.brand, 0.45) : "#00000000")
          .hover((st) => st.bg(on ? alpha(c.brand, 0.16) : c.hover))
          .on_click((_e, cx) => view.showWorkflow(w.id, cx))
          .child(h_flex().gap(8).items_center()
            .child(dot(col, 8, s?.health === "failing" && w.active))
            .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_medium().text_color(w.active ? c.foreground : c.muted).child(w.name))
            .when(Boolean(s?.fails24), (e) => e.child(h_flex().h(17).px(6).rounded(9).items_center().bg(alpha(c.err, 0.15)).text_color(c.err).text_size(10.5).font_semibold().child(`${s.fails24}✕`))))
          .child(h_flex().gap(8).items_center().pl(16)
            .child(div().flex_1().min_w(0).truncate().text_size(11.3).text_color(c.dim)
              .child(`${triggerOf(w)} · ${w.nodes?.length ?? "?"} nodes${w.active ? "" : " · off"}${s?.last ? ` · ${ago(startOf(s.last), m.now)}` : ""}`))
            .when(Boolean(s?.runs.length), (e) => e.child(runStrip(c, { id: `strip-${w.id}`, runs: runsFor(s), count: 14, height: 13, width: 3, gap: 1.5 }))));
      }))
      .when(ws.length > 400, (e) => e.child(div().p(10).text_size(11.5).text_color(c.dim).text_center().child(`Showing 400 of ${ws.length}. Search to narrow it down.`))));
}

function runBar(view, c, w, s, run) {
  const runs = runsFor(s);
  const sel = view.sel.runId;
  const e = s?.runs.find((r) => String(r.id) === String(sel));
  const st = e?.status;
  return h_flex().id("run-bar").px(16).py(10).gap(14).items_center().border_b(1).border_color(c.border).flex_none()
    .child(v_flex().gap(2).flex_none()
      .child(div().text_size(11).font_semibold().text_color(c.dim).child("RUNS · 7 DAYS"))
      .child(div().text_size(11.5).text_color(c.muted).child(view.source?.has.executions ? `${s?.runs.length ?? 0} runs, ${s?.fails7 ?? 0} failed` : "Needs an API key")))
    .child(div().flex_1().min_w(0).overflow_hidden().child(runs.length ? runStrip(c, { id: "big-strip", runs, count: 48, height: 22, width: 5, gap: 2, selected: sel, onPick: (r, cx) => view.pickRun(r.id, cx) }) : div().text_size(12).text_color(c.dim).child("No runs yet")))
    .when(Boolean(e), (el) => el.child(h_flex().gap(10).items_center().flex_none()
      .child(dot(statusColor(c, st), 8, running(e)))
      .child(v_flex().gap(1)
        .child(div().text_size(12.3).font_medium().child(`${st === "error" ? "Failed" : st === "success" ? "Succeeded" : st ?? "?"} · ${when(startOf(e))}`))
        .child(div().text_size(11.3).text_color(c.dim).child(run ? `${run.order.length} nodes ran · ${duration(durationOf(e))}${run.node ? ` · stopped at ${run.node}` : ""}` : view.data.pending.has(String(e.id)) ? "Loading run…" : `#${e.id} · ${duration(durationOf(e))}`)))
      .child(button(c, { id: "replay", label: view.replay ? "Stop" : "Replay", iconName: view.replay ? "stop" : "play", size: "sm", kind: view.replay ? "solid" : "ghost", disabled: !run?.order?.length,
        onClick: (_e, cx) => { if (view.replay) { view.stopReplay(); cx.notify(); } else view.startReplay(cx); } }))));
}

function inspector(view, c, w, run) {
  const n = (w.nodes ?? []).find((x) => x.name === view.sel.node);
  if (!n) return null;
  const info = nodeInfo(n.type);
  const o = run?.order.find((x) => x.name === n.name);
  const failedHere = run?.node === n.name;
  const params = JSON.stringify(redact(n.parameters ?? {}), null, 2);
  const shown = params.length > 6000 ? `${params.slice(0, 6000)}\n…` : params;
  return v_flex().id("inspector").w(320).flex_none().h_full().border_l(1).border_color(c.border).bg(c.surface)
    .child(h_flex().p(14).gap(10).items_center().border_b(1).border_color(c.border)
      .child(h_flex().size(34).flex_none().rounded(9).items_center().justify_center().bg(alpha(info.color, 0.18)).child(icon(info.icon, 17, info.color)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13.5).font_semibold().child(n.name))
        .child(div().truncate().text_size(11.5).text_color(c.dim).child(`${info.label} · ${KINDS[info.kind].label}${n.disabled ? " · disabled" : ""}`)))
      .child(button(c, { id: "insp-close", iconName: "close", kind: "subtle", size: "sm", onClick: (_e, cx) => { view.sel.node = null; cx.notify(); } })))
    .child(v_flex().id("insp-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(14)
      .when(Boolean(o || failedHere), (e) => e.child(v_flex().p(12).gap(6).rounded(10)
        .bg(alpha(failedHere ? c.err : c.ok, 0.09)).border(1).border_color(alpha(failedHere ? c.err : c.ok, 0.35))
        .child(h_flex().gap(8).items_center().child(icon(failedHere ? "alert" : "check", 13, failedHere ? c.err : c.ok))
          .child(div().text_size(12.5).font_semibold().child(failedHere ? "Failed in this run" : `Ran in ${duration(o?.ms)}`)))
        .when(failedHere && Boolean(run.message), (e2) => e2.child(div().text_size(12).text_color(c.foreground).child(run.message)))
        .when(failedHere && Boolean(run.description), (e2) => e2.child(div().text_size(11.5).font_family(mono()).text_color(c.muted).child(run.description)))
        .when((o?.runs ?? 0) > 1, (e2) => e2.child(div().text_size(11.5).text_color(c.dim).child(`Ran ${o.runs} times in this execution`)))
        .when(failedHere, (e2) => e2.child(h_flex().pt(4).child(button(c, { id: "insp-ask", label: "Ask Claude why", iconName: "spark", size: "sm", kind: "primary",
          onClick: (_e, cx) => view.ask(`Why did "${n.name}" fail in "${w.name}", and how do I fix it?`, cx, { kind: "failure", workflowId: w.id, runId: run.id, label: `${w.name} › ${n.name}` }) }))))))
      .when(Boolean(n.credentials), (e) => e.child(v_flex().gap(6).child(div().text_size(11).font_semibold().text_color(c.dim).child("CREDENTIALS"))
        .children(Object.keys(n.credentials).map((k) => h_flex().gap(7).items_center().child(icon("lock", 12, c.dim)).child(div().text_size(12).text_color(c.muted).child(k))))))
      .child(v_flex().gap(6)
        .child(h_flex().justify_between().child(div().text_size(11).font_semibold().text_color(c.dim).child("PARAMETERS")).child(div().text_size(10.5).text_color(c.dim).child("secrets hidden")))
        .child(div().p(10).rounded(8).bg(c.background).border(1).border_color(c.border).text_size(11.3).font_family(mono()).text_color(c.muted).child(shown === "{}" ? "No parameters set" : shown))));
}

export function workflowsView(view, c) {
  const m = view.derived();
  if (view.data.loading) return v_flex().size_full().items_center().justify_center().child(spinner(20, c.brand));
  if (!view.data.workflows.length) return empty(c, { iconName: "flow", title: "No workflows", body: "This key can't see any workflows yet." });
  const w = m.byId.get(view.sel.workflowId);
  const s = w ? m.stats.get(w.id) : null;
  const run = view.sel.runId ? view.data.runs.get(String(view.sel.runId)) ?? null : null;
  const graph = w && !w.partial ? view.graphOf(w) : null;
  const base = view.profile?.base;
  const notify = (cx) => cx.notify();

  let main;
  if (!w) main = empty(c, { iconName: "flow", title: "Pick a workflow", body: "Its graph, runs and nodes show up here." });
  else {
    const head = h_flex().id("wf-head").px(16).py(12).gap(12).items_center().justify_between().border_b(1).border_color(c.border).flex_none()
      .child(v_flex().min_w(0).gap(3)
        .child(h_flex().gap(9).items_center().min_w(0)
          .child(div().truncate().text_size(16).font_semibold().child(w.name))
          .child(h_flex().h(19).px(7).gap(5).rounded(10).items_center().text_size(10.5).font_semibold()
            .bg(alpha(w.active ? c.ok : c.dim, 0.15)).text_color(w.active ? c.ok : c.dim)
            .child(dot(w.active ? c.ok : c.dim, 6, w.active)).child(div().child(w.active ? "Active" : "Inactive"))))
        .child(div().truncate().text_size(11.8).text_color(c.dim).child(`${triggerOf(w)} trigger · ${(w.nodes ?? []).length} nodes${(w.tags ?? []).length ? ` · ${(w.tags ?? []).map((t) => `#${t.name ?? t}`).join(" ")}` : ""}${w.updatedAt ? ` · edited ${ago(Date.parse(w.updatedAt), m.now)}` : ""}`)))
      .child(h_flex().gap(8).flex_none()
        .child(button(c, { id: "wf-ask", label: "Ask about this", iconName: "spark", size: "sm", onClick: (_e, cx) => {
          view.asking.scope = { kind: "workflow", workflowId: w.id, label: w.name };
          view.go("ask", cx);
        } }))
        .when(view.profile?.mode !== "demo", (e) => e.child(button(c, { id: "wf-open", label: "Open in n8n", iconName: "external", size: "sm", onClick: () => view.openLink(links.workflow(base, w.id)) }))));
    const canvas = w.partial
      ? v_flex().flex_1().items_center().justify_center().gap(10).child(w.detailError ? icon("alert", 18, c.warn) : spinner(18, c.brand)).child(div().text_size(12).text_color(c.muted).child(w.detailError ?? "Loading the workflow…"))
      : div().id("canvas-wrap").relative().flex_1().min_w(0).h_full()
        .child(graphView(c, { id: "graph", graph, state: view.graph, run, replay: view.replay, selected: view.sel.node, active: w.active,
          onSelect: (name, cx) => { view.sel.node = name; cx.notify(); }, onChange: notify }))
        .child(div().absolute().bottom(14).right(14).child(graphControls(c, { id: "gc", state: view.graph, graph, onChange: notify })))
        .child(h_flex().absolute().bottom(14).left(14).gap(12).px(10).py(6).rounded(8).bg(alpha(c.surface, 0.9)).border(1).border_color(c.border).text_size(11).text_color(c.muted)
          .when(Boolean(run), (e) => e
            .child(h_flex().gap(5).items_center().child(dot(c.ok, 7)).child(div().child("ran")))
            .child(h_flex().gap(5).items_center().child(dot(c.err, 7)).child(div().child("failed")))
            .child(h_flex().gap(5).items_center().child(div().size(7).rounded(4).bg(c.dim).opacity(0.5)).child(div().child("not reached"))))
          .when(!run, (e) => e.child(div().child(view.source?.has.executions ? "Pick a run above to see its path" : "Drag to pan · ⌘-scroll to zoom"))))
        .when(Boolean(view.replay), (e) => e.child(h_flex().absolute().top(14).left(14).gap(8).px(11).py(7).items_center().rounded(8).bg(c.popover ?? c.surface).border(1).border_color(alpha(c.run, 0.5)).shadow_md()
          .child(spinner(12, c.run)).child(div().text_size(12).child(`Replaying · ${Math.min(view.replay.step, view.replay.total)} of ${view.replay.total}`))));
    main = v_flex().flex_1().min_w(0).h_full()
      .child(head)
      .when(Boolean(view.source?.has.executions), (e) => e.child(runBar(view, c, w, s, run)))
      .child(h_flex().flex_1().min_h(0).w_full().items_stretch().child(canvas).when(Boolean(view.sel.node), (e) => e.child(inspector(view, c, w, run) ?? div())));
  }
  return h_flex().id("workflows").size_full().child(list(view, c, m)).child(main);
}
