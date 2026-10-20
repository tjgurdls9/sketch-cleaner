/**
 * Picks one line of a drawing at a click: the piece under the pointer and whatever runs straight
 * on from it (across crossings and hairline gaps), stopping where it meets another line in a T or
 * turns a corner. Used to select a leader or a stray line the automatic candidates missed.
 */
import { buildLineGraph, xy, type Segment } from './line-graph';
import { MARK_RULES } from './marks';

export interface PickedLine {
  /** 255 on the ink of the picked line. */
  mask: Uint8Array;
  /** 1 on the ink of the other lines, which the selection must not eat into. */
  kept: Uint8Array;
  /** Median pen width of the area, in pixels; 0 when there is no ink. */
  strokeWidth: number;
  /** True when the picked line runs to the edge of the area: a larger area may hold more of it. */
  reachesEdge: boolean;
}

// A click counts on a line within this many pen widths of its centre (plus a few pixels).
const PICK_REACH = 2;
const PICK_SLACK = 4;
const MAX_HOPS = 200;
// Skeleton ends sit on whole pixels: allow one pixel more than the note analysis does.
const GAP_SLACK = 1;

export function pickLineAt(ink: Uint8Array, width: number, height: number, x: number, y: number): PickedLine {
  const mask = new Uint8Array(ink.length);
  const kept = new Uint8Array(ink.length);
  const graph = buildLineGraph(ink, width, height, MARK_RULES);
  if (!graph) return { mask, kept, strokeWidth: 0, reachesEdge: false };
  const { strokeWidth, segments, atNode, isEnd, freeEnds, linedUpEnd, otherNode, straightOn } = graph;

  let start: Segment | undefined;
  let best = (strokeWidth * PICK_REACH + PICK_SLACK) ** 2;
  for (const segment of segments) {
    for (const point of segment.points) {
      const [px, py] = xy(point, width);
      const distance = (px - x) ** 2 + (py - y) ** 2;
      if (distance < best) { best = distance; start = segment; }
    }
  }
  if (!start) return { mask, kept, strokeWidth, reachesEdge: false };

  const picked = new Set<Segment>([start]);
  const hairline = strokeWidth * MARK_RULES.hairlineGap + GAP_SLACK;
  for (const from of start.nodes) {
    let current = start;
    let at = from;
    for (let hops = 0; hops < MAX_HOPS; hops += 1) {
      let next: Segment | undefined;
      let landing = at;
      if (isEnd(at)) {
        // Step over a hairline gap where the pen skipped.
        const point = current.nodes[0] === at ? current.points[0] : current.points[current.points.length - 1];
        const across = linedUpEnd(current, at, point, hairline);
        const end = across && freeEnds(across.segment).find(([, endPoint]) => {
          const [ex, ey] = xy(endPoint, width);
          return ex === across.x && ey === across.y;
        });
        if (across && end) { next = across.segment; landing = end[0]; }
      } else {
        next = straightOn(current, at);
        // Across an X the next piece starts at the far end of the short crossed piece.
        if (next && !next.nodes.includes(at)) {
          landing = next.nodes.find(node => (atNode.get(node) ?? []).some(piece => piece.nodes.includes(at))) ?? next.nodes[0];
        }
      }
      if (!next || picked.has(next)) break;
      picked.add(next);
      current = next;
      at = otherNode(next, landing);
    }
  }

  const radius = Math.ceil(strokeWidth / 2) + 1;
  let reachesEdge = false;
  const paint = (segment: Segment, value: number): void => {
    for (const index of segment.points) {
      const [cx, cy] = xy(index, width);
      if (value === 255 && (cx <= radius || cy <= radius || cx >= width - 1 - radius || cy >= height - 1 - radius)) reachesEdge = true;
      for (let py = Math.max(0, cy - radius); py <= Math.min(height - 1, cy + radius); py += 1) {
        for (let px = Math.max(0, cx - radius); px <= Math.min(width - 1, cx + radius); px += 1) {
          const index2 = py * width + px;
          if ((px - cx) ** 2 + (py - cy) ** 2 > radius * radius || !ink[index2]) continue;
          if (value === 255) { if (!kept[index2]) mask[index2] = 255; } else kept[index2] = 1;
        }
      }
    }
  };
  // Other lines first: pixels they share with the picked line stay, so a crossing is not cut.
  for (const segment of segments) if (!picked.has(segment)) paint(segment, 1);
  for (const segment of picked) paint(segment, 255);
  return { mask, kept, strokeWidth, reachesEdge };
}
