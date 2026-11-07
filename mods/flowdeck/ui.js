// Flowdeck's small parts: colours, icons, buttons, chips, tiles and the motion they share. Every surface colour comes
// from Herdr's theme, so the mod follows light and dark; only status and node-kind colours are Flowdeck's own.
// Motion is native only (.transition, .spring, .loop, .spin): timers never drive an animation here.

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings } from "herdr";

export const ICON = (name) => `mods/flowdeck/icons/${name}.svg`;

export const MOTION = {
  fade: { duration: 280, easing: "ease-out" },
  rise: { duration: 380, easing: "ease-out" },
  bar: { duration: 520, easing: "ease-out" },
  quick: { duration: 160, easing: "ease-out" },
  panel: { response: 340, damping: 0.88 },
  glide: { response: 420, damping: 0.95 },
};
export const ENTER_MS = 40;

export function colors() {
  const t = theme();
  const dark = settings()?.dark ?? true;
  return {
    ...t,
    dark,
    ok: dark ? "#3fb950" : "#1a7f37",
    err: dark ? "#ff5d5d" : "#cf222e",
    warn: dark ? "#e3b341" : "#9a6700",
    run: dark ? "#58a6ff" : "#0969da",
    brand: dark ? "#ff7a5c" : "#e8553b",
    brand2: dark ? "#ffb35c" : "#d9822b",
  };
}

export const alpha = (hex, a) => `${String(hex).slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;

export function statusColor(c, status) {
  if (status === "error" || status === "crashed" || status === "failing") return c.err;
  if (status === "success" || status === "healthy") return c.ok;
  if (status === "running" || status === "new" || status === "waiting") return c.run;
  if (status === "flaky") return c.warn;
  return c.dim;
}

export const icon = (name, size, color) => svg(ICON(name)).size(size).flex_none().text_color(color);

export const spinner = (size, color) => svg(ICON("spinner")).size(size).flex_none().text_color(color).spin(900);

// Fades in on its first draw; `entered` flips one frame later, so the transition has a start to run from.
export const fadeIn = (entered, delay = 0) => (el) => el.opacity(entered ? 1 : 0).transition("opacity", { ...MOTION.fade, delay });
export const rise = (entered, delay = 0, px = 8) => (el) => el.relative().top(entered ? 0 : px).transition("top", { ...MOTION.rise, delay })
  .opacity(entered ? 1 : 0).transition("opacity", { ...MOTION.fade, delay });

export function dot(color, size = 8, pulse = false) {
  const d = div().size(size).rounded(size / 2).flex_none().bg(color);
  if (!pulse) return d;
  return div().relative().size(size).flex_none()
    .child(div().absolute().top(0).left(0).size(size).rounded(size / 2).bg(color).opacity(0.35).loop("opacity", { from: 0.1, to: 0.55, period: 1600 }))
    .child(div().absolute().top(size * 0.2).left(size * 0.2).size(size * 0.6).rounded(size * 0.3).bg(color));
}

// kind: primary (solid brand), solid (theme's), ghost (bordered), subtle (no border), danger.
export function button(c, { id, label, iconName, kind = "ghost", onClick, disabled = false, loading = false, size = "md", tooltip }) {
  const h = size === "sm" ? 26 : 32;
  const fg = kind === "primary" ? "#ffffff" : kind === "solid" ? c.solid_foreground : kind === "danger" ? c.err : c.foreground;
  const bg = kind === "primary" ? c.brand : kind === "solid" ? c.solid : "#00000000";
  let el = h_flex().id(id).h(h).px(label ? (size === "sm" ? 9 : 13) : 0).when(!label, (e) => e.w(h).justify_center())
    .gap(7).items_center().flex_none().rounded(7).text_size(size === "sm" ? 12 : 13).font_medium().text_color(fg).bg(bg)
    .when(kind === "ghost" || kind === "danger", (e) => e.border(1).border_color(kind === "danger" ? alpha(c.err, 0.5) : c.border))
    .when(!disabled && !loading, (e) => e.cursor_pointer()
      .hover((s) => (kind === "primary" ? s.bg(c.brand2) : kind === "solid" ? s.opacity(0.9) : s.bg(c.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => onClick?.(e, cx)))
    .when(disabled, (e) => e.opacity(0.45));
  if (tooltip) el = el.tooltip(tooltip);
  if (loading) el = el.child(spinner(size === "sm" ? 12 : 14, fg));
  else if (iconName) el = el.child(icon(iconName, size === "sm" ? 13 : 15, fg));
  if (label) el = el.child(div().child(label));
  return el;
}

export function chip(c, { id, label, active, onClick, count, color, iconName }) {
  return h_flex().id(id).h(26).px(10).gap(6).items_center().flex_none().rounded(13).text_size(12).cursor_pointer()
    .border(1).border_color(active ? alpha(c.brand, 0.7) : c.border)
    .bg(active ? alpha(c.brand, 0.14) : "#00000000")
    .text_color(active ? c.foreground : c.muted)
    .hover((s) => s.bg(active ? alpha(c.brand, 0.2) : c.hover))
    .on_click((e, cx) => onClick?.(e, cx))
    .when(Boolean(iconName), (e) => e.child(icon(iconName, 12, color ?? (active ? c.brand : c.dim))))
    .when(Boolean(color) && !iconName, (e) => e.child(dot(color, 7)))
    .child(div().child(label))
    .when(count !== undefined && count !== null, (e) => e.child(div().px(6).h(16).rounded(8).flex().items_center().text_size(10.5).font_semibold()
      .bg(active ? c.brand : c.raised).text_color(active ? "#ffffff" : c.muted).child(String(count))));
}

export const card = (c) => v_flex().rounded(12).border(1).border_color(c.border).bg(c.surface);

export const label = (c, text) => div().text_size(11).font_semibold().text_color(c.dim).child(text.toUpperCase());

export function kpi(c, { id, title, value, sub, subColor, iconName, accent, entered, delay, extra }) {
  return card(c).id(id).flex_1().min_w(150).p(14).gap(6).overflow_hidden()
    .map(rise(entered, delay))
    .child(h_flex().items_center().gap(8)
      .child(h_flex().size(26).rounded(7).items_center().justify_center().bg(alpha(accent, 0.16)).child(icon(iconName, 14, accent)))
      .child(div().text_size(12).text_color(c.muted).child(title)))
    .child(h_flex().items_end().justify_between().gap(8)
      .child(v_flex().gap(2)
        .child(div().text_size(26).font_semibold().text_color(c.foreground).line_height("30px").child(value))
        .child(div().text_size(11.5).text_color(subColor ?? c.dim).truncate().child(sub ?? "")))
      .when(Boolean(extra), (e) => e.child(extra)));
}

// Bars that grow up from zero when first shown. values: [{ ok, err, run }] stacked bottom-up err, run, ok.
export function stackedBars(c, { id, bins, height, entered, gap = 3, onHover, hovered }) {
  const max = Math.max(1, ...bins.map((b) => b.ok + b.err + b.run));
  return h_flex().id(id).h(height).items_end().gap(gap).w_full()
    .children(bins.map((b, i) => {
      const total = b.ok + b.err + b.run;
      const hTotal = total ? Math.max(3, (total / max) * height) : 2;
      const hErr = total ? (b.err / total) * hTotal : 0, hRun = total ? (b.run / total) * hTotal : 0;
      const delay = 60 + i * 14;
      const hot = hovered === i;
      return v_flex().id(`${id}-${i}`).flex_1().h_full().justify_end().rounded(3)
        .when(Boolean(onHover), (e) => e.on_hover((on, cx) => onHover(on ? i : null, cx)))
        .child(v_flex().w_full().justify_end().overflow_hidden().rounded(3)
          .h(entered ? hTotal : 0).transition("height", { ...MOTION.bar, delay })
          .bg(total ? alpha(c.ok, hot ? 0.95 : 0.7) : c.border)
          .when(hRun > 0, (e) => e.child(div().w_full().h(hRun).flex_none().bg(c.run)))
          .when(hErr > 0, (e) => e.child(div().w_full().h(hErr).flex_none().bg(hot ? c.err : alpha(c.err, 0.9)))));
    }));
}

// The last runs of a workflow, oldest left: one thin bar each, tall when slow, coloured by status.
export function runStrip(c, { id, runs, count = 20, height = 16, width = 4, gap = 2, selected, onPick }) {
  const shown = runs.slice(0, count).reverse();
  const pad = Array.from({ length: Math.max(0, count - shown.length) });
  const slow = Math.max(1, ...shown.map((r) => r.ms ?? 0));
  return h_flex().id(id).h(height).items_end().gap(gap).flex_none()
    .children(pad.map((_, i) => div().w(width).h(3).rounded(1).bg(c.border).opacity(0.6).flex_none().id(`${id}-p${i}`)))
    .children(shown.map((r, i) => {
      const hgt = Math.max(5, Math.min(height, 5 + ((r.ms ?? 0) / slow) * (height - 5)));
      const col = statusColor(c, r.status);
      const sel = selected && String(selected) === String(r.id);
      let bar = div().id(`${id}-${r.id ?? i}`).w(width).h(hgt).rounded(1.5).flex_none().bg(col)
        .when(!sel && selected, (e) => e.opacity(0.55))
        .when(sel, (e) => e.border(1).border_color(c.foreground));
      if (onPick) bar = bar.cursor_pointer().hover((s) => s.opacity(1)).on_click((_e, cx) => onPick(r, cx)).tooltip(r.tip ?? r.status);
      return bar;
    }));
}

export function sparkline(c, { id, values, color, width = 64, height = 18 }) {
  const max = Math.max(1, ...values);
  return h_flex().id(id).w(width).h(height).items_end().gap(1.5).flex_none()
    .children(values.map((v, i) => div().id(`${id}-${i}`).flex_1().h(v ? Math.max(3, (v / max) * height) : 1.5).rounded(1).bg(v ? color : c.border)));
}

export function empty(c, { iconName, title, body, action }) {
  return v_flex().size_full().items_center().justify_center().gap(10).p(24)
    .child(h_flex().size(44).rounded(12).items_center().justify_center().bg(c.raised).child(icon(iconName, 20, c.dim)))
    .child(div().text_size(14).font_semibold().text_color(c.foreground).child(title))
    .when(Boolean(body), (e) => e.child(div().max_w(380).text_size(12.5).text_color(c.muted).text_center().child(body)))
    .when(Boolean(action), (e) => e.child(action));
}

export const mono = () => settings()?.font_family ?? "JetBrains Mono";
