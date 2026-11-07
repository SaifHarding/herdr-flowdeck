// The workflow as a picture: cards where the person put the nodes in n8n, curves between them, and a run laid over
// the top: what ran glows green, the node that failed pulses red, what the run never reached fades back. Replay walks
// a run node by node. Drag or scroll to pan, ⌘/Ctrl-scroll or the buttons to zoom, double-click to fit.
//
// Paths are built in screen units for the current zoom and cached; panning only moves the layer they sit in.

import { div, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { edgeCurve, travelled, CARD } from "./model.js";
import { alpha, icon, spinner, MOTION, mono } from "./ui.js";

const GLIDE = { response: 420, damping: 0.92 };
const SNAP = { response: 300, damping: 1, epsilon: 100000 };
const MIN_Z = 0.25, MAX_Z = 2;

export class GraphState {
  constructor() {
    this.zoom = 1;
    this.x = 0;
    this.y = 0;
    this.size = null;
    this.fitted = null;
    this.dragging = null;
    this.moved = false;
    this.glide = false;
    this.cache = new Map();
    this.entered = false;
  }

  // Fits the whole graph in view, centred, no bigger than a little over life size.
  fit(graph, animate = true) {
    if (!this.size || !graph?.nodes.length) return;
    const { width: W, height: H } = this.size;
    // `pad` leaves room for the controls laid over a big graph; a small one fills its card.
    const pad = this.pad ?? 96;
    const z = Math.max(MIN_Z, Math.min(1.1, (W - pad / 2) / graph.width, (H - pad) / graph.height));
    this.zoom = Math.round(z * 100) / 100;
    this.x = (W - graph.width * this.zoom) / 2;
    this.y = Math.max(pad / 6, (H - graph.height * this.zoom) / 2 - pad / 8);
    this.glide = animate;
  }

  // Centres one node at a readable zoom: the camera that follows Flo in a narrow panel.
  follow(graph, name, animate = true) {
    const n = graph?.nodes.find((x) => x.name === name);
    if (!this.size || !n) return;
    const { width: W, height: H } = this.size;
    this.zoom = Math.max(0.55, Math.min(0.9, (W - 40) / (CARD.w * 2.2)));
    this.x = W / 2 - (n.x + n.w / 2) * this.zoom;
    this.y = H / 2 - (n.y + n.h / 2) * this.zoom + 18;
    this.glide = animate;
  }

  zoomBy(factor, at) {
    if (!this.size) return;
    const z = Math.max(MIN_Z, Math.min(MAX_Z, this.zoom * factor));
    const px = at?.x ?? this.size.width / 2, py = at?.y ?? this.size.height / 2;
    // Keep the point under the pointer where it is.
    this.x = px - ((px - this.x) * z) / this.zoom;
    this.y = py - ((py - this.y) * z) / this.zoom;
    this.zoom = z;
  }
}

function strokePath(width, dash) {
  const p = PathBuilder.stroke(width);
  if (dash) p.dash_array(dash);
  return p;
}

function addCurve(path, curve, z) {
  const [sx, sy] = curve.start;
  path.move_to(sx * z, sy * z);
  for (const [c1, c2, to] of curve.segs) path.cubic_bezier_to(to[0] * z, to[1] * z, c1[0] * z, c1[1] * z, c2[0] * z, c2[1] * z);
}

const keyOf = (e) => `${e.from}→${e.to}`;

// What each node looks like for this run (or replay step): ok, error, running, skipped, or nothing to say.
function nodeStates(run, replay) {
  const states = new Map();
  if (!run?.order?.length) return states;
  const shown = replay ? run.order.slice(0, replay.step) : run.order;
  for (const o of shown) states.set(o.name, o.status === "error" ? "error" : o.status === "running" ? "running" : "ok");
  if (replay && replay.step < run.order.length) {
    const next = run.order[replay.step];
    if (next) states.set(next.name, "running");
  }
  if (!replay && run.node && !states.has(run.node)) states.set(run.node, "error");
  return states;
}

function paths(state, graph, z, run, replay, c) {
  const hl = run ? `${run.id}|${replay ? replay.step : "all"}` : "none";
  const key = `${graph.key}|${z}|${hl}|${c.dark}`;
  const hit = state.cache.get(key);
  if (hit) return hit;
  if (state.cache.size > 40) state.cache.clear();
  const order = run ? (replay ? run.order.slice(0, replay.step + 1) : run.order) : [];
  const went = run ? travelled(graph, order) : new Set();
  const failedInto = run?.node && !replay ? run.node : null;
  const sw = Math.max(1, 1.6 * z);
  const base = strokePath(sw), ai = strokePath(sw, [4 * z, 4 * z]), hot = strokePath(sw * 1.6), bad = strokePath(sw * 1.6);
  const arrows = PathBuilder.fill(), hotArrows = PathBuilder.fill();
  let nBase = 0, nAi = 0, nHot = 0, nBad = 0, nArrow = 0, nHotArrow = 0;
  for (const e of graph.edges) {
    const curve = edgeCurve(e, graph);
    const lit = went.has(keyOf(e));
    const into = lit && failedInto === e.to;
    if (e.ai) { addCurve(lit ? hot : ai, curve, z); lit ? nHot++ : nAi++; continue; }
    addCurve(into ? bad : lit ? hot : base, curve, z);
    into ? nBad++ : lit ? nHot++ : nBase++;
    const [x, y] = e.p2, a = 7 * z, b = 4.5 * z;
    (lit ? hotArrows : arrows).add_polygon([[x * z, y * z], [x * z - a, y * z - b], [x * z - a, y * z + b]], true);
    lit ? nHotArrow++ : nArrow++;
  }
  const out = {
    base: nBase ? base.build() : null, ai: nAi ? ai.build() : null, hot: nHot ? hot.build() : null, bad: nBad ? bad.build() : null,
    arrows: nArrow ? arrows.build() : null, hotArrows: nHotArrow ? hotArrows.build() : null,
  };
  state.cache.set(key, out);
  return out;
}

function grid(state, c) {
  const s = state.size;
  if (!s) return null;
  const step = 22 * state.zoom < 10 ? 44 * state.zoom : 22 * state.zoom;
  const ox = ((state.x % step) + step) % step, oy = ((state.y % step) + step) % step;
  const key = `grid|${Math.round(s.width)}x${Math.round(s.height)}|${step.toFixed(2)}|${ox.toFixed(0)},${oy.toFixed(0)}`;
  let path = state.cache.get(key);
  if (!path) {
    const b = PathBuilder.fill(), r = 0.8;
    for (let x = ox; x < s.width; x += step) for (let y = oy; y < s.height; y += step) b.add_polygon([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]], true);
    path = b.build();
    for (const k of state.cache.keys()) if (k.startsWith("grid|")) state.cache.delete(k);
    state.cache.set(key, path);
  }
  return window.paint_path(path, alpha(c.foreground, c.dark ? 0.09 : 0.12)).absolute().top(0).left(0).w(s.width).h(s.height);
}

function nodeCard(c, n, z, st, { selected, onSelect, entered, index, runInfo }) {
  const w = n.w * z, h = n.h * z, r = (n.info.sub ? n.h / 2 : 11) * z;
  const ring = st === "error" ? c.err : st === "ok" ? c.ok : st === "running" ? c.run : selected ? c.brand : c.border;
  const dimmed = st === "skip";
  const tile = (n.info.sub ? 24 : 32) * z;
  const showType = z >= 0.6 && !n.info.sub, showName = z >= 0.42;
  const delay = 40 + index * 45;
  let el = div().id(`node-${n.name}`).absolute().left(n.x * z).top(n.y * z).w(w).h(h)
    .opacity(!entered ? 0 : dimmed ? 0.4 : n.disabled ? 0.5 : 1).transition("opacity", { ...MOTION.fade, delay: entered ? 0 : delay });
  // A soft halo behind a failed or running node, breathing.
  if (st === "error" || st === "running") {
    el = el.child(div().absolute().left(-5 * z).top(-5 * z).w(w + 10 * z).h(h + 10 * z).rounded(r + 5 * z).bg(alpha(ring, 0.22))
      .loop("opacity", { from: 0.25, to: 1, period: st === "error" ? 1300 : 900 }));
  }
  const body = h_flex().id(`node-body-${n.name}`).absolute().left(0).top(0).w(w).h(h).rounded(r).px(9 * z).gap(9 * z).items_center()
    .bg(c.surface).border(selected || st ? Math.max(1, 1.6 * z) : 1).border_color(ring)
    .when(selected, (e) => e.shadow_lg())
    .cursor_pointer().hover((s) => s.border_color(selected ? c.brand : alpha(c.brand, 0.6)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onSelect(n.name, cx))
    .tooltip(runInfo ? `${n.name} · ${runInfo}` : `${n.name} · ${n.info.label}`)
    .child(h_flex().size(tile).flex_none().rounded((n.info.sub ? tile / 2 : 8 * z)).items_center().justify_center()
      .bg(alpha(n.info.color, c.dark ? 0.18 : 0.16)).child(icon(n.info.icon, Math.max(8, tile * 0.52), n.info.color)))
    .when(showName, (e) => e.child(v_flex().flex_1().min_w(0).gap(1 * z)
      .child(div().truncate().text_size(Math.max(9, 12.5 * z)).font_semibold().text_color(c.foreground).child(n.name))
      .when(showType, (e2) => e2.child(div().truncate().text_size(Math.max(8, 10.5 * z)).text_color(c.dim)
        .child(n.disabled ? `${n.info.label} · off` : n.info.label)))));
  el = el.child(body);
  // A badge on the corner saying how the node did.
  if (st === "ok" || st === "error" || st === "running") {
    const bs = Math.max(12, 18 * z);
    const badge = h_flex().absolute().left(w - bs * 0.6).top(-bs * 0.4).size(bs).rounded(bs / 2).items_center().justify_center()
      .bg(st === "running" ? c.surface : ring).border(1.5).border_color(c.canvas ?? c.background)
      .child(st === "running" ? spinner(bs * 0.7, c.run) : icon(st === "ok" ? "check" : "close", bs * 0.6, "#ffffff"));
    el = el.child(badge);
  }
  if (n.info.trigger) {
    const s = Math.max(10, 14 * z);
    el = el.child(h_flex().absolute().left(-s * 0.55).top(h / 2 - s / 2).size(s).rounded(s / 2).items_center().justify_center()
      .bg(n.info.color).child(icon("bolt", s * 0.62, "#ffffff")));
  }
  return el;
}

// Flo, the focus sprite: stands on top of the node that has the attention (the one a replay is running, the one that
// failed, the one Claude is talking about) and hops to the next with a bouncy spring. It turns to face where it's
// going, bobs while it waits, and says how things are going in a bubble: thinking dots, a red "!", a green tick.
const HOP = { response: 620, damping: 0.6 };
const MOODS = { think: { text: null }, error: { text: "!" }, ok: { text: "✓" }, look: { text: null } };

function sprite(c, state, graph, z, focus) {
  const n = graph.nodes.find((x) => x.name === focus?.node);
  if (!n) return null;
  const S = Math.round(Math.max(30, Math.min(52, 46 * (0.5 + z * 0.55))));
  // Standing on the middle of the card's top edge, clear of the status badge on its corner.
  const x = n.x * z + (n.w * z) / 2 - S / 2, y = n.y * z - S + 4;
  if (state.flo && Math.abs(state.flo.x - x) > 2) state.flo.facing = x < state.flo.x ? "l" : "r";
  state.flo = { x, facing: state.flo?.facing ?? "r" };
  const mood = MOODS[focus.mood] ? focus.mood : "look";
  const tone = mood === "error" ? c.err : mood === "ok" ? c.ok : c.brand;
  const bubble = mood === "think"
    ? h_flex().absolute().left(S * 0.55).top(-15).h(16).px(6).rounded(8).items_center().bg(c.popover ?? c.surface).border(1).border_color(alpha(c.brand, 0.6))
      .child(div().w(16).text_size(10).font_bold().text_color(c.brand).frames(["•  ", "•• ", "•••", " ••", "  •", "   "], 160).child(""))
    : MOODS[mood].text
      ? h_flex().absolute().left(S * 0.62).top(-14).size(17).rounded(9).items_center().justify_center().bg(tone)
        .when(mood === "error", (e) => e.loop("opacity", { from: 0.55, to: 1, period: 800 }))
        .child(div().text_size(11).font_bold().text_color("#ffffff").child(MOODS[mood].text))
      : null;
  return div().id("flo").absolute().left(x).spring("left", HOP).top(y).spring("top", HOP).w(S).h(S)
    .tooltip(focus.label ?? `Focus: ${n.name}`)
    // A shadow on the card's edge, breathing with the bob.
    .child(div().absolute().left(S * 0.18).top(S - 3).w(S * 0.64).h(5).rounded(3).bg(alpha("#000000", c.dark ? 0.55 : 0.25))
      .loop("opacity", { from: 0.45, to: 1, period: mood === "think" ? 520 : 1100 }))
    .child(div().absolute().left(0).top(0).size(S).loop("top", { from: 0, to: mood === "think" ? -4 : -2.5, period: mood === "think" ? 520 : 1100 })
      .child(image(`mods/flowdeck/sprite/flo-${state.flo.facing}.svg`).size(S)))
    // The antenna's glow.
    .child(div().absolute().left(S * 0.34).top(-S * 0.06).size(S * 0.32).rounded(S).bg(alpha("#ffd36e", 0.35)).loop("opacity", { from: 0.2, to: 0.9, period: 1400 }))
    .when(Boolean(bubble), (e) => e.child(bubble));
}

// The graph view. `run` (from extractRun) lays a run over the picture; `replay` ({ step }) shows it part-way.
export function graphView(c, { id, graph, state, run, replay, selected, onSelect, onChange, active, focus, follow = false }) {
  if (follow && state.size && graph?.nodes.length && focus?.node) {
    const key = `${graph.key}|${focus.node}`;
    if (state.followed !== key && !state.touched) { state.follow(graph, focus.node, Boolean(state.followed)); state.followed = key; state.fitted = graph.key; }
  } else if (state.size && graph?.nodes.length && state.fitted !== graph.key) { state.fit(graph, false); state.fitted = graph.key; }
  const z = state.zoom;
  const p = graph?.nodes.length ? paths(state, graph, z, run, replay, c) : null;
  const states = nodeStates(run, replay);
  if (run?.order?.length) for (const n of graph?.nodes ?? []) if (!states.has(n.name) && !n.info.sub) states.set(n.name, replay ? null : "skip");
  const ran = new Map((run?.order ?? []).map((o) => [o.name, o]));
  const gw = (graph?.width ?? 0) * z, gh = (graph?.height ?? 0) * z;
  const spring = state.glide ? GLIDE : SNAP;
  const paint = (path, color) => window.paint_path(path, color).absolute().top(0).left(0).w(gw).h(gh);

  const layer = div().id(`${id}-layer`).absolute().left(state.x).spring("left", spring).top(state.y).spring("top", spring).w(gw).h(gh)
    .opacity(state.entered ? 1 : 0).transition("opacity", MOTION.fade)
    .when(Boolean(p?.base), (e) => e.child(paint(p.base, alpha(c.foreground, c.dark ? 0.32 : 0.38))))
    .when(Boolean(p?.ai), (e) => e.child(paint(p.ai, alpha(c.foreground, c.dark ? 0.28 : 0.34))))
    .when(Boolean(p?.arrows), (e) => e.child(paint(p.arrows, alpha(c.foreground, c.dark ? 0.4 : 0.45))))
    // Live workflows shimmer along their idle lines; a run's path glows.
    .when(Boolean(p?.base) && active && !run, (e) => e.child(paint(p.base, c.brand).loop("opacity", { from: 0, to: 0.5, period: 2800 })))
    .when(Boolean(p?.hot), (e) => e.child(paint(p.hot, c.ok).opacity(0.85))
      .child(paint(p.hot, c.ok).loop("opacity", { from: 0.1, to: 0.7, period: 1800 })))
    .when(Boolean(p?.hotArrows), (e) => e.child(paint(p.hotArrows, c.ok)))
    .when(Boolean(p?.bad), (e) => e.child(paint(p.bad, c.err).loop("opacity", { from: 0.45, to: 1, period: 1300 })))
    .children((graph?.edges ?? []).filter((e) => e.label && z >= 0.55).map((e) => div().absolute()
      .left(e.p1[0] * z + 6 * z).top(e.p1[1] * z - 15 * z).px(5).rounded(4).text_size(Math.max(8.5, 10 * z)).text_color(c.dim).bg(c.canvas ?? c.background)
      .child(e.label)))
    .children((graph?.nodes ?? []).map((n, i) => {
      const o = ran.get(n.name);
      const info = o ? `${o.status}${o.ms != null ? ` in ${o.ms} ms` : ""}${o.runs > 1 ? ` · ${o.runs} runs` : ""}` : null;
      return nodeCard(c, n, z, states.get(n.name) ?? null, { selected: selected === n.name, onSelect, entered: state.entered, index: i, runInfo: info });
    }))
    .when(Boolean(focus && graph?.nodes.length), (e) => { const f = sprite(c, state, graph, z, focus); return f ? e.child(f) : e; });

  return div().id(id).relative().size_full().overflow_hidden().bg(c.canvas ?? c.background)
    .on_size_change((size, cx) => {
      state.size = size;
      // Until the person pans or zooms, the graph keeps fitting its space as the pane settles and resizes.
      if (follow && focus?.node && !state.touched) { state.follow(graph, focus.node, false); state.followed = `${graph?.key}|${focus.node}`; state.fitted = graph?.key; }
      else if (!state.touched || state.fitted !== graph?.key) { state.fit(graph, false); state.fitted = graph?.key; }
      onChange(cx);
    })
    .on_mouse_down("left", (e, cx) => { state.dragging = { x: e.position.x, y: e.position.y }; state.moved = false; state.glide = false; cx.notify(); })
    .on_mouse_move((e, cx) => {
      const d = state.dragging;
      if (!d) return;
      const dx = e.position.x - d.x, dy = e.position.y - d.y;
      if (!state.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      state.moved = true;
      state.touched = true;
      state.x += dx;
      state.y += dy;
      state.dragging = { x: e.position.x, y: e.position.y };
      onChange(cx);
    })
    .on_mouse_up("left", (_e, cx) => {
      const clicked = state.dragging && !state.moved;
      state.dragging = null;
      if (clicked) onSelect(null, cx);
      else onChange(cx);
    })
    .on_scroll_wheel((e, cx) => {
      state.glide = false;
      state.touched = true;
      if (e.modifiers?.platform || e.modifiers?.control) state.zoomBy(Math.exp(-e.delta.y * 0.004), e.local_position ?? null);
      else { state.x += e.delta.x; state.y += e.delta.y; }
      onChange(cx);
    })
    .child(grid(state, c) ?? div())
    .child(layer);
}

// Zoom and fit, over the graph's corner.
export function graphControls(c, { id, state, graph, onChange }) {
  const btn = (bid, iconName, tip, fn) => h_flex().id(`${id}-${bid}`).size(28).items_center().justify_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(c.hover)).tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { fn(); state.glide = true; state.touched = bid !== "fit"; onChange(cx); }).child(icon(iconName, 14, c.muted));
  return h_flex().id(id).gap(2).p(3).rounded(9).bg(c.popover ?? c.surface).border(1).border_color(c.border).shadow_md().items_center()
    .child(btn("out", "minus", "Zoom out", () => state.zoomBy(1 / 1.2)))
    .child(div().w(44).text_center().text_size(11.5).font_family(mono()).text_color(c.muted).child(`${Math.round(state.zoom * 100)}%`))
    .child(btn("in", "plus", "Zoom in", () => state.zoomBy(1.2)))
    .child(div().w(1).h(16).bg(c.border).mx(2))
    .child(btn("fit", "fit", "Fit to view", () => state.fit(graph, true)));
}
