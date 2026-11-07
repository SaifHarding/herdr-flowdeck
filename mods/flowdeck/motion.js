// The geometry and timing behind the focus sprites (sprites.js), ported from the sprite preview: easing, points along a
// polyline, the wire between two nodes sampled from the graph's real edges, each sprite's travel path, and the move
// state machine. No "herdr" or "gpui-kit" imports, so it runs under node --test.

import { edgeCurve } from "./model.js";

export const DWELL = 2400;
export const MOVE = { goose: 1900, brackets: 1100, probe: 1400 };
// How often a move steps; each step glides natively to the next point, so this sets smoothness on curves, not speed.
export const TICK = 90;
export const HOVER = 26;

export const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const lerp = (a, b, t) => a + (b - a) * t;
export const snap = (v, px = 1) => Math.round(v / px) * px;

export const bez = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
};

// The point at fraction u of the polyline's length, and the x direction of travel there (negative: heading left).
export function along(pts, u) {
  if (!pts?.length) return [0, 0, 0];
  if (pts.length === 1) return [pts[0][0], pts[0][1], 0];
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = Math.max(0, Math.min(1, u)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const k = seg[i] ? Math.min(1, want / seg[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k, pts[i + 1][0] - pts[i][0]];
    }
    want -= seg[i];
  }
  const last = pts[pts.length - 1];
  return [last[0], last[1], 0];
}

// An edge's curve (model.edgeCurve, in graph units) as points.
export function sampleCurve(curve, per = 16) {
  const pts = [curve.start];
  let p0 = curve.start;
  for (const [c1, c2, to] of curve.segs) {
    for (let i = 1; i <= per; i++) pts.push(bez(p0, c1, c2, to, i / per));
    p0 = to;
  }
  return pts;
}

// The wire from node a to node b in screen units (graph units times zoom): the real edge between them, walked
// backwards when it runs b→a; a straight line between their facing sides when they aren't connected.
export function wireBetween(graph, a, b, z) {
  const fwd = graph.edges.find((e) => e.from === a && e.to === b);
  const back = fwd ? null : graph.edges.find((e) => e.from === b && e.to === a);
  const edge = fwd ?? back;
  let pts;
  if (edge) {
    pts = sampleCurve(edgeCurve(edge, graph));
    if (!fwd) pts = pts.slice().reverse();
  } else {
    const A = graph.nodes.find((n) => n.name === a), B = graph.nodes.find((n) => n.name === b);
    if (!A || !B) return [];
    const right = B.x + B.w / 2 >= A.x + A.w / 2;
    pts = [[right ? A.x + A.w : A.x, A.y + A.h / 2], [right ? B.x : B.x + B.w, B.y + B.h / 2]];
  }
  return pts.map(([x, y]) => [x * z, y * z]);
}

const rectOf = (n, z) => ({ x: n.x * z, y: n.y * z, w: n.w * z, h: n.h * z });

// The goose walks off the top of the card to its edge, waddles along the wire, and climbs onto the next card.
export function goosePath(graph, a, b, z) {
  const A = graph.nodes.find((n) => n.name === a), B = graph.nodes.find((n) => n.name === b);
  if (!A || !B) return [];
  const ra = rectOf(A, z), rb = rectOf(B, z), w = wireBetween(graph, a, b, z);
  if (!w.length) return [];
  const ea = w[0][0] > ra.x + ra.w / 2 ? ra.x + ra.w : ra.x;
  const eb = w[w.length - 1][0] > rb.x + rb.w / 2 ? rb.x + rb.w : rb.x;
  return [[ra.x + ra.w * 0.55, ra.y], [ea, ra.y], ...w, [eb, rb.y], [rb.x + rb.w * 0.55, rb.y]];
}

// The probe flies from above one node, along the wire lifted 20 px, to above the next.
export function probePath(graph, a, b, z) {
  const A = graph.nodes.find((n) => n.name === a), B = graph.nodes.find((n) => n.name === b);
  if (!A || !B) return [];
  const ra = rectOf(A, z), rb = rectOf(B, z);
  const w = wireBetween(graph, a, b, z).map(([x, y]) => [x, y - 20]);
  return [[ra.x + ra.w / 2, ra.y - HOVER], ...w, [rb.x + rb.w / 2, rb.y - HOVER]];
}

// Event-driven focus: when the focused node changes, a move starts from the old node to the new one and runs for that
// sprite's MOVE time; then the sprite dwells until the next change. Reduced motion, a sprite without travel, or the
// first focus just jump. A change mid-move starts the next move from where the last was headed.
export function stepMotion(m, node, kind, reduced, now) {
  if (node !== m.node) {
    const travels = Boolean(m.node && node && MOVE[kind] && !reduced);
    m.moving = travels ? { from: m.node, to: node, start: now, dur: MOVE[kind] } : null;
    if (!travels) m.arrivedAt = now;
    m.node = node;
  }
  if (m.moving && now - m.moving.start >= m.moving.dur) {
    m.moving = null;
    m.arrivals = (m.arrivals ?? 0) + 1;
    m.arrivedAt = now;
  }
  const since = now - (m.arrivedAt ?? 0);
  // Every third stop the goose honks, 0.9 to 1.7 s into its dwell.
  const honkStop = kind === "goose" && !reduced && !m.moving && (m.arrivals ?? 0) % 3 === 2;
  m.honk = honkStop && since > 900 && since < 1700;
  m.needsTick = Boolean(m.moving) || (honkStop && since < 1750) || (kind === "probe" && !reduced && !m.moving && since < 300);
  m.u = m.moving ? Math.min(1, (now - m.moving.start) / m.moving.dur) : 1;
  m.since = since;
  return m;
}

// A square wave on opacity from a native loop: Herdr clamps opacity to 0..1, so a steep linear swing well past both
// ends reads as on or off. Visible for `duty` of each `period` ms, centred mid-cycle (or on its start when `early`).
// Two layers, one `early` with duty 1 - d and one not with duty d, take turns.
export function pulseRange(duty, early = false, span = 24) {
  const top = 1 + span * Math.max(0, Math.min(1, duty));
  const bottom = top - span;
  return early ? { from: top, to: bottom } : { from: bottom, to: top };
}
