// The focus sprites from the sprite preview, drawn natively in the graph's layer so they follow pan and zoom:
//
//   probe     a drone hovers over the node and scans it; its eye follows the scan line; it flies along the wire with
//             its thrusters lit. The default.
//   goose     stands on the node and pecks it; every third stop it honks and the node shakes; it walks off the card
//             and waddles along the wire.
//   brackets  orange corner brackets breathe around the node, shrink to a dot that runs along the wire, and open
//             around the next.
//
// Pixel art is built once per pose as native paths, one per colour, so it stays crisp and costs nothing per frame.
// Everything that repeats while the sprite waits (pecks, bob, scan, breathing, flicker, blinks) is a native loop;
// a move steps every TICK ms and glides natively between steps. Under reduced motion the sprites jump and hold still.

import { div, PathBuilder } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared } from "herdr";
import { along, ease, lerp, snap, goosePath, probePath, wireBetween, pulseRange, stepMotion, TICK, HOVER } from "./motion.js";
import { alpha } from "./ui.js";

export const SPRITES = [
  { id: "probe", label: "Probe", note: "A drone that scans the node" },
  { id: "goose", label: "Goose", note: "Pecks, honks, waddles" },
  { id: "brackets", label: "Brackets", note: "Quiet corner marks" },
  { id: "flo", label: "Flo", note: "The little coral bot" },
  { id: "off", label: "Off", note: "No sprite" },
];
export const SPRITE_KEY = "flowdeck.sprite";
export const spriteKind = () => (SPRITES.some((s) => s.id === shared(SPRITE_KEY)) ? shared(SPRITE_KEY) : "probe");

// Set by the view each render: whether motion is reduced (the person's choice, else the system's).
export const motionPrefs = { reduced: false };

const ORANGE = "#f97316", GREEN = "#4ade80";
const GLIDE = (ms = TICK) => ({ duration: ms, easing: "linear" });

// ── Pixel art ─────────────────────────────────────────────────────────────────────────────────────────────────

// Parts are [rows, col, row] on a grid; `flip` mirrors them across `sw` columns, as part() did. Runs of one colour in
// a row become one rectangle.
const ART = new Map();
function art(key, cols, rows, px, pal, parts, flip = false, sw = cols, extra = []) {
  const k = `${key}|${px}|${flip}`;
  let entry = ART.get(k);
  if (!entry) {
    const by = new Map();
    const rect = (color, x, y, w, h) => {
      let b = by.get(color);
      if (!b) { b = PathBuilder.fill(); by.set(color, b); }
      b.add_polygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    };
    for (const [grid, col, row, off = [0, 0]] of parts) {
      grid.forEach((line, r) => {
        const chars = [...line];
        for (let k2 = 0; k2 < chars.length; k2++) {
          const ch = chars[k2];
          if (ch === ".") continue;
          let end = k2;
          while (end + 1 < chars.length && chars[end + 1] === ch) end++;
          const a = col + k2, b = col + end;
          const x0 = flip ? sw - 1 - b : a;
          rect(pal[ch], (x0 + off[0]) * px, (row + r + off[1]) * px, (b - a + 1) * px, px);
          k2 = end;
        }
      });
    }
    for (const [color, x, y, w, h] of extra) rect(color, x * px, y * px, w * px, h * px);
    entry = { paths: [...by].map(([color, b]) => [color, b.build()]), w: cols * px, h: rows * px };
    ART.set(k, entry);
  }
  return div().relative().w(entry.w).h(entry.h).flex_none()
    .children(entry.paths.map(([color, path]) => window.paint_path(path, color).absolute().top(0).left(0).w(entry.w).h(entry.h)));
}

// A layer that takes turns with others: see pulseRange.
const pulse = (el, period, duty, early = false) => el.loop("opacity", { ...pulseRange(duty, early), period, easing: "linear" });
const layer = (el) => div().absolute().top(0).left(0).child(el);

// ── 1. Goose ──────────────────────────────────────────────────────────────────────────────────────────────────

const GP = { W: "#f4f4f5", G: "#a1a1aa", K: "#18181b", O: "#fb923c", Y: "#fde68a" };
const G_HEAD = [".WW....", "WWWW...", "WKWWOO.", "WWWWOOO", ".WW....", ".WW....", ".WW...."];
const G_HONK = [".WW....", "WWWW.OO", "WKWWOO.", "WWWW...", ".WW.OO.", ".WW..OO", ".WW...."];
const G_BODY = ["..WW.....WWW", ".WWWWWWWWWWW", "WWGGGWWWWWWW", ".WWGGGWWWWW.", "..WWWWWWWW.."];
const G_WING = ["GW...", ".GWW.", "..GWW"];
const G_LEGS = { stand: ["..O..O.", ".OO.OO."], a: [".O....O", "OO...OO"], b: ["...OO..", "..OOOO."] };
const G_SW = 17, G_SH = 14;
// The art canvas leaves room left of the goose for a flipped peck's sparks and above it for the honk head.
const G_PAD = [5, 1], G_COLS = 5 + 17 + 4, G_ROWS = 1 + 14 + 1;

function goosePose(name, px, flip) {
  const o = G_PAD;
  const up = name === "walkA" ? -1 : 0;
  const parts = [[G_BODY, 0, 7 + up, o]];
  if (name === "honk" || name === "walkA") parts.push([G_WING, 1, 5 + up, o]);
  if (name === "peck") parts.push([G_HEAD, 10, 3, o]);
  else if (name === "honk") parts.push([G_HONK, 9, -1, o]);
  else parts.push([G_HEAD, 9, up, o]);
  parts.push([name === "walkA" ? G_LEGS.a : name === "walkB" ? G_LEGS.b : G_LEGS.stand, 4, 12, o]);
  // The peck's two sparks, just past the beak.
  const sparks = name === "peck" ? (flip ? [["#fde68a", 3, 14, 1, 1], ["#fde68a", 1, 12, 1, 1]] : [["#fde68a", 23, 14, 1, 1], ["#fde68a", 25, 12, 1, 1]]) : [];
  return art(`goose-${name}`, G_COLS, G_ROWS, px, GP, parts, flip, G_SW, sparks);
}

function drawGoose(c, { m, graph, z, px, reduced, mood }) {
  const n = graph.nodes.find((x) => x.name === m.node);
  if (!n) return null;
  let fx, fy;
  if (m.moving) {
    const p = along(goosePath(graph, m.moving.from, m.moving.to, z), ease(m.u));
    [fx, fy] = p;
    if (Math.abs(p[2]) > 0.01) m.facing = p[2] < 0 ? -1 : 1;
  } else {
    fx = n.x * z + n.w * z * 0.55;
    fy = n.y * z;
  }
  const flip = m.facing < 0;
  const ox = snap(fx - 8 * px) - G_PAD[0] * px, oy = snap(fy - G_SH * px) - G_PAD[1] * px;
  const poses = m.moving
    ? [pulse(layer(goosePose("walkA", px, flip)), 220, 0.5, true), pulse(layer(goosePose("walkB", px, flip)), 220, 0.5)]
    : m.honk ? [layer(goosePose("honk", px, flip))]
    : reduced ? [layer(goosePose("stand", px, flip))]
    // Two quick pecks a beat: down for 30% of each 400 ms.
    : [pulse(layer(goosePose("stand", px, flip)), 400, 0.7, true), pulse(layer(goosePose("peck", px, flip)), 400, 0.3)];
  const bubble = m.honk
    ? h_flex().absolute().left((flip ? -30 : 22) + G_PAD[0] * px).top(-16 + G_PAD[1] * px).w(46).h(16).rounded(3).items_center().justify_center().bg("#f4f4f5")
      .child(div().text_size(10).font_bold().font_family("JetBrains Mono").text_color("#18181b").child("HONK!"))
    : moodBubble(c, mood, G_COLS * px * 0.6, 0);
  return { el: div().id("fs-goose").absolute().left(ox).transition("left", GLIDE()).top(oy).transition("top", GLIDE())
    .w(G_COLS * px).h(G_ROWS * px).children(poses).when(Boolean(bubble), (e) => e.child(bubble)), shake: m.honk ? n.name : null };
}

// ── 2. Brackets ───────────────────────────────────────────────────────────────────────────────────────────────

// One corner: an arm across and an arm down, pointing into the box.
function corner(id, x, y, arm, T, sx, sy, color, motion) {
  const el = div().id(id).absolute().w(arm).h(arm)
    .child(div().absolute().left(sx > 0 ? 0 : 0).top(sy > 0 ? 0 : arm - T).w(arm).h(T).bg(color))
    .child(div().absolute().left(sx > 0 ? 0 : arm - T).top(0).w(T).h(arm).bg(color));
  return motion(el, sx > 0 ? x : x - arm, sy > 0 ? y : y - arm);
}

function drawBrackets(c, { m, graph, z, px, reduced, mood }) {
  const n = graph.nodes.find((x) => x.name === m.node);
  if (!n) return null;
  // Always orange: red would vanish into a failed node's own red ring.
  const T = px, color = ORANGE;
  const box = (node, pad) => [node.x * z - pad, node.y * z - pad, node.w * z + pad * 2, node.h * z + pad * 2];
  const kids = [];
  if (!m.moving) {
    const [x, y, w, h] = box(n, 5);
    const arm = Math.max(T, Math.min(snap(8, px), Math.floor(w / 2), Math.floor(h / 2)));
    const d = reduced ? 0 : 1.5, period = 2640;
    // Breathing: every corner swings 1.5 px in and out together, and the marks brighten as they open.
    const motion = (sx, sy) => (el, left, top) => (d
      ? el.left(left).loop("left", { from: left - sx * d, to: left + sx * d, period, easing: "ease-in-out" })
        .top(top).loop("top", { from: top - sy * d, to: top + sy * d, period, easing: "ease-in-out" })
      : el.left(left).top(top));
    for (const [cx, cy, sx, sy, k] of [[x, y, 1, 1, "tl"], [x + w, y, -1, 1, "tr"], [x, y + h, 1, -1, "bl"], [x + w, y + h, -1, -1, "br"]]) {
      kids.push(corner(`fs-b-${k}`, snap(cx), snap(cy), arm, T, sx, sy, color, motion(sx, sy)));
    }
    return { el: div().id("fs-brackets").absolute().top(0).left(0).when(!reduced, (e) => e.loop("opacity", { from: 0.95, to: 0.55, period, easing: "ease-in-out" })).children(kids), shake: null };
  }
  // Moving: close into a dot over the first quarter, run along the wire with a short trail, open over the last.
  const wire = wireBetween(graph, m.moving.from, m.moving.to, z);
  const to = graph.nodes.find((x) => x.name === m.moving.to), from = graph.nodes.find((x) => x.name === m.moving.from) ?? to;
  const dot = (p) => [p[0] - 3, p[1] - 3, 6, 6], u = m.u;
  let r;
  if (u < 0.25) { const k = ease(u / 0.25), A = box(from, 5), B = dot(wire[0]); r = A.map((v, i) => lerp(v, B[i], k)); }
  else if (u > 0.75) { const k = ease((u - 0.75) / 0.25), A = dot(wire[wire.length - 1]), B = box(to, 5); r = A.map((v, i) => lerp(v, B[i], k)); }
  else {
    const k = ease((u - 0.25) / 0.5);
    for (let j = 6; j >= 1; j--) {
      if (k - j * 0.025 < 0) continue;
      const p = along(wire, k - j * 0.025);
      kids.push(div().id(`fs-trail-${j}`).absolute().left(snap(p[0] - 1)).top(snap(p[1] - 1)).size(px).bg(alpha(ORANGE, 0.5 - j * 0.07)));
    }
    r = dot(along(wire, k));
  }
  const [x, y, w, h] = r.map((v) => snap(v));
  const arm = Math.max(T, Math.min(snap(8, px), Math.floor(w / 2), Math.floor(h / 2)));
  const glide = (el, left, top) => el.left(left).transition("left", GLIDE()).top(top).transition("top", GLIDE());
  for (const [cx, cy, sx, sy, k] of [[x, y, 1, 1, "tl"], [x + w, y, -1, 1, "tr"], [x, y + h, 1, -1, "bl"], [x + w, y + h, -1, -1, "br"]]) {
    kids.push(corner(`fs-b-${k}`, cx, cy, arm, T, sx, sy, color, glide));
  }
  return { el: div().id("fs-brackets").absolute().top(0).left(0).opacity(0.95).children(kids), shake: null };
}

// ── 3. Probe ──────────────────────────────────────────────────────────────────────────────────────────────────

const PP = { A: "#f97316", D: "#52525b", B: "#3f3f46", L: "#d4d4d8", S: "#18181b", P: "#71717a" };
const P_BODY = [".....AA.....", "......D.....", "...BBBBBB...", "..BLLLLLLB..", ".BLSSSSSSLB.", ".BLSSSSSSLB.", ".BLSSSSSSLB.", ".BLSSSSSSLB.", "..BLLLLLLB..", "...BBBBBB...", "..P......P..", ".PP......PP."];
const P_ROWS = 12 + 3;

// Thruster flames under both feet: a pale core and, when lit hard, orange below it.
function flames(px, len) {
  const extra = [];
  for (const col of [1, 9]) for (let r = 0; r < len; r++) extra.push(r ? [ORANGE, col + 0.5, 12 + r, 1, 1] : ["#fde68a", col, 12, 2, 1]);
  return art(`probe-flame-${len}`, 12, P_ROWS, px, {}, [], false, 12, extra);
}

const eye = (px, blink) => art(`probe-eye-${blink}`, 2, 2, px, {}, [], false, 2, blink ? [[GREEN, 0, 1, 2, 1]] : [[GREEN, 0, 0, 2, 2]]);

function drawProbe(c, { m, graph, z, px, reduced, mood }) {
  const n = graph.nodes.find((x) => x.name === m.node);
  if (!n) return null;
  const nx = n.x * z, ny = n.y * z, nw = n.w * z, nh = n.h * z;
  let cx, cy, eyeCol = 5;
  const under = [];
  if (m.moving) {
    const path = probePath(graph, m.moving.from, m.moving.to, z), k = ease(m.u), p = along(path, k);
    [cx, cy] = p;
    eyeCol = p[2] < 0 ? 3 : 7;
    for (let j = 1; j <= 5; j++) {
      if (k - j * 0.04 < 0) break;
      const q = along(path, k - j * 0.04);
      under.push(div().id(`fs-ptrail-${j}`).absolute().left(snap(q[0])).top(snap(q[1] + 8)).size(px).bg(alpha(ORANGE, 0.45 - j * 0.08)));
    }
  } else {
    cx = nx + nw / 2;
    cy = ny - HOVER;
    // The scan: a faint fan from the drone over the card, and a bright line sweeping across it with a soft glow.
    const by = snap(cy) + 6 * px, left = nx + 10, right = nx + nw - 10, period = 4084;
    const fan = PathBuilder.fill().add_polygon([[cx - 6, by], [cx + 6, by], [right + 12, ny], [left - 12, ny]], true).build();
    const fade = m.since < 250 && !reduced ? 0 : 1;
    const sweep = (el, w) => (reduced ? el.left(cx - w / 2) : el.left(left - w / 2).loop("left", { from: left - w / 2, to: right - w / 2, period, easing: "ease-in-out" }));
    under.push(div().id("fs-scan").absolute().top(0).left(0).opacity(fade).transition("opacity", { duration: 250, easing: "ease-out" })
      .child(window.paint_path(fan, alpha(GREEN, 0.09)).absolute().top(0).left(0).w(right + 40).h(ny + nh))
      .child(sweep(div().absolute().top(ny).w(24).h(10).rounded(5).bg(alpha(GREEN, 0.16)), 24))
      .child(sweep(div().absolute().top(ny + 2).w(2).h(Math.max(4, nh - 4)).bg(alpha(GREEN, 0.55)), 2)));
  }
  const ox = snap(cx - 6 * px), oy = snap(cy - 6 * px);
  // The eye follows the scan line while dwelling (same loop, same clock), and blinks for 120 ms every 3.2 s.
  const eyeEl = (blink) => {
    const base = div().absolute().top(6 * px);
    const placed = !m.moving && !reduced
      ? base.left(3 * px).loop("left", { from: 3 * px, to: 7 * px, period: 4084, easing: "ease-in-out" })
      : base.left(eyeCol * px);
    return placed.child(eye(px, blink));
  };
  const eyes = reduced ? [eyeEl(false)] : [pulse(eyeEl(false), 3200, 0.9625, true), pulse(eyeEl(true), 3200, 0.0375)];
  const thrust = m.moving
    ? [pulse(layer(flames(px, 2)), 140, 0.5, true), pulse(layer(flames(px, 3)), 140, 0.5)]
    : reduced ? [] : [pulse(layer(flames(px, 1)), 270, 0.33)];
  const body = div().id("fs-probe-body").absolute().top(0).left(0).w(12 * px).h(P_ROWS * px)
    .when(!reduced && !m.moving, (e) => e.loop("top", { from: -px, to: px, period: 1630, easing: "ease-in-out" }))
    .child(layer(art("probe-body", 12, P_ROWS, px, PP, [[P_BODY, 0, 0]])))
    .children(thrust).children(eyes);
  const bubble = moodBubble(c, mood, 12 * px * 0.7, -2);
  return {
    el: div().id("fs-probe").absolute().top(0).left(0).children(under)
      .child(div().id("fs-probe-at").absolute().left(ox).transition("left", GLIDE()).top(oy).transition("top", GLIDE()).w(12 * px).h(P_ROWS * px)
        .child(body).when(Boolean(bubble), (e) => e.child(bubble))),
    shake: null,
  };
}

// The same mood bubbles Flo uses: a red "!" pulsing on a failure, a green tick on success.
function moodBubble(c, mood, left, top) {
  if (mood !== "error" && mood !== "ok") return null;
  const tone = mood === "error" ? c.err : c.ok;
  return h_flex().absolute().left(left).top(top - 16).size(17).rounded(9).items_center().justify_center().bg(tone)
    .when(mood === "error", (e) => e.loop("opacity", { from: 0.55, to: 1, period: 800 }))
    .child(div().text_size(11).font_bold().text_color("#ffffff").child(mood === "error" ? "!" : "✓"));
}

const DRAW = { goose: drawGoose, brackets: drawBrackets, probe: drawProbe };

// The sprite for one graph, and the node it is shaking (the goose's honk), if any. `state.motion` holds where the
// sprite is between renders; `state.motion.needsTick` asks the view for the next step of a move.
export function focusSprite(c, state, graph, z, focus, kind = spriteKind()) {
  const m = (state.motion ??= { node: null, moving: null, arrivals: 0, arrivedAt: 0, facing: 1 });
  const draw = DRAW[kind];
  if (!draw || !focus?.node) { m.needsTick = false; return null; }
  const reduced = motionPrefs.reduced;
  stepMotion(m, focus.node, kind, reduced, Date.now());
  // Pixels stay whole: three screen pixels per sprite pixel, two when zoomed far out, the same size at any zoom.
  const px = z >= 0.75 ? 3 : 2;
  return draw(c, { m, graph, z, px, reduced, mood: focus.mood });
}
