/**
 * Picks one line of a drawing at a click: the piece under the pointer and whatever runs straight
 * on from it (across crossings and hairline gaps), stopping where it meets another line in a T or
 * turns a corner. Used to select a leader or a stray line the automatic candidates missed.
 */
import type { Snapshot } from '../shared/types';
import { isInked, isLineInk } from './automatic';
import { applySelection, type Point, type SelectionCombine } from './engine';
import { growIntoHalo, type Region } from './halo';
import { buildLineGraph, xy, type Segment } from './line-graph';
import { MARK_RULES } from './marks';

export interface PickedLine {
  /** 255 on the ink of the picked line. */
  mask: Uint8Array;
  /** 1 on the ink of the other lines, which the selection must not eat into. */
  kept: Uint8Array;
  /** Median pen width of the area, in pixels; 0 when there is no ink. */
  strokeWidth: number;
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
  if (!graph) return { mask, kept, strokeWidth: 0 };
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
  if (!start) return { mask, kept, strokeWidth };

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
  const paint = (segment: Segment, value: number): void => {
    for (const index of segment.points) {
      const [cx, cy] = xy(index, width);
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
  return { mask, kept, strokeWidth };
}

/** True when the picked line reaches a side of the look that has more photo beyond it. */
function runsPastLook(mask: Uint8Array, cropWidth: number, cropHeight: number, region: Region, width: number, height: number): boolean {
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % cropWidth;
    const y = (index - x) / cropWidth;
    if ((x <= 1 && region.left > 0) || (y <= 1 && region.top > 0)
      || (x >= cropWidth - 2 && region.right < width) || (y >= cropHeight - 2 && region.bottom < height)) return true;
  }
  return false;
}

// The first look around a click, in photo pixels each way; doubled while the line runs on.
const LOOK_START = 320;
// Larger looks are analysed at a coarser grid so a click stays instant on a 25MP photo.
const MAX_LOOK_PIXELS = 2_000_000;
const HALO_MIN_RADIUS = 2;

/**
 * Selects the line under `point` with its soft edge, meeting the current selection as the other
 * selection tools do. Returns the same snapshot when there is no line there.
 */
export function selectLineAt(snapshot: Snapshot, point: Point, combine: SelectionCombine): Snapshot {
  const { width, height, data } = snapshot.working;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return snapshot;
  for (let half = LOOK_START; ; half *= 2) {
    const region: Region = {
      left: Math.max(0, Math.floor(point.x - half)), top: Math.max(0, Math.floor(point.y - half)),
      right: Math.min(width, Math.ceil(point.x + half)), bottom: Math.min(height, Math.ceil(point.y + half)),
    };
    const scale = Math.max(1, Math.ceil(Math.sqrt((region.right - region.left) * (region.bottom - region.top) / MAX_LOOK_PIXELS)));
    const cropWidth = Math.ceil((region.right - region.left) / scale);
    const cropHeight = Math.ceil((region.bottom - region.top) / scale);
    const cellOf = (x: number, y: number): number => ((y - region.top) / scale | 0) * cropWidth + ((x - region.left) / scale | 0);
    const ink = new Uint8Array(cropWidth * cropHeight);
    for (let y = region.top; y < region.bottom; y += 1) {
      for (let x = region.left; x < region.right; x += 1) if (isLineInk(data, (y * width + x) * 4)) ink[cellOf(x, y)] = 1;
    }
    const picked = pickLineAt(ink, cropWidth, cropHeight, (point.x - region.left) / scale, (point.y - region.top) / scale);
    if (!picked.mask.some(Boolean)) return snapshot;
    if (runsPastLook(picked.mask, cropWidth, cropHeight, region, width, height)) continue;
    const selection = new Uint8Array(width * height);
    const kept = new Uint8Array(width * height);
    for (let y = region.top; y < region.bottom; y += 1) {
      for (let x = region.left; x < region.right; x += 1) {
        const index = y * width + x;
        if (!isInked(data, index * 4)) continue;
        const cell = cellOf(x, y);
        if (picked.mask[cell]) selection[index] = 255;
        else if (picked.kept[cell]) kept[index] = 1;
      }
    }
    const radius = Math.max(HALO_MIN_RADIUS, Math.ceil(picked.strokeWidth * scale));
    return applySelection(snapshot, growIntoHalo(data, width, height, selection, kept, region, radius), combine);
  }
}
