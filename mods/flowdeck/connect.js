// The first thing a person sees: connect an n8n instance with an API key or an MCP token, or look around with demo
// data. Everything that keeps the key safe is said here, next to the field it's typed into.

import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { alpha, icon, button, rise, fadeIn } from "./ui.js";
import { vaultName } from "./vault.js";

// Three soft lights drifting behind the card. Native loops: they cost nothing between frames and stop when hidden.
function backdrop(c) {
  // Each light is three discs, largest faintest, which reads as a soft glow.
  const orb = (size, color, x, y, dx, dy, period) => div().absolute().size(size)
    .left(x).loop("left", { from: x, to: x + dx, period }).top(y).loop("top", { from: y, to: y + dy, period: period * 1.3 })
    .child(div().absolute().top(0).left(0).size(size).rounded(size / 2).bg(alpha(color, 0.035)))
    .child(div().absolute().top(size * 0.15).left(size * 0.15).size(size * 0.7).rounded(size * 0.35).bg(alpha(color, 0.04)))
    .child(div().absolute().top(size * 0.3).left(size * 0.3).size(size * 0.4).rounded(size * 0.2).bg(alpha(color, 0.05)));
  return div().absolute().top(0).left(0).size_full().overflow_hidden()
    .child(orb(620, c.brand, -220, -260, 160, 110, 17000))
    .child(orb(560, "#8b5cf6", 640, 220, -190, -120, 21000))
    .child(orb(460, "#22d3ee", 120, 460, 220, -90, 25000));
}

function field(c, { id, labelText, input, focused, trailing, hint }) {
  return v_flex().gap(6)
    .child(h_flex().justify_between().items_center()
      .child(div().text_size(12).font_medium().text_color(c.muted).child(labelText))
      .when(Boolean(hint), (e) => e.child(div().text_size(11).text_color(c.dim).child(hint))))
    .child(h_flex().id(id).h(38).px(11).gap(8).items_center().rounded(9).border(1).border_color(focused ? c.brand : c.input ?? c.border)
      .bg(c.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(input).flex_1().h_full().text_size(13).text_color(c.foreground))
      .when(Boolean(trailing), (e) => e.child(trailing)));
}

function segmented(c, value, onPick) {
  const opt = (id, text, iconName) => {
    const on = value === id;
    return h_flex().id(`mode-${id}`).flex_1().h(32).gap(7).items_center().justify_center().rounded(7).cursor_pointer()
      .text_size(12.5).font_medium().text_color(on ? c.foreground : c.muted)
      .bg(on ? c.surface : "#00000000").when(on, (e) => e.shadow_sm())
      .hover((s) => s.text_color(c.foreground))
      .on_click((_e, cx) => onPick(id, cx))
      .child(icon(iconName, 13, on ? c.brand : c.dim)).child(div().child(text));
  };
  return h_flex().p(3).gap(3).rounded(10).bg(alpha(c.foreground, 0.06)).child(opt("api", "API key", "key")).child(opt("mcp", "MCP token", "plug"));
}

function toggle(c, { id, on, labelText, sub, disabled, onToggle }) {
  return h_flex().id(id).gap(11).items_center().cursor_pointer().when(disabled, (e) => e.opacity(0.55))
    .on_click((_e, cx) => { if (!disabled) onToggle(cx); })
    .child(div().relative().w(34).h(20).flex_none().rounded(10).bg(on ? c.brand : alpha(c.foreground, 0.18))
      .child(div().absolute().top(2).left(on ? 16 : 2).transition("left", { duration: 180, easing: "ease-out" }).size(16).rounded(8).bg("#ffffff").shadow_sm()))
    .child(v_flex().gap(1)
      .child(div().text_size(12.5).text_color(c.foreground).child(labelText))
      .when(Boolean(sub), (e) => e.child(div().text_size(11.5).text_color(c.dim).child(sub))));
}

const trust = (c, iconName, title, body, color) => h_flex().flex_1().gap(9).items_start().min_w(0)
  .child(h_flex().size(26).flex_none().rounded(7).items_center().justify_center().bg(alpha(color, 0.14)).child(icon(iconName, 13, color)))
  .child(v_flex().gap(2).min_w(0).child(div().text_size(12).font_semibold().text_color(c.foreground).child(title)).child(div().text_size(11.5).text_color(c.muted).child(body)));

export function connectView(view, c) {
  const f = view.form, en = f.entered;
  const mcp = f.mode === "mcp";
  const where = vaultName(view.vault);
  const canRemember = view.vault && view.vault !== "session";
  const eye = h_flex().id("eye").size(24).items_center().justify_center().rounded(5).cursor_pointer().hover((s) => s.bg(c.hover))
    .tooltip(f.show ? "Hide" : "Show").on_click((_e, cx) => { f.show = !f.show; view.inputs.key.set_masked(!f.show); cx.notify(); })
    .child(icon(f.show ? "eye-off" : "eye", 14, c.dim));
  const how = mcp
    ? ["In n8n, open Settings → Instance-level MCP, turn it on, and copy the access token.", "MCP shows workflows and their graphs. Run history and failures need an API key."]
    : ["In n8n, open Settings → n8n API and create an API key.", "Self-hosted? The public API must be enabled (it is unless N8N_PUBLIC_API_DISABLED is set)."];

  const form = v_flex().id("card").w_full().p(22).gap(16).rounded(16).bg(alpha(c.surface, 0.92)).border(1).border_color(c.border).shadow_lg()
    .map(rise(en, 120, 14))
    .child(segmented(c, f.mode, (id, cx) => { f.mode = id; f.error = null; cx.notify(); }))
    .child(field(c, { id: "url", labelText: "Instance address", input: view.inputs.url }))
    .when(Boolean(f.needsOptIn), (e) => e.child(toggle(c, {
      id: "insecure", on: Boolean(f.allowInsecure),
      labelText: "Allow plain http on this network",
      sub: "Anyone on the same network could read your key. Only for a network you trust; https is better.",
      onToggle: (cx) => { f.allowInsecure = !f.allowInsecure; f.error = null; cx.notify(); },
    })))
    .child(field(c, { id: "key", labelText: mcp ? "MCP access token" : "API key", input: view.inputs.key, trailing: eye, hint: mcp ? "Bearer token" : "X-N8N-API-KEY" }))
    .child(field(c, { id: "name", labelText: "Name", input: view.inputs.name }))
    .child(toggle(c, {
      id: "remember", on: f.remember && canRemember, disabled: !canRemember,
      labelText: canRemember ? `Remember in ${where}` : "Remember the key",
      sub: canRemember ? (f.remember ? "Encrypted at rest by the OS; never in a file, a setting or a command line" : "Kept in memory until Herdr quits") : "No keychain found here, so the key lasts until Herdr quits",
      onToggle: (cx) => { f.remember = !f.remember; cx.notify(); },
    }))
    .when(Boolean(f.error), (e) => e.child(h_flex().px(11).py(9).gap(9).items_start().rounded(9).bg(alpha(c.err, 0.1)).border(1).border_color(alpha(c.err, 0.4))
      .map(fadeIn(true)).child(icon("alert", 14, c.err)).child(div().flex_1().text_size(12.5).text_color(c.foreground).child(f.error))))
    .child(h_flex().gap(10).items_center()
      .child(button(c, { id: "connect", label: f.busy ? "Checking…" : "Connect", iconName: "plug", kind: "primary", loading: f.busy, onClick: (_e, cx) => cx.spawn(async (cx) => view.connect(cx)) }))
      .when(!view.adding, (e) => e.child(button(c, { id: "demo", label: "Try with demo data", iconName: "play", onClick: (_e, cx) => cx.spawn(async (cx) => view.tryDemo(cx)) })))
      .when(Boolean(view.adding), (e) => e.child(button(c, { id: "cancel", label: "Cancel", kind: "subtle", onClick: (_e, cx) => {
        const p = view.activeProfile();
        if (p) cx.spawn(async (cx) => view.open(p, cx));
      } }))))
    .child(v_flex().gap(4).pt(2).border_t(1).border_color(c.border).pt(12)
      .children(how.map((line, i) => h_flex().gap(8).items_start()
        .child(div().mt(6).size(4).rounded(2).flex_none().bg(i ? c.dim : c.brand))
        .child(div().flex_1().min_w(0).text_size(11.8).text_color(i ? c.dim : c.muted).child(line)))));

  return div().id("root").size_full().relative().bg(c.canvas ?? c.background).text_color(c.foreground).overflow_hidden()
    .child(backdrop(c))
    .child(v_flex().id("scroll").absolute().top(0).left(0).size_full().overflow_y_scrollbar().items_center()
      .child(v_flex().w_full().max_w(500).px(20).py(40).gap(22)
        .child(v_flex().gap(14).items_center().map(rise(en, 0, 10))
          .child(h_flex().size(52).rounded(15).items_center().justify_center().bg(c.brand).shadow_lg().child(icon("logo", 28, "#ffffff")))
          .child(v_flex().gap(6).items_center()
            .child(div().text_size(24).font_semibold().text_center().child(view.adding ? "Connect another instance" : "Connect your n8n"))
            .child(div().max_w(400).text_size(13.5).text_color(c.muted).text_center()
              .child("See every workflow as a live graph, catch failures the moment they happen, and ask Claude why."))))
        .child(form)
        .child(h_flex().gap(14).items_start().map(rise(en, 240, 10))
          .child(trust(c, "lock", "Keys stay local", canRemember ? `In ${where}, never in files` : "In memory, never on disk", c.ok))
          .child(trust(c, "shield", "Read-only", "Flowdeck never edits, runs or deletes", c.run))
          .child(trust(c, "spark", "You choose", "Claude sees a workflow only when you ask", c.brand)))));
}
